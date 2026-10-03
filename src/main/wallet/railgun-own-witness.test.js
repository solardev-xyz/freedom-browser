let mockEnrollment, mockCoordinator, mockPublicIdentity, mockPolicy;
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
const { captureRailgunOwnWitness: capture } = require('./railgun-own-witness');
const copy = (v) => JSON.parse(JSON.stringify(v));
const hash = (s) => '0' + createHash('sha256').update(s).digest('hex').slice(1);
const pair = (a, b) => hash(a + b),
  zeros = [hash('zero')];
for (let n = 0; n < 16; n++) zeros.push(pair(zeros[n], zeros[n]));
let scope, caller, options, first, latest, txid, state, witness, events, fixture;
async function setup(unshield = false, mutateRow = () => {}) {
  fixture = sample(unshield);
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
  mockPublicIdentity = {
    generationId: '1'.repeat(64),
    publicId: '2'.repeat(64),
    sourceId: '3'.repeat(64),
  };
  mockEnrollment = {
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
test('drains a late open after cancellation before returning', async () => {
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
