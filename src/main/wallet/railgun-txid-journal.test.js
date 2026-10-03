const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunTxidJournal } = require('./railgun-txid-journal');
const { getPrivacyStoragePath } = require('./privacy-storage');
const { ZERO_NODES } = require('./railgun-public-records');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const empty = () => ({
  version: 1,
  count: 0,
  root: ZERO_NODES[16],
  after: '0x00',
  verificationHash: null,
  branches: Array(16).fill(null),
  breaks: [],
  transcript: sha(''),
});
const next = () => ({
  ...empty(),
  count: 1,
  root: '1'.repeat(64),
  after: '0x' + '1'.repeat(192),
  verificationHash: '0x' + '2'.repeat(64),
  transcript: '3'.repeat(64),
});
let scope, options, journals, storeState, resultReceipts, rootReceipts, rootCurrent, filename;
function result(mode, payload, value) {
  const receipt = {};
  resultReceipts.set(receipt, { mode, payload: JSON.stringify(payload), value });
  return receipt;
}
function root(state) {
  const receipt = {};
  rootReceipts.set(receipt, { index: state.count - 1, root: state.root });
  return receipt;
}
const page = () => ({
  base: empty(),
  rows: [{ public: 'captured fixture row' }],
  expected: next(),
});
async function open(create, overrides = {}) {
  const journal = await createRailgunTxidJournal({ ...options, create, ...overrides });
  journals.push(journal);
  return journal;
}
function applied(payload) {
  storeState = { ...storeState, count: 4, bytes: 100, sha256: '9'.repeat(64) };
  return result('apply', payload, {
    state: payload.expected,
    pageSha256: sha(JSON.stringify(payload.rows)),
  });
}
async function prepare(journal, payload = page()) {
  return journal.prepare(
    payload,
    result(
      'project',
      { base: payload.base, rows: payload.rows },
      { state: payload.expected, pageSha256: sha(JSON.stringify(payload.rows)) }
    ),
    root(payload.expected)
  );
}
beforeEach(() => {
  scope = createPrivacyScope({
    profileId: 'txid-journal-test',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
    operation: 'railgun-txid-v1:' + 'c'.repeat(64),
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-txid-journal-'));
  filename = getPrivacyStoragePath(handle, directory);
  storeState = {
    schema: 'wallet-store-v1',
    storeId: 'a'.repeat(64),
    count: 0,
    bytes: 0,
    sha256: sha('empty'),
  };
  resultReceipts = new WeakMap();
  rootReceipts = new WeakMap();
  rootCurrent = true;
  journals = [];
  const identity = { format: 'paged-v2', instanceId: storeState.storeId };
  options = {
    handle,
    directory,
    key: Buffer.alloc(32, 73),
    binding: 'b'.repeat(64),
    policy: 'c'.repeat(64),
    publicIdentity: {
      generationId: 'd'.repeat(64),
      sourceId: 'e'.repeat(64),
      publicId: 'f'.repeat(64),
    },
    session: {
      signal: scope.signal,
      inspectStoreIdentity: async () => identity,
      inspectWalletState: async () => storeState,
      assertFresh: (value) => {
        if (value !== identity && value !== storeState) throw new Error('stale');
      },
    },
    assertResult: (receipt, mode, payload) => {
      const entry = resultReceipts.get(receipt);
      if (!entry || entry.mode !== mode || entry.payload !== JSON.stringify(payload))
        throw new Error('forged');
      return entry.value;
    },
    assertRoot: (receipt, point) => {
      const entry = rootReceipts.get(receipt);
      if (!rootCurrent || JSON.stringify(entry) !== JSON.stringify(point))
        throw new Error('stale root');
      return {
        ...point,
        service: 'sepolia-ppoi-fdi',
        accepted: true,
        observedAt: '2026-10-03T00:00:00.000Z',
        latestIndex: 100,
      };
    },
  };
});
afterEach(() => {
  journals.forEach((v) => v.close());
  scope.close();
});
test('pending page is durable before completion, then cold restore requires fresh root evidence', async () => {
  const journal = await open(true),
    payload = page();
  await journal.revalidate(result('inspect', {}, { state: empty(), initialized: false }));
  const token = await prepare(journal, payload);
  expect((await journal.readState()).pending.work).toEqual(payload);
  expect(fs.readFileSync(filename).includes(Buffer.from('captured fixture row'))).toBe(false);
  await journal.complete(token, applied(payload), root(payload.expected));
  expect((await journal.readState()).pending).toBeNull();
  journal.close();
  const reopened = await open(false);
  const checkpoint = await reopened.revalidate(
    result('inspect', {}, { state: next(), initialized: true }),
    root(next())
  );
  expect(checkpoint.state).toEqual(next());
  rootCurrent = false;
  await expect(
    reopened.revalidate(result('inspect', {}, { state: next(), initialized: true }), root(next()))
  ).rejects.toThrow();
});
test.each(['before-apply', 'after-apply'])(
  'recovers %s with a new lease and new apply/root receipts',
  async (stage) => {
    const journal = await open(true),
      payload = page();
    const oldToken = await prepare(journal, payload);
    if (stage === 'after-apply') applied(payload);
    journal.close();
    const reopened = await open(false);
    const current = stage === 'after-apply' ? next() : empty();
    const token = await reopened.resume(
      result('inspect', {}, { state: current, initialized: stage === 'after-apply' }),
      root(next())
    );
    expect(token).not.toBe(oldToken);
    await reopened.complete(token, applied(payload), root(next()));
    expect((await reopened.readState()).checkpoint.state.count).toBe(1);
  }
);
test.each(['policy', 'publicIdentity', 'storeId'])(
  'changed %s refuses reopen without changing the journal',
  async (kind) => {
    const journal = await open(true);
    journal.close();
    const before = fs.readFileSync(filename),
      overrides = {};
    if (kind === 'policy') overrides.policy = '9'.repeat(64);
    if (kind === 'publicIdentity')
      overrides.publicIdentity = { ...options.publicIdentity, publicId: '9'.repeat(64) };
    if (kind === 'storeId')
      overrides.session = {
        ...options.session,
        inspectStoreIdentity: async () => ({ format: 'paged-v2', instanceId: '9'.repeat(64) }),
        assertFresh: () => {},
      };
    await expect(open(false, overrides)).rejects.toThrow();
    expect(fs.readFileSync(filename)).toEqual(before);
  }
);
test('missing/duplicate creation, simultaneous owners and forged preparation refuse', async () => {
  await expect(open(false)).rejects.toThrow();
  const journal = await open(true);
  await expect(open(false)).rejects.toThrow();
  await expect(journal.prepare(page(), {}, root(next()))).rejects.toThrow();
  const before = fs.readFileSync(filename);
  await expect(open(true)).rejects.toThrow();
  expect(fs.readFileSync(filename)).toEqual(before);
});
test('unexpected store state during recovery refuses and retains pending work', async () => {
  const journal = await open(true);
  await prepare(journal);
  journal.close();
  const reopened = await open(false),
    before = fs.readFileSync(filename);
  await expect(
    reopened.resume(
      result('inspect', {}, { state: { ...next(), root: '2'.repeat(64) }, initialized: true }),
      root(next())
    )
  ).rejects.toThrow();
  expect(fs.readFileSync(filename)).toEqual(before);
});
test('changed whole-store digest cannot be accepted as the checkpoint baseline', async () => {
  const journal = await open(true),
    payload = page(),
    token = await prepare(journal, payload);
  await journal.complete(token, applied(payload), root(next()));
  journal.close();
  storeState = { ...storeState, sha256: '7'.repeat(64) };
  const reopened = await open(false);
  await expect(
    reopened.revalidate(result('inspect', {}, { state: next(), initialized: true }), root(next()))
  ).rejects.toThrow();
});
