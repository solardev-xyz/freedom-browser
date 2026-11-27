// Fixtures for the Safe (multi-owner account) E2E.
//
// Boots freedom in test-harness mode with a PRE-SEEDED vault holding two
// mnemonic accounts (a Safe needs two owners), and points EVERY Gnosis
// RPC the app resolves at a local anvil fork of the real chain: the
// registry's user-layer network-config.json adds the anvil endpoint and
// removes the builtin public ones, so the whole app — status quotes,
// deployment, execTransaction, balance display — runs against the fork.
//
// Needs `anvil` (foundry) on PATH and network access to the public fork
// RPCs; the spec skips cleanly otherwise, unless FREEDOM_SAFE_E2E_REQUIRED=1
// (CI's e2e-safe job). anvil fetches through a failover proxy over several
// providers (gnosis-fork.js says why, #536).

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'src', 'main', 'identity'));
const { closeApp } = require('./close-app');
const { startRpcForwarder } = require('./rpc-forwarder');
const {
  attachForkLogOnFailure,
  gnosisForkUnavailableReason,
  startGnosisFork,
} = require('./gnosis-fork');

const VAULT_PASSWORD = 'Freedom-E2E-Safe-2026!';
const ANVIL_PORT = 18847; // distinct from the jest fork tests (18845/6)
// The fork's second endpoint, a forwarder (rpc-forwarder.js).
const FORWARDER_PORT = 18849;

// Builtin keyless Gnosis rpc sources to remove so nothing escapes to the
// live chain (keyed sources resolve to nothing without API keys).
const BUILTIN_GNOSIS_SOURCES = ['gno-gnosischain', 'gno-publicnode', 'gno-drpc-public'];

/**
 * anvil present + a fork RPC reachable (gnosis-fork.js).
 *
 * With FREEDOM_SAFE_E2E_REQUIRED=1 (the `e2e-safe` CI job) a missing
 * prerequisite throws instead of skipping: a skipped spec reports green, so a
 * broken foundry install or unreachable fork RPCs would otherwise turn the
 * job into a silent no-op.
 */
function safeE2eAvailable() {
  const missing = gnosisForkUnavailableReason();
  if (missing && process.env.FREEDOM_SAFE_E2E_REQUIRED === '1') {
    throw new Error(`Safe E2E required but ${missing}`);
  }
  return !missing;
}

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  anvil: async ({}, use, testInfo) => {
    const logPath = testInfo.outputPath('anvil-fork.log');
    const fork = await startGnosisFork({ port: ANVIL_PORT, logPath });
    const forwarder = await startRpcForwarder(fork.url, FORWARDER_PORT);
    await use({ url: fork.url, forwarderUrl: forwarder.url, rpc: fork.rpc });
    await forwarder.close();
    await fork.stop();
    await attachForkLogOnFailure(testInfo, logPath);
  },

  electronApp: async ({ anvil }, use) => {
    // /tmp, not os.tmpdir() — see remote-signing-fixtures for why.
    const tmpRoot = fs.mkdtempSync('/tmp/f-safe-');
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

    // Every Gnosis RPC the app resolves goes to the anvil fork.
    fs.writeFileSync(
      path.join(userDataDir, 'network-config.json'),
      JSON.stringify({
        // Two endpoints for the one fork: anvil itself and a forwarder on a
        // second loopback port (rpc-forwarder.js says why not two anvils),
        // named as two providers by FREEDOM_E2E_PROVIDER_IDENTITIES below.
        endpointSources: {
          'e2e-anvil-gnosis': { role: 'rpc', keyed: false, coverage: { 100: anvil.url } },
          'e2e-anvil-gnosis-forwarder': {
            role: 'rpc',
            keyed: false,
            coverage: { 100: anvil.forwarderUrl },
          },
        },
        removedSources: BUILTIN_GNOSIS_SOURCES,
        // Read Gnosis from the fork only. Myotis and Colibri verify against
        // the *live* chain: their answers are correct there and wrong here
        // (the fork-funded Safe reads a verified balance of 0), so a
        // verifying source can never serve a fork. This keeps the
        // "nothing escapes to the live chain" promise above; it is not
        // what kept these specs alive — the SIGSEGV they used to hit (#453,
        // a Colibri receipt lookup trapping in WASM) is fixed in
        // colibri-runtime.js and pinned by colibri-runtime.test.js under
        // Electron's full main process.
        //
        // The quorum is asked first, so the Safe flow runs on verified reads,
        // as it would with two providers that agree. Direct answers when the
        // two disagree, e.g. one read lands just after a new block.
        networks: { 100: { access: { readOrder: ['quorum', 'direct'] } } },
      }),
      'utf-8'
    );

    // Real vault with TWO mnemonic accounts — the Safe's owners.
    const mnemonic = await identity.createVault(identityDir, VAULT_PASSWORD);
    const keys = identity.deriveAllKeys(mnemonic);
    const second = identity.deriveUserWallet(mnemonic, 1);
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({
        addresses: { userWallet: keys.userWallet.address },
        activeWalletIndex: 0,
        derivedWallets: [
          { index: 0, name: 'Main Wallet', address: keys.userWallet.address },
          { index: 1, name: 'Second Wallet', address: second.address },
        ],
      }),
      'utf-8'
    );

    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        // Test-only seam (src/main/networks/e2e-provider-identities.js).
        // Every loopback endpoint is one provider, so anvil and the
        // forwarder in front of it would be one quorum member; this names
        // them as two, so the fork's answers make the verified quorum a
        // Safe's activation needs. Only an unpackaged app honors it, and the
        // label it yields is this fixture's say-so, not two providers.
        FREEDOM_E2E_PROVIDER_IDENTITIES: JSON.stringify({
          [anvil.url]: 'e2e-anvil',
          [anvil.forwarderUrl]: 'e2e-anvil-forwarder',
        }),
        FREEDOM_IDENTITY_DATA: identityDir,
        FREEDOM_RADICLE_DATA: radicleDir,
        // Shown, not hidden (#536; the onboarding fixture's #479 is the same
        // bug). A never-shown window has no steady frame clock: probed
        // 2026-10 under xvfb, the hidden window ran requestAnimationFrame at
        // ~1 fps (60 fps shown), and on CI it intermittently stops. The
        // sidebar opens by widening over the area the tab's <webview> had,
        // and the browser routes a click by hit-testing the compositor's
        // last *presented* frame (see clickOverGuest in fixtures.js), so
        // with no new frame a click on #wallet-selector-btn can still go to
        // the guest: Playwright's in-renderer checks pass, the click
        // returns, and the selector never opens. Looped on CI 2026-10-06, retries
        // off: a cold first launch failed that way 16 times in 40 hidden and
        // 0 in 40 shown. '0' explicitly, so an inherited =1 can't re-hide it.
        FREEDOM_TEST_HIDE_WINDOW: '0',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });

    await use(app);

    await closeApp(app);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

module.exports = { test, expect, safeE2eAvailable, VAULT_PASSWORD };
