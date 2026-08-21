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
    settings: 'settings.html',
  },
  other: ['error.html', 'rad-browser.html'],
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// The context-menu interceptor defers its send with setTimeout(0) so the
// defaultPrevented check runs after the full event dispatch.
const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadWebviewPreloadModule(options = {}) {
  jest.resetModules();

  const contextBridge = createContextBridgeMock();
  const ipcRenderer = createIpcRendererMock({
    syncResponses: {
      [IPC.GET_INTERNAL_PAGES]: internalPages,
      [IPC.GET_ETHEREUM_INJECT_SOURCE]: '/* ethereum inject source stub */',
      [IPC.PRIVATE_IS_PRIVATE]: options.isPrivateWindow === true,
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
  const windowCaptureHandlers = {};
  global.window = {
    location,
    getSelection: jest.fn(() => selection),
    addEventListener: jest.fn((event, handler, useCapture) => {
      if (useCapture === true) {
        windowCaptureHandlers[event] = handler;
      }
    }),
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
    windowCaptureHandlers,
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

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('freedomAPI', expect.any(Object));
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(IPC.GET_INTERNAL_PAGES);

    const invokeCases = [
      ['getHistory', [{ limit: 10 }], IPC.HISTORY_GET, [{ limit: 10 }]],
      [
        'addHistory',
        [{ url: 'https://example.com' }],
        IPC.HISTORY_ADD,
        [{ url: 'https://example.com' }],
      ],
      ['removeHistory', [5], IPC.HISTORY_REMOVE, [5]],
      ['clearHistory', [], IPC.HISTORY_CLEAR, []],
      ['getSettings', [], IPC.SETTINGS_GET, []],
      ['saveSettings', [{ theme: 'light' }], IPC.SETTINGS_SAVE, [{ theme: 'light' }]],
      ['getPlatform', [], IPC.WINDOW_GET_PLATFORM, []],
      ['getActiveProfile', [], IPC.PROFILE_GET_ACTIVE, []],
      ['listProfiles', [], IPC.PROFILE_LIST, []],
      ['getServiceRegistry', [], IPC.SERVICE_REGISTRY_GET, []],
      ['getMyotisStatus', [], IPC.MYOTIS_GET_STATUS, []],
      ['openPublishSetup', [], IPC.SIDEBAR_OPEN_PUBLISH_SETUP, []],
      ['getBookmarks', [], IPC.BOOKMARKS_GET, []],
      ['openInNewTab', ['https://example.com'], IPC.OPEN_URL_IN_NEW_TAB, ['https://example.com']],
      [
        'getCachedFavicon',
        ['https://example.com'],
        IPC.FAVICON_GET_CACHED,
        ['https://example.com'],
      ],
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

    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[webview-preload] Loaded (freedomAPI + context menu + ethereum + swarm + radicle providers)'
    );
  });

  test('exposes profile mutation methods only on the settings page', async () => {
    const { exposures, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'file:///app/pages/settings.html',
        protocol: 'file:',
        pathname: '/app/pages/settings.html',
      },
    });

    const mutationCases = [
      ['createProfile', [{ displayName: 'Work' }], IPC.PROFILE_CREATE, [{ displayName: 'Work' }]],
      ['importProfile', ['work'], IPC.PROFILE_IMPORT, [{ id: 'work' }]],
      [
        'renameProfile',
        ['work', 'Work'],
        IPC.PROFILE_RENAME,
        [{ id: 'work', displayName: 'Work' }],
      ],
      ['openProfile', ['work'], IPC.PROFILE_OPEN, [{ id: 'work' }]],
      ['openProfileSettings', ['work'], IPC.PROFILE_OPEN, [{ id: 'work', openSettings: true }]],
      [
        'deleteProfile',
        ['work', 'Work'],
        IPC.PROFILE_DELETE,
        [{ id: 'work', confirmDisplayName: 'Work' }],
      ],
      [
        'updateProfileNodeConfig',
        ['bee', { mode: 'disabled' }],
        IPC.PROFILE_UPDATE_NODE_CONFIG,
        [{ protocol: 'bee', config: { mode: 'disabled' } }],
      ],
    ];

    for (const [method, args, channel, expectedArgs] of mutationCases) {
      ipcRenderer.invoke.mockClear();
      await exposures.freedomAPI[method](...args);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...expectedArgs);
    }
  });

  test('blocks profile mutation methods on other internal pages', async () => {
    const { exposures, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'file:///app/pages/history.html',
        protocol: 'file:',
        pathname: '/app/pages/history.html',
      },
    });

    // createProfile is a profile-management method (allowed on settings +
    // profiles.html); updateProfileNodeConfig is settings-only. Both are blocked
    // here on a non-manager internal page.
    await expect(exposures.freedomAPI.createProfile({ displayName: 'Work' })).rejects.toThrow(
      'freedomAPI profile changes are only available on profile management pages'
    );
    await expect(
      exposures.freedomAPI.updateProfileNodeConfig('bee', {
        mode: 'disabled',
      })
    ).rejects.toThrow('freedomAPI profile changes are only available on settings');

    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith(IPC.PROFILE_CREATE, expect.anything());
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith(
      IPC.PROFILE_UPDATE_NODE_CONFIG,
      expect.anything()
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[freedomAPI] blocked profile-management "createProfile" on page: file:///app/pages/history.html'
    );
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

  test('onProfileUpdated forwards the broadcast and unsubscribes on pagehide', () => {
    const { exposures, ipcRenderer } = loadWebviewPreloadModule();

    const callback = jest.fn();
    const unsubscribe = exposures.freedomAPI.onProfileUpdated(callback);
    expect(typeof unsubscribe).toBe('function');

    ipcRenderer.emit(IPC.PROFILE_UPDATED, { id: 'work', displayName: 'Work' });
    expect(callback).toHaveBeenCalledWith({ id: 'work', displayName: 'Work' });

    const pagehideHandler = global.window.addEventListener.mock.calls.find(
      ([event]) => event === 'pagehide'
    )?.[1];
    expect(pagehideHandler).toBeDefined();

    pagehideHandler();
    callback.mockClear();
    ipcRenderer.emit(IPC.PROFILE_UPDATED, { id: 'personal', displayName: 'Personal' });
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
    // The blocked freedomAPI call must not reach IPC. (The preload's
    // cosmetic-filtering client does invoke 'adblock:cosmetic' on this
    // real web page — that's expected and unrelated to freedomAPI.)
    const historyInvokes = ipcRenderer.invoke.mock.calls.filter(
      ([channel]) => channel !== 'adblock:cosmetic'
    );
    expect(historyInvokes).toHaveLength(0);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[freedomAPI] blocked "getHistory" on non-internal page: https://example.com/articles/1'
    );
  });

  test('collects rich context menu data and forwards it to the host renderer', async () => {
    const { windowCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule({
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
      defaultPrevented: false,
    };

    // Registered in the capture phase so page-level stopPropagation()
    // cannot starve the interceptor.
    windowCaptureHandlers.contextmenu(event);
    await flushTimers();

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

  test('skips the native context menu when the page calls preventDefault', async () => {
    const { windowCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'https://example.com/dapp',
        protocol: 'https:',
        pathname: '/dapp',
      },
    });
    const event = {
      clientX: 5,
      clientY: 6,
      target: global.document.body,
      defaultPrevented: false,
    };

    windowCaptureHandlers.contextmenu(event);
    // A page handler runs after the capture-phase interceptor and
    // suppresses the menu; the deferred check must honor it.
    event.defaultPrevented = true;
    await flushTimers();

    expect(ipcRenderer.sendToHost).not.toHaveBeenCalledWith(
      'context-menu',
      expect.anything()
    );
  });

  test('registers the contextmenu interceptor on window in the capture phase', () => {
    const { windowCaptureHandlers, document } = loadWebviewPreloadModule();

    // window-capture is the only spot no page handler can run before: the
    // preload registers before any page script, and window is the first node
    // in the capture path. A document-level or bubble-phase listener could be
    // starved by a page calling stopPropagation() without preventDefault().
    expect(typeof windowCaptureHandlers.contextmenu).toBe('function');
    expect(
      document.addEventListener.mock.calls.filter(([event]) => event === 'contextmenu')
    ).toHaveLength(0);
  });

  test('intercepts ipfs/ipns anchor clicks before Chromium lowercases the host', () => {
    const { documentCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'file:///app/pages/links.html',
        protocol: 'file:',
        pathname: '/app/pages/links.html',
      },
    });
    const anchor = {
      tagName: 'A',
      getAttribute: jest.fn((name) => {
        if (name === 'href') return 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
        if (name === 'target') return '';
        return null;
      }),
      parentElement: global.document.body,
    };
    const event = {
      target: anchor,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    };

    documentCaptureHandlers.click(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith('link:navigate', {
      url: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      disposition: 'currentTab',
      target: null,
    });
  });

  test('forwards a named target so the renderer can reuse the named tab', () => {
    // P3 from the round-4 review: without forwarding `target`, a
    // `<a target="docs" href="ipfs://...">` click hits the unconditional
    // newTab branch in the renderer and silently loses the named-tab
    // reuse semantics that `setWindowOpenHandler → tab:new-with-url`
    // path applies for non-dweb links. Forwarding the attribute lets
    // `link:navigate` route through the same `openInNewTabWithTarget`
    // helper.
    const { documentCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'file:///app/pages/links.html',
        protocol: 'file:',
        pathname: '/app/pages/links.html',
      },
    });
    const anchor = {
      tagName: 'A',
      getAttribute: jest.fn((name) => {
        if (name === 'href') return 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
        if (name === 'target') return 'docs';
        return null;
      }),
      parentElement: global.document.body,
    };
    const event = {
      target: anchor,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    };

    documentCaptureHandlers.click(event);

    expect(event.preventDefault).toHaveBeenCalled();
    // Named target → newTab disposition (Chromium's window.open semantics
    // for any non-empty `target` other than the current frame), with the
    // target name forwarded so the renderer's named-target reuse path
    // can fire.
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith('link:navigate', {
      url: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      disposition: 'newTab',
      target: 'docs',
    });
  });

  test('intercepts modified clicks and target=_blank with newTab disposition', () => {
    const makeAnchor = (target = '') => ({
      tagName: 'A',
      getAttribute: jest.fn((name) => {
        if (name === 'href') return 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
        if (name === 'target') return target;
        return null;
      }),
      parentElement: global.document.body,
    });

    // Each case names which DOM event fires for that activation in real
    // Chromium. Middle-click goes through `auxclick`, NOT `click` —
    // modern Chromium only dispatches `click` for the primary button
    // (UI Events spec). A previous implementation listened only to
    // `click` and checked `event.button === 1` inside, which is dead
    // code for real middle-clicks; fixed by registering both listeners.
    const cases = [
      { label: 'cmd-click', dispatchEvent: 'click', overrides: { metaKey: true } },
      { label: 'ctrl-click', dispatchEvent: 'click', overrides: { ctrlKey: true } },
      { label: 'shift-click', dispatchEvent: 'click', overrides: { shiftKey: true } },
      { label: 'middle-click', dispatchEvent: 'auxclick', overrides: { button: 1 } },
      { label: 'target=_blank', dispatchEvent: 'click', overrides: {}, target: '_blank' },
    ];

    for (const { label, dispatchEvent, overrides, target = '' } of cases) {
      const { documentCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule();
      const event = {
        target: makeAnchor(target),
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault: jest.fn(),
        ...overrides,
      };
      documentCaptureHandlers[dispatchEvent](event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(ipcRenderer.sendToHost).toHaveBeenCalledWith('link:navigate', {
        url: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        disposition: 'newTab',
        target: target || null,
      });
      void label;
    }
  });

  test('ignores non-dweb anchor clicks', () => {
    const { documentCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule();
    const event = {
      target: {
        tagName: 'A',
        getAttribute: jest.fn((name) => (name === 'href' ? 'https://example.com/' : null)),
        parentElement: global.document.body,
      },
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    };
    documentCaptureHandlers.click(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalledWith('link:navigate', expect.anything());
  });

  test('context menu preserves raw dweb href before anchor.href normalisation', async () => {
    const { windowCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'file:///app/pages/links.html',
        protocol: 'file:',
        pathname: '/app/pages/links.html',
      },
    });
    const anchor = {
      tagName: 'A',
      href: 'ipfs://qmywapjzv5czsna625s3xf2nemtygpphdwez79ojwnpbdg/',
      getAttribute: jest.fn((name) =>
        name === 'href' ? 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' : null
      ),
      textContent: 'CIDv0 link',
      parentElement: global.document.body,
    };

    windowCaptureHandlers.contextmenu({
      clientX: 1,
      clientY: 2,
      target: anchor,
      defaultPrevented: false,
    });
    await flushTimers();

    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
      'context-menu',
      expect.objectContaining({
        linkUrl: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        linkText: 'CIDv0 link',
      })
    );
  });

  test('detects video and audio media sources in the context menu handler', async () => {
    const { windowCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule({
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

    windowCaptureHandlers.contextmenu({
      clientX: 1,
      clientY: 2,
      target: video,
      defaultPrevented: false,
    });
    await flushTimers();
    expect(ipcRenderer.sendToHost).toHaveBeenLastCalledWith(
      'context-menu',
      expect.objectContaining({
        mediaType: 'video',
        mediaSrc: 'https://cdn.example/video.mp4',
      })
    );

    windowCaptureHandlers.contextmenu({
      clientX: 3,
      clientY: 4,
      target: audio,
      defaultPrevented: false,
    });
    await flushTimers();
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
});

// The page-side provider scripts are injected as source strings, so they are
// exercised here by extracting and evaluating them in a sandbox rather than
// through loadWebviewPreloadModule().
describe('injected provider request timeouts', () => {
  const fs = require('fs');
  const preloadSource = fs.readFileSync(require.resolve('./webview-preload'), 'utf8');

  function extractScript(varName) {
    const start = preloadSource.indexOf(`${varName}.textContent = \``);
    const bodyStart = preloadSource.indexOf('`', start) + 1;
    const bodyEnd = preloadSource.indexOf('\n  `;', bodyStart);
    expect(bodyStart).toBeGreaterThan(0);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    return preloadSource.slice(bodyStart, bodyEnd);
  }

  /** Evaluate an injected provider and report the timeout it arms per method. */
  function timeoutFor(varName, globalName, method) {
    let armed = null;
    const sandboxWindow = {
      postMessage: () => {},
      addEventListener: () => {},
      location: { origin: 'https://dapp.example' },
    };
    new Function('window', 'setTimeout', 'Map', extractScript(varName))(
      sandboxWindow,
      (_fn, ms) => {
        armed = ms;
      },
      Map
    );
    sandboxWindow[globalName].request({ method }).catch(() => {});
    return armed;
  }

  // A consent prompt blocks the response until the user decides. Timing that
  // out page-side rejects the dApp's promise while main still records the
  // grant and performs the write — the dApp retries and duplicates the COB.
  test.each([
    'radicle_requestAccess',
    'radicle_seed',
    'radicle_getIdentity',
    'radicle_createIssue',
    'radicle_commentIssue',
    'radicle_editIssueState',
    'radicle_commentPatch',
  ])('radicle %s (can prompt) gets the 300s budget', (method) => {
    expect(timeoutFor('radicleScript', 'radicle', method)).toBe(300000);
  });

  test.each([
    'radicle_getCapabilities',
    'radicle_getNodeStatus',
    'radicle_listSeededRepos',
    'radicle_unseed',
    'radicle_sync',
    'radicle_getSeedStatus',
    'radicle_disconnect',
  ])('radicle %s (never prompts) keeps the 60s budget', (method) => {
    expect(timeoutFor('radicleScript', 'radicle', method)).toBe(60000);
  });

  // Parity with the sibling provider the radicle one was modelled on.
  test('swarm prompt/long-running methods use the same 300s budget', () => {
    expect(timeoutFor('swarmScript', 'swarm', 'swarm_getSigningIdentity')).toBe(300000);
    expect(timeoutFor('swarmScript', 'swarm', 'swarm_readChunk')).toBe(60000);
  });
});

// PRIVATE MODE GUARD coverage (providers): in private windows none of
// window.ethereum / window.swarm / window.radicle is injected and none of the
// provider bridges are installed — a dApp probing for a wallet sees nothing.
describe('webview-preload private windows', () => {
  let consoleLogSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.navigator = originalNavigator;
    global.location = originalLocation;
    jest.restoreAllMocks();
  });

  const providerChannels = [
    'dapp:provider-response',
    'dapp:provider-event',
    'swarm:provider-response',
    'swarm:provider-event',
    'radicle:provider-response',
    'radicle:provider-event',
  ];

  test('private window: no provider bridges, no page-world injection attempts', () => {
    const { ipcRenderer, document } = loadWebviewPreloadModule({
      isPrivateWindow: true,
      location: {
        href: 'https://dapp.example/',
        protocol: 'https:',
        pathname: '/',
      },
    });

    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(IPC.PRIVATE_IS_PRIVATE);

    // No provider IPC bridges installed.
    const onChannels = ipcRenderer.on.mock.calls.map(([channel]) => channel);
    for (const channel of providerChannels) {
      expect(onChannels).not.toContain(channel);
    }

    // No message bridges (page → host) registered on window.
    const messageListeners = global.window.addEventListener.mock.calls.filter(
      ([event]) => event === 'message'
    );
    expect(messageListeners).toHaveLength(0);

    // No <script> injection is even attempted (createElement is absent on
    // the doc mock and would have logged an injection failure).
    expect(document.addEventListener.mock.calls.map(([e]) => e)).not.toContain(
      'DOMContentLoaded'
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[webview-preload] Loaded (freedomAPI + context menu — private window, providers disabled)'
    );
  });

  test('normal window: provider bridges are installed as before', () => {
    const { ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'https://dapp.example/',
        protocol: 'https:',
        pathname: '/',
      },
    });

    const onChannels = ipcRenderer.on.mock.calls.map(([channel]) => channel);
    for (const channel of providerChannels) {
      expect(onChannels).toContain(channel);
    }

    const messageListeners = global.window.addEventListener.mock.calls.filter(
      ([event]) => event === 'message'
    );
    // ethereum, swarm and radicle page→host bridges.
    expect(messageListeners).toHaveLength(3);
  });
});
