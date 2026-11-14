/**
 * A file replaced whole, never written in place (freedom-core design 0001,
 * "Writes and durability": the single-file write).
 *
 * For files another process reads while main writes them. From the APR-3 pin
 * on, freedom-cored reads the four permission files at each of its checks,
 * and main is still the only writer of `dapp-permissions.json` and
 * `x402-permissions.json` (design 0012, "The files (Q10)"; the core writes
 * `swarm-permissions.json` and `radicle-permissions.json` from APB-3, and
 * main writes them nowhere). It reads a file that doesn't parse as an empty
 * store, so a read must never see a half-written one.
 *
 * - **The temp file** is new, in the target's directory, made exclusively
 *   (`wx`, so a name already there, a link included, fails the write instead
 *   of being written through) with mode 0600.
 * - **The order** is 0001's: write the temp file, fsync it, rename it over
 *   the target, then flush the directory. A rename replaces the target's
 *   link itself, never what it points at.
 * - **A failure before the rename** leaves the target as it was, removes the
 *   temp file and throws.
 * - **After the rename, the flush** makes the rename durable: on POSIX an
 *   fsync of the directory; on Windows, which has no directory flush, the
 *   renamed file reopened and flushed (`FlushFileBuffers`, which Node's
 *   fsync calls), as 0001 does. Its failure isn't ignored, and isn't thrown
 *   either, since the new file is already in place: the write returns
 *   `{ durable: false }` (0001's committed-but-not-durable outcome), and the
 *   caller reports it.
 *
 * Synchronous, as the stores that use it are.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_MODE = 0o600;

/** The temp file's name beside `filePath`'s: unique to this write. */
function tempPathFor(filePath) {
  const unique = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  return path.join(path.dirname(filePath), `${path.basename(filePath)}.${unique}.tmp`);
}

/**
 * Makes the rename of `filePath` durable: the directory's entries flushed
 * (POSIX), or the renamed file reopened and flushed (Windows).
 * @returns {boolean} whether the flush succeeded
 */
function flushAfterRename(filePath) {
  const windows = process.platform === 'win32';
  let fd;
  try {
    // FlushFileBuffers needs a handle open for writing.
    fd = windows ? fs.openSync(filePath, 'r+') : fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The flush's outcome is already decided.
      }
    }
  }
}

/**
 * Replaces `filePath` with `data` by a temp file and a rename.
 * @param {string} filePath
 * @param {string} data - written as UTF-8
 * @returns {{ durable: boolean }} `durable: false` when the rename is done but
 *   its flush failed: the new file is in place, and a power loss before the
 *   system writes it back could restore the old one.
 */
function writeFileAtomicSync(filePath, data) {
  const tempPath = tempPathFor(filePath);
  const fd = fs.openSync(tempPath, 'wx', FILE_MODE);
  let renamed = false;
  try {
    try {
      fs.writeFileSync(fd, data, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) fs.rmSync(tempPath, { force: true });
  }
  return { durable: flushAfterRename(filePath) };
}

module.exports = { writeFileAtomicSync };
