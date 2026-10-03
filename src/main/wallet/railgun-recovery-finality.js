/** Internally consistent RPC finality, not cryptographic chain verification. */
const assert = require('assert/strict');
async function readRailgunRecoveryFinality(network, record, assertCurrent, previous) {
  const request = async (method, params) => {
    assertCurrent();
    const response = await network.request(11155111, method, params);
    assertCurrent();
    return response.result;
  };
  const finalized = await request('eth_getBlockByNumber', ['finalized', false]);
  const height = BigInt(finalized.number);
  const head = BigInt(await request('eth_blockNumber', []));
  assert.ok(height <= BigInt(Number.MAX_SAFE_INTEGER) && height <= head);
  assert.ok(height >= BigInt(record.observation.blockNumber));
  if (height === BigInt(record.observation.blockNumber))
    assert.equal(finalized.hash, record.observation.blockHash);
  const canonical = await request('eth_getBlockByNumber', [finalized.number, false]);
  assert.equal(canonical.number, finalized.number);
  assert.equal(canonical.hash, finalized.hash);
  if (previous) {
    assert.ok(height >= BigInt(previous.number));
    const prior = await request('eth_getBlockByNumber', [
      '0x' + previous.number.toString(16),
      false,
    ]);
    assert.equal(BigInt(prior.number), BigInt(previous.number));
    assert.equal(prior.hash, previous.hash);
    if (height === BigInt(previous.number)) assert.equal(finalized.hash, previous.hash);
  }
  // Do not splice a tag observed on one fork with a numbered header from another.
  const repeated = await request('eth_getBlockByNumber', ['finalized', false]);
  assert.equal(repeated.number, finalized.number);
  assert.equal(repeated.hash, finalized.hash);
  return Object.freeze({ number: Number(height), hash: finalized.hash });
}
module.exports = { readRailgunRecoveryFinality };
