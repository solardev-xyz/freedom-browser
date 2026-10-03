/** Match the exact journaled shield to an RPC receipt. No consensus, wallet
 * scan or spendability grant follows from this observation.
 */
const { Interface } = require('ethers');
const { transactionIntent, validIntent } = require('./private-transaction-intent');
const { SHIELD_ABI } = require('./railgun-shield-policy');
const pins = require('./railgun-shield-pins.json');
const SHIELD_EVENT =
  'event Shield(uint256 treeNumber,uint256 startPosition,(bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value)[] commitments,(bytes32[3] encryptedBundle,bytes32 shieldKey)[] shieldCiphertext,uint256[] fees)';
const abi = new Interface([...SHIELD_ABI, SHIELD_EVENT]);
const event = abi.getEvent('Shield');
const quantity = (value) => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value);
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const check = (value) => {
  if (!value) throw Error('Receipt mismatch');
};
function inspectRailgunShieldReceipt(record, transaction, receipt) {
  try {
    check(
      record?.intent?.kind === 'railgun-native-shield' &&
        validIntent(record.intent) &&
        hash(record.hash)
    );
    check(
      transaction?.hash?.toLowerCase() === record.hash &&
        quantity(transaction.nonce) &&
        BigInt(transaction.nonce) === BigInt(record.nonce)
    );
    check(quantity(transaction.chainId) && BigInt(transaction.chainId) === BigInt(pins.chainId));
    const intent = transactionIntent('railgun-native-shield', {
      chainId: transaction.chainId,
      from: transaction.from,
      to: transaction.to,
      value: transaction.value,
      data: transaction.input,
    });
    check(
      intent.digest === record.intent.digest &&
        ['npk', 'token', 'amount'].every((k) => intent[k] === record.intent[k])
    );
    check(
      receipt?.status === '0x1' &&
        receipt.transactionHash?.toLowerCase() === record.hash &&
        receipt.from?.toLowerCase() === transaction.from.toLowerCase() &&
        receipt.to?.toLowerCase() === pins.relayAdapt &&
        hash(receipt.blockHash) &&
        quantity(receipt.blockNumber)
    );
    check(
      transaction.blockHash?.toLowerCase() === receipt.blockHash &&
        transaction.blockNumber === receipt.blockNumber
    );
    check(Array.isArray(receipt.logs) && receipt.logs.length <= 4096);
    const logs = receipt.logs.filter(
      (log) =>
        log.address?.toLowerCase() === pins.proxy &&
        log.topics?.[0]?.toLowerCase() === event.topicHash
    );
    check(logs.length === 1);
    const log = logs[0];
    check(
      log.removed !== true &&
        log.transactionHash?.toLowerCase() === record.hash &&
        log.blockHash?.toLowerCase() === receipt.blockHash &&
        log.blockNumber === receipt.blockNumber &&
        quantity(log.logIndex)
    );
    check(
      Array.isArray(log.topics) &&
        log.topics.length === 1 &&
        typeof log.data === 'string' &&
        /^0x(?:[0-9a-f]{2})+$/.test(log.data) &&
        log.data.length <= 8194
    );
    const args = abi.decodeEventLog(event, log.data, log.topics);
    const encoded = abi.encodeEventLog(event, args);
    check(encoded.data === log.data && encoded.topics[0] === log.topics[0]);
    check(
      args.commitments.length === 1 && args.shieldCiphertext.length === 1 && args.fees.length === 1
    );
    const note = args.commitments[0],
      fee = args.fees[0];
    check(
      note.npk === record.intent.npk &&
        note.token.tokenType === 0n &&
        note.token.tokenAddress.toLowerCase() === record.intent.token &&
        note.token.tokenSubID === 0n
    );
    check(note.value > 0n && note.value + fee === BigInt(record.intent.amount));
    check(args.treeNumber < 65536n && args.startPosition < 65536n);
    const [, calls] = abi.decodeFunctionData('multicall', transaction.input);
    const [requests] = abi.decodeFunctionData('shield', calls[1].data);
    const expected = requests[0].ciphertext,
      actual = args.shieldCiphertext[0];
    check(
      expected.shieldKey === actual.shieldKey &&
        expected.encryptedBundle.every((word, i) => word === actual.encryptedBundle[i])
    );
    return Object.freeze({
      status: 'matched',
      transactionHash: record.hash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      logIndex: log.logIndex,
      tree: Number(args.treeNumber),
      position: Number(args.startPosition),
      npk: note.npk,
      token: record.intent.token,
      amount: record.intent.amount,
      noteValue: note.value.toString(),
      fee: fee.toString(),
      feeDeviation: note.value.toString() !== record.intent.noteValue,
      trust: 'unverified-rpc',
      spendingEnabled: false,
    });
  } catch {
    return Object.freeze({
      status: 'anomaly',
      transactionHash: record?.hash ?? null,
      trust: 'unverified-rpc',
      spendingEnabled: false,
    });
  }
}
module.exports = { SHIELD_EVENT, inspectRailgunShieldReceipt };
