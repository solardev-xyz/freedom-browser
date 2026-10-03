const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const { createRailgunWalletCoverageStore } = require('./railgun-wallet-coverage-store');
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
async function open(create, interrupt = false, assertScan) {
  const session = startRailgunSessionWorker({
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
  const wrapped = interrupt
    ? {
        ...session,
        claimDispatch() {
          const grant = session.claimDispatch();
          return {
            async dispatch(wire) {
              const result = await grant.dispatch(wire);
              if (JSON.parse(wire).method === 'txStage') session.close();
              return result;
            },
          };
        },
      }
    : session;
  return {
    session,
    store: createRailgunWalletCoverageStore({
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
