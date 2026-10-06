/** Internal pre-transaction relay POI values for one input, fee first/self second,
 * Sepolia WETH and no unshield. Normalization/binding establishes structural
 * agreement only, not proof validity, membership, source, disclosure or signing
 * authority. A guarded pinned-engine reconstruction must derive/check the TXID
 * leaf, synthetic root and blinded outputs. Never substitute mined own-POI data.
 */
const assert = require('assert/strict');
const { isProxy } = require('util').types;
const { REQUIRED_LIST } = require('./railgun-poi-records');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
// Exact compact JSON maxima for the fixed schemas below: all roots/digests are
// fixed width, the list witness has 16 siblings, and proof has eight coordinates
// of at most 77 decimal digits. These are per-value budgets, not a store format.
const RAILGUN_RELAY_PRE_POI_MAX_BINDING_BYTES = 1912;
const RAILGUN_RELAY_PRE_POI_MAX_PAYLOAD_BYTES = 1055;
const RAILGUN_RELAY_PRE_POI_MAX_BOUND_BYTES = 3032;
const fail = () =>
  Object.assign(new Error('Railgun relay pre-transaction POI data refused'), {
    code: 'RAILGUN_RELAY_PRE_POI_DATA_REFUSED',
  });
function shape(value, names) {
  assert.ok(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...names].sort());
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    assert.ok(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}
function array(value, length, item) {
  assert.ok(value && !isProxy(value) && Array.isArray(value));
  assert.equal(Object.getPrototypeOf(value), Array.prototype);
  assert.deepEqual(Reflect.ownKeys(value), [...Array(length).keys()].map(String).concat('length'));
  assert.equal(Object.getOwnPropertyDescriptor(value, 'length').value, length);
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    assert.ok(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    result.push(item(descriptor.value));
  }
  return Object.freeze(result);
}
function hex(value, prefix = '') {
  assert.equal(typeof value, 'string');
  assert.match(value, prefix ? /^0x[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/);
  return value;
}
function field(value, prefix = '') {
  hex(value, prefix);
  assert.ok(BigInt(prefix ? value : '0x' + value) < FIELD);
  return value;
}
function outputs(value) {
  const result = array(value, 2, (item) => {
    field(item, '0x');
    assert.ok(BigInt(item) > 0n);
    return item;
  });
  assert.notEqual(result[0], result[1]);
  return result;
}
function point(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(?:0|[1-9][0-9]{0,76})$/);
  assert.ok(BigInt(value) < BASE);
  return value;
}
function bounded(value, maximum) {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= maximum);
  return Object.freeze(value);
}
function normalizeRailgunRelayPrePoiBinding(value) {
  try {
    shape(value, [
      'schema',
      'draftDigest',
      'chainId',
      'txidVersion',
      'listKey',
      'listWitness',
      'txidLeafHash',
      'txidMerkleroot',
      'blindedCommitmentsOut',
    ]);
    assert.equal(value.schema, 'railgun-relay-pre-poi-binding-v1');
    assert.equal(value.chainId, pins.chainId);
    assert.equal(value.txidVersion, 'V2_PoseidonMerkle');
    assert.equal(value.listKey, REQUIRED_LIST);
    shape(value.listWitness, ['leaf', 'root', 'indices', 'elements']);
    const witness = value.listWitness;
    const indices = field(witness.indices);
    assert.ok(BigInt('0x' + indices) < 65536n);
    const listWitness = Object.freeze({
      leaf: field(witness.leaf),
      root: field(witness.root),
      indices,
      elements: array(witness.elements, 16, (item) => field(item)),
    });
    return bounded(
      {
        schema: 'railgun-relay-pre-poi-binding-v1',
        draftDigest: hex(value.draftDigest),
        chainId: pins.chainId,
        txidVersion: 'V2_PoseidonMerkle',
        listKey: REQUIRED_LIST,
        listWitness,
        txidLeafHash: field(value.txidLeafHash),
        txidMerkleroot: field(value.txidMerkleroot),
        blindedCommitmentsOut: outputs(value.blindedCommitmentsOut),
      },
      RAILGUN_RELAY_PRE_POI_MAX_BINDING_BYTES
    );
  } catch {
    throw fail();
  }
}
function normalizeRailgunRelayPrePoiPayload(value) {
  try {
    shape(value, [
      'snarkProof',
      'txidMerkleroot',
      'poiMerkleroots',
      'blindedCommitmentsOut',
      'railgunTxidIfHasUnshield',
    ]);
    shape(value.snarkProof, ['pi_a', 'pi_b', 'pi_c']);
    const pair = (item) => array(item, 2, point);
    const snarkProof = Object.freeze({
      pi_a: pair(value.snarkProof.pi_a),
      pi_b: array(value.snarkProof.pi_b, 2, pair),
      pi_c: pair(value.snarkProof.pi_c),
    });
    assert.equal(value.railgunTxidIfHasUnshield, '0x00');
    return bounded(
      {
        snarkProof,
        txidMerkleroot: field(value.txidMerkleroot),
        poiMerkleroots: array(value.poiMerkleroots, 1, (item) => field(item)),
        blindedCommitmentsOut: outputs(value.blindedCommitmentsOut),
        railgunTxidIfHasUnshield: '0x00',
      },
      RAILGUN_RELAY_PRE_POI_MAX_PAYLOAD_BYTES
    );
  } catch {
    throw fail();
  }
}
function bindRailgunRelayPrePoiPayload(value, expected) {
  try {
    const binding = normalizeRailgunRelayPrePoiBinding(expected);
    const payload = normalizeRailgunRelayPrePoiPayload(value);
    assert.equal(payload.txidMerkleroot, binding.txidMerkleroot);
    assert.deepEqual(payload.poiMerkleroots, [binding.listWitness.root]);
    assert.deepEqual(payload.blindedCommitmentsOut, binding.blindedCommitmentsOut);
    return bounded(
      { schema: 'railgun-relay-pre-poi-bound-v1', binding, payload },
      RAILGUN_RELAY_PRE_POI_MAX_BOUND_BYTES
    );
  } catch {
    throw fail();
  }
}
module.exports = {
  normalizeRailgunRelayPrePoiBinding,
  normalizeRailgunRelayPrePoiPayload,
  bindRailgunRelayPrePoiPayload,
  RAILGUN_RELAY_PRE_POI_MAX_BINDING_BYTES,
  RAILGUN_RELAY_PRE_POI_MAX_PAYLOAD_BYTES,
  RAILGUN_RELAY_PRE_POI_MAX_BOUND_BYTES,
};
