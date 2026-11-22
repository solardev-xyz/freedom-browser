/**
 * Wires the freedom-cored child process into the app (freedom-core design
 * 0001). It owns the vault and the keys (migration step 2): main reaches it
 * through core/vault-backend.js. Once wind-down has called `stopCore()`,
 * `startCore()` never starts it again.
 *
 * **The grant** (freedom-core design 0017, C1): `serve` confines itself to
 * the directories its arguments name before it reads the hello. The client
 * appends `--grant-root` and `--user-data-dir`, the hello's own values
 * (core-client.js); main adds the node roots `nodes.write_identity` writes:
 * - `--node-root bee=`: Ant's data directory, `getAntDataPath()`, the path
 *   identity-manager.js's `getAntDataDir()` sends as Bee's `data_dir`. It
 *   is fixed for the run (`FREEDOM_ANT_DATA` from main's environment, or
 *   `ant-data` under a Freedom root that doesn't change while main holds
 *   the profile), and no setting picks another: `bee-data` is only the
 *   Bee-era directory index.js carries over into `ant-data` before the
 *   core starts. The core makes it if it is missing.
 * - `--node-root radicle=`: the Radicle home, `getRadicleDataDir()`, the
 *   path `prepareRadicleDataDir()` returns to identity-manager.js and
 *   radicle-manager.js (RadicledNode's `home`). Each spawn, restarts
 *   included, waits for `prepareRadicleDataDir()` first: a legacy home's
 *   carry-over into the short home renames a directory into its place,
 *   which a confined core couldn't reach (Landlock binds the grant to the
 *   directory confinement saw), so it lands before the core confines
 *   itself. A home that can't be resolved (a control socket path too long)
 *   is left out: Radicle can't run there, and the core then writes no
 *   Radicle home.
 * The core refuses a `nodes.write_identity` for another directory.
 */

const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');
const log = require('../logger');
const {
  getAntDataPath,
  getIdentityDataDir,
  getRadicleDataDir,
  prepareRadicleDataDir,
} = require('../profile-paths');
const { getFreedomDataDir } = require('../freedom-root');
const { getLockDir } = require('../service-locks');
const { getCoredBinaryPath } = require('./cored-binary');
const { CoreClient, PROTOCOL_VERSION_STREAMS } = require('./core-client');
const guard = require('./node-identity-guard');
const { attachNaming, detachNaming } = require('./naming');
const { attachChain, detachChain } = require('./chain');
const { registerDwebShell } = require('./dweb-shell');
const { attachDwebVerify, detachDwebVerify } = require('./dweb-verify');
const { attachGrants, detachGrants } = require('./grants');
const { registerKeystoreShell } = require('./keystore-shell');
const { confinementLog, CONFINEMENT_PROPERTIES } = require('./service-client');

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

/**
 * The Radicle home `nodes.write_identity` names (`getRadicleDataDir()`), or
 * null when it can't be resolved.
 */
function radicleHome() {
  try {
    return getRadicleDataDir();
  } catch (err) {
    log.warn('[Core] no Radicle home for the core', { code: err?.code || 'error' });
    return null;
  }
}

/**
 * `deferSpawn` for the core (service-client.js): before each spawn, a wait
 * for `prepareRadicleDataDir()`, then the spawn. A preparation that fails
 * is logged and the core spawns anyway: the vault doesn't wait on Radicle.
 */
function radicleHomeWait() {
  let prepared = false;
  return () => {
    if (prepared) {
      prepared = false;
      return null;
    }
    return prepareRadicleDataDir()
      .catch((err) => {
        log.warn("[Core] the Radicle home isn't prepared", { code: err?.code || 'error' });
      })
      .finally(() => {
        prepared = true;
      });
  };
}

/**
 * The confinement the core got (design 0017), from its hello: an info line
 * with the mechanism and each property's status, and a warning naming the
 * properties that aren't `enforced`. A core that reports none (before
 * 0.28.0) is logged as such.
 */
function logConfinement(hello) {
  const { confinement } = hello;
  if (!confinement) {
    log.warn('[Core] the core reported no confinement', { core_version: hello.core_version });
    return;
  }
  log.info('[Core] confinement', {
    core_version: hello.core_version,
    ...confinementLog(confinement),
  });
  const weaker = CONFINEMENT_PROPERTIES.filter((name) => confinement[name] !== 'enforced');
  if (weaker.length > 0) {
    log.warn('[Core] confinement not enforced', {
      mechanism: confinement.mechanism,
      ...Object.fromEntries(weaker.map((name) => [name, confinement[name]])),
      gaps: confinement.gaps,
    });
  }
}

async function startCore() {
  if (!isCoreEnabled() || shutDown || client) return client;
  guard.setIdentityDir(getIdentityDataDir());
  const radicle = radicleHome();
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
      // The node roots (design 0017, C1): see the top of this file.
      '--node-root',
      `bee=${path.resolve(getAntDataPath())}`,
      ...(radicle === null ? [] : ['--node-root', `radicle=${path.resolve(radicle)}`]),
    ],
    ...(radicle === null ? {} : { deferSpawn: radicleHomeWait() }),
    log,
    shellVersion: app.getVersion(),
    // Protocol 2 (design 0009): streams both ways, `dweb.verify` and
    // `dweb.forget`. It's the client's only protocol, and the only one the
    // pinned core (0.27.0) takes; a core that answers another is a
    // mismatch, not restarted.
    protocol: PROTOCOL_VERSION_STREAMS,
    // The hello's `grant_root` (design 0012, APR-3): where the four
    // permission files are, the profile's Freedom root (its userData until
    // 0013's move, freedom-root.js), which the stores write them under.
    grantRoot: getFreedomDataDir(),
    // The hello's `user_data_dir` (design 0013, PRF-8b-lite): the profile's
    // own directory, where the legacy `x402-receipts.json` is. After 0013's
    // move the core copies it into the Freedom root and imports the copy
    // (design 0017 C5).
    userDataDir: app.getPath('userData'),
  });
  client.on('failed', (reason) => log.error('[Core] not available', { reason }));
  // Every (re)start reports node identity writes recovery couldn't finish;
  // those nodes stay stopped. Between an exit and the next report, nothing
  // is known (node-identity-guard.js).
  client.on('ready', (hello) => {
    logConfinement(hello);
    if (hello.node_recovery) {
      log.error('[Core] node identity recovery pending', hello.node_recovery);
    }
    guard.setStartupRecovery(hello.node_recovery);
  });
  client.on('exit', () => guard.setRecoveryUnknown());
  // The grant stores the core writes (design 0012, APB-3), loaded at each
  // start: attached before the first.
  attachGrants(client);
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
  // The dApp grants, which the core writes (design 0012, APB-2): main's
  // copy read at each handshake, and again for each change the core sends.
  require('../wallet/dapp-permissions').attachCore(client);
  // The pending Safe transactions, which the core writes (design 0013,
  // PRF-6(d)): main's copy loaded at each handshake.
  require('../wallet/safe/pending-store').attachCore(client);
  // The RPC API keys, which the core keeps (design 0013, PRF-6(e)): main's
  // copy, for the requests main runs itself, read at each handshake.
  require('../wallet/rpc-manager').attachCore(client);
  // A phone payment's later check (design 0012, PHN-2): the core's
  // `phone.checked` and `phone.lost`, which it sends from its start on.
  require('../wallet/tx-recorder').attachPhoneEvents(client);
  // The core's requests about a page's EIP-1193 request (design 0012,
  // APB-4a): its prompts, its rechecks and a switch's selection, served
  // before main sends any `eip1193.request`.
  require('../page/page-eip1193').attachEip1193(client);
  // `shell.keystore` (design 0013, PRF-2): the core's key-store calls, each
  // run in the one-shot helper. Only where the helper has a key store
  // (macOS); elsewhere the core asks nothing.
  registerKeystoreShell(client);
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
  detachGrants();
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
