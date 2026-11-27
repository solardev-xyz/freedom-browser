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
 * main's cap. So main holds each such payment's amount itself:
 *
 * - `holdIfCovered(origin, accept)`: one synchronous step checks that main's
 *   mirror shows a cap for the entry's chain and asset that answers now
 *   with room for its amount beyond every hold main counts against that
 *   cap's origin, chain and asset (payment-utils.js `coverageForAccept`,
 *   less the holds), and holds the amount; the hold, or null when it isn't
 *   covered. The hold keeps the cap as it was then: its identity (its
 *   `createdAt`: a cap granted again is a new record from `spentAmount`
 *   "0") and its `spentAmount`, the baseline.
 * - `releaseHold(hold)`: let go at once, when the device's signature never
 *   left main (main's relay saw none: the payment was refused before the
 *   device or unsent, the user rejected it, the device failed, the core
 *   ended it first). Without a signature nothing can be paid, whatever the
 *   core says of its charge.
 * - `awaitSpend(hold, read)`: the device's signature may have left main (a
 *   signed payment, or one the core then failed), so the hold stays until
 *   the mirror accounts for it: until a read that has landed shows the
 *   same cap's `spentAmount` risen by the held amount above both the
 *   baseline and what earlier holds let go this way already claimed of
 *   that cap's rises (two holds can't both claim one rise), or another cap
 *   (another `createdAt`) now under the key, which starts afresh. Checked
 *   when `read`, a mirror read asked after the payment ended, lands, and
 *   again at every later check of that cap (`holdIfCovered`,
 *   `heldAmount`), so the mirror's next refresh (the core's
 *   `approval.changed`, another payment's read) is enough.
 *
 * A cap that is gone from the mirror (revoked, expired, a read that failed)
 * covers nothing, so its holds are inert there; they are let go once
 * another cap takes the key. A core that never reports the spend leaves
 * the amount held until the cap changes or main restarts: the safe way
 * round, since a hold only ever keeps room unavailable. Letting go twice is
 * harmless. Only a Ledger's auto-pays on the core's backend take holds;
 * nothing else reads them.
 */

const { getPermission } = require('./caps');
const { coverageForAccept } = require('./payment-utils');

/** Each cap's holds, by origin, chain and asset, in the order they were taken. */
const holds = new Map();
/** What holds let go by a rise have claimed of each cap's `spentAmount`, by key and identity. */
const claimed = new Map();

const keyOf = (origin, chainId, asset) => `${origin} ${chainId} ${asset}`;
const identityOf = (key, createdAt) => `${key} ${createdAt}`;

function remove(hold) {
  hold.released = true;
  const list = holds.get(hold.key);
  if (!list) return;
  const at = list.indexOf(hold);
  if (at >= 0) list.splice(at, 1);
  if (list.length === 0) {
    holds.delete(hold.key);
    for (const identity of claimed.keys()) {
      if (identity.startsWith(`${hold.key} `)) claimed.delete(identity);
    }
  }
}

/**
 * Lets go of each hold awaiting its spend under `key` that the mirror now
 * accounts for, oldest first.
 */
function reconcile(key) {
  const list = holds.get(key);
  if (!list) return;
  const [{ origin, chainId, asset }] = list;
  const cap = getPermission(origin, chainId, asset);
  // No cap answers: it covers nothing, and its holds wait for another.
  if (!cap) return;
  const spent = BigInt(cap.spentAmount);
  for (const hold of [...list]) {
    if (!hold.awaiting) continue;
    if (cap.createdAt !== hold.createdAt) {
      remove(hold);
      continue;
    }
    const identity = identityOf(key, hold.createdAt);
    const before = claimed.get(identity);
    const floor = before !== undefined && before > hold.baseline ? before : hold.baseline;
    if (spent >= floor + hold.amount) {
      claimed.set(identity, floor + hold.amount);
      remove(hold);
    }
  }
}

function heldFor(key) {
  let sum = 0n;
  for (const hold of holds.get(key) ?? []) sum += hold.amount;
  return sum;
}

/**
 * Holds `accept`'s amount against `origin`'s cap for its chain and asset if
 * main's mirror shows that cap covering it beyond the holds counted.
 * Synchronous: no other payment's check runs between the check and the
 * hold.
 *
 * @param {string} origin - the paid URL's origin, the cap's key
 * @param {object} accept - main's copy of the `accepts[]` entry
 * @returns {object | null} the hold
 */
function holdIfCovered(origin, accept) {
  const coverage = coverageForAccept(origin, accept);
  if (!coverage) return null;
  const { chainId, asset } = coverage.tuple;
  const key = keyOf(coverage.perm.origin, chainId, asset);
  reconcile(key);
  const amount = BigInt(coverage.tuple.amount);
  if (amount > coverage.remaining - heldFor(key)) return null;
  const hold = {
    key,
    origin: coverage.perm.origin,
    chainId,
    asset,
    amount,
    createdAt: coverage.perm.createdAt,
    baseline: BigInt(coverage.perm.spentAmount),
    awaiting: false,
    released: false,
  };
  if (!holds.has(key)) holds.set(key, []);
  holds.get(key).push(hold);
  return hold;
}

/** Lets go of a hold at once: the device's signature never left main (again, or null: nothing). */
function releaseHold(hold) {
  if (!hold || hold.released) return;
  remove(hold);
}

/**
 * Keeps a hold whose device's signature may have left main until the
 * mirror accounts for its spend, checked once `read`, a mirror read asked
 * after the payment ended, lands, and at every later check of its cap.
 */
function awaitSpend(hold, read) {
  if (!hold || hold.released) return;
  hold.awaiting = true;
  Promise.resolve(read)
    .catch(() => {})
    .then(() => reconcile(hold.key));
}

/** What is held against `origin`'s cap for `chainId` and `asset` (lowercase), in atomic units. */
function heldAmount(origin, chainId, asset) {
  const key = keyOf(origin, chainId, asset);
  reconcile(key);
  return heldFor(key);
}

module.exports = {
  holdIfCovered,
  releaseHold,
  awaitSpend,
  heldAmount,
  _resetForTests: () => {
    holds.clear();
    claimed.clear();
  },
};
