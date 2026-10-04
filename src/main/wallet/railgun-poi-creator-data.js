/** Bounded creator relationships only. These data predicates authenticate no
 * source, owner, current root, POI status or spending capability. Generic note
 * provenance uses this narrower shape only when an unshield row is present.
 */
const assert = require('assert/strict');
const { types } = require('util');
const { normalizeRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun POI creator data unavailable'), {
    code: 'RAILGUN_POI_CREATOR_DATA_REFUSED',
  });
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value));
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys)
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
};
const integer = (value, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;
const hex = (value, n = 64) =>
  typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${n}}$`).test(value);
const field = (value) => hex(value) && BigInt(value) < FIELD;
const positive = (value) =>
  typeof value === 'string' && /^[1-9][0-9]{0,36}$/.test(value) && BigInt(value) < 1n << 120n;
const oneField = (values) => {
  assert.ok(Array.isArray(values) && !types.isProxy(values));
  assert.deepEqual(Reflect.ownKeys(values), ['0', 'length']);
  assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(values, '0'), 'value'));
  assert.ok(field(values[0]));
  return Object.freeze([values[0]]);
};
function eventsFor({ note, events }) {
  shape(note, ['type', 'txid', 'hash', 'tree', 'position', 'blockNumber']);
  assert.equal(note.type, 'Transact');
  assert.ok(hex(note.txid) && field(note.hash));
  assert.ok(
    integer(note.tree, 65535) && integer(note.position, 65535) && integer(note.blockNumber)
  );
  assert.ok(Array.isArray(events) && !types.isProxy(events) && [2, 3].includes(events.length));
  assert.deepEqual(Reflect.ownKeys(events), [...events.keys()].map(String).concat('length'));
  const copied = [];
  let previous = -1;
  for (let i = 0; i < events.length; i++) {
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(events, String(i)), 'value'));
    const event = events[i];
    const name = i === 0 ? 'Nullified' : i === events.length - 1 ? 'Transact' : 'Unshield';
    shape(
      event,
      name === 'Nullified'
        ? ['name', 'logIndex', 'tree', 'values']
        : name === 'Transact'
          ? ['name', 'logIndex', 'tree', 'start', 'hashes']
          : ['name', 'logIndex', 'to', 'token', 'type', 'subID', 'value']
    );
    assert.equal(event.name, name);
    assert.ok(integer(event.logIndex) && event.logIndex > previous);
    previous = event.logIndex;
    if (name === 'Nullified') {
      assert.ok(integer(event.tree, 65535));
      copied.push(
        Object.freeze({
          name,
          logIndex: event.logIndex,
          tree: event.tree,
          values: oneField(event.values),
        })
      );
    } else if (name === 'Transact') {
      assert.equal(event.tree, note.tree);
      assert.equal(event.start, note.position);
      const hashes = oneField(event.hashes);
      assert.equal(hashes[0], note.hash);
      copied.push(
        Object.freeze({
          name,
          logIndex: event.logIndex,
          tree: event.tree,
          start: event.start,
          hashes,
        })
      );
    } else {
      assert.ok(hex(event.to, 40));
      assert.equal(event.token, pins.wrappedNative);
      assert.equal(event.type, 0);
      assert.equal(event.subID, '0');
      assert.ok(positive(event.value));
      copied.push(
        Object.freeze({
          name,
          logIndex: event.logIndex,
          to: event.to,
          token: event.token,
          type: 0,
          subID: '0',
          value: event.value,
        })
      );
    }
  }
  return Object.freeze({ events: Object.freeze(copied), hasUnshield: copied.length === 3 });
}
function witnessFor({ state, note, noteWitness }) {
  const normalized = normalizeRailgunNoteTxidWitness(noteWitness, state, note);
  const row = normalized.witness.row;
  const hasUnshield = Object.hasOwn(row, 'unshield');
  assert.equal(normalized.outputIndex, 0);
  assert.equal(row.nullifiers.length, 1);
  assert.equal(row.commitments.length, hasUnshield ? 2 : 1);
  assert.ok(row.utxoTreeOut < 65536 && row.utxoBatchStartPositionOut < 65536);
  if (hasUnshield) {
    assert.ok(row.unshield);
    assert.deepEqual(row.unshield.tokenData, {
      tokenType: 0,
      tokenAddress: pins.wrappedNative,
      tokenSubID: '0x' + '0'.repeat(64),
    });
    assert.ok(positive(row.unshield.value));
  }
  return Object.freeze({ noteWitness: normalized, hasUnshield });
}
function verificationFor({ state, note, noteWitness, verification }) {
  const normalized = witnessFor({ state, note, noteWitness });
  for (const key of ['pathVerified', 'suppliedCreatorEventsMatched', 'utilityExitObserved'])
    assert.equal(verification[key], true);
  assert.deepEqual(verification.coverage, {
    matchedRows: 1,
    knownOmissions: 0,
    boundParamsChecked: false,
    unshieldCommitmentHashesChecked: false,
    globalTxidCompleteness: false,
  });
  assert.equal(Object.hasOwn(verification, 'unshieldCommitmentVerified'), normalized.hasUnshield);
  if (normalized.hasUnshield) assert.equal(verification.unshieldCommitmentVerified, true);
  return normalized.noteWitness;
}
const guarded = (fn) => (options) => {
  try {
    return fn(options);
  } catch {
    throw fail();
  }
};
module.exports = {
  assertRailgunPoiCreatorEvents: guarded(eventsFor),
  normalizeRailgunPoiCreatorWitness: guarded(witnessFor),
  assertRailgunPoiCreatorVerification: guarded(verificationFor),
};
