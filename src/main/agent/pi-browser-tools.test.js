'use strict';

const { OPERATIONS, MAX_WAIT_TIMEOUT_MS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');
const { AutomationController } = require('../automation/automation-controller');
const {
  FreedomBrowserToolError,
  TOOL_SPEC_BY_NAME,
  createFreedomBrowserTools,
} = require('./pi-browser-tools');

function createSdk() {
  const SessionManager = jest.fn();
  const SettingsManager = jest.fn();
  return {
    createAgentSession: jest.fn(),
    createExtensionRuntime: jest.fn(),
    defineTool: jest.fn((tool) => tool),
    ModelRuntime: jest.fn(),
    SessionManager,
    SettingsManager,
  };
}

function successEnvelope(result = {}) {
  return {
    ok: true,
    runtimeId: 'runtime_test',
    contextId: 'context_test',
    tabId: 'tab_assigned',
    navigationId: 4,
    result,
  };
}

describe('Pi browser tool adapter', () => {
  test('defines only the supported canonical, sequential tools', async () => {
    const sdk = createSdk();
    const controller = { execute: jest.fn() };
    const tools = await createFreedomBrowserTools({ sdk, controller, tabId: 'tab_assigned' });

    expect(tools.map((tool) => tool.name)).toEqual([
      OPERATIONS.LIST_TABS,
      OPERATIONS.CREATE_TAB,
      OPERATIONS.GET_TAB,
      OPERATIONS.FOCUS_TAB,
      OPERATIONS.CLOSE_TAB,
      OPERATIONS.SNAPSHOT,
      OPERATIONS.NAVIGATE,
      OPERATIONS.CLICK,
      OPERATIONS.TYPE,
      OPERATIONS.SELECT,
      OPERATIONS.PRESS,
      OPERATIONS.UPLOAD,
      OPERATIONS.DOWNLOAD,
      OPERATIONS.WALLET_ACTION,
      OPERATIONS.LIST_DOWNLOADS,
      OPERATIONS.WAIT,
      OPERATIONS.STOP_LOADING,
    ]);
    expect(tools.every((tool) => tool.executionMode === 'sequential')).toBe(true);
    expect(tools.some((tool) => tool.name === OPERATIONS.SCREENSHOT)).toBe(false);
    expect(tools.some((tool) => tool.name === OPERATIONS.LIST_TABS)).toBe(true);
  });

  test('keeps the assigned tab ID out of model-visible schemas', async () => {
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller: { execute: jest.fn() },
      tabId: 'tab_assigned',
    });

    for (const tool of tools) {
      expect(tool.parameters.additionalProperties).toBe(false);
      if (![OPERATIONS.FOCUS_TAB, OPERATIONS.CLOSE_TAB].includes(tool.name)) {
        expect(tool.parameters.properties).not.toHaveProperty('tabId');
      }
    }
    expect(TOOL_SPEC_BY_NAME.get(OPERATIONS.WAIT).parameters).toMatchObject({
      properties: {
        condition: { enum: ['load', 'navigation', 'text', 'url'] },
        timeoutMs: { minimum: 1, maximum: MAX_WAIT_TIMEOUT_MS },
      },
      required: ['condition'],
    });
    expect(TOOL_SPEC_BY_NAME.get(OPERATIONS.PRESS).parameters.properties.key.enum).toContain(
      'Enter'
    );
  });

  test('describes task tabs as a cross-site workspace capability', async () => {
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller: { execute: jest.fn() },
      tabId: 'tab_assigned',
    });

    expect(tools.find((tool) => tool.name === OPERATIONS.CREATE_TAB)?.description).toContain(
      'supported web or distributed-web URL'
    );
  });

  test('targets newly created and explicitly focused task tabs without exposing tab IDs broadly', async () => {
    const controller = {
      execute: jest.fn(async (operation, input) => {
        if (operation === OPERATIONS.CREATE_TAB) {
          return successEnvelope({
            tab: { tabId: 'tab_created', url: input.url },
            activeTabId: 'tab_created',
          });
        }
        return successEnvelope(
          operation === OPERATIONS.FOCUS_TAB ? { focused: true, tabId: input.tabId } : {}
        );
      }),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
    });
    const create = tools.find((tool) => tool.name === OPERATIONS.CREATE_TAB);
    const snapshot = tools.find((tool) => tool.name === OPERATIONS.SNAPSHOT);
    const focus = tools.find((tool) => tool.name === OPERATIONS.FOCUS_TAB);

    await create.execute('call_create', { url: 'https://example.test/research' });
    await snapshot.execute('call_created_snapshot', {});
    await focus.execute('call_focus', { tabId: 'tab_assigned' });
    await snapshot.execute('call_start_snapshot', {});

    expect(controller.execute.mock.calls).toEqual([
      [OPERATIONS.CREATE_TAB, { tabId: 'tab_assigned', url: 'https://example.test/research' }],
      [OPERATIONS.SNAPSHOT, { tabId: 'tab_created' }],
      [OPERATIONS.FOCUS_TAB, { tabId: 'tab_assigned' }],
      [OPERATIONS.SNAPSHOT, { tabId: 'tab_assigned' }],
    ]);
  });

  test('tracks controller fallback and can create after every task tab is closed', async () => {
    let activeTabId = 'tab_assigned';
    const controller = {
      getActiveTabId: jest.fn(() => activeTabId),
      execute: jest.fn(async (operation, input) => {
        if (operation === OPERATIONS.CREATE_TAB) {
          activeTabId = 'tab_fresh';
          return successEnvelope({
            tab: { tabId: 'tab_fresh', url: input.url },
            activeTabId,
          });
        }
        return successEnvelope({});
      }),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
    });
    const snapshot = tools.find((tool) => tool.name === OPERATIONS.SNAPSHOT);
    const create = tools.find((tool) => tool.name === OPERATIONS.CREATE_TAB);

    activeTabId = 'tab_remaining';
    await snapshot.execute('call_fallback', {});
    activeTabId = null;
    await create.execute('call_fresh', { url: 'https://fresh.example/' });
    await snapshot.execute('call_fresh_snapshot', {});

    expect(controller.execute.mock.calls).toEqual([
      [OPERATIONS.SNAPSHOT, { tabId: 'tab_remaining' }],
      [OPERATIONS.CREATE_TAB, { tabId: null, url: 'https://fresh.example/' }],
      [OPERATIONS.SNAPSHOT, { tabId: 'tab_fresh' }],
    ]);
  });

  test('creates the first task tab from an initially empty workspace', async () => {
    let activeTabId = null;
    const controller = {
      getActiveTabId: jest.fn(() => activeTabId),
      execute: jest.fn(async (operation, input) => {
        if (operation === OPERATIONS.CREATE_TAB) {
          activeTabId = 'tab_fresh';
          return successEnvelope({
            tab: { tabId: activeTabId, url: input.url },
            activeTabId,
          });
        }
        return successEnvelope({});
      }),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: null,
    });
    const create = tools.find((tool) => tool.name === OPERATIONS.CREATE_TAB);
    const snapshot = tools.find((tool) => tool.name === OPERATIONS.SNAPSHOT);

    await create.execute('call_create', { url: 'https://fresh.example/' });
    await snapshot.execute('call_snapshot', {});

    expect(controller.execute.mock.calls).toEqual([
      [OPERATIONS.CREATE_TAB, { tabId: null, url: 'https://fresh.example/' }],
      [OPERATIONS.SNAPSHOT, { tabId: 'tab_fresh' }],
    ]);
  });

  test('routes tool execution through the controller with the pinned tab', async () => {
    const envelope = successEnvelope({ clicked: true, ref: 'ref_7' });
    const controller = { execute: jest.fn(async () => envelope) };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
    });
    const click = tools.find((tool) => tool.name === OPERATIONS.CLICK);

    const result = await click.execute('call_1', { ref: 'ref_7', tabId: 'tab_attacker' });

    expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.CLICK, {
      tabId: 'tab_assigned',
      ref: 'ref_7',
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      details: { operation: OPERATIONS.CLICK, envelope },
    });
  });

  test('returns a safe download artifact and forwards bounded progress', async () => {
    const artifact = {
      artifactId: 'artifact_1234567890abcdef1234',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      bytes: 2048,
      state: 'completed',
      sourceOrigin: 'https://files.example',
      location: 'downloads',
      available: true,
    };
    const controller = {
      execute: jest.fn(async (_operation, _input, execution) => {
        execution.onProgress({ receivedBytes: 1024, totalBytes: 2048, state: 'in_progress' });
        return successEnvelope({ artifact });
      }),
    };
    const onToolOutcome = jest.fn();
    const onToolProgress = jest.fn();
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
      onToolOutcome,
      onToolProgress,
    });
    const download = tools.find((tool) => tool.name === OPERATIONS.DOWNLOAD);

    const result = await download.execute(
      'call_download',
      { ref: 'ref_download' },
      new AbortController().signal
    );

    expect(controller.execute).toHaveBeenCalledWith(
      OPERATIONS.DOWNLOAD,
      { tabId: 'tab_assigned', ref: 'ref_download' },
      expect.objectContaining({ signal: expect.any(Object), onProgress: expect.any(Function) })
    );
    expect(JSON.parse(result.content[0].text).result.artifact).toEqual(artifact);
    expect(result.content[0].text).not.toContain('/Users/');
    expect(onToolProgress).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'call_download', operation: OPERATIONS.DOWNLOAD })
    );
    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ artifact, status: 'succeeded' })
    );
  });

  test('reports structured outcomes independently of Pi error rendering', async () => {
    const onToolOutcome = jest.fn();
    const controller = {
      execute: jest.fn(async () => ({
        ok: false,
        error: {
          code: ERROR_CODES.TAB_NOT_FOUND,
          message: 'Rendered wording can change',
          retryable: false,
        },
      })),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
      onToolOutcome,
    });
    const snapshot = tools.find((tool) => tool.name === OPERATIONS.SNAPSHOT);

    await expect(snapshot.execute('call_structured', {})).rejects.toThrow();
    expect(onToolOutcome).toHaveBeenCalledWith({
      toolCallId: 'call_structured',
      operation: OPERATIONS.SNAPSHOT,
      status: 'failed',
      tabId: 'tab_assigned',
      pageId: 'tab_assigned',
      errorCode: ERROR_CODES.TAB_NOT_FOUND,
    });
  });

  test('tells the model not to retry a download cancelled by the user', async () => {
    const onToolOutcome = jest.fn();
    const controller = {
      execute: jest.fn(async () => ({
        ok: false,
        error: {
          code: ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER,
          message:
            'The user cancelled this download. Do not retry it unless the user explicitly asks again.',
          retryable: false,
          suggestedAction: 'Acknowledge the cancellation and continue without this file.',
        },
      })),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
      onToolOutcome,
    });
    const download = tools.find((tool) => tool.name === OPERATIONS.DOWNLOAD);

    await expect(download.execute('call_cancelled', { ref: 'ref_download' })).rejects.toMatchObject({
      code: ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER,
      retryable: false,
      suggestedAction: expect.stringContaining('Acknowledge'),
      message: expect.stringContaining('Do not retry'),
    });
    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call_cancelled',
        operation: OPERATIONS.DOWNLOAD,
        status: 'failed',
        errorCode: ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER,
      })
    );
  });

  test('reports only redacted browser metadata in successful progress receipts', async () => {
    const onToolOutcome = jest.fn();
    const controller = {
      execute: jest.fn(async () =>
        successEnvelope({
          url: 'https://accounts.example/private?token=secret#details',
          title: 'Private account',
          text: 'sensitive page contents',
          elements: [],
        })
      ),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
      onToolOutcome,
    });
    const snapshot = tools.find((tool) => tool.name === OPERATIONS.SNAPSHOT);

    await snapshot.execute('call_receipt', {});

    expect(onToolOutcome).toHaveBeenCalledWith({
      toolCallId: 'call_receipt',
      operation: OPERATIONS.SNAPSHOT,
      status: 'succeeded',
      tabId: 'tab_assigned',
      pageId: 'tab_assigned',
      origin: 'https://accounts.example',
    });
    expect(JSON.stringify(onToolOutcome.mock.calls)).not.toMatch(
      /token|secret|Private account|sensitive page contents/
    );
  });

  test('retains the canonical controller policy boundary', async () => {
    const authorize = jest.fn(async () => ({ allowed: true }));
    const controller = new AutomationController({
      runtimeId: 'runtime_test',
      contextId: 'context_test',
      tabIdFactory: () => 'tab_assigned',
      policyController: { authorize },
    });
    const adapter = {
      getState: () => ({ url: 'https://example.test/', navigationId: 1, available: true }),
      navigate: jest.fn(),
      snapshot: jest.fn(async () => ({ text: 'Fixture', elements: [] })),
      click: jest.fn(),
      type: jest.fn(),
      screenshot: jest.fn(),
      wait: jest.fn(),
      stopLoading: jest.fn(),
    };
    const tabId = controller.registerPage(adapter, { kind: 'desktop' });
    const tools = await createFreedomBrowserTools({ sdk: createSdk(), controller, tabId });
    const snapshot = tools.find((tool) => tool.name === OPERATIONS.SNAPSHOT);

    await expect(snapshot.execute('call_1', {})).resolves.toMatchObject({
      details: {
        operation: OPERATIONS.SNAPSHOT,
        envelope: { ok: true, result: { text: 'Fixture', elements: [] } },
      },
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: OPERATIONS.SNAPSHOT,
        input: { tabId: 'tab_assigned' },
        tab: expect.objectContaining({ tabId: 'tab_assigned', kind: 'desktop' }),
      })
    );
  });

  test.each([
    ERROR_CODES.POLICY_DENIED,
    ERROR_CODES.APPROVAL_REQUIRED,
    ERROR_CODES.STALE_ELEMENT_REFERENCE,
  ])('converts %s envelopes into typed Pi tool failures', async (code) => {
    const controller = {
      execute: jest.fn(async () => ({
        ok: false,
        error: {
          code,
          message: 'Operation refused',
          retryable: code === ERROR_CODES.STALE_ELEMENT_REFERENCE,
          suggestedAction: 'Take a new snapshot',
        },
      })),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
    });
    const snapshot = tools.find((tool) => tool.name === OPERATIONS.SNAPSHOT);

    await expect(snapshot.execute('call_1', {})).rejects.toMatchObject({
      name: 'FreedomBrowserToolError',
      code,
      retryable: code === ERROR_CODES.STALE_ELEMENT_REFERENCE,
      suggestedAction: 'Take a new snapshot',
    });
  });

  test('redacts unexpected controller exceptions', async () => {
    const controller = {
      execute: jest.fn(async () => {
        throw new Error('provider key or implementation secret');
      }),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
    });
    const snapshot = tools.find((tool) => tool.name === OPERATIONS.SNAPSHOT);

    let failure;
    try {
      await snapshot.execute('call_1', {});
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FreedomBrowserToolError);
    expect(failure).toMatchObject({ code: ERROR_CODES.INTERNAL_ERROR });
    expect(failure.message).not.toContain('secret');
  });

  test('cancels a blocking operation through canonical stop-loading', async () => {
    let settleWait;
    const controller = {
      execute: jest.fn((operation) => {
        if (operation === OPERATIONS.WAIT) {
          return new Promise((resolve) => {
            settleWait = resolve;
          });
        }
        if (operation === OPERATIONS.STOP_LOADING) {
          settleWait({
            ok: false,
            error: { code: ERROR_CODES.USER_CANCELLED, message: 'Wait cancelled', retryable: false },
          });
          return Promise.resolve(successEnvelope({ stopped: true }));
        }
        return Promise.resolve(successEnvelope());
      }),
    };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
    });
    const wait = tools.find((tool) => tool.name === OPERATIONS.WAIT);
    const abortController = new AbortController();

    const execution = wait.execute('call_1', { condition: 'text', text: 'Ready' }, abortController.signal);
    abortController.abort();

    await expect(execution).rejects.toMatchObject({ code: ERROR_CODES.USER_CANCELLED });
    expect(controller.execute).toHaveBeenNthCalledWith(1, OPERATIONS.WAIT, {
      tabId: 'tab_assigned',
      condition: 'text',
      text: 'Ready',
    });
    expect(controller.execute).toHaveBeenNthCalledWith(2, OPERATIONS.STOP_LOADING, {
      tabId: 'tab_assigned',
    });
  });

  test('does not start an already-aborted blocking operation', async () => {
    const controller = { execute: jest.fn() };
    const tools = await createFreedomBrowserTools({
      sdk: createSdk(),
      controller,
      tabId: 'tab_assigned',
    });
    const navigate = tools.find((tool) => tool.name === OPERATIONS.NAVIGATE);
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      navigate.execute('call_1', { url: 'https://example.test/' }, abortController.signal)
    ).rejects.toMatchObject({ code: ERROR_CODES.USER_CANCELLED });
    expect(controller.execute).not.toHaveBeenCalled();
  });

  test('requires a controller and an exact pinned tab ID', async () => {
    await expect(createFreedomBrowserTools({ sdk: createSdk(), tabId: 'tab_1' })).rejects.toThrow(
      'require an automation controller'
    );
    await expect(
      createFreedomBrowserTools({
        sdk: createSdk(),
        controller: { execute: jest.fn() },
        tabId: ' tab_1 ',
      })
    ).rejects.toThrow('cannot contain surrounding whitespace');
  });
});
