const { EventEmitter } = require('events');
const {
  CHANNEL,
  DEFAULT_SELECTED_CHAIN_ID,
  selectedChainOf,
  selectChain,
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
});
