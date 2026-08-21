// The sidebar chrome — the header X, the tab bar, the toolbar toggle — sits
// above whatever approval screen is up and is *not* an approval surface, so
// it used to sit outside the signature lock entirely. With a device prompt
// live ("Confirm on your Ledger", Back/Reject disabled) a click on the X
// directly above it collapsed the panel over an un-recallable confirmation:
// the user approves on the device to make it go away and the transaction
// broadcasts into a hidden screen. The same click fires 'sidebar-closed',
// whose closeAllSubscreens() cascade un-hides the identity view — reopening
// the panel then showed an interactive identity view stacked on the pending
// send, with its own unguarded Receive / Settings / Ledger openers.
//
// Driven through the real renderer, with the main-process IPC replaced for
// this app instance and the send handler left hanging to hold the UI in the
// device-prompt state.

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

// Opens the sidebar on a Ledger account and drives the send screen to the
// review step, exactly as a user tipping from a page would arrive there.
async function openSendOnLedger(window) {
  await window.evaluate(async ({ ledger, recipient }) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const sidebar = await import('./lib/sidebar.js');
    const send = await import('./lib/wallet/send.js');
    sidebar.open();
    // The harness profile has no identity, so the setup CTA is up; the real
    // app shows the identity view here. Hide it so the screenshots show what
    // a user with a wallet would actually see.
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
    walletState.currentBalances = {
      'base-native': { formatted: '1.0', symbol: 'ETH' },
    };

    send.openSend({ recipient, chainId: 8453 });
  }, { ledger: LEDGER, recipient: RECIPIENT });

  await expect(window.locator('#sidebar-send')).toBeVisible();
  await window.fill('#send-amount', '0.001');
  await window.click('#send-continue-btn');
  await expect(window.locator('#send-review-view')).toBeVisible();
}

test('sidebar chrome cannot collapse or repaint over a live device confirmation', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp);
  await openSendOnLedger(window);

  await window.click('#send-confirm-btn');

  // The device prompt is up. The chrome above it is dead too, not just Back.
  await expect(window.locator('#send-pending-view')).toBeVisible();
  await expect(window.locator('#send-pending-view .send-pending-title'))
    .toHaveText('Confirm on your Ledger');
  await expect(window.locator('#send-back')).toBeDisabled();
  await expect(window.locator('#sidebar-close')).toBeDisabled();
  await expect(window.locator('#wallet-toggle-btn')).toBeDisabled();
  await expect(window.locator('.sidebar-tab[data-tab="wallet"]')).toBeDisabled();
  await window.screenshot({ path: 'test-results/sidebar-chrome-locked-in-flight.png' });

  // The user clicks the X anyway (a real click; the browser drops it on a
  // disabled button, and the handler refuses regardless).
  await window.evaluate(() => {
    document.getElementById('sidebar-close').click();
    document.getElementById('wallet-toggle-btn').click();
    document.querySelector('.sidebar-tab[data-tab="settings"]').click();
  });

  // The panel is still open on the confirmation, and the identity view was
  // not un-hidden underneath it by the closeAllSubscreens() cascade.
  await expect(window.locator('#sidebar')).not.toHaveClass(/collapsed/);
  await expect(window.locator('#sidebar-send')).toBeVisible();
  await expect(window.locator('#send-pending-view')).toBeVisible();
  await expect(window.locator('#sidebar-identity')).toBeHidden();
  await window.screenshot({ path: 'test-results/sidebar-chrome-x-refused.png' });

  // The keyboard route to the same collapse.
  await window.keyboard.press('Control+Shift+W');
  await expect(window.locator('#sidebar')).not.toHaveClass(/collapsed/);
  await expect(window.locator('#send-pending-view')).toBeVisible();

  // Direct openers reachable from the identity view take the sidebar over
  // without going through hideAllSubscreens(), so they check the lock too.
  const refused = await window.evaluate(async () => {
    const receive = await import('./lib/wallet/receive.js');
    const connectLedger = await import('./lib/wallet/connect-ledger.js');
    await receive.openReceive();
    await connectLedger.openConnectLedger();
    return {
      receiveHidden: document.getElementById('sidebar-receive').classList.contains('hidden'),
      ledgerHidden: document.getElementById('sidebar-connect-ledger').classList.contains('hidden'),
    };
  });
  expect(refused).toEqual({ receiveHidden: true, ledgerHidden: true });
  await expect(window.locator('#send-pending-view')).toBeVisible();

  // The device approves: the send reports success on a screen the user can
  // actually see, and the chrome comes back to life.
  await electronApp.evaluate(() => {
    globalThis.__resolveLedgerSend({
      success: true,
      hash: '0xfeedface',
      explorerUrl: 'https://basescan.org/tx/0xfeedface',
      recorded: true,
    });
  });
  await expect(window.locator('#send-success-view')).toBeVisible();
  await expect(window.locator('#sidebar')).not.toHaveClass(/collapsed/);
  await expect(window.locator('#sidebar-close')).toBeEnabled();
  await expect(window.locator('#wallet-toggle-btn')).toBeEnabled();
  await expect(window.locator('.sidebar-tab[data-tab="wallet"]')).toBeEnabled();
  await window.screenshot({ path: 'test-results/sidebar-chrome-unlocked-after-send.png' });

  // And the X works again now that there is nothing to protect.
  await window.click('#sidebar-close');
  await expect(window.locator('#sidebar')).toHaveClass(/collapsed/);
});
