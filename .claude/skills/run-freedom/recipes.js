// Recipes that put the running app into a specific UI state so it can be
// screenshotted or inspected. Every recipe takes the { app, win } pair from
// lib.launch() and leaves the state on screen; callers take the screenshot.
//
// Mirrors the mechanisms used by test-e2e/*.spec.js so the recipes stay in
// step with what the harness supports.

const { randomBytes } = require('crypto');

const {
  launch,
  go,
  pageFor,
  evalInWebview,
  harness,
  menuItem,
  dismissOnboarding,
} = require('./lib');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_MISSING = 'c'.repeat(64);
const PAGE_STYLE = '<style>body{font-family:sans-serif;padding:40px}</style>';

const LEDGER = {
  index: 1000000,
  name: 'Ledger 1',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};
const RECIPIENT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DATA_URI = 'data:application/octet-stream;base64,ZnJlZWRvbS1kb3dubG9hZHMtZTJl';

// A fixture page with three "needle" matches; opens the find bar with matches.
async function findBar({ app, win }, query = 'needle') {
  await harness.content(app, `bzz://${HASH_A}/`, {
    body: `<!doctype html><title>find fixture</title>${PAGE_STYLE}<p>needle one</p><p>needle two</p><p>NEEDLE three</p>`,
  });
  await go(win, `bzz://${HASH_A}/`, 2_000);
  await win.click('[data-test="address-input"]');
  await win.keyboard.press('Control+f');
  await win.waitForSelector('[data-test="find-bar"]', { state: 'visible' });
  await win.fill('[data-test="find-bar-input"]', query);
  await win.waitForTimeout(800);
}

// A fixture page that asks for a permission; leaves the prompt open.
// kind: 'notifications' | 'geolocation'
async function permissionPrompt({ app, win }, kind = 'notifications') {
  const ask =
    kind === 'geolocation'
      ? 'navigator.geolocation.getCurrentPosition(() => {}, () => {})'
      : 'Notification.requestPermission()';
  await harness.content(app, `bzz://${HASH_B}/`, {
    body: `<!doctype html><title>permission fixture</title>${PAGE_STYLE}<button id="ask">ask</button><script>document.getElementById('ask').addEventListener('click',()=>{${ask};});</script>`,
  });
  await go(win, `bzz://${HASH_B}`, 2_500);
  await evalInWebview(win, "document.getElementById('ask').click(); true");
  await win.waitForSelector('[data-test="permission-prompt"]', { state: 'visible' });
  await win.waitForTimeout(400);
}

// Answer the open prompt. Use dispatchEvent: right after a guest attaches,
// pointer events can be swallowed by the guest surface.
async function answerPermission({ win }, allow = true) {
  await win
    .locator(allow ? '[data-test="permission-allow"]' : '[data-test="permission-block"]')
    .dispatchEvent('click');
  await win.waitForTimeout(400);
}

// Trigger a completed download so the shelf card shows.
async function downloadShelf({ app, win }) {
  await app.evaluate(({ BrowserWindow }, uri) => {
    BrowserWindow.getAllWindows()[0].webContents.downloadURL(uri);
  }, DATA_URI);
  await win.waitForSelector('#download-shelf .download-card', {
    state: 'visible',
    timeout: 10_000,
  });
  await win.waitForTimeout(800);
}

// Right-click the first tab and leave the context menu open.
async function tabContextMenu({ win }) {
  await win.locator('[data-test="tab"]').first().click({ button: 'right' });
  await win.waitForSelector('#tab-context-menu', { state: 'visible', timeout: 2_000 });
}

// Mute (and optionally pin) the first tab through its context menu.
async function muteTab({ win }, { pin = false } = {}) {
  await tabContextMenu({ win });
  await win.locator('#tab-context-menu [data-action="mute"]').click({ timeout: 2_000 });
  await win.waitForTimeout(400);
  if (pin) {
    await tabContextMenu({ win });
    await win.locator('#tab-context-menu [data-action="pin"]').click({ timeout: 2_000 });
    await win.waitForTimeout(400);
  }
}

// Open the hamburger menu (zoomed in first so the zoom readout is non-default).
async function appMenu({ app, win }, { zoomIn = false } = {}) {
  if (zoomIn) {
    await menuItem(app, 'zoom-in');
    await win.waitForTimeout(300);
  }
  await win.click('#menu-button');
  await win.waitForTimeout(500);
}

async function nodesMenu({ win }) {
  await win.click('#bee-menu-button');
  await win.waitForTimeout(500);
}

// Open a private window and return its Playwright page.
async function privateWindow({ app, win }) {
  const known = new Set(
    app
      .windows()
      .filter((p) => p.url().includes('privatePartition=private-'))
      .map((p) => p.url())
  );
  await menuItem(app, 'new-private-window');
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    await win.waitForTimeout(300);
    page = app
      .windows()
      .find(
        (c) =>
          c.url().includes('privatePartition=private-') &&
          c.url().includes('index.html') &&
          !known.has(c.url())
      );
  }
  if (!page) throw new Error('private window did not open');
  page.setDefaultTimeout(8_000);
  await page.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  await page.waitForTimeout(800);
  return page;
}

// Open the settings page on a nav entry (profile, appearance, search,
// downloads, shortcuts, privacy, networks, nodes, advanced, about) and return
// the settings page. Sub-routes — a panel below the first, such as
// 'networks/rpc' or 'nodes/startup', or a chain detail such as 'networks/1' —
// are set via location.hash too; the pre-#268 names ('rpc', 'chains/1', …)
// still resolve.
async function settings({ app, win }, section = 'appearance') {
  await go(win, 'freedom://settings', 2_000);
  const page = await pageFor(app, 'settings.html');
  if (!page) throw new Error('settings page not found');
  page.setDefaultTimeout(8_000);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, section);
  await page.waitForTimeout(600);
  return page;
}

// Shortcuts page: start recording on New Tab and press Ctrl+W so the
// conflict banner shows.
async function shortcutConflict(ctx) {
  const page = await settings(ctx, 'shortcuts');
  await page.waitForSelector('#shortcuts-view [data-shortcut-id]');
  await page.evaluate(() =>
    document.querySelector('[data-shortcut-id="tab.new"] [data-action="record"]').click()
  );
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'w',
        code: 'KeyW',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
  );
  await page.waitForTimeout(400);
  return page;
}

// Stub the wallet IPC so the Send flow can run against a fake Ledger and
// seed renderer wallet state. Returns a resolver for the pending send.
async function stubWalletIpc({ app }) {
  await app.evaluate(({ ipcMain }) => {
    const replace = (ch, h) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, h);
    };
    replace('wallet:parse-amount', () => ({ success: true, value: '1000000000000000' }));
    replace('wallet:estimate-gas', () => ({ success: true, gasLimit: '21000' }));
    replace('wallet:get-gas-price', () => ({
      success: true,
      type: 'legacy',
      gasPrice: '1000000000',
      effectiveGasPrice: '1000000000',
    }));
    replace('ens:resolve-reverse', () => ({ success: false }));
    replace('identity:get-status', () => ({ isUnlocked: true }));
    replace('wallet:get-derived-wallets', () => ({
      success: true,
      wallets: [
        {
          index: 1000000,
          name: 'Ledger 1',
          address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          type: 'ledger',
        },
      ],
    }));
    replace('networks:get-chains', () => ({
      success: true,
      chains: { 8453: { chainId: 8453, name: 'Base', nativeSymbol: 'ETH' } },
    }));
    replace('dapp:get-permission', () => ({
      origin: 'https://swap.example',
      walletIndex: 1000000,
      chainId: 8453,
    }));
    globalThis.__resolveLedgerSend = null;
    replace(
      'wallet:send-transaction',
      () => new Promise((r) => (globalThis.__resolveLedgerSend = r))
    );
  });
  return (result) => app.evaluate((_e, r) => globalThis.__resolveLedgerSend(r), result);
}

// Open the sidebar Send form on the fake Ledger wallet.
async function sendForm({ app, win }) {
  await win.click('#wallet-toggle-btn').catch(() => {});
  await dismissOnboarding(win);
  await win.evaluate(
    async ({ ledger, recipient }) => {
      const { walletState } = await import('./lib/wallet/wallet-state.js');
      const sidebar = await import('./lib/sidebar.js');
      const send = await import('./lib/wallet/send.js');
      sidebar.open();
      document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
      document.getElementById('sidebar-identity')?.classList.remove('hidden');
      walletState.viewMode = 'identity';
      walletState.identityView = document.getElementById('sidebar-identity');
      walletState.fullAddresses.wallet = ledger.address;
      walletState.derivedWallets = [ledger];
      walletState.activeWalletIndex = ledger.index;
      walletState.selectedChainId = 8453;
      walletState.registeredChains = { 8453: { chainId: 8453, name: 'Base', nativeSymbol: 'ETH' } };
      walletState.registeredTokens = {
        'base-native': {
          chainId: 8453,
          symbol: 'ETH',
          name: 'Ether',
          decimals: 18,
          address: null,
          builtin: true,
        },
      };
      walletState.currentBalances = { 'base-native': { formatted: '1.0', symbol: 'ETH' } };
      send.openSend({ recipient, chainId: 8453 });
    },
    { ledger: LEDGER, recipient: RECIPIENT }
  );
  await win.waitForSelector('#sidebar-send', { state: 'visible' });
  await win.waitForTimeout(400);
  void app;
}

// dApp screens: main's prompts for a page's requests (freedom-core design
// 0011). Main sends a prompt to the chrome (`page:prompt`) and
// page-prompts.js hands it to the screen for its kind: the screens that
// register themselves (page-prompt-renderers.js), and dapp-connect.js's
// showPageConnect for connecting. A recipe hands the screen a prompt the way
// main would send it, with a handle main never issued. The screen is what is
// being tested here, not main's queue. Main refuses a decision for that
// handle (`page:decide` answers `closed`), and the screen comes down as it
// would after any refusal.
//
// The Send, Sign and Connect screens share the sidebar, and page-prompts.js
// shows no newcomer while one of them shows an undecided request
// (dapp-prompt-guard.js). So each recipe first answers whichever prompt is up
// the way a user would, with its own Reject button, and only then shows its
// own. The click goes through the DOM rather than the mouse so the pointer
// (and any :hover it draws) stays where the caller left it.
const DAPP_PROMPTS = [
  ['#sidebar-dapp-tx', '#dapp-tx-reject'],
  ['#sidebar-dapp-sign', '#dapp-sign-reject'],
  ['#sidebar-dapp-connect', '#dapp-connect-reject'],
];

const DAPP_SITE = { key: 'https://swap.example', label: 'https://swap.example' };
const SWARM_SITE = { key: 'bzz://myapp.eth', label: 'bzz://myapp.eth' };
// The account as main's views carry it.
const LEDGER_ACCOUNT = {
  index: LEDGER.index,
  name: LEDGER.name,
  address: LEDGER.address,
  type: LEDGER.type,
};

// A prompt as main sends it (`page:prompt`), with a fresh handle.
function pagePrompt(kind, site, view) {
  return { handle: randomBytes(32).toString('hex'), guest: 1, kind, site, view };
}

// Show `prompt` on the screen registered for its kind, as page-prompts.js
// does once the sidebar is free.
function showPagePrompt(win, prompt) {
  return win.evaluate(async (p) => {
    const { pagePromptRenderer } = await import('./lib/page-prompt-renderers.js');
    pagePromptRenderer(p.kind).show(p);
  }, prompt);
}

async function dismissDappPrompts(win) {
  await win.evaluate((prompts) => {
    for (const [screen, reject] of prompts) {
      const el = document.querySelector(screen);
      if (el && !el.classList.contains('hidden')) document.querySelector(reject)?.click();
    }
  }, DAPP_PROMPTS);
  for (const [screen] of DAPP_PROMPTS) {
    await win.waitForSelector(screen, { state: 'hidden' });
  }
}

// The screens look the Ledger up among the wallet's accounts: a device
// account skips the vault's unlock gate.
async function knowLedger(win) {
  await win.evaluate(async (ledger) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    walletState.derivedWallets = [ledger];
  }, LEDGER);
}

// A page's ERC-20 approve call: main's send prompt (`eth.send`) with the fee
// main quoted and the fee check's verdict.
async function dappTxApproval({ win }) {
  await dismissDappPrompts(win);
  await knowLedger(win);
  await showPagePrompt(
    win,
    pagePrompt('eth.send', DAPP_SITE, {
      account: LEDGER_ACCOUNT,
      chain: { id: 8453, name: 'Base', symbol: 'ETH' },
      tx: {
        to: RECIPIENT,
        value: '0',
        data: `0x095ea7b3${'0'.repeat(56)}deadbeef${'f'.repeat(64)}`,
      },
      fee: { gasLimit: '21000', gasPrice: '1000000000', estimate: '21000000000000' },
      feeCheck: {
        maxCost: '21000000000000',
        comparable: true,
        ratio: '1',
        above: false,
        autoApprove: true,
      },
      feeAskAgain: false,
      alwaysAllow: true,
    })
  );
  await win.waitForSelector('#sidebar-dapp-tx', { state: 'visible' });
  await win.waitForTimeout(500);
}

// A page's personal_sign: main's signing prompt (`eth.sign`) with the message
// as main decoded it.
async function dappSign({ win }) {
  await dismissDappPrompts(win);
  await knowLedger(win);
  await showPagePrompt(
    win,
    pagePrompt('eth.sign', DAPP_SITE, {
      account: LEDGER_ACCOUNT,
      chain: { id: 8453, name: 'Base' },
      method: 'personal_sign',
      message: { hex: '0x48656c6c6f2046726565646f6d', rawHash: false },
    })
  );
  await win.waitForSelector('#sidebar-dapp-sign', { state: 'visible' });
  await win.waitForTimeout(500);
}

// A page's eth_requestAccounts: main's connect prompt (`eth.connect`) with the
// accounts main offers.
async function dappConnect({ win }) {
  await dismissDappPrompts(win);
  await win.evaluate(
    async (prompt) => {
      const { showPageConnect } = await import('./lib/wallet/dapp-connect.js');
      showPageConnect(prompt);
    },
    pagePrompt('eth.connect', DAPP_SITE, {
      accounts: [LEDGER_ACCOUNT],
      defaultIndex: LEDGER.index,
    })
  );
  await win.waitForSelector('#sidebar-dapp-connect', { state: 'visible' });
  await win.waitForTimeout(500);
}

// The wallet's manage-permissions subscreen for a connected dApp — the screen
// #249 rendered white-on-white on the light theme. Needs stubWalletIpc() first
// (it reads the permission back over `dapp:get-permission`).
async function dappPermissions({ win }, origin = 'https://swap.example') {
  await win.evaluate(async (key) => {
    const pm = await import('./lib/wallet/permission-manage.js');
    await pm.showDappPermissions(key);
  }, origin);
  await win.waitForSelector('#sidebar-dapp-permissions', { state: 'visible' });
  await win.waitForTimeout(400);
}

// A Safe's own transactions, stopped by the fee check (design 0005, A): the
// executor's fee waits on the screen for the user's confirmation. A browser
// owner (the executor) and the Ledger above own a 2-of-2 Safe on Gnosis.
const SAFE_OWNER = {
  index: 0,
  name: 'Main Wallet',
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  type: 'mnemonic',
};
const SAFE = {
  index: 7,
  name: 'Team Safe',
  address: '0x41aD4887971f90BB3fE4d83eCa65177281283261',
  type: 'safe',
  owners: [SAFE_OWNER.index, LEDGER.index],
  threshold: 2,
  deployed: {},
};
const feeStop = (to, feeCheck) => ({
  success: false,
  code: 'FEE_CHECK_NEEDS_CONFIRMATION',
  error: "This payment's network fee needs your confirmation.",
  feeCheck: { maxCost: '310000000000000', oneEndpoint: false, autoApprove: false, ...feeCheck },
  offer: {
    executorIndex: SAFE_OWNER.index,
    chainId: 100,
    to,
    value: '0',
    data: '0x6a761202',
    gasLimit: '155000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
  },
});

// The signing board, every signature in: the executor's fee is far above
// today's network fee, its ratio shown.
async function safeExecuteFee({ app, win }) {
  const state = {
    status: 'collecting',
    collected: 2,
    threshold: 2,
    createdAt: new Date().toISOString(),
    display: { toAddress: RECIPIENT, amount: '250000000000000000', symbol: 'xDAI' },
    executorIndex: SAFE_OWNER.index,
    owners: [
      { index: SAFE_OWNER.index, type: 'mnemonic', signed: true },
      { index: LEDGER.index, type: 'ledger', signed: true },
    ],
  };
  const stop = feeStop(SAFE.address, { comparable: true, ratio: '12', above: true });
  await app.evaluate(
    ({ ipcMain }, { state, stop }) => {
      const replace = (ch, h) => {
        ipcMain.removeHandler(ch);
        ipcMain.handle(ch, h);
      };
      replace('wallet:safe-state', () => ({ success: true, state }));
      replace('wallet:safe-execute', () => stop);
    },
    { state, stop }
  );
  await win.evaluate(
    async ({ wallets, safe, state }) => {
      const { walletState } = await import('./lib/wallet/wallet-state.js');
      const board = await import('./lib/wallet/safe-signing.js');
      walletState.derivedWallets = wallets;
      await board.openSafeSigningBoard(safe.index, state);
    },
    { wallets: [SAFE_OWNER, LEDGER, SAFE], safe: SAFE, state }
  );
  await win.waitForSelector('#safe-signing-confirm-fee', { state: 'visible' });
  await win.waitForTimeout(400);
}

// The account card's activation: its fee couldn't be compared with today's
// network fee.
async function safeActivateFee({ app, win }) {
  const stop = feeStop('0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', {
    comparable: false,
    ratio: null,
    above: false,
  });
  await app.evaluate(
    ({ ipcMain }, { stop, executorAddress }) => {
      const replace = (ch, h) => {
        ipcMain.removeHandler(ch);
        ipcMain.handle(ch, h);
      };
      replace('wallet:get-safe-status', () => ({
        success: true,
        status: {
          deployed: false,
          chainId: 100,
          executorIndex: 0,
          executorAddress,
          executorBalance: '1000000000000000000',
          estimatedCost: '310000000000000',
          needsFunds: false,
        },
      }));
      replace('wallet:activate-safe', () => stop);
      // No site is connected in this tab (stubWalletIpc connects every one).
      replace('dapp:get-permission', () => null);
    },
    { stop, executorAddress: SAFE_OWNER.address }
  );
  await win.evaluate(
    async ({ wallets, safe }) => {
      const { walletState, hideAllSubscreens } = await import('./lib/wallet/wallet-state.js');
      const selector = await import('./lib/wallet/wallet-selector.js');
      const connect = await import('./lib/wallet/dapp-connect.js');
      walletState.derivedWallets = wallets;
      walletState.activeWalletIndex = safe.index;
      hideAllSubscreens();
      walletState.identityView?.classList.remove('hidden');
      await connect.updateConnectionBanner();
      // The Safe as the active account: its name, and its status card.
      selector.updateWalletSelectorDisplay(safe);
    },
    { wallets: [SAFE_OWNER, LEDGER, SAFE], safe: SAFE }
  );
  await win.waitForSelector('#safe-status-activate', { state: 'visible' });
  await win.click('#safe-status-activate');
  await win.waitForSelector('#safe-status-confirm-fee', { state: 'visible' });
  await win.waitForTimeout(400);
}

// Swarm approval screens: 'connect' | 'publish' | 'messaging' | 'feed'.
// Main's Swarm prompts (`swarm.*`, see the dApp screens above), each with the
// view main builds for the page's request.
const SWARM_PUBLISH_HTML = `<!doctype html><title>My app</title>${'<p>Hello Swarm.</p>'.repeat(64)}`;
const SWARM_MESSAGE = 'Hello from myapp.eth';
const SWARM_PROMPTS = {
  connect: ['#sidebar-swarm-connect', () => pagePrompt('swarm.connect', SWARM_SITE, {})],
  // swarm_publishData: what main measured, and the page's name and content
  // type as far as main bounds them.
  publish: [
    '#sidebar-swarm-publish-approve',
    () =>
      pagePrompt('swarm.publish', SWARM_SITE, {
        method: 'swarm_publishData',
        kind: 'data',
        size: Buffer.byteLength(SWARM_PUBLISH_HTML),
        contentType: 'text/html',
        name: 'index.html',
      }),
  ],
  // A PSS send on a site that already has messaging access: the per-send
  // prompt, with the "always allow" it offers.
  messaging: [
    '#sidebar-swarm-messaging-approve',
    () =>
      pagePrompt('swarm.messaging', SWARM_SITE, {
        method: 'swarm_sendPss',
        grantMode: false,
        topic: 'chat',
        size: Buffer.byteLength(SWARM_MESSAGE),
      }),
  ],
  // swarm_createFeed: main unlocks the vault first, so its view carries the
  // site's publisher identities and their owners, and the new app-scoped
  // identity it picks for a site with none.
  feed: [
    '#sidebar-swarm-feed-approve',
    () =>
      pagePrompt('swarm.feed', SWARM_SITE, {
        method: 'swarm_createFeed',
        mode: 'feeds',
        name: 'blog-updates',
        identities: [
          {
            id: 'bee-wallet',
            mode: 'bee-wallet',
            label: '',
            owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
            shared: true,
            stored: true,
            unavailable: false,
          },
        ],
        newIdentity: {
          id: 'app-scoped:0',
          mode: 'app-scoped',
          label: '',
          owner: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
          shared: false,
          stored: false,
          unavailable: false,
        },
        activeIdentityId: 'app-scoped:0',
      }),
  ],
};

async function swarmApproval({ win }, kind = 'connect') {
  const [screen, prompt] = SWARM_PROMPTS[kind];
  await showPagePrompt(win, prompt());
  await win.waitForSelector(screen, { state: 'visible' });
  await win.waitForTimeout(600);
}

// Verified onchain app with a trust header; leaves the page loaded.
async function onchainApp({ app, win }) {
  const { PROVENANCE_HEADER, encodeOnchainProvenance } = require(
    require('path').join(require('./lib').ROOT, 'src/main/onchain/onchain-app-protocol')
  );
  const address = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
  await harness.content(app, `web3://${address}.eip155-1/`, {
    body: `<!doctype html><title>Onchain fixture</title>${PAGE_STYLE}<h1>ERC-8244 fixture</h1>`,
    headers: {
      [PROVENANCE_HEADER]: encodeOnchainProvenance({
        version: 1,
        chainId: 1,
        network: 'Ethereum',
        contract: address,
        htmlHash: `0x${'ab'.repeat(32)}`,
        trust: {
          level: 'verified',
          method: 'myotis',
          finality: 'optimistic',
          block: 25684159,
          agreed: ['myotis-p2p'],
          dissented: [],
          queried: ['myotis-p2p'],
        },
      }),
    },
  });
  await go(win, `web3://${address}`, 2_500);
}

async function trustPopover({ win }) {
  await win.click('#trust-shield');
  await win.waitForSelector('#trust-popover', { state: 'visible' });
  await win.waitForTimeout(300);
}

// Tezos interstitials: 'unverified' | 'conflict'
async function tezInterstitial({ app, win }, kind = 'unverified') {
  if (kind === 'conflict') {
    await harness.ens(app, 'lagged.tez', {
      type: 'conflict',
      system: 'tezos',
      reason: 'Tezos RPC providers disagree about the chain head',
      groups: [
        { value: 'chain head #1000', urls: ['rpc-one.test'] },
        { value: 'chain head #400', urls: ['rpc-two.test'] },
      ],
      trust: { level: 'conflict', system: 'tezos', block: null, k: 2, m: 1 },
    });
    await go(win, 'lagged.tez', 2_500);
    return;
  }
  await harness.ens(app, 'retry.tez', {
    type: 'ok',
    system: 'tezos',
    protocol: 'ipfs',
    decoded: 'QmRetryTez',
    uri: 'ipfs://QmRetryTez',
    trust: { level: 'unverified', system: 'tezos', agreed: ['rpc-one.test'] },
  });
  await harness.content(app, 'ipfs://retry.tez/', {
    body: '<html><body>retry.tez content loaded</body></html>',
  });
  await go(win, 'retry.tez', 2_500);
}

// Swarm "content not found" error page.
async function errorPage({ app, win }) {
  await harness.probe(app, HASH_MISSING, { ok: false, reason: 'not_found' });
  await go(win, `bzz://${HASH_MISSING}`, 2_500);
}

// freedom://profiles with a real catalog: its own catalog-mode app (see
// lib.js `launch`), two profiles created beside the default one. Returns the
// context; the caller shoots and closes it.
async function profilesPage(theme, names = ['Work', 'Research']) {
  const ctx = await launch({ theme }, { catalog: true });
  for (const displayName of names) {
    const result = await ctx.win.evaluate((input) => window.electronAPI.createProfile(input), {
      displayName,
    });
    if (!result?.success)
      throw new Error(`createProfile ${displayName}: ${JSON.stringify(result)}`);
  }
  await go(ctx.win, 'freedom://profiles', 1_800);
  return ctx;
}

module.exports = {
  profilesPage,
  HASH_A,
  HASH_B,
  LEDGER,
  RECIPIENT,
  findBar,
  permissionPrompt,
  answerPermission,
  downloadShelf,
  tabContextMenu,
  muteTab,
  appMenu,
  nodesMenu,
  privateWindow,
  settings,
  shortcutConflict,
  stubWalletIpc,
  sendForm,
  dappTxApproval,
  dappSign,
  dappConnect,
  dappPermissions,
  safeExecuteFee,
  safeActivateFee,
  swarmApproval,
  onchainApp,
  trustPopover,
  tezInterstitial,
  errorPage,
};
