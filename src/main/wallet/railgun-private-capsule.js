/** Exact-intent recovery data, never an ownership or signing capability. The
 * nullifier, original path and ciphertext link this operation to its account;
 * persist only inside authenticated account storage and keep out of reports.
 * No witness secret, note randomness, signature or key belongs in this shape.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { normalizeRailgunPrivateOffer } = require('./railgun-private-preparation');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const exact = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
const field = (v) => {
  assert.equal(typeof v, 'string');
  assert.match(v, /^0x[0-9a-f]{64}$/);
  assert.ok(BigInt(v) < FIELD);
  return v;
};
function normalizeRailgunPrivateCapsule(value) {
  exact(value, [
    'version',
    'walletId',
    'engineSha256',
    'selection',
    'preparation',
    'noteHash',
    'pathElements',
  ]);
  assert.equal(value.version, 1);
  // Provenance only: recovery is defined by capsule version and revalidated
  // cryptography, so updating the runtime cannot strand an older capsule.
  assert.match(value.engineSha256, /^[0-9a-f]{64}$/);
  assert.match(value.walletId, /^[0-9a-f]{64}$/);
  const s = value.selection;
  exact(s, ['kind', 'tree', 'position', 'recipient']);
  for (const key of ['tree', 'position'])
    assert.ok(Number.isSafeInteger(s[key]) && s[key] >= 0 && s[key] <= 65535);
  assert.equal(typeof s.recipient, 'string');
  if (s.kind === 'railgun-private-transfer')
    assert.match(s.recipient, /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/);
  const selection = Object.freeze({
    kind: s.kind,
    tree: s.tree,
    position: s.position,
    recipient: s.recipient,
  });
  const offer = normalizeRailgunPrivateOffer(value.preparation, selection);
  const t = offer.transaction,
    e = offer.expected;
  const transaction = Object.freeze({ chainId: t.chainId, to: t.to, value: t.value, data: t.data });
  const expected = Object.freeze({
    kind: e.kind,
    tree: e.tree,
    merkleRoot: e.merkleRoot,
    nullifier: e.nullifier,
    commitment: e.commitment,
    boundParamsHash: e.boundParamsHash,
    ...(e.kind === 'railgun-token-unshield' ? { recipient: e.recipient, amount: e.amount } : {}),
  });
  const preparation = Object.freeze({
    transaction,
    expected,
    expectedHash: offer.expectedHash,
    recipient: offer.recipient,
    amount: offer.amount,
  });
  assert.ok(Array.isArray(value.pathElements) && value.pathElements.length === 16);
  return Object.freeze({
    version: 1,
    walletId: value.walletId,
    engineSha256: value.engineSha256,
    selection,
    preparation,
    noteHash: field(value.noteHash),
    pathElements: Object.freeze(value.pathElements.map(field)),
  });
}
function digestRailgunPrivateCapsule(value) {
  const capsule = normalizeRailgunPrivateCapsule(value);
  return createHash('sha256')
    .update('freedom:railgun:private-capsule-v1\0')
    .update(JSON.stringify(capsule))
    .digest('hex');
}
module.exports = { normalizeRailgunPrivateCapsule, digestRailgunPrivateCapsule };
