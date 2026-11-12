// The chain switcher tells main every selection (freedom-core design 0011,
// PRQ-3): main answers pages' Ethereum reads with the window's selected
// chain, and (PRQ-6) tells the window's pages of the change itself. The
// chrome sends no page an event.

function element() {
  const classes = new Set();
  const listeners = new Map();
  return {
    listeners,
    children: [],
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    style: {},
    textContent: '',
    innerHTML: '',
    src: '',
    addEventListener: (type, listener) => listeners.set(type, listener),
    appendChild(child) {
      this.children.push(child);
    },
    contains: () => true,
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('chain switcher: the selection reaches main', () => {
  let log;
  let elements;
  let switcher;
  let walletState;
  let pageSelected;

  beforeEach(async () => {
    pageSelected = null;
    jest.resetModules();
    log = [];
    elements = new Map();
    jest.doMock('./balance-display.js', () => ({
      renderAssetList: jest.fn(),
      loadChainRegistry: jest.fn(async () => {}),
    }));
    // Anything the switcher sent a page would go through the chrome's
    // provider module, which it no longer imports.
    jest.doMock('../dapp-provider.js', () => {
      throw new Error('the chain switcher imports no provider module');
    });
    global.document = {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: () => element(),
      addEventListener: jest.fn(),
    };
    global.window = {
      wallet: {
        selectChain: jest.fn((chainId, seen) => log.push(seen ? ['main', chainId, seen] : ['main', chainId])),
        onPageSelectedChain: jest.fn((listener) => {
          pageSelected = listener;
          return () => {};
        }),
      },
      networks: {
        getAvailableChains: jest.fn(async () => ({ success: true, chains: { 1: {}, 100: {} } })),
      },
    };
    ({ walletState } = await import('./wallet-state.js'));
    walletState.registeredChains = { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis Chain' } };
    walletState.selectedChainId = 100;
    switcher = await import('./chain-switcher.js');
    switcher.initChainSwitcher();
  });

  afterEach(() => {
    delete global.document;
    delete global.window;
  });

  /** Open the dropdown and pick the item at `index`. */
  async function pick(index) {
    elements.get('chain-switcher-btn').listeners.get('click')();
    await flush();
    elements.get('chain-switcher-list').children[index].listeners.get('click')();
  }

  test('the window\'s starting selection is reported as the switcher starts', () => {
    expect(log).toEqual([['main', 100]]);
  });

  test('a chain the user picks reaches main, which tells the pages', async () => {
    log.length = 0;
    // Items: "All Chains", then the registered chains in order.
    await pick(1);
    expect(walletState.selectedChainId).toBe(1);
    expect(log).toEqual([['main', 1]]);
    log.length = 0;
    await pick(0);
    expect(walletState.selectedChainId).toBeNull();
    expect(log).toEqual([['main', null]]);
  });

  test('a selected chain that was removed falls back to "All Chains", in main too', async () => {
    walletState.selectedChainId = 10;
    log.length = 0;
    elements.get('chain-switcher-btn').listeners.get('click')();
    await flush();
    expect(walletState.selectedChainId).toBeNull();
    expect(log).toEqual([['main', null]]);
  });

  // freedom-core design 0011, PRQ-4: main runs a page's switch, selects the
  // chain for the window and tells the page itself.
  test('a chain main selected for a page\'s switch shows in the switcher, and nothing goes back to main', async () => {
    log.length = 0;
    expect(typeof pageSelected).toBe('function');
    pageSelected({ chainId: 1, sequence: 1 });
    expect(walletState.selectedChainId).toBe(1);
    expect(elements.get('chain-switcher-name').textContent).toBe('Ethereum');
    // Main selected it already (PRQ-6).
    expect(log).toEqual([]);
    for (const bad of [1, '0x64', { chainId: '0x64', sequence: 2 }, { chainId: 0, sequence: 2 }, { chainId: 10 }, null]) {
      pageSelected(bad);
    }
    expect(walletState.selectedChainId).toBe(1);
    // The user's next pick reaches main with the number it last showed.
    await pick(2);
    expect(log).toEqual([['main', 100, 1]]);
  });

  test('a selection of main\'s no newer than the last shown is ignored', async () => {
    pageSelected({ chainId: 1, sequence: 2 });
    await pick(2);
    // A copy of an earlier one, or an older one, arriving after the pick.
    pageSelected({ chainId: 1, sequence: 2 });
    pageSelected({ chainId: 1, sequence: 1 });
    expect(walletState.selectedChainId).toBe(100);
    // A newer one shows, "All Chains" included.
    pageSelected({ chainId: null, sequence: 3 });
    expect(walletState.selectedChainId).toBeNull();
    expect(elements.get('chain-switcher-name').textContent).toBe('All Chains');
  });

  test('a chrome without the API still switches', async () => {
    delete window.wallet;
    await pick(1);
    expect(walletState.selectedChainId).toBe(1);
  });
});

// freedom-core design 0011, PRQ-6: the switcher against main's own
// selected-chain module. A page's switch and the user's pick race; main's
// messages to the chrome wait until the test delivers them, so each
// interleaving is run exactly. However they interleave, the switcher, main
// and the pages end on the same chain.
describe('chain switcher and main: a page\'s switch and the user\'s pick, in either order', () => {
  let main;
  let walletState;
  let elements;
  let inbox;
  let told;
  let stopTelling;
  let deliverTo;
  const win = { id: 1, isDestroyed: () => false, once: () => {} };

  async function start(before = () => {}) {
    jest.resetModules();
    elements = new Map();
    inbox = [];
    told = [];
    jest.doMock('./balance-display.js', () => ({
      renderAssetList: jest.fn(),
      loadChainRegistry: jest.fn(async () => {}),
    }));
    main = require('../../../main/wallet/selected-chain.js');
    main.resetSelectedChains();
    const handlers = {};
    const chrome = { send: (_channel, payload) => inbox.push(payload), isDestroyed: () => false };
    win.webContents = chrome;
    main.registerSelectedChainIpc({ on: (channel, handler) => (handlers[channel] = handler) }, { windowOf: () => win });
    // What main tells the window's pages of a pick (page-events.js).
    stopTelling = main.onChromeSelection((change) => told.push(change.next));
    before();
    global.document = {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: () => element(),
      addEventListener: jest.fn(),
    };
    global.window = {
      wallet: {
        selectChain: (chainId, seen) => handlers['wallet:select-chain']({ sender: chrome }, chainId, seen),
        onPageSelectedChain: (listener) => {
          deliverTo = listener;
          return () => {};
        },
      },
      networks: { getAvailableChains: jest.fn(async () => ({ success: true, chains: { 1: {}, 100: {} } })) },
    };
    ({ walletState } = await import('./wallet-state.js'));
    walletState.registeredChains = { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis Chain' } };
    walletState.selectedChainId = 100;
    const switcher = await import('./chain-switcher.js');
    switcher.initChainSwitcher();
    return switcher;
  }

  afterEach(() => {
    stopTelling?.();
    main?.resetSelectedChains();
    delete global.document;
    delete global.window;
  });

  const pageSelects = (chainId) => main.selectChainForPage(1, chainId, { windowFromId: () => win });
  const deliver = () => {
    while (inbox.length) deliverTo(inbox.shift());
  };
  async function userPicks(index) {
    elements.get('chain-switcher-btn').listeners.get('click')();
    await flush();
    elements.get('chain-switcher-list').children[index].listeners.get('click')();
  }

  test('the page\'s switch reaches main first, the user picks before the switcher shows it: all end on the page\'s chain', async () => {
    await start();
    pageSelects(1);
    // Items: "All Chains", Ethereum, Gnosis. The switcher still shows Gnosis.
    await userPicks(0);
    expect(walletState.selectedChainId).toBeNull();
    // Main refused the pick: the pages were told nothing of it.
    expect(main.selectedChainOf(1)).toBe(1);
    expect(told).toEqual([]);
    deliver();
    expect(walletState.selectedChainId).toBe(1);
    expect(elements.get('chain-switcher-name').textContent).toBe('Ethereum');
    // The user picks again, from a switcher that shows main's chain: it counts.
    await userPicks(0);
    expect(main.selectedChainOf(1)).toBeNull();
    expect(walletState.selectedChainId).toBeNull();
    expect(told).toEqual([null]);
  });

  test('the user\'s pick reaches main first, then the page\'s switch: all end on the page\'s chain', async () => {
    await start();
    await userPicks(0);
    expect(told).toEqual([null]);
    pageSelects(1);
    deliver();
    expect(main.selectedChainOf(1)).toBe(1);
    expect(walletState.selectedChainId).toBe(1);
  });

  test('a reloaded chrome shows the selection main kept', async () => {
    await start(() => {
      pageSelects(1);
      inbox.length = 0;
    });
    // Its starting report of Gnosis was made before it showed main's.
    expect(main.selectedChainOf(1)).toBe(1);
    deliver();
    expect(walletState.selectedChainId).toBe(1);
    expect(told).toEqual([]);
  });
});
