/**
 * Shared mutable state for wallet UI modules.
 * All submodules import and mutate the same object reference — no stale reads.
 */
export const walletState = {
  // Identity
  identityData: null,

  // Multi-wallet
  derivedWallets: [],
  activeWalletIndex: 0,

  // Chain registry
  registeredTokens: {},
  registeredChains: {},

  // Balances
  currentBalances: {},
  balanceRefreshInterval: null,
  BALANCE_REFRESH_MS: 30000,

  // Selected chain (default to Gnosis Chain)
  selectedChainId: 100,

  // Full addresses for copy
  fullAddresses: {
    wallet: '',
    swarm: '',
    ipfs: '',
    radicle: '',
  },

  // Current view mode: 'setup' or 'identity' (set by coordinator showView)
  viewMode: 'setup',

  // Shared DOM reference (set by coordinator init)
  identityView: null,
};

// Registry of screen-hide functions for hideAllSubscreens
const screenHiders = [];

export function registerScreenHider(fn) {
  screenHiders.push(fn);
}

export function hideAllSubscreens() {
  screenHiders.forEach(fn => fn());
}
