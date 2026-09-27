/** Reviewed fe0244e3 native emergency-exit circuit boundary. */
const { FIELD } = require('./ppv2-deposit-policy');
const RAGEQUIT_ABI = 'function ragequit((uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256[7] pubSignals) _proof)';
const ARTIFACTS = Object.freeze([
  Object.freeze({ kind: 'wasm', name: 'ragequit.wasm', size: 3085620, sha256: '95108046f922d9cb08a1d4e42c88708af03233551a5e13a7118d7a6eff5d31c4' }),
  Object.freeze({ kind: 'provingKey', name: 'ragequit.zkey', size: 5932748, sha256: '3b0d2c3fdf26363be409dc4f01f5beb1c3cbc3b07a0c1ddb9e825e22e46d9bf4' }),
  Object.freeze({ kind: 'verificationKey', name: 'ragequit.vkey.json', size: 4329, sha256: 'd285bf7a8f2e38d206c5513771d80816969c75b87558df194c1804ed1ec484d7' }),
]);
const hex = (value, limit) => typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value) && BigInt(value) < limit;
function validWitness(value) {
  const scalars = { keystoreRoot: FIELD, ownerAddress: 1n << 160n, value: 1n << 128n, tokenId: 1n << 160n,
    label: FIELD, noteSecret: 1n << 256n, metadata: 1n, privateNullifyingKey: 1n << 256n,
    privateRevocableKey: 1n << 256n, keystoreLeafIndex: 1n << 18n, keystoreTreeDepth: 19n };
  return value && Object.keys(value).length === 12 && Object.entries(scalars).every(([name, limit]) => hex(value[name], limit)) &&
    Array.isArray(value.keystoreSiblings) && value.keystoreSiblings.length === 18 && value.keystoreSiblings.every((v) => hex(v, FIELD));
}
module.exports = { ARTIFACTS, RAGEQUIT_ABI, validWitness };
