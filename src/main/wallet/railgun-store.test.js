const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { spawnSync } = require('child_process');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunStore } = require('./railgun-store');
let scope, options, store;
const k = (s) => Buffer.from(s);
const put = (key, value) => ({ type: 'put', key: k(key), value: k(value) });
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'account0',
      protocol: 'railgun',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'storage',
    }),
    filename: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-store-')), 'state.sqlite'),
    onFatal: jest.fn(),
    key: Buffer.alloc(32, 7),
    binding: 'a'.repeat(64),
  };
  store = createRailgunStore({ ...options, create: true });
});
afterEach(() => {
  store.close();
  scope.close();
});
test('encrypts keys and values, restores exact bytes, and does not reuse buffers', () => {
  store.batch([
    put('secret-owned-output', 'secret-note-value'),
    { type: 'put', key: Buffer.from([0, 255]), value: Buffer.alloc(0) },
  ]);
  const copy = store.get(k('secret-owned-output'));
  copy.fill(0);
  const snapshot = store.snapshot();
  snapshot[1][1].fill(0);
  expect(store.get(k('secret-owned-output')).toString()).toBe('secret-note-value');
  store.close();
  const bytes = fs.readFileSync(options.filename);
  expect(bytes.includes(k('secret-owned-output'))).toBe(false);
  expect(bytes.includes(k('secret-note-value'))).toBe(false);
  expect(fs.statSync(options.filename).mode & 0o777).toBe(0o600);
  store = createRailgunStore(options);
  expect(store.get(k('secret-owned-output')).toString()).toBe('secret-note-value');
  expect(store.get(Buffer.from([0, 255]))).toEqual(Buffer.alloc(0));
});
test('batches are ordered, binary-sorted and all-or-nothing on invalid inputs', () => {
  store.batch([put('b', 'old'), put('a', 'first'), put('b', 'new'), { type: 'del', key: k('a') }]);
  expect(store.snapshot().map(([key, value]) => [key.toString(), value.toString()])).toEqual([
    ['b', 'new'],
  ]);
  expect(() =>
    store.batch([put('b', 'bad'), { type: 'put', key: k('invalid'), value: 'not-bytes' }])
  ).toThrow();
  expect(store.signal.aborted).toBe(true);
  expect(options.onFatal).toHaveBeenCalled();
  store.close();
  store = createRailgunStore(options);
  expect(store.get(k('b')).toString()).toBe('new');
});
test('refuses missing state, duplicate ownership and accidental fresh overwrite', () => {
  expect(() => createRailgunStore(options)).toThrow();
  store.close();
  expect(() => createRailgunStore({ ...options, create: true })).toThrow();
  expect(() => createRailgunStore({ ...options, filename: options.filename + '.missing' })).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_MISSING' })
  );
  store = createRailgunStore(options);
});
test.each(['key', 'binding', 'account'])('refuses substitution with wrong %s', (field) => {
  store.batch([put('note', 'sensitive')]);
  store.close();
  const other = { ...options };
  if (field === 'key') other.key = Buffer.alloc(32, 8);
  if (field === 'binding') other.binding = 'b'.repeat(64);
  if (field === 'account')
    other.handle = scope.getContext({
      kind: 'private-account',
      principal: 'account1',
      protocol: 'railgun',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'storage',
    });
  expect(() => createRailgunStore(other)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_UNREADABLE' })
  );
  store = createRailgunStore(options);
  expect(store.get(k('note')).toString()).toBe('sensitive');
});
test.each(['remove', 'modify', 'add'])(
  'authenticates the whole row set after %s tampering',
  (kind) => {
    store.batch([put('note', 'sensitive')]);
    store.close();
    const db = new Database(options.filename);
    const row = db.prepare("SELECT * FROM records WHERE id != 'manifest'").get();
    if (kind === 'remove') db.prepare('DELETE FROM records WHERE id = ?').run(row.id);
    if (kind === 'modify') {
      row.ciphertext[15] ^= 1;
      db.prepare('UPDATE records SET ciphertext = ? WHERE id = ?').run(row.ciphertext, row.id);
    }
    if (kind === 'add')
      db.prepare('INSERT INTO records VALUES (?, ?)').run('e'.repeat(32), row.ciphertext);
    db.close();
    const before = fs.readFileSync(options.filename);
    expect(() => createRailgunStore(options)).toThrow(
      expect.objectContaining({ code: 'RAILGUN_STORE_UNREADABLE' })
    );
    expect(fs.readFileSync(options.filename)).toEqual(before);
  }
);
test('revocation closes the connection and refuses all later operations', () => {
  store.batch([put('note', 'value')]);
  scope.close();
  for (const fn of [
    () => store.get(k('note')),
    () => store.snapshot(),
    () => store.batch([put('x', 'y')]),
  ])
    expect(fn).toThrow();
  expect(options.key.equals(Buffer.alloc(32, 7))).toBe(true);
});
test('refuses oversized values without committing an earlier batch operation', () => {
  expect(() =>
    store.batch([
      put('early', 'value'),
      { type: 'put', key: k('large'), value: Buffer.alloc(1024 * 1024 + 1) },
    ])
  ).toThrow();
  expect(store.signal.aborted).toBe(true);
  store = createRailgunStore(options);
  expect(store.get(k('early'))).toBeNull();
});
test('rolls back SQL transaction failure, preserving the old snapshot on reopen', () => {
  store.batch([put('note', 'before')]);
  store.close();
  store = createRailgunStore(options);
  const original = Database.prototype.prepare;
  const fail = jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
    if (sql === 'INSERT INTO records VALUES (?, ?)')
      return {
        run() {
          throw new Error('fixture');
        },
      };
    return original.call(this, sql);
  });
  expect(() => store.batch([put('note', 'after')])).toThrow();
  fail.mockRestore();
  expect(store.signal.aborted).toBe(true);
  store = createRailgunStore(options);
  expect(store.get(k('note')).toString()).toBe('before');
  store.close();
  store = createRailgunStore(options);
  expect(store.get(k('note')).toString()).toBe('before');
});
test('recovers the old authenticated state after another process dies mid-transaction', () => {
  store.batch([put('note', 'before-crash')]);
  store.close();
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2]);
    db.pragma('synchronous = FULL');
    db.exec('BEGIN EXCLUSIVE');
    db.prepare('UPDATE records SET ciphertext = ?').run(Buffer.alloc(40000, 3));
    process.kill(process.pid, 'SIGKILL');
  `,
      require.resolve('better-sqlite3'),
      options.filename,
    ],
    { timeout: 10000 }
  );
  expect(child.signal).toBe('SIGKILL');
  store = createRailgunStore(options);
  expect(store.get(k('note')).toString()).toBe('before-crash');
});
test('bounds the complete batch before copying large repeated values', () => {
  const value = Buffer.alloc(1024 * 1024);
  expect(() =>
    store.batch(Array.from({ length: 33 }, (_, i) => ({ type: 'put', key: k('key' + i), value })))
  ).toThrow(expect.objectContaining({ code: 'RAILGUN_STORE_LIMIT' }));
  expect(store.signal.aborted).toBe(true);
  store = createRailgunStore(options);
  expect(store.snapshot()).toEqual([]);
});
test('rejects a schema trigger whose name resembles a reserved SQLite prefix', () => {
  store.close();
  const db = new Database(options.filename);
  db.exec(
    'CREATE TRIGGER sqliteXtamper AFTER INSERT ON records BEGIN DELETE FROM records WHERE id = NEW.id; END'
  );
  db.close();
  expect(() => createRailgunStore(options)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_UNREADABLE' })
  );
});
test('an incomplete file is refused and never silently re-created', () => {
  store.close();
  fs.truncateSync(options.filename, 0);
  expect(() => createRailgunStore(options)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_INCOMPLETE' })
  );
  expect(() => createRailgunStore({ ...options, create: true })).toThrow(
    expect.objectContaining({ code: 'RAILGUN_STORE_EXISTS' })
  );
});
