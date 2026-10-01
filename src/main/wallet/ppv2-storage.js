/** Profile/account-bound encrypted SDK cache with a main-owned compatibility
 * record. Changing identity, deployment or SDK pins requires explicit migration.
 */
const path = require('path');
const { createPrivacyProfileGuard } = require('./privacy-profile-guard');
const { createHmac } = require('crypto');
const { mnemonicToSeedSync } = require('@scure/bip39');
const vault = require('../identity/vault');
const { assertPPv2Context, PPV2_IDENTITY } = require('../identity/ppv2-keys');
const { privacyError } = require('../networks/privacy-context');
const { createPrivacyStorage } = require('./privacy-storage');
const BINDING_KEY = 'freedom-ppv2-binding-v1';

async function createPPv2Storage({ handle, accountIndex, binding }) {
  const { context, profile } = assertPPv2Context(handle, 'storage', accountIndex);
  const signal = vault.getSessionSignal();
  if (signal.aborted || !vault.getMnemonic())
    throw privacyError('PRIVACY_VAULT_LOCKED', 'PPv2 storage is locked');
  // Identity/pins are deliberately NOT part of the filename/key derivation:
  // opening incompatible state must refuse, not look like an empty account.
  const seed = mnemonicToSeedSync(vault.getMnemonic());
  let key, storage;
  try {
    key = createHmac('sha256', seed)
      .update('Freedom PPv2 storage v1\0')
      .update(JSON.stringify([context.profileId, context.subject]))
      .digest();
    storage = createPrivacyStorage({
      handle,
      directory: path.join(profile.userDataDir, 'wallet-ppv2-experiment'),
      key,
      profileGuard: createPrivacyProfileGuard({ handle, profile, seed }),
    });
  } finally {
    seed.fill(0);
    key?.fill(0);
  }
  const expected = JSON.stringify({ identity: PPV2_IDENTITY, accountIndex, binding });
  function assertActive() {
    assertPPv2Context(handle, 'storage', accountIndex);
    if (signal.aborted || signal !== vault.getSessionSignal())
      throw privacyError('PRIVACY_VAULT_LOCKED', 'PPv2 storage is locked');
  }
  assertActive();
  await storage.update(BINDING_KEY, (existing) => {
    if (existing !== null && existing !== expected)
      throw privacyError('PRIVATE_PPV2_STATE_MISMATCH', 'PPv2 state requires a reviewed migration');
    return expected;
  });
  assertActive();
  function checkName(name) {
    assertActive();
    if (typeof name !== 'string' || !name.startsWith('ppv2:controlled:')) {
      throw privacyError('PRIVATE_PPV2_STORAGE_REFUSED', 'SDK state is outside its namespace');
    }
  }
  return Object.freeze({
    _brand: 'Storage',
    async get(name) {
      checkName(name);
      const value = await storage.get(name);
      assertActive();
      return value;
    },
    async set(name, value) {
      checkName(name);
      await storage.set(name, value);
      assertActive();
    },
  });
}

module.exports = { createPPv2Storage };
