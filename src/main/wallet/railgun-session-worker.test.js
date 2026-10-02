const fs = require('fs');
const os = require('os');
const path = require('path');
let mockWorkerPause, mockWorkerPauseMode, mockWorkerOutOfMemory;
const mockWorkerFailures = [];
jest.mock('worker_threads', () => {
  const actual = jest.requireActual('worker_threads');
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename, options) {
        if (mockWorkerOutOfMemory) {
          super(
            'const retained = []; while (true) retained.push(new Array(100000).fill("public"));',
            {
              ...options,
              eval: true,
              resourceLimits: { maxOldGenerationSizeMb: 8 },
            }
          );
          this.on('error', (error) => mockWorkerFailures.push(error.code));
          return;
        }
        if (!mockWorkerPause) {
          super(filename, options);
          return;
        }
        // Test-only instrumentation. Production always uses its fixed entry and
        // has no hook for executable input or pausing database transactions.
        const source = `
        const { workerData } = require('worker_threads');
        const Database = require(workerData.databaseModule);
        const original = Database.prototype.prepare;
        let changed = false;
        const pause = () => {
          const marker = new Int32Array(workerData.pause);
          Atomics.store(marker, 0, 1);
          Atomics.wait(marker, 1, 0, 10000);
        };
        const transaction = Database.prototype.transaction;
        Database.prototype.transaction = function(fn) {
          const invoke = transaction.call(this, fn);
          return (...args) => {
            const result = invoke(...args);
            if (changed && workerData.pauseMode === 'after') pause();
            return result;
          };
        };
        Database.prototype.prepare = function(sql) {
          const statement = original.call(this, sql);
          if (sql.startsWith('UPDATE records SET ciphertext')) {
            const run = statement.run;
            statement.run = function(...args) {
              const result = run.apply(this, args);
              changed = true;
              if (workerData.pauseMode === 'before') pause();
              return result;
            };
          }
          return statement;
        };
        require(workerData.entry);
      `;
        super(source, {
          ...options,
          eval: true,
          workerData: {
            ...options.workerData,
            pause: mockWorkerPause,
            pauseMode: mockWorkerPauseMode,
            entry: filename,
            databaseModule: require.resolve('better-sqlite3'),
          },
        });
      }
    },
  };
});
const { createPrivacyScope } = require('../networks/privacy-context');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
let scope, options, worker;
const workers = [];
const b64 = (text) => Buffer.from(text).toString('base64');
const wire = (id, method, args) => JSON.stringify({ id, method, args });
const put = (key, value) => ({ type: 'put', key: b64(key), value: b64(value) });
function start(overrides = {}) {
  worker = startRailgunSessionWorker({ ...options, ...overrides });
  workers.push(worker);
  return worker;
}
async function call(id, method, args) {
  return JSON.parse(await worker.dispatch(wire(id, method, args))).value;
}
beforeEach(() => {
  mockWorkerPause = undefined;
  mockWorkerPauseMode = 'before';
  mockWorkerOutOfMemory = false;
  mockWorkerFailures.length = 0;
  scope = createPrivacyScope({ profileId: 'worker-fixture', signal: new AbortController().signal });
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      chainId: 11155111,
      protocol: 'railgun',
      deployment: 'public-fixture',
      role: 'engine',
    }),
    storage: {
      filename: path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-worker-')),
        'state.sqlite'
      ),
      key: Buffer.alloc(32, 9),
      binding: 'b'.repeat(64),
      format: 'paged-v2',
      create: true,
    },
    createProvider: ({ signal }) => ({ signal, request: async () => '0xaa36a7' }),
    onClose: jest.fn(),
  };
});
afterEach(async () => {
  for (const item of workers) item.close();
  await Promise.all(workers.splice(0).map((item) => item.closed));
  scope.close();
});
test('real worker preserves ordered writes, binary reads, cursors and cold restoration', async () => {
  start();
  const pendingWrite = worker.dispatch(
    wire(1, 'batch', { operations: [put('a', 'value-a'), put('b', 'value-b')] })
  );
  const pendingRead = worker.dispatch(wire(2, 'get', { key: b64('a') }));
  await pendingWrite;
  expect(JSON.parse(await pendingRead).value).toBe(b64('value-a'));
  const cursor = await call(3, 'open', { options: {} });
  await call(4, 'batch', { operations: [put('a', 'new')] });
  expect(await call(5, 'nextMany', { cursor, limit: 128 })).toEqual({
    rows: [
      [b64('a'), b64('value-a')],
      [b64('b'), b64('value-b')],
    ],
    done: true,
  });
  await call(6, 'end', { cursor });
  worker.close();
  await worker.closed;
  start({ storage: { ...options.storage, create: false } });
  await worker.ready;
  expect(await call(1, 'get', { key: b64('a') })).toBe(b64('new'));
  expect(fs.readFileSync(options.storage.filename).includes(Buffer.from('value-b'))).toBe(false);
});
test('staged transaction dies on lock and reopens without partial writes or a retained lock', async () => {
  start();
  await worker.ready;
  await call(1, 'batch', { operations: [put('old', 'value')] });
  const transaction = await call(2, 'txBegin', {});
  await call(3, 'txStage', { transaction, operations: [put('new', 'not-published')] });
  worker.close();
  expect(worker.signal.aborted).toBe(true);
  await worker.closed;
  start({ storage: { ...options.storage, create: false } });
  await worker.ready;
  expect(await call(1, 'get', { key: b64('new') })).toBeNull();
  expect(await call(2, 'get', { key: b64('old') })).toBe(b64('value'));
});
test('revokes immediately while RPC is pending, suppresses its late reply and holds ownership until exit', async () => {
  let reply, entered;
  const requested = new Promise((resolve) => {
    entered = resolve;
  });
  start({
    createProvider: ({ signal }) => ({
      signal,
      request: () =>
        new Promise((resolve) => {
          reply = resolve;
          entered();
        }),
    }),
  });
  await worker.ready;
  const pending = worker.dispatch(wire(1, 'rpc', { method: 'eth_chainId', params: [] }));
  const result = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_SESSION_REVOKED' });
  await requested;
  worker.close();
  expect(() => startRailgunSessionWorker(options)).toThrow('Railgun worker unavailable');
  reply('0xaa36a7');
  await result;
  await worker.closed;
  expect(options.onClose).toHaveBeenCalledTimes(1);
});
test('a malformed child command refuses the complete worker lifetime without leaking errors', async () => {
  start();
  await worker.ready;
  await expect(worker.dispatch('{not-json')).rejects.toMatchObject({
    code: 'RAILGUN_SESSION_REVOKED',
  });
  await worker.closed;
  expect(worker.signal.aborted).toBe(true);
});
test('the main-owned RPC scope is used and an RPC failure revokes the worker', async () => {
  let ownerSignal;
  const request = jest.fn(async () => {
    throw new Error('https://private.example/secret');
  });
  start({
    createProvider: ({ signal }) => {
      ownerSignal = signal;
      return { signal, request };
    },
  });
  await worker.ready;
  await expect(call(1, 'rpc', { method: 'eth_chainId', params: [] })).rejects.toThrow(
    'Railgun worker unavailable'
  );
  await worker.closed;
  expect(ownerSignal.aborted).toBe(true);
  expect(request).toHaveBeenCalledWith(
    { method: 'eth_chainId', params: [] },
    { signal: ownerSignal }
  );
});
test('queue overload before startup refuses every pending command', async () => {
  start();
  const calls = Array.from({ length: 9 }, (_, n) =>
    worker.dispatch(wire(n + 1, 'get', { key: b64('a') }))
  );
  const results = await Promise.allSettled(calls);
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  await worker.closed;
});
test.each([
  ['before', true],
  ['after', true],
  ['before', false],
  ['after', false],
])(
  'lock %s SQLite commit with forced termination=%s preserves the durable revision and releases the lock',
  async (mode, force) => {
    start();
    await worker.ready;
    await call(1, 'batch', { operations: [put('a', 'old')] });
    worker.close();
    await worker.closed;
    mockWorkerPause = new SharedArrayBuffer(8);
    mockWorkerPauseMode = mode;
    const marker = new Int32Array(mockWorkerPause);
    start({ storage: { ...options.storage, create: false } });
    await worker.ready;
    const write = expect(call(1, 'batch', { operations: [put('a', 'new')] })).rejects.toMatchObject(
      {
        code: 'RAILGUN_SESSION_REVOKED',
      }
    );
    const deadline = Date.now() + 3000;
    while (!Atomics.load(marker, 0) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(Atomics.load(marker, 0)).toBe(1);
    // Main refuses this queued call immediately. Forced exit prevents delivery;
    // the resumed variant additionally lets the worker observe revocation before
    // it can process queued work, even though close was posted after that work.
    const queued = expect(
      call(2, 'batch', { operations: [put('queued', 'must-not-commit')] })
    ).rejects.toMatchObject({ code: 'RAILGUN_SESSION_REVOKED' });
    // Flush the ready.then relay so the second command is in the worker's port,
    // rather than merely waiting in main's pre-ready continuation.
    await Promise.resolve();
    worker.close();
    if (!force) Atomics.notify(marker, 1);
    expect(worker.signal.aborted).toBe(true);
    await write;
    await queued;
    expect((await worker.closed).exitCode).toBe(force ? 1 : 0);
    mockWorkerPause = undefined;
    start({ storage: { ...options.storage, create: false } });
    await worker.ready;
    expect(await call(1, 'get', { key: b64('a') })).toBe(
      b64(mode === 'before' && force ? 'old' : 'new')
    );
    expect(await call(2, 'get', { key: b64('queued') })).toBeNull();
  },
  15000
);
test('failed startup rejects pre-ready commands and permits a corrected reopen after observed exit', async () => {
  start();
  await worker.ready;
  await call(1, 'batch', { operations: [put('a', 'kept')] });
  worker.close();
  await worker.closed;
  start({ storage: { ...options.storage, create: false, key: Buffer.alloc(32, 2) } });
  await expect(call(1, 'get', { key: b64('a') })).rejects.toMatchObject({
    code: 'RAILGUN_SESSION_REVOKED',
  });
  await expect(worker.ready).rejects.toMatchObject({ code: 'RAILGUN_SESSION_REVOKED' });
  await worker.closed;
  start({ storage: { ...options.storage, create: false } });
  await worker.ready;
  expect(await call(1, 'get', { key: b64('a') })).toBe(b64('kept'));
});
test('worker inspections retain synchronous host freshness and refuse queued writes, clones and reopened observations', async () => {
  start();
  await worker.ready;
  const frontier = await worker.inspectFrontier();
  expect(frontier.status).toBe('unscanned');
  expect(Object.isFrozen(frontier)).toBe(true);
  worker.assertFresh(frontier);
  expect(() => worker.assertFresh({ ...frontier })).toThrow();
  await expect(worker.inspectPosition(frontier, { tree: 0, index: 0 })).rejects.toMatchObject({
    code: 'RAILGUN_FRONTIER_NOT_ELIGIBLE',
  });
  const write = call(1, 'batch', { operations: [put('a', 'value')] });
  expect(() => worker.assertFresh(frontier)).toThrow();
  await write;
  const fresh = await worker.inspectFrontier();
  worker.assertFresh(fresh);
  const transaction = await call(2, 'txBegin', {});
  expect(() => worker.assertFresh(fresh)).toThrow();
  await expect(worker.inspectFrontier()).rejects.toMatchObject({ code: 'RAILGUN_FRONTIER_BUSY' });
  await call(3, 'txAbort', { transaction });
  const last = await worker.inspectFrontier();
  worker.assertFresh(last);
  worker.close();
  expect(() => worker.assertFresh(last)).toThrow();
  await worker.closed;
  start({ storage: { ...options.storage, create: false } });
  await worker.ready;
  expect(() => worker.assertFresh(last)).toThrow();
});
test('store identity is host-only, stable across reopen, and uses revocable observation freshness', async () => {
  start();
  await worker.ready;
  const identity = await worker.inspectStoreIdentity();
  expect(identity.format).toBe('paged-v2');
  expect(identity.instanceId).toMatch(/^[0-9a-f]{64}$/);
  worker.assertFresh(identity);
  expect(() => worker.assertFresh({ ...identity })).toThrow();
  expect(() => worker.inspectPosition(identity, { tree: 0, index: 0 })).toThrow(
    expect.objectContaining({ code: 'RAILGUN_FRONTIER_NOT_ELIGIBLE' })
  );
  await call(1, 'batch', { operations: [put('a', 'value')] });
  expect(() => worker.assertFresh(identity)).toThrow();
  worker.close();
  await worker.closed;
  start({ storage: { ...options.storage, create: false } });
  await worker.ready;
  expect((await worker.inspectStoreIdentity()).instanceId).toBe(identity.instanceId);
  await expect(call(1, 'storeIdentity', {})).rejects.toMatchObject({
    code: 'RAILGUN_SESSION_REVOKED',
  });
});
test('a heap-exhausted worker revokes pending work and releases ownership after observed exit', async () => {
  mockWorkerOutOfMemory = true;
  start();
  await expect(call(1, 'get', { key: b64('a') })).rejects.toMatchObject({
    code: 'RAILGUN_SESSION_REVOKED',
  });
  await worker.closed;
  expect(mockWorkerFailures).toContain('ERR_WORKER_OUT_OF_MEMORY');
  expect(options.onClose).toHaveBeenCalledTimes(1);
  mockWorkerOutOfMemory = false;
  start();
  await worker.ready;
});
test('worker positions are host-only, preserve ineligible refusal, and reject an inspection overtaken by a write', async () => {
  start();
  await worker.ready;
  const vectors = require('../../../docs/qualification/railgun-frontier-vectors-2026-10-02.json');
  const raw = (key, value) => ({ type: 'put', key: b64(key), value: value.toString('base64') });
  const leaf = Buffer.from('20'.padStart(64, '0'), 'hex');
  await call(1, 'batch', {
    operations: [
      raw(vectors.keys.metadata, Buffer.from(vectors.metadata[0].hex, 'hex')),
      raw(vectors.keys.history, Buffer.from('13')),
      raw(vectors.keys.synced, Buffer.from('9000000')),
      raw(vectors.keys.root0, Buffer.alloc(32, 1)),
      raw(vectors.keys.leaf31, leaf),
      raw(vectors.keys.data31, Buffer.from(JSON.stringify({ hash: leaf.toString('hex') }))),
    ],
  });
  const frontier = await worker.inspectFrontier();
  const position = await worker.inspectPosition(frontier, { tree: 0, index: 31 });
  expect(position.status).toBe('persisted-unverified');
  expect(() => worker.inspectPosition(position, { tree: 0, index: 31 })).toThrow(
    expect.objectContaining({ code: 'RAILGUN_FRONTIER_NOT_ELIGIBLE' })
  );
  worker.assertFresh(position);
  worker.assertFresh(frontier);
  await expect(worker.inspectPosition(frontier, { tree: 0, index: 32 })).rejects.toMatchObject({
    code: 'RAILGUN_FRONTIER_NOT_ELIGIBLE',
  });
  const pendingInspection = expect(worker.inspectFrontier()).rejects.toMatchObject({
    code: 'RAILGUN_FRONTIER_STALE',
  });
  await call(2, 'batch', { operations: [put('other', 'value')] });
  await pendingInspection;
  expect(() => worker.assertFresh(frontier)).toThrow();
  expect(worker.signal.aborted).toBe(false);
  const fresh = await worker.inspectFrontier();
  worker.assertFresh(fresh);
  for (let i = 0; i < 16; i++) await worker.inspectFrontier();
  await expect(worker.inspectPosition(fresh, { tree: 0, index: 31 })).rejects.toMatchObject({
    code: 'RAILGUN_FRONTIER_STALE',
  });
  await expect(call(3, 'inspectFrontier', {})).rejects.toMatchObject({
    code: 'RAILGUN_SESSION_REVOKED',
  });
  await worker.closed;
});
test('earlier writes precede worker inspection and pending RPC prevents freshness until idle', async () => {
  let reply, entered;
  const requested = new Promise((resolve) => {
    entered = resolve;
  });
  start({
    createProvider: ({ signal }) => ({
      signal,
      request: () =>
        new Promise((resolve) => {
          reply = resolve;
          entered();
        }),
    }),
  });
  await worker.ready;
  const write = call(1, 'batch', { operations: [put('a', 'value')] });
  const inspected = worker.inspectFrontier();
  await write;
  worker.assertFresh(await inspected);
  const rpc = call(2, 'rpc', { method: 'eth_chainId', params: [] });
  await requested;
  await expect(worker.inspectFrontier()).rejects.toMatchObject({ code: 'RAILGUN_FRONTIER_STALE' });
  reply('0xaa36a7');
  await rpc;
  worker.assertFresh(await worker.inspectFrontier());
  const late = expect(worker.inspectFrontier()).rejects.toMatchObject({
    code: 'RAILGUN_SESSION_REVOKED',
  });
  worker.close();
  await late;
});
test('a coordinator claims exclusive dispatch before use; old dispatch holders cannot bypass it', async () => {
  start();
  await worker.ready;
  const grant = worker.claimDispatch();
  expect(() => worker.claimDispatch()).toThrow();
  const wire = JSON.stringify({
    id: 1,
    method: 'get',
    args: { key: Buffer.from('missing').toString('base64') },
  });
  expect(JSON.parse(await grant.dispatch(wire)).value).toBeNull();
  await expect(
    worker.dispatch(
      JSON.stringify({
        id: 2,
        method: 'get',
        args: { key: Buffer.from('missing').toString('base64') },
      })
    )
  ).rejects.toThrow();
  expect(worker.signal.aborted).toBe(true);
});
test('a session already used by another dispatcher cannot be claimed', async () => {
  start();
  await worker.ready;
  await call(1, 'get', { key: Buffer.from('missing').toString('base64') });
  expect(() => worker.claimDispatch()).toThrow();
});
test('permits the three isolated scan stores and refuses a fourth or duplicate owner', async () => {
  const entries = [];
  for (const name of ['source', 'public', 'wallet']) {
    entries.push(
      start({
        storage: {
          ...options.storage,
          filename: path.join(path.dirname(options.storage.filename), name + '.sqlite'),
        },
      })
    );
  }
  await Promise.all(entries.map((entry) => entry.ready));
  expect(() =>
    start({
      storage: {
        ...options.storage,
        filename: path.join(path.dirname(options.storage.filename), 'fourth.sqlite'),
      },
    })
  ).toThrow();
  expect(() =>
    start({
      storage: {
        ...options.storage,
        filename: path.join(path.dirname(options.storage.filename), 'wallet.sqlite'),
      },
    })
  ).toThrow();
  entries[2].close();
  await entries[2].closed;
  const reopened = start({
    storage: {
      ...options.storage,
      filename: path.join(path.dirname(options.storage.filename), 'wallet.sqlite'),
      create: false,
    },
  });
  await reopened.ready;
});
test('wallet-store evidence binds exact persisted content and becomes stale on dispatch', async () => {
  start();
  await worker.ready;
  await call(1, 'batch', { operations: [put('wallet-note', 'derived')] });
  const first = await worker.inspectWalletState();
  expect(first).toMatchObject({ schema: 'wallet-store-v1', count: 1 });
  worker.assertFresh(first);
  expect(() => worker.assertFresh({ ...first })).toThrow();
  await call(2, 'get', { key: b64('wallet-note') });
  expect(() => worker.assertFresh(first)).toThrow();
  const second = await worker.inspectWalletState();
  expect(second).toEqual(first);
  worker.close();
  await worker.closed;
  start({ storage: { ...options.storage, create: false } });
  await worker.ready;
  const cold = await worker.inspectWalletState();
  expect(cold).toEqual(first);
  await call(1, 'batch', { operations: [put('wallet-note', 'changed')] });
  expect((await worker.inspectWalletState()).sha256).not.toBe(cold.sha256);
  const cursor = await call(2, 'open', { options: {} });
  await expect(worker.inspectWalletState()).rejects.toMatchObject({
    code: 'RAILGUN_FRONTIER_BUSY',
  });
  await call(3, 'end', { cursor });
  const transaction = await call(4, 'txBegin', {});
  await expect(worker.inspectWalletState()).rejects.toMatchObject({
    code: 'RAILGUN_FRONTIER_BUSY',
  });
  await call(5, 'txAbort', { transaction });
  worker.assertFresh(await worker.inspectWalletState());
});
