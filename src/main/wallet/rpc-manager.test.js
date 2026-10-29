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
