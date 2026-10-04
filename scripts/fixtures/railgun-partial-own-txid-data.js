/** Public structural partial fixture: dummy proof/ciphertext, no ownership or spend authority.
 * Native callers replace commitments using the pinned engine before building evidence.
 */
const { Interface } = require('ethers');
const { createRailgunPartialCapsuleData } = require('./railgun-partial-capsule-data');
const {
  extractRailgunTransactIntent,
  railgunTransactJournalIntent,
} = require('../../src/main/wallet/railgun-transact-intent');
const {
  inspectRailgunTransactReceipt,
  PRIVATE_EVENTS,
} = require('../../src/main/wallet/railgun-transact-receipt');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { treasury } = require('../../src/main/wallet/railgun-transact-receipt-policy');
const abi = new Interface([
  ...PRIVATE_EVENTS,
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function samplePartial({
  inputAmount = '1000',
  unshieldAmount = '400',
  recipient = '0x' + '12'.repeat(20),
  commitments,
  archived = false,
} = {}) {
  const f = createRailgunPartialCapsuleData({ inputAmount, unshieldAmount });
  f.inner.unshieldPreimage.npk = hex(BigInt(recipient));
  if (commitments) f.inner.commitments = [...commitments];
  f.inner.proof = { a: { x: 1, y: 2 }, b: { x: [3, 4], y: [5, 6] }, c: { x: 7, y: 8 } };
  const original = {
    chainId: pins.chainId,
    to: pins.proxy,
    from: '0x' + '34'.repeat(20),
    value: '0',
    data: f.encode(),
  };
  const decoded = extractRailgunTransactIntent(original);
  const transaction = {
    ...original,
    chainId: '0xaa36a7',
    value: '0x0',
    input: original.data,
    hash: hex(100),
    nonce: '0x3',
    blockNumber: '0x123',
    blockHash: hex(200),
    transactionIndex: '0x4',
  };
  delete transaction.data;
  const fee = (BigInt(unshieldAmount) * 25n) / 10000n;
  const received = BigInt(unshieldAmount) - fee;
  const events = [
    [pins.proxy, 'Nullified', [0, f.inner.nullifiers]],
    [pins.wrappedNative, 'Transfer', [pins.proxy, recipient, received]],
    [pins.wrappedNative, 'Transfer', [pins.proxy, treasury, fee]],
    [pins.proxy, 'Unshield', [recipient, [0, pins.wrappedNative, 0], received, fee]],
    [
      pins.proxy,
      'Transact',
      [1, 123, [f.inner.commitments[0]], f.inner.boundParams.commitmentCiphertext],
    ],
  ];
  const receipt = {
    status: '0x1',
    transactionHash: transaction.hash,
    from: transaction.from,
    to: pins.proxy,
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
    logs: events.map(([address, name, values], i) => ({
      ...abi.encodeEventLog(name, values),
      address,
      transactionHash: transaction.hash,
      blockHash: transaction.blockHash,
      blockNumber: transaction.blockNumber,
      transactionIndex: transaction.transactionIndex,
      logIndex: '0x' + (5 + i).toString(16),
      removed: false,
    })),
  };
  let record = {
    hash: transaction.hash,
    nonce: 3,
    intent: railgunTransactJournalIntent(original),
    state: 'submitted',
    attemptedAt: 0,
    revision: 2,
    observation: {
      status: 'included',
      blockNumber: 291,
      blockHash: transaction.blockHash,
      confirmations: 4,
      trust: 'unverified',
      observedAt: 1,
    },
  };
  const railgun = {
    outcome: 'matched',
    finalizedBlockNumber: 300,
    finalizedBlockHash: hex(201),
    transact: inspectRailgunTransactReceipt(record, transaction, receipt),
  };
  record.resolution = {
    minimumConfirmations: 3,
    reviewedAt: 0,
    blockHash: transaction.blockHash,
    railgun,
  };
  if (archived)
    record = {
      hash: record.hash,
      nonce: record.nonce,
      intent: record.intent,
      status: 'included',
      blockNumber: 291,
      blockHash: transaction.blockHash,
      archivedAt: 10,
      finalized: { blockNumber: 301, blockHash: hex(202) },
      railgun,
    };
  const capsule = {
    ...f.capsule,
    selection: { ...f.capsule.selection, recipient },
    preparation: {
      ...f.capsule.preparation,
      transaction: decoded.intent,
      expected: decoded.expected,
      recipient,
    },
  };
  const row = {
    version: 'V2',
    graphID: hex(291) + hex(4).slice(2) + '0'.repeat(64),
    commitments: [...f.inner.commitments],
    nullifiers: [...f.inner.nullifiers],
    boundParamsHash: decoded.expected.boundParamsHash,
    blockNumber: 291,
    txid: transaction.hash.slice(2),
    timestamp: 1000,
    utxoTreeIn: 0,
    utxoTreeOut: 1,
    utxoBatchStartPositionOut: 123,
    verificationHash: hex(23),
    unshield: {
      tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      toAddress: recipient,
      value: unshieldAmount,
    },
  };
  return JSON.parse(JSON.stringify({ capsule, record, transaction, receipt, row }));
}
module.exports = { samplePartial };
