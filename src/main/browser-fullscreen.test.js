const { EventEmitter } = require('events');

let mockCursor = { x: 0, y: 0 };
jest.mock('electron', () => ({ screen: { getCursorScreenPoint: () => mockCursor } }));
// Off every test window unless a test puts it somewhere.
beforeEach(() => {
  mockCursor = { x: 0, y: 0 };
});

// Browser full screen hides the chrome (#78): the main-process half. The
// window's own enter/leave events are reported to its chrome renderer, driven
// through the real listeners the module attaches, the way Electron calls them.
// Escape is deliberately not claimed: it stays the page's (see the e2e spec).

function load() {
  let mod;
  jest.isolateModules(() => {
    mod = require('./browser-fullscreen');
  });
  return mod;
}

function chromeWindow({ fullScreen = false } = {}) {
  const win = new EventEmitter();
  let state = fullScreen;
  win.isDestroyed = () => false;
  win.isFullScreen = () => state;
  win.setFullScreen = jest.fn((next) => {
    state = next;
  });
  win.setWindowButtonVisibility = jest.fn();
  win.setWindowButtonPosition = jest.fn();
  win.getContentBounds = () => ({ x: 100, y: 50, width: 800, height: 600 });
  win.webContents = new EventEmitter();
  win.webContents.send = jest.fn();
  win.webContents.isDestroyed = () => false;
  return win;
}

describe('reporting full screen to the chrome', () => {
  test('every enter and leave is sent, whatever started it', () => {
    const win = chromeWindow();
    const mod = load();
    mod.attachFullscreenChromeSync(win);

    win.isFullScreen = () => true;
    win.emit('enter-full-screen');
    win.isFullScreen = () => false;
    win.emit('leave-full-screen');

    expect(win.webContents.send.mock.calls).toEqual([
      ['window:fullscreen-changed', true],
      ['window:fullscreen-changed', false],
    ]);
  });

  test('a reloaded chrome is told the current state', () => {
    const win = chromeWindow({ fullScreen: true });
    const mod = load();
    mod.attachFullscreenChromeSync(win);

    win.webContents.emit('did-finish-load');
    expect(win.webContents.send).toHaveBeenCalledWith('window:fullscreen-changed', true);
  });

  test('a destroyed window is not written to', () => {
    const win = chromeWindow();
    const mod = load();
    mod.attachFullscreenChromeSync(win);
    win.isDestroyed = () => true;
    win.emit('leave-full-screen');
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

// Free Mode: the chrome hides as in full screen while the window stays
// a window, for recordings and streams.
describe('Free Mode', () => {
  const realPlatform = process.platform;
  const setPlatform = (value) => Object.defineProperty(process, 'platform', { value });
  afterEach(() => setPlatform(realPlatform));

  test('toggling reports each state to the chrome', () => {
    const win = chromeWindow();
    const mod = load();
    mod.toggleFreeMode(win);
    expect(mod.isFreeMode(win)).toBe(true);
    mod.toggleFreeMode(win);
    expect(mod.isFreeMode(win)).toBe(false);
    expect(win.webContents.send.mock.calls).toEqual([
      ['window:free-mode-changed', true],
      ['window:free-mode-changed', false],
    ]);
  });

  test('is per window', () => {
    const a = chromeWindow();
    const b = chromeWindow();
    const mod = load();
    mod.setFreeMode(a, true);
    expect(mod.isFreeMode(b)).toBe(false);
  });

  test('a reloaded chrome is told the Free Mode state too', () => {
    const win = chromeWindow();
    const mod = load();
    mod.attachFullscreenChromeSync(win);
    mod.setFreeMode(win, true);
    win.webContents.send.mockClear();
    win.webContents.emit('did-finish-load');
    expect(win.webContents.send).toHaveBeenCalledWith('window:free-mode-changed', true);
  });

  test('hides the macOS traffic lights, and again after leaving full screen', () => {
    setPlatform('darwin');
    const win = chromeWindow();
    const mod = load();
    mod.attachFullscreenChromeSync(win);
    mod.setFreeMode(win, true);
    expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
    win.setWindowButtonVisibility.mockClear();
    win.emit('leave-full-screen');
    expect(win.setWindowButtonVisibility).toHaveBeenCalledWith(false);
    mod.setFreeMode(win, false);
    expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
  });

  test('leaves window buttons alone off macOS', () => {
    setPlatform('linux');
    const win = chromeWindow();
    const mod = load();
    mod.setFreeMode(win, true);
    expect(win.setWindowButtonVisibility).not.toHaveBeenCalled();
  });

  describe('the drag bar', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      setPlatform('darwin');
    });
    afterEach(() => jest.useRealTimers());

    const barCalls = (win) =>
      win.webContents.send.mock.calls.filter(([channel]) => channel === 'window:free-mode-bar-changed');

    test('reveals with the traffic lights, moved into the bar', () => {
      const win = chromeWindow();
      const mod = load();
      mod.setFreeMode(win, true);
      expect(win.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 14, y: 8 });
      mockCursor = { x: 300, y: 52 };
      mod.revealFreeModeBar(win);
      expect(barCalls(win)).toEqual([['window:free-mode-bar-changed', true]]);
      expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
    });

    test('stays while the pointer is over it and folds the moment it leaves', () => {
      const win = chromeWindow();
      const mod = load();
      mod.setFreeMode(win, true);
      mockCursor = { x: 300, y: 52 };
      mod.revealFreeModeBar(win);
      // A drag: the window and the pointer move together.
      jest.advanceTimersByTime(200);
      expect(barCalls(win)).toHaveLength(1);
      mockCursor = { x: 300, y: 50 + 28 };
      jest.advanceTimersByTime(16);
      expect(barCalls(win)).toEqual([
        ['window:free-mode-bar-changed', true],
        ['window:free-mode-bar-changed', false],
      ]);
      expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
    });

    test('folds when the pointer leaves out of the window', () => {
      const win = chromeWindow();
      const mod = load();
      mod.setFreeMode(win, true);
      mockCursor = { x: 300, y: 52 };
      mod.revealFreeModeBar(win);
      mockCursor = { x: 300, y: 40 };
      jest.advanceTimersByTime(16);
      expect(barCalls(win).at(-1)).toEqual(['window:free-mode-bar-changed', false]);
    });

    test('is not revealed outside Free Mode or in full screen', () => {
      const plain = chromeWindow();
      const full = chromeWindow({ fullScreen: true });
      const mod = load();
      mod.setFreeMode(full, true);
      mod.revealFreeModeBar(plain);
      mod.revealFreeModeBar(full);
      expect(barCalls(plain)).toHaveLength(0);
      expect(barCalls(full)).toHaveLength(0);
    });

    test('leaving Free Mode folds it and puts the traffic lights back', () => {
      const win = chromeWindow();
      const mod = load();
      mod.setFreeMode(win, true);
      mockCursor = { x: 300, y: 52 };
      mod.revealFreeModeBar(win);
      mod.setFreeMode(win, false);
      expect(barCalls(win).at(-1)).toEqual(['window:free-mode-bar-changed', false]);
      expect(win.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 14, y: 14 });
      expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
    });
  
    test('stays up through a drag by it, wherever the cursor reads, then folds', () => {
      const win = chromeWindow();
      let position = [100, 22];
      win.getPosition = () => position;
      win.setPosition = jest.fn((x, y) => {
        position = [x, y];
      });
      const mod = load();
      mod.setFreeMode(win, true);
      mockCursor = { x: 300, y: 60 };
      mod.revealFreeModeBar(win);
      mod.dragFreeModeBar(win, 'start');
      // The cursor runs ahead of the window (or past the menu bar).
      mockCursor = { x: 420, y: 20 };
      mod.dragFreeModeBar(win, 'move');
      expect(win.setPosition).toHaveBeenLastCalledWith(220, -18);
      jest.advanceTimersByTime(200);
      expect(barCalls(win)).toHaveLength(1);
      // Released with the cursor off the (stubbed, unmoved) bar: it goes.
      mod.dragFreeModeBar(win, 'end');
      jest.advanceTimersByTime(16);
      expect(barCalls(win).at(-1)).toEqual(['window:free-mode-bar-changed', false]);
    });

    test('a drag needs the bar up, and moves nothing once ended', () => {
      const win = chromeWindow();
      win.getPosition = () => [0, 0];
      win.setPosition = jest.fn();
      const mod = load();
      mod.setFreeMode(win, true);
      mod.dragFreeModeBar(win, 'start');
      mod.dragFreeModeBar(win, 'move');
      expect(win.setPosition).not.toHaveBeenCalled();
      mockCursor = { x: 300, y: 60 };
      mod.revealFreeModeBar(win);
      mod.dragFreeModeBar(win, 'start');
      mod.dragFreeModeBar(win, 'end');
      mod.dragFreeModeBar(win, 'move');
      expect(win.setPosition).not.toHaveBeenCalled();
    });

    test('entering Free Mode with the cursor on the bar shows it at once', () => {
      const win = chromeWindow();
      const mod = load();
      mockCursor = { x: 880, y: 60 };
      mod.setFreeMode(win, true);
      expect(barCalls(win)).toEqual([['window:free-mode-bar-changed', true]]);
      expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
    });

    test('entering Free Mode with the cursor on the page leaves it folded', () => {
      const win = chromeWindow();
      const mod = load();
      mockCursor = { x: 300, y: 300 };
      mod.setFreeMode(win, true);
      expect(barCalls(win)).toHaveLength(0);
    });
  
    test('leaving shows the lights before moving them back (macOS ignores a hidden move)', () => {
      const win = chromeWindow();
      const order = [];
      win.setWindowButtonVisibility = jest.fn((v) => order.push(`visible:${v}`));
      win.setWindowButtonPosition = jest.fn((p) => order.push(`y:${p.y}`));
      const mod = load();
      mod.setFreeMode(win, true);
      order.length = 0;
      mod.setFreeMode(win, false);
      expect(order).toEqual(['visible:true', 'y:14']);
    });
  
    test('an ask with the cursor off the bar (a stale one) reveals nothing', () => {
      const win = chromeWindow();
      const mod = load();
      mod.setFreeMode(win, true);
      mockCursor = { x: 300, y: 300 };
      mod.revealFreeModeBar(win);
      expect(barCalls(win)).toHaveLength(0);
    });
  });
});

