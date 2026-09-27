/** Reviewed fe0244e3 deposit circuit and ABI boundary. No SDK dependency. */
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const DEPOSIT_ABI = 'function deposit((uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256[4] pubSignals) _proof,(bytes32 hint,bytes data) _noteData,bytes _aspCiphertext) payable';
const ARTIFACTS = Object.freeze([
  Object.freeze({ kind: 'wasm', name: 'deposit.wasm', size: 2337270, sha256: '833e7b3c44a900a95496009a36284e11f57ba0385fab6b63f92075750817550a' }),
  Object.freeze({ kind: 'provingKey', name: 'deposit.zkey', size: 1031707, sha256: '0e64b6d15ea540b3ab04d5596ab45d1ed6df0872e0261a850039372104837b30' }),
  Object.freeze({ kind: 'verificationKey', name: 'deposit.vkey.json', size: 3744, sha256: 'cc0c1647983f2ca75b192e5c671b9b2932fd690709922bf32443a4053cd0912a' }),
]);
const hex = (value, limit) => typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value) && BigInt(value) < limit;
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
function validWitness(value) {
  return keys(value, ['tokenId', 'value', 'context', 'noteAddressHash', 'depositSecret']) &&
    hex(value.tokenId, 1n << 160n) && hex(value.value, 1n << 128n) &&
    hex(value.context, 1n << 256n) && hex(value.noteAddressHash, FIELD) && hex(value.depositSecret, FIELD);
}
function validProof(value) {
  if (!keys(value, ['proof', 'publicSignals']) || !keys(value.proof, ['pi_a', 'pi_b', 'pi_c', 'protocol', 'curve'])) return false;
  const { proof, publicSignals } = value;
  const vector = (row, length) => Array.isArray(row) && row.length === length && row.every((item) => hex(item, BASE_FIELD));
  return proof.protocol === 'groth16' && proof.curve === 'bn128' && vector(proof.pi_a, 3) && vector(proof.pi_c, 3) &&
    BigInt(proof.pi_a[2]) === 1n && BigInt(proof.pi_c[2]) === 1n && Array.isArray(proof.pi_b) && proof.pi_b.length === 3 &&
    proof.pi_b.every((row) => vector(row, 2)) && BigInt(proof.pi_b[2][0]) === 1n && BigInt(proof.pi_b[2][1]) === 0n &&
    Array.isArray(publicSignals) && publicSignals.length === 4 && publicSignals.every((item) => hex(item, FIELD));
}
function formatProof({ proof, publicSignals }) {
  return { pA: proof.pi_a.slice(0, 2).map(BigInt), pB: proof.pi_b.slice(0, 2).map((row) => [BigInt(row[1]), BigInt(row[0])]),
    pC: proof.pi_c.slice(0, 2).map(BigInt), pubSignals: publicSignals.map(BigInt) };
}
module.exports = { FIELD, NATIVE, DEPOSIT_ABI, ARTIFACTS, validWitness, validProof, formatProof };
