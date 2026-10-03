/** Bounded immutable signature data shared by the broker and result normalizers.
 * Shape validation grants neither signing authority nor cryptographic validity.
 */
const assert = require('assert/strict');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SUBGROUP = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const field = (value, limit = FIELD) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) < limit;
function normalizeRailgunSignature(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['R8', 'S']);
  assert.ok(Array.isArray(value.R8) && value.R8.length === 2 && value.R8.every((v) => field(v)));
  assert.ok(field(value.S, SUBGROUP));
  return Object.freeze({ R8: Object.freeze([...value.R8]), S: value.S });
}
module.exports = { normalizeRailgunSignature };
