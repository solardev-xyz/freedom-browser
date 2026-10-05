const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  startRailgunSessionWorker,
  startRailgunReadOnlySessionWorker,
} = require('./railgun-session-worker');
const {
  createRailgunWalletCoverageStore,
  createRailgunCompletedWalletCoverageStore,
} = require('./railgun-wallet-coverage-store');
const { normalizeRailgunWalletCoverage } = require('./railgun-wallet-coverage');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const { getRailgunWalletPrefixes } = require('./railgun-wallet-storage');
const noteKey = getRailgunWalletPrefixes('8'.repeat(64))[0] + ':note';
const b64 = (v) => Buffer.from(v).toString('base64');
function plan(count = 2, to = 10) {
  return {
    from: 0,
    previousHash: hash(0),
    to: { number: to, hash: hash(to) },
    anchor: { number: 100, hash: hash(100) },
    logs: { count, sha256: 'a'.repeat(64) },
    source: {
      level: 'unverified-rpc',
      providersSha256: 'b'.repeat(64),
      ledgerId: 'c'.repeat(64),
      ledgerSha256: 'd'.repeat(64),
    },
    state: {
      schema: 'public-records-v1',
      storeId: 'e'.repeat(64),
      trees: [{ tree: 0, length: count, root: hash(count) }],
      commitments: { count, sha256: 'f'.repeat(64) },
      nullifiers: { count: 0, sha256: '1'.repeat(64) },
      unshields: { count: 0, sha256: '2'.repeat(64) },
    },
  };
}
const coverage = () => ({
  scannedLeaves: 2,
  expectedReceived: [{ tree: 0, position: 0 }],
  expectedSent: [{ tree: 0, position: 1 }],
  quarantine: [],
  unrecoverableSent: [],
});
let scope, directory, workers;
beforeEach(() => {
  scope = createPrivacyScope({
    profileId: 'coverage-store-fixture',
    signal: new AbortController().signal,
  });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-wallet-coverage-'));
  workers = [];
});
afterEach(async () => {
  scope.close();
  for (const worker of workers) worker.close();
  await Promise.all(workers.map((w) => w.closed));
});
async function open(create, interrupt = false, assertScan, completedOnly = false, bare = false) {
  const session = (completedOnly ? startRailgunReadOnlySessionWorker : startRailgunSessionWorker)({
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'engine',
    }),
    storage: {
      format: 'paged-v2',
      filename: path.join(directory, 'wallet.sqlite'),
      key: Buffer.alloc(32, 77),
      binding: '7'.repeat(64),
      create,
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw Error('No RPC');
      },
    }),
    onClose: () => {},
  });
  workers.push(session);
  await session.ready;
  if (bare) return { session };
  const wrapped = interrupt
    ? {
        ...session,
        claimDispatch() {
          const grant = session.claimDispatch();
          return {
            async dispatch(wire) {
              const result = await grant.dispatch(wire);
              if (interrupt && JSON.parse(wire).method === 'txStage') session.close();
              return result;
            },
          };
        },
      }
    : session;
  return {
    session,
    store: (completedOnly
      ? createRailgunCompletedWalletCoverageStore
      : createRailgunWalletCoverageStore)({
      session: wrapped,
      walletId: '8'.repeat(64),
      policy: '9'.repeat(64),
      assertScan,
    }),
  };
}
test('keeps paged coverage across cold restoration and revokes the finished engine grant', async () => {
  const { session, store } = await open(true);
  expect(await store.read()).toBeNull();
  const grant = store.beginEngine();
  await grant.dispatch(
    JSON.stringify({
      id: 1,
      method: 'batch',
      args: { operations: [{ type: 'put', key: b64(noteKey), value: b64('derived') }] },
    })
  );
  store.finishEngine();
  const saved = await store.write(plan(), coverage());
  expect(saved.coverage).toEqual(normalizeRailgunWalletCoverage(plan(), coverage()));
  const state = await session.inspectWalletState();
  expect(state.count).toBe(4);
  store.close();
  await session.closed;
  const cold = await open(false);
  expect(await cold.store.read()).toEqual(saved);
  expect(await cold.session.inspectWalletState()).toEqual(state);
  await expect(
    grant.dispatch(JSON.stringify({ id: 2, method: 'get', args: { key: b64(noteKey) } }))
  ).rejects.toThrow();
});
test('provider changes preserve identical coverage bytes and changed same-checkpoint sets are refused', async () => {
  const { session, store } = await open(true);
  await store.write(plan(), coverage());
  const first = await session.inspectWalletState(),
    alternate = plan();
  alternate.source.providersSha256 = '3'.repeat(64);
  await store.write(alternate, coverage());
  expect(await session.inspectWalletState()).toEqual(first);
  const changed = coverage();
  changed.expectedReceived.push({ tree: 0, position: 1 });
  await expect(store.write(plan(), changed)).rejects.toThrow();
});
test('interruption after staging host pages retains the previous complete manifest and sets', async () => {
  const first = await open(true);
  const saved = await first.store.write(plan(), coverage());
  first.store.close();
  await first.session.closed;
  const interrupted = await open(false, true),
    next = coverage();
  next.scannedLeaves = 3;
  next.expectedReceived.push({ tree: 0, position: 2 });
  await expect(interrupted.store.write(plan(3, 20), next)).rejects.toThrow();
  await interrupted.session.closed;
  const cold = await open(false);
  expect(await cold.store.read()).toEqual(saved);
});
test('all four maximum-size sets exceed a journal value but fit authenticated coverage pages', async () => {
  const { session, store } = await open(true),
    value = {
      scannedLeaves: 40000,
      expectedReceived: [],
      expectedSent: [],
      quarantine: [],
      unrecoverableSent: [],
    };
  for (let n = 0; n < 10000; n++) {
    value.expectedReceived.push({ tree: 0, position: n });
    value.expectedSent.push({ tree: 0, position: 10000 + n });
    value.quarantine.push({
      tree: 0,
      position: 20000 + n,
      txid: hash(n),
      reason: 'commitment-mismatch',
    });
    value.unrecoverableSent.push({
      tree: 0,
      position: 30000 + n,
      txid: hash(n),
      reason: 'sent-note-unrecoverable',
    });
  }
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(1024 * 1024);
  const saved = await store.write(plan(40000), value);
  expect((await store.read()).summary).toEqual(saved.summary);
  expect((await session.inspectWalletState()).count).toBe(317);
});

test.each([
  'rpc',
  'clear',
  'txBegin',
  'txStage',
  'txCommit',
  'host-get',
  'host-put',
  'delete',
  'unbounded',
  'host-range',
  'unknown-cursor',
])('engine grant independently refuses %s', async (mode) => {
  const { store } = await open(true),
    grant = store.beginEngine();
  let method = mode,
    args = {};
  const host = b64('freedom:railgun:wallet-coverage:v1:manifest');
  if (mode === 'host-get') {
    method = 'get';
    args = { key: host };
  }
  if (mode === 'host-put' || mode === 'delete') {
    method = 'batch';
    args = {
      operations: [
        {
          type: mode === 'delete' ? 'del' : 'put',
          key: mode === 'delete' ? b64(noteKey) : host,
          value: b64('x'),
        },
      ],
    };
  }
  if (mode === 'unbounded' || mode === 'host-range') {
    method = 'open';
    args = {
      options:
        mode === 'unbounded' ? {} : { gte: host, lt: b64('freedom:railgun:wallet-coverage:v1:~') },
    };
  }
  if (mode === 'unknown-cursor') {
    method = 'seek';
    args = { cursor: 1, target: b64(noteKey) };
  }
  await expect(grant.dispatch(JSON.stringify({ id: 1, method, args }))).rejects.toThrow();
  expect(store.signal.aborted).toBe(true);
});
test('engine cursors cannot seek outside wallet keys or outlive their phase', async () => {
  const { store } = await open(true),
    grant = store.beginEngine();
  const prefix = getRailgunWalletPrefixes('8'.repeat(64))[0];
  const { value: cursor } = JSON.parse(
    await grant.dispatch(
      JSON.stringify({
        id: 1,
        method: 'open',
        args: { options: { gte: b64(prefix), lt: b64(prefix + '~') } },
      })
    )
  );
  expect(() => store.finishEngine()).toThrow();
  await expect(
    grant.dispatch(
      JSON.stringify({
        id: 2,
        method: 'seek',
        args: { cursor, target: b64('freedom:railgun:wallet-coverage:v1:manifest') },
      })
    )
  ).rejects.toThrow();
});

async function restorable() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-wallet-restore-'));
  const receipts = new WeakMap();
  const issue = (mode) => {
    const receipt = Object.freeze({});
    receipts.set(receipt, mode);
    return receipt;
  };
  const assertScan = (receipt, expected) => {
    expect(receipts.has(receipt)).toBe(true);
    if (expected.mode) expect(receipts.get(receipt)).toBe(expected.mode);
  };
  const opened = await open(true, false, assertScan),
    { store } = opened;
  const first = issue('scan'),
    initial = store.beginEngine();
  await initial.dispatch(
    JSON.stringify({
      id: 1,
      method: 'batch',
      args: {
        operations: [{ type: 'put', key: b64(noteKey), value: b64('derived') }],
      },
    })
  );
  store.finishEngine(first);
  const observation = await store.write(plan(), coverage(), first);
  return { ...opened, issue, first, initial, coverage: observation };
}
const getNote = (grant, id = 1) =>
  grant.dispatch(JSON.stringify({ id, method: 'get', args: { key: b64(noteKey) } }));

test('repeated read-only grants preserve bytes, reset IDs and require new restore receipts', async () => {
  const f = await restorable(),
    before = await f.session.inspectWalletState();
  for (let i = 0; i < 2; i++) {
    const window = new AbortController(),
      grant = f.store.beginRestore(window.signal);
    expect(() => f.store.assertCoverage(f.coverage, f.first)).toThrow();
    expect(JSON.parse(await getNote(grant)).value).toBe(b64('derived'));
    const receipt = f.issue('restore');
    f.store.finishRestore(receipt);
    expect(grant.signal.aborted).toBe(true);
    expect(grant.getStatus()).toEqual({ readOnly: true, writeAttempts: 0 });
    window.abort(); // finishing detached this window's cancellation hook
    const renewed = await f.store.read(receipt);
    expect(() => f.store.assertCoverage(renewed, receipt)).not.toThrow();
    expect(await f.session.inspectWalletState()).toEqual(before);
    expect(() => f.store.beginEngine()).toThrow();
  }
});
test.each(['batch', 'put', 'del', 'clear', 'txBegin', 'txStage', 'txCommit', 'txRollback'])(
  'read-only grant refuses %s and closes the session',
  async (method) => {
    const f = await restorable(),
      grant = f.store.beginRestore(new AbortController().signal);
    await expect(
      grant.dispatch(JSON.stringify({ id: 1, method, args: { operations: [] } }))
    ).rejects.toThrow();
    expect(grant.getStatus().writeAttempts).toBe(1);
    expect(f.store.signal.aborted).toBe(true);
  }
);
test.each([true, false])(
  'restore receipt cannot authorize coverage writes (supplied=%s)',
  async (supplied) => {
    const f = await restorable();
    f.store.beginRestore(new AbortController().signal);
    const receipt = f.issue('restore');
    f.store.finishRestore(receipt);
    await expect(
      f.store.write(plan(), coverage(), supplied ? receipt : undefined)
    ).rejects.toThrow();
    expect(f.store.signal.aborted).toBe(true);
  }
);
test('late old grant cannot operate during a newer read-only window', async () => {
  const f = await restorable(),
    old = f.store.beginRestore(new AbortController().signal);
  const receipt = f.issue('restore');
  f.store.finishRestore(receipt);
  await f.store.read(receipt);
  f.store.beginRestore(new AbortController().signal);
  await expect(getNote(old)).rejects.toThrow();
  expect(f.store.signal.aborted).toBe(true);
});
test('unfinished cursor, reused receipt and mismatched finish cannot revive a grant', async () => {
  for (const mode of ['cursor', 'receipt', 'finish']) {
    const f = await restorable(),
      grant = f.store.beginRestore(new AbortController().signal);
    if (mode === 'cursor') {
      const prefix = getRailgunWalletPrefixes('8'.repeat(64))[0];
      await grant.dispatch(
        JSON.stringify({
          id: 1,
          method: 'open',
          args: { options: { gte: b64(prefix), lt: b64(prefix + '~') } },
        })
      );
    }
    expect(() =>
      mode === 'finish'
        ? f.store.finishEngine(f.issue('restore'))
        : f.store.finishRestore(mode === 'receipt' ? f.first : f.issue('restore'))
    ).toThrow();
    expect(f.store.signal.aborted).toBe(true);
    expect(grant.signal.aborted).toBe(true);
    await f.session.closed;
  }
});
test('window cancellation revokes the grant and requires cold recovery', async () => {
  const f = await restorable(),
    window = new AbortController();
  const grant = f.store.beginRestore(window.signal);
  window.abort();
  expect(grant.signal.aborted).toBe(true);
  expect(f.store.signal.aborted).toBe(true);
  await expect(getNote(grant)).rejects.toThrow();
});
test('finishing with an in-flight request revokes and closes rather than granting readiness', async () => {
  const f = await restorable(),
    grant = f.store.beginRestore(new AbortController().signal);
  const pending = getNote(grant),
    refused = expect(pending).rejects.toThrow();
  expect(() => f.store.finishRestore(f.issue('restore'))).toThrow();
  await refused;
  expect(f.store.signal.aborted).toBe(true);
});
test('a restore receipt must be consumed once and cannot finish a later grant', async () => {
  const f = await restorable();
  f.store.beginRestore(new AbortController().signal);
  const receipt = f.issue('restore');
  f.store.finishRestore(receipt);
  expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
  await f.store.read(receipt);
  f.store.beginRestore(new AbortController().signal);
  expect(() => f.store.finishRestore(receipt)).toThrow();
  expect(f.store.signal.aborted).toBe(true);
});
test('read-only grant requires a consumed genuine scan receipt and live window', async () => {
  const { store, session } = await open(true);
  expect(() => store.beginRestore(new AbortController().signal)).toThrow();
  store.close();
  await session.closed;
  const f = await restorable(),
    window = new AbortController();
  window.abort();
  expect(() => f.store.beginRestore(window.signal)).toThrow();
  expect(() => f.store.beginRestore({})).toThrow();
});

async function completedFixture({ empty = false } = {}) {
  const first = await open(true);
  let persisted;
  if (!empty) persisted = await first.store.write(plan(), coverage());
  first.store.close();
  await first.session.closed;
  const receipts = new WeakSet();
  const issue = () => {
    const value = Object.freeze({});
    receipts.add(value);
    return value;
  };
  const assertScan = jest.fn((receipt, expected) => {
    if (!receipts.has(receipt)) throw Error('unissued receipt');
    if (expected.mode) expect(expected.mode).toBe('restore');
  });
  const cold = await open(false, false, assertScan, true);
  return { ...cold, persisted, issue, assertScan };
}
test('completed cold coverage requires its own persisted read before the first read-only grant and issues no early scan authority', async () => {
  const f = await completedFixture(),
    before = await f.session.inspectWalletState();
  expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
  expect(() => f.store.beginEngine()).toThrow();
  const saved = await f.store.read();
  expect(saved).toEqual(f.persisted);
  expect(Object.isFrozen(saved)).toBe(true);
  expect(Object.isFrozen(saved.coverage.expectedReceived)).toBe(true);
  expect(f.assertScan).not.toHaveBeenCalled();
  expect(() => f.store.assertCoverage(saved, f.issue())).toThrow();
  expect(() => f.store.assertCoverage(saved, null)).toThrow();
  const grant = f.store.beginRestore(new AbortController().signal);
  expect(grant.getStatus()).toEqual({ readOnly: true, writeAttempts: 0 });
  await getNote(grant);
  const receipt = f.issue();
  f.store.finishRestore(receipt);
  expect(() => f.store.assertCoverage(saved, receipt)).toThrow();
  const renewed = await f.store.read(receipt);
  expect(() => f.store.assertCoverage(renewed, receipt)).not.toThrow();
  expect(await f.session.inspectWalletState()).toEqual(before);
});
test('completed restoration consumes its initial observation once and repeats only through fresh genuine receipts', async () => {
  const f = await completedFixture();
  await f.store.read();
  let previous;
  for (let n = 0; n < 2; n++) {
    const grant = f.store.beginRestore(new AbortController().signal);
    expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
    expect(() => f.store.beginEngine()).toThrow();
    await getNote(grant);
    const receipt = f.issue();
    f.store.finishRestore(receipt);
    expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
    const observed = await f.store.read(receipt);
    expect(() => f.store.assertCoverage(observed, receipt)).not.toThrow();
    if (previous)
      expect(() => f.store.assertCoverage(previous.observed, previous.receipt)).toThrow();
    previous = { observed, receipt };
    // Root rechecks persisted coverage before the next RPC/utility window.
    expect(await f.store.read()).toEqual(f.persisted);
  }
});
test.each([
  'missing',
  'fake-receipt',
  'write-before-read',
  'write-after-read',
  'write-after-restore',
  'omitted-later-receipt',
  'reused-receipt',
  'wrong-finish',
  'expired-window',
])('completed coverage independently refuses %s', async (mode) => {
  const f = await completedFixture({ empty: mode === 'missing' });
  if (mode === 'missing') {
    await expect(f.store.read()).rejects.toThrow();
    expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
    return;
  }
  if (mode === 'write-before-read') {
    expect(() => f.store.write(plan(), coverage())).toThrow();
    return;
  }
  await f.store.read();
  if (mode === 'write-after-read') {
    expect(() => f.store.write(plan(), coverage())).toThrow();
    return;
  }
  const window = new AbortController(),
    grant = f.store.beginRestore(window.signal);
  if (mode === 'expired-window') {
    window.abort();
    await expect(getNote(grant)).rejects.toThrow();
    expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
    return;
  }
  if (mode === 'fake-receipt' || mode === 'wrong-finish') {
    expect(() =>
      mode === 'wrong-finish'
        ? f.store.finishEngine(f.issue())
        : f.store.finishRestore(Object.freeze({}))
    ).toThrow();
    return;
  }
  const receipt = f.issue();
  f.store.finishRestore(receipt);
  if (mode === 'write-after-restore') {
    expect(() => f.store.write(plan(), coverage(), receipt)).toThrow();
    return;
  }
  if (mode === 'omitted-later-receipt') {
    await expect(f.store.read()).resolves.toEqual(f.persisted);
    expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
    return;
  }
  await f.store.read(receipt);
  f.store.beginRestore(new AbortController().signal);
  expect(() => f.store.finishRestore(receipt)).toThrow();
});
test.each(['batch', 'txBegin', 'clear'])(
  'completed initial grant refuses %s without changing persisted wallet state',
  async (method) => {
    const f = await completedFixture(),
      before = await f.session.inspectWalletState();
    await f.store.read();
    const grant = f.store.beginRestore(new AbortController().signal);
    await expect(
      grant.dispatch(JSON.stringify({ id: 1, method, args: { operations: [] } }))
    ).rejects.toThrow();
    expect(grant.getStatus().writeAttempts).toBe(1);
    await f.session.closed;
    const cold = await open(false, false, f.assertScan, true);
    expect(await cold.session.inspectWalletState()).toEqual(before);
  }
);
test('ordinary cold coverage still cannot bootstrap restore from a raw persisted read', async () => {
  const f = await completedFixture();
  f.store.close();
  await f.session.closed;
  const ordinary = await open(false, false, f.assertScan);
  expect(await ordinary.store.read()).toEqual(f.persisted);
  expect(() => ordinary.store.beginRestore(new AbortController().signal)).toThrow();
});

test.each(['orphan', 'wrong-policy', 'checkpoint-hash', 'malformed-page'])(
  'completed initial read rejects authenticated logical %s corruption without granting restoration',
  async (mode) => {
    const f = await completedFixture();
    f.store.close();
    await f.session.closed;
    const { createRailgunPagedStore } = require('./railgun-paged-store');
    const raw = createRailgunPagedStore({
      handle: scope.getContext({
        kind: 'private-account',
        principal: 'fixture',
        protocol: 'railgun',
        deployment: 'fixture',
        chainId: 11155111,
        role: 'storage',
      }),
      filename: path.join(directory, 'wallet.sqlite'),
      key: Buffer.alloc(32, 77),
      binding: '7'.repeat(64),
      onFatal: () => {},
    });
    const prefix = 'freedom:railgun:wallet-coverage:v1:',
      key = Buffer.from(prefix + 'manifest');
    if (mode === 'orphan')
      raw.batch([{ type: 'put', key: Buffer.from(prefix + 'orphan'), value: Buffer.from('{}') }]);
    else if (mode === 'malformed-page')
      raw.batch([
        {
          type: 'put',
          key: Buffer.from(prefix + 'expectedReceived:0000'),
          value: Buffer.from('[]'),
        },
      ]);
    else {
      const value = JSON.parse(raw.get(key));
      if (mode === 'wrong-policy') value.policy = '0'.repeat(64);
      else value.checkpointHash = '0'.repeat(64);
      raw.batch([{ type: 'put', key, value: Buffer.from(JSON.stringify(value)) }]);
    }
    raw.close();
    const filename = path.join(directory, 'wallet.sqlite'),
      before = fs.readFileSync(filename);
    const cold = await open(false, false, f.assertScan, true);
    await expect(cold.store.read()).rejects.toThrow();
    expect(() => cold.store.beginRestore(new AbortController().signal)).toThrow();
    expect(f.assertScan).not.toHaveBeenCalled();
    await cold.session.closed;
    expect(fs.readFileSync(filename)).toEqual(before);
  }
);
test('initial persisted read must finish before restoration and a foreign observation cannot substitute', async () => {
  const f = await completedFixture();
  expect(() => f.store.beginRestore(new AbortController().signal, f.persisted)).toThrow();
  const pending = f.store.read();
  expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
  await pending;
  const expired = new AbortController();
  expired.abort();
  expect(() => f.store.beginRestore(expired.signal)).toThrow();
  expect(() => f.store.beginRestore({})).toThrow();
  expect(() => f.store.beginRestore(new AbortController().signal)).not.toThrow();
});

test.each([false, true])(
  'completed coverage omits every writable method (preread=%s)',
  async (preread) => {
    const f = await completedFixture();
    if (preread) await f.store.read();
    const before = await f.session.inspectWalletState();
    for (const method of ['beginEngine', 'finishEngine', 'write']) {
      expect(Object.hasOwn(f.store, method)).toBe(false);
      expect(f.store[method]).toBeUndefined();
    }
    expect(await f.session.inspectWalletState()).toEqual(before);
  }
);

test('completed factory requires a genuine readonly session before claiming dispatch', async () => {
  const options = { walletId: '8'.repeat(64), policy: '9'.repeat(64) };
  const mutable = await open(true, false, undefined, false, true);
  expect(() =>
    createRailgunCompletedWalletCoverageStore({ ...options, session: mutable.session })
  ).toThrow();
  // Rejection did not consume even the mutable session's exclusive dispatch.
  const ordinary = createRailgunWalletCoverageStore({ ...options, session: mutable.session });
  await ordinary.write(plan(), coverage());
  ordinary.close();
  await mutable.session.closed;
  const reader = await open(false, false, undefined, true, true);
  const claimed = jest.fn(() => reader.session.claimDispatch());
  const copy = { ...reader.session, readOnly: true, claimDispatch: claimed };
  expect(() => createRailgunCompletedWalletCoverageStore({ ...options, session: copy })).toThrow();
  expect(claimed).not.toHaveBeenCalled();
  const genuine = createRailgunCompletedWalletCoverageStore({
    ...options,
    session: reader.session,
  });
  await expect(genuine.read()).resolves.not.toBeNull();
  genuine.close();
  await reader.session.closed;
  expect(() =>
    createRailgunCompletedWalletCoverageStore({ ...options, session: reader.session })
  ).toThrow();
});
test('a failed intervening host read invalidates initial eligibility instead of reusing its old observation', async () => {
  const f = await completedFixture();
  const saved = await f.store.read();
  await expect(f.store.read(f.issue())).rejects.toThrow();
  expect(() => f.store.beginRestore(new AbortController().signal, saved)).toThrow();
  expect(f.store.signal.aborted).toBe(true);
});
test('a new prerequisite read must complete before first restore can use its refreshed observation', async () => {
  const f = await completedFixture();
  await f.store.read();
  const current = f.store.read();
  expect(() => f.store.beginRestore(new AbortController().signal)).toThrow();
  await current;
  expect(() => f.store.beginRestore(new AbortController().signal)).not.toThrow();
});
