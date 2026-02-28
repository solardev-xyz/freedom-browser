/**
 * Unified Identity Module
 *
 * Derives and manages all node identities from a single BIP-39 mnemonic.
 */

// Key derivation
export {
  createMnemonic,
  isValidMnemonic,
  deriveAllKeys,
  deriveEthereumKey,
  deriveEd25519Key,
  deriveUserWallet,
  getSeed,
  PATHS,
} from './derivation.js';

// Key formats
export {
  createBeeKeystore,
  getBeeAddress,
  createIpfsIdentity,
  createRadicleIdentity,
  didFromPublicKey,
} from './formats.js';

// Key injection
export {
  injectBeeKey,
  injectIpfsKey,
  injectRadicleKey,
  createMinimalIpfsConfig,
  createBeeConfig,
} from './injection.js';

// Identity vault
export {
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
} from './vault.js';
