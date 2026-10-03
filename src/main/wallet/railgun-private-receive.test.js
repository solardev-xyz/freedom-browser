let mockIdentity, mockEnrollment, mockMode, mockExit, mockRelease, mockInput, mockCopy;
const mockStart = jest.fn(),
  mockViewingKey = Buffer.alloc(32, 7);
jest.mock('./railgun-process', () => ({ startRailgunProcess: (...args) => mockStart(...args) }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-private-intent', () => ({
  validateRailgunPrivateSigningIntent: (tx, expected) => {
    if (expected.kind !== 'railgun-private-transfer') throw Error('kind');
    return { kind: expected.kind, digest: tx.data };
  },
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (v) => {
    if (v !== mockIdentity || v.signal.aborted) throw Error('identity');
    return v.descriptor;
  },
  withRailgunViewingCredential: async (_identity, use) => {
    mockCopy = use({ viewingKey: mockViewingKey });
    if (mockMode === 'late-key') {
      mockEnrollment.close();
      throw Error('cancelled');
    }
    return mockCopy;
  },
}));
const { verifyRailgunPrivateReceiver } = require('./railgun-private-receive');
let args;
beforeEach(() => {
  jest.clearAllMocks();
  mockMode = mockExit = mockRelease = mockInput = mockCopy = undefined;
  const controller = new AbortController();
  mockIdentity = {
    signal: controller.signal,
    descriptor: { walletId: 'a'.repeat(64), instanceId: 'self' },
  };
  mockEnrollment = {
    signal: controller.signal,
    descriptor: mockIdentity.descriptor,
    getContext: jest.fn(() => ({})),
    close: () => controller.abort(),
  };
  args = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture.asar',
    transaction: { data: '0x' + '1'.repeat(64) },
    expected: { kind: 'railgun-private-transfer' },
    recipient: 'self',
    amount: '1000',
  };
  mockStart.mockImplementation(({ broker, input, filename, binaryKey }) => {
    mockInput = JSON.parse(input);
    expect(binaryKey).toBe(true);
    expect(filename).toBe(require.resolve('./railgun-private-receive-job'));
    const closed = new Promise((resolve) => {
      mockExit = () => resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    const ready = Promise.resolve().then(async () => {
      const key = await broker.dispatch(
        JSON.stringify({
          id: 1,
          method: 'key',
          purpose: mockMode === 'purpose' ? 'spending-sign' : 'private-receive',
        })
      );
      expect(key).not.toBe(mockViewingKey);
      expect(key.byteOffset).toBe(0);
      expect(key.buffer.byteLength).toBe(32);
      key.fill(0);
      if (mockMode === 'drain')
        await new Promise((resolve) => {
          mockRelease = resolve;
        });
      if (mockMode === 'replay-key')
        await broker.dispatch(JSON.stringify({ id: 2, method: 'key', purpose: 'private-receive' }));
      const value = {
        verified: true,
        transactionDigest: mockInput.transaction.data,
        recipient: mockInput.recipient,
        amount: mockInput.amount,
        inventory: require('./railgun-engine-manifest.json').inventory.sha256,
        guards: { attempts: 0, canaries: 1, hooks: ['test.hook'] },
      };
      if (['recipient', 'amount', 'transactionDigest', 'inventory'].includes(mockMode))
        value[mockMode] = 'wrong';
      if (mockMode === 'egress') value.guards.attempts = 1;
      if (mockMode === 'extra') value.extra = true;
      await broker.dispatch(JSON.stringify({ id: 2, method: 'result', value }));
    });
    return {
      ready,
      closed,
      close: () => {
        if (mockMode !== 'drain') mockExit();
      },
    };
  });
});
test('returns intent-bound cryptographic data only after exit and never serializes the viewing key', async () => {
  const pending = verifyRailgunPrivateReceiver(args);
  args.transaction.data = 'changed';
  const value = await pending;
  expect(value).toMatchObject({
    recipientVerified: true,
    transactionDigest: '0x' + '1'.repeat(64),
    inputOwnershipVerified: false,
    spendingEnabled: false,
  });
  expect(Object.isFrozen(value)).toBe(true);
  expect(JSON.stringify(mockInput)).not.toContain('07'.repeat(32));
  expect(mockCopy.equals(Buffer.alloc(32))).toBe(true);
  expect(mockViewingKey[0]).toBe(7);
});
test.each([
  'purpose',
  'replay-key',
  'recipient',
  'amount',
  'transactionDigest',
  'inventory',
  'egress',
  'extra',
  'late-key',
])('refuses %s without returning verification', async (mode) => {
  mockMode = mode;
  await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED',
  });
  if (mockCopy) expect(mockCopy.equals(Buffer.alloc(32))).toBe(true);
});
test.each(['identity', 'enrollment', 'recipient', 'amount', 'kind', 'cancelled'])(
  'refuses invalid %s before starting the worker',
  async (field) => {
    if (field === 'identity' || field === 'enrollment') args[field] = {};
    if (field === 'recipient') args.recipient = 'foreign';
    if (field === 'amount') args.amount = '0';
    if (field === 'kind') args.expected.kind = 'railgun-token-unshield';
    if (field === 'cancelled') args.signal = AbortSignal.abort();
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toThrow();
    expect(mockStart).not.toHaveBeenCalled();
  }
);
test('cancellation and concurrent requests cannot bypass utility exit drain', async () => {
  mockMode = 'drain';
  let settled = false;
  const pending = verifyRailgunPrivateReceiver(args).finally(() => {
    settled = true;
  });
  const rejected = expect(pending).rejects.toThrow();
  for (let i = 0; i < 30 && !mockRelease; i++) await Promise.resolve();
  expect(mockRelease).toBeDefined();
  await expect(verifyRailgunPrivateReceiver(args)).rejects.toThrow();
  mockEnrollment.close();
  mockRelease();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(settled).toBe(false);
  mockExit();
  await rejected;
});
