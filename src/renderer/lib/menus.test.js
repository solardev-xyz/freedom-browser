const fs = require('fs');
const path = require('path');

const { SUBMENU_CLOSE_DELAY_MS } = require('./submenu-hover.js');

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

const DEFAULT_SHORTCUT_HINTS = [
  { shortcut: 'CmdOrCtrl+Shift+T' },
  { shortcut: 'Alt+CmdOrCtrl+I' },
  // History differs per platform (Cmd+Y on macOS, Ctrl+H elsewhere).
  { shortcut: 'Cmd+Y', shortcutOther: 'Ctrl+H' },
];

const loadMenusModule = async ({
  platform = 'darwin',
  webview,
  shortcutHints = DEFAULT_SHORTCUT_HINTS,
  // Load the real ant-ui.js instead of the stub, so a test can check what the
  // Nodes menu's Ant readouts actually say after menus.js closes the dropdown.
  realAntUi = false,
} = {}) => {
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
  // Profiles flyout (#301). The wrapper holds BOTH the trigger row and the
  // flyout, so `contains` is what tells a sibling row apart from the submenu.
  const profileMenuBtn = createElement();
  const profileFlyout = createElement();
  profileFlyout.hidden = true;
  const profileMenuWrap = createElement();
  profileMenuWrap.contains = jest.fn(
    (node) => node === profileMenuWrap || node === profileMenuBtn || node === profileFlyout
  );
  const beePeersCount = createElement();
  const beeNetworkPeers = createElement();
  const beeVersionText = createElement();
  const beeInfoPanel = createElement();

  const shortcutEls = shortcutHints.map((dataset) => ({ dataset: { ...dataset }, textContent: '' }));

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
        'profile-menu-wrap': profileMenuWrap,
        'profile-menu-btn': profileMenuBtn,
        'profile-menu': profileFlyout,
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
  // doMock survives resetModules, so the real-module case has to opt back out
  // explicitly rather than just skipping the doMock call.
  if (realAntUi) jest.dontMock('./ant-ui.js');
  else jest.doMock('./ant-ui.js', () => beeUiMocks);
  jest.doMock('./ipfs-ui.js', () => ipfsUiMocks);
  jest.doMock('./myotis-ui.js', () => myotisUiMocks);
  jest.doMock('./radicle-ui.js', () => radicleUiMocks);

  const menus = await import('./menus.js');
  const antUi = realAntUi ? await import('./ant-ui.js') : null;
  const stateModule = await import('./state.js');
  // Same module instance menus.js resolves matchesShortcut through, so the
  // platform can be pinned instead of sniffed from a jsdom-less navigator.
  const shortcuts = await import('./shortcuts.js');
  shortcuts.configureShortcuts({ platform, overrides: {} });

  return {
    menus,
    antUi,
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
      profileMenuWrap,
      profileMenuBtn,
      profileFlyout,
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

// The hamburger hints markup is the source of truth for what the menu
// offers; pull the real values so this test can't drift from index.html.
const readIndexHintDatasets = () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  return [...html.matchAll(/<span[^>]*class="menu-item-shortcut"[^>]*>/gs)].map((match) => {
    const tag = match[0];
    const shortcut = /data-shortcut="([^"]+)"/.exec(tag)?.[1];
    const shortcutOther = /data-shortcut-other="([^"]+)"/.exec(tag)?.[1];
    return shortcutOther ? { shortcut, shortcutOther } : { shortcut };
  });
};

// #227: every numeric counter row in the Nodes menu shares one empty-state
// representation ('0'); '--' stays reserved for the non-numeric rows
// (Version, Finalized Block). Read the real dropdown markup so a counter
// can't drift back to '--' — including one added later.
const readNodesMenuCounterDefaults = () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dropdown = html.slice(
    html.indexOf('id="bee-menu-dropdown"'),
    html.indexOf('id="wallet-toggle-btn"')
  );
  return [...dropdown.matchAll(/<span id="([\w-]+(?:-count|-peers))">([^<]*)<\/span>/g)].map(
    ([, id, text]) => [id, text]
  );
};

describe('menus', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
  });

  // #225: formatShortcut used to strip every '+' on every platform, so the
  // hamburger read 'CtrlT'/'CtrlShiftN' on Linux/Windows while Settings >
  // Shortcuts read 'Ctrl+T'/'Ctrl+Shift+N' for the same binding.
  describe.each(['linux', 'win32'])('hamburger shortcut hints on %s', (platform) => {
    test('keep the + separator, matching Settings > Shortcuts', async () => {
      const { menus, elements } = await loadMenusModule({
        platform,
        shortcutHints: readIndexHintDatasets(),
      });

      menus.initMenus();
      await Promise.resolve();

      expect(elements.shortcutEls.map((el) => el.textContent)).toEqual([
        'Ctrl+T',
        'Ctrl+N',
        'Ctrl+Shift+N',
        'Ctrl+H',
        'Ctrl+Alt+I',
      ]);
    });
  });

  // #227: the Radicle row used to be the odd one out at '--'; the Swarm and
  // IPFS rows were the odd ones out the other way once it moved to '0'.
  test('every Nodes menu counter starts at 0, not --', () => {
    const counters = readNodesMenuCounterDefaults();

    expect(counters.map(([id]) => id)).toEqual([
      'bee-peers-count',
      'bee-network-peers',
      'ipfs-active-requests-count',
      'myotis-peers-count',
      'myotis-gnosis-peers-count',
      'radicle-peers-count',
      'radicle-repos-count',
    ]);
    expect(counters.filter(([, text]) => text !== '0')).toEqual([]);
  });

  test('hamburger shortcut hints render as mac glyph runs on darwin', async () => {
    const { menus, elements } = await loadMenusModule({
      platform: 'darwin',
      shortcutHints: readIndexHintDatasets(),
    });

    menus.initMenus();
    await Promise.resolve();

    expect(elements.shortcutEls.map((el) => el.textContent)).toEqual([
      '⌘T',
      '⌘N',
      '⇧⌘N',
      '⌘Y',
      '⌥⌘I',
    ]);
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

    // Same glyph run Settings > Shortcuts renders (⌃⌥⇧⌘ order, per Apple's
    // menu convention) — both surfaces share formatAccelerator now (#225).
    expect(elements.shortcutEls[0].textContent).toBe('⇧⌘T');
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
    // (Ctrl+H), not the mac-only Cmd+Y — spelled with the '+' separator
    // Settings > Shortcuts uses (#225), not the old 'CtrlShiftT'.
    expect(elements.shortcutEls[0].textContent).toBe('Ctrl+Shift+T');
    expect(elements.shortcutEls[2].textContent).toBe('Ctrl+H');

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
    elements.beePeersCount.textContent = '5';
    elements.beeNetworkPeers.textContent = '8';
    elements.beeVersionText.textContent = 'Ant v0.5.8';

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
    // Resetting the Ant readouts is stopAntInfoPolling's job (stubbed here);
    // menus.js keeps no second copy of those empty-state rules.
    expect(elements.beePeersCount.textContent).toBe('5');
    expect(elements.beeNetworkPeers.textContent).toBe('8');
    expect(elements.beeVersionText.textContent).toBe('Ant v0.5.8');
    expect(elements.beeInfoPanel.classList.remove).not.toHaveBeenCalled();
    expect(mocks.backdropMocks.hideMenuBackdrop).toHaveBeenCalled();
  });

  // #253: closing the Nodes menu used to re-blank the Version row whenever the
  // one-shot /health fetch had not settled yet, undoing the 'Unknown' that
  // ant-ui.js had just written. The readouts belong to ant-ui.js alone now, so
  // this runs the real module rather than the stub.
  test('closing the Nodes menu leaves an unfetched Version row reading Unknown', async () => {
    const { menus, antUi, state, elements } = await loadMenusModule({ realAntUi: true });

    menus.initMenus();
    antUi.initAntUi();
    state.antVersionFetched = false;
    state.antVersionValue = '';
    elements.beeVersionText.textContent = 'Ant v0.5.8';

    menus.setAntMenuOpen(false);

    expect(elements.beeVersionText.textContent).toBe('Unknown');
  });

  // #301: Chrome's submenu model — only one submenu open at a time, so a
  // hover/focus on any other hamburger row dismisses the Profiles flyout. The
  // pointer path keeps a short intent delay because the flyout is anchored to
  // the LEFT of the menu: travelling into it from the Profiles row crosses the
  // rows below first, and cutting that move off is the bug this delay avoids.
  describe('profiles flyout dismissal (#301)', () => {
    const openFlyout = async () => {
      const loaded = await loadMenusModule();
      loaded.menus.initMenus();
      loaded.menus.setMenuOpen(true);
      loaded.elements.profileFlyout.hidden = false;
      return loaded;
    };

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('hovering a sibling row closes it, after the intent delay', async () => {
      const { elements } = await openFlyout();

      elements.menuDropdown.handlers.mouseover({ target: elements.newTabMenuBtn });
      jest.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS - 1);
      expect(elements.profileFlyout.hidden).toBe(false);

      jest.advanceTimersByTime(1);
      expect(elements.profileFlyout.hidden).toBe(true);
      expect(elements.profileMenuBtn.setAttribute).toHaveBeenCalledWith('aria-expanded', 'false');
      expect(elements.profileMenuWrap.classList.remove).toHaveBeenCalledWith('flyout-open');
    });

    // Empty menu chrome counts as "another part of the menu", not as still
    // being on the flyout: a divider or the dropdown's own padding is outside
    // #profile-menu-wrap, so it dismisses the flyout like any row would. Pinned
    // because the index.js/menus.js comments document exactly this, and a
    // future reader could otherwise mistake it for a bug and "fix" it.
    test('hovering empty menu chrome (divider, dropdown padding) closes it', async () => {
      for (const chrome of ['divider', 'padding']) {
        const { elements } = await openFlyout();
        const target = chrome === 'divider' ? createElement() : elements.menuDropdown;

        elements.menuDropdown.handlers.mouseover({ target });
        jest.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS);

        expect(elements.profileFlyout.hidden).toBe(true);
      }
    });

    test('a diagonal move into the flyout during the delay keeps it open', async () => {
      const { elements } = await openFlyout();

      // Cross the row below the Profiles row on the way to the flyout …
      elements.menuDropdown.handlers.mouseover({ target: elements.newTabMenuBtn });
      jest.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS - 20);
      // … and land in the flyout before the close fires.
      elements.menuDropdown.handlers.mouseover({ target: elements.profileFlyout });
      jest.advanceTimersByTime(5000);

      expect(elements.profileFlyout.hidden).toBe(false);
    });

    test('hovering the Profiles row itself never closes it', async () => {
      const { elements } = await openFlyout();

      elements.menuDropdown.handlers.mouseover({ target: elements.profileMenuBtn });
      jest.advanceTimersByTime(5000);

      expect(elements.profileFlyout.hidden).toBe(false);
    });

    test('focus on a sibling row closes it at once; focus inside it does not', async () => {
      const { elements } = await openFlyout();

      // Keyboard moves are deliberate: no intent delay, or the flyout would
      // sit over the row that just took focus.
      elements.menuDropdown.handlers.focusin({ target: elements.newTabMenuBtn });
      expect(elements.profileFlyout.hidden).toBe(true);

      // Tabbing through the flyout's own rows leaves it open.
      elements.profileFlyout.hidden = false;
      elements.menuDropdown.handlers.focusin({ target: elements.profileFlyout });
      expect(elements.profileFlyout.hidden).toBe(false);
    });

    test('a pending close is dropped when the hamburger itself closes', async () => {
      const { menus, elements } = await openFlyout();

      elements.menuDropdown.handlers.mouseover({ target: elements.newTabMenuBtn });
      menus.setMenuOpen(false);
      expect(elements.profileFlyout.hidden).toBe(true);

      // The stale timer must not fire against a flyout the user has since
      // reopened (reopening happens on hover, well inside the delay window).
      elements.profileFlyout.hidden = false;
      jest.advanceTimersByTime(5000);
      expect(elements.profileFlyout.hidden).toBe(false);
    });
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
