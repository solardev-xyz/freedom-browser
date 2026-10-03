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

/** Main-only cache store. Its distinct subject/key/file gives disposable scan
 * pages a separate quota from SDK notes; the SDK never receives this capability.
 */
async function createPPv2ScanStorage({ handle, cacheHandle, accountIndex, binding }) {
  const { getPrivacyContext } = require('../networks/privacy-context');
  const { context, profile } = assertPPv2Context(handle, 'storage', accountIndex);
  const cacheContext = getPrivacyContext(cacheHandle);
  if (
    cacheContext.profileId !== context.profileId ||
    cacheContext.generation !== context.generation ||
    JSON.stringify(cacheContext.subject) !==
      JSON.stringify({ ...context.subject, operation: 'scan-cache-v1' })
  )
    throw privacyError('PRIVATE_PPV2_SCOPE', 'Unsupported scan checkpoint scope');
  const signal = vault.getSessionSignal();
  function assertActive() {
    assertPPv2Context(handle, 'storage', accountIndex);
    getPrivacyContext(cacheHandle);
    if (signal.aborted || signal !== vault.getSessionSignal() || !vault.getMnemonic())
      throw privacyError('PRIVACY_VAULT_LOCKED', 'PPv2 scan cache is locked');
  }
  assertActive();
  const seed = mnemonicToSeedSync(vault.getMnemonic());
  let key,
    storage,
    available = true;
  try {
    key = createHmac('sha256', seed)
      .update('Freedom PPv2 scan cache v1\0')
      .update(JSON.stringify([context.profileId, cacheContext.subject]))
      .digest();
    storage = createPrivacyStorage({
      handle: cacheHandle,
      directory: path.join(profile.userDataDir, 'wallet-ppv2-experiment'),
      key,
      profileGuard: createPrivacyProfileGuard({ handle: cacheHandle, profile, seed }),
    });
  } finally {
    seed.fill(0);
    key?.fill(0);
  }
  const expected = JSON.stringify({
    identity: PPV2_IDENTITY,
    accountIndex,
    binding,
    cachePolicy: 1,
  });
  const keyName = 'freedom-ppv2-scan-pages-v1';
  function unpack(value) {
    if (value === null) return null;
    try {
      const envelope = JSON.parse(value);
      return envelope.binding === expected && Object.keys(envelope).length === 2
        ? JSON.stringify(envelope.state)
        : null;
    } catch {
      return null;
    }
  }
  function unreadable(error) {
    if (error.code !== 'PRIVATE_STORAGE_UNREADABLE') throw error;
    available = false;
    console.warn('[PPv2] Scan cache unavailable; continuing with uncached event reads');
  }
  return Object.freeze({
    get available() {
      return available;
    },
    async get() {
      assertActive();
      if (!available) return null;
      try {
        const value = unpack(await storage.get(keyName));
        assertActive();
        return value;
      } catch (error) {
        unreadable(error);
        assertActive();
        return null;
      }
    },
    async update(change) {
      assertActive();
      if (!available) return;
      try {
        await storage.update(keyName, (value) => {
          assertActive();
          return JSON.stringify({ binding: expected, state: JSON.parse(change(unpack(value))) });
        });
        assertActive();
      } catch (error) {
        unreadable(error);
        assertActive();
      }
    },
  });
}
module.exports.createPPv2ScanStorage = createPPv2ScanStorage;
