/**
 * Owner-only directories and files for node keys and the configs that hold
 * their secrets (K-3). The one module every key and secret-bearing config
 * goes through.
 *
 * Node data directories hold key material: Ant's `keys/swarm.key` and the
 * `config.yaml` with its keystore password, Radicle's `keys/radicle`, the
 * identity vault. Created with the process umask, they come out 0755/0644
 * and any local account can read them.
 *
 * Never through a link. A name in these directories that is a symlink could
 * point anywhere, so:
 *  - reads and repairs open the file with O_NOFOLLOW, check the opened
 *    object is a regular file this account owns, and fchmod / read through
 *    that one descriptor;
 *  - writes create an exclusive temp file (O_CREAT | O_EXCL | O_NOFOLLOW,
 *    0600) in the same directory, fsync it and rename it over the name. A
 *    rename replaces a link itself, never its target;
 *  - directories are lstat-checked (not a link), created 0700, and narrowed
 *    through an O_NOFOLLOW descriptor.
 *
 * POSIX only for modes and ownership: on Windows the files inherit the user
 * profile directory's ACL, so there the helpers do the plain open, write and
 * rename, and still refuse anything that is not a regular file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const POSIX = process.platform !== 'win32';
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
const NOFOLLOW = POSIX ? fs.constants.O_NOFOLLOW : 0;
const DIRECTORY = POSIX ? fs.constants.O_DIRECTORY : 0;

class UnsafePrivatePathError extends Error {
  constructor(target, why) {
    super(`Refusing ${target}: ${why}`);
    this.name = 'UnsafePrivatePathError';
    this.code = 'UNSAFE_PRIVATE_PATH';
  }
}

// An object opened through a descriptor: the right kind, and ours.
function checkOpened(fd, target, { directory = false } = {}) {
  const stat = fs.fstatSync(fd);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new UnsafePrivatePathError(target, directory ? 'not a directory' : 'not a regular file');
  }
  if (POSIX && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new UnsafePrivatePathError(target, 'owned by another account');
  }
  return stat;
}

// Only when group or other have any access: an owner-only mode (0400, say)
// is left as it is.
function narrow(fd, stat, mode, target) {
  if (!POSIX || (stat.mode & 0o077) === 0) return false;
  try {
    fs.fchmodSync(fd, mode);
    return true;
  } catch (err) {
    console.warn(`[PrivateFiles] Could not restrict ${target}:`, err.message);
    return false;
  }
}

/**
 * Open `target` (never through a link), check it is a regular file this
 * account owns, narrow it to 0600, then run `use(fd)`.
 * @returns {*} use's result, or null when `target` does not exist
 * @throws {UnsafePrivatePathError} a link (ELOOP), or not ours / not a file
 */
function withPrivateFile(target, use) {
  let fd;
  try {
    fd = fs.openSync(target, O_RDONLY | NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') throw new UnsafePrivatePathError(target, 'it is a symbolic link');
    throw err;
  }
  try {
    const stat = checkOpened(fd, target);
    narrow(fd, stat, PRIVATE_FILE_MODE, target);
    return use(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a private file through one no-follow descriptor, repairing its mode
 * first.
 * @param {string} target
 * @returns {Buffer|null} null when it does not exist
 */
function readPrivateFile(target) {
  return withPrivateFile(target, (fd) => fs.readFileSync(fd));
}

/**
 * Narrow an existing private file to 0600 (startup repair). A missing file
 * is fine. A link or a file that is not ours is reported and left alone.
 * @returns {boolean} whether a file was there and is now private
 */
function repairPrivateFile(target) {
  try {
    return withPrivateFile(target, () => true) === true;
  } catch (err) {
    console.warn(`[PrivateFiles] Not repairing ${target}:`, err.message);
    return false;
  }
}

function fsyncDirectory(dir) {
  if (!POSIX) return;
  let fd;
  try {
    fd = fs.openSync(dir, O_RDONLY | DIRECTORY | NOFOLLOW);
    fs.fsyncSync(fd);
  } catch (err) {
    console.warn(`[PrivateFiles] Could not fsync ${dir}:`, err.message);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Replace `target` with `data`, owner-only: an exclusive no-follow 0600
 * temp file beside it, fsynced, renamed over the name (which replaces a link
 * at that name, not its target), then the directory fsynced.
 * @param {string} target
 * @param {string|Buffer} data
 */
function writePrivateFileSync(target, data) {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  const fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  fsyncDirectory(path.dirname(target));
}

/**
 * Create `dir` (and missing parents) owner-only, or narrow it if it exists.
 * The directory itself must not be a link; its parents may be (macOS's
 * /tmp is one), since only the last component is under our control.
 * @param {string} dir
 * @returns {string} dir
 * @throws {UnsafePrivatePathError} when `dir` is a link or not a directory
 */
function ensurePrivateDir(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat?.isSymbolicLink()) throw new UnsafePrivatePathError(dir, 'it is a symbolic link');
  if (!stat) fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (!POSIX) {
    if (!fs.statSync(dir).isDirectory()) throw new UnsafePrivatePathError(dir, 'not a directory');
    return dir;
  }
  let fd;
  try {
    fd = fs.openSync(dir, O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP') throw new UnsafePrivatePathError(dir, 'it is a symbolic link');
    if (err.code === 'ENOTDIR') throw new UnsafePrivatePathError(dir, 'not a directory');
    throw err;
  }
  try {
    narrow(fd, checkOpened(fd, dir, { directory: true }), PRIVATE_DIR_MODE, dir);
  } finally {
    fs.closeSync(fd);
  }
  return dir;
}

/**
 * Narrow an existing private directory (startup repair); missing is fine,
 * a link or a directory that is not ours is reported and left alone.
 */
function repairPrivateDir(dir) {
  try {
    if (!fs.existsSync(dir) && !fs.lstatSync(dir, { throwIfNoEntry: false })) return false;
    ensurePrivateDir(dir);
    return true;
  } catch (err) {
    console.warn(`[PrivateFiles] Not repairing ${dir}:`, err.message);
    return false;
  }
}

module.exports = {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  UnsafePrivatePathError,
  ensurePrivateDir,
  repairPrivateDir,
  readPrivateFile,
  repairPrivateFile,
  writePrivateFileSync,
};
