let mockEnrollment, mockIdentity, mockMode, mockRelease, mockExit;
const mockStart = jest.fn();
jest.mock('./railgun-process', () => ({ startRailgunProcess: (...args) => mockStart(...args) }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (v) => {
    if (v !== mockIdentity || v.signal.aborted) throw Error('Identity refused');
    return v.descriptor;
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  prepareRailgunNativeShield,
  assertRailgunShieldPreparation,
  MAX_AGE_MS,
} = require('./railgun-shield-prepare');
const { SHIELD_ABI } = require('./railgun-shield-policy');
const pins = require('./railgun-shield-pins.json');
const { Interface } = require('ethers');
const abi = new Interface(SHIELD_ABI);
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
let scope;
const amount = '100000000000000';
function jobResult() {
  const request = {
    preimage: {
      npk: hex(7),
      token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: 0 },
      value: amount,
    },
    ciphertext: { encryptedBundle: [hex(1), hex(2), hex(3)], shieldKey: hex(4) },
  };
  const data = abi.encodeFunctionData('multicall', [
    true,
    [
      { to: pins.relayAdapt, data: abi.encodeFunctionData('wrapBase', [amount]), value: 0 },
      { to: pins.relayAdapt, data: abi.encodeFunctionData('shield', [[request]]), value: 0 },
    ],
  ]);
  return {
    npk: hex(7),
    commitment: hex(8),
    noteValue: '99750000000000',
    transaction: { chainId: 11155111, to: pins.relayAdapt, value: amount, data },
    guards: { attempts: 0 },
    inventory: require('./railgun-engine-manifest.json').inventory.sha256,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  mockRelease = undefined;
  mockExit = undefined;
  scope = createPrivacyScope({ profileId: 'shield-test', signal: new AbortController().signal });
  mockIdentity = {
    signal: scope.signal,
    descriptor: { walletId: 'a'.repeat(64), instanceId: 'public-fixture-recipient' },
  };
  mockEnrollment = {
    descriptor: { walletId: mockIdentity.descriptor.walletId },
    signal: scope.signal,
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      }),
  };
  mockStart.mockImplementation(({ broker }) => {
    const closed = new Promise((resolve) => {
      mockExit = () => resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    const close = () => {
      if (mockMode !== 'drain') mockExit();
    };
    const ready = Promise.resolve().then(async () => {
      const input = JSON.parse(await broker.dispatch(JSON.stringify({ id: 1, method: 'input' })));
      expect(input.value).toEqual({ amount, recipient: mockIdentity.descriptor.instanceId });
      if (mockMode === 'drain')
        await new Promise((resolve) => {
          mockRelease = resolve;
        });
      const result = jobResult();
      if (mockMode === 'inventory') result.inventory = 'wrong';
      if (mockMode === 'egress') result.guards.attempts = 1;
      if (mockMode === 'net') result.noteValue = amount;
      if (mockMode === 'commitment') result.commitment = '0x' + 'f'.repeat(64);
      if (mockMode === 'target') result.transaction.to = pins.proxy;
      if (mockMode === 'extra') result.secret = 'not allowed';
      await broker.dispatch(JSON.stringify({ id: 2, method: 'result', value: result }));
    });
    return { ready, closed, close };
  });
});
afterEach(() => {
  scope.close();
  jest.restoreAllMocks();
});
const prepare = () =>
  prepareRailgunNativeShield({
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture/engine.asar',
    amount,
  });
test('own-recipient preparation is bound, immutable, short-lived and invalidated by another prepare', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const first = await prepare();
  expect(first.prepared).toMatchObject({
    recipient: mockIdentity.descriptor.instanceId,
    commitment: hex(8),
    signingEnabled: false,
    deploymentVerified: false,
  });
  expect(assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)).toBe(
    first.prepared
  );
  expect(Object.isFrozen(first.prepared)).toBe(true);
  expect(() => assertRailgunShieldPreparation({}, mockIdentity, mockEnrollment)).toThrow();
  now = 99;
  expect(() =>
    assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
  now = 100 + MAX_AGE_MS;
  expect(() =>
    assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
  now = 100;
  const second = await prepare();
  expect(() =>
    assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
  expect(assertRailgunShieldPreparation(second.receipt, mockIdentity, mockEnrollment)).toBe(
    second.prepared
  );
  scope.close();
  expect(() =>
    assertRailgunShieldPreparation(second.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
});
test.each(['inventory', 'egress', 'net', 'commitment', 'target', 'extra'])(
  'utility %s mutation cannot produce preparation',
  async (kind) => {
    mockMode = kind;
    await expect(prepare()).rejects.toThrow('Railgun shield preparation unavailable');
  }
);
test('revocation drains utility before releasing the preparation owner', async () => {
  mockMode = 'drain';
  let settled = false;
  const pending = prepare().finally(() => {
    settled = true;
  });
  const refused = expect(pending).rejects.toThrow();
  for (let n = 0; n < 10 && !mockRelease; n++) await Promise.resolve();
  expect(mockRelease).toBeDefined();
  await expect(prepare()).rejects.toThrow();
  expect(mockStart).toHaveBeenCalledTimes(1);
  scope.close();
  mockRelease();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(settled).toBe(false);
  mockExit();
  await refused;
});
test('forged enrollment/identity, changed wallet and zero amount fail before compute', async () => {
  const input = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture/engine.asar',
    amount,
  };
  for (const change of [
    { enrollment: { ...mockEnrollment } },
    { identity: { ...mockIdentity } },
    { amount: '0' },
  ])
    await expect(prepareRailgunNativeShield({ ...input, ...change })).rejects.toThrow();
  mockEnrollment.descriptor.walletId = 'b'.repeat(64);
  await expect(prepare()).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
});
