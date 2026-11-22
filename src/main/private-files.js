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
 *    through that descriptor. A managed directory that is a link, not
 *    ours, or not owner-only once narrowed, is refused, so a caller stops
 *    instead of using it.
 *  - Every read, repair, temp-file creation and rename of a file in it goes
 *    through the handle. Each use is bracketed by a check that every
 *    managed component from the root down is still the directory the handle
 *    opened (same device and inode, still not a link). A change refuses the
 *    use. That bracket says what the path names at each check, not what an
 *    open in between used, so each platform binds the open itself:
 *      - Linux: the handle names its entries `/proc/self/fd/<fd>/<name>`,
 *        which the kernel resolves inside the directory the descriptor
 *        holds, whatever the pathname points at by then: openat(2) for a
 *        runtime that has none, and the binding holds across awaits.
 *        Without /proc the handle refuses every entry rather than fall back
 *        to the path.
 *      - macOS: every open carries O_NOFOLLOW_ANY (macOS 11+), so a link
 *        anywhere in the path is refused. The handle opens the resolved
 *        path (trusted ancestors such as /var -> /private/var resolved once,
 *        when it is opened), which has none. A managed directory swapped for
 *        a link, even briefly, fails the open.
 *      - Windows: the bracket alone. A directory junction needs no
 *        privilege, so a local process that can write inside the profile
 *        (this account, or an administrator) could swap a managed directory
 *        and swap it back between the check and the open. It can read the
 *        keys directly anyway. Handle-relative I/O there needs native code:
 *        #963.
 *  - Files are opened with O_NOFOLLOW (O_NOFOLLOW_ANY on macOS) |
 *    O_NONBLOCK | O_NOCTTY, so a FIFO or
 *    device at the name cannot block or act on the open. The name is
 *    lstat'ed first and must not be a link (Windows has no O_NOFOLLOW: an
 *    ordinary open there follows a link to its target). The opened
 *    descriptor must be that same object, a regular file this account
 *    owns, before any I/O. It is then narrowed to 0600 (a file still open
 *    to other accounts after that is refused) and read through.
 *  - Writes create an exclusive temp file (O_CREAT | O_EXCL | O_NOFOLLOW,
 *    0600) in the directory, fsync it and rename it over the name. A rename
 *    replaces a link itself, never its target.
 *  - Listing a directory (`entries`) and removing an empty directory in it
 *    (`removeDir`) go through the handle too, descriptor-relative on Linux
 *    (`/proc/self/fd/<fd>`). Node has no fdopendir or unlinkat, so on macOS
 *    and Windows a listing is done by path, bracketed by the check before
 *    and after and refused if either fails, and a directory removal is
 *    refused outright, never done by path (#963).
 *
 * Ancestors above a managed root (the profile's userData, macOS's /tmp) may
 * be links: they are not ours to manage. The path functions
 * (`readPrivateFile`, `repairPrivateFile`, `writePrivateFileSync`) are for
 * files directly in such a directory (`<userData>/rpc-api-keys.json`). They
 * bind the same way to that directory, with its links followed.
 *
 * POSIX only for modes and ownership: on Windows the files inherit the user
 * profile directory's ACL, so there the helpers do the plain open, write and
 * rename, with the same checks, and still refuse anything that is not a
 * regular file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PLATFORM = process.platform;
const POSIX = PLATFORM !== 'win32';
const LINUX = PLATFORM === 'linux';
const DARWIN = PLATFORM === 'darwin';
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
const NOFOLLOW = POSIX ? fs.constants.O_NOFOLLOW : 0;
const DIRECTORY = POSIX ? fs.constants.O_DIRECTORY : 0;
// Opening a FIFO for reading waits for a writer, and opening a terminal can
// make it the controlling one. With these the open returns at once, so the
// descriptor's type is checked before anything else.
const NO_WAIT = POSIX ? fs.constants.O_NONBLOCK | (fs.constants.O_NOCTTY || 0) : 0;
// macOS 11+, <sys/fcntl.h>: no symbolic link anywhere in the path. Node has
// no constant for it and passes open flags to open(2) unchanged.
const NOFOLLOW_ANY = DARWIN ? (fs.constants.O_NOFOLLOW_ANY ?? 0x20000000) : 0;
// The no-link flag for every open: O_NOFOLLOW_ANY on macOS, which refuses
// the final component too (and is EINVAL together with O_NOFOLLOW,
// xnu vn_open_auth), O_NOFOLLOW elsewhere.
const NO_LINKS = DARWIN ? NOFOLLOW_ANY : NOFOLLOW;

// Linux's /proc/self/fd/<fd> binding. Off in tests that check a Linux
// without it refuses.
let fdBinding = LINUX;
// Directory listing by path, bracketed, and no directory removal (macOS,
// Windows). Linux tests turn it on to exercise that there.
let dirOpsByPath = !LINUX;

class UnsafePrivatePathError extends Error {
  constructor(target, why) {
    super(`Refusing ${target}: ${why}`);
    this.name = 'UnsafePrivatePathError';
    this.code = 'UNSAFE_PRIVATE_PATH';
  }
}

const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;

// The checks, over what a stat or an open reported, shared by the
// synchronous opens and ensurePrivateDirAsync so both judge alike.

// Why `stat`'s object can't be used as a private directory (`directory`) or
// file, or null: a link (a Windows lstat's; a descriptor's fstat never is
// one), the wrong kind, or, when `owned`, another account's (POSIX).
function statRefusal(stat, target, { directory = false, owned = true } = {}) {
  if (stat.isSymbolicLink()) return new UnsafePrivatePathError(target, 'it is a symbolic link');
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    return new UnsafePrivatePathError(target, directory ? 'not a directory' : 'not a regular file');
  }
  if (
    owned &&
    POSIX &&
    typeof process.getuid === 'function' &&
    Number(stat.uid) !== process.getuid()
  ) {
    return new UnsafePrivatePathError(target, 'owned by another account');
  }
  return null;
}

// Whether group or other have any access (POSIX): what narrowing changes.
function openToOthers(stat) {
  return POSIX && (Number(stat.mode) & 0o077) !== 0;
}

// Why a narrowing failed, or null: the fchmod threw `error`, or `stat`,
// read after it, is still open to other accounts.
function narrowRefusal(target, { error = null, stat = null }) {
  if (error) {
    return new UnsafePrivatePathError(target, `could not make it owner-only (${error.message})`);
  }
  if (openToOthers(stat)) {
    return new UnsafePrivatePathError(
      target,
      'its mode is still open to other accounts after narrowing'
    );
  }
  return null;
}

// What a failed no-follow directory open throws: a link's refusal for
// ELOOP; for ENOTDIR, a link's or a non-directory's (`link`: whether lstat
// finds a link at the name, as Linux reports a link opened with
// O_DIRECTORY | O_NOFOLLOW this way); any other error as it is.
function openDirRefusal(err, dirPath, link) {
  if (err.code === 'ELOOP') return linkRefusal(dirPath);
  if (err.code === 'ENOTDIR') {
    return new UnsafePrivatePathError(dirPath, link ? 'it is a symbolic link' : 'not a directory');
  }
  return err;
}

// An object opened through a descriptor: the right kind, and ours.
function checkOpened(fd, target, options) {
  const stat = fs.fstatSync(fd);
  const refusal = statRefusal(stat, target, options);
  if (refusal) throw refusal;
  return stat;
}

// Only when group or other have any access: an owner-only mode (0400, say)
// is left as it is. A mode that stays open to other accounts refuses the
// use, so the caller stops rather than going on with it: the fchmod failed,
// or it succeeded without effect, as on a file system that ignores modes.
function narrow(fd, stat, mode, target) {
  if (!openToOthers(stat)) return;
  try {
    fs.fchmodSync(fd, mode);
  } catch (err) {
    throw narrowRefusal(target, { error: err });
  }
  const refusal = narrowRefusal(target, { stat: fs.fstatSync(fd) });
  if (refusal) throw refusal;
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
  constructor({ dirPath, ioPath, fd, stat, parent, trusted }) {
    this.path = dirPath;
    // The path every check and (unbound) open uses: on macOS the resolved
    // one, with no link in it.
    this.ioPath = ioPath;
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
    if (this.bound && fdBinding) return `/proc/self/fd/${this.fd}/${name}`;
    if (LINUX) {
      throw new UnsafePrivatePathError(
        path.join(this.path, name),
        'no /proc/self/fd binding to its directory is available'
      );
    }
    return path.join(this.ioPath, name);
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
        ? fs.statSync(this.ioPath, { bigint: true })
        : fs.lstatSync(this.ioPath, { bigint: true });
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
    const entry = this.entry(name);
    // What the name is before the open. Windows has no O_NOFOLLOW, so this
    // is where a link at the name is refused there; the identity check
    // below refuses one swapped in after it.
    const seen = fs.lstatSync(entry, { bigint: true, throwIfNoEntry: false });
    if (!seen) return null;
    if (seen.isSymbolicLink()) throw new UnsafePrivatePathError(target, 'it is a symbolic link');
    let fd;
    try {
      fd = fs.openSync(entry, O_RDONLY | NO_LINKS | NO_WAIT);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (err.code === 'ELOOP') throw linkRefusal(target);
      if (err.code === 'ENXIO' || err.code === 'EISDIR') {
        throw new UnsafePrivatePathError(target, 'not a regular file');
      }
      throw err;
    }
    try {
      if (!sameObject(fs.fstatSync(fd, { bigint: true }), seen)) {
        throw new UnsafePrivatePathError(target, 'it changed while being opened');
      }
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
   *   could not be narrowed, or this directory changed
   */
  read(name) {
    return this.withFile(name, (fd) => fs.readFileSync(fd));
  }

  /**
   * The check before a node is handed a key it reads by path. Missing is
   * fine: the node or the core creates it. One that is there must be a
   * regular file this account owns, and is narrowed to 0600.
   * @returns {boolean} whether the file is there
   * @throws {UnsafePrivatePathError} it is there but a link, not a regular
   *   file, not ours or could not be narrowed, or this directory changed
   */
  requirePrivate(name) {
    return this.withFile(name, () => true) === true;
  }

  /**
   * Narrow an existing file to 0600 (startup repair). Missing is fine; a
   * link, a file that is not ours or one that could not be narrowed is
   * reported and left alone. Not for a key a node is about to read: a
   * refusal here does not stop anything (`requirePrivate` does).
   * @returns {boolean} whether a file was there and is now private
   */
  repair(name) {
    try {
      return this.requirePrivate(name);
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
    let fd;
    try {
      fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | NO_LINKS, mode);
    } catch (err) {
      if (err.code === 'ELOOP') throw linkRefusal(path.join(this.path, name));
      throw err;
    }
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

  // This directory itself, as the kernel should resolve it: the descriptor
  // on Linux, the opened path elsewhere.
  self() {
    if (dirOpsByPath) return this.ioPath;
    if (this.bound && fdBinding) return `/proc/self/fd/${this.fd}`;
    throw new UnsafePrivatePathError(this.path, 'no /proc/self/fd binding to it is available');
  }

  /**
   * The names in this directory: through the descriptor on Linux; by path
   * elsewhere, refused if the directory changed before or after (#963).
   * @returns {string[]}
   * @throws {UnsafePrivatePathError}
   */
  entries() {
    this.verify();
    const names = fs.readdirSync(this.self());
    this.verify();
    return names;
  }

  /**
   * Remove the empty directory `name` in this one, through the descriptor
   * (Linux). A link at the name is refused (rmdir does not follow it),
   * never its target removed. Without a descriptor-relative removal (macOS,
   * Windows: Node has no unlinkat) it is refused, never done by path
   * (#963).
   * @returns {boolean} false when there was none
   * @throws {UnsafePrivatePathError}
   */
  removeDir(name) {
    checkName(name);
    // Never by path: a directory swapped in between the check and the
    // rmdir could lose an empty directory of the same name before the
    // check after it refused (#963).
    if (dirOpsByPath || !(this.bound && fdBinding)) {
      throw new UnsafePrivatePathError(
        path.join(this.path, name),
        'no descriptor-relative directory removal on this platform (#963)'
      );
    }
    this.verify();
    try {
      fs.rmdirSync(this.entry(name));
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
    this.verify();
    return true;
  }

  /**
   * Open the directory `name` inside this one, owner-only, through this
   * handle.
   * @param {string} name
   * @param {{create?: boolean}} [options] create it (0700) when missing;
   *   without, a missing one is null
   * @returns {PrivateDir|null}
   * @throws {UnsafePrivatePathError} it is a link, not a directory, not
   *   ours, or could not be narrowed, or this directory changed
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
      ioPath: path.join(this.ioPath, name),
      parent: this,
      missingOk: !create,
    });
    if (child) this.children.add(child);
    return child;
  }

  /**
   * fsync this directory, so a change to its entries lasts. A failure is
   * logged, unless `required`: then it is thrown, for a caller whose next
   * step must wait until the change is durable. Windows has no directory
   * descriptor, so there is nothing to sync there.
   * @param {{required?: boolean}} [options]
   */
  sync({ required = false } = {}) {
    if (!POSIX || this.fd === undefined) return;
    try {
      fs.fsyncSync(this.fd);
    } catch (err) {
      if (required) throw err;
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

function linkRefusal(target) {
  return new UnsafePrivatePathError(
    target,
    DARWIN ? 'a symbolic link is in its path' : 'it is a symbolic link'
  );
}

// `entryPath` is what to open: the parent handle's entry for a child, the
// directory's own (on macOS, resolved) path for a root. `ioPath` is the
// path later checks use.
function openDirectory(
  entryPath,
  dirPath,
  { ioPath = entryPath, parent = null, trusted = false, missingOk = false } = {}
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
    const refusal = statRefusal(stat, dirPath, { directory: true, owned: !trusted });
    if (refusal) throw refusal;
    const dir = new PrivateDir({ dirPath, ioPath, stat, parent, trusted });
    parent?.verify();
    return dir;
  }
  let fd;
  try {
    fd = fs.openSync(
      entryPath,
      // A trusted directory may be reached through links, except on macOS,
      // where its path was resolved and carries none.
      O_RDONLY | DIRECTORY | NO_WAIT | (trusted && !DARWIN ? 0 : NO_LINKS)
    );
  } catch (err) {
    if (err.code === 'ENOENT' && missingOk) return null;
    const link =
      err.code === 'ENOTDIR' &&
      fs.lstatSync(entryPath, { throwIfNoEntry: false })?.isSymbolicLink();
    throw openDirRefusal(err, dirPath, link);
  }
  try {
    const stat = checkOpened(fd, dirPath, { directory: true, owned: !trusted });
    if (!trusted) narrow(fd, stat, PRIVATE_DIR_MODE, dirPath);
    const dir = new PrivateDir({
      dirPath,
      ioPath,
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
 * @throws {UnsafePrivatePathError} when `dir` is a link, not a directory,
 *   not ours, or could not be made owner-only
 */
function openPrivateDir(dir, { create = true, trusted = false } = {}) {
  if (create && !trusted && !fs.lstatSync(dir, { throwIfNoEntry: false })) {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  let ioPath = dir;
  if (DARWIN) {
    // O_NOFOLLOW_ANY refuses a link anywhere in the path, so resolve the
    // ancestors we do not manage now: all of a trusted directory, and the
    // parent of a managed one, whose own last component must not be a link.
    try {
      ioPath = trusted
        ? fs.realpathSync(dir)
        : path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
    } catch (err) {
      if (err.code === 'ENOENT' && !create) return null;
      throw err;
    }
  }
  return openDirectory(ioPath, dir, { ioPath, trusted, missingOk: !create });
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
 * @throws {UnsafePrivatePathError} a link (ELOOP), not ours, not a file,
 *   or could not be narrowed
 */
function readPrivateFile(target) {
  return inParent(target, (dir, name) => dir.read(name), { missing: () => null });
}

/**
 * Narrow an existing private file to 0600 (startup repair). A missing file
 * is fine. A link, a file that is not ours or one that could not be
 * narrowed is reported and left alone; a later read refuses it.
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
 * @throws {UnsafePrivatePathError} when `dir` is a link, not a directory,
 *   not ours, or could not be made owner-only
 */
function ensurePrivateDir(dir) {
  openPrivateDir(dir).close();
  return dir;
}

/**
 * `ensurePrivateDir`, for a caller that must not block main's event loop on
 * a stalled file system (core/core-process.js's bounded wait for the
 * Radicle home): each probe is an `fs.promises` call, run on libuv's thread
 * pool, so a stalled one holds a pool thread, not the event loop. The same
 * opens (no-follow, O_DIRECTORY), the same checks (`statRefusal`,
 * `narrowRefusal`, `openDirRefusal`) and the same narrowing, through the
 * descriptor.
 * @returns {Promise<string>} dir
 * @throws {UnsafePrivatePathError} as `ensurePrivateDir`
 */
async function ensurePrivateDirAsync(dir) {
  const lstatOrNull = (target) =>
    fs.promises.lstat(target).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
  if (!(await lstatOrNull(dir))) {
    await fs.promises.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  // On macOS, the managed directory's parent resolved, as openPrivateDir
  // resolves it.
  const ioPath = DARWIN
    ? path.join(await fs.promises.realpath(path.dirname(dir)), path.basename(dir))
    : dir;
  if (!POSIX) {
    const refusal = statRefusal(await fs.promises.lstat(ioPath, { bigint: true }), dir, {
      directory: true,
    });
    if (refusal) throw refusal;
    return dir;
  }
  let handle;
  try {
    handle = await fs.promises.open(ioPath, O_RDONLY | DIRECTORY | NO_WAIT | NO_LINKS);
  } catch (err) {
    const link = err.code === 'ENOTDIR' && (await lstatOrNull(ioPath))?.isSymbolicLink();
    throw openDirRefusal(err, dir, link);
  }
  try {
    const stat = await handle.stat();
    const refusal = statRefusal(stat, dir, { directory: true });
    if (refusal) throw refusal;
    if (openToOthers(stat)) {
      try {
        await handle.chmod(PRIVATE_DIR_MODE);
      } catch (err) {
        throw narrowRefusal(dir, { error: err });
      }
      const narrowed = narrowRefusal(dir, { stat: await handle.stat() });
      if (narrowed) throw narrowed;
    }
  } finally {
    await handle.close();
  }
  return dir;
}

/**
 * Narrow an existing private directory (startup repair); missing is fine,
 * a link, a directory that is not ours or one that could not be narrowed
 * is reported and left alone.
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

/** Tests: a Linux handle without its /proc binding, which refuses entries. */
function _setFdBindingForTests(enabled) {
  fdBinding = LINUX && enabled;
}

/** Tests: list by path, bracketed, and refuse directory removal, as on macOS and Windows. */
function _setDirOpsByPathForTests(enabled) {
  dirOpsByPath = enabled || !LINUX;
}

module.exports = {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  PrivateDir,
  UnsafePrivatePathError,
  openPrivateDir,
  withPrivateDir,
  ensurePrivateDir,
  ensurePrivateDirAsync,
  repairPrivateDir,
  readPrivateFile,
  repairPrivateFile,
  writePrivateFileSync,
  _setFdBindingForTests,
  _setDirOpsByPathForTests,
};
