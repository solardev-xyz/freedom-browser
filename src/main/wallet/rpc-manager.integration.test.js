/**
 * The RPC API keys through the real freedom-cored (freedom-core design
 * 0013, "RPC API keys"; PRF-6(e)): this build names `rpc_api_keys` in the
 * hello's `store_moved`, and the core is the keys' one writer. Main's
 * modules run as main runs them: rpc-manager (its copy of the keys, read
 * at each start of the core), the network registry (keyed URLs from that
 * copy) and network-ipc (the settings page's channels, relayed as the
 * chrome's).
 *
 * - **(T1) No key store** (Linux and Windows until PRF-7, and macOS with no
 *   executor for the core's key-store calls): a set from the settings page
 *   writes rpc-api-keys.json in the reference's text, which the reference
 *   key store (9d4ea6251) reads back (rollback), and a remove takes it out;
 *   an id outside the entry form and an empty key are refused. Keyed
 *   endpoints appear once main's copy is read, and the settings broadcast
 *   follows.
 * - **(T1) macOS, with the job's temporary keychain** (FREEDOM_TEST_KEYCHAIN,
 *   the user's default, as in keystore.integration.test.js): a set lands in
 *   secrets.json and writes no file; a file in the reference's text is
 *   migrated at the core's first RPC-key request and removed, or keeps only
 *   what the secrets file can't hold (rollback: the reference reads just
 *   that); an id outside the entry form and a 17th key are refused.
 * - **(T2)** Main opens no rpc-api-keys.json, reads included, and changes
 *   no mode, through any of the above (an `fs` spy).
 * - **(T3)** The reference key store and rpc-manager, with the hello before
 *   this step (`store_moved: []`), on the pinned core: the echo lacks the
 *   name, all four RPC-key methods answer `not_moved`, the file's digest is
 *   unchanged by each, the core never opens it, and the reference's own
 *   writes still work.
 * - **(T4)** This step's modules on the previous release (0.22.0), which
 *   echoes no store: all four methods fail `requirement_unmet` in main,
 *   networks:get-config answers that failure, main's copy stays empty so
 *   the registry has no keyed endpoint, and nothing writes the file.
 *
 * Skipped without the binaries; FREEDOM_CORED_STORES_TEST=1 requires both
 * (npm run core:download, npm run core:download:previous). CI's e2e-desktop
 * job runs it on each OS, inside the temporary keychain's steps on macOS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  coredBinaries,
  digests,
  openFiles,
  watchWrites,
} = require('../../../test/helpers/store-handover');
const { createIpcMainMock } = require('../../../test/helpers/main-process-test-utils');

const { current, previous } = coredBinaries();
const haveCurrent = !!(current && fs.existsSync(current));
const describeIfCurrent = haveCurrent ? describe : describe.skip;
const describeIfPrevious =
  haveCurrent && previous && fs.existsSync(previous) ? describe : describe.skip;

/** The job's temporary keychain, when it is the user's default (as in
 * keystore.integration.test.js): the only keychain these tests touch. */
const testKeychain = (() => {
  const keychain = process.env.FREEDOM_TEST_KEYCHAIN;
  if (process.platform !== 'darwin' || !keychain) return null;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const out = spawnSync('security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' });
  const actual = real(String(out.stdout || '').trim().replace(/^"|"$/g, ''));
  const expected = [keychain, `${keychain}-db`].map(real).filter(Boolean);
  return actual && expected.includes(actual) ? actual : null;
})();

if (haveCurrent && process.env.FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN === '1' && !testKeychain) {
  throw new Error(
    "FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN=1 needs FREEDOM_TEST_KEYCHAIN, the user's default keychain"
  );
}
const describeIfKeychain = haveCurrent && testKeychain ? describe : describe.skip;

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const posix = process.platform !== 'win32';
const FILE = 'rpc-api-keys.json';
const KEY_FILE = /rpc-api-keys\.json/;
// Built at runtime, so no key-shaped literal sits in the source.
const KEY = ['rpc', 'key', 'core', process.pid.toString(36)].join('-');
const UNMET = "The core can't take this request";

jest.setTimeout(120_000);

const errorOf = (promise) =>
  promise.then(
    (result) => ({ result }),
    (err) => ({ code: err.code, data: err.data, message: err.message })
  );

function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) resolve();
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 50);
    };
    poll();
  });
}

/**
 * Main's own spies on the key file, wider than the write spy: its reads,
 * opens and mode changes (watchWrites with `forbidReads`), and its stats.
 */
function watchKeyFile() {
  const writes = watchWrites(KEY_FILE, { forbidReads: true });
  const stats = ['existsSync', 'statSync', 'lstatSync', 'accessSync'].map((name) => [
    name,
    jest.spyOn(fs, name),
  ]);
  return {
    offending() {
      const out = writes.offending();
      for (const [name, spy] of stats) {
        for (const args of spy.mock.calls) {
          if (KEY_FILE.test(String(args[0]))) out.push({ name, args });
        }
      }
      return out;
    },
    restore() {
      writes.restore();
      for (const [, spy] of stats) spy.mockRestore();
    },
  };
}

describe('RPC API keys through freedom-cored (0013, PRF-6(e))', () => {
  let root;
  let keysPath;
  let core;
  let main;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-keys-core-')));
    keysPath = path.join(root, FILE);
    fs.mkdirSync(path.join(root, 'identity'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'locks'));
    core = null;
    main = null;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await core?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /**
   * A CoreClient on `binary` for this profile (Freedom root `root`, its
   * grant root; identity in `root/identity`), its hello naming `storeMoved`
   * (default: the build's `STORE_MOVED`), with main's key-store executor
   * when `keychain`. Not started.
   */
  function makeCore({ binary = current, storeMoved, keychain = false } = {}) {
    const { CoreClient, _internal } = require('../core/core-client');
    const client = new CoreClient({
      spawn,
      command: binary,
      args: [
        'serve',
        '--data-dir',
        path.join(root, 'identity'),
        '--lock-dir',
        path.join(root, 'locks'),
      ],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    if (storeMoved) client.service = _internal.coreService(storeMoved);
    if (keychain) {
      const { createHelperRunner, registerKeystoreShell } = require('../core/keystore-shell');
      registerKeystoreShell(client, { runner: createHelperRunner({ command: binary }) });
    }
    return client;
  }

  /**
   * Main's modules over `client`, fresh, with electron's userData at `root`
   * (the Freedom root): rpc-manager attached to the client as core-process
   * attaches it, and network-ipc's channels registered.
   */
  function loadMain(client) {
    jest.resetModules();
    const ipcMain = createIpcMainMock();
    const chain = { chainSettingsChanged: jest.fn(), checkEndpointChain: jest.fn(async (id) => id) };
    jest.doMock('electron', () => ({
      app: { isPackaged: false, getPath: () => root, getVersion: () => 'jest' },
      ipcMain,
      webContents: { getAllWebContents: () => [] },
    }));
    jest.doMock('../logger', () => quietLog);
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => client }));
    jest.doMock('../core/chain', () => chain);
    jest.doMock('../ens-resolver', () => ({ invalidateCachedProvider() {} }));
    jest.doMock('../networks/chain-catalog-host', () => ({
      searchChains: async () => [],
      getCatalogChain: async () => null,
    }));
    jest.doMock('../settings-store', () => ({ loadSettings: () => ({}) }));
    jest.doMock('./provider-manager', () => ({
      onApiKeysChanged: () => require('../networks/network-registry').invalidate(),
      clearProviderCache() {},
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));
    const rpc = require('./rpc-manager');
    require('../networks/network-ipc').registerNetworkConfigIpc();
    rpc.attachCore(client);
    return {
      rpc,
      ipcMain,
      chain,
      errors,
      vault: require('../core/vault-backend').vaultBackend,
      registry: require('../networks/network-registry'),
    };
  }

  /** The reference key store and rpc-manager (9d4ea6251) over this profile. */
  function loadReference() {
    jest.resetModules();
    jest.doMock('electron', () => ({
      app: { isPackaged: false, getPath: () => root },
      ipcMain: { handle() {} },
    }));
    jest.doMock('./provider-manager', () => ({ onApiKeysChanged() {} }));
    return {
      store: require('../../../test/helpers/reference-rpc-keys-store'),
      manager: require('../../../test/helpers/reference-rpc-keys-manager'),
    };
  }

  /** Keyed rpc sources in network-config.json, each covering chain 1. */
  function writeKeyedSources(ids) {
    const endpointSources = Object.fromEntries(
      ids.map((id) => [
        id,
        { role: 'rpc', keyed: true, name: id, coverage: { 1: `https://${id}.example/v2/{API_KEY}` } },
      ])
    );
    fs.writeFileSync(path.join(root, 'network-config.json'), JSON.stringify({ endpointSources }));
  }

  const keyedUrls = (chainId = 1) =>
    main.rpc.getEffectiveRpcUrls(chainId).filter((url) => url.includes(KEY));
  const config = () => main.ipcMain.invoke('networks:get-config');
  const hasKey = async (id) =>
    (await config()).sources.find((src) => src.id === id)?.hasKey ?? null;
  const modeOf = (file) => fs.statSync(file).mode & 0o777;
  const secretsEntries = () => {
    const file = path.join(root, 'identity', 'secrets.json');
    return fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).entries || {}) : [];
  };

  /** Runs `task` (main's operations) under the key-file spy, which must stay clean. */
  async function asMain(task) {
    const watch = watchKeyFile();
    try {
      await task();
      expect(watch.offending()).toEqual([]);
    } finally {
      watch.restore();
    }
  }

  describeIfCurrent('with no key store in the core', () => {
    test('a set writes the reference text, which the reference reads back, and a remove takes it out', async () => {
      core = makeCore();
      main = loadMain(core);
      await asMain(async () => {
        await core.start();
        expect(core.hello.store_moved).toEqual(['rpc_api_keys']);
        await expect(
          main.ipcMain.invoke('networks:set-api-key', 'alchemy', KEY)
        ).resolves.toEqual({ success: true });
        expect(main.rpc.hasApiKey('alchemy')).toBe(true);
        expect(keyedUrls()).toEqual([expect.stringContaining(`/${KEY}`)]);
        expect(await hasKey('alchemy')).toBe(true);
        expect(await hasKey('infura')).toBe(false);
        // The settings page's channels followed the change.
        expect(main.chain.chainSettingsChanged).toHaveBeenCalled();
      });

      const text = fs.readFileSync(keysPath, 'utf8');
      const stored = JSON.parse(text);
      expect(stored).toEqual({ alchemy: { apiKey: KEY, enabled: true, addedAt: expect.any(Number) } });
      expect(text).toBe(JSON.stringify(stored, null, 2));
      if (posix) expect(modeOf(keysPath)).toBe(0o600);
      expect(secretsEntries().filter((name) => name.startsWith('rpc-api-key.'))).toEqual([]);
      // Rollback: an older build reads the core's file.
      const reference = loadReference();
      expect(reference.store.readRpcApiKeys()).toEqual(stored);
      expect(reference.manager.hasApiKey('alchemy')).toBe(true);

      main = loadMain(core);
      await asMain(async () => {
        await main.rpc.refreshKeys();
        expect(main.rpc.hasApiKey('alchemy')).toBe(true);
        await expect(main.ipcMain.invoke('networks:remove-api-key', 'alchemy')).resolves.toEqual({
          success: true,
        });
        expect(main.rpc.hasApiKey('alchemy')).toBe(false);
        expect(keyedUrls()).toEqual([]);
        expect(await hasKey('alchemy')).toBe(false);
      });
      expect(loadReference().store.readRpcApiKeys()).toEqual({});
    });

    test('an id outside the entry form and an empty key are refused, with nothing written', async () => {
      writeKeyedSources(['Custom_Up']);
      core = makeCore();
      main = loadMain(core);
      await asMain(async () => {
        await core.start();
        const refused = await main.ipcMain.invoke('networks:set-api-key', 'Custom_Up', KEY);
        expect(refused).toEqual({ success: false, error: expect.stringMatching(/1 to 52 lowercase/) });
        const empty = await main.ipcMain.invoke('networks:set-api-key', 'alchemy', '');
        expect(empty).toEqual({ success: false, error: 'An API key must be 1 to 1,024 bytes long.' });
        // Main's registry still comes first.
        const unknown = await main.ipcMain.invoke('networks:set-api-key', 'no-such', KEY);
        expect(unknown).toEqual({ success: false, error: 'Unknown provider: no-such' });
      });
      expect(fs.existsSync(keysPath)).toBe(false);
    });

    test('keyed endpoints appear once main reads the keys at the core start', async () => {
      // An older build's file, in its own text.
      loadReference().store.writeRpcApiKeys({
        infura: { apiKey: KEY, enabled: true, addedAt: 1 },
      });
      const before = digests([keysPath]);
      core = makeCore();
      main = loadMain(core);
      await asMain(async () => {
        expect(keyedUrls()).toEqual([]);
        expect(main.rpc.hasApiKey('infura')).toBe(false);
        await core.start();
        await waitFor(() => main.rpc.hasApiKey('infura'), "main's copy of the keys");
        expect(keyedUrls()).toEqual([expect.stringContaining(KEY)]);
        expect(main.chain.chainSettingsChanged).toHaveBeenCalledTimes(1);
        expect(await hasKey('infura')).toBe(true);
      });
      // With no key store nothing moves: the file stays, the core's.
      expect(digests([keysPath])).toEqual(before);
    });
  });

  describeIfKeychain('with the temporary keychain (macOS)', () => {
    test('a set lands in the secrets file and writes no key file', async () => {
      core = makeCore({ keychain: true });
      main = loadMain(core);
      await asMain(async () => {
        await core.start();
        await expect(main.ipcMain.invoke('networks:set-api-key', 'alchemy', KEY)).resolves.toEqual({
          success: true,
        });
        expect(keyedUrls()).toEqual([expect.stringContaining(`/${KEY}`)]);
        expect(await hasKey('alchemy')).toBe(true);
      });
      expect(secretsEntries()).toContain('rpc-api-key.alchemy');
      expect(fs.existsSync(keysPath)).toBe(false);
      expect(fs.readFileSync(path.join(root, 'identity', 'secrets.json'), 'utf8')).not.toContain(KEY);
      // Rollback: an older build finds no key, and asks for it again.
      expect(loadReference().store.readRpcApiKeys()).toEqual({});
    });

    test('a key file is migrated at the first request and removed', async () => {
      loadReference().manager.setApiKey('alchemy', KEY);
      expect(fs.existsSync(keysPath)).toBe(true);
      core = makeCore({ keychain: true });
      main = loadMain(core);
      await asMain(async () => {
        await core.start();
        await waitFor(() => main.rpc.hasApiKey('alchemy'), "main's copy of the keys");
        expect(keyedUrls()).toEqual([expect.stringContaining(`/${KEY}`)]);
      });
      expect(secretsEntries()).toContain('rpc-api-key.alchemy');
      expect(fs.existsSync(keysPath)).toBe(false);
    });

    test('the file keeps only what the secrets file cannot hold, which the reference reads', async () => {
      const odd = { apiKey: `${KEY}-odd`, enabled: true, addedAt: 2 };
      loadReference().store.writeRpcApiKeys({
        infura: { apiKey: KEY, enabled: true, addedAt: 1 },
        Odd_Provider: odd,
      });
      writeKeyedSources(['Odd_Provider']);
      core = makeCore({ keychain: true });
      main = loadMain(core);
      await asMain(async () => {
        await core.start();
        await waitFor(() => main.rpc.hasApiKey('infura'), "main's copy of the keys");
        // Both answered: the odd id from the file.
        expect(main.rpc.hasApiKey('Odd_Provider')).toBe(true);
        expect(await hasKey('Odd_Provider')).toBe(true);
        // A set for it is refused; it stays removable.
        const refused = await main.ipcMain.invoke('networks:set-api-key', 'Odd_Provider', KEY);
        expect(refused).toEqual({ success: false, error: expect.stringMatching(/1 to 52 lowercase/) });
      });
      expect(secretsEntries()).toContain('rpc-api-key.infura');
      const left = loadReference().store.readRpcApiKeys();
      expect(left).toEqual({ Odd_Provider: odd });
      expect(fs.readFileSync(keysPath, 'utf8')).toBe(JSON.stringify(left, null, 2));

      main = loadMain(core);
      await asMain(async () => {
        await main.rpc.refreshKeys();
        await expect(main.ipcMain.invoke('networks:remove-api-key', 'Odd_Provider')).resolves.toEqual({
          success: true,
        });
        expect(main.rpc.hasApiKey('Odd_Provider')).toBe(false);
      });
    });

    test('a 17th key is refused, and a replace at the bound taken', async () => {
      const ids = Array.from({ length: 17 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
      writeKeyedSources(ids);
      core = makeCore({ keychain: true });
      main = loadMain(core);
      await asMain(async () => {
        await core.start();
        for (const id of ids.slice(0, 16)) {
          await expect(
            main.ipcMain.invoke('networks:set-api-key', id, `${KEY}-${id}`)
          ).resolves.toEqual({ success: true });
        }
        await expect(main.ipcMain.invoke('networks:set-api-key', 'p17', KEY)).resolves.toEqual({
          success: false,
          error: 'Freedom keeps at most 16 RPC API keys. Remove one, then try again.',
        });
        await expect(
          main.ipcMain.invoke('networks:set-api-key', 'p01', `${KEY}-again`)
        ).resolves.toEqual({ success: true });
        expect(main.rpc.cachedApiKeys().size).toBe(16);
        expect(main.rpc.cachedApiKeys().get('p01')).toBe(`${KEY}-again`);
      });
      expect(secretsEntries().filter((name) => name.startsWith('rpc-api-key.'))).toHaveLength(16);
      expect(fs.existsSync(keysPath)).toBe(false);
    });
  });

  describeIfCurrent('the reference, with the hello before this step, on the pinned core', () => {
    test('all four methods answer not_moved, the file is untouched, and the reference still writes', async () => {
      const reference = loadReference();
      expect(reference.manager.setApiKey('alchemy', KEY)).toEqual({ success: true });
      core = makeCore({ storeMoved: [] });
      await core.start();
      expect(core.hello.store_moved).toEqual([]);

      const before = digests([keysPath]);
      const requests = [
        ['secrets.rpc_api_keys', {}, 'shell'],
        ['secrets.rpc_api_key_status', {}, 'chrome'],
        ['secrets.set_rpc_api_key', { id: 'alchemy', api_key: `${KEY}-2` }, 'chrome'],
        ['secrets.remove_rpc_api_key', { id: 'alchemy' }, 'chrome'],
      ];
      for (const [method, params, caller] of requests) {
        const answer = await errorOf(core.request(method, params, { caller }));
        expect([method, answer.code, answer.data?.store]).toEqual([method, 'not_moved', 'rpc_api_keys']);
        expect(digests([keysPath])).toEqual(before);
      }
      const open = openFiles(core.current.child.pid);
      if (open) expect(open.filter((file) => KEY_FILE.test(file))).toEqual([]);

      // The reference's own writes still work, and read back.
      expect(reference.manager.setApiKey('infura', `${KEY}-i`)).toEqual({ success: true });
      expect(Object.keys(reference.store.readRpcApiKeys()).sort()).toEqual(['alchemy', 'infura']);
      expect(reference.manager.removeApiKey('alchemy')).toEqual({ success: true });
      expect(Object.keys(loadReference().store.readRpcApiKeys())).toEqual(['infura']);
    });
  });

  describeIfPrevious("this step's modules on the previous release (0.22.0)", () => {
    test('every RPC-key request fails requirement_unmet in main, and nothing writes the file', async () => {
      loadReference().store.writeRpcApiKeys({ alchemy: { apiKey: KEY, enabled: true, addedAt: 1 } });
      const before = digests([keysPath]);
      core = makeCore({ binary: previous });
      main = loadMain(core);
      await asMain(async () => {
        await core.start();
        expect(core.hello.store_moved).toEqual([]);
        await expect(main.rpc.refreshKeys()).rejects.toMatchObject({ code: 'requirement_unmet' });
        const asked = [
          () => main.vault.secrets.rpcApiKeys(),
          () => main.vault.secrets.rpcApiKeyStatus('chrome'),
          () => main.vault.secrets.setRpcApiKey({ id: 'alchemy', api_key: KEY }, 'chrome'),
          () => main.vault.secrets.removeRpcApiKey({ id: 'alchemy' }, 'chrome'),
        ];
        for (const ask of asked) {
          await expect(errorOf(ask())).resolves.toMatchObject({ code: 'requirement_unmet' });
        }
        expect(main.rpc.hasApiKey('alchemy')).toBe(false);
        expect(keyedUrls()).toEqual([]);
        expect(main.registry.getEndpoints(1, 'rpc').some((url) => url.includes(KEY))).toBe(false);
        await expect(config()).resolves.toEqual({ success: false, error: UNMET });
        await expect(main.ipcMain.invoke('networks:set-api-key', 'alchemy', KEY)).resolves.toEqual({
          success: false,
          error: UNMET,
        });
        await expect(main.ipcMain.invoke('networks:remove-api-key', 'alchemy')).resolves.toEqual({
          success: false,
          error: UNMET,
        });
        expect(JSON.stringify(main.errors)).not.toContain(KEY);
      });
      expect(digests([keysPath])).toEqual(before);
    });
  });
});
