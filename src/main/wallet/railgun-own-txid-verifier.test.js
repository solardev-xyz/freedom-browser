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
        pathVerified: true,
        bindingDigest: input.bindingDigest,
        railgunTxid: input.witness.railgunTxid,
        unshieldCommitmentVerified: !!input.witness.row.unshield,
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
      if (mockMode === 'path') value.pathVerified = false;
      if (mockMode === 'binding') value.bindingDigest = '0'.repeat(64);
      if (mockMode === 'txid') value.railgunTxid = '0'.repeat(64);
      if (mockMode === 'unshield')
        value.unshieldCommitmentVerified = !value.unshieldCommitmentVerified;
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
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { verifyRailgunOwnTxid } = require('./railgun-own-txid-verifier');
const { startRailgunProcess } = require('./railgun-process');
const hash = (s) => '0' + createHash('sha256').update(s).digest('hex').slice(1);
const pair = (a, b) => hash(a + b),
  zeros = [hash('zero')];
for (let n = 0; n < 16; n++) zeros.push(pair(zeros[n], zeros[n]));
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
  const evidence = sample();
  const projection = createRailgunTxidProjection({
    hashPair: pair,
    zeroNodes: zeros,
    transactionHash: (r) => ({ hash: hash(JSON.stringify(r)), railgunTxid: hash(r.nullifiers[0]) }),
    verificationHash: () => evidence.row.verificationHash,
  });
  const values = new Map(),
    read = async (key) => values.get(key) ?? null;
  const { state, writes } = await projection.append(projection.empty(), [evidence.row], read);
  writes.forEach(({ key, value }) => values.set(key, value));
  const witness = await projection.witness(state, hash(evidence.row.nullifiers[0]), read);
  input = {
    handle: scope.getContext({
      kind: 'private-account',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      principal: 'test-account',
      role: 'engine',
      operation: 'own-txid-proof',
    }),
    archive: '/test/runtime.asar',
    state,
    witness,
    evidence,
    signal: controller.signal,
  };
});

afterEach(() => {
  controller.abort();
  scope.close();
  jest.useRealTimers();
});
test('returns only immutable diagnostic evidence after exit, with no key/storage/provider channel', async () => {
  const result = await verifyRailgunOwnTxid(input);
  expect(result).toMatchObject({
    pathVerified: true,
    utilityExitObserved: true,
    spendingEnabled: false,
    sourceAuthenticated: false,
    rootAccepted: false,
    globalTxidCompleteness: false,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.unshieldCommitmentVerified).toBe(false);
  expect(mockTask.close).toHaveBeenCalled();
  const options = startRailgunProcess.mock.calls[0][0];
  for (const field of ['binaryKey', 'storage', 'createProvider'])
    expect(options[field]).toBeUndefined();
  expect(Object.keys(JSON.parse(options.input)).sort()).toEqual([
    'archive',
    'bindingDigest',
    'state',
    'witness',
  ]);
});
test.each(['full', 'partial'])(
  'requires affirmative unshield verification for a matched %s withdrawal',
  async (kind) => {
    const evidence =
      kind === 'partial'
        ? require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial()
        : sample(true);
    const projection = createRailgunTxidProjection({
      hashPair: pair,
      zeroNodes: zeros,
      transactionHash: (r) => ({
        hash: hash(JSON.stringify(r)),
        railgunTxid: hash(r.nullifiers[0]),
      }),
      verificationHash: () => evidence.row.verificationHash,
    });
    const values = new Map(),
      read = async (key) => values.get(key) ?? null;
    const { state, writes } = await projection.append(projection.empty(), [evidence.row], read);
    writes.forEach(({ key, value }) => values.set(key, value));
    const witness = await projection.witness(state, hash(evidence.row.nullifiers[0]), read);
    const options = { ...input, evidence, state, witness };
    expect(await verifyRailgunOwnTxid(options)).toMatchObject({
      unshieldCommitmentVerified: true,
      pathVerified: true,
      sourceAuthenticated: false,
      rootAccepted: false,
      spendingEnabled: false,
      utilityExitObserved: true,
    });
    mockMode = 'unshield';
    await expect(verifyRailgunOwnTxid(options)).rejects.toMatchObject({
      code: 'RAILGUN_OWN_TXID_VERIFICATION_REFUSED',
    });
    expect(mockTask.close).toHaveBeenCalled();
  }
);
test.each([
  'key',
  'input',
  'get',
  'provider',
  'digest',
  'inventory',
  'authority',
  'guards',
  'path',
  'binding',
  'txid',
  'unshield',
  'missing',
  'duplicate',
  'crash',
])('refuses %s without leaving a utility alive', async (mode) => {
  mockMode = mode;
  await expect(verifyRailgunOwnTxid(input)).rejects.toMatchObject({
    code: 'RAILGUN_OWN_TXID_VERIFICATION_REFUSED',
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
    const pending = verifyRailgunOwnTxid({ ...input, timeoutMs: 20 });
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
    expect(await outcome).toMatchObject({ code: 'RAILGUN_OWN_TXID_VERIFICATION_REFUSED' });
  }
);
test('refuses unmatched own data, a different row and oversize input before starting', async () => {
  const changed = structuredClone(input.evidence);
  changed.row.nullifiers[0] = '0x' + hash('wrong');
  await expect(verifyRailgunOwnTxid({ ...input, evidence: changed })).rejects.toThrow();
  const witness = structuredClone(input.witness);
  witness.row.timestamp++;
  witness.rowSha256 = createHash('sha256').update(JSON.stringify(witness.row)).digest('hex');
  await expect(verifyRailgunOwnTxid({ ...input, witness })).rejects.toThrow();
  await expect(
    verifyRailgunOwnTxid({
      ...input,
      state: { ...input.state, extra: 'x'.repeat(65536) },
    })
  ).rejects.toThrow();
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
  await expect(verifyRailgunOwnTxid(input)).rejects.toMatchObject({
    code: 'RAILGUN_OWN_TXID_VERIFICATION_REFUSED',
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
    const pending = verifyRailgunOwnTxid(input).then(
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
      expect(await pending).toMatchObject({
        error: { code: 'RAILGUN_OWN_TXID_VERIFICATION_REFUSED' },
      });
    } finally {
      mockExit();
      await pending;
    }
  }
);
