/**
 * Tests for the renderer-side dApp provider handler.
 *
 * Focus: binding response delivery to the document that made the request.
 * Main drops Safe signing sessions on navigation, but the renderer must
 * also suppress its own response send — provider request ids restart per
 * document, so a result (or error) that lands after a navigation could
 * satisfy a reused id in the replacement document.
 */

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const SAFE_WALLET_INDEX = 1000;

const loadProvider = async (options = {}) => {
  jest.resetModules();

  const state = {
    permission: options.permission ?? null,
  };

  const walletMocks = {
    getDerivedWallets: jest.fn(async () => ({ success: true, wallets: [] })),
    safeMessageStart: jest.fn(async () => ({
      success: true,
      state: { complete: true, token: 'tok' },
    })),
    safeMessageComplete: jest.fn(async () => ({ success: true, signature: '0xsig' })),
    signMessage: jest.fn(async () => ({ success: true, signature: '0xeoa' })),
    signTypedData: jest.fn(async () => ({ success: true, signature: '0xeoa' })),
    requestChain: jest.fn(async () => ({ success: true, result: '0xfeed' })),
  };

  const dappPermissions = {
    getPermission: jest.fn(async () => state.permission),
    updateLastUsed: jest.fn(async () => {}),
  };

  global.window = {
    electronAPI: {
      getSettings: jest.fn(async () => ({ enableIdentityWallet: true })),
    },
    addEventListener: jest.fn(),
    dappPermissions,
    wallet: walletMocks,
    networks: {
      getChains: jest.fn(async () => ({
        success: true,
        chains: { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis' } },
      })),
      isChainAvailable: jest.fn(async () => ({ available: true })),
    },
    identity: { getStatus: jest.fn(async () => ({ isUnlocked: true })) },
  };

  const addressInput = createElement('input');
  addressInput.value = 'https://app.example';
  global.document = createDocument({ elementsById: { 'address-input': addressInput } });

  const walletUi = {
    showDappConnect: jest.fn(),
    getSelectedChainId: jest.fn(() => 100),
    setSelectedChainId: jest.fn(),
    updateConnectionBanner: jest.fn(),
    showDappTxApproval: jest.fn(),
    showDappSignApproval: jest.fn(),
    showVaultUnlock: jest.fn(),
    updateSwarmConnectionBanner: jest.fn(),
    updateX402ConnectionBanner: jest.fn(),
  };
  jest.doMock('./wallet-ui.js', () => walletUi);
  jest.doMock('./wallet/dapp-tx.js', () => ({
    buildDappTxContext: jest.fn(),
    extractSelector: jest.fn(() => null),
  }));
  jest.doMock('./wallet/wallet-utils.js', () => ({
    isSafeAccount: jest.fn((index) => index >= SAFE_WALLET_INDEX),
    GNOSIS_CHAIN_ID: 100,
  }));
  const safeSigning = {
    openSafeMessageBoard: jest.fn(),
    abandonSafeMessageBoard: jest.fn(),
  };
  jest.doMock('./wallet/safe-signing.js', () => safeSigning);
  jest.doMock('./origin-utils.js', () => ({
    getPermissionKey: jest.fn((url) => url),
  }));

  const mod = await import('./dapp-provider.js');
  // Let the async settings read land so the feature gate opens.
  await flushMicrotasks();

  const webview = createElement('webview');
  webview.send = jest.fn();
  webview.getURL = jest.fn(() => options.webviewUrl || 'https://app.example');
  mod.setupWebviewProvider(webview);

  const sendRequest = (request) => {
    webview.dispatch('ipc-message', {
      channel: 'dapp:provider-request',
      args: [request],
    });
  };

  return {
    mod,
    webview,
    sendRequest,
    state,
    walletMocks,
    dappPermissions,
    safeSigning,
    walletUi,
  };
};

const responsesSentTo = (webview) =>
  webview.send.mock.calls.filter(([channel]) => channel === 'dapp:provider-response');

const safePermission = () => ({
  walletIndex: SAFE_WALLET_INDEX,
  chainId: 100,
  autoApprove: { signing: true },
});

describe('dapp-provider document binding', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('delivers a Safe signature to the document that requested it', async () => {
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
    });

    sendRequest({ id: 1, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();

    expect(walletMocks.safeMessageStart).toHaveBeenCalled();
    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 1,
      result: '0xsig',
      error: null,
    });
  });

  test('a Safe signature that completes after navigation is never delivered', async () => {
    const completion = deferred();
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
    });
    walletMocks.safeMessageComplete.mockReturnValue(completion.promise);

    sendRequest({ id: 2, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();
    expect(walletMocks.safeMessageComplete).toHaveBeenCalled();

    // The webview commits a navigation while the signing path is in flight.
    webview.dispatch('did-navigate', { url: 'https://evil.example' });

    completion.resolve({ success: true, signature: '0xsig' });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('a signing error that arrives after navigation is never delivered', async () => {
    const completion = deferred();
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
    });
    walletMocks.safeMessageComplete.mockReturnValue(completion.promise);

    sendRequest({ id: 3, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();

    webview.dispatch('did-navigate', { url: 'https://evil.example' });

    completion.resolve({ success: false, error: 'signing failed' });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('webview destruction mid-request also suppresses delivery', async () => {
    const completion = deferred();
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
    });
    walletMocks.safeMessageComplete.mockReturnValue(completion.promise);

    sendRequest({ id: 4, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();

    webview.dispatch('destroyed', {});

    completion.resolve({ success: true, signature: '0xsig' });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('the signing board is opened for the requesting webview and withdrawn on navigation', async () => {
    const { webview, sendRequest, walletMocks, safeSigning } = await loadProvider({
      permission: safePermission(),
    });
    walletMocks.safeMessageStart.mockResolvedValue({
      success: true,
      state: { complete: false, token: 'tok' },
    });
    safeSigning.openSafeMessageBoard.mockReturnValue(new Promise(() => {}));

    sendRequest({ id: 5, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();
    expect(safeSigning.openSafeMessageBoard).toHaveBeenCalledWith(
      SAFE_WALLET_INDEX,
      { complete: false, token: 'tok' },
      webview
    );

    webview.dispatch('did-navigate', { url: 'https://other.example' });

    expect(safeSigning.abandonSafeMessageBoard).toHaveBeenCalledWith(webview);
  });

  test('webview destruction also withdraws the signing board', async () => {
    const { webview, safeSigning } = await loadProvider({ permission: safePermission() });

    webview.dispatch('destroyed', {});

    expect(safeSigning.abandonSafeMessageBoard).toHaveBeenCalledWith(webview);
  });

  test('a fresh request from the replacement document still gets its response', async () => {
    const { webview, sendRequest } = await loadProvider({
      permission: safePermission(),
    });

    webview.dispatch('did-navigate', { url: 'https://other.example' });

    sendRequest({ id: 1, method: 'eth_chainId', params: [] });
    await flushMicrotasks();

    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 1,
      result: '0x64',
      error: null,
    });
  });
});

describe('dapp-provider onchain application binding', () => {
  const APP_URL = 'web3://0x00000095643cffA7d9faE407A84Dfcb6406456C6.eip155-1/';

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('reports the chain encoded in the app origin', async () => {
    const { webview, sendRequest } = await loadProvider({ webviewUrl: APP_URL });

    sendRequest({ id: 10, method: 'eth_chainId', params: [] });
    sendRequest({ id: 11, method: 'net_version', params: [] });
    await flushMicrotasks();

    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 10,
      result: '0x1',
      error: null,
    });
    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 11,
      result: '1',
      error: null,
    });
  });

  test('routes read calls to the app origin chain, not the globally selected chain', async () => {
    const { webview, sendRequest, walletMocks } = await loadProvider({ webviewUrl: APP_URL });

    sendRequest({ id: 12, method: 'eth_call', params: [{ to: '0x1', data: '0x' }, 'latest'] });
    await flushMicrotasks();

    expect(walletMocks.requestChain).toHaveBeenCalledWith(
      1,
      'eth_call',
      [{ to: '0x1', data: '0x' }, 'latest'],
      { origin: APP_URL.toLowerCase() }
    );
    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 12,
      result: '0xfeed',
      error: null,
    });
  });

  test('pins the connect approval UI to the origin chain', async () => {
    const { sendRequest, walletUi } = await loadProvider({ webviewUrl: APP_URL });

    sendRequest({ id: 13, method: 'eth_requestAccounts', params: [] });
    await flushMicrotasks();

    expect(walletUi.setSelectedChainId).toHaveBeenCalledWith(1);
    expect(walletUi.showDappConnect).toHaveBeenCalled();
  });

  test('rejects switching an onchain app away from its origin chain', async () => {
    const { webview, sendRequest } = await loadProvider({ webviewUrl: APP_URL });

    sendRequest({
      id: 14,
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x64' }],
    });
    await flushMicrotasks();

    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 14,
      result: null,
      error: {
        code: 4200,
        message: 'This onchain application is pinned to chain 1.',
        data: undefined,
      },
    });
  });

  test('does not forward global wallet chain changes into a pinned app', async () => {
    const { mod, webview } = await loadProvider({ webviewUrl: APP_URL });

    mod.emitChainChanged(webview, '0x64');

    expect(webview.send).not.toHaveBeenCalledWith('dapp:provider-event', {
      event: 'chainChanged',
      data: '0x64',
    });
  });
});
