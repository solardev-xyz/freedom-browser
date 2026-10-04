let mockIdentity,
  mockEnrollment,
  mockCoordinator,
  mockPublicIdentity,
  mockObserved,
  mockExpected,
  mockCapture,
  mockPhase,
  mockEvents,
  mockTask,
  mockWindow,
  mockScenario,
  mockKeyMutation,
  mockResultMutation,
  mockDeferExit,
  mockStartError,
  mockReattest,
  mockCredential,
  mockVerifier,
  mockRecoveryStart,
  mockRecoveryPost,
  mockMembershipCurrent,
  mockIdentityCurrent,
  mockBorrowed,
  mockCopies;
const mockReceipts = new WeakSet();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: jest.fn((identity) => {
    if (identity !== mockIdentity || identity.signal.aborted || !mockIdentityCurrent)
      throw Error('identity');
    return identity.descriptor;
  }),
  withRailgunViewingCredential: jest.fn((identity, use) => {
    if (identity !== mockIdentity) throw Error('identity');
    return mockCredential(use);
  }),
}));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (coordinator, enrollment) => {
    if (
      coordinator !== mockCoordinator ||
      enrollment !== mockEnrollment ||
      coordinator.signal.aborted
    )
      throw Error('owner');
    return mockPublicIdentity;
  },
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'policy' }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (v) => v }));
jest.mock('./railgun-own-poi-membership', () => ({
  assertRailgunOwnPoiMembership: jest.fn((receipt, enrollment, coordinator) => {
    if (
      !mockReceipts.has(receipt) ||
      enrollment !== mockEnrollment ||
      coordinator !== mockCoordinator ||
      !mockMembershipCurrent
    )
      throw Error('membership');
    return mockObserved;
  }),
}));
jest.mock('./railgun-own-poi-proof-data', () => {
  const actual = jest.requireActual('./railgun-own-poi-proof-data');
  return {
    // Structural preparation/crypto have their own suites. Keep the actual
    // public payload normalizer/binder and the actual strict capture comparator.
    normalizeRailgunOwnPoiProofInput: jest.fn((v) => JSON.parse(JSON.stringify(v))),
    expectedRailgunOwnPoiFields: jest.fn(() => JSON.parse(JSON.stringify(mockExpected))),
    bindRailgunOwnPoiPayload: actual.bindRailgunOwnPoiPayload,
  };
});
jest.mock('./railgun-own-operation', () => ({
  withRailgunOwnOperationRecovery: jest.fn(async (options, use) => {
    if (mockPhase) throw Error('phase busy');
    mockPhase = 'window';
    mockEvents.push('window-open');
    const controller = new AbortController(),
      deadline = performance.now() + options.timeoutMs;
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let accepting = true;
    const active = (margin = 0) => {
      if (
        !accepting ||
        signal.aborted ||
        !Number.isSafeInteger(margin) ||
        margin < 0 ||
        performance.now() + margin >= deadline ||
        mockPhase !== 'window'
      )
        throw Error('window expired');
    };
    mockWindow = Object.freeze({
      capture: JSON.parse(JSON.stringify(mockCapture)),
      signal,
      assertCurrent: jest.fn(active),
      reattest: jest.fn(async () => {
        active();
        mockEvents.push('reattest');
        const result = await mockReattest();
        active();
        return result;
      }),
    });
    try {
      await mockRecoveryStart();
      active();
      let value;
      try {
        value = await use(mockWindow);
      } catch {
        return { status: 'refused', stage: 'callback' };
      }
      active();
      accepting = false;
      controller.abort();
      mockEvents.push('recovery-post');
      await mockRecoveryPost();
      if (options.signal.aborted || performance.now() >= deadline) throw Error('recovery ended');
      return { status: 'used', value: JSON.parse(JSON.stringify(value)) };
    } finally {
      accepting = false;
      controller.abort();
      mockEvents.push('window-close');
      mockPhase = null;
    }
  }),
}));
jest.mock('./railgun-account-phase', () => ({
  claimRailgunAccountPhase: jest.fn((enrollment, phase) => {
    if (enrollment !== mockEnrollment || phase !== 'recovery' || mockPhase)
      throw Error('phase busy');
    mockPhase = 'verify';
    mockEvents.push('verify-claim');
    let released = false;
    return {
      assertCurrent() {
        if (released || mockPhase !== 'verify' || enrollment.signal.aborted)
          throw Error('phase ended');
      },
      release: jest.fn(() => {
        if (!released) {
          released = true;
          mockEvents.push('verify-release');
          mockPhase = null;
        }
      }),
    };
  }),
}));
jest.mock('./railgun-poi-verifier', () => ({
  verifyRailgunPoiPayload: jest.fn((options) => mockVerifier(options)),
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    if (mockStartError) throw Error('start refused');
    if (mockPhase !== 'window') throw Error('no recovery');
    mockEvents.push('job-start');
    let resolveReady,
      rejectReady,
      resolveExit,
      exited = false;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const closed = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const task = {
      ready,
      closed,
      options,
      exit() {
        if (!exited) {
          exited = true;
          mockEvents.push('job-exit');
          resolveExit({ code: 'RAILGUN_PROCESS_CLOSED' });
        }
      },
      close: jest.fn(() => {
        rejectReady(Error('utility closed'));
        if (!mockDeferExit) task.exit();
      }),
    };
    options.broker.signal.addEventListener('abort', () => task.close(), { once: true });
    // ready rejects on cancellation independently of borrowed dispatch work.
    // Its driver can still be awaiting a credential/store callback after exit.
    Promise.resolve()
      .then(() => mockScenario(options, task))
      .then(resolveReady, rejectReady);
    mockTask = task;
    return task;
  }),
}));
const { createHash } = require('crypto');
const { proveRailgunOwnPoi: prove } = require('./railgun-own-poi-proof');
const { startRailgunProcess } = require('./railgun-process');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const { withRailgunViewingCredential } = require('./railgun-identity');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { verifyRailgunPoiPayload } = require('./railgun-poi-verifier');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const copy = (v) => JSON.parse(JSON.stringify(v));
const sha = (v) => createHash('sha256').update(v).digest('hex');
let caller,
  identityController,
  enrollmentController,
  coordinatorController,
  options,
  gates,
  operations;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  const gate = { promise, resolve, reject };
  gates.push(gate);
  return gate;
};
const waitFor = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await Promise.resolve();
  expect(check()).toBe(true);
};
const receipt = () => {
  const r = Object.freeze({});
  mockReceipts.add(r);
  return r;
};
const run = (value = options) => {
  const work = prove(value);
  operations.push(work);
  return work;
};
const payload = () =>
  normalizeRailgunPoiPayload({
    listKey: mockExpected.listKey,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: mockExpected.poiMerkleroots,
    txidMerkleroot: mockExpected.txidMerkleroot,
    txidMerklerootIndex: mockExpected.txidMerklerootIndex,
    blindedCommitmentsOut: mockExpected.outputCount ? [hex(8)] : [],
    railgunTxidIfHasUnshield: mockExpected.railgunTxidIfHasUnshield,
  });
const keyWire = (job) => ({
  id: 1,
  method: 'key',
  purpose: 'poi-prove',
  inputSha256: sha(job.input),
});
const resultWire = (job) => {
  const p = payload();
  return {
    id: 2,
    method: 'result',
    value: {
      inputSha256: sha(job.input),
      payloadSha256: sha(JSON.stringify(p)),
      payload: copy(p),
      locallyVerified: true,
      independentlyVerified: false,
      sourceAuthenticated: false,
      membershipAuthenticated: false,
      rootAccepted: false,
      disclosureEnabled: false,
      spendingEnabled: false,
      engineSha256: require('./railgun-engine-manifest.json').sha256,
      proverSha256: require('./railgun-prover-manifest.json').sha256,
      guards: { attempts: 0, canaries: 1, hooks: ['fixture.guard'] },
    },
  };
};
const sendKey = async (job) => {
  const message = keyWire(job);
  mockKeyMutation(message);
  const bytes = await job.broker.dispatch(JSON.stringify(message));
  mockCopies.push(bytes);
  mockEvents.push('key-copy');
  return bytes;
};
const sendResult = async (job) => {
  const message = resultWire(job);
  mockResultMutation(message);
  return job.broker.dispatch(JSON.stringify(message));
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  gates = [];
  operations = [];
  mockEvents = [];
  mockBorrowed = [];
  mockCopies = [];
  mockTask = mockWindow = undefined;
  mockPhase = null;
  mockDeferExit = mockStartError = false;
  mockMembershipCurrent = mockIdentityCurrent = true;
  caller = new AbortController();
  identityController = new AbortController();
  enrollmentController = new AbortController();
  coordinatorController = new AbortController();
  const descriptor = { walletId: 'wallet', accountIndex: 0, instanceId: 'address' };
  mockIdentity = { signal: identityController.signal, descriptor };
  mockEnrollment = {
    directory: '/synthetic-proof-account',
    descriptor,
    signal: enrollmentController.signal,
    getContext: jest.fn((role, operation) => Object.freeze({ role, operation })),
  };
  mockCoordinator = { signal: coordinatorController.signal };
  mockPublicIdentity = { generationId: 'one', sourceId: 'source', publicId: 'public' };
  mockCapture = {
    bindingDigest: 'a'.repeat(64),
    selector: { tree: 0, position: 0, noteHash: hex(2), nullifier: hex(3) },
    facts: {},
    submitter: 'owner',
    capsule: { walletId: 'wallet' },
    capsuleDigest: 'b'.repeat(64),
    provedTransaction: {},
    intent: {},
    projection: {},
    record: { revision: 1 },
  };
  mockExpected = {
    listKey: REQUIRED_LIST,
    poiMerkleroots: [hex(5).slice(2)],
    txidMerkleroot: hex(6).slice(2),
    txidMerklerootIndex: 4,
    railgunTxidIfHasUnshield: '0x00',
    outputCount: 1,
  };
  mockObserved = {
    capture: copy(mockCapture),
    poiPreparation: { ownEvidence: { capsule: copy(mockCapture.capsule) } },
    selector: { blindedCommitment: hex(4) },
    membership: {
      membershipVerified: true,
      proofs: [{ leaf: hex(4).slice(2), root: hex(5).slice(2) }],
    },
  };
  mockReattest = jest.fn(async () => copy(mockCapture));
  mockRecoveryStart = jest.fn(async () => {});
  mockRecoveryPost = jest.fn(async () => {});
  mockCredential = jest.fn(async (use) => {
    expect(mockPhase).toBe('window');
    mockEvents.push('derive');
    const key = Buffer.alloc(32, 7);
    mockBorrowed.push(key);
    try {
      return await use({ viewingKey: key, spendingPublicKey: ['public'] });
    } finally {
      key.fill(0);
      mockEvents.push('credential-wipe');
    }
  });
  mockVerifier = jest.fn(async ({ payload: p }) => {
    expect(mockPhase).toBe('verify');
    expect(mockWindow.signal.aborted).toBe(true);
    mockEvents.push('keyless-verify');
    return {
      utilityExitObserved: true,
      proofVerified: true,
      independentlyVerified: true,
      payloadSha256: sha(JSON.stringify(p)),
    };
  });
  mockKeyMutation = () => {};
  mockResultMutation = () => {};
  mockScenario = async (job) => {
    await sendKey(job);
    await sendResult(job);
  };
  options = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    coordinator: mockCoordinator,
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    membershipReceipt: receipt(),
    signal: caller.signal,
  };
});
afterEach(async () => {
  caller.abort();
  identityController.abort();
  enrollmentController.abort();
  coordinatorController.abort();
  for (const gate of gates) gate.resolve();
  mockTask?.exit();
  await Promise.allSettled(operations);
  jest.useRealTimers();
});

test.each([false, true])(
  'successful %s proof drains recovery before separate keyless verification',
  async (unshield) => {
    if (unshield) {
      mockExpected.outputCount = 0;
      mockExpected.railgunTxidIfHasUnshield = hex(9);
    }
    const result = await run();
    expect(result).toMatchObject({
      status: 'proved',
      payload: payload(),
      locallyVerified: true,
      separatelyVerified: true,
      utilityExitObserved: true,
    });
    expect(result.payloadSha256).toBe(sha(JSON.stringify(result.payload)));
    expect(Object.isFrozen(result.payload.proof.pi_a)).toBe(true);
    for (const flag of [
      'accountAuthenticated',
      'sourceAuthenticated',
      'currentFinalityVerified',
      'membershipAuthenticated',
      'rootAccepted',
      'disclosureEnabled',
      'spendingEnabled',
    ])
      expect(result[flag]).toBe(false);
    expect(mockEvents).toEqual([
      'window-open',
      'job-start',
      'reattest',
      'derive',
      'reattest',
      'credential-wipe',
      'key-copy',
      'job-exit',
      'recovery-post',
      'window-close',
      'verify-claim',
      'keyless-verify',
      'verify-release',
    ]);
    const job = startRailgunProcess.mock.calls[0][0];
    expect(job).toMatchObject({
      binaryKey: true,
      startupMs: 110000,
      lifetimeMs: 110000,
      heapMb: 256,
      rssMb: 768,
      filename: require.resolve('./railgun-own-poi-prove-job'),
    });
    expect(job.handle).toEqual({ role: 'engine', operation: 'poi-prove' });
    expect(withRailgunOwnOperationRecovery.mock.calls[0][0].timeoutMs).toBe(120000);
    expect(mockWindow.reattest).toHaveBeenCalledTimes(2);
    expect(mockCopies[0]).not.toBe(mockBorrowed[0]);
    expect(mockCopies[0]).toEqual(Buffer.alloc(32));
    expect(mockBorrowed[0]).toEqual(Buffer.alloc(32));
    expect(verifyRailgunPoiPayload.mock.calls[0][0].handle).toEqual({
      role: 'prover',
      operation: 'poi-verify',
    });
    expect(mockPhase).toBeNull();
  }
);
test.each([
  'enrollment',
  'identity',
  'coordinator',
  'receipt',
  'descriptor',
  'extra',
  'aborted',
  'membership',
])('invalid %s refuses before recovery', async (fault) => {
  const x = { ...options };
  if (['enrollment', 'identity', 'coordinator'].includes(fault)) x[fault] = {};
  if (fault === 'receipt') x.membershipReceipt = {};
  if (fault === 'descriptor') mockEnrollment.descriptor = { walletId: 'other' };
  if (fault === 'extra') x.payload = payload();
  if (fault === 'aborted') caller.abort();
  if (fault === 'membership') mockObserved.membership.membershipVerified = false;
  expect(await run(x)).toEqual({ status: 'refused', stage: 'context' });
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  expect(startRailgunProcess).not.toHaveBeenCalled();
});
test.each(['purpose', 'hash', 'method', 'id', 'extra'])(
  'malformed key %s refuses before consuming the receipt',
  async (fault) => {
    mockKeyMutation = (v) => {
      if (fault === 'purpose') v.purpose = 'spend';
      if (fault === 'hash') v.inputSha256 = '0'.repeat(64);
      if (fault === 'method') v.method = 'get';
      if (fault === 'id') v.id = 2;
      if (fault === 'extra') v.extra = true;
    };
    expect((await run()).status).toBe('refused');
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    mockKeyMutation = () => {};
    expect((await run()).status).toBe('proved');
  }
);
test.each(['start', 'late'])('%s request refusal leaves membership reusable', async (fault) => {
  if (fault === 'start') mockStartError = true;
  else
    mockScenario = async (job) => {
      jest.advanceTimersByTime(100000);
      await sendKey(job);
    };
  expect((await run()).status).toBe('refused');
  expect(mockReattest).not.toHaveBeenCalled();
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  mockStartError = false;
  mockScenario = async (job) => {
    await sendKey(job);
    await sendResult(job);
  };
  expect((await run()).status).toBe('proved');
});
test.each(['reattest', 'derive', 'post-derive'])(
  'valid key request consumes receipt on %s failure',
  async (fault) => {
    if (fault === 'reattest') mockReattest.mockRejectedValueOnce(Error('private'));
    if (fault === 'derive') mockCredential.mockRejectedValueOnce(Error('private'));
    if (fault === 'post-derive')
      mockReattest.mockResolvedValueOnce(copy(mockCapture)).mockRejectedValueOnce(Error('private'));
    expect((await run()).status).toBe('refused');
    const launches = startRailgunProcess.mock.calls.length;
    expect(await run()).toEqual({ status: 'refused', stage: 'context' });
    expect(startRailgunProcess).toHaveBeenCalledTimes(launches);
    expect(mockCopies).toHaveLength(0);
    for (const key of mockBorrowed) expect(key).toEqual(Buffer.alloc(32));
  }
);
test('successful receipt cannot release another key', async () => {
  expect((await run()).status).toBe('proved');
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
  expect(startRailgunProcess).toHaveBeenCalledTimes(1);
  expect(withRailgunViewingCredential).toHaveBeenCalledTimes(1);
});
test.each(['binding', 'capsule', 'projection', 'archive', 'anchor'])(
  'capture %s drift refuses before key release',
  async (fault) => {
    if (fault === 'binding') mockCapture.bindingDigest = 'f'.repeat(64);
    if (fault === 'capsule') mockCapture.capsule = { changed: true };
    if (fault === 'projection') mockCapture.projection = { changed: true };
    if (fault === 'archive') mockCapture.record = { archivedAt: 1, finalized: { blockNumber: 1 } };
    if (fault === 'anchor') {
      mockObserved.capture.record = {
        archivedAt: 1,
        finalized: { blockNumber: 1, blockHash: hex(1) },
      };
      mockCapture.record = { archivedAt: 1, finalized: { blockNumber: 2, blockHash: hex(2) } };
    }
    expect((await run()).status).toBe('refused');
    expect(startRailgunProcess).not.toHaveBeenCalled();
    mockCapture = copy(mockObserved.capture);
    expect((await run()).status).toBe('proved');
  }
);
test.each(['identity', 'generation'])(
  '%s changes during credential derivation prevent copy',
  async (fault) => {
    const original = mockCredential.getMockImplementation();
    mockCredential.mockImplementationOnce(async (use) => {
      if (fault === 'identity') mockIdentityCurrent = false;
      else mockPublicIdentity = { ...mockPublicIdentity, generationId: 'two' };
      return original(use);
    });
    expect((await run()).status).toBe('refused');
    expect(mockCopies).toHaveLength(0);
    expect(mockBorrowed[0]).toEqual(Buffer.alloc(32));
    expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
  }
);
test.each([
  [1, 'binding'],
  [1, 'anchor'],
  [2, 'binding'],
  [2, 'anchor'],
])('reattest %s detects coherent %s drift and consumes the request', async (at, fault) => {
  if (fault === 'anchor') {
    mockCapture.record = { archivedAt: 1, finalized: { blockNumber: 1, blockHash: hex(1) } };
    mockObserved.capture = copy(mockCapture);
  }
  const changed = copy(mockCapture);
  if (fault === 'binding') changed.bindingDigest = 'c'.repeat(64);
  else changed.record.finalized = { blockNumber: 2, blockHash: hex(2) };
  if (at === 2) mockReattest.mockResolvedValueOnce(copy(mockCapture));
  mockReattest.mockResolvedValueOnce(changed);
  expect((await run()).status).toBe('refused');
  expect(mockWindow.reattest).toHaveBeenCalledTimes(at);
  expect(withRailgunViewingCredential).toHaveBeenCalledTimes(at - 1);
  expect(mockCopies).toHaveLength(0);
  expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
  for (const key of mockBorrowed) expect(key).toEqual(Buffer.alloc(32));
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
});
test('routine record revision changes remain acceptable across fresh reattestations', async () => {
  mockReattest.mockImplementation(async () => ({
    ...copy(mockCapture),
    record: { ...copy(mockCapture.record), revision: 999 },
  }));
  expect((await run()).status).toBe('proved');
});
test.each(['identity', 'enrollment', 'coordinator'])(
  '%s revocation during derivation prevents key copy',
  async (parent) => {
    const original = mockCredential.getMockImplementation();
    mockCredential.mockImplementationOnce(async (use) => {
      ({
        identity: identityController,
        enrollment: enrollmentController,
        coordinator: coordinatorController,
      })[parent].abort();
      return original(use);
    });
    expect((await run()).status).toBe('refused');
    expect(mockTask.options.broker.signal.aborted).toBe(true);
    expect(mockCopies).toHaveLength(0);
    expect(mockBorrowed[0]).toEqual(Buffer.alloc(32));
    expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
    expect(mockPhase).toBeNull();
  }
);
test.each([31, 33, 'array'])('invalid credential shape %s cannot be copied', async (shape) => {
  mockCredential.mockImplementationOnce(async (use) =>
    use({ viewingKey: shape === 'array' ? Array(32).fill(7) : Buffer.alloc(shape, 7) })
  );
  expect((await run()).status).toBe('refused');
  expect(mockCopies).toHaveLength(0);
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
});
test.each(['resolve', 'reject'])(
  'outer recovery post-attestation must %s before a keyless phase can start',
  async (outcome) => {
    const gate = deferred(),
      entered = deferred();
    mockRecoveryPost.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
    });
    let settled = false;
    const pending = run().then((v) => {
      settled = true;
      return v;
    });
    await entered.promise;
    expect(mockWindow.signal.aborted).toBe(true);
    expect(mockPhase).toBe('window');
    expect(settled).toBe(false);
    expect(claimRailgunAccountPhase).not.toHaveBeenCalled();
    expect(mockCopies[0]).toEqual(Buffer.alloc(32));
    if (outcome === 'resolve') gate.resolve();
    else gate.reject(Error('post-attestation refused'));
    expect((await pending).status).toBe(outcome === 'resolve' ? 'proved' : 'refused');
    expect(verifyRailgunPoiPayload).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
    expect(mockPhase).toBeNull();
  }
);
test.each(['derive', 'first-reattest', 'second-reattest'])(
  'cancellation after utility exit drains borrowed %s before releasing recovery/owner',
  async (where) => {
    const gate = deferred(),
      entered = deferred();
    if (where === 'derive') {
      const original = mockCredential.getMockImplementation();
      mockCredential.mockImplementationOnce(async (use) => {
        entered.resolve();
        await gate.promise;
        return original(use);
      });
    } else {
      if (where === 'second-reattest') mockReattest.mockResolvedValueOnce(copy(mockCapture));
      mockReattest.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return copy(mockCapture);
      });
    }
    let settled = false;
    const pending = run().then((v) => {
      settled = true;
      return v;
    });
    await entered.promise;
    const firstTask = mockTask;
    caller.abort();
    await firstTask.closed;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockPhase).toBe('window');
    const launches = startRailgunProcess.mock.calls.length;
    const other = {
      ...options,
      signal: new AbortController().signal,
      membershipReceipt: receipt(),
    };
    expect(await run(other)).toEqual({ status: 'refused', stage: 'context' });
    expect(startRailgunProcess).toHaveBeenCalledTimes(launches);
    expect(claimRailgunAccountPhase).not.toHaveBeenCalled();
    gate.resolve();
    expect((await pending).status).toBe('refused');
    expect(mockPhase).toBeNull();
    expect(mockCopies).toHaveLength(0);
    for (const key of mockBorrowed) expect(key).toEqual(Buffer.alloc(32));
    expect((await run(other)).status).toBe('proved');
  }
);
test('same-account owner excludes another receipt until successful prover exit and verifier drain', async () => {
  const gate = deferred(),
    entered = deferred();
  const original = mockVerifier.getMockImplementation();
  mockVerifier.mockImplementationOnce(async (v) => {
    entered.resolve();
    await gate.promise;
    return original(v);
  });
  const pending = run();
  await entered.promise;
  const other = { ...options, membershipReceipt: receipt() };
  expect(await run(other)).toEqual({ status: 'refused', stage: 'context' });
  expect(mockPhase).toBe('verify');
  gate.resolve();
  expect((await pending).status).toBe('proved');
  expect((await run(other)).status).toBe('proved');
});
test('early job deadline retains cleanup budget and leaves recovery healthy', async () => {
  const entered = deferred(),
    gate = deferred();
  mockScenario = async (job) => {
    await sendKey(job);
    entered.resolve();
    await gate.promise;
  };
  let settled = false;
  const pending = run().then((v) => {
    settled = true;
    return v;
  });
  await entered.promise;
  jest.advanceTimersByTime(110000);
  expect(performance.now()).toBeLessThan(120000);
  expect((await pending).status).toBe('refused');
  expect(settled).toBe(true);
  expect(mockCopies[0]).toEqual(Buffer.alloc(32));
  expect(mockPhase).toBeNull();
  gate.resolve();
  mockScenario = async (job) => {
    await sendKey(job);
    await sendResult(job);
  };
  expect((await run({ ...options, membershipReceipt: receipt() })).status).toBe('proved');
});
test('insufficient total reserve refuses before opening recovery and preserves receipt', async () => {
  expect(await run({ ...options, timeoutMs: 55000 })).toEqual({
    status: 'refused',
    stage: 'recovery',
  });
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  expect((await run()).status).toBe('proved');
});
test.each([
  'id',
  'method',
  'shape',
  'inputSha',
  'payloadSha',
  'engine',
  'prover',
  'local',
  'independentlyVerified',
  'sourceAuthenticated',
  'membershipAuthenticated',
  'rootAccepted',
  'disclosureEnabled',
  'spendingEnabled',
  'guards',
  'canaries',
  'duplicate-hooks',
  'hook-name',
  'checkpoint',
  'txid-root',
  'poi-root',
  'marker',
  'output-count',
])('result %s refuses through actual payload binding and drains', async (fault) => {
  mockResultMutation = (m) => {
    const v = m.value;
    if (fault === 'id') m.id = 3;
    if (fault === 'method') m.method = 'input';
    if (fault === 'shape') v.extra = true;
    if (fault === 'inputSha') v.inputSha256 = 'f'.repeat(64);
    if (fault === 'payloadSha') v.payloadSha256 = 'f'.repeat(64);
    if (fault === 'engine') v.engineSha256 = 'f'.repeat(64);
    if (fault === 'prover') v.proverSha256 = 'f'.repeat(64);
    if (fault === 'local') v.locallyVerified = false;
    if (
      [
        'independentlyVerified',
        'sourceAuthenticated',
        'membershipAuthenticated',
        'rootAccepted',
        'disclosureEnabled',
        'spendingEnabled',
      ].includes(fault)
    )
      v[fault] = true;
    if (fault === 'guards') v.guards.attempts = 1;
    if (fault === 'canaries') v.guards.canaries = 2;
    if (fault === 'duplicate-hooks') {
      v.guards.hooks.push(v.guards.hooks[0]);
      v.guards.canaries = 2;
    }
    if (fault === 'hook-name') v.guards.hooks = ['../bad'];
    if (fault === 'checkpoint') v.payload.txidMerklerootIndex++;
    if (fault === 'txid-root') v.payload.txidMerkleroot = hex(88).slice(2);
    if (fault === 'poi-root') v.payload.poiMerkleroots = [hex(88).slice(2)];
    if (fault === 'marker') {
      v.payload.railgunTxidIfHasUnshield = hex(9);
      v.payload.blindedCommitmentsOut = [];
    }
    if (fault === 'output-count') v.payload.blindedCommitmentsOut = [];
    if (['checkpoint', 'txid-root', 'poi-root', 'marker', 'output-count'].includes(fault))
      v.payloadSha256 = sha(JSON.stringify(v.payload));
  };
  expect((await run()).status).toBe('refused');
  expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
  expect(mockEvents).toContain('job-exit');
  expect(mockPhase).toBeNull();
  expect(mockCopies[0]).toEqual(Buffer.alloc(32));
});
test.each(['duplicate-key', 'duplicate-result', 'result-before-key', 'missing-result'])(
  '%s sequence cannot produce a proof',
  async (fault) => {
    mockScenario = async (job) => {
      if (fault === 'result-before-key') return sendResult(job);
      await sendKey(job);
      if (fault === 'duplicate-key') return job.broker.dispatch(JSON.stringify(keyWire(job)));
      if (fault === 'missing-result') return;
      await sendResult(job);
      await sendResult(job);
    };
    expect((await run()).status).toBe('refused');
    expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
    expect(mockPhase).toBeNull();
  }
);
test('a result is not accepted before observed prover exit', async () => {
  mockDeferExit = true;
  let settled = false;
  const pending = run().then((v) => {
    settled = true;
    return v;
  });
  await waitFor(() => !!mockTask?.close.mock.calls.length);
  expect(settled).toBe(false);
  expect(mockPhase).toBe('window');
  expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
  mockTask.exit();
  expect((await pending).status).toBe('proved');
});
test.each(['throw', 'digest', 'exit', 'proof', 'independent'])(
  'keyless verifier %s failure releases phase after it settles',
  async (fault) => {
    mockVerifier.mockImplementationOnce(async ({ payload: p }) => {
      if (fault === 'throw') throw Error('private verifier detail');
      return {
        utilityExitObserved: fault !== 'exit',
        proofVerified: fault !== 'proof',
        independentlyVerified: fault !== 'independent',
        payloadSha256: fault === 'digest' ? 'f'.repeat(64) : sha(JSON.stringify(p)),
      };
    });
    expect(await run()).toEqual({ status: 'refused', stage: 'verify' });
    expect(mockPhase).toBeNull();
    expect(mockEvents.at(-1)).toBe('verify-release');
  }
);
test('cancelled keyless verifier must drain before releasing verification phase and owner', async () => {
  const gate = deferred(),
    entered = deferred();
  mockVerifier.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    throw Error('closed');
  });
  let settled = false;
  const pending = run().then((v) => {
    settled = true;
    return v;
  });
  await entered.promise;
  caller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mockPhase).toBe('verify');
  gate.resolve();
  expect(await pending).toEqual({ status: 'refused', stage: 'verify' });
  expect(mockPhase).toBeNull();
});
