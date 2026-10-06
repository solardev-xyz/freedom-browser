/** Pure local-custody record format. No storage, ownership, cryptographic proof,
 * signing, discard or export authority follows from decoding these values.
 * A future fixed account owner must authenticate storage and all record/ledger
 * joins. Every retained row reserves its largest future signature/proof/terminal
 * form before admission; later completion cannot consume another row's space.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { shape, freeze } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const {
  normalizeRailgunRelayPoiHistory,
  MAX_HISTORY_BYTES,
} = require('./railgun-relay-poi-history');
const {
  normalizeRailgunRelayPrePoiBinding,
  bindRailgunRelayPrePoiPayload,
  RAILGUN_RELAY_PRE_POI_MAX_BINDING_BYTES,
  RAILGUN_RELAY_PRE_POI_MAX_PAYLOAD_BYTES,
} = require('./railgun-relay-pre-poi-data');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const { matchRailgunRelayProvedTransaction } = require('./railgun-relay-transaction');
const LIMITS = Object.freeze({
  draft: 65536,
  history: MAX_HISTORY_BYTES,
  prePoiBinding: RAILGUN_RELAY_PRE_POI_MAX_BINDING_BYTES,
  signature: 256,
  transaction: 16640,
  payload: RAILGUN_RELAY_PRE_POI_MAX_PAYLOAD_BYTES,
  // Includes all field names, delimiters, fixed digests, schema and state.
  metadata: 4096,
  record: 98304,
  records: 10,
  envelope: 4096,
  document: 987136,
  sequence: 50,
});
const IMMUTABLE = [
  'schema',
  'id',
  'binding',
  'walletId',
  'generationId',
  'checkpointHash',
  'authorizationDigest',
  'draft',
  'history',
  'prePoiBinding',
];
const STATES = [
  'held',
  'signing-local',
  'signed',
  'ready-local',
  'cancelled-unsigned',
  'discarded-signed',
];
const fail = () =>
  Object.assign(new Error('Railgun local relay recovery data refused'), {
    code: 'RAILGUN_RELAY_RECOVERY_DATA_REFUSED',
  });
const bounded = (value, bytes) => {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= bytes);
  return value;
};
const digest = (value) => {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[0-9a-f]{64}$/);
  return value;
};
function record(value) {
  shape(value, [...IMMUTABLE, 'state', 'signature', 'proved']);
  assert.equal(value.schema, 'railgun-relay-local-record-v4');
  for (const key of IMMUTABLE.slice(1, 7)) digest(value[key]);
  assert.ok(STATES.includes(value.state));
  const draft = normalizeRailgunRelayDraftCapsule(value.draft);
  bounded(draft.data, LIMITS.draft);
  assert.equal(draft.data.walletId, value.walletId);
  const history = normalizeRailgunRelayPoiHistory(value.history).data;
  bounded(history, LIMITS.history);
  const prePoiBinding = normalizeRailgunRelayPrePoiBinding(value.prePoiBinding);
  assert.equal(history.draftDigest, draft.digest);
  assert.equal(prePoiBinding.draftDigest, draft.digest);
  assert.deepEqual(prePoiBinding.listWitness, history.proof);
  const signature =
    value.signature === null
      ? null
      : bounded(normalizeRailgunSignature(value.signature), LIMITS.signature);
  let proved = null;
  if (value.proved !== null) {
    assert.ok(signature);
    shape(value.proved, ['transaction', 'payload']);
    const matched = matchRailgunRelayProvedTransaction(
      draft.data.intent,
      value.proved.transaction
    ).transaction;
    const transaction = {
      chainId: matched.chainId,
      to: matched.to,
      value: matched.value,
      data: matched.data,
    };
    const payload = bindRailgunRelayPrePoiPayload(value.proved.payload, prePoiBinding).payload;
    bounded(transaction, LIMITS.transaction);
    bounded(payload, LIMITS.payload);
    proved = { transaction, payload };
  }
  if (['held', 'signing-local', 'cancelled-unsigned'].includes(value.state))
    assert.equal(signature, null);
  if (['signed', 'ready-local'].includes(value.state)) assert.ok(signature);
  if (!['ready-local', 'discarded-signed'].includes(value.state)) assert.equal(proved, null);
  if (value.state === 'ready-local') assert.ok(proved);
  const result = {
    schema: value.schema,
    id: value.id,
    binding: value.binding,
    walletId: value.walletId,
    generationId: value.generationId,
    checkpointHash: value.checkpointHash,
    authorizationDigest: value.authorizationDigest,
    draft: draft.data,
    history,
    prePoiBinding,
    state: value.state,
    signature,
    proved,
  };
  const metadata = {
    ...result,
    draft: null,
    history: null,
    prePoiBinding: null,
    signature: null,
    proved: { transaction: null, payload: null },
  };
  bounded(metadata, LIMITS.metadata);
  return freeze(bounded(result, LIMITS.record));
}
function decodeRailgunRelayLocalRecord(text) {
  try {
    assert.equal(typeof text, 'string');
    assert.ok(Buffer.byteLength(text) <= LIMITS.record);
    const parsed = JSON.parse(text);
    assert.equal(JSON.stringify(parsed), text);
    const result = record(parsed);
    assert.equal(JSON.stringify(result), text);
    return result;
  } catch {
    throw fail();
  }
}
function digestRailgunRelayLocalIntent(text) {
  const value = decodeRailgunRelayLocalRecord(text);
  return createHash('sha256')
    .update('freedom:railgun:relay-local-intent-v4\0')
    .update(JSON.stringify(Object.fromEntries(IMMUTABLE.map((key) => [key, value[key]]))))
    .digest('hex');
}
/** Match detached data from two independently authenticated stores. This does
 * not authenticate either store or authorize signing/release. The fixed owner
 * must additionally assert the account, generation, floors and live exclusion.
 * Signing writes the ledger marker first; retirement writes the record first.
 * Only those two orders produce recoverable intermediate pairs.
 */
function matchRailgunRelayLocalReservation(text, entry) {
  try {
    const value = decodeRailgunRelayLocalRecord(text);
    shape(entry, ['id', 'origin', 'facts', 'state', 'signing']);
    assert.equal(entry.id, value.id);
    assert.equal(entry.origin, 'relay-local-v4');
    const draftDigest = normalizeRailgunRelayDraftCapsule(value.draft).digest;
    const expected = {
      tree: value.draft.selection.tree,
      position: value.draft.selection.position,
      nullifier: value.draft.intent.expected.nullifier,
      noteHash: value.draft.noteHash,
      kind: 'railgun-relay-self-transfer',
      checkpointHash: value.checkpointHash,
      draftDigest,
      expectedHash: value.draft.intent.expectedHash,
    };
    shape(entry.facts, Object.keys(expected));
    for (const key of Object.keys(expected)) assert.equal(entry.facts[key], expected[key]);
    const recordDigest = digestRailgunRelayLocalIntent(text);
    if (['signing-local', 'discarded-signed'].includes(entry.state)) {
      shape(entry.signing, ['gatesDigest', 'recordDigest']);
      assert.equal(entry.signing.gatesDigest, value.authorizationDigest);
      assert.equal(entry.signing.recordDigest, recordDigest);
    } else assert.equal(entry.signing, null);
    let interruptedStep = null;
    if (entry.state === 'held') {
      assert.ok(['held', 'cancelled-unsigned'].includes(value.state));
      if (value.state === 'cancelled-unsigned') interruptedStep = 'release-unsigned';
    } else if (entry.state === 'signing-local') {
      assert.ok(
        ['held', 'signing-local', 'signed', 'ready-local', 'discarded-signed'].includes(value.state)
      );
      if (value.state === 'held') interruptedStep = 'mark-recovery-signing';
      if (value.state === 'discarded-signed') interruptedStep = 'release-signed';
    } else {
      assert.ok(['cancelled-unsigned', 'discarded-signed'].includes(entry.state));
      assert.equal(entry.state, value.state);
    }
    return freeze({
      record: value,
      recordDigest,
      draftDigest,
      reservationState: entry.state,
      interruptedStep,
      authorityGranted: false,
    });
  } catch {
    throw fail();
  }
}
function cost(value) {
  if (value.state === 'held') return 1;
  if (value.state === 'cancelled-unsigned') return 2;
  return (
    2 +
    Number(value.signature !== null) +
    Number(value.proved !== null) +
    Number(value.state === 'discarded-signed')
  );
}
function decodeRailgunRelayLocalDocument(text, context) {
  try {
    shape(context, ['binding', 'walletId']);
    digest(context.binding);
    digest(context.walletId);
    assert.equal(typeof text, 'string');
    assert.ok(Buffer.byteLength(text) <= LIMITS.document);
    const value = JSON.parse(text);
    assert.equal(JSON.stringify(value), text);
    shape(value, ['version', 'binding', 'walletId', 'lease', 'sequence', 'entries']);
    assert.equal(value.version, 4);
    assert.equal(value.binding, context.binding);
    assert.equal(value.walletId, context.walletId);
    digest(value.lease);
    assert.ok(Array.isArray(value.entries) && value.entries.length <= LIMITS.records);
    const entries = value.entries.map((entry) => {
      const result = record(entry);
      assert.equal(result.binding, context.binding);
      assert.equal(result.walletId, context.walletId);
      return result;
    });
    assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
    assert.equal(
      value.sequence,
      entries.reduce((sum, entry) => sum + cost(entry), 0)
    );
    assert.ok(value.sequence <= LIMITS.sequence);
    const result = freeze({
      version: 4,
      binding: context.binding,
      walletId: context.walletId,
      lease: value.lease,
      sequence: value.sequence,
      entries,
    });
    bounded({ ...result, entries: [] }, LIMITS.envelope);
    assert.equal(JSON.stringify(result), text);
    return bounded(result, LIMITS.document);
  } catch {
    throw fail();
  }
}
module.exports = {
  decodeRailgunRelayLocalRecord,
  digestRailgunRelayLocalIntent,
  matchRailgunRelayLocalReservation,
  decodeRailgunRelayLocalDocument,
  RAILGUN_RELAY_LOCAL_LIMITS: LIMITS,
};
