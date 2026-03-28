const IPC = require('../shared/ipc-channels');
const {
  createContextBridgeMock,
  createIpcRendererMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const originalBeeApi = process.env.BEE_API;
const originalIpfsGateway = process.env.IPFS_GATEWAY;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function loadPreloadModule(options = {}) {
  const internalPages = options.internalPages || {
    home: 'file:///app/pages/home.html',
    history: 'file:///app/pages/history.html',
  };
  const ipcRenderer =
    options.ipcRenderer ||
    createIpcRendererMock({
      syncResponses: {
        [IPC.GET_INTERNAL_PAGES]: internalPages,
      },
      invokeResponses: {
        [IPC.BEE_GET_STATUS]: { status: 'running', error: null },
        [IPC.IPFS_GET_STATUS]: { status: 'stopped', error: null },
        [IPC.RADICLE_GET_STATUS]: { status: 'error', error: 'offline' },
        ...(options.invokeResponses || {}),
      },
    });
  const contextBridge = options.contextBridge || createContextBridgeMock();

  if (Object.prototype.hasOwnProperty.call(options, 'beeApiEnv')) {
    if (options.beeApiEnv == null) {
      delete process.env.BEE_API;
    } else {
      process.env.BEE_API = options.beeApiEnv;
    }
  }

  if (Object.prototype.hasOwnProperty.call(options, 'ipfsGatewayEnv')) {
    if (options.ipfsGatewayEnv == null) {
      delete process.env.IPFS_GATEWAY;
    } else {
      process.env.IPFS_GATEWAY = options.ipfsGatewayEnv;
    }
  }

  loadMainModule(require.resolve('./preload'), {
    ipcRenderer,
    contextBridge,
  });

  return {
    contextBridge,
    exposures: contextBridge.exposedValues,
    internalPages,
    ipcRenderer,
  };
}

describe('preload', () => {
  afterEach(() => {
    if (originalBeeApi === undefined) {
      delete process.env.BEE_API;
    } else {
      process.env.BEE_API = originalBeeApi;
    }

    if (originalIpfsGateway === undefined) {
      delete process.env.IPFS_GATEWAY;
    } else {
      process.env.IPFS_GATEWAY = originalIpfsGateway;
    }

    jest.restoreAllMocks();
  });

  test('exposes the preload bridges and routes direct wrappers to ipcRenderer', async () => {
    const { contextBridge, exposures, internalPages, ipcRenderer } = loadPreloadModule({
      beeApiEnv: 'http://127.0.0.1:1700',
      ipfsGatewayEnv: 'http://127.0.0.1:9090',
    });

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(18);
    expect(Object.keys(exposures)).toEqual([
      'nodeConfig',
      'internalPages',
      'electronAPI',
      'bee',
      'ipfs',
      'radicle',
      'githubBridge',
      'serviceRegistry',
      'identity',
      'quickUnlock',
      'wallet',
      'swarmNode',
      'chainRegistry',
      'rpcManager',
      'dappPermissions',
      'swarmPermissions',
      'swarmProvider',
      'swarmFeedStore',
    ]);
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(IPC.GET_INTERNAL_PAGES);
    expect(exposures.nodeConfig).toEqual({
      beeApi: 'http://127.0.0.1:1700',
      ipfsGateway: 'http://127.0.0.1:9090',
    });
    expect(exposures.internalPages).toBe(internalPages);

    const invokeCases = [
      [exposures.electronAPI, 'setBzzBase', [11, 'http://127.0.0.1:1633/bzz/hash/'], IPC.BZZ_SET_BASE, [{ webContentsId: 11, baseUrl: 'http://127.0.0.1:1633/bzz/hash/' }]],
      [exposures.electronAPI, 'clearBzzBase', [11], IPC.BZZ_CLEAR_BASE, [{ webContentsId: 11 }]],
      [exposures.electronAPI, 'setIpfsBase', [21, 'http://127.0.0.1:8080/ipfs/cid/'], IPC.IPFS_SET_BASE, [{ webContentsId: 21, baseUrl: 'http://127.0.0.1:8080/ipfs/cid/' }]],
      [exposures.electronAPI, 'clearIpfsBase', [21], IPC.IPFS_CLEAR_BASE, [{ webContentsId: 21 }]],
      [exposures.electronAPI, 'setRadBase', [31, 'http://127.0.0.1:8780/api/v1/repos/rid/'], IPC.RAD_SET_BASE, [{ webContentsId: 31, baseUrl: 'http://127.0.0.1:8780/api/v1/repos/rid/' }]],
      [exposures.electronAPI, 'clearRadBase', [31], IPC.RAD_CLEAR_BASE, [{ webContentsId: 31 }]],
      [exposures.electronAPI, 'getPlatform', [], IPC.WINDOW_GET_PLATFORM, []],
      [exposures.electronAPI, 'getSettings', [], IPC.SETTINGS_GET, []],
      [exposures.electronAPI, 'saveSettings', [{ theme: 'dark' }], IPC.SETTINGS_SAVE, [{ theme: 'dark' }]],
      [exposures.electronAPI, 'getBookmarks', [], IPC.BOOKMARKS_GET, []],
      [exposures.electronAPI, 'addBookmark', [{ label: 'Example', target: 'https://example.com' }], IPC.BOOKMARKS_ADD, [{ label: 'Example', target: 'https://example.com' }]],
      [exposures.electronAPI, 'updateBookmark', ['https://old.example', { label: 'New', target: 'https://new.example' }], IPC.BOOKMARKS_UPDATE, [{ originalTarget: 'https://old.example', bookmark: { label: 'New', target: 'https://new.example' } }]],
      [exposures.electronAPI, 'removeBookmark', ['https://example.com'], IPC.BOOKMARKS_REMOVE, ['https://example.com']],
      [exposures.electronAPI, 'resolveEns', ['myname.box'], IPC.ENS_RESOLVE, [{ name: 'myname.box' }]],
      [exposures.electronAPI, 'getHistory', [{ limit: 10 }], IPC.HISTORY_GET, [{ limit: 10 }]],
      [exposures.electronAPI, 'addHistory', [{ url: 'https://example.com' }], IPC.HISTORY_ADD, [{ url: 'https://example.com' }]],
      [exposures.electronAPI, 'removeHistory', [7], IPC.HISTORY_REMOVE, [7]],
      [exposures.electronAPI, 'clearHistory', [], IPC.HISTORY_CLEAR, []],
      [exposures.electronAPI, 'getWebviewPreloadPath', [], IPC.GET_WEBVIEW_PRELOAD_PATH, []],
      [exposures.electronAPI, 'saveImage', ['https://example.com/image.png'], IPC.CONTEXT_MENU_SAVE_IMAGE, ['https://example.com/image.png']],
      [exposures.electronAPI, 'copyText', ['hello'], 'clipboard:copy-text', ['hello']],
      [exposures.electronAPI, 'copyImageFromUrl', ['https://example.com/image.png'], 'clipboard:copy-image', ['https://example.com/image.png']],
      [exposures.electronAPI, 'getFavicon', ['https://example.com'], IPC.FAVICON_GET, ['https://example.com']],
      [exposures.electronAPI, 'getCachedFavicon', ['https://example.com'], IPC.FAVICON_GET_CACHED, ['https://example.com']],
      [exposures.electronAPI, 'fetchFavicon', ['https://example.com'], IPC.FAVICON_FETCH, ['https://example.com']],
      [exposures.electronAPI, 'fetchFaviconWithKey', ['https://example.com/icon.png', 'icon-key'], IPC.FAVICON_FETCH_WITH_KEY, ['https://example.com/icon.png', 'icon-key']],
      [exposures.bee, 'start', [], IPC.BEE_START, []],
      [exposures.bee, 'stop', [], IPC.BEE_STOP, []],
      [exposures.bee, 'getStatus', [], IPC.BEE_GET_STATUS, []],
      [exposures.bee, 'checkBinary', [], IPC.BEE_CHECK_BINARY, []],
      [exposures.ipfs, 'start', [], IPC.IPFS_START, []],
      [exposures.ipfs, 'stop', [], IPC.IPFS_STOP, []],
      [exposures.ipfs, 'getStatus', [], IPC.IPFS_GET_STATUS, []],
      [exposures.ipfs, 'checkBinary', [], IPC.IPFS_CHECK_BINARY, []],
      [exposures.radicle, 'start', [], IPC.RADICLE_START, []],
      [exposures.radicle, 'stop', [], IPC.RADICLE_STOP, []],
      [exposures.radicle, 'getStatus', [], IPC.RADICLE_GET_STATUS, []],
      [exposures.radicle, 'checkBinary', [], IPC.RADICLE_CHECK_BINARY, []],
      [exposures.radicle, 'getConnections', [], IPC.RADICLE_GET_CONNECTIONS, []],
      [exposures.githubBridge, 'import', ['https://github.com/openai/project'], IPC.GITHUB_BRIDGE_IMPORT, ['https://github.com/openai/project']],
      [exposures.githubBridge, 'checkGit', [], IPC.GITHUB_BRIDGE_CHECK_GIT, []],
      [exposures.githubBridge, 'checkPrerequisites', [], IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES, []],
      [exposures.githubBridge, 'validateUrl', ['https://github.com/openai/project'], IPC.GITHUB_BRIDGE_VALIDATE_URL, ['https://github.com/openai/project']],
      [exposures.githubBridge, 'checkExisting', ['https://github.com/openai/project'], IPC.GITHUB_BRIDGE_CHECK_EXISTING, ['https://github.com/openai/project']],
      [exposures.serviceRegistry, 'getRegistry', [], IPC.SERVICE_REGISTRY_GET, []],
    ];

    for (const [target, method, args, channel, expectedArgs] of invokeCases) {
      ipcRenderer.invoke.mockClear();
      await target[method](...args);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...expectedArgs);
    }

    const sendCases = [
      [exposures.electronAPI, 'setWindowTitle', ['Title'], IPC.WINDOW_SET_TITLE, ['Title']],
      [exposures.electronAPI, 'closeWindow', [], IPC.WINDOW_CLOSE, []],
      [exposures.electronAPI, 'minimizeWindow', [], IPC.WINDOW_MINIMIZE, []],
      [exposures.electronAPI, 'maximizeWindow', [], IPC.WINDOW_MAXIMIZE, []],
      [exposures.electronAPI, 'toggleFullscreen', [], IPC.WINDOW_TOGGLE_FULLSCREEN, []],
      [exposures.electronAPI, 'newWindow', [], IPC.WINDOW_NEW, []],
      [exposures.electronAPI, 'openUrlInNewWindow', ['https://example.com'], IPC.WINDOW_NEW_WITH_URL, ['https://example.com']],
      [exposures.electronAPI, 'showAbout', [], IPC.APP_SHOW_ABOUT, []],
      [exposures.electronAPI, 'updateTabMenuState', [{ canGoBack: true }], 'menu:update-tab-state', [{ canGoBack: true }]],
      [exposures.electronAPI, 'setBookmarkBarToggleEnabled', [true], 'menu:set-bookmark-bar-toggle-enabled', [true]],
      [exposures.electronAPI, 'setBookmarkBarChecked', [false], 'menu:set-bookmark-bar-checked', [false]],
      [exposures.electronAPI, 'restartAndInstallUpdate', [], 'update:restart-and-install', []],
      [exposures.electronAPI, 'checkForUpdates', [], 'update:check', []],
    ];

    for (const [target, method, args, channel, expectedArgs] of sendCases) {
      ipcRenderer.send.mockClear();
      target[method](...args);
      expect(ipcRenderer.send).toHaveBeenCalledWith(channel, ...expectedArgs);
    }
  });

  test('registers electronAPI, github bridge, and service registry listeners with cleanup', () => {
    const { exposures, ipcRenderer } = loadPreloadModule();

    const listenerCases = [
      [exposures.electronAPI, 'onNewTab', 'tab:new', [], []],
      [exposures.electronAPI, 'onCloseTab', 'tab:close', [], []],
      [exposures.electronAPI, 'onNewTabWithUrl', 'tab:new-with-url', ['https://example.com', 'named-target'], ['https://example.com', 'named-target']],
      [exposures.electronAPI, 'onNavigateToUrl', 'navigate-to-url', ['bzz://hash'], ['bzz://hash']],
      [exposures.electronAPI, 'onLoadUrl', 'tab:load-url', ['https://load.example'], ['https://load.example']],
      [exposures.electronAPI, 'onToggleDevTools', 'devtools:toggle', [], []],
      [exposures.electronAPI, 'onCloseDevTools', 'devtools:close', [], []],
      [exposures.electronAPI, 'onCloseAllDevTools', 'devtools:close-all', [], []],
      [exposures.electronAPI, 'onFocusAddressBar', 'focus:address-bar', [], []],
      [exposures.electronAPI, 'onCloseMenus', 'menus:close', [], []],
      [exposures.electronAPI, 'onReload', 'page:reload', [], []],
      [exposures.electronAPI, 'onHardReload', 'page:hard-reload', [], []],
      [exposures.electronAPI, 'onNextTab', 'tab:next', [], []],
      [exposures.electronAPI, 'onPrevTab', 'tab:prev', [], []],
      [exposures.electronAPI, 'onMoveTabLeft', 'tab:move-left', [], []],
      [exposures.electronAPI, 'onMoveTabRight', 'tab:move-right', [], []],
      [exposures.electronAPI, 'onReopenClosedTab', 'tab:reopen-closed', [], []],
      [exposures.electronAPI, 'onToggleBookmarkBar', IPC.BOOKMARKS_TOGGLE_BAR, [], []],
      [exposures.electronAPI, 'onUpdateNotification', 'show-update-notification', [{ version: '1.2.3' }], [{ version: '1.2.3' }]],
      [exposures.githubBridge, 'onProgress', IPC.GITHUB_BRIDGE_PROGRESS, [{ step: 'cloning' }], [{ step: 'cloning' }]],
      [exposures.serviceRegistry, 'onUpdate', IPC.SERVICE_REGISTRY_UPDATE, [{ bee: { mode: 'bundled' } }], [{ bee: { mode: 'bundled' } }]],
    ];

    for (const [target, method, channel, emittedArgs, expectedArgs] of listenerCases) {
      const callback = jest.fn();
      const cleanup = target[method](callback);
      const handler = ipcRenderer.listeners.get(channel)[0];

      ipcRenderer.emit(channel, ...emittedArgs);
      expect(callback).toHaveBeenCalledWith(...expectedArgs);

      cleanup();
      expect(ipcRenderer.removeListener).toHaveBeenLastCalledWith(channel, handler);
    }
  });

  test('status update wrappers subscribe, fetch current state immediately, and clean up', async () => {
    const beeStatus = { status: 'running', error: null };
    const ipfsStatus = { status: 'stopped', error: null };
    const radicleStatus = { status: 'error', error: 'offline' };
    const { exposures, ipcRenderer } = loadPreloadModule({
      invokeResponses: {
        [IPC.BEE_GET_STATUS]: beeStatus,
        [IPC.IPFS_GET_STATUS]: ipfsStatus,
        [IPC.RADICLE_GET_STATUS]: radicleStatus,
      },
    });

    const statusCases = [
      [exposures.bee, IPC.BEE_STATUS_UPDATE, IPC.BEE_GET_STATUS, beeStatus, { status: 'starting', error: null }],
      [exposures.ipfs, IPC.IPFS_STATUS_UPDATE, IPC.IPFS_GET_STATUS, ipfsStatus, { status: 'running', error: null }],
      [exposures.radicle, IPC.RADICLE_STATUS_UPDATE, IPC.RADICLE_GET_STATUS, radicleStatus, { status: 'running', error: null }],
    ];

    for (const [target, updateChannel, getStatusChannel, initialStatus, pushedStatus] of statusCases) {
      const callback = jest.fn();
      ipcRenderer.invoke.mockClear();
      ipcRenderer.removeListener.mockClear();

      const cleanup = target.onStatusUpdate(callback);
      const handler = ipcRenderer.listeners.get(updateChannel)[0];

      expect(ipcRenderer.invoke).toHaveBeenCalledWith(getStatusChannel);
      await flushMicrotasks();
      expect(callback).toHaveBeenCalledWith(initialStatus);

      ipcRenderer.emit(updateChannel, pushedStatus);
      expect(callback).toHaveBeenLastCalledWith(pushedStatus);

      cleanup();
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(updateChannel, handler);
    }
  });

  test('uses default gateway env values when overrides are absent', () => {
    const { exposures } = loadPreloadModule({
      beeApiEnv: null,
      ipfsGatewayEnv: null,
    });

    expect(exposures.nodeConfig).toEqual({
      beeApi: 'http://127.0.0.1:1633',
      ipfsGateway: 'http://127.0.0.1:8080',
    });
  });
});
