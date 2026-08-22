'use strict';

const { OPERATIONS } = require('./contract/operations');
const { ERROR_CODES } = require('./contract/errors');
const {
  createOriginScopedAutomationController,
  originScopeForUrl,
} = require('./origin-scoped-controller');

function createController(initialUrl = 'https://trusted.example/start') {
  let url = initialUrl;
  let navigationId = 1;
  let failNextNavigation = false;
  const execute = jest.fn(async (operation, input) => {
    if (operation === OPERATIONS.GET_TAB) {
      return {
        ok: true,
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        tabId: 'tab_assigned',
        navigationId,
        result: { tab: { url, navigationId, available: true } },
      };
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
        ? { effect: 'form_submission', label: 'Submit registration' }
        : input.ref === 'ref_cross_origin'
          ? { label: 'Leave site', navigationTarget: 'https://attacker.example/collect' }
          : { label: 'Ordinary action' },
  }));
  return {
    execute,
    inspectAction,
    failNextNavigation: () => {
      failNextNavigation = true;
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

  test('denies cross-origin navigation before it reaches the page adapter', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    const result = await scoped.execute(OPERATIONS.NAVIGATE, {
      tabId: 'tab_assigned',
      url: 'https://attacker.example/collect',
    });

    expect(result).toMatchObject({
      ok: false,
      tabId: 'tab_assigned',
      error: { code: ERROR_CODES.POLICY_DENIED, retryable: false },
    });
    expect(controller.execute).not.toHaveBeenCalledWith(OPERATIONS.NAVIGATE, expect.anything());
  });

  test('denies a declarative cross-origin click target before dispatching input', async () => {
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
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.POLICY_DENIED, retryable: false },
    });
    expect(controller.execute).not.toHaveBeenCalledWith(OPERATIONS.CLICK, expect.anything());
  });

  test('denies foreign tabs and operations outside the run manifest', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });

    await expect(
      scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_other' })
    ).resolves.toMatchObject({ error: { code: ERROR_CODES.POLICY_DENIED } });
    await expect(scoped.execute(OPERATIONS.LIST_TABS, {})).resolves.toMatchObject({
      error: { code: ERROR_CODES.POLICY_DENIED },
    });
  });

  test('retains stop-loading authority after an unexpected origin change', async () => {
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
    ).resolves.toMatchObject({ error: { code: ERROR_CODES.POLICY_DENIED } });
    await expect(
      scoped.execute(OPERATIONS.STOP_LOADING, { tabId: 'tab_assigned' })
    ).resolves.toMatchObject({ ok: true });
    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.STOP_LOADING, {
      tabId: 'tab_assigned',
    });
  });

  test('lets a browser-owned start page establish the first supported origin', async () => {
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
    ).resolves.toMatchObject({ error: { code: ERROR_CODES.POLICY_DENIED } });
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
    const requestApproval = jest.fn(async () => true);
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
      origin: 'https://trusted.example',
      label: 'Submit registration',
    });
    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.CLICK, {
      tabId: 'tab_assigned',
      ref: 'ref_submit',
    });
  });

  test('does not dispatch a form submission after the user declines', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => false);
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

  test('fails closed when no form-submission approval channel is available', async () => {
    const controller = createController();
    const scoped = await createOriginScopedAutomationController({
      controller,
      tabId: 'tab_assigned',
    });
    await scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' });

    await expect(
      scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_assigned', ref: 'ref_submit' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.APPROVAL_REQUIRED, retryable: false },
    });
  });
});
