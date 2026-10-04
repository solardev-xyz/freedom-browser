const mockArchive = '/synthetic-poi-assembly.asar';
let mockController, mockGate, mockRelease, mockSeen, mockObserved;
const mockPathVerify = jest.fn(),
  mockMerkleVerify = jest.fn(),
  mockBlind = jest.fn(),
  mockMarker = jest.fn(),
  mockNullifier = jest.fn();
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => mockArchive),
}));
jest.mock('./railgun-own-txid', () => ({
  matchRailgunOwnTxid: jest.fn((v) => ({ row: v.row, output: { kind: 'shielded' } })),
}));
jest.mock('./railgun-txid-note-witness', () => ({
  normalizeRailgunTxidWitness: jest.fn((v) => v),
}));
jest.mock('./railgun-txid-projection', () => ({
  ...jest.requireActual('./railgun-txid-projection'),
  createRailgunTxidProjection: () => ({ verifyWitness: mockPathVerify }),
}));
jest.mock('./railgun-poi-reconstruct', () => ({
  reconstructRailgunPoiNotes: jest.fn(async (args) => {
    mockSeen = args.viewingKey;
    mockObserved = {
      key: Buffer.from(args.viewingKey),
      creator: structuredClone(args.creator),
      capsule: structuredClone(args.capsule),
    };
    mockController.abort();
    return {};
  }),
}));
jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockGate;
    },
    poseidonHex: jest.fn(),
  }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/transaction/railgun-txid',
  () => ({}),
  { virtual: true }
);
const { prepareRailgunPoiWitness } = require('./railgun-poi-witness');
const runtime = require('./railgun-engine-runtime');
const reconstruct = require('./railgun-poi-reconstruct').reconstructRailgunPoiNotes;
const zero = '0'.repeat(64);
function args() {
  return {
    archive: mockArchive,
    descriptor: {},
    viewingKey: Buffer.alloc(32, 7),
    creator: { marker: 'original' },
    ownEvidence: {
      capsule: { marker: 'original' },
      record: {},
      transaction: {},
      receipt: {},
      row: {},
    },
    state: {},
    witness: { row: {} },
    listProofs: [{ leaf: zero, root: zero, indices: zero, elements: Array(16).fill(zero) }],
    signal: mockController.signal,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockController = new AbortController();
  mockSeen = mockObserved = undefined;
  mockGate = new Promise((resolve) => {
    mockRelease = resolve;
  });
});
test('source-normalized list proof passes assembly shape checks before key work', async () => {
  const input = args();
  input.listProofs = require('./railgun-poi-records').normalizePoiProofs(
    [
      {
        leaf: '0x' + zero,
        root: '0x' + zero,
        indices: '0x' + zero,
        elements: Array(16).fill('0x' + zero),
      },
    ],
    [{ blindedCommitment: '0x' + zero, type: 'Shield' }]
  );
  const pending = prepareRailgunPoiWitness(input);
  mockRelease();
  // This suite aborts in reconstruction. Reaching it proves format compatibility,
  // not membership or witness validity; native qualification covers the crypto.
  await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_POI_WITNESS_REFUSED' });
  expect(runtime.verifyRailgunEngineRuntime).toHaveBeenCalled();
  expect(reconstruct).toHaveBeenCalledTimes(1);
});
test('assembly keeps one captured input and private key copy across async work and wipes on cancellation', async () => {
  const input = args();
  const promise = prepareRailgunPoiWitness(input);
  input.viewingKey.fill(9);
  input.creator.marker = 'changed';
  input.ownEvidence.capsule.marker = 'changed';
  mockRelease();
  await expect(promise).rejects.toMatchObject({ code: 'RAILGUN_POI_WITNESS_REFUSED' });
  expect(mockObserved.key.equals(Buffer.alloc(32, 7))).toBe(true);
  expect(mockObserved.creator.marker).toBe('original');
  expect(mockObserved.capsule.marker).toBe('original');
  expect(mockSeen.equals(Buffer.alloc(32))).toBe(true);
  expect(input.viewingKey.equals(Buffer.alloc(32, 9))).toBe(true);
});
test.each(['marker', 'outputPosition', 'listKey'])(
  'caller %s override refuses before engine/key work',
  async (name) => {
    await expect(prepareRailgunPoiWitness({ ...args(), [name]: 'override' })).rejects.toMatchObject(
      { code: 'RAILGUN_POI_WITNESS_REFUSED' }
    );
    expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
    expect(reconstruct).not.toHaveBeenCalled();
  }
);
test.each(['oversize', 'index', 'field', 'extra-proof', 'aborted'])(
  'bounded %s refusal sanitizes errors before engine work',
  async (mode) => {
    const input = args();
    if (mode === 'oversize') input.creator.text = 'secret-sentinel'.repeat(20000);
    if (mode === 'index') input.listProofs[0].indices = '1'.padEnd(64, '0');
    if (mode === 'field') input.listProofs[0].root = 'f'.repeat(64);
    if (mode === 'extra-proof') input.listProofs.push(input.listProofs[0]);
    if (mode === 'aborted') mockController.abort();
    await expect(prepareRailgunPoiWitness(input)).rejects.toMatchObject({
      message: 'Railgun POI witness unavailable',
      code: 'RAILGUN_POI_WITNESS_REFUSED',
    });
    expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  }
);

jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/note/transact-note',
  () => ({ TransactNote: { getNullifier: (...a) => mockNullifier(...a) } }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/poi/global-tree-position',
  () => ({ getGlobalTreePosition: (tree, pos) => BigInt(tree) * 65536n + BigInt(pos) }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/poi/blinded-commitment',
  () => ({
    BlindedCommitment: {
      getForShieldOrTransact: (...a) => mockBlind(...a),
      getForUnshield: (...a) => mockMarker(...a),
    },
  }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/merkletree/merkle-proof',
  () => ({ verifyMerkleProof: (...a) => mockMerkleVerify(...a) }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/models/merkletree-types',
  () => ({ MERKLE_ZERO_VALUE_BIGINT: 91n }),
  { virtual: true }
);

describe('combined output assembly with actual own matcher and witness normalizer', () => {
  const { createHash } = require('crypto');
  const { samplePartial } = require('../../../scripts/fixtures/railgun-partial-own-txid-data');
  const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
  const matcher = require('./railgun-own-txid').matchRailgunOwnTxid;
  const normalizer = require('./railgun-txid-note-witness').normalizeRailgunTxidWitness;
  const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
  let notes;
  beforeEach(() => {
    mockGate = Promise.resolve();
    matcher.mockImplementation(jest.requireActual('./railgun-own-txid').matchRailgunOwnTxid);
    normalizer.mockImplementation(
      jest.requireActual('./railgun-txid-note-witness').normalizeRailgunTxidWitness
    );
    mockPathVerify.mockImplementation(() => {});
    mockMerkleVerify.mockReturnValue(true);
    mockNullifier.mockReturnValue(2n);
    // Deterministic unit seam, not engine crypto. Native fixture verifies paths,
    // blinded commitments and all eight signals with the pinned engine/circuit.
    mockBlind.mockImplementation((hash, npk, pos) => '0x' + hex(BigInt(hash) + npk + pos));
    mockMarker.mockImplementation((txid) => txid);
    notes = {
      spendingPublicKey: [7n, 8n],
      nullifyingKey: 6n,
      token: 'a'.repeat(64),
      randomsIn: ['01'.repeat(16)],
      valuesIn: [1000n],
      utxoPositionsIn: [1],
      utxoTreeIn: 0,
      npksOut: [11n],
      valuesOut: [600n],
      inputNpk: 10n,
    };
    reconstruct.mockImplementation(async (a) => {
      mockSeen = a.viewingKey;
      return notes;
    });
  });
  function input(kind = 'partial') {
    const ownEvidence = kind === 'partial' ? samplePartial() : sample(kind === 'full');
    notes.valuesOut = kind === 'full' ? [] : [kind === 'partial' ? 600n : 1000n];
    notes.npksOut = kind === 'full' ? [] : [11n];
    mockNullifier.mockReturnValue(BigInt(ownEvidence.row.nullifiers[0]));
    const state = { count: 3, root: hex(80), transcript: hex(81), breaks: [] };
    const witness = {
      row: ownEvidence.row,
      leaf: hex(90),
      railgunTxid: hex(77),
      rowSha256: createHash('sha256').update(JSON.stringify(ownEvidence.row)).digest('hex'),
      index: 1,
      elements: Array(16).fill(hex(0)),
      root: state.root,
      checkpointIndex: 2,
      transcript: state.transcript,
      continuity: require('./railgun-txid-omissions').classifyRailgunTxidContinuity(2, []),
      globalTxidCompleteness: false,
    };
    return {
      ...args(),
      ownEvidence,
      state,
      witness,
      listProofs: [
        {
          leaf: mockBlind(ownEvidence.capsule.noteHash, 10n, 1n).slice(2),
          root: hex(92),
          indices: hex(5),
          elements: Array(16).fill(hex(0)),
        },
      ],
    };
  }
  function wiped(a) {
    expect(mockSeen.equals(Buffer.alloc(32))).toBe(true);
    expect(a.viewingKey.equals(Buffer.alloc(32, 7))).toBe(true);
  }
  test.each(['partial', 'transfer', 'full'])(
    '%s binds exact ordinary output count and own TXID marker',
    async (kind) => {
      const a = input(kind);
      mockBlind.mockClear();
      const result = await prepareRailgunPoiWitness(a);
      const ordinary = kind !== 'full',
        hasUnshield = kind !== 'transfer';
      expect(result.inputs.commitmentsOut).toEqual(a.ownEvidence.row.commitments);
      expect(result.inputs.commitmentsOut).toHaveLength(kind === 'partial' ? 2 : 1);
      expect(result.inputs.npksOut).toEqual(ordinary ? [11n] : []);
      expect(result.inputs.valuesOut).toEqual(ordinary ? [kind === 'partial' ? 600n : 1000n] : []);
      expect(result.blindedOut).toHaveLength(ordinary ? 1 : 0);
      expect(result.inputs.railgunTxidIfHasUnshield).toBe(
        hasUnshield ? '0x' + a.witness.railgunTxid : '0x00'
      );
      if (ordinary)
        expect(mockBlind).toHaveBeenLastCalledWith(
          a.ownEvidence.row.commitments[0],
          11n,
          BigInt(a.ownEvidence.row.utxoTreeOut) * 65536n +
            BigInt(a.ownEvidence.row.utxoBatchStartPositionOut)
        );
      expect(mockBlind).toHaveBeenCalledTimes(ordinary ? 2 : 1);
      expect(result.expectedPublicInputs).toEqual({
        blindedCommitmentsOut: [ordinary ? BigInt(result.blindedOut[0]) : 0n, 0n, 0n],
        railgunTxidIfHasUnshield: hasUnshield ? 77n : 0n,
        anyRailgunTxidMerklerootAfterTransaction: 80n,
        poiMerkleroots: [92n, 91n, 91n],
      });
      expect(mockMerkleVerify).toHaveBeenCalledTimes(2);
      expect(mockMerkleVerify.mock.calls[1][0]).toEqual({
        leaf: a.witness.leaf,
        root: a.witness.root,
        indices: hex(1),
        elements: a.witness.elements,
      });
      for (const flag of [
        'sourceAuthenticated',
        'membershipAuthenticated',
        'rootAccepted',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        expect(result[flag]).toBe(false);
      wiped(a);
    }
  );
  test.each([
    'empty-values',
    'extra-values',
    'empty-npks',
    'extra-npks',
    'zero-change',
    'nullifier',
    'input-tree',
    'list-leaf',
    'list-proof',
    'converted-path',
    'projection',
  ])('partial %s cannot produce a witness and wipes the owned key', async (mode) => {
    const a = input();
    if (mode === 'empty-values') notes.valuesOut = [];
    if (mode === 'extra-values') notes.valuesOut.push(400n);
    if (mode === 'empty-npks') notes.npksOut = [];
    if (mode === 'extra-npks')
      notes.npksOut.push(BigInt(a.ownEvidence.capsule.selection.recipient));
    if (mode === 'zero-change') notes.valuesOut = [0n];
    if (mode === 'nullifier') mockNullifier.mockReturnValue(99n);
    if (mode === 'input-tree') notes.utxoTreeIn = 1;
    if (mode === 'list-leaf') a.listProofs[0].leaf = hex(99);
    if (mode === 'list-proof') mockMerkleVerify.mockReturnValueOnce(false);
    if (mode === 'converted-path')
      mockMerkleVerify.mockReturnValueOnce(true).mockReturnValueOnce(false);
    if (mode === 'projection')
      mockPathVerify.mockImplementation(() => {
        throw Error('invalid path');
      });
    await expect(prepareRailgunPoiWitness(a)).rejects.toMatchObject({
      code: 'RAILGUN_POI_WITNESS_REFUSED',
    });
    if (mode === 'projection') expect(reconstruct).not.toHaveBeenCalled();
    else wiped(a);
  });
  test.each([
    'final-commitment',
    'change-commitment',
    'unshield-value',
    'output-position',
    'capsule-version',
    'capsule-calldata',
    'receipt-output',
  ])(
    'real own matcher refuses partial %s drift before runtime/secret reconstruction',
    async (mode) => {
      const a = input();
      if (mode === 'final-commitment') a.ownEvidence.row.commitments[1] = '0x' + hex(99);
      if (mode === 'change-commitment') a.ownEvidence.row.commitments[0] = '0x' + hex(99);
      if (mode === 'unshield-value') a.ownEvidence.row.unshield.value = '401';
      if (mode === 'output-position') a.ownEvidence.row.utxoBatchStartPositionOut++;
      if (mode === 'capsule-version') a.ownEvidence.capsule.version = 1;
      if (mode === 'capsule-calldata') a.ownEvidence.capsule.preparation.transaction.data = '0x';
      if (mode === 'receipt-output') a.ownEvidence.receipt.logs[4].data = '0x';
      await expect(prepareRailgunPoiWitness(a)).rejects.toMatchObject({
        code: 'RAILGUN_POI_WITNESS_REFUSED',
      });
      expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
      expect(reconstruct).not.toHaveBeenCalled();
    }
  );
  test('partial reconstruction held after cancellation drains without publishing combined inputs', async () => {
    const a = input();
    let release, entered;
    const ready = new Promise((r) => {
      entered = r;
    });
    reconstruct.mockImplementation((v) => {
      mockSeen = v.viewingKey;
      entered();
      return new Promise((r) => {
        release = () => r(notes);
      });
    });
    let settled = false;
    const work = prepareRailgunPoiWitness(a).finally(() => {
      settled = true;
    });
    const refused = expect(work).rejects.toMatchObject({ code: 'RAILGUN_POI_WITNESS_REFUSED' });
    await ready;
    mockController.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockSeen.equals(Buffer.alloc(32))).toBe(false);
    release();
    await refused;
    wiped(a);
  });
});
