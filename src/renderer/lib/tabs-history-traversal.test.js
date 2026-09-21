// The back/forward traversal mark, driven end-to-end through the real
// `tabs.js` + `history-traversal.js` pair on the fake-DOM harness (same shape
// as `tabs-find-nav.test.js`), rather than by calling either module's hooks
// directly. What matters here is which *dispatched webview event* produces the
// `history-traversal-committed` report navigation.js re-verifies ENS trust on
// (#86), so the events are dispatched on the guest exactly as Chromium fires
// them.
//
// Two halves are pinned:
//   * only a commit that a traversal asked for is reported — a link click or
//     an address-bar load committing on the same guest is not;
//   * the mark is consumed by the first commit that follows, so a traversal
//     that never commits cannot make a later, unrelated navigation look like
//     one.

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const HOME_URL = 'freedom://home';
const ENS_URL = 'bzz://vitalik.eth/';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createWebview = (createdWebviews) => {
  const webview = createElement('webview');
  webview.getURL = jest.fn(() => webview.src || 'about:blank');
  webview.canGoBack = jest.fn(() => true);
  webview.canGoForward = jest.fn(() => true);
  webview.goBack = jest.fn();
  webview.goForward = jest.fn();
  webview.focus = jest.fn();
  createdWebviews.push(webview);
  return webview;
};

const loadModules = async () => {
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
    isNewTabPageUrl: (url) => url === HOME_URL || url === 'freedom://private',
    isNewTabPageName: (pageName) => pageName === 'home' || pageName === 'private',
    isHomePageUrl: (url) =>
      typeof url === 'string' &&
      (url === HOME_URL || url.startsWith(`${HOME_URL}?`) || url.startsWith(`${HOME_URL}#`)),
  }));

  const tabs = await import('./tabs.js');
  const traversal = await import('./history-traversal.js');
  const events = [];
  tabs.setWebviewEventHandler((name, data) => {
    events.push({ name, data });
  });
  await tabs.initTabs();

  const traversalReports = () => events.filter((e) => e.name === 'history-traversal-committed');

  return { tabs, traversal, events, traversalReports, webview: createdWebviews[0] };
};

describe('back/forward traversal marking (tabs.js + history-traversal.js)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a commit produced by Back is reported as a traversal', async () => {
    const ctx = await loadModules();

    expect(ctx.traversal.goBackInHistory(ctx.webview)).toBe(true);
    expect(ctx.webview.goBack).toHaveBeenCalledTimes(1);

    ctx.webview.dispatch('did-navigate', { url: ENS_URL });
    await flushMicrotasks();

    expect(ctx.traversalReports()).toHaveLength(1);
    expect(ctx.traversalReports()[0].data.tabId).toBe(ctx.tabs.getTabs()[0].id);
  });

  test('a commit produced by Forward is reported as a traversal', async () => {
    const ctx = await loadModules();

    expect(ctx.traversal.goForwardInHistory(ctx.webview)).toBe(true);
    expect(ctx.webview.goForward).toHaveBeenCalledTimes(1);

    ctx.webview.dispatch('did-navigate', { url: ENS_URL });

    expect(ctx.traversalReports()).toHaveLength(1);
  });

  test('an ordinary commit is not reported as a traversal', async () => {
    // The control: without this, every test above would pass with the mark
    // ignored and every commit reported.
    const ctx = await loadModules();

    ctx.webview.dispatch('did-navigate', { url: ENS_URL });

    expect(ctx.traversalReports()).toHaveLength(0);
  });

  test('the mark is consumed by the first commit and no later one', async () => {
    // A traversal that never commits (a restored entry that turns out to be
    // a download, a stop() mid-flight) must not leave its mark standing for
    // the *next*, unrelated navigation to be taken for a traversal.
    const ctx = await loadModules();

    ctx.traversal.goBackInHistory(ctx.webview);
    ctx.webview.dispatch('did-navigate', { url: ENS_URL });
    ctx.webview.dispatch('did-navigate', { url: 'https://example.com/' });

    expect(ctx.traversalReports()).toHaveLength(1);
  });

  test('a same-document traversal reports through did-navigate-in-page', async () => {
    const ctx = await loadModules();

    ctx.traversal.goBackInHistory(ctx.webview);
    ctx.webview.dispatch('did-navigate-in-page', { url: `${ENS_URL}#section`, isMainFrame: true });

    expect(ctx.traversalReports()).toHaveLength(1);

    // ...and is consumed there too, so the following cross-document commit
    // is not a second report.
    ctx.webview.dispatch('did-navigate', { url: 'https://example.com/' });
    expect(ctx.traversalReports()).toHaveLength(1);
  });

  test('a guest that cannot go back is neither traversed nor marked', async () => {
    const ctx = await loadModules();
    ctx.webview.canGoBack.mockReturnValue(false);

    expect(ctx.traversal.goBackInHistory(ctx.webview)).toBe(false);
    expect(ctx.webview.goBack).not.toHaveBeenCalled();

    ctx.webview.dispatch('did-navigate', { url: ENS_URL });
    expect(ctx.traversalReports()).toHaveLength(0);
  });

  test('a background tab traversal is still reported', async () => {
    // tabs.js forwards `did-navigate` to navigation.js for the active tab
    // only. The traversal report is deliberately not gated that way: a user
    // who switches tabs between pressing Back and the commit landing must
    // still get fresh trust metadata for the restored entry.
    const ctx = await loadModules();
    const firstTabId = ctx.tabs.getTabs()[0].id;
    const backgroundTab = ctx.tabs.createTab('https://background.example');
    await flushMicrotasks();
    ctx.tabs.switchTab(firstTabId);

    ctx.traversal.goBackInHistory(backgroundTab.webview);
    backgroundTab.webview.dispatch('did-navigate', { url: ENS_URL });

    expect(ctx.traversalReports()).toHaveLength(1);
    expect(ctx.traversalReports()[0].data.tabId).toBe(backgroundTab.id);
    // The regular did-navigate forward stayed active-tab-only.
    expect(ctx.events.filter((e) => e.name === 'did-navigate')).toHaveLength(0);
  });
});
