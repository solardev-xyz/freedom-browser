/** Narrow ordinary-route classification for enrolled Sepolia accounts. These
 * facts do not prove chain state: the sender code observation is RPC-trusted.
 * The pinned PoolVault requires msg.sender == proof.ownerAddress for ragequit.
 */
const { Transaction } = require('ethers');
const { privacyError } = require('../networks/privacy-context');
const pins = require('./ppv2-sepolia-pins.json');
const address = (value) => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
function targets() {
  return new Set(
    [
      ...Object.values(pins.contracts).flatMap((c) => [c.address, c.implementation?.address]),
      ...Object.values(pins.verifiers).map((c) => c.address),
    ]
      .filter(Boolean)
      .map((v) => v.toLowerCase())
  );
}
const fail = () =>
  privacyError(
    'PRIVATE_ORDINARY_TRANSACTION_REFUSED',
    'This enrolled account requires a supported ordinary transaction from an undelegated account'
  );
function assertOrdinaryRequest(tx) {
  if (
    !address(tx.to?.toLowerCase()) ||
    targets().has(tx.to.toLowerCase()) ||
    (tx.type != null && ![0, 1, 2].includes(Number(tx.type))) ||
    tx.authorizationList != null
  )
    throw fail();
}
function ordinaryFacts(tx) {
  assertOrdinaryRequest(tx);
  const parsed = tx instanceof Transaction ? tx : Transaction.from(tx);
  if (parsed.chainId !== 11155111n || ![0, 1, 2].includes(parsed.type ?? parsed.inferType()))
    throw fail();
  return Object.freeze({
    to: parsed.to.toLowerCase(),
    selector: parsed.data.length >= 10 ? parsed.data.slice(0, 10).toLowerCase() : null,
    type: parsed.type ?? parsed.inferType(),
    senderCode: '0x',
    trust: 'unverified-rpc',
  });
}
function validOrdinaryFacts(facts) {
  return (
    facts &&
    typeof facts === 'object' &&
    !Array.isArray(facts) &&
    Object.keys(facts).length === 5 &&
    address(facts.to) &&
    (facts.selector === null || /^0x[0-9a-f]{8}$/.test(facts.selector)) &&
    [0, 1, 2].includes(facts.type) &&
    facts.senderCode === '0x' &&
    facts.trust === 'unverified-rpc'
  );
}
function isClassifiedOrdinary(record) {
  return (
    record.route === 'ordinary' &&
    record.intent === undefined &&
    validOrdinaryFacts(record.ordinary) &&
    !targets().has(record.ordinary.to)
  );
}
module.exports = {
  assertOrdinaryRequest,
  ordinaryFacts,
  validOrdinaryFacts,
  isClassifiedOrdinary,
  fail,
};
