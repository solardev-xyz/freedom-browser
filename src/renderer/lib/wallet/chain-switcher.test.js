// The chain switcher tells main every selection (freedom-core design 0011,
// PRQ-3): main answers pages' Ethereum reads with the window's selected
// chain, so it hears of each change before any page does.

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
    const webview = { id: 'active' };
    jest.doMock('./balance-display.js', () => ({
      renderAssetList: jest.fn(),
      loadChainRegistry: jest.fn(async () => {}),
    }));
    jest.doMock('../dapp-provider.js', () => ({
      getActiveWebview: () => webview,
      emitChainChanged: jest.fn((_webview, chainId) => log.push(['chainChanged', chainId])),
    }));
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
        selectChain: jest.fn((chainId) => log.push(['main', chainId])),
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

  test('a chain the user picks reaches main before the page hears chainChanged', async () => {
    log.length = 0;
    // Items: "All Chains", then the registered chains in order.
    await pick(1);
    expect(walletState.selectedChainId).toBe(1);
    expect(log).toEqual([
      ['main', 1],
      ['chainChanged', '0x1'],
    ]);
    log.length = 0;
    await pick(0);
    expect(walletState.selectedChainId).toBeNull();
    expect(log).toEqual([['main', null]]);
  });

  test('a page\'s chain switch through the chrome reaches main too', () => {
    log.length = 0;
    switcher.setSelectedChainId(1);
    switcher.setSelectedChainId(1);
    expect(log).toEqual([['main', 1]]);
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
  test('a chain main selected for a page\'s switch shows in the switcher, with no chainChanged from the chrome', () => {
    log.length = 0;
    expect(typeof pageSelected).toBe('function');
    pageSelected(1);
    expect(walletState.selectedChainId).toBe(1);
    expect(elements.get('chain-switcher-name').textContent).toBe('Ethereum');
    // The report back to main is the same chain; no page hears it from here.
    expect(log).toEqual([['main', 1]]);
    pageSelected('0x64');
    pageSelected(0);
    expect(walletState.selectedChainId).toBe(1);
  });

  test('a chrome without the API still switches', () => {
    delete window.wallet;
    switcher.setSelectedChainId(1);
    expect(walletState.selectedChainId).toBe(1);
  });
});
