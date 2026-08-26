// Fixtures for the remote (phone) signing E2E.
//
// Boots freedom in test-harness mode with a PRE-SEEDED vault (created
// with the real identity module — no onboarding wizard to drive), plus
// two local services the openlv flow needs:
//   - an in-test MQTT-over-WebSocket broker (the signaling relay; the
//     app is pointed at it via FREEDOM_OPENLV_SIGNALING so no public
//     relay is touched), and
//   - a static server for the bridge page (sibling freedom-bridge
//     checkout — see scripts/serve-bridge.js), which plays the
//     "any phone wallet" role in a plain Chromium context.
//
// The phone's wallet is faked per page: window.ethereum forwards to a
// Node-side ethers test key via exposeFunction, so every signature in
// the test is a real secp256k1 signature the app must verify.

const { test: base, expect, _electron: electron, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'src', 'main', 'identity'));
const { createBridgeServer } = require(path.join(repoRoot, 'scripts', 'serve-bridge.js'));
const { startLocalMqttBroker } = require(path.join(repoRoot, 'test', 'helpers', 'local-mqtt-broker.js'));

const VAULT_PASSWORD = 'Freedom-E2E-Remote-Signing-2026!';

const { WEBRTC_LOCAL_SWITCH } = require('../test/helpers/webrtc');

function startBridgeServer() {
  const server = createBridgeServer();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const test = base.extend({
  // Local signaling relay + bridge-page server.
  // eslint-disable-next-line no-empty-pattern
  services: async ({}, use) => {
    const [mqtt, bridgeServer] = await Promise.all([startLocalMqttBroker(), startBridgeServer()]);
    const bridgeOrigin = `http://127.0.0.1:${bridgeServer.address().port}`;

    await use({ mqttUrl: mqtt.url, bridgeOrigin });

    await Promise.all([
      mqtt.close(),
      new Promise((resolve) => bridgeServer.close(resolve)),
    ]);
  },

  electronApp: async ({ services }, use) => {
    // Deliberately /tmp, not os.tmpdir(): the radicle node's unix control
    // socket lives under the data dir, and macOS's deep per-user tmpdir
    // pushes the socket path past the OS length limit — which fails the
    // whole identity-status IPC and makes the app think there is no vault.
    const tmpRoot = fs.mkdtempSync('/tmp/f-rs-');
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

    // Real vault on disk → the app boots straight past onboarding. The
    // vault stays LOCKED for the whole test: phone accounts must work
    // without it.
    const mnemonic = await identity.createVault(identityDir, VAULT_PASSWORD);
    const keys = identity.deriveAllKeys(mnemonic);
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({
        addresses: { userWallet: keys.userWallet.address },
        activeWalletIndex: 0,
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

module.exports = { test, expect };
