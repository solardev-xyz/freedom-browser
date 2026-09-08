// EXPERIMENTAL (spike): Myotis — a fully peer-to-peer Ethereum light client
// (devp2p + beacon light client; every read Merkle-proven against a
// sync-committee-anchored state root). Runs invisibly like the ant/IPFS
// nodes, via a napi-rs native addon over the myotis-engine C ABI.
//
// Available through an explicit MYOTIS_NODE_PATH, the development download,
// or the packaged resource. Profile configuration can disable it; otherwise
// the profile-local autostart preference or Nodes UI controls its lifecycle.
// Every addon call runs in a supervised child, with a separate libuv pool.
// Main retains policy, profile ownership, cached status, and renderer IPC.
const log = require('../logger');
const path = require('path');
const { getMyotisDataDir } = require('../profile-paths');

const { MyotisProcess } = require('./myotis-process');
const MYOTIS_VERSION = '0.1.7';
const AVAILABILITY_POLL_MS = 1000;
const STATUS_FRESH_MS = 3000;
const RECOVERY_COOLDOWN_MS = 15000;

const NETWORKS = new Map([
  [1, { chainId: 1, name: 'mainnet', displayName: 'Ethereum' }],
  [100, { chainId: 100, name: 'gnosis', displayName: 'Gnosis' }],
]);

let shuttingDown = false;
let readyWatchTimer = null;
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
      client: null,
      startPromise: null,
      statusAt: 0,
      retryAfter: 0,
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

function ensurePollers() {
  if (readyWatchTimer) return;
  readyWatchTimer = setInterval(() => {
    for (const chainId of NETWORKS.keys()) {
      const instance = instanceFor(chainId);
      if (!instance.client?.accepting || instance.stopping) continue;
      // Only one status request per child, and no native call in main.
      pollStatus(instance);
      publishStatus(publicStatus(chainId));
    }
  }, AVAILABILITY_POLL_MS);
  readyWatchTimer.unref?.();
}

function pollStatus(instance) {
  if (instance.statusPending) return;
  instance.statusPending = true;
  const client = instance.client;
  client.request('status', [], STATUS_FRESH_MS).catch(() => {
    if (instance.client === client) {
      instance.lastStatus = null;
      publishAvailability(instance, false, 'status-unavailable');
    }
  }).finally(() => {
    if (instance.client === client) instance.statusPending = false;
  });
}

function startMyotis({ dataDir, chainId = 1 } = {}) {
  const instance = instanceFor(chainId);
  if (shuttingDown || isDisabledMyotisConfig()) return Promise.resolve(false);
  if (instance.startPromise) return instance.startPromise;
  if (instance.client && !instance.client.exited) {
    return Promise.resolve(instance.client.accepting && !instance.stopping);
  }
  if (Date.now() < instance.retryAfter) return Promise.resolve(false);
  const addonFile = addonPath();
  if (!addonFile) { publishStatus(publicStatus(chainId)); return Promise.resolve(false); }
  instance.stopping = false;
  instance.lastError = null;
  instance.lastStatus = null;
  instance.statusPending = false;
  publishAvailability(instance, false, 'starting', true);
  try {
    const client = new MyotisProcess({
      addonPath: addonFile,
      network: instance.name,
      dataDir: dataDir || getMyotisDataDir(instance.name),
      onLifecycle: (event) => log.info(`[myotis] ${instance.name} lifecycle ${JSON.stringify(event)}`),
      onStatus: (status) => {
        if (instance.client !== client || instance.stopping) return;
        instance.lastStatus = status;
        instance.statusAt = Date.now();
        publishStatus(publicStatus(chainId));
      },
      onUnavailable: (message) => {
        if (instance.client !== client) return;
        instance.lastError = message;
        instance.lastStatus = null;
        instance.retryAfter = Date.now() + RECOVERY_COOLDOWN_MS;
        publishAvailability(instance, false, 'unavailable', true);
        publishStatus(publicStatus(chainId));
      },
      onExit: () => {
        if (instance.client !== client) return;
        instance.lastStatus = null;
        instance.stopping = false;
        publishAvailability(instance, false, 'exited');
        publishStatus(publicStatus(chainId));
        if (![...instances.values()].some((entry) => entry.client && !entry.client.exited)) {
          clearInterval(readyWatchTimer);
          readyWatchTimer = null;
        }
      },
    });
    instance.client = client;
    instance.startPromise = client.startPromise.then((started) => {
      if (started && !instance.stopping && !shuttingDown) {
        instance.startedAt = Date.now();
        pollStatus(instance);
        ensurePollers();
      }
      publishStatus(publicStatus(chainId));
      return started;
    }).finally(() => { instance.startPromise = null; });
    return instance.startPromise;
  } catch {
    log.warn(`[myotis] ${instance.name} supervisor launch unavailable`);
    instance.lastError = 'Myotis process supervisor unavailable';
    instance.retryAfter = Date.now() + RECOVERY_COOLDOWN_MS;
    publishStatus(publicStatus(chainId));
    return Promise.resolve(false);
  }
}

function getStatus(chainId = 1) {
  const instance = instanceFor(chainId);
  if (!instance.client?.accepting || instance.stopping ||
      Date.now() - instance.statusAt >= STATUS_FRESH_MS) return null;
  return instance.lastStatus ? { ...instance.lastStatus } : null;
}

// Ready = the verified read path can actually serve: beacon SYNCED, the EL
// reader up (and not hunting for a servable head context — first reads
// during a hunt fail on the cold context), and at least one snap-capable
// peer held. Callers treat not-ready as "skip myotis, use the next tier" —
// never as an error.
function updateReadiness(instance, s) {
  const ready = Boolean(
    s && s.beaconState === 'SYNCED' && s.elReaderAvailable === true && s.elHunting === false &&
    typeof s.snapPeers === 'number' && s.snapPeers > 0
  );
  publishAvailability(instance, ready, ready ? 'ready' : 'not-ready');
  return ready;
}

function isReady(chainId = 1) {
  const instance = instanceFor(chainId);
  if (shuttingDown || instance.stopping || !instance.client?.accepting) return false;
  return updateReadiness(instance, getStatus(chainId));
}

function getAvailabilityEpoch(chainId = 1) {
  return instanceFor(chainId).availabilityEpoch;
}

// --- Verified reads (Promise<parsed JSON>) --------------------------------

function runningInstance(chainId = 1) {
  const instance = instanceFor(chainId);
  if (shuttingDown || instance.stopping || !instance.client?.accepting) throw new Error(`${instance.displayName} Myotis client is not running`);
  return instance;
}

async function resolveEnsRecord(params, chainId = 1) {
  const instance = runningInstance(chainId);
  return instance.client.request('ens', [JSON.stringify(params)]);
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
  return instance.client.request('call', [from, to, data, value, block]);
}

async function getAccount(address, chainId = 1) {
  const instance = runningInstance(chainId);
  return instance.client.request('account', [address]);
}

async function estimateGas({ from = '', to, data = '0x', value = '0', chainId = 1 }) {
  const instance = runningInstance(chainId);
  return instance.client.request('gas', [from, to, data, value]);
}

async function feeEstimate(chainId = 1) {
  const instance = runningInstance(chainId);
  return instance.client.request('fee');
}

async function sendRawTransaction(rawTransaction, chainId = 1) {
  const instance = runningInstance(chainId);
  return instance.client.request('broadcast', [rawTransaction]);
}

async function stopMyotis(chainId = 1) {
  const instance = instanceFor(chainId);
  instance.stopping = true;
  instance.lastStatus = null;
  publishAvailability(instance, false, 'stopping', true);
  const exited = !instance.client || await instance.client.stop();
  instance.stopping = !exited;
  if (!exited) instance.lastError = 'Myotis exit unconfirmed; restart blocked';
  publishStatus(publicStatus(chainId));
  return exited;
}

function stopAllMyotis({ shutdown = false } = {}) {
  if (shutdown) shuttingDown = true;
  return Promise.all([...NETWORKS.keys()].map((chainId) => stopMyotis(chainId)));
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
  const error = instance.lastError;
  if (error) {
    return { ...base, running: false, state: 'error', error };
  }
  if (!instance.client || instance.client.exited) return { ...base, running: false, state: 'off' };
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
  ipcMain.handle(IPC.MYOTIS_START, async (_event, chainId = 1) => {
    await startMyotis({ chainId });
    return publicStatus(chainId);
  });
  ipcMain.handle(IPC.MYOTIS_STOP, async (_event, chainId = 1) => {
    await stopMyotis(chainId);
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
