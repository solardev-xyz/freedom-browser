const { createDocument, createElement, FakeElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalAlert = global.alert;
const originalHTMLElement = global.HTMLElement;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createWebview = (initialUrl = 'https://active.example', options = {}) => {
  const webview = createElement('webview');
  webview._currentUrl = initialUrl;
  webview.loadURL = jest.fn((url) => {
    webview._currentUrl = url;
  });
  webview.reload = jest.fn();
  webview.reloadIgnoringCache = jest.fn();
  webview.stop = jest.fn();
  webview.goBack = jest.fn();
  webview.goForward = jest.fn();
  webview.canGoBack = jest.fn(() => options.canGoBack ?? false);
  webview.canGoForward = jest.fn(() => options.canGoForward ?? false);
  webview.getURL = jest.fn(() => webview._currentUrl);
  webview.getWebContentsId = jest.fn(() => options.webContentsId ?? 7);
  return webview;
};

const createTab = (id, url, overrides = {}) => {
  const webview = overrides.webview || createWebview(url, { webContentsId: id + 10 });
  const navigationState = {
    currentPageUrl: url,
    pendingNavigationUrl: '',
    pendingTitleForUrl: '',
    hasNavigatedDuringCurrentLoad: false,
    isWebviewLoading: false,
    currentBzzBase: null,
    currentIpfsBase: null,
    currentRadBase: null,
    addressBarSnapshot: '',
    cachedWebContentsId: null,
    resolvingWebContentsId: null,
    ...overrides.navigationState,
  };

  return {
    id,
    title: overrides.title || `Tab ${id}`,
    url,
    isLoading: overrides.isLoading || false,
    favicon: overrides.favicon || null,
    webview,
    navigationState,
  };
};

const loadNavigationModule = async (options = {}) => {
  jest.resetModules();

  const homeUrl = 'file:///app/pages/home.html';
  const historyUrl = 'file:///app/pages/history.html';
  const errorUrlBase = 'file:///app/pages/error.html';
  const state = {
    bzzRoutePrefix: 'https://gateway.example/bzz/',
    ipfsRoutePrefix: 'https://gateway.example/ipfs/',
    ipnsRoutePrefix: 'https://gateway.example/ipns/',
    radicleApiPrefix: 'http://127.0.0.1:8780/api/v1/repos/',
    radicleBase: 'http://127.0.0.1:8780',
    enableRadicleIntegration: options.enableRadicleIntegration || false,
    currentRadicleStatus: options.currentRadicleStatus || 'running',
    knownEnsNames: new Map(),
    ensProtocols: new Map(),
    ensTrustByName: new Map(),
    ensUriByName: new Map(),
    blockUnverifiedEns: options.blockUnverifiedEns !== false,
  };
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const bookmarksUiMocks = {
    updateBookmarkButtonVisibility: jest.fn(),
    updateBookmarksBarForPage: jest.fn(),
    setBookmarksBarVisible: jest.fn(),
    isBookmarksBarVisible: jest.fn(() => true),
  };
  const githubBridgeUiMocks = {
    updateGithubBridgeIcon: jest.fn(),
  };
  const activeRef = {};
  const tabsRef = { list: [] };
  const tabsMocks = {
    webviewEventHandler: null,
    getActiveWebview: jest.fn(() => activeRef.tab?.webview || null),
    getActiveTab: jest.fn(() => activeRef.tab || null),
    getActiveTabState: jest.fn(() => activeRef.tab?.navigationState || null),
    setWebviewEventHandler: jest.fn((handler) => {
      tabsMocks.webviewEventHandler = handler;
    }),
    updateActiveTabTitle: jest.fn(),
    updateTabFavicon: jest.fn(),
    setTabLoading: jest.fn(),
    getTabs: jest.fn(() => tabsRef.list),
  };
  const navigationUtilsMocks = {
    applyEnsSuffix: jest.fn((targetUri, suffix = '') => `${targetUri}${suffix}`),
    buildRadicleDisabledUrl: jest.fn(() => 'file:///app/pages/rad-browser.html?error=disabled'),
    buildViewSourceNavigation: jest.fn(({ value }) => ({
      addressValue: `display:${value}`,
      loadUrl: `load:${value}`,
    })),
    deriveDisplayAddress: jest.fn(({ url }) => `display:${url}`),
    deriveSwitchedTabDisplay: jest.fn(
      ({ url, isLoading, addressBarSnapshot }) =>
        (isLoading && addressBarSnapshot) || (url ? `switched:${url}` : '')
    ),
    extractEnsResolutionMetadata: jest.fn(() => ({
      knownEnsPairs: [],
      resolvedProtocol: null,
    })),
    getBookmarkBarState: jest.fn(({ url, bookmarkBarOverride }) => {
      const isHomePage = !url || url === homeUrl;
      return {
        isHomePage,
        visible: isHomePage || bookmarkBarOverride,
      };
    }),
    getOriginalUrlFromErrorPage: jest.fn((url) => {
      if (!url.includes('error.html')) return null;
      try {
        return new URL(url).searchParams.get('url');
      } catch {
        return null;
      }
    }),
    getRadicleDisplayUrl: jest.fn((url) =>
      url.includes('rad-browser.html?rid=') ? 'rad://zrepo123' : null
    ),
    resolveProtocolIconType: jest.fn(({ value, currentPageSecure }) => {
      if (currentPageSecure) return 'https';
      if (value?.startsWith('bzz://')) return 'swarm';
      if (value?.startsWith('rad://') && state.enableRadicleIntegration) return 'radicle';
      return value ? 'http' : 'http';
    }),
    resolveTrustBadge: jest.fn(({ value, ensTrustByName }) => {
      // Mirror the production helper's shape. Tests that need specific
      // trust levels populate ensTrustByName; default is null.
      const m = value?.toLowerCase().match(/^(?:ens:\/\/)?([^/]+\.(?:eth|box))/);
      if (!m) return null;
      const name = m[1];
      const trust = ensTrustByName?.get?.(name);
      if (!trust?.level) return null;
      return { level: trust.level, name, trust };
    }),
  };
  const urlUtilsMocks = {
    formatBzzUrl: jest.fn((input, prefix) => {
      if (!input.startsWith('bzz://')) return null;
      const hashAndPath = input.slice(6);
      const hash = hashAndPath.split('/')[0];
      return {
        targetUrl: `${prefix}${hashAndPath}`,
        displayValue: input,
        baseUrl: `${prefix}${hash}/`,
      };
    }),
    formatIpfsUrl: jest.fn((input, prefix) => {
      if (!input.startsWith('ipfs://')) return null;
      return {
        targetUrl: `${prefix}${input.slice(7)}`,
        displayValue: input,
        baseUrl: `${prefix}${input.slice(7).split('/')[0]}/`,
      };
    }),
    formatRadicleUrl: jest.fn((input) => {
      if (!input.startsWith('rad://')) return null;
      return {
        targetUrl: 'file:///app/pages/rad-browser.html?rid=zrepo123',
        displayValue: input,
      };
    }),
    deriveDisplayValue: jest.fn((url) => `display:${url}`),
    deriveBzzBaseFromUrl: jest.fn((url) => (url.includes('/bzz/') ? 'https://gateway.example/bzz/hash/' : null)),
    deriveIpfsBaseFromUrl: jest.fn(() => null),
    deriveRadBaseFromUrl: jest.fn(() => null),
  };
  const pageUrlsMocks = {
    homeUrl,
    homeUrlNormalized: homeUrl,
    errorUrlBase,
    internalPages: {
      history: historyUrl,
      settings: 'file:///app/pages/settings.html',
    },
    detectProtocol: jest.fn(() => 'https'),
    isHistoryRecordable: jest.fn((displayUrl, internalUrl) => {
      return (
        Boolean(displayUrl) &&
        !displayUrl.startsWith('freedom://') &&
        !displayUrl.startsWith('view-source:') &&
        !internalUrl.includes('/error.html')
      );
    }),
    getInternalPageName: jest.fn((url) => (url === historyUrl ? 'history' : null)),
    parseEnsInput: jest.fn(() => null),
    buildInternalPageUrl: jest.fn((file, params = null) => {
      const base = `file:///app/pages/${file}`;
      if (!params) return base;
      const qs = new URLSearchParams(params).toString();
      return qs ? `${base}?${qs}` : base;
    }),
  };
  const settingsState = options.initialSettings || { showBookmarkBar: true };
  const electronHandlers = {};
  const electronAPI = {
    getSettings: jest.fn().mockResolvedValue({ ...settingsState }),
    saveSettings: jest.fn().mockResolvedValue(true),
    setBookmarkBarChecked: jest.fn(),
    setBookmarkBarToggleEnabled: jest.fn(),
    setWindowTitle: jest.fn(),
    fetchFaviconWithKey: jest.fn().mockResolvedValue('data:image/png;base64,favicon'),
    addHistory: jest.fn().mockResolvedValue(undefined),
    setBzzBase: jest.fn(),
    clearBzzBase: jest.fn(),
    setIpfsBase: jest.fn(),
    clearIpfsBase: jest.fn(),
    setRadBase: jest.fn(),
    clearRadBase: jest.fn(),
    onToggleBookmarkBar: jest.fn((handler) => {
      electronHandlers.toggleBookmarkBar = handler;
    }),
    resolveEns: jest.fn(),
  };

  const addressInput = createElement('input');
  const navForm = createElement('form');
  const backBtn = createElement('button');
  const forwardBtn = createElement('button');
  const reloadBtn = createElement('button');
  const homeBtn = createElement('button');
  const bookmarksBar = createElement('div', { classes: ['hidden'] });
  const protocolIcon = createElement('div');
  const trustShield = createElement('button');
  const trustPopover = createElement('div');
  const trustPopoverTitle = createElement('div');
  const trustPopoverSubtitle = createElement('div');
  const trustPopoverSummary = createElement('p');
  const trustPopoverBlock = createElement('div');
  const trustPopoverAgreed = createElement('div');
  const trustPopoverAgreedSection = createElement('div');
  const trustPopoverDissented = createElement('div');
  const trustPopoverDissentedSection = createElement('div');
  const document = createDocument({
    elementsById: {
      'address-input': addressInput,
      'nav-form': navForm,
      'back-btn': backBtn,
      'forward-btn': forwardBtn,
      'reload-btn': reloadBtn,
      'home-btn': homeBtn,
      'protocol-icon': protocolIcon,
      'trust-shield': trustShield,
      'trust-popover': trustPopover,
      'trust-popover-title': trustPopoverTitle,
      'trust-popover-subtitle': trustPopoverSubtitle,
      'trust-popover-summary': trustPopoverSummary,
      'trust-popover-block': trustPopoverBlock,
      'trust-popover-agreed': trustPopoverAgreed,
      'trust-popover-agreed-section': trustPopoverAgreedSection,
      'trust-popover-dissented': trustPopoverDissented,
      'trust-popover-dissented-section': trustPopoverDissentedSection,
    },
  });

  addressInput.focus = jest.fn();
  addressInput.blur = jest.fn();
  addressInput.select = jest.fn();
  protocolIcon.removeAttribute = jest.fn((name) => {
    delete protocolIcon.attributes[name];
  });
  document.querySelector = jest.fn((selector) => {
    if (selector === '.bookmarks') return bookmarksBar;
    return null;
  });
  document.activeElement = null;

  const windowHandlers = {};
  global.window = {
    electronAPI,
    location: {
      href: 'file:///app/index.html',
    },
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };
  global.document = document;
  global.alert = jest.fn();
  global.HTMLElement = FakeElement;

  const firstTab =
    options.firstTab ||
    createTab(1, 'https://active.example', {
      title: 'Active Tab',
      webview: createWebview('https://active.example', {
        canGoBack: true,
        canGoForward: true,
        webContentsId: 21,
      }),
    });
  tabsRef.list = options.tabs || [firstTab];
  activeRef.tab = options.activeTab || firstTab;

  jest.doMock('./state.js', () => ({ state }));
  jest.doMock('./debug.js', () => debugMocks);
  jest.doMock('./bookmarks-ui.js', () => bookmarksUiMocks);
  jest.doMock('./github-bridge-ui.js', () => githubBridgeUiMocks);
  jest.doMock('./tabs.js', () => tabsMocks);
  jest.doMock('./navigation-utils.js', () => navigationUtilsMocks);
  jest.doMock('./url-utils.js', () => urlUtilsMocks);
  jest.doMock('./page-urls.js', () => pageUrlsMocks);

  const mod = await import('./navigation.js');

  return {
    mod,
    state,
    debugMocks,
    bookmarksUiMocks,
    githubBridgeUiMocks,
    tabsMocks,
    navigationUtilsMocks,
    urlUtilsMocks,
    pageUrlsMocks,
    electronAPI,
    electronHandlers,
    activeRef,
    tabsRef,
    windowHandlers,
    elements: {
      addressInput,
      navForm,
      backBtn,
      forwardBtn,
      reloadBtn,
      homeBtn,
      bookmarksBar,
      protocolIcon,
      trustShield,
      trustPopover,
    },
  };
};

describe('navigation', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.alert = originalAlert;
    global.HTMLElement = originalHTMLElement;
    jest.restoreAllMocks();
  });

  test('initializes navigation controls and public entrypoints', async () => {
    const ctx = await loadNavigationModule({
      initialSettings: { showBookmarkBar: true },
    });

    await ctx.mod.initNavigation();
    await flushMicrotasks();

    expect(ctx.electronAPI.getSettings).toHaveBeenCalled();
    expect(ctx.electronAPI.setBookmarkBarChecked).toHaveBeenCalledWith(true);

    ctx.elements.addressInput.value = 'bzz://abcdef';
    ctx.elements.addressInput.dispatch('focus');
    ctx.elements.addressInput.dispatch('focusin');
    ctx.elements.addressInput.dispatch('input');

    expect(ctx.elements.addressInput.select).toHaveBeenCalled();
    expect(ctx.activeRef.tab.navigationState.addressBarSnapshot).toBe('bzz://abcdef');
    expect(ctx.navigationUtilsMocks.resolveProtocolIconType).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'bzz://abcdef',
      })
    );
    expect(ctx.elements.protocolIcon.getAttribute('data-protocol')).toBe('swarm');

    ctx.elements.backBtn.dispatch('click');
    ctx.elements.forwardBtn.dispatch('click');

    expect(ctx.activeRef.tab.webview.goBack).toHaveBeenCalled();
    expect(ctx.activeRef.tab.webview.goForward).toHaveBeenCalled();

    ctx.elements.homeBtn.dispatch('click');

    expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(ctx.pageUrlsMocks.homeUrl);
    expect(ctx.tabsMocks.updateActiveTabTitle).toHaveBeenCalledWith('New Tab');
    expect(ctx.electronAPI.setWindowTitle).toHaveBeenCalledWith('');
    expect(ctx.tabsMocks.updateTabFavicon).toHaveBeenCalledWith(ctx.activeRef.tab.id, null);

    await ctx.mod.toggleBookmarkBar();
    expect(ctx.electronAPI.setBookmarkBarChecked).toHaveBeenLastCalledWith(false);
    expect(ctx.electronAPI.saveSettings).toHaveBeenCalledWith({
      showBookmarkBar: false,
    });
  });

  test('handles reload retry, escape restore, keyboard shortcuts, and settings refresh', async () => {
    const ctx = await loadNavigationModule({
      initialSettings: { showBookmarkBar: false },
    });

    await ctx.mod.initNavigation();

    ctx.activeRef.tab.navigationState.isWebviewLoading = true;
    ctx.activeRef.tab.navigationState.currentPageUrl = 'https://current.example';
    ctx.activeRef.tab.navigationState.hasNavigatedDuringCurrentLoad = false;
    ctx.elements.addressInput.value = 'working';

    const addressEscapeEvent = {
      key: 'Escape',
      preventDefault: jest.fn(),
    };
    ctx.elements.addressInput.dispatch('keydown', addressEscapeEvent);

    expect(addressEscapeEvent.preventDefault).toHaveBeenCalled();
    expect(ctx.activeRef.tab.webview.stop).toHaveBeenCalled();
    expect(ctx.elements.addressInput.value).toBe('display:https://current.example');
    expect(ctx.elements.reloadBtn.dataset.state).toBe('reload');
    expect(ctx.elements.addressInput.blur).toHaveBeenCalled();

    const blurTarget = createElement('button');
    blurTarget.blur = jest.fn();
    global.document.activeElement = blurTarget;
    ctx.activeRef.tab.navigationState.isWebviewLoading = true;
    ctx.windowHandlers.keydown({
      key: 'Escape',
      preventDefault: jest.fn(),
    });
    expect(blurTarget.blur).toHaveBeenCalled();

    ctx.activeRef.tab.navigationState.isWebviewLoading = false;
    ctx.activeRef.tab.webview.getURL.mockReturnValue(
      'file:///app/pages/error.html?url=https%3A%2F%2Fretry.example'
    );
    ctx.elements.reloadBtn.dispatch('click', {
      shiftKey: false,
    });
    expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith('https://retry.example');

    ctx.activeRef.tab.webview.getURL.mockReturnValue('https://active.example');
    ctx.windowHandlers.keydown({
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      key: 'r',
      preventDefault: jest.fn(),
    });
    ctx.windowHandlers.keydown({
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      key: 'r',
      preventDefault: jest.fn(),
    });
    expect(ctx.activeRef.tab.webview.reload).toHaveBeenCalled();
    expect(ctx.activeRef.tab.webview.reloadIgnoringCache).toHaveBeenCalled();

    ctx.state.enableRadicleIntegration = false;
    ctx.elements.addressInput.value = 'rad://zrepo123';
    ctx.mod.onSettingsChanged();
    expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
      'file:///app/pages/rad-browser.html?error=disabled'
    );
  });

  test('processes webview lifecycle events and records history', async () => {
    const ctx = await loadNavigationModule();
    const onHistoryRecorded = jest.fn();

    ctx.mod.setOnHistoryRecorded(onHistoryRecorded);
    await ctx.mod.initNavigation();

    ctx.tabsMocks.webviewEventHandler('did-start-loading', { tabId: ctx.activeRef.tab.id });

    expect(ctx.tabsMocks.setTabLoading).toHaveBeenCalledWith(true);
    expect(ctx.elements.reloadBtn.dataset.state).toBe('stop');

    ctx.elements.addressInput.value = 'https://recorded.example';
    ctx.activeRef.tab.title = 'Recorded Title';

    ctx.tabsMocks.webviewEventHandler('did-stop-loading', {
      url: 'https://loaded.example',
    });
    await flushMicrotasks();

    expect(ctx.tabsMocks.setTabLoading).toHaveBeenLastCalledWith(false);
    expect(ctx.elements.reloadBtn.dataset.state).toBe('reload');
    expect(ctx.electronAPI.fetchFaviconWithKey).toHaveBeenCalledWith(
      'https://loaded.example',
      'https://recorded.example'
    );
    expect(ctx.tabsMocks.updateTabFavicon).toHaveBeenCalledWith(
      ctx.activeRef.tab.id,
      'https://recorded.example'
    );
    expect(ctx.electronAPI.addHistory).toHaveBeenCalledWith({
      url: 'https://recorded.example',
      title: 'Recorded Title',
      protocol: 'https',
    });
    expect(onHistoryRecorded).toHaveBeenCalled();

    ctx.tabsMocks.webviewEventHandler('did-fail-load', {
      event: {
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://bad.example',
      },
    });
    expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
      'file:///app/pages/error.html?error=ERR_NAME_NOT_RESOLVED&url=https%3A%2F%2Fbad.example'
    );

    ctx.tabsMocks.webviewEventHandler('certificate-error', {
      event: { error: 'CERT_INVALID' },
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Certificate error: CERT_INVALID');

    ctx.tabsMocks.webviewEventHandler('dom-ready', {});
    await flushMicrotasks();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Webview ready.');
  });

  test('restores tab state on tab switches and updates navigation display', async () => {
    const secondTab = createTab(2, 'https://second.example', {
      title: 'Second Tab',
      isLoading: true,
      navigationState: {
        addressBarSnapshot: 'typed second',
        currentBzzBase: 'https://gateway.example/bzz/hash/',
      },
      webview: createWebview('https://second.example', {
        webContentsId: 22,
      }),
    });
    const thirdTab = createTab(3, 'file:///app/pages/home.html', {
      title: 'Home Tab',
      webview: createWebview('file:///app/pages/home.html', {
        webContentsId: 23,
      }),
    });
    const ctx = await loadNavigationModule({
      tabs: [createTab(1, 'https://first.example'), secondTab, thirdTab],
      activeTab: createTab(1, 'https://first.example'),
    });

    ctx.tabsRef.list = [ctx.activeRef.tab, secondTab, thirdTab];
    await ctx.mod.initNavigation();

    ctx.elements.addressInput.value = 'saved snapshot';
    ctx.tabsMocks.webviewEventHandler('tab-switched', {
      tabId: ctx.activeRef.tab.id,
      tab: ctx.activeRef.tab,
      isNewTab: false,
    });
    ctx.elements.addressInput.value = 'saved snapshot';

    ctx.activeRef.tab = secondTab;
    ctx.tabsMocks.webviewEventHandler('tab-switched', {
      tabId: secondTab.id,
      tab: secondTab,
      isNewTab: false,
    });
    await flushMicrotasks();

    expect(ctx.tabsRef.list[0].navigationState.addressBarSnapshot).toBe('saved snapshot');
    expect(ctx.elements.addressInput.value).toBe('typed second');
    expect(ctx.tabsMocks.setTabLoading).toHaveBeenLastCalledWith(true);
    expect(ctx.elements.reloadBtn.dataset.state).toBe('stop');
    expect(ctx.tabsMocks.updateTabFavicon).toHaveBeenCalledWith(secondTab.id, 'typed second');

    ctx.navigationUtilsMocks.deriveSwitchedTabDisplay.mockReturnValueOnce('');
    ctx.activeRef.tab = thirdTab;
    ctx.tabsMocks.webviewEventHandler('tab-switched', {
      tabId: thirdTab.id,
      tab: thirdTab,
      isNewTab: true,
    });

    expect(ctx.elements.addressInput.focus).toHaveBeenCalled();
  });

  describe('ENS trust dispatch', () => {
    // setupEnsDispatch: bootstrap the navigation module with a realistic
    // parseEnsInput mock (mirrors the production regex; real helper is
    // unit-tested in page-urls.test.js), then run initNavigation so
    // setWebviewEventHandler is registered. All dispatch tests start here.
    const setupEnsDispatch = async (options = {}) => {
      const ctx = await loadNavigationModule(options);
      ctx.pageUrlsMocks.parseEnsInput.mockImplementation((value) => {
        const m = value.match(/^(?:ens:\/\/)?([^?/]+\.(?:eth|box))(.*)?$/i);
        return m ? { name: m[1].toLowerCase(), suffix: m[2] || '' } : null;
      });
      await ctx.mod.initNavigation();
      return ctx;
    };

    // Drive one ENS resolution through loadTarget. Returns the webview's
    // loadURL call history after the resolver promise settles so tests
    // can inspect which interstitial (if any) was chosen.
    const dispatchEns = async (ctx, url, result, options = {}) => {
      ctx.electronAPI.resolveEns.mockResolvedValue(result);
      ctx.mod.loadTarget(url, null, null, options);
      await flushMicrotasks();
      return ctx.activeRef.tab.webview.loadURL.mock.calls;
    };

    test('conflict result routes to ens-conflict interstitial', async () => {
      const ctx = await setupEnsDispatch();
      const conflictResult = {
        type: 'conflict',
        name: 'bad.eth',
        trust: { level: 'conflict', block: { number: 123, hash: '0xabc' } },
        groups: [
          { resolvedData: '0x111', urls: ['a'] },
          { resolvedData: '0x222', urls: ['b'] },
        ],
      };

      const loadCalls = await dispatchEns(ctx, 'ens://bad.eth', conflictResult);

      const interstitialCall = loadCalls.find(([u]) => u.includes('ens-conflict.html'));
      expect(interstitialCall).toBeDefined();
      const url = new URL(interstitialCall[0]);
      expect(url.searchParams.get('name')).toBe('bad.eth');
      const groups = JSON.parse(url.searchParams.get('groups'));
      expect(groups).toEqual(conflictResult.groups);
      expect(ctx.state.ensTrustByName.get('bad.eth')).toEqual(conflictResult.trust);
    });

    test('unverified result routes to ens-unverified interstitial when setting is on', async () => {
      const ctx = await setupEnsDispatch({ blockUnverifiedEns: true });
      const loadCalls = await dispatchEns(ctx, 'ens://lonely.eth', {
        type: 'ok',
        name: 'lonely.eth',
        protocol: 'ipfs',
        uri: 'ipfs://QmFake',
        trust: { level: 'unverified', queried: ['a'], agreed: ['a'] },
      });

      const interstitialCall = loadCalls.find(([u]) => u.includes('ens-unverified.html'));
      expect(interstitialCall).toBeDefined();
      const url = new URL(interstitialCall[0]);
      expect(url.searchParams.get('name')).toBe('lonely.eth');
      expect(url.searchParams.get('uri')).toContain('ipfs://QmFake');
    });

    test('unverified proceeds normally when blockUnverifiedEns is off', async () => {
      const ctx = await setupEnsDispatch({ blockUnverifiedEns: false });
      const loadCalls = await dispatchEns(ctx, 'ens://ok.eth', {
        type: 'ok',
        name: 'ok.eth',
        protocol: 'ipfs',
        uri: 'ipfs://QmOk',
        trust: { level: 'unverified', queried: ['a'], agreed: ['a'] },
      });

      expect(loadCalls.find(([u]) => u.includes('ens-unverified.html'))).toBeUndefined();
    });

    test('allowUnverifiedOnce option bypasses the unverified interstitial for one call', async () => {
      const ctx = await setupEnsDispatch({ blockUnverifiedEns: true });
      const loadCalls = await dispatchEns(
        ctx,
        'ens://once.eth',
        {
          type: 'ok',
          name: 'once.eth',
          protocol: 'ipfs',
          uri: 'ipfs://QmOnce',
          trust: { level: 'unverified', queried: ['a'], agreed: ['a'] },
        },
        { allowUnverifiedOnce: true }
      );

      expect(loadCalls.find(([u]) => u.includes('ens-unverified.html'))).toBeUndefined();
    });

    test('verified result proceeds normally and stores trust metadata', async () => {
      const ctx = await setupEnsDispatch();
      const verifiedTrust = { level: 'verified', queried: ['a', 'b', 'c'], agreed: ['a', 'b'] };

      const loadCalls = await dispatchEns(ctx, 'ens://vitalik.eth', {
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'ipfs',
        uri: 'ipfs://QmVitalik',
        trust: verifiedTrust,
      });

      expect(ctx.state.ensTrustByName.get('vitalik.eth')).toEqual(verifiedTrust);
      expect(loadCalls.find(([u]) => u.includes('ens-conflict.html'))).toBeUndefined();
      expect(loadCalls.find(([u]) => u.includes('ens-unverified.html'))).toBeUndefined();
    });

    test('ipc-message ens:continue-unverified re-dispatches with allow flag', async () => {
      const ctx = await setupEnsDispatch({ blockUnverifiedEns: true });
      const unverifiedResult = {
        type: 'ok',
        name: 'retry.eth',
        protocol: 'ipfs',
        uri: 'ipfs://QmRetry',
        trust: { level: 'unverified', queried: ['a'], agreed: ['a'] },
      };
      ctx.electronAPI.resolveEns.mockResolvedValue(unverifiedResult);

      // First load: blocked → interstitial.
      ctx.mod.loadTarget('ens://retry.eth');
      await flushMicrotasks();
      expect(
        ctx.activeRef.tab.webview.loadURL.mock.calls.find(([u]) => u.includes('ens-unverified.html'))
      ).toBeDefined();

      // Simulate interstitial "Continue once" sendToHost → tabs routes to
      // the ipc-message webview event. The handler should re-dispatch with
      // allowUnverifiedOnce=true, which bypasses the block and would call
      // resolveEns again (we verify the follow-up resolveEns call).
      ctx.electronAPI.resolveEns.mockClear();
      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'ens:continue-unverified',
        args: [{ name: 'retry.eth' }],
      });
      await flushMicrotasks();

      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('retry.eth');
    });

    test('ipc-message ens:open-settings navigates to freedom://settings', async () => {
      const ctx = await setupEnsDispatch();

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'ens:open-settings',
        args: [],
      });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'file:///app/pages/settings.html'
      );
    });
  });

  describe('trust shield', () => {
    test('shows verified badge with aria-label when stored trust is verified', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.state.ensTrustByName.set('vitalik.eth', {
        level: 'verified',
        queried: ['a', 'b'],
        agreed: ['a', 'b'],
      });
      ctx.elements.addressInput.value = 'ens://vitalik.eth';
      ctx.elements.addressInput.dispatch('input');

      expect(ctx.elements.trustShield.getAttribute('data-trust')).toBe('verified');
      expect(ctx.elements.trustShield.getAttribute('aria-label')).toContain('verified');
      expect(ctx.elements.trustShield.hidden).toBe(false);
    });

    test('hides for non-ENS URLs', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.elements.addressInput.value = 'https://example.com';
      ctx.elements.addressInput.dispatch('input');

      expect(ctx.elements.trustShield.hidden).toBe(true);
    });

    test('hides when ENS name has no stored trust', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.elements.addressInput.value = 'ens://unknown.eth';
      ctx.elements.addressInput.dispatch('input');

      expect(ctx.elements.trustShield.hidden).toBe(true);
    });
  });
});
