/**
 * K-1 review: the vault authority epoch. A lock, a vault delete or app quit
 * revokes every key read before it, including keys that work in flight
 * already holds: a paused injection, an unlock still decrypting, a queued
 * feed write. The mutable key bytes are zeroed.
 *
 * Real vault, identity-manager and injection; the password hashing is
 * stubbed, and can be held to order the steps.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

// Each decrypt waits for the next queued hold, if any.
const mockDecryptHolds = [];
jest.mock('@metamask/browser-passworder', () => ({
  encrypt: async (password, value) => JSON.stringify({ password, value }),
  decrypt: async (password, text) => {
    const hold = mockDecryptHolds.shift();
    if (hold) await hold;
    const stored = JSON.parse(text);
    if (stored.password !== password) throw new Error('Incorrect password');
    return stored.value;
  },
}));

const AUTO_LOCK_MS = 15 * 60 * 1000;
const PASSWORD = 'correct horse battery';
const ENV_KEYS = [
  'FREEDOM_ANT_DATA',
  'FREEDOM_IPFS_DATA',
  'FREEDOM_RADICLE_DATA',
  'FREEDOM_IDENTITY_DATA',
];

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('vault authority epoch (K-1)', () => {
  let tempRoot;
  let envSnapshot;
  let dirs;

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-vault-epoch-'));
    dirs = {};
    for (const key of ENV_KEYS) {
      dirs[key] = path.join(tempRoot, key.toLowerCase());
      process.env[key] = dirs[key];
    }
    fs.mkdirSync(path.join(tempRoot, 'user-data'), { recursive: true });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDecryptHolds.length = 0;
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

  function load(extraMocks = {}) {
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: path.join(tempRoot, 'user-data'),
      extraMocks,
    });
    return {
      manager: mod,
      vault: require('./identity'),
      vaultAccess: require('./wallet/vault-access'),
    };
  }

  async function expectRevoked({ manager, vault, vaultAccess }) {
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.getMnemonic()).toBeNull();
    expect(manager.getDerivedKeys()).toBeNull();
    await expect(vaultAccess.withVaultPrivateKey(0, () => 'signed')).rejects.toThrow(/locked/i);
  }

  const radicleKeyFile = () => path.join(dirs.FREEDOM_RADICLE_DATA, 'keys', 'radicle');
  const swarmKeyFile = () => path.join(dirs.FREEDOM_ANT_DATA, 'keys', 'swarm.key');

  test('an unlock still decrypting when the vault is deleted publishes nothing', async () => {
    const ctx = load();
    await ctx.manager.createNewVault(PASSWORD);
    await ctx.manager.lockVault();

    const held = deferred();
    mockDecryptHolds.push(held.promise);
    const unlocking = ctx.manager.unlockVault(PASSWORD);
    unlocking.catch(() => {});
    await settle();

    // The deletion's own password check decrypts unheld, and completes.
    await ctx.manager.deleteVaultData(PASSWORD);
    expect(fs.existsSync(ctx.vault.getVaultPath(dirs.FREEDOM_IDENTITY_DATA))).toBe(false);

    held.resolve();
    await expect(unlocking).rejects.toThrow(/locked/i);
    await expectRevoked(ctx);
  });

  test('an unlock still decrypting when the vault locks publishes nothing', async () => {
    const ctx = load();
    await ctx.manager.createNewVault(PASSWORD);
    await ctx.manager.lockVault();

    const held = deferred();
    mockDecryptHolds.push(held.promise);
    const unlocking = ctx.manager.unlockVault(PASSWORD);
    unlocking.catch(() => {});
    await settle();
    await ctx.manager.lockVault();

    held.resolve();
    await expect(unlocking).rejects.toThrow(/locked/i);
    await expectRevoked(ctx);

    // A fresh unlock afterwards works.
    await ctx.manager.unlockVault(PASSWORD);
    expect(ctx.manager.getDerivedKeys()).not.toBeNull();
  });

  describe('a paused Radicle injection stops at a lock, delete or auto-lock', () => {
    const revokers = {
      'the explicit lock': (manager) => manager.lockVault(),
      'a vault delete': (manager) => manager.deleteVaultData(PASSWORD),
      'the auto-lock': () => jest.advanceTimersByTime(AUTO_LOCK_MS + 1),
    };

    test.each(Object.keys(revokers))('%s', async (name) => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      const preparing = deferred();
      const ctx = load({
        [require.resolve('./profile-paths')]: () => {
          const actual = jest.requireActual('./profile-paths');
          return {
            ...actual,
            prepareRadicleDataDir: async () => {
              await preparing.promise;
              return actual.prepareRadicleDataDir();
            },
          };
        },
      });
      await ctx.manager.createNewVault(PASSWORD);

      const injecting = ctx.manager.injectRadicleIdentity('Alias');
      injecting.catch(() => {});
      await settle();
      await revokers[name](ctx.manager);

      preparing.resolve();
      await expect(injecting).rejects.toThrow(/locked/i);
      expect(fs.existsSync(radicleKeyFile())).toBe(false);
      await expectRevoked(ctx);
    });
  });

  test('a Bee injection paused while the node stops writes no key after a lock', async () => {
    const ctx = load();
    await ctx.manager.createNewVault(PASSWORD);
    const stopping = deferred();
    const start = jest.fn(async () => {});
    ctx.manager.setBeeLifecycle({ stop: () => stopping.promise.then(() => true), start });

    const injecting = ctx.manager.injectBeeIdentity();
    injecting.catch(() => {});
    await settle();
    await ctx.manager.lockVault();

    stopping.resolve();
    await expect(injecting).rejects.toThrow(/locked/i);
    expect(fs.existsSync(swarmKeyFile())).toBe(false);
    // The node it stopped is started again.
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('a Bee injection paused in keystore generation writes no key after a delete', async () => {
    const generating = deferred();
    const ctx = load({
      [require.resolve('./identity/formats')]: () => {
        const actual = jest.requireActual('./identity/formats');
        return {
          ...actual,
          createBeeKeystore: async (...args) => {
            await generating.promise;
            return actual.createBeeKeystore(...args);
          },
        };
      },
    });
    await ctx.manager.createNewVault(PASSWORD);

    const injecting = ctx.manager.injectBeeIdentity();
    injecting.catch(() => {});
    await settle();
    await ctx.manager.deleteVaultData(PASSWORD);

    generating.resolve();
    await expect(injecting).rejects.toThrow(/locked/i);
    expect(fs.existsSync(swarmKeyFile())).toBe(false);
  }, 30000);

  test('quit revokes the vault and refuses every later unlock, signing and injection', async () => {
    const ctx = load();
    await ctx.manager.createNewVault(PASSWORD);
    expect(ctx.manager.getDerivedKeys()).not.toBeNull();

    ctx.manager.closeVaultAuthority();
    await expectRevoked(ctx);
    await expect(ctx.manager.unlockVault(PASSWORD)).rejects.toThrow(/locked/i);
    await expect(ctx.manager.getPublisherKey(0)).rejects.toThrow(/unlocked/i);
    await expect(ctx.manager.injectAllIdentities('Alias', true)).rejects.toThrow(/locked/i);
    expect(ctx.vault.isUnlocked()).toBe(false);
  });

  describe('the mutable key bytes are zeroed', () => {
    const revokers = {
      'the auto-lock': () => jest.advanceTimersByTime(AUTO_LOCK_MS + 1),
      'the explicit lock': (manager) => manager.lockVault(),
      'a vault delete': (manager) => manager.deleteVaultData(PASSWORD),
      'quit': (manager) => manager.closeVaultAuthority(),
    };

    test.each(Object.keys(revokers))('on %s', async (name) => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      const ctx = load();
      await ctx.manager.createNewVault(PASSWORD);
      const keys = ctx.manager.getDerivedKeys();
      const radicle = keys.radicleKey.privateKey;
      const ipfs = keys.ipfsKey.privateKey;
      expect(radicle.some((byte) => byte !== 0)).toBe(true);
      expect(ipfs.some((byte) => byte !== 0)).toBe(true);

      await revokers[name](ctx.manager);

      expect(radicle.every((byte) => byte === 0)).toBe(true);
      expect(ipfs.every((byte) => byte === 0)).toBe(true);
    });
  });
});
