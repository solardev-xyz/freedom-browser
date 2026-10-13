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
  return electronApp.evaluate(
    ({ ipcMain }, { intents, fees }) => {
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
    },
    { intents, fees: REPLACEMENT_FEES }
  );
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
        chainId: 8453,
        symbol: 'ETH',
        name: 'Ether',
        decimals: 18,
        address: null,
        builtin: true,
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

const rowOf = (window, intent) =>
  window.locator(`#held-payments-list [data-intent="${intent.intentId}"]`);

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
    .poll(() => row.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth - 8))
    .toBe(true);
  await shootBothThemes(window, 'held-payments-row');

  await row.click();
  await expect(window.locator('#sidebar-held-payments')).toBeVisible();
  await expect(window.locator('#sidebar-held-payments .subscreen-title')).toHaveText(
    'Payments Waiting'
  );
  // Oldest nonce first, each saying what it pays and why it waits.
  await expect(window.locator('#held-payments-list .held-payment-row')).toHaveCount(3);
  await expect(window.locator('#held-payments-list .safe-signing-row-name').first()).toHaveText(
    '0.25 ETH to 0x8335…2913'
  );
  await expect(rowOf(window, UNDERPRICED)).toContainText(
    'Ledger 1 · Base · nonce 7 · 12 minutes ago'
  );
  await expect(rowOf(window, UNDERPRICED)).toContainText(
    'The network refused it: transaction underpriced'
  );
  await expect(rowOf(window, DAPP)).toContainText('Requested by https://app.example');
  await expect(rowOf(window, DAPP)).toContainText('Not sent; nothing left this computer');
  await expect(rowOf(window, STUCK)).toContainText('Sent, waiting for confirmation');
  await expect(rowOf(window, UNDERPRICED).locator('[data-action="replace"]')).toHaveText(
    'Raise the fee'
  );
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

// #710 review: the list is fetched before it opens. A reply that arrives
// after a Ledger approval took the sidebar must not paint the list over the
// live device prompt.
test('a delayed opening of the list stays shut under a live device approval', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, [STUCK]);
  await electronApp.evaluate(
    ({ ipcMain }, intents) => {
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };
      globalThis.__holdNextList = false;
      replace('wallet:intents-list', () => {
        if (!globalThis.__holdNextList) return { success: true, intents };
        globalThis.__holdNextList = false;
        return new Promise((resolve) => {
          globalThis.__releaseList = () => resolve({ success: true, intents });
        });
      });
      // The device prompt: never answers on its own.
      replace(
        'wallet:send-transaction',
        () =>
          new Promise((resolve) => {
            globalThis.__answerDevice = resolve;
          })
      );
    },
    [STUCK]
  );
  await showIdentity(window);

  await electronApp.evaluate(() => {
    globalThis.__holdNextList = true;
  });
  await window.click('#held-payments-row');
  await expect.poll(() => electronApp.evaluate(() => Boolean(globalThis.__releaseList))).toBe(true);

  // Meanwhile a send starts its Ledger approval.
  await window.evaluate(async (recipient) => {
    const send = await import('./lib/wallet/send.js');
    send.openSend({ recipient, chainId: 8453 });
  }, RECIPIENT);
  await window.fill('#send-amount', '0.001');
  await window.click('#send-continue-btn');
  await expect(window.locator('#send-review-view')).toBeVisible();
  await window.click('#send-confirm-btn');
  await expect(window.locator('#send-pending-view')).toBeVisible();
  const inFlight = () =>
    window.evaluate(async () =>
      (await import('./lib/wallet/signature-flight.js')).isSignatureInFlight()
    );
  await expect.poll(inFlight).toBe(true);

  await electronApp.evaluate(() => globalThis.__releaseList());
  // Give the late reply its chance to paint.
  await window.waitForTimeout(300);
  await expect(window.locator('#sidebar-held-payments')).toBeHidden();
  await expect(window.locator('#sidebar-send')).toBeVisible();
  expect(await inFlight()).toBe(true);

  await electronApp.evaluate(() =>
    globalThis.__answerDevice({ success: false, error: 'Rejected on the Ledger' })
  );
});

test('a primary button keeps its fill when hovered, in both themes', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, [UNDERPRICED]);
  await showIdentity(window);
  await window.click('#held-payments-row');
  await rowOf(window, UNDERPRICED).locator('[data-action="replace"]').click();
  const confirm = rowOf(window, UNDERPRICED).locator('[data-action="confirm-replace"]');
  const paint = () =>
    confirm.evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, color: style.color };
    });
  // WCAG relative luminance contrast of two rgb() colors.
  const contrast = (a, b) => {
    const lum = (rgb) => {
      const [r, g, b] = rgb
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((c) => {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const theme of ['dark', 'light']) {
    await setTheme(window, theme);
    await window.mouse.move(0, 0);
    const rest = await paint();
    await confirm.hover();
    const hovered = await paint();
    expect({ theme, background: hovered.background }).toEqual({
      theme,
      background: rest.background,
    });
    // An opaque fill: no translucent overlay under white text.
    expect(hovered.background).toMatch(/^rgb\(/);
    // No worse than the app's own primary button (Send's Confirm), and
    // AA for normal text in the light theme. (The dark theme's accent
    // buttons are white on #8ab4f8 throughout the app.)
    const reference = await window.evaluate(() => {
      const style = getComputedStyle(document.getElementById('send-confirm-btn'));
      return { background: style.backgroundColor, color: style.color };
    });
    expect(contrast(hovered.color, hovered.background)).toBeGreaterThanOrEqual(
      contrast(reference.color, reference.background) - 0.01
    );
    if (theme === 'light') {
      expect(contrast(hovered.color, hovered.background)).toBeGreaterThanOrEqual(4.5);
    }
  }
  await setTheme(window, 'dark');
});
