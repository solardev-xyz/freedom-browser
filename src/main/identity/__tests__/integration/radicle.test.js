/**
 * Integration test: Radicle key injection
 *
 * Tests that a derived Ed25519 key can be injected into Radicle and
 * the identity is correctly recognized.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { deriveAllKeys } = require('../../derivation');
const { createRadicleIdentity } = require('../../formats');
const { injectRadicleKey } = require('../../injection');

// Test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function getRadicleAddonPath() {
  const arch = process.arch;
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const projectRoot = path.resolve(__dirname, '../../../../..');
  const addonPath = path.join(
    projectRoot,
    'radicle-bin',
    `${platform}-${arch}`,
    'libradicle.node'
  );

  return fs.existsSync(addonPath) ? addonPath : null;
}

describe('Radicle Integration', () => {
  const addonPath = getRadicleAddonPath();
  const addon = addonPath ? require(addonPath) : null;
  let tempDir;
  let addonStarted = false;

  const callAddon = async (name, ...args) => {
    const value = JSON.parse(await addon[name](...args));
    if (value.error) throw new Error(value.error);
    return value;
  };

  const startAddon = async (alias) => {
    const result = await callAddon('start', tempDir, alias);
    addonStarted = true;
    return result;
  };

  beforeAll(() => {
    if (!addon) {
      console.log('libradicle addon not found, skipping native integration tests');
    }
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-test-'));
  });

  afterEach(async () => {
    if (addonStarted) {
      await callAddon('shutdown');
      addonStarted = false;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const maybeNativeTest = addon ? test : test.skip;

  maybeNativeTest('native addon reports the injected DID', async () => {
    // 1. Derive keys
    const keys = deriveAllKeys(TEST_MNEMONIC);
    const expectedIdentity = createRadicleIdentity(
      keys.radicleKey.privateKey,
      keys.radicleKey.publicKey,
      'TestNode'
    );

    console.log(`[Test] Expected DID: ${expectedIdentity.did}`);

    // 2. Inject identity
    injectRadicleKey(tempDir, keys.radicleKey.privateKey, keys.radicleKey.publicKey, 'TestNode');

    // Verify files were created
    expect(fs.existsSync(path.join(tempDir, 'keys', 'radicle'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'keys', 'radicle.pub'))).toBe(true);

    const started = await startAddon('TestNode');
    const identity = await callAddon('identity');

    expect(started.did).toBe(expectedIdentity.did);
    expect(identity.did).toBe(expectedIdentity.did);
    expect(identity.alias).toBe('TestNode');
  });

  test('nodeId matches the DID suffix', () => {
    const keys = deriveAllKeys(TEST_MNEMONIC);
    const expectedIdentity = createRadicleIdentity(
      keys.radicleKey.privateKey,
      keys.radicleKey.publicKey,
      'TestNode'
    );

    // Verify that nodeId is correctly derived from DID
    // DID format: did:key:z6Mk...
    // nodeId format: z6Mk... (same without "did:key:" prefix)
    expect(expectedIdentity.did).toBe('did:key:' + expectedIdentity.nodeId);
    expect(expectedIdentity.nodeId.startsWith('z6Mk')).toBe(true);
  });

  test('key files have correct format', () => {
    const keys = deriveAllKeys(TEST_MNEMONIC);

    injectRadicleKey(tempDir, keys.radicleKey.privateKey, keys.radicleKey.publicKey, 'TestNode');

    // Check private key format
    const privateKey = fs.readFileSync(path.join(tempDir, 'keys', 'radicle'), 'utf-8');
    expect(privateKey).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(privateKey).toContain('-----END OPENSSH PRIVATE KEY-----');

    // Check public key format
    const publicKey = fs.readFileSync(path.join(tempDir, 'keys', 'radicle.pub'), 'utf-8');
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ TestNode\n$/);

    // Check config file
    const config = JSON.parse(fs.readFileSync(path.join(tempDir, 'config.json'), 'utf-8'));
    expect(config.node.alias).toBe('TestNode');
  });

  test('private key has correct permissions', () => {
    const keys = deriveAllKeys(TEST_MNEMONIC);

    injectRadicleKey(tempDir, keys.radicleKey.privateKey, keys.radicleKey.publicKey, 'TestNode');

    const stats = fs.statSync(path.join(tempDir, 'keys', 'radicle'));
    // Check that only owner has read/write (0o600 = 384 in decimal)
    // Note: On Windows, file permissions work differently
    if (process.platform !== 'win32') {
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test('custom alias is written to the native profile', () => {
    const keys = deriveAllKeys(TEST_MNEMONIC);

    injectRadicleKey(tempDir, keys.radicleKey.privateKey, keys.radicleKey.publicKey, 'MyCustomAlias');

    const config = JSON.parse(fs.readFileSync(path.join(tempDir, 'config.json'), 'utf-8'));

    expect(config.node.alias).toBe('MyCustomAlias');
  });
});
