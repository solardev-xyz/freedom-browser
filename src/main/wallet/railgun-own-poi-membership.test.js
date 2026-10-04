let mockEnrollment,
  mockCoordinator,
  mockPublicIdentity,
  mockPreflight,
  mockCapture,
  mockSource,
  mockObserved,
  mockVerified,
  mockSourceReceipt,
  mockMembershipReceipt,
  mockLease,
  mockExpired,
  mockCalls;
const mockPreflightRun = jest.fn(),
  mockCaptureRun = jest.fn(),
  mockDerive = jest.fn(),
  mockVerify = jest.fn();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (c, e) => {
    if (c !== mockCoordinator || e !== mockEnrollment) throw Error('owner');
    return mockPublicIdentity;
  },
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'policy' }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-own-witness', () => ({
  preflightRailgunOwnPoi: (...a) => mockPreflightRun(...a),
}));
jest.mock('./railgun-own-operation', () => ({
  captureRailgunOwnOperation: (...a) => mockCaptureRun(...a),
}));
jest.mock('./railgun-poi-shield-selector', () => ({
  deriveRailgunPoiShieldSelector: (...a) => mockDerive(...a),
}));
jest.mock('./railgun-account-phase', () => ({
  claimRailgunAccountPhase: jest.fn(() => {
    if (mockLease) throw Error('phase busy');
    const lease = {
      assertCurrent: () => {
        if (mockLease !== lease) throw Error('phase stale');
      },
      release: jest.fn(() => {
        if (mockLease === lease) mockLease = null;
      }),
    };
    mockLease = lease;
    mockCalls.push('claim');
    return lease;
  }),
}));
jest.mock('./railgun-poi-source', () => ({
  MAX_AGE_MS: 60000,
  createRailgunPoiSource: jest.fn(() => {
    mockCalls.push('source');
    return mockSource;
  }),
}));
jest.mock('./railgun-poi-membership', () => ({
  verifyRailgunPoiMembership: (...a) => mockVerify(...a),
  assertRailgunPoiMembership: jest.fn((receipt, _handle, margin = 0) => {
    if (
      receipt !== mockMembershipReceipt ||
      mockExpired ||
      mockSource.signal.aborted ||
      margin >= 59000
    )
      throw Error('membership expired');
    return mockVerified;
  }),
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunPoiSource } = require('./railgun-poi-source');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { REQUIRED_LIST, normalizePoiProofs } = require('./railgun-poi-records');
const {
  openRailgunOwnPoiMembership: open,
  assertRailgunOwnPoiMembership: attest,
} = require('./railgun-own-poi-membership');
const copy = (v) => JSON.parse(JSON.stringify(v)),
  hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let scope, caller, coordinatorController, sourceController, options, opened;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  mockExpired = false;
  mockLease = null;
  mockCalls = [];
  opened = [];
  scope = createPrivacyScope({ profileId: 'own-poi-test', signal: new AbortController().signal });
  caller = new AbortController();
  coordinatorController = new AbortController();
  sourceController = new AbortController();
  mockCoordinator = { signal: coordinatorController.signal };
  mockEnrollment = {
    directory: '/synthetic-own-poi',
    binding: 'binding',
    signal: scope.signal,
    getContext: (role = 'engine', operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        ...(operation ? { operation } : {}),
      }),
  };
  mockPublicIdentity = { sourceId: 'source', generation: 'one' };
  mockCapture = {
    bindingDigest: 'a'.repeat(64),
    selector: { tree: 0, position: 1, noteHash: hex(2), nullifier: hex(3) },
    facts: {},
    submitter: 'owner',
    capsule: { noteHash: hex(2) },
    capsuleDigest: 'b'.repeat(64),
    provedTransaction: {},
    intent: {},
    projection: {},
    record: { revision: 1 },
  };
  mockPreflight = {
    status: 'captured',
    publicIdentity: copy(mockPublicIdentity),
    observations: { archiveAnchorChecked: true },
    creatorClassification: { type: 'Shield', blockNumber: 6000000, legacy: false },
    capture: copy(mockCapture),
    poiPreparation: {
      creator: { type: 'Shield', marker: 'genuine' },
      ownEvidence: { capsule: copy(mockCapture.capsule) },
      state: {},
      witness: {},
    },
  };
  mockPreflightRun.mockImplementation(async () => {
    mockCalls.push('preflight');
    return copy(mockPreflight);
  });
  mockCaptureRun.mockImplementation(async () => {
    expect(mockLease).toBeNull();
    mockCalls.push('capture');
    return { status: 'captured', capture: copy(mockCapture) };
  });
  mockDerive.mockImplementation(async () => {
    expect(mockLease).not.toBeNull();
    mockCalls.push('derive');
    return {
      utilityExitObserved: true,
      selectorDerived: true,
      blindedCommitment: hex(4),
      bindingDigest: 'c'.repeat(64),
      inputSha256: 'd'.repeat(64),
    };
  });
  mockSourceReceipt = {};
  mockMembershipReceipt = {};
  mockObserved = {
    listKey: REQUIRED_LIST,
    statuses: [{ blindedCommitment: hex(4), type: 'Shield', status: 'Valid' }],
    proofs: [
      {
        leaf: hex(4).slice(2),
        root: hex(5).slice(2),
        indices: hex(2).slice(2),
        elements: Array(16).fill(hex(0).slice(2)),
      },
    ],
    events: [
      {
        signedPOIEvent: {
          index: 2,
          type: 'Shield',
          blindedCommitment: hex(4).slice(2),
          signature: '0'.repeat(128),
        },
        validatedMerkleroot: hex(5).slice(2),
      },
    ],
    rootsAccepted: true,
    membershipVerified: false,
  };
  mockSource = {
    signal: sourceController.signal,
    close: jest.fn(() => sourceController.abort()),
    acquire: jest.fn(async () => {
      expect(mockLease).toBeNull();
      mockCalls.push('acquire');
      return { receipt: mockSourceReceipt, observation: mockObserved };
    }),
    assertResult: jest.fn((receipt, margin = 0) => {
      if (
        receipt !== mockSourceReceipt ||
        mockExpired ||
        sourceController.signal.aborted ||
        margin >= 59000
      )
        throw Error('source expired');
      return mockObserved;
    }),
  };
  mockVerify.mockImplementation(async () => {
    expect(mockLease).not.toBeNull();
    mockCalls.push('verify');
    mockVerified = { ...mockObserved, membershipVerified: true };
    return { receipt: mockMembershipReceipt, observation: mockVerified };
  });
  options = {
    enrollment: mockEnrollment,
    coordinator: mockCoordinator,
    archive: '/test/runtime.asar',
    selector: copy(mockCapture.selector),
    signal: caller.signal,
  };
});
afterEach(() => {
  for (const op of opened) op.close?.();
  caller.abort();
  scope.close();
  coordinatorController.abort();
  sourceController.abort();
  jest.useRealTimers();
});
const run = async (input = options) => {
  const result = await open(input);
  opened.push(result);
  return result;
};
const waitFor = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await Promise.resolve();
  expect(check()).toBe(true);
};
test('derives from internal preflight, recaptures before query and after verification, retains membership only', async () => {
  const result = await run();
  expect(result.status).toBe('verified');
  expect(mockCalls).toEqual([
    'preflight',
    'claim',
    'derive',
    'capture',
    'source',
    'acquire',
    'claim',
    'verify',
    'capture',
  ]);
  const input = mockDerive.mock.calls[0][0];
  expect(input.capsule).toEqual(mockPreflight.poiPreparation.ownEvidence.capsule);
  expect(input.creator).toEqual(mockPreflight.poiPreparation.creator);
  const sourceArgs = createRailgunPoiSource.mock.calls[0][0];
  expect(sourceArgs.notes).toEqual([{ blindedCommitment: hex(4), type: 'Shield' }]);
  expect(getPrivacyContext(sourceArgs.handle).subject).toMatchObject({
    principal: 'railgun:0',
    role: 'poi',
    operation: expect.stringMatching(/^poi:[0-9a-f]{64}$/),
  });
  expect(normalizePoiProofs(result.observation.membership.proofs, sourceArgs.notes)).toEqual(
    mockObserved.proofs
  );
  expect(attest(result.receipt, mockEnrollment, mockCoordinator)).toBe(result.observation);
  for (const flag of [
    'accountAuthenticated',
    'sourceAuthenticated',
    'currentFinalityVerified',
    'disclosureEnabled',
    'spendingEnabled',
  ])
    expect(result.observation[flag]).toBe(false);
  expect(Object.isFrozen(result.observation.poiPreparation)).toBe(true);
  expect(mockLease).toBeNull();
  const leases = claimRailgunAccountPhase.mock.results.map((v) => v.value);
  expect(leases.every((v) => v.release.mock.calls.length === 1)).toBe(true);
  result.close();
  expect(result.signal.aborted).toBe(true);
  expect(() => attest(result.receipt, mockEnrollment, mockCoordinator)).toThrow(
    'Railgun own POI membership unavailable'
  );
});
test.each(['enrollment', 'coordinator', 'extra-preparation', 'extra-proofs', 'timeout', 'aborted'])(
  'rejects invalid %s before preflight or query',
  async (fault) => {
    const x = { ...options };
    if (fault === 'enrollment') x.enrollment = {};
    if (fault === 'coordinator') x.coordinator = {};
    if (fault === 'extra-preparation') x.poiPreparation = mockPreflight.poiPreparation;
    if (fault === 'extra-proofs') x.listProofs = mockObserved.proofs;
    if (fault === 'timeout') x.timeoutMs = 480001;
    if (fault === 'aborted') caller.abort();
    expect(await run(x)).toEqual({ status: 'refused', stage: 'context' });
    expect(mockPreflightRun).not.toHaveBeenCalled();
    expect(createRailgunPoiSource).not.toHaveBeenCalled();
  }
);
test.each(['refused', 'archive-anchor', 'legacy', 'transact', 'capsule', 'public-identity'])(
  'refuses %s preflight before deriving/disclosing',
  async (fault) => {
    if (fault === 'refused') mockPreflight = { status: 'refused', stage: 'receipt' };
    if (fault === 'archive-anchor') mockPreflight.observations.archiveAnchorChecked = false;
    if (fault === 'legacy') {
      mockPreflight.creatorClassification.legacy = true;
      mockPreflight.creatorClassification.blockNumber = 290;
    }
    if (fault === 'transact') mockPreflight.creatorClassification.type = 'Transact';
    if (fault === 'capsule') mockPreflight.poiPreparation.ownEvidence.capsule.noteHash = hex(99);
    if (fault === 'public-identity') mockPreflight.publicIdentity.sourceId = 'other';
    expect((await run()).status).toBe('refused');
    expect(mockDerive).not.toHaveBeenCalled();
    expect(createRailgunPoiSource).not.toHaveBeenCalled();
  }
);
test.each(['bindingDigest', 'capsule', 'record'])(
  'fresh %s drift refuses before query',
  async (field) => {
    mockCapture[field] =
      field === 'bindingDigest'
        ? 'e'.repeat(64)
        : field === 'record'
          ? { archivedAt: 1, finalized: { blockNumber: 2 } }
          : { changed: true };
    expect(await run()).toEqual({ status: 'refused', stage: 'before-query' });
    expect(createRailgunPoiSource).not.toHaveBeenCalled();
    expect(mockLease).toBeNull();
  }
);
test.each([
  'status',
  'root',
  'proof-leaf',
  'proof-count',
  'event-index',
  'event-leaf',
  'event-type',
  'list',
])('refuses inconsistent %s before membership utility', async (fault) => {
  if (fault === 'status') mockObserved.statuses[0].status = 'Missing';
  if (fault === 'root') mockObserved.rootsAccepted = false;
  if (fault === 'proof-leaf') mockObserved.proofs[0].leaf = hex(9).slice(2);
  if (fault === 'proof-count') mockObserved.proofs.push(copy(mockObserved.proofs[0]));
  if (fault === 'event-index') mockObserved.events[0].signedPOIEvent.index++;
  if (fault === 'event-leaf') mockObserved.events[0].signedPOIEvent.blindedCommitment = hex(9);
  if (fault === 'event-type') mockObserved.events[0].signedPOIEvent.type = 'Transact';
  if (fault === 'list') mockObserved.listKey = 'f'.repeat(64);
  expect(await run()).toEqual({ status: 'refused', stage: 'membership-status' });
  expect(mockVerify).not.toHaveBeenCalled();
  expect(mockSource.close).toHaveBeenCalled();
});
test.each(['bindingDigest', 'record', 'capsule'])(
  'final %s drift refuses after verification and closes source',
  async (field) => {
    mockCaptureRun
      .mockImplementationOnce(async () => ({ status: 'captured', capture: copy(mockCapture) }))
      .mockImplementationOnce(async () => ({
        status: 'captured',
        capture: {
          ...copy(mockCapture),
          [field]:
            field === 'record'
              ? { archivedAt: 1, finalized: { blockNumber: 2 } }
              : { changed: true },
        },
      }));
    expect(await run()).toEqual({ status: 'refused', stage: 'after-query' });
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockSource.close).toHaveBeenCalled();
    expect(mockLease).toBeNull();
  }
);
test('receipt owners, freshness margin and source expiry are checked on every assertion', async () => {
  const result = await run();
  expect(result.status).toBe('verified');
  expect(() => attest({}, mockEnrollment, mockCoordinator)).toThrow();
  expect(() => attest(result.receipt, {}, mockCoordinator)).toThrow();
  expect(() => attest(result.receipt, mockEnrollment, {})).toThrow();
  for (const margin of [-1, 0.5, 60000, 59000])
    expect(() => attest(result.receipt, mockEnrollment, mockCoordinator, margin)).toThrow();
  expect(attest(result.receipt, mockEnrollment, mockCoordinator, 10)).toBe(result.observation);
  mockExpired = true;
  expect(() => attest(result.receipt, mockEnrollment, mockCoordinator)).toThrow();
});
test.each(['source', 'caller', 'coordinator', 'parent'])(
  'completed receipt revokes on %s lifetime',
  async (which) => {
    const result = await run();
    expect(result.status).toBe('verified');
    if (which === 'source') sourceController.abort();
    if (which === 'caller') caller.abort();
    if (which === 'coordinator') coordinatorController.abort();
    if (which === 'parent') scope.close();
    expect(result.signal.aborted).toBe(true);
    expect(() => attest(result.receipt, mockEnrollment, mockCoordinator)).toThrow();
  }
);
test.each(['selector', 'membership'])(
  'cancellation retains the %s phase and owner until work drains',
  async (which) => {
    let release;
    const pendingWork = new Promise((resolve) => {
      release = resolve;
    });
    const target = which === 'selector' ? mockDerive : mockVerify;
    const original = target.getMockImplementation();
    target.mockImplementationOnce(async (...a) => {
      const result = await original(...a);
      await pendingWork;
      return result;
    });
    let settled = false;
    const pending = run().then((v) => {
      settled = true;
      return v;
    });
    await waitFor(() => mockLease !== null && target.mock.calls.length > 0);
    const held = mockLease;
    caller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(held.release).not.toHaveBeenCalled();
    const other = { ...options, signal: new AbortController().signal };
    expect(await run(other)).toEqual({ status: 'refused', stage: 'context' });
    release();
    expect((await pending).status).toBe('refused');
    expect(held.release).toHaveBeenCalledTimes(1);
    expect(mockLease).toBeNull();
  }
);
test('caller selector mutations during preflight cannot change recapture selection', async () => {
  const selected = copy(options.selector);
  let release;
  mockPreflightRun.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(copy(mockPreflight));
      })
  );
  const pending = run();
  await waitFor(() => typeof release === 'function');
  options.selector.position = 99;
  release();
  expect((await pending).status).toBe('verified');
  for (const [args] of mockCaptureRun.mock.calls) expect(args.selector).toEqual(selected);
});
test('successful operation owns its slot until close; new operation gets a distinct context', async () => {
  const first = await run();
  expect(first.status).toBe('verified');
  const firstOperation = getPrivacyContext(createRailgunPoiSource.mock.calls[0][0].handle).subject
    .operation;
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
  first.close();
  // Fresh service lifetime, as the production factory provides on each open.
  sourceController = new AbortController();
  mockSource.signal = sourceController.signal;
  const second = await run();
  expect(second.status).toBe('verified');
  expect(
    getPrivacyContext(createRailgunPoiSource.mock.calls[1][0].handle).subject.operation
  ).not.toBe(firstOperation);
});
test('membership receipt expires automatically after acquisition budget', async () => {
  jest.useFakeTimers();
  const result = await run();
  expect(result.status).toBe('verified');
  await jest.advanceTimersByTimeAsync(60001);
  expect(result.signal.aborted).toBe(true);
  expect(() => attest(result.receipt, mockEnrollment, mockCoordinator)).toThrow();
});

test('volatile journal refresh is accepted without granting account freshness', async () => {
  mockCapture.record = {
    revision: 2,
    observation: { confirmations: 8, observedAt: 42 },
    resolution: { reviewedAt: 43 },
  };
  const result = await run();
  expect(result.status).toBe('verified');
  expect(result.observation.accountAuthenticated).toBe(false);
  expect(result.observation.capture.record).toEqual(mockPreflight.capture.record);
});
test('changed finalized archive anchor refuses before query despite stable projection', async () => {
  mockPreflight.capture.record = {
    archivedAt: 1,
    finalized: { blockNumber: 100, blockHash: hex(8) },
  };
  mockCapture.record = { archivedAt: 1, finalized: { blockNumber: 101, blockHash: hex(9) } };
  expect(await run()).toEqual({ status: 'refused', stage: 'before-query' });
  expect(createRailgunPoiSource).not.toHaveBeenCalled();
});
test('membership verifier output must retain the exact source proofs', async () => {
  mockVerify.mockImplementationOnce(async () => {
    mockVerified = { ...copy(mockObserved), membershipVerified: true };
    mockVerified.proofs[0].root = hex(99).slice(2);
    return { receipt: mockMembershipReceipt, observation: mockVerified };
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'membership-verify' });
  expect(mockLease).toBeNull();
  expect(mockSource.close).toHaveBeenCalled();
});
test('generation drift while querying refuses before membership verification', async () => {
  mockSource.acquire.mockImplementationOnce(async () => {
    mockPublicIdentity = { sourceId: 'other', generation: 'two' };
    return { receipt: mockSourceReceipt, observation: mockObserved };
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'acquire' });
  expect(mockVerify).not.toHaveBeenCalled();
  expect(mockSource.close).toHaveBeenCalled();
});
test('semantic refusal frees the owner for another operation on the same enrollment', async () => {
  mockCapture.capsule = { changed: true };
  expect(await run()).toEqual({ status: 'refused', stage: 'before-query' });
  mockCapture = copy(mockPreflight.capture);
  expect((await run()).status).toBe('verified');
});
test.each(['selector', 'membership-verify'])(
  'busy %s phase refuses without leaking owner',
  async (stage) => {
    const original = claimRailgunAccountPhase.getMockImplementation();
    if (stage === 'membership-verify') claimRailgunAccountPhase.mockImplementationOnce(original);
    claimRailgunAccountPhase.mockImplementationOnce(() => {
      throw Error('other phase');
    });
    expect(await run()).toEqual({ status: 'refused', stage });
    expect(mockLease).toBeNull();
    if (stage === 'selector') expect(createRailgunPoiSource).not.toHaveBeenCalled();
    else {
      expect(mockSource.close).toHaveBeenCalled();
      sourceController = new AbortController();
      mockSource.signal = sourceController.signal;
    }
    expect((await run()).status).toBe('verified');
  }
);
test.each(['throw', 'exit', 'derived'])(
  'selector %s failure refuses before disclosure and releases phase',
  async (failure) => {
    const original = mockDerive.getMockImplementation();
    mockDerive.mockImplementationOnce(async (...args) => {
      if (failure === 'throw') throw Error('private sentinel');
      return {
        ...(await original(...args)),
        [failure === 'exit' ? 'utilityExitObserved' : 'selectorDerived']: false,
      };
    });
    expect(await run()).toEqual({ status: 'refused', stage: 'selector' });
    expect(createRailgunPoiSource).not.toHaveBeenCalled();
    expect(mockLease).toBeNull();
    expect((await run()).status).toBe('verified');
  }
);
test('receipt margin must fit the composition deadline as well as source freshness', async () => {
  jest.useFakeTimers();
  const result = await run({ ...options, timeoutMs: 1000 });
  expect(result.status).toBe('verified');
  expect(attest(result.receipt, mockEnrollment, mockCoordinator, 999)).toBe(result.observation);
  for (const margin of [1000, 2000])
    expect(() => attest(result.receipt, mockEnrollment, mockCoordinator, margin)).toThrow(
      'Railgun own POI membership unavailable'
    );
  await jest.advanceTimersByTimeAsync(500);
  expect(attest(result.receipt, mockEnrollment, mockCoordinator, 499)).toBe(result.observation);
  expect(() => attest(result.receipt, mockEnrollment, mockCoordinator, 500)).toThrow(
    'Railgun own POI membership unavailable'
  );
});
test('elapsed source budget prevents launching membership verification', async () => {
  jest.useFakeTimers();
  mockSource.acquire.mockImplementationOnce(async () => {
    await jest.advanceTimersByTimeAsync(60001);
    return { receipt: mockSourceReceipt, observation: mockObserved };
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'membership-verify' });
  expect(mockVerify).not.toHaveBeenCalled();
  expect(claimRailgunAccountPhase).toHaveBeenCalledTimes(1);
  expect(mockLease).toBeNull();
  expect(mockSource.close).toHaveBeenCalled();
});
test('overall deadline during recapture prevents creating a query source', async () => {
  jest.useFakeTimers();
  mockCaptureRun.mockImplementationOnce(async () => {
    await jest.advanceTimersByTimeAsync(21);
    return { status: 'captured', capture: copy(mockCapture) };
  });
  expect(await run({ ...options, timeoutMs: 20 })).toEqual({
    status: 'refused',
    stage: 'before-query',
  });
  expect(createRailgunPoiSource).not.toHaveBeenCalled();
  expect(mockLease).toBeNull();
});
test('refused recovery capture prevents a query', async () => {
  mockCaptureRun.mockResolvedValueOnce({ status: 'refused', stage: 'journal' });
  expect(await run()).toEqual({ status: 'refused', stage: 'before-query' });
  expect(createRailgunPoiSource).not.toHaveBeenCalled();
});
