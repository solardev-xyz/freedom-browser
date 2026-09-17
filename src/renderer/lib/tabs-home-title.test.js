// The "this tab is on the new-tab page" title treatment in tabs.js: a commit
// on the home page relabels the tab "New Tab" and blanks the window title,
// and the page's own <title> never overrides it.
//
// Both halves used to key on `url.endsWith('/pages/home.html')`, which any
// external site satisfies by serving that path — so navigating to
// `https://example.com/pages/home.html` relabelled the tab "New Tab" and
// blanked the window title over the site's own content (#376). The check is
// now anchored to the shell's resolved home URL (`page-urls.js#isHomePageUrl`),
// the same discipline as `matchesInternalPage` (#235).
//
// Driven through the real tabs.js on the fake-DOM harness (same shape as
// tabs-favicon.test.js), dispatching the events on the webview element the
// module created, so what is asserted is the title a user would see.

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

// The production shape: a resolved `file://` URL under the shell's own
// `pages/` directory, not the friendly `freedom://home` form.
const HOME_URL = 'file:///app/pages/home.html';
const EXTERNAL_PAGE = 'https://shop.example/items/42';
// A remote page whose path merely ends in the home page's file name.
const HOME_LOOKALIKE = 'https://example.com/pages/home.html';

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
  await tabs.initTabs();
  await flushMicrotasks();

  return { tabs, webview: createdWebviews[0], electronAPI: global.window.electronAPI };
};

// Commit a cross-document main-frame navigation on the tab's webview.
const commitNavigation = (ctx, url) => {
  ctx.webview.src = url;
  ctx.webview.dispatch('did-navigate', { url });
};

describe('tabs home-page title treatment (#376)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('committing the real home page relabels the tab "New Tab"', async () => {
    const ctx = await loadTabs();
    // Somewhere else first, so the tab carries a real page title to reset.
    commitNavigation(ctx, EXTERNAL_PAGE);
    ctx.webview.dispatch('page-title-updated', { title: 'Item 42 — Shop' });
    expect(ctx.tabs.getActiveTab().title).toBe('Item 42 — Shop');

    // Back button home.
    commitNavigation(ctx, HOME_URL);

    expect(ctx.tabs.getActiveTab().title).toBe('New Tab');
    expect(ctx.electronAPI.setWindowTitle).toHaveBeenLastCalledWith('');
  });

  test('the home page\'s own <title> never overrides "New Tab"', async () => {
    const ctx = await loadTabs();
    commitNavigation(ctx, HOME_URL);

    ctx.webview.dispatch('page-title-updated', { title: 'Freedom' });

    expect(ctx.tabs.getActiveTab().title).toBe('New Tab');
    expect(ctx.electronAPI.setWindowTitle).toHaveBeenLastCalledWith('');
  });

  test('the home page with a fragment is still the home page', async () => {
    const ctx = await loadTabs();
    commitNavigation(ctx, EXTERNAL_PAGE);
    ctx.webview.dispatch('page-title-updated', { title: 'Item 42 — Shop' });

    commitNavigation(ctx, `${HOME_URL}#recent`);

    expect(ctx.tabs.getActiveTab().title).toBe('New Tab');
  });

  // The anchoring itself: a remote path that merely ends in the home page's
  // file name is content, not chrome. With the old suffix test it took the
  // new-tab-page branch, so the site's tab read "New Tab" and the window
  // title was blanked until the page's own `page-title-updated` repainted it.
  test('an external page whose path ends in /pages/home.html keeps its own title', async () => {
    const ctx = await loadTabs();
    commitNavigation(ctx, HOME_LOOKALIKE);

    // The commit clears the previous document's title (#236) — it must not
    // substitute the new-tab label.
    expect(ctx.tabs.getActiveTab().title).toBe('');

    ctx.webview.dispatch('page-title-updated', { title: 'Example Pages' });

    expect(ctx.tabs.getActiveTab().title).toBe('Example Pages');
    expect(ctx.electronAPI.setWindowTitle).toHaveBeenLastCalledWith('Example Pages');
  });
});
