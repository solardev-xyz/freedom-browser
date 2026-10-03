/** Public-data lookup for a Transact commitment's creating TXID. Callers must
 * supply the guarded projection and an exclusive authenticated store snapshot.
 * This relation and Merkle path do not establish ownership, canonical event
 * coverage, service-root acceptance, POI validity or permission to spend.
 */
const { createHash } = require('crypto');
const { validateRailgunTxidRow } = require('./railgun-txid-projection');
const { classifyRailgunTxidContinuity } = require('./railgun-txid-omissions');
const fail = () =>
  Object.assign(new Error('Railgun note TXID witness unavailable'), {
    code: 'RAILGUN_TXID_NOTE_WITNESS_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const hex = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const bare = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const field = (value) =>
  bare(value) &&
  BigInt('0x' + value) <
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const shape = (value, keys) =>
  value &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function selectedNote(note) {
  check(
    note &&
      Object.keys(note).length === 6 &&
      ['type', 'txid', 'hash', 'tree', 'position', 'blockNumber'].every((key) =>
        Object.hasOwn(note, key)
      ) &&
      note.type === 'Transact' &&
      hex(note.txid) &&
      hex(note.hash) &&
      BigInt(note.hash) <
        21888242871839275222246405745257275088548364400416034343698204186575808495617n &&
      integer(note.tree, 0xffffffff) &&
      note.tree !== 99999 &&
      integer(note.position, 65535) &&
      integer(note.blockNumber, Number.MAX_SAFE_INTEGER)
  );
  return Object.freeze({ ...note });
}
async function findRailgunNoteTxidWitness({ state, note, read, projection }) {
  const selected = selectedNote(note);
  check(
    typeof read === 'function' &&
      typeof projection?.inspect === 'function' &&
      typeof projection.inspectRecord === 'function' &&
      typeof projection.witness === 'function'
  );
  // Copy before the first asynchronous read so caller mutation cannot change
  // either the selector or the checkpoint halfway through the bounded scan.
  const current = projection.inspect(state);
  check(integer(current.count, 8000) && current.count > 0);
  let match;
  for (let index = 0; index < current.count; index++) {
    const record = projection.inspectRecord(await read(`txid:row:${index}`));
    const row = record.row;
    if (
      row.txid !== selected.txid.slice(2) ||
      row.blockNumber !== selected.blockNumber ||
      row.utxoTreeOut !== selected.tree
    )
      continue;
    const outputIndex = selected.position - row.utxoBatchStartPositionOut;
    // The last commitment of an unshield transaction is not a UTXO leaf.
    const outputCount = row.commitments.length - (row.unshield ? 1 : 0);
    if (outputIndex < 0 || outputIndex >= outputCount) continue;
    if (row.commitments[outputIndex] !== selected.hash) continue;
    check(!match);
    match = { index, outputIndex, record };
  }
  check(match);
  const witness = await projection.witness(current, match.record.railgunTxid, read);
  check(
    witness.index === match.index &&
      witness.rowSha256 === match.record.rowSha256 &&
      witness.railgunTxid === match.record.railgunTxid &&
      witness.root === current.root &&
      witness.checkpointIndex === current.count - 1 &&
      witness.transcript === current.transcript
  );
  return Object.freeze({
    note: selected,
    outputIndex: match.outputIndex,
    witness,
    ownershipVerified: false,
    eventCoverageVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  });
}
// Main checks the returned schema and public relationships without loading
// Poseidon. Cryptographic path verification remains the guarded job's work;
// this normalizer deliberately creates no acceptance or ownership authority.
function normalizeRailgunTxidWitness(value, state, txid) {
  check(
    shape(value, [
      'row',
      'leaf',
      'railgunTxid',
      'rowSha256',
      'index',
      'elements',
      'root',
      'checkpointIndex',
      'transcript',
      'continuity',
      'globalTxidCompleteness',
    ])
  );
  check(Buffer.byteLength(JSON.stringify(value)) <= 32768);
  const copied = JSON.parse(JSON.stringify(value));
  validateRailgunTxidRow(copied.row);
  check(integer(state?.count, 8000) && state.count > 0);
  check(
    integer(copied.index, state.count - 1) &&
      field(copied.leaf) &&
      field(copied.railgunTxid) &&
      field(copied.root) &&
      bare(copied.rowSha256) &&
      bare(copied.transcript) &&
      copied.rowSha256 === createHash('sha256').update(JSON.stringify(copied.row)).digest('hex') &&
      copied.root === state.root &&
      copied.transcript === state.transcript &&
      copied.checkpointIndex === state.count - 1 &&
      copied.globalTxidCompleteness === false &&
      Array.isArray(copied.elements) &&
      copied.elements.length === 16 &&
      copied.elements.every(field)
  );
  check(
    JSON.stringify(copied.continuity) ===
      JSON.stringify(classifyRailgunTxidContinuity(state.count - 1, state.breaks))
  );
  if (txid !== undefined) check(field(txid) && copied.railgunTxid === txid);
  return freeze(copied);
}
function normalizeRailgunNoteTxidWitness(value, state, note) {
  const selected = selectedNote(note);
  check(
    shape(value, [
      'note',
      'outputIndex',
      'witness',
      'ownershipVerified',
      'eventCoverageVerified',
      'rootAccepted',
      'spendingEnabled',
    ])
  );
  check(
    value.ownershipVerified === false &&
      value.eventCoverageVerified === false &&
      value.rootAccepted === false &&
      value.spendingEnabled === false &&
      shape(value.note, Object.keys(selected)) &&
      Object.keys(selected).every((key) => value.note[key] === selected[key]) &&
      integer(value.outputIndex, 12)
  );
  const witness = normalizeRailgunTxidWitness(value.witness, state);
  const row = witness.row;
  check(
    row.txid === selected.txid.slice(2) &&
      row.blockNumber === selected.blockNumber &&
      row.utxoTreeOut === selected.tree &&
      row.utxoBatchStartPositionOut + value.outputIndex === selected.position &&
      value.outputIndex < row.commitments.length - (row.unshield ? 1 : 0) &&
      row.commitments[value.outputIndex] === selected.hash
  );
  return Object.freeze({
    note: selected,
    outputIndex: value.outputIndex,
    witness,
    ownershipVerified: false,
    eventCoverageVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  });
}
module.exports = {
  findRailgunNoteTxidWitness,
  normalizeRailgunTxidWitness,
  normalizeRailgunNoteTxidWitness,
};
