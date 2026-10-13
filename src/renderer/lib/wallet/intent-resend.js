/**
 * Send a held payment again: the one path every surface uses (the Send
 * screen's Retry, a dApp approval's Confirm-again).
 *
 * The rule it keeps (freedom-core design 0005, "Retrying an intent"): a
 * payment that has an intent is only ever sent again, at its one nonce, or
 * left; never composed and signed afresh. So whatever a resend's reply
 * says, the caller gets back the payment to keep offering, and only main's
 * positive word that the payment is no longer held (settled, voided, or
 * unknown to it) ends that.
 */

import { confirmSigning } from './signing-confirmation.js';

/** What an `intent-resend` confirmation binds, from a held summary. */
export function resendBinding(intent) {
  return {
    intentId: intent.intentId,
    chainId: intent.chainId,
    sender: intent.sender,
    nonce: intent.nonce,
    hash: intent.hash,
  };
}

/**
 * Send `intent` (a held summary from main) again, authorized by a
 * confirmation minted now. When main refuses that confirmation because it
 * lapsed or no longer matches its record (a replacement changed the
 * payment's latest transaction), the payment is confirmed again as main
 * reports it, once.
 *
 * Throws only when no reply came (the confirmation couldn't be minted, or
 * the IPC failed): the caller keeps offering `intent`.
 *
 * @param {object} intent
 * @returns {Promise<{ result: object, intent: object|null, closed: boolean }>}
 *   main's reply; the held payment to offer next (main's latest summary of
 *   it), null once `closed`; and `closed`, true only when main reported the
 *   payment settled, voided or unknown
 */
export async function resendHeldPayment(intent) {
  let current = intent;
  for (let attempt = 0; ; attempt += 1) {
    const result = await window.wallet.intentResend(
      current.intentId,
      await confirmSigning('intent-resend', null, resendBinding(current))
    );
    if (result?.success) return { result, intent: current, closed: false };
    const reported = result?.intent?.intentId === current.intentId ? result.intent : null;
    if (result?.code === 'INTENT_UNKNOWN' || (reported && reported.state !== 'held')) {
      return { result, intent: null, closed: true };
    }
    if (result?.code === 'SIGNING_NOT_CONFIRMED' && reported && attempt === 0) {
      current = reported;
      continue;
    }
    return { result, intent: reported ?? current, closed: false };
  }
}
