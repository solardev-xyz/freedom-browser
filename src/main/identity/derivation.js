/**
 * Unified key derivation from BIP-39 mnemonic
 *
 * Derives all node identities from a single mnemonic:
 * - Ethereum keys (secp256k1) via BIP-44
 * - Ed25519 keys via SLIP-0010
 */

const { createHash } = require('crypto');
const { mnemonicToSeedSync, validateMnemonic, generateMnemonic } = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english.js');
const { HDNodeWallet, Mnemonic } = require('ethers');

// SLIP-0010 for Ed25519 derivation
const { HDKey } = require('micro-key-producer/slip10.js');

// Derivation paths
// Using custom coin types for Ed25519 to avoid conflicts
// 73404 = "RAD" in ASCII (R=82, A=65, D=68 -> 82*1000 + 65*10 + 68 = nah, just picked unique numbers)
// These are in the "unregistered" range (>= 0x80000000 is hardened)
const PATHS = {
  // Ethereum (secp256k1) - standard BIP-44
  USER_WALLET: "m/44'/60'/0'/0/0",      // Account 0 - main user wallet
  BEE_WALLET: "m/44'/60'/0'/0/1",       // Account 1 - Bee node wallet

  // Ed25519 via SLIP-0010 - custom coin types
  // All segments must be hardened for Ed25519
  RADICLE: "m/44'/73404'/0'/0'/0'",     // Radicle DID
  IPFS: "m/44'/73405'/0'/0'/0'",        // IPFS PeerID

  // Swarm publisher keys (secp256k1) - dedicated namespace for feed signing.
  // Counter-numbered (before #1155): m/44'/73406'/{originIndex}'/0/0
  // Per site: m/44'/73406'/{a}'/{b}'/{c}'/{n}', see sitePublisherKeyPath
  SWARM_PUBLISHER: "m/44'/73406'",       // base path (without trailing segments)

  // Page encryption keys (secp256k1) - one per site, for key agreement only.
  // m/44'/73407'/{a}'/{b}'/{c}', where a, b, c come from the site's
  // permission key (see siteEncryptionKeyPath)
  SWARM_ENCRYPTION: "m/44'/73407'",      // base path (without trailing segments)
};

// Domain separation for the hash that turns a site into its key path. The
// path, and so the key, must never change for a site: anything encrypted to
// the key would become unreadable. Changing this string, the hash, or the
// way the permission key is formed is therefore a breaking change. The label
// is vendor-neutral on purpose: the Swarm provider API's encryption
// extension (SWIP) specifies this recipe, so every browser that follows it
// derives the same key for a site from the same recovery phrase.
const SITE_ENCRYPTION_KEY_DOMAIN = 'swarm-provider/encryption-key/v1\n';

// The same for a site's publisher keys (#1155): the recipe the Swarm
// provider SWIP specifies, so a restored recovery phrase gives a site the
// same signing keys, and so the same feeds, in any browser that follows it.
// Changing it changes the owner of every feed those keys signed.
const SITE_PUBLISHER_KEY_DOMAIN = 'swarm-provider/publisher-key/v1\n';

/**
 * Generate a new BIP-39 mnemonic
 * @param {number} strength - Entropy bits (128 = 12 words, 256 = 24 words)
 * @returns {string} Space-separated mnemonic words
 */
function createMnemonic(strength = 256) {
  return generateMnemonic(wordlist, strength);
}

/**
 * Validate a BIP-39 mnemonic
 * @param {string} mnemonic - Space-separated mnemonic words
 * @returns {boolean} True if valid
 */
function isValidMnemonic(mnemonic) {
  if (!mnemonic || typeof mnemonic !== 'string') return false;
  return validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive all keys from a mnemonic
 * @param {string} mnemonic - BIP-39 mnemonic
 * @returns {Object} All derived keys and identities
 */
function deriveAllKeys(mnemonic) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  const seed = mnemonicToSeedSync(mnemonic);

  // Derive Ethereum keys (secp256k1) via ethers.js
  const userWallet = deriveEthereumKey(mnemonic, PATHS.USER_WALLET);
  const beeWallet = deriveEthereumKey(mnemonic, PATHS.BEE_WALLET);

  // Derive Ed25519 keys via SLIP-0010
  const radicleKey = deriveEd25519Key(seed, PATHS.RADICLE);
  const ipfsKey = deriveEd25519Key(seed, PATHS.IPFS);

  return {
    userWallet,
    beeWallet,
    radicleKey,
    ipfsKey,
  };
}

/**
 * Derive an Ethereum key at a specific BIP-44 path
 * @param {string} mnemonic - BIP-39 mnemonic
 * @param {string} path - Derivation path (e.g., "m/44'/60'/0'/0/0")
 * @returns {Object} { privateKey, publicKey, address }
 */
function deriveEthereumKey(mnemonic, path) {
  // Create Mnemonic object and derive HD wallet at specific path
  const mnemonicObj = Mnemonic.fromPhrase(mnemonic);
  const wallet = HDNodeWallet.fromMnemonic(mnemonicObj, path);

  return {
    privateKey: wallet.privateKey,         // 0x-prefixed hex
    publicKey: wallet.publicKey,           // 0x-prefixed hex (compressed)
    address: wallet.address,               // 0x-prefixed checksummed address
    path,
  };
}

/**
 * Derive a user wallet at a specific account index
 * Uses BIP-44 path: m/44'/60'/{accountIndex}'/0/0
 * Account 0 is the main wallet, accounts 1+ are additional wallets
 * @param {string} mnemonic - BIP-39 mnemonic
 * @param {number} accountIndex - Account index (0, 1, 2, ...)
 * @returns {Object} { privateKey, publicKey, address, path, accountIndex }
 */
function deriveUserWallet(mnemonic, accountIndex = 0) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  if (typeof accountIndex !== 'number' || accountIndex < 0 || !Number.isInteger(accountIndex)) {
    throw new Error('Account index must be a non-negative integer');
  }

  const path = `m/44'/60'/${accountIndex}'/0/0`;
  const wallet = deriveEthereumKey(mnemonic, path);

  return {
    ...wallet,
    accountIndex,
  };
}

/**
 * Derive an Ed25519 key at a specific SLIP-0010 path
 * @param {Uint8Array} seed - BIP-39 seed bytes
 * @param {string} path - Derivation path (must be all hardened for Ed25519)
 * @returns {Object} { privateKey, publicKey, path }
 */
function deriveEd25519Key(seed, path) {
  // micro-key-producer's slip10 HDKey for Ed25519 derivation
  const master = HDKey.fromMasterSeed(seed);
  const derived = master.derive(path);

  return {
    privateKey: derived.privateKey,        // Uint8Array (32 bytes)
    publicKey: derived.publicKeyRaw,       // Uint8Array (32 bytes) - raw, without prefix
    path,
  };
}

/**
 * Derive a Swarm publisher key at a specific origin index.
 * Uses BIP-44 path: m/44'/73406'/{originIndex}'/0/0
 * These are dedicated secp256k1 keys for feed signing — separate from
 * the user wallet, Bee wallet, and all other identity namespaces.
 * @param {string} mnemonic - BIP-39 mnemonic
 * @param {number} originIndex - Origin index (0, 1, 2, ...)
 * @returns {Object} { privateKey, publicKey, address, path, originIndex }
 */
function derivePublisherKey(mnemonic, originIndex) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  if (typeof originIndex !== 'number' || originIndex < 0 || !Number.isInteger(originIndex)) {
    throw new Error('Origin index must be a non-negative integer');
  }

  const path = `${PATHS.SWARM_PUBLISHER}/${originIndex}'/0/0`;
  const key = deriveEthereumKey(mnemonic, path);

  return {
    ...key,
    originIndex,
  };
}

/**
 * The derivation path of a site's encryption key. Three hardened indexes
 * (93 bits) taken from a SHA-256 of the site's permission key, so that two
 * sites practically never share a key, and the same recovery phrase gives
 * the same key for a site on any device, with no stored index.
 * @param {string} site - The site's permission key (e.g. 'myapp.eth')
 * @returns {string} m/44'/73407'/{a}'/{b}'/{c}'
 */
function siteEncryptionKeyPath(site) {
  return `${PATHS.SWARM_ENCRYPTION}/${siteHardenedIndexes(SITE_ENCRYPTION_KEY_DOMAIN, site)}`;
}

/**
 * Three hardened path indexes for a site: the first three big-endian 32-bit
 * words of SHA-256(domain + site), each with its top bit cleared.
 * @returns {string} "{a}'/{b}'/{c}'"
 */
function siteHardenedIndexes(domain, site) {
  if (typeof site !== 'string' || site.length === 0) {
    throw new Error('Site must be a non-empty string');
  }
  const digest = createHash('sha256').update(domain + site, 'utf8').digest();
  return [0, 4, 8].map((offset) => `${digest.readUInt32BE(offset) & 0x7fffffff}'`).join('/');
}

/**
 * The derivation path of a site's publisher key number `index` (0 for the
 * site's first app-scoped identity, 1 for its second, ...). Restoring the
 * recovery phrase restores each one, found by trying index 0, 1, 2, ...
 * @param {string} site - The site's permission key (e.g. 'myapp.eth')
 * @param {number} index - The site's identity number
 * @returns {string} m/44'/73406'/{a}'/{b}'/{c}'/{index}'
 */
function sitePublisherKeyPath(site, index) {
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new Error('Site key index must be an integer from 0 to 2^31 - 1');
  }
  return `${PATHS.SWARM_PUBLISHER}/${siteHardenedIndexes(SITE_PUBLISHER_KEY_DOMAIN, site)}/${index}'`;
}

/**
 * Derive a site's publisher key number `index`: a secp256k1 key that signs
 * the site's feeds and single-owner chunks (an app-scoped identity).
 * @param {string} mnemonic - BIP-39 mnemonic
 * @param {string} site - The site's permission key
 * @param {number} index - The site's identity number
 * @returns {Object} { privateKey, publicKey, address, path }
 */
function deriveSitePublisherKey(mnemonic, site, index) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  return deriveEthereumKey(mnemonic, sitePublisherKeyPath(site, index));
}

/**
 * Derive a site's encryption key: a secp256k1 key used only for key
 * agreement (ECDH) on behalf of that site, never for signing.
 * @param {string} mnemonic - BIP-39 mnemonic
 * @param {string} site - The site's permission key
 * @returns {Object} { privateKey, publicKey, path }
 */
function deriveSiteEncryptionKey(mnemonic, site) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  const { privateKey, publicKey, path } = deriveEthereumKey(mnemonic, siteEncryptionKeyPath(site));
  return { privateKey, publicKey, path };
}

/**
 * Get the seed from a mnemonic (for direct use with SLIP-0010)
 * @param {string} mnemonic - BIP-39 mnemonic
 * @returns {Uint8Array} 64-byte seed
 */
function getSeed(mnemonic) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  return mnemonicToSeedSync(mnemonic);
}

module.exports = {
  createMnemonic,
  isValidMnemonic,
  deriveAllKeys,
  deriveEthereumKey,
  deriveEd25519Key,
  deriveUserWallet,
  derivePublisherKey,
  siteEncryptionKeyPath,
  deriveSiteEncryptionKey,
  sitePublisherKeyPath,
  deriveSitePublisherKey,
  getSeed,
  PATHS,
};
