/**
 * Safe error codes — the machine-readable side of the Safe flows' error
 * contract. Codes cross the IPC boundary (wallet-ipc's safeStateHandler
 * forwards `err.code`) and the renderer switches on them to render
 * blocking states, unlock walks, and row notes instead of raw text.
 * (VAULT_LOCKED is not here: it belongs to the vault layer and is tagged
 * by wallet-ipc via isVaultLockedError.)
 */

const CODES = {
  /** Another step (signature ceremony, execution) is live for this Safe. */
  SAFE_BUSY: 'SAFE_BUSY',
  /** One pending SafeTx per Safe — finish or discard the current one. */
  SAFE_PENDING_EXISTS: 'SAFE_PENDING_EXISTS',
  /** A live SafeMessage session belongs to another page — no takeover. */
  SAFE_MESSAGE_EXISTS: 'SAFE_MESSAGE_EXISTS',
  /** The pending item was discarded while a signature was being made. */
  SAFE_DISCARDED: 'SAFE_DISCARDED',
  /** Nothing local can pay gas — render the fund-the-executor state. */
  SAFE_NEEDS_FUNDS: 'SAFE_NEEDS_FUNDS',
};

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { ...CODES, codedError };
