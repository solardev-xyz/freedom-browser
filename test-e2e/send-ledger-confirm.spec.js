// Manual send with a hardware account — once Confirm is pressed the
// signature lives on the device and cannot be recalled, so the send screen
// owns the sidebar until the device answers. Every other approval surface
// takes the sidebar over via hideAllSubscreens(), so without the shared
// lock a dApp request (personal_sign, a permissionless eth_requestAccounts)
// paints over "Confirm on your Ledger" with Reject/Sign fully enabled: the
// user rejects what they believe the device is showing, then clears the
// still-live device prompt and the send broadcasts with no visible feedback.
//
// Driven through the real renderer screen: the main-process IPC the screen
// talks to is replaced for this app instance, and the send handler is left
// hanging to hold the UI in the device-prompt state. The send's own
// confirmation is decided in the window's approvals panel (freedom-core
// design 0011), which needs the Ledger account in main's wallet list. The
// page prompts below are sent to the chrome's own screens, which main uses
// only with the panel off (FREEDOM_APPROVALS_DOCUMENT=0, the rollback): they
// still must not take the sidebar from a live device confirmation.

const { test, expect, approvalsPage, decideInPanel } = require('./approvals-fixtures');

const LEDGER = {
  index: 1000000,
  name: 'Ledger 1',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};

const RECIPIENT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function stubMainIpc(electronApp) {
  return electronApp.evaluate(({ ipcMain }) => {
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
    replace('wallet:get-derived-wallets', () => ({
      success: true,
      wallets: [{
        index: 1000000,
        name: 'Ledger 1',
        address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        type: 'ledger',
      }],
    }));
    // Never settles on its own: this is the window where the device prompt
    // is up and the user is deciding.
    globalThis.__resolveLedgerSend = null;
    replace('wallet:send-transaction', () => new Promise((resolve) => {
      globalThis.__resolveLedgerSend = resolve;
    }));
  });
}

const SITE = { key: 'https://swap.example', label: 'https://swap.example' };

// A prompt main shows the chrome for a page's request, as main sends it.
function sendPagePrompt(electronApp, prompt) {
  return electronApp.evaluate(({ BrowserWindow }, message) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('page:prompt', message);
  }, prompt);
}

// Opens the send screen on a Ledger account with a recipient and amount
// pre-filled, exactly as the `ethereum:` tip-link entry point does.
async function openSendOnLedger(window, recipient) {
  await window.evaluate(async ({ ledger, recipient }) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const sidebar = await import('./lib/sidebar.js');
    const send = await import('./lib/wallet/send.js');
    sidebar.open();
    // The harness profile has no identity, so the setup CTA is up; the real
    // app shows the identity view here. Hide it so the screenshots show
    // what a user with a wallet would actually see.
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');

    walletState.viewMode = 'identity';
    walletState.fullAddresses.wallet = ledger.address;
    // The account type is what makes the screen skip the vault-unlock gate
    // and wait on the device instead of the network.
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
    walletState.currentBalances = {
      'base-native': { formatted: '1.0', symbol: 'ETH' },
    };

    send.openSend({ recipient, chainId: 8453 });
  }, { ledger: LEDGER, recipient });

  await expect(window.locator('#sidebar-send')).toBeVisible();
  await window.fill('#send-amount', '0.001');
  await window.click('#send-continue-btn');
  await expect(window.locator('#send-review-view')).toBeVisible();
}

test.describe('with the Ledger account in main\'s wallet list', () => {
  test.use({ vaultWallets: { wallets: [LEDGER], activeWalletIndex: LEDGER.index } });

  test('a dApp request cannot take the sidebar from an in-flight send confirmation', async ({
    electronApp,
    window,
  }) => {
    await stubMainIpc(electronApp);
    await openSendOnLedger(window, RECIPIENT);

    await window.click('#send-confirm-btn');
    // Approved in the panel, with main's view of the send.
    const panel = await approvalsPage(electronApp);
    await expect(panel.locator('#heading')).toHaveText('Confirm Send');
    await expect(panel.locator('#body')).toContainText(LEDGER.address);
    await decideInPanel(electronApp, { panel });

    // The device prompt is up: the screen says so and Back is closed off.
    await expect(window.locator('#send-pending-view')).toBeVisible();
    await expect(window.locator('#send-pending-view .send-pending-title'))
      .toHaveText('Confirm on your Ledger');
    await expect(window.locator('#send-back')).toBeDisabled();
    await window.screenshot({ path: 'test-results/send-ledger-in-flight.png' });

    // Main now shows a page's signature, then its connect, while the device
    // prompt for the send is still up: each waits for the sidebar.
    await sendPagePrompt(electronApp, {
      handle: 'a'.repeat(64),
      guest: 1,
      kind: 'eth.sign',
      site: SITE,
      view: {
        method: 'personal_sign',
        message: { hex: '0xdeadbeef', rawHash: false },
        account: { index: LEDGER.index, type: 'ledger' },
        chain: { id: 8453 },
      },
    });
    await sendPagePrompt(electronApp, {
      handle: 'b'.repeat(64),
      guest: 1,
      kind: 'eth.connect',
      site: SITE,
      view: { accounts: [LEDGER], defaultIndex: LEDGER.index },
    });
    // Several of the waiting prompts' retries pass.
    await window.waitForTimeout(1000);

    // Neither screen took the sidebar; the send confirmation is untouched.
    await expect(window.locator('#sidebar-dapp-sign')).toBeHidden();
    await expect(window.locator('#sidebar-dapp-connect')).toBeHidden();
    await expect(window.locator('#sidebar-send')).toBeVisible();
    await expect(window.locator('#send-pending-view')).toBeVisible();
    await expect(window.locator('#send-back')).toBeDisabled();
    await window.screenshot({ path: 'test-results/send-ledger-dapp-request-refused.png' });

    // A stray Back click (or a tab switch / sidebar close, which both land on
    // closeSend) must not tear the screen down either.
    await window.evaluate(async () => {
      document.getElementById('send-back').click();
      const send = await import('./lib/wallet/send.js');
      send.closeSend();
    });
    await expect(window.locator('#sidebar-send')).toBeVisible();
    await expect(window.locator('#send-pending-view')).toBeVisible();

    // The device approves: the send reports success on its own screen, where
    // the user can actually see it.
    await electronApp.evaluate(() => {
      globalThis.__resolveLedgerSend({
        success: true,
        hash: '0xfeedface',
        explorerUrl: 'https://basescan.org/tx/0xfeedface',
        recorded: true,
      });
    });
    await expect(window.locator('#send-success-view')).toBeVisible();
    await expect(window.locator('#sidebar-send')).toBeVisible();
    await expect(window.locator('#send-back')).toBeEnabled();
    // The page's prompt still waits: the sidebar isn't back on the wallet.
    await window.waitForTimeout(600);
    await expect(window.locator('#sidebar-dapp-connect')).toBeHidden();
    await expect(window.locator('#sidebar-send')).toBeVisible();
    await window.screenshot({ path: 'test-results/send-ledger-success-visible.png' });
  });
});

// The other direction: an `ethereum:` tip link is page-reachable and routes
// straight into the send screen, so it must not paint over a live device
// confirmation owned by another surface either.
test('the send screen refuses to open over another surface\'s device confirmation', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp);
  // Main's answer to the approval never comes: this is the window where the
  // device signs the page's send (main signs it, after the decision).
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('page:decide');
    ipcMain.handle('page:decide', () => new Promise(() => {}));
  });

  // A page's transaction, main's send prompt (`eth.send`) on screen.
  await window.evaluate(async ({ ledger, site }) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const { pagePromptRenderer } = await import('./lib/page-prompt-renderers.js');
    walletState.viewMode = 'identity';
    walletState.fullAddresses.wallet = ledger.address;
    walletState.derivedWallets = [ledger];
    walletState.activeWalletIndex = ledger.index;
    pagePromptRenderer('eth.send').show({
      handle: 'c'.repeat(64),
      guest: 1,
      kind: 'eth.send',
      site,
      view: {
        account: { index: ledger.index, name: ledger.name, address: ledger.address, type: 'ledger' },
        chain: { id: 8453, name: 'Base', symbol: 'ETH' },
        tx: { to: '0x4200000000000000000000000000000000000006', value: '0', data: '0x' },
        fee: { gasLimit: '21000', gasPrice: '1000000000', estimate: '21000000000000' },
        feeCheck: { maxCost: '21000000000000', comparable: true, ratio: '1', above: false, autoApprove: true },
        feeAskAgain: false,
        alwaysAllow: false,
      },
    });
  }, { ledger: LEDGER, site: SITE });

  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
  await window.click('#dapp-tx-approve');
  await expect(window.locator('#dapp-tx-approve')).toHaveText('Confirm on your Ledger…');

  // The page follows a tip link into the send flow.
  await window.evaluate(async (recipient) => {
    const send = await import('./lib/wallet/send.js');
    send.openSend({ recipient, chainId: 8453 });
  }, RECIPIENT);

  await expect(window.locator('#sidebar-send')).toBeHidden();
  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
  await expect(window.locator('#dapp-tx-approve')).toHaveText('Confirm on your Ledger…');
  await window.screenshot({ path: 'test-results/send-open-refused-during-dapp-confirm.png' });
});
