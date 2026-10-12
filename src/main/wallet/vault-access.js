/**
 * Vault account access helper.
 *
 * Every caller that signs with a vault account — the signer factory, and
 * through it wallet IPC, the x402 client and Safe owners — performs the
 * same sequence:
 *
 *   1. Guard the account record (no device or Safe accounts).
 *   2. Hand the operation the account's key *reference*; the identity core
 *      signs with the key and never returns it (freedom-core design 0002).
 *      A locked vault is refused with VAULT_LOCKED_MESSAGE.
 *   3. `resetVaultAutoLockTimer()` after success — keep the vault alive
 *      through multi-step flows (server settlement, follow-up retries).
 */

const { getWalletRecord, isHardwareWalletIndex, WALLET_TYPES } = require('../identity-manager');
const { resetVaultAutoLockTimer } = require('../vault-timer');

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
 * Run one operation on a vault (mnemonic) account.
 *
 * `operation` receives the account's key reference for the identity core,
 * `{ kind: 'account', index }`. Throws `Error('Invalid wallet index')` for
 * an index that would not round-trip through vault derivation, and refuses
 * device accounts before anything reaches the core. A locked vault fails
 * inside the operation with VAULT_LOCKED_MESSAGE; check with
 * `isVaultLockedError(err)`.
 *
 * Resets the auto-lock timer after the operation resolves; if it throws,
 * the timer is *not* reset (only successful operations extend the lease).
 *
 * @template T
 * @param {number} walletIndex
 * @param {(key: {kind: 'account', index: number}) => T | Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withVaultAccount(walletIndex, operation) {
  if (!isValidWalletIndex(walletIndex)) {
    throw new Error('Invalid wallet index');
  }
  // Hard stop for non-mnemonic accounts: signing with a mnemonic key at a
  // hardware/phone account's index would silently use a key whose address
  // the user has never seen.
  //
  // The index-range half of the check stands on its own and must come
  // first: a *deleted* device account has no record at all, and a stale
  // reference to it (dApp permission, publisher identity, an index from
  // untrusted renderer code) would otherwise reach derivation at
  // m/44'/60'/<hardware index>'/0/0 — a phantom account.
  const record = getWalletRecord(walletIndex);
  if (isHardwareWalletIndex(walletIndex) || (record && record.type !== WALLET_TYPES.MNEMONIC)) {
    throw new Error('This account keeps its key on another device; sign via its device signer');
  }
  const result = await operation({ kind: 'account', index: walletIndex });
  resetVaultAutoLockTimer();
  return result;
}

module.exports = { withVaultAccount, isValidWalletIndex };
