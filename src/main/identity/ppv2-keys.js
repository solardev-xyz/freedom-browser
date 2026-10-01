/** Experimental Kohaku PPv2 derivation capability. Main alone creates it;
 * the reviewed plugin receives one dedicated signer key, never the mnemonic.
 * The provisional upstream identity must not be used for production accounts.
 */
const { createHash } = require('crypto');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { HDNodeWallet } = require('ethers');
const vault = require('./vault');
const { getActiveProfile } = require('../profile-resolver');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');

const PPV2_IDENTITY = Object.freeze({
  version: 1,
  appIdentifier: 'TODO-privacy-pools-v2',
  pathFamily: "m/28784'/2'",
  provisional: true,
});

function assertPPv2Context(handle, role, accountIndex) {
  const context = getPrivacyContext(handle);
  const profile = getActiveProfile();
  const subject = context.subject;
  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > 65535 ||
    subject.kind !== 'private-account' ||
    subject.principal !== `ppv2:${accountIndex}` ||
    subject.protocol !== 'privacy-pools-v2' ||
    subject.deployment !== 'sepolia' ||
    subject.chainId !== 11155111 ||
    subject.role !== role ||
    subject.operation !== null ||
    !profile?.id ||
    !profile.userDataDir ||
    context.profileId !==
      createHash('sha256')
        .update(JSON.stringify([profile.id, profile.userDataDir]))
        .digest('hex')
  ) {
    throw privacyError('PRIVATE_PPV2_SCOPE', 'Unsupported PPv2 account scope');
  }
  return { context, profile };
}

function createPPv2Keystore(handle, accountIndex) {
  assertPPv2Context(handle, 'keystore', accountIndex);
  const signal = vault.getSessionSignal();
  const path = `${PPV2_IDENTITY.pathFamily}/${accountIndex}'`;
  function assertActive() {
    assertPPv2Context(handle, 'keystore', accountIndex);
    if (signal.aborted || signal !== vault.getSessionSignal() || !vault.getMnemonic()) {
      throw privacyError('PRIVACY_VAULT_LOCKED', 'PPv2 keystore is locked');
    }
  }
  assertActive();
  return Object.freeze({
    descriptor: Object.freeze({ ...PPV2_IDENTITY, accountIndex }),
    async deriveAt(requested) {
      assertActive();
      if (requested !== path)
        throw privacyError(
          'PRIVATE_DERIVATION_REFUSED',
          'Derivation path is outside this PPv2 account'
        );
      const seed = mnemonicToSeedSync(vault.getMnemonic());
      try {
        const key = HDNodeWallet.fromSeed(seed).derivePath(path).privateKey;
        assertActive();
        return key;
      } finally {
        seed.fill(0);
      }
    },
  });
}

module.exports = { PPV2_IDENTITY, assertPPv2Context, createPPv2Keystore };
