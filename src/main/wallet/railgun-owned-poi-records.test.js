const {
  projectRailgunOwnedPoiRecord: project,
  normalizeRailgunOwnedPoiRecords: normalize,
} = require('./railgun-owned-poi-records');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function fixture() {
  const leaf = {
    commitmentType: 'ShieldCommitment',
    utxoTree: 1,
    utxoIndex: 2,
    hash: hex(3),
    txid: hex(9),
    preImage: { npk: hex(4) },
    blockNumber: 6000000,
  };
  const txo = {
    commitmentType: leaf.commitmentType,
    tree: 1,
    position: 2,
    note: { hash: 3n, notePublicKey: 4n, tokenHash: hex(5), value: 6n },
    blindedCommitment: hex(7),
  };
  const runtime = {
    TransactNote: { getHash: jest.fn(() => 3n) },
    BlindedCommitment: { getForShieldOrTransact: jest.fn(() => hex(7)) },
    getGlobalTreePosition: jest.fn(() => 65538n),
  };
  return { leaf, txo, runtime };
}
test('uses the verified public position and independently recomputed commitment before blinding', () => {
  const { leaf, txo, runtime } = fixture();
  const record = project(txo, leaf, runtime);
  expect(runtime.TransactNote.getHash).toHaveBeenCalledWith(4n, hex(5), 6n);
  expect(runtime.BlindedCommitment.getForShieldOrTransact).toHaveBeenCalledWith(hex(3), 4n, 65538n);
  expect(record).toEqual({
    id: '1:2',
    hash: hex(3),
    txid: hex(9),
    npk: hex(4),
    blindedCommitment: hex(7),
    type: 'Shield',
    blockNumber: 6000000,
  });
});
test.each([
  'cached-blinding',
  'cached-hash',
  'recomputed-hash',
  'shield-key',
  'position',
  'type',
  'global-position',
])('refuses %s disagreement instead of exporting a query target', (mode) => {
  const { leaf, txo, runtime } = fixture();
  if (mode === 'cached-blinding') txo.blindedCommitment = hex(8);
  if (mode === 'cached-hash') txo.note.hash = 8n;
  if (mode === 'recomputed-hash') runtime.TransactNote.getHash.mockReturnValue(8n);
  if (mode === 'shield-key') leaf.preImage.npk = hex(8);
  if (mode === 'position') txo.position++;
  if (mode === 'type') txo.commitmentType = 'TransactCommitmentV2';
  if (mode === 'global-position') runtime.getGlobalTreePosition.mockReturnValue(2n);
  expect(() => project(txo, leaf, runtime)).toThrow();
});
function normalizedFixture() {
  const { leaf, txo, runtime } = fixture();
  return {
    input: [project(txo, leaf, runtime)],
    read: { received: [{ id: '1:2', hash: hex(3), txid: hex(9) }] },
    checkpoint: { to: { number: 6000000 } },
  };
}
test.each([
  'missing',
  'foreign',
  'duplicate',
  'hash',
  'txid',
  'future',
  'negative-block',
  'type',
  'extra',
  'field-overflow',
])('main refuses %s owned projection', (mode) => {
  const { input, read, checkpoint } = normalizedFixture();
  if (mode === 'missing') input.pop();
  if (mode === 'foreign') input[0].id = '1:3';
  if (mode === 'duplicate') {
    input.push({ ...input[0] });
    read.received.push({ id: '1:3', hash: hex(3) });
  }
  if (mode === 'hash') input[0].hash = hex(8);
  if (mode === 'txid') input[0].txid = hex(8);
  if (mode === 'future') input[0].blockNumber++;
  if (mode === 'negative-block') input[0].blockNumber = -1;
  if (mode === 'type') input[0].type = 'LegacyGeneratedCommitment';
  if (mode === 'extra') input[0].random = 'never retain';
  if (mode === 'field-overflow') input[0].npk = '0x' + 'f'.repeat(64);
  expect(() => normalize(input, read, checkpoint)).toThrow();
});
test('main copies immutable facts without promoting them to ownership or spending authority', () => {
  const { input, read, checkpoint } = normalizedFixture();
  const result = normalize(input, read, checkpoint);
  input[0].npk = hex(8);
  expect(result[0].npk).toBe(hex(4));
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result[0])).toBe(true);
  expect(result[0].spendingEnabled).toBeUndefined();
});
