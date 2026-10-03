/** Calldata-only private journal classification. No proof/ownership authority.
 * The zero-proof digest joins this public transaction to the private capsule;
 * no caller-supplied hold ID or capsule metadata enters the EOA journal.
 * Railgun's Poseidon TXID is deliberately not computed in the main process.
 */
const { AbiCoder, Interface, keccak256 } = require('ethers');
const {
  TRANSACT_ABI,
  BOUND_PARAMS,
  validateRailgunPrivateTransaction,
} = require('./railgun-private-policy');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const abi = new Interface([TRANSACT_ABI]),
  coder = AbiCoder.defaultAbiCoder();
const hex = (v) => '0x' + v.toString(16).padStart(64, '0');
const field = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) < FIELD;
const digest = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const fail = () =>
  Object.assign(new Error('Railgun transact intent unavailable'), {
    code: 'RAILGUN_TRANSACT_INTENT_REFUSED',
  });
function extractRailgunTransactIntent(tx) {
  try {
    if (typeof tx.data !== 'string' || tx.data.length > 8194) throw fail();
    const transaction = Object.freeze({
      chainId: Number(tx.chainId),
      to: tx.to.toLowerCase(),
      value: BigInt(tx.value).toString(),
      data: tx.data.toLowerCase(),
    });
    const [transactions] = abi.decodeFunctionData('transact', transaction.data);
    if (transactions.length !== 1) throw fail();
    const t = transactions[0],
      bound = t.boundParams;
    if (
      ![0n, 1n].includes(bound.unshield) ||
      t.nullifiers.length !== 1 ||
      t.commitments.length !== 1
    )
      throw fail();
    const unshield = bound.unshield === 1n;
    if (
      unshield &&
      (BigInt(t.unshieldPreimage.npk) === 0n || BigInt(t.unshieldPreimage.npk) >= 1n << 160n)
    )
      throw fail();
    const expected = Object.freeze({
      kind: unshield ? 'railgun-token-unshield' : 'railgun-private-transfer',
      tree: Number(bound.treeNumber),
      merkleRoot: t.merkleRoot,
      nullifier: t.nullifiers[0],
      commitment: t.commitments[0],
      boundParamsHash: hex(BigInt(keccak256(coder.encode([BOUND_PARAMS], [bound]))) % FIELD),
      ...(unshield
        ? {
            recipient: '0x' + BigInt(t.unshieldPreimage.npk).toString(16).padStart(40, '0'),
            amount: t.unshieldPreimage.value.toString(),
          }
        : {}),
    });
    validateRailgunPrivateTransaction(transaction, expected);
    const zeroProof = [
      [0, 0],
      [
        [0, 0],
        [0, 0],
      ],
      [0, 0],
    ];
    const intent = Object.freeze({
      ...transaction,
      data: abi.encodeFunctionData('transact', [
        [[zeroProof, t.merkleRoot, t.nullifiers, t.commitments, bound, t.unshieldPreimage]],
      ]),
    });
    const checked = validateRailgunPrivateSigningIntent(intent, expected);
    return Object.freeze({ transaction, intent, expected, intentDigest: checked.digest });
  } catch {
    throw fail();
  }
}
function railgunTransactIntentBinding(tx) {
  const { expected, intentDigest } = extractRailgunTransactIntent(tx);
  const { kind, ...fields } = expected;
  return Object.freeze({ operation: kind, ...fields, intentDigest });
}
function railgunTransactJournalIntent(tx) {
  try {
    return Object.freeze({
      kind: 'railgun-transact',
      ...railgunTransactIntentBinding(tx),
      digest: keccak256(
        coder.encode(
          ['string', 'uint256', 'address', 'address', 'uint256', 'bytes'],
          ['railgun-transact', tx.chainId, tx.from, tx.to, tx.value, tx.data]
        )
      ),
    });
  } catch {
    throw fail();
  }
}
function validRailgunTransactIntent(value) {
  try {
    const unshield = value?.operation === 'railgun-token-unshield';
    const keys = [
      'kind',
      'digest',
      'operation',
      'tree',
      'merkleRoot',
      'nullifier',
      'commitment',
      'boundParamsHash',
      'intentDigest',
      ...(unshield ? ['recipient', 'amount'] : []),
    ];
    if (
      !value ||
      Array.isArray(value) ||
      value.kind !== 'railgun-transact' ||
      (!unshield && value.operation !== 'railgun-private-transfer') ||
      Object.keys(value).length !== keys.length ||
      !keys.every((k) => Object.hasOwn(value, k)) ||
      !digest(value.digest) ||
      !digest(value.intentDigest) ||
      !Number.isSafeInteger(value.tree) ||
      value.tree < 0 ||
      value.tree > 65535 ||
      !['merkleRoot', 'nullifier', 'commitment', 'boundParamsHash'].every((k) => field(value[k]))
    )
      return false;
    return (
      !unshield ||
      (typeof value.recipient === 'string' &&
        /^0x[0-9a-f]{40}$/.test(value.recipient) &&
        BigInt(value.recipient) > 0n &&
        typeof value.amount === 'string' &&
        /^[1-9][0-9]{0,16}$/.test(value.amount) &&
        BigInt(value.amount) <= BigInt(pins.maxQualificationAmount))
    );
  } catch {
    return false;
  }
}
module.exports = {
  extractRailgunTransactIntent,
  railgunTransactIntentBinding,
  railgunTransactJournalIntent,
  validRailgunTransactIntent,
};
