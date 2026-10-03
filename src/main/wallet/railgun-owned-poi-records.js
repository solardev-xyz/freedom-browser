/** Internal owned-note projection. These facts link private notes and must never
 * enter public reports or the Kohaku read surface. Ownership authority belongs
 * to the guarded scan receipt, not to these serializable records themselves.
 */
const assert = require('assert/strict');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const POI_LAUNCH_BLOCK = 5944700;
function field(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^0x[0-9a-f]{64}$/);
  assert.ok(BigInt(value) < FIELD);
  return value;
}
const canonical = (value) => field('0x' + value.replace(/^0x/, '').toLowerCase());
const hex = (value) => field('0x' + value.toString(16).padStart(64, '0'));
function projectRailgunOwnedPoiRecord(txo, leaf, runtime, derivedNullifier) {
  assert.ok(['ShieldCommitment', 'TransactCommitmentV2'].includes(leaf.commitmentType));
  assert.equal(txo.commitmentType, leaf.commitmentType);
  assert.equal(txo.tree, leaf.utxoTree);
  assert.equal(txo.position, leaf.utxoIndex);
  const note = txo.note;
  assert.equal(typeof note.notePublicKey, 'bigint');
  const npk = hex(note.notePublicKey),
    hash = canonical(leaf.hash);
  assert.equal(hex(note.hash), hash);
  assert.equal(
    hex(runtime.TransactNote.getHash(note.notePublicKey, note.tokenHash, note.value)),
    hash
  );
  if (leaf.commitmentType === 'ShieldCommitment') assert.equal(canonical(leaf.preImage.npk), npk);
  const position = runtime.getGlobalTreePosition(txo.tree, txo.position);
  assert.equal(position, BigInt(txo.tree) * 65536n + BigInt(txo.position));
  const blindedCommitment = field(
    runtime.BlindedCommitment.getForShieldOrTransact(hash, note.notePublicKey, position)
  );
  assert.equal(canonical(txo.blindedCommitment), blindedCommitment);
  const nullifier = canonical(derivedNullifier);
  assert.equal(canonical(txo.nullifier), nullifier);
  return {
    id: `${txo.tree}:${txo.position}`,
    hash,
    txid: '0x' + leaf.txid.replace(/^0x/, '').toLowerCase(),
    npk,
    // Supplied by the enclosing validated loop's independent derivation.
    nullifier,
    blindedCommitment,
    type: leaf.commitmentType === 'ShieldCommitment' ? 'Shield' : 'Transact',
    blockNumber: leaf.blockNumber,
  };
}
function normalizeRailgunOwnedPoiRecords(input, read, checkpoint) {
  assert.ok(Array.isArray(input) && input.length <= 10000);
  assert.equal(input.length, read.received.length);
  assert.ok(Number.isSafeInteger(checkpoint.to.number) && checkpoint.to.number >= 0);
  const expected = new Map(read.received.map((note) => [note.id, note]));
  assert.equal(expected.size, read.received.length);
  const seenBlinded = new Set();
  const records = input.map((record) => {
    assert.deepEqual(
      Object.keys(record).sort(),
      ['id', 'hash', 'txid', 'npk', 'nullifier', 'blindedCommitment', 'type', 'blockNumber'].sort()
    );
    const note = expected.get(record.id);
    assert.ok(note);
    expected.delete(record.id);
    assert.equal(field(record.hash), note.hash);
    assert.match(record.txid, /^0x[0-9a-f]{64}$/);
    assert.equal(record.txid, note.txid);
    field(record.npk);
    field(record.nullifier);
    field(record.blindedCommitment);
    assert.ok(!seenBlinded.has(record.blindedCommitment));
    seenBlinded.add(record.blindedCommitment);
    assert.ok(['Shield', 'Transact'].includes(record.type));
    assert.ok(
      Number.isSafeInteger(record.blockNumber) &&
        record.blockNumber >= 0 &&
        record.blockNumber <= checkpoint.to.number
    );
    return Object.freeze({ ...record });
  });
  assert.equal(expected.size, 0);
  const order = new Map(read.received.map((note, index) => [note.id, index]));
  return Object.freeze(records.sort((a, b) => order.get(a.id) - order.get(b.id)));
}
module.exports = {
  projectRailgunOwnedPoiRecord,
  normalizeRailgunOwnedPoiRecords,
  POI_LAUNCH_BLOCK,
};
