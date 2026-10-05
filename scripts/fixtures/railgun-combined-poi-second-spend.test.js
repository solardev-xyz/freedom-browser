// Pure fixture joins, not a substitute for the genuine registry/native path.
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const { selectChange } = require('./railgun-combined-poi-second-spend');
const { samplePartial } = require('./railgun-partial-own-txid-data');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let owned, continuation;
beforeEach(() => {
  const first = samplePartial();
  continuation = { ownEvidence: first };
  const note = {
    id: '1:123',
    tree: 1,
    position: 123,
    txid: '0x' + first.row.txid,
    hash: first.capsule.preparation.expected.changeCommitment,
    amount: 600n,
    spentTxid: false,
  };
  owned = {
    read: { received: [note] },
    ownedPoi: [
      {
        id: note.id,
        hash: note.hash,
        txid: note.txid,
        type: 'Transact',
        nullifier: hex(199),
        blindedCommitment: hex(200),
      },
    ],
    trees: [{ tree: 1, root: hex(201), length: 124 }],
  };
});
test('actual partial structural evidence joins one remaining owned change', () => {
  const found = selectChange(owned, continuation);
  expect(found.note).toBe(owned.read.received[0]);
  expect(found.record).toBe(owned.ownedPoi[0]);
  expect(found.merkleRoot).toBe(hex(201));
});
test.each([
  [
    'old nullifier',
    () => {
      owned.ownedPoi[0].nullifier = continuation.ownEvidence.capsule.preparation.expected.nullifier;
    },
  ],
  [
    'old UTXO root',
    () => {
      owned.trees[0].root = continuation.ownEvidence.capsule.preparation.expected.merkleRoot;
    },
  ],
  [
    'spent change',
    () => {
      owned.read.received[0].spentTxid = hex(202);
    },
  ],
  [
    'wrong amount',
    () => {
      owned.read.received[0].amount = 599n;
    },
  ],
  [
    'wrong commitment',
    () => {
      owned.ownedPoi[0].hash = hex(203);
    },
  ],
  [
    'wrong record identity',
    () => {
      owned.ownedPoi[0].id = '1:122';
    },
  ],
  [
    'wrong creator type',
    () => {
      owned.ownedPoi[0].type = 'Shield';
    },
  ],
  [
    'wrong first transaction',
    () => {
      owned.ownedPoi[0].txid = hex(204);
    },
  ],
  [
    'duplicate note',
    () => {
      owned.read.received.push({ ...owned.read.received[0] });
    },
  ],
  [
    'duplicate record',
    () => {
      owned.ownedPoi.push({ ...owned.ownedPoi[0] });
    },
  ],
  [
    'outside tree',
    () => {
      owned.trees[0].length = 123;
    },
  ],
  [
    'missing tree',
    () => {
      owned.trees = [];
    },
  ],
])('%s refuses before selection', (_name, mutate) => {
  mutate();
  expect(() => selectChange(owned, continuation)).toThrow();
});
