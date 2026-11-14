const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

describe('swipe-navigation (#980)', () => {
  const originalDocument = global.document;

  // Enough microtask turns for the settings answer to land.
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  async function load({
    canGoBack = true,
    canGoForward = true,
    zoom = 1,
    blocked = false,
    settings = { twoFinger: true },
    scrollEnd = () => Promise.resolve({ quietForMs: 150 }),
  } = {}) {
    jest.resetModules();
    jest.useFakeTimers();
    const indicator = createElement('div');
    indicator.hidden = true;
    indicator.style.setProperty = jest.fn((name, value) => {
      indicator.style[name] = value;
    });
    global.document = createDocument({ elementsById: { 'swipe-nav-indicator': indicator } });
    const webview = {
      canGoBack: jest.fn(() => canGoBack),
      canGoForward: jest.fn(() => canGoForward),
      getZoomFactor: jest.fn(() => zoom),
    };
    const state = { blocked };
    const deps = {
      getActiveWebview: jest.fn(() => webview),
      isNavigationBlocked: jest.fn(() => state.blocked),
      goBack: jest.fn(() => true),
      goForward: jest.fn(() => true),
      getSwipeSettings: jest.fn(() =>
        settings instanceof Error ? Promise.reject(settings) : Promise.resolve(settings)
      ),
      awaitScrollEnd: jest.fn(scrollEnd),
    };
    const mod = await import('./swipe-navigation.js');
    mod.initSwipeNavigation(deps);
    const send = (channel, payload) => mod.handleSwipeNavigationMessage(channel, payload);
    return { mod, indicator, webview, deps, state, send };
  }

  afterEach(() => {
    jest.useRealTimers();
    global.document = originalDocument;
  });

  test('the arrow follows the swipe and fills in at the commit distance', async () => {
    const { indicator, send, deps, webview } = await load();
    expect(send('swipe-nav:update', { direction: 'back', distance: 50 })).toBe(true);
    await flush();
    expect(deps.getSwipeSettings).toHaveBeenCalledTimes(1);
    expect(indicator.hidden).toBe(false);
    expect(indicator.classList.contains('swipe-nav-indicator--forward')).toBe(false);
    expect(indicator.classList.contains('swipe-nav-indicator--ready')).toBe(false);
    // A quarter of the way: from -48px toward 16px.
    expect(indicator.style['--swipe-nav-offset']).toBe('-32px');

    send('swipe-nav:update', { direction: 'back', distance: 199 });
    expect(deps.goBack).not.toHaveBeenCalled();
    send('swipe-nav:update', { direction: 'back', distance: 200 });
    expect(indicator.classList.contains('swipe-nav-indicator--ready')).toBe(true);
    // It fades where it stands rather than sliding back.
    expect(indicator.style['--swipe-nav-offset']).toBe('16px');
    expect(indicator.style['--swipe-nav-opacity']).toBe('0');
    expect(deps.goBack).toHaveBeenCalledWith(webview);
    // The setting is asked once per swipe, not per update.
    expect(deps.getSwipeSettings).toHaveBeenCalledTimes(1);
  });

  test('reaching the commit distance goes back at once, without waiting for the end', async () => {
    // The end comes only after macOS's momentum has died down, a second or
    // more after the fingers lift.
    const { indicator, send, deps, webview } = await load();
    send('swipe-nav:update', { direction: 'back', distance: 120 });
    await flush();
    send('swipe-nav:update', { direction: 'back', distance: 210 });
    expect(deps.goBack).toHaveBeenCalledTimes(1);
    expect(deps.goBack).toHaveBeenCalledWith(webview);
    expect(deps.goForward).not.toHaveBeenCalled();
    expect(indicator.classList.contains('swipe-nav-indicator--committed')).toBe(true);
    send('swipe-nav:end', { direction: 'back', distance: 400 });
    expect(deps.goBack).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(200);
    expect(indicator.hidden).toBe(true);
  });

  test('an end that carries it past the commit distance goes back too', async () => {
    const { send, deps } = await load();
    send('swipe-nav:update', { direction: 'back', distance: 120 });
    await flush();
    send('swipe-nav:end', { direction: 'back', distance: 210 });
    expect(deps.goBack).toHaveBeenCalledTimes(1);
  });

  test('a forward swipe goes forward with the arrow on the right', async () => {
    const { indicator, send, deps, webview } = await load();
    send('swipe-nav:update', { direction: 'forward', distance: 150 });
    await flush();
    expect(indicator.classList.contains('swipe-nav-indicator--forward')).toBe(true);
    send('swipe-nav:update', { direction: 'forward', distance: 250 });
    expect(deps.goForward).toHaveBeenCalledWith(webview);
    expect(deps.goBack).not.toHaveBeenCalled();
  });

  test('one that is already far enough when the setting answers goes then', async () => {
    const { send, deps } = await load();
    send('swipe-nav:update', { direction: 'back', distance: 250 });
    expect(deps.goBack).not.toHaveBeenCalled();
    await flush();
    expect(deps.goBack).toHaveBeenCalledTimes(1);
  });

  test('letting go short of it slides the arrow away without navigating', async () => {
    const { indicator, send, deps } = await load();
    send('swipe-nav:update', { direction: 'back', distance: 150 });
    await flush();
    send('swipe-nav:end', { direction: 'back', distance: 199 });
    expect(deps.goBack).not.toHaveBeenCalled();
    expect(indicator.style['--swipe-nav-offset']).toBe('-48px');
    jest.advanceTimersByTime(200);
    expect(indicator.hidden).toBe(true);
  });

  test("counts the page's zoom, so the distance is the trackpad's", async () => {
    const { send, deps } = await load({ zoom: 2 });
    send('swipe-nav:update', { direction: 'back', distance: 60 });
    await flush();
    expect(deps.goBack).not.toHaveBeenCalled();
    send('swipe-nav:update', { direction: 'back', distance: 100 });
    expect(deps.goBack).toHaveBeenCalled();
  });

  test.each([
    ['the setting is off', { settings: { twoFinger: false } }],
    ['the setting cannot be read', { settings: new Error('ipc') }],
  ])('does nothing when %s', async (_label, options) => {
    const { indicator, send, deps } = await load(options);
    send('swipe-nav:update', { direction: 'back', distance: 300 });
    await flush();
    send('swipe-nav:end', { direction: 'back', distance: 300 });
    expect(indicator.hidden).toBe(true);
    expect(deps.goBack).not.toHaveBeenCalled();
  });

  test('does nothing without an entry that way, and does not ask for the setting', async () => {
    const { indicator, send, deps } = await load({ canGoBack: false });
    send('swipe-nav:update', { direction: 'back', distance: 300 });
    await flush();
    send('swipe-nav:end', { direction: 'back', distance: 300 });
    expect(deps.getSwipeSettings).not.toHaveBeenCalled();
    expect(indicator.hidden).toBe(true);
    expect(deps.goBack).not.toHaveBeenCalled();
  });

  test('the Agent holding the tab blocks it, also when it takes the tab mid-swipe', async () => {
    const held = await load({ blocked: true });
    held.send('swipe-nav:update', { direction: 'back', distance: 300 });
    await flush();
    held.send('swipe-nav:end', { direction: 'back', distance: 300 });
    expect(held.indicator.hidden).toBe(true);
    expect(held.deps.goBack).not.toHaveBeenCalled();

    const taken = await load();
    taken.send('swipe-nav:update', { direction: 'back', distance: 150 });
    await flush();
    taken.state.blocked = true;
    taken.send('swipe-nav:update', { direction: 'back', distance: 300 });
    taken.send('swipe-nav:end', { direction: 'back', distance: 300 });
    expect(taken.deps.goBack).not.toHaveBeenCalled();
  });

  test('a swipe that ends before the setting answers does not navigate', async () => {
    const { send, deps } = await load();
    send('swipe-nav:update', { direction: 'back', distance: 300 });
    send('swipe-nav:end', { direction: 'back', distance: 300 });
    await flush();
    expect(deps.goBack).not.toHaveBeenCalled();
  });

  test('cancel, a tab switch and a silent preload all drop the swipe', async () => {
    const { mod, indicator, send, deps } = await load();
    send('swipe-nav:update', { direction: 'back', distance: 150 });
    await flush();
    send('swipe-nav:cancel');
    send('swipe-nav:end', { direction: 'back', distance: 300 });
    jest.advanceTimersByTime(200);
    expect(indicator.hidden).toBe(true);

    send('swipe-nav:update', { direction: 'back', distance: 150 });
    await flush();
    mod.cancelSwipeNavigation();
    send('swipe-nav:end', { direction: 'back', distance: 300 });

    send('swipe-nav:update', { direction: 'back', distance: 150 });
    await flush();
    jest.advanceTimersByTime(500);
    jest.advanceTimersByTime(200);
    expect(indicator.hidden).toBe(true);
    send('swipe-nav:end', { direction: 'back', distance: 300 });
    expect(deps.goBack).not.toHaveBeenCalled();
  });

  test('a swipe the other way replaces one whose end never came', async () => {
    const { send, deps } = await load();
    send('swipe-nav:update', { direction: 'back', distance: 150 });
    await flush();
    send('swipe-nav:update', { direction: 'forward', distance: 20 });
    await flush();
    send('swipe-nav:end', { direction: 'forward', distance: 20 });
    expect(deps.getSwipeSettings).toHaveBeenCalledTimes(2);
    expect(deps.goBack).not.toHaveBeenCalled();
    expect(deps.goForward).not.toHaveBeenCalled();
  });

  // A promise the test settles, for the main process's answer.
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  test('drops the rest of a swipe that navigated until its scroll is over', async () => {
    // The fingers and macOS's momentum carry on after it navigates, first in
    // the page being left, then in the one arriving, whose preload reports
    // them as a new swipe from its own edge.
    const answer = deferred();
    const { indicator, send, deps, webview } = await load({ scrollEnd: () => answer.promise });
    send('swipe-nav:update', { direction: 'back', distance: 150, sinceStart: 100 });
    await flush();
    send('swipe-nav:update', { direction: 'back', distance: 210, sinceStart: 120 });
    expect(deps.goBack).toHaveBeenCalledTimes(1);
    await flush();
    expect(deps.awaitScrollEnd).toHaveBeenCalledWith(webview);
    // However long the scroll goes on, and with gaps in what is heard of it.
    for (const distance of [400, 10, 120, 250, 600]) {
      send('swipe-nav:update', { direction: 'back', distance, sinceStart: 0 });
      await flush();
      jest.advanceTimersByTime(700);
    }
    send('swipe-nav:end', { direction: 'back', distance: 600, sinceStart: 0 });
    expect(deps.goBack).toHaveBeenCalledTimes(1);
    expect(deps.getSwipeSettings).toHaveBeenCalledTimes(1);
    expect(indicator.hidden).toBe(true);

    // Over: its last wheel event came 150 ms ago. A page busy loading hears
    // its share only now; that gesture began before the end and stays dropped.
    answer.resolve({ quietForMs: 150 });
    await flush();
    send('swipe-nav:update', { direction: 'back', distance: 300, sinceStart: 400 });
    send('swipe-nav:end', { direction: 'back', distance: 300, sinceStart: 400 });
    await flush();
    expect(deps.getSwipeSettings).toHaveBeenCalledTimes(1);
    expect(deps.goBack).toHaveBeenCalledTimes(1);

    // One that began after it is a swipe again.
    send('swipe-nav:update', { direction: 'back', distance: 150, sinceStart: 50 });
    await flush();
    expect(indicator.hidden).toBe(false);
    send('swipe-nav:update', { direction: 'back', distance: 210, sinceStart: 70 });
    expect(deps.goBack).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['refuses', () => Promise.resolve(null)],
    ['fails', () => Promise.reject(new Error('ipc'))],
  ])('when the wait %s, the scroll counts as over from then', async (_label, scrollEnd) => {
    const { send, deps } = await load({ scrollEnd });
    send('swipe-nav:update', { direction: 'back', distance: 250, sinceStart: 100 });
    await flush();
    expect(deps.goBack).toHaveBeenCalledTimes(1);
    send('swipe-nav:update', { direction: 'back', distance: 250, sinceStart: 10 });
    await flush();
    expect(deps.goBack).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(200);
    send('swipe-nav:update', { direction: 'back', distance: 250, sinceStart: 10 });
    await flush();
    expect(deps.goBack).toHaveBeenCalledTimes(2);
  });

  test("a tab switch ends that wait: the next tab's swipes are its own", async () => {
    const answer = deferred();
    const { mod, send, deps } = await load({ scrollEnd: () => answer.promise });
    send('swipe-nav:update', { direction: 'back', distance: 250, sinceStart: 100 });
    await flush();
    expect(deps.goBack).toHaveBeenCalledTimes(1);

    mod.cancelSwipeNavigation();
    send('swipe-nav:update', { direction: 'back', distance: 150, sinceStart: 0 });
    await flush();
    // The first tab's answer arrives late, its scroll having ended just now,
    // after this swipe began: it does not apply here.
    answer.resolve({ quietForMs: 0 });
    await flush();
    jest.advanceTimersByTime(30);
    send('swipe-nav:update', { direction: 'back', distance: 210, sinceStart: 30 });
    expect(deps.goBack).toHaveBeenCalledTimes(2);
  });

  test('ignores other channels and malformed payloads', async () => {
    const { send, deps, indicator } = await load();
    expect(send('link-status:zone', {})).toBe(false);
    send('swipe-nav:update', { direction: 'up', distance: 300 });
    send('swipe-nav:update', { direction: 'back', distance: 'far' });
    send('swipe-nav:update');
    await flush();
    expect(deps.getSwipeSettings).not.toHaveBeenCalled();
    expect(indicator.hidden).toBe(true);
  });
});
