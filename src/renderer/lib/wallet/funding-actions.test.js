const CHECKSUM_XBZZ_KEY = '100:0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da';
const NORMALIZED_XBZZ_KEY = '100:0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const XDAI_TOKEN_KEY = '100:native';

function createWalletState(overrides = {}) {
  return {
    fullAddresses: {
      swarm: '0xF1f61666Be8555e3D39d46C43B12eE829f8A97a1',
    },
    currentBalances: {},
    registeredTokens: {},
    ...overrides,
  };
}

async function loadFundingActions(walletState) {
  jest.resetModules();

  const openSend = jest.fn();
  const openReceive = jest.fn();

  jest.doMock('./wallet-state.js', () => ({ walletState }));
  jest.doMock('./send.js', () => ({ openSend }));
  jest.doMock('./receive.js', () => ({ openReceive }));

  const mod = await import('./funding-actions.js');
  return { mod, openSend, openReceive };
}

describe('funding-actions', () => {
  afterEach(() => {
    jest.dontMock('./wallet-state.js');
    jest.dontMock('./send.js');
    jest.dontMock('./receive.js');
  });

  test('normalizes token keys the way the token registry emits them', async () => {
    const walletState = createWalletState();
    const { mod } = await loadFundingActions(walletState);

    expect(mod.normalizeTokenKey(CHECKSUM_XBZZ_KEY)).toBe(NORMALIZED_XBZZ_KEY);
    expect(mod.normalizeTokenKey(XDAI_TOKEN_KEY)).toBe(XDAI_TOKEN_KEY);
  });

  test('opens xDAI send flow when the main wallet has xDAI', async () => {
    const walletState = createWalletState({
      currentBalances: {
        [XDAI_TOKEN_KEY]: { formatted: '0.25' },
      },
    });
    const { mod, openSend, openReceive } = await loadFundingActions(walletState);

    expect(mod.topUpXdai()).toEqual({ action: 'send' });
    expect(openSend).toHaveBeenCalledWith({
      recipient: walletState.fullAddresses.swarm,
      chainId: 100,
      tokenKey: XDAI_TOKEN_KEY,
      tokenSymbol: 'xDAI',
    });
    expect(openReceive).not.toHaveBeenCalled();
  });

  test('opens receive flow for xDAI top-up when the main wallet has no xDAI', async () => {
    const walletState = createWalletState({ currentBalances: {} });
    const { mod, openReceive, openSend } = await loadFundingActions(walletState);

    expect(mod.topUpXdai()).toEqual({ action: 'receive' });
    expect(openReceive).toHaveBeenCalledTimes(1);
    expect(openSend).not.toHaveBeenCalled();
  });

  test('reads legacy checksum-cased balance maps', async () => {
    const walletState = createWalletState();
    const { mod } = await loadFundingActions(walletState);

    expect(
      mod.hasPositiveTokenBalance({
        [CHECKSUM_XBZZ_KEY]: { formatted: '0.1' },
      }, NORMALIZED_XBZZ_KEY)
    ).toBe(true);
  });

  test('returns present falsy token-map entries without falling through to legacy scan', async () => {
    const walletState = createWalletState();
    const { mod } = await loadFundingActions(walletState);

    expect(mod.getTokenMapEntry({
      [NORMALIZED_XBZZ_KEY]: false,
      [CHECKSUM_XBZZ_KEY]: { symbol: 'legacy' },
    }, NORMALIZED_XBZZ_KEY)).toBe(false);
  });
});
