// The trust panel's content label on the chrome's side (freedom-core design
// 0009, Labels), through the real `tabs.js` on the fake-DOM harness (same
// shape as `tabs-history-traversal.test.js`): a committed dweb navigation
// asks main for its label once, a same-document navigation keeps it, and an
// answer that lands after the tab moved on is dropped.

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const HOME_URL = 'freedom://home';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createWebview = (createdWebviews) => {
  const webview = createElement('webview');
  const webContentsId = createdWebviews.length + 42;
  webview.getWebContentsId = () => webContentsId;
  webview.getURL = jest.fn(() => webview.currentUrl || webview.src || 'about:blank');
  webview.canGoBack = jest.fn(() => true);
  webview.canGoForward = jest.fn(() => true);
  webview.goBack = jest.fn();
  webview.goForward = jest.fn();
  webview.focus = jest.fn();
  createdWebviews.push(webview);
  return webview;
};

const loadModules = async (answer = async () => null) => {
  jest.resetModules();

  const createdWebviews = [];
  const navigateToUrlListeners = [];
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
      onNavigateToUrl: (cb) => {
        navigateToUrlListeners.push(cb);
      },
      getOnchainAppProvenance: jest.fn().mockResolvedValue(null),
      getDwebContentTrust: jest.fn((id, url) => answer(id, url)),
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
    isNewTabPageUrl: (url) => url === HOME_URL || url === 'freedom://private',
    isNewTabPageName: (pageName) => pageName === 'home' || pageName === 'private',
    isHomePageUrl: (url) =>
      typeof url === 'string' &&
      (url === HOME_URL || url.startsWith(`${HOME_URL}?`) || url.startsWith(`${HOME_URL}#`)),
  }));

  const tabs = await import('./tabs.js');
  const changes = [];
  tabs.setOnchainProvenanceChangeHandler((tabId) => changes.push(tabId));
  await tabs.initTabs();
  return {
    tabs,
    changes,
    webview: createdWebviews[0],
    electronAPI: global.window.electronAPI,
    tab: () => tabs.getActiveTab(),
  };
};

const HASH = 'ab'.repeat(32);
const PAGE = `bzz://${HASH}/index.html`;

describe('the dweb content label of a tab (tabs.js)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a committed dweb navigation asks main once, for the committed URL', async () => {
    const ctx = await loadModules(async () => 'unverified');
    // The page has already replaced its URL by the time the chrome hears of
    // the commit: the committed one is asked for.
    ctx.webview.currentUrl = `bzz://${HASH}/replaced`;
    ctx.webview.dispatch('did-navigate', { url: PAGE });
    await flushMicrotasks();

    expect(ctx.electronAPI.getDwebContentTrust).toHaveBeenCalledTimes(1);
    expect(ctx.electronAPI.getDwebContentTrust).toHaveBeenCalledWith(42, PAGE);
    expect(ctx.tab().dwebContentTrust).toEqual({ url: PAGE, content: 'unverified' });
    expect(ctx.changes).toContain(ctx.tab().id);
  });

  test('a same-document navigation keeps the label; the next commit clears it', async () => {
    const ctx = await loadModules(async () => 'verified');
    ctx.webview.dispatch('did-navigate', { url: PAGE });
    await flushMicrotasks();
    expect(ctx.tab().dwebContentTrust).toEqual({ url: PAGE, content: 'verified' });

    ctx.webview.dispatch('did-navigate-in-page', { url: `bzz://${HASH}/#/route`, isMainFrame: true });
    await flushMicrotasks();
    expect(ctx.tab().dwebContentTrust).toEqual({ url: PAGE, content: 'verified' });
    expect(ctx.electronAPI.getDwebContentTrust).toHaveBeenCalledTimes(1);

    ctx.webview.dispatch('did-navigate', { url: 'https://example.com/' });
    await flushMicrotasks();
    expect(ctx.tab().dwebContentTrust).toBeNull();
    expect(ctx.electronAPI.getDwebContentTrust).toHaveBeenCalledTimes(1);
  });

  test('no label from main leaves none', async () => {
    const ctx = await loadModules(async () => null);
    ctx.webview.dispatch('did-navigate', { url: PAGE });
    await flushMicrotasks();
    expect(ctx.tab().dwebContentTrust).toBeNull();
  });

  test('an answer that lands after the tab moved on is dropped', async () => {
    const pending = [];
    const ctx = await loadModules(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        })
    );
    ctx.webview.dispatch('did-navigate', { url: PAGE });
    ctx.webview.dispatch('did-navigate', { url: `ipfs://${'b'.repeat(59)}/` });
    // The first page's answer arrives last-but-one: it no longer applies.
    pending[0]('verified');
    await flushMicrotasks();
    expect(ctx.tab().dwebContentTrust).toBeNull();
    pending[1]('node_asserted');
    await flushMicrotasks();
    expect(ctx.tab().dwebContentTrust).toEqual({
      url: `ipfs://${'b'.repeat(59)}/`,
      content: 'node_asserted',
    });
  });

  test('a view-source page gets no label', async () => {
    const ctx = await loadModules(async () => 'verified');
    ctx.webview.currentUrl = `view-source:${PAGE}`;
    ctx.webview.dispatch('did-navigate', { url: PAGE });
    await flushMicrotasks();
    expect(ctx.electronAPI.getDwebContentTrust).not.toHaveBeenCalled();
    expect(ctx.tab().dwebContentTrust).toBeNull();
  });
});
