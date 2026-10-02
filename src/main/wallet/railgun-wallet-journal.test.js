const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  createRailgunWalletJournal,
  assertRailgunWalletGenerationClosed,
} = require('./railgun-wallet-journal');
const {
  normalizeRailgunWalletCoverage,
  summarizeRailgunWalletCoverage,
} = require('./railgun-wallet-coverage');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const walletId = '8'.repeat(64),
  policy = '9'.repeat(64),
  storeId = '7'.repeat(64);
function plan(to = 10, count = 2) {
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
let scope, options, journals, currentEvidence, mode;
function evidence(checkpoint = plan()) {
  const coverage = normalizeRailgunWalletCoverage(checkpoint, {
    scannedLeaves: checkpoint.state.commitments.count,
    expectedReceived: [{ tree: 0, position: 0 }],
    expectedSent: [],
    quarantine: [],
    unrecoverableSent: [],
  });
  return {
    snapshot: checkpoint,
    receipt: Object.freeze({}),
    state: { schema: 'wallet-store-v1', storeId, count: 3, bytes: 500, sha256: '6'.repeat(64) },
    coverage: { checkpoint, coverage, summary: summarizeRailgunWalletCoverage(coverage) },
  };
}
beforeEach(() => {
  journals = [];
  mode = 'scan';
  currentEvidence = evidence();
  scope = createPrivacyScope({
    profileId: 'wallet-journal-test',
    signal: new AbortController().signal,
  });
  const session = {
    signal: scope.signal,
    closed: new Promise((resolve) =>
      scope.signal.addEventListener('abort', resolve, { once: true })
    ),
    inspectStoreIdentity: async () => ({ format: 'paged-v2', instanceId: storeId }),
    inspectWalletState: async () => currentEvidence.state,
    assertFresh: (v) => {
      if (v !== currentEvidence.state && v.instanceId !== storeId) throw Error('stale state');
    },
  };
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'storage',
      operation: 'railgun-wallet-v1:' + walletId,
    }),
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-wallet-journal-')),
    key: Buffer.alloc(32, 44),
    binding: '5'.repeat(64),
    walletId,
    policy,
    storeSession: session,
    coverageStore: {
      session,
      signal: scope.signal,
      assertCoverage: (v, receipt) => {
        if (v !== currentEvidence.coverage || receipt !== currentEvidence.receipt)
          throw Error('stale coverage');
      },
    },
    coordinator: {
      signal: scope.signal,
      assertSnapshot: (v) => {
        if (v !== currentEvidence.snapshot) throw Error('stale snapshot');
        return v;
      },
    },
    assertScan: (receipt, expected) => {
      if (receipt !== currentEvidence.receipt || (expected.mode && expected.mode !== mode))
        throw Error('invalid scan receipt');
    },
  };
});
afterEach(() => {
  journals.forEach((j) => j.close());
  scope.close();
});
async function open(create = true, override = {}) {
  const j = await createRailgunWalletJournal({ ...options, create, ...override });
  journals.push(j);
  return j;
}
test('durable pending work cannot grant readiness; checked completion is encrypted and restores only with a new validated restore', async () => {
  const j = await open(),
    token = await j.prepare(plan());
  expect((await j.readState()).pending.plan.to.number).toBe(10);
  expect(() => j.assertReady()).toThrow();
  await j.complete(token, currentEvidence);
  expect(j.assertReady()).toMatchObject({
    status: 'wallet-scanned-unverified',
    spendableGranted: false,
  });
  expect((await j.readState()).pending).toBeNull();
  j.close();
  const cold = await open(false);
  expect(() => cold.assertReady()).toThrow();
  await expect(cold.revalidate(currentEvidence)).rejects.toThrow();
  mode = 'restore';
  currentEvidence = evidence();
  expect(await cold.revalidate(currentEvidence)).toMatchObject({ spendableGranted: false });
  for (const name of fs.readdirSync(options.directory))
    expect(
      fs.readFileSync(path.join(options.directory, name)).includes(Buffer.from('wallet-store-v1'))
    ).toBe(false);
});
test.each(['snapshot', 'state', 'coverage', 'receipt'])(
  'cloned %s cannot complete pending work',
  async (field) => {
    const j = await open(),
      token = await j.prepare(plan());
    await expect(
      j.complete(token, { ...currentEvidence, [field]: structuredClone(currentEvidence[field]) })
    ).rejects.toThrow();
    expect(() => j.assertReady()).toThrow();
    const cold = await open(false);
    expect((await cold.readState()).pending).not.toBeNull();
  }
);
test('later dispatch or snapshot invalidates already granted readiness', async () => {
  const j = await open(),
    token = await j.prepare(plan());
  await j.complete(token, currentEvidence);
  currentEvidence = evidence();
  expect(() => j.assertReady()).toThrow();
});
test('pending interruption is recovered by a new scan token, never by restore', async () => {
  const j = await open(),
    old = await j.prepare(plan());
  j.close();
  const cold = await open(false);
  mode = 'restore';
  await expect(cold.revalidate(currentEvidence)).rejects.toThrow();
  await expect(cold.complete(old, currentEvidence)).rejects.toThrow();
  mode = 'scan';
  const token = await cold.prepare(plan());
  await cold.complete(token, currentEvidence);
  expect(cold.assertReady().to.number).toBe(10);
});
test('cold changed whole-cache digest refuses readiness even with valid coverage and scan receipt', async () => {
  const j = await open(),
    token = await j.prepare(plan());
  await j.complete(token, currentEvidence);
  j.close();
  const cold = await open(false);
  mode = 'restore';
  currentEvidence = evidence();
  currentEvidence.state.sha256 = '4'.repeat(64);
  await expect(cold.revalidate(currentEvidence)).rejects.toThrow();
  expect(() => cold.assertReady()).toThrow();
});
test('coverage from another derived session and changed policy are refused', async () => {
  await expect(
    open(true, { coverageStore: { ...options.coverageStore, session: {} } })
  ).rejects.toThrow();
  const j = await open();
  j.close();
  await expect(open(false, { policy: '3'.repeat(64) })).rejects.toThrow();
});
test('same-target rescan cannot silently change a completed cache digest', async () => {
  const j = await open();
  await j.complete(await j.prepare(plan()), currentEvidence);
  const token = await j.prepare(plan());
  currentEvidence.state.sha256 = '4'.repeat(64);
  await expect(j.complete(token, currentEvidence)).rejects.toThrow();
});
test('higher checkpoint preserves pending lineage and cannot regress tree root', async () => {
  const j = await open();
  await j.prepare(plan());
  const next = plan(20);
  next.state.trees[0].root = hash(99);
  await expect(j.prepare(next)).rejects.toThrow();
});

test('failed journal construction still holds generation ownership until the worker has exited', async () => {
  let exited;
  options.storeSession.closed = new Promise((resolve) => {
    exited = resolve;
  });
  options.storeSession.inspectStoreIdentity = async () => {
    throw Error('identity unavailable');
  };
  await expect(open()).rejects.toThrow();
  expect(() => assertRailgunWalletGenerationClosed(options.directory)).toThrow();
  exited();
  await Promise.resolve();
  expect(() => assertRailgunWalletGenerationClosed(options.directory)).not.toThrow();
});

test('read evidence requires the exact current receipt and cannot be reassigned by its caller', async () => {
  const j = await open(),
    evidence = { ...currentEvidence },
    receipt = evidence.receipt;
  await j.complete(await j.prepare(plan()), evidence);
  expect(j.assertReceipt(receipt).status).toBe('wallet-scanned-unverified');
  expect(() => j.assertReceipt({})).toThrow();
  evidence.receipt = {};
  expect(() => j.assertReceipt(receipt)).not.toThrow();
  await j.prepare(plan());
  expect(() => j.assertReceipt(receipt)).toThrow();
});
