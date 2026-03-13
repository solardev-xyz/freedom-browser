const originalWindow = global.window;
const originalDocument = global.document;
const originalNavigator = global.navigator;
const originalRequestAnimationFrame = global.requestAnimationFrame;
const originalCustomEvent = global.CustomEvent;

const createClassList = (initialClasses = []) => {
  const classes = new Set(initialClasses);

  return {
    add: jest.fn((className) => {
      classes.add(className);
    }),
    remove: jest.fn((className) => {
      classes.delete(className);
    }),
    toggle: jest.fn((className, force) => {
      if (force === undefined) {
        if (classes.has(className)) {
          classes.delete(className);
          return false;
        }
        classes.add(className);
        return true;
      }

      if (force) {
        classes.add(className);
      } else {
        classes.delete(className);
      }

      return force;
    }),
    contains: jest.fn((className) => classes.has(className)),
  };
};

const createElement = (initialClasses = []) => {
  const handlers = {};

  return {
    handlers,
    classList: createClassList(initialClasses),
    style: {},
    dataset: {},
    disabled: false,
    addEventListener: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    querySelector: jest.fn(() => null),
    querySelectorAll: jest.fn(() => []),
    getBoundingClientRect: jest.fn(() => ({
      left: 0,
      top: 0,
      right: 120,
      bottom: 120,
      width: 120,
      height: 120,
    })),
    contains: jest.fn(() => false),
  };
};

const loadPageContextMenuModule = async (options = {}) => {
  jest.resetModules();

  const {
    activeWebview = {
      canGoBack: jest.fn(() => true),
      canGoForward: jest.fn(() => false),
      goBack: jest.fn(),
      goForward: jest.fn(),
      reloadIgnoringCache: jest.fn(),
      openDevTools: jest.fn(),
      send: jest.fn(),
    },
    menuRect = {
      left: 0,
      top: 0,
      right: 850,
      bottom: 650,
      width: 120,
      height: 100,
    },
  } = options;

  const pageGroup = createElement();
  const selectionGroup = createElement();
  const linkGroup = createElement();
  const imageGroup = createElement();
  const backBtn = createElement();
  const forwardBtn = createElement();
  const pageContextMenu = createElement(['hidden']);
  const webviewContainer = {
    querySelector: jest.fn(() => activeWebview),
  };
  const documentHandlers = {};
  const windowHandlers = {};
  const electronAPI = {
    openUrlInNewWindow: jest.fn(),
    copyText: jest.fn(),
    saveImage: jest.fn(),
    copyImageFromUrl: jest.fn(),
  };
  const selectorMap = {
    '[data-group="page"]': pageGroup,
    '[data-group="selection"]': selectionGroup,
    '[data-group="link"]': linkGroup,
    '[data-group="image"]': imageGroup,
    '[data-action="back"]': backBtn,
    '[data-action="forward"]': forwardBtn,
  };
  const pushDebug = jest.fn();
  const backdrop = {
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  };
  const urlUtils = {
    deriveDisplayValue: jest.fn((url) => `derived:${url}`),
    applyEnsNamePreservation: jest.fn((display) => `ens:${display}`),
  };

  pageContextMenu.querySelectorAll = jest.fn((selector) => {
    if (selector === '.context-menu-group') {
      return [pageGroup, selectionGroup, linkGroup, imageGroup];
    }

    return [];
  });
  pageContextMenu.querySelector = jest.fn((selector) => selectorMap[selector] || null);
  pageContextMenu.getBoundingClientRect = jest.fn(() => menuRect);

  global.window = {
    electronAPI,
    nodeConfig: {},
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };

  global.document = {
    getElementById: jest.fn((id) => {
      if (id === 'page-context-menu') return pageContextMenu;
      if (id === 'webview-container') return webviewContainer;
      return null;
    }),
    addEventListener: jest.fn((event, handler) => {
      documentHandlers[event] = handler;
    }),
    dispatchEvent: jest.fn(),
  };

  global.navigator = {
    clipboard: {
      writeText: jest.fn().mockResolvedValue(undefined),
    },
  };
  global.requestAnimationFrame = jest.fn((callback) => {
    callback();
    return 1;
  });
  global.CustomEvent = jest.fn((type, init) => ({
    type,
    detail: init.detail,
  }));

  jest.doMock('./debug.js', () => ({
    pushDebug,
  }));
  jest.doMock('./menu-backdrop.js', () => backdrop);
  jest.doMock('./url-utils.js', () => urlUtils);

  const mod = await import('./page-context-menu.js');
  const stateModule = await import('./state.js');

  stateModule.state.knownEnsNames = new Map([['cid', 'name.eth']]);

  return {
    mod,
    state: stateModule.state,
    pageContextMenu,
    pageGroup,
    selectionGroup,
    linkGroup,
    imageGroup,
    backBtn,
    forwardBtn,
    activeWebview,
    webviewContainer,
    documentHandlers,
    windowHandlers,
    electronAPI,
    pushDebug,
    backdrop,
    urlUtils,
  };
};

const triggerMenuAction = async (pageContextMenu, action, itemOverrides = {}) => {
  const item = {
    disabled: false,
    dataset: { action },
    ...itemOverrides,
  };
  const target = {
    closest: jest.fn(() => item),
  };

  pageContextMenu.handlers.click({ target });
  await Promise.resolve();

  return item;
};

describe('page-context-menu', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.navigator = originalNavigator;
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.CustomEvent = originalCustomEvent;
    jest.restoreAllMocks();
  });

  test('handles missing initialization targets safely', async () => {
    jest.resetModules();

    global.window = {
      electronAPI: {},
      nodeConfig: {},
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: jest.fn(),
    };
    global.document = {
      getElementById: jest.fn(() => null),
      addEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    };
    global.navigator = {
      clipboard: {
        writeText: jest.fn(),
      },
    };
    global.requestAnimationFrame = jest.fn((callback) => {
      callback();
      return 1;
    });
    global.CustomEvent = jest.fn((type, init) => ({
      type,
      detail: init.detail,
    }));

    jest.doMock('./debug.js', () => ({
      pushDebug: jest.fn(),
    }));
    jest.doMock('./menu-backdrop.js', () => ({
      showMenuBackdrop: jest.fn(),
      hideMenuBackdrop: jest.fn(),
    }));
    jest.doMock('./url-utils.js', () => ({
      deriveDisplayValue: jest.fn((url) => url),
      applyEnsNamePreservation: jest.fn((display) => display),
    }));

    const mod = await import('./page-context-menu.js');

    expect(() => {
      mod.showPageContextMenu(10, 20, { pageUrl: 'https://example.com' });
      mod.hidePageContextMenu();
      mod.setupWebviewContextMenu(null);
    }).not.toThrow();

    await expect(mod.initPageContextMenu()).resolves.toBeUndefined();
  });

  test('shows the correct group, updates navigation state, and repositions on screen bounds', async () => {
    const activeWebview = {
      canGoBack: jest.fn(() => true),
      canGoForward: jest.fn(() => false),
      goBack: jest.fn(),
      goForward: jest.fn(),
      reloadIgnoringCache: jest.fn(),
      openDevTools: jest.fn(),
      send: jest.fn(),
    };
    const { mod, pageContextMenu, pageGroup, selectionGroup, linkGroup, imageGroup, backBtn, forwardBtn, backdrop, pushDebug } =
      await loadPageContextMenuModule({ activeWebview });

    await mod.initPageContextMenu();

    expect(pushDebug).toHaveBeenCalledWith('[PageContextMenu] Initialized');

    mod.showPageContextMenu(790, 590, { imageSrc: 'https://example.com/image.png' });

    expect(imageGroup.classList.add).toHaveBeenCalledWith('visible');
    expect(backBtn.disabled).toBe(false);
    expect(forwardBtn.disabled).toBe(true);
    expect(backdrop.showMenuBackdrop).toHaveBeenCalled();
    expect(pageContextMenu.classList.remove).toHaveBeenCalledWith('hidden');
    expect(pageContextMenu.style.left).toBe('672px');
    expect(pageContextMenu.style.top).toBe('492px');

    mod.showPageContextMenu(20, 30, { linkUrl: 'https://example.com/link' });
    mod.showPageContextMenu(5, 6, { selectedText: 'selected text' });
    mod.showPageContextMenu(1, 2, { pageUrl: 'https://example.com/page' });

    expect(linkGroup.classList.add).toHaveBeenCalledWith('visible');
    expect(selectionGroup.classList.add).toHaveBeenCalledWith('visible');
    expect(pageGroup.classList.add).toHaveBeenCalledWith('visible');

    pageContextMenu.getBoundingClientRect.mockReturnValueOnce({
      left: 0,
      top: 0,
      right: 30,
      bottom: 40,
      width: 20,
      height: 20,
    });
    mod.showPageContextMenu(5, 6, { pageUrl: 'https://example.com/clamped' });

    expect(pageContextMenu.style.left).toBe('8px');
    expect(pageContextMenu.style.top).toBe('8px');

    activeWebview.canGoBack.mockImplementation(() => {
      throw new Error('no back state');
    });
    activeWebview.canGoForward.mockImplementation(() => {
      throw new Error('no forward state');
    });

    mod.showPageContextMenu(100, 110, { pageUrl: 'https://example.com/page' });

    expect(backBtn.disabled).toBe(true);
    expect(forwardBtn.disabled).toBe(true);
  });

  test('dispatches page and link actions through menu clicks', async () => {
    const { mod, pageContextMenu, activeWebview, electronAPI, pushDebug, backdrop, urlUtils } =
      await loadPageContextMenuModule();

    await mod.initPageContextMenu();

    const context = {
      pageUrl: 'https://example.com/page',
      linkUrl: 'https://example.com/link',
    };

    mod.showPageContextMenu(20, 30, context);
    await triggerMenuAction(pageContextMenu, 'back');
    expect(activeWebview.goBack).toHaveBeenCalled();

    mod.showPageContextMenu(20, 30, context);
    activeWebview.canGoForward.mockReturnValue(true);
    await triggerMenuAction(pageContextMenu, 'forward');
    expect(activeWebview.goForward).toHaveBeenCalled();

    mod.showPageContextMenu(20, 30, context);
    await triggerMenuAction(pageContextMenu, 'reload');
    expect(activeWebview.reloadIgnoringCache).toHaveBeenCalled();

    mod.showPageContextMenu(20, 30, context);
    await triggerMenuAction(pageContextMenu, 'view-source');
    expect(global.document.dispatchEvent).toHaveBeenCalledWith({
      type: 'open-url-new-tab',
      detail: { url: 'view-source:https://example.com/page' },
    });

    mod.showPageContextMenu(20, 30, context);
    await triggerMenuAction(pageContextMenu, 'inspect');
    expect(activeWebview.openDevTools).toHaveBeenCalled();

    mod.showPageContextMenu(20, 30, context);
    await triggerMenuAction(pageContextMenu, 'open-link-new-tab');
    expect(global.document.dispatchEvent).toHaveBeenCalledWith({
      type: 'open-url-new-tab',
      detail: { url: 'https://example.com/link' },
    });

    mod.showPageContextMenu(20, 30, context);
    await triggerMenuAction(pageContextMenu, 'open-link-new-window');
    expect(urlUtils.deriveDisplayValue).toHaveBeenCalledWith(
      'https://example.com/link',
      expect.any(String),
      '',
      expect.any(String),
      expect.any(String)
    );
    expect(electronAPI.openUrlInNewWindow).toHaveBeenCalledWith(
      'ens:derived:https://example.com/link'
    );

    mod.showPageContextMenu(20, 30, context);
    await triggerMenuAction(pageContextMenu, 'copy-link');
    expect(electronAPI.copyText).toHaveBeenCalledWith('ens:derived:https://example.com/link');
    expect(pushDebug).toHaveBeenCalledWith('Copied link: ens:derived:https://example.com/link');
    expect(backdrop.hideMenuBackdrop).toHaveBeenCalled();
  });

  test('handles selection and image actions, including clipboard and native fallbacks', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { mod, pageContextMenu, activeWebview, electronAPI, pushDebug, urlUtils } =
      await loadPageContextMenuModule();

    await mod.initPageContextMenu();

    mod.showPageContextMenu(20, 30, { selectedText: 'copied selection' });
    await triggerMenuAction(pageContextMenu, 'copy');
    expect(global.navigator.clipboard.writeText).toHaveBeenCalledWith('copied selection');
    expect(pushDebug).toHaveBeenCalledWith('Copied selected text');

    global.navigator.clipboard.writeText.mockRejectedValueOnce(new Error('clipboard blocked'));
    mod.showPageContextMenu(20, 30, { selectedText: 'fallback selection' });
    await triggerMenuAction(pageContextMenu, 'copy');
    expect(activeWebview.send).toHaveBeenCalledWith('context-menu-action', 'copy');

    mod.showPageContextMenu(20, 30, { imageSrc: 'https://example.com/image.png' });
    await triggerMenuAction(pageContextMenu, 'open-image-new-tab');
    expect(global.document.dispatchEvent).toHaveBeenCalledWith({
      type: 'open-url-new-tab',
      detail: { url: 'https://example.com/image.png' },
    });

    electronAPI.saveImage.mockResolvedValueOnce({
      success: true,
      filePath: '/tmp/image.png',
    });
    mod.showPageContextMenu(20, 30, { imageSrc: 'https://example.com/image.png' });
    await triggerMenuAction(pageContextMenu, 'save-image');
    expect(pushDebug).toHaveBeenCalledWith('Image saved to: /tmp/image.png');

    electronAPI.saveImage.mockResolvedValueOnce({
      error: 'disk full',
    });
    mod.showPageContextMenu(20, 30, { imageSrc: 'https://example.com/image.png' });
    await triggerMenuAction(pageContextMenu, 'save-image');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to save image:', 'disk full');

    electronAPI.copyImageFromUrl.mockResolvedValueOnce({
      success: true,
    });
    mod.showPageContextMenu(20, 30, { imageSrc: 'https://example.com/image.png' });
    await triggerMenuAction(pageContextMenu, 'copy-image');
    expect(pushDebug).toHaveBeenCalledWith('Copied image to clipboard');

    electronAPI.copyImageFromUrl.mockResolvedValueOnce({
      error: 'copy failed',
    });
    mod.showPageContextMenu(20, 30, { imageSrc: 'https://example.com/image.png' });
    await triggerMenuAction(pageContextMenu, 'copy-image');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to copy image:', 'copy failed');

    urlUtils.applyEnsNamePreservation.mockReturnValueOnce('');
    mod.showPageContextMenu(20, 30, { imageSrc: 'https://example.com/image.png' });
    await triggerMenuAction(pageContextMenu, 'copy-image-address');
    expect(electronAPI.copyText).toHaveBeenCalledWith('https://example.com/image.png');
  });

  test('closes on outside interactions and wires webview ipc context-menu events', async () => {
    const { mod, pageContextMenu, documentHandlers, windowHandlers, backdrop } =
      await loadPageContextMenuModule();

    await mod.initPageContextMenu();

    mod.showPageContextMenu(20, 30, { pageUrl: 'https://example.com/page' });
    pageContextMenu.contains.mockReturnValueOnce(false);
    documentHandlers.click({ target: {} });
    expect(pageContextMenu.classList.add).toHaveBeenCalledWith('hidden');
    expect(backdrop.hideMenuBackdrop).toHaveBeenCalled();

    mod.showPageContextMenu(20, 30, { pageUrl: 'https://example.com/page' });
    windowHandlers.blur();
    expect(pageContextMenu.classList.add).toHaveBeenCalledWith('hidden');

    const webviewHandlers = {};
    const webview = {
      addEventListener: jest.fn((event, handler) => {
        webviewHandlers[event] = handler;
      }),
      getBoundingClientRect: jest.fn(() => ({
        left: 25,
        top: 35,
      })),
    };

    mod.setupWebviewContextMenu(webview);
    pageContextMenu.getBoundingClientRect.mockReturnValueOnce({
      left: 0,
      top: 0,
      right: 60,
      bottom: 70,
      width: 25,
      height: 25,
    });
    webviewHandlers['ipc-message']({
      channel: 'context-menu',
      args: [{ x: 10, y: 15, pageUrl: 'https://example.com/from-webview' }],
    });

    expect(pageContextMenu.style.left).toBe('35px');
    expect(pageContextMenu.style.top).toBe('50px');
  });
});
