// A send that leaves a held payment (refused, or never sent) offers to send
// those same signed bytes again: Retry becomes "Send again", which asks
// main for an 'intent-resend' confirmation of the held intent and sends it
// through `wallet:intent-resend`, instead of going back to the form and
// signing a second payment at a new nonce (freedom-core design 0005,
// "Retrying an intent").
//
// Driven through the real renderer screen and the real confirmation
// handler; the send and resend handlers are replaced for this app instance.

const { test, expect } = require('./fixtures');

const LEDGER = {
  index: 1000000,
  name: 'Ledger 1',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};

const RECIPIENT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const HELD = {
  intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a03',
  chainId: 8453,
  sender: LEDGER.address.toLowerCase(),
  nonce: 7,
  hash: `0x${'ab'.repeat(32)}`,
  state: 'held',
  attention: 'refused',
};

function stubMainIpc(electronApp, held) {
  return electronApp.evaluate(({ ipcMain }, heldIntent) => {
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
    globalThis.__sends = [];
    globalThis.__resends = [];
    replace('wallet:send-transaction', (_event, params) => {
      globalThis.__sends.push(params);
      return {
        success: false,
        error: 'Insufficient funds for transaction',
        outcome: 'rejected',
        reasonClass: 'insufficient funds',
        intentId: heldIntent.intentId,
        intent: heldIntent,
      };
    });
    replace('wallet:intent-resend', (_event, intentId, authorization) => {
      globalThis.__resends.push({ intentId, authorization });
      return { success: true, hash: heldIntent.hash, outcome: 'sent', resent: true };
    });
  }, held);
}

async function openSendOnLedger(window, recipient) {
  await window.evaluate(async ({ ledger, recipient }) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const sidebar = await import('./lib/sidebar.js');
    const send = await import('./lib/wallet/send.js');
    sidebar.open();
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
    walletState.viewMode = 'identity';
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
    send.openSend({ recipient, chainId: 8453 });
  }, { ledger: LEDGER, recipient });

  await expect(window.locator('#sidebar-send')).toBeVisible();
  await window.fill('#send-amount', '0.001');
  await window.click('#send-continue-btn');
  await expect(window.locator('#send-review-view')).toBeVisible();
}

test('a refused send is sent again as the same payment, with its own confirmation', async ({
  electronApp,
  window,
}) => {
  await stubMainIpc(electronApp, HELD);
  await openSendOnLedger(window, RECIPIENT);
  await window.click('#send-confirm-btn');

  await expect(window.locator('#send-error-view')).toBeVisible();
  await expect(window.locator('#send-error-view .send-error-title')).toHaveText('Refused by the network');
  await expect(window.locator('#send-error-text')).toHaveText(
    'The network refused it: insufficient funds'
  );
  await expect(window.locator('#send-retry-btn')).toHaveText('Send again');
  await window.screenshot({ path: 'test-results/send-intent-refused.png' });

  await window.click('#send-retry-btn');
  await expect(window.locator('#send-success-view')).toBeVisible();

  const calls = await electronApp.evaluate(() => ({
    sends: globalThis.__sends,
    resends: globalThis.__resends,
  }));
  // One payment was signed; the retry sent it again, authorized by a
  // confirmation main minted for that held intent.
  expect(calls.sends).toHaveLength(1);
  expect(calls.resends).toEqual([
    { intentId: HELD.intentId, authorization: { confirmation: expect.stringMatching(/^[0-9a-f]{64}$/) } },
  ]);
});
