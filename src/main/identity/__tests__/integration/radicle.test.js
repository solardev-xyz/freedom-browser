/**
 * Integration test: Radicle key injection
 *
 * Tests that a derived Ed25519 key can be injected into Radicle and
 * the identity is correctly recognized.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { deriveAllKeys } from '../../derivation.js';
import { createRadicleIdentity } from '../../formats.js';
import { injectRadicleKey } from '../../injection.js';

// Test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Find Radicle binary
function getRadicleBinaryPath(binary = 'rad') {
  const arch = process.arch;
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? `${binary}.exe` : binary;

  const projectRoot = path.resolve(__dirname, '../../../../..');
  const binPath = path.join(projectRoot, 'radicle-bin', `${platform}-${arch}`, binName);

  if (fs.existsSync(binPath)) {
    return binPath;
  }

  return null;
}

describe('Radicle Integration', () => {
  const radBinary = getRadicleBinaryPath('rad');
  let tempDir;

  beforeAll(() => {
    if (!radBinary) {
      console.log('Radicle binary not found, skipping integration tests');
    }
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const maybeTest = radBinary ? test : test.skip;

  maybeTest('rad self reports correct DID after key injection', () => {
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

    // 3. Run rad self to verify identity
    const output = execSync(`"${radBinary}" self`, {
      env: {
        ...process.env,
        RAD_HOME: tempDir,
        RAD_PASSPHRASE: '', // Key is unencrypted
      },
      encoding: 'utf-8',
    });

    console.log(`[Test] rad self output:\n${output}`);

    // Extract DID from output (format: "DID did:key:z6Mk...")
    const didMatch = output.match(/DID\s+(did:key:z[A-Za-z0-9]+)/);
    expect(didMatch).not.toBeNull();

    const actualDid = didMatch[1];
    console.log(`[Test] Got DID: ${actualDid}`);

    expect(actualDid).toBe(expectedIdentity.did);
  });

  maybeTest('nodeId matches the DID suffix', () => {
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

  maybeTest('key files have correct format', () => {
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

  maybeTest('private key has correct permissions', () => {
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

  maybeTest('alias is correctly set', () => {
    const keys = deriveAllKeys(TEST_MNEMONIC);

    injectRadicleKey(tempDir, keys.radicleKey.privateKey, keys.radicleKey.publicKey, 'MyCustomAlias');

    const output = execSync(`"${radBinary}" self`, {
      env: {
        ...process.env,
        RAD_HOME: tempDir,
        RAD_PASSPHRASE: '',
      },
      encoding: 'utf-8',
    });

    expect(output).toContain('MyCustomAlias');
  });
});
