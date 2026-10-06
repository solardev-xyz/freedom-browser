const fs = require('fs');
const os = require('os');
const path = require('path');
let mockConnections,
  mockRecords,
  mockOpenError,
  mockCloseError,
  mockBeforeOpen,
  mockMainThread,
  mockCommitHook;
jest.mock('worker_threads', () => ({
  get isMainThread() {
    return mockMainThread;
  },
}));
const mockSchema =
  'CREATE TABLE account_fence (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 1))';
jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation((filename, options) => {
    if (mockBeforeOpen) mockBeforeOpen(filename);
    if (mockOpenError) throw mockOpenError;
    const record = mockRecords.get(filename) || { schema: [], rows: [], mode: 'delete' };
    mockRecords.set(filename, record);
    let locking = 'normal',
      journalLimit = -1;
    const db = {
      open: true,
      filename,
      options,
      calls: [],
      pragma(sql, options) {
        this.calls.push(['pragma', sql, options]);
        if (sql === 'journal_mode') return record.mode;
        if (sql === 'journal_size_limit = 0') journalLimit = 0;
        if (sql === 'journal_size_limit') return journalLimit;
        if (sql === 'locking_mode = EXCLUSIVE') locking = 'exclusive';
        if (sql === 'locking_mode') return locking;
        if (sql === 'page_size') return 4096;
        if (sql.startsWith('max_page_count = ')) return Number(sql.split(' = ')[1]);
      },
      exec(sql) {
        this.calls.push(['exec', sql]);
        if (sql === mockSchema)
          record.schema = [{ type: 'table', name: 'account_fence', sql: mockSchema }];
        if (sql === 'COMMIT') {
          const bytes = Buffer.alloc(4096);
          Buffer.from('SQLite format 3\0').copy(bytes);
          bytes[18] = bytes[19] = 1;
          require('fs').writeFileSync(filename, bytes);
          require('fs').writeFileSync(filename + '-journal', '');
          mockCommitHook?.(filename);
        }
      },
      prepare(sql) {
        this.calls.push(['prepare', sql]);
        return {
          all: () => (sql.includes('sqlite_master') ? record.schema : record.rows),
          run: () => {
            record.rows = [{ id: 1, version: 1 }];
          },
        };
      },
      close: jest.fn(function () {
        if (mockCloseError) throw mockCloseError;
        this.open = false;
      }),
    };
    mockConnections.push(db);
    return db;
  })
);
const { openRailgunAccountFence } = require('./railgun-account-fence');
const Database = require('better-sqlite3');
let directory;
const filename = () => path.join(directory, 'writer-fence.sqlite');
const open = (create = true) => openRailgunAccountFence({ directory, create });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const pending = async (promise) => {
  let settled = false;
  Promise.prototype.then.call(
    promise,
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
};
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-fence-unit-')));
  mockMainThread = true;
  mockConnections = [];
  mockRecords = new Map();
  mockOpenError = mockCloseError = mockBeforeOpen = mockCommitHook = undefined;
  Database.mockClear();
});
// Unknown cases intentionally retain their mocked connection for process lifetime.
// No native SQLite binding or wallet/profile/engine is loaded by these tests.
test('fixed main connection, bounded schema and initialization commit precede use', async () => {
  const fence = open(),
    db = mockConnections[0];
  expect(Object.keys(fence).sort()).toEqual([
    'assertCurrent',
    'close',
    'closed',
    'retainUntilExit',
    'run',
    'signal',
  ]);
  expect(Object.isFrozen(fence)).toBe(true);
  expect(db.options).toEqual({ fileMustExist: true, timeout: 0 });
  expect(db.filename).toBe(filename());
  expect(db.calls.filter(([kind]) => kind === 'exec').map((v) => v[1])).toEqual([
    'BEGIN EXCLUSIVE',
    mockSchema,
    'COMMIT',
    'BEGIN EXCLUSIVE',
  ]);
  expect(db.calls).toContainEqual(['pragma', 'locking_mode = EXCLUSIVE', undefined]);
  expect(db.calls).toContainEqual(['pragma', 'max_page_count = 16', { simple: true }]);
  expect(db.open).toBe(true);
  expect(fence.run(() => undefined)).toBeUndefined();
  fence.assertCurrent();
  fence.close();
  await fence.closed;
  expect(fence.signal.aborted).toBe(true);
  expect(db.close).toHaveBeenCalledTimes(1);
  fence.close();
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(() => fence.assertCurrent()).toThrow();
});
test('cooperative reopen validates schema before mutating pragmas and reuses same file', async () => {
  const first = open();
  first.close();
  await first.closed;
  const stat = fs.statSync(filename());
  const second = open(false),
    db = mockConnections[1];
  expect(db.calls.slice(0, 3).map((v) => v[1])).toEqual([
    'journal_mode',
    'SELECT type, name, sql FROM sqlite_master ORDER BY name',
    'SELECT id, version FROM account_fence',
  ]);
  expect(db.calls.filter(([kind]) => kind === 'exec').map((v) => v[1])).toEqual([
    'BEGIN EXCLUSIVE',
  ]);
  expect(fs.statSync(filename()).ino).toBe(stat.ino);
  second.close();
  await second.closed;
});
test('live same-process owner refuses a second opener before another connection', async () => {
  const fence = open();
  expect(() => open(false)).toThrow();
  expect(Database).toHaveBeenCalledTimes(1);
  fence.close();
  await fence.closed;
});
test('revoke during original callback holds connection through original settlement', async () => {
  const fence = open(),
    work = deferred(),
    value = Object.freeze({ done: true });
  const original = fence.run(() => {
    fence.close();
    return work.promise;
  });
  expect(original).toBe(work.promise);
  expect(fence.signal.aborted).toBe(true);
  expect(mockConnections[0].close).not.toHaveBeenCalled();
  expect(() => fence.run(() => undefined)).toThrow();
  await pending(fence.closed);
  work.resolve(value);
  expect(await original).toBe(value);
  await fence.closed;
  expect(mockConnections[0].close).toHaveBeenCalledTimes(1);
});
test('all registered originals settle before release, including nested admission', async () => {
  const fence = open(),
    outer = deferred(),
    inner = deferred();
  fence.run(() => {
    expect(fence.run(() => inner.promise)).toBe(inner.promise);
    return outer.promise;
  });
  fence.close();
  outer.resolve();
  await outer.promise;
  await pending(fence.closed);
  expect(mockConnections[0].close).not.toHaveBeenCalled();
  inner.resolve();
  await fence.closed;
  expect(mockConnections[0].close).toHaveBeenCalledTimes(1);
});
test('ordinary asynchronous rejection is observed settlement and preserves error identity', async () => {
  const fence = open(),
    work = deferred(),
    error = new Error('ordinary failure');
  const original = fence.run(() => work.promise);
  fence.close();
  work.reject(error);
  await expect(original).rejects.toBe(error);
  await fence.closed;
  expect(mockConnections[0].close).toHaveBeenCalledTimes(1);
});
test('synchronous callback failure preserves identity, including close inside callback', async () => {
  const fence = open(),
    error = new Error('synchronous');
  expect(() =>
    fence.run(() => {
      fence.close();
      throw error;
    })
  ).toThrow(error);
  await fence.closed;
  expect(mockConnections[0].close).toHaveBeenCalledTimes(1);
});
test('intrinsic observer never reads an overridden then or fulfillment then getter', async () => {
  const fence = open(),
    work = deferred(),
    value = {};
  let reads = 0;
  work.resolve(value);
  Object.defineProperty(value, 'then', {
    get() {
      reads++;
      throw Error('assimilation');
    },
  });
  Object.defineProperty(work.promise, 'then', {
    get() {
      reads++;
      throw Error('override');
    },
  });
  expect(fence.run(() => work.promise)).toBe(work.promise);
  fence.close();
  await fence.closed;
  expect(reads).toBe(0);
});
test.each(['constructor', 'species'])(
  'unobservable original %s retains strong ownership until exit',
  async (kind) => {
    const fence = open(),
      work = deferred();
    if (kind === 'constructor')
      Object.defineProperty(work.promise, 'constructor', {
        get() {
          throw Error('constructor');
        },
      });
    else
      Object.defineProperty(work.promise, 'constructor', {
        value: {
          get [Symbol.species]() {
            throw Error('species');
          },
        },
      });
    expect(() => fence.run(() => work.promise)).toThrow(
      expect.objectContaining({ code: 'RAILGUN_ACCOUNT_FENCE_DRAIN_UNOBSERVED' })
    );
    work.resolve();
    fence.close();
    await pending(fence.closed);
    expect(mockConnections[0].close).not.toHaveBeenCalled();
    expect(() => open(false)).toThrow();
  }
);
test('unknown actual task closure explicitly quarantines before parent rejection settles', async () => {
  const fence = open(),
    work = deferred(),
    error = new Error('unknown task exit');
  const original = fence.run(() => work.promise);
  fence.retainUntilExit();
  work.reject(error);
  await expect(original).rejects.toBe(error);
  fence.close();
  await pending(fence.closed);
  expect(mockConnections[0].close).not.toHaveBeenCalled();
  expect(() => open(false)).toThrow();
});
test('invalid thenable is never invoked and cannot claim original drainage', async () => {
  const fence = open();
  let calls = 0;
  const thenable = {
    get then() {
      calls++;
      throw Error('must not read');
    },
  };
  expect(() => fence.run(() => thenable)).toThrow();
  expect(calls).toBe(0);
  await pending(fence.closed);
  expect(mockConnections[0].close).not.toHaveBeenCalled();
});
test('failed database close retains exclusion rather than resolving closed', async () => {
  const fence = open();
  mockCloseError = Error('close failed');
  fence.close();
  await pending(fence.closed);
  expect(() => open(false)).toThrow();
  expect(mockConnections[0].open).toBe(true);
});
test('connection and directory/file identity are rechecked before admission', async () => {
  const fence = open();
  fs.renameSync(filename(), path.join(directory, 'preserved-original.sqlite'));
  fs.writeFileSync(filename(), Buffer.alloc(4096));
  expect(() => fence.run(() => undefined)).toThrow();
  expect(fence.signal.aborted).toBe(true);
  await pending(fence.closed);
  expect(mockConnections[0].close).not.toHaveBeenCalled();
});
test('replacement discovered at final settlement prevents release claim', async () => {
  const fence = open(),
    work = deferred();
  fence.run(() => work.promise);
  fence.close();
  fs.renameSync(filename(), path.join(directory, 'old.sqlite'));
  fs.writeFileSync(filename(), Buffer.alloc(4096));
  work.resolve();
  await work.promise;
  await pending(fence.closed);
  expect(mockConnections[0].close).not.toHaveBeenCalled();
});
test.each(['payload', 'existing-empty-file'])(
  'fresh creation refuses %s without native open',
  (kind) => {
    fs.writeFileSync(
      path.join(directory, kind === 'payload' ? 'existing.json' : 'writer-fence.sqlite'),
      ''
    );
    expect(() => open()).toThrow();
    expect(Database).not.toHaveBeenCalled();
  }
);
test('missing cooperative fence is not implicitly created', () => {
  expect(() => open(false)).toThrow();
  expect(fs.readdirSync(directory)).toEqual([]);
  expect(Database).not.toHaveBeenCalled();
});
test.each(['wal-header', 'empty', 'oversized', 'symlink', 'hardlink'])(
  'existing %s refuses before native open',
  async (kind) => {
    const fence = open();
    fence.close();
    await fence.closed;
    Database.mockClear();
    if (kind === 'wal-header') {
      const data = fs.readFileSync(filename());
      data[18] = 2;
      fs.writeFileSync(filename(), data);
    }
    if (kind === 'empty') fs.writeFileSync(filename(), '');
    if (kind === 'oversized') fs.writeFileSync(filename(), Buffer.alloc(65537));
    if (kind === 'hardlink') fs.linkSync(filename(), path.join(directory, 'alias.sqlite'));
    if (kind === 'symlink') {
      fs.renameSync(filename(), path.join(directory, 'real.sqlite'));
      fs.symlinkSync('real.sqlite', filename());
    }
    expect(() => open(false)).toThrow();
    expect(Database).not.toHaveBeenCalled();
  }
);
test.each(['mode', 'schema', 'version', 'extra-row'])(
  'wrong existing %s is refused without mutating pragmas',
  async (kind) => {
    const fence = open();
    fence.close();
    await fence.closed;
    const record = mockRecords.get(filename());
    if (kind === 'mode') record.mode = 'wal';
    if (kind === 'schema') record.schema = [];
    if (kind === 'version') record.rows[0].version = 2;
    if (kind === 'extra-row') record.rows.push({ id: 2, version: 1 });
    expect(() => open(false)).toThrow();
    const db = mockConnections[1];
    expect(
      db.calls.some(([kind, sql]) => kind === 'exec' || (kind === 'pragma' && sql.includes('=')))
    ).toBe(false);
    expect(db.close).toHaveBeenCalledTimes(1);
  }
);
test('directory aliases and accessor options never create a connection', () => {
  const alias = directory + '-alias';
  fs.symlinkSync(directory, alias);
  expect(() => openRailgunAccountFence({ directory: alias, create: true })).toThrow();
  let calls = 0;
  expect(() =>
    openRailgunAccountFence({
      get directory() {
        calls++;
        return directory;
      },
      create: true,
    })
  ).toThrow();
  expect(calls).toBe(0);
  expect(Database).not.toHaveBeenCalled();
});
test.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CORRUPT'])(
  'native %s is sanitized and incomplete files are preserved',
  (code) => {
    mockOpenError = Object.assign(Error('private path'), { code });
    expect(() => open()).toThrow(
      expect.objectContaining({
        code:
          code === 'SQLITE_CORRUPT'
            ? 'RAILGUN_ACCOUNT_FENCE_REFUSED'
            : 'RAILGUN_ACCOUNT_FENCE_BUSY',
      })
    );
    expect(fs.existsSync(filename())).toBe(true);
  }
);
test('path replacement while opening closes that unadopted connection and refuses', () => {
  mockBeforeOpen = (file) => {
    fs.renameSync(file, path.join(directory, 'preserved.sqlite'));
    fs.writeFileSync(file, '');
  };
  expect(() => open()).toThrow();
  expect(mockConnections[0].close).toHaveBeenCalledTimes(1);
});

test('schema change at release retains ownership and leaves closed pending', async () => {
  const fence = open();
  mockRecords.get(filename()).rows[0].version = 2;
  fence.close();
  await pending(fence.closed);
  expect(mockConnections[0].close).not.toHaveBeenCalled();
  expect(() => open(false)).toThrow();
});

test('worker-thread and Electron utility ownership refuse before touching the directory', () => {
  mockMainThread = false;
  expect(() => open()).toThrow();
  mockMainThread = true;
  const previous = Object.getOwnPropertyDescriptor(process, 'type');
  Object.defineProperty(process, 'type', { value: 'utility', configurable: true });
  try {
    expect(() => open()).toThrow();
  } finally {
    if (previous) Object.defineProperty(process, 'type', previous);
    else delete process.type;
  }
  expect(fs.readdirSync(directory)).toEqual([]);
  expect(Database).not.toHaveBeenCalled();
});
test('pre-open filesystem errors are sanitized without a private pathname', () => {
  let error;
  try {
    openRailgunAccountFence({
      directory: path.join(directory, 'missing-private-directory'),
      create: false,
    });
  } catch (caught) {
    error = caught;
  }
  expect(error.code).toBe('RAILGUN_ACCOUNT_FENCE_REFUSED');
  expect(error.message).toBe('Railgun account writer fence unavailable');
  expect(Database).not.toHaveBeenCalled();
});

test('no header descriptor is opened while SQLite owns the fence', async () => {
  const original = fs.openSync;
  const readDuringOwnership = [];
  const spy = jest.spyOn(fs, 'openSync').mockImplementation((file, flags, ...rest) => {
    if (file === filename() && flags === 'r' && mockConnections.some((db) => db.open))
      readDuringOwnership.push(file);
    return original(file, flags, ...rest);
  });
  try {
    const first = open();
    first.assertCurrent();
    first.close();
    await first.closed;
    const second = open(false);
    second.assertCurrent();
    second.close();
    await second.closed;
    expect(readDuringOwnership).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test.each(['same-path', 'renamed-directory'])(
  'a second module copy refuses %s before header or SQLite open',
  async (variant) => {
    const fence = open();
    if (variant === 'renamed-directory') {
      const moved = directory + '-moved';
      fs.renameSync(directory, moved);
      directory = moved;
    }
    let second;
    jest.isolateModules(() => {
      second = require('./railgun-account-fence').openRailgunAccountFence;
    });
    const headerRead = jest.spyOn(fs, 'readSync');
    const before = mockConnections.length;
    try {
      expect(() => second({ directory, create: false })).toThrow();
      expect(headerRead).not.toHaveBeenCalled();
      expect(mockConnections).toHaveLength(before);
      expect(mockConnections[0].close).not.toHaveBeenCalled();
    } finally {
      headerRead.mockRestore();
    }
    if (variant === 'same-path') {
      fence.close();
      await fence.closed;
    } else {
      fence.retainUntilExit();
      await pending(fence.closed);
    }
  }
);

test('zero-length regular journal is admitted and its zero limit is set and verified', async () => {
  const first = open(),
    db = mockConnections[0];
  expect(db.calls).toContainEqual(['pragma', 'journal_size_limit = 0', undefined]);
  expect(db.calls).toContainEqual(['pragma', 'journal_size_limit', { simple: true }]);
  expect(fs.lstatSync(filename() + '-journal').size).toBe(0);
  first.close();
  await first.closed;
  const second = open(false);
  second.close();
  await second.closed;
});
test.each([
  'nonempty-journal',
  'directory-journal',
  'symlink-journal',
  'dangling-journal',
  'hardlink-journal',
  'wal',
  'shm',
])('existing %s refuses before any header or native database open', async (kind) => {
  const first = open();
  first.close();
  await first.closed;
  const journal = filename() + '-journal';
  if (kind === 'nonempty-journal') fs.writeFileSync(journal, 'possible recovery');
  if (kind.endsWith('-journal') && kind !== 'nonempty-journal') {
    fs.renameSync(journal, journal + '.preserved');
    if (kind === 'directory-journal') fs.mkdirSync(journal);
    if (kind === 'symlink-journal') fs.symlinkSync(journal + '.preserved', journal);
    if (kind === 'dangling-journal') fs.symlinkSync(journal + '.absent', journal);
    if (kind === 'hardlink-journal') fs.linkSync(journal + '.preserved', journal);
  }
  if (kind === 'wal' || kind === 'shm') fs.writeFileSync(filename() + '-' + kind, '');
  const headerRead = jest.spyOn(fs, 'readSync'),
    before = mockConnections.length;
  try {
    expect(() => open(false)).toThrow();
    expect(headerRead).not.toHaveBeenCalled();
    expect(mockConnections).toHaveLength(before);
  } finally {
    headerRead.mockRestore();
  }
});
test('unexpected nonempty journal after commit refuses adoption and closes unadopted connection', () => {
  mockCommitHook = (filename) => fs.writeFileSync(filename + '-journal', 'unexpected');
  expect(() => open()).toThrow();
  expect(mockConnections[0].close).toHaveBeenCalledTimes(1);
});
