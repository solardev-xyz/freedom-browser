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
 */

const log = require('../logger');
const { normalizeOrigin } = require('../../shared/origin-utils');

/**
 * Whether `origin` has a payment in Payments waiting: a held intent it
 * requested that no receipt has shown mined, by the list's own rule
 * (intent-ipc.js `waitingIntents`). Records that can't be read pause it:
 * the prompt is the safe reading.
 *
 * @param {string} origin the site's permission key
 * @returns {Promise<boolean>}
 */
async function transactionAutoApprovePaused(origin) {
  const site = typeof origin === 'string' ? normalizeOrigin(origin) : '';
  if (!site) return false;
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

module.exports = { transactionAutoApprovePaused };
