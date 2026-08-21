const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { getActiveProfile } = require('./profile-resolver');

const RADICLE_SOCKET_PATH_LIMIT = 100;
const RADICLE_SHORT_HOME_DIR = 'R';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function hasEntries(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function resolveDir(envName, fallbackName) {
  const override = process.env[envName];
  if (override) {
    return ensureDir(override);
  }
  return ensureDir(path.join(app.getPath('userData'), fallbackName));
}

function copyProfileRadicleDataIfNeeded(profileRadicleDir, radicleDir) {
  if (!hasEntries(profileRadicleDir) || hasEntries(radicleDir)) {
    return;
  }

  fs.mkdirSync(path.dirname(radicleDir), { recursive: true });
  fs.cpSync(profileRadicleDir, radicleDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
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
   * radicle-node binds a Unix domain socket at:
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
    copyProfileRadicleDataIfNeeded(profileRadicleDir, catalogRadicleDir);
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
};
