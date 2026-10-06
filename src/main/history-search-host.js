// Main-process side of history search (#503): one lazily spawned worker
// (`history-search-worker.js`) runs the bounded history queries so the main
// thread only posts a message per address-bar keystroke / History page load.
//
// Every request settles. A worker error or exit fails its pending requests
// with `HistorySearchUnavailable`, and the caller (history.js) answers that
// one request on the main thread instead; the next request spawns a fresh
// worker. A worker that cannot load better-sqlite3 or open the database —
// it says so, or dies before it has answered anything — is not retried: the
// rest of the session queries on the main thread, as before this module. A
// request still unanswered after REQUEST_TIMEOUT_MS terminates the worker
// and fails with a timeout — not a fallback, since a query that slow would
// freeze the main thread just the same. That holds for every other request
// queued on the same worker too: they fail with the same timeout rather than
// falling back, since they would run against the same slow table on main.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const log = require('./logger');

const WORKER_PATH = path.join(__dirname, 'history-search-worker.js');
let workerPath = WORKER_PATH;
const REQUEST_TIMEOUT_MS = 10_000;
const RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
});

class HistorySearchUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistorySearchUnavailable';
  }
}

class HistorySearchTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistorySearchTimeout';
  }
}

let entry = null; // { worker, pending: Map<id, request>, answered, terminated }
let disabled = false;
let nextId = 1;
let requestTimeoutMs = REQUEST_TIMEOUT_MS;

function failAll(target, makeError) {
  for (const request of target.pending.values()) {
    clearTimeout(request.timer);
    request.reject(makeError());
  }
  target.pending.clear();
}

function retire(target, reason, makeError = () => new HistorySearchUnavailable(reason)) {
  if (target.terminated) return;
  target.terminated = true;
  if (entry === target) entry = null;
  if (!target.answered && !target.deliberate) {
    disabled = true;
    log.warn(`[HistorySearch] worker unavailable (${reason}); searching on the main thread`);
  }
  failAll(target, makeError);
  try {
    Promise.resolve(target.worker.terminate()).catch(() => {});
  } catch {
    // Already gone.
  }
}

function spawn(dbPath) {
  const target = {
    worker: null,
    pending: new Map(),
    answered: false,
    // Retired on purpose (timeout, stop), not because it could not run.
    deliberate: false,
    terminated: false,
  };
  target.worker = new Worker(workerPath, {
    workerData: { dbPath },
    execArgv: [],
    resourceLimits: RESOURCE_LIMITS,
  });
  target.worker.on('message', (message) => {
    if (message?.unavailable) {
      // It could not open the database: no use retrying it this session.
      retire(target, `worker cannot open the database: ${message.error}`);
      return;
    }
    const request = target.pending.get(message?.id);
    if (!request) return;
    target.pending.delete(message.id);
    clearTimeout(request.timer);
    target.answered = true;
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(`History search failed: ${message.error}`));
  });
  // Both stay attached through termination: a late worker error must not
  // become an unhandled main-process EventEmitter error.
  target.worker.on('error', (err) => retire(target, `worker error: ${err?.message || err}`));
  target.worker.on('exit', (code) => retire(target, `worker exited (${code})`));
  // An idle worker must not keep the process alive at quit.
  target.worker.unref?.();
  return target;
}

/**
 * Run a history-search op in the worker.
 * @param {string} dbPath - history.sqlite; the main connection must have
 *   created it (and its schema) already
 * @param {'autocomplete'|'page'} op
 * @param {object} payload - `{ query }` or `{ options }`
 * @returns {Promise<any>} rejects with HistorySearchUnavailable when the
 *   caller should answer on the main thread instead
 */
function runInWorker(dbPath, op, payload) {
  if (disabled) {
    return Promise.reject(new HistorySearchUnavailable('worker disabled'));
  }
  if (!entry || entry.terminated) {
    try {
      entry = spawn(dbPath);
    } catch (err) {
      disabled = true;
      log.warn(
        `[HistorySearch] worker failed to start (${err.message}); searching on the main thread`
      );
      return Promise.reject(new HistorySearchUnavailable(err.message));
    }
  }
  const target = entry;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timeoutMs = requestTimeoutMs;
    const timer = setTimeout(() => {
      if (!target.pending.has(id)) return;
      log.warn(`[HistorySearch] ${op} still running after ${timeoutMs} ms; terminating the worker`);
      target.pending.delete(id);
      reject(new HistorySearchTimeout(`history ${op} timed out after ${timeoutMs} ms`));
      target.deliberate = true;
      // Requests queued behind the slow one fail the same way, not with
      // HistorySearchUnavailable: a fallback would run them on main against
      // the table that just took this long.
      retire(
        target,
        'timed out',
        () => new HistorySearchTimeout(`history search abandoned: a ${op} timed out ahead of it`)
      );
    }, timeoutMs);
    target.pending.set(id, { resolve, reject, timer });
    try {
      target.worker.postMessage({ id, op, ...payload });
    } catch (err) {
      retire(target, `worker unreachable (${err.message})`);
    }
  });
}

/** Terminate the worker (database closing, app quitting). */
function stopWorker() {
  if (!entry) return;
  entry.deliberate = true;
  // Not HistorySearchUnavailable: answering on the main thread would reopen
  // the database that is being closed.
  retire(entry, 'stopped', () => new Error('History search stopped'));
}

function resetForTest({ timeoutMs = REQUEST_TIMEOUT_MS, path: testWorkerPath = WORKER_PATH } = {}) {
  stopWorker();
  entry = null;
  disabled = false;
  requestTimeoutMs = timeoutMs;
  workerPath = testWorkerPath;
}

module.exports = {
  runInWorker,
  stopWorker,
  HistorySearchUnavailable,
  HistorySearchTimeout,
  REQUEST_TIMEOUT_MS,
  resetForTest,
  WORKER_PATH,
};
