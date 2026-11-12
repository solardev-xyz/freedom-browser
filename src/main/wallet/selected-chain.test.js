const { EventEmitter } = require('events');
const {
  CHANNEL,
  DEFAULT_SELECTED_CHAIN_ID,
  selectedChainOf,
  selectChain,
  selectChainForPage,
  PAGE_SELECTED_CHANNEL,
  onChromeSelection,
  registerSelectedChainIpc,
  resetSelectedChains,
} = require('./selected-chain');

function fakeIpc() {
  const listeners = new Map();
  return {
    on: (channel, listener) => listeners.set(channel, listener),
    emit: (channel, event, ...args) => listeners.get(channel)(event, ...args),
    channels: () => [...listeners.keys()],
  };
}

class FakeWindow extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.destroyed = false;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

describe('the selected chain in main (freedom-core design 0011, PRQ-3)', () => {
  beforeEach(() => resetSelectedChains());

  test('a window that reported nothing has the chain switcher\'s default, Gnosis', () => {
    expect(DEFAULT_SELECTED_CHAIN_ID).toBe(100);
    expect(selectedChainOf(7)).toBe(100);
  });

  test('each window keeps its own selection, "All Chains" included; a malformed one is ignored', () => {
    expect(selectChain(1, 1)).toBe(true);
    expect(selectChain(2, null)).toBe(true);
    expect(selectedChainOf(1)).toBe(1);
    expect(selectedChainOf(2)).toBeNull();
    for (const bad of [0, -1, 1.5, '1', '0x1', undefined, Number.MAX_SAFE_INTEGER + 1, {}]) {
      expect(selectChain(1, bad)).toBe(false);
    }
    expect(selectChain('1', 5)).toBe(false);
    expect(selectedChainOf(1)).toBe(1);
  });

  test('wallet:select-chain records the sending chrome\'s window, until that window closes', () => {
    const ipc = fakeIpc();
    const windows = new Map([['chrome-1', new FakeWindow(1)], ['chrome-2', new FakeWindow(2)]]);
    registerSelectedChainIpc(ipc, { windowOf: (sender) => windows.get(sender) || null });
    expect(ipc.channels()).toEqual([CHANNEL]);
    expect(CHANNEL).toBe('wallet:select-chain');

    ipc.emit(CHANNEL, { sender: 'chrome-1' }, 1);
    ipc.emit(CHANNEL, { sender: 'chrome-2' }, 10);
    ipc.emit(CHANNEL, { sender: 'chrome-1' }, 42161);
    ipc.emit(CHANNEL, { sender: 'unknown' }, 5);
    ipc.emit(CHANNEL, { sender: 'chrome-2' }, 'nonsense');
    expect(selectedChainOf(1)).toBe(42161);
    expect(selectedChainOf(2)).toBe(10);

    windows.get('chrome-1').emit('closed');
    expect(selectedChainOf(1)).toBe(100);
    expect(selectedChainOf(2)).toBe(10);
    // One close listener per window, however often it reports.
    expect(windows.get('chrome-2').listenerCount('closed')).toBe(1);

    windows.get('chrome-2').destroyed = true;
    ipc.emit(CHANNEL, { sender: 'chrome-2' }, 3);
    expect(selectedChainOf(2)).toBe(10);
  });

  // PRQ-4: a page's wallet_switchEthereumChain is main's; main selects the
  // chain for the page's window and tells that window's chrome.
  test('a page\'s switch selects the chain for its window and tells that window\'s chrome', () => {
    const win = new FakeWindow(4);
    win.webContents = { send: jest.fn(), isDestroyed: () => false };
    const windowFromId = (id) => (id === 4 ? win : null);
    expect(selectChainForPage(4, 1, { windowFromId })).toBe(true);
    expect(selectedChainOf(4)).toBe(1);
    expect(win.webContents.send).toHaveBeenCalledWith(PAGE_SELECTED_CHANNEL, { chainId: 1, sequence: 1 });
    expect(PAGE_SELECTED_CHANNEL).toBe('wallet:page-selected-chain');
    // Not "All Chains", not a malformed chain, not a window that has gone.
    expect(selectChainForPage(4, null, { windowFromId })).toBe(false);
    expect(selectChainForPage(4, 0, { windowFromId })).toBe(false);
    expect(selectChainForPage(5, 10, { windowFromId })).toBe(false);
    expect(selectedChainOf(5)).toBe(100);
    win.emit('closed');
    expect(selectedChainOf(4)).toBe(100);
    win.destroyed = true;
    expect(selectChainForPage(4, 10, { windowFromId })).toBe(false);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });
});

// freedom-core design 0011, PRQ-6: main tells a window's pages of the user's
// selection (page/page-events.js), so it hears each change the chrome makes,
// with the selection before it, after recording it.
describe('the chrome\'s selection is told to main\'s listeners (0011 PRQ-6)', () => {
  beforeEach(() => resetSelectedChains());

  function setupIpc() {
    const ipc = fakeIpc();
    const windows = new Map([['chrome-1', new FakeWindow(1)], ['chrome-2', new FakeWindow(2)]]);
    registerSelectedChainIpc(ipc, { windowOf: (sender) => windows.get(sender) || null });
    return { ipc, windows };
  }

  test('each change, with its window and the selection before it, recorded before it is told', () => {
    const { ipc } = setupIpc();
    const heard = [];
    const stop = onChromeSelection((change) => heard.push({ ...change, recorded: selectedChainOf(change.window) }));
    ipc.emit(CHANNEL, { sender: 'chrome-1' }, 1);
    ipc.emit(CHANNEL, { sender: 'chrome-2' }, 10);
    ipc.emit(CHANNEL, { sender: 'chrome-1' }, null);
    expect(heard).toEqual([
      { window: 1, previous: 100, next: 1, recorded: 1 },
      { window: 2, previous: 100, next: 10, recorded: 10 },
      { window: 1, previous: 1, next: null, recorded: null },
    ]);
    stop();
    ipc.emit(CHANNEL, { sender: 'chrome-1' }, 5);
    expect(heard).toHaveLength(3);
  });

  test('no change, a malformed one, an unknown sender and a page\'s switch are not told', () => {
    const { ipc } = setupIpc();
    const heard = [];
    const stop = onChromeSelection((change) => heard.push(change));
    // The starting report: the switcher's default, which main already has.
    ipc.emit(CHANNEL, { sender: 'chrome-1' }, 100);
    ipc.emit(CHANNEL, { sender: 'chrome-1' }, 'nonsense');
    ipc.emit(CHANNEL, { sender: 'unknown' }, 5);
    // A page's switch tells its own pages (page-ethereum.js).
    const win = new FakeWindow(1);
    win.webContents = { send: jest.fn(), isDestroyed: () => false };
    expect(selectChainForPage(1, 10, { windowFromId: () => win })).toBe(true);
    expect(heard).toEqual([]);
    // The chrome's report of the same chain changes nothing either.
    ipc.emit(CHANNEL, { sender: 'chrome-1' }, 10);
    expect(heard).toEqual([]);
    stop();
  });

  test('one listener\'s failure does not keep another from hearing', () => {
    const { ipc } = setupIpc();
    const heard = [];
    const stops = [
      onChromeSelection(() => {
        throw new Error('boom');
      }),
      onChromeSelection((change) => heard.push(change.next)),
    ];
    ipc.emit(CHANNEL, { sender: 'chrome-1' }, 1);
    expect(heard).toEqual([1]);
    for (const stop of stops) stop();
    expect(onChromeSelection(null)()).toBeUndefined();
  });
});

// freedom-core design 0011, PRQ-6: a page's switch and the user's pick are
// two writers of a window's selection. Main numbers its page selections;
// the chrome reports the number it last showed, and main refuses a pick made
// before the switcher showed main's latest, and shows it again.
describe('a page\'s switch and the user\'s pick, ordered (0011 PRQ-6)', () => {
  beforeEach(() => resetSelectedChains());

  function setupWindow() {
    const ipc = fakeIpc();
    const toChrome = [];
    const chrome = { send: jest.fn((channel, payload) => toChrome.push([channel, payload])), isDestroyed: () => false };
    const win = new FakeWindow(1);
    win.webContents = chrome;
    registerSelectedChainIpc(ipc, { windowOf: (sender) => (sender === chrome ? win : null) });
    const heard = [];
    const stop = onChromeSelection((change) => heard.push(change));
    const pageSelects = (chainId) => selectChainForPage(1, chainId, { windowFromId: () => win });
    const chromeReports = (chainId, seen) => ipc.emit(CHANNEL, { sender: chrome }, chainId, seen);
    return { win, toChrome, heard, stop, pageSelects, chromeReports };
  }

  test('each page selection is numbered for its window, and the chrome told the number', () => {
    const env = setupWindow();
    env.pageSelects(1);
    env.pageSelects(10);
    expect(env.toChrome).toEqual([
      [PAGE_SELECTED_CHANNEL, { chainId: 1, sequence: 1 }],
      [PAGE_SELECTED_CHANNEL, { chainId: 10, sequence: 2 }],
    ]);
    env.stop();
  });

  test('a pick made before the switcher showed the page\'s selection is refused, and the selection shown again', () => {
    const env = setupWindow();
    env.pageSelects(1);
    // The user picks "All Chains" from a switcher that still shows Gnosis.
    env.chromeReports(null, 0);
    expect(selectedChainOf(1)).toBe(1);
    expect(env.heard).toEqual([]);
    expect(env.toChrome).toEqual([
      [PAGE_SELECTED_CHANNEL, { chainId: 1, sequence: 1 }],
      [PAGE_SELECTED_CHANNEL, { chainId: 1, sequence: 1 }],
    ]);
    // A report with no number counts as one that saw none.
    env.chromeReports(10);
    expect(selectedChainOf(1)).toBe(1);
    expect(env.toChrome).toHaveLength(3);
    // Once it has shown it, the user's pick counts.
    env.chromeReports(null, 1);
    expect(selectedChainOf(1)).toBeNull();
    expect(env.heard).toEqual([{ window: 1, previous: 1, next: null }]);
    expect(env.toChrome).toHaveLength(3);
    env.stop();
  });

  test('a pick that reached main first counts, and the page\'s later selection then wins', () => {
    const env = setupWindow();
    env.chromeReports(10, 0);
    expect(env.heard).toEqual([{ window: 1, previous: 100, next: 10 }]);
    env.pageSelects(1);
    expect(selectedChainOf(1)).toBe(1);
    expect(env.toChrome).toEqual([[PAGE_SELECTED_CHANNEL, { chainId: 1, sequence: 1 }]]);
    env.stop();
  });

  test('a malformed pick is ignored, refused or not; a closed window starts again from no number', () => {
    const env = setupWindow();
    env.pageSelects(1);
    env.chromeReports('nonsense', 0);
    env.chromeReports(0, 5);
    expect(env.toChrome).toHaveLength(1);
    expect(selectedChainOf(1)).toBe(1);
    env.win.emit('closed');
    env.chromeReports(10, 0);
    expect(selectedChainOf(1)).toBe(10);
    expect(env.toChrome).toHaveLength(1);
    env.stop();
  });

  test('a reloaded chrome\'s starting report is refused, and it is shown the window\'s selection, "All Chains" included', () => {
    const env = setupWindow();
    env.pageSelects(1);
    env.chromeReports(null, 1);
    // The chrome reloads: its switcher starts from Gnosis and no number.
    env.chromeReports(100, 0);
    expect(selectedChainOf(1)).toBeNull();
    expect(env.toChrome.at(-1)).toEqual([PAGE_SELECTED_CHANNEL, { chainId: null, sequence: 1 }]);
    env.stop();
  });
});
