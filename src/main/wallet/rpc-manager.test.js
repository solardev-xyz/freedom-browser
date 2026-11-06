/**
 * K-5: rpc-api-keys.json holds the user's RPC provider API keys in plain
 * JSON. It is written owner-only and replaced atomically.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');

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
