/**
 * The Ant node's keystore password, kept out of config.yaml (K-3).
 *
 * `keys/swarm.key` is a Web3 v3 keystore holding the node wallet key,
 * encrypted with a random password. That password used to sit in plaintext
 * in `config.yaml`, beside the keystore, so whoever could read the data
 * directory could decrypt the key. It is now sealed with Electron's
 * safeStorage (the OS keychain: Keychain on macOS, DPAPI on Windows,
 * libsecret/KWallet on Linux) in `keys/keystore-password.sealed`, and only
 * reaches antd as a `--password-file` in the profile's private handoff
 * directory (`run/ant-handoff/`), removed once the node is up; one a killed
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

// The seal record: the ciphertext, and the SHA-256 of the swarm.key bytes
// it was sealed for (null: no keystore then). A keystore written without
// its seal being republished (a crash between the two writes) no longer
// matches, and the pair is treated as broken instead of handing Ant a
// password for another keystore.
const SEAL_VERSION = 2;

/** SHA-256 (hex) of keys/swarm.key's bytes, or null when there is none. */
function keystoreDigest(keys) {
  const raw = keys ? keys.read('swarm.key') : null;
  return raw === null ? null : crypto.createHash('sha256').update(raw).digest('hex');
}

function encodeSeal(ciphertext, keystoreSha256) {
  return JSON.stringify({
    version: SEAL_VERSION,
    ciphertext: ciphertext.toString('base64'),
    keystoreSha256,
  });
}

// The seal record stored as `name`, through one no-follow descriptor; null
// when missing.
function readSeal(keys, name) {
  const raw = keys.read(name);
  if (raw === null) return null;
  let record;
  try {
    record = JSON.parse(raw.toString('utf-8'));
  } catch {
    throw new Error('not a seal record');
  }
  const digest = record?.keystoreSha256;
  if (
    record?.version !== SEAL_VERSION ||
    typeof record.ciphertext !== 'string' ||
    !(digest === null || (typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)))
  ) {
    throw new Error('not a seal record');
  }
  return { ciphertext: Buffer.from(record.ciphertext, 'base64'), keystoreSha256: digest };
}

function sealedPasswordPath(dataDir) {
  return path.join(dataDir, 'keys', SEALED_FILE);
}

/** Whether keys/ holds a sealed password (`data`: a PrivateDir or path). */
function hasSealedPassword(data) {
  return withKeysDir(data, (keys) => hasEntry(keys, SEALED_FILE));
}

/**
 * SHA-256 (hex) of keys/swarm.key as it is now, or null when there is none.
 * @param {import('../private-files').PrivateDir|string} data the data directory
 */
function keystoreDigestOf(data) {
  return withKeysDir(data, (keys) => keystoreDigest(keys));
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
 * @param {string} password
 * @param {{verifyKeystore?: boolean}} [options] migration: first check the
 *   password opens keys/swarm.key as it is then (keystoreOpensWith; no
 *   keystore is the null digest), and fail closed if the keystore appears
 *   or changes afterwards
 * @returns {Promise<boolean>} true once the verified seal is in place;
 *   false when there is no OS keyring to seal with, or sealing failed. The
 *   caller then keeps the password in the owner-only config.yaml.
 * @throws {KeystorePasswordUnavailableError} `verifyKeystore`, and the
 *   password does not open keys/swarm.key, or the keystore appeared or
 *   changed after it was checked
 */
async function sealPassword(data, password, { verifyKeystore = false, pin } = {}) {
  // The keystore this seal is for: the caller's pin (ensureConfig), or the
  // one on disk now (injection, recovery), whose change means no seal.
  const keystorePin = pin || pinKeystore(data, { strict: false });
  // No keyring returns before any check; the caller's commit guard still
  // stands between that and writing config.yaml.
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
  // Only once the seal will really happen, so a keyring-less host never
  // pays for the check: a password that does not open keys/swarm.key is not
  // sealed, and the caller leaves everything as it was.
  if (verifyKeystore) {
    const check = await keystoreOpensWith(data, password);
    if (!check.opens) {
      throw new KeystorePasswordUnavailableError(
        new Error('the password does not open keys/swarm.key')
      );
    }
    keystorePin.confirm(check.digest);
  }
  let opened = null;
  try {
    opened = openKeys(data, { create: true });
    return await sealInto(opened.keys, storage, ciphertext, password, keystorePin, 'seal');
  } catch (err) {
    // A keystore that changed after the check is not an ordinary failure to
    // seal: nothing may go on as if the password were the keystore's.
    if (err instanceof KeystorePasswordUnavailableError) throw err;
    console.warn('[AntKeystore] Could not seal the keystore password:', err.message);
    return false;
  } finally {
    opened?.close();
  }
}

// Remove a seal just published for a keystore that changed meanwhile.
// A failure is reported and left: the caller fails closed either way.
function withdrawSeal(keys) {
  try {
    keys.remove(SEALED_FILE);
  } catch (err) {
    console.warn('[AntKeystore] Could not withdraw a seal for a changed keystore:', err.message);
  }
}

// keys/swarm.key appeared or changed after its password was checked.
function keystoreChanged() {
  return new KeystorePasswordUnavailableError(
    new Error('keys/swarm.key changed after its password was checked')
  );
}

// Tests: told the site of every commit guard, as it runs.
let guardHook = null;

/**
 * The keystore a decision is made against: keys/swarm.key's SHA-256 when it
 * was pinned (null: none), and the one check that stands immediately before
 * every commit made on that decision: publishing a seal or a reseal,
 * handing a sealed password back, writing config.yaml, handing the
 * password to Ant (ensureConfig). Everything a decision awaited (the
 * keychain, scrypt) happened before its guard, and the guard itself is
 * synchronous, so no keystore change can fall between the check and the
 * commit within this process.
 *
 * A strict pin (ensureConfig) fails with the re-inject error; a lenient one
 * (sealing after injection or recovery) just stops that seal.
 */
class KeystorePin {
  constructor(data, { strict = true } = {}) {
    this.data = data;
    this.strict = strict;
    this.expected = keystoreDigestOf(data);
  }

  changed() {
    return this.strict
      ? keystoreChanged()
      : new Error('the keystore changed while it was being sealed');
  }

  /** A digest a check produced must be the pinned keystore's. */
  confirm(digest) {
    if (digest !== this.expected) throw this.changed();
  }

  /** The commit guard: keys/swarm.key re-read, still the pinned one. */
  guard(site) {
    guardHook?.(site);
    if (keystoreDigestOf(this.data) !== this.expected) throw this.changed();
  }
}

/** Pin keys/swarm.key as it is now (`data`: a PrivateDir or path). */
function pinKeystore(data, options) {
  return new KeystorePin(data, options);
}

async function sealInto(keys, storage, ciphertext, password, pin, site) {
  let staged = false;
  try {
    // Bound to the pinned keystore: the one this password opens.
    pin.confirm(keystoreDigest(keys));
    const digest = pin.expected;
    keys.write(STAGED_FILE, encodeSeal(ciphertext, digest));
    staged = true;
    // What is on disk, not what was meant to be: it must open to exactly
    // this password, for this keystore, before anything relies on it.
    const stored = readSeal(keys, STAGED_FILE);
    if (!keyedByKeyring(stored.ciphertext)) {
      throw new Error('the staged seal is not keyed by the keyring');
    }
    const { result } = await storage.decryptStringAsync(stored.ciphertext);
    if (result !== password) throw new Error('the staged seal does not open to the password');
    if (stored.keystoreSha256 !== digest) throw new Error('the staged seal names another keystore');
    // Published as those verified bytes, atomically (temp file and rename).
    pin.guard(site);
    keys.write(SEALED_FILE, encodeSeal(stored.ciphertext, digest));
    // The keystore can still change while that write runs: checked once
    // more, and a seal now bound to the wrong keystore is taken back.
    if (keystoreDigest(keys) !== digest) {
      withdrawSeal(keys);
      // A strict pin fails closed whatever happened to the withdrawal, so
      // the config.yaml password stays where it is.
      throw pin.changed();
    }
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
    entries = keys.entries();
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
 * @param {{pin?: KeystorePin}} [options] the keystore the caller decided
 *   against (ensureConfig); otherwise keys/swarm.key as it is now
 * @returns {Promise<string|null>}
 * @throws {KeystorePasswordUnavailableError} when it cannot be read or
 *   decrypted, was sealed for another keystore than the pinned one, the
 *   keystore changed while it was opened, or (Linux) was not sealed with a
 *   keyring's key
 */
async function unsealPassword(data, { pin } = {}) {
  const keystorePin = pin || pinKeystore(data);
  const { keys, close } = openKeys(data, { create: false });
  try {
    if (!hasEntry(keys, SEALED_FILE)) return null;
    const storage = await availableStorage();
    if (!storage) throw new KeystorePasswordUnavailableError();
    try {
      const record = readSeal(keys, SEALED_FILE);
      if (record === null) return null;
      if (!keyedByKeyring(record.ciphertext)) throw new Error('not sealed with a keyring key');
      // Checked before the seal is trusted (or the keychain asked): a seal
      // for another keystore than the pinned one is a broken pair.
      if (record.keystoreSha256 !== keystorePin.expected) {
        throw new Error('the seal belongs to another keystore');
      }
      const { result, shouldReEncrypt } = await storage.decryptStringAsync(record.ciphertext);
      if (typeof result !== 'string' || !result) throw new Error('empty password');
      // The keychain rotated its key: store it under the current one.
      if (shouldReEncrypt) await resealInto(keys, storage, result, keystorePin);
      // Handed back only for the keystore it was sealed for, after every
      // await above.
      keystorePin.guard('unseal');
      return result;
    } catch (err) {
      if (err instanceof KeystorePasswordUnavailableError) throw err;
      throw new KeystorePasswordUnavailableError(err);
    }
  } finally {
    close();
  }
}

async function resealInto(keys, storage, password, pin) {
  try {
    const ciphertext = await storage.encryptStringAsync(password);
    if (keyedByKeyring(ciphertext))
      await sealInto(keys, storage, ciphertext, password, pin, 'reseal');
  } catch (err) {
    if (err instanceof KeystorePasswordUnavailableError) throw err;
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

// Remove the entry `name` from the handoff directory, through its handle.
// A file (a handoff, or a temp file a killed write left) or a planted link
// is unlinked, never followed. A directory (an older layout's, or planted)
// has its files removed; the directory itself goes only where it can be
// removed relative to the handle (Linux), and is otherwise left empty
// rather than removed by path (#963).
// @returns {boolean} whether the entry is gone
function removeHandoffEntry(root, name) {
  try {
    return root.remove(name) || true;
  } catch (err) {
    if (err.code !== 'EISDIR' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  }
  const dir = root.openDir(name, { create: false });
  if (!dir) return true;
  try {
    for (const entry of dir.entries()) dir.remove(entry);
  } finally {
    dir.close();
  }
  try {
    root.removeDir(name);
    return true;
  } catch (err) {
    if (err instanceof UnsafePrivatePathError) return false;
    throw err;
  }
}

/**
 * Write `password` where antd's `--password-file` can read it: a 0600 file
 * of its own in the profile's one handoff directory, handoffRoot(userDataDir)
 * (0700, reused by every launch), written through held directory handles.
 * Call `remove()` once antd has read it (its API is up) or has exited; it is
 * idempotent, and a removal that failed is tried again on the next call.
 * @returns {{ path: string, remove: () => boolean }}
 */
function writePasswordFile(password, userDataDir) {
  const name = `password-${crypto.randomBytes(8).toString('hex')}`;
  const file = path.join(handoffRoot(userDataDir), name);
  liveHandoffs.add(file);
  let removed = false;
  const remove = () => {
    // No longer needed: a later sweep may take it if this removal fails.
    liveHandoffs.delete(file);
    if (removed) return true;
    try {
      withHandoffRoot(userDataDir, (root) => root && root.remove(name), { create: false });
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
        root.write(name, password);
      },
      { create: true }
    );
  } catch (err) {
    remove();
    throw err;
  }
  return { path: file, remove };
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
        for (const entry of root.entries()) {
          if (liveHandoffs.has(path.join(handoffRoot(userDataDir), entry))) continue;
          try {
            if (removeHandoffEntry(root, entry)) removed += 1;
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
 * Whether `password` decrypts keys/swarm.key as it is on disk, to the
 * account its unencrypted `address` names (one scrypt run). No keystore is
 * nothing to check.
 * @param {import('../private-files').PrivateDir|string} data the data directory
 * @returns {Promise<{opens: boolean, digest: string|null}>} `digest`: the
 *   SHA-256 of the bytes checked
 */
async function keystoreOpensWith(data, password) {
  let raw;
  try {
    raw = withKeysDir(data, (keys) => (keys ? keys.read('swarm.key') : null));
  } catch {
    return { opens: false, digest: null };
  }
  if (raw === null) return { opens: true, digest: null };
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  try {
    const text = raw.toString('utf-8');
    const declared = String(JSON.parse(text)?.address || '')
      .toLowerCase()
      .replace(/^0x/, '');
    const { Wallet } = require('ethers');
    const wallet = await Wallet.fromEncryptedJson(text, password);
    return { opens: wallet.address.toLowerCase().slice(2) === declared, digest };
  } catch {
    return { opens: false, digest };
  }
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
  keystoreOpensWith,
  keystoreDigestOf,
  pinKeystore,
  sealedPasswordPath,
  _setSafeStorageForTests: (storage) => {
    safeStorageOverride = storage;
  },
  _setGuardHookForTests: (hook) => {
    guardHook = hook;
  },
};
