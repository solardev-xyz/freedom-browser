const { contextBridge, ipcRenderer } = require('electron');

// Note: Preload scripts run in a sandboxed context where relative requires
// can fail. Using hardcoded strings here for reliability.
// Keep these in sync with src/shared/ipc-channels.js

// Internal pages list — canonical source is src/shared/internal-pages.json,
// served by the main process via sync IPC so preloads don't need require().
const internalPages = ipcRenderer.sendSync('internal:get-pages');

// Environment variable overrides for gateways (for advanced users)
const defaultBeeApi = process.env.BEE_API || 'http://127.0.0.1:1633';
const defaultIpfsGateway = process.env.IPFS_GATEWAY || 'http://127.0.0.1:8080';

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
  validateUrl: (url) => ipcRenderer.invoke('github-bridge:validate-url', url),
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
