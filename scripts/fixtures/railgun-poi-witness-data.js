/** Synthetic mined receipt/journal and actual projection around a real fixture
 * transaction. These observations are not network or enrollment evidence.
 */
const assert = require('assert/strict'),
  path = require('path');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const {
  PRIVATE_EVENTS,
  inspectRailgunTransactReceipt,
} = require('../../src/main/wallet/railgun-transact-receipt');
const { railgunTransactJournalIntent } = require('../../src/main/wallet/railgun-transact-intent');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
exports.createPoiWitnessData = async ({ archive, capsule, proof }) => {
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  const { Prover } = imp('prover/prover');
  const abi = new Interface([TRANSACT_ABI]),
    events = new Interface(PRIVATE_EVENTS);
  const raw = abi
    .decodeFunctionData('transact', capsule.preparation.transaction.data)[0][0]
    .toArray(true);
  raw[0] = Prover.formatProof(proof);
  const tx = {
    ...capsule.preparation.transaction,
    from: '0x' + '34'.repeat(20),
    data: abi.encodeFunctionData('transact', [[raw]]),
  };
  const [[decoded]] = abi.decodeFunctionData('transact', tx.data);
  const partial = capsule.selection.kind === 'railgun-partial-unshield';
  const unshield = capsule.selection.kind === 'railgun-token-unshield';
  const hasUnshield = unshield || partial;
  const amount = partial ? BigInt(capsule.preparation.unshieldAmount) : 1000n;
  const fee = (amount * 25n) / 10000n;
  const transaction = {
    ...tx,
    chainId: '0xaa36a7',
    value: '0x0',
    input: tx.data,
    hash: hex(100),
    nonce: '0x3',
    blockNumber: '0x123',
    blockHash: hex(200),
    transactionIndex: '0x4',
  };
  delete transaction.data;
  const e = partial
    ? [
        ['Nullified', [0, decoded.nullifiers]],
        ['Transfer', [pins.proxy, capsule.selection.recipient, amount - fee]],
        [
          'Transfer',
          [
            pins.proxy,
            require('../../src/main/wallet/railgun-transact-receipt-policy').treasury,
            fee,
          ],
        ],
        ['Unshield', [capsule.selection.recipient, [0, pins.wrappedNative, 0], amount - fee, fee]],
        [
          'Transact',
          [1, 23456, [decoded.commitments[0]], decoded.boundParams.commitmentCiphertext],
        ],
      ]
    : [
        ['Nullified', [0, decoded.nullifiers]],
        unshield
          ? ['Unshield', [capsule.selection.recipient, [0, pins.wrappedNative, 0], 998, 2]]
          : ['Transact', [1, 23456, decoded.commitments, decoded.boundParams.commitmentCiphertext]],
      ];
  const transfers = new Interface([
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ]);
  const receipt = {
    status: '0x1',
    transactionHash: transaction.hash,
    from: transaction.from,
    to: pins.proxy,
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
    logs: e.map(([name, values], i) => ({
      ...(name === 'Transfer' ? transfers : events).encodeEventLog(name, values),
      address: name === 'Transfer' ? pins.wrappedNative : pins.proxy,
      transactionHash: transaction.hash,
      blockHash: transaction.blockHash,
      blockNumber: transaction.blockNumber,
      transactionIndex: transaction.transactionIndex,
      logIndex: partial ? '0x' + (5 + i).toString(16) : i ? '0x8' : '0x5',
      removed: false,
    })),
  };
  const record = {
    hash: transaction.hash,
    nonce: 3,
    intent: railgunTransactJournalIntent(tx),
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
  const outcome = inspectRailgunTransactReceipt(record, transaction, receipt);
  assert.equal(outcome.status, 'matched');
  record.resolution = {
    minimumConfirmations: 3,
    reviewedAt: 0,
    blockHash: transaction.blockHash,
    railgun: {
      outcome: 'matched',
      finalizedBlockNumber: 300,
      finalizedBlockHash: hex(201),
      transact: outcome,
    },
  };
  const row = {
    version: 'V2',
    graphID: hex(291) + hex(4).slice(2) + '0'.repeat(64),
    commitments: partial
      ? [
          capsule.preparation.expected.changeCommitment,
          capsule.preparation.expected.unshieldCommitment,
        ]
      : [capsule.preparation.expected.commitment],
    nullifiers: [capsule.preparation.expected.nullifier],
    boundParamsHash: capsule.preparation.expected.boundParamsHash,
    blockNumber: 291,
    txid: transaction.hash.slice(2),
    timestamp: 1000,
    utxoTreeIn: 0,
    utxoTreeOut: unshield ? 99999 : 1,
    utxoBatchStartPositionOut: unshield ? 99999 : 23456,
    ...(hasUnshield
      ? {
          unshield: {
            tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
            toAddress: capsule.selection.recipient,
            value: amount.toString(),
          },
        }
      : {}),
  };
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = imp(
    'transaction/railgun-txid'
  );
  const { poseidonHex } = imp('utils/poseidon');
  const projection =
    require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
      hashPair: (a, b) => poseidonHex([a, b]),
      transactionHash: createRailgunTransactionWithHash,
      verificationHash: calculateRailgunTransactionVerificationHash,
      zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
    });
  let previous;
  const rows = Array.from({ length: 7 }, (_, i) => {
    const value =
      i === 5
        ? row
        : {
            version: 'V2',
            graphID: hex(286 + i) + hex(0).slice(2) + '0'.repeat(64),
            commitments: [hex(i + 1)],
            nullifiers: [hex(i + 11)],
            boundParamsHash: hex(100),
            blockNumber: 286 + i,
            txid: hex(i + 50).slice(2),
            timestamp: 1000,
            utxoTreeIn: 0,
            utxoTreeOut: 0,
            utxoBatchStartPositionOut: i,
          };
    previous = calculateRailgunTransactionVerificationHash(previous, value.nullifiers[0]);
    value.verificationHash = previous;
    return value;
  });
  const values = new Map(),
    read = async (key) => values.get(key) ?? null;
  const added = await projection.append(projection.empty(), rows, read);
  added.writes.forEach(({ key, value }) => values.set(key, value));
  const witness = await projection.witness(
    added.state,
    createRailgunTransactionWithHash(row).railgunTxid,
    read
  );
  assert.equal(witness.index, 5);
  assert.equal(witness.checkpointIndex, 6);
  return {
    ownEvidence: { capsule, record, transaction, receipt, row },
    state: added.state,
    witness,
  };
};
