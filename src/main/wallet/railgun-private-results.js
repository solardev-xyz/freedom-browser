/** Strict copies of guarded job results. These are data, not operation receipts:
 * ownership, freshness, reservation and observed utility exit remain host gates.
 */
const assert = require('assert/strict');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const {
  validateRailgunPrivateSigningIntent,
  matchRailgunPrivateProvedTransaction,
} = require('./railgun-private-intent');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const field = (value, limit = FIELD) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) < limit;
function shape(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function guards(value) {
  shape(value, ['attempts', 'canaries', 'hooks']);
  assert.equal(value.attempts, 0);
  assert.ok(Array.isArray(value.hooks) && value.hooks.length > 0 && value.hooks.length <= 256);
  assert.ok(
    value.hooks.every((hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook))
  );
  assert.equal(new Set(value.hooks).size, value.hooks.length);
  assert.equal(value.canaries, value.hooks.length);
}
// B has finished its independent public-intent/message checks before emitting
// this request. Matching data is necessary, never a key-release capability.
function normalizeRailgunSpendKeyRequest(value, { transaction, expected, expectedHash }) {
  const checked = validateRailgunPrivateSigningIntent(transaction, expected);
  shape(value, ['id', 'method', 'purpose', 'transactionDigest', 'expectedHash']);
  assert.equal(value.id, 1);
  assert.equal(value.method, 'key');
  assert.equal(value.purpose, 'spending-sign');
  assert.ok(field(expectedHash));
  assert.equal(value.transactionDigest, checked.digest);
  assert.equal(value.expectedHash, expectedHash);
  return Object.freeze({ transactionDigest: checked.digest, expectedHash });
}
function normalizeRailgunSpendSignature(value, { transaction, expected, expectedHash }) {
  const intent = validateRailgunPrivateSigningIntent(transaction, expected);
  shape(value, ['signature', 'message', 'transactionDigest', 'guards', 'inventory']);
  assert.ok(field(expectedHash));
  assert.equal(value.message, expectedHash);
  assert.equal(value.transactionDigest, intent.digest);
  assert.equal(value.inventory, require('./railgun-engine-manifest.json').inventory.sha256);
  guards(value.guards);
  const signature = normalizeRailgunSignature(value.signature);
  return Object.freeze({ signature, message: value.message, transactionDigest: intent.digest });
}
function normalizeRailgunPrivateVerification(value, { intent, transaction, expected }) {
  const checked = matchRailgunPrivateProvedTransaction(intent, transaction, expected);
  shape(value, ['transactionDigest', 'verified', 'guards', 'proverSha256']);
  assert.equal(value.verified, true);
  assert.equal(value.transactionDigest, checked.digest);
  assert.equal(value.proverSha256, require('./railgun-prover-manifest.json').sha256);
  guards(value.guards);
  return Object.freeze({ transactionDigest: checked.digest, verified: true });
}
function normalizeRailgunPrivateReceiver(value, options) {
  const { transaction, expected, recipient, amount, inputAmount } = options;
  const checked = validateRailgunPrivateSigningIntent(transaction, expected);
  const partial = checked.kind === 'railgun-partial-unshield';
  assert.ok(partial || checked.kind === 'railgun-private-transfer');
  // A sent-note check of a full-value foreign output reports its explicit marker.
  // Self-transfer and change results keep their original exact shape.
  const foreign = Object.hasOwn(options, 'recipientRelationship');
  if (foreign) {
    assert.ok(!partial);
    assert.equal(options.recipientRelationship, 'foreign');
  }
  const relationship = foreign ? { recipientRelationship: 'foreign' } : {};
  let amounts;
  if (partial) {
    for (const key of ['amount', 'unshieldAmount', 'changeAmount'])
      assert.ok(!Object.hasOwn(options, key));
    assert.match(inputAmount, /^[1-9][0-9]{0,16}$/);
    const v = BigInt(inputAmount),
      u = BigInt(checked.unshieldAmount);
    assert.ok(
      v <= BigInt(require('./railgun-shield-pins.json').maxQualificationAmount) && u > 0n && u < v
    );
    amounts = {
      inputAmount,
      unshieldAmount: checked.unshieldAmount,
      changeAmount: (v - u).toString(),
    };
  } else {
    assert.ok(!Object.hasOwn(options, 'inputAmount'));
    amounts = { amount };
  }
  shape(value, [
    'verified',
    'transactionDigest',
    'recipient',
    ...Object.keys(relationship),
    ...Object.keys(amounts),
    'guards',
    'inventory',
  ]);
  assert.equal(value.verified, true);
  assert.equal(value.transactionDigest, checked.digest);
  assert.equal(value.recipient, recipient);
  if (foreign) assert.equal(value.recipientRelationship, 'foreign');
  for (const [key, expectedValue] of Object.entries(amounts))
    assert.equal(value[key], expectedValue);
  assert.equal(value.inventory, require('./railgun-engine-manifest.json').inventory.sha256);
  guards(value.guards);
  return Object.freeze({
    recipientVerified: true,
    transactionDigest: checked.digest,
    recipient,
    ...relationship,
    ...amounts,
    inputOwnershipVerified: false,
    spendingEnabled: false,
  });
}
module.exports = {
  normalizeRailgunSignature,
  normalizeRailgunSpendSignature,
  normalizeRailgunSpendKeyRequest,
  normalizeRailgunPrivateVerification,
  normalizeRailgunPrivateReceiver,
};
