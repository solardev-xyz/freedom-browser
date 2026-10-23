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
 * send is never refused by the pause; it only waits its turn.
 */

const log = require('../logger');
const { normalizeOrigin } = require('../../shared/origin-utils');

// Per site, the end of its queue of dApp sends, and how many are in it.
const queues = new Map();

/** The permission key a site compares as, or '' for none. */
function siteKey(origin) {
  return typeof origin === 'string' ? normalizeOrigin(origin) : '';
}

/**
 * Wait for the site's turn among its dApp sends. Resolves with `leave`,
 * to be called once the send's payment is committed or the send has
 * failed; calling it again does nothing. A send without a site has no
 * turn to wait for.
 *
 * @param {string} origin the site's permission key
 * @returns {Promise<() => void>}
 */
function takeSiteTurn(origin) {
  const site = siteKey(origin);
  if (!site) return Promise.resolve(() => {});
  const queue = queues.get(site) ?? { last: Promise.resolve(), size: 0 };
  queues.set(site, queue);
  queue.size += 1;
  let left = false;
  let markLeft;
  const done = new Promise((resolve) => {
    markLeft = resolve;
  });
  const leave = () => {
    if (left) return;
    left = true;
    markLeft();
    queue.size -= 1;
    if (queue.size === 0 && queues.get(site) === queue) queues.delete(site);
  };
  const turn = queue.last.then(() => leave);
  queue.last = done;
  return turn;
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
  if (queues.has(site)) return true;
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

module.exports = { sitePaymentWaiting, takeSiteTurn, transactionAutoApprovePaused };
