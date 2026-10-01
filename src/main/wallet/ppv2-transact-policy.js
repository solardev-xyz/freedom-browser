/** Pinned single-asset 1x1 withdrawal witness. No other transact shape is granted. */
const { FIELD } = require('./ppv2-deposit-policy');
const ARTIFACTS = Object.freeze(
  [
    {
      kind: 'wasm',
      name: 'transact_1x1.wasm',
      size: 3239462,
      sha256: 'bd13ab4130320f095cdee83b42e27877fc6c17f18be3fbdfc55436d33689d262',
    },
    {
      kind: 'provingKey',
      name: 'transact_1x1.zkey',
      size: 17942432,
      sha256: 'ba00dc63d1ef0b09a49dbf9348430362ef18dca5309ad5b6f06a896349c4c80a',
    },
    {
      kind: 'verificationKey',
      name: 'transact_1x1.vkey.json',
      size: 4531,
      sha256: 'e429d3e895de5cc9d2839a3fd8303fadd30be3759bac06ce7fb063ceda198308',
    },
  ].map(Object.freeze)
);
const hex = (v, max) => typeof v === 'string' && /^0x[0-9a-f]{1,64}$/i.test(v) && BigInt(v) < max;
const scalars = {
  stateRoot: FIELD,
  keystoreRoot: FIELD,
  associationSetRoot: FIELD,
  amountOut: 1n << 128n,
  tokenIdOut: 1n << 160n,
  context: 1n << 256n,
  ownerAddress: 1n << 160n,
  privateNullifyingKey: 1n << 256n,
  privateRevocableKey: 1n << 256n,
  keystoreLeafIndex: 1n << 18n,
  keystoreTreeDepth: 19n,
  tokenId: 1n << 160n,
};
const vectors = {
  noteSecret: 1n << 256n,
  value: 1n << 128n,
  label: FIELD,
  stateLeafIndex: 1n << 22n,
  stateTreeDepth: 23n,
  associationSetLeafIndex: 1n << 18n,
  associationSetTreeDepth: 19n,
  timestamp: 1n << 64n,
  outputNoteAddressHash: FIELD,
  outputValue: 1n << 128n,
  outputLabel: FIELD,
};
function validWitness(v) {
  const vector = (a, n, max) => Array.isArray(a) && a.length === n && a.every((x) => hex(x, max));
  return (
    v &&
    Object.keys(v).length === 26 &&
    Object.entries(scalars).every(([k, max]) => hex(v[k], max)) &&
    Object.entries(vectors).every(([k, max]) => vector(v[k], 1, max)) &&
    vector(v.keystoreSiblings, 18, FIELD) &&
    Array.isArray(v.stateSiblings) &&
    v.stateSiblings.length === 1 &&
    vector(v.stateSiblings[0], 22, FIELD) &&
    Array.isArray(v.associationSetSiblings) &&
    v.associationSetSiblings.length === 1 &&
    vector(v.associationSetSiblings[0], 18, FIELD) &&
    BigInt(v.tokenId) > 0n &&
    BigInt(v.tokenIdOut) === BigInt(v.tokenId) &&
    BigInt(v.value[0]) === BigInt(v.amountOut) + BigInt(v.outputValue[0]) &&
    BigInt(v.outputValue[0]) > 0n &&
    BigInt(v.outputLabel[0]) === BigInt(v.label[0])
  );
}
module.exports = { ARTIFACTS, validWitness };
