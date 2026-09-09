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
      // Shift+click / `new-window` disposition routes back out through the
      // existing "Open Link in New Window" request (#303).
      openUrlInNewWindow: jest.fn(),
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
  const linkStatusMocks = {
    clearLinkStatus: jest.fn(),
    clearHoverStatus: jest.fn(),
    showLinkStatus: jest.fn(),
    setLinkStatusSide: jest.fn(),
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
  jest.doMock('./link-status.js', () => linkStatusMocks);
  // `internalPages` is opt-in per test: with the default empty map no
  // `freedom://<page>` URL is a recognised internal page, which is the shape
  // every pre-existing test in this file assumes.
  const internalPages = options.internalPages || {};
  jest.doMock('./page-urls.js', () => ({
    homeUrl: options.homeUrl || HOME_URL,
    getOnchainInterstitialTarget: () => null,
    internalPages,
    getInternalPageName: (url) =>
      Object.entries(internalPages).find(([, pageUrl]) => pageUrl === url)?.[0] || null,
    // Mirrors `page-urls.js#isNewTabPageUrl`: this window's new-tab page in
    // both the friendly `freedom://` form and the resolved internal-page one
    // (#312), for a normal window (`home`) and a private one (`private`).
    isNewTabPageUrl: (url) =>
      url === (options.homeUrl || HOME_URL) ||
      url === 'freedom://home' ||
      url === 'freedom://private' ||
      url === internalPages.home ||
      url === internalPages.private,
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
    linkStatusMocks,
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

  test('createTab loads file:// homeUrl directly without going through onLoadTarget', async () => {
    // Regression: a previous fix replaced "anything not http(s) loads
    // homeUrl, then onLoadTarget(url) overrides ~50 ms later" with
    // "anything not http(s) loads about:blank, then onLoadTarget(url)".
    // That broke production new-tab + new-window paths because the real
    // homeUrl is a `file:///app/pages/home.html` URL, and `loadTarget`
    // only routes view-source/ethereum/freedom/ENS/IPFS/IPNS/rad/bzz/http
    // — `file://` falls through to "Ignoring empty input or invalid URL"
    // and the tab stays on about:blank forever. The fix is an explicit
    // allowlist of *direct-load-safe* URLs (homeUrl + http(s) +
    // about:blank); everything else (dweb schemes AND hostile schemes)
    // parks on about:blank and is dispatched to loadTarget, which routes
    // what it can and silently drops the rest.
    const productionHomeUrl = 'file:///app/pages/home.html';
    const { mod, createdWebviews } = await loadTabsModule({ homeUrl: productionHomeUrl });
    const onLoadTarget = jest.fn();
    mod.setLoadTargetHandler(onLoadTarget);

    jest.useFakeTimers();
    try {
      await mod.initTabs();
      // initTabs creates the first tab via createTab(homeUrl). The webview
      // must point at homeUrl directly, not at about:blank.
      expect(createdWebviews[0].getAttribute('src')).toBe(productionHomeUrl);

      // Likewise for an explicit createTab(homeUrl) (new-tab button path).
      mod.createTab(productionHomeUrl);
      expect(createdWebviews[1].getAttribute('src')).toBe(productionHomeUrl);

      // No deferred onLoadTarget dispatch for direct URLs.
      jest.runAllTimers();
      expect(onLoadTarget).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('createTab never loads hostile schemes directly into the webview', async () => {
    // Security regression: after tightening the indirect-protocol
    // allowlist to fix the GUEST_VIEW_MANAGER_CALL noise, the inverse
    // (everything-not-in-the-allowlist loads directly) made arbitrary
    // `file:///etc/passwd`, `data:`, `javascript:`, etc. URLs into
    // direct webview navigations. That path is reachable from main-
    // process IPC (`tab:new-with-url` via `setWindowOpenHandler`) and
    // any caller of `createTab(url)`. The fix flips the rule: only
    // direct-load known-safe URLs (!url, http(s), about:blank,
    // homeUrl); park everything else on about:blank and dispatch
    // through loadTarget, which silently drops what it can't route.
    const productionHomeUrl = 'file:///app/pages/home.html';
    const { mod, createdWebviews } = await loadTabsModule({
      homeUrl: productionHomeUrl,
    });
    const onLoadTarget = jest.fn();
    mod.setLoadTargetHandler(onLoadTarget);

    jest.useFakeTimers();
    try {
      await mod.initTabs();
      const hostileTargets = [
        'file:///etc/passwd',
        'file:///app/pages/settings.html',
        'data:text/html,<script>alert(1)</script>',
        'javascript:alert(1)',
        'blob:https://example.com/abc',
        'chrome://settings',
      ];
      const baseCount = createdWebviews.length;
      for (const url of hostileTargets) {
        mod.createTab(url);
      }
      for (let i = 0; i < hostileTargets.length; i++) {
        const src = createdWebviews[baseCount + i].getAttribute('src');
        expect(src).toBe('about:blank');
        expect(src).not.toBe(hostileTargets[i]);
      }
      jest.runAllTimers();
      expect(onLoadTarget.mock.calls.map((call) => call[0])).toEqual(hostileTargets);
    } finally {
      jest.useRealTimers();
    }
  });

  test('createTab defers dweb URLs through onLoadTarget with about:blank placeholder', async () => {
    // Counterpart to the file:// regression above: dweb / freedom /
    // wallet schemes (`bzz:`, `ipfs:`, `ipns:`, `ens:`, `rad:`,
    // `freedom:`, `ethereum:`, `view-source:`) MUST sit on about:blank
    // and let loadTarget take over after a microtask, because pointing
    // the webview at homeUrl synchronously and then calling loadURL
    // triggers `net::ERR_ABORTED` and Electron logs the rejected
    // GUEST_VIEW_MANAGER_CALL promise once per tab.
    const { mod, createdWebviews } = await loadTabsModule({
      homeUrl: 'file:///app/pages/home.html',
    });
    const onLoadTarget = jest.fn();
    mod.setLoadTargetHandler(onLoadTarget);

    jest.useFakeTimers();
    try {
      await mod.initTabs();
      const targets = [
        'bzz://meinhard.eth',
        'ipfs://vitalik.eth',
        'ipns://docs.ipfs.tech',
        'ens://swarm.eth',
        'rad:z2u2CP3ZJzB7ZqE8jHrau19yjcfCQ',
        'freedom://settings',
        'ethereum:0xabc',
        'view-source:bzz://meinhard.eth',
      ];
      const baseCount = createdWebviews.length;
      for (const url of targets) {
        mod.createTab(url);
      }
      for (let i = 0; i < targets.length; i++) {
        expect(createdWebviews[baseCount + i].getAttribute('src')).toBe('about:blank');
      }
      jest.runAllTimers();
      expect(onLoadTarget.mock.calls.map((call) => call[0])).toEqual(targets);
    } finally {
      jest.useRealTimers();
    }
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
      // Flagged page-initiated: a scripted/link navigation the main process
      // bounced back here must not discard an address-bar edit (#305).
      expect(onLoadTarget).toHaveBeenCalledWith('bzz://meinhard.eth', null, null, {
        pageInitiated: true,
      });
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

  test('ignores sub-frame did-fail-load (third-party iframe / pixel failure)', async () => {
    // Regression: Chromium fires `did-fail-load` for ANY frame, including
    // hidden third-party iframes (WalletConnect verify attestation) and
    // ad-tech cookie-sync pixels. Without an `isMainFrame` gate, those
    // failures clear the main-frame loading state and (via the
    // navigation-side handler) replace the entire page with `error.html`
    // — hijacking the user's perfectly-loaded top-level page on top of
    // an unrelated sub-resource error.
    const { mod } = await loadTabsModule();
    const onWebviewEvent = jest.fn();
    mod.setWebviewEventHandler(onWebviewEvent);
    await mod.initTabs();

    const activeTab = mod.getActiveTab();
    const { webview } = activeTab;
    activeTab.isLoading = true;

    webview.dispatch('did-fail-load', {
      errorCode: -310,
      errorDescription: 'ERR_BLOCKED_BY_RESPONSE',
      validatedURL: 'https://verify.walletconnect.com/attestation/abc',
      isMainFrame: false,
    });

    expect(activeTab.isLoading).toBe(true);
    expect(onWebviewEvent).not.toHaveBeenCalledWith('did-fail-load', expect.anything());
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
      // Flagged page-initiated: a scripted/link navigation the main process
      // bounced back here must not discard an address-bar edit (#305).
      expect(onLoadTarget).toHaveBeenCalledWith('bzz://meinhard.eth', null, null, {
        pageInitiated: true,
      });
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

  test('fast freedom:// navigation clears the spinner inside the suppression window', async () => {
    // Regression: the proactive `suppressNextStop=true` set by the
    // navigate-to-url IPC is armed for every intercepted scheme
    // (freedom://, bzz://, ens://, ipfs://, ipns://, rad:, ethereum:),
    // but only the async ENS-backed schemes actually need it — slow
    // resolution keeps the real did-stop-loading well past the 200 ms
    // safety timer. Fast schemes like `freedom://` load synchronously
    // (~10–50 ms), so the real did-stop-loading lands inside the
    // suppression window and would be silently swallowed unless we
    // disarm on the real did-start-loading. Once a real load starts,
    // the phantom has either already fired or been elided, so the
    // next did-stop-loading is the real one.
    jest.useFakeTimers();
    try {
      const { mod, electronHandlers } = await loadTabsModule();
      const onWebviewEvent = jest.fn();
      mod.setLoadTargetHandler(jest.fn());
      mod.setWebviewEventHandler(onWebviewEvent);
      await mod.initTabs();

      const activeTab = mod.getActiveTab();
      const { webview } = activeTab;

      electronHandlers.navigateToUrl('freedom://settings');
      expect(activeTab.suppressNextStop).toBe(true);

      // Real load starts — disarms proactive suppression so the paired
      // real stop isn't swallowed.
      webview.dispatch('did-start-loading');
      expect(activeTab.suppressNextStop).toBe(false);
      expect(activeTab.suppressNextStopTimer).toBeNull();
      expect(activeTab.isLoading).toBe(true);

      onWebviewEvent.mockClear();
      webview.dispatch('did-stop-loading');

      expect(activeTab.isLoading).toBe(false);
      expect(onWebviewEvent).toHaveBeenCalledWith(
        'did-stop-loading',
        expect.objectContaining({ tabId: activeTab.id })
      );
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
    // The `#bzz-webview` focus/mousedown dismissal that used to live in
    // initTabs was dead code — webviews are created id-less, so the lookup was
    // always null (#315, #306). The fake DOM *does* resolve that id, so this
    // asserts the listeners are really gone rather than merely never firing.
    expect(elements.bzzWebview.handlers.focus).toBeUndefined();
    expect(elements.bzzWebview.handlers.mousedown).toBeUndefined();

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
    // The reused tab's own webview is named explicitly so a background
    // re-navigation can't land in whatever tab happens to be active (#303).
    expect(onLoadTarget).toHaveBeenCalledWith(
      'https://reuse-target.example',
      null,
      expect.objectContaining({ tagName: 'WEBVIEW' })
    );

    electronHandlers.newTabWithUrl('ipfs://cid', 'ipfs-target');
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    expect(onLoadTarget).toHaveBeenCalledWith(
      'ipfs://cid',
      null,
      expect.objectContaining({ tagName: 'WEBVIEW' })
    );

    electronHandlers.navigateToUrl('https://navigate.example');
    electronHandlers.loadUrl('https://load.example');
    expect(onLoadTarget).toHaveBeenCalledWith('https://navigate.example', null, null, {
      pageInitiated: true,
    });
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

  test('forwards update-target-url and link-status:zone for the active tab only', async () => {
    const { mod, linkStatusMocks } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    mod.switchTab(secondTab.id);

    linkStatusMocks.showLinkStatus.mockClear();
    linkStatusMocks.clearLinkStatus.mockClear();
    linkStatusMocks.clearHoverStatus.mockClear();
    linkStatusMocks.setLinkStatusSide.mockClear();

    // Active tab: non-empty url goes to showLinkStatus, empty triggers a
    // hover-only clear so loading diagnostics can remain underneath.
    secondTab.webview.dispatch('update-target-url', { url: 'https://hovered.example/' });
    expect(linkStatusMocks.showLinkStatus).toHaveBeenCalledWith('https://hovered.example/');

    secondTab.webview.dispatch('update-target-url', { url: '' });
    expect(linkStatusMocks.clearHoverStatus).toHaveBeenLastCalledWith();

    secondTab.webview.dispatch('ipc-message', {
      channel: 'link-status:zone',
      args: [{ inLeftZone: true }],
    });
    expect(linkStatusMocks.setLinkStatusSide).toHaveBeenLastCalledWith('right');

    secondTab.webview.dispatch('ipc-message', {
      channel: 'link-status:zone',
      args: [{ inLeftZone: false }],
    });
    expect(linkStatusMocks.setLinkStatusSide).toHaveBeenLastCalledWith('left');

    // Background-tab events for both channels are dropped entirely so
    // hovering links in a hidden tab can never move the active tab's bar.
    linkStatusMocks.showLinkStatus.mockClear();
    linkStatusMocks.clearLinkStatus.mockClear();
    linkStatusMocks.setLinkStatusSide.mockClear();

    firstTab.webview.dispatch('update-target-url', { url: 'https://background.example/' });
    expect(linkStatusMocks.showLinkStatus).not.toHaveBeenCalled();
    expect(linkStatusMocks.clearLinkStatus).not.toHaveBeenCalled();

    firstTab.webview.dispatch('ipc-message', {
      channel: 'link-status:zone',
      args: [{ inLeftZone: true }],
    });
    expect(linkStatusMocks.setLinkStatusSide).not.toHaveBeenCalled();
  });

  test('switchTab clears the link status immediately and restores per-tab side', async () => {
    // Per-tab side is restored from the tab's last-known cursor-zone
    // state instead of being blindly reset to 'left'. With no prior
    // zone events on either tab, the restored side is 'left' for both.
    const { mod, linkStatusMocks } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');

    linkStatusMocks.clearLinkStatus.mockClear();
    linkStatusMocks.setLinkStatusSide.mockClear();

    mod.switchTab(firstTab.id);
    expect(linkStatusMocks.clearLinkStatus).toHaveBeenCalledWith({ immediate: true });
    expect(linkStatusMocks.setLinkStatusSide).toHaveBeenCalledWith('left');

    linkStatusMocks.clearLinkStatus.mockClear();
    linkStatusMocks.setLinkStatusSide.mockClear();

    mod.switchTab(secondTab.id);
    expect(linkStatusMocks.clearLinkStatus).toHaveBeenCalledWith({ immediate: true });
    expect(linkStatusMocks.setLinkStatusSide).toHaveBeenCalledWith('left');
  });

  test('switchTab restores the active tab side from the per-tab zone state', async () => {
    // Regression: the preload only emits link-status:zone events on
    // transitions, and a hidden webview's `linkStatusInZone` freezes at
    // whatever value it held when the tab was backgrounded. If the
    // renderer reset `currentSide` to 'left' on every switch (the
    // previous behavior), returning to a tab whose pointer is still in
    // the bottom-left band would leave the bar on `left` until the
    // pointer leaves and re-enters the zone — painting it over the
    // link the user is hovering.
    //
    // The fix tracks per-tab zone state in tabs.js and restores it on
    // activation so the bar's side matches the destination tab's
    // current pointer position immediately.
    const { mod, linkStatusMocks } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    mod.switchTab(firstTab.id);

    // Pointer enters the bottom-left band on the first tab → bar flips
    // to the right side and per-tab state remembers the zone hit.
    firstTab.webview.dispatch('ipc-message', {
      channel: 'link-status:zone',
      args: [{ inLeftZone: true }],
    });

    linkStatusMocks.clearLinkStatus.mockClear();
    linkStatusMocks.setLinkStatusSide.mockClear();

    // Switch to a tab whose preload has never emitted — side restores to
    // its default 'left'.
    mod.switchTab(secondTab.id);
    expect(linkStatusMocks.setLinkStatusSide).toHaveBeenLastCalledWith('left');

    linkStatusMocks.clearLinkStatus.mockClear();
    linkStatusMocks.setLinkStatusSide.mockClear();

    // Switch back to the first tab — the per-tab state is replayed so
    // the bar sits on the correct side without waiting for a new
    // pointer transition inside the (still-in-zone) preload.
    mod.switchTab(firstTab.id);
    expect(linkStatusMocks.clearLinkStatus).toHaveBeenCalledWith({ immediate: true });
    expect(linkStatusMocks.setLinkStatusSide).toHaveBeenLastCalledWith('right');
  });
  // #304: activating a tab hands keyboard focus to that tab's page, the way
  // Chrome does — otherwise focus is left on the tab button (mouse switch) or
  // stranded on the now-hidden outgoing webview (keyboard switch), and
  // scrolling/typing does nothing until the user clicks into the page.
  test('switchTab focuses the incoming page and never the hidden outgoing one', async () => {
    const { mod } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    // The window's first tab starts on the new-tab page, which defers focus to
    // the address bar (see the next test) — navigate it to a real page so this
    // one is about the ordinary page-focus rule.
    firstTab.url = 'https://first.example';
    const secondTab = mod.createTab('https://second.example');
    const firstFocus = jest.spyOn(firstTab.webview, 'focus');
    const secondFocus = jest.spyOn(secondTab.webview, 'focus');

    mod.switchTab(firstTab.id);
    expect(firstFocus).toHaveBeenCalledTimes(1);
    expect(secondFocus).not.toHaveBeenCalled();

    // Keyboard switch (Ctrl+Tab) goes through the same path.
    mod.switchToNextTab();
    expect(mod.getActiveTab().id).toBe(secondTab.id);
    expect(secondFocus).toHaveBeenCalledTimes(1);
    expect(firstFocus).toHaveBeenCalledTimes(1);
  });

  // #304, the switch-back case: a tab sitting on this window's new-tab page
  // has no focus target in its guest (`home.html`/`private.html` are inert),
  // so focusing the page there drops the keystroke the user is about to type.
  // Chrome focuses the omnibox instead — which is navigation.js' `tab-switched`
  // job, the same deferral a brand-new tab uses.
  test('switchTab leaves the page unfocused for a tab on the new-tab page', async () => {
    const { mod } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    const firstFocus = jest.spyOn(firstTab.webview, 'focus');
    const secondFocus = jest.spyOn(secondTab.webview, 'focus');

    // The first tab is still on the new-tab page it was opened with.
    expect(firstTab.url).toBe(HOME_URL);
    mod.switchTab(firstTab.id);
    expect(mod.getActiveTab().id).toBe(firstTab.id);
    expect(firstFocus).not.toHaveBeenCalled();
    // The deferral is one-sided: the tab on a real page still gets the
    // keyboard on the way back.
    mod.switchTab(secondTab.id);
    expect(secondFocus).toHaveBeenCalledTimes(1);

    // …and once that tab has navigated somewhere real it is an ordinary tab
    // again. `tab.url` is the friendly form; the resolved `file://…/home.html`
    // one Chromium commits lands in `currentPageUrl`, and both have to count.
    firstTab.url = 'https://first.example';
    mod.switchTab(firstTab.id);
    expect(firstFocus).toHaveBeenCalledTimes(1);

    mod.switchTab(secondTab.id);
    firstTab.url = null;
    firstTab.navigationState.currentPageUrl = HOME_URL;
    mod.switchTab(firstTab.id);
    expect(firstFocus).toHaveBeenCalledTimes(1);
  });

  // #304 × #314. The page-focus rule above and the "a tab left mid-edit comes
  // back mid-edit, with the address bar focused" rule both fire on a tab
  // switch, and they want the keyboard in different places. The address bar
  // wins, because it is the surface the user was last typing into — and
  // because it cannot win any other way: navigation.js' `addressInput.focus()`
  // runs synchronously inside the `tab-switched` dispatch below, while
  // `<webview>.focus()` hands focus to the guest asynchronously, so a webview
  // focus issued first still lands last and takes the bar's focus away again.
  test('switchTab leaves the page unfocused for a tab with an uncommitted address-bar edit', async () => {
    const { mod } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    // On a real page, so the new-tab-page deferral above isn't what's being
    // measured — the draft has to carry this on its own.
    firstTab.url = 'https://first.example';
    const secondTab = mod.createTab('https://second.example');
    const firstFocus = jest.spyOn(firstTab.webview, 'focus');

    // The user typed into the first tab's address bar and switched away
    // without committing (`address-bar-edit.js` records the draft here).
    firstTab.navigationState.addressBarPendingInput = 'half-typed';

    mod.switchTab(firstTab.id);
    expect(mod.getActiveTab().id).toBe(firstTab.id);
    expect(firstFocus).not.toHaveBeenCalled();

    // An empty draft is still a draft — the user cleared the bar deliberately.
    mod.switchTab(secondTab.id);
    firstTab.navigationState.addressBarPendingInput = '';
    mod.switchTab(firstTab.id);
    expect(firstFocus).not.toHaveBeenCalled();

    // Once the edit is committed or reverted the page gets the keyboard again.
    mod.switchTab(secondTab.id);
    firstTab.navigationState.addressBarPendingInput = null;
    mod.switchTab(firstTab.id);
    expect(firstFocus).toHaveBeenCalledTimes(1);
  });

  // #304: the tab promoted when the active tab closes is focused too.
  test('closing the active tab focuses the tab promoted in its place', async () => {
    const { mod } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    // On a real page: the promoted tab gets the keyboard, unless it is sitting
    // on the new-tab page, where the address bar takes it instead.
    firstTab.url = 'https://first.example';
    const secondTab = mod.createTab('https://second.example');
    const firstFocus = jest.spyOn(firstTab.webview, 'focus');

    expect(mod.getActiveTab().id).toBe(secondTab.id);
    mod.closeTab(secondTab.id);

    expect(mod.getActiveTab().id).toBe(firstTab.id);
    expect(firstFocus).toHaveBeenCalled();
  });

  // #311: below the tabs' minimum width the strip scrolls instead of clipping,
  // so the newly activated tab has to be scrolled back into view — a tab you
  // cannot see or click is the bug this fixes.
  test('switchTab scrolls the activated tab into view', async () => {
    const { mod, elements } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    const firstTabEl = findTabElement(elements.tabBar, firstTab.id);
    firstTabEl.scrollIntoView = jest.fn();

    mod.switchTab(firstTab.id);

    expect(firstTabEl.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
    void secondTab;
  });

  // #311: the edge fades are the only cue that more tabs exist in a direction,
  // since the strip's scrollbar is hidden.
  test('the tab strip marks which edge has more tabs behind it', async () => {
    const { mod, elements } = await loadTabsModule();
    await mod.initTabs();

    // Not overflowing: neither fade.
    elements.tabBar.scrollWidth = 400;
    elements.tabBar.clientWidth = 400;
    elements.tabBar.scrollLeft = 0;
    mod.createTab('https://second.example');
    expect(elements.tabBar.classList.contains('overflow-start')).toBe(false);
    expect(elements.tabBar.classList.contains('overflow-end')).toBe(false);

    // Overflowing, scrolled to the left end: more tabs to the right only.
    elements.tabBar.scrollWidth = 1200;
    elements.tabBar.clientWidth = 400;
    elements.tabBar.scrollLeft = 0;
    elements.tabBar.dispatch('scroll');
    expect(elements.tabBar.classList.contains('overflow-start')).toBe(false);
    expect(elements.tabBar.classList.contains('overflow-end')).toBe(true);

    // Scrolled into the middle: tabs hidden on both sides.
    elements.tabBar.scrollLeft = 300;
    elements.tabBar.dispatch('scroll');
    expect(elements.tabBar.classList.contains('overflow-start')).toBe(true);
    expect(elements.tabBar.classList.contains('overflow-end')).toBe(true);

    // Scrolled to the right end: more tabs to the left only.
    elements.tabBar.scrollLeft = 800;
    elements.tabBar.dispatch('scroll');
    expect(elements.tabBar.classList.contains('overflow-start')).toBe(true);
    expect(elements.tabBar.classList.contains('overflow-end')).toBe(false);
  });

  // #303: Ctrl/Cmd+click and middle-click open a background tab — the tab is
  // created and navigated, but the user stays on the page they were reading
  // and it keeps keyboard focus.
  test('a background tab is created without switching away from the current one', async () => {
    jest.useFakeTimers();
    const { mod } = await loadTabsModule();
    const onLoadTarget = jest.fn();
    mod.setLoadTargetHandler(onLoadTarget);
    await mod.initTabs();

    const activeTab = mod.getActiveTab();
    const activeFocus = jest.spyOn(activeTab.webview, 'focus');

    const backgroundTab = mod.openInNewTabWithTarget('ipfs://cid', null, { background: true });
    jest.runOnlyPendingTimers();

    expect(mod.getTabs()).toHaveLength(2);
    expect(mod.getActiveTab().id).toBe(activeTab.id);
    expect(activeFocus).not.toHaveBeenCalled();
    expect(backgroundTab.webview.classList.contains('hidden')).toBe(true);
    // The dweb URL still resolves — into the BACKGROUND tab's webview, not
    // into whatever tab is active.
    expect(onLoadTarget).toHaveBeenCalledWith('ipfs://cid', null, backgroundTab.webview);

    // Without the flag the same call still opens in the foreground.
    const foregroundTab = mod.openInNewTabWithTarget('https://fg.example', null);
    expect(mod.getActiveTab().id).toBe(foregroundTab.id);
  });

  // #303: a `freedom://` internal page is a singleton tab, but that must not
  // outrank the disposition — Ctrl/Cmd+click on a `freedom://settings` link
  // inside a page (e.g. a web3:// onchain app, whose preload forwards
  // freedom: hrefs) has to leave the user on the page they are reading.
  test('a background open of a freedom:// page does not switch away from the current tab', async () => {
    jest.useFakeTimers();
    const { mod } = await loadTabsModule({
      internalPages: { settings: 'file:///app/pages/settings.html' },
    });
    const onLoadTarget = jest.fn();
    mod.setLoadTargetHandler(onLoadTarget);
    await mod.initTabs();

    const activeTab = mod.getActiveTab();
    const activeFocus = jest.spyOn(activeTab.webview, 'focus');

    // No settings tab yet: created hidden, in the background.
    const opened = mod.openInNewTabWithTarget('freedom://settings', null, { background: true });
    expect(mod.getTabs()).toHaveLength(2);
    expect(mod.getActiveTab().id).toBe(activeTab.id);
    expect(opened.webview.classList.contains('hidden')).toBe(true);
    expect(activeFocus).not.toHaveBeenCalled();

    // A second background open reuses the singleton tab and routes it to the
    // requested section — into that tab's own webview, still without switching.
    const reused = mod.openInNewTabWithTarget('freedom://settings/profile', null, {
      background: true,
    });
    expect(reused.id).toBe(opened.id);
    expect(mod.getTabs()).toHaveLength(2);
    expect(mod.getActiveTab().id).toBe(activeTab.id);
    jest.runOnlyPendingTimers();
    expect(onLoadTarget).toHaveBeenCalledWith('freedom://settings/profile', null, opened.webview);

    // Without the flag the singleton is focused, exactly as before.
    const focused = mod.openInNewTabWithTarget('freedom://settings', null);
    expect(focused.id).toBe(opened.id);
    expect(mod.getActiveTab().id).toBe(opened.id);
  });

  // #303: Chrome resolves the modifier before the `target` attribute — a
  // Ctrl/Cmd+click never re-navigates the window a name already points at,
  // which when that window is the current tab would navigate the page out from
  // under the user.
  test('a background open of a named target opens a new tab instead of reusing it', async () => {
    jest.useFakeTimers();
    const { mod } = await loadTabsModule();
    const onLoadTarget = jest.fn();
    mod.setLoadTargetHandler(onLoadTarget);
    await mod.initTabs();

    // A plain click on <a target="foo"> opens the tab and registers the name.
    const named = mod.openInNewTabWithTarget('ipfs://one', 'foo');
    expect(mod.getActiveTab().id).toBe(named.id);
    jest.runOnlyPendingTimers();
    onLoadTarget.mockClear();

    // Ctrl+click on a second target="foo" link, from inside that very tab.
    const opened = mod.openInNewTabWithTarget('ipfs://two', 'foo', { background: true });
    expect(opened.id).not.toBe(named.id);
    expect(mod.getTabs()).toHaveLength(3);
    expect(mod.getActiveTab().id).toBe(named.id);
    expect(opened.webview.classList.contains('hidden')).toBe(true);
    jest.runOnlyPendingTimers();
    // The tab the user is reading was never re-navigated; the new one was.
    expect(onLoadTarget).not.toHaveBeenCalledWith('ipfs://two', null, named.webview);
    expect(onLoadTarget).toHaveBeenCalledWith('ipfs://two', null, opened.webview);

    // The fresh tab took the name over, so an unmodified click reuses it.
    const reused = mod.openInNewTabWithTarget('ipfs://three', 'foo');
    expect(reused.id).toBe(opened.id);
    expect(mod.getTabs()).toHaveLength(3);
  });

  // #303: the main process forwards the disposition Chromium derived from the
  // click's modifiers over `tab:new-with-url`.
  test('tab:new-with-url honours the background and new-window dispositions', async () => {
    const { mod, electronAPI, electronHandlers } = await loadTabsModule();
    await mod.initTabs();

    const activeTab = mod.getActiveTab();
    electronHandlers.newTabWithUrl('https://bg.example', null, { background: true });
    expect(mod.getTabs()).toHaveLength(2);
    expect(mod.getActiveTab().id).toBe(activeTab.id);

    electronHandlers.newTabWithUrl('https://win.example', null, { newWindow: true });
    expect(electronAPI.openUrlInNewWindow).toHaveBeenCalledWith('https://win.example');
    expect(mod.getTabs()).toHaveLength(2);

    // No options → the previous foreground-tab behaviour.
    electronHandlers.newTabWithUrl('https://fg.example', null);
    expect(mod.getTabs()).toHaveLength(3);
    expect(mod.getActiveTab().url).toBe('https://fg.example');
  });

  // #315: the menu was dismissed by a mouse tab switch (the strip click
  // reaches the document listener) but not by a keyboard one, leaving every
  // destructive item bound to the tab the user had just left.
  test('a tab context menu is dismissed by any tab activation and by a close', async () => {
    const { mod, elements } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    mod.switchTab(firstTab.id);
    const firstTabEl = findTabElement(elements.tabBar, firstTab.id);

    const openMenu = () =>
      firstTabEl.dispatch('contextmenu', {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
        clientX: 20,
        clientY: 30,
      });

    openMenu();
    expect(elements.tabContextMenu.classList.contains('hidden')).toBe(false);

    // Keyboard switch (Ctrl+Tab / Ctrl+PageDown / Ctrl+1..8).
    mod.switchToNextTab();
    expect(mod.getActiveTab().id).toBe(secondTab.id);
    expect(elements.tabContextMenu.classList.contains('hidden')).toBe(true);

    // A tab closing invalidates the menu's anchor and its target too.
    mod.switchTab(firstTab.id);
    openMenu();
    expect(elements.tabContextMenu.classList.contains('hidden')).toBe(false);
    mod.closeTab(secondTab.id);
    expect(elements.tabContextMenu.classList.contains('hidden')).toBe(true);
  });

  // #315: re-activating the tab that is already foreground (Ctrl+1 on tab 1
  // while tab 1 is active) is still an activation — it has to dismiss the
  // menu, which is anchored to some other tab with every destructive item
  // live. The dismissal therefore runs before switchTab's already-foreground
  // early return, without taking any of the swap's other side effects with it.
  test('a tab context menu is dismissed by re-activating the already-active tab', async () => {
    const { mod, elements, linkStatusMocks } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    mod.switchTab(firstTab.id);

    // Menu open over tab 2 while tab 1 is the active one.
    findTabElement(elements.tabBar, secondTab.id).dispatch('contextmenu', {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      clientX: 20,
      clientY: 30,
    });
    expect(elements.tabContextMenu.classList.contains('hidden')).toBe(false);

    linkStatusMocks.clearLinkStatus.mockClear();
    mod.switchTab(firstTab.id);

    expect(elements.tabContextMenu.classList.contains('hidden')).toBe(true);
    // Still an early return otherwise: no find-bar close, no webview re-hide.
    expect(mod.getActiveTab().id).toBe(firstTab.id);
    expect(linkStatusMocks.clearLinkStatus).not.toHaveBeenCalled();
  });

  // #311: the strip only scrolls the active tab back into view on activation,
  // so the two other things that reflow it — a window resize, and closing a
  // tab that sits left of the viewport — could leave the active tab past an
  // edge, unreachable, until the next tab switch.
  test('the active tab is scrolled back into view on a resize and on a close', async () => {
    const { mod, elements, windowHandlers } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    mod.createTab('https://second.example');
    const thirdTab = mod.createTab('https://third.example');
    const thirdTabEl = findTabElement(elements.tabBar, thirdTab.id);
    thirdTabEl.scrollIntoView = jest.fn();

    windowHandlers.resize();
    expect(thirdTabEl.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });

    // Closing a tab to the left of the active one takes its width out of the
    // strip and slides everything after it.
    thirdTabEl.scrollIntoView.mockClear();
    mod.closeTab(firstTab.id);
    expect(mod.getActiveTab().id).toBe(thirdTab.id);
    expect(thirdTabEl.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
  });

  // #315: belt and braces — if some future path leaves a menu up over a tab
  // that no longer exists, its destructive items refuse rather than resolving
  // to whichever tab took that id's place.
  test('a tab context menu item refuses to act on a tab that is gone', async () => {
    const { mod, elements } = await loadTabsModule();
    await mod.initTabs();

    const firstTab = mod.getActiveTab();
    const secondTab = mod.createTab('https://second.example');
    const secondTabEl = findTabElement(elements.tabBar, secondTab.id);

    secondTabEl.dispatch('contextmenu', {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      clientX: 20,
      clientY: 30,
    });
    // Drop the tab out from under the menu without going through closeTab's
    // dismissal, then click "Close Tab".
    mod.getTabs().splice(1, 1);
    elements.tabContextMenu.dispatch('click', { target: elements.closeBtn });

    expect(mod.getTabs().map((tab) => tab.id)).toEqual([firstTab.id]);
    expect(elements.tabContextMenu.classList.contains('hidden')).toBe(true);
  });
});
