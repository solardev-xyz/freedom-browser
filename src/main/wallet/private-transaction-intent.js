/** Non-secret correlation metadata, stored only inside the encrypted journal. */
const { AbiCoder, keccak256 } = require('ethers');
const { privacyError } = require('../networks/privacy-context');
const kinds = ['ppv2-register-auth', 'ppv2-register-viewing', 'ppv2-native-deposit'];
function validIntent(value) {
  return value && Object.keys(value).length === 2 && kinds.includes(value.kind) &&
    typeof value.digest === 'string' && /^0x[0-9a-f]{64}$/.test(value.digest);
}
function transactionIntent(kind, tx) {
  if (!kinds.includes(kind)) throw privacyError('PRIVATE_INTENT_INVALID', 'Unsupported transaction intent');
  try {
    return Object.freeze({ kind, digest: keccak256(AbiCoder.defaultAbiCoder().encode(
      ['string', 'uint256', 'address', 'address', 'uint256', 'bytes'],
      [kind, tx.chainId, tx.from, tx.to, tx.value, tx.data])) });
  } catch { throw privacyError('PRIVATE_INTENT_INVALID', 'Invalid transaction intent'); }
}
module.exports = { validIntent, transactionIntent };
