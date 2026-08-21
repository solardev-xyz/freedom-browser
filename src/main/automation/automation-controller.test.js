'use strict';

const { EventEmitter } = require('events');
const { AutomationController } = require('./automation-controller');
const { OPERATIONS } = require('./contract/operations');
const { AutomationError, ERROR_CODES } = require('./contract/errors');

class FakePageAdapter extends EventEmitter {
  constructor(url = 'https://example.test/') {
    super();
    this.state = {
      url,
      title: 'Fixture',
      loading: false,
      navigationId: 3,
      available: true,
    };
    this.navigate = jest.fn(async (nextUrl) => {
      this.state.url = nextUrl;
      this.state.navigationId += 1;
      return { url: nextUrl };
    });
    this.snapshot = jest.fn(async () => ({ text: 'Fixture page', elements: [] }));
    this.click = jest.fn(async (ref) => ({ clicked: true, ref }));
    this.type = jest.fn(async (ref, text) => ({ typed: true, ref, characters: text.length }));
    this.screenshot = jest.fn(async () => ({ mediaType: 'image/png', base64: 'cG5n' }));
    this.wait = jest.fn(async ({ condition }) => ({ matched: true, condition }));
    this.stopLoading = jest.fn(async () => ({ stopped: true }));
  }

  getState() {
    return { ...this.state };
  }
}

function createController(authorize = jest.fn(async () => ({ allowed: true }))) {
  let nextTab = 1;
  return {
    authorize,
    controller: new AutomationController({
      runtimeId: 'runtime_test',
      contextId: 'context_test',
      tabIdFactory: () => `tab_${nextTab++}`,
      policyController: { authorize },
    }),
  };
}

describe('AutomationController', () => {
  test('requires a policy boundary', () => {
    expect(() => new AutomationController()).toThrow('requires a policyController');
  });

  test('uses opaque IDs and one result envelope for desktop and headless pages', async () => {
    const { controller, authorize } = createController();
    const desktop = new FakePageAdapter();
    const headless = new FakePageAdapter('bzz://fixture/');
    const desktopTabId = controller.registerPage(desktop, { kind: 'desktop' });
    const headlessTabId = controller.registerPage(headless, { kind: 'headless' });

    const listed = await controller.execute(OPERATIONS.LIST_TABS);
    expect(listed).toEqual({
      ok: true,
      runtimeId: 'runtime_test',
      contextId: 'context_test',
      result: {
        tabs: [
          expect.objectContaining({ tabId: desktopTabId, kind: 'desktop' }),
          expect.objectContaining({ tabId: headlessTabId, kind: 'headless' }),
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toMatch(/webContents|BrowserWindow|partition/);

    const navigated = await controller.execute(OPERATIONS.NAVIGATE, {
      tabId: headlessTabId,
      url: 'ipfs://bafy/',
    });
    expect(navigated).toMatchObject({
      ok: true,
      tabId: headlessTabId,
      navigationId: 4,
      result: { url: 'ipfs://bafy/' },
    });
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: OPERATIONS.NAVIGATE,
        tab: expect.objectContaining({ tabId: headlessTabId, kind: 'headless' }),
      })
    );
  });

  test('returns typed not-found and policy errors without throwing', async () => {
    const { controller } = createController();
    await expect(
      controller.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_missing' })
    ).resolves.toMatchObject({
      ok: false,
      tabId: 'tab_missing',
      error: { code: ERROR_CODES.TAB_NOT_FOUND },
    });

    const denied = createController(async () => ({ allowed: false, reason: 'Not granted' }));
    const tabId = denied.controller.registerPage(new FakePageAdapter(), { kind: 'desktop' });
    await expect(
      denied.controller.execute(OPERATIONS.CLICK, { tabId, ref: 'ref_1' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.POLICY_DENIED, message: 'Not granted' },
    });
  });

  test('does not echo an unvalidated tab ID into error envelopes', async () => {
    const { controller } = createController();
    const failure = await controller.execute(OPERATIONS.SNAPSHOT, {
      tabId: { secret: 'untrusted metadata' },
    });

    expect(failure).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.INVALID_ARGUMENT },
    });
    expect(failure).not.toHaveProperty('tabId');
    expect(JSON.stringify(failure)).not.toContain('untrusted metadata');
  });

  test('normalizes and dispatches bounded waits', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });

    await expect(
      controller.execute(OPERATIONS.WAIT, {
        tabId,
        condition: 'text',
        text: 'Ready',
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { matched: true, condition: 'text' },
    });
    expect(adapter.wait).toHaveBeenCalledWith({
      tabId,
      condition: 'text',
      text: 'Ready',
      timeoutMs: 10_000,
    });
  });

  test('preserves typed adapter failures and redacts unexpected errors', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });
    adapter.click.mockRejectedValueOnce(
      new AutomationError(ERROR_CODES.STALE_ELEMENT_REFERENCE, 'Page changed', {
        retryable: true,
        suggestedAction: 'Take a new snapshot',
      })
    );
    await expect(
      controller.execute(OPERATIONS.CLICK, { tabId, ref: 'ref_1' })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
        retryable: true,
        suggestedAction: 'Take a new snapshot',
      },
    });

    adapter.snapshot.mockRejectedValueOnce(new Error('secret implementation detail'));
    const failure = await controller.execute(OPERATIONS.SNAPSHOT, { tabId });
    expect(failure.error).toEqual({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'The automation operation failed unexpectedly',
      retryable: false,
    });
    expect(JSON.stringify(failure)).not.toContain('secret implementation detail');
  });

  test('removes a tab when its adapter is destroyed', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });
    adapter.emit('destroyed');

    const listed = await controller.execute(OPERATIONS.LIST_TABS);
    expect(listed.result.tabs).toEqual([]);
    expect(controller.unregisterPage(tabId)).toBe(false);
  });
});
