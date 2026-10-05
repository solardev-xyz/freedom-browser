/** Observer contracts with explicit worker doubles; no native execution claim. */
const W = '../../src/main/wallet/';
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  jest.resetModules();
  const pending = [],
    start = jest.fn(() => {
      const barrier = deferred();
      const task = { closed: barrier.promise };
      pending.push({ task, ...barrier });
      return task;
    });
  const session = { startRailgunSessionWorker: start, startRailgunReadOnlySessionWorker: start };
  const runtime = { startRailgunProcess: jest.fn() };
  const identity = {
    withRailgunViewingCredential: (_identity, use) => {
      const viewingKey = Buffer.alloc(32, 1);
      try {
        return use({ viewingKey });
      } finally {
        viewingKey.fill(0);
      }
    },
  };
  jest.doMock(W + 'railgun-session-worker', () => session);
  jest.doMock(W + 'railgun-process', () => runtime);
  jest.doMock(W + 'railgun-identity', () => identity);
  const meter = require('./railgun-public-cold-observer').install();
  // Supply an observed, subsequently wiped loan for the existing close guard.
  identity.withRailgunViewingCredential({}, () => {});
  return { meter, session, start, pending, sticky: require('./railgun-native-assertions') };
}
function options(kind, create = false) {
  return {
    storage: {
      format: 'paged-v2',
      filename: '/disposable/' + kind + (create ? '.init-' + 'a'.repeat(32) : '') + '.sqlite',
      create,
    },
  };
}
afterEach(() => {
  for (const name of ['railgun-session-worker', 'railgun-process', 'railgun-identity'])
    jest.dontMock(W + name);
});
test('observer counts actual initializer and reopen calls separately and retains every exit barrier', async () => {
  const s = setup();
  for (const kind of ['source', 'public', 'wallet']) {
    const first = s.session.startRailgunSessionWorker(options(kind, true));
    expect(first).toBe(s.pending.at(-1).task);
    const second = s.session.startRailgunSessionWorker(options(kind));
    expect(second).toBe(s.pending.at(-1).task);
  }
  s.session.startRailgunSessionWorker(options('wallet'));
  expect(s.start).toHaveBeenCalledTimes(7);
  expect(s.meter.snapshot().workerKinds).toEqual({
    'source.initialize': 1,
    'source.open': 1,
    'public.initialize': 1,
    'public.open': 1,
    'wallet.initialize': 1,
    'wallet.open': 2,
  });
  const detached = s.meter.snapshot();
  detached.workerKinds['wallet.open'] = 999;
  expect(s.meter.snapshot().workerKinds['wallet.open']).toBe(2);
  let done = false;
  const closed = s.meter.close().then((value) => {
    done = true;
    return value;
  });
  for (const worker of s.pending.slice(0, -1)) worker.resolve({ exitCode: 0 });
  await new Promise(setImmediate);
  expect(done).toBe(false);
  s.pending.at(-1).resolve({ exitCode: 0 });
  const result = await closed;
  expect(result.workers).toBe(7);
  expect(result.workerResults).toHaveLength(7);
  expect(result.workerResults.every((v) => v.exitCode === 0)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('/disposable');
  expect(result.credentialBuffersWiped).toBe(true);
});
test('observer distinguishes completed read-only wallet from writable public-store reopen', async () => {
  const s = setup();
  s.session.startRailgunSessionWorker(options('source'));
  s.session.startRailgunSessionWorker(options('public'));
  s.session.startRailgunReadOnlySessionWorker(options('wallet'));
  s.pending.forEach((v) => v.resolve({ exitCode: 0 }));
  const value = await s.meter.close();
  expect(value.workerKinds).toEqual({ 'source.open': 1, 'public.open': 1, 'wallet.readOnly': 1 });
  expect(value.workers).toBe(3);
});
test.each(['create-installed', 'open-initializer', 'unknown-store', 'readonly-source'])(
  'unexpected worker classification %s sticks before factory',
  async (mode) => {
    const s = setup();
    const value = options('source', mode === 'open-initializer');
    if (mode === 'create-installed') value.storage.create = true;
    if (mode === 'open-initializer') value.storage.create = false;
    if (mode === 'unknown-store') value.storage.filename = '/disposable/txid.sqlite';
    const method =
      mode === 'readonly-source'
        ? 'startRailgunReadOnlySessionWorker'
        : 'startRailgunSessionWorker';
    expect(() => s.session[method](value)).toThrow();
    expect(s.start).not.toHaveBeenCalled();
    await expect(s.meter.close()).rejects.toThrow();
  }
);
test('nonzero actual worker exit remains sticky independently of category accounting', async () => {
  const s = setup();
  s.session.startRailgunSessionWorker(options('wallet'));
  s.pending[0].resolve({ exitCode: 1 });
  await expect(s.meter.close()).rejects.toThrow();
  expect(() => s.sticky.assertEmpty()).toThrow();
});
