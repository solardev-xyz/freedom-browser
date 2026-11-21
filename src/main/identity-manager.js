/**
 * Identity Manager
 *
 * Orchestrates the unified identity system on top of the identity core
 * (freedom-cored, through core/vault-backend.js):
 * - vault lifecycle and lock state live in the core; nothing here holds keys
 * - vault-meta.json (public addresses, wallet records) is the core's from
 *   PRF-6(a) (freedom-core design 0013, "`vault-meta.json`"): every change
 *   goes through `accounts.*`, and the core writes the file with the vault
 *   on a create or an import. Main reads the file, never writing it, only
 *   for its synchronous lookups (`getVaultMeta`)
 * - node identities are written by the core (nodes.write_identity)
 * - IPC handlers for the renderer
 */

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const IPC = require('../shared/ipc-channels');
const fsOffload = require('./fs-offload');
const {
  getAntDataDir,
  getIdentityDataDir,
  getIpfsDataDir,
  getRadicleDataDir,
  prepareRadicleDataDir,
} = require('./profile-paths');
const { getActiveProfile } = require('./profile-resolver');
const { VAULT_LOCKED_MESSAGE, isVaultLockedError } = require('./wallet/vault-errors');
const { LEDGER_ERROR_CODES, createLedgerError } = require('./wallet/ledger/errors');
const { REMOTE_ERROR_CODES, createRemoteError } = require('./wallet/remote/errors');
const { forSenderWindow } = require('./windows/request-window');
const { vaultBackend } = require('./core/vault-backend');
const {
  blockNode,
  unblockNode,
  nodeWriteStatus,
  restoreNodeWrite,
} = require('./core/node-identity-guard');
const { withRadicleGate } = require('./radicle/radicled-gate');
const { radicleBackendKind } = require('./radicle/radicle-backend-kind');
const { withPrivateDir } = require('./private-files');
const keystorePassword = require('./swarm/ant-keystore-password');
const { verifiedDeployments } = require('./wallet/safe/deployed-mark');

// Optional Bee node lifecycle hooks, wired by the main process (see index.js).
// Bee holds an exclusive LevelDB lock on statestore while running, so it must be
// stopped before its stale state is wiped during (re)injection — otherwise the
// wipe fails with EPERM on Windows (issue #90). `stop` resolves to whether Bee
// was running; `start` brings it back up with the freshly injected identity.
let beeLifecycle = { stop: null, start: null };

/**
 * Register Bee node lifecycle hooks used around identity (re)injection.
 * `needsKeyReinjection` answers whether the node's last start could not open
 * its keystore (K-3); the next unlock then re-injects the key.
 * `refuseKeyReinjection(message)` reports that it would not: the keystore
 * holds another identity.
 * @param {{stop?: () => Promise<boolean>, start?: () => Promise<void>,
 *   needsKeyReinjection?: () => boolean,
 *   refuseKeyReinjection?: (message: string) => void}} hooks
 */
function setBeeLifecycle(hooks = {}) {
  beeLifecycle = {
    stop: typeof hooks.stop === 'function' ? hooks.stop : null,
    start: typeof hooks.start === 'function' ? hooks.start : null,
    needsKeyReinjection:
      typeof hooks.needsKeyReinjection === 'function' ? hooks.needsKeyReinjection : null,
    refuseKeyReinjection:
      typeof hooks.refuseKeyReinjection === 'function' ? hooks.refuseKeyReinjection : null,
  };
}

// Optional Radicle node lifecycle hook, wired by the main process (see
// index.js). The embedded node writes node/, cobs/ and storage/ while it
// runs, so a re-key must stop it, with proof that it stopped, before wiping
// them (R-8). `withStopped(work)` runs `work` as one operation of the node's
// lifecycle queue (radicle-manager withRadicleStopped): it stops the node
// (throwing, without running `work`, when the stop is not proven), awaits
// `work`, and restarts a node that was running. Starts, alias changes and
// other re-keys queue behind it. Under the freedom-radicled service the
// proof is the process's exit, which frees the home's gate for the core's
// write (freedom-core design 0008, "Identity changes").
let radicleLifecycle = { withStopped: null };

/**
 * Register the Radicle node lifecycle hook used around identity (re)injection.
 * @param {{withStopped?: <T>(work: () => Promise<T>) => Promise<T>}} hooks
 */
function setRadicleLifecycle(hooks = {}) {
  radicleLifecycle = {
    withStopped: typeof hooks.withStopped === 'function' ? hooks.withStopped : null,
  };
}

// Track which nodes have been injected
let injectedNodes = {
  bee: false,
  ipfs: false,
  radicle: false,
};

// Vault metadata file
const VAULT_META_FILE = 'vault-meta.json';
// The core's vault file (freedom-core fc-vault); only its existence is read here.
const VAULT_FILE = 'identity-vault.json';
const LEGACY_NON_CATALOG_BEE_API_PORT = 1633;
const LEGACY_NON_CATALOG_BEE_P2P_PORT = 1634;

/**
 * Get the path to the vault metadata file
 */
function getVaultMetaPath() {
  return path.join(getIdentityDataDir(), VAULT_META_FILE);
}

/**
 * Get vault metadata, read from the file the core writes: main's
 * synchronous lookups only (the account seams below, the locked status).
 * The chrome's reads go through the core (`accounts.meta`, `accounts.list`,
 * `accounts.active`).
 * @returns {Object|null} Metadata or null if not found
 */
function getVaultMeta() {
  const metaPath = getVaultMetaPath();
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (err) {
    console.error('[IdentityManager] Failed to read vault meta:', err.message);
    return null;
  }
}

/**
 * Addresses of mnemonic accounts and publisher keys from the core, or null
 * while the vault is locked. Public data only.
 * @param {{accounts?: number[], publishers?: number[]}} request
 */
async function deriveAddresses({ accounts = [], publishers = [] } = {}) {
  try {
    // keys.addresses takes at most 64 indices of each kind per request.
    const result = { user_wallets: [], publishers: [] };
    for (let i = 0; i === 0 || i < accounts.length || i < publishers.length; i += 64) {
      const part = await vaultBackend.addresses({
        accounts: accounts.slice(i, i + 64),
        publishers: publishers.slice(i, i + 64),
      });
      result.user_wallets.push(...part.user_wallets);
      result.publishers.push(...part.publishers);
      result.bee_wallet = part.bee_wallet;
      result.radicle = part.radicle;
    }
    return result;
  } catch (err) {
    if (isVaultLockedError(err)) return null;
    throw err;
  }
}

/**
 * Check if a vault exists
 * @returns {Promise<boolean>}
 */
async function hasVault() {
  try {
    return (await vaultBackend.status()).exists;
  } catch (err) {
    if (err.code !== 'core_unavailable') throw err;
    // The core is down. The file still tells whether this profile has a
    // vault (as before the core), so nodes keep their vault-backed mode.
    return fs.existsSync(path.join(getIdentityDataDir(), VAULT_FILE));
  }
}

/**
 * Check if vault is currently unlocked
 * @returns {Promise<boolean>}
 */
async function isVaultUnlocked() {
  return (await vaultBackend.status()).unlocked;
}

/**
 * Create a new vault with a generated mnemonic
 * @param {string} password - User's password
 * @param {number} strength - Mnemonic strength (128=12 words, 256=24 words)
 * @param {boolean} userKnowsPassword - Whether the user knows the password (false for Quick Setup)
 * @returns {Promise<string>} The generated mnemonic (for backup display)
 */
async function createNewVault(password, strength = 256, userKnowsPassword = true) {
  // The core writes the vault and its vault-meta.json (the public addresses,
  // shown without unlocking) as one operation, and unlocks after creation,
  // as before (design 0013, "The vault and its metadata, one write"). A lost
  // reply's reconcile needs nothing from main either: Quick Setup's
  // credential is written with the vault too (`quick_unlock: true`).
  const { mnemonic } = await vaultBackend.createVault(password, strength, { userKnowsPassword });
  console.log('[IdentityManager] New vault created');
  return mnemonic;
}

/**
 * Import an existing mnemonic into a new vault
 * @param {string} password - User's password
 * @param {string} mnemonic - The mnemonic to import
 * @param {boolean} userKnowsPassword - Whether the user knows the password (false for Quick Setup)
 * @param {{quickUnlock?: boolean}} [options] - `quickUnlock`: Quick Setup's
 *   vault, created with quick unlock's credential in the core (design 0013)
 * @returns {Promise<void>}
 */
async function importExistingMnemonic(
  password,
  mnemonic,
  userKnowsPassword = true,
  { quickUnlock = false } = {}
) {
  // The vault and its vault-meta.json, written by the core as one operation.
  await vaultBackend.importVault(password, mnemonic, {
    overwrite: false,
    quickUnlock,
    userKnowsPassword,
  });
  console.log('[IdentityManager] Mnemonic imported to vault');
}

/**
 * Unlock the vault with password
 * @param {string} password - User's password
 * @returns {Promise<void>}
 */
async function unlockVault(password) {
  await vaultBackend.unlock(password);
  console.log('[IdentityManager] Vault unlocked');
  afterUnlock();
}

/**
 * Unlock the vault with quick unlock's credential in the core, after main's
 * Touch ID prompt (design 0013, PRF-2b): the password stays in the core.
 * @returns {Promise<void>}
 */
async function quickUnlockVault() {
  await vaultBackend.quickUnlock();
  console.log('[IdentityManager] Vault unlocked with quick unlock');
  afterUnlock();
}

/**
 * The recovery phrase through quick unlock's credential, after main's Touch
 * ID prompt. The core unlocks the vault first, as the password flow does.
 * @returns {Promise<string>}
 */
async function quickExportMnemonic() {
  const mnemonic = await vaultBackend.quickExportMnemonic();
  afterUnlock();
  return mnemonic;
}

/**
 * One account's private key through quick unlock's credential, after main's
 * Touch ID prompt; the vault is unlocked first.
 * @returns {Promise<string>}
 */
async function quickExportPrivateKeyForAccount(accountIndex) {
  assertPrivateKeyExportable(accountIndex);
  const privateKey = await vaultBackend.quickExportPrivateKey(accountIndex);
  afterUnlock();
  return privateKey;
}

/**
 * What follows every unlock. An older vault-meta.json without `addresses`
 * gains them in the core, which writes them as both unlocks answer (design
 * 0013, "The unlock's migration").
 */
function afterUnlock() {
  // The Swarm node could not open its keystore at its last start: the core
  // writes it again, same key, with a new password (K-3).
  if (beeLifecycle.needsKeyReinjection?.() === true) {
    void reencryptBeeKeystore().catch((err) => {
      console.warn('[IdentityManager] Could not re-inject the Swarm key:', err.message);
    });
  }
}

/**
 * Lock the vault
 */
async function lockVault() {
  await vaultBackend.lock();
  console.log('[IdentityManager] Vault locked');
}

/**
 * The Bee wallet's address, or null while the vault is locked.
 * @returns {Promise<string|null>}
 */
async function getBeeWalletAddress() {
  const addresses = await deriveAddresses();
  return addresses ? addresses.bee_wallet : null;
}

/**
 * A Swarm publisher key's address (owner lookups need no private key).
 * @param {number} originIndex
 * @returns {Promise<string>}
 */
async function getPublisherAddress(originIndex) {
  if (typeof originIndex !== 'number' || originIndex < 0 || !Number.isInteger(originIndex)) {
    throw new Error('Origin index must be a non-negative integer');
  }
  const addresses = await deriveAddresses({ publishers: [originIndex] });
  if (!addresses) {
    throw new Error('Vault must be unlocked to derive publisher keys');
  }
  return addresses.publishers[0].address;
}

/**
 * Check if the Swarm identity has been injected into Ant's data directory.
 */
function isBeeIdentityInjected() {
  const dataDir = getAntDataDir();
  const keystorePath = path.join(dataDir, 'keys', 'swarm.key');
  return fs.existsSync(keystorePath);
}

function isIpfsIdentityPrepared() {
  return false;
}

/**
 * Check if IPFS has an active injected runtime identity.
 *
 * The desktop app now uses native freedom-ipfs as a read-oriented retrieval
 * node. It deliberately uses ephemeral libp2p identities today, so there is no
 * durable vault-derived PeerID to report as injected.
 */
function isIpfsIdentityInjected() {
  return false;
}

/**
 * Check if Radicle identity has been injected
 */
function isRadicleIdentityInjected() {
  const dataDir = getRadicleDataDir();
  const keyPath = path.join(dataDir, 'keys', 'radicle');
  return fs.existsSync(keyPath);
}

/**
 * Read the active native IPFS PeerID (no unlock required).
 *
 * Native freedom-ipfs uses ephemeral libp2p identities for retrieval today and
 * does not expose a stable app/node PeerID.
 * @returns {string|null}
 */
function readIpfsPeerId() {
  return null;
}

/**
 * Read Radicle DID from public key file (no unlock required)
 * The file is in OpenSSH format: "ssh-ed25519 <base64> <comment>"
 * @returns {Promise<string|null>}
 */
async function readRadicleDid() {
  const dataDir = await prepareRadicleDataDir();
  const pubKeyPath = path.join(dataDir, 'keys', 'radicle.pub');

  if (!fs.existsSync(pubKeyPath)) {
    return null;
  }

  try {
    // Read the OpenSSH format public key
    const pubKeyContent = fs.readFileSync(pubKeyPath, 'utf-8').trim();
    // Format: "ssh-ed25519 <base64> <comment>"
    const parts = pubKeyContent.split(' ');
    if (parts.length < 2 || parts[0] !== 'ssh-ed25519') {
      console.error('[IdentityManager] Invalid Radicle public key format');
      return null;
    }

    // Decode base64 blob
    const blob = Buffer.from(parts[1], 'base64');
    // OpenSSH blob format: uint32 keytype_len, keytype, uint32 pubkey_len, pubkey
    // Skip keytype (4 bytes len + 11 bytes "ssh-ed25519" = 15 bytes)
    // Then read pubkey (4 bytes len + 32 bytes key)
    const keytypeLen = blob.readUInt32BE(0);
    const pubkeyOffset = 4 + keytypeLen;
    const pubkeyLen = blob.readUInt32BE(pubkeyOffset);
    const publicKey = blob.slice(pubkeyOffset + 4, pubkeyOffset + 4 + pubkeyLen);

    return await vaultBackend.radicleDid(publicKey);
  } catch (err) {
    console.error('[IdentityManager] Failed to read Radicle DID:', err.message);
    return null;
  }
}

function getBeeApiPortForIdentityConfig() {
  const profile = getActiveProfile();
  const apiPort = profile?.metadata?.nodes?.bee?.apiPort;
  if (Number.isInteger(apiPort)) {
    return apiPort;
  }

  if (!profile || profile.source !== 'catalog') {
    return LEGACY_NON_CATALOG_BEE_API_PORT;
  }

  throw new Error('Active profile is missing a Bee API port');
}

function getBeeP2pPortForIdentityConfig() {
  const profile = getActiveProfile();
  const p2pPort = profile?.metadata?.nodes?.bee?.p2pPort;
  if (Number.isInteger(p2pPort)) {
    return p2pPort;
  }

  if (!profile || profile.source !== 'catalog') {
    return LEGACY_NON_CATALOG_BEE_P2P_PORT;
  }

  throw new Error('Active profile is missing a Bee P2P port');
}

// On Windows, deleting LevelDB-backed dirs (statestore/localstore) throws
// EPERM while the node still holds the `LOCK` file open without
// FILE_SHARE_DELETE (issue #90). Node's own rm maxRetries/retryDelay does
// NOT help here: on Windows an open-handle EPERM is short-circuited by
// libuv/Node's fixWinEPERM path (which only clears a read-only *attribute*) and
// never reaches the retry-sleep loop, so it throws immediately. We therefore
// run our own retry loop, giving the node a moment to exit and the OS to
// release the handle. Verified on Windows on ARM against a real Bee node.
//
// Neither the delete nor the back-off blocks the main thread (#513): node data
// can be several GB (the rm runs in a worker via fs-offload, which preserves
// rmSync's error codes for the check below), and the back-off adds up to
// ~4.5 s across attempts (an async delay, not Atomics.wait).
const RM_MAX_ATTEMPTS = 10;
const RM_RETRY_DELAY_MS = 100;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recursively remove a path, retrying on transient Windows lock errors
 * (EPERM/EBUSY) until the holding process exits and releases the handle.
 * Resolves true if the path existed and was removed.
 * @param {string} targetPath - Absolute path to remove
 * @returns {Promise<boolean>}
 */
async function removePathWithRetry(targetPath) {
  // Same "does it exist" answer fs.existsSync gave (follows symlinks, any
  // stat error reads as absent), without the sync syscall.
  try {
    await fs.promises.stat(targetPath);
  } catch {
    return false;
  }
  for (let attempt = 1; attempt <= RM_MAX_ATTEMPTS; attempt++) {
    try {
      await fsOffload.removePath(targetPath, { recursive: true, force: true });
      return true;
    } catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'ENOTEMPTY';
      if (!transient || attempt === RM_MAX_ATTEMPTS) {
        throw err;
      }
      await delay(attempt * RM_RETRY_DELAY_MS);
    }
  }
  return true;
}

/**
 * Remove Bee's persisted state directories so a freshly injected identity
 * isn't mixed with state derived from the previous key. Sequential, in the
 * listed order.
 * @param {string} dataDir - Bee data directory
 */
async function removeStaleBeeDirs(dataDir) {
  const staleDirs = ['statestore', 'localstore', 'kademlia-metrics', 'stamperstore'];
  for (const dir of staleDirs) {
    if (await removePathWithRetry(path.join(dataDir, dir))) {
      console.log(`[IdentityManager] Removed old ${dir} (identity change)`);
    }
  }
}

/**
 * Wipe Bee's stale persisted state ahead of a fresh key injection.
 *
 * A running Bee node holds an exclusive LevelDB lock on `statestore`; on Windows
 * deleting it then fails with EPERM (issue #90). The retry loop in
 * removePathWithRetry only helps if the holder exits, so we first stop the node
 * via the registered lifecycle hook and wait for it to exit, releasing the lock.
 *
 * @param {string} dataDir - Bee data directory
 * @returns {Promise<boolean>} whether Bee was running and was stopped
 */
async function wipeStaleBeeState(dataDir) {
  let beeWasRunning = false;
  if (beeLifecycle.stop) {
    try {
      beeWasRunning = (await beeLifecycle.stop()) === true;
    } catch (err) {
      console.warn('[IdentityManager] Bee stop hook failed before wipe:', err.message);
    }
  }

  // When re-injecting with a new key, Bee's persisted state (overlay address,
  // auxiliary keys) becomes invalid. Remove everything except the directories
  // we're about to write fresh (keys/ and config.yaml).
  try {
    await removeStaleBeeDirs(dataDir);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY') {
      throw new Error(
        'Could not reset node data because it is still in use. ' +
          'Please close Freedom completely and try again.',
        { cause: err }
      );
    }
    throw err;
  }
  for (const keyFile of ['libp2p_v2.key', 'pss.key']) {
    if (await removePathWithRetry(path.join(dataDir, 'keys', keyFile))) {
      console.log(`[IdentityManager] Removed old ${keyFile} (password mismatch prevention)`);
    }
  }

  // antd self-generates a native node identity (identity.json + signing.key)
  // whenever it starts on a data dir that has no injected `keys/swarm.key`
  // (e.g. the node auto-started at launch before the vault was unlocked). If
  // those files survive, antd keeps that throwaway identity instead of loading
  // the swarm.key we're about to inject — so the node would run under the wrong
  // wallet (different overlay, none of the user's postage stamps or chequebook).
  // Remove them so the injected keystore becomes the sole identity on restart.
  for (const idFile of ['identity.json', 'signing.key']) {
    if (await removePathWithRetry(path.join(dataDir, idFile))) {
      console.log(`[IdentityManager] Removed antd self-generated ${idFile} (identity injection)`);
    }
  }

  return beeWasRunning;
}

// One re-keying per node at a time: stop, wipe, write and restart are one
// unit, so one attempt's success can't lift the block of another that is
// still wiping or writing (node-identity-guard.js).
const nodeInjections = new Map();

function serializedInjection(node, task) {
  const run = (nodeInjections.get(node) || Promise.resolve()).then(task);
  nodeInjections.set(
    node,
    run.catch(() => {})
  );
  return run;
}

/**
 * The core has just installed keys/swarm.key under a new password, which it
 * wrote into config.yaml (nodes.write_identity). A seal of the previous
 * keystore's password is dropped here: nothing is sealed at injection, and
 * the next node start seals the new password and removes its config.yaml
 * line (ant-manager ensureConfig, K-3). The seal's swarm.key digest would
 * refuse the old seal anyway, but left in place it would keep that start
 * from migrating. Called under the keystore lock.
 */
function forgetPreviousSeal(dataDir) {
  try {
    keystorePassword.forgetSealedPassword(dataDir);
  } catch (err) {
    // The next start then uses the config.yaml password, once it has
    // checked that it opens the keystore, and leaves the seal alone.
    console.warn('[IdentityManager] Could not remove the previous keystore seal:', err.message);
  }
}

/**
 * Inject Bee identity
 * The core generates its own random password for the keystore, separate from
 * the vault password, and writes it into config.yaml; the next node start
 * seals it in the OS keychain where there is one (K-3).
 * @returns {Promise<{address: string}>}
 */
function injectBeeIdentity() {
  return serializedInjection('bee', injectBeeIdentityNow);
}

async function injectBeeIdentityNow() {
  if (!(await isVaultUnlocked())) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }
  const dataDir = getAntDataDir();
  // Read the ports first: a missing one fails before anything is wiped.
  const apiPort = getBeeApiPortForIdentityConfig();
  const p2pPort = getBeeP2pPortForIdentityConfig();

  // The public address first: a write reconciled after a lost reply only
  // reports its status.
  const expected = await deriveAddresses();
  if (!expected) throw new Error(VAULT_LOCKED_MESSAGE);

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // From here until the write is known to be installed, Bee must not start:
  // its files may be wiped or half written (node-identity-guard.js).
  blockNode('bee', 'writing');
  let beeWasRunning;
  let result;
  try {
    // Under the data directory's keystore lock (K-3), so neither a node
    // start's config step (ant-manager ensureConfig: its seal, its
    // migration) nor an automatic recovery reads or writes the keystore and
    // its password in between.
    ({ beeWasRunning, result } = await keystorePassword.withKeystoreLock(dataDir, async () => {
      // Stop Bee (if running) and wipe its stale state before writing fresh keys.
      const wasRunning = await wipeStaleBeeState(dataDir);
      // The core writes keys/swarm.key (under a fresh random keystore password,
      // separate from the vault password) and config.yaml together, through
      // its journal, so the keystore and its password always match.
      const written = await vaultBackend.writeNodeIdentity(
        { node: 'bee', data_dir: dataDir, api_port: apiPort, p2p_port: p2pPort },
        crypto.randomUUID()
      );
      if (written.status === 'installed') forgetPreviousSeal(dataDir);
      return { beeWasRunning: wasRunning, result: written };
    }));
  } catch (err) {
    blockNode('bee', 'pending_recovery');
    throw err;
  }
  if (result.status !== 'installed') {
    // Keep Bee stopped until a later write installs its identity.
    blockNode('bee', result.status);
    throw new Error(`The Bee identity write did not finish (${result.status})`);
  }
  unblockNode('bee');

  injectedNodes.bee = true;

  // If we stopped a running node to wipe it, bring it back up with the new
  // identity so the user isn't left with a silently-stopped node.
  if (beeWasRunning && beeLifecycle.start) {
    try {
      await beeLifecycle.start();
    } catch (err) {
      console.warn('[IdentityManager] Bee start hook failed after injection:', err.message);
    }
  }

  const address = result.address || expected.bee_wallet;
  console.log(`[IdentityManager] Bee identity injected: ${address}`);
  return { address };
}

// The recovery running for each Swarm data directory, if any: a second
// unlock while it runs joins it instead of starting another.
const keystoreRecoveries = new Map();

/**
 * Re-encrypt the Swarm keystore with a new password after its sealed one
 * stopped decrypting (a reset keychain, a profile copied to another
 * machine). The core writes the same key again (nodes.write_identity), so
 * the node keeps its identity and state; nothing is wiped. Starts the node
 * again.
 *
 * Only for the unlocked vault's own identity: the keystore's unencrypted
 * `address` must be the derived Swarm address. A keystore of another
 * identity (an imported data directory, another vault's), or one whose
 * address cannot be read, is never overwritten; the node reports it
 * instead, and a manual re-injection remains possible.
 *
 * One recovery at a time per data directory. It is a re-keying like
 * injection (serializedInjection), so neither lifts the other's node block,
 * and runs under the same keystore lock as injection and the node's startup
 * migration (ant-manager ensureConfig), so the keystore on disk always ends
 * with its own password.
 * @returns {Promise<boolean>} whether the keystore was re-encrypted
 */
function reencryptBeeKeystore() {
  let dataDir;
  try {
    dataDir = path.resolve(getAntDataDir());
  } catch (err) {
    return Promise.reject(err);
  }
  const running = keystoreRecoveries.get(dataDir);
  if (running) return running;
  const recovery = serializedInjection('bee', () => recoverBeeKeystore(dataDir)).finally(() => {
    keystoreRecoveries.delete(dataDir);
  });
  keystoreRecoveries.set(dataDir, recovery);
  return recovery;
}

async function recoverBeeKeystore(dataDir) {
  if (!(await isVaultUnlocked())) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }
  // Read the ports first: a missing one fails before anything is written.
  const apiPort = getBeeApiPortForIdentityConfig();
  const p2pPort = getBeeP2pPortForIdentityConfig();
  const expected = await deriveAddresses();
  if (!expected) throw new Error(VAULT_LOCKED_MESSAGE);
  const derived = String(expected.bee_wallet).toLowerCase().replace(/^0x/, '');

  const recovered = await keystorePassword
    .withKeystoreLock(dataDir, async () => {
      // An earlier recovery or an injection may have settled it meanwhile.
      if (beeLifecycle.needsKeyReinjection && beeLifecycle.needsKeyReinjection() !== true) {
        return false;
      }
      if (keystorePassword.keystoreAddress(dataDir) !== derived) {
        throw new keystorePassword.KeystoreIdentityMismatchError();
      }
      // The same key again: the node's state stays valid, so nothing is
      // wiped (wipeStaleBeeState). Until the write is known to be
      // installed, Bee must not start (node-identity-guard.js).
      blockNode('bee', 'writing');
      let result;
      try {
        result = await vaultBackend.writeNodeIdentity(
          { node: 'bee', data_dir: dataDir, api_port: apiPort, p2p_port: p2pPort },
          crypto.randomUUID()
        );
      } catch (err) {
        blockNode('bee', 'pending_recovery');
        throw err;
      }
      if (result.status !== 'installed') {
        blockNode('bee', result.status);
        throw new Error(`The Bee identity write did not finish (${result.status})`);
      }
      forgetPreviousSeal(dataDir);
      unblockNode('bee');
      return true;
    })
    .catch((err) => {
      if (err instanceof keystorePassword.KeystoreIdentityMismatchError) {
        console.warn('[IdentityManager] Not re-injecting the Swarm key:', err.message);
        beeLifecycle.refuseKeyReinjection?.(err.message);
      }
      throw err;
    });
  if (!recovered) return false;
  injectedNodes.bee = true;
  console.log('[IdentityManager] Swarm keystore re-encrypted with a new password');
  // Outside the lock: the start takes it again for its config.
  if (beeLifecycle.start) {
    await beeLifecycle.start();
  }
  return true;
}

/**
 * Report IPFS identity mode.
 *
 * Native freedom-ipfs currently uses ephemeral identities by design. Keep IPFS
 * visible in onboarding/status, but do not derive or persist a stable PeerID
 * that the runtime cannot consume.
 * @returns {Promise<{mode: string, active: boolean, peerId: null, stableIdentitySupported: boolean}>}
 */
async function injectIpfsIdentity() {
  if (!(await isVaultUnlocked())) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }

  injectedNodes.ipfs = false;

  console.log('[IdentityManager] IPFS uses ephemeral native identities for retrieval');
  return {
    mode: 'ephemeral',
    active: false,
    peerId: null,
    stableIdentitySupported: false,
  };
}

/**
 * Inject Radicle identity: on the add-on, the key file the add-on loads; on
 * the freedom-radicled service, an identity change, which writes no key
 * (changeRadicleIdentityOnService).
 * @param {string} alias - Node alias
 * @returns {Promise<{did: string}>}
 */
function injectRadicleIdentity(alias = 'FreedomBrowser') {
  return serializedInjection('radicle', () => injectRadicleIdentityNow(alias));
}

async function injectRadicleIdentityNow(alias) {
  if (!(await isVaultUnlocked())) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }

  const dataDir = await prepareRadicleDataDir();

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const expected = await deriveAddresses();
  if (!expected) throw new Error(VAULT_LOCKED_MESSAGE);

  if (radicleBackendKind() === 'service') {
    await changeRadicleIdentityOnService(dataDir, alias);
    // The sealed form returns no DID: the node runs as the derived one,
    // released sealed at its next start.
    const did = expected.radicle.did;
    console.log(`[IdentityManager] Radicle identity changed: ${did}`);
    return { did };
  }

  // The wipe and the key write, with the node stopped (R-8). blockNode keeps
  // new starts out, but it does not stop a node that is already running, so
  // they run inside one operation of the node's lifecycle queue: the node is
  // stopped, with the add-on's proof, before the first removal, and nothing
  // starts it again until the key is written (or the write fails); then it
  // restarts if it was running. A stop without proof throws before any of
  // this, and the data is left alone. Only an installed write unblocks the
  // node, so after a failed one the restart is refused with its reason. The
  // core refuses the write while the vault is locked.
  //
  // The wipe runs under the home's gate (freedom-core design 0008, "Spawn
  // and lock"; radicle/radicled-gate.js): the add-on's proved stop shows
  // only that this process's node stopped, not that no other writer (a
  // freedom-radicled service, another build's add-on) holds the home. A
  // gate held elsewhere refuses the re-key before anything is removed, and
  // blocks nothing. The gate is let go before the core's write, which takes
  // the same gate itself: main never holds it while the core needs it (0008,
  // "Identity changes").
  const rekey = async () => {
    // Set once the gate is held and the wipe may begin.
    let begun = false;
    let written;
    try {
      // When re-injecting with a new key, Radicle's persisted node state
      // (fingerprint, routing db, etc.) becomes invalid. Remove stale state
      // directories.
      await withRadicleGate(dataDir, async (gate) => {
        blockNode('radicle', 'writing');
        begun = true;
        const staleDirs = ['node', 'cobs', 'storage'];
        for (const dir of staleDirs) {
          if (gate.gated && !gate.held()) {
            throw new Error("The Radicle home's lock was lost; its data was not fully reset");
          }
          if (await removePathWithRetry(path.join(dataDir, dir))) {
            console.log(`[IdentityManager] Removed old ${dir} (identity change)`);
          }
        }
      });
      // The core writes keys/radicle, keys/radicle.pub and the config.json
      // alias together, through its journal, under the home's gate.
      written = await vaultBackend.writeNodeIdentity(
        { node: 'radicle', home: dataDir, alias },
        crypto.randomUUID()
      );
    } catch (err) {
      if (begun) blockNode('radicle', 'pending_recovery');
      throw err;
    }
    if (written.status !== 'installed') {
      blockNode('radicle', written.status);
      throw new Error(`The Radicle identity write did not finish (${written.status})`);
    }
    unblockNode('radicle');

    injectedNodes.radicle = true;
    return written;
  };
  const result = radicleLifecycle.withStopped
    ? await radicleLifecycle.withStopped(rekey)
    : await rekey();

  const did = result.did || expected.radicle.did;
  console.log(`[IdentityManager] Radicle identity injected: ${did}`);
  return { did };
}

// The waits before each retry of a Radicle identity change the core answered
// `lock_held` or `pending_recovery` (changeRadicleIdentityOnService): five
// writes in all. Each `lock_held` comes after the core's own 5 s on the gate.
const RADICLE_CHANGE_RETRY_MS = Object.freeze([1_000, 2_000, 4_000, 8_000]);
const radicleChangeRetry = { delaysMs: RADICLE_CHANGE_RETRY_MS };
const RADICLE_HOME_IN_USE =
  'The Radicle data is in use by another process. Close it and try again.';

/**
 * A Radicle identity change on the freedom-radicled service (freedom-core
 * design 0008, "Identity changes"; 0001, "Multi-file writes"). One owner
 * holds the home's gate at each step:
 * 1. the lifecycle hook stops the service; its exit frees the gate;
 * 2. the core takes the gate for the whole change: `nodes.write_identity
 *    { node: 'radicle', home, alias, custody: 'sealed', wipe: true }`
 *    journals the wipe of node/, cobs/ and storage/ and the removal of
 *    keys/radicle and keys/radicle.pub, then does them and installs the
 *    config. No key file is written, and main removes nothing itself;
 * 3. the hook starts the service again if it was running. Main's block
 *    (node-identity-guard.js), set before the first write, comes off only on
 *    `installed`, so after any outcome that may have written the start is
 *    refused with its reason.
 *
 * `lock_held` (another process holds the gate, the core touched nothing)
 * and `pending_recovery` (the core committed but couldn't finish) keep the
 * service stopped, and the write is tried again, after each of
 * RADICLE_CHANGE_RETRY_MS: a later write finishes an outstanding journal
 * before its own. Out of tries, `pending_recovery` keeps the block, which
 * the core's startup recovery at the next launch resolves; `lock_held`
 * alone wrote nothing, so main's record goes back to what it was, and the
 * node restarts as it was, as after a re-key that failed before its write.
 * Other error replies wrote nothing either; a lost reply
 * (`core_unavailable`) may have, and keeps the block.
 */
async function changeRadicleIdentityOnService(home, alias) {
  const change = async () => {
    const before = nodeWriteStatus('radicle');
    blockNode('radicle', 'writing');
    // Whether an answer so far may have left the home part-written.
    let unfinished = false;
    const giveUp = (err) => {
      if (unfinished) blockNode('radicle', 'pending_recovery');
      else restoreNodeWrite('radicle', before);
      throw err;
    };
    const delays = radicleChangeRetry.delaysMs;
    let failure = null;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (attempt > 0) await delay(delays[attempt - 1]);
      let written;
      try {
        written = await vaultBackend.writeNodeIdentity(
          { node: 'radicle', home, alias, custody: 'sealed', wipe: true },
          crypto.randomUUID()
        );
      } catch (err) {
        if (err?.code === 'lock_held') {
          console.warn('[IdentityManager] The Radicle home is in use; the identity change waits');
          failure = Object.assign(new Error(RADICLE_HOME_IN_USE), { code: 'lock_held' });
          continue;
        }
        if (err?.code === 'core_unavailable') unfinished = true;
        return giveUp(err);
      }
      const status = typeof written?.status === 'string' ? written.status : 'unknown';
      if (status === 'installed') {
        unblockNode('radicle');
        injectedNodes.radicle = true;
        return written;
      }
      // pending_recovery: the core finishes it at the next start, so the
      // message onboarding shows says so.
      const unfinishedWrite = new Error(
        status === 'pending_recovery'
          ? 'The Radicle identity write did not finish (pending_recovery); restart Freedom to complete it, or try the change again'
          : `The Radicle identity write did not finish (${status})`
      );
      if (status !== 'pending_recovery') {
        // corrupt: only a fresh write while unlocked repairs it.
        blockNode('radicle', status);
        throw unfinishedWrite;
      }
      console.warn('[IdentityManager] The Radicle identity write is pending recovery; retrying');
      unfinished = true;
      failure = unfinishedWrite;
    }
    return giveUp(failure);
  };
  return radicleLifecycle.withStopped ? radicleLifecycle.withStopped(change) : change();
}

/**
 * Inject all identities
 * @param {string} radicleAlias - Alias for Radicle node
 * @param {boolean} force - Force overwrite even if keys exist
 * @returns {Promise<Object>}
 */
async function injectAllIdentities(radicleAlias = 'FreedomBrowser', force = false) {
  const addresses = await deriveAddresses({ accounts: [0] });
  if (!addresses) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }

  const results = {
    // Include user wallet (Account 0) - not injected anywhere, just derived
    userWallet: { address: addresses.user_wallets[0].address },
    // Track if any node was re-injected (needs restart)
    needsRestart: [],
  };

  // Inject Bee (only if not already injected OR force)
  // The core generates its own random keystore password
  if (force || !isBeeIdentityInjected()) {
    const wasInjected = isBeeIdentityInjected();
    results.bee = await injectBeeIdentity();
    if (wasInjected && force) {
      // Bee's restart is owned by injectBeeIdentity (via the lifecycle hook),
      // which stops the lock-holding node before the wipe and starts it again
      // with the new key. Deliberately NOT added to needsRestart so the
      // renderer doesn't restart Bee a second time (issue #90).
      results.bee.reinjected = true;
    }
  } else {
    results.bee = { address: addresses.bee_wallet, alreadyInjected: true };
  }

  // Native freedom-ipfs uses ephemeral libp2p identities for read-only
  // retrieval today. Keep this in the result so onboarding can show IPFS as an
  // intentional identity mode rather than a failed injection.
  results.ipfs = await injectIpfsIdentity();

  // Inject Radicle (only if not already injected OR force). Finish any pending
  // carry-over of an older profile's Radicle home first: judged against a
  // short home still being migrated, the identity would read as missing and
  // re-injection would wipe the node/cobs/storage that are on their way in.
  await prepareRadicleDataDir();
  if (radicleBackendKind() === 'service') {
    // Under the freedom-radicled service no key is injected: the derived
    // identity arrives sealed at each start. Only a forced re-injection is an
    // identity change, which wipes the node's state (freedom-core design
    // 0008, "Identity changes": "When"). The service writes no key file, so
    // keys/ says nothing either way and isn't read.
    if (force) {
      results.radicle = await injectRadicleIdentity(radicleAlias);
      results.radicle.reinjected = true;
    } else {
      results.radicle = { did: addresses.radicle.did };
    }
  } else if (force || !isRadicleIdentityInjected()) {
    const wasInjected = isRadicleIdentityInjected();
    results.radicle = await injectRadicleIdentity(radicleAlias);
    if (wasInjected && force) {
      // Radicle's restart is owned by injectRadicleIdentity (the lifecycle
      // hook stops the node before the wipe and restarts it after), so it is
      // not in needsRestart: the renderer would restart it a second time.
      results.radicle.reinjected = true;
    }
  } else {
    results.radicle = { did: addresses.radicle.did, alreadyInjected: true };
  }

  console.log('[IdentityManager] All identities injected/verified');
  return results;
}

/**
 * Get identity status
 * Returns addresses without requiring vault unlock by reading from:
 * - vault-meta.json for wallet addresses (stored at vault creation)
 * - native IPFS mode (ephemeral; no durable PeerID today)
 * - Radicle public key for DID (the add-on); under the freedom-radicled
 *   service, the running generation's identity (see radicleServiceStatus)
 * @returns {Promise<Object>}
 */
async function getIdentityStatus() {
  const onRadicleService = radicleBackendKind() === 'service';
  // The add-on's DID is read from the home's keys/, once a pending
  // carry-over of an older profile's home has landed. The service's isn't.
  if (!onRadicleService) await prepareRadicleDataDir();
  const hasVaultResult = await hasVault();
  const isUnlocked = await isVaultUnlocked();

  // Try to get addresses - works even when vault is locked
  let addresses = null;
  const derived = isUnlocked ? await deriveAddresses({ accounts: [0] }) : null;
  const radicle = onRadicleService ? radicleServiceStatus(derived) : null;

  if (derived) {
    // Vault is unlocked - from the core (most accurate)
    addresses = {
      userWallet: derived.user_wallets[0].address,
      beeWallet: derived.bee_wallet,
      ipfsPeerId: null,
      radicleDid: radicle ? (radicle.active?.did ?? null) : derived.radicle.did,
    };
  } else if (hasVaultResult) {
    // Vault is locked - read from stored metadata and node config files
    const meta = getVaultMeta();

    addresses = {
      userWallet: meta?.addresses?.userWallet || null,
      beeWallet: meta?.addresses?.beeWallet || null,
      ipfsPeerId: readIpfsPeerId(),
      radicleDid: radicle ? (radicle.active?.did ?? null) : await readRadicleDid(),
    };
  }

  return {
    hasVault: hasVaultResult,
    isUnlocked,
    beeInjected: isBeeIdentityInjected(),
    ipfsInjected: isIpfsIdentityInjected(),
    ipfsIdentityPrepared: isIpfsIdentityPrepared(),
    ipfsIdentityMode: 'ephemeral',
    ipfsStableIdentitySupported: false,
    ipfsNativeIdentityActive: false,
    // Under the service no key file is ever written, so its absence says
    // nothing (0008, "Main no longer reads keys/"): not consulted there.
    radicleInjected: onRadicleService ? false : isRadicleIdentityInjected(),
    addresses,
    ...(radicle ? { radicle } : {}),
  };
}

/**
 * The Radicle identities under the freedom-radicled service (freedom-core
 * design 0008, Main's side), neither read from the home's keys/:
 * - `active`: the running node's, `{ did, ephemeral }` from its generation's
 *   `rad.identity` reply, or null with no generation running. It alone is
 *   the DID shown for the node; `addresses.radicleDid` is its DID.
 * - `nextDid`: the identity Radicle will use at its next start, the derived
 *   DID from `keys.addresses` while the vault is unlocked, else null. Never
 *   the running node's: creating, locking or deleting the vault changes the
 *   running node's identity only at its next start.
 */
function radicleServiceStatus(derived) {
  const active = require('./radicle-manager').activeRadicleIdentity();
  return {
    active: active ? { did: active.did, ephemeral: active.ephemeral === true } : null,
    nextDid: derived?.radicle?.did ?? null,
  };
}

/**
 * Export the mnemonic for backup. The core verifies `password`, then needs
 * the vault unlocked (the JS order: password first, then the lock state).
 * @param {string} password
 * @returns {Promise<string>}
 */
async function exportMnemonic(password) {
  return vaultBackend.exportMnemonic(password);
}

/**
 * Throw unless `accountIndex` holds a vault-derived key that can be
 * exported. Same two-part guard as withVaultPrivateKey: the index range
 * alone is decisive, so a deleted device account (no record) cannot
 * export a phantom mnemonic key derived at its index.
 */
function assertPrivateKeyExportable(accountIndex) {
  const record = getWalletRecord(accountIndex);
  if (isHardwareWalletIndex(accountIndex) || (record && record.type !== WALLET_TYPES.MNEMONIC)) {
    throw new Error('This account has no exportable private key — the key never leaves its device');
  }
}

/**
 * Export one account's private key from the unlocked vault. The core
 * verifies `password` (typed, or unsealed by Touch ID) first.
 */
async function exportPrivateKeyForAccount(accountIndex, password) {
  assertPrivateKeyExportable(accountIndex);
  return vaultBackend.exportPrivateKey(password, accountIndex);
}

// ============================================
// Multi-Wallet Support
// ============================================

/**
 * Wallet account types. Entries in vault-meta's `derivedWallets[]` without
 * a `type` field predate hardware-wallet support and are mnemonic-derived.
 */
const WALLET_TYPES = {
  MNEMONIC: 'mnemonic',
  LEDGER: 'ledger',
  REMOTE: 'remote', // phone / other device signing over openlv
  SAFE: 'safe', // Safe smart account owned by other wallet records
};

/** User-facing labels for non-mnemonic account types (auto-names, error text). */
const DEVICE_LABELS = {
  [WALLET_TYPES.LEDGER]: 'Ledger',
  [WALLET_TYPES.REMOTE]: 'Phone',
  [WALLET_TYPES.SAFE]: 'Safe',
};

/**
 * Whether a device record's device has shown that it holds the record's
 * address. A record a device doesn't match is `mismatched`, kept, and
 * shown as such; a later match makes it `matched`. Only a `matched`
 * record can own a new Safe.
 *
 * - Ledger records (#1065): main reads the address back from the device
 *   at the record's path when an account is added, so a new record starts
 *   `matched`. Records added before that took the chrome's word for the
 *   address and start `unchecked`: the first Ledger connected with them
 *   (discovery, or the check before every signature) checks them.
 * - Phone records (#1078): main has the phone sign a fresh challenge as
 *   the account before adding it, so a new record starts `matched`.
 *   Records added before that start `unchecked`. The next time the phone
 *   answers for one (a check from Wallet Settings, or any phone signature
 *   main verifies) it becomes `matched`, or `mismatched` when the phone
 *   answers from another account.
 */
const ADDRESS_CHECK = {
  UNCHECKED: 'unchecked',
  MATCHED: 'matched',
  MISMATCHED: 'mismatched',
};

/** The device record types that carry an address check. */
const ADDRESS_CHECKED_TYPES = new Set([WALLET_TYPES.LEDGER, WALLET_TYPES.REMOTE]);

function addressCheckOf(record) {
  return record.addressCheck === ADDRESS_CHECK.MATCHED ||
    record.addressCheck === ADDRESS_CHECK.MISMATCHED
    ? record.addressCheck
    : ADDRESS_CHECK.UNCHECKED;
}

/** Type-specific record fields to expose through the record seams. */
function extraRecordFields(record) {
  const fields = {};
  if (record.path) {
    fields.path = record.path;
  }
  if (ADDRESS_CHECKED_TYPES.has(record.type)) {
    fields.addressCheck = addressCheckOf(record);
  }
  if (record.type === WALLET_TYPES.SAFE) {
    fields.owners = record.owners;
    fields.threshold = record.threshold;
    fields.saltNonce = record.saltNonce;
    fields.deployed = verifiedDeployments(record.deployed);
  }
  return fields;
}

/**
 * Hardware accounts are allocated from a disjoint, never-reused slice of
 * the wallet index space, starting here.
 *
 * A wallet's `index` is two things at once: the account id every
 * persisted reference stores (dApp permissions, Swarm publisher
 * identities, `activeWalletIndex`) and — for mnemonic accounts — the
 * BIP-44 account index its key is derived at. Letting hardware accounts
 * take ids from that same pool breaks both roles: the mnemonic account
 * at the squatted derivation index can never be re-created (the hardware
 * guards block derivation at that index), stranding any funds it holds,
 * and every persisted reference to that index silently rebinds to a
 * different address and signing backend. The core allocates hardware
 * indices, monotonic and never reused (`accounts.add_ledger`, …).
 */
const HARDWARE_INDEX_BASE = 1000000;

function isHardwareWalletIndex(index) {
  return Number.isInteger(index) && index >= HARDWARE_INDEX_BASE;
}

/**
 * The wallet list stored in vault-meta, with the implicit pre-multi-wallet
 * default (just the main wallet) when `derivedWallets` was never written.
 *
 * @param {Object} meta - Parsed vault-meta
 * @returns {Array<Object>} Raw derivedWallets entries
 */
function getWalletList(meta) {
  return (
    meta.derivedWallets || [
      { index: 0, name: 'Main Wallet', address: meta.addresses?.userWallet || null },
    ]
  );
}

/**
 * Look up a single wallet account record by index, normalized: `type`
 * always present, address falling back to the stored main-wallet address
 * for index 0. Returns null when the index is unknown.
 *
 * Used by the signer factory and the vault-access guard to decide which
 * signing backend an index resolves to — must stay synchronous and cheap.
 *
 * @param {number} walletIndex
 * @param {Object} [meta] - Already-loaded vault-meta, to skip the disk read
 * @returns {{index: number, name: string, address: string|null, type: string, path?: string}|null}
 */
function getWalletRecord(walletIndex, meta = getVaultMeta()) {
  if (!meta) {
    return null;
  }
  const record = getWalletList(meta).find((wallet) => wallet.index === walletIndex);
  if (!record) {
    return null;
  }
  let address = record.address || null;
  if (!address && record.index === 0) {
    address = meta.addresses?.userWallet || null;
  }
  return {
    index: record.index,
    name: record.name,
    address,
    type: record.type || WALLET_TYPES.MNEMONIC,
    ...extraRecordFields(record),
  };
}

/**
 * The wallet-list record stored with `address` (case-insensitive), as
 * getWalletRecord normalizes it, or null. An address names one record at
 * most: a second account at an address in the list is refused. Only stored
 * addresses count (a Safe's, a device's); synchronous and cheap.
 *
 * @param {string} address
 * @param {Object} [meta] - Already-loaded vault-meta, to skip the disk read
 * @returns {Object|null}
 */
function findWalletRecordByAddress(address, meta = getVaultMeta()) {
  if (!meta || typeof address !== 'string' || !address) return null;
  const wanted = address.toLowerCase();
  const found = getWalletList(meta).find(
    (wallet) => typeof wallet.address === 'string' && wallet.address.toLowerCase() === wanted
  );
  return found ? getWalletRecord(found.index, meta) : null;
}

/**
 * Get list of derived user wallets, from the core (`accounts.list`): mnemonic
 * accounts' addresses derived while the vault is unlocked, the stored ones
 * otherwise; the first list's default written once. `caller` is `'chrome'`
 * for the chrome's request, null for main's own.
 * @returns {Promise<Array<{index: number, name: string, address: string, type: string}>>}
 */
async function getDerivedWallets(caller = null) {
  return vaultBackend.accounts.list(caller);
}

/**
 * Refuse a device account address that is malformed or already in the
 * wallet list, or a wallet list that doesn't exist yet: main's check before
 * it asks the phone (the core checks again as it adds the record).
 *
 * @returns {Object} The vault meta
 */
function assertDeviceWalletAddable(type, address) {
  const label = DEVICE_LABELS[type];
  const { isAddress } = require('ethers');
  if (typeof address !== 'string' || !isAddress(address)) {
    throw new Error(`Invalid ${label} account address`);
  }

  const meta = getVaultMeta();
  if (!meta) {
    throw new Error('No vault found');
  }

  const duplicate = getWalletList(meta).find(
    (wallet) => wallet.address && wallet.address.toLowerCase() === address.toLowerCase()
  );
  if (duplicate) {
    throw new Error(`This account is already in your wallet list as "${duplicate.name}"`);
  }
  return meta;
}

/**
 * Add a Ledger hardware-wallet account.
 *
 * The address and path come from the chrome, which read them from the
 * device during discovery. Main doesn't take its word for the address: it
 * asks the attached device for the address at that path (without showing
 * it on the device) and refuses the account unless the two are the same
 * (#1065), so a compromised chrome can't list an address the user's
 * Ledger doesn't hold.
 *
 * @param {string} name - Display name ('' → auto "Ledger N")
 * @param {string} address - Checksummed address read from the device
 * @param {string} path - Derivation path in device format (e.g. "44'/60'/0'/0/0")
 * @returns {Promise<{index: number, name: string, address: string, type: string, path: string, addressCheck: string}>}
 */
async function addLedgerWallet(name, address, path) {
  if (typeof path !== 'string' || !path) {
    throw new Error('Missing derivation path for Ledger account');
  }
  const { isAddress } = require('ethers');
  if (typeof address !== 'string' || !isAddress(address)) {
    throw new Error('Invalid Ledger account address');
  }
  const { readAddresses } = require('./wallet/ledger/transport');
  const [onDevice] = await readAddresses([path]);
  if (typeof onDevice !== 'string' || onDevice.toLowerCase() !== address.toLowerCase()) {
    throw createLedgerError(LEDGER_ERROR_CODES.ADDRESS_MISMATCH);
  }
  // The core adds the record main checked, `matched`, at its next hardware
  // index (refusing a duplicate or a missing vault).
  return vaultBackend.accounts.addLedger({ name, address, path });
}

/**
 * Ledger records no device has matched yet (`unchecked` or
 * `mismatched`), for the check that runs when a Ledger is connected.
 *
 * @returns {Array<{index: number, name: string, address: string, path: string, addressCheck: string}>}
 */
function getLedgerRecordsToCheck() {
  const meta = getVaultMeta();
  if (!meta) {
    return [];
  }
  return getWalletList(meta)
    .filter((wallet) => wallet.type === WALLET_TYPES.LEDGER)
    .map((wallet) => getWalletRecord(wallet.index, meta))
    .filter((record) => record.addressCheck !== ADDRESS_CHECK.MATCHED);
}

/**
 * Add a remote (phone / other device) account, signing over openlv.
 *
 * The address comes from the chrome, which relays the phone's answer to
 * eth_requestAccounts. Main doesn't take its word for it (#1078): it has
 * the phone sign a fresh challenge as the account and refuses the account
 * unless the signature recovers to it, so a compromised chrome can't list
 * an address no key behind the phone session answers for. No answer
 * (timeout, cancel, rejection) adds nothing either.
 *
 * @param {string} name - Display name ('' → auto "Phone N")
 * @param {string} address - Address the phone reported via eth_requestAccounts
 * @returns {Promise<{index: number, name: string, address: string, type: string, addressCheck: string}>}
 */
async function addRemoteWallet(name, address) {
  // Malformed and duplicate addresses are refused before the phone is asked.
  assertDeviceWalletAddable(WALLET_TYPES.REMOTE, address);
  const { proveRemoteAccount } = require('./wallet/remote/account-proof');
  let matched;
  try {
    matched = await proveRemoteAccount(address);
  } catch (err) {
    const unproven = createRemoteError(REMOTE_ERROR_CODES.ADDRESS_UNPROVEN);
    unproven.cause = err;
    throw unproven;
  }
  if (!matched) {
    throw createRemoteError(REMOTE_ERROR_CODES.ADDRESS_MISMATCH);
  }
  return vaultBackend.accounts.addRemote({ name, address });
}

/**
 * Check an existing phone record on the phone (#1078): the phone signs a
 * fresh challenge as the account, and the outcome is kept on the record.
 * No answer leaves the record as it was.
 *
 * @param {number} index - Wallet index of the phone record
 * @returns {Promise<{index: number, name: string, address: string, type: string, addressCheck: string}>}
 */
async function checkRemoteWallet(index) {
  const record = getWalletRecord(index);
  if (!record || record.type !== WALLET_TYPES.REMOTE) {
    throw new Error(`Wallet ${index} is not a phone account`);
  }
  const { proveRemoteAccount } = require('./wallet/remote/account-proof');
  const matched = await proveRemoteAccount(record.address, index);
  return { ...record, addressCheck: await recordRemoteAddressCheck(index, matched) };
}

/**
 * Record what a device's answer showed about a device record: whether it
 * answered as the record's address (a Ledger: whether it derives the
 * address at the record's path). A `matched` record stays matched: a
 * later answer that doesn't match is another Ledger, or the phone on
 * another account, and every signature is checked against the record
 * anyway. Never deletes a record. The core keeps it on the record
 * (`accounts.record_address_check`).
 *
 * @param {string} type - A type in ADDRESS_CHECKED_TYPES
 * @param {number} index - Wallet index of the record
 * @param {boolean} matched
 * @returns {Promise<string|null>} The record's check state, or null if it isn't such a record
 */
function recordAddressCheck(type, index, matched) {
  return vaultBackend.accounts.recordAddressCheck(type, index, matched);
}

/** What a device said about a Ledger record (see recordAddressCheck). */
function recordLedgerAddressCheck(index, matched) {
  return recordAddressCheck(WALLET_TYPES.LEDGER, index, matched);
}

/** What the phone's answer showed about a phone record (see recordAddressCheck). */
function recordRemoteAddressCheck(index, matched) {
  return recordAddressCheck(WALLET_TYPES.REMOTE, index, matched);
}

/**
 * Add a Safe smart-account record.
 *
 * The init params (owners, threshold, saltNonce) are FROZEN once stored —
 * they are what makes the CREATE2 address reproducible on other chains
 * (retroactive deployment recovers funds sent there), so nothing may ever
 * rewrite them. `owners` are wallet indexes of existing records; the
 * caller (safe-service) resolves their addresses and predicts `address`
 * before storing.
 *
 * Only the shipped presets are accepted: 1-of-2 and 2-of-3. 2-of-2 is
 * deliberately not offered — losing either device bricks the funds. Each
 * device owner must be `matched` (#1065, #1078): in a 1-of-2 Safe an owner
 * address planted by the chrome would control the funds alone.
 *
 * @param {string} name - Display name ('' → auto "Safe N")
 * @param {Object} params
 * @param {string} params.address - Predicted counterfactual address
 * @param {number[]} params.owners - Wallet indexes of the owner records
 * @param {number} params.threshold
 * @param {string} params.saltNonce
 * @returns {Promise<Object>} The stored record
 */
async function addSafeWallet(name, { address, owners, threshold, saltNonce }) {
  // The core checks the preset, the owners (existing, no Safe, a device
  // owner `matched`: LEDGER_ACCOUNT_UNCHECKED, REMOTE_ACCOUNT_UNCHECKED) and
  // the salt, then stores the record.
  return vaultBackend.accounts.addSafe({ name, address, owners, threshold, saltNonce });
}

/**
 * Record that a Safe's contract is now live on a chain. Deployment state
 * is the ONLY mutable part of a safe record — init params stay frozen.
 *
 * The caller must have verified the deployment (#1066): the mark says so
 * (wallet/safe/deployed-mark.js), and replaces a mark of a release before
 * #1066 on that chain.
 *
 * @param {number} index - Wallet index of the safe record
 * @param {number} chainId
 */
async function markSafeDeployed(index, chainId) {
  await vaultBackend.accounts.markSafeDeployed(index, chainId);
}

/**
 * Get the active wallet index, read from the core's file (main's
 * synchronous lookups; the chrome's goes through `accounts.active`)
 * @returns {number}
 */
function getActiveWalletIndex() {
  const meta = getVaultMeta();
  return meta?.activeWalletIndex ?? 0;
}

/**
 * Set the active wallet index
 * @param {number} index - Wallet index to set as active
 * @param {'chrome'|null} [caller] - the chrome's request, or main's own
 */
async function setActiveWalletIndex(index, caller = null) {
  await vaultBackend.accounts.setActive(index, caller);
}

/**
 * Create a new derived wallet: the core picks the next mnemonic index and
 * derives its address, and needs the vault unlocked.
 * @param {string} name - Wallet name
 * @param {'chrome'|null} [caller] - the chrome's request, or main's own
 * @returns {Promise<{index: number, name: string, address: string}>}
 */
async function createDerivedWallet(name, caller = null) {
  return vaultBackend.accounts.addMnemonic(name, caller);
}

/**
 * Rename a derived wallet
 * @param {number} index - Wallet index
 * @param {string} newName - New wallet name
 * @param {'chrome'|null} [caller] - the chrome's request, or main's own
 */
async function renameDerivedWallet(index, newName, caller = null) {
  await vaultBackend.accounts.rename(index, newName, caller);
}

function getSwarmPublisherIdentityReferences(walletIndex) {
  const { getEthereumWalletIdentityReferences } = require('./swarm/feed-store');
  return getEthereumWalletIdentityReferences(walletIndex);
}

/**
 * Whether `accounts.remove` failed before the core ended anything: a refusal
 * (`invalid_argument`, whose `data.code`, when it set one, became the error's
 * code) or a request main never sent (`requirement_unmet`).
 */
function removalRefusedBeforeCleanup(err) {
  if (err?.code === 'requirement_unmet' || err?.code === 'invalid_argument') return true;
  return typeof err?.data?.code === 'string' && err.code === err.data.code;
}

/**
 * Delete a derived wallet, through the core (`accounts.remove`, design 0013),
 * which refuses the main wallet, a missing index, a Safe's owner and an
 * account the Swarm feeds still name (main's feed store finds those, and
 * passes them), then ends a Safe's open approvals, forgets the account's
 * dApp grants (main's copy follows `approval.changed`) and removes the
 * record, in one request.
 *
 * A Safe's exclusion is main's: taken before the request, refused
 * (SAFE_BUSY) while one of its steps runs or a send has reserved it, and
 * released after. Its half-signed state, keyed by wallet index (the
 * in-memory approval slots and SafeMessage session, and safe-pending.json
 * until that store moves), goes once the record has: a later account that
 * reuses the index must neither inherit nor be blocked by it. A failed
 * clear of the pending entry is logged.
 *
 * A removal that fails after it may have reached the core's cleanup (a
 * `storage` or `not_moved` answer from a later step, or no answer at all)
 * has ended the Safe's approvals in the core while the account stays: main
 * drops its own approval slots too, so the Safe's next step asks for a new
 * approval instead of presenting a token the core ended. A refusal the core
 * answers before any cleanup (`invalid_argument`, carried as its `data.code`)
 * and a request never sent (`requirement_unmet`) leave them.
 *
 * @param {number} index - Wallet index (cannot be 0)
 * @param {'chrome'|null} [caller] - the chrome's request, or main's own
 */
async function deleteDerivedWallet(index, caller = null) {
  const references =
    Number.isInteger(index) && index >= 0 ? getSwarmPublisherIdentityReferences(index) : [];
  const isSafe = getWalletRecord(index)?.type === WALLET_TYPES.SAFE;
  // Lazy requires (the Safe modules are dependency-light) keep the Safe
  // stack out of ordinary wallet operations.
  const safeApprovals = isSafe ? require('./wallet/safe/safe-approvals') : null;
  const deletion = safeApprovals ? safeApprovals.beginDeletion(index) : null;
  try {
    try {
      await vaultBackend.accounts.remove(index, references, caller);
    } catch (err) {
      if (isSafe && !removalRefusedBeforeCleanup(err)) safeApprovals.forgetSafe(index);
      throw err;
    }
    if (isSafe) {
      safeApprovals.forgetSafe(index);
      require('./wallet/safe/message-sessions').discardSession(index);
      try {
        require('./wallet/safe/pending-store').clearPending(index);
      } catch (err) {
        console.warn(
          "[IdentityManager] A deleted Safe's pending transaction was not cleared:",
          err.message
        );
      }
    }
  } finally {
    deletion?.release();
  }
}

/**
 * Get active wallet address
 * @returns {Promise<string|null>}
 */
async function getActiveWalletAddress() {
  const meta = getVaultMeta();

  if (!meta) {
    return null;
  }

  const activeIndex = meta.activeWalletIndex ?? 0;

  // Hardware accounts always use the stored device address — there is
  // no local derivation, unlocked vault or not.
  const record = getWalletRecord(activeIndex, meta);
  if (record && record.type !== WALLET_TYPES.MNEMONIC) {
    return record.address;
  }

  const derived = await deriveAddresses({ accounts: [activeIndex] });
  if (derived) {
    return derived.user_wallets[0].address;
  }

  // Vault locked - can only return main wallet address from stored meta
  return activeIndex === 0 ? (record?.address ?? null) : null;
}

/**
 * Change vault password
 * @param {string} currentPassword
 * @param {string} newPassword
 */
async function changeVaultPassword(currentPassword, newPassword) {
  // Quick unlock stays on through the change (design 0013).
  await require('./quick-unlock').changePasswordKeepingQuickUnlock(currentPassword, newPassword);
  console.log('[IdentityManager] Vault password changed');
}

/**
 * Delete vault (dangerous!)
 * @param {string} password - Must verify password
 */
async function deleteVaultData(password) {
  await vaultBackend.deleteVault(password);
  injectedNodes = { bee: false, ipfs: false, radicle: false };
  console.log('[IdentityManager] Vault deleted');
}

/**
 * Startup repair (K-3): the vault and the quick-unlock credential an older
 * build wrote with the umask's mode (usually 0644) become owner-only,
 * through a no-follow descriptor, so a link planted at either name is left
 * alone. The core writes the vault (an atomic 0600 replace) and tightens an
 * older one at its own startup too; quick-unlock.js reads the vault and
 * reads and writes the credential through the same directory handle as here.
 */
function repairIdentityFiles() {
  try {
    withPrivateDir(getIdentityDataDir(), (dir) => {
      dir.repair('identity-vault.json');
      dir.repair('quick-unlock.dat');
    });
  } catch (err) {
    // A data directory that is a link is refused (profile-paths); say so
    // without taking startup down.
    console.warn('[IdentityManager] Identity files not repaired:', err.message);
  }
}

/**
 * The renderer's `userKnowsPassword` for a new vault (its setup choice),
 * which the core writes into vault-meta.json and requires as a boolean:
 * absent means true, the reference's default; anything else that isn't a
 * boolean is refused here, "Invalid parameters".
 */
function knowsPasswordFrom(value) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error('Invalid parameters');
  return value;
}

/**
 * Register IPC handlers for identity operations. The chrome's vault-meta
 * requests go to the core as the chrome's (`'chrome'`); the device, phone
 * and Safe additions stay main's own, after its checks.
 */
function registerIdentityIpc() {
  repairIdentityFiles();
  // Check if vault exists
  ipcMain.handle(IPC.IDENTITY_HAS_VAULT, async () => {
    try {
      return { hasVault: await hasVault() };
    } catch (err) {
      return { hasVault: false, error: err.message };
    }
  });

  // Check if vault is unlocked
  ipcMain.handle(IPC.IDENTITY_IS_UNLOCKED, async () => {
    try {
      return { isUnlocked: await isVaultUnlocked() };
    } catch (err) {
      return { isUnlocked: false, error: err.message };
    }
  });

  // Generate mnemonic (without saving vault)
  ipcMain.handle(IPC.IDENTITY_GENERATE_MNEMONIC, async (_event, strength) => {
    try {
      const mnemonic = await vaultBackend.generateMnemonic(strength);
      return { success: true, mnemonic };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Create new vault
  ipcMain.handle(
    IPC.IDENTITY_CREATE_VAULT,
    async (_event, password, strength, userKnowsPassword) => {
      try {
        const knows = knowsPasswordFrom(userKnowsPassword);
        const mnemonic = await createNewVault(password, strength, knows);
        return { success: true, mnemonic };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // Import mnemonic
  ipcMain.handle(
    IPC.IDENTITY_IMPORT_MNEMONIC,
    async (_event, password, mnemonic, userKnowsPassword) => {
      try {
        await importExistingMnemonic(password, mnemonic, knowsPasswordFrom(userKnowsPassword));
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // Get vault metadata (setup type, etc.), the core's file; null without
  // one, or when the core can't answer (as an unreadable file read before).
  ipcMain.handle('identity:get-vault-meta', async () => {
    try {
      return await vaultBackend.accounts.meta('chrome');
    } catch (err) {
      console.warn('[IdentityManager] Vault metadata not read:', err.message);
      return null;
    }
  });

  // Unlock vault
  ipcMain.handle(IPC.IDENTITY_UNLOCK, async (_event, password) => {
    try {
      await unlockVault(password);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Lock vault
  ipcMain.handle(IPC.IDENTITY_LOCK, async () => {
    try {
      await lockVault();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get status
  ipcMain.handle(IPC.IDENTITY_GET_STATUS, async () => {
    try {
      return await getIdentityStatus();
    } catch (err) {
      return { error: err.message };
    }
  });

  // Inject all identities
  ipcMain.handle(IPC.IDENTITY_INJECT_ALL, async (_event, radicleAlias, force = false) => {
    try {
      const results = await injectAllIdentities(radicleAlias, force);
      return { success: true, ...results };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Export mnemonic (requires password re-verification)
  ipcMain.handle(IPC.IDENTITY_EXPORT_MNEMONIC, async (_event, password) => {
    try {
      if (!password) {
        return { success: false, error: 'Password is required to export mnemonic' };
      }
      // The core verifies the password, then needs the vault unlocked.
      const mnemonic = await exportMnemonic(password);
      return { success: true, mnemonic };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Export private key for a specific wallet (requires password re-verification)
  ipcMain.handle(IPC.IDENTITY_EXPORT_PRIVATE_KEY, async (_event, accountIndex, password) => {
    try {
      if (!password) {
        return { success: false, error: 'Password is required to export private key' };
      }
      const privateKey = await exportPrivateKeyForAccount(accountIndex, password);
      return { success: true, privateKey };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Change password
  ipcMain.handle(IPC.IDENTITY_CHANGE_PASSWORD, async (_event, currentPassword, newPassword) => {
    try {
      await changeVaultPassword(currentPassword, newPassword);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Delete vault
  ipcMain.handle(IPC.IDENTITY_DELETE_VAULT, async (_event, password) => {
    try {
      await deleteVaultData(password);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Validate mnemonic (for import form)
  ipcMain.handle(IPC.IDENTITY_VALIDATE_MNEMONIC, async (_event, mnemonic) => {
    try {
      return { valid: await vaultBackend.validateMnemonic(mnemonic) };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  });

  // ============================================
  // Multi-Wallet IPC Handlers
  // ============================================

  // Get list of derived wallets
  ipcMain.handle('wallet:get-derived-wallets', async () => {
    try {
      const wallets = await getDerivedWallets('chrome');
      return { success: true, wallets };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get active wallet index
  ipcMain.handle('wallet:get-active-index', async () => {
    try {
      const index = await vaultBackend.accounts.active('chrome');
      return { success: true, index };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Set active wallet
  ipcMain.handle('wallet:set-active-wallet', async (_event, index) => {
    try {
      await setActiveWalletIndex(index, 'chrome');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Create new derived wallet
  ipcMain.handle('wallet:create-derived-wallet', async (_event, name) => {
    try {
      const wallet = await createDerivedWallet(name, 'chrome');
      return { success: true, wallet };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Add a Ledger hardware-wallet account (address read from the device)
  ipcMain.handle('wallet:add-ledger-wallet', async (_event, name, address, path) => {
    try {
      const wallet = await addLedgerWallet(name, address, path);
      return { success: true, wallet };
    } catch (err) {
      return { success: false, error: err.message, code: err.code };
    }
  });

  // Add a remote (phone) account (address reported over openlv)
  // Both run for the window that asked (APS-4): the phone's QR shows in
  // its sidebar.
  ipcMain.handle(
    'wallet:add-remote-wallet',
    forSenderWindow(async (_event, name, address) => {
      try {
        const wallet = await addRemoteWallet(name, address);
        return { success: true, wallet };
      } catch (err) {
        return { success: false, error: err.message, code: err.code };
      }
    })
  );

  // Check an existing phone account on the phone (#1078)
  ipcMain.handle(
    'wallet:check-remote-wallet',
    forSenderWindow(async (_event, index) => {
      try {
        const wallet = await checkRemoteWallet(index);
        return { success: true, wallet };
      } catch (err) {
        return { success: false, error: err.message, code: err.code };
      }
    })
  );

  // Rename wallet
  ipcMain.handle('wallet:rename-wallet', async (_event, index, newName) => {
    try {
      await renameDerivedWallet(index, newName, 'chrome');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Delete wallet
  ipcMain.handle('wallet:delete-wallet', async (_event, index) => {
    try {
      await deleteDerivedWallet(index, 'chrome');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get active wallet address
  ipcMain.handle('wallet:get-active-address', async () => {
    try {
      const address = await getActiveWalletAddress();
      return { success: true, address };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  console.log('[IdentityManager] IPC handlers registered');
}

module.exports = {
  // Initialization
  registerIdentityIpc,

  // Vault operations
  hasVault,
  isVaultUnlocked,
  createNewVault,
  importExistingMnemonic,
  unlockVault,
  quickUnlockVault,
  lockVault,
  exportMnemonic,
  quickExportMnemonic,
  assertPrivateKeyExportable,
  exportPrivateKeyForAccount,
  quickExportPrivateKeyForAccount,
  changeVaultPassword,
  deleteVaultData,

  // Public key data (the core signs; design 0002)
  deriveAddresses,
  getBeeWalletAddress,
  getPublisherAddress,

  // Multi-wallet operations
  WALLET_TYPES,
  HARDWARE_INDEX_BASE,
  isHardwareWalletIndex,
  getWalletRecord,
  findWalletRecordByAddress,
  getDerivedWallets,
  getActiveWalletIndex,
  setActiveWalletIndex,
  createDerivedWallet,
  addLedgerWallet,
  getLedgerRecordsToCheck,
  recordLedgerAddressCheck,
  addRemoteWallet,
  ADDRESS_CHECK,
  checkRemoteWallet,
  recordRemoteAddressCheck,
  addSafeWallet,
  markSafeDeployed,
  renameDerivedWallet,
  deleteDerivedWallet,
  getActiveWalletAddress,

  // Identity injection
  setBeeLifecycle,
  reencryptBeeKeystore,
  setRadicleLifecycle,
  repairIdentityFiles,
  removeStaleBeeDirs,
  wipeStaleBeeState,
  injectBeeIdentity,
  injectIpfsIdentity,
  injectRadicleIdentity,
  injectAllIdentities,

  // Status
  getIdentityStatus,
  isBeeIdentityInjected,
  isIpfsIdentityInjected,
  isIpfsIdentityPrepared,
  isRadicleIdentityInjected,

  // Data directories
  getIdentityDataDir,
  getAntDataDir,
  getIpfsDataDir,
  getRadicleDataDir,

  // For tests: the retry schedule of a Radicle identity change.
  RADICLE_CHANGE_RETRY_MS,
  _internal: { radicleChangeRetry },
};
