// Payments waiting: the held payments (the wallet's intent records) listed
// under the identity view, each with Send again, and a higher-fee
// replacement where that is the fix. A dApp's payment asks once more before
// it is sent again. The send review warns when a new payment would wait
// behind one of them (D11). Each action is authorized by a confirmation
// main mints for that held payment (freedom-core design 0005, "Retrying an
// intent").
//
// Driven through the real renderer screens and the real confirmation
// handler; the intent handlers are replaced for this app instance. Writes
// screenshots of each new surface in both themes to test-results/.

const { test, expect } = require('./fixtures');

const LEDGER = {
  index: 1000000,
  name: 'Ledger 1',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};
const SENDER = LEDGER.address.toLowerCase();
const RECIPIENT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MINUTES_AGO = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();

const held = (overrides) => ({
  chainId: 8453,
  sender: SENDER,
  state: 'held',
  kind: 'wallet-send',
  origin: null,
  walletIndex: LEDGER.index,
  fields: {
    type: 0,
    to: RECIPIENT,
    value: '250000000000000000',
    data: '0x',
    gasLimit: '21000',
    gasPrice: '2000000000',
  },
  createdAt: MINUTES_AGO(12),
  receipt: null,
  ...overrides,
});

const UNDERPRICED = held({
  intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a07',
  nonce: 7,
  hash: `0x${'a7'.repeat(32)}`,
  attention: 'refused',
  lastOutcome: { outcome: 'rejected', reasonClass: 'transaction underpriced' },
  replacement: 'replace',
});
const DAPP = held({
  intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a08',
  nonce: 8,
  hash: `0x${'a8'.repeat(32)}`,
  kind: 'dapp-send',
  origin: 'https://app.example',
  fields: { ...UNDERPRICED.fields, value: '10000000000000000' },
  createdAt: MINUTES_AGO(9),
  attention: 'not-sent',
  lastOutcome: { outcome: 'not_sent' },
  replacement: null,
});
const STUCK = held({
  intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a09',
  nonce: 9,
  hash: `0x${'a9'.repeat(32)}`,
  createdAt: MINUTES_AGO(3),
  attention: 'uncertain',
  lastOutcome: { outcome: 'uncertain' },
  replacement: 'speed-up',
});
const REPLACEMENT_FEES = { gasPrice: '2200000000' };

function stubMainIpc(electronApp, intents) {
  return electronApp.evaluate(({ ipcMain }, { intents, fees }) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
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
    globalThis.__resends = [];
    globalThis.__replacements = [];
    replace('wallet:intents-list', () => ({ success: true, intents }));
    replace('wallet:intent-resend', (_event, intentId, authorization) => {
      globalThis.__resends.push({ intentId, authorization });
      return { success: true, outcome: 'sent', resent: true };
    });
    replace('wallet:intent-replacement-fees', () => ({ success: true, fees }));
    replace('wallet:intent-replace', (_event, intentId, submitted, authorization) => {
      globalThis.__replacements.push({ intentId, fees: submitted, authorization });
      return { success: true, outcome: 'sent', replaced: true };
    });
  }, { intents, fees: REPLACEMENT_FEES });
}

async function showIdentity(window) {
  await window.evaluate(async (ledger) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const sidebar = await import('./lib/sidebar.js');
    const held = await import('./lib/wallet/held-payments.js');
    sidebar.open();
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
    document.getElementById('sidebar-identity')?.classList.remove('hidden');
    walletState.viewMode = 'identity';
    walletState.identityView = document.getElementById('sidebar-identity');
    walletState.fullAddresses.wallet = ledger.address;
    walletState.derivedWallets = [ledger];
    walletState.activeWalletIndex = ledger.index;
    walletState.selectedChainId = 8453;
    walletState.registeredChains = {
      8453: { chainId: 8453, name: 'Base', nativeSymbol: 'ETH' },
    };
    walletState.registeredTokens = {
      'base-native': {
        chainId: 8453, symbol: 'ETH', name: 'Ether', decimals: 18, address: null, builtin: true,
      },
    };
    walletState.currentBalances = { 'base-native': { formatted: '1.0', symbol: 'ETH' } };
    await held.refreshHeldPayments();
  }, LEDGER);
}

const setTheme = (window, theme) =>
  window.evaluate((value) => {
    if (value === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }, theme);

async function shootBothThemes(window, name) {
  for (const theme of ['dark', 'light']) {
    await setTheme(window, theme);
    await window.screenshot({ path: `test-results/${name}-${theme}.png` });
  }
  await setTheme(window, 'dark');
}

const rowOf = (window, intent) => window.locator(`#held-payments-list [data-intent="${intent.intentId}"]`);

test('waiting payments are listed, sent again and replaced, each confirmed as itself', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, [STUCK, UNDERPRICED, DAPP]);
  await showIdentity(window);

  const row = window.locator('#held-payments-row');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Payments waiting');
  await expect(window.locator('#held-payments-count')).toHaveText('3');
  // The sidebar slides in: shoot the row once it is wholly on screen.
  await expect
    .poll(() =>
      row.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth - 8)
    )
    .toBe(true);
  await shootBothThemes(window, 'held-payments-row');

  await row.click();
  await expect(window.locator('#sidebar-held-payments')).toBeVisible();
  await expect(window.locator('#sidebar-held-payments .subscreen-title')).toHaveText('Payments Waiting');
  // Oldest nonce first, each saying what it pays and why it waits.
  await expect(window.locator('#held-payments-list .held-payment-row')).toHaveCount(3);
  await expect(window.locator('#held-payments-list .safe-signing-row-name').first()).toHaveText(
    '0.25 ETH to 0x8335…2913'
  );
  await expect(rowOf(window, UNDERPRICED)).toContainText('Ledger 1 · Base · nonce 7 · 12 minutes ago');
  await expect(rowOf(window, UNDERPRICED)).toContainText('The network refused it: transaction underpriced');
  await expect(rowOf(window, DAPP)).toContainText('Requested by https://app.example');
  await expect(rowOf(window, DAPP)).toContainText('Not sent; nothing left this computer');
  await expect(rowOf(window, STUCK)).toContainText('Sent, waiting for confirmation');
  await expect(rowOf(window, UNDERPRICED).locator('[data-action="replace"]')).toHaveText('Raise the fee');
  await expect(rowOf(window, STUCK).locator('[data-action="replace"]')).toHaveText('Speed up');
  await expect(rowOf(window, DAPP).locator('[data-action="replace"]')).toHaveCount(0);
  await shootBothThemes(window, 'held-payments-list');

  // The user's own payment: Send again at the press.
  await rowOf(window, STUCK).locator('[data-action="resend"]').click();
  await expect.poll(() => electronApp.evaluate(() => globalThis.__resends.length)).toBe(1);

  // A dApp's payment asks once more, naming the site.
  await rowOf(window, DAPP).locator('[data-action="resend"]').click();
  await expect(rowOf(window, DAPP)).toContainText(
    'Send the payment https://app.example requested 9 minutes ago again? It is the same signed payment.'
  );
  await shootBothThemes(window, 'held-payments-dapp-confirm');
  await rowOf(window, DAPP).locator('[data-action="confirm-resend"]').click();
  await expect.poll(() => electronApp.evaluate(() => globalThis.__resends.length)).toBe(2);

  // A refusal over fees: the new fee is shown before anything is signed.
  await rowOf(window, UNDERPRICED).locator('[data-action="replace"]').click();
  // 21000 gas at 2.2 gwei.
  await expect(rowOf(window, UNDERPRICED)).toContainText('New network fee: up to 0.0000462 ETH');
  await shootBothThemes(window, 'held-payments-replace');
  expect(await electronApp.evaluate(() => globalThis.__replacements)).toEqual([]);
  await rowOf(window, UNDERPRICED).locator('[data-action="confirm-replace"]').click();
  await expect(rowOf(window, UNDERPRICED)).toContainText('Replaced with a higher fee');

  const calls = await electronApp.evaluate(() => ({
    resends: globalThis.__resends,
    replacements: globalThis.__replacements,
  }));
  const confirmation = { confirmation: expect.stringMatching(/^[0-9a-f]{64}$/) };
  expect(calls.resends).toEqual([
    { intentId: STUCK.intentId, authorization: confirmation },
    { intentId: DAPP.intentId, authorization: confirmation },
  ]);
  expect(calls.replacements).toEqual([
    { intentId: UNDERPRICED.intentId, fees: REPLACEMENT_FEES, authorization: confirmation },
  ]);
});

test('the send review warns when the payment would wait behind a held one', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, [UNDERPRICED, DAPP]);
  await showIdentity(window);
  await window.evaluate(async (recipient) => {
    const send = await import('./lib/wallet/send.js');
    send.openSend({ recipient, chainId: 8453 });
  }, RECIPIENT);
  await expect(window.locator('#sidebar-send')).toBeVisible();
  await window.fill('#send-amount', '0.001');
  await window.click('#send-continue-btn');
  await expect(window.locator('#send-review-view')).toBeVisible();

  const warning = window.locator('#send-held-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText(
    "This payment will wait behind an earlier one that hasn't gone through yet: " +
      '0.25 ETH to 0x8335…2913 (nonce 7). Send that one again or raise its fee first, ' +
      'from Payments waiting.'
  );
  await shootBothThemes(window, 'send-held-warning');
});
