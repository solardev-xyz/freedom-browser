// Recipes that put the running app into a specific UI state so it can be
// screenshotted or inspected. Every recipe takes the { app, win } pair from
// lib.launch() and leaves the state on screen; callers take the screenshot.
//
// Mirrors the mechanisms used by test-e2e/*.spec.js so the recipes stay in
// step with what the harness supports.

const { go, pageFor, evalInWebview, harness, menuItem, dismissOnboarding } = require('./lib');

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

// Open the settings page on a section (appearance, search, profile, nodes,
// startup, downloads, shortcuts, chains, rpc, ens, adblock, permissions,
// experimental, updates) and return the settings page. Sub-routes such as
// 'chains/1' are set via location.hash.
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
    replace('dapp:add-transaction-auto-approve', () => ({ success: true }));
    globalThis.__resolveLedgerSend = null;
    const pending = () => new Promise((r) => (globalThis.__resolveLedgerSend = r));
    replace('wallet:send-transaction', pending);
    replace('wallet:dapp-send-transaction', pending);
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

// dApp screens rendered directly from the renderer modules.
async function dappTxApproval({ win }) {
  await win.evaluate(
    async ({ ledger, to }) => {
      const dappTx = await import('./lib/wallet/dapp-tx.js');
      const { walletState } = await import('./lib/wallet/wallet-state.js');
      walletState.derivedWallets = [ledger];
      dappTx
        .showDappTxApproval({}, 'https://swap.example', {
          to,
          value: '0',
          data: `0x095ea7b3${'0'.repeat(56)}deadbeef${'f'.repeat(64)}`,
        })
        .then(
          () => {},
          () => {}
        );
    },
    { ledger: LEDGER, to: RECIPIENT }
  );
  await win.waitForSelector('#sidebar-dapp-tx', { state: 'visible' });
  await win.waitForTimeout(500);
}

async function dappSign({ win }) {
  await win.evaluate(async () => {
    const dappSign = await import('./lib/wallet/dapp-sign.js');
    dappSign.showDappSignApproval({}, 'https://swap.example', 'personal_sign', [
      '0x48656c6c6f2046726565646f6d',
      '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    ]);
  });
  await win.waitForTimeout(600);
}

async function dappConnect({ win }) {
  await win.evaluate(async () => {
    const dappConnect = await import('./lib/wallet/dapp-connect.js');
    new Promise((res, rej) =>
      dappConnect.showDappConnect('https://swap.example', 'https://swap.example', res, rej, {})
    );
  });
  await win.waitForTimeout(600);
}

// Swarm approval screens: 'connect' | 'publish' | 'messaging' | 'feed'
async function swarmApproval({ win }, kind = 'connect') {
  await win.evaluate(async (k) => {
    const sc = await import('./lib/wallet/swarm-connect.js');
    const origin = 'bzz://myapp.eth';
    const show = {
      connect: (res, rej) => sc.showSwarmConnect('myapp.eth', origin, res, rej, null),
      publish: (res, rej) =>
        sc.showSwarmPublishApproval(
          origin,
          { size: 1234, filename: 'index.html' },
          res,
          rej,
          'swarm_upload'
        ),
      messaging: (res, rej) =>
        sc.showSwarmMessagingApproval(origin, { topic: 'chat' }, res, rej, {}),
      feed: (res, rej) => sc.showSwarmFeedApproval(origin, { topic: 'feed' }, res, rej, {}),
    }[k];
    new Promise(show);
  }, kind);
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

module.exports = {
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
  swarmApproval,
  onchainApp,
  trustPopover,
  tezInterstitial,
  errorPage,
};
