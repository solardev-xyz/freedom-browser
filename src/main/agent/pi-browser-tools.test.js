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
      errorCode: ERROR_CODES.TAB_NOT_FOUND,
    });
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
