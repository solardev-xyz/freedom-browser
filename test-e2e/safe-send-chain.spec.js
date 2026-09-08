// A Safe lives on exactly one chain (Gnosis), and the calldata the send
// screen composes is only meaningful there — the executor always runs it on
// the deployment chain. So the send screen must not let a Safe user compose
// on any other chain: offering Ethereum produces a review screen labelled
// "Ethereum" for a transaction that spends xDAI (or CALLs a mainnet token
// address that holds no code on Gnosis — a CALL that succeeds, burns the
// Safe nonce and records a transfer that moved nothing).
//
// Driven through the real renderer screen, so the chain selector, its
// dropdown and the review label are all the ones a user actually sees.

const { test, expect } = require('./fixtures');

const SAFE = {
  index: 2000000,
  name: 'E2E Safe',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  type: 'safe',
  owners: [0],
  threshold: 1,
  deployed: { 100: true },
};

const MNEMONIC = {
  index: 0,
  name: 'Main Wallet',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  type: 'mnemonic',
};

// Balances on both Gnosis and Ethereum, so "only Gnosis is offered" is a
// real restriction rather than an artefact of there being nothing else.
const CHAIN_FIXTURE = {
  registeredChains: {
    1: { chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH' },
    100: { chainId: 100, name: 'Gnosis', nativeSymbol: 'xDAI' },
  },
  registeredTokens: {
    'eth-native': {
      chainId: 1, symbol: 'ETH', name: 'Ether', decimals: 18, address: null, builtin: true,
    },
    'gnosis-native': {
      chainId: 100, symbol: 'xDAI', name: 'xDAI', decimals: 18, address: null, builtin: true,
    },
  },
  currentBalances: {
    'eth-native': { formatted: '2.0', symbol: 'ETH' },
    'gnosis-native': { formatted: '5.0', symbol: 'xDAI' },
  },
};

async function openSendOn(window, wallet) {
  await window.evaluate(async ({ account, fixture }) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const sidebar = await import('./lib/sidebar.js');
    const send = await import('./lib/wallet/send.js');
    sidebar.open();
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');

    walletState.viewMode = 'identity';
    walletState.fullAddresses.wallet = account.address;
    walletState.derivedWallets = [account];
    walletState.activeWalletIndex = account.index;
    // The user's global chain is Ethereum — the case the Safe screen has to
    // override rather than inherit.
    walletState.selectedChainId = 1;
    Object.assign(walletState, fixture);

    send.openSend();
  }, { account: wallet, fixture: CHAIN_FIXTURE });

  await expect(window.locator('#sidebar-send')).toBeVisible();
}

test('a Safe send is pinned to Gnosis and offers no other chain', async ({ window }) => {
  await openSendOn(window, SAFE);

  // The screen opens on Gnosis even though the wallet view is on Ethereum.
  await expect(window.locator('#send-chain-name')).toHaveText('Gnosis');
  await expect(window.locator('#send-asset-name')).toHaveText('xDAI');

  // ...and the dropdown offers nothing else.
  await window.click('#send-chain-btn');
  await expect(window.locator('#send-chain-dropdown')).toBeVisible();
  await expect(window.locator('#send-chain-list .send-selector-item')).toHaveCount(1);
  await expect(window.locator('#send-chain-list .send-selector-item')).toHaveText(/Gnosis/);
  await window.screenshot({ path: 'test-results/safe-send-chain-gnosis-only.png' });

  // A programmatic opener's chain hint does not outrank the Safe's chain.
  await window.evaluate(async () => {
    const send = await import('./lib/wallet/send.js');
    send.closeSend();
    send.openSend({ chainId: 1 });
  });
  await expect(window.locator('#send-chain-name')).toHaveText('Gnosis');
});

test('a regular account still gets the full chain list', async ({ window }) => {
  await openSendOn(window, MNEMONIC);

  await expect(window.locator('#send-chain-name')).toHaveText('Ethereum');
  await window.click('#send-chain-btn');
  await expect(window.locator('#send-chain-list .send-selector-item')).toHaveCount(2);
  await window.screenshot({ path: 'test-results/send-chain-all-chains.png' });
});
