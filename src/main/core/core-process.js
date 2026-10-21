/**
 * Wires the freedom-cored child process into the app (freedom-core design
 * 0001). It owns the vault and the keys (migration step 2): main reaches it
 * through core/vault-backend.js. Once wind-down has called `stopCore()`,
 * `startCore()` never starts it again.
 */

const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const log = require('../logger');
const { getIdentityDataDir } = require('../profile-paths');
const { getLockDir } = require('../service-locks');
const { CoreClient } = require('./core-client');
const guard = require('./node-identity-guard');
const { attachNaming, detachNaming } = require('./naming');
const { attachChain, detachChain } = require('./chain');

let client = null;
// Set once app wind-down has stopped the core; nothing starts it again.
let shutDown = false;

/**
 * The vault and keys live in the core (migration step 2), so it always runs.
 * There is no runtime switch back to the JS stack: two writers must never
 * share one identity directory (design 0001, "Rollback").
 */
function isCoreEnabled() {
  return true;
}

/** Dev overrides or downloaded binaries; packaged builds always use resources. */
function getCoredBinaryPath() {
  if (!app.isPackaged && process.env.FREEDOM_CORED_PATH) {
    return process.env.FREEDOM_CORED_PATH;
  }
  const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
  if (!app.isPackaged) {
    const os =
      { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
    return path.join(
      __dirname,
      '..',
      '..',
      '..',
      'freedom-cored-bin',
      `${os}-${process.arch}`,
      name
    );
  }
  return path.join(process.resourcesPath, 'freedom-cored', name);
}

async function startCore() {
  if (!isCoreEnabled() || shutDown || client) return client;
  guard.setIdentityDir(getIdentityDataDir());
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
  client.on('failed', (reason) => log.error('[Core] not available', { reason }));
  // Every (re)start reports node identity writes recovery couldn't finish;
  // those nodes stay stopped. Between an exit and the next report, nothing
  // is known (node-identity-guard.js).
  client.on('ready', (hello) => {
    if (hello.node_recovery) {
      log.error('[Core] node identity recovery pending', hello.node_recovery);
    }
    guard.setStartupRecovery(hello.node_recovery);
  });
  client.on('exit', () => guard.setRecoveryUnknown());
  // Before it starts, so its first handshake configures naming.
  const naming = attachNaming(client);
  // Chain data: its configuration, executors (under naming's bound on
  // verifier operations) and drivers.
  attachChain(client, { running: naming.running });
  const starting = client;
  let hello;
  try {
    hello = await starting.start();
  } catch (err) {
    // Wind-down began while the core was starting: not a failure.
    if (shutDown) return null;
    throw err;
  }
  log.info('[Core] ready', {
    core_version: hello.core_version,
    capabilities: hello.capabilities.length,
  });
  return starting;
}

async function stopCore() {
  shutDown = true;
  detachNaming();
  detachChain();
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
