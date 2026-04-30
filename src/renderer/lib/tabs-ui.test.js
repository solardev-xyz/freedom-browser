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

  test('keeps spinner on through preventDefault-triggered abort after a custom-protocol click', async () => {
    // Regression: when the main process intercepts a `bzz://`/`ens://`
    // (etc.) link click via `will-navigate`+preventDefault and forwards
    // the URL through `navigate-to-url`, Chromium fires a phantom
    // `did-fail-load -3` + `did-stop-loading` pair on the source webview
    // for the cancelled navigation. Without suppression those events
    // clear `tab.isLoading`, so the user sees no spinner during the
    // (often slow) ENS lookup that follows the click. The IPC handler
    // and per-tab handlers cooperate to swallow exactly that one abort
    // — including suppressing the active-tab onWebviewEvent forwarding,
    // since the navigation-side handler unconditionally calls
    // `setLoading(false)` and would otherwise undo the spinner state.
    jest.useFakeTimers();
    try {
      const { mod, electronHandlers } = await loadTabsModule();
      const onLoadTarget = jest.fn();
      const onWebviewEvent = jest.fn();
      mod.setLoadTargetHandler(onLoadTarget);
      mod.setWebviewEventHandler(onWebviewEvent);
      await mod.initTabs();

      const activeTab = mod.getActiveTab();
      const { webview } = activeTab;

      electronHandlers.navigateToUrl('bzz://meinhard.eth');
      expect(onLoadTarget).toHaveBeenCalledWith('bzz://meinhard.eth');
      // Simulate the `loadTarget` dispatch flipping the spinner on (the
      // ENS branch in navigation.js does this synchronously).
      activeTab.isLoading = true;
      onWebviewEvent.mockClear();

      webview.dispatch('did-fail-load', {
        errorCode: -3,
        errorDescription: 'ERR_ABORTED',
        validatedURL: 'bzz://meinhard.eth',
      });
      webview.dispatch('did-stop-loading');

      expect(activeTab.isLoading).toBe(true);
      // Phantom abort must NOT reach the navigation-side handler,
      // otherwise its unconditional `setLoading(false)` would undo the
      // spinner regardless of the tab-level suppression.
      expect(onWebviewEvent).not.toHaveBeenCalledWith('did-fail-load', expect.anything());
      expect(onWebviewEvent).not.toHaveBeenCalledWith('did-stop-loading', expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  test('manual stop-button abort still clears the spinner', async () => {
    // Counter-regression: the suppression above must not swallow
    // legitimate aborts (e.g. user hitting the stop button), which also
    // arrive as `did-fail-load -3` + `did-stop-loading`. Distinguished
    // by `tab.pendingAbortUrl` being unset when no will-navigate
    // intercept is in flight.
    const { mod } = await loadTabsModule();
    await mod.initTabs();

    const activeTab = mod.getActiveTab();
    const { webview } = activeTab;

    activeTab.isLoading = true;

    webview.dispatch('did-fail-load', {
      errorCode: -3,
      errorDescription: 'ERR_ABORTED',
      validatedURL: 'https://stopped.example',
    });
    webview.dispatch('did-stop-loading');

    expect(activeTab.isLoading).toBe(false);
  });

  test('an unrelated abort during the suppression window is not swallowed', async () => {
    // The suppression must compare the aborted URL to `pendingAbortUrl`,
    // not just check that the flag is set. Otherwise a Stop-button click
    // (or any other abort source) during the 1500 ms window after a
    // custom-protocol click would be silently consumed and the spinner
    // would only clear when the safety-net timer fires.
    jest.useFakeTimers();
    try {
      const { mod, electronHandlers } = await loadTabsModule();
      const onLoadTarget = jest.fn();
      const onWebviewEvent = jest.fn();
      mod.setLoadTargetHandler(onLoadTarget);
      mod.setWebviewEventHandler(onWebviewEvent);
      await mod.initTabs();

      const activeTab = mod.getActiveTab();
      const { webview } = activeTab;

      electronHandlers.navigateToUrl('bzz://meinhard.eth');
      activeTab.isLoading = true;
      onWebviewEvent.mockClear();

      webview.dispatch('did-fail-load', {
        errorCode: -3,
        errorDescription: 'ERR_ABORTED',
        validatedURL: 'https://other.example',
      });

      expect(activeTab.isLoading).toBe(false);
      expect(activeTab.pendingAbortUrl).toBe('bzz://meinhard.eth');
      expect(onWebviewEvent).toHaveBeenCalledWith(
        'did-fail-load',
        expect.objectContaining({ tabId: activeTab.id })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('closing a tab during the phantom-abort window cancels the safety timer', async () => {
    // The 1500 ms self-clearing timer set by `navigateToUrl` must be
    // cleared when the tab is closed before the timer fires — otherwise
    // it pins the (detached) tab object until the timer expires and
    // writes to a dead tab.
    jest.useFakeTimers();
    try {
      const { mod, electronHandlers } = await loadTabsModule();
      mod.setLoadTargetHandler(jest.fn());
      await mod.initTabs();

      const newTab = mod.createTab('https://example.test');
      const tabId = newTab.id;
      mod.switchTab(tabId);

      electronHandlers.navigateToUrl('bzz://meinhard.eth');
      const tabBeforeClose = mod.getTabs().find((t) => t.id === tabId);
      expect(tabBeforeClose.pendingAbortTimer).toBeDefined();
      expect(tabBeforeClose.pendingAbortTimer).not.toBeNull();
      // The proactive suppress-next-stop safety timer must also exist so
      // closeTab gets a chance to cancel it (asserted below).
      expect(tabBeforeClose.suppressNextStopTimer).toBeDefined();
      expect(tabBeforeClose.suppressNextStopTimer).not.toBeNull();

      mod.closeTab(tabId);
      // closeTab must clear both phantom-abort timers on the detached tab
      // so a later fire can't write to it. We don't assert on the global
      // timer count because the test bootstrap wires up unrelated debug /
      // probe timers that are out of scope here.
      expect(tabBeforeClose.pendingAbortTimer).toBeNull();
      expect(tabBeforeClose.suppressNextStopTimer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('keeps spinner on when phantom abort fires before navigate-to-url IPC arrives', async () => {
    // Race regression: the webview's phantom `did-fail-load -3` +
    // `did-stop-loading` pair travels via the <webview> DOM-event path,
    // while `navigate-to-url` travels via the parent BrowserWindow's
    // ipcRenderer channel. Their relative arrival order in the renderer
    // is non-deterministic. When the phantom did-fail-load fires before
    // the IPC handler runs, `pendingAbortUrl` is still null, so the
    // did-fail-load suppression check falls through and the paired
    // did-stop-loading also misses suppression — clearing the spinner
    // *after* `loadTarget` (driven by the late IPC) flipped it on for
    // the slow ENS resolution.
    //
    // The fix: the IPC handler proactively arms `suppressNextStop` (with
    // a short safety timer) so a phantom did-stop-loading arriving after
    // the IPC still gets swallowed.
    jest.useFakeTimers();
    try {
      const { mod, electronHandlers } = await loadTabsModule();
      const onLoadTarget = jest.fn();
      const onWebviewEvent = jest.fn();
      mod.setLoadTargetHandler(onLoadTarget);
      mod.setWebviewEventHandler(onWebviewEvent);
      await mod.initTabs();

      const activeTab = mod.getActiveTab();
      const { webview } = activeTab;

      // Step 1: webview reports the click as a real load start.
      webview.dispatch('did-start-loading');

      // Step 2: phantom did-fail-load arrives BEFORE the IPC handler.
      // pendingAbortUrl is null so suppression must miss and the
      // navigation-side handler is correctly notified (it'll clear
      // isLoading via setLoading(false), matching pre-fix behavior).
      webview.dispatch('did-fail-load', {
        errorCode: -3,
        errorDescription: 'ERR_ABORTED',
        validatedURL: 'bzz://meinhard.eth',
      });
      expect(activeTab.isLoading).toBe(false);

      // Step 3: navigate-to-url IPC arrives. The handler arms both
      // pendingAbortUrl (in case did-fail-load follows) AND
      // suppressNextStop (in case the paired did-stop-loading is still
      // in flight, which is exactly what's about to happen here).
      electronHandlers.navigateToUrl('bzz://meinhard.eth');
      expect(onLoadTarget).toHaveBeenCalledWith('bzz://meinhard.eth');
      expect(activeTab.suppressNextStop).toBe(true);
      expect(activeTab.suppressNextStopTimer).not.toBeNull();

      // Step 4: simulate `loadTarget` flipping the spinner on synchronously
      // (the ENS branch in navigation.js does this).
      activeTab.isLoading = true;
      onWebviewEvent.mockClear();

      // Step 5: phantom did-stop-loading lands. With the proactive
      // suppression in place it gets swallowed and the spinner stays on
      // through the slow ENS resolution that follows.
      webview.dispatch('did-stop-loading');
      expect(activeTab.isLoading).toBe(true);
      expect(activeTab.suppressNextStop).toBe(false);
      expect(activeTab.suppressNextStopTimer).toBeNull();
      expect(onWebviewEvent).not.toHaveBeenCalledWith('did-stop-loading', expect.anything());

      // Counter-check: after the safety timer would have fired, a real
      // did-stop-loading from the post-resolution content load is NOT
      // swallowed. (suppressNextStop was already consumed above; this
      // verifies the per-tab state is back to baseline.)
      jest.advanceTimersByTime(500);
      activeTab.isLoading = true;
      webview.dispatch('did-stop-loading');
      expect(activeTab.isLoading).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('safety timer clears suppressNextStop if no phantom did-stop-loading consumes it', async () => {
    // If the phantom did-fail-load + did-stop-loading pair both already
    // fired before the IPC handler runs (the most degenerate
    // interleaving), the proactive `suppressNextStop=true` armed by the
    // IPC handler has nothing to consume it. The 200 ms safety timer
    // must clear it, otherwise a *real* did-stop-loading (e.g. from a
    // very fast post-resolution load) arriving within the 1.5 s
    // pendingAbortTimer window would be silently swallowed.
    jest.useFakeTimers();
    try {
      const { mod, electronHandlers } = await loadTabsModule();
      mod.setLoadTargetHandler(jest.fn());
      mod.setWebviewEventHandler(jest.fn());
      await mod.initTabs();

      const activeTab = mod.getActiveTab();
      electronHandlers.navigateToUrl('bzz://meinhard.eth');
      expect(activeTab.suppressNextStop).toBe(true);

      jest.advanceTimersByTime(200);

      expect(activeTab.suppressNextStop).toBe(false);
      expect(activeTab.suppressNextStopTimer).toBeNull();
      // pendingAbortUrl has its own (longer) timer and is still armed.
      expect(activeTab.pendingAbortUrl).toBe('bzz://meinhard.eth');
    } finally {
      jest.useRealTimers();
    }
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
