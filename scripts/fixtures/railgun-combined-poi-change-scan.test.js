// Orchestration controls only. Account/store/proof authority and the scan/list
// factory are mocked; genuine ownership, crypto and child exits require native.
let mockHistory, mockAccount, mockOwned, mockAcceptance, mockOpen, mockMatch;
jest.mock('../../src/main/wallet/railgun-own-poi-proof', () => ({
  assertRailgunOwnPoiProof: jest.fn(() => mockHistory),
}));
jest.mock('../../src/main/wallet/railgun-private-capsule', () => ({
  normalizeRailgunPrivateCapsule: jest.fn((value) => value),
}));
jest.mock('../../src/main/wallet/railgun-own-txid', () => ({
  matchRailgunOwnTxid: jest.fn(() => mockMatch),
}));
jest.mock('../../src/main/wallet/railgun-account-wallet', () => ({
  openRailgunAccountWallet: jest.fn((options) => mockOpen(options)),
  readRailgunAccountOwnedNotes: jest.fn((account) => {
    expect(account).toBe(mockAccount);
    return mockOwned;
  }),
}));
jest.mock('./railgun-combined-poi-list-acceptance', () => ({
  createCombinedPoiListAcceptance: jest.fn(() => mockAcceptance),
}));
const { scanCombinedPoiChange } = require('./railgun-combined-poi-change-scan');
const { createCombinedPoiListAcceptance } = require('./railgun-combined-poi-list-acceptance');
const { openRailgunAccountWallet } = require('../../src/main/wallet/railgun-account-wallet');
const sha = (value) =>
  require('crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let options, controller, entry;
beforeEach(() => {
  jest.clearAllMocks();
  const payload = { blindedCommitmentsOut: ['blinded'] };
  const capsule = {
    version: 2,
    walletId: 'wallet',
    noteHash: 'input',
    selection: { kind: 'railgun-partial-unshield', tree: 0, position: 1 },
    preparation: {
      inputAmount: '1000',
      unshieldAmount: '400',
      changeAmount: '600',
      expected: { changeCommitment: 'change', nullifier: 'nullifier' },
    },
  };
  mockHistory = {
    archive: 'archive',
    capture: {
      capsule,
      capsuleDigest: 'capsule',
      bindingDigest: 'binding',
      selector: { input: 1 },
    },
    preparation: { ownEvidence: { capsule } },
    payload,
    payloadSha256: sha(payload),
    inputSha256: 'inputSha',
  };
  mockMatch = {
    capsuleDigest: 'capsule',
    row: { txid: 'first', blockNumber: 40 },
    output: { kind: 'partial-unshield', change: { tree: 0, position: 3 } },
  };
  entry = {
    state: 'prepared',
    capsuleDigest: 'capsule',
    bindingDigest: 'binding',
    selector: { input: 1 },
    payload,
    payloadSha256: sha(payload),
    inputSha256: 'inputSha',
    revision: 1,
  };
  mockOwned = {
    checkpointHash: 'checkpoint',
    read: {
      received: [
        { id: '0:1', hash: 'input', amount: 1000n, spentTxid: '0xfirst', txid: '0xold' },
        {
          id: '0:3',
          tree: 0,
          position: 3,
          hash: 'change',
          amount: 600n,
          spentTxid: false,
          txid: '0xfirst',
          asset: {
            __type: 'erc20',
            contract: require('../../src/main/wallet/railgun-shield-pins.json').wrappedNative,
          },
        },
      ],
    },
    ownedPoi: [
      { id: '0:1', nullifier: 'nullifier', txid: '0xold' },
      {
        id: '0:3',
        hash: 'change',
        type: 'Transact',
        blockNumber: 40,
        txid: '0xfirst',
        blindedCommitment: 'blinded',
      },
    ],
  };
  mockAccount = { close: jest.fn(async () => {}) };
  mockOpen = async () => mockAccount;
  mockAcceptance = {
    close: jest.fn(),
    closed: Promise.resolve(),
    report: () => ({ accepted: false, postCalls: 0 }),
  };
  const store = { get: jest.fn(async () => JSON.parse(JSON.stringify(entry))) };
  controller = new AbortController();
  options = {
    archive: 'archive',
    proverArchive: 'prover',
    artifactDirectory: 'artifacts',
    proof: {},
    store,
    identity: {},
    coordinator: {},
    enrollment: { descriptor: { walletId: 'wallet' }, openPoiIntents: jest.fn(async () => store) },
    signal: controller.signal,
    signature: { sign: jest.fn() },
    originalNoteId: '0:1',
  };
});
test('joins prepared history and genuine scan factory before returning drained helper', async () => {
  const result = await scanCombinedPoiChange(options);
  expect(openRailgunAccountWallet).toHaveBeenCalledWith({
    identity: options.identity,
    enrollment: options.enrollment,
    coordinator: options.coordinator,
    archive: 'archive',
    mode: 'advance',
  });
  expect(options.enrollment.openPoiIntents).toHaveBeenCalledWith({ existingOnly: true });
  expect(createCombinedPoiListAcceptance.mock.calls[0][0].account).toBe(mockAccount);
  expect(createCombinedPoiListAcceptance.mock.calls[0][0].proof).toBe(options.proof);
  expect(createCombinedPoiListAcceptance.mock.calls[0][0].signal).toBe(controller.signal);
  expect(result.acceptance).toBe(mockAcceptance);
  expect(mockAccount.close).toHaveBeenCalledTimes(1);
  expect(result.diagnostics.walletClosedBeforeReturn).toBe(true);
  expect(result.diagnostics.scannedChangeSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.diagnostics).not.toHaveProperty('change');
  expect(options.signature.sign).not.toHaveBeenCalled();
});
test.each(['store', 'binding', 'payload', 'inputSha', 'selector', 'attempted', 'original-id'])(
  '%s mismatch refuses before wallet admission',
  async (fault) => {
    if (fault === 'store')
      options.enrollment.openPoiIntents.mockResolvedValue({ ...options.store });
    if (fault === 'binding') entry.bindingDigest = 'wrong';
    if (fault === 'payload') entry.payload = { blindedCommitmentsOut: ['wrong'] };
    if (fault === 'inputSha') entry.inputSha256 = 'wrong';
    if (fault === 'selector') entry.selector = { input: 2 };
    if (fault === 'attempted') entry.state = 'attempted';
    if (fault === 'original-id') options.originalNoteId = '0:2';
    await expect(scanCombinedPoiChange(options)).rejects.toThrow();
    expect(openRailgunAccountWallet).not.toHaveBeenCalled();
    expect(createCombinedPoiListAcceptance).not.toHaveBeenCalled();
  }
);
test.each(['unspent', 'wrong-spend', 'amount', 'hash', 'position', 'type', 'blinded', 'duplicate'])(
  '%s scan mismatch drains and refuses acceptance',
  async (fault) => {
    const [input, change] = mockOwned.read.received;
    if (fault === 'unspent') input.spentTxid = false;
    if (fault === 'wrong-spend') input.spentTxid = '0xother';
    if (fault === 'amount') change.amount = 599n;
    if (fault === 'hash') change.hash = 'wrong';
    if (fault === 'position') change.position = 4;
    if (fault === 'type') mockOwned.ownedPoi[1].type = 'Shield';
    if (fault === 'blinded') mockOwned.ownedPoi[1].blindedCommitment = 'wrong';
    if (fault === 'duplicate') mockOwned.read.received.push({ ...change });
    await expect(scanCombinedPoiChange(options)).rejects.toThrow();
    expect(mockAccount.close).toHaveBeenCalledTimes(1);
    expect(createCombinedPoiListAcceptance).not.toHaveBeenCalled();
  }
);
test('held opening cancellation waits for late handle then closes it', async () => {
  const entered = defer(),
    release = defer();
  mockOpen = async () => {
    entered.resolve();
    await release.promise;
    return mockAccount;
  };
  let settled = false;
  const work = scanCombinedPoiChange(options).finally(() => {
    settled = true;
  });
  const rejected = expect(work).rejects.toThrow();
  await entered.promise;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  release.resolve();
  await rejected;
  expect(mockAccount.close).toHaveBeenCalledTimes(1);
  expect(createCombinedPoiListAcceptance).not.toHaveBeenCalled();
});
test('held wallet close keeps acceptance private and cancellation destroys it after drain', async () => {
  const entered = defer(),
    release = defer();
  mockAccount.close.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  let settled = false;
  const work = scanCombinedPoiChange(options).finally(() => {
    settled = true;
  });
  const rejected = expect(work).rejects.toThrow();
  await entered.promise;
  expect(createCombinedPoiListAcceptance).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  controller.abort();
  release.resolve();
  await rejected;
  expect(mockAcceptance.close).toHaveBeenCalledTimes(1);
});
test('failed wallet drain never returns acceptance', async () => {
  mockAccount.close.mockRejectedValue(Error('close failed'));
  await expect(scanCombinedPoiChange(options)).rejects.toThrow('close failed');
  expect(mockAcceptance.close).toHaveBeenCalledTimes(1);
});
test('prepared entry changed during scan prevents acceptance', async () => {
  options.store.get.mockResolvedValueOnce(JSON.parse(JSON.stringify(entry)));
  mockOpen = async () => {
    entry.revision++;
    return mockAccount;
  };
  await expect(scanCombinedPoiChange(options)).rejects.toThrow();
  expect(mockAccount.close).toHaveBeenCalledTimes(1);
  expect(createCombinedPoiListAcceptance).not.toHaveBeenCalled();
});
