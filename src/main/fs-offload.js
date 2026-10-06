// Recursive removes and copies of node data, run off the main thread (#513).
//
// Node data (Ant localstore/statestore, Radicle storage, a whole profile dir)
// can be several GB and hundreds of thousands of files. fs.rmSync/fs.cpSync on
// the main thread freeze every window for the whole operation. fs.promises.rm
// is not enough either: its recursive walk issues one libuv request per entry
// with no concurrency bound, and the completions land in a handful of poll
// phases — measured on a 200k-file / 3 GB tree under Electron 44 it still
// stalled the main loop for ~500 ms in one go (the synchronous rmSync: ~1.1 s).
//
// So each operation runs the *same* synchronous fs call in a short-lived worker
// thread instead. The main thread only waits on a message, and the operation
// keeps fs.rmSync/fs.cpSync's exact semantics (Windows read-only/EPERM
// handling, `force`, `errorOnExist`, ...). Errors come back with their `code`,
// `errno`, `syscall` and `path`, so callers can keep branching on EPERM/EBUSY.
//
// The worker source is inline (`eval: true`) so there is no extra file to ship
// or unpack from the asar.

const fs = require('fs');
const { Worker } = require('worker_threads');

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { op, args } = workerData;
try {
  if (op === 'rm') fs.rmSync(...args);
  else if (op === 'cp') fs.cpSync(...args);
  else throw new Error('Unknown fs-offload op: ' + op);
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: {
      message: err && err.message,
      code: err && err.code,
      errno: err && err.errno,
      syscall: err && err.syscall,
      path: err && err.path,
      dest: err && err.dest,
    },
  });
}
`;

function toError(serialized) {
  const err = new Error(serialized?.message || 'fs-offload operation failed');
  for (const key of ['code', 'errno', 'syscall', 'path', 'dest']) {
    if (serialized?.[key] !== undefined) err[key] = serialized[key];
  }
  return err;
}

// Test seam: lets a test force the fallback path.
let createWorker = (source, options) => new Worker(source, options);

function runInWorker(op, args) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = createWorker(WORKER_SOURCE, { eval: true, workerData: { op, args } });
    } catch (err) {
      reject(Object.assign(err, { workerUnavailable: true }));
      return;
    }

    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      if (message?.ok) resolve();
      else reject(toError(message?.error));
    });
    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`fs-offload worker exited with code ${code} before replying`));
    });
  });
}

async function offload(op, args, fallback) {
  try {
    await runInWorker(op, args);
  } catch (err) {
    if (!err?.workerUnavailable) throw err;
    // No worker available: still don't block — fs.promises at least yields
    // between entries.
    await fallback();
  }
}

/**
 * Off-main-thread equivalent of fs.rmSync(target, options).
 * @param {string} target
 * @param {fs.RmOptions} [options]
 * @returns {Promise<void>}
 */
function removePath(target, options = { recursive: true, force: true }) {
  return offload('rm', [target, options], () => fs.promises.rm(target, options));
}

/**
 * Off-main-thread equivalent of fs.cpSync(source, destination, options).
 * Only plain-data options (no `filter` function) can cross into the worker.
 * @param {string} source
 * @param {string} destination
 * @param {fs.CopySyncOptions} [options]
 * @returns {Promise<void>}
 */
function copyPath(source, destination, options = {}) {
  return offload('cp', [source, destination, options], () =>
    fs.promises.cp(source, destination, options)
  );
}

module.exports = {
  copyPath,
  removePath,
  __setCreateWorkerForTests(factory) {
    createWorker = factory || ((source, options) => new Worker(source, options));
  },
};
