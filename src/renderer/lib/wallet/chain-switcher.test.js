/**
 * The wallet's chain is global, and a dApp page sends and signs on the chain
 * it was last told (dapp-provider.js). Every way the selection changes must
 * therefore tell the pages (syncPagesToSelectedChain), "All Chains" and a
 * removed chain's fallback included, not only a pick of another chain.
 */
const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const load = async ({ selected = 100, registered = { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis' } } } = {}) => {
  jest.resetModules();
  const walletState = { selectedChainId: selected, registeredChains: registered };
  const provider = { syncPagesToSelectedChain: jest.fn() };
  jest.doMock('./wallet-state.js', () => ({ walletState }));
  jest.doMock('./wallet-utils.js', () => ({ escapeHtml: (s) => String(s) }));
  jest.doMock('./balance-display.js', () => ({
    renderAssetList: jest.fn(),
    loadChainRegistry: jest.fn(async () => {}),
  }));
  jest.doMock('../dapp-provider.js', () => provider);

  const ids = [
    'chain-switcher', 'chain-switcher-btn', 'chain-switcher-name', 'chain-switcher-logo',
    'chain-switcher-logo-placeholder', 'chain-switcher-dropdown', 'chain-switcher-list',
  ];
  const elementsById = Object.fromEntries(ids.map((id) => [id, createElement('div')]));
  global.document = createDocument({ elementsById });
  global.window = {
    networks: {
      getAvailableChains: jest.fn(async () => ({
        success: true,
        chains: Object.fromEntries(Object.keys(registered).map((id) => [id, {}])),
      })),
    },
  };

  const mod = await import('./chain-switcher.js');
  mod.initChainSwitcher();
  const openList = async () => {
    elementsById['chain-switcher-btn'].dispatch('click');
    await flush();
    return elementsById['chain-switcher-list'].children;
  };
  return { mod, walletState, provider, openList };
};

describe('chain switcher tells every dApp page when the chain changes', () => {
  afterEach(() => {
    delete global.document;
    delete global.window;
  });

  test('picking another chain', async () => {
    const { walletState, provider, openList } = await load({ selected: 100 });
    const [, ethereum] = await openList(); // All Chains, Ethereum, Gnosis
    ethereum.dispatch('click');
    expect(walletState.selectedChainId).toBe(1);
    expect(provider.syncPagesToSelectedChain).toHaveBeenCalledTimes(1);
  });

  test('picking "All Chains"', async () => {
    const { walletState, provider, openList } = await load({ selected: 1 });
    const [allChains] = await openList();
    allChains.dispatch('click');
    expect(walletState.selectedChainId).toBe(null);
    expect(provider.syncPagesToSelectedChain).toHaveBeenCalledTimes(1);
  });

  test('re-picking the current chain tells nobody', async () => {
    const { provider, openList } = await load({ selected: 1 });
    const [, ethereum] = await openList();
    ethereum.dispatch('click');
    expect(provider.syncPagesToSelectedChain).not.toHaveBeenCalled();
  });

  test("the selected chain's removal falls back to All Chains and tells the pages", async () => {
    const { walletState, provider, openList } = await load({ selected: 5 });
    await openList();
    expect(walletState.selectedChainId).toBe(null);
    expect(provider.syncPagesToSelectedChain).toHaveBeenCalledTimes(1);
  });

  test("a page's switch or an onchain app's connect (setSelectedChainId)", async () => {
    const { mod, provider } = await load({ selected: 100 });
    mod.setSelectedChainId(100);
    expect(provider.syncPagesToSelectedChain).not.toHaveBeenCalled();
    mod.setSelectedChainId(1);
    expect(provider.syncPagesToSelectedChain).toHaveBeenCalledTimes(1);
  });
});
