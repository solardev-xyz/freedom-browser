/**
 * Durable journal: an append-only JSON Lines file whose appends are on disk
 * by the time they are acknowledged.
 *
 * For records that must survive a crash or a power cut once their writer has
 * been told they are written. The wallet's intent records (freedom-core
 * design 0005, "Retrying an intent") are committed here before a signed
 * transaction's bytes go to a broadcaster.
 *
 * - **Lines.** One JSON object per line:
 *   `{"v":1,"sha256":"<hex>","record":<record>}`. The checksum covers the
 *   record's exact bytes, so a line is checked without serializing anything
 *   again, and every line is still plain JSON.
 * - **Appends** are serialized, so concurrent callers never interleave
 *   partial lines. Each one opens the file, appends, calls
 *   `filehandle.sync()` and only then resolves. It is all async: main's
 *   event loop never waits on the disk. The file is created with mode 0600,
 *   and the append that creates it also syncs the directory (POSIX), or the
 *   new entry, and every line in it, could be lost.
 * - **A failed append** is cut back off the file. If that fails too, the end
 *   of the file is unknown, and the journal refuses every later write until
 *   it is opened again.
 * - **Reading** ignores a torn last line, one without its newline: an append
 *   that never completed, so it was never acknowledged. A damaged complete
 *   line is skipped and reported. `open()` cuts a torn tail off, so the next
 *   append starts a line of its own.
 * - **Compaction** replaces the file with the records given: a temp file,
 *   sync, rename, directory sync. A crash before the rename keeps the old
 *   journal, and its leftover temp file is removed on the next `open()`.
 *   Callers only compact to a subset of what the file says, so the old file
 *   is never wrong, just longer. Windows has no directory sync, so there
 *   the renamed file is synced instead.
 *
 * One process writes a journal at a time; for files under userData the
 * profile lock (profile-lock.js) ensures it.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const LINE_PREFIX = '{"v":1,"sha256":"';
const RECORD_KEY = '","record":';
const DIGEST_LENGTH = 64;
const HEADER_LENGTH = LINE_PREFIX.length + DIGEST_LENGTH + RECORD_KEY.length;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const NEWLINE = 0x0a;
const CLOSING_BRACE = 0x7d;
const FILE_MODE = 0o600;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const IS_WINDOWS = process.platform === 'win32';
// What a file system that can't sync a directory answers.
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF']);

function journalError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** One record as its line, newline included. */
function encodeLine(record) {
  if (!isPlainObject(record)) {
    throw journalError('A journal record must be a JSON object', 'JOURNAL_INVALID_RECORD');
  }
  const body = JSON.stringify(record);
  return `${LINE_PREFIX}${sha256(Buffer.from(body, 'utf8'))}${RECORD_KEY}${body}}\n`;
}

// One complete line, without its newline: `{ record }` or `{ reason }`.
function decodeLine(line) {
  if (line.length <= HEADER_LENGTH || line[line.length - 1] !== CLOSING_BRACE) {
    return { reason: 'malformed' };
  }
  const header = line.toString('latin1', 0, HEADER_LENGTH);
  const digest = header.slice(LINE_PREFIX.length, LINE_PREFIX.length + DIGEST_LENGTH);
  if (
    !header.startsWith(LINE_PREFIX) ||
    !header.endsWith(RECORD_KEY) ||
    !DIGEST_PATTERN.test(digest)
  ) {
    return { reason: 'malformed' };
  }
  const body = line.subarray(HEADER_LENGTH, line.length - 1);
  if (sha256(body) !== digest) return { reason: 'checksum' };
  let record;
  try {
    record = JSON.parse(body.toString('utf8'));
  } catch {
    return { reason: 'malformed' };
  }
  return isPlainObject(record) ? { record } : { reason: 'malformed' };
}

/**
 * Parse a journal's bytes.
 *
 * @param {Buffer} buffer
 * @returns {{
 *   records: object[],
 *   corrupt: Array<{ line: number, offset: number, reason: 'malformed'|'checksum' }>,
 *   completeLength: number,
 *   tornTail: number,
 * }} `completeLength` is where the last complete line ends; `tornTail` is
 *   how many bytes follow it.
 */
function parseJournal(buffer) {
  const records = [];
  const corrupt = [];
  let start = 0;
  let line = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(NEWLINE, start);
    if (end === -1) break;
    line += 1;
    const decoded = decodeLine(buffer.subarray(start, end));
    if (decoded.record) records.push(decoded.record);
    else corrupt.push({ line, offset: start, reason: decoded.reason });
    start = end + 1;
  }
  return { records, corrupt, completeLength: start, tornTail: buffer.length - start };
}

/**
 * Read a journal without changing it.
 *
 * @returns {Promise<{ missing: boolean, size: number } & ReturnType<typeof parseJournal>>}
 */
async function readJournal(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { missing: true, size: 0, records: [], corrupt: [], completeLength: 0, tornTail: 0 };
  }
  if (!stat.isFile()) {
    throw journalError(`Journal is not a regular file: ${filePath}`, 'JOURNAL_NOT_A_FILE');
  }
  const tooLarge = () =>
    journalError(`Journal is larger than ${maxBytes} bytes: ${filePath}`, 'JOURNAL_TOO_LARGE');
  if (stat.size > maxBytes) throw tooLarge();
  const buffer = await fs.readFile(filePath);
  if (buffer.length > maxBytes) throw tooLarge();
  return { missing: false, size: buffer.length, ...parseJournal(buffer) };
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function syncDirectory(directory) {
  if (IS_WINDOWS) return;
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [options] `maxBytes` bounds what `open()`
 *   reads; a larger file fails with `JOURNAL_TOO_LARGE`.
 */
function createJournal(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const directory = path.dirname(filePath);
  const tempPrefix = `${path.basename(filePath)}.compact-`;
  let queue = Promise.resolve();
  let opened = false;
  let exists = false;
  // The file was created, and its directory not synced since.
  let entryUnsynced = false;
  let size = 0;
  let broken = null;

  // Runs one file operation at a time, in call order.
  function serialize(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  function assertWritable() {
    if (!opened) throw journalError('The journal is not open', 'JOURNAL_NOT_OPEN');
    if (broken) {
      throw journalError(
        'The journal could not finish a write; reopen it before writing again',
        'JOURNAL_BROKEN',
        broken
      );
    }
  }

  // The directory entry of a file just created or renamed.
  async function syncEntry() {
    if (!IS_WINDOWS) return syncDirectory(directory);
    const handle = await fs.open(filePath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function removeStaleTemps() {
    for (const name of await fs.readdir(directory)) {
      if (name.startsWith(tempPrefix) && name.endsWith('.tmp')) {
        await fs.rm(path.join(directory, name), { force: true });
      }
    }
  }

  async function cutTornTail(length) {
    const handle = await fs.open(filePath, 'r+');
    try {
      await handle.truncate(length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function restrictMode() {
    if (IS_WINDOWS) return;
    const stat = await fs.stat(filePath);
    if ((stat.mode & 0o777) !== FILE_MODE) await fs.chmod(filePath, FILE_MODE);
  }

  /**
   * Read the journal and make it ready for appends: remove a crashed
   * compaction's temp file, cut a torn tail off and set the mode to 0600.
   * Opening again (after a failed write) re-reads the file.
   *
   * @returns {Promise<ReturnType<typeof readJournal>>}
   */
  function open() {
    return serialize(async () => {
      opened = false;
      await removeStaleTemps();
      const result = await readJournal(filePath, { maxBytes });
      if (!result.missing) {
        if (result.tornTail > 0) await cutTornTail(result.completeLength);
        await restrictMode();
      }
      exists = !result.missing;
      entryUnsynced = false;
      size = result.completeLength;
      broken = null;
      opened = true;
      return result;
    });
  }

  /**
   * Append one record. Resolves once the line is synced to disk.
   *
   * @param {object} record a JSON object
   */
  async function append(record) {
    const line = Buffer.from(encodeLine(record), 'utf8');
    return serialize(async () => {
      assertWritable();
      const handle = await fs.open(filePath, exists ? 'a' : 'ax', FILE_MODE);
      if (!exists) {
        exists = true;
        entryUnsynced = true;
      }
      try {
        await handle.appendFile(line);
        await handle.sync();
      } catch (error) {
        // Take the partial or unsynced line back off, so the file ends where
        // the last acknowledged append left it.
        try {
          await handle.truncate(size);
          await handle.sync();
        } catch {
          broken = error;
        }
        throw error;
      } finally {
        await handle.close().catch(() => {});
      }
      size += line.length;
      if (entryUnsynced) {
        try {
          await syncDirectory(directory);
        } catch (error) {
          // The line is synced, but the file holding it might not survive.
          broken = error;
          throw error;
        }
        entryUnsynced = false;
      }
    });
  }

  /**
   * Replace the journal with these records, in this order. Compact only to
   * records the file already holds (or that fold to the same state), so
   * that the old file, if a crash keeps it, is still right.
   *
   * @param {object[]} records
   */
  async function compact(records) {
    const bytes = Buffer.from(records.map(encodeLine).join(''), 'utf8');
    return serialize(async () => {
      assertWritable();
      const temp = path.join(directory, `${tempPrefix}${crypto.randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temp, 'wx', FILE_MODE);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, filePath);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      exists = true;
      entryUnsynced = true;
      size = bytes.length;
      try {
        await syncEntry();
      } catch (error) {
        // Later appends would land in a file whose name may not survive.
        broken = error;
        throw error;
      }
      entryUnsynced = false;
    });
  }

  /**
   * Move the journal aside, to `<file>.<tag>`, and start an empty one, also
   * when `open()` refused the file. Returns the path it was moved to, or null
   * when there was no file.
   *
   * @param {string} tag
   */
  function moveAside(tag) {
    return serialize(async () => {
      let target = `${filePath}.${tag}`;
      for (let n = 1; await pathExists(target); n += 1) {
        target = `${filePath}.${tag}-${n}`;
      }
      try {
        await fs.rename(filePath, target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        target = null;
      }
      if (target) await syncDirectory(directory);
      exists = false;
      entryUnsynced = false;
      size = 0;
      broken = null;
      opened = true;
      return target;
    });
  }

  return {
    filePath,
    open,
    append,
    compact,
    moveAside,
    /** Bytes in the journal, as of the last completed operation. */
    get size() {
      return size;
    },
  };
}

module.exports = {
  FILE_MODE,
  createJournal,
  encodeLine,
  parseJournal,
  readJournal,
};
