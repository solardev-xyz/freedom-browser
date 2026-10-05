/**
 * Asynchronous main.log writes with crash-safe warn/error lines (#511).
 *
 * electron-log's sync default does one `fs.writeFileSync` (open, write,
 * close) per line on the main thread. logger.js turns the file transport
 * asynchronous (`log.transports.file.sync = false`) and installs
 * `createLogFileHook()` on `log.hooks`. The hook does two things:
 *
 * - It gives the File electron-log creates (5.4.x,
 *   `src/node/transports/file/File.js`) its own `nextAsyncWrite`, which
 *   appends one batch at a time as: async `fs.open` → `fs.writeSync` of the
 *   batch on the main thread → async `fs.close`. The open and close — the
 *   per-line syscalls that cost the most, especially with an antivirus filter
 *   on `CreateFile` — stay off the main thread. Unlike electron-log's own
 *   `fs.writeFile` chain, the batch in flight is kept here until it is
 *   written, and is written by exactly one party: either the open callback or
 *   a synchronous settle (below), whichever runs first on the main thread.
 *   The write itself never sits in the thread pool, so there is no moment at
 *   which a batch is "maybe written".
 * - Before electron-log hands a `warn` or `error` line to the file transport,
 *   it settles the file synchronously — the in-flight batch (if its open has
 *   not called back yet), then the queue, in that order — and switches the
 *   File to sync, so that line is appended with `fs.writeFileSync` before the
 *   `log.warn()`/`log.error()` call returns. The next `info`-or-below line
 *   switches it back to async.
 *
 * So every warn and error line is on disk before the call that logged it
 * returns, preceded in order by every line logged before it. A hang, SIGKILL
 * or segfault after that point loses only `info`-and-below lines logged since
 * the last warn/error. `FREEDOM_LOG_SYNC=1` makes every line synchronous, for
 * chasing a hang or native crash where those info lines matter (cf. #345,
 * #292): logger.js then leaves electron-log's sync transport alone.
 *
 * Exit paths. electron-log has no flush, so:
 *
 * - `app.exit()` emits no `will-quit`, `quit` or `process` `'exit'` at all
 *   (probed on Electron 44), so a forced exit calls `flushLogFileSync()`
 *   itself first; logger.js also flushes on `'exit'`.
 * - At the end of a graceful quit's wind-down, index.js calls
 *   `drainLogFile()`, so the remaining quit handlers' lines land at once.
 *   Observed 2026-10-05 on Electron 44.4.5 with electron-log's own writer:
 *   with neither flush the last 6–8 wind-down lines were missing from
 *   main.log; with only the `'exit'` flush they landed before the in-flight
 *   batch, out of order. With the batch kept here, a flush writes the
 *   in-flight batch first, so both flushes keep order.
 *
 * These reach into the File object electron-log returns from
 * `transport.getFile()` (`asyncWriteQueue`, `hasActiveAsyncWriting`,
 * `writeAsync`, `nextAsyncWrite`, `writeOptions`,
 * `increaseBytesWrittenCounter`). log-file-flush.test.js drives the installed
 * electron-log's real Logger and File classes, so a version that renames them
 * fails there.
 */
const fs = require('fs');

const DRAIN_TIMEOUT_MS = 1000;
const DRAIN_POLL_MS = 5;
const SYNC_LEVELS = new Set(['warn', 'error']);

// Per-File state, keyed by the File object electron-log owns.
const states = new WeakMap();

function asyncFileOf(fileTransport, message) {
  let file;
  try {
    file = fileTransport?.getFile?.(message);
  } catch {
    return null;
  }
  if (!file || (typeof file.isNull === 'function' && file.isNull())) return null;
  if (!Array.isArray(file.asyncWriteQueue) || typeof file.path !== 'string') return null;
  return file;
}

function emitWriteError(file, err) {
  try {
    if (file.listenerCount?.('error') > 0) {
      file.emit('error', new Error(`Couldn't write to ${file.path}. ${err.message}`), file);
    }
  } catch {
    // Nowhere left to report it: the log file is what failed.
  }
}

function countBytes(file, text) {
  if (typeof file.increaseBytesWrittenCounter === 'function') {
    file.increaseBytesWrittenCounter(text);
  }
}

function writeAllSync(fsImpl, fd, text, encoding) {
  const buf = Buffer.from(text, encoding || 'utf8');
  let off = 0;
  while (off < buf.length) off += fsImpl.writeSync(fd, buf, off, buf.length - off);
}

/**
 * Replaces the File's `nextAsyncWrite` with one that keeps the batch in flight
 * until it is written (see the header). Idempotent; returns the state.
 */
function installBatchWriter(file, { fsImpl = fs } = {}) {
  let state = states.get(file);
  if (state) return state;
  state = { inFlight: null, pinnedSync: false, fsImpl };
  states.set(file, state);

  const finish = () => {
    state.inFlight = null;
    file.hasActiveAsyncWriting = false;
    file.nextAsyncWrite();
  };

  file.nextAsyncWrite = function nextAsyncWrite() {
    if (file.hasActiveAsyncWriting || file.asyncWriteQueue.length === 0) return;
    const batch = { text: file.asyncWriteQueue.join(''), written: false };
    file.asyncWriteQueue = [];
    file.hasActiveAsyncWriting = true;
    state.inFlight = batch;
    const { flag = 'a', mode = 0o666, encoding = 'utf8' } = file.writeOptions || {};
    fsImpl.open(file.path, flag, mode, (openErr, fd) => {
      if (batch.written) {
        // A synchronous settle already wrote this batch.
        if (!openErr) fsImpl.close(fd, () => {});
        finish();
        return;
      }
      if (openErr) {
        batch.written = true; // dropped, as electron-log drops a failed write
        emitWriteError(file, openErr);
        finish();
        return;
      }
      try {
        writeAllSync(fsImpl, fd, batch.text, encoding);
        countBytes(file, batch.text);
      } catch (err) {
        emitWriteError(file, err);
      }
      batch.written = true;
      fsImpl.close(fd, finish);
    });
  };
  return state;
}

/**
 * Writes whatever is not on disk yet — the in-flight batch, if its open has
 * not called back, then the queue — synchronously, in that order, and turns
 * the File synchronous. Never throws.
 */
function settleSync(file, state) {
  file.writeAsync = false;
  let text = '';
  if (state?.inFlight && !state.inFlight.written) {
    text += state.inFlight.text;
    state.inFlight.written = true;
  }
  text += file.asyncWriteQueue.join('');
  file.asyncWriteQueue = [];
  if (!text) return;
  try {
    (state?.fsImpl || fs).writeFileSync(file.path, text, file.writeOptions);
    countBytes(file, text);
  } catch (err) {
    emitWriteError(file, err);
  }
}

/**
 * An electron-log hook (`log.hooks.push(...)`) for the file transport: keeps
 * `info`-and-below asynchronous and makes `warn`/`error` synchronous and
 * in order (see the header). Returns the message unchanged.
 */
function createLogFileHook({ fsImpl = fs } = {}) {
  // The File last seen for each transport. An info line already headed for an
  // async File skips the getFile() lookup (path resolution on every line); a
  // warn/error always looks it up afresh.
  const lastFile = new WeakMap();
  return function logFileHook(message, transport, transportName) {
    if (transportName !== 'file' || !transport) return message;
    const syncLevel = SYNC_LEVELS.has(message?.level);
    if (!syncLevel && lastFile.get(transport)?.writeAsync === true) return message;
    const file = asyncFileOf(transport, message);
    if (!file) return message;
    lastFile.set(transport, file);
    const state = installBatchWriter(file, { fsImpl });
    if (syncLevel) {
      settleSync(file, state);
    } else if (!state.pinnedSync && transport.sync === false) {
      file.writeAsync = true;
    }
    return message;
  };
}

/**
 * Writes every pending line synchronously — including a batch in flight, when
 * the batch writer is installed — and makes all later lines synchronous for
 * good (the process is on its way out). Safe to call any number of times;
 * never throws.
 */
function flushLogFileSync(fileTransport, { fsImpl } = {}) {
  const file = asyncFileOf(fileTransport);
  if (!file) return;
  const state = states.get(file);
  if (state) {
    state.pinnedSync = true;
    if (fsImpl) state.fsImpl = fsImpl;
  }
  settleSync(file, state || (fsImpl ? { fsImpl } : null));
}

/**
 * Whether main.log should be written synchronously: only when
 * `FREEDOM_LOG_SYNC` is `1` (trimmed). Async is the default (#511).
 */
function wantsSyncLogFile(env = process.env) {
  return String(env?.FREEDOM_LOG_SYNC ?? '').trim() === '1';
}

/**
 * The graceful-quit flush. Waits (bounded) for an in-flight batch only when
 * the batch writer is not installed (electron-log's own writer keeps no copy
 * of it), then `flushLogFileSync()`. Never rejects.
 */
async function drainLogFile(
  fileTransport,
  { timeoutMs = DRAIN_TIMEOUT_MS, pollMs = DRAIN_POLL_MS, fsImpl } = {}
) {
  const file = asyncFileOf(fileTransport);
  const deadline = Date.now() + timeoutMs;
  while (file && !states.has(file) && file.hasActiveAsyncWriting && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  flushLogFileSync(fileTransport, { fsImpl });
}

module.exports = {
  createLogFileHook,
  drainLogFile,
  flushLogFileSync,
  installBatchWriter,
  wantsSyncLogFile,
};
