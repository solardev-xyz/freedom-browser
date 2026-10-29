/**
 * K-3: the Ant keystore password is sealed in the OS keychain (safeStorage)
 * instead of sitting in config.yaml beside keys/swarm.key, and reaches antd
 * only as a short-lived --password-file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');

const posixTest = process.platform === 'win32' ? test.skip : test;
const modeOf = (target) => fs.statSync(target).mode & 0o777;

// safeStorage's async API with a keyring behind it (`v11` ciphertexts, as
// Linux's keyring-keyed ones), whose ciphertext is not the plaintext.
// `prefix: 'v10'` is Chromium's fixed fallback key.
function fakeSafeStorage({ backend = 'gnome_libsecret', available = true, prefix = 'v11' } = {}) {
  return {
    isAsyncEncryptionAvailable: jest.fn(async () => available),
    getSelectedStorageBackend: jest.fn(() => backend),
    encryptStringAsync: jest.fn(async (text) =>
      Buffer.from(`${prefix}${Buffer.from(text).toString('hex')}`)
    ),
    decryptStringAsync: jest.fn(async (buffer) => {
      const text = buffer.toString();
      if (!/^v1[01][0-9a-f]+$/.test(text)) throw new Error('Error while decrypting the ciphertext');
      return { result: Buffer.from(text.slice(3), 'hex').toString(), shouldReEncrypt: false };
    }),
  };
}

function loadWith(safeStorage, userDataDir = os.tmpdir()) {
  const { mod } = loadMainModule(require.resolve('./ant-keystore-password'), {
    userDataDir,
    electronOverrides: { safeStorage },
  });
  return mod;
}

describe('ant keystore password (K-3)', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-keystore-'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('seals with a keychain-backed safeStorage and opens it again', async () => {
    const keystore = loadWith(fakeSafeStorage());
    expect(await keystore.sealPassword(dataDir, 'pw-123')).toBe(true);

    const file = keystore.sealedPasswordPath(dataDir);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('pw-123');
    if (process.platform !== 'win32') expect(modeOf(file)).toBe(0o600);
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-123');
  });

  test('does not seal where safeStorage has no keyring, or none at all', async () => {
    const keyringless = [fakeSafeStorage({ available: false }), undefined];
    if (process.platform === 'linux') {
      // basic_text, and gnome_libsecret with no Secret Service (fixed key).
      keyringless.push(fakeSafeStorage({ backend: 'basic_text' }));
      keyringless.push(fakeSafeStorage({ prefix: 'v10' }));
    }
    for (const storage of keyringless) {
      const keystore = loadWith(storage);
      expect(await keystore.sealPassword(dataDir, 'pw')).toBe(false);
      expect(keystore.hasSealedPassword(dataDir)).toBe(false);
      expect(await keystore.unsealPassword(dataDir)).toBeNull();
    }
  });

  test('a sealed password that will not open is the re-inject error', async () => {
    const keystore = loadWith(fakeSafeStorage());
    fs.mkdirSync(path.join(dataDir, 'keys'));
    fs.writeFileSync(keystore.sealedPasswordPath(dataDir), Buffer.from('other-key').toString('base64'));
    await expect(keystore.unsealPassword(dataDir)).rejects.toThrow(
      keystore.KeystorePasswordUnavailableError
    );
    await expect(keystore.unsealPassword(dataDir)).rejects.toThrow(
      'Swarm key needs re-injecting: unlock your vault'
    );

    // The keychain went away.
    const keyringless = loadWith(fakeSafeStorage({ available: false }));
    await expect(keyringless.unsealPassword(dataDir)).rejects.toThrow(keystore.REINJECT_MESSAGE);
  });

  test('a keychain key rotation stores the password under the new key', async () => {
    const storage = fakeSafeStorage();
    const keystore = loadWith(storage);
    await keystore.sealPassword(dataDir, 'pw-789');
    storage.decryptStringAsync.mockResolvedValueOnce({ result: 'pw-789', shouldReEncrypt: true });
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-789');
    expect(storage.encryptStringAsync).toHaveBeenCalledTimes(2);
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-789');
  });

  posixTest('the --password-file is private and removed for good', () => {
    const keystore = loadWith(fakeSafeStorage());
    const file = keystore.writePasswordFile('pw-456');
    expect(fs.readFileSync(file.path, 'utf8')).toBe('pw-456');
    expect(modeOf(file.path)).toBe(0o600);
    expect(modeOf(path.dirname(file.path))).toBe(0o700);

    file.remove();
    expect(fs.existsSync(path.dirname(file.path))).toBe(false);
    expect(() => file.remove()).not.toThrow();
  });
});

describe('Ant config.yaml and the sealed password (K-3)', () => {
  let userDataDir;
  let dataDir;
  let configPath;
  let swarmKeyPath;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-config-'));
    dataDir = path.join(userDataDir, 'ant-data');
    configPath = path.join(dataDir, 'config.yaml');
    swarmKeyPath = path.join(dataDir, 'keys', 'swarm.key');
    fs.mkdirSync(path.join(dataDir, 'keys'), { recursive: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  function loadAntManager(safeStorage) {
    const { mod } = loadMainModule(require.resolve('../ant-manager'), {
      userDataDir,
      electronOverrides: { safeStorage },
      extraMocks: {
        [require.resolve('../logger')]: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
        [require.resolve('../settings-store')]: () => ({
          loadSettings: jest.fn(() => ({})),
          saveSettings: jest.fn(() => true),
        }),
        [require.resolve('../networks/network-registry')]: () => ({
          getEndpoints: jest.fn(() => ['https://ethereum.example']),
          getEndpointSources: jest.fn(() => []),
        }),
      },
    });
    return {
      ant: mod,
      keystore: require('./ant-keystore-password'),
    };
  }

  const configText = () => fs.readFileSync(configPath, 'utf8');

  test('a fresh node keeps its password sealed, out of config.yaml', async () => {
    const { ant, keystore } = loadAntManager(fakeSafeStorage());
    const { configPath: written, sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(written).toBe(configPath);
    expect(sealedPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(configText()).not.toMatch(/^password:/m);
    expect(await keystore.unsealPassword(dataDir)).toBe(sealedPassword);
  });

  test('without a keyring the password stays in the owner-only config.yaml', async () => {
    const { ant, keystore } = loadAntManager(fakeSafeStorage({ available: false }));
    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toBeNull();
    expect(configText()).toMatch(/^password: [0-9a-f]{64}$/m);
    expect(keystore.hasSealedPassword(dataDir)).toBe(false);
  });

  test("an older build's password moves out of config.yaml on first start", async () => {
    fs.writeFileSync(swarmKeyPath, '{}');
    fs.writeFileSync(configPath, 'api-addr: 127.0.0.1:1633\npassword: legacy-password\n');
    const { ant, keystore } = loadAntManager(fakeSafeStorage());

    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toBe('legacy-password');
    expect(configText()).not.toContain('legacy-password');
    expect(await keystore.unsealPassword(dataDir)).toBe('legacy-password');

    // And it stays sealed on later starts.
    expect((await ant.ensureConfig(dataDir, 1633, 1634)).sealedPassword).toBe('legacy-password');
    expect(configText()).not.toMatch(/^password:/m);
  });

  test('a keystore whose sealed password will not open is never given a new one', async () => {
    fs.writeFileSync(swarmKeyPath, '{}');
    const storage = fakeSafeStorage();
    const { ant, keystore } = loadAntManager(storage);
    expect(await keystore.sealPassword(dataDir, 'original')).toBe(true);
    fs.writeFileSync(configPath, 'api-addr: 127.0.0.1:1633\n');
    storage.decryptStringAsync.mockRejectedValue(new Error('Error while decrypting the ciphertext'));

    await expect(ant.ensureConfig(dataDir, 1633, 1634)).rejects.toThrow(keystore.REINJECT_MESSAGE);
    expect(configText()).toBe('api-addr: 127.0.0.1:1633\n');
    expect(keystore.hasSealedPassword(dataDir)).toBe(true);
  });

  test('without a keystore, a sealed password that will not open is replaced', async () => {
    const storage = fakeSafeStorage();
    const { ant, keystore } = loadAntManager(storage);
    fs.writeFileSync(keystore.sealedPasswordPath(dataDir), 'bm90LXNlYWxlZA==');

    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(await keystore.unsealPassword(dataDir)).toBe(sealedPassword);
  });
});
