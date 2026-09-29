/**
 * Ask main for a signing confirmation (security audit O-7).
 *
 * Main signs nothing without a single-use token it issued for exactly the
 * request being signed. Approval screens call this at the moment the user
 * confirms, with the same request they are about to hand to the signing
 * call, and pass the returned `authorization` along with it.
 *
 * @param {string} kind - 'wallet-send' | 'dapp-send' | 'sign-message' |
 *   'sign-typed-data' | 'safe-send' | 'safe-message'
 * @param {number|null} accountIndex - the signing wallet / Safe index
 *   (ignored for 'wallet-send': main binds the active account)
 * @param {*} payload - the request exactly as it will be signed
 * @returns {Promise<{confirmation: string}>}
 */
export async function confirmSigning(kind, accountIndex, payload) {
  const result = await window.wallet.confirmSigning(kind, accountIndex, payload);
  if (!result?.success || !result.token) {
    throw new Error(result?.error || 'Could not confirm this request');
  }
  return { confirmation: result.token };
}
