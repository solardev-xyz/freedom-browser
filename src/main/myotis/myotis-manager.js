// EXPERIMENTAL (spike): Myotis — a fully peer-to-peer Ethereum light client
// (devp2p + beacon light client; every read Merkle-proven against a
// sync-committee-anchored state root). Runs invisibly like the ant/IPFS
// nodes, via a napi-rs native addon over the myotis-engine C ABI.
//
// Available through an explicit MYOTIS_NODE_PATH, the development download,
// or the packaged resource. Profile configuration can disable it; otherwise
// the profile-local autostart preference or Nodes UI controls its lifecycle.
// The addon's blocking verified reads run on the libuv thread pool and surface
// as Promises, so the main process event loop never blocks.
const log = require('../logger');
const path = require('path');
const { getMyotisDataDir } = require('../profile-paths');

// The engine ABI version this manager was written against. The addon's
// init() must return exactly this or we refuse to start (a stale addon
// would otherwise fail confusingly deep inside a resolve).
// v19 → v22 (myotis v0.1.5 release): additive only — v20 Tor toggle,
// v21 opt-in eth_getLogs watch-list index, v22 live served-block window.
// No shape we call changed.
const EXPECTED_ABI = 22;
const MYOTIS_VERSION = '0.1.7';

// Poll/log-drain cadence while the node runs. Availability is intentionally
// checked more frequently than log draining: resolution policy must react
// promptly when a node finishes warming up or loses its usable peer context.
const LOG_DRAIN_MS = 15000;
const AVAILABILITY_POLL_MS = 1000;

const NETWORKS = new Map([
  [1, { chainId: 1, name: 'mainnet', displayName: 'Ethereum' }],
  [100, { chainId: 100, name: 'gnosis', displayName: 'Gnosis' }],
]);

let addon = null;
let drainTimer = null;
let readyWatchTimer = null;
let addonError = null;
const instances = new Map();
const readyListeners = new Set();
const availabilityListeners = new Set();

function normalizeChainId(chainId = 1) {
  const numeric = Number(chainId);
  if (!NETWORKS.has(numeric)) throw new Error(`Unsupported Myotis chain ID: ${chainId}`);
  return numeric;
}

function instanceFor(chainId = 1) {
  const id = normalizeChainId(chainId);
  if (!instances.has(id)) {
    instances.set(id, {
      ...NETWORKS.get(id),
      handle: -1,
      lastStatus: null,
      startedAt: 0,
      lastError: null,
      wasReady: false,
      stopping: false,
      availabilityEpoch: 0,
    });
  }
  return instances.get(id);
}

// Backward-compatible ready-only subscription for callers that do not need
// lifecycle epochs. New resolution code uses onAvailabilityTransition below.
function onReadyTransition(cb) {
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

// Fires for both availability directions and lifecycle boundaries. The epoch
// lets consumers reject an async result produced by a client that was stopped
// or replaced while the native read was in flight.
function onAvailabilityTransition(cb) {
  availabilityListeners.add(cb);
  return () => availabilityListeners.delete(cb);
}

function publishAvailability(instance, ready, reason, force = false) {
  const changed = instance.wasReady !== ready;
  if (!changed && !force) return;
  instance.wasReady = ready;
  instance.availabilityEpoch += 1;
  const event = {
    chainId: instance.chainId,
    ready,
    reason,
    epoch: instance.availabilityEpoch,
  };

  if (ready) {
    log.info(`[myotis] ${instance.name} ready — verified reads available`);
  }
  for (const cb of availabilityListeners) {
    try {
      cb(event);
    } catch (err) {
      log.warn(`[myotis] availability listener failed: ${err.message}`);
    }
  }
  if (ready && changed) {
    for (const cb of readyListeners) {
      try {
        cb(instance.chainId);
      } catch (err) {
        log.warn(`[myotis] ready listener failed: ${err.message}`);
      }
    }
  }
}

// Addon discovery, mirroring freedom-ipfs-native-binding: env override
// (spike/testing) → dev fetch dir (scripts/fetch-myotis.js, per-platform
// subdir) → packaged resources. Enabled iff one of them exists.
function addonPath() {
  const osDir = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const candidates = [
    process.env.MYOTIS_NODE_PATH,
    path.join(
      __dirname, '..', '..', '..', 'myotis-bin', `${osDir}-${process.arch}`, 'myotis-node.node'
    ),
    process.resourcesPath && path.join(process.resourcesPath, 'myotis-node', 'myotis-node.node'),
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return require('fs').existsSync(p);
    } catch {
      return false;
    }
  });
}

function isEnabled() {
  return Boolean(addonPath()) && !isDisabledMyotisConfig();
}

function getProfileMyotisConfig() {
  return require('../profile-resolver').getActiveProfile()?.metadata?.nodes?.myotis || null;
}

function isDisabledMyotisConfig(config = getProfileMyotisConfig()) {
  return config?.mode === 'disabled';
}

function getMyotisDataPath(chainId = 1) {
  return getMyotisDataDir(instanceFor(chainId).name);
}

function broadcastStatus(status = publicStatus()) {
  try {
    const { BrowserWindow } = require('electron');
    const IPC = require('../../shared/ipc-channels');
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.MYOTIS_STATUS_UPDATE, status);
    }
  } catch {
    // Electron may be unavailable in plain-Node tests and tooling.
  }
}

function registryMessage(status) {
  if (status.state === 'disabled') return 'Disabled';
  if (status.state === 'unavailable') return 'Native addon unavailable';
  if (status.state === 'error') return `Error: ${status.error}`;
  if (status.state === 'off') return 'Not running';
  if (status.state === 'ready') return `Ready: verified ${status.displayName} reads available`;
  return `Syncing: ${status.peerCount ?? 0} peers`;
}

function publishStatus(status = publicStatus()) {
  try {
    const { MODE, updateService } = require('../service-registry');
    const statuses = [...NETWORKS.keys()].map((chainId) => publicStatus(chainId));
    const running = statuses.filter((entry) => entry.running);
    const ready = running.filter((entry) => entry.state === 'ready');
    updateService('myotis', {
      mode:
        status.state === 'disabled'
          ? MODE.DISABLED
          : running.length
            ? MODE.BUNDLED
            : MODE.NONE,
      statusMessage: ready.length
        ? `${ready.map((entry) => entry.displayName).join(' + ')} ready`
        : registryMessage(status),
    });
  } catch {
    // The service registry is unavailable in plain-Node tooling.
  }
  broadcastStatus(status);
  return status;
}

function loadAddon() {
  if (addon) return true;
  if (isDisabledMyotisConfig()) {
    return false;
  }
  const addonFile = addonPath();
  if (!addonFile) {
    return false;
  }
  try {
    addon = require(addonFile);
  } catch (err) {
    addonError = err.message;
    log.warn(`[myotis] addon load failed (${addonFile}): ${err.message}`);
    return false;
  }
  let abi;
  try {
    abi = addon.init();
  } catch (err) {
    addonError = err.message;
    log.warn(`[myotis] init failed: ${err.message}`);
    addon = null;
    return false;
  }
  if (abi !== EXPECTED_ABI) {
    addonError = `ABI mismatch: engine ${abi}, expected ${EXPECTED_ABI}`;
    log.warn(`[myotis] ABI mismatch: engine ${abi}, expected ${EXPECTED_ABI} — not starting`);
    addon = null;
    return false;
  }
  addonError = null;
  return true;
}

function ensurePollers() {
  if (!drainTimer) {
    drainTimer = setInterval(drainEngineLogs, LOG_DRAIN_MS);
    if (drainTimer.unref) drainTimer.unref();
  }
  if (!readyWatchTimer) {
    readyWatchTimer = setInterval(() => {
      for (const chainId of NETWORKS.keys()) {
        const instance = instanceFor(chainId);
        if (instance.handle < 1) continue;
        publishStatus(publicStatus(chainId));
      }
    }, AVAILABILITY_POLL_MS);
    if (readyWatchTimer.unref) readyWatchTimer.unref();
  }
}

function startMyotis({ dataDir, chainId = 1 } = {}) {
  const instance = instanceFor(chainId);
  if (instance.handle >= 1) return true;
  instance.stopping = false;
  publishAvailability(instance, false, 'starting', true);
  if (isDisabledMyotisConfig() || !loadAddon()) {
    publishStatus(publicStatus(instance.chainId));
    return false;
  }
  const dir = dataDir || getMyotisDataDir(instance.name);
  try {
    instance.handle = addon.create(instance.name, dir);
  } catch (err) {
    instance.lastError = err.message;
    log.warn(`[myotis] ${instance.name} create failed: ${err.message}`);
    publishStatus(publicStatus(instance.chainId));
    return false;
  }
  if (instance.handle < 1) {
    instance.lastError = `Native create returned handle ${instance.handle}`;
    log.warn(`[myotis] ${instance.name} create failed: ${instance.handle}`);
    publishStatus(publicStatus(instance.chainId));
    return false;
  }
  let started;
  try {
    started = addon.start(instance.handle);
  } catch (err) {
    instance.lastError = err.message;
    log.warn(`[myotis] ${instance.name} start failed: ${err.message}`);
    instance.handle = -1;
    publishStatus(publicStatus(instance.chainId));
    return false;
  }
  if (!started) {
    instance.lastError = 'Native client refused to start';
    log.warn(`[myotis] ${instance.name} start failed`);
    instance.handle = -1;
    publishStatus(publicStatus(instance.chainId));
    return false;
  }
  instance.startedAt = Date.now();
  instance.lastStatus = null;
  instance.lastError = null;
  instance.wasReady = false;
  log.info(`[myotis] node started (${instance.name}, dataDir=${dir})`);
  publishStatus(publicStatus(instance.chainId));
  ensurePollers();
  return true;
}

function drainEngineLogs() {
  if (!addon) return;
  const batch = addon.drainLogs(200);
  if (!batch) return;
  for (const line of batch.split('\n')) {
    if (/ERROR/.test(line)) log.warn(`[myotis-engine] ${line}`);
    else if (/WARN/.test(line)) log.info(`[myotis-engine] ${line}`);
  }
}

function getStatus(chainId = 1) {
  const instance = instanceFor(chainId);
  if (!addon || instance.handle < 1) return null;
  try {
    instance.lastStatus = JSON.parse(addon.statusJson(instance.handle));
  } catch {
    return instance.lastStatus;
  }
  return instance.lastStatus;
}

// Ready = the verified read path can actually serve: beacon SYNCED, the EL
// reader up (and not hunting for a servable head context — first reads
// during a hunt fail on the cold context), and at least one snap-capable
// peer held. Callers treat not-ready as "skip myotis, use the next tier" —
// never as an error.
function updateReadiness(instance, s) {
  const ready = Boolean(
    s && s.beaconState === 'SYNCED' && s.elReaderAvailable && !s.elHunting && s.snapPeers > 0
  );
  publishAvailability(instance, ready, ready ? 'ready' : 'not-ready');
  return ready;
}

function isReady(chainId = 1) {
  const instance = instanceFor(chainId);
  if (instance.stopping || !addon || instance.handle < 1) return false;
  return updateReadiness(instance, getStatus(chainId));
}

function getAvailabilityEpoch(chainId = 1) {
  return instanceFor(chainId).availabilityEpoch;
}

// --- Verified reads (Promise<parsed JSON>) --------------------------------

function runningInstance(chainId = 1) {
  const instance = instanceFor(chainId);
  if (!addon || instance.handle < 1) throw new Error(`${instance.displayName} Myotis client is not running`);
  return instance;
}

async function resolveEnsRecord(params, chainId = 1) {
  const instance = runningInstance(chainId);
  const raw = await addon.ensRecordJson(instance.handle, JSON.stringify(params));
  return JSON.parse(raw);
}

async function resolveContenthash(name) {
  return resolveEnsRecord({ method: 'contenthash', name });
}

async function resolveAddress(name) {
  return resolveEnsRecord({ method: 'addr', name });
}

async function resolveReverse(addressHex) {
  return resolveEnsRecord({ method: 'reverse', addressHex });
}

async function ethCall({ from = '', to, data = '0x', value = '0', block = 'latest', chainId = 1 }) {
  const instance = runningInstance(chainId);
  const raw = await addon.ethCallJson(instance.handle, from, to, data, value, block);
  return JSON.parse(raw);
}

async function getAccount(address, chainId = 1) {
  const instance = runningInstance(chainId);
  return JSON.parse(await addon.requestAccountJson(instance.handle, address));
}

async function estimateGas({ from = '', to, data = '0x', value = '0', chainId = 1 }) {
  const instance = runningInstance(chainId);
  return JSON.parse(await addon.estimateGasJson(instance.handle, from, to, data, value));
}

async function feeEstimate(chainId = 1) {
  const instance = runningInstance(chainId);
  return JSON.parse(await addon.feeEstimateJson(instance.handle));
}

async function sendRawTransaction(rawTransaction, chainId = 1) {
  const instance = runningInstance(chainId);
  return JSON.parse(await addon.sendRawTransactionJson(instance.handle, rawTransaction));
}

function stopMyotis(chainId = 1) {
  const instance = instanceFor(chainId);
  instance.stopping = true;
  // Make new reads ineligible and invalidate in-flight consumers before the
  // blocking native stop begins. The handle remains intact for addon.stop().
  publishAvailability(instance, false, 'stopping', true);
  if (addon && instance.handle >= 1) {
    try {
      addon.stop(instance.handle);
      log.info(`[myotis] ${instance.name} stopped (uptime ${Math.round((Date.now() - instance.startedAt) / 1000)}s)`);
    } catch (err) {
      log.warn(`[myotis] ${instance.name} stop failed: ${err.message}`);
    }
  }
  instance.handle = -1;
  instance.lastStatus = null;
  instance.startedAt = 0;
  instance.lastError = null;
  instance.stopping = false;
  if (![...instances.values()].some((entry) => entry.handle >= 1)) {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
    if (readyWatchTimer) clearInterval(readyWatchTimer);
    readyWatchTimer = null;
  }
  publishStatus(publicStatus(instance.chainId));
}

function stopAllMyotis() {
  for (const chainId of NETWORKS.keys()) stopMyotis(chainId);
}

// Targets the upstream release publishes addons for (win-arm64 notably
// absent). Keys are process.platform-process.arch. Mirrors the matrix in
// scripts/fetch-myotis.js / check-binaries.js.
const SUPPORTED_TARGETS = new Set([
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
]);

function isSupportedTarget() {
  return SUPPORTED_TARGETS.has(`${process.platform}-${process.arch}`);
}

// Renderer-facing status snapshot (Nodes UI and settings ENS section). One flat
// object; `state` is the one-word summary the UI keys copy on. `supported`
// lets the UI distinguish "this platform can never run Myotis" (hide the
// controls) from "addon merely not installed" (disable with a hint).
function publicStatus(chainId = 1) {
  const instance = instanceFor(chainId);
  const supported = isSupportedTarget();
  const available = Boolean(addonPath());
  const base = {
    supported,
    available,
    version: MYOTIS_VERSION,
    chainId: instance.chainId,
    network: instance.name,
    displayName: instance.displayName,
  };
  if (isDisabledMyotisConfig()) {
    return { ...base, running: false, state: 'disabled' };
  }
  if (!available) return { ...base, running: false, state: 'unavailable' };
  const error = instance.lastError || addonError;
  if (error) {
    return { ...base, running: false, state: 'error', error };
  }
  if (instance.handle < 1) return { ...base, running: false, state: 'off' };
  const s = getStatus(instance.chainId) || {};
  const ready = instance.stopping ? false : updateReadiness(instance, s);
  return {
    ...base,
    running: true,
    state: ready ? 'ready' : 'syncing',
    beaconState: s.beaconState,
    currentPeriod: s.currentPeriod,
    targetPeriod: s.targetPeriod,
    peerCount: s.peerCount,
    snapPeers: s.snapPeers,
    finalizedBlockNumber: s.finalizedBlockNumber,
    uptimeSeconds: Math.round((Date.now() - instance.startedAt) / 1000),
  };
}

function registerMyotisIpc() {
  // Self-contained like the other register*Ipc() functions; lazy electron
  // require keeps the module loadable from plain-Node harnesses.
  const { ipcMain } = require('electron');
  const IPC = require('../../shared/ipc-channels');
  ipcMain.handle(IPC.MYOTIS_START, (_event, chainId = 1) => {
    startMyotis({ chainId });
    return publicStatus(chainId);
  });
  ipcMain.handle(IPC.MYOTIS_STOP, (_event, chainId = 1) => {
    stopMyotis(chainId);
    return publicStatus(chainId);
  });
  ipcMain.handle(IPC.MYOTIS_GET_STATUS, (_event, chainId = 1) => publicStatus(chainId));
  publishStatus();
}

function refreshMyotisStatus(chainId = 1) {
  return publishStatus(publicStatus(chainId));
}

module.exports = {
  isEnabled,
  isDisabledMyotisConfig,
  getMyotisDataPath,
  startMyotis,
  stopMyotis,
  stopAllMyotis,
  isReady,
  getStatus,
  publicStatus,
  registerMyotisIpc,
  refreshMyotisStatus,
  onReadyTransition,
  onAvailabilityTransition,
  getAvailabilityEpoch,
  resolveEnsRecord,
  resolveContenthash,
  resolveAddress,
  resolveReverse,
  ethCall,
  getAccount,
  estimateGas,
  feeEstimate,
  sendRawTransaction,
  NETWORKS,
};
