/**
 * Unified Identity Module
 *
 * Derives and manages all node identities from a single BIP-39 mnemonic.
 */

// Key derivation
const {
  createMnemonic,
  isValidMnemonic,
  deriveAllKeys,
  deriveEthereumKey,
  deriveEd25519Key,
  deriveUserWallet,
  derivePublisherKey,
  getSeed,
  PATHS,
} = require('./derivation');

// Key formats
const {
  createBeeKeystore,
  getBeeAddress,
  createIpfsIdentity,
  createRadicleIdentity,
  didFromPublicKey,
} = require('./formats');

// Key injection
const {
  injectBeeKey,
  injectIpfsKey,
  injectRadicleKey,
  createMinimalIpfsConfig,
  createBeeConfig,
} = require('./injection');

// Identity vault
const {
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
} = require('./vault');

module.exports = {
  createMnemonic,
  isValidMnemonic,
  deriveAllKeys,
  deriveEthereumKey,
  deriveEd25519Key,
  deriveUserWallet,
  derivePublisherKey,
  getSeed,
  PATHS,
  createBeeKeystore,
  getBeeAddress,
  createIpfsIdentity,
  createRadicleIdentity,
  didFromPublicKey,
  injectBeeKey,
  injectIpfsKey,
  injectRadicleKey,
  createMinimalIpfsConfig,
  createBeeConfig,
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
