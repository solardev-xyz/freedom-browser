// Structural joins with actual ABI/receipt/matcher. No spend proof or enrollment
// is fabricated by these unit vectors; native supplies the genuine continuation.
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const { PRIVATE_EVENTS } = require('../../src/main/wallet/railgun-transact-receipt');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { treasury } = require('../../src/main/wallet/railgun-transact-receipt-policy');
const data = require('./railgun-combined-poi-terminal-data');
const { matchRailgunOwnTxid } = require('../../src/main/wallet/railgun-own-txid');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const clone = (v) => JSON.parse(JSON.stringify(v));
const abi = new Interface([
  ...PRIVATE_EVENTS,
  TRANSACT_ABI,
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const { vector } = require('./railgun-combined-poi-terminal-test-data.fixture');
let v;
beforeEach(() => {
  v = vector();
});
test('actual calldata/capture/receipt yields gross full-unshield sentinel row and real matcher', () => {
  const { row, finalized } = data.rowFromSecond(v.second, v.first, v.header);
  expect(row.commitments).toHaveLength(1);
  expect(row.unshield.value).toBe('600');
  expect(row.graphID.slice(130)).toBe('0'.repeat(64));
  expect(finalized).toBe(321);
  expect(
    matchRailgunOwnTxid({
      ...v.second,
      capsule: v.second.capture.capsule,
      record: v.second.capture.record,
      row: { ...row, verificationHash: hex(23) },
    }).output.kind
  ).toBe('unshield');
});
test.each([
  [
    'different calldata',
    (v) => {
      v.second.transaction.input += '00';
    },
  ],
  [
    'wrong submitter',
    (v) => {
      v.second.capture.submitter = '0x' + '56'.repeat(20);
    },
  ],
  [
    'wrong C',
    (v) => {
      v.first.ownEvidence.capsule.preparation.changeAmount = '601';
    },
  ],
  [
    'wrong first change hash',
    (v) => {
      v.first.ownEvidence.capsule.preparation.expected.changeCommitment = hex(402);
    },
  ],
  [
    'unbound finalized anchor',
    (v) => {
      v.second.capture.projection.railgun.finalizedBlockHash = hex(403);
    },
  ],
  [
    'missing nullifier log',
    (v) => {
      v.second.receipt.logs.shift();
    },
  ],
  [
    'extra log',
    (v) => {
      v.second.receipt.logs.push(v.second.receipt.logs[3]);
    },
  ],
  [
    'reordered transfer',
    (v) => {
      [v.second.receipt.logs[1], v.second.receipt.logs[2]] = [
        v.second.receipt.logs[2],
        v.second.receipt.logs[1],
      ];
    },
  ],
  [
    'foreign log',
    (v) => {
      v.second.receipt.logs[1].address = '0x' + '77'.repeat(20);
    },
  ],
])('rejects %s before projection', (_name, mutate) => {
  mutate(v);
  expect(() => data.rowFromSecond(v.second, v.first, v.header)).toThrow();
});
function scans({ inputAmount = 1000n, changeAmount = 600n, unrelatedAmount } = {}) {
  const first = v.first.ownEvidence;
  first.capsule.preparation.inputAmount = inputAmount.toString();
  first.capsule.preparation.changeAmount = changeAmount.toString();
  const asset = { __type: 'erc20', contract: pins.wrappedNative };
  const original = {
    id: `${first.capsule.selection.tree}:${first.capsule.selection.position}`,
    hash: first.capsule.noteHash,
    amount: inputAmount,
    spentTxid: first.record.hash,
    txid: hex(88),
    asset,
  };
  const change = {
    id: '1:123',
    hash: first.capsule.preparation.expected.changeCommitment,
    amount: changeAmount,
    spentTxid: false,
    txid: first.record.hash,
    asset,
  };
  const before = {
    checkpointHash: 'a'.repeat(64),
    trees: [{ tree: 1, length: 124, root: hex(55) }],
    ownedPoi: [{ id: change.id, txid: first.record.hash, nullifier: hex(299) }],
    read: { received: [original, change] },
  };
  const after = {
    ...before,
    checkpointHash: 'b'.repeat(64),
    read: { received: [original, { ...change, spentTxid: v.second.capture.record.hash }] },
  };
  if (unrelatedAmount !== undefined) {
    const unrelated = {
      ...change,
      id: '1:122',
      hash: hex(122),
      txid: hex(92),
      amount: unrelatedAmount,
    };
    before.read.received.push(unrelated);
    after.read.received.push({ ...unrelated, asset: { ...unrelated.asset } });
    before.ownedPoi.push({ id: unrelated.id, txid: unrelated.txid, nullifier: hex(122) });
  }
  return { before, after, change };
}
test('spent history remains and only unspent WETH sum becomes zero', () => {
  const { before, after, change } = scans();
  const snapshot = data.beforeSecond(before, v.first, change);
  expect(snapshot).not.toBe(before);
  data.assertScanned(snapshot, after, v.first, v.second);
});
test.each([
  ['Shield', 2000n, 1000n, 700n],
  ['Transact', 700n, 350n, 2000n],
])(
  '%s source preserves unrelated unspent WETH after spending only its change',
  (_kind, inputAmount, changeAmount, unrelatedAmount) => {
    const { before, after, change } = scans({ inputAmount, changeAmount, unrelatedAmount });
    const snapshot = data.beforeSecond(before, v.first, change);
    expect(snapshot.read.received.filter((note) => note.spentTxid === false)).toHaveLength(2);
    data.assertScanned(snapshot, after, v.first, v.second);
    expect(
      after.read.received.filter((note) => note.spentTxid === false).map((note) => note.amount)
    ).toEqual([unrelatedAmount]);
  }
);
test.each(['amount', 'spender', 'missing', 'new note'])(
  'refuses unrelated WETH %s drift despite correctly spent change',
  (kind) => {
    const { before, after } = scans({ unrelatedAmount: 700n });
    if (kind === 'amount') after.read.received[2].amount += 1n;
    if (kind === 'spender') after.read.received[2].spentTxid = v.second.capture.record.hash;
    if (kind === 'missing') after.read.received.pop();
    if (kind === 'new note') after.read.received.push({ ...after.read.received[2], id: '1:124' });
    expect(() => data.assertScanned(before, after, v.first, v.second)).toThrow();
  }
);
test('unchanged scanned nullifier must match the second capsule expected nullifier', () => {
  const { before, after } = scans({ unrelatedAmount: 700n });
  data.assertScanned(before, after, v.first, v.second);
  const mismatch = clone(v.second);
  mismatch.capture.capsule.preparation.expected.nullifier = hex(999);
  expect(after.ownedPoi).toEqual(before.ownedPoi);
  expect(() => data.assertScanned(before, after, v.first, mismatch)).toThrow();
});
test('duplicate selected change refuses even among unrelated unspent notes', () => {
  const { before, change } = scans({ unrelatedAmount: 700n });
  before.read.received.push({ ...change });
  expect(() => data.beforeSecond(before, v.first, change)).toThrow();
});
test.each([
  'stale checkpoint',
  'unspent change',
  'wrong spender',
  'new root',
  'new leaf',
  'wrong nullifier',
  'missing original',
  'new output',
  'extra unspent WETH',
])('refuses %s scan', (name) => {
  const { before, after, change } = scans();
  if (name === 'stale checkpoint') after.checkpointHash = before.checkpointHash;
  if (name === 'unspent change') after.read.received[1].spentTxid = false;
  if (name === 'wrong spender') after.read.received[1].spentTxid = hex(999);
  if (name === 'new root') after.trees = [{ ...after.trees[0], root: hex(999) }];
  if (name === 'new leaf') after.trees = [{ ...after.trees[0], length: 125 }];
  if (name === 'wrong nullifier') after.ownedPoi = [{ ...after.ownedPoi[0], nullifier: hex(999) }];
  if (name === 'missing original') after.read.received.shift();
  if (name === 'new output')
    after.read.received.push({ ...change, id: '1:124', txid: v.second.capture.record.hash });
  if (name === 'extra unspent WETH') before.read.received.push({ ...change, id: '1:124' });
  expect(() => data.assertScanned(before, after, v.first, v.second)).toThrow();
});
test('equal recipient and treasury with zero fee retains two distinct transfers', () => {
  const row = {
    txid: hex(5).slice(2),
    blockNumber: 10,
    graphID: hex(10) + hex(0).slice(2) + hex(0).slice(2),
    utxoTreeIn: 0,
    nullifiers: [hex(8)],
    unshield: { toAddress: treasury, value: '1' },
  };
  const receipt = {
    status: '0x1',
    transactionHash: hex(5),
    blockNumber: '0xa',
    blockHash: hex(1010),
    transactionIndex: '0x0',
  };
  receipt.logs = [
    [pins.proxy, 'Nullified', [0, [hex(8)]]],
    [pins.wrappedNative, 'Transfer', [pins.proxy, treasury, 1]],
    [pins.wrappedNative, 'Transfer', [pins.proxy, treasury, 0]],
    [pins.proxy, 'Unshield', [treasury, [0, pins.wrappedNative, 0], 1, 0]],
  ].map(([address, name, args], i) => ({
    ...abi.encodeEventLog(name, args),
    address,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    transactionHash: receipt.transactionHash,
    transactionIndex: '0x0',
    logIndex: '0x' + i,
    removed: false,
  }));
  expect(data.assertReceipt(receipt, row)).toHaveLength(2);
  const changed = clone(receipt);
  changed.logs.splice(2, 1);
  expect(() => data.assertReceipt(changed, row)).toThrow();
});
