const { contextBridge, ipcRenderer } = require('electron');

// Note: Preload scripts run in a sandboxed context where relative requires
// can fail. Using hardcoded strings here for reliability.
// Keep these in sync with src/shared/ipc-channels.js

// Internal pages list — canonical source is src/shared/internal-pages.json,
// served by the main process via sync IPC so preloads don't need require().
const internalPages = ipcRenderer.sendSync('internal:get-pages');

// Environment variable overrides for gateways (for advanced users)
const defaultBeeApi = process.env.BEE_API || 'http://127.0.0.1:1633';
// Gateway uses `localhost` (not 127.0.0.1) so Kubo's default subdomain-gateway
// PublicGateways entry kicks in — required for `_redirects` file support.
const defaultIpfsGateway = process.env.IPFS_GATEWAY || 'http://localhost:8080';

contextBridge.exposeInMainWorld('nodeConfig', {
  beeApi: defaultBeeApi,
  ipfsGateway: defaultIpfsGateway,
});

contextBridge.exposeInMainWorld('internalPages', internalPages);

contextBridge.exposeInMainWorld('electronAPI', {
  setBzzBase: (webContentsId, baseUrl) =>
    ipcRenderer.invoke('bzz:set-base', { webContentsId, baseUrl }),
  clearBzzBase: (webContentsId) => ipcRenderer.invoke('bzz:clear-base', { webContentsId }),
  setIpfsBase: (webContentsId, baseUrl) =>
    ipcRenderer.invoke('ipfs:set-base', { webContentsId, baseUrl }),
  clearIpfsBase: (webContentsId) => ipcRenderer.invoke('ipfs:clear-base', { webContentsId }),
  setRadBase: (webContentsId, baseUrl) =>
    ipcRenderer.invoke('rad:set-base', { webContentsId, baseUrl }),
  clearRadBase: (webContentsId) => ipcRenderer.invoke('rad:clear-base', { webContentsId }),
  setWindowTitle: (title) => ipcRenderer.send('window:set-title', title),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  newWindow: () => ipcRenderer.send('window:new'),
  openUrlInNewWindow: (url) => ipcRenderer.send('window:new-with-url', url),
  showAbout: () => ipcRenderer.send('app:show-about'),
  getPlatform: () => ipcRenderer.invoke('window:get-platform'),
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
  testEnsRpc: (url) => ipcRenderer.invoke('ens:test-rpc', { url }),
  // History
  getHistory: (options) => ipcRenderer.invoke('history:get', options),
  addHistory: (entry) => ipcRenderer.invoke('history:add', entry),
  removeHistory: (id) => ipcRenderer.invoke('history:remove', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  // Internal
  getWebviewPreloadPath: () => ipcRenderer.invoke('internal:get-webview-preload-path'),
  // Context menu
  saveImage: (imageUrl) => ipcRenderer.invoke('context-menu:save-image', imageUrl),
  // Clipboard
  copyText: (text) => ipcRenderer.invoke('clipboard:copy-text', text),
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
  updateTabMenuState: (state) => ipcRenderer.send('menu:update-tab-state', state),
  setBookmarkBarToggleEnabled: (enabled) =>
    ipcRenderer.send('menu:set-bookmark-bar-toggle-enabled', enabled),
  setBookmarkBarChecked: (checked) =>
    ipcRenderer.send('menu:set-bookmark-bar-checked', checked),
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

// Re-dispatch main-process settings:updated broadcasts as a window CustomEvent
// so existing renderer listeners (theme, radicle, sidebar, wallet, etc.) work
// regardless of which UI surface triggered the save.
ipcRenderer.on('settings:updated', (_event, settings) => {
  try {
    window.dispatchEvent(new CustomEvent('settings:updated', { detail: settings }));
  } catch {
    // Window may be closing
  }
});

contextBridge.exposeInMainWorld('bee', {
  start: () => ipcRenderer.invoke('bee:start'),
  stop: () => ipcRenderer.invoke('bee:stop'),
  getStatus: () => ipcRenderer.invoke('bee:getStatus'),
  checkBinary: () => ipcRenderer.invoke('bee:checkBinary'),
  onStatusUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('bee:statusUpdate', handler);
    ipcRenderer.invoke('bee:getStatus').then(callback);
    return () => ipcRenderer.removeListener('bee:statusUpdate', handler);
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
  injectAll: (radicleAlias = 'FreedomBrowser', force = false) => ipcRenderer.invoke('identity:inject-all', radicleAlias, force),
  exportMnemonic: (password) => ipcRenderer.invoke('identity:export-mnemonic', password),
  exportPrivateKey: (accountIndex, password) => ipcRenderer.invoke('identity:export-private-key', accountIndex, password),
  changePassword: (currentPassword, newPassword) => ipcRenderer.invoke('identity:change-password', currentPassword, newPassword),
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
  sendTransaction: (params) => ipcRenderer.invoke('wallet:send-transaction', params),
  getTransactionStatus: (txHash, chainId) => ipcRenderer.invoke('wallet:get-transaction-status', txHash, chainId),
  waitForTransaction: (txHash, chainId, confirmations) => ipcRenderer.invoke('wallet:wait-for-transaction', txHash, chainId, confirmations),

  // dApp-specific operations (use specific wallet index)
  dappSendTransaction: (params, walletIndex) => ipcRenderer.invoke('wallet:dapp-send-transaction', params, walletIndex),
  signMessage: (message, walletIndex) => ipcRenderer.invoke('wallet:sign-message', message, walletIndex),
  signTypedData: (typedData, walletIndex) => ipcRenderer.invoke('wallet:sign-typed-data', typedData, walletIndex),

  // RPC proxy (renderer CSP blocks direct fetch to external endpoints)
  proxyRpc: (rpcUrl, method, params) => ipcRenderer.invoke('wallet:proxy-rpc', { rpcUrl, method, params }),
});

contextBridge.exposeInMainWorld('swarmNode', {
  getStamps: () => ipcRenderer.invoke('swarm:get-stamps'),
  getStorageCost: (sizeGB, durationDays) => ipcRenderer.invoke('swarm:get-storage-cost', sizeGB, durationDays),
  buyStorage: (sizeGB, durationDays) => ipcRenderer.invoke('swarm:buy-storage', sizeGB, durationDays),
  getDurationExtensionCost: (batchId, additionalDays) => ipcRenderer.invoke('swarm:get-duration-extension-cost', batchId, additionalDays),
  getSizeExtensionCost: (batchId, newSizeGB) => ipcRenderer.invoke('swarm:get-size-extension-cost', batchId, newSizeGB),
  extendStorageDuration: (batchId, additionalDays) => ipcRenderer.invoke('swarm:extend-storage-duration', batchId, additionalDays),
  extendStorageSize: (batchId, newSizeGB) => ipcRenderer.invoke('swarm:extend-storage-size', batchId, newSizeGB),
  getChequebookBalance: () => ipcRenderer.invoke('swarm:get-chequebook-balance'),
  depositChequebook: (amountBzz) => ipcRenderer.invoke('swarm:deposit-chequebook', amountBzz),
  publishData: (data) => ipcRenderer.invoke('swarm:publish-data', data),
  publishFile: (filePath) => ipcRenderer.invoke('swarm:publish-file', filePath),
  publishDirectory: (dirPath) => ipcRenderer.invoke('swarm:publish-directory', dirPath),
  getUploadStatus: (tagUid) => ipcRenderer.invoke('swarm:get-upload-status', tagUid),
});

contextBridge.exposeInMainWorld('chainRegistry', {
  getChains: () => ipcRenderer.invoke('chain-registry:get-chains'),
  getTokens: (chainId) => ipcRenderer.invoke('chain-registry:get-tokens', chainId),
  getChain: (chainId) => ipcRenderer.invoke('chain-registry:get-chain', chainId),
  getToken: (key) => ipcRenderer.invoke('chain-registry:get-token', key),
  addChain: (chain) => ipcRenderer.invoke('chain-registry:add-chain', chain),
  addToken: (token) => ipcRenderer.invoke('chain-registry:add-token', token),
  removeChain: (chainId) => ipcRenderer.invoke('chain-registry:remove-chain', chainId),
  removeToken: (key) => ipcRenderer.invoke('chain-registry:remove-token', key),
  getAvailableChains: () => ipcRenderer.invoke('chain-registry:get-available-chains'),
  isChainAvailable: (chainId) => ipcRenderer.invoke('chain-registry:is-chain-available', chainId),
});

contextBridge.exposeInMainWorld('rpcManager', {
  // Get all available RPC providers (Alchemy, Infura, DRPC, etc.)
  getProviders: () => ipcRenderer.invoke('rpc:get-providers'),
  // Get list of provider IDs that have API keys configured
  getConfiguredProviders: () => ipcRenderer.invoke('rpc:get-configured-providers'),
  // Check if a specific provider has an API key
  hasApiKey: (providerId) => ipcRenderer.invoke('rpc:has-api-key', providerId),
  // Set API key for a provider
  setApiKey: (providerId, apiKey) => ipcRenderer.invoke('rpc:set-api-key', providerId, apiKey),
  // Remove API key for a provider
  removeApiKey: (providerId) => ipcRenderer.invoke('rpc:remove-api-key', providerId),
  // Test an API key before saving
  testApiKey: (providerId, apiKey) => ipcRenderer.invoke('rpc:test-api-key', providerId, apiKey),
  // Get chains supported by configured providers
  getProviderSupportedChains: () => ipcRenderer.invoke('rpc:get-provider-supported-chains'),
  // Get effective RPC URLs for a chain (includes provider URLs)
  getEffectiveUrls: (chainId) => ipcRenderer.invoke('rpc:get-effective-urls', chainId),
});

contextBridge.exposeInMainWorld('dappPermissions', {
  getPermission: (origin) => ipcRenderer.invoke('dapp:get-permission', origin),
  grantPermission: (origin, walletIndex, chainId) => ipcRenderer.invoke('dapp:grant-permission', origin, walletIndex, chainId),
  revokePermission: (origin) => ipcRenderer.invoke('dapp:revoke-permission', origin),
  getAllPermissions: () => ipcRenderer.invoke('dapp:get-all-permissions'),
  updateLastUsed: (origin, chainId) => ipcRenderer.invoke('dapp:update-last-used', origin, chainId),
  getSigningAutoApprove: (origin) => ipcRenderer.invoke('dapp:get-signing-auto-approve', origin),
  setSigningAutoApprove: (origin, enabled) => ipcRenderer.invoke('dapp:set-signing-auto-approve', origin, enabled),
  isTransactionAutoApproved: (origin, to, selector, chainId) => ipcRenderer.invoke('dapp:is-tx-auto-approved', origin, to, selector, chainId),
  addTransactionAutoApprove: (origin, to, selector, chainId) => ipcRenderer.invoke('dapp:add-tx-auto-approve', origin, to, selector, chainId),
  removeTransactionAutoApprove: (origin, to, selector, chainId) => ipcRenderer.invoke('dapp:remove-tx-auto-approve', origin, to, selector, chainId),
});

contextBridge.exposeInMainWorld('swarmPermissions', {
  getPermission: (origin) => ipcRenderer.invoke('swarm:get-permission', origin),
  grantPermission: (origin) => ipcRenderer.invoke('swarm:grant-permission', origin),
  revokePermission: (origin) => ipcRenderer.invoke('swarm:revoke-permission', origin),
  getAllPermissions: () => ipcRenderer.invoke('swarm:get-all-permissions'),
  updateLastUsed: (origin) => ipcRenderer.invoke('swarm:update-last-used', origin),
  getAutoApprove: (origin, type) => ipcRenderer.invoke('swarm:get-auto-approve', origin, type),
  setAutoApprove: (origin, type, enabled) => ipcRenderer.invoke('swarm:set-auto-approve', origin, type, enabled),
});

contextBridge.exposeInMainWorld('swarmProvider', {
  execute: (method, params, origin) =>
    ipcRenderer.invoke('swarm:provider-execute', { method, params, origin }),
});

contextBridge.exposeInMainWorld('swarmFeedStore', {
  getAllOrigins: () => ipcRenderer.invoke('swarm:get-all-origins'),
  hasFeedIdentity: (origin) => ipcRenderer.invoke('swarm:has-feed-identity', origin),
  hasFeedGrant: (origin) => ipcRenderer.invoke('swarm:has-feed-grant', origin),
  getIdentityMode: (origin) => ipcRenderer.invoke('swarm:get-identity-mode', origin),
  setFeedIdentity: (origin, identityMode) => ipcRenderer.invoke('swarm:set-feed-identity', origin, identityMode),
  revokeFeedAccess: (origin) => ipcRenderer.invoke('swarm:revoke-feed-access', origin),
});
