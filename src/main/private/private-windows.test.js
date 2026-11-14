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
    fromWebContents,
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
    expect(createMainWindow).toHaveBeenCalledWith(null, { privatePartition: p1, tor: false });
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

  // R-9 review: a sender main cannot place in a known window is unknown,
  // never public, so a fail-closed guard can refuse it.
  test('classifyWebContents tells private, public and unknown apart', () => {
    const { mod, createdWindows, fromWebContents, sessionsByPartition } = loadWithWindowFactory();
    const privateWin = mod.createPrivateWindow();
    const privateChrome = createdWindows[0].webContents;
    const privateSession = sessionsByPartition.get(privateWin.options.privatePartition);
    const publicWin = { id: 42, isDestroyed: () => false };
    const publicChrome = { id: 4200, isDestroyed: () => false };
    const lookup = { mode: 'registry' };
    fromWebContents.mockImplementation((contents) => {
      if (lookup.mode === 'throw') throw new Error('webContents destroyed mid-lookup');
      if (lookup.mode === 'null') return null;
      if (contents === publicChrome) return publicWin;
      return createdWindows.find((w) => w.webContents === contents) || null;
    });

    expect(mod.classifyWebContents(privateChrome)).toBe('private');
    expect(mod.classifyWebContents({ hostWebContents: privateChrome })).toBe('private');
    expect(mod.classifyWebContents({ session: privateSession })).toBe('private');
    expect(mod.classifyWebContents(publicChrome)).toBe('public');
    expect(mod.classifyWebContents({ hostWebContents: publicChrome })).toBe('public');

    for (const contents of [
      null,
      undefined,
      { isDestroyed: () => true },
      { hostWebContents: { isDestroyed: () => true } },
      { id: 7 }, // no window main can find
      {
        get session() {
          throw new Error('destroyed');
        },
      },
    ]) {
      expect(mod.classifyWebContents(contents)).toBe('unknown');
    }
    expect(mod.classifyWebContents({ hostWebContents: publicChrome, isDestroyed: () => true })).toBe(
      'unknown'
    );
    // A public window being destroyed.
    publicWin.isDestroyed = () => true;
    expect(mod.classifyWebContents(publicChrome)).toBe('unknown');
    publicWin.isDestroyed = () => false;

    // A null or throwing window lookup: unknown, even for a sender that
    // would otherwise be public. isPrivateWebContents still says false.
    for (const mode of ['null', 'throw']) {
      lookup.mode = mode;
      expect(mod.classifyWebContents(publicChrome)).toBe('unknown');
      expect(mod.isPrivateWebContents(publicChrome)).toBe(false);
    }
    // A private window's chrome stays private once its window has closed.
    lookup.mode = 'registry';
    createdWindows[0].emit('closed');
    expect(mod.classifyWebContents(privateChrome)).toBe('private');
  });

  // #1058: the private session runs from the first private window to the
  // last one's close, which ends it before the cleanup hooks run.
  test('the last private window to close ends the private session, before the hooks', async () => {
    const { mod, createdWindows } = loadWithWindowFactory();
    const logContext = require('./private-log-context');
    // Work entered in a private context, which reports whether its session
    // is live each time it is released.
    const releases = [];
    const answers = [];
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const ask = async () => {
      releases.shift()();
      await tick();
      return answers.at(-1);
    };
    mod.createPrivateWindow();
    mod.createPrivateWindow();
    logContext.runWithPrivateLogContext(true, async () => {
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => releases.push(resolve));
        answers.push(logContext.privateSessionLive());
      }
    });
    const seenByHook = [];
    // Whether the session is still open when a hook runs.
    mod.registerPrivateCleanup(() =>
      seenByHook.push(logContext.runWithPrivateLogContext(true, () => logContext.privateSessionLive()))
    );

    expect(await ask()).toBe(true);
    createdWindows[0].emit('closed');
    expect(await ask()).toBe(true);
    createdWindows[1].emit('closed');
    expect(await ask()).toBe(false);
    expect(seenByHook).toEqual([true, false]);

    // A new private window opens a new session; the old context stays ended.
    mod.createPrivateWindow();
    expect(await ask()).toBe(false);
    logContext.runWithPrivateLogContext(true, () =>
      expect(logContext.privateSessionLive()).toBe(true)
    );
  });
});

describe('Tor windows (#473)', () => {
  test('the session is routed through Tor before the window opens', async () => {
    const { mod, createMainWindow, configurator } = loadWithWindowFactory();
    const order = [];
    const routeThroughTor = jest.fn(async (partition, session) => {
      order.push(['route', partition, session]);
    });
    createMainWindow.mockImplementationOnce((initialUrl, options) => {
      order.push(['open', options]);
      const win = new FakeWindow(42);
      win.webContents = { id: 4200, session: null };
      return win;
    });

    const win = await mod.createTorWindow('https://example.org/', { routeThroughTor });

    expect(win.id).toBe(42);
    const [[, partition, session]] = order;
    expect(order.map(([step]) => step)).toEqual(['route', 'open']);
    expect(order[1][1]).toEqual({ privatePartition: partition, tor: true });
    expect(configurator).toHaveBeenCalledWith(session, { partition, tor: true });
    // A Tor window is a private window too, and both classifications hold
    // for its session and its chrome renderer.
    expect(mod.isTorSession(session)).toBe(true);
    expect(mod.isPrivateWebContents({ session })).toBe(true);
    expect(mod.isTorWebContents({ session })).toBe(true);
  });

  test('a session that cannot be routed opens no window', async () => {
    const { mod, createMainWindow } = loadWithWindowFactory();
    const routeThroughTor = jest.fn().mockRejectedValue(new Error('no proxy'));

    await expect(mod.createTorWindow(null, { routeThroughTor })).resolves.toBeNull();
    await expect(mod.createTorWindow(null, {})).resolves.toBeNull();
    expect(createMainWindow).not.toHaveBeenCalled();
  });

  test('a private window is not a Tor window', () => {
    const { mod } = loadWithWindowFactory();
    const win = mod.createPrivateWindow();
    expect(win.options).toEqual({ privatePartition: expect.any(String), tor: false });
    expect(mod.isTorWebContents(win.webContents)).toBe(false);
  });
});
