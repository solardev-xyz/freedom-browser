/**
 * Vault Auto-Lock Timer Helper
 *
 * Resets the vault auto-lock timer after successful operations that
 * require the vault to be unlocked. Keeps the vault alive as long
 * as dapps are actively using it.
 */

function resetVaultAutoLockTimer() {
  try {
    const identity = require('./identity');
    if (identity.isUnlocked()) {
      identity.resetAutoLockTimer();
    }
  } catch {
    // Non-critical — vault module may not be loaded yet
  }
}

module.exports = { resetVaultAutoLockTimer };
