const { createHash } = require('crypto');
// Real projection/path and input normalization, deterministic test hashes in
// place of the pinned engine's Poseidon. Native crypto is qualified separately.
const mockHash = (value) => '0' + createHash('sha256').update(value).digest('hex').slice(1);
const mockPair = (a, b) => mockHash(a + b);
const mockZeros = [mockHash('zero')];
for (let i = 0; i < 16; i++) mockZeros.push(mockPair(mockZeros[i], mockZeros[i]));
const mockTransactionHash = (row) => ({
  hash: mockHash(JSON.stringify(row)),
  railgunTxid: mockHash(JSON.stringify([row.nullifiers, row.commitments, row.boundParamsHash])),
});
const mockVerificationHash = (previous, nullifier) => '0x' + mockHash((previous ?? '') + nullifier);
const mockNoteHash = (to, token, value) =>
  BigInt('0x' + mockHash(JSON.stringify([to, token, value.toString()])));
let mockReady, mockGetNoteHash, mockValidateToken;
jest.mock('module', () => ({
  ...jest.requireActual('module'),
  createRequire: () => ({ resolve: () => '/fixture-own-txid/engine/index.js' }),
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((v) => v) }));
jest.mock('./railgun-public-records', () => ({ ZERO_NODES: mockZeros }));
jest.mock(
  '/fixture-own-txid/engine/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockReady;
    },
    poseidonHex: ([a, b]) => mockPair(a, b),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-own-txid/engine/transaction/railgun-txid',
  () => ({
    createRailgunTransactionWithHash: (row) => mockTransactionHash(row),
    calculateRailgunTransactionVerificationHash: (previous, nullifier) =>
      mockVerificationHash(previous, nullifier),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-own-txid/engine/note/note-util',
  () => ({
    getNoteHash: (...args) => mockGetNoteHash(...args),
    assertValidNoteToken: (...args) => mockValidateToken(...args),
  }),
  { virtual: true }
);
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { run } = require('./railgun-own-txid-job');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let controller, request, guardReport;
beforeEach(() => {
  jest.clearAllMocks();
  mockReady = Promise.resolve();
  mockGetNoteHash = jest.fn(mockNoteHash);
  mockValidateToken = jest.fn();
  controller = new AbortController();
  request = jest.fn(async () => JSON.stringify({ id: 1, value: null }));
  guardReport = jest.fn(() => ({ attempts: 0, canaries: 1, hooks: ['test.guard'] }));
});
async function fixture(kind = 'partial', mutate = () => {}) {
  const row = sample(kind !== 'transfer').row;
  if (row.unshield) {
    row.unshield.value = kind === 'partial' ? '400' : '1000';
    row.commitments = [
      hex(mockNoteHash(row.unshield.toAddress, row.unshield.tokenData, BigInt(row.unshield.value))),
    ];
  }
  if (kind === 'partial') {
    row.commitments.unshift(hex(77));
    row.utxoTreeOut = 1;
    row.utxoBatchStartPositionOut = 123;
  }
  mutate(row);
  row.verificationHash = mockVerificationHash(undefined, row.nullifiers[0]);
  const projection = createRailgunTxidProjection({
    hashPair: mockPair,
    transactionHash: mockTransactionHash,
    verificationHash: mockVerificationHash,
    zeroNodes: mockZeros,
  });
  const values = new Map();
  const read = async (key) => values.get(key) ?? null;
  const { state, writes } = await projection.append(projection.empty(), [row], read);
  writes.forEach(({ key, value }) => values.set(key, value));
  const witness = await projection.witness(state, mockTransactionHash(row).railgunTxid, read);
  return JSON.parse(
    JSON.stringify({
      archive: '/fixture-own-txid.asar',
      bindingDigest: 'a'.repeat(64),
      state,
      witness,
    })
  );
}
const execute = (input) =>
  run(JSON.stringify(input), { request, signal: controller.signal, guardReport });
test.each(['transfer', 'unshield', 'partial'])(
  'verifies %s path and only the final unshield preimage without requesting keys',
  async (kind) => {
    const input = await fixture(kind);
    await execute(input);
    expect(request).toHaveBeenCalledTimes(1);
    const result = JSON.parse(request.mock.calls[0][0]);
    expect(result).toEqual({
      id: 1,
      method: 'result',
      value: {
        inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        bindingDigest: input.bindingDigest,
        railgunTxid: input.witness.railgunTxid,
        pathVerified: true,
        unshieldCommitmentVerified: kind !== 'transfer',
        sourceAuthenticated: false,
        rootAccepted: false,
        spendingEnabled: false,
        guards: guardReport(),
        inventory: require('./railgun-engine-manifest.json').inventory.sha256,
      },
    });
    if (kind === 'transfer') expect(mockGetNoteHash).not.toHaveBeenCalled();
    else {
      const u = input.witness.row.unshield;
      expect(mockGetNoteHash).toHaveBeenCalledTimes(1);
      expect(mockGetNoteHash).toHaveBeenCalledWith(u.toAddress, u.tokenData, BigInt(u.value));
      expect(mockValidateToken).toHaveBeenCalledWith(u.tokenData, BigInt(u.value));
    }
  }
);
test.each([
  ['swapped commitments', (r) => r.commitments.reverse()],
  ['wrong final commitment', (r) => (r.commitments[1] = hex(78))],
  ['wrong gross amount', (r) => (r.unshield.value = '399')],
  ['change amount as gross', (r) => (r.unshield.value = '600')],
  ['input amount as gross', (r) => (r.unshield.value = '1000')],
  ['wrong recipient', (r) => (r.unshield.toAddress = '0x' + '56'.repeat(20))],
])('rejects a path-valid partial row with %s at its preimage check', async (_name, mutate) => {
  // Rebuild a genuine test-hash path AFTER the change: failure cannot be
  // attributed merely to stale rowSha256 or a mismatched Merkle path.
  const input = await fixture('partial', mutate);
  await expect(execute(input)).rejects.toThrow();
  expect(mockGetNoteHash).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});
test.each([
  ['extra commitment', (r) => r.commitments.push(hex(79))],
  ['extra nullifier', (r) => r.nullifiers.push(hex(80))],
  ['out-of-range tree', (r) => (r.utxoTreeOut = 65536)],
  ['zero gross amount', (r) => (r.unshield.value = '0')],
  ['wrong token address', (r) => (r.unshield.tokenData.tokenAddress = '0x' + '56'.repeat(20))],
  ['wrong token type', (r) => (r.unshield.tokenData.tokenType = 1)],
  ['wrong token sub-ID', (r) => (r.unshield.tokenData.tokenSubID = hex(1))],
])('rejects path-valid but unsupported partial %s before hashing', async (_name, mutate) => {
  const input = await fixture('partial', mutate);
  await expect(execute(input)).rejects.toThrow();
  expect(mockGetNoteHash).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test.each([
  ['sentinel tree', (r) => (r.utxoTreeOut = 99999)],
  ['sentinel position', (r) => (r.utxoBatchStartPositionOut = 99999)],
  ['sentinel pair', (r) => ((r.utxoTreeOut = 99999), (r.utxoBatchStartPositionOut = 99999))],
  ['out-of-range position', (r) => (r.utxoBatchStartPositionOut = 65536)],
])('rejects partial %s during real witness normalization', async (_name, mutate) => {
  const input = await fixture();
  mutate(input.witness.row);
  input.witness.rowSha256 = createHash('sha256')
    .update(JSON.stringify(input.witness.row))
    .digest('hex');
  await expect(execute(input)).rejects.toThrow();
  expect(require('./railgun-engine-runtime').verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test('accepts the bounded change-coordinate edges', async () => {
  const input = await fixture('partial', (r) => {
    r.utxoTreeOut = 65535;
    r.utxoBatchStartPositionOut = 65535;
  });
  await execute(input);
  expect(request).toHaveBeenCalledTimes(1);
});
test('rejects a substituted path before checking the unshield preimage', async () => {
  const input = await fixture();
  input.witness.elements[0] = mockHash('substituted');
  await expect(execute(input)).rejects.toThrow();
  expect(mockGetNoteHash).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test('cancellation during engine initialization emits no result or preimage work', async () => {
  const input = await fixture();
  let release;
  mockReady = new Promise((resolve) => (release = resolve));
  const pending = execute(input);
  controller.abort();
  release();
  await expect(pending).rejects.toThrow();
  expect(mockGetNoteHash).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test('a guard violation cannot produce verification evidence', async () => {
  const input = await fixture();
  guardReport.mockReturnValue({ attempts: 1 });
  await expect(execute(input)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
