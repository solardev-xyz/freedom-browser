let mockMode, mockTask, mockExit, mockDeferExit;
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn((v) => v),
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    let finish, rejectReady, observeClose;
    const closed = new Promise((resolve) => {
      finish = resolve;
    });
    const closeStarted = new Promise((resolve) => {
      observeClose = resolve;
    });
    const waiting = new Promise((_resolve, reject) => {
      rejectReady = reject;
    });
    waiting.catch(() => {});
    mockExit = () =>
      finish({
        code: mockMode === 'crash' ? 'RAILGUN_PROCESS_FAILED' : 'RAILGUN_PROCESS_CLOSED',
      });
    const task = {
      closed,
      closeStarted,
      close: jest.fn(() => {
        observeClose();
        rejectReady(Error('closed'));
        if (!mockDeferExit) mockExit();
      }),
    };
    mockTask = task;
    options.broker.signal.addEventListener('abort', () => task.close(), { once: true });
    task.ready = Promise.resolve().then(async () => {
      if (mockMode === 'hang') return waiting;
      const input = JSON.parse(options.input);
      const value = {
        inputSha256: require('crypto').createHash('sha256').update(options.input).digest('hex'),
        bindingDigest: input.bindingDigest,
        blindedCommitment: '0x' + '1'.repeat(64),
        selectorDerived: true,
        sourceAuthenticated: false,
        ownershipAuthenticated: false,
        membershipAuthenticated: false,
        disclosureEnabled: false,
        spendingEnabled: false,
        guards: { attempts: 0, canaries: 1, hooks: ['test.guard'] },
        inventory: require('./railgun-engine-manifest.json').inventory.sha256,
      };
      if (mockMode === 'sha') value.inputSha256 = '0'.repeat(64);
      if (mockMode === 'altered-facts') {
        // Keep the old binding echo but hash a different worker request.
        input.facts.position++;
        value.inputSha256 = require('crypto')
          .createHash('sha256')
          .update(JSON.stringify(input))
          .digest('hex');
      }
      if (mockMode === 'binding') value.bindingDigest = '0'.repeat(64);
      if (mockMode === 'inventory') value.inventory = '0'.repeat(64);
      if (mockMode === 'derived') value.selectorDerived = false;
      if (mockMode.endsWith('Authenticated') || mockMode.endsWith('Enabled'))
        value[mockMode] = true;
      if (mockMode === 'field') value.blindedCommitment = '0x' + 'f'.repeat(64);
      if (mockMode === 'prefix') value.blindedCommitment = '1'.repeat(64);
      if (mockMode === 'case') value.blindedCommitment = '0x' + 'A'.repeat(64);
      if (mockMode === 'extra') value.extra = true;
      if (mockMode === 'attempts') value.guards.attempts = 1;
      if (mockMode === 'canaries') value.guards.canaries = 2;
      if (mockMode === 'duplicate-hooks') {
        value.guards.hooks = ['test.guard', 'test.guard'];
        value.guards.canaries = 2;
      }
      if (mockMode === 'invalid-hook') value.guards.hooks = ['private/path'];
      if (mockMode === 'empty-hooks') {
        value.guards.hooks = [];
        value.guards.canaries = 0;
      }
      if (mockMode === 'guards-extra') value.guards.extra = true;
      const message = { id: 1, method: 'result', value };
      if (['key', 'input', 'get', 'provider'].includes(mockMode)) message.method = mockMode;
      if (mockMode === 'id') message.id = 2;
      if (mockMode === 'envelope-extra') message.extra = true;
      if (mockMode === 'missing') return;
      const wire = mockMode === 'oversize' ? 'x'.repeat(16385) : JSON.stringify(message);
      await options.broker.dispatch(wire);
      if (mockMode === 'duplicate') await options.broker.dispatch(wire);
    });
    return task;
  }),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { normalizeRailgunPoiShieldInput } = require('./railgun-poi-shield-selector-data');
const { deriveRailgunPoiShieldSelector } = require('./railgun-poi-shield-selector');
const { startRailgunProcess } = require('./railgun-process');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const refused = { code: 'RAILGUN_POI_SHIELD_SELECTOR_REFUSED' };
const subject = {
  kind: 'private-account',
  protocol: 'railgun',
  deployment: 'sepolia',
  chainId: 11155111,
  principal: 'test-account',
  role: 'engine',
  operation: 'poi-shield-selector',
};
let scope, controller, input;
beforeEach(() => {
  jest.clearAllMocks();
  verifyRailgunEngineRuntime.mockImplementation((v) => v);
  mockMode = 'valid';
  mockDeferExit = false;
  mockTask = undefined;
  mockExit = undefined;
  controller = new AbortController();
  scope = createPrivacyScope({
    profileId: 'shield-selector-test',
    signal: new AbortController().signal,
  });
  const capsule = sample().capsule;
  input = {
    handle: scope.getContext(subject),
    archive: '/test/runtime.asar',
    capsule,
    creator: {
      type: 'Shield',
      tree: 0,
      position: 1,
      preimage: {
        npk: hex(7),
        value: '1000',
        token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      },
      ciphertext: { encryptedBundle: [hex(8), hex(9), hex(10)], shieldKey: hex(11) },
    },
    signal: controller.signal,
  };
});
afterEach(() => {
  controller.abort();
  scope.close();
  mockExit?.();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('returns immutable data only after exit and exposes only the result broker', async () => {
  mockDeferExit = true;
  let settled = false;
  const pending = deriveRailgunPoiShieldSelector(input).then((result) => {
    settled = true;
    return result;
  });
  await mockTask.closeStarted;
  expect(settled).toBe(false);
  mockExit();
  const result = await pending;
  expect(result).toEqual({
    inputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    bindingDigest: normalizeRailgunPoiShieldInput(input.capsule, input.creator).bindingDigest,
    blindedCommitment: '0x' + '1'.repeat(64),
    selectorDerived: true,
    sourceAuthenticated: false,
    ownershipAuthenticated: false,
    membershipAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
    utilityExitObserved: true,
  });
  expect(Object.isFrozen(result)).toBe(true);
  const options = startRailgunProcess.mock.calls[0][0];
  for (const key of ['binaryKey', 'storage', 'createProvider', 'storageWorker'])
    expect(options[key]).toBeUndefined();
  expect(options.filename).toBe(require.resolve('./railgun-poi-shield-selector-job'));
  expect(Object.keys(JSON.parse(options.input)).sort()).toEqual([
    'archive',
    'bindingDigest',
    'facts',
  ]);
  expect(verifyRailgunEngineRuntime).toHaveBeenCalledWith(input.archive);
});

test.each([
  'sha',
  'altered-facts',
  'binding',
  'inventory',
  'derived',
  'field',
  'prefix',
  'case',
  'sourceAuthenticated',
  'ownershipAuthenticated',
  'membershipAuthenticated',
  'disclosureEnabled',
  'spendingEnabled',
  'extra',
  'attempts',
  'canaries',
  'duplicate-hooks',
  'invalid-hook',
  'empty-hooks',
  'guards-extra',
  'key',
  'input',
  'get',
  'provider',
  'id',
  'envelope-extra',
  'oversize',
  'missing',
  'duplicate',
  'crash',
])('refuses %s and closes the utility', async (mode) => {
  mockMode = mode;
  await expect(deriveRailgunPoiShieldSelector(input)).rejects.toMatchObject(refused);
  expect(mockTask.close).toHaveBeenCalled();
});

test.each([
  ['before-result', 'timeout'],
  ['before-result', 'caller'],
  ['before-result', 'parent'],
  ['after-result', 'timeout'],
  ['after-result', 'caller'],
  ['after-result', 'parent'],
])('%s %s revocation refuses only after deferred exit', async (phase, cause) => {
  jest.useFakeTimers();
  mockMode = phase === 'before-result' ? 'hang' : 'valid';
  mockDeferExit = true;
  let settled = false;
  const outcome = deriveRailgunPoiShieldSelector({ ...input, timeoutMs: 20 }).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    }
  );
  if (phase === 'after-result') await mockTask.closeStarted;
  else await Promise.resolve();
  if (cause === 'timeout') await jest.advanceTimersByTimeAsync(21);
  if (cause === 'caller') controller.abort();
  if (cause === 'parent') scope.close();
  await mockTask.closeStarted;
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mockTask.close).toHaveBeenCalled();
  mockExit();
  expect(await outcome).toEqual({ error: expect.objectContaining(refused) });
});

test.each([21, -1])(
  'checks the monotonic clock at exit without timer dispatch: %s',
  async (now) => {
    mockDeferExit = true;
    const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
    const outcome = deriveRailgunPoiShieldSelector({ ...input, timeoutMs: 20 }).catch((e) => e);
    await mockTask.closeStarted;
    clock.mockReturnValue(now);
    mockExit();
    expect(await outcome).toMatchObject(refused);
  }
);

test.each([
  ['kind', 'service'],
  ['protocol', 'other'],
  ['deployment', 'mainnet'],
  ['chainId', 1],
  ['role', 'prover'],
  ['operation', 'own-txid-selector'],
])('refuses incorrect context %s before launching', async (key, value) => {
  input.handle = scope.getContext({ ...subject, [key]: value });
  await expect(deriveRailgunPoiShieldSelector(input)).rejects.toMatchObject(refused);
  expect(startRailgunProcess).not.toHaveBeenCalled();
});

test('refuses malformed inputs, pin failure and revoked lifetimes before launching', async () => {
  for (const changed of [
    { handle: {} },
    { capsule: null },
    { creator: {} },
    { signal: {} },
    { timeoutMs: 0 },
    { timeoutMs: 60001 },
    { timeoutMs: 1.5 },
  ])
    await expect(deriveRailgunPoiShieldSelector({ ...input, ...changed })).rejects.toMatchObject(
      refused
    );
  verifyRailgunEngineRuntime.mockImplementationOnce(() => {
    throw Error('private runtime path');
  });
  await expect(deriveRailgunPoiShieldSelector(input)).rejects.toMatchObject({
    ...refused,
    message: 'Railgun Shield POI selector unavailable',
  });
  controller.abort();
  await expect(deriveRailgunPoiShieldSelector(input)).rejects.toMatchObject(refused);
  input.signal = new AbortController().signal;
  scope.close();
  await expect(deriveRailgunPoiShieldSelector(input)).rejects.toMatchObject(refused);
  expect(startRailgunProcess).not.toHaveBeenCalled();
});

test('captures capsule and creator before the first await, including ciphertext in the binding', async () => {
  const expected = normalizeRailgunPoiShieldInput(input.capsule, input.creator);
  const pending = deriveRailgunPoiShieldSelector(input);
  input.capsule.noteHash = hex(55);
  input.creator.preimage.npk = hex(56);
  input.creator.ciphertext.encryptedBundle[0] = hex(57);
  const result = await pending;
  expect(result.bindingDigest).toBe(expected.bindingDigest);
  const wire = JSON.parse(startRailgunProcess.mock.calls[0][0].input);
  expect(wire.facts).toEqual(expected.facts);
  expect(wire.bindingDigest).toBe(expected.bindingDigest);
});
