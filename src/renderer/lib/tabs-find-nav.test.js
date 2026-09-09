// The `did-start-navigation` filter tabs.js puts in front of the find bar's
// navigation hooks. Only a main-frame, cross-document start may re-record
// Chrome's "was the bar visible when this navigation started?" flag; a
// subframe load or a same-document (in-place) navigation must not touch it.
//
// Both halves of that filter are one `if` in a handler that has no return
// value and no other visible effect, so nothing else in the suite pins them:
// dropping `event.isInPlace` (a deprecated name in Electron's typings) or
// `event.isMainFrame` stays green everywhere else. What it costs is the
// bar the user opened *during* a load: the flag says "keep it open at
// commit", and any iframe or hash navigation that starts before the commit
// silently rewrites it to "close".
//
// Driven through the real tabs.js + find-bar.js pair on the fake-DOM
// harness (same shape as tabs-ui.test.js), so what is asserted is the bar a
// user would see, not a spy call count.

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const HOME_URL = 'freedom://home';
const PAGE_URL = 'https://example.com/page';

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
  webview.findInPage = jest.fn();
  webview.stopFindInPage = jest.fn();
  createdWebviews.push(webview);
  return webview;
};

const loadModules = async () => {
  jest.resetModules();

  const createdWebviews = [];
  const findBarEl = createElement('div');
  findBarEl.hidden = true;
  const findInput = createElement('input');
  findInput.focus = jest.fn();
  findInput.select = jest.fn();
  const findCount = createElement('span');

  const document = createDocument({
    elementsById: {
      'tab-bar': createElement('div'),
      'new-tab-btn': createElement('button'),
      'webview-container': createElement('div'),
      'tab-context-menu': createElement('div'),
      'bzz-webview': createElement('webview'),
      'address-input': createElement('input'),
      'find-bar': findBarEl,
      'find-bar-input': findInput,
      'find-bar-count': findCount,
      'find-bar-prev': createElement('button'),
      'find-bar-next': createElement('button'),
      'find-bar-close': createElement('button'),
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
  jest.doMock('./page-context-menu.js', () => ({ setupWebviewContextMenu: jest.fn() }));
  jest.doMock('./link-status.js', () => ({
    clearLinkStatus: jest.fn(),
    clearHoverStatus: jest.fn(),
    showLinkStatus: jest.fn(),
    setLinkStatusSide: jest.fn(),
  }));
  jest.doMock('./page-urls.js', () => ({
    homeUrl: HOME_URL,
    getOnchainInterstitialTarget: () => null,
    // Mirrors `page-urls.js#isNewTabPageUrl` for this window's new-tab page,
    // which `switchTab` consults to decide whether the page or the address bar
    // gets the keyboard (#304).
    isNewTabPageUrl: (url) => url === HOME_URL || url === 'freedom://private',
  }));

  const tabs = await import('./tabs.js');
  const findBar = await import('./find-bar.js');
  await tabs.initTabs();
  findBar.initFindBar({ getActiveWebview: () => tabs.getActiveWebview() });

  return { tabs, findBar, findInput, findCount, webview: createdWebviews[0] };
};

// Start a main-frame, cross-document navigation with the bar still closed,
// then open the bar while it is in flight — Chrome's "the user asked to
// search the incoming page" case, where the bar must survive the commit.
const startNavigationThenOpenBar = async (ctx) => {
  ctx.webview.dispatch('did-start-navigation', {
    url: PAGE_URL,
    isMainFrame: true,
    isInPlace: false,
  });
  ctx.findBar.openFindBar();
  await flushMicrotasks();
  expect(ctx.findBar.isFindBarOpen()).toBe(true);
};

describe('tabs did-start-navigation → find bar filter', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a subframe navigation start does not re-record the close flag', async () => {
    const ctx = await loadModules();
    await startNavigationThenOpenBar(ctx);

    // An iframe on the loading page starts navigating. Its start says
    // nothing about the main frame's find session.
    ctx.webview.dispatch('did-start-navigation', {
      url: 'https://ads.example/frame',
      isMainFrame: false,
      isInPlace: false,
    });
    ctx.webview.dispatch('did-navigate', { url: PAGE_URL });

    expect(ctx.findBar.isFindBarOpen()).toBe(true);
  });

  test('a same-document navigation start does not re-record the close flag', async () => {
    const ctx = await loadModules();
    await startNavigationThenOpenBar(ctx);

    // A fragment jump inside the document still on screen: same document,
    // so Chrome's find bar ignores it entirely.
    ctx.webview.dispatch('did-start-navigation', {
      url: `${PAGE_URL}#section`,
      isMainFrame: true,
      isInPlace: true,
    });
    ctx.webview.dispatch('did-navigate', { url: PAGE_URL });

    expect(ctx.findBar.isFindBarOpen()).toBe(true);
  });

  test('a main-frame cross-document start still closes the bar at commit', async () => {
    // The control for both cases above: the filter must let the real thing
    // through, or they would pass with the hooks never wired up at all.
    const ctx = await loadModules();
    ctx.findBar.openFindBar();
    await flushMicrotasks();
    expect(ctx.findBar.isFindBarOpen()).toBe(true);

    ctx.webview.dispatch('did-start-navigation', {
      url: PAGE_URL,
      isMainFrame: true,
      isInPlace: false,
    });
    ctx.webview.dispatch('did-navigate', { url: PAGE_URL });

    expect(ctx.findBar.isFindBarOpen()).toBe(false);
  });
});
