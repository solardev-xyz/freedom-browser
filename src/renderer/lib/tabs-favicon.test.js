// What tabs.js does with the webview's own `page-favicon-updated` report
// (#75).
//
// Before #75 this event was honoured for internal pages only, and every
// external site's icon was discovered by the main process re-downloading the
// page URL — cookielessly, on top of the webview's cookied load — just to
// regex `<link rel="icon">` out of the HTML. The event already carries what
// that fetch was after, so it is now forwarded to navigation.js, which hands
// the URL to main; main fetches that icon and nothing else.
//
// Driven through the real tabs.js on the fake-DOM harness, dispatching the
// event on the webview element the module created, rather than calling an
// internal hook: the handler's internal/external split and the tab id it
// tags each report with are exactly what a future edit could silently drop.

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const HOME_URL = 'freedom://home';
const INTERNAL_PAGE = 'file:///app/pages/history.html';
const EXTERNAL_PAGE = 'https://shop.example/items/42';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createWebview = (createdWebviews) => {
  const webview = createElement('webview');
  webview.getURL = jest.fn(() => webview.src || 'about:blank');
  webview.canGoBack = jest.fn(() => false);
  webview.canGoForward = jest.fn(() => false);
  webview.focus = jest.fn();
  createdWebviews.push(webview);
  return webview;
};

const loadTabs = async () => {
  jest.resetModules();

  const createdWebviews = [];
  const document = createDocument({
    elementsById: {
      'tab-bar': createElement('div'),
      'new-tab-btn': createElement('button'),
      'webview-container': createElement('div'),
      'tab-context-menu': createElement('div'),
      'bzz-webview': createElement('webview'),
      'address-input': createElement('input'),
    },
    createElementOverride: (tagName) =>
      tagName === 'webview' ? createWebview(createdWebviews) : createElement(tagName),
  });

  global.window = {
    electronAPI: {
      setWindowTitle: jest.fn(),
      updateTabMenuState: jest.fn(),
      closeWindow: jest.fn(),
      getWebviewPreloadPath: jest.fn().mockResolvedValue('/tmp/webview-preload.js'),
      // No cached icon: nothing else can paint the strip during these tests.
      getCachedFavicon: jest.fn().mockResolvedValue(''),
    },
    innerWidth: 800,
    innerHeight: 600,
    location: { href: 'file:///app/index.html', search: '' },
    addEventListener: jest.fn(),
  };
  global.document = document;

  jest.doMock('./debug.js', () => ({ pushDebug: jest.fn() }));
  jest.doMock('./menus.js', () => ({ closeMenus: jest.fn() }));
  jest.doMock('./bookmarks-ui.js', () => ({ hideBookmarkContextMenu: jest.fn() }));
  jest.doMock('./menu-backdrop.js', () => ({
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  }));
  jest.doMock('./page-context-menu.js', () => ({
    setupWebviewContextMenu: jest.fn(),
    notifyPageContextMenuNavigated: jest.fn(),
  }));
  jest.doMock('./link-status.js', () => ({
    clearLinkStatus: jest.fn(),
    clearHoverStatus: jest.fn(),
    showLinkStatus: jest.fn(),
    setLinkStatusSide: jest.fn(),
  }));
  jest.doMock('./page-urls.js', () => ({
    homeUrl: HOME_URL,
    getOnchainInterstitialTarget: () => null,
    internalPages: {},
    getInternalPageName: () => null,
    isNewTabPageUrl: (url) => url === HOME_URL || url === 'freedom://private',
    isNewTabPageName: (pageName) => pageName === 'home' || pageName === 'private',
    // Mirrors `page-urls.js#isHomePageUrl`: anchored to the home page's own
    // resolved URL, never an `/pages/home.html` suffix (#376).
    isHomePageUrl: (url) =>
      typeof url === 'string' &&
      (url === HOME_URL || url.startsWith(`${HOME_URL}?`) || url.startsWith(`${HOME_URL}#`)),
  }));

  const tabs = await import('./tabs.js');
  const onWebviewEvent = jest.fn();
  tabs.setWebviewEventHandler(onWebviewEvent);
  await tabs.initTabs();
  await flushMicrotasks();

  return { tabs, onWebviewEvent, webview: createdWebviews[0], createdWebviews };
};

// Only the favicon forwards matter here; the harness's other lifecycle events
// (did-navigate, did-stop-loading…) go through the same handler.
const faviconForwards = (onWebviewEvent) =>
  onWebviewEvent.mock.calls.filter(([name]) => name === 'page-favicon-updated');

describe('tabs page-favicon-updated handling (#75)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('an external page forwards the reported icon URL for fetching', async () => {
    const ctx = await loadTabs();
    ctx.webview.src = EXTERNAL_PAGE;

    ctx.webview.dispatch('page-favicon-updated', {
      favicons: [`${EXTERNAL_PAGE}/icon.png`, 'https://shop.example/apple-touch-icon.png'],
    });

    expect(faviconForwards(ctx.onWebviewEvent)).toEqual([
      [
        'page-favicon-updated',
        {
          tabId: ctx.tabs.getActiveTab().id,
          pageUrl: EXTERNAL_PAGE,
          // The first reported candidate, as Chromium orders them.
          iconUrl: `${EXTERNAL_PAGE}/icon.png`,
        },
      ],
    ]);
    // The remote URL is never painted into the strip directly: the strip
    // shows the per-domain cached copy main fetches and stores, so a chrome
    // <img> never dials the site itself.
    expect(ctx.tabs.getActiveTab().favicon).toBeFalsy();
  });

  test('an internal page paints its own icon and forwards nothing', async () => {
    const ctx = await loadTabs();
    ctx.webview.src = INTERNAL_PAGE;

    ctx.webview.dispatch('page-favicon-updated', {
      favicons: ['file:///app/pages/icons/history.png'],
    });

    expect(ctx.tabs.getActiveTab().favicon).toBe('file:///app/pages/icons/history.png');
    expect(faviconForwards(ctx.onWebviewEvent)).toHaveLength(0);
  });

  test('a non-foreground tab forwards its report, tagged with its own tab id', async () => {
    const ctx = await loadTabs();
    // A second tab opened in the background (#303). Its report is forwarded
    // too: Chromium emits `page-favicon-updated` *after* did-stop-loading,
    // so the tab that just finished loading may no longer be the foreground
    // one by the time the icon is reported, and dropping it here would leave
    // that visit with no icon fetched at all (#376). Which tab it belongs to
    // travels with the event; navigation.js pairs it against the load half
    // recorded for *that* tab, so a tab that recorded none fetches nothing.
    ctx.tabs.createTab(EXTERNAL_PAGE, { background: true });
    await flushMicrotasks();
    const background = ctx.createdWebviews[ctx.createdWebviews.length - 1];
    background.src = EXTERNAL_PAGE;
    const backgroundTabId = ctx.tabs.getTabs().find((t) => t.id !== ctx.tabs.getActiveTab().id).id;

    background.dispatch('page-favicon-updated', { favicons: [`${EXTERNAL_PAGE}/icon.png`] });

    expect(faviconForwards(ctx.onWebviewEvent)).toEqual([
      [
        'page-favicon-updated',
        {
          tabId: backgroundTabId,
          pageUrl: EXTERNAL_PAGE,
          iconUrl: `${EXTERNAL_PAGE}/icon.png`,
        },
      ],
    ]);
    // Still never painted directly — the strip shows the cached copy.
    expect(ctx.tabs.getTabById(backgroundTabId).favicon).toBeFalsy();
  });

  // The internal/external split is anchored to the shell's own resolved
  // `pages/` base, not an `/pages/` substring: a remote site is free to
  // serve one. Taking the internal branch would paint the site's own icon
  // URL into the strip, so the chrome renderer dials it directly and the
  // per-domain cached copy main fetches is bypassed — in a private window
  // too, which is supposed to make no favicon network request at all (#376).
  test('an external page whose path contains /pages/ is not treated as internal', async () => {
    const ctx = await loadTabs();
    const lookalike = 'https://example.com/pages/about.html';
    ctx.webview.src = lookalike;

    ctx.webview.dispatch('page-favicon-updated', {
      favicons: ['https://example.com/track.png'],
    });

    expect(ctx.tabs.getActiveTab().favicon).toBeFalsy();
    expect(faviconForwards(ctx.onWebviewEvent)).toEqual([
      [
        'page-favicon-updated',
        {
          tabId: ctx.tabs.getActiveTab().id,
          pageUrl: lookalike,
          iconUrl: 'https://example.com/track.png',
        },
      ],
    ]);
  });

  // Sibling of the same split, one function away: `updateTabFavicon` paints
  // the per-domain cached copy, and with an `/pages/` substring test it
  // blanked the strip for exactly the pages the handler above just routed
  // into the fetch-and-cache path — so the lookalike ended up with no icon
  // at all instead of the cached one (seen in the real app, #376).
  test('the cached copy is painted for an external path containing /pages/', async () => {
    const ctx = await loadTabs();
    global.window.electronAPI.getCachedFavicon.mockResolvedValue('data:image/png;base64,CACHED');

    await ctx.tabs.updateTabFavicon(
      ctx.tabs.getActiveTab().id,
      'https://example.com/pages/about.html'
    );

    expect(ctx.tabs.getActiveTab().favicon).toBe('data:image/png;base64,CACHED');
  });

  test('an internal page URL still blanks the strip instead of reading the cache', async () => {
    const ctx = await loadTabs();
    global.window.electronAPI.getCachedFavicon.mockResolvedValue('data:image/png;base64,CACHED');

    await ctx.tabs.updateTabFavicon(ctx.tabs.getActiveTab().id, INTERNAL_PAGE);

    expect(ctx.tabs.getActiveTab().favicon).toBeNull();
    expect(global.window.electronAPI.getCachedFavicon).not.toHaveBeenCalled();
  });

  test('an event with no favicons forwards nothing', async () => {
    const ctx = await loadTabs();
    ctx.webview.src = EXTERNAL_PAGE;

    ctx.webview.dispatch('page-favicon-updated', { favicons: [] });

    expect(faviconForwards(ctx.onWebviewEvent)).toHaveLength(0);
  });
});
