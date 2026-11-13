/**
 * A file replaced whole, never written in place (freedom-core design 0001,
 * "Writes and durability": the single-file write).
 *
 * For files another process reads while main writes them. From the APR-3 pin
 * on, freedom-cored reads the four permission files (`dapp-permissions.json`,
 * `swarm-permissions.json`, `radicle-permissions.json`,
 * `x402-permissions.json`) at each of its checks, while main is still their
 * only writer (design 0012, "The files (Q10)"). It reads a file that doesn't
 * parse as an empty store, so a read must never see a half-written one.
 *
 * - **The temp file** is new, in the target's directory, made exclusively
 *   (`wx`, so a name already there, a link included, fails the write instead
 *   of being written through) with mode 0600.
 * - **The order** is 0001's: write the temp file, fsync it, rename it over
 *   the target, then flush the directory. A rename replaces the target's
 *   link itself, never what it points at.
 * - **A failure before the rename** leaves the target as it was, removes the
 *   temp file and throws. The directory flush after the rename is best
 *   effort: the new file is in place either way (0001's `durable: false`).
 *   Windows has no directory flush.
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

/** Flushes `directory`'s entries (POSIX); a failure is ignored. */
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // The rename is done: the file is in place, only maybe not durable yet.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Replaces `filePath` with `data` by a temp file and a rename.
 * @param {string} filePath
 * @param {string} data - written as UTF-8
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
  syncDirectory(path.dirname(filePath));
}

module.exports = { writeFileAtomicSync };
