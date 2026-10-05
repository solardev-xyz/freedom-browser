let mockEnrollment, mockMode, mockTask, mockExit, mockDeferExit;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (v) => v }));
jest.mock('./railgun-private-intent', () => ({
  matchRailgunPrivateProvedTransaction: () => ({ digest: '0x' + '1'.repeat(64) }),
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    let finish, reject;
    const closed = new Promise((resolve) => {
      finish = resolve;
    });
    mockExit = () =>
      finish({
        code: mockMode === 'crash' ? 'RAILGUN_PROCESS_FAILED' : 'RAILGUN_PROCESS_CLOSED',
        exitCode: 15,
      });
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
      const value = {
        transactionDigest: '0x' + '1'.repeat(64),
        verified: true,
        guards: { attempts: 0, canaries: 1, hooks: ['test.guard'] },
        proverSha256: require('./railgun-prover-manifest.json').sha256,
      };
      if (mockMode === 'invalid-proof') value.verified = false;
      if (mockMode === 'wrong-digest') value.transactionDigest = '0x' + '2'.repeat(64);
      const wire = JSON.stringify(
        mockMode === 'key'
          ? { id: 1, method: 'key', purpose: 'spending-sign' }
          : { id: 1, method: 'result', value }
      );
      await options.broker.dispatch(wire);
      if (mockMode === 'duplicate') await options.broker.dispatch(wire);
    });
    return mockTask;
  }),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { verifyRailgunPrivateProof, assertRailgunPrivateProof } = require('./railgun-private-proof');
const { startRailgunProcess } = require('./railgun-process');
let scope, controller, input, results;
beforeEach(() => {
  jest.clearAllMocks();
  mockMode = 'valid';
  mockDeferExit = false;
  results = [];
  scope = createPrivacyScope({ profileId: 'proof-fixture', signal: new AbortController().signal });
  controller = new AbortController();
  mockEnrollment = {
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
  input = {
    enrollment: mockEnrollment,
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    intent: { data: 'original' },
    transaction: { data: 'proved' },
    expected: { input: 'exact' },
    signal: controller.signal,
  };
});
afterEach(() => {
  results.forEach((r) => r.close());
  controller.abort();
  scope.close();
  jest.useRealTimers();
});
async function verify(extra = {}) {
  const result = await verifyRailgunPrivateProof({ ...input, ...extra });
  results.push(result);
  return result;
}
test('issues exact account-bound evidence only after verifier exit and passes no key or database', async () => {
  const result = await verify();
  expect(mockTask.close).toHaveBeenCalled();
  expect(assertRailgunPrivateProof(result.receipt, mockEnrollment, input)).toEqual({
    transactionDigest: '0x' + '1'.repeat(64),
    verified: true,
    utilityExitObserved: true,
  });
  expect(() => assertRailgunPrivateProof({ ...result.receipt }, mockEnrollment, input)).toThrow();
  expect(() => assertRailgunPrivateProof(result.receipt, { ...mockEnrollment }, input)).toThrow();
  expect(() =>
    assertRailgunPrivateProof(result.receipt, mockEnrollment, {
      ...input,
      transaction: { data: 'other' },
    })
  ).toThrow();
  const job = startRailgunProcess.mock.calls[0][0];
  expect(job.binaryKey).toBeUndefined();
  expect(Object.keys(JSON.parse(job.input)).sort()).toEqual([
    'archive',
    'artifactDirectory',
    'expected',
    'intent',
    'transaction',
  ]);
  input.transaction.data = 'mutated';
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input)).toThrow();
  expect(() =>
    assertRailgunPrivateProof(result.receipt, mockEnrollment, {
      ...input,
      transaction: { data: 'proved' },
    })
  ).not.toThrow();
  result.close();
  expect(() =>
    assertRailgunPrivateProof(result.receipt, mockEnrollment, {
      ...input,
      transaction: { data: 'proved' },
    })
  ).toThrow();
});
test.each(['duplicate', 'key', 'invalid-proof', 'wrong-digest', 'crash'])(
  '%s never grants a receipt and drains the child',
  async (mode) => {
    mockMode = mode;
    await expect(verify()).rejects.toMatchObject({ code: 'RAILGUN_PRIVATE_PROOF_REFUSED' });
    expect(mockTask.close).toHaveBeenCalled();
  }
);
test('receipt publication and next verification wait for the previous child to exit', async () => {
  mockDeferExit = true;
  let settled = false;
  const pending = verify().then((v) => {
    settled = true;
    return v;
  });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(mockTask.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  await expect(verify()).rejects.toThrow();
  expect(startRailgunProcess).toHaveBeenCalledTimes(1);
  mockExit();
  const result = await pending;
  expect(settled).toBe(true);
  result.close();
});
test('a caller abort terminates a pending verifier and revokes prior evidence', async () => {
  const first = await verify();
  mockMode = 'hang';
  const pending = verify();
  const rejected = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_PRIVATE_PROOF_REFUSED' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  controller.abort();
  await rejected;
  expect(() => assertRailgunPrivateProof(first.receipt, mockEnrollment, input)).toThrow();
});
test('receipt has a separate bounded lifetime after process exit', async () => {
  jest.useFakeTimers();
  const result = await verify({ timeoutMs: 20 });
  await jest.advanceTimersByTimeAsync(21);
  expect(result.signal.aborted).toBe(false);
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input)).not.toThrow();
  await jest.advanceTimersByTimeAsync(60000);
  expect(result.signal.aborted).toBe(true);
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input)).toThrow();
});

test('pre-launch validation errors are sanitized and start no child', async () => {
  await expect(verify({ enrollment: {} })).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_PROOF_REFUSED',
  });
  await expect(verify({ timeoutMs: 0 })).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_PROOF_REFUSED',
  });
  expect(startRailgunProcess).not.toHaveBeenCalled();
});
test('a pending verifier is terminated when its own process deadline elapses', async () => {
  jest.useFakeTimers();
  mockMode = 'hang';
  const pending = verify({ timeoutMs: 20 });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_PRIVATE_PROOF_REFUSED' });
  await jest.advanceTimersByTimeAsync(21);
  await rejected;
  expect(mockTask.close).toHaveBeenCalled();
});

// These exercise the actual private receipt deadline, not a host mock. Timers
// deliberately stay delayed while monotonic time advances.
afterEach(() => jest.restoreAllMocks());
test('genuine receipt margin is strict at the private post-exit deadline and never renews', async () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const result = await verify();
  const original = assertRailgunPrivateProof(result.receipt, mockEnrollment, input);
  expect(assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 59999)).toBe(original);
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 60000)).toThrow();
  now = 10999;
  expect(assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 50000)).toBe(original);
  now = 11000;
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 50000)).toThrow();
  expect(assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 49999)).toBe(original);
  now = 60999;
  expect(assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 0)).toBe(original);
  now = 61000;
  expect(result.signal.aborted).toBe(false); // Delayed timer is not authority.
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input)).toThrow();
  expect(startRailgunProcess).toHaveBeenCalledTimes(1);
});
test.each([-1, 0.5, NaN, Infinity, null, '0', 60000, Number.MAX_SAFE_INTEGER + 1])(
  'invalid proof margin %p refuses without revoking otherwise-current evidence',
  async (margin) => {
    const result = await verify();
    expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input, margin)).toThrow(
      expect.objectContaining({ code: 'RAILGUN_PRIVATE_PROOF_REFUSED' })
    );
    expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 0)).not.toThrow();
    expect(result.signal.aborted).toBe(false);
  }
);
test('margin reads the observed-exit lifetime rather than the shorter verifier job budget', async () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mockDeferExit = true;
  const pending = verify({ timeoutMs: 15000 });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(mockTask.close).toHaveBeenCalled();
  now = 10000;
  mockExit();
  const result = await pending;
  expect(() =>
    assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 59999)
  ).not.toThrow();
  now = 70000;
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 0)).toThrow();
});
test('margin cannot bypass backward time, owner revocation or original evidence binding', async () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const result = await verify();
  now = 999;
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 0)).toThrow();
  now = 1000;
  expect(() =>
    assertRailgunPrivateProof(
      result.receipt,
      mockEnrollment,
      {
        ...input,
        transaction: { data: 'other' },
      },
      50000
    )
  ).toThrow();
  controller.abort();
  expect(() => assertRailgunPrivateProof(result.receipt, mockEnrollment, input, 0)).toThrow();
});
