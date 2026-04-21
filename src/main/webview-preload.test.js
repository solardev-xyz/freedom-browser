const IPC = require('../shared/ipc-channels');
const {
  createContextBridgeMock,
  createIpcRendererMock,
} = require('../../test/helpers/main-process-test-utils');

const originalWindow = global.window;
const originalDocument = global.document;
const originalNavigator = global.navigator;
const originalLocation = global.location;

const internalPages = {
  routable: {
    home: 'home.html',
    history: 'history.html',
    links: 'links.html',
    'protocol-test': 'protocol-test.html',
  },
  other: ['error.html', 'rad-browser.html'],
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function loadWebviewPreloadModule(options = {}) {
  jest.resetModules();

  const contextBridge = createContextBridgeMock();
  const ipcRenderer = createIpcRendererMock({
    syncResponses: {
      [IPC.GET_INTERNAL_PAGES]: internalPages,
      [IPC.GET_ETHEREUM_INJECT_SOURCE]: '/* ethereum inject source stub */',
    },
    invokeResponses: {
      [IPC.HISTORY_GET]: [{ url: 'https://example.com' }],
      [IPC.SETTINGS_GET]: { theme: 'dark' },
      [IPC.BOOKMARKS_GET]: [{ target: 'https://example.com' }],
      [IPC.RADICLE_GET_STATUS]: { status: 'running' },
      ...(options.invokeResponses || {}),
    },
  });
  ipcRenderer.sendToHost = jest.fn();

  const documentHandlers = {};
  const documentCaptureHandlers = {};
  const body = { tagName: 'BODY' };
  const document = {
    title: options.title || 'Internal Page',
    body,
    addEventListener: jest.fn((event, handler, useCapture) => {
      documentHandlers[event] = handler;
      if (useCapture === true) {
        documentCaptureHandlers[event] = handler;
      }
    }),
    execCommand: jest.fn(),
  };
  const location = options.location || {
    href: 'file:///app/pages/history.html',
    protocol: 'file:',
    pathname: '/app/pages/history.html',
  };
  const selectionText = options.selectionText || '';
  const selection = {
    toString: jest.fn(() => selectionText),
  };
  const clipboard = {
    writeText: jest.fn().mockResolvedValue(undefined),
  };

  global.document = document;
  const windowFetch = options.fetch || jest.fn();
  global.window = {
    location,
    getSelection: jest.fn(() => selection),
    addEventListener: jest.fn(),
    fetch: windowFetch,
  };
  global.location = location;
  global.navigator = {
    clipboard,
  };

  jest.doMock('electron', () => ({
    contextBridge,
    ipcRenderer,
  }));

  require(require.resolve('./webview-preload'));

  return {
    clipboard,
    contextBridge,
    document,
    documentHandlers,
    documentCaptureHandlers,
    exposures: contextBridge.exposedValues,
    ipcRenderer,
    location,
    windowFetch,
    getWindowFetch: () => global.window.fetch,
  };
}

describe('webview-preload', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.navigator = originalNavigator;
    global.location = originalLocation;
    jest.restoreAllMocks();
  });

  test('exposes guarded freedomAPI methods for allowed internal pages', async () => {
    const { contextBridge, exposures, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'file:///app/pages/error.html?url=https%3A%2F%2Fexample.com',
        protocol: 'file:',
        pathname: '/app/pages/error.html',
      },
    });

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'freedomAPI',
      expect.any(Object)
    );
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(IPC.GET_INTERNAL_PAGES);

    const invokeCases = [
      ['getHistory', [{ limit: 10 }], IPC.HISTORY_GET, [{ limit: 10 }]],
      ['addHistory', [{ url: 'https://example.com' }], IPC.HISTORY_ADD, [{ url: 'https://example.com' }]],
      ['removeHistory', [5], IPC.HISTORY_REMOVE, [5]],
      ['clearHistory', [], IPC.HISTORY_CLEAR, []],
      ['getSettings', [], IPC.SETTINGS_GET, []],
      ['saveSettings', [{ theme: 'light' }], IPC.SETTINGS_SAVE, [{ theme: 'light' }]],
      ['getPlatform', [], IPC.WINDOW_GET_PLATFORM, []],
      ['testEnsRpc', ['http://localhost:8545'], IPC.ENS_TEST_RPC, [{ url: 'http://localhost:8545' }]],
      ['getServiceRegistry', [], IPC.SERVICE_REGISTRY_GET, []],
      ['openPublishSetup', [], IPC.SIDEBAR_OPEN_PUBLISH_SETUP, []],
      ['getBookmarks', [], IPC.BOOKMARKS_GET, []],
      ['openInNewTab', ['https://example.com'], IPC.OPEN_URL_IN_NEW_TAB, ['https://example.com']],
      ['getCachedFavicon', ['https://example.com'], IPC.FAVICON_GET_CACHED, ['https://example.com']],
      ['seedRadicle', ['z3abc'], IPC.RADICLE_SEED, ['z3abc']],
      ['getRadicleStatus', [], IPC.RADICLE_GET_STATUS, []],
      ['getRadicleRepoPayload', ['z3abc'], IPC.RADICLE_GET_REPO_PAYLOAD, ['z3abc']],
      ['syncRadicleRepo', ['z3abc'], IPC.RADICLE_SYNC_REPO, ['z3abc']],
    ];

    for (const [method, args, channel, expectedArgs] of invokeCases) {
      ipcRenderer.invoke.mockClear();
      await exposures.freedomAPI[method](...args);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...expectedArgs);
    }

    expect(consoleLogSpy).toHaveBeenCalledWith('[webview-preload] Loaded (freedomAPI + context menu + ethereum + swarm provider)');
  });

  test('onSettingsUpdated forwards the broadcast and unsubscribes on pagehide', () => {
    const { exposures, ipcRenderer } = loadWebviewPreloadModule();

    const callback = jest.fn();
    const unsubscribe = exposures.freedomAPI.onSettingsUpdated(callback);
    expect(typeof unsubscribe).toBe('function');

    ipcRenderer.emit('settings:updated', { theme: 'dark' });
    expect(callback).toHaveBeenCalledWith({ theme: 'dark' });

    const pagehideHandler = global.window.addEventListener.mock.calls.find(
      ([event]) => event === 'pagehide'
    )?.[1];
    expect(pagehideHandler).toBeDefined();

    pagehideHandler();
    callback.mockClear();
    ipcRenderer.emit('settings:updated', { theme: 'light' });
    expect(callback).not.toHaveBeenCalled();
  });

  test('onSettingsUpdated returns a noop on non-internal pages', () => {
    const { exposures, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'https://example.com/',
        protocol: 'https:',
        pathname: '/',
      },
    });

    const callback = jest.fn();
    const unsubscribe = exposures.freedomAPI.onSettingsUpdated(callback);
    expect(typeof unsubscribe).toBe('function');
    ipcRenderer.emit('settings:updated', { theme: 'dark' });
    expect(callback).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[freedomAPI] blocked subscription "onSettingsUpdated" on non-internal page'
    );
  });

  test('blocks freedomAPI access on non-internal pages', async () => {
    const { exposures, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'https://example.com/articles/1',
        protocol: 'https:',
        pathname: '/articles/1',
      },
    });

    await expect(exposures.freedomAPI.getHistory({ limit: 5 })).rejects.toThrow(
      'freedomAPI is only available on internal pages'
    );
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[freedomAPI] blocked "getHistory" on non-internal page: https://example.com/articles/1'
    );
  });

  test('collects rich context menu data and forwards it to the host renderer', () => {
    const { documentHandlers, ipcRenderer } = loadWebviewPreloadModule({
      selectionText: 'Selected text',
      title: 'Article Title',
      location: {
        href: 'https://example.com/articles/1',
        protocol: 'https:',
        pathname: '/articles/1',
      },
    });
    const editableContainer = {
      tagName: 'DIV',
      isContentEditable: true,
      parentElement: { tagName: 'BODY' },
    };
    const link = {
      tagName: 'A',
      href: 'https://linked.example',
      textContent: 'Read more',
      parentElement: editableContainer,
    };
    const image = {
      tagName: 'IMG',
      src: 'https://linked.example/cover.png',
      alt: 'Cover image',
      parentElement: link,
    };
    const event = {
      clientX: 12,
      clientY: 34,
      target: image,
      preventDefault: jest.fn(),
    };

    documentHandlers.contextmenu(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith('context-menu', {
      x: 12,
      y: 34,
      pageUrl: 'https://example.com/articles/1',
      pageTitle: 'Article Title',
      linkUrl: 'https://linked.example',
      linkText: 'Read more',
      selectedText: 'Selected text',
      imageSrc: 'https://linked.example/cover.png',
      imageAlt: 'Cover image',
      isEditable: true,
      mediaType: 'image',
    });
  });

  test('detects video and audio media sources in the context menu handler', () => {
    const { documentHandlers, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'https://example.com/media',
        protocol: 'https:',
        pathname: '/media',
      },
    });
    const body = global.document.body;
    const video = {
      tagName: 'VIDEO',
      src: '',
      querySelector: jest.fn((selector) =>
        selector === 'source' ? { src: 'https://cdn.example/video.mp4' } : null
      ),
      parentElement: body,
    };
    const audio = {
      tagName: 'AUDIO',
      src: 'https://cdn.example/audio.mp3',
      querySelector: jest.fn(() => null),
      parentElement: body,
    };

    documentHandlers.contextmenu({
      clientX: 1,
      clientY: 2,
      target: video,
      preventDefault: jest.fn(),
    });
    expect(ipcRenderer.sendToHost).toHaveBeenLastCalledWith(
      'context-menu',
      expect.objectContaining({
        mediaType: 'video',
        mediaSrc: 'https://cdn.example/video.mp4',
      })
    );

    documentHandlers.contextmenu({
      clientX: 3,
      clientY: 4,
      target: audio,
      preventDefault: jest.fn(),
    });
    expect(ipcRenderer.sendToHost).toHaveBeenLastCalledWith(
      'context-menu',
      expect.objectContaining({
        mediaType: 'audio',
        mediaSrc: 'https://cdn.example/audio.mp3',
      })
    );
  });

  test('handles context menu actions through execCommand and clipboard APIs', async () => {
    const { clipboard, document, ipcRenderer } = loadWebviewPreloadModule();

    ipcRenderer.emit('context-menu-action', 'copy');
    ipcRenderer.emit('context-menu-action', 'cut');
    ipcRenderer.emit('context-menu-action', 'paste');
    ipcRenderer.emit('context-menu-action', 'select-all');
    ipcRenderer.emit('context-menu-action', 'copy-text', { text: 'Copied text' });
    await flushMicrotasks();

    expect(document.execCommand).toHaveBeenNthCalledWith(1, 'copy');
    expect(document.execCommand).toHaveBeenNthCalledWith(2, 'cut');
    expect(document.execCommand).toHaveBeenNthCalledWith(3, 'paste');
    expect(document.execCommand).toHaveBeenNthCalledWith(4, 'selectAll');
    expect(clipboard.writeText).toHaveBeenCalledWith('Copied text');

    clipboard.writeText.mockRejectedValueOnce(new Error('clipboard failed'));
    ipcRenderer.emit('context-menu-action', 'copy-text', { text: 'Failure case' });
    await flushMicrotasks();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(Error));
  });

  describe('bzz retry shim', () => {
    const bzzLocation = () => ({
      href: 'http://127.0.0.1:1633/bzz/abc/',
      origin: 'http://127.0.0.1:1633',
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '1633',
      pathname: '/bzz/abc/',
    });

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('does not install on non-bzz pages', () => {
      const ctx = loadWebviewPreloadModule({
        location: {
          href: 'https://example.com/',
          protocol: 'https:',
          hostname: 'example.com',
          port: '',
          pathname: '/',
          origin: 'https://example.com',
        },
      });
      expect(ctx.documentCaptureHandlers.error).toBeUndefined();
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Bzz retry shim installed')
      );
    });

    test('installs on bzz gateway pages', () => {
      const ctx = loadWebviewPreloadModule({ location: bzzLocation() });
      expect(ctx.documentCaptureHandlers.error).toBeDefined();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[webview-preload] Bzz retry shim installed for',
        '/bzz/abc/'
      );
    });

    test('retries a failed same-origin <img> by rewriting src', () => {
      const ctx = loadWebviewPreloadModule({ location: bzzLocation() });
      const img = {
        tagName: 'IMG',
        _src: '/bzz/abc/image.png',
        getAttribute: jest.fn(function () {
          return this._src;
        }),
        setAttribute: jest.fn(function (_attr, val) {
          this._src = val;
        }),
      };

      ctx.documentCaptureHandlers.error({ target: img });
      jest.advanceTimersByTime(500);

      expect(img.setAttribute).toHaveBeenCalledWith(
        'src',
        expect.stringContaining('/bzz/abc/image.png')
      );
      expect(img.setAttribute).toHaveBeenCalledWith(
        'src',
        expect.stringContaining('__bzzretry=')
      );
    });

    test('retries a failed <link> via href, not src', () => {
      const ctx = loadWebviewPreloadModule({ location: bzzLocation() });
      const link = {
        tagName: 'LINK',
        _href: '/bzz/abc/styles.css',
        getAttribute: jest.fn(function (attr) {
          return attr === 'href' ? this._href : null;
        }),
        setAttribute: jest.fn(function (attr, val) {
          if (attr === 'href') this._href = val;
        }),
      };

      ctx.documentCaptureHandlers.error({ target: link });
      jest.advanceTimersByTime(500);

      expect(link.setAttribute).toHaveBeenCalledWith(
        'href',
        expect.stringContaining('__bzzretry=')
      );
    });

    test('does not retry cross-origin resources', () => {
      const ctx = loadWebviewPreloadModule({ location: bzzLocation() });
      const img = {
        tagName: 'IMG',
        getAttribute: jest.fn(() => 'https://cdn.example.com/remote.png'),
        setAttribute: jest.fn(),
      };
      ctx.documentCaptureHandlers.error({ target: img });
      jest.advanceTimersByTime(10_000);
      expect(img.setAttribute).not.toHaveBeenCalled();
    });

    test('caps retries at MAX_RETRIES per element', () => {
      const ctx = loadWebviewPreloadModule({ location: bzzLocation() });
      const img = {
        tagName: 'IMG',
        _src: '/bzz/abc/image.png',
        getAttribute: jest.fn(function () {
          return this._src;
        }),
        setAttribute: jest.fn(function (_attr, val) {
          this._src = val;
        }),
      };
      // Trigger many more errors than the shim's retry cap and advance
      // well past its longest delay (30s) each iteration so every scheduled
      // retry fires. setAttribute should plateau at the configured cap.
      for (let i = 0; i < 40; i += 1) {
        ctx.documentCaptureHandlers.error({ target: img });
        jest.advanceTimersByTime(60_000);
      }
      expect(img.setAttribute).toHaveBeenCalledTimes(15);
    });

    test('wraps fetch and retries 404/500 same-origin responses', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 500 })
        .mockResolvedValueOnce({ status: 200 });
      const ctx = loadWebviewPreloadModule({
        location: bzzLocation(),
        fetch: fetchMock,
      });
      const wrapped = ctx.getWindowFetch();
      const pending = wrapped('/bzz/abc/data.json');
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test('wrapped fetch passes cross-origin requests straight through', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ status: 404 });
      const ctx = loadWebviewPreloadModule({
        location: bzzLocation(),
        fetch: fetchMock,
      });
      const wrapped = ctx.getWindowFetch();
      const res = await wrapped('https://cdn.example.com/thing.json');
      expect(res.status).toBe(404);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('wrapped fetch does not retry non-404/500 same-origin responses', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ status: 403 });
      const ctx = loadWebviewPreloadModule({
        location: bzzLocation(),
        fetch: fetchMock,
      });
      const wrapped = ctx.getWindowFetch();
      const res = await wrapped('/bzz/abc/forbidden');
      expect(res.status).toBe(403);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
