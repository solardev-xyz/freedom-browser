const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { getActiveProfile } = require('./profile-resolver');
const fsOffload = require('./fs-offload');
const { ensurePrivateDir } = require('./private-files');

const RADICLE_SOCKET_PATH_LIMIT = 100;
const RADICLE_SHORT_HOME_DIR = 'R';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * The directory a data-directory override (`FREEDOM_IPFS_DATA`, …) names,
 * absolute, or null when it isn't set. It is resolved here, against main's
 * working directory (on Windows, a drive's own for `C:name`), and every
 * consumer gets this path: a service handed it as an argument, whose
 * environment and working directory may differ, never resolves it from
 * another base (freedom-core design 0010, "Main's check").
 */
function overrideDir(envName) {
  const override = process.env[envName];
  return override ? path.resolve(override) : null;
}

function resolveDir(envName, fallbackName, { owned = false } = {}) {
  const ensure = owned ? ensurePrivateDir : ensureDir;
  const override = overrideDir(envName);
  if (override) {
    return ensure(override);
  }
  return ensure(path.join(app.getPath('userData'), fallbackName));
}

async function hasEntriesAsync(dirPath) {
  try {
    return (await fs.promises.readdir(dirPath)).length > 0;
  } catch {
    return false;
  }
}

const RADICLE_STAGING_INFIX = '.migrating-';

function isProcessAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, we just may not signal it.
    return err.code === 'EPERM';
  }
}

// A migration interrupted mid-copy (quit, crash) never reaches its `finally`,
// leaving a possibly multi-GB `<radicleDir>.migrating-<pid>-<ts>` sibling that
// the next attempt (with a new name) would not reuse and profile deletion would
// not see. Remove those left by processes that are gone. A live other pid is
// left alone: it may be copying right now (pid reuse only delays the sweep to a
// later launch). Our own pid's leftovers are not swept here either — this
// process only ever has one migration per home in flight (radicleMigrations),
// and its `finally` removes its own staging dir.
async function sweepOrphanedRadicleStagingDirs(radicleDir) {
  const parent = path.dirname(radicleDir);
  const prefix = `${path.basename(radicleDir)}${RADICLE_STAGING_INFIX}`;
  let names;
  try {
    names = await fs.promises.readdir(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number.parseInt(name.slice(prefix.length), 10);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) continue;
    try {
      await fsOffload.removePath(path.join(parent, name), { recursive: true, force: true });
    } catch (err) {
      console.warn('[ProfilePaths] Failed to remove stale Radicle staging dir:', err.message);
    }
  }
}

// One-time carry-over of a pre-short-home profile's `radicle-data/` into the
// catalog's short Radicle home (see getRadicleDataDir). The tree can be several
// GB of seeded repositories, so it is copied off the main thread (fs-offload,
// #513) into a staging sibling and renamed into place: anything that reads the
// short home meanwhile sees it empty or complete, never half-copied. Skipped —
// as the old synchronous copy was — when the source is empty or the
// destination already has entries, including entries that appeared while we
// were copying.
//
// It writes the home, so it runs under the home's gate (freedom-core design
// 0008, "Spawn and lock"; radicle/radicled-gate.js), from its check that the
// home is empty to its rename into place: a service or another build's
// add-on holding even a new, empty home fails the carry-over, with nothing
// replaced, rather than having its home renamed away under it. A later
// prepareRadicleDataDir() tries again. The quick checks before the gate only
// skip it where there is nothing to carry over.
async function migrateProfileRadicleData(profileRadicleDir, radicleDir) {
  if (!(await hasEntriesAsync(profileRadicleDir)) || (await hasEntriesAsync(radicleDir))) {
    return;
  }

  await fs.promises.mkdir(path.dirname(radicleDir), { recursive: true });
  // Required here, not at load: it loads the logger and the lock directory,
  // which every importer of this module would otherwise load too.
  const { withRadicleGate } = require('./radicle/radicled-gate');
  await withRadicleGate(radicleDir, async (gate) => {
    // Again under the gate: the home may have gained entries meanwhile.
    if (await hasEntriesAsync(radicleDir)) return;
    await sweepOrphanedRadicleStagingDirs(radicleDir);
    const stagingDir = `${radicleDir}${RADICLE_STAGING_INFIX}${process.pid}-${Date.now()}`;
    try {
      await fsOffload.copyPath(profileRadicleDir, stagingDir, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      // A gate lost during the copy: another writer may hold the home now.
      if (gate.gated && !gate.held()) {
        throw new Error("The Radicle home's lock was lost; its data was not carried over");
      }
      // getRadicleDataDir, or the gate's holder, may have created the
      // destination as an empty dir in the meantime; only an *empty* one may
      // be replaced.
      try {
        await fs.promises.rmdir(radicleDir);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') return;
          throw err;
        }
      }
      await fs.promises.rename(stagingDir, radicleDir);
    } finally {
      await fsOffload.removePath(stagingDir, { recursive: true, force: true });
    }
  });
}

const radicleMigrations = new Map();
// Homes whose migration has not settled yet. getRadicleDataDir must not
// ensureDir() these: between the migration's rmdir of an empty destination and
// its rename of the staging dir into place, a recreated destination would make
// the rename fail on Windows (it cannot rename onto an existing directory).
const radicleMigrationsInFlight = new Set();

function startRadicleMigration(profileRadicleDir, radicleDir) {
  let pending = radicleMigrations.get(radicleDir);
  if (!pending) {
    radicleMigrationsInFlight.add(radicleDir);
    pending = migrateProfileRadicleData(profileRadicleDir, radicleDir)
      .catch((err) => {
        // Let a later call retry instead of caching the failure.
        radicleMigrations.delete(radicleDir);
        throw err;
      })
      .finally(() => {
        radicleMigrationsInFlight.delete(radicleDir);
      });
    radicleMigrations.set(radicleDir, pending);
  }
  return pending;
}

function getCatalogRadicleDataDir(profile) {
  if (
    !profile
    || profile.source !== 'catalog'
    || !profile.appRoot
    || !Number.isInteger(profile.metadata?.slot)
  ) {
    return null;
  }

  const slot = String(profile.metadata.slot);
  if (profile.isDev) {
    return path.join(
      path.dirname(profile.appRoot),
      RADICLE_SHORT_HOME_DIR,
      profile.checkoutHash || 'dev',
      slot
    );
  }

  return path.join(profile.appRoot, RADICLE_SHORT_HOME_DIR, slot);
}

function getProfileUserDataDir() {
  return app.getPath('userData');
}

// The identity vault and the node data dirs hold key material, so they are
// owner-only (0700) on POSIX, narrowed if an older build made them 0755 (K-3).
function getIdentityDataDir() {
  return resolveDir('FREEDOM_IDENTITY_DATA', 'identity', { owned: true });
}

function getBeeDataDir() {
  return resolveDir('FREEDOM_BEE_DATA', 'bee-data', { owned: true });
}

function getAntDataDir() {
  return resolveDir('FREEDOM_ANT_DATA', 'ant-data', { owned: true });
}

function getIpfsDataDir() {
  return resolveDir('FREEDOM_IPFS_DATA', 'ipfs-data');
}

function getMyotisDataDir(network = 'mainnet') {
  // MYOTIS_DATA_DIR predates profile integration and remains an explicit
  // development/test escape hatch. Normal launches resolve under the active
  // profile's userData directory, which keeps every embedded client isolated.
  const root = resolveDir('MYOTIS_DATA_DIR', 'myotis');
  // Keep Ethereum at the legacy root so existing synced profiles retain
  // their warm state. Additional networks are isolated below that root.
  return network === 'mainnet' ? root : ensureDir(path.join(root, network));
}

function getTorDataDir() {
  return resolveDir('FREEDOM_TOR_DATA', 'tor-data');
}

function getRadicleDataDir() {
  const override = overrideDir('FREEDOM_RADICLE_DATA');
  if (override) {
    return ensurePrivateDir(override);
  }

  const profileRadicleDir = path.join(app.getPath('userData'), 'radicle-data');
  const activeProfile = getActiveProfile();
  const catalogRadicleDir = getCatalogRadicleDataDir(activeProfile);

  /*
   * IMPORTANT: Radicle is intentionally the one managed node whose data directory
   * does not always live inside the profile's userData directory.
   *
   * The embedded Radicle runtime binds a Unix domain socket at:
   *
   *   $RAD_HOME/node/control.sock
   *
   * macOS and Linux impose a hard sockaddr_un path limit. Our normal profile
   * paths, especially dev paths such as:
   *
   *   .../Freedom Dev/freedom-browser-<hash>/Profiles/<profile>/radicle-data
   *
   * can exceed that limit and Radicle exits with "path must be shorter than
   * SUN_LEN". Symlinking RAD_HOME is not enough because Radicle canonicalizes it
   * before binding the socket.
   *
   * So catalog-managed profiles use a short, app-owned Radicle home:
   *
   *   packaged: <appRoot>/R/<slot>
   *   dev:      <Freedom Dev>/R/<checkoutHash>/<slot>
   *
   * Bee/IPFS stay under profile userData because they do not place Unix sockets
   * under their data dirs. Any profile export/delete/copy code must remember
   * this Radicle exception.
   */
  if (catalogRadicleDir) {
    // Never copy synchronously here: kick off (or join) the async migration and
    // return the path. Everything that writes to or starts Radicle awaits
    // prepareRadicleDataDir() first, so only read-only callers can observe the
    // short home before the migration lands — and they see it empty, not torn.
    startRadicleMigration(profileRadicleDir, catalogRadicleDir).catch((err) => {
      console.warn('[ProfilePaths] Radicle data migration failed:', err.message);
    });
    // While the migration is in flight the home may not exist yet; read-only
    // callers cope with that (missing file), and prepareRadicleDataDir creates
    // it once the migration has settled.
    if (radicleMigrationsInFlight.has(catalogRadicleDir)) return catalogRadicleDir;
    return ensurePrivateDir(catalogRadicleDir);
  }

  const socketPath = path.join(profileRadicleDir, 'node', 'control.sock');
  if (process.platform !== 'win32' && socketPath.length >= RADICLE_SOCKET_PATH_LIMIT) {
    throw new Error(
      `Radicle data path is too long for its control socket: ${socketPath}`
    );
  }

  return ensurePrivateDir(profileRadicleDir);
}

/**
 * Resolve the Radicle data dir, first finishing the one-time async migration of
 * a profile-local `radicle-data/` into the catalog's short home if one is due.
 * Await this before starting Radicle or writing its home.
 * @returns {Promise<string>}
 */
async function prepareRadicleDataDir() {
  const radicleDir = getRadicleDataDir();
  const pending = radicleMigrations.get(radicleDir);
  if (pending) await pending;
  return ensurePrivateDir(radicleDir);
}

// Each managed component's data directory: its default name under a
// profile's userData directory, and the variable that overrides it.
const COMPONENT_DATA_DIRS = Object.freeze({
  identity: ['identity', 'FREEDOM_IDENTITY_DATA'],
  bee: ['bee-data', 'FREEDOM_BEE_DATA'],
  ant: ['ant-data', 'FREEDOM_ANT_DATA'],
  ipfs: ['ipfs-data', 'FREEDOM_IPFS_DATA'],
  myotis: ['myotis', 'MYOTIS_DATA_DIR'],
  tor: ['tor-data', 'FREEDOM_TOR_DATA'],
  radicle: ['radicle-data', 'FREEDOM_RADICLE_DATA'],
});

/**
 * Where each managed component keeps its data, as the getters above resolve
 * it but without creating anything: the protected roots of freedom-core
 * design 0010's grant check (`service-grant.js`).
 *
 * - Without `userDataDir`: the active profile's, with this process's
 *   overrides (`FREEDOM_IPFS_DATA`, …), resolved as the getters resolve
 *   them (`overrideDir`).
 * - With it: that profile's at their default names, the active one's too
 *   (an override is this process's alone, and not where a profile keeps
 *   its data by default).
 *
 * `radicleHome` is the profile's short Radicle home outside its userData
 * directory (`<appRoot>/R/<slot>`, or a dev checkout's
 * `<parent of appRoot>/R/<hash>/<slot>`), for a catalog profile, or null.
 * Another profile's needs its catalog `slot`.
 */
function getComponentDataDirs(userDataDir = null, { slot = null } = {}) {
  const root = userDataDir ?? app.getPath('userData');
  const dirs = {};
  for (const [component, [name, override]] of Object.entries(COMPONENT_DATA_DIRS)) {
    dirs[component] = (!userDataDir && overrideDir(override)) || path.join(root, name);
  }
  const activeProfile = getActiveProfile();
  dirs.radicleHome = getCatalogRadicleDataDir(
    userDataDir
      ? activeProfile && { ...activeProfile, metadata: { slot } }
      : activeProfile
  );
  return dirs;
}

/**
 * This process's data-directory overrides as they are written, by
 * component, before `overrideDir` resolves them: the grant check refuses a
 * form a service could resolve from another base (on Windows, `C:name`).
 */
function getDataDirOverrides() {
  const overrides = {};
  for (const [component, [, override]] of Object.entries(COMPONENT_DATA_DIRS)) {
    if (process.env[override]) overrides[component] = process.env[override];
  }
  return overrides;
}

function getQuickUnlockCredentialPath() {
  return path.join(getIdentityDataDir(), 'quick-unlock.dat');
}

function getAgentDataDir() {
  return ensureDir(path.join(app.getPath('userData'), 'agent'));
}

function getProfileCrashDir() {
  return ensureDir(path.join(app.getPath('userData'), 'crash-reports'));
}

function getProfileTempDir() {
  return ensureDir(path.join(app.getPath('userData'), 'tmp'));
}

function createProfileTempDir(prefix) {
  const safePrefix = String(prefix || 'tmp')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'tmp';
  return fs.mkdtempSync(path.join(getProfileTempDir(), `${safePrefix}-`));
}

module.exports = {
  RADICLE_STAGING_INFIX,
  createProfileTempDir,
  getAgentDataDir,
  getAntDataDir,
  getBeeDataDir,
  getComponentDataDirs,
  getDataDirOverrides,
  getIdentityDataDir,
  getIpfsDataDir,
  getMyotisDataDir,
  getProfileCrashDir,
  getProfileTempDir,
  getProfileUserDataDir,
  getQuickUnlockCredentialPath,
  getRadicleDataDir,
  getTorDataDir,
  prepareRadicleDataDir,
};
