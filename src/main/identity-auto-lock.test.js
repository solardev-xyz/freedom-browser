/**
 * K-1: the vault's inactivity auto-lock must stop every signer, not only the
 * ones that read the mnemonic. identity-manager caches the keys it derives
 * at unlock; before the fix the auto-lock cleared only the vault's mnemonic,
 * so bee-wallet feed/SOC signing and identity injection kept working while
 * the status said "locked".
 *
 * Real vault, identity-manager, feed-store and Swarm provider; the password
 * hashing is stubbed out (the PBKDF2 cost is irrelevant to lock state).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

jest.mock('@metamask/browser-passworder', () => ({
  encrypt: async (password, value) => JSON.stringify({ password, value }),
  decrypt: async (password, text) => {
    const stored = JSON.parse(text);
    if (stored.password !== password) throw new Error('Incorrect password');
    return stored.value;
  },
}));

const AUTO_LOCK_MS = 15 * 60 * 1000;
const PASSWORD = 'correct horse battery';
const ORIGIN = 'https://feeds.example';
const ENV_KEYS = [
  'FREEDOM_ANT_DATA',
  'FREEDOM_IPFS_DATA',
  'FREEDOM_RADICLE_DATA',
  'FREEDOM_IDENTITY_DATA',
];

describe('vault auto-lock stops every signer (K-1)', () => {
  let tempRoot;
  let envSnapshot;
  let identityManager;
  let feedStore;
  let swarmProvider;
  let vaultAccess;

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-auto-lock-'));
    for (const key of ENV_KEYS) {
      process.env[key] = path.join(tempRoot, key.toLowerCase());
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

    const userDataDir = path.join(tempRoot, 'user-data');
    fs.mkdirSync(userDataDir, { recursive: true });
    ({ mod: identityManager } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir,
      extraMocks: {
        [require.resolve('./swarm/swarm-permissions')]: () => ({
          getPermission: jest.fn(() => ({ origin: ORIGIN })),
          hasMessagingGrant: jest.fn(() => false),
          onRevoke: jest.fn(),
        }),
      },
    }));
    // Same module registry as identity-manager, so they share its state.
    feedStore = require('./swarm/feed-store');
    swarmProvider = require('./swarm/swarm-provider-ipc');
    vaultAccess = require('./wallet/vault-access');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function signingOwner(identityId) {
    feedStore.activateIdentity(ORIGIN, identityId);
    return swarmProvider.executeSwarmMethod('swarm_getSigningIdentity', {}, ORIGIN);
  }

  async function signersAfter(lock) {
    await identityManager.createNewVault(PASSWORD);
    identityManager.lockVault();
    await identityManager.unlockVault(PASSWORD);

    // One origin holding each publisher identity mode, with the feed grant.
    feedStore.ensureAntWalletIdentity(ORIGIN, { activate: true });
    const appScoped = feedStore.createAppScopedIdentity(ORIGIN).activeIdentityId;
    await identityManager.getDerivedWallets();
    await feedStore.ensureEthereumWalletIdentity(ORIGIN, 0);
    feedStore.grantFeedAccess(ORIGIN);
    const ids = {
      'bee-wallet': 'bee-wallet',
      'app-scoped': appScoped,
      'ethereum-wallet': Object.values(feedStore.getOriginEntry(ORIGIN).identities).find(
        (identity) => identity.mode === 'ethereum-wallet'
      ).id,
    };

    // Unlocked: every signer works.
    for (const id of Object.values(ids)) {
      const before = await signingOwner(id);
      expect(before.error).toBeUndefined();
      expect(before.result.owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    await expect(vaultAccess.withVaultPrivateKey(0, () => 'signed')).resolves.toBe('signed');
    expect(identityManager.getDerivedKeys()).not.toBeNull();

    await lock();

    const status = await identityManager.getIdentityStatus();
    expect(status.isUnlocked).toBe(false);
    return ids;
  }

  async function expectEverySignerStopped(ids) {
    expect(identityManager.getDerivedKeys()).toBeNull();
    for (const [mode, id] of Object.entries(ids)) {
      const after = await signingOwner(id);
      expect({ mode, result: after.result }).toEqual({ mode, result: undefined });
      expect(after.error.message).toMatch(/locked|unlocked/i);
    }
    await expect(vaultAccess.withVaultPrivateKey(0, () => 'signed')).rejects.toThrow(/locked/i);
    await expect(identityManager.getPublisherKey(0)).rejects.toThrow(/unlocked/i);
    await expect(identityManager.getUserWalletKey(0)).rejects.toThrow(/unlocked/i);
    await expect(identityManager.injectAllIdentities('Alias', true)).rejects.toThrow(/locked/i);
    await expect(identityManager.injectBeeIdentity()).rejects.toThrow(/locked/i);
    await expect(identityManager.injectRadicleIdentity()).rejects.toThrow(/locked/i);
    await expect(identityManager.exportMnemonic()).rejects.toThrow(/locked/i);
  }

  test('the inactivity auto-lock', async () => {
    const ids = await signersAfter(async () => {
      jest.advanceTimersByTime(AUTO_LOCK_MS + 1);
    });
    await expectEverySignerStopped(ids);
  });

  test('a lock straight through the vault module', async () => {
    const ids = await signersAfter(async () => {
      require('./identity').lockVault();
    });
    await expectEverySignerStopped(ids);
  });

  test('the explicit lock', async () => {
    const ids = await signersAfter(() => identityManager.lockVault());
    await expectEverySignerStopped(ids);
  });

  test('unlocking again restores the signers', async () => {
    await signersAfter(async () => {
      jest.advanceTimersByTime(AUTO_LOCK_MS + 1);
    });
    await identityManager.unlockVault(PASSWORD);
    const again = await signingOwner('bee-wallet');
    expect(again.result.owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
