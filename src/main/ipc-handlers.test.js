const fs = require('fs');
const path = require('path');
const internalPages = require('../shared/internal-pages.json');
const IPC = require('../shared/ipc-channels');
const { failure, success } = require('./ipc-contract');
const { createIpcMainMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

function createWindowMock() {
  return {
    close: jest.fn(),
    minimize: jest.fn(),
    maximize: jest.fn(),
    unmaximize: jest.fn(),
    isMaximized: jest.fn(() => false),
    setFullScreen: jest.fn(),
    isFullScreen: jest.fn(() => false),
    setTitle: jest.fn(),
  };
}

const HOST_RENDERER_URL = 'file:///app/src/renderer/index.html';
const SETTINGS_PAGE_URL = 'file:///app/src/renderer/pages/settings.html';
const HISTORY_PAGE_URL = 'file:///app/src/renderer/pages/history.html';

function createIpcEvent(url = SETTINGS_PAGE_URL) {
  return {
    senderFrame: { url },
    sender: {
      getURL: jest.fn(() => url),
    },
  };
}

function loadIpcHandlersModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const loadSettings = jest.fn(() => options.settings || { enableRadicleIntegration: false });
  const fetchBuffer =
    options.fetchBuffer || jest.fn().mockResolvedValue(Buffer.from('image-bytes'));
  const fetchToFile = options.fetchToFile || jest.fn().mockResolvedValue(undefined);
  const dialog = options.dialog || {
    showSaveDialog: jest.fn(),
  };
  const clipboard = options.clipboard || {
    writeText: jest.fn(),
    writeImage: jest.fn(),
  };
  const nativeImage = options.nativeImage || {
    createFromBuffer: jest.fn(() => ({
      isEmpty: () => false,
    })),
  };
  const activeProfile = Object.prototype.hasOwnProperty.call(options, 'activeProfile')
    ? options.activeProfile
    : {
        id: 'default',
        displayName: 'Default',
        source: 'catalog',
        isDev: false,
        userDataDir: '/tmp/freedom-user-data',
      };
  const updateActiveProfileNodeConfig =
    options.updateActiveProfileNodeConfig ||
    jest.fn((protocol, updates) => {
      if (activeProfile?.metadata) {
        activeProfile.metadata.nodes = activeProfile.metadata.nodes || {};
        activeProfile.metadata.nodes[protocol] = {
          ...(activeProfile.metadata.nodes[protocol] || {}),
          ...updates,
        };
      }
      return { metadata: activeProfile?.metadata || null };
    });
  const listProfilesForActiveApp =
    options.listProfilesForActiveApp ||
    jest.fn(
      () =>
        options.profiles || [
          {
            id: activeProfile?.id || 'default',
            displayName: activeProfile?.displayName || 'Default',
            slot: activeProfile?.metadata?.slot ?? 0,
            createdAt: activeProfile?.metadata?.createdAt || null,
            lastOpenedAt: activeProfile?.metadata?.lastOpenedAt || null,
            nodes: activeProfile?.metadata?.nodes || null,
            isActive: true,
          },
        ]
    );
  const createProfileForActiveApp =
    options.createProfileForActiveApp ||
    jest.fn((profile) => ({
      record: {
        id: 'created',
        displayName: profile.displayName,
        slot: 1,
      },
      metadata: {
        id: 'created',
        displayName: profile.displayName,
        slot: 1,
        nodes: {},
      },
    }));
  const importProfileForActiveApp =
    options.importProfileForActiveApp ||
    jest.fn((id) => ({
      record: {
        id,
        displayName: id === 'work' ? 'Work' : id,
        slot: 1,
      },
      metadata: {
        id,
        displayName: id === 'work' ? 'Work' : id,
        slot: 1,
        nodes: {},
      },
    }));
  const renameProfileForActiveApp =
    options.renameProfileForActiveApp ||
    jest.fn((id, displayName) => ({
      record: {
        id,
        displayName,
        slot: 0,
      },
      metadata: {
        id,
        displayName,
        slot: 0,
        nodes: {},
      },
    }));
  const openOrFocusProfile =
    options.openOrFocusProfile ||
    jest.fn((_activeProfile, profileId) => ({
      focused: false,
      launch: { command: '/electron', args: [`--profile=${profileId}`] },
    }));
  const deleteProfileForActiveApp =
    options.deleteProfileForActiveApp ||
    jest.fn((id, _confirmDisplayName) => ({
      record: {
        id,
        displayName: id === 'work' ? 'Work' : id,
        slot: 1,
        nodes: {},
      },
    }));
  const getProfileFocusTargetForActiveApp =
    options.getProfileFocusTargetForActiveApp || jest.fn(() => null);
  const validateProfileDeletionForActiveApp =
    options.validateProfileDeletionForActiveApp || jest.fn(() => true);
  const requestProfileQuitAsync = options.requestProfileQuitAsync || jest.fn(() => ({ ok: true }));
  const isProfileLocked = options.isProfileLocked || jest.fn(() => false);
  const myotisManager = options.myotisManager || {
    stopAllMyotis: jest.fn(),
    refreshMyotisStatus: jest.fn(),
    NETWORKS: new Map([[1, {}], [100, {}]]),
  };

  const { mod, app, webContents } = loadMainModule(require.resolve('./ipc-handlers'), {
    ipcMain,
    dialog,
    clipboard,
    nativeImage,
    webContents: options.webContents,
    webContentsList: options.webContentsList,
    extraMocks: {
      [require.resolve('./logger')]: () => log,
      [require.resolve('./settings-store')]: () => ({ loadSettings }),
      [require.resolve('./http-fetch')]: () => ({
        fetchBuffer,
        fetchToFile,
      }),
      [require.resolve('./profile-resolver')]: () => ({
        createProfileForActiveApp,
        deleteProfileForActiveApp,
        getActiveProfile: jest.fn(() => activeProfile),
        getProfileFocusTargetForActiveApp,
        importProfileForActiveApp,
        listProfilesForActiveApp,
        renameProfileForActiveApp,
        updateActiveProfileNodeConfig,
        validateProfileDeletionForActiveApp,
      }),
      [require.resolve('./profile-launcher')]: () => ({
        openOrFocusProfile,
      }),
      [require.resolve('./profile-focus-handoff')]: () => ({
        requestProfileQuitAsync,
      }),
      [require.resolve('./profile-lock')]: () => ({
        isProfileLocked,
      }),
      [require.resolve('./myotis/myotis-manager')]: () => myotisManager,
      ...(options.swarmProbeMock
        ? { [require.resolve('./swarm/swarm-probe')]: () => options.swarmProbeMock }
        : {}),
      ...(options.isPrivateWebContents
        ? {
            [require.resolve('./private/private-windows')]: () => ({
              isPrivateWebContents: options.isPrivateWebContents,
            }),
          }
        : {}),
    },
  });
  const state = require('./state');

  state.activeBzzBases.clear();
  state.activeRadBases.clear();

  return {
    app,
    clipboard,
    dialog,
    fetchBuffer,
    fetchToFile,
    ipcMain,
    loadSettings,
    log,
    mod,
    nativeImage,
    state,
    webContents,
    createProfileForActiveApp,
    deleteProfileForActiveApp,
    getProfileFocusTargetForActiveApp,
    validateProfileDeletionForActiveApp,
    requestProfileQuitAsync,
    isProfileLocked,
    myotisManager,
    importProfileForActiveApp,
    listProfilesForActiveApp,
    openOrFocusProfile,
    invokeProfileMutation: (channel, payload = {}, url = SETTINGS_PAGE_URL) =>
      Promise.resolve(ipcMain.handlers.get(channel)(createIpcEvent(url), payload)),
    renameProfileForActiveApp,
    updateActiveProfileNodeConfig,
  };
}

describe('ipc-handlers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('registers and validates base-url handlers for bzz and radicle', async () => {
    const ctx = loadIpcHandlersModule({
      settings: { enableRadicleIntegration: false },
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.ipcMain.invoke(IPC.BZZ_SET_BASE, {
        webContentsId: 0,
        baseUrl: 'http://127.0.0.1:1633/bzz/hash/',
      })
    ).resolves.toEqual(
      failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId: 0 })
    );

    await expect(
      ctx.ipcMain.invoke(IPC.BZZ_SET_BASE, {
        webContentsId: 5,
      })
    ).resolves.toEqual(failure('INVALID_BASE_URL', 'Missing baseUrl'));

    await expect(
      ctx.ipcMain.invoke(IPC.BZZ_SET_BASE, {
        webContentsId: 5,
        baseUrl: 'https://swarm-gateway.example/bzz/hash/',
      })
    ).resolves.toEqual(
      failure('INVALID_BASE_URL', 'Base URL must be localhost or 127.0.0.1', {
        baseUrl: 'https://swarm-gateway.example/bzz/hash/',
      })
    );
    expect(ctx.log.warn).toHaveBeenCalledWith('[ipc] Rejecting non-local bzz base URL');

    await expect(
      ctx.ipcMain.invoke(IPC.BZZ_SET_BASE, {
        webContentsId: 5,
        baseUrl: 'http://127.0.0.1:1633/bzz/hash/',
      })
    ).resolves.toEqual(success());
    expect(ctx.state.activeBzzBases.get(5)?.toString()).toBe('http://127.0.0.1:1633/bzz/hash/');

    await expect(
      ctx.ipcMain.invoke(IPC.BZZ_CLEAR_BASE, {
        webContentsId: 5,
      })
    ).resolves.toEqual(success());
    expect(ctx.state.activeBzzBases.has(5)).toBe(false);

    await expect(
      ctx.ipcMain.invoke(IPC.RAD_SET_BASE, {
        webContentsId: 12,
        baseUrl: 'http://127.0.0.1:8780/api/v1/repos/rid/',
      })
    ).resolves.toEqual(
      failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      )
    );

    const enabledCtx = loadIpcHandlersModule({
      settings: { enableRadicleIntegration: true },
    });
    enabledCtx.mod.registerBaseIpcHandlers();

    await expect(
      enabledCtx.ipcMain.invoke(IPC.RAD_SET_BASE, {
        webContentsId: 12,
        baseUrl: 'http://127.0.0.1:8780/api/v1/repos/rid/',
      })
    ).resolves.toEqual(success());
    expect(enabledCtx.state.activeRadBases.get(12)?.toString()).toBe(
      'http://127.0.0.1:8780/api/v1/repos/rid/'
    );

    await expect(
      enabledCtx.ipcMain.invoke(IPC.RAD_CLEAR_BASE, {
        webContentsId: 12,
      })
    ).resolves.toEqual(success());
    expect(enabledCtx.state.activeRadBases.has(12)).toBe(false);
  });

  test('registers window, app, and internal routing handlers', async () => {
    const onNewWindow = jest.fn();
    const onSetTitle = jest.fn();
    const ctx = loadIpcHandlersModule();
    const win = createWindowMock();
    const hostWebContents = {
      send: jest.fn(),
    };
    const event = {
      sender: {
        getOwnerBrowserWindow: jest.fn(() => win),
        hostWebContents,
      },
    };

    ctx.mod.registerBaseIpcHandlers({
      onNewWindow,
      onSetTitle,
    });

    ctx.ipcMain.emit(IPC.WINDOW_SET_TITLE, event, '  Example Title  ');
    expect(win.setTitle).toHaveBeenCalledWith('Example Title - Freedom');
    expect(onSetTitle).toHaveBeenCalledWith('Example Title - Freedom');

    ctx.ipcMain.emit(IPC.WINDOW_CLOSE, event);
    ctx.ipcMain.emit(IPC.WINDOW_MINIMIZE, event);
    expect(win.close).toHaveBeenCalled();
    expect(win.minimize).toHaveBeenCalled();

    ctx.ipcMain.emit(IPC.WINDOW_MAXIMIZE, event);
    expect(win.maximize).toHaveBeenCalled();
    win.isMaximized.mockReturnValueOnce(true);
    ctx.ipcMain.emit(IPC.WINDOW_MAXIMIZE, event);
    expect(win.unmaximize).toHaveBeenCalled();

    ctx.ipcMain.emit(IPC.WINDOW_TOGGLE_FULLSCREEN, event);
    expect(win.setFullScreen).toHaveBeenCalledWith(true);

    await expect(ctx.ipcMain.invoke(IPC.WINDOW_GET_PLATFORM)).resolves.toBe(process.platform);
    await expect(ctx.ipcMain.invoke(IPC.PROFILE_GET_ACTIVE)).resolves.toEqual({
      id: 'default',
      displayName: 'Default',
      source: 'catalog',
      isDev: false,
    });

    ctx.ipcMain.emit(IPC.WINDOW_NEW, event);
    ctx.ipcMain.emit(IPC.WINDOW_NEW_WITH_URL, event, 'https://example.com');
    expect(onNewWindow).toHaveBeenNthCalledWith(1);
    expect(onNewWindow).toHaveBeenNthCalledWith(2, 'https://example.com');

    ctx.ipcMain.emit(IPC.APP_SHOW_ABOUT);
    expect(ctx.app.showAboutPanel).toHaveBeenCalled();

    const preloadPath = await ctx.ipcMain.invoke(IPC.GET_WEBVIEW_PRELOAD_PATH);
    expect(path.basename(preloadPath)).toBe('webview-preload.js');

    const internalPagesEvent = {};
    ctx.ipcMain.emit(IPC.GET_INTERNAL_PAGES, internalPagesEvent);
    expect(internalPagesEvent.returnValue).toEqual(internalPages);

    const injectEvent = {};
    ctx.ipcMain.emit(IPC.GET_ETHEREUM_INJECT_SOURCE, injectEvent);
    const expectedSource = fs.readFileSync(
      path.join(__dirname, 'webview-preload-ethereum-inject.js'),
      'utf-8'
    );
    const served = injectEvent.returnValue;
    expect(typeof served).toBe('string');
    expect(served).toContain('window.__FREEDOM_PROVIDER_CONFIG__');
    expect(served).toContain('"rdns":"baby.freedom.browser"');
    expect(served).toContain('"name":"Freedom"');
    expect(served).toMatch(/"uuid":"[0-9a-f-]{36}"/);
    expect(served.endsWith(expectedSource)).toBe(true);

    // A second call must mint a fresh UUID (spec: unique per provider session).
    const secondEvent = {};
    ctx.ipcMain.emit(IPC.GET_ETHEREUM_INJECT_SOURCE, secondEvent);
    const uuid1 = served.match(/"uuid":"([^"]+)"/)[1];
    const uuid2 = secondEvent.returnValue.match(/"uuid":"([^"]+)"/)[1];
    expect(uuid1).not.toBe(uuid2);

    await ctx.ipcMain.handlers.get(IPC.OPEN_URL_IN_NEW_TAB)(event, 'https://open.example');
    expect(hostWebContents.send).toHaveBeenCalledWith('tab:new-with-url', 'https://open.example');

    await ctx.ipcMain.handlers.get(IPC.SIDEBAR_OPEN_PUBLISH_SETUP)(event);
    expect(hostWebContents.send).toHaveBeenCalledWith(IPC.SIDEBAR_OPEN_PUBLISH_SETUP);
  });

  test('returns active profile metadata without local paths', async () => {
    const ctx = loadIpcHandlersModule({
      activeProfile: {
        id: 'work',
        displayName: 'Work',
        source: 'catalog',
        isDev: true,
        userDataDir: '/sensitive/profile/path',
        appRoot: '/sensitive/app/root',
        metadata: {
          slot: 2,
          nodes: {
            bee: { mode: 'managed', apiPort: 11635 },
            ipfs: { mode: 'managed', backend: 'freedom-ipfs' },
            radicle: { mode: 'disabled' },
            tor: { mode: 'managed', socksPort: 19152 },
          },
        },
      },
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(ctx.ipcMain.invoke(IPC.PROFILE_GET_ACTIVE)).resolves.toEqual({
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
      isDev: true,
      slot: 2,
      nodes: {
        bee: { mode: 'managed', apiPort: 11635 },
        ipfs: { mode: 'managed', backend: 'freedom-ipfs' },
        myotis: null,
        radicle: { mode: 'disabled' },
        tor: { mode: 'managed', socksPort: 19152 },
      },
    });
  });

  // PRIVATE MODE GUARD (windows): "Open Link in New Window" asked from a
  // private window must not hand the URL to a normal window — that window
  // runs on the persistent default session (history, cookies, providers).
  test('window:new-with-url from a private window opens another private window', () => {
    const onNewWindow = jest.fn();
    const onNewPrivateWindow = jest.fn();
    const ctx = loadIpcHandlersModule({
      isPrivateWebContents: (wc) => wc?.isPrivate === true,
    });

    ctx.mod.registerBaseIpcHandlers({ onNewWindow, onNewPrivateWindow });

    ctx.ipcMain.emit(
      IPC.WINDOW_NEW_WITH_URL,
      { sender: { isPrivate: true } },
      'https://example.com/secret'
    );
    expect(onNewPrivateWindow).toHaveBeenCalledWith('https://example.com/secret');
    expect(onNewWindow).not.toHaveBeenCalled();

    // Normal windows keep the normal path.
    ctx.ipcMain.emit(IPC.WINDOW_NEW_WITH_URL, { sender: {} }, 'https://example.com/public');
    expect(onNewWindow).toHaveBeenCalledWith('https://example.com/public');
    expect(onNewPrivateWindow).toHaveBeenCalledTimes(1);
  });

  test('window:new-with-url from a private window is dropped, never downgraded', () => {
    const onNewWindow = jest.fn();
    const ctx = loadIpcHandlersModule({
      isPrivateWebContents: (wc) => wc?.isPrivate === true,
    });

    // No private-window factory wired: the request must be dropped rather
    // than fall back to a normal (persistent-session) window.
    ctx.mod.registerBaseIpcHandlers({ onNewWindow });

    ctx.ipcMain.emit(
      IPC.WINDOW_NEW_WITH_URL,
      { sender: { isPrivate: true } },
      'https://example.com/secret'
    );
    expect(onNewWindow).not.toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining('window:new-with-url'));
  });

  // PRIVATE MODE GUARD (window title): a private page's <title> (and, for
  // view-source, the full URL the renderer sends as the title) must stay out
  // of the persistent on-disk log and out of the process-wide title that
  // later normal windows inherit at ready-to-show.
  test('window:set-title from a private window neither logs the title nor seeds the shared title', () => {
    const onSetTitle = jest.fn();
    const ctx = loadIpcHandlersModule({
      isPrivateWebContents: (wc) => wc?.isPrivate === true,
    });
    const win = createWindowMock();

    ctx.mod.registerBaseIpcHandlers({ onSetTitle });

    ctx.ipcMain.emit(
      IPC.WINDOW_SET_TITLE,
      { sender: { isPrivate: true, getOwnerBrowserWindow: () => win } },
      'SECRET-TITLE-XYZZY'
    );

    // The window's own native title still updates (as Chrome/Firefox do)...
    expect(win.setTitle).toHaveBeenCalledWith('SECRET-TITLE-XYZZY - Freedom');
    // ...but nothing durable or shared records it.
    expect(onSetTitle).not.toHaveBeenCalled();
    for (const call of ctx.log.info.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SECRET-TITLE-XYZZY');
    }

    // Normal windows are unchanged.
    const normalWin = createWindowMock();
    ctx.ipcMain.emit(
      IPC.WINDOW_SET_TITLE,
      { sender: { getOwnerBrowserWindow: () => normalWin } },
      'Public Title'
    );
    expect(onSetTitle).toHaveBeenCalledWith('Public Title - Freedom');
    expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining('Public Title'));
  });

  test('lists, creates, and renames profiles through profile IPC', async () => {
    const activeProfile = {
      id: 'default',
      displayName: 'Default',
      source: 'catalog',
      isDev: false,
    };
    const profileWebContents = {
      send: jest.fn(),
    };
    const ctx = loadIpcHandlersModule({
      activeProfile,
      webContentsList: [profileWebContents],
      profiles: [
        {
          id: 'default',
          displayName: 'Default',
          slot: 0,
          createdAt: '2026-05-25T00:00:00.000Z',
          lastOpenedAt: '2026-05-26T00:00:00.000Z',
          nodes: { bee: { mode: 'managed', apiPort: 11633 } },
          isActive: true,
        },
      ],
      renameProfileForActiveApp: jest.fn((id, displayName) => {
        if (id === activeProfile.id) {
          activeProfile.displayName = displayName;
        }
        return {
          record: {
            id,
            displayName,
            slot: 0,
          },
          metadata: {
            id,
            displayName,
            slot: 0,
            nodes: {},
          },
        };
      }),
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(ctx.ipcMain.invoke(IPC.PROFILE_LIST)).resolves.toEqual(
      success({
        profiles: [
          {
            id: 'default',
            displayName: 'Default',
            slot: 0,
            createdAt: '2026-05-25T00:00:00.000Z',
            lastOpenedAt: '2026-05-26T00:00:00.000Z',
            nodes: { bee: { mode: 'managed', apiPort: 11633 } },
            isActive: true,
          },
        ],
      })
    );

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_CREATE, { displayName: 'Work' })
    ).resolves.toEqual(
      success({
        profile: {
          id: 'created',
          displayName: 'Work',
          slot: 1,
          createdAt: null,
          lastOpenedAt: null,
          nodes: {},
          isActive: false,
        },
      })
    );
    expect(ctx.createProfileForActiveApp).toHaveBeenCalledWith({
      displayName: 'Work',
      id: undefined,
    });

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_RENAME, { id: 'default', displayName: 'Personal' })
    ).resolves.toEqual(
      success({
        profile: {
          id: 'default',
          displayName: 'Personal',
          slot: 0,
          createdAt: null,
          lastOpenedAt: null,
          nodes: {},
          isActive: true,
        },
        activeProfile: {
          id: 'default',
          displayName: 'Personal',
          source: 'catalog',
          isDev: false,
        },
      })
    );
    expect(ctx.renameProfileForActiveApp).toHaveBeenCalledWith('default', 'Personal');
    expect(profileWebContents.send).toHaveBeenCalledWith(IPC.PROFILE_UPDATED, {
      id: 'default',
      displayName: 'Personal',
      source: 'catalog',
      isDev: false,
    });
  });

  test('opens inactive catalog profiles through profile IPC', async () => {
    const ctx = loadIpcHandlersModule({
      profiles: [
        {
          id: 'default',
          displayName: 'Default',
          slot: 0,
          nodes: {},
          isActive: true,
        },
        {
          id: 'work',
          displayName: 'Work',
          slot: 1,
          nodes: { bee: { mode: 'managed', apiPort: 11634 } },
          isActive: false,
        },
      ],
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_OPEN, { id: 'work' }, HOST_RENDERER_URL)
    ).resolves.toEqual(
      success({
        profile: {
          id: 'work',
          displayName: 'Work',
          slot: 1,
          createdAt: undefined,
          lastOpenedAt: undefined,
          nodes: { bee: { mode: 'managed', apiPort: 11634 } },
          isActive: false,
        },
        launch: {
          command: '/electron',
          args: ['--profile=work'],
        },
      })
    );
    expect(ctx.openOrFocusProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'default' }),
      'work',
      { openSettings: false }
    );
  });

  test('reports focused (no launch) when the profile is already running', async () => {
    const ctx = loadIpcHandlersModule({
      profiles: [
        { id: 'default', displayName: 'Default', slot: 0, nodes: {}, isActive: true },
        { id: 'work', displayName: 'Work', slot: 1, nodes: {}, isActive: false },
      ],
      openOrFocusProfile: jest.fn(() => ({ focused: true })),
    });

    ctx.mod.registerBaseIpcHandlers();

    const result = await ctx.invokeProfileMutation(
      IPC.PROFILE_OPEN,
      { id: 'work' },
      HOST_RENDERER_URL
    );

    expect(result.success).toBe(true);
    expect(result.focused).toBe(true);
    expect(result.launch).toBeUndefined();
    expect(ctx.openOrFocusProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'default' }),
      'work',
      { openSettings: false }
    );
  });

  test('reports PROFILE_FOCUS_FAILED when a running profile does not respond', async () => {
    const ctx = loadIpcHandlersModule({
      profiles: [
        { id: 'default', displayName: 'Default', slot: 0, nodes: {}, isActive: true },
        { id: 'work', displayName: 'Work', slot: 1, nodes: {}, isActive: false },
      ],
      openOrFocusProfile: jest.fn(() => ({
        focused: false,
        error: 'The running profile did not respond',
      })),
    });

    ctx.mod.registerBaseIpcHandlers();

    const result = await ctx.invokeProfileMutation(
      IPC.PROFILE_OPEN,
      { id: 'work' },
      HOST_RENDERER_URL
    );

    expect(result).toEqual(
      failure('PROFILE_FOCUS_FAILED', 'The running profile did not respond')
    );
  });

  test('forwards openSettings (edit button) to openOrFocusProfile', async () => {
    const ctx = loadIpcHandlersModule({
      profiles: [
        { id: 'default', displayName: 'Default', slot: 0, nodes: {}, isActive: true },
        { id: 'work', displayName: 'Work', slot: 1, nodes: {}, isActive: false },
      ],
      openOrFocusProfile: jest.fn(() => ({ focused: true })),
    });

    ctx.mod.registerBaseIpcHandlers();

    const result = await ctx.invokeProfileMutation(
      IPC.PROFILE_OPEN,
      { id: 'work', openSettings: true },
      HOST_RENDERER_URL
    );

    expect(result.success).toBe(true);
    expect(ctx.openOrFocusProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'default' }),
      'work',
      { openSettings: true }
    );
  });

  test('rejects profile mutations from non-settings internal pages', async () => {
    const ctx = loadIpcHandlersModule();

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_CREATE, { displayName: 'Work' }, HISTORY_PAGE_URL)
    ).resolves.toEqual(
      failure('PROFILE_IPC_FORBIDDEN', 'Profile changes are only available from trusted profile UI')
    );
    expect(ctx.createProfileForActiveApp).not.toHaveBeenCalled();
  });

  test('shows the create-profile modal only for trusted senders', () => {
    const ctx = loadIpcHandlersModule();
    ctx.mod.registerBaseIpcHandlers();

    const makeEvent = (url) => {
      const win = { isDestroyed: () => false, webContents: { send: jest.fn() } };
      return {
        win,
        senderFrame: { url },
        sender: { getURL: () => url, getOwnerBrowserWindow: () => win },
      };
    };

    // A hostile page loaded in a webview must not be able to pop the modal.
    const untrusted = makeEvent('file:///app/src/renderer/pages/history.html');
    ctx.ipcMain.emit(IPC.PROFILE_REQUEST_CREATE_MODAL, untrusted);
    expect(untrusted.win.webContents.send).not.toHaveBeenCalled();

    // The trusted profiles manager page may.
    const trusted = makeEvent('file:///app/src/renderer/pages/profiles.html');
    ctx.ipcMain.emit(IPC.PROFILE_REQUEST_CREATE_MODAL, trusted);
    expect(trusted.win.webContents.send).toHaveBeenCalledWith(IPC.PROFILE_SHOW_CREATE_MODAL);
  });

  test('imports unregistered profile directories through profile IPC', async () => {
    const ctx = loadIpcHandlersModule();

    ctx.mod.registerBaseIpcHandlers();

    await expect(ctx.invokeProfileMutation(IPC.PROFILE_IMPORT, { id: 'work' })).resolves.toEqual(
      success({
        profile: {
          id: 'work',
          displayName: 'Work',
          slot: 1,
          createdAt: null,
          lastOpenedAt: null,
          nodes: {},
          isActive: false,
        },
      })
    );
    expect(ctx.importProfileForActiveApp).toHaveBeenCalledWith('work');
  });

  test('rejects opening the active profile', async () => {
    const ctx = loadIpcHandlersModule();

    ctx.mod.registerBaseIpcHandlers();

    await expect(ctx.invokeProfileMutation(IPC.PROFILE_OPEN, { id: 'default' })).resolves.toEqual(
      failure('PROFILE_ALREADY_OPEN', 'This profile is already open')
    );
    expect(ctx.openOrFocusProfile).not.toHaveBeenCalled();
  });

  test('deletes inactive profiles through typed confirmation IPC', async () => {
    const ctx = loadIpcHandlersModule();

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_DELETE, {
        id: 'work',
        confirmDisplayName: 'Work',
      })
    ).resolves.toEqual(
      success({
        profile: {
          id: 'work',
          displayName: 'Work',
          slot: 1,
          createdAt: null,
          lastOpenedAt: null,
          nodes: {},
          isActive: false,
        },
      })
    );
    expect(ctx.deleteProfileForActiveApp).toHaveBeenCalledWith('work', 'Work');
  });

  test('closes a running profile before deleting it', async () => {
    const ctx = loadIpcHandlersModule({
      getProfileFocusTargetForActiveApp: jest.fn(() => ({
        id: 'work',
        displayName: 'Work',
        userDataDir: '/tmp/freedom-user-data/Profiles/work',
        isDev: false,
        isLocked: true,
      })),
      // Lock has already released by the time we poll.
      isProfileLocked: jest.fn(() => false),
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_DELETE, {
        id: 'work',
        confirmDisplayName: 'Work',
      })
    ).resolves.toEqual(expect.objectContaining({ success: true }));

    expect(ctx.requestProfileQuitAsync).toHaveBeenCalledTimes(1);
    expect(ctx.deleteProfileForActiveApp).toHaveBeenCalledWith('work', 'Work');
  });

  test('validates the request before closing a running profile', async () => {
    // A stale/mismatched confirmation must be rejected up front — BEFORE we ask
    // a running profile to quit. Otherwise an invalid delete would close a live
    // window only to fail validation afterwards.
    const ctx = loadIpcHandlersModule({
      getProfileFocusTargetForActiveApp: jest.fn(() => ({
        id: 'work',
        displayName: 'Work',
        userDataDir: '/tmp/freedom-user-data/Profiles/work',
        isDev: false,
        isLocked: true,
      })),
      validateProfileDeletionForActiveApp: jest.fn(() => {
        throw new Error('Profile display name confirmation did not match');
      }),
    });

    ctx.mod.registerBaseIpcHandlers();

    const result = await ctx.mod.deleteProfileFromIpc({ id: 'work', confirmDisplayName: 'Wrong' });

    expect(result).toEqual(
      failure('PROFILE_DELETE_FAILED', 'Profile display name confirmation did not match')
    );
    // The running profile must NOT have been asked to quit, and no delete ran.
    expect(ctx.requestProfileQuitAsync).not.toHaveBeenCalled();
    expect(ctx.deleteProfileForActiveApp).not.toHaveBeenCalled();
  });

  test('waits for the holder process to exit before deleting (not just lock release)', async () => {
    const ctx = loadIpcHandlersModule({
      getProfileFocusTargetForActiveApp: jest.fn(() => ({
        id: 'work',
        displayName: 'Work',
        userDataDir: '/tmp/freedom-user-data/Profiles/work',
        isDev: false,
        isLocked: true,
      })),
      requestProfileQuitAsync: jest.fn(() => ({ ok: true, nonce: 'quit-nonce' })),
      // The lock reads as free immediately (e.g. went stale during a slow
      // shutdown), but the holder process is still alive and touching data.
      isProfileLocked: jest.fn(() => false),
    });

    ctx.mod.registerBaseIpcHandlers();

    let alive = true;
    const isProcessAlive = jest.fn(() => alive);
    // Holder acks the quit with its pid; it exits on the third poll.
    const readProfileFocusAck = jest.fn(() => ({ nonce: 'quit-nonce', ok: true, pid: 4321 }));
    setTimeout(() => {
      alive = false;
    }, 5);

    const result = await ctx.mod.deleteProfileFromIpc(
      { id: 'work', confirmDisplayName: 'Work' },
      { timeoutMs: 200, intervalMs: 1, isProcessAlive, readProfileFocusAck }
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(isProcessAlive).toHaveBeenCalledWith(4321);
    expect(ctx.deleteProfileForActiveApp).toHaveBeenCalledWith('work', 'Work');
  });

  test('refuses to delete a running profile that will not close', async () => {
    const ctx = loadIpcHandlersModule({
      getProfileFocusTargetForActiveApp: jest.fn(() => ({
        id: 'work',
        displayName: 'Work',
        userDataDir: '/tmp/freedom-user-data/Profiles/work',
        isDev: false,
        isLocked: true,
      })),
      // Stays locked forever — the close attempt times out.
      isProfileLocked: jest.fn(() => true),
    });

    ctx.mod.registerBaseIpcHandlers();

    // Call the handler directly with fast timing so the close attempt times out
    // quickly instead of waiting the full default window.
    const result = await ctx.mod.deleteProfileFromIpc(
      { id: 'work', confirmDisplayName: 'Work' },
      { timeoutMs: 10, intervalMs: 1 }
    );

    expect(result).toEqual(
      failure(
        'PROFILE_CLOSE_FAILED',
        'This profile is open and could not be closed automatically. Close its window and try again.'
      )
    );
    expect(ctx.deleteProfileForActiveApp).not.toHaveBeenCalled();
    // The no-ack fallback must probe the lock with an effectively-infinite
    // stale window, so a still-held lock can't read as released merely because
    // its heartbeat lapsed (dev profiles have a 5s stale < the delete wait).
    expect(ctx.isProfileLocked).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'work' }),
      { staleMs: Number.MAX_SAFE_INTEGER }
    );
  });

  test('updates active profile node config through validated IPC', async () => {
    const activeProfile = {
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
      isDev: false,
      metadata: {
        slot: 1,
        nodes: {
          bee: { mode: 'managed', apiPort: 11634 },
          ipfs: { mode: 'managed', backend: 'freedom-ipfs' },
          myotis: { mode: 'managed', backend: 'myotis-native' },
          radicle: { mode: 'managed', httpPort: 18781, p2pPort: 18777 },
          tor: { mode: 'managed', socksPort: 19151 },
        },
      },
    };
    const profileWebContents = {
      send: jest.fn(),
    };
    const ctx = loadIpcHandlersModule({ activeProfile, webContentsList: [profileWebContents] });

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_UPDATE_NODE_CONFIG, {
        protocol: 'bee',
        config: {
          mode: 'external',
          externalApi: '127.0.0.1:1633/',
          ignored: true,
        },
      })
    ).resolves.toEqual(
      success({
        profile: {
          id: 'work',
          displayName: 'Work',
          source: 'catalog',
          isDev: false,
          slot: 1,
          nodes: {
            bee: { mode: 'external', apiPort: 11634, externalApi: 'http://127.0.0.1:1633' },
            ipfs: { mode: 'managed', backend: 'freedom-ipfs' },
            myotis: { mode: 'managed', backend: 'myotis-native' },
            radicle: { mode: 'managed', httpPort: 18781, p2pPort: 18777 },
            tor: { mode: 'managed', socksPort: 19151 },
          },
        },
      })
    );

    expect(ctx.updateActiveProfileNodeConfig).toHaveBeenCalledWith('bee', {
      mode: 'external',
      externalApi: 'http://127.0.0.1:1633',
    });
    expect(profileWebContents.send).toHaveBeenCalledWith(IPC.PROFILE_UPDATED, {
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
      isDev: false,
      slot: 1,
      nodes: {
        bee: { mode: 'external', apiPort: 11634, externalApi: 'http://127.0.0.1:1633' },
        ipfs: { mode: 'managed', backend: 'freedom-ipfs' },
        myotis: { mode: 'managed', backend: 'myotis-native' },
        radicle: { mode: 'managed', httpPort: 18781, p2pPort: 18777 },
        tor: { mode: 'managed', socksPort: 19151 },
      },
    });
  });

  test('supports managed and disabled Myotis profile modes', async () => {
    const activeProfile = {
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
      metadata: {
        nodes: { myotis: { mode: 'managed', backend: 'myotis-native' } },
      },
    };
    const ctx = loadIpcHandlersModule({ activeProfile });
    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_UPDATE_NODE_CONFIG, {
        protocol: 'myotis',
        config: { mode: 'disabled', externalApi: 'http://127.0.0.1:8545' },
      })
    ).resolves.toEqual(
      success({
        profile: expect.objectContaining({
          nodes: expect.objectContaining({
            myotis: { mode: 'disabled', backend: 'myotis-native' },
          }),
        }),
      })
    );
    expect(ctx.updateActiveProfileNodeConfig).toHaveBeenCalledWith('myotis', {
      mode: 'disabled',
    });
    expect(ctx.myotisManager.stopAllMyotis).toHaveBeenCalled();

    await ctx.invokeProfileMutation(IPC.PROFILE_UPDATE_NODE_CONFIG, {
      protocol: 'myotis',
      config: { mode: 'managed' },
    });
    expect(ctx.myotisManager.refreshMyotisStatus.mock.calls).toEqual([[1], [100]]);

    expect(ctx.mod.validateProfileNodeConfigUpdate('myotis', { mode: 'external' })).toEqual({
      ok: false,
      response: failure('INVALID_PROFILE_NODE_MODE', 'Unsupported profile node mode', {
        mode: 'external',
      }),
    });
  });

  test('updates Tor profile node config through SOCKS endpoint validation', async () => {
    const activeProfile = {
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
      isDev: false,
      metadata: {
        slot: 1,
        nodes: {
          tor: { mode: 'managed', socksPort: 19151, externalSocks: null },
        },
      },
    };
    const ctx = loadIpcHandlersModule({ activeProfile });

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_UPDATE_NODE_CONFIG, {
        protocol: 'tor',
        config: {
          mode: 'external',
          externalSocks: 'socks5://127.0.0.1:9150/',
        },
      })
    ).resolves.toEqual(
      success({
        profile: {
          id: 'work',
          displayName: 'Work',
          source: 'catalog',
          isDev: false,
          slot: 1,
          nodes: {
            bee: null,
            ipfs: null,
            myotis: null,
            radicle: null,
            tor: {
              mode: 'external',
              socksPort: 19151,
              externalSocks: '127.0.0.1:9150',
            },
          },
        },
      })
    );

    expect(ctx.updateActiveProfileNodeConfig).toHaveBeenCalledWith('tor', {
      mode: 'external',
      externalSocks: '127.0.0.1:9150',
    });

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_UPDATE_NODE_CONFIG, {
        protocol: 'tor',
        config: {
          mode: 'external',
          externalSocks: 'http://127.0.0.1:9150',
        },
      })
    ).resolves.toEqual(
      failure('INVALID_PROFILE_NODE_ENDPOINT', 'Invalid profile node endpoint', {
        field: 'externalSocks',
      })
    );
  });

  test('rejects invalid active profile node updates', async () => {
    const ctx = loadIpcHandlersModule({
      activeProfile: {
        id: 'work',
        displayName: 'Work',
        source: 'catalog',
        metadata: { nodes: {} },
      },
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_UPDATE_NODE_CONFIG, {
        protocol: 'bee',
        config: { mode: 'preferExternal' },
      })
    ).resolves.toEqual(
      failure('INVALID_PROFILE_NODE_MODE', 'Unsupported profile node mode', {
        mode: 'preferExternal',
      })
    );

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_UPDATE_NODE_CONFIG, {
        protocol: 'ipfs',
        config: { mode: 'external', externalApi: '127.0.0.1:5001' },
      })
    ).resolves.toEqual(
      failure('INVALID_PROFILE_NODE_MODE', 'Unsupported profile node mode', {
        mode: 'external',
      })
    );

    expect(ctx.updateActiveProfileNodeConfig).not.toHaveBeenCalled();
  });

  test('rejects profile node updates outside catalog profiles', async () => {
    const ctx = loadIpcHandlersModule({
      activeProfile: {
        id: 'direct',
        displayName: 'Direct',
        source: 'profile-dir',
      },
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(
      ctx.invokeProfileMutation(IPC.PROFILE_UPDATE_NODE_CONFIG, {
        protocol: 'bee',
        config: { mode: 'disabled' },
      })
    ).resolves.toEqual(failure('PROFILE_NOT_EDITABLE', 'The active profile cannot be edited'));
  });

  test('saves images through the dialog workflow', async () => {
    const ctx = loadIpcHandlersModule();
    const win = createWindowMock();
    const event = {
      sender: {
        getOwnerBrowserWindow: jest.fn(() => win),
      },
    };

    ctx.mod.registerBaseIpcHandlers();

    await expect(ctx.ipcMain.handlers.get(IPC.CONTEXT_MENU_SAVE_IMAGE)(event)).resolves.toEqual({
      success: false,
      error: 'No image URL provided',
    });

    ctx.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: true,
      filePath: undefined,
    });
    await expect(
      ctx.ipcMain.handlers.get(IPC.CONTEXT_MENU_SAVE_IMAGE)(
        event,
        'https://example.com/assets/logo.png'
      )
    ).resolves.toEqual({
      success: false,
      canceled: true,
    });

    ctx.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/tmp/logo.png',
    });
    await expect(
      ctx.ipcMain.handlers.get(IPC.CONTEXT_MENU_SAVE_IMAGE)(
        event,
        'https://example.com/assets/logo.png'
      )
    ).resolves.toEqual({
      success: true,
      filePath: '/tmp/logo.png',
    });
    expect(ctx.dialog.showSaveDialog).toHaveBeenLastCalledWith(
      win,
      expect.objectContaining({
        defaultPath: 'logo.png',
      })
    );
    expect(ctx.fetchToFile).toHaveBeenCalledWith(
      'https://example.com/assets/logo.png',
      '/tmp/logo.png'
    );
  });

  test('copies text and images to the clipboard with error handling', async () => {
    const emptyImage = {
      isEmpty: () => true,
    };
    const ctx = loadIpcHandlersModule({
      nativeImage: {
        createFromBuffer: jest
          .fn()
          .mockReturnValueOnce({
            isEmpty: () => false,
          })
          .mockReturnValueOnce(emptyImage),
      },
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(ctx.ipcMain.invoke('clipboard:copy-text', 'hello')).resolves.toEqual({
      success: true,
    });
    expect(ctx.clipboard.writeText).toHaveBeenCalledWith('hello');

    await expect(ctx.ipcMain.invoke('clipboard:copy-text', '')).resolves.toEqual({
      success: false,
      error: 'No text provided',
    });

    ctx.clipboard.readText = jest.fn(() => 'from-main');
    await expect(ctx.ipcMain.invoke('clipboard:read-text')).resolves.toEqual({
      success: true,
      text: 'from-main',
    });
    expect(ctx.clipboard.readText).toHaveBeenCalled();

    // Webview senders (hostWebContents !== null) must not be able to
    // siphon the user's clipboard without a paste gesture.
    const webviewEvent = { sender: { hostWebContents: { id: 99 } } };
    expect(ctx.ipcMain.handlers.get('clipboard:read-text')(webviewEvent)).toEqual({
      success: false,
      error: 'Untrusted sender',
    });

    await expect(ctx.ipcMain.handlers.get('clipboard:copy-image')({}, undefined)).resolves.toEqual({
      success: false,
      error: 'No image URL provided',
    });

    await expect(
      ctx.ipcMain.handlers.get('clipboard:copy-image')({}, 'https://example.com/image.png')
    ).resolves.toEqual({
      success: true,
    });
    expect(ctx.fetchBuffer).toHaveBeenCalledWith('https://example.com/image.png');
    expect(ctx.clipboard.writeImage).toHaveBeenCalled();

    await expect(
      ctx.ipcMain.handlers.get('clipboard:copy-image')({}, 'https://example.com/empty.png')
    ).resolves.toEqual({
      success: false,
      error: 'Failed to create image from data',
    });

    const failingCtx = loadIpcHandlersModule({
      fetchBuffer: jest.fn().mockRejectedValue(new Error('download failed')),
    });
    failingCtx.mod.registerBaseIpcHandlers();

    await expect(
      failingCtx.ipcMain.handlers.get('clipboard:copy-image')({}, 'https://example.com/error.png')
    ).resolves.toEqual({
      success: false,
      error: 'download failed',
    });
    expect(failingCtx.log.error).toHaveBeenCalledWith(
      '[clipboard] Failed to copy image:',
      expect.any(Error)
    );
  });

  test('wires bzz content probe handlers through start/await/cancel', async () => {
    let probeResolve;
    const startProbe = jest.fn(() => ({
      id: 'probe-abc',
      promise: new Promise((resolve) => {
        probeResolve = resolve;
      }),
    }));
    const cancelProbe = jest.fn(() => true);
    const ctx = loadIpcHandlersModule({
      swarmProbeMock: { startProbe, cancelProbe },
    });

    ctx.mod.registerBaseIpcHandlers();

    await expect(ctx.ipcMain.invoke(IPC.BZZ_START_PROBE, {})).resolves.toEqual(
      failure('INVALID_HASH', 'Missing hash')
    );
    await expect(ctx.ipcMain.invoke(IPC.BZZ_CANCEL_PROBE, {})).resolves.toEqual(
      failure('INVALID_ID', 'Missing probe id')
    );
    await expect(ctx.ipcMain.invoke(IPC.BZZ_AWAIT_PROBE, { id: 'missing' })).resolves.toEqual(
      failure('UNKNOWN_PROBE', 'Unknown probe id', { id: 'missing' })
    );

    const startResult = await ctx.ipcMain.invoke(IPC.BZZ_START_PROBE, {
      hash: 'a'.repeat(64),
      path: '/index.html',
    });
    expect(startResult).toEqual(success({ id: 'probe-abc' }));
    expect(startProbe).toHaveBeenCalledWith('a'.repeat(64), { path: '/index.html' });

    const awaitPromise = ctx.ipcMain.invoke(IPC.BZZ_AWAIT_PROBE, { id: 'probe-abc' });
    probeResolve({ ok: true });
    await expect(awaitPromise).resolves.toEqual(success({ outcome: { ok: true } }));

    // Once consumed, awaiting again reports unknown probe.
    await expect(ctx.ipcMain.invoke(IPC.BZZ_AWAIT_PROBE, { id: 'probe-abc' })).resolves.toEqual(
      failure('UNKNOWN_PROBE', 'Unknown probe id', { id: 'probe-abc' })
    );

    // Race: a fast probe that settles before the renderer's await-probe IPC
    // arrives must still deliver its outcome — the entry survives until
    // await-probe consumes it.
    let fastResolve;
    startProbe.mockImplementationOnce(() => ({
      id: 'probe-fast',
      promise: new Promise((resolve) => {
        fastResolve = resolve;
      }),
    }));
    await ctx.ipcMain.invoke(IPC.BZZ_START_PROBE, { hash: 'b'.repeat(64) });
    fastResolve({ ok: true });
    // Let the probe promise microtask-settle before we await.
    await Promise.resolve();
    await Promise.resolve();
    await expect(ctx.ipcMain.invoke(IPC.BZZ_AWAIT_PROBE, { id: 'probe-fast' })).resolves.toEqual(
      success({ outcome: { ok: true } })
    );

    await expect(ctx.ipcMain.invoke(IPC.BZZ_CANCEL_PROBE, { id: 'probe-abc' })).resolves.toEqual(
      success({ cancelled: true })
    );
    expect(cancelProbe).toHaveBeenCalledWith('probe-abc');
  });
});
