// focusBrowserWindow is how a running profile answers another profile's
// "focus your window" request (profile-focus-handoff.js → index.js →
// focusOrCreateMainWindow). The request arrives from a different process, so
// every platform has to get past its window manager's focus-stealing
// prevention in its own way (issue #142 for Linux).

const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');

function makeWindow({ focused = false } = {}) {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => focused,
    restore: record('restore'),
    show: record('show'),
    focus: record('focus'),
    setAlwaysOnTop: record('setAlwaysOnTop'),
    flashFrame: record('flashFrame'),
    once: record('once'),
  };
}

function loadForPlatform(platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  const appFocus = jest.fn();
  try {
    const { mod } = loadMainModule(require.resolve('./mainWindow'), {
      app: { isPackaged: false, focus: appFocus },
      extraMocks: {
        [require.resolve('../logger')]: () => ({
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        }),
        [require.resolve('../settings-store')]: () => ({ loadSettings: () => ({}) }),
      },
    });
    return { mod, appFocus, restore: () => Object.defineProperty(process, 'platform', original) };
  } catch (error) {
    Object.defineProperty(process, 'platform', original);
    throw error;
  }
}

describe('focusBrowserWindow', () => {
  let ctx;
  afterEach(() => ctx?.restore());

  test('linux: raises through an always-on-top toggle around focus()', () => {
    ctx = loadForPlatform('linux');
    const win = makeWindow();
    expect(ctx.mod.focusBrowserWindow(win)).toBe(true);
    expect(win.calls).toEqual([
      ['setAlwaysOnTop', true],
      ['focus'],
      ['setAlwaysOnTop', false],
      ['focus'],
    ]);
  });

  test('linux: never flashes the frame, even when focus was refused', () => {
    // On Linux flashFrame(true) sets "demands attention", which GNOME shows
    // as the "'Freedom' is ready" notification #142 is about.
    ctx = loadForPlatform('linux');
    const win = makeWindow({ focused: false });
    ctx.mod.focusBrowserWindow(win);
    expect(win.calls.some(([name]) => name === 'flashFrame')).toBe(false);
  });

  test('win32: toggles always-on-top and flashes the frame if still unfocused', () => {
    ctx = loadForPlatform('win32');
    const win = makeWindow({ focused: false });
    ctx.mod.focusBrowserWindow(win);
    expect(win.calls.slice(0, 4)).toEqual([
      ['setAlwaysOnTop', true],
      ['focus'],
      ['setAlwaysOnTop', false],
      ['flashFrame', true],
    ]);
  });

  test('darwin: steals focus through app.focus, no always-on-top toggle', () => {
    ctx = loadForPlatform('darwin');
    const win = makeWindow();
    ctx.mod.focusBrowserWindow(win);
    expect(ctx.appFocus).toHaveBeenCalledWith({ steal: true });
    expect(win.calls).toEqual([['focus']]);
  });
});

// Links a launch was given reach the window as `initialUrl` query parameters
// (a new window) or `tab:new-with-url` messages (an open one), #597.
describe('opening launch URLs', () => {
  let restorePlatform;
  let windows;

  function load() {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    restorePlatform = () => Object.defineProperty(process, 'platform', original);
    windows = [];
    class FakeBrowserWindow {
      constructor() {
        this.loadFile = jest.fn();
        this.webContents = { send: jest.fn(), on: jest.fn() };
        this.handlers = {};
        this.destroyed = false;
        windows.push(this);
      }
      on(event, handler) {
        (this.handlers[event] ||= []).push(handler);
      }
      emit(event) {
        for (const handler of this.handlers[event] || []) handler();
      }
      once() {}
      isDestroyed() {
        return this.destroyed;
      }
      isMinimized() {
        return false;
      }
      isVisible() {
        return true;
      }
      isFocused() {
        return true;
      }
      focus() {}
      setAlwaysOnTop() {}
      flashFrame() {}
    }
    const { mod } = loadMainModule(require.resolve('./mainWindow'), {
      app: { isPackaged: false, focus: jest.fn() },
      BrowserWindow: FakeBrowserWindow,
      extraMocks: {
        [require.resolve('../logger')]: () => ({
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        }),
        [require.resolve('../settings-store')]: () => ({ loadSettings: () => ({}) }),
        [require.resolve('../test-harness')]: () => ({ isTestMode: () => false }),
      },
    });
    return mod;
  }

  afterEach(() => restorePlatform?.());

  test('a new window gets each URL as an initialUrl parameter, in order', () => {
    const mod = load();
    mod.focusOrCreateMainWindow(['freedom://settings', 'bzz://ab12cd34/?a=1&b=2']);
    expect(windows).toHaveLength(1);
    const [, options] = windows[0].loadFile.mock.calls[0];
    expect(new URLSearchParams(options.search).getAll('initialUrl')).toEqual([
      'freedom://settings',
      'bzz://ab12cd34/?a=1&b=2',
    ]);
  });

  test('a single URL and the private partition still reach the renderer', () => {
    const mod = load();
    mod.createMainWindow('https://example.com/', { privatePartition: 'private-abc' });
    const params = new URLSearchParams(windows[0].loadFile.mock.calls[0][1].search);
    expect(params.getAll('initialUrl')).toEqual(['https://example.com/']);
    expect(params.get('privatePartition')).toBe('private-abc');
  });

  test('a window with no URL loads index.html without parameters', () => {
    const mod = load();
    mod.focusOrCreateMainWindow([]);
    expect(windows[0].loadFile.mock.calls[0]).toHaveLength(1);
  });

  test('an open window gets a new tab per URL instead of a second window', () => {
    const mod = load();
    mod.createMainWindow();
    mod.focusOrCreateMainWindow(['freedom://settings', 'https://freedombrowser.eth.limo/']);
    expect(windows).toHaveLength(1);
    expect(windows[0].webContents.send.mock.calls).toEqual([
      ['tab:new-with-url', 'freedom://settings'],
      ['tab:new-with-url', 'https://freedombrowser.eth.limo/'],
    ]);
  });

  test('a plain focus request opens no tab', () => {
    const mod = load();
    mod.createMainWindow();
    mod.focusOrCreateMainWindow(null);
    expect(windows[0].webContents.send).not.toHaveBeenCalled();
  });

  // R1-M1 (#630): links from outside go to the last-focused *normal* window,
  // never into a private window's throwaway partition.
  function close(win) {
    win.destroyed = true;
    win.emit('closed');
  }

  test('links skip a private window that is older than the normal one', () => {
    const mod = load();
    const a = mod.createMainWindow();
    const p = mod.createMainWindow(null, { privatePartition: 'private-1' });
    close(a);
    const b = mod.createMainWindow();
    mod.focusOrCreateMainWindow(['https://example.com/']);
    expect(p.webContents.send).not.toHaveBeenCalled();
    expect(b.webContents.send.mock.calls).toEqual([['tab:new-with-url', 'https://example.com/']]);
  });

  test('links go to the most recently focused normal window', () => {
    const mod = load();
    const a = mod.createMainWindow();
    const b = mod.createMainWindow();
    const p = mod.createMainWindow(null, { privatePartition: 'private-1' });
    a.emit('focus');
    p.emit('focus');
    mod.focusOrCreateMainWindow(['https://example.com/']);
    expect(a.webContents.send).toHaveBeenCalledWith('tab:new-with-url', 'https://example.com/');
    expect(b.webContents.send).not.toHaveBeenCalled();
    expect(p.webContents.send).not.toHaveBeenCalled();
  });

  test('links open a new normal window when only private windows are open', () => {
    const mod = load();
    const p = mod.createMainWindow(null, { privatePartition: 'private-1' });
    mod.focusOrCreateMainWindow(['https://example.com/']);
    expect(p.webContents.send).not.toHaveBeenCalled();
    expect(windows).toHaveLength(2);
    const params = new URLSearchParams(windows[1].loadFile.mock.calls[0][1].search);
    expect(params.getAll('initialUrl')).toEqual(['https://example.com/']);
    expect(params.get('privatePartition')).toBeNull();
  });

  test('a plain focus request raises the last-used window, private included', () => {
    const mod = load();
    const a = mod.createMainWindow();
    const p = mod.createMainWindow(null, { privatePartition: 'private-1' });
    p.emit('focus');
    expect(mod.focusOrCreateMainWindow(null)).toBe(p);
    a.emit('focus');
    expect(mod.focusOrCreateMainWindow(null)).toBe(a);
    expect(windows).toHaveLength(2);
  });
});
