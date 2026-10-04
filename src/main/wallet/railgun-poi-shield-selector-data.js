/** Public-preimage consistency data for a private POI lookup. Neither the NPK
 * nor the ciphertext is proven owned here. No source or disclosure authority. */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const shape = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
function field(v) {
  assert.match(v, /^0x[0-9a-f]{64}$/);
  assert.ok(BigInt(v) < FIELD);
  return v;
}
function normalizeRailgunPoiShieldFacts(input) {
  shape(input, ['npk', 'token', 'value', 'tree', 'position', 'noteHash']);
  assert.equal(input.token, pins.wrappedNative);
  assert.match(input.value, /^[1-9][0-9]*$/);
  assert.ok(BigInt(input.value) < 1n << 120n);
  for (const key of ['tree', 'position'])
    assert.ok(Number.isSafeInteger(input[key]) && input[key] >= 0 && input[key] < 65536);
  return Object.freeze({
    npk: field(input.npk),
    token: input.token,
    value: input.value,
    tree: input.tree,
    position: input.position,
    noteHash: field(input.noteHash),
  });
}
function normalizeRailgunPoiShieldInput(capsule, creator) {
  const text = JSON.stringify({ capsule, creator });
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const copied = JSON.parse(text);
  capsule = normalizeRailgunPrivateCapsule(copied.capsule);
  creator = copied.creator;
  shape(creator, ['type', 'tree', 'position', 'preimage', 'ciphertext']);
  assert.equal(creator.type, 'Shield');
  assert.equal(creator.tree, capsule.selection.tree);
  assert.equal(creator.position, capsule.selection.position);
  shape(creator.preimage, ['npk', 'token', 'value']);
  const { preimage, ciphertext } = creator;
  shape(preimage.token, ['tokenType', 'tokenAddress', 'tokenSubID']);
  assert.equal(preimage.token.tokenType, 0);
  assert.equal(preimage.token.tokenSubID, '0x' + '0'.repeat(64));
  assert.equal(
    preimage.value,
    capsule.version === 2 ? capsule.preparation.inputAmount : capsule.preparation.amount
  );
  shape(ciphertext, ['encryptedBundle', 'shieldKey']);
  assert.ok(Array.isArray(ciphertext.encryptedBundle) && ciphertext.encryptedBundle.length === 3);
  for (const v of [...ciphertext.encryptedBundle, ciphertext.shieldKey])
    assert.match(v, /^0x[0-9a-f]{64}$/);
  const facts = normalizeRailgunPoiShieldFacts({
    npk: preimage.npk,
    token: preimage.token.tokenAddress,
    value: preimage.value,
    tree: creator.tree,
    position: creator.position,
    noteHash: capsule.noteHash,
  });
  const canonicalCreator = {
    type: 'Shield',
    tree: facts.tree,
    position: facts.position,
    preimage: {
      npk: facts.npk,
      token: { tokenType: 0, tokenAddress: facts.token, tokenSubID: '0x' + '0'.repeat(64) },
      value: facts.value,
    },
    ciphertext: {
      encryptedBundle: [...ciphertext.encryptedBundle],
      shieldKey: ciphertext.shieldKey,
    },
  };
  // Keep legacy bytes: this domain also binds the complete normalized capsule,
  // including its strict version and partial input/change/unshield amounts.
  const bindingDigest = createHash('sha256')
    .update('freedom:railgun:poi-shield-selector-v1\0')
    .update(JSON.stringify({ capsule, creator: canonicalCreator }))
    .digest('hex');
  return Object.freeze({ facts, bindingDigest });
}
module.exports = { normalizeRailgunPoiShieldFacts, normalizeRailgunPoiShieldInput };
