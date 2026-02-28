/**
 * Unified key derivation from BIP-39 mnemonic
 *
 * Derives all node identities from a single mnemonic:
 * - Ethereum keys (secp256k1) via BIP-44
 * - Ed25519 keys via SLIP-0010
 */

import { mnemonicToSeedSync, validateMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDNodeWallet, Mnemonic } from 'ethers';

// SLIP-0010 for Ed25519 derivation
import HDKey from 'micro-key-producer/slip10.js';

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
};

/**
 * Generate a new BIP-39 mnemonic
 * @param {number} strength - Entropy bits (128 = 12 words, 256 = 24 words)
 * @returns {string} Space-separated mnemonic words
 */
export function createMnemonic(strength = 256) {
  return generateMnemonic(wordlist, strength);
}

/**
 * Validate a BIP-39 mnemonic
 * @param {string} mnemonic - Space-separated mnemonic words
 * @returns {boolean} True if valid
 */
export function isValidMnemonic(mnemonic) {
  if (!mnemonic || typeof mnemonic !== 'string') return false;
  return validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive all keys from a mnemonic
 * @param {string} mnemonic - BIP-39 mnemonic
 * @returns {Object} All derived keys and identities
 */
export function deriveAllKeys(mnemonic) {
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
export function deriveEthereumKey(mnemonic, path) {
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
export function deriveUserWallet(mnemonic, accountIndex = 0) {
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
export function deriveEd25519Key(seed, path) {
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
 * Get the seed from a mnemonic (for direct use with SLIP-0010)
 * @param {string} mnemonic - BIP-39 mnemonic
 * @returns {Uint8Array} 64-byte seed
 */
export function getSeed(mnemonic) {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  return mnemonicToSeedSync(mnemonic);
}

// Export paths for testing and reference
export { PATHS };
