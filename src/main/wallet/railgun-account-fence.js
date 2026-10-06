/** Cooperative account writer exclusion, held by the same main process as JSON
 * persistence. Not integrated with enrollment yet. No migration of old accounts,
 * physical utility-drain proof, rollback protection or payload storage. The
 * process-global registry survives module reload/copy. Do not read/hash its
 * inode elsewhere, including workers or a file-reading profile guard.
 *
 * run registers original work before calling it. It accepts undefined for wholly
 * synchronous work or an original native Promise; all asynchronous descendants
 * and their actual closure barriers must be covered by that original. Ordinary
 * rejection settles work. A rejected/unknown child closure must instead invoke
 * retainUntilExit before the parent settles. Enrollment integration must cover
 * every writer/owner; synchronous enrollment.close alone is NOT such a barrier.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { types } = require('util');
const threads = require('worker_threads');
const then = Promise.prototype.then;
const REGISTRY = Symbol.for('freedom.railgun.account-writer-fence.v1');
const NAME = 'writer-fence.sqlite';
const LIMIT = 65536;
const SCHEMA =
  'CREATE TABLE account_fence (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 1))';
const fail = (code = 'RAILGUN_ACCOUNT_FENCE_REFUSED') =>
  Object.assign(new Error('Railgun account writer fence unavailable'), { code });
const check = (value) => {
  if (!value) throw fail();
};
function registry() {
  if (!Object.hasOwn(process, REGISTRY))
    Object.defineProperty(process, REGISTRY, {
      value: Object.freeze({ paths: new Map(), inodes: new Map() }),
    });
  const descriptor = Object.getOwnPropertyDescriptor(process, REGISTRY);
  check(Object.hasOwn(descriptor, 'value'));
  const value = descriptor.value;
  check(value && value.paths instanceof Map && value.inodes instanceof Map);
  return value;
}
function directoryStat(directory) {
  check(typeof directory === 'string' && path.isAbsolute(directory));
  check(path.normalize(directory) === directory && fs.realpathSync(directory) === directory);
  const stat = fs.lstatSync(directory);
  check(stat.isDirectory() && !stat.isSymbolicLink());
  return stat;
}
function fileStat(filename) {
  const stat = fs.lstatSync(filename);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= LIMIT);
  return stat;
}
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
// Never open sidecars: a zero-length rollback journal is a supported result of
// EXCLUSIVE + journal_size_limit=0. Any possible recovery journal refuses.
function sidecars(filename, original) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    let stat;
    try {
      stat = fs.lstatSync(filename + suffix);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    check(
      suffix === '-journal' &&
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.size === 0 &&
        !sameFile(stat, original)
    );
  }
}
// Before SQLite opens only: closing another fd for this inode in the same
// process can release POSIX fcntl locks. Never hash/read this file while owned.
function header(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const value = Buffer.alloc(100);
    check(
      fs.readSync(fd, value, 0, value.length, 0) === value.length &&
        value.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) &&
        value[18] === 1 &&
        value[19] === 1
    );
  } finally {
    fs.closeSync(fd);
  }
}
function schema(db) {
  assert.deepEqual(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(), [
    { type: 'table', name: 'account_fence', sql: SCHEMA },
  ]);
  assert.deepEqual(db.prepare('SELECT id, version FROM account_fence').all(), [
    { id: 1, version: 1 },
  ]);
}
function openFence(options) {
  check(threads.isMainThread && (process.type === undefined || process.type === 'browser'));
  check(options && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype);
  check(Reflect.ownKeys(options).sort().join(',') === 'create,directory');
  for (const key of ['create', 'directory']) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    check(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  }
  const { directory, create } = options;
  check(typeof create === 'boolean');
  const parent = directoryStat(directory);
  const filename = path.join(directory, NAME);
  const retained = registry();
  check(!retained.paths.has(filename));
  let db, original, inode;
  const controller = new AbortController();
  let stopped = false,
    unknown = false,
    pending = 0,
    resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  // Strong ownership survives caller GC and deliberately survives unknown work.
  const owner = { database: null };
  retained.paths.set(filename, owner);
  const forget = () => {
    if (retained.paths.get(filename) === owner) retained.paths.delete(filename);
    if (retained.inodes.get(inode) === owner) retained.inodes.delete(inode);
    owner.database = null;
  };
  const identity = () => {
    check(sameFile(directoryStat(directory), parent));
    check(sameFile(fileStat(filename), original));
    sidecars(filename, original);
    check(db.open === true);
  };
  const revoke = () => {
    stopped = true;
    controller.abort();
  };
  const finish = () => {
    if (!stopped || unknown || pending) return;
    try {
      identity();
      schema(db);
      db.close();
      check(db.open === false);
      forget();
      resolveClosed();
    } catch {
      unknown = true;
    }
  };
  const retainUntilExit = () => {
    unknown = true;
    revoke();
  };
  const assertCurrent = () => {
    check(!stopped && !unknown);
    try {
      identity();
    } catch {
      retainUntilExit();
      throw fail();
    }
  };
  try {
    if (create) {
      check(fs.readdirSync(directory).length === 0);
      const fd = fs.openSync(filename, 'wx', 0o600);
      fs.closeSync(fd);
    }
    original = fileStat(filename);
    inode = `${original.dev}:${original.ino}`;
    check(!retained.inodes.has(inode));
    retained.inodes.set(inode, owner);
    sidecars(filename, original);
    if (!create) header(filename);
    const Database = require('better-sqlite3');
    db = new Database(filename, { fileMustExist: true, timeout: 0 });
    owner.database = db;
    identity();
    // Existing files are inspected before any mutating pragma or schema repair.
    check(db.pragma('journal_mode', { simple: true }) === 'delete');
    if (!create) schema(db);
    db.pragma('trusted_schema = OFF');
    db.pragma('synchronous = FULL');
    db.pragma('journal_size_limit = 0');
    check(db.pragma('journal_size_limit', { simple: true }) === 0);
    if (process.platform === 'darwin') db.pragma('fullfsync = ON');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -64');
    db.pragma('mmap_size = 0');
    db.pragma('locking_mode = EXCLUSIVE');
    check(db.pragma('locking_mode', { simple: true }) === 'exclusive');
    const pageSize = db.pragma('page_size', { simple: true });
    check(Number.isSafeInteger(pageSize) && pageSize >= 512 && pageSize <= LIMIT);
    const pages = db.pragma('max_page_count = ' + Math.floor(LIMIT / pageSize), { simple: true });
    check(Number.isSafeInteger(pages) && pages >= 1 && pages * pageSize <= LIMIT);
    db.exec('BEGIN EXCLUSIVE');
    if (create) {
      db.exec(SCHEMA);
      db.prepare('INSERT INTO account_fence (id, version) VALUES (1, 1)').run();
      db.exec('COMMIT');
      // EXCLUSIVE mode must retain ownership across commit; native qualification
      // will distinguish this from a connection that releases between writes.
      db.exec('BEGIN EXCLUSIVE');
    }
    schema(db);
    identity();
  } catch (error) {
    try {
      if (db) {
        db.close();
        check(db.open === false);
      }
      forget();
    } catch {
      unknown = true;
    }
    throw fail(
      ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code)
        ? 'RAILGUN_ACCOUNT_FENCE_BUSY'
        : undefined
    );
  }
  function close() {
    if (stopped) return;
    revoke();
    finish();
  }
  function run(callback) {
    assertCurrent();
    check(typeof callback === 'function');
    pending++;
    let result;
    try {
      result = callback();
    } catch (error) {
      pending--;
      finish();
      throw error;
    }
    if (result === undefined) {
      pending--;
      finish();
      return result;
    }
    if (!types.isPromise(result) || types.isProxy(result)) {
      retainUntilExit();
      throw fail('RAILGUN_ACCOUNT_FENCE_DRAIN_UNOBSERVED');
    }
    const settled = () => {
      pending--;
      finish();
    };
    try {
      // No result assimilation or overridden then call; fulfillment is ignored.
      then.call(result, settled, settled);
    } catch {
      retainUntilExit();
      throw fail('RAILGUN_ACCOUNT_FENCE_DRAIN_UNOBSERVED');
    }
    return result;
  }
  return Object.freeze({
    signal: controller.signal,
    closed,
    run,
    assertCurrent,
    close,
    retainUntilExit,
  });
}
function openRailgunAccountFence(options) {
  try {
    return openFence(options);
  } catch (error) {
    throw fail(error.code === 'RAILGUN_ACCOUNT_FENCE_BUSY' ? error.code : undefined);
  }
}
module.exports = { openRailgunAccountFence };
