const fs = require('fs');
const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const log = require('./logger');
const IPC = require('../shared/ipc-channels');
const { success, failure, validateNonEmptyString } = require('./ipc-contract');
const { getRadicleDataDir, prepareRadicleDataDir } = require('./profile-paths');
const { getActiveProfile } = require('./profile-resolver');
const embedded = require('./radicle-embedded');
const { nodeBlockReason } = require('./core/node-identity-guard');
const { withPrivateDir } = require('./private-files');
const { isPrivateSender } = require('./private/private-sender');
// PRIVATE MODE GUARD (#1073): window.radicle requests reach the log lines
// below inside the provider's private log context. The add-on's text can
// name its storage path, and a RID names the repository, so each goes
// through redactForLog. The context alone redacts nothing.
const { redactForLog } = require('./private/private-log-context');
const seedStatus = require('./radicle/seed-status');
const {
  takeRadicleGate,
  withRadicleGate,
  switchedHomeRefusal,
} = require('./radicle/radicled-gate');
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
// The Radicle home's gate (freedom-core design 0008, "Spawn and lock" and
// Rollback; radicle/radicled-gate.js), held for the add-on from before its
// start until its shutdown proves it stopped: `{ hold, lost }`, `hold` null
// in a development build without freedom-radicled (ungated). Null while no
// node can hold the home. A stop that wasn't proved keeps it: the node may
// still write the home (R-8).
let homeGate = null;
// The gate waits of the starts asked for and not yet past their gate. A
// stop gives each up at once, begun or not, so it never waits out another
// writer's hold (0008, Rollback).
const gateWaits = new Set();
// The failure a node reports when the holder of its home's gate ends under
// it (0008, Rollback).
const GATE_LOST = 'freedom-radicled hold-lock exited';

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
    .catch((err) => log.warn('[Radicle] Could not publish node info:', redactForLog(err.message)))
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
    const stopped = await stopRadicle();
    // A stop that wasn't proved (R-8): the node may still run, so it is
    // not published as disabled and stopped. The failed stop's error stays,
    // and a later stop can still recover.
    if (embedded.isStarted()) return stopped;
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

// A node whose stop was never proved (its shutdown rejected) may still be
// running on the home: the add-on still counts it as started. Until a later
// shutdown proves it stopped, only a stop (the recovery) may run; a start
// or an alias change is refused, and the shutdown's error stays (R-8).
function stopUnproved() {
  return currentState !== STATUS.RUNNING && embedded.isStarted();
}

const UNPROVED_STOP_MESSAGE = 'The Radicle node did not stop; stop it again before starting it';

/** Takes the home's gate for a node about to start; `signal` gives up the
 * wait. Rejects with a RadicleGateError. */
async function takeHomeGate(home, signal) {
  const gate = { hold: null, lost: false };
  gate.hold = await takeRadicleGate(home, { signal, onLost: () => onHomeGateLost(gate) });
  homeGate = gate;
  return gate;
}

async function releaseHomeGate() {
  const gate = homeGate;
  homeGate = null;
  await gate?.hold?.release();
}

/**
 * The gate's holder ended under the node: another gated writer (the
 * service, a profile delete, the core's identity write) could now take the
 * home while the add-on writes to it. A running node stops, with the loss as
 * its error, and the user starts it again, which takes the gate again. A
 * start still under way checks for the loss itself, before its node starts
 * and once it has.
 */
function onHomeGateLost(gate) {
  gate.lost = true;
  if (homeGate !== gate || currentState !== STATUS.RUNNING) return;
  void enqueueLifecycle(async () => {
    if (homeGate !== gate) return;
    try {
      await stopNode({ error: GATE_LOST });
    } catch {
      // Reported through the status.
    }
  });
}

async function startRadicleInternal({ signal = null } = {}) {
  if (currentState === STATUS.RUNNING) return getCurrentStatus();
  if (stopUnproved()) {
    // Before prepareRadicleDataDir() or embedded.start(): nothing touches
    // the home a node may still hold.
    if (currentState !== STATUS.ERROR) updateState(STATUS.ERROR, UNPROVED_STOP_MESSAGE);
    log.warn('[Radicle] Not starting: the last stop was never proved');
    return getCurrentStatus();
  }
  if (isDisabledForProfile()) {
    updateService('radicle', { api: null, gateway: null, mode: MODE.DISABLED });
    setStatusMessage('radicle', 'Node disabled for this profile');
    updateState(STATUS.STOPPED);
    return getCurrentStatus();
  }
  const identityBlock = nodeBlockReason('radicle');
  if (identityBlock) {
    clearService('radicle');
    updateState(STATUS.ERROR, identityBlock);
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
    const radHome = await prepareRadicleDataDir();
    // The home's gate, before anything here reads or writes the home's
    // files (0008, Rollback): the add-on is a writer the gate excludes, as
    // the service is. Held until a shutdown proves the node stopped
    // (stopNode); a start that leaves no node lets it go (below).
    const gate = await takeHomeGate(radHome, signal);
    // Under the gate, so no service switches the home meanwhile.
    const switched = switchedHomeRefusal(radHome);
    if (switched) {
      log.warn('[Radicle] Not starting the add-on: the service has switched its home');
      clearService('radicle');
      updateState(STATUS.ERROR, switched);
      return getCurrentStatus();
    }
    // The home is owner-only now (profile-paths). Its keys/ is opened
    // through the home's handle, never through a link. The node opens
    // keys/radicle by its path, following a link there: missing is fine
    // (the core writes it), but a key that is a link, not a regular file of
    // ours, or not owner-only once narrowed stops the start, and so does
    // such a home or keys/. Keys an older build left with the umask's modes
    // are narrowed (K-3).
    withPrivateDir(radHome, (home) =>
      home.openDir('keys', { create: false })?.requirePrivate('radicle')
    );
    // Again at the boundary: an identity write may have begun meanwhile.
    const blockedNow = nodeBlockReason('radicle');
    if (blockedNow) {
      clearService('radicle');
      updateState(STATUS.ERROR, blockedNow);
      return getCurrentStatus();
    }
    if (gate.lost) throw new Error(GATE_LOST);
    const result = await embedded.start(radHome, 'FreedomBrowser');
    // The gate went while the node started: it never runs ungated.
    if (gate.lost) {
      await stopNode({ error: GATE_LOST });
      return getCurrentStatus();
    }
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
    // A wait for the gate a stop gave up: nothing started, nothing failed.
    if (err?.name === 'RadicleGateError' && err.code === 'cancelled') {
      updateState(STATUS.STOPPED);
    } else {
      updateState(STATUS.ERROR, err.message);
    }
    return getCurrentStatus();
  } finally {
    // A start that left no node holds no gate.
    if (!embedded.isStarted()) await releaseHomeGate();
  }
}

function startRadicle() {
  // Made as the start is asked for, so a stop asked for after it gives up
  // its gate wait even before the wait has begun.
  const gateWait = new AbortController();
  gateWaits.add(gateWait);
  const started = enqueueLifecycle(() => startRadicleInternal({ signal: gateWait.signal }));
  const done = () => gateWaits.delete(gateWait);
  started.then(done, done);
  return started;
}

// Stop the node. Resolves once the add-on proved it stopped (its shutdown
// joined the node's thread), and its home's gate is let go; otherwise
// records the error and throws, the gate still held. `error` is what a
// proved stop leaves as the status's error (the gate's loss), if anything.
async function stopNode({ error = null } = {}) {
  // Stopped, and proved stopped: the add-on no longer counts it as started.
  if (currentState === STATUS.STOPPED && !embedded.isStarted()) return;
  updateState(STATUS.STOPPING);
  try {
    await embedded.shutdown();
  } catch (err) {
    clearService('radicle');
    updateState(STATUS.ERROR, err.message);
    throw err;
  }
  // Proved stopped: the gate goes last.
  await releaseHomeGate();
  clearService('radicle');
  updateState(error ? STATUS.ERROR : STATUS.STOPPED, error);
}

async function stopRadicleInternal() {
  try {
    await stopNode();
  } catch {
    // Reported through the status.
  }
  return getCurrentStatus();
}

function stopRadicle() {
  // A start still waiting for the home's gate gives up at once.
  for (const gateWait of gateWaits) gateWait.abort();
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
    log.warn(
      `[Radicle] Could not read seeding policies for ${redactForLog(fullRid)}:`,
      redactForLog(err.message)
    );
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
      log.warn(
        `[Radicle] Could not request clone cancellation for ${redactForLog(rid)}:`,
        redactForLog(err.message)
      );
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
      .catch((err) =>
        log.warn(
          `[Radicle] Final unseed failed for ${redactForLog(fullRid)}:`,
          redactForLog(err.message)
        )
      );
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
      log.warn('[Radicle] Could not read seeded repository count:', redactForLog(err.message));
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
    if (stopUnproved()) {
      return failure('RADICLE_NOT_STOPPED', UNPROVED_STOP_MESSAGE);
    }
    const restart = currentState === STATUS.RUNNING;
    if (restart) {
      await stopRadicleInternal();
      // A stop that wasn't proved: nothing is written or restarted.
      if (stopUnproved()) return failure('RADICLE_NOT_STOPPED', lastError || UNPROVED_STOP_MESSAGE);
    }
    const radHome = await prepareRadicleDataDir();
    const configPath = path.join(radHome, 'config.json');
    try {
      // With the node stopped, under the home's gate alone (freedom-core
      // design 0008, "Identity changes"): no other writer of the home, the
      // service among them, runs while the alias is rewritten.
      await withRadicleGate(radHome, (gate) => {
        let config = {};
        if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.node = config.node || {};
        config.node.alias = alias;
        if (gate.gated && !gate.held()) {
          throw new Error("The Radicle home's lock was lost; the alias was not written");
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      });
    } catch (err) {
      return failure('ALIAS_WRITE_FAILED', err.message);
    }
    if (restart) await startRadicleInternal();
    return success({ alias, restarted: restart });
  });
}

// PRIVATE MODE GUARD (R-9): seeding writes a lasting seeding policy and
// fetches the repository into storage, which a private window must not
// leave behind. isPrivateSender fails closed: a sender whose window can no
// longer be read counts as private. The page-facing provider applies the
// same check (radicle-provider-ipc.js).
const PRIVATE_SEED_FAILURE = () =>
  failure('RADICLE_PRIVATE_WINDOW', 'Seeding is not available in private windows');

/**
 * Run `work` with the node stopped (R-8): the wipe and key write of an
 * identity re-injection, which must never run under a live node.
 *
 * One lifecycle-queue operation, so every start, stop, alias change and
 * other re-key queues behind it. Inside it, once the earlier operations
 * have run:
 *  - it notes whether the node is running,
 *  - stops it and requires the add-on's proof that it stopped (a stop
 *    without that proof throws, and `work` never runs),
 *  - awaits `work`,
 *  - and in `finally` starts the node again if it was running: as the new
 *    identity, or as the old one when `work` failed before its key write.
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>} work's result
 */
function withRadicleStopped(work) {
  return enqueueLifecycle(async () => {
    const wasRunning = currentState === STATUS.RUNNING || embedded.isStarted();
    await stopNode();
    if (embedded.isStarted()) {
      throw new Error('The Radicle node did not stop, so its data was not reset');
    }
    try {
      return await work();
    } finally {
      if (wasRunning) {
        const restarted = await startRadicleInternal();
        if (restarted.status !== STATUS.RUNNING) {
          log.warn('[Radicle] Node did not restart after the re-key:', restarted.error);
        }
      }
    }
  });
}

/** The hook identity-manager's setRadicleLifecycle takes (R-8). */
function createRadicleLifecycle() {
  return { withStopped: withRadicleStopped };
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
    if (isPrivateSender(event)) return PRIVATE_SEED_FAILURE();
    if (isDisabledForProfile()) {
      return failure('RADICLE_DISABLED', 'Radicle is disabled for this profile');
    }
    if (!validateNonEmptyString(rid)) return failure('INVALID_RID', 'Missing repository ID');
    return seedRepository(rid, pushStatus(event));
  });
  ipcMain.handle(IPC.RADICLE_GET_CONNECTIONS, () => getConnections());
  ipcMain.handle(IPC.RADICLE_SYNC_REPO, (event, rid) =>
    isPrivateSender(event) ? PRIVATE_SEED_FAILURE() : refetchRepository(rid, pushStatus(event))
  );
  ipcMain.handle(IPC.RADICLE_GET_SEED_STATUS, (_event, rid) => getSeedFetchStatus(rid));
}

module.exports = {
  registerRadicleIpc,
  createRadicleLifecycle,
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
