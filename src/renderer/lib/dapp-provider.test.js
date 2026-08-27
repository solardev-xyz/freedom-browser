'use strict';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('dApp provider Agent wallet handoff', () => {
  beforeEach(() => {
    jest.resetModules();
    global.document = {
      getElementById: jest.fn(() => ({ value: 'https://app.example/swap' })),
    };
    global.window = {
      addEventListener: jest.fn(),
      electronAPI: {
        getSettings: jest.fn(async () => ({ enableIdentityWallet: true })),
        handleAgentWalletRequest: jest.fn(),
      },
      dappPermissions: {
        getPermission: jest.fn(),
      },
    };
  });

  afterEach(() => {
    delete global.document;
    delete global.window;
  });

  test('uses an armed Agent-native result without opening the legacy wallet sidebar', async () => {
    const showDappConnect = jest.fn();
    jest.doMock('./wallet-ui.js', () => ({
      showDappConnect,
      getSelectedChainId: jest.fn(() => 100),
      setSelectedChainId: jest.fn(),
      updateConnectionBanner: jest.fn(),
      showDappTxApproval: jest.fn(),
      showDappSignApproval: jest.fn(),
      showVaultUnlock: jest.fn(),
      updateSwarmConnectionBanner: jest.fn(),
      updateX402ConnectionBanner: jest.fn(),
    }));
    jest.doMock('./wallet/dapp-tx.js', () => ({
      buildDappTxContext: jest.fn(),
      extractSelector: jest.fn(),
    }));
    window.electronAPI.handleAgentWalletRequest.mockResolvedValue({
      handled: true,
      result: ['0x1111111111111111111111111111111111111111'],
    });
    const listeners = new Map();
    const webview = {
      dataset: { tabId: '7' },
      addEventListener: jest.fn((type, listener) => listeners.set(type, listener)),
      send: jest.fn(),
    };
    const { setupWebviewProvider } = await import('./dapp-provider.js');
    await flush();
    setupWebviewProvider(webview);

    listeners.get('ipc-message')({
      channel: 'dapp:provider-request',
      args: [{ id: 1, method: 'eth_requestAccounts', params: [] }],
    });
    await flush();
    await flush();

    expect(window.electronAPI.handleAgentWalletRequest).toHaveBeenCalledWith(7, {
      method: 'eth_requestAccounts',
      params: [],
      displayUrl: 'https://app.example/swap',
      permissionKey: 'https://app.example',
      chainId: 100,
    });
    expect(showDappConnect).not.toHaveBeenCalled();
    expect(window.dappPermissions.getPermission).not.toHaveBeenCalled();
    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 1,
      result: ['0x1111111111111111111111111111111111111111'],
      error: null,
    });
  });

  test('preserves the existing human wallet flow when no Agent action is armed', async () => {
    const showDappConnect = jest.fn((_url, _key, resolve) => resolve(['0xhuman']));
    jest.doMock('./wallet-ui.js', () => ({
      showDappConnect,
      getSelectedChainId: jest.fn(() => 100),
      setSelectedChainId: jest.fn(),
      updateConnectionBanner: jest.fn(),
      showDappTxApproval: jest.fn(),
      showDappSignApproval: jest.fn(),
      showVaultUnlock: jest.fn(),
      updateSwarmConnectionBanner: jest.fn(),
      updateX402ConnectionBanner: jest.fn(),
    }));
    jest.doMock('./wallet/dapp-tx.js', () => ({
      buildDappTxContext: jest.fn(),
      extractSelector: jest.fn(),
    }));
    window.electronAPI.handleAgentWalletRequest.mockResolvedValue({ handled: false });
    window.dappPermissions.getPermission.mockResolvedValue(null);
    const listeners = new Map();
    const webview = {
      dataset: { tabId: '7' },
      addEventListener: jest.fn((type, listener) => listeners.set(type, listener)),
      send: jest.fn(),
    };
    const { setupWebviewProvider } = await import('./dapp-provider.js');
    await flush();
    setupWebviewProvider(webview);

    listeners.get('ipc-message')({
      channel: 'dapp:provider-request',
      args: [{ id: 2, method: 'eth_requestAccounts', params: [] }],
    });
    await flush();
    await flush();

    expect(showDappConnect).toHaveBeenCalledTimes(1);
    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 2,
      result: ['0xhuman'],
      error: null,
    });
  });
});
