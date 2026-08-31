'use strict';

const { ERROR_CODES } = require('../automation/contract/errors');
const { OPERATIONS } = require('../automation/contract/operations');
const {
  AGENT_ERROR_CODES,
  AGENT_EVENT_VERSION,
  MAX_AGENT_PROMPT_LENGTH,
  FreedomAgentError,
  FreedomAgentService,
  normalizePiEvent,
  providerFailureFromPiMessage,
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
    steer: jest.fn(async () => {}),
    clearQueue: jest.fn(() => ({ steering: [], followUp: [] })),
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
      getWorkspaceState: jest.fn(() => ({
        tabIds: ['tab_assigned', 'tab_research'],
        activeTabId: 'tab_research',
      })),
      setApprovalMode: jest.fn(),
      prepareResume: jest.fn(async () => ({ ok: true })),
    })),
    createTools: jest.fn(async () => [{ name: 'browser_snapshot' }]),
    createSession: jest.fn(async () => ({ session: fakeSession.session })),
    effectClassifier: { classify: jest.fn(async () => ({ effect: 'read', confidence: 1 })) },
    interactionClassifier: {
      classify: jest.fn(async () => ({
        kind: 'ordinary',
        confidence: 1,
        summary: 'Open details.',
        uncertainties: [],
      })),
    },
    runIdFactory: jest.fn(() => 'run_test'),
    conversationIdFactory: jest.fn(() => 'conversation_test'),
    now: jest.fn(() => 1_000),
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
    createWorkspacePage: jest.fn(async () => 'tab_fresh'),
    ...overrides,
  };
}

function createHistoryStore(overrides = {}) {
  return {
    createSession: jest.fn(),
    startTurn: jest.fn(),
    finishTurn: jest.fn(),
    updateTurnGuidance: jest.fn(),
    listSessions: jest.fn(() => []),
    getSession: jest.fn(() => null),
    updateApprovalMode: jest.fn((_conversationId, approvalMode) => ({ approvalMode })),
    renameSession: jest.fn(() => null),
    deleteSession: jest.fn(() => false),
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
      conversationId: 'conversation_test',
    });
    expect(dependencies.createControllerScope).toHaveBeenCalledWith({
      controller: dependencies.controller,
      tabId: 'tab_assigned',
      navigationScope: 'workspace',
      approvalMode: 'every_interaction',
      createWorkspacePage: expect.any(Function),
      onWorkspaceTabCreated: expect.any(Function),
      requestApproval: expect.any(Function),
      classifyEffect: expect.any(Function),
      classifyInteraction: expect.any(Function),
      transferOwnerId: 'conversation_test',
    });
    expect(dependencies.createTools).toHaveBeenCalledWith({
      sdk: { kind: 'sdk' },
      controller: expect.objectContaining({ execute: dependencies.controller.execute }),
      tabId: 'tab_assigned',
      visionEnabled: false,
      onToolOutcome: expect.any(Function),
      onToolProgress: expect.any(Function),
    });
    expect(dependencies.createSession).toHaveBeenCalledWith({
      sdk: { kind: 'sdk' },
      model: { id: 'model_test', provider: 'test' },
      modelRuntime: { kind: 'model-runtime' },
      thinkingLevel: 'low',
      customTools: [{ name: 'browser_snapshot' }],
      enableBuiltInSkills: true,
      systemPrompt: expect.stringContaining('You are Freedom Agent inside Freedom Browser'),
    });
    expect(service.getWorkspaceState()).toEqual({
      tabIds: ['tab_assigned', 'tab_research'],
      activeTabId: 'tab_research',
    });
    expect(fake.session.prompt).toHaveBeenCalledWith(expect.stringContaining('Summarize this page'), {
      expandPromptTemplates: false,
      source: 'interactive',
    });
    expect(fake.session.prompt.mock.calls[0][0]).toContain(
      'Freedom approval policy for this turn'
    );

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
        conversationId: 'conversation_test',
        runId: 'run_test',
        type: 'run_started',
        tabId: 'tab_assigned',
        approvalMode: 'every_interaction',
        userText: 'Summarize this page',
      },
      {
        version: AGENT_EVENT_VERSION,
        sequence: 2,
        conversationId: 'conversation_test',
        runId: 'run_test',
        type: 'assistant_text_delta',
        text: 'Summary',
      },
      {
        version: AGENT_EVENT_VERSION,
        sequence: 3,
        conversationId: 'conversation_test',
        runId: 'run_test',
        type: 'tool_started',
        toolCallId: 'call_1',
        operation: 'browser_snapshot',
        intent: 'Reading the current page',
        label: 'Read the current page',
        effect: 'observed',
      },
      {
        version: AGENT_EVENT_VERSION,
        sequence: 4,
        conversationId: 'conversation_test',
        runId: 'run_test',
        type: 'tool_finished',
        toolCallId: 'call_1',
        operation: 'browser_snapshot',
        status: 'succeeded',
        intent: 'Reading the current page',
        label: 'Read the current page',
        effect: 'observed',
      },
      {
        version: AGENT_EVENT_VERSION,
        sequence: 5,
        conversationId: 'conversation_test',
        runId: 'run_test',
        type: 'run_finished',
        status: 'completed',
        durationMs: 0,
        actionCount: 1,
        failedActionCount: 0,
        outcome: {
          kind: 'completed',
          verification: 'browser_observed',
          tone: 'success',
          headline: 'Browser state inspected',
          detail: 'Freedom recorded 1 successful browser action. No browser change was made.',
          destinations: [],
          counts: {
            successful: 1,
            failed: 0,
            changed: 0,
            observed: 1,
            pages: 0,
            approvals: { requested: 0, approved: 0, declined: 0, withdrawn: 0 },
          },
        },
      },
    ]);
    expect(fake.unsubscribe).not.toHaveBeenCalled();
    expect(fake.session.dispose).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({
      status: 'ready',
      conversationId: 'conversation_test',
      transcript: [
        {
          runId: 'run_test',
          userText: 'Summarize this page',
          assistantText: 'Summary',
          status: 'completed',
          durationMs: 0,
        },
      ],
    });
  });

  test('tells Pi about the allow-interaction policy for the current turn', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);

    await service.start(startOptions({ approvalMode: 'allow_website_interactions' }));

    expect(dependencies.createControllerScope).toHaveBeenCalledWith({
      controller: dependencies.controller,
      tabId: 'tab_assigned',
      navigationScope: 'workspace',
      approvalMode: 'allow_website_interactions',
      createWorkspacePage: expect.any(Function),
      onWorkspaceTabCreated: expect.any(Function),
      requestApproval: expect.any(Function),
      classifyEffect: expect.any(Function),
      classifyInteraction: expect.any(Function),
      transferOwnerId: 'conversation_test',
    });
    expect(dependencies.createSession.mock.calls[0][0].systemPrompt).toEqual(
      expect.stringContaining('You are Freedom Agent inside Freedom Browser')
    );
    expect(fake.session.prompt.mock.calls[0][0]).toContain(
      'Freedom allows ordinary website interactions without asking each time'
    );

    fake.prompt.resolve();
    await service.waitForIdle();
  });

  test('binds consequential-action classification to the current turn and model runtime', async () => {
    const fake = createFakeSession();
    const interactionClassifier = {
      classify: jest.fn(async () => ({
        kind: 'consequential',
        confidence: 0.98,
        summary: 'Publish the comment.',
        uncertainties: [],
      })),
    };
    const { service, dependencies } = createService(fake, { interactionClassifier });
    const events = [];
    service.subscribe((event) => events.push(event));
    const options = startOptions({
      prompt: 'Publish my response',
      approvalMode: 'sensitive_actions',
      model: { id: 'gpt-test', provider: 'openai' },
      modelRuntime: { kind: 'isolated-runtime' },
    });

    await service.start(options);
    expect(fake.session.prompt.mock.calls[0][0]).toContain(
      'Freedom will independently classify the intended consequence'
    );
    expect(fake.session.prompt.mock.calls[0][0]).toContain(
      'include a brief literal intent'
    );

    const classifyInteraction =
      dependencies.createControllerScope.mock.calls[0][0].classifyInteraction;
    const proposed = {
      action: { operation: 'browser_click', intent: 'Publish the comment' },
      trustedContext: { origin: 'https://community.example' },
      untrustedContext: { label: 'Publish' },
    };
    await expect(classifyInteraction(proposed)).resolves.toMatchObject({
      kind: 'consequential',
    });
    expect(interactionClassifier.classify).toHaveBeenCalledWith(
      {
        ...proposed,
        userRequest: 'Publish my response',
        guidance: [],
      },
      { model: options.model, modelRuntime: options.modelRuntime }
    );

    const requestApproval = dependencies.createControllerScope.mock.calls[0][0].requestApproval;
    const decision = requestApproval({
      action: 'browser_interaction',
      operation: 'browser_click',
      origin: 'https://community.example/post/1',
      label: 'Publish',
      interaction: await interactionClassifier.classify.mock.results[0].value,
    });
    expect(events.at(-1)).toMatchObject({
      type: 'approval_requested',
      action: 'browser_interaction',
      interaction: {
        kind: 'consequential',
        confidence: 0.98,
        summary: 'Publish the comment.',
        uncertainties: [],
      },
    });
    await service.decideApproval('run_test', events.at(-1).approvalId, true);
    await expect(decision).resolves.toBe('approved');

    fake.prompt.resolve();
    await service.waitForIdle();
  });

  test('enables visual page observation only for a model declaring image input', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);

    await service.start(
      startOptions({ model: { id: 'vision_model', provider: 'test', input: ['text', 'image'] } })
    );

    expect(dependencies.createTools).toHaveBeenCalledWith(
      expect.objectContaining({ visionEnabled: true })
    );
    fake.prompt.resolve();
    await service.waitForIdle();
  });

  test('consumes opaque attachment selections and exposes scoped tools without model-visible paths', async () => {
    const fake = createFakeSession();
    const attachmentStore = {
      consume: jest.fn(async () => [
        {
          resourceId: 'attachment_aaaaaaaaaaaaaaaaaaaa',
          kind: 'file',
          name: 'notes.txt',
          category: 'text',
          bytes: 12,
          available: true,
        },
      ]),
      listResources: jest.fn(async () => []),
      read: jest.fn(),
      revokeFolder: jest.fn(async () => true),
      deleteConversation: jest.fn(async () => {}),
    };
    const createAttachmentTools = jest.fn(async () => [
      { name: 'attachment_list' },
      { name: 'attachment_read' },
    ]);
    const { service, dependencies } = createService(fake, {
      attachmentStore,
      createAttachmentTools,
    });

    await service.start(
      startOptions({
        attachmentIds: ['selection_aaaaaaaaaaaaaaaaaaaa'],
        attachmentOwnerId: '41',
      })
    );

    expect(attachmentStore.consume).toHaveBeenCalledWith(
      '41',
      ['selection_aaaaaaaaaaaaaaaaaaaa'],
      'conversation_test'
    );
    expect(createAttachmentTools).toHaveBeenCalledWith({
      sdk: { kind: 'sdk' },
      store: attachmentStore,
      conversationId: 'conversation_test',
      visionEnabled: false,
    });
    expect(dependencies.createSession.mock.calls[0][0].customTools).toEqual([
      { name: 'browser_snapshot' },
      { name: 'attachment_list' },
      { name: 'attachment_read' },
    ]);
    expect(fake.session.prompt.mock.calls[0][0]).toContain('attachment_aaaaaaaaaaaaaaaaaaaa');
    expect(fake.session.prompt.mock.calls[0][0]).not.toContain('/Users/');
    expect(service.getState().resources).toEqual([
      expect.objectContaining({ name: 'notes.txt', category: 'text' }),
    ]);

    fake.prompt.resolve();
    await service.waitForIdle();
  });

  test('passes selected images natively only to a vision-capable Pi session', async () => {
    const fake = createFakeSession();
    const attachmentStore = {
      consume: jest.fn(async () => [
        {
          resourceId: 'attachment_bbbbbbbbbbbbbbbbbbbb',
          kind: 'file',
          name: 'diagram.png',
          category: 'image',
          mimeType: 'image/png',
          bytes: 3,
          available: true,
        },
      ]),
      listResources: jest.fn(async () => []),
      read: jest.fn(async () => ({
        kind: 'image',
        name: 'diagram.png',
        mimeType: 'image/png',
        data: Buffer.from('png'),
      })),
      revokeFolder: jest.fn(async () => true),
      deleteConversation: jest.fn(async () => {}),
    };
    const { service } = createService(fake, {
      attachmentStore,
      createAttachmentTools: jest.fn(async () => []),
    });

    await service.start(
      startOptions({
        model: { id: 'vision_model', provider: 'test', input: ['text', 'image'] },
        attachmentIds: ['selection_bbbbbbbbbbbbbbbbbbbb'],
        attachmentOwnerId: '41',
      })
    );

    expect(fake.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining('attachment_bbbbbbbbbbbbbbbbbbbb'),
      expect.objectContaining({
        images: [{ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }],
      })
    );
    fake.prompt.resolve();
    await service.waitForIdle();
  });

  test('revokes a live folder resource and broadcasts the remaining conversation sources', async () => {
    const fake = createFakeSession();
    const folderId = `folder_${'d'.repeat(20)}`;
    const attachmentStore = {
      consume: jest.fn(async () => [
        {
          resourceId: folderId,
          kind: 'folder',
          name: 'Bug reports',
          category: 'folder',
          available: true,
        },
      ]),
      listResources: jest.fn(async () => []),
      read: jest.fn(),
      revokeFolder: jest.fn(async () => true),
      deleteConversation: jest.fn(async () => {}),
    };
    const { service } = createService(fake, {
      attachmentStore,
      createAttachmentTools: jest.fn(async () => []),
    });
    const events = [];
    service.subscribe((event) => events.push(event));

    const started = await service.start(
      startOptions({
        attachmentIds: ['selection_dddddddddddddddddddd'],
        attachmentOwnerId: '41',
      })
    );
    fake.prompt.resolve();
    await service.waitForIdle();

    await expect(service.revokeAttachment(started.conversationId, folderId)).resolves.toMatchObject({
      resource: { resourceId: folderId, available: false },
      resources: [],
    });
    expect(attachmentStore.revokeFolder).toHaveBeenCalledWith(started.conversationId, folderId);
    expect(service.getState().resources).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'conversation_resources_changed',
      conversationId: started.conversationId,
      resources: [],
    });
  });

  test('cleans attachment snapshots if startup fails before a conversation exists', async () => {
    const fake = createFakeSession();
    const attachmentStore = {
      consume: jest.fn(async () => [
        {
          resourceId: 'attachment_cccccccccccccccccccc',
          kind: 'file',
          name: 'notes.txt',
          category: 'text',
          bytes: 12,
          available: true,
        },
      ]),
      listResources: jest.fn(async () => []),
      read: jest.fn(),
      revokeFolder: jest.fn(async () => true),
      deleteConversation: jest.fn(async () => {}),
    };
    const { service } = createService(fake, {
      attachmentStore,
      loadSdk: jest.fn(async () => {
        throw new Error('SDK unavailable');
      }),
    });

    await expect(
      service.start(
        startOptions({
          attachmentIds: ['selection_cccccccccccccccccccc'],
          attachmentOwnerId: '41',
        })
      )
    ).rejects.toMatchObject({ code: 'SESSION_START_FAILED' });
    expect(attachmentStore.deleteConversation).toHaveBeenCalledWith('conversation_test');
  });

  test('starts with an empty workspace when no user page is shared', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);

    await service.start(startOptions({ tabId: null }));

    expect(dependencies.createControllerScope).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: null })
    );
    expect(dependencies.createTools).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: null })
    );
    expect(dependencies.createSession.mock.calls[0][0].systemPrompt).toContain(
      'No existing browser page was shared with this conversation'
    );
    expect(service.getState()).toMatchObject({ tabId: null });

    fake.prompt.resolve();
    await service.waitForIdle();
  });

  test('reuses one Pi session and task workspace across conversational turns', async () => {
    const fake = createFakeSession();
    const runIdFactory = jest
      .fn()
      .mockReturnValueOnce('run_first')
      .mockReturnValueOnce('run_follow_up');
    const { service, dependencies } = createService(fake, { runIdFactory });

    await service.start(startOptions({ prompt: 'Find the project name' }));
    fake.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'The project is Freedom.' },
    });
    fake.prompt.resolve();
    await service.waitForIdle();

    const scopedController = dependencies.createTools.mock.calls[0][0].controller;
    await expect(
      service.start(
        startOptions({ prompt: 'Now put that project name into the form' })
      )
    ).resolves.toEqual({
      runId: 'run_follow_up',
      conversationId: 'conversation_test',
    });

    expect(dependencies.loadSdk).toHaveBeenCalledTimes(1);
    expect(dependencies.createSession).toHaveBeenCalledTimes(1);
    expect(dependencies.createControllerScope).toHaveBeenCalledTimes(1);
    expect(scopedController.prepareResume).toHaveBeenCalledTimes(1);
    expect(fake.session.prompt).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Now put that project name into the form'),
      {
        expandPromptTemplates: false,
        source: 'interactive',
      }
    );

    fake.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Done.' },
    });
    fake.prompts[1].resolve();
    await service.waitForIdle();

    expect(service.getState()).toMatchObject({
      status: 'ready',
      conversationId: 'conversation_test',
      transcript: [
        {
          runId: 'run_first',
          userText: 'Find the project name',
          assistantText: 'The project is Freedom.',
          status: 'completed',
        },
        {
          runId: 'run_follow_up',
          userText: 'Now put that project name into the form',
          assistantText: 'Done.',
          status: 'completed',
        },
      ],
    });
    expect(fake.session.dispose).not.toHaveBeenCalled();
  });

  test('rebuilds a failed provider session while preserving its browser workspace', async () => {
    const failed = createFakeSession();
    const recovered = createFakeSession();
    const runIdFactory = jest
      .fn()
      .mockReturnValueOnce('run_failed')
      .mockReturnValueOnce('run_retry');
    const createSession = jest
      .fn()
      .mockResolvedValueOnce({ session: failed.session })
      .mockResolvedValueOnce({ session: recovered.session });
    const { service, dependencies } = createService(failed, { createSession, runIdFactory });

    await service.start(startOptions({ prompt: 'Publish this text' }));
    failed.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '503 service unavailable',
      },
    });
    failed.prompt.resolve();
    await service.waitForIdle();

    expect(failed.unsubscribe).toHaveBeenCalledTimes(1);
    expect(failed.session.dispose).toHaveBeenCalledTimes(1);
    expect(service.getState()).toMatchObject({
      status: 'ready',
      runtimeAvailable: false,
      transcript: [{ runId: 'run_failed', status: 'failed' }],
    });

    await expect(service.start(startOptions({ prompt: 'Publish this text' }))).resolves.toEqual({
      runId: 'run_retry',
      conversationId: 'conversation_test',
    });

    expect(dependencies.createControllerScope).toHaveBeenCalledTimes(1);
    const scopedController = dependencies.createTools.mock.calls[0][0].controller;
    expect(scopedController.prepareResume).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[1][0]).toMatchObject({
      restoredTranscript: [expect.objectContaining({ runId: 'run_failed', status: 'failed' })],
    });
    expect(recovered.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining('Publish this text'),
      {
        expandPromptTemplates: false,
        source: 'interactive',
      }
    );

    recovered.prompt.resolve();
    await service.waitForIdle();
    expect(service.getState()).toMatchObject({ status: 'ready', runtimeAvailable: true });
  });

  test('changes approval policy only between turns and records the policy used by each turn', async () => {
    const fake = createFakeSession();
    const historyStore = createHistoryStore();
    const runIdFactory = jest
      .fn()
      .mockReturnValueOnce('run_first')
      .mockReturnValueOnce('run_second');
    const { service, dependencies } = createService(fake, { historyStore, runIdFactory });

    await service.start(startOptions({ prompt: 'Inspect the page' }));
    expect(() =>
      service.updateApprovalMode('conversation_test', 'allow_website_interactions')
    ).toThrow(
      expect.objectContaining({
        code: AGENT_ERROR_CODES.BUSY,
        message: 'Finish the current Agent turn before changing its approval setting',
      })
    );
    fake.prompt.resolve();
    await service.waitForIdle();

    const scopedController = dependencies.createTools.mock.calls[0][0].controller;
    expect(
      service.updateApprovalMode('conversation_test', 'allow_website_interactions')
    ).toEqual({
      conversationId: 'conversation_test',
      approvalMode: 'allow_website_interactions',
    });
    expect(scopedController.setApprovalMode).toHaveBeenCalledWith(
      'allow_website_interactions'
    );
    expect(historyStore.updateApprovalMode).toHaveBeenCalledWith(
      'conversation_test',
      'allow_website_interactions'
    );

    await service.start(
      startOptions({
        prompt: 'Submit the form',
        approvalMode: 'allow_website_interactions',
      })
    );
    expect(fake.session.prompt.mock.calls[1][0]).toContain(
      'Freedom allows ordinary website interactions without asking each time'
    );
    expect(historyStore.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: 'run_second',
        approvalMode: 'allow_website_interactions',
      })
    );
    fake.prompts[1].resolve();
    await service.waitForIdle();

    expect(service.getState()).toMatchObject({
      approvalMode: 'allow_website_interactions',
      transcript: [
        { runId: 'run_first', approvalMode: 'every_interaction' },
        { runId: 'run_second', approvalMode: 'allow_website_interactions' },
      ],
    });
  });

  test('accepts a follow-up after the originally adopted tab closes', async () => {
    const fake = createFakeSession();
    let lifecycleListener;
    const handleTabLifecycle = jest.fn();
    const prepareResume = jest.fn(async () => ({
      ok: true,
      activeTabId: 'tab_remaining',
      workspaceEmpty: false,
    }));
    const { service } = createService(fake, {
      subscribeTabLifecycle: (listener) => {
        lifecycleListener = listener;
        return jest.fn();
      },
      createControllerScope: jest.fn(async ({ controller }) => ({
        ...controller,
        handleTabLifecycle,
        prepareResume,
      })),
    });

    await service.start(startOptions({ prompt: 'Open five articles' }));
    fake.prompt.resolve();
    await service.waitForIdle();
    lifecycleListener({ type: 'tab_closed', tabId: 'tab_assigned', kind: 'desktop' });

    await expect(
      service.start({ prompt: 'Compare the remaining articles', approvalMode: 'every_interaction' })
    ).resolves.toMatchObject({ conversationId: 'conversation_test' });
    expect(handleTabLifecycle).toHaveBeenCalledWith({
      type: 'tab_closed',
      tabId: 'tab_assigned',
      kind: 'desktop',
    });
    expect(prepareResume).toHaveBeenCalledTimes(1);
    fake.prompts[1].resolve();
    await service.waitForIdle();
    expect(service.getState()).toMatchObject({ status: 'ready' });
  });

  test('New chat deselects an idle live conversation without disposing it', async () => {
    const fake = createFakeSession();
    const historyStore = createHistoryStore();
    const { service } = createService(fake, { historyStore });
    const events = [];
    service.subscribe((event) => events.push(event));

    await service.start(startOptions());
    await expect(service.clearConversation()).resolves.toBe(false);
    fake.prompt.resolve();
    await service.waitForIdle();

    await expect(service.clearConversation()).resolves.toBe(true);
    expect(fake.session.dispose).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ status: 'idle' });
    expect(events.at(-1)).toMatchObject({
      type: 'conversation_cleared',
      conversationId: 'conversation_test',
    });
    await expect(service.openConversation('conversation_test')).resolves.toMatchObject({
      status: 'ready',
      conversationId: 'conversation_test',
      runtimeAvailable: true,
    });
    expect(historyStore.getSession).not.toHaveBeenCalled();
  });

  test('retains live session workspaces across switches and transfers claimed tabs to the user', async () => {
    const first = createFakeSession();
    const second = createFakeSession();
    const scopes = new Map();
    const createControllerScope = jest.fn(async ({ controller, tabId }) => {
      const tabIds = [tabId];
      const scope = {
        ...controller,
        getWorkspaceState: jest.fn(() => ({
          tabIds: [...tabIds],
          activeTabId: tabIds.at(-1) || null,
        })),
        prepareResume: jest.fn(async () => ({ ok: true })),
        releaseTab: jest.fn((candidate) => {
          const index = tabIds.indexOf(candidate);
          if (index === -1) return false;
          tabIds.splice(index, 1);
          return true;
        }),
        addTab: (candidate) => tabIds.push(candidate),
      };
      scopes.set(tabId, scope);
      return scope;
    });
    const historyStore = createHistoryStore({ deleteSession: jest.fn(() => true) });
    const { service, dependencies } = createService(first, {
      historyStore,
      createControllerScope,
      createSession: jest
        .fn()
        .mockResolvedValueOnce({ session: first.session })
        .mockResolvedValueOnce({ session: second.session }),
      conversationIdFactory: jest
        .fn()
        .mockReturnValueOnce('conversation_first')
        .mockReturnValueOnce('conversation_second'),
      runIdFactory: jest
        .fn()
        .mockReturnValueOnce('run_first')
        .mockReturnValueOnce('run_second'),
    });
    const events = [];
    service.subscribe((event) => events.push(event));

    await service.start(startOptions({ tabId: 'tab_user_first' }));
    const firstCreated = dependencies.createControllerScope.mock.calls[0][0].onWorkspaceTabCreated;
    scopes.get('tab_user_first').addTab('tab_agent_first');
    firstCreated('tab_agent_first');
    first.prompt.resolve();
    await service.waitForIdle();
    await service.clearConversation();

    await service.start(startOptions({ tabId: 'tab_user_second' }));
    const secondCreated = dependencies.createControllerScope.mock.calls[1][0].onWorkspaceTabCreated;
    scopes.get('tab_user_second').addTab('tab_agent_second');
    secondCreated('tab_agent_second');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'workspace_changed', runId: 'run_first' }),
        expect.objectContaining({ type: 'workspace_changed', runId: 'run_second' }),
      ])
    );
    second.prompt.resolve();
    await service.waitForIdle();

    await expect(service.openConversation('conversation_first')).resolves.toMatchObject({
      conversationId: 'conversation_first',
      runtimeAvailable: true,
    });
    expect(service.getWorkspaceState()).toEqual({
      tabIds: ['tab_user_first', 'tab_agent_first'],
      activeTabId: 'tab_agent_first',
    });
    expect(first.session.dispose).not.toHaveBeenCalled();
    expect(service.listAgentTabs()).toEqual([
      {
        tabId: 'tab_agent_first',
        provenance: 'agent',
        custody: 'agent',
        conversationId: 'conversation_first',
      },
      {
        tabId: 'tab_agent_second',
        provenance: 'agent',
        custody: 'agent',
        conversationId: 'conversation_second',
      },
    ]);

    await expect(service.claimTab('tab_agent_first')).resolves.toBe(true);
    expect(scopes.get('tab_user_first').releaseTab).toHaveBeenCalledWith('tab_agent_first');
    expect(service.getWorkspaceState()).toEqual({
      tabIds: ['tab_user_first'],
      activeTabId: 'tab_user_first',
    });
    expect(service.listAgentTabs().map((record) => record.tabId)).toEqual(['tab_agent_second']);

    await service.openConversation('conversation_second');
    expect(service.getWorkspaceState()).toEqual({
      tabIds: ['tab_user_second', 'tab_agent_second'],
      activeTabId: 'tab_agent_second',
    });
    await expect(service.deleteConversation('conversation_first')).resolves.toBe(true);
    expect(first.session.dispose).toHaveBeenCalledTimes(1);
    expect(second.session.dispose).not.toHaveBeenCalled();
  });

  test('persists the visible conversation lifecycle without raw Pi events', async () => {
    const fake = createFakeSession();
    const historyStore = createHistoryStore();
    const { service } = createService(fake, { historyStore });

    await service.start(startOptions({ prompt: 'Research this page' }));
    fake.emit({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'browser_snapshot',
      args: { pageContents: 'not persisted' },
    });
    fake.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Finished.' },
    });
    fake.prompt.resolve();
    await service.waitForIdle();

    expect(historyStore.createSession).toHaveBeenCalledWith({
      conversationId: 'conversation_test',
      title: 'Research this page',
      approvalMode: 'every_interaction',
      providerId: 'test',
      modelId: 'model_test',
      thinkingLevel: undefined,
      createdAt: 1_000,
    });
    expect(historyStore.startTurn).toHaveBeenCalledWith({
      conversationId: 'conversation_test',
      runId: 'run_test',
      position: 0,
      userText: 'Research this page',
      approvalMode: 'every_interaction',
      startedAt: 1_000,
    });
    expect(historyStore.finishTurn).toHaveBeenCalledWith({
      conversationId: 'conversation_test',
      runId: 'run_test',
      assistantText: 'Finished.',
      status: 'completed',
      durationMs: 0,
      activity: [
        {
          toolCallId: 'call_1',
          operation: 'browser_snapshot',
          status: 'running',
          label: 'Read the current page',
          intent: 'Reading the current page',
          effect: 'observed',
        },
      ],
      guidance: [],
      error: undefined,
    });
    expect(JSON.stringify(historyStore.finishTurn.mock.calls)).not.toContain(
      'pageContents'
    );
  });

  test('opens a stored conversation dormant and rebuilds safe Pi context on follow-up', async () => {
    const fake = createFakeSession();
    const stored = {
      conversationId: 'conversation_saved',
      title: 'Saved research',
      approvalMode: 'every_interaction',
      transcript: [
        {
          runId: 'run_saved',
          userText: 'Research this topic',
          assistantText: 'I found three sources.',
          status: 'completed',
          startedAt: 500,
          durationMs: 200,
          activity: [],
        },
      ],
    };
    const historyStore = createHistoryStore({
      getSession: jest.fn(() => stored),
    });
    const { service, dependencies } = createService(fake, {
      historyStore,
      runIdFactory: jest.fn(() => 'run_followup'),
    });

    await expect(service.openConversation('conversation_saved')).resolves.toMatchObject({
      status: 'ready',
      conversationId: 'conversation_saved',
      title: 'Saved research',
      runtimeAvailable: false,
      transcript: [expect.objectContaining({ runId: 'run_saved' })],
    });
    expect(service.getWorkspaceState()).toEqual({ tabIds: [], activeTabId: null });

    await service.start(
      startOptions({ prompt: 'Continue from there', tabId: 'tab_new' })
    );
    expect(dependencies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        restoredTranscript: [
          expect.objectContaining({
            runId: 'run_saved',
            userText: 'Research this topic',
            assistantText: 'I found three sources.',
          }),
        ],
        systemPrompt: expect.stringContaining('restored from Freedom\'s saved session history'),
      })
    );
    expect(historyStore.createSession).not.toHaveBeenCalled();
    expect(historyStore.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation_saved',
        runId: 'run_followup',
        position: 1,
      })
    );
    fake.prompt.resolve();
    await service.waitForIdle();
    expect(service.getState()).toMatchObject({ runtimeAvailable: true });
  });

  test('lists, renames, and deletes stored conversations while idle', async () => {
    const fake = createFakeSession();
    const summary = { conversationId: 'conversation_saved', title: 'Saved' };
    const historyStore = createHistoryStore({
      listSessions: jest.fn(() => [summary]),
      renameSession: jest.fn(() => ({ ...summary, title: 'Renamed' })),
      deleteSession: jest.fn(() => true),
    });
    const { service } = createService(fake, { historyStore });

    expect(service.listConversations()).toEqual([summary]);
    expect(service.renameConversation('conversation_saved', 'Renamed')).toMatchObject({
      title: 'Renamed',
    });
    await expect(service.deleteConversation('conversation_saved')).resolves.toBe(true);
  });

  test('pauses a run for a bounded approval and accepts only its exact decision', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    fake.emit({
      type: 'tool_execution_start',
      toolCallId: 'call_approval',
      toolName: 'browser_click',
      args: { ref: 'snapshot_ref' },
    });

    const requestApproval = dependencies.createControllerScope.mock.calls[0][0].requestApproval;
    const decision = requestApproval({
      action: 'form_submission',
      operation: 'browser_click',
      origin: 'https://trusted.example',
      destinationOrigin: 'https://submit.example/path?private=yes',
      label: 'Submit registration',
      toolCallId: 'call_approval',
    });
    const approval = events.at(-1);

    expect(approval).toMatchObject({
      type: 'approval_requested',
      action: 'form_submission',
      operation: 'browser_click',
      origin: 'https://trusted.example',
      destinationOrigin: 'https://submit.example',
      label: 'Submit registration',
      toolCallId: 'call_approval',
    });
    expect(service.getState()).toMatchObject({
      pendingApproval: { approvalId: approval.approvalId },
    });
    await expect(service.steer('run_test', 'Do not submit until I confirm')).resolves.toMatchObject({
      text: 'Do not submit until I confirm',
      status: 'queued',
    });
    expect(fake.session.steer).toHaveBeenCalledWith('Do not submit until I confirm');
    expect(service.getState()).toMatchObject({
      pendingApproval: { approvalId: approval.approvalId },
      transcript: [
        expect.objectContaining({
          guidance: [expect.objectContaining({ status: 'queued' })],
        }),
      ],
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
      toolCallId: 'call_approval',
    });
    expect(service.getState()).toMatchObject({
      transcript: [
        expect.objectContaining({
          activity: [
            expect.objectContaining({
              approval: 'approved',
              destinationOrigin: 'https://submit.example',
            }),
          ],
        }),
      ],
    });

    await service.stop('run_test');
    await service.waitForIdle();
  });

  test('discloses raw diagnostics to the selected provider and returns a conversation grant', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(
      startOptions({ model: { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai' } })
    );

    const requestApproval = dependencies.createControllerScope.mock.calls[0][0].requestApproval;
    const decision = requestApproval({
      action: 'diagnostic_data',
      operation: OPERATIONS.NODE_DIAGNOSTICS,
      label: 'Share recent ipfs diagnostics',
      diagnostic: { scope: 'node', service: 'ipfs', maxLines: 50, maxBytes: 8192 },
    });
    const approval = events.at(-1);

    expect(approval).toMatchObject({
      type: 'approval_requested',
      action: 'diagnostic_data',
      operation: OPERATIONS.NODE_DIAGNOSTICS,
      diagnostic: {
        scope: 'node',
        service: 'ipfs',
        maxLines: 50,
        maxBytes: 8192,
        providerId: 'openai',
        providerLabel: 'OpenAI',
        modelId: 'gpt-5.6-sol',
        local: false,
      },
    });
    await expect(
      service.decideApproval('run_test', approval.approvalId, {
        approved: true,
        diagnosticScope: 'conversation',
      })
    ).resolves.toBe(true);
    await expect(decision).resolves.toEqual({
      status: 'approved',
      diagnosticScope: 'conversation',
    });
    expect(JSON.stringify(approval)).not.toMatch(/entries|logs|runtime|statusSnapshot/);

    await service.stop('run_test');
    await service.waitForIdle();
  });

  test('projects a path-free Agent-native approval for public Swarm publishing', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    const requestApproval = dependencies.createControllerScope.mock.calls[0][0].requestApproval;
    const decision = requestApproval({
      action: 'swarm_publish',
      operation: OPERATIONS.SWARM_PUBLISH,
      label: 'website',
      publication: {
        kind: 'folder',
        name: 'website',
        public: true,
        indexDocument: 'index.html',
        sourcePath: '/Users/private/website',
      },
    });
    const approval = events.at(-1);

    expect(approval).toMatchObject({
      type: 'approval_requested',
      action: 'swarm_publish',
      operation: OPERATIONS.SWARM_PUBLISH,
      publication: {
        kind: 'folder',
        name: 'website',
        public: true,
        indexDocument: 'index.html',
      },
    });
    expect(JSON.stringify(approval)).not.toContain('/Users/private');
    await service.decideApproval('run_test', approval.approvalId, true);
    await expect(decision).resolves.toBe('approved');

    await service.stop('run_test');
    await service.waitForIdle();
  });

  test('classifies an exact node request in the isolated model context and exposes a bounded approval', async () => {
    const fake = createFakeSession();
    const effectClassifier = {
      classify: jest.fn(async () => ({
        effect: 'persistent_change',
        confidence: 0.96,
        summary: 'Creates a durable postage batch.',
        resources: ['postage batch'],
        uncertainties: [],
      })),
    };
    const { service, dependencies } = createService(fake, { effectClassifier });
    const events = [];
    service.subscribe((event) => events.push(event));
    const options = startOptions({
      model: { id: 'gpt-5.6-sol', provider: 'openai' },
      modelRuntime: { kind: 'isolated-runtime' },
    });
    await service.start(options);

    const classifyEffect = dependencies.createControllerScope.mock.calls[0][0].classifyEffect;
    const proposed = {
      domain: 'node',
      action: {
        service: 'ant',
        request: { method: 'POST', path: '/stamps/100/20' },
      },
    };
    await expect(classifyEffect(proposed)).resolves.toMatchObject({
      effect: 'persistent_change',
    });
    expect(effectClassifier.classify).toHaveBeenCalledWith(proposed, {
      model: options.model,
      modelRuntime: options.modelRuntime,
    });

    const requestApproval = dependencies.createControllerScope.mock.calls[0][0].requestApproval;
    const decision = requestApproval({
      action: 'node_request',
      operation: OPERATIONS.NODE_REQUEST,
      label: 'POST /stamps/100/20',
      nodeRequest: {
        service: 'ant',
        transport: 'http',
        request: {
          method: 'POST',
          path: '/stamps/100/20',
          headers: { 'content-type': 'application/json' },
          body: '{"immutable":false}',
        },
        effect: 'persistent_change',
        classification: await effectClassifier.classify.mock.results[0].value,
      },
    });
    const approval = events.at(-1);

    expect(approval).toMatchObject({
      type: 'approval_requested',
      action: 'node_request',
      operation: OPERATIONS.NODE_REQUEST,
      nodeRequest: {
        service: 'ant',
        transport: 'http',
        request: {
          method: 'POST',
          path: '/stamps/100/20',
          headers: { 'content-type': 'application/json' },
          body: '{"immutable":false}',
        },
        effect: 'persistent_change',
        classification: {
          summary: 'Creates a durable postage batch.',
          confidence: 0.96,
          uncertainties: [],
        },
        providerLabel: 'OpenAI',
        modelId: 'gpt-5.6-sol',
      },
    });
    await service.decideApproval('run_test', approval.approvalId, true);
    await expect(decision).resolves.toBe('approved');

    const lifecycleDecision = requestApproval({
      action: 'node_lifecycle',
      operation: OPERATIONS.NODE_LIFECYCLE,
      label: 'restart ipfs',
      nodeLifecycle: {
        service: 'ipfs',
        action: 'restart',
        beforeState: 'running',
        effect: 'reversible_admin',
        classification: {
          effect: 'reversible_admin',
          summary: 'Restarts one Freedom-managed node.',
          confidence: 0.99,
          uncertainties: [],
        },
      },
    });
    const lifecycleApproval = events.at(-1);
    expect(lifecycleApproval).toMatchObject({
      type: 'approval_requested',
      action: 'node_lifecycle',
      operation: OPERATIONS.NODE_LIFECYCLE,
      nodeLifecycle: {
        service: 'ipfs',
        action: 'restart',
        beforeState: 'running',
        effect: 'reversible_admin',
        providerLabel: 'OpenAI',
        modelId: 'gpt-5.6-sol',
      },
    });
    await service.decideApproval('run_test', lifecycleApproval.approvalId, true);
    await expect(lifecycleDecision).resolves.toBe('approved');

    await service.stop('run_test');
    await service.waitForIdle();
  });

  test('delivers native Pi steering in the retained run and projects its lifecycle', async () => {
    const fake = createFakeSession();
    const historyStore = createHistoryStore();
    const { service } = createService(fake, {
      historyStore,
      guidanceIdFactory: jest.fn(() => 'guidance_test'),
    });
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    await expect(service.steer('run_test', 'Focus on primary sources')).resolves.toEqual({
      guidanceId: 'guidance_test',
      text: 'Focus on primary sources',
      status: 'queued',
      createdAt: 1_000,
    });
    expect(fake.session.steer).toHaveBeenCalledWith('Focus on primary sources');
    expect(events.at(-1)).toMatchObject({
      type: 'guidance_queued',
      guidance: { guidanceId: 'guidance_test', status: 'queued' },
    });

    fake.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Focus on primary sources' }],
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'guidance_applying',
      guidanceId: 'guidance_test',
    });
    fake.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    expect(events.at(-1)).toMatchObject({
      type: 'guidance_applied',
      guidanceId: 'guidance_test',
    });
    expect(historyStore.updateTurnGuidance).toHaveBeenLastCalledWith({
      conversationId: 'conversation_test',
      runId: 'run_test',
      guidance: [
        {
          guidanceId: 'guidance_test',
          text: 'Focus on primary sources',
          status: 'applied',
          createdAt: 1_000,
        },
      ],
    });

    fake.prompt.resolve();
    await service.waitForIdle();
    expect(service.getState()).toMatchObject({
      transcript: [
        expect.objectContaining({
          guidance: [expect.objectContaining({ status: 'applied' })],
        }),
      ],
    });
  });

  test('holds a provider request from the actively controlled tab in Agent-native approval', async () => {
    const fake = createFakeSession();
    const externalBarriers = [];
    const scopedController = {
      execute: jest.fn(),
      prepareResume: jest.fn(async () => ({ ok: true })),
      getActiveTabId: jest.fn(() => 'tab_assigned'),
      getWorkspaceState: jest.fn(() => ({
        tabIds: ['tab_assigned'],
        activeTabId: 'tab_assigned',
      })),
      setExternalApprovalBarrier: jest.fn((promise) => externalBarriers.push(promise)),
    };
    const walletController = {
      handleRequest: jest.fn(async (context, payload) => {
        const decision = await context.requestApproval({
          action: 'wallet_connection',
          operation: OPERATIONS.WALLET_ACTION,
          tabId: context.tabId,
          origin: payload.permissionKey,
          destinationOrigin: payload.permissionKey,
          label: 'Connect a wallet account',
          wallet: {
            kind: 'connection',
            chainId: 100,
            chainName: 'Gnosis',
            wallets: [
              {
                index: 0,
                name: 'Main Wallet',
                address: '0x1111111111111111111111111111111111111111',
                type: 'mnemonic',
              },
            ],
            defaultWalletIndex: 0,
            requiresUnlock: false,
          },
        });
        expect(decision).toEqual({ status: 'approved', walletIndex: 0 });
        return {
          handled: true,
          result: ['0x1111111111111111111111111111111111111111'],
          receipt: {
            wallet: {
              action: 'connected',
              origin: payload.permissionKey,
              chainId: 100,
              account: '0x1111111111111111111111111111111111111111',
            },
          },
        };
      }),
    };
    const { service } = createService(fake, {
      controller: {
        execute: jest.fn(),
        getPageState: jest.fn(() => ({
          tabId: 'tab_assigned',
          url: 'https://app.example/swap',
          navigationId: 4,
        })),
      },
      createControllerScope: jest.fn(async () => scopedController),
      walletController,
    });
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    const providerResponse = service.handleWalletRequest('tab_assigned', {
      method: 'eth_requestAccounts',
      params: [],
      displayUrl: 'https://app.example/swap',
      permissionKey: 'https://app.example',
      chainId: 100,
    });
    await Promise.resolve();
    await Promise.resolve();

    const approval = events.find((event) => event.type === 'approval_requested');
    expect(approval).toMatchObject({
      action: 'wallet_connection',
      operation: OPERATIONS.WALLET_ACTION,
      origin: 'https://app.example',
    });
    expect(externalBarriers).toHaveLength(1);
    await service.decideApproval('run_test', approval.approvalId, {
      approved: true,
      walletIndex: 0,
    });
    await expect(providerResponse).resolves.toEqual({
      handled: true,
      result: ['0x1111111111111111111111111111111111111111'],
    });
    expect(fake.session.steer).toHaveBeenCalledWith(
      expect.stringContaining('Freedom wallet event (trusted browser result)')
    );
    expect(events.filter((event) => event.type === 'tool_started').at(-1)).toMatchObject({
      operation: OPERATIONS.WALLET_ACTION,
    });
    expect(events.filter((event) => event.type === 'tool_finished').at(-1)).toMatchObject({
      operation: OPERATIONS.WALLET_ACTION,
      status: 'succeeded',
    });

    fake.prompt.resolve();
    await service.waitForIdle();
  });

  test('leaves wallet requests from inactive or unrelated tabs to the human wallet flow', async () => {
    const fake = createFakeSession();
    const walletController = { handleRequest: jest.fn() };
    const { service } = createService(fake, { walletController });

    await expect(
      service.handleWalletRequest('tab_assigned', { method: 'eth_requestAccounts' })
    ).resolves.toEqual({ handled: false });
    await service.start(startOptions());
    await expect(
      service.handleWalletRequest('tab_assigned', { method: 'eth_requestAccounts' })
    ).resolves.toEqual({ handled: false });
    expect(walletController.handleRequest).not.toHaveBeenCalled();

    fake.prompt.resolve();
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
    const cancelAgentDownloads = jest.fn();
    const { service, dependencies } = createService(fake, { cancelAgentDownloads });
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
    expect(cancelAgentDownloads).not.toHaveBeenCalled();

    await expect(service.resume('run_test')).resolves.toBe(true);

    expect(scopedController.prepareResume).toHaveBeenCalledTimes(1);
    expect(fake.session.prompt).toHaveBeenCalledTimes(2);
    expect(fake.session.prompt.mock.calls[1][0]).toContain('browser workspace');
    expect(fake.session.prompt.mock.calls[1][0]).toContain('If no task tab remains');
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      'run_resuming',
      'run_resumed',
    ]);
    expect(service.getState()).toMatchObject({ status: 'running' });

    fake.prompts[1].resolve();
    await service.waitForIdle();
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'completed' });
    expect(fake.session.dispose).not.toHaveBeenCalled();
  });

  test('retains queued steering across Pause and resumes with additional guidance', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake, {
      guidanceIdFactory: jest
        .fn()
        .mockReturnValueOnce('guidance_running')
        .mockReturnValueOnce('guidance_resume'),
    });
    await service.start(startOptions());
    await service.steer('run_test', 'Do not submit yet');
    fake.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Do not submit yet' }],
      },
    });
    expect(service.getState().transcript[0].guidance[0].status).toBe('applying');

    await expect(service.pause('run_test')).resolves.toBe(true);
    expect(fake.session.clearQueue).toHaveBeenCalledTimes(1);
    expect(service.getState().transcript[0].guidance[0].status).toBe('queued');
    await expect(service.resume('run_test', 'I have logged in; continue')).resolves.toBe(true);

    const resumePrompt = fake.session.prompt.mock.calls[1][0];
    expect(resumePrompt).toContain('browser workspace');
    expect(resumePrompt).toContain('Do not submit yet');
    expect(resumePrompt).toContain('I have logged in; continue');
    expect(service.getState()).toMatchObject({
      transcript: [
        expect.objectContaining({
          guidance: [
            expect.objectContaining({ guidanceId: 'guidance_running', status: 'applying' }),
            expect.objectContaining({ guidanceId: 'guidance_resume', status: 'applying' }),
          ],
        }),
      ],
    });

    fake.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    fake.prompts[1].resolve();
    await service.waitForIdle();
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
    expect(fake.session.dispose).not.toHaveBeenCalled();
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
    const cancelAgentDownloads = jest.fn(() => 1);
    const { service } = createService(fake, { cancelAgentDownloads });
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    await expect(service.stop('run_stale')).resolves.toBe(false);
    await expect(service.stop('run_test')).resolves.toBe(true);
    await service.waitForIdle();

    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    expect(cancelAgentDownloads).toHaveBeenCalledWith('conversation_test');
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'cancelled' });
  });

  test('returns a missing-tab tool failure to the model without killing the conversation', async () => {
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
    expect(fake.session.abort).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'tool_finished',
      status: 'failed',
      errorCode: ERROR_CODES.TAB_NOT_FOUND,
    });
    fake.prompt.resolve();
    await service.waitForIdle();
    expect(service.getState()).toMatchObject({ status: 'ready' });
  });

  test('retains only the safe node summary for progress and completion evidence', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    fake.emit({
      type: 'tool_execution_start',
      toolCallId: 'call_nodes',
      toolName: OPERATIONS.NODE_STATUS,
      args: {},
    });
    dependencies.createTools.mock.calls[0][0].onToolOutcome({
      toolCallId: 'call_nodes',
      operation: OPERATIONS.NODE_STATUS,
      status: 'succeeded',
      nodeStatus: { total: 6, ready: 2, active: 3, disabled: 1, attention: 1 },
      nodes: [{ endpoint: 'http://private.test', error: 'secret' }],
    });
    fake.emit({
      type: 'tool_execution_end',
      toolCallId: 'call_nodes',
      toolName: OPERATIONS.NODE_STATUS,
      result: { content: [{ type: 'text', text: 'node details for the model' }] },
      isError: false,
    });
    fake.prompt.resolve();
    await service.waitForIdle();

    expect(events.find((event) => event.type === 'tool_finished')).toMatchObject({
      operation: OPERATIONS.NODE_STATUS,
      status: 'succeeded',
      label: 'Checked 6 services',
      nodeStatus: { total: 6, ready: 2, active: 3, disabled: 1, attention: 1 },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      outcome: {
        verification: 'nodes_inspected',
        headline: 'Node status checked',
        counts: { nodeChecks: 1 },
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/private\.test|secret/);
  });

  test('projects user-cancelled downloads without promoting an incomplete receipt', async () => {
    const fake = createFakeSession();
    const { service, dependencies } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    fake.emit({
      type: 'tool_execution_start',
      toolCallId: 'call_download',
      toolName: OPERATIONS.DOWNLOAD,
      args: { ref: 'ref_download' },
    });
    dependencies.createTools.mock.calls[0][0].onToolProgress({
      toolCallId: 'call_download',
      operation: OPERATIONS.DOWNLOAD,
      progress: {
        receivedBytes: 0,
        totalBytes: 6_000_000_000,
        state: 'cancelled',
        receipt: {
          artifactId: 'artifact_1234567890abcdef1234',
          filename: 'large.iso',
          bytes: 0,
          state: 'cancelled',
          location: 'downloads',
          available: false,
        },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'tool_progress',
      state: 'cancelled',
    });
    expect(events.at(-1)).not.toHaveProperty('artifact');

    dependencies.createTools.mock.calls[0][0].onToolOutcome({
      toolCallId: 'call_download',
      operation: OPERATIONS.DOWNLOAD,
      status: 'failed',
      errorCode: ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER,
    });
    fake.emit({
      type: 'tool_execution_end',
      toolCallId: 'call_download',
      toolName: OPERATIONS.DOWNLOAD,
      result: { content: [{ type: 'text', text: 'cancelled' }] },
      isError: true,
    });
    fake.prompt.resolve();
    await service.waitForIdle();

    expect(events.find((event) => event.type === 'tool_finished')).toMatchObject({
      status: 'failed',
      errorCode: ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER,
    });
    expect(events.at(-1)).toMatchObject({
      failedActionCount: 0,
      cancelledActionCount: 1,
      outcome: {
        verification: 'download_cancelled',
        headline: 'Download cancelled',
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

  test('keeps an active conversation running when its originally adopted tab closes', async () => {
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
    expect(fake.session.abort).not.toHaveBeenCalled();
    fake.prompt.resolve();
    await service.waitForIdle();
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      status: 'completed',
    });

    await service.dispose();
    expect(unsubscribeTabLifecycle).toHaveBeenCalledTimes(1);
  });

  test('keeps a paused conversation resumable after its originally adopted tab closes', async () => {
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
    expect(service.getState()).toMatchObject({ status: 'paused' });
    await expect(service.resume('run_test')).resolves.toBe(true);
    expect(fake.session.prompt.mock.calls[1][0]).toContain('If no task tab remains');
    expect(fake.session.dispose).not.toHaveBeenCalled();
    await service.stop('run_test');
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
        message:
          'test using model_test rejected the saved credentials. Provider detail: “Authorization failed for [redacted credential]”',
        providerFailure: {
          category: 'authentication',
          recovery: 'provider_setup',
          cause: 'credentials_rejected',
          phase: 'request',
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain('sk-secret-key');
  });

  test('reports sanitized transient retry progress and successful recovery', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    fake.emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 2_000,
      errorMessage: '429 upstream exposed sk-secret-key',
    });
    fake.emit({ type: 'auto_retry_end', success: true, attempt: 1 });
    fake.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    fake.prompt.resolve();
    await service.waitForIdle();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run_retrying',
          attempt: 1,
          maxAttempts: 2,
          delayMs: 2_000,
          message:
            'test using model_test rate-limited the request. Provider detail: “429 upstream exposed [redacted credential]”',
          providerFailure: expect.objectContaining({
            category: 'rate_limited',
            recovery: 'transient',
            cause: 'rate_limited',
            httpStatus: 429,
          }),
        }),
        expect.objectContaining({ type: 'run_retry_recovered', attempt: 1 }),
      ])
    );
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'completed' });
    expect(JSON.stringify(events)).not.toContain('sk-secret-key');
  });

  test('retains safe Pi WebSocket transport diagnostics without exposing diagnostic stacks', () => {
    const failure = providerFailureFromPiMessage({
      errorMessage: 'fetch failed',
      diagnostics: [
        {
          type: 'provider_transport_failure',
          error: {
            message: 'WebSocket closed 1006 Authorization: Bearer private-provider-token',
            stack: 'must-not-be-exposed',
          },
          details: {
            phase: 'before_message_stream_start',
            fallbackTransport: 'sse',
            requestBytes: 123456,
          },
        },
      ],
    });

    expect(failure).toMatchObject({ category: 'connection' });
    expect(failure.detail).toContain('fell back to SSE');
    expect(failure.detail).toContain('Authorization: [redacted]');
    expect(JSON.stringify(failure)).not.toContain('private-provider-token');
    expect(JSON.stringify(failure)).not.toContain('must-not-be-exposed');
    expect(JSON.stringify(failure)).not.toContain('123456');
  });

  test('enumerates distinct sanitized provider reasons from every failed attempt', async () => {
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
        errorMessage: 'fetch failed',
        diagnostics: [
          {
            type: 'provider_transport_failure',
            error: { message: 'WebSocket closed 1006' },
            details: { phase: 'after_message_stream_start' },
          },
        ],
      },
    });
    fake.emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 2_000,
      errorMessage: 'fetch failed',
    });
    fake.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'fetch failed · UND_ERR_CONNECT_TIMEOUT',
      },
    });
    fake.emit({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 2,
      delayMs: 4_000,
      errorMessage: 'fetch failed',
    });
    fake.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 503 overloaded' },
    });
    fake.emit({
      type: 'auto_retry_end',
      success: false,
      attempt: 2,
      finalError: 'HTTP 503 overloaded',
    });
    fake.prompt.resolve();
    await service.waitForIdle();

    const error = events.at(-1).error;
    expect(error.providerAttempts).toMatchObject({
      total: 3,
      observedFailures: 3,
      sameReason: false,
    });
    expect(error.message).toContain('Attempt details:');
    expect(error.message).toContain('WebSocket transport failed after response streaming started');
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(error.message).toContain('HTTP 503');
  });

  test('explains exhausted automatic retries with sanitized provider detail', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    fake.emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 2_000,
      errorMessage: '503 upstream sk-secret-key',
    });
    fake.emit({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 2,
      delayMs: 4_000,
      errorMessage: '503 upstream sk-secret-key',
    });
    fake.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '503 upstream sk-secret-key',
      },
    });
    fake.emit({
      type: 'auto_retry_end',
      success: false,
      attempt: 2,
      finalError: '503 upstream sk-secret-key',
    });
    fake.prompt.resolve();
    await service.waitForIdle();

    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      status: 'failed',
      error: {
        code: AGENT_ERROR_CODES.PROVIDER_ERROR,
        message:
          'test using model_test returned HTTP 503. Provider detail: “503 upstream [redacted credential]” Freedom made 3 attempts total: the initial request plus 2 automatic retries. Every attempt failed for the same reason.',
        providerFailure: {
          category: 'service_unavailable',
          recovery: 'transient',
          cause: 'http_error',
          phase: 'response',
          httpStatus: 503,
        },
        providerAttempts: {
          total: 3,
          automaticRetries: 2,
          observedFailures: 3,
          sameReason: true,
        },
        retryCount: 2,
      },
    });
    expect(JSON.stringify(events)).not.toContain('sk-secret-key');
  });

  test('states explicitly when repeated network failures include no status or code', async () => {
    const fake = createFakeSession();
    const { service } = createService(fake);
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.start(startOptions());

    for (const attempt of [1, 2]) {
      fake.emit({
        type: 'auto_retry_start',
        attempt,
        maxAttempts: 2,
        delayMs: attempt * 2_000,
        errorMessage: 'Network error',
      });
    }
    fake.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'Network error' },
    });
    fake.emit({
      type: 'auto_retry_end',
      success: false,
      attempt: 2,
      finalError: 'Network error',
    });
    fake.prompt.resolve();
    await service.waitForIdle();

    const error = events.at(-1).error;
    expect(error.message).toContain('Provider detail: “Network error”');
    expect(error.message).toContain(
      'No HTTP status, network error code, or more specific reason was supplied.'
    );
    expect(error.message).not.toContain('same reason');
    expect(error.providerAttempts).toMatchObject({
      total: 3,
      observedFailures: 3,
      sameReason: null,
    });
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
      service.start(startOptions({ approvalMode: 'unsafe' }))
    ).rejects.toMatchObject({ code: AGENT_ERROR_CODES.INVALID_ARGUMENT });
    expect(dependencies.loadSdk).not.toHaveBeenCalled();
  });

  test('normalizes only the safe event subset and known tool errors', () => {
    expect(normalizePiEvent({ type: 'turn_start' })).toEqual({ type: 'run_thinking' });
    expect(
      normalizePiEvent({ type: 'message_start', message: { role: 'assistant', secret: true } })
    ).toEqual({ type: 'run_responding' });
    expect(
      normalizePiEvent({ type: 'message_start', message: { role: 'user', secret: true } })
    ).toBeNull();
    expect(
      normalizePiEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_skill',
        toolName: 'read',
        args: { path: '/freedom-agent/skills/swarm-postage/SKILL.md' },
      })
    ).toBeNull();
    expect(
      normalizePiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_skill',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'bundled skill contents' }] },
      })
    ).toBeNull();
    expect(
      normalizePiEvent({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 2,
        delayMs: 500,
        errorMessage: 'secret provider detail',
      })
    ).toEqual({
      type: 'run_retrying',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 500,
      message:
        'The model provider reported: “secret provider detail” It supplied no recognized HTTP status or error code.',
      providerFailure: {
        category: 'unknown',
        recovery: 'unknown',
        cause: 'unknown',
        phase: 'unknown',
        detail: 'secret provider detail',
      },
    });
    expect(normalizePiEvent({ type: 'auto_retry_end', success: true, attempt: 1 })).toEqual({
      type: 'run_retry_recovered',
      attempt: 1,
    });
    expect(
      normalizePiEvent({
        type: 'auto_retry_end',
        success: false,
        attempt: 2,
        finalError: 'HTTP 503 overloaded_error',
      })
    ).toEqual({
      type: 'run_retry_exhausted',
      attempt: 2,
      providerFailure: {
        category: 'service_unavailable',
        recovery: 'transient',
        cause: 'http_error',
        phase: 'response',
        httpStatus: 503,
        detail: 'HTTP 503 overloaded_error',
      },
    });
    expect(normalizePiEvent({ type: 'message_end', message: { secret: true } })).toBeNull();
    expect(normalizePiEvent({ type: 'compaction_start', reason: 'threshold' })).toEqual({
      type: 'context_compaction_started',
      reason: 'threshold',
    });
    expect(
      normalizePiEvent({
        type: 'compaction_end',
        reason: 'threshold',
        aborted: false,
        result: { summary: 'private summary content' },
      })
    ).toEqual({
      type: 'context_compaction_finished',
      reason: 'threshold',
      status: 'succeeded',
    });
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
    expect(
      normalizePiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_attachment',
        toolName: 'attachment_read',
        result: {
          content: [{ type: 'text', text: 'private attachment contents' }],
          details: {
            resourceId: `folder_${'a'.repeat(20)}`,
            resourceKind: 'folder',
            folderName: 'Bug reports',
            name: 'ant-report.json',
            relativePath: 'ant-report.json',
            bytesRead: 100,
            offset: 0,
            truncated: false,
            sourcePath: '/Users/private/ant-report.json',
          },
        },
        isError: false,
      })
    ).toMatchObject({
      operation: 'attachment_read',
      status: 'succeeded',
      label: 'Read ant-report.json',
      effect: 'observed',
      attachment: {
        action: 'read',
        name: 'ant-report.json',
        folderName: 'Bug reports',
        relativePath: 'ant-report.json',
      },
    });
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
