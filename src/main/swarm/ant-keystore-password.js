/**
 * The Ant node's keystore password, kept out of config.yaml (K-3).
 *
 * `keys/swarm.key` is a Web3 v3 keystore holding the node wallet key,
 * encrypted with a random password. That password used to sit in plaintext
 * in `config.yaml`, beside the keystore, so whoever could read the data
 * directory could decrypt the key. It is now sealed with Electron's
 * safeStorage (the OS keychain: Keychain on macOS, DPAPI on Windows,
 * libsecret/KWallet on Linux) in `keys/keystore-password.sealed`, and only
 * reaches antd as a `--password-file` in a private directory under the
 * profile (`run/ant-handoff/`), removed once the node is up; one a killed
 * launch left behind is removed at the next start.
 *
 * Where safeStorage has no OS keyring behind it, sealing would protect
 * nothing, so the password stays in the owner-only `config.yaml` as before.
 * On Linux that is decided by the ciphertext safeStorage's async API
 * actually returns, never by `getSelectedStorageBackend()`, which describes
 * the legacy synchronous selection: Chromium tags each ciphertext with the
 * key that made it, `v10` for its fixed fallback key (no keyring), `v11`
 * for the Secret Service / KWallet key and `v12` for the Secret Portal key.
 * Only `v11` and `v12` count as sealed, when sealing and before opening a
 * sealed file.
 *
 * safeStorage is only touched from here, when Ant starts or a key is
 * injected, never at app launch, and only through its asynchronous API: on
 * Linux the first use can make the keyring ask to be unlocked, and the
 * synchronous calls would hold the main process while it asks.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UnsafePrivatePathError, openPrivateDir, withPrivateDir } = require('../private-files');

const SEALED_FILE = 'keystore-password.sealed';
// A seal being written: a private sibling, published as SEALED_FILE only
// once what it holds has been read back and opened to the exact password.
const STAGED_FILE = '.keystore-password.staged';
// The staged seal, and the temp files PrivateDir#write writes either one
// through, as a crash can leave them.
const STALE_STAGING =
  /^(?:\.keystore-password\.staged|\.\.keystore-password\.staged\.\d+\.[0-9a-f]+\.tmp|\.keystore-password\.sealed\.\d+\.[0-9a-f]+\.tmp)$/;
const REINJECT_MESSAGE = 'Swarm key needs re-injecting: unlock your vault';
const IDENTITY_MISMATCH_MESSAGE =
  'Swarm keystore belongs to a different identity: re-inject manually';

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

/**
 * Automatic recovery found a keystore that is not the unlocked vault's Swarm
 * key (or one whose identity it cannot read): it is kept, never overwritten.
 */
class KeystoreIdentityMismatchError extends Error {
  constructor() {
    super(IDENTITY_MISMATCH_MESSAGE);
    this.name = 'KeystoreIdentityMismatchError';
    this.code = 'ANT_KEYSTORE_IDENTITY_MISMATCH';
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

// Linux ciphertexts keyed by an OS keyring: `v11` (Secret Service,
// KWallet) and `v12` (Secret Portal). `v10` is the fixed fallback key.
// macOS (Keychain) and Windows (DPAPI) use `v10` for keyed data, so the
// check applies to Linux only.
const LINUX_KEYED_PREFIXES = new Set(['v11', 'v12']);

/** safeStorage's async API, when it can encrypt at all. */
async function availableStorage() {
  const storage = getSafeStorage();
  try {
    if (typeof storage?.encryptStringAsync !== 'function') return null;
    if (typeof storage.decryptStringAsync !== 'function') return null;
    if ((await storage.isAsyncEncryptionAvailable()) !== true) return null;
    return storage;
  } catch {
    return null;
  }
}

function keyedByKeyring(ciphertext) {
  if (!Buffer.isBuffer(ciphertext)) return false;
  if (process.platform !== 'linux') return true;
  return LINUX_KEYED_PREFIXES.has(ciphertext.subarray(0, 3).toString('latin1'));
}

// A PrivateDir (or a stand-in with its interface), not a path.
function isDirHandle(value) {
  return typeof value === 'object' && value !== null && typeof value.openDir === 'function';
}

/**
 * The Ant data directory's keys/, opened (private-files.js: never through a
 * link, bound across awaits) from the data directory's PrivateDir, as
 * ensureConfig holds it, or from its path. With `create: false` a missing
 * data directory or keys/ is a null `keys`. `close()` closes what this
 * opened; callers call it in a `finally`, so an async body adds no extra
 * promise hops.
 * @returns {{ keys: PrivateDir|null, close: () => void }}
 */
function openKeys(data, { create = false } = {}) {
  if (!data) return { keys: null, close() {} };
  if (isDirHandle(data)) {
    const keys = data.openDir('keys', { create });
    return { keys, close: () => keys?.close() };
  }
  const handle = openPrivateDir(data, { create });
  if (!handle) return { keys: null, close() {} };
  try {
    return { keys: handle.openDir('keys', { create }), close: () => handle.close() };
  } catch (err) {
    handle.close();
    throw err;
  }
}

// `use(keys)` for a synchronous use.
function withKeysDir(data, use, options) {
  const { keys, close } = openKeys(data, options);
  try {
    return use(keys);
  } finally {
    close();
  }
}

// Whether `keys` has an entry `name` (a link counts: reading it refuses).
function hasEntry(keys, name) {
  if (!keys) return false;
  keys.verify();
  return fs.lstatSync(keys.entry(name), { throwIfNoEntry: false }) !== undefined;
}

// A directory's entry names, read through its handle.
function listEntries(dir) {
  dir.verify();
  return fs.readdirSync(dir.bound ? `/proc/self/fd/${dir.fd}` : dir.path);
}

// The base64 ciphertext stored as `name`, through one no-follow descriptor;
// null when missing.
function readCiphertext(keys, name) {
  const stored = keys.read(name);
  return stored === null ? null : Buffer.from(stored.toString('utf-8').trim(), 'base64');
}

function sealedPasswordPath(dataDir) {
  return path.join(dataDir, 'keys', SEALED_FILE);
}

/** Whether keys/ holds a sealed password (`data`: a PrivateDir or path). */
function hasSealedPassword(data) {
  return withKeysDir(data, (keys) => hasEntry(keys, SEALED_FILE));
}

/** Whether keys/ holds a keystore (`keys`: the held keys/ handle, or null). */
function keystoreExists(keys) {
  return hasEntry(keys, 'swarm.key');
}

/**
 * Seal `password` for the keystore in `data`'s keys/. The ciphertext is
 * staged in a private sibling file, read back and opened to the exact
 * password, and only then published over the sealed file, atomically: a
 * failed or interrupted seal leaves whatever was there before, and never a
 * file that won't open. keys/ stays bound across the keychain awaits.
 * @param {import('../private-files').PrivateDir|string} data the data directory
 * @returns {Promise<boolean>} true once the verified seal is in place;
 *   false when there is no OS keyring to seal with, or sealing failed. The
 *   caller then keeps the password in the owner-only config.yaml.
 */
async function sealPassword(data, password) {
  const storage = await availableStorage();
  if (!storage) return false;
  let ciphertext;
  try {
    ciphertext = await storage.encryptStringAsync(password);
  } catch (err) {
    console.warn('[AntKeystore] Could not seal the keystore password:', err.message);
    return false;
  }
  if (!keyedByKeyring(ciphertext)) return false;
  let opened = null;
  try {
    opened = openKeys(data, { create: true });
    return await sealInto(opened.keys, storage, ciphertext, password);
  } catch (err) {
    console.warn('[AntKeystore] Could not seal the keystore password:', err.message);
    return false;
  } finally {
    opened?.close();
  }
}

async function sealInto(keys, storage, ciphertext, password) {
  let staged = false;
  try {
    keys.write(STAGED_FILE, ciphertext.toString('base64'));
    staged = true;
    // What is on disk, not what was meant to be: it must open to exactly
    // this password before anything relies on it.
    const stored = readCiphertext(keys, STAGED_FILE);
    if (!keyedByKeyring(stored)) throw new Error('the staged seal is not keyed by the keyring');
    const { result } = await storage.decryptStringAsync(stored);
    if (result !== password) throw new Error('the staged seal does not open to the password');
    // Published as those verified bytes, atomically (temp file and rename).
    keys.write(SEALED_FILE, stored.toString('base64'));
    return true;
  } finally {
    if (staged) {
      try {
        keys.remove(STAGED_FILE);
      } catch (err) {
        console.warn('[AntKeystore] Could not remove a staged seal:', err.message);
      }
    }
  }
}

/**
 * Staged seals a crash left behind: ciphertext only, never published.
 * @param {PrivateDir} keys the held keys/ handle
 */
function removeStaleSealStaging(keys) {
  let entries;
  try {
    entries = listEntries(keys);
  } catch (err) {
    console.warn('[AntKeystore] Could not list keys/:', err.message);
    return;
  }
  for (const entry of entries) {
    if (!STALE_STAGING.test(entry)) continue;
    try {
      keys.remove(entry);
    } catch (err) {
      console.warn('[AntKeystore] Could not remove a staged seal:', err.message);
    }
  }
}

/**
 * The sealed password, or null when there is none.
 * @param {import('../private-files').PrivateDir|string} data the data directory
 * @returns {Promise<string|null>}
 * @throws {KeystorePasswordUnavailableError} when it cannot be read or
 *   decrypted, or (Linux) it was not sealed with a keyring's key
 */
async function unsealPassword(data) {
  const { keys, close } = openKeys(data, { create: false });
  try {
    if (!hasEntry(keys, SEALED_FILE)) return null;
    const storage = await availableStorage();
    if (!storage) throw new KeystorePasswordUnavailableError();
    try {
      const ciphertext = readCiphertext(keys, SEALED_FILE);
      if (ciphertext === null) return null;
      if (!keyedByKeyring(ciphertext)) throw new Error('not sealed with a keyring key');
      const { result, shouldReEncrypt } = await storage.decryptStringAsync(ciphertext);
      if (typeof result !== 'string' || !result) throw new Error('empty password');
      // The keychain rotated its key: store it under the current one.
      if (shouldReEncrypt) await resealInto(keys, storage, result);
      return result;
    } catch (err) {
      throw new KeystorePasswordUnavailableError(err);
    }
  } finally {
    close();
  }
}

async function resealInto(keys, storage, password) {
  try {
    const ciphertext = await storage.encryptStringAsync(password);
    if (keyedByKeyring(ciphertext)) await sealInto(keys, storage, ciphertext, password);
  } catch (err) {
    console.warn('[AntKeystore] Could not re-seal the keystore password:', err.message);
  }
}

/** Drop the sealed password (`data`: a PrivateDir or path). */
function forgetSealedPassword(data) {
  withKeysDir(data, (keys) => {
    keys?.remove(SEALED_FILE);
  });
}

// Handoff directories of this process that antd may still have to read.
const liveHandoffs = new Set();

/**
 * The profile-owned parent of every --password-file handoff:
 * `<userData>/run/ant-handoff/`, owner-only. Profile-owned, not the shared
 * temp directory, so the next launch of the profile can find and remove
 * what a killed one left behind (sweepAbandonedHandoffs).
 */
function handoffRoot(userDataDir) {
  return path.join(userDataDir, 'run', 'ant-handoff');
}

// `use(root)` with handoffRoot(userDataDir) held open: userData is the
// profile's own directory (trusted, links followed), run/ and ant-handoff/
// are managed, 0700. With `create: false` a missing one is `use(null)`.
function withHandoffRoot(userDataDir, use, { create }) {
  return withPrivateDir(
    userDataDir,
    (profile) => {
      if (!profile) return use(null);
      const run = profile.openDir('run', { create });
      try {
        const root = run && run.openDir('ant-handoff', { create });
        return use(root);
      } finally {
        run?.close();
      }
    },
    { create: false, trusted: true }
  );
}

// Remove the handoff directory `name` in `root`, through the handles: its
// files, then itself. Something other than a directory at the name (a
// planted link, say) is removed as a name, never followed.
function removeHandoff(root, name) {
  let dir;
  try {
    dir = root.openDir(name, { create: false });
  } catch (err) {
    if (!(err instanceof UnsafePrivatePathError)) throw err;
    root.remove(name);
    return;
  }
  if (!dir) return;
  try {
    for (const entry of listEntries(dir)) dir.remove(entry);
  } finally {
    dir.close();
  }
  root.verify();
  fs.rmdirSync(root.entry(name));
}

/**
 * Write `password` where antd's `--password-file` can read it: a 0600 file
 * in a fresh 0700 directory under handoffRoot(userDataDir), all written
 * through held directory handles. Call `remove()` once antd has read it
 * (its API is up) or has exited; it is idempotent, and a removal that
 * failed is tried again on the next call.
 * @returns {{ path: string, remove: () => boolean }}
 */
function writePasswordFile(password, userDataDir) {
  const name = `h-${crypto.randomBytes(8).toString('hex')}`;
  const dir = path.join(handoffRoot(userDataDir), name);
  liveHandoffs.add(dir);
  let removed = false;
  const remove = () => {
    // No longer needed: a later sweep may take it if this removal fails.
    liveHandoffs.delete(dir);
    if (removed) return true;
    try {
      withHandoffRoot(userDataDir, (root) => root && removeHandoff(root, name), { create: false });
      removed = true;
    } catch (err) {
      console.warn('[AntKeystore] Could not remove the password file:', err.message);
    }
    return removed;
  };
  try {
    withHandoffRoot(
      userDataDir,
      (root) => {
        if (fs.lstatSync(root.entry(name), { throwIfNoEntry: false })) {
          throw new Error(`password handoff ${name} already exists`);
        }
        const handoff = root.openDir(name, { create: true });
        try {
          handoff.write('password', password);
        } finally {
          handoff.close();
        }
      },
      { create: true }
    );
  } catch (err) {
    remove();
    throw err;
  }
  return { path: path.join(dir, 'password'), remove };
}

/**
 * Remove the handoffs under `userDataDir` that no live start of this process
 * owns: the ones a crashed or killed launch left (its antd has read them, or
 * never will). Only one Freedom runs a profile at a time (profile-lock.js),
 * so nothing else can own them.
 * @returns {number} how many were removed
 */
function sweepAbandonedHandoffs(userDataDir) {
  if (!userDataDir) return 0;
  try {
    return withHandoffRoot(
      userDataDir,
      (root) => {
        if (!root) return 0;
        let removed = 0;
        for (const entry of listEntries(root)) {
          if (liveHandoffs.has(path.join(handoffRoot(userDataDir), entry))) continue;
          try {
            removeHandoff(root, entry);
            removed += 1;
          } catch (err) {
            console.warn('[AntKeystore] Could not remove an abandoned password file:', err.message);
          }
        }
        return removed;
      },
      { create: false }
    );
  } catch (err) {
    console.warn('[AntKeystore] Could not sweep password handoffs:', err.message);
    return 0;
  }
}

// One keystore operation at a time per data directory: startup migration
// (ensureConfig), injection and automatic recovery all write swarm.key, the
// sealed password or config.yaml, and two of them interleaved could leave a
// keystore with another one's password.
const keystoreLocks = new Map();

function callAsync(fn) {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Run `fn` once no other keystore operation on `dataDir` is running.
 * Not re-entrant: `fn` must not wait for another withKeystoreLock on the
 * same directory.
 * @template T
 * @param {string} dataDir
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
function withKeystoreLock(dataDir, fn) {
  const key = path.resolve(dataDir);
  const previous = keystoreLocks.get(key);
  // Uncontended, `fn` starts at once, as a direct call would.
  const run = previous ? previous.then(() => fn()) : callAsync(fn);
  const settled = run.then(
    () => {},
    () => {}
  );
  keystoreLocks.set(key, settled);
  settled.then(() => {
    if (keystoreLocks.get(key) === settled) keystoreLocks.delete(key);
  });
  return run;
}

/**
 * The account a Web3 v3 keystore says it holds (its unencrypted `address`),
 * as 40 lowercase hex digits, or null when the file has none to read.
 * @param {import('../private-files').PrivateDir|string} data the data directory
 */
function keystoreAddress(data) {
  try {
    return withKeysDir(data, (keys) => {
      const raw = keys?.read('swarm.key');
      if (!raw) return null;
      const keystore = JSON.parse(raw.toString('utf-8'));
      const hex = typeof keystore?.address === 'string' ? keystore.address.toLowerCase() : '';
      const address = hex.startsWith('0x') ? hex.slice(2) : hex;
      return /^[0-9a-f]{40}$/.test(address) ? address : null;
    });
  } catch {
    return null;
  }
}

module.exports = {
  REINJECT_MESSAGE,
  IDENTITY_MISMATCH_MESSAGE,
  KeystorePasswordUnavailableError,
  KeystoreIdentityMismatchError,
  hasSealedPassword,
  keystoreExists,
  sealPassword,
  unsealPassword,
  forgetSealedPassword,
  removeStaleSealStaging,
  writePasswordFile,
  sweepAbandonedHandoffs,
  handoffRoot,
  withKeystoreLock,
  keystoreAddress,
  sealedPasswordPath,
  _setSafeStorageForTests: (storage) => {
    safeStorageOverride = storage;
  },
};
