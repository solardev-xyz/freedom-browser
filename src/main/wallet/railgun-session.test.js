const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunSession } = require('./railgun-session');
let scope, options, session, rpc, rpcSignal, id;
const b = (s) => Buffer.from(s).toString('base64');
const put = (key, value) => ({ type: 'put', key: b(key), value: b(value) });
const request = (method, args) =>
  session
    .dispatch(JSON.stringify({ id: ++id, method, args }))
    .then((wire) => JSON.parse(wire).value);
beforeEach(() => {
  id = 0;
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  rpc = jest.fn(async () => '0xaa36a7');
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'account0',
      protocol: 'railgun',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'engine',
    }),
    storage: {
      filename: path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-session-')),
        'state.sqlite'
      ),
      key: Buffer.alloc(32, 9),
      binding: 'b'.repeat(64),
      create: true,
    },
    createProvider: jest.fn(({ handle, signal }) => {
      expect(getPrivacyContext(handle).subject.role).toBe('protocol-rpc');
      rpcSignal = signal;
      return { signal, request: rpc };
    }),
    onClose: jest.fn(),
  };
  session = createRailgunSession(options);
});
afterEach(() => {
  session.close();
  scope.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
test('host-only storage survives a new session and never exposes its encryption key or path', async () => {
  const ack = await request('batch', { operations: [put('private-key', 'private-value')] });
  expect(ack).toBeNull();
  expect(await request('get', { key: b('private-key') })).toBe(b('private-value'));
  expect(await request('get', { key: b('missing') })).toBeNull();
  session.close();
  expect(fs.readFileSync(options.storage.filename).includes(Buffer.from('private-value'))).toBe(
    false
  );
  session = createRailgunSession({ ...options, storage: { ...options.storage, create: false } });
  id = 0;
  expect(await request('get', { key: b('private-key') })).toBe(b('private-value'));
});
test('snapshots are stable, ordered, seekable and bounded; clear is atomic', async () => {
  await request('batch', { operations: [put('a', '1'), put('b', '2'), put('c', '3')] });
  const cursor = await request('open', {
    options: { gte: b('a'), lt: b('d'), reverse: true, limit: 2 },
  });
  await request('batch', { operations: [put('b', 'changed')] });
  expect(await request('next', { cursor })).toEqual([b('c'), b('3')]);
  await request('seek', { cursor, target: b('b') });
  expect(await request('next', { cursor })).toEqual([b('b'), b('2')]);
  expect(await request('next', { cursor })).toBeNull();
  await request('end', { cursor });
  await request('clear', { options: { gte: b('a'), lte: b('c'), reverse: true, limit: 2 } });
  expect(await request('get', { key: b('a') })).toBe(b('1'));
  expect(await request('get', { key: b('b') })).toBeNull();
  expect(await request('get', { key: b('c') })).toBeNull();
});
test('vault lock aborts an in-flight RPC and suppresses even a late successful result', async () => {
  let resolve;
  rpc.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const task = request('rpc', { method: 'eth_blockNumber', params: [] });
  const rejected = expect(task).rejects.toMatchObject({ code: 'RAILGUN_SESSION_REVOKED' });
  await Promise.resolve();
  expect(rpc).toHaveBeenCalledTimes(1);
  scope.close();
  await rejected;
  expect(rpcSignal.aborted).toBe(true);
  expect(options.onClose).toHaveBeenCalledTimes(1);
  resolve('0x123');
  await expect(request('get', { key: b('a') })).rejects.toThrow('Railgun session unavailable');
});
test('an actual SQLite write failure revokes a pending RPC and commits no partial batch', async () => {
  await request('batch', { operations: [put('a', 'old')] });
  rpc.mockImplementation(() => new Promise(() => {}));
  const task = request('rpc', { method: 'eth_blockNumber', params: [] });
  const rejected = expect(task).rejects.toThrow('Railgun session unavailable');
  await Promise.resolve();
  const original = Database.prototype.prepare;
  jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
    if (sql === 'INSERT INTO records VALUES (?, ?)') throw new Error('sensitive filename');
    return original.call(this, sql);
  });
  await expect(
    request('batch', { operations: [put('a', 'new'), put('b', 'partial')] })
  ).rejects.toThrow('Railgun session unavailable');
  await rejected;
  expect(rpcSignal.aborted).toBe(true);
  expect(options.onClose).toHaveBeenCalledTimes(1);
  jest.restoreAllMocks();
  session = createRailgunSession({ ...options, storage: { ...options.storage, create: false } });
  id = 0;
  expect(await request('get', { key: b('a') })).toBe(b('old'));
  expect(await request('get', { key: b('b') })).toBeNull();
});
test.each([
  ['unknown method', 'sign', {}],
  ['RPC write', 'rpc', { method: 'eth_sendRawTransaction', params: ['0x123'] }],
  ['extra authority', 'get', { key: b('a'), filename: '/sensitive' }],
  ['noncanonical base64', 'get', { key: 'YR==' }],
  ['bad range', 'open', { options: { limit: -2 } }],
  ['unknown cursor', 'next', { cursor: 999 }],
  ['oversized batch', 'batch', { operations: Array(1025).fill(put('a', 'b')) }],
])('refuses %s and revokes all authority', async (_name, method, args) => {
  await expect(request(method, args)).rejects.toThrow('Railgun session unavailable');
  expect(rpc).not.toHaveBeenCalled();
  expect(rpcSignal.aborted).toBe(true);
  expect(options.onClose).toHaveBeenCalledTimes(1);
});
test('replayed request IDs and oversized envelopes fail closed', async () => {
  await request('get', { key: b('a') });
  await expect(
    session.dispatch(JSON.stringify({ id: 1, method: 'get', args: { key: b('a') } }))
  ).rejects.toThrow();
  expect(session.signal.aborted).toBe(true);
  session = createRailgunSession({ ...options, storage: { ...options.storage, create: false } });
  await expect(session.dispatch(' '.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow();
  expect(session.signal.aborted).toBe(true);
});
test('a third snapshot closes the session; existing cursors cannot outlive it', async () => {
  await request('open', { options: {} });
  await request('open', { options: {} });
  await expect(request('open', { options: {} })).rejects.toThrow();
  expect(session.signal.aborted).toBe(true);
});
test('request deadline aborts uncooperative RPC and all storage authority', async () => {
  jest.useFakeTimers();
  rpc.mockImplementation(() => new Promise(() => {}));
  const task = request('rpc', { method: 'eth_blockNumber', params: [] });
  const rejected = expect(task).rejects.toThrow('Railgun session unavailable');
  await Promise.resolve();
  jest.advanceTimersByTime(30000);
  await rejected;
  expect(rpcSignal.aborted).toBe(true);
});
test('in-flight limit revokes all pending requests without letting any extra RPC start', async () => {
  rpc.mockImplementation(() => new Promise(() => {}));
  const pending = Array.from({ length: 8 }, () =>
    expect(request('rpc', { method: 'eth_blockNumber', params: [] })).rejects.toThrow()
  );
  await Promise.resolve();
  await expect(request('rpc', { method: 'eth_blockNumber', params: [] })).rejects.toThrow();
  await Promise.all(pending);
  expect(rpc).toHaveBeenCalledTimes(8);
});
test('upstream errors and oversized replies never leak into the child', async () => {
  rpc.mockRejectedValue(new Error('https://secret.example/?private-account'));
  await expect(request('rpc', { method: 'eth_blockNumber', params: [] })).rejects.toThrow(
    'Railgun session unavailable'
  );
  session = createRailgunSession({ ...options, storage: { ...options.storage, create: false } });
  id = 0;
  rpc.mockResolvedValue('x'.repeat(2 * 1024 * 1024));
  await expect(request('rpc', { method: 'eth_getLogs', params: [] })).rejects.toThrow(
    'Railgun session unavailable'
  );
});
test('requires engine role and a provider with the exact shared lifetime', () => {
  session.close();
  expect(() =>
    createRailgunSession({
      ...options,
      createProvider: () => ({ signal: new AbortController().signal, request: rpc }),
      storage: { ...options.storage, create: false },
    })
  ).toThrow();
  expect(() =>
    createRailgunSession({
      ...options,
      handle: scope.getContext({
        kind: 'private-account',
        principal: 'account0',
        protocol: 'railgun',
        deployment: 'fixture',
        chainId: 1,
        role: 'engine',
      }),
    })
  ).toThrow();
});
test('multi-get sees one snapshot and refuses an oversized aggregate without returning a prefix', async () => {
  await request('batch', { operations: [put('a', 'old')] });
  const before = request('getMany', { keys: [b('a'), b('a'), b('missing')] });
  await request('batch', { operations: [put('a', 'new')] });
  expect(await before).toEqual([b('old'), b('old'), null]);
  await request('batch', { operations: [put('big', Buffer.alloc(1024 * 1024, 7))] });
  await expect(request('getMany', { keys: [b('big'), b('big')] })).rejects.toThrow();
  expect(session.signal.aborted).toBe(true);
});

test('staged frames publish together; reads and existing snapshots see committed state', async () => {
  await request('batch', { operations: [put('old', 'before'), put('untouched', 'stable')] });
  const cursor = await request('open', { options: {} });
  const transaction = await request('txBegin', {});
  await request('txStage', { transaction, operations: [put('old', 'after')] });
  await request('txStage', { transaction, operations: [put('new', 'value')] });
  expect(
    await request('txRead', { transaction, method: 'get', args: { key: b('untouched') } })
  ).toBe(b('stable'));
  await request('txCommit', { transaction });
  expect(await request('get', { key: b('old') })).toBe(b('after'));
  expect(await request('next', { cursor })).toEqual([b('old'), b('before')]);
  await request('end', { cursor });
  session.close();
  session = createRailgunSession({ ...options, storage: { ...options.storage, create: false } });
  id = 0;
  expect(await request('get', { key: b('new') })).toBe(b('value'));
});
test.each(['txAbort', 'close', 'deadline', 'fault'])(
  '%s discards every staged frame and preserves durable old state',
  async (mode) => {
    await request('batch', { operations: [put('old', 'before')] });
    const transaction = await request('txBegin', {});
    await request('txStage', {
      transaction,
      operations: [put('old', 'after'), put('new', 'value')],
    });
    if (mode === 'txAbort') await request(mode, { transaction });
    else if (mode === 'close') session.close();
    else if (mode === 'deadline') {
      // Start the timed group under fake timers; the first staged group is aborted.
      await request('txAbort', { transaction });
      jest.useFakeTimers();
      const timed = await request('txBegin', {});
      await request('txStage', { transaction: timed, operations: [put('new', 'value')] });
      jest.advanceTimersByTime(30001);
      jest.useRealTimers();
      expect(session.signal.aborted).toBe(true);
    } else {
      const original = Database.prototype.prepare;
      jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
        const stmt = original.call(this, sql);
        if (sql === 'UPDATE records SET ciphertext = ? WHERE id = ?')
          stmt.run = () => {
            throw new Error('manifest fault');
          };
        return stmt;
      });
      await expect(request('txCommit', { transaction })).rejects.toMatchObject({
        code: 'RAILGUN_SESSION_REVOKED',
      });
      jest.restoreAllMocks();
    }
    session.close();
    session = createRailgunSession({ ...options, storage: { ...options.storage, create: false } });
    id = 0;
    expect(await request('get', { key: b('old') })).toBe(b('before'));
    expect(await request('get', { key: b('new') })).toBeNull();
  }
);
test.each([
  'nested',
  'wrong-id',
  'outside-write',
  'outside-clear',
  'too-many-ops',
  'too-many-bytes',
])('transaction %s misuse revokes the host', async (mode) => {
  const transaction = await request('txBegin', {});
  let attempt;
  if (mode === 'nested') attempt = request('txBegin', {});
  else if (mode === 'wrong-id') attempt = request('txCommit', { transaction: transaction + 1 });
  else if (mode === 'outside-write') attempt = request('batch', { operations: [put('a', 'b')] });
  else if (mode === 'outside-clear') attempt = request('clear', { options: {} });
  else if (mode === 'too-many-ops') {
    for (let i = 0; i < 32; i++)
      await request('txStage', {
        transaction,
        operations: Array.from({ length: 1024 }, (_, j) => put(String(i * 1024 + j), 'b')),
      });
    attempt = request('txStage', { transaction, operations: [put('a', 'b')] });
  } else {
    for (let i = 0; i < 15; i++)
      await request('txStage', {
        transaction,
        operations: [put(String(i), 'b'.repeat(1024 * 1024))],
      });
    attempt = request('txStage', {
      transaction,
      operations: [put('overflow', 'b'.repeat(1024 * 1024))],
    });
  }
  await expect(attempt).rejects.toMatchObject({ code: 'RAILGUN_SESSION_REVOKED' });
  expect(session.signal.aborted).toBe(true);
});

test.each(['untagged', 'staged-key'])(
  '%s read cannot observe a provisional tree update',
  async (mode) => {
    const transaction = await request('txBegin', {});
    await request('txStage', { transaction, operations: [put('node', 'new')] });
    await expect(
      mode === 'untagged'
        ? request('get', { key: b('node') })
        : request('txRead', { transaction, method: 'get', args: { key: b('node') } })
    ).rejects.toMatchObject({ code: 'RAILGUN_SESSION_REVOKED' });
  }
);

test('polling RPC continues during an exclusive staged storage group', async () => {
  const transaction = await request('txBegin', {});
  await request('txStage', { transaction, operations: [put('node', 'value')] });
  expect(await request('rpc', { method: 'eth_chainId', params: [] })).toBe('0xaa36a7');
  await request('txCommit', { transaction });
  expect(await request('get', { key: b('node') })).toBe(b('value'));
});
test.each(['same-frame', 'later-frame'])('duplicate staged key in %s is refused', async (mode) => {
  const transaction = await request('txBegin', {});
  if (mode === 'later-frame')
    await request('txStage', { transaction, operations: [put('a', 'one')] });
  await expect(
    request('txStage', {
      transaction,
      operations: mode === 'same-frame' ? [put('a', 'one'), put('a', 'two')] : [put('a', 'two')],
    })
  ).rejects.toMatchObject({ code: 'RAILGUN_SESSION_REVOKED' });
});
