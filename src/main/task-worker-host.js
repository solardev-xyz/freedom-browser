// A small request/response host for one lazily spawned `worker_threads`
// worker (#503 items 9 and 12). Used by the web3:// document decoder
// (`onchain/onchain-html-worker.js`) and the chainlist catalog
// (`networks/chain-catalog-worker.js`), so CPU-heavy work on a multi-MB input
// never runs on Electron's main thread, where it freezes every window.
//
// Protocol: main posts `{ id, op, ...payload }`; the worker answers
// `{ id, ok: true, result }` or `{ id, ok: false, error, code }`, and may post
// `{ type: 'log', level, message }` at any time (the worker has no access to
// the main process's log file).
//
// Requests wait in a FIFO here, in the main process, and the worker is handed
// one at a time. So `timeoutMs` measures the worker's time on *that* request,
// not its wait behind others (a queue of slow-but-healthy requests never
// times out), and a request that is aborted or times out costs nothing to the
// ones still waiting: they go to the next worker.
//
// Every request settles:
//   - A worker that cannot start, or dies before it has answered anything, is
//     not retried: its request and every request (then and later) reject with
//     `TaskWorkerUnavailable`, and the caller does the work on the main thread
//     as it did before the worker existed.
//   - A worker that errors/exits after it has answered fails the one request
//     it was working on with `TaskWorkerUnavailable` too (same main-thread
//     fallback, for that request only); waiting requests go to a fresh worker.
//   - A request the worker has worked on for `timeoutMs` without an answer
//     terminates the worker and fails with `TaskWorkerTimeout` — not a
//     fallback, since work that slow would freeze the main thread just the
//     same. Waiting requests go to a fresh worker.
//   - A request whose `signal` aborts rejects with an `AbortError` at once:
//     still waiting, it is dropped; already in the worker, the worker is
//     terminated so it stops spending time on an answer nobody wants.
//   - A failure the worker reports (`ok: false`) rejects with an Error carrying
//     the worker's message and `code`.
const { Worker } = require('node:worker_threads');
const log = require('./logger');

class TaskWorkerUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskWorkerUnavailable';
  }
}

class TaskWorkerTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskWorkerTimeout';
  }
}

const LOG_LEVELS = new Set(['info', 'warn', 'error']);

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * @param {object} options
 * @param {string} options.name - log prefix, e.g. 'OnchainHtml'
 * @param {string} options.workerPath
 * @param {() => any} [options.workerData] - evaluated at each spawn
 * @param {object} [options.resourceLimits]
 * @param {number} options.timeoutMs - per request, from when the worker gets it
 */
function createTaskWorkerHost({
  name,
  workerPath,
  workerData = () => undefined,
  resourceLimits,
  timeoutMs,
}) {
  // { worker, current: request|null, answered, deliberate, terminated }
  let entry = null;
  const queue = []; // requests not yet handed to a worker
  let disabled = false;
  let nextId = 1;
  let requestTimeoutMs = timeoutMs;
  let currentWorkerPath = workerPath;

  function settle(request, error, result) {
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    if (request.signal) request.signal.removeEventListener('abort', request.onAbort);
    if (error) request.reject(error);
    else request.resolve(result);
  }

  function failQueued(makeError) {
    for (const request of queue.splice(0)) settle(request, makeError());
  }

  function retire(target, reason, makeError = () => new TaskWorkerUnavailable(reason)) {
    if (target.terminated) return;
    target.terminated = true;
    if (entry === target) entry = null;
    const request = target.current;
    target.current = null;
    if (request) settle(request, makeError());
    if (!target.answered && !target.deliberate) {
      disabled = true;
      log.warn(`[${name}] worker unavailable (${reason}); running on the main thread`);
    }
    try {
      Promise.resolve(target.worker.terminate()).catch(() => {});
    } catch {
      // Already gone.
    }
    dispatch();
  }

  function spawn() {
    const target = {
      worker: null,
      current: null,
      answered: false,
      // Retired on purpose (timeout, abort, stop), not because it could not run.
      deliberate: false,
      terminated: false,
    };
    target.worker = new Worker(currentWorkerPath, {
      workerData: workerData(),
      execArgv: [],
      resourceLimits,
    });
    target.worker.on('message', (message) => {
      if (message?.type === 'log') {
        const level = LOG_LEVELS.has(message.level) ? message.level : 'info';
        log[level](`[${name}] ${String(message.message).slice(0, 1000)}`);
        return;
      }
      const request = target.current;
      if (!request || message?.id !== request.id) return;
      target.current = null;
      target.answered = true;
      if (message.ok) {
        settle(request, null, message.result);
      } else {
        const error = new Error(message.error || `${name} failed`);
        if (message.code) error.code = message.code;
        settle(request, error);
      }
      dispatch();
    });
    // Both stay attached through termination: a late worker error must not
    // become an unhandled main-process EventEmitter error.
    target.worker.on('error', (err) => retire(target, `worker error: ${err?.message || err}`));
    target.worker.on('exit', (code) => retire(target, `worker exited (${code})`));
    // An idle worker must not keep the process alive at quit.
    target.worker.unref?.();
    return target;
  }

  // Hand the next waiting request to the worker, if it is free.
  function dispatch() {
    if (entry?.current || queue.length === 0) return;
    if (disabled) {
      failQueued(() => new TaskWorkerUnavailable('worker disabled'));
      return;
    }
    if (!entry || entry.terminated) {
      try {
        entry = spawn();
      } catch (err) {
        disabled = true;
        log.warn(`[${name}] worker failed to start (${err.message}); running on the main thread`);
        failQueued(() => new TaskWorkerUnavailable(err.message));
        return;
      }
    }
    const target = entry;
    const request = queue.shift();
    target.current = request;
    const deadlineMs = requestTimeoutMs;
    request.timer = setTimeout(() => {
      if (target.current !== request) return;
      log.warn(
        `[${name}] ${request.op} still running after ${deadlineMs} ms; terminating the worker`
      );
      target.deliberate = true;
      retire(
        target,
        'timed out',
        () => new TaskWorkerTimeout(`${name} ${request.op} timed out after ${deadlineMs} ms`)
      );
    }, deadlineMs);
    try {
      target.worker.postMessage({ id: request.id, op: request.op, ...request.payload });
    } catch (err) {
      retire(target, `worker unreachable (${err.message})`);
    }
  }

  /**
   * @param {string} op
   * @param {object} [payload]
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] - drops the request (and stops the
   *   worker if it is already on it); rejects with an AbortError
   * @returns {Promise<any>} rejects with TaskWorkerUnavailable when the
   *   caller should do the work on the main thread instead
   */
  function run(op, payload = {}, { signal } = {}) {
    if (disabled) {
      return Promise.reject(new TaskWorkerUnavailable('worker disabled'));
    }
    if (signal?.aborted) {
      return Promise.reject(abortError(`${name} ${op} aborted`));
    }
    return new Promise((resolve, reject) => {
      const request = {
        id: nextId++,
        op,
        payload,
        resolve,
        reject,
        timer: null,
        settled: false,
        signal,
        onAbort: null,
      };
      if (signal) {
        request.onAbort = () => {
          const queued = queue.indexOf(request);
          if (queued !== -1) {
            queue.splice(queued, 1);
            settle(request, abortError(`${name} ${op} aborted`));
            return;
          }
          if (entry?.current === request) {
            entry.deliberate = true;
            retire(entry, 'aborted', () => abortError(`${name} ${op} aborted`));
          }
        };
        signal.addEventListener('abort', request.onAbort, { once: true });
      }
      queue.push(request);
      dispatch();
    });
  }

  /** Terminate the worker and drop waiting requests (app quitting, tests). */
  function stop() {
    failQueued(() => new Error(`${name} stopped`));
    if (!entry) return;
    entry.deliberate = true;
    retire(entry, 'stopped', () => new Error(`${name} stopped`));
  }

  function resetForTest({
    timeoutMs: testTimeoutMs = timeoutMs,
    path: testPath = workerPath,
  } = {}) {
    stop();
    entry = null;
    disabled = false;
    requestTimeoutMs = testTimeoutMs;
    currentWorkerPath = testPath;
  }

  return { run, stop, resetForTest };
}

module.exports = { createTaskWorkerHost, TaskWorkerUnavailable, TaskWorkerTimeout };
