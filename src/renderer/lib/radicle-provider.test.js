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

const loadProvider = async (options = {}) => {
  jest.resetModules();

  const state = {
    displayUrl: options.displayUrl ?? 'https://app.example',
    permission: options.permission ?? null,
    autoApprove: options.autoApprove ?? false,
    signingGrant: options.signingGrant ?? false,
  };

  const consentMocks = {
    showRadicleConnect: jest.fn(() => Promise.resolve()),
    showRadicleSeedApproval: jest.fn(() => Promise.resolve()),
    showRadicleSigningApproval: jest.fn(() => Promise.resolve()),
    dismissRadicleConsent: jest.fn(),
  };

  const permissions = {
    getPermission: jest.fn(async () => state.permission),
    grantPermission: jest.fn(async () => {}),
    getAutoApprove: jest.fn(async () => state.autoApprove),
    hasSigningGrant: jest.fn(async () => state.signingGrant),
    grantSigning: jest.fn(async () => {}),
  };

  const execute = jest.fn(async () => ({ result: 'ok' }));

  global.window = {
    electronAPI: {
      getSettings: jest.fn(async () => ({ enableRadicleIntegration: true })),
    },
    addEventListener: jest.fn(),
    radiclePermissions: permissions,
    radicleProvider: { execute },
  };

  jest.doMock('./dapp-provider.js', () => ({
    getPermissionKey: jest.fn((url) => url),
  }));
  jest.doMock('./tabs.js', () => ({
    getDisplayUrlForWebview: jest.fn(() => state.displayUrl),
  }));
  jest.doMock('./radicle-consent.js', () => consentMocks);

  const mod = await import('./radicle-provider.js');
  // Let the async settings read land so the feature gate opens.
  await flushMicrotasks();

  const webview = createElement('webview');
  webview.send = jest.fn();
  mod.setupRadicleProvider(webview);

  const sendRequest = (request) => {
    webview.dispatch('ipc-message', {
      channel: 'radicle:provider-request',
      args: [request],
    });
  };

  return { mod, webview, sendRequest, state, consentMocks, permissions, execute };
};

const responsesSentTo = (webview) =>
  webview.send.mock.calls.filter(([channel]) => channel === 'radicle:provider-response');

describe('radicle-provider', () => {
  afterEach(() => {
    global.window = originalWindow;
    jest.restoreAllMocks();
  });

  describe('happy paths (same document throughout)', () => {
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
      expect(execute).toHaveBeenCalledWith(
        'radicle_createIssue',
        { title: 'hi' },
        'https://app.example'
      );
      expect(webview.send).toHaveBeenCalledWith('radicle:provider-response', {
        id: 1,
        result: 'ok',
        error: null,
      });
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
});
