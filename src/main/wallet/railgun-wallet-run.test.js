let mockDescriptor, mockRefuse, mockCopy, mockCancelledCopy, mockInput, mockRouter, mockTask;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: () => {
    if (mockRefuse) throw Error('identity refused');
    return mockDescriptor;
  },
  withRailgunViewingCredential: async (_identity, use) => {
    const viewingKey = Buffer.alloc(32, 7);
    try {
      mockCopy = await use({ viewingKey });
      if (mockCancelledCopy) throw Error('identity revoked');
      return mockCopy;
    } finally {
      viewingKey.fill(0);
    }
  },
}));
jest.mock('./railgun-wallet-storage', () => ({ createRailgunWalletStorage: () => mockRouter }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: (options) => {
    mockInput = JSON.parse(options.input);
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const ready = (async () => {
      const bytes = await options.broker.dispatch(
        JSON.stringify({ id: 1, method: 'key', purpose: 'wallet-viewing' })
      );
      expect(options.binaryKey).toBe(true);
      expect(bytes.byteLength).toBe(32);
      expect(bytes.byteOffset).toBe(0);
      expect(bytes.buffer.byteLength).toBe(32);
      expect([...bytes]).toEqual(Array(32).fill(7));
      bytes.fill(0);
      await options.broker.dispatch(
        JSON.stringify({
          id: 2,
          method: 'result',
          value: { instanceId: mockDescriptor.instanceId },
        })
      );
    })();
    return (mockTask = {
      ready,
      closed,
      close: jest.fn(() => resolveClosed({ code: 'RAILGUN_PROCESS_CLOSED' })),
    });
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { runRailgunWalletSnapshot } = require('./railgun-wallet-run');
let scope, args;
beforeEach(() => {
  mockRefuse = false;
  mockCancelledCopy = false;
  mockCopy = mockTask = mockInput = null;
  mockDescriptor = { walletId: '1'.repeat(64), instanceId: '0zk1' + 'q'.repeat(123) };
  scope = createPrivacyScope({ profileId: 'view-run-test', signal: new AbortController().signal });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  });
  mockRouter = { signal: scope.signal, prefixes: {}, assertIdle: jest.fn(), close: jest.fn() };
  args = {
    handle,
    archive: '/fixture.asar',
    identity: { signal: scope.signal },
    snapshot: { checkpoint: {} },
    walletId: mockDescriptor.walletId,
    restore: false,
    walletSession: {},
    walletGrant: {},
  };
});
afterEach(() => scope.close());
test('the viewing key is copied into a dedicated 32-byte backing buffer and never appears in JSON input', async () => {
  await expect(runRailgunWalletSnapshot(args)).resolves.toMatchObject({
    instanceId: mockDescriptor.instanceId,
  });
  expect(JSON.stringify(mockInput)).not.toContain('07'.repeat(32));
  expect([...mockCopy]).toEqual(Array(32).fill(0));
  expect(mockRouter.close).toHaveBeenCalledTimes(1);
});
test('revocation after making the viewing-key copy wipes it even though no response is delivered', async () => {
  mockCancelledCopy = true;
  await expect(runRailgunWalletSnapshot(args)).rejects.toThrow('identity revoked');
  expect([...mockCopy]).toEqual(Array(32).fill(0));
  expect(mockTask.close).toHaveBeenCalled();
  expect(mockRouter.close).toHaveBeenCalledTimes(1);
});
test('a revoked/foreign identity or wrong walletId starts no worker', async () => {
  mockRefuse = true;
  await expect(runRailgunWalletSnapshot(args)).rejects.toThrow('identity refused');
  mockRefuse = false;
  await expect(runRailgunWalletSnapshot({ ...args, walletId: '2'.repeat(64) })).rejects.toThrow();
  expect(mockTask).toBeNull();
});
