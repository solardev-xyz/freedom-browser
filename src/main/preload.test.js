const IPC = require('../shared/ipc-channels');
const {
  createContextBridgeMock,
  createIpcRendererMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const originalBeeApi = process.env.BEE_API;
const originalAntApi = process.env.ANT_API;

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
        [IPC.ANT_GET_STATUS]: { status: 'running', error: null },
        [IPC.IPFS_GET_STATUS]: { status: 'stopped', error: null },
        [IPC.MYOTIS_GET_STATUS]: { state: 'off', running: false, available: true },
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
  if (Object.prototype.hasOwnProperty.call(options, 'antApiEnv')) {
    if (options.antApiEnv == null) {
      delete process.env.ANT_API;
    } else {
      process.env.ANT_API = options.antApiEnv;
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
    if (originalAntApi === undefined) {
      delete process.env.ANT_API;
    } else {
      process.env.ANT_API = originalAntApi;
    }

    jest.restoreAllMocks();
  });

  test('exposes the preload bridges and routes direct wrappers to ipcRenderer', async () => {
    const { contextBridge, exposures, internalPages, ipcRenderer } = loadPreloadModule({
      antApiEnv: null,
      beeApiEnv: 'http://127.0.0.1:1700',
    });

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(28);
    expect(Object.keys(exposures)).toEqual([
      'nodeConfig',
      'internalPages',
      'electronAPI',
      'ant',
      'myotis',
      'ipfs',
      'radicle',
      'tor',
      'githubBridge',
      'serviceRegistry',
      'identity',
      'quickUnlock',
      'wallet',
      'ledger',
      'remoteSigner',
      'swarmNode',
      'networks',
      'payments',
      'tokens',
      'rpcManager',
      'sitePermissions',
      'dappPermissions',
      'swarmPermissions',
      'swarmManifest',
      'swarmProvider',
      'radiclePermissions',
      'radicleProvider',
      'swarmFeedStore',
    ]);
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(IPC.GET_INTERNAL_PAGES);
    expect(exposures.nodeConfig).toEqual({
      antApi: 'http://127.0.0.1:1700',
      openlvSignaling: null,
    });
    expect(exposures.internalPages).toBe(internalPages);

    const invokeCases = [
      [exposures.electronAPI, 'setBzzBase', [11, 'http://127.0.0.1:1633/bzz/hash/'], IPC.BZZ_SET_BASE, [{ webContentsId: 11, baseUrl: 'http://127.0.0.1:1633/bzz/hash/' }]],
      [exposures.electronAPI, 'clearBzzBase', [11], IPC.BZZ_CLEAR_BASE, [{ webContentsId: 11 }]],
      [exposures.electronAPI, 'startSwarmProbe', ['a'.repeat(64), '/index.html'], IPC.BZZ_START_PROBE, [{ hash: 'a'.repeat(64), path: '/index.html' }]],
      [exposures.electronAPI, 'awaitSwarmProbe', ['probe-1'], IPC.BZZ_AWAIT_PROBE, [{ id: 'probe-1' }]],
      [exposures.electronAPI, 'cancelSwarmProbe', ['probe-1'], IPC.BZZ_CANCEL_PROBE, [{ id: 'probe-1' }]],
      [exposures.electronAPI, 'setRadBase', [31, 'http://127.0.0.1:8780/api/v1/repos/rid/'], IPC.RAD_SET_BASE, [{ webContentsId: 31, baseUrl: 'http://127.0.0.1:8780/api/v1/repos/rid/' }]],
      [exposures.electronAPI, 'clearRadBase', [31], IPC.RAD_CLEAR_BASE, [{ webContentsId: 31 }]],
      [exposures.electronAPI, 'getPlatform', [], IPC.WINDOW_GET_PLATFORM, []],
      [exposures.electronAPI, 'getActiveProfile', [], IPC.PROFILE_GET_ACTIVE, []],
      [exposures.electronAPI, 'listProfiles', [], IPC.PROFILE_LIST, []],
      [exposures.electronAPI, 'createProfile', [{ displayName: 'Work' }], IPC.PROFILE_CREATE, [{ displayName: 'Work' }]],
      [exposures.electronAPI, 'openProfile', ['work'], IPC.PROFILE_OPEN, [{ id: 'work' }]],
      [exposures.electronAPI, 'getSettings', [], IPC.SETTINGS_GET, []],
      [exposures.electronAPI, 'saveSettings', [{ theme: 'dark' }], IPC.SETTINGS_SAVE, [{ theme: 'dark' }]],
      [exposures.electronAPI, 'getBookmarks', [], IPC.BOOKMARKS_GET, []],
      [exposures.electronAPI, 'addBookmark', [{ label: 'Example', target: 'https://example.com' }], IPC.BOOKMARKS_ADD, [{ label: 'Example', target: 'https://example.com' }]],
      [exposures.electronAPI, 'updateBookmark', ['https://old.example', { label: 'New', target: 'https://new.example' }], IPC.BOOKMARKS_UPDATE, [{ originalTarget: 'https://old.example', bookmark: { label: 'New', target: 'https://new.example' } }]],
      [exposures.electronAPI, 'removeBookmark', ['https://example.com'], IPC.BOOKMARKS_REMOVE, ['https://example.com']],
      [exposures.electronAPI, 'resolveEns', ['myname.box'], IPC.ENS_RESOLVE, [{ name: 'myname.box' }]],
      [exposures.electronAPI, 'resolveEnsAddress', ['vitalik.eth'], IPC.ENS_RESOLVE_ADDRESS, [{ name: 'vitalik.eth' }]],
      [exposures.electronAPI, 'resolveEnsReverse', ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'], IPC.ENS_RESOLVE_REVERSE, [{ address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' }]],
      [exposures.electronAPI, 'getHistory', [{ limit: 10 }], IPC.HISTORY_GET, [{ limit: 10 }]],
      [exposures.electronAPI, 'addHistory', [{ url: 'https://example.com' }], IPC.HISTORY_ADD, [{ url: 'https://example.com' }]],
      [exposures.electronAPI, 'removeHistory', [7], IPC.HISTORY_REMOVE, [7]],
      [exposures.electronAPI, 'clearHistory', [], IPC.HISTORY_CLEAR, []],
      [exposures.electronAPI, 'getWebviewPreloadPath', [], IPC.GET_WEBVIEW_PRELOAD_PATH, []],
      [exposures.electronAPI, 'saveImage', ['https://example.com/image.png'], IPC.CONTEXT_MENU_SAVE_IMAGE, ['https://example.com/image.png']],
      [exposures.electronAPI, 'copyText', ['hello'], 'clipboard:copy-text', ['hello']],
      [exposures.electronAPI, 'readClipboardText', [], 'clipboard:read-text', []],
      [exposures.electronAPI, 'copyImageFromUrl', ['https://example.com/image.png'], 'clipboard:copy-image', ['https://example.com/image.png']],
      [exposures.electronAPI, 'getFavicon', ['https://example.com'], IPC.FAVICON_GET, ['https://example.com']],
      [exposures.electronAPI, 'getCachedFavicon', ['https://example.com'], IPC.FAVICON_GET_CACHED, ['https://example.com']],
      [exposures.electronAPI, 'fetchFavicon', ['https://example.com'], IPC.FAVICON_FETCH, ['https://example.com']],
      [exposures.electronAPI, 'fetchFaviconWithKey', ['https://example.com/icon.png', 'icon-key'], IPC.FAVICON_FETCH_WITH_KEY, ['https://example.com/icon.png', 'icon-key']],
      [exposures.ant, 'start', [], IPC.ANT_START, []],
      [exposures.ant, 'stop', [], IPC.ANT_STOP, []],
      [exposures.ant, 'getStatus', [], IPC.ANT_GET_STATUS, []],
      [exposures.ant, 'checkBinary', [], IPC.ANT_CHECK_BINARY, []],
      [exposures.myotis, 'start', [], IPC.MYOTIS_START, []],
      [exposures.myotis, 'stop', [], IPC.MYOTIS_STOP, []],
      [exposures.myotis, 'getStatus', [], IPC.MYOTIS_GET_STATUS, []],
      [exposures.ipfs, 'start', [], IPC.IPFS_START, []],
      [exposures.ipfs, 'stop', [], IPC.IPFS_STOP, []],
      [exposures.ipfs, 'getStatus', [], IPC.IPFS_GET_STATUS, []],
      [exposures.ipfs, 'checkBinary', [], IPC.IPFS_CHECK_BINARY, []],
      [exposures.radicle, 'start', [], IPC.RADICLE_START, []],
      [exposures.radicle, 'stop', [], IPC.RADICLE_STOP, []],
      [exposures.radicle, 'getStatus', [], IPC.RADICLE_GET_STATUS, []],
      [exposures.radicle, 'checkBinary', [], IPC.RADICLE_CHECK_BINARY, []],
      [exposures.radicle, 'getConnections', [], IPC.RADICLE_GET_CONNECTIONS, []],
      [exposures.tor, 'start', [], IPC.TOR_START, []],
      [exposures.tor, 'stop', [], IPC.TOR_STOP, []],
      [exposures.tor, 'getStatus', [], IPC.TOR_GET_STATUS, []],
      [exposures.tor, 'checkBinary', [], IPC.TOR_CHECK_BINARY, []],
      [exposures.tor, 'getVersion', [], IPC.TOR_GET_VERSION, []],
      [exposures.githubBridge, 'import', ['https://github.com/openai/project'], IPC.GITHUB_BRIDGE_IMPORT, ['https://github.com/openai/project']],
      [exposures.githubBridge, 'checkGit', [], IPC.GITHUB_BRIDGE_CHECK_GIT, []],
      [exposures.githubBridge, 'checkPrerequisites', [], IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES, []],
      [exposures.githubBridge, 'validateUrl', ['https://github.com/openai/project'], IPC.GITHUB_BRIDGE_VALIDATE_URL, ['https://github.com/openai/project']],
      [exposures.githubBridge, 'checkExisting', ['https://github.com/openai/project'], IPC.GITHUB_BRIDGE_CHECK_EXISTING, ['https://github.com/openai/project']],
      [exposures.serviceRegistry, 'getRegistry', [], IPC.SERVICE_REGISTRY_GET, []],
      [exposures.swarmPermissions, 'revokeMessaging', ['origin.eth'], IPC.SWARM_REVOKE_MESSAGING, ['origin.eth']],
      [exposures.swarmManifest, 'check', [{ origin: 'origin.eth', committedUrl: 'bzz://origin.eth/' }], IPC.SWARM_MANIFEST_CHECK, [{ origin: 'origin.eth', committedUrl: 'bzz://origin.eth/' }]],
      [exposures.swarmManifest, 'decide', ['token', 'allow'], IPC.SWARM_MANIFEST_DECIDE, [{ token: 'token', outcome: 'allow' }]],
      [exposures.swarmManifest, 'get', ['origin.eth'], IPC.SWARM_MANIFEST_GET, ['origin.eth']],
      [exposures.swarmManifest, 'useIndividual', ['origin.eth', 'feeds'], IPC.SWARM_MANIFEST_USE_INDIVIDUAL, [{ origin: 'origin.eth', capability: 'feeds' }]],
      [exposures.swarmManifest, 'disconnect', ['origin.eth'], IPC.SWARM_MANIFEST_DISCONNECT, ['origin.eth']],
      [exposures.swarmFeedStore, 'previewAppScopedIdentity', ['origin.eth', { label: 'Draft' }], IPC.SWARM_PREVIEW_APP_SCOPED_IDENTITY, ['origin.eth', { label: 'Draft' }]],
      [exposures.swarmFeedStore, 'ensureEthereumWalletIdentity', ['origin.eth', 2, { activate: true }], IPC.SWARM_ENSURE_ETHEREUM_WALLET_IDENTITY, ['origin.eth', 2, { activate: true }]],
      [exposures.sitePermissions, 'respondToPrompt', [{ id: 1, decision: 'allow', remember: true }], IPC.PERMISSIONS_PROMPT_RESPONSE, [{ id: 1, decision: 'allow', remember: true }]],
      [exposures.sitePermissions, 'getForOrigin', ['https://example.com'], IPC.PERMISSIONS_GET_FOR_ORIGIN, ['https://example.com']],
      [exposures.sitePermissions, 'revoke', ['https://example.com', 'camera'], IPC.PERMISSIONS_REVOKE, ['https://example.com', 'camera']],
      [exposures.sitePermissions, 'revokeOrigin', ['https://example.com'], IPC.PERMISSIONS_REVOKE_ORIGIN, ['https://example.com']],
      [exposures.payments, 'getRecent', [{ limit: 10 }], IPC.PAYMENTS_GET_RECENT, [{ limit: 10 }]],
      [exposures.payments, 'getById', [7], IPC.PAYMENTS_GET_BY_ID, [7]],
      [exposures.payments, 'getCount', [{ kind: 'x402' }], IPC.PAYMENTS_GET_COUNT, [{ kind: 'x402' }]],
    ];

    for (const [target, method, args, channel, expectedArgs] of invokeCases) {
      ipcRenderer.invoke.mockClear();
      await target[method](...args);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...expectedArgs);
    }
    expect(exposures.payments.clear).toBeUndefined();

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
      [exposures.electronAPI, 'resolveExternalNodeCandidates', [{ requestId: 'req-1', choices: { bee: 'managed' } }], IPC.PROFILE_EXTERNAL_CANDIDATES_DECISION, [{ requestId: 'req-1', choices: { bee: 'managed' } }]],
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
      [exposures.electronAPI, 'onProfileUpdated', IPC.PROFILE_UPDATED, [{ id: 'work', displayName: 'Work' }], [{ id: 'work', displayName: 'Work' }]],
      [exposures.electronAPI, 'onExternalNodeCandidates', IPC.PROFILE_EXTERNAL_CANDIDATES, [{ requestId: 'req-1' }], [{ requestId: 'req-1' }]],
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
      [exposures.electronAPI, 'onOpenFindBar', IPC.FIND_IN_PAGE_OPEN, [], []],
      [exposures.electronAPI, 'onToggleBookmarkBar', IPC.BOOKMARKS_TOGGLE_BAR, [], []],
      [exposures.electronAPI, 'onUpdateNotification', 'show-update-notification', [{ version: '1.2.3' }], [{ version: '1.2.3' }]],
      [exposures.sitePermissions, 'onPromptRequest', IPC.PERMISSIONS_PROMPT_REQUEST, [{ id: 1, origin: 'https://example.com', keys: ['camera'], guestId: 7 }], [{ id: 1, origin: 'https://example.com', keys: ['camera'], guestId: 7 }]],
      [exposures.sitePermissions, 'onPromptCancel', IPC.PERMISSIONS_PROMPT_CANCEL, [{ id: 1 }], [{ id: 1 }]],
      [exposures.sitePermissions, 'onOsDenied', IPC.PERMISSIONS_OS_DENIED, [{ origin: 'https://example.com', permissions: ['camera'] }], [{ origin: 'https://example.com', permissions: ['camera'] }]],
      [exposures.sitePermissions, 'onChanged', IPC.PERMISSIONS_CHANGED, [{}], [{}]],
      [exposures.githubBridge, 'onProgress', IPC.GITHUB_BRIDGE_PROGRESS, [{ step: 'cloning' }], [{ step: 'cloning' }]],
      [exposures.serviceRegistry, 'onUpdate', IPC.SERVICE_REGISTRY_UPDATE, [{ ant: { mode: 'bundled' } }], [{ ant: { mode: 'bundled' } }]],
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
    const myotisStatus = { state: 'off', running: false, available: true };
    const radicleStatus = { status: 'error', error: 'offline' };
    const torStatus = { status: 'stopped', error: null };
    const { exposures, ipcRenderer } = loadPreloadModule({
      invokeResponses: {
        [IPC.ANT_GET_STATUS]: beeStatus,
        [IPC.IPFS_GET_STATUS]: ipfsStatus,
        [IPC.MYOTIS_GET_STATUS]: myotisStatus,
        [IPC.RADICLE_GET_STATUS]: radicleStatus,
        [IPC.TOR_GET_STATUS]: torStatus,
      },
    });

    const statusCases = [
      [exposures.ant, IPC.ANT_STATUS_UPDATE, IPC.ANT_GET_STATUS, beeStatus, { status: 'starting', error: null }],
      [exposures.ipfs, IPC.IPFS_STATUS_UPDATE, IPC.IPFS_GET_STATUS, ipfsStatus, { status: 'running', error: null }],
      [exposures.myotis, IPC.MYOTIS_STATUS_UPDATE, IPC.MYOTIS_GET_STATUS, myotisStatus, { state: 'ready', running: true }],
      [exposures.radicle, IPC.RADICLE_STATUS_UPDATE, IPC.RADICLE_GET_STATUS, radicleStatus, { status: 'running', error: null }],
      [exposures.tor, IPC.TOR_STATUS_UPDATE, IPC.TOR_GET_STATUS, torStatus, { status: 'running', error: null }],
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

  test('does not expose default gateway URLs when overrides are absent', () => {
    const { exposures } = loadPreloadModule({
      antApiEnv: null,
      beeApiEnv: null,
    });

    expect(exposures.nodeConfig).toEqual({
      antApi: null,
      openlvSignaling: null,
    });
  });

  test('contains an eager Myotis status failure inside the preload bridge', async () => {
    const { exposures, ipcRenderer } = loadPreloadModule();
    const callback = jest.fn();
    ipcRenderer.invoke.mockRejectedValueOnce(new Error('window closed'));

    const cleanup = exposures.myotis.onStatusUpdate(callback);
    await flushMicrotasks();

    expect(callback).not.toHaveBeenCalled();
    cleanup();
  });
});
