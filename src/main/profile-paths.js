const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { getActiveProfile } = require('./profile-resolver');
const fsOffload = require('./fs-offload');

const RADICLE_SOCKET_PATH_LIMIT = 100;
const RADICLE_SHORT_HOME_DIR = 'R';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function resolveDir(envName, fallbackName) {
  const override = process.env[envName];
  if (override) {
    return ensureDir(override);
  }
  return ensureDir(path.join(app.getPath('userData'), fallbackName));
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
async function migrateProfileRadicleData(profileRadicleDir, radicleDir) {
  if (!(await hasEntriesAsync(profileRadicleDir)) || (await hasEntriesAsync(radicleDir))) {
    return;
  }

  await fs.promises.mkdir(path.dirname(radicleDir), { recursive: true });
  await sweepOrphanedRadicleStagingDirs(radicleDir);
  const stagingDir = `${radicleDir}${RADICLE_STAGING_INFIX}${process.pid}-${Date.now()}`;
  try {
    await fsOffload.copyPath(profileRadicleDir, stagingDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    // getRadicleDataDir may have created the destination as an empty dir in the
    // meantime; only an *empty* one may be replaced.
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

function getIdentityDataDir() {
  return resolveDir('FREEDOM_IDENTITY_DATA', 'identity');
}

function getBeeDataDir() {
  return resolveDir('FREEDOM_BEE_DATA', 'bee-data');
}

function getAntDataDir() {
  return resolveDir('FREEDOM_ANT_DATA', 'ant-data');
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
  const override = process.env.FREEDOM_RADICLE_DATA;
  if (override) {
    return ensureDir(override);
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
    return ensureDir(catalogRadicleDir);
  }

  const socketPath = path.join(profileRadicleDir, 'node', 'control.sock');
  if (process.platform !== 'win32' && socketPath.length >= RADICLE_SOCKET_PATH_LIMIT) {
    throw new Error(
      `Radicle data path is too long for its control socket: ${socketPath}`
    );
  }

  return ensureDir(profileRadicleDir);
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
  return ensureDir(radicleDir);
}

function getQuickUnlockCredentialPath() {
  return path.join(getIdentityDataDir(), 'quick-unlock.dat');
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
  getAntDataDir,
  getBeeDataDir,
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
