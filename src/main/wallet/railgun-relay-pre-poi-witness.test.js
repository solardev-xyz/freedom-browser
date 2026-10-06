// Structural arithmetic/core seams; real captured event signature verification.
// No archive/Poseidon implementation or private wallet is loaded by these tests.
const { createHash } = require('crypto');
const { keccak256, toUtf8Bytes } = require('ethers');
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const event = require('../../../scripts/fixtures/railgun-poi-signed-event.json')[0];
const mockField = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const mockHex = (v) => BigInt(v).toString(16).padStart(64, '0');
const mockZero = BigInt(keccak256(toUtf8Bytes('Railgun'))) % mockField;
const mockHash = (values) =>
  BigInt(
    '0x' +
      createHash('sha256')
        .update('structural-only:' + values.join(','))
        .digest('hex')
  ) % mockField;
let mockInit;
const mockPoseidon = jest.fn((values) => mockHash(values));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn((archive) => {
    if (archive !== '/fixture-engine.asar') throw Error('unselected fixture archive');
    return archive;
  }),
}));
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    poseidon: (values) => mockPoseidon(values),
    get initPoseidonPromise() {
      return mockInit;
    },
  }),
  { virtual: true }
);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const copy = (value) => JSON.parse(JSON.stringify(value));
function fixture(tree = 7) {
  const f = createRailgunRelayUnsignedData();
  f.bound.treeNumber = tree;
  f.expected.tree = tree;
  f.draft.selection.tree = tree;
  f.draft.intent = f.build();
  const draft = normalizeRailgunRelayDraftCapsule(f.draft);
  const leaf = event.signedPOIEvent.blindedCommitment.slice(2);
  const elements = Array.from({ length: 16 }, (_, i) => mockHex(i + 1));
  let root = BigInt('0x' + leaf);
  for (const sibling of elements) root = mockHash([root, BigInt('0x' + sibling)]);
  const history = normalizeRailgunRelayPoiHistory({
    schema: 'railgun-relay-input-poi-history-v1',
    draftDigest: draft.digest,
    listKey: REQUIRED_LIST,
    note: { blindedCommitment: event.signedPOIEvent.blindedCommitment, type: 'Shield' },
    proof: { leaf, root: mockHex(root), indices: mockHex(0), elements },
    event: copy(event),
  }).data;
  const expected = draft.data.intent.expected;
  const nullifiers = [BigInt(expected.nullifier)];
  const commitments = [BigInt(expected.feeCommitment), BigInt(expected.selfCommitment)];
  const bound = BigInt(expected.boundParamsHash);
  const txid = mockHash([
    mockHash([...nullifiers, ...Array(12).fill(mockZero)]),
    mockHash([...commitments, ...Array(11).fill(mockZero)]),
    bound,
  ]);
  const global = 13107334463n;
  const txidLeaf = mockHash([txid, BigInt(tree), global]);
  let synthetic = txidLeaf;
  for (let i = 0; i < 16; i++) synthetic = mockHash([synthetic, 0n]);
  const binding = {
    schema: 'railgun-relay-pre-poi-binding-v1',
    draftDigest: draft.digest,
    chainId: 11155111,
    txidVersion: 'V2_PoseidonMerkle',
    listKey: REQUIRED_LIST,
    listWitness: history.proof,
    txidLeafHash: mockHex(txidLeaf),
    txidMerkleroot: mockHex(synthetic),
    blindedCommitmentsOut: commitments.map(
      (c, i) => '0x' + mockHex(mockHash([c, BigInt(21 + i), global + BigInt(i)]))
    ),
  };
  return {
    draft: draft.data,
    draftDigest: draft.digest,
    draftText: JSON.stringify(draft.data),
    history,
    binding,
    publicSignals: [
      ...binding.blindedCommitmentsOut.map(BigInt),
      0n,
      synthetic,
      0n,
      root,
      mockZero,
      mockZero,
    ],
    publicInputs: {
      merkleRoot: BigInt(expected.merkleRoot),
      boundParamsHash: bound,
      nullifiers,
      commitmentsOut: commitments,
    },
  };
}
beforeEach(() => {
  mockInit = Promise.resolve();
  mockPoseidon.mockClear();
});

let mockCore, mockPrepare, mockLocal, mockSelection;
const mockBlinds = jest.fn((commitment, npk, position) => {
  if (
    BigInt(commitment) === 12n &&
    npk === 777n &&
    position === BigInt(mockSelection.tree) * 65536n + BigInt(mockSelection.position)
  )
    return event.signedPOIEvent.blindedCommitment;
  return '0x' + mockHex(mockHash([BigInt(commitment), npk, position]));
});
jest.mock('./railgun-relay-reconstruct', () => ({
  reconstructRailgunRelayWitness: jest.fn((input) => mockPrepare(input)),
  reconstructRailgunRelayLocalWitness: jest.fn((input) => mockLocal(input)),
}));
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/poi/global-tree-position',
  () => ({
    getGlobalTreePosition: (tree, position) => BigInt(tree) * 65536n + BigInt(position),
    getGlobalTreePositionPreTransactionPOIProof: () => 13107334463n,
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/poi/blinded-commitment',
  () => ({ BlindedCommitment: { getForShieldOrTransact: (...args) => mockBlinds(...args) } }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/transaction/railgun-txid',
  () => ({
    getRailgunTransactionIDFromBigInts: (n, c, b) =>
      mockHash([
        mockHash([...n, ...Array(13 - n.length).fill(mockZero)]),
        mockHash([...c, ...Array(13 - c.length).fill(mockZero)]),
        b,
      ]),
    getRailgunTxidLeafHash: (t, tree, g) => mockHex(mockHash([t, tree, g])),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/merkletree/merkle-proof',
  () => ({
    createDummyMerkleProof: (leaf) => {
      let root = BigInt('0x' + leaf);
      for (let i = 0; i < 16; i++) root = mockHash([root, 0n]);
      return {
        leaf,
        root: mockHex(root),
        indices: mockHex(0),
        elements: Array(16).fill(mockHex(0)),
      };
    },
    verifyMerkleProof: (proof) => {
      let root = BigInt('0x' + proof.leaf);
      for (const sibling of proof.elements) root = mockHash([root, BigInt('0x' + sibling)]);
      return mockHex(root) === proof.root;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/models/merkletree-types',
  () => ({ MERKLE_ZERO_VALUE_BIGINT: mockZero }),
  { virtual: true }
);
const {
  prepareRailgunRelayPrePoiWitness: prepare,
  restoreRailgunRelayPrePoiWitness: restore,
} = require('./railgun-relay-pre-poi-witness');
const core = require('./railgun-relay-reconstruct');
const refused = expect.objectContaining({ code: 'RAILGUN_RELAY_PRE_POI_WITNESS_REFUSED' });
function request(f = fixture(), signal = new AbortController().signal) {
  mockSelection = f.draft.selection;
  mockCore = {
    publicReconstruction: {
      draftDigest: f.draftDigest,
      expectedHash: f.draft.intent.expectedHash,
      recoveredOutputs: 2,
    },
    witness: {
      txidVersion: 'V2_PoseidonMerkle',
      publicInputs: f.publicInputs,
      privateInputs: {},
      boundParams: {},
    },
    prePoi: {
      spendingPublicKey: [1n, 2n],
      nullifyingKey: 3n,
      inputNpk: 777n,
      token: mockHex(4),
      randomsIn: ['01'.repeat(16)],
      valuesIn: [700n],
      utxoTreeIn: f.draft.selection.tree,
      utxoPositionsIn: [7],
      npksOut: [21n, 22n],
      valuesOut: [100n, 600n],
      inputNoteType: 'Shield',
    },
  };
  return {
    archive: '/fixture-engine.asar',
    wallet: { fixture: 'wallet' },
    descriptor: { fixture: 'descriptor' },
    checkpoint: { fixture: 'checkpoint' },
    scan: { fixture: 'scan' },
    draftText: f.draftText,
    history: copy(f.history),
    signal,
  };
}
beforeEach(() => {
  mockPrepare = jest.fn(async () => mockCore);
  mockLocal = jest.fn(async () => mockCore);
  core.reconstructRailgunRelayWitness.mockClear();
  core.reconstructRailgunRelayLocalWitness.mockClear();
  mockBlinds.mockClear();
});
test.each([0, 7, 65535])(
  'private assembler derives actual tree %i and fee/self order',
  async (tree) => {
    const f = fixture(tree),
      input = request(f),
      result = await prepare(input);
    expect(result.witness).toEqual(mockCore.witness);
    expect(Object.isFrozen(result.witness.publicInputs.nullifiers)).toBe(true);
    expect(result.binding).toEqual(f.binding);
    expect(result.publicSignals).toEqual(f.publicSignals);
    expect(result.inputs).toMatchObject({
      utxoTreeIn: tree,
      utxoPositionsIn: [7],
      npksOut: [21n, 22n],
      valuesOut: [100n, 600n],
      utxoBatchGlobalStartPositionOut: 13107334463n,
      railgunTxidIfHasUnshield: '0x00',
      railgunTxidMerkleProofIndices: mockHex(0),
      railgunTxidMerkleProofPathElements: Array(16).fill(mockHex(0)),
    });
    expect(mockBlinds.mock.calls).toEqual([
      [f.draft.noteHash, 777n, BigInt(tree) * 65536n + 7n],
      ['0x' + mockHex(9), 21n, 13107334463n],
      ['0x' + mockHex(10), 22n, 13107334464n],
    ]);
    expect(core.reconstructRailgunRelayWitness).toHaveBeenCalledTimes(1);
    expect(core.reconstructRailgunRelayLocalWitness).not.toHaveBeenCalled();
    expect(core.reconstructRailgunRelayWitness.mock.calls[0][0]).toEqual(
      Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'history'))
    );
    expect(Object.isFrozen(result.inputs.poiInMerkleProofPathElements[0])).toBe(true);
  }
);
test('local entrypoint selects only fixed original-root core, no caller-selected mode', async () => {
  await restore(request());
  expect(core.reconstructRailgunRelayLocalWitness).toHaveBeenCalledTimes(1);
  expect(core.reconstructRailgunRelayWitness).not.toHaveBeenCalled();
  await expect(prepare({ ...request(), local: true })).rejects.toEqual(refused);
});
test.each([
  'inputNpk',
  'inputNoteType',
  'utxoTreeIn',
  'utxoPositionsIn',
  'valuesIn',
  'valuesOut',
  'digest',
  'nullifier',
  'commitment',
])('refuses changed genuine-core %s join', async (kind) => {
  const input = request();
  if (kind === 'inputNpk') mockCore.prePoi.inputNpk = 778n;
  if (kind === 'inputNoteType') mockCore.prePoi.inputNoteType = 'Transact';
  if (kind === 'utxoTreeIn') mockCore.prePoi.utxoTreeIn = 0;
  if (kind === 'utxoPositionsIn') mockCore.prePoi.utxoPositionsIn = [8];
  if (kind === 'valuesIn') mockCore.prePoi.valuesIn = [701n];
  if (kind === 'valuesOut') mockCore.prePoi.valuesOut = [600n, 100n];
  if (kind === 'digest') mockCore.publicReconstruction.draftDigest = 'f'.repeat(64);
  if (kind === 'nullifier') mockCore.witness.publicInputs.nullifiers = [88n];
  if (kind === 'commitment') mockCore.witness.publicInputs.commitmentsOut.reverse();
  await expect(prepare(input)).rejects.toEqual(refused);
});
test.each(['notes', 'witness', 'prePoi', 'hashPair', 'core', 'mode'])(
  'refuses caller-supplied %s before invoking core',
  async (key) => {
    await expect(prepare({ ...request(), [key]: {} })).rejects.toEqual(refused);
    expect(core.reconstructRailgunRelayWitness).not.toHaveBeenCalled();
  }
);
test('bad historical signature refuses before private reconstruction', async () => {
  const input = request();
  input.history.event.signedPOIEvent.signature = '00'.repeat(64);
  await expect(prepare(input)).rejects.toEqual(refused);
  expect(core.reconstructRailgunRelayWitness).not.toHaveBeenCalled();
});
test('historical caller mutation during actual core await cannot replace selected evidence', async () => {
  const input = request(),
    held = deferred();
  mockPrepare = jest.fn(() => held.promise);
  const original = prepare(input);
  expect(mockPrepare).toHaveBeenCalledTimes(1);
  input.history.proof.elements[0] = mockHex(99);
  input.history.note.type = 'Transact';
  input.history.event.signedPOIEvent.signature = '00'.repeat(64);
  held.resolve(mockCore);
  expect((await original).binding).toEqual(fixture().binding);
});
test.each(['core', 'poseidon'])(
  'abort while awaiting %s refuses without witness result',
  async (stage) => {
    const c = new AbortController(),
      input = request(fixture(), c.signal),
      held = deferred();
    if (stage === 'core') mockPrepare = jest.fn(() => held.promise);
    else mockInit = held.promise;
    const original = prepare(input);
    await Promise.resolve();
    c.abort();
    held.resolve(stage === 'core' ? mockCore : undefined);
    await expect(original).rejects.toEqual(refused);
  }
);
test('core failure cannot be replaced with caller note data or leak private error details', async () => {
  const input = request();
  mockPrepare = jest.fn(async () => {
    throw Error('private witness secret');
  });
  await expect(prepare(input)).rejects.toEqual(refused);
  await expect(prepare(input)).rejects.not.toHaveProperty('cause');
});
