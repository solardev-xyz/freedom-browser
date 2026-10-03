/** Narrow calldata policy for one-input, one-output Sepolia qualification.
 * Main repeats public intent and bound-parameter checks without the engine.
 * Passing this policy does not verify a proof, decrypt an output, reserve an
 * input or authorize signing. No generic adapter, batch or override calls.
 */
const { AbiCoder, Interface, keccak256 } = require('ethers');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO = '0x' + '0'.repeat(40),
  ZERO32 = '0x' + '0'.repeat(64);
const CIPHERTEXT =
  '(bytes32[4] ciphertext,bytes32 blindedSenderViewingKey,bytes32 blindedReceiverViewingKey,bytes annotationData,bytes memo)';
const BOUND_PARAMS = `(uint16 treeNumber,uint72 minGasPrice,uint8 unshield,uint64 chainID,address adaptContract,bytes32 adaptParams,${CIPHERTEXT}[] commitmentCiphertext)`;
const PROOF = '((uint256 x,uint256 y) a,(uint256[2] x,uint256[2] y) b,(uint256 x,uint256 y) c)';
const PREIMAGE =
  '(bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value)';
const TRANSACT_ABI = `function transact((${PROOF} proof,bytes32 merkleRoot,bytes32[] nullifiers,bytes32[] commitments,${BOUND_PARAMS} boundParams,${PREIMAGE} unshieldPreimage)[] _transactions) payable`;
const abi = new Interface([TRANSACT_ABI]),
  coder = AbiCoder.defaultAbiCoder();
const fail = () =>
  Object.assign(new Error('Railgun private transaction refused'), {
    code: 'RAILGUN_PRIVATE_TRANSACTION_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
const shape = (value, keys) =>
  value &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const field = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) < FIELD;
const bytes = (value, max) =>
  typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(value) && value.length <= 2 + 2 * max;
function validateRailgunPrivateTransaction(transaction, expected) {
  try {
    const unshield = expected?.kind === 'railgun-token-unshield';
    check(unshield || expected?.kind === 'railgun-private-transfer');
    const keys = ['kind', 'tree', 'merkleRoot', 'nullifier', 'commitment', 'boundParamsHash'];
    if (unshield) keys.push('recipient', 'amount');
    check(shape(expected, keys));
    check(Number.isInteger(expected.tree) && expected.tree >= 0 && expected.tree <= 65535);
    check(
      ['merkleRoot', 'nullifier', 'commitment', 'boundParamsHash'].every((key) =>
        field(expected[key])
      )
    );
    if (unshield)
      check(
        typeof expected.recipient === 'string' &&
          /^0x[0-9a-f]{40}$/.test(expected.recipient) &&
          expected.recipient !== ZERO &&
          typeof expected.amount === 'string' &&
          /^[1-9][0-9]{0,16}$/.test(expected.amount) &&
          BigInt(expected.amount) <= BigInt(pins.maxQualificationAmount)
      );
    check(shape(transaction, ['chainId', 'to', 'value', 'data']));
    check(
      transaction.chainId === pins.chainId &&
        transaction.to === pins.proxy &&
        transaction.value === '0'
    );
    check(bytes(transaction.data, 4096));
    const [transactions] = abi.decodeFunctionData('transact', transaction.data);
    check(
      transactions.length === 1 &&
        abi.encodeFunctionData('transact', [transactions]) === transaction.data
    );
    const tx = transactions[0],
      bound = tx.boundParams;
    check(
      tx.merkleRoot === expected.merkleRoot &&
        tx.nullifiers.length === 1 &&
        tx.nullifiers[0] === expected.nullifier &&
        tx.commitments.length === 1 &&
        tx.commitments[0] === expected.commitment &&
        bound.treeNumber === BigInt(expected.tree) &&
        bound.minGasPrice === 0n &&
        bound.unshield === (unshield ? 1n : 0n) &&
        bound.chainID === BigInt(pins.chainId) &&
        bound.adaptContract.toLowerCase() === ZERO &&
        bound.adaptParams === ZERO32 &&
        bound.commitmentCiphertext.length === (unshield ? 0 : 1)
    );
    for (const cipher of bound.commitmentCiphertext) {
      check(bytes(cipher.annotationData, 256) && bytes(cipher.memo, 256));
      check(
        cipher.blindedSenderViewingKey !== ZERO32 && cipher.blindedReceiverViewingKey !== ZERO32
      );
    }
    // SDK 9.6 hashes minGasPrice as uint48, while the contract's transact ABI
    // declares uint72. Our zero-only policy makes their encoded words identical;
    // the function selector must still use the deployed uint72 signature.
    const boundHash = BigInt(keccak256(coder.encode([BOUND_PARAMS], [bound]))) % FIELD;
    check(boundHash === BigInt(expected.boundParamsHash));
    const preimage = tx.unshieldPreimage;
    check(preimage.token.tokenType === 0n && preimage.token.tokenSubID === 0n);
    if (unshield)
      check(
        BigInt(preimage.npk) === BigInt(expected.recipient) &&
          preimage.token.tokenAddress.toLowerCase() === pins.wrappedNative &&
          preimage.value === BigInt(expected.amount)
      );
    else
      check(
        preimage.npk === ZERO32 &&
          preimage.token.tokenAddress.toLowerCase() === ZERO &&
          preimage.value === 0n
      );
    return Object.freeze({
      ...transaction,
      ...expected,
      digest: keccak256(
        coder.encode(
          ['string', 'uint256', 'address', 'uint256', 'bytes'],
          [expected.kind, pins.chainId, pins.proxy, 0n, transaction.data]
        )
      ),
      proofVerified: false,
      recipientVerified: false,
      reservationsChecked: false,
      spendingEnabled: false,
    });
  } catch {
    throw fail();
  }
}
module.exports = { TRANSACT_ABI, BOUND_PARAMS, validateRailgunPrivateTransaction };
