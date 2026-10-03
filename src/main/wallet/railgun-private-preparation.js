/** Main-only diagnostic preparation checks. The utility exits with its witness;
 * these values never authorize a future signature or private operation.
 */
const assert = require('assert/strict');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const pins = require('./railgun-shield-pins.json');
const shape = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
function selectRailgunPrivatePreparation(owned, request) {
  shape(request, ['kind', 'noteId', 'recipient']);
  assert.ok(['railgun-private-transfer', 'railgun-token-unshield'].includes(request.kind));
  assert.equal(typeof request.noteId, 'string');
  const note = owned.read.received.find((v) => v.id === request.noteId);
  const record = owned.ownedPoi.find((v) => v.id === request.noteId);
  assert.ok(
    note &&
      record &&
      note.spentTxid === false &&
      note.amount > 0n &&
      note.amount <= BigInt(pins.maxQualificationAmount)
  );
  assert.equal(note.asset.__type, 'erc20');
  assert.equal(note.asset.contract, pins.wrappedNative);
  if (request.kind === 'railgun-token-unshield') {
    assert.match(request.recipient, /^0x[0-9a-f]{40}$/);
    assert.ok(BigInt(request.recipient) > 0n);
  } else assert.equal(request.recipient, owned.read.instanceId);
  return Object.freeze({
    kind: request.kind,
    tree: note.tree,
    position: note.position,
    recipient: request.recipient,
  });
}
function normalizeRailgunPrivatePreparation(value, { selection, read, ownedPoi, trees }) {
  shape(value, ['transaction', 'expected', 'expectedHash', 'recipient', 'amount']);
  const note = read.received.find(
    (v) => v.tree === selection.tree && v.position === selection.position
  );
  const owned = ownedPoi.find((v) => v.id === note?.id),
    tree = trees.find((v) => v.tree === note?.tree);
  assert.ok(note && owned && tree);
  assert.equal(note.spentTxid, false);
  assert.equal(note.asset.__type, 'erc20');
  assert.equal(note.asset.contract, pins.wrappedNative);
  assert.ok(note.amount > 0n && note.amount <= BigInt(pins.maxQualificationAmount));
  assert.equal(value.amount, note.amount.toString());
  assert.equal(value.recipient, selection.recipient);
  const expected = value.expected;
  assert.equal(expected.kind, selection.kind);
  assert.equal(expected.tree, note.tree);
  assert.equal(expected.merkleRoot, tree.root);
  assert.equal(expected.nullifier, owned.nullifier);
  if (expected.kind === 'railgun-token-unshield') {
    assert.equal(expected.recipient, selection.recipient);
    assert.equal(expected.amount, value.amount);
  } else assert.equal(value.recipient, read.instanceId);
  const checked = validateRailgunPrivateSigningIntent(value.transaction, expected);
  assert.match(value.expectedHash, /^0x[0-9a-f]{64}$/);
  assert.ok(
    BigInt(value.expectedHash) <
      21888242871839275222246405745257275088548364400416034343698204186575808495617n
  );
  return Object.freeze({
    transaction: Object.freeze({ ...value.transaction }),
    expected: Object.freeze({ ...expected }),
    expectedHash: value.expectedHash,
    transactionDigest: checked.digest,
    recipient: value.recipient,
    amount: value.amount,
    witnessRetained: false,
    recipientVerified: false,
    reservationsChecked: false,
    poiVerified: false,
    spendingEnabled: false,
  });
}
module.exports = { selectRailgunPrivatePreparation, normalizeRailgunPrivatePreparation };
