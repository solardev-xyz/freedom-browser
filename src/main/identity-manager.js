/**
 * Identity Manager
 *
 * Orchestrates the unified identity system:
 * - Manages vault state (locked/unlocked)
 * - Derives keys from mnemonic when unlocked
 * - Injects keys into node data directories
 * - Provides IPC handlers for renderer communication
 */

const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const IPC = require('../shared/ipc-channels');

// Identity module (ESM) - loaded dynamically
let identityModule = null;

// Cached derived keys (only available when unlocked)
let derivedKeys = null;

// Track which nodes have been injected
let injectedNodes = {
  bee: false,
  ipfs: false,
  radicle: false,
};

// Vault metadata file
const VAULT_META_FILE = 'vault-meta.json';

/**
 * Get the app data directory for identity storage
 */
function getIdentityDataDir() {
  if (!app.isPackaged) {
    return path.join(__dirname, '..', '..', 'identity-data');
  }
  return path.join(app.getPath('userData'), 'identity');
}

/**
 * Get the path to the vault metadata file
 */
function getVaultMetaPath() {
  return path.join(getIdentityDataDir(), VAULT_META_FILE);
}

/**
 * Get vault metadata
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
 * Save vault metadata
 * @param {Object} meta - Metadata to save
 */
function saveVaultMeta(meta) {
  const metaPath = getVaultMetaPath();
  const dir = path.dirname(metaPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  console.log('[IdentityManager] Vault metadata saved, userKnowsPassword:', meta.userKnowsPassword);
}

/**
 * Load the ESM identity module dynamically
 */
async function loadIdentityModule() {
  if (identityModule) return identityModule;

  try {
    identityModule = await import('./identity/index.js');
    return identityModule;
  } catch (err) {
    console.error('[IdentityManager] Failed to load identity module:', err);
    throw err;
  }
}

/**
 * Check if a vault exists
 * @returns {Promise<boolean>}
 */
async function hasVault() {
  const identity = await loadIdentityModule();
  const dataDir = getIdentityDataDir();
  return identity.vaultExists(dataDir);
}

/**
 * Check if vault is currently unlocked
 * @returns {Promise<boolean>}
 */
async function isVaultUnlocked() {
  const identity = await loadIdentityModule();
  return identity.isUnlocked();
}

/**
 * Create a new vault with a generated mnemonic
 * @param {string} password - User's password
 * @param {number} strength - Mnemonic strength (128=12 words, 256=24 words)
 * @param {boolean} userKnowsPassword - Whether the user knows the password (false for Quick Setup)
 * @returns {Promise<string>} The generated mnemonic (for backup display)
 */
async function createNewVault(password, strength = 256, userKnowsPassword = true) {
  const identity = await loadIdentityModule();
  const dataDir = getIdentityDataDir();

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const mnemonic = await identity.createVault(dataDir, password, strength);
  console.log('[IdentityManager] New vault created');

  // Auto-unlock after creation
  await identity.unlockVault(dataDir, password, 0); // 0 = no auto-lock for now
  derivedKeys = identity.deriveAllKeys(mnemonic);

  // Save vault metadata including public addresses (so we can display without unlock)
  saveVaultMeta({
    userKnowsPassword,
    createdAt: new Date().toISOString(),
    addresses: {
      userWallet: derivedKeys.userWallet.address,
      beeWallet: derivedKeys.beeWallet.address,
    },
  });

  return mnemonic;
}

/**
 * Import an existing mnemonic into a new vault
 * @param {string} password - User's password
 * @param {string} mnemonic - The mnemonic to import
 * @param {boolean} userKnowsPassword - Whether the user knows the password (false for Quick Setup)
 * @returns {Promise<void>}
 */
async function importExistingMnemonic(password, mnemonic, userKnowsPassword = true) {
  const identity = await loadIdentityModule();
  const dataDir = getIdentityDataDir();

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  await identity.importVault(dataDir, password, mnemonic, false);
  console.log('[IdentityManager] Mnemonic imported to vault');

  // Auto-unlock after import
  await identity.unlockVault(dataDir, password, 0);
  derivedKeys = identity.deriveAllKeys(mnemonic);

  // Save vault metadata including public addresses (so we can display without unlock)
  saveVaultMeta({
    userKnowsPassword,
    createdAt: new Date().toISOString(),
    addresses: {
      userWallet: derivedKeys.userWallet.address,
      beeWallet: derivedKeys.beeWallet.address,
    },
  });
}

/**
 * Unlock the vault with password
 * @param {string} password - User's password
 * @returns {Promise<void>}
 */
async function unlockVault(password) {
  const identity = await loadIdentityModule();
  const dataDir = getIdentityDataDir();

  await identity.unlockVault(dataDir, password, 0); // 0 = no auto-lock for now

  const mnemonic = identity.getMnemonic();
  if (!mnemonic) {
    throw new Error('Failed to retrieve mnemonic after unlock');
  }

  derivedKeys = identity.deriveAllKeys(mnemonic);
  console.log('[IdentityManager] Vault unlocked, keys derived');

  // Migrate old vaults: save addresses to metadata if not present
  const meta = getVaultMeta();
  if (meta && !meta.addresses) {
    console.log('[IdentityManager] Migrating vault metadata to include addresses');
    saveVaultMeta({
      ...meta,
      addresses: {
        userWallet: derivedKeys.userWallet.address,
        beeWallet: derivedKeys.beeWallet.address,
      },
    });
  }
}

/**
 * Lock the vault
 */
async function lockVault() {
  const identity = await loadIdentityModule();
  identity.lockVault();
  derivedKeys = null;
  console.log('[IdentityManager] Vault locked');
}

/**
 * Get derived keys (only if unlocked)
 * @returns {Object|null}
 */
function getDerivedKeys() {
  return derivedKeys;
}

/**
 * Get the Bee data directory
 */
function getBeeDataDir() {
  if (!app.isPackaged) {
    return path.join(__dirname, '..', '..', 'bee-data');
  }
  return path.join(app.getPath('userData'), 'bee-data');
}

/**
 * Get the IPFS data directory
 */
function getIpfsDataDir() {
  if (!app.isPackaged) {
    return path.join(__dirname, '..', '..', 'ipfs-data');
  }
  return path.join(app.getPath('userData'), 'ipfs-data');
}

/**
 * Get the Radicle data directory
 */
function getRadicleDataDir() {
  if (!app.isPackaged) {
    return path.join(__dirname, '..', '..', 'radicle-data');
  }
  return path.join(app.getPath('userData'), 'radicle-data');
}

/**
 * Check if Bee identity has been injected
 */
function isBeeIdentityInjected() {
  const dataDir = getBeeDataDir();
  const keystorePath = path.join(dataDir, 'keys', 'swarm.key');
  return fs.existsSync(keystorePath);
}

/**
 * Check if IPFS has an identity (either injected by us or generated by ipfs init)
 */
function isIpfsIdentityInjected() {
  const dataDir = getIpfsDataDir();
  const configPath = path.join(dataDir, 'config');

  if (!fs.existsSync(configPath)) {
    return false;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Check if Identity.PeerID exists (indicates IPFS has been initialized with an identity)
    return !!(config.Identity && config.Identity.PeerID);
  } catch (err) {
    return false;
  }
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
 * Read IPFS PeerID from config file (no unlock required)
 * @returns {string|null}
 */
function readIpfsPeerId() {
  const dataDir = getIpfsDataDir();
  const configPath = path.join(dataDir, 'config');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.Identity?.PeerID || null;
  } catch (err) {
    console.error('[IdentityManager] Failed to read IPFS PeerID:', err.message);
    return null;
  }
}

/**
 * Read Radicle DID from public key file (no unlock required)
 * The file is in OpenSSH format: "ssh-ed25519 <base64> <comment>"
 * @returns {Promise<string|null>}
 */
async function readRadicleDid() {
  const dataDir = getRadicleDataDir();
  const pubKeyPath = path.join(dataDir, 'keys', 'radicle.pub');

  if (!fs.existsSync(pubKeyPath)) {
    return null;
  }

  try {
    const identity = await loadIdentityModule();
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

    return identity.didFromPublicKey(publicKey);
  } catch (err) {
    console.error('[IdentityManager] Failed to read Radicle DID:', err.message);
    return null;
  }
}

/**
 * Generate a random password for Bee keystore
 * This password is separate from the vault password for defense in depth
 * @returns {string}
 */
function generateBeeKeystorePassword() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Inject Bee identity
 * Generates its own random password for the keystore (stored in config.yaml)
 * This is intentionally different from the vault password
 * @returns {Promise<{address: string}>}
 */
async function injectBeeIdentity() {
  if (!derivedKeys) {
    throw new Error('Vault is locked');
  }

  const identity = await loadIdentityModule();
  const dataDir = getBeeDataDir();

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Remove pre-existing auxiliary keys that may be encrypted with a different password.
  // Bee will regenerate libp2p_v2 and pss from scratch on next start.
  for (const keyFile of ['libp2p_v2.key', 'pss.key']) {
    const keyPath = path.join(dataDir, 'keys', keyFile);
    if (fs.existsSync(keyPath)) {
      fs.unlinkSync(keyPath);
      console.log(`[IdentityManager] Removed old ${keyFile} (password mismatch prevention)`);
    }
  }

  // Generate a random password for the Bee keystore
  // This is separate from the vault password - defense in depth
  const beePassword = generateBeeKeystorePassword();

  // Inject the key with the random password
  await identity.injectBeeKey(dataDir, derivedKeys.beeWallet.privateKey, beePassword);

  // Store the password in config so Bee can decrypt the keystore on startup
  identity.createBeeConfig(dataDir, beePassword);

  injectedNodes.bee = true;

  console.log(`[IdentityManager] Bee identity injected: ${derivedKeys.beeWallet.address}`);
  return { address: derivedKeys.beeWallet.address };
}

/**
 * Inject IPFS identity
 * @returns {Promise<{peerId: string}>}
 */
async function injectIpfsIdentity() {
  if (!derivedKeys) {
    throw new Error('Vault is locked');
  }

  const identity = await loadIdentityModule();
  const dataDir = getIpfsDataDir();

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Check if IPFS repo exists - if not, run ipfs init first
  const configPath = path.join(dataDir, 'config');
  if (!fs.existsSync(configPath)) {
    // Need to run ipfs init to create a proper repo structure
    const { execSync } = require('child_process');
    const ipfsBinPath = getIpfsBinaryPath();

    if (fs.existsSync(ipfsBinPath)) {
      try {
        console.log('[IdentityManager] Initializing IPFS repo...');
        execSync(`"${ipfsBinPath}" init`, {
          env: { ...process.env, IPFS_PATH: dataDir },
          stdio: 'pipe',
        });
        console.log('[IdentityManager] IPFS repo initialized');
      } catch (err) {
        console.error('[IdentityManager] Failed to init IPFS repo:', err.message);
        throw new Error('Failed to initialize IPFS repo');
      }
    } else {
      throw new Error('IPFS binary not found');
    }
  }

  const peerId = identity.injectIpfsKey(
    dataDir,
    derivedKeys.ipfsKey.privateKey,
    derivedKeys.ipfsKey.publicKey
  );

  // Write marker file to indicate we injected the identity
  fs.writeFileSync(path.join(dataDir, '.identity-injected'), new Date().toISOString());

  injectedNodes.ipfs = true;

  console.log(`[IdentityManager] IPFS identity injected: ${peerId}`);
  return { peerId };
}

/**
 * Get IPFS binary path (mirrors ipfs-manager logic)
 */
function getIpfsBinaryPath() {
  const arch = process.arch;
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  let basePath = path.join(__dirname, '..', '..', 'ipfs-bin');

  if (app.isPackaged) {
    basePath = path.join(process.resourcesPath, 'ipfs-bin');
    const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
    return path.join(basePath, binName);
  }

  const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
  return path.join(basePath, `${platform}-${arch}`, binName);
}

/**
 * Inject Radicle identity
 * @param {string} alias - Node alias
 * @returns {Promise<{did: string}>}
 */
async function injectRadicleIdentity(alias = 'FreedomBrowser') {
  if (!derivedKeys) {
    throw new Error('Vault is locked');
  }

  const identity = await loadIdentityModule();
  const dataDir = getRadicleDataDir();

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const did = identity.injectRadicleKey(
    dataDir,
    derivedKeys.radicleKey.privateKey,
    derivedKeys.radicleKey.publicKey,
    alias
  );

  injectedNodes.radicle = true;

  console.log(`[IdentityManager] Radicle identity injected: ${did}`);
  return { did };
}

/**
 * Inject all identities
 * @param {string} radicleAlias - Alias for Radicle node
 * @param {boolean} force - Force overwrite even if keys exist
 * @returns {Promise<Object>}
 */
async function injectAllIdentities(radicleAlias = 'FreedomBrowser', force = false) {
  if (!derivedKeys) {
    throw new Error('Vault is locked');
  }

  const results = {
    // Include user wallet (Account 0) - not injected anywhere, just derived
    userWallet: { address: derivedKeys.userWallet.address },
    // Track if any node was re-injected (needs restart)
    needsRestart: [],
  };

  // Inject Bee (only if not already injected OR force)
  // Bee generates its own random keystore password internally
  if (force || !isBeeIdentityInjected()) {
    const wasInjected = isBeeIdentityInjected();
    results.bee = await injectBeeIdentity();
    if (wasInjected && force) {
      results.bee.reinjected = true;
      results.needsRestart.push('bee');
    }
  } else {
    results.bee = { address: derivedKeys.beeWallet.address, alreadyInjected: true };
  }

  // Inject IPFS (only if not already injected OR force)
  if (force || !isIpfsIdentityInjected()) {
    const wasInjected = isIpfsIdentityInjected();
    results.ipfs = await injectIpfsIdentity();
    if (wasInjected && force) {
      results.ipfs.reinjected = true;
      results.needsRestart.push('ipfs');
    }
  } else {
    // Get PeerID from config
    const identity = await loadIdentityModule();
    const ipfsIdentity = identity.createIpfsIdentity(
      derivedKeys.ipfsKey.privateKey,
      derivedKeys.ipfsKey.publicKey
    );
    results.ipfs = { peerId: ipfsIdentity.peerId, alreadyInjected: true };
  }

  // Inject Radicle (only if not already injected OR force)
  if (force || !isRadicleIdentityInjected()) {
    const wasInjected = isRadicleIdentityInjected();
    results.radicle = await injectRadicleIdentity(radicleAlias);
    if (wasInjected && force) {
      results.radicle.reinjected = true;
      results.needsRestart.push('radicle');
    }
  } else {
    // Get DID
    const identity = await loadIdentityModule();
    const radicleIdentity = identity.createRadicleIdentity(
      derivedKeys.radicleKey.privateKey,
      derivedKeys.radicleKey.publicKey,
      radicleAlias
    );
    results.radicle = { did: radicleIdentity.did, alreadyInjected: true };
  }

  console.log('[IdentityManager] All identities injected/verified');
  return results;
}

/**
 * Get identity status
 * Returns addresses without requiring vault unlock by reading from:
 * - vault-meta.json for wallet addresses (stored at vault creation)
 * - IPFS config for PeerID
 * - Radicle public key for DID
 * @returns {Promise<Object>}
 */
async function getIdentityStatus() {
  const hasVaultResult = await hasVault();
  const isUnlocked = await isVaultUnlocked();

  // Try to get addresses - works even when vault is locked
  let addresses = null;

  if (derivedKeys) {
    // Vault is unlocked - compute from derived keys (most accurate)
    const identity = await loadIdentityModule();

    const ipfsIdentity = identity.createIpfsIdentity(
      derivedKeys.ipfsKey.privateKey,
      derivedKeys.ipfsKey.publicKey
    );

    const radicleIdentity = identity.createRadicleIdentity(
      derivedKeys.radicleKey.privateKey,
      derivedKeys.radicleKey.publicKey,
      'FreedomBrowser'
    );

    addresses = {
      userWallet: derivedKeys.userWallet.address,
      beeWallet: derivedKeys.beeWallet.address,
      ipfsPeerId: ipfsIdentity.peerId,
      radicleDid: radicleIdentity.did,
    };
  } else if (hasVaultResult) {
    // Vault is locked - read from stored metadata and node config files
    const meta = getVaultMeta();

    addresses = {
      userWallet: meta?.addresses?.userWallet || null,
      beeWallet: meta?.addresses?.beeWallet || null,
      ipfsPeerId: readIpfsPeerId(),
      radicleDid: await readRadicleDid(),
    };
  }

  return {
    hasVault: hasVaultResult,
    isUnlocked,
    beeInjected: isBeeIdentityInjected(),
    ipfsInjected: isIpfsIdentityInjected(),
    radicleInjected: isRadicleIdentityInjected(),
    addresses,
  };
}

/**
 * Export mnemonic for backup (vault must be unlocked)
 * @returns {Promise<string>}
 */
async function exportMnemonic() {
  const identity = await loadIdentityModule();
  return identity.exportMnemonic();
}

// ============================================
// Multi-Wallet Support
// ============================================

/**
 * Get list of derived user wallets
 * @returns {Array<{index: number, name: string, address: string}>}
 */
async function getDerivedWallets() {
  const identity = await loadIdentityModule();
  const meta = getVaultMeta();

  if (!meta) {
    return [];
  }

  // Initialize with default wallet if derivedWallets not present
  if (!meta.derivedWallets) {
    const mainWalletAddress = meta.addresses?.userWallet || null;
    const wallets = [{
      index: 0,
      name: 'Main Wallet',
      address: mainWalletAddress,
    }];

    // Update meta with derivedWallets (include address for persistence)
    saveVaultMeta({
      ...meta,
      derivedWallets: wallets,
      activeWalletIndex: 0,
    });

    return wallets;
  }

  // If vault is unlocked, derive addresses; otherwise use stored addresses
  const mnemonic = identity.getMnemonic();
  const wallets = [];

  for (const wallet of meta.derivedWallets) {
    let address = null;

    if (mnemonic) {
      // Derive address from mnemonic
      const derived = identity.deriveUserWallet(mnemonic, wallet.index);
      address = derived.address;
    } else {
      // Use stored address from wallet object, or fallback to meta.addresses for index 0
      if (wallet.address) {
        address = wallet.address;
      } else if (wallet.index === 0) {
        address = meta.addresses?.userWallet || null;
      }
    }

    wallets.push({
      index: wallet.index,
      name: wallet.name,
      address,
    });
  }

  return wallets;
}

/**
 * Get the active wallet index
 * @returns {number}
 */
function getActiveWalletIndex() {
  const meta = getVaultMeta();
  return meta?.activeWalletIndex ?? 0;
}

/**
 * Set the active wallet index
 * @param {number} index - Wallet index to set as active
 */
async function setActiveWalletIndex(index) {
  const meta = getVaultMeta();
  if (!meta) {
    throw new Error('No vault found');
  }

  // Verify wallet exists
  const wallets = meta.derivedWallets || [{ index: 0, name: 'Main Wallet' }];
  const walletExists = wallets.some(w => w.index === index);

  if (!walletExists) {
    throw new Error(`Wallet with index ${index} does not exist`);
  }

  saveVaultMeta({
    ...meta,
    activeWalletIndex: index,
  });
}

/**
 * Create a new derived wallet
 * @param {string} name - Wallet name
 * @returns {Promise<{index: number, name: string, address: string}>}
 */
async function createDerivedWallet(name) {
  const identity = await loadIdentityModule();
  const mnemonic = identity.getMnemonic();

  if (!mnemonic) {
    throw new Error('Vault must be unlocked to create a new wallet');
  }

  const meta = getVaultMeta();
  if (!meta) {
    throw new Error('No vault found');
  }

  // Get current wallets
  const wallets = meta.derivedWallets || [{ index: 0, name: 'Main Wallet' }];

  // Find next available index (use account index, starting from max + 1)
  const maxIndex = wallets.reduce((max, w) => Math.max(max, w.index), -1);
  const newIndex = maxIndex + 1;

  // Derive the new wallet
  const derived = identity.deriveUserWallet(mnemonic, newIndex);

  // Add to list (include address so it persists when vault is locked)
  const newWallet = {
    index: newIndex,
    name: name || `Wallet ${newIndex + 1}`,
    address: derived.address,
  };
  wallets.push(newWallet);

  // Save updated metadata
  saveVaultMeta({
    ...meta,
    derivedWallets: wallets,
  });

  return {
    index: newIndex,
    name: newWallet.name,
    address: derived.address,
  };
}

/**
 * Rename a derived wallet
 * @param {number} index - Wallet index
 * @param {string} newName - New wallet name
 */
async function renameDerivedWallet(index, newName) {
  const meta = getVaultMeta();
  if (!meta) {
    throw new Error('No vault found');
  }

  const wallets = meta.derivedWallets || [{ index: 0, name: 'Main Wallet' }];
  const walletIndex = wallets.findIndex(w => w.index === index);

  if (walletIndex === -1) {
    throw new Error(`Wallet with index ${index} does not exist`);
  }

  wallets[walletIndex].name = newName;

  saveVaultMeta({
    ...meta,
    derivedWallets: wallets,
  });
}

/**
 * Delete a derived wallet
 * @param {number} index - Wallet index (cannot be 0)
 */
async function deleteDerivedWallet(index) {
  if (index === 0) {
    throw new Error('Cannot delete the main wallet (index 0)');
  }

  const meta = getVaultMeta();
  if (!meta) {
    throw new Error('No vault found');
  }

  const wallets = meta.derivedWallets || [{ index: 0, name: 'Main Wallet' }];
  const walletIndex = wallets.findIndex(w => w.index === index);

  if (walletIndex === -1) {
    throw new Error(`Wallet with index ${index} does not exist`);
  }

  // Remove from list
  wallets.splice(walletIndex, 1);

  // If active wallet was deleted, reset to main wallet
  let activeIndex = meta.activeWalletIndex ?? 0;
  if (activeIndex === index) {
    activeIndex = 0;
  }

  saveVaultMeta({
    ...meta,
    derivedWallets: wallets,
    activeWalletIndex: activeIndex,
  });
}

/**
 * Get active wallet address
 * @returns {Promise<string|null>}
 */
async function getActiveWalletAddress() {
  const identity = await loadIdentityModule();
  const meta = getVaultMeta();

  if (!meta) {
    return null;
  }

  const activeIndex = meta.activeWalletIndex ?? 0;
  const mnemonic = identity.getMnemonic();

  if (mnemonic) {
    const derived = identity.deriveUserWallet(mnemonic, activeIndex);
    return derived.address;
  }

  // Vault locked - can only return main wallet address from stored meta
  if (activeIndex === 0) {
    return meta.addresses?.userWallet || null;
  }

  return null;
}

/**
 * Change vault password
 * @param {string} currentPassword
 * @param {string} newPassword
 */
async function changeVaultPassword(currentPassword, newPassword) {
  const identity = await loadIdentityModule();
  const dataDir = getIdentityDataDir();
  await identity.changePassword(dataDir, currentPassword, newPassword);
  console.log('[IdentityManager] Vault password changed');
}

/**
 * Delete vault (dangerous!)
 * @param {string} password - Must verify password
 */
async function deleteVaultData(password) {
  const identity = await loadIdentityModule();
  const dataDir = getIdentityDataDir();
  await identity.deleteVault(dataDir, password);
  derivedKeys = null;
  injectedNodes = { bee: false, ipfs: false, radicle: false };
  console.log('[IdentityManager] Vault deleted');
}

/**
 * Register IPC handlers for identity operations
 */
function registerIdentityIpc() {
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
      const identity = await loadIdentityModule();
      const mnemonic = identity.createMnemonic(strength);
      return { success: true, mnemonic };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Create new vault
  ipcMain.handle(IPC.IDENTITY_CREATE_VAULT, async (_event, password, strength, userKnowsPassword) => {
    try {
      const mnemonic = await createNewVault(password, strength, userKnowsPassword);
      return { success: true, mnemonic };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Import mnemonic
  ipcMain.handle(IPC.IDENTITY_IMPORT_MNEMONIC, async (_event, password, mnemonic, userKnowsPassword) => {
    try {
      await importExistingMnemonic(password, mnemonic, userKnowsPassword);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get vault metadata (setup type, etc.)
  ipcMain.handle('identity:get-vault-meta', () => {
    return getVaultMeta();
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

  // Export mnemonic
  ipcMain.handle(IPC.IDENTITY_EXPORT_MNEMONIC, async () => {
    try {
      const mnemonic = await exportMnemonic();
      return { success: true, mnemonic };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Export private key for a specific wallet
  ipcMain.handle(IPC.IDENTITY_EXPORT_PRIVATE_KEY, async (_event, accountIndex) => {
    try {
      const identity = await loadIdentityModule();
      const privateKey = identity.exportPrivateKey(accountIndex);
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
      const identity = await loadIdentityModule();
      return { valid: identity.isValidMnemonic(mnemonic) };
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
      const wallets = await getDerivedWallets();
      return { success: true, wallets };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get active wallet index
  ipcMain.handle('wallet:get-active-index', () => {
    try {
      const index = getActiveWalletIndex();
      return { success: true, index };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Set active wallet
  ipcMain.handle('wallet:set-active-wallet', async (_event, index) => {
    try {
      await setActiveWalletIndex(index);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Create new derived wallet
  ipcMain.handle('wallet:create-derived-wallet', async (_event, name) => {
    try {
      const wallet = await createDerivedWallet(name);
      return { success: true, wallet };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Rename wallet
  ipcMain.handle('wallet:rename-wallet', async (_event, index, newName) => {
    try {
      await renameDerivedWallet(index, newName);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Delete wallet
  ipcMain.handle('wallet:delete-wallet', async (_event, index) => {
    try {
      await deleteDerivedWallet(index);
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
  loadIdentityModule,
  registerIdentityIpc,

  // Vault operations
  hasVault,
  isVaultUnlocked,
  createNewVault,
  importExistingMnemonic,
  unlockVault,
  lockVault,
  exportMnemonic,
  changeVaultPassword,
  deleteVaultData,

  // Key operations
  getDerivedKeys,

  // Multi-wallet operations
  getDerivedWallets,
  getActiveWalletIndex,
  setActiveWalletIndex,
  createDerivedWallet,
  renameDerivedWallet,
  deleteDerivedWallet,
  getActiveWalletAddress,

  // Identity injection
  injectBeeIdentity,
  injectIpfsIdentity,
  injectRadicleIdentity,
  injectAllIdentities,

  // Status
  getIdentityStatus,
  isBeeIdentityInjected,
  isIpfsIdentityInjected,
  isRadicleIdentityInjected,

  // Data directories
  getIdentityDataDir,
  getBeeDataDir,
  getIpfsDataDir,
  getRadicleDataDir,
};
