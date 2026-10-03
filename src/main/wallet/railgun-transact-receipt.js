/** Exact own-hash private outcome matching against unverified RPC data.
 * No proof, finality, POI, balance or retry authority follows from a match.
 * An alternate hash needs separate public input-spent/TXID reconciliation.
 */
const assert = require('assert/strict');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const {
  railgunTransactJournalIntent,
  validRailgunTransactIntent,
} = require('./railgun-transact-intent');
const pins = require('./railgun-shield-pins.json');
const PRIVATE_EVENTS = Object.freeze([
  'event Nullified(uint16 treeNumber,bytes32[] nullifier)',
  'event Transact(uint256 treeNumber,uint256 startPosition,bytes32[] hash,(bytes32[4] ciphertext,bytes32 blindedSenderViewingKey,bytes32 blindedReceiverViewingKey,bytes annotationData,bytes memo)[] ciphertext)',
  'event Unshield(address to,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint256 amount,uint256 fee)',
]);
const abi = new Interface([TRANSACT_ABI, ...PRIVATE_EVENTS]);
const quantity = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v);
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
function inspectRailgunTransactReceipt(record, transaction, receipt) {
  try {
    assert.ok(validRailgunTransactIntent(record?.intent) && hash(record.hash));
    assert.equal(transaction?.hash?.toLowerCase(), record.hash);
    assert.ok(quantity(transaction.nonce) && BigInt(transaction.nonce) === BigInt(record.nonce));
    assert.ok(
      quantity(transaction.chainId) && BigInt(transaction.chainId) === BigInt(pins.chainId)
    );
    const intent = railgunTransactJournalIntent({
      chainId: transaction.chainId,
      from: transaction.from,
      to: transaction.to,
      value: transaction.value,
      data: transaction.input,
    });
    assert.deepEqual(intent, record.intent);
    assert.equal(receipt?.status, '0x1');
    assert.equal(receipt.transactionHash?.toLowerCase(), record.hash);
    assert.equal(receipt.from?.toLowerCase(), transaction.from.toLowerCase());
    assert.equal(receipt.to?.toLowerCase(), pins.proxy);
    assert.ok(
      hash(receipt.blockHash) && quantity(receipt.blockNumber) && quantity(receipt.transactionIndex)
    );
    assert.equal(transaction.blockHash?.toLowerCase(), receipt.blockHash);
    assert.equal(transaction.blockNumber, receipt.blockNumber);
    assert.equal(transaction.transactionIndex, receipt.transactionIndex);
    assert.ok(Array.isArray(receipt.logs) && receipt.logs.length <= 4096);
    const logs = receipt.logs.filter((log) => log.address?.toLowerCase() === pins.proxy);
    assert.equal(logs.length, 2);
    let previous = -1n;
    const decode = (log, name) => {
      const event = abi.getEvent(name);
      assert.equal(log.removed === true, false);
      assert.equal(log.transactionHash?.toLowerCase(), record.hash);
      assert.equal(log.blockHash?.toLowerCase(), receipt.blockHash);
      assert.equal(log.blockNumber, receipt.blockNumber);
      assert.equal(log.transactionIndex, receipt.transactionIndex);
      assert.ok(
        quantity(log.logIndex) &&
          BigInt(log.logIndex) > previous &&
          BigInt(log.logIndex) <= BigInt(Number.MAX_SAFE_INTEGER)
      );
      previous = BigInt(log.logIndex);
      assert.deepEqual(log.topics, [event.topicHash]);
      assert.ok(
        typeof log.data === 'string' &&
          /^0x(?:[0-9a-f]{2})+$/.test(log.data) &&
          log.data.length <= 8194
      );
      const args = abi.decodeEventLog(event, log.data, log.topics);
      assert.deepEqual(abi.encodeEventLog(event, args), { data: log.data, topics: log.topics });
      return args;
    };
    const nullified = decode(logs[0], 'Nullified');
    assert.equal(nullified.treeNumber, BigInt(intent.tree));
    assert.deepEqual([...nullified.nullifier], [intent.nullifier]);
    let output;
    if (intent.operation === 'railgun-private-transfer') {
      const args = decode(logs[1], 'Transact');
      assert.ok(args.treeNumber < 65536n && args.startPosition < 65536n);
      assert.deepEqual([...args.hash], [intent.commitment]);
      assert.equal(args.ciphertext.length, 1);
      const [[original]] = abi.decodeFunctionData('transact', transaction.input);
      const expected = original.boundParams.commitmentCiphertext[0],
        actual = args.ciphertext[0];
      assert.deepEqual([...actual.ciphertext], [...expected.ciphertext]);
      for (const key of [
        'blindedSenderViewingKey',
        'blindedReceiverViewingKey',
        'annotationData',
        'memo',
      ])
        assert.equal(actual[key], expected[key]);
      output = Object.freeze({
        kind: 'shielded',
        tree: Number(args.treeNumber),
        position: Number(args.startPosition),
        logIndex: logs[1].logIndex,
      });
    } else {
      const args = decode(logs[1], 'Unshield');
      assert.equal(args.to.toLowerCase(), intent.recipient);
      assert.equal(args.token.tokenType, 0n);
      assert.equal(args.token.tokenAddress.toLowerCase(), pins.wrappedNative);
      assert.equal(args.token.tokenSubID, 0n);
      assert.equal(args.amount + args.fee, BigInt(intent.amount));
      assert.ok(args.amount > 0n);
      output = Object.freeze({
        kind: 'unshield',
        logIndex: logs[1].logIndex,
        recipient: intent.recipient,
        token: pins.wrappedNative,
        amount: intent.amount,
        received: args.amount.toString(),
        fee: args.fee.toString(),
        feeDeviation: args.fee !== (BigInt(intent.amount) * 25n) / 10000n,
      });
    }
    return Object.freeze({
      status: 'matched',
      transactionHash: record.hash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      operation: intent.operation,
      inputTree: intent.tree,
      nullifier: intent.nullifier,
      commitment: intent.commitment,
      boundParamsHash: intent.boundParamsHash,
      intentDigest: intent.intentDigest,
      nullifiedLogIndex: logs[0].logIndex,
      output,
      trust: 'unverified-rpc',
      spendingEnabled: false,
    });
  } catch {
    return Object.freeze({
      status: 'anomaly',
      transactionHash: hash(record?.hash) ? record.hash : null,
      trust: 'unverified-rpc',
      spendingEnabled: false,
    });
  }
}
module.exports = { PRIVATE_EVENTS, inspectRailgunTransactReceipt };
