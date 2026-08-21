/**
 * Integration test: bee-data → ant-data migration against a real antd node.
 *
 * The unit tests in src/main/migrate-user-data.test.js prove the file
 * mechanics; this proves the semantic contract that actually protects
 * upgrading users' funds: antd must decrypt the migrated bee-era keystore
 * (keys/swarm.key) with the password carried over in config.yaml and adopt
 * that identity — instead of self-generating a throwaway one with a different
 * overlay address.
 *
 * Builds a genuine bee-era data dir with the real injection writers
 * (injectBeeKey + createBeeConfig), runs migrateBeeDataToAntData(), then
 * spawns the bundled antd on the result and asserts the node reports the
 * wallet address derived from the injected key.
 *
 * Skipped when the antd binary is absent (run `npm run ant:download`).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { deriveAllKeys } = require('../../derivation');
const { getBeeAddress } = require('../../formats');
const { injectBeeKey, createBeeConfig } = require('../../injection');
const {
  createAppMock,
  loadMainModule,
} = require('../../../../../test/helpers/main-process-test-utils');

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'bee-era-keystore-password';

// OS-assigned free ports instead of fixed "non-standard" ones: the readiness
// probe polls /health on 127.0.0.1, so ANY process already on the chosen port
// makes the test assert against the wrong node. (The installed Freedom app's
// port-fallback once landed its node exactly on the previously hardcoded
// 11633 — instant false "ready", baffling failures.)
function getFreePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function getAntBinaryPath() {
  const arch = process.arch;
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'antd.exe' : 'antd';

  const projectRoot = path.resolve(__dirname, '../../../../..');
  const binPath = path.join(projectRoot, 'ant-bin', `${platform}-${arch}`, binName);

  return fs.existsSync(binPath) ? binPath : null;
}

function waitForAntReady(port, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 },
        (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else if (Date.now() - start < timeout) {
            setTimeout(check, 500);
          } else {
            reject(new Error(`antd not ready after ${timeout}ms`));
          }
        }
      );

      req.on('error', () => {
        if (Date.now() - start < timeout) {
          setTimeout(check, 500);
        } else {
          reject(new Error(`antd not ready after ${timeout}ms`));
        }
      });

      req.end();
    };

    check();
  });
}

function getAntAddresses(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/addresses', method: 'GET', timeout: 5000 },
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

// Ultra-light config shape matching ant-manager's buildAntConfigContent.
function writeUltraLightConfig(antDataDir, apiPort, p2pPort, password) {
  const configPath = path.join(antDataDir, 'config.yaml');
  const content = `# Ant node configuration (bee-compatible keys)
api-addr: 127.0.0.1:${apiPort}
p2p-addr: :${p2pPort}
swap-enable: false
mainnet: true
full-node: false
blockchain-rpc-endpoint: ""
cors-allowed-origins: "null"
skip-postage-snapshot: true
resolver-options: "https://ethereum.publicnode.com"
storage-incentives-enable: false
data-dir: ${antDataDir}
password: ${password}
`;
  fs.writeFileSync(configPath, content);
  return configPath;
}

// Mirrors ant-manager's ensureConfig, which rewrites config.yaml on every
// start: only the password is carried over from the existing (migrated)
// config; data-dir and api-addr are re-derived.
function rewriteConfigLikeEnsureConfig(antDataDir, apiPort, p2pPort) {
  const existing = fs.readFileSync(path.join(antDataDir, 'config.yaml'), 'utf-8');
  const passwordMatch = existing.match(/^password:\s*(.+)$/m);
  if (!passwordMatch) {
    throw new Error('No password found in migrated config.yaml');
  }
  const password = passwordMatch[1].trim();
  const configPath = writeUltraLightConfig(antDataDir, apiPort, p2pPort, password);
  return { configPath, password };
}

describe('bee-data → ant-data migration (real antd)', () => {
  const antBinary = getAntBinaryPath();
  let userDataDir;
  let antProcess;
  let apiPort;
  let p2pPort;

  beforeAll(() => {
    if (!antBinary) {
      console.log('antd binary not found, skipping integration tests');
    }
  });

  beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-migration-test-'));
    delete process.env.FREEDOM_ANT_DATA;
    apiPort = await getFreePort();
    p2pPort = await getFreePort();
  });

  afterEach(async () => {
    if (antProcess && !antProcess.killed) {
      antProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        timer.unref?.();
        antProcess.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      antProcess = null;
    }

    if (userDataDir && fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  function loadMigrationModule() {
    return loadMainModule(require.resolve('../../../migrate-user-data'), {
      app: createAppMock({ isPackaged: true, userDataDir }),
      extraMocks: {
        [require.resolve('../../../logger')]: () => ({
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        }),
      },
    }).mod;
  }

  const maybeTest = antBinary ? test : test.skip;

  maybeTest(
    'antd adopts the migrated bee-era identity instead of self-generating one',
    async () => {
      // 1. Derive the identity a bee-era install would have injected.
      const keys = deriveAllKeys(TEST_MNEMONIC);
      const expectedAddress = getBeeAddress(keys.beeWallet.privateKey);

      // 2. Build a genuine bee-era data dir with the real injection writers,
      //    plus a statestore/ to stand in for Bee's LevelDB cache.
      const beeDataDir = path.join(userDataDir, 'bee-data');
      createBeeConfig(beeDataDir, TEST_PASSWORD, 1633, 1634);
      await injectBeeKey(beeDataDir, keys.beeWallet.privateKey, TEST_PASSWORD);
      fs.mkdirSync(path.join(beeDataDir, 'statestore'), { recursive: true });
      fs.writeFileSync(path.join(beeDataDir, 'statestore', 'LOCK'), '');

      // 3. Run the migration exactly as bootstrap() does.
      const mod = loadMigrationModule();
      expect(mod.migrateBeeDataToAntData()).toBe(true);

      const antDataDir = path.join(userDataDir, 'ant-data');
      expect(fs.existsSync(path.join(antDataDir, 'keys', 'swarm.key'))).toBe(true);
      expect(fs.existsSync(path.join(antDataDir, 'statestore'))).toBe(false);
      expect(fs.existsSync(beeDataDir)).toBe(false);

      // 4. Rewrite the config the way ant-manager's ensureConfig does on
      //    every start — the password must have survived the migration.
      const { configPath, password } = rewriteConfigLikeEnsureConfig(
        antDataDir,
        apiPort,
        p2pPort
      );
      expect(password).toBe(TEST_PASSWORD);

      // 5. Start antd on the migrated directory (flag-only, no subcommand).
      antProcess = spawn(antBinary, [`--config=${configPath}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      antProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (/error/i.test(msg)) {
          console.log('[antd stderr]', msg);
        }
      });

      await waitForAntReady(apiPort, 60000);

      // 6. The node must report the injected wallet, not a self-generated one.
      const addresses = await getAntAddresses(apiPort);
      console.log(`[Test] Expected: ${expectedAddress}`);
      console.log(`[Test] Got:      ${addresses.ethereum}`);
      expect(addresses.ethereum.toLowerCase()).toBe(expectedAddress.toLowerCase());

      // antd loaded the keystore, so it must not have minted a native identity.
      expect(fs.existsSync(path.join(antDataDir, 'identity.json'))).toBe(false);
    },
    120000
  );

  maybeTest(
    'a fresh antd start with no injected key never creates keys/swarm.key',
    async () => {
      // Guards the invariant isBeeDataMigrationPending() keys off (see
      // migrate-user-data.js): antd's self-generated identity must live in
      // identity.json/signing.key — keys/swarm.key only ever appears via
      // Freedom's injection or the bee-data migration. If a future antd
      // version wrote keys/swarm.key on self-init, the migration precondition
      // would turn false on the first post-upgrade start and a funded
      // bee-era identity would be silently abandoned with no retry.
      const antDataDir = path.join(userDataDir, 'ant-data');
      fs.mkdirSync(antDataDir, { recursive: true });
      const configPath = writeUltraLightConfig(
        antDataDir,
        apiPort,
        p2pPort,
        'fresh-start-password'
      );

      antProcess = spawn(antBinary, [`--config=${configPath}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitForAntReady(apiPort, 60000);

      expect(fs.existsSync(path.join(antDataDir, 'keys', 'swarm.key'))).toBe(false);
      // The self-generated identity must take antd's native shape instead.
      expect(fs.existsSync(path.join(antDataDir, 'identity.json'))).toBe(true);
    },
    120000
  );
});
