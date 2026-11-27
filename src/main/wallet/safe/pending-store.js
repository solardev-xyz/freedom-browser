/**
 * Pending SafeTx store — the half-signed transaction that survives a
 * restart, as interim JSON (same posture as the other wallet JSON
 * stores; migrates into the unified wallet-history SQLite later).
 *
 * One pending SafeTx per Safe at a time, by design (research doc B.4):
 * a single slot sidesteps the nonce-replacement/ordering swamp that
 * Safe's hosted service exists to manage. Collected signatures are just
 * bytes — safe to persist, useless without the Safe and its chain state.
 *
 * Losing this file loses every collected signature (#1068), so it fails
 * closed:
 * - A file that cannot be READ (EACCES, EBUSY, EMFILE, EIO…) is left
 *   exactly where it is and every call throws SAFE_PENDING_UNREADABLE.
 *   Nothing is cached, so the next call tries again and a transient
 *   error heals on its own; no write can replace a file we never read.
 * - A file that reads but does not PARSE (torn write) is renamed aside to
 *   `safe-pending.json.corrupt-<ts>` and the user is told (see
 *   getStoreNotice). If that rename fails too, the store stays unreadable
 *   as above rather than starting empty over the old bytes.
 * - Writes go through a unique temp file, fsync and rename, and the
 *   in-memory copy only changes once the rename landed: a failed write
 *   throws to the caller and leaves memory and disk agreeing.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { codedError, SAFE_PENDING_UNREADABLE } = require('./errors');

const PENDING_FILE = 'safe-pending.json';

// Temp files are `safe-pending.json.<16 hex>.tmp`. A write is one
// synchronous call, so a temp older than this belongs to a write a crash
// interrupted, never to one still in flight.
const TMP_NAME = /^safe-pending\.json\.[0-9a-f]{16}\.tmp$/;
const STALE_TMP_MS = 60_000;

// On Windows a rename over a file another handle holds open (Defender,
// the search indexer) fails with EPERM/EACCES/EBUSY until that handle
// closes; retry briefly, as graceful-fs does. This runs on Electron's
// main thread, so the total wait stays short (~150 ms).
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 75];

let cache = null;
let notice = null;
let swept = false;

function getFilePath() {
  return path.join(app.getPath('userData'), PENDING_FILE);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw err;
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function sweepStaleTempFiles(dir, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TMP_NAME.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.unlinkSync(file);
    } catch {
      // gone already — try again next start
    }
  }
}

function unreadable(reason, cause) {
  const err = codedError(
    `Unfinished Safe transactions could not be read (${reason}). ` +
      'Nothing was changed; they will appear again once the file can be read.',
    SAFE_PENDING_UNREADABLE
  );
  err.cause = cause;
  return err;
}

function parseStore(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pending store root must be an object');
  }
  return parsed;
}

function load() {
  if (cache !== null) {
    return cache;
  }
  const filePath = getFilePath();
  if (!swept) {
    swept = true;
    sweepStaleTempFiles(path.dirname(filePath));
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      cache = {};
      return cache;
    }
    // An I/O failure says nothing about the bytes on disk: never move
    // them, never cache, let the next call try again.
    console.error('[SafePending] Failed to read pending store:', err);
    throw unreadable(err?.code || err?.message || 'read error', err);
  }

  try {
    cache = parseStore(raw);
    return cache;
  } catch (parseErr) {
    console.error('[SafePending] Pending store is damaged:', parseErr);
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      renameWithRetry(filePath, corruptPath);
    } catch (moveErr) {
      // Could not set it aside: starting empty would let the next save
      // replace the only copy, so stay unreadable instead.
      console.error('[SafePending] Failed to move damaged pending store aside:', moveErr);
      throw unreadable(
        `damaged, and could not be set aside: ${moveErr?.code || moveErr?.message}`,
        moveErr
      );
    }
    console.warn(`[SafePending] Moved damaged pending store aside to ${corruptPath}`);
    notice = {
      kind: 'quarantined',
      path: corruptPath,
      message:
        'The unfinished Safe transactions file was damaged and has been set aside as ' +
        `${corruptPath}. It may still hold collected signatures; ` +
        'unfinished transactions start fresh from here.',
    };
    cache = {};
    return cache;
  }
}

function fsyncDir(dir) {
  // Makes the rename itself durable. Not possible on Windows (a directory
  // cannot be opened for fsync there); a failure after the rename landed
  // must not report the write as failed, so it is only logged.
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    console.warn('[SafePending] Could not fsync store directory:', err?.message);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** Write `next` to disk atomically; throws on failure (disk untouched). */
function save(next) {
  const filePath = getFilePath();
  const dir = path.dirname(filePath);
  const body = JSON.stringify(next, null, 2);
  const temporary = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(temporary, filePath);
  } catch (err) {
    console.error('[SafePending] Failed to save pending store:', err);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // never created, or already renamed — keep the original failure
    }
    throw err;
  }
  fsyncDir(dir);
}

// Entries are handed out and taken in as copies: callers mutate what they
// get (`pending.superseded = true`) before setPending, and the cache must
// only ever hold what is on disk.
const copy = (value) => structuredClone(value);

/** @returns {Object|null} The pending entry for a safe wallet index */
function getPending(safeIndex) {
  const entry = load()[safeIndex];
  return entry ? copy(entry) : null;
}

function setPending(safeIndex, entry) {
  const next = { ...load(), [safeIndex]: copy(entry) };
  save(next);
  cache = next;
}

function clearPending(safeIndex) {
  const store = load();
  if (safeIndex in store) {
    const next = { ...store };
    delete next[safeIndex];
    save(next);
    cache = next;
  }
}

/** Safe wallet indexes that currently have a pending SafeTx. */
function listPendingIndexes() {
  return Object.keys(load()).map(Number);
}

/**
 * Something the user must be told about the store this session (a damaged
 * file set aside), or null. Session-only: the `.corrupt-*` file itself
 * stays on disk.
 */
function getStoreNotice() {
  return notice ? { ...notice } : null;
}

function _resetForTests() {
  cache = null;
  notice = null;
  swept = false;
}

module.exports = {
  getPending,
  setPending,
  clearPending,
  listPendingIndexes,
  getStoreNotice,
  _resetForTests,
  _internals: { sweepStaleTempFiles, STALE_TMP_MS },
};
