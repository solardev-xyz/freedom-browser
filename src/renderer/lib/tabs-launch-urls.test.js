// A window opened for a launch given several links (#597) carries one
// `initialUrl` query parameter per link: the first takes the window's initial
// tab, each further one opens in a tab of its own. Driven through the real
// tabs.js on the fake-DOM harness (same shape as tabs-home-title.test.js).

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const HOME_URL = 'file:///app/pages/home.html';

const createWebview = (createdWebviews) => {
  const webview = createElement('webview');
  webview.getURL = jest.fn(() => webview.src || 'about:blank');
  webview.canGoBack = jest.fn(() => false);
  webview.canGoForward = jest.fn(() => false);
  webview.focus = jest.fn();
  createdWebviews.push(webview);
  return webview;
};

const loadTabs = async (search) => {
  jest.resetModules();

  const createdWebviews = [];
  const addressInput = createElement('input');
  const document = createDocument({
    elementsById: {
      'tab-bar': createElement('div'),
      'new-tab-btn': createElement('button'),
      'webview-container': createElement('div'),
      'tab-context-menu': createElement('div'),
      'bzz-webview': createElement('webview'),
      'address-input': addressInput,
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
    location: { href: `file:///app/index.html${search}`, search },
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
    isHomePageUrl: (url) => url === HOME_URL,
  }));

  const tabs = await import('./tabs.js');
  const loadTarget = jest.fn();
  tabs.setLoadTargetHandler(loadTarget);
  await tabs.initTabs();
  // The initial tab's target is dispatched after a short delay.
  await new Promise((resolve) => setTimeout(resolve, 80));

  return { tabs, loadTarget, createdWebviews, addressInput };
};

describe('initial URLs of a new window (#597)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('each initialUrl parameter opens in its own tab, the first in the initial tab', async () => {
    const search = `?${new URLSearchParams([
      ['initialUrl', 'bzz://ab12cd34/'],
      ['initialUrl', 'https://second.example/'],
    ])}`;
    const ctx = await loadTabs(search);

    const tabs = ctx.tabs.getTabs();
    expect(tabs).toHaveLength(2);
    // The first link is routed into the initial tab's own webview, not
    // whichever tab is active once the second one has opened.
    expect(ctx.loadTarget).toHaveBeenCalledWith('bzz://ab12cd34/', null, ctx.createdWebviews[0]);
    expect(tabs[1].url).toBe('https://second.example/');
    expect(ctx.addressInput.value).toBe('bzz://ab12cd34/');
  });

  test('a single initialUrl still opens just the one tab', async () => {
    const ctx = await loadTabs(`?initialUrl=${encodeURIComponent('https://only.example/')}`);

    expect(ctx.tabs.getTabs()).toHaveLength(1);
    expect(ctx.loadTarget).toHaveBeenCalledWith(
      'https://only.example/',
      null,
      ctx.createdWebviews[0]
    );
  });
});
