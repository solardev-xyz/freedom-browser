/** Durable own-hash private outcome. It never releases the input reservation. */
const { validRailgunTransactIntent } = require('./railgun-transact-intent');
const pins = require('./railgun-shield-pins.json');
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
    if (
      !validRailgunTransactIntent(i) ||
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
        'status',
        'transactionHash',
        'blockHash',
        'blockNumber',
        'operation',
        'inputTree',
        'nullifier',
        'commitment',
        'boundParamsHash',
        'intentDigest',
        'nullifiedLogIndex',
        'output',
        'trust',
        'spendingEnabled',
      ]) ||
      t.status !== 'matched' ||
      t.transactionHash !== record.hash ||
      t.blockHash !== o.blockHash ||
      !index(t.blockNumber) ||
      BigInt(t.blockNumber) !== BigInt(o.blockNumber) ||
      t.operation !== i.operation ||
      t.inputTree !== i.tree ||
      t.nullifier !== i.nullifier ||
      t.commitment !== i.commitment ||
      t.boundParamsHash !== i.boundParamsHash ||
      t.intentDigest !== i.intentDigest ||
      !index(t.nullifiedLogIndex) ||
      t.trust !== 'unverified-rpc' ||
      t.spendingEnabled !== false
    )
      return false;
    const out = t.output;
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
    Object.freeze(value.transact.output);
    Object.freeze(value.transact);
  }
  return Object.freeze(value);
}
module.exports = { validRailgunTransactResolution, freezeRailgunTransactResolution };
