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
  mockCloseError,
  mockRejectExit,
  mockStartup,
  mockClosedRead,
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
      rejectExit,
      exited = false,
      closedReads = 0;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const closed = new Promise((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    closed.catch(() => {});
    const task = {
      ready,
      get closed() {
        mockClosedRead(++closedReads);
        return closed;
      },
      options,
      exit() {
        if (!exited) {
          exited = true;
          mockEvents.push('job-exit');
          if (mockRejectExit) rejectExit(Error('sensitive exit details'));
          else resolveExit({ code: 'RAILGUN_PROCESS_CLOSED' });
        }
      },
      close: jest.fn(() => {
        rejectReady(Error('utility closed'));
        if (!mockDeferExit) task.exit();
        if (mockCloseError) throw Error('sensitive close details');
      }),
    };
    // The real supervisor owns its shutdown; a deliberately throwing host
    // close method must not create an unrelated mock abort-listener exception.
    options.broker.signal.addEventListener('abort', () => rejectReady(Error('utility aborted')), {
      once: true,
    });
    // ready rejects on cancellation independently of borrowed dispatch work.
    // Its driver can still be awaiting a credential/store callback after exit.
    Promise.resolve()
      .then(() => mockScenario(options, task))
      .then(resolveReady, rejectReady);
    mockTask = task;
    mockStartup(options, task);
    return task;
  }),
}));
const { createHash } = require('crypto');
const {
  proveRailgunOwnPoi: prove,
  assertRailgunOwnPoiProof: historyOf,
} = require('./railgun-own-poi-proof');
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
  mockDeferExit = mockStartError = mockCloseError = mockRejectExit = false;
  mockStartup = mockClosedRead = () => {};
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
    poiPreparation: {
      creator: { type: 'Shield' },
      ownEvidence: { capsule: copy(mockCapture.capsule) },
    },
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
  jest.restoreAllMocks();
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

const expectHistoryRefused = (
  value,
  enrollment = mockEnrollment,
  coordinator = mockCoordinator
) => {
  let failure;
  try {
    historyOf(value, enrollment, coordinator);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    code: 'RAILGUN_OWN_POI_PROOF_HISTORY_REFUSED',
    message: 'Railgun own POI proof history unavailable',
  });
  expect(Object.keys(failure)).toEqual(['code']);
  expect(failure.cause).toBeUndefined();
};
const expectDeepFrozen = (value) => {
  if (!value || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(expectDeepFrozen);
};
test('registered history is bounded detached deeply frozen data with unchanged public result schema', async () => {
  const result = await run();
  expect(result.status).toBe('proved');
  const history = historyOf(result, mockEnrollment, mockCoordinator);
  expect(Object.keys(result).sort()).toEqual(
    [
      'status',
      'payload',
      'payloadSha256',
      'inputSha256',
      'locallyVerified',
      'separatelyVerified',
      'utilityExitObserved',
      'accountAuthenticated',
      'sourceAuthenticated',
      'currentFinalityVerified',
      'membershipAuthenticated',
      'rootAccepted',
      'disclosureEnabled',
      'spendingEnabled',
    ].sort()
  );
  expect(history).toEqual({
    txidTree: 0,
    archive: options.archive,
    publicIdentity: mockPublicIdentity,
    capture: mockObserved.capture,
    preparation: mockObserved.poiPreparation,
    selector: mockObserved.selector,
    expected: mockExpected,
    payload: result.payload,
    payloadSha256: result.payloadSha256,
    inputSha256: result.inputSha256,
  });
  expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(131072);
  expectDeepFrozen(history);
  expect(history.capture).not.toBe(mockObserved.capture);
  expect(history.capture.capsule).not.toBe(mockObserved.capture.capsule);
  expect(history.preparation).not.toBe(mockObserved.poiPreparation);
  expect(history.publicIdentity).not.toBe(mockPublicIdentity);
  expect(history.payload).not.toBe(result.payload);
  expect(history.payload.proof.pi_b[0]).not.toBe(result.payload.proof.pi_b[0]);
  const baseline = copy(history);
  mockObserved.capture.capsule.walletId = 'changed-after-return';
  mockObserved.poiPreparation.ownEvidence.capsule.walletId = 'changed-after-return';
  mockObserved.selector.blindedCommitment = hex(99);
  expect(Reflect.set(history.capture.capsule, 'walletId', 'mutated')).toBe(false);
  expect(Reflect.set(history.payload.proof.pi_b[0], '0', '999')).toBe(false);
  expect(historyOf(result, mockEnrollment, mockCoordinator)).toEqual(baseline);
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
});
test('only the exact registered successful object can retrieve history', async () => {
  const result = await run();
  const history = historyOf(result, mockEnrollment, mockCoordinator);
  for (const fake of [
    {},
    copy(result),
    { ...result },
    Object.create(result),
    result.payload,
    history,
    null,
    undefined,
    'proved',
  ])
    expectHistoryRefused(fake);
  expectHistoryRefused(result, { ...mockEnrollment }, mockCoordinator);
  expectHistoryRefused(result, mockEnrollment, { ...mockCoordinator });
  expectHistoryRefused(result, undefined, {});
  expect(historyOf(result, mockEnrollment, mockCoordinator)).toBe(history);
});
test.each([
  'identity-signal',
  'enrollment-signal',
  'coordinator-signal',
  'identity-current',
  'descriptor',
  'public-generation',
])('historical proof lookup refuses and sanitizes %s revocation', async (fault) => {
  const result = await run();
  expect(historyOf(result, mockEnrollment, mockCoordinator)).toBeDefined();
  if (fault === 'identity-signal') identityController.abort();
  if (fault === 'enrollment-signal') enrollmentController.abort();
  if (fault === 'coordinator-signal') coordinatorController.abort();
  if (fault === 'identity-current') mockIdentityCurrent = false;
  if (fault === 'descriptor') mockIdentity.descriptor = { walletId: 'private-descriptor-detail' };
  if (fault === 'public-generation')
    mockPublicIdentity = { ...mockPublicIdentity, generationId: 'private-generation-detail' };
  expectHistoryRefused(result);
  expect(startRailgunProcess).toHaveBeenCalledTimes(1);
  expect(verifyRailgunPoiPayload).toHaveBeenCalledTimes(1);
});
test('membership closure/expiry and finished proof/caller lifetimes do not revoke historical data', async () => {
  const result = await run();
  const history = historyOf(result, mockEnrollment, mockCoordinator);
  expect(mockWindow.signal.aborted).toBe(true);
  expect(mockTask.options.broker.signal.aborted).toBe(true);
  expect(verifyRailgunPoiPayload.mock.calls[0][0].signal.aborted).toBe(true);
  mockMembershipCurrent = false; // The genuine membership accessor now refuses.
  expect(() =>
    require('./railgun-own-poi-membership').assertRailgunOwnPoiMembership(
      options.membershipReceipt,
      mockEnrollment,
      mockCoordinator
    )
  ).toThrow();
  caller.abort();
  jest.advanceTimersByTime(175001);
  expect(historyOf(result, mockEnrollment, mockCoordinator)).toBe(history);
  expect(mockPhase).toBeNull();
});
test.each(['throw', 'digest', 'exit', 'proof', 'independent'])(
  'fresh verifier %s failure never returns registered history',
  async (fault) => {
    const entered = deferred(),
      gate = deferred();
    let completed = false;
    mockVerifier.mockImplementationOnce(async ({ payload: p }) => {
      entered.resolve();
      await gate.promise;
      if (fault === 'throw') throw Error('private verification detail');
      return {
        utilityExitObserved: fault !== 'exit',
        proofVerified: fault !== 'proof',
        independentlyVerified: fault !== 'independent',
        payloadSha256: fault === 'digest' ? 'f'.repeat(64) : sha(JSON.stringify(p)),
      };
    });
    const pending = run().then((value) => {
      completed = true;
      return value;
    });
    await entered.promise;
    expect(completed).toBe(false);
    expectHistoryRefused({ status: 'proved', payload: payload(), separatelyVerified: true });
    gate.resolve();
    const refused = await pending;
    expect(refused).toEqual({ status: 'refused', stage: 'verify' });
    expectHistoryRefused(refused);
    expect(mockPhase).toBeNull();
  }
);
test('pre-verification refusal cannot be used as registered proof history', async () => {
  mockStartError = true;
  const refused = await run();
  expect(refused.status).toBe('refused');
  expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
  expectHistoryRefused(refused);
});
test.each([0, 1])(
  'history UTF-8 bound at 128 KiB plus %s bytes is enforced before registration',
  async (excess) => {
    const first = await run();
    const baseline = copy(historyOf(first, mockEnrollment, mockCoordinator));
    // Padding only the mocked capture isolates the registry's bound from utility
    // input/proof bounds. Real upstream capture validation is tested separately.
    baseline.capture.historyPadding = '';
    const paddingBytes = 131072 + excess - Buffer.byteLength(JSON.stringify(baseline));
    expect(paddingBytes).toBeGreaterThan(0);
    const padding = 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2);
    mockObserved.capture.historyPadding = padding;
    mockCapture.historyPadding = padding;
    baseline.capture.historyPadding = padding;
    expect(Buffer.byteLength(JSON.stringify(baseline))).toBe(131072 + excess);
    let internalCandidate;
    const freeze = Object.freeze;
    jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      if (value?.status === 'proved' && value.separatelyVerified === true)
        internalCandidate = value;
      return freeze(value);
    });
    const result = await run({ ...options, membershipReceipt: receipt() });
    expect(verifyRailgunPoiPayload).toHaveBeenCalledTimes(2);
    expect(internalCandidate).toBeDefined();
    if (excess === 0) {
      expect(result).toBe(internalCandidate);
      const history = historyOf(result, mockEnrollment, mockCoordinator);
      expect(Buffer.byteLength(JSON.stringify(history))).toBe(131072);
      expectDeepFrozen(history);
    } else {
      expect(result).toEqual({ status: 'refused', stage: 'verify' });
      expectHistoryRefused(result);
      // Inspect the internally constructed success-shaped candidate: the rejected
      // oversize attempt must not leave even that object in the private registry.
      expectHistoryRefused(internalCandidate);
    }
    expect(mockPhase).toBeNull();
    expect(
      historyOf(first, mockEnrollment, mockCoordinator).capture.historyPadding
    ).toBeUndefined();
  }
);

const expectBrokerRefusal = (error) => {
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe('RAILGUN_OWN_POI_PROOF_REFUSED');
  expect(error.message).toBe('Railgun own POI proof unavailable');
  expect(error.cause).toBeUndefined();
  expect(Object.keys(error)).toEqual(['code']);
};
test.each(['same-turn', 'microtask'])(
  'caught malformed broker request permanently refuses a valid %s rescue',
  async (timing) => {
    const errors = [];
    let immediatelyAborted;
    mockScenario = async (job) => {
      const bad = job.broker.dispatch('{sensitive malformed wire').catch((e) => errors.push(e));
      immediatelyAborted = job.broker.signal.aborted;
      if (timing === 'microtask') await Promise.resolve();
      await job.broker.dispatch(JSON.stringify(keyWire(job))).catch((e) => errors.push(e));
      await bad;
    };
    const result = await run();
    expect(immediatelyAborted).toBe(true);
    expect(errors).toHaveLength(2);
    errors.forEach(expectBrokerRefusal);
    expect(result.status).toBe('refused');
    expect(mockCredential).not.toHaveBeenCalled();
    expect(mockVerifier).not.toHaveBeenCalled();
    expect(() => historyOf(result, mockEnrollment, mockCoordinator)).toThrow();
  }
);

test.each(['derive', 'first-reattest', 'second-reattest'])(
  'sticky broker refusal drains held %s even after child exit',
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
    const pending = run().then((result) => {
      settled = true;
      return result;
    });
    await entered.promise;
    const task = mockTask;
    const failure = await task.options.broker.dispatch('{invalid').catch((e) => e);
    expectBrokerRefusal(failure);
    expect(task.options.broker.signal.aborted).toBe(true);
    await task.closed;
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockPhase).toBe('window');
    expect((await run({ ...options, membershipReceipt: receipt() })).stage).toBe('context');
    gate.resolve();
    expect((await pending).status).toBe('refused');
    expect(mockCopies).toHaveLength(0);
    for (const key of mockBorrowed) expect(key).toEqual(Buffer.alloc(32));
    expect(mockVerifier).not.toHaveBeenCalled();
    expect(mockPhase).toBeNull();
  }
);

test.each(['malformed', 'duplicate-result', 'extra-key'])(
  'a valid result followed by caught %s cannot publish proof history',
  async (fault) => {
    let error, immediate;
    mockScenario = async (job) => {
      await sendKey(job);
      await sendResult(job);
      const wire =
        fault === 'malformed'
          ? '{invalid'
          : JSON.stringify(fault === 'duplicate-result' ? resultWire(job) : keyWire(job));
      const rejected = job.broker.dispatch(wire).catch((e) => {
        error = e;
      });
      immediate = job.broker.signal.aborted;
      await rejected;
    };
    expect((await run()).status).toBe('refused');
    expect(immediate).toBe(true);
    expectBrokerRefusal(error);
    expect(mockCopies[0]).toEqual(Buffer.alloc(32));
    expect(mockVerifier).not.toHaveBeenCalled();
  }
);

test.each(['success', 'refusal', 'abort', 'timer', 'startup'])(
  'throwing task.close during %s is contained and still waits for exit',
  async (when) => {
    mockCloseError = mockDeferExit = true;
    const entered = deferred();
    let startupAborted, startupError;
    if (when === 'startup') {
      mockStartup = (job) => {
        job.broker.dispatch('{invalid').catch((e) => {
          startupError = e;
        });
        startupAborted = job.broker.signal.aborted;
      };
    }
    mockScenario = async (job) => {
      if (when === 'startup') return;
      if (when === 'refusal') {
        await job.broker.dispatch('{invalid').catch(() => {});
        return;
      }
      await sendKey(job);
      if (when === 'success') await sendResult(job);
      entered.resolve();
      if (when === 'abort' || when === 'timer') await deferred().promise;
    };
    let settled = false;
    const pending = run().then((result) => {
      settled = true;
      return result;
    });
    if (when === 'abort' || when === 'timer') {
      await entered.promise;
      if (when === 'abort') expect(() => caller.abort()).not.toThrow();
      else expect(() => jest.advanceTimersByTime(110000)).not.toThrow();
    }
    await waitFor(() => mockTask?.close.mock.calls.length === 1);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockPhase).toBe('window');
    if (when === 'startup') {
      expect(startupAborted).toBe(true);
      expectBrokerRefusal(startupError);
    }
    mockTask.exit();
    expect((await pending).status).toBe('refused');
    expect(mockTask.close).toHaveBeenCalledTimes(1);
    expect(mockVerifier).not.toHaveBeenCalled();
    for (const key of mockCopies) expect(key).toEqual(Buffer.alloc(32));
  }
);

test('rejected child closure still drains a borrowed credential and wipes its buffer', async () => {
  const gate = deferred(),
    entered = deferred();
  mockRejectExit = true;
  mockReattest.mockResolvedValueOnce(copy(mockCapture));
  mockReattest.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    return copy(mockCapture);
  });
  let settled = false;
  const pending = run().then((result) => {
    settled = true;
    return result;
  });
  await entered.promise;
  caller.abort();
  await mockTask.closed.catch(() => {});
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(mockPhase).toBe('window');
  expect(mockBorrowed[0]).toEqual(Buffer.alloc(32, 7));
  gate.resolve();
  expect((await pending).status).toBe('refused');
  expect(mockBorrowed[0]).toEqual(Buffer.alloc(32));
  expect(mockCopies).toHaveLength(0);
  expect(mockVerifier).not.toHaveBeenCalled();
});

test.each(['caller', 'deadline-without-timer', 'late-broker'])(
  'valid result cannot publish after %s during cleanup',
  async (fault) => {
    mockDeferExit = true;
    let settled = false;
    const pending = run().then((result) => {
      settled = true;
      return result;
    });
    await waitFor(() => mockTask?.close.mock.calls.length === 1);
    expect(settled).toBe(false);
    if (fault === 'caller') caller.abort();
    else if (fault === 'deadline-without-timer')
      jest.spyOn(performance, 'now').mockReturnValue(110000);
    else expectBrokerRefusal(await mockTask.options.broker.dispatch('{invalid').catch((e) => e));
    mockTask.exit();
    expect((await pending).status).toBe('refused');
    expect(mockCopies[0]).toEqual(Buffer.alloc(32));
    expect(mockVerifier).not.toHaveBeenCalled();
  }
);

test.each(['deadline', 'identity'])(
  'final publication rechecks %s after the final cleanup barrier',
  async (fault) => {
    let injected = false;
    mockClosedRead = (reads) => {
      if (reads !== 2) return;
      injected = true;
      if (fault === 'deadline') jest.spyOn(performance, 'now').mockReturnValue(110000);
      else mockIdentityCurrent = false;
    };
    const result = await run();
    expect(injected).toBe(true);
    expect(result.status).toBe('refused');
    // Distinguish the inner post-cleanup check from a later outer recovery check.
    expect(mockRecoveryPost).not.toHaveBeenCalled();
    expect(mockVerifier).not.toHaveBeenCalled();
    expect(mockCopies[0]).toEqual(Buffer.alloc(32));
  }
);

// Structural fixture only: real capsule/receipt/row/schema checks, synthetic
// Merkle fields. It does not establish cryptographic path/proof correctness.
function makeTransactProofFixture(unshield = false, mixedCreator = false) {
  const h = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const hash = (v) =>
    require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const evidence = require('../../../scripts/fixtures/railgun-own-txid-data').sample(unshield);
  const descriptor = {
    walletId: evidence.capsule.walletId,
    instanceId: '0zk1' + 'q'.repeat(123),
    masterPublicKey: h(3).slice(2),
    spendingPublicKey: [h(4).slice(2), h(5).slice(2)],
    viewingPublicKey: h(6).slice(2),
    accountIndex: 0,
  };
  const creator = {
    type: 'Transact',
    tree: evidence.capsule.selection.tree,
    position: evidence.capsule.selection.position,
    hash: evidence.capsule.noteHash,
    ciphertext: {
      ciphertext: [h(7), h(8), h(9), h(10)],
      blindedSenderViewingKey: h(11),
      blindedReceiverViewingKey: h(12),
      annotationData: '0x',
      memo: '0x',
    },
  };
  const state = { count: 2, root: h(15).slice(2), transcript: h(16).slice(2), breaks: [] };
  const witnessFor = (row, index) => ({
    row: JSON.parse(JSON.stringify(row)),
    leaf: h(17 + index).slice(2),
    railgunTxid: h(19 + index).slice(2),
    rowSha256: hash(row),
    index,
    elements: Array(16).fill(h(0).slice(2)),
    root: state.root,
    checkpointIndex: 1,
    transcript: state.transcript,
    continuity: require('./railgun-txid-omissions').classifyRailgunTxidContinuity(1, []),
    globalTxidCompleteness: false,
  });
  const blockNumber = evidence.row.blockNumber - 1;
  const creatorRow = {
    version: 'V2',
    graphID: h(blockNumber) + h(2).slice(2) + h(0).slice(2),
    commitments: mixedCreator ? [creator.hash, h(702)] : [creator.hash],
    nullifiers: [h(700)],
    boundParamsHash: h(701),
    blockNumber,
    txid: h(706).slice(2),
    timestamp: blockNumber,
    utxoTreeIn: creator.tree,
    utxoTreeOut: creator.tree,
    utxoBatchStartPositionOut: creator.position,
    verificationHash: evidence.row.verificationHash,
    ...(mixedCreator
      ? {
          unshield: {
            tokenData: {
              tokenType: 0,
              tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
              tokenSubID: h(0),
            },
            toAddress: '0x' + '12'.repeat(20),
            value: '400',
          },
        }
      : {}),
  };
  const note = {
    type: 'Transact',
    tree: creator.tree,
    position: creator.position,
    hash: creator.hash,
    txid: h(706),
    blockNumber,
  };
  const input = {
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    descriptor,
    preparation: { creator, ownEvidence: evidence, state, witness: witnessFor(evidence.row, 1) },
    listProofs: [
      {
        leaf: h(21).slice(2),
        root: h(22).slice(2),
        indices: h(0).slice(2),
        elements: Array(16).fill(h(0).slice(2)),
      },
    ],
  };
  const selectorInput =
    require('./railgun-poi-transact-selector-data').prepareRailgunPoiTransactSelectorInput({
      archive: input.archive,
      descriptor,
      capsule: evidence.capsule,
      creator,
    });
  return {
    input,
    selector: {
      blindedCommitment: h(21),
      bindingDigest: selectorInput.bindingDigest,
      inputSha256: hash(selectorInput),
    },
    creatorProvenance: {
      note,
      noteWitness: {
        note,
        outputIndex: 0,
        witness: witnessFor(creatorRow, 0),
        ownershipVerified: false,
        eventCoverageVerified: false,
        rootAccepted: false,
        spendingEnabled: false,
      },
      verification: {
        ...(mixedCreator ? { unshieldCommitmentVerified: true } : {}),
        utilityExitObserved: true,
        pathVerified: true,
        suppliedCreatorEventsMatched: true,
        coverage: {
          matchedRows: 1,
          knownOmissions: 0,
          boundParamsChecked: false,
          unshieldCommitmentHashesChecked: false,
          globalTxidCompleteness: false,
        },
      },
    },
  };
}

test('Transact-tagged mocked receipt cannot enter the otherwise valid Shield branch', async () => {
  mockObserved.inputType = 'Transact';
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  expect(startRailgunProcess).not.toHaveBeenCalled();
  delete mockObserved.inputType;
  expect((await run()).status).toBe('proved');
});

describe('Transact host cross-binding with real normalization and mocked membership authority', () => {
  const actualData = jest.requireActual('./railgun-own-poi-proof-data');
  const mockedData = require('./railgun-own-poi-proof-data');
  function install(unshield = false, mixedCreator = false) {
    const fixture = makeTransactProofFixture(unshield, mixedCreator);
    mockIdentity.descriptor = fixture.input.descriptor;
    mockEnrollment.descriptor = fixture.input.descriptor;
    mockCapture.capsule = copy(fixture.input.preparation.ownEvidence.capsule);
    mockCapture.selector = copy(mockCapture.capsule.selection);
    mockCapture.capsuleDigest = require('./railgun-private-capsule').digestRailgunPrivateCapsule(
      mockCapture.capsule
    );
    mockObserved = {
      inputType: 'Transact',
      capture: copy(mockCapture),
      poiPreparation: fixture.input.preparation,
      selector: fixture.selector,
      creatorProvenance: { ...fixture.creatorProvenance, publicIdentity: copy(mockPublicIdentity) },
      membership: {
        membershipVerified: true,
        proofs: fixture.input.listProofs,
        events: [
          {
            signedPOIEvent: {
              type: 'Transact',
              index: 0,
              blindedCommitment: fixture.selector.blindedCommitment,
            },
          },
        ],
      },
    };
    mockedData.normalizeRailgunOwnPoiProofInput.mockImplementation(
      actualData.normalizeRailgunOwnPoiProofInput
    );
    mockedData.expectedRailgunOwnPoiFields.mockImplementation(
      actualData.expectedRailgunOwnPoiFields
    );
    mockExpected = actualData.expectedRailgunOwnPoiFields(
      actualData.normalizeRailgunOwnPoiProofInput(fixture.input)
    );
    return fixture;
  }
  afterEach(() => {
    mockedData.normalizeRailgunOwnPoiProofInput.mockImplementation((v) => copy(v));
    mockedData.expectedRailgunOwnPoiFields.mockImplementation(() => copy(mockExpected));
  });
  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'structural Transact second spend unshield=%s mixed creator=%s reaches both mocked proof stages',
    async (unshield, mixedCreator) => {
      const fixture = install(unshield, mixedCreator);
      const result = await run();
      expect(result.status).toBe('proved');
      expect(mockCredential).toHaveBeenCalledTimes(1);
      expect(mockVerifier).toHaveBeenCalledTimes(1);
      const input = JSON.parse(startRailgunProcess.mock.calls[0][0].input);
      expect(input).toEqual(fixture.input);
      const history = historyOf(result, mockEnrollment, mockCoordinator);
      expect(history.preparation.creator.type).toBe('Transact');
      expect(history).not.toHaveProperty('creatorProvenance');
      expect(history.selector.bindingDigest).toBe(fixture.selector.bindingDigest);
      expect(history.selector.inputSha256).toBe(fixture.selector.inputSha256);
      expect(result.rootAccepted).toBe(false);
      expect(result.membershipAuthenticated).toBe(false);
    }
  );
  test.each(
    [
      'missing-type',
      'wrong-type',
      'selector-binding',
      'selector-input',
      'archive',
      'capture-capsule',
      'provenance-type',
      'provenance-tree',
      'provenance-position',
      'provenance-hash',
      'public-identity',
      'creator-root',
      'creator-checkpoint',
      'creator-transcript',
      'creator-after-own',
      'creator-output',
      'creator-extra-input',
      'creator-extra-output',
      'creator-exit',
      'creator-path',
      'creator-events',
      'matched-rows',
      'known-omission',
      'events-missing',
      'events-many',
      'event-type',
      'event-leaf',
      'event-index',
    ].flatMap((fault) => [
      [fault, false],
      [fault, true],
    ])
  )(
    'pre-key %s mixed=%s mismatch refuses without consuming mocked membership receipt',
    async (fault, mixedCreator) => {
      install(false, mixedCreator);
      const original = copy(mockObserved),
        originalArchive = options.archive;
      const provenance = mockObserved.creatorProvenance;
      const witness = provenance.noteWitness.witness;
      if (fault === 'missing-type') delete mockObserved.inputType;
      if (fault === 'wrong-type') mockObserved.inputType = 'Shield';
      if (fault === 'selector-binding') mockObserved.selector.bindingDigest = '0'.repeat(64);
      if (fault === 'selector-input') mockObserved.selector.inputSha256 = '0'.repeat(64);
      if (fault === 'archive') options.archive = '/other-engine.asar';
      if (fault === 'capture-capsule') mockObserved.capture.capsule.operationId = 'changed';
      if (fault === 'provenance-type') provenance.note.type = 'Shield';
      if (fault === 'provenance-tree') provenance.note.tree++;
      if (fault === 'provenance-position') provenance.note.position++;
      if (fault === 'provenance-hash') provenance.note.hash = hex(99);
      if (fault === 'public-identity') provenance.publicIdentity.generationId = 'another';
      if (fault === 'creator-root') witness.root = hex(99).slice(2);
      if (fault === 'creator-checkpoint') witness.checkpointIndex = 0;
      if (fault === 'creator-transcript') witness.transcript = hex(99).slice(2);
      if (fault === 'creator-after-own') witness.index = 1;
      if (fault === 'creator-output') provenance.noteWitness.outputIndex = 1;
      if (fault === 'creator-extra-input') witness.row.nullifiers.push(hex(99));
      if (fault === 'creator-extra-output') witness.row.commitments.push(hex(99));
      if (fault === 'creator-extra-input' || fault === 'creator-extra-output')
        witness.rowSha256 = sha(JSON.stringify(witness.row));
      if (fault === 'creator-exit') provenance.verification.utilityExitObserved = false;
      if (fault === 'creator-path') provenance.verification.pathVerified = false;
      if (fault === 'creator-events') provenance.verification.suppliedCreatorEventsMatched = false;
      if (fault === 'matched-rows') provenance.verification.coverage.matchedRows = 2;
      if (fault === 'known-omission') provenance.verification.coverage.knownOmissions = 1;
      if (fault === 'events-missing') delete mockObserved.membership.events;
      if (fault === 'events-many')
        mockObserved.membership.events.push(copy(mockObserved.membership.events[0]));
      if (fault === 'event-type') mockObserved.membership.events[0].signedPOIEvent.type = 'Shield';
      if (fault === 'event-leaf')
        mockObserved.membership.events[0].signedPOIEvent.blindedCommitment = hex(99);
      if (fault === 'event-index') mockObserved.membership.events[0].signedPOIEvent.index = 1;
      expect(await run()).toEqual({ status: 'refused', stage: 'context' });
      expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
      expect(startRailgunProcess).not.toHaveBeenCalled();
      expect(mockCredential).not.toHaveBeenCalled();
      expect(mockVerifier).not.toHaveBeenCalled();
      mockObserved = original;
      options.archive = originalArchive;
      expect((await run()).status).toBe('proved');
    }
  );
  test.each(['missing', 'false', 'copied-legacy', 'inherited', 'coverage-hash', 'copied-receipt'])(
    'mixed creator %s verification cannot authorize a proof key',
    async (fault) => {
      install(false, true);
      const provenance = mockObserved.creatorProvenance;
      if (fault === 'missing') delete provenance.verification.unshieldCommitmentVerified;
      if (fault === 'false') provenance.verification.unshieldCommitmentVerified = false;
      if (fault === 'copied-legacy')
        provenance.verification = copy(makeTransactProofFixture().creatorProvenance.verification);
      if (fault === 'inherited') {
        delete provenance.verification.unshieldCommitmentVerified;
        Object.setPrototypeOf(provenance.verification, { unshieldCommitmentVerified: true });
      }
      if (fault === 'coverage-hash')
        provenance.verification.coverage.unshieldCommitmentHashesChecked = true;
      const supplied =
        fault === 'copied-receipt'
          ? {
              ...options,
              membershipReceipt: { ...options.membershipReceipt, unshieldCommitmentVerified: true },
            }
          : options;
      expect(await run(supplied)).toEqual({ status: 'refused', stage: 'context' });
      expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
      expect(startRailgunProcess).not.toHaveBeenCalled();
      expect(mockCredential).not.toHaveBeenCalled();
    }
  );
  test('historical typed membership may close after entry without extending root or list authority', async () => {
    install();
    mockRecoveryStart.mockImplementationOnce(async () => {
      mockMembershipCurrent = false;
    });
    const result = await run();
    expect(result.status).toBe('proved');
    expect(result.rootAccepted).toBe(false);
    expect(result.membershipAuthenticated).toBe(false);
    expect(historyOf(result, mockEnrollment, mockCoordinator).preparation.creator.type).toBe(
      'Transact'
    );
  });
});
