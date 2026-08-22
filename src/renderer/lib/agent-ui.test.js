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
    'agent-provider-clear',
    'agent-auth-code',
    'agent-auth-user-code',
    'agent-provider-message',
    'agent-prompt',
    'agent-run',
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
    'agent-output',
    'agent-activity',
    'agent-tool-list',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, createElement('div')]));
  elements['agent-toggle-btn'] = createElement('button');
  elements['agent-sidebar'] = createElement('aside', { classes: ['collapsed'] });
  elements['agent-sidebar-close'] = createElement('button');
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
  elements['agent-provider-clear'] = createElement('button');
  elements['agent-auth-code'].hidden = true;
  elements['agent-prompt'] = createElement('textarea');
  elements['agent-run'] = createElement('button');
  elements['agent-pause'] = createElement('button', { disabled: true });
  elements['agent-pause'].hidden = true;
  elements['agent-resume'] = createElement('button', { disabled: true });
  elements['agent-resume'].hidden = true;
  elements['agent-stop'] = createElement('button', { disabled: true });
  elements['agent-approval'] = createElement('div');
  elements['agent-approval'].hidden = true;
  elements['agent-approval-approve'] = createElement('button');
  elements['agent-approval-decline'] = createElement('button');
  elements['agent-transcript'].hidden = true;
  elements['agent-activity'].hidden = true;
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
      status: { configured: false, secureStorageAvailable: true },
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
    clearAgentProvider: jest.fn(),
    getAgentState: jest.fn().mockResolvedValue({ ok: true, state: { status: 'idle' } }),
    startAgent: jest.fn().mockResolvedValue({ ok: true, runId: 'run_test' }),
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
  global.window = { electronAPI };
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
  const mod = await import('./agent-ui.js');
  mod.initAgentUi({ getActiveTab: () => ({ id: 7 }), setAgentControlledTab });
  await flush();
  return {
    mod,
    elements,
    document,
    electronAPI,
    sidebar,
    setAgentControlledTab,
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
    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(7, 'Summarize this page');

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

    expect(ctx.elements['agent-output'].textContent).toBe('<img src=x onerror=alert(1)>Summary');
    expect(ctx.elements['agent-output'].children).toHaveLength(0);
    expect(ctx.elements['agent-tool-list'].children[0].children[0].textContent).toBe('✓');
    expect(ctx.elements['agent-run-status'].textContent).toBe('Complete');
    expect(ctx.elements['agent-run'].disabled).toBe(false);
    expect(ctx.setAgentControlledTab).toHaveBeenNthCalledWith(1, 7);
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(null);
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
            message: 'The controlled tab left the task\'s starting site.',
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

  test('reports controlled-tab closure as a distinct terminal state', async () => {
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
        code: 'AGENT_TAB_CLOSED',
        message: 'The controlled browser tab was closed',
      },
    });

    expect(ctx.elements['agent-run-status'].textContent).toBe('Tab closed');
    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'The controlled browser tab was closed'
    );
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
    expect(ctx.elements['agent-run'].disabled).toBe(false);
    expect(ctx.elements['agent-stop'].disabled).toBe(true);
  });
});
