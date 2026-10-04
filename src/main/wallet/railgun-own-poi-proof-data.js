/** Bounded local proving input and keylessly derivable public fields. These
 * checks establish internal consistency only, never account/source authority.
 */
const assert = require('assert/strict');
const path = require('path');
const { matchRailgunOwnTxid } = require('./railgun-own-txid');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const { normalizeRailgunPoiShieldInput } = require('./railgun-poi-shield-selector-data');
const { prepareRailgunPoiTransactSelectorInput } = require('./railgun-poi-transact-selector-data');
const { normalizePoiProofs, REQUIRED_LIST } = require('./railgun-poi-records');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const shape = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
function normalizeRailgunOwnPoiProofInput(value) {
  const text = JSON.stringify(value);
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const v = JSON.parse(text);
  shape(v, [
    'archive',
    'proverArchive',
    'artifactDirectory',
    'descriptor',
    'preparation',
    'listProofs',
  ]);
  for (const key of ['archive', 'proverArchive', 'artifactDirectory'])
    assert.ok(typeof v[key] === 'string' && path.isAbsolute(v[key]));
  shape(v.preparation, ['creator', 'ownEvidence', 'state', 'witness']);
  shape(v.preparation.ownEvidence, ['capsule', 'record', 'transaction', 'receipt', 'row']);
  const { creator, ownEvidence, state, witness } = v.preparation;
  const partial = ownEvidence.capsule.selection.kind === 'railgun-partial-unshield';
  assert.equal(ownEvidence.capsule.version, partial ? 2 : 1);
  assert.ok(
    ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
      ownEvidence.capsule.selection.kind
    )
  );
  if (creator.type === 'Transact') {
    // Reuse the selector's exact current-format receiver input bounds. This
    // structural branch authenticates neither creator history nor typed POI.
    const normalized = prepareRailgunPoiTransactSelectorInput({
      archive: v.archive,
      descriptor: v.descriptor,
      capsule: ownEvidence.capsule,
      creator,
    });
    assert.deepEqual(normalized.capsule, ownEvidence.capsule);
    v.descriptor = normalized.descriptor;
    v.preparation.creator = normalized.creator;
  } else {
    normalizeRailgunPoiShieldInput(ownEvidence.capsule, creator);
  }
  assert.equal(v.descriptor.walletId, ownEvidence.capsule.walletId);
  const matched = matchRailgunOwnTxid(ownEvidence);
  if (creator.type === 'Transact' || partial) {
    assert.equal(matched.row.nullifiers.length, 1);
    assert.equal(matched.row.commitments.length, partial ? 2 : 1);
  }
  if (partial) {
    assert.equal(matched.output.kind, 'partial-unshield');
    const expected = ownEvidence.capsule.preparation.expected;
    assert.deepEqual(matched.row.nullifiers, [expected.nullifier]);
    assert.deepEqual(matched.row.commitments, [
      expected.changeCommitment,
      expected.unshieldCommitment,
    ]);
  }
  const normalizedWitness = normalizeRailgunTxidWitness(witness, state);
  assert.deepEqual(normalizedWitness.row, matched.row);
  assert.ok(Array.isArray(v.listProofs) && v.listProofs.length === 1);
  assert.equal(typeof v.listProofs[0].leaf, 'string');
  v.listProofs = normalizePoiProofs(v.listProofs, [
    {
      blindedCommitment: '0x' + v.listProofs[0].leaf.replace(/^0x/, ''),
      type: creator.type,
    },
  ]);
  return freeze(v);
}
function expectedRailgunOwnPoiFields(input) {
  const v = normalizeRailgunOwnPoiProofInput(input);
  const witness = normalizeRailgunTxidWitness(v.preparation.witness, v.preparation.state);
  const kind = v.preparation.ownEvidence.capsule.selection.kind;
  const unshield = kind !== 'railgun-private-transfer';
  return freeze({
    listKey: REQUIRED_LIST,
    poiMerkleroots: [v.listProofs[0].root],
    txidMerkleroot: witness.root,
    txidMerklerootIndex: witness.checkpointIndex,
    railgunTxidIfHasUnshield: unshield ? '0x' + witness.railgunTxid : '0x00',
    outputCount: kind === 'railgun-token-unshield' ? 0 : 1,
  });
}
function bindRailgunOwnPoiPayload(value, expected) {
  const payload = normalizeRailgunPoiPayload(value);
  for (const key of [
    'listKey',
    'poiMerkleroots',
    'txidMerkleroot',
    'txidMerklerootIndex',
    'railgunTxidIfHasUnshield',
  ])
    assert.deepEqual(payload[key], expected[key]);
  assert.equal(payload.blindedCommitmentsOut.length, expected.outputCount);
  // Construct the payload from host-derived metadata. Only the proof and
  // receiver-derived blinded outputs originate with the viewing utility.
  return normalizeRailgunPoiPayload({
    listKey: expected.listKey,
    poiMerkleroots: expected.poiMerkleroots,
    txidMerkleroot: expected.txidMerkleroot,
    txidMerklerootIndex: expected.txidMerklerootIndex,
    railgunTxidIfHasUnshield: expected.railgunTxidIfHasUnshield,
    proof: payload.proof,
    blindedCommitmentsOut: payload.blindedCommitmentsOut,
  });
}
module.exports = {
  normalizeRailgunOwnPoiProofInput,
  expectedRailgunOwnPoiFields,
  bindRailgunOwnPoiPayload,
};
