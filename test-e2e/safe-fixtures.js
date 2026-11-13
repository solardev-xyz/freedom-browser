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
const net = require('net');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));
const BUILTIN_TOKENS = require(path.join(repoRoot, 'src', 'shared', 'tokens.json'));
const safeDeployments = require('@safe-global/safe-deployments');
const { closeApp } = require('./close-app');
const { chromeWindow } = require('./chrome-window');
const { startRpcForwarder } = require('./rpc-forwarder');

const VAULT_PASSWORD = 'Freedom-E2E-Safe-2026!';
const GNOSIS_FORK_URL = 'https://rpc.gnosischain.com';
const ANVIL_PORT = 18847; // distinct from the jest fork tests (18845/6)
// The fork's second endpoint, a forwarder (rpc-forwarder.js).
const FORWARDER_PORT = 18849;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Builtin keyless Gnosis rpc sources to remove so nothing escapes to the
// live chain (keyed sources resolve to nothing without API keys).
const BUILTIN_GNOSIS_SOURCES = ['gno-gnosischain', 'gno-publicnode', 'gno-drpc-public'];

/**
 * anvil present + fork RPC reachable — mirrors the jest fork-test gate.
 *
 * With FREEDOM_SAFE_E2E_REQUIRED=1 (the `e2e-safe` CI job) a missing
 * prerequisite throws instead of skipping: a skipped spec reports green, so a
 * broken foundry install or an unreachable fork RPC would otherwise turn the
 * job into a silent no-op.
 */
function safeE2eAvailable() {
  let missing = null;
  if (spawnSync('anvil', ['--version']).status !== 0) {
    missing = 'anvil (foundry) is not on PATH';
  } else {
    const probe = spawnSync('curl', [
      '-sf', '-m', '10', '-X', 'POST', GNOSIS_FORK_URL,
      '-H', 'Content-Type: application/json',
      '-d', '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
    ]);
    if (probe.status !== 0) missing = `the fork RPC ${GNOSIS_FORK_URL} is unreachable`;
  }
  if (missing && process.env.FREEDOM_SAFE_E2E_REQUIRED === '1') {
    throw new Error(`Safe E2E required but ${missing}`);
  }
  return !missing;
}

const DIAGNOSTIC_LINES = 50_000;

/**
 * One test's diagnostics (#1101): anvil's lifecycle and output, the
 * forwarder's exchanges, the app's main-process output and the chrome
 * window's console, each line stamped with the milliseconds since the test
 * began. Written to the test's output directory and attached when the test
 * fails, so an attempt that a retry hides still leaves them in the job's
 * uploaded test-results. At most DIAGNOSTIC_LINES lines are kept.
 */
function createDiagnostics() {
  const started = Date.now();
  const lines = [];
  let dropped = 0;
  const add = (source, text) => {
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      if (lines.length < DIAGNOSTIC_LINES) {
        lines.push(`+${Date.now() - started}ms [${source}] ${line}`);
      } else {
        dropped += 1;
      }
    }
  };
  return {
    add,
    /** Every line `stream` writes, as `source`'s. */
    pipe(source, stream) {
      let rest = '';
      stream?.on('data', (chunk) => {
        const text = rest + chunk.toString('utf8');
        const end = text.lastIndexOf('\n');
        if (end === -1) {
          rest = text;
          return;
        }
        add(source, text.slice(0, end));
        rest = text.slice(end + 1);
      });
      stream?.on('end', () => rest && add(source, rest));
    },
    text() {
      return lines.join('\n') + (dropped ? `\n(${dropped} more lines dropped)` : '') + '\n';
    },
  };
}

/** Whether something accepts connections on 127.0.0.1:`port`. */
function portAccepting(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (accepting) => {
      socket.destroy();
      resolve(accepting);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
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

// The contracts the warm-up loads (warmFork): Gnosis's builtin tokens, whose
// balances the wallet reads as it starts, and the Safe 1.4.1 contracts a
// Safe's status quote and activation execute (safe-executor.js pins these).
const GNOSIS_TOKENS = Object.values(BUILTIN_TOKENS)
  .filter((token) => token.chainId === 100 && token.address)
  .map((token) => token.address);
const SAFE_CONTRACTS = [
  'getSafeL2SingletonDeployment',
  'getProxyFactoryDeployment',
  'getCompatibilityFallbackHandlerDeployment',
].flatMap((getter) => {
  const deployment = safeDeployments[getter]({ version: '1.4.1', network: '100' });
  const address = deployment?.networkAddresses?.['100'];
  return address ? [address].flat() : [];
});
const ERC20_DECIMALS = '0x313ce567';
// The fixtures run inside the test's 30 s timeout (setTimeout in the body
// extends it only afterwards), with anvil's own start ahead of the warm-up:
// past this, the app starts with whatever is warm by then.
const WARM_UP_MS = 15_000;
const erc20BalanceOf = (holder) => '0x70a08231' + holder.slice(2).toLowerCase().padStart(64, '0');

/**
 * Loads into the fork, before the app starts, the state the app reads first
 * (#1101): the vault accounts, the builtin Gnosis tokens' balances for them,
 * and the Safe contracts' code.
 *
 * A fresh fork holds no state: anvil fetches each account, its code and
 * each storage slot from the public RPC the first time something reads it,
 * one round trip at a time. On CI a cold token balance took 4–6 s. The app
 * reads its wallet's balances as it starts, each read from both endpoints
 * (the quorum), and Electron's network stack keeps at most six connections
 * open to each endpoint. The Safe card's first eth_getCode then waited behind
 * those reads on both endpoints until the core's 5 s timeout passed, and the
 * card showed "All RPC endpoints failed" with nothing to retry it. Warm, those
 * reads take milliseconds. What stays cold is what no fixture can know ahead:
 * the new Safe's own address, one round trip.
 *
 * Bounded by WARM_UP_MS; a read that fails or is still running then only
 * leaves its state cold.
 */
async function warmFork(holders, diagnostics) {
  const started = Date.now();
  const reads = [
    ...holders.map((holder) => rpc('eth_getBalance', [holder, 'latest'])),
    ...SAFE_CONTRACTS.map((address) => rpc('eth_getCode', [address, 'latest'])),
    ...GNOSIS_TOKENS.flatMap((to) => [
      rpc('eth_call', [{ to, data: ERC20_DECIMALS }, 'latest']),
      ...holders.map((holder) => rpc('eth_call', [{ to, data: erc20BalanceOf(holder) }, 'latest'])),
    ]),
  ];
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), WARM_UP_MS);
  });
  const settled = await Promise.race([Promise.allSettled(reads), bound]);
  clearTimeout(timer);
  if (!settled) {
    diagnostics.add('fixture', `warm-up still running after ${WARM_UP_MS} ms: starting the app`);
    return;
  }
  const failed = settled.filter((result) => result.status === 'rejected');
  diagnostics.add(
    'fixture',
    `warmed the fork: ${reads.length} reads in ${Date.now() - started} ms, ${failed.length} failed` +
      (failed.length ? ` (first: ${failed[0].reason?.message})` : '')
  );
}

async function startAnvilFork(diagnostics) {
  if (await portAccepting(ANVIL_PORT)) {
    diagnostics.add('fixture', `port ${ANVIL_PORT} accepts connections before anvil starts`);
  }
  // --block-time (not automine): ethers' waitForTransaction — which the
  // app relies on for confirmations — only re-checks receipts when new
  // blocks arrive, exactly like on the real chain. Not --silent: its
  // output goes to the diagnostics.
  const proc = spawn('anvil', [
    '--fork-url', GNOSIS_FORK_URL,
    '--port', String(ANVIL_PORT),
    '--block-time', '2',
  ]);
  diagnostics.add('fixture', `anvil spawned, pid ${proc.pid}`);
  diagnostics.pipe('anvil', proc.stdout);
  diagnostics.pipe('anvil:err', proc.stderr);
  proc.once('exit', (code, signal) =>
    diagnostics.add('fixture', `anvil pid ${proc.pid} exited: code ${code}, signal ${signal}`)
  );
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    try {
      const chainId = await rpc('eth_chainId');
      if (parseInt(chainId, 16) === 100) {
        diagnostics.add('fixture', 'anvil answered eth_chainId 100');
        return proc;
      }
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
  diagnostics: async ({}, use, testInfo) => {
    const diagnostics = createDiagnostics();
    await use(diagnostics);
    if (testInfo.status !== testInfo.expectedStatus) {
      const file = testInfo.outputPath('safe-e2e-diagnostics.log');
      fs.writeFileSync(file, diagnostics.text());
      await testInfo.attach('safe-e2e-diagnostics', { path: file, contentType: 'text/plain' });
    }
  },

  anvil: async ({ diagnostics }, use) => {
    const proc = await startAnvilFork(diagnostics);
    const forwarder = await startRpcForwarder(ANVIL_URL, FORWARDER_PORT, {
      log: (line) => diagnostics.add('forwarder', line),
    });
    await use({ url: ANVIL_URL, forwarderUrl: forwarder.url, rpc });
    await forwarder.close();
    diagnostics.add('fixture', `stopping anvil pid ${proc.pid}`);
    proc.kill();
  },

  // The approvals document (freedom-core design 0011): on by default, so
  // the Safe boards and every approval show in the window's panel; false
  // runs the rollback, the chrome's own screens (FREEDOM_APPROVALS_DOCUMENT=0).
  approvalsDocument: [true, { option: true }],

  electronApp: async ({ anvil, diagnostics, approvalsDocument }, use) => {
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
    await warmFork([keys.userWallet.address, second.address], diagnostics);
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
        FREEDOM_APPROVALS_DOCUMENT: approvalsDocument ? '1' : '0',
      },
      timeout: 20_000,
    });
    diagnostics.add('fixture', `app launched, pid ${app.process().pid}`);
    diagnostics.pipe('app', app.process().stdout);
    diagnostics.pipe('app:err', app.process().stderr);

    await use(app);

    await closeApp(app);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },

  window: async ({ electronApp, diagnostics }, use) => {
    // The chrome, not the window's approvals document (a page too).
    const window = await chromeWindow(electronApp);
    window.on('console', (message) =>
      diagnostics.add('renderer', `${message.type()}: ${message.text()}`)
    );
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

module.exports = { test, expect, safeE2eAvailable, VAULT_PASSWORD };
