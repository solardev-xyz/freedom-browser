/**
 * Integration test: IPFS key injection
 *
 * Tests that a derived Ed25519 key can be injected into IPFS and the node
 * starts with the expected PeerID.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { deriveAllKeys, getSeed } from '../../derivation.js';
import { createIpfsIdentity } from '../../formats.js';
import { injectIpfsKey } from '../../injection.js';

// Test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Find IPFS binary
function getIpfsBinaryPath() {
  const arch = process.arch;
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';

  const projectRoot = path.resolve(__dirname, '../../../../..');
  const binPath = path.join(projectRoot, 'ipfs-bin', `${platform}-${arch}`, binName);

  if (fs.existsSync(binPath)) {
    return binPath;
  }

  return null;
}

// Wait for IPFS API to be ready
function waitForIpfsReady(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v0/id',
          method: 'POST',
          timeout: 2000,
        },
        (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else if (Date.now() - start < timeout) {
            setTimeout(check, 500);
          } else {
            reject(new Error(`IPFS not ready after ${timeout}ms`));
          }
        }
      );

      req.on('error', () => {
        if (Date.now() - start < timeout) {
          setTimeout(check, 500);
        } else {
          reject(new Error(`IPFS not ready after ${timeout}ms`));
        }
      });

      req.end();
    };

    check();
  });
}

// Get IPFS identity from API
function getIpfsId(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v0/id',
        method: 'POST',
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

describe('IPFS Integration', () => {
  const ipfsBinary = getIpfsBinaryPath();
  let tempDir;
  let ipfsProcess;
  const TEST_API_PORT = 15001;
  const TEST_GATEWAY_PORT = 18080;

  beforeAll(() => {
    if (!ipfsBinary) {
      console.log('IPFS binary not found, skipping integration tests');
    }
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-test-'));
  });

  afterEach(async () => {
    // Kill IPFS process if running
    if (ipfsProcess && !ipfsProcess.killed) {
      ipfsProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        ipfsProcess.on('exit', resolve);
        setTimeout(resolve, 3000);
      });
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const maybeTest = ipfsBinary ? test : test.skip;

  maybeTest(
    'starts with injected key and reports correct PeerID',
    async () => {
      // 1. Derive keys
      const keys = deriveAllKeys(TEST_MNEMONIC);
      const expectedIdentity = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);

      console.log(`[Test] Expected PeerID: ${expectedIdentity.peerId}`);

      // 2. Initialize IPFS repo (creates default identity which we'll overwrite)
      execSync(`"${ipfsBinary}" init`, {
        env: { ...process.env, IPFS_PATH: tempDir },
        stdio: 'pipe',
      });

      // 3. Inject our identity
      injectIpfsKey(tempDir, keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);

      // 4. Configure ports and disable bootstrap for faster startup
      const configPath = path.join(tempDir, 'config');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      config.Addresses.API = `/ip4/127.0.0.1/tcp/${TEST_API_PORT}`;
      config.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${TEST_GATEWAY_PORT}`;
      config.Addresses.Swarm = []; // Disable swarm for testing
      config.Bootstrap = []; // No bootstrap peers
      config.Routing = { Type: 'none' }; // Disable DHT
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // 5. Start IPFS daemon
      ipfsProcess = spawn(ipfsBinary, ['daemon', '--offline'], {
        env: { ...process.env, IPFS_PATH: tempDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Log stderr for debugging
      ipfsProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('error') || msg.includes('Error')) {
          console.log('[IPFS stderr]', msg);
        }
      });

      // 6. Wait for IPFS to be ready
      await waitForIpfsReady(TEST_API_PORT, 60000);

      // 7. Get identity and verify
      const identity = await getIpfsId(TEST_API_PORT);

      console.log(`[Test] Got PeerID:      ${identity.ID}`);

      expect(identity.ID).toBe(expectedIdentity.peerId);
    },
    90000
  );

  maybeTest('identity fields are correctly set in config', () => {
    const keys = deriveAllKeys(TEST_MNEMONIC);
    const expectedIdentity = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);

    // Initialize repo
    execSync(`"${ipfsBinary}" init`, {
      env: { ...process.env, IPFS_PATH: tempDir },
      stdio: 'pipe',
    });

    // Inject identity
    injectIpfsKey(tempDir, keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);

    // Read and verify config
    const configPath = path.join(tempDir, 'config');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(config.Identity.PeerID).toBe(expectedIdentity.peerId);
    expect(config.Identity.PrivKey).toBe(expectedIdentity.privKey);
  });

  maybeTest('protobuf structure is correct', () => {
    const keys = deriveAllKeys(TEST_MNEMONIC);
    const identity = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);

    // Decode and verify protobuf
    const decoded = Buffer.from(identity.privKey, 'base64');

    // Check protobuf header
    expect(decoded[0]).toBe(0x08); // field 1, wire type 0
    expect(decoded[1]).toBe(0x01); // value = 1 (Ed25519)
    expect(decoded[2]).toBe(0x12); // field 2, wire type 2
    expect(decoded[3]).toBe(0x40); // length = 64

    // Check key data
    const keyData = decoded.slice(4);
    expect(keyData.length).toBe(64);

    // First 32 bytes = private key
    expect(Buffer.from(keys.ipfsKey.privateKey).equals(keyData.slice(0, 32))).toBe(true);
    // Last 32 bytes = public key
    expect(Buffer.from(keys.ipfsKey.publicKey).equals(keyData.slice(32))).toBe(true);
  });
});
