/**
 * Identity Vault
 *
 * Securely stores and manages the user's mnemonic and optional BIP-39 passphrase.
 * - Encrypts them with user password (AES-GCM via PBKDF2)
 * - Stores encrypted vault in app data directory
 * - Provides lock/unlock interface
 */

const { encrypt, decrypt } = require('@metamask/browser-passworder');
const fs = require('fs');
const path = require('path');
const {
  isValidMnemonic,
  createMnemonic,
  deriveUserWallet,
  deriveWalletAtPath,
} = require('./derivation');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');

// Vault state: { mnemonic, passphrase } while unlocked
let unlockedSecret = null;
let autoLockTimer = null;

// A vault holding a passphrase gets its own version, so a build that doesn't
// understand passphrases refuses it instead of opening a different, empty wallet
// from the words alone. Every other vault stays readable by those builds.
const VAULT_VERSION = 1;
const VAULT_VERSION_WITH_PASSPHRASE = 2;
const READABLE_VAULT_VERSIONS = [VAULT_VERSION, VAULT_VERSION_WITH_PASSPHRASE];

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
  await saveVault(dataDir, password, { mnemonic });

  return mnemonic;
}

/**
 * Import an existing mnemonic into a new vault
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {string} mnemonic - The mnemonic to import
 * @param {boolean} overwrite - Whether to overwrite existing vault
 * @param {string} passphrase - BIP-39 passphrase, as typed ('' for none)
 */
async function importVault(dataDir, password, mnemonic, overwrite = false, passphrase = '') {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  if (typeof passphrase !== 'string') {
    throw new Error('Passphrase must be text');
  }

  if (vaultExists(dataDir) && !overwrite) {
    throw new Error('Vault already exists. Set overwrite=true to replace.');
  }

  await saveVault(dataDir, password, { mnemonic, passphrase });
}

/**
 * Save the seed to the vault file. A vault with no passphrase is written
 * exactly as it was before passphrases existed.
 * @private
 * @param {string} dataDir
 * @param {string} password
 * @param {{mnemonic: string, passphrase?: string}} secret
 */
async function saveVault(dataDir, password, { mnemonic, passphrase = '' }) {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Encrypt the seed
  const encrypted = await encrypt(password, passphrase ? { mnemonic, passphrase } : { mnemonic });

  // Save to file
  const vaultPath = getVaultPath(dataDir);
  const vaultData = {
    version: passphrase ? VAULT_VERSION_WITH_PASSPHRASE : VAULT_VERSION,
    encrypted,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(vaultPath, JSON.stringify(vaultData, null, 2));
}

/**
 * Unlock the vault and load the seed into memory
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {number} autoLockMs - Auto-lock timeout (0 to disable)
 * @returns {Promise<void>}
 */
async function unlockVault(dataDir, password, autoLockMs = DEFAULT_AUTO_LOCK_MS) {
  if (!vaultExists(dataDir)) {
    throw new Error('No vault found. Create one first.');
  }

  const vaultPath = getVaultPath(dataDir);
  const vaultData = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'));

  if (!READABLE_VAULT_VERSIONS.includes(vaultData.version)) {
    throw new Error(`Unsupported vault version: ${vaultData.version}`);
  }

  try {
    const decrypted = await decrypt(password, vaultData.encrypted);

    // Validate decrypted mnemonic
    if (!isValidMnemonic(decrypted.mnemonic)) {
      unlockedSecret = null;
      throw new Error('Decrypted data is not a valid mnemonic');
    }
    unlockedSecret = Object.freeze({
      mnemonic: decrypted.mnemonic,
      passphrase: decrypted.passphrase ?? '',
    });

    // Set up auto-lock timer
    if (autoLockMs > 0) {
      resetAutoLockTimer(autoLockMs);
    }
  } catch (err) {
    if (err.message.includes('Incorrect password')) {
      throw new Error('Incorrect password', { cause: err });
    }
    throw err;
  }
}

/**
 * Lock the vault (clear the seed from memory)
 */
function lockVault() {
  unlockedSecret = null;
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
}

/**
 * Check if vault is unlocked
 * @returns {boolean}
 */
function isUnlocked() {
  return unlockedSecret !== null;
}

/**
 * The unlocked seed, for deriving keys. There's deliberately no getter for the
 * words alone: deriving from them would silently give a different wallet when
 * the seed has a passphrase.
 * @returns {{mnemonic: string, passphrase: string}|null} Null if locked
 */
function getSeedSecret() {
  return unlockedSecret;
}

/**
 * Reset the auto-lock timer (called on activity)
 * @param {number} autoLockMs - Timeout in milliseconds
 */
function resetAutoLockTimer(autoLockMs = DEFAULT_AUTO_LOCK_MS) {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
  }

  if (autoLockMs > 0 && unlockedSecret) {
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
  // First verify current password by unlocking
  await unlockVault(dataDir, currentPassword, 0);

  if (!unlockedSecret) {
    throw new Error('Failed to unlock vault');
  }

  // Re-encrypt with new password
  await saveVault(dataDir, newPassword, unlockedSecret);
}

/**
 * Delete the vault (dangerous - requires confirmation)
 * @param {string} dataDir - App data directory
 * @param {string} password - Password to confirm
 */
async function deleteVault(dataDir, password) {
  // Verify password first
  await unlockVault(dataDir, password, 0);
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
  if (!vaultExists(dataDir)) {
    throw new Error('No vault found');
  }
  const vaultPath = getVaultPath(dataDir);
  const vaultData = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'));
  try {
    await decrypt(password, vaultData.encrypted);
  } catch (err) {
    if (err.message.includes('Incorrect password')) {
      throw new Error('Incorrect password', { cause: err });
    }
    throw err;
  }
}

/**
 * Export what's needed to restore this wallet (for backup). The words alone
 * would restore a different wallet when the seed has a passphrase.
 * Vault must be unlocked
 * @returns {{mnemonic: string, passphrase: string}}
 */
function exportRecoveryPhrase() {
  if (!unlockedSecret) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }
  return { ...unlockedSecret };
}

/**
 * Export private key for a specific wallet account
 * Vault must be unlocked
 * @param {number} accountIndex - Account index (0, 1, 2, ...)
 * @param {string} [path] - The account's stored derivation path, when it has one
 * @returns {string} The private key (0x-prefixed hex)
 */
function exportPrivateKey(accountIndex = 0, path) {
  if (!unlockedSecret) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }
  const wallet = path
    ? deriveWalletAtPath(unlockedSecret, path)
    : deriveUserWallet(unlockedSecret, accountIndex);
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
  getSeedSecret,
  resetAutoLockTimer,
  changePassword,
  deleteVault,
  exportRecoveryPhrase,
  exportPrivateKey,
  verifyPassword,
};
