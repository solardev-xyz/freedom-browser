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
  /** No pinned Safe deployment (proxy code) for this chain or version; on
   * the core, anything else Freedom doesn't sign for a Safe (another chain
   * than Gnosis, a phone owner): the core's `unsupported`. */
  SAFE_UNSUPPORTED: 'SAFE_UNSUPPORTED',
  /** The Safe's code was read, but no verified source confirmed it; on the
   * core, any read a step that signs or executes rests on (its `unverified`,
   * deviation `safe-unverified`): nothing was signed. */
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
  // The core's own refusals (freedom-core design 0016, API, "Errors";
  // SAFE-3): `invalid_argument` with `data.safe` (CORE_SAFE_CODES).
  /** The Safe's setup on Gnosis isn't its record's (singleton, owners,
   * threshold, guard, handler or a module): nothing is signed, and the
   * board offers only to discard (deviation `safe-setup`). */
  SAFE_CHANGED: 'SAFE_CHANGED',
  /** A transaction to the Safe itself (a setup change), which Freedom never
   * signs (0016's question 4). */
  SAFE_SELF_CALL: 'SAFE_SELF_CALL',
  /** The Safe's nonce on Gnosis is below the SafeTx's (deviation
   * `nonce-behind`): nothing is signed or sent. */
  SAFE_NONCE_BEHIND: 'SAFE_NONCE_BEHIND',
  /** No room in `safe-pending.json` (its 1 MiB bound) for the proposal. */
  SAFE_STORE_FULL: 'SAFE_STORE_FULL',
  /** The Safe isn't activated on Gnosis: nothing signs or executes for it. */
  SAFE_NOT_DEPLOYED: 'SAFE_NOT_DEPLOYED',
  /** The pending SafeTx carries no proposal mark of the core's (one an older
   * version wrote): no owner adds a signature to it. */
  SAFE_NOT_PROPOSED: 'SAFE_NOT_PROPOSED',
};

/**
 * The core's `data.safe` on an `invalid_argument` (freedom-core design
 * 0016, API, "Errors"; cored 0.32.0's `safe::methods`), and the code main
 * gives it: the core's own refusals by name, and today's codes, which the
 * core sends as they are. A `data.safe` this table doesn't name is no
 * Safe code of main's.
 */
const CORE_SAFE_CODES = Object.freeze({
  unsupported: CODES.SAFE_UNSUPPORTED,
  unverified: CODES.SAFE_UNVERIFIED,
  changed: CODES.SAFE_CHANGED,
  self_call: CODES.SAFE_SELF_CALL,
  nonce_behind: CODES.SAFE_NONCE_BEHIND,
  store_full: CODES.SAFE_STORE_FULL,
  not_deployed: CODES.SAFE_NOT_DEPLOYED,
  not_proposed: CODES.SAFE_NOT_PROPOSED,
  SAFE_ADDRESS_MISMATCH: CODES.SAFE_ADDRESS_MISMATCH,
  SAFE_NEEDS_FUNDS: CODES.SAFE_NEEDS_FUNDS,
  SAFE_DISCARDED: CODES.SAFE_DISCARDED,
  SAFE_PENDING_EXISTS: CODES.SAFE_PENDING_EXISTS,
  SAFE_BUSY: CODES.SAFE_BUSY,
  SAFE_MESSAGE_EXISTS: CODES.SAFE_MESSAGE_EXISTS,
  SAFE_APPROVAL_NEEDED: CODES.SAFE_APPROVAL_NEEDED,
});

/**
 * The code main gives a core refusal (`invalid_argument` whose `data.safe`
 * CORE_SAFE_CODES names), or null for any other error.
 * @param {{ code?: string, data?: { safe?: unknown } }} err
 * @returns {string|null}
 */
function coreSafeCode(err) {
  if (err?.code !== 'invalid_argument') return null;
  const named = err.data?.safe;
  return typeof named === 'string' && Object.hasOwn(CORE_SAFE_CODES, named)
    ? CORE_SAFE_CODES[named]
    : null;
}

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { ...CODES, CORE_SAFE_CODES, codedError, coreSafeCode };
