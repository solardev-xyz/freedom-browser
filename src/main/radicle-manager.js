const fs = require('fs');
const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const log = require('./logger');
const IPC = require('../shared/ipc-channels');
const { success, failure, validateNonEmptyString } = require('./ipc-contract');
const { getRadicleDataDir } = require('./profile-paths');
const { getActiveProfile } = require('./profile-resolver');
const embedded = require('./radicle-embedded');
const seedStatus = require('./radicle/seed-status');
const {
  MODE,
  updateService,
  setStatusMessage,
  clearService,
} = require('./service-registry');

const FREEDOM_BROWSER_RID = 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE';

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let useInjectedIdentity = false;
let lifecycleTail = Promise.resolve();
let infoUpdatePromise = null;

function enqueueLifecycle(operation) {
  const result = lifecycleTail.then(operation, operation);
  lifecycleTail = result.catch(() => {});
  return result;
}

function validateAndNormalizeRid(rid) {
  if (!rid || typeof rid !== 'string') return null;
  let bare = rid;
  if (bare.startsWith('rad://')) bare = bare.slice(6);
  else if (bare.startsWith('rad:')) bare = bare.slice(4);
  if (!/^z[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(bare)) return null;
  return `rad:${bare}`;
}

function broadcastStatus(extra = {}) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.RADICLE_STATUS_UPDATE, {
      status: currentState,
      error: lastError,
      ...extra,
    });
  }
}

function updateState(status, error = null) {
  log.info('[Radicle] State change:', currentState, '->', status, error || '');
  currentState = status;
  lastError = error;
  broadcastStatus();
  if (status === STATUS.RUNNING) void pushInfoUpdate();
}

function pushInfoUpdate() {
  if (currentState !== STATUS.RUNNING) return Promise.resolve();
  if (infoUpdatePromise) return infoUpdatePromise;
  infoUpdatePromise = getConnections()
    .then((info) => broadcastStatus({ info }))
    .catch((err) => log.warn('[Radicle] Could not publish node info:', err.message))
    .finally(() => {
      infoUpdatePromise = null;
    });
  return infoUpdatePromise;
}

function isDisabledForProfile() {
  return getActiveProfile()?.metadata?.nodes?.radicle?.mode === 'disabled';
}

async function syncProfileMode() {
  if (isDisabledForProfile()) {
    await stopRadicle();
    updateService('radicle', { api: null, gateway: null, mode: MODE.DISABLED });
    setStatusMessage('radicle', 'Disabled for this profile');
    updateState(STATUS.STOPPED);
    return getCurrentStatus();
  }

  if (currentState === STATUS.STOPPED) {
    clearService('radicle');
    updateState(STATUS.STOPPED);
  }
  return getCurrentStatus();
}

async function connectAndSeedDefault() {
  try {
    const bootstrap = await embedded.connectSeeds(15000);
    const connected = Number.isFinite(bootstrap.connected) ? bootstrap.connected : 0;
    // v0.6.x returned only `{ connected }`; require at least one live peer
    // while an older addon is still installed instead of treating 0/0 as ready.
    const target = Number.isFinite(bootstrap.target) ? bootstrap.target : 1;
    const attempted = Number.isFinite(bootstrap.attempted) ? bootstrap.attempted : connected;
    const elapsedMs = Number.isFinite(bootstrap.elapsedMs) ? bootstrap.elapsedMs : 0;
    let livePeers = connected;
    try {
      const status = await embedded.status();
      if (Number.isFinite(status.connectedPeers)) {
        livePeers = Math.max(livePeers, status.connectedPeers);
      }
    } catch (err) {
      log.warn('[Radicle] Could not read peer count after seed bootstrap:', err.message);
    }
    const targetReached = (bootstrap.targetReached ?? connected >= target) || livePeers >= target;
    const readiness = targetReached ? 'ready' : 'degraded';
    log.info(
      `[Radicle] Seed bootstrap ${readiness}: ${connected}/${target} ` +
      `seed connections, ${livePeers} live peers, ${attempted} attempted in ${elapsedMs}ms`
    );
    if (!targetReached) {
      log.warn(
        `[Radicle] Seed bootstrap did not reach its target; continuing with ` +
        `${connected} connected peer(s)`
      );
    }
    await pushInfoUpdate();
    await embedded.cloneRepo(FREEDOM_BROWSER_RID, 120000);
    log.info(`[Radicle] Default repository available: ${FREEDOM_BROWSER_RID}`);
    await pushInfoUpdate();
  } catch (err) {
    log.warn('[Radicle] Background network initialization failed:', err.message);
  }
}

async function startRadicleInternal() {
  if (currentState === STATUS.RUNNING) return getCurrentStatus();
  if (isDisabledForProfile()) {
    updateService('radicle', { api: null, gateway: null, mode: MODE.DISABLED });
    setStatusMessage('radicle', 'Node disabled for this profile');
    updateState(STATUS.STOPPED);
    return getCurrentStatus();
  }
  if (!embedded.isAvailable()) {
    const message = 'libradicle addon is not installed';
    clearService('radicle');
    updateState(STATUS.ERROR, message);
    return getCurrentStatus();
  }

  updateState(STATUS.STARTING);
  try {
    const radHome = getRadicleDataDir();
    const result = await embedded.start(radHome, 'FreedomBrowser');
    updateService('radicle', {
      api: 'radapi://local',
      gateway: 'radapi://local',
      mode: MODE.EMBEDDED,
    });
    setStatusMessage('radicle', null);
    updateState(STATUS.RUNNING);
    log.info('[Radicle] Embedded node started:', result.did);
    void connectAndSeedDefault();
    return getCurrentStatus();
  } catch (err) {
    clearService('radicle');
    updateState(STATUS.ERROR, err.message);
    return getCurrentStatus();
  }
}

function startRadicle() {
  return enqueueLifecycle(startRadicleInternal);
}

async function stopRadicleInternal() {
  if (currentState === STATUS.STOPPED) return getCurrentStatus();
  updateState(STATUS.STOPPING);
  try {
    await embedded.shutdown();
    clearService('radicle');
    updateState(STATUS.STOPPED);
  } catch (err) {
    clearService('radicle');
    updateState(STATUS.ERROR, err.message);
  }
  return getCurrentStatus();
}

function stopRadicle() {
  return enqueueLifecycle(stopRadicleInternal);
}

function requireRunning() {
  return currentState === STATUS.RUNNING
    ? null
    : failure('RADICLE_NOT_RUNNING', 'Radicle node is not running');
}

async function repoExists(rid) {
  try {
    await embedded.repoInfo(rid);
    return true;
  } catch {
    return false;
  }
}

async function getSeederCount(rid) {
  return (await embedded.seeders(rid)).seeding;
}

function startTrackedFetch(rid, onStatus) {
  const publishStatus = (status) => {
    onStatus?.(status);
    if (
      status?.progress?.phase === 'connecting' ||
      status?.progress?.phase === 'fetching' ||
      status?.state !== 'fetching'
    ) {
      void pushInfoUpdate();
    }
  };
  const status = seedStatus.startFetch(rid, {
    fetchRepo: (value, onProgress) =>
      embedded.cloneRepoWithProgress(value, 120000, onProgress),
    getSeeders: getSeederCount,
    onStatus: publishStatus,
  });
  return success({ status });
}

/**
 * Seed a repository: the native fetch writes the seeding policy as it
 * replicates, so this commits the user's disk and bandwidth. Consent for
 * that commitment is the caller's job — every entry point either belongs
 * to the browser's own UI or sits behind the provider's per-repo prompt.
 */
async function seedRepository(rid, onStatus) {
  const unavailable = requireRunning();
  if (unavailable) return unavailable;
  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  return startTrackedFetch(fullRid, onStatus);
}

async function isSeeded(fullRid) {
  try {
    const repos = await embedded.listSeededRepos();
    return Array.isArray(repos) && repos.some((repo) => repo?.rid === fullRid);
  } catch (err) {
    log.warn(`[Radicle] Could not read seeding policies for ${fullRid}:`, err.message);
    return false;
  }
}

/**
 * Re-run the network fetch for an ALREADY-seeded repository — the retry
 * path after a failed fetch (`radicle_sync`, and the sidebar's sync
 * action).
 *
 * This deliberately does NOT fall through to seedRepository. The native
 * fetch writes a persistent seeding policy as a side effect, so aliasing
 * the two would let anything holding only the lightweight connection
 * grant commit the user to replicating an arbitrary repo — exactly what
 * seeding gates behind a per-repo consent prompt. Unknown repos are
 * rejected, and a policy lookup that fails counts as "not seeded".
 */
async function refetchRepository(rid, onStatus) {
  const unavailable = requireRunning();
  if (unavailable) return unavailable;
  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  if (!(await isSeeded(fullRid))) {
    return failure('NOT_SEEDED', 'Repository is not seeded — seed it before syncing', {
      rid: fullRid,
    });
  }
  return startTrackedFetch(fullRid, onStatus);
}

async function getSeedFetchStatus(rid, onStatus) {
  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  if (onStatus) seedStatus.subscribe(fullRid, onStatus);
  const status = await seedStatus.getStatus(fullRid, {
    repoExists,
    getSeeders: getSeederCount,
  });
  return success({ status });
}

function unsubscribeSeedStatus(listener) {
  seedStatus.unsubscribe(listener);
}

async function cancelCloneWithRetry(rid) {
  const delays = [0, 10, 25, 50, 100];
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const result = await embedded.cancelClone(rid);
      if (result?.cancelled) return true;
    } catch (err) {
      log.warn(`[Radicle] Could not request clone cancellation for ${rid}:`, err.message);
      return false;
    }
  }
  return false;
}

async function unseedRepository(rid) {
  const unavailable = requireRunning();
  if (unavailable) return unavailable;
  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  const fetchDone = seedStatus.cancelFetch(fullRid);
  const cancellation = fetchDone ? cancelCloneWithRetry(fullRid) : Promise.resolve(false);
  // Heartwood's pack transfer is a blocking operation, so native
  // cancellation can only be observed when that call returns. Re-apply
  // the policy afterward to prevent a late clone from leaving the repo
  // seeded after the user explicitly unseeded it, even if the immediate
  // unseed attempt fails.
  if (fetchDone) {
    void Promise.all([fetchDone, cancellation])
      .then(() => embedded.unseedRepo(fullRid))
      .catch((err) => log.warn(`[Radicle] Final unseed failed for ${fullRid}:`, err.message));
  }
  try {
    await embedded.unseedRepo(fullRid);
    await pushInfoUpdate();
    return success();
  } catch (err) {
    return failure('UNSEED_FAILED', err.message, { rid: fullRid });
  }
}

async function getConnections() {
  const unavailable = requireRunning();
  if (unavailable) {
    return {
      ...unavailable,
      count: 0,
      reposCount: null,
      version: embedded.getVersion(),
    };
  }
  try {
    const { connectedPeers } = await embedded.status();
    let reposCount = null;
    try {
      const repos = await embedded.listRepos();
      reposCount = Array.isArray(repos) ? repos.length : null;
    } catch (err) {
      log.warn('[Radicle] Could not read seeded repository count:', err.message);
    }
    return success({
      count: connectedPeers,
      reposCount,
      version: embedded.getVersion(),
    });
  } catch (err) {
    return failure('GET_CONNECTIONS_FAILED', err.message, undefined, {
      count: 0,
      reposCount: null,
      version: embedded.getVersion(),
    });
  }
}

function getCurrentStatus() {
  return { status: currentState, error: lastError };
}

function getRadicleDataPath() {
  return getRadicleDataDir();
}

function setUseInjectedIdentity(enabled) {
  useInjectedIdentity = Boolean(enabled);
}

function hasInjectedIdentity() {
  return useInjectedIdentity;
}

function checkBinary() {
  return embedded.isAvailable();
}

function getNodeAlias() {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(getRadicleDataDir(), 'config.json'), 'utf8')
    );
    return config?.node?.alias || null;
  } catch {
    return null;
  }
}

function isValidAlias(alias) {
  return (
    typeof alias === 'string' &&
    alias.length > 0 &&
    Buffer.byteLength(alias, 'utf8') <= 32 &&
    // eslint-disable-next-line no-control-regex
    !/[\s\u0000-\u001f\u007f]/.test(alias)
  );
}

function setNodeAlias(alias) {
  if (!isValidAlias(alias)) {
    return Promise.resolve(failure(
      'INVALID_ALIAS',
      'Alias must be 1–32 bytes with no whitespace or control characters'
    ));
  }
  return enqueueLifecycle(async () => {
    const restart = currentState === STATUS.RUNNING;
    if (restart) await stopRadicleInternal();
    const configPath = path.join(getRadicleDataDir(), 'config.json');
    try {
      let config = {};
      if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.node = config.node || {};
      config.node.alias = alias;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      return failure('ALIAS_WRITE_FAILED', err.message);
    }
    if (restart) await startRadicleInternal();
    return success({ alias, restarted: restart });
  });
}

function registerRadicleIpc() {
  ipcMain.handle(IPC.RADICLE_START, () => startRadicle());
  ipcMain.handle(IPC.RADICLE_STOP, () => stopRadicle());
  ipcMain.handle(IPC.RADICLE_GET_STATUS, () => getCurrentStatus());
  ipcMain.handle(IPC.RADICLE_CHECK_BINARY, () => ({ available: checkBinary() }));
  const pushStatus = (event) => (status) => {
    if (!event?.sender?.isDestroyed?.()) {
      event?.sender?.send?.(IPC.RADICLE_SEED_STATUS_UPDATE, status);
    }
  };

  ipcMain.handle(IPC.RADICLE_SEED, async (event, rid) => {
    if (isDisabledForProfile()) {
      return failure('RADICLE_DISABLED', 'Radicle is disabled for this profile');
    }
    if (!validateNonEmptyString(rid)) return failure('INVALID_RID', 'Missing repository ID');
    return seedRepository(rid, pushStatus(event));
  });
  ipcMain.handle(IPC.RADICLE_GET_CONNECTIONS, () => getConnections());
  ipcMain.handle(IPC.RADICLE_SYNC_REPO, (event, rid) =>
    refetchRepository(rid, pushStatus(event))
  );
  ipcMain.handle(IPC.RADICLE_GET_SEED_STATUS, (_event, rid) => getSeedFetchStatus(rid));
}

module.exports = {
  registerRadicleIpc,
  startRadicle,
  stopRadicle,
  getRadicleDataPath,
  setUseInjectedIdentity,
  hasInjectedIdentity,
  getCurrentStatus,
  getConnections,
  seedRepository,
  unseedRepository,
  getSeedFetchStatus,
  unsubscribeSeedStatus,
  refetchRepository,
  validateAndNormalizeRid,
  getNodeAlias,
  setNodeAlias,
  isDisabledForProfile,
  syncProfileMode,
  STATUS,
};
