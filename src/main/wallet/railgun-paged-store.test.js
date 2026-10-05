let mockDatabaseOpens;
jest.mock('better-sqlite3', () => {
  const Actual = jest.requireActual('better-sqlite3');
  function Database(...args) {
    mockDatabaseOpens?.push(args);
    return new Actual(...args);
  }
  Database.prototype = Actual.prototype;
  return Database;
});
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunPagedStore, openRailgunReadOnlyPagedStore } = require('./railgun-paged-store');
let scope, options, store;
const key = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const put = (n, value = Buffer.from('value-' + n)) => ({ type: 'put', key: key(n), value });
const read = (cursor) => {
  const rows = [];
  try {
    for (let row; (row = cursor.next());) rows.push(row);
  } finally {
    cursor.close();
  }
  return rows;
};
beforeEach(() => {
  mockDatabaseOpens = [];
  scope = createPrivacyScope({ profileId: 'paged-fixture', signal: new AbortController().signal });
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'account0',
      protocol: 'railgun',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'storage',
    }),
    filename: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-paged-')), 'state.sqlite'),
    onFatal: jest.fn(),
    key: Buffer.alloc(32, 7),
    binding: 'a'.repeat(64),
  };
  store = createRailgunPagedStore({ ...options, create: true });
});
afterEach(() => {
  store.close();
  scope.close();
});
test('authenticated instance identity survives writes, collection and reopen, and differs for new stores', () => {
  const id = store.getInstanceId();
  expect(id).toMatch(/^[0-9a-f]{64}$/);
  store.batch([put(1)]);
  store.clear({});
  expect(store.getInstanceId()).toBe(id);
  store.close();
  store = createRailgunPagedStore(options);
  expect(store.getInstanceId()).toBe(id);
  const other = createRailgunPagedStore({
    ...options,
    filename: options.filename + '.other',
    create: true,
  });
  try {
    expect(other.getInstanceId()).not.toBe(id);
  } finally {
    other.close();
  }
});
function editManifest(change) {
  store.close();
  const context = getPrivacyContext(options.handle),
    subject = context.subject;
  const aad = Buffer.concat([
    Buffer.from(
      JSON.stringify([
        'railgun-paged-store-v2',
        context.profileId,
        subject.kind,
        subject.principal,
        subject.chainId,
        subject.protocol,
        subject.deployment,
        subject.role,
        options.binding,
      ])
    ),
    Buffer.from('manifest'),
  ]);
  const db = new Database(options.filename);
  try {
    const bytes = db
      .prepare("SELECT ciphertext FROM records WHERE id = 'manifest'")
      .get().ciphertext;
    const decipher = crypto.createDecipheriv('aes-256-gcm', options.key, bytes.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(-16));
    const parsed = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()])
    );
    change(parsed);
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', options.key, iv);
    cipher.setAAD(aad);
    const sealed = Buffer.concat([
      iv,
      cipher.update(JSON.stringify(parsed)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    db.prepare("UPDATE records SET ciphertext = ? WHERE id = 'manifest'").run(sealed);
  } finally {
    db.close();
  }
}
test('legacy five-field manifests stay readable and never silently acquire an identity', () => {
  store.batch([put(1)]);
  editManifest((value) => {
    value.pop();
  });
  store = createRailgunPagedStore(options);
  expect(store.getInstanceId()).toBeNull();
  expect(store.get(key(1)).toString()).toBe('value-1');
  store.batch([put(2)]);
  store.close();
  store = createRailgunPagedStore(options);
  expect(store.getInstanceId()).toBeNull();
});
test.each([null, '', 'a'.repeat(63), 'A'.repeat(64), 1])(
  'refuses malformed authenticated instance identity %j',
  (id) => {
    editManifest((value) => {
      value[5] = id;
    });
    expect(() => createRailgunPagedStore(options)).toThrow();
  }
);
test('encrypts exact binary keys and values, including an empty value; reopens without shared buffers', () => {
  store.batch([put(0, Buffer.alloc(0)), put(1, Buffer.from('private-value-do-not-publish'))]);
  const result = store.get(key(1));
  result.fill(0);
  expect(store.get(key(1)).toString()).toBe('private-value-do-not-publish');
  expect(store.get(key(0))).toEqual(Buffer.alloc(0));
  store.close();
  expect(
    fs.readFileSync(options.filename).includes(Buffer.from('private-value-do-not-publish'))
  ).toBe(false);
  expect(fs.statSync(options.filename).mode & 0o777).toBe(0o600);
  store = createRailgunPagedStore(options);
  expect(store.get(key(1)).toString()).toBe('private-value-do-not-publish');
});
test('snapshot pages survive later writes, clears, seek and cold reopen; retired pages are collected', () => {
  store.batch(Array.from({ length: 250 }, (_, n) => put(n, Buffer.alloc(1024, n % 256))));
  const forward = store.openSnapshot({ gte: key(60), lt: key(200), limit: 3 });
  const reverse = store.openSnapshot({ reverse: true, gte: key(60), lte: key(200), values: false });
  store.batch([put(75), put(201)]);
  store.clear({ gte: key(65), lt: key(80) });
  forward.seek(key(75));
  expect(read(forward).map(([k, v]) => [k.readUInt32BE(), v.length])).toEqual([
    [75, 1024],
    [76, 1024],
    [77, 1024],
  ]);
  reverse.seek(key(65));
  expect(read(reverse).map(([k, v]) => [k.readUInt32BE(), v.length])).toEqual(
    [65, 64, 63, 62, 61, 60].map((n) => [n, 0])
  );
  expect(store.get(key(75))).toBeNull();
  const latest = read(store.openSnapshot()).map(([k, v]) => [k.toString('hex'), v.toString('hex')]);
  store.close();
  store = createRailgunPagedStore(options);
  expect(
    read(store.openSnapshot()).map(([k, v]) => [k.toString('hex'), v.toString('hex')])
  ).toEqual(latest);
  const pages = store.stats().pages;
  store.close();
  const db = new Database(options.filename);
  expect(db.prepare('SELECT COUNT(*) AS n FROM records').get().n).toBe(pages + 1);
  db.close();
});
test('keeps snapshots valid across a whole-namespace clear without materializing every key', () => {
  store.batch(Array.from({ length: 1500 }, (_, n) => put(n, Buffer.alloc(100))));
  const snapshot = store.openSnapshot({ reverse: true, limit: 2 });
  store.clear();
  expect(store.stats()).toMatchObject({ keys: 0, bytes: 0, pages: 0 });
  expect(read(snapshot).map(([k]) => k.readUInt32BE())).toEqual([1499, 1498]);
  store.close();
  store = createRailgunPagedStore(options);
  expect(read(store.openSnapshot())).toEqual([]);
});
test('reproduces deterministic randomized ordered-map semantics across reopen and limited reverse clears', () => {
  let state = 1234567;
  const random = (max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
  const reference = new Map();
  const select = (range) => {
    let rows = [...reference]
      .map(([n, v]) => [key(n), v])
      .sort((a, b) => Buffer.compare(a[0], b[0]));
    rows = rows.filter(([k]) =>
      ['gt', 'gte', 'lt', 'lte'].every(
        (name) =>
          !range[name] ||
          (name === 'gt'
            ? Buffer.compare(k, range[name]) > 0
            : name === 'gte'
              ? Buffer.compare(k, range[name]) >= 0
              : name === 'lt'
                ? Buffer.compare(k, range[name]) < 0
                : Buffer.compare(k, range[name]) <= 0)
      )
    );
    if (range.reverse) rows.reverse();
    return range.limit >= 0 ? rows.slice(0, range.limit) : rows;
  };
  for (let step = 0; step < 120; step++) {
    const ops = Array.from({ length: 20 }, () =>
      random(3)
        ? put(random(400), Buffer.alloc(random(1500), random(256)))
        : { type: 'del', key: key(random(400)) }
    );
    store.batch(ops);
    for (const op of ops)
      if (op.type === 'del') reference.delete(op.key.readUInt32BE());
      else reference.set(op.key.readUInt32BE(), op.value);
    const range = {
      [random(2) ? 'gt' : 'gte']: key(random(200)),
      [random(2) ? 'lt' : 'lte']: key(200 + random(200)),
      reverse: !!random(2),
      limit: random(12) - 1,
    };
    expect(read(store.openSnapshot(range))).toEqual(select(range));
    if (step % 3 === 0) {
      const selected = select(range);
      store.clear(range);
      for (const [k] of selected) reference.delete(k.readUInt32BE());
    }
    if (step % 15 === 0) {
      store.close();
      store = createRailgunPagedStore(options);
    }
    expect(store.get(key(75))).toEqual(reference.get(75) ?? null);
  }
  expect(read(store.openSnapshot())).toEqual(select({}));
});
test.each(['remove', 'modify', 'swap', 'add', 'manifest', 'truncate'])(
  'rejects %s tampering rather than returning missing state',
  (mode) => {
    store.batch(Array.from({ length: 200 }, (_, n) => put(n, Buffer.alloc(1024, n))));
    store.close();
    const db = new Database(options.filename);
    const pages = db.prepare("SELECT * FROM records WHERE id != 'manifest'").all();
    if (mode === 'remove') db.prepare('DELETE FROM records WHERE id = ?').run(pages[0].id);
    if (mode === 'modify') {
      pages[0].ciphertext[20] ^= 1;
      db.prepare('UPDATE records SET ciphertext = ? WHERE id = ?').run(
        pages[0].ciphertext,
        pages[0].id
      );
    }
    if (mode === 'swap')
      db.prepare('UPDATE records SET ciphertext = ? WHERE id = ?').run(
        pages[1].ciphertext,
        pages[0].id
      );
    if (mode === 'add')
      db.prepare('INSERT INTO records VALUES (?, ?)').run('e'.repeat(32), pages[0].ciphertext);
    if (mode === 'manifest')
      db.prepare("UPDATE records SET ciphertext = ? WHERE id = 'manifest'").run(
        pages[0].ciphertext
      );
    if (mode === 'truncate')
      db.prepare('UPDATE records SET ciphertext = ? WHERE id = ?').run(
        pages[0].ciphertext.subarray(0, 100),
        pages[0].id
      );
    db.close();
    expect(() => createRailgunPagedStore(options)).toThrow(
      expect.objectContaining({ code: 'RAILGUN_STORE_UNREADABLE' })
    );
  }
);
test('rejects replay of a superseded page even when its encryption remains authentic', () => {
  store.batch([put(1)]);
  store.close();
  let db = new Database(options.filename);
  const old = db.prepare("SELECT * FROM records WHERE id != 'manifest'").get();
  db.close();
  store = createRailgunPagedStore(options);
  store.batch([put(1, Buffer.from('new'))]);
  store.close();
  db = new Database(options.filename);
  const current = db.prepare("SELECT id FROM records WHERE id != 'manifest'").get();
  db.prepare('UPDATE records SET id = ?, ciphertext = ? WHERE id = ?').run(
    old.id,
    old.ciphertext,
    current.id
  );
  db.close();
  expect(() => createRailgunPagedStore(options)).toThrow();
});
test.each([
  'INSERT INTO records VALUES (?, ?)',
  'UPDATE records SET ciphertext = ? WHERE id = ?',
  'DELETE FROM records WHERE id = ?',
])('rolls back a failure at %s without publishing a partial state', (statement) => {
  store.batch([put(1), put(2)]);
  const original = Database.prototype.prepare;
  const spy = jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
    if (sql === statement)
      return {
        run() {
          throw new Error('fixture SQL failure');
        },
      };
    return original.call(this, sql);
  });
  expect(() => store.batch([put(1, Buffer.from('wrong')), put(3)])).toThrow();
  spy.mockRestore();
  expect(options.onFatal).toHaveBeenCalled();
  store = createRailgunPagedStore(options);
  expect(store.get(key(1)).toString()).toBe('value-1');
  expect(store.get(key(3))).toBeNull();
});
test('refuses wrong binding, ownership, overwrite, missing state and incomplete files', () => {
  expect(() => createRailgunPagedStore(options)).toThrow();
  store.close();
  expect(() => createRailgunPagedStore({ ...options, create: true })).toThrow();
  expect(() => createRailgunPagedStore({ ...options, binding: 'b'.repeat(64) })).toThrow();
  expect(() => createRailgunPagedStore({ ...options, key: Buffer.alloc(32, 8) })).toThrow();
  expect(() =>
    createRailgunPagedStore({ ...options, filename: options.filename + '.absent' })
  ).toThrow(expect.objectContaining({ code: 'RAILGUN_STORE_MISSING' }));
  fs.truncateSync(options.filename, 0);
  expect(() => createRailgunPagedStore(options)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_INCOMPLETE' })
  );
});
test('refuses an invalid or oversized batch before writing and closes all snapshots', () => {
  store.batch([put(1)]);
  const snapshot = store.openSnapshot();
  expect(() => store.batch([put(2), put(3, Buffer.alloc(1024 * 1024 + 1))])).toThrow();
  expect(() => snapshot.next()).toThrow();
  store = createRailgunPagedStore(options);
  expect(store.get(key(2))).toBeNull();
});
test('revocation and snapshot capacity fail closed', () => {
  const first = store.openSnapshot(),
    second = store.openSnapshot();
  expect(() => store.openSnapshot()).toThrow();
  expect(() => first.next()).toThrow();
  expect(() => second.seek(key(1))).toThrow();
  expect(store.signal.aborted).toBe(true);
  store = createRailgunPagedStore(options);
  scope.close();
  expect(() => store.get(key(1))).toThrow();
});
test('snapshot expiry discards retained plaintext and refuses subsequent use', () => {
  jest.useFakeTimers();
  try {
    store.batch([put(1)]);
    const snapshot = store.openSnapshot();
    snapshot.next();
    jest.advanceTimersByTime(300001);
    expect(store.stats().snapshots).toBe(0);
    expect(() => snapshot.next()).toThrow();
  } finally {
    jest.useRealTimers();
  }
});
test('active snapshots refresh their idle deadline but retain an absolute lifetime limit', () => {
  jest.useFakeTimers();
  try {
    store.batch([put(1)]);
    const snapshot = store.openSnapshot();
    for (let i = 0; i < 7; i++) {
      jest.advanceTimersByTime(240000);
      snapshot.seek(key(1));
      expect(snapshot.next()[0]).toEqual(key(1));
    }
    jest.advanceTimersByTime(120001);
    expect(() => snapshot.next()).toThrow();
  } finally {
    jest.useRealTimers();
  }
});
test('prefix-compressed directory stays small for engine-sized binary keys and pages merge after deletion', () => {
  const largeKey = (n) => Buffer.concat([Buffer.alloc(326, 97), key(n)]);
  store.batch(
    Array.from({ length: 2000 }, (_, n) => ({
      type: 'put',
      key: largeKey(n),
      value: Buffer.alloc(1000),
    }))
  );
  const before = store.stats();
  expect(before.directoryBytes / before.pages).toBeLessThan(220);
  store.batch(Array.from({ length: 1600 }, (_, n) => ({ type: 'del', key: largeKey(n) })));
  expect(store.stats().pages).toBeLessThan(before.pages / 2);
  expect(store.stats().pageFill).toBeGreaterThan(0.5);
  store.close();
  store = createRailgunPagedStore(options);
  expect(store.get(largeKey(1999))).toEqual(Buffer.alloc(1000));
});
test('refuses scattered write amplification above its publish budget and rolls back every page', () => {
  for (let start = 0; start < 1100; start += 100) {
    const ops = [];
    for (let n = start; n < start + 100; n++)
      ops.push(put(n * 2, Buffer.alloc(32768, 3)), put(n * 2 + 1, Buffer.from('before')));
    store.batch(ops);
  }
  expect(() =>
    store.batch(Array.from({ length: 1100 }, (_, n) => put(n * 2 + 1, Buffer.from('after'))))
  ).toThrow(expect.objectContaining({ code: 'RAILGUN_STORE_LIMIT' }));
  store = createRailgunPagedStore(options);
  expect(store.get(key(1)).toString()).toBe('before');
  expect(store.get(key(2199)).toString()).toBe('before');
}, 30000);
test('snapshot release does not make the next large write fail; deferred pages remain authenticated through reopen', () => {
  const value = Buffer.alloc(1024 * 1024, 5);
  for (let start = 0; start < 94; start += 10)
    store.batch(Array.from({ length: Math.min(10, 94 - start) }, (_, n) => put(start + n, value)));
  const snapshot = store.openSnapshot();
  for (let start = 0; start < 94; start += 10)
    store.batch(Array.from({ length: Math.min(10, 94 - start) }, (_, n) => put(start + n, value)));
  expect(store.stats().retiredPages).toBe(94);
  snapshot.close();
  store.batch(Array.from({ length: 31 }, (_, n) => put(n, Buffer.alloc(1024 * 1024, 9))));
  expect(store.stats().retiredPages).toBeGreaterThan(0);
  store.close();
  store = createRailgunPagedStore(options);
  expect(store.stats().retiredPages).toBe(0);
  expect(store.get(key(0))[0]).toBe(9);
  expect(store.get(key(93))[0]).toBe(5);
}, 30000);
test('snapshot retention above 96 MiB refuses the writer, preserves its previous revision and revokes the reader', () => {
  const value = Buffer.alloc(1024 * 1024, 5);
  for (let start = 0; start < 100; start += 10)
    store.batch(Array.from({ length: 10 }, (_, n) => put(start + n, value)));
  const snapshot = store.openSnapshot();
  for (let start = 0; start < 90; start += 10)
    store.batch(Array.from({ length: 10 }, (_, n) => put(start + n, value)));
  expect(() =>
    store.batch(Array.from({ length: 10 }, (_, n) => put(90 + n, Buffer.alloc(1024 * 1024, 9))))
  ).toThrow(expect.objectContaining({ code: 'RAILGUN_STORE_LIMIT' }));
  expect(() => snapshot.next()).toThrow();
  store = createRailgunPagedStore(options);
  expect(store.get(key(99))[0]).toBe(5);
  expect(store.stats().keys).toBe(100);
}, 30000);
test.each(['page', 'directory', 'collection', 'committed'])(
  'host SIGKILL at %s preserves one complete durable revision',
  (phase) => {
    store.batch([put(1), put(2)]);
    store.close();
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
    const Database = require(process.argv[1]);
    const { createRailgunPagedStore } = require(process.argv[2]);
    const { createPrivacyScope } = require(process.argv[3]);
    const scope = createPrivacyScope({profileId:'paged-fixture',signal:new AbortController().signal});
    const store = createRailgunPagedStore({handle:scope.getContext({kind:'private-account',principal:'account0',protocol:'railgun',deployment:'fixture',chainId:11155111,role:'storage'}),filename:process.argv[4],key:Buffer.alloc(32,7),binding:'a'.repeat(64),onFatal:()=>{}});
    const phase = process.argv[5];
    const statements = {page:'INSERT INTO records VALUES (?, ?)',directory:'UPDATE records SET ciphertext = ? WHERE id = ?',collection:'DELETE FROM records WHERE id = ?'};
    const original = Database.prototype.prepare;
    Database.prototype.prepare = function(sql) {
      const stmt = original.call(this,sql);
      if (sql === statements[phase]) { const run = stmt.run.bind(stmt); stmt.run = (...args) => { const value = run(...args); process.kill(process.pid,'SIGKILL'); return value; }; }
      return stmt;
    };
    const key = n => {const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
    store.batch([{type:'put',key:key(1),value:Buffer.from('after')},{type:'del',key:key(2)},{type:'put',key:key(3),value:Buffer.from('new')}]);
    process.kill(process.pid,'SIGKILL');
  `,
        require.resolve('better-sqlite3'),
        require.resolve('./railgun-paged-store'),
        require.resolve('../networks/privacy-context'),
        options.filename,
        phase,
      ],
      { timeout: 10000 }
    );
    expect(child.signal).toBe('SIGKILL');
    store = createRailgunPagedStore(options);
    expect(store.get(key(1)).toString()).toBe(phase === 'committed' ? 'after' : 'value-1');
    expect(store.get(key(2))).toEqual(phase === 'committed' ? null : Buffer.from('value-2'));
    expect(store.get(key(3))).toEqual(phase === 'committed' ? Buffer.from('new') : null);
  }
);
test('stores and cold-reopens more than the old key and byte limits with bounded page sizes', () => {
  for (let start = 0; start < 72000; start += 2000)
    store.batch(
      Array.from({ length: 2000 }, (_, n) => put(start + n, Buffer.alloc(512, (start + n) % 256)))
    );
  expect(store.stats()).toMatchObject({ keys: 72000, bytes: 72000 * 516 });
  expect(store.stats().pages).toBeLessThan(1000);
  const snapshot = store.openSnapshot({ gte: key(71997) });
  expect(read(snapshot).map(([k]) => k.readUInt32BE())).toEqual([71997, 71998, 71999]);
  store.close();
  store = createRailgunPagedStore(options);
  expect(store.get(key(65000))).toEqual(Buffer.alloc(512, 65000 % 256));
  expect(store.stats().keys).toBe(72000);
}, 30000);

test('LevelDOWN presentation options stay out of strict paged storage ranges', async () => {
  const { createRailgunLeveldown } = require('./railgun-leveldown');
  const level = createRailgunLeveldown({
    AbstractLevelDOWN: class {},
    AbstractIterator: class {},
    store,
  });
  store.batch([put(1), put(2), put(3)]);
  const iterator = level._iterator({
    gte: key(2),
    lte: key(3),
    keys: true,
    values: true,
    reverse: false,
    limit: -1,
    keyAsBuffer: true,
    valueAsBuffer: false,
    valueEncoding: 'utf8',
  });
  const next = () =>
    new Promise((resolve, reject) =>
      iterator._next((error, key, value) => (error ? reject(error) : resolve([key, value])))
    );
  expect(await next()).toEqual([key(2), 'value-2']);
  expect(await next()).toEqual([key(3), 'value-3']);
  expect(await next()).toEqual([undefined, undefined]);
  await new Promise((resolve) => iterator._end(resolve));
  await new Promise((resolve, reject) =>
    level._clear({ gte: key(2), lte: key(2), keyAsBuffer: true }, (error) =>
      error ? reject(error) : resolve()
    )
  );
  expect(store.get(key(1)).toString()).toBe('value-1');
  expect(store.get(key(2))).toBe(null);
  expect(store.get(key(3)).toString()).toBe('value-3');
});

function directorySnapshot() {
  const directory = path.dirname(options.filename);
  return fs
    .readdirSync(directory)
    .sort()
    .map((name) => {
      const filename = path.join(directory, name),
        stat = fs.lstatSync(filename, { bigint: true });
      return {
        name,
        size: stat.size,
        mtime: stat.mtimeNs,
        bytes: stat.isFile() ? fs.readFileSync(filename) : null,
        link: stat.isSymbolicLink() ? fs.readlinkSync(filename) : null,
      };
    });
}
function retainedFixture() {
  store.batch([put(1, Buffer.from('before'))]);
  const snapshot = store.openSnapshot();
  store.batch([put(1, Buffer.from('after')), put(2)]);
  expect(store.stats().retiredPages).toBeGreaterThan(0);
  snapshot.close();
  store.close();
}
test('fixed read-only open authenticates and preserves current and retired pages across reads, cursors and close', () => {
  retainedFixture();
  const before = directorySnapshot();
  mockDatabaseOpens = [];
  store = openRailgunReadOnlyPagedStore(options);
  expect(mockDatabaseOpens).toEqual([
    [options.filename, { fileMustExist: true, timeout: 0, readonly: true }],
  ]);
  expect(store.stats().retiredPages).toBeGreaterThan(0);
  const id = store.getInstanceId();
  expect(store.get(key(1)).toString()).toBe('after');
  const snapshot = store.openSnapshot({ reverse: true });
  expect(snapshot.next()).toEqual([key(2), Buffer.from('value-2')]);
  snapshot.seek(key(1));
  expect(snapshot.next()).toEqual([key(1), Buffer.from('after')]);
  expect(directorySnapshot()).toEqual(before);
  store.close();
  expect(() => snapshot.next()).toThrow();
  expect(directorySnapshot()).toEqual(before);
  store = openRailgunReadOnlyPagedStore(options);
  expect(store.getInstanceId()).toBe(id);
  expect(store.stats().retiredPages).toBeGreaterThan(0);
  store.close();
  expect(directorySnapshot()).toEqual(before);
});
test('ordinary open still performs mutable initialization and collects retained pages', () => {
  retainedFixture();
  const before = directorySnapshot();
  const pragma = jest.spyOn(Database.prototype, 'pragma');
  store = createRailgunPagedStore(options);
  expect(pragma).toHaveBeenCalledWith('journal_mode = DELETE');
  expect(store.stats().retiredPages).toBe(0);
  pragma.mockRestore();
  store.close();
  expect(directorySnapshot()).not.toEqual(before);
});
test('reader uses only connection-local protections and a deferred read transaction', () => {
  store.close();
  const pragma = jest.spyOn(Database.prototype, 'pragma'),
    exec = jest.spyOn(Database.prototype, 'exec');
  try {
    store = openRailgunReadOnlyPagedStore(options);
    expect(pragma.mock.calls.map((call) => call[0])).toEqual([
      'query_only = ON',
      'temp_store = MEMORY',
      'journal_mode',
      'trusted_schema = OFF',
      'cache_size = -4096',
      'mmap_size = 0',
    ]);
    expect(exec.mock.calls).toEqual([['BEGIN']]);
  } finally {
    pragma.mockRestore();
    exec.mockRestore();
  }
});
test.each(['batch', 'clear'])(
  'reader %s refuses before any SQLite write and preserves the whole directory',
  (method) => {
    retainedFixture();
    const before = directorySnapshot();
    store = openRailgunReadOnlyPagedStore(options);
    const prepare = jest.spyOn(Database.prototype, 'prepare'),
      transaction = jest.spyOn(Database.prototype, 'transaction');
    try {
      expect(() => store[method](method === 'batch' ? [put(9)] : {})).toThrow(
        expect.objectContaining({ code: 'RAILGUN_STORE_READ_ONLY' })
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
    }
    expect(options.onFatal).toHaveBeenCalledTimes(1);
    expect(directorySnapshot()).toEqual(before);
  }
);
test('SQLite readonly backstop denies writes even if connection query_only is disabled', () => {
  store.close();
  let connection;
  const original = Database.prototype.pragma;
  const pragma = jest.spyOn(Database.prototype, 'pragma').mockImplementation(function (...args) {
    connection = this;
    return original.apply(this, args);
  });
  store = openRailgunReadOnlyPagedStore(options);
  pragma.mockRestore();
  const before = directorySnapshot();
  connection.pragma('query_only = OFF');
  expect(() => connection.prepare("DELETE FROM records WHERE id = 'manifest'").run()).toThrow(
    expect.objectContaining({ code: 'SQLITE_READONLY' })
  );
  store.close();
  expect(directorySnapshot()).toEqual(before);
});
test('read-only route never creates a file or accepts create:true; caller flags cannot switch its policy', () => {
  store.close();
  mockDatabaseOpens = [];
  const before = directorySnapshot();
  expect(() => openRailgunReadOnlyPagedStore({ ...options, create: true })).toThrow();
  expect(() =>
    openRailgunReadOnlyPagedStore({ ...options, filename: options.filename + '.absent' })
  ).toThrow(expect.objectContaining({ code: 'RAILGUN_STORE_MISSING' }));
  expect(mockDatabaseOpens).toEqual([]);
  expect(directorySnapshot()).toEqual(before);
  store = openRailgunReadOnlyPagedStore({ ...options, readOnly: false });
  expect(() => store.batch([put(1)])).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_READ_ONLY' })
  );
});
test.each(
  ['-journal', '-wal', '-shm'].flatMap((suffix) =>
    ['empty', 'hot-marker', 'broken-link'].map((kind) => [suffix, kind])
  )
)(
  'reader rejects existing %s %s before opening SQLite and preserves every byte',
  (suffix, kind) => {
    store.close();
    if (kind === 'broken-link')
      fs.symlinkSync(options.filename + '.missing-target', options.filename + suffix);
    else
      fs.writeFileSync(
        options.filename + suffix,
        kind === 'hot-marker' ? Buffer.from('d9d505f920a163d7', 'hex') : Buffer.alloc(0)
      );
    const before = directorySnapshot();
    mockDatabaseOpens = [];
    expect(() => openRailgunReadOnlyPagedStore(options)).toThrow();
    expect(mockDatabaseOpens).toEqual([]);
    expect(directorySnapshot()).toEqual(before);
  }
);
test.each([
  'wal-write',
  'wal-read',
  'bad-magic',
  'truncated',
  'empty',
  'directory',
  'symlink',
  'oversized',
])('reader refuses %s file/header before opening SQLite', (mode) => {
  store.close();
  let filename = options.filename;
  if (mode === 'directory') filename = path.dirname(filename);
  else if (mode === 'symlink') {
    filename += '.link';
    fs.symlinkSync(options.filename, filename);
  } else if (mode === 'oversized') fs.truncateSync(filename, 4 * 1024 * 1024 * 1024 + 1);
  else {
    const bytes = fs.readFileSync(filename);
    if (mode === 'wal-write') bytes[18] = 2;
    if (mode === 'wal-read') bytes[19] = 2;
    if (mode === 'bad-magic') bytes[0] ^= 1;
    fs.writeFileSync(
      filename,
      mode === 'truncated' ? bytes.subarray(0, 99) : mode === 'empty' ? Buffer.alloc(0) : bytes
    );
  }
  mockDatabaseOpens = [];
  // Avoid materializing the intentionally oversized sparse fixture.
  const before = mode === 'oversized' ? null : directorySnapshot();
  expect(() => openRailgunReadOnlyPagedStore({ ...options, filename })).toThrow();
  expect(mockDatabaseOpens).toEqual([]);
  if (before) expect(directorySnapshot()).toEqual(before);
});
test('read-only open still authenticates retired ciphertext and refuses corruption without collection', () => {
  retainedFixture();
  // The initial row is retired; current rows were inserted by the later publish.
  const db = new Database(options.filename);
  const row = db
    .prepare("SELECT id,ciphertext FROM records WHERE id != 'manifest' ORDER BY rowid LIMIT 1")
    .get();
  row.ciphertext[20] ^= 1;
  db.prepare('UPDATE records SET ciphertext=? WHERE id=?').run(row.ciphertext, row.id);
  db.close();
  const before = directorySnapshot();
  expect(() => openRailgunReadOnlyPagedStore(options)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_UNREADABLE' })
  );
  expect(directorySnapshot()).toEqual(before);
});
test.each(['sidecar', 'size', 'mtime'])(
  'close reports sticky %s change after unconditional cleanup',
  (mode) => {
    store.close();
    store = openRailgunReadOnlyPagedStore(options);
    const snapshot = store.openSnapshot();
    if (mode === 'sidecar') fs.writeFileSync(options.filename + '-journal', 'external change');
    if (mode === 'size') fs.appendFileSync(options.filename, Buffer.alloc(1));
    if (mode === 'mtime') fs.utimesSync(options.filename, new Date(), new Date(Date.now() + 10000));
    const reader = store;
    expect(() => reader.close()).toThrow(
      expect.objectContaining({ code: 'RAILGUN_STORE_UNREADABLE' })
    );
    expect(() => reader.close()).toThrow(
      expect.objectContaining({ code: 'RAILGUN_STORE_UNREADABLE' })
    );
    expect(reader.signal.aborted).toBe(true);
    expect(() => snapshot.next()).toThrow();
    expect(() => reader.get(key(1))).toThrow();
    // The filename owner was released even though validation failed.
    try {
      const next = openRailgunReadOnlyPagedStore(options);
      next.close();
    } catch (error) {
      expect(error.code).not.toBe('RAILGUN_STORE_BUSY');
    }
    store = { close() {} };
  }
);
test('abort close records a sticky integrity failure without throwing out of the signal callback', () => {
  store.close();
  store = openRailgunReadOnlyPagedStore(options);
  fs.utimesSync(options.filename, new Date(), new Date(Date.now() + 10000));
  expect(() => scope.close()).not.toThrow();
  expect(options.onFatal).toHaveBeenCalledTimes(1);
  expect(() => store.close()).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_UNREADABLE' })
  );
  store = { close() {} };
});
