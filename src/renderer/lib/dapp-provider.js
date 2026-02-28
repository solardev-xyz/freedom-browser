/**
 * dApp Provider Handler (Renderer Side)
 *
 * Handles Ethereum provider requests from webviews:
 * - Routes read-only RPC calls to main process
 * - Manages connection requests (shows approval UI)
 * - Handles transaction signing (shows approval UI)
 *
 * Communication flow:
 * webview (window.ethereum) → renderer (this) → main (RPC/signing)
 */

import { showDappConnect, getSelectedChainId, setSelectedChainId, updateConnectionBanner, showDappTxApproval, showDappSignApproval } from './wallet-ui.js';

// Feature flag state
let identityWalletEnabled = false;

// Load initial flag state and listen for changes
window.electronAPI?.getSettings?.().then((settings) => {
  identityWalletEnabled = settings?.enableIdentityWallet === true;
}).catch(() => {});
window.addEventListener('settings:updated', (event) => {
  identityWalletEnabled = event.detail?.enableIdentityWallet === true;
});

// Provider state per webview (keyed by webview ID or reference)
const providerStates = new WeakMap();

// Current active webview reference (set by tabs.js)
let activeWebview = null;

// Callback for showing connection approval UI (legacy, kept for compatibility)
let showConnectionApproval = null;

/**
 * EIP-1193 error codes
 */
const ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'Unauthorized' },
  UNSUPPORTED_METHOD: { code: 4200, message: 'Method not supported' },
  DISCONNECTED: { code: 4900, message: 'Disconnected' },
  CHAIN_NOT_ADDED: { code: 4902, message: 'Unrecognized chain ID' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid parameters' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

/**
 * Get the display URL from the address bar
 * This is what the user sees (e.g., ipfs://QmXxx, vitalik.eth, https://example.com)
 */
function getDisplayUrl() {
  const addressInput = document.getElementById('address-input');
  return addressInput?.value || '';
}

/**
 * Extract the permission key from a display URL
 * This strips the URL to its "root" identifier:
 * - ipfs://QmABC123/path → ipfs://QmABC123
 * - bzz://abc123/page → bzz://abc123
 * - vitalik.eth/blog → vitalik.eth
 * - ipns://docs.ipfs.tech/guide → ipns://docs.ipfs.tech
 * - https://app.uniswap.org/swap → https://app.uniswap.org
 */
function getPermissionKey(displayUrl) {
  if (!displayUrl) return null;

  const trimmed = displayUrl.trim();

  // ENS name without protocol (e.g., 1inch.eth/path)
  if (/^[a-z0-9-]+\.(eth|box)/i.test(trimmed)) {
    return trimmed.split('/')[0].toLowerCase();
  }

  // ens:// protocol → extract ENS name (e.g., ens://1inch.eth/#/path → 1inch.eth)
  const ensMatch = trimmed.match(/^ens:\/\/([^/#]+)/i);
  if (ensMatch) {
    return ensMatch[1].toLowerCase();
  }

  // dweb protocols: ipfs://CID/path → ipfs://CID
  const dwebMatch = trimmed.match(/^(ipfs|bzz|ipns):\/\/([^/]+)/i);
  if (dwebMatch) {
    return `${dwebMatch[1].toLowerCase()}://${dwebMatch[2]}`;
  }

  // rad:// protocol
  const radMatch = trimmed.match(/^rad:\/\/([^/]+)/i);
  if (radMatch) {
    return `rad://${radMatch[1]}`;
  }

  // Regular URL (https://host/path → https://host)
  try {
    const url = new URL(trimmed);
    // Non-standard protocols return "null" for origin, fall back to trimmed
    if (url.origin === 'null') {
      return trimmed;
    }
    return url.origin;
  } catch {
    // If parsing fails, return as-is
    return trimmed;
  }
}

/**
 * Methods that can be handled without user approval (read-only)
 */
const READ_ONLY_METHODS = [
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getLogs',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_uninstallFilter',
  'web3_clientVersion',
  'web3_sha3',
];

/**
 * Methods that require connection (account access)
 */
const ACCOUNT_METHODS = [
  'eth_accounts',
  'eth_requestAccounts',
];

/**
 * Methods that require user approval
 */
const APPROVAL_METHODS = [
  'eth_sendTransaction',
  'eth_signTransaction',
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_addEthereumChain',
  'wallet_switchEthereumChain',
  'wallet_watchAsset',
];

/**
 * Get or create provider state for a webview
 */
function getProviderState(webview) {
  if (!providerStates.has(webview)) {
    providerStates.set(webview, {
      chainId: null,
      accounts: [],
      isConnected: false,
    });
  }
  return providerStates.get(webview);
}

/**
 * Get the current chain ID in hex format
 */
async function getCurrentChainId() {
  try {
    // Get from wallet UI's selected chain
    const chainId = getSelectedChainId();
    if (chainId) {
      return '0x' + chainId.toString(16);
    }
    // Default to Gnosis Chain
    return '0x64';
  } catch {
    return '0x64';
  }
}

/**
 * Handle a provider request from a webview
 */
async function handleProviderRequest(webview, request) {
  const { id, method, params } = request;

  // Gate: if Identity & Wallet feature is disabled, reject all provider requests
  if (!identityWalletEnabled) {
    sendProviderResponse(webview, id, null, ERRORS.DISCONNECTED);
    return;
  }

  console.log('[DappProvider] handleProviderRequest:', { id, method, params });

  // Get the display URL from address bar and derive permission key
  // This replaces the raw origin (which is 127.0.0.1 for IPFS/Swarm pages)
  const displayUrl = getDisplayUrl();
  const permissionKey = getPermissionKey(displayUrl);

  console.log('[DappProvider] Using permissionKey:', permissionKey);

  try {
    let result;

    // Handle different method categories
    if (method === 'eth_chainId') {
      result = await getCurrentChainId();
    } else if (method === 'net_version') {
      const chainId = await getCurrentChainId();
      result = String(parseInt(chainId, 16));
    } else if (method === 'eth_accounts') {
      // Return connected accounts (empty if not connected)
      const permission = await window.dappPermissions.getPermission(permissionKey);
      if (permission) {
        const walletsResult = await window.wallet.getDerivedWallets();
        const wallets = walletsResult.success ? walletsResult.wallets : [];
        const wallet = wallets.find((w) => w.index === permission.walletIndex);
        result = wallet ? [wallet.address] : [];
      } else {
        result = [];
      }
    } else if (method === 'eth_requestAccounts') {
      // Check if already connected
      const permission = await window.dappPermissions.getPermission(permissionKey);
      if (permission) {
        // Already connected, return accounts
        const walletsResult = await window.wallet.getDerivedWallets();
        const wallets = walletsResult.success ? walletsResult.wallets : [];
        const wallet = wallets.find((w) => w.index === permission.walletIndex);
        result = wallet ? [wallet.address] : [];
        // Update last used
        await window.dappPermissions.updateLastUsed(permissionKey);
      } else {
        // Need to show connection approval UI
        console.log('[DappProvider] Showing connect UI for:', permissionKey);
        result = await new Promise((resolve, reject) => {
          showDappConnect(displayUrl, permissionKey, resolve, reject, webview);
        });
        console.log('[DappProvider] Connect UI resolved with:', result);
      }
    } else if (READ_ONLY_METHODS.includes(method)) {
      // Proxy read-only calls to RPC
      result = await proxyRpcCall(method, params);
    } else if (method === 'wallet_switchEthereumChain') {
      // Handle chain switching
      result = await handleSwitchChain(params, permissionKey, webview);
    } else if (method === 'eth_sendTransaction') {
      // Need transaction approval
      result = await showDappTxApproval(webview, permissionKey, params[0]);
    } else if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      // Need signing approval
      result = await showDappSignApproval(webview, permissionKey, method, params);
    } else if (method === 'eth_sign') {
      // Deprecated and dangerous - reject
      throw { ...ERRORS.UNSUPPORTED_METHOD, message: 'eth_sign is deprecated for security reasons' };
    } else {
      // Unknown method
      throw ERRORS.UNSUPPORTED_METHOD;
    }

    // Send success response
    sendProviderResponse(webview, id, result, null);
  } catch (error) {
    // Send error response
    const err = {
      code: error.code || ERRORS.INTERNAL_ERROR.code,
      message: error.message || 'Unknown error',
      data: error.data,
    };
    sendProviderResponse(webview, id, null, err);
  }
}

/**
 * Proxy an RPC call to the main process
 * Tries multiple RPC endpoints with fallback on failure
 */
async function proxyRpcCall(method, params) {
  // Get current chain ID
  const chainIdHex = await getCurrentChainId();
  const chainId = parseInt(chainIdHex, 16);

  // Get effective RPC URLs (includes provider URLs if configured)
  const urlsResult = await window.rpcManager.getEffectiveUrls(chainId);
  const rpcUrls = urlsResult.success ? urlsResult.urls : [];

  if (rpcUrls.length === 0) {
    // No RPC URLs available - give helpful error message
    const chainsResult = await window.chainRegistry.getChains();
    const chains = chainsResult.success ? chainsResult.chains : {};
    const chain = chains[chainId];
    const chainName = chain?.name || `Chain ${chainId}`;
    throw {
      ...ERRORS.INTERNAL_ERROR,
      message: `${chainName} requires an RPC provider. Please configure Alchemy, Infura, or DRPC in Settings.`,
    };
  }

  // Try each RPC URL until one succeeds (via main process to avoid renderer CSP)
  let lastError = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const data = await window.wallet.proxyRpc(rpcUrl, method, params);

      if (!data.success) {
        // RPC returned an error - try next endpoint
        console.warn(`[DappProvider] RPC error from ${rpcUrl}:`, data.error?.message);
        lastError = { code: data.error?.code, message: data.error?.message };
        continue;
      }

      return data.result;
    } catch (err) {
      // IPC/network error - try next endpoint
      console.warn(`[DappProvider] RPC proxy failed for ${rpcUrl}:`, err.message);
      lastError = { ...ERRORS.INTERNAL_ERROR, message: err.message };
    }
  }

  // All endpoints failed
  throw lastError || { ...ERRORS.INTERNAL_ERROR, message: `All RPC endpoints failed for chain ${chainId}` };
}

/**
 * Handle wallet_switchEthereumChain
 */
async function handleSwitchChain(params, permissionKey, webview) {
  if (!params || !params[0] || !params[0].chainId) {
    throw ERRORS.INVALID_PARAMS;
  }

  const requestedChainId = parseInt(params[0].chainId, 16);
  const result = await window.chainRegistry.getChains();
  const chains = result.success ? result.chains : {};

  if (!chains[requestedChainId]) {
    throw ERRORS.CHAIN_NOT_ADDED;
  }

  // Check if the chain is available (has RPC configured)
  const availabilityResult = await window.chainRegistry.isChainAvailable(requestedChainId);
  if (!availabilityResult.available) {
    const chain = chains[requestedChainId];
    throw {
      code: 4902,
      message: `${chain.name} requires an RPC provider. Please configure Alchemy, Infura, or DRPC in Settings.`,
    };
  }

  // Update the permission with new chain
  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (permission) {
    await window.dappPermissions.updateLastUsed(permissionKey, requestedChainId);
  }

  // Update wallet UI's selected chain to match
  setSelectedChainId(requestedChainId);

  // Emit chainChanged event to the dApp
  const chainIdHex = '0x' + requestedChainId.toString(16);
  if (webview) {
    sendProviderEvent(webview, 'chainChanged', chainIdHex);
    console.log('[DappProvider] Emitted chainChanged:', chainIdHex);
  }

  return null;
}

/**
 * Send a response back to the webview
 */
function sendProviderResponse(webview, id, result, error) {
  console.log('[DappProvider] sendProviderResponse:', { id, result, error, hasWebview: !!webview, hasSend: !!(webview && webview.send) });
  if (webview && webview.send) {
    webview.send('dapp:provider-response', { id, result, error });
  } else {
    console.error('[DappProvider] Cannot send response - webview or send missing');
  }
}

/**
 * Send an event to a webview
 */
function sendProviderEvent(webview, event, data) {
  if (webview && webview.send) {
    webview.send('dapp:provider-event', { event, data });
  }
}

/**
 * Send state update to a webview
 */
function sendProviderState(webview, state) {
  if (webview && webview.send) {
    webview.send('dapp:provider-state', state);
  }
}

/**
 * Setup provider request listener for a webview
 */
export function setupWebviewProvider(webview) {
  if (!webview) return;

  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'dapp:provider-request') {
      const request = event.args[0];
      handleProviderRequest(webview, request);
    }
  });

  // Initialize provider state for this webview
  getProviderState(webview);
}

/**
 * Set the active webview (for sending events)
 */
export function setActiveWebview(webview) {
  activeWebview = webview;

  // Update connection banner after a small delay to allow address bar to update
  setTimeout(() => {
    updateConnectionBanner();
  }, 50);
}

/**
 * Get the current active webview
 */
export function getActiveWebview() {
  return activeWebview;
}

/**
 * Register callback for showing connection approval UI
 */
export function onConnectionApproval(callback) {
  showConnectionApproval = callback;
}

/**
 * Emit accountsChanged event to a webview
 */
export function emitAccountsChanged(webview, accounts) {
  sendProviderEvent(webview, 'accountsChanged', accounts);
}

/**
 * Emit chainChanged event to a webview
 */
export function emitChainChanged(webview, chainId) {
  sendProviderEvent(webview, 'chainChanged', chainId);
}

/**
 * Emit connect event to a webview
 */
export function emitConnect(webview, chainId) {
  sendProviderEvent(webview, 'connect', { chainId });
}

/**
 * Emit disconnect event to a webview
 */
export function emitDisconnect(webview, error) {
  sendProviderEvent(webview, 'disconnect', error || { code: 4900, message: 'Disconnected' });
}

/**
 * Broadcast event to all webviews (when chain changes globally, etc.)
 */
export function broadcastProviderEvent(event, data) {
  // This would need access to all webviews
  // For now, just emit to active webview
  if (activeWebview) {
    sendProviderEvent(activeWebview, event, data);
  }
}

// Export state for wallet UI to access
export const walletState = {
  selectedChainId: 100, // Default to Gnosis
};

// Make walletState accessible globally for provider
if (typeof window !== 'undefined') {
  window.walletState = walletState;
}
