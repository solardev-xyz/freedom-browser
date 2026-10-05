// Real normalizers, row projection/path and worker orchestration; deterministic
// toy engine functions below explicitly do NOT qualify Poseidon or Groth16.
const mockHash = (s) =>
  '0' + require('crypto').createHash('sha256').update(s).digest('hex').slice(1);
const mockPair = (a, b) => mockHash(a + b);
jest.mock('../../src/main/wallet/railgun-public-records', () => {
  const zeroNodes = [mockHash('zero')];
  for (let i = 0; i < 16; i++) zeroNodes.push(mockPair(zeroNodes[i], zeroNodes[i]));
  return {
    ...jest.requireActual('../../src/main/wallet/railgun-public-records'),
    ZERO_NODES: zeroNodes,
  };
});
const mockToken = '0'.repeat(63) + '2';
const mockNoteHash = (npk, value) => BigInt('0x' + mockHash(npk + ':' + value));
const mockUnshield = (address, value) => BigInt('0x' + mockHash(address + ':' + value));
jest.mock('../../src/main/wallet/railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (v) => v,
}));
jest.mock('module', () => ({
  ...jest.requireActual('module'),
  createRequire: () => ({ resolve: () => '/test/engine/index.js' }),
}));
jest.mock(
  '/test/engine/utils/poseidon',
  () => ({ initPoseidonPromise: Promise.resolve(), poseidonHex: ([a, b]) => mockPair(a, b) }),
  { virtual: true }
);
jest.mock(
  '/test/engine/transaction/railgun-txid',
  () => ({
    createRailgunTransactionWithHash: (r) => ({
      hash: mockHash(JSON.stringify(r)),
      railgunTxid: mockHash(r.nullifiers[0]),
    }),
    calculateRailgunTransactionVerificationHash: () => '0x' + (23).toString(16).padStart(64, '0'),
  }),
  { virtual: true }
);
jest.mock(
  '/test/engine/note/note-util',
  () => ({
    assertValidNoteToken: jest.fn(),
    getNoteHash: (address, _token, value) => mockUnshield(address, value),
    getTokenDataERC20: () => ({}),
    getTokenDataHash: () => mockToken,
  }),
  { virtual: true }
);
jest.mock(
  '/test/engine/note/transact-note',
  () => ({ TransactNote: { getHash: (npk, _token, value) => mockNoteHash(npk, value) } }),
  { virtual: true }
);
jest.mock(
  '/test/engine/poi/global-tree-position',
  () => ({ getGlobalTreePosition: (tree, position) => BigInt(tree) * 65536n + BigInt(position) }),
  { virtual: true }
);
jest.mock(
  '/test/engine/poi/blinded-commitment',
  () => ({
    BlindedCommitment: {
      getForShieldOrTransact: (hash, npk, position) =>
        '0x' + mockHash(hash + ':' + npk + ':' + position),
    },
  }),
  { virtual: true }
);
const { samplePartial } = require('./railgun-partial-own-txid-data');
const { createRailgunTxidProjection } = require('../../src/main/wallet/railgun-txid-projection');
const { ZERO_NODES } = require('../../src/main/wallet/railgun-public-records');
const { REQUIRED_LIST, verifyPoiMembership } = require('../../src/main/wallet/railgun-poi-records');
const { run } = require('./railgun-combined-poi-list-job');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let input, request, controller;
async function rebuild(evidence) {
  const projection = createRailgunTxidProjection({
    hashPair: mockPair,
    zeroNodes: ZERO_NODES,
    transactionHash: (r) => ({
      hash: mockHash(JSON.stringify(r)),
      railgunTxid: mockHash(r.nullifiers[0]),
    }),
    verificationHash: () => hex(23),
  });
  const map = new Map(),
    read = async (k) => map.get(k) ?? null;
  const { state, writes } = await projection.append(projection.empty(), [evidence.row], read);
  writes.forEach(({ key, value }) => map.set(key, value));
  const witness = await projection.witness(state, mockHash(evidence.row.nullifiers[0]), read);
  return { state, witness };
}
beforeEach(async () => {
  const npk = 3n,
    value = 600n,
    recipient = '0x' + '12'.repeat(20),
    hash = hex(mockNoteHash(npk, value)),
    unshield = hex(mockUnshield(recipient, 400n));
  const ownEvidence = samplePartial({ recipient, commitments: [hash, unshield] });
  const { state, witness } = await rebuild(ownEvidence);
  const blinded = '0x' + mockHash(hash + ':' + npk + ':' + (65536n + 123n));
  input = {
    archive: '/engine.asar',
    change: {
      hash,
      npk: hex(npk),
      blindedCommitment: blinded,
      tree: 1,
      position: 123,
      value: '600',
      tokenHash: '0x' + mockToken,
      txid: ownEvidence.transaction.hash,
      blockNumber: 291,
    },
    ownEvidence,
    state,
    witness,
    payload: {
      listKey: REQUIRED_LIST,
      proof: {
        pi_a: ['1', '2'],
        pi_b: [
          ['3', '4'],
          ['5', '6'],
        ],
        pi_c: ['7', '8'],
      },
      poiMerkleroots: [hex(3).slice(2)],
      txidMerkleroot: witness.root,
      txidMerklerootIndex: witness.checkpointIndex,
      blindedCommitmentsOut: [blinded],
      railgunTxidIfHasUnshield: '0x' + witness.railgunTxid,
    },
  };
  controller = new AbortController();
  request = jest.fn(async () => JSON.stringify({ id: 1, value: null }));
});
const execute = () =>
  run(JSON.stringify(input), {
    request,
    signal: controller.signal,
    guardReport: () => ({ attempts: 0, canaries: 1, hooks: ['test.guard'] }),
  });
test('independently binds change hash, own TXID, final unshield hash and actual Merkle relationships', async () => {
  await execute();
  expect(request).toHaveBeenCalledTimes(1);
  const { value } = JSON.parse(request.mock.calls[0][0]);
  expect(value.note).toEqual({
    blindedCommitment: input.change.blindedCommitment,
    type: 'Transact',
  });
  expect(verifyPoiMembership([value.proof], [value.note], mockPair)).toEqual([value.proof]);
  expect(value).toMatchObject({
    chainAuthenticated: false,
    ownershipAuthenticated: false,
    spendingEnabled: false,
  });
});
test.each(['npk', 'amount', 'token', 'position', 'blinded', 'T', 'root', 'path'])(
  'refuses independent %s substitution without publishing membership',
  async (mode) => {
    if (mode === 'npk') input.change.npk = hex(9);
    if (mode === 'amount') input.change.value = '599';
    if (mode === 'token') input.change.tokenHash = hex(9);
    if (mode === 'position') input.change.position++;
    if (mode === 'blinded') {
      input.change.blindedCommitment = hex(9);
      input.payload.blindedCommitmentsOut = [hex(9)];
    }
    if (mode === 'T') input.payload.railgunTxidIfHasUnshield = hex(9);
    if (mode === 'root') input.payload.txidMerkleroot = hex(9).slice(2);
    if (mode === 'path')
      input.witness = {
        ...input.witness,
        elements: [hex(9).slice(2), ...input.witness.elements.slice(1)],
      };
    await expect(execute()).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  }
);
test('path-valid wrong final unshield preimage refuses at independent pinned-engine hash comparison', async () => {
  const evidence = samplePartial({
    commitments: [input.change.hash, hex(mockUnshield('0x' + '12'.repeat(20), 399n))],
  });
  input.ownEvidence = evidence;
  Object.assign(input, await rebuild(evidence));
  input.payload.txidMerkleroot = input.witness.root;
  input.payload.railgunTxidIfHasUnshield = '0x' + input.witness.railgunTxid;
  await expect(execute()).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
test('abort and oversize input never publish', async () => {
  controller.abort();
  await expect(execute()).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  controller = new AbortController();
  input.extra = 'x'.repeat(65536);
  await expect(execute()).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

test('foreign NPK with coherently rebound blinded output still refuses the scanned commitment hash', async () => {
  input.change.npk = hex(9);
  input.change.blindedCommitment = '0x' + mockHash(input.change.hash + ':9:' + (65536n + 123n));
  input.payload.blindedCommitmentsOut = [input.change.blindedCommitment];
  await expect(execute()).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
