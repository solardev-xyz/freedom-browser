/**
 * The Ant node's keystore password, kept out of config.yaml (K-3).
 *
 * `keys/swarm.key` is a Web3 v3 keystore holding the node wallet key,
 * encrypted with a random password. That password used to sit in plaintext
 * in `config.yaml`, beside the keystore, so whoever could read the data
 * directory could decrypt the key. It is now sealed with Electron's
 * safeStorage (the OS keychain: Keychain on macOS, DPAPI on Windows,
 * libsecret/KWallet on Linux) in `keys/keystore-password.sealed`, and only
 * reaches antd as a `--password-file` in a private temp directory that is
 * removed once the node is up.
 *
 * Where safeStorage has no OS keyring behind it, sealing would protect
 * nothing, so the password stays in the owner-only `config.yaml` as before.
 * On Linux that is not only the `basic_text` backend: with no Secret
 * Service on the session bus, Chromium still reports `gnome_libsecret` but
 * encrypts with its fixed fallback key (a `v10` ciphertext). Only a `v11`
 * ciphertext, keyed by the keyring, counts as sealed there.
 *
 * safeStorage is only touched from here, when Ant starts or a key is
 * injected, never at app launch, and only through its asynchronous API: on
 * Linux the first use can make the keyring ask to be unlocked, and the
 * synchronous calls would hold the main process while it asks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensurePrivateDir, writePrivateFileSync } = require('../private-files');

const SEALED_FILE = 'keystore-password.sealed';
const REINJECT_MESSAGE = 'Swarm key needs re-injecting: unlock your vault';

/**
 * The sealed password is missing or cannot be decrypted (a reset keychain,
 * a profile copied from another machine) while a keystore needs it. The key
 * is derived from the recovery phrase, so it is re-injected with a new
 * password on the next vault unlock; a new identity is never made instead.
 */
class KeystorePasswordUnavailableError extends Error {
  constructor(cause) {
    super(REINJECT_MESSAGE, cause ? { cause } : undefined);
    this.name = 'KeystorePasswordUnavailableError';
    this.code = 'ANT_KEYSTORE_PASSWORD_UNAVAILABLE';
  }
}

let safeStorageOverride = null;

function getSafeStorage() {
  if (safeStorageOverride) return safeStorageOverride;
  try {
    return require('electron').safeStorage || null;
  } catch {
    return null;
  }
}

// Linux ciphertexts keyed by the OS keyring start with `v11`; `v10` is the
// fixed fallback key. macOS (Keychain) and Windows (DPAPI) use `v10` for
// keyed data, so the check applies to Linux only.
const LINUX_KEYRING_PREFIX = 'v11';

/** safeStorage's async API, when it can encrypt at all. */
async function availableStorage() {
  const storage = getSafeStorage();
  try {
    if (typeof storage?.encryptStringAsync !== 'function') return null;
    if ((await storage.isAsyncEncryptionAvailable()) !== true) return null;
    if (process.platform === 'linux' && storage.getSelectedStorageBackend?.() === 'basic_text') {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

function keyedByKeyring(ciphertext) {
  if (process.platform !== 'linux') return true;
  return ciphertext.subarray(0, LINUX_KEYRING_PREFIX.length).toString() === LINUX_KEYRING_PREFIX;
}

function sealedPasswordPath(dataDir) {
  return path.join(dataDir, 'keys', SEALED_FILE);
}

function hasSealedPassword(dataDir) {
  return fs.existsSync(sealedPasswordPath(dataDir));
}

/**
 * Seal `password` for `dataDir`'s keystore.
 * @returns {Promise<boolean>} false when there is no OS keyring to seal
 *   with; the caller then keeps the password in the owner-only config.yaml.
 */
async function sealPassword(dataDir, password) {
  const storage = await availableStorage();
  if (!storage) return false;
  try {
    const ciphertext = await storage.encryptStringAsync(password);
    if (!keyedByKeyring(ciphertext)) return false;
    ensurePrivateDir(path.join(dataDir, 'keys'));
    writePrivateFileSync(sealedPasswordPath(dataDir), ciphertext.toString('base64'));
    return true;
  } catch (err) {
    console.warn('[AntKeystore] Could not seal the keystore password:', err.message);
    return false;
  }
}

/**
 * The sealed password, or null when there is none.
 * @returns {Promise<string|null>}
 * @throws {KeystorePasswordUnavailableError} when it cannot be decrypted
 */
async function unsealPassword(dataDir) {
  const file = sealedPasswordPath(dataDir);
  if (!fs.existsSync(file)) return null;
  const storage = await availableStorage();
  if (!storage) throw new KeystorePasswordUnavailableError();
  try {
    const ciphertext = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'base64');
    const { result, shouldReEncrypt } = await storage.decryptStringAsync(ciphertext);
    if (!result) throw new Error('empty password');
    // The keychain rotated its key: store it under the current one.
    if (shouldReEncrypt) await sealPassword(dataDir, result);
    return result;
  } catch (err) {
    throw new KeystorePasswordUnavailableError(err);
  }
}

function forgetSealedPassword(dataDir) {
  fs.rmSync(sealedPasswordPath(dataDir), { force: true });
}

/**
 * Write `password` where antd's `--password-file` can read it: a 0600 file
 * in a fresh 0700 directory. Call `remove()` once antd has read it (its API
 * is up) or has exited; it is idempotent.
 * @returns {{ path: string, remove: () => void }}
 */
function writePasswordFile(password) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ant-'));
  ensurePrivateDir(dir);
  const file = path.join(dir, 'password');
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn('[AntKeystore] Could not remove the password file:', err.message);
    }
  };
  try {
    writePrivateFileSync(file, password);
  } catch (err) {
    remove();
    throw err;
  }
  return { path: file, remove };
}

module.exports = {
  REINJECT_MESSAGE,
  KeystorePasswordUnavailableError,
  hasSealedPassword,
  sealPassword,
  unsealPassword,
  forgetSealedPassword,
  writePasswordFile,
  sealedPasswordPath,
  _setSafeStorageForTests: (storage) => {
    safeStorageOverride = storage;
  },
};
