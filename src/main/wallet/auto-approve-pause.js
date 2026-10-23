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
 * An auto-approved send is admitted before it signs, and holds its site's
 * admission until its send settles: by then its payment, if it made one, is
 * in the records, held and waiting. Meanwhile the site counts as paused, so
 * two silent requests sent together can't both pass the check before
 * either payment is committed.
 */

const log = require('../logger');
const { normalizeOrigin } = require('../../shared/origin-utils');

// Sites with an auto-approved send admitted and not yet settled.
const admitted = new Set();

/** The permission key a site compares as, or '' for none. */
function siteKey(origin) {
  return typeof origin === 'string' ? normalizeOrigin(origin) : '';
}

/**
 * Whether `origin` has a payment in Payments waiting: a held intent it
 * requested that no receipt has shown mined, by the list's own rule
 * (intent-ipc.js `waitingIntents`), or an auto-approved send admitted and
 * not settled yet. Records that can't be read pause it: the prompt is the
 * safe reading.
 *
 * @param {string} origin the site's permission key
 * @returns {Promise<boolean>}
 */
async function transactionAutoApprovePaused(origin) {
  const site = siteKey(origin);
  if (!site) return false;
  if (admitted.has(site)) return true;
  return paymentWaiting(site);
}

/**
 * Admit an auto-approved send of `origin`, unless the site is paused. The
 * admission is taken before the records are read, so a second send of the
 * site arriving meanwhile is refused. Release it once the send settles
 * (signed and recorded, or failed).
 *
 * @param {string} origin the site's permission key
 * @returns {Promise<(() => void) | null>} the release, or null when paused
 */
async function admitAutoApprovedTransaction(origin) {
  const site = siteKey(origin);
  if (!site || admitted.has(site)) return null;
  admitted.add(site);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    admitted.delete(site);
  };
  if (await paymentWaiting(site)) {
    release();
    return null;
  }
  return release;
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

module.exports = { admitAutoApprovedTransaction, transactionAutoApprovePaused };
