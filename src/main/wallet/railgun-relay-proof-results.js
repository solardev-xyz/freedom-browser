/** Main-only detached proof data joins. No store, ownership or signing authority. */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const { shape, freeze } = require('./railgun-relay-quote-data');
const {
  decodeRailgunRelayLocalRecord,
  digestRailgunRelayLocalIntent,
} = require('./railgun-relay-recovery-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalizeRailgunRelayProofInput(value, walletId) {
  shape(value, ['recordText', 'proverArchive', 'artifactDirectory', 'timeoutMs']);
  const record = decodeRailgunRelayLocalRecord(value.recordText);
  assert.equal(record.state, 'signed');
  assert.equal(record.walletId, walletId);
  for (const name of ['proverArchive', 'artifactDirectory']) {
    assert.equal(typeof value[name], 'string');
    assert.ok(path.isAbsolute(value[name]));
  }
  assert.ok(value.proverArchive.endsWith('.asar'));
  assert.ok(
    Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 110000
  );
  return Object.freeze({ ...value });
}
function normalizeRailgunRelayProducedProof(value, recordText) {
  shape(value, [
    'recordDigest',
    'draftDigest',
    'historyDigest',
    'expectedHash',
    'transaction',
    'payload',
    'transactionDigest',
    'payloadDigest',
    'locallyVerified',
    'independentlyVerified',
  ]);
  const record = decodeRailgunRelayLocalRecord(recordText);
  assert.equal(record.state, 'signed');
  // Reuse the canonical record's exact transaction/payload bounds and joins.
  const matched = require('./railgun-relay-transaction').matchRailgunRelayProvedTransaction(
    record.draft.intent,
    value.transaction
  ).transaction;
  const transaction = Object.fromEntries(
    ['chainId', 'to', 'value', 'data'].map((key) => [key, matched[key]])
  );
  const payload = require('./railgun-relay-pre-poi-data').bindRailgunRelayPrePoiPayload(
    value.payload,
    record.prePoiBinding
  ).payload;
  const ready = decodeRailgunRelayLocalRecord(
    JSON.stringify({
      ...record,
      state: 'ready-local',
      proved: { transaction, payload },
    })
  );
  const result = {
    recordDigest: digestRailgunRelayLocalIntent(recordText),
    draftDigest: normalizeRailgunRelayDraftCapsule(record.draft).digest,
    historyDigest: normalizeRailgunRelayPoiHistory(record.history).digest,
    expectedHash: record.draft.intent.expectedHash,
    transaction: ready.proved.transaction,
    payload: ready.proved.payload,
    transactionDigest: digest(ready.proved.transaction),
    payloadDigest: digest(ready.proved.payload),
    locallyVerified: true,
    independentlyVerified: false,
  };
  assert.deepEqual(value, result);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  return freeze(result);
}
function createRailgunRelayReadyCandidate(recordText, value) {
  const proof = normalizeRailgunRelayProducedProof(value, recordText),
    record = decodeRailgunRelayLocalRecord(recordText);
  return JSON.stringify(
    decodeRailgunRelayLocalRecord(
      JSON.stringify({
        ...record,
        state: 'ready-local',
        proved: { transaction: proof.transaction, payload: proof.payload },
      })
    )
  );
}
function bindRailgunRelayLocalOwned(recordText, { walletId, read, ownedPoi, trees }) {
  const record = decodeRailgunRelayLocalRecord(recordText),
    data = record.draft;
  assert.equal(record.state, 'signed');
  assert.equal(record.walletId, walletId);
  assert.equal(data.engineSha256, require('./railgun-engine-manifest.json').sha256);
  assert.equal(data.intent.context.self.address, read.instanceId);
  const id = `${data.selection.tree}:${data.selection.position}`,
    notes = read.received.filter((note) => note.id === id),
    owned = ownedPoi.filter((note) => note.id === id),
    selectedTrees = trees.filter((tree) => tree.tree === data.selection.tree);
  assert.equal(notes.length, 1);
  assert.equal(owned.length, 1);
  assert.equal(selectedTrees.length, 1);
  assert.ok(data.selection.position < selectedTrees[0].length);
  const note = notes[0],
    selected = owned[0];
  assert.equal(note.spentTxid, false);
  assert.equal(note.hash, data.noteHash);
  assert.equal(selected.hash, data.noteHash);
  assert.equal(selected.txid, note.txid);
  assert.equal(note.asset.__type, 'erc20');
  assert.equal(note.asset.contract, require('./railgun-shield-pins.json').wrappedNative);
  assert.equal(note.amount.toString(), data.intent.context.inputAmount);
  assert.equal(selected.nullifier, data.intent.expected.nullifier);
  assert.equal(selected.blindedCommitment, record.history.note.blindedCommitment);
  assert.equal(selected.type, record.history.note.type);
  // Original signed root/path are verified in the fixed local reconstruction;
  // current root equality is deliberately required only by unsigned admission.
}
function normalizeRailgunRelayProofVerification(value, recordText, proof) {
  const produced = normalizeRailgunRelayProducedProof(proof, recordText);
  const wanted = {
    engineSha256: require('./railgun-engine-manifest.json').sha256,
    proverSha256: require('./railgun-prover-manifest.json').sha256,
    artifactVkeys: Object.fromEntries(
      ['01x02', 'POI_3x3'].map((variant) => [
        variant,
        require('./railgun-artifacts').manifest[variant].find((entry) => entry.kind === 'vkey')
          .sha256,
      ])
    ),
    ...Object.fromEntries(
      [
        'recordDigest',
        'draftDigest',
        'historyDigest',
        'expectedHash',
        'transactionDigest',
        'payloadDigest',
      ].map((key) => [key, produced[key]])
    ),
    transactionVerified: true,
    prePoiVerified: true,
    historicalEventSignatureVerified: true,
    historicalMembershipPathVerified: true,
    inputOwnershipVerified: false,
    currentMembershipVerified: false,
    authorityGranted: false,
  };
  shape(value, Object.keys(wanted));
  shape(value.artifactVkeys, ['01x02', 'POI_3x3']);
  assert.deepEqual(value, wanted);
  return freeze(wanted);
}
module.exports = {
  normalizeRailgunRelayProofInput,
  normalizeRailgunRelayProducedProof,
  createRailgunRelayReadyCandidate,
  bindRailgunRelayLocalOwned,
  normalizeRailgunRelayProofVerification,
};
