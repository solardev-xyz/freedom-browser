/**
 * Colibri's native backend (freedom-core design 0014, COL-5): the
 * freedom-colibrid processes behind colibri-worker-host.js's interface, so
 * colibri-resolver.js runs on either one by the development switch
 * (colibri-backend.js) and nothing above it changes (design 0014, What the
 * core sees). One `ColibridClient` (colibrid-client.js) runs each process;
 * this module decides which processes run, holds them to the browser-wide
 * bounds, restarts them, and builds what each request gets.
 *
 * - **The interface** is the WASM host's: `createClient({ chainId,
 *   proverUrl, zkProof, private })` → `{ request({ method, params },
 *   { deadlineMs }), destroy() }`, `ensureWorker(chainId, { private })`,
 *   `endPrivateSession()`, `ColibriWorkerError` (the host's class),
 *   `resetForTest` and `DEFAULT_DEADLINE_MS` (60 s); and `stopAll()` for
 *   the quit. `destroy` sends `colibri.forget` to each process the client
 *   used. `ensureWorker` gets or spawns the lane's process under the
 *   bounds and waits for its handshake.
 * - **Lanes:** two per chain, `<chain>` and `<chain>:private`, as the host
 *   has them. A normal lane's process is `serve --chain <id> --data-dir
 *   <userData>/colibri/<id> --lock-dir <locks>`; a private lane's is
 *   `serve --chain <id>`, its store in memory with no directory, and it
 *   ends with the private session. A private client from a session that
 *   has ended is refused (`Colibri private session ended`, a bystander)
 *   before anything is spawned.
 * - **A request** goes to its lane's process as `colibri.request` (the
 *   client's ID, its ZK, its prover, the method and the params) with what
 *   is left of its deadline, which runs from the first time a process is
 *   ready for it, as the host's does. The reply becomes the adapter's
 *   outcome (`replyOutcome`, colibri-outcome.js, which cuts it to 2,000
 *   units); main's own errors (ColibridClient's texts and this module's)
 *   are never cut. A reply that is none of the service's is a protocol
 *   error: the process is ended, and its death names nobody.
 * - **Bystanders** of a death (ColibridClient's `colibriBystander`) are sent
 *   once more to the lane's next process, with what is left of their
 *   deadline, waiting out the restart's back-off when their deadline
 *   allows it; not a request already sent again, whose client was
 *   destroyed, or whose private session ended. A recycling refusal
 *   (`colibriRecycling`) marks its process recycling and sends the request
 *   to the successor, which counts as its one resend.
 * - **Bounds** (design 0014, How many): at most 3 processes live at once,
 *   browser-wide, private ones included. A recycling or retiring process
 *   counts until it exits. A lane with no process, at the limit, retires
 *   the least recently used idle one (ready, nothing open) and spawns its
 *   own once that one has exited; with none idle, the request fails at once
 *   with `Colibri service busy`, and so does `ensureWorker`. A recycle's
 *   successor is spawned at once if the limit has room, retiring an idle
 *   process if it must, otherwise once the recycling process exits;
 *   meanwhile the chain's new requests get `Colibri service busy`. A
 *   process with nothing open for 10 minutes is sent `colibri.shutdown`
 *   and exits 0, which is no fault and starts no back-off.
 * - **Directories:** at most 6 chain directories in `<userData>/colibri/`.
 *   Each spawn sets its directory's modification time; before one that
 *   would make a seventh, the oldest directory whose chain has no process
 *   here is deleted (a cache: that chain bootstraps again). Only
 *   directories named by a chain ID count, so the WASM path's flat files
 *   there are left alone. Before each persistent spawn main checks the
 *   grant (service-grant.js, `colibriGrantRefusal`; design 0010, step 7):
 *   a refusal, or a directory that can't be made, spawns nothing and stops
 *   the lane.
 * - **Restarts,** per lane and lazy (design 0014, Crashes): after an
 *   abnormal exit the next spawn waits 0.5 s, then 2 s, then 10 s, reset
 *   after 60 s without one, and requests meanwhile get `Colibri service
 *   unavailable` at once. Abnormal is every exit main didn't ask for but
 *   exit 0 (a recycle, or the service's own clean end), and every kill
 *   main made of a process it no longer trusted. Three exits within 60 s
 *   that name no culprit (ColibridClient's `lastDeath`) stop the lane; so
 *   do exits 64, 74, 75 and 77, and a protocol mismatch. A stopped lane
 *   stays so until a client of another configuration (prover or ZK) is
 *   created for it, or the next launch. Exit 75 (the store's lock held)
 *   after a recycle waits for the recycling process's exit and tries once
 *   more. Three abnormal exits in a row with no reply to a request between
 *   them clear the chain's directory, once no process of the lane lives.
 * - **The private session's end** (`endPrivateSession`): every private
 *   process is sent `colibri.shutdown`; what is still open on one fails as
 *   a bystander (`Colibri worker replaced: private session ended`) once it
 *   has exited, and is never sent again; a private process still waiting
 *   for its slot is never spawned.
 * - **Logs:** every crash, kill, recycle, retirement and stop at warn, with
 *   the chain and the reason, never a request's params.
 * - **The quit** (`stopAll`): every process is stopped (killed 5 s after
 *   `colibri.shutdown` at most), and nothing spawns after it.
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { ColibridClient, COLIBRID_TEXTS, DEFAULT_DEADLINE_MS } = require('./colibrid-client');
const { DEATH_REASONS } = require('./colibri-markers');
const { replyOutcome } = require('./colibri-outcome');
const { ColibriWorkerError } = require('./colibri-worker-host');
const { PINNED_COLIBRID_VERSION } = require('./colibrid-pin');

/** Persistent and private processes live at once, browser-wide. */
const MAX_PROCESSES = 3;
/** Chain directories kept under `<userData>/colibri/`. */
const MAX_DIRECTORIES = 6;
/** How long a process may have nothing open before it is retired. */
const IDLE_MS = 10 * 60_000;
/** The lazy back-off after abnormal exits (0007's). */
const RESTART_DELAYS_MS = Object.freeze([500, 2_000, 10_000]);
/** A minute without an abnormal exit resets the back-off. */
const CRASH_RESET_MS = 60_000;
/** Exits naming no culprit within this window that stop a lane. */
const NO_CULPRIT_WINDOW_MS = 60_000;
const NO_CULPRIT_STOP = 3;
/** Abnormal exits in a row, with no reply between them, that clear a
 * chain's directory. */
const CLEAR_AFTER = 3;
/** Exits after which a lane is never restarted (usage, storage, the lock
 * held, confinement refused). */
const STOP_EXIT_CODES = new Set([64, 74, 75, 77]);
const LOCK_HELD = 75;
/** A chain directory's name: a chain ID. */
const CHAIN_DIR = /^[1-9][0-9]{0,15}$/;
const SESSION_END = 'private session ended';

/** This module's texts, besides ColibridClient's (`COLIBRID_TEXTS`). */
const SERVICE_TEXTS = Object.freeze({
  sessionEnded: 'Colibri private session ended',
  sessionStopped: `${COLIBRID_TEXTS.replaced}: ${SESSION_END}`,
  destroyed: 'Colibri client was destroyed',
  protocol: `${COLIBRID_TEXTS.replaced}: ${DEATH_REASONS.protocol}`,
});

function electronApp() {
  try {
    return require('electron').app;
  } catch {
    return undefined;
  }
}

/**
 * The release `colibri.hello` must report: the pin's in a packaged build;
 * in development any for a binary of the developer's own
 * (`FREEDOM_COLIBRID_PATH`), the tag's for another release
 * (`FREEDOM_COLIBRID_RELEASE_TAG`), else the pin's.
 */
function expectedColibridVersion({
  packaged = Boolean(electronApp()?.isPackaged),
  env = process.env,
} = {}) {
  if (packaged) return PINNED_COLIBRID_VERSION;
  if (env.FREEDOM_COLIBRID_PATH) return null;
  const tag = env.FREEDOM_COLIBRID_RELEASE_TAG;
  if (!tag) return PINNED_COLIBRID_VERSION;
  return tag.startsWith('colibrid-v') ? tag.slice('colibrid-v'.length) : null;
}

/** What this module runs with; `resetForTest` replaces any of it. */
function defaultOptions() {
  return {
    // `<userData>/colibri`, the chain directories' parent.
    storageDir: null,
    spawn: childProcess.spawn,
    // The binary (colibrid-binary.js) and the release its hello must name.
    command: null,
    serviceVersion: undefined,
    lockDir: null,
    // (dataDir, chainId) => null, or why the grant is refused.
    checkGrant: null,
    parentPid: process.pid,
    shellVersion: null,
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    // ColibridClient's fetch pool and transport: the browser's by default.
    fetchPool: undefined,
    hop: undefined,
  };
}

let options = defaultOptions();
// Lanes by key: their process, back-off and stop.
const lanes = new Map();
// Every process not yet exited, those waiting for a slot included.
const procs = new Set();
// Counts private sessions: a private client belongs to the one it was
// created in, and is refused once that session has ended.
let privateSession = 0;
let nextClientId = 1;
// Set by the quit: nothing spawns any more.
let stopping = false;

const now = () => options.now();

function later(fn, ms) {
  const timer = options.setTimer(fn, ms);
  timer?.unref?.();
  return timer;
}

function cancel(timer) {
  if (timer) options.clearTimer(timer);
}

const delay = (ms) => new Promise((resolve) => later(resolve, ms));

function storageRoot() {
  return options.storageDir ?? path.join(electronApp().getPath('userData'), 'colibri');
}

function lockDir() {
  return options.lockDir ?? require('../service-locks').getLockDir();
}

function command() {
  return options.command ?? require('./colibrid-binary').getColibridBinaryPath();
}

function serviceVersion() {
  return options.serviceVersion === undefined ? expectedColibridVersion() : options.serviceVersion;
}

function shellVersion() {
  return options.shellVersion ?? electronApp()?.getVersion?.() ?? 'unknown';
}

function checkGrant(dataDir, chainId) {
  if (options.checkGrant) return options.checkGrant(dataDir, chainId);
  return require('../service-grant').colibriGrantRefusal(dataDir, { chainId });
}

function colibriError(message, marks = {}) {
  return Object.assign(new ColibriWorkerError(message), marks);
}

const busy = () => colibriError(COLIBRID_TEXTS.busy);
const unavailable = () => colibriError(COLIBRID_TEXTS.unavailable);
const sessionEnded = () => colibriError(SERVICE_TEXTS.sessionEnded, { colibriBystander: true });

function laneKey(chainId, privateLane) {
  return privateLane ? `${chainId}:private` : String(chainId);
}

function laneName(lane) {
  return lane.privateLane ? `chain ${lane.chainId} (private)` : `chain ${lane.chainId}`;
}

function openText(open) {
  return open > 0 ? `; ${open} request(s) open` : '';
}

function laneFor(chainId, privateLane) {
  const key = laneKey(chainId, privateLane);
  let lane = lanes.get(key);
  if (!lane) {
    lane = {
      key,
      chainId,
      privateLane,
      // The process new requests go to: pending (waiting for a slot),
      // starting or ready; never one recycling or retiring.
      current: null,
      crashes: 0,
      lastCrashAt: null,
      backoffUntil: 0,
      noCulprit: [],
      // Abnormal exits since the last reply, toward the directory clear.
      streak: 0,
      clearPending: false,
      stopped: null,
      stoppedConfig: null,
      // The configuration (`<prover>|<zk>`) of the last client created.
      config: null,
      // A recycle since the last process was ready, and whether exit 75
      // after it was tried again.
      recycled: false,
      lockRetried: false,
    };
    lanes.set(key, lane);
  }
  return lane;
}

// ---- processes ----

function makeProc(lane) {
  const proc = {
    lane,
    session: privateSession,
    // pending → starting → ready → (recycling | retiring) → exited
    state: 'pending',
    client: null,
    // The process that takes this one's slot when it exits, and the one
    // whose slot this one waits for.
    heir: null,
    heirOf: null,
    open: 0,
    lastUsed: now(),
    idleTimer: null,
    // Main asked it to go: retired, the private session's end, the quit.
    stopping: false,
    sessionEnded: false,
    readySettled: false,
  };
  proc.ready = new Promise((resolve, reject) => {
    proc.resolveReady = resolve;
    proc.rejectReady = reject;
  });
  // Waiters that never come (an ensureWorker nobody awaits) leave no
  // unhandled rejection.
  proc.ready.catch(() => {});
  proc.exited = new Promise((resolve) => {
    proc.resolveExited = resolve;
  });
  procs.add(proc);
  return proc;
}

/** Settles `proc.ready` once: with a process, or a promise of one (a
 * retry's, whose outcome its waiters adopt). */
function settleReady(proc, value) {
  if (proc.readySettled) return;
  proc.readySettled = true;
  proc.resolveReady(value);
}

function failReady(proc, err) {
  if (proc.readySettled) return;
  proc.readySettled = true;
  proc.rejectReady(err);
}

function holdsSlot(proc) {
  return proc.state !== 'pending' && proc.state !== 'exited';
}

function liveCount() {
  let count = 0;
  for (const proc of procs) if (holdsSlot(proc)) count += 1;
  return count;
}

/** The least recently used process with nothing open, or null. */
function idleVictim() {
  let victim = null;
  for (const proc of procs) {
    if (proc.state !== 'ready' || proc.open > 0) continue;
    if (!victim || proc.lastUsed < victim.lastUsed) victim = proc;
  }
  return victim;
}

/**
 * A new process for `lane` under the bound: spawned now if there is room;
 * else waiting for the slot of the least recently used idle process, which
 * is retired; else, for a recycle's successor, for the slot of `after`.
 * Otherwise `Colibri service busy`.
 */
function placeProc(lane, { after = null } = {}) {
  if (liveCount() < MAX_PROCESSES) {
    const proc = makeProc(lane);
    spawnProc(proc);
    return proc;
  }
  const victim = idleVictim();
  const holder = victim ?? after;
  if (!holder) throw busy();
  const proc = makeProc(lane);
  proc.heirOf = holder;
  holder.heir = proc;
  if (victim) retire(victim, 'browser-wide limit');
  return proc;
}

function spawnProc(proc) {
  const { lane } = proc;
  proc.state = 'starting';
  proc.lastUsed = now();
  const persistent = !lane.privateLane;
  let client;
  try {
    const dataDir = persistent ? path.join(storageRoot(), String(lane.chainId)) : undefined;
    client = new ColibridClient({
      kind: persistent ? 'persistent' : 'private',
      chain: lane.chainId,
      dataDir,
      lockDir: persistent ? lockDir() : undefined,
      parentPid: options.parentPid,
      command: command(),
      serviceVersion: serviceVersion(),
      spawn: options.spawn,
      shellVersion: shellVersion(),
      now: options.now,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      fetchPool: options.fetchPool,
      hop: options.hop,
      // Main's check before each spawn (design 0010, step 7), and the
      // directory's bound and modification time.
      beforeSpawn: persistent ? () => prepareDirectory(proc, dataDir) : null,
    });
  } catch (err) {
    log.warn(`[colibri] ${laneName(lane)} service not configured`, {
      code: err?.code || err?.name || 'error',
    });
    stopLane(lane, 'not configured');
    gone(proc);
    failReady(proc, unavailable());
    passSlot(proc);
    return;
  }
  proc.client = client;
  client.on('exit', (exit) => onExit(proc, exit));
  client.on('failed', (reason) => onFailed(proc, reason));
  client.start().then(
    () => onReady(proc),
    () => failReady(proc, unavailable())
  );
}

function onReady(proc) {
  if (proc.state !== 'starting') return;
  proc.state = 'ready';
  proc.lastUsed = now();
  proc.lane.recycled = false;
  proc.lane.lockRetried = false;
  armIdle(proc);
  settleReady(proc, proc);
}

/** `proc` takes the lane's new requests, unless it has already ended
 * (a spawn that failed at once, or a refused grant). */
function setCurrent(lane, proc) {
  if (proc.state !== 'exited') lane.current = proc;
}

/** The process is gone, or will never run: it holds no slot and takes no
 * request. Its heir is passed the slot by the caller. */
function gone(proc) {
  proc.state = 'exited';
  procs.delete(proc);
  cancel(proc.idleTimer);
  proc.idleTimer = null;
  if (proc.lane.current === proc) proc.lane.current = null;
  if (proc.heirOf) {
    if (proc.heirOf.heir === proc) proc.heirOf.heir = null;
    proc.heirOf = null;
  }
  proc.resolveExited();
}

/** `proc`'s slot goes to its heir, which is spawned, unless what it was
 * waiting for has gone meanwhile. */
function passSlot(proc) {
  const heir = proc.heir;
  proc.heir = null;
  if (!heir || heir.state !== 'pending') return;
  heir.heirOf = null;
  const { lane } = heir;
  if (lane.privateLane && heir.session !== privateSession) {
    gone(heir);
    failReady(heir, sessionEnded());
  } else if (stopping || lane.stopped) {
    gone(heir);
    failReady(heir, unavailable());
  } else {
    spawnProc(heir);
  }
}

function onExit(proc, exit) {
  if (proc.state === 'exited') return;
  const { lane } = proc;
  const wasRecycling = proc.state === 'recycling';
  const { open } = proc;
  const death = proc.client?.lastDeath ?? null;
  gone(proc);
  if (proc.stopping) {
    // Main asked it to go: logged when it did.
  } else if (exit.code === 0) {
    log.warn(
      `[colibri] ${laneName(lane)} service ${wasRecycling ? 'recycled' : 'exited (0)'}` +
        openText(open)
    );
  } else if (exit.cause === 'mismatch') {
    stopLane(lane, 'protocol mismatch');
  } else if (exit.code !== null && STOP_EXIT_CODES.has(exit.code)) {
    if (exit.code === LOCK_HELD && lane.recycled && !lane.lockRetried) lockRetry(proc);
    else stopLane(lane, `exit ${exit.code}`);
  } else {
    crashed(lane, death, open);
  }
  failReady(proc, unavailable());
  passSlot(proc);
  clearIfDue(lane);
}

/** The client gave up without an exit: the check before the spawn refused
 * it, so no process ran. */
function onFailed(proc, reason) {
  if (proc.state === 'exited') return;
  const { lane } = proc;
  if (!proc.stopping) {
    log.warn(`[colibri] ${laneName(lane)} service not started (${reason})`);
    stopLane(lane, reason);
  }
  gone(proc);
  failReady(proc, unavailable());
  passSlot(proc);
}

/** An abnormal exit: the back-off, the no-culprit stop and the directory
 * clear's count. */
function crashed(lane, death, open) {
  const at = now();
  if (lane.lastCrashAt === null || at - lane.lastCrashAt >= CRASH_RESET_MS) lane.crashes = 0;
  lane.crashes += 1;
  lane.lastCrashAt = at;
  const wait = RESTART_DELAYS_MS[Math.min(lane.crashes, RESTART_DELAYS_MS.length) - 1];
  lane.backoffUntil = at + wait;
  if (!lane.privateLane) {
    lane.streak += 1;
    if (lane.streak >= CLEAR_AFTER) {
      lane.streak = 0;
      lane.clearPending = true;
    }
  }
  const cause = death?.cause ?? null;
  let how = 'killed';
  if (cause === null || cause === 'transport') how = 'crashed';
  else if (cause === 'spawn') how = 'failed to spawn';
  const named = death?.culprit != null;
  log.warn(
    `[colibri] ${laneName(lane)} service ${how} (${death?.reason ?? 'service exited'}); ` +
      `${named ? 'the request in its step is named' : 'no request named'}` +
      openText(open) +
      `; next start after ${wait} ms`
  );
  if (named) return;
  lane.noCulprit = lane.noCulprit.filter((t) => at - t < NO_CULPRIT_WINDOW_MS);
  lane.noCulprit.push(at);
  if (lane.noCulprit.length >= NO_CULPRIT_STOP) {
    stopLane(lane, 'three exits within a minute named no culprit');
  }
}

/** Exit 75 after a recycle: the recycling process still holds the store's
 * lock. Its successor waits for it to exit and tries once more; whoever
 * waited for the one that failed waits for that one. */
function lockRetry(failed) {
  const { lane } = failed;
  lane.lockRetried = true;
  let predecessor = null;
  for (const proc of procs) {
    if (proc.lane === lane && proc.state === 'recycling') predecessor = proc;
  }
  log.warn(
    `[colibri] ${laneName(lane)} store still locked (exit 75); trying once more` +
      (predecessor ? ' when the recycling process has exited' : '')
  );
  let successor;
  if (predecessor && !predecessor.heir) {
    successor = makeProc(lane);
    successor.heirOf = predecessor;
    predecessor.heir = successor;
  } else {
    try {
      successor = placeProc(lane);
    } catch (err) {
      failReady(failed, err);
      return;
    }
  }
  setCurrent(lane, successor);
  settleReady(failed, successor.ready);
}

function stopLane(lane, reason) {
  if (lane.stopped) return;
  lane.stopped = reason;
  lane.stoppedConfig = lane.config;
  log.warn(
    `[colibri] ${laneName(lane)} stopped (${reason}) until its configuration changes or the next launch`
  );
  const pending = lane.current;
  if (pending?.state === 'pending') {
    gone(pending);
    failReady(pending, unavailable());
  }
}

/** A client of another configuration than the stopped lane's lets it
 * start again. */
function noteConfig(lane, config) {
  if (lane.stopped && lane.stoppedConfig !== config) {
    log.info(`[colibri] ${laneName(lane)} may start again: its configuration changed`);
    lane.stopped = null;
    lane.stoppedConfig = null;
    lane.crashes = 0;
    lane.lastCrashAt = null;
    lane.backoffUntil = 0;
    lane.noCulprit = [];
    lane.lockRetried = false;
  }
  lane.config = config;
}

/**
 * Main asks `proc` to go (`reason`: idle, the limit, the private session's
 * end, the quit): `colibri.shutdown`, killed 5 s later if it hasn't
 * exited. One still waiting for a slot is dropped.
 */
function retire(proc, reason) {
  if (proc.stopping || proc.state === 'exited') return;
  proc.stopping = true;
  const { lane } = proc;
  if (lane.current === proc) lane.current = null;
  cancel(proc.idleTimer);
  proc.idleTimer = null;
  const ended = reason === SESSION_END ? sessionEnded() : unavailable();
  if (proc.state === 'pending') {
    gone(proc);
    failReady(proc, ended);
    return;
  }
  log.warn(`[colibri] ${laneName(lane)} service retired (${reason})` + openText(proc.open));
  failReady(proc, ended);
  proc.state = 'retiring';
  proc.client.stop().then(() => {
    // A client that had no process to stop emits no exit.
    if (proc.state === 'exited') return;
    gone(proc);
    passSlot(proc);
  });
}

function armIdle(proc) {
  cancel(proc.idleTimer);
  proc.idleTimer = null;
  if (proc.state !== 'ready' || proc.open > 0) return;
  proc.idleTimer = later(() => {
    proc.idleTimer = null;
    if (proc.state === 'ready' && proc.open === 0) retire(proc, 'idle for 10 minutes');
  }, IDLE_MS);
}

/** Over its memory budget, `proc` refuses new requests and exits once its
 * open ones are done: its successor takes the lane (see the header). */
function recycled(proc) {
  if (proc.state !== 'ready') return;
  const { lane } = proc;
  proc.state = 'recycling';
  cancel(proc.idleTimer);
  proc.idleTimer = null;
  lane.recycled = true;
  lane.lockRetried = false;
  log.warn(`[colibri] ${laneName(lane)} service recycling; its successor takes new requests`);
  if (lane.current !== proc) return;
  lane.current = null;
  if (stopping || lane.stopped) return;
  setCurrent(lane, placeProc(lane, { after: proc }));
}

// ---- directories ----

/** Before a persistent spawn: the grant checked, a due clear done, the
 * directory bound kept, and the directory made with its modification time
 * set. Null, or why nothing may be spawned. */
function prepareDirectory(proc, dataDir) {
  const { lane } = proc;
  let refused;
  try {
    refused = checkGrant(dataDir, lane.chainId) ?? null;
  } catch (err) {
    refused = `the check failed: ${err?.code || err?.name || 'error'}`;
  }
  if (refused) {
    log.error(`[colibri] ${laneName(lane)} store directory refused`, { reason: refused });
    return refused;
  }
  clearIfDue(lane, proc);
  pruneDirectories(lane.chainId);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const at = new Date(now());
  fs.utimesSync(dataDir, at, at);
  return null;
}

/** Clears the lane's directory when three abnormal exits in a row made it
 * due, once no process of the lane but `except` lives. */
function clearIfDue(lane, except = null) {
  if (!lane.clearPending || lane.privateLane) return;
  for (const proc of procs) {
    if (proc !== except && proc.lane === lane && holdsSlot(proc)) return;
  }
  lane.clearPending = false;
  try {
    fs.rmSync(path.join(storageRoot(), String(lane.chainId)), { recursive: true, force: true });
    log.warn(
      `[colibri] ${laneName(lane)} store cleared after ${CLEAR_AFTER} abnormal exits in a row`
    );
  } catch (err) {
    lane.clearPending = true;
    log.warn(`[colibri] ${laneName(lane)} store could not be cleared`, {
      code: err?.code || 'error',
    });
  }
}

function mtimeOf(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/** Before `chainId`'s directory is made: while there are 6 or more, the
 * oldest one whose chain has no process here is deleted. */
function pruneDirectories(chainId) {
  const root = storageRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  const own = String(chainId);
  const dirs = entries
    .filter((entry) => entry.isDirectory() && CHAIN_DIR.test(entry.name))
    .map((entry) => entry.name);
  if (dirs.includes(own)) return;
  const live = new Set([own]);
  for (const proc of procs) if (!proc.lane.privateLane) live.add(String(proc.lane.chainId));
  const candidates = dirs
    .filter((name) => !live.has(name))
    .map((name) => ({ name, mtime: mtimeOf(path.join(root, name)) }))
    .sort((a, b) => a.mtime - b.mtime || Number(a.name) - Number(b.name));
  let count = dirs.length;
  while (count >= MAX_DIRECTORIES && candidates.length > 0) {
    const { name } = candidates.shift();
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    count -= 1;
    log.warn(`[colibri] chain ${name} store removed: at most ${MAX_DIRECTORIES} are kept`);
  }
}

// ---- requests ----

function sessionLive(client) {
  return !client.privateLane || client.privateSession === privateSession;
}

function assertUsable(client) {
  if (!sessionLive(client)) throw sessionEnded();
  if (client.destroyed) throw colibriError(SERVICE_TEXTS.destroyed);
}

/** The lane's process ready for `request` (or for `ensureWorker`, with
 * none), spawned under the bounds if it has none. */
async function acquire(lane, request = null) {
  for (;;) {
    // Again after a wait: a session that ended meanwhile spawns nothing.
    if (request) assertUsable(request.client);
    if (stopping || lane.stopped) throw unavailable();
    let proc = lane.current;
    if (proc?.state === 'exited') {
      lane.current = null;
      proc = null;
    }
    if (!proc) {
      const wait = lane.backoffUntil - now();
      if (wait > 0) {
        // The back-off: a request sent again waits for the next process,
        // within its deadline; anything else is refused at once.
        if (!request?.resent) throw unavailable();
        if (request.deadlineAt - now() <= wait) throw request.lastError;
        await delay(wait);
        continue;
      }
      proc = placeProc(lane);
      setCurrent(lane, proc);
    } else if (
      proc.state === 'pending' &&
      proc.heirOf?.lane === lane &&
      proc.heirOf.state === 'recycling' &&
      !request?.redirected
    ) {
      // A recycle's successor waiting for its predecessor's slot.
      throw busy();
    }
    if (proc.state === 'ready') return proc;
    return waitFor(proc, request);
  }
}

/** `proc` ready, bounded by the request's deadline once it has one. */
function waitFor(proc, request) {
  const until = request?.deadlineAt ?? null;
  if (until === null) return proc.ready;
  return new Promise((resolve, reject) => {
    const timer = later(() => reject(request.lastError ?? busy()), Math.max(0, until - now()));
    proc.ready.then(
      (ready) => {
        cancel(timer);
        resolve(ready);
      },
      (err) => {
        cancel(timer);
        reject(err);
      }
    );
  });
}

function canResend(request) {
  const { client } = request;
  return (
    !request.resent &&
    !client.destroyed &&
    !stopping &&
    sessionLive(client) &&
    request.deadlineAt - now() > 0
  );
}

/** Sends `request` to its lane's process, spawning one if needed; again
 * for a resend. Its promise settles once, with the outcome. */
async function dispatch(request) {
  const { client } = request;
  for (let attempt = 0; ; attempt += 1) {
    assertUsable(client);
    const lane = laneFor(client.chainId, client.privateLane);
    let proc;
    try {
      proc = await acquire(lane, request);
    } catch (err) {
      assertUsable(client);
      throw err;
    }
    assertUsable(client);
    // Retired or recycling between its readiness and now: the lane's
    // next one, a few times at most.
    if (proc.state !== 'ready') {
      if (attempt < 2) continue;
      throw busy();
    }
    if (request.deadlineAt === null) request.deadlineAt = now() + request.deadlineMs;
    const remaining = request.deadlineAt - now();
    if (remaining <= 0) throw request.lastError ?? busy();
    return run(proc, request, remaining);
  }
}

async function run(proc, request, remaining) {
  const { client } = request;
  proc.open += 1;
  proc.lastUsed = now();
  cancel(proc.idleTimer);
  proc.idleTimer = null;
  for (const used of client.procs) if (used.state === 'exited') client.procs.delete(used);
  client.procs.add(proc);
  let reply;
  try {
    reply = await proc.client.request(
      {
        client: String(client.id),
        zk: client.config.zkProof,
        prover: client.config.proverUrl,
        method: request.method,
        params: request.params,
      },
      { deadlineMs: remaining }
    );
  } catch (err) {
    closed(proc);
    return afterFailure(proc, request, err);
  }
  closed(proc);
  const outcome = replyOutcome(reply, request);
  if (!outcome) {
    // No reply of the service's: a protocol error, which names nobody.
    proc.client.abandon('protocol');
    throw colibriError(SERVICE_TEXTS.protocol, { colibriBystander: true });
  }
  proc.lane.streak = 0;
  if (outcome.ok) return outcome.result;
  throw outcome.error;
}

function closed(proc) {
  proc.open -= 1;
  proc.lastUsed = now();
  if (proc.open === 0) armIdle(proc);
}

function afterFailure(proc, request, err) {
  if (!(err instanceof ColibriWorkerError)) throw err;
  if (proc.sessionEnded) {
    throw colibriError(SERVICE_TEXTS.sessionStopped, { colibriBystander: true });
  }
  if (err.colibriRecycling) {
    recycled(proc);
    if (!canResend(request)) throw busy();
    request.resent = true;
    request.redirected = true;
    request.lastError = busy();
    return dispatch(request);
  }
  if (err.colibriBystander && canResend(request)) {
    request.resent = true;
    request.lastError = err;
    return dispatch(request);
  }
  throw err;
}

function sendRequest(client, method, params, deadlineMs) {
  const request = {
    client,
    method,
    params,
    deadlineMs: Math.max(1, Number(deadlineMs) || DEFAULT_DEADLINE_MS),
    deadlineAt: null,
    resent: false,
    redirected: false,
    lastError: null,
  };
  return dispatch(request);
}

// ---- the interface ----

/**
 * A Colibri client on its chain's process, or with `private: true` on the
 * chain's private one. `request` is EIP-1193, plus an optional
 * `{ deadlineMs }` the caller will wait at most.
 */
function createClient({ chainId, proverUrl, zkProof, private: privateLane = false }) {
  const client = {
    id: nextClientId++,
    chainId: Number(chainId),
    privateLane: privateLane === true,
    privateSession,
    config: { chainId: Number(chainId), proverUrl, zkProof: zkProof !== false },
    destroyed: false,
    procs: new Set(),
  };
  noteConfig(laneFor(client.chainId, client.privateLane), `${proverUrl}|${client.config.zkProof}`);
  return {
    request({ method, params } = {}, { deadlineMs } = {}) {
      return sendRequest(client, method, params ?? [], deadlineMs);
    },
    destroy() {
      if (client.destroyed) return;
      client.destroyed = true;
      for (const proc of client.procs) {
        if (proc.state === 'exited' || !proc.client) continue;
        proc.client.forget(String(client.id)).catch(() => {});
      }
      client.procs.clear();
    },
  };
}

/** Resolves once the chain's process (its private one with `private:
 * true`) has completed its handshake; spawns it under the bounds. */
function ensureWorker(chainId, { private: privateLane = false } = {}) {
  return acquire(laneFor(Number(chainId), privateLane === true)).then(() => undefined);
}

/** The last private window has closed: every private process goes, with
 * its memory store, and the private clients created so far are refused
 * from now on. Normal processes are untouched. */
function endPrivateSession() {
  privateSession += 1;
  for (const proc of [...procs]) {
    if (!proc.lane.privateLane) continue;
    proc.sessionEnded = true;
    retire(proc, SESSION_END);
  }
}

function retireAll(reason) {
  const exits = [];
  for (const proc of [...procs]) {
    if (proc.state !== 'pending') exits.push(proc.exited);
    retire(proc, reason);
  }
  return Promise.all(exits).then(() => undefined);
}

/** The quit: every process stops; resolves once each has exited. */
function stopAll() {
  stopping = true;
  return retireAll('quit');
}

/** Stops every process and starts afresh with `overrides` (see
 * `defaultOptions`); resolves once the old processes have exited. */
function resetForTest(overrides = {}) {
  stopping = true;
  // An old process's late exit clears no directory of the next test's.
  for (const lane of lanes.values()) lane.clearPending = false;
  const exited = retireAll('test reset');
  procs.clear();
  lanes.clear();
  options = { ...defaultOptions(), ...overrides };
  stopping = false;
  return exited;
}

module.exports = {
  createClient,
  ensureWorker,
  endPrivateSession,
  stopAll,
  ColibriWorkerError,
  resetForTest,
  expectedColibridVersion,
  DEFAULT_DEADLINE_MS,
  MAX_PROCESSES,
  MAX_DIRECTORIES,
  IDLE_MS,
  RESTART_DELAYS_MS,
  SERVICE_TEXTS,
};
