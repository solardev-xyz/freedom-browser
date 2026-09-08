const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// A promise whose resolution the test controls, for holding a prefill's
// executeJavaScript in flight while the world changes around it.
const createDeferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const createFakeWebview = () => {
  const webview = createElement('webview');
  webview.findInPage = jest.fn();
  webview.stopFindInPage = jest.fn();
  webview.executeJavaScript = jest.fn().mockResolvedValue('');
  webview.focus = jest.fn();
  return webview;
};

const loadFindBarModule = async ({ webview = createFakeWebview(), initOptions } = {}) => {
  jest.resetModules();

  const findBar = createElement('div');
  findBar.hidden = true;
  const input = createElement('input');
  input.focus = jest.fn();
  input.select = jest.fn();
  const count = createElement('span');
  const prevBtn = createElement('button');
  const nextBtn = createElement('button');
  const closeBtn = createElement('button');

  global.document = createDocument({
    elementsById: {
      'find-bar': findBar,
      'find-bar-input': input,
      'find-bar-count': count,
      'find-bar-prev': prevBtn,
      'find-bar-next': nextBtn,
      'find-bar-close': closeBtn,
    },
  });

  const windowHandlers = {};
  const electronHandlers = {};
  global.window = {
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
    electronAPI: {
      onOpenFindBar: jest.fn((callback) => {
        electronHandlers.openFindBar = callback;
      }),
    },
  };

  // Pin the shortcut matcher to macOS semantics (the Cmd-based events these
  // tests dispatch) so assertions don't depend on the host platform.
  const shortcuts = await import('./shortcuts.js');
  shortcuts.configureShortcuts({ platform: 'darwin', overrides: {} });

  const mod = await import('./find-bar.js');
  mod.initFindBar(initOptions ?? { getActiveWebview: () => webview });

  return {
    mod,
    webview,
    findBar,
    input,
    count,
    prevBtn,
    nextBtn,
    closeBtn,
    windowHandlers,
    electronHandlers,
  };
};

// Type into the find input and let the find-as-you-type debounce fire.
const typeQuery = async (ctx, query) => {
  ctx.input.value = query;
  ctx.input.dispatch('input');
  const { FIND_DEBOUNCE_MS } = ctx.mod;
  jest.advanceTimersByTime(FIND_DEBOUNCE_MS);
  await flushMicrotasks();
};

const emitFoundInPage = (ctx, result) => {
  ctx.webview.dispatch('found-in-page', { result });
};

describe('find-bar', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
  });

  test('openFindBar shows the bar, focuses and selects the input', async () => {
    const ctx = await loadFindBarModule();

    expect(ctx.mod.isFindBarOpen()).toBe(false);
    ctx.mod.openFindBar();
    await flushMicrotasks();

    expect(ctx.mod.isFindBarOpen()).toBe(true);
    expect(ctx.findBar.hidden).toBe(false);
    expect(ctx.input.focus).toHaveBeenCalled();
    expect(ctx.input.select).toHaveBeenCalled();
  });

  test('opens via the Cmd/Ctrl+F window fallback and the menu IPC hook', async () => {
    const ctx = await loadFindBarModule();

    const keydown = ctx.windowHandlers.keydown;
    const preventDefault = jest.fn();
    keydown({
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      key: 'f',
      preventDefault,
    });
    await flushMicrotasks();

    expect(preventDefault).toHaveBeenCalled();
    expect(ctx.mod.isFindBarOpen()).toBe(true);

    ctx.mod.closeFindBar();
    expect(ctx.mod.isFindBarOpen()).toBe(false);

    ctx.electronHandlers.openFindBar();
    await flushMicrotasks();
    expect(ctx.mod.isFindBarOpen()).toBe(true);
  });

  test('Cmd+Shift+F does not open the bar', async () => {
    const ctx = await loadFindBarModule();

    ctx.windowHandlers.keydown({
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      key: 'f',
      preventDefault: jest.fn(),
    });

    expect(ctx.mod.isFindBarOpen()).toBe(false);
  });

  test('typing runs a debounced findInPage against the active webview', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();

    ctx.input.value = 'need';
    ctx.input.dispatch('input');
    expect(ctx.webview.findInPage).not.toHaveBeenCalled();

    jest.advanceTimersByTime(ctx.mod.FIND_DEBOUNCE_MS);
    expect(ctx.webview.findInPage).toHaveBeenCalledTimes(1);
    expect(ctx.webview.findInPage).toHaveBeenCalledWith('need');
  });

  test('found-in-page results drive the "active/total" counter', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    emitFoundInPage(ctx, { activeMatchOrdinal: 3, matches: 17, finalUpdate: true });

    expect(ctx.count.textContent).toBe('3/17');
    expect(ctx.prevBtn.disabled).toBe(false);
    expect(ctx.nextBtn.disabled).toBe(false);
    expect(ctx.input.classList.contains('find-bar-input--no-matches')).toBe(false);
  });

  test('zero matches shows 0/0, tints the input, and disables prev/next', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'zzz-not-there');

    emitFoundInPage(ctx, { activeMatchOrdinal: 0, matches: 0, finalUpdate: true });

    expect(ctx.count.textContent).toBe('0/0');
    expect(ctx.input.classList.contains('find-bar-input--no-matches')).toBe(true);
    expect(ctx.prevBtn.disabled).toBe(true);
    expect(ctx.nextBtn.disabled).toBe(true);
  });

  test('Enter advances forward, Shift+Enter goes backward', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    ctx.webview.findInPage.mockClear();

    ctx.input.dispatch('keydown', { key: 'Enter', shiftKey: false, preventDefault: jest.fn() });
    expect(ctx.webview.findInPage).toHaveBeenLastCalledWith('needle', {
      forward: true,
      findNext: true,
    });

    ctx.input.dispatch('keydown', { key: 'Enter', shiftKey: true, preventDefault: jest.fn() });
    expect(ctx.webview.findInPage).toHaveBeenLastCalledWith('needle', {
      forward: false,
      findNext: true,
    });
  });

  test('prev/next buttons advance the match', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    ctx.webview.findInPage.mockClear();

    ctx.nextBtn.dispatch('click');
    expect(ctx.webview.findInPage).toHaveBeenLastCalledWith('needle', {
      forward: true,
      findNext: true,
    });

    ctx.prevBtn.dispatch('click');
    expect(ctx.webview.findInPage).toHaveBeenLastCalledWith('needle', {
      forward: false,
      findNext: true,
    });
  });

  test('Escape closes the bar and clears highlights via stopFindInPage', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    const stopPropagation = jest.fn();
    ctx.input.dispatch('keydown', {
      key: 'Escape',
      preventDefault: jest.fn(),
      stopPropagation,
    });

    expect(stopPropagation).toHaveBeenCalled();
    expect(ctx.mod.isFindBarOpen()).toBe(false);
    expect(ctx.webview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(ctx.count.textContent).toBe('');
  });

  test('closing only ends the foreground tab session, never a background one', async () => {
    const firstWebview = createFakeWebview();
    const secondWebview = createFakeWebview();
    let active = firstWebview;
    const ctx = await loadFindBarModule({
      webview: firstWebview,
      initOptions: { getActiveWebview: () => active },
    });

    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    // Tab switch: the second tab has no find session of its own, so the bar
    // hides — and closing it there must not reach into the first tab's live
    // session (its highlights stay until the user goes back and closes it).
    active = secondWebview;
    ctx.mod.notifyFindBarTabSwitched();
    expect(ctx.mod.isFindBarOpen()).toBe(false);

    ctx.mod.closeFindBar();
    expect(firstWebview.stopFindInPage).not.toHaveBeenCalled();
    expect(secondWebview.stopFindInPage).not.toHaveBeenCalled();

    // Back on the searched tab: its own bar, query and count come back...
    active = firstWebview;
    ctx.mod.notifyFindBarTabSwitched();
    expect(ctx.mod.isFindBarOpen()).toBe(true);
    expect(ctx.input.value).toBe('needle');

    // ...and closing there is what finally clears its highlights.
    ctx.mod.closeFindBar();
    expect(firstWebview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(secondWebview.stopFindInPage).not.toHaveBeenCalled();
  });

  test('each tab keeps its own bar, query and match count across switches', async () => {
    const firstWebview = createFakeWebview();
    const secondWebview = createFakeWebview();
    let active = firstWebview;
    const ctx = await loadFindBarModule({
      webview: firstWebview,
      initOptions: { getActiveWebview: () => active },
    });

    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    firstWebview.dispatch('found-in-page', {
      result: { activeMatchOrdinal: 1, matches: 3, finalUpdate: true },
    });
    expect(ctx.count.textContent).toBe('1/3');

    // Second tab: its own query and its own count.
    active = secondWebview;
    ctx.mod.notifyFindBarTabSwitched();
    expect(ctx.mod.isFindBarOpen()).toBe(false);
    expect(ctx.count.textContent).toBe('');

    ctx.mod.openFindBar();
    await flushMicrotasks();
    expect(ctx.input.value).toBe('');
    await typeQuery(ctx, 'banana');
    expect(secondWebview.findInPage).toHaveBeenCalledWith('banana');
    secondWebview.dispatch('found-in-page', {
      result: { activeMatchOrdinal: 1, matches: 2, finalUpdate: true },
    });
    expect(ctx.count.textContent).toBe('1/2');

    // Switching back restores the first tab's state, not the second's.
    active = firstWebview;
    ctx.mod.notifyFindBarTabSwitched();
    expect(ctx.mod.isFindBarOpen()).toBe(true);
    expect(ctx.input.value).toBe('needle');
    expect(ctx.count.textContent).toBe('1/3');

    // Neither switch ended a session: both tabs keep their highlights.
    expect(firstWebview.stopFindInPage).not.toHaveBeenCalled();
    expect(secondWebview.stopFindInPage).not.toHaveBeenCalled();
  });

  test('a background tab result repaints only that tab, not the visible bar', async () => {
    const firstWebview = createFakeWebview();
    const secondWebview = createFakeWebview();
    let active = firstWebview;
    const ctx = await loadFindBarModule({
      webview: firstWebview,
      initOptions: { getActiveWebview: () => active },
    });

    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    active = secondWebview;
    ctx.mod.notifyFindBarTabSwitched();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'banana');
    secondWebview.dispatch('found-in-page', {
      result: { activeMatchOrdinal: 1, matches: 2, finalUpdate: true },
    });
    expect(ctx.count.textContent).toBe('1/2');

    // A late scoping update from the backgrounded tab must not repaint the
    // foreground tab's counter...
    firstWebview.dispatch('found-in-page', {
      result: { activeMatchOrdinal: 4, matches: 9, finalUpdate: true },
    });
    expect(ctx.count.textContent).toBe('1/2');

    // ...but it is remembered, and shown when that tab comes back.
    active = firstWebview;
    ctx.mod.notifyFindBarTabSwitched();
    expect(ctx.count.textContent).toBe('4/9');
  });

  test('closing a tab drops its find state without touching the dead webview', async () => {
    const firstWebview = createFakeWebview();
    const secondWebview = createFakeWebview();
    let active = firstWebview;
    const ctx = await loadFindBarModule({
      webview: firstWebview,
      initOptions: { getActiveWebview: () => active },
    });

    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    // tabs.js closes the tab: state goes with it, and stopFindInPage is not
    // called on a guest that is being torn down.
    ctx.mod.notifyFindBarTabClosed(firstWebview);
    expect(firstWebview.stopFindInPage).not.toHaveBeenCalled();
    expect(ctx.mod.isFindBarOpen()).toBe(false);

    // A late found-in-page from the dying guest cannot repaint the bar.
    firstWebview.dispatch('found-in-page', {
      result: { activeMatchOrdinal: 2, matches: 7, finalUpdate: true },
    });
    expect(ctx.count.textContent).toBe('');

    // The freed state must not be resurrected for the next tab either.
    active = secondWebview;
    ctx.mod.notifyFindBarTabSwitched();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    expect(ctx.input.value).toBe('');
  });

  test('closing while the searched tab is still active returns focus to the page', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    ctx.mod.closeFindBar();

    expect(ctx.webview.focus).toHaveBeenCalled();
  });

  test('closing within the debounce window cancels the queued find-as-you-type', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();

    // Type, then close before the debounce elapses.
    ctx.input.value = 'needle';
    ctx.input.dispatch('input');
    jest.advanceTimersByTime(ctx.mod.FIND_DEBOUNCE_MS - 1);
    ctx.input.dispatch('keydown', {
      key: 'Escape',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });

    jest.advanceTimersByTime(ctx.mod.FIND_DEBOUNCE_MS);
    await flushMicrotasks();

    // No orphaned session: nothing searched, nothing highlighted, and the
    // hidden counter stays blank instead of reporting matches nobody sees.
    expect(ctx.webview.findInPage).not.toHaveBeenCalled();
    expect(ctx.mod.isFindBarOpen()).toBe(false);
    expect(ctx.count.textContent).toBe('');

    // A late found-in-page (from a session that should not exist) must not
    // repaint the counter either — the listener is gone.
    emitFoundInPage(ctx, { activeMatchOrdinal: 1, matches: 3, finalUpdate: true });
    expect(ctx.count.textContent).toBe('');
  });

  test('switching tabs within the debounce window does not search the incoming tab', async () => {
    const firstWebview = createFakeWebview();
    const secondWebview = createFakeWebview();
    let active = firstWebview;
    const ctx = await loadFindBarModule({
      webview: firstWebview,
      initOptions: { getActiveWebview: () => active },
    });

    ctx.mod.openFindBar();
    await flushMicrotasks();
    ctx.input.value = 'needle';
    ctx.input.dispatch('input');

    // tabs.js flips the active tab, then closes the bar — both inside the
    // debounce window.
    active = secondWebview;
    ctx.mod.closeFindBar();

    jest.advanceTimersByTime(ctx.mod.FIND_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(firstWebview.findInPage).not.toHaveBeenCalled();
    expect(secondWebview.findInPage).not.toHaveBeenCalled();
  });

  test('a completed debounce still searches after a later close/reopen cycle', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    expect(ctx.webview.findInPage).toHaveBeenCalledWith('needle');

    ctx.mod.closeFindBar();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    ctx.webview.findInPage.mockClear();

    // Cancelling on close must not wedge the debounce for the next session.
    await typeQuery(ctx, 'haystack');
    expect(ctx.webview.findInPage).toHaveBeenCalledWith('haystack');
  });

  test('a navigation started with the bar open ends the session and closes the bar', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    emitFoundInPage(ctx, { activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    expect(ctx.count.textContent).toBe('2/5');

    // The start only records the bar's visibility — the session keeps
    // running, because this navigation may still be one that never commits.
    ctx.mod.notifyFindBarNavigationStarted(ctx.webview);
    expect(ctx.webview.stopFindInPage).not.toHaveBeenCalled();
    expect(ctx.count.textContent).toBe('2/5');

    // Chrome ends the session and hides the bar at commit, when it was
    // visible when the navigation started.
    ctx.mod.notifyFindBarNavigated(ctx.webview);
    expect(ctx.webview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(ctx.mod.isFindBarOpen()).toBe(false);
    expect(ctx.count.textContent).toBe('');

    // The query survives for the next open, the way Chrome prepopulates it.
    ctx.mod.openFindBar();
    await flushMicrotasks();
    expect(ctx.input.value).toBe('needle');
  });

  test('a navigation that reports no start still ends the session at commit', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    ctx.mod.notifyFindBarNavigated(ctx.webview);

    expect(ctx.webview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(ctx.mod.isFindBarOpen()).toBe(false);
  });

  test('a bar opened after the navigation started stays open, with no search re-run', async () => {
    const ctx = await loadFindBarModule();

    // Navigation starts while the bar is closed...
    ctx.mod.notifyFindBarNavigationStarted(ctx.webview);
    // ...and the user opens the bar during the load: they mean to search the
    // incoming page, so Chrome leaves the bar open at commit (crbug 469819146)
    // but never re-runs the query by itself.
    ctx.mod.openFindBar();
    await flushMicrotasks();
    ctx.mod.notifyFindBarNavigated(ctx.webview);

    expect(ctx.mod.isFindBarOpen()).toBe(true);
    expect(ctx.webview.findInPage).not.toHaveBeenCalled();
  });

  test('a background tab navigation closes that tab bar, not the foreground one', async () => {
    const firstWebview = createFakeWebview();
    const secondWebview = createFakeWebview();
    let active = firstWebview;
    const ctx = await loadFindBarModule({
      webview: firstWebview,
      initOptions: { getActiveWebview: () => active },
    });

    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    active = secondWebview;
    ctx.mod.notifyFindBarTabSwitched();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'banana');
    secondWebview.dispatch('found-in-page', {
      result: { activeMatchOrdinal: 1, matches: 2, finalUpdate: true },
    });

    // The backgrounded tab navigates (a redirect, a timer): its own session
    // ends, the visible bar keeps showing the foreground tab untouched.
    ctx.mod.notifyFindBarNavigationStarted(firstWebview);
    ctx.mod.notifyFindBarNavigated(firstWebview);

    expect(firstWebview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(ctx.mod.isFindBarOpen()).toBe(true);
    expect(ctx.input.value).toBe('banana');
    expect(ctx.count.textContent).toBe('1/2');

    // Returning to it shows a closed bar, not a stale count from the page
    // that navigated away.
    active = firstWebview;
    ctx.mod.notifyFindBarTabSwitched();
    expect(ctx.mod.isFindBarOpen()).toBe(false);
  });

  test('the navigation hooks paint nothing for a tab that never opened the bar', async () => {
    const ctx = await loadFindBarModule();

    expect(() => {
      ctx.mod.notifyFindBarNavigationStarted(ctx.webview);
      ctx.mod.notifyFindBarNavigated(ctx.webview);
      ctx.mod.notifyFindBarTabClosed(ctx.webview);
    }).not.toThrow();
    expect(ctx.count.textContent).toBe('');
    expect(ctx.mod.isFindBarOpen()).toBe(false);
  });

  // A main-frame navigation that never commits — a link served as a
  // download, Stop, window.stop(), a link handed to an external protocol
  // handler — leaves the user on the same page. Chrome acts only at commit,
  // so its session, highlights and count survive; ours must too.
  test('a navigation that starts but never commits leaves the live session alone', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    emitFoundInPage(ctx, { activeMatchOrdinal: 1, matches: 2, finalUpdate: true });
    expect(ctx.count.textContent).toBe('1/2');

    // The download click: did-start-navigation fires (Chromium emits it
    // before it knows the response is an attachment), no did-navigate ever
    // follows.
    ctx.mod.notifyFindBarNavigationStarted(ctx.webview);

    expect(ctx.webview.stopFindInPage).not.toHaveBeenCalled();
    expect(ctx.mod.isFindBarOpen()).toBe(true);
    expect(ctx.count.textContent).toBe('1/2');
    expect(ctx.prevBtn.disabled).toBe(false);
    expect(ctx.nextBtn.disabled).toBe(false);

    // The session is still live: Enter advances the existing search instead
    // of restarting it.
    ctx.webview.findInPage.mockClear();
    ctx.input.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });
    expect(ctx.webview.findInPage).toHaveBeenCalledWith('needle', {
      forward: true,
      findNext: true,
    });
  });

  // The flag Chrome records at DidStartNavigation is rewritten on every
  // start. Recording it only when unset let an uncommitted navigation wedge
  // it, so the next real navigation kept the bar open with the previous
  // page's query — the #299 behaviour this module removes.
  test('an uncommitted navigation does not wedge the bar open across the next one', async () => {
    const ctx = await loadFindBarModule();

    // Bar closed: a download link is clicked, so the recorded answer is
    // "was not visible" — and no commit ever consumes it.
    ctx.mod.notifyFindBarNavigationStarted(ctx.webview);

    // The user now searches this (unchanged) page and navigates for real.
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    ctx.mod.notifyFindBarNavigationStarted(ctx.webview);
    ctx.mod.notifyFindBarNavigated(ctx.webview);

    expect(ctx.mod.isFindBarOpen()).toBe(false);
    expect(ctx.count.textContent).toBe('');
  });

  // #300: a document that went into the back/forward cache mid-search comes
  // back painted. The session let go of the webview at the outgoing commit,
  // so the restoring commit has to reach the guest anyway — Chrome's
  // EndFindSession runs StopFinding on every cross-document commit.
  test('a commit with no live session still tells the guest to stop finding', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    // Navigating away ends the session (the cached document keeps its
    // highlights, which this stop cannot reach — it is no longer current).
    ctx.mod.notifyFindBarNavigationStarted(ctx.webview);
    ctx.mod.notifyFindBarNavigated(ctx.webview);
    ctx.webview.stopFindInPage.mockClear();

    // Back: the cached document commits again, painted, with no session.
    ctx.mod.notifyFindBarNavigated(ctx.webview);

    expect(ctx.webview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  test('clearing the query ends the session and blanks the counter', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    emitFoundInPage(ctx, { activeMatchOrdinal: 1, matches: 4, finalUpdate: true });

    await typeQuery(ctx, '');

    expect(ctx.webview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(ctx.count.textContent).toBe('');
    expect(ctx.prevBtn.disabled).toBe(true);
    expect(ctx.nextBtn.disabled).toBe(true);
  });

  test('opening with a page text selection prefills and searches it', async () => {
    const webview = createFakeWebview();
    webview.executeJavaScript.mockResolvedValue('  selected   phrase \n');
    const ctx = await loadFindBarModule({ webview });

    ctx.mod.openFindBar();
    await flushMicrotasks();

    expect(ctx.input.value).toBe('selected phrase');
    expect(webview.findInPage).toHaveBeenCalledWith('selected phrase');
  });

  test('re-opening without a page selection keeps the previous query', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');

    ctx.mod.closeFindBar();
    ctx.mod.openFindBar();
    await flushMicrotasks();

    expect(ctx.input.value).toBe('needle');
    expect(ctx.input.select).toHaveBeenCalled();
  });

  test('a prefill that resolves after the bar closed is discarded', async () => {
    const webview = createFakeWebview();
    const deferred = createDeferred();
    webview.executeJavaScript.mockReturnValue(deferred.promise);
    const ctx = await loadFindBarModule({ webview });

    ctx.mod.openFindBar();
    ctx.mod.closeFindBar();

    deferred.resolve('stale selection');
    await flushMicrotasks();

    expect(ctx.input.value).toBe('');
    expect(webview.findInPage).not.toHaveBeenCalled();
    expect(ctx.mod.isFindBarOpen()).toBe(false);
  });

  test('a prefill that resolves after the active webview changed is discarded', async () => {
    const firstWebview = createFakeWebview();
    const secondWebview = createFakeWebview();
    const deferred = createDeferred();
    firstWebview.executeJavaScript.mockReturnValue(deferred.promise);
    let active = firstWebview;
    const ctx = await loadFindBarModule({
      webview: firstWebview,
      initOptions: { getActiveWebview: () => active },
    });

    ctx.mod.openFindBar();
    // The active tab changes while the selection read is still in flight.
    active = secondWebview;

    deferred.resolve('stale selection');
    await flushMicrotasks();

    expect(ctx.input.value).toBe('');
    expect(firstWebview.findInPage).not.toHaveBeenCalled();
    expect(secondWebview.findInPage).not.toHaveBeenCalled();
  });

  test('a prefill that resolves after the same webview navigated is discarded', async () => {
    const webview = createFakeWebview();
    const deferred = createDeferred();
    webview.executeJavaScript.mockReturnValue(deferred.promise);
    const ctx = await loadFindBarModule({ webview });

    ctx.mod.openFindBar();
    // The page navigates while the selection read is still in flight. The
    // webview object survives navigation, so only the generation bump in
    // the navigation hook can invalidate the read from the old document.
    ctx.mod.notifyFindBarNavigationStarted(webview);
    ctx.mod.notifyFindBarNavigated(webview);

    deferred.resolve('selection from the old document');
    await flushMicrotasks();

    expect(ctx.mod.isFindBarOpen()).toBe(false);
    expect(webview.findInPage).not.toHaveBeenCalled();
  });

  test('typing while a prefill is in flight keeps the typed query', async () => {
    const webview = createFakeWebview();
    const deferred = createDeferred();
    webview.executeJavaScript.mockReturnValue(deferred.promise);
    const ctx = await loadFindBarModule({ webview });

    ctx.mod.openFindBar();
    // The user starts typing before the selection read comes back.
    ctx.input.value = 'q';
    ctx.input.dispatch('input');

    deferred.resolve('needle one');
    await flushMicrotasks();

    // The late selection must not rewrite (or re-select) what was typed.
    expect(ctx.input.value).toBe('q');
    expect(webview.findInPage).not.toHaveBeenCalledWith('needle one');

    // ...and the typed query still searches once the debounce fires.
    jest.advanceTimersByTime(ctx.mod.FIND_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(webview.findInPage).toHaveBeenCalledWith('q');
  });

  test('submitting with Enter while a prefill is in flight keeps the submitted query', async () => {
    const webview = createFakeWebview();
    const deferred = createDeferred();
    webview.executeJavaScript.mockReturnValue(deferred.promise);
    const ctx = await loadFindBarModule({ webview });

    ctx.mod.openFindBar();
    ctx.input.value = 'typed query';
    ctx.input.dispatch('input');
    ctx.input.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });

    deferred.resolve('page selection');
    await flushMicrotasks();

    expect(ctx.input.value).toBe('typed query');
    expect(webview.findInPage).toHaveBeenCalledWith('typed query');
    expect(webview.findInPage).not.toHaveBeenCalledWith('page selection');
  });

  test('clicking next while a prefill is in flight keeps the visible query', async () => {
    const webview = createFakeWebview();
    const deferred = createDeferred();
    webview.executeJavaScript.mockReturnValue(deferred.promise);
    const ctx = await loadFindBarModule({ webview });

    ctx.mod.openFindBar();
    ctx.input.value = 'typed query';
    ctx.input.dispatch('input');
    ctx.nextBtn.dispatch('click');

    deferred.resolve('page selection');
    await flushMicrotasks();

    expect(ctx.input.value).toBe('typed query');
    expect(webview.findInPage).not.toHaveBeenCalledWith('page selection');
  });

  test('a re-open supersedes a still-pending prefill; only the latest applies', async () => {
    const webview = createFakeWebview();
    const first = createDeferred();
    const second = createDeferred();
    webview.executeJavaScript
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const ctx = await loadFindBarModule({ webview });

    ctx.mod.openFindBar();
    ctx.mod.openFindBar();

    second.resolve('fresh selection');
    await flushMicrotasks();
    // The first request resolves last — it must not clobber the newer one.
    first.resolve('stale selection');
    await flushMicrotasks();

    expect(ctx.input.value).toBe('fresh selection');
    expect(webview.findInPage).toHaveBeenCalledTimes(1);
    expect(webview.findInPage).toHaveBeenCalledWith('fresh selection');
  });

  test('handles missing DOM elements and a missing webview safely', async () => {
    jest.resetModules();
    global.document = createDocument({ elementsById: {} });
    global.window = { addEventListener: jest.fn(), electronAPI: {} };
    const mod = await import('./find-bar.js');

    expect(() => {
      mod.initFindBar({ getActiveWebview: () => null });
      mod.openFindBar();
      mod.closeFindBar();
      mod.notifyFindBarNavigated();
    }).not.toThrow();
    expect(mod.isFindBarOpen()).toBe(false);
  });
});
