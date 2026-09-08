// Fixtures for the Safe + phone-owner E2E: the anvil Gnosis fork and
// pre-seeded vault from the Safe E2E, plus the openlv services from the
// remote-signing E2E (local MQTT relay + bridge-page server), so a
// phone owner can co-sign a SafeTx through the real stack.
//
// The vault carries THREE owner records: the mnemonic account, a phone
// (remote) account whose key the fake phone page holds, and a second
// phone account that is never reachable — so a 2-of-3 Safe genuinely
// needs the phone signature after the vault's free one.

const { test: base, expect, _electron: electron, chromium } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Wallet } = require('ethers');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'src', 'main', 'identity'));
const { createBridgeServer } = require(path.join(repoRoot, 'scripts', 'serve-bridge.js'));
const { startLocalMqttBroker } = require(path.join(repoRoot, 'test', 'helpers', 'local-mqtt-broker.js'));
const { WEBRTC_LOCAL_SWITCH } = require('../test/helpers/webrtc');

const VAULT_PASSWORD = 'Freedom-E2E-Safe-Phone-2026!';
const GNOSIS_FORK_URL = 'https://rpc.gnosischain.com';
const ANVIL_PORT = 18848; // distinct from the other suites
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Anvil/Hardhat-default test key — well-known, never funded on mainnet.
// The fake phone page signs with it; the seeded remote record carries
// its address.
const PHONE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const phoneWallet = new Wallet(PHONE_KEY);
// Second remote owner that is never reachable in the test.
const DEAD_PHONE_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const BUILTIN_GNOSIS_SOURCES = ['gno-gnosischain', 'gno-ankr', 'gno-publicnode', 'gno-drpc-public'];

function safePhoneE2eAvailable() {
  if (spawnSync('anvil', ['--version']).status !== 0) return false;
  const probe = spawnSync('curl', [
    '-sf', '-m', '10', '-X', 'POST', GNOSIS_FORK_URL,
    '-H', 'Content-Type: application/json',
    '-d', '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
  ]);
  return probe.status === 0;
}

async function rpc(method, params = []) {
  const res = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(`${method}: ${error.message}`);
  return result;
}

async function startAnvilFork() {
  const proc = spawn('anvil', [
    '--fork-url', GNOSIS_FORK_URL,
    '--port', String(ANVIL_PORT),
    '--block-time', '2',
    '--silent',
  ]);
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    try {
      const chainId = await rpc('eth_chainId');
      if (parseInt(chainId, 16) === 100) return proc;
      throw new Error(`unexpected chain id ${chainId}`);
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`anvil fork not ready: ${err.message}`, { cause: err });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  anvil: async ({}, use) => {
    const proc = await startAnvilFork();
    await use({ url: ANVIL_URL, rpc });
    proc.kill();
  },

  // Local openlv services: signaling relay + bridge page.
  // eslint-disable-next-line no-empty-pattern
  services: async ({}, use) => {
    const [mqtt, bridgeServer] = await Promise.all([
      startLocalMqttBroker(),
      new Promise((resolve) => {
        const server = createBridgeServer();
        server.listen(0, '127.0.0.1', () => resolve(server));
      }),
    ]);
    const bridgeOrigin = `http://127.0.0.1:${bridgeServer.address().port}`;
    await use({ mqttUrl: mqtt.url, bridgeOrigin });
    await Promise.all([mqtt.close(), new Promise((resolve) => bridgeServer.close(resolve))]);
  },

  electronApp: async ({ anvil, services }, use) => {
    const tmpRoot = fs.mkdtempSync('/tmp/f-sp-');
    const userDataDir = path.join(tmpRoot, 'userData');
    const identityDir = path.join(tmpRoot, 'identity');
    const radicleDir = path.join(tmpRoot, 'rad');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    fs.mkdirSync(radicleDir, { recursive: true });

    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        enableIdentityWallet: true,
        startAntAtLaunch: false,
        startIpfsAtLaunch: false,
        startRadicleAtLaunch: false,
        enableRadicleIntegration: false,
      }),
      'utf-8'
    );

    fs.writeFileSync(
      path.join(userDataDir, 'network-config.json'),
      JSON.stringify({
        endpointSources: {
          'e2e-anvil-gnosis': { role: 'rpc', keyed: false, coverage: { 100: anvil.url } },
        },
        removedSources: BUILTIN_GNOSIS_SOURCES,
      }),
      'utf-8'
    );

    const mnemonic = await identity.createVault(identityDir, VAULT_PASSWORD);
    const keys = identity.deriveAllKeys(mnemonic);
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({
        addresses: { userWallet: keys.userWallet.address },
        activeWalletIndex: 0,
        derivedWallets: [
          { index: 0, name: 'Main Wallet', address: keys.userWallet.address },
          { index: 1, name: 'E2E Phone', address: phoneWallet.address, type: 'remote' },
          { index: 2, name: 'Dead Phone', address: DEAD_PHONE_ADDRESS, type: 'remote' },
        ],
      }),
      'utf-8'
    );

    const app = await electron.launch({
      args: ['.', WEBRTC_LOCAL_SWITCH],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        FREEDOM_IDENTITY_DATA: identityDir,
        FREEDOM_RADICLE_DATA: radicleDir,
        FREEDOM_OPENLV_SIGNALING: services.mqttUrl,
        FREEDOM_TEST_HIDE_WINDOW: process.env.FREEDOM_E2E_HEADED === '1' ? '0' : '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });

    await use(app);

    try {
      await app.close();
    } catch {
      // window already gone
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },

  // The "phone": a plain Chromium context for the bridge page.
  // eslint-disable-next-line no-empty-pattern
  phoneBrowser: async ({}, use) => {
    const browser = await chromium.launch({ args: [WEBRTC_LOCAL_SWITCH] });
    await use(browser);
    await browser.close();
  },
});

module.exports = { test, expect, safePhoneE2eAvailable, VAULT_PASSWORD, PHONE_KEY, phoneWallet };
