/** Public structural own-transaction fixture; proof/ciphertext are not valid crypto. */
const { Interface } = require('ethers');
const {
  extractRailgunTransactIntent,
  railgunTransactJournalIntent,
} = require('../../src/main/wallet/railgun-transact-intent');
const {
  inspectRailgunTransactReceipt,
  PRIVATE_EVENTS,
} = require('../../src/main/wallet/railgun-transact-receipt');
const { fixture } = require('./railgun-transact-data');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const abi = new Interface(PRIVATE_EVENTS);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function sample(unshield = false, archived = false, commitment) {
  const f = fixture(unshield);
  if (commitment) f.inner.commitments = [commitment];
  const original = f.transaction();
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
  const events = [
    ['Nullified', [0, f.inner.nullifiers]],
    unshield
      ? ['Unshield', [f.recipient, [0, pins.wrappedNative, 0], 998, 2]]
      : ['Transact', [1, 123, f.inner.commitments, f.inner.boundParams.commitmentCiphertext]],
  ];
  const receipt = {
    status: '0x1',
    transactionHash: transaction.hash,
    from: transaction.from,
    to: pins.proxy,
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
    logs: events.map(([name, values], i) => ({
      ...abi.encodeEventLog(name, values),
      address: pins.proxy,
      transactionHash: transaction.hash,
      blockHash: transaction.blockHash,
      blockNumber: transaction.blockNumber,
      transactionIndex: transaction.transactionIndex,
      logIndex: i ? '0x8' : '0x5',
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
  const recipient = unshield ? f.recipient : '0zk1' + 'q'.repeat(123);
  const capsule = {
    version: 1,
    walletId: '1'.repeat(64),
    engineSha256: '2'.repeat(64),
    selection: { kind: decoded.expected.kind, tree: 0, position: 1, recipient },
    preparation: {
      transaction: decoded.intent,
      expected: decoded.expected,
      expectedHash: hex(20),
      recipient,
      amount: '1000',
    },
    noteHash: hex(21),
    pathElements: Array(16).fill(hex(22)),
  };
  const row = {
    version: 'V2',
    graphID: hex(291) + hex(4).slice(2) + '0'.repeat(64),
    commitments: [decoded.expected.commitment],
    nullifiers: [decoded.expected.nullifier],
    boundParamsHash: decoded.expected.boundParamsHash,
    blockNumber: 291,
    txid: transaction.hash.slice(2),
    timestamp: 1000,
    utxoTreeIn: 0,
    utxoTreeOut: unshield ? 99999 : 1,
    utxoBatchStartPositionOut: unshield ? 99999 : 123,
    verificationHash: hex(23),
    ...(unshield
      ? {
          unshield: {
            tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
            toAddress: f.recipient,
            value: '1000',
          },
        }
      : {}),
  };
  return JSON.parse(JSON.stringify({ capsule, record, transaction, receipt, row }));
}
module.exports = { sample };
