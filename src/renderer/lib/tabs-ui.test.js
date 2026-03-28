const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const HOME_URL = 'freedom://home';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createElectronApi = () => {
  const handlers = {};
  const register = (name) =>
    jest.fn((callback) => {
      handlers[name] = callback;
    });

  return {
    handlers,
    api: {
      setWindowTitle: jest.fn(),
      updateTabMenuState: jest.fn(),
      closeWindow: jest.fn(),
      getWebviewPreloadPath: jest.fn().mockResolvedValue('/tmp/webview-preload.js'),
      getCachedFavicon: jest.fn().mockResolvedValue('data:image/png;base64,favicon'),
      onNewTab: register('newTab'),
      onCloseTab: register('closeTab'),
      onNewTabWithUrl: register('newTabWithUrl'),
      onNavigateToUrl: register('navigateToUrl'),
      onLoadUrl: register('loadUrl'),
      onToggleDevTools: register('toggleDevTools'),
      onCloseDevTools: register('closeDevTools'),
      onCloseAllDevTools: register('closeAllDevTools'),
      onFocusAddressBar: register('focusAddressBar'),
      onReload: register('reload'),
      onHardReload: register('hardReload'),
      onNextTab: register('nextTab'),
      onPrevTab: register('prevTab'),
      onMoveTabLeft: register('moveTabLeft'),
      onMoveTabRight: register('moveTabRight'),
      onReopenClosedTab: register('reopenClosedTab'),
    },
  };
};

const createWebview = (createdWebviews) => {
  const webview = createElement('webview');
  const addEventListener = webview.addEventListener.bind(webview);
  const removeEventListener = webview.removeEventListener.bind(webview);

  webview.addEventListener = jest.fn((event, handler) => {
    addEventListener(event, handler);
  });
  webview.removeEventListener = jest.fn((event, handler) => {
    removeEventListener(event, handler);
  });
  webview._devToolsOpen = false;
  webview.getURL = jest.fn(() => webview.src || 'about:blank');
  webview.canGoBack = jest.fn(() => false);
  webview.canGoForward = jest.fn(() => false);
  webview.goBack = jest.fn();
  webview.goForward = jest.fn();
  webview.reloadIgnoringCache = jest.fn();
  webview.send = jest.fn();
  webview.print = jest.fn();
  webview.openDevTools = jest.fn(() => {
    webview._devToolsOpen = true;
  });
  webview.closeDevTools = jest.fn(() => {
    webview._devToolsOpen = false;
  });
  webview.isDevToolsOpened = jest.fn(() => webview._devToolsOpen);
  createdWebviews.push(webview);
  return webview;
};

const buildTabContextMenu = () => {
  const tabContextMenu = createElement('div', { classes: ['hidden'] });
  const actions = {};

  ['close', 'close-others', 'close-right', 'pin'].forEach((action) => {
    const button = createElement('button');
    button.dataset.action = action;
    tabContextMenu.appendChild(button);
    actions[action] = button;
  });

  return {
    tabContextMenu,
    actions,
  };
};

const loadTabsModule = async (options = {}) => {
  jest.resetModules();

  const createdWebviews = [];
  const { api: electronAPI, handlers: electronHandlers } = createElectronApi();
  const tabBar = createElement('div');
  const newTabBtn = createElement('button');
  const webviewContainer = createElement('div');
  const bzzWebview = createElement('webview');
  const addressInput = createElement('input');
  const { tabContextMenu, actions } = buildTabContextMenu();
  const document = createDocument({
    elementsById: {
      'tab-bar': tabBar,
      'new-tab-btn': newTabBtn,
      'webview-container': webviewContainer,
      'tab-context-menu': tabContextMenu,
      'bzz-webview': bzzWebview,
      'address-input': addressInput,
    },
    createElementOverride: (tagName) => {
      if (tagName === 'webview') {
        return createWebview(createdWebviews);
      }
      return createElement(tagName);
    },
  });
  const windowHandlers = {};
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const menuMocks = {
    closeMenus: jest.fn(),
  };
  const bookmarksMocks = {
    hideBookmarkContextMenu: jest.fn(),
  };
  const backdropMocks = {
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  };
  const pageContextMenuMocks = {
    setupWebviewContextMenu: jest.fn(),
  };

  addressInput.focus = jest.fn();
  addressInput.select = jest.fn();
  addressInput.blur = jest.fn();

  global.window = {
    electronAPI,
    innerWidth: 800,
    innerHeight: 600,
    location: {
      href: 'file:///app/index.html',
      search: options.search || '',
    },
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };

  global.document = document;

  jest.doMock('./debug.js', () => debugMocks);
  jest.doMock('./menus.js', () => menuMocks);
  jest.doMock('./bookmarks-ui.js', () => bookmarksMocks);
  jest.doMock('./menu-backdrop.js', () => backdropMocks);
  jest.doMock('./page-context-menu.js', () => pageContextMenuMocks);
  jest.doMock('./page-urls.js', () => ({
    homeUrl: HOME_URL,
  }));

  const mod = await import('./tabs.js');

  return {
    mod,
    electronAPI,
    electronHandlers,
    createdWebviews,
    elements: {
      tabBar,
      newTabBtn,
      webviewContainer,
      tabContextMenu,
      bzzWebview,
      addressInput,
      closeBtn: actions.close,
      closeOthersBtn: actions['close-others'],
      closeRightBtn: actions['close-right'],
      pinBtn: actions.pin,
    },
    windowHandlers,
    documentHandlers: document.handlers,
    debugMocks,
    menuMocks,
    bookmarksMocks,
    backdropMocks,
    pageContextMenuMocks,
  };
};

const findTabElement = (tabBar, tabId) =>
  tabBar.children.find((child) => child.dataset.tabId === tabId) || null;

describe('tabs ui behavior', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('initializes tabs and supports tab lifecycle helpers', async () => {
    const { mod, electronAPI, createdWebviews, pageContextMenuMocks } = await loadTabsModule();
    const onWebviewEvent = jest.fn();

    mod.setWebviewEventHandler(onWebviewEvent);
    await mod.initTabs();

    expect(electronAPI.getWebviewPreloadPath).toHaveBeenCalled();
    expect(createdWebviews[0].getAttribute('preload')).toBe('file:///tmp/webview-preload.js');
    expect(pageContextMenuMocks.setupWebviewContextMenu).toHaveBeenCalledWith(createdWebviews[0]);
    expect(mod.getTabs()).toHaveLength(1);
    expect(mod.getActiveTab().url).toBe(HOME_URL);

    const initialTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    const thirdTab = mod.createTab('https://third.example');

    mod.setTabLoading(true, secondTab.id);
    expect(mod.getTabs().find((tab) => tab.id === secondTab.id).isLoading).toBe(true);

    mod.switchTab(secondTab.id);
    expect(mod.getActiveTab()).toBe(secondTab);
    expect(mod.getActiveWebview()).toBe(secondTab.webview);
    expect(mod.getActiveTabState()).toBe(secondTab.navigationState);

    mod.updateActiveTabTitle('Updated Title');
    expect(mod.getActiveTab().title).toBe('Updated Title');
    expect(electronAPI.setWindowTitle).toHaveBeenCalledWith('New Tab');
    expect(onWebviewEvent).toHaveBeenCalledWith(
      'tab-switched',
      expect.objectContaining({ tabId: secondTab.id, isNewTab: false })
    );

    mod.moveTab('left');
    expect(mod.getTabs().map((tab) => tab.id)).toEqual([secondTab.id, initialTab.id, thirdTab.id]);

    mod.switchToNextTab();
    expect(mod.getActiveTab().id).toBe(initialTab.id);

    mod.switchToPrevTab();
    expect(mod.getActiveTab().id).toBe(secondTab.id);

    expect(mod.getOpenTabs()).toEqual([
      { id: secondTab.id, url: secondTab.url, title: secondTab.title, isActive: true },
      { id: initialTab.id, url: initialTab.url, title: initialTab.title, isActive: false },
      { id: thirdTab.id, url: thirdTab.url, title: thirdTab.title, isActive: false },
    ]);
  });

  test('updates favicons and manages devtools state', async () => {
    const { mod, electronAPI, debugMocks } = await loadTabsModule();

    await mod.initTabs();
    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');

    await mod.updateTabFavicon(firstTab.id, '');
    expect(firstTab.favicon).toBeNull();

    await mod.updateTabFavicon(firstTab.id, 'freedom://history');
    expect(firstTab.favicon).toBeNull();

    await mod.updateTabFavicon(firstTab.id, 'https://favicon.example');
    expect(firstTab.favicon).toBe('data:image/png;base64,favicon');
    expect(electronAPI.getCachedFavicon).toHaveBeenCalledWith('https://favicon.example');

    electronAPI.getCachedFavicon.mockRejectedValueOnce(new Error('cache miss'));
    await mod.updateTabFavicon(firstTab.id, 'https://error.example');
    expect(debugMocks.pushDebug).toHaveBeenCalledWith(
      '[Tabs] Favicon cache lookup failed: cache miss'
    );

    mod.switchTab(firstTab.id);
    mod.toggleDevTools();
    mod.toggleDevTools();

    expect(firstTab.webview.openDevTools).toHaveBeenCalled();
    expect(firstTab.webview.closeDevTools).toHaveBeenCalled();
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('DevTools opened');
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('DevTools closed');

    firstTab.webview._devToolsOpen = true;
    mod.closeDevTools();
    expect(firstTab.webview.closeDevTools).toHaveBeenCalledTimes(2);

    secondTab.webview._devToolsOpen = true;
    secondTab.webview.closeDevTools.mockImplementationOnce(() => {
      throw new Error('close failed');
    });
    mod.closeAllDevTools();

    expect(secondTab.webview.closeDevTools).toHaveBeenCalled();
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('[Tabs] closeDevTools failed: close failed');
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('All DevTools closed');
  });

  test('updates tab state from webview events', async () => {
    const { mod, electronAPI, debugMocks } = await loadTabsModule();
    const onWebviewEvent = jest.fn();

    mod.setWebviewEventHandler(onWebviewEvent);
    await mod.initTabs();

    const activeTab = mod.getActiveTab();
    const { webview } = activeTab;

    webview.getURL.mockReturnValue('https://loaded.example');
    webview.dispatch('did-start-loading');
    expect(activeTab.isLoading).toBe(true);

    webview.dispatch('did-stop-loading');
    expect(activeTab.isLoading).toBe(false);
    expect(activeTab.url).toBe('https://loaded.example');
    expect(onWebviewEvent).toHaveBeenCalledWith(
      'did-stop-loading',
      expect.objectContaining({ tabId: activeTab.id, url: 'https://loaded.example' })
    );

    webview.dispatch('did-fail-load', { errorCode: -1 });
    webview.dispatch('did-navigate-in-page', { url: 'https://loaded.example#hash' });
    webview.dispatch('dom-ready');

    activeTab.favicon = 'data:favicon';
    activeTab.title = 'Old Title';
    webview.getURL.mockReturnValue('view-source:https://loaded.example');
    webview.dispatch('did-navigate', { url: 'https://loaded.example' });
    expect(activeTab.isViewingSource).toBe(true);
    expect(activeTab.favicon).toBeNull();

    webview.getURL.mockReturnValue(HOME_URL);
    webview.dispatch('did-navigate', { url: HOME_URL });
    expect(activeTab.title).toBe('New Tab');
    expect(electronAPI.setWindowTitle).toHaveBeenCalledWith('');

    activeTab.title = 'Still New Tab';
    webview.dispatch('page-title-updated', { title: 'Ignored Home Title' });
    expect(activeTab.title).toBe('New Tab');

    activeTab.isViewingSource = true;
    activeTab.title = 'view-source:https://loaded.example';
    webview.getURL.mockReturnValue('view-source:https://loaded.example');
    webview.dispatch('page-title-updated', { title: 'Source Title' });
    expect(activeTab.title).toBe('view-source:https://loaded.example');

    activeTab.isViewingSource = false;
    webview.getURL.mockReturnValue('https://loaded.example');
    webview.dispatch('page-title-updated', { title: 'Loaded Title' });
    expect(activeTab.title).toBe('Loaded Title');
    expect(electronAPI.setWindowTitle).toHaveBeenCalledWith('Loaded Title');

    webview.dispatch('console-message', {
      level: 2,
      message: 'hello',
      sourceId: 'index.js',
      line: 12,
    });
    webview.dispatch('certificate-error', { certificate: 'bad-cert' });
    expect(activeTab.hasCertError).toBe(true);
    expect(onWebviewEvent).toHaveBeenCalledWith(
      'certificate-error',
      expect.objectContaining({ tabId: activeTab.id, event: { certificate: 'bad-cert' } })
    );
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('Console level-2: hello (index.js:12)');
  });

  test('closes and reopens tabs and closes the window when the last tab is removed', async () => {
    const firstLoad = await loadTabsModule();
    await firstLoad.mod.initTabs();

    const reopenTab = firstLoad.mod.createTab('https://reopen.example');
    firstLoad.mod.closeTab(reopenTab.id);
    expect(firstLoad.mod.getTabs()).toHaveLength(1);

    firstLoad.mod.reopenLastClosedTab();
    expect(firstLoad.mod.getTabs()).toHaveLength(2);
    expect(firstLoad.mod.getActiveTab().url).toBe('https://reopen.example');

    const lastWindowLoad = await loadTabsModule();
    await lastWindowLoad.mod.initTabs();

    const onlyTab = lastWindowLoad.mod.getActiveTab();
    lastWindowLoad.mod.closeTab(onlyTab.id);

    expect(lastWindowLoad.electronAPI.closeWindow).toHaveBeenCalled();
    expect(lastWindowLoad.mod.getActiveTab()).toBeNull();
  });

  test('wires context menu, keyboard shortcuts, and ipc entrypoints', async () => {
    jest.useFakeTimers();

    const {
      mod,
      electronHandlers,
      elements,
      windowHandlers,
      documentHandlers,
      menuMocks,
      bookmarksMocks,
      backdropMocks,
      debugMocks,
    } = await loadTabsModule();
    const onContextMenuOpening = jest.fn();
    const onLoadTarget = jest.fn();
    const onReload = jest.fn();
    const onHardReload = jest.fn();

    mod.setOnContextMenuOpening(onContextMenuOpening);
    mod.setLoadTargetHandler(onLoadTarget);
    mod.setReloadHandler(onReload);
    mod.setHardReloadHandler(onHardReload);
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    mod.createTab('https://third.example');
    const firstTabEl = findTabElement(elements.tabBar, firstTab.id);
    const secondTabEl = findTabElement(elements.tabBar, secondTab.id);

    elements.tabContextMenu.setRect({
      right: 900,
      bottom: 640,
      width: 120,
      height: 40,
    });

    secondTabEl.dispatch('contextmenu', {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      clientX: 790,
      clientY: 590,
    });

    expect(menuMocks.closeMenus).toHaveBeenCalled();
    expect(bookmarksMocks.hideBookmarkContextMenu).toHaveBeenCalled();
    expect(onContextMenuOpening).toHaveBeenCalled();
    expect(backdropMocks.showMenuBackdrop).toHaveBeenCalled();
    expect(elements.pinBtn.textContent).toBe('Pin Tab');
    expect(elements.closeRightBtn.disabled).toBe(false);
    expect(elements.closeOthersBtn.disabled).toBe(false);
    expect(elements.tabContextMenu.style.left).toBe('672px');
    expect(elements.tabContextMenu.style.top).toBe('552px');

    elements.tabContextMenu.dispatch('click', { target: elements.pinBtn });
    expect(mod.getTabs().find((tab) => tab.id === secondTab.id).pinned).toBe(true);

    firstTabEl.dispatch('contextmenu', {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      clientX: 20,
      clientY: 30,
    });
    elements.tabContextMenu.dispatch('click', { target: elements.closeRightBtn });
    expect(mod.getTabs().map((tab) => tab.id)).toEqual([secondTab.id, firstTab.id]);

    firstTabEl.dispatch('contextmenu', {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      clientX: 20,
      clientY: 30,
    });
    documentHandlers.click({ target: createElement('div') });
    expect(backdropMocks.hideMenuBackdrop).toHaveBeenCalled();

    firstTabEl.dispatch('contextmenu', {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      clientX: 20,
      clientY: 30,
    });
    windowHandlers.blur();
    elements.bzzWebview.dispatch('focus');
    elements.bzzWebview.dispatch('mousedown');

    elements.newTabBtn.dispatch('click');
    expect(mod.getTabs()).toHaveLength(3);

    electronHandlers.newTab();
    expect(mod.getTabs()).toHaveLength(4);

    const activeTab = mod.getActiveTab();
    activeTab.pinned = true;
    electronHandlers.closeTab();
    expect(mod.getTabs()).toHaveLength(3);

    electronHandlers.newTabWithUrl('https://named-target.example', 'named-target');
    expect(mod.getActiveTab().url).toBe('https://named-target.example');
    const beforeReuseCount = mod.getTabs().length;
    electronHandlers.newTabWithUrl('https://reuse-target.example', 'named-target');
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    expect(mod.getTabs()).toHaveLength(beforeReuseCount);
    expect(onLoadTarget).toHaveBeenCalledWith('https://reuse-target.example');

    electronHandlers.newTabWithUrl('ipfs://cid', 'ipfs-target');
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    expect(onLoadTarget).toHaveBeenCalledWith('ipfs://cid');

    electronHandlers.navigateToUrl('https://navigate.example');
    electronHandlers.loadUrl('https://load.example');
    expect(onLoadTarget).toHaveBeenCalledWith('https://navigate.example');
    expect(onLoadTarget).toHaveBeenCalledWith('https://load.example');

    electronHandlers.focusAddressBar();
    expect(elements.addressInput.focus).toHaveBeenCalled();
    expect(elements.addressInput.select).toHaveBeenCalled();

    electronHandlers.reload();
    electronHandlers.hardReload();
    expect(onReload).toHaveBeenCalled();
    expect(onHardReload).toHaveBeenCalled();

    mod.switchTab(firstTab.id);
    const orderedTabs = mod.getTabs();
    const firstIndex = orderedTabs.findIndex((tab) => tab.id === firstTab.id);
    const expectedNextTabId = orderedTabs[(firstIndex + 1) % orderedTabs.length].id;
    windowHandlers.keydown({
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      key: 'Tab',
      preventDefault: jest.fn(),
    });
    expect(mod.getActiveTab().id).toBe(expectedNextTabId);

    windowHandlers.keydown({
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      key: 'Tab',
      preventDefault: jest.fn(),
    });
    expect(mod.getActiveTab().id).toBe(firstTab.id);

    const devtoolsOpenBefore = firstTab.webview.openDevTools.mock.calls.length;
    const devtoolsCloseBefore = firstTab.webview.closeDevTools.mock.calls.length;
    windowHandlers.keydown({
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      key: 'I',
      preventDefault: jest.fn(),
    });
    windowHandlers.keydown({
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      key: 'F12',
      preventDefault: jest.fn(),
    });
    expect(firstTab.webview.openDevTools.mock.calls.length).toBe(devtoolsOpenBefore + 1);
    expect(firstTab.webview.closeDevTools.mock.calls.length).toBe(devtoolsCloseBefore + 1);
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('DevTools opened');
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('DevTools closed');
  });
});
