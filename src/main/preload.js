const { contextBridge, ipcRenderer } = require('electron');

// Note: Preload scripts run in a sandboxed context where relative requires
// can fail. Using hardcoded strings here for reliability.
// Keep these in sync with src/shared/ipc-channels.js

// Internal pages list — canonical source is src/shared/internal-pages.json,
// served by the main process via sync IPC so preloads don't need require().
const internalPages = ipcRenderer.sendSync('internal:get-pages');

// Environment variable override for the Swarm HTTP API (advanced/dev only).
// BEE_API remains a legacy alias because the endpoint is Bee-compatible.
const defaultAntApi = process.env.ANT_API || process.env.BEE_API || null;

contextBridge.exposeInMainWorld('nodeConfig', {
  antApi: defaultAntApi,
  // Override the openlv signaling relay (remote/phone signing). E2E
  // tests point this at an in-test local MQTT broker for determinism.
  openlvSignaling: process.env.FREEDOM_OPENLV_SIGNALING || null,
});

contextBridge.exposeInMainWorld('internalPages', internalPages);

contextBridge.exposeInMainWorld('electronAPI', {
  setBzzBase: (webContentsId, baseUrl) =>
    ipcRenderer.invoke('bzz:set-base', { webContentsId, baseUrl }),
  clearBzzBase: (webContentsId) => ipcRenderer.invoke('bzz:clear-base', { webContentsId }),
  startSwarmProbe: (hash, path) => ipcRenderer.invoke('bzz:start-probe', { hash, path }),
  awaitSwarmProbe: (id) => ipcRenderer.invoke('bzz:await-probe', { id }),
  cancelSwarmProbe: (id) => ipcRenderer.invoke('bzz:cancel-probe', { id }),
  setRadBase: (webContentsId, baseUrl) =>
    ipcRenderer.invoke('rad:set-base', { webContentsId, baseUrl }),
  clearRadBase: (webContentsId) => ipcRenderer.invoke('rad:clear-base', { webContentsId }),
  setWindowTitle: (title) => ipcRenderer.send('window:set-title', title),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  newWindow: () => ipcRenderer.send('window:new'),
  newPrivateWindow: () => ipcRenderer.send('window:new-private'),
  openUrlInNewWindow: (url) => ipcRenderer.send('window:new-with-url', url),
  showAbout: () => ipcRenderer.send('app:show-about'),
  getPlatform: () => ipcRenderer.invoke('window:get-platform'),
  getWindowButtonLayout: () => ipcRenderer.invoke('window:get-button-layout'),
  getActiveProfile: () => ipcRenderer.invoke('profile:get-active'),
  listProfiles: () => ipcRenderer.invoke('profile:list'),
  createProfile: (input) => ipcRenderer.invoke('profile:create', input),
  openProfile: (id) => ipcRenderer.invoke('profile:open', { id }),
  resolveExternalNodeCandidates: (payload) =>
    ipcRenderer.send('profile:external-candidates-decision', payload),
  onExternalNodeCandidates: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('profile:external-candidates', handler);
    return () => ipcRenderer.removeListener('profile:external-candidates', handler);
  },
  onProfileUpdated: (callback) => {
    const handler = (_event, profile) => callback(profile);
    ipcRenderer.on('profile:updated', handler);
    return () => ipcRenderer.removeListener('profile:updated', handler);
  },
  onShowCreateProfileModal: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('profile:show-create-modal', handler);
    return () => ipcRenderer.removeListener('profile:show-create-modal', handler);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getBookmarks: () => ipcRenderer.invoke('bookmarks:get'),
  addBookmark: (bookmark) => ipcRenderer.invoke('bookmarks:add', bookmark),
  updateBookmark: (originalTarget, bookmark) =>
    ipcRenderer.invoke('bookmarks:update', { originalTarget, bookmark }),
  removeBookmark: (target) => ipcRenderer.invoke('bookmarks:remove', target),
  resolveEns: (name) => ipcRenderer.invoke('ens:resolve', { name }),
  resolveEnsAddress: (name) => ipcRenderer.invoke('ens:resolve-address', { name }),
  resolveEnsReverse: (address) => ipcRenderer.invoke('ens:resolve-reverse', { address }),
  invalidateEnsContent: (name) => ipcRenderer.invoke('ens:invalidate-content', { name }),
  resolveTezosDomain: (name) => ipcRenderer.invoke('tezos-domains:resolve', { name }),
  invalidateTezosDomain: (name) => ipcRenderer.invoke('tezos-domains:invalidate', { name }),
  // History
  getHistory: (options) => ipcRenderer.invoke('history:get', options),
  addHistory: (entry) => ipcRenderer.invoke('history:add', entry),
  removeHistory: (id) => ipcRenderer.invoke('history:remove', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  // Downloads (shelf in the chrome renderer)
  getDownloads: (options) => ipcRenderer.invoke('downloads:get', options),
  pauseDownload: (id) => ipcRenderer.invoke('downloads:pause', id),
  resumeDownload: (id) => ipcRenderer.invoke('downloads:resume', id),
  cancelDownload: (id) => ipcRenderer.invoke('downloads:cancel', id),
  openDownloadedFile: (id) => ipcRenderer.invoke('downloads:open-file', id),
  showDownloadInFolder: (id) => ipcRenderer.invoke('downloads:show-in-folder', id),
  // Main sends this to the download's owning window only; drives the shelf.
  onDownloadUpdated: (callback) => {
    const handler = (_event, download) => callback(download);
    ipcRenderer.on('downloads:updated', handler);
    return () => ipcRenderer.removeListener('downloads:updated', handler);
  },
  // x402 payments. All tab-scoped calls take webContentsId explicitly —
  // the sidebar is the host webContents, not the paying webview.
  x402GetDetails: (args) => ipcRenderer.invoke('x402:get-details', args),
  x402Approve: (args) => ipcRenderer.invoke('x402:approve', args),
  // Subresource approval-card reject (sign-on-click flow). For
  // mainFrame paywall cancel, use x402Cancel (which also navigates the
  // webview).
  x402Reject: (args) => ipcRenderer.invoke('x402:reject', args),
  // Dedicated resume channel for the locked-vault auto-pay flow. Manual
  // approve clicks must use x402Approve and not this — the resume token
  // is consent-source-specific.
  x402ResumeUnlock: (args) => ipcRenderer.invoke('x402:resume-unlock', args),
  // User-initiated balance refresh from the insufficient-funds card.
  x402RefreshBalances: (args) => ipcRenderer.invoke('x402:refresh-balances', args),
  x402Cancel: (args) => ipcRenderer.invoke('x402:cancel', args),
  x402GetReceipts: (options) => ipcRenderer.invoke('x402:get-receipts', options),
  x402GetAllPermissions: () => ipcRenderer.invoke('x402:get-all-permissions'),
  x402RevokePermission: (args) => ipcRenderer.invoke('x402:revoke-permission', args),
  x402RevokeAllForOrigin: (args) => ipcRenderer.invoke('x402:revoke-all-for-origin', args),
  x402UpdatePermission: (args) => ipcRenderer.invoke('x402:update-permission', args),
  // Main fires this when an unsupervised 402 needs approval (no active
  // cap covers the charge). Returns a disposer.
  onX402ApprovalNeeded: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('x402:approval-needed', handler);
    return () => ipcRenderer.removeListener('x402:approval-needed', handler);
  },
  // Main fires this AFTER a subresource sign-after-approve completes
  // (success or failure). x402:approve for the subresource path returns
  // `{ pending: true }` synchronously; the renderer keeps the card in
  // "Signing..." state and listens here for the final outcome.
  onX402ApprovalResult: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('x402:approval-result', handler);
    return () => ipcRenderer.removeListener('x402:approval-result', handler);
  },
  // Main fires this when auto-pay would have fired but the vault is
  // locked. The cap is already authorised; we just need the user to
  // unlock so sign-flow can resume.
  onX402UnlockNeeded: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('x402:unlock-needed', handler);
    return () => ipcRenderer.removeListener('x402:unlock-needed', handler);
  },
  // Main fires this after the inject handler actually decremented a
  // per-origin cap. Silent auto-pay (video segments, lazy paragraphs)
  // never round-trips through the renderer otherwise, so the auto-pay
  // banner's spend counter would stay stale until the next navigation.
  onX402CapConsumed: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('x402:cap-consumed', handler);
    return () => ipcRenderer.removeListener('x402:cap-consumed', handler);
  },
  // Background fresh-balance refresh result for the approval card's
  // chooser rows. Main kicks the refresh on x402:get-details and
  // broadcasts here when it lands. Pinned-selection semantics live on
  // the renderer side: balances + fundability indicators update in
  // place, but the user's current selection is never changed
  // implicitly.
  onX402BalancesUpdated: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('x402:balances-updated', handler);
    return () => ipcRenderer.removeListener('x402:balances-updated', handler);
  },
  // Internal
  getWebviewPreloadPath: () => ipcRenderer.invoke('internal:get-webview-preload-path'),
  // Context menu
  saveImage: (imageUrl) => ipcRenderer.invoke('context-menu:save-image', imageUrl),
  // Clipboard
  copyText: (text) => ipcRenderer.invoke('clipboard:copy-text', text),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  copyImageFromUrl: (imageUrl) => ipcRenderer.invoke('clipboard:copy-image', imageUrl),
  // Favicons
  getFavicon: (url) => ipcRenderer.invoke('favicon:get', url),
  getCachedFavicon: (url) => ipcRenderer.invoke('favicon:get-cached', url),
  fetchFavicon: (url) => ipcRenderer.invoke('favicon:fetch', url),
  fetchFaviconWithKey: (fetchUrl, cacheKey) =>
    ipcRenderer.invoke('favicon:fetch-with-key', fetchUrl, cacheKey),
  // Tab menu handlers
  onNewTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tab:new', handler);
    return () => ipcRenderer.removeListener('tab:new', handler);
  },
  onCloseTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tab:close', handler);
    return () => ipcRenderer.removeListener('tab:close', handler);
  },
  onNewTabWithUrl: (callback) => {
    const handler = (_event, url, targetName) => callback(url, targetName);
    ipcRenderer.on('tab:new-with-url', handler);
    return () => ipcRenderer.removeListener('tab:new-with-url', handler);
  },
  onOpenPublishSetup: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('sidebar:open-publish-setup', handler);
    return () => ipcRenderer.removeListener('sidebar:open-publish-setup', handler);
  },
  onNavigateToUrl: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('navigate-to-url', handler);
    return () => ipcRenderer.removeListener('navigate-to-url', handler);
  },
  onLoadUrl: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('tab:load-url', handler);
    return () => ipcRenderer.removeListener('tab:load-url', handler);
  },
  onToggleDevTools: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('devtools:toggle', handler);
    return () => ipcRenderer.removeListener('devtools:toggle', handler);
  },
  onCloseDevTools: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('devtools:close', handler);
    return () => ipcRenderer.removeListener('devtools:close', handler);
  },
  onCloseAllDevTools: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('devtools:close-all', handler);
    return () => ipcRenderer.removeListener('devtools:close-all', handler);
  },
  onFocusAddressBar: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('focus:address-bar', handler);
    return () => ipcRenderer.removeListener('focus:address-bar', handler);
  },
  onCloseMenus: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menus:close', handler);
    return () => ipcRenderer.removeListener('menus:close', handler);
  },
  onReload: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('page:reload', handler);
    return () => ipcRenderer.removeListener('page:reload', handler);
  },
  onHardReload: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('page:hard-reload', handler);
    return () => ipcRenderer.removeListener('page:hard-reload', handler);
  },
  onNextTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tab:next', handler);
    return () => ipcRenderer.removeListener('tab:next', handler);
  },
  onPrevTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tab:prev', handler);
    return () => ipcRenderer.removeListener('tab:prev', handler);
  },
  onMoveTabLeft: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tab:move-left', handler);
    return () => ipcRenderer.removeListener('tab:move-left', handler);
  },
  onMoveTabRight: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tab:move-right', handler);
    return () => ipcRenderer.removeListener('tab:move-right', handler);
  },
  onReopenClosedTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tab:reopen-closed', handler);
    return () => ipcRenderer.removeListener('tab:reopen-closed', handler);
  },
  onOpenFindBar: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('find:open', handler);
    return () => ipcRenderer.removeListener('find:open', handler);
  },
  updateTabMenuState: (state) => ipcRenderer.send('menu:update-tab-state', state),
  setBookmarkBarToggleEnabled: (enabled) =>
    ipcRenderer.send('menu:set-bookmark-bar-toggle-enabled', enabled),
  setBookmarkBarChecked: (checked) => ipcRenderer.send('menu:set-bookmark-bar-checked', checked),
  onToggleBookmarkBar: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('bookmarks:toggle-bar', handler);
    return () => ipcRenderer.removeListener('bookmarks:toggle-bar', handler);
  },
  // Update notifications
  onUpdateNotification: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('show-update-notification', handler);
    return () => ipcRenderer.removeListener('show-update-notification', handler);
  },
  restartAndInstallUpdate: () => ipcRenderer.send('update:restart-and-install'),
  checkForUpdates: () => ipcRenderer.send('update:check'),
});

// Re-dispatch main-process broadcasts as window CustomEvents so existing
// renderer listeners can subscribe via plain DOM `addEventListener` —
// no need to thread an unsubscribe through preload.
function reDispatchAsWindowEvent(channel) {
  ipcRenderer.on(channel, (_event, detail) => {
    try {
      window.dispatchEvent(new CustomEvent(channel, { detail }));
    } catch {
      // Window may be closing
    }
  });
}
reDispatchAsWindowEvent('settings:updated');
reDispatchAsWindowEvent('payments:tx-recorded');

contextBridge.exposeInMainWorld('ant', {
  start: () => ipcRenderer.invoke('ant:start'),
  stop: () => ipcRenderer.invoke('ant:stop'),
  getStatus: () => ipcRenderer.invoke('ant:getStatus'),
  checkBinary: () => ipcRenderer.invoke('ant:checkBinary'),
  onStatusUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('ant:statusUpdate', handler);
    ipcRenderer.invoke('ant:getStatus').then(callback);
    return () => ipcRenderer.removeListener('ant:statusUpdate', handler);
  },
});

contextBridge.exposeInMainWorld('myotis', {
  start: (chainId) => chainId == null
    ? ipcRenderer.invoke('myotis:start')
    : ipcRenderer.invoke('myotis:start', chainId),
  stop: (chainId) => chainId == null
    ? ipcRenderer.invoke('myotis:stop')
    : ipcRenderer.invoke('myotis:stop', chainId),
  getStatus: (chainId) => chainId == null
    ? ipcRenderer.invoke('myotis:getStatus')
    : ipcRenderer.invoke('myotis:getStatus', chainId),
  onStatusUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('myotis:statusUpdate', handler);
    // The eager snapshot is best-effort; live status events continue to work
    // if startup races handler registration or the window is already closing.
    ipcRenderer.invoke('myotis:getStatus').then(callback).catch(() => {});
    return () => ipcRenderer.removeListener('myotis:statusUpdate', handler);
  },
});

contextBridge.exposeInMainWorld('ipfs', {
  start: () => ipcRenderer.invoke('ipfs:start'),
  stop: () => ipcRenderer.invoke('ipfs:stop'),
  getStatus: () => ipcRenderer.invoke('ipfs:getStatus'),
  checkBinary: () => ipcRenderer.invoke('ipfs:checkBinary'),
  onStatusUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('ipfs:statusUpdate', handler);
    ipcRenderer.invoke('ipfs:getStatus').then(callback);
    return () => ipcRenderer.removeListener('ipfs:statusUpdate', handler);
  },
});

contextBridge.exposeInMainWorld('radicle', {
  getAlias: () => ipcRenderer.invoke('radicle:get-alias'),
  setAlias: (alias) => ipcRenderer.invoke('radicle:set-alias', alias),
  start: () => ipcRenderer.invoke('radicle:start'),
  stop: () => ipcRenderer.invoke('radicle:stop'),
  getStatus: () => ipcRenderer.invoke('radicle:getStatus'),
  checkBinary: () => ipcRenderer.invoke('radicle:checkBinary'),
  getConnections: () => ipcRenderer.invoke('radicle:getConnections'),
  onStatusUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('radicle:statusUpdate', handler);
    ipcRenderer.invoke('radicle:getStatus').then(callback);
    return () => ipcRenderer.removeListener('radicle:statusUpdate', handler);
  },
});

contextBridge.exposeInMainWorld('tor', {
  start: () => ipcRenderer.invoke('tor:start'),
  stop: () => ipcRenderer.invoke('tor:stop'),
  getStatus: () => ipcRenderer.invoke('tor:getStatus'),
  checkBinary: () => ipcRenderer.invoke('tor:checkBinary'),
  getVersion: () => ipcRenderer.invoke('tor:getVersion'),
  onStatusUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('tor:statusUpdate', handler);
    ipcRenderer.invoke('tor:getStatus').then(callback);
    return () => ipcRenderer.removeListener('tor:statusUpdate', handler);
  },
});

contextBridge.exposeInMainWorld('githubBridge', {
  import: (url) => ipcRenderer.invoke('github-bridge:import', url),
  checkGit: () => ipcRenderer.invoke('github-bridge:check-git'),
  checkPrerequisites: () => ipcRenderer.invoke('github-bridge:check-prerequisites'),
  validateUrl: (url) => ipcRenderer.invoke('github-bridge:validate-url', url),
  checkExisting: (url) => ipcRenderer.invoke('github-bridge:check-existing', url),
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('github-bridge:progress', handler);
    return () => ipcRenderer.removeListener('github-bridge:progress', handler);
  },
});

contextBridge.exposeInMainWorld('serviceRegistry', {
  getRegistry: () => ipcRenderer.invoke('service-registry:get'),
  onUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('service-registry:update', handler);
    return () => ipcRenderer.removeListener('service-registry:update', handler);
  },
});

contextBridge.exposeInMainWorld('identity', {
  hasVault: () => ipcRenderer.invoke('identity:has-vault'),
  isUnlocked: () => ipcRenderer.invoke('identity:is-unlocked'),
  getStatus: () => ipcRenderer.invoke('identity:get-status'),
  getVaultMeta: () => ipcRenderer.invoke('identity:get-vault-meta'),
  generateMnemonic: (strength = 256) => ipcRenderer.invoke('identity:generate-mnemonic', strength),
  createVault: (password, strength = 256, userKnowsPassword = true) =>
    ipcRenderer.invoke('identity:create-vault', password, strength, userKnowsPassword),
  importMnemonic: (password, mnemonic, userKnowsPassword = true) =>
    ipcRenderer.invoke('identity:import-mnemonic', password, mnemonic, userKnowsPassword),
  unlock: (password) => ipcRenderer.invoke('identity:unlock', password),
  lock: () => ipcRenderer.invoke('identity:lock'),
  injectAll: (radicleAlias = 'FreedomBrowser', force = false) =>
    ipcRenderer.invoke('identity:inject-all', radicleAlias, force),
  exportMnemonic: (password) => ipcRenderer.invoke('identity:export-mnemonic', password),
  exportPrivateKey: (accountIndex, password) =>
    ipcRenderer.invoke('identity:export-private-key', accountIndex, password),
  changePassword: (currentPassword, newPassword) =>
    ipcRenderer.invoke('identity:change-password', currentPassword, newPassword),
  deleteVault: (password) => ipcRenderer.invoke('identity:delete-vault', password),
  validateMnemonic: (mnemonic) => ipcRenderer.invoke('identity:validate-mnemonic', mnemonic),
});

contextBridge.exposeInMainWorld('quickUnlock', {
  canUseTouchId: () => ipcRenderer.invoke('quick-unlock:can-use-touch-id'),
  isEnabled: () => ipcRenderer.invoke('quick-unlock:is-enabled'),
  enable: (password) => ipcRenderer.invoke('quick-unlock:enable', password),
  unlock: () => ipcRenderer.invoke('quick-unlock:unlock'),
  disable: () => ipcRenderer.invoke('quick-unlock:disable'),
});

contextBridge.exposeInMainWorld('wallet', {
  // Balance operations
  getBalances: (address) => ipcRenderer.invoke('wallet:get-balances', address),
  getBalancesCached: (address) => ipcRenderer.invoke('wallet:get-balances-cached', address),
  clearBalanceCache: (address) => ipcRenderer.invoke('wallet:clear-balance-cache', address),

  // Chain info
  getChain: (chainId) => ipcRenderer.invoke('wallet:get-chain', chainId),
  getChains: () => ipcRenderer.invoke('wallet:get-chains'),
  testProvider: (chainId) => ipcRenderer.invoke('wallet:test-provider', chainId),

  // Multi-wallet operations
  getDerivedWallets: () => ipcRenderer.invoke('wallet:get-derived-wallets'),
  getActiveIndex: () => ipcRenderer.invoke('wallet:get-active-index'),
  setActiveWallet: (index) => ipcRenderer.invoke('wallet:set-active-wallet', index),
  createDerivedWallet: (name) => ipcRenderer.invoke('wallet:create-derived-wallet', name),
  renameWallet: (index, newName) => ipcRenderer.invoke('wallet:rename-wallet', index, newName),
  deleteWallet: (index) => ipcRenderer.invoke('wallet:delete-wallet', index),
  getActiveAddress: () => ipcRenderer.invoke('wallet:get-active-address'),

  // QR code generation
  generateQR: (text, options) => ipcRenderer.invoke('wallet:generate-qr', text, options),

  // Transaction operations
  estimateGas: (params) => ipcRenderer.invoke('wallet:estimate-gas', params),
  getGasPrice: (chainId) => ipcRenderer.invoke('wallet:get-gas-price', chainId),
  buildErc20Data: (to, amount) => ipcRenderer.invoke('wallet:build-erc20-data', to, amount),
  parseAmount: (amount, decimals) => ipcRenderer.invoke('wallet:parse-amount', amount, decimals),
  sendTransaction: (params, context) =>
    ipcRenderer.invoke('wallet:send-transaction', params, context),
  getTransactionStatus: (txHash, chainId) =>
    ipcRenderer.invoke('wallet:get-transaction-status', txHash, chainId),
  waitForTransaction: (txHash, chainId, confirmations) =>
    ipcRenderer.invoke('wallet:wait-for-transaction', txHash, chainId, confirmations),

  // dApp-specific operations (use specific wallet index)
  dappSendTransaction: (params, walletIndex, context) =>
    ipcRenderer.invoke('wallet:dapp-send-transaction', params, walletIndex, context),
  signMessage: (message, walletIndex) =>
    ipcRenderer.invoke('wallet:sign-message', message, walletIndex),
  signTypedData: (typedData, walletIndex) =>
    ipcRenderer.invoke('wallet:sign-typed-data', typedData, walletIndex),

  // RPC proxy (renderer CSP blocks direct fetch to external endpoints)
  proxyRpc: (rpcUrl, method, params) =>
    ipcRenderer.invoke('wallet:proxy-rpc', { rpcUrl, method, params }),
  requestChain: (chainId, method, params) =>
    ipcRenderer.invoke('wallet:chain-request', { chainId, method, params }),

  // Safe multisig accounts
  createSafe: (name, ownerIndexes, threshold) =>
    ipcRenderer.invoke('wallet:create-safe', name, ownerIndexes, threshold),
  getSafeStatus: (index) => ipcRenderer.invoke('wallet:get-safe-status', index),
  activateSafe: (index) => ipcRenderer.invoke('wallet:activate-safe', index),
  // Safe sends (the signing board): every call returns {success, state}
  // where state is the board's render model (null when nothing pending).
  safeSend: (safeIndex, tx, display) => ipcRenderer.invoke('wallet:safe-send', safeIndex, tx, display),
  safeSign: (safeIndex, ownerIndex) => ipcRenderer.invoke('wallet:safe-sign', safeIndex, ownerIndex),
  safeExecute: (safeIndex) => ipcRenderer.invoke('wallet:safe-execute', safeIndex),
  safeState: (safeIndex) => ipcRenderer.invoke('wallet:safe-state', safeIndex),
  safeCancelPending: (index) => ipcRenderer.invoke('wallet:safe-cancel-pending', index),
  safePendingList: () => ipcRenderer.invoke('wallet:safe-pending-list'),
  // SafeMessage sessions (dApp message signing via EIP-1271). start
  // binds the session to the requesting page ({origin, webContentsId})
  // and returns state.token — required by every other call.
  safeMessageStart: (safeIndex, request, display, requester) =>
    ipcRenderer.invoke('wallet:safe-message-start', safeIndex, request, display, requester),
  safeMessageSign: (safeIndex, ownerIndex, token) =>
    ipcRenderer.invoke('wallet:safe-message-sign', safeIndex, ownerIndex, token),
  safeMessageState: (safeIndex, token) =>
    ipcRenderer.invoke('wallet:safe-message-state', safeIndex, token),
  safeMessageCancel: (safeIndex, token) =>
    ipcRenderer.invoke('wallet:safe-message-cancel', safeIndex, token),
  safeMessageComplete: (safeIndex, token) =>
    ipcRenderer.invoke('wallet:safe-message-complete', safeIndex, token),
});

contextBridge.exposeInMainWorld('ledger', {
  getAccounts: (options) => ipcRenderer.invoke('ledger:get-accounts', options),
  addAccount: (name, address, path) => ipcRenderer.invoke('wallet:add-ledger-wallet', name, address, path),
});

// Remote (phone) signing: main publishes signing jobs here; the renderer
// session broker (lib/wallet/remote-session.js) shows the QR, tunnels the
// request to the phone over openlv, and responds with the result.
contextBridge.exposeInMainWorld('remoteSigner', {
  // Main asks the renderer to run a signing job. Returns a disposer.
  onRequest: (callback) => {
    const handler = (_event, job) => callback(job);
    ipcRenderer.on('remote-signer:request', handler);
    return () => ipcRenderer.removeListener('remote-signer:request', handler);
  },
  // Main gave up on a job (timeout) — close its QR dialog. Returns a disposer.
  onAbort: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('remote-signer:abort', handler);
    return () => ipcRenderer.removeListener('remote-signer:abort', handler);
  },
  // Job outcome: { jobId, result } or { jobId, error: {code, message} }.
  respond: (payload) => ipcRenderer.send('remote-signer:response', payload),
  // Persist a phone account discovered via eth_requestAccounts.
  addAccount: (name, address) => ipcRenderer.invoke('wallet:add-remote-wallet', name, address),
});

contextBridge.exposeInMainWorld('swarmNode', {
  getStamps: () => ipcRenderer.invoke('swarm:get-stamps'),
  getStorageCost: (sizeGB, durationDays) =>
    ipcRenderer.invoke('swarm:get-storage-cost', sizeGB, durationDays),
  buyStorage: (sizeGB, durationDays) =>
    ipcRenderer.invoke('swarm:buy-storage', sizeGB, durationDays),
  getDurationExtensionCost: (batchId, additionalDays) =>
    ipcRenderer.invoke('swarm:get-duration-extension-cost', batchId, additionalDays),
  getSizeExtensionCost: (batchId, newSizeGB) =>
    ipcRenderer.invoke('swarm:get-size-extension-cost', batchId, newSizeGB),
  extendStorageDuration: (batchId, additionalDays) =>
    ipcRenderer.invoke('swarm:extend-storage-duration', batchId, additionalDays),
  extendStorageSize: (batchId, newSizeGB) =>
    ipcRenderer.invoke('swarm:extend-storage-size', batchId, newSizeGB),
  getChequebookBalance: () => ipcRenderer.invoke('swarm:get-chequebook-balance'),
  depositChequebook: (amountBzz) => ipcRenderer.invoke('swarm:deposit-chequebook', amountBzz),
  publishData: (data) => ipcRenderer.invoke('swarm:publish-data', data),
  publishFile: (filePath) => ipcRenderer.invoke('swarm:publish-file', filePath),
  publishDirectory: (dirPath) => ipcRenderer.invoke('swarm:publish-directory', dirPath),
  getUploadStatus: (tagUid) => ipcRenderer.invoke('swarm:get-upload-status', tagUid),
});

contextBridge.exposeInMainWorld('networks', {
  getChains: () => ipcRenderer.invoke('networks:get-chains'),
  getChain: (chainId) => ipcRenderer.invoke('networks:get-chain', chainId),
  getAvailableChains: () => ipcRenderer.invoke('networks:get-available-chains'),
  isChainAvailable: (chainId) => ipcRenderer.invoke('networks:is-chain-available', chainId),
  addChain: (chain, rpcUrls) => ipcRenderer.invoke('networks:add-chain', chain, rpcUrls),
  removeChain: (chainId) => ipcRenderer.invoke('networks:remove-chain', chainId),
});

// Unified payment history. The renderer (Wallet sidebar mini-section,
// future freedom://payments page) reads from this — never writes.
// Producers (x402 intercept, wallet/dapp sends) record in main directly.
contextBridge.exposeInMainWorld('payments', {
  getRecent: (filters) => ipcRenderer.invoke('payments:get-recent', filters),
  getById: (id) => ipcRenderer.invoke('payments:get-by-id', id),
  getCount: (filters) => ipcRenderer.invoke('payments:get-count', filters),
});

contextBridge.exposeInMainWorld('tokens', {
  getTokens: (chainId) => ipcRenderer.invoke('tokens:get-tokens', chainId),
  getToken: (key) => ipcRenderer.invoke('tokens:get-token', key),
  addToken: (token) => ipcRenderer.invoke('tokens:add-token', token),
  removeToken: (key) => ipcRenderer.invoke('tokens:remove-token', key),
});

contextBridge.exposeInMainWorld('rpcManager', {
  // Effective RPC URLs for a chain — the registry's resolved rpc pool.
  // Used by the injected dApp provider; provider/API-key management now
  // lives on the Networks settings page.
  getEffectiveUrls: (chainId) => ipcRenderer.invoke('rpc:get-effective-urls', chainId),
});

// Site permissions (web permission prompts). The chrome renderer shows
// the anchored prompt + the address-bar indicator; both live here.
contextBridge.exposeInMainWorld('sitePermissions', {
  // Main asks this window to show a prompt
  // ({id, origin, permission, keys, guestId}). `guestId` is the requesting
  // webview's webContents id; the prompt only shows while that tab is active.
  onPromptRequest: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('permissions:prompt-request', handler);
    return () => ipcRenderer.removeListener('permissions:prompt-request', handler);
  },
  // Main withdraws a prompt ({id}): the requesting document navigated away
  // or its webContents was destroyed (already denied once on the main side).
  onPromptCancel: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('permissions:prompt-cancel', handler);
    return () => ipcRenderer.removeListener('permissions:prompt-cancel', handler);
  },
  // Answer a prompt: {id, decision: 'allow'|'deny'|'dismiss', remember}.
  respondToPrompt: (response) => ipcRenderer.invoke('permissions:prompt-response', response),
  // macOS blocked camera/mic for Freedom itself after a site-level allow.
  onOsDenied: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('permissions:os-denied', handler);
    return () => ipcRenderer.removeListener('permissions:os-denied', handler);
  },
  onChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('permissions:changed', handler);
    return () => ipcRenderer.removeListener('permissions:changed', handler);
  },
  getForOrigin: (origin) => ipcRenderer.invoke('permissions:get-for-origin', origin),
  revoke: (origin, permission) => ipcRenderer.invoke('permissions:revoke', origin, permission),
  revokeOrigin: (origin) => ipcRenderer.invoke('permissions:revoke-origin', origin),
});

contextBridge.exposeInMainWorld('dappPermissions', {
  getPermission: (origin) => ipcRenderer.invoke('dapp:get-permission', origin),
  grantPermission: (origin, walletIndex, chainId) =>
    ipcRenderer.invoke('dapp:grant-permission', origin, walletIndex, chainId),
  revokePermission: (origin) => ipcRenderer.invoke('dapp:revoke-permission', origin),
  getAllPermissions: () => ipcRenderer.invoke('dapp:get-all-permissions'),
  updateLastUsed: (origin, chainId) => ipcRenderer.invoke('dapp:update-last-used', origin, chainId),
  getSigningAutoApprove: (origin) => ipcRenderer.invoke('dapp:get-signing-auto-approve', origin),
  setSigningAutoApprove: (origin, enabled) =>
    ipcRenderer.invoke('dapp:set-signing-auto-approve', origin, enabled),
  isTransactionAutoApproved: (origin, to, selector, chainId) =>
    ipcRenderer.invoke('dapp:is-tx-auto-approved', origin, to, selector, chainId),
  addTransactionAutoApprove: (origin, to, selector, chainId) =>
    ipcRenderer.invoke('dapp:add-tx-auto-approve', origin, to, selector, chainId),
  removeTransactionAutoApprove: (origin, to, selector, chainId) =>
    ipcRenderer.invoke('dapp:remove-tx-auto-approve', origin, to, selector, chainId),
});

contextBridge.exposeInMainWorld('swarmPermissions', {
  getPermission: (origin) => ipcRenderer.invoke('swarm:get-permission', origin),
  grantPermission: (origin) => ipcRenderer.invoke('swarm:grant-permission', origin),
  revokePermission: (origin) => ipcRenderer.invoke('swarm:revoke-permission', origin),
  getAllPermissions: () => ipcRenderer.invoke('swarm:get-all-permissions'),
  updateLastUsed: (origin) => ipcRenderer.invoke('swarm:update-last-used', origin),
  getAutoApprove: (origin, type) => ipcRenderer.invoke('swarm:get-auto-approve', origin, type),
  setAutoApprove: (origin, type, enabled) =>
    ipcRenderer.invoke('swarm:set-auto-approve', origin, type, enabled),
  grantMessaging: (origin) => ipcRenderer.invoke('swarm:grant-messaging', origin),
  revokeMessaging: (origin) => ipcRenderer.invoke('swarm:revoke-messaging', origin),
  hasMessagingGrant: (origin) => ipcRenderer.invoke('swarm:has-messaging-grant', origin),
});

contextBridge.exposeInMainWorld('swarmManifest', {
  check: (request) => ipcRenderer.invoke('swarm:manifest-check', request),
  decide: (token, outcome) => ipcRenderer.invoke('swarm:manifest-decide', { token, outcome }),
  get: (origin) => ipcRenderer.invoke('swarm:manifest-get', origin),
  useIndividual: (origin, capability) => ipcRenderer.invoke('swarm:manifest-use-individual', { origin, capability }),
  disconnect: (origin) => ipcRenderer.invoke('swarm:manifest-disconnect', origin),
});

contextBridge.exposeInMainWorld('swarmProvider', {
  // meta carries renderer-only routing info (e.g. the subscribing
  // webview's webContentsId for swarm_subscribe message delivery).
  execute: (method, params, origin, meta) =>
    ipcRenderer.invoke('swarm:provider-execute', { method, params, origin, meta }),
});

// Page-facing Radicle provider plumbing. Distinct from the host-chrome
// `window.radicle` namespace above (node lifecycle controls) — these back
// the consent flow and authority calls for the injected page provider.
contextBridge.exposeInMainWorld('radiclePermissions', {
  getPermission: (origin) => ipcRenderer.invoke('radicle:get-permission', origin),
  grantPermission: (origin) => ipcRenderer.invoke('radicle:grant-permission', origin),
  revokePermission: (origin) => ipcRenderer.invoke('radicle:revoke-permission', origin),
  getAllPermissions: () => ipcRenderer.invoke('radicle:get-all-permissions'),
  updateLastUsed: (origin) => ipcRenderer.invoke('radicle:update-last-used', origin),
  hasSigningGrant: (origin) => ipcRenderer.invoke('radicle:has-signing-grant', origin),
  grantSigning: (origin) => ipcRenderer.invoke('radicle:grant-signing', origin),
  getAutoApprove: (origin, type) => ipcRenderer.invoke('radicle:get-auto-approve', origin, type),
  setAutoApprove: (origin, type, enabled) =>
    ipcRenderer.invoke('radicle:set-auto-approve', origin, type, enabled),
});

contextBridge.exposeInMainWorld('radicleProvider', {
  execute: (method, params, origin) =>
    ipcRenderer.invoke('radicle:provider-execute', { method, params, origin }),
});

contextBridge.exposeInMainWorld('swarmFeedStore', {
  getAllOrigins: () => ipcRenderer.invoke('swarm:get-all-origins'),
  hasFeedIdentity: (origin) => ipcRenderer.invoke('swarm:has-feed-identity', origin),
  hasFeedGrant: (origin) => ipcRenderer.invoke('swarm:has-feed-grant', origin),
  getIdentityMode: (origin) => ipcRenderer.invoke('swarm:get-identity-mode', origin),
  getOriginIdentities: (origin) => ipcRenderer.invoke('swarm:get-origin-identities', origin),
  previewAppScopedIdentity: (origin, options) =>
    ipcRenderer.invoke('swarm:preview-app-scoped-identity', origin, options),
  createAppScopedIdentity: (origin, options) =>
    ipcRenderer.invoke('swarm:create-app-scoped-identity', origin, options),
  ensureAntWalletIdentity: (origin, options) =>
    ipcRenderer.invoke('swarm:ensure-ant-wallet-identity', origin, options),
  ensureEthereumWalletIdentity: (origin, walletIndex, options) =>
    ipcRenderer.invoke('swarm:ensure-ethereum-wallet-identity', origin, walletIndex, options),
  activateFeedIdentity: (origin, identityId) =>
    ipcRenderer.invoke('swarm:activate-feed-identity', origin, identityId),
  setFeedIdentity: (origin, identityMode) =>
    ipcRenderer.invoke('swarm:set-feed-identity', origin, identityMode),
  revokeFeedAccess: (origin) => ipcRenderer.invoke('swarm:revoke-feed-access', origin),
});
