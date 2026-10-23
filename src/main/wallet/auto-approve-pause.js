/**
 * "Always allow" pauses for a site while one of its payments is in Payments
 * waiting (the user's decision D12, freedom-core design 0005 step 5.4).
 *
 * A site whose payment failed, or may still be on its way, often asks
 * again. With a transaction auto-approve rule, that request was signed at
 * once: a second payment, at a new nonce, which the user never saw (the
 * design calls it a new intent, and it is the user's to decide). So while
 * the site has a payment in Payments waiting, its new transaction requests
 * show the normal approval prompt, where the user can decide. Once that
 * payment leaves the list (it is seen mined, or it settles), the rule
 * applies again.
 *
 * Transactions only: message signing pays nothing, and its auto-approve is
 * unchanged. Both of main's readings of a transaction rule consult this:
 * the renderer's question (`dapp:is-tx-auto-approved`, which decides
 * between the prompt and the silent send) and main's own check of an
 * auto-approved send (wallet-ipc.js), so neither can skip the pause.
 *
 * Every dApp send of a site takes the site's turn, one at a time, from
 * before the pause is read until its payment is committed to the records
 * (or its send fails first): confirmed sends too, and on any account or
 * chain, since the pause is the site's. So no payment of the site can be
 * committed between a silent send's reading of Payments waiting and its
 * own commit: two silent requests sent together give one payment, and a
 * payment the user confirms meanwhile pauses the silent one. A confirmed
 * send is never refused by the pause; it only waits its turn. The wait is
 * bounded, as an account lock's is, and so is the queue; a silent send
 * doesn't queue at all (takeSiteTurn).
 */

const log = require('../logger');
const { normalizeOrigin } = require('../../shared/origin-utils');

const { WAIT_TIMEOUT_MS } = require('./nonce-reservations');

// A site's sends waiting for its turn, at most. More are refused at once.
const MAX_WAITING = 8;

// Site → its turn: held while the site is in the map, with the sends
// waiting for it in order.
const turns = new Map();

/** The permission key a site compares as, or '' for none. */
function siteKey(origin) {
  return typeof origin === 'string' ? normalizeOrigin(origin) : '';
}

function turnBusyError() {
  const error = new Error(
    'Another payment for this site is waiting for approval. Try again once it is done.'
  );
  error.code = 'SITE_TURN_BUSY';
  return error;
}

// Hands the turn straight to the next send waiting, so no newcomer can take
// it in between; the turn is free once no one waits.
function leaveOnce(site, turn) {
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const next = turn.waiting.shift();
    if (!next) {
      turns.delete(site);
      return;
    }
    clearTimeout(next.timer);
    next.resolve(leaveOnce(site, turn));
  };
}

/**
 * Wait for the site's turn among its dApp sends. Resolves with `leave`, to
 * be called once the send's payment is committed or the send has failed;
 * calling it again does nothing. The send holding the turn is never cut
 * short (it may be waiting for a device), but a send waiting for it gives
 * up after `waitMs` (the account lock's wait), and only MAX_WAITING may
 * wait at once: either way it fails with SITE_TURN_BUSY, leaving the order
 * of the others as it was. A send that mustn't wait (`wait: false`, a
 * silent one: it would only be refused once the payment ahead is waiting)
 * fails at once while the turn is taken. A send without a site has no turn
 * to wait for.
 *
 * @param {string} origin the site's permission key
 * @param {{ wait?: boolean, waitMs?: number }} [options]
 * @returns {Promise<() => void>}
 */
function takeSiteTurn(origin, { wait = true, waitMs = WAIT_TIMEOUT_MS } = {}) {
  const site = siteKey(origin);
  if (!site) return Promise.resolve(() => {});
  const turn = turns.get(site);
  if (!turn) {
    const fresh = { waiting: [] };
    turns.set(site, fresh);
    return Promise.resolve(leaveOnce(site, fresh));
  }
  if (!wait || turn.waiting.length >= MAX_WAITING) return Promise.reject(turnBusyError());
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const index = turn.waiting.indexOf(waiter);
      if (index !== -1) turn.waiting.splice(index, 1);
      reject(turnBusyError());
    }, waitMs);
    waiter.timer.unref?.();
    turn.waiting.push(waiter);
  });
}

/**
 * Whether `origin` has a payment in Payments waiting: a held intent it
 * requested that no receipt has shown mined, by the list's own rule
 * (intent-ipc.js `waitingIntents`), or a dApp send of the site under way
 * that hasn't committed yet. The renderer asks this before choosing the
 * silent path. Records that can't be read pause it: the prompt is the safe
 * reading.
 *
 * @param {string} origin the site's permission key
 * @returns {Promise<boolean>}
 */
async function transactionAutoApprovePaused(origin) {
  const site = siteKey(origin);
  if (!site) return false;
  if (turns.has(site)) return true;
  return paymentWaiting(site);
}

/**
 * Whether a silent send of `origin` must stop: one of the site's payments
 * is in Payments waiting. Read in the send's own turn, so no same-site
 * commit can land between this and the send's.
 *
 * @param {string} origin the site's permission key
 * @returns {Promise<boolean>}
 */
async function sitePaymentWaiting(origin) {
  const site = siteKey(origin);
  return site ? paymentWaiting(site) : false;
}

async function paymentWaiting(site) {
  let waiting;
  try {
    // Loaded here, not at the top: the permissions store is required early,
    // by modules that never touch the wallet's records.
    waiting = await require('./intent-ipc').waitingIntents();
  } catch (err) {
    log.warn(`[AutoApprove] Payments waiting unavailable; asking instead: ${err.message}`);
    return true;
  }
  return waiting.some(
    (intent) => typeof intent.origin === 'string' && normalizeOrigin(intent.origin) === site
  );
}

module.exports = {
  MAX_WAITING,
  sitePaymentWaiting,
  takeSiteTurn,
  transactionAutoApprovePaused,
};
