/** Main-process validation of the sole supported native shield call. No generic
 * RelayAdapt calls, zero/all-balance amounts, token approvals or batch shields.
 * Calldata validation is not deployment verification or submission authority.
 */
const { Interface, keccak256, AbiCoder } = require('ethers');
const pins = require('./railgun-shield-pins.json');
const SHIELD_ABI = Object.freeze([
  'function wrapBase(uint256 _amount)',
  'function shield(((bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage,(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext)[] _shieldRequests)',
  'function multicall(bool _requireSuccess,(address to,bytes data,uint256 value)[] _calls) payable',
]);
const abi = new Interface(SHIELD_ABI);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun native shield refused'), { code: 'RAILGUN_SHIELD_REFUSED' });
const check = (value) => {
  if (!value) throw fail();
};
function shieldAmount(value) {
  check(typeof value === 'string' && /^[1-9][0-9]{0,16}$/.test(value));
  const amount = BigInt(value);
  check(amount <= BigInt(pins.maxQualificationAmount));
  return amount;
}
function decode(name, data) {
  check(typeof data === 'string' && /^0x[0-9a-f]+$/.test(data) && data.length <= 8194);
  const values = abi.decodeFunctionData(name, data);
  check(abi.encodeFunctionData(name, values) === data);
  return values;
}
function validateRailgunNativeShield(transaction, expected) {
  try {
    check(
      expected &&
        Object.keys(expected).length === 2 &&
        Object.hasOwn(expected, 'amount') &&
        Object.hasOwn(expected, 'npk')
    );
    const amount = shieldAmount(expected.amount);
    check(
      typeof expected.npk === 'string' &&
        /^0x[0-9a-f]{64}$/.test(expected.npk) &&
        BigInt(expected.npk) > 0n &&
        BigInt(expected.npk) < FIELD
    );
    check(
      transaction &&
        !Array.isArray(transaction) &&
        Object.keys(transaction).length === 4 &&
        ['chainId', 'to', 'value', 'data'].every((k) => Object.hasOwn(transaction, k))
    );
    check(
      transaction.chainId === pins.chainId &&
        transaction.to === pins.relayAdapt &&
        transaction.value === expected.amount
    );
    const [required, calls] = decode('multicall', transaction.data);
    check(required === true && calls.length === 2);
    for (const call of calls) check(call.to.toLowerCase() === pins.relayAdapt && call.value === 0n);
    check(decode('wrapBase', calls[0].data)[0] === amount);
    const [requests] = decode('shield', calls[1].data);
    check(requests.length === 1);
    const { preimage, ciphertext } = requests[0];
    check(
      preimage.npk === expected.npk &&
        preimage.value === amount &&
        preimage.token.tokenType === 0n &&
        preimage.token.tokenAddress.toLowerCase() === pins.wrappedNative &&
        preimage.token.tokenSubID === 0n
    );
    check(
      ciphertext.encryptedBundle.every((v) => /^0x[0-9a-f]{64}$/.test(v)) &&
        /^0x[0-9a-f]{64}$/.test(ciphertext.shieldKey) &&
        BigInt(ciphertext.shieldKey) !== 0n
    );
    return Object.freeze({
      kind: 'railgun-native-shield',
      ...transaction,
      npk: expected.npk,
      token: pins.wrappedNative,
      shieldFeeBps: pins.shieldFeeBps,
      noteValue: (amount - (amount * BigInt(pins.shieldFeeBps)) / 10000n).toString(),
      digest: keccak256(
        AbiCoder.defaultAbiCoder().encode(
          ['string', 'uint256', 'address', 'uint256', 'bytes'],
          ['railgun-native-shield', pins.chainId, pins.relayAdapt, amount, transaction.data]
        )
      ),
    });
  } catch {
    throw fail();
  }
}
module.exports = { SHIELD_ABI, shieldAmount, validateRailgunNativeShield };
