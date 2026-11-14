/**
 * The Safe approvals main holds (freedom-core design 0012, "A page's Safe
 * and Swarm signatures"; APB-1c): what a spent `safe-send` or
 * `safe-message` token, or a Safe message's standing rule, gives the
 * signatures it stands for. Each vault owner's `sign.typed_data` presents
 * it as `{ safe }`, and so does the executor's `sign.transaction` of a
 * Safe send, while the fee check allows it.
 *
 * - **One per Safe and kind:** a Safe has one pending SafeTx and one
 *   SafeMessage session, so a `send` slot and a `message` slot per Safe
 *   index, each bound to the SafeTx's or the SafeMessage's hash once main
 *   has built it. A slot names whose approval it is: a page's carries the
 *   PageContext it was recorded with, under which every signature presents
 *   it, the document gone or not; the wallet's has none (`shell`).
 * - **In memory only.** The id is a bearer secret, like a token: never
 *   persisted, never logged. After a restart main holds none, as the core
 *   holds none, and an owner that hasn't signed needs a new confirmation
 *   (`safe-transactions.js`), the executor an `executor-send` token.
 * - **Ended before the step that ends its effect** (design 0012, "Narrowing
 *   first"): from the moment main asks the core to end it (`approval.end`),
 *   nothing main does presents it, and the step waits for the core's
 *   answer, which comes after any signature already presenting it. The core
 *   answers `{}` whatever it was (ended already, or unknown), so asking
 *   again is harmless. A failure counts as an end only once the core
 *   process that gave it has ended (`vaultBackend.coreProcessEnded`: its
 *   approvals went with it, and a signature on its way failed with it).
 *   Otherwise main asks again, a bounded number of times, and then the end
 *   fails (SAFE_APPROVAL_END_FAILED): the approval is held again, and the
 *   caller does none of what waited on it.
 *
 * - **The Safe's exclusion.** One live step per Safe (a signature ceremony,
 *   an execution through its broadcast, a session's opening), across sends
 *   and message sessions; the send a Safe has reserved before its token is
 *   spent; and a Safe's deletion, which waits for neither but is refused
 *   while either runs, and then lets no step start, no send reserve it and
 *   no approval be held for it until it ends.
 *
 * Dependency-light, so a Safe's deletion (identity-manager) can take its
 * exclusion and end its approvals without loading the Safe stack.
 */

const { codedError, SAFE_APPROVAL_END_FAILED, SAFE_BUSY, SAFE_PENDING_EXISTS } = require('./errors');

// `${kind}:${safeIndex}` -> { id, page, subject, core, ending }: `core` the
// core process when main held it (`vaultBackend.coreProcess()`), `ending`
// the end in flight, if any.
const slots = new Map();

const KINDS = Object.freeze({ SEND: 'send', MESSAGE: 'message' });
const KIND_SET = new Set(Object.values(KINDS));
const ID = /^[0-9a-f]{32}$/;

// The waits before asking the core again after a failed `approval.end`, while
// the process that gave the approval still runs (ms): three tries in all.
const RETRY_DELAYS_MS = Object.freeze([100, 400]);
let retryDelaysMs = RETRY_DELAYS_MS;

function slotKey(kind, safeIndex) {
  if (!KIND_SET.has(kind)) throw new Error(`Not a Safe approval kind: ${kind}`);
  return `${kind}:${safeIndex}`;
}

function backend() {
  return require('../../core/vault-backend').vaultBackend;
}

function endFailed(cause) {
  const err = codedError(
    "The wallet couldn't close this request's approval in the identity core, so nothing changed. Try again.",
    SAFE_APPROVAL_END_FAILED
  );
  err.cause = cause;
  return err;
}

/**
 * Ends `approval` (`{ id, page, core }`) in the core: resolves once the core
 * has answered, or once the process `core` names has ended; rejects
 * SAFE_APPROVAL_END_FAILED after its tries otherwise.
 */
async function endInCore(approval) {
  const vaultBackend = backend();
  let failure = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt - 1]));
    try {
      await vaultBackend.approval.end(approval.id, approval.page || null);
      return;
    } catch (err) {
      // The process that gave it has exited (a crash, a hang killed, a
      // restart), or main stopped it: the approval is gone with it.
      if (vaultBackend.coreProcessEnded(approval.core)) return;
      failure = err;
    }
  }
  throw endFailed(failure);
}

/**
 * Whether `approval` is one the core gave: `{ id, page }`, its id 32
 * lowercase hex digits, its page a PageContext or null.
 */
function isApproval(approval) {
  return (
    Boolean(approval) &&
    typeof approval.id === 'string' &&
    ID.test(approval.id) &&
    (approval.page === null || (typeof approval.page === 'object' && typeof approval.page.origin === 'string'))
  );
}

/**
 * Hold `approval` for the Safe's `kind` slot, bound to `subject` (the
 * SafeTx's or the SafeMessage's hash). An older one held there is ended
 * first: a Safe has one pending SafeTx and one session, and the core ends a
 * Safe's older `safe-send` approval itself as it records a new one. If that
 * end fails, this one isn't held (SAFE_APPROVAL_END_FAILED).
 */
async function hold(kind, safeIndex, approval, subject) {
  if (!isApproval(approval)) throw new Error('Not a Safe approval');
  if (typeof subject !== 'string' || !subject) throw new Error('A Safe approval is held for its SafeTx or SafeMessage');
  const key = slotKey(kind, safeIndex);
  // None for a Safe being deleted, or deleted while this waited.
  if (deleting.has(safeIndex)) throw deletionUnderWay();
  const deletion = deletions.get(safeIndex) ?? 0;
  for (let older = slots.get(key); older && older.id !== approval.id; older = slots.get(key)) {
    await end(kind, safeIndex);
  }
  if (deleting.has(safeIndex) || (deletions.get(safeIndex) ?? 0) !== deletion) throw deletionUnderWay();
  // The process that answers now gave it, or one after that one: its end
  // proves the approval gone, and nothing earlier's would.
  slots.set(key, { id: approval.id, page: approval.page ?? null, subject, core: backend().coreProcess(), ending: null });
}

/**
 * The approval held for the Safe's `kind` slot, only for `subject`: `{ id,
 * page }`, or null for none, one held for another SafeTx or SafeMessage, or
 * one being ended.
 */
function held(kind, safeIndex, subject) {
  const slot = slots.get(slotKey(kind, safeIndex));
  if (!slot || slot.ending || slot.subject !== subject) return null;
  return { id: slot.id, page: slot.page };
}

/**
 * End the approval held for the Safe's `kind` slot (for `subject` only,
 * when one is named). From the call on it isn't presented (`held` answers
 * null); it is forgotten once the core has ended it, and the promise
 * resolves then. If its end fails, it is held again and the promise rejects
 * (SAFE_APPROVAL_END_FAILED): the caller does nothing that waited on it.
 * Ends of one approval share the one in flight.
 */
async function end(kind, safeIndex, subject = null) {
  const key = slotKey(kind, safeIndex);
  const slot = slots.get(key);
  if (!slot || (subject !== null && slot.subject !== subject)) return;
  if (!slot.ending) {
    slot.ending = endInCore(slot).then(
      () => {
        if (slots.get(key) === slot) slots.delete(key);
      },
      (err) => {
        slot.ending = null;
        throw err;
      }
    );
  }
  await slot.ending;
}

/**
 * End an approval main was given but never held (its SafeTx or session not
 * started), in the core. Rejects as `end` does; nothing else waits on it.
 */
function release(approval) {
  if (!isApproval(approval)) return Promise.resolve();
  return endInCore({ id: approval.id, page: approval.page ?? null, core: backend().coreProcess() });
}

/**
 * Forget the approval held for the Safe's `kind` slot, without asking the
 * core: for one the core no longer knows (`unknown_token`).
 */
function forget(kind, safeIndex, subject) {
  const key = slotKey(kind, safeIndex);
  if (slots.get(key)?.subject === subject) slots.delete(key);
}

/**
 * A Safe deleted: both its approvals ended, each as `end` ends it. Rejects
 * if either's end fails (the other may be ended by then).
 */
async function endSafe(safeIndex) {
  const results = await Promise.allSettled([...KIND_SET].map((kind) => end(kind, safeIndex)));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

// ---- The Safe's exclusion ----

// The Safes with a live step (`beginStep`). In memory only: a main-process
// crash clears it, the correct reset.
const steps = new Set();
// The send each Safe has reserved (`reserveSend`), by index.
const sendReservations = new Map();
// The Safes being deleted (`beginDeletion`), and how many deletions each
// index has begun, which a hold that waited compares.
const deleting = new Set();
const deletions = new Map();

function deletionUnderWay() {
  return codedError('This account is being deleted', SAFE_BUSY);
}

/**
 * A step of the Safe's begins (a signature ceremony, an execution through
 * its broadcast, a session's opening): refused (SAFE_BUSY) while another
 * runs, since a device can't serve two at once, or while the Safe is being
 * deleted. `endStep` ends it.
 */
function beginStep(safeIndex) {
  if (deleting.has(safeIndex)) throw deletionUnderWay();
  if (steps.has(safeIndex)) throw codedError('Another step of this transaction is still running', SAFE_BUSY);
  steps.add(safeIndex);
}

function endStep(safeIndex) {
  steps.delete(safeIndex);
}

function stepRunning(safeIndex) {
  return steps.has(safeIndex);
}

/**
 * Reserves the Safe's next SafeTx for a send, before its `safe-send` token
 * is spent (`safe-transactions.js`): refused (SAFE_PENDING_EXISTS) while
 * another send holds it, and (SAFE_BUSY) while the Safe is being deleted.
 * `release()` (idempotent) gives it up, never a later send's.
 *
 * @returns {{ safeIndex: number, release: () => void }}
 */
function reserveSend(safeIndex) {
  if (deleting.has(safeIndex)) throw deletionUnderWay();
  if (sendReservations.has(safeIndex)) {
    throw codedError(
      'Another transaction for this account is being set up — finish or discard it first',
      SAFE_PENDING_EXISTS
    );
  }
  const reservation = Object.freeze({
    safeIndex,
    release: () => {
      if (sendReservations.get(safeIndex) === reservation) sendReservations.delete(safeIndex);
    },
  });
  sendReservations.set(safeIndex, reservation);
  return reservation;
}

/** Whether `reservation` is the Safe's live send reservation. */
function holdsReservation(safeIndex, reservation) {
  return Boolean(reservation) && sendReservations.get(safeIndex) === reservation;
}

/**
 * A Safe's deletion begins: refused (SAFE_BUSY) while a step of it runs or
 * a send holds its reservation, so nothing of it is cut short (an execution
 * past its executor's signature included, up to its broadcast). From then
 * on no step starts, no send reserves it and no approval is held for it,
 * until `release()`: the deletion calls it once it has failed, or once the
 * Safe's state and record are gone.
 *
 * @returns {{ release: () => void }}
 */
function beginDeletion(safeIndex) {
  if (deleting.has(safeIndex) || steps.has(safeIndex) || sendReservations.has(safeIndex)) {
    throw codedError('Wait for the current step of this account to finish first', SAFE_BUSY);
  }
  deleting.add(safeIndex);
  deletions.set(safeIndex, (deletions.get(safeIndex) ?? 0) + 1);
  let open = true;
  return {
    release: () => {
      if (open) deleting.delete(safeIndex);
      open = false;
    },
  };
}

function _reset({ retryDelays = RETRY_DELAYS_MS } = {}) {
  slots.clear();
  steps.clear();
  sendReservations.clear();
  deleting.clear();
  deletions.clear();
  retryDelaysMs = retryDelays;
}

module.exports = {
  KINDS,
  isApproval,
  hold,
  held,
  end,
  release,
  forget,
  endSafe,
  beginStep,
  endStep,
  stepRunning,
  reserveSend,
  holdsReservation,
  beginDeletion,
  _reset,
};
