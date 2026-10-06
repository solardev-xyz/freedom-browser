// Structural owner/permit seams; the real root source and its 60-second clock run.
// No engine cryptography or public-service request is executed by these tests.
let mockServices, mockClaim, mockData, mockOwners, mockAccount, mockWindow, mockReceipt;
const mockClaimStaging = jest.fn(),
  mockConsume = jest.fn(),
  mockCreate = jest.fn();
jest.mock('./railgun-public-services', () => ({
  createRailgunPublicServices: (...args) => mockCreate(...args),
}));
jest.mock('./railgun-relay-transact-staging', () => ({
  claimRailgunRelayTransactStaging: (...args) => mockClaimStaging(...args),
}));
jest.mock('./railgun-account-wallet', () => ({
  assertRailgunAccountRelayWindow: (window, account, owners, margin = 0) => {
    if (
      window !== mockWindow ||
      account !== mockAccount ||
      owners.identity !== mockOwners.identity ||
      owners.enrollment !== mockOwners.enrollment ||
      owners.coordinator !== mockOwners.coordinator ||
      mockData.signal.aborted ||
      performance.now() + margin >= mockData.deadline
    )
      throw Error('window');
    return mockData;
  },
}));
jest.mock(
  './railgun-relay-operation',
  () => ({
    consumeRailgunRelayRootDisclosurePermit: (...args) => mockConsume(...args),
  }),
  { virtual: true }
);
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  openRailgunRelayTransactProvenance: open,
  assertRailgunRelayTransactProvenanceOperation: assertOperation,
  assertRailgunRelayTransactProvenance: assertResult,
} = require('./railgun-relay-transact-provenance');
let scope, caller, serviceController, options, operation, permit, events;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  caller = new AbortController();
  serviceController = new AbortController();
  scope = createPrivacyScope({ profileId: 'relay-root-fixture', signal: caller.signal });
  mockAccount = { signal: caller.signal };
  mockWindow = {};
  mockReceipt = {};
  permit = {};
  mockOwners = {
    identity: {},
    coordinator: {},
    enrollment: {
      getContext: () =>
        scope.getContext({
          kind: 'private-account',
          principal: 'fixture',
          protocol: 'railgun',
          deployment: 'sepolia',
          chainId: 11155111,
          role: 'engine',
        }),
    },
  };
  mockData = {
    signal: caller.signal,
    deadline: performance.now() + 150000,
    checkpointHash: '1'.repeat(64),
    draftDigest: '2'.repeat(64),
    summaryDigest: '3'.repeat(64),
  };
  const evidence = Object.freeze({
    state: { count: 2, root: '1'.repeat(64) },
    creator: { creator: { blockHash: '0x' + '4'.repeat(64), transactionIndex: 2 } },
    verified: { inputSha256: '5'.repeat(64) },
    noteWitness: { witness: { row: { unshield: null } } },
  });
  mockClaim = {
    assertCurrent: jest.fn(() => evidence),
    signal: caller.signal,
    draftDigest: mockData.draftDigest,
    summaryDigest: mockData.summaryDigest,
  };
  mockClaimStaging.mockImplementation((receipt, account, owners, request, window) => {
    if (
      receipt !== mockReceipt ||
      account !== mockAccount ||
      owners.identity !== mockOwners.identity ||
      request !== options.request ||
      window !== mockWindow
    )
      throw Error('staging');
    events.push('claimed');
    return mockClaim;
  });
  mockConsume.mockImplementation((value, op, account, owners, window) => {
    expect(value).toBe(permit);
    const binding = assertOperation(op, account, owners, window);
    expect(binding).toMatchObject({
      stagingReceipt: mockReceipt,
      draftDigest: mockData.draftDigest,
      summaryDigest: mockData.summaryDigest,
      checkpointHash: mockData.checkpointHash,
      point: { index: 1, root: '1'.repeat(64) },
    });
    events.push('permit');
  });
  mockServices = {
    signal: serviceController.signal,
    close: jest.fn(() => serviceController.abort()),
    latestTxid: jest.fn(async () => {
      events.push('latest');
      return { index: 3, root: '2'.repeat(64) };
    }),
    validateTxidRoot: jest.fn(async () => {
      events.push('validate');
      return true;
    }),
  };
  mockCreate.mockImplementation(() => {
    events.push('service');
    return mockServices;
  });
  options = {
    stagingReceipt: mockReceipt,
    account: mockAccount,
    owners: mockOwners,
    request: {},
    window: mockWindow,
    signal: caller.signal,
  };
});
afterEach(async () => {
  if (operation) await operation.close().catch(() => {});
  operation = undefined;
  caller.abort();
  scope.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const result = (receipt, margin = 0) =>
  assertResult(operation, receipt, mockAccount, mockOwners, mockWindow, margin);
test('claims a genuine reviewed binding before separate consent and exact root disclosure', async () => {
  operation = open(options);
  expect(events).toEqual(['claimed']);
  expect(mockCreate).not.toHaveBeenCalled();
  const binding = assertOperation(operation, mockAccount, mockOwners, mockWindow);
  expect(binding.witnessInputSha256).toBe('5'.repeat(64));
  const acquired = await operation.acquireRoot({ permit });
  expect(events).toEqual(['claimed', 'permit', 'service', 'latest', 'validate']);
  expect(mockServices.validateTxidRoot).toHaveBeenCalledWith({
    tree: 0,
    index: 1,
    root: '1'.repeat(64),
  });
  expect(result(acquired.receipt)).toBe(acquired.observation);
  expect(acquired.observation).toMatchObject({
    root: { accepted: true },
    pathVerified: true,
    creatorSourceAuthenticated: true,
    spendingEnabled: false,
    boundParamsChecked: false,
    globalTxidCompleteness: false,
  });
  expect(() => result({})).toThrow();
  expect(() => assertOperation({ ...operation }, mockAccount, mockOwners, mockWindow)).toThrow();
  expect(() => assertOperation(operation, {}, mockOwners, mockWindow)).toThrow();
  expect(() =>
    assertOperation(operation, mockAccount, { ...mockOwners, coordinator: {} }, mockWindow)
  ).toThrow();
  expect(() => assertOperation(operation, mockAccount, mockOwners, {})).toThrow();
});
test.each(['receipt', 'window', 'account', 'draft', 'summary'])(
  'refuses %s before any root service',
  (fault) => {
    if (fault === 'receipt') options.stagingReceipt = {};
    if (fault === 'window') options.window = {};
    if (fault === 'account') options.account = { signal: caller.signal };
    if (fault === 'draft') mockClaim.draftDigest = '6'.repeat(64);
    if (fault === 'summary') mockClaim.summaryDigest = '7'.repeat(64);
    expect(() => open(options)).toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  }
);
test.each([
  'private-permit',
  'no-consumer',
  'async-consumer',
  'consumer-close',
  'extra-field',
  'timeout',
])('refuses %s before service creation', (fault) => {
  operation = open(options);
  let args = { permit };
  if (fault === 'private-permit') args.permit = {};
  if (fault === 'no-consumer')
    mockConsume.mockImplementation(() => {
      throw Error('unimplemented fixed controller');
    });
  if (fault === 'async-consumer') mockConsume.mockReturnValue(Promise.resolve());
  if (fault === 'consumer-close')
    mockConsume.mockImplementation(() => {
      operation.close();
    });
  if (fault === 'extra-field') args.root = {};
  if (fault === 'timeout') args.timeoutMs = 20001;
  expect(() => operation.acquireRoot(args)).toThrow();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(operation.signal.aborted).toBe(true);
});
test('a used disclosure cannot start a second request', async () => {
  operation = open(options);
  await operation.acquireRoot({ permit });
  expect(() => operation.acquireRoot({ permit })).toThrow();
  expect(mockConsume).toHaveBeenCalledTimes(1);
  expect(mockServices.latestTxid).toHaveBeenCalledTimes(1);
});
test.each(['latest', 'validate'])(
  'close retains the original pending %s request and refuses its late result',
  async (where) => {
    const held = deferred();
    mockServices[where === 'latest' ? 'latestTxid' : 'validateTxidRoot'].mockReturnValue(
      held.promise
    );
    operation = open(options);
    const pending = operation.acquireRoot({ permit }).catch((e) => e);
    await turn();
    let closed = false;
    const closing = operation.close().then(() => {
      closed = true;
    });
    expect(operation.close()).toBe(operation.close());
    await turn();
    expect(closed).toBe(false);
    held.resolve(where === 'latest' ? { index: 3, root: '2'.repeat(64) } : true);
    expect((await pending).code).toBe('RAILGUN_RELAY_TRANSACT_PROVENANCE_REFUSED');
    await closing;
    expect(closed).toBe(true);
  }
);
test('throwing transport cleanup cannot skip original request drainage', async () => {
  const held = deferred();
  mockServices.latestTxid.mockReturnValue(held.promise);
  mockServices.close.mockImplementation(() => {
    throw Error('close failed');
  });
  operation = open(options);
  const pending = operation.acquireRoot({ permit }).catch((e) => e);
  await turn();
  let closed = false;
  const closing = operation.close().catch((e) => {
    closed = true;
    return e;
  });
  await turn();
  expect(closed).toBe(false);
  held.reject(Error('service failed'));
  expect((await pending).code).toBe('RAILGUN_RELAY_TRANSACT_PROVENANCE_REFUSED');
  expect((await closing).code).toBe('RAILGUN_RELAY_TRANSACT_PROVENANCE_REFUSED');
});
test('root age starts at the original request and is not renewed at receipt publication', async () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mockData.deadline = 151000;
  mockServices.latestTxid.mockImplementation(async () => {
    now += 10000;
    return { index: 3, root: '2'.repeat(64) };
  });
  mockServices.validateTxidRoot.mockImplementation(async () => {
    now += 9000;
    return true;
  });
  operation = open(options);
  const value = await operation.acquireRoot({ permit });
  expect(() => result(value.receipt, 40999)).not.toThrow();
  expect(() => result(value.receipt, 41000)).toThrow();
  now = 61000;
  expect(() => result(value.receipt)).toThrow();
});
test('monotonic rollback or changed reviewed window invalidates the operation', () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mockData.deadline = 151000;
  operation = open(options);
  now = 999;
  expect(() => assertOperation(operation, mockAccount, mockOwners, mockWindow)).toThrow();
  now = 1001;
  mockData = { ...mockData };
  expect(() => assertOperation(operation, mockAccount, mockOwners, mockWindow)).toThrow();
});
test('acquisition timeout aborts admission but close still waits for original service settlement', async () => {
  jest.useFakeTimers();
  const held = deferred();
  mockServices.latestTxid.mockReturnValue(held.promise);
  operation = open(options);
  const pending = operation.acquireRoot({ permit, timeoutMs: 10 }).catch((e) => e);
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(10);
  expect(operation.signal.aborted).toBe(true);
  let closed = false;
  const closing = operation.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  held.resolve({ index: 3, root: '2'.repeat(64) });
  await pending;
  await closing;
  expect(closed).toBe(true);
});
