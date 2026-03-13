const path = require('path');
const internalPages = require('../shared/internal-pages.json');
const IPC = require('../shared/ipc-channels');
const { failure, success } = require('./ipc-contract');
const {
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

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

  const { mod, app } = loadMainModule(require.resolve('./ipc-handlers'), {
    ipcMain,
    dialog,
    clipboard,
    nativeImage,
    extraMocks: {
      [require.resolve('./logger')]: () => log,
      [require.resolve('./settings-store')]: () => ({ loadSettings }),
      [require.resolve('./http-fetch')]: () => ({
        fetchBuffer,
        fetchToFile,
      }),
    },
  });
  const state = require('./state');

  state.activeBzzBases.clear();
  state.activeIpfsBases.clear();
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
  };
}

describe('ipc-handlers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('registers and validates base-url handlers for bzz, ipfs, and radicle', async () => {
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
      ctx.ipcMain.invoke(IPC.IPFS_SET_BASE, {
        webContentsId: 8,
        baseUrl: 'http://localhost:8080/ipfs/cid/',
      })
    ).resolves.toEqual(success());
    expect(ctx.state.activeIpfsBases.get(8)?.toString()).toBe('http://localhost:8080/ipfs/cid/');

    await expect(
      ctx.ipcMain.invoke(IPC.IPFS_CLEAR_BASE, {
        webContentsId: 8,
      })
    ).resolves.toEqual(success());
    expect(ctx.state.activeIpfsBases.has(8)).toBe(false);

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

    await ctx.ipcMain.handlers.get(IPC.OPEN_URL_IN_NEW_TAB)(event, 'https://open.example');
    expect(hostWebContents.send).toHaveBeenCalledWith('tab:new-with-url', 'https://open.example');
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
    expect(ctx.fetchToFile).toHaveBeenCalledWith('https://example.com/assets/logo.png', '/tmp/logo.png');
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
});
