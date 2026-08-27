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

import { showDappConnect, getSelectedChainId, setSelectedChainId, updateConnectionBanner, showDappTxApproval, showDappSignApproval, showVaultUnlock, updateSwarmConnectionBanner, updateX402ConnectionBanner } from './wallet-ui.js';
import { buildDappTxContext, extractSelector } from './wallet/dapp-tx.js';
import { getPermissionKey } from './origin-utils.js';

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

// Callback for showing connection approval UI (legacy, kept for compatibility
// with external callers of the exported onConnectionApproval setter).
let _showConnectionApproval = null;

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
const AGENT_WALLET_METHODS = new Set([
  'eth_requestAccounts',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
]);

async function offerAgentWalletRequest(webview, method, params, displayUrl, permissionKey) {
  if (!AGENT_WALLET_METHODS.has(method)) return { handled: false };
  const rendererTabId = Number(webview?.dataset?.tabId);
  if (!Number.isSafeInteger(rendererTabId) || rendererTabId < 1) return { handled: false };
  const chainId = parseInt(await getCurrentChainId(), 16);
  const response = await window.electronAPI?.handleAgentWalletRequest?.(rendererTabId, {
    method,
    params,
    displayUrl,
    permissionKey,
    chainId,
  });
  return response && typeof response === 'object' ? response : { handled: false };
}

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

    const agentWallet = await offerAgentWalletRequest(
      webview,
      method,
      params,
      displayUrl,
      permissionKey
    );
    if (agentWallet.handled) {
      if (agentWallet.error) throw agentWallet.error;
      result = agentWallet.result;
      sendProviderResponse(webview, id, result, null);
      return;
    }

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
      const txParams = params[0];
      const selector = extractSelector(txParams?.data);
      const permission = await window.dappPermissions.getPermission(permissionKey);
      if (!permission) {
        throw { ...ERRORS.UNAUTHORIZED, message: 'Not connected. Call eth_requestAccounts first.' };
      }

      const chainId = permission.chainId || parseInt(await getCurrentChainId(), 16);

      // Auto-approve only for contract calls with a matching rule (never plain ETH transfers)
      if (selector && txParams?.to
        && await window.dappPermissions.isTransactionAutoApproved(permissionKey, txParams.to, selector, chainId)
      ) {
        const vaultStatus = await window.identity?.getStatus?.();
        if (!vaultStatus?.isUnlocked) {
          await showVaultUnlock(permissionKey);
        }
        result = await autoApproveTx(permission, txParams, chainId, permissionKey);
      } else {
        result = await showDappTxApproval(webview, permissionKey, txParams);
      }
    } else if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      const permission = await window.dappPermissions.getPermission(permissionKey);
      if (!permission) {
        throw { ...ERRORS.UNAUTHORIZED, message: 'Not connected. Call eth_requestAccounts first.' };
      }

      if (permission.autoApprove?.signing) {
        const vaultStatus = await window.identity?.getStatus?.();
        if (!vaultStatus?.isUnlocked) {
          await showVaultUnlock(permissionKey);
        }
        result = await autoApproveSign(permission, method, params, permissionKey);
      } else {
        result = await showDappSignApproval(webview, permissionKey, method, params);
      }
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
 * Send a transaction without showing the approval UI (auto-approved).
 * Handles gas estimation and signing via wallet IPC.
 */
async function autoApproveTx(permission, txParams, chainId, permissionKey) {
  const walletIndex = permission.walletIndex;

  // Resolve sender address and gas price in parallel
  const [walletsResult, gasPrices] = await Promise.all([
    window.wallet.getDerivedWallets(),
    window.wallet.getGasPrice(chainId),
  ]);

  const wallets = walletsResult?.success ? walletsResult.wallets : [];
  const wallet = wallets.find((w) => w.index === walletIndex);
  const fromAddress = wallet?.address;

  if (!gasPrices?.success) {
    throw new Error(gasPrices?.error || 'Failed to get gas prices');
  }

  const gasEstimate = await window.wallet.estimateGas({
    from: fromAddress,
    to: txParams.to,
    value: txParams.value,
    data: txParams.data,
    chainId,
  });

  if (!gasEstimate?.success) {
    throw new Error(gasEstimate?.error || 'Gas estimation failed');
  }

  const tx = {
    to: txParams.to,
    value: txParams.value || '0',
    data: txParams.data,
    gasLimit: gasEstimate.gasLimit || txParams.gas,
    chainId,
  };

  if (gasPrices.type === 'eip1559') {
    tx.maxFeePerGas = gasPrices.maxFeePerGas;
    tx.maxPriorityFeePerGas = gasPrices.maxPriorityFeePerGas;
  } else if (gasPrices.gasPrice) {
    tx.gasPrice = gasPrices.gasPrice;
  }

  const result = await window.wallet.dappSendTransaction(
    tx,
    walletIndex,
    buildDappTxContext(permissionKey, txParams)
  );
  if (!result.success) throw new Error(result.error || 'Transaction failed');
  if (result.recorded === false) {
    console.warn('[DappProvider] Auto-approved transaction broadcast but payment history did not record:', result.recordError);
  }

  window.dappPermissions.updateLastUsed(permissionKey);
  return result.hash;
}

/**
 * Sign a message without showing the approval UI (auto-approved).
 * Accepts the already-fetched permission object to avoid redundant IPC.
 */
async function autoApproveSign(permission, method, params, permissionKey) {
  const signature = await executeSign(method, params, permission.walletIndex);
  window.dappPermissions.updateLastUsed(permissionKey);
  return signature;
}

/**
 * Execute a signing operation via the wallet IPC bridge.
 * Shared by both auto-approve and manual approval paths.
 */
async function executeSign(method, params, walletIndex) {
  let result;
  if (method === 'personal_sign') {
    result = await window.wallet.signMessage(params[0], walletIndex);
  } else if (method === 'eth_signTypedData_v4') {
    result = await window.wallet.signTypedData(params[1], walletIndex);
  } else {
    throw new Error(`Unsupported signing method: ${method}`);
  }
  if (!result.success) throw new Error(result.error || 'Signing failed');
  return result.signature;
}

/**
 * Proxy an RPC call to the main process
 * Uses the chain's capability-aware source order (Myotis, Colibri,
 * RPC quorum, then direct RPC fallback).
 */
async function proxyRpcCall(method, params) {
  // Get current chain ID
  const chainIdHex = await getCurrentChainId();
  const chainId = parseInt(chainIdHex, 16);

  const data = await window.wallet.requestChain(chainId, method, params);
  if (!data?.success) {
    let message = data?.error?.message || `All chain sources failed for chain ${chainId}`;
    try {
      const availability = await window.networks.isChainAvailable(chainId);
      if (availability?.available === false) {
        const chainsResult = await window.networks.getChains();
        const chainName = chainsResult?.success
          ? chainsResult.chains?.[chainId]?.name
          : null;
        message = `${chainName || `Chain ${chainId}`} requires an RPC provider. Please configure one in Settings.`;
      }
    } catch {
      // Preserve the original router error if availability lookup also fails.
    }
    throw {
      code: data?.error?.code || ERRORS.INTERNAL_ERROR.code,
      message,
      data: data?.error?.data,
    };
  }
  return data.result;
}

/**
 * Handle wallet_switchEthereumChain
 */
async function handleSwitchChain(params, permissionKey, webview) {
  if (!params || !params[0] || !params[0].chainId) {
    throw ERRORS.INVALID_PARAMS;
  }

  const requestedChainId = parseInt(params[0].chainId, 16);
  const result = await window.networks.getChains();
  const chains = result.success ? result.chains : {};

  if (!chains[requestedChainId]) {
    throw ERRORS.CHAIN_NOT_ADDED;
  }

  // Check if the chain is available (has RPC configured)
  const availabilityResult = await window.networks.isChainAvailable(requestedChainId);
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

  // Update connection banners after a small delay to allow address bar to update
  setTimeout(() => {
    updateConnectionBanner();
    updateSwarmConnectionBanner();
    updateX402ConnectionBanner();
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
  _showConnectionApproval = callback;
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

// Exported for use by swarm-provider.js and swarm-connect.js
export { getPermissionKey, getDisplayUrl, executeSign };

// Export state for wallet UI to access
export const walletState = {
  selectedChainId: 100, // Default to Gnosis
};

// Make walletState accessible globally for provider
if (typeof window !== 'undefined') {
  window.walletState = walletState;
}
