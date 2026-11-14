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
  /** No pinned Safe deployment (proxy code) for this chain or version. */
  SAFE_UNSUPPORTED: 'SAFE_UNSUPPORTED',
  /** The Safe's code was read, but no verified source confirmed it. */
  SAFE_UNVERIFIED: 'SAFE_UNVERIFIED',
  /** The deployment would create another address than the record's. */
  SAFE_ADDRESS_MISMATCH: 'SAFE_ADDRESS_MISMATCH',
  /** A site's SafeTx whose site no longer holds it (its name moved, or its
   * page has gone) is not executed for the site: it stays, as the wallet's. */
  SAFE_SITE_WITHDRAWN: 'SAFE_SITE_WITHDRAWN',
  /** The same, but the records couldn't yet be rewritten to say so: the
   * SafeTx still names its site, and the next attempt finishes the move. */
  SAFE_SITE_WITHDRAWING: 'SAFE_SITE_WITHDRAWING',
  /** No Safe approval is held for the pending item (freedom-core design
   * 0012): main restarted since it was confirmed, or the approval ended, so
   * no owner signs it until the user confirms it again. */
  SAFE_APPROVAL_NEEDED: 'SAFE_APPROVAL_NEEDED',
  /** The identity core didn't confirm the end of the pending item's Safe
   * approval (`approval.end`), and the process that gave it is still
   * running: nothing that waits on its end (a discard, a cancel, the join,
   * clearing an executed SafeTx) was done, and the user tries again. */
  SAFE_APPROVAL_END_FAILED: 'SAFE_APPROVAL_END_FAILED',
  /** A held Safe execution's Safe is no longer in the wallet list (deleted):
   * its bytes aren't sent again or replaced. */
  SAFE_DELETED: 'SAFE_DELETED',
};

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { ...CODES, codedError };
