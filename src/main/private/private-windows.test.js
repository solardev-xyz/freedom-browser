const { EventEmitter } = require('events');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');

class FakeWindow extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.webContents = { id: id * 100 };
  }
}

function makeFakeSession() {
  return {
    clearStorageData: jest.fn(() => Promise.resolve()),
    clearCache: jest.fn(() => Promise.resolve()),
  };
}

// The window factory lives in ../windows/mainWindow and is required lazily;
// mock it per-suite via jest.doMock inside loadMainModule's extraMocks.
function loadWithWindowFactory() {
  let nextWindowId = 1;
  const createdWindows = [];
  const createMainWindow = jest.fn((initialUrl, options) => {
    const win = new FakeWindow(nextWindowId++);
    win.initialUrl = initialUrl;
    win.options = options;
    createdWindows.push(win);
    return win;
  });

  const sessionsByPartition = new Map();
  const fromPartition = jest.fn((partition) => {
    if (!sessionsByPartition.has(partition)) {
      sessionsByPartition.set(partition, makeFakeSession());
    }
    return sessionsByPartition.get(partition);
  });

  const fromWebContents = jest.fn((wc) => createdWindows.find((w) => w.webContents === wc) || null);

  const ctx = loadMainModule(require.resolve('./private-windows'), {
    electronOverrides: {
      BrowserWindow: { fromWebContents, getAllWindows: jest.fn(() => createdWindows) },
      session: { fromPartition },
    },
    extraMocks: {
      [require.resolve('../windows/mainWindow')]: () => ({ createMainWindow }),
    },
  });

  // createPrivateWindow fails CLOSED without a configurator, so every suite
  // that just wants a window installs a no-op one. The refusal itself is
  // covered explicitly below.
  const configurator = jest.fn();
  ctx.mod.setPrivateSessionConfigurator(configurator);

  return {
    mod: ctx.mod,
    createMainWindow,
    createdWindows,
    fromPartition,
    sessionsByPartition,
    configurator,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('private-windows', () => {
  test('createPrivateWindow uses a unique non-persisted private-<uuid> partition', () => {
    const { mod, createMainWindow, fromPartition } = loadWithWindowFactory();

    mod.createPrivateWindow();
    mod.createPrivateWindow();

    expect(fromPartition).toHaveBeenCalledTimes(2);
    const [p1] = fromPartition.mock.calls[0];
    const [p2] = fromPartition.mock.calls[1];

    // Unique per window, prefixed, and crucially WITHOUT `persist:` — the
    // absence of the prefix is what makes the session in-memory only.
    expect(p1).toMatch(/^private-[0-9a-f-]{36}$/);
    expect(p2).toMatch(/^private-[0-9a-f-]{36}$/);
    expect(p1).not.toBe(p2);
    expect(p1.startsWith('persist:')).toBe(false);

    // The partition is handed to the window factory for the renderer.
    expect(createMainWindow).toHaveBeenCalledWith(null, { privatePartition: p1 });
    expect(mod.isPrivatePartition(p1)).toBe(true);
    expect(mod.isPrivatePartition('private-not-created')).toBe(false);
    expect(mod.isPrivatePartition('persist:main')).toBe(false);
  });

  test('configures the private session before creating the window', () => {
    const { mod, createMainWindow, fromPartition } = loadWithWindowFactory();
    const order = [];
    createMainWindow.mockImplementation(() => {
      order.push('window');
      return new FakeWindow(99);
    });
    const configurator = jest.fn(() => order.push('configure'));
    mod.setPrivateSessionConfigurator(configurator);

    mod.createPrivateWindow('https://example.com');

    expect(configurator).toHaveBeenCalledTimes(1);
    const [sessionArg, meta] = configurator.mock.calls[0];
    expect(sessionArg).toBe(fromPartition.mock.results[0].value);
    expect(meta.partition).toMatch(/^private-/);
    // Session must be fully configured before any webview can exist.
    expect(order).toEqual(['configure', 'window']);
  });

  test('isPrivateWebContents recognises private webviews (session) and chrome (window)', () => {
    const { mod, createdWindows, sessionsByPartition } = loadWithWindowFactory();
    const win = mod.createPrivateWindow();

    // The private window's own chrome renderer.
    expect(mod.isPrivateWebContents(createdWindows[0].webContents)).toBe(true);

    // A webview on the private session (host relationship not needed).
    const partition = win.options.privatePartition;
    const webviewContents = { session: sessionsByPartition.get(partition) };
    expect(mod.isPrivateWebContents(webviewContents)).toBe(true);

    // A webview whose host is the private window.
    const hosted = { hostWebContents: createdWindows[0].webContents };
    expect(mod.isPrivateWebContents(hosted)).toBe(true);

    // Unrelated webContents / missing sender.
    expect(mod.isPrivateWebContents({ session: {} })).toBe(false);
    expect(mod.isPrivateWebContents(null)).toBe(false);
    expect(mod.isPrivateWebContents(undefined)).toBe(false);

    expect(mod.getPartitionForWebContents(createdWindows[0].webContents)).toBe(partition);
    expect(mod.getPartitionForWebContents({ session: {} })).toBe(null);
  });

  test('window close runs cleanup hooks and clears the session (belt-and-braces)', async () => {
    const { mod, createdWindows, sessionsByPartition } = loadWithWindowFactory();
    const cleanup = jest.fn();
    mod.registerPrivateCleanup(cleanup);

    const win = mod.createPrivateWindow();
    const partition = win.options.privatePartition;
    const privateSession = sessionsByPartition.get(partition);
    expect(mod.getPrivateWindowCount()).toBe(1);

    createdWindows[0].emit('closed');
    await flush();

    expect(cleanup).toHaveBeenCalledWith(partition);
    expect(privateSession.clearStorageData).toHaveBeenCalledTimes(1);
    expect(privateSession.clearCache).toHaveBeenCalledTimes(1);
    expect(mod.getPrivateWindowCount()).toBe(0);
    // The window is gone from the LIVE registry, but its identity stays
    // known-private forever: the private chrome renderer runs on the DEFAULT
    // session (so the session-identity check cannot see it) and can still be
    // dispatching history:add / favicon:fetch IPC while the window tears
    // down. Deny-by-default for anything that ever was private — this is the
    // promise the module comment makes, asserted here so it stays true.
    expect(mod.isPrivateWebContents(createdWindows[0].webContents)).toBe(true);
    expect(mod.isPrivatePartition(partition)).toBe(true);
  });

  test('createPrivateWindow fails closed when the session cannot be configured', () => {
    // A bare private session has no permission handler (Electron's default
    // GRANTS every request), no per-session protocol handlers and no
    // downloads hook — the opposite of what the window promises. Refusing to
    // open is the only safe degradation.
    const noConfigurator = loadWithWindowFactory();
    noConfigurator.mod.setPrivateSessionConfigurator(null);
    expect(noConfigurator.mod.createPrivateWindow()).toBe(null);
    expect(noConfigurator.createMainWindow).not.toHaveBeenCalled();
    expect(noConfigurator.mod.getPrivateWindowCount()).toBe(0);

    const throwing = loadWithWindowFactory();
    throwing.configurator.mockImplementation(() => {
      throw new Error('protocol registration failed');
    });
    expect(throwing.mod.createPrivateWindow('https://example.com')).toBe(null);
    expect(throwing.createMainWindow).not.toHaveBeenCalled();
    expect(throwing.mod.getPrivateWindowCount()).toBe(0);

    // The partition name it burned stays known-private: nothing may ever be
    // treated as normal just because its window failed to open.
    const [partition] = throwing.fromPartition.mock.calls[0];
    expect(throwing.mod.isPrivatePartition(partition)).toBe(true);
  });

  test('a failing cleanup hook does not prevent session clearing', async () => {
    const { mod, createdWindows, sessionsByPartition } = loadWithWindowFactory();
    mod.registerPrivateCleanup(() => {
      throw new Error('boom');
    });
    const okCleanup = jest.fn();
    mod.registerPrivateCleanup(okCleanup);

    const win = mod.createPrivateWindow();
    createdWindows[0].emit('closed');
    await flush();

    expect(okCleanup).toHaveBeenCalledTimes(1);
    const privateSession = sessionsByPartition.get(win.options.privatePartition);
    expect(privateSession.clearStorageData).toHaveBeenCalledTimes(1);
  });
});
