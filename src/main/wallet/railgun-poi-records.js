/** Bounded POI input/response validation. Membership proves inclusion in the
 * supplied list root, not ownership, canonical history or spending permission.
 * Poseidon is supplied only by the guarded, pinned engine job.
 */
const { createPublicKey, verify } = require('crypto');
// shared-models b37e643ef38e3df554deffa33f40530b20ce9065, POI_REQUIRED_LISTS.
const REQUIRED_LIST = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88';
const listPublicKey = createPublicKey({
  key: Buffer.from('302a300506032b6570032100' + REQUIRED_LIST, 'hex'),
  format: 'der',
  type: 'spki',
});
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_NOTES = 3;
const fail = () =>
  Object.assign(new Error('Railgun POI evidence unavailable'), {
    code: 'RAILGUN_POI_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
const shape = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
function field(value) {
  check(typeof value === 'string' && /^(0x)?[0-9a-f]{64}$/.test(value));
  const text = value.replace(/^0x/, '');
  check(BigInt('0x' + text) < FIELD);
  return text;
}
function normalizePoiNotes(input) {
  check(Array.isArray(input) && input.length >= 1 && input.length <= MAX_NOTES);
  const result = input.map((note) => {
    check(shape(note, ['blindedCommitment', 'type']) && ['Shield', 'Transact'].includes(note.type));
    return { blindedCommitment: '0x' + field(note.blindedCommitment), type: note.type };
  });
  check(new Set(result.map((n) => n.blindedCommitment)).size === result.length);
  return freeze(result);
}
function normalizePoiStatuses(input, notes) {
  notes = normalizePoiNotes(notes);
  check(
    shape(
      input,
      notes.map((n) => n.blindedCommitment)
    )
  );
  return freeze(
    notes.map(({ blindedCommitment, type }) => {
      const status = input[blindedCommitment];
      check(shape(status, [REQUIRED_LIST]));
      check(
        ['Valid', 'ShieldBlocked', 'ProofSubmitted', 'Missing'].includes(status[REQUIRED_LIST])
      );
      return { blindedCommitment, type, status: status[REQUIRED_LIST] };
    })
  );
}
function normalizePoiProofs(input, notes) {
  notes = normalizePoiNotes(notes);
  check(Array.isArray(input) && input.length === notes.length);
  return freeze(
    input.map((proof, index) => {
      check(shape(proof, ['leaf', 'elements', 'indices', 'root']));
      check(Array.isArray(proof.elements) && proof.elements.length === 16);
      const leaf = field(proof.leaf),
        indices = field(proof.indices);
      check(leaf === notes[index].blindedCommitment.slice(2));
      check(BigInt('0x' + indices) < 65536n);
      return { leaf, elements: proof.elements.map(field), indices, root: field(proof.root) };
    })
  );
}
function verifyPoiMembership(input, notes, hashPair) {
  check(typeof hashPair === 'function');
  const proofs = normalizePoiProofs(input, notes);
  for (const proof of proofs) {
    let hash = proof.leaf;
    const indices = BigInt('0x' + proof.indices);
    for (let level = 0; level < 16; level++) {
      const sibling = proof.elements[level];
      hash = field(
        (indices & (1n << BigInt(level))) === 0n ? hashPair(hash, sibling) : hashPair(sibling, hash)
      );
    }
    check(hash === proof.root);
  }
  return proofs;
}
function verifyPoiEvent(input, note, proof) {
  const normalized = normalizePoiNotes([note])[0];
  const path = normalizePoiProofs([proof], [normalized])[0];
  check(Array.isArray(input) && input.length === 1);
  const record = input[0];
  check(shape(record, ['signedPOIEvent', 'validatedMerkleroot']));
  const event = record.signedPOIEvent;
  check(shape(event, ['index', 'blindedCommitment', 'signature', 'type']));
  check(Number.isSafeInteger(event.index) && event.index >= 0 && event.index < 65536);
  check(event.index === Number(BigInt('0x' + path.indices)) && event.type === normalized.type);
  check('0x' + field(event.blindedCommitment) === normalized.blindedCommitment);
  check(typeof event.signature === 'string' && /^[0-9a-f]{128}$/.test(event.signature));
  // Preserve the exact signed string and key order. The upstream ed25519 message
  // omits chain/root, so local note provenance and current root checks remain
  // necessary. validatedMerkleroot is an unsigned historical service assertion.
  const message = Buffer.from(
    JSON.stringify({
      index: event.index,
      blindedCommitment: event.blindedCommitment,
      type: event.type,
    }),
    'utf8'
  );
  check(verify(null, message, listPublicKey, Buffer.from(event.signature, 'hex')));
  return freeze({
    signedPOIEvent: { ...event },
    validatedMerkleroot: field(record.validatedMerkleroot),
  });
}
module.exports = {
  REQUIRED_LIST,
  MAX_NOTES,
  normalizePoiNotes,
  normalizePoiStatuses,
  normalizePoiProofs,
  verifyPoiMembership,
  verifyPoiEvent,
};
