/** Main-only diagnostic preparation checks. The utility exits with its witness;
 * these values never authorize a future signature or private operation.
 */
const assert = require('assert/strict');
const { normalizeRailgunPrivateOffer } = require('@freedom/railgun-kohaku-adapter/host/data');
const { assertRailgunPrivateTransferRecipient } = require('./railgun-private-destination');
const pins = require('./railgun-shield-pins.json');
const shape = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
function selectRailgunPrivatePreparation(owned, request) {
  const partial = request?.kind === 'railgun-partial-unshield';
  shape(request, ['kind', 'noteId', 'recipient', ...(partial ? ['unshieldAmount'] : [])]);
  assert.ok(
    ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
      request.kind
    )
  );
  // The request keeps its existing shape. Only a transfer to a destination other
  // than this account's instance address gains the explicit foreign marker.
  const foreign =
    request.kind === 'railgun-private-transfer' && request.recipient !== owned.read.instanceId;
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
  if (partial || request.kind === 'railgun-token-unshield') {
    assert.match(request.recipient, /^0x[0-9a-f]{40}$/);
    assert.ok(BigInt(request.recipient) > 0n);
  }
  if (partial) {
    amount(request.unshieldAmount);
    assert.ok(BigInt(request.unshieldAmount) < note.amount);
  }
  const selection = Object.freeze({
    kind: request.kind,
    tree: note.tree,
    position: note.position,
    recipient: request.recipient,
    ...(foreign ? { recipientRelationship: 'foreign' } : {}),
    ...(partial ? { unshieldAmount: request.unshieldAmount } : {}),
  });
  if (request.kind === 'railgun-private-transfer')
    assertRailgunPrivateTransferRecipient(selection, owned.read.instanceId);
  return selection;
}
function normalizeRailgunPrivatePreparation(value, { selection, read, ownedPoi, trees }) {
  const offer = normalizeRailgunPrivateOffer(value, selection);
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
  const partial = selection.kind === 'railgun-partial-unshield';
  assert.equal(partial ? value.inputAmount : value.amount, note.amount.toString());
  assert.equal(value.recipient, selection.recipient);
  const expected = value.expected;
  assert.equal(expected.kind, selection.kind);
  assert.equal(expected.tree, note.tree);
  assert.equal(expected.merkleRoot, tree.root);
  assert.equal(expected.nullifier, owned.nullifier);
  if (partial) {
    assert.equal(expected.recipient, selection.recipient);
    assert.equal(expected.unshieldAmount, selection.unshieldAmount);
  } else if (expected.kind === 'railgun-token-unshield') {
    assert.equal(expected.recipient, selection.recipient);
    assert.equal(expected.amount, value.amount);
  } else assertRailgunPrivateTransferRecipient(selection, read.instanceId);
  return Object.freeze({
    ...offer,
    witnessRetained: false,
    recipientVerified: false,
    reservationsChecked: false,
    poiVerified: false,
    spendingEnabled: false,
  });
}
function amount(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[1-9][0-9]{0,16}$/);
  assert.ok(BigInt(value) <= BigInt(pins.maxQualificationAmount));
}
function normalizeRailgunPrivateOperation(value, preparation) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  if (value.status === 'refused') {
    shape(value, ['status']);
    return Object.freeze({ status: 'refused' });
  }
  shape(value, ['status', 'transaction', 'transactionDigest', 'independentlyVerified']);
  assert.equal(value.status, 'proved');
  assert.equal(value.independentlyVerified, false);
  const checked = require('./railgun-private-intent').matchRailgunPrivateProvedTransaction(
    preparation.transaction,
    value.transaction,
    preparation.expected
  );
  assert.equal(value.transactionDigest, checked.digest);
  return Object.freeze({
    status: 'proved',
    transaction: Object.freeze({ ...value.transaction }),
    transactionDigest: checked.digest,
    independentlyVerified: false,
  });
}
module.exports = {
  selectRailgunPrivatePreparation,
  normalizeRailgunPrivatePreparation,
  normalizeRailgunPrivateOffer,
  normalizeRailgunPrivateOperation,
};
