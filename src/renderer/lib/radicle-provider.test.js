/**
 * Tests for the renderer-side Radicle provider handler.
 *
 * Focus: binding consent, grants, execution, and response delivery to the
 * document that made the request. A webview that commits a navigation (or is
 * destroyed) while a request is in flight must never have an approval applied
 * on behalf of the replacement document, and must never receive the stale
 * response (request ids can be reused across navigations).
 */

const { createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;

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

// [processId, routingId] of the guest's main frame and of a sub-frame.
const MAIN_FRAME = [7, 4];
const SUB_FRAME = [8, 5];

const loadProvider = async (options = {}) => {
  jest.resetModules();

  const state = {
    displayUrl: options.displayUrl ?? 'https://app.example',
    permission: options.permission ?? null,
    autoApprove: options.autoApprove ?? false,
    writeRule: options.writeRule ?? false,
    signingGrant: options.signingGrant ?? false,
  };

  const consentMocks = {
    showRadicleConnect: jest.fn(() => Promise.resolve()),
    showRadicleSeedApproval: jest.fn(() => Promise.resolve()),
    showRadicleUnseedApproval: jest.fn(() => Promise.resolve()),
    showRadicleSigningApproval: jest.fn(() => Promise.resolve()),
    showRadicleSignedWriteApproval: jest.fn(() => Promise.resolve()),
    dismissRadicleConsent: jest.fn(),
  };

  const permissions = {
    getPermission: jest.fn(async () => state.permission),
    grantPermission: jest.fn(async () => {}),
    getAutoApprove: jest.fn(async (_origin, type) =>
      type === 'signing' ? state.writeRule : state.autoApprove
    ),
    setAutoApprove: jest.fn(async (_origin, type, enabled) => {
      if (type === 'signing') state.writeRule = enabled;
      return true;
    }),
    hasSigningGrant: jest.fn(async () => state.signingGrant),
    grantSigning: jest.fn(async () => {}),
  };

  const execute = jest.fn(async () => ({ result: 'ok' }));
  let providerEventHandler = null;

  global.window = {
    electronAPI: {
    },
    addEventListener: jest.fn(),
    radiclePermissions: permissions,
    radicleProvider: {
      execute,
      onEvent: jest.fn((handler) => {
        providerEventHandler = handler;
        return jest.fn();
      }),
    },
  };

  jest.doMock('./dapp-provider.js', () => ({
    getPermissionKey: jest.fn((url) => url),
  }));
  jest.doMock('./tabs.js', () => ({
    getDisplayUrlForWebview: jest.fn(() => state.displayUrl),
    isTabAgentOwned: jest.fn((tabId) => options.agentOwnedTabId === tabId),
  }));
  jest.doMock('./radicle-consent.js', () => consentMocks);

  const mod = await import('./radicle-provider.js');
  // Let the async settings read land so the feature gate opens.
  await flushMicrotasks();

  const webview = createElement('webview');
  webview.send = jest.fn();
  webview.dataset = { tabId: '3' };
  webview.getWebContentsId = jest.fn(() => 41);
  mod.setupRadicleProvider(webview);
  // The guest's main frame commits, as Electron reports it before any
  // message from the new document (see guest-main-frame.js).
  const commitMainFrame = ([frameProcessId, frameRoutingId], isMainFrame = true) => {
    webview.dispatch('did-frame-navigate', { isMainFrame, frameProcessId, frameRoutingId });
  };
  if (options.mainFrameCommitted !== false) commitMainFrame(MAIN_FRAME);

  const sendRequest = (request, frameId = MAIN_FRAME) => {
    webview.dispatch('ipc-message', {
      channel: 'radicle:provider-request',
      frameId,
      args: [request],
    });
  };

  return {
    mod,
    webview,
    sendRequest,
    commitMainFrame,
    state,
    consentMocks,
    permissions,
    execute,
    emitProviderEvent: (event) => providerEventHandler(event),
  };
};

const responsesSentTo = (webview) =>
  webview.send.mock.calls.filter(([channel]) => channel === 'radicle:provider-response');

describe('radicle-provider', () => {
  afterEach(() => {
    global.window = originalWindow;
    jest.restoreAllMocks();
  });

  describe('happy paths (same document throughout)', () => {
    test('routes pushed seed status only to the matching current origin', async () => {
      const { webview, state, emitProviderEvent } = await loadProvider();
      const status = { rid: 'rad:z371PVmDHdjJucejRoRYJcDEvD5pp', state: 'fetching' };

      emitProviderEvent({
        event: 'seedStatus',
        origin: 'https://app.example',
        data: status,
      });
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-event', {
        event: 'seedStatus',
        data: status,
      });

      webview.send.mockClear();
      state.displayUrl = 'https://other.example';
      emitProviderEvent({
        event: 'seedStatus',
        origin: 'https://app.example',
        data: status,
      });
      expect(webview.send).not.toHaveBeenCalled();
    });

    test('signing request prompts, grants, executes, and responds', async () => {
      const { webview, sendRequest, consentMocks, permissions, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });

      sendRequest({ id: 1, method: 'radicle_createIssue', params: { title: 'hi' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSigningApproval).toHaveBeenCalledWith(
        'https://app.example',
        webview
      );
      expect(permissions.grantSigning).toHaveBeenCalledWith('https://app.example');
      // The grant lets the site ask; the write itself still prompts (R-6).
      expect(consentMocks.showRadicleSignedWriteApproval).toHaveBeenCalledWith(
        'https://app.example',
        'radicle_createIssue',
        { title: 'hi' },
        webview,
        { agentHeld: false, alwaysAllow: false }
      );
      expect(execute).toHaveBeenCalledWith(
        'radicle_createIssue',
        { title: 'hi' },
        'https://app.example',
        { webContentsId: 41, approval: 'user' }
      );
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-response', {
        id: 1,
        result: 'ok',
        error: null,
      });
    });

    test('the signing grant alone does not answer a write: each write prompts', async () => {
      const { webview, sendRequest, consentMocks, permissions, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
      });

      sendRequest({ id: 11, method: 'radicle_commentIssue', params: { body: 'Same here' } });
      await flushMicrotasks();
      sendRequest({ id: 12, method: 'radicle_commentIssue', params: { body: 'Again' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSigningApproval).not.toHaveBeenCalled();
      expect(consentMocks.showRadicleSignedWriteApproval).toHaveBeenCalledTimes(2);
      expect(consentMocks.showRadicleSignedWriteApproval).toHaveBeenLastCalledWith(
        'https://app.example',
        'radicle_commentIssue',
        { body: 'Again' },
        webview,
        { agentHeld: false, alwaysAllow: false }
      );
      expect(execute.mock.calls.map((call) => call[3])).toEqual([
        { webContentsId: 41, approval: 'user' },
        { webContentsId: 41, approval: 'user' },
      ]);
      // Approving without the checkbox leaves the rule off.
      expect(permissions.setAutoApprove).not.toHaveBeenCalled();
    });

    test('the "always allow writes" rule answers a write without a prompt', async () => {
      const { sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
        writeRule: true,
      });

      sendRequest({ id: 15, method: 'radicle_commentIssue', params: { body: 'Same here' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSignedWriteApproval).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'radicle_commentIssue',
        { body: 'Same here' },
        'https://app.example',
        { webContentsId: 41, approval: 'auto' }
      );
    });

    test('checking "always allow" in a write prompt turns the rule on', async () => {
      const { sendRequest, consentMocks, permissions, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
      });
      consentMocks.showRadicleSignedWriteApproval.mockResolvedValueOnce({ alwaysAllow: true });

      sendRequest({ id: 16, method: 'radicle_createIssue', params: { title: 'Bug' } });
      await flushMicrotasks();
      expect(permissions.setAutoApprove).toHaveBeenCalledWith(
        'https://app.example',
        'signing',
        true
      );
      expect(execute).toHaveBeenLastCalledWith(
        'radicle_createIssue',
        { title: 'Bug' },
        'https://app.example',
        { webContentsId: 41, approval: 'user' }
      );

      sendRequest({ id: 17, method: 'radicle_createIssue', params: { title: 'Next' } });
      await flushMicrotasks();
      expect(consentMocks.showRadicleSignedWriteApproval).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenLastCalledWith(
        'radicle_createIssue',
        { title: 'Next' },
        'https://app.example',
        { webContentsId: 41, approval: 'auto' }
      );
    });

    test('past main\'s limit a rule-answered write falls back to the prompt', async () => {
      const { webview, sendRequest, consentMocks, permissions, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
        writeRule: true,
      });
      execute.mockResolvedValueOnce({
        error: { code: 4100, message: 'limit', data: { reason: 'auto_write_limit' } },
      });
      // The user unchecks the box in the fallback prompt: the rule goes off.
      consentMocks.showRadicleSignedWriteApproval.mockResolvedValueOnce({ alwaysAllow: false });

      sendRequest({ id: 18, method: 'radicle_commentIssue', params: { body: 'Hi' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSignedWriteApproval).toHaveBeenCalledWith(
        'https://app.example',
        'radicle_commentIssue',
        { body: 'Hi' },
        webview,
        { agentHeld: false, alwaysAllow: true }
      );
      expect(execute.mock.calls.map((call) => call[3])).toEqual([
        { webContentsId: 41, approval: 'auto' },
        { webContentsId: 41, approval: 'user' },
      ]);
      expect(permissions.setAutoApprove).toHaveBeenCalledWith(
        'https://app.example',
        'signing',
        false
      );
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-response', {
        id: 18,
        result: 'ok',
        error: null,
      });
    });

    test('any other refusal of a rule-answered write is returned, not prompted', async () => {
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
        writeRule: true,
      });
      execute.mockResolvedValueOnce({
        error: { code: 4100, message: 'custody', data: { reason: 'agent_custody' } },
      });

      sendRequest({ id: 19, method: 'radicle_commentIssue', params: { body: 'Hi' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSignedWriteApproval).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-response', {
        id: 19,
        result: null,
        error: { code: 4100, message: 'custody', data: { reason: 'agent_custody' } },
      });
    });

    test.each([
      ['radicle_createIssue', { rid: 'rad:zExample', title: 'Bug', description: 'Steps' }],
      ['radicle_commentIssue', { rid: 'rad:zExample', issueId: 'a1b2c3', body: 'Same here' }],
      ['radicle_editIssueState', { rid: 'rad:zExample', issueId: 'a1b2c3', state: 'closed' }],
      ['radicle_commentPatch', { rid: 'rad:zExample', patchId: 'd4e5f6', body: 'LGTM' }],
    ])('%s from a tab in Agent custody needs a per-write prompt despite the grant', async (method, params) => {
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
        agentOwnedTabId: 3,
      });

      sendRequest({ id: 12, method, params });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSigningApproval).not.toHaveBeenCalled();
      expect(consentMocks.showRadicleSignedWriteApproval).toHaveBeenCalledWith(
        'https://app.example',
        method,
        params,
        webview,
        { agentHeld: true, alwaysAllow: false }
      );
      expect(execute).toHaveBeenCalledWith(method, params, 'https://app.example', {
        webContentsId: 41,
        approval: 'user',
      });
    });

    test('a rejected per-write prompt on an Agent-held tab signs nothing', async () => {
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
        agentOwnedTabId: 3,
      });
      consentMocks.showRadicleSignedWriteApproval.mockRejectedValue({
        code: 4001,
        message: 'User rejected the request',
      });

      sendRequest({ id: 13, method: 'radicle_createIssue', params: { title: 'Bug' } });
      await flushMicrotasks();

      expect(execute).not.toHaveBeenCalled();
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-response', {
        id: 13,
        result: null,
        error: { code: 4001, message: 'User rejected the request', data: undefined },
      });
    });

    test('the "always allow writes" rule does not answer for a tab in Agent custody', async () => {
      const { webview, sendRequest, consentMocks, permissions, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
        writeRule: true,
        agentOwnedTabId: 3,
      });

      sendRequest({ id: 20, method: 'radicle_createIssue', params: { title: 'Bug' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSignedWriteApproval).toHaveBeenCalledWith(
        'https://app.example',
        'radicle_createIssue',
        { title: 'Bug' },
        webview,
        { agentHeld: true, alwaysAllow: false }
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][3]).toEqual({ webContentsId: 41, approval: 'user' });
      expect(permissions.setAutoApprove).not.toHaveBeenCalled();
    });

    test('disclosing the identity on an Agent-held tab stays on the grant', async () => {
      const { sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
        agentOwnedTabId: 3,
      });

      sendRequest({ id: 14, method: 'radicle_getIdentity', params: {} });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSignedWriteApproval).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith('radicle_getIdentity', {}, 'https://app.example');
    });

    test('requestAccess without prior permission prompts and emits connect', async () => {
      const { webview, sendRequest, consentMocks, permissions } = await loadProvider();

      sendRequest({ id: 2, method: 'radicle_requestAccess', params: {} });
      await flushMicrotasks();

      expect(consentMocks.showRadicleConnect).toHaveBeenCalledWith('https://app.example', webview);
      expect(permissions.grantPermission).toHaveBeenCalledWith('https://app.example');
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-event', {
        event: 'connect',
        data: { origin: 'https://app.example' },
      });
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-response', {
        id: 2,
        result: 'ok',
        error: null,
      });
    });

    test('a navigation before the request does not block the new document', async () => {
      const { webview, sendRequest, state, execute } = await loadProvider({
        permission: { origin: 'https://other.example' },
      });

      // Old document navigates away; the new document then makes a request.
      webview.dispatch('did-navigate', { url: 'https://other.example' });
      state.displayUrl = 'https://other.example';

      sendRequest({ id: 3, method: 'radicle_getNodeStatus', params: {} });
      await flushMicrotasks();

      expect(execute).toHaveBeenCalledWith('radicle_getNodeStatus', {}, 'https://other.example');
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-response', {
        id: 3,
        result: 'ok',
        error: null,
      });
    });
  });

  describe('navigation while a consent prompt is open', () => {
    test('dismisses the pending prompt on did-navigate and on destroyed', async () => {
      const { webview, consentMocks } = await loadProvider();

      webview.dispatch('did-navigate', { url: 'https://other.example' });
      expect(consentMocks.dismissRadicleConsent).toHaveBeenCalledTimes(1);
      expect(consentMocks.dismissRadicleConsent).toHaveBeenCalledWith(webview);

      webview.dispatch('destroyed', {});
      expect(consentMocks.dismissRadicleConsent).toHaveBeenCalledTimes(2);
    });

    test('signing approval after navigation must not grant, execute, or respond', async () => {
      const approval = deferred();
      const { webview, sendRequest, state, consentMocks, permissions, execute } =
        await loadProvider({ permission: { origin: 'https://app.example' } });
      consentMocks.showRadicleSigningApproval.mockReturnValue(approval.promise);

      sendRequest({ id: 4, method: 'radicle_createIssue', params: { title: 'hi' } });
      await flushMicrotasks();
      expect(consentMocks.showRadicleSigningApproval).toHaveBeenCalled();

      // The webview navigates to a different origin while the prompt is open.
      webview.dispatch('did-navigate', { url: 'https://evil.example' });
      state.displayUrl = 'https://evil.example';

      // The (now moot) approval resolves anyway — e.g. the click raced the
      // navigation. Nothing may be granted or executed as the old origin,
      // and no response may reach the replacement document.
      approval.resolve();
      await flushMicrotasks();

      expect(permissions.grantSigning).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(responsesSentTo(webview)).toHaveLength(0);
    });

    test('connect approval after navigation must not grant or emit connect', async () => {
      const approval = deferred();
      const { webview, sendRequest, state, consentMocks, permissions, execute } =
        await loadProvider();
      consentMocks.showRadicleConnect.mockReturnValue(approval.promise);

      sendRequest({ id: 5, method: 'radicle_requestAccess', params: {} });
      await flushMicrotasks();
      expect(consentMocks.showRadicleConnect).toHaveBeenCalled();

      webview.dispatch('did-navigate', { url: 'https://evil.example' });
      state.displayUrl = 'https://evil.example';

      approval.resolve();
      await flushMicrotasks();

      expect(permissions.grantPermission).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(webview.send).not.toHaveBeenCalled();
    });

    test('seed approval after navigation must not execute or respond', async () => {
      const approval = deferred();
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });
      consentMocks.showRadicleSeedApproval.mockReturnValue(approval.promise);

      sendRequest({ id: 6, method: 'radicle_seed', params: { rid: 'rad:zExample' } });
      await flushMicrotasks();
      expect(consentMocks.showRadicleSeedApproval).toHaveBeenCalled();

      webview.dispatch('did-navigate', { url: 'https://evil.example' });

      approval.resolve();
      await flushMicrotasks();

      expect(execute).not.toHaveBeenCalled();
      expect(responsesSentTo(webview)).toHaveLength(0);
    });

    test('webview destruction mid-prompt also blocks grant and execution', async () => {
      const approval = deferred();
      const { webview, sendRequest, consentMocks, permissions, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });
      consentMocks.showRadicleSigningApproval.mockReturnValue(approval.promise);

      sendRequest({ id: 7, method: 'radicle_createIssue', params: {} });
      await flushMicrotasks();

      webview.dispatch('destroyed', {});

      approval.resolve();
      await flushMicrotasks();

      expect(permissions.grantSigning).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(webview.send).not.toHaveBeenCalled();
    });
  });

  describe('a signed write whose document navigates before its prompt (R-6 review)', () => {
    test('a held auto_write_limit answer opens no prompt for the departed document', async () => {
      const pendingAuto = deferred();
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
        writeRule: true,
      });
      execute.mockReturnValueOnce(pendingAuto.promise);

      sendRequest({ id: 30, method: 'radicle_commentIssue', params: { body: 'Hi' } });
      await flushMicrotasks();
      expect(execute).toHaveBeenCalledTimes(1);

      webview.dispatch('did-navigate', { url: 'https://other.example' });
      pendingAuto.resolve({
        error: { code: 4100, message: 'limit', data: { reason: 'auto_write_limit' } },
      });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSignedWriteApproval).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(webview.send).not.toHaveBeenCalled();
    });

    test('a delayed rule lookup answering "no rule" opens no prompt after navigation', async () => {
      const lookup = deferred();
      const { webview, sendRequest, consentMocks, permissions, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        signingGrant: true,
      });
      permissions.getAutoApprove.mockImplementation((_origin, type) =>
        type === 'signing' ? lookup.promise : Promise.resolve(false)
      );

      sendRequest({ id: 31, method: 'radicle_createIssue', params: { title: 'Bug' } });
      await flushMicrotasks();

      webview.dispatch('did-navigate', { url: 'https://other.example' });
      lookup.resolve(false);
      await flushMicrotasks();

      expect(consentMocks.showRadicleSignedWriteApproval).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(webview.send).not.toHaveBeenCalled();
    });
  });

  describe('navigation while a request executes (no prompt involved)', () => {
    test('a result that arrives after navigation is never delivered', async () => {
      const pendingExecution = deferred();
      const { webview, sendRequest, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });
      execute.mockReturnValue(pendingExecution.promise);

      sendRequest({ id: 8, method: 'radicle_getNodeStatus', params: {} });
      await flushMicrotasks();
      expect(execute).toHaveBeenCalled();

      webview.dispatch('did-navigate', { url: 'https://evil.example' });

      pendingExecution.resolve({ result: { peers: 3 } });
      await flushMicrotasks();

      expect(webview.send).not.toHaveBeenCalled();
    });

    test('an error that arrives after navigation is never delivered', async () => {
      const pendingExecution = deferred();
      const { webview, sendRequest, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });
      execute.mockReturnValue(pendingExecution.promise);

      sendRequest({ id: 9, method: 'radicle_getNodeStatus', params: {} });
      await flushMicrotasks();

      webview.dispatch('did-navigate', { url: 'https://evil.example' });

      pendingExecution.resolve({ error: { code: -32000, message: 'node down' } });
      await flushMicrotasks();

      expect(webview.send).not.toHaveBeenCalled();
    });
  });
  // Node tier: both directions of the seeding policy take a per-repo prompt.
  // `unseed` used to run off the bare connection grant, so a connected origin
  // could enumerate the user's repos with radicle_listSeededRepos and drop
  // their seeding policies silently.
  describe('per-repo consent for seeding policy changes', () => {
    test('unseed prompts per repo before reaching main', async () => {
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });

      sendRequest({ id: 20, method: 'radicle_unseed', params: { rid: 'rad:zExample' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleUnseedApproval).toHaveBeenCalledWith(
        'https://app.example',
        'rad:zExample',
        webview
      );
      expect(execute).toHaveBeenCalledWith(
        'radicle_unseed',
        { rid: 'rad:zExample' },
        'https://app.example',
        { webContentsId: 41, approval: 'user' }
      );
    });

    test('a rejected unseed prompt never touches the node', async () => {
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });
      consentMocks.showRadicleUnseedApproval.mockRejectedValue({
        code: 4001,
        message: 'User rejected the request',
      });

      sendRequest({ id: 21, method: 'radicle_unseed', params: { rid: 'rad:zExample' } });
      await flushMicrotasks();

      expect(execute).not.toHaveBeenCalled();
      expect(responsesSentTo(webview)).toEqual([
        [
          'radicle:provider-response',
          { id: 21, result: null, error: { code: 4001, message: 'User rejected the request', data: undefined } },
        ],
      ]);
    });

    test('unseed approval that lands after a navigation is not executed', async () => {
      const approval = deferred();
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });
      consentMocks.showRadicleUnseedApproval.mockReturnValue(approval.promise);

      sendRequest({ id: 22, method: 'radicle_unseed', params: { rid: 'rad:zExample' } });
      await flushMicrotasks();
      webview.dispatch('did-navigate', { url: 'https://evil.example' });
      approval.resolve();
      await flushMicrotasks();

      expect(execute).not.toHaveBeenCalled();
      expect(responsesSentTo(webview)).toHaveLength(0);
    });

    test('the origin-level node auto-approve still covers both directions', async () => {
      const { sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        autoApprove: true,
      });

      sendRequest({ id: 23, method: 'radicle_unseed', params: { rid: 'rad:zExample' } });
      sendRequest({ id: 24, method: 'radicle_seed', params: { rid: 'rad:zExample' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleUnseedApproval).not.toHaveBeenCalled();
      expect(consentMocks.showRadicleSeedApproval).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledWith(
        'radicle_seed',
        { rid: 'rad:zExample' },
        'https://app.example',
        { webContentsId: 41, approval: 'auto' }
      );
    });

    test('node auto-approve never answers for a tab in Agent custody', async () => {
      const { webview, sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        autoApprove: true,
        agentOwnedTabId: 3,
      });

      sendRequest({ id: 26, method: 'radicle_seed', params: { rid: 'rad:zExample' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleSeedApproval).toHaveBeenCalledWith(
        'https://app.example',
        'rad:zExample',
        webview
      );
      expect(execute).toHaveBeenCalledWith(
        'radicle_seed',
        { rid: 'rad:zExample' },
        'https://app.example',
        { webContentsId: 41, approval: 'user' }
      );
    });

    test('sync stays promptless — main gates it on an existing seeding policy', async () => {
      const { sendRequest, consentMocks, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });

      sendRequest({ id: 25, method: 'radicle_sync', params: { rid: 'rad:zExample' } });
      await flushMicrotasks();

      expect(consentMocks.showRadicleUnseedApproval).not.toHaveBeenCalled();
      expect(consentMocks.showRadicleSeedApproval).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'radicle_sync',
        { rid: 'rad:zExample' },
        'https://app.example'
      );
    });
  });

  // Audit O-6 (#433): a compromised iframe renderer can still call
  // ipcRenderer.sendToHost; its requests must not use the top page's grants.
  describe('only the guest main frame is served', () => {
    test('a seed request from a sub-frame is dropped before any grant is read', async () => {
      const { webview, sendRequest, consentMocks, permissions, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        autoApprove: true,
      });

      sendRequest({ id: 30, method: 'radicle_seed', params: { rid: 'rad:zExample' } }, SUB_FRAME);
      await flushMicrotasks();

      expect(permissions.getPermission).not.toHaveBeenCalled();
      expect(consentMocks.showRadicleSeedApproval).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(responsesSentTo(webview)).toHaveLength(0);
    });

    test('a connect request from a sub-frame never opens the connect prompt', async () => {
      const { webview, sendRequest, consentMocks, execute } = await loadProvider();

      sendRequest({ id: 31, method: 'radicle_requestAccess', params: {} }, SUB_FRAME);
      await flushMicrotasks();

      expect(consentMocks.showRadicleConnect).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(responsesSentTo(webview)).toHaveLength(0);
    });

    test('nothing is served before the main frame has committed', async () => {
      const { webview, sendRequest, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
        mainFrameCommitted: false,
      });

      sendRequest({ id: 32, method: 'radicle_getNodeStatus', params: {} });
      await flushMicrotasks();

      expect(execute).not.toHaveBeenCalled();
      expect(responsesSentTo(webview)).toHaveLength(0);
    });

    test('follows the main frame across a commit; sub-frame commits are ignored', async () => {
      const { webview, sendRequest, commitMainFrame, execute } = await loadProvider({
        permission: { origin: 'https://app.example' },
      });
      const NEXT_MAIN_FRAME = [9, 4];

      commitMainFrame(SUB_FRAME, false);
      commitMainFrame(NEXT_MAIN_FRAME);
      sendRequest({ id: 33, method: 'radicle_getNodeStatus', params: {} }, SUB_FRAME);
      sendRequest({ id: 34, method: 'radicle_getNodeStatus', params: {} }, MAIN_FRAME);
      sendRequest({ id: 35, method: 'radicle_getNodeStatus', params: {} }, NEXT_MAIN_FRAME);
      await flushMicrotasks();

      expect(execute).toHaveBeenCalledTimes(1);
      expect(responsesSentTo(webview)).toEqual([
        ['radicle:provider-response', { id: 35, result: 'ok', error: null }],
      ]);
    });
  });
});
