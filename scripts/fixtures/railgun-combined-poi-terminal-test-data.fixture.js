/** Structural unit-only data, dummy proof; never used by native qualification. */
const { Interface } = require('ethers');
const { sample } = require('./railgun-own-txid-data');
const { samplePartial } = require('./railgun-partial-own-txid-data');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const {
  PRIVATE_EVENTS,
  inspectRailgunTransactReceipt,
} = require('../../src/main/wallet/railgun-transact-receipt');
const {
  extractRailgunTransactIntent,
  railgunTransactJournalIntent,
} = require('../../src/main/wallet/railgun-transact-intent');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { treasury } = require('../../src/main/wallet/railgun-transact-receipt-policy');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const abi = new Interface([
  ...PRIVATE_EVENTS,
  TRANSACT_ABI,
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
function vector() {
  const one = samplePartial();
  const two = sample(true);
  // Re-encode coherent gross C (600) and distinct second transaction identity.
  const inner = abi.decodeFunctionData('transact', two.transaction.input)[0][0].toArray(true);
  inner[5][2] = 600n;
  inner[2] = [hex(299)];
  const bytes = abi.encodeFunctionData('transact', [[inner]]);
  const transaction = {
    ...two.transaction,
    input: bytes,
    hash: hex(301),
    blockNumber: '0x137',
    blockHash: hex(1311),
    transactionIndex: '0x0',
  };
  const decoded = extractRailgunTransactIntent({
    chainId: transaction.chainId,
    to: transaction.to,
    value: transaction.value,
    data: bytes,
  });
  const capsule = {
    ...two.capsule,
    noteHash: one.capsule.preparation.expected.changeCommitment,
    preparation: {
      ...two.capsule.preparation,
      transaction: decoded.intent,
      expected: decoded.expected,
      amount: '600',
    },
  };
  const receipt = {
    ...two.receipt,
    blockNumber: transaction.blockNumber,
    blockHash: transaction.blockHash,
    transactionHash: transaction.hash,
    transactionIndex: '0x0',
  };
  const events = [
    [pins.proxy, 'Nullified', [0, [hex(299)]]],
    [pins.wrappedNative, 'Transfer', [pins.proxy, decoded.expected.recipient, 599]],
    [pins.wrappedNative, 'Transfer', [pins.proxy, treasury, 1]],
    [pins.proxy, 'Unshield', [decoded.expected.recipient, [0, pins.wrappedNative, 0], 599, 1]],
  ];
  receipt.logs = events.map(([address, name, args], i) => ({
    ...abi.encodeEventLog(name, args),
    address,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    transactionHash: receipt.transactionHash,
    transactionIndex: '0x0',
    logIndex: '0x' + i.toString(16),
    removed: false,
  }));
  const record = {
    ...two.record,
    hash: transaction.hash,
    intent: railgunTransactJournalIntent({
      ...decoded.intent,
      data: bytes,
      from: transaction.from,
    }),
    observation: { ...two.record.observation, blockNumber: 311, blockHash: transaction.blockHash },
  };
  const railgun = {
    outcome: 'matched',
    finalizedBlockNumber: 321,
    finalizedBlockHash: hex(1321),
    transact: inspectRailgunTransactReceipt(record, transaction, receipt),
  };
  record.resolution = { ...record.resolution, blockHash: transaction.blockHash, railgun };
  const capture = {
    capsule,
    record,
    provedTransaction: { ...decoded.intent, data: bytes },
    submitter: transaction.from,
    projection: { railgun },
  };
  return {
    first: { ownEvidence: one },
    second: { capture, transaction, receipt },
    header: (n) => ({ hash: hex(n + 1000), timestamp: '0x' + n.toString(16) }),
  };
}
module.exports = { vector };
