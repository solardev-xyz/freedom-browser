/** Main-owned projection of a completed guarded scan. No viewing secrets, note
 * randomness, memo text or engine objects cross this read boundary. All amounts
 * remain observed/unverified until a separate POI/spending policy is qualified.
 */
const assert = require('assert/strict');
const { keccak256, concat, toBeHex } = require('ethers');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const hex = (value, bytes) => {
  assert.equal(typeof value, 'string');
  assert.ok(new RegExp(`^(?:0x)?[0-9a-fA-F]{${bytes * 2}}$`).test(value));
  return '0x' + value.replace(/^0x/, '').toLowerCase();
};
function tokenAsset(token, tokenHash, amount) {
  assert.ok(token && [0, 1, 2].includes(token.tokenType));
  const contract = hex(token.tokenAddress, 20),
    subId = BigInt(hex(token.tokenSubID, 32));
  let expected;
  if (token.tokenType === 0) {
    assert.equal(subId, 0n);
    expected = toBeHex(BigInt(contract), 32);
  } else {
    expected = toBeHex(
      BigInt(
        keccak256(
          concat([toBeHex(token.tokenType, 32), toBeHex(BigInt(contract), 32), toBeHex(subId, 32)])
        )
      ) % FIELD,
      32
    );
    if (token.tokenType === 1) assert.equal(amount, 1n);
  }
  assert.equal(hex(tokenHash, 32), expected);
  return token.tokenType === 0
    ? { __type: 'erc20', contract }
    : { __type: token.tokenType === 1 ? 'erc721' : 'erc1155', contract, tokenId: subId };
}
function normalizeRailgunWalletRead(result, coverage) {
  // The reviewed runner authenticates which wallet the SDK constructed. This is
  // a shape bound, not an independent address checksum/credential derivation.
  assert.equal(typeof result.instanceId, 'string');
  assert.match(result.instanceId, /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/);
  function records(values, expected, received) {
    assert.ok(Array.isArray(values) && values.length === expected.length && values.length <= 10000);
    const positions = new Set(expected.map((v) => `${v.tree}:${v.position}`));
    const normalized = values.map((item) => {
      assert.ok(Number.isSafeInteger(item.tree) && Number.isSafeInteger(item.position));
      const id = `${item.tree}:${item.position}`;
      assert.ok(positions.delete(id));
      assert.equal(typeof item.value, 'string');
      assert.match(item.value, /^(0|[1-9][0-9]{0,38})$/);
      const amount = BigInt(item.value);
      assert.ok(amount < 1n << 120n);
      const hash = hex(item.hash, 32);
      assert.ok(BigInt(hash) < FIELD);
      const value = {
        id,
        tree: item.tree,
        position: item.position,
        txid: hex(item.txid, 32),
        hash,
        tokenHash: hex(item.tokenHash, 32),
        asset: tokenAsset(item.tokenData, item.tokenHash, amount),
        amount,
        tag: 'unverified',
      };
      if (received) value.spentTxid = item.spentTxid === false ? false : hex(item.spentTxid, 32);
      return value;
    });
    assert.equal(positions.size, 0);
    return normalized.sort((a, b) => a.tree - b.tree || a.position - b.position);
  }
  const received = records(result.received, coverage.expectedReceived, true),
    sent = records(result.sent, coverage.expectedSent, false),
    byPosition = new Map(received.map((v) => [v.id, v]));
  for (const item of sent) {
    const own = byPosition.get(item.id);
    if (own) {
      const { spentTxid: _spentTxid, ...common } = own;
      assert.deepEqual(common, item);
    }
  }
  return freeze({ instanceId: result.instanceId, received, sent });
}
module.exports = { normalizeRailgunWalletRead };
