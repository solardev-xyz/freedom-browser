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
    onchainProvenance: overrides.onchainProvenance || null,
  };
};

const loadNavigationModule = async (options = {}) => {
  jest.resetModules();

  const homeUrl = 'file:///app/pages/home.html';
  const historyUrl = 'file:///app/pages/history.html';
  const privateUrl = 'file:///app/pages/private.html';
  const errorUrlBase = 'file:///app/pages/error.html';
  // Mirrors `page-urls.js`: chrome pages are matched on the shell's own
  // resolved `pages/<file>` base, never a `/<file>.html` substring, so a
  // remote look-alike path can't impersonate an internal page (#235).
  const matchesInternalPage = (url, base) =>
    typeof url === 'string' &&
    (url === base || url.startsWith(`${base}?`) || url.startsWith(`${base}#`));
  const isInterstitialPageUrlMock = (url) =>
    ['file:///app/pages/ens-unverified.html', 'file:///app/pages/ens-conflict.html'].some((base) =>
      matchesInternalPage(url, base)
    );
  const isOnchainInterstitialPageUrlMock = (url) =>
    matchesInternalPage(url, 'file:///app/pages/onchain-unverified.html');
  const state = {
    bzzRoutePrefix: 'https://gateway.example/bzz/',
    ipfsRoutePrefix: 'https://gateway.example/ipfs/',
    ipnsRoutePrefix: 'https://gateway.example/ipns/',
    radicleApiPrefix: 'radapi://local/api/v1/repos/',
    radicleBase: 'radapi://local',
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
  // navigation.js only reaches into wallet-ui.js for the ethereum: tip-link
  // send flow; the reason constants mirror the real module so the refusal
  // messages are asserted against the same strings production compares.
  const walletUiMocks = {
    openSendFlow: jest.fn(() => 'ok'),
    SEND_FLOW_OK: 'ok',
    SEND_FLOW_DISABLED: 'disabled',
    SEND_FLOW_PRIVATE: 'private',
    SEND_FLOW_SETUP: 'setup',
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
    setOnchainProvenanceChangeHandler: jest.fn((handler) => {
      tabsMocks.onchainProvenanceChangeHandler = handler;
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
      ({ url, isLoading, addressBarSnapshot, addressBarPendingInput }) => {
        if (typeof addressBarPendingInput === 'string') return addressBarPendingInput;
        return (
          (isLoading && addressBarSnapshot) ||
          // Mirrors the real helper on the one branch the focus rule depends on:
          // a new-tab page (home, or a private window's start page) derives to an
          // EMPTY address bar, not to its `freedom://<page>` name (#312).
          (url && !pageUrlsMocks.isNewTabPageUrl(url) ? `switched:${url}` : '')
        );
      }
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
      if (!matchesInternalPage(url, errorUrlBase)) return null;
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
      if (value?.startsWith('rad://')) return 'radicle';
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
    formatOnchainAppUrl: jest.fn((input) => {
      const raw = (input || '').trim();
      const canonical = raw.match(/^web3:\/\/(0x[0-9a-f]{40})\.eip155-([0-9]+)([/?#].*)?$/i);
      const friendly = raw.match(
        /^web3:\/\/(0x[0-9a-f]{40})(?::([1-9][0-9]*))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i
      );
      const match = canonical || friendly;
      if (!match) return null;
      const chainId = Number(match[2] || 1);
      const rawSuffix = canonical
        ? match[3] || '/'
        : `${match[3] || '/'}${match[4] || ''}${match[5] || ''}`;
      const suffix = rawSuffix.startsWith('/') ? rawSuffix : `/${rawSuffix}`;
      return `web3://${match[1].toLowerCase()}.eip155-${chainId}${suffix}`;
    }),
    formatOnchainAppDisplayUrl: jest.fn((input) => {
      const raw = (input || '').trim();
      const canonical = raw.match(/^web3:\/\/(0x[0-9a-f]{40})\.eip155-([0-9]+)([/?#].*)?$/i);
      const friendly = raw.match(
        /^web3:\/\/(0x[0-9a-f]{40})(?::([1-9][0-9]*))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i
      );
      const match = canonical || friendly;
      if (!match) return null;
      const chainId = Number(match[2] || 1);
      const rawSuffix = canonical
        ? match[3] || '/'
        : `${match[3] || '/'}${match[4] || ''}${match[5] || ''}`;
      const suffix = rawSuffix.startsWith('/') ? rawSuffix : `/${rawSuffix}`;
      return `web3://${match[1].toLowerCase()}${chainId === 1 ? '' : `:${chainId}`}${suffix}`;
    }),
    looksLikeOnchainAppInput: jest.fn((input) => /^web3:/i.test((input || '').trim())),
    deriveDisplayValue: jest.fn((url) => `display:${url}`),
    deriveBzzBaseFromUrl: jest.fn((url) =>
      url.includes('/bzz/') ? 'https://gateway.example/bzz/hash/' : null
    ),
    deriveIpfsBaseFromUrl: jest.fn(() => null),
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
      private: privateUrl,
    },
    detectProtocol: jest.fn(() => 'https'),
    isHistoryRecordable: jest.fn((displayUrl, internalUrl) => {
      return (
        Boolean(displayUrl) &&
        !displayUrl.startsWith('freedom://') &&
        !displayUrl.startsWith('view-source:') &&
        !matchesInternalPage(internalUrl, errorUrlBase)
      );
    }),
    getInternalPageName: jest.fn((url) => {
      if (url === historyUrl) return 'history';
      if (url === privateUrl) return 'private';
      if (url === homeUrl) return 'home';
      return null;
    }),
    // Mirrors `page-urls.js#isNewTabPageUrl`: the home page and the private
    // window's start page, in both the friendly `freedom://` form and the
    // resolved `file://` one (#312).
    isNewTabPageUrl: jest.fn(
      (url) =>
        url === homeUrl ||
        url === privateUrl ||
        url === 'freedom://home' ||
        url === 'freedom://private'
    ),
    getOnchainInterstitialTarget: jest.fn(() => null),
    isErrorPageUrl: jest.fn((url) => matchesInternalPage(url, errorUrlBase)),
    isInterstitialPageUrl: jest.fn((url) => isInterstitialPageUrlMock(url)),
    isOnchainInterstitialPageUrl: jest.fn((url) => isOnchainInterstitialPageUrlMock(url)),
    isTrustInterstitialPageUrl: jest.fn(
      (url) => isInterstitialPageUrlMock(url) || isOnchainInterstitialPageUrlMock(url)
    ),
    getInterstitialDisplayName: jest.fn((url) => {
      if (!isInterstitialPageUrlMock(url)) {
        return null;
      }
      try {
        return new URL(url).searchParams.get('name') || null;
      } catch {
        return null;
      }
    }),
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
    // Shift+click on a link routes here (#303) — same request the page context
    // menu's "Open Link in New Window" uses.
    openUrlInNewWindow: jest.fn(),
    fetchFaviconWithKey: jest.fn().mockResolvedValue('data:image/png;base64,favicon'),
    addHistory: jest.fn().mockResolvedValue(undefined),
    setBzzBase: jest.fn(),
    clearBzzBase: jest.fn(),
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
  const trustPopoverContentTitle = createElement('div');
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
      'trust-popover-content-title': trustPopoverContentTitle,
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

  jest.doMock('./state.js', () => ({
    state,
    // Mirrors the real helper: the profile's Radicle mode is published into
    // the service registry by the main process.
    isRadicleDisabledForProfile: () => state.registry?.radicle?.mode === 'disabled',
  }));
  jest.doMock('./debug.js', () => debugMocks);
  jest.doMock('./bookmarks-ui.js', () => bookmarksUiMocks);
  jest.doMock('./github-bridge-ui.js', () => githubBridgeUiMocks);
  jest.doMock('./tabs.js', () => tabsMocks);
  jest.doMock('./navigation-utils.js', () => navigationUtilsMocks);
  jest.doMock('./url-utils.js', () => urlUtilsMocks);
  jest.doMock('./page-urls.js', () => pageUrlsMocks);
  jest.doMock('./ipfs-progress-status.js', () => ipfsProgressMocks);
  jest.doMock('./wallet-ui.js', () => walletUiMocks);

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
    walletUiMocks,
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

    ctx.elements.addressInput.value = 'rad://zrepo123';
    ctx.mod.onSettingsChanged();
    expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledTimes(1);
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
      expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Ignoring empty input or invalid URL.');
    });

    test('does not turn protocol input into a search', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      await flushMicrotasks();

      ctx.mod.loadTarget('ipfs://bafybeigdyrzt');

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith('ipfs://bafybeigdyrzt');
    });
  });

  describe('onchain application navigation', () => {
    const ADDRESS = '0x00000095643CFfA7D9fae407a84dfCB6406456c6';
    const CANONICAL = `web3://${ADDRESS.toLowerCase()}.eip155-1/`;

    test('loads an ERC-8244 app through its canonical contract-and-chain origin', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget(`web3://${ADDRESS}`);

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(CANONICAL);
      expect(ctx.elements.addressInput.value).toBe(`web3://${ADDRESS.toLowerCase()}/`);
      expect(ctx.activeRef.tab.navigationState.pendingNavigationUrl).toBe(CANONICAL);
    });

    test('preserves app routes while canonicalizing the origin', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      const target = `web3://${ADDRESS}:100/swap?token=eth#route`;

      ctx.mod.loadTarget(target);

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        `web3://${ADDRESS.toLowerCase()}.eip155-100/swap?token=eth#route`
      );
      expect(ctx.elements.addressInput.value).toBe(
        `web3://${ADDRESS.toLowerCase()}:100/swap?token=eth#route`
      );
    });

    test('refuses to view the source of the trust gate, on dispatch and on commit', async () => {
      // #235: the gate's own `file:///…/pages/onchain-unverified.html?…` URL
      // carries the single-use approval token. `view-source:` of it commits
      // that URL, so every chrome surface that repaints from the committed
      // URL — address bar, tab title, window title — would publish the token
      // and the on-disk implementation path. The context menu hides the item;
      // the dispatch refuses the navigation outright.
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      const gateUrl = `file:///app/pages/onchain-unverified.html?target=${encodeURIComponent(
        CANONICAL
      )}&token=aaaabbbbccccddddeeeeffff`;

      ctx.activeRef.tab.webview.loadURL.mockClear();
      ctx.elements.addressInput.value = '';
      ctx.mod.loadTarget(`view-source:${gateUrl}`);

      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
      expect(ctx.elements.addressInput.value).toBe('');

      // Same for the name-resolution interstitials — same class of page.
      ctx.mod.loadTarget('view-source:file:///app/pages/ens-conflict.html?name=lagged.tez');
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();

      // Ordinary content still views its source.
      ctx.mod.loadTarget('view-source:https://example.com/page');
      // (`buildViewSourceNavigation` is mocked with a `load:` prefix here.)
      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'load:view-source:https://example.com/page'
      );

      // Fail-safe on commit: if such a tab exists anyway (session restore, a
      // back/forward entry predating the refusal above), the address bar and
      // title stay blank rather than showing the token.
      ctx.activeRef.tab.webview.getURL.mockReturnValue(`view-source:${gateUrl}`);
      ctx.tabsMocks.webviewEventHandler('did-navigate', { event: { url: gateUrl } });

      expect(ctx.elements.addressInput.value).toBe('');
      expect(ctx.tabsMocks.updateActiveTabTitle).toHaveBeenCalledWith('');
      expect(ctx.electronAPI.setWindowTitle).toHaveBeenCalledWith('');
    });

    test('surfaces malformed web3 intent instead of searching for it', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget('web3://not-a-contract:1/');

      expect(global.alert).toHaveBeenCalledWith(
        expect.stringContaining('Invalid onchain application URL')
      );
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
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
      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(`bzz://${VALID_HASH}/`);
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
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalledWith(`bzz://${VALID_HASH}/`);
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
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalledWith(`bzz://${VALID_HASH}/`);

      // Settle the second probe with success — it should load the bzz:// URL.
      settleAwait(ctx, 'probe-2', { ok: true });
      await flushMicrotasks();
      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(`bzz://${secondHash}/`);
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

    // A profile with Radicle disabled can never start the node, so the
    // generic connection-error panel would point at a toggle this profile
    // does not have. The purpose-built panel explains the profile setting.
    test('Radicle: a disabled profile lands on the explanatory disabled panel', async () => {
      const ctx = await loadNavigationModule({
        registry: { ipfs: { mode: 'bundled' }, radicle: { mode: 'disabled' } },
      });
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget('rad://zrepo123');
      await flushMicrotasks();

      expect(ctx.navigationUtilsMocks.buildRadicleDisabledUrl).toHaveBeenCalledWith(
        expect.any(String),
        'rad://zrepo123'
      );
      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toBe('file:///app/pages/rad-browser.html?error=disabled');
      expect(ctx.urlUtilsMocks.formatRadicleUrl).not.toHaveBeenCalled();
    });

    test('Radicle: an enabled profile still routes to the repository viewer', async () => {
      const ctx = await loadNavigationModule({
        registry: { ipfs: { mode: 'bundled' }, radicle: { mode: 'embedded' } },
      });
      await ctx.mod.initNavigation();

      ctx.mod.loadTarget('rad://zrepo123');
      await flushMicrotasks();

      expect(ctx.navigationUtilsMocks.buildRadicleDisabledUrl).not.toHaveBeenCalled();
      const loadedUrl = ctx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0];
      expect(loadedUrl).toContain('rad-browser.html?rid=zrepo123');
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

  describe('ethereum: tip links', () => {
    // The chain registry has to be populated or handleEthereumUri bails before
    // it ever reaches openSendFlow.
    const loadWithChains = async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      const { walletState } = await import('./wallet/wallet-state.js');
      walletState.registeredChains = { 100: { name: 'Gnosis' } };
      return ctx;
    };

    test('opens the send flow with the parsed recipient, chain and amount', async () => {
      const ctx = await loadWithChains();

      ctx.mod.loadTarget('ethereum:0x1111111111111111111111111111111111111111@100?value=1e18');
      await flushMicrotasks();

      expect(ctx.walletUiMocks.openSendFlow).toHaveBeenCalledWith({
        recipient: '0x1111111111111111111111111111111111111111',
        chainId: 100,
        amount: '1',
      });
      expect(global.alert).not.toHaveBeenCalled();
      // Routing to the sidebar means no page load.
      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
    });

    // Each refusal has a different way out; the alert has to name the right
    // one. Telling a private-window user to flip a Settings toggle that is
    // already on leaves them with no path forward (#240).
    test('explains a private window instead of pointing at the feature toggle', async () => {
      const ctx = await loadWithChains();
      ctx.walletUiMocks.openSendFlow.mockReturnValue('private');

      ctx.mod.loadTarget('ethereum:0x1111111111111111111111111111111111111111@100');
      await flushMicrotasks();

      expect(global.alert).toHaveBeenCalledWith(
        'Wallet is unavailable in private windows. Open a normal window to accept tips.'
      );
    });

    test('points at the feature toggle only when the feature is off', async () => {
      const ctx = await loadWithChains();
      ctx.walletUiMocks.openSendFlow.mockReturnValue('disabled');

      ctx.mod.loadTarget('ethereum:0x1111111111111111111111111111111111111111@100');
      await flushMicrotasks();

      expect(global.alert).toHaveBeenCalledWith(
        'Enable Identity & Wallet (Settings → Experimental) to accept tips.'
      );
    });

    test('points at onboarding when the wallet is enabled but not set up', async () => {
      const ctx = await loadWithChains();
      ctx.walletUiMocks.openSendFlow.mockReturnValue('setup');

      ctx.mod.loadTarget('ethereum:0x1111111111111111111111111111111111111111@100');
      await flushMicrotasks();

      expect(global.alert).toHaveBeenCalledWith(
        'Finish setting up Identity & Wallet to accept tips.'
      );
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

    test('committing an interstitial keeps the blocked name in the address bar', async () => {
      // #235: the interstitials are chrome, not content. Their own
      // `file:///…/pages/ens-*.html` URL must never reach the address bar —
      // the user keeps seeing the name they asked for, exactly like the
      // Swarm error page keeps `bzz://<hash>/`.
      const ctx = await setupEnsDispatch({ blockUnverifiedEns: true });

      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: {
          url: 'file:///app/pages/ens-unverified.html?name=retry.tez&uri=ipfs%3A%2F%2FQmRetryTez',
        },
      });
      expect(ctx.elements.addressInput.value).toBe('retry.tez');

      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: {
          url: 'file:///app/pages/ens-conflict.html?name=lagged.tez&block=%7B%7D&groups=%5B%5D',
        },
      });
      expect(ctx.elements.addressInput.value).toBe('lagged.tez');

      // Fail-safe: an interstitial without its `name` param still must not
      // fall through to the raw file:// path.
      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'file:///app/pages/ens-conflict.html' },
      });
      expect(ctx.elements.addressInput.value).toBe('');
    });

    test('a remote page at an interstitial-look-alike path cannot spoof the address bar', async () => {
      // #235 regression: `isInterstitialPageUrl` matched a `/ens-*.html`
      // substring, so any remote page served at that path was treated as
      // chrome — the address bar showed the attacker's `?name=` value (and
      // the trust shield could badge it) while the webview rendered the
      // attacker's HTML. Only the shell's own `pages/ens-*.html` is chrome.
      const ctx = await setupEnsDispatch({ blockUnverifiedEns: true });

      for (const hostile of [
        'https://evil.test/ens-conflict.html?name=bank.eth',
        'https://evil.test/pages/ens-unverified.html?name=bank.eth',
        'https://evil.test/error.html?url=bzz%3A%2F%2Fvitalik.eth',
      ]) {
        ctx.tabsMocks.webviewEventHandler('did-navigate', { event: { url: hostile } });
        expect(ctx.elements.addressInput.value).not.toBe('bank.eth');
        expect(ctx.elements.addressInput.value).not.toBe('bzz://vitalik.eth');
        // Falls through to the ordinary content path — `deriveDisplayValue`
        // (mocked here as a `display:` prefix) renders the real URL.
        expect(ctx.elements.addressInput.value).toBe(`display:${hostile}`);
      }
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

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith('https://example.com/landing');
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

      expect(global.alert).toHaveBeenCalledWith(expect.stringMatching(/resolves to ipfs, not bzz/));
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

      expect(global.alert).not.toHaveBeenCalledWith(expect.stringMatching(/resolves to ipfs, not/));
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
        ctx.activeRef.tab.webview.loadURL.mock.calls.find(([u]) =>
          u.includes('ens-unverified.html')
        )
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
        ctx.activeRef.tab.webview.loadURL.mock.calls.find(([u]) =>
          u.includes('ens-unverified.html')
        )
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

    test('ipc-message onchain continue returns the approval token as a navigation header', async () => {
      const ctx = await setupEnsDispatch();
      const target = 'web3://0x00000095643cffA7d9FAe407A84DfCB6406456C6.eip155-1/';
      const token = 'a'.repeat(43);

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'onchain:continue-unverified',
        args: [{ target, token }],
      });

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(target.toLowerCase(), {
        extraHeaders: `X-Freedom-Onchain-App-Approval: ${token}`,
      });
    });

    test('ipc-message onchain continue rejects malformed tokens', async () => {
      const ctx = await setupEnsDispatch();

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'onchain:continue-unverified',
        args: [
          {
            target: 'web3://0x00000095643cffA7d9FAe407A84DfCB6406456C6.eip155-1/',
            token: 'bad\r\nX-Injected: yes',
          },
        ],
      });

      expect(ctx.activeRef.tab.webview.loadURL).not.toHaveBeenCalled();
    });

    test('ipc-message onchain conflict retry re-enters normal web3 navigation', async () => {
      const ctx = await setupEnsDispatch();
      const target = 'web3://0x00000095643cffA7d9FAe407A84DfCB6406456C6.eip155-1/';

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'onchain:retry',
        args: [{ target }],
      });

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(target.toLowerCase());
    });

    test('ipc-message onchain settings opens the RPC section', async () => {
      const ctx = await setupEnsDispatch();

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'onchain:open-rpc-settings',
        args: [],
      });

      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith(
        'file:///app/pages/settings.html#rpc'
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

      expect(ctx.tabsMocks.openInNewTabWithTarget).toHaveBeenCalledWith(rawHref, null, {
        background: false,
      });
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

      expect(ctx.tabsMocks.openInNewTabWithTarget).toHaveBeenCalledWith(rawHref, 'docs', {
        background: false,
      });
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

      expect(ctx.tabsMocks.openInNewTabWithTarget).toHaveBeenCalledWith(rawHref, null, {
        background: false,
      });
    });

    // #303: Ctrl/Cmd+click and middle-click open a BACKGROUND tab in Chrome —
    // the current page stays active and keeps keyboard focus. The preload
    // resolves the modifiers into the disposition; this is the renderer half.
    test('ipc-message link:navigate with disposition newBackgroundTab opens without switching', async () => {
      const ctx = await setupEnsDispatch();
      const rawHref = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'link:navigate',
        args: [{ url: rawHref, disposition: 'newBackgroundTab', target: null }],
      });
      await flushMicrotasks();

      expect(ctx.tabsMocks.openInNewTabWithTarget).toHaveBeenCalledWith(rawHref, null, {
        background: true,
      });
      expect(ctx.electronAPI.openUrlInNewWindow).not.toHaveBeenCalled();
    });

    // #303: Shift+click opens a new window, through the same
    // `window:new-with-url` request (and private-window guard) the page
    // context menu's "Open Link in New Window" already uses.
    test('ipc-message link:navigate with disposition newWindow opens a window, not a tab', async () => {
      const ctx = await setupEnsDispatch();
      const rawHref = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'link:navigate',
        args: [{ url: rawHref, disposition: 'newWindow', target: null }],
      });
      await flushMicrotasks();

      expect(ctx.electronAPI.openUrlInNewWindow).toHaveBeenCalledWith(rawHref);
      expect(ctx.tabsMocks.openInNewTabWithTarget).not.toHaveBeenCalled();
      expect(ctx.tabsMocks.createTab).not.toHaveBeenCalled();
    });

    // An unknown/absent disposition still means "this tab" — the fallback has
    // to stay closed rather than defaulting into any of the new branches.
    test('ipc-message link:navigate with an unknown disposition navigates the current tab', async () => {
      const ctx = await setupEnsDispatch();
      const rawHref = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'link:navigate',
        args: [{ url: rawHref, disposition: 'newSomething', target: null }],
      });
      await flushMicrotasks();

      expect(ctx.tabsMocks.openInNewTabWithTarget).not.toHaveBeenCalled();
      expect(ctx.electronAPI.openUrlInNewWindow).not.toHaveBeenCalled();
      expect(ctx.urlUtilsMocks.formatIpfsUrl).toHaveBeenCalledWith(
        rawHref,
        ctx.state.ipfsRoutePrefix
      );
    });
  });

  // #312: a private window's new tab has to focus an EMPTY address bar, the
  // same as a normal window's. Before the fix the private start page derived
  // to `freedom://private`, so the "empty new tab" test never fired and focus
  // was left on <body>.
  describe('new tab focus', () => {
    const switchToNewTab = (ctx, url) => {
      const tab = createTab(42, url);
      ctx.tabsRef.list = [tab];
      ctx.activeRef.tab = tab;
      ctx.tabsMocks.webviewEventHandler('tab-switched', { tabId: tab.id, tab, isNewTab: true });
    };

    test('a new tab on the private start page focuses and selects an empty address bar', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      ctx.elements.addressInput.focus.mockClear();

      switchToNewTab(ctx, 'freedom://private');

      expect(ctx.elements.addressInput.value).toBe('');
      expect(ctx.elements.addressInput.focus).toHaveBeenCalled();
      expect(ctx.elements.addressInput.select).toHaveBeenCalled();
    });

    test('a new tab on the home page still focuses the address bar', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      ctx.elements.addressInput.focus.mockClear();

      switchToNewTab(ctx, 'file:///app/pages/home.html');

      expect(ctx.elements.addressInput.value).toBe('');
      expect(ctx.elements.addressInput.focus).toHaveBeenCalled();
    });

    test('a tab opened on a real page focuses the page, not the address bar', async () => {
      // A link opened in a new foreground tab: the address bar must not steal
      // focus, and focus must not stay stranded on the outgoing tab's
      // now-hidden webview either (#303/#304).
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();
      ctx.elements.addressInput.focus.mockClear();

      const tab = createTab(43, 'https://example.com/');
      const webviewFocus = jest.spyOn(tab.webview, 'focus');
      ctx.tabsRef.list = [tab];
      ctx.activeRef.tab = tab;
      ctx.tabsMocks.webviewEventHandler('tab-switched', { tabId: tab.id, tab, isNewTab: true });

      expect(ctx.elements.addressInput.focus).not.toHaveBeenCalled();
      expect(webviewFocus).toHaveBeenCalled();
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
        return name.endsWith('.eth') ||
          name.endsWith('.box') ||
          name.endsWith('.wei') ||
          name.endsWith('.gwei')
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
      // The refresh keys on the committed page, not on the live input.
      ctx.activeRef.tab.navigationState.committedDisplayUrl = 'bzz://vitalik.eth';
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
        return name.endsWith('.eth') ||
          name.endsWith('.box') ||
          name.endsWith('.wei') ||
          name.endsWith('.gwei')
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
      ctx.activeRef.tab.webview.getURL.mockReturnValue(`bzz://${'a'.repeat(64)}/`);
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
      ctx.navigationUtilsMocks.deriveSwitchedTabDisplay.mockReturnValueOnce('ipfs://vitalik.eth');
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
  describe('uncommitted address-bar edits (Chrome omnibox parity)', () => {
    // #305/#310/#314. The three behaviours share one concept: Chrome's
    // "user input in progress". These assert it end-to-end through the
    // renderer's own handlers rather than through the helper alone.

    const typeInAddressBar = (ctx, value) => {
      ctx.elements.addressInput.value = value;
      ctx.elements.addressInput.dispatch('input');
    };

    test('a page commit does not overwrite text the user is typing (#305)', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      // The page settles once with its own URL, so the bar (and the page
      // snapshot) start out truthful.
      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'https://page-a.example/' },
      });
      expect(ctx.elements.addressInput.value).toBe('display:https://page-a.example/');

      typeInAddressBar(ctx, 'my-important-note.eth/deep/link');

      // …and now the page redirects itself (client-side redirect, meta
      // refresh, a slow load finishing — all arrive as navigation events).
      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'https://page-b.example/' },
      });
      ctx.tabsMocks.webviewEventHandler('did-navigate-in-page', {
        event: { url: 'https://page-b.example/#frag' },
      });

      // The typed text survives; the page's own URL is kept as the snapshot
      // so Escape and tab switches still have it.
      expect(ctx.elements.addressInput.value).toBe('my-important-note.eth/deep/link');
      expect(ctx.activeRef.tab.navigationState.addressBarSnapshot).toBe(
        'display:https://page-b.example/#frag'
      );

      // Committing through the address bar ends the edit, so the next page
      // commit paints normally again.
      ctx.elements.navForm.dispatch('submit', { preventDefault: jest.fn() });
      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'https://page-c.example/' },
      });
      expect(ctx.elements.addressInput.value).toBe('display:https://page-c.example/');
    });

    test('an internal-page commit is held too, not just derived URLs (#305)', async () => {
      // Every branch of handleNavigationEvent writes the address bar; the
      // guard has to cover all of them, not only the one the report named.
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      typeInAddressBar(ctx, 'half-typed');

      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'file:///app/pages/history.html' },
      });
      expect(ctx.elements.addressInput.value).toBe('half-typed');
      expect(ctx.activeRef.tab.navigationState.addressBarSnapshot).toBe('freedom://history');

      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'file:///app/pages/error.html?url=https%3A%2F%2Ffailed.example' },
      });
      expect(ctx.elements.addressInput.value).toBe('half-typed');
    });

    test('an in-page link click keeps the edit, a chrome-driven load ends it (#305)', async () => {
      // A same-tab link click is replayed through `loadTarget` (the preload
      // intercept, and the main process' will-navigate bounce for custom
      // schemes — the exact route the #305 repro takes). Page-driven commits
      // must leave a half-typed address alone; chrome-driven ones commit it.
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      typeInAddressBar(ctx, 'half-typed');
      ctx.tabsMocks.webviewEventHandler('ipc-message', {
        tabId: ctx.activeRef.tab.id,
        channel: 'link:navigate',
        args: [{ url: 'https://linked.example/', disposition: 'currentTab' }],
      });
      await flushMicrotasks();

      expect(ctx.elements.addressInput.value).toBe('half-typed');
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBe('half-typed');

      // The same call without the page-initiated flag (menu item, bookmark,
      // address-bar submit) does commit.
      ctx.mod.loadTarget('https://chrome-driven.example/');
      await flushMicrotasks();
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBeNull();
    });

    // Bootstrap a module whose `parseEnsInput` recognises `<name>.eth` (bare
    // or transport-prefixed) and whose resolver never settles on its own, so
    // a test can hold a name resolution open across a user edit.
    const setupDeferredEns = async () => {
      const ctx = await loadNavigationModule();
      ctx.pageUrlsMocks.parseEnsInput.mockImplementation((value) => {
        const m = value.match(/^(?:(bzz|ipfs|ipns|ens):\/\/)?([^?/]+\.eth)(.*)?$/i);
        if (!m) return null;
        const scheme = m[1]?.toLowerCase();
        return {
          name: m[2].toLowerCase(),
          suffix: m[3] || '',
          assertedTransport: !scheme || scheme === 'ens' ? null : scheme,
        };
      });
      await ctx.mod.initNavigation();
      let settle;
      ctx.electronAPI.resolveEns.mockReturnValue(
        new Promise((resolve) => {
          settle = resolve;
        })
      );
      return {
        ctx,
        settle: async (result) => {
          settle(result);
          await flushMicrotasks();
        },
      };
    };

    const IPFS_RESOLUTION = {
      type: 'ok',
      name: 'name.eth',
      protocol: 'ipfs',
      uri: 'ipfs://QmResolved',
      decoded: 'QmResolved',
      trust: { level: 'verified', queried: ['a', 'b'], agreed: ['a', 'b'] },
    };

    test('a page-driven name resolution settling keeps the edit it was held for (#305)', async () => {
      // The report's own repro: the page scripts `location.href` to a custom
      // scheme, the main process bounces it back through `loadTarget` as
      // page-initiated, and the name resolution finishes a second later. The
      // resolution hop re-enters `loadTarget`; pre-fix that second entry ran
      // the chrome-driven branch and cleared the edit the outer call had just
      // held, so the resolved display painted straight over the typed text.
      const { ctx, settle } = await setupDeferredEns();

      typeInAddressBar(ctx, 'my-important-note.eth/deep/link');
      ctx.mod.loadTarget('bzz://name.eth/', null, null, { pageInitiated: true });
      await flushMicrotasks();
      expect(ctx.elements.addressInput.value).toBe('my-important-note.eth/deep/link');

      await settle({ ...IPFS_RESOLUTION, protocol: 'bzz', uri: `bzz://${'a'.repeat(64)}` });

      expect(ctx.elements.addressInput.value).toBe('my-important-note.eth/deep/link');
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBe(
        'my-important-note.eth/deep/link'
      );
      // The page's own display still lands in the snapshot, so Escape and a
      // tab switch have the truthful URL to fall back to.
      expect(ctx.activeRef.tab.navigationState.addressBarSnapshot).toBe('bzz://name.eth/');
    });

    test('a chrome-driven name resolution settling does not wipe a draft typed while it was in flight (#305)', async () => {
      // Committing `name.eth` ends that edit at submit time. If the lookup
      // takes a second and the user starts typing a new address meanwhile,
      // the resolution hop must not end *that* edit — it is a new one the
      // user has not committed.
      const { ctx, settle } = await setupDeferredEns();

      ctx.mod.loadTarget('name.eth');
      await flushMicrotasks();
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBeNull();

      typeInAddressBar(ctx, 'somewhere-else.example');
      await settle(IPFS_RESOLUTION);

      expect(ctx.elements.addressInput.value).toBe('somewhere-else.example');
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBe(
        'somewhere-else.example'
      );
      expect(ctx.activeRef.tab.navigationState.addressBarSnapshot).toBe('ipfs://name.eth');
      // …and the navigation itself still happened.
      expect(ctx.activeRef.tab.webview.loadURL).toHaveBeenCalledWith('ipfs://name.eth');
    });

    test("loadTarget's rad: error branches hold the edit like every other branch (#305)", async () => {
      // Both of these used to write `addressInput.value` directly, so they
      // painted over a held edit (and over the foreground tab when the
      // navigation targeted a background one). They go through the same
      // per-tab helper as their siblings now.
      const disabledCtx = await loadNavigationModule({
        registry: { ipfs: { mode: 'bundled' }, radicle: { mode: 'disabled' } },
      });
      await disabledCtx.mod.initNavigation();
      typeInAddressBar(disabledCtx, 'half-typed');
      disabledCtx.mod.loadTarget('rad://zrepo123', null, null, { pageInitiated: true });
      await flushMicrotasks();
      expect(disabledCtx.elements.addressInput.value).toBe('half-typed');
      expect(disabledCtx.activeRef.tab.navigationState.addressBarSnapshot).toBe('rad://zrepo123');

      const invalidCtx = await loadNavigationModule();
      await invalidCtx.mod.initNavigation();
      typeInAddressBar(invalidCtx, 'half-typed');
      invalidCtx.mod.loadTarget('rad:notarid', null, null, { pageInitiated: true });
      await flushMicrotasks();
      expect(invalidCtx.elements.addressInput.value).toBe('half-typed');
      expect(invalidCtx.activeRef.tab.webview.loadURL.mock.calls.at(-1)[0]).toContain(
        'error=invalid-rid'
      );
    });

    test('the search fallback does not end an edit a page-driven navigation held (#305)', async () => {
      // The tail of `loadTarget` re-enters itself with the built search URL.
      // That inner call is the same navigation, not a second user action.
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      typeInAddressBar(ctx, 'half-typed');
      ctx.mod.loadTarget('some free text query', null, null, { pageInitiated: true });
      await flushMicrotasks();

      expect(ctx.elements.addressInput.value).toBe('half-typed');
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBe('half-typed');
    });

    test('Escape reverts to the page URL keeping focus, and blurs only on the next press (#310)', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'https://page-a.example/' },
      });
      typeInAddressBar(ctx, 'bzz');

      const first = { key: 'Escape', preventDefault: jest.fn() };
      ctx.elements.addressInput.dispatch('keydown', first);

      expect(first.preventDefault).toHaveBeenCalled();
      expect(ctx.elements.addressInput.value).toBe('display:https://page-a.example/');
      // Chrome keeps focus in the omnibox and selects the restored text.
      expect(ctx.elements.addressInput.select).toHaveBeenCalled();
      expect(ctx.elements.addressInput.blur).not.toHaveBeenCalled();

      const second = { key: 'Escape', preventDefault: jest.fn() };
      ctx.elements.addressInput.dispatch('keydown', second);
      expect(ctx.elements.addressInput.blur).toHaveBeenCalled();
      expect(ctx.elements.addressInput.value).toBe('display:https://page-a.example/');
    });

    test('Escape stands down while the dropdown previews a suggestion (#310)', async () => {
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'https://page-a.example/' },
      });
      typeInAddressBar(ctx, 'bzz');
      // autocomplete.js previewed a row into the bar.
      ctx.elements.addressInput.value = 'https://suggestion.example';
      ctx.mod.setSuggestionPreviewProbe(() => true);

      const escape = { key: 'Escape', preventDefault: jest.fn() };
      ctx.elements.addressInput.dispatch('keydown', escape);

      // autocomplete.js owns this press: no revert, no blur, no preventDefault
      // from this handler.
      expect(escape.preventDefault).not.toHaveBeenCalled();
      expect(ctx.elements.addressInput.value).toBe('https://suggestion.example');
      expect(ctx.elements.addressInput.blur).not.toHaveBeenCalled();

      // With the dropdown closed again, this handler takes over.
      ctx.mod.setSuggestionPreviewProbe(() => false);
      ctx.elements.addressInput.dispatch('keydown', { key: 'Escape', preventDefault: jest.fn() });
      expect(ctx.elements.addressInput.value).toBe('display:https://page-a.example/');
    });

    test('an unsubmitted edit survives switching tabs and back (#314)', async () => {
      const tabB = createTab(2, 'https://second.example', {
        title: 'Second Tab',
        webview: createWebview('https://second.example', { webContentsId: 22 }),
      });
      const ctx = await loadNavigationModule();
      const tabA = ctx.activeRef.tab;
      ctx.tabsRef.list = [tabA, tabB];
      await ctx.mod.initNavigation();

      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'https://page-a.example/' },
      });
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabA.id,
        tab: tabA,
        isNewTab: false,
      });
      typeInAddressBar(ctx, 'half-typed-url');

      // Switch away: the draft goes onto the tab we left, and the page
      // snapshot is *not* replaced by it.
      ctx.activeRef.tab = tabB;
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabB.id,
        tab: tabB,
        isNewTab: false,
      });
      expect(tabA.navigationState.addressBarPendingInput).toBe('half-typed-url');
      expect(tabA.navigationState.addressBarSnapshot).toBe('display:https://page-a.example/');
      expect(ctx.elements.addressInput.value).toBe('switched:https://second.example');

      // …and back: the draft is restored and the bar regains focus, the way
      // Chrome restores per-tab omnibox state.
      ctx.elements.addressInput.focus.mockClear();
      ctx.activeRef.tab = tabA;
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabA.id,
        tab: tabA,
        isNewTab: false,
      });

      expect(ctx.elements.addressInput.value).toBe('half-typed-url');
      expect(ctx.elements.addressInput.focus).toHaveBeenCalled();

      // Escape ends the edit, so a later switch away restores the page URL.
      ctx.elements.addressInput.dispatch('keydown', { key: 'Escape', preventDefault: jest.fn() });
      expect(tabA.navigationState.addressBarPendingInput).toBeNull();
      ctx.activeRef.tab = tabB;
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabB.id,
        tab: tabB,
        isNewTab: false,
      });
      ctx.activeRef.tab = tabA;
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabA.id,
        tab: tabA,
        isNewTab: false,
      });
      // No draft left to restore: the display is derived from the tab's own
      // committed URL again (`deriveSwitchedTabDisplay` is mocked here).
      expect(ctx.elements.addressInput.value).not.toBe('half-typed-url');
      expect(ctx.elements.addressInput.value).toBe('switched:https://active.example');
    });

    test('reloading an error/ENS page keeps the edit, like reloading a plain page does', async () => {
      // Reload is not a commit of the address bar. On a plain page it is a
      // bare `webview.reload()` and the draft survives by construction; the
      // branches that have to route through `loadTarget` (error-page retry,
      // ENS re-resolution, an unavailable dweb node) must behave the same.
      const ctx = await loadNavigationModule();
      ctx.pageUrlsMocks.parseEnsInput.mockImplementation((value) =>
        /(^|\/\/)[^/]+\.eth/i.test(value) ? { name: 'vitalik.eth', suffix: '' } : null
      );
      await ctx.mod.initNavigation();

      // 1. Error-page retry branch.
      ctx.activeRef.tab.navigationState.committedDisplayUrl = 'https://failed.example/';
      ctx.activeRef.tab.webview.getURL.mockReturnValue(
        'file:///app/pages/error.html?url=https%3A%2F%2Ffailed.example%2F'
      );
      typeInAddressBar(ctx, 'half-typed-url');
      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBe('half-typed-url');
      expect(ctx.elements.addressInput.value).toBe('half-typed-url');

      // …and the page committing underneath it still doesn't repaint the bar.
      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'https://failed.example/' },
      });
      expect(ctx.elements.addressInput.value).toBe('half-typed-url');

      // 2. ENS re-resolution branch.
      ctx.electronAPI.resolveEns.mockReturnValue(new Promise(() => {}));
      ctx.activeRef.tab.navigationState.committedDisplayUrl = 'bzz://vitalik.eth/';
      ctx.activeRef.tab.webview.getURL.mockReturnValue(`bzz://${'a'.repeat(64)}/`);
      ctx.elements.reloadBtn.dispatch('click', { shiftKey: false });
      await flushMicrotasks();

      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('vitalik.eth');
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBe('half-typed-url');
      expect(ctx.elements.addressInput.value).toBe('half-typed-url');

      // The form submit is still what commits: it ends the edit.
      ctx.elements.navForm.dispatch('submit', { preventDefault: jest.fn() });
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBeNull();
    });

    test('a settings refresh reloads the committed page, not a half-typed draft', async () => {
      // A settings broadcast (e.g. a network config saved in another window)
      // is not the user submitting the address bar: it must re-run the page
      // the tab is on, and leave the draft alone.
      const ctx = await loadNavigationModule();
      ctx.pageUrlsMocks.parseEnsInput.mockImplementation((value) =>
        /(^|\/\/)[^/]+\.eth/i.test(value) ? { name: 'vitalik.eth', suffix: '' } : null
      );
      await ctx.mod.initNavigation();
      ctx.electronAPI.resolveEns.mockReturnValue(new Promise(() => {}));

      ctx.activeRef.tab.navigationState.committedDisplayUrl = 'bzz://vitalik.eth/';
      typeInAddressBar(ctx, 'half-typed.eth');

      ctx.mod.onSettingsChanged({ networkConfigUpdated: true });
      await flushMicrotasks();

      expect(ctx.electronAPI.resolveEns).toHaveBeenCalledWith('vitalik.eth');
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBe('half-typed.eth');
      expect(ctx.elements.addressInput.value).toBe('half-typed.eth');
    });

    test('Escape reverts to an empty page display in a single press (#310)', async () => {
      // A new-tab page's display *is* the empty string. Gating the revert on
      // snapshot truthiness left the typed fragment in the bar with nothing
      // tracking it — neither the page URL nor a live edit.
      const ctx = await loadNavigationModule();
      await ctx.mod.initNavigation();

      ctx.activeRef.tab.navigationState.addressBarSnapshot = '';
      ctx.activeRef.tab.navigationState.pendingTitleForUrl = '';
      typeInAddressBar(ctx, 'half-typed');

      ctx.elements.addressInput.dispatch('keydown', { key: 'Escape', preventDefault: jest.fn() });
      expect(ctx.elements.addressInput.value).toBe('');
      expect(ctx.activeRef.tab.navigationState.addressBarPendingInput).toBeNull();
      expect(ctx.elements.addressInput.select).toHaveBeenCalled();
      expect(ctx.elements.addressInput.blur).not.toHaveBeenCalled();

      // Nothing left to revert: the second press moves focus to the page.
      ctx.elements.addressInput.dispatch('keydown', { key: 'Escape', preventDefault: jest.fn() });
      expect(ctx.elements.addressInput.blur).toHaveBeenCalled();
      expect(ctx.elements.addressInput.value).toBe('');
    });

    test('a switch-to-tab suggestion does not write its URL into the tab it leaves', async () => {
      // autocomplete.js clears the edit and switches; the bar at that moment
      // holds the *target* tab's URL (a previewed row) or the leftover query,
      // so the tab being left must not adopt it as its page display.
      const tabB = createTab(2, 'https://second.example', {
        title: 'Second Tab',
        webview: createWebview('https://second.example', { webContentsId: 22 }),
      });
      const ctx = await loadNavigationModule();
      const tabA = ctx.activeRef.tab;
      ctx.tabsRef.list = [tabA, tabB];
      await ctx.mod.initNavigation();

      ctx.tabsMocks.webviewEventHandler('did-navigate', {
        event: { url: 'https://page-a.example/' },
      });
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabA.id,
        tab: tabA,
        isNewTab: false,
      });
      expect(tabA.navigationState.addressBarSnapshot).toBe('display:https://page-a.example/');

      // The dropdown previewed tab B's URL into the bar and committed it.
      ctx.elements.addressInput.value = 'https://second.example';
      ctx.activeRef.tab = tabB;
      ctx.tabsMocks.webviewEventHandler('tab-switched', {
        tabId: tabB.id,
        tab: tabB,
        isNewTab: false,
        fromAddressBarCommit: true,
      });

      expect(tabA.navigationState.addressBarSnapshot).toBe('display:https://page-a.example/');
    });
  });
});
