let mockIdentity, mockEnrollment, mockPreparation, mockPrepared, mockMode, mockExit, mockRelease;
const mockStart = jest.fn();
const mockViewingKey = Buffer.alloc(32, 7);
jest.mock('./railgun-process', () => ({ startRailgunProcess: (...args) => mockStart(...args) }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-shield-prepare', () => ({
  assertRailgunShieldPreparation: (receipt, identity, enrollment) => {
    if (
      receipt !== mockPreparation ||
      identity !== mockIdentity ||
      enrollment !== mockEnrollment ||
      identity.signal.aborted
    )
      throw Error('Invalid preparation');
    return mockPrepared;
  },
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (identity) => {
    if (identity !== mockIdentity || identity.signal.aborted) throw Error('Invalid identity');
    return identity.descriptor;
  },
  withRailgunViewingCredential: async (identity, callback) => {
    const result = callback({ viewingKey: mockViewingKey });
    if (mockMode === 'late-key') {
      mockEnrollment.close();
      throw Error('Revoked credential');
    }
    return result;
  },
}));
const {
  verifyRailgunShieldReceiver,
  assertRailgunShieldReceiver,
} = require('./railgun-shield-receive');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
let copiedKey;
beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  mockExit = mockRelease = copiedKey = undefined;
  const abort = new AbortController();
  mockIdentity = { signal: abort.signal, descriptor: { instanceId: 'fixture-recipient' } };
  mockEnrollment = {
    signal: abort.signal,
    close: () => abort.abort(),
    getContext: jest.fn(() => ({})),
  };
  mockPreparation = Object.freeze({});
  mockPrepared = Object.freeze({
    commitment: 'fixture-commitment',
    noteValue: '99750',
    npk: 'fixture-npk',
    recipient: 'fixture-recipient',
  });
  mockStart.mockImplementation(({ broker, binaryKey, filename }) => {
    expect(binaryKey).toBe(true);
    expect(filename).toBe(require.resolve('./railgun-shield-receive-job'));
    const closed = new Promise((resolve) => {
      mockExit = () => resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    const ready = Promise.resolve().then(async () => {
      copiedKey = await broker.dispatch(
        JSON.stringify({ id: 1, method: 'key', purpose: 'shield-receive' })
      );
      expect(copiedKey).not.toBe(mockViewingKey);
      expect(copiedKey.byteOffset).toBe(0);
      expect(copiedKey.buffer.byteLength).toBe(32);
      expect(copiedKey.equals(mockViewingKey)).toBe(true);
      // The supervisor owns/wipes this returned buffer after transferring it.
      copiedKey.fill(0);
      if (mockMode === 'drain')
        await new Promise((resolve) => {
          mockRelease = resolve;
        });
      if (mockMode === 'replay-key')
        await broker.dispatch(JSON.stringify({ id: 2, method: 'key', purpose: 'shield-receive' }));
      const value = { ...mockPrepared, verified: true, guards: { attempts: 0 }, inventory };
      if (mockMode === 'recipient') value.recipient = 'foreign';
      if (mockMode === 'commitment') value.commitment = 'foreign';
      if (mockMode === 'inventory') value.inventory = 'foreign';
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
const verify = () =>
  verifyRailgunShieldReceiver({
    identity: mockIdentity,
    enrollment: mockEnrollment,
    preparation: mockPreparation,
    archive: '/fixture/engine.asar',
  });
test('receiver receipt binds the exact preparation and enrollment and expires with preparation', async () => {
  const receipt = await verify();
  expect(assertRailgunShieldReceiver(receipt, mockIdentity, mockEnrollment, mockPreparation)).toBe(
    mockPrepared
  );
  expect(mockEnrollment.getContext).toHaveBeenCalledWith('engine', 'shield-receive');
  expect(copiedKey.every((v) => v === 0)).toBe(true);
  expect(mockViewingKey.every((v) => v === 7)).toBe(true);
  expect(() =>
    assertRailgunShieldReceiver({}, mockIdentity, mockEnrollment, mockPreparation)
  ).toThrow();
  expect(() =>
    assertRailgunShieldReceiver(receipt, mockIdentity, { ...mockEnrollment }, mockPreparation)
  ).toThrow();
  mockPreparation = Object.freeze({});
  expect(() =>
    assertRailgunShieldReceiver(receipt, mockIdentity, mockEnrollment, mockPreparation)
  ).toThrow();
});
test.each(['recipient', 'commitment', 'inventory', 'egress', 'extra', 'replay-key', 'late-key'])(
  'refuses %s without issuing a receipt',
  async (mode) => {
    mockMode = mode;
    await expect(verify()).rejects.toThrow('Railgun shield receiver unavailable');
  }
);
test('lock during work drains the process before returning failure', async () => {
  mockMode = 'drain';
  let settled = false;
  const pending = verify().finally(() => {
    settled = true;
  });
  const rejected = expect(pending).rejects.toThrow();
  for (let n = 0; n < 20 && !mockRelease; n++) await Promise.resolve();
  expect(mockRelease).toBeDefined();
  await expect(verify()).rejects.toThrow();
  expect(mockStart).toHaveBeenCalledTimes(1);
  mockEnrollment.close();
  mockRelease();
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(settled).toBe(false);
  mockExit();
  await rejected;
});
