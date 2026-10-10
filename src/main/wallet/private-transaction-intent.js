/** Non-secret correlation metadata, stored only inside the encrypted journal. */
const { AbiCoder, Interface, keccak256 } = require('ethers');
const { privacyError } = require('../networks/privacy-context');
const { RAGEQUIT_ABI } = require('./ppv2-ragequit-policy');
const { FIELD, NATIVE } = require('./ppv2-deposit-policy');
const {
  railgunTransactJournalIntent,
  validRailgunTransactIntent,
} = require('@freedom/railgun-kohaku-adapter/host/journal-data');
const {
  shieldIntentBinding,
  validShieldIntent,
  isRailgunTarget,
} = require('@freedom/railgun-kohaku-adapter/host/journal-data');
const exitABI = new Interface([RAGEQUIT_ABI]);
const isExitIntent = (value) =>
  ['ppv2-native-ragequit', 'ppv2-token-ragequit'].includes(value?.kind);
const kinds = [
  'railgun-native-shield',
  'railgun-transact',
  'ppv2-register-auth',
  'ppv2-register-viewing',
  'ppv2-native-deposit',
  'ppv2-native-ragequit',
  'ppv2-token-approval',
  'ppv2-token-deposit',
  'ppv2-token-ragequit',
];
function validIntent(value) {
  if (value?.kind === 'railgun-transact') return validRailgunTransactIntent(value);
  if (value?.kind === 'railgun-native-shield') return validShieldIntent(value);
  return (
    value &&
    [2, 4].includes(Object.keys(value).length) &&
    kinds.includes(value.kind) &&
    (Object.keys(value).length === 2 ||
      (isExitIntent(value) &&
        typeof value.pool === 'string' &&
        /^0x[0-9a-f]{40}$/.test(value.pool) &&
        BigInt(value.pool) > 0n &&
        typeof value.commitment === 'string' &&
        /^0x[0-9a-f]{64}$/.test(value.commitment) &&
        BigInt(value.commitment) < FIELD)) &&
    typeof value.digest === 'string' &&
    /^0x[0-9a-f]{64}$/.test(value.digest)
  );
}
function transactionIntent(kind, tx) {
  if (!kinds.includes(kind))
    throw privacyError('PRIVATE_INTENT_INVALID', 'Unsupported transaction intent');
  try {
    if (kind === 'railgun-transact') return railgunTransactJournalIntent(tx);
    if (isRailgunTarget(tx.to) && kind !== 'railgun-native-shield')
      throw new Error('Mislabeled shield');
    if (
      typeof tx.data === 'string' &&
      tx.data.slice(0, 10).toLowerCase() === exitABI.getFunction('ragequit').selector &&
      !isExitIntent({ kind })
    ) {
      throw new Error('Mislabeled exit');
    }
    let binding = kind === 'railgun-native-shield' ? shieldIntentBinding(tx) : {};
    if (isExitIntent({ kind })) {
      const proof = exitABI.decodeFunctionData('ragequit', tx.data)[0];
      const signals = proof.pubSignals;
      if (
        exitABI.encodeFunctionData('ragequit', [proof]).toLowerCase() !== tx.data.toLowerCase() ||
        BigInt(tx.chainId) !== 11155111n ||
        BigInt(tx.value) !== 0n ||
        BigInt(tx.to) === 0n ||
        signals.some((v) => v >= FIELD) ||
        signals[3] !== BigInt(tx.from) ||
        signals[4] <= 0n ||
        signals[4] >= 1n << 128n ||
        signals[5] === 0n ||
        signals[5] >= 1n << 160n ||
        (kind === 'ppv2-native-ragequit') !== (signals[5] === BigInt(NATIVE))
      )
        throw new Error('Invalid exit');
      binding = {
        pool: tx.to.toLowerCase(),
        commitment: `0x${signals[1].toString(16).padStart(64, '0')}`,
      };
    }
    return Object.freeze({
      kind,
      ...binding,
      digest: keccak256(
        AbiCoder.defaultAbiCoder().encode(
          ['string', 'uint256', 'address', 'address', 'uint256', 'bytes'],
          [kind, tx.chainId, tx.from, tx.to, tx.value, tx.data]
        )
      ),
    });
  } catch {
    throw privacyError('PRIVATE_INTENT_INVALID', 'Invalid transaction intent');
  }
}
module.exports = { validIntent, transactionIntent, isExitIntent };
