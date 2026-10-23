const { EventEmitter } = require('events');

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
