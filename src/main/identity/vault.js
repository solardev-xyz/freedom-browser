/**
 * Identity Vault
 *
 * Securely stores and manages the user's mnemonic.
 * - Encrypts mnemonic with user password (AES-GCM via PBKDF2)
 * - Stores encrypted vault in app data directory
 * - Provides lock/unlock interface
 */

const { encrypt, decrypt } = require('@metamask/browser-passworder');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isValidMnemonic, createMnemonic, deriveUserWallet } = require('./derivation');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');

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
function getVaultPath(dataDir) {
  return path.join(dataDir, 'identity-vault.json');
}

// Owner read/write only. The vault is encrypted, but a world-readable copy
// lets any local account run an offline password search against it (K-2).
const VAULT_FILE_MODE = 0o600;

const POSIX = process.platform !== 'win32';
// Never follow a link planted at the vault's name (POSIX).
const READ_FLAGS = fs.constants.O_RDONLY | (POSIX ? fs.constants.O_NOFOLLOW : 0);

// Test seam: called at each step of a vault write ('file-synced' once the
// temp file is fsynced, 'renamed', 'dir-synced'), so the crash tests can
// stop the process at an exact point.
let writeObserver = null;

function digestOf(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read the vault through one descriptor: narrow it to VAULT_FILE_MODE first
 * (vaults written before K-2 got the umask's mode, usually 0644; a file that
 * does not parse is narrowed too), then read it from the same descriptor, so
 * a name swapped meanwhile is never the one read.
 * @returns {{ bytes: Buffer, digest: string }}
 */
function readVaultBytes(vaultPath) {
  const fd = fs.openSync(vaultPath, READ_FLAGS);
  try {
    if (POSIX) {
      try {
        if ((fs.fstatSync(fd).mode & 0o777) !== VAULT_FILE_MODE) fs.fchmodSync(fd, VAULT_FILE_MODE);
      } catch (err) {
        console.warn('[Vault] Could not restrict the vault file mode:', err.message);
      }
    }
    const bytes = fs.readFileSync(fd);
    return { bytes, digest: digestOf(bytes) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The digest of the vault file as it is now, or null when there is none.
 * A write refuses to replace a file that is not the one it started from.
 */
function liveVaultDigest(vaultPath) {
  try {
    return readVaultBytes(vaultPath).digest;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read and parse the vault file (see readVaultBytes).
 * @param {string} dataDir
 * @returns {{version: number, encrypted: string, createdAt?: string}}
 */
function readVaultData(dataDir) {
  return readVaultFile(dataDir).vaultData;
}

function readVaultFile(dataDir) {
  const { bytes, digest } = readVaultBytes(getVaultPath(dataDir));
  return { vaultData: JSON.parse(bytes.toString('utf-8')), digest };
}

// Vault mutations (create, import, password change, delete) run one at a
// time per data directory: a password change that had read the old vault
// must not land on top of a vault deleted and recreated meanwhile, and two
// creates must not both hand out a recovery phrase (K-2).
const mutationChains = new Map();

function withVaultMutation(dataDir, fn) {
  const key = path.resolve(dataDir);
  const run = (mutationChains.get(key) || Promise.resolve()).then(() => fn());
  const tail = run.catch(() => {});
  mutationChains.set(key, tail);
  tail.then(() => {
    if (mutationChains.get(key) === tail) mutationChains.delete(key);
  });
  return run;
}

/**
 * Decrypt the vault with `password`, without touching the lock state.
 * @returns {Promise<string>} the mnemonic
 */
async function decryptVaultMnemonic(vaultData, password) {
  if (vaultData.version !== 1) {
    throw new Error(`Unsupported vault version: ${vaultData.version}`);
  }
  try {
    const decrypted = await decrypt(password, vaultData.encrypted);
    return decrypted.mnemonic;
  } catch (err) {
    if (err.message.includes('Incorrect password')) {
      throw new Error('Incorrect password', { cause: err });
    }
    throw err;
  }
}

function fsyncDirectory(dir) {
  // Makes the rename itself durable. Directories cannot be opened for fsync
  // on Windows, where the rename is already durable enough for this.
  if (!POSIX) return;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    console.warn('[Vault] Could not fsync the vault directory:', err.message);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Replace the vault file atomically: write a private temp file next to it,
 * fsync it, check that it decrypts back to `mnemonic` with `password`, and
 * only then rename it over the vault. A crash, a full disk or a bad write
 * leaves the previous vault (and its password) in place.
 *
 * `expectedDigest` is the live vault the operation started from (null: no
 * vault). If the file there is no longer that one, nothing is replaced.
 */
async function writeVaultFile(vaultPath, vaultData, password, mnemonic, expectedDigest) {
  const tempPath = `${vaultPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tempPath, 'wx', VAULT_FILE_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify(vaultData, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    writeObserver?.('file-synced', tempPath);

    const written = JSON.parse(fs.readFileSync(tempPath, 'utf-8'));
    if ((await decryptVaultMnemonic(written, password)) !== mnemonic) {
      throw new Error('The new vault did not decrypt to the same recovery phrase');
    }

    if (liveVaultDigest(vaultPath) !== expectedDigest) {
      throw new Error('The vault changed while it was being saved; nothing was replaced');
    }
    fs.renameSync(tempPath, vaultPath);
    writeObserver?.('renamed', vaultPath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
  fsyncDirectory(path.dirname(vaultPath));
  writeObserver?.('dir-synced', vaultPath);
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
function createVault(dataDir, password, strength = 256) {
  return withVaultMutation(dataDir, async () => {
    if (vaultExists(dataDir)) {
      throw new Error('Vault already exists. Use importVault to replace.');
    }

    const mnemonic = createMnemonic(strength);
    await saveVault(dataDir, password, mnemonic, null);

    return mnemonic;
  });
}

/**
 * Import an existing mnemonic into a new vault
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {string} mnemonic - The mnemonic to import
 * @param {boolean} overwrite - Whether to overwrite existing vault
 */
function importVault(dataDir, password, mnemonic, overwrite = false) {
  return withVaultMutation(dataDir, async () => {
    if (!isValidMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic');
    }

    if (vaultExists(dataDir) && !overwrite) {
      throw new Error('Vault already exists. Set overwrite=true to replace.');
    }

    await saveVault(dataDir, password, mnemonic, liveVaultDigest(getVaultPath(dataDir)));
  });
}

/**
 * Save mnemonic to vault file
 * @private
 */
async function saveVault(dataDir, password, mnemonic, expectedDigest) {
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

  await writeVaultFile(vaultPath, vaultData, password, mnemonic, expectedDigest);
}

/**
 * Unlock the vault and load mnemonic into memory
 * @param {string} dataDir - App data directory
 * @param {string} password - User's password
 * @param {number} autoLockMs - Auto-lock timeout (0 to disable)
 * @returns {Promise<void>}
 */
async function unlockVault(dataDir, password, autoLockMs = DEFAULT_AUTO_LOCK_MS) {
  if (!vaultExists(dataDir)) {
    throw new Error('No vault found. Create one first.');
  }

  const mnemonic = await decryptVaultMnemonic(readVaultData(dataDir), password);

  // Validate decrypted mnemonic
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Decrypted data is not a valid mnemonic');
  }
  unlockedMnemonic = mnemonic;

  // Set up auto-lock timer
  if (autoLockMs > 0) {
    resetAutoLockTimer(autoLockMs);
  }
}

/**
 * Lock the vault (clear mnemonic from memory)
 */
function lockVault() {
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
function changePassword(dataDir, currentPassword, newPassword) {
  return withVaultMutation(dataDir, async () => {
    if (!vaultExists(dataDir)) {
      throw new Error('No vault found');
    }
    // Verify the current password by decrypting, without unlocking: a locked
    // vault stays locked, and an unlocked one keeps its auto-lock timer.
    const { vaultData, digest } = readVaultFile(dataDir);
    const mnemonic = await decryptVaultMnemonic(vaultData, currentPassword);
    if (!isValidMnemonic(mnemonic)) {
      throw new Error('Decrypted data is not a valid mnemonic');
    }

    // Re-encrypt with the new password. saveVault replaces the file only
    // once the new copy decrypts with it, and only if the vault is still the
    // one read above, so a failure keeps the old vault and the old password.
    await saveVault(dataDir, newPassword, mnemonic, digest);
  });
}

/**
 * Delete the vault (dangerous - requires confirmation)
 * @param {string} dataDir - App data directory
 * @param {string} password - Password to confirm
 */
function deleteVault(dataDir, password) {
  return withVaultMutation(dataDir, async () => {
    // Verify password first
    await unlockVault(dataDir, password, 0);
    lockVault();

    // Delete vault file
    const vaultPath = getVaultPath(dataDir);
    if (fs.existsSync(vaultPath)) {
      fs.unlinkSync(vaultPath);
    }
  });
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
  await decryptVaultMnemonic(readVaultData(dataDir), password);
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
  _setVaultWriteObserver: (observer) => {
    writeObserver = observer;
  },
  getVaultPath,
  vaultExists,
  createVault,
  importVault,
  unlockVault,
  lockVault,
  isUnlocked,
  getMnemonic,
  resetAutoLockTimer,
  changePassword,
  deleteVault,
  exportMnemonic,
  exportPrivateKey,
  verifyPassword,
};
