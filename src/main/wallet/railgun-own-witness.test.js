const mockPoiCapture = jest.fn(),
  mockPoiCompletedCapture = jest.fn(),
  mockPoiTransactCapture = jest.fn(),
  mockPoiRetainedCapture = jest.fn(),
  mockVerifyCreator = jest.fn();
let mockPoiObservation;
const mockObserve = jest.fn(),
  mockSourceCapture = jest.fn(),
  mockVerify = jest.fn(),
  mockRootCreate = jest.fn();
let mockSource, mockSourceObservation, mockRoots, mockSourceCurrent, mockSourceAt;
jest.mock('./railgun-note-provenance', () => ({
  verifyRailgunNoteProvenance: (...args) => mockVerifyCreator(...args),
}));
jest.mock('./railgun-own-receipt', () => ({
  observeRailgunOwnReceipt: (...args) => mockObserve(...args),
}));
jest.mock('./railgun-own-source-capture', () => ({
  captureRailgunOwnSource: (...args) => mockSourceCapture(...args),
  assertRailgunOwnSource: (receipt) => {
    if (
      receipt !== mockSource.receipt ||
      !mockSourceCurrent ||
      (mockSourceAt !== undefined && performance.now() - mockSourceAt >= 60000)
    )
      throw Error('source expired');
    return mockSourceObservation;
  },
}));
jest.mock('./railgun-poi-source-capture', () => ({
  captureRailgunPoiSource: (...args) => mockPoiCapture(...args),
  captureRailgunPoiSourceCompleted: (...args) => mockPoiCompletedCapture(...args),
  captureRailgunPoiSourceForTransactMembership: (...args) => mockPoiTransactCapture(...args),
  captureRailgunPoiSourceForRetainedInput: (...args) => mockPoiRetainedCapture(...args),
  assertRailgunPoiSource: (receipt) => {
    if (
      receipt !== mockSource.receipt ||
      !mockSourceCurrent ||
      (mockSourceAt !== undefined && performance.now() - mockSourceAt >= 60000)
    )
      throw Error('poi source expired');
    return mockPoiObservation;
  },
}));
jest.mock('./railgun-own-txid-verifier', () => ({
  verifyRailgunOwnTxid: (...args) => mockVerify(...args),
}));
jest.mock('./railgun-txid-root', () => ({
  createRailgunTxidRootSource: (...args) => mockRootCreate(...args),
}));
let mockEnrollment, mockCoordinator, mockPublicIdentity, mockPolicy, mockDestination;
const mockCapture = jest.fn(),
  mockSelectorCapture = jest.fn(),
  mockOpen = jest.fn();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'public' }));
jest.mock('./railgun-txid-policy', () => ({ getRailgunTxidPolicy: () => mockPolicy }));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicDestination: jest.fn((c, e) => {
    if (c !== mockCoordinator || e !== mockEnrollment) throw Error('owner');
    return mockDestination;
  }),
  assertRailgunAccountPublicDestination: (c, e, destination) => {
    if (c !== mockCoordinator || e !== mockEnrollment || destination !== mockDestination)
      throw Error('destination');
    return destination;
  },
  getRailgunAccountPublicIdentity: (c, e) => {
    if (c !== mockCoordinator || e !== mockEnrollment) throw Error('owners');
    return mockPublicIdentity;
  },
}));
jest.mock('./railgun-own-operation', () => ({
  captureRailgunOwnOperation: (...args) => mockCapture(...args),
  captureRailgunOwnOperationSelector: (...args) => mockSelectorCapture(...args),
}));
jest.mock('./railgun-account-txid', () => ({
  openRailgunAccountTxid: (...args) => mockOpen(...args),
}));
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { projectRailgunOwnRecord } = require('./railgun-own-txid');
const {
  captureRailgunOwnWitness: capture,
  preflightRailgunOwnTransaction: preflight,
  preflightRailgunOwnPoi: poiPreflight,
  preflightRailgunOwnPoiCompleted: poiCompleted,
  preflightRailgunOwnPoiForSubmission: poiSubmission,
  preflightRailgunOwnTransactPoiMembership: poiTransact,
  captureRailgunOwnTransactPoiMembershipInput: transactInput,
  preflightRailgunRetainedPoiCompleted: poiRetained,
  preflightRailgunRetainedPoiForSubmission: poiRetainedSubmission,
} = require('./railgun-own-witness');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const copy = (v) => JSON.parse(JSON.stringify(v));
const hash = (s) => '0' + createHash('sha256').update(s).digest('hex').slice(1);
const pair = (a, b) => hash(a + b),
  zeros = [hash('zero')];
for (let n = 0; n < 16; n++) zeros.push(pair(zeros[n], zeros[n]));
let scope, caller, options, first, latest, txid, state, witness, events, fixture;
async function setup(unshield = false, mutateRow = () => {}) {
  fixture =
    unshield === 'partial'
      ? require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial()
      : sample(unshield);
  mutateRow(fixture.row);
  const projection = createRailgunTxidProjection({
    hashPair: pair,
    zeroNodes: zeros,
    transactionHash: (r) => ({ hash: hash(JSON.stringify(r)), railgunTxid: hash(r.nullifiers[0]) }),
    verificationHash: () => fixture.row.verificationHash,
  });
  const values = new Map(),
    read = async (key) => values.get(key) ?? null;
  const projected = await projection.append(projection.empty(), [fixture.row], read);
  state = projected.state;
  projected.writes.forEach(({ key, value }) => values.set(key, value));
  witness = await projection.witness(state, hash(fixture.row.nullifiers[0]), read);
  const data = {
    bindingDigest: '1'.repeat(64),
    selector: {
      tree: 0,
      position: 0,
      nullifier: fixture.row.nullifiers[0],
      noteHash: fixture.capsule.noteHash,
    },
    facts: { nullifier: fixture.row.nullifiers[0] },
    submitter: fixture.transaction.from,
    capsule: fixture.capsule,
    capsuleDigest: '2'.repeat(64),
    provedTransaction: { data: fixture.transaction.input },
    intent: fixture.record.intent,
    record: fixture.record,
    projection: projectRailgunOwnRecord(fixture.record),
  };
  first = {
    status: 'captured',
    capture: copy(data),
    derived: { railgunTxid: witness.railgunTxid },
  };
  latest = { status: 'captured', capture: copy(data) };
  mockSelectorCapture.mockImplementation(async () => {
    events.push('capture-selector-exited');
    return first;
  });
  mockCapture.mockImplementation(async () => {
    events.push('recapture');
    return latest;
  });
  txid = {
    policy: mockPolicy,
    publicIdentity: mockPublicIdentity,
    inspect: jest.fn(async () => ({
      checkpoint: { state: copy(state) },
      pending: null,
      capacityReached: false,
    })),
    witness: jest.fn(async () => {
      events.push('witness');
      return { witness: copy(witness) };
    }),
    close: jest.fn(async () => {
      events.push('txid-drained');
    }),
  };
  mockOpen.mockImplementation(async () => {
    events.push('txid-open');
    return txid;
  });
  mockObserve.mockImplementation(async () => {
    events.push('receipt');
    return {
      status: 'observed',
      observation: {
        transaction: fixture.transaction,
        receipt: fixture.receipt,
        captureBindingDigest: first.capture.bindingDigest,
        capturedRepresentation: 'active',
        anchorsActuallyChecked: [],
      },
    };
  });
  mockSourceCurrent = true;
  mockSourceAt = undefined;
  mockSourceObservation = {
    suppliedOutcome: first.capture.projection.railgun.transact,
    sourceAuthenticated: true,
  };
  mockSource = { receipt: {}, close: jest.fn(), signal: scope.signal };
  mockSourceCapture.mockImplementation(async () => {
    events.push('source');
    mockSourceAt = performance.now();
    return mockSource;
  });
  mockPoiObservation = {
    sourceAuthenticated: true,
    own: mockSourceObservation,
    creator: {
      creator: {
        type: 'Shield',
        tree: fixture.capsule.selection.tree,
        position: fixture.capsule.selection.position,
        preimage: { value: '1000' },
      },
      origin: { blockNumber: 5944700 },
    },
  };
  mockPoiCapture.mockImplementation(async () => {
    events.push('poi-source');
    mockSourceAt = performance.now();
    return mockSource;
  });
  mockPoiCompletedCapture.mockImplementation(async () => {
    events.push('poi-source-completed');
    mockSourceAt = performance.now();
    return { ...mockSource, status: 'captured' };
  });
  mockVerify.mockImplementation(async () => {
    events.push('verify-exited');
    return { pathVerified: true, utilityExitObserved: true };
  });
  const rootReceipt = {},
    rootObservation = { index: state.count - 1, root: state.root, accepted: true };
  mockRoots = {
    acquire: jest.fn(async () => {
      events.push('root');
      return rootReceipt;
    }),
    assertRoot: jest.fn((receipt, point) => {
      expect(receipt).toBe(rootReceipt);
      expect(point).toEqual({ index: state.count - 1, root: state.root });
      return rootObservation;
    }),
    close: jest.fn(),
  };
  mockRootCreate.mockReturnValue(mockRoots);
  options = {
    enrollment: mockEnrollment,
    coordinator: mockCoordinator,
    archive: '/runtime.asar',
    selector: copy(data.selector),
    signal: caller.signal,
  };
}
beforeEach(async () => {
  jest.clearAllMocks();
  scope = createPrivacyScope({ profileId: 'own-witness', signal: new AbortController().signal });
  caller = new AbortController();
  events = [];
  mockPolicy = 'txid';
  mockDestination = Object.freeze({});
  mockPublicIdentity = {
    generationId: '1'.repeat(64),
    publicId: '2'.repeat(64),
    sourceId: '3'.repeat(64),
  };
  mockEnrollment = {
    directory: '/synthetic-own-witness',
    signal: scope.signal,
    getContext: () =>
      scope.getContext({
        kind: 'private-account',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        principal: 'fixture',
        role: 'engine',
      }),
  };
  mockCoordinator = { signal: scope.signal };
  await setup();
});
afterEach(() => {
  caller.abort();
  scope.close();
  jest.useRealTimers();
});
test.each([false, true])(
  'captures detached %s data only after TXID drain and fresh recovery',
  async (unshield) => {
    await setup(unshield);
    const result = await capture(options);
    expect(result.status).toBe('captured');
    expect(events).toEqual([
      'capture-selector-exited',
      'txid-open',
      'witness',
      'txid-drained',
      'recapture',
    ]);
    expect(mockOpen).toHaveBeenCalledWith({
      enrollment: mockEnrollment,
      coordinator: mockCoordinator,
      archive: '/runtime.asar',
      create: false,
      checkpointOnly: true,
      signal: expect.any(AbortSignal),
    });
    expect(result.capture).toEqual(latest.capture);
    expect(Object.isFrozen(result.witness.row)).toBe(true);
    for (const flag of [
      'accountAuthenticated',
      'sourceAuthenticated',
      'currentFinalityVerified',
      'txidPathVerified',
      'txidRootAccepted',
      'poiVerified',
      'spendingEnabled',
    ])
      expect(result[flag]).toBe(false);
  }
);
test.each(['bindingDigest', 'capsule', 'provedTransaction', 'projection', 'intent'])(
  'refuses changed %s at fresh recovery',
  async (field) => {
    latest.capture[field] = { changed: true };
    expect(await capture(options)).toEqual({ status: 'refused', stage: 'recapture' });
    expect(events.indexOf('txid-drained')).toBeLessThan(events.indexOf('recapture'));
  }
);
test('allows representation-only journal archival between phases', async () => {
  latest.capture.record = sample(false, true).record;
  expect((await capture(options)).status).toBe('captured');
});
test.each(['capacity', 'behind', 'missing', 'pending', 'changed'])(
  'refuses %s checkpoints and drains without recapture',
  async (mode) => {
    if (mode === 'capacity')
      txid.inspect.mockResolvedValue({
        checkpoint: { state: { ...state, after: '0x' + '0'.repeat(192) } },
        pending: null,
        capacityReached: true,
      });
    if (mode === 'behind')
      txid.inspect.mockResolvedValue({
        checkpoint: { state: { ...state, after: '0x' + '0'.repeat(192) } },
        pending: null,
        capacityReached: false,
      });
    if (mode === 'missing') txid.inspect.mockResolvedValue({ checkpoint: null, pending: null });
    if (mode === 'pending') txid.inspect.mockResolvedValue({ checkpoint: { state }, pending: {} });
    if (mode === 'changed')
      txid.inspect
        .mockResolvedValueOnce({
          checkpoint: { state: copy(state) },
          pending: null,
          capacityReached: false,
        })
        .mockResolvedValueOnce({ checkpoint: { state: { ...state, count: 2 } }, pending: null });
    expect((await capture(options)).status).toBe('refused');
    expect(txid.close).toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    if (mode !== 'changed') expect(txid.witness).not.toHaveBeenCalled();
  }
);
test.each(['txid', 'output', 'input-tree', 'unshield-recipient'])(
  'refuses internally valid but unrelated row metadata: %s',
  async (mode) => {
    await setup(mode === 'unshield-recipient', (row) => {
      if (mode === 'txid') row.txid = '1'.repeat(64);
      if (mode === 'output') row.utxoBatchStartPositionOut++;
      if (mode === 'input-tree') row.utxoTreeIn++;
      if (mode === 'unshield-recipient') row.unshield.toAddress = '0x' + '56'.repeat(20);
    });
    expect(await capture(options)).toEqual({ status: 'refused', stage: 'row' });
  }
);
test.each([
  ['witness', capture],
  ['preflight', preflight],
  ['POI preflight', poiPreflight],
])('drains a late %s open after cancellation before returning', async (_name, run) => {
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  mockOpen.mockImplementation(async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return txid;
  });
  let settled = false;
  const pending = run(options).then((result) => {
    settled = true;
    return result;
  });
  await ready;
  const forwarded = mockOpen.mock.calls[0][0].signal;
  expect(forwarded).toBeInstanceOf(AbortSignal);
  expect(forwarded.aborted).toBe(false);
  caller.abort();
  expect(forwarded.aborted).toBe(true);
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect((await pending).status).toBe('refused');
  expect(txid.close).toHaveBeenCalledTimes(1);
  expect(txid.inspect).not.toHaveBeenCalled();
});
test('waits for TXID close before refusal after cancellation during close', async () => {
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const drain = new Promise((resolve) => {
    release = resolve;
  });
  txid.close.mockImplementation(() => {
    entered();
    return drain;
  });
  let settled = false;
  const pending = capture(options).then((result) => {
    settled = true;
    return result;
  });
  await ready;
  caller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect((await pending).status).toBe('refused');
  expect(mockCapture).not.toHaveBeenCalled();
});
test('pins caller selector and refuses owner/policy drift', async () => {
  mockSelectorCapture.mockImplementation(async ({ selector }) => {
    options.selector.position = 99;
    expect(selector.position).toBe(0);
    mockPublicIdentity = { ...mockPublicIdentity, generationId: 'changed' };
    return first;
  });
  expect((await capture(options)).status).toBe('refused');
  expect(mockOpen).not.toHaveBeenCalled();
});

test('a full checkpoint may still supply the selected existing row', async () => {
  txid.inspect.mockResolvedValue({
    checkpoint: { state: copy(state) },
    pending: null,
    capacityReached: true,
  });
  expect((await capture(options)).status).toBe('captured');
});

test('preflight composes internally captured observations without returning receipts', async () => {
  const result = await preflight(options);
  expect(result.status).toBe('captured');
  expect(events).toEqual([
    'capture-selector-exited',
    'receipt',
    'txid-open',
    'witness',
    'txid-drained',
    'verify-exited',
    'source',
    'root',
    'recapture',
  ]);
  expect(result.observations.verification.pathVerified).toBe(true);
  expect(result.observations.archiveAnchorChecked).toBe(true);
  expect(result.txidPathVerified).toBe(false);
  expect(result.sourceAuthenticated).toBe(false);
  expect(result.spendingEnabled).toBe(false);
  expect(result.receipt).toBeUndefined();
  expect(result.observations.source.receipt).toBeUndefined();
  expect(mockSource.close).toHaveBeenCalledTimes(1);
  expect(mockRoots.close).toHaveBeenCalledTimes(1);
  expect(mockVerify.mock.calls[0][0].evidence.record).toEqual(first.capture.record);
});
test('preflight marks a newly archived anchor as unchecked', async () => {
  latest.capture.record = sample(false, true).record;
  const result = await preflight(options);
  expect(result.status).toBe('captured');
  expect(result.observations.finalRepresentation).toBe('archived');
  expect(result.observations.archiveAnchorChecked).toBe(false);
});
test.each(['receipt', 'source', 'verification', 'root', 'expired-source', 'expired-root'])(
  'preflight refuses %s and closes acquired resources',
  async (mode) => {
    if (mode === 'receipt')
      mockObserve.mockResolvedValue({ status: 'refused', stage: 'inclusion' });
    if (mode === 'source') mockSourceCapture.mockRejectedValue(Error('source'));
    if (mode === 'verification') mockVerify.mockRejectedValue(Error('proof'));
    if (mode === 'root') mockRoots.acquire.mockRejectedValue(Error('root'));
    if (mode === 'expired-source')
      mockCapture.mockImplementation(async () => {
        mockSourceCurrent = false;
        return latest;
      });
    if (mode === 'expired-root')
      mockRoots.assertRoot
        .mockImplementationOnce(() => ({ accepted: true }))
        .mockImplementationOnce(() => {
          throw Error('stale');
        });
    expect((await preflight(options)).status).toBe('refused');
    if (['root', 'expired-source', 'expired-root'].includes(mode))
      expect(mockSource.close).toHaveBeenCalled();
    if (['root', 'expired-source', 'expired-root'].includes(mode))
      expect(mockRoots.close).toHaveBeenCalled();
    const lease = claimRailgunAccountPhase(mockEnrollment, 'recovery');
    lease.release();
  }
);
test('verifier phase remains claimed until observed completion after cancellation', async () => {
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  mockPoiCompletedCapture.mockImplementation(async () => {
    events.push('poi-source-completed');
    mockSourceAt = performance.now();
    return { ...mockSource, status: 'captured' };
  });
  mockVerify.mockImplementation(async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return { pathVerified: true };
  });
  let settled = false;
  const pending = preflight(options).then((result) => {
    settled = true;
    return result;
  });
  await ready;
  expect(txid.close).toHaveBeenCalled();
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
  caller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
  release();
  expect((await pending).status).toBe('refused');
  const lease = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  lease.release();
  expect(mockRoots.acquire).not.toHaveBeenCalled();
});
test('plain witness export cannot be switched into preflight by an extra argument', async () => {
  expect((await capture(options, true)).status).toBe('captured');
  expect(mockObserve).not.toHaveBeenCalled();
  expect(mockVerify).not.toHaveBeenCalled();
});

test('source freshness starts after slow TXID and verifier steps', async () => {
  jest.useFakeTimers();
  txid.witness.mockImplementation(async () => {
    await jest.advanceTimersByTimeAsync(30001);
    return { witness: copy(witness) };
  });
  mockPoiCompletedCapture.mockImplementation(async () => {
    events.push('poi-source-completed');
    mockSourceAt = performance.now();
    return { ...mockSource, status: 'captured' };
  });
  mockVerify.mockImplementation(async () => {
    await jest.advanceTimersByTimeAsync(20001);
    return { pathVerified: true, utilityExitObserved: true };
  });
  expect((await preflight(options)).status).toBe('captured');
  expect(mockSourceAt).toBeGreaterThan(45000);
});
test('uses distinct default overall deadlines for witness and preflight', async () => {
  jest.useFakeTimers();
  const timer = jest.spyOn(global, 'setTimeout');
  expect((await preflight(options)).status).toBe('captured');
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 300000);
  timer.mockClear();
  expect((await capture(options)).status).toBe('captured');
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 180000);
  timer.mockRestore();
});

test('source acquisition budget includes a long visit before snapshot freshness begins', async () => {
  jest.useFakeTimers();
  mockSourceCapture.mockImplementation(async ({ timeoutMs }) => {
    const started = performance.now();
    await jest.advanceTimersByTimeAsync(60001);
    if (performance.now() - started >= timeoutMs) throw Error('capture deadline');
    mockSourceAt = performance.now();
    return mockSource;
  });
  const acquire = mockRoots.acquire.getMockImplementation();
  mockRoots.acquire.mockImplementation(async (...args) => {
    await jest.advanceTimersByTimeAsync(20001);
    return acquire(...args);
  });
  expect((await preflight(options)).status).toBe('captured');
  expect(mockSourceCapture.mock.calls[0][0].timeoutMs).toBe(180000);
});

test('POI preflight joins the genuine capsule and one combined source receipt after verification', async () => {
  const result = await poiPreflight({ ...options, capsule: { forged: true } });
  expect(result.status).toBe('captured');
  expect(events).toEqual([
    'capture-selector-exited',
    'receipt',
    'txid-open',
    'witness',
    'txid-drained',
    'verify-exited',
    'poi-source',
    'root',
    'recapture',
  ]);
  expect(mockSourceCapture).not.toHaveBeenCalled();
  expect(mockPoiCapture.mock.calls[0][0]).toMatchObject({
    capsule: first.capture.capsule,
    record: first.capture.record,
    transaction: fixture.transaction,
    receipt: fixture.receipt,
  });
  expect(result.poiPreparation).toEqual({
    creator: mockPoiObservation.creator.creator,
    ownEvidence: {
      capsule: latest.capture.capsule,
      record: latest.capture.record,
      transaction: fixture.transaction,
      receipt: fixture.receipt,
      row: witness.row,
    },
    state,
    witness,
  });
  expect(result.sourceAuthenticated).toBe(false);
  expect(result.poiVerified).toBe(false);
  expect(result.disclosureEnabled).toBe(false);
  expect(result.spendingEnabled).toBe(false);
  expect(result.poiPreparation.receipt).toBeUndefined();
  expect(Object.isFrozen(result.poiPreparation.ownEvidence.capsule)).toBe(true);
  expect(mockSource.close).toHaveBeenCalledTimes(1);
});
test.each([
  [5944699, true],
  [5944700, false],
  [5944701, false],
])(
  'classifies creator block %s as legacy=%s without selecting list proofs',
  async (number, legacy) => {
    mockPoiObservation.creator.origin.blockNumber = number;
    const result = await poiPreflight(options);
    expect(result.creatorClassification).toEqual({ type: 'Shield', blockNumber: number, legacy });
    expect(result.poiPreparation.listProofs).toBeUndefined();
  }
);
test('existing exports cannot select POI mode through extra arguments or properties', async () => {
  expect((await capture({ ...options, poi: true }, true, true)).poiPreparation).toBeUndefined();
  expect((await preflight({ ...options, poi: true }, true)).poiPreparation).toBeUndefined();
  expect(mockPoiCapture).not.toHaveBeenCalled();
});
test.each(['source', 'expired-source', 'root', 'capsule-drift'])(
  'POI preflight refuses %s without returning preparation',
  async (mode) => {
    if (mode === 'source') mockPoiCapture.mockRejectedValue(Error('source refused'));
    if (mode === 'expired-source')
      mockCapture.mockImplementation(async () => {
        mockSourceCurrent = false;
        return latest;
      });
    if (mode === 'root') mockRoots.acquire.mockRejectedValue(Error('root refused'));
    if (mode === 'capsule-drift') latest.capture.capsule.noteHash = '0x' + '1'.repeat(64);
    const result = await poiPreflight(options);
    expect(result.status).toBe('refused');
    expect(result.poiPreparation).toBeUndefined();
    if (mode !== 'source') expect(mockSource.close).toHaveBeenCalled();
  }
);
test('POI source stays late after slow verifier and retains the 180-second acquisition budget', async () => {
  jest.useFakeTimers();
  mockPoiCompletedCapture.mockImplementation(async () => {
    events.push('poi-source-completed');
    mockSourceAt = performance.now();
    return { ...mockSource, status: 'captured' };
  });
  mockVerify.mockImplementation(async () => {
    await jest.advanceTimersByTimeAsync(50001);
    return { pathVerified: true };
  });
  expect((await poiPreflight(options)).status).toBe('captured');
  expect(mockSourceAt).toBeGreaterThan(45000);
  expect(mockPoiCapture.mock.calls[0][0].timeoutMs).toBe(180000);
});

test.each([
  ['witness', capture],
  ['preflight', preflight],
  ['POI preflight', poiPreflight],
])(
  'own %s deadline revokes pending TXID startup and drains late handle without cancelling shared owners',
  async (_name, run) => {
    jest.useFakeTimers();
    let entered,
      release,
      settled = false;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    mockOpen.mockImplementation(async () => {
      entered();
      await gate;
      return txid;
    });
    const pending = run({ ...options, timeoutMs: 1000 }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await ready;
      const forwarded = mockOpen.mock.calls[0][0].signal;
      expect(forwarded).toBeInstanceOf(AbortSignal);
      await jest.advanceTimersByTimeAsync(999);
      expect(forwarded.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(forwarded.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      expect(scope.signal.aborted).toBe(false);
      expect(settled).toBe(false);
      expect(txid.inspect).not.toHaveBeenCalled();
      release();
      expect((await pending).status).toBe('refused');
      expect(txid.close).toHaveBeenCalledTimes(1);
      expect(txid.witness).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockRoots.acquire).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  }
);

test.each([false, true])(
  'completed POI preflight %s pins destination and retains the existing receipt wrapper',
  async (unshield) => {
    await setup(unshield);
    const result = await poiCompleted({ ...options, sourceDestination: mockDestination });
    expect(result.status).toBe('captured');
    expect(mockPoiCompletedCapture).toHaveBeenCalledTimes(1);
    expect(mockPoiCompletedCapture.mock.calls[0][0]).toMatchObject({
      destination: mockDestination,
      enrollment: mockEnrollment,
      coordinator: mockCoordinator,
    });
    expect(mockPoiCapture).not.toHaveBeenCalled();
    expect(mockSourceCapture).not.toHaveBeenCalled();
    expect(mockObserve).toHaveBeenCalledTimes(1);
    expect(mockRootCreate).toHaveBeenCalledTimes(1);
    expect(events.indexOf('poi-source-completed')).toBeGreaterThan(events.indexOf('verify-exited'));
    expect(events.indexOf('root')).toBeGreaterThan(events.indexOf('poi-source-completed'));
    expect(result).toMatchObject({
      spendingEnabled: false,
      disclosureEnabled: false,
      sourceAuthenticated: false,
    });
  }
);
test.each([undefined, null, {}])(
  'completed preflight refuses absent/copied source destination %# before receipt/TXID work',
  async (sourceDestination) => {
    expect((await poiCompleted({ ...options, sourceDestination })).status).toBe('refused');
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockSelectorCapture).not.toHaveBeenCalled();
    expect(mockRootCreate).not.toHaveBeenCalled();
  }
);
test.each([false, true])(
  'completed source refusal forwards authenticated fatal=%s and admits no root',
  async (fatal) => {
    const sourceOutcome = Object.freeze({
      fatal,
      reason: fatal ? 'fatal' : 'checkpoint-unavailable',
      rpcFailure: fatal ? 'response' : null,
    });
    mockPoiCompletedCapture.mockResolvedValueOnce({
      status: 'refused',
      stage: 'snapshot',
      sourceOutcome,
    });
    const result = await poiCompleted({ ...options, sourceDestination: mockDestination });
    expect(result).toMatchObject({ status: 'refused', sourceOutcome });
    expect(Object.isFrozen(result.sourceOutcome)).toBe(true);
    expect(mockRootCreate).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  }
);
test('cancellation waits for completed source and preserves its late fatal outcome before checking currency', async () => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const sourceOutcome = Object.freeze({ fatal: true, reason: 'fatal', rpcFailure: 'response' });
  mockPoiCompletedCapture.mockImplementationOnce(async () => {
    entered();
    await gate;
    return { status: 'refused', stage: 'snapshot', sourceOutcome };
  });
  let settled = false;
  const pending = poiCompleted({ ...options, sourceDestination: mockDestination }).then(
    (result) => {
      settled = true;
      return result;
    }
  );
  try {
    await ready;
    caller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockRootCreate).not.toHaveBeenCalled();
  } finally {
    release();
  }
  expect(await pending).toMatchObject({ status: 'refused', sourceOutcome });
  expect(mockRootCreate).not.toHaveBeenCalled();
});
test.each(['receipt', 'verification', 'source'])(
  'destination replacement during %s refuses without later root admission',
  async (boundary) => {
    const target =
      boundary === 'receipt'
        ? mockObserve
        : boundary === 'verification'
          ? mockVerify
          : mockPoiCompletedCapture;
    const original = target.getMockImplementation();
    target.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      mockDestination = Object.freeze({});
      return result;
    });
    expect((await poiCompleted({ ...options, sourceDestination: mockDestination })).status).toBe(
      'refused'
    );
    expect(mockRootCreate).not.toHaveBeenCalled();
    if (boundary !== 'source') expect(mockPoiCompletedCapture).not.toHaveBeenCalled();
  }
);
test('completed preflight passes remaining total budget to the late source capture', async () => {
  jest.useFakeTimers();
  mockVerify.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(130000);
    return { pathVerified: true, utilityExitObserved: true };
  });
  expect(
    (await poiCompleted({ ...options, sourceDestination: mockDestination, timeoutMs: 300000 }))
      .status
  ).toBe('captured');
  expect(mockPoiCompletedCapture.mock.calls[0][0].timeoutMs).toBe(170000);
});
test('legacy POI preflight ignores extra route-selector arguments and keeps its original source path', async () => {
  expect(
    (await poiPreflight({ ...options, sourceDestination: mockDestination }, true)).status
  ).toBe('captured');
  expect(mockPoiCapture).toHaveBeenCalledTimes(1);
  expect(mockPoiCompletedCapture).not.toHaveBeenCalled();
});

describe('fixed submission witness/preflight core', () => {
  let handoff;
  function prepare() {
    handoff = {
      entry: {
        selector: copy(options.selector),
        capsuleDigest: first.capture.capsuleDigest,
        bindingDigest: first.capture.bindingDigest,
      },
      capture: copy(first.capture),
      observation: {
        transaction: copy(fixture.transaction),
        receipt: copy(fixture.receipt),
        captureBindingDigest: first.capture.bindingDigest,
        capturedRepresentation: 'active',
        anchorsActuallyChecked: [],
      },
    };
  }
  const submit = (input = handoff) =>
    poiSubmission({ ...options, sourceDestination: mockDestination }, input);
  beforeEach(() => prepare());
  test.each([false, true])(
    'uses retained receipt without second RPC, kind %s',
    async (unshield) => {
      await setup(unshield);
      prepare();
      const result = await submit();
      expect(result.status).toBe('captured');
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockPoiCapture).not.toHaveBeenCalled();
      expect(mockPoiCompletedCapture).toHaveBeenCalledTimes(1);
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockVerify.mock.calls[0][0].evidence).toMatchObject({
        transaction: handoff.observation.transaction,
        receipt: handoff.observation.receipt,
      });
      expect(events.indexOf('capture-selector-exited')).toBeLessThan(events.indexOf('txid-open'));
      expect(events.indexOf('txid-drained')).toBeLessThan(events.indexOf('verify-exited'));
      expect(events.indexOf('verify-exited')).toBeLessThan(events.indexOf('poi-source-completed'));
      expect(events.indexOf('poi-source-completed')).toBeLessThan(events.indexOf('root'));
      expect(result.disclosureEnabled).toBe(false);
    }
  );
  test.each([undefined, null, false, {}])(
    'missing input %p cannot fall back to a receipt read',
    async (input) => {
      expect(
        (await poiSubmission({ ...options, sourceDestination: mockDestination }, input)).status
      ).toBe('refused');
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockSelectorCapture).not.toHaveBeenCalled();
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );
  test.each(['entry-selector', 'entry-capsule', 'entry-binding', 'extra'])(
    'rejects malformed internal %s before capture',
    async (field) => {
      if (field === 'entry-selector') handoff.entry.selector.position++;
      if (field === 'entry-capsule') handoff.entry.capsuleDigest = '9'.repeat(64);
      if (field === 'entry-binding') handoff.entry.bindingDigest = '9'.repeat(64);
      if (field === 'extra') handoff.authorized = true;
      expect(await submit()).toEqual({ status: 'refused', stage: 'context' });
      expect(mockSelectorCapture).not.toHaveBeenCalled();
      expect(mockObserve).not.toHaveBeenCalled();
    }
  );
  test.each(['facts', 'projection', 'binding', 'transaction', 'receipt'])(
    'binds actual capture and retained %s before opening TXID',
    async (field) => {
      if (field === 'facts' || field === 'projection') first.capture[field] = { changed: true };
      if (field === 'binding') handoff.observation.captureBindingDigest = '9'.repeat(64);
      if (field === 'transaction') handoff.observation.transaction.hash = '0x' + '9'.repeat(64);
      if (field === 'receipt') handoff.observation.receipt.transactionHash = '0x' + '9'.repeat(64);
      expect(await submit()).toEqual({ status: 'refused', stage: 'capture' });
      expect(mockSelectorCapture).toHaveBeenCalledTimes(1);
      expect(mockOpen).not.toHaveBeenCalled();
      expect(mockObserve).not.toHaveBeenCalled();
    }
  );
  test('wrong exact destination refuses before any capture or receipt work', async () => {
    expect((await poiSubmission({ ...options, sourceDestination: {} }, handoff)).status).toBe(
      'refused'
    );
    expect(mockSelectorCapture).not.toHaveBeenCalled();
    expect(mockObserve).not.toHaveBeenCalled();
  });
  test('detaches private receipt data before first awaited capture', async () => {
    let release, entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    mockSelectorCapture.mockImplementationOnce(async () => {
      entered();
      await gate;
      return first;
    });
    const baseline = copy(handoff);
    const pending = submit();
    try {
      await ready;
      handoff.observation.transaction.hash = '0x' + '9'.repeat(64);
      handoff.capture.facts = { changed: true };
      handoff.entry.selector.position++;
      release();
      expect((await pending).status).toBe('captured');
      expect(mockVerify.mock.calls[0][0].evidence).toMatchObject({
        transaction: baseline.observation.transaction,
        receipt: baseline.observation.receipt,
      });
      expect(mockObserve).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  });
  test('final account drift refuses after source/root and drains without another receipt read', async () => {
    latest.capture.projection = { ...latest.capture.projection, hash: '0x' + '9'.repeat(64) };
    expect(await submit()).toEqual({ status: 'refused', stage: 'recapture' });
    expect(mockPoiCompletedCapture).toHaveBeenCalledTimes(1);
    expect(mockRoots.acquire).toHaveBeenCalledTimes(1);
    expect(mockRoots.close).toHaveBeenCalled();
    expect(mockSource.close).toHaveBeenCalled();
    expect(mockObserve).not.toHaveBeenCalled();
  });
  test('preserves late genuine source failure after cancel and waits for it', async () => {
    let release, entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const sourceOutcome = Object.freeze({ fatal: true, reason: 'rpc', rpcFailure: 'response' });
    mockPoiCompletedCapture.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { status: 'refused', stage: 'snapshot', sourceOutcome };
    });
    let settled = false;
    const pending = submit().then((value) => {
      settled = true;
      return value;
    });
    try {
      await ready;
      caller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect(await pending).toMatchObject({ status: 'refused', sourceOutcome });
      expect(mockRoots.acquire).not.toHaveBeenCalled();
      expect(mockObserve).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  });
  test('legacy completed preflight still observes its own receipt despite extra positional data', async () => {
    expect(
      (await poiCompleted({ ...options, sourceDestination: mockDestination }, handoff)).status
    ).toBe('captured');
    expect(mockObserve).toHaveBeenCalledTimes(1);
  });
});

const prefixed = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const deferredGate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let creatorNoteWitness;
async function setupTransact(unshield = false, partialCreator = false) {
  await setup(unshield);
  const creatorBlock = 5944701,
    ownBlock = 5944702;
  fixture.row.blockNumber = ownBlock;
  fixture.row.graphID = prefixed(ownBlock) + prefixed(4).slice(2) + prefixed(0).slice(2);
  for (const value of [fixture.transaction, fixture.receipt, ...fixture.receipt.logs]) {
    value.blockNumber = '0x' + ownBlock.toString(16);
    value.blockHash = prefixed(ownBlock);
  }
  fixture.record.observation.blockNumber = ownBlock;
  fixture.record.observation.blockHash = prefixed(ownBlock);
  fixture.record.resolution.blockHash = prefixed(ownBlock);
  fixture.record.resolution.railgun.finalizedBlockNumber = ownBlock + 10;
  fixture.record.resolution.railgun.finalizedBlockHash = prefixed(ownBlock + 10);
  fixture.record.resolution.railgun.transact =
    require('./railgun-transact-receipt').inspectRailgunTransactReceipt(
      fixture.record,
      fixture.transaction,
      fixture.receipt
    );
  expect(fixture.record.resolution.railgun.transact.status).toBe('matched');
  const creatorRow = {
    version: 'V2',
    graphID: prefixed(creatorBlock) + prefixed(2).slice(2) + prefixed(0).slice(2),
    commitments: [fixture.capsule.noteHash],
    nullifiers: [prefixed(700)],
    boundParamsHash: prefixed(701),
    blockNumber: creatorBlock,
    txid: prefixed(706).slice(2),
    timestamp: creatorBlock,
    utxoTreeIn: 0,
    utxoTreeOut: 0,
    utxoBatchStartPositionOut: 1,
    verificationHash: fixture.row.verificationHash,
  };
  if (partialCreator) {
    creatorRow.commitments.push(prefixed(702));
    creatorRow.unshield = {
      tokenData: {
        tokenType: 0,
        tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
        tokenSubID: prefixed(0),
      },
      toAddress: '0x' + '12'.repeat(20),
      value: '400',
    };
  }
  const projection = createRailgunTxidProjection({
    hashPair: pair,
    zeroNodes: zeros,
    transactionHash: (row) => ({
      hash: hash(JSON.stringify(row)),
      railgunTxid: hash(row.nullifiers[0]),
    }),
    verificationHash: () => fixture.row.verificationHash,
  });
  const values = new Map(),
    read = async (key) => values.get(key) ?? null;
  const appended = await projection.append(projection.empty(), [creatorRow, fixture.row], read);
  for (const { key, value } of appended.writes) values.set(key, value);
  state = appended.state;
  witness = await projection.witness(state, hash(fixture.row.nullifiers[0]), read);
  const note = {
    type: 'Transact',
    txid: prefixed(706),
    hash: fixture.capsule.noteHash,
    tree: 0,
    position: 1,
    blockNumber: creatorBlock,
  };
  creatorNoteWitness = await require('./railgun-txid-note-witness').findRailgunNoteTxidWitness({
    state,
    note,
    read,
    projection,
  });
  first.capture.record = copy(fixture.record);
  first.capture.projection = projectRailgunOwnRecord(fixture.record);
  first.capture.selector.position = 1;
  first.capture.capsule.selection.position = 1;
  first.derived.railgunTxid = witness.railgunTxid;
  latest = { status: 'captured', capture: copy(first.capture) };
  options.selector = copy(first.capture.selector);
  mockSourceObservation.suppliedOutcome = first.capture.projection.railgun.transact;
  mockPoiObservation = {
    sourceAuthenticated: true,
    own: mockSourceObservation,
    checkpointHash: 'a'.repeat(64),
    creator: {
      creator: { type: 'Transact', tree: 0, position: 1, hash: note.hash, ciphertext: {} },
      origin: {
        blockNumber: creatorBlock,
        blockHash: prefixed(creatorBlock),
        transactionHash: note.txid,
        transactionIndex: 2,
        logIndex: partialCreator ? 2 : 1,
        tree: 0,
        startPosition: 1,
        outputOffset: 0,
      },
      transaction: {
        note,
        logsSha256: 'b'.repeat(64),
        events: [
          { name: 'Nullified', logIndex: 0, tree: 0, values: creatorRow.nullifiers },
          ...(partialCreator
            ? [
                {
                  name: 'Unshield',
                  logIndex: 1,
                  to: creatorRow.unshield.toAddress,
                  token: creatorRow.unshield.tokenData.tokenAddress,
                  type: 0,
                  subID: '0',
                  value: '400',
                },
              ]
            : []),
          {
            name: 'Transact',
            logIndex: partialCreator ? 2 : 1,
            tree: 0,
            start: 1,
            hashes: [creatorRow.commitments[0]],
          },
        ],
      },
    },
  };
  txid.witnessNote = jest.fn(async () => {
    events.push('creator-witness');
    return { noteWitness: copy(creatorNoteWitness) };
  });
  mockPoiTransactCapture.mockImplementation(async () => {
    events.push('poi-source-transact');
    mockSourceAt = performance.now();
    return { ...mockSource, status: 'captured' };
  });
  mockVerifyCreator.mockImplementation(async ({ note, noteWitness, events: creatorEvents }) => {
    // Actual structural row/event comparison; native path/preimage cryptography
    // and worker exit remain explicit mocks in this orchestration unit suite.
    const coverage = require('./railgun-txid-events').matchRailgunTxidEvents({
      blockNumber: note.blockNumber,
      txid: note.txid.slice(2),
      events: creatorEvents,
      rows: [noteWitness.witness.row],
    });
    events.push('creator-verify-exited');
    return {
      utilityExitObserved: true,
      pathVerified: true,
      suppliedCreatorEventsMatched: true,
      ownershipVerified: false,
      eventSourceAuthenticated: false,
      rootAccepted: false,
      spendingEnabled: false,
      coverage: { ...coverage },
      ...(partialCreator ? { unshieldCommitmentVerified: true } : {}),
    };
  });
  const rootObservation = { index: 1, root: state.root, accepted: true };
  mockRoots.assertRoot.mockImplementation((_receipt, point) => {
    expect(point).toEqual({ index: 1, root: state.root });
    return rootObservation;
  });
}
describe('fixed source-first Transact membership preflight', () => {
  beforeEach(async () => {
    await setupTransact();
  });
  test.each([false, true])(
    'joins both independent paths in one cold mirror, unshield=%s',
    async (unshield) => {
      await setupTransact(unshield);
      const result = await poiTransact(options);
      expect(result.status).toBe('captured');
      expect(events).toEqual([
        'capture-selector-exited',
        'receipt',
        'poi-source-transact',
        'txid-open',
        'witness',
        'creator-witness',
        'txid-drained',
        'verify-exited',
        'creator-verify-exited',
        'root',
        'recapture',
      ]);
      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(mockOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          create: false,
          checkpointOnly: true,
          signal: expect.any(AbortSignal),
        })
      );
      expect(txid.inspect).toHaveBeenCalledTimes(2);
      expect(txid.witness).toHaveBeenCalledTimes(1);
      expect(txid.witnessNote).toHaveBeenCalledWith(mockPoiObservation.creator.transaction.note);
      expect(mockObserve).toHaveBeenCalledTimes(1);
      expect(mockPoiCapture).not.toHaveBeenCalled();
      expect(mockPoiCompletedCapture).not.toHaveBeenCalled();
      expect(mockPoiTransactCapture.mock.calls[0][0].destination).toBe(mockDestination);
      expect(mockVerify.mock.calls[0][0].state).toEqual(mockVerifyCreator.mock.calls[0][0].state);
      expect(mockVerify.mock.calls[0][0].witness.index).toBe(1);
      expect(mockVerifyCreator.mock.calls[0][0].noteWitness.witness.index).toBe(0);
      expect(result.creatorProvenance).toMatchObject({
        note: mockPoiObservation.creator.transaction.note,
        noteWitness: creatorNoteWitness,
        origin: mockPoiObservation.creator.origin,
        logsSha256: 'b'.repeat(64),
        checkpointHash: 'a'.repeat(64),
        txidPolicy: mockPolicy,
        publicIdentity: mockPublicIdentity,
        boundParamsChecked: false,
        globalTxidCompleteness: false,
        disclosureEnabled: false,
        spendingEnabled: false,
      });
      expect(Object.isFrozen(result.creatorProvenance.noteWitness.witness.row)).toBe(true);
      for (const key of [
        'accountAuthenticated',
        'sourceAuthenticated',
        'currentFinalityVerified',
        'txidPathVerified',
        'txidRootAccepted',
        'poiVerified',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        expect(result[key]).toBe(false);
    }
  );
});

describe('Transact membership refusal and lifetime boundaries', () => {
  beforeEach(async () => {
    await setupTransact();
  });
  test.each(['sourceDestination', 'creator', 'observation', 'transport', 'submission'])(
    'rejects caller-supplied %s before any operation',
    async (key) => {
      expect(await poiTransact({ ...options, [key]: {} })).toEqual({
        status: 'refused',
        stage: 'context',
      });
      expect(mockSelectorCapture).not.toHaveBeenCalled();
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );
  test.each([0, -1, 300001, 1.5, null, false, Infinity, NaN])(
    'rejects timeout %s before capture',
    async (timeoutMs) => {
      expect((await poiTransact({ ...options, timeoutMs })).status).toBe('refused');
      expect(mockSelectorCapture).not.toHaveBeenCalled();
    }
  );
  test.each(['Shield', 'prelaunch', 'note', 'two-inputs', 'two-outputs', 'unshield'])(
    'rejects source creator %s before mirror opening',
    async (fault) => {
      const c = mockPoiObservation.creator;
      if (fault === 'Shield') c.creator.type = 'Shield';
      if (fault === 'prelaunch') c.origin.blockNumber = 5944699;
      if (fault === 'note') c.transaction.note.position = 2;
      if (fault === 'two-inputs') c.transaction.events[0].values.push(prefixed(999));
      if (fault === 'two-outputs') c.transaction.events[1].hashes.push(prefixed(999));
      if (fault === 'unshield') c.transaction.events.splice(1, 0, { name: 'Unshield' });
      expect((await poiTransact(options)).status).toBe('refused');
      expect(mockOpen).not.toHaveBeenCalled();
      expect(mockVerifyCreator).not.toHaveBeenCalled();
      expect(mockRootCreate).not.toHaveBeenCalled();
      expect(mockSource.close).toHaveBeenCalledTimes(1);
    }
  );
  test.each(['index', 'graph-index', 'root', 'checkpoint', 'note', 'two-inputs', 'two-outputs'])(
    'rejects independently malformed creator witness %s before either verifier',
    async (fault) => {
      const c = copy(creatorNoteWitness);
      if (fault === 'index') c.witness.index = witness.index;
      if (fault === 'graph-index')
        c.witness.row.graphID = prefixed(5944701) + prefixed(3).slice(2) + prefixed(0).slice(2);
      if (fault === 'root') c.witness.root = hash('wrong root');
      if (fault === 'checkpoint') c.witness.checkpointIndex = 0;
      if (fault === 'note') c.note.position = 2;
      if (fault === 'two-inputs') c.witness.row.nullifiers.push(prefixed(999));
      if (fault === 'two-outputs') c.witness.row.commitments.push(prefixed(999));
      c.witness.rowSha256 = createHash('sha256')
        .update(JSON.stringify(c.witness.row))
        .digest('hex');
      txid.witnessNote.mockResolvedValue({ noteWitness: c });
      expect((await poiTransact(options)).status).toBe('refused');
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockVerifyCreator).not.toHaveBeenCalled();
      expect(mockRootCreate).not.toHaveBeenCalled();
      expect(txid.close).toHaveBeenCalled();
    }
  );
  test.each(['own', 'creator', 'path', 'exit', 'events', 'omissions', 'bound-params', 'global'])(
    'refuses verification %s before service-root acquisition',
    async (fault) => {
      if (fault === 'own') mockVerify.mockRejectedValue(Error('path failed'));
      else if (fault === 'creator') mockVerifyCreator.mockRejectedValue(Error('path failed'));
      else {
        const valid = mockVerifyCreator.getMockImplementation();
        mockVerifyCreator.mockImplementation(async (...args) => {
          const result = await valid(...args);
          if (fault === 'path') result.pathVerified = false;
          if (fault === 'exit') result.utilityExitObserved = false;
          if (fault === 'events') result.suppliedCreatorEventsMatched = false;
          if (fault === 'omissions') result.coverage.knownOmissions = 1;
          if (fault === 'bound-params') result.coverage.boundParamsChecked = true;
          if (fault === 'global') result.coverage.globalTxidCompleteness = true;
          return result;
        });
      }
      expect((await poiTransact(options)).status).toBe('refused');
      expect(mockRootCreate).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
      const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
      phase.release();
    }
  );
  test.each(['destination', 'generation', 'policy'])(
    'rejects %s replacement after source without silently reopening it',
    async (fault) => {
      const original = txid.witnessNote.getMockImplementation();
      txid.witnessNote.mockImplementation(async (...args) => {
        const result = await original(...args);
        if (fault === 'destination') mockDestination = Object.freeze({});
        if (fault === 'generation')
          mockPublicIdentity = { ...mockPublicIdentity, generationId: '9'.repeat(64) };
        if (fault === 'policy') txid.policy = 'replacement-policy';
        return result;
      });
      // A session's policy is checked on opening. Change the actual policy before
      // open, rather than emulating a mutable policy on an already-frozen session.
      if (fault === 'policy')
        mockOpen.mockImplementation(async () => ({ ...txid, policy: 'replacement-policy' }));
      expect((await poiTransact(options)).status).toBe('refused');
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockRootCreate).not.toHaveBeenCalled();
      expect(mockPoiTransactCapture).toHaveBeenCalledTimes(1);
    }
  );
  test('detaches the first mirror checkpoint before borrowed reads can mutate it', async () => {
    const mutable = { checkpoint: { state: copy(state) }, pending: null, capacityReached: false };
    txid.inspect.mockResolvedValue(mutable);
    txid.witnessNote.mockImplementation(async () => {
      mutable.checkpoint.state.transcript = '9'.repeat(64);
      return { noteWitness: copy(creatorNoteWitness) };
    });
    expect((await poiTransact(options)).status).toBe('refused');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(txid.close).toHaveBeenCalled();
  });
  test.each(['own', 'creator'])(
    'holds the actual recovery phase until cancelled %s verifier exits',
    async (which) => {
      const entered = deferredGate(),
        gate = deferredGate();
      const verify = which === 'own' ? mockVerify : mockVerifyCreator;
      const original = verify.getMockImplementation();
      verify.mockImplementation(async (...args) => {
        entered.resolve();
        await gate.promise;
        return original(...args);
      });
      let settled = false;
      const pending = poiTransact(options).then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      try {
        caller.abort();
        await Promise.resolve();
        expect(verify.mock.calls[0][0].signal.aborted).toBe(true);
        expect(settled).toBe(false);
        expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
        expect(mockRootCreate).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
      }
      expect((await pending).status).toBe('refused');
      const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
      phase.release();
      expect(scope.signal.aborted).toBe(false);
    }
  );
  test.each(['cancel', 'deadline'])(
    'drains late mirror opening and closing after %s before returning',
    async (kind) => {
      jest.useFakeTimers();
      const entered = deferredGate(),
        open = deferredGate(),
        closing = deferredGate(),
        close = deferredGate();
      mockOpen.mockImplementation(async () => {
        entered.resolve();
        await open.promise;
        return txid;
      });
      txid.close.mockImplementation(async () => {
        closing.resolve();
        await close.promise;
      });
      let settled = false;
      const pending = poiTransact(options).then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      try {
        if (kind === 'cancel') caller.abort();
        else await jest.advanceTimersByTimeAsync(20000);
        expect(mockOpen.mock.calls[0][0].signal.aborted).toBe(true);
        expect(settled).toBe(false);
        open.resolve();
        await closing.promise;
        expect(settled).toBe(false);
        expect(txid.inspect).not.toHaveBeenCalled();
        expect(mockVerify).not.toHaveBeenCalled();
      } finally {
        open.resolve();
        close.resolve();
      }
      expect((await pending).status).toBe('refused');
      expect(scope.signal.aborted).toBe(false);
    }
  );
  test('source canonical age includes completion cleanup and expires during a fresh tail', async () => {
    jest.useFakeTimers();
    mockPoiTransactCapture.mockImplementation(async () => {
      mockSourceAt = performance.now();
      await jest.advanceTimersByTimeAsync(50000);
      return { ...mockSource, status: 'captured' };
    });
    txid.witnessNote.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(10000);
      return { noteWitness: copy(creatorNoteWitness) };
    });
    expect((await poiTransact(options)).status).toBe('refused');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockRootCreate).not.toHaveBeenCalled();
  });
  test('preserves a late authenticated source failure even after caller cancellation', async () => {
    const entered = deferredGate(),
      gate = deferredGate();
    const sourceOutcome = Object.freeze({ fatal: true, reason: 'fatal', rpcFailure: 'response' });
    mockPoiTransactCapture.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { status: 'refused', stage: 'snapshot', sourceOutcome };
    });
    const pending = poiTransact(options);
    await entered.promise;
    caller.abort();
    gate.resolve();
    expect(await pending).toMatchObject({ status: 'refused', sourceOutcome });
    expect(mockOpen).not.toHaveBeenCalled();
  });
  test.each(['archive', 'anchor', 'capsule', 'projection'])(
    'refuses final strict capture %s drift',
    async (fault) => {
      if (fault === 'archive') latest.capture.record.archivedAt = 123;
      if (fault === 'anchor') {
        first.capture.record.archivedAt = latest.capture.record.archivedAt = 123;
        first.capture.record.finalized = { blockNumber: 5944712, blockHash: prefixed(5944712) };
        latest.capture.record.finalized = { blockNumber: 5944713, blockHash: prefixed(5944713) };
      }
      if (fault === 'capsule') latest.capture.capsuleDigest = '9'.repeat(64);
      if (fault === 'projection') latest.capture.projection.blockNumber++;
      expect((await poiTransact(options)).status).toBe('refused');
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockRoots.close).toHaveBeenCalled();
    }
  );
  test('does not renew the original total budget while reserving source and tail', async () => {
    jest.useFakeTimers();
    mockSelectorCapture.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(20000);
      return first;
    });
    const result = await poiTransact({ ...options, timeoutMs: 100000 });
    expect(result.status).toBe('captured');
    expect(mockPoiTransactCapture.mock.calls[0][0].timeoutMs).toBe(80000);
    expect(mockVerify.mock.calls[0][0].timeoutMs).toBe(10000);
    expect(mockVerifyCreator.mock.calls[0][0].timeoutMs).toBe(10000);
    expect(mockCapture.mock.calls[0][0].timeoutMs).toBe(10000);
  });
  test('reserves later tail stages from the same deadline after slow earlier stages', async () => {
    jest.useFakeTimers();
    mockOpen.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(19000);
      return txid;
    });
    const own = mockVerify.getMockImplementation(),
      creator = mockVerifyCreator.getMockImplementation();
    mockVerify.mockImplementation(async (...args) => {
      await jest.advanceTimersByTimeAsync(9000);
      return own(...args);
    });
    mockVerifyCreator.mockImplementation(async (...args) => {
      await jest.advanceTimersByTimeAsync(9000);
      return creator(...args);
    });
    mockRoots.acquire.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(9000);
      return {};
    });
    expect((await poiTransact(options)).status).toBe('captured');
    expect(mockCapture.mock.calls[0][0].timeoutMs).toBe(7000);
  });
});

describe('Transact membership final admission and cleanup', () => {
  beforeEach(async () => {
    await setupTransact();
  });
  test.each(['own', 'creator'])(
    'the %s verifier timeout revokes but retains its phase through exit',
    async (which) => {
      jest.useFakeTimers();
      const gate = deferredGate(),
        entered = deferredGate();
      const verify = which === 'own' ? mockVerify : mockVerifyCreator;
      const original = verify.getMockImplementation();
      verify.mockImplementation(async (...args) => {
        entered.resolve();
        await gate.promise;
        return original(...args);
      });
      let settled = false;
      const pending = poiTransact(options).then((value) => {
        settled = true;
        return value;
      });
      await entered.promise;
      try {
        await jest.advanceTimersByTimeAsync(10000);
        expect(verify.mock.calls[0][0].signal.aborted).toBe(true);
        expect(settled).toBe(false);
        expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
        expect(mockRootCreate).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
      }
      expect((await pending).status).toBe('refused');
      const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
      phase.release();
      expect(scope.signal.aborted).toBe(false);
    }
  );
  test('root timeout drains acquisition and refuses any recapture or result', async () => {
    jest.useFakeTimers();
    const entered = deferredGate(),
      gate = deferredGate();
    mockRoots.acquire.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return {};
    });
    let settled = false;
    const pending = poiTransact(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await jest.advanceTimersByTimeAsync(10000);
      expect(settled).toBe(false);
      expect(mockCapture).not.toHaveBeenCalled();
      expect(mockRoots.close).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe('refused');
    expect(mockRoots.close).toHaveBeenCalledTimes(1);
    expect(mockSource.close).toHaveBeenCalledTimes(1);
  });
  test('mirror closing remains covered by the mirror deadline and fully drains', async () => {
    jest.useFakeTimers();
    const entered = deferredGate(),
      gate = deferredGate();
    txid.close.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    let settled = false;
    const pending = poiTransact(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await jest.advanceTimersByTimeAsync(20000);
      expect(mockOpen.mock.calls[0][0].signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(mockVerify).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe('refused');
    expect(scope.signal.aborted).toBe(false);
  });
  test.each([false, true])(
    'a stable archived capture requires its exact actually checked anchor, checked=%s',
    async (checked) => {
      const archive = { blockNumber: 5944712, blockHash: prefixed(5944712) };
      for (const capture of [first.capture, latest.capture]) {
        capture.record.archivedAt = 123;
        capture.record.finalized = { ...archive };
      }
      const observe = mockObserve.getMockImplementation();
      mockObserve.mockImplementation(async (...args) => {
        const result = await observe(...args);
        result.observation.capturedRepresentation = 'archived';
        result.observation.anchorsActuallyChecked = checked
          ? [{ kind: 'archive', number: archive.blockNumber, hash: archive.blockHash }]
          : [];
        return result;
      });
      const result = await poiTransact(options);
      expect(result.status).toBe(checked ? 'captured' : 'refused');
      if (checked) expect(result.observations.archiveAnchorChecked).toBe(true);
    }
  );
  test.each(['source', 'own', 'creator', 'root', 'recapture'])(
    'exact destination replacement at %s cannot be blessed by later success',
    async (at) => {
      const boundary = {
        source: mockPoiTransactCapture,
        own: mockVerify,
        creator: mockVerifyCreator,
        root: mockRoots.acquire,
        recapture: mockCapture,
      }[at];
      const original = boundary.getMockImplementation();
      boundary.mockImplementation(async (...args) => {
        const result = await original(...args);
        mockDestination = Object.freeze({});
        return result;
      });
      expect((await poiTransact(options)).status).toBe('refused');
      if (at === 'source') expect(mockOpen).not.toHaveBeenCalled();
      if (['source', 'own', 'creator'].includes(at)) expect(mockRootCreate).not.toHaveBeenCalled();
      if (at !== 'recapture') expect(mockCapture).not.toHaveBeenCalled();
    }
  );
});

describe('direct historical Transact selector input producer', () => {
  beforeEach(async () => {
    await setupTransact();
  });
  test('returns detached historical facts only after normal source/root closure', async () => {
    const result = await transactInput(options);
    expect(result.status).toBe('captured');
    expect(mockSource.close).toHaveBeenCalledTimes(1);
    expect(mockRoots.close).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(result.capture.capsule)).toBe(true);
    expect(result.creatorProvenance.noteWitness).toEqual(creatorNoteWitness);
    expect(result.sourceAuthenticated).toBe(false);
    expect(result.currentFinalityVerified).toBe(false);
    expect(result.disclosureEnabled).toBe(false);
    expect(scope.signal.aborted).toBe(false);
  });
  test.each(['caller', 'owner', 'generation', 'destination', 'expiry', 'throw'])(
    'refuses %s occurring in final source cleanup after core success',
    async (kind) => {
      if (kind === 'expiry') jest.useFakeTimers();
      const original = mockSource.close.getMockImplementation();
      mockSource.close.mockImplementation(() => {
        original?.();
        if (kind === 'caller') caller.abort();
        if (kind === 'owner') scope.close();
        if (kind === 'generation')
          mockPublicIdentity = { ...mockPublicIdentity, generationId: '9'.repeat(64) };
        if (kind === 'destination') mockDestination = Object.freeze({});
        if (kind === 'expiry') jest.advanceTimersByTime(300000);
        if (kind === 'throw') throw Error('PRIVATE cleanup');
      });
      const result = await transactInput(options);
      expect(result.status).toBe('refused');
      expect(result.capture).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  );
  test('cancelled pending mirror close drains before historical refusal', async () => {
    const entered = deferredGate(),
      gate = deferredGate();
    txid.close.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    let settled = false;
    const pending = transactInput(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    caller.abort();
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe('refused');
    expect(mockVerify).not.toHaveBeenCalled();
  });
  test('preserves bounded genuine source refusal even if caller revokes afterward', async () => {
    const sourceOutcome = Object.freeze({ fatal: false, reason: 'cancelled', rpcFailure: null });
    mockPoiTransactCapture.mockImplementation(async () => {
      caller.abort();
      return { status: 'refused', stage: 'snapshot', sourceOutcome };
    });
    const result = await transactInput(options);
    expect(result.status).toBe('refused');
    expect(result.sourceOutcome).toBe(sourceOutcome);
  });
  test.each(['completion', 'creator', 'witness', 'sourceDestination', 'observed', 'transport'])(
    'producer accepts no external %s authority',
    async (key) => {
      expect(await transactInput({ ...options, [key]: {} })).toEqual({
        status: 'refused',
        stage: 'context',
      });
      expect(mockSelectorCapture).not.toHaveBeenCalled();
    }
  );
});

test('witness exports fixed historical producer with no claim, registration or adoption surface', () => {
  expect(Object.keys(require('./railgun-own-witness')).sort()).toEqual(
    [
      'captureRailgunOwnTransactPoiMembershipInput',
      'captureRailgunOwnWitness',
      'preflightRailgunOwnPoi',
      'preflightRailgunOwnPoiCompleted',
      'preflightRailgunOwnPoiForSubmission',
      'preflightRailgunOwnTransactPoiMembership',
      'preflightRailgunOwnTransaction',
      'preflightRailgunRetainedPoiCompleted',
      'preflightRailgunRetainedPoiForSubmission',
    ].sort()
  );
});

async function setupRetainedTransact(unshield = false, partialCreator = false) {
  await setupTransact(unshield, partialCreator);
  mockPoiRetainedCapture.mockImplementation(async () => {
    events.push('poi-source-retained');
    mockSourceAt = performance.now();
    return { ...mockSource, status: 'captured' };
  });
}
const retainedTransact = (input = options) =>
  poiRetained({
    ...input,
    sourceDestination: Object.hasOwn(input, 'sourceDestination')
      ? input.sourceDestination
      : mockDestination,
  });
describe.each([
  ['membership', poiTransact, setupTransact],
  ['retained', retainedTransact, setupRetainedTransact],
])('%s preflight with a partial creator', (_name, run, prepare) => {
  beforeEach(async () => {
    await prepare(true, true);
  });
  test.each([false, true])(
    'binds mixed creator and legacy own operation, full-unshield=%s',
    async (unshield) => {
      await prepare(unshield, true);
      const result = await run(options);
      expect(result.status).toBe('captured');
      expect(result.capture.capsule.version).toBe(1);
      expect(result.creatorProvenance.noteWitness.witness.row.commitments).toHaveLength(2);
      expect(result.creatorProvenance.noteWitness.outputIndex).toBe(0);
      expect(result.creatorProvenance.verification.unshieldCommitmentVerified).toBe(true);
      expect(result.creatorProvenance.verification.coverage).toMatchObject({
        matchedRows: 1,
        knownOmissions: 0,
        unshieldCommitmentHashesChecked: false,
      });
      expect(mockVerifyCreator.mock.calls[0][0].state).toEqual(mockVerify.mock.calls[0][0].state);
      expect(mockVerifyCreator.mock.calls[0][0].events.map((event) => event.name)).toEqual([
        'Nullified',
        'Unshield',
        'Transact',
      ]);
      expect(mockVerifyCreator.mock.calls[0][0].noteWitness.witness.index).toBeLessThan(
        mockVerify.mock.calls[0][0].witness.index
      );
      expect(events.indexOf('creator-verify-exited')).toBeLessThan(events.indexOf('root'));
      expect(events.indexOf('txid-drained')).toBeLessThan(events.indexOf('creator-verify-exited'));
      expect(mockRootCreate).toHaveBeenCalledTimes(1);
      expect(result.spendingEnabled).toBe(false);
    }
  );
  test.each([
    'missing-hash-proof',
    'false-hash-proof',
    'unobserved-exit',
    'missing-path',
    'missing-events',
    'extra-row',
    'omission',
  ])('refuses %s before constructing any root client', async (fault) => {
    const original = mockVerifyCreator.getMockImplementation();
    mockVerifyCreator.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (fault === 'missing-hash-proof') delete result.unshieldCommitmentVerified;
      if (fault === 'false-hash-proof') result.unshieldCommitmentVerified = false;
      if (fault === 'unobserved-exit') result.utilityExitObserved = false;
      if (fault === 'missing-path') result.pathVerified = false;
      if (fault === 'missing-events') result.suppliedCreatorEventsMatched = false;
      if (fault === 'extra-row') result.coverage = { ...result.coverage, matchedRows: 2 };
      if (fault === 'omission') result.coverage = { ...result.coverage, knownOmissions: 1 };
      return result;
    });
    expect(await run(options)).toMatchObject({ status: 'refused', stage: 'creator-verify' });
    expect(mockVerifyCreator).toHaveBeenCalledTimes(1);
    expect(mockRootCreate).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
  test('rejects a two-event source with a mixed creator row before either verifier', async () => {
    mockPoiObservation.creator.transaction.events.splice(1, 1);
    expect((await run(options)).status).toBe('refused');
    expect(txid.witnessNote).toHaveBeenCalledTimes(1);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockVerifyCreator).not.toHaveBeenCalled();
    expect(mockRootCreate).not.toHaveBeenCalled();
  });
  test('rejects a changed unshield event against the genuine normalized creator row', async () => {
    mockPoiObservation.creator.transaction.events[1].value = '401';
    // The mock verifies actual event coverage; pinned preimage crypto belongs
    // to note-provenance's native qualification, not this controller unit test.
    expect(await run(options)).toMatchObject({ status: 'refused', stage: 'creator-verify' });
    expect(mockVerifyCreator).toHaveBeenCalledTimes(1);
    expect(mockRootCreate).not.toHaveBeenCalled();
  });
  test.each(['pending', 'missing'])(
    'requires separate maintenance after %s checkpoint refusal',
    async (kind) => {
      const completed = txid.inspect.getMockImplementation();
      txid.inspect.mockImplementation(async () => {
        const value = await completed();
        return kind === 'pending'
          ? { ...value, pending: { progress: 1 } }
          : { ...value, checkpoint: null };
      });
      expect((await run(options)).status).toBe('refused');
      expect(txid.witnessNote).not.toHaveBeenCalled();
      expect(mockVerifyCreator).not.toHaveBeenCalled();
      expect(mockRootCreate).not.toHaveBeenCalled();
      // A separate maintenance owner has completed the mirror. The preflight
      // itself never acquires repair/write authority or retries the old visit.
      txid.inspect.mockImplementation(completed);
      expect((await run(options)).status).toBe('captured');
      expect(mockOpen).toHaveBeenCalledTimes(2);
      expect(mockRootCreate).toHaveBeenCalledTimes(1);
    }
  );
  test('retains phase exclusion until the cancelled mixed verifier actually drains', async () => {
    const entered = deferredGate(),
      gate = deferredGate();
    const original = mockVerifyCreator.getMockImplementation();
    mockVerifyCreator.mockImplementation(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    let settled = false;
    const pending = run(options).then((value) => {
      settled = true;
      return value;
    });
    try {
      await entered.promise;
      caller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(mockVerifyCreator.mock.calls[0][0].signal.aborted).toBe(true);
      expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
      expect(mockRootCreate).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe('refused');
    const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
    phase.release();
    expect(mockRootCreate).not.toHaveBeenCalled();
  });
});
describe('fixed source-first retained Transact preflight', () => {
  beforeEach(async () => {
    await setupRetainedTransact();
  });
  test.each([false, true])(
    'joins both independent paths in one cold mirror, unshield=%s',
    async (unshield) => {
      await setupRetainedTransact(unshield);
      const result = await retainedTransact(options);
      expect(result.status).toBe('captured');
      expect(events).toEqual([
        'capture-selector-exited',
        'receipt',
        'poi-source-retained',
        'txid-open',
        'witness',
        'creator-witness',
        'txid-drained',
        'verify-exited',
        'creator-verify-exited',
        'root',
        'recapture',
      ]);
      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(mockOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          create: false,
          checkpointOnly: true,
          signal: expect.any(AbortSignal),
        })
      );
      expect(txid.inspect).toHaveBeenCalledTimes(2);
      expect(txid.witness).toHaveBeenCalledTimes(1);
      expect(txid.witnessNote).toHaveBeenCalledWith(mockPoiObservation.creator.transaction.note);
      expect(mockObserve).toHaveBeenCalledTimes(1);
      expect(mockPoiCapture).not.toHaveBeenCalled();
      expect(mockPoiCompletedCapture).not.toHaveBeenCalled();
      expect(mockPoiRetainedCapture.mock.calls[0][0].destination).toBe(mockDestination);
      expect(mockVerify.mock.calls[0][0].state).toEqual(mockVerifyCreator.mock.calls[0][0].state);
      expect(mockVerify.mock.calls[0][0].witness.index).toBe(1);
      expect(mockVerifyCreator.mock.calls[0][0].noteWitness.witness.index).toBe(0);
      expect(result.creatorProvenance).toMatchObject({
        note: mockPoiObservation.creator.transaction.note,
        noteWitness: creatorNoteWitness,
        origin: mockPoiObservation.creator.origin,
        logsSha256: 'b'.repeat(64),
        checkpointHash: 'a'.repeat(64),
        txidPolicy: mockPolicy,
        publicIdentity: mockPublicIdentity,
        boundParamsChecked: false,
        globalTxidCompleteness: false,
        disclosureEnabled: false,
        spendingEnabled: false,
      });
      expect(Object.isFrozen(result.creatorProvenance.noteWitness.witness.row)).toBe(true);
      for (const key of [
        'accountAuthenticated',
        'sourceAuthenticated',
        'currentFinalityVerified',
        'txidPathVerified',
        'txidRootAccepted',
        'poiVerified',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        expect(result[key]).toBe(false);
    }
  );
});

describe('retained Transact refusal and lifetime boundaries', () => {
  beforeEach(async () => {
    await setupRetainedTransact();
  });
  test.each(['sourceDestination', 'creator', 'observation', 'transport', 'submission'])(
    'rejects caller-supplied %s before any operation',
    async (key) => {
      expect(await retainedTransact({ ...options, [key]: {} })).toEqual({
        status: 'refused',
        stage: 'context',
      });
      expect(mockSelectorCapture).not.toHaveBeenCalled();
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );
  test.each([0, -1, 180001, 1.5, null, false, Infinity, NaN])(
    'rejects timeout %s before capture',
    async (timeoutMs) => {
      expect((await retainedTransact({ ...options, timeoutMs })).status).toBe('refused');
      expect(mockSelectorCapture).not.toHaveBeenCalled();
    }
  );
  test.each(['Unknown', 'prelaunch', 'note', 'two-inputs', 'two-outputs', 'unshield'])(
    'rejects source creator %s before mirror opening',
    async (fault) => {
      const c = mockPoiObservation.creator;
      if (fault === 'Unknown') c.creator.type = 'Unknown';
      if (fault === 'prelaunch') c.origin.blockNumber = 5944699;
      if (fault === 'note') c.transaction.note.position = 2;
      if (fault === 'two-inputs') c.transaction.events[0].values.push(prefixed(999));
      if (fault === 'two-outputs') c.transaction.events[1].hashes.push(prefixed(999));
      if (fault === 'unshield') c.transaction.events.splice(1, 0, { name: 'Unshield' });
      expect((await retainedTransact(options)).status).toBe('refused');
      expect(mockOpen).not.toHaveBeenCalled();
      expect(mockVerifyCreator).not.toHaveBeenCalled();
      expect(mockRootCreate).not.toHaveBeenCalled();
      expect(mockSource.close).toHaveBeenCalledTimes(1);
    }
  );
  test.each(['index', 'graph-index', 'root', 'checkpoint', 'note', 'two-inputs', 'two-outputs'])(
    'rejects independently malformed creator witness %s before either verifier',
    async (fault) => {
      const c = copy(creatorNoteWitness);
      if (fault === 'index') c.witness.index = witness.index;
      if (fault === 'graph-index')
        c.witness.row.graphID = prefixed(5944701) + prefixed(3).slice(2) + prefixed(0).slice(2);
      if (fault === 'root') c.witness.root = hash('wrong root');
      if (fault === 'checkpoint') c.witness.checkpointIndex = 0;
      if (fault === 'note') c.note.position = 2;
      if (fault === 'two-inputs') c.witness.row.nullifiers.push(prefixed(999));
      if (fault === 'two-outputs') c.witness.row.commitments.push(prefixed(999));
      c.witness.rowSha256 = createHash('sha256')
        .update(JSON.stringify(c.witness.row))
        .digest('hex');
      txid.witnessNote.mockResolvedValue({ noteWitness: c });
      expect((await retainedTransact(options)).status).toBe('refused');
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockVerifyCreator).not.toHaveBeenCalled();
      expect(mockRootCreate).not.toHaveBeenCalled();
      expect(txid.close).toHaveBeenCalled();
    }
  );
  test.each(['own', 'creator', 'path', 'exit', 'events', 'omissions', 'bound-params', 'global'])(
    'refuses verification %s before service-root acquisition',
    async (fault) => {
      if (fault === 'own') mockVerify.mockRejectedValue(Error('path failed'));
      else if (fault === 'creator') mockVerifyCreator.mockRejectedValue(Error('path failed'));
      else {
        const valid = mockVerifyCreator.getMockImplementation();
        mockVerifyCreator.mockImplementation(async (...args) => {
          const result = await valid(...args);
          if (fault === 'path') result.pathVerified = false;
          if (fault === 'exit') result.utilityExitObserved = false;
          if (fault === 'events') result.suppliedCreatorEventsMatched = false;
          if (fault === 'omissions') result.coverage.knownOmissions = 1;
          if (fault === 'bound-params') result.coverage.boundParamsChecked = true;
          if (fault === 'global') result.coverage.globalTxidCompleteness = true;
          return result;
        });
      }
      expect((await retainedTransact(options)).status).toBe('refused');
      expect(mockRootCreate).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
      const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
      phase.release();
    }
  );
  test.each(['destination', 'generation', 'policy'])(
    'rejects %s replacement after source without silently reopening it',
    async (fault) => {
      const original = txid.witnessNote.getMockImplementation();
      txid.witnessNote.mockImplementation(async (...args) => {
        const result = await original(...args);
        if (fault === 'destination') mockDestination = Object.freeze({});
        if (fault === 'generation')
          mockPublicIdentity = { ...mockPublicIdentity, generationId: '9'.repeat(64) };
        if (fault === 'policy') txid.policy = 'replacement-policy';
        return result;
      });
      // A session's policy is checked on opening. Change the actual policy before
      // open, rather than emulating a mutable policy on an already-frozen session.
      if (fault === 'policy')
        mockOpen.mockImplementation(async () => ({ ...txid, policy: 'replacement-policy' }));
      expect((await retainedTransact(options)).status).toBe('refused');
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockRootCreate).not.toHaveBeenCalled();
      expect(mockPoiRetainedCapture).toHaveBeenCalledTimes(1);
    }
  );
  test('detaches the first mirror checkpoint before borrowed reads can mutate it', async () => {
    const mutable = { checkpoint: { state: copy(state) }, pending: null, capacityReached: false };
    txid.inspect.mockResolvedValue(mutable);
    txid.witnessNote.mockImplementation(async () => {
      mutable.checkpoint.state.transcript = '9'.repeat(64);
      return { noteWitness: copy(creatorNoteWitness) };
    });
    expect((await retainedTransact(options)).status).toBe('refused');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(txid.close).toHaveBeenCalled();
  });
  test.each(['own', 'creator'])(
    'holds the actual recovery phase until cancelled %s verifier exits',
    async (which) => {
      const entered = deferredGate(),
        gate = deferredGate();
      const verify = which === 'own' ? mockVerify : mockVerifyCreator;
      const original = verify.getMockImplementation();
      verify.mockImplementation(async (...args) => {
        entered.resolve();
        await gate.promise;
        return original(...args);
      });
      let settled = false;
      const pending = retainedTransact(options).then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      try {
        caller.abort();
        await Promise.resolve();
        expect(verify.mock.calls[0][0].signal.aborted).toBe(true);
        expect(settled).toBe(false);
        expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
        expect(mockRootCreate).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
      }
      expect((await pending).status).toBe('refused');
      const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
      phase.release();
      expect(scope.signal.aborted).toBe(false);
    }
  );
  test.each(['cancel', 'deadline'])(
    'drains late mirror opening and closing after %s before returning',
    async (kind) => {
      jest.useFakeTimers();
      const entered = deferredGate(),
        open = deferredGate(),
        closing = deferredGate(),
        close = deferredGate();
      mockOpen.mockImplementation(async () => {
        entered.resolve();
        await open.promise;
        return txid;
      });
      txid.close.mockImplementation(async () => {
        closing.resolve();
        await close.promise;
      });
      let settled = false;
      const pending = retainedTransact(options).then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      try {
        if (kind === 'cancel') caller.abort();
        else await jest.advanceTimersByTimeAsync(20000);
        expect(mockOpen.mock.calls[0][0].signal.aborted).toBe(true);
        expect(settled).toBe(false);
        open.resolve();
        await closing.promise;
        expect(settled).toBe(false);
        expect(txid.inspect).not.toHaveBeenCalled();
        expect(mockVerify).not.toHaveBeenCalled();
      } finally {
        open.resolve();
        close.resolve();
      }
      expect((await pending).status).toBe('refused');
      expect(scope.signal.aborted).toBe(false);
    }
  );
  test('source canonical age includes completion cleanup and expires during a fresh tail', async () => {
    jest.useFakeTimers();
    mockPoiRetainedCapture.mockImplementation(async () => {
      mockSourceAt = performance.now();
      await jest.advanceTimersByTimeAsync(50000);
      return { ...mockSource, status: 'captured' };
    });
    txid.witnessNote.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(10000);
      return { noteWitness: copy(creatorNoteWitness) };
    });
    expect((await retainedTransact(options)).status).toBe('refused');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockRootCreate).not.toHaveBeenCalled();
  });
  test('preserves a late authenticated source failure even after caller cancellation', async () => {
    const entered = deferredGate(),
      gate = deferredGate();
    const sourceOutcome = Object.freeze({ fatal: true, reason: 'fatal', rpcFailure: 'response' });
    mockPoiRetainedCapture.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { status: 'refused', stage: 'snapshot', sourceOutcome };
    });
    const pending = retainedTransact(options);
    await entered.promise;
    caller.abort();
    gate.resolve();
    expect(await pending).toMatchObject({ status: 'refused', sourceOutcome });
    expect(mockOpen).not.toHaveBeenCalled();
  });
  test.each(['archive', 'anchor', 'capsule', 'projection'])(
    'refuses final strict capture %s drift',
    async (fault) => {
      if (fault === 'archive') latest.capture.record.archivedAt = 123;
      if (fault === 'anchor') {
        first.capture.record.archivedAt = latest.capture.record.archivedAt = 123;
        first.capture.record.finalized = { blockNumber: 5944712, blockHash: prefixed(5944712) };
        latest.capture.record.finalized = { blockNumber: 5944713, blockHash: prefixed(5944713) };
      }
      if (fault === 'capsule') latest.capture.capsuleDigest = '9'.repeat(64);
      if (fault === 'projection') latest.capture.projection.blockNumber++;
      expect((await retainedTransact(options)).status).toBe('refused');
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockRoots.close).toHaveBeenCalled();
    }
  );
  test('does not renew the original total budget while reserving source and tail', async () => {
    jest.useFakeTimers();
    mockSelectorCapture.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(20000);
      return first;
    });
    const result = await retainedTransact({ ...options, timeoutMs: 100000 });
    expect(result.status).toBe('captured');
    expect(mockPoiRetainedCapture.mock.calls[0][0].timeoutMs).toBe(80000);
    expect(mockVerify.mock.calls[0][0].timeoutMs).toBe(10000);
    expect(mockVerifyCreator.mock.calls[0][0].timeoutMs).toBe(10000);
    expect(mockCapture.mock.calls[0][0].timeoutMs).toBe(10000);
  });
  test('reserves later tail stages from the same deadline after slow earlier stages', async () => {
    jest.useFakeTimers();
    mockOpen.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(19000);
      return txid;
    });
    const own = mockVerify.getMockImplementation(),
      creator = mockVerifyCreator.getMockImplementation();
    mockVerify.mockImplementation(async (...args) => {
      await jest.advanceTimersByTimeAsync(9000);
      return own(...args);
    });
    mockVerifyCreator.mockImplementation(async (...args) => {
      await jest.advanceTimersByTimeAsync(9000);
      return creator(...args);
    });
    mockRoots.acquire.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(9000);
      return {};
    });
    expect((await retainedTransact(options)).status).toBe('captured');
    expect(mockCapture.mock.calls[0][0].timeoutMs).toBe(7000);
  });
});

describe('retained Transact final admission and cleanup', () => {
  beforeEach(async () => {
    await setupRetainedTransact();
  });
  test.each(['own', 'creator'])(
    'the %s verifier timeout revokes but retains its phase through exit',
    async (which) => {
      jest.useFakeTimers();
      const gate = deferredGate(),
        entered = deferredGate();
      const verify = which === 'own' ? mockVerify : mockVerifyCreator;
      const original = verify.getMockImplementation();
      verify.mockImplementation(async (...args) => {
        entered.resolve();
        await gate.promise;
        return original(...args);
      });
      let settled = false;
      const pending = retainedTransact(options).then((value) => {
        settled = true;
        return value;
      });
      await entered.promise;
      try {
        await jest.advanceTimersByTimeAsync(10000);
        expect(verify.mock.calls[0][0].signal.aborted).toBe(true);
        expect(settled).toBe(false);
        expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
        expect(mockRootCreate).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
      }
      expect((await pending).status).toBe('refused');
      const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
      phase.release();
      expect(scope.signal.aborted).toBe(false);
    }
  );
  test('root timeout drains acquisition and refuses any recapture or result', async () => {
    jest.useFakeTimers();
    const entered = deferredGate(),
      gate = deferredGate();
    mockRoots.acquire.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return {};
    });
    let settled = false;
    const pending = retainedTransact(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await jest.advanceTimersByTimeAsync(10000);
      expect(settled).toBe(false);
      expect(mockCapture).not.toHaveBeenCalled();
      expect(mockRoots.close).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe('refused');
    expect(mockRoots.close).toHaveBeenCalledTimes(1);
    expect(mockSource.close).toHaveBeenCalledTimes(1);
  });
  test('mirror closing remains covered by the mirror deadline and fully drains', async () => {
    jest.useFakeTimers();
    const entered = deferredGate(),
      gate = deferredGate();
    txid.close.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    let settled = false;
    const pending = retainedTransact(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await jest.advanceTimersByTimeAsync(20000);
      expect(mockOpen.mock.calls[0][0].signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(mockVerify).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe('refused');
    expect(scope.signal.aborted).toBe(false);
  });
  test.each([false, true])(
    'a stable archived capture requires its exact actually checked anchor, checked=%s',
    async (checked) => {
      const archive = { blockNumber: 5944712, blockHash: prefixed(5944712) };
      for (const capture of [first.capture, latest.capture]) {
        capture.record.archivedAt = 123;
        capture.record.finalized = { ...archive };
      }
      const observe = mockObserve.getMockImplementation();
      mockObserve.mockImplementation(async (...args) => {
        const result = await observe(...args);
        result.observation.capturedRepresentation = 'archived';
        result.observation.anchorsActuallyChecked = checked
          ? [{ kind: 'archive', number: archive.blockNumber, hash: archive.blockHash }]
          : [];
        return result;
      });
      const result = await retainedTransact(options);
      expect(result.status).toBe(checked ? 'captured' : 'refused');
      if (checked) expect(result.observations.archiveAnchorChecked).toBe(true);
    }
  );
  test.each(['source', 'own', 'creator', 'root', 'recapture'])(
    'exact destination replacement at %s cannot be blessed by later success',
    async (at) => {
      const boundary = {
        source: mockPoiRetainedCapture,
        own: mockVerify,
        creator: mockVerifyCreator,
        root: mockRoots.acquire,
        recapture: mockCapture,
      }[at];
      const original = boundary.getMockImplementation();
      boundary.mockImplementation(async (...args) => {
        const result = await original(...args);
        mockDestination = Object.freeze({});
        return result;
      });
      expect((await retainedTransact(options)).status).toBe('refused');
      if (at === 'source') expect(mockOpen).not.toHaveBeenCalled();
      if (['source', 'own', 'creator'].includes(at)) expect(mockRootCreate).not.toHaveBeenCalled();
      if (at !== 'recapture') expect(mockCapture).not.toHaveBeenCalled();
    }
  );
});

async function setupRetainedShield(unshield = false) {
  await setup(unshield);
  txid.witnessNote = jest.fn(() => {
    throw Error('unexpected Shield creator witness');
  });
  mockPoiRetainedCapture.mockImplementation(async () => {
    events.push('poi-source-retained');
    mockSourceAt = performance.now();
    return { ...mockSource, status: 'captured' };
  });
}
describe('retained source-derived Shield branch', () => {
  beforeEach(async () => setupRetainedShield());
  test.each([false, true])(
    'Shield unshield=%s uses source first and no creator witness/verification',
    async (unshield) => {
      await setupRetainedShield(unshield);
      const result = await retainedTransact();
      expect(result.status).toBe('captured');
      expect(result.creatorClassification.type).toBe('Shield');
      expect(result).not.toHaveProperty('creatorProvenance');
      expect(events).toEqual([
        'capture-selector-exited',
        'receipt',
        'poi-source-retained',
        'txid-open',
        'witness',
        'txid-drained',
        'verify-exited',
        'root',
        'recapture',
      ]);
      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(txid.inspect).toHaveBeenCalledTimes(2);
      expect(txid.witnessNote).not.toHaveBeenCalled();
      expect(mockVerifyCreator).not.toHaveBeenCalled();
      expect(mockPoiTransactCapture).not.toHaveBeenCalled();
      expect(mockPoiCompletedCapture).not.toHaveBeenCalled();
      expect(
        require('./railgun-account-public').getRailgunAccountPublicDestination
      ).not.toHaveBeenCalled();
    }
  );
  test('legacy POI preflight preserves mirror-before-source order', async () => {
    expect((await poiPreflight(options)).status).toBe('captured');
    expect(events.indexOf('txid-open')).toBeLessThan(events.indexOf('poi-source'));
    expect(events.indexOf('verify-exited')).toBeLessThan(events.indexOf('poi-source'));
    expect(mockPoiRetainedCapture).not.toHaveBeenCalled();
  });
  test.each([undefined, null, {}, false])(
    'missing/copied destination %p refuses without replacement selection',
    async (sourceDestination) => {
      expect(await poiRetained({ ...options, sourceDestination })).toEqual({
        status: 'refused',
        stage: 'context',
      });
      expect(mockSelectorCapture).not.toHaveBeenCalled();
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockPoiRetainedCapture).not.toHaveBeenCalled();
      expect(
        require('./railgun-account-public').getRailgunAccountPublicDestination
      ).not.toHaveBeenCalled();
    }
  );
  test('authenticated source type requires creator work even if record carries misleading type metadata', async () => {
    mockPoiObservation.creator.creator.type = 'Transact';
    first.capture.record.creatorType = 'Shield';
    latest.capture.record.creatorType = 'Shield';
    expect((await retainedTransact()).status).toBe('refused');
    expect(mockOpen).not.toHaveBeenCalled();
  });
  test('Shield source allowance reserves55s from original180s after earlier work', async () => {
    jest.useFakeTimers();
    mockSelectorCapture.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(20000);
      return first;
    });
    const result = await retainedTransact();
    expect(result.status).toBe('captured');
    // Capture's scope includes the tail; its completed snapshot gets105s at most.
    expect(mockPoiRetainedCapture.mock.calls[0][0].timeoutMs).toBe(160000);
    expect(mockVerify.mock.calls[0][0].timeoutMs).toBe(10000);
    expect(mockVerifyCreator).not.toHaveBeenCalled();
  });
  test.each(['archive', 'anchor'])(
    'Shield strict final capture rejects %s drift',
    async (fault) => {
      if (fault === 'archive') latest.capture.record.archivedAt = 123;
      else {
        for (const c of [first.capture, latest.capture]) c.record.archivedAt = 123;
        first.capture.record.finalized = { blockNumber: 5944712, blockHash: prefixed(5944712) };
        latest.capture.record.finalized = { blockNumber: 5944713, blockHash: prefixed(5944713) };
      }
      expect((await retainedTransact()).status).toBe('refused');
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockSource.close).toHaveBeenCalledTimes(1);
    }
  );
  test.each(['generation', 'destination', 'deadline'])(
    'outer completion rejects %s drift during source cleanup',
    async (fault) => {
      if (fault === 'deadline') jest.useFakeTimers();
      mockSource.close.mockImplementation(() => {
        if (fault === 'generation')
          mockPublicIdentity = { ...mockPublicIdentity, generationId: '9'.repeat(64) };
        if (fault === 'destination') mockDestination = Object.freeze({});
        if (fault === 'deadline') jest.spyOn(performance, 'now').mockReturnValue(180000);
      });
      try {
        expect(await retainedTransact()).toEqual({ status: 'refused', stage: 'completion' });
      } finally {
        jest.restoreAllMocks();
      }
    }
  );
});

describe.each(['Shield', 'Transact'])('fixed retained %s submission handoff', (type) => {
  let handoff;
  async function prepare(unshield = false) {
    if (type === 'Shield') await setupRetainedShield(unshield);
    else await setupRetainedTransact(unshield);
    handoff = {
      entry: {
        selector: copy(options.selector),
        capsuleDigest: first.capture.capsuleDigest,
        bindingDigest: first.capture.bindingDigest,
      },
      capture: copy(first.capture),
      observation: {
        transaction: copy(fixture.transaction),
        receipt: copy(fixture.receipt),
        captureBindingDigest: first.capture.bindingDigest,
        capturedRepresentation: 'active',
        anchorsActuallyChecked: [],
      },
    };
  }
  const submit = (input = handoff) =>
    poiRetainedSubmission({ ...options, sourceDestination: mockDestination }, input);
  beforeEach(async () => prepare());
  test.each([false, true])(
    'one supplied receipt suffices for unshield=%s without fallback',
    async (unshield) => {
      await prepare(unshield);
      const result = await submit();
      expect(result.status).toBe('captured');
      expect(result.creatorClassification.type).toBe(type);
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockPoiRetainedCapture).toHaveBeenCalledTimes(1);
      expect(mockPoiCompletedCapture).not.toHaveBeenCalled();
      expect(mockPoiTransactCapture).not.toHaveBeenCalled();
      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockVerifyCreator).toHaveBeenCalledTimes(type === 'Shield' ? 0 : 1);
      expect(mockVerify.mock.calls[0][0].evidence).toMatchObject({
        transaction: handoff.observation.transaction,
        receipt: handoff.observation.receipt,
      });
      expect(events.indexOf('poi-source-retained')).toBeLessThan(events.indexOf('txid-open'));
      expect(
        require('./railgun-account-public').getRailgunAccountPublicDestination
      ).not.toHaveBeenCalled();
    }
  );
  test.each([undefined, null, false, {}])(
    'missing handoff %p refuses with zero receipt/selector/mirror work',
    async (input) => {
      expect(
        (await poiRetainedSubmission({ ...options, sourceDestination: mockDestination }, input))
          .status
      ).toBe('refused');
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockSelectorCapture).not.toHaveBeenCalled();
      expect(mockPoiRetainedCapture).not.toHaveBeenCalled();
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );
  test.each(['selector', 'capsule', 'binding', 'extra'])(
    'malformed handoff %s refuses before capture',
    async (fault) => {
      if (fault === 'selector') handoff.entry.selector.position++;
      if (fault === 'capsule') handoff.entry.capsuleDigest = '9'.repeat(64);
      if (fault === 'binding') handoff.entry.bindingDigest = '9'.repeat(64);
      if (fault === 'extra') handoff.authorized = true;
      expect(await submit()).toEqual({ status: 'refused', stage: 'context' });
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockSelectorCapture).not.toHaveBeenCalled();
    }
  );
  test.each(['capture', 'digest', 'transaction', 'receipt'])(
    'supplied observation %s is joined before source/mirror admission',
    async (fault) => {
      if (fault === 'capture') first.capture.facts.changed = true;
      if (fault === 'digest') handoff.observation.captureBindingDigest = '9'.repeat(64);
      if (fault === 'transaction') handoff.observation.transaction.hash = prefixed(999);
      if (fault === 'receipt') handoff.observation.receipt.transactionHash = prefixed(999);
      expect((await submit()).status).toBe('refused');
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockPoiRetainedCapture).not.toHaveBeenCalled();
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );
  test('ordinary retained wrapper ignores positional diagnostic and still observes itself', async () => {
    expect(
      (await poiRetained({ ...options, sourceDestination: mockDestination }, handoff)).status
    ).toBe('captured');
    expect(mockObserve).toHaveBeenCalledTimes(1);
  });
  test.each([false, true])(
    'late sourceOutcome fatal=%s survives aborted caller after borrowed work drains',
    async (fatal) => {
      const entered = deferredGate(),
        gate = deferredGate();
      const sourceOutcome = Object.freeze({
        fatal,
        reason: fatal ? 'fatal' : 'cancelled',
        rpcFailure: fatal ? 'response' : null,
      });
      mockPoiRetainedCapture.mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
        return { status: 'refused', stage: 'snapshot', sourceOutcome };
      });
      let settled = false;
      const pending = submit().then((value) => {
        settled = true;
        return value;
      });
      await entered.promise;
      try {
        caller.abort();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(mockOpen).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
      }
      expect(await pending).toMatchObject({ status: 'refused', sourceOutcome });
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
    }
  );
});

test.each([
  ['witness', capture, false, false],
  ['transaction-preflight', preflight, false, false],
  ['poi-preflight', poiPreflight, false, false],
  ['completed-poi', poiCompleted, true, false],
  ['submission-poi', poiSubmission, true, true],
  ['transact-membership', poiTransact, false, false],
  ['transact-input', transactInput, false, false],
  ['retained-completed', poiRetained, true, false],
  ['retained-submission', poiRetainedSubmission, true, true],
])(
  '%s refuses a downgraded partial before receipt/source/TXID/root work',
  async (_name, run, destination, submission) => {
    const partial =
      require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial({
        recipient: '0x' + '34'.repeat(20),
      });
    partial.capsule.version = 1;
    first.capture = {
      ...first.capture,
      capsule: partial.capsule,
      intent: partial.record.intent,
      record: partial.record,
      projection: projectRailgunOwnRecord(partial.record),
      provedTransaction: {
        chainId: 11155111,
        to: partial.transaction.to,
        value: '0',
        data: partial.transaction.input,
      },
    };
    const handoff = submission
      ? {
          entry: {
            selector: copy(options.selector),
            capsuleDigest: first.capture.capsuleDigest,
            bindingDigest: first.capture.bindingDigest,
          },
          capture: copy(first.capture),
          observation: {
            transaction: partial.transaction,
            receipt: partial.receipt,
            captureBindingDigest: first.capture.bindingDigest,
          },
        }
      : undefined;
    expect(
      await run(
        { ...options, ...(destination ? { sourceDestination: mockDestination } : {}) },
        handoff
      )
    ).toEqual({ status: 'refused', stage: 'capture' });
    expect(mockSelectorCapture).toHaveBeenCalledTimes(1);
    expect(mockObserve).not.toHaveBeenCalled();
    for (const source of [
      mockSourceCapture,
      mockPoiCapture,
      mockPoiCompletedCapture,
      mockPoiTransactCapture,
      mockPoiRetainedCapture,
    ])
      expect(source).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockVerifyCreator).not.toHaveBeenCalled();
    expect(mockRootCreate).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(events).toEqual(['capture-selector-exited']);
    const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
    phase.release();
  }
);
test.each(['partial-v1', 'legacy-v2', 'unknown-kind'])(
  'witness rejects %s immediately after capture',
  async (mode) => {
    if (mode === 'partial-v1') first.capture.capsule.selection.kind = 'railgun-partial-unshield';
    if (mode === 'legacy-v2') first.capture.capsule.version = 2;
    if (mode === 'unknown-kind') first.capture.capsule.selection.kind = 'unknown';
    expect(await preflight(options)).toEqual({ status: 'refused', stage: 'capture' });
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockRootCreate).not.toHaveBeenCalled();
  }
);

// Real structural capsules/journal projections and locally built TXID paths;
// source, root acceptance and exited utility verification remain mocked.
describe('partial own-POI producer row binding', () => {
  test.each(['Shield', 'Transact'])(
    '%s partial producer retains both commitments and U while C has ordinary coordinates',
    async (type) => {
      if (type === 'Transact') await setupTransact('partial');
      else await setup('partial');
      const result = await (type === 'Transact' ? transactInput : poiPreflight)(options);
      expect(result.status).toBe('captured');
      expect(result.capture.capsule.version).toBe(2);
      expect(result.poiPreparation.ownEvidence.row.commitments).toEqual([
        fixture.capsule.preparation.expected.changeCommitment,
        fixture.capsule.preparation.expected.unshieldCommitment,
      ]);
      expect(result.witness.row.unshield.value).toBe('400');
      expect(result.witness.row.utxoTreeOut).toBe(1);
      expect(result.witness.row.utxoBatchStartPositionOut).toBe(123);
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(events.indexOf('txid-drained')).toBeLessThan(events.indexOf('verify-exited'));
      if (type === 'Transact') {
        expect(mockVerifyCreator).toHaveBeenCalledTimes(1);
        expect(result.creatorProvenance.noteWitness.witness.index).toBeLessThan(
          result.witness.index
        );
      }
      expect(result.spendingEnabled).toBe(false);
      expect(result.poiVerified).toBe(false);
    }
  );
  test.each([
    'order',
    'input-as-unshield',
    'change-as-unshield',
    'recipient',
    'token',
    'foreign-tree',
    'foreign-position',
  ])('partial independently normalized path with %s refuses the final row join', async (fault) => {
    await setup('partial', (row) => {
      if (fault === 'order') row.commitments.reverse();
      if (fault === 'input-as-unshield') row.unshield.value = '1000';
      if (fault === 'change-as-unshield') row.unshield.value = '600';
      if (fault === 'recipient') row.unshield.toAddress = '0x' + '56'.repeat(20);
      if (fault === 'token') row.unshield.tokenData.tokenAddress = '0x' + '56'.repeat(20);
      if (fault === 'foreign-tree') row.utxoTreeOut = 2;
      if (fault === 'foreign-position') row.utxoBatchStartPositionOut = 124;
    });
    // The coherent current mirror/path is admissible independently. The
    // mismatch is specifically against the authenticated own projection.
    expect(() =>
      require('./railgun-txid-note-witness').normalizeRailgunTxidWitness(witness, state)
    ).not.toThrow();
    expect(await poiPreflight(options)).toEqual({
      status: 'refused',
      stage: 'row',
    });
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
  test.each(['input', 'change', 'unshield'])(
    'partial private %s amount inconsistency refuses before receipt or utility',
    async (field) => {
      await setup('partial');
      const preparation = first.capture.capsule.preparation;
      preparation[field + 'Amount'] = String(BigInt(preparation[field + 'Amount']) + 1n);
      latest.capture = copy(first.capture);
      expect(await poiPreflight(options)).toEqual({
        status: 'refused',
        stage: 'capture',
      });
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockOpen).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
    }
  );
  test('partial unshield verifier refusal cannot reach root or final recapture', async () => {
    await setup('partial');
    mockVerify.mockRejectedValueOnce(Error('wrong final unshield preimage'));
    expect(await poiPreflight(options)).toEqual({
      status: 'refused',
      stage: 'txid-verify',
    });
    expect(mockRootCreate).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
    phase.release();
  });
});
