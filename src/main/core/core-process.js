/**
 * Wires the freedom-cored child process into the app (freedom-core design
 * 0001, migration step 1). For now this is **dev builds only**, behind
 * `FREEDOM_CORE=1`, and changes no behavior: the core starts, completes its
 * handshake and is supervised, but nothing calls it yet.
 */

const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const log = require('../logger');
const { getIdentityDataDir } = require('../profile-paths');
const { CoreClient } = require('./core-client');

let client = null;

function isCoreEnabled() {
  return !app.isPackaged && process.env.FREEDOM_CORE === '1';
}

/** `FREEDOM_CORED_PATH` in dev builds; the bundled binary otherwise. */
function getCoredBinaryPath() {
  if (!app.isPackaged && process.env.FREEDOM_CORED_PATH) {
    return process.env.FREEDOM_CORED_PATH;
  }
  const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
  return path.join(process.resourcesPath, 'freedom-cored', name);
}

/**
 * The per-user lock directory every Freedom build shares (design 0001,
 * "Lifetime lock"). It is never deleted.
 */
function getLockDir() {
  return path.join(app.getPath('appData'), 'Freedom', 'locks');
}

async function startCore() {
  if (!isCoreEnabled() || client) return client;
  client = new CoreClient({
    spawn,
    command: getCoredBinaryPath(),
    args: [
      'serve',
      '--data-dir',
      getIdentityDataDir(),
      '--lock-dir',
      getLockDir(),
      '--parent-pid',
      String(process.pid),
    ],
    log,
    shellVersion: app.getVersion(),
  });
  client.on('failed', (reason) => log.error('[Core] not available:', reason));
  const hello = await client.start();
  log.info('[Core] ready', hello);
  return client;
}

async function stopCore() {
  if (!client) return;
  const stopping = client;
  client = null;
  await stopping.stop();
}

function getCoreClient() {
  return client;
}

module.exports = {
  isCoreEnabled,
  getCoredBinaryPath,
  getLockDir,
  startCore,
  stopCore,
  getCoreClient,
};
