/** Durable shield outcome schema shared by live and compacted journals. */
const HASH = /^0x[0-9a-f]{64}$/;
const quantity = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
function validRailgunShieldResolution(value, record) {
  try {
    const observation = record.observation;
    if (
      !value ||
      Object.keys(value).length !== 4 ||
      !['matched', 'reverted'].includes(value.outcome) ||
      !integer(value.finalizedBlockNumber) ||
      !HASH.test(value.finalizedBlockHash) ||
      value.finalizedBlockNumber < observation.blockNumber ||
      record.intent?.kind !== 'railgun-native-shield'
    )
      return false;
    if (value.outcome === 'reverted')
      return observation.status === 'reverted' && value.shield === null;
    const s = value.shield,
      i = record.intent;
    return (
      observation.status === 'included' &&
      s &&
      Object.keys(s).length === 15 &&
      s.status === 'matched' &&
      s.transactionHash === record.hash &&
      s.blockHash === observation.blockHash &&
      quantity(s.blockNumber) &&
      BigInt(s.blockNumber) === BigInt(observation.blockNumber) &&
      quantity(s.logIndex) &&
      BigInt(s.logIndex) <= BigInt(Number.MAX_SAFE_INTEGER) &&
      integer(s.tree) &&
      s.tree < 65536 &&
      integer(s.position) &&
      s.position < 65536 &&
      s.npk === i.npk &&
      s.token === i.token &&
      s.amount === i.amount &&
      typeof s.noteValue === 'string' &&
      /^[1-9][0-9]{0,16}$/.test(s.noteValue) &&
      typeof s.fee === 'string' &&
      /^(?:0|[1-9][0-9]{0,16})$/.test(s.fee) &&
      BigInt(s.noteValue) + BigInt(s.fee) === BigInt(i.amount) &&
      s.feeDeviation === (s.noteValue !== i.noteValue) &&
      s.trust === 'unverified-rpc' &&
      s.spendingEnabled === false
    );
  } catch {
    return false;
  }
}
function freezeRailgunShieldResolution(value) {
  if (value.shield) Object.freeze(value.shield);
  return Object.freeze(value);
}
module.exports = { validRailgunShieldResolution, freezeRailgunShieldResolution };
