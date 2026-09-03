const originalWindow = global.window;
const originalDocument = global.document;

const createElement = () => {
  const handlers = {};

  return {
    handlers,
    classList: {
      toggle: jest.fn(),
      add: jest.fn(),
      remove: jest.fn(),
    },
    dataset: {},
    textContent: '',
    setAttribute: jest.fn(),
    addEventListener: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    contains: jest.fn(() => false),
    blur: jest.fn(),
    print: jest.fn(),
  };
};

const loadMenusModule = async ({ platform = 'darwin', webview } = {}) => {
  jest.resetModules();

  const menuButton = createElement();
  const menuDropdown = createElement();
  const historyBtn = createElement();
  const newTabMenuBtn = createElement();
  const newWindowMenuBtn = createElement();
  const zoomOutBtn = createElement();
  const zoomInBtn = createElement();
  const zoomLevelDisplay = createElement();
  const fullscreenBtn = createElement();
  const printBtn = createElement();
  const devtoolsBtn = createElement();
  const aboutBtn = createElement();
  const checkUpdatesBtn = createElement();
  const beeMenuButton = createElement();
  const beeMenuDropdown = createElement();
  const webviewElement = createElement();
  const beePeersCount = createElement();
  const beeNetworkPeers = createElement();
  const beeVersionText = createElement();
  const beeInfoPanel = createElement();

  const shortcutEls = [
    { dataset: { shortcut: 'CmdOrCtrl+Shift+T' }, textContent: '' },
    { dataset: { shortcut: 'Alt+CmdOrCtrl+I' }, textContent: '' },
    // History differs per platform (Cmd+Y on macOS, Ctrl+H elsewhere).
    { dataset: { shortcut: 'Cmd+Y', shortcutOther: 'Ctrl+H' }, textContent: '' },
  ];

  const documentHandlers = {};
  const windowHandlers = {};
  // Captures the View-menu zoom subscriptions so tests can fire them the way
  // the main process would.
  const zoomCallbacks = {};
  const electronAPI = {
    getPlatform: jest.fn().mockResolvedValue(platform),
    newWindow: jest.fn(),
    toggleFullscreen: jest.fn(),
    showAbout: jest.fn(),
    checkForUpdates: jest.fn(),
    onZoomIn: jest.fn((callback) => {
      zoomCallbacks.in = callback;
    }),
    onZoomOut: jest.fn((callback) => {
      zoomCallbacks.out = callback;
    }),
    onZoomReset: jest.fn((callback) => {
      zoomCallbacks.reset = callback;
    }),
  };
  const tabsMocks = {
    hideTabContextMenu: jest.fn(),
    getActiveWebview: jest.fn(() => webview || null),
  };
  const bookmarkMocks = {
    hideBookmarkContextMenu: jest.fn(),
    hideOverflowMenu: jest.fn(),
  };
  const backdropMocks = {
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  };
  const beeUiMocks = {
    startAntInfoPolling: jest.fn(),
    stopAntInfoPolling: jest.fn(),
  };
  const ipfsUiMocks = {
    startIpfsInfoPolling: jest.fn(),
    stopIpfsInfoPolling: jest.fn(),
  };
  const myotisUiMocks = {
    startMyotisInfoPolling: jest.fn(),
    stopMyotisInfoPolling: jest.fn(),
  };
  const radicleUiMocks = {
    startRadicleInfoUpdates: jest.fn(),
    stopRadicleInfoUpdates: jest.fn(),
  };

  global.window = {
    electronAPI,
    nodeConfig: {},
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };

  global.document = {
    getElementById: jest.fn((id) => {
      const map = {
        'menu-button': menuButton,
        'menu-dropdown': menuDropdown,
        'history-btn': historyBtn,
        'new-tab-menu-btn': newTabMenuBtn,
        'new-window-menu-btn': newWindowMenuBtn,
        'zoom-out-btn': zoomOutBtn,
        'zoom-in-btn': zoomInBtn,
        'zoom-level': zoomLevelDisplay,
        'fullscreen-btn': fullscreenBtn,
        'print-btn': printBtn,
        'devtools-btn': devtoolsBtn,
        'about-btn': aboutBtn,
        'check-updates-btn': checkUpdatesBtn,
        'bee-menu-button': beeMenuButton,
        'bee-menu-dropdown': beeMenuDropdown,
        'bzz-webview': webviewElement,
        'bee-peers-count': beePeersCount,
        'bee-network-peers': beeNetworkPeers,
        'bee-version-text': beeVersionText,
      };

      return map[id] || null;
    }),
    querySelector: jest.fn((selector) => (selector === '.bee-info' ? beeInfoPanel : null)),
    querySelectorAll: jest.fn(() => shortcutEls),
    addEventListener: jest.fn((event, handler) => {
      documentHandlers[event] = handler;
    }),
  };

  jest.doMock('./tabs.js', () => tabsMocks);
  jest.doMock('./bookmarks-ui.js', () => bookmarkMocks);
  jest.doMock('./menu-backdrop.js', () => backdropMocks);
  jest.doMock('./ant-ui.js', () => beeUiMocks);
  jest.doMock('./ipfs-ui.js', () => ipfsUiMocks);
  jest.doMock('./myotis-ui.js', () => myotisUiMocks);
  jest.doMock('./radicle-ui.js', () => radicleUiMocks);

  const menus = await import('./menus.js');
  const stateModule = await import('./state.js');
  // Same module instance menus.js resolves matchesShortcut through, so the
  // platform can be pinned instead of sniffed from a jsdom-less navigator.
  const shortcuts = await import('./shortcuts.js');
  shortcuts.configureShortcuts({ platform, overrides: {} });

  return {
    menus,
    shortcuts,
    state: stateModule.state,
    elements: {
      menuButton,
      menuDropdown,
      historyBtn,
      newTabMenuBtn,
      newWindowMenuBtn,
      zoomOutBtn,
      zoomInBtn,
      zoomLevelDisplay,
      fullscreenBtn,
      printBtn,
      devtoolsBtn,
      aboutBtn,
      checkUpdatesBtn,
      beeMenuButton,
      beeMenuDropdown,
      webviewElement,
      beePeersCount,
      beeNetworkPeers,
      beeVersionText,
      beeInfoPanel,
      shortcutEls,
    },
    handlers: {
      documentHandlers,
      windowHandlers,
    },
    mocks: {
      electronAPI,
      zoomCallbacks,
      tabsMocks,
      bookmarkMocks,
      backdropMocks,
      beeUiMocks,
      ipfsUiMocks,
      myotisUiMocks,
      radicleUiMocks,
    },
  };
};

describe('menus', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
  });

  test('formats shortcuts and toggles the main menu state', async () => {
    const webview = {
      getZoomFactor: jest.fn(() => 1.25),
    };
    const { menus, state, elements, mocks } = await loadMenusModule({ webview });
    const onMenuOpening = jest.fn();

    menus.setOnMenuOpening(onMenuOpening);
    menus.initMenus();
    await Promise.resolve();

    expect(elements.shortcutEls[0].textContent).toBe('⌘⇧T');
    expect(elements.shortcutEls[1].textContent).toBe('⌥⌘I');
    expect(elements.shortcutEls[2].textContent).toBe('⌘Y');

    elements.menuButton.handlers.click();

    expect(state.menuOpen).toBe(true);
    expect(elements.menuDropdown.classList.toggle).toHaveBeenCalledWith('open', true);
    expect(elements.menuButton.setAttribute).toHaveBeenCalledWith('aria-expanded', 'true');
    expect(mocks.tabsMocks.hideTabContextMenu).toHaveBeenCalled();
    expect(mocks.bookmarkMocks.hideBookmarkContextMenu).toHaveBeenCalled();
    expect(mocks.bookmarkMocks.hideOverflowMenu).toHaveBeenCalled();
    expect(mocks.backdropMocks.showMenuBackdrop).toHaveBeenCalled();
    expect(onMenuOpening).toHaveBeenCalled();
    expect(elements.zoomLevelDisplay.textContent).toBe('125%');

    menus.closeMenus();

    expect(state.menuOpen).toBe(false);
    expect(elements.menuDropdown.classList.toggle).toHaveBeenCalledWith('open', false);
  });

  test('handles menu actions and zoom controls through registered click handlers', async () => {
    let zoomFactor = 1;
    const webview = {
      getZoomFactor: jest.fn(() => zoomFactor),
      setZoomFactor: jest.fn((next) => {
        zoomFactor = next;
      }),
      print: jest.fn(),
      isDevToolsOpened: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      openDevTools: jest.fn(),
      closeDevTools: jest.fn(),
    };
    const { menus, elements, mocks } = await loadMenusModule({ platform: 'win32', webview });
    const onNewTab = jest.fn();
    const onOpenHistory = jest.fn();

    menus.setOnNewTab(onNewTab);
    menus.setOnOpenHistory(onOpenHistory);
    menus.initMenus();
    await Promise.resolve();

    // Off macOS the hint must show the binding this platform actually has
    // (Ctrl+H), not the mac-only Cmd+Y.
    expect(elements.shortcutEls[0].textContent).toBe('CtrlShiftT');
    expect(elements.shortcutEls[2].textContent).toBe('CtrlH');

    elements.newTabMenuBtn.handlers.click();
    elements.newWindowMenuBtn.handlers.click();
    elements.historyBtn.handlers.click();
    elements.zoomInBtn.handlers.click();
    elements.zoomOutBtn.handlers.click();
    elements.fullscreenBtn.handlers.click();
    elements.printBtn.handlers.click();
    elements.devtoolsBtn.handlers.click();
    elements.devtoolsBtn.handlers.click();
    elements.aboutBtn.handlers.click();
    elements.checkUpdatesBtn.handlers.click();

    expect(onNewTab).toHaveBeenCalled();
    expect(mocks.electronAPI.newWindow).toHaveBeenCalled();
    expect(onOpenHistory).toHaveBeenCalled();
    expect(webview.setZoomFactor).toHaveBeenCalledWith(1.1);
    expect(webview.setZoomFactor).toHaveBeenCalledWith(1);
    expect(mocks.electronAPI.toggleFullscreen).toHaveBeenCalled();
    expect(webview.print).toHaveBeenCalled();
    expect(webview.openDevTools).toHaveBeenCalled();
    expect(webview.closeDevTools).toHaveBeenCalled();
    expect(mocks.electronAPI.showAbout).toHaveBeenCalled();
    expect(mocks.electronAPI.checkForUpdates).toHaveBeenCalled();
  });

  test('zoom shortcuts share the hamburger buttons code path and keep the readout in sync', async () => {
    let zoomFactor = 1;
    const webview = {
      getZoomFactor: jest.fn(() => zoomFactor),
      setZoomFactor: jest.fn((next) => {
        zoomFactor = next;
      }),
    };
    const { menus, elements, handlers, mocks } = await loadMenusModule({
      platform: 'darwin',
      webview,
    });

    menus.initMenus();
    await Promise.resolve();

    // View-menu accelerator → main → renderer.
    mocks.zoomCallbacks.in();
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1.1);
    expect(elements.zoomLevelDisplay.textContent).toBe('110%');

    mocks.zoomCallbacks.out();
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1);

    mocks.zoomCallbacks.in();
    mocks.zoomCallbacks.reset();
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1);
    expect(elements.zoomLevelDisplay.textContent).toBe('100%');

    // Keydown fallback — the only path on the Linux frameless setups where
    // menu accelerators never reach the app.
    const preventDefault = jest.fn();
    handlers.windowHandlers.keydown({
      key: '=',
      code: 'Equal',
      metaKey: true,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1.1);

    handlers.windowHandlers.keydown({
      key: '-',
      code: 'Minus',
      metaKey: true,
      preventDefault: jest.fn(),
    });
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1);

    handlers.windowHandlers.keydown({
      key: '0',
      code: 'Digit0',
      metaKey: true,
      preventDefault: jest.fn(),
    });
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1);

    // An unrelated chord must not move the zoom.
    webview.setZoomFactor.mockClear();
    handlers.windowHandlers.keydown({
      key: '=',
      code: 'Equal',
      preventDefault: jest.fn(),
    });
    expect(webview.setZoomFactor).not.toHaveBeenCalled();
  });

  test('a Nordic Ctrl++ zooms in, not out (the fallback chain order is load-bearing)', async () => {
    // Swedish/Norwegian/Danish/Finnish layouts have `+` unshifted at the US
    // `Minus` position, so Ctrl+`+` arrives as { key: '+', code: 'Minus' }
    // and matches page.zoomIn (via the CmdOrCtrl+Plus alias) *and*
    // page.zoomOut (via the `-` its code implies). The if/else-if order in
    // menus.js decides which wins; reordering it, or splitting the chain
    // into independent ifs, turns Nordic zoom-in into zoom-out. Fail here
    // if that happens.
    let zoomFactor = 1;
    const webview = {
      getZoomFactor: jest.fn(() => zoomFactor),
      setZoomFactor: jest.fn((next) => {
        zoomFactor = next;
      }),
    };
    const { menus, elements, handlers } = await loadMenusModule({ platform: 'linux', webview });

    menus.initMenus();
    await Promise.resolve();

    const preventDefault = jest.fn();
    handlers.windowHandlers.keydown({
      key: '+',
      code: 'Minus',
      ctrlKey: true,
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(webview.setZoomFactor).toHaveBeenCalledTimes(1);
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1.1);
    expect(elements.zoomLevelDisplay.textContent).toBe('110%');
    // Belt and braces: zoom out would have produced 0.9.
    expect(webview.setZoomFactor).not.toHaveBeenCalledWith(0.9);

    // The unambiguous Nordic zoom-out chord (Shift+`+` types `?` there, so
    // users reach it via the keypad or a plain `-` on other layouts) still
    // zooms out — the ordering fix must not swallow zoom out entirely.
    handlers.windowHandlers.keydown({
      key: '-',
      code: 'NumpadSubtract',
      ctrlKey: true,
      preventDefault: jest.fn(),
    });
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1);
  });

  test('zoom clamps at both ends and tolerates a webview that is not dom-ready', async () => {
    let zoomFactor = 5;
    const webview = {
      getZoomFactor: jest.fn(() => zoomFactor),
      setZoomFactor: jest.fn((next) => {
        zoomFactor = next;
      }),
    };
    const { menus, elements, mocks } = await loadMenusModule({ platform: 'darwin', webview });

    menus.initMenus();
    await Promise.resolve();

    elements.zoomInBtn.handlers.click();
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(5);

    zoomFactor = 0.25;
    elements.zoomOutBtn.handlers.click();
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(0.25);

    // getZoomFactor throws until the webview is attached and dom-ready.
    webview.getZoomFactor.mockImplementationOnce(() => {
      throw new Error('The WebView must be attached to the DOM');
    });
    webview.setZoomFactor.mockClear();
    expect(() => mocks.zoomCallbacks.in()).not.toThrow();
    expect(webview.setZoomFactor).not.toHaveBeenCalled();

    // No active webview at all is a no-op, not a crash.
    mocks.tabsMocks.getActiveWebview.mockReturnValueOnce(null);
    expect(() => mocks.zoomCallbacks.reset()).not.toThrow();
  });

  test('opens and closes the bee menu while managing polling and backdrop state', async () => {
    const { menus, state, elements, mocks } = await loadMenusModule();

    menus.initMenus();
    state.antVersionFetched = true;
    state.antVersionValue = '1.2.3';
    elements.beePeersCount.textContent = '5';
    elements.beeNetworkPeers.textContent = '8';

    menus.setAntMenuOpen(true);

    expect(state.antMenuOpen).toBe(true);
    expect(elements.beeMenuDropdown.classList.toggle).toHaveBeenCalledWith('open', true);
    expect(mocks.beeUiMocks.startAntInfoPolling).toHaveBeenCalled();
    expect(mocks.ipfsUiMocks.startIpfsInfoPolling).toHaveBeenCalled();
    expect(mocks.myotisUiMocks.startMyotisInfoPolling).toHaveBeenCalled();
    expect(mocks.radicleUiMocks.startRadicleInfoUpdates).toHaveBeenCalled();
    expect(mocks.backdropMocks.showMenuBackdrop).toHaveBeenCalled();

    menus.setAntMenuOpen(false);

    expect(state.antMenuOpen).toBe(false);
    expect(mocks.beeUiMocks.stopAntInfoPolling).toHaveBeenCalled();
    expect(mocks.ipfsUiMocks.stopIpfsInfoPolling).toHaveBeenCalled();
    expect(mocks.myotisUiMocks.stopMyotisInfoPolling).toHaveBeenCalled();
    expect(mocks.radicleUiMocks.stopRadicleInfoUpdates).toHaveBeenCalled();
    expect(elements.beePeersCount.textContent).toBe('0');
    expect(elements.beeNetworkPeers.textContent).toBe('0');
    expect(elements.beeVersionText.textContent).toBe('1.2.3');
    expect(elements.beeInfoPanel.classList.remove).toHaveBeenCalledWith('visible');
    expect(mocks.backdropMocks.hideMenuBackdrop).toHaveBeenCalled();
  });

  test('closes menus on outside clicks, webview interaction, and window blur', async () => {
    const { menus, state, elements, handlers } = await loadMenusModule();

    menus.initMenus();
    menus.setMenuOpen(true);
    menus.setAntMenuOpen(true);

    handlers.documentHandlers.click({ target: {} });
    elements.webviewElement.handlers.focus();
    handlers.windowHandlers.blur();

    expect(state.menuOpen).toBe(false);
    expect(state.antMenuOpen).toBe(false);
  });
});
