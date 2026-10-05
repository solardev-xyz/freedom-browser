/** Pure fixture joins only. Native callers supply actual captured/signed bytes
 * and a fresh genuine wallet-registry read; none of these functions issue trust. */
const { assert } = require('./railgun-native-assertions');
const { Interface } = require('ethers');
const wallet = '../../src/main/wallet/';
const pins = require(wallet + 'railgun-shield-pins.json');
const { TRANSACT_ABI } = require(wallet + 'railgun-private-policy');
const { PRIVATE_EVENTS } = require(wallet + 'railgun-transact-receipt');
const { treasury } = require(wallet + 'railgun-transact-receipt-policy');
const abi = new Interface([
  ...PRIVATE_EVENTS,
  TRANSACT_ABI,
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const copy = (v) => JSON.parse(JSON.stringify(v));
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function assertReceipt(receipt, row) {
  assert.equal(receipt.status, '0x1');
  assert.equal(receipt.transactionHash, '0x' + row.txid);
  assert.equal(Number(BigInt(receipt.blockNumber)), row.blockNumber);
  assert.equal(
    row.graphID,
    hex(row.blockNumber) + hex(receipt.transactionIndex).slice(2) + hex(0).slice(2)
  );
  assert.equal(receipt.logs.length, 4);
  const names = ['Nullified', 'Transfer', 'Transfer', 'Unshield'];
  const addresses = [pins.proxy, pins.wrappedNative, pins.wrappedNative, pins.proxy];
  const parsed = receipt.logs.map((log, i) => {
    assert.equal(log.address.toLowerCase(), addresses[i].toLowerCase());
    for (const name of ['blockNumber', 'blockHash', 'transactionHash', 'transactionIndex'])
      assert.equal(log[name], receipt[name]);
    assert.equal(log.removed, false);
    if (i) assert.ok(BigInt(log.logIndex) > BigInt(receipt.logs[i - 1].logIndex));
    const value = abi.parseLog(log);
    assert.equal(value.name, names[i]);
    const encoded = abi.encodeEventLog(value.fragment, value.args);
    assert.deepEqual(log.topics, encoded.topics);
    assert.equal(log.data, encoded.data);
    return value.args;
  });
  assert.equal(Number(parsed[0][0]), row.utxoTreeIn);
  assert.deepEqual(Array.from(parsed[0][1]), row.nullifiers);
  for (const i of [1, 2]) assert.equal(parsed[i][0].toLowerCase(), pins.proxy);
  assert.equal(parsed[1][1].toLowerCase(), row.unshield.toAddress);
  assert.equal(parsed[2][1].toLowerCase(), treasury);
  assert.equal(parsed[3][0].toLowerCase(), row.unshield.toAddress);
  assert.equal(Number(parsed[3][1][0]), 0);
  assert.equal(parsed[3][1][1].toLowerCase(), pins.wrappedNative);
  assert.equal(parsed[3][1][2], 0n);
  assert.equal(parsed[1][2], parsed[3][2]);
  assert.equal(parsed[2][2], parsed[3][3]);
  assert.equal(parsed[1][2] + parsed[2][2], BigInt(row.unshield.value));
  return copy([receipt.logs[0], receipt.logs[3]]);
}
function rowFromSecond({ capture, transaction, receipt }, first, header) {
  const capsule = capture.capsule;
  assert.equal(capsule.version, 1);
  assert.equal(capsule.selection.kind, 'railgun-token-unshield');
  assert.equal(capture.record.hash, transaction.hash);
  assert.equal(receipt.transactionHash, transaction.hash);
  assert.equal(transaction.from.toLowerCase(), capture.submitter);
  assert.equal(transaction.input, capture.provedTransaction.data);
  const { extractRailgunTransactIntent, railgunTransactJournalIntent } = require(
    wallet + 'railgun-transact-intent'
  );
  assert.deepEqual(
    railgunTransactJournalIntent({ ...capture.provedTransaction, from: capture.submitter }),
    capture.record.intent
  );
  const decoded = extractRailgunTransactIntent({
    chainId: transaction.chainId,
    to: transaction.to,
    value: transaction.value,
    data: transaction.input,
  });
  assert.deepEqual(decoded.intent, capsule.preparation.transaction);
  assert.deepEqual(decoded.expected, capsule.preparation.expected);
  const [[inner]] = abi.decodeFunctionData('transact', transaction.input);
  const expected = capsule.preparation.expected;
  assert.equal(inner.boundParams.unshield, 1n);
  assert.equal(inner.boundParams.commitmentCiphertext.length, 0);
  assert.deepEqual(Array.from(inner.nullifiers), [expected.nullifier]);
  assert.deepEqual(Array.from(inner.commitments), [expected.commitment]);
  assert.equal(
    inner.unshieldPreimage.value.toString(),
    first.ownEvidence.capsule.preparation.changeAmount
  );
  assert.equal(capsule.preparation.amount, inner.unshieldPreimage.value.toString());
  assert.equal(capsule.noteHash, first.ownEvidence.capsule.preparation.expected.changeCommitment);
  assert.notEqual(expected.nullifier, first.ownEvidence.capsule.preparation.expected.nullifier);
  assert.equal(inner.unshieldPreimage.token.tokenType, 0n);
  assert.equal(inner.unshieldPreimage.token.tokenAddress.toLowerCase(), pins.wrappedNative);
  assert.equal(inner.unshieldPreimage.token.tokenSubID, 0n);
  assert.equal(BigInt(inner.unshieldPreimage.npk), BigInt(expected.recipient));
  const blockNumber = Number(BigInt(receipt.blockNumber));
  const at = header(blockNumber);
  assert.equal(at.hash, receipt.blockHash);
  const row = {
    version: 'V2',
    graphID: hex(blockNumber) + hex(receipt.transactionIndex).slice(2) + hex(0).slice(2),
    commitments: Array.from(inner.commitments),
    nullifiers: Array.from(inner.nullifiers),
    boundParamsHash: expected.boundParamsHash,
    blockNumber,
    txid: transaction.hash.slice(2),
    timestamp: Number(BigInt(at.timestamp)),
    utxoTreeIn: Number(inner.boundParams.treeNumber),
    utxoTreeOut: 99999,
    utxoBatchStartPositionOut: 99999,
    unshield: {
      tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      toAddress: expected.recipient,
      value: inner.unshieldPreimage.value.toString(),
    },
  };
  assertReceipt(receipt, row);
  const finalized = capture.projection.railgun.finalizedBlockNumber;
  assert.ok(Number.isSafeInteger(finalized) && finalized >= blockNumber);
  assert.equal(capture.projection.railgun.finalizedBlockHash, header(finalized).hash);
  return { row, finalized };
}
function wethUnspent(owned) {
  return owned.read.received.filter(
    (n) =>
      n.asset.__type === 'erc20' &&
      n.asset.contract.toLowerCase() === pins.wrappedNative &&
      n.spentTxid === false
  );
}
function beforeSecond(owned, first, selected) {
  const available = wethUnspent(owned);
  const change = available.filter((note) => note.txid === first.ownEvidence.record.hash);
  assert.equal(change.length, 1);
  assert.equal(change[0].id, selected.id);
  assert.equal(owned.read.received.filter((note) => note.id === selected.id).length, 1);
  assert.deepEqual(change[0], selected);
  assert.equal(change[0].txid, first.ownEvidence.record.hash);
  assert.equal(change[0].hash, first.ownEvidence.capsule.preparation.expected.changeCommitment);
  assert.equal(change[0].amount, BigInt(first.ownEvidence.capsule.preparation.changeAmount));
  const capsule = first.ownEvidence.capsule;
  const originalId = `${capsule.selection.tree}:${capsule.selection.position}`;
  const original = owned.read.received.filter((note) => note.id === originalId);
  assert.equal(original.length, 1);
  assert.equal(original[0].spentTxid, first.ownEvidence.record.hash);
  assert.equal(original[0].hash, capsule.noteHash);
  assert.equal(original[0].amount, BigInt(capsule.preparation.inputAmount));
  // Only the private scan facts required by the terminal comparison survive.
  return {
    checkpointHash: owned.checkpointHash,
    trees: copy(owned.trees),
    ownedPoi: copy(owned.ownedPoi),
    read: { received: owned.read.received.map((n) => ({ ...n, asset: { ...n.asset } })) },
  };
}
function assertScanned(before, after, first, second) {
  assert.notEqual(after.checkpointHash, before.checkpointHash);
  assert.deepEqual(after.trees, before.trees);
  assert.deepEqual(after.ownedPoi, before.ownedPoi);
  const firstCapsule = first.ownEvidence.capsule;
  const originalId = `${firstCapsule.selection.tree}:${firstCapsule.selection.position}`;
  const firstHash = first.ownEvidence.record.hash,
    secondHash = second.capture.record.hash;
  const prior = before.read.received.filter((n) => n.txid === firstHash);
  assert.equal(prior.length, 1);
  beforeSecond(before, first, prior[0]);
  const originals = after.read.received.filter((n) => n.id === originalId);
  assert.equal(originals.length, 1);
  assert.equal(originals[0].spentTxid, firstHash);
  assert.equal(originals[0].amount, BigInt(firstCapsule.preparation.inputAmount));
  assert.equal(originals[0].hash, firstCapsule.noteHash);
  const change = after.read.received.filter((n) => n.id === prior[0].id);
  assert.equal(change.length, 1);
  assert.deepEqual(change[0], { ...prior[0], spentTxid: secondHash });
  assert.equal(
    after.read.received.some((n) => n.txid === secondHash),
    false
  );
  assert.equal(
    after.ownedPoi.some((n) => n.txid === secondHash),
    false
  );
  assert.deepEqual(
    after.read.received,
    before.read.received.map((n) => (n.id === prior[0].id ? { ...n, spentTxid: secondHash } : n))
  );
  assert.equal(
    wethUnspent(after)
      .filter((note) => note.id === prior[0].id)
      .reduce((sum, note) => sum + note.amount, 0n),
    0n
  );
  assert.equal(
    wethUnspent(after).reduce((sum, note) => sum + note.amount, 0n),
    wethUnspent(before).reduce((sum, note) => sum + note.amount, 0n) - prior[0].amount
  );
  const record = after.ownedPoi.find((n) => n.id === prior[0].id);
  assert.ok(record);
  assert.equal(record.nullifier, second.capture.capsule.preparation.expected.nullifier);
}
module.exports = { rowFromSecond, assertReceipt, beforeSecond, assertScanned };
