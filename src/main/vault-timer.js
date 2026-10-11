/**
 * Vault Auto-Lock Timer Helper
 *
 * Resets the vault auto-lock timer after successful operations that
 * require the vault to be unlocked. Keeps the vault alive as long
 * as dapps are actively using it.
 */

function resetVaultAutoLockTimer() {
  try {
    // vault.touch: restarts the core's auto-lock timer if unlocked; sent
    // without waiting for the reply.
    require('./core/vault-backend').vaultBackend.touch();
  } catch {
    // Non-critical — the core may not be running yet
  }
}

module.exports = { resetVaultAutoLockTimer };
