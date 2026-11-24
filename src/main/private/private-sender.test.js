const { EventEmitter } = require('events');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');

// isPrivateSender over the real private-window registry: only the window
// lookup is faked (R-9 review, through the real classifier).
function loadSender() {
  const lookup = { mode: 'registry' };
  const windows = new Map();
  let nextId = 1;
  const createMainWindow = jest.fn(() => {
    const win = new EventEmitter();
    win.id = nextId++;
    win.isDestroyed = () => false;
    win.webContents = { id: win.id * 100, isDestroyed: () => false };
    windows.set(win.webContents, win);
    return win;
  });
  const fromWebContents = jest.fn((contents) => {
    if (lookup.mode === 'throw') throw new Error('webContents destroyed mid-lookup');
    if (lookup.mode === 'null') return null;
    return windows.get(contents) || null;
  });
  const { mod } = loadMainModule(require.resolve('./private-sender'), {
    electronOverrides: {
      BrowserWindow: { fromWebContents, getAllWindows: jest.fn(() => [...windows.values()]) },
      session: {
        fromPartition: jest.fn(() => ({
          clearStorageData: jest.fn(async () => {}),
          clearCache: jest.fn(async () => {}),
        })),
      },
    },
    extraMocks: {
      [require.resolve('../windows/mainWindow')]: () => ({ createMainWindow }),
    },
  });
  const privateWindows = require('./private-windows');
  privateWindows.setPrivateSessionConfigurator(() => {});
  return {
    mod,
    lookup,
    publicChrome: () => createMainWindow().webContents,
    privateChrome: () => privateWindows.createPrivateWindow().webContents,
  };
}

describe('isPrivateSender (R-9)', () => {
  test('refuses private and unclassifiable senders, and passes a known public one', () => {
    const { mod, lookup, publicChrome, privateChrome } = loadSender();
    const publicSender = publicChrome();
    const privateSender = privateChrome();

    expect(mod.isPrivateSender({ sender: publicSender })).toBe(false);
    expect(mod.isPrivateSender({ sender: { hostWebContents: publicSender } })).toBe(false);
    expect(mod.isPrivateSender({ sender: privateSender })).toBe(true);
    expect(mod.isPrivateSender({ sender: { hostWebContents: privateSender } })).toBe(true);

    for (const event of [
      null,
      undefined,
      {},
      { sender: { isDestroyed: () => true } },
      { sender: { hostWebContents: { isDestroyed: () => true } } },
      { sender: { id: 9, isDestroyed: () => false } }, // no window main can find
    ]) {
      expect(mod.isPrivateSender(event)).toBe(true);
    }

    // The lookup itself returns nothing, or throws: the sender is unknown,
    // so private, even one that would otherwise be public.
    for (const mode of ['null', 'throw']) {
      lookup.mode = mode;
      expect(mod.isPrivateSender({ sender: publicSender })).toBe(true);
      expect(mod.isPrivateSender({ sender: { hostWebContents: publicSender } })).toBe(true);
    }
  });
});
