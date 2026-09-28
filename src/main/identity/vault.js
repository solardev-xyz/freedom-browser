/**
 * Identity Vault
 *
 * Securely stores and manages the user's mnemonic.
 * - Encrypts mnemonic with user password (AES-GCM via PBKDF2)
 * - Stores encrypted vault in app data directory
 * - Provides lock/unlock interface
 */

const { encrypt, decrypt } = require('@metamask/browser-passworder');
const fs = require('fs');
const path = require('path');
const { isValidMnemonic, createMnemonic, deriveUserWallet } = require('./derivation');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');

// Vault state
let unlockedMnemonic = null;
let autoLockTimer = null;
let lockGeneration = 0;
let sessionController = new AbortController();
sessionController.abort();

// Main-only lifetime capability. Every lock path revokes the old signal;
// unlocking never makes an old signal live again.
function getSessionSignal() {
  return sessionController.signal;
}

// Default auto-lock timeout (15 minutes)
const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

/**
 * Get the vault file path
 * @param {string} dataDir - App data directory
 * @returns {string} Path to vault file
 */
function getVaultPath(dataDir) {
  return path.join(dataDir, 'identity-vault.json');
}

/**
 * Check if a vault exists
 * @param {string} dataDir - App data directory
 * @returns {boolean}
 */
function vaultExists(dataDir) {
  return fs.existsSync(getVaultPath(dataDir));
}

/**
 * Create a new vault with a generated mnemonic
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {number} strength - Mnemonic strength (128=12 words, 256=24 words)
 * @returns {Promise<string>} The generated mnemonic (for backup display)
 */
async function createVault(dataDir, password, strength = 256) {
  if (vaultExists(dataDir)) {
    throw new Error('Vault already exists. Use importVault to replace.');
  }

  const mnemonic = createMnemonic(strength);
  await saveVault(dataDir, password, mnemonic);

  return mnemonic;
}

/**
 * Import an existing mnemonic into a new vault
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {string} mnemonic - The mnemonic to import
 * @param {boolean} overwrite - Whether to overwrite existing vault
 */
async function importVault(dataDir, password, mnemonic, overwrite = false) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  if (vaultExists(dataDir) && !overwrite) {
    throw new Error('Vault already exists. Set overwrite=true to replace.');
  }

  await saveVault(dataDir, password, mnemonic);
}

/**
 * Save mnemonic to vault file
 * @private
 */
async function saveVault(dataDir, password, mnemonic) {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Encrypt mnemonic
  const encrypted = await encrypt(password, { mnemonic });

  // Save to file
  const vaultPath = getVaultPath(dataDir);
  const vaultData = {
    version: 1,
    encrypted,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(vaultPath, JSON.stringify(vaultData, null, 2));
}

// Verify/decrypt without changing the vault session or its auto-lock timer.
async function decryptVaultMnemonic(dataDir, password) {
  if (!vaultExists(dataDir)) {
    throw new Error('No vault found. Create one first.');
  }

  const vaultPath = getVaultPath(dataDir);
  const vaultData = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'));

  if (vaultData.version !== 1) {
    throw new Error(`Unsupported vault version: ${vaultData.version}`);
  }

  try {
    const decrypted = await decrypt(password, vaultData.encrypted);
    if (!isValidMnemonic(decrypted.mnemonic)) {
      throw new Error('Decrypted data is not a valid mnemonic');
    }
    return decrypted.mnemonic;
  } catch (err) {
    if (err.message.includes('Incorrect password')) {
      throw new Error('Incorrect password', { cause: err });
    }
    throw err;
  }
}

/**
 * Unlock the vault and load mnemonic into memory
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {number} autoLockMs - Auto-lock timeout (0 to disable)
 * @returns {Promise<void>}
 */
async function unlockVault(dataDir, password, autoLockMs = DEFAULT_AUTO_LOCK_MS) {
  const startedGeneration = lockGeneration;
  const mnemonic = await decryptVaultMnemonic(dataDir, password);
  if (startedGeneration !== lockGeneration) throw new Error('Vault unlock cancelled by a newer session');
  // Only an explicit unlock replaces the lifetime and inactivity timer.
  lockVault();
  unlockedMnemonic = mnemonic;
  sessionController = new AbortController();
  resetAutoLockTimer(autoLockMs);
}

/**
 * Lock the vault (clear mnemonic from memory)
 */
function lockVault() {
  lockGeneration += 1;
  unlockedMnemonic = null;
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  sessionController.abort();
}

/**
 * Check if vault is unlocked
 * @returns {boolean}
 */
function isUnlocked() {
  return unlockedMnemonic !== null;
}

/**
 * Get the unlocked mnemonic
 * @returns {string|null} Mnemonic or null if locked
 */
function getMnemonic() {
  return unlockedMnemonic;
}

/**
 * Reset the auto-lock timer (called on activity)
 * @param {number} autoLockMs - Timeout in milliseconds
 */
function resetAutoLockTimer(autoLockMs = DEFAULT_AUTO_LOCK_MS) {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
  }

  if (autoLockMs > 0 && unlockedMnemonic) {
    autoLockTimer = setTimeout(() => {
      console.log('[Vault] Auto-locking due to inactivity');
      lockVault();
    }, autoLockMs);
    // Don't keep the event loop alive solely for this timer. Production
    // Electron stays running via windows / IPC handles, so the timer still
    // fires normally; in Jest, the worker can exit cleanly once tests finish
    // without waiting for a pending auto-lock to elapse.
    autoLockTimer.unref();
  }
}

/**
 * Change the vault password
 * @param {string} dataDir - App data directory
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 */
async function changePassword(dataDir, currentPassword, newPassword) {
  // Password verification must preserve the existing lock state, deadline and
  // privacy-session signal, including an auto-lock during re-encryption.
  const mnemonic = await decryptVaultMnemonic(dataDir, currentPassword);
  await saveVault(dataDir, newPassword, mnemonic);
}

/**
 * Delete the vault (dangerous - requires confirmation)
 * @param {string} dataDir - App data directory
 * @param {string} password - Password to confirm
 */
async function deleteVault(dataDir, password) {
  // Verify password first
  await verifyPassword(dataDir, password);
  lockVault();

  // Delete vault file
  const vaultPath = getVaultPath(dataDir);
  if (fs.existsSync(vaultPath)) {
    fs.unlinkSync(vaultPath);
  }
}

/**
 * Verify a password against the vault without mutating state.
 * Used for gating sensitive exports (private key, mnemonic).
 * @param {string} dataDir - App data directory
 * @param {string} password - Password to verify
 * @throws {Error} If password is incorrect or vault doesn't exist
 */
async function verifyPassword(dataDir, password) {
  await decryptVaultMnemonic(dataDir, password);
}

/**
 * Export mnemonic (for backup)
 * Vault must be unlocked
 * @returns {string} The mnemonic
 */
function exportMnemonic() {
  if (!unlockedMnemonic) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }
  return unlockedMnemonic;
}

/**
 * Export private key for a specific wallet account
 * Vault must be unlocked
 * @param {number} accountIndex - Account index (0, 1, 2, ...)
 * @returns {string} The private key (0x-prefixed hex)
 */
function exportPrivateKey(accountIndex = 0) {
  if (!unlockedMnemonic) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }
  const wallet = deriveUserWallet(unlockedMnemonic, accountIndex);
  return wallet.privateKey;
}

module.exports = {
  getVaultPath,
  vaultExists,
  createVault,
  importVault,
  unlockVault,
  lockVault,
  isUnlocked,
  getSessionSignal,
  getMnemonic,
  resetAutoLockTimer,
  changePassword,
  deleteVault,
  exportMnemonic,
  exportPrivateKey,
  verifyPassword,
};
