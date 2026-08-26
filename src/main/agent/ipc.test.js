'use strict';

const { EventEmitter } = require('events');
const IPC = require('../../shared/ipc-channels');
const { AGENT_ERROR_CODES, FreedomAgentError } = require('./freedom-agent-service');
const {
  AGENT_IPC_ERROR_CODES,
  OPENAI_DEVICE_VERIFICATION_URL,
  normalizeSubscriptionAuthEvent,
  registerFreedomAgentIpc,
} = require('./ipc');

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: jest.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: jest.fn((channel) => handlers.delete(channel)),
  };
}

function createSender() {
  const sender = new EventEmitter();
  sender.send = jest.fn();
  sender.isDestroyed = jest.fn(() => false);
  return sender;
}

function createService(options = {}) {
  let listener;
  return {
    start:
      options.start ||
      jest.fn(async () => ({ runId: 'run_test', conversationId: 'conversation_test' })),
    steer: options.steer || jest.fn(async (_runId, prompt) => ({
      guidanceId: 'guidance_test',
      text: prompt,
      status: 'queued',
      createdAt: 1_000,
    })),
    pause: options.pause || jest.fn(async () => true),
    resume: options.resume || jest.fn(async () => true),
    stop: options.stop || jest.fn(async () => true),
    clearConversation: options.clearConversation || jest.fn(async () => true),
    listConversations: options.listConversations || jest.fn(() => []),
    listAgentTabs: options.listAgentTabs || jest.fn(() => []),
    claimTab: options.claimTab || jest.fn(async () => false),
    openConversation: options.openConversation || jest.fn(async () => null),
    renameConversation: options.renameConversation || jest.fn(() => null),
    deleteConversation: options.deleteConversation || jest.fn(async () => false),
    decideApproval: options.decideApproval || jest.fn(async () => true),
    getState: jest.fn(() => ({
      status: 'running',
      conversationId: 'conversation_test',
      runId: 'run_test',
      tabId: 'tab_bound',
      transcript: [],
      runtimeAvailable: options.runtimeAvailable ?? true,
    })),
    getWorkspaceState:
      options.getWorkspaceState ||
      jest.fn(() => ({ tabIds: ['tab_bound'], activeTabId: 'tab_bound' })),
    subscribe: jest.fn((nextListener) => {
      listener = nextListener;
      return jest.fn();
    }),
    emit: (event) => listener({ conversationId: 'conversation_test', ...event }),
  };
}

function register(overrides = {}) {
  const ipcMain = createIpcMain();
  const service = overrides.service || createService();
  const sender = overrides.sender || createSender();
  const otherSender = createSender();
  const automationTabIdForRenderer = jest.fn((candidate, rendererTabId) =>
    candidate === sender && rendererTabId === 7 ? 'tab_bound' : null
  );
  const createAutomationPageForHost = jest.fn(async () => 'tab_fresh');
  const desktopBindingForAutomationTab = jest.fn((automationTabId) => {
    if (automationTabId === 'tab_bound') {
      return { hostWebContents: sender, rendererTabId: 7 };
    }
    if (automationTabId === 'tab_fresh') {
      return { hostWebContents: sender, rendererTabId: 8 };
    }
    return null;
  });
  const resolveModel = jest.fn(async () => ({
    model: { id: 'model_test' },
    modelRuntime: { kind: 'runtime' },
    thinkingLevel: 'low',
  }));
  const providerResolver = {
    getStatus: jest.fn(() => ({ configured: false, secureStorageAvailable: true })),
    getCatalog: jest.fn(async () => [{ providerId: 'openai', models: [] }]),
    configureHosted: jest.fn(async () => ({ configured: true, providerId: 'openai' })),
    configureOllama: jest.fn(() => ({ configured: true, providerId: 'ollama' })),
    loginSubscription: jest.fn(async () => ({
      configured: true,
      providerId: 'openai-codex',
      modelId: 'codex-model',
    })),
    selectModel: jest.fn(async () => ({
      configured: true,
      providerId: 'openai',
      modelId: 'gpt-test',
    })),
    removeProvider: jest.fn(() => ({ configured: false, connections: [] })),
    clear: jest.fn(() => ({ configured: false })),
  };
  const openExternal = jest.fn(async () => {});
  const isTrustedSender = jest.fn((candidate) => candidate === sender);
  const dispose = registerFreedomAgentIpc({
    ipcMain,
    service,
    automationTabIdForRenderer,
    desktopBindingForAutomationTab,
    createAutomationPageForHost,
    resolveModel,
    providerResolver,
    isTrustedSender,
    openExternal,
    ...overrides,
  });
  return {
    ipcMain,
    service,
    sender,
    otherSender,
    automationTabIdForRenderer,
    desktopBindingForAutomationTab,
    createAutomationPageForHost,
    resolveModel,
    providerResolver,
    isTrustedSender,
    openExternal,
    dispose,
  };
}

describe('Freedom agent IPC', () => {
  test('resolves a renderer tab through its exact chrome sender and keeps models in main', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await expect(
      start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Summarize this page' })
    ).resolves.toEqual({
      ok: true,
      runId: 'run_test',
      conversationId: 'conversation_test',
    });

    expect(ctx.automationTabIdForRenderer).toHaveBeenCalledWith(ctx.sender, 7);
    expect(ctx.resolveModel).toHaveBeenCalledWith();
    expect(ctx.service.start).toHaveBeenCalledWith({
      prompt: 'Summarize this page',
      tabId: 'tab_bound',
      approvalMode: 'every_interaction',
      createWorkspacePage: expect.any(Function),
      model: { id: 'model_test' },
      modelRuntime: { kind: 'runtime' },
      thinkingLevel: 'low',
    });
    const { createWorkspacePage } = ctx.service.start.mock.calls[0][0];
    await expect(createWorkspacePage('https://fresh.example/')).resolves.toBe('tab_fresh');
    expect(ctx.createAutomationPageForHost).toHaveBeenCalledWith(
      ctx.sender,
      'https://fresh.example/'
    );
  });

  test('starts an empty workspace without binding or exposing an existing user tab', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await expect(
      start(
        { sender: ctx.sender },
        { rendererTabId: null, prompt: 'Research five sources' }
      )
    ).resolves.toEqual({
      ok: true,
      runId: 'run_test',
      conversationId: 'conversation_test',
    });

    expect(ctx.automationTabIdForRenderer).not.toHaveBeenCalled();
    expect(ctx.service.start).toHaveBeenCalledWith({
      prompt: 'Research five sources',
      tabId: null,
      approvalMode: 'every_interaction',
      createWorkspacePage: expect.any(Function),
      model: { id: 'model_test' },
      modelRuntime: { kind: 'runtime' },
      thinkingLevel: 'low',
    });
  });

  test('forwards an explicitly selected website interaction approval mode', async () => {
    const ctx = register();

    await ctx.ipcMain.handlers.get(IPC.AGENT_START)(
      { sender: ctx.sender },
      {
        rendererTabId: 7,
        prompt: 'Complete this task',
        approvalMode: 'allow_website_interactions',
      }
    );

    expect(ctx.service.start).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'allow_website_interactions' })
    );
  });

  test('continues an idle conversation without resolving a new tab or model', async () => {
    const service = createService();
    service.start
      .mockResolvedValueOnce({ runId: 'run_first', conversationId: 'conversation_test' })
      .mockResolvedValueOnce({ runId: 'run_followup', conversationId: 'conversation_test' });
    const ctx = register({ service });
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Find the settings' });
    service.emit({
      type: 'run_finished',
      runId: 'run_first',
      sequence: 1,
      status: 'completed',
    });
    await expect(
      start({ sender: ctx.sender }, { rendererTabId: 999, prompt: 'Now turn it on' })
    ).resolves.toEqual({
      ok: true,
      runId: 'run_followup',
      conversationId: 'conversation_test',
    });

    expect(ctx.automationTabIdForRenderer).toHaveBeenCalledTimes(1);
    expect(ctx.resolveModel).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenNthCalledWith(2, {
      prompt: 'Now turn it on',
      approvalMode: 'every_interaction',
    });
  });

  test('clears only an idle conversation owned by the requesting chrome', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    const clear = ctx.ipcMain.handlers.get(IPC.AGENT_CLEAR_CONVERSATION);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await expect(clear({ sender: ctx.sender })).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_ERROR_CODES.BUSY },
    });
    ctx.service.emit({
      type: 'run_finished',
      runId: 'run_test',
      sequence: 1,
      status: 'completed',
    });
    await expect(clear({ sender: ctx.otherSender })).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
    await expect(clear({ sender: ctx.sender })).resolves.toEqual({ ok: true, cleared: true });
    expect(ctx.service.clearConversation).toHaveBeenCalledTimes(1);
  });

  test('lists and opens saved sessions without granting browser authority', async () => {
    const sessions = [
      {
        conversationId: 'conversation_saved',
        title: 'Saved task',
        status: 'ready',
        turnCount: 2,
      },
    ];
    const service = createService({
      listConversations: jest.fn(() => sessions),
      getWorkspaceState: jest.fn(() => ({ tabIds: [], activeTabId: null })),
      openConversation: jest.fn(async () => ({
        status: 'ready',
        conversationId: 'conversation_saved',
        title: 'Saved task',
        runtimeAvailable: false,
        transcript: [],
      })),
    });
    service.getState.mockReturnValue({
      status: 'ready',
      conversationId: 'conversation_saved',
      title: 'Saved task',
      runtimeAvailable: false,
      transcript: [],
    });
    const ctx = register({ service });

    expect(ctx.ipcMain.handlers.get(IPC.AGENT_HISTORY_LIST)({ sender: ctx.sender })).toEqual({
      ok: true,
      sessions,
    });
    await expect(
      ctx.ipcMain.handlers.get(IPC.AGENT_HISTORY_OPEN)(
        { sender: ctx.sender },
        { conversationId: 'conversation_saved' }
      )
    ).resolves.toMatchObject({
      ok: true,
      state: {
        conversationId: 'conversation_saved',
        runtimeAvailable: false,
        taskTabs: [],
      },
    });
    expect(service.openConversation).toHaveBeenCalledWith('conversation_saved');
    expect(ctx.automationTabIdForRenderer).not.toHaveBeenCalled();
    expect(ctx.resolveModel).not.toHaveBeenCalled();
    expect(
      ctx.ipcMain.handlers.get(IPC.AGENT_HISTORY_LIST)({ sender: ctx.otherSender })
    ).toMatchObject({ ok: false, error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER } });
  });

  test('creates fresh browser authority when continuing a dormant saved session', async () => {
    const service = createService({
      runtimeAvailable: false,
      openConversation: jest.fn(async () => ({
        status: 'ready',
        conversationId: 'conversation_saved',
        runtimeAvailable: false,
        transcript: [],
      })),
    });
    service.start.mockResolvedValue({
      runId: 'run_followup',
      conversationId: 'conversation_saved',
    });
    service.getState.mockReturnValue({
      status: 'ready',
      conversationId: 'conversation_saved',
      runtimeAvailable: false,
      transcript: [],
    });
    const ctx = register({ service });
    await ctx.ipcMain.handlers.get(IPC.AGENT_HISTORY_OPEN)(
      { sender: ctx.sender },
      { conversationId: 'conversation_saved' }
    );

    await expect(
      ctx.ipcMain.handlers.get(IPC.AGENT_START)(
        { sender: ctx.sender },
        { rendererTabId: 7, prompt: 'Continue it', approvalMode: 'every_interaction' }
      )
    ).resolves.toEqual({
      ok: true,
      runId: 'run_followup',
      conversationId: 'conversation_saved',
    });
    expect(ctx.automationTabIdForRenderer).toHaveBeenCalledWith(ctx.sender, 7);
    expect(ctx.resolveModel).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledWith({
      prompt: 'Continue it',
      approvalMode: 'every_interaction',
      tabId: 'tab_bound',
      createWorkspacePage: expect.any(Function),
      model: { id: 'model_test' },
      modelRuntime: { kind: 'runtime' },
      thinkingLevel: 'low',
    });
  });

  test('renames and permanently deletes saved sessions through trusted chrome only', async () => {
    const service = createService({
      renameConversation: jest.fn(() => ({
        conversationId: 'conversation_saved',
        title: 'Renamed task',
      })),
      deleteConversation: jest.fn(async () => true),
    });
    const ctx = register({ service });
    const rename = ctx.ipcMain.handlers.get(IPC.AGENT_HISTORY_RENAME);
    const remove = ctx.ipcMain.handlers.get(IPC.AGENT_HISTORY_DELETE);

    expect(
      rename(
        { sender: ctx.sender },
        { conversationId: 'conversation_saved', title: 'Renamed task' }
      )
    ).toMatchObject({ ok: true, session: { title: 'Renamed task' } });
    await expect(
      remove({ sender: ctx.sender }, { conversationId: 'conversation_saved' })
    ).resolves.toEqual({ ok: true, deleted: true });
    await expect(
      remove({ sender: ctx.otherSender }, { conversationId: 'conversation_saved' })
    ).resolves.toMatchObject({ ok: false, error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER } });
    expect(service.deleteConversation).toHaveBeenCalledTimes(1);
  });

  test('projects profile-level Agent custody and claims only an exactly bound trusted tab', async () => {
    const service = createService({
      listAgentTabs: jest
        .fn()
        .mockReturnValueOnce([
          {
            tabId: 'tab_bound',
            provenance: 'agent',
            custody: 'agent',
            conversationId: 'conversation_saved',
          },
        ])
        .mockReturnValue([]),
      claimTab: jest.fn(async () => true),
    });
    const ctx = register({ service });

    expect(ctx.ipcMain.handlers.get(IPC.AGENT_GET_STATE)({ sender: ctx.sender })).toEqual({
      ok: true,
      state: {
        status: 'idle',
        rendererTabId: null,
        taskTabs: [],
        agentTabs: [
          {
            rendererTabId: 7,
            provenance: 'agent',
            custody: 'agent',
            conversationId: 'conversation_saved',
          },
        ],
      },
    });
    await expect(
      ctx.ipcMain.handlers.get(IPC.AGENT_TAB_CLAIM)(
        { sender: ctx.sender },
        { rendererTabId: 7 }
      )
    ).resolves.toMatchObject({ ok: true, claimed: true, state: { agentTabs: [] } });
    expect(service.claimTab).toHaveBeenCalledWith('tab_bound');
    await expect(
      ctx.ipcMain.handlers.get(IPC.AGENT_TAB_CLAIM)(
        { sender: ctx.otherSender },
        { rendererTabId: 7 }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
  });

  test('rejects untrusted chrome before resolving its tab', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await expect(
      start({ sender: ctx.otherSender }, { rendererTabId: 7, prompt: 'Task' })
    ).resolves.toEqual({
      ok: false,
      error: {
        code: AGENT_IPC_ERROR_CODES.NOT_OWNER,
        message: 'The sender is not trusted browser chrome',
      },
    });
    expect(ctx.automationTabIdForRenderer).not.toHaveBeenCalled();
    expect(ctx.resolveModel).not.toHaveBeenCalled();
    expect(ctx.service.start).not.toHaveBeenCalled();
  });

  test('rejects a trusted chrome sender when its tab is not bound', async () => {
    const ctx = register({ automationTabIdForRenderer: jest.fn(() => null) });
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await expect(
      start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' })
    ).resolves.toEqual({
      ok: false,
      error: {
        code: AGENT_IPC_ERROR_CODES.TAB_NOT_BOUND,
        message: 'The selected browser tab is not ready for the agent',
      },
    });
    expect(ctx.resolveModel).not.toHaveBeenCalled();
    expect(ctx.service.start).not.toHaveBeenCalled();
  });

  test('buffers immediate service events and sends them only to the owning chrome', async () => {
    const service = createService();
    service.start.mockImplementation(async () => {
      service.emit({ type: 'run_started', runId: 'run_test', sequence: 1 });
      service.emit({ type: 'assistant_text_delta', runId: 'run_test', sequence: 2, text: 'Hi' });
      return { runId: 'run_test', conversationId: 'conversation_test' };
    });
    const ctx = register({ service });
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    service.emit({ type: 'run_finished', runId: 'run_test', sequence: 3, status: 'completed' });

    expect(ctx.sender.send.mock.calls).toEqual([
      [
        IPC.AGENT_EVENT,
        {
          type: 'run_started',
          conversationId: 'conversation_test',
          runId: 'run_test',
          sequence: 1,
        },
      ],
      [
        IPC.AGENT_EVENT,
        {
          type: 'assistant_text_delta',
          conversationId: 'conversation_test',
          runId: 'run_test',
          sequence: 2,
          text: 'Hi',
        },
      ],
      [
        IPC.AGENT_EVENT,
        {
          type: 'run_finished',
          conversationId: 'conversation_test',
          runId: 'run_test',
          sequence: 3,
          status: 'completed',
        },
      ],
    ]);
    expect(ctx.otherSender.send).not.toHaveBeenCalled();
  });

  test('allows only the owning sender and exact run ID to stop', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    const stop = ctx.ipcMain.handlers.get(IPC.AGENT_STOP);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await expect(stop({ sender: ctx.otherSender }, { runId: 'run_test' })).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
    await expect(stop({ sender: ctx.sender }, { runId: 'run_stale' })).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
    await expect(stop({ sender: ctx.sender }, { runId: 'run_test' })).resolves.toEqual({
      ok: true,
      stopped: true,
    });
    expect(ctx.service.stop).toHaveBeenCalledTimes(1);
  });

  test('routes pause and resume only for the owning sender and exact run', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    const pause = ctx.ipcMain.handlers.get(IPC.AGENT_PAUSE);
    const resume = ctx.ipcMain.handlers.get(IPC.AGENT_RESUME);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await expect(
      pause({ sender: ctx.otherSender }, { runId: 'run_test' })
    ).resolves.toMatchObject({ ok: false, error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER } });
    await expect(
      resume({ sender: ctx.sender }, { runId: 'run_stale' })
    ).resolves.toMatchObject({ ok: false, error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER } });
    await expect(pause({ sender: ctx.sender }, { runId: 'run_test' })).resolves.toEqual({
      ok: true,
      paused: true,
    });
    await expect(resume({ sender: ctx.sender }, { runId: 'run_test' })).resolves.toEqual({
      ok: true,
      resumed: true,
    });
    expect(ctx.service.pause).toHaveBeenCalledWith('run_test');
    expect(ctx.service.resume).toHaveBeenCalledWith('run_test', undefined);
  });

  test('routes steering only from the owning chrome and keeps it separate from approvals', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    const steer = ctx.ipcMain.handlers.get(IPC.AGENT_STEER);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await expect(
      steer(
        { sender: ctx.otherSender },
        { runId: 'run_test', prompt: 'Change direction' }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
    await expect(
      steer({ sender: ctx.sender }, { runId: 'run_test', prompt: 'Change direction' })
    ).resolves.toMatchObject({
      ok: true,
      guidance: { text: 'Change direction', status: 'queued' },
    });
    expect(ctx.service.steer).toHaveBeenCalledWith('run_test', 'Change direction');
    expect(ctx.service.decideApproval).not.toHaveBeenCalled();
  });

  test('returns a safe service error when resume refuses the changed page scope', async () => {
    const service = createService({
      resume: jest.fn(async () => {
        throw new FreedomAgentError(
          AGENT_ERROR_CODES.RESUME_SCOPE_CHANGED,
          'The controlled tab left the task\'s starting site. Start a new task to continue there.'
        );
      }),
    });
    const ctx = register({ service });
    await ctx.ipcMain.handlers
      .get(IPC.AGENT_START)({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await expect(
      ctx.ipcMain.handlers.get(IPC.AGENT_RESUME)(
        { sender: ctx.sender },
        { runId: 'run_test' }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_ERROR_CODES.RESUME_SCOPE_CHANGED },
    });
  });

  test('routes approval decisions only from the owning chrome and exact run', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    const decide = ctx.ipcMain.handlers.get(IPC.AGENT_APPROVAL_DECIDE);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await expect(
      decide(
        { sender: ctx.otherSender },
        { runId: 'run_test', approvalId: 'approval_test', approved: true }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER } });
    await expect(
      decide(
        { sender: ctx.sender },
        { runId: 'run_other', approvalId: 'approval_test', approved: true }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER } });
    await expect(
      decide(
        { sender: ctx.sender },
        { runId: 'run_test', approvalId: 'approval_test', approved: true }
      )
    ).resolves.toEqual({ ok: true, decided: true });
    expect(ctx.service.decideApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_test',
      true
    );
  });

  test('reports the controlled renderer tab only to the owning chrome', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    const getState = ctx.ipcMain.handlers.get(IPC.AGENT_GET_STATE);

    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    expect(getState({ sender: ctx.sender })).toEqual({
      ok: true,
      state: {
        status: 'running',
        conversationId: 'conversation_test',
        runId: 'run_test',
        tabId: 'tab_bound',
        transcript: [],
        runtimeAvailable: true,
        rendererTabId: 7,
        taskTabs: [{ rendererTabId: 7, agentActive: true }],
        agentTabs: [],
      },
    });
    expect(getState({ sender: ctx.otherSender })).toEqual({
      ok: true,
      state: { status: 'idle', taskTabs: [], agentTabs: [] },
    });
  });

  test('projects only task tabs bound to the owning chrome', async () => {
    const service = createService({
      getWorkspaceState: jest.fn(() => ({
        tabIds: ['tab_bound', 'tab_foreign', 'tab_missing'],
        activeTabId: 'tab_foreign',
      })),
    });
    const ctx = register({ service });
    ctx.desktopBindingForAutomationTab.mockImplementation((automationTabId) => {
      if (automationTabId === 'tab_bound') {
        return { hostWebContents: ctx.sender, rendererTabId: 7 };
      }
      if (automationTabId === 'tab_foreign') {
        return { hostWebContents: ctx.otherSender, rendererTabId: 44 };
      }
      return null;
    });
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    const getState = ctx.ipcMain.handlers.get(IPC.AGENT_GET_STATE);

    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    expect(getState({ sender: ctx.sender }).state.taskTabs).toEqual([
      { rendererTabId: 7, agentActive: false },
    ]);
  });

  test('configures providers only for trusted chrome and never returns a key', async () => {
    const ctx = register();
    const configure = ctx.ipcMain.handlers.get(IPC.AGENT_PROVIDER_CONFIGURE_HOSTED);
    const input = { providerId: 'openai', modelId: 'model', apiKey: 'sk-secret' };

    await expect(configure({ sender: ctx.otherSender }, input)).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
    const response = await configure({ sender: ctx.sender }, input);

    expect(ctx.providerResolver.configureHosted).toHaveBeenCalledWith(input);
    expect(response).toEqual({
      ok: true,
      status: { configured: true, providerId: 'openai' },
    });
    expect(JSON.stringify(response)).not.toContain('sk-secret');
  });

  test('selects and removes configured models only through trusted chrome', async () => {
    const ctx = register();
    const select = ctx.ipcMain.handlers.get(IPC.AGENT_PROVIDER_SELECT_MODEL);
    const remove = ctx.ipcMain.handlers.get(IPC.AGENT_PROVIDER_REMOVE);

    await expect(
      select(
        { sender: ctx.otherSender },
        { providerId: 'openai', modelId: 'gpt-test' }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER } });
    await expect(
      select({ sender: ctx.sender }, { providerId: 'openai', modelId: 'gpt-test' })
    ).resolves.toMatchObject({ ok: true, status: { modelId: 'gpt-test' } });
    await expect(
      remove({ sender: ctx.sender }, { providerId: 'openai' })
    ).resolves.toMatchObject({ ok: true, status: { configured: false } });

    expect(ctx.providerResolver.selectModel).toHaveBeenCalledWith({
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    expect(ctx.providerResolver.removeProvider).toHaveBeenCalledWith({ providerId: 'openai' });
  });

  test('fails provider trust checks closed without exposing classifier errors', async () => {
    const ctx = register({
      isTrustedSender: jest.fn(() => {
        throw new Error('private-window-internal');
      }),
    });
    const getStatus = ctx.ipcMain.handlers.get(IPC.AGENT_PROVIDER_GET_STATUS);

    await expect(getStatus({ sender: ctx.sender })).resolves.toEqual({
      ok: false,
      error: {
        code: AGENT_IPC_ERROR_CODES.NOT_OWNER,
        message: 'The sender is not trusted browser chrome',
      },
    });
    expect(ctx.providerResolver.getStatus).not.toHaveBeenCalled();
  });

  test('runs subscription login with a fixed device-code flow and normalized events', async () => {
    const ctx = register();
    ctx.providerResolver.loginSubscription.mockImplementation(async (_input, interaction) => {
      await expect(
        interaction.prompt({
          type: 'select',
          options: [
            { id: 'browser', label: 'Browser' },
            { id: 'device_code', label: 'Device code' },
          ],
        })
      ).resolves.toBe('device_code');
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: OPENAI_DEVICE_VERIFICATION_URL,
        expiresInSeconds: 900,
      });
      interaction.notify({ type: 'progress', message: 'secret provider message' });
      return { configured: true, providerId: 'openai-codex', modelId: 'codex-model' };
    });
    const login = ctx.ipcMain.handlers.get(IPC.AGENT_PROVIDER_LOGIN_SUBSCRIPTION);

    await expect(
      login({ sender: ctx.sender }, { providerId: 'openai-codex', modelId: 'codex-model' })
    ).resolves.toEqual({
      ok: true,
      status: { configured: true, providerId: 'openai-codex', modelId: 'codex-model' },
    });

    expect(ctx.sender.send).toHaveBeenCalledWith(IPC.AGENT_PROVIDER_AUTH_EVENT, {
      type: 'device_code',
      providerId: 'openai-codex',
      userCode: 'ABCD-1234',
      verificationUri: OPENAI_DEVICE_VERIFICATION_URL,
    });
    expect(ctx.openExternal).toHaveBeenCalledWith(OPENAI_DEVICE_VERIFICATION_URL);
    expect(JSON.stringify(ctx.sender.send.mock.calls)).not.toContain('secret provider message');
  });

  test('cancels only the owning subscription login', async () => {
    const ctx = register();
    ctx.providerResolver.loginSubscription.mockImplementation(
      (_input, interaction) =>
        new Promise((_resolve, reject) => {
          interaction.signal.addEventListener('abort', () => reject(interaction.signal.reason), {
            once: true,
          });
        })
    );
    const login = ctx.ipcMain.handlers.get(IPC.AGENT_PROVIDER_LOGIN_SUBSCRIPTION);
    const cancel = ctx.ipcMain.handlers.get(IPC.AGENT_PROVIDER_CANCEL_LOGIN);
    const pending = login(
      { sender: ctx.sender },
      { providerId: 'openai-codex', modelId: 'codex-model' }
    );
    await Promise.resolve();

    await expect(cancel({ sender: ctx.otherSender })).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
    await expect(cancel({ sender: ctx.sender })).resolves.toEqual({ ok: true, cancelled: true });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'AGENT_PROVIDER_AUTH_CANCELLED' },
    });
  });

  test('rejects spoofed subscription auth events', () => {
    expect(
      normalizeSubscriptionAuthEvent({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://evil.example/device',
      })
    ).toBeNull();
    expect(
      normalizeSubscriptionAuthEvent({
        type: 'device_code',
        userCode: '<script>',
        verificationUri: OPENAI_DEVICE_VERIFICATION_URL,
      })
    ).toBeNull();
  });

  test('stops the run and clears its conversation when its chrome renderer is destroyed', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    ctx.sender.emit('destroyed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(ctx.service.stop).toHaveBeenCalledWith('run_test');
    expect(ctx.service.clearConversation).toHaveBeenCalledTimes(1);
  });

  test('stops a run that finishes starting after its chrome renderer is destroyed', async () => {
    let resolveStart;
    const service = createService({
      start: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveStart = resolve;
          })
      ),
    });
    const ctx = register({ service });
    const pending = ctx.ipcMain.handlers
      .get(IPC.AGENT_START)({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });
    await Promise.resolve();

    ctx.sender.emit('destroyed');
    resolveStart({ runId: 'run_late', conversationId: 'conversation_test' });
    await pending;
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.stop).toHaveBeenCalledWith('run_late');
    expect(service.clearConversation).toHaveBeenCalledTimes(1);
  });

  test('redacts model resolver and unexpected service failures', async () => {
    const modelFailure = register({
      resolveModel: jest.fn(async () => {
        throw new Error('sk-secret-key');
      }),
    });
    await expect(
      modelFailure.ipcMain.handlers
        .get(IPC.AGENT_START)(
          { sender: modelFailure.sender },
          { rendererTabId: 7, prompt: 'Task' }
        )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.MODEL_UNAVAILABLE },
    });

    const serviceFailure = createService({
      start: jest.fn(async () => {
        throw new Error('sk-other-secret');
      }),
    });
    const serviceContext = register({ service: serviceFailure });
    const response = await serviceContext.ipcMain.handlers
      .get(IPC.AGENT_START)(
        { sender: serviceContext.sender },
        { rendererTabId: 7, prompt: 'Task' }
      );
    expect(response).toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.INTERNAL_ERROR },
    });
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  test('preserves safe service errors and validates input', async () => {
    const service = createService({
      start: jest.fn(async () => {
        throw new FreedomAgentError(AGENT_ERROR_CODES.BUSY, 'Agent is busy');
      }),
    });
    const ctx = register({ service });
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await expect(start({ sender: ctx.sender }, null)).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_ERROR_CODES.INVALID_ARGUMENT },
    });
    await expect(
      start(
        { sender: ctx.sender },
        { rendererTabId: 7, prompt: 'Task', approvalMode: 'sensitive_actions' }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_ERROR_CODES.INVALID_ARGUMENT },
    });
    await expect(
      start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' })
    ).resolves.toEqual({ ok: false, error: { code: AGENT_ERROR_CODES.BUSY, message: 'Agent is busy' } });
  });

  test('removes handlers and stops an owned run on disposal', async () => {
    const ctx = register();
    await ctx.ipcMain.handlers
      .get(IPC.AGENT_START)({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await ctx.dispose();

    expect(ctx.ipcMain.handlers.size).toBe(0);
    expect(ctx.service.stop).toHaveBeenCalledWith('run_test');
    expect(ctx.service.clearConversation).toHaveBeenCalledTimes(1);
  });
});
