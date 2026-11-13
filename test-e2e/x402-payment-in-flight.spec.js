// x402 payment approval with a hardware account — once Pay is pressed the
// EIP-3009 authorization lives on the device and cannot be recalled.
//
// The payment card's screen hider *cancels* the payment (x402:reject for a
// subresource, x402:cancel for a paywall page, which also navigates the
// webview away). hideAllSubscreens() fires every hider, so any other
// approval surface opening mid-payment would force-cancel the detection in
// main while the user is still confirming that very payment on the device.
//
// Driven through the real renderer card: the main-process IPC it talks to is
// replaced for this app instance, and the approve handler is left hanging to
// hold the UI in the device-prompt state. The 402 is main's real detection,
// and the confirmation Pay mints (`wallet:confirm-signing`) is main's real
// one, approved in the window's approvals panel (freedom-core design 0011,
// APS-5) from main's record of the 402 and main's active account, the
// Ledger. The page prompts below are sent to the chrome's own screens,
// which main uses only with the panel off (the rollback): they still must
// not cancel a payment on the device.

const { test, expect, approvalsPage, decideInPanel } = require('./approvals-fixtures');

const LEDGER = {
  index: 1000000,
  name: 'Ledger 1',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};

const TX_PARAMS = {
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  value: '0',
  data: '0x095ea7b3' + '0'.repeat(56) + 'deadbeef' + 'f'.repeat(64),
};

// Main's send prompt for a page's transaction (freedom-core design 0011),
// as main sends it to the chrome, which renders it once the sidebar is free.
function sendTxPrompt(electronApp, handle) {
  return electronApp.evaluate(({ BrowserWindow }, { handle: h, ledger, tx }) => {
    const message = {
      handle: h,
      guest: 1,
      kind: 'eth.send',
      site: { key: 'https://swap.example', label: 'https://swap.example' },
      view: {
        account: { index: ledger.index, name: ledger.name, address: ledger.address, type: 'ledger' },
        chain: { id: 8453, name: 'Base', symbol: 'ETH' },
        tx,
        fee: { gasLimit: '21000', gasPrice: '1000000000', estimate: '21000000000000' },
        feeCheck: { maxCost: '21000000000000', comparable: true, ratio: '1', above: false, autoApprove: true },
        feeAskAgain: false,
        alwaysAllow: true,
      },
    };
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('page:prompt', message);
  }, { handle, ledger: LEDGER, tx: TX_PARAMS });
}

const USDC_ACCEPT = {
  accept: {
    scheme: 'exact',
    amount: '2500000',
    asset: '0xUSDC',
    network: 'base',
    payTo: '0x1111111111111111111111111111111111111111',
  },
  tuple: { amount: '2500000', chainId: 8453 },
  balanceKey: '8453:0xUSDC',
  asset: { symbol: 'USDC', decimals: 6 },
  balance: '5000000',
  fundable: true,
};

// A second fundable accept, which is what makes the card render the
// chooser radios.
const DAI_ACCEPT = {
  accept: {
    scheme: 'exact',
    amount: '3000000000000000000',
    asset: '0xDAI',
    network: 'base',
    payTo: '0x1111111111111111111111111111111111111111',
  },
  tuple: { amount: '3000000000000000000', chainId: 8453 },
  balanceKey: '8453:0xDAI',
  asset: { symbol: 'DAI', decimals: 18 },
  balance: '9000000000000000000',
  fundable: true,
};

// The 402's own entries, as the seller sends them and main records them;
// the card's view of each is the stub's (USDC_ACCEPT, DAI_ACCEPT).
const PAY_TO = '0x1111111111111111111111111111111111111111';
const USDC_ENTRY = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '2500000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: 'USD Coin', version: '2' },
};
const DAI_ENTRY = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '3000000000000000000',
  asset: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: 'Dai Stablecoin', version: '1' },
};
const PAYWALL_URL = 'https://pay.example/article';
// The id main's detector mints for a 402 on request `id`.
const detectionOf = (id) => `req-${id}`;

/** Main's real detector, on a 402 for `url` from tab `guestId` (request `id`). */
function detect402(electronApp, { guestId, id, url = PAYWALL_URL, entries = [USDC_ENTRY], resourceType = 'mainFrame' }) {
  return electronApp.evaluate(({ app }, args) => {
    // `require` isn't in scope inside evaluate; go through the main
    // module so we get the SAME intercept instance the app is running.
    const nodeRequire = process.mainModule.require.bind(process.mainModule);
    const intercept = nodeRequire(nodeRequire('path').join(app.getAppPath(), 'src/main/x402/intercept.js'));
    const requirements = { x402Version: 2, resource: { url: args.url }, accepts: args.entries };
    // Not awaited: for a subresource the detector holds the response open
    // until the user decides, exactly as it does in production.
    intercept.detectPaymentRequiredHandler({
      id: args.id,
      webContentsId: args.guestId,
      url: args.url,
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(requirements)).toString('base64')],
      },
      resourceType: args.resourceType,
    });
  }, { guestId, id, url, entries, resourceType });
}

/** Pay's confirmation, approved in the panel with main's view of the 402. */
async function approvePayInPanel(electronApp, amount = '2.5 USDC') {
  const panel = await approvalsPage(electronApp);
  await expect(panel.locator('#heading')).toHaveText('Payment Required');
  await expect(panel.locator('#body')).toContainText(amount);
  await expect(panel.locator('#body')).toContainText(LEDGER.address);
  await decideInPanel(electronApp, { panel });
}

function stubMainIpc(electronApp, ledger, accepts = [USDC_ACCEPT], detectionId = detectionOf(4101)) {
  return electronApp.evaluate(({ ipcMain }, { ledger, accepts, detectionId }) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('identity:get-status', () => ({ isUnlocked: true }));
    replace('wallet:get-derived-wallets', () => ({ success: true, wallets: [ledger] }));
    replace('dapp:get-permission', () => ({
      origin: 'https://pay.example',
      walletIndex: ledger.index,
      chainId: 8453,
    }));
    replace('x402:get-details', () => ({
      success: true,
      detectionId,
      url: 'https://pay.example/article',
      accepts,
      initialSelectionIndex: 0,
    }));
    replace('x402:get-all-permissions', () => ({ success: true, permissions: [] }));

    // Cancel paths must stay untouched while the device prompt is up.
    globalThis.__x402Cancels = { cancel: 0, reject: 0 };
    replace('x402:cancel', () => {
      globalThis.__x402Cancels.cancel += 1;
      return { success: true };
    });
    replace('x402:reject', () => {
      globalThis.__x402Cancels.reject += 1;
      return { success: true };
    });

    // Never settles on its own: this is the window where the device prompt
    // is up and the user is deciding.
    globalThis.__resolveX402Approve = null;
    globalThis.__x402ApproveCalls = [];
    replace('x402:approve', (_event, payload) => new Promise((resolve) => {
      globalThis.__x402ApproveCalls.push(payload);
      globalThis.__resolveX402Approve = resolve;
    }));
  }, { ledger, accepts, detectionId });
}

// Put the app on the Ledger account and raise a 402 through main's real
// detector, on the window's own tab: main mints a payment's confirmation
// only for the window that hosts its tab, from its own record of the 402.
// Returns that tab's webContents id.
async function openPaymentCard(electronApp, window, ledger, { id = 4101, entries = [USDC_ENTRY] } = {}) {
  await window.evaluate(async (ledger) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    walletState.derivedWallets = [ledger];
    walletState.activeWalletIndex = ledger.index;
  }, ledger);
  // The tab's webview has an id once it is attached and its DOM is ready.
  let guestId = null;
  await expect
    .poll(async () => {
      guestId = await window
        .evaluate(async () => {
          const tabs = await import('./lib/tabs.js');
          return tabs.getActiveWebview()?.getWebContentsId() ?? null;
        })
        .catch(() => null);
      return typeof guestId;
    })
    .toBe('number');
  await detect402(electronApp, { guestId, id, entries });
  return guestId;
}

// Main's active account is the Ledger, in its own wallet list: the panel
// shows the payment for it.
test.use({ vaultWallets: { wallets: [LEDGER], activeWalletIndex: LEDGER.index } });

function cancelCounts(electronApp) {
  return electronApp.evaluate(() => globalThis.__x402Cancels);
}

test('a dApp request mid-payment cannot cancel an in-flight Ledger payment', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, LEDGER);
  await openPaymentCard(electronApp, window, LEDGER);

  await expect(window.locator('#sidebar-x402-approval')).toBeVisible();
  await expect(window.locator('#x402-approval-amount')).toHaveText('2.5 USDC');
  await expect(window.locator('#x402-approval-approve')).toBeEnabled();
  await window.screenshot({ path: 'test-results/x402-ledger-before-pay.png' });

  await window.click('#x402-approval-approve');
  await approvePayInPanel(electronApp);

  // Device prompt is up: both ways out of the card are closed.
  await expect(window.locator('#x402-approval-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#x402-approval-reject')).toBeDisabled();
  await expect(window.locator('#x402-approval-back')).toBeDisabled();

  // A dApp request lands while the device is showing the payment: main's
  // prompt for it waits rather than firing hideAllSubscreens() — which would
  // run the card's hider and cancel the detection out from under the device.
  await sendTxPrompt(electronApp, 'a'.repeat(64));
  // Several of the waiting prompt's retries pass.
  await window.waitForTimeout(1000);

  expect(await cancelCounts(electronApp)).toEqual({ cancel: 0, reject: 0 });
  await expect(window.locator('#sidebar-dapp-tx')).toBeHidden();
  await expect(window.locator('#sidebar-x402-approval')).toBeVisible();
  await expect(window.locator('#x402-approval-url')).toHaveText('https://pay.example/article');
  await expect(window.locator('#x402-approval-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#x402-approval-reject')).toBeDisabled();
  await expect(window.locator('#x402-approval-back')).toBeDisabled();
  await window.screenshot({ path: 'test-results/x402-ledger-in-flight-protected.png' });

  // The device confirms: the payment — and only it — settles, and the card
  // releases the sidebar for the next request.
  await electronApp.evaluate(() => {
    globalThis.__resolveX402Approve({ success: true });
  });
  await expect(window.locator('#sidebar-x402-approval')).toBeHidden();
  expect(await cancelCounts(electronApp)).toEqual({ cancel: 0, reject: 0 });

  await sendTxPrompt(electronApp, 'b'.repeat(64));
  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
});

// A multi-accept paywall keeps the chooser radios on screen while the
// authorization is on the device. Flipping one re-renders the card, and the
// re-render used to re-derive Pay as enabled — offering a second, concurrent
// device signature for a different accept, whose failure would then release
// the lock the first one still holds. The card must stay frozen instead.
test('flipping the accept chooser mid-payment cannot re-arm Pay', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, LEDGER, [USDC_ACCEPT, DAI_ACCEPT], detectionOf(4102));
  const guestId = await openPaymentCard(electronApp, window, LEDGER, { id: 4102, entries: [USDC_ENTRY, DAI_ENTRY] });

  await expect(window.locator('#sidebar-x402-approval')).toBeVisible();
  await expect(window.locator('#x402-approval-chooser')).toBeVisible();
  await expect(window.locator('#x402-approval-chooser-options .x402-chooser-row')).toHaveCount(2);
  await expect(window.locator('#x402-approval-approve')).toBeEnabled();

  await window.click('#x402-approval-approve');
  await approvePayInPanel(electronApp);
  await expect(window.locator('#x402-approval-approve')).toHaveText('Confirm on your Ledger…');

  // The user pokes the other option while the device prompt is up.
  await window.click('#x402-approval-chooser-options input[value="1"]');

  await expect(window.locator('#x402-approval-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#x402-approval-approve')).toBeDisabled();
  await expect(window.locator('#x402-approval-reject')).toBeDisabled();
  await expect(window.locator('#x402-approval-back')).toBeDisabled();
  // …and the radio snaps back to the accept that is on the device, so the
  // card never shows a selection the payment doesn't match.
  await expect(window.locator('#x402-approval-chooser-options input[value="0"]')).toBeChecked();
  await expect(window.locator('#x402-approval-chooser-options input[value="1"]')).not.toBeChecked();
  await expect(window.locator('#x402-approval-amount')).toHaveText('2.5 USDC');
  await window.screenshot({ path: 'test-results/x402-chooser-flip-in-flight.png' });

  // Even a click that bypasses the disabled button reaches no second sign.
  await window.evaluate(() => {
    document.getElementById('x402-approval-approve').dispatchEvent(new Event('click'));
  });
  const approveCalls = await electronApp.evaluate(() => globalThis.__x402ApproveCalls);
  expect(approveCalls).toHaveLength(1);
  expect(approveCalls[0].selectedAcceptIndex).toBe(0);

  // The one approval carries main's token for exactly that payment, as main
  // recorded it: the entry on the device, not the one the radio was flipped
  // to, and only once. Checked with main's own confirmation store.
  const spend = (payment) => electronApp.evaluate(({ app }, { confirmation, payment }) => {
    const nodeRequire = process.mainModule.require.bind(process.mainModule);
    const path = nodeRequire('path');
    const confirmations = nodeRequire(path.join(app.getAppPath(), 'src/main/wallet/signing-confirmation.js'));
    const { getActiveWalletIndex } = nodeRequire(path.join(app.getAppPath(), 'src/main/identity-manager.js'));
    try {
      confirmations.consumeConfirmation(confirmation, 'x402-payment', getActiveWalletIndex(), payment);
      return 'spent';
    } catch (err) {
      return err.message;
    }
  }, { confirmation: approveCalls[0].confirmation, payment });
  const shown = {
    webContentsId: guestId,
    detectionId: detectionOf(4102),
    url: PAYWALL_URL,
    acceptIndex: 0,
    accept: USDC_ENTRY,
    grant: null,
  };
  expect(typeof approveCalls[0].confirmation).toBe('string');
  expect(await spend(shown)).toBe('spent');
  expect(await spend(shown)).toMatch(/already used/);

  // The device confirms the one payment that was ever sent to it.
  await electronApp.evaluate(() => {
    globalThis.__resolveX402Approve({ success: true });
  });
  await expect(window.locator('#sidebar-x402-approval')).toBeHidden();
  expect(await cancelCounts(electronApp)).toEqual({ cancel: 0, reject: 0 });
});

// Signing without hosted clear-signing resolution means a factory-default
// Ledger (blind signing off) refuses every contract call — including the
// EIP-3009 authorization behind an x402 payment. The instruction the user
// gets has to name the setting to change; "reconnect the device" is a dead
// end. The message comes from the real main-process mapper.
test('a blind-signing refusal tells the user which device setting to enable', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, LEDGER);
  await electronApp.evaluate(({ ipcMain, app }) => {
    const nodeRequire = process.mainModule.require.bind(process.mainModule);
    const { mapLedgerError } = nodeRequire(
      nodeRequire('path').join(app.getAppPath(), 'src/main/wallet/ledger/errors.js')
    );
    // Exactly what the Ethereum app answers when it will not sign data it
    // cannot decode.
    const mapped = mapLedgerError(Object.assign(new Error('status 6a80'), { statusCode: 0x6a80 }));
    ipcMain.removeHandler('x402:approve');
    ipcMain.handle('x402:approve', () => ({ success: false, error: mapped.message, code: mapped.code }));
  });
  await openPaymentCard(electronApp, window, LEDGER);

  await expect(window.locator('#sidebar-x402-approval')).toBeVisible();
  await window.click('#x402-approval-approve');
  await approvePayInPanel(electronApp);

  await expect(window.locator('#x402-approval-error')).toBeVisible();
  await expect(window.locator('#x402-approval-error')).toContainText('Blind signing');
  await expect(window.locator('#x402-approval-error')).not.toContainText('Reconnect');
  // The card is usable again: fix the setting on the device and retry.
  await expect(window.locator('#x402-approval-approve')).toHaveText('Pay');
  await expect(window.locator('#x402-approval-approve')).toBeEnabled();
  await expect(window.locator('#x402-approval-reject')).toBeEnabled();
  await window.screenshot({ path: 'test-results/x402-blind-signing-error.png' });
});

// The browser tab strip is chrome the signature lock deliberately does not
// cover, so the paying tab can be closed while the device prompt is up. The
// subresource card's only release is the x402:approval-result event, so if
// that event is addressed through the (now dead) paying tab the sidebar
// keeps the lock for the rest of the session: the card freezes, the X and
// the toolbar toggle stay disabled, and every dApp request is refused
// -32002. Driven through the REAL detector + the REAL webContents
// 'destroyed' handler against a real tab; only get-details/approve are
// stubbed (the sign itself needs a device).
test('closing the paying tab mid-payment releases the sidebar instead of bricking it', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, LEDGER);
  // The card carries the detectionId get-details hands it, so the stub has
  // to report the id the real detector below mints (`req-<request id>`).
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('x402:get-details');
    ipcMain.handle('x402:get-details', () => ({
      success: true,
      detectionId: 'req-4242',
      url: 'https://pay.example/segment/0',
      accepts: [{
        accept: {
          scheme: 'exact',
          amount: '2500000',
          asset: '0xUSDC',
          network: 'base',
          payTo: '0x1111111111111111111111111111111111111111',
        },
        tuple: { amount: '2500000', chainId: 8453 },
        balanceKey: '8453:0xUSDC',
        asset: { symbol: 'USDC', decimals: 6 },
        balance: '5000000',
        fundable: true,
      }],
      initialSelectionIndex: 0,
    }));
  });
  await window.evaluate(async (ledger) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    walletState.derivedWallets = [ledger];
    walletState.activeWalletIndex = ledger.index;
  }, LEDGER);

  // A second tab is the paying tab, so closing it doesn't close the window.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  const guestId = await window.evaluate(async () => {
    const tabs = await import('./lib/tabs.js');
    return tabs.getActiveWebview()?.getWebContentsId() ?? null;
  });
  expect(typeof guestId).toBe('number');

  // Real 402 detection on that tab: mints the detectionId, stores the
  // detection and fires x402:approval-needed through the real sendToHost.
  await electronApp.evaluate(({ app }, guestId) => {
    // `require` isn't in scope inside evaluate; go through the main
    // module so we get the SAME intercept instance the app is running.
    const nodeRequire = process.mainModule.require.bind(process.mainModule);
    const intercept = nodeRequire(
      nodeRequire('path').join(app.getAppPath(), 'src/main/x402/intercept.js')
    );
    const requirements = {
      x402Version: 2,
      resource: { url: 'https://pay.example/segment/0' },
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '2500000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      }],
    };
    // Not awaited: the detector holds the response open until the user
    // decides, exactly as it does in production.
    intercept.detectPaymentRequiredHandler({
      id: 4242,
      webContentsId: guestId,
      url: 'https://pay.example/segment/0',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(requirements)).toString('base64')],
      },
      resourceType: 'xhr',
    });
  }, guestId);

  await expect(window.locator('#sidebar-x402-approval')).toBeVisible();
  await window.click('#x402-approval-approve');
  await approvePayInPanel(electronApp);

  // Device prompt is up and the sidebar is locked to it.
  await expect(window.locator('#x402-approval-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#x402-approval-reject')).toBeDisabled();
  await expect(window.locator('#sidebar-close')).toBeDisabled();
  await window.screenshot({ path: 'test-results/x402-tab-close-before.png' });

  // Main-side shape of "the authorization has left for the device": the
  // approval entry is settled and gone, the sign is outstanding.
  await electronApp.evaluate(({ app }) => {
    const nodeRequire = process.mainModule.require.bind(process.mainModule);
    nodeRequire(
      nodeRequire('path').join(app.getAppPath(), 'src/main/x402/intercept.js')
    ).clearAllPendingApprovals();
  });

  // User closes the paying tab. Real destroy → real cleanup → the card is
  // told its request is gone, over a channel that doesn't need the tab.
  await window.locator('[data-test="tab"][data-tab-id="2"] [data-test="tab-close"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(1);

  await expect(window.locator('#sidebar-x402-approval')).toBeHidden();
  await expect(window.locator('#sidebar-close')).toBeEnabled();
  await expect(window.locator('#wallet-toggle-btn')).toBeEnabled();
  expect(await cancelCounts(electronApp)).toEqual({ cancel: 0, reject: 0 });

  // Acceptance: the wallet works again — a dApp request's prompt shows
  // rather than waiting, and the sidebar can be closed normally.
  await sendTxPrompt(electronApp, 'c'.repeat(64));
  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
  await window.screenshot({ path: 'test-results/x402-tab-close-after.png' });
});
