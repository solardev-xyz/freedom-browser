// The account lock as the reference intent store (reference-intent-store.js)
// sees it. The identity core takes main's word for it: `intents.void` and
// `intents.retire` carry `lock: true` once main has checked it holds the
// account's reservation lock (freedom-core design 0013, "The intent
// journal", until 0012's APR-6), so `true` holds it here, as in the core.
// Anything else is a token of main's own lock (nonce-reservations.js), as
// an older build's callers pass one to the reference itself.

function holdsAccountLock(lock, chainId, sender) {
  if (lock === true) return true;
  return require('../../src/main/wallet/nonce-reservations').holdsAccountLock(
    lock,
    chainId,
    sender
  );
}

module.exports = { holdsAccountLock };
