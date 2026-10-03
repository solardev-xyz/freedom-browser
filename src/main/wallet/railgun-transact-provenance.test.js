let mockStaged, mockWindow, mockCreator, mockClaim, mockRoots, mockVerified;
const mockServices = jest.fn(),
  mockCapture = jest.fn(),
  mockVerify = jest.fn(),
  mockRootFactory = jest.fn();
jest.mock('./railgun-transact-staging', () => ({
  claimRailgunTransactStaging: jest.fn(() => mockClaim),
}));
jest.mock('./railgun-account-wallet', () => ({
  assertRailgunAccountPrivateWindow: jest.fn(() => mockWindow),
  readRailgunAccountPrivateCreator: (...args) => mockCapture(...args),
  assertRailgunAccountPrivateCreator: jest.fn(() => mockCreator),
}));
jest.mock('./railgun-note-provenance', () => ({
  verifyRailgunNoteProvenance: (...args) => mockVerify(...args),
}));
jest.mock('./railgun-public-services', () => ({
  createRailgunPublicServices: (...args) => mockServices(...args),
}));
jest.mock('./railgun-txid-root', () => ({
  createRailgunTxidRootSource: (...args) => mockRootFactory(...args),
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  openRailgunTransactProvenance,
  assertRailgunTransactProvenance,
} = require('./railgun-transact-provenance');
let scope, caller, options, operations;
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
beforeEach(() => {
  jest.clearAllMocks();
  caller = new AbortController();
  scope = createPrivacyScope({ profileId: 'transact-provenance-test', signal: caller.signal });
  const signal = scope.signal;
  const enrollment = {
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'fixture',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      }),
  };
  options = {
    stagingReceipt: {},
    account: { signal },
    window: {},
    request: {},
    signal,
    owners: { enrollment, identity: {}, coordinator: {} },
  };
  mockWindow = { signal, deadline: performance.now() + 175000 };
  mockStaged = {
    bindings: { archive: '/pinned-engine.asar' },
    state: { count: 1, root: '1'.repeat(64) },
    baseline: {
      checkpointHash: '2'.repeat(64),
      owned: { txid: hex(40), hash: hex(20), blockNumber: 30 },
      selection: { tree: 0, position: 2 },
    },
    noteWitness: {
      witness: {
        row: { graphID: hex(30) + '0'.repeat(128), blockNumber: 30, txid: hex(40).slice(2) },
      },
    },
  };
  mockClaim = { signal, assertCurrent: jest.fn(() => mockStaged) };
  mockCreator = {
    eventSourceAuthenticated: true,
    checkpointHash: '2'.repeat(64),
    transactionDigest: '0x' + '3'.repeat(64),
    creator: { transactionIndex: 0, blockNumber: 30, transactionHash: hex(40), blockHash: hex(31) },
    note: { type: 'Transact', txid: hex(40), hash: hex(20), tree: 0, position: 2, blockNumber: 30 },
    events: [],
    source: { ledgerSha256: '4'.repeat(64) },
    logsSha256: '5'.repeat(64),
  };
  mockCapture.mockResolvedValue({ receipt: {} });
  mockVerified = {
    pathVerified: true,
    suppliedCreatorEventsMatched: true,
    utilityExitObserved: true,
    inputSha256: '6'.repeat(64),
    coverage: { boundParamsChecked: false, globalTxidCompleteness: false },
  };
  mockVerify.mockImplementation(async () => mockVerified);
  const rootValue = Object.freeze({ root: '1'.repeat(64), accepted: true });
  mockRoots = {
    acquire: jest.fn(async () => ({})),
    close: jest.fn(),
    assertRoot: jest.fn(() => rootValue),
  };
  mockRootFactory.mockImplementation(() => mockRoots);
  operations = [];
});
afterEach(async () => {
  await Promise.all(operations.map((op) => op.close()));
  caller.abort();
  scope.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
async function open(extra = {}) {
  const op = await openRailgunTransactProvenance({ ...options, ...extra });
  operations.push(op);
  return op;
}
const check = (op, receipt, margin = 0) =>
  assertRailgunTransactProvenance(
    op,
    receipt,
    options.account,
    options.owners,
    options.window,
    margin
  );
test('claims exact staging, verifies creator/path before opening a fixed root source, and binds receipt', async () => {
  const op = await open();
  expect(mockRootFactory).not.toHaveBeenCalled();
  expect(mockVerify).toHaveBeenCalledWith(
    expect.objectContaining({
      archive: '/pinned-engine.asar',
      state: mockStaged.state,
      note: mockCreator.note,
      noteWitness: mockStaged.noteWitness,
      events: mockCreator.events,
    })
  );
  const acquired = await op.acquireRoot();
  expect(mockRoots.acquire).toHaveBeenCalledWith({ index: 0, root: '1'.repeat(64) });
  expect(getPrivacyContext(mockRootFactory.mock.calls[0][0]).subject).toEqual({
    kind: 'service',
    principal: 'railgun-public-sync',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'public-services',
    operation: null,
  });
  const value = check(op, acquired.receipt, 20000);
  expect(value.transactionDigest).toBe(mockCreator.transactionDigest);
  expect(value.spendingEnabled).toBe(false);
  expect(mockClaim.assertCurrent).toHaveBeenCalledWith(20000);
  expect(mockRoots.assertRoot).toHaveBeenLastCalledWith(
    expect.any(Object),
    { index: 0, root: '1'.repeat(64) },
    20000
  );
  for (const args of [
    [{}, acquired.receipt, options.account, options.owners, options.window],
    [op, {}, options.account, options.owners, options.window],
    [op, acquired.receipt, {}, options.owners, options.window],
    [op, acquired.receipt, options.account, { ...options.owners, identity: {} }, options.window],
    [op, acquired.receipt, options.account, options.owners, {}],
  ])
    expect(() => assertRailgunTransactProvenance(...args)).toThrow();
  await op.close();
  expect(() => check(op, acquired.receipt)).toThrow();
});
test.each([
  'graph-index',
  'oversized-index',
  'block',
  'txid',
  'note',
  'checkpoint',
  'digest',
  'source',
  'path',
  'exit',
  'coverage',
])('changed %s cannot reach root acquisition', async (mode) => {
  if (mode === 'graph-index')
    mockStaged.noteWitness.witness.row.graphID = hex(30) + hex(1).slice(2) + '0'.repeat(64);
  if (mode === 'oversized-index')
    mockStaged.noteWitness.witness.row.graphID = hex(30) + 'f'.repeat(64) + '0'.repeat(64);
  if (mode === 'block') mockCreator.creator.blockNumber++;
  if (mode === 'txid') mockCreator.creator.transactionHash = hex(41);
  if (mode === 'note') mockCreator.note.position++;
  if (mode === 'checkpoint') mockCreator.checkpointHash = '0'.repeat(64);
  if (mode === 'digest') mockCreator.transactionDigest = '';
  if (mode === 'source') mockCreator.eventSourceAuthenticated = false;
  if (mode === 'path') mockVerified.pathVerified = false;
  if (mode === 'exit') mockVerified.utilityExitObserved = false;
  if (mode === 'coverage') mockVerified.coverage.globalTxidCompleteness = true;
  await expect(open()).rejects.toMatchObject({ code: 'RAILGUN_TRANSACT_PROVENANCE_REFUSED' });
  expect(mockRootFactory).not.toHaveBeenCalled();
});
test.each(['creator', 'verifier'])(
  'late %s completion after abort drains and cannot open root service',
  async (mode) => {
    let release;
    (mode === 'creator' ? mockCapture : mockVerify).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    let settled = false;
    const pending = open().finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toThrow();
    for (let n = 0; n < 5; n++) await Promise.resolve();
    caller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release(mode === 'creator' ? { receipt: {} } : mockVerified);
    await rejected;
    expect(mockRootFactory).not.toHaveBeenCalled();
  }
);
test('root acquisition is one attempt and close drains a late root response', async () => {
  let release;
  mockRoots.acquire.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const op = await open();
  const pending = op.acquireRoot();
  const rejected = expect(pending).rejects.toThrow();
  expect(() => op.acquireRoot()).toThrow();
  let closed = false;
  const closing = op.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(mockRoots.close).toHaveBeenCalled();
  release({});
  await rejected;
  await closing;
  expect(closed).toBe(true);
  expect(() => op.acquireRoot()).toThrow();
});
test('root errors revoke the entire operation and cannot be retried', async () => {
  mockRoots.acquire.mockRejectedValue(Error('rejected root'));
  const op = await open();
  await expect(op.acquireRoot()).rejects.toThrow();
  expect(op.signal.aborted).toBe(true);
  expect(() => op.acquireRoot()).toThrow();
});
test('remaining-time margin rechecks creator, staging and root freshness', async () => {
  const op = await open();
  const acquired = await op.acquireRoot();
  mockRoots.assertRoot.mockImplementation(() => {
    throw Error('stale');
  });
  expect(() => check(op, acquired.receipt, 20000)).toThrow();
  mockRoots.assertRoot.mockReturnValue(acquired.observation.root);
  mockClaim.assertCurrent.mockImplementation(() => {
    throw Error('changed generation');
  });
  expect(() => check(op, acquired.receipt)).toThrow();
});

test.each(['staging-revoked', 'deadline-before-timer'])(
  'real root source refuses its second request after %s',
  async (mode) => {
    const stagingController = new AbortController();
    mockClaim.signal = stagingController.signal;
    let now = 1000,
      release;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    mockWindow.deadline = now + 175000;
    const transport = new AbortController();
    const second = jest.fn(async () => true);
    mockServices.mockReturnValue({
      signal: transport.signal,
      close: () => transport.abort(),
      latestTxid: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      validateTxidRoot: second,
    });
    mockRootFactory.mockImplementation(
      jest.requireActual('./railgun-txid-root').createRailgunTxidRootSource
    );
    const op = await open({ timeoutMs: 10000 });
    const pending = op.acquireRoot();
    const rejected = expect(pending).rejects.toThrow();
    if (mode === 'staging-revoked') {
      stagingController.abort();
      expect(transport.signal.aborted).toBe(true);
    } else now += 11000;
    release({ index: 0, root: mockStaged.state.root });
    await rejected;
    expect(second).not.toHaveBeenCalled();
    expect(op.signal.aborted).toBe(true);
  }
);
