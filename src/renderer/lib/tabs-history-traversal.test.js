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
//   * the mark is consumed by the first *cross-document* commit that follows,
//     so a traversal that never commits cannot make a later, unrelated
//     navigation look like one — while a same-document commit, which is how
//     Chromium reports a page's own `pushState`/`replaceState` (in the main
//     frame as much as in an iframe), can neither report nor eat the mark out
//     from under a traversal still in flight.

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
  // The main process `preventDefault()`s a page-driven navigation to a custom
  // protocol and replays it through this IPC, which is how such a navigation
  // reaches `loadTarget` at all.
  const replayNavigateToUrl = (url) => navigateToUrlListeners.forEach((cb) => cb(url));

  return {
    tabs,
    traversal,
    events,
    traversalReports,
    replayNavigateToUrl,
    webview: createdWebviews[0],
  };
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

  test('a page-driven dweb navigation is routed to loadTarget, which clears the mark', async () => {
    // What bounds the mark a *same-document* traversal leaves standing (no
    // same-document commit is allowed to consume it — see the
    // `did-navigate-in-page` handler). The dangerous shape would be a
    // navigation the page starts, which never calls `loadTarget` itself: but
    // every page-driven hop to a scheme the refresh can act on
    // (`bzz:`/`ipfs:`/`ipns:`) is `preventDefault()`ed in the main process
    // and replayed through `navigate-to-url`, and *that* lands in
    // `loadTarget`. This test pins the replay hop; that `loadTarget` then
    // drops the mark is pinned on the real function in navigation.test.js
    // ("a navigation the user asks for drops a still-pending traversal
    // mark"). A page-driven hop to http(s) is not replayed and does consume
    // a standing mark — harmlessly, since `parseEnsInput` declines its
    // committed URL and the refresh returns having done nothing.
    const ctx = await loadModules();
    jest.useFakeTimers();
    try {
      const loadTargets = [];
      ctx.tabs.setLoadTargetHandler((url) => loadTargets.push(url));

      ctx.traversal.goBackInHistory(ctx.webview);
      ctx.replayNavigateToUrl(ENS_URL);

      expect(loadTargets).toEqual([ENS_URL]);
    } finally {
      // The replay arms the phantom-abort suppression timers; run them out so
      // they don't outlive the test.
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    }
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

  test('a commit onto about:blank is not reported, but still consumes the mark', async () => {
    // `did-navigate` deliberately skips the `committedDisplayUrl` write for
    // `about:blank` (Chromium fires one through it during "open in new
    // window", and clobbering the commit there would lose the real page
    // identity). The refresh keys on `committedDisplayUrl`, so reporting such
    // a commit would hand it the entry the traversal just *left*: a Forward
    // onto an `about:blank` entry re-resolved the outgoing ENS name and
    // raised *its* interstitial over the restored entry, forward history
    // gone.
    const ctx = await loadModules();
    const navState = ctx.tabs.getTabs()[0].navigationState;
    navState.committedDisplayUrl = ENS_URL;
    const sequenceBefore = navState.committedNavigationSequence;

    ctx.traversal.goForwardInHistory(ctx.webview);
    ctx.webview.dispatch('did-navigate', { url: 'about:blank' });

    expect(ctx.traversalReports()).toHaveLength(0);
    // The skipped identity write is what makes the report wrong — pinned here
    // so the two can't drift apart. The sequence counter is *not* skipped with
    // it: it is what a refresh already in flight for the outgoing entry
    // compares against to find out the tab has moved on, so an about:blank
    // commit has to bump it like any other.
    expect(navState.committedDisplayUrl).toBe(ENS_URL);
    expect(navState.committedNavigationSequence).toBe(sequenceBefore + 1);

    // The mark is still consumed, exactly as any other cross-document commit
    // consumes it: the next, unrelated navigation is not a traversal.
    ctx.webview.dispatch('did-navigate', { url: 'https://example.com/' });
    expect(ctx.traversalReports()).toHaveLength(0);
  });

  test('an in-page commit neither reports nor consumes the mark, in any frame', async () => {
    // Chromium reports a page's own History API call through the same
    // `did-navigate-in-page` event as a same-document traversal, with nothing
    // on it or on its preceding `did-start-navigation` to separate the two.
    // So the page being *left* — its main document on a `replaceState` timer,
    // or an embedded widget/ad frame rewriting its own URL — must not be
    // taken for the commit the traversal asked for, and must not consume the
    // mark: doing so left the restored entry unverified (its trust badge
    // stuck on the method configured when it first loaded), or ran the
    // refresh against the outgoing page and raised *its* interstitial over
    // the traversal the user had just asked for.
    for (const frame of [
      { isMainFrame: true, url: 'ipfs://qmspahost/p?n=1' },
      { isMainFrame: false, url: 'https://widget.example/embed?r=2' },
      // Chromium omitting the flag must not read as "report it anyway".
      { url: 'ipfs://qmspahost/p?n=2' },
    ]) {
      const ctx = await loadModules();

      ctx.traversal.goBackInHistory(ctx.webview);
      // A whole burst of them, as a 20ms timer produces while a traversal to
      // a page that takes a moment to commit is still in flight.
      for (let i = 0; i < 5; i += 1) ctx.webview.dispatch('did-navigate-in-page', frame);

      expect(ctx.traversalReports()).toHaveLength(0);

      // The mark survived, so the cross-document commit the traversal
      // actually produces still reports — exactly once.
      ctx.webview.dispatch('did-navigate', { url: ENS_URL });
      expect(ctx.traversalReports()).toHaveLength(1);
      expect(ctx.traversalReports()[0].data.previousUrl).toBe(HOME_URL);
    }
  });

  test('an in-page commit outside a traversal is still not a traversal', async () => {
    // The control for the pair above: with no mark pending, a same-document
    // commit reports nothing either, so nothing about this path can start
    // looking like a traversal on its own.
    const ctx = await loadModules();

    ctx.webview.dispatch('did-navigate-in-page', { url: `${ENS_URL}#section`, isMainFrame: true });

    expect(ctx.traversalReports()).toHaveLength(0);
  });

  test('clearHistoryTraversal drops a mark no commit will consume', async () => {
    // A traversal superseded by a navigation the user asked for, and the
    // subframe-only restored entry (Chromium navigates that frame alone, so
    // no main-frame commit ever follows) both leave a mark standing. Every
    // shell-initiated navigation clears it, so it cannot attach itself to
    // some later, unrelated commit.
    const ctx = await loadModules();

    ctx.traversal.goBackInHistory(ctx.webview);
    ctx.traversal.clearHistoryTraversal(ctx.webview);

    ctx.webview.dispatch('did-navigate', { url: ENS_URL });
    expect(ctx.traversalReports()).toHaveLength(0);
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
