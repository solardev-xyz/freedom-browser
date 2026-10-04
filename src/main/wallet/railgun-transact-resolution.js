/** Durable own-hash private outcome. It never releases the input reservation. */
const { validRailgunTransactIntent } = require('./railgun-transact-intent');
const pins = require('./railgun-shield-pins.json');
const receiptPolicy = require('./railgun-transact-receipt-policy');
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const quantity = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v);
const index = (v) => quantity(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const amount = (v) => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,16})$/.test(v);
const exact = (v, keys) =>
  v &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
function validRailgunTransactResolution(value, record) {
  try {
    const o = record.observation,
      i = record.intent;
    const partial = i?.operation === 'railgun-partial-unshield';
    if (
      !validRailgunTransactIntent(i) ||
      !['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
        i.operation
      ) ||
      (partial && (i.version !== 2 || receiptPolicy.chainId !== pins.chainId)) ||
      !hash(record.hash) ||
      !o ||
      !integer(o.blockNumber) ||
      !hash(o.blockHash) ||
      !exact(value, ['outcome', 'finalizedBlockNumber', 'finalizedBlockHash', 'transact']) ||
      !integer(value.finalizedBlockNumber) ||
      !hash(value.finalizedBlockHash) ||
      value.finalizedBlockNumber < o.blockNumber ||
      (value.finalizedBlockNumber === o.blockNumber && value.finalizedBlockHash !== o.blockHash)
    )
      return false;
    if (value.outcome === 'reverted') return o.status === 'reverted' && value.transact === null;
    const t = value.transact;
    if (
      value.outcome !== 'matched' ||
      o.status !== 'included' ||
      !exact(t, [
        ...(partial ? ['version', 'receiptPolicy'] : []),
        'status',
        'transactionHash',
        'blockHash',
        'blockNumber',
        'operation',
        'inputTree',
        'nullifier',
        ...(partial ? ['changeCommitment', 'unshieldCommitment'] : ['commitment']),
        'boundParamsHash',
        'intentDigest',
        'nullifiedLogIndex',
        'output',
        'trust',
        'spendingEnabled',
      ]) ||
      t.status !== 'matched' ||
      (partial && (t.version !== 2 || t.receiptPolicy !== receiptPolicy.id)) ||
      t.transactionHash !== record.hash ||
      t.blockHash !== o.blockHash ||
      !index(t.blockNumber) ||
      BigInt(t.blockNumber) !== BigInt(o.blockNumber) ||
      t.operation !== i.operation ||
      t.inputTree !== i.tree ||
      t.nullifier !== i.nullifier ||
      (partial
        ? t.changeCommitment !== i.changeCommitment || t.unshieldCommitment !== i.unshieldCommitment
        : t.commitment !== i.commitment) ||
      t.boundParamsHash !== i.boundParamsHash ||
      t.intentDigest !== i.intentDigest ||
      !index(t.nullifiedLogIndex) ||
      t.trust !== 'unverified-rpc' ||
      t.spendingEnabled !== false
    )
      return false;
    const out = t.output;
    if (partial) {
      if (!exact(out, ['kind', 'change', 'unshield']) || out.kind !== 'partial-unshield')
        return false;
      const c = out.change,
        u = out.unshield;
      if (
        !exact(c, ['kind', 'tree', 'position', 'logIndex']) ||
        c.kind !== 'shielded' ||
        !integer(c.tree) ||
        c.tree >= 65536 ||
        !integer(c.position) ||
        c.position >= 65536 ||
        !exact(u, [
          'kind',
          'logIndex',
          'recipient',
          'token',
          'unshieldAmount',
          'received',
          'fee',
          'feeDeviation',
          'treasury',
          'recipientTransferLogIndex',
          'treasuryTransferLogIndex',
        ]) ||
        u.kind !== 'unshield' ||
        u.recipient !== i.recipient ||
        u.token !== pins.wrappedNative ||
        u.treasury !== receiptPolicy.treasury ||
        u.unshieldAmount !== i.unshieldAmount ||
        !amount(u.received) ||
        BigInt(u.received) <= 0n ||
        !amount(u.fee) ||
        BigInt(u.received) + BigInt(u.fee) !== BigInt(i.unshieldAmount) ||
        u.feeDeviation !== (BigInt(u.fee) !== (BigInt(i.unshieldAmount) * 25n) / 10000n)
      )
        return false;
      const indices = [
        t.nullifiedLogIndex,
        u.recipientTransferLogIndex,
        u.treasuryTransferLogIndex,
        u.logIndex,
        c.logIndex,
      ];
      return (
        indices.every(index) &&
        indices.every((v, n) => n === 0 || BigInt(v) > BigInt(indices[n - 1]))
      );
    }
    if (!index(out?.logIndex) || BigInt(out.logIndex) <= BigInt(t.nullifiedLogIndex)) return false;
    if (i.operation === 'railgun-private-transfer')
      return (
        exact(out, ['kind', 'tree', 'position', 'logIndex']) &&
        out.kind === 'shielded' &&
        integer(out.tree) &&
        out.tree < 65536 &&
        integer(out.position) &&
        out.position < 65536
      );
    return (
      exact(out, [
        'kind',
        'logIndex',
        'recipient',
        'token',
        'amount',
        'received',
        'fee',
        'feeDeviation',
      ]) &&
      out.kind === 'unshield' &&
      out.recipient === i.recipient &&
      out.token === pins.wrappedNative &&
      out.amount === i.amount &&
      amount(out.received) &&
      BigInt(out.received) > 0n &&
      amount(out.fee) &&
      BigInt(out.received) + BigInt(out.fee) === BigInt(i.amount) &&
      out.feeDeviation === (BigInt(out.fee) !== (BigInt(i.amount) * 25n) / 10000n)
    );
  } catch {
    return false;
  }
}
function freezeRailgunTransactResolution(value) {
  if (value.transact) {
    if (value.transact.version === 2) {
      Object.freeze(value.transact.output.change);
      Object.freeze(value.transact.output.unshield);
    }
    Object.freeze(value.transact.output);
    Object.freeze(value.transact);
  }
  return Object.freeze(value);
}
module.exports = { validRailgunTransactResolution, freezeRailgunTransactResolution };
