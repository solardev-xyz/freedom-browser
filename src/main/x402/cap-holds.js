/**
 * Main's own count of the cap charges it has let a Ledger sign for, whose
 * spend its mirror of the caps doesn't show yet (freedom-core design 0016,
 * "x402 from a Ledger account", and LDG-2's L5 as built; LDG-3's PR 9).
 *
 * On the core's Ledger backend, an auto-pay's charge is only a hold in the
 * core until the device's signature is checked: nothing is written to the
 * cap's file before, so main's mirror (core/grants.js, read again only
 * after each payment, and keeping the old record while it reads) shows the
 * cap's room without it. Main checks, before anything reaches the device,
 * that the entry the core picked is one a cap covers in main's own view
 * (sign-flow.js `ledgerEntry`); two auto-pays in flight at once would each
 * see the same room, so a faulty core could have the Ledger sign more than
 * main's cap. So the check and the count are one synchronous step here:
 *
 * - `holdIfCovered(origin, accept)`: the entry's amount is held if main's
 *   mirror shows a cap for its chain and asset that answers now with room
 *   for it beyond every hold already counted for that cap's origin, chain
 *   and asset (payment-utils.js `coverageForAccept`, less the holds); the
 *   hold, or null when it isn't covered.
 * - `releaseHold(hold)`: the hold is let go at once: the payment ended with
 *   nothing written to the cap (refused before the device, settled
 *   `withheld`, refunded, cancelled).
 * - `releaseHoldWhen(hold, read)`: let go only once `read` settles, a read
 *   of the mirror asked after the charge may have been written (a signed
 *   payment, whose charge the core writes before it answers; an end that
 *   may have left a charge counted): so there is never a moment when
 *   neither the mirror nor a hold counts it.
 *
 * Releasing twice is harmless. Only a Ledger's auto-pays on the core's
 * backend take holds; nothing else reads them.
 */

const { coverageForAccept } = require('./payment-utils');

/** Each cap's holds, by origin, chain and asset. */
const holds = new Map();

const keyOf = (origin, chainId, asset) => `${origin} ${chainId} ${asset}`;

function heldFor(key) {
  let sum = 0n;
  for (const hold of holds.get(key) ?? []) sum += hold.amount;
  return sum;
}

/**
 * Holds `accept`'s amount against `origin`'s cap for its chain and asset if
 * main's mirror shows that cap covering it beyond the holds already
 * counted. Synchronous: no other payment's check runs between the check and
 * the hold.
 *
 * @param {string} origin - the paid URL's origin, the cap's key
 * @param {object} accept - main's copy of the `accepts[]` entry
 * @returns {{ key: string, amount: bigint, released: boolean } | null}
 */
function holdIfCovered(origin, accept) {
  const coverage = coverageForAccept(origin, accept);
  if (!coverage) return null;
  const key = keyOf(coverage.perm.origin, coverage.tuple.chainId, coverage.tuple.asset);
  const amount = BigInt(coverage.tuple.amount);
  if (amount > coverage.remaining - heldFor(key)) return null;
  const hold = { key, amount, released: false };
  if (!holds.has(key)) holds.set(key, new Set());
  holds.get(key).add(hold);
  return hold;
}

/** Lets go of a hold at once (again, or null: nothing). */
function releaseHold(hold) {
  if (!hold || hold.released) return;
  hold.released = true;
  const set = holds.get(hold.key);
  if (!set) return;
  set.delete(hold);
  if (set.size === 0) holds.delete(hold.key);
}

/** Lets go of a hold once `read`, a mirror read asked after its charge may have been written, settles. */
function releaseHoldWhen(hold, read) {
  if (!hold || hold.released) return;
  Promise.resolve(read).finally(() => releaseHold(hold)).catch(() => {});
}

/** What is held against `origin`'s cap for `chainId` and `asset` (lowercase), in atomic units. */
function heldAmount(origin, chainId, asset) {
  return heldFor(keyOf(origin, chainId, asset));
}

module.exports = {
  holdIfCovered,
  releaseHold,
  releaseHoldWhen,
  heldAmount,
  _resetForTests: () => holds.clear(),
};
