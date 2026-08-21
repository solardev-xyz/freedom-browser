const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

function createContentsMock(options = {}) {
  const listeners = new Map();
  const onceListeners = new Map();
  let currentUrl = options.url || 'https://example.com';

  const contents = {
    id: options.id || 7,
    getType: jest.fn(() => options.type || 'webview'),
    getURL: jest.fn(() => currentUrl),
    setURL(url) {
      currentUrl = url;
    },
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    }),
    once: jest.fn((event, handler) => {
      if (!onceListeners.has(event)) {
        onceListeners.set(event, []);
      }
      onceListeners.get(event).push(handler);
    }),
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) {
        handler(...args);
      }

      const oneTimeHandlers = onceListeners.get(event) || [];
      onceListeners.delete(event);
      oneTimeHandlers.forEach((handler) => handler(...args));
    },
    insertCSS: jest.fn(() => Promise.resolve()),
    setWindowOpenHandler: jest.fn((handler) => {
      contents.windowOpenHandler = handler;
    }),
    windowOpenHandler: null,
  };

  return contents;
}

function loadWebContentsSetupModule(options = {}) {
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const BrowserWindow = options.BrowserWindow || {
    getAllWindows: jest.fn(() => options.windows || []),
    // Default: the owner lookup misses, which is exactly the precondition
    // for ownerWindowOf's teardown fallback.
    fromWebContents: jest.fn(options.fromWebContents || (() => null)),
  };
  const { app, mod } = loadMainModule(require.resolve('./webcontents-setup'), {
    BrowserWindow,
    extraMocks: {
      [require.resolve('./logger')]: () => log,
      [require.resolve('./private/private-windows')]: () => ({
        isPrivateWebContents: options.isPrivateWebContents || (() => false),
      }),
    },
  });
  const state = require('./state');

  state.activeBzzBases.clear();
  state.activeRadBases.clear();

  return {
    app,
    BrowserWindow,
    log,
    mod,
    state,
  };
}

describe('webcontents-setup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('injects light defaults for external webviews and clears active protocol bases on destroy', async () => {
    const ctx = loadWebContentsSetupModule();
    const contents = createContentsMock({
      id: 14,
      type: 'webview',
      url: 'https://example.com/articles/1',
    });

    ctx.state.activeBzzBases.set(contents.id, new URL('http://127.0.0.1:1633/bzz/hash/'));
    ctx.state.activeRadBases.set(contents.id, new URL('http://127.0.0.1:8780/api/v1/repos/rid/'));

    ctx.mod.registerWebContentsHandlers();
    ctx.app.emit('web-contents-created', {}, contents);

    contents.emit('dom-ready');
    expect(contents.insertCSS).toHaveBeenCalledWith(
      'html, body { background-color: #fff; color: #000; color-scheme: light; }',
      {
        cssOrigin: 'user',
      }
    );

    contents.emit('destroyed');
    expect(ctx.state.activeBzzBases.has(contents.id)).toBe(false);
    expect(ctx.state.activeRadBases.has(contents.id)).toBe(false);
  });

  test('skips css injection for internal file pages and intercepts external window opens', () => {
    const parentWindow = {
      webContents: {
        id: 1,
        send: jest.fn(),
      },
    };
    const ctx = loadWebContentsSetupModule({
      windows: [parentWindow],
    });
    const contents = createContentsMock({
      id: 22,
      type: 'webview',
      url: 'file:///app/pages/home.html',
    });

    ctx.mod.registerWebContentsHandlers();
    ctx.app.emit('web-contents-created', {}, contents);

    contents.emit('dom-ready');
    expect(contents.insertCSS).not.toHaveBeenCalled();

    const namedResult = contents.windowOpenHandler({
      url: 'https://github.com/openai/project',
      frameName: 'named-tab',
    });
    expect(namedResult).toEqual({ action: 'deny' });
    expect(parentWindow.webContents.send).toHaveBeenCalledWith(
      'tab:new-with-url',
      'https://github.com/openai/project',
      'named-tab'
    );

    const blankResult = contents.windowOpenHandler({
      url: 'https://example.com',
      frameName: '_blank',
    });
    expect(blankResult).toEqual({ action: 'deny' });
    expect(parentWindow.webContents.send).toHaveBeenLastCalledWith(
      'tab:new-with-url',
      'https://example.com',
      null
    );
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.stringContaining('intercepted new window request')
    );
  });

  test('intercepts custom protocol navigation and logs renderer lifecycle failures', () => {
    const parentWindow = {
      webContents: {
        id: 2,
        send: jest.fn(),
      },
    };
    const ctx = loadWebContentsSetupModule({
      windows: [parentWindow],
    });
    const contents = createContentsMock({
      id: 33,
      type: 'webview',
      url: 'https://example.com',
    });
    const event = {
      preventDefault: jest.fn(),
    };

    ctx.mod.registerWebContentsHandlers();
    ctx.app.emit('web-contents-created', {}, contents);

    contents.emit('will-navigate', event, 'bzz://0123456789abcdef');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(parentWindow.webContents.send).toHaveBeenCalledWith(
      'navigate-to-url',
      'bzz://0123456789abcdef'
    );
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.stringContaining('intercepted custom protocol navigation')
    );

    const ethEvent = {
      preventDefault: jest.fn(),
    };
    contents.emit('will-navigate', ethEvent, 'ethereum:vitalik.eth@1?value=1e16');
    expect(ethEvent.preventDefault).toHaveBeenCalled();
    expect(parentWindow.webContents.send).toHaveBeenCalledWith(
      'navigate-to-url',
      'ethereum:vitalik.eth@1?value=1e16'
    );

    const httpEvent = {
      preventDefault: jest.fn(),
    };
    contents.emit('will-navigate', httpEvent, 'https://example.com/next');
    expect(httpEvent.preventDefault).not.toHaveBeenCalled();

    const crashDetails = { reason: 'crashed' };
    contents.emit('render-process-gone', {}, crashDetails);
    contents.emit('crashed');
    contents.emit('unresponsive');
    contents.emit('responsive');

    expect(ctx.log.error).toHaveBeenCalledWith(
      '[webcontents:33:webview] render-process-gone',
      crashDetails
    );
    expect(ctx.log.error).toHaveBeenCalledWith('[webcontents:33:webview] crashed event (legacy)');
    expect(ctx.log.warn).toHaveBeenCalledWith('[webcontents:33:webview] became unresponsive');
    expect(ctx.log.warn).toHaveBeenCalledWith('[webcontents:33:webview] responsive again');
  });

  // PRIVATE MODE GUARD (navigation logging): log.info is written to the
  // persistent <userData>/logs/main.log, which outlives the private window.
  // Neither an intercepted custom-protocol URL nor a new-window target may
  // record where a private tab went — `rad:`/`ethereum:` URIs in particular
  // have no origin for sanitizeUrlForLog to strip them back to.
  test('private-window navigations log no URL at all', () => {
    const parentWindow = { webContents: { id: 2, send: jest.fn() } };
    const ctx = loadWebContentsSetupModule({
      windows: [parentWindow],
      // The private window's OWN chrome window resolves, so routing works
      // normally — this test is about logging, not about the fallback.
      fromWebContents: () => ({ ...parentWindow, isDestroyed: () => false }),
      isPrivateWebContents: (contents) => contents?.id === 44,
    });
    const contents = createContentsMock({ id: 44, type: 'webview' });

    ctx.mod.registerWebContentsHandlers();
    ctx.app.emit('web-contents-created', {}, contents);

    contents.emit('will-navigate', { preventDefault: jest.fn() }, 'rad:zSECRETRIDXYZZY');
    contents.windowOpenHandler({ url: 'https://secret.example/path', frameName: '' });

    // The events are still traced (diagnosability), just not their targets.
    const lines = ctx.log.info.mock.calls.map((call) => call.join(' '));
    expect(lines.some((line) => line.includes('intercepted custom protocol navigation'))).toBe(
      true
    );
    expect(lines.some((line) => line.includes('intercepted new window request'))).toBe(true);
    const joined = lines.join('\n');
    expect(joined).not.toContain('zSECRETRIDXYZZY');
    expect(joined).not.toContain('secret.example');
    // The navigation itself still works.
    expect(parentWindow.webContents.send).toHaveBeenCalledWith(
      'navigate-to-url',
      'rad:zSECRETRIDXYZZY'
    );
  });

  // A window that is closing stays in BrowserWindow.getAllWindows() while it
  // tears down, and its webContents is destroyed FIRST — so a bare
  // `win.webContents.id` in the ownerWindowOf fallback throws "Object has
  // been destroyed" synchronously inside the setWindowOpenHandler /
  // will-navigate callback and escapes as an unhandled main-process
  // exception. Both dereference shapes are exercised below.
  describe('ownerWindowOf fallback: windows mid-teardown', () => {
    const destroyedWindow = () => ({
      isDestroyed: () => false,
      get webContents() {
        throw new Error('Object has been destroyed');
      },
    });

    const contentsDestroyedWindow = () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        get id() {
          throw new Error('Object has been destroyed');
        },
        send: jest.fn(),
      },
    });

    test('skips a window whose webContents getter throws, and routes to a live one', () => {
      const live = { isDestroyed: () => false, webContents: { id: 2, send: jest.fn() } };
      const ctx = loadWebContentsSetupModule({ windows: [destroyedWindow(), live] });
      const contents = createContentsMock({ id: 55, type: 'webview' });

      ctx.mod.registerWebContentsHandlers();
      ctx.app.emit('web-contents-created', {}, contents);

      expect(() =>
        contents.emit('will-navigate', { preventDefault: jest.fn() }, 'freedom://settings')
      ).not.toThrow();
      expect(live.webContents.send).toHaveBeenCalledWith('navigate-to-url', 'freedom://settings');
    });

    test('skips a window whose webContents is destroyed, and routes to a live one', () => {
      const dying = contentsDestroyedWindow();
      const live = { isDestroyed: () => false, webContents: { id: 2, send: jest.fn() } };
      const ctx = loadWebContentsSetupModule({ windows: [dying, live] });
      const contents = createContentsMock({ id: 55, type: 'webview' });

      ctx.mod.registerWebContentsHandlers();
      ctx.app.emit('web-contents-created', {}, contents);

      expect(() =>
        contents.windowOpenHandler({ url: 'https://example.com/popup', frameName: '' })
      ).not.toThrow();
      expect(live.webContents.send).toHaveBeenCalledWith(
        'tab:new-with-url',
        'https://example.com/popup',
        null
      );
      expect(dying.webContents.send).not.toHaveBeenCalled();
    });

    test('drops the action when every remaining window is mid-teardown', () => {
      const ctx = loadWebContentsSetupModule({
        windows: [destroyedWindow(), contentsDestroyedWindow()],
      });
      const contents = createContentsMock({ id: 55, type: 'webview' });

      ctx.mod.registerWebContentsHandlers();
      ctx.app.emit('web-contents-created', {}, contents);

      const navEvent = { preventDefault: jest.fn() };
      expect(() => contents.emit('will-navigate', navEvent, 'bzz://example.eth/x')).not.toThrow();
      // The navigation is still cancelled — the webview must not load a
      // custom-protocol URL itself just because no window could take it.
      expect(navEvent.preventDefault).toHaveBeenCalled();
    });

    test('survives getAllWindows() itself throwing during shutdown', () => {
      const ctx = loadWebContentsSetupModule({
        BrowserWindow: {
          getAllWindows: jest.fn(() => {
            throw new Error('Object has been destroyed');
          }),
          fromWebContents: jest.fn(() => null),
        },
      });
      const contents = createContentsMock({ id: 55, type: 'webview' });

      ctx.mod.registerWebContentsHandlers();
      ctx.app.emit('web-contents-created', {}, contents);

      expect(() =>
        contents.windowOpenHandler({ url: 'https://example.com/popup', frameName: '' })
      ).not.toThrow();
    });
  });

  // PRIVATE MODE GUARD (cross-privacy routing): the fallback picks an
  // ARBITRARY other window. For a private sender that window may well be a
  // normal one on the default persistent session — the private page's URL
  // would land in history, on persistent cookies, with wallet providers
  // injected. There is no safe arbitrary window for a private action.
  describe('ownerWindowOf fallback: private senders', () => {
    test('drops a private new-window request rather than routing it to a normal window', () => {
      const normalWindow = { isDestroyed: () => false, webContents: { id: 2, send: jest.fn() } };
      const ctx = loadWebContentsSetupModule({
        windows: [normalWindow],
        isPrivateWebContents: (contents) => contents?.id === 44,
      });
      const contents = createContentsMock({ id: 44, type: 'webview' });

      ctx.mod.registerWebContentsHandlers();
      ctx.app.emit('web-contents-created', {}, contents);

      const result = contents.windowOpenHandler({
        url: 'https://secret.example/leak',
        frameName: '',
      });

      expect(normalWindow.webContents.send).not.toHaveBeenCalled();
      // The popup is still denied, as before — nothing opens anywhere.
      expect(result).toEqual({ action: 'deny' });
    });

    test('drops a private custom-protocol navigation rather than routing it', () => {
      const normalWindow = { isDestroyed: () => false, webContents: { id: 2, send: jest.fn() } };
      const ctx = loadWebContentsSetupModule({
        windows: [normalWindow],
        isPrivateWebContents: (contents) => contents?.id === 44,
      });
      const contents = createContentsMock({ id: 44, type: 'webview' });

      ctx.mod.registerWebContentsHandlers();
      ctx.app.emit('web-contents-created', {}, contents);

      const navEvent = { preventDefault: jest.fn() };
      contents.emit('will-navigate', navEvent, 'bzz://secret.eth/page');

      expect(navEvent.preventDefault).toHaveBeenCalled();
      expect(normalWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('a NORMAL sender still degrades to the old routing (guard is not a blanket drop)', () => {
      const otherWindow = { isDestroyed: () => false, webContents: { id: 2, send: jest.fn() } };
      const ctx = loadWebContentsSetupModule({ windows: [otherWindow] });
      const contents = createContentsMock({ id: 44, type: 'webview' });

      ctx.mod.registerWebContentsHandlers();
      ctx.app.emit('web-contents-created', {}, contents);

      contents.emit('will-navigate', { preventDefault: jest.fn() }, 'freedom://settings');

      expect(otherWindow.webContents.send).toHaveBeenCalledWith(
        'navigate-to-url',
        'freedom://settings'
      );
    });

    test('fails closed: an isPrivateWebContents that throws drops the action', () => {
      const normalWindow = { isDestroyed: () => false, webContents: { id: 2, send: jest.fn() } };
      const ctx = loadWebContentsSetupModule({
        windows: [normalWindow],
        isPrivateWebContents: () => {
          throw new Error('Object has been destroyed');
        },
      });
      const contents = createContentsMock({ id: 44, type: 'webview' });

      ctx.mod.registerWebContentsHandlers();
      ctx.app.emit('web-contents-created', {}, contents);

      expect(() =>
        contents.emit('will-navigate', { preventDefault: jest.fn() }, 'freedom://settings')
      ).not.toThrow();
      expect(normalWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  test('registers global process failure handlers on the app', () => {
    const ctx = loadWebContentsSetupModule();

    ctx.mod.registerWebContentsHandlers();

    ctx.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });
    ctx.app.emit('render-process-gone', {}, { id: 99, reason: 'oom' });

    expect(ctx.log.error).toHaveBeenCalledWith('[child-process-gone]', {
      type: 'GPU',
      reason: 'crashed',
    });
    expect(ctx.log.error).toHaveBeenCalledWith('[render-process-gone-global]', {
      id: 99,
      reason: 'oom',
    });
  });
});
