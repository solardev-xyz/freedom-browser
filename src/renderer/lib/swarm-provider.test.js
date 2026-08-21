const mockShowPermissionManifest = jest.fn();

jest.mock('./dapp-provider.js', () => ({
  getPermissionKey: jest.fn(() => 'app.eth'),
}));

jest.mock('./tabs.js', () => ({
  getDisplayUrlForWebview: jest.fn(() => 'bzz://app.eth/'),
  getNavigationKeyForWebview: jest.fn(() => 'tab-1:1'),
}));

jest.mock('./wallet-ui.js', () => ({
  showSwarmConnect: jest.fn(),
  updateSwarmConnectionBanner: jest.fn(),
  showSwarmPublishApproval: jest.fn(),
  showSwarmFeedApproval: jest.fn(),
  showSwarmMessagingApproval: jest.fn(),
  showVaultUnlock: jest.fn(),
  showPermissionManifest: (...args) => mockShowPermissionManifest(...args),
}));

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createWebview() {
  const listeners = {};
  return {
    listeners,
    addEventListener: jest.fn((name, listener) => { listeners[name] = listener; }),
    getWebContentsId: jest.fn(() => 41),
    send: jest.fn(),
  };
}

beforeAll(async () => {
  global.window = {
    electronAPI: { getSettings: jest.fn().mockResolvedValue({ enableIdentityWallet: true }) },
    addEventListener: jest.fn(),
    swarmManifest: {
      check: jest.fn(),
      decide: jest.fn(),
    },
    swarmPermissions: {
      getPermission: jest.fn().mockResolvedValue({ origin: 'app.eth', autoApprove: {} }),
      updateLastUsed: jest.fn().mockResolvedValue(true),
    },
    swarmProvider: { execute: jest.fn() },
  };
  await flush();
});

afterAll(() => {
  delete global.window;
});

describe('renderer Swarm manifest freshness gate', () => {
  let setupSwarmProvider;

  beforeAll(async () => {
    ({ setupSwarmProvider } = require('./swarm-provider.js'));
    await flush();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('awaits one manifest sheet and decision before requestAccess consumes grants', async () => {
    window.swarmManifest.check.mockResolvedValue({
      kind: 'consent',
      token: 'opaque-token',
      model: { origin: 'app.eth', changed: [{ key: 'publish' }], removed: [] },
    });
    mockShowPermissionManifest.mockResolvedValue('allow');
    window.swarmManifest.decide.mockResolvedValue({ allowed: true, mode: 'allow' });
    window.swarmProvider.execute.mockResolvedValue({ result: { connected: true } });
    const webview = createWebview();
    setupSwarmProvider(webview);

    webview.listeners['ipc-message']({
      channel: 'swarm:provider-request',
      args: [{ id: 1, method: 'swarm_requestAccess', params: {} }],
    });
    await flush();
    await flush();

    expect(window.swarmManifest.check).toHaveBeenCalledWith({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      navigationKey: 'tab-1:1',
      eager: true,
    });
    expect(window.swarmManifest.decide).toHaveBeenCalledWith('opaque-token', 'allow');
    expect(window.swarmProvider.execute).toHaveBeenCalledWith('swarm_requestAccess', {}, 'app.eth');
    expect(webview.send).toHaveBeenCalledWith('swarm:provider-response', {
      id: 1,
      result: { connected: true },
      error: null,
    });
  });

  test('public reads bypass manifest discovery', async () => {
    window.swarmProvider.execute.mockResolvedValue({ result: { data: 'public' } });
    const webview = createWebview();
    setupSwarmProvider(webview);

    webview.listeners['ipc-message']({
      channel: 'swarm:provider-request',
      args: [{ id: 2, method: 'swarm_readChunk', params: { reference: 'abc' } }],
    });
    await flush();

    expect(window.swarmManifest.check).not.toHaveBeenCalled();
    expect(webview.send).toHaveBeenCalledWith('swarm:provider-response', {
      id: 2,
      result: { data: 'public' },
      error: null,
    });
  });
});
