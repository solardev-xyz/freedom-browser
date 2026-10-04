const { createHash } = require('crypto');
let mockInput, mockExpected, mockPayload, mockArtifacts, mockScope, mockProve;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((v) => v) }));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: jest.fn((v) => v) }));
jest.mock('./railgun-artifacts', () => ({
  loadRailgunArtifacts: jest.fn(async () => mockArtifacts),
}));
jest.mock('../networks/privacy-context', () => ({ createPrivacyScope: () => mockScope }));
jest.mock('./railgun-own-poi-proof-data', () => ({
  ...jest.requireActual('./railgun-own-poi-proof-data'),
  normalizeRailgunOwnPoiProofInput: jest.fn(() => mockInput),
  expectedRailgunOwnPoiFields: jest.fn(() => mockExpected),
}));
jest.mock('./railgun-poi-prover', () => ({ proveRailgunPoi: (...args) => mockProve(...args) }));
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const sha = (v) => createHash('sha256').update(v).digest('hex');
let run, caller, bytes, requestKey, request, guardReport, text;
beforeEach(() => {
  jest.resetModules();
  caller = new AbortController();
  bytes = Buffer.alloc(32, 7);
  mockInput = {
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    descriptor: { walletId: 'public-fixture' },
    preparation: { creator: {}, ownEvidence: {}, state: {}, witness: {} },
    listProofs: [{}],
  };
  mockExpected = {
    listKey: require('./railgun-poi-records').REQUIRED_LIST,
    poiMerkleroots: [hex(2).slice(2)],
    txidMerkleroot: hex(3).slice(2),
    txidMerklerootIndex: 4,
    railgunTxidIfHasUnshield: '0x00',
    outputCount: 1,
  };
  mockPayload = {
    ...mockExpected,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    blindedCommitmentsOut: [hex(1)],
  };
  delete mockPayload.outputCount;
  mockArtifacts = { wasm: Buffer.alloc(4, 1), zkey: Buffer.alloc(4, 2), vkey: {} };
  mockScope = { getContext: jest.fn(() => ({})), close: jest.fn() };
  mockProve = jest.fn(async () => ({
    payload: mockPayload,
    locallyVerified: true,
    independentlyVerified: false,
  }));
  text = JSON.stringify(mockInput);
  requestKey = jest.fn(async (wire) => {
    expect(JSON.parse(wire)).toEqual({
      id: 1,
      method: 'key',
      purpose: 'poi-prove',
      inputSha256: sha(text),
    });
    expect(mockArtifacts.wasm.equals(Buffer.alloc(4))).toBe(true);
    expect(mockArtifacts.zkey.equals(Buffer.alloc(4))).toBe(true);
    return bytes;
  });
  request = jest.fn(async () => JSON.stringify({ id: 2, value: null }));
  guardReport = jest.fn(() => ({ attempts: 0, canaries: 1, hooks: ['network'] }));
  run = require('./railgun-own-poi-prove-job').run;
});
const context = () => ({ request, requestKey, signal: caller.signal, guardReport });
test('authenticates artifacts before one viewing key, wipes before public result, and cannot run twice', async () => {
  request.mockImplementation(async (wire) => {
    expect(bytes.equals(Buffer.alloc(32))).toBe(true);
    const message = JSON.parse(wire);
    expect(message).toMatchObject({
      id: 2,
      method: 'result',
      value: {
        inputSha256: sha(text),
        payloadSha256: sha(
          JSON.stringify(require('./railgun-poi-payload').normalizeRailgunPoiPayload(mockPayload))
        ),
        locallyVerified: true,
        independentlyVerified: false,
        disclosureEnabled: false,
        spendingEnabled: false,
      },
    });
    expect(message.value.payload).toEqual(mockPayload);
    return JSON.stringify({ id: 2, value: null });
  });
  await run(text, context());
  expect(requestKey).toHaveBeenCalledTimes(1);
  expect(mockProve).toHaveBeenCalledTimes(1);
  expect(mockProve.mock.calls[0][0]).toMatchObject({
    ...mockInput.preparation,
    descriptor: mockInput.descriptor,
    listProofs: mockInput.listProofs,
    archive: mockInput.archive,
    proverArchive: mockInput.proverArchive,
    signal: caller.signal,
  });
  expect(mockScope.close).toHaveBeenCalledTimes(1);
  await expect(run(text, context())).rejects.toMatchObject({
    code: 'RAILGUN_OWN_POI_PROOF_REFUSED',
  });
  expect(requestKey).toHaveBeenCalledTimes(1);
});
test.each(['input-limit', 'input-json', 'engine', 'prover', 'artifacts', 'aborted'])(
  'refuses %s before requesting a key',
  async (fault) => {
    if (fault === 'input-limit') text = 'x'.repeat(65537);
    if (fault === 'input-json') text = '{';
    if (fault === 'engine')
      require('./railgun-engine-runtime').verifyRailgunEngineRuntime.mockImplementationOnce(() => {
        throw Error('private');
      });
    if (fault === 'prover')
      require('./railgun-prover-runtime').verifyRailgunProverRuntime.mockImplementationOnce(() => {
        throw Error('private');
      });
    if (fault === 'artifacts')
      require('./railgun-artifacts').loadRailgunArtifacts.mockRejectedValueOnce(Error('private'));
    if (fault === 'aborted') caller.abort();
    await expect(run(text, context())).rejects.toMatchObject({
      code: 'RAILGUN_OWN_POI_PROOF_REFUSED',
      message: 'Railgun own POI proof unavailable',
    });
    expect(requestKey).not.toHaveBeenCalled();
    expect(mockProve).not.toHaveBeenCalled();
  }
);
test.each([
  'key-length',
  'proof-failure',
  'local-flag',
  'independent-flag',
  'root',
  'checkpoint',
  'guard',
  'ack',
])('refuses %s and wipes the received viewing bytes', async (fault) => {
  if (fault === 'key-length') bytes = Buffer.alloc(31, 7);
  if (fault === 'proof-failure') mockProve.mockRejectedValueOnce(Error('private witness sentinel'));
  if (fault === 'local-flag')
    mockProve.mockResolvedValueOnce({
      payload: mockPayload,
      locallyVerified: false,
      independentlyVerified: false,
    });
  if (fault === 'independent-flag')
    mockProve.mockResolvedValueOnce({
      payload: mockPayload,
      locallyVerified: true,
      independentlyVerified: true,
    });
  if (fault === 'root') mockPayload.txidMerkleroot = hex(11).slice(2);
  if (fault === 'checkpoint') mockPayload.txidMerklerootIndex++;
  if (fault === 'guard') guardReport.mockReturnValue({ attempts: 1 });
  if (fault === 'ack') request.mockResolvedValue(JSON.stringify({ id: 1, value: null }));
  await expect(run(text, context())).rejects.toMatchObject({
    code: 'RAILGUN_OWN_POI_PROOF_REFUSED',
  });
  expect(bytes.equals(Buffer.alloc(bytes.length))).toBe(true);
});
test('cancellation drains the proof before wiping and never sends a payload', async () => {
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  mockProve.mockImplementationOnce(async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return { payload: mockPayload, locallyVerified: true, independentlyVerified: false };
  });
  let settled = false;
  const pending = run(text, context()).finally(() => {
    settled = true;
  });
  await ready;
  caller.abort();
  expect(settled).toBe(false);
  release();
  await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_OWN_POI_PROOF_REFUSED' });
  expect(bytes.equals(Buffer.alloc(32))).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

// Structural fixture only: real capsule/receipt/row/schema checks, synthetic
// Merkle fields. It does not establish cryptographic path/proof correctness.
function makeTransactProofFixture(unshield = false) {
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
    commitments: [creator.hash],
    nullifiers: [h(700)],
    boundParamsHash: h(701),
    blockNumber,
    txid: h(706).slice(2),
    timestamp: blockNumber,
    utxoTreeIn: creator.tree,
    utxoTreeOut: creator.tree,
    utxoBatchStartPositionOut: creator.position,
    verificationHash: evidence.row.verificationHash,
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
        utilityExitObserved: true,
        pathVerified: true,
        suppliedCreatorEventsMatched: true,
        coverage: { matchedRows: 1, knownOmissions: 0 },
      },
    },
  };
}

function useActualTransactInput(unshield = false) {
  const actual = jest.requireActual('./railgun-own-poi-proof-data');
  const mocked = require('./railgun-own-poi-proof-data');
  mockInput = makeTransactProofFixture(unshield).input;
  mocked.normalizeRailgunOwnPoiProofInput.mockImplementation(
    actual.normalizeRailgunOwnPoiProofInput
  );
  mocked.expectedRailgunOwnPoiFields.mockImplementation(actual.expectedRailgunOwnPoiFields);
  mockExpected = actual.expectedRailgunOwnPoiFields(
    actual.normalizeRailgunOwnPoiProofInput(mockInput)
  );
  mockPayload = {
    ...mockExpected,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    blindedCommitmentsOut: unshield ? [] : [hex(1)],
  };
  delete mockPayload.outputCount;
  text = JSON.stringify(mockInput);
}
test.each([false, true])(
  'worker applies actual Transact input normalization before one key: unshield=%s',
  async (unshield) => {
    useActualTransactInput(unshield);
    request.mockImplementation(async (wire) => {
      expect(bytes).toEqual(Buffer.alloc(32));
      const result = JSON.parse(wire);
      expect(result.value.payload).toEqual(mockPayload);
      expect(result.value.sourceAuthenticated).toBe(false);
      expect(result.value.rootAccepted).toBe(false);
      return JSON.stringify({ id: 2, value: null });
    });
    await run(text, context());
    expect(requestKey).toHaveBeenCalledTimes(1);
    expect(mockProve).toHaveBeenCalledTimes(1);
    expect(mockProve.mock.calls[0][0].creator).toEqual(mockInput.preparation.creator);
    expect(mockProve.mock.calls[0][0].witness).toEqual(mockInput.preparation.witness);
    expect(mockProve.mock.calls[0][0].descriptor).toEqual(mockInput.descriptor);
    await expect(run(text, context())).rejects.toMatchObject({
      code: 'RAILGUN_OWN_POI_PROOF_REFUSED',
    });
    expect(requestKey).toHaveBeenCalledTimes(1);
  }
);
test.each(['creator', 'descriptor', 'capsule', 'witness', 'list', 'extra'])(
  'worker real Transact normalizer rejects %s before artifacts or key',
  async (fault) => {
    useActualTransactInput();
    if (fault === 'creator') mockInput.preparation.creator.ciphertext.ciphertext.pop();
    if (fault === 'descriptor') mockInput.descriptor.instanceId = '0zk1' + 'p'.repeat(123);
    if (fault === 'capsule') mockInput.preparation.ownEvidence.capsule.pathElements.pop();
    if (fault === 'witness') mockInput.preparation.witness.elements.pop();
    if (fault === 'list') mockInput.listProofs[0].elements.pop();
    if (fault === 'extra') mockInput.preparation.privateWitness = {};
    text = JSON.stringify(mockInput);
    await expect(run(text, context())).rejects.toMatchObject({
      code: 'RAILGUN_OWN_POI_PROOF_REFUSED',
      message: 'Railgun own POI proof unavailable',
    });
    expect(require('./railgun-artifacts').loadRailgunArtifacts).not.toHaveBeenCalled();
    expect(requestKey).not.toHaveBeenCalled();
    expect(mockProve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);
