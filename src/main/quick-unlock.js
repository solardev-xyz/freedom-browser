/**
 * Quick Unlock Module
 *
 * Provides Touch ID (macOS) support for quick vault unlock.
 * Stores the vault password in OS secure storage, protected by biometrics.
 */

const { ipcMain, systemPreferences, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Storage key for the encrypted credential
const CREDENTIAL_FILE = 'quick-unlock.dat';

/**
 * Get the path to the credential file
 */
function getCredentialPath() {
  if (!app.isPackaged) {
    return path.join(__dirname, '..', '..', 'identity-data', CREDENTIAL_FILE);
  }
  return path.join(app.getPath('userData'), 'identity', CREDENTIAL_FILE);
}

/**
 * Check if Touch ID is available on this system
 * @returns {boolean}
 */
function canUseTouchId() {
  if (process.platform !== 'darwin') {
    return false;
  }
  return systemPreferences.canPromptTouchID();
}

/**
 * Check if secure storage is available
 * @returns {boolean}
 */
function isSecureStorageAvailable() {
  return safeStorage.isEncryptionAvailable();
}

/**
 * Check if quick unlock is enabled (credential exists)
 * @returns {boolean}
 */
function isQuickUnlockEnabled() {
  const credPath = getCredentialPath();
  return fs.existsSync(credPath);
}

/**
 * Enable quick unlock by storing the password
 * Prompts for Touch ID to authorize storage
 * @param {string} password - The vault password to store
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function enableQuickUnlock(password) {
  if (!canUseTouchId()) {
    return { success: false, error: 'Touch ID not available' };
  }

  if (!isSecureStorageAvailable()) {
    return { success: false, error: 'Secure storage not available' };
  }

  try {
    // Prompt Touch ID to authorize storing the credential
    await systemPreferences.promptTouchID('enable Touch ID unlock for Freedom Browser');

    // Encrypt the password using OS secure storage
    const encrypted = safeStorage.encryptString(password);

    // Ensure directory exists
    const credPath = getCredentialPath();
    const dir = path.dirname(credPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Store encrypted credential
    fs.writeFileSync(credPath, encrypted);

    console.log('[QuickUnlock] Touch ID unlock enabled');
    return { success: true };
  } catch (err) {
    console.error('[QuickUnlock] Failed to enable:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Retrieve password using Touch ID
 * @returns {Promise<{success: boolean, password?: string, error?: string}>}
 */
async function unlockWithTouchId() {
  if (!canUseTouchId()) {
    return { success: false, error: 'Touch ID not available' };
  }

  if (!isQuickUnlockEnabled()) {
    return { success: false, error: 'Quick unlock not enabled' };
  }

  try {
    // Prompt for Touch ID
    await systemPreferences.promptTouchID('unlock Freedom Browser');

    // Read and decrypt the credential
    const credPath = getCredentialPath();
    const encrypted = fs.readFileSync(credPath);
    const password = safeStorage.decryptString(encrypted);

    console.log('[QuickUnlock] Unlocked with Touch ID');
    return { success: true, password };
  } catch (err) {
    console.error('[QuickUnlock] Failed to unlock:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Disable quick unlock by removing stored credential
 * @returns {{success: boolean, error?: string}}
 */
function disableQuickUnlock() {
  try {
    const credPath = getCredentialPath();
    if (fs.existsSync(credPath)) {
      fs.unlinkSync(credPath);
    }
    console.log('[QuickUnlock] Touch ID unlock disabled');
    return { success: true };
  } catch (err) {
    console.error('[QuickUnlock] Failed to disable:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Register IPC handlers for quick unlock
 */
function registerQuickUnlockIpc() {
  // Check if Touch ID is available
  ipcMain.handle('quick-unlock:can-use-touch-id', () => {
    return canUseTouchId();
  });

  // Check if quick unlock is enabled
  ipcMain.handle('quick-unlock:is-enabled', () => {
    return isQuickUnlockEnabled();
  });

  // Enable quick unlock (store password)
  ipcMain.handle('quick-unlock:enable', async (_event, password) => {
    return enableQuickUnlock(password);
  });

  // Unlock with Touch ID (retrieve password)
  ipcMain.handle('quick-unlock:unlock', async () => {
    return unlockWithTouchId();
  });

  // Disable quick unlock
  ipcMain.handle('quick-unlock:disable', () => {
    return disableQuickUnlock();
  });

  console.log('[QuickUnlock] IPC handlers registered');
}

module.exports = {
  canUseTouchId,
  isSecureStorageAvailable,
  isQuickUnlockEnabled,
  enableQuickUnlock,
  unlockWithTouchId,
  disableQuickUnlock,
  registerQuickUnlockIpc,
};
