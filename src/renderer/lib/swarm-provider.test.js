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

// [processId, routingId] of the guest's main frame and of a sub-frame.
const MAIN_FRAME = [7, 4];
const SUB_FRAME = [8, 5];

function createWebview() {
  const listeners = {};
  const dispatch = (name, event) => {
    for (const listener of listeners[name] || []) listener(event);
  };
  return {
    listeners,
    dispatch,
    addEventListener: jest.fn((name, listener) => {
      (listeners[name] ||= []).push(listener);
    }),
    getWebContentsId: jest.fn(() => 41),
    send: jest.fn(),
  };
}

// Set up the provider on a fresh webview whose main frame has committed, as
// Electron reports it before any message from the new document.
function setUp(setupSwarmProvider) {
  const webview = createWebview();
  setupSwarmProvider(webview);
  commitFrame(webview, MAIN_FRAME);
  return webview;
}

function commitFrame(webview, [frameProcessId, frameRoutingId], isMainFrame = true) {
  webview.dispatch('did-frame-navigate', { isMainFrame, frameProcessId, frameRoutingId });
}

function sendRequest(webview, request, frameId = MAIN_FRAME) {
  webview.dispatch('ipc-message', { channel: 'swarm:provider-request', frameId, args: [request] });
}

const responsesSentTo = (webview) =>
  webview.send.mock.calls.filter(([channel]) => channel === 'swarm:provider-response');

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
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, { id: 1, method: 'swarm_requestAccess', params: {} });
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
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, { id: 2, method: 'swarm_readChunk', params: { reference: 'abc' } });
    await flush();

    expect(window.swarmManifest.check).not.toHaveBeenCalled();
    expect(webview.send).toHaveBeenCalledWith('swarm:provider-response', {
      id: 2,
      result: { data: 'public' },
      error: null,
    });
  });
});

// Audit O-6 (#433): a compromised iframe renderer can still call
// ipcRenderer.sendToHost; its requests must not use the top page's grants.
describe('renderer Swarm bridge only serves the guest main frame', () => {
  let setupSwarmProvider;

  beforeAll(async () => {
    ({ setupSwarmProvider } = require('./swarm-provider.js'));
    await flush();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window.swarmManifest.check.mockResolvedValue({ kind: 'fresh' });
    window.swarmProvider.execute.mockResolvedValue({ result: { reference: 'ref' } });
  });

  test('a publish request from a sub-frame is dropped before any grant is read', async () => {
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, { id: 10, method: 'swarm_publishData', params: { data: 'x' } }, SUB_FRAME);
    await flush();
    await flush();

    expect(window.swarmPermissions.getPermission).not.toHaveBeenCalled();
    expect(window.swarmManifest.check).not.toHaveBeenCalled();
    expect(window.swarmProvider.execute).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('a message without a frameId is dropped', async () => {
    const webview = setUp(setupSwarmProvider);

    webview.dispatch('ipc-message', {
      channel: 'swarm:provider-request',
      args: [{ id: 11, method: 'swarm_readChunk', params: { reference: 'abc' } }],
    });
    await flush();

    expect(window.swarmProvider.execute).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('nothing is served before the main frame has committed', async () => {
    const webview = createWebview();
    setupSwarmProvider(webview);

    sendRequest(webview, { id: 12, method: 'swarm_readChunk', params: { reference: 'abc' } });
    await flush();

    expect(window.swarmProvider.execute).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('follows the main frame across a commit; sub-frame commits are ignored', async () => {
    const webview = setUp(setupSwarmProvider);
    const NEXT_MAIN_FRAME = [9, 4];

    commitFrame(webview, SUB_FRAME, false);
    commitFrame(webview, NEXT_MAIN_FRAME);
    sendRequest(webview, { id: 13, method: 'swarm_readChunk', params: {} }, SUB_FRAME);
    sendRequest(webview, { id: 14, method: 'swarm_readChunk', params: {} }, MAIN_FRAME);
    sendRequest(webview, { id: 15, method: 'swarm_readChunk', params: {} }, NEXT_MAIN_FRAME);
    await flush();

    expect(window.swarmProvider.execute).toHaveBeenCalledTimes(1);
    expect(responsesSentTo(webview)).toEqual([
      ['swarm:provider-response', { id: 15, result: { reference: 'ref' }, error: null }],
    ]);
  });
});

describe('renderer Swarm bridge binds responses to the requesting document', () => {
  let setupSwarmProvider;

  beforeAll(async () => {
    ({ setupSwarmProvider } = require('./swarm-provider.js'));
    await flush();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window.swarmManifest.check.mockResolvedValue({ kind: 'fresh' });
  });

  const deferred = () => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  };

  test.each([
    ['did-navigate', { url: 'https://evil.example' }],
    ['destroyed', {}],
  ])('a result that settles after %s is never delivered', async (eventName, detail) => {
    const pending = deferred();
    window.swarmProvider.execute.mockReturnValue(pending.promise);
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, { id: 20, method: 'swarm_readChunk', params: { reference: 'abc' } });
    await flush();
    expect(window.swarmProvider.execute).toHaveBeenCalled();

    webview.dispatch(eventName, detail);
    pending.resolve({ result: { data: 'stale' } });
    await flush();

    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('an error that settles after navigation is never delivered', async () => {
    const pending = deferred();
    window.swarmProvider.execute.mockReturnValue(pending.promise);
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, { id: 21, method: 'swarm_readChunk', params: { reference: 'abc' } });
    await flush();

    webview.dispatch('did-navigate', { url: 'https://evil.example' });
    pending.resolve({ error: { code: -32603, message: 'boom' } });
    await flush();

    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('a request from the replacement document still gets its response', async () => {
    window.swarmProvider.execute.mockResolvedValue({ result: { data: 'fresh' } });
    const webview = setUp(setupSwarmProvider);

    webview.dispatch('did-navigate', { url: 'bzz://app.eth/next' });
    sendRequest(webview, { id: 22, method: 'swarm_readChunk', params: { reference: 'abc' } });
    await flush();

    expect(responsesSentTo(webview)).toEqual([
      ['swarm:provider-response', { id: 22, result: { data: 'fresh' }, error: null }],
    ]);
  });
});
