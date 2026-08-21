// Tab audio indicator + click-to-mute. Uses the same fake-DOM module
// harness as tabs-ui.test.js, extended with the audio webview surface
// (setAudioMuted / isCurrentlyAudible) and the mute context-menu action.

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const HOME_URL = 'freedom://home';

const createElectronApi = (options = {}) => {
  const handlers = {};
  const register = (name) =>
    jest.fn((callback) => {
      handlers[name] = callback;
    });

  return {
    handlers,
    api: {
      setWindowTitle: jest.fn(),
      updateTabMenuState: jest.fn(),
      closeWindow: jest.fn(),
      copyText: jest.fn().mockResolvedValue(true),
      getSettings: jest.fn().mockResolvedValue(options.settings || {}),
      getWebviewPreloadPath: jest.fn().mockResolvedValue('/tmp/webview-preload.js'),
      getCachedFavicon: jest.fn().mockResolvedValue('data:image/png;base64,favicon'),
      onNewTab: register('newTab'),
      onCloseTab: register('closeTab'),
      onNewTabWithUrl: register('newTabWithUrl'),
      onNavigateToUrl: register('navigateToUrl'),
      onLoadUrl: register('loadUrl'),
      onToggleDevTools: register('toggleDevTools'),
      onCloseDevTools: register('closeDevTools'),
      onCloseAllDevTools: register('closeAllDevTools'),
      onFocusAddressBar: register('focusAddressBar'),
      onReload: register('reload'),
      onHardReload: register('hardReload'),
      onNextTab: register('nextTab'),
      onPrevTab: register('prevTab'),
      onMoveTabLeft: register('moveTabLeft'),
      onMoveTabRight: register('moveTabRight'),
      onReopenClosedTab: register('reopenClosedTab'),
    },
  };
};

const createWebview = (createdWebviews) => {
  const webview = createElement('webview');
  const addEventListener = webview.addEventListener.bind(webview);
  const removeEventListener = webview.removeEventListener.bind(webview);

  webview.addEventListener = jest.fn((event, handler) => {
    addEventListener(event, handler);
  });
  webview.removeEventListener = jest.fn((event, handler) => {
    removeEventListener(event, handler);
  });
  webview._devToolsOpen = false;
  webview._audioMuted = false;
  webview._audible = false;
  webview.getURL = jest.fn(() => webview.src || 'about:blank');
  webview.setAudioMuted = jest.fn((muted) => {
    webview._audioMuted = muted;
  });
  webview.isAudioMuted = jest.fn(() => webview._audioMuted);
  webview.isCurrentlyAudible = jest.fn(() => webview._audible);
  webview.openDevTools = jest.fn(() => {
    webview._devToolsOpen = true;
  });
  webview.closeDevTools = jest.fn(() => {
    webview._devToolsOpen = false;
  });
  webview.isDevToolsOpened = jest.fn(() => webview._devToolsOpen);
  createdWebviews.push(webview);
  return webview;
};

const CONTEXT_MENU_ACTIONS = ['close', 'close-others', 'close-right', 'pin', 'mute'];

const buildTabContextMenu = () => {
  const tabContextMenu = createElement('div', { classes: ['hidden'] });
  const actions = {};

  CONTEXT_MENU_ACTIONS.forEach((action) => {
    const button = createElement('button');
    button.dataset.action = action;
    tabContextMenu.appendChild(button);
    actions[action] = button;
  });

  return { tabContextMenu, actions };
};

const loadTabsModule = async (options = {}) => {
  jest.resetModules();

  const createdWebviews = [];
  const { api: electronAPI, handlers: electronHandlers } = createElectronApi(options);
  const tabBar = createElement('div');
  const newTabBtn = createElement('button');
  const webviewContainer = createElement('div');
  const bzzWebview = createElement('webview');
  const addressInput = createElement('input');
  const { tabContextMenu, actions } = buildTabContextMenu();
  const document = createDocument({
    elementsById: {
      'tab-bar': tabBar,
      'new-tab-btn': newTabBtn,
      'webview-container': webviewContainer,
      'tab-context-menu': tabContextMenu,
      'bzz-webview': bzzWebview,
      'address-input': addressInput,
    },
    createElementOverride: (tagName) => {
      if (tagName === 'webview') {
        return createWebview(createdWebviews);
      }
      return createElement(tagName);
    },
  });
  const windowHandlers = {};

  addressInput.focus = jest.fn();
  addressInput.select = jest.fn();

  global.window = {
    electronAPI,
    innerWidth: 800,
    innerHeight: 600,
    location: {
      href: 'file:///app/index.html',
      search: options.search || '',
    },
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };

  global.document = document;

  jest.doMock('./debug.js', () => ({ pushDebug: jest.fn() }));
  jest.doMock('./menus.js', () => ({ closeMenus: jest.fn() }));
  jest.doMock('./bookmarks-ui.js', () => ({ hideBookmarkContextMenu: jest.fn() }));
  jest.doMock('./menu-backdrop.js', () => ({
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  }));
  jest.doMock('./page-context-menu.js', () => ({ setupWebviewContextMenu: jest.fn() }));
  jest.doMock('./link-status.js', () => ({
    clearLinkStatus: jest.fn(),
    clearHoverStatus: jest.fn(),
    showLinkStatus: jest.fn(),
    setLinkStatusSide: jest.fn(),
  }));
  jest.doMock('./page-urls.js', () => ({
    homeUrl: options.homeUrl || HOME_URL,
    getInternalPageName: (url) =>
      typeof url === 'string' && url.includes('/pages/history.html') ? 'history' : null,
    internalPages: {},
  }));

  const mod = await import('./tabs.js');

  return {
    mod,
    electronAPI,
    electronHandlers,
    createdWebviews,
    elements: {
      tabBar,
      newTabBtn,
      webviewContainer,
      tabContextMenu,
      bzzWebview,
      addressInput,
      actions,
    },
    windowHandlers,
    documentHandlers: document.handlers,
  };
};

const findTabElement = (tabBar, tabId) =>
  tabBar.children.find((child) => child.dataset.tabId === tabId) || null;

const openContextMenu = (tabEl) => {
  tabEl.dispatch('contextmenu', {
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    clientX: 100,
    clientY: 100,
  });
};

describe('tab audio indicator + mute', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('getTabAudioState reducer: muted wins over audible', async () => {
    const { mod } = await loadTabsModule();
    expect(mod.getTabAudioState(null)).toBe(null);
    expect(mod.getTabAudioState({})).toBe(null);
    expect(mod.getTabAudioState({ isAudible: true })).toBe('audible');
    expect(mod.getTabAudioState({ isMuted: true })).toBe('muted');
    expect(mod.getTabAudioState({ isMuted: true, isAudible: true })).toBe('muted');
  });

  test('media events drive the audible flag and the strip indicator', async () => {
    jest.useFakeTimers();
    const { mod, elements } = await loadTabsModule();
    await mod.initTabs();

    const tab = mod.getActiveTab();
    const tabEl = findTabElement(elements.tabBar, tab.id);
    expect(tabEl.dataset.audioState).toBeUndefined();

    tab.webview._audible = true;
    tab.webview.dispatch('media-started-playing');
    expect(tab.isAudible).toBe(true);
    expect(tabEl.dataset.audioState).toBe('audible');

    tab.webview._audible = false;
    tab.webview.dispatch('media-paused');
    expect(tab.isAudible).toBe(false);
    expect(tabEl.dataset.audioState).toBeUndefined();
  });

  test('falls back to the media event when isCurrentlyAudible is unavailable', async () => {
    jest.useFakeTimers();
    const { mod } = await loadTabsModule();
    await mod.initTabs();

    const tab = mod.getActiveTab();
    delete tab.webview.isCurrentlyAudible;

    tab.webview.dispatch('media-started-playing');
    expect(tab.isAudible).toBe(true);
    tab.webview.dispatch('media-paused');
    expect(tab.isAudible).toBe(false);
  });

  test('delayed re-sample converges the indicator on the real audible state', async () => {
    jest.useFakeTimers();
    const { mod } = await loadTabsModule();
    await mod.initTabs();

    const tab = mod.getActiveTab();
    // Media starts but audio is not audible yet (fade-in): the event edge
    // samples false, the recheck later flips it to true.
    tab.webview._audible = false;
    tab.webview.dispatch('media-started-playing');
    // isCurrentlyAudible() returned false, overriding the event fallback.
    expect(tab.isAudible).toBe(false);

    tab.webview._audible = true;
    jest.runOnlyPendingTimers();
    expect(tab.isAudible).toBe(true);
    // The recheck must not reschedule itself into a standing poll.
    expect(jest.getTimerCount()).toBe(0);
  });

  test('toggleMuteTab applies webContents mute and shows the muted indicator', async () => {
    jest.useFakeTimers();
    const { mod, elements } = await loadTabsModule();
    await mod.initTabs();

    const tab = mod.getActiveTab();
    const tabEl = findTabElement(elements.tabBar, tab.id);

    // Muted wins over audible.
    tab.webview._audible = true;
    tab.webview.dispatch('media-started-playing');
    mod.toggleMuteTab(tab.id);
    expect(tab.isMuted).toBe(true);
    expect(tab.webview.setAudioMuted).toHaveBeenCalledWith(true);
    expect(tabEl.dataset.audioState).toBe('muted');

    mod.toggleMuteTab(tab.id);
    expect(tab.isMuted).toBe(false);
    expect(tab.webview.setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(tabEl.dataset.audioState).toBe('audible');
  });

  test('clicking the tab audio button toggles mute without switching tabs', async () => {
    const { mod, elements } = await loadTabsModule();
    await mod.initTabs();

    const first = mod.getActiveTab();
    mod.createTab('https://second.example');
    const firstEl = findTabElement(elements.tabBar, first.id);
    const audioBtn = firstEl.querySelector('.tab-audio');
    expect(audioBtn).toBeTruthy();

    const stopPropagation = jest.fn();
    audioBtn.dispatch('click', { stopPropagation });
    expect(stopPropagation).toHaveBeenCalled();
    expect(first.isMuted).toBe(true);
    // The click must not activate the (background) first tab.
    expect(mod.getActiveTab().id).not.toBe(first.id);
  });

  test('context menu offers Mute Tab / Unmute Tab', async () => {
    const { mod, elements } = await loadTabsModule();
    await mod.initTabs();

    const tab = mod.getActiveTab();
    const tabEl = findTabElement(elements.tabBar, tab.id);

    openContextMenu(tabEl);
    expect(elements.actions.mute.textContent).toBe('Mute Tab');
    elements.tabContextMenu.dispatch('click', { target: elements.actions.mute });
    expect(tab.isMuted).toBe(true);

    openContextMenu(tabEl);
    expect(elements.actions.mute.textContent).toBe('Unmute Tab');
    elements.tabContextMenu.dispatch('click', { target: elements.actions.mute });
    expect(tab.isMuted).toBe(false);
  });

  test('mute toggled before the guest is attached is re-applied at dom-ready', async () => {
    const { mod } = await loadTabsModule();
    await mod.initTabs();

    const tab = mod.getActiveTab();
    // Webview methods throw until the guest is attached; the tab-level flag
    // must stick anyway and dom-ready must re-apply it.
    tab.webview.setAudioMuted.mockImplementationOnce(() => {
      throw new Error('guest not attached');
    });
    mod.toggleMuteTab(tab.id);
    expect(tab.isMuted).toBe(true);
    expect(tab.webview._audioMuted).toBe(false);

    tab.webview.dispatch('dom-ready');
    expect(tab.webview.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(tab.webview._audioMuted).toBe(true);
  });
});
