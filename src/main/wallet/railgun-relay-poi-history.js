/** Original selected-input list evidence retained for local proof continuation.
 * Normalization preserves signed event strings; it verifies neither signature,
 * membership, provenance nor freshness. validatedMerkleroot is an unsigned
 * historical service assertion and need not equal a later membership root.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { isProxy } = require('util').types;
const { shape, freeze } = require('./railgun-relay-quote-data');
const { REQUIRED_LIST, normalizePoiProofs } = require('./railgun-poi-records');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_HISTORY_BYTES = 4096;
function field(value, prefixed = false) {
  assert.equal(typeof value, 'string');
  assert.match(value, prefixed ? /^0x[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/);
  assert.ok(BigInt(prefixed ? value : '0x' + value) < FIELD);
  return value;
}
function normalizeRailgunRelayPoiHistory(value) {
  try {
    shape(value, ['schema', 'draftDigest', 'listKey', 'note', 'proof', 'event']);
    assert.equal(value.schema, 'railgun-relay-input-poi-history-v1');
    assert.equal(typeof value.draftDigest, 'string');
    assert.match(value.draftDigest, /^[0-9a-f]{64}$/);
    assert.equal(value.listKey, REQUIRED_LIST);
    shape(value.note, ['blindedCommitment', 'type']);
    assert.ok(['Shield', 'Transact'].includes(value.note.type));
    const note = {
      blindedCommitment: field(value.note.blindedCommitment, true),
      type: value.note.type,
    };
    shape(value.proof, ['leaf', 'root', 'indices', 'elements']);
    const elements = value.proof.elements;
    assert.ok(
      !isProxy(elements) &&
        Array.isArray(elements) &&
        Object.getPrototypeOf(elements) === Array.prototype
    );
    assert.equal(Reflect.ownKeys(elements).length, 17);
    assert.equal(Object.getOwnPropertyDescriptor(elements, 'length').value, 16);
    const copied = [];
    for (let i = 0; i < 16; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(elements, String(i));
      assert.ok(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
      copied.push(field(descriptor.value));
    }
    const proof = normalizePoiProofs(
      [
        {
          leaf: field(value.proof.leaf),
          root: field(value.proof.root),
          indices: field(value.proof.indices),
          elements: copied,
        },
      ],
      [note]
    )[0];
    shape(value.event, ['signedPOIEvent', 'validatedMerkleroot']);
    const event = value.event.signedPOIEvent;
    shape(event, ['index', 'blindedCommitment', 'signature', 'type']);
    assert.equal(event.index, Number(BigInt('0x' + proof.indices)));
    assert.equal(event.type, note.type);
    assert.equal(typeof event.blindedCommitment, 'string');
    assert.match(event.blindedCommitment, /^(?:0x)?[0-9a-f]{64}$/);
    assert.equal(event.blindedCommitment.replace(/^0x/, ''), proof.leaf);
    assert.equal(typeof event.signature, 'string');
    assert.match(event.signature, /^[0-9a-f]{128}$/);
    const data = freeze({
      schema: value.schema,
      draftDigest: value.draftDigest,
      listKey: REQUIRED_LIST,
      note,
      proof,
      event: {
        // Never canonicalize this prefix: it belongs to the signed message.
        signedPOIEvent: {
          index: event.index,
          blindedCommitment: event.blindedCommitment,
          signature: event.signature,
          type: event.type,
        },
        validatedMerkleroot: field(value.event.validatedMerkleroot),
      },
    });
    const text = JSON.stringify(data);
    assert.ok(Buffer.byteLength(text) <= MAX_HISTORY_BYTES);
    return freeze({
      data,
      digest: createHash('sha256')
        .update('freedom:railgun:relay-input-poi-history-v1\0')
        .update(text)
        .digest('hex'),
    });
  } catch {
    throw Object.assign(new Error('Railgun relay membership history refused'), {
      code: 'RAILGUN_RELAY_POI_HISTORY_REFUSED',
    });
  }
}
module.exports = { normalizeRailgunRelayPoiHistory, MAX_HISTORY_BYTES };
