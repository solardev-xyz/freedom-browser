'use strict';

const { ERROR_CODES } = require('../automation/contract/errors');
const {
  AGENT_ERROR_CODES,
  AGENT_EVENT_VERSION,
  MAX_AGENT_PROMPT_LENGTH,
  FreedomAgentError,
  FreedomAgentService,
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
  const prompts = [];
  let listener;
  const unsubscribe = jest.fn();
  const session = {
    subscribe: jest.fn((nextListener) => {
      listener = nextListener;
      return unsubscribe;
    }),
    prompt: jest.fn(() => {
      const turn = prompts.length === 0 ? prompt : createDeferred();
      prompts.push(turn);
      return turn.promise;
    }),
    abort: jest.fn(async () => prompts.at(-1)?.resolve()),
    dispose: jest.fn(),
  };
  return {
    session,
    prompt,
    prompts,
    unsubscribe,
    emit: (event) => listener?.(event),
  };
}

function createService(fakeSession, overrides = {}) {
  const dependencies = {
    controller: { execute: jest.fn() },
    loadSdk: jest.fn(async () => ({ kind: 'sdk' })),
    createControllerScope: jest.fn(async ({ controller }) => ({
      ...controller,
      prepareResume: jest.fn(async () => ({ ok: true })),
    })),
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
    expect(dependencies.createControllerScope).toHaveBeenCalledWith({
      controller: dependencies.controller,
      tabId: 'tab_assigned',
      navigationScope: 'site',
      requestApproval: expect.any(Function),
    });
    expect(dependencies.createTools).toHaveBeenCalledWith({
      sdk: { kind: 'sdk' },
      controller: expect.objectContaining({ execute: dependencies.controller.execute }),
      tabId: 'tab_assigned',
      navigationScope: 'site',
      onToolOutcome: expect.any(Function),
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
        navigationScope: 'site',
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

  test('builds research runs with a read-only cross-site policy prompt', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);

    await service.start(startOptions({ navigationScope: 'research' }));

    expect(dependencies.createControllerScope).toHaveBeenCalledWith({
      controller: dependencies.controller,
      tabId: 'tab_assigned',
      navigationScope: 'research',
      requestApproval: expect.any(Function),
    });
    expect(dependencies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringMatching(/read-only web research scope[\s\S]*must not click/),
      })
    );

    fake.prompt.resolve();
    await service.waitForIdle();
  });

  test('pauses a run for a bounded approval and accepts only its exact decision', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    const requestApproval = dependencies.createControllerScope.mock.calls[0][0].requestApproval;
    const decision = requestApproval({
      action: 'form_submission',
      operation: 'browser_click',
      origin: 'https://trusted.example',
      label: 'Submit registration',
    });
    const approval = events.at(-1);

    expect(approval).toMatchObject({
      type: 'approval_requested',
      action: 'form_submission',
      operation: 'browser_click',
      origin: 'https://trusted.example',
      label: 'Submit registration',
    });
    expect(service.getState()).toMatchObject({
      pendingApproval: { approvalId: approval.approvalId },
    });
    await expect(service.decideApproval('run_other', approval.approvalId, true)).resolves.toBe(
      false
    );
    await expect(service.decideApproval('run_test', approval.approvalId, true)).resolves.toBe(true);
    await expect(decision).resolves.toBe('approved');
    expect(events.at(-1)).toMatchObject({
      type: 'approval_resolved',
      approvalId: approval.approvalId,
      decision: 'approved',
    });

    await service.stop('run_test');
    await service.waitForIdle();
  });

  test('declines a pending approval when the user takes over', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    await service.start(startOptions());
    const requestApproval = dependencies.createControllerScope.mock.calls[0][0].requestApproval;
    const decision = requestApproval({ action: 'form_submission' });

    await service.stop('run_test');

    await expect(decision).resolves.toBe('declined');
    await service.waitForIdle();
  });

  test('pauses and resumes the same Pi session with a mandatory recovery prompt', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());
    const scopedController = dependencies.createTools.mock.calls[0][0].controller;
    const requestApproval = dependencies.createControllerScope.mock.calls[0][0].requestApproval;
    const approvalDecision = requestApproval({ action: 'form_submission' });

    await expect(service.pause('run_other')).resolves.toBe(false);
    await expect(service.pause('run_test')).resolves.toBe(true);

    await expect(approvalDecision).resolves.toBe('withdrawn');
    expect(events.map((event) => event.type)).toContain('run_pausing');
    expect(events.at(-1)).toMatchObject({ type: 'run_paused' });
    expect(events.find((event) => event.type === 'approval_resolved')).toMatchObject({
      decision: 'withdrawn',
    });
    expect(service.getState()).toMatchObject({ status: 'paused', runId: 'run_test' });
    expect(fake.session.dispose).not.toHaveBeenCalled();

    await expect(service.resume('run_test')).resolves.toBe(true);

    expect(scopedController.prepareResume).toHaveBeenCalledTimes(1);
    expect(fake.session.prompt).toHaveBeenCalledTimes(2);
    expect(fake.session.prompt.mock.calls[1][0]).toContain(
      'Treat the current page as authoritative'
    );
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      'run_resuming',
      'run_resumed',
    ]);
    expect(service.getState()).toMatchObject({ status: 'running' });

    fake.prompts[1].resolve();
    await service.waitForIdle();
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'completed' });
    expect(fake.session.dispose).toHaveBeenCalledTimes(1);
  });

  test('refuses resume after the controlled tab leaves its starting site', async () => {
    const fake = createFakeSession();
    const prepareResume = jest.fn(async () => ({
      ok: false,
      error: { code: ERROR_CODES.POLICY_DENIED },
    }));
    const { service } = createService(fake, {
      createControllerScope: jest.fn(async ({ controller }) => ({
        ...controller,
        prepareResume,
      })),
    });
    await service.start(startOptions());
    await service.pause('run_test');

    await expect(service.resume('run_test')).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.RESUME_SCOPE_CHANGED,
    });
    expect(service.getState()).toMatchObject({ status: 'paused' });
    expect(fake.session.prompt).toHaveBeenCalledTimes(1);

    await service.stop('run_test');
    await service.waitForIdle();
  });

  test('take over remains terminal while paused', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());
    await service.pause('run_test');

    await expect(service.stop('run_test')).resolves.toBe(true);
    await service.waitForIdle();

    expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'cancelled' });
    expect(fake.session.dispose).toHaveBeenCalledTimes(1);
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
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    dependencies.createTools.mock.calls[0][0].onToolOutcome({
      toolCallId: 'call_1',
      operation: 'browser_snapshot',
      status: 'failed',
      errorCode: ERROR_CODES.TAB_NOT_FOUND,
    });
    fake.emit({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'browser_snapshot',
      result: {
        content: [{ type: 'text', text: 'Pi may render this however it wants' }],
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

  test('does not terminate the task when a created tab disappears', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    await service.start(startOptions());

    dependencies.createTools.mock.calls[0][0].onToolOutcome({
      toolCallId: 'call_created_missing',
      operation: 'browser_snapshot',
      status: 'failed',
      tabId: 'tab_created',
      errorCode: ERROR_CODES.TAB_NOT_FOUND,
    });

    expect(fake.session.abort).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ status: 'running', tabId: 'tab_assigned' });
    await service.stop('run_test');
  });

  test('aborts immediately with a distinct failure when the controlled tab closes', async () => {
    const fake = createFakeSession();
    let lifecycleListener;
    const unsubscribeTabLifecycle = jest.fn();
    const subscribeTabLifecycle = jest.fn((listener) => {
      lifecycleListener = listener;
      return unsubscribeTabLifecycle;
    });
    const { service } = createService(fake, { subscribeTabLifecycle });
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    lifecycleListener({ type: 'tab_closed', tabId: 'tab_other', kind: 'desktop' });
    expect(fake.session.abort).not.toHaveBeenCalled();
    lifecycleListener({ type: 'tab_closed', tabId: 'tab_assigned', kind: 'desktop' });
    await service.waitForIdle();

    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({
      version: AGENT_EVENT_VERSION,
      sequence: 2,
      runId: 'run_test',
      type: 'run_finished',
      status: 'failed',
      error: {
        code: AGENT_ERROR_CODES.TAB_CLOSED,
        message: 'The controlled browser tab was closed',
      },
    });

    await service.dispose();
    expect(unsubscribeTabLifecycle).toHaveBeenCalledTimes(1);
  });

  test('closing the controlled tab is terminal while the run is paused', async () => {
    const fake = createFakeSession();
    let lifecycleListener;
    const { service } = createService(fake, {
      subscribeTabLifecycle: (listener) => {
        lifecycleListener = listener;
        return jest.fn();
      },
    });
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());
    await service.pause('run_test');

    lifecycleListener({ type: 'tab_closed', tabId: 'tab_assigned', kind: 'desktop' });
    await service.waitForIdle();

    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      status: 'failed',
      error: { code: AGENT_ERROR_CODES.TAB_CLOSED },
    });
    expect(fake.session.dispose).toHaveBeenCalledTimes(1);
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
    await expect(
      service.start(startOptions({ navigationScope: 'unrestricted' }))
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
      normalizePiEvent(
        {
          type: 'tool_execution_end',
          toolCallId: 'call_1',
          toolName: 'browser_snapshot',
          result: { content: [{ type: 'text', text: 'unstructured wording' }] },
          isError: true,
        },
        { status: 'failed', errorCode: ERROR_CODES.POLICY_DENIED }
      )
    ).toMatchObject({ status: 'failed', errorCode: ERROR_CODES.POLICY_DENIED });
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
