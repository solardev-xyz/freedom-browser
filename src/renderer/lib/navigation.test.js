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
  // Mirror production tabs.js: each webview carries its tab id so async
  // helpers (`getTabIdForWebview`) can route per-tab UI updates back to
  // the originating tab even after the active tab changes.
  webview.dataset = webview.dataset || {};
  webview.dataset.tabId = String(id);
  const navigationState = {
    currentPageUrl: url,
    pendingNavigationUrl: '',
    pendingTitleForUrl: '',
    hasNavigatedDuringCurrentLoad: false,
    isWebviewLoading: false,
    currentBzzBase: null,
    currentRadBase: null,
    addressBarSnapshot: '',
    committedDisplayUrl: '',
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
    currentIpfsStatus: options.currentIpfsStatus || 'running',
    registry: options.registry || { ipfs: { mode: 'bundled' } },
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
  const ipfsProgressMocks = {
    startIpfsProgressStatus: jest.fn(),
    stopIpfsProgressStatus: jest.fn(),
  };
  const activeRef = {};
  const tabsRef = { list: [] };
  const tabsMocks = {
    webviewEventHandler: null,
    createTab: jest.fn(),
    openInNewTabWithTarget: jest.fn(),
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
    getTabById: jest.fn((tabId) => {
      if (tabId === null || tabId === undefined) return null;
      return tabsRef.list.find((t) => t.id === tabId) || null;
    }),
    getTabIdForWebview: jest.fn((webview) => {
      if (!webview) return null;
      const raw = webview.dataset?.tabId;
      if (raw === undefined) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }),
    isActiveTab: jest.fn(
      (tabId) => tabId !== null && tabId !== undefined && tabId === activeRef.tab?.id
    ),
  };
  const navigationUtilsMocks = {
    applyEnsSuffix: jest.fn((targetUri, suffix = '') => `${targetUri}${suffix}`),
    buildRadicleDisabledUrl: jest.fn(() => 'file:///app/pages/rad-browser.html?error=disabled'),
    buildTrustRows: jest.fn(() => ({
      status: 'ENS resolution verified',
      trustRows: [],
      contentRows: [],
    })),
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
      const m = value
        ?.toLowerCase()
        .match(/^(?:(?:ens|bzz|ipfs|ipns):\/\/)?([^/?#]+\.(?:eth|box))/);
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
      // Both `ipfs://` and `ipns://` are 7-char schemes, so slice(7) is shared.
      if (!input.startsWith('ipfs://') && !input.startsWith('ipns://')) return null;
      return {
        targetUrl: `${prefix}${input.slice(7)}`,
        displayValue: input,
        baseUrl: `${prefix}${input.slice(7).split('/')[0]}/`,
      };
    }),
    looksLikeBzzInput: jest.fn((input) => {
      const raw = (input || '').trim();
      if (!raw) return false;
      if (/^bzz:/i.test(raw)) return true;
      return /^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/.test(raw.split('/')[0]);
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
    applyEnsNamePreservation: jest.fn((url) => url),
    buildEnsDisplayUri: jest.fn((protocol, name, suffix = '') => {
      if (!name) return null;
      if (protocol !== 'bzz' && protocol !== 'ipfs' && protocol !== 'ipns') return null;
      return `${protocol}://${name}${suffix || ''}`;
    }),
    isEnsBackedDisplay: jest.fn((value) => {
      if (!value || typeof value !== 'string') return false;
      const trimmed = value.trim();
      if (!trimmed) return false;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('ens://')) return true;
      const transportMatch = lower.match(/^(?:bzz|ipfs|ipns):\/\/([^/?#]+)/);
      const host = transportMatch ? transportMatch[1] : trimmed.split(/[/?#]/)[0].toLowerCase();
      return (
        host.endsWith('.eth') ||
        host.endsWith('.box') ||
        host.endsWith('.wei') ||
        host.endsWith('.gwei')
      );
    }),
    isSupportedEnsTransport: jest.fn(
      (protocol) => protocol === 'bzz' || protocol === 'ipfs' || protocol === 'ipns'
    ),
    SUPPORTED_ENS_TRANSPORTS: ['bzz', 'ipfs', 'ipns'],
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
  const swarmProbeState = {
    nextProbeId: 'probe-1',
    pendingAwaits: [],
    startCalls: [],
    awaitCalls: [],
    cancelCalls: [],
  };
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
    setRadBase: jest.fn(),
    clearRadBase: jest.fn(),
    startSwarmProbe: jest.fn((hash, path) => {
      const id = swarmProbeState.nextProbeId;
      swarmProbeState.startCalls.push({ id, hash, path });
      return Promise.resolve({ success: true, id });
    }),
    awaitSwarmProbe: jest.fn(
      (id) =>
        new Promise((resolve) => {
          swarmProbeState.awaitCalls.push(id);
          swarmProbeState.pendingAwaits.push({ id, resolve });
        })
    ),
    cancelSwarmProbe: jest.fn((id) => {
      swarmProbeState.cancelCalls.push(id);
      return Promise.resolve({ success: true, cancelled: true });
    }),
    onToggleBookmarkBar: jest.fn((handler) => {
      electronHandlers.toggleBookmarkBar = handler;
    }),
    resolveEns: jest.fn(),
    invalidateEnsContent: jest.fn().mockResolvedValue(true),
    resolveTezosDomain: jest.fn(),
    invalidateTezosDomain: jest.fn().mockResolvedValue(true),
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
  const trustPopoverStatus = createElement('div');
  const trustPopoverTrustFields = createElement('div');
  const trustPopoverContent = createElement('div');
  const trustPopoverContentFields = createElement('div');
  const trustPopoverTooltip = createElement('div');
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
      'trust-popover-status': trustPopoverStatus,
      'trust-popover-trust-fields': trustPopoverTrustFields,
      'trust-popover-content': trustPopoverContent,
      'trust-popover-content-fields': trustPopoverContentFields,
      'trust-popover-tooltip': trustPopoverTooltip,
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
  // navigation.js broadcasts CustomEvents ('navigation-completed',
  // 'active-tab-changed') for the dApp banner + permission indicator.
  document.dispatchEvent = jest.fn();

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
  jest.doMock('./ipfs-progress-status.js', () => ipfsProgressMocks);

  // Pin the shortcut matcher to Linux semantics (Ctrl-based combos) so the
  // keyboard-shortcut assertions below don't depend on the host platform.
  const shortcuts = await import('./shortcuts.js');
  shortcuts.configureShortcuts({ platform: 'linux', overrides: {} });

  const mod = await import('./navigation.js');

  return {
    mod,
    state,
    debugMocks,
    bookmarksUiMocks,
    githubBridgeUiMocks,
    ipfsProgressMocks,
    tabsMocks,
    navigationUtilsMocks,
    urlUtilsMocks,
    pageUrlsMocks,
    electronAPI,
    electronHandlers,
    activeRef,
    tabsRef,
    windowHandlers,
    swarmProbeState,
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
      trustPopoverContent,
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
    const ctx = await loadNavigationModule({
      initialSettings: { showBookmarkBar: true, showIpfsProgressStatus: true },
    });
    const onHistoryRecorded = jest.fn();

    ctx.mod.setOnHistoryRecorded(onHistoryRecorded);
    await ctx.mod.initNavigation();
    await flushMicrotasks();

    ctx.tabsMocks.webviewEventHandler('did-start-loading', {
      tabId: ctx.activeRef.tab.id,
      pendingNavigationUrl: 'ipfs://bafybeigdyrzt',
    });

    expect(ctx.tabsMocks.setTabLoading).toHaveBeenCalledWith(true);
    expect(ctx.ipfsProgressMocks.startIpfsProgressStatus).toHaveBeenCalled();
    expect(ctx.elements.reloadBtn.dataset.state).toBe('stop');

    ctx.elements.addressInput.value = 'https://recorded.example';
    ctx.activeRef.tab.title = 'Recorded Title';

    ctx.tabsMocks.webviewEventHandler('did-stop-loading', {
      url: 'https://loaded.example',
    });
    await flushMicrotasks();

    expect(ctx.tabsMocks.setTabLoading).toHaveBeenLastCalledWith(false);
    expect(ctx.ipfsProgressMocks.stopIpfsProgressStatus).toHaveBeenLastCalledWith({
      immediate: true,
    });
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
    expect(ctx.ipfsProgressMocks.stopIpfsProgressStatus).toHaveBeenLastCalledWith({
      immediate: true,
    });

    // Defensive twin of the per-tab gate in `tabs.js`: a sub-frame
    // failure (third-party iframe, ad-tech pixel, etc.) must NOT
    // replace the main page with `error.html`. Without this guard,
    // any WalletConnect / heavy-ad-tech site hijacks itself on top of
    // a successful main-frame load.
    ctx.activeRef.tab.webview.loadURL.mockClear();
    ctx.tabsMocks.webviewEventHandler('did-fail-load', {
      event: {
        errorCode: -310,
        errorDescription: 'ERR_BLOCKED_BY_RESPONSE',
        validatedURL: 'https://verify.walletconnect.com/attestation/abc',
        isMainFrame: false,
      },
    });
    expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();

    ctx.tabsMocks.webviewEventHandler('certificate-error', {
      event: { error: 'CERT_INVALID' },
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Certificate error: CERT_INVALID');

    ctx.tabsMocks.webviewEventHandler('dom-ready', {});
    await flushMicrotasks();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Webview ready.');
  });

  describe('address bar search fallback', () => {
    test('loads the default provider results page for non-URL input', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      await flushMicrotasks();

      ctx.mod.loadTarget('best pizza near me');

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'https://duckduckgo.com/?q=best%20pizza%20near%20me'
      );
    });

    test('respects the configured search provider', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      await flushMicrotasks();
      // A non-default provider — with the DuckDuckGo default this test would
      // pass even if state.searchProvider were ignored entirely.
      ctx.state.searchProvider = 'google';

      ctx.mod.loadTarget('weather');

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'https://www.google.com/search?q=weather'
      );
    });

    test('respects a configured custom search provider', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      await flushMicrotasks();
      ctx.state.searchProvider = 'custom:searx';
      ctx.state.customSearchProviders = [
        {
          id: 'searx',
          name: 'SearxNG',
          searchUrlTemplate: 'https://search.example/?query={searchTerms}',
        },
      ];

      ctx.mod.loadTarget('privacy news');

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'https://search.example/?query=privacy%20news'
      );
    });

    test('still ignores empty input', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      await flushMicrotasks();

      ctx.mod.loadTarget('   ');

      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
      expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith(
        'Ignoring empty input or invalid URL.'
      );
    });

    test('does not turn protocol input into a search', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      await flushMicrotasks();

      ctx.mod.loadTarget('ipfs://bafybeigdyrzt');

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith('ipfs://bafybeigdyrzt');
    });
  });

  describe('bzz navigation probe', () => {
    const VALID_HASH = 'a'.repeat(64);

    const settleAwait = (ctx, id, outcome) => {
      const entry = ctx.swarmProbeState.pendingAwaits.find((p) => p.id === id);
      if (!entry) throw new Error(`no pending await for ${id}`);
      entry.resolve({ success: true, outcome });
      ctx.swarmProbeState.pendingAwaits = ctx.swarmProbeState.pendingAwaits.filter(
        (p) => p !== entry
      );
    };

    test('loads gateway URL only after the probe succeeds', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`);
      await flushMicrotasks();

      // Tab spinner is active and stop state is set, but no gateway load yet.
      // The probe targets the captured tab by id so a tab switch during a
      // slow Bee warm-up doesn't redirect the spinner to a different tab.
      expect(ctx.tabsMocks.setTabLoading).toHaveBeenCalledWith(true, ctx.activeRef.tab.id);
      expect(ctx.elements.reloadBtn.dataset.state).toBe('stop');
      expect(ctx.electronAPI.startSwarmProbe).toHaveBeenCalledWith(VALID_HASH, '');
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
      expect(ctx.activeRef.tab.navigationState.pendingSwarmProbeId).toBe('probe-1');

      settleAwait(ctx, 'probe-1', { ok: true });
      await flushMicrotasks();

      // After a successful probe we hand off to the `bzz:` protocol handler
      // rather than the raw gateway URL — see README "Swarm Content Retrieval".
      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        `bzz://${VALID_HASH}/`
      );
      expect(ctx.activeRef.tab.navigationState.pendingSwarmProbeId).toBeNull();
    });

    test('probes the in-manifest path so index-less manifests deep-link (#172)', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}/index.html`);
      await flushMicrotasks();

      // The probe must HEAD the same resource the navigation will load. A
      // manifest without a root index document 404s on the bare hash even
      // when /index.html is retrievable, which strands the probe until its
      // overall timeout.
      expect(ctx.electronAPI.startSwarmProbe).toHaveBeenCalledWith(VALID_HASH, '/index.html');

      settleAwait(ctx, 'probe-1', { ok: true });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        `bzz://${VALID_HASH}/index.html`
      );
    });

    test('routes to ERR_CONNECTION_REFUSED error page when Bee is unreachable', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`);
      await flushMicrotasks();
      settleAwait(ctx, 'probe-1', { ok: false, reason: 'bee_unreachable' });
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('error=ERR_CONNECTION_REFUSED');
      // The error page's `url` param should carry the user-facing display
      // URL, not the internal Bee gateway URL — otherwise the address bar
      // ends up showing the raw bzz hash instead of what the user typed.
      expect(loadedUrl).toContain(encodeURIComponent(`bzz://${VALID_HASH}`));
      expect(loadedUrl).not.toContain(
        encodeURIComponent(`https://gateway.example/bzz/${VALID_HASH}`)
      );
    });

    test('error page url param shows the ENS name, not the gateway URL', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`, 'ens://swarm.eth');
      await flushMicrotasks();
      settleAwait(ctx, 'probe-1', { ok: false, reason: 'not_found' });
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('error=swarm_content_not_found');
      expect(loadedUrl).toContain(encodeURIComponent('ens://swarm.eth'));
      expect(loadedUrl).not.toContain(
        encodeURIComponent(`https://gateway.example/bzz/${VALID_HASH}`)
      );
    });

    test('routes to swarm_content_not_found error page on timeout', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`);
      await flushMicrotasks();
      settleAwait(ctx, 'probe-1', { ok: false, reason: 'not_found' });
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('error=swarm_content_not_found');
    });

    test('stop button cancels probe even if start IPC has not resolved yet', async () => {
      // Simulate the small window between calling startSwarmProbe and the
      // IPC resolving with a probeId. Stopping in that window must still
      // cancel the probe; otherwise it eventually navigates the webview
      // after the user told it to stop.
      const ctx = await loadNavigationModule();
      let resolveStart;
      ctx.electronAPI.startSwarmProbe.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStart = resolve;
          })
      );
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`);
      // Do NOT flush — startSwarmProbe is still pending, no probeId yet.
      expect(ctx.activeRef.tab.navigationState.pendingSwarmProbeId).toBeFalsy();

      // User clicks stop in the early window.
      ctx.elements.reloadBtn.dispatch('click');
      expect(ctx.activeRef.tab.webview.stop).toHaveBeenCalled();

      // The IPC eventually resolves with an id — the probe must be
      // retroactively cancelled, never awaited, and the webview untouched.
      resolveStart({ success: true, id: 'probe-late' });
      await flushMicrotasks();

      expect(ctx.electronAPI.cancelSwarmProbe).toHaveBeenCalledWith('probe-late');
      expect(ctx.electronAPI.awaitSwarmProbe).not.toHaveBeenCalled();
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
    });

    test('stop button cancels the pending probe', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`);
      await flushMicrotasks();
      expect(ctx.activeRef.tab.navigationState.pendingSwarmProbeId).toBe('probe-1');
      expect(ctx.activeRef.tab.navigationState.isWebviewLoading).toBe(true);

      ctx.elements.reloadBtn.dispatch('click');

      expect(ctx.electronAPI.cancelSwarmProbe).toHaveBeenCalledWith('probe-1');
      expect(ctx.activeRef.tab.navigationState.pendingSwarmProbeId).toBeNull();
      expect(ctx.activeRef.tab.webview.stop).toHaveBeenCalled();
      expect(ctx.elements.reloadBtn.dataset.state).toBe('reload');

      // A late probe resolution after cancel must be ignored — the id has
      // already been cleared, so the webview stays on its original URL.
      settleAwait(ctx, 'probe-1', { ok: true });
      await flushMicrotasks();
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalledWith(
        `bzz://${VALID_HASH}/`
      );
    });

    test('a second navigation cancels the first probe', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`);
      await flushMicrotasks();
      expect(ctx.activeRef.tab.navigationState.pendingSwarmProbeId).toBe('probe-1');

      ctx.swarmProbeState.nextProbeId = 'probe-2';
      const secondHash = 'b'.repeat(64);
      ctx.mod.loadTarget(`bzz://${secondHash}`);
      await flushMicrotasks();

      expect(ctx.electronAPI.cancelSwarmProbe).toHaveBeenCalledWith('probe-1');
      expect(ctx.activeRef.tab.navigationState.pendingSwarmProbeId).toBe('probe-2');

      // Settle the superseded first probe — result must be ignored.
      settleAwait(ctx, 'probe-1', { ok: true });
      await flushMicrotasks();
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalledWith(
        `bzz://${VALID_HASH}/`
      );

      // Settle the second probe with success — it should load the bzz:// URL.
      settleAwait(ctx, 'probe-2', { ok: true });
      await flushMicrotasks();
      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        `bzz://${secondHash}/`
      );
    });

    test('aborted outcome leaves the webview alone', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`);
      await flushMicrotasks();
      settleAwait(ctx, 'probe-1', { ok: false, reason: 'aborted' });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
    });
  });

  describe('disabled / not-running node error pages', () => {
    const VALID_HASH = 'a'.repeat(64);

    test('Swarm: shows the friendly error page instead of failing silently when the node is unavailable', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      // Disabled/stopped Ant node nulls the route prefix (see service-registry
      // → state.bzzRoutePrefix). Previously this made formatBzzUrl return null
      // and the navigation fell through to "Ignoring empty input" — silently.
      ctx.state.bzzRoutePrefix = null;

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`);
      await flushMicrotasks();

      // No probe should be started (the node can't be probed), and the webview
      // should land on error.html with the Swarm-specific params.
      expect(ctx.electronAPI.startSwarmProbe).not.toHaveBeenCalled();
      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('error=ERR_CONNECTION_REFUSED');
      expect(loadedUrl).toContain('protocol=swarm');
      expect(loadedUrl).toContain(encodeURIComponent(`bzz://${VALID_HASH}`));
    });

    test('Swarm: bare hash input is still routed to the error page when disabled', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      ctx.state.bzzRoutePrefix = null;

      ctx.mod.loadTarget(VALID_HASH);
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=swarm');
      // Retry must be a loadable scheme URL, not the bare hash.
      expect(loadedUrl).toContain(encodeURIComponent(`bzz://${VALID_HASH}`));
    });

    test('Swarm: ENS-backed retry preserves the ENS host, not the resolved hash', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      ctx.state.bzzRoutePrefix = null;

      // Mirrors the ENS resolution recursion: value is the resolved hash form,
      // while displayOverride / options.bzzLoadUrl carry the ENS-named URL. The
      // disabled path must keep the ENS host on the error/retry URL, matching
      // the probe path (startBzzNavigationWithProbe).
      ctx.mod.loadTarget(`bzz://${VALID_HASH}`, 'bzz://vitalik.eth', null, {
        bzzLoadUrl: 'bzz://vitalik.eth',
      });
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=swarm');
      expect(loadedUrl).toContain(`retry=${encodeURIComponent('bzz://vitalik.eth')}`);
      expect(loadedUrl).not.toContain(encodeURIComponent(`bzz://${VALID_HASH}`));
    });

    test('IPFS: shows the friendly error page instead of raw JSON when the node is disabled', async () => {
      const ctx = await loadNavigationModule({ registry: { ipfs: { mode: 'disabled' } } });
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget('ipfs://QmTest');
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('error=ERR_CONNECTION_REFUSED');
      expect(loadedUrl).toContain('protocol=ipfs');
      expect(loadedUrl).toContain(encodeURIComponent('ipfs://QmTest'));
    });

    test('IPNS: error page carries protocol=ipns', async () => {
      const ctx = await loadNavigationModule({ registry: { ipfs: { mode: 'disabled' } } });
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget('ipns://k51qtest');
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=ipns');
      expect(loadedUrl).toContain(encodeURIComponent('ipns://k51qtest'));
    });

    test('IPFS: ENS-backed retry preserves the ENS host, not the resolved CID', async () => {
      const ctx = await loadNavigationModule({ registry: { ipfs: { mode: 'disabled' } } });
      await ctx.mod.initNavigation();

      // Mirrors the ENS resolution path: value is the resolved CID form, while
      // options.ipfsLoadUrl carries the user-facing ENS-named URL.
      ctx.mod.loadTarget('ipfs://QmResolvedCid', null, null, {
        ipfsLoadUrl: 'ipfs://vitalik.eth',
      });
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain(encodeURIComponent('ipfs://vitalik.eth'));
      expect(loadedUrl).not.toContain(encodeURIComponent('ipfs://QmResolvedCid'));
    });

    test('IPFS: shows the error page when the node is stopped', async () => {
      const ctx = await loadNavigationModule({ currentIpfsStatus: 'stopped' });
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget('ipfs://QmTest');
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=ipfs');
    });

    test('IPFS: background-tab error page leaves the foreground address bar alone', async () => {
      const tabA = createTab(1, 'https://a.example', { title: 'Tab A' });
      const tabB = createTab(2, 'about:blank', { title: 'Tab B' });
      const ctx = await loadNavigationModule({
        firstTab: tabA,
        tabs: [tabA, tabB],
        activeTab: tabB,
        registry: { ipfs: { mode: 'disabled' } },
      });
      ctx.tabsRef.list = [tabA, tabB];
      ctx.activeRef.tab = tabB;
      await ctx.mod.initNavigation();
      ctx.elements.addressInput.value = 'about:blank';

      // A background ENS/dweb navigation targets Tab A while Tab B is foreground.
      ctx.mod.loadTarget('ipfs://QmBackground', null, tabA.webview);
      await flushMicrotasks();

      // Error page loads in Tab A's webview, not the active tab's.
      const loadedUrl = tabA.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=ipfs');
      // Foreground (Tab B) address bar is untouched...
      expect(ctx.elements.addressInput.value).toBe('about:blank');
      // ...and Tab A's snapshot carries the resolved display for switchback.
      expect(tabA.navigationState.addressBarSnapshot).toBe('ipfs://QmBackground');
    });

    test('Swarm: background-tab error page leaves the foreground address bar alone', async () => {
      const tabA = createTab(1, 'https://a.example', { title: 'Tab A' });
      const tabB = createTab(2, 'about:blank', { title: 'Tab B' });
      const ctx = await loadNavigationModule({
        firstTab: tabA,
        tabs: [tabA, tabB],
        activeTab: tabB,
      });
      ctx.tabsRef.list = [tabA, tabB];
      ctx.activeRef.tab = tabB;
      await ctx.mod.initNavigation();
      ctx.state.bzzRoutePrefix = null;
      ctx.elements.addressInput.value = 'about:blank';

      ctx.mod.loadTarget(`bzz://${VALID_HASH}`, null, tabA.webview);
      await flushMicrotasks();

      const loadedUrl = tabA.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=swarm');
      expect(ctx.elements.addressInput.value).toBe('about:blank');
      expect(tabA.navigationState.addressBarSnapshot).toBe(`bzz://${VALID_HASH}`);
    });

    test('IPFS: honors a just-flipped-off Nodes-menu toggle before the status catches up', async () => {
      // Reproduces navigating immediately after switching the node off: the
      // toggle sets ipfsDesiredRunning=false synchronously, but currentIpfsStatus
      // still reads 'running' until the async stop lands. The guard must honor
      // the pending intent so the friendly page shows instead of the raw 503.
      const ctx = await loadNavigationModule({ currentIpfsStatus: 'running' });
      await ctx.mod.initNavigation();
      ctx.state.ipfsDesiredRunning = false;

      ctx.mod.loadTarget('ipfs://QmStillRunning');
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=ipfs');
    });

    test('IPFS: a running node navigates normally (no error page)', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget('ipfs://QmTest');
      await flushMicrotasks();

      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toBe('ipfs://QmTest');
      expect(loadedUrl).not.toContain('error.html');
    });
  });

  test('starts IPFS progress polling only for IPFS/IPNS navigations', async () => {
    const ctx = await loadNavigationModule({
      initialSettings: { showBookmarkBar: true, showIpfsProgressStatus: true },
    });
    await ctx.mod.initNavigation();
    await flushMicrotasks();

    ctx.tabsMocks.webviewEventHandler('did-start-loading', {
      tabId: ctx.activeRef.tab.id,
      pendingNavigationUrl: 'https://example.com',
      url: 'https://example.com',
    });

    expect(ctx.ipfsProgressMocks.startIpfsProgressStatus).not.toHaveBeenCalled();
    expect(ctx.ipfsProgressMocks.stopIpfsProgressStatus).toHaveBeenCalledWith({
      immediate: true,
    });

    ctx.ipfsProgressMocks.stopIpfsProgressStatus.mockClear();
    ctx.tabsMocks.webviewEventHandler('did-start-loading', {
      tabId: ctx.activeRef.tab.id,
      pendingNavigationUrl: 'ipns://docs.ipfs.tech',
    });

    expect(ctx.ipfsProgressMocks.startIpfsProgressStatus).toHaveBeenCalled();
    expect(ctx.ipfsProgressMocks.stopIpfsProgressStatus).not.toHaveBeenCalled();
  });

  test('IPFS progress polling stays gated behind the experimental flag', async () => {
    const ctx = await loadNavigationModule({
      initialSettings: { showBookmarkBar: true, showIpfsProgressStatus: false },
    });
    await ctx.mod.initNavigation();
    await flushMicrotasks();

    // Flag off (default): an ipfs:// load must not start the progress poller.
    ctx.tabsMocks.webviewEventHandler('did-start-loading', {
      tabId: ctx.activeRef.tab.id,
      pendingNavigationUrl: 'ipfs://bafybeigdyrzt',
    });
    expect(ctx.ipfsProgressMocks.startIpfsProgressStatus).not.toHaveBeenCalled();

    // Enabling it live (settings:updated broadcast) lets the next load start it.
    ctx.windowHandlers['settings:updated']({ detail: { showIpfsProgressStatus: true } });
    ctx.tabsMocks.webviewEventHandler('did-start-loading', {
      tabId: ctx.activeRef.tab.id,
      pendingNavigationUrl: 'ipfs://bafybeigdyrzt',
    });
    expect(ctx.ipfsProgressMocks.startIpfsProgressStatus).toHaveBeenCalled();

    // Disabling it live stops any running poller immediately.
    ctx.ipfsProgressMocks.stopIpfsProgressStatus.mockClear();
    ctx.windowHandlers['settings:updated']({ detail: { showIpfsProgressStatus: false } });
    expect(ctx.ipfsProgressMocks.stopIpfsProgressStatus).toHaveBeenCalledWith({
      immediate: true,
    });
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
      // Mirrors the real parseEnsInput in page-urls.js: accepts bare names,
      // legacy ens://, and the transport-prefixed forms (bzz://, ipfs://,
      // ipns://) when the host is a supported Ethereum name. Hash/CID hosts return
      // null so the caller falls through to direct content navigation.
      ctx.pageUrlsMocks.parseEnsInput.mockImplementation((value) => {
        const prefixMatch = value.match(/^(ens|bzz|ipfs|ipns):\/\//i);
        const assertedTransport = prefixMatch
          ? prefixMatch[1].toLowerCase() === 'ens'
            ? null
            : prefixMatch[1].toLowerCase()
          : null;
        const m = value.match(/^(?:(?:ens|bzz|ipfs|ipns):\/\/)?([^?/]+)(.*)?$/i);
        if (!m) return null;
        const host = m[1].toLowerCase();
        if (host.endsWith('.tez')) {
          if (prefixMatch?.[1]?.toLowerCase() === 'ens') return null;
          return { name: host, suffix: m[2] || '', assertedTransport, system: 'tezos' };
        }
        if (
          !host.endsWith('.eth') &&
          !host.endsWith('.box') &&
          !host.endsWith('.wei') &&
          !host.endsWith('.gwei')
        ) {
          return null;
        }
        return { name: host, suffix: m[2] || '', assertedTransport };
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

    test('native .tez resolution keeps the name origin for IPFS content', async () => {
      const ctx = await setupEnsDispatch();
      ctx.electronAPI.resolveTezosDomain.mockResolvedValue({
        type: 'ok',
        system: 'tezos',
        protocol: 'ipfs',
        decoded: 'QmTezosSite',
        uri: 'ipfs://QmTezosSite/published',
        basePath: '/published',
        trust: { level: 'verified', system: 'tezos', agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('docs.example.tez/guide');
      await flushMicrotasks();

      expect(ctx.electronAPI.resolveTezosDomain).toHaveBeenCalledWith('docs.example.tez');
      expect(ctx.electronAPI.resolveEns).not.toHaveBeenCalled();
      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'ipfs://docs.example.tez/guide'
      );
      expect(ctx.elements.addressInput.value).toBe('ipfs://docs.example.tez/guide');
    });

    test('a self-referential .tez website record cannot loop resolve→navigate forever', async () => {
      // A domain owner controls the website record: publishing
      // `ipns://loop.tez` used to make loadTarget re-resolve the same name
      // on every hop, spinning IPC until the tab was closed.
      const ctx = await setupEnsDispatch();
      ctx.electronAPI.resolveTezosDomain.mockResolvedValue({
        type: 'ok',
        system: 'tezos',
        protocol: 'ipns',
        decoded: 'loop.tez',
        uri: 'ipns://loop.tez',
        trust: { level: 'verified', system: 'tezos', agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('loop.tez');
      for (let i = 0; i < 20; i += 1) await flushMicrotasks();

      expect(ctx.electronAPI.resolveTezosDomain.mock.calls.length).toBeLessThanOrEqual(3);
      expect(global.alert).toHaveBeenCalledWith(expect.stringContaining('resolves in a loop'));
    });

    test('Tezos redirect_url takes precedence and ignores the address-bar suffix', async () => {
      const ctx = await setupEnsDispatch();
      ctx.electronAPI.resolveTezosDomain.mockResolvedValue({
        type: 'ok',
        system: 'tezos',
        protocol: 'https',
        uri: 'https://example.com/landing',
        redirect: true,
        trust: { level: 'verified', system: 'tezos', agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('docs.example.tez/ignored');
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'https://example.com/landing'
      );
    });

    test('Tezos HTTP content appends the requested path to its published base path', async () => {
      const ctx = await setupEnsDispatch();
      ctx.electronAPI.resolveTezosDomain.mockResolvedValue({
        type: 'ok',
        system: 'tezos',
        protocol: 'https',
        uri: 'https://example.com/published/site',
        redirect: false,
        trust: { level: 'verified', system: 'tezos', agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('docs.example.tez/guide?q=1#intro');
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'https://example.com/published/site/guide?q=1#intro'
      );
    });

    test('Tezos HTTP content keeps the published query when the suffix has none', async () => {
      const ctx = await setupEnsDispatch();
      ctx.electronAPI.resolveTezosDomain.mockResolvedValue({
        type: 'ok',
        system: 'tezos',
        protocol: 'https',
        uri: 'https://example.com/page?v=2',
        redirect: false,
        trust: { level: 'verified', system: 'tezos', agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('docs.example.tez/guide');
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'https://example.com/page/guide?v=2'
      );
    });

    test('protocol icon and address bar update immediately when an ENS-Swarm name is dispatched, before resolution completes', async () => {
      // Regression on two fronts:
      //   1. The swarm logo used to only appear after the page finished
      //      loading because the bzz/ipfs branches never refreshed the
      //      protocol icon.
      //   2. The address bar stayed on the previous page's URL (same-tab
      //      clicks) or empty (new tabs whose tab.url collapsed to
      //      homeUrl) for the entire ENS resolution roundtrip — which
      //      reads as the browser stalling.
      // The ENS branch now refreshes both up front so the user sees the
      // intended target even while resolveEns is in flight.
      const ctx = await setupEnsDispatch();

      // resolveEns intentionally never settles in this test.
      ctx.electronAPI.resolveEns.mockReturnValue(new Promise(() => {}));

      ctx.mod.loadTarget('bzz://meinhard.eth');
      await flushMicrotasks();

      // Address bar reflects the in-flight target instead of staying on
      // whatever was there before.
      expect(ctx.elements.addressInput.value).toBe('bzz://meinhard.eth');

      // Icon was updated even though resolveEns is still pending.
      expect(ctx.navigationUtilsMocks.resolveProtocolIconType).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'bzz://meinhard.eth' })
      );
      expect(ctx.elements.protocolIcon.getAttribute('data-protocol')).toBe('swarm');
    });

    test('ENS resolution that settles after a tab switch updates the original tab spinner, not the active tab', async () => {
      // Regression: pre-fix, `setLoading(false)` defaulted to the active
      // tab. If the user clicked an ENS link in Tab A and then switched
      // to Tab B before the resolveEns IPC settled, Tab B's spinner would
      // be cleared while Tab A's stayed on. After the fix, async
      // callbacks must target the captured tab via its id.
      const HASH = 'c'.repeat(64);
      const tabA = createTab(1, 'https://a.example');
      const tabB = createTab(2, 'https://b.example');
      const ctx = await setupEnsDispatch({
        firstTab: tabA,
        tabs: [tabA, tabB],
        activeTab: tabA,
      });

      // Stash a deferred resolveEns so we can observe state mid-flight.
      let resolveResolver;
      ctx.electronAPI.resolveEns.mockReturnValue(
        new Promise((resolve) => {
          resolveResolver = resolve;
        })
      );

      // Kick off ENS resolution targeting Tab A.
      ctx.mod.loadTarget('bzz://meinhard.eth', null, tabA.webview);
      await flushMicrotasks();

      // Spinner went on for Tab A, by id.
      expect(ctx.tabsMocks.setTabLoading).toHaveBeenCalledWith(true, tabA.id);

      // Simulate the user switching to Tab B mid-resolution.
      ctx.activeRef.tab = tabB;
      ctx.tabsMocks.setTabLoading.mockClear();

      resolveResolver({
        type: 'ok',
        name: 'meinhard.eth',
        protocol: 'bzz',
        decoded: HASH,
        uri: `bzz://${HASH}`,
        trust: { level: 'verified', queried: ['a', 'b'], agreed: ['a', 'b'] },
      });
      await flushMicrotasks();

      // Spinner update from the .then handler must target Tab A by id —
      // never Tab B (the active tab) and never the active-tab default.
      const [[firstArg, secondArg]] = ctx.tabsMocks.setTabLoading.mock.calls;
      expect(firstArg).toBe(false);
      expect(secondArg).toBe(tabA.id);
      expect(ctx.tabsMocks.setTabLoading).not.toHaveBeenCalledWith(false, tabB.id);
      expect(ctx.tabsMocks.setTabLoading).not.toHaveBeenCalledWith(false, null);
    });

    test('ENS resolution that settles after a tab switch does not clobber the active tab address bar', async () => {
      // Regression: pre-fix, the recursive loadTarget call from a settled
      // ENS resolution wrote `addressInput.value` and refreshed the
      // protocol icon globally — so if the user clicked an ENS link in
      // Tab A and then switched to Tab B mid-flight, the resolved URL
      // (e.g. `ipfs://vitalik.eth`) would appear in Tab B's address bar
      // once Tab A's resolution finished. After the fix, the resolved
      // display is stashed on the originating tab's navigationState so
      // tab-switched picks it up when the user switches back.
      const tabA = createTab(1, 'https://a.example');
      const tabB = createTab(2, 'about:blank');
      const ctx = await setupEnsDispatch({
        firstTab: tabA,
        tabs: [tabA, tabB],
        activeTab: tabA,
      });

      let resolveResolver;
      ctx.electronAPI.resolveEns.mockReturnValue(
        new Promise((resolve) => {
          resolveResolver = resolve;
        })
      );

      ctx.mod.loadTarget('vitalik.eth', null, tabA.webview);
      await flushMicrotasks();

      // Tab A's bar shows the in-flight name (this is the active tab now).
      expect(ctx.elements.addressInput.value).toBe('vitalik.eth');

      // Simulate user switching to Tab B and Tab B's address bar showing
      // its own URL.
      ctx.activeRef.tab = tabB;
      ctx.elements.addressInput.value = 'about:blank';

      resolveResolver({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'ipfs',
        uri: 'ipfs://QmVitalik',
        trust: { level: 'verified', queried: ['a', 'b'], agreed: ['a', 'b'] },
      });
      await flushMicrotasks();

      // Tab B's address bar must not have been clobbered.
      expect(ctx.elements.addressInput.value).toBe('about:blank');

      // Tab A's per-tab snapshot now holds the resolved display value, so
      // the tab-switched handler shows the right thing on switchback.
      expect(tabA.navigationState.addressBarSnapshot).toBe('ipfs://vitalik.eth');
    });

    test('ENS resolution failure on a backgrounded tab does not pop an alert on the active tab', async () => {
      // Modal alerts on top of unrelated content read as random
      // interruptions to whatever the user is doing, so failure paths
      // must check that the originating tab is still in the foreground
      // before surfacing the dialog. The pushDebug trail is unaffected.
      const tabA = createTab(1, 'https://a.example');
      const tabB = createTab(2, 'https://b.example');
      const ctx = await setupEnsDispatch({
        firstTab: tabA,
        tabs: [tabA, tabB],
        activeTab: tabA,
      });

      let resolveResolver;
      ctx.electronAPI.resolveEns.mockReturnValue(
        new Promise((resolve) => {
          resolveResolver = resolve;
        })
      );

      ctx.mod.loadTarget('vitalik.eth', null, tabA.webview);
      await flushMicrotasks();

      ctx.activeRef.tab = tabB;
      global.alert.mockClear();

      resolveResolver({ type: 'fail', reason: 'rpc unreachable' });
      await flushMicrotasks();

      expect(global.alert).not.toHaveBeenCalled();
    });

    test('legacy ens:// dispatch shows the input in the address bar during resolution', async () => {
      // For `ens://vitalik.eth` clicks and bookmarks, the address bar
      // should show the URL immediately rather than staying blank for the
      // duration of the resolveEns IPC roundtrip.
      const ctx = await setupEnsDispatch();
      ctx.electronAPI.resolveEns.mockReturnValue(new Promise(() => {}));

      ctx.mod.loadTarget('ens://vitalik.eth');
      await flushMicrotasks();

      expect(ctx.elements.addressInput.value).toBe('ens://vitalik.eth');
    });

    test('IPFS-backed ENS name shows the ipfs icon after resolution settles', async () => {
      // Regression: pre-fix, after resolution the address bar held
      // `ipfs://vitalik.eth` but resolveProtocolIconType's broken
      // extractEnsName turned that into a bogus key and never fell through
      // to the ipfs:// branch, so the icon stayed http.
      const ctx = await setupEnsDispatch();

      // Mirror the production helper's transport-first ordering (the real
      // implementation lives in navigation-utils.js and is unit-tested
      // separately).
      ctx.navigationUtilsMocks.resolveProtocolIconType.mockImplementation(({ value }) => {
        if (value?.startsWith('bzz://')) return 'swarm';
        if (value?.startsWith('ipfs://')) return 'ipfs';
        if (value?.startsWith('ipns://')) return 'ipns';
        return 'http';
      });

      ctx.elements.addressInput.value = 'vitalik.eth';
      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'ipfs',
        decoded: 'QmFake',
        uri: 'ipfs://QmFake',
        trust: { level: 'verified', queried: ['a', 'b'], agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('vitalik.eth');
      await flushMicrotasks();

      expect(ctx.elements.addressInput.value).toBe('ipfs://vitalik.eth');
      expect(ctx.elements.protocolIcon.getAttribute('data-protocol')).toBe('ipfs');
    });

    test('ENS-Swarm name loads bzz://name.eth/ (not the resolved hash) so DevTools shows the ENS name', async () => {
      // Regression for the DevTools/origin issue: pre-fix, the renderer
      // resolved ENS and then loaded `bzz://<hash>/`, so Chromium's URL
      // (and therefore DevTools, window.location, storage origin) was the
      // hash. Post-fix, we keep the ENS name in the loaded URL and let
      // the bzz protocol handler resolve at request time.
      const HASH = 'b'.repeat(64);
      const ctx = await setupEnsDispatch();

      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'meinhard.eth',
        protocol: 'bzz',
        decoded: HASH,
        uri: `bzz://${HASH}`,
        trust: { level: 'verified', queried: ['a', 'b'], agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('bzz://meinhard.eth');
      await flushMicrotasks();

      // Probe gates on the resolved hash so the cold-Bee retry budget is
      // applied to actual content, even though Chromium's URL is the ENS
      // name.
      expect(ctx.electronAPI.startSwarmProbe).toHaveBeenCalledWith(HASH, '');

      // Settle the probe successfully and confirm the URL handed to
      // webview.loadURL is the ENS form, not the gateway URL or hash form.
      const probeId = ctx.swarmProbeState.startCalls.at(-1)?.id || 'probe-1';
      const entry = ctx.swarmProbeState.pendingAwaits.find((p) => p.id === probeId);
      entry.resolve({ success: true, outcome: { ok: true } });
      ctx.swarmProbeState.pendingAwaits = ctx.swarmProbeState.pendingAwaits.filter(
        (p) => p !== entry
      );
      await flushMicrotasks();

      const loadedUrls = ctx.activeRef.tab.webview.loadURL.mock.calls.map(([u]) => u);
      expect(loadedUrls).toContain('bzz://meinhard.eth');
      expect(loadedUrls.some((u) => u === `bzz://${HASH}/` || u === `bzz://${HASH}`)).toBe(false);
      expect(loadedUrls.some((u) => u.includes('gateway.example'))).toBe(false);
    });

    test('cross-transport assertion: bzz://name.eth where the contenthash is IPFS errors instead of switching transports', async () => {
      // A typed transport scheme is an assertion. If the user typed
      // `bzz://vitalik.eth/` and vitalik.eth's contenthash is IPFS, we
      // surface the mismatch rather than silently transporting via IPFS
      // — that mirrors what the bzz protocol handler does for
      // subresource fetches (404 with explanatory body).
      const ctx = await setupEnsDispatch();

      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'ipfs',
        decoded: 'QmFakeCid',
        uri: 'ipfs://QmFakeCid',
        trust: { level: 'verified', queried: ['a', 'b'], agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('bzz://vitalik.eth');
      await flushMicrotasks();

      expect(global.alert).toHaveBeenCalledWith(
        expect.stringMatching(/resolves to ipfs, not bzz/)
      );
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
      expect(ctx.electronAPI.startSwarmProbe).not.toHaveBeenCalled();
    });

    test('bare ENS name without an asserted scheme accepts any transport (no mismatch error)', async () => {
      // Same setup as the previous test, but the user typed `vitalik.eth`
      // (no scheme) — that makes no transport assertion, so the renderer
      // should happily load it as IPFS.
      const ctx = await setupEnsDispatch();

      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'ipfs',
        decoded: 'QmFakeCid',
        uri: 'ipfs://QmFakeCid',
        trust: { level: 'verified', queried: ['a', 'b'], agreed: ['a', 'b'] },
      });

      ctx.mod.loadTarget('vitalik.eth');
      await flushMicrotasks();

      expect(global.alert).not.toHaveBeenCalledWith(
        expect.stringMatching(/resolves to ipfs, not/)
      );
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

    test('ipc-message ens:continue-unverified re-dispatches a .tez name without the ens:// prefix', async () => {
      // `ens://<name>.tez` is rejected by parseEnsInput, so prefixing the
      // name would make "Continue once" a silent no-op for Tezos names.
      const ctx = await setupEnsDispatch({ blockUnverifiedEns: true });
      ctx.electronAPI.resolveTezosDomain.mockResolvedValue({
        type: 'ok',
        system: 'tezos',
        protocol: 'ipfs',
        decoded: 'QmRetryTez',
        uri: 'ipfs://QmRetryTez',
        trust: { level: 'unverified', system: 'tezos', agreed: ['a'] },
      });

      ctx.mod.loadTarget('retry.tez');
      await flushMicrotasks();
      expect(
        ctx.activeRef.tab.webview.loadURL.mock.calls.find(([u]) => u.includes('ens-unverified.html'))
      ).toBeDefined();

      ctx.electronAPI.resolveTezosDomain.mockClear();
      ctx.activeRef.tab.webview.loadURL.mockClear();
      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'ens:continue-unverified',
        args: [{ name: 'retry.tez' }],
      });
      await flushMicrotasks();

      expect(ctx.electronAPI.resolveTezosDomain).toHaveBeenCalledWith('retry.tez');
      expect(ctx.electronAPI.resolveEns).not.toHaveBeenCalledWith('retry.tez');
      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith('ipfs://retry.tez');
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

    test('ipc-message link:navigate routes raw mixed-case ipfs href through loadTarget', async () => {
      const ctx = await setupEnsDispatch();
      const rawHref = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'link:navigate',
        args: [{ url: rawHref, disposition: 'currentTab' }],
      });
      await flushMicrotasks();

      expect(ctx.urlUtilsMocks.formatIpfsUrl).toHaveBeenCalledWith(
        rawHref,
        ctx.state.ipfsRoutePrefix
      );
      expect(ctx.tabsMocks.createTab).not.toHaveBeenCalled();
    });

    test('ipc-message link:navigate with disposition newTab opens via openInNewTabWithTarget', async () => {
      const ctx = await setupEnsDispatch();
      const rawHref = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'link:navigate',
        args: [{ url: rawHref, disposition: 'newTab', target: null }],
      });
      await flushMicrotasks();

      expect(ctx.tabsMocks.openInNewTabWithTarget).toHaveBeenCalledWith(rawHref, null);
      expect(ctx.tabsMocks.createTab).not.toHaveBeenCalled();
      expect(ctx.urlUtilsMocks.formatIpfsUrl).not.toHaveBeenCalled();
    });

    test('ipc-message link:navigate with named target forwards the target name for tab reuse', async () => {
      // P3 from the round-4 review: a `<a target="docs" href="ipfs://...">`
      // click should route through the same named-target tab-reuse path
      // that `setWindowOpenHandler → tab:new-with-url` uses for non-dweb
      // links. Passing the target through to `openInNewTabWithTarget`
      // preserves the reuse semantics that earlier versions silently
      // dropped on the dweb-link interceptor path.
      const ctx = await setupEnsDispatch();
      const rawHref = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'link:navigate',
        args: [{ url: rawHref, disposition: 'newTab', target: 'docs' }],
      });
      await flushMicrotasks();

      expect(ctx.tabsMocks.openInNewTabWithTarget).toHaveBeenCalledWith(rawHref, 'docs');
    });

    test('ipc-message link:navigate with target=_blank does not register as a named tab', async () => {
      // `_blank`/`_self`/`_parent`/`_top` are special — they mean
      // "default new-tab disposition", not "reuse a named tab". The
      // renderer mirrors webcontents-setup.js' `!frameName.startsWith('_')`
      // gate so the named-target map only ever holds real names.
      const ctx = await setupEnsDispatch();
      const rawHref = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'link:navigate',
        args: [{ url: rawHref, disposition: 'newTab', target: '_blank' }],
      });
      await flushMicrotasks();

      expect(ctx.tabsMocks.openInNewTabWithTarget).toHaveBeenCalledWith(rawHref, null);
    });
  });

  describe('trust shield', () => {
    const installEnsParser = (ctx) => {
      ctx.pageUrlsMocks.parseEnsInput.mockImplementation((value) => {
        const prefixMatch = value.match(/^(ens|bzz|ipfs|ipns):\/\//i);
        const assertedTransport = prefixMatch
          ? prefixMatch[1].toLowerCase() === 'ens'
            ? null
            : prefixMatch[1].toLowerCase()
          : null;
        const m = value.match(/^(?:(?:ens|bzz|ipfs|ipns):\/\/)?([^?/]+)(.*)?$/i);
        if (!m) return null;
        const name = m[1].toLowerCase();
        return (
          name.endsWith('.eth') ||
          name.endsWith('.box') ||
          name.endsWith('.wei') ||
          name.endsWith('.gwei')
        )
          ? { name, suffix: m[2] || '', assertedTransport }
          : null;
      });
    };

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

    test('network config updates keep current trust while re-resolving foreground ENS name', async () => {
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      const trust = {
        level: 'verified',
        queried: ['a', 'b'],
        agreed: ['a', 'b'],
      };
      ctx.state.ensTrustByName.set('vitalik.eth', trust);
      ctx.state.ensUriByName.set('vitalik.eth', 'bzz://old-reference');
      ctx.elements.addressInput.value = 'bzz://vitalik.eth';
      ctx.elements.addressInput.dispatch('input');
      expect(ctx.elements.trustShield.hidden).toBe(false);

      ctx.electronAPI.resolveEns.mockReturnValue(new Promise(() => {}));
      ctx.mod.onSettingsChanged({ networkConfigUpdated: true });

      expect(ctx.state.ensTrustByName.get('vitalik.eth')).toBe(trust);
      expect(ctx.state.ensUriByName.get('vitalik.eth')).toBe('bzz://old-reference');
      expect(ctx.elements.trustShield.hidden).toBe(false);
      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('vitalik.eth');
    });

    test('network config updates from settings keep background ENS trust cached', async () => {
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      const trust = {
        level: 'verified',
        queried: ['a', 'b'],
        agreed: ['a', 'b'],
      };
      ctx.state.ensTrustByName.set('vitalik.eth', trust);
      ctx.state.ensUriByName.set('vitalik.eth', 'bzz://old-reference');

      ctx.elements.addressInput.value = 'freedom://settings/ens';
      ctx.elements.addressInput.dispatch('input');
      expect(ctx.elements.trustShield.hidden).toBe(true);

      ctx.mod.onSettingsChanged({ networkConfigUpdated: true });

      expect(ctx.state.ensTrustByName.get('vitalik.eth')).toBe(trust);
      expect(ctx.state.ensUriByName.get('vitalik.eth')).toBe('bzz://old-reference');
      expect(ctx.electronAPI.resolveEns).not.toHaveBeenCalled();

      ctx.elements.addressInput.value = 'bzz://vitalik.eth';
      ctx.elements.addressInput.dispatch('input');

      expect(ctx.elements.trustShield.getAttribute('data-trust')).toBe('verified');
      expect(ctx.elements.trustShield.hidden).toBe(false);
    });
  });

  describe('trust popover staleness', () => {
    // The popover is a security/trust surface. Leaving it open on a stale
    // ENS resolution after the user has navigated away (or switched
    // tabs) would mislead about the page they're now looking at — these
    // tests pin the close-on-stale guard wired into updateProtocolIcon.

    const verifiedTrust = {
      level: 'verified',
      queried: ['a', 'b'],
      agreed: ['a', 'b'],
    };

    const openPopoverFor = (ctx, ensName, trust = verifiedTrust) => {
      // index.html declares `<div id="trust-popover" hidden>`; the fake
      // DOM creates plain elements with no initial attributes, so we
      // mirror the production starting state explicitly here. Without
      // it `toggleTrustPopover` would read `hidden === undefined` and
      // take the "already open, close it" branch on the first click.
      ctx.elements.trustPopover.hidden = true;
      ctx.state.ensTrustByName.set(ensName, trust);
      ctx.elements.addressInput.value = `ens://${ensName}`;
      ctx.elements.addressInput.dispatch('input');
      ctx.elements.trustShield.dispatch('click');
      expect(ctx.elements.trustPopover.hidden).toBe(false);
      expect(ctx.elements.trustShield.getAttribute('aria-expanded')).toBe('true');
    };

    test('hides the destination section when the resolution has no content rows', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      openPopoverFor(ctx, 'vitalik.eth');

      expect(ctx.elements.trustPopoverContent.hidden).toBe(true);
    });

    test('closes when the address bar moves to a non-ENS URL', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      openPopoverFor(ctx, 'vitalik.eth');

      ctx.elements.addressInput.value = 'https://example.com';
      ctx.elements.addressInput.dispatch('input');

      expect(ctx.elements.trustPopover.hidden).toBe(true);
      expect(ctx.elements.trustShield.getAttribute('aria-expanded')).toBe('false');
    });

    test('closes when the address bar moves to a freedom:// internal page', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      openPopoverFor(ctx, 'vitalik.eth');

      // Internal pages render the neutral globe (no shield); the
      // popover must follow the shield away rather than linger with
      // vitalik.eth's RPCs / block / CID over the settings page.
      ctx.elements.addressInput.value = 'freedom://settings';
      ctx.elements.addressInput.dispatch('input');

      expect(ctx.elements.trustPopover.hidden).toBe(true);
      expect(ctx.elements.trustShield.getAttribute('aria-expanded')).toBe('false');
    });

    test('closes when the address bar moves to a different ENS name', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.state.ensTrustByName.set('other.eth', {
        level: 'unverified',
        queried: ['x'],
        agreed: ['x'],
      });
      openPopoverFor(ctx, 'vitalik.eth');

      ctx.elements.addressInput.value = 'ens://other.eth';
      ctx.elements.addressInput.dispatch('input');

      // The shield itself stays visible for the new ENS name, but the
      // popover content was about vitalik.eth and must not survive the
      // switch.
      expect(ctx.elements.trustShield.hidden).toBe(false);
      expect(ctx.elements.trustPopover.hidden).toBe(true);
      expect(ctx.elements.trustShield.getAttribute('aria-expanded')).toBe('false');
    });

    test('stays open across a no-op refresh on the same address', async () => {
      // Regression guard against a too-aggressive close rule: the
      // stale check must not fire when the address bar simply
      // re-emits an input event (e.g. focus changes, programmatic
      // value reassignment to the same string) without the resolved
      // ENS name actually changing.
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      openPopoverFor(ctx, 'vitalik.eth');

      ctx.elements.addressInput.dispatch('input');

      expect(ctx.elements.trustPopover.hidden).toBe(false);
      expect(ctx.elements.trustShield.getAttribute('aria-expanded')).toBe('true');
    });

    test('closes when stored trust for the same name is replaced', async () => {
      // Rarer but real: a fresh resolution finishes for the still-
      // current ENS name and replaces the trust map entry. The popover
      // is now showing details that no longer match the stored
      // resolution. Comparing the trust object reference (not just the
      // name) catches this.
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      openPopoverFor(ctx, 'vitalik.eth');

      ctx.state.ensTrustByName.set('vitalik.eth', {
        level: 'conflict',
        queried: ['a', 'b'],
        agreed: ['a'],
        dissented: ['b'],
      });
      ctx.elements.addressInput.dispatch('input');

      expect(ctx.elements.trustPopover.hidden).toBe(true);
      expect(ctx.elements.trustShield.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('ENS reload re-resolution', () => {
    // Issue #82: reload on an ENS page used to call webview.reload() against
    // the resolved transport URL (carrying the actual content hash), which
    // never re-entered the ENS resolution path. After flipping the ENS
    // verification method in settings, the trust badge stayed stuck on the
    // previous method until the user re-typed the name. These tests pin the
    // fix: reload now detects ENS-form address-bar values and routes them
    // through loadTarget so the resolution + trust badge refresh under the
    // currently-configured method.
    const installEnsParser = (ctx) => {
      ctx.pageUrlsMocks.parseEnsInput.mockImplementation((value) => {
        const prefixMatch = value.match(/^(ens|bzz|ipfs|ipns):\/\//i);
        const assertedTransport = prefixMatch
          ? prefixMatch[1].toLowerCase() === 'ens'
            ? null
            : prefixMatch[1].toLowerCase()
          : null;
        const m = value.match(/^(?:(?:ens|bzz|ipfs|ipns):\/\/)?([^?/]+)(.*)?$/i);
        if (!m) return null;
        const name = m[1].toLowerCase();
        return (
          name.endsWith('.eth') ||
          name.endsWith('.box') ||
          name.endsWith('.wei') ||
          name.endsWith('.gwei')
        )
          ? { name, suffix: m[2] || '', assertedTransport }
          : null;
      });
    };

    // Mirror the production post-commit shape across the two handlers
    // that write to it:
    //   - `addressInput.value` and `navState.addressBarSnapshot` are
    //     written by navigation.js' did-navigate handler (foreground UI
    //     and draft-restoration snapshot).
    //   - `navState.committedDisplayUrl` is written by tabs.js'
    //     per-webview did-navigate handler — for both active and
    //     background tabs — so reload and provider permission keying
    //     read the actual committed page identity rather than a draft
    //     in addressBarSnapshot or an in-flight destination URL.
    // The helper sets all three so reload tests start from a fully
    // committed state regardless of which handler owns each field.
    const commitDisplay = (ctx, value) => {
      ctx.elements.addressInput.value = value;
      ctx.activeRef.tab.navigationState.addressBarSnapshot = value;
      ctx.activeRef.tab.navigationState.committedDisplayUrl = value;
    };

    test('soft reload of an ENS page re-resolves and updates trust', async () => {
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      const oldTrust = {
        level: 'verified',
        method: 'colibri',
        queried: ['a', 'b'],
        agreed: ['a', 'b'],
      };
      const newTrust = {
        level: 'verified',
        method: 'public-rpc-quorum',
        queried: ['a', 'b', 'c'],
        agreed: ['a', 'b', 'c'],
      };
      ctx.state.ensTrustByName.set('vitalik.eth', oldTrust);
      commitDisplay(ctx, 'bzz://vitalik.eth/');
      ctx.activeRef.tab.webview.getURL.mockReturnValue(
        `bzz://${'a'.repeat(64)}/`
      );
      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'bzz',
        uri: `bzz://${'a'.repeat(64)}`,
        decoded: 'a'.repeat(64),
        trust: newTrust,
      });

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('vitalik.eth');
      expect(ctx.activeRef.tab.webview.reload).not.toHaveBeenCalled();
      expect(ctx.activeRef.tab.webview.reloadIgnoringCache).not.toHaveBeenCalled();
      expect(ctx.electronAPI.invalidateEnsContent).not.toHaveBeenCalled();
      expect(ctx.state.ensTrustByName.get('vitalik.eth')).toEqual(newTrust);
    });

    test('hard reload of an ENS page invalidates the contenthash cache and re-resolves', async () => {
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      commitDisplay(ctx, 'ipfs://vitalik.eth/about');
      ctx.activeRef.tab.webview.getURL.mockReturnValue('ipfs://bafyfake/about');
      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'ipfs',
        uri: 'ipfs://bafyfake',
        trust: { level: 'verified', queried: ['a'], agreed: ['a'] },
      });

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: true });
      await flushMicrotasks();

      expect(ctx.electronAPI.invalidateEnsContent).toHaveBeenCalledWith('vitalik.eth');
      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('vitalik.eth');
      expect(ctx.activeRef.tab.webview.reload).not.toHaveBeenCalled();
      expect(ctx.activeRef.tab.webview.reloadIgnoringCache).not.toHaveBeenCalled();
    });

    test('reload of a non-ENS page falls through to webview.reload()', async () => {
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      commitDisplay(ctx, 'https://example.com/');
      ctx.activeRef.tab.webview.getURL.mockReturnValue('https://example.com/');

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.reload).toHaveBeenCalled();
      expect(ctx.activeRef.tab.webview.reloadIgnoringCache).not.toHaveBeenCalled();
      expect(ctx.electronAPI.resolveEns).not.toHaveBeenCalled();
      expect(ctx.electronAPI.invalidateEnsContent).not.toHaveBeenCalled();
    });

    test('hard reload of a non-ENS page falls through to reloadIgnoringCache()', async () => {
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      commitDisplay(ctx, 'https://example.com/');
      ctx.activeRef.tab.webview.getURL.mockReturnValue('https://example.com/');

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: true });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.reloadIgnoringCache).toHaveBeenCalled();
      expect(ctx.activeRef.tab.webview.reload).not.toHaveBeenCalled();
      expect(ctx.electronAPI.resolveEns).not.toHaveBeenCalled();
      expect(ctx.electronAPI.invalidateEnsContent).not.toHaveBeenCalled();
    });

    test('reload of a bare-CID IPFS page routes to the error page when the node is disabled', async () => {
      const ctx = await loadNavigationModule({ registry: { ipfs: { mode: 'disabled' } } });
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      // Node was running when the page loaded; committedDisplayUrl holds the
      // bare-CID ipfs URL. It has since been disabled — a plain webview.reload()
      // would re-hit the ipfs: handler and render its raw JSON 503.
      const cidUrl = 'ipfs://bafybeihhofqwesc552xtojljmjslqryb6fco4kvfgpujf44dm2jp4e6jxm/';
      commitDisplay(ctx, cidUrl);
      ctx.activeRef.tab.webview.getURL.mockReturnValue(cidUrl);
      ctx.activeRef.tab.webview.loadURL.mockClear();

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.reload).not.toHaveBeenCalled();
      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=ipfs');
    });

    test('reload of a bare-hash Swarm page routes to the error page when the node is disabled', async () => {
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();
      ctx.state.bzzRoutePrefix = null;

      const hashUrl = `bzz://${'a'.repeat(64)}/`;
      commitDisplay(ctx, hashUrl);
      ctx.activeRef.tab.webview.getURL.mockReturnValue(hashUrl);
      ctx.activeRef.tab.webview.loadURL.mockClear();

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.reload).not.toHaveBeenCalled();
      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('pages/error.html');
      expect(loadedUrl).toContain('protocol=swarm');
    });

    test('reload of a bare-CID IPFS page still uses webview.reload() when the node is available', async () => {
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      const cidUrl = 'ipfs://bafybeihhofqwesc552xtojljmjslqryb6fco4kvfgpujf44dm2jp4e6jxm/';
      commitDisplay(ctx, cidUrl);
      ctx.activeRef.tab.webview.getURL.mockReturnValue(cidUrl);

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.reload).toHaveBeenCalled();
      expect(ctx.electronAPI.resolveEns).not.toHaveBeenCalled();
    });

    test('reload from an ENS error page recovers via the original-URL branch', async () => {
      // Regression guard for the existing branch order: the
      // getOriginalUrlFromErrorPage recovery path runs before the ENS
      // re-resolve check, so an error page recovered from an ENS load
      // re-runs the original URL through loadTarget (which itself re-enters
      // the ENS resolution path). The new ENS branch must not short-circuit
      // this — without the early return, an error-page reload would skip
      // the recovery path and re-resolve a possibly-stale display value.
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      commitDisplay(ctx, 'bzz://vitalik.eth/');
      ctx.activeRef.tab.webview.getURL.mockReturnValue(
        'file:///app/pages/error.html?url=bzz%3A%2F%2Fvitalik.eth%2F'
      );
      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'bzz',
        uri: `bzz://${'a'.repeat(64)}`,
        decoded: 'a'.repeat(64),
        trust: { level: 'verified', queried: ['a'], agreed: ['a'] },
      });

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('vitalik.eth');
      expect(ctx.activeRef.tab.webview.reload).not.toHaveBeenCalled();
      expect(ctx.electronAPI.invalidateEnsContent).not.toHaveBeenCalled();
    });

    test('hard reload from an ENS error page invalidates the contenthash cache and re-resolves', async () => {
      // Hard reload must bypass `ensResultCache` even on the recovery
      // branch — without this, a hard reload from an ENS error page would
      // re-run loadTarget but resolveEns would return the stale cached
      // contenthash from the failed attempt.
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      commitDisplay(ctx, 'bzz://vitalik.eth/');
      ctx.activeRef.tab.webview.getURL.mockReturnValue(
        'file:///app/pages/error.html?url=bzz%3A%2F%2Fvitalik.eth%2F'
      );
      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'bzz',
        uri: `bzz://${'a'.repeat(64)}`,
        decoded: 'a'.repeat(64),
        trust: { level: 'verified', queried: ['a'], agreed: ['a'] },
      });

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: true });
      await flushMicrotasks();

      expect(ctx.electronAPI.invalidateEnsContent).toHaveBeenCalledWith('vitalik.eth');
      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('vitalik.eth');
      expect(ctx.activeRef.tab.webview.reload).not.toHaveBeenCalled();
      expect(ctx.activeRef.tab.webview.reloadIgnoringCache).not.toHaveBeenCalled();
    });

    test('reload with unsubmitted ENS-looking text in the address bar reloads the current non-ENS page', async () => {
      // Reload reads `committedDisplayUrl`, not `addressInput.value`. If
      // the user has typed `vitalik.eth` over an `https://example.com`
      // page but hasn't submitted it, hitting reload should reload the
      // current page — submitting the typed value is the form-submit
      // handler's job.
      const ctx = await loadNavigationModule();
      installEnsParser(ctx);
      await ctx.mod.initNavigation();

      commitDisplay(ctx, 'https://example.com/');
      // Now simulate the user typing into the address bar without
      // submitting: addressInput.value is dirty, but committedDisplayUrl
      // still reflects the committed page.
      ctx.elements.addressInput.value = 'vitalik.eth';
      ctx.activeRef.tab.webview.getURL.mockReturnValue('https://example.com/');

      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.webview.reload).toHaveBeenCalled();
      expect(ctx.activeRef.tab.webview.reloadIgnoringCache).not.toHaveBeenCalled();
      expect(ctx.electronAPI.resolveEns).not.toHaveBeenCalled();
      expect(ctx.electronAPI.invalidateEnsContent).not.toHaveBeenCalled();
    });

    test('reload after a background ENS navigation commits in another tab re-resolves on switch-back', async () => {
      // Regression for the background-commit gap: a slow ENS load that
      // finishes while its tab is in the background must still populate
      // `committedDisplayUrl` so a later reload re-runs ENS resolution
      // under today's verification method.
      //
      // The committed write itself lives in tabs.js' per-webview
      // did-navigate handler (which fires for active and background
      // tabs). This test stubs that write so navigation.js' setup-and-
      // reload flow can be exercised end-to-end against the resulting
      // post-commit state — see tabs.test.js for the test that pins the
      // tabs.js handler itself.
      //
      // Crucially, navigation.js must NOT be writing `committedDisplayUrl`
      // before navigation actually commits. Doing so would let
      // `getDisplayUrlForWebview()` (which feeds Swarm provider permission
      // keys) briefly point at the destination origin while the previous
      // page is still loaded. The pre-commit `setAddressDisplayForTab`
      // call in the dweb dispatch path must therefore leave
      // `committedDisplayUrl` untouched until the simulated did-navigate
      // fires below.
      const tabA = createTab(1, 'https://a.example', { title: 'Tab A' });
      const tabB = createTab(2, 'about:blank', { title: 'Tab B' });
      const ctx = await loadNavigationModule({
        firstTab: tabA,
        tabs: [tabA, tabB],
        activeTab: tabA,
      });
      installEnsParser(ctx);
      ctx.tabsRef.list = [tabA, tabB];
      ctx.activeRef.tab = tabA;
      await ctx.mod.initNavigation();

      // Step 1: kick off ENS navigation in Tab A with a deferred resolveEns.
      let resolveResolver;
      ctx.electronAPI.resolveEns.mockReturnValue(
        new Promise((resolve) => {
          resolveResolver = resolve;
        })
      );
      ctx.mod.loadTarget('vitalik.eth', null, tabA.webview);
      await flushMicrotasks();
      expect(ctx.elements.addressInput.value).toBe('vitalik.eth');

      // Step 2: user switches to Tab B before resolveEns settles. We seed
      // previousActiveTabId via the prior tab-switched dispatch so a real
      // switch flow is exercised, and clear the foreground address input
      // to mimic Tab B's own URL taking over.
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabA.id,
        tab: tabA,
        isNewTab: false,
      });
      ctx.activeRef.tab = tabB;
      ctx.elements.addressInput.value = 'about:blank';
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabB.id,
        tab: tabB,
        isNewTab: false,
      });
      await flushMicrotasks();

      // Step 3: resolveEns settles in the background and the recursive
      // loadTarget commits the IPFS dispatch on Tab A. Pre-fix this also
      // wrote `committedDisplayUrl`, but that was wrong — Chromium hasn't
      // committed yet (and for bzz the Bee warm-probe hasn't even run).
      // Today the dispatch only stashes the display value into the
      // background tab's `addressBarSnapshot` for switchback restoration,
      // and `committedDisplayUrl` stays empty until did-navigate fires.
      resolveResolver({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'ipfs',
        uri: 'ipfs://QmVitalik',
        trust: { level: 'verified', queried: ['a', 'b'], agreed: ['a', 'b'] },
      });
      await flushMicrotasks();

      // Tab B's foreground address bar must not have been clobbered.
      expect(ctx.elements.addressInput.value).toBe('about:blank');
      // Tab A picked up the resolved display in addressBarSnapshot for
      // tab-switched restoration, but `committedDisplayUrl` stays empty
      // — it's only written by tabs.js' did-navigate handler.
      expect(tabA.navigationState.addressBarSnapshot).toBe('ipfs://vitalik.eth');
      expect(tabA.navigationState.committedDisplayUrl).toBe('');

      // Step 4: simulate the per-webview did-navigate that tabs.js fires
      // for Tab A once Chromium commits the navigation. tabs.js writes
      // `webview.getURL()` into `committedDisplayUrl` regardless of
      // whether the tab is active. We mirror that here so the post-
      // commit state matches production for the reload exercise below.
      tabA.webview.getURL.mockReturnValue('ipfs://vitalik.eth');
      tabA.navigationState.committedDisplayUrl = 'ipfs://vitalik.eth';

      // Step 5: switch back to Tab A. The tab-switched handler restores
      // addressInput.value from the snapshot.
      ctx.navigationUtilsMocks.deriveSwitchedTabDisplay.mockReturnValueOnce(
        'ipfs://vitalik.eth'
      );
      ctx.activeRef.tab = tabA;
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabA.id,
        tab: tabA,
        isNewTab: false,
      });
      await flushMicrotasks();
      expect(ctx.elements.addressInput.value).toBe('ipfs://vitalik.eth');

      // Step 6: hit reload. Now that committedDisplayUrl is populated, the
      // ENS branch fires instead of webview.reload().
      ctx.electronAPI.resolveEns.mockReset();
      ctx.electronAPI.resolveEns.mockResolvedValue({
        type: 'ok',
        name: 'vitalik.eth',
        protocol: 'ipfs',
        uri: 'ipfs://QmVitalik',
        trust: { level: 'verified', queried: ['a', 'b', 'c'], agreed: ['a', 'b', 'c'] },
      });
      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('vitalik.eth');
      expect(tabA.webview.reload).not.toHaveBeenCalled();
      expect(tabA.webview.reloadIgnoringCache).not.toHaveBeenCalled();
    });

    test('reload after typing ENS draft, switching tabs, and switching back reloads the current non-ENS page', async () => {
      // Regression for the addressBarSnapshot-vs-committedDisplayUrl split:
      //   1. Open https://example.com (commits).
      //   2. Type `vitalik.eth` into the address bar (no submit).
      //   3. Switch to another tab — tab-switched writes the live
      //      addressInput.value (the draft) into the previous tab's
      //      addressBarSnapshot.
      //   4. Switch back — addressInput.value is restored from the snapshot
      //      (still the draft).
      //   5. Hit reload.
      // Pre-fix, reload read addressBarSnapshot and re-resolved
      // `vitalik.eth` — wrong, the user never submitted it. Post-fix,
      // reload reads committedDisplayUrl (which only commits write to)
      // and reloads `https://example.com`.
      const tabA = createTab(1, 'https://example.com', { title: 'Tab A' });
      const tabB = createTab(2, 'https://other.example', { title: 'Tab B' });
      const ctx = await loadNavigationModule({
        firstTab: tabA,
        tabs: [tabA, tabB],
        activeTab: tabA,
      });
      installEnsParser(ctx);
      ctx.tabsRef.list = [tabA, tabB];
      ctx.activeRef.tab = tabA;
      await ctx.mod.initNavigation();

      commitDisplay(ctx, 'https://example.com/');
      tabA.webview.getURL.mockReturnValue('https://example.com/');

      // Seed `previousActiveTabId` so the next tab-switched actually fires
      // the address-bar-save branch (the first switch records the previous
      // id and skips the save). Mirrors the existing tab-switching test.
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabA.id,
        tab: tabA,
        isNewTab: false,
      });

      // Step 2: user types an unsubmitted draft into the address bar.
      ctx.elements.addressInput.value = 'vitalik.eth';

      // Step 3: switch to tab B. The handler writes the live (draft)
      // addressInput.value into Tab A's addressBarSnapshot.
      ctx.activeRef.tab = tabB;
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabB.id,
        tab: tabB,
        isNewTab: false,
      });
      await flushMicrotasks();

      expect(tabA.navigationState.addressBarSnapshot).toBe('vitalik.eth');
      // Crucially, the draft did NOT leak into committedDisplayUrl.
      expect(tabA.navigationState.committedDisplayUrl).toBe('https://example.com/');

      // Step 4: switch back to tab A.
      ctx.navigationUtilsMocks.deriveSwitchedTabDisplay.mockReturnValueOnce('vitalik.eth');
      ctx.activeRef.tab = tabA;
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabA.id,
        tab: tabA,
        isNewTab: false,
      });
      await flushMicrotasks();

      // Address input restored to the draft — but committedDisplayUrl
      // remains the genuinely-committed URL.
      expect(ctx.elements.addressInput.value).toBe('vitalik.eth');
      expect(tabA.navigationState.committedDisplayUrl).toBe('https://example.com/');

      // Step 5: hit reload.
      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(tabA.webview.reload).toHaveBeenCalled();
      expect(tabA.webview.reloadIgnoringCache).not.toHaveBeenCalled();
      expect(ctx.electronAPI.resolveEns).not.toHaveBeenCalled();
      expect(ctx.electronAPI.invalidateEnsContent).not.toHaveBeenCalled();
    });
  });
});
