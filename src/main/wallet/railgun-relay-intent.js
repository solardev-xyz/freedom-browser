/** Internal unsigned relay data only. No identity, ciphertext, signature, proof,
 * ownership, review, reservation or spending authority is authenticated here. */
const { AbiCoder, Interface, keccak256 } = require('ethers');
const { createHash } = require('crypto');
const {
  shape,
  freeze,
  decimal,
  normalizeRailgunRelayQuote,
} = require('./railgun-relay-quote-data');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO = '0x' + '0'.repeat(40),
  ZERO32 = '0x' + '0'.repeat(64);
const abi = new Interface([TRANSACT_ABI]),
  coder = AbiCoder.defaultAbiCoder();
const fail = () =>
  Object.assign(new Error('Railgun unsigned relay data refused'), {
    code: 'RAILGUN_RELAY_UNSIGNED_DATA_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
const field = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) < FIELD;
const hash = (v) => createHash('sha256').update(v).digest('hex');
function identity(value) {
  shape(value, ['address', 'masterPublicKey', 'viewingPublicKey']);
  check(
    typeof value.address === 'string' &&
      /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/.test(value.address)
  );
  check(decimal(value.masterPublicKey, FIELD - 1n) > 0n);
  check(
    typeof value.viewingPublicKey === 'string' &&
      /^[0-9a-f]{64}$/.test(value.viewingPublicKey) &&
      !/^0+$/.test(value.viewingPublicKey)
  );
  return {
    address: value.address,
    masterPublicKey: value.masterPublicKey,
    viewingPublicKey: value.viewingPublicKey,
  };
}
// Detached structural context only; callers must authenticate identities and
// obtain fresh owner/quote authority separately before any later operation.
function normalizeRailgunRelayUnsignedContext(value) {
  try {
    shape(value, [
      'walletId',
      'self',
      'peer',
      'quote',
      'gas',
      'inputAmount',
      'feeAmount',
      'selfAmount',
      'feeCap',
    ]);
    const c = value;
    check(typeof c.walletId === 'string' && /^[0-9a-f]{64}$/.test(c.walletId));
    const self = identity(c.self),
      peer = identity(c.peer);
    const binding = normalizeRailgunRelayQuote(c.quote, c.gas);
    check(peer.address === binding.fields.railgunAddress);
    const amounts = {};
    for (const k of ['inputAmount', 'feeAmount', 'selfAmount', 'feeCap']) {
      check(decimal(c[k], BigInt(pins.maxQualificationAmount)) > 0n);
      amounts[k] = c[k];
    }
    check(c.feeAmount === binding.feeAmount);
    check(BigInt(c.feeAmount) <= BigInt(c.feeCap));
    check(BigInt(c.feeAmount) + BigInt(c.selfAmount) === BigInt(c.inputAmount));
    return freeze({
      walletId: c.walletId,
      self,
      peer,
      quote: { ...binding.quote },
      gas: { ...binding.gas },
      ...amounts,
    });
  } catch {
    throw fail();
  }
}
function normalizeRailgunRelayUnsignedIntent(value) {
  try {
    shape(value, ['transaction', 'expected', 'expectedHash', 'context']);
    shape(value.transaction, ['chainId', 'to', 'value', 'data']);
    shape(value.expected, [
      'kind',
      'tree',
      'merkleRoot',
      'nullifier',
      'feeCommitment',
      'selfCommitment',
      'boundParamsHash',
    ]);
    const t = value.transaction,
      e = value.expected;
    const c = normalizeRailgunRelayUnsignedContext(value.context);
    check(e.kind === 'railgun-relay-self-transfer');
    check(Number.isSafeInteger(e.tree) && e.tree >= 0 && e.tree <= 65535);
    check(
      ['merkleRoot', 'nullifier', 'feeCommitment', 'selfCommitment', 'boundParamsHash'].every((k) =>
        field(e[k])
      ) && field(value.expectedHash)
    );
    check(e.feeCommitment !== e.selfCommitment);
    check(t.chainId === pins.chainId && t.to === pins.proxy && t.value === '0');
    check(
      typeof t.data === 'string' &&
        /^0x(?:[0-9a-f]{2})+$/.test(t.data) &&
        t.data.length <= 2 + 8192 * 2
    );
    const [transactions] = abi.decodeFunctionData('transact', t.data);
    check(
      transactions.length === 1 && abi.encodeFunctionData('transact', [transactions]) === t.data
    );
    const tx = transactions[0],
      b = tx.boundParams,
      p = tx.proof;
    check([p.a.x, p.a.y, ...p.b.x, ...p.b.y, p.c.x, p.c.y].every((v) => v === 0n));
    check(
      tx.merkleRoot === e.merkleRoot &&
        tx.nullifiers.length === 1 &&
        tx.nullifiers[0] === e.nullifier
    );
    check(
      tx.commitments.length === 2 &&
        tx.commitments[0] === e.feeCommitment &&
        tx.commitments[1] === e.selfCommitment
    );
    check(
      b.treeNumber === BigInt(e.tree) &&
        b.minGasPrice === BigInt(c.gas.minGasPrice) &&
        b.minGasPrice < 1n << 48n
    );
    check(
      b.unshield === 0n &&
        b.chainID === BigInt(pins.chainId) &&
        b.adaptContract.toLowerCase() === ZERO &&
        b.adaptParams === ZERO32
    );
    check(b.commitmentCiphertext.length === 2);
    for (const cipher of b.commitmentCiphertext) {
      check(
        cipher.blindedSenderViewingKey !== ZERO32 && cipher.blindedReceiverViewingKey !== ZERO32
      );
      check(/^0x(?:[0-9a-f]{2}){1,256}$/.test(cipher.annotationData));
      check(cipher.memo === '0x');
    }
    check(
      BigInt(keccak256(coder.encode([BOUND_PARAMS], [b]))) % FIELD === BigInt(e.boundParamsHash)
    );
    const unshield = tx.unshieldPreimage;
    check(
      unshield.npk === ZERO32 &&
        unshield.token.tokenType === 0n &&
        unshield.token.tokenAddress.toLowerCase() === ZERO &&
        unshield.token.tokenSubID === 0n &&
        unshield.value === 0n
    );
    const data = freeze({
      transaction: { chainId: t.chainId, to: t.to, value: t.value, data: t.data },
      expected: {
        kind: e.kind,
        tree: e.tree,
        merkleRoot: e.merkleRoot,
        nullifier: e.nullifier,
        feeCommitment: e.feeCommitment,
        selfCommitment: e.selfCommitment,
        boundParamsHash: e.boundParamsHash,
      },
      expectedHash: value.expectedHash,
      context: c,
    });
    return freeze({
      data,
      digest: hash('freedom:railgun:relay-unsigned-intent-draft-v1\0' + JSON.stringify(data)),
      reviewedPreparation: false,
      identityAuthenticated: false,
      ownershipAuthenticated: false,
      recipientsVerified: false,
      expectedHashVerified: false,
      signatureVerified: false,
      proofVerified: false,
      reservationsChecked: false,
      capsulePersisted: false,
      signingEnabled: false,
      poiQueriesPermitted: false,
      relaySendPermitted: false,
    });
  } catch {
    throw fail();
  }
}
module.exports = { normalizeRailgunRelayUnsignedContext, normalizeRailgunRelayUnsignedIntent };
