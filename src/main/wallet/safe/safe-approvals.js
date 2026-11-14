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
 *   first"): main forgets it at once and asks the core to end it
 *   (`approval.end`), which answers `{}` whatever it was, so a retry or an
 *   approval already gone is harmless. Nothing main does presents it after.
 *
 * Dependency-light, so a Safe's deletion (identity-manager) can end its
 * approvals without loading the Safe stack.
 */

const slots = new Map(); // `${kind}:${safeIndex}` -> { id, page, subject }

const KINDS = Object.freeze({ SEND: 'send', MESSAGE: 'message' });
const KIND_SET = new Set(Object.values(KINDS));
const ID = /^[0-9a-f]{32}$/;

function slotKey(kind, safeIndex) {
  if (!KIND_SET.has(kind)) throw new Error(`Not a Safe approval kind: ${kind}`);
  return `${kind}:${safeIndex}`;
}

function endInCore(slot) {
  if (!slot) return Promise.resolve();
  const { vaultBackend } = require('../../core/vault-backend');
  let ending;
  try {
    ending = vaultBackend.approval.end(slot.id, slot.page || null);
  } catch {
    return Promise.resolve();
  }
  return Promise.resolve(ending).then(
    () => {},
    () => {
      // The core gone, or the approval already gone: nothing presents it.
    }
  );
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
 * Safe's older `safe-send` approval itself as it records a new one.
 */
async function hold(kind, safeIndex, approval, subject) {
  if (!isApproval(approval)) throw new Error('Not a Safe approval');
  if (typeof subject !== 'string' || !subject) throw new Error('A Safe approval is held for its SafeTx or SafeMessage');
  const key = slotKey(kind, safeIndex);
  const older = slots.get(key);
  slots.delete(key);
  if (older && older.id !== approval.id) await endInCore(older);
  slots.set(key, { id: approval.id, page: approval.page ?? null, subject });
}

/**
 * The approval held for the Safe's `kind` slot, only for `subject`: `{ id,
 * page }`, or null for none, or one held for another SafeTx or SafeMessage.
 */
function held(kind, safeIndex, subject) {
  const slot = slots.get(slotKey(kind, safeIndex));
  if (!slot || slot.subject !== subject) return null;
  return { id: slot.id, page: slot.page };
}

/**
 * End the approval held for the Safe's `kind` slot (for `subject` only,
 * when one is named): forgotten at once, then ended in the core. Never
 * rejects.
 */
async function end(kind, safeIndex, subject = null) {
  const key = slotKey(kind, safeIndex);
  const slot = slots.get(key);
  if (!slot || (subject !== null && slot.subject !== subject)) return;
  slots.delete(key);
  await endInCore(slot);
}

/**
 * End an approval main was given but never held (its SafeTx or session not
 * started): ended in the core. Never rejects.
 */
function release(approval) {
  return isApproval(approval) ? endInCore(approval) : Promise.resolve();
}

/**
 * Forget the approval held for the Safe's `kind` slot, without asking the
 * core: for one the core no longer knows (`unknown_token`).
 */
function forget(kind, safeIndex, subject) {
  const key = slotKey(kind, safeIndex);
  if (slots.get(key)?.subject === subject) slots.delete(key);
}

/** A Safe deleted: both its approvals forgotten at once, and ended in the core. */
function endSafe(safeIndex) {
  const ended = [];
  for (const kind of KIND_SET) {
    const key = slotKey(kind, safeIndex);
    const slot = slots.get(key);
    if (!slot) continue;
    slots.delete(key);
    ended.push(endInCore(slot));
  }
  return Promise.all(ended).then(() => {});
}

function _reset() {
  slots.clear();
}

module.exports = { KINDS, isApproval, hold, held, end, release, forget, endSafe, _reset };
