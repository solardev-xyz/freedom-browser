/** Bounded public proof payload only. These fields can correlate private notes
 * and must stay in private main/utility state until disclosure is authorized.
 * Normalization is neither proof verification nor disclosure authority.
 */
const assert = require('assert/strict');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const shape = (v, keys) => assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
const field = (v) => {
  assert.equal(typeof v, 'string');
  assert.match(v, /^0x[0-9a-f]{64}$/);
  assert.ok(BigInt(v) < FIELD);
  return v;
};
const bareField = (v) => {
  assert.equal(typeof v, 'string');
  assert.match(v, /^[0-9a-f]{64}$/);
  field('0x' + v);
  return v;
};
const point = (v) => {
  assert.equal(typeof v, 'string');
  assert.match(v, /^(?:0|[1-9][0-9]{0,76})$/);
  assert.ok(BigInt(v) < BASE);
  return v;
};
const pair = (v, item) => {
  assert.ok(Array.isArray(v) && v.length === 2);
  return Object.freeze(v.map(item));
};
function normalizeRailgunPoiPayload(value) {
  try {
    const text = JSON.stringify(value);
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 16384);
    const v = JSON.parse(text);
    shape(v, [
      'listKey',
      'proof',
      'poiMerkleroots',
      'txidMerkleroot',
      'txidMerklerootIndex',
      'blindedCommitmentsOut',
      'railgunTxidIfHasUnshield',
    ]);
    assert.equal(v.listKey, REQUIRED_LIST);
    shape(v.proof, ['pi_a', 'pi_b', 'pi_c']);
    const proof = Object.freeze({
      pi_a: pair(v.proof.pi_a, point),
      pi_b: pair(v.proof.pi_b, (p) => pair(p, point)),
      pi_c: pair(v.proof.pi_c, point),
    });
    assert.ok(Array.isArray(v.poiMerkleroots) && v.poiMerkleroots.length === 1);
    assert.ok(
      Number.isSafeInteger(v.txidMerklerootIndex) &&
        v.txidMerklerootIndex >= 0 &&
        v.txidMerklerootIndex < 8000
    );
    assert.ok(Array.isArray(v.blindedCommitmentsOut) && v.blindedCommitmentsOut.length <= 1);
    const outputs = Object.freeze(v.blindedCommitmentsOut.map(field));
    const marker =
      v.railgunTxidIfHasUnshield === '0x00' ? '0x00' : field(v.railgunTxidIfHasUnshield);
    if (BigInt(marker) === 0n) assert.equal(marker, '0x00');
    // Transfer, full unshield, or one change output plus an unshield marker.
    if (BigInt(marker) === 0n) assert.equal(outputs.length, 1);
    if (outputs.length) assert.ok(BigInt(outputs[0]) > 0n);
    return Object.freeze({
      listKey: REQUIRED_LIST,
      proof,
      poiMerkleroots: Object.freeze(v.poiMerkleroots.map(bareField)),
      txidMerkleroot: bareField(v.txidMerkleroot),
      txidMerklerootIndex: v.txidMerklerootIndex,
      blindedCommitmentsOut: outputs,
      railgunTxidIfHasUnshield: marker,
    });
  } catch {
    throw Object.assign(new Error('Railgun POI payload unavailable'), {
      code: 'RAILGUN_POI_PAYLOAD_REFUSED',
    });
  }
}
module.exports = { normalizeRailgunPoiPayload };
