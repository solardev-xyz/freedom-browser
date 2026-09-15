// Myotis — a fully peer-to-peer Ethereum light client
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
const checkpointStore = require('./checkpoint-store');
const { acquireCheckpoint } = require('./checkpoint-verifier');
const MYOTIS_VERSION = '0.1.9';
const AVAILABILITY_POLL_MS = 1000;
const STATUS_FRESH_MS = 6000;
const STATUS_REQUEST_MS = 10000;
const RECOVERY_COOLDOWN_MS = 15000;
const RECOVERY_RETRY_MS = [15000, 60000];
const SYNC_NOTICE_MS = 5 * 60 * 1000;

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
      stopPromise: null,
      statusAt: 0,
      retryAfter: 0,
      lastStatus: null,
      startedAt: 0,
      lastError: null,
      wasReady: false,
      stopping: false,
      availabilityEpoch: 0,
      wanted: false,
      lifecycleToken: 0,
      baseDir: null,
      storage: null,
      recovery: null,
      recoveryAttempt: 0,
      recoveryPromise: null,
      recoveryController: null,
      recoveryTimer: null,
      notReadySince: 0,
      retiring: null,
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
  if (status.state === 'recovering') return 'Updating sync checkpoint';
  if (status.state === 'recovery-blocked') return 'Sync paused — checkpoint recovery needs attention';
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
  client.request('status', [], STATUS_REQUEST_MS).catch(() => {
    if (instance.client === client) {
      instance.lastStatus = null;
      publishAvailability(instance, false, 'status-unavailable');
    }
  }).finally(() => {
    if (instance.client === client) instance.statusPending = false;
  });
}

function profileIdentity() {
  const profile = require('../profile-resolver').getActiveProfile();
  return `${profile?.id || 'default'}:${profile?.path || profile?.userDataDir || ''}`;
}

function currentRun(instance, token) {
  return instance.lifecycleToken === token && instance.wanted && !instance.stopping &&
    !shuttingDown && !isDisabledMyotisConfig() && instance.profileIdentity === profileIdentity();
}

function clearRecoveryTimer(instance) {
  clearTimeout(instance.recoveryTimer);
  instance.recoveryTimer = null;
}

function failRecovery(instance, reason, retry = false) {
  if (!instance.wanted || shuttingDown || instance.stopping) return;
  clearRecoveryTimer(instance);
  const delay = retry ? RECOVERY_RETRY_MS[instance.recoveryAttempt - 1] : null;
  const token = instance.lifecycleToken;
  instance.recovery = {
    phase: delay ? 'waiting' : 'blocked', reason,
    attempt: instance.recoveryAttempt,
    nextRetryAt: delay ? Date.now() + delay : null,
    canRetry: reason !== 'unsupported',
  };
  instance.lastError = null;
  publishAvailability(instance, false, 'checkpoint-recovery-failed');
  publishStatus(publicStatus(instance.chainId));
  if (delay) {
    instance.recoveryTimer = setTimeout(() => {
      instance.recoveryTimer = null;
      if (currentRun(instance, token)) recoverCheckpoint(instance);
    }, delay);
    instance.recoveryTimer.unref?.();
  }
}

function canFinishRecovery(instance, status) {
  if (status?.beaconState !== 'SYNCED') return false;
  const checkpoint = instance.storage?.checkpoint;
  if (!checkpoint) return true;
  if (!Number.isSafeInteger(status.finalizedSlot) || status.finalizedSlot < checkpoint.slot ||
      !/^[0-9a-f]{64}$/i.test(status.finalizedRootHex || '')) return false;
  return status.finalizedSlot !== checkpoint.slot ||
    `0x${status.finalizedRootHex.toLowerCase()}` === checkpoint.root.toLowerCase();
}

function observeSync(instance, status) {
  if (!instance.wanted || instance.stopping || shuttingDown) return;
  if (status.beaconState === 'STALE_ANCHOR') {
    publishAvailability(instance, false, 'stale-checkpoint');
    if (!instance.recovery && !instance.recoveryPromise) recoverCheckpoint(instance);
    else if (instance.recovery?.phase === 'blocked' && instance.recovery.reason === 'stalled' &&
        !instance.recoveryPromise) recoverCheckpoint(instance, { resetAttempts: true });
    else if (instance.recovery?.phase === 'restarting' && !instance.recoveryPromise) {
      if (instance.recovery.mode === 'restart') {
        instance.recovery = null;
        recoverCheckpoint(instance, { resetAttempts: true });
      } else failRecovery(instance, 'stale', true);
    }
    return;
  }
  const checkpoint = instance.storage?.checkpoint;
  if (checkpoint && status.beaconState === 'SYNCED' &&
      status.finalizedSlot === checkpoint.slot &&
      /^[0-9a-f]{64}$/i.test(status.finalizedRootHex || '') &&
      `0x${status.finalizedRootHex.toLowerCase()}` !== checkpoint.root.toLowerCase()) {
    failRecovery(instance, 'mismatch');
    return;
  }
  const finished = canFinishRecovery(instance, status);
  const ready = finished && status.running === true && status.paused !== true &&
    status.elReaderAvailable === true && status.elHunting === false && status.snapPeers > 0;
  if ((finished && instance.recovery?.phase === 'restarting') ||
      (ready && instance.recovery?.reason === 'stalled')) {
    clearRecoveryTimer(instance);
    instance.recovery = null;
    instance.recoveryAttempt = 0;
  }
  if (ready && !instance.recovery) instance.notReadySince = 0;
  else {
    instance.notReadySince ||= Date.now();
    if (!instance.recoveryPromise && (!instance.recovery || instance.recovery.phase === 'restarting') &&
        Date.now() - instance.notReadySince >= SYNC_NOTICE_MS) failRecovery(instance, 'stalled');
  }
}

async function launchClient(instance, token) {
  if (!currentRun(instance, token)) return false;
  const addonFile = addonPath();
  if (!addonFile) return false;
  const client = new MyotisProcess({
    addonPath: addonFile,
    network: instance.name,
    dataDir: instance.storage.dataDir,
    checkpoint: instance.storage.checkpoint,
    resumeVerifiedState: instance.storage.resumeVerifiedState,
    onLifecycle: (event) => log.info(`[myotis] ${instance.name} lifecycle ${JSON.stringify(event)}`),
    onStatus: (status) => {
      if (instance.client !== client || !currentRun(instance, token)) return;
      instance.lastStatus = status;
      instance.statusAt = Date.now();
      observeSync(instance, status);
      publishStatus(publicStatus(instance.chainId));
    },
    onUnavailable: (message, code) => {
      if (instance.client !== client || instance.retiring === client || !currentRun(instance, token)) return;
      instance.lastStatus = null;
      instance.retryAfter = Date.now() + RECOVERY_COOLDOWN_MS;
      publishAvailability(instance, false, 'unavailable', true);
      failRecovery(instance, code === 'CHECKPOINT_UNSUPPORTED' ? 'unsupported' : 'startup');
      log.warn(`[myotis] ${instance.name} native process unavailable`);
    },
    onExit: () => {
      if (instance.client !== client) return;
      // onExit is emitted only after a verified native exit (or failed spawn).
      // A receipt arriving after the caller deadline releases the in-memory gate.
      if (client.exited && !instance.stopPromise) {
        instance.stopping = false;
        if (!instance.wanted) instance.lastError = null;
      }
      instance.lastStatus = null;
      publishAvailability(instance, false, 'exited');
      publishStatus(publicStatus(instance.chainId));
      if (![...instances.values()].some((entry) => entry.client && !entry.client.exited)) {
        clearInterval(readyWatchTimer);
        readyWatchTimer = null;
      }
    },
  });
  instance.client = client;
  const started = await client.startPromise;
  if (started && currentRun(instance, token) && instance.client === client) {
    instance.startedAt = Date.now();
    instance.notReadySince = Date.now();
    pollStatus(instance);
    ensurePollers();
  } else if (!currentRun(instance, token)) {
    await client.stop();
  }
  publishStatus(publicStatus(instance.chainId));
  return started && currentRun(instance, token);
}

function recoverCheckpoint(instance, { resetAttempts = false } = {}) {
  if (instance.recoveryPromise) return instance.recoveryPromise;
  const token = instance.lifecycleToken;
  if (!currentRun(instance, token)) return Promise.resolve(false);
  clearRecoveryTimer(instance);
  if (resetAttempts) instance.recoveryAttempt = 0;
  if (instance.client?.checkpointSupported === false) {
    failRecovery(instance, 'unsupported');
    return Promise.resolve(false);
  }
  const controller = new AbortController();
  instance.recoveryController = controller;
  instance.recoveryAttempt += 1;
  instance.recovery = { phase: 'checking', reason: null, attempt: instance.recoveryAttempt,
    nextRetryAt: null, canRetry: false };
  publishAvailability(instance, false, 'checkpoint-recovery', true);
  publishStatus(publicStatus(instance.chainId));
  const pending = (async () => {
    try {
      const checkpoint = await acquireCheckpoint(instance.chainId, { signal: controller.signal });
      if (!currentRun(instance, token) || controller.signal.aborted) return false;
      instance.recovery = { ...instance.recovery, phase: 'restarting' };
      publishStatus(publicStatus(instance.chainId));
      const previous = instance.client;
      if (previous && !previous.exited) {
        instance.retiring = previous;
        const exited = await previous.stop();
        instance.retiring = null;
        if (!currentRun(instance, token)) return false;
        if (!exited || !previous.exited) {
          failRecovery(instance, 'startup');
          return false;
        }
      }
      if (!currentRun(instance, token) || controller.signal.aborted) return false;
      const storage = await checkpointStore.replaceCheckpoint(instance.baseDir, instance.chainId, checkpoint);
      if (!currentRun(instance, token) || controller.signal.aborted) return false;
      instance.storage = storage;
      instance.lastStatus = null;
      instance.statusPending = false;
      instance.lastError = null;
      instance.retryAfter = 0;
      const started = await launchClient(instance, token);
      if (!started && currentRun(instance, token) && instance.recovery?.phase !== 'blocked') {
        failRecovery(instance, 'startup');
      }
      return started;
    } catch (error) {
      if (!currentRun(instance, token) || controller.signal.aborted) return false;
      const reasons = {
        CHECKPOINT_QUORUM_UNAVAILABLE: 'quorum-unavailable',
        CHECKPOINT_QUORUM_CONFLICT: 'quorum-conflict',
        CHECKPOINT_MISMATCH: 'mismatch', CHECKPOINT_CLOCK: 'clock',
        CHECKPOINT_STORAGE: 'storage', CHECKPOINT_OWNERSHIP: 'ownership', CHECKPOINT_STALE: 'stale',
        CHECKPOINT_INCOMPATIBLE: 'unsupported',
      };
      const retry = ['CHECKPOINT_UNAVAILABLE', 'CHECKPOINT_QUORUM_UNAVAILABLE', 'CHECKPOINT_RACE', 'CHECKPOINT_STALE'].includes(error.code);
      failRecovery(instance, reasons[error.code] || 'unavailable', retry);
      return false;
    }
  })();
  instance.recoveryPromise = pending;
  pending.finally(() => {
    if (instance.recoveryPromise === pending) {
      instance.recoveryPromise = null;
      instance.recoveryController = null;
    }
  });
  return pending;
}

// Ordinary process or peer failures do not require a different checkpoint.
// Retry the authenticated generation; its native stale guard can then request
// checkpoint recovery if the anchor really has expired.
function restartOwnedState(instance) {
  if (instance.recoveryPromise) return instance.recoveryPromise;
  const token = instance.lifecycleToken;
  if (!currentRun(instance, token)) return Promise.resolve(false);
  clearRecoveryTimer(instance);
  instance.recoveryAttempt = 0;
  instance.recovery = { phase: 'restarting', mode: 'restart', reason: null,
    attempt: 0, nextRetryAt: null, canRetry: false };
  publishAvailability(instance, false, 'restarting', true);
  publishStatus(publicStatus(instance.chainId));
  const pending = (async () => {
    try {
      const previous = instance.client;
      if (previous && !previous.exited) {
        instance.retiring = previous;
        const exited = await previous.stop();
        instance.retiring = null;
        if (!currentRun(instance, token)) return false;
        if (!exited || !previous.exited) {
          failRecovery(instance, 'ownership');
          return false;
        }
      }
      if (!currentRun(instance, token)) return false;
      const storage = await checkpointStore.loadOrCreateState(instance.baseDir, instance.chainId);
      if (!currentRun(instance, token)) return false;
      instance.storage = storage;
      instance.lastStatus = null;
      instance.statusPending = false;
      instance.lastError = null;
      instance.retryAfter = 0;
      const started = await launchClient(instance, token);
      if (!started && currentRun(instance, token) && instance.recovery?.phase !== 'blocked')
        failRecovery(instance, 'startup');
      return started;
    } catch (error) {
      if (currentRun(instance, token)) {
        const reason = error.code === 'CHECKPOINT_OWNERSHIP' ? 'ownership' :
          error.code === 'CHECKPOINT_STORAGE' ? 'storage' : 'startup';
        failRecovery(instance, reason);
      }
      return false;
    }
  })();
  instance.recoveryPromise = pending;
  pending.finally(() => { if (instance.recoveryPromise === pending) instance.recoveryPromise = null; });
  return pending;
}

function startMyotis({ dataDir, chainId = 1 } = {}) {
  const instance = instanceFor(chainId);
  if (shuttingDown || isDisabledMyotisConfig() || instance.stopping) return Promise.resolve(false);
  if (instance.startPromise) return instance.startPromise;
  if (instance.recoveryPromise || instance.recoveryTimer) return Promise.resolve(true);
  if (instance.client && !instance.client.exited) {
    return Promise.resolve(instance.client.accepting && !instance.stopping);
  }
  if (Date.now() < instance.retryAfter) return Promise.resolve(false);
  if (!addonPath()) { publishStatus(publicStatus(chainId)); return Promise.resolve(false); }
  instance.wanted = true;
  instance.baseDir = dataDir || getMyotisDataDir(instance.name);
  instance.profileIdentity = profileIdentity();
  instance.lifecycleToken += 1;
  const token = instance.lifecycleToken;
  instance.lastError = null;
  instance.lastStatus = null;
  instance.statusPending = false;
  instance.recovery = null;
  instance.recoveryAttempt = 0;
  publishAvailability(instance, false, 'starting', true);
  const pending = (async () => {
    try {
      instance.storage = await checkpointStore.loadOrCreateState(instance.baseDir, instance.chainId);
      if (!currentRun(instance, token)) return false;
      return await launchClient(instance, token);
    } catch (error) {
      if (currentRun(instance, token)) {
        const reason = error.code === 'CHECKPOINT_OWNERSHIP' ? 'ownership' :
          error.code === 'CHECKPOINT_STORAGE' ? 'storage' : 'startup';
        failRecovery(instance, reason);
      }
      return false;
    }
  })();
  instance.startPromise = pending;
  pending.finally(() => { if (instance.startPromise === pending) instance.startPromise = null; });
  return pending;
}

function getStatus(chainId = 1) {
  const instance = instanceFor(chainId);
  if (!currentRun(instance, instance.lifecycleToken) || !instance.client?.accepting ||
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
    !instance.recovery && canFinishRecovery(instance, s) && s && s.running === true && s.paused !== true && s.beaconState === 'SYNCED' && s.elReaderAvailable === true && s.elHunting === false &&
    typeof s.snapPeers === 'number' && s.snapPeers > 0
  );
  publishAvailability(instance, ready, ready ? 'ready' : 'not-ready');
  return ready;
}

function isReady(chainId = 1) {
  const instance = instanceFor(chainId);
  if (shuttingDown || !instance.wanted || instance.stopping || !instance.client?.accepting) return false;
  return updateReadiness(instance, getStatus(chainId));
}

function getAvailabilityEpoch(chainId = 1) {
  return instanceFor(chainId).availabilityEpoch;
}

// --- Verified reads (Promise<parsed JSON>) --------------------------------

function runningInstance(chainId = 1) {
  const instance = instanceFor(chainId);
  if (shuttingDown || instance.stopping || !instance.client?.accepting) throw new Error(`${instance.displayName} Myotis client is not running`);
  if (!isReady(chainId)) throw new Error(`${instance.displayName} Myotis verified reader is not ready`);
  return instance;
}

async function verifiedRequest(instance, op, args = []) {
  const client = instance.client;
  const epoch = instance.availabilityEpoch;
  const result = await client.request(op, args);
  if (instance.client !== client || instance.availabilityEpoch !== epoch || !isReady(instance.chainId)) {
    const error = new Error('Myotis state changed while the request was running');
    error.code = 'MYOTIS_UNAVAILABLE';
    throw error;
  }
  return result;
}

async function resolveEnsRecord(params, chainId = 1) {
  const instance = runningInstance(chainId);
  return verifiedRequest(instance, 'ens', [JSON.stringify(params)]);
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
  return verifiedRequest(instance, 'call', [from, to, data, value, block]);
}

async function getAccount(address, chainId = 1) {
  const instance = runningInstance(chainId);
  return verifiedRequest(instance, 'account', [address]);
}

async function estimateGas({ from = '', to, data = '0x', value = '0', chainId = 1 }) {
  const instance = runningInstance(chainId);
  return verifiedRequest(instance, 'gas', [from, to, data, value]);
}

async function feeEstimate(chainId = 1) {
  const instance = runningInstance(chainId);
  return verifiedRequest(instance, 'fee');
}

async function sendRawTransaction(rawTransaction, chainId = 1) {
  const instance = runningInstance(chainId);
  const result = await instance.client.request('broadcast', [rawTransaction]);
  if (!result || result.error || ['error', 'unavailable'].includes(result.status) || !(result.txHash || result.result)) {
    const error = new Error('Myotis broadcast outcome uncertain; reconcile the original signed transaction');
    error.code = 'MYOTIS_BROADCAST_UNCERTAIN';
    throw error;
  }
  return result;
}

function stopMyotis(chainId = 1) {
  const instance = instanceFor(chainId);
  if (instance.stopPromise) return instance.stopPromise;
  instance.wanted = false;
  instance.lifecycleToken += 1;
  instance.stopping = true;
  clearRecoveryTimer(instance);
  instance.recoveryController?.abort();
  instance.recovery = null;
  instance.recoveryAttempt = 0;
  instance.lastStatus = null;
  publishAvailability(instance, false, 'stopping', true);
  const pendingStart = instance.startPromise;
  const pendingRecovery = instance.recoveryPromise;
  const client = instance.client;
  const pending = (async () => {
    const exited = !client || await client.stop();
    await Promise.allSettled([pendingStart, pendingRecovery].filter(Boolean));
    const confirmed = exited || client?.exited === true;
    instance.stopping = !confirmed;
    instance.lastError = confirmed ? null : 'Myotis exit unconfirmed; restart blocked';
    instance.retryAfter = 0;
    publishStatus(publicStatus(chainId));
    return confirmed;
  })();
  instance.stopPromise = pending;
  pending.finally(() => { if (instance.stopPromise === pending) instance.stopPromise = null; });
  return pending;
}

function stopAllMyotis({ shutdown = false } = {}) {
  if (shutdown) shuttingDown = true;
  return Promise.all([...NETWORKS.keys()].map((chainId) => stopMyotis(chainId)));
}

// Supported native build targets (win-arm64 is absent). Keys match the
// source-build and packaging matrices.
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
    abi: 25,
    chainId: instance.chainId,
    network: instance.name,
    displayName: instance.displayName,
  };
  if (isDisabledMyotisConfig()) {
    return { ...base, running: false, state: 'disabled' };
  }
  if (!available) return { ...base, running: false, state: 'unavailable' };
  if (instance.recovery && instance.wanted) {
    return { ...base, running: true,
      state: ['checking', 'restarting', 'waiting'].includes(instance.recovery.phase) ? 'recovering' : 'recovery-blocked',
      recovery: { ...instance.recovery },
      beaconState: instance.lastStatus?.beaconState,
      peerCount: instance.lastStatus?.peerCount,
    };
  }
  const error = instance.lastError;
  if (error) {
    return { ...base, running: false, state: 'error', error };
  }
  if (!instance.client || instance.client.exited) return { ...base, running: instance.wanted, state: instance.wanted ? 'syncing' : 'off' };
  const s = getStatus(instance.chainId) || {};
  const ready = instance.stopping ? false : updateReadiness(instance, s);
  return {
    ...base,
    running: instance.wanted,
    state: !instance.wanted ? 'off' : ready ? 'ready' : 'syncing',
    beaconState: s.beaconState,
    paused: s.paused,
    wsBoundPeriods: s.wsBoundPeriods,
    optimisticBlockNumber: s.optimisticBlockNumber,
    executionBlockNumber: s.executionBlockNumber,
    currentPeriod: s.currentPeriod,
    targetPeriod: s.targetPeriod,
    peerCount: s.peerCount,
    snapPeers: s.snapPeers,
    finalizedBlockNumber: s.finalizedBlockNumber,
    uptimeSeconds: Math.round((Date.now() - instance.startedAt) / 1000),
  };
}

// Retry is a privileged browser action, never consent to skip verification.
function recoveryWindow(event) {
  const { BrowserWindow } = require('electron');
  const { fileURLToPath } = require('url');
  try {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null;
    if (fileURLToPath(event.senderFrame.url) !== path.resolve(__dirname, '../../renderer/index.html')) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() && win.webContents === event.sender ? win : null;
  } catch { return null; }
}

function retryCheckpoint(event, chainId = 1) {
  if (!recoveryWindow(event)) throw new Error('Myotis recovery is only available from the browser Nodes menu');
  const instance = instanceFor(chainId);
  if (instance.wanted && instance.recovery?.canRetry && !instance.stopping) {
    if (['startup', 'stalled', 'storage', 'ownership'].includes(instance.recovery.reason))
      restartOwnedState(instance);
    else recoverCheckpoint(instance, { resetAttempts: true });
  }
  return publicStatus(chainId);
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
  ipcMain.handle(IPC.MYOTIS_RETRY_CHECKPOINT, retryCheckpoint);
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
