let mockMode, mockTask, mockExit, mockDeferExit;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    let finish, reject;
    const closed = new Promise((resolve) => {
      finish = resolve;
    });
    mockExit = () =>
      finish({ code: mockMode === 'crash' ? 'RAILGUN_PROCESS_FAILED' : 'RAILGUN_PROCESS_CLOSED' });
    mockTask = {
      closed,
      close: jest.fn(() => {
        if (!mockDeferExit) mockExit();
        reject?.(Error('closed'));
      }),
    };
    const wait = new Promise((_resolve, r) => {
      reject = r;
    });
    wait.catch(() => {});
    options.broker.signal.addEventListener('abort', () => mockTask.close(), { once: true });
    mockTask.ready = Promise.resolve().then(async () => {
      if (mockMode === 'hang') return wait;
      const input = JSON.parse(options.input);
      const value = {
        inputSha256: require('crypto').createHash('sha256').update(options.input).digest('hex'),
        selectorDerived: true,
        bindingDigest: input.bindingDigest,
        railgunTxid: '1'.repeat(64),
        sourceAuthenticated: false,
        rootAccepted: false,
        spendingEnabled: false,
        guards: { attempts: 0, canaries: 1, hooks: ['test.guard'] },
        inventory: require('./railgun-engine-manifest.json').inventory.sha256,
      };
      if (mockMode === 'digest') value.inputSha256 = '0'.repeat(64);
      if (mockMode === 'inventory') value.inventory = '0'.repeat(64);
      if (mockMode === 'authority') value.spendingEnabled = true;
      if (mockMode === 'guards') value.guards.attempts = 1;
      if (mockMode === 'derived') value.selectorDerived = false;
      if (mockMode === 'binding') value.bindingDigest = '0'.repeat(64);
      if (mockMode === 'txid') value.railgunTxid = 'f'.repeat(64);
      if (mockMode === 'prefixed') value.railgunTxid = '0x' + value.railgunTxid;
      if (mockMode === 'extra') value.extra = true;
      if (mockMode === 'canary') value.guards.canaries = 2;
      if (mockMode === 'hooks') value.guards.hooks = ['test.guard', 'test.guard'];
      const wire = JSON.stringify({
        id: 1,
        method: ['key', 'input', 'get', 'provider'].includes(mockMode) ? mockMode : 'result',
        value,
      });
      if (mockMode === 'missing') return;
      await options.broker.dispatch(wire);
      if (mockMode === 'duplicate') await options.broker.dispatch(wire);
    });
    return mockTask;
  }),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const { deriveRailgunOwnSelector } = require('./railgun-own-selector');
const { startRailgunProcess } = require('./railgun-process');
let scope, controller, input;
beforeEach(async () => {
  jest.clearAllMocks();
  mockMode = 'valid';
  mockDeferExit = false;
  scope = createPrivacyScope({
    profileId: 'detached-fixture',
    signal: new AbortController().signal,
  });
  controller = new AbortController();
  input = {
    handle: scope.getContext({
      kind: 'private-account',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      principal: 'test-account',
      role: 'engine',
      operation: 'own-txid-selector',
    }),
    archive: '/test/runtime.asar',
    provedTransaction: fixture().transaction(),
    signal: controller.signal,
  };
});

afterEach(() => {
  controller.abort();
  scope.close();
  jest.useRealTimers();
});
test('returns only immutable diagnostic evidence after exit, with no key/storage/provider channel', async () => {
  const result = await deriveRailgunOwnSelector(input);
  expect(result).toMatchObject({
    selectorDerived: true,
    utilityExitObserved: true,
    spendingEnabled: false,
    sourceAuthenticated: false,
    rootAccepted: false,
    globalTxidCompleteness: false,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.pathVerified).toBe(false);
  expect(result.accountAuthenticated).toBe(false);
  expect(mockTask.close).toHaveBeenCalled();
  const options = startRailgunProcess.mock.calls[0][0];
  for (const field of ['binaryKey', 'storage', 'createProvider'])
    expect(options[field]).toBeUndefined();
  expect(Object.keys(JSON.parse(options.input)).sort()).toEqual([
    'archive',
    'bindingDigest',
    'facts',
  ]);
});
test.each([
  'key',
  'input',
  'get',
  'provider',
  'digest',
  'inventory',
  'authority',
  'guards',
  'derived',
  'binding',
  'txid',
  'prefixed',
  'extra',
  'canary',
  'hooks',
  'missing',
  'duplicate',
  'crash',
])('refuses %s without leaving a utility alive', async (mode) => {
  mockMode = mode;
  await expect(deriveRailgunOwnSelector(input)).rejects.toMatchObject({
    code: 'RAILGUN_OWN_SELECTOR_REFUSED',
  });
  expect(mockTask.close).toHaveBeenCalled();
});
test.each(['timeout', 'caller', 'parent'])(
  'drains observed exit after %s revocation',
  async (mode) => {
    jest.useFakeTimers();
    mockMode = 'hang';
    mockDeferExit = true;
    let settled = false;
    const pending = deriveRailgunOwnSelector({ ...input, timeoutMs: 20 });
    const outcome = pending.catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    if (mode === 'timeout') await jest.advanceTimersByTimeAsync(21);
    if (mode === 'caller') controller.abort();
    if (mode === 'parent') scope.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockTask.close).toHaveBeenCalled();
    expect(settled).toBe(false);
    mockExit();
    expect(await outcome).toMatchObject({ code: 'RAILGUN_OWN_SELECTOR_REFUSED' });
  }
);
test('refuses malformed calldata and context before starting', async () => {
  for (const provedTransaction of [
    null,
    {},
    { ...input.provedTransaction, data: '0x' },
    { ...input.provedTransaction, data: '0x' + '00'.repeat(65536) },
  ]) {
    await expect(deriveRailgunOwnSelector({ ...input, provedTransaction })).rejects.toThrow();
  }
  await expect(deriveRailgunOwnSelector({ ...input, timeoutMs: 60001 })).rejects.toThrow();
  await expect(deriveRailgunOwnSelector({ ...input, handle: {} })).rejects.toThrow();
  expect(startRailgunProcess).not.toHaveBeenCalled();
});
test('pins submitted calldata before asynchronous work', async () => {
  const pending = deriveRailgunOwnSelector(input);
  input.provedTransaction.data = '0x';
  expect((await pending).selectorDerived).toBe(true);
  const facts = JSON.parse(startRailgunProcess.mock.calls[0][0].input).facts;
  expect(facts.nullifiers).toHaveLength(1);
  expect(facts.commitments).toHaveLength(1);
});

test('refuses non-1x1, out-of-field facts and the wrong operation before starting', async () => {
  const multiple = fixture();
  multiple.inner.nullifiers.push(multiple.inner.nullifiers[0]);
  const outOfField = fixture();
  outOfField.inner.commitments[0] = '0x' + 'f'.repeat(64);
  for (const f of [multiple, outOfField]) {
    await expect(
      deriveRailgunOwnSelector({ ...input, provedTransaction: f.transaction() })
    ).rejects.toThrow();
  }
  const handle = scope.getContext({
    kind: 'private-account',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    principal: 'test-account',
    role: 'engine',
    operation: 'own-txid-proof',
  });
  await expect(deriveRailgunOwnSelector({ ...input, handle })).rejects.toThrow();
  controller.abort();
  await expect(deriveRailgunOwnSelector(input)).rejects.toThrow();
  expect(startRailgunProcess).not.toHaveBeenCalled();
});
