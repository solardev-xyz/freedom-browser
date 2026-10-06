/** Detached input for viewing-only output reconstruction. It carries no saved
 * blinded output, POI proof, list witness, key or authority capability.
 */
const assert = require('assert/strict');
const path = require('path');
const { getRailgunOwnPoiShape } = require('./railgun-own-poi-shape-data');
const { digestRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { assertRailgunPrivateTransferRecipient } = require('./railgun-private-destination');
const { normalizeRailgunPoiShieldInput } = require('./railgun-poi-shield-selector-data');
const { prepareRailgunPoiTransactSelectorInput } = require('./railgun-poi-transact-selector-data');
const { matchRailgunOwnTxid } = require('./railgun-own-txid');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function normalizeRailgunPoiOutputRecoveryInput(value) {
  const text = JSON.stringify(value);
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  shape(input, ['archive', 'descriptor', 'binding', 'preparation']);
  assert.ok(typeof input.archive === 'string' && path.isAbsolute(input.archive));
  shape(input.descriptor, [
    'walletId',
    'instanceId',
    'masterPublicKey',
    'spendingPublicKey',
    'viewingPublicKey',
    'accountIndex',
  ]);
  const descriptor = input.descriptor;
  assert.ok(
    Number.isSafeInteger(descriptor.accountIndex) &&
      descriptor.accountIndex >= 0 &&
      descriptor.accountIndex <= 65535
  );
  for (const name of ['walletId', 'viewingPublicKey', 'masterPublicKey'])
    assert.match(descriptor[name], /^[0-9a-f]{64}$/);
  assert.ok(BigInt('0x' + descriptor.masterPublicKey) < FIELD);
  assert.match(descriptor.instanceId, /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/);
  assert.ok(
    Array.isArray(descriptor.spendingPublicKey) && descriptor.spendingPublicKey.length === 2
  );
  for (const value of descriptor.spendingPublicKey) {
    assert.match(value, /^[0-9a-f]{64}$/);
    assert.ok(BigInt('0x' + value) < FIELD);
  }
  shape(input.binding, ['capsuleDigest', 'bindingDigest', 'payloadSha256', 'revision']);
  for (const key of ['capsuleDigest', 'bindingDigest', 'payloadSha256'])
    assert.match(input.binding[key], /^[0-9a-f]{64}$/);
  assert.ok(
    Number.isSafeInteger(input.binding.revision) &&
      input.binding.revision >= 1 &&
      input.binding.revision <= 4
  );
  shape(input.preparation, ['creator', 'ownEvidence', 'state', 'witness']);
  const { creator, ownEvidence, state, witness } = input.preparation;
  shape(ownEvidence, ['capsule', 'record', 'transaction', 'receipt', 'row']);
  if (creator.type === 'Transact') {
    const normalized = prepareRailgunPoiTransactSelectorInput({
      archive: input.archive,
      descriptor: input.descriptor,
      capsule: ownEvidence.capsule,
      creator,
    });
    assert.deepEqual(normalized.capsule, ownEvidence.capsule);
    input.descriptor = normalized.descriptor;
    input.preparation.creator = normalized.creator;
  } else {
    normalizeRailgunPoiShieldInput(ownEvidence.capsule, creator);
  }
  const outputShape = getRailgunOwnPoiShape(ownEvidence.capsule);
  assert.equal(outputShape.hasPrivateOutput, true);
  assert.equal(input.descriptor.walletId, ownEvidence.capsule.walletId);
  if (!outputShape.hasUnshield)
    assertRailgunPrivateTransferRecipient(
      ownEvidence.capsule.selection,
      input.descriptor.instanceId
    );
  assert.equal(digestRailgunPrivateCapsule(ownEvidence.capsule), input.binding.capsuleDigest);
  const matched = matchRailgunOwnTxid(ownEvidence);
  const normalizedWitness = normalizeRailgunTxidWitness(witness, state);
  assert.deepEqual(witness.row, normalizedWitness.row);
  assert.deepEqual(normalizedWitness.row, matched.row);
  assert.equal(matched.output.kind, outputShape.hasUnshield ? 'partial-unshield' : 'shielded');
  assert.equal(Math.floor(normalizedWitness.index / 65536), 0);
  assert.equal(normalizedWitness.row.nullifiers.length, 1);
  const expected = ownEvidence.capsule.preparation.expected;
  assert.deepEqual(
    normalizedWitness.row.commitments,
    outputShape.hasUnshield
      ? [expected.changeCommitment, expected.unshieldCommitment]
      : [expected.commitment]
  );
  return freeze(input);
}
function normalizeRailgunRecoveredPoiOutput(value) {
  shape(value, ['blindedCommitmentsOut', 'railgunTxidIfHasUnshield']);
  const marker = value.railgunTxidIfHasUnshield;
  if (marker !== '0x00') {
    assert.equal(typeof marker, 'string');
    assert.match(marker, /^0x[0-9a-f]{64}$/);
    assert.ok(BigInt(marker) > 0n && BigInt(marker) < FIELD);
  }
  assert.ok(Array.isArray(value.blindedCommitmentsOut) && value.blindedCommitmentsOut.length === 1);
  const output = value.blindedCommitmentsOut[0];
  assert.match(output, /^0x[0-9a-f]{64}$/);
  assert.ok(BigInt(output) > 0n && BigInt(output) < FIELD);
  return freeze({ blindedCommitmentsOut: [output], railgunTxidIfHasUnshield: marker });
}
module.exports = { normalizeRailgunPoiOutputRecoveryInput, normalizeRailgunRecoveredPoiOutput };
