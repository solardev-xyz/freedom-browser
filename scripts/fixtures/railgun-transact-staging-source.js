/** Derive a separate synthetic history; never represents a valid chain spend. */
const assert = require('assert/strict');
const { Interface } = require('ethers');
const { PRIVATE_EVENTS } = require('../../src/main/wallet/railgun-transact-receipt');
const abi = new Interface(PRIVATE_EVENTS);
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
exports.derive = (source) => {
  assert.equal(source.publicVaultVector, true);
  const result = structuredClone(source);
  const candidates = result.logs.filter((log) => log.blockNumber === 30);
  assert.equal(candidates.length, 1);
  const creator = candidates[0];
  const parsed = abi.parseLog(creator);
  assert.equal(parsed.name, 'Transact');
  assert.equal(creator.logIndex, 0);
  assert.equal(creator.transactionIndex, 0);
  assert.equal(Number(parsed.args.startPosition), 2);
  const nullifier = hex(888);
  const event = abi.encodeEventLog(abi.getEvent('Nullified'), [0, [nullifier]]);
  assert.ok(result.logs.every((log) => !log.data.includes(nullifier.slice(2))));
  const inserted = { ...creator, ...event };
  creator.logIndex = 1;
  result.logs.splice(result.logs.indexOf(creator), 0, inserted);
  // The original guard report covers the original generator, not this derivation.
  return {
    source: result,
    row: {
      version: 'V2',
      graphID: hex(30) + '0'.repeat(128),
      commitments: Array.from(parsed.args.hash),
      nullifiers: [nullifier],
      boundParamsHash: hex(123),
      blockNumber: 30,
      txid: creator.transactionHash.slice(2),
      timestamp: 30,
      utxoTreeIn: 0,
      utxoTreeOut: Number(parsed.args.treeNumber),
      utxoBatchStartPositionOut: 2,
    },
  };
};
