/**
 * K-5: rpc-api-keys.json holds the user's RPC provider API keys in plain
 * JSON. It is written owner-only and replaced atomically.
 *
 * A keyed provider's resolved RPC URL carries the user's API key (#1040).
 * Main resolves and uses it; no renderer is answered with it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createIpcMainMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
} = require('../../../test/helpers/main-process-test-utils');

const SHARED = path.join(__dirname, '..', '..', 'shared');
const readShared = (name) => JSON.parse(fs.readFileSync(path.join(SHARED, name), 'utf-8'));

// Built at runtime, so no key-shaped literal sits in the source.
const KEY = ['rpc', 'key', 'sentinel', process.pid.toString(36)].join('-');

const keyedProviderIds = Object.entries(readShared('endpoint-sources.json'))
  .filter(([, src]) => src.role === 'rpc' && src.keyed)
  .map(([id]) => id);
const chainIds = Object.keys(readShared('chains.json'));

const posixTest = process.platform === 'win32' ? test.skip : test;
const modeOf = (file) => fs.statSync(file).mode & 0o777;

describe('rpc-manager API key file (K-5)', () => {
  let userDataDir;
  let keysPath;
  let rpc;
  let onApiKeysChanged;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-keys-'));
    keysPath = path.join(userDataDir, 'rpc-api-keys.json');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    onApiKeysChanged = jest.fn();
    ({ mod: rpc } = loadMainModule(require.resolve('./rpc-manager'), {
      userDataDir,
      extraMocks: {
        [require.resolve('../networks/network-registry')]: () => ({
          getKeyedSources: jest.fn(() => ({ alchemy: { id: 'alchemy', coverage: {} } })),
        }),
        [require.resolve('./provider-manager')]: () => ({ onApiKeysChanged }),
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const tempFiles = () => fs.readdirSync(userDataDir).filter((name) => name.endsWith('.tmp'));

  posixTest('saves the keys owner-only', () => {
    expect(rpc.setApiKey('alchemy', 'secret-key')).toEqual({ success: true });
    expect(modeOf(keysPath)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(keysPath, 'utf8')).alchemy.apiKey).toBe('secret-key');
    expect(tempFiles()).toEqual([]);
  });

  posixTest('narrows a key file an older build left world-readable', () => {
    fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: 'old', enabled: true } }));
    fs.chmodSync(keysPath, 0o644);
    expect(rpc.hasApiKey('alchemy')).toBe(true);
    expect(modeOf(keysPath)).toBe(0o600);
  });

  test('a failed replace keeps the previous file', () => {
    expect(rpc.setApiKey('alchemy', 'first').success).toBe(true);
    const before = fs.readFileSync(keysPath, 'utf8');
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });

    expect(rpc.setApiKey('alchemy', 'second')).toEqual({
      success: false,
      error: 'Failed to save API key',
    });
    rename.mockRestore();
    expect(fs.readFileSync(keysPath, 'utf8')).toBe(before);
    expect(tempFiles()).toEqual([]);
  });
});

describe('the shared RPC key store (K-5 review)', () => {
  let userDataDir;
  let keysPath;
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-store-'));
    keysPath = path.join(userDataDir, 'rpc-api-keys.json');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  function loadRegistry() {
    // Other tests here doMock the registry; this one wants the real one.
    jest.dontMock(require.resolve('../networks/network-registry'));
    const { mod } = loadMainModule(require.resolve('../networks/network-registry'), {
      userDataDir,
    });
    return mod;
  }

  posixTest('the network registry, read first, repairs an older 0644 file', () => {
    fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: 'k', enabled: true } }));
    fs.chmodSync(keysPath, 0o644);

    loadRegistry().getEndpoints(1, 'rpc');
    expect(modeOf(keysPath)).toBe(0o600);
  });

  posixTest('the startup repair narrows it before any reader runs', () => {
    fs.writeFileSync(keysPath, '{}');
    fs.chmodSync(keysPath, 0o644);
    const { mod: store } = loadMainModule(require.resolve('./rpc-api-key-store'), { userDataDir });
    expect(store.repairRpcApiKeys()).toBe(true);
    expect(modeOf(keysPath)).toBe(0o600);
  });

  posixTest('neither reader follows a link planted at the key file', () => {
    const outside = path.join(userDataDir, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ alchemy: { apiKey: 'planted', enabled: true } }));
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, keysPath);

    const { mod: rpc } = loadMainModule(require.resolve('./rpc-manager'), {
      userDataDir,
      extraMocks: {
        [require.resolve('../networks/network-registry')]: () => ({
          getKeyedSources: jest.fn(() => ({ alchemy: { id: 'alchemy', coverage: {} } })),
        }),
        [require.resolve('./provider-manager')]: () => ({ onApiKeysChanged: jest.fn() }),
      },
    });
    expect(rpc.hasApiKey('alchemy')).toBe(false);
    loadRegistry().getEndpoints(1, 'rpc');
    const { mod: store } = loadMainModule(require.resolve('./rpc-api-key-store'), { userDataDir });
    expect(store.repairRpcApiKeys()).toBe(false);
    expect(modeOf(outside)).toBe(0o644);

    // Saving replaces the link with a real, owner-only file.
    expect(rpc.setApiKey('alchemy', 'mine')).toEqual({ success: true });
    expect(fs.lstatSync(keysPath).isSymbolicLink()).toBe(false);
    expect(modeOf(keysPath)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(outside, 'utf8')).alchemy.apiKey).toBe('planted');
  });
});

// Review #1029 R1-2: a key file that cannot be made owner-only is never
// read, by either reader, and the startup repair does not report it fixed.
describe('a key file whose fchmod fails (K-5)', () => {
  let userDataDir;
  let keysPath;
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-keys-fchmod-'));
    keysPath = path.join(userDataDir, 'rpc-api-keys.json');
    fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: 'old', enabled: true } }));
    fs.chmodSync(keysPath, 0o644);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  posixTest('is refused: no reader gets its keys, and repair reports it unrepaired', () => {
    const { mod: store } = loadMainModule(require.resolve('./rpc-api-key-store'), { userDataDir });
    jest.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), { code: 'EPERM' });
    });
    // The file's bytes are read through its descriptor, after the narrowing.
    const realRead = fs.readFileSync;
    const fdReads = [];
    jest.spyOn(fs, 'readFileSync').mockImplementation((target, ...rest) => {
      if (typeof target === 'number') fdReads.push(target);
      return realRead(target, ...rest);
    });

    expect(store.repairRpcApiKeys()).toBe(false);
    expect(() => store.readRpcApiKeys()).toThrow('could not make it owner-only');
    const { mod: rpc } = loadMainModule(require.resolve('./rpc-manager'), {
      userDataDir,
      extraMocks: {
        [require.resolve('../networks/network-registry')]: () => ({
          getKeyedSources: jest.fn(() => ({ alchemy: { id: 'alchemy', coverage: {} } })),
        }),
        [require.resolve('./provider-manager')]: () => ({ onApiKeysChanged: jest.fn() }),
      },
    });
    expect(rpc.hasApiKey('alchemy')).toBe(false);
    jest.dontMock(require.resolve('../networks/network-registry'));
    const { mod: registry } = loadMainModule(require.resolve('../networks/network-registry'), {
      userDataDir,
    });
    registry.getEndpoints(1, 'rpc');
    expect(fdReads).toEqual([]);
    expect(modeOf(keysPath)).toBe(0o644);
  });
});

describe('a FIFO at the key file name (K-5)', () => {
  let userDataDir;
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-keys-fifo-'));
  });
  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  posixTest('the startup repair and a read refuse it at once, never waiting for a writer', () => {
    const fifo = path.join(userDataDir, 'rpc-api-keys.json');
    require('child_process').execFileSync('mkfifo', [fifo]);
    // In a child, with electron's app stubbed: an open that waited for a
    // writer would hang this worker.
    const script = `
      const Module = require('module');
      const load = Module._load;
      Module._load = function (request, ...rest) {
        if (request === 'electron') return { app: { getPath: () => process.argv[1] } };
        return load.call(this, request, ...rest);
      };
      const store = require(${JSON.stringify(require.resolve('./rpc-api-key-store'))});
      const out = { repair: store.repairRpcApiKeys() };
      try { store.readRpcApiKeys(); out.read = 'read'; } catch (err) { out.read = err.message; }
      process.stdout.write(JSON.stringify(out));
    `;
    const result = require('child_process').spawnSync(
      process.execPath,
      ['-e', script, userDataDir],
      { encoding: 'utf8', timeout: 15000 }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      repair: false,
      read: expect.stringContaining('not a regular file'),
    });
  });
});

describe('RPC API keys stay in main (#1040)', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir('freedom-rpc-keys-');
    // Every keyed provider has a key, so each covered chain's pool has a
    // keyed URL in it.
    const keys = Object.fromEntries(
      keyedProviderIds.map((id) => [id, { apiKey: `${KEY}-${id}`, enabled: true, addedAt: 1 }])
    );
    fs.writeFileSync(path.join(userDataDir, 'rpc-api-keys.json'), JSON.stringify(keys));
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  function loadRpcManager() {
    const ipcMain = createIpcMainMock();
    const { mod } = loadMainModule(require.resolve('./rpc-manager'), { ipcMain, userDataDir });
    return { rpcManager: mod, ipcMain };
  }

  describe('rpc-manager keeps RPC API keys in main', () => {
    test('the fixture has keyed providers to check', () => {
      expect(keyedProviderIds.length).toBeGreaterThan(0);
      expect(chainIds).toContain('1');
    });

    test('main still resolves the keyed URLs for its own requests', () => {
      const { rpcManager } = loadRpcManager();
      for (const id of keyedProviderIds) {
        expect(rpcManager.getEffectiveRpcUrls(1).some((url) => url.includes(`${KEY}-${id}`))).toBe(
          true
        );
      }
    });

    test('offers no IPC registration: no channel answers with the RPC pool', () => {
      const { rpcManager, ipcMain } = loadRpcManager();
      for (const value of Object.values(rpcManager)) {
        if (typeof value === 'function' && /^register/.test(value.name)) value();
      }
      expect(Object.keys(rpcManager).filter((name) => /^register/.test(name))).toEqual([]);
      expect(ipcMain.handle).not.toHaveBeenCalled();
      expect(ipcMain.on).not.toHaveBeenCalled();
      expect(ipcMain.handlers.has('rpc:get-effective-urls')).toBe(false);
    });

    test('the keyless pool is the effective pool minus the keyed URLs, in its order', () => {
      const { rpcManager } = loadRpcManager();
      let keyedSeen = 0;
      for (const chainId of chainIds) {
        const effective = rpcManager.getEffectiveRpcUrls(chainId);
        const keyless = rpcManager.getKeylessRpcUrls(chainId);
        keyedSeen += effective.filter((url) => url.includes(KEY)).length;
        expect(keyless.filter((url) => url.includes(KEY))).toEqual([]);
        expect(keyless).toEqual(effective.filter((url) => !url.includes(KEY)));
      }
      expect(keyedSeen).toBeGreaterThan(0);
    });
  });

  describe('the settings page reads key presence, never a key', () => {
    test('every networks read answers without the key', async () => {
      const ipcMain = createIpcMainMock();
      const { mod } = loadMainModule(require.resolve('../networks/network-ipc'), {
        ipcMain,
        userDataDir,
        extraMocks: {
          [require.resolve('../networks/chain-catalog-host')]: () => ({
            searchChains: jest.fn(),
            getCatalogChain: jest.fn(),
          }),
          [require.resolve('../token-registry')]: () => ({}),
          [require.resolve('../settings-store')]: () => ({ loadSettings: () => ({}) }),
        },
      });
      mod.registerNetworkConfigIpc();

      const reads = [
        ['networks:get-config'],
        ['networks:get-chains'],
        ['networks:get-available-chains'],
        ...chainIds.flatMap((chainId) => [
          ['networks:get-chain', chainId],
          ['networks:is-chain-available', chainId],
        ]),
      ];
      for (const [channel, ...args] of reads) {
        const answer = await ipcMain.invoke(channel, ...args);
        expect(answer).toMatchObject({ success: true });
        expect(JSON.stringify(answer)).not.toContain(KEY);
      }

      const { sources } = await ipcMain.invoke('networks:get-config');
      for (const id of keyedProviderIds) {
        expect(sources.find((src) => src.id === id)).toMatchObject({ keyed: true, hasKey: true });
      }
    });
  });
});
