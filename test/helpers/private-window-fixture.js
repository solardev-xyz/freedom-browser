/* global jest */

/**
 * Windows for the real private-window registry
 * (src/main/private/private-windows.js) in a main-process test.
 *
 * Route the test's electron mock through `fromWebContents` (as
 * BrowserWindow.fromWebContents) and `fromPartition` (as
 * session.fromPartition), and its ../windows/mainWindow mock through
 * `createMainWindow`. Then:
 *  - `publicSender()` is the chrome renderer of a window main knows is not
 *    private;
 *  - `privateSender(privateWindows)` opens a private window through the
 *    real registry and returns its chrome renderer;
 *  - `lookup.mode` ('registry' | 'null' | 'throw') fakes a window lookup
 *    that finds nothing or throws.
 */
const { EventEmitter } = require('events');

function createPrivateWindowFixture() {
  const lookup = { mode: 'registry' };
  const windows = new Map();
  let nextId = 1;

  const createMainWindow = () => {
    const win = new EventEmitter();
    win.id = nextId;
    nextId += 1;
    win.isDestroyed = () => false;
    win.webContents = { id: win.id * 100, isDestroyed: () => false, send: jest.fn() };
    windows.set(win.webContents, win);
    return win;
  };

  const fromWebContents = (contents) => {
    if (lookup.mode === 'throw') throw new Error('webContents destroyed mid-lookup');
    if (lookup.mode === 'null') return null;
    return windows.get(contents) || null;
  };

  const fromPartition = () => ({
    clearStorageData: async () => {},
    clearCache: async () => {},
  });

  const privateSender = (privateWindows) => {
    privateWindows.setPrivateSessionConfigurator(() => {});
    return privateWindows.createPrivateWindow().webContents;
  };

  return {
    lookup,
    createMainWindow,
    fromWebContents,
    fromPartition,
    publicSender: () => createMainWindow().webContents,
    privateSender,
  };
}

module.exports = { createPrivateWindowFixture };
