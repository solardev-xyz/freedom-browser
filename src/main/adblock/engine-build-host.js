/**
 * Main-process side of the ad-block engine build (#512). FiltersEngine.parse
 * over the bundled lists takes hundreds of milliseconds of CPU; on the main
 * thread that froze every window and held every page load (each frame's
 * preload waits on main for its scriptlets) for as long as it ran — at
 * startup without a cache, after a list update and on every category toggle.
 *
 * Each build gets its own worker (`engine-build-worker.js`), which does the
 * reading, parsing and serializing and hands the serialized engine back with
 * its buffer transferred. Builds are rare and the worker exits right after,
 * so nothing idles in memory between them.
 *
 * A worker that cannot run — fails to start, crashes, exits without an answer
 * — is not a reason to stop blocking: that build runs on the main thread
 * instead, exactly as every build did before this module. A build that
 * *fails* (the parse threw) rejects either way, as before.
 *
 * A build that does not answer within BUILD_DEADLINE_MS is terminated and
 * rejects with EngineBuildTimeout. Nothing else would ever settle it — a
 * worker stuck in a parse loop fires no message, error or exit — and every
 * later rebuild (category toggle, allowlist change, list update) queues
 * behind it in service.js's refreshChain. It does *not* fall back to the main
 * thread: whatever wedged the worker would wedge the whole app there. The
 * previous engine keeps serving, and the next rebuild tries again.
 */

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const log = require('../logger');
// Called through the module object so tests can see the fallback run.
const engineBuild = require('./engine-build');

const WORKER_PATH = path.join(__dirname, 'engine-build-worker.js');
let workerPath = WORKER_PATH;

// A normal build takes well under a second (~460 ms median wall time in the
// worker, measured on #519 — the ~240 ms figure in #512 is main's old
// main-thread stall, not the worker's build time); this is generous enough
// for a slow machine under load and short enough that a wedged build
// releases the rebuild queue within the session.
const BUILD_DEADLINE_MS = 60_000;
let buildDeadlineMs = BUILD_DEADLINE_MS;

class EngineWorkerUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineWorkerUnavailable';
  }
}

class EngineBuildTimeout extends Error {
  constructor(ms) {
    super(`engine build did not finish within ${ms} ms; worker terminated`);
    this.name = 'EngineBuildTimeout';
  }
}

function buildInWorker(job) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    let deadline = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      try {
        Promise.resolve(worker?.terminate()).catch(() => {});
      } catch {
        // Already gone.
      }
      fn(value);
    };
    try {
      worker = new Worker(workerPath, { execArgv: [] });
    } catch (err) {
      reject(new EngineWorkerUnavailable(`worker failed to start: ${err.message}`));
      return;
    }
    worker.once('message', (message) => {
      if (message?.ok) {
        finish(resolve, { bytes: message.bytes || null, warnings: message.warnings || [] });
      } else {
        finish(reject, new Error(message?.error || 'engine build failed'));
      }
    });
    // Both stay attached through termination: a late worker error must not
    // become an unhandled main-process EventEmitter error.
    worker.on('error', (err) =>
      finish(reject, new EngineWorkerUnavailable(`worker error: ${err?.message || err}`))
    );
    worker.on('exit', (code) =>
      finish(reject, new EngineWorkerUnavailable(`worker exited (${code}) without a result`))
    );
    // A build still running at quit must not keep the process alive.
    worker.unref?.();
    deadline = setTimeout(
      () => finish(reject, new EngineBuildTimeout(buildDeadlineMs)),
      buildDeadlineMs
    );
    deadline.unref?.();
    try {
      worker.postMessage(job);
    } catch (err) {
      finish(reject, new EngineWorkerUnavailable(`worker unreachable: ${err.message}`));
    }
  });
}

/**
 * Build and serialize an engine for `job` (see engine-build.js), off the
 * main thread when possible.
 *
 * @returns {Promise<{bytes: Uint8Array|null, warnings: string[],
 *   inWorker: boolean}>}
 */
async function buildEngine(job) {
  try {
    return { ...(await buildInWorker(job)), inWorker: true };
  } catch (err) {
    if (!(err instanceof EngineWorkerUnavailable)) throw err;
    log.warn(`[adblock] engine worker unavailable (${err.message}); building on the main thread`);
  }
  return { ...(await engineBuild.buildSerializedEngine(job)), inWorker: false };
}

function _setWorkerPathForTests(testPath = WORKER_PATH) {
  workerPath = testPath;
}

function _setBuildDeadlineForTests(ms = BUILD_DEADLINE_MS) {
  buildDeadlineMs = ms;
}

module.exports = {
  buildEngine,
  EngineBuildTimeout,
  WORKER_PATH,
  BUILD_DEADLINE_MS,
  _setWorkerPathForTests,
  _setBuildDeadlineForTests,
};
