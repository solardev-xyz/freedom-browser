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
// hanging to hold the UI in the device-prompt state.

const { test, expect } = require('./fixtures');

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
    replace('dapp:get-permission', () => ({
      origin: 'https://swap.example',
      walletIndex: 1000000,
      chainId: 8453,
    }));
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

test('a dApp request cannot take the sidebar from an in-flight send confirmation', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp);
  await openSendOnLedger(window, RECIPIENT);

  await window.click('#send-confirm-btn');

  // The device prompt is up: the screen says so and Back is closed off.
  await expect(window.locator('#send-pending-view')).toBeVisible();
  await expect(window.locator('#send-pending-view .send-pending-title'))
    .toHaveText('Confirm on your Ledger');
  await expect(window.locator('#send-back')).toBeDisabled();
  await window.screenshot({ path: 'test-results/send-ledger-in-flight.png' });

  // The page now asks for a signature and for accounts while the device
  // prompt for the send is still up.
  await window.evaluate(async () => {
    const dappSign = await import('./lib/wallet/dapp-sign.js');
    const dappConnect = await import('./lib/wallet/dapp-connect.js');
    window.__otherSurfaces = {};
    dappSign
      .showDappSignApproval({}, 'https://swap.example', 'personal_sign', ['0xdeadbeef', '0xledger'])
      .then(
        (sig) => { window.__otherSurfaces.sign = `resolved:${sig}`; },
        (err) => { window.__otherSurfaces.sign = `rejected:${err.code || err.message}`; }
      );
    await new Promise((resolve, reject) => {
      dappConnect.showDappConnect('https://swap.example', 'https://swap.example', resolve, reject, {});
    }).then(
      () => { window.__otherSurfaces.connect = 'resolved'; },
      (err) => { window.__otherSurfaces.connect = `rejected:${err.code || err.message}`; }
    );
  });

  await expect.poll(() => window.evaluate(() => window.__otherSurfaces?.sign)).toBe('rejected:-32002');
  await expect.poll(() => window.evaluate(() => window.__otherSurfaces?.connect)).toBe('rejected:-32002');

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
  await window.screenshot({ path: 'test-results/send-ledger-success-visible.png' });
});

// The other direction: an `ethereum:` tip link is page-reachable and routes
// straight into the send screen, so it must not paint over a live device
// confirmation owned by another surface either.
test('the send screen refuses to open over another surface\'s device confirmation', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp);
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('wallet:dapp-send-transaction');
    ipcMain.handle('wallet:dapp-send-transaction', () => new Promise(() => {}));
  });

  // A dApp transaction is waiting on the device.
  await window.evaluate(async ({ ledger }) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const dappTx = await import('./lib/wallet/dapp-tx.js');
    walletState.viewMode = 'identity';
    walletState.fullAddresses.wallet = ledger.address;
    walletState.derivedWallets = [ledger];
    walletState.activeWalletIndex = ledger.index;
    dappTx.showDappTxApproval({}, 'https://swap.example', {
      to: '0x4200000000000000000000000000000000000006',
      value: '0x0',
    }).catch(() => {});
  }, { ledger: LEDGER });

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
