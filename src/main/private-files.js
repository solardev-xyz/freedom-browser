/**
 * Owner-only directories and files for node keys and the configs that hold
 * their secrets (K-3). The one module every key and secret-bearing config
 * goes through.
 *
 * Node data directories hold key material: Ant's `keys/swarm.key` and the
 * `config.yaml` with its keystore password, Radicle's `keys/radicle`, the
 * identity vault and the quick-unlock credential. Created with the process
 * umask, they come out 0755/0644 and any local account can read them.
 *
 * Never through a link, never through a swapped directory:
 *  - A managed directory is opened once, as a `PrivateDir` handle:
 *    `openPrivateDir(dataDir)` for the root, `handle.openDir('keys')` for a
 *    directory inside it. Each is opened with O_NOFOLLOW | O_DIRECTORY,
 *    checked to be a directory this account owns, and narrowed to 0700
 *    through that descriptor. A managed directory that is a link, or not
 *    ours, is refused, so a caller stops instead of using it.
 *  - Every read, repair, temp-file creation and rename of a file in it goes
 *    through the handle, which keeps its binding across awaits:
 *      - On Linux the handle names its entries `/proc/self/fd/<fd>/<name>`,
 *        which the kernel resolves inside the directory the descriptor
 *        holds, whatever the pathname points at by then: openat(2) for a
 *        runtime that has none.
 *      - Everywhere, each use is bracketed by a check that every managed
 *        component from the root down is still the directory the handle
 *        opened (same device and inode, still not a link). A change refuses
 *        the use. On macOS and Windows, which have no such path, that
 *        bracket is the binding. Only an account that can rename entries in
 *        the 0700 directories could race it, which means this account or
 *        root, and both can read the keys anyway.
 *  - Files are opened with O_NOFOLLOW | O_NONBLOCK | O_NOCTTY, so a FIFO or
 *    device at the name cannot block or act on the open. The descriptor is
 *    checked to be a regular file this account owns before any I/O, then
 *    fchmod'ed and read through.
 *  - Writes create an exclusive temp file (O_CREAT | O_EXCL | O_NOFOLLOW,
 *    0600) in the directory, fsync it and rename it over the name. A rename
 *    replaces a link itself, never its target.
 *
 * Ancestors above a managed root (the profile's userData, macOS's /tmp) may
 * be links: they are not ours to manage. The path functions
 * (`readPrivateFile`, `repairPrivateFile`, `writePrivateFileSync`) are for
 * files directly in such a directory (`<userData>/rpc-api-keys.json`). They
 * bind the same way to that directory, with its links followed.
 *
 * POSIX only for modes and ownership: on Windows the files inherit the user
 * profile directory's ACL, so there the helpers do the plain open, write and
 * rename, with the same directory checks, and still refuse anything that is
 * not a regular file.
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
// Opening a FIFO for reading waits for a writer, and opening a terminal can
// make it the controlling one. With these the open returns at once, so the
// descriptor's type is checked before anything else.
const NO_WAIT = POSIX ? fs.constants.O_NONBLOCK | (fs.constants.O_NOCTTY || 0) : 0;

// Linux's /proc/self/fd/<fd> binding. Off in tests that exercise the bracket
// alone, as macOS and Windows have it.
let fdBinding = process.platform === 'linux';

class UnsafePrivatePathError extends Error {
  constructor(target, why) {
    super(`Refusing ${target}: ${why}`);
    this.name = 'UnsafePrivatePathError';
    this.code = 'UNSAFE_PRIVATE_PATH';
  }
}

const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;

// An object opened through a descriptor: the right kind, and ours.
function checkOpened(fd, target, { directory = false, owned = true } = {}) {
  const stat = fs.fstatSync(fd);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new UnsafePrivatePathError(target, directory ? 'not a directory' : 'not a regular file');
  }
  if (owned && POSIX && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
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

function checkName(name) {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new TypeError(`Not a plain file name: ${JSON.stringify(name)}`);
  }
}

function boundTo(fd, stat) {
  try {
    return sameObject(fs.statSync(`/proc/self/fd/${fd}`, { bigint: true }), stat);
  } catch {
    return false;
  }
}

/**
 * A managed directory, held open. Get one from `openPrivateDir` or a
 * parent's `openDir`. Closing it closes the directories opened through it.
 */
class PrivateDir {
  constructor({ dirPath, fd, stat, parent, trusted }) {
    this.path = dirPath;
    this.fd = fd;
    this.stat = stat;
    this.parent = parent || null;
    this.trusted = trusted;
    this.children = new Set();
    this.closed = false;
    /** Entries resolve through the descriptor itself (Linux), not the path. */
    this.bound = fd !== undefined && fdBinding && boundTo(fd, stat);
  }

  entry(name) {
    checkName(name);
    return this.bound ? `/proc/self/fd/${this.fd}/${name}` : path.join(this.path, name);
  }

  /**
   * Every managed component from the root down is still the directory
   * this handle opened: same object, not a link.
   * @throws {UnsafePrivatePathError}
   */
  verify() {
    if (this.closed) throw new Error(`${this.path} is closed`);
    if (this.parent) this.parent.verify();
    let now;
    try {
      now = this.trusted
        ? fs.statSync(this.path, { bigint: true })
        : fs.lstatSync(this.path, { bigint: true });
    } catch (err) {
      throw new UnsafePrivatePathError(this.path, `it went away while in use (${err.code})`);
    }
    if (!now.isDirectory() || !sameObject(now, this.stat)) {
      throw new UnsafePrivatePathError(this.path, 'it was replaced while in use');
    }
  }

  // A regular file this account owns, opened for reading without following
  // a link or waiting on a FIFO; null when there is none.
  openFile(name) {
    this.verify();
    const target = path.join(this.path, name);
    let fd;
    try {
      fd = fs.openSync(this.entry(name), O_RDONLY | NOFOLLOW | NO_WAIT);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (err.code === 'ELOOP') throw new UnsafePrivatePathError(target, 'it is a symbolic link');
      if (err.code === 'ENXIO') throw new UnsafePrivatePathError(target, 'not a regular file');
      throw err;
    }
    try {
      const stat = checkOpened(fd, target);
      this.verify();
      return { fd, stat, target };
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  withFile(name, use) {
    const opened = this.openFile(name);
    if (!opened) return null;
    try {
      narrow(opened.fd, opened.stat, PRIVATE_FILE_MODE, opened.target);
      return use(opened.fd);
    } finally {
      fs.closeSync(opened.fd);
    }
  }

  /**
   * The file's contents, read through one no-follow descriptor after
   * narrowing it to 0600.
   * @returns {Buffer|null} null when it does not exist
   * @throws {UnsafePrivatePathError} a link, not a regular file, not ours,
   *   or this directory changed
   */
  read(name) {
    return this.withFile(name, (fd) => fs.readFileSync(fd));
  }

  /**
   * Narrow an existing file to 0600 (startup repair). Missing is fine; a
   * link or a file that is not ours is reported and left alone.
   * @returns {boolean} whether a file was there and is now private
   */
  repair(name) {
    try {
      return this.withFile(name, () => true) === true;
    } catch (err) {
      console.warn(`[PrivateFiles] Not repairing ${path.join(this.path, name)}:`, err.message);
      return false;
    }
  }

  /**
   * Replace `name` with `data`: an exclusive no-follow temp file in this
   * directory, fsynced, renamed over the name (which replaces a link at
   * that name, not its target), then the directory fsynced.
   * @param {string} name
   * @param {string|Buffer} data
   * @param {{mode?: number}} [options] 0600 unless a public file says otherwise
   */
  write(name, data, { mode = PRIVATE_FILE_MODE } = {}) {
    checkName(name);
    this.verify();
    const temp = this.entry(`.${name}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, mode);
    try {
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.verify();
      fs.renameSync(temp, this.entry(name));
    } catch (err) {
      try {
        fs.rmSync(temp, { force: true });
      } catch (cleanupErr) {
        console.warn(`[PrivateFiles] Could not remove ${temp}:`, cleanupErr.message);
      }
      throw err;
    }
    this.sync();
    this.verify();
  }

  /** Remove `name` (a link is removed, not its target). */
  remove(name) {
    this.verify();
    try {
      fs.unlinkSync(this.entry(name));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Open the directory `name` inside this one, owner-only, through this
   * handle.
   * @param {string} name
   * @param {{create?: boolean}} [options] create it (0700) when missing;
   *   without, a missing one is null
   * @returns {PrivateDir|null}
   * @throws {UnsafePrivatePathError} it is a link, not a directory, or not
   *   ours, or this directory changed
   */
  openDir(name, { create = true } = {}) {
    this.verify();
    if (create) {
      try {
        fs.mkdirSync(this.entry(name), { mode: PRIVATE_DIR_MODE });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    const child = openDirectory(this.entry(name), path.join(this.path, name), {
      parent: this,
      missingOk: !create,
    });
    if (child) this.children.add(child);
    return child;
  }

  sync() {
    if (!POSIX || this.fd === undefined) return;
    try {
      fs.fsyncSync(this.fd);
    } catch (err) {
      console.warn(`[PrivateFiles] Could not fsync ${this.path}:`, err.message);
    }
  }

  close() {
    if (this.closed) return;
    for (const child of this.children) child.close();
    this.closed = true;
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.parent?.children.delete(this);
  }
}

function openDirectory(
  entryPath,
  dirPath,
  { parent = null, trusted = false, missingOk = false } = {}
) {
  if (!POSIX) {
    // No directory descriptors on Windows: the object lstat finds is the
    // one every use is checked against.
    let stat;
    try {
      stat = trusted
        ? fs.statSync(entryPath, { bigint: true })
        : fs.lstatSync(entryPath, { bigint: true });
    } catch (err) {
      if (err.code === 'ENOENT' && missingOk) return null;
      throw err;
    }
    if (stat.isSymbolicLink()) throw new UnsafePrivatePathError(dirPath, 'it is a symbolic link');
    if (!stat.isDirectory()) throw new UnsafePrivatePathError(dirPath, 'not a directory');
    const dir = new PrivateDir({ dirPath, stat, parent, trusted });
    parent?.verify();
    return dir;
  }
  let fd;
  try {
    fd = fs.openSync(entryPath, O_RDONLY | DIRECTORY | NO_WAIT | (trusted ? 0 : NOFOLLOW));
  } catch (err) {
    if (err.code === 'ENOENT' && missingOk) return null;
    if (err.code === 'ELOOP') throw new UnsafePrivatePathError(dirPath, 'it is a symbolic link');
    if (err.code === 'ENOTDIR') {
      // Linux reports a link opened with O_DIRECTORY | O_NOFOLLOW this way.
      const link = fs.lstatSync(entryPath, { throwIfNoEntry: false })?.isSymbolicLink();
      throw new UnsafePrivatePathError(dirPath, link ? 'it is a symbolic link' : 'not a directory');
    }
    throw err;
  }
  try {
    const stat = checkOpened(fd, dirPath, { directory: true, owned: !trusted });
    if (!trusted) narrow(fd, stat, PRIVATE_DIR_MODE, dirPath);
    const dir = new PrivateDir({
      dirPath,
      fd,
      stat: fs.fstatSync(fd, { bigint: true }),
      parent,
      trusted,
    });
    parent?.verify();
    return dir;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

/**
 * Open a managed directory as a handle, creating it (and missing parents)
 * owner-only, or narrowing it if it exists. The directory itself must not
 * be a link; its ancestors may be (macOS's /tmp is one), since only this
 * last component is under our control.
 * @param {string} dir
 * @param {{create?: boolean, trusted?: boolean}} [options]
 *   create: when false, a missing directory is null.
 *   trusted: a directory we do not manage (userData). Links are followed,
 *   it is not narrowed and need not be ours; uses still bind to it.
 * @returns {PrivateDir|null}
 * @throws {UnsafePrivatePathError} when `dir` is a link or not a directory
 */
function openPrivateDir(dir, { create = true, trusted = false } = {}) {
  if (create && !trusted && !fs.lstatSync(dir, { throwIfNoEntry: false })) {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  return openDirectory(dir, dir, { trusted, missingOk: !create });
}

/**
 * `use(handle)` with `dir` open, closed once `use` returns or, when it
 * returns a promise, once that settles. For a write that awaits (say, key
 * encryption) between opening the directory and writing into it.
 */
function withPrivateDir(dir, use, options) {
  const handle = openPrivateDir(dir, options);
  let result;
  try {
    result = use(handle);
  } catch (err) {
    handle?.close();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(() => handle?.close());
  }
  handle?.close();
  return result;
}

// The path functions: a file directly in a directory we do not manage.
function inParent(target, use, { missing }) {
  const dir = openPrivateDir(path.dirname(target), { create: false, trusted: true });
  if (!dir) return missing();
  try {
    return use(dir, path.basename(target));
  } finally {
    dir.close();
  }
}

/**
 * Read a private file through one no-follow descriptor, repairing its mode
 * first.
 * @param {string} target
 * @returns {Buffer|null} null when it does not exist
 * @throws {UnsafePrivatePathError} a link (ELOOP), or not ours / not a file
 */
function readPrivateFile(target) {
  return inParent(target, (dir, name) => dir.read(name), { missing: () => null });
}

/**
 * Narrow an existing private file to 0600 (startup repair). A missing file
 * is fine. A link or a file that is not ours is reported and left alone.
 * @returns {boolean} whether a file was there and is now private
 */
function repairPrivateFile(target) {
  try {
    return inParent(target, (dir, name) => dir.repair(name), { missing: () => false });
  } catch (err) {
    console.warn(`[PrivateFiles] Not repairing ${target}:`, err.message);
    return false;
  }
}

/**
 * Replace `target` with `data`, owner-only (see `PrivateDir#write`).
 * @param {string} target
 * @param {string|Buffer} data
 */
function writePrivateFileSync(target, data) {
  inParent(target, (dir, name) => dir.write(name, data), {
    missing: () => {
      const err = new Error(`ENOENT: no such directory, '${path.dirname(target)}'`);
      err.code = 'ENOENT';
      throw err;
    },
  });
}

/**
 * Create `dir` (and missing parents) owner-only, or narrow it if it exists.
 * @returns {string} dir
 * @throws {UnsafePrivatePathError} when `dir` is a link or not a directory
 */
function ensurePrivateDir(dir) {
  openPrivateDir(dir).close();
  return dir;
}

/**
 * Narrow an existing private directory (startup repair); missing is fine,
 * a link or a directory that is not ours is reported and left alone.
 */
function repairPrivateDir(dir) {
  try {
    const handle = openPrivateDir(dir, { create: false });
    if (!handle) return false;
    handle.close();
    return true;
  } catch (err) {
    console.warn(`[PrivateFiles] Not repairing ${dir}:`, err.message);
    return false;
  }
}

/** Tests: run without the /proc binding, as on macOS and Windows. */
function _setFdBindingForTests(enabled) {
  fdBinding = process.platform === 'linux' && enabled;
}

module.exports = {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  PrivateDir,
  UnsafePrivatePathError,
  openPrivateDir,
  withPrivateDir,
  ensurePrivateDir,
  repairPrivateDir,
  readPrivateFile,
  repairPrivateFile,
  writePrivateFileSync,
  _setFdBindingForTests,
};
