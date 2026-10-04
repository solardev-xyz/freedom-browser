let mockMode, mockTask, mockExit, mockDeferExit, mockProtocol;
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
      if (mockProtocol) return mockProtocol(options.broker, wire);
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
const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
let scope, controller, input;
beforeEach(async () => {
  jest.clearAllMocks();
  mockMode = 'valid';
  mockDeferExit = false;
  mockProtocol = undefined;
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

test('binds both ordered partial commitments with a separate domain before starting', async () => {
  const f = createRailgunPartialCapsuleData();
  input.provedTransaction = f.capsule.preparation.transaction;
  const original = JSON.parse(JSON.stringify(input.provedTransaction));
  const result = await deriveRailgunOwnSelector(input);
  const supplied = JSON.parse(startRailgunProcess.mock.calls[0][0].input);
  expect(supplied.intentKind).toBe('railgun-partial-unshield');
  expect(supplied.facts.commitments).toEqual([
    f.capsule.preparation.expected.changeCommitment,
    f.capsule.preparation.expected.unshieldCommitment,
  ]);
  expect(supplied.facts.nullifiers).toEqual([f.capsule.preparation.expected.nullifier]);
  expect(supplied.bindingDigest).toBe(
    require('crypto')
      .createHash('sha256')
      .update('freedom:railgun:own-selector-v2\0')
      .update(JSON.stringify(original))
      .digest('hex')
  );
  expect(result).toMatchObject({ selectorDerived: true, spendingEnabled: false });
});

test.each(['extra-output', 'missing-ciphertext', 'transfer-with-two', 'extra-nullifier'])(
  'rejects partial %s before launching a selector',
  async (mode) => {
    const f = createRailgunPartialCapsuleData();
    if (mode === 'extra-output') f.inner.commitments.push(f.inner.commitments[0]);
    if (mode === 'missing-ciphertext') f.inner.boundParams.commitmentCiphertext = [];
    if (mode === 'transfer-with-two') f.inner.boundParams.unshield = 0;
    if (mode === 'extra-nullifier') f.inner.nullifiers.push(f.inner.nullifiers[0]);
    await expect(
      deriveRailgunOwnSelector({
        ...input,
        provedTransaction: { ...f.capsule.preparation.transaction, data: f.encode() },
      })
    ).rejects.toMatchObject({ code: 'RAILGUN_OWN_SELECTOR_REFUSED' });
    expect(startRailgunProcess).not.toHaveBeenCalled();
  }
);

test('refuses extra inputs, out-of-field facts and the wrong operation before starting', async () => {
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

// Deliberately suppress broker rejection in the mocked supervisor. These tests
// establish the host's own irrevocable refusal, not a live supervisor bypass.
const protocolCases = ['same-tick', 'next-tick', 'valid-then-bad'];
function exerciseRefusal(timing, fault, observed) {
  return async (broker, valid) => {
    const value = JSON.parse(valid);
    if (fault === 'digest') value.value.inputSha256 = '0'.repeat(64);
    if (fault === 'method') value.method = 'key';
    const invalid = fault === 'json' ? '{' : JSON.stringify(value);
    observed.signal = broker.signal;
    if (timing === 'valid-then-bad') {
      await broker.dispatch(valid);
      observed.initialAccepted = true;
    }
    const refused = broker.dispatch(invalid);
    observed.immediatelyAborted = broker.signal.aborted;
    const rejection = refused.then(
      () => {
        observed.invalidAccepted = true;
      },
      () => {
        observed.rejectionSeen = true;
      }
    );
    if (timing === 'next-tick') await new Promise((resolve) => setImmediate(resolve));
    if (timing !== 'valid-then-bad') {
      await broker.dispatch(valid).then(
        () => {
          observed.lateAccepted = true;
        },
        () => {
          observed.lateRefused = true;
        }
      );
    }
    await rejection;
    observed.driverFinished = true;
    // Return normally even after refusal; supervisor readiness is not trusted
    // to preserve the original failure in this adversarial host-boundary mock.
  };
}
test.each(
  protocolCases.flatMap((timing) => ['digest', 'method', 'json'].map((fault) => [timing, fault]))
)('permanently revokes %s %s refusal before supervisor reaction', async (timing, fault) => {
  const observed = {};
  mockProtocol = exerciseRefusal(timing, fault, observed);
  await expect(deriveRailgunOwnSelector(input)).rejects.toMatchObject({
    code: 'RAILGUN_OWN_SELECTOR_REFUSED',
  });
  expect(observed.immediatelyAborted).toBe(true);
  expect(observed.rejectionSeen).toBe(true);
  expect(observed.invalidAccepted).not.toBe(true);
  expect(observed.driverFinished).toBe(true);
  if (timing === 'valid-then-bad') expect(observed.initialAccepted).toBe(true);
  else {
    expect(observed.lateAccepted).not.toBe(true);
    expect(observed.lateRefused).toBe(true);
  }
  expect(mockTask.close).toHaveBeenCalled();
});
test.each(protocolCases)(
  'retains %s refusal until the actual delayed process exit',
  async (timing) => {
    const observed = {};
    mockDeferExit = true;
    mockProtocol = exerciseRefusal(timing, 'digest', observed);
    let settled = false;
    const pending = deriveRailgunOwnSelector(input).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(observed.driverFinished).toBe(true);
      expect(observed.immediatelyAborted).toBe(true);
      expect(observed.signal.aborted).toBe(true);
      expect(mockTask.close).toHaveBeenCalled();
      expect(settled).toBe(false);
      mockExit();
      expect(await pending).toMatchObject({ error: { code: 'RAILGUN_OWN_SELECTOR_REFUSED' } });
    } finally {
      mockExit();
      await pending;
    }
  }
);
