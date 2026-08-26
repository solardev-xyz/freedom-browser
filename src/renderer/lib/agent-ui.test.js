const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function createAgentElements() {
  const ids = [
    'agent-toggle-btn',
    'agent-sidebar',
    'agent-sidebar-close',
    'agent-first-toggle',
    'agent-first-titlebar',
    'agent-first-title',
    'agent-first-browser-return',
    'agent-session-sidebar-toggle',
    'agent-workspace-sidebar-toggle',
    'agent-session-sidebar',
    'agent-session-resizer',
    'agent-page-surface',
    'agent-workspace-resizer',
    'agent-session-new-chat',
    'agent-session-list',
    'agent-session-history-empty',
    'agent-task-pages',
    'agent-task-page-count',
    'agent-task-page-list',
    'agent-task-pages-empty',
    'agent-task-pages-note',
    'agent-workspace-nav',
    'agent-workspace-back',
    'agent-workspace-forward',
    'agent-workspace-reload',
    'agent-workspace-address-host',
    'agent-sidebar-back',
    'agent-sidebar-title',
    'agent-sidebar-subtitle',
    'agent-loading-view',
    'agent-setup-view',
    'agent-workspace-view',
    'agent-connected-providers',
    'agent-connected-provider-list',
    'agent-provider-select',
    'agent-provider-status',
    'agent-provider-privacy',
    'agent-hosted-fields',
    'agent-api-key-field',
    'agent-subscription-fields',
    'agent-ollama-fields',
    'agent-model-select',
    'agent-api-key',
    'agent-ollama-model',
    'agent-ollama-url',
    'agent-provider-save',
    'agent-provider-login',
    'agent-provider-cancel-login',
    'agent-auth-code',
    'agent-auth-user-code',
    'agent-provider-message',
    'agent-prompt',
    'agent-run',
    'agent-new-chat',
    'agent-pause',
    'agent-resume',
    'agent-stop',
    'agent-run-status',
    'agent-run-message',
    'agent-approval',
    'agent-approval-action',
    'agent-approval-origin',
    'agent-approval-approve',
    'agent-approval-decline',
    'agent-approval-message',
    'agent-transcript',
    'agent-empty-state',
    'agent-model-menu-button',
    'agent-active-model-label',
    'agent-model-menu',
    'agent-model-menu-list',
    'agent-manage-providers',
    'agent-approval-mode-button',
    'agent-active-approval-mode-label',
    'agent-approval-mode-popover',
    'agent-approval-mode-every',
    'agent-approval-mode-sensitive',
    'agent-approval-mode-allow',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, createElement('div')]));
  elements['agent-toggle-btn'] = createElement('button');
  elements['agent-sidebar'] = createElement('aside', { classes: ['collapsed'] });
  elements['agent-sidebar-close'] = createElement('button');
  elements['agent-first-toggle'] = createElement('button');
  elements['agent-first-toggle'].hidden = true;
  elements['agent-first-titlebar'] = createElement('div');
  elements['agent-first-titlebar'].hidden = true;
  elements['agent-first-browser-return'] = createElement('button');
  elements['agent-session-sidebar-toggle'] = createElement('button');
  elements['agent-workspace-sidebar-toggle'] = createElement('button');
  elements['agent-session-sidebar'] = createElement('aside', {
    rect: { left: 0, right: 242, width: 242 },
  });
  elements['agent-session-sidebar'].hidden = true;
  elements['agent-session-resizer'] = createElement('div');
  elements['agent-page-surface'] = createElement('section', {
    rect: { left: 860, right: 1280, width: 420 },
  });
  elements['agent-workspace-resizer'] = createElement('div');
  elements['agent-session-new-chat'] = createElement('button');
  elements['agent-session-list'] = createElement('div');
  elements['agent-session-history-empty'] = createElement('div');
  elements['agent-task-pages'] = createElement('aside');
  elements['agent-task-pages'].hidden = true;
  elements['agent-task-page-count'] = createElement('span', { textContent: '0' });
  elements['agent-task-page-list'] = createElement('div');
  elements['agent-task-pages-empty'] = createElement('div');
  elements['agent-workspace-nav'] = createElement('form');
  elements['agent-workspace-back'] = createElement('button');
  elements['agent-workspace-forward'] = createElement('button');
  elements['agent-workspace-reload'] = createElement('button');
  elements['agent-workspace-address-host'] = createElement('div');
  elements['agent-sidebar-back'] = createElement('button');
  elements['agent-setup-view'].hidden = true;
  elements['agent-workspace-view'].hidden = true;
  elements['agent-connected-providers'].hidden = true;
  elements['agent-provider-select'] = createElement('select', { value: 'openai' });
  elements['agent-model-select'] = createElement('select');
  elements['agent-api-key'] = createElement('input');
  elements['agent-ollama-model'] = createElement('input');
  elements['agent-ollama-url'] = createElement('input', {
    value: 'http://127.0.0.1:11434/v1',
  });
  elements['agent-provider-save'] = createElement('button');
  elements['agent-provider-login'] = createElement('button');
  elements['agent-provider-cancel-login'] = createElement('button');
  elements['agent-auth-code'].hidden = true;
  elements['agent-prompt'] = createElement('textarea');
  elements['agent-run'] = createElement('button');
  elements['agent-new-chat'] = createElement('button');
  elements['agent-new-chat'].hidden = true;
  elements['agent-pause'] = createElement('button', { disabled: true });
  elements['agent-pause'].hidden = true;
  elements['agent-resume'] = createElement('button', { disabled: true });
  elements['agent-resume'].hidden = true;
  elements['agent-stop'] = createElement('button', { disabled: true });
  elements['agent-stop'].hidden = true;
  elements['agent-approval'] = createElement('div');
  elements['agent-approval'].hidden = true;
  elements['agent-approval-approve'] = createElement('button');
  elements['agent-approval-decline'] = createElement('button');
  elements['agent-transcript'].hidden = true;
  elements['agent-model-menu-button'] = createElement('button');
  elements['agent-model-menu'] = createElement('div');
  elements['agent-model-menu'].hidden = true;
  elements['agent-manage-providers'] = createElement('button');
  elements['agent-approval-mode-button'] = createElement('button');
  elements['agent-active-approval-mode-label'] = createElement('span', {
    textContent: 'Ask every action',
  });
  elements['agent-approval-mode-popover'] = createElement('div');
  elements['agent-approval-mode-popover'].hidden = true;
  elements['agent-approval-mode-every'] = createElement('button', { classes: ['active'] });
  elements['agent-approval-mode-every'].appendChild(createElement('span'));
  elements['agent-approval-mode-every'].appendChild(
    createElement('span', { classes: ['agent-approval-mode-check'], textContent: '✓' })
  );
  elements['agent-approval-mode-sensitive'] = createElement('button', { disabled: true });
  elements['agent-approval-mode-allow'] = createElement('button');
  elements['agent-approval-mode-allow'].appendChild(createElement('span'));
  elements['agent-approval-mode-allow'].appendChild(
    createElement('span', { classes: ['agent-approval-mode-check'] })
  );
  return elements;
}

async function loadAgentUi(options = {}) {
  jest.resetModules();
  const elements = createAgentElements();
  const document = createDocument({ elementsById: elements });
  document.dispatchEvent = jest.fn();
  let eventHandler = null;
  let providerAuthEventHandler = null;
  const electronAPI = {
    getAgentProviderStatus: jest.fn().mockResolvedValue({
      ok: true,
      status: {
        configured: true,
        secureStorageAvailable: true,
        kind: 'hosted',
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        connections: [{ kind: 'hosted', providerId: 'openai', modelId: 'gpt-4.1-mini' }],
      },
    }),
    getAgentProviderCatalog: jest.fn().mockResolvedValue({
      ok: true,
      catalog: [
        {
          providerId: 'openai',
          name: 'OpenAI',
          authType: 'api_key',
          models: [{ id: 'gpt-4.1-mini', name: 'GPT 4.1 mini' }],
        },
        {
          providerId: 'openai-codex',
          name: 'ChatGPT (Codex)',
          authType: 'subscription',
          models: [{ id: 'codex-model', name: 'Codex Model' }],
        },
      ],
    }),
    configureHostedAgentProvider: jest.fn().mockResolvedValue({
      ok: true,
      status: { configured: true, providerId: 'openai', modelId: 'gpt-4.1-mini' },
    }),
    configureOllamaAgentProvider: jest.fn(),
    loginSubscriptionAgentProvider: jest.fn(),
    cancelAgentProviderLogin: jest.fn().mockResolvedValue({ ok: true, cancelled: true }),
    selectAgentModel: jest.fn(),
    removeAgentProvider: jest.fn(),
    getAgentState: jest.fn().mockResolvedValue({ ok: true, state: { status: 'idle' } }),
    startAgent: jest.fn().mockResolvedValue({
      ok: true,
      runId: 'run_test',
      conversationId: 'conversation_test',
    }),
    clearAgentConversation: jest.fn().mockResolvedValue({ ok: true, cleared: true }),
    listAgentSessions: jest.fn().mockResolvedValue({ ok: true, sessions: [] }),
    openAgentSession: jest.fn(),
    renameAgentSession: jest.fn(),
    deleteAgentSession: jest.fn(),
    claimAgentTab: jest.fn(),
    pauseAgent: jest.fn().mockResolvedValue({ ok: true, paused: true }),
    resumeAgent: jest.fn().mockResolvedValue({ ok: true, resumed: true }),
    stopAgent: jest.fn().mockResolvedValue({ ok: true, stopped: true }),
    decideAgentApproval: jest.fn().mockResolvedValue({ ok: true, decided: true }),
    onAgentEvent: jest.fn((handler) => {
      eventHandler = handler;
      return jest.fn();
    }),
    onAgentProviderAuthEvent: jest.fn((handler) => {
      providerAuthEventHandler = handler;
      return jest.fn();
    }),
    ...options.electronAPI,
  };
  global.document = document;
  global.window = {
    electronAPI,
    confirm: jest.fn(() => true),
    prompt: jest.fn(() => null),
    innerWidth: 1280,
    ...(options.windowGlobals || {}),
  };
  global.CustomEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  const sidebar = {
    close: jest.fn(),
    isVisible: jest.fn(() => false),
  };
  jest.doMock('./private-mode.js', () => ({ isPrivateWindow: () => options.isPrivate === true }));
  jest.doMock('./sidebar.js', () => sidebar);
  jest.doMock('./wallet/signature-flight.js', () => ({
    isSignatureInFlight: () => false,
    onSignatureFlightChange: jest.fn(),
  }));
  const setAgentControlledTab = jest.fn();
  const setAgentTabCustody = jest.fn();
  const setAgentTabClaimHandler = jest.fn();
  const switchTab = jest.fn();
  const setTabStripProjection = jest.fn();
  const setWorkspaceNavigationProjection = jest.fn();
  const setWorkspaceNavigationEditable = jest.fn();
  const getOpenTabs =
    options.getOpenTabs ||
    (() => [
      {
        id: 7,
        url: 'https://example.com/start',
        title: 'Start page',
        favicon: '',
        isLoading: false,
        isActive: true,
      },
    ]);
  const mod = await import('./agent-ui.js');
  mod.initAgentUi({
    getActiveTab:
      options.getActiveTab || (() => getOpenTabs().find((tab) => tab.isActive) || getOpenTabs()[0]),
    getOpenTabs,
    setAgentControlledTab,
    setAgentTabCustody,
    setAgentTabClaimHandler,
    setTabStripProjection,
    setWorkspaceNavigationProjection,
    setWorkspaceNavigationEditable,
    subscribeTabPresentation: (listener) => {
      listener(getOpenTabs());
      return jest.fn();
    },
    switchTab,
  });
  await flush();
  return {
    mod,
    elements,
    document,
    electronAPI,
    sidebar,
    setAgentControlledTab,
    setAgentTabCustody,
    setAgentTabClaimHandler,
    switchTab,
    setTabStripProjection,
    setWorkspaceNavigationProjection,
    setWorkspaceNavigationEditable,
    emit: (event) => eventHandler(event),
    emitProviderAuth: (event) => providerAuthEventHandler(event),
  };
}

describe('Agent UI', () => {
  afterEach(() => {
    delete global.document;
    delete global.window;
    delete global.CustomEvent;
  });

  test('shows provider setup when no model is connected', async () => {
    const ctx = await loadAgentUi({
      electronAPI: {
        getAgentProviderStatus: jest.fn().mockResolvedValue({
          ok: true,
          status: { configured: false, secureStorageAvailable: true, connections: [] },
        }),
      },
    });

    expect(ctx.elements['agent-setup-view'].hidden).toBe(false);
    expect(ctx.elements['agent-workspace-view'].hidden).toBe(true);
    expect(ctx.elements['agent-sidebar-title'].textContent).toBe('Set up Agent');
    expect(ctx.elements['agent-run'].disabled).toBe(true);
  });

  test('submits a configured task with Enter while Shift+Enter remains multiline', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Summarize this page';
    ctx.elements['agent-prompt'].dispatch('input');
    expect(ctx.elements['agent-run'].disabled).toBe(false);

    const multiline = { key: 'Enter', shiftKey: true, preventDefault: jest.fn() };
    ctx.elements['agent-prompt'].dispatch('keydown', multiline);
    expect(multiline.preventDefault).not.toHaveBeenCalled();
    expect(ctx.electronAPI.startAgent).not.toHaveBeenCalled();

    const submit = { key: 'Enter', shiftKey: false, preventDefault: jest.fn() };
    ctx.elements['agent-prompt'].dispatch('keydown', submit);
    await flush();
    expect(submit.preventDefault).toHaveBeenCalledTimes(1);
    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      7,
      'Summarize this page',
      'every_interaction'
    );
  });

  test('selects website interaction approval behavior while sensitive actions remain a stub', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-approval-mode-allow'].dispatch('click');

    expect(ctx.elements['agent-active-approval-mode-label'].textContent).toBe(
      'Allow website actions'
    );
    expect(ctx.elements['agent-approval-mode-allow'].getAttribute('aria-pressed')).toBe('true');
    expect(ctx.elements['agent-approval-mode-sensitive'].disabled).toBe(true);

    ctx.elements['agent-prompt'].value = 'Compare these sources';
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      7,
      'Compare these sources',
      'allow_website_interactions'
    );
    expect(ctx.elements['agent-approval-mode-button'].disabled).toBe(true);
  });

  test('disconnects a provider through the management view and returns to setup', async () => {
    const ctx = await loadAgentUi({
      electronAPI: {
        removeAgentProvider: jest.fn().mockResolvedValue({
          ok: true,
          status: { configured: false, secureStorageAvailable: true, connections: [] },
        }),
      },
    });
    ctx.elements['agent-toggle-btn'].dispatch('click');
    await flush();
    ctx.elements['agent-manage-providers'].dispatch('click');

    const disconnect = ctx.elements['agent-connected-provider-list'].children[0].children[1];
    disconnect.dispatch('click');
    await flush();

    expect(global.window.confirm).toHaveBeenCalledWith('Disconnect OpenAI from Agent?');
    expect(ctx.electronAPI.removeAgentProvider).toHaveBeenCalledWith('openai');
    expect(ctx.elements['agent-setup-view'].hidden).toBe(false);
    expect(ctx.elements['agent-sidebar-back'].hidden).toBe(true);
  });

  test('saves credentials without retaining the key and renders structured run events as text', async () => {
    const ctx = await loadAgentUi();
    expect(ctx.electronAPI.getAgentProviderCatalog).not.toHaveBeenCalled();
    ctx.elements['agent-toggle-btn'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.getAgentProviderCatalog).toHaveBeenCalledTimes(1);
    ctx.elements['agent-model-select'].value = 'gpt-4.1-mini';
    ctx.elements['agent-api-key'].value = 'sk-user-secret';
    ctx.elements['agent-provider-save'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.configureHostedAgentProvider).toHaveBeenCalledWith(
      'openai',
      'gpt-4.1-mini',
      'sk-user-secret'
    );
    expect(ctx.elements['agent-api-key'].value).toBe('');
    expect(ctx.elements['agent-provider-status'].textContent).toBe('OpenAI · gpt-4.1-mini');

    ctx.elements['agent-prompt'].value = 'Summarize this page';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      7,
      'Summarize this page',
      'every_interaction'
    );

    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'assistant_text_delta',
      runId: 'run_test',
      text: '<img src=x onerror=alert(1)>Summary',
    });
    ctx.emit({
      type: 'tool_started',
      runId: 'run_test',
      toolCallId: 'tool_1',
      operation: 'browser_snapshot',
    });
    ctx.emit({
      type: 'tool_finished',
      runId: 'run_test',
      toolCallId: 'tool_1',
      operation: 'browser_snapshot',
      status: 'succeeded',
    });
    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'completed' });

    const output = ctx.elements['agent-transcript'].querySelector('.agent-output');
    const toolList = ctx.elements['agent-transcript'].querySelector('.agent-tool-list');
    expect(output.textContent).toBe('<img src=x onerror=alert(1)>Summary');
    expect(output.children).toHaveLength(0);
    expect(toolList.children[0].children[0].textContent).toBe('✓');
    expect(ctx.elements['agent-run-status'].textContent).toBe('Complete');
    expect(ctx.elements['agent-run'].disabled).toBe(true);
    expect(ctx.setAgentControlledTab).toHaveBeenNthCalledWith(1, 7);
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(null);
  });

  test('keeps follow-up prompts in one chat and collapses completed activity', async () => {
    const startAgent = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        runId: 'run_first',
        conversationId: 'conversation_test',
      })
      .mockResolvedValueOnce({
        ok: true,
        runId: 'run_followup',
        conversationId: 'conversation_test',
      });
    const ctx = await loadAgentUi({ electronAPI: { startAgent } });

    ctx.elements['agent-prompt'].value = 'Find the account settings';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_first',
      userText: 'Find the account settings',
    });
    ctx.emit({
      type: 'context_compaction_started',
      conversationId: 'conversation_test',
      runId: 'run_first',
    });
    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'Making room for more conversation…'
    );
    ctx.emit({
      type: 'context_compaction_finished',
      conversationId: 'conversation_test',
      runId: 'run_first',
      status: 'succeeded',
    });
    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'Conversation compacted. Continuing…'
    );
    ctx.emit({
      type: 'tool_started',
      conversationId: 'conversation_test',
      runId: 'run_first',
      toolCallId: 'tool_first',
      operation: 'browser_click',
    });
    ctx.emit({
      type: 'tool_finished',
      conversationId: 'conversation_test',
      runId: 'run_first',
      toolCallId: 'tool_first',
      operation: 'browser_click',
      status: 'succeeded',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_first',
      status: 'completed',
      durationMs: 72_000,
      actionCount: 1,
    });

    const firstTurn = ctx.elements['agent-transcript'].children[0];
    const firstActivity = firstTurn.querySelector('.agent-turn-activity');
    expect(firstTurn.querySelector('.agent-user-message').textContent).toBe(
      'Find the account settings'
    );
    expect(firstActivity.open).toBe(false);
    expect(firstActivity.children[0].textContent).toBe('Worked for 1m 12s · 1 action');
    expect(ctx.elements['agent-model-menu-button'].disabled).toBe(true);
    expect(ctx.elements['agent-approval-mode-button'].disabled).toBe(true);
    expect(ctx.elements['agent-new-chat'].hidden).toBe(false);

    ctx.elements['agent-prompt'].value = 'Now enable notifications';
    ctx.elements['agent-prompt'].dispatch('input');
    expect(ctx.elements['agent-run'].disabled).toBe(false);
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_followup',
      userText: 'Now enable notifications',
    });

    expect(startAgent).toHaveBeenNthCalledWith(
      2,
      7,
      'Now enable notifications',
      'every_interaction'
    );
    expect(ctx.elements['agent-transcript'].children).toHaveLength(2);
    expect(
      ctx.elements['agent-transcript'].children[1].querySelector('.agent-user-message').textContent
    ).toBe('Now enable notifications');
  });

  test('starts a fresh chat only after clearing the idle conversation', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'First task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'First task',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
    });

    ctx.elements['agent-new-chat'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.clearAgentConversation).toHaveBeenCalledTimes(1);
    expect(ctx.elements['agent-transcript'].children).toHaveLength(0);
    expect(ctx.elements['agent-transcript'].hidden).toBe(true);
    expect(ctx.elements['agent-empty-state'].hidden).toBe(false);
    expect(ctx.elements['agent-new-chat'].hidden).toBe(true);
    expect(ctx.elements['agent-model-menu-button'].disabled).toBe(false);
    expect(ctx.elements['agent-approval-mode-button'].disabled).toBe(false);
  });

  test('restores an idle in-memory conversation when the sidebar UI reloads', async () => {
    const ctx = await loadAgentUi({
      electronAPI: {
        getAgentState: jest.fn().mockResolvedValue({
          ok: true,
          state: {
            status: 'ready',
            conversationId: 'conversation_restored',
            rendererTabId: 7,
            approvalMode: 'allow_website_interactions',
            transcript: [
              {
                runId: 'run_restored',
                userText: 'What is on this page?',
                assistantText: 'A settings page.',
                status: 'completed',
                durationMs: 2_000,
                activity: [],
              },
            ],
          },
        }),
      },
    });

    expect(ctx.elements['agent-run-status'].textContent).toBe('Ready');
    expect(ctx.elements['agent-transcript'].children).toHaveLength(1);
    expect(ctx.elements['agent-transcript'].querySelector('.agent-user-message').textContent).toBe(
      'What is on this page?'
    );
    expect(ctx.elements['agent-active-approval-mode-label'].textContent).toBe(
      'Allow website actions'
    );
    expect(ctx.elements['agent-model-menu-button'].disabled).toBe(true);
    expect(ctx.elements['agent-new-chat'].hidden).toBe(false);
  });

  test('opens a saved session and continues it from the current page with fresh authority', async () => {
    const sessions = [
      {
        conversationId: 'conversation_saved',
        title: 'Saved comparison',
        status: 'ready',
        turnCount: 1,
      },
    ];
    const ctx = await loadAgentUi({
      electronAPI: {
        listAgentSessions: jest.fn().mockResolvedValue({ ok: true, sessions }),
        openAgentSession: jest.fn().mockResolvedValue({
          ok: true,
          state: {
            status: 'ready',
            conversationId: 'conversation_saved',
            title: 'Saved comparison',
            approvalMode: 'every_interaction',
            runtimeAvailable: false,
            transcript: [
              {
                runId: 'run_saved',
                userText: 'Compare these pages',
                assistantText: 'The first one is newer.',
                status: 'completed',
                activity: [],
              },
            ],
            taskTabs: [],
          },
        }),
        startAgent: jest.fn().mockResolvedValue({
          ok: true,
          runId: 'run_followup',
          conversationId: 'conversation_saved',
        }),
      },
    });

    const row = ctx.elements['agent-session-list'].children[0];
    row.children[0].dispatch('click');
    await flush();

    expect(ctx.electronAPI.openAgentSession).toHaveBeenCalledWith('conversation_saved');
    expect(ctx.elements['agent-first-title'].textContent).toBe('Saved comparison');
    expect(ctx.elements['agent-transcript'].querySelector('.agent-user-message').textContent).toBe(
      'Compare these pages'
    );
    expect(ctx.elements['agent-run-message'].textContent).toContain('fresh page');

    ctx.elements['agent-prompt'].value = 'Now compare their authors';
    ctx.elements['agent-prompt'].dispatch('input');
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      7,
      'Now compare their authors',
      'every_interaction'
    );
  });

  test('restores a live session workspace and claims an Agent-owned tab', async () => {
    const agentTab = {
      rendererTabId: 8,
      provenance: 'agent',
      custody: 'agent',
      conversationId: 'conversation_live',
    };
    const ctx = await loadAgentUi({
      electronAPI: {
        listAgentSessions: jest.fn().mockResolvedValue({
          ok: true,
          sessions: [
            {
              conversationId: 'conversation_live',
              title: 'Live research',
              status: 'ready',
              turnCount: 1,
            },
          ],
        }),
        openAgentSession: jest.fn().mockResolvedValue({
          ok: true,
          state: {
            status: 'ready',
            conversationId: 'conversation_live',
            title: 'Live research',
            approvalMode: 'every_interaction',
            runtimeAvailable: true,
            transcript: [],
            taskTabs: [{ rendererTabId: 8, agentActive: true }],
            agentTabs: [agentTab],
          },
        }),
        claimAgentTab: jest.fn().mockResolvedValue({
          ok: true,
          claimed: true,
          state: {
            status: 'ready',
            conversationId: 'conversation_live',
            taskTabs: [],
            agentTabs: [],
          },
        }),
      },
    });

    ctx.elements['agent-session-list'].children[0].children[0].dispatch('click');
    await flush();

    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'Live conversation and workspace restored.'
    );
    expect(ctx.setAgentTabCustody).toHaveBeenLastCalledWith([agentTab]);

    const claimHandler = ctx.setAgentTabClaimHandler.mock.calls[0][0];
    await claimHandler(8);

    expect(ctx.electronAPI.claimAgentTab).toHaveBeenCalledWith(8);
    expect(ctx.setAgentTabCustody).toHaveBeenLastCalledWith([]);
    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'This tab is now yours. Agent no longer controls it.'
    );
  });

  test('renames and deletes saved sessions from their sidebar menu', async () => {
    const sessions = [
      {
        conversationId: 'conversation_saved',
        title: 'Original title',
        status: 'ready',
        turnCount: 2,
      },
    ];
    const ctx = await loadAgentUi({
      electronAPI: {
        listAgentSessions: jest.fn().mockResolvedValue({ ok: true, sessions }),
        renameAgentSession: jest.fn().mockResolvedValue({
          ok: true,
          session: { ...sessions[0], title: 'Renamed title' },
        }),
        deleteAgentSession: jest.fn().mockResolvedValue({ ok: true, deleted: true }),
      },
      windowGlobals: {
        prompt: jest.fn(() => 'Renamed title'),
        confirm: jest.fn(() => true),
      },
    });

    let row = ctx.elements['agent-session-list'].children[0];
    row.children[1].dispatch('click');
    row.children[2].children[0].dispatch('click');
    await flush();
    expect(ctx.electronAPI.renameAgentSession).toHaveBeenCalledWith(
      'conversation_saved',
      'Renamed title'
    );

    row = ctx.elements['agent-session-list'].children[0];
    row.children[1].dispatch('click');
    row.children[2].children[1].dispatch('click');
    await flush();
    expect(global.window.confirm).toHaveBeenCalledWith(
      'Delete “Original title”? This cannot be undone.'
    );
    expect(ctx.electronAPI.deleteAgentSession).toHaveBeenCalledWith('conversation_saved');
  });

  test('uses a collapsible three-pane shell and inspects owned pages without leaving Agent-first', async () => {
    const getOpenTabs = () => [
      {
        id: 7,
        url: 'https://unrelated.example/',
        title: 'Unrelated page',
        favicon: '',
        isLoading: false,
        isActive: true,
      },
      {
        id: 8,
        url: 'https://en.wikipedia.org/wiki/Agent',
        title: 'Agent — Wikipedia',
        favicon: '',
        isLoading: false,
        isActive: false,
      },
    ];
    const ctx = await loadAgentUi({
      getOpenTabs,
      electronAPI: {
        listAgentSessions: jest.fn().mockResolvedValue({
          ok: true,
          sessions: [
            {
              conversationId: 'conversation_restored',
              title: 'Compare agent definitions',
              status: 'ready',
              turnCount: 1,
            },
          ],
        }),
        getAgentState: jest.fn().mockResolvedValue({
          ok: true,
          state: {
            status: 'ready',
            conversationId: 'conversation_restored',
            rendererTabId: 7,
            approvalMode: 'every_interaction',
            transcript: [
              {
                runId: 'run_restored',
                userText: 'Compare agent definitions',
                assistantText: 'Ready.',
                status: 'completed',
                activity: [],
              },
            ],
            taskTabs: [{ rendererTabId: 8, agentActive: true }],
          },
        }),
      },
    });

    ctx.elements['agent-toggle-btn'].dispatch('click');
    await flush();
    expect(ctx.elements['agent-first-toggle'].hidden).toBe(false);

    ctx.elements['agent-first-toggle'].dispatch('click');
    await flush();

    expect(ctx.document.body.classList.contains('agent-first-mode')).toBe(true);
    expect(ctx.elements['agent-first-titlebar'].hidden).toBe(false);
    expect(ctx.elements['agent-session-sidebar'].hidden).toBe(false);
    expect(ctx.elements['agent-session-list'].children).toHaveLength(1);
    expect(
      ctx.elements['agent-session-list'].children[0].classList.contains('active')
    ).toBe(true);
    expect(ctx.elements['agent-first-title'].textContent).toBe('Compare agent definitions');
    expect(ctx.elements['agent-task-pages'].hidden).toBe(false);
    expect(ctx.elements['agent-task-page-count'].textContent).toBe('1');
    expect(ctx.setTabStripProjection).toHaveBeenLastCalledWith({
      container: ctx.elements['agent-task-page-list'],
      tabIds: [8],
    });
    expect(ctx.setWorkspaceNavigationProjection).toHaveBeenLastCalledWith(
      ctx.elements['agent-workspace-address-host']
    );
    expect(ctx.document.body.classList.contains('agent-first-mode')).toBe(true);

    ctx.elements['agent-session-sidebar-toggle'].dispatch('click');
    ctx.elements['agent-workspace-sidebar-toggle'].dispatch('click');
    expect(ctx.document.body.classList.contains('agent-session-sidebar-closed')).toBe(true);
    expect(ctx.document.body.classList.contains('agent-workspace-sidebar-closed')).toBe(true);

    ctx.elements['agent-first-browser-return'].dispatch('click');
    expect(ctx.document.body.classList.contains('agent-first-mode')).toBe(false);
    expect(ctx.elements['agent-sidebar'].classList.contains('collapsed')).toBe(false);
    expect(ctx.setTabStripProjection).toHaveBeenLastCalledWith();
    expect(ctx.setWorkspaceNavigationProjection).toHaveBeenLastCalledWith();
  });

  test('delegates workspace address editing policy to shared browser navigation', async () => {
    const ctx = await loadAgentUi();

    expect(ctx.setWorkspaceNavigationEditable).toHaveBeenLastCalledWith(true);

    ctx.elements['agent-prompt'].value = 'Inspect this page';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    expect(ctx.setWorkspaceNavigationEditable).toHaveBeenLastCalledWith(false);

    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({ type: 'run_paused', runId: 'run_test' });
    expect(ctx.setWorkspaceNavigationEditable).toHaveBeenLastCalledWith(true);

    ctx.emit({ type: 'run_resumed', runId: 'run_test' });
    expect(ctx.setWorkspaceNavigationEditable).toHaveBeenLastCalledWith(false);
  });

  test('translates wheel gestures into horizontal workspace tab scrolling', async () => {
    const ctx = await loadAgentUi();
    const tabList = ctx.elements['agent-task-page-list'];
    tabList.scrollWidth = 600;
    tabList.clientWidth = 240;
    tabList.scrollLeft = 0;
    const preventDefault = jest.fn();

    tabList.dispatch('wheel', { deltaX: 0, deltaY: 52, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(tabList.scrollLeft).toBe(52);
  });

  test('resizes both Agent-first sidebars with pointer and keyboard input', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-toggle-btn'].dispatch('click');
    await flush();
    ctx.elements['agent-first-toggle'].dispatch('click');

    const sessionHandle = ctx.elements['agent-session-resizer'];
    sessionHandle.dispatch('pointerdown', {
      button: 0,
      pointerId: 1,
      preventDefault: jest.fn(),
    });
    sessionHandle.dispatch('pointermove', { pointerId: 1, clientX: 320 });
    expect(ctx.document.body.style['--agent-session-sidebar-width']).toBe('320px');
    expect(sessionHandle.attributes['aria-valuenow']).toBe('320');
    expect(ctx.document.body.classList.contains('agent-sidebar-resizing')).toBe(true);
    sessionHandle.dispatch('pointerup', { pointerId: 1 });
    expect(ctx.document.body.classList.contains('agent-sidebar-resizing')).toBe(false);

    const workspaceHandle = ctx.elements['agent-workspace-resizer'];
    workspaceHandle.dispatch('pointerdown', {
      button: 0,
      pointerId: 2,
      preventDefault: jest.fn(),
    });
    workspaceHandle.dispatch('pointermove', { pointerId: 2, clientX: 760 });
    workspaceHandle.dispatch('pointerup', { pointerId: 2 });
    expect(ctx.document.body.style['--agent-workspace-sidebar-width']).toBe('520px');

    workspaceHandle.dispatch('keydown', { key: 'ArrowLeft', preventDefault: jest.fn() });
    expect(ctx.document.body.style['--agent-workspace-sidebar-width']).toBe('536px');
    workspaceHandle.dispatch('dblclick');
    expect(ctx.document.body.style['--agent-workspace-sidebar-width']).toBeUndefined();
  });

  test('sanitizes completed assistant Markdown with a restricted element allowlist', async () => {
    const sanitize = jest.fn(() => '<p>Safe response</p>');
    const ctx = await loadAgentUi({
      windowGlobals: {
        marked: { parse: jest.fn(() => '<img src=x onerror=alert(1)><p>Safe response</p>') },
        DOMPurify: { sanitize },
      },
    });
    ctx.elements['agent-prompt'].value = 'Summarize';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Summarize',
    });
    ctx.emit({
      type: 'assistant_text_delta',
      conversationId: 'conversation_test',
      runId: 'run_test',
      text: '<img src=x onerror=alert(1)>Safe response',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
    });

    expect(sanitize).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ ALLOWED_ATTR: [] })
    );
    const allowedTags = sanitize.mock.calls[0][1].ALLOWED_TAGS;
    expect(allowedTags).not.toContain('img');
    expect(allowedTags).not.toContain('a');
    expect(ctx.elements['agent-transcript'].querySelector('.agent-output').innerHTML).toBe(
      '<p>Safe response</p>'
    );
  });

  test('falls back to text when completed assistant Markdown cannot be rendered', async () => {
    const ctx = await loadAgentUi({
      windowGlobals: {
        marked: { parse: jest.fn(() => '<p>Response</p>') },
        DOMPurify: {
          sanitize: jest.fn(() => {
            throw new Error('sanitizer failed');
          }),
        },
      },
    });
    ctx.elements['agent-prompt'].value = 'Summarize';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Summarize',
    });
    ctx.emit({
      type: 'assistant_text_delta',
      conversationId: 'conversation_test',
      runId: 'run_test',
      text: '<unsafe>Response',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
    });

    expect(ctx.elements['agent-run-status'].textContent).toBe('Complete');
    expect(ctx.elements['agent-transcript'].querySelector('.agent-output').textContent).toBe(
      '<unsafe>Response'
    );
  });

  test('keeps the assigned tab marked until the user takes over', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Complete the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });

    expect(ctx.elements['agent-run-message'].textContent).toContain('stays attached to this tab');
    ctx.elements['agent-stop'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.stopAgent).toHaveBeenCalledWith('run_test');
    expect(ctx.elements['agent-run-message'].textContent).toBe('Taking over…');

    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'cancelled' });
    expect(ctx.elements['agent-run-status'].textContent).toBe('Taken over');
    expect(ctx.elements['agent-run-message'].textContent).toBe('You took control of the tab');
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(null);
  });

  test('keeps the run attached while paused and resumes it explicitly', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Complete the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });

    ctx.elements['agent-pause'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.pauseAgent).toHaveBeenCalledWith('run_test');

    ctx.emit({ type: 'run_pausing', runId: 'run_test' });
    ctx.emit({ type: 'run_paused', runId: 'run_test' });
    expect(ctx.elements['agent-run-status'].textContent).toBe('Paused');
    expect(ctx.elements['agent-pause'].hidden).toBe(true);
    expect(ctx.elements['agent-resume'].hidden).toBe(false);
    expect(ctx.elements['agent-stop'].disabled).toBe(false);
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(7);

    ctx.elements['agent-resume'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.resumeAgent).toHaveBeenCalledWith('run_test');
    ctx.emit({ type: 'run_resuming', runId: 'run_test' });
    ctx.emit({ type: 'run_resumed', runId: 'run_test' });

    expect(ctx.elements['agent-run-status'].textContent).toBe('Running');
    expect(ctx.elements['agent-pause'].hidden).toBe(false);
    expect(ctx.elements['agent-pause'].disabled).toBe(false);
    expect(ctx.elements['agent-resume'].hidden).toBe(true);
    expect(ctx.elements['agent-run-message'].textContent).toContain('re-reading');
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(7);

    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'completed' });
  });

  test('withdraws approval UI on pause and reports a refused resume without detaching', async () => {
    const ctx = await loadAgentUi({
      electronAPI: {
        resumeAgent: jest.fn().mockResolvedValue({
          ok: false,
          error: {
            code: 'AGENT_RESUME_SCOPE_CHANGED',
            message: "The controlled tab left the task's starting site.",
          },
        }),
      },
    });
    ctx.elements['agent-prompt'].value = 'Submit the form';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_test',
      action: 'form_submission',
    });
    ctx.emit({
      type: 'approval_resolved',
      runId: 'run_test',
      approvalId: 'approval_test',
      decision: 'withdrawn',
    });
    ctx.emit({ type: 'run_pausing', runId: 'run_test' });
    ctx.emit({ type: 'run_paused', runId: 'run_test' });

    expect(ctx.elements['agent-approval'].hidden).toBe(true);
    ctx.elements['agent-resume'].dispatch('click');
    await flush();

    expect(ctx.elements['agent-run-status'].textContent).toBe('Paused');
    expect(ctx.elements['agent-run-message'].textContent).toContain('left the task');
    expect(ctx.elements['agent-run-message'].classList.contains('error')).toBe(true);
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(7);

    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'cancelled' });
  });

  test('renders form approval details as text and sends a one-shot decision', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Submit the form';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_test',
      action: 'form_submission',
      origin: 'https://trusted.example',
      label: '<img src=x onerror=alert(1)>',
    });

    expect(ctx.elements['agent-approval'].hidden).toBe(false);
    expect(ctx.elements['agent-run-status'].textContent).toBe('Approval needed');
    expect(ctx.elements['agent-approval-action'].textContent).toContain(
      '<img src=x onerror=alert(1)>'
    );
    expect(ctx.elements['agent-approval-action'].children).toHaveLength(0);
    expect(ctx.elements['agent-approval-origin'].textContent).toContain('https://trusted.example');

    ctx.elements['agent-approval-approve'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_test',
      true
    );

    ctx.emit({
      type: 'approval_resolved',
      runId: 'run_test',
      approvalId: 'approval_test',
      decision: 'approved',
    });
    expect(ctx.elements['agent-approval'].hidden).toBe(true);
    expect(ctx.elements['agent-run-status'].textContent).toBe('Running');
  });

  test('keeps the conversation reusable after a failed run', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Complete the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });

    ctx.emit({
      type: 'run_finished',
      runId: 'run_test',
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'The agent could not complete this turn',
      },
    });

    expect(ctx.elements['agent-run-status'].textContent).toBe('failed');
    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'The agent could not complete this turn'
    );
    ctx.elements['agent-prompt'].value = 'Try a different approach';
    ctx.elements['agent-prompt'].dispatch('input');
    expect(ctx.elements['agent-run'].disabled).toBe(false);
    expect(ctx.elements['agent-stop'].disabled).toBe(true);
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(null);
  });

  test('connects a ChatGPT subscription without exposing OAuth credentials', async () => {
    let resolveLogin;
    const loginPromise = new Promise((resolve) => {
      resolveLogin = resolve;
    });
    const ctx = await loadAgentUi({
      electronAPI: { loginSubscriptionAgentProvider: jest.fn(() => loginPromise) },
    });
    ctx.elements['agent-toggle-btn'].dispatch('click');
    await flush();
    ctx.elements['agent-provider-select'].value = 'openai-codex';
    ctx.elements['agent-provider-select'].dispatch('change');
    ctx.elements['agent-model-select'].value = 'codex-model';

    expect(ctx.elements['agent-api-key-field'].classList.contains('hidden')).toBe(true);
    expect(ctx.elements['agent-provider-save'].hidden).toBe(true);
    expect(ctx.elements['agent-provider-login'].hidden).toBe(false);
    ctx.elements['agent-provider-login'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.loginSubscriptionAgentProvider).toHaveBeenCalledWith(
      'openai-codex',
      'codex-model'
    );
    ctx.emitProviderAuth({
      type: 'device_code',
      providerId: 'openai-codex',
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
    });
    expect(ctx.elements['agent-auth-user-code'].textContent).toBe('ABCD-1234');
    expect(ctx.elements['agent-auth-code'].hidden).toBe(false);
    expect(ctx.elements['agent-provider-message'].textContent).toContain('OpenAI page');

    resolveLogin({
      ok: true,
      status: {
        configured: true,
        kind: 'subscription',
        providerId: 'openai-codex',
        modelId: 'codex-model',
      },
    });
    await flush();
    expect(ctx.elements['agent-provider-status'].textContent).toBe('ChatGPT (Codex) · codex-model');
    expect(ctx.elements['agent-provider-message'].textContent).toBe(
      'ChatGPT connected for this profile'
    );
    expect(ctx.elements['agent-provider-login'].hidden).toBe(true);
  });

  test('never initializes provider or run IPC in a private window', async () => {
    const ctx = await loadAgentUi({ isPrivate: true });

    expect(ctx.elements['agent-toggle-btn'].classList.contains('hidden')).toBe(true);
    expect(ctx.electronAPI.getAgentProviderStatus).not.toHaveBeenCalled();
    expect(ctx.electronAPI.getAgentProviderCatalog).not.toHaveBeenCalled();
    expect(ctx.electronAPI.listAgentSessions).not.toHaveBeenCalled();
    expect(ctx.electronAPI.onAgentEvent).not.toHaveBeenCalled();
    expect(ctx.electronAPI.onAgentProviderAuthEvent).not.toHaveBeenCalled();
  });

  test('formats tool operations for a compact activity timeline', async () => {
    const ctx = await loadAgentUi();
    expect(ctx.mod.formatOperation('browser_get_page_text')).toBe('get page text');
    expect(ctx.mod.providerPrivacyMessage('freepi')).toContain('sent to Free Pi');
    expect(ctx.elements['agent-provider-privacy'].textContent).toContain('sent to OpenAI');

    ctx.elements['agent-provider-select'].value = 'ollama';
    ctx.elements['agent-provider-select'].dispatch('change');
    expect(ctx.elements['agent-provider-privacy'].textContent).toBe(
      'Model requests stay on this device and are sent only to your local Ollama server.'
    );
    expect(ctx.mod.responseMessage({}, 'Fallback')).toBe('Fallback');
  });

  test('does not resurrect a run that finishes before start IPC resolves', async () => {
    let resolveStart;
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const ctx = await loadAgentUi({
      electronAPI: { startAgent: jest.fn(() => startPromise) },
    });
    ctx.elements['agent-prompt'].value = 'Quick task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    ctx.emit({ type: 'run_started', runId: 'run_fast' });
    ctx.emit({ type: 'run_finished', runId: 'run_fast', status: 'completed' });
    resolveStart({ ok: true, runId: 'run_fast' });
    await flush();

    expect(ctx.elements['agent-run-status'].textContent).toBe('Complete');
    expect(ctx.elements['agent-run'].disabled).toBe(true);
    expect(ctx.elements['agent-stop'].disabled).toBe(true);
  });
});
