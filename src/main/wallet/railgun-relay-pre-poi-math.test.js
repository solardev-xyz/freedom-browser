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

const { verifyRailgunRelayPrePoiPublicMath: verify } = require('./railgun-relay-pre-poi-math');
const refused = expect.objectContaining({ code: 'RAILGUN_RELAY_PRE_POI_MATH_REFUSED' });
function request(f = fixture(), signal = new AbortController().signal) {
  return {
    archive: '/fixture-engine.asar',
    draftText: f.draftText,
    history: copy(f.history),
    binding: copy(f.binding),
    signal,
  };
}
test.each([0, 7, 65535])(
  'derives exact root/signals for actual tree %i without private imports',
  async (tree) => {
    const f = fixture(tree),
      result = await verify(request(f));
    expect(result.publicSignals).toEqual(f.publicSignals);
    expect(result).toMatchObject({
      historicalEventSignatureVerified: true,
      historicalMembershipPathVerified: true,
      outputBlindingVerified: false,
      inputOwnershipVerified: false,
      proofVerified: false,
      currentMembershipVerified: false,
      authorityGranted: false,
    });
    expect(Object.isFrozen(result.publicSignals)).toBe(true);
    expect(Object.keys(result)).toEqual([
      'draftDigest',
      'historyDigest',
      'txidLeafHash',
      'txidMerkleroot',
      'publicSignals',
      'historicalEventSignatureVerified',
      'historicalMembershipPathVerified',
      'outputBlindingVerified',
      'inputOwnershipVerified',
      'proofVerified',
      'currentMembershipVerified',
      'authorityGranted',
    ]);
    const calls = mockPoseidon.mock.calls.map(([v]) => v);
    expect(calls.filter((v) => v.length === 13)).toEqual([
      [8n, ...Array(12).fill(mockZero)],
      [9n, 10n, ...Array(11).fill(mockZero)],
    ]);
    expect(calls.slice(-16).every((v) => v.length === 2 && v[1] === 0n)).toBe(true);
    expect(calls.at(-17)[1]).toBe(BigInt(tree));
    expect(calls.at(-17)[2]).toBe(13107334463n);
  }
);
test('bounded alternate blinds remain explicitly unverified; public-only math cannot recover NPK', async () => {
  const input = request();
  input.binding.blindedCommitmentsOut = ['0x' + mockHex(71), '0x' + mockHex(72)];
  const result = await verify(input);
  expect(result.publicSignals.slice(0, 2)).toEqual([71n, 72n]);
  expect(result.outputBlindingVerified).toBe(false);
  expect(result.proofVerified).toBe(false);
});
test.each([
  'leaf',
  'root',
  'path',
  'draft',
  'list',
  'signature',
  'event-prefix',
  'event-type',
  'event-index',
  'marker-shape',
])('refuses changed %s', async (kind) => {
  const input = request();
  if (kind === 'leaf') input.binding.txidLeafHash = mockHex(1);
  if (kind === 'root') input.binding.txidMerkleroot = mockHex(1);
  if (kind === 'path') {
    input.history.proof.elements[0] = mockHex(999);
    input.binding.listWitness = copy(input.history.proof);
  }
  if (kind === 'draft') input.history.draftDigest = 'f'.repeat(64);
  if (kind === 'list') input.history.listKey = 'f'.repeat(64);
  if (kind === 'signature') input.history.event.signedPOIEvent.signature = '00'.repeat(64);
  if (kind === 'event-prefix')
    input.history.event.signedPOIEvent.blindedCommitment =
      input.history.note.blindedCommitment.slice(2);
  if (kind === 'event-type') {
    input.history.note.type = 'Transact';
    input.history.event.signedPOIEvent.type = 'Transact';
  }
  if (kind === 'event-index') {
    input.history.proof.indices = mockHex(1);
    input.history.event.signedPOIEvent.index = 1;
    input.binding.listWitness = copy(input.history.proof);
  }
  if (kind === 'marker-shape') input.binding.railgunTxidIfHasUnshield = '0x01';
  await expect(verify(input)).rejects.toEqual(refused);
});
test('wrong-tree binding refuses even when both leaf/root came from one internally coherent other tree', async () => {
  const input = request(fixture(7)),
    other = fixture(0);
  input.binding.txidLeafHash = other.binding.txidLeafHash;
  input.binding.txidMerkleroot = other.binding.txidMerkleroot;
  await expect(verify(input)).rejects.toEqual(refused);
});
test('caller history/binding mutations across init await cannot replace admitted data', async () => {
  const held = deferred();
  mockInit = held.promise;
  const input = request(),
    expected = fixture().publicSignals;
  const original = verify(input);
  input.history.event.signedPOIEvent.signature = '00'.repeat(64);
  input.history.proof.root = mockHex(9);
  input.binding.blindedCommitmentsOut[0] = '0x' + mockHex(99);
  held.resolve();
  expect((await original).publicSignals).toEqual(expected);
});
test('abort during init refuses; unsigned historical validated root is not current membership', async () => {
  const held = deferred();
  mockInit = held.promise;
  const controller = new AbortController(),
    input = request(fixture(), controller.signal);
  const original = verify(input);
  controller.abort();
  held.resolve();
  await expect(original).rejects.toEqual(refused);
  mockInit = Promise.resolve();
  const second = request();
  second.history.event.validatedMerkleroot = mockHex(123);
  expect((await verify(second)).currentMembershipVerified).toBe(false);
});
test.each(['wallet', 'viewingKey', 'witness', 'poseidon', 'proof'])(
  'refuses injected %s capability or override',
  async (key) => {
    await expect(verify({ ...request(), [key]: {} })).rejects.toEqual(refused);
  }
);
test('signal proxy and own getter refuse without invocation', async () => {
  const trap = jest.fn(),
    input = request();
  input.signal = new Proxy(input.signal, { getPrototypeOf: trap });
  await expect(verify(input)).rejects.toEqual(refused);
  const other = request();
  Object.defineProperty(other.signal, 'aborted', { get: trap });
  await expect(verify(other)).rejects.toEqual(refused);
  expect(trap).not.toHaveBeenCalled();
});
