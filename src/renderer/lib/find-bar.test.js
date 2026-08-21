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

  test('closeFindBar stops the session on the searched webview even after the active tab changed', async () => {
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

    // Simulate a tab switch: the active webview changes, then tabs.js
    // closes the bar. Highlights must be cleared on the *searched* webview,
    // and focus must NOT be stolen from the incoming tab.
    active = secondWebview;
    ctx.mod.closeFindBar();

    expect(firstWebview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(secondWebview.stopFindInPage).not.toHaveBeenCalled();
    expect(firstWebview.focus).not.toHaveBeenCalled();
    expect(secondWebview.focus).not.toHaveBeenCalled();
    expect(ctx.mod.isFindBarOpen()).toBe(false);
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

  test('navigation resets results but keeps the bar open; Enter re-runs a full search', async () => {
    const ctx = await loadFindBarModule();
    ctx.mod.openFindBar();
    await flushMicrotasks();
    await typeQuery(ctx, 'needle');
    emitFoundInPage(ctx, { activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    expect(ctx.count.textContent).toBe('2/5');

    ctx.mod.notifyFindBarNavigated();

    expect(ctx.mod.isFindBarOpen()).toBe(true);
    expect(ctx.count.textContent).toBe('');
    expect(ctx.input.value).toBe('needle');
    // Chromium already dropped the highlights on navigation — no extra
    // stopFindInPage call that could race the new document.
    expect(ctx.webview.stopFindInPage).not.toHaveBeenCalled();

    ctx.webview.findInPage.mockClear();
    ctx.input.dispatch('keydown', { key: 'Enter', shiftKey: false, preventDefault: jest.fn() });
    // Fresh search (no findNext options) because the session was reset.
    expect(ctx.webview.findInPage).toHaveBeenCalledWith('needle');
  });

  test('notifyFindBarNavigated is a no-op while the bar is closed', async () => {
    const ctx = await loadFindBarModule();

    expect(() => ctx.mod.notifyFindBarNavigated()).not.toThrow();
    expect(ctx.count.textContent).toBe('');
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
    ctx.mod.notifyFindBarNavigated();

    deferred.resolve('selection from the old document');
    await flushMicrotasks();

    expect(ctx.mod.isFindBarOpen()).toBe(true);
    expect(ctx.input.value).toBe('');
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

    ctx.input.value = 'typed query';
    ctx.mod.openFindBar();
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

    ctx.input.value = 'typed query';
    ctx.mod.openFindBar();
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
