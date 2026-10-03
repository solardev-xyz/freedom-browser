let mockDescriptor,
  mockRefuse,
  mockCopy,
  mockCancelledCopy,
  mockInput,
  mockRouter,
  mockTask,
  mockFailure;
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
      if (mockCancelledCopy) throw mockFailure || Error('identity revoked');
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
        JSON.stringify({
          id: 1,
          method: 'key',
          purpose: mockInput.privateIntent ? 'private-prepare' : 'wallet-viewing',
        })
      );
      expect(options.binaryKey).toBe(true);
      expect(options.filename).toBe(
        require.resolve(
          mockInput.privateIntent ? './railgun-private-prepare-job' : './railgun-wallet-job'
        )
      );
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
  mockFailure = null;
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
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    cause: new Error('identity revoked'),
  });
  expect([...mockCopy]).toEqual(Array(32).fill(0));
  expect(mockTask.close).toHaveBeenCalled();
  expect(mockRouter.close).toHaveBeenCalledTimes(1);
});
test('frozen shared revocation reasons stay intact while utility exit is drained', async () => {
  mockCancelledCopy = true;
  mockFailure = Object.freeze(Object.assign(new Error('shared reason'), { code: 'REVOKED' }));
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    cause: mockFailure,
    code: 'REVOKED',
    closed: { code: 'RAILGUN_PROCESS_CLOSED' },
  });
  expect(Object.keys(mockFailure)).toEqual(['code']);
  expect([...mockCopy]).toEqual(Array(32).fill(0));
});
test('a revoked/foreign identity or wrong walletId starts no worker', async () => {
  mockRefuse = true;
  await expect(runRailgunWalletSnapshot(args)).rejects.toThrow('identity refused');
  mockRefuse = false;
  await expect(runRailgunWalletSnapshot({ ...args, walletId: '2'.repeat(64) })).rejects.toThrow();
  expect(mockTask).toBeNull();
});
test('private preparation uses only the dedicated viewing-key entry and requires restore mode', async () => {
  const privateIntent = {
    kind: 'railgun-token-unshield',
    tree: 0,
    position: 1,
    recipient: '0x' + '12'.repeat(20),
  };
  await expect(runRailgunWalletSnapshot({ ...args, privateIntent })).rejects.toThrow();
  expect(mockTask).toBeNull();
  await runRailgunWalletSnapshot({ ...args, privateIntent, restore: true });
  expect(mockInput.privateIntent).toEqual(privateIntent);
  expect([...mockCopy]).toEqual(Array(32).fill(0));
});
