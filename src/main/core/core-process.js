/**
 * Wires the freedom-cored child process into the app (freedom-core design
 * 0001). It owns the vault and the keys (migration step 2): main reaches it
 * through core/vault-backend.js. Once wind-down has called `stopCore()`,
 * `startCore()` never starts it again.
 */

const { spawn } = require('child_process');
const { app } = require('electron');
const log = require('../logger');
const { getIdentityDataDir } = require('../profile-paths');
const { getFreedomDataDir } = require('../freedom-root');
const { getLockDir } = require('../service-locks');
const { getCoredBinaryPath } = require('./cored-binary');
const { CoreClient, PROTOCOL_VERSION_STREAMS } = require('./core-client');
const guard = require('./node-identity-guard');
const { attachNaming, detachNaming } = require('./naming');
const { attachChain, detachChain } = require('./chain');
const { registerDwebShell } = require('./dweb-shell');
const { attachDwebVerify, detachDwebVerify } = require('./dweb-verify');

let client = null;
// `shell.dweb_get`'s executor (design 0009) on the client; null before
// startCore() and after stopCore().
let dwebShell = null;
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
    // Protocol 2 (design 0009): streams both ways, `dweb.verify` and
    // `dweb.forget`. It's the client's only protocol, and the only one the
    // pinned core (0.14.0) takes; a core that answers another is a
    // mismatch, not restarted.
    protocol: PROTOCOL_VERSION_STREAMS,
    // The hello's `grant_root` (design 0012, APR-3): where the four
    // permission files are, the profile's Freedom root (its userData until
    // 0013's move, freedom-root.js), which the stores write them under.
    grantRoot: getFreedomDataDir(),
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
  // Verified dweb fetches' pieces (`shell.dweb_get`, protocol 2).
  dwebShell = registerDwebShell(client);
  // `{ verify }` plans' `dweb.verify`, and `dweb.forget` as a private
  // partition closes.
  attachDwebVerify(client, dwebShell);
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
  detachDwebVerify();
  dwebShell = null;
  if (!client) return;
  const stopping = client;
  client = null;
  await stopping.stop();
}

function getCoreClient() {
  return client;
}

/** `shell.dweb_get`'s executor, whose `open()` a `dweb.verify` request
 * calls; null while no core client runs. */
function getDwebShell() {
  return dwebShell;
}

module.exports = {
  isCoreEnabled,
  getCoredBinaryPath,
  getLockDir,
  startCore,
  stopCore,
  getCoreClient,
  getDwebShell,
};
