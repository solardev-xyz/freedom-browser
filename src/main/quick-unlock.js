/**
 * Quick Unlock Module
 *
 * Touch ID (macOS) in front of the vault password (freedom-core design 0013,
 * "The re-wrap", step PRF-2b).
 *
 * - **The credential is the core's.** `quick_unlock.enroll` writes the vault
 *   password into the core's key store, and `quick_unlock.unlock` and the
 *   two exports use it after main's Touch ID prompt, so the password stays
 *   in the core. A password change re-wraps it in the core, and Quick Setup
 *   creates the vault with it (`quick_unlock: true`).
 * - **quick-unlock.dat** is the credential every earlier build reads: the
 *   password under Electron's `safeStorage`, bound to the profile and the
 *   vault file. Quick Setup and enable still write it, for those builds.
 *   Nothing here rewrites one that exists (a legacy one stays legacy), and
 *   only disable removes it, together with the core's.
 * - **The migration:** a profile with only quick-unlock.dat unlocks (or
 *   exports) through it once, as before, and main then enrolls the password
 *   it unsealed. A core credential whose key is gone (`not_found`,
 *   `invalidated`) or whose entry doesn't open goes through the file the
 *   same way, and the enroll replaces it.
 */

const { app, ipcMain, systemPreferences, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getIdentityDataDir, getQuickUnlockCredentialPath } = require('./profile-paths');
const { getActiveProfile } = require('./profile-resolver');
const { vaultBackend } = require('./core/vault-backend');
const { withPrivateDir } = require('./private-files');

// The vault file in the identity directory. Its hash binds a credential to
// this vault; the file is encrypted, so main reads it itself (the core
// writes it), through the identity directory's handle (K-3).
const VAULT_FILE = 'identity-vault.json';

const CREDENTIAL_VERSION = 2;

const UNLOCK_PROMPT = 'unlock Freedom Browser';

// The core's credential can't be used, but enrolling again replaces it:
// its key is gone or invalidated, or its entry doesn't open.
const DEAD_CREDENTIAL = new Set(['not_found', 'invalidated', 'entry_refused']);

// Where the core has a key store for quick unlock (cored 0.17.0: macOS).
const KEY_STORE_PLATFORMS = new Set(['darwin']);

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

// The credential and the vault live in the identity directory. Every read
// of either, and every write of the credential, goes through a handle on it
// (private-files.js): never through a link planted at the name or a swapped
// directory, never waiting on a FIFO; the credential is written by an
// atomic 0600 replace (K-3).
function withCredentialDir(use) {
  return withPrivateDir(path.dirname(getCredentialPath()), use);
}

function getVaultFingerprint() {
  const bytes = withPrivateDir(getIdentityDataDir(), (dir) => dir.read(VAULT_FILE));
  return bytes ? sha256Hex(bytes) : null;
}

/**
 * The stored credential, parsed; null when there is none.
 * @throws {UnsafePrivatePathError} a link or anything but our regular file
 */
function readCredential() {
  const credPath = getCredentialPath();
  const bytes = withCredentialDir((dir) => dir.read(path.basename(credPath)));
  return bytes ? parseCredential(bytes) : null;
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
  const payload = createCredentialPayload(password);
  withCredentialDir((dir) => dir.write(path.basename(getCredentialPath()), payload));
}

async function verifyCredentialPassword(password) {
  // Shares the core's unlock throttle (design 0001).
  await vaultBackend.verifyPassword(password);
}

/**
 * Get the path to the credential file
 */
function getCredentialPath() {
  return getQuickUnlockCredentialPath();
}

/**
 * quick-unlock.dat, when it can unlock this vault: a legacy credential, or
 * a bound one whose profile and vault match. Null otherwise, also for a
 * credential or vault that is a link or not our regular file.
 */
function usableFileCredential() {
  try {
    const credential = readCredential();
    if (!credential) return null;
    if (credential.type === 'bound' && validateCredentialBinding(credential.payload) !== null) {
      return null;
    }
    return credential;
  } catch (err) {
    console.warn('[QuickUnlock] quick-unlock.dat unavailable:', err.message);
    return null;
  }
}

/** Whether the core holds quick unlock's credential for this vault. */
async function coreCredential() {
  try {
    return (await vaultBackend.quickUnlockStatus()).enabled === true;
  } catch (err) {
    console.warn('[QuickUnlock] Quick unlock status unavailable:', err.message);
    return false;
  }
}

function isDeadCredential(err) {
  return err?.code === 'key_store_unavailable' && DEAD_CREDENTIAL.has(err.data?.reason);
}

/**
 * Hands the core a password main already has, for quick unlock's
 * credential (`quick_unlock.enroll`, which checks it first). A failure is
 * logged: the caller's own step has succeeded, and the next one through
 * quick-unlock.dat tries again.
 * @returns {Promise<boolean>} whether the core holds it now
 */
async function enroll(password) {
  try {
    await vaultBackend.quickUnlockEnroll(password);
    console.log('[QuickUnlock] Quick unlock is in the core');
    return true;
  } catch (err) {
    console.error('[QuickUnlock] Quick unlock not moved into the core:', err.message);
    return false;
  }
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
 * Whether quick unlock is on for this vault: the core holds its credential,
 * or quick-unlock.dat can still unlock it (until the migration).
 * @returns {Promise<boolean>}
 */
async function isQuickUnlockEnabled() {
  if (await coreCredential()) return true;
  return usableFileCredential() !== null;
}

/**
 * Enable quick unlock for a password the user typed. Prompts for Touch ID
 * to authorize it, then hands the password to the core, and writes
 * quick-unlock.dat for older builds.
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

    await vaultBackend.quickUnlockEnroll(password);
    // The user's own choice replaces a lost Quick Setup's pending one.
    cancelPendingSetup();
    writeCredentialForOlderBuilds(password);

    console.log('[QuickUnlock] Touch ID unlock enabled');
    return { success: true };
  } catch (err) {
    console.error('[QuickUnlock] Failed to enable:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * quick-unlock.dat for the builds before the core held the credential. The
 * core has it already, so a failure here is logged, not answered.
 */
function writeCredentialForOlderBuilds(password) {
  try {
    writeCredential(password);
    return true;
  } catch (err) {
    console.error('[QuickUnlock] quick-unlock.dat not written for older builds:', err.message);
    return false;
  }
}

/**
 * Quick Setup (design 0013, PRF-2b): Touch ID first, then a vault for
 * `mnemonic` under a random password nobody sees, created with quick
 * unlock's credential in the core (`quick_unlock: true`), so the vault never
 * exists without it. quick-unlock.dat is written after, for older builds.
 *
 * Nothing the core committed is ever deleted here: a refusal comes before
 * any vault is written, and a failure after the commit leaves the vault
 * with its credential.
 * @param {string} mnemonic
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function quickSetup(mnemonic) {
  if (!canUseTouchId()) {
    return { success: false, error: 'Touch ID not available' };
  }
  // quick-unlock.dat is the only copy an older build can use: Quick Setup
  // still needs it written (0013: "still writes quick-unlock.dat").
  if (!isSecureStorageAvailable()) {
    return { success: false, error: 'Secure storage not available' };
  }

  try {
    await systemPreferences.promptTouchID('set up Freedom Browser with Touch ID');
    const password = crypto.randomBytes(32).toString('hex');
    await identityManager().importExistingMnemonic(password, mnemonic, false, {
      quickUnlock: true,
    });
    if (!writeCredentialForOlderBuilds(password)) {
      // Kept and retried, as for a lost Quick Setup.
      void completeQuickSetup(password);
    }
    console.log('[QuickUnlock] Quick Setup done');
    return { success: true };
  } catch (err) {
    console.error('[QuickUnlock] Quick Setup failed:', err.message);
    return { success: false, error: err.message };
  }
}

// A lost Quick Setup's password until it is stored (see completeQuickSetup).
let pendingSetup = null;
const SETUP_RETRY_MS = 30_000;

/**
 * Stores a Quick Setup vault's random password as quick-unlock.dat, for a
 * setup the core confirmed only after its reply was lost (freedom-core design
 * 0001, "Reconciliation"). The core wrote its own credential with the vault;
 * this file is for older builds. The onboarding renderer that started it may
 * be gone and nobody else knows this password, so main finishes the setup the
 * user chose. Main-internal only.
 *
 * Until the credential is stored, main keeps the password and retries
 * (secure storage or the core may come back). It stops only when the vault
 * no longer takes the password: it was replaced or deleted. Other vault
 * operations aren't held up meanwhile, so a restore still works.
 * @returns {Promise<boolean>} whether it was stored now
 */
async function completeQuickSetup(password) {
  if (pendingSetup) clearTimeout(pendingSetup.timer);
  pendingSetup = { password, timer: null };
  return trySetupCredential(pendingSetup);
}

/** Drops a lost Quick Setup's retained password; an attempt in flight won't write. */
function cancelPendingSetup() {
  if (!pendingSetup) return;
  clearTimeout(pendingSetup.timer);
  pendingSetup = null;
}

async function trySetupCredential(setup) {
  try {
    if (!isSecureStorageAvailable()) throw new Error('Secure storage not available');
    await verifyCredentialPassword(setup.password);
    if (pendingSetup !== setup) return false; // superseded meanwhile
    writeCredential(setup.password);
    pendingSetup = null;
    console.log('[QuickUnlock] Quick Setup credential stored after reconciliation');
    return true;
  } catch (err) {
    if (pendingSetup !== setup) return false;
    if (err.code === 'incorrect_password' || err.code === 'no_vault') {
      // The vault this password belonged to is gone.
      pendingSetup = null;
      console.error('[QuickUnlock] Lost Quick Setup credential dropped:', err.message);
      return false;
    }
    console.error('[QuickUnlock] Quick Setup credential not stored yet:', err.message);
    setup.timer = setTimeout(() => void trySetupCredential(setup), SETUP_RETRY_MS);
    setup.timer.unref?.();
    return false;
  }
}

/**
 * Touch ID, then `job` — main-internal only. The password never crosses
 * IPC: each job finishes in main (unlock, export) and returns only its
 * outcome (security audit O-8). Throws on any failure.
 *
 * - With the core's credential, `job.core()` runs: the password stays in
 *   the core.
 * - Otherwise, or when the core's credential is dead (`DEAD_CREDENTIAL`),
 *   quick-unlock.dat is unsealed and `job.file(password)` runs, as before;
 *   then main enrolls that password, so the next time goes through the
 *   core. The file isn't written.
 * @param {{core: () => Promise<any>, file: (password: string) => Promise<any>}} job
 */
async function withTouchId(job) {
  if (!canUseTouchId()) {
    throw new Error('Touch ID not available');
  }

  const inCore = await coreCredential();
  const credential = inCore ? null : usableFileCredential();
  if (!inCore && !credential) {
    throw new Error('Quick unlock not enabled');
  }

  await systemPreferences.promptTouchID(UNLOCK_PROMPT);

  if (inCore) {
    try {
      return await job.core();
    } catch (err) {
      const fallback = isDeadCredential(err) ? usableFileCredential() : null;
      if (!fallback) throw err;
      console.warn('[QuickUnlock] The core credential is unusable; using quick-unlock.dat:', err.data.reason);
      return throughFile(fallback, job);
    }
  }
  return throughFile(credential, job);
}

async function throughFile(credential, job) {
  const password = safeStorage.decryptString(credential.encrypted);
  const result = await job.file(password);
  await enroll(password);
  return result;
}

// Lazy: identity-manager pulls in the whole identity stack, which this
// module's own callers (and tests) don't otherwise need.
function identityManager() {
  return require('./identity-manager');
}

/**
 * Unlock the vault with Touch ID. Main unlocks the vault itself, and the
 * renderer learns only whether it worked.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function unlockWithTouchId() {
  try {
    const identity = identityManager();
    await withTouchId({
      core: () => identity.quickUnlockVault(),
      file: (password) => identity.unlockVault(password),
    });
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
    const identity = identityManager();
    const mnemonic = await withTouchId({
      core: () => identity.quickExportMnemonic(),
      file: async (password) => {
        await identity.unlockVault(password);
        return identity.exportMnemonic(password);
      },
    });
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
    const privateKey = await withTouchId({
      core: () => identity.quickExportPrivateKeyForAccount(accountIndex),
      file: async (password) => {
        await identity.unlockVault(password);
        return identity.exportPrivateKeyForAccount(accountIndex, password);
      },
    });
    return { success: true, privateKey };
  } catch (err) {
    console.error('[QuickUnlock] Failed to export private key:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * A password change that keeps quick unlock (0013's deviation
 * `quick-unlock-password-change`). The core re-wraps its own credential in
 * the change. A profile still on quick-unlock.dat alone would lose it, as
 * the file is bound to the vault being replaced: main enrolls the new
 * password once the change is done. The file isn't written.
 * @param {string} currentPassword
 * @param {string} newPassword
 */
async function changePasswordKeepingQuickUnlock(currentPassword, newPassword) {
  const enrollAfter =
    KEY_STORE_PLATFORMS.has(process.platform) &&
    usableFileCredential() !== null &&
    !(await coreCredential());
  await vaultBackend.changePassword(currentPassword, newPassword);
  if (enrollAfter) await enroll(newPassword);
}

/**
 * Disable quick unlock: removes quick-unlock.dat, then the core's
 * credential (whose key the core then forgets). In that order, so a failure
 * never leaves the file to bring the core's credential back at the next
 * Touch ID unlock.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function disableQuickUnlock() {
  // A lost Quick Setup's retry must not bring the credential back.
  cancelPendingSetup();
  try {
    withCredentialDir((dir) => dir.remove(path.basename(getCredentialPath())));
    await vaultBackend.quickUnlockDisable();
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

  // Quick Setup: Touch ID, then a vault for the mnemonic with quick unlock.
  // The random password is made in main and never leaves it.
  ipcMain.handle('quick-unlock:quick-setup', async (_event, mnemonic) => {
    return quickSetup(mnemonic);
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
  completeQuickSetup,
  canUseTouchId,
  isSecureStorageAvailable,
  isQuickUnlockEnabled,
  enableQuickUnlock,
  quickSetup,
  unlockWithTouchId,
  exportMnemonicWithTouchId,
  exportPrivateKeyWithTouchId,
  changePasswordKeepingQuickUnlock,
  disableQuickUnlock,
  registerQuickUnlockIpc,
};
