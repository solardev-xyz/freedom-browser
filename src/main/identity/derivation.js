/**
 * Unified key derivation from BIP-39 mnemonic
 *
 * Derives all node identities from a single mnemonic:
 * - Ethereum keys (secp256k1) via BIP-44
 * - Ed25519 keys via SLIP-0010
 */

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

  // Swarm publisher keys (secp256k1) - dedicated namespace for feed signing
  // One key per origin index: m/44'/73406'/{originIndex}'/0/0
  SWARM_PUBLISHER: "m/44'/73406'",       // base path (without trailing segments)
};

// A wallet account at an explicit path may not sit on a key Freedom already
// uses for something else: a dApp could then ask that key to sign.
const RESERVED_WALLET_PATH_PREFIXES = ["m/44'/73404'", "m/44'/73405'", PATHS.SWARM_PUBLISHER];
const MAX_WALLET_PATH_DEPTH = 10;
const MAX_WALLET_PATH_INDEX = 0x7fffffff;
const INVALID_WALLET_PATH = "Enter a path like m/44'/60'/0'/0/0";

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
 * Normalize a user-supplied wallet path to its canonical `m/...` form.
 * Ledger's format (no leading `m/`) is accepted. Numbers are rewritten
 * without leading zeros, so `m/044'/...` cannot slip past the reserved-path
 * check while still deriving the same key.
 * @param {string} path
 * @returns {string} Canonical path, e.g. "m/44'/60'/0'/0/0"
 */
function normalizeWalletPath(path) {
  if (typeof path !== 'string') {
    throw new Error(INVALID_WALLET_PATH);
  }
  const trimmed = path.trim();
  const segments = (trimmed.startsWith('m/') ? trimmed.slice(2) : trimmed).split('/');
  if (segments.length > MAX_WALLET_PATH_DEPTH) {
    throw new Error(INVALID_WALLET_PATH);
  }
  const normalized = segments.map((segment) => {
    const match = /^(\d{1,10})('?)$/.exec(segment);
    if (!match || Number(match[1]) > MAX_WALLET_PATH_INDEX) {
      throw new Error(INVALID_WALLET_PATH);
    }
    return `${Number(match[1])}${match[2]}`;
  });
  return `m/${normalized.join('/')}`;
}

/**
 * Derive a user wallet at an explicit path, for accounts that don't follow
 * Freedom's default `m/44'/60'/{accountIndex}'/0/0` scheme. Every derivation
 * re-checks the path, signing included, because the path comes back from
 * vault-meta.json, which sits outside the encrypted vault.
 * @param {string} mnemonic - BIP-39 mnemonic
 * @param {string} path - Derivation path, with or without the leading `m/`
 * @returns {Object} { privateKey, publicKey, address, path } with `path` canonical
 */
function deriveWalletAtPath(mnemonic, path) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  const normalized = normalizeWalletPath(path);
  if (normalized === PATHS.BEE_WALLET) {
    throw new Error("This path is your Swarm node's wallet, so it can't be added as an account");
  }
  const reserved = RESERVED_WALLET_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
  if (reserved) {
    throw new Error("This path is reserved for Freedom's node and publishing keys");
  }
  return deriveEthereumKey(mnemonic, normalized);
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
  normalizeWalletPath,
  deriveWalletAtPath,
  derivePublisherKey,
  getSeed,
  PATHS,
};
