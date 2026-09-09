const IPC = require('../shared/ipc-channels');
const {
  createContextBridgeMock,
  createIpcRendererMock,
} = require('../../test/helpers/main-process-test-utils');

const originalWindow = global.window;
const originalDocument = global.document;
const originalMutationObserver = global.MutationObserver;
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

  const contextBridge = options.contextBridge || createContextBridgeMock();
  const ipcRenderer = createIpcRendererMock({
    syncResponses: {
      [IPC.GET_INTERNAL_PAGES]: internalPages,
      [IPC.GET_ETHEREUM_INJECT_SOURCE]: '/* ethereum inject source stub */',
      [IPC.PRIVATE_IS_PRIVATE]: options.isPrivateWindow === true,
      [IPC.GET_THEME]: options.theme ?? 'system',
      ...(options.syncResponses || {}),
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
  // <html>. `options.documentElement === null` models document-start, where
  // the preload runs before the element exists.
  const attributes = {};
  const documentElement =
    options.documentElement === null
      ? null
      : {
          tagName: 'HTML',
          attributes,
          setAttribute: jest.fn((name, value) => {
            attributes[name] = value;
          }),
          getAttribute: jest.fn((name) => (name in attributes ? attributes[name] : null)),
          removeAttribute: jest.fn((name) => {
            delete attributes[name];
          }),
        };
  const document = {
    title: options.title || 'Internal Page',
    body,
    documentElement,
    addEventListener: jest.fn((event, handler, useCapture) => {
      documentHandlers[event] = handler;
      if (useCapture === true) {
        documentCaptureHandlers[event] = handler;
      }
    }),
    execCommand: jest.fn(),
    ...(options.documentOverrides || {}),
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
  // Only `(prefers-color-scheme: dark)` is queried, by the internal-page theme
  // bootstrap. The list is a single live object, so a spec can flip `matches`
  // and fire `mediaChangeHandlers` to model the desktop switching scheme.
  const mediaChangeHandlers = [];
  const prefersDarkQuery = {
    matches: options.prefersDark === true,
    addEventListener: jest.fn((_event, handler) => mediaChangeHandlers.push(handler)),
  };
  global.window = {
    location,
    getSelection: jest.fn(() => selection),
    addEventListener: jest.fn((event, handler, useCapture) => {
      if (useCapture === true) {
        windowCaptureHandlers[event] = handler;
      }
    }),
    matchMedia: jest.fn(() => prefersDarkQuery),
    fetch: windowFetch,
  };
  global.location = location;
  global.navigator = {
    clipboard,
  };
  // The theme bootstrap falls back to observing `document` when <html> does
  // not exist yet at document-start.
  const mutationObservers = [];
  global.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      mutationObservers.push(this);
    }
    observe(target, init) {
      this.target = target;
      this.init = init;
    }
    disconnect() {
      this.disconnected = true;
    }
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
    documentElement,
    mediaChangeHandlers,
    prefersDarkQuery,
    mutationObservers,
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
    global.MutationObserver = originalMutationObserver;
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
      ['checkRadicleBinary', [], IPC.RADICLE_CHECK_BINARY, []],
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

  test('onRadicleSeedStatus forwards pushed clone progress', () => {
    const { exposures, ipcRenderer } = loadWebviewPreloadModule();
    const callback = jest.fn();
    const status = {
      rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5',
      state: 'fetching',
      progress: { phase: 'fetching', index: 1, total: 2 },
    };

    const unsubscribe = exposures.freedomAPI.onRadicleSeedStatus(callback);
    ipcRenderer.emit(IPC.RADICLE_SEED_STATUS_UPDATE, status);
    expect(callback).toHaveBeenCalledWith(status);

    unsubscribe();
    callback.mockClear();
    ipcRenderer.emit(IPC.RADICLE_SEED_STATUS_UPDATE, status);
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

  test('resolves modifiers into Chrome dispositions (background tab, foreground tab, new window)', () => {
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
    // Dispositions match Chrome (#303): Ctrl/Cmd+click and middle-click open a
    // BACKGROUND tab (you stay on the page you are reading), adding Shift
    // promotes it to the foreground, and a bare Shift+click opens a window.
    // Every one of these used to collapse into a single foreground `newTab`.
    const cases = [
      {
        label: 'cmd-click',
        dispatchEvent: 'click',
        overrides: { metaKey: true },
        expected: 'newBackgroundTab',
      },
      {
        label: 'ctrl-click',
        dispatchEvent: 'click',
        overrides: { ctrlKey: true },
        expected: 'newBackgroundTab',
      },
      {
        label: 'ctrl-shift-click',
        dispatchEvent: 'click',
        overrides: { ctrlKey: true, shiftKey: true },
        expected: 'newTab',
      },
      {
        label: 'cmd-shift-click',
        dispatchEvent: 'click',
        overrides: { metaKey: true, shiftKey: true },
        expected: 'newTab',
      },
      {
        label: 'shift-click',
        dispatchEvent: 'click',
        overrides: { shiftKey: true },
        expected: 'newWindow',
      },
      {
        label: 'middle-click',
        dispatchEvent: 'auxclick',
        overrides: { button: 1 },
        expected: 'newBackgroundTab',
      },
      {
        label: 'shift-middle-click',
        dispatchEvent: 'auxclick',
        overrides: { button: 1, shiftKey: true },
        expected: 'newTab',
      },
      {
        label: 'target=_blank',
        dispatchEvent: 'click',
        overrides: {},
        target: '_blank',
        expected: 'newTab',
      },
      {
        // Modifiers beat the target attribute, as in Chrome: Ctrl+clicking a
        // `target="_blank"` link still leaves you on the current page.
        label: 'ctrl-click on target=_blank',
        dispatchEvent: 'click',
        overrides: { ctrlKey: true },
        target: '_blank',
        expected: 'newBackgroundTab',
      },
      {
        // A named target keeps its name in every disposition so the renderer's
        // tab-reuse path still fires.
        label: 'ctrl-click on a named target',
        dispatchEvent: 'click',
        overrides: { ctrlKey: true },
        target: 'docs',
        expected: 'newBackgroundTab',
      },
    ];

    for (const { label, dispatchEvent, overrides, target = '', expected } of cases) {
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
      // `label` names the failing case in the assertion message.
      expect({ label, ...ipcRenderer.sendToHost.mock.calls[0][1] }).toEqual({
        label,
        url: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        disposition: expected,
        target: target || null,
      });
      expect(ipcRenderer.sendToHost.mock.calls[0][0]).toBe('link:navigate');
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

  test('routes trusted links out of an onchain app through browser chrome', () => {
    const { documentCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'web3://0x00000095643cffA7d9faE407A84Dfcb6406456C6.eip155-1/swap',
        protocol: 'web3:',
        pathname: '/swap',
      },
    });
    const anchor = {
      tagName: 'A',
      hasAttribute: jest.fn(() => false),
      getAttribute: jest.fn((name) => {
        if (name === 'href') return '/about?from=swap';
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
      defaultPrevented: false,
      isTrusted: true,
      preventDefault: jest.fn(),
    };

    documentCaptureHandlers.click(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith('link:navigate', {
      url: 'web3://0x00000095643cffA7d9faE407A84Dfcb6406456C6.eip155-1/about?from=swap',
      disposition: 'currentTab',
      target: null,
    });
  });

  test('does not elevate synthetic onchain clicks into browser navigation', () => {
    const { documentCaptureHandlers, ipcRenderer } = loadWebviewPreloadModule({
      location: {
        href: 'web3://0x00000095643cffA7d9faE407A84Dfcb6406456C6.eip155-1/',
        protocol: 'web3:',
        pathname: '/',
      },
    });
    const event = {
      target: {
        tagName: 'A',
        hasAttribute: jest.fn(() => false),
        getAttribute: jest.fn((name) => (name === 'href' ? 'https://evil.example/' : '')),
        parentElement: global.document.body,
      },
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      defaultPrevented: false,
      isTrusted: false,
      preventDefault: jest.fn(),
    };

    documentCaptureHandlers.click(event);

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
    global.MutationObserver = originalMutationObserver;
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
    const { contextBridge, ipcRenderer, document } = loadWebviewPreloadModule({
      isPrivateWindow: true,
      location: {
        href: 'https://dapp.example/',
        protocol: 'https:',
        pathname: '/',
      },
    });

    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(IPC.PRIVATE_IS_PRIVATE);
    expect(contextBridge.executeInMainWorld).not.toHaveBeenCalled();

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
    const { contextBridge, ipcRenderer, document } = loadWebviewPreloadModule({
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

    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(1);
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledWith({
      func: expect.any(Function),
    });
    expect(document.addEventListener.mock.calls.map(([event]) => event)).not.toContain(
      'DOMContentLoaded'
    );
  });

  test('normal window: falls back to DOM injection if early main-world execution fails', () => {
    const contextBridge = createContextBridgeMock();
    contextBridge.executeInMainWorld.mockImplementation(() => {
      throw new Error('early injection unavailable');
    });
    const scripts = [];
    const head = { firstChild: null, insertBefore: jest.fn() };

    const { documentHandlers } = loadWebviewPreloadModule({
      contextBridge,
      location: {
        href: 'https://dapp.example/',
        protocol: 'https:',
        pathname: '/',
      },
      documentOverrides: {
        createElement: jest.fn(() => {
          const script = { remove: jest.fn(), textContent: '' };
          scripts.push(script);
          return script;
        }),
        head,
        readyState: 'complete',
      },
    });

    expect(documentHandlers.DOMContentLoaded).toBeUndefined();
    expect(scripts[0].textContent).toBe('/* ethereum inject source stub */');
    expect(head.insertBefore).toHaveBeenNthCalledWith(1, scripts[0], null);
    expect(scripts[0].remove).toHaveBeenCalled();
  });
});

// #233: internal pages used to follow the OS colour scheme only, so a dark app
// on a light desktop rendered a dark toolbar over white pages. The preload now
// resolves Settings > Appearance at document-start and stamps the answer on
// <html>; the page stylesheets key their light palette (and `color-scheme`)
// off that attribute.
describe('webview-preload internal-page theme', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.navigator = originalNavigator;
    global.location = originalLocation;
    global.MutationObserver = originalMutationObserver;
    jest.restoreAllMocks();
  });

  const internalLocation = {
    href: 'file:///app/pages/history.html',
    protocol: 'file:',
    pathname: '/app/pages/history.html',
  };

  test.each([
    ['dark', 'dark'],
    ['light', 'light'],
  ])('an explicit theme of %s wins over the OS scheme', (theme, expected) => {
    // prefersDark is the *opposite* of the setting in both rows: the whole
    // point of #233 is that the setting, not the desktop, decides.
    const { documentElement, ipcRenderer } = loadWebviewPreloadModule({
      location: internalLocation,
      theme,
      prefersDark: theme === 'light',
    });

    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(IPC.GET_THEME);
    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', expected);
  });

  test.each([
    [true, 'dark'],
    [false, 'light'],
  ])('"system" still resolves through prefers-color-scheme (dark=%s)', (prefersDark, expected) => {
    const { documentElement } = loadWebviewPreloadModule({
      location: internalLocation,
      theme: 'system',
      prefersDark,
    });

    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', expected);
  });

  test('"system" repaints when the OS scheme changes, an explicit theme does not', () => {
    const system = loadWebviewPreloadModule({
      location: internalLocation,
      theme: 'system',
      prefersDark: false,
    });
    expect(system.documentElement.getAttribute('data-theme')).toBe('light');
    expect(system.mediaChangeHandlers).toHaveLength(1);
    // The desktop switches to dark: the live query flips, then notifies.
    system.prefersDarkQuery.matches = true;
    system.mediaChangeHandlers[0]();
    expect(system.documentElement.getAttribute('data-theme')).toBe('dark');

    // An explicit setting ignores the OS entirely.
    const explicit = loadWebviewPreloadModule({
      location: internalLocation,
      theme: 'light',
      prefersDark: false,
    });
    explicit.prefersDarkQuery.matches = true;
    explicit.mediaChangeHandlers[0]();
    expect(explicit.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('a settings:updated broadcast repaints an already-loaded page', () => {
    // OS is dark here, so the "system" leg below is not satisfied by the
    // starting value.
    const { documentElement, ipcRenderer } = loadWebviewPreloadModule({
      location: internalLocation,
      theme: 'light',
      prefersDark: true,
    });
    expect(documentElement.getAttribute('data-theme')).toBe('light');

    const handlers = ipcRenderer.listeners.get(IPC.SETTINGS_UPDATED) || [];
    expect(handlers).toHaveLength(1);
    handlers[0]({}, { theme: 'dark' });
    expect(documentElement.getAttribute('data-theme')).toBe('dark');

    handlers[0]({}, { theme: 'light' });
    expect(documentElement.getAttribute('data-theme')).toBe('light');

    // Falling back to "system" re-reads the OS scheme, which is dark here.
    handlers[0]({}, { theme: 'system' });
    expect(documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('stamps <html> as soon as it is parsed when it does not exist yet', () => {
    // Preloads run at document-start, before the parser has created <html>.
    // Waiting for DOMContentLoaded instead would flash the wrong theme.
    const { document, mutationObservers } = loadWebviewPreloadModule({
      location: internalLocation,
      theme: 'light',
      documentElement: null,
    });

    expect(mutationObservers).toHaveLength(1);
    expect(mutationObservers[0].target).toBe(document);
    expect(mutationObservers[0].init).toEqual({ childList: true });

    const attributes = {};
    document.documentElement = {
      setAttribute: (name, value) => {
        attributes[name] = value;
      },
    };
    mutationObservers[0].callback();
    expect(attributes['data-theme']).toBe('light');
    expect(mutationObservers[0].disconnected).toBe(true);
  });

  test('leaves non-internal pages alone', () => {
    const { documentElement, ipcRenderer } = loadWebviewPreloadModule({
      location: { href: 'https://dapp.example/', protocol: 'https:', pathname: '/' },
      theme: 'dark',
    });

    expect(ipcRenderer.sendSync).not.toHaveBeenCalledWith(IPC.GET_THEME);
    expect(documentElement.setAttribute).not.toHaveBeenCalled();
    expect(ipcRenderer.listeners.get(IPC.SETTINGS_UPDATED)).toBeUndefined();
  });
});
