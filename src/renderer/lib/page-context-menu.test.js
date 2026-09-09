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
    focus: jest.fn(),
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
      focus: jest.fn(),
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
  const viewSourceBtn = createElement();
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
    '[data-action="view-source"]': viewSourceBtn,
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
    // page-urls.js resolves the shell's own `pages/*.html` URLs from these at
    // import time; the trust-interstitial test the view-source item is gated
    // on compares against the resolved base.
    location: { href: 'file:///app/index.html' },
    internalPages: { routable: { settings: 'settings.html' } },
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
    // Nothing in the chrome document holds focus until a test says so.
    activeElement: null,
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
    viewSourceBtn,
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
      location: { href: 'file:///app/index.html' },
      internalPages: { routable: {} },
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
    const {
      mod,
      pageContextMenu,
      pageGroup,
      selectionGroup,
      linkGroup,
      imageGroup,
      backBtn,
      forwardBtn,
      backdrop,
      pushDebug,
    } = await loadPageContextMenuModule({ activeWebview });

    await mod.initPageContextMenu();

    expect(pushDebug).toHaveBeenCalledWith('[PageContextMenu] Initialized');

    mod.showPageContextMenu(790, 590, { imageSrc: 'https://example.com/image.png' });

    expect(imageGroup.classList.add).toHaveBeenCalledWith('visible');
    expect(backBtn.disabled).toBe(false);
    expect(forwardBtn.disabled).toBe(true);
    expect(backdrop.showMenuBackdrop).toHaveBeenCalled();
    expect(pageContextMenu.classList.remove).toHaveBeenCalledWith('hidden');
    expect(pageContextMenu.style.left).toBe('672px');
    // Only 10 px below the pointer in a 600 px-tall window, so the menu opens
    // *upwards* from it — its bottom edge lands on the click (#324). It used
    // to be pushed down against the bottom edge instead, covering the pointer.
    expect(pageContextMenu.style.top).toBe('490px');

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

  test('withholds view source on browser-owned trust interstitials', async () => {
    const { mod, pageContextMenu, viewSourceBtn, pushDebug } = await loadPageContextMenuModule();

    await mod.initPageContextMenu();

    // Real content: the item is offered and dispatches as before.
    mod.showPageContextMenu(10, 10, { pageUrl: 'https://example.com/page' });
    expect(viewSourceBtn.classList.contains('hidden')).toBe(false);

    // The onchain trust gate. Its URL carries the single-use approval token,
    // so `view-source:` of it would publish the token and the on-disk path
    // into the new tab's address bar, tab title and window title (#235).
    const gateUrl =
      'file:///app/pages/onchain-unverified.html?target=web3%3A%2F%2F0x00000095643cffa7d9fae407a84dfcb6406456c6.eip155-1%2F&token=aaaabbbbccccddddeeeeffff';
    mod.showPageContextMenu(10, 10, { pageUrl: gateUrl });
    expect(viewSourceBtn.classList.contains('hidden')).toBe(true);

    global.document.dispatchEvent.mockClear();
    await triggerMenuAction(pageContextMenu, 'view-source');
    expect(global.document.dispatchEvent).not.toHaveBeenCalled();
    expect(pushDebug).toHaveBeenCalledWith(
      'Refusing view source for a browser-owned trust interstitial'
    );

    // Same for the name-resolution interstitials — same class of page, same
    // rule about the shell's own file:// URL reaching chrome.
    for (const url of [
      'file:///app/pages/ens-unverified.html?name=retry.tez',
      'file:///app/pages/ens-conflict.html?name=lagged.tez&block=%7B%7D',
    ]) {
      mod.showPageContextMenu(10, 10, { pageUrl: url });
      expect(viewSourceBtn.classList.contains('hidden')).toBe(true);
      global.document.dispatchEvent.mockClear();
      await triggerMenuAction(pageContextMenu, 'view-source');
      expect(global.document.dispatchEvent).not.toHaveBeenCalled();
    }

    // A remote look-alike path is ordinary content: still viewable.
    mod.showPageContextMenu(10, 10, {
      pageUrl: 'https://evil.test/pages/onchain-unverified.html?token=aaaa',
    });
    expect(viewSourceBtn.classList.contains('hidden')).toBe(false);
    global.document.dispatchEvent.mockClear();
    await triggerMenuAction(pageContextMenu, 'view-source');
    expect(global.document.dispatchEvent).toHaveBeenCalledWith({
      type: 'open-url-new-tab',
      detail: {
        url: 'view-source:https://evil.test/pages/onchain-unverified.html?token=aaaa',
      },
    });
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
      null,
      '',
      'http://freedom-ipfs.localhost/ipfs/',
      'http://freedom-ipfs.localhost/ipns/'
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
    expect(pushDebug).toHaveBeenCalledWith('Failed to save image: disk full');

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
    expect(pushDebug).toHaveBeenCalledWith('Failed to copy image: copy failed');

    urlUtils.applyEnsNamePreservation.mockReturnValueOnce('');
    mod.showPageContextMenu(20, 30, { imageSrc: 'https://example.com/image.png' });
    await triggerMenuAction(pageContextMenu, 'copy-image-address');
    expect(electronAPI.copyText).toHaveBeenCalledWith('https://example.com/image.png');
  });

  test('takes the keyboard from the guest and hands it back to the same page', async () => {
    const {
      mod,
      pageContextMenu,
      activeWebview,
      webviewContainer,
      documentHandlers,
      windowHandlers,
    } = await loadPageContextMenuModule();

    await mod.initPageContextMenu();

    // Opening the menu pulls focus out of the guest. Without this, an Escape
    // pressed over a focused `<webview>` never reaches the handler below —
    // which is the normal state since tab activation focuses the page (#304).
    mod.showPageContextMenu(20, 30, { pageUrl: 'https://example.com/page' });
    expect(pageContextMenu.focus).toHaveBeenCalled();

    // Escape dismisses and returns the keyboard to the page it was opened over.
    global.document.activeElement = pageContextMenu;
    pageContextMenu.contains.mockImplementation((el) => el === pageContextMenu);
    const escape = { key: 'Escape', preventDefault: jest.fn() };
    documentHandlers.keydown(escape);
    expect(pageContextMenu.classList.add).toHaveBeenCalledWith('hidden');
    expect(activeWebview.focus).toHaveBeenCalledTimes(1);
    // Closing the menu consumes the press — navigation.js's window-level
    // Escape (stop loading + restore the address bar) stands down on
    // `defaultPrevented`, so dismissing a context menu raised over a loading
    // page doesn't also cancel that load (#306).
    expect(escape.preventDefault).toHaveBeenCalled();

    // With the menu already down the press belongs to whatever is behind it.
    const escapeAgain = { key: 'Escape', preventDefault: jest.fn() };
    documentHandlers.keydown(escapeAgain);
    expect(escapeAgain.preventDefault).not.toHaveBeenCalled();

    // A click that moved focus elsewhere in chrome (the address bar) dismisses
    // the menu too — and must not yank focus back to the page.
    mod.showPageContextMenu(20, 30, { pageUrl: 'https://example.com/page' });
    global.document.activeElement = { id: 'address-input' };
    documentHandlers.click({ target: {} });
    expect(activeWebview.focus).toHaveBeenCalledTimes(1);

    // A window blur hides the menu without pulling focus back into a window
    // that is on its way out.
    mod.showPageContextMenu(20, 30, { pageUrl: 'https://example.com/page' });
    global.document.activeElement = pageContextMenu;
    windowHandlers.blur();
    expect(activeWebview.focus).toHaveBeenCalledTimes(1);

    // An action that moved the foreground on (open-link-new-tab, view-source)
    // leaves a different guest active: the new tab owns its own focus (#312),
    // so the menu never focuses the page it was opened over after the fact.
    mod.showPageContextMenu(20, 30, { pageUrl: 'https://example.com/page' });
    global.document.activeElement = pageContextMenu;
    webviewContainer.querySelector.mockReturnValue({ focus: jest.fn() });
    documentHandlers.keydown({ key: 'Escape', preventDefault: jest.fn() });
    expect(activeWebview.focus).toHaveBeenCalledTimes(1);
  });

  // #306, dialog sibling: a modal <dialog> raised over the menu is the top
  // layer, so the press is its own close request — and it cannot mark the
  // press the way this handler does. Consuming it here would cancel that close
  // outright, leaving the dialog open.
  test('a modal dialog above the menu owns the Escape', async () => {
    const { mod, pageContextMenu, documentHandlers } = await loadPageContextMenuModule();

    await mod.initPageContextMenu();
    mod.showPageContextMenu(20, 30, { pageUrl: 'https://example.com/page' });
    pageContextMenu.classList.add.mockClear();

    const dialog = { tagName: 'DIALOG' };
    global.document.querySelector = jest.fn((selector) =>
      selector === 'dialog[open]' ? dialog : null
    );

    const escape = { key: 'Escape', preventDefault: jest.fn() };
    documentHandlers.keydown(escape);
    expect(pageContextMenu.classList.add).not.toHaveBeenCalledWith('hidden');
    expect(escape.preventDefault).not.toHaveBeenCalled();

    // The dialog gone, the menu is innermost again and takes the next press.
    global.document.querySelector = jest.fn(() => null);
    const next = { key: 'Escape', preventDefault: jest.fn() };
    documentHandlers.keydown(next);
    expect(pageContextMenu.classList.add).toHaveBeenCalledWith('hidden');
    expect(next.preventDefault).toHaveBeenCalled();
  });

  test('still dismisses when the context went away before the action ran', async () => {
    const { mod, pageContextMenu, windowHandlers, backdrop } = await loadPageContextMenuModule();

    await mod.initPageContextMenu();

    mod.showPageContextMenu(20, 30, { pageUrl: 'https://example.com/page' });
    // A window blur nulls the context; the menu can still be on screen when a
    // click lands on it. The action is a no-op, but the menu must come down.
    windowHandlers.blur();
    pageContextMenu.classList.remove('hidden');
    pageContextMenu.classList.add.mockClear();
    backdrop.hideMenuBackdrop.mockClear();

    await triggerMenuAction(pageContextMenu, 'reload');

    expect(pageContextMenu.classList.add).toHaveBeenCalledWith('hidden');
    expect(backdrop.hideMenuBackdrop).toHaveBeenCalled();
  });

  // #308: a context menu describes one document. A navigation in the tab it
  // was raised on takes it down, and an action that somehow still reaches a
  // navigated-away page is dropped rather than applied to the old page's link.
  describe('navigation', () => {
    const withUrl = (url) => ({
      canGoBack: jest.fn(() => true),
      canGoForward: jest.fn(() => false),
      goBack: jest.fn(),
      goForward: jest.fn(),
      reloadIgnoringCache: jest.fn(),
      openDevTools: jest.fn(),
      send: jest.fn(),
      focus: jest.fn(),
      getURL: jest.fn(() => url),
    });

    test('a navigation in the menu\u2019s own tab dismisses it', async () => {
      const activeWebview = withUrl('bzz://page-a/');
      const { mod, pageContextMenu, backdrop } = await loadPageContextMenuModule({ activeWebview });
      await mod.initPageContextMenu();

      mod.showPageContextMenu(20, 30, {
        pageUrl: 'bzz://page-a/',
        linkUrl: 'bzz://page-c/',
      });
      pageContextMenu.classList.add.mockClear();
      backdrop.hideMenuBackdrop.mockClear();

      mod.notifyPageContextMenuNavigated(activeWebview);

      expect(pageContextMenu.classList.add).toHaveBeenCalledWith('hidden');
      expect(backdrop.hideMenuBackdrop).toHaveBeenCalled();
      // The document the keyboard would go back to is the one that just went
      // away, so the incoming page is left to take focus on its own terms.
      expect(activeWebview.focus).not.toHaveBeenCalled();
    });

    test('a navigation in another tab leaves it alone', async () => {
      const activeWebview = withUrl('bzz://page-a/');
      const { mod, pageContextMenu } = await loadPageContextMenuModule({ activeWebview });
      await mod.initPageContextMenu();

      mod.showPageContextMenu(20, 30, { pageUrl: 'bzz://page-a/' });
      pageContextMenu.classList.add.mockClear();

      mod.notifyPageContextMenuNavigated(withUrl('bzz://other-tab/'));

      expect(pageContextMenu.classList.add).not.toHaveBeenCalledWith('hidden');
    });

    test('a tab switch (no webview named) dismisses it', async () => {
      const activeWebview = withUrl('bzz://page-a/');
      const { mod, pageContextMenu } = await loadPageContextMenuModule({ activeWebview });
      await mod.initPageContextMenu();

      mod.showPageContextMenu(20, 30, { pageUrl: 'bzz://page-a/' });
      pageContextMenu.classList.add.mockClear();

      mod.notifyPageContextMenuNavigated();

      expect(pageContextMenu.classList.add).toHaveBeenCalledWith('hidden');
    });

    test('an item clicked after the page moved on acts on nothing', async () => {
      const activeWebview = withUrl('bzz://page-a/');
      const { mod, pageContextMenu, pushDebug } = await loadPageContextMenuModule({
        activeWebview,
      });
      await mod.initPageContextMenu();

      mod.showPageContextMenu(20, 30, {
        pageUrl: 'bzz://page-a/',
        linkUrl: 'bzz://page-c/',
      });

      // The page redirected itself and nothing told the menu — the belt to the
      // navigation braces above.
      activeWebview.getURL.mockReturnValue('bzz://page-b/');
      document.dispatchEvent.mockClear();
      pageContextMenu.classList.add.mockClear();

      await triggerMenuAction(pageContextMenu, 'open-link-new-tab');

      expect(document.dispatchEvent).not.toHaveBeenCalled();
      expect(pageContextMenu.classList.add).toHaveBeenCalledWith('hidden');
      expect(pushDebug).toHaveBeenCalledWith(expect.stringContaining('navigated away'));
    });

    test('an item clicked on the page it was raised on still acts', async () => {
      const activeWebview = withUrl('bzz://page-a/');
      const { mod, pageContextMenu } = await loadPageContextMenuModule({ activeWebview });
      await mod.initPageContextMenu();

      mod.showPageContextMenu(20, 30, {
        pageUrl: 'bzz://page-a/',
        linkUrl: 'bzz://page-c/',
      });
      document.dispatchEvent.mockClear();

      await triggerMenuAction(pageContextMenu, 'open-link-new-tab');

      expect(document.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'open-url-new-tab', detail: { url: 'bzz://page-c/' } })
      );
    });
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
