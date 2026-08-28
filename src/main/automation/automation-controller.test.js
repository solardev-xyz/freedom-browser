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
    this.inspectAction = jest.fn(async () => ({
      effect: 'form_submission',
      label: 'Submit registration',
    }));
    this.click = jest.fn(async (ref) => ({ clicked: true, ref }));
    this.type = jest.fn(async (ref, text) => ({ typed: true, ref, characters: text.length }));
    this.select = jest.fn(async (ref, value) => ({ selected: true, ref, value }));
    this.press = jest.fn(async (ref, key) => ({ pressed: true, ref, key }));
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

  test('inspects a referenced click target without dispatching it', async () => {
    const { controller, authorize } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });

    await expect(
      controller.inspectAction(OPERATIONS.CLICK, { tabId, ref: 'ref_submit' })
    ).resolves.toMatchObject({
      ok: true,
      tabId,
      result: { effect: 'form_submission', label: 'Submit registration' },
    });
    expect(adapter.inspectAction).toHaveBeenCalledWith('ref_submit', {
      operation: OPERATIONS.CLICK,
    });
    expect(adapter.click).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  test('inspects type and select targets without dispatching them', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });

    await expect(
      controller.inspectAction(OPERATIONS.TYPE, { tabId, ref: 'ref_field', text: 'draft' })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      controller.inspectAction(OPERATIONS.SELECT, {
        tabId,
        ref: 'ref_region',
        value: 'eu-west',
      })
    ).resolves.toMatchObject({ ok: true });

    expect(adapter.inspectAction).toHaveBeenNthCalledWith(1, 'ref_field', {
      operation: OPERATIONS.TYPE,
    });
    expect(adapter.inspectAction).toHaveBeenNthCalledWith(2, 'ref_region', {
      operation: OPERATIONS.SELECT,
    });
    expect(adapter.type).not.toHaveBeenCalled();
    expect(adapter.select).not.toHaveBeenCalled();
  });

  test('dispatches semantic select and bounded key operations', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });

    await expect(
      controller.execute(OPERATIONS.SELECT, { tabId, ref: 'ref_region', value: 'eu-west' })
    ).resolves.toMatchObject({
      ok: true,
      result: { selected: true, ref: 'ref_region', value: 'eu-west' },
    });
    await expect(
      controller.execute(OPERATIONS.PRESS, {
        tabId,
        ref: 'ref_environment',
        key: 'ArrowDown',
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { pressed: true, ref: 'ref_environment', key: 'ArrowDown' },
    });
    expect(adapter.select).toHaveBeenCalledWith('ref_region', 'eu-west');
    expect(adapter.press).toHaveBeenCalledWith('ref_environment', 'ArrowDown');
  });

  test('routes controlled downloads through the download boundary with execution context', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });
    const download = jest.fn(async () => ({
      artifact: {
        artifactId: 'artifact_1234567890abcdef1234',
        filename: 'report.pdf',
      },
    }));
    controller.setDownloadController({ download, list: jest.fn(() => []) });
    const signal = new AbortController().signal;

    await expect(
      controller.execute(
        OPERATIONS.DOWNLOAD,
        { tabId, ref: 'ref_download' },
        { conversationId: 'conversation_test', signal }
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { artifact: { filename: 'report.pdf' } },
    });
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        pageAdapter: adapter,
        ref: 'ref_download',
        conversationId: 'conversation_test',
        signal,
      })
    );
  });

  test('routes a selected file through the controlled upload boundary', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });
    const upload = jest.fn(async () => ({
      attached: true,
      upload: { filename: 'report.pdf', bytes: 2048, state: 'attached' },
    }));
    controller.setUploadController({ upload });
    const signal = new AbortController().signal;

    await expect(
      controller.execute(OPERATIONS.UPLOAD, { tabId, ref: 'ref_upload' }, { signal })
    ).resolves.toMatchObject({
      ok: true,
      result: { upload: { filename: 'report.pdf', state: 'attached' } },
    });
    expect(upload).toHaveBeenCalledWith({ pageAdapter: adapter, ref: 'ref_upload', signal });
  });

  test('treats the legacy wallet action operation as an ordinary page click', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter();
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });
    adapter.click.mockResolvedValue({ clicked: true });

    await expect(
      controller.execute(OPERATIONS.WALLET_ACTION, { tabId, ref: 'ref_wallet' })
    ).resolves.toMatchObject({
      ok: true,
      result: { clicked: true },
    });
    expect(adapter.click).toHaveBeenCalledWith('ref_wallet');
  });

  test('routes direct wallet transfers through the privileged main-process boundary', async () => {
    const { controller, authorize } = createController();
    const transfer = jest.fn(async () => ({
      wallet: { action: 'broadcast', transactionHash: '0xtransaction' },
    }));
    controller.setWalletTransferController({ transfer });
    const requestApproval = jest.fn();
    const signal = new AbortController().signal;

    await expect(
      controller.execute(
        OPERATIONS.WALLET_TRANSFER,
        { recipient: 'meinhard.eth', amount: '0.01', asset: 'GNO', chainId: 100 },
        { requestApproval, signal }
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { wallet: { action: 'broadcast', transactionHash: '0xtransaction' } },
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: OPERATIONS.WALLET_TRANSFER,
        tab: null,
      })
    );
    expect(transfer).toHaveBeenCalledWith(
      { recipient: 'meinhard.eth', amount: '0.01', asset: 'GNO', chainId: 100 },
      { requestApproval, signal }
    );
  });

  test('routes node inspection through a read-only main-process boundary', async () => {
    const { controller, authorize } = createController();
    const status = jest.fn(async () => ({
      nodes: [{ id: 'ant', state: 'running', ready: true }],
      summary: { total: 1, ready: 1, active: 1, disabled: 0, attention: 0 },
    }));
    controller.setNodeController({ status });

    await expect(controller.execute(OPERATIONS.NODE_STATUS)).resolves.toMatchObject({
      ok: true,
      result: {
        nodes: [{ id: 'ant', state: 'running', ready: true }],
        summary: { total: 1, ready: 1 },
      },
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ operation: OPERATIONS.NODE_STATUS, input: {}, tab: null })
    );
    expect(status).toHaveBeenCalledTimes(1);
  });

  test('routes diagnostics through a separate approved main-process boundary', async () => {
    const { controller } = createController();
    const requestApproval = jest.fn(async () => 'approved');
    const diagnostics = {
      node: jest.fn(async () => ({ scope: 'node', service: 'ipfs' })),
      app: jest.fn(async () => ({ scope: 'app' })),
    };
    controller.setDiagnosticsController(diagnostics);

    await expect(
      controller.execute(
        OPERATIONS.NODE_DIAGNOSTICS,
        { service: 'ipfs' },
        { requestApproval }
      )
    ).resolves.toMatchObject({ ok: true, result: { scope: 'node', service: 'ipfs' } });
    expect(diagnostics.node).toHaveBeenCalledWith(
      { service: 'ipfs', maxLines: 200, maxBytes: 49_152 },
      { requestApproval }
    );
    await controller.execute(OPERATIONS.APP_DIAGNOSTICS, {}, { requestApproval });
    expect(diagnostics.app).toHaveBeenCalledWith(
      { maxLines: 200, maxBytes: 49_152 },
      { requestApproval }
    );
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

  test('creates and closes pages only through the configured lifecycle', async () => {
    const { controller } = createController();
    const adapter = new FakePageAdapter('https://created.example/');
    const lifecycle = {
      createPage: jest.fn(async () => controller.registerPage(adapter, { kind: 'headless' })),
      closePage: jest.fn(async (tabId) => {
        controller.unregisterPage(tabId);
        return true;
      }),
      focusPage: jest.fn(async () => true),
    };
    controller.setPageLifecycle(lifecycle);

    const created = await controller.execute(OPERATIONS.CREATE_TAB, {
      url: 'https://created.example/',
    });
    const tabId = created.result.tab.tabId;
    expect(created).toMatchObject({
      ok: true,
      result: {
        tab: { tabId, kind: 'headless', url: 'https://created.example/', available: true },
      },
    });
    expect(lifecycle.createPage).toHaveBeenCalledWith('https://created.example/', {
      openerTabId: null,
    });
    await expect(controller.execute(OPERATIONS.FOCUS_TAB, { tabId })).resolves.toMatchObject({
      ok: true,
      result: { focused: true, tabId },
    });
    expect(lifecycle.focusPage).toHaveBeenCalledWith(tabId);

    await expect(controller.execute(OPERATIONS.CLOSE_TAB, { tabId })).resolves.toMatchObject({
      ok: true,
      tabId,
      result: { closed: true, tabId },
    });
    expect(lifecycle.closePage).toHaveBeenCalledWith(tabId);
    await expect(controller.execute(OPERATIONS.LIST_TABS)).resolves.toMatchObject({
      result: { tabs: [] },
    });

    controller.setPageLifecycle(null);
    await expect(
      controller.execute(OPERATIONS.CREATE_TAB, { url: 'https://unavailable.example/' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.CAPABILITY_UNAVAILABLE },
    });
  });
});
