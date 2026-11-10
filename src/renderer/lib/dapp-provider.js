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
import { isSafeAccount, GNOSIS_CHAIN_ID } from './wallet/wallet-utils.js';
import { openSafeMessageBoard, abandonSafeMessageBoard } from './wallet/safe-signing.js';
import { confirmSigning } from './wallet/signing-confirmation.js';
import { getPermissionKey } from './origin-utils.js';
import { parseOnchainAppUrl, applyDnsNameIdentity } from './url-utils.js';
import { state } from './state.js';
import { trackGuestMainFrame, isFromGuestMainFrame } from './guest-main-frame.js';
import { getDisplayUrlForWebview, isTabAgentOwned } from './tabs.js';

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

// Per-webview navigation generation, bumped on every committed navigation
// and on webview destruction (mirrors radicle-provider.js). Requests capture
// the generation on arrival and responses are only delivered while it still
// matches: provider request ids restart per document, so a result or error
// that lands after a navigation could otherwise satisfy a reused id in the
// replacement document. Main already drops Safe signing sessions on
// navigation; this closes the same gap on the renderer's delivery side.
const navigationGenerations = new WeakMap();

const getNavigationGeneration = (webview) => navigationGenerations.get(webview) ?? 0;

// Current active webview reference (set by tabs.js)
let activeWebview = null;

// Every webview with a provider, so a change of the wallet's chain reaches
// background tabs too, not just the active one.
const providerWebviews = new Set();

// The chain (hex) each document was last told: an eth_chainId / net_version
// answer or a chainChanged event. The wallet's chain is global, but a page
// builds its transactions for the chain it was told, so sending and signing
// use this record rather than the selection as it stands when the request
// lands. Cleared on navigation: a new document has been told nothing.
const toldChains = new WeakMap();

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

async function offerAgentWalletRequest(webview, method, params, displayUrl, permissionKey, told) {
  if (!AGENT_WALLET_METHODS.has(method)) return { handled: false };
  const rendererTabId = Number(webview?.dataset?.tabId);
  if (!Number.isSafeInteger(rendererTabId) || rendererTabId < 1) return { handled: false };
  const chainId = pageChainId(webview, told);
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
function getOnchainApp(webview) {
  try {
    return parseOnchainAppUrl(webview?.getURL?.());
  } catch {
    return null;
  }
}

/**
 * The user-facing identity of the page in `webview` — the site a request
 * from that webview is attributed to (permission key, prompts, auto-approve).
 *
 * Always the *requesting* webview's own committed URL (its tab's
 * `committedDisplayUrl`, which keeps ENS/bzz/ipfs names), never the address
 * bar: `#address-input` shows the visible tab — or a half-typed draft — so
 * reading it let a background tab's request borrow the visible site's
 * connection and auto-approve rules (#764). A DNS-named ENS site over IPNS
 * commits as `ipns://<key>`; `applyDnsNameIdentity` maps it back to the
 * `ens://<name>` its address bar shows, so it keeps the key its grants were
 * stored under (main cross-checks that name against the guest's key).
 */
function getRequestDisplayUrl(webview) {
  return getOnchainApp(webview)?.url ||
    applyDnsNameIdentity(getDisplayUrlForWebview(webview), state.knownEnsNames);
}

/**
 * The dApp identity of the visible tab's committed page ('' when none) —
 * the same derivation a request from that tab is keyed on. For chrome that
 * describes the visible tab's dApp connection (the banner) — never for
 * attributing a request; use the requesting webview for that.
 */
export function getActiveDisplayUrl() {
  return activeWebview ? getRequestDisplayUrl(activeWebview) : '';
}

/**
 * The visible tab's committed page URL ('' when none), read exactly as
 * `swarm-provider.js` reads it for a request: without the dApp-only
 * DNS-name mapping above, since the Swarm provider and main's x402
 * attribution both key on the page URL itself.
 */
export function getActivePageUrl() {
  return activeWebview ? getDisplayUrlForWebview(activeWebview) : '';
}

// Methods that act for the site: without a committed URL a page has no
// identity to hold a grant, so these are refused rather than keyed to
// nothing.
const SITE_METHODS = new Set([
  'eth_requestAccounts',
  'wallet_switchEthereumChain',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
]);

/**
 * The wallet's selected chain as a page sees it: "All Chains" (no
 * selection) answers Gnosis.
 */
function selectedChainHex() {
  try {
    const chainId = getSelectedChainId();
    if (chainId) return '0x' + chainId.toString(16);
  } catch {
    // fall through to the default
  }
  return '0x64';
}

async function getCurrentChainId(webview = null) {
  try {
    // A contract-hosted app is part of a particular chain. Pinning provider
    // reads to that authority prevents a background wallet selection or a
    // same-address deployment on another chain from changing its meaning.
    const app = getOnchainApp(webview);
    if (app) return '0x' + app.chainId.toString(16);
  } catch {
    // fall through to the wallet's chain
  }
  return selectedChainHex();
}

/**
 * The chain a page's transaction or signature is for: an onchain app's own
 * chain, else the chain the document was last told (`told`, read when the
 * request arrived), else the wallet's chain. Never the chain saved with the
 * grant, and never a selection change the page hasn't been told about.
 */
function pageChainId(webview, told) {
  const app = getOnchainApp(webview);
  if (app) return app.chainId;
  return parseInt(told ?? selectedChainHex(), 16);
}

/**
 * Tell one page the chain, unless that is what it was last told. A webview
 * whose guest isn't attached (yet, or any more) throws on send: it keeps the
 * chain it was last told, and the other pages are still told.
 */
function tellChain(webview, chainIdHex) {
  if (!webview?.send || getOnchainApp(webview)) return;
  if (toldChains.get(webview) === chainIdHex) return;
  try {
    webview.send('dapp:provider-event', { event: 'chainChanged', data: chainIdHex });
  } catch (err) {
    console.warn('[DappProvider] Could not send chainChanged:', err?.message || err);
    return;
  }
  toldChains.set(webview, chainIdHex);
}

/**
 * The wallet's chain changed (the chain selector, "All Chains", a removed
 * chain's fallback, a page's wallet_switchEthereumChain, an onchain app's
 * connect): tell every page whose last-told chain differs, active or not.
 * An onchain app is pinned to its own chain and is never told.
 */
export function syncPagesToSelectedChain() {
  const chainIdHex = selectedChainHex();
  const targets = new Set(providerWebviews);
  if (activeWebview) targets.add(activeWebview);
  for (const webview of targets) {
    // A closed tab's webview is removed from the DOM without a `destroyed`
    // event reaching us first: drop it rather than keep it (and a failing
    // send) for the rest of the session.
    if (webview.isConnected === false) {
      providerWebviews.delete(webview);
      continue;
    }
    tellChain(webview, chainIdHex);
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

  // The requesting webview's own committed page identity, never the address
  // bar's (#764) — a background tab's request is attributed to its own site.
  const displayUrl = getRequestDisplayUrl(webview);
  const permissionKey = getPermissionKey(displayUrl);

  console.log('[DappProvider] Using permissionKey:', permissionKey);

  // Captured at request arrival; if the webview navigates (or is destroyed)
  // before the async path below settles, neither the result nor the error
  // may be delivered — the reply would land in a replacement document that
  // never made this request.
  const generation = getNavigationGeneration(webview);
  // What this document had been told when it sent the request, read before
  // any await, so a chain change landing while this request is in flight
  // can't move a transaction the page built for the old chain.
  const told = toldChains.get(webview);

  try {
    let result;
    // Set when the answer itself tells the page a chain (eth_chainId,
    // net_version); recorded only if it is actually delivered.
    let answeredChainHex = null;

    if (!permissionKey && SITE_METHODS.has(method)) {
      throw { ...ERRORS.UNAUTHORIZED, message: 'This page has no address to connect from yet' };
    }

    const agentWallet = await offerAgentWalletRequest(
      webview,
      method,
      params,
      displayUrl,
      permissionKey,
      told
    );
    if (getNavigationGeneration(webview) !== generation) return;
    if (agentWallet.handled) {
      if (agentWallet.error) throw agentWallet.error;
      result = agentWallet.result;
      sendProviderResponse(webview, id, result, null);
      return;
    }

    // Handle different method categories
    if (method === 'eth_chainId') {
      result = await getCurrentChainId(webview);
      answeredChainHex = result;
    } else if (method === 'net_version') {
      const chainId = await getCurrentChainId(webview);
      answeredChainHex = chainId;
      result = String(parseInt(chainId, 16));
    } else if (method === 'eth_accounts') {
      // Return connected accounts (empty if not connected)
      const permission = permissionKey
        ? await window.dappPermissions.getPermission(permissionKey)
        : null;
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
        const app = getOnchainApp(webview);
        if (app) setSelectedChainId(app.chainId);
        result = await new Promise((resolve, reject) => {
          showDappConnect(displayUrl, permissionKey, resolve, reject, webview);
        });
        console.log('[DappProvider] Connect UI resolved with:', result);
      }
    } else if (READ_ONLY_METHODS.includes(method)) {
      // Proxy read-only calls to RPC
      result = await proxyRpcCall(webview, method, params, permissionKey);
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

      // The chain this page sees (pageChainId): an onchain app's own
      // chain, else the chain the document was last told, never the chain
      // saved with the grant, which the wallet's chain selector doesn't
      // update. The page built this transaction for it, and the Safe check,
      // the auto-approve rule, the quote and the send all use it.
      const chainId = pageChainId(webview, told);

      assertSafeOnGnosis(permission, chainId, 'transact');

      // Auto-approve only for contract calls with a matching rule (never
      // plain ETH transfers, never Safes — their sends are a multi-step
      // signature ceremony, not a background signature)
      if (!isTabAgentOwned?.(Number(webview.dataset?.tabId)) && !isSafeAccount(permission.walletIndex) && selector && txParams?.to
        && await window.dappPermissions.isTransactionAutoApproved(permissionKey, txParams.to, selector, chainId)
      ) {
        const vaultStatus = await window.identity?.getStatus?.();
        if (!vaultStatus?.isUnlocked) {
          await showVaultUnlock(permissionKey);
        }
        result = await autoApproveTx(permission, txParams, chainId, permissionKey, webview);
      } else {
        result = await showDappTxApproval(webview, permissionKey, txParams, chainId);
      }
    } else if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      const permission = await window.dappPermissions.getPermission(permissionKey);
      if (!permission) {
        throw { ...ERRORS.UNAUTHORIZED, message: 'Not connected. Call eth_requestAccounts first.' };
      }

      // The chain this page sees, as for a transaction: a Safe signs only
      // when that is Gnosis.
      const chainId = pageChainId(webview, told);
      assertSafeOnGnosis(permission, chainId, 'sign');

      if (!isTabAgentOwned?.(Number(webview.dataset?.tabId)) && permission.autoApprove?.signing) {
        const vaultStatus = await window.identity?.getStatus?.();
        if (!vaultStatus?.isUnlocked) {
          await showVaultUnlock(permissionKey);
        }
        result = await autoApproveSign(permission, method, params, permissionKey, webview);
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

    // Send success response — unless the requesting document is gone
    if (getNavigationGeneration(webview) !== generation) return;
    const delivered = sendProviderResponse(webview, id, result, null);
    if (delivered && answeredChainHex && !getOnchainApp(webview)) {
      toldChains.set(webview, answeredChainHex);
    }
  } catch (error) {
    // Never deliver a stale response (success or error) into a replacement
    // document — request ids can be reused across navigations.
    if (getNavigationGeneration(webview) !== generation) return;
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
 * v1 Safes live on Gnosis only: a SafeTx for another chain could never
 * execute, and an EIP-1271 signature only verifies where the contract
 * lives — a clear refusal beats an answer the dApp can't use.
 */
function assertSafeOnGnosis(permission, chainId, verb) {
  if (isSafeAccount(permission.walletIndex) && chainId !== GNOSIS_CHAIN_ID) {
    throw {
      ...ERRORS.INTERNAL_ERROR,
      message: `This multi-owner account can only ${verb} on Gnosis Chain — switch the app to Gnosis first.`,
    };
  }
}

/**
 * Send a transaction without showing the approval UI (auto-approved).
 * Handles gas estimation and signing via wallet IPC.
 */
async function autoApproveTx(permission, txParams, chainId, permissionKey, webview) {
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

  // No confirmation token: main signs only if the requesting guest's own
  // page belongs to this site and its own reading of the site's
  // auto-approve rules covers this exact transaction.
  const result = await window.wallet.dappSendTransaction(
    tx,
    walletIndex,
    buildDappTxContext(permissionKey, txParams),
    { autoApprove: permissionKey, webContentsId: webviewContentsId(webview) }
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
async function autoApproveSign(permission, method, params, permissionKey, webview) {
  const signature = await executeSign(method, params, permission.walletIndex, permissionKey, webview, {
    autoApproved: true,
  });
  window.dappPermissions.updateLastUsed(permissionKey);
  return signature;
}

/**
 * Execute a signing operation via the wallet IPC bridge.
 * Shared by both auto-approve and manual approval paths. `webview` is
 * the requesting page's webview — Safe message sessions are bound to it.
 *
 * Manual approval (the default) is called the moment the user presses
 * Sign: it asks main for a confirmation token bound to exactly this
 * message. `{ autoApproved: true }` sends none — main then checks that
 * the requesting webview's page belongs to `site` (#764) and the site's
 * signing auto-approve itself (security audit O-7).
 */
async function executeSign(method, params, walletIndex, site, webview, { autoApproved = false } = {}) {
  const authorize = (kind, payload) =>
    autoApproved
      ? { autoApprove: site, webContentsId: webviewContentsId(webview) }
      : confirmSigning(kind, walletIndex, payload);
  if (isSafeAccount(walletIndex)) {
    return signViaSafeAccount(method, params, walletIndex, site, webview,
      await authorize('safe-message', { method, params }));
  }
  let result;
  if (method === 'personal_sign') {
    result = await window.wallet.signMessage(params[0], walletIndex,
      await authorize('sign-message', params[0]));
  } else if (method === 'eth_signTypedData_v4') {
    result = await window.wallet.signTypedData(params[1], walletIndex,
      await authorize('sign-typed-data', params[1]));
  } else {
    throw new Error(`Unsupported signing method: ${method}`);
  }
  if (!result.success) throw new Error(result.error || 'Signing failed');
  return result.signature;
}

/**
 * A Safe account signs as a smart contract (EIP-1271): owner signatures
 * are collected over the SafeMessage wrap and concatenated; the dApp
 * verifies via isValidSignature on the Safe. Free vault signatures may
 * satisfy the threshold on their own — the signing board only opens
 * when a device signature is actually needed. Rejects with EIP-1193
 * code 4001 when the user closes the board.
 *
 * The session is bound main-side to this page (site + webview
 * webContents) and guarded by the returned state.token — another tab
 * can neither resume nor replace it, and it dies with the page.
 */
async function signViaSafeAccount(method, params, walletIndex, site, webview, authorization) {
  const display = { kind: 'message', site, method };
  const requester = { origin: site || null, webContentsId: webviewContentsId(webview) };
  const started = await window.wallet.safeMessageStart(
    walletIndex,
    { method, params },
    display,
    requester,
    authorization
  );
  if (!started.success) throw new Error(started.error || 'Signing failed');

  if (started.state?.complete) {
    const done = await window.wallet.safeMessageComplete(walletIndex, started.state.token);
    if (!done.success) throw new Error(done.error || 'Signing failed');
    return done.signature;
  }
  return openSafeMessageBoard(walletIndex, started.state, webview);
}

/** The webview's webContents id, or null when it isn't attached (yet). */
function webviewContentsId(webview) {
  try {
    return webview?.getWebContentsId?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Proxy an RPC call to the main process
 * Uses the chain's capability-aware source order (Myotis, Colibri,
 * RPC quorum, then direct RPC fallback).
 */
async function proxyRpcCall(webview, method, params, origin) {
  // Get current chain ID
  const chainIdHex = await getCurrentChainId(webview);
  const chainId = parseInt(chainIdHex, 16);

  const data = await window.wallet.requestChain(chainId, method, params, { origin });
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
  const app = getOnchainApp(webview);
  if (app && requestedChainId !== app.chainId) {
    throw {
      ...ERRORS.UNSUPPORTED_METHOD,
      message: `This onchain application is pinned to chain ${app.chainId}.`,
    };
  }
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

  // Update wallet UI's selected chain to match; a change tells every page
  // (syncPagesToSelectedChain), this one included
  setSelectedChainId(requestedChainId);

  // ...and when the wallet was already on that chain, still tell this page
  // if it was last told another one
  tellChain(webview, '0x' + requestedChainId.toString(16));

  return null;
}

/**
 * Send a response back to the webview
 */
function sendProviderResponse(webview, id, result, error) {
  console.log('[DappProvider] sendProviderResponse:', { id, result, error, hasWebview: !!webview, hasSend: !!(webview && webview.send) });
  if (!webview || !webview.send) {
    console.error('[DappProvider] Cannot send response - webview or send missing');
    return false;
  }
  // A guest that detached since the request arrived throws on send: nothing
  // was delivered, so the caller records nothing (see tellChain).
  try {
    webview.send('dapp:provider-response', { id, result, error });
  } catch (err) {
    console.warn('[DappProvider] Could not send response:', err?.message || err);
    return false;
  }
  return true;
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

  trackGuestMainFrame(webview);
  providerWebviews.add(webview);
  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'dapp:provider-request') {
      // Only the top frame gets window.ethereum; a request from any other
      // frame would be handled under the top page's grants (audit O-6).
      if (!isFromGuestMainFrame(webview, event)) return;
      const request = event.args[0];
      handleProviderRequest(webview, request);
    }
  });

  // Invalidate in-flight requests when their document goes away, so their
  // responses can never reach the replacement document — and withdraw the
  // Safe signing board it may have opened (its session is gone main-side;
  // the board is owner-scoped, so a successor document's board survives).
  const invalidateDocument = () => {
    navigationGenerations.set(webview, getNavigationGeneration(webview) + 1);
    toldChains.delete(webview);
    abandonSafeMessageBoard(webview);
  };
  webview.addEventListener('did-navigate', invalidateDocument);
  webview.addEventListener('destroyed', () => {
    invalidateDocument();
    providerWebviews.delete(webview);
  });

  // Initialize provider state for this webview
  getProviderState(webview);
}

/**
 * Set the active webview (for sending events)
 */
export function setActiveWebview(webview) {
  activeWebview = webview;

  // Repaint the connection banners for the newly visible tab (they read its
  // committed page identity via getActiveDisplayUrl)
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
 * Tell one page a chain through chainChanged, recorded as what it was told
 * only once the send went through. An onchain app is pinned and never told.
 */
export function emitChainChanged(webview, chainId) {
  tellChain(webview, chainId);
}

/**
 * Emit connect to a webview, which tells the page a chain just as
 * chainChanged does: record it, once delivered, so the page's transactions
 * and signatures go to the chain it was told here. A missing chainId means
 * the wallet's selection, as eth_chainId answers it.
 */
export function emitConnect(webview, chainId) {
  if (!webview?.send) return;
  // No chain (a grant made under "All Chains", no pin): the chain the page
  // would be answered for eth_chainId.
  if (!chainId) chainId = selectedChainHex();
  try {
    webview.send('dapp:provider-event', { event: 'connect', data: { chainId } });
  } catch (err) {
    console.warn('[DappProvider] Could not send connect:', err?.message || err);
    return;
  }
  // An onchain app's chain is its pin, not a record.
  if (!getOnchainApp(webview)) toldChains.set(webview, chainId);
}

/**
 * Emit disconnect event to a webview
 */
export function emitDisconnect(webview, error) {
  sendProviderEvent(webview, 'disconnect', error || { code: 4900, message: 'Disconnected' });
}

// Exported for use by swarm-provider.js and swarm-connect.js
export { getPermissionKey, executeSign, getNavigationGeneration };

// Export state for wallet UI to access
export const walletState = {
  selectedChainId: 100, // Default to Gnosis
};

// Make walletState accessible globally for provider
if (typeof window !== 'undefined') {
  window.walletState = walletState;
}
