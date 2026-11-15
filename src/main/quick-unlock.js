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

const FILE_NOT_REMOVED =
  "Touch ID unlock is still on: its file in this profile's identity folder could not be removed. Try again; if it keeps failing, contact support.";

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

/**
 * The password sealed under safeStorage as quick-unlock.dat's bytes, bound
 * to the profile and to the vault on disk now (its fingerprint, returned
 * too). Throws when safeStorage can't seal it.
 */
function sealCredential(password) {
  const encrypted = safeStorage.encryptString(password);
  const binding = getCurrentBinding();
  const vaultFingerprint = getVaultFingerprint();
  const payload = {
    version: CREDENTIAL_VERSION,
    profileId: binding.profileId,
    userDataDirHash: binding.userDataDirHash,
    vaultFingerprint,
    encrypted: encrypted.toString('base64'),
    createdAt: new Date().toISOString(),
  };
  return { bytes: Buffer.from(JSON.stringify(payload, null, 2), 'utf-8'), vaultFingerprint };
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

function writeSealed(sealed) {
  withCredentialDir((dir) => dir.write(path.basename(getCredentialPath()), sealed.bytes));
}

function writeCredential(password) {
  writeSealed(sealCredential(password));
}

/**
 * A failure, for the log: its code, never its message. A file error's
 * message names the identity path (fs, private-files.js).
 */
function errorCode(err) {
  return err?.code || err?.name || 'error';
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
    console.warn('[QuickUnlock] quick-unlock.dat unavailable:', errorCode(err));
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
    console.error('[QuickUnlock] quick-unlock.dat not written for older builds:', errorCode(err));
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
    // quick-unlock.dat for older builds: sealed now, and only the sealed
    // bytes kept for a short retry of the write.
    await completeQuickSetup(password);
    console.log('[QuickUnlock] Quick Setup done');
    return { success: true };
  } catch (err) {
    console.error('[QuickUnlock] Quick Setup failed:', err.message);
    return { success: false, error: err.message };
  }
}

// quick-unlock.dat's sealed bytes for a write that failed, retried a few
// times (see completeQuickSetup). Never the password.
let pendingSetup = null;
const SETUP_RETRY_MS = 30_000;
const SETUP_ATTEMPTS = 3;

/**
 * Writes quick-unlock.dat, for older builds, once the core has committed a
 * vault with quick unlock's credential: Quick Setup, or one whose reply was
 * lost and found again (freedom-core design 0001, "Reconciliation"). The
 * core's credential is the one this build uses, and it is already there.
 * Main-internal only.
 *
 * The password is sealed (safeStorage) here, at once, and never kept. If it
 * can't be sealed, no file is written, and the log says so with the
 * failure's code only. The sealed bytes are kept for at most
 * SETUP_ATTEMPTS writes, SETUP_RETRY_MS apart, and dropped as soon as the
 * vault they are bound to is no longer the one on disk.
 * @returns {Promise<boolean>} whether it was written now
 */
async function completeQuickSetup(password) {
  cancelPendingSetup();
  let sealed;
  try {
    if (!isSecureStorageAvailable()) {
      throw Object.assign(new Error('Secure storage not available'), { code: 'secure_storage_unavailable' });
    }
    sealed = sealCredential(password);
  } catch (err) {
    console.error(
      `[QuickUnlock] quick-unlock.dat for older builds not written: the password could not be sealed (${errorCode(err)}). It is not kept; the core's credential is unaffected.`
    );
    return false;
  }
  pendingSetup = { sealed, attemptsLeft: SETUP_ATTEMPTS, timer: null };
  return trySetupCredential(pendingSetup);
}

/** Drops a pending write's sealed bytes; a retry scheduled won't write. */
function cancelPendingSetup() {
  if (!pendingSetup) return;
  clearTimeout(pendingSetup.timer);
  pendingSetup = null;
}

function trySetupCredential(setup) {
  if (pendingSetup !== setup) return false; // superseded or cancelled
  setup.attemptsLeft -= 1;
  try {
    if (getVaultFingerprint() !== setup.sealed.vaultFingerprint) {
      // The vault was replaced or deleted: the file would be bound to none.
      pendingSetup = null;
      console.error('[QuickUnlock] quick-unlock.dat for older builds not written: the vault changed');
      return false;
    }
    writeSealed(setup.sealed);
    pendingSetup = null;
    console.log('[QuickUnlock] quick-unlock.dat written for older builds');
    return true;
  } catch (err) {
    if (setup.attemptsLeft <= 0) {
      pendingSetup = null;
      console.error(
        `[QuickUnlock] quick-unlock.dat for older builds not written after ${SETUP_ATTEMPTS} tries (${errorCode(err)}); given up`
      );
      return false;
    }
    console.error(`[QuickUnlock] quick-unlock.dat for older builds not written yet (${errorCode(err)})`);
    setup.timer = setTimeout(() => trySetupCredential(setup), SETUP_RETRY_MS);
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

// The file and its binding are read again after the Touch ID prompt, right
// before use. A vault swapped (or a file replaced) while the prompt was up
// fails closed rather than meet a stale credential.
const CHANGED_DURING_PROMPT = 'Quick unlock changed during the Touch ID prompt. Try again.';

/**
 * quick-unlock.dat's password into `job.file`, then enrolled.
 *
 * A v2 file is bound to the vault: it is checked against the vault on disk
 * again here, after the prompt, and must still be the file read before it.
 * **A legacy file is the exception:** it carries no binding, so it opens any
 * vault that takes the same password (as before PRF-2b; a vault delete
 * leaves the file, as it always has). The core's enroll binds what it
 * stores to the vault it checks the password against.
 */
async function throughFile(credential, job) {
  const current = usableFileCredential();
  if (!current || current.type !== credential.type || !current.encrypted.equals(credential.encrypted)) {
    throw new Error(CHANGED_DURING_PROMPT);
  }
  const password = safeStorage.decryptString(current.encrypted);
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
 * the change, as one operation with the vault's write (0013, "The re-wrap's
 * two entries").
 *
 * A profile still on quick-unlock.dat alone would lose quick unlock, as the
 * file is bound to the vault being replaced. So main enrolls the current
 * password first, under the vault as it is, and the change's re-wrap then
 * carries the credential across. An enroll the core refuses refuses the
 * change too, before anything is written: the password stays as it was,
 * and quick unlock with it. The file isn't written.
 * @param {string} currentPassword
 * @param {string} newPassword
 */
async function changePasswordKeepingQuickUnlock(currentPassword, newPassword) {
  const enrollFirst =
    KEY_STORE_PLATFORMS.has(process.platform) &&
    usableFileCredential() !== null &&
    !(await coreCredential());
  if (enrollFirst) {
    try {
      await vaultBackend.quickUnlockEnroll(currentPassword);
    } catch (err) {
      // A wrong current password reads as the change's own refusal.
      if (err.code !== 'incorrect_password') {
        err.message = `The password was not changed: Touch ID unlock could not be kept. ${err.message}`;
      }
      console.error('[QuickUnlock] Password change refused: quick unlock not moved into the core:', errorCode(err));
      throw err;
    }
    console.log('[QuickUnlock] Quick unlock is in the core, ahead of the password change');
  }
  await vaultBackend.changePassword(currentPassword, newPassword);
}

/**
 * Disable quick unlock: removes quick-unlock.dat, then the core's
 * credential (whose key the core then forgets). In that order, so a failure
 * never leaves the file to bring the core's credential back at the next
 * Touch ID unlock.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function disableQuickUnlock() {
  // A pending write of quick-unlock.dat must not bring the file back.
  cancelPendingSetup();
  try {
    withCredentialDir((dir) => dir.remove(path.basename(getCredentialPath())));
  } catch (err) {
    // The file error's message names the identity path: the log gets its
    // code, the renderer fixed words.
    console.error('[QuickUnlock] Failed to disable: quick-unlock.dat not removed:', errorCode(err));
    return { success: false, error: FILE_NOT_REMOVED };
  }
  try {
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
  FILE_NOT_REMOVED,
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
  // Tests: what a failed write of quick-unlock.dat keeps.
  _internal: { pendingSetup: () => pendingSetup },
};
