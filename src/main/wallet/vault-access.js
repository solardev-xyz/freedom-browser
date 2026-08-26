/**
 * Vault private-key access helper.
 *
 * Every caller that needs to sign with a vault key — wallet IPC handlers,
 * the x402 client, future signers — performs the same sequence:
 *
 *   1. `loadIdentityModule()` — lazy-load the identity module.
 *   2. `isUnlocked()` — refuse if the vault is locked.
 *   3. `exportPrivateKey(walletIndex)` — derive the key.
 *   4. (do the work)
 *   5. `resetVaultAutoLockTimer()` — keep the vault alive through multi-
 *       step flows (server settlement, follow-up retries, etc.).
 *
 * Open-coded across six places before this helper existed; one of those
 * places (`wallet:send-transaction`) was missing step 5 and is fixed
 * incidentally by the consolidation.
 */

const {
  loadIdentityModule,
  getWalletRecord,
  isHardwareWalletIndex,
  WALLET_TYPES,
} = require('../identity-manager');
const { resetVaultAutoLockTimer } = require('../vault-timer');
const { VAULT_LOCKED_MESSAGE } = require('./vault-errors');

/**
 * Check that a wallet index is a non-negative integer. dApp IPC handlers
 * accept walletIndex from untrusted renderer code, so guard before
 * passing it to vault derivation.
 *
 * @param {unknown} walletIndex
 * @returns {boolean}
 */
function isValidWalletIndex(walletIndex) {
  return typeof walletIndex === 'number' && Number.isInteger(walletIndex) && walletIndex >= 0;
}

/**
 * Borrow a private key from the vault for a single operation.
 *
 * Throws `Error(VAULT_LOCKED_MESSAGE)` if the vault is locked at call
 * time. Recovery code: use `isVaultLockedError(err)` rather than a
 * literal string compare.
 * Throws `Error('Invalid wallet index')` if the index would not
 * round-trip through vault derivation.
 *
 * Resets the auto-lock timer after the callback resolves; if the
 * callback throws, the timer is *not* reset (preserves the existing
 * per-handler behaviour — only successful operations extend the lease).
 *
 * @template T
 * @param {number} walletIndex
 * @param {(privateKey: string) => T | Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withVaultPrivateKey(walletIndex, callback) {
  if (!isValidWalletIndex(walletIndex)) {
    throw new Error('Invalid wallet index');
  }
  // Hard stop for non-mnemonic accounts at the key-derivation chokepoint:
  // deriving a mnemonic key at a hardware/phone account's index would silently
  // sign with a key whose address the user has never seen.
  //
  // The index-range half of the check stands on its own and must come
  // first: a *deleted* device account has no record at all, and a stale
  // reference to it (dApp permission, publisher identity, an index from
  // untrusted renderer code) would otherwise fall through to derivation
  // at m/44'/60'/<hardware index>'/0/0 — a phantom account.
  const record = getWalletRecord(walletIndex);
  if (isHardwareWalletIndex(walletIndex) || (record && record.type !== WALLET_TYPES.MNEMONIC)) {
    throw new Error('This account keeps its key on another device; sign via its device signer');
  }
  const identity = await loadIdentityModule();
  if (!identity.isUnlocked()) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }
  const privateKey = identity.exportPrivateKey(walletIndex);
  const result = await callback(privateKey);
  resetVaultAutoLockTimer();
  return result;
}

module.exports = { withVaultPrivateKey, isValidWalletIndex };
