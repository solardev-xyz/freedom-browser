const mockShowPermissionManifest = jest.fn();
const mockRouteToPublishSetup = jest.fn();

jest.mock('./dapp-provider.js', () => ({
  getPermissionKey: jest.fn(() => 'app.eth'),
}));

const mockIsTabAgentOwned = jest.fn(() => false);
const mockGetTabs = jest.fn(() => []);
// The provider subscribes once, when first loaded; keep what it registered.
let registeredDisconnectListener = null;
jest.mock('./tabs.js', () => ({
  getDisplayUrlForWebview: jest.fn(() => 'bzz://app.eth/'),
  getNavigationKeyForWebview: jest.fn(() => 'tab-1:1'),
  getTabs: (...args) => mockGetTabs(...args),
  isTabAgentOwned: (...args) => mockIsTabAgentOwned(...args),
}));

jest.mock('./wallet-ui.js', () => ({
  showSwarmConnect: jest.fn(),
  updateSwarmConnectionBanner: jest.fn(),
  showSwarmPublishApproval: jest.fn(),
  showSwarmFeedApproval: jest.fn(),
  showSwarmMessagingApproval: jest.fn(),
  showVaultUnlock: jest.fn(),
  showPermissionManifest: (...args) => mockShowPermissionManifest(...args),
  routeToPublishSetup: (...args) => mockRouteToPublishSetup(...args),
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
      onOriginDisconnected: jest.fn((listener) => {
        registeredDisconnectListener = listener;
      }),
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

  test.each(['swarm_readChunk', 'swarm_readData'])('public read %s bypasses manifest discovery', async (method) => {
    window.swarmProvider.execute.mockResolvedValue({ result: { data: 'public' } });
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, { id: 2, method, params: { reference: 'abc' } });
    await flush();

    expect(window.swarmManifest.check).not.toHaveBeenCalled();
    expect(window.swarmProvider.execute).toHaveBeenCalledWith(method, { reference: 'abc' }, expect.any(String));
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

describe('routing setup failures into the publish setup', () => {
  let setupSwarmProvider;

  beforeAll(async () => {
    ({ setupSwarmProvider } = require('./swarm-provider.js'));
    await flush();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window.swarmManifest.check.mockResolvedValue({ kind: 'fresh' });
    window.swarmPermissions.getPermission.mockResolvedValue({
      origin: 'app.eth',
      autoApprove: { publish: true },
    });
  });

  const nodeUnavailable = (reason) => ({
    error: { code: 4900, message: `Node not available: ${reason}`, data: { reason } },
  });

  test('a publish refused for missing storage opens the setup, naming the site', async () => {
    window.swarmProvider.execute.mockResolvedValue(nodeUnavailable('no-usable-stamps'));
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, {
      id: 1,
      method: 'swarm_publishData',
      params: { data: 'hi', contentType: 'text/plain' },
    });
    await flush();
    await flush();

    expect(mockRouteToPublishSetup).toHaveBeenCalledWith('app.eth', 'no-usable-stamps');
    // The page still gets its error: routing is for the user, not the app.
    const [, response] = responsesSentTo(webview).at(-1);
    expect(response.error).toMatchObject({ code: 4900, data: { reason: 'no-usable-stamps' } });
  });

  test('a capability probe or a read never pulls the sidebar open', async () => {
    window.swarmProvider.execute.mockResolvedValue(nodeUnavailable('node-stopped'));
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, { id: 1, method: 'swarm_getCapabilities', params: {} });
    sendRequest(webview, { id: 2, method: 'swarm_readChunk', params: { reference: 'ab' } });
    await flush();
    await flush();

    expect(responsesSentTo(webview)).toHaveLength(2);
    expect(mockRouteToPublishSetup).not.toHaveBeenCalled();
  });

  test('other failures of a write do not route either', async () => {
    window.swarmProvider.execute.mockResolvedValue({
      error: { code: -32602, message: 'Invalid parameters', data: { reason: 'payload_too_large' } },
    });
    const webview = setUp(setupSwarmProvider);

    sendRequest(webview, {
      id: 1,
      method: 'swarm_publishData',
      params: { data: 'hi', contentType: 'text/plain' },
    });
    await flush();
    await flush();

    expect(mockRouteToPublishSetup).not.toHaveBeenCalled();
  });
});

describe('Agent custody and site auto-approve', () => {
  let setupSwarmProvider;
  let showSwarmPublishApproval;

  beforeAll(async () => {
    ({ setupSwarmProvider } = require('./swarm-provider.js'));
    ({ showSwarmPublishApproval } = require('./wallet-ui.js'));
    await flush();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window.swarmManifest.check.mockResolvedValue({ kind: 'fresh' });
    window.swarmPermissions.getPermission.mockResolvedValue({
      origin: 'app.eth',
      autoApprove: { publish: true },
    });
    window.swarmProvider.execute.mockResolvedValue({ result: { reference: 'abc' } });
    showSwarmPublishApproval.mockImplementation((_key, _params, resolve) => resolve());
  });

  const publish = async (agentOwned) => {
    mockIsTabAgentOwned.mockImplementation((tabId) => agentOwned && tabId === 3);
    const webview = setUp(setupSwarmProvider);
    webview.dataset = { tabId: '3' };
    sendRequest(webview, { id: 1, method: 'swarm_publishData', params: { data: 'hi' } });
    await flush();
    await flush();
    return webview;
  };

  test('an Agent-held tab is prompted and main is told the user approved', async () => {
    await publish(true);
    expect(showSwarmPublishApproval).toHaveBeenCalledTimes(1);
    expect(window.swarmProvider.execute).toHaveBeenCalledWith(
      'swarm_publishData', { data: 'hi' }, 'app.eth', { webContentsId: 41, approval: 'user' }
    );
  });

  test("a user tab keeps the site's rule and main is told it answered", async () => {
    await publish(false);
    expect(showSwarmPublishApproval).not.toHaveBeenCalled();
    expect(window.swarmProvider.execute).toHaveBeenCalledWith(
      'swarm_publishData', { data: 'hi' }, 'app.eth', { webContentsId: 41, approval: 'auto' }
    );
  });
});

describe('feed writes with a locked vault', () => {
  let setupSwarmProvider;
  let showSwarmFeedApproval;
  let showVaultUnlock;

  beforeAll(async () => {
    ({ setupSwarmProvider } = require('./swarm-provider.js'));
    ({ showSwarmFeedApproval, showVaultUnlock } = require('./wallet-ui.js'));
    await flush();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window.swarmManifest.check.mockResolvedValue({ kind: 'fresh' });
    window.swarmPermissions.getPermission.mockResolvedValue({ origin: 'app.eth', autoApprove: {} });
    window.swarmPermissions.getAutoApprove = jest.fn().mockResolvedValue(false);
    window.swarmFeedStore = { hasFeedGrant: jest.fn().mockResolvedValue(true) };
    window.identity = { getStatus: jest.fn().mockResolvedValue({ isUnlocked: false }) };
    window.swarmProvider.execute.mockResolvedValue({ result: { ok: true } });
    showSwarmFeedApproval.mockImplementation((_key, _params, resolve) => resolve());
    showVaultUnlock.mockResolvedValue();
  });

  afterAll(() => {
    delete window.swarmFeedStore;
    delete window.identity;
  });

  const writeEntry = async ({ agentOwned = false } = {}) => {
    mockIsTabAgentOwned.mockImplementation((tabId) => agentOwned && tabId === 3);
    const webview = setUp(setupSwarmProvider);
    webview.dataset = { tabId: '3' };
    sendRequest(webview, { id: 1, method: 'swarm_writeFeedEntry', params: { name: 'blog' } });
    for (let i = 0; i < 4; i += 1) await flush();
    return webview;
  };

  test('without an auto-approve rule, the unlock does not replace the feed approval', async () => {
    await writeEntry();
    expect(showSwarmFeedApproval).toHaveBeenCalledTimes(1);
    expect(showVaultUnlock).not.toHaveBeenCalled();
    expect(window.swarmProvider.execute).toHaveBeenCalledWith(
      'swarm_writeFeedEntry', { name: 'blog' }, 'app.eth', { webContentsId: 41, approval: 'user' }
    );
  });

  test('an Agent-held tab is prompted per operation even with the site rule on', async () => {
    window.swarmPermissions.getAutoApprove.mockResolvedValue(true);
    await writeEntry({ agentOwned: true });
    expect(showSwarmFeedApproval).toHaveBeenCalledTimes(1);
    expect(showVaultUnlock).not.toHaveBeenCalled();
    expect(window.swarmProvider.execute).toHaveBeenCalledWith(
      'swarm_writeFeedEntry', { name: 'blog' }, 'app.eth', { webContentsId: 41, approval: 'user' }
    );
  });

  test('a user tab with the site rule only unlocks, and main is told the rule answered', async () => {
    window.swarmPermissions.getAutoApprove.mockResolvedValue(true);
    await writeEntry();
    expect(showSwarmFeedApproval).not.toHaveBeenCalled();
    expect(showVaultUnlock).toHaveBeenCalledWith('app.eth');
    expect(window.swarmProvider.execute).toHaveBeenCalledWith(
      'swarm_writeFeedEntry', { name: 'blog' }, 'app.eth', { webContentsId: 41, approval: 'auto' }
    );
  });
});

describe('connect and disconnect events (#1158)', () => {
  let mod;
  let onOriginDisconnected;
  const tabs = require('./tabs.js');
  const { getPermissionKey } = require('./dapp-provider.js');
  const eventsSentTo = (webview) =>
    webview.send.mock.calls.filter(([channel]) => channel === 'swarm:provider-event').map(([, payload]) => payload);

  beforeAll(async () => {
    mod = require('./swarm-provider.js');
    await flush();
    onOriginDisconnected = registeredDisconnectListener;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window.swarmManifest.check.mockResolvedValue({
      kind: 'consent',
      token: 'opaque-token',
      model: { origin: 'app.eth', changed: [{ key: 'publish' }], removed: [] },
    });
    mockShowPermissionManifest.mockResolvedValue('allow');
    window.swarmManifest.decide.mockResolvedValue({ allowed: true, mode: 'allow' });
    window.swarmProvider.execute.mockResolvedValue({ result: { connected: true, origin: 'app.eth' } });
    window.swarmPermissions.getPermission.mockResolvedValue({ origin: 'app.eth', autoApprove: {} });
  });

  afterEach(() => {
    tabs.getNavigationKeyForWebview.mockImplementation(() => 'tab-1:1');
    tabs.getDisplayUrlForWebview.mockImplementation(() => 'bzz://app.eth/');
    getPermissionKey.mockImplementation(() => 'app.eth');
  });

  async function requestAccessThroughSheet() {
    const webview = setUp(mod.setupSwarmProvider);
    sendRequest(webview, { id: 1, method: 'swarm_requestAccess', params: {} });
    for (let i = 0; i < 4; i += 1) await flush();
    return webview;
  }

  test('a manifest sheet that connects the site sends connect once', async () => {
    window.swarmPermissions.getPermission.mockResolvedValueOnce(null);
    const webview = await requestAccessThroughSheet();
    expect(eventsSentTo(webview)).toEqual([{ event: 'connect', data: { origin: 'app.eth' } }]);
    expect(responsesSentTo(webview)).toHaveLength(1);
  });

  test("'ask each time' connects the site too", async () => {
    mockShowPermissionManifest.mockResolvedValue('individual');
    window.swarmManifest.decide.mockResolvedValue({ allowed: true, mode: 'individual' });
    window.swarmPermissions.getPermission.mockResolvedValueOnce(null);
    const webview = await requestAccessThroughSheet();
    expect(eventsSentTo(webview)).toEqual([{ event: 'connect', data: { origin: 'app.eth' } }]);
  });

  test('no connect when the site was already connected', async () => {
    const webview = await requestAccessThroughSheet();
    expect(eventsSentTo(webview)).toEqual([]);
  });

  test('no connect when the sheet is declined', async () => {
    mockShowPermissionManifest.mockResolvedValue('deny');
    window.swarmManifest.decide.mockResolvedValue({ allowed: false });
    window.swarmPermissions.getPermission.mockResolvedValueOnce(null).mockResolvedValue(null);
    const webview = await requestAccessThroughSheet();
    expect(eventsSentTo(webview)).toEqual([]);
  });

  test('no connect to a document the tab navigated to while the sheet was open', async () => {
    window.swarmPermissions.getPermission.mockResolvedValueOnce(null);
    mockShowPermissionManifest.mockImplementation(async () => {
      tabs.getNavigationKeyForWebview.mockImplementation(() => 'tab-1:2');
      return 'allow';
    });
    const webview = await requestAccessThroughSheet();
    expect(eventsSentTo(webview)).toEqual([]);
  });

  test('no connect when the tab navigates while the final connection check is pending', async () => {
    let finishCheck;
    window.swarmPermissions.getPermission
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => new Promise((resolve) => { finishCheck = resolve; }));
    const webview = setUp(mod.setupSwarmProvider);
    sendRequest(webview, { id: 1, method: 'swarm_requestAccess', params: {} });
    for (let i = 0; i < 4; i += 1) await flush();

    tabs.getNavigationKeyForWebview.mockImplementation(() => 'tab-1:2');
    finishCheck({ origin: 'app.eth', autoApprove: {} });
    for (let i = 0; i < 4; i += 1) await flush();
    expect(eventsSentTo(webview)).toEqual([]);
  });

  test("an operation's check and requestAccess sharing one sheet announce connect once", async () => {
    let connected = false;
    window.swarmPermissions.getPermission.mockImplementation(async () => (
      connected ? { origin: 'app.eth', autoApprove: { publish: true } } : null
    ));
    let answerSheet;
    const sheet = new Promise((resolve) => { answerSheet = resolve; });
    mockShowPermissionManifest.mockImplementation(() => sheet);
    window.swarmManifest.decide.mockImplementation(async () => {
      connected = true;
      return { allowed: true, mode: 'allow' };
    });
    const webview = setUp(mod.setupSwarmProvider);

    sendRequest(webview, { id: 1, method: 'swarm_publishData', params: { data: 'x', contentType: 'text/plain' } });
    await flush();
    sendRequest(webview, { id: 2, method: 'swarm_requestAccess', params: {} });
    for (let i = 0; i < 4; i += 1) await flush();
    expect(window.swarmManifest.check).toHaveBeenCalledTimes(2);

    answerSheet('allow');
    for (let i = 0; i < 6; i += 1) await flush();
    expect(eventsSentTo(webview)).toEqual([{ event: 'connect', data: { origin: 'app.eth' } }]);
  });

  test('a site disconnected and connected again in the same page hears connect again', async () => {
    let connected = false;
    window.swarmPermissions.getPermission.mockImplementation(async () => (
      connected ? { origin: 'app.eth', autoApprove: { publish: true } } : null
    ));
    window.swarmManifest.decide.mockImplementation(async () => {
      connected = true;
      return { allowed: true, mode: 'allow' };
    });
    const webview = setUp(mod.setupSwarmProvider);

    // An operation's check connects the site through the sheet.
    sendRequest(webview, { id: 1, method: 'swarm_publishData', params: { data: 'x', contentType: 'text/plain' } });
    for (let i = 0; i < 6; i += 1) await flush();

    // The user disconnects it; main tells the window.
    connected = false;
    mockGetTabs.mockReturnValue([{ webview }]);
    onOriginDisconnected('app.eth');

    // requestAccess in the same document opens the sheet again and reconnects.
    sendRequest(webview, { id: 2, method: 'swarm_requestAccess', params: {} });
    for (let i = 0; i < 6; i += 1) await flush();
    expect(eventsSentTo(webview)).toEqual([
      { event: 'connect', data: { origin: 'app.eth' } },
      { event: 'disconnect', data: { origin: 'app.eth' } },
      { event: 'connect', data: { origin: 'app.eth' } },
    ]);
  });

  describe('the plain connect prompt', () => {
    const { showSwarmConnect } = require('./wallet-ui.js');
    let approvals;

    beforeEach(() => {
      window.swarmManifest.check.mockResolvedValue({ kind: 'fresh' });
      window.swarmPermissions.getPermission.mockResolvedValue(null);
      approvals = [];
      showSwarmConnect.mockImplementation((displayUrl, key, resolve) => {
        approvals.push(() => resolve({ connected: true, origin: key }));
      });
    });

    afterEach(() => {
      showSwarmConnect.mockReset();
    });

    test('approving it announces connect once', async () => {
      const webview = setUp(mod.setupSwarmProvider);
      sendRequest(webview, { id: 1, method: 'swarm_requestAccess', params: {} });
      for (let i = 0; i < 4; i += 1) await flush();
      approvals[0]();
      for (let i = 0; i < 4; i += 1) await flush();
      expect(eventsSentTo(webview)).toEqual([{ event: 'connect', data: { origin: 'app.eth' } }]);
    });

    test('not to a document the tab navigated to before the approval landed', async () => {
      const webview = setUp(mod.setupSwarmProvider);
      sendRequest(webview, { id: 1, method: 'swarm_requestAccess', params: {} });
      for (let i = 0; i < 4; i += 1) await flush();
      tabs.getNavigationKeyForWebview.mockImplementation(() => 'tab-1:2');
      approvals[0]();
      for (let i = 0; i < 4; i += 1) await flush();
      expect(eventsSentTo(webview)).toEqual([]);
    });

    test('two queued prompts that are both approved announce connect once', async () => {
      const webview = setUp(mod.setupSwarmProvider);
      sendRequest(webview, { id: 1, method: 'swarm_requestAccess', params: {} });
      sendRequest(webview, { id: 2, method: 'swarm_requestAccess', params: {} });
      for (let i = 0; i < 4; i += 1) await flush();
      expect(approvals).toHaveLength(2);
      approvals[0]();
      approvals[1]();
      for (let i = 0; i < 4; i += 1) await flush();
      expect(eventsSentTo(webview)).toEqual([{ event: 'connect', data: { origin: 'app.eth' } }]);
      expect(responsesSentTo(webview)).toHaveLength(2);
    });
  });

  test('a revoked connection reaches every tab of the site in this window, and only those', () => {
    expect(onOriginDisconnected).toEqual(expect.any(Function));
    const front = createWebview();
    const background = createWebview();
    const otherSite = createWebview();
    const urls = new Map([[front, 'bzz://app.eth/'], [background, 'bzz://app.eth/blog'], [otherSite, 'bzz://other.eth/']]);
    tabs.getDisplayUrlForWebview.mockImplementation((webview) => urls.get(webview));
    getPermissionKey.mockImplementation((url) => (url?.includes('other.eth') ? 'other.eth' : 'app.eth'));
    mockGetTabs.mockReturnValue([{ webview: front }, { webview: background }, { webview: otherSite }, { webview: null }]);

    onOriginDisconnected('app.eth');

    const disconnect = [{ event: 'disconnect', data: { origin: 'app.eth' } }];
    expect(eventsSentTo(front)).toEqual(disconnect);
    expect(eventsSentTo(background)).toEqual(disconnect);
    expect(eventsSentTo(otherSite)).toEqual([]);
    expect(require('./wallet-ui.js').updateSwarmConnectionBanner).toHaveBeenCalledWith('app.eth');
  });
});

describe('requests refused before any prompt (#1157)', () => {
  let setupSwarmProvider;

  beforeAll(async () => {
    ({ setupSwarmProvider } = require('./swarm-provider.js'));
    await flush();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a PSS subscription asking for history is refused without a sheet, prompt or main call', async () => {
    const { showSwarmMessagingApproval } = require('./wallet-ui.js');
    const webview = setUp(setupSwarmProvider);
    sendRequest(webview, { id: 1, method: 'swarm_subscribe', params: { kind: 'pss', topic: 'dm:alice', history: true } });
    await flush();
    await flush();

    expect(window.swarmManifest.check).not.toHaveBeenCalled();
    expect(showSwarmMessagingApproval).not.toHaveBeenCalled();
    expect(window.swarmProvider.execute).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toEqual([[
      'swarm:provider-response',
      {
        id: 1,
        result: null,
        error: expect.objectContaining({ code: -32602, data: { reason: 'unsupported_option', option: 'history' } }),
      },
    ]]);
  });
});
