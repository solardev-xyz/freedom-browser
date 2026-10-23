/**
 * Ask main for a signing confirmation (security audit O-7).
 *
 * Main signs nothing without a single-use token it issued for exactly the
 * request being signed. Approval screens call this at the moment the user
 * confirms, with the same request they are about to hand to the signing
 * call, and pass the returned `authorization` along with it.
 *
 * @param {string} kind - 'wallet-send' | 'dapp-send' | 'sign-message' |
 *   'sign-typed-data' | 'safe-send' | 'safe-message' | 'intent-resend'
 *   (a held payment's {intentId, chainId, sender, nonce, hash}, sent again)
 *   | 'intent-replace' (a held payment's {intentId, chainId, sender, nonce,
 *   to, value, data, gasLimit} with its new fees, signed again at its nonce)
 * @param {number|null} accountIndex - the signing wallet / Safe index
 *   (ignored for 'wallet-send': main binds the active account)
 * @param {*} payload - the request exactly as it will be signed
 * @param {{ feeAcknowledged?: boolean }} [options] - for a transaction:
 *   whether the user confirmed a fee above the fee check's threshold again
 *   (fee-check.js). Without it, main may mint nothing and answer
 *   FEE_CHECK_ASK_AGAIN: the error then carries that `code` and main's
 *   verdict as `feeCheck`, and the screen asks again.
 * @returns {Promise<{confirmation: string}>}
 */
export async function confirmSigning(kind, accountIndex, payload, options) {
  const result = await (options === undefined
    ? window.wallet.confirmSigning(kind, accountIndex, payload)
    : window.wallet.confirmSigning(kind, accountIndex, payload, options));
  if (!result?.success || !result.token) {
    const error = new Error(result?.error || 'Could not confirm this request');
    if (result?.code) error.code = result.code;
    if (result?.feeCheck) error.feeCheck = result.feeCheck;
    throw error;
  }
  return { confirmation: result.token };
}
