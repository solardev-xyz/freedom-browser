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
  ];

  const documentHandlers = {};
  const windowHandlers = {};
  const electronAPI = {
    getPlatform: jest.fn().mockResolvedValue(platform),
    newWindow: jest.fn(),
    toggleFullscreen: jest.fn(),
    showAbout: jest.fn(),
    checkForUpdates: jest.fn(),
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
    startBeeInfoPolling: jest.fn(),
    stopBeeInfoPolling: jest.fn(),
  };
  const ipfsUiMocks = {
    startIpfsInfoPolling: jest.fn(),
    stopIpfsInfoPolling: jest.fn(),
  };
  const radicleUiMocks = {
    startRadicleInfoPolling: jest.fn(),
    stopRadicleInfoPolling: jest.fn(),
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
  jest.doMock('./bee-ui.js', () => beeUiMocks);
  jest.doMock('./ipfs-ui.js', () => ipfsUiMocks);
  jest.doMock('./radicle-ui.js', () => radicleUiMocks);

  const menus = await import('./menus.js');
  const stateModule = await import('./state.js');

  return {
    menus,
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
      tabsMocks,
      bookmarkMocks,
      backdropMocks,
      beeUiMocks,
      ipfsUiMocks,
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

  test('opens and closes the bee menu while managing polling and backdrop state', async () => {
    const { menus, state, elements, mocks } = await loadMenusModule();

    menus.initMenus();
    state.beeVersionFetched = true;
    state.beeVersionValue = '1.2.3';
    elements.beePeersCount.textContent = '5';
    elements.beeNetworkPeers.textContent = '8';

    menus.setBeeMenuOpen(true);

    expect(state.beeMenuOpen).toBe(true);
    expect(elements.beeMenuDropdown.classList.toggle).toHaveBeenCalledWith('open', true);
    expect(mocks.beeUiMocks.startBeeInfoPolling).toHaveBeenCalled();
    expect(mocks.ipfsUiMocks.startIpfsInfoPolling).toHaveBeenCalled();
    expect(mocks.radicleUiMocks.startRadicleInfoPolling).toHaveBeenCalled();
    expect(mocks.backdropMocks.showMenuBackdrop).toHaveBeenCalled();

    menus.setBeeMenuOpen(false);

    expect(state.beeMenuOpen).toBe(false);
    expect(mocks.beeUiMocks.stopBeeInfoPolling).toHaveBeenCalled();
    expect(mocks.ipfsUiMocks.stopIpfsInfoPolling).toHaveBeenCalled();
    expect(mocks.radicleUiMocks.stopRadicleInfoPolling).toHaveBeenCalled();
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
    menus.setBeeMenuOpen(true);

    handlers.documentHandlers.click({ target: {} });
    elements.webviewElement.handlers.focus();
    handlers.windowHandlers.blur();

    expect(state.menuOpen).toBe(false);
    expect(state.beeMenuOpen).toBe(false);
  });
});
