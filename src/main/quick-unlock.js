/**
 * Quick Unlock Module
 *
 * Provides Touch ID (macOS) support for quick vault unlock.
 * Stores the vault password in OS secure storage, protected by biometrics.
 */

const { app, ipcMain, systemPreferences, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getIdentityDataDir, getQuickUnlockCredentialPath } = require('./profile-paths');
const { getActiveProfile } = require('./profile-resolver');
const vault = require('./identity/vault');

const CREDENTIAL_VERSION = 2;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function realpathOrResolve(dirPath) {
  try {
    return fs.realpathSync(dirPath);
  } catch {
    return path.resolve(dirPath);
  }
}

function getCurrentBinding() {
  const profile = getActiveProfile();
  const userDataDir = profile?.userDataDir || app.getPath('userData');
  return {
    profileId: profile?.id || 'default',
    userDataDirHash: sha256Hex(realpathOrResolve(userDataDir)),
  };
}

function getVaultFingerprint() {
  const vaultPath = vault.getVaultPath(getIdentityDataDir());
  if (!fs.existsSync(vaultPath)) {
    return null;
  }
  return sha256Hex(fs.readFileSync(vaultPath));
}

function createCredentialPayload(password) {
  const encrypted = safeStorage.encryptString(password);
  const binding = getCurrentBinding();
  const payload = {
    version: CREDENTIAL_VERSION,
    profileId: binding.profileId,
    userDataDirHash: binding.userDataDirHash,
    vaultFingerprint: getVaultFingerprint(),
    encrypted: encrypted.toString('base64'),
    createdAt: new Date().toISOString(),
  };
  return Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');
}

function parseCredential(buffer) {
  try {
    const payload = JSON.parse(buffer.toString('utf-8'));
    if (
      payload?.version === CREDENTIAL_VERSION &&
      typeof payload.encrypted === 'string'
    ) {
      return {
        type: 'bound',
        payload,
        encrypted: Buffer.from(payload.encrypted, 'base64'),
      };
    }
  } catch {
    // Legacy quick-unlock files are raw safeStorage ciphertext buffers.
  }

  return { type: 'legacy', encrypted: buffer };
}

function validateCredentialBinding(payload) {
  const binding = getCurrentBinding();
  if (payload.profileId !== binding.profileId || payload.userDataDirHash !== binding.userDataDirHash) {
    return 'Quick unlock belongs to a different profile';
  }

  const vaultFingerprint = getVaultFingerprint();
  if (!vaultFingerprint || payload.vaultFingerprint !== vaultFingerprint) {
    return 'Quick unlock does not match this vault';
  }

  return null;
}

function writeCredential(password) {
  const credPath = getCredentialPath();
  const dir = path.dirname(credPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(credPath, createCredentialPayload(password), { mode: 0o600 });
  try {
    fs.chmodSync(credPath, 0o600);
  } catch {
    // Best-effort permissions hardening; Windows may ignore POSIX modes.
  }
}

async function verifyCredentialPassword(password) {
  await vault.verifyPassword(getIdentityDataDir(), password);
}

/**
 * Get the path to the credential file
 */
function getCredentialPath() {
  return getQuickUnlockCredentialPath();
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
  if (!fs.existsSync(credPath)) {
    return false;
  }

  const credential = parseCredential(fs.readFileSync(credPath));
  if (credential.type === 'legacy') {
    return true;
  }

  return validateCredentialBinding(credential.payload) === null;
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
    await verifyCredentialPassword(password);

    // Prompt Touch ID to authorize storing the credential
    await systemPreferences.promptTouchID('enable Touch ID unlock for Freedom Browser');

    writeCredential(password);

    console.log('[QuickUnlock] Touch ID unlock enabled');
    return { success: true };
  } catch (err) {
    console.error('[QuickUnlock] Failed to enable:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Touch ID, then the stored vault password — main-internal only. The
 * password never crosses IPC: every caller below finishes the job
 * (unlock, export) in main and returns only its outcome (security audit
 * O-8). Throws on any failure.
 * @returns {Promise<string>}
 */
async function retrievePasswordWithTouchId() {
  if (!canUseTouchId()) {
    throw new Error('Touch ID not available');
  }

  if (!isQuickUnlockEnabled()) {
    throw new Error('Quick unlock not enabled');
  }

  const credPath = getCredentialPath();
  const credential = parseCredential(fs.readFileSync(credPath));
  if (credential.type === 'bound') {
    const bindingError = validateCredentialBinding(credential.payload);
    if (bindingError) {
      throw new Error(bindingError);
    }
  }

  // Prompt for Touch ID
  await systemPreferences.promptTouchID('unlock Freedom Browser');

  const password = safeStorage.decryptString(credential.encrypted);
  await verifyCredentialPassword(password);

  if (credential.type === 'legacy') {
    writeCredential(password);
  }
  return password;
}

// Lazy: identity-manager pulls in the whole identity stack, which this
// module's own callers (and tests) don't otherwise need.
function identityManager() {
  return require('./identity-manager');
}

/**
 * Unlock the vault with Touch ID. Main unlocks the vault itself — exactly
 * what `identity:unlock` does with a typed password — and the renderer
 * learns only whether it worked.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function unlockWithTouchId() {
  try {
    const password = await retrievePasswordWithTouchId();
    await identityManager().unlockVault(password);
    console.log('[QuickUnlock] Unlocked with Touch ID');
    return { success: true };
  } catch (err) {
    console.error('[QuickUnlock] Failed to unlock:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Touch ID in place of the password re-entry `identity:export-mnemonic`
 * asks for. Unlocks the vault (as the password flow does first) and
 * returns the recovery phrase the user asked to see — never the password.
 * @returns {Promise<{success: boolean, mnemonic?: string, error?: string}>}
 */
async function exportMnemonicWithTouchId() {
  try {
    const password = await retrievePasswordWithTouchId();
    const identity = identityManager();
    await identity.unlockVault(password);
    const mnemonic = await identity.exportMnemonic();
    return { success: true, mnemonic };
  } catch (err) {
    console.error('[QuickUnlock] Failed to export recovery phrase:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Touch ID in place of the password re-entry
 * `identity:export-private-key` asks for. Same shape as
 * exportMnemonicWithTouchId.
 * @param {number} accountIndex
 * @returns {Promise<{success: boolean, privateKey?: string, error?: string}>}
 */
async function exportPrivateKeyWithTouchId(accountIndex) {
  try {
    const identity = identityManager();
    // Refuse a device/Safe account before prompting for Touch ID.
    identity.assertPrivateKeyExportable(accountIndex);
    const password = await retrievePasswordWithTouchId();
    await identity.unlockVault(password);
    const privateKey = await identity.exportPrivateKeyForAccount(accountIndex);
    return { success: true, privateKey };
  } catch (err) {
    console.error('[QuickUnlock] Failed to export private key:', err.message);
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

  // Unlock the vault with Touch ID. Returns success/failure only — the
  // stored password never leaves main (security audit O-8).
  ipcMain.handle('quick-unlock:unlock', async () => {
    return unlockWithTouchId();
  });

  // Touch ID instead of the password re-entry for the two export screens.
  ipcMain.handle('quick-unlock:export-mnemonic', async () => {
    return exportMnemonicWithTouchId();
  });

  ipcMain.handle('quick-unlock:export-private-key', async (_event, accountIndex) => {
    return exportPrivateKeyWithTouchId(accountIndex);
  });

  // Disable quick unlock
  ipcMain.handle('quick-unlock:disable', () => {
    return disableQuickUnlock();
  });

  console.log('[QuickUnlock] IPC handlers registered');
}

module.exports = {
  CREDENTIAL_VERSION,
  canUseTouchId,
  isSecureStorageAvailable,
  isQuickUnlockEnabled,
  enableQuickUnlock,
  unlockWithTouchId,
  exportMnemonicWithTouchId,
  exportPrivateKeyWithTouchId,
  disableQuickUnlock,
  registerQuickUnlockIpc,
};
