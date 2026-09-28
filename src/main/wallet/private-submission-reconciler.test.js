const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createSubmissionJournal } = require('./private-submission-journal');
const { createSubmissionReconciler } = require('./private-submission-reconciler');
const principal = `0x${'1'.repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const subject = { kind: 'public-address', principal, chainId: 11155111, role: 'transaction-rpc' };
const accept = async () => ({ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' });
let scope, handle, journal, reconciler, rpc, responses, directory;
function included(status = '0x1') {
  responses.eth_getTransactionReceipt = { transactionHash: hash, from: principal, status, blockHash, blockNumber: '0x10' };
}
beforeEach(async () => {
  scope = createPrivacyScope({ profileId: 'reconciliation-fixture', signal: new AbortController().signal });
  handle = scope.getContext(subject);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciliation-fixture-'));
  journal = createSubmissionJournal({ handle, directory, key: Buffer.alloc(32, 7) });
  await journal.begin(hash, 7);
  responses = { eth_getTransactionReceipt: null, eth_getTransactionByHash: null,
    eth_getBlockByNumber: { number: '0x10', hash: blockHash }, eth_blockNumber: '0x12', eth_getTransactionCount: '0x7' };
  rpc = { signal: getPrivacyContext(handle).signal, request: jest.fn(async (method, _params, validate) => {
    const result = responses[method];
    if (!validate(result)) throw Object.assign(new Error('Invalid result'), { code: 'PRIVATE_RPC_INVALID' });
    return { result };
  }) };
  reconciler = createSubmissionReconciler({ rpc, journal, principal, assertActive: () => getPrivacyContext(handle) });
});
afterEach(() => scope.close());

test('a consumed finalized nonce resolves an unknown outcome only after review, without claiming replacement or success', async () => {
  responses.eth_getTransactionCount = '0x8';
  const observed = await reconciler.observe(hash);
  expect(observed.observation).toMatchObject({ status: 'nonce-consumed', finalizedNonce: 8, blockNumber: 16, trust: 'unverified' });
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  await reconciler.resolve(hash, { minimumConfirmations: 2, review: accept });
  await expect(journal.assertCanSubmit()).resolves.toBeUndefined();
  await expect(journal.begin(`0x${'c'.repeat(64)}`, 7)).rejects.toMatchObject({ code: 'PRIVATE_NONCE_REUSE_REFUSED' });
  expect(rpc.request.mock.calls.filter(([method]) => method === 'eth_getTransactionCount').every(([, params]) => params[1] === '0x10')).toBe(true);
  responses.eth_getTransactionCount = '0x7';
  expect(await reconciler.observe(hash)).toMatchObject({ resolution: null, observation: { status: 'reorged' } });
});

test('nonce consumption that changes during review cannot release an uncertain public attempt', async () => {
  responses.eth_getTransactionCount = '0x8';
  await expect(reconciler.resolve(hash, { minimumConfirmations: 2, review: async () => {
    responses.eth_getTransactionCount = '0x7'; return accept();
  } })).rejects.toMatchObject({ code: 'PRIVATE_REVIEW_STALE' });
  await expect(journal.assertCanSubmit()).rejects.toThrow();
});

test('unknown and pending observations never release the next-send gate or write signed bytes', async () => {
  expect((await reconciler.observe(hash)).observation).toMatchObject({ status: 'unknown', confirmations: 0, trust: 'unverified' });
  responses.eth_getTransactionByHash = { hash, from: principal, nonce: '0x7', blockHash };
  expect((await reconciler.observe(hash)).observation.status).toBe('pending');
  const review = jest.fn(accept);
  await expect(reconciler.resolve(hash, { minimumConfirmations: 1, review })).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
  expect(review).not.toHaveBeenCalled();
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
  expect(rpc.request.mock.calls.every(([method]) => !method.includes('send'))).toBe(true);
});

test.each(['0x1', '0x0'])('included/reverted evidence %s requires a frozen explicit review and a fresh matching receipt', async (status) => {
  included(status);
  const review = jest.fn(async (intent) => {
    expect(Object.isFrozen(intent)).toBe(true); expect(Object.isFrozen(intent.observation)).toBe(true);
    expect(intent).toMatchObject({ action: 'allow-next-transaction', transactionHash: hash, nonce: 7, minimumConfirmations: 3,
      observation: { status: status === '0x1' ? 'included' : 'reverted', confirmations: 3, trust: 'unverified' } });
    return accept();
  });
  const resolved = await reconciler.resolve(hash, { minimumConfirmations: 3, review });
  expect(resolved.resolution).toMatchObject({ blockHash, minimumConfirmations: 3 });
  expect(review).toHaveBeenCalledTimes(1);
  expect(rpc.request.mock.calls.filter(([method]) => method === 'eth_getTransactionReceipt')).toHaveLength(2);
  await expect(journal.assertCanSubmit()).resolves.toBeUndefined();
  await expect(journal.begin(hash, 7)).rejects.toMatchObject({ code: 'PRIVATE_BROADCAST_ALREADY_ATTEMPTED' });
  await expect(journal.begin(`0x${'c'.repeat(64)}`, 7)).rejects.toMatchObject({ code: 'PRIVATE_NONCE_REUSE_REFUSED' });
  await journal.begin(`0x${'c'.repeat(64)}`, 8);
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
});

test('missing policy, insufficient depth and implicit evidence acceptance fail closed', async () => {
  included();
  await expect(reconciler.resolve(hash)).rejects.toMatchObject({ code: 'PRIVATE_RECONCILIATION_REVIEW_REQUIRED' });
  await expect(reconciler.resolve(hash, { minimumConfirmations: 4, review: accept })).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
  for (const decision of [true, { allowNextTransaction: true }, { allowNextTransaction: true, acceptedEvidence: 'verified' }]) {
    await expect(reconciler.resolve(hash, { minimumConfirmations: 1, review: async () => decision }))
      .rejects.toMatchObject({ code: 'PRIVATE_REVIEW_REJECTED' });
  }
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
});

test.each(['missing', 'block', 'status', 'head'])('evidence change during review (%s) invalidates permission', async (change) => {
  included();
  const review = async () => {
    if (change === 'missing') responses.eth_getTransactionReceipt = null;
    if (change === 'block') responses.eth_getBlockByNumber.hash = `0x${'c'.repeat(64)}`;
    if (change === 'status') responses.eth_getTransactionReceipt.status = '0x0';
    if (change === 'head') responses.eth_blockNumber = '0xf';
    return accept();
  };
  await expect(reconciler.resolve(hash, { minimumConfirmations: 2, review })).rejects.toMatchObject({
    code: ['missing', 'head'].includes(change) ? 'PRIVATE_RECONCILIATION_UNAVAILABLE' : 'PRIVATE_REVIEW_STALE' });
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
});

test('lock and deadline terminate review; callback errors do not expose their contents', async () => {
  included();
  await expect(reconciler.resolve(hash, { minimumConfirmations: 1, review: () => new Promise(() => {}), reviewTimeoutMs: 5 }))
    .rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  await expect(reconciler.resolve(hash, { minimumConfirmations: 1, review: () => { throw new Error('sensitive details'); } }))
    .rejects.toMatchObject({ code: 'PRIVATE_REVIEW_REJECTED', message: 'Reconciliation review failed' });
  await expect(reconciler.resolve(hash, { minimumConfirmations: 1, review: () => { scope.close(); return accept(); } }))
    .rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
});

test('resolution survives reopening; disappearing inclusion revokes it durably', async () => {
  included();
  await reconciler.resolve(hash, { minimumConfirmations: 2, review: accept });
  scope.close();
  scope = createPrivacyScope({ profileId: 'reconciliation-fixture', signal: new AbortController().signal });
  handle = scope.getContext(subject);
  journal = createSubmissionJournal({ handle, directory, key: Buffer.alloc(32, 7) });
  await expect(journal.assertCanSubmit()).resolves.toBeUndefined();
  reconciler = createSubmissionReconciler({ rpc: { ...rpc, signal: getPrivacyContext(handle).signal }, journal, principal,
    assertActive: () => getPrivacyContext(handle) });
  responses.eth_getTransactionReceipt = null;
  responses.eth_getBlockByNumber.hash = `0x${'c'.repeat(64)}`;
  expect(await reconciler.observe(hash)).toMatchObject({ resolution: null, observation: { status: 'reorged' } });
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
});

test('missing receipts and RPC failures preserve reviewed history while preventing use of unavailable evidence', async () => {
  included(); await reconciler.resolve(hash, { minimumConfirmations: 2, review: accept });
  const before = await journal.list();
  rpc.request.mockRejectedValueOnce(new Error('Temporary RPC outage'));
  await expect(reconciler.observe(hash)).rejects.toThrow();
  expect(await journal.list()).toEqual(before);
  responses.eth_getTransactionReceipt = null;
  await expect(reconciler.observe(hash)).rejects.toMatchObject({ code: 'PRIVATE_RECONCILIATION_UNAVAILABLE' });
  expect(await journal.list()).toEqual(before);
  responses.eth_getBlockByNumber.transactions = [hash];
  expect(await reconciler.observe(hash)).toMatchObject({ resolution: before[0].resolution, observation: { status: 'included' } });
});

test('a later observation wins over an earlier RPC response still in flight', async () => {
  included();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  rpc.request.mockImplementationOnce(async () => { await pending; return { result: null }; });
  const earlier = reconciler.observe(hash);
  await new Promise(setImmediate);
  expect((await reconciler.observe(hash)).observation.status).toBe('included');
  release();
  await expect(earlier).rejects.toMatchObject({ code: 'PRIVATE_RECONCILIATION_STALE' });
  expect((await journal.list())[0].observation.status).toBe('included');
});

test('untracked hashes, wrong owner/nonce and malformed chain data cannot create observations', async () => {
  await expect(reconciler.observe(`0x${'f'.repeat(64)}`)).rejects.toMatchObject({ code: 'PRIVATE_TRANSACTION_REQUEST_REFUSED' });
  expect(rpc.request).not.toHaveBeenCalled();
  responses.eth_getTransactionByHash = { hash, from: principal, nonce: '0x8', blockHash: null };
  await expect(reconciler.observe(hash)).rejects.toMatchObject({ code: 'PRIVATE_RPC_INVALID' });
  included(); responses.eth_getTransactionReceipt.from = `0x${'2'.repeat(40)}`;
  await expect(reconciler.observe(hash)).rejects.toMatchObject({ code: 'PRIVATE_RPC_INVALID' });
  included(); responses.eth_getBlockByNumber.number = '0x11';
  await expect(reconciler.observe(hash)).rejects.toMatchObject({ code: 'PRIVATE_RPC_INVALID' });
  expect((await journal.list())[0].observation).toBeUndefined();
});

test('compact refresh preserves reviewed history on unavailable/wrong-height evidence and invalidates a changed canonical hash', async () => {
  included(); await reconciler.resolve(hash, { minimumConfirmations: 2, review: accept });
  const before = await journal.list();
  for (const value of [null, { number: '0x11', hash: blockHash }]) {
    responses.eth_getBlockByNumber = value;
    await expect(reconciler.refreshResolved()).rejects.toMatchObject({ code: 'PRIVATE_RECONCILIATION_UNAVAILABLE' });
    expect(await journal.list()).toEqual(before);
  }
  responses.eth_getBlockByNumber = { number: '0x10', hash: blockHash };
  responses.eth_getTransactionReceipt = null; rpc.request.mockClear();
  await reconciler.refreshResolved();
  expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(['eth_blockNumber', 'eth_getBlockByNumber']);
  expect((await journal.list())[0].resolution).toBeTruthy();
  responses.eth_getBlockByNumber.hash = `0x${'c'.repeat(64)}`;
  await reconciler.refreshResolved();
  expect((await journal.list())[0]).toMatchObject({ resolution: null, observation: { status: 'reorged' } });
});

test('an aborted compact refresh cannot commit a delayed block response', async () => {
  included(); await reconciler.resolve(hash, { minimumConfirmations: 2, review: accept });
  const before = await journal.list(), controller = new AbortController();
  let release;
  const original = rpc.request.getMockImplementation();
  rpc.request.mockImplementation((method, params, validate) => method === 'eth_getBlockByNumber'
    ? new Promise((resolve) => { release = () => resolve({ result: responses.eth_getBlockByNumber }); }) : original(method, params, validate));
  const pending = reconciler.refreshResolved(controller.signal);
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  expect(release).toEqual(expect.any(Function));
  controller.abort(); release();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVATE_RECONCILIATION_UNAVAILABLE' });
  expect(await journal.list()).toEqual(before);
});
