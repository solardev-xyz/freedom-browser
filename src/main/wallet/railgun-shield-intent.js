/** Calldata-derived journal metadata. This is classification, not permission to
 * sign: only the enrolled operation can bind recipient recovery and preflight.
 */
const { Interface } = require('ethers');
const {
  SHIELD_ABI,
  validateRailgunNativeShield,
  shieldAmount,
} = require('./railgun-shield-policy');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface(SHIELD_ABI);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const isRailgunTarget = (to) =>
  typeof to === 'string' &&
  [pins.proxy, pins.implementation, pins.relayAdapt].includes(to.toLowerCase());
function shieldIntentBinding(tx) {
  if (typeof tx.data !== 'string' || tx.data.length > 8194) throw Error('Invalid shield intent');
  const [, calls] = abi.decodeFunctionData('multicall', tx.data);
  if (calls.length !== 2) throw Error('Invalid shield intent');
  const [notes] = abi.decodeFunctionData('shield', calls[1].data);
  if (notes.length !== 1) throw Error('Invalid shield intent');
  const amount = BigInt(tx.value).toString();
  const checked = validateRailgunNativeShield(
    {
      chainId: Number(tx.chainId),
      to: tx.to.toLowerCase(),
      value: amount,
      data: tx.data.toLowerCase(),
    },
    { amount, npk: notes[0].preimage.npk.toLowerCase() }
  );
  return { npk: checked.npk, token: checked.token, amount, noteValue: checked.noteValue };
}
function validShieldIntent(value) {
  try {
    return (
      value &&
      Object.keys(value).length === 6 &&
      value.kind === 'railgun-native-shield' &&
      /^0x[0-9a-f]{64}$/.test(value.digest) &&
      typeof value.npk === 'string' &&
      /^0x[0-9a-f]{64}$/.test(value.npk) &&
      BigInt(value.npk) > 0n &&
      BigInt(value.npk) < FIELD &&
      value.token === pins.wrappedNative &&
      shieldAmount(value.amount) > 0n &&
      typeof value.noteValue === 'string' &&
      /^[1-9][0-9]{0,16}$/.test(value.noteValue) &&
      BigInt(value.noteValue) <= BigInt(value.amount)
    );
  } catch {
    return false;
  }
}
module.exports = { shieldIntentBinding, validShieldIntent, isRailgunTarget };
