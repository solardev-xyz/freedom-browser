let mockStaged, mockWindow, mockCreator, mockClaim, mockRoots, mockVerified;
const mockServices = jest.fn(),
  mockCapture = jest.fn(),
  mockVerify = jest.fn(),
  mockRootFactory = jest.fn();
jest.mock('./railgun-transact-staging', () => ({
  claimRailgunTransactStaging: jest.fn(() => mockClaim),
}));
jest.mock('./railgun-account-wallet', () => ({
  assertRailgunAccountPrivateWindow: jest.fn(() => mockWindow),
  readRailgunAccountPrivateCreator: (...args) => mockCapture(...args),
  assertRailgunAccountPrivateCreator: jest.fn(() => mockCreator),
}));
jest.mock('./railgun-note-provenance', () => ({
  verifyRailgunNoteProvenance: (...args) => mockVerify(...args),
}));
jest.mock('./railgun-public-services', () => ({
  createRailgunPublicServices: (...args) => mockServices(...args),
}));
jest.mock('./railgun-txid-root', () => ({
  createRailgunTxidRootSource: (...args) => mockRootFactory(...args),
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  openRailgunTransactProvenance,
  assertRailgunTransactProvenance,
} = require('./railgun-transact-provenance');
let scope, caller, options, operations;
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
beforeEach(() => {
  jest.clearAllMocks();
  caller = new AbortController();
  scope = createPrivacyScope({ profileId: 'transact-provenance-test', signal: caller.signal });
  const signal = scope.signal;
  const enrollment = {
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'fixture',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      }),
  };
  options = {
    stagingReceipt: {},
    account: { signal },
    window: {},
    request: {},
    signal,
    owners: { enrollment, identity: {}, coordinator: {} },
  };
  mockWindow = { signal, deadline: performance.now() + 175000 };
  mockStaged = {
    bindings: { archive: '/pinned-engine.asar' },
    state: { count: 1, root: '1'.repeat(64) },
    baseline: {
      checkpointHash: '2'.repeat(64),
      owned: { txid: hex(40), hash: hex(20), blockNumber: 30 },
      selection: { tree: 0, position: 2 },
    },
    noteWitness: {
      witness: {
        row: { graphID: hex(30) + '0'.repeat(128), blockNumber: 30, txid: hex(40).slice(2) },
      },
    },
  };
  mockClaim = { signal, assertCurrent: jest.fn(() => mockStaged) };
  mockCreator = {
    eventSourceAuthenticated: true,
    checkpointHash: '2'.repeat(64),
    transactionDigest: '0x' + '3'.repeat(64),
    creator: { transactionIndex: 0, blockNumber: 30, transactionHash: hex(40), blockHash: hex(31) },
    note: { type: 'Transact', txid: hex(40), hash: hex(20), tree: 0, position: 2, blockNumber: 30 },
    events: [],
    source: { ledgerSha256: '4'.repeat(64) },
    logsSha256: '5'.repeat(64),
  };
  mockCapture.mockResolvedValue({ receipt: {} });
  mockVerified = {
    pathVerified: true,
    suppliedCreatorEventsMatched: true,
    utilityExitObserved: true,
    inputSha256: '6'.repeat(64),
    coverage: { boundParamsChecked: false, globalTxidCompleteness: false },
  };
  mockVerify.mockImplementation(async () => mockVerified);
  const rootValue = Object.freeze({ root: '1'.repeat(64), accepted: true });
  mockRoots = {
    acquire: jest.fn(async () => ({})),
    close: jest.fn(),
    assertRoot: jest.fn(() => rootValue),
  };
  mockRootFactory.mockImplementation(() => mockRoots);
  operations = [];
});
afterEach(async () => {
  await Promise.all(operations.map((op) => op.close()));
  caller.abort();
  scope.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
async function open(extra = {}) {
  const op = await openRailgunTransactProvenance({ ...options, ...extra });
  operations.push(op);
  return op;
}
const check = (op, receipt, margin = 0) =>
  assertRailgunTransactProvenance(
    op,
    receipt,
    options.account,
    options.owners,
    options.window,
    margin
  );
test('claims exact staging, verifies creator/path before opening a fixed root source, and binds receipt', async () => {
  const op = await open();
  expect(mockRootFactory).not.toHaveBeenCalled();
  expect(mockVerify).toHaveBeenCalledWith(
    expect.objectContaining({
      archive: '/pinned-engine.asar',
      state: mockStaged.state,
      note: mockCreator.note,
      noteWitness: mockStaged.noteWitness,
      events: mockCreator.events,
    })
  );
  const acquired = await op.acquireRoot();
  expect(mockRoots.acquire).toHaveBeenCalledWith({ index: 0, root: '1'.repeat(64) });
  expect(getPrivacyContext(mockRootFactory.mock.calls[0][0]).subject).toEqual({
    kind: 'service',
    principal: 'railgun-public-sync',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'public-services',
    operation: null,
  });
  const value = check(op, acquired.receipt, 20000);
  expect(value.transactionDigest).toBe(mockCreator.transactionDigest);
  expect(value.spendingEnabled).toBe(false);
  expect(mockClaim.assertCurrent).toHaveBeenCalledWith(20000);
  expect(mockRoots.assertRoot).toHaveBeenLastCalledWith(
    expect.any(Object),
    { index: 0, root: '1'.repeat(64) },
    20000
  );
  for (const args of [
    [{}, acquired.receipt, options.account, options.owners, options.window],
    [op, {}, options.account, options.owners, options.window],
    [op, acquired.receipt, {}, options.owners, options.window],
    [op, acquired.receipt, options.account, { ...options.owners, identity: {} }, options.window],
    [op, acquired.receipt, options.account, options.owners, {}],
  ])
    expect(() => assertRailgunTransactProvenance(...args)).toThrow();
  await op.close();
  expect(() => check(op, acquired.receipt)).toThrow();
});
test.each([
  'graph-index',
  'oversized-index',
  'block',
  'txid',
  'note',
  'checkpoint',
  'digest',
  'source',
  'path',
  'exit',
  'coverage',
])('changed %s cannot reach root acquisition', async (mode) => {
  if (mode === 'graph-index')
    mockStaged.noteWitness.witness.row.graphID = hex(30) + hex(1).slice(2) + '0'.repeat(64);
  if (mode === 'oversized-index')
    mockStaged.noteWitness.witness.row.graphID = hex(30) + 'f'.repeat(64) + '0'.repeat(64);
  if (mode === 'block') mockCreator.creator.blockNumber++;
  if (mode === 'txid') mockCreator.creator.transactionHash = hex(41);
  if (mode === 'note') mockCreator.note.position++;
  if (mode === 'checkpoint') mockCreator.checkpointHash = '0'.repeat(64);
  if (mode === 'digest') mockCreator.transactionDigest = '';
  if (mode === 'source') mockCreator.eventSourceAuthenticated = false;
  if (mode === 'path') mockVerified.pathVerified = false;
  if (mode === 'exit') mockVerified.utilityExitObserved = false;
  if (mode === 'coverage') mockVerified.coverage.globalTxidCompleteness = true;
  await expect(open()).rejects.toMatchObject({ code: 'RAILGUN_TRANSACT_PROVENANCE_REFUSED' });
  expect(mockRootFactory).not.toHaveBeenCalled();
});
test.each(['creator', 'verifier'])(
  'late %s completion after abort drains and cannot open root service',
  async (mode) => {
    let release;
    (mode === 'creator' ? mockCapture : mockVerify).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    let settled = false;
    const pending = open().finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toThrow();
    for (let n = 0; n < 5; n++) await Promise.resolve();
    caller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release(mode === 'creator' ? { receipt: {} } : mockVerified);
    await rejected;
    expect(mockRootFactory).not.toHaveBeenCalled();
  }
);
test('root acquisition is one attempt and close drains a late root response', async () => {
  let release;
  mockRoots.acquire.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const op = await open();
  const pending = op.acquireRoot();
  const rejected = expect(pending).rejects.toThrow();
  expect(() => op.acquireRoot()).toThrow();
  let closed = false;
  const closing = op.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(mockRoots.close).toHaveBeenCalled();
  release({});
  await rejected;
  await closing;
  expect(closed).toBe(true);
  expect(() => op.acquireRoot()).toThrow();
});
test('root errors revoke the entire operation and cannot be retried', async () => {
  mockRoots.acquire.mockRejectedValue(Error('rejected root'));
  const op = await open();
  await expect(op.acquireRoot()).rejects.toThrow();
  expect(op.signal.aborted).toBe(true);
  expect(() => op.acquireRoot()).toThrow();
});
test('remaining-time margin rechecks creator, staging and root freshness', async () => {
  const op = await open();
  const acquired = await op.acquireRoot();
  mockRoots.assertRoot.mockImplementation(() => {
    throw Error('stale');
  });
  expect(() => check(op, acquired.receipt, 20000)).toThrow();
  mockRoots.assertRoot.mockReturnValue(acquired.observation.root);
  mockClaim.assertCurrent.mockImplementation(() => {
    throw Error('changed generation');
  });
  expect(() => check(op, acquired.receipt)).toThrow();
});

test.each(['staging-revoked', 'deadline-before-timer', 'root-budget-before-timer'])(
  'real root source refuses its second request after %s',
  async (mode) => {
    const stagingController = new AbortController();
    mockClaim.signal = stagingController.signal;
    let now = 1000,
      release;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    mockWindow.deadline = now + 175000;
    const transport = new AbortController();
    const second = jest.fn(async () => true);
    mockServices.mockReturnValue({
      signal: transport.signal,
      close: () => transport.abort(),
      latestTxid: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      validateTxidRoot: second,
    });
    mockRootFactory.mockImplementation(
      jest.requireActual('./railgun-txid-root').createRailgunTxidRootSource
    );
    const op = await open({ timeoutMs: mode === 'root-budget-before-timer' ? 150000 : 10000 });
    const pending = op.acquireRoot({ timeoutMs: 10000 });
    const rejected = expect(pending).rejects.toThrow();
    if (mode === 'staging-revoked') {
      stagingController.abort();
      expect(transport.signal.aborted).toBe(true);
    } else now += 11000;
    release({ index: 0, root: mockStaged.state.root });
    await rejected;
    expect(second).not.toHaveBeenCalled();
    expect(op.signal.aborted).toBe(true);
  }
);

function mixedCreator() {
  const { createHash } = require('crypto');
  const { classifyRailgunTxidContinuity } = require('./railgun-txid-omissions');
  const pins = require('./railgun-shield-pins.json');
  const row = {
    version: 'V2',
    graphID: hex(30) + '0'.repeat(128),
    commitments: [hex(20), hex(21)],
    nullifiers: [hex(10)],
    boundParamsHash: hex(9),
    blockNumber: 30,
    txid: hex(40).slice(2),
    timestamp: 1,
    utxoTreeIn: 0,
    utxoTreeOut: 0,
    utxoBatchStartPositionOut: 2,
    verificationHash: hex(8),
    unshield: {
      tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      toAddress: '0x' + '12'.repeat(20),
      value: '400',
    },
  };
  mockStaged.state.transcript = '2'.repeat(64);
  mockStaged.state.breaks = [];
  mockStaged.noteWitness = {
    note: { ...mockCreator.note },
    outputIndex: 0,
    witness: {
      row,
      leaf: hex(3).slice(2),
      railgunTxid: hex(4).slice(2),
      rowSha256: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
      index: 0,
      elements: Array(16).fill(hex(0).slice(2)),
      root: mockStaged.state.root,
      checkpointIndex: 0,
      transcript: mockStaged.state.transcript,
      continuity: classifyRailgunTxidContinuity(0, []),
      globalTxidCompleteness: false,
    },
    ownershipVerified: false,
    eventCoverageVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  };
  mockCreator.events = [
    { name: 'Nullified', logIndex: 1, tree: 0, values: [hex(10)] },
    {
      name: 'Unshield',
      logIndex: 2,
      to: row.unshield.toAddress,
      token: pins.wrappedNative,
      type: 0,
      subID: '0',
      value: '400',
    },
    { name: 'Transact', logIndex: 3, tree: 0, start: 2, hashes: [hex(20)] },
  ];
  mockVerified.coverage = {
    matchedRows: 1,
    knownOmissions: 0,
    boundParamsChecked: false,
    unshieldCommitmentHashesChecked: false,
    globalTxidCompleteness: false,
  };
  mockVerified.unshieldCommitmentVerified = true;
}
test('mixed creating row needs detached final-commitment verification before root admission', async () => {
  mixedCreator();
  let release;
  mockVerify.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = open();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(mockRootFactory).not.toHaveBeenCalled();
  release(mockVerified);
  const op = await pending;
  expect(mockRootFactory).not.toHaveBeenCalled();
  const acquired = await op.acquireRoot();
  expect(check(op, acquired.receipt).unshieldCommitmentVerified).toBe(true);
  expect(mockVerify.mock.calls[0][0].events).toEqual(mockCreator.events);
});
test.each(['missing', 'false', 'matchedRows', 'knownOmissions', 'hashCoverage'])(
  'mixed creator %s refuses before root service creation',
  async (mode) => {
    mixedCreator();
    if (mode === 'missing') delete mockVerified.unshieldCommitmentVerified;
    if (mode === 'false') mockVerified.unshieldCommitmentVerified = false;
    if (mode === 'matchedRows') mockVerified.coverage.matchedRows = 2;
    if (mode === 'knownOmissions') mockVerified.coverage.knownOmissions = 1;
    if (mode === 'hashCoverage') mockVerified.coverage.unshieldCommitmentHashesChecked = true;
    await expect(open()).rejects.toMatchObject({ code: 'RAILGUN_TRANSACT_PROVENANCE_REFUSED' });
    expect(mockRootFactory).not.toHaveBeenCalled();
  }
);
test('legacy provenance observation preserves absent unshield diagnostic', async () => {
  const op = await open();
  const acquired = await op.acquireRoot();
  expect(Object.hasOwn(check(op, acquired.receipt), 'unshieldCommitmentVerified')).toBe(false);
});

test.each(['multi-output', 'max-row', 'ERC20', 'ERC721', 'ERC1155', 'nullable-absent'])(
  'generic pre-spend %s retains creator/witness joins without retained-only narrowing',
  async (kind) => {
    mixedCreator();
    const { createHash } = require('crypto');
    const { normalizeRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
    const { matchRailgunTxidEvents } = require('./railgun-txid-events');
    const w = mockStaged.noteWitness.witness,
      row = w.row;
    let selected = 0;
    if (kind === 'multi-output' || kind === 'max-row') {
      const inputs = kind === 'max-row' ? 13 : 2,
        outputs = kind === 'max-row' ? 12 : 2;
      row.nullifiers = Array.from({ length: inputs }, (_, i) => hex(100 + i));
      row.commitments = [...Array.from({ length: outputs }, (_, i) => hex(200 + i)), hex(21)];
      selected = outputs - 1;
    }
    if (kind === 'ERC20') row.unshield.tokenData.tokenAddress = '0x' + '34'.repeat(20);
    if (kind === 'ERC721' || kind === 'ERC1155') {
      row.unshield.tokenData.tokenType = kind === 'ERC721' ? 1 : 2;
      row.unshield.tokenData.tokenSubID = hex(7);
      if (kind === 'ERC721') row.unshield.value = '1';
    }
    if (kind === 'nullable-absent') {
      row.unshield = null;
      row.commitments.pop();
      delete mockVerified.unshieldCommitmentVerified;
    }
    mockCreator.note = {
      ...mockCreator.note,
      position: row.utxoBatchStartPositionOut + selected,
      hash: row.commitments[selected],
    };
    mockStaged.baseline.selection.position = mockCreator.note.position;
    mockStaged.baseline.owned.hash = mockCreator.note.hash;
    mockStaged.noteWitness.note = { ...mockCreator.note };
    mockStaged.noteWitness.outputIndex = selected;
    w.rowSha256 = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    mockCreator.events = [
      { name: 'Nullified', logIndex: 1, tree: row.utxoTreeIn, values: row.nullifiers },
      ...(row.unshield
        ? [
            {
              name: 'Unshield',
              logIndex: 2,
              to: row.unshield.toAddress,
              token: row.unshield.tokenData.tokenAddress,
              type: row.unshield.tokenData.tokenType,
              subID: BigInt(row.unshield.tokenData.tokenSubID).toString(),
              value: row.unshield.value,
            },
          ]
        : []),
      {
        name: 'Transact',
        logIndex: 3,
        tree: row.utxoTreeOut,
        start: row.utxoBatchStartPositionOut,
        hashes: row.commitments.slice(0, row.commitments.length - (row.unshield ? 1 : 0)),
      },
    ];
    // Real structural normalization/coverage on the handoff; detached crypto is
    // the genuine verifier's responsibility and is independently job-tested.
    mockVerify.mockImplementation(async (input) => {
      const normalized = normalizeRailgunNoteTxidWitness(
        input.noteWitness,
        input.state,
        input.note
      );
      expect(normalized.outputIndex).toBe(selected);
      expect(
        matchRailgunTxidEvents({
          blockNumber: 30,
          txid: row.txid,
          events: input.events,
          rows: [normalized.witness.row],
        })
      ).toEqual(mockVerified.coverage);
      return mockVerified;
    });
    const op = await open();
    expect(mockRootFactory).not.toHaveBeenCalled();
    const acquired = await op.acquireRoot();
    expect(Object.hasOwn(check(op, acquired.receipt), 'unshieldCommitmentVerified')).toBe(
      kind !== 'nullable-absent'
    );
  }
);
test('generic mixed verifier failure drains before refusal and cannot expose root admission', async () => {
  mixedCreator();
  let release;
  mockVerify.mockImplementation(
    () =>
      new Promise((_, reject) => {
        release = () => reject(Error('invalid preimage'));
      })
  );
  let settled = false;
  const pending = open().finally(() => {
    settled = true;
  });
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'RAILGUN_TRANSACT_PROVENANCE_REFUSED',
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(mockRootFactory).not.toHaveBeenCalled();
  release();
  await rejected;
  expect(mockRootFactory).not.toHaveBeenCalled();
});

test.each([true, false])(
  'original verifier rejection propagates unknown=%s only after its original settles',
  async (unknown) => {
    let rejectOriginal;
    const original = new Promise((_resolve, reject) => {
      rejectOriginal = reject;
    });
    mockVerify.mockReturnValue(original);
    const error = Object.assign(Error('fixed helper refusal'), {
      code: unknown ? 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED' : 'RAILGUN_NOTE_PROVENANCE_REFUSED',
    });
    let settled = false;
    const work = open().catch((failure) => {
      settled = true;
      return failure;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    rejectOriginal(error);
    const outcome = await work;
    if (unknown) expect(outcome).toBe(error);
    else expect(outcome.code).toBe('RAILGUN_TRANSACT_PROVENANCE_REFUSED');
    expect(mockServices).not.toHaveBeenCalled();
    expect(mockRootFactory).not.toHaveBeenCalled();
  }
);
