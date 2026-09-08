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
// RPC; the spec skips cleanly otherwise (CI has neither).

const { test: base, expect, _electron: electron } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'src', 'main', 'identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Safe-2026!';
const GNOSIS_FORK_URL = 'https://rpc.gnosischain.com';
const ANVIL_PORT = 18847; // distinct from the jest fork tests (18845/6)
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Builtin keyless Gnosis rpc sources to remove so nothing escapes to the
// live chain (keyed sources resolve to nothing without API keys).
const BUILTIN_GNOSIS_SOURCES = ['gno-gnosischain', 'gno-ankr', 'gno-publicnode', 'gno-drpc-public'];

/** anvil present + fork RPC reachable — mirrors the jest fork-test gate. */
function safeE2eAvailable() {
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
  // --block-time (not automine): ethers' waitForTransaction — which the
  // app relies on for confirmations — only re-checks receipts when new
  // blocks arrive, exactly like on the real chain.
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
        endpointSources: {
          'e2e-anvil-gnosis': { role: 'rpc', keyed: false, coverage: { 100: anvil.url } },
        },
        removedSources: BUILTIN_GNOSIS_SOURCES,
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
        FREEDOM_IDENTITY_DATA: identityDir,
        FREEDOM_RADICLE_DATA: radicleDir,
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
});

module.exports = { test, expect, safeE2eAvailable, VAULT_PASSWORD };
