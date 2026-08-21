// dApp transaction approval with a hardware account — once Confirm is
// pressed the signature lives on the device and cannot be recalled, so
// Reject and Back must stop being a way out: settling the dApp promise
// with 4001 behind an in-flight signature would tell the site the user
// declined while the transaction still broadcasts (and would still install
// the "always allow" rule when the continuation resumed).
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

const TX_PARAMS = {
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  value: '0',
  // approve(address,uint256) — a contract call, so the auto-approve row shows.
  data: '0x095ea7b3' + '0'.repeat(56) + 'deadbeef' + 'f'.repeat(64),
};

function stubMainIpc(electronApp, ledger) {
  return electronApp.evaluate(({ ipcMain }, ledger) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('dapp:get-permission', () => ({
      origin: 'https://swap.example',
      walletIndex: ledger.index,
      chainId: 8453,
    }));
    replace('wallet:get-derived-wallets', () => ({ success: true, wallets: [ledger] }));
    replace('wallet:estimate-gas', () => ({ success: true, gasLimit: '21000' }));
    replace('wallet:get-gas-price', () => ({
      success: true,
      type: 'legacy',
      gasPrice: '1000000000',
      effectiveGasPrice: '1000000000',
    }));
    replace('networks:get-chains', () => ({
      success: true,
      chains: { 8453: { chainId: 8453, name: 'Base', nativeSymbol: 'ETH' } },
    }));
    replace('dapp:add-transaction-auto-approve', () => ({ success: true }));
    replace('identity:get-status', () => ({ isUnlocked: true }));
    // Never settles on its own: this is the window where the device prompt
    // is up and the user is deciding.
    globalThis.__resolveLedgerSend = null;
    replace('wallet:dapp-send-transaction', () => new Promise((resolve) => {
      globalThis.__resolveLedgerSend = resolve;
    }));
  }, ledger);
}

// Opens an approval screen and stashes its settled state on
// `window.__dappTxSettled[key]`, so a test can watch two requests at once.
function requestApproval(window, key, txParams) {
  return window.evaluate(async ({ ledger, key, txParams }) => {
    const dappTx = await import('./lib/wallet/dapp-tx.js');
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    // The account type is what makes the screen skip the vault-unlock gate.
    walletState.derivedWallets = [ledger];

    window.__dappTxSettled = window.__dappTxSettled || {};
    window.__dappTxSettled[key] = 'pending';
    dappTx.showDappTxApproval({}, 'https://swap.example', txParams).then(
      (hash) => { window.__dappTxSettled[key] = `resolved:${hash}`; },
      (err) => { window.__dappTxSettled[key] = `rejected:${err.code || err.message}`; }
    );
  }, { ledger: LEDGER, key, txParams });
}

function settledState(window, key) {
  return window.evaluate((key) => window.__dappTxSettled[key], key);
}

test('reject and back are inert while a Ledger confirmation is in flight', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, LEDGER);
  await requestApproval(window, 'a', TX_PARAMS);

  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
  await expect(window.locator('#dapp-tx-approve')).toBeEnabled();
  await expect(window.locator('#dapp-tx-reject')).toBeEnabled();
  await window.screenshot({ path: 'test-results/dapp-tx-ledger-before-confirm.png' });

  await window.check('#dapp-tx-auto-approve');
  await window.click('#dapp-tx-approve');

  await expect(window.locator('#dapp-tx-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#dapp-tx-reject')).toBeDisabled();
  await expect(window.locator('#dapp-tx-back')).toBeDisabled();
  await window.screenshot({ path: 'test-results/dapp-tx-ledger-in-flight.png' });

  // Clicking them anyway (a stray programmatic click, or a click that raced
  // the disable) must not settle the dApp promise or close the screen.
  await window.evaluate(() => {
    document.getElementById('dapp-tx-reject').click();
    document.getElementById('dapp-tx-back').click();
  });
  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
  expect(await settledState(window, 'a')).toBe('pending');

  // The device approves: the tx resolves for the dApp and the screen closes
  // with the auto-approve checkbox cleared for the next request.
  await electronApp.evaluate(() => {
    globalThis.__resolveLedgerSend({ success: true, hash: '0xabc123', recorded: true });
  });
  await expect(window.locator('#sidebar-dapp-tx')).toBeHidden();
  expect(await settledState(window, 'a')).toBe('resolved:0xabc123');
  expect(await window.isChecked('#dapp-tx-auto-approve')).toBe(false);
  await expect(window.locator('#dapp-tx-reject')).toBeEnabled();
});

// The screen is a single shared surface. A second dApp request arriving
// while the device is still showing the first one must not repaint it and
// re-enable the way out: the user would click a Reject that appears to
// cancel what the device is displaying, get 4001 for the *newcomer*, then
// approve the still-live first prompt and see it broadcast after the
// visible cancel.
test('a second request cannot take the screen from an in-flight Ledger confirmation', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, LEDGER);
  await requestApproval(window, 'a', TX_PARAMS);

  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
  await window.click('#dapp-tx-approve');
  await expect(window.locator('#dapp-tx-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#dapp-tx-reject')).toBeDisabled();

  // Second request lands while the device prompt for the first is up.
  await requestApproval(window, 'b', {
    ...TX_PARAMS,
    to: '0x4200000000000000000000000000000000000006',
  });

  // It is refused with "already pending" instead of taking the screen, and
  // the screen still belongs to the first request: same recipient, same
  // "Confirm on your Ledger…" state, no way out re-enabled.
  await expect
    .poll(() => settledState(window, 'b'))
    .toBe('rejected:-32002');
  await expect(window.locator('#dapp-tx-to')).toHaveAttribute('title', TX_PARAMS.to);
  await expect(window.locator('#dapp-tx-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#dapp-tx-approve')).toBeDisabled();
  await expect(window.locator('#dapp-tx-reject')).toBeDisabled();
  await expect(window.locator('#dapp-tx-back')).toBeDisabled();
  await window.screenshot({ path: 'test-results/dapp-tx-ledger-second-request-refused.png' });

  await window.evaluate(() => {
    document.getElementById('dapp-tx-reject').click();
    document.getElementById('dapp-tx-back').click();
  });
  expect(await settledState(window, 'a')).toBe('pending');

  // The device approves the first request: it — and only it — settles.
  await electronApp.evaluate(() => {
    globalThis.__resolveLedgerSend({ success: true, hash: '0xabc123', recorded: true });
  });
  await expect(window.locator('#sidebar-dapp-tx')).toBeHidden();
  expect(await settledState(window, 'a')).toBe('resolved:0xabc123');
  expect(await settledState(window, 'b')).toBe('rejected:-32002');
});

// Same steal, different thief. The sidebar is shared by *every* approval
// surface, and each of them takes it over by calling hideAllSubscreens() —
// so a per-module "already pending" guard only stops a sibling request of
// the same kind. A personal_sign, or a permissionless eth_requestAccounts,
// would otherwise paint its own screen over the live confirmation with
// Reject/Sign/Connect fully enabled: the user cancels what they believe the
// device is showing, and the first transaction broadcasts anyway.
test('other approval surfaces cannot take the screen from an in-flight Ledger confirmation', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, LEDGER);
  await requestApproval(window, 'a', TX_PARAMS);

  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
  await window.click('#dapp-tx-approve');
  await expect(window.locator('#dapp-tx-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#dapp-tx-reject')).toBeDisabled();

  // The page now asks for a signature and for accounts while the device
  // prompt for the transaction is still up.
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

  await expect
    .poll(() => window.evaluate(() => window.__otherSurfaces?.sign))
    .toBe('rejected:-32002');
  await expect
    .poll(() => window.evaluate(() => window.__otherSurfaces?.connect))
    .toBe('rejected:-32002');

  // Neither screen took the sidebar; the transaction confirmation is
  // untouched, with both ways out still closed.
  await expect(window.locator('#sidebar-dapp-sign')).toBeHidden();
  await expect(window.locator('#sidebar-dapp-connect')).toBeHidden();
  await expect(window.locator('#sidebar-dapp-tx')).toBeVisible();
  await expect(window.locator('#dapp-tx-to')).toHaveAttribute('title', TX_PARAMS.to);
  await expect(window.locator('#dapp-tx-approve')).toHaveText('Confirm on your Ledger…');
  await expect(window.locator('#dapp-tx-reject')).toBeDisabled();
  await expect(window.locator('#dapp-tx-back')).toBeDisabled();
  await window.screenshot({ path: 'test-results/dapp-tx-ledger-other-surfaces-refused.png' });

  // The device approves: the transaction — and only it — settles.
  await electronApp.evaluate(() => {
    globalThis.__resolveLedgerSend({ success: true, hash: '0xabc123', recorded: true });
  });
  await expect(window.locator('#sidebar-dapp-tx')).toBeHidden();
  expect(await settledState(window, 'a')).toBe('resolved:0xabc123');
});
