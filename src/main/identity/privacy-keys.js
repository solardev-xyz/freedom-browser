/** Restricted Railgun host keystore. No mnemonic or generic derivation API is
 * handed to plugins. Algorithm: babyjubjub-seed HMAC hardened tree, matching
 * derive-railgun-keys 0.1.0 (https://github.com/kassandraoftroy/derive-railgun-keys).
 */
const { mnemonicToSeedSync } = require('@scure/bip39');
const { deriveRailgunKey } = require('./railgun-key-derivation');
const vault = require('./vault');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');

function createRailgunKeystore(handle, keyIndex = 0) {
  const context = getPrivacyContext(handle);
  const { subject } = context;
  if (
    subject.kind !== 'private-account' ||
    subject.protocol !== 'railgun' ||
    subject.role !== 'keystore' ||
    subject.chainId !== 11155111 ||
    subject.deployment !== 'sepolia' ||
    !Number.isInteger(keyIndex) ||
    keyIndex < 0 ||
    keyIndex > 65535
  ) {
    throw privacyError('PRIVATE_DERIVATION_REFUSED', 'Unsupported privacy key scope');
  }
  const vaultSignal = vault.getSessionSignal();
  const paths = [44, 420].map((purpose) => `m/${purpose}'/1984'/0'/0'/${keyIndex}'`);
  function assertActive() {
    getPrivacyContext(handle);
    if (vaultSignal.aborted || vaultSignal !== vault.getSessionSignal() || !vault.getMnemonic()) {
      throw privacyError('PRIVACY_VAULT_LOCKED', 'Privacy keystore is locked');
    }
  }
  assertActive();
  return Object.freeze({
    descriptor: Object.freeze({
      protocol: 'railgun',
      algorithm: 'babyjubjub-hardened-v1',
      keyIndex,
    }),
    async deriveAt(path) {
      assertActive();
      if (!paths.includes(path))
        throw privacyError(
          'PRIVATE_DERIVATION_REFUSED',
          'Derivation path is outside this privacy account'
        );
      const seed = mnemonicToSeedSync(vault.getMnemonic());
      let node;
      try {
        node = deriveRailgunKey(seed, path);
        assertActive();
        return `0x${node.subarray(0, 32).toString('hex')}`;
      } finally {
        seed.fill(0);
        node?.fill(0);
      }
    },
  });
}

// Engine-facing view capability: never pass the broader keystore above across
// the process boundary. The spending key is reserved for a reviewed host signer.
function createRailgunViewingKeystore(handle, keyIndex = 0) {
  const keystore = createRailgunKeystore(handle, keyIndex);
  const viewingPath = `m/420'/1984'/0'/0'/${keyIndex}'`;
  return Object.freeze({
    async deriveAt(path) {
      if (path !== viewingPath)
        throw privacyError(
          'PRIVATE_DERIVATION_REFUSED',
          'Viewing capability cannot derive this key'
        );
      return keystore.deriveAt(path);
    },
  });
}

module.exports = { createRailgunKeystore, createRailgunViewingKeystore };
