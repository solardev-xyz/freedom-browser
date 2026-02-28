/**
 * Identity Vault
 *
 * Securely stores and manages the user's mnemonic.
 * - Encrypts mnemonic with user password (AES-GCM via PBKDF2)
 * - Stores encrypted vault in app data directory
 * - Provides lock/unlock interface
 */

import { encrypt, decrypt } from '@metamask/browser-passworder';
import fs from 'fs';
import path from 'path';
import { isValidMnemonic, createMnemonic, deriveUserWallet } from './derivation.js';

// Vault state
let unlockedMnemonic = null;
let autoLockTimer = null;

// Default auto-lock timeout (15 minutes)
const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

/**
 * Get the vault file path
 * @param {string} dataDir - App data directory
 * @returns {string} Path to vault file
 */
export function getVaultPath(dataDir) {
  return path.join(dataDir, 'identity-vault.json');
}

/**
 * Check if a vault exists
 * @param {string} dataDir - App data directory
 * @returns {boolean}
 */
export function vaultExists(dataDir) {
  return fs.existsSync(getVaultPath(dataDir));
}

/**
 * Create a new vault with a generated mnemonic
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {number} strength - Mnemonic strength (128=12 words, 256=24 words)
 * @returns {Promise<string>} The generated mnemonic (for backup display)
 */
export async function createVault(dataDir, password, strength = 256) {
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
export async function importVault(dataDir, password, mnemonic, overwrite = false) {
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

/**
 * Unlock the vault and load mnemonic into memory
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {number} autoLockMs - Auto-lock timeout (0 to disable)
 * @returns {Promise<void>}
 */
export async function unlockVault(dataDir, password, autoLockMs = DEFAULT_AUTO_LOCK_MS) {
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
    unlockedMnemonic = decrypted.mnemonic;

    // Validate decrypted mnemonic
    if (!isValidMnemonic(unlockedMnemonic)) {
      unlockedMnemonic = null;
      throw new Error('Decrypted data is not a valid mnemonic');
    }

    // Set up auto-lock timer
    if (autoLockMs > 0) {
      resetAutoLockTimer(autoLockMs);
    }
  } catch (err) {
    if (err.message.includes('Incorrect password')) {
      throw new Error('Incorrect password');
    }
    throw err;
  }
}

/**
 * Lock the vault (clear mnemonic from memory)
 */
export function lockVault() {
  unlockedMnemonic = null;
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
}

/**
 * Check if vault is unlocked
 * @returns {boolean}
 */
export function isUnlocked() {
  return unlockedMnemonic !== null;
}

/**
 * Get the unlocked mnemonic
 * @returns {string|null} Mnemonic or null if locked
 */
export function getMnemonic() {
  return unlockedMnemonic;
}

/**
 * Reset the auto-lock timer (called on activity)
 * @param {number} autoLockMs - Timeout in milliseconds
 */
export function resetAutoLockTimer(autoLockMs = DEFAULT_AUTO_LOCK_MS) {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
  }

  if (autoLockMs > 0 && unlockedMnemonic) {
    autoLockTimer = setTimeout(() => {
      console.log('[Vault] Auto-locking due to inactivity');
      lockVault();
    }, autoLockMs);
  }
}

/**
 * Change the vault password
 * @param {string} dataDir - App data directory
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 */
export async function changePassword(dataDir, currentPassword, newPassword) {
  // First verify current password by unlocking
  await unlockVault(dataDir, currentPassword, 0);

  if (!unlockedMnemonic) {
    throw new Error('Failed to unlock vault');
  }

  // Re-encrypt with new password
  await saveVault(dataDir, newPassword, unlockedMnemonic);
}

/**
 * Delete the vault (dangerous - requires confirmation)
 * @param {string} dataDir - App data directory
 * @param {string} password - Password to confirm
 */
export async function deleteVault(dataDir, password) {
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
export async function verifyPassword(dataDir, password) {
  if (!vaultExists(dataDir)) {
    throw new Error('No vault found');
  }
  const vaultPath = getVaultPath(dataDir);
  const vaultData = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'));
  try {
    await decrypt(password, vaultData.encrypted);
  } catch (err) {
    if (err.message.includes('Incorrect password')) {
      throw new Error('Incorrect password');
    }
    throw err;
  }
}

/**
 * Export mnemonic (for backup)
 * Vault must be unlocked
 * @returns {string} The mnemonic
 */
export function exportMnemonic() {
  if (!unlockedMnemonic) {
    throw new Error('Vault is locked');
  }
  return unlockedMnemonic;
}

/**
 * Export private key for a specific wallet account
 * Vault must be unlocked
 * @param {number} accountIndex - Account index (0, 1, 2, ...)
 * @returns {string} The private key (0x-prefixed hex)
 */
export function exportPrivateKey(accountIndex = 0) {
  if (!unlockedMnemonic) {
    throw new Error('Vault is locked');
  }
  const wallet = deriveUserWallet(unlockedMnemonic, accountIndex);
  return wallet.privateKey;
}
