/** Original-signature recovery data only. Neither persisted data nor a locally
 * regenerated proof grants ownership, signing, submission or POI authority. */
const assert = require('assert/strict');
const path = require('path');
const { types } = require('util');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const { normalizeRailgunPrivateOperation } = require('./railgun-private-preparation');
const { assertRailgunPrivateTransferRecipient } = require('./railgun-private-destination');
const pins = require('./railgun-shield-pins.json');
function copyData(input) {
  let nodes = 0;
  const copy = (value, depth = 0) => {
    assert.ok(++nodes <= 4096 && depth <= 16);
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
    assert.ok(value && typeof value === 'object' && !types.isProxy(value));
    const array = Array.isArray(value);
    assert.ok(array || [Object.prototype, null].includes(Object.getPrototypeOf(value)));
    const keys = Reflect.ownKeys(value);
    if (array) {
      assert.ok(value.length <= 1024);
      assert.deepEqual(keys, [...Array(value.length).keys()].map(String).concat('length'));
    }
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      assert.equal(typeof key, 'string');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert.ok(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  };
  const value = copy(input);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 32768);
  return value;
}
function normalizeRailgunPrivateRecoveryInput(input, { walletId }) {
  const value = copyData(input);
  assert.deepEqual(Object.keys(value).sort(), [
    'artifactDirectory',
    'capsule',
    'proverArchive',
    'signature',
  ]);
  for (const name of ['proverArchive', 'artifactDirectory']) {
    assert.equal(typeof value[name], 'string');
    assert.ok(path.isAbsolute(value[name]));
  }
  const capsule = normalizeRailgunPrivateCapsule(value.capsule);
  assert.equal(capsule.walletId, walletId);
  return Object.freeze({
    capsule,
    signature: normalizeRailgunSignature(value.signature),
    proverArchive: value.proverArchive,
    artifactDirectory: value.artifactDirectory,
  });
}
function normalizeRailgunPrivateRecoveryResult(
  input,
  { capsule: original, walletId, read, ownedPoi, trees }
) {
  const capsule = normalizeRailgunPrivateCapsule(copyData(original));
  assert.equal(capsule.walletId, walletId);
  const { selection, preparation, noteHash } = capsule;
  const id = `${selection.tree}:${selection.position}`;
  const notes = read.received.filter((note) => note.id === id);
  const records = ownedPoi.filter((note) => note.id === id);
  const matches = trees.filter((tree) => tree.tree === selection.tree);
  assert.equal(notes.length, 1);
  assert.equal(records.length, 1);
  assert.equal(matches.length, 1);
  const note = notes[0],
    owned = records[0];
  assert.equal(note.tree, selection.tree);
  assert.equal(note.position, selection.position);
  assert.ok(selection.position < matches[0].length);
  assert.equal(note.spentTxid, false);
  assert.equal(note.hash, noteHash);
  assert.equal(owned.hash, noteHash);
  assert.equal(owned.nullifier, preparation.expected.nullifier);
  assert.equal(note.asset.__type, 'erc20');
  assert.equal(note.asset.contract, pins.wrappedNative);
  assert.equal(typeof note.amount, 'bigint');
  assert.ok(note.amount > 0n && note.amount <= BigInt(pins.maxQualificationAmount));
  assert.equal(
    note.amount.toString(),
    selection.kind === 'railgun-partial-unshield' ? preparation.inputAmount : preparation.amount
  );
  if (selection.kind === 'railgun-private-transfer')
    assertRailgunPrivateTransferRecipient(selection, read.instanceId);
  // The completed snapshot may be newer. Reconstruction authenticates the saved
  // Merkle path against the ORIGINAL signed root, never the current tree root.
  const value = copyData(input);
  assert.equal(value.status, 'proved');
  return normalizeRailgunPrivateOperation(value, preparation);
}
module.exports = { normalizeRailgunPrivateRecoveryInput, normalizeRailgunPrivateRecoveryResult };
