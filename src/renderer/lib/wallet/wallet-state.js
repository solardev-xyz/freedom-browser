/**
 * Shared mutable state for wallet UI modules.
 * All submodules import and mutate the same object reference — no stale reads.
 */

import { assertNoSignatureInFlight } from './signature-flight.js';

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

/**
 * Hide every registered sub-screen so a caller can take over the sidebar.
 *
 * Refuses while a signature is in flight: that screen owns the sidebar
 * until the device prompt it produced is answered (see signature-flight.js).
 * Callers check the lock first and refuse the newcomer on their own error
 * channel; this throw is the backstop that turns a missed check into a
 * loud failure *before* anything is torn down, rather than a silent steal
 * of a live device confirmation.
 */
export function hideAllSubscreens() {
  assertNoSignatureInFlight();
  screenHiders.forEach(fn => fn());
}
