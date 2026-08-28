'use strict';

const { AGENT_APPROVAL_MODES } = require('../../shared/agent-approval-modes');
const { AGENT_NAVIGATION_SCOPES } = require('../../shared/agent-navigation-scopes');
const { OPERATIONS } = require('./contract/operations');
const { ERROR_CODES } = require('./contract/errors');
const {
  createOriginScopedAutomationController: createScopeBoundary,
  originScopeForUrl,
} = require('./origin-scoped-controller');

function createOriginScopedAutomationController(options) {
  return createScopeBoundary({
    navigationScope: AGENT_NAVIGATION_SCOPES.WORKSPACE,
    approvalMode: options.requestApproval
      ? AGENT_APPROVAL_MODES.EVERY_INTERACTION
      : AGENT_APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS,
    ...options,
  });
}

function createController(initialUrl = 'https://trusted.example/start') {
  let url = initialUrl;
  let navigationId = 1;
  let failNextNavigation = false;
  let submitAction = {
    effect: 'form_submission',
    label: 'Submit registration',
    navigationTarget: 'https://trusted.example/submit',
    formPayloadFingerprint: 'payload_initial',
  };
  let createdUrl = '';
  let createdClosed = false;
  let createdRedirectUrl = '';
  const execute = jest.fn(async (operation, input) => {
    if (operation === OPERATIONS.GET_TAB) {
      if (input.tabId === 'tab_created' && createdUrl && !createdClosed) {
        return {
          ok: true,
          runtimeId: 'runtime_test',
          contextId: 'context_test',
          tabId: 'tab_created',
          navigationId: 1,
          result: {
            tab: { tabId: 'tab_created', url: createdUrl, navigationId: 1, available: true },
          },
        };
      }
      return {
        ok: true,
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        tabId: 'tab_assigned',
        navigationId,
        result: { tab: { url, navigationId, available: true } },
      };
    }
    if (operation === OPERATIONS.CREATE_TAB) {
      createdUrl = createdRedirectUrl || input.url;
      createdClosed = false;
      return {
        ok: true,
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        result: {
          tab: { tabId: 'tab_created', url: createdUrl, navigationId: 1, available: true },
        },
      };
    }
    if (operation === OPERATIONS.CLOSE_TAB && input.tabId === 'tab_created') {
      createdClosed = true;
    }
    if (operation === OPERATIONS.NAVIGATE) {
      if (failNextNavigation) {
        failNextNavigation = false;
        return {
          ok: false,
          runtimeId: 'runtime_test',
          contextId: 'context_test',
          tabId: 'tab_assigned',
          navigationId,
          error: { code: ERROR_CODES.NAVIGATION_FAILED, message: 'Failed', retryable: true },
        };
      }
      url = input.url;
      navigationId += 1;
      return {
        ok: true,
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        tabId: 'tab_assigned',
        navigationId,
        result: { url },
      };
    }
    if (operation === OPERATIONS.SNAPSHOT) {
      return {
        ok: true,
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        tabId: 'tab_assigned',
        navigationId,
        result: {
          elements: [
            {
              ref: 'ref_submit',
              role: 'button',
              name: 'Submit registration',
              effect: 'form_submission',
            },
          ],
        },
      };
    }
    return {
      ok: true,
      runtimeId: 'runtime_test',
      contextId: 'context_test',
      tabId: 'tab_assigned',
      navigationId,
      result: { operation },
    };
  });
  const inspectAction = jest.fn(async (_operation, input) => ({
    ok: true,
    runtimeId: 'runtime_test',
    contextId: 'context_test',
    tabId: 'tab_assigned',
    navigationId,
    result:
      input.ref === 'ref_submit'
        ? submitAction
        : input.ref === 'ref_download'
          ? {
              effect: 'file_download',
              label: 'Download report',
              navigationTarget: 'https://trusted.example/report.pdf',
            }
        : input.ref === 'ref_upload'
          ? { effect: 'file_upload', label: 'Attach résumé' }
        : input.ref === 'ref_cross_origin'
          ? { label: 'Leave site', navigationTarget: 'https://attacker.example/collect' }
          : { label: 'Ordinary action' },
  }));
  return {
    execute,
    inspectAction,
    setUrl: (nextUrl) => {
      url = nextUrl;
      navigationId += 1;
    },
    setSubmitAction: (nextAction) => {
      submitAction = nextAction;
    },
    failNextNavigation: () => {
      failNextNavigation = true;
    },
    redirectCreatedTabTo: (nextUrl) => {
      createdRedirectUrl = nextUrl;
    },
    setCreatedUrl: (nextUrl) => {
      createdUrl = nextUrl;
    },
  };
}

describe('OriginScopedAutomationController', () => {
  test('normalizes web and dweb origins without retaining paths', () => {
    expect(originScopeForUrl('https://Example.test:443/path?q=1')).toBe('https://example.test');
    expect(originScopeForUrl('ipfs://BAFY/path')).toBe('ipfs://bafy');
    expect(originScopeForUrl('file:///tmp/secret')).toBeNull();
    expect(originScopeForUrl('not a url')).toBeNull();
  });

  test('starts without adopting a user tab and creates the first Agent-owned page', async () => {
    const controller = createController();
    const createWorkspacePage = jest.fn(async (url) => {
      controller.setCreatedUrl(url);
      return 'tab_created';
    });
    const onWorkspaceTabCreated = jest.fn();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: null,
      createWorkspacePage,
      onWorkspaceTabCreated,
    });

    expect(controller.execute).not.toHaveBeenCalledWith(OPERATIONS.GET_TAB, {
      tabId: 'tab_assigned',
    });
    expect(scoped.getWorkspaceState()).toEqual({ tabIds: [], activeTabId: null });
    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      ok: true,
      result: { tabs: [], activeTabId: null },
    });
    await expect(
      scoped.execute(OPERATIONS.CREATE_TAB, { url: 'https://fresh.example/start' })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        activeTabId: 'tab_created',
        tab: { tabId: 'tab_created', url: 'https://fresh.example/start' },
      },
    });
    expect(createWorkspacePage).toHaveBeenCalledWith('https://fresh.example/start');
    expect(onWorkspaceTabCreated).toHaveBeenCalledWith('tab_created');
    expect(scoped.getWorkspaceState()).toEqual({
      tabIds: ['tab_created'],
      activeTabId: 'tab_created',
    });
    await expect(
      scoped.execute(OPERATIONS.CREATE_TAB, {
        tabId: 'tab_created',
        url: 'https://second.example/source',
      })
    ).resolves.toMatchObject({ ok: true });
  });

  test('allows assigned-tab operations and same-origin navigation', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      scoped.execute(OPERATIONS.NAVIGATE, {
        tabId: 'tab_assigned',
        url: 'https://trusted.example/next',
      })
    ).resolves.toMatchObject({ ok: true, result: { url: 'https://trusted.example/next' } });
  });

  test('allows cross-origin navigation inside the task-owned workspace', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    const result = await scoped.execute(OPERATIONS.NAVIGATE, {
      tabId: 'tab_assigned',
      url: 'https://attacker.example/collect',
    });

    expect(result).toMatchObject({ ok: true, tabId: 'tab_assigned' });
    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.NAVIGATE, {
      tabId: 'tab_assigned',
      url: 'https://attacker.example/collect',
    });
  });

  test('allows supported cross-origin navigation and task tabs in workspace scope', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(
      scoped.execute(OPERATIONS.NAVIGATE, {
        tabId: 'tab_assigned',
        url: 'https://independent.example/report',
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      scoped.execute(OPERATIONS.CREATE_TAB, {
        tabId: 'tab_assigned',
        url: 'ipfs://bafybeiresearch/source',
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { activeTabId: 'tab_created', tab: { tabId: 'tab_created' } },
    });
    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      result: {
        tabs: [
          { url: 'https://independent.example/report' },
          { url: 'ipfs://bafybeiresearch/source' },
        ],
      },
    });
  });

  test.each([
    [OPERATIONS.CLICK, { ref: 'ref_button' }],
    [OPERATIONS.TYPE, { ref: 'ref_field', text: 'sensitive' }],
    [OPERATIONS.SELECT, { ref: 'ref_select', value: 'one' }],
    [OPERATIONS.PRESS, { ref: 'ref_field', key: 'Enter' }],
  ])('requires approval before %s in every-interaction mode', async (operation, input) => {
    const controller = createController();
    const requestApproval = jest.fn(async () => 'declined');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
    });

    await expect(
      scoped.execute(operation, { tabId: 'tab_assigned', ...input })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: ERROR_CODES.USER_CANCELLED,
        message: expect.stringContaining('declined'),
      },
    });
    expect(controller.execute).not.toHaveBeenCalledWith(operation, expect.anything());
    expect(controller.inspectAction).toHaveBeenCalledWith(operation, {
      tabId: 'tab_assigned',
      ...input,
    });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'browser_interaction', operation })
    );
  });

  test('rejects an unknown navigation scope when creating the policy boundary', async () => {
    const controller = createController();

    await expect(
      createOriginScopedAutomationController({
        controller,
        tabId: 'tab_assigned',
        navigationScope: 'unrestricted',
      })
    ).rejects.toThrow('valid navigation scope');
  });

  test('rejects the unimplemented sensitive-actions approval mode', async () => {
    const controller = createController();

    await expect(
      createOriginScopedAutomationController({
        controller,
        tabId: 'tab_assigned',
        approvalMode: AGENT_APPROVAL_MODES.SENSITIVE_ACTIONS,
      })
    ).rejects.toThrow('supported approval mode');
  });

  test('allows a declarative cross-origin click target in the cross-site workspace', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(
      scoped.execute(OPERATIONS.CLICK, {
        tabId: 'tab_assigned',
        ref: 'ref_cross_origin',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.CLICK, {
      tabId: 'tab_assigned',
      ref: 'ref_cross_origin',
    });
    expect(controller.inspectAction).not.toHaveBeenCalled();
  });

  test('denies foreign tabs while listing only tabs owned by the task', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_other' })
    ).resolves.toMatchObject({ error: { code: ERROR_CODES.POLICY_DENIED } });
    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      ok: true,
      result: {
        activeTabId: 'tab_assigned',
        tabs: [{ url: 'https://trusted.example/start' }],
      },
    });
  });

  test('creates, focuses, lists, and closes task-owned tabs across sites', async () => {
    const controller = createController();
    const onWorkspaceTabCreated = jest.fn();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      onWorkspaceTabCreated,
    });

    const created = await scoped.execute(OPERATIONS.CREATE_TAB, {
      tabId: 'tab_assigned',
      url: 'https://trusted.example/comparison',
    });
    expect(created).toMatchObject({
      ok: true,
      result: { activeTabId: 'tab_created', tab: { tabId: 'tab_created' } },
    });
    expect(onWorkspaceTabCreated).toHaveBeenCalledWith('tab_created');
    expect(scoped.getWorkspaceState()).toEqual({
      tabIds: ['tab_assigned', 'tab_created'],
      activeTabId: 'tab_created',
    });
    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      ok: true,
      result: {
        activeTabId: 'tab_created',
        tabs: [{ url: 'https://trusted.example/start' }, { tabId: 'tab_created' }],
      },
    });
    await expect(
      scoped.execute(OPERATIONS.FOCUS_TAB, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      scoped.execute(OPERATIONS.CLOSE_TAB, { tabId: 'tab_created' })
    ).resolves.toMatchObject({
      ok: true,
      result: { activeTabId: 'tab_assigned' },
    });
    expect(scoped.getWorkspaceState()).toEqual({
      tabIds: ['tab_assigned'],
      activeTabId: 'tab_assigned',
    });
    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      result: { activeTabId: 'tab_assigned', tabs: [{ url: 'https://trusted.example/start' }] },
    });
    await expect(
      scoped.execute(OPERATIONS.CREATE_TAB, {
        tabId: 'tab_assigned',
        url: 'https://foreign.example/comparison',
      })
    ).resolves.toMatchObject({ ok: true, result: { activeTabId: 'tab_created' } });
    await expect(
      scoped.execute(OPERATIONS.CLOSE_TAB, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({ error: { code: ERROR_CODES.POLICY_DENIED } });
  });

  test('releases a claimed Agent-created tab without affecting the adopted user tab', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });
    await scoped.execute(OPERATIONS.CREATE_TAB, {
      tabId: 'tab_assigned',
      url: 'https://research.example/article',
    });

    expect(scoped.releaseTab('tab_created')).toBe(true);
    expect(scoped.releaseTab('tab_created')).toBe(false);
    expect(scoped.getWorkspaceState()).toEqual({
      tabIds: ['tab_assigned'],
      activeTabId: 'tab_assigned',
    });
    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_created' })
    ).resolves.toMatchObject({ error: { code: ERROR_CODES.POLICY_DENIED } });
  });

  test('falls back to a remaining task-owned tab when the originally adopted tab closes', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });
    await scoped.execute(OPERATIONS.CREATE_TAB, {
      tabId: 'tab_assigned',
      url: 'https://research.example/article',
    });
    await scoped.execute(OPERATIONS.FOCUS_TAB, { tabId: 'tab_assigned' });

    scoped.handleTabLifecycle({ type: 'tab_closed', tabId: 'tab_assigned' });

    expect(scoped.getActiveTabId()).toBe('tab_created');
    await expect(scoped.prepareResume()).resolves.toMatchObject({
      ok: true,
      activeTabId: 'tab_created',
      workspaceEmpty: false,
    });
    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      result: { activeTabId: 'tab_created', tabs: [{ tabId: 'tab_created' }] },
    });
  });

  test('creates a fresh task tab without adopting unrelated tabs after the workspace empties', async () => {
    const controller = createController();
    const createWorkspacePage = jest.fn(async (url) => {
      controller.setCreatedUrl(url);
      return 'tab_created';
    });
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      createWorkspacePage,
    });
    scoped.handleTabLifecycle({ type: 'tab_closed', tabId: 'tab_assigned' });

    await expect(scoped.prepareResume()).resolves.toEqual({
      ok: true,
      activeTabId: null,
      workspaceEmpty: true,
    });
    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_unrelated' })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: ERROR_CODES.CAPABILITY_UNAVAILABLE,
        message: expect.stringContaining('Create a fresh task tab'),
      },
    });
    await expect(
      scoped.execute(OPERATIONS.CREATE_TAB, { url: 'https://fresh.example/start' })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        activeTabId: 'tab_created',
        tab: { tabId: 'tab_created', url: 'https://fresh.example/start' },
      },
    });
    expect(createWorkspacePage).toHaveBeenCalledWith('https://fresh.example/start');
    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_created' })
    ).resolves.toMatchObject({ ok: true });
  });

  test('adopts a created tab that redirects to another supported website', async () => {
    const controller = createController();
    controller.redirectCreatedTabTo('https://foreign.example/redirected');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(
      scoped.execute(OPERATIONS.CREATE_TAB, {
        tabId: 'tab_assigned',
        url: 'https://trusted.example/comparison',
      })
    ).resolves.toMatchObject({ ok: true, result: { activeTabId: 'tab_created' } });
    expect(controller.execute).not.toHaveBeenCalledWith(OPERATIONS.CLOSE_TAB, {
      tabId: 'tab_created',
    });
    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      result: {
        tabs: [
          { url: 'https://trusted.example/start' },
          { url: 'https://foreign.example/redirected' },
        ],
      },
    });
  });

  test('redacts an owned tab outside the supported workspace while retaining close authority', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });
    await scoped.execute(OPERATIONS.CREATE_TAB, {
      tabId: 'tab_assigned',
      url: 'https://trusted.example/comparison',
    });
    controller.setCreatedUrl('file:///private/secret.html');

    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      ok: true,
      result: {
        tabs: [
          { url: 'https://trusted.example/start' },
          {
            tabId: 'tab_created',
            url: '',
            title: 'Unavailable task tab',
            available: false,
            unavailableReason: 'outside_supported_workspace',
          },
        ],
      },
    });
    await expect(
      scoped.execute(OPERATIONS.GET_TAB, { tabId: 'tab_created' })
    ).resolves.toMatchObject({ ok: false, error: { code: ERROR_CODES.POLICY_DENIED } });
    await expect(
      scoped.execute(OPERATIONS.CLOSE_TAB, { tabId: 'tab_created' })
    ).resolves.toMatchObject({ ok: true });
  });

  test('retains observation and stop-loading authority after an origin change', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });
    await controller.execute(OPERATIONS.NAVIGATE, {
      tabId: 'tab_assigned',
      url: 'https://redirected.example/',
    });

    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      scoped.execute(OPERATIONS.STOP_LOADING, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({ ok: true });
    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.STOP_LOADING, {
      tabId: 'tab_assigned',
    });
  });

  test('requires a fresh tab read and snapshot before acting after resume', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(scoped.prepareResume()).resolves.toMatchObject({
      ok: true,
      activeTabId: 'tab_assigned',
      workspaceEmpty: false,
    });
    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_button' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.POLICY_DENIED },
    });
    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.POLICY_DENIED },
    });
    await expect(
      scoped.execute(OPERATIONS.GET_TAB, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_button' })
    ).resolves.toMatchObject({ ok: true });
  });

  test('prepares resume after a cross-origin human navigation inside the workspace', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });
    controller.setUrl('https://other.example/changed-by-user');

    await expect(scoped.prepareResume()).resolves.toMatchObject({
      ok: true,
      activeTabId: 'tab_assigned',
      workspaceEmpty: false,
    });
  });

  test('lets a browser-owned start page navigate across supported origins', async () => {
    const controller = createController('freedom://newtab/');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(
      scoped.execute(OPERATIONS.NAVIGATE, {
        tabId: 'tab_assigned',
        url: 'ipfs://bafybeifirst/page',
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      scoped.execute(OPERATIONS.NAVIGATE, {
        tabId: 'tab_assigned',
        url: 'ipfs://bafybeisecond/page',
      })
    ).resolves.toMatchObject({ ok: true });
  });

  test('does not lock a browser-owned start page to a failed first navigation', async () => {
    const controller = createController('freedom://newtab/');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });
    controller.failNextNavigation();

    await expect(
      scoped.execute(OPERATIONS.NAVIGATE, {
        tabId: 'tab_assigned',
        url: 'https://unavailable.example/',
      })
    ).resolves.toMatchObject({ error: { code: ERROR_CODES.NAVIGATION_FAILED } });
    await expect(
      scoped.execute(OPERATIONS.NAVIGATE, {
        tabId: 'tab_assigned',
        url: 'https://working.example/',
      })
    ).resolves.toMatchObject({ ok: true });
  });

  test('pauses native form submission for one-shot user approval', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => 'approved');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
    });
    await scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({ ok: true });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'form_submission',
      operation: OPERATIONS.CLICK,
      tabId: 'tab_assigned',
      origin: 'https://trusted.example',
      destinationOrigin: 'https://trusted.example',
      label: 'Submit registration',
    });
    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.CLICK, {
      tabId: 'tab_assigned',
      ref: 'ref_submit',
    });
  });

  test('requires the same approval when Enter would submit a form', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => 'approved');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
    });

    await expect(
      scoped.execute(OPERATIONS.PRESS, {
        tabId: 'tab_assigned',
        ref: 'ref_submit',
        key: 'Enter',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'form_submission',
      operation: OPERATIONS.PRESS,
      tabId: 'tab_assigned',
      origin: 'https://trusted.example',
      destinationOrigin: 'https://trusted.example',
      label: 'Submit registration',
    });
    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.PRESS, {
      tabId: 'tab_assigned',
      ref: 'ref_submit',
      key: 'Enter',
    });
    expect(controller.inspectAction).toHaveBeenCalledWith(OPERATIONS.PRESS, {
      tabId: 'tab_assigned',
      ref: 'ref_submit',
      key: 'Enter',
    });
  });

  test('does not dispatch a form submission after the user declines', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => 'declined');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
    });
    await scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.USER_CANCELLED, retryable: false },
    });
    expect(controller.execute).not.toHaveBeenCalledWith(OPERATIONS.CLICK, expect.anything());
    await scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  test('does not make a withdrawn approval sticky across a later attempt', async () => {
    const controller = createController();
    const requestApproval = jest
      .fn()
      .mockResolvedValueOnce('withdrawn')
      .mockResolvedValueOnce('approved');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
    });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.USER_CANCELLED, retryable: false },
    });
    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({ ok: true });

    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.CLICK, {
      tabId: 'tab_assigned',
      ref: 'ref_submit',
    });
  });

  test('invalidates approval when a form target changes across origins', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => {
      controller.setSubmitAction({
        effect: 'form_submission',
        label: 'Submit registration',
        navigationTarget: 'https://attacker.example/collect',
      });
      return 'approved';
    });
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
    });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.STALE_ELEMENT_REFERENCE, retryable: true },
    });
    expect(controller.inspectAction).toHaveBeenCalledTimes(2);
    expect(controller.execute).not.toHaveBeenCalledWith(OPERATIONS.CLICK, expect.anything());
  });

  test('invalidates approval when the action descriptor changes during approval', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => {
      controller.setSubmitAction({
        effect: 'form_submission',
        label: 'Publish registration',
        navigationTarget: 'https://trusted.example/submit',
      });
      return 'approved';
    });
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
    });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.STALE_ELEMENT_REFERENCE, retryable: true },
    });
    expect(controller.execute).not.toHaveBeenCalledWith(OPERATIONS.CLICK, expect.anything());
  });

  test('invalidates approval when the form payload changes during approval', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => {
      controller.setSubmitAction({
        effect: 'form_submission',
        label: 'Submit registration',
        navigationTarget: 'https://trusted.example/submit',
        formPayloadFingerprint: 'payload_changed',
      });
      return 'approved';
    });
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
    });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.STALE_ELEMENT_REFERENCE, retryable: true },
    });
    expect(controller.inspectAction).toHaveBeenCalledTimes(2);
    expect(controller.execute).not.toHaveBeenCalledWith(OPERATIONS.CLICK, expect.anything());
  });

  test('fails closed when every-interaction mode has no approval channel', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      approvalMode: AGENT_APPROVAL_MODES.EVERY_INTERACTION,
    });
    await scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.APPROVAL_REQUIRED, retryable: false },
    });
  });

  test('dispatches form submission without approval in allow-interactions mode', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({ ok: true });
    expect(controller.inspectAction).not.toHaveBeenCalled();
  });

  test('requires explicit approval for a controlled download and scopes its artifact owner', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => 'approved');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
      transferOwnerId: 'conversation_test',
    });

    await expect(
      scoped.execute(OPERATIONS.DOWNLOAD, {
        tabId: 'tab_assigned',
        ref: 'ref_download',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'file_download',
        operation: OPERATIONS.DOWNLOAD,
        label: 'Download report',
      })
    );
    expect(controller.execute).toHaveBeenCalledWith(
      OPERATIONS.DOWNLOAD,
      { tabId: 'tab_assigned', ref: 'ref_download' },
      { conversationId: 'conversation_test' }
    );
  });

  test('always asks before file selection and binds approval to the current site', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => 'approved');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
      approvalMode: AGENT_APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS,
    });

    await expect(
      scoped.execute(OPERATIONS.UPLOAD, { tabId: 'tab_assigned', ref: 'ref_upload' })
    ).resolves.toMatchObject({ ok: true });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'file_upload',
        operation: OPERATIONS.UPLOAD,
        label: 'Attach résumé',
        origin: 'https://trusted.example',
        destinationOrigin: 'https://trusted.example',
      })
    );
  });

  test('subjects the legacy wallet action alias to ordinary page-interaction approval', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => 'approved');
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
      requestApproval,
      transferOwnerId: 'conversation_test',
    });

    await expect(
      scoped.execute(OPERATIONS.WALLET_ACTION, {
        tabId: 'tab_assigned',
        ref: 'ref_wallet',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(controller.inspectAction).toHaveBeenCalledTimes(2);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'browser_interaction',
        operation: OPERATIONS.WALLET_ACTION,
      })
    );
    expect(controller.execute).toHaveBeenLastCalledWith(
      OPERATIONS.WALLET_ACTION,
      { tabId: 'tab_assigned', ref: 'ref_wallet' },
      { conversationId: 'conversation_test' }
    );
  });

  test('holds a triggering page interaction until its external approval settles', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });
    let releaseApproval;
    const approval = new Promise((resolve) => {
      releaseApproval = resolve;
    });
    const executeController = controller.execute.getMockImplementation();
    controller.execute.mockImplementation(async (operation, input) => {
      const result = await executeController(operation, input);
      if (operation === OPERATIONS.CLICK) scoped.setExternalApprovalBarrier(approval);
      return result;
    });

    let settled = false;
    const execution = scoped
      .execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_wallet' })
      .then((result) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseApproval();
    await expect(execution).resolves.toMatchObject({ ok: true });
  });

  test('lists only downloads belonging to the scoped conversation without requiring a tab', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: null,
      transferOwnerId: 'conversation_test',
    });

    await scoped.execute(OPERATIONS.LIST_DOWNLOADS, {});

    expect(controller.execute).toHaveBeenLastCalledWith(
      OPERATIONS.LIST_DOWNLOADS,
      {},
      { conversationId: 'conversation_test' }
    );
  });

  test('allows a direct wallet transfer from an empty browser workspace but preserves approval', async () => {
    const controller = createController();
    const requestApproval = jest.fn();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: null,
      transferOwnerId: 'conversation_test',
      requestApproval,
    });
    const input = {
      recipient: 'meinhard.eth',
      amount: '0.01',
      asset: 'GNO',
      chainId: 100,
    };

    await scoped.execute(OPERATIONS.WALLET_TRANSFER, input);

    expect(controller.execute).toHaveBeenLastCalledWith(OPERATIONS.WALLET_TRANSFER, input, {
      conversationId: 'conversation_test',
      requestApproval,
    });
  });

  test('allows read-only node inspection from an empty browser workspace', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: null,
      transferOwnerId: 'conversation_test',
    });

    await scoped.execute(OPERATIONS.NODE_STATUS, {});

    expect(controller.execute).toHaveBeenLastCalledWith(
      OPERATIONS.NODE_STATUS,
      {},
      { conversationId: 'conversation_test' }
    );
  });

  test('preserves classifier and approval boundaries for node lifecycle without a tab', async () => {
    const controller = createController();
    const requestApproval = jest.fn();
    const classifyEffect = jest.fn();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: null,
      transferOwnerId: 'conversation_test',
      requestApproval,
      classifyEffect,
    });
    const input = { service: 'ipfs', action: 'restart' };

    await scoped.execute(OPERATIONS.NODE_LIFECYCLE, input);

    expect(controller.execute).toHaveBeenLastCalledWith(OPERATIONS.NODE_LIFECYCLE, input, {
      conversationId: 'conversation_test',
      classifyEffect,
      requestApproval,
    });
  });

  test('requires one provider disclosure and can grant diagnostics for the conversation', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => ({
      status: 'approved',
      diagnosticScope: 'conversation',
    }));
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: null,
      transferOwnerId: 'conversation_test',
      requestApproval,
    });

    controller.execute.mockImplementation(async (_operation, _input, execution) => {
      await execution.requestApproval({
        operation: _operation,
        diagnostic: { scope: _operation === OPERATIONS.APP_DIAGNOSTICS ? 'app' : 'node' },
      });
      return { ok: true };
    });
    await scoped.execute(OPERATIONS.NODE_DIAGNOSTICS, { service: 'ipfs' });
    await scoped.execute(OPERATIONS.APP_DIAGNOSTICS, {});

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(controller.execute).toHaveBeenNthCalledWith(
      1,
      OPERATIONS.NODE_DIAGNOSTICS,
      { service: 'ipfs' },
      expect.objectContaining({ conversationId: 'conversation_test' })
    );
  });
});
