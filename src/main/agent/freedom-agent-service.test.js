'use strict';

const { ERROR_CODES } = require('../automation/contract/errors');
const {
  AGENT_ERROR_CODES,
  AGENT_EVENT_VERSION,
  MAX_AGENT_PROMPT_LENGTH,
  FreedomAgentError,
  FreedomAgentService,
  extractToolErrorCode,
  normalizePiEvent,
} = require('./freedom-agent-service');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFakeSession() {
  const prompt = createDeferred();
  let listener;
  const unsubscribe = jest.fn();
  const session = {
    subscribe: jest.fn((nextListener) => {
      listener = nextListener;
      return unsubscribe;
    }),
    prompt: jest.fn(() => prompt.promise),
    abort: jest.fn(async () => prompt.resolve()),
    dispose: jest.fn(),
  };
  return {
    session,
    prompt,
    unsubscribe,
    emit: (event) => listener?.(event),
  };
}

function createService(fakeSession, overrides = {}) {
  const dependencies = {
    controller: { execute: jest.fn() },
    loadSdk: jest.fn(async () => ({ kind: 'sdk' })),
    createTools: jest.fn(async () => [{ name: 'browser_snapshot' }]),
    createSession: jest.fn(async () => ({ session: fakeSession.session })),
    runIdFactory: jest.fn(() => 'run_test'),
    ...overrides,
  };
  return { service: new FreedomAgentService(dependencies), dependencies };
}

function startOptions(overrides = {}) {
  return {
    prompt: 'Summarize this page',
    tabId: 'tab_assigned',
    model: { id: 'model_test', provider: 'test' },
    modelRuntime: { kind: 'model-runtime' },
    ...overrides,
  };
}

describe('FreedomAgentService', () => {
  test('builds one isolated run and emits normalized lifecycle events', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));

    await expect(service.start(startOptions({ thinkingLevel: 'low' }))).resolves.toEqual({
      runId: 'run_test',
    });
    expect(dependencies.createTools).toHaveBeenCalledWith({
      sdk: { kind: 'sdk' },
      controller: dependencies.controller,
      tabId: 'tab_assigned',
    });
    expect(dependencies.createSession).toHaveBeenCalledWith({
      sdk: { kind: 'sdk' },
      model: { id: 'model_test', provider: 'test' },
      modelRuntime: { kind: 'model-runtime' },
      thinkingLevel: 'low',
      customTools: [{ name: 'browser_snapshot' }],
    });
    expect(fake.session.prompt).toHaveBeenCalledWith('Summarize this page', {
      expandPromptTemplates: false,
      source: 'interactive',
    });

    fake.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Summary' },
    });
    fake.emit({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'browser_snapshot',
      args: { untrusted: 'not forwarded' },
    });
    fake.emit({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'browser_snapshot',
      result: { content: [{ type: 'text', text: '{"large":"result"}' }] },
      isError: false,
    });
    fake.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    fake.prompt.resolve();
    await service.waitForIdle();

    expect(events).toEqual([
      {
        version: AGENT_EVENT_VERSION,
        sequence: 1,
        runId: 'run_test',
        type: 'run_started',
        tabId: 'tab_assigned',
      },
      {
        version: AGENT_EVENT_VERSION,
        sequence: 2,
        runId: 'run_test',
        type: 'assistant_text_delta',
        text: 'Summary',
      },
      {
        version: AGENT_EVENT_VERSION,
        sequence: 3,
        runId: 'run_test',
        type: 'tool_started',
        toolCallId: 'call_1',
        operation: 'browser_snapshot',
      },
      {
        version: AGENT_EVENT_VERSION,
        sequence: 4,
        runId: 'run_test',
        type: 'tool_finished',
        toolCallId: 'call_1',
        operation: 'browser_snapshot',
        status: 'succeeded',
      },
      {
        version: AGENT_EVENT_VERSION,
        sequence: 5,
        runId: 'run_test',
        type: 'run_finished',
        status: 'completed',
      },
    ]);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fake.session.dispose).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({ status: 'idle' });
  });

  test('enforces single-run ownership', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    await service.start(startOptions());

    await expect(service.start(startOptions())).rejects.toMatchObject({
      name: 'FreedomAgentError',
      code: AGENT_ERROR_CODES.BUSY,
    });

    await service.stop('run_test');
    await service.waitForIdle();
  });

  test('stops the matching run and reports cancellation', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    await expect(service.stop('run_stale')).resolves.toBe(false);
    await expect(service.stop('run_test')).resolves.toBe(true);
    await service.waitForIdle();

    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'cancelled' });
  });

  test('fails closed when the assigned tab disappears', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    fake.emit({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'browser_snapshot',
      result: {
        content: [
          { type: 'text', text: `[${ERROR_CODES.TAB_NOT_FOUND}] Automation tab not found` },
        ],
      },
      isError: true,
    });
    await service.waitForIdle();

    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    expect(events.at(-2)).toMatchObject({
      type: 'tool_finished',
      status: 'failed',
      errorCode: ERROR_CODES.TAB_NOT_FOUND,
    });
    expect(events.at(-1)).toEqual({
      version: AGENT_EVENT_VERSION,
      sequence: 3,
      runId: 'run_test',
      type: 'run_finished',
      status: 'failed',
      error: {
        code: AGENT_ERROR_CODES.TAB_UNAVAILABLE,
        message: 'The assigned browser tab is no longer available',
      },
    });
  });

  test('redacts provider failures from terminal events', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    fake.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'Authorization failed for sk-secret-key',
      },
    });
    fake.prompt.resolve();
    await service.waitForIdle();

    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      status: 'failed',
      error: {
        code: AGENT_ERROR_CODES.PROVIDER_ERROR,
        message: 'The model provider request failed',
      },
    });
    expect(JSON.stringify(events)).not.toContain('sk-secret-key');
  });

  test('redacts prompt rejection details', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    fake.prompt.reject(new Error('Request header contained sk-secret-key'));
    await service.waitForIdle();

    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      status: 'failed',
      error: { code: AGENT_ERROR_CODES.PROVIDER_ERROR },
    });
    expect(JSON.stringify(events)).not.toContain('sk-secret-key');
  });

  test('reports and redacts session initialization failures', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake, {
      createSession: jest.fn(async () => {
        throw new Error('Failed while using sk-secret-key');
      }),
    });
    const events = [];
    service.subscribe((event) => events.push(event));

    await expect(service.start(startOptions())).rejects.toEqual(
      new FreedomAgentError(
        AGENT_ERROR_CODES.SESSION_START_FAILED,
        'The agent session could not be started'
      )
    );
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      status: 'failed',
      error: { code: AGENT_ERROR_CODES.SESSION_START_FAILED },
    });
    expect(JSON.stringify(events)).not.toContain('sk-secret-key');
  });

  test('disposes an active run and rejects future work', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    await service.start(startOptions());

    await service.dispose();

    expect(service.getState()).toEqual({ status: 'disposed' });
    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    expect(fake.session.dispose).toHaveBeenCalledTimes(1);
    await expect(service.start(startOptions())).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.DISPOSED,
    });
  });

  test('validates bounded prompts before creating a run', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);

    await expect(service.start(startOptions({ prompt: ' '.repeat(3) }))).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.INVALID_ARGUMENT,
    });
    await expect(
      service.start(startOptions({ prompt: 'x'.repeat(MAX_AGENT_PROMPT_LENGTH + 1) }))
    ).rejects.toMatchObject({ code: AGENT_ERROR_CODES.INVALID_ARGUMENT });
    expect(dependencies.loadSdk).not.toHaveBeenCalled();
  });

  test('normalizes only the safe event subset and known tool errors', () => {
    expect(
      normalizePiEvent({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 2,
        delayMs: 500,
        errorMessage: 'secret provider detail',
      })
    ).toEqual({ type: 'run_retrying', attempt: 1, maxAttempts: 2, delayMs: 500 });
    expect(normalizePiEvent({ type: 'message_end', message: { secret: true } })).toBeNull();
    expect(
      extractToolErrorCode({
        content: [{ type: 'text', text: `[${ERROR_CODES.POLICY_DENIED}] Not granted` }],
      })
    ).toBe(ERROR_CODES.POLICY_DENIED);
    expect(
      extractToolErrorCode({ content: [{ type: 'text', text: '[PROVIDER_KEY] secret' }] })
    ).toBeUndefined();
  });

  test('isolates subscriber failures', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe(() => {
      throw new Error('broken chrome subscriber');
    });
    service.subscribe((event) => events.push(event));

    await service.start(startOptions());
    fake.prompt.resolve();
    await service.waitForIdle();

    expect(events.map((event) => event.type)).toEqual(['run_started', 'run_finished']);
  });
});
