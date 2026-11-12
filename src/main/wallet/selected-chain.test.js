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
    expect(win.webContents.send).toHaveBeenCalledWith(PAGE_SELECTED_CHANNEL, 1);
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
