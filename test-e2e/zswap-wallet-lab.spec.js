// Lab-only lifecycle test for zSwap's unmodified single-file application.
// Point FREEDOM_ZSWAP_HTML at a downloaded html() response (or gateway copy).

const fs = require('fs');
const { test, expect } = require('./fixtures');

const ADDRESS = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const APP_URL = `web3://${ADDRESS}.eip155-1/`;
const WEIDAO_ADDRESS = '0x00000007988a79d16cf76b5dc4cf54dc3af24936';
const WEIDAO_URL = `web3://${WEIDAO_ADDRESS}.eip155-1/`;
const WALLET = {
  index: 0,
  name: 'Lab Wallet',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
};
const HTML_PATH = process.env.FREEDOM_ZSWAP_HTML || '/private/tmp/zswap-gateway.html';
const HAS_HTML = fs.existsSync(HTML_PATH);
const WEIDAO_HTML_PATH =
  process.env.FREEDOM_WEIDAO_HTML || '/private/tmp/onchain-app-07988.html';
const HAS_WEIDAO_HTML = fs.existsSync(WEIDAO_HTML_PATH);

test.use({
  seedSettings: {
    enableIdentityWallet: true,
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    startRadicleAtLaunch: false,
  },
});

async function inWebview(window, script) {
  return window.evaluate(async (code) => {
    const webview = document.querySelector('webview:not(.hidden)');
    if (!webview?.executeJavaScript) return null;
    try {
      return await webview.executeJavaScript(code);
    } catch {
      return null;
    }
  }, script);
}

async function installWalletAndChainStubs(window, electronApp) {
  await electronApp.evaluate(({ ipcMain }, wallet) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('wallet:get-derived-wallets', () => ({ success: true, wallets: [wallet] }));
    replace('wallet:chain-request', (_event, { method }) => {
      const results = {
        eth_chainId: '0x1',
        eth_blockNumber: '0x1876543',
        eth_getBalance: '0x0',
        eth_getCode: '0x',
        eth_call: '0x',
      };
      return { success: true, result: results[method] ?? '0x' };
    });
  }, WALLET);

  await window.evaluate(async (wallet) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    walletState.derivedWallets = [wallet];
    walletState.activeWalletIndex = wallet.index;
  }, WALLET);
}

async function installWalletStub(window, electronApp) {
  await electronApp.evaluate(({ ipcMain }, wallet) => {
    ipcMain.removeHandler('wallet:get-derived-wallets');
    ipcMain.handle('wallet:get-derived-wallets', () => ({ success: true, wallets: [wallet] }));
  }, WALLET);

  await window.evaluate(async (wallet) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    walletState.derivedWallets = [wallet];
    walletState.activeWalletIndex = wallet.index;
  }, WALLET);
}

test('zSwap connects once and restores its wallet state across reloads', async ({
  window,
  electronApp,
  harness,
}) => {
  test.skip(!HAS_HTML, `zSwap HTML corpus not found at ${HTML_PATH}`);
  test.setTimeout(120_000);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  await installWalletAndChainStubs(window, electronApp);
  await harness.setContentFixture(APP_URL, {
    contentType: 'text/html; charset=utf-8',
    body: html,
  });

  const input = window.locator('[data-test="address-input"]');
  await input.fill(`web3://${ADDRESS}`);
  await input.press('Enter');

  await expect.poll(() => inWebview(window, 'document.querySelector("#swap")?.textContent'))
    .toBe('Connect Wallet');
  expect(await inWebview(window, 'Boolean(window.ethereum?.request)')).toBe(true);

  await inWebview(window, 'document.querySelector("#swap").click(); true');
  await expect(window.locator('#sidebar-dapp-connect')).toBeVisible();
  await window.locator('#dapp-connect-approve').click();

  await expect.poll(() => inWebview(window, 'document.querySelector("#addr")?.textContent'), {
    timeout: 10_000,
  }).toBe('0x2096...287C');

  const reloadTimes = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const started = Date.now();
    await window.locator('#reload-btn').click();
    await expect.poll(() => inWebview(window, 'document.querySelector("#addr")?.textContent'), {
      timeout: 10_000,
    }).toBe('0x2096...287C');
    reloadTimes.push(Date.now() - started);
  }

  console.log('[zswap-wallet-lab] reload restoration ms:', reloadTimes.join(', '));
});

test('zSwap connection milestones through the real Freedom read router', async ({
  window,
  electronApp,
  harness,
}) => {
  test.skip(!HAS_HTML, `zSwap HTML corpus not found at ${HTML_PATH}`);
  test.skip(process.env.FREEDOM_ZSWAP_LIVE !== '1', 'opt-in live source-router measurement');
  test.setTimeout(300_000);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  await installWalletStub(window, electronApp);
  await harness.setContentFixture(APP_URL, {
    contentType: 'text/html; charset=utf-8',
    body: html,
  });

  const input = window.locator('[data-test="address-input"]');
  await input.fill(`web3://${ADDRESS}`);
  await input.press('Enter');
  await expect.poll(() => inWebview(window, 'document.querySelector("#swap")?.textContent'))
    .toBe('Connect Wallet');

  await inWebview(window, `
    window.__walletLab = { started: performance.now(), calls: [], events: [] };
    const originalRequest = window.ethereum.request.bind(window.ethereum);
    window.ethereum.request = async (request) => {
      const call = { method: request.method, started: performance.now() };
      window.__walletLab.calls.push(call);
      try {
        const result = await originalRequest(request);
        call.ended = performance.now();
        call.result = request.method === 'eth_requestAccounts' ? result : undefined;
        return result;
      } catch (error) {
        call.ended = performance.now();
        call.error = String(error?.message || error);
        throw error;
      }
    };
    for (const event of ['accountsChanged', 'connect']) {
      window.ethereum.on(event, (data) => {
        window.__walletLab.events.push({ event, data, at: performance.now() });
      });
    }
    true
  `);

  await inWebview(window, 'document.querySelector("#swap").click(); true');
  await expect(window.locator('#sidebar-dapp-connect')).toBeVisible();
  await window.locator('#dapp-connect-approve').click();
  const approvedAt = Date.now();

  await expect.poll(() => inWebview(window, 'document.querySelector("#addr")?.textContent'), {
    timeout: 30_000,
  }).toBe('0x2096...287C');
  const addressMs = Date.now() - approvedAt;

  await expect.poll(() => inWebview(window, 'document.querySelector("#swap")?.textContent'), {
    timeout: 180_000,
  }).not.toBe('Connecting…');
  const readyMs = Date.now() - approvedAt;
  const finalButton = await inWebview(window, 'document.querySelector("#swap")?.textContent');
  const status = await inWebview(window, 'document.querySelector("#stat")?.textContent');
  const providerTrace = await inWebview(window, 'window.__walletLab');

  console.log('[zswap-wallet-lab] live connect:', {
    addressMs,
    readyMs,
    finalButton,
    status,
    providerTrace: JSON.stringify(providerTrace),
  });

  const reloadAt = Date.now();
  await window.locator('#reload-btn').click();
  await expect.poll(() => inWebview(window, 'document.querySelector("#addr")?.textContent'), {
    timeout: 30_000,
  }).toBe('0x2096...287C');
  const reloadAddressMs = Date.now() - reloadAt;
  await expect.poll(() => inWebview(window, 'document.querySelector("#swap")?.textContent'), {
    timeout: 180_000,
  }).not.toBe('Connect Wallet');
  const reloadReadyMs = Date.now() - reloadAt;
  console.log('[zswap-wallet-lab] live reload:', { reloadAddressMs, reloadReadyMs });
});

test('an eager app captures Freedom wallet injection while parsing', async ({
  window,
  electronApp,
  harness,
}) => {
  test.skip(!HAS_WEIDAO_HTML, `WeiDAO HTML corpus not found at ${WEIDAO_HTML_PATH}`);
  const html = fs.readFileSync(WEIDAO_HTML_PATH, 'utf8');
  await installWalletAndChainStubs(window, electronApp);
  await harness.setContentFixture(WEIDAO_URL, {
    contentType: 'text/html; charset=utf-8',
    body: html,
  });

  // Do not let the initial home commit clear an address typed by the test.
  await expect.poll(() =>
    window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
  ).toContain('/pages/home.html');

  const input = window.locator('[data-test="address-input"]');
  await input.fill(`web3://${WEIDAO_ADDRESS}`);
  await input.press('Enter');
  await expect.poll(() => inWebview(window, 'document.querySelector("#cx")?.textContent'))
    .toBe('Connect wallet');

  expect(await inWebview(window, 'Boolean(window.ethereum?.request)')).toBe(true);
  await inWebview(window, `
    window.__walletLabAlerts = [];
    window.alert = (message) => window.__walletLabAlerts.push(String(message));
    document.querySelector('#cx').click();
    true
  `);

  await expect(window.locator('#sidebar-dapp-connect')).toBeVisible();
  expect(await inWebview(window, 'window.__walletLabAlerts')).toEqual([]);
});
