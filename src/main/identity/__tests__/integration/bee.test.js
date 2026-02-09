/**
 * Integration test: Bee key injection
 *
 * Tests that a derived key can be injected into Bee and the node
 * starts with the expected address.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { deriveAllKeys } from '../../derivation.js';
import { getBeeAddress } from '../../formats.js';
import { injectBeeKey, createBeeConfig } from '../../injection.js';

// Test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Find Bee binary
function getBeeBinaryPath() {
  const arch = process.arch;
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'bee.exe' : 'bee';

  // Try project root first
  const projectRoot = path.resolve(__dirname, '../../../../..');
  const binPath = path.join(projectRoot, 'bee-bin', `${platform}-${arch}`, binName);

  if (fs.existsSync(binPath)) {
    return binPath;
  }

  return null;
}

// Wait for Bee API to be ready
function waitForBeeReady(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/health',
          method: 'GET',
          timeout: 2000,
        },
        (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else if (Date.now() - start < timeout) {
            setTimeout(check, 500);
          } else {
            reject(new Error(`Bee not ready after ${timeout}ms`));
          }
        }
      );

      req.on('error', () => {
        if (Date.now() - start < timeout) {
          setTimeout(check, 500);
        } else {
          reject(new Error(`Bee not ready after ${timeout}ms`));
        }
      });

      req.end();
    };

    check();
  });
}

// Get Bee addresses from API
function getBeeAddresses(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/addresses',
        method: 'GET',
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

describe('Bee Integration', () => {
  const beeBinary = getBeeBinaryPath();
  let tempDir;
  let beeProcess;
  const TEST_PORT = 11633; // Use non-standard port to avoid conflicts
  const TEST_PASSWORD = 'test-password-for-integration';

  // Skip all tests if Bee binary not found
  beforeAll(() => {
    if (!beeBinary) {
      console.log('Bee binary not found, skipping integration tests');
    }
  });

  beforeEach(() => {
    // Create temp directory for this test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-test-'));
  });

  afterEach(async () => {
    // Kill Bee process if running
    if (beeProcess && !beeProcess.killed) {
      beeProcess.kill('SIGTERM');
      // Wait for process to exit
      await new Promise((resolve) => {
        beeProcess.on('exit', resolve);
        setTimeout(resolve, 2000); // Force continue after 2s
      });
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const maybeTest = beeBinary ? test : test.skip;

  maybeTest(
    'starts with injected key and reports correct address',
    async () => {
      // 1. Derive keys
      const keys = deriveAllKeys(TEST_MNEMONIC);
      const expectedAddress = getBeeAddress(keys.beeWallet.privateKey);

      // 2. Create config and inject key
      createBeeConfig(tempDir, TEST_PASSWORD, TEST_PORT);
      await injectBeeKey(tempDir, keys.beeWallet.privateKey, TEST_PASSWORD);

      // Verify key file was created
      const keyPath = path.join(tempDir, 'keys', 'swarm.key');
      expect(fs.existsSync(keyPath)).toBe(true);

      // 3. Start Bee
      const configPath = path.join(tempDir, 'config.yaml');
      beeProcess = spawn(beeBinary, ['start', `--config=${configPath}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Log stderr for debugging
      beeProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('error') || msg.includes('Error')) {
          console.log('[Bee stderr]', msg);
        }
      });

      // 4. Wait for Bee to be ready
      await waitForBeeReady(TEST_PORT, 60000);

      // 5. Get addresses and verify
      const addresses = await getBeeAddresses(TEST_PORT);

      // Bee returns ethereum address in lowercase without 0x prefix in some endpoints,
      // but /addresses returns with 0x prefix
      expect(addresses.ethereum.toLowerCase()).toBe(expectedAddress.toLowerCase());

      console.log(`[Test] Expected: ${expectedAddress}`);
      console.log(`[Test] Got:      ${addresses.ethereum}`);
    },
    90000 // 90 second timeout for this test
  );

  maybeTest('key file format is valid JSON keystore', async () => {
    const keys = deriveAllKeys(TEST_MNEMONIC);

    await injectBeeKey(tempDir, keys.beeWallet.privateKey, TEST_PASSWORD);

    const keyPath = path.join(tempDir, 'keys', 'swarm.key');
    const keystore = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));

    expect(keystore.version).toBe(3);
    expect(keystore.Crypto).toBeDefined();
    expect(keystore.address).toBeDefined();
  });
});
