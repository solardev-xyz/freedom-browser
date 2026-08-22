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
    return {
      ok: true,
      runtimeId: 'runtime_test',
      contextId: 'context_test',
      tabId: 'tab_assigned',
      navigationId,
      result: { operation },
    };
  });
  return {
    execute,
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
});
