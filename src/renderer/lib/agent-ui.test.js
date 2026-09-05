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
    'agent-page-contexts',
    'agent-page-context',
    'agent-page-context-label',
    'agent-composer',
    'agent-prompt',
    'agent-run',
    'agent-new-chat',
    'agent-page-interlock',
    'agent-page-lock-trigger',
    'agent-page-lock-hint',
    'agent-takeover-dialog',
    'agent-takeover-cancel',
    'agent-takeover-confirm',
    'agent-run-status',
    'agent-run-message',
    'agent-approval',
    'agent-approval-action',
    'agent-approval-origin',
    'agent-workspace-permission-details',
    'agent-workspace-permission-summary',
    'agent-approval-approve',
    'agent-approval-allow-conversation',
    'agent-approval-decline',
    'agent-approval-stop',
    'agent-approval-message',
    'agent-wallet-approval-details',
    'agent-wallet-approval-summary',
    'agent-node-request-details',
    'agent-node-request-summary',
    'agent-publication-details',
    'agent-publication-summary',
    'agent-wallet-account-field',
    'agent-wallet-account',
    'agent-wallet-unlock',
    'agent-wallet-password',
    'agent-wallet-unlock-submit',
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
    'agent-attachment-button',
    'agent-attachment-menu',
    'agent-attach-files',
    'agent-attach-folder',
    'agent-attachment-contexts',
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
  elements['agent-page-contexts'].hidden = true;
  elements['agent-page-context'] = createElement('button');
  elements['agent-composer'] = createElement('div');
  elements['agent-prompt'] = createElement('textarea');
  elements['agent-run'] = createElement('button');
  elements['agent-new-chat'] = createElement('button');
  elements['agent-new-chat'].hidden = true;
  elements['agent-page-interlock'] = createElement('div');
  elements['agent-page-interlock'].hidden = true;
  elements['agent-page-lock-trigger'] = createElement('button');
  elements['agent-page-lock-hint'] = createElement('div');
  elements['agent-takeover-dialog'] = createElement('section');
  elements['agent-takeover-dialog'].hidden = true;
  elements['agent-takeover-cancel'] = createElement('button');
  elements['agent-takeover-confirm'] = createElement('button');
  elements['agent-takeover-dialog'].appendChild(elements['agent-takeover-cancel']);
  elements['agent-takeover-dialog'].appendChild(elements['agent-takeover-confirm']);
  elements['agent-page-lock-trigger'].appendChild(elements['agent-page-lock-hint']);
  elements['agent-page-interlock'].appendChild(elements['agent-page-lock-trigger']);
  elements['agent-page-interlock'].appendChild(elements['agent-takeover-dialog']);
  elements['agent-approval'] = createElement('div');
  elements['agent-approval'].hidden = true;
  elements['agent-approval-approve'] = createElement('button');
  elements['agent-approval-allow-conversation'] = createElement('button');
  elements['agent-approval-decline'] = createElement('button');
  elements['agent-approval-stop'] = createElement('button');
  elements['agent-wallet-approval-details'].hidden = true;
  elements['agent-wallet-approval-summary'] = createElement('dl');
  elements['agent-node-request-details'].hidden = true;
  elements['agent-node-request-summary'] = createElement('dl');
  elements['agent-publication-details'].hidden = true;
  elements['agent-publication-summary'] = createElement('dl');
  elements['agent-wallet-account-field'].hidden = true;
  elements['agent-wallet-account'] = createElement('select');
  elements['agent-wallet-unlock'].hidden = true;
  elements['agent-wallet-password'] = createElement('input');
  elements['agent-wallet-unlock-submit'] = createElement('button');
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
  elements['agent-approval-mode-sensitive'] = createElement('button');
  elements['agent-approval-mode-sensitive'].appendChild(createElement('span'));
  elements['agent-approval-mode-sensitive'].appendChild(
    createElement('span', { classes: ['agent-approval-mode-check'] })
  );
  elements['agent-approval-mode-allow'] = createElement('button');
  elements['agent-approval-mode-allow'].appendChild(createElement('span'));
  elements['agent-approval-mode-allow'].appendChild(
    createElement('span', { classes: ['agent-approval-mode-check'] })
  );
  elements['agent-attachment-button'] = createElement('button');
  elements['agent-attachment-menu'] = createElement('div');
  elements['agent-attachment-menu'].hidden = true;
  elements['agent-attach-files'] = createElement('button');
  elements['agent-attach-folder'] = createElement('button');
  elements['agent-attachment-contexts'] = createElement('div');
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
    steerAgent: jest.fn().mockResolvedValue({
      ok: true,
      guidance: {
        guidanceId: 'guidance_test',
        text: 'Focus on primary sources',
        status: 'queued',
      },
    }),
    clearAgentConversation: jest.fn().mockResolvedValue({ ok: true, cleared: true }),
    listAgentSessions: jest.fn().mockResolvedValue({ ok: true, sessions: [] }),
    openAgentSession: jest.fn(),
    renameAgentSession: jest.fn(),
    deleteAgentSession: jest.fn(),
    pickAgentFiles: jest.fn().mockResolvedValue({ ok: true, selections: [] }),
    pickAgentFolder: jest.fn().mockResolvedValue({ ok: true, selections: [] }),
    removeAgentAttachment: jest.fn().mockResolvedValue({ ok: true, removed: true }),
    revokeAgentAttachment: jest.fn().mockResolvedValue({
      ok: true,
      revoked: true,
      resources: [],
    }),
    getAgentAttachmentPreview: jest.fn().mockResolvedValue({ ok: false }),
    setAgentApprovalMode: jest.fn(async (conversationId, approvalMode) => ({
      ok: true,
      conversationId,
      approvalMode,
    })),
    claimAgentTab: jest.fn(),
    openAgentArtifact: jest.fn().mockResolvedValue({ success: true }),
    showAgentArtifactInFolder: jest.fn().mockResolvedValue({ success: true }),
    openAgentPublication: jest.fn().mockResolvedValue({ ok: true, opened: true }),
    copyText: jest.fn().mockResolvedValue({ success: true }),
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
    identity: {
      getStatus: jest.fn().mockResolvedValue({ isUnlocked: true }),
      unlock: jest.fn().mockResolvedValue({ success: true }),
    },
    quickUnlock: {
      canUseTouchId: jest.fn().mockResolvedValue(false),
      isEnabled: jest.fn().mockResolvedValue(false),
      unlock: jest.fn(),
    },
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
  jest.doMock('./page-urls.js', () => ({ homeUrl: 'file:///app/pages/home.html' }));
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
    isTabAgentOwned: options.isTabAgentOwned || (() => false),
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

  test('focuses the composer when Agent opens and keeps it ready after sending', async () => {
    const ctx = await loadAgentUi();
    const focus = jest.spyOn(ctx.elements['agent-prompt'], 'focus');

    ctx.elements['agent-toggle-btn'].dispatch('click');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    focus.mockClear();
    ctx.elements['agent-prompt'].value = 'Summarize this page';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    focus.mockClear();
    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'completed' });
    expect(focus).not.toHaveBeenCalled();
  });

  test('does not reclaim focus claimed elsewhere while a send is starting', async () => {
    let resolveStart;
    const startPending = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const ctx = await loadAgentUi({
      electronAPI: { startAgent: jest.fn(() => startPending) },
    });
    ctx.elements['agent-toggle-btn'].dispatch('click');
    const focus = jest.spyOn(ctx.elements['agent-prompt'], 'focus');

    ctx.elements['agent-prompt'].value = 'Summarize this page';
    ctx.elements['agent-run'].dispatch('click');
    ctx.document.activeElement = ctx.elements['agent-sidebar-back'];
    resolveStart({
      ok: true,
      runId: 'run_test',
      conversationId: 'conversation_test',
    });
    await flush();

    expect(focus).not.toHaveBeenCalled();
  });

  test('focuses the composer on Agent-first entry but not over an approval', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-toggle-btn'].dispatch('click');
    const focus = jest.spyOn(ctx.elements['agent-prompt'], 'focus');

    ctx.elements['agent-first-toggle'].dispatch('click');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    ctx.elements['agent-prompt'].value = 'Submit the form';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_test',
      action: 'form_submission',
      label: 'Submit',
    });
    focus.mockClear();
    ctx.elements['agent-first-toggle'].dispatch('click');
    ctx.elements['agent-first-toggle'].dispatch('click');
    expect(focus).not.toHaveBeenCalled();
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

  test('adds opaque file and folder selections through the composer drop-up', async () => {
    const fileSelectionId = `selection_${'a'.repeat(20)}`;
    const folderSelectionId = `selection_${'b'.repeat(20)}`;
    const ctx = await loadAgentUi({
      electronAPI: {
        pickAgentFiles: jest.fn().mockResolvedValue({
          ok: true,
          selections: [
            {
              selectionId: fileSelectionId,
              kind: 'file',
              name: 'notes.txt',
              category: 'text',
              bytes: 2_048,
            },
          ],
        }),
        pickAgentFolder: jest.fn().mockResolvedValue({
          ok: true,
          selections: [
            {
              selectionId: folderSelectionId,
              kind: 'folder',
              name: 'Project',
              category: 'folder',
              available: true,
            },
          ],
        }),
      },
    });

    ctx.elements['agent-attachment-button'].dispatch('click');
    expect(ctx.elements['agent-attachment-menu'].hidden).toBe(false);
    ctx.elements['agent-attach-files'].dispatch('click');
    await flush();
    ctx.elements['agent-attachment-button'].dispatch('click');
    ctx.elements['agent-attach-folder'].dispatch('click');
    await flush();

    expect(ctx.elements['agent-attachment-contexts'].children).toHaveLength(2);
    expect(ctx.elements['agent-attachment-contexts'].children[0].children[0].textContent).toContain(
      'notes.txt'
    );
    expect(ctx.elements['agent-attachment-contexts'].children[1].children[0].textContent).toContain(
      'Project'
    );

    ctx.elements['agent-prompt'].value = 'Review these resources';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      7,
      'Review these resources',
      'every_interaction',
      [fileSelectionId, folderSelectionId]
    );

    ctx.emit({
      type: 'run_started',
      runId: 'run_test',
      conversationId: 'conversation_test',
      userText: 'Review these resources',
      attachments: [
        {
          resourceId: `attachment_${'c'.repeat(20)}`,
          kind: 'file',
          name: 'notes.txt',
          category: 'text',
          bytes: 2_048,
          available: true,
        },
        {
          resourceId: `folder_${'d'.repeat(20)}`,
          kind: 'folder',
          name: 'Project',
          category: 'folder',
          available: true,
        },
        {
          resourceId: `attachment_${'e'.repeat(20)}`,
          kind: 'file',
          name: 'founding-document.pdf',
          category: 'pdf',
          bytes: 4_096,
          available: true,
        },
        {
          resourceId: `attachment_${'f'.repeat(20)}`,
          kind: 'file',
          name: 'diagram.png',
          category: 'image',
          bytes: 8_192,
          available: true,
        },
        {
          resourceId: `attachment_${'1'.repeat(20)}`,
          kind: 'file',
          name: 'worker.ts',
          category: 'text',
          bytes: 1_024,
          available: true,
        },
      ],
    });
    const sentAttachments = ctx.elements['agent-transcript'].querySelectorAll(
      '.agent-message-attachment'
    );
    expect(sentAttachments).toHaveLength(5);
    expect(sentAttachments[0].dataset.kind).toBe('text');
    expect(sentAttachments[0].querySelector('.agent-message-attachment-badge').textContent).toBe(
      'TXT'
    );
    expect(sentAttachments[0].querySelector('.agent-message-attachment-name').textContent).toBe(
      'notes.txt'
    );
    expect(sentAttachments[1].dataset.kind).toBe('folder');
    expect(sentAttachments[1].querySelector('.agent-message-attachment-badge').textContent).toBe(
      'Folder'
    );
    expect(sentAttachments[2].dataset.kind).toBe('pdf');
    expect(sentAttachments[2].querySelector('.agent-message-attachment-badge').textContent).toBe(
      'PDF'
    );
    expect(sentAttachments[3].dataset.kind).toBe('image');
    expect(sentAttachments[3].querySelector('.agent-message-attachment-badge').textContent).toBe(
      'PNG'
    );
    expect(sentAttachments[4].dataset.kind).toBe('code');
    expect(sentAttachments[4].querySelector('.agent-message-attachment-badge').textContent).toBe(
      'TS'
    );
    const attachmentShelf =
      ctx.elements['agent-transcript'].querySelector('.agent-user-attachments');
    expect(attachmentShelf.getAttribute('role')).toBe('list');
    expect(attachmentShelf.getAttribute('aria-label')).toBe('Attached files and folders');
    expect(ctx.elements['agent-attachment-contexts'].children).toHaveLength(1);
    expect(ctx.elements['agent-attachment-contexts'].children[0].children[0].textContent).toContain(
      'Project'
    );
  });

  test('removes a pending attachment before it is sent', async () => {
    const selectionId = `selection_${'e'.repeat(20)}`;
    const ctx = await loadAgentUi({
      electronAPI: {
        pickAgentFiles: jest.fn().mockResolvedValue({
          ok: true,
          selections: [
            { selectionId, kind: 'file', name: 'draft.md', category: 'text', bytes: 10 },
          ],
        }),
      },
    });

    ctx.elements['agent-attach-files'].dispatch('click');
    await flush();
    ctx.elements['agent-attachment-contexts'].children[0].children[1].dispatch('click');
    await flush();

    expect(ctx.electronAPI.removeAgentAttachment).toHaveBeenCalledWith(selectionId);
    expect(ctx.elements['agent-attachment-contexts'].children).toHaveLength(0);
  });

  test('stops sharing a live folder without rewriting the historical turn', async () => {
    const folderId = `folder_${'f'.repeat(20)}`;
    const ctx = await loadAgentUi();
    ctx.emit({
      type: 'run_started',
      runId: 'run_test',
      conversationId: 'conversation_test',
      userText: 'Review this folder',
      attachments: [
        {
          resourceId: folderId,
          kind: 'folder',
          name: 'Bug reports',
          category: 'folder',
          available: true,
        },
      ],
    });

    const historicalAttachment = ctx.elements['agent-transcript'].querySelector(
      '.agent-message-attachment'
    );
    const liveChip = ctx.elements['agent-attachment-contexts'].children[0];
    expect(liveChip.children[1].title).toBe('Stop sharing this folder');

    liveChip.children[1].dispatch('click');
    await flush();

    expect(ctx.electronAPI.revokeAgentAttachment).toHaveBeenCalledWith(
      'conversation_test',
      folderId
    );
    expect(ctx.elements['agent-attachment-contexts'].children).toHaveLength(0);
    expect(historicalAttachment.querySelector('.agent-message-attachment-name').textContent).toBe(
      'Bug reports'
    );
    expect(ctx.elements['agent-run-message'].textContent).toContain(
      'content already read remains in this conversation'
    );
  });

  test('loads bounded image and PDF previews without replacing the fallback icon', async () => {
    const previewDataUrl = `data:image/png;base64,${Buffer.from('preview').toString('base64')}`;
    const getAgentAttachmentPreview = jest.fn().mockResolvedValue({
      ok: true,
      preview: {
        sourceKind: 'image',
        width: 64,
        height: 48,
        dataUrl: previewDataUrl,
      },
    });
    const ctx = await loadAgentUi({ electronAPI: { getAgentAttachmentPreview } });
    ctx.emit({
      type: 'run_started',
      runId: 'run_preview',
      conversationId: 'conversation_preview',
      userText: 'Review these',
      attachments: [
        {
          resourceId: `attachment_${'a'.repeat(20)}`,
          kind: 'file',
          name: 'diagram.png',
          category: 'image',
          available: true,
        },
        {
          resourceId: `attachment_${'b'.repeat(20)}`,
          kind: 'file',
          name: 'report.pdf',
          category: 'pdf',
          available: true,
        },
      ],
    });
    await flush();

    expect(getAgentAttachmentPreview).toHaveBeenCalledTimes(2);
    const tiles = ctx.elements['agent-transcript'].querySelectorAll('.agent-message-attachment');
    const image = tiles[0].querySelector('.agent-message-attachment-preview');
    const pdf = tiles[1].querySelector('.agent-message-attachment-preview');
    expect(image.src).toBe(previewDataUrl);
    expect(pdf.src).toBe(previewDataUrl);
    expect(tiles[0].querySelector('.agent-message-attachment-icon')).not.toBeNull();
    image.dispatch('load');
    expect(
      tiles[0].querySelector('.agent-message-attachment-visual').classList.contains('has-preview')
    ).toBe(true);
  });

  test('starts without page access instead of adopting an Agent-owned tab', async () => {
    const ctx = await loadAgentUi({ isTabAgentOwned: (tabId) => tabId === 7 });

    ctx.elements['agent-prompt'].value = 'Continue this work in a new chat';
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      null,
      'Continue this work in a new chat',
      'every_interaction'
    );
  });

  test('keeps the pristine homepage outside a new Agent workspace', async () => {
    const homeTab = {
      id: 7,
      url: 'file:///app/pages/home.html',
      title: 'New Tab',
      favicon: '',
      isLoading: false,
      isActive: true,
    };
    const ctx = await loadAgentUi({ getOpenTabs: () => [homeTab] });

    expect(ctx.elements['agent-page-contexts'].hidden).toBe(true);
    ctx.elements['agent-prompt'].value = 'Research five sources';
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      null,
      'Research five sources',
      'every_interaction'
    );
  });

  test('keeps the pristine homepage hidden when file and folder pills expose the context row', async () => {
    const homeTab = {
      id: 7,
      url: 'file:///app/pages/home.html',
      title: 'New Tab',
      favicon: '',
      isLoading: false,
      isActive: true,
    };
    const fileSelectionId = `selection_${'1'.repeat(20)}`;
    const folderSelectionId = `selection_${'2'.repeat(20)}`;
    const ctx = await loadAgentUi({
      getOpenTabs: () => [homeTab],
      electronAPI: {
        pickAgentFiles: jest.fn().mockResolvedValue({
          ok: true,
          selections: [
            {
              selectionId: fileSelectionId,
              kind: 'file',
              name: 'notes.txt',
              category: 'text',
              bytes: 20,
            },
          ],
        }),
        pickAgentFolder: jest.fn().mockResolvedValue({
          ok: true,
          selections: [
            {
              selectionId: folderSelectionId,
              kind: 'folder',
              name: 'Reports',
              category: 'folder',
              available: true,
            },
          ],
        }),
      },
    });

    ctx.elements['agent-attach-files'].dispatch('click');
    await flush();
    ctx.elements['agent-attach-folder'].dispatch('click');
    await flush();

    expect(ctx.elements['agent-page-contexts'].hidden).toBe(false);
    expect(ctx.elements['agent-page-context'].hidden).toBe(true);
    expect(ctx.elements['agent-attachment-contexts'].children).toHaveLength(2);

    ctx.elements['agent-prompt'].value = 'Review these';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      null,
      'Review these',
      'every_interaction',
      [fileSelectionId, folderSelectionId]
    );
  });

  test('shares an ordinary current page visibly and lets the user remove it', async () => {
    const ctx = await loadAgentUi();

    expect(ctx.elements['agent-page-contexts'].hidden).toBe(false);
    expect(ctx.elements['agent-page-context-label'].textContent).toBe('Current page · Start page');
    ctx.elements['agent-page-context'].dispatch('click');
    expect(ctx.elements['agent-page-contexts'].hidden).toBe(true);

    ctx.elements['agent-prompt'].value = 'Research independently';
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.startAgent).toHaveBeenCalledWith(
      null,
      'Research independently',
      'every_interaction'
    );
  });

  test('ignores a stale workspace refresh after New chat', async () => {
    let resolveStaleProjection;
    const getAgentState = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, state: { status: 'idle' } })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStaleProjection = resolve;
        })
      )
      .mockResolvedValue({ ok: true, state: { status: 'idle' } });
    const ctx = await loadAgentUi({ electronAPI: { getAgentState } });

    ctx.elements['agent-prompt'].value = 'Open supporting pages';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
    });
    ctx.elements['agent-new-chat'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.clearAgentConversation).toHaveBeenCalledTimes(1);
    expect(ctx.elements['agent-task-page-count'].textContent).toBe('1');

    resolveStaleProjection({
      ok: true,
      state: {
        status: 'ready',
        conversationId: 'conversation_test',
        taskTabs: [{ rendererTabId: 8, agentActive: true }],
        agentTabs: [
          {
            rendererTabId: 8,
            provenance: 'agent',
            custody: 'agent',
            conversationId: 'conversation_test',
          },
        ],
      },
    });
    await flush();

    expect(ctx.elements['agent-task-page-count'].textContent).toBe('1');
    expect(ctx.setAgentTabCustody).toHaveBeenLastCalledWith([]);
  });

  test('selects each website interaction approval behavior', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-approval-mode-sensitive'].dispatch('click');

    expect(ctx.elements['agent-active-approval-mode-label'].textContent).toBe('Ask when needed');
    expect(ctx.elements['agent-approval-mode-sensitive'].getAttribute('aria-pressed')).toBe('true');

    ctx.elements['agent-approval-mode-allow'].dispatch('click');

    expect(ctx.elements['agent-active-approval-mode-label'].textContent).toBe(
      'Allow website actions'
    );
    expect(ctx.elements['agent-approval-mode-allow'].getAttribute('aria-pressed')).toBe('true');
    expect(ctx.elements['agent-approval-mode-sensitive'].disabled).toBe(false);

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

  test('explains an intent-classified consequential website approval honestly', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Publish my response';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_consequential',
      action: 'browser_interaction',
      operation: 'browser_click',
      origin: 'https://community.example/post/1',
      label: 'Publish',
      interaction: {
        kind: 'consequential',
        confidence: 0.98,
        summary: 'Publish the comment.',
        uncertainties: [],
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe('Publish the comment?');
    expect(ctx.elements['agent-approval-origin'].textContent).toContain(
      'Based on Agent’s stated intent and the visible target on community.example'
    );
    expect(ctx.elements['agent-approval-origin'].textContent).toContain(
      'Freedom has not audited the page’s hidden behavior.'
    );
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
    expect(ctx.elements['agent-approval-mode-button'].disabled).toBe(false);
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

  test('changes approval mode between turns while keeping it locked during a run', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_first',
      userText: 'Inspect this page',
      approvalMode: 'every_interaction',
    });
    expect(ctx.elements['agent-approval-mode-button'].disabled).toBe(true);
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_first',
      status: 'completed',
    });
    expect(ctx.elements['agent-approval-mode-button'].disabled).toBe(false);

    ctx.elements['agent-approval-mode-button'].dispatch('click');
    ctx.elements['agent-approval-mode-allow'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.setAgentApprovalMode).toHaveBeenCalledWith(
      'conversation_test',
      'allow_website_interactions'
    );
    expect(ctx.elements['agent-active-approval-mode-label'].textContent).toBe(
      'Allow website actions'
    );
    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'Approval setting updated for the next message.'
    );

    ctx.elements['agent-prompt'].value = 'Now submit the form';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.startAgent).toHaveBeenLastCalledWith(
      null,
      'Now submit the form',
      'allow_website_interactions'
    );
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

  test('renders verified download receipts with trusted file actions', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Download the report';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Download the report',
    });
    ctx.emit({
      type: 'tool_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_download',
      operation: 'browser_download',
      intent: 'Downloading a file',
    });
    ctx.emit({
      type: 'tool_progress',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_download',
      operation: 'browser_download',
      receivedBytes: 1024,
      totalBytes: 2048,
      state: 'in_progress',
    });
    const artifact = {
      artifactId: 'artifact_1234567890abcdef1234',
      filename: 'report.pdf',
      bytes: 2048,
      state: 'completed',
      location: 'downloads',
      available: true,
    };
    ctx.emit({
      type: 'tool_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_download',
      operation: 'browser_download',
      status: 'succeeded',
      label: 'Downloaded report.pdf',
      artifact,
    });

    const turn = ctx.elements['agent-transcript'].children[0];
    const artifactList = turn.querySelector('.agent-artifact-list');
    expect(artifactList.hidden).toBe(false);
    expect(artifactList.children[0].children[0].children[0].textContent).toBe('report.pdf');
    expect(artifactList.children[0].children[0].children[1].textContent).not.toContain('/Users/');
    artifactList.children[0].children[1].children[0].dispatch('click');
    await flush();
    expect(ctx.electronAPI.openAgentArtifact).toHaveBeenCalledWith(artifact.artifactId);
  });

  test('renders a cancelled download without exposing a phantom artifact', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Download the image';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Download the image',
    });
    ctx.emit({
      type: 'tool_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_download',
      operation: 'browser_download',
      intent: 'Downloading a file',
    });
    ctx.emit({
      type: 'tool_progress',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_download',
      operation: 'browser_download',
      receivedBytes: 0,
      totalBytes: 6_000_000_000,
      state: 'cancelled',
      artifact: {
        artifactId: 'artifact_1234567890abcdef1234',
        filename: 'large.iso',
        bytes: 0,
        state: 'cancelled',
        location: 'downloads',
        available: false,
      },
    });
    ctx.emit({
      type: 'tool_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_download',
      operation: 'browser_download',
      status: 'failed',
      errorCode: 'DOWNLOAD_CANCELLED_BY_USER',
      label: 'Downloaded a file',
      approval: 'approved',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
      durationMs: 1_000,
      actionCount: 1,
      outcome: {
        kind: 'completed',
        verification: 'download_cancelled',
        tone: 'neutral',
        headline: 'Download cancelled',
        detail: 'You stopped the transfer. Freedom did not record a completed file.',
      },
    });

    const turn = ctx.elements['agent-transcript'].children[0];
    const toolRow = turn.querySelector('.agent-tool-item');
    expect(toolRow.classList.contains('failed')).toBe(false);
    expect(toolRow.classList.contains('cancelled')).toBe(true);
    expect(toolRow.children[0].textContent).toBe('•');
    expect(toolRow.children[1].textContent).toContain('Download cancelled by you');
    expect(toolRow.children[2].textContent).toBe('Cancelled by you');
    expect(turn.querySelector('.agent-artifact-list').hidden).toBe(true);
    expect(turn.querySelector('.agent-turn-outcome').classList.contains('neutral')).toBe(true);
    expect(turn.querySelector('.agent-turn-activity').children[0].textContent).toContain(
      'Download cancelled'
    );
  });

  test('shows live browser intent and trusted completion evidence', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Update the profile';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Update the profile',
    });
    ctx.emit({
      type: 'tool_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_snapshot',
      operation: 'browser_snapshot',
      intent: 'Reading https://example.test',
      label: 'Read https://example.test',
    });

    expect(ctx.elements['agent-run-message'].textContent).toBe('Reading https://example.test');
    const liveActivity = ctx.elements['agent-transcript'].querySelector('.agent-turn-activity');
    expect(liveActivity.children[0].textContent).toBe('Reading https://example.test');

    ctx.emit({
      type: 'tool_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_snapshot',
      operation: 'browser_snapshot',
      status: 'succeeded',
      label: 'Read https://example.test',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
      durationMs: 4_000,
      actionCount: 1,
      outcome: {
        kind: 'completed',
        verification: 'browser_observed',
        tone: 'success',
        headline: 'Browser state inspected',
        detail: 'Freedom recorded 1 successful browser action. No browser change was made.',
      },
    });

    const outcome = ctx.elements['agent-transcript'].querySelector('.agent-turn-outcome');
    expect(outcome.hidden).toBe(false);
    expect(outcome.classList.contains('success')).toBe(true);
    expect(outcome.children[1].children[0].textContent).toBe('Browser state inspected');
    expect(outcome.children[1].children[1].textContent).toContain(
      'Freedom recorded 1 successful browser action'
    );
    expect(liveActivity.children[0].textContent).toBe(
      'Worked for 4s · 1 action · Browser inspected'
    );
  });

  test('explains automatic provider retries and connection recovery', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Continue the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Continue the task',
    });
    ctx.emit({
      type: 'run_retrying',
      conversationId: 'conversation_test',
      runId: 'run_test',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 2_000,
      message: 'The connection to the model provider was interrupted.',
      providerFailure: { category: 'connection', recovery: 'transient' },
    });

    expect(ctx.elements['agent-run-status'].textContent).toBe('Reconnecting');
    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'The connection to the model provider was interrupted. Retrying automatically (1 of 2) in 2s…'
    );
    const liveStatus = ctx.elements['agent-transcript'].querySelector('.agent-live-status');
    expect(liveStatus.hidden).toBe(false);
    expect(liveStatus.classList.contains('active')).toBe(true);
    expect(liveStatus.children[1].textContent).toBe('Reconnecting · attempt 1 of 2…');

    ctx.emit({
      type: 'run_retry_recovered',
      conversationId: 'conversation_test',
      runId: 'run_test',
      attempt: 1,
    });
    expect(ctx.elements['agent-run-status'].textContent).toBe('Running');
    expect(ctx.elements['agent-run-message'].textContent).toBe(
      'Model connection restored. Agent is continuing…'
    );
    expect(liveStatus.children[1].textContent).toBe('Connection restored. Continuing…');
  });

  test('shows semantic live activity and replaces it with the completed turn summary', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Research this',
    });
    const turn = ctx.elements['agent-transcript'].querySelector('.agent-turn');
    const liveStatus = turn.querySelector('.agent-live-status');
    expect(liveStatus.hidden).toBe(false);
    expect(liveStatus.children[1].textContent).toBe('Thinking…');

    ctx.emit({ type: 'run_responding', runId: 'run_test' });
    expect(liveStatus.children[1].textContent).toBe('Responding…');

    ctx.emit({
      type: 'tool_started',
      runId: 'run_test',
      toolCallId: 'call_1',
      operation: 'browser_snapshot',
      intent: 'Reading the page…',
    });
    expect(liveStatus.children[1].textContent).toBe('Reading the page…');

    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_1',
      toolCallId: 'call_1',
      label: 'Continue',
    });
    expect(liveStatus.classList.contains('active')).toBe(false);
    expect(liveStatus.classList.contains('waiting')).toBe(true);
    expect(liveStatus.children[1].textContent).toBe('Waiting for your approval');

    ctx.emit({
      type: 'run_finished',
      runId: 'run_test',
      status: 'completed',
      durationMs: 1_000,
      actionCount: 1,
      outcome: { verification: 'actions_recorded' },
    });
    expect(liveStatus.hidden).toBe(true);
    expect(turn.querySelector('.agent-turn-activity').children[0].textContent).toBe(
      'Worked for 1s · 1 action · Actions recorded'
    );
  });

  test('uses explicit reasoning progress until verified activity or response takes over', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Build a page',
    });
    const turn = ctx.elements['agent-transcript'].querySelector('.agent-turn');
    const liveStatus = turn.querySelector('.agent-live-status');
    expect(liveStatus.children[1].textContent).toBe('Thinking…');

    ctx.emit({
      type: 'run_progress',
      runId: 'run_test',
      source: 'reasoning_heading',
      message: 'Planning basic landing page creation…',
    });
    expect(liveStatus.children[1].textContent).toBe('Planning basic landing page creation…');

    ctx.emit({
      type: 'tool_started',
      runId: 'run_test',
      toolCallId: 'write_1',
      operation: 'write',
      intent: 'Writing index.html…',
    });
    expect(liveStatus.children[1].textContent).toBe('Writing index.html…');

    ctx.emit({
      type: 'workspace_phase',
      runId: 'run_test',
      toolCallId: 'write_1',
      operation: 'write',
      phase: 'creating_workspace',
      message: 'Creating the project workspace…',
    });
    expect(liveStatus.children[1].textContent).toBe('Creating the project workspace…');

    ctx.emit({
      type: 'tool_finished',
      runId: 'run_test',
      toolCallId: 'write_1',
      operation: 'write',
      status: 'succeeded',
      label: 'Wrote index.html',
    });
    expect(liveStatus.children[1].textContent).toBe('Checking the result…');

    ctx.emit({
      type: 'run_progress',
      runId: 'run_test',
      source: 'reasoning_heading',
      message: 'Verifying workspace snapshot…',
    });
    expect(liveStatus.children[1].textContent).toBe('Verifying workspace snapshot…');

    ctx.emit({ type: 'assistant_text_delta', runId: 'run_test', text: 'Done.' });
    expect(liveStatus.children[1].textContent).toBe('Responding…');
  });

  test('renders attached-source evidence semantically and consolidates paginated reads', async () => {
    const ctx = await loadAgentUi();
    const folderId = `folder_${'a'.repeat(20)}`;
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Check the attached folder',
    });

    for (const [toolCallId, offset] of [
      ['attachment_read_1', 0],
      ['attachment_read_2', 65_536],
    ]) {
      ctx.emit({
        type: 'tool_started',
        conversationId: 'conversation_test',
        runId: 'run_test',
        toolCallId,
        operation: 'attachment_read',
        intent: 'Reading report.json…',
        label: 'Read report.json',
      });
      ctx.emit({
        type: 'tool_finished',
        conversationId: 'conversation_test',
        runId: 'run_test',
        toolCallId,
        operation: 'attachment_read',
        status: 'succeeded',
        label: 'Read report.json',
        attachment: {
          action: 'read',
          resourceId: folderId,
          resourceKind: 'folder',
          folderName: 'Bug reports',
          relativePath: 'report.json',
          name: 'report.json',
          bytesRead: 65_536,
          offset,
          truncated: offset === 0,
        },
      });
    }
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
      durationMs: 2_000,
      actionCount: 2,
      outcome: {
        kind: 'completed',
        verification: 'attachments_inspected',
        tone: 'success',
        headline: 'Attached sources inspected',
        detail:
          'Freedom verified access to 1 attached file in the shared folder. This confirms source access, not necessarily the model conclusions.',
      },
    });

    const turn = ctx.elements['agent-transcript'].children[0];
    const toolList = turn.querySelector('.agent-tool-list');
    expect(toolList.children).toHaveLength(1);
    expect(toolList.children[0].children[1].textContent).toBe('Read report.json');
    const outcome = turn.querySelector('.agent-turn-outcome');
    expect(outcome.children[1].children[0].textContent).toBe('Attached sources inspected');
    expect(outcome.children[1].children[1].textContent).not.toContain('browser evidence');
    expect(turn.querySelector('.agent-turn-activity').children[0].textContent).toBe(
      'Worked for 2s · 2 actions · Sources inspected'
    );
  });

  test('labels a terminal provider failure as a provider issue', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Continue the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Continue the task',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'failed',
      durationMs: 6_000,
      actionCount: 0,
      error: {
        code: 'PROVIDER_ERROR',
        message: 'The model provider remained unavailable. Freedom exhausted 2 automatic retries.',
      },
      outcome: {
        kind: 'recovery',
        verification: 'none',
        tone: 'danger',
        headline: 'Agent stopped before completion',
        detail: 'The model provider remained unavailable.',
        technicalDetails:
          'The provider returned HTTP 503. Freedom made 3 attempts total: the initial request plus 2 automatic retries.',
        nextStep: 'Wait a moment, then continue this conversation.',
        retrySafety: 'safe',
        canRetry: true,
      },
    });

    expect(ctx.elements['agent-run-status'].textContent).toBe('Provider issue');
    expect(ctx.elements['agent-run-message'].textContent).toBe('');
    const outcome = ctx.elements['agent-transcript'].querySelector('.agent-turn-outcome');
    const technical = outcome.querySelector('.agent-turn-outcome-technical');
    const retry = outcome.querySelector('.agent-turn-outcome-actions').children[0];
    expect(technical.hidden).toBe(false);
    expect(technical.open).toBe(false);
    expect(technical.children[1].textContent).toContain('HTTP 503');
    expect(retry.hidden).toBe(false);
    retry.dispatch('click');
    await flush();
    expect(ctx.electronAPI.startAgent).toHaveBeenLastCalledWith(
      7,
      'Continue the task',
      'every_interaction'
    );
  });

  test('does not show a browser-evidence outcome for conversation', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Hello';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Hello',
    });
    ctx.emit({
      type: 'assistant_text_delta',
      conversationId: 'conversation_test',
      runId: 'run_test',
      text: 'Hello! How can I help?',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
      durationMs: 1_000,
      actionCount: 0,
      outcome: {
        kind: 'completed',
        verification: 'not_applicable',
        tone: 'neutral',
      },
    });

    const turn = ctx.elements['agent-transcript'].children[0];
    expect(turn.querySelector('.agent-output').textContent).toBe('Hello! How can I help?');
    expect(turn.querySelector('.agent-turn-outcome').hidden).toBe(true);
    expect(turn.querySelector('.agent-turn-activity').hidden).toBe(true);
  });

  test('shows node diagnostics as node evidence rather than browser evidence', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'How are my nodes doing?';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'How are my nodes doing?',
    });
    ctx.emit({
      type: 'tool_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_node_status',
      operation: 'node_status',
      intent: 'Checking Freedom nodes',
      label: 'Checked Freedom nodes',
    });
    ctx.emit({
      type: 'tool_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_node_status',
      operation: 'node_status',
      status: 'succeeded',
      label: 'Checked 6 services',
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'completed',
      durationMs: 2_000,
      actionCount: 1,
      outcome: {
        kind: 'completed',
        verification: 'nodes_inspected',
        tone: 'caution',
        headline: 'Node status checked',
        detail: 'Freedom checked 6 integrated services: 3 ready, 1 disabled, 2 need attention.',
      },
    });

    const turn = ctx.elements['agent-transcript'].children[0];
    const outcome = turn.querySelector('.agent-turn-outcome');
    expect(outcome.hidden).toBe(false);
    expect(outcome.classList.contains('caution')).toBe(true);
    expect(outcome.children[1].children[0].textContent).toBe('Node status checked');
    expect(turn.querySelector('.agent-turn-activity').children[0].textContent).toBe(
      'Worked for 2s · 1 action · Node status checked'
    );
  });

  test('explains partial failure and does not present an unsafe blind retry', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Submit the application';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      userText: 'Submit the application',
    });
    ctx.emit({
      type: 'tool_started',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_click',
      operation: 'browser_click',
      label: 'Clicking on https://example.test',
    });
    ctx.emit({
      type: 'tool_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      toolCallId: 'tool_click',
      operation: 'browser_click',
      status: 'failed',
      errorCode: 'STALE_ELEMENT_REFERENCE',
      label: 'Clicked on https://example.test',
    });
    expect(ctx.elements['agent-run-message'].textContent).toContain(
      'Page changed before this could run'
    );
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_test',
      status: 'failed',
      durationMs: 2_000,
      actionCount: 1,
      error: { code: 'PROVIDER_ERROR', message: 'The model provider request failed' },
      outcome: {
        kind: 'recovery',
        verification: 'partial',
        tone: 'danger',
        headline: 'Agent stopped before completion',
        detail: 'The model connection failed. 1 earlier browser change remains in place.',
        nextStep: 'Review the Agent tabs, then tell Agent what to continue or redo.',
        retrySafety: 'review',
      },
    });

    const outcome = ctx.elements['agent-transcript'].querySelector('.agent-turn-outcome');
    expect(outcome.classList.contains('danger')).toBe(true);
    expect(outcome.children[1].children[0].textContent).toBe('Agent stopped before completion');
    expect(outcome.children[1].children[2].textContent).toContain('Review the Agent tabs');
    expect(outcome.children[1].children[2].textContent).not.toContain('safely try');
    expect(
      ctx.elements['agent-transcript'].querySelector('.agent-tool-item').children[1].textContent
    ).toContain('Page changed before this could run');
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

  test('opens a saved session and continues without silently adopting the current page', async () => {
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
      null,
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
    expect(ctx.elements['agent-session-list'].children[0].classList.contains('active')).toBe(true);
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
    expect(allowedTags).toEqual(
      expect.arrayContaining(['table', 'thead', 'tbody', 'tr', 'th', 'td'])
    );
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

  test('uses the empty running composer as Stop without conflating it with takeover', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Complete the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });

    expect(ctx.elements['agent-run-message'].textContent).toContain(
      'page you shared and any tabs it opens'
    );
    expect(ctx.elements['agent-run'].dataset.action).toBe('stop');
    expect(ctx.elements['agent-run'].disabled).toBe(false);
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.stopAgent).toHaveBeenCalledWith('run_test');
    expect(ctx.elements['agent-run-message'].textContent).toBe('Stopping Agent…');

    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'cancelled' });
    expect(ctx.elements['agent-run-status'].textContent).toBe('Stopped');
    expect(ctx.elements['agent-run-message'].textContent).toBe('Agent stopped.');
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(null);
  });

  test('intercepts the controlled page before takeover and resumes from the composer', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Complete the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });

    expect(ctx.elements['agent-page-interlock'].hidden).toBe(false);
    const preventScroll = jest.fn();
    ctx.elements['agent-page-interlock'].dispatch('wheel', { preventDefault: preventScroll });
    expect(preventScroll).toHaveBeenCalled();
    expect(ctx.elements['agent-takeover-dialog'].hidden).toBe(true);
    ctx.elements['agent-page-lock-trigger'].dispatch('click');
    expect(ctx.elements['agent-takeover-dialog'].hidden).toBe(false);
    ctx.elements['agent-takeover-cancel'].dispatch('click', {
      stopPropagation: jest.fn(),
    });
    expect(ctx.elements['agent-takeover-dialog'].hidden).toBe(true);
    expect(ctx.electronAPI.pauseAgent).not.toHaveBeenCalled();

    ctx.elements['agent-page-lock-trigger'].dispatch('click');
    ctx.elements['agent-takeover-confirm'].dispatch('click', {
      stopPropagation: jest.fn(),
    });
    await flush();
    expect(ctx.electronAPI.pauseAgent).toHaveBeenCalledWith('run_test');

    ctx.emit({ type: 'run_pausing', runId: 'run_test' });
    ctx.emit({ type: 'run_paused', runId: 'run_test' });
    expect(ctx.elements['agent-run-status'].textContent).toBe('You’re in control');
    expect(ctx.elements['agent-page-interlock'].hidden).toBe(true);
    expect(ctx.elements['agent-run'].dataset.action).toBe('resume');
    expect(ctx.elements['agent-run'].disabled).toBe(false);
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(7);

    ctx.elements['agent-run'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.resumeAgent).toHaveBeenCalledWith('run_test', undefined);
    ctx.emit({ type: 'run_resuming', runId: 'run_test' });
    ctx.emit({ type: 'run_resumed', runId: 'run_test' });

    expect(ctx.elements['agent-run-status'].textContent).toBe('Running');
    expect(ctx.elements['agent-run'].dataset.action).toBe('stop');
    expect(ctx.elements['agent-page-interlock'].hidden).toBe(false);
    expect(ctx.elements['agent-run-message'].textContent).toContain('re-reading');
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(7);

    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'completed' });
  });

  test('routes an Agent-owned tab claim through takeover while a run is active', async () => {
    const ctx = await loadAgentUi({ isTabAgentOwned: (tabId) => tabId === 7 });
    ctx.elements['agent-prompt'].value = 'Keep researching';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });

    expect(ctx.elements['agent-page-interlock'].hidden).toBe(false);
    const claimHandler = ctx.setAgentTabClaimHandler.mock.calls[0][0];
    await claimHandler(7);

    expect(ctx.electronAPI.claimAgentTab).not.toHaveBeenCalled();
    expect(ctx.elements['agent-takeover-dialog'].hidden).toBe(false);
    ctx.elements['agent-takeover-cancel'].dispatch('click', {
      stopPropagation: jest.fn(),
    });
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'cancelled' });
  });

  test('morphs the composer into a decision surface until approval resolves', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Complete the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test', userText: 'Complete the task' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_test',
      action: 'form_submission',
      label: 'Submit',
    });

    expect(ctx.elements['agent-prompt'].disabled).toBe(true);
    expect(ctx.elements['agent-composer'].classList.contains('approval-pending')).toBe(true);
    expect(ctx.elements['agent-approval'].hidden).toBe(false);
    expect(ctx.elements['agent-approval-message'].textContent).toBe('Agent is waiting');
    expect(ctx.elements['agent-approval-stop'].disabled).toBe(false);
    expect(ctx.electronAPI.steerAgent).not.toHaveBeenCalled();
    expect(ctx.electronAPI.decideAgentApproval).not.toHaveBeenCalled();

    ctx.emit({
      type: 'approval_resolved',
      runId: 'run_test',
      approvalId: 'approval_test',
      decision: 'declined',
    });

    expect(ctx.elements['agent-approval'].hidden).toBe(true);
    expect(ctx.elements['agent-composer'].classList.contains('approval-pending')).toBe(false);
    expect(ctx.elements['agent-prompt'].disabled).toBe(false);
  });

  test('stops the task directly from the approval composer', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Complete the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test', userText: 'Complete the task' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_test',
      action: 'form_submission',
      label: 'Submit',
    });

    ctx.elements['agent-approval-stop'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.stopAgent).toHaveBeenCalledWith('run_test');
    expect(ctx.elements['agent-approval-message'].textContent).toBe('Stopping…');
    expect(ctx.elements['agent-approval-stop'].disabled).toBe(true);

    ctx.emit({ type: 'run_finished', runId: 'run_test', status: 'cancelled' });
    expect(ctx.elements['agent-approval'].hidden).toBe(true);
    expect(ctx.elements['agent-prompt'].disabled).toBe(false);
  });

  test('submits paused composer text as resume guidance', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Complete the task';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({ type: 'run_paused', runId: 'run_test' });

    expect(ctx.elements['agent-prompt'].placeholder).toBe('Add guidance and resume…');
    expect(ctx.elements['agent-run'].dataset.action).toBe('resume');
    ctx.elements['agent-prompt'].value = 'I logged in; continue';
    ctx.elements['agent-prompt'].dispatch('input');
    expect(ctx.elements['agent-run'].dataset.action).toBe('send');
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    expect(ctx.electronAPI.resumeAgent).toHaveBeenCalledWith('run_test', 'I logged in; continue');
    expect(ctx.electronAPI.steerAgent).not.toHaveBeenCalled();
    expect(ctx.elements['agent-prompt'].value).toBe('');
    expect(ctx.elements['agent-run-status'].textContent).toBe('Resuming');
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
      type: 'tool_started',
      runId: 'run_test',
      toolCallId: 'tool_approval',
      operation: 'browser_click',
      intent: 'Clicking on the current page',
    });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_test',
      action: 'form_submission',
      toolCallId: 'tool_approval',
    });
    expect(ctx.elements['agent-transcript'].querySelector('.agent-tool-approval').textContent).toBe(
      'Approval needed'
    );
    ctx.emit({
      type: 'approval_resolved',
      runId: 'run_test',
      approvalId: 'approval_test',
      decision: 'withdrawn',
      toolCallId: 'tool_approval',
    });
    expect(ctx.elements['agent-transcript'].querySelector('.agent-tool-approval').textContent).toBe(
      'Withdrawn'
    );
    ctx.emit({ type: 'run_pausing', runId: 'run_test' });
    ctx.emit({ type: 'run_paused', runId: 'run_test' });

    expect(ctx.elements['agent-approval'].hidden).toBe(true);
    ctx.elements['agent-run'].dispatch('click');
    await flush();

    expect(ctx.elements['agent-run-status'].textContent).toBe('You’re in control');
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
      destinationOrigin: 'https://submit.example',
      label: '<img src=x onerror=alert(1)>',
    });

    expect(ctx.elements['agent-approval'].hidden).toBe(false);
    expect(ctx.elements['agent-run-status'].textContent).toBe('Approval needed');
    expect(ctx.elements['agent-approval-action'].textContent).toContain(
      '<img src=x onerror=alert(1)>'
    );
    expect(ctx.elements['agent-approval-action'].children).toHaveLength(0);
    expect(ctx.elements['agent-approval-origin'].textContent).toBe(
      'trusted.example → submit.example'
    );

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

  test('renders an honest provider diagnostic disclosure and can grant the conversation', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Diagnose IPFS';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_diagnostics',
      action: 'diagnostic_data',
      operation: 'node_diagnostics',
      diagnostic: {
        scope: 'node',
        service: 'ipfs',
        providerId: 'openai',
        providerLabel: 'OpenAI',
        modelId: 'gpt-5.6-sol',
        local: false,
        maxLines: 200,
        maxBytes: 49152,
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe(
      'Share recent ipfs node diagnostics with OpenAI?'
    );
    expect(ctx.elements['agent-approval-origin'].textContent).toContain(
      'This sends raw diagnostic logs to OpenAI using gpt-5.6-sol.'
    );
    expect(ctx.elements['agent-approval-origin'].textContent).toContain('local paths');
    expect(ctx.elements['agent-approval-approve'].textContent).toBe('Share once');
    expect(ctx.elements['agent-approval'].classList.contains('diagnostic-approval')).toBe(true);
    expect(ctx.elements['agent-approval-approve'].classList.contains('secondary')).toBe(true);
    expect(ctx.elements['agent-approval-approve'].classList.contains('primary')).toBe(false);
    expect(ctx.elements['agent-approval-allow-conversation'].hidden).toBe(false);

    ctx.elements['agent-approval-allow-conversation'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_diagnostics',
      true,
      { diagnosticScope: 'conversation' }
    );
  });

  test('renders the exact classified node request as a one-shot approval', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Create a postage stamp';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_node_request',
      action: 'node_request',
      operation: 'node_request',
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

    expect(ctx.elements['agent-approval-action'].textContent).toBe('Allow this Ant node request?');
    expect(ctx.elements['agent-approval-origin'].textContent).toContain(
      'OpenAI using gpt-5.6-sol independently classified this request as persistent change.'
    );
    expect(ctx.elements['agent-node-request-details'].hidden).toBe(false);
    expect(
      ctx.elements['agent-node-request-summary'].children.map((child) => child.textContent)
    ).toEqual([
      'Request',
      'POST /stamps/100/20',
      'Effect',
      'Persistent change',
      'Classifier',
      'Creates a durable postage batch.',
      'Headers',
      'content-type: application/json',
      'Body',
      '{"immutable":false}',
    ]);
    expect(ctx.elements['agent-approval-allow-conversation'].hidden).toBe(true);

    ctx.elements['agent-approval-approve'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_node_request',
      true
    );
  });

  test('renders an exact node lifecycle approval with current state and classifier result', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Restart IPFS';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_node_lifecycle',
      action: 'node_lifecycle',
      operation: 'node_lifecycle',
      nodeLifecycle: {
        service: 'ipfs',
        action: 'restart',
        beforeState: 'running',
        effect: 'reversible_admin',
        classification: {
          summary: 'Restarts one Freedom-managed IPFS process.',
          confidence: 0.99,
          uncertainties: [],
        },
        providerLabel: 'OpenAI',
        modelId: 'gpt-5.6-sol',
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe('Restart the IPFS node?');
    expect(ctx.elements['agent-approval-origin'].textContent).toContain(
      'Freedom will run it through the node manager and verify the resulting state.'
    );
    expect(
      ctx.elements['agent-node-request-summary'].children.map((child) => child.textContent)
    ).toEqual([
      'Action',
      'restart ipfs',
      'Current state',
      'running',
      'Effect',
      'Reversible admin change',
      'Classifier',
      'Restarts one Freedom-managed IPFS process.',
    ]);
  });

  test('condenses same-origin download approval copy without repeating Download', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Download Ubuntu';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_test',
      action: 'file_download',
      origin: 'https://ubuntu.com',
      destinationOrigin: 'https://ubuntu.com',
      label: 'Download Ubuntu 26.04 LTS amd64',
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe(
      'Download Ubuntu 26.04 LTS amd64?'
    );
    expect(ctx.elements['agent-approval-origin'].textContent).toBe('ubuntu.com');
  });

  test('renders an Agent-native wallet decision and sends the selected public account', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Connect my wallet';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_wallet',
      action: 'wallet_connection',
      origin: 'https://app.example',
      destinationOrigin: 'https://app.example',
      wallet: {
        kind: 'connection',
        chainId: 100,
        chainName: 'Gnosis',
        defaultWalletIndex: 2,
        requiresUnlock: false,
        wallets: [
          {
            index: 0,
            name: 'Main Wallet',
            address: '0x1111111111111111111111111111111111111111',
            type: 'mnemonic',
          },
          {
            index: 2,
            name: 'Ledger',
            address: '0x2222222222222222222222222222222222222222',
            type: 'ledger',
          },
        ],
      },
    });

    expect(ctx.elements['agent-wallet-approval-details'].hidden).toBe(false);
    expect(
      ctx.elements['agent-wallet-approval-summary'].children.some(
        (child) => child.textContent === 'Gnosis'
      )
    ).toBe(true);
    expect(ctx.elements['agent-wallet-account-field'].hidden).toBe(false);
    expect(ctx.elements['agent-wallet-account'].children).toHaveLength(2);
    expect(ctx.elements['agent-approval-approve'].textContent).toBe('Connect once');

    ctx.elements['agent-wallet-account'].value = '2';
    ctx.elements['agent-approval-approve'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_wallet',
      true,
      { walletIndex: 2 }
    );
  });

  test('keeps a locked transaction approval in the composer until password unlock succeeds', async () => {
    const unlock = jest.fn().mockResolvedValue({ success: true });
    const ctx = await loadAgentUi({
      windowGlobals: {
        identity: {
          getStatus: jest
            .fn()
            .mockResolvedValueOnce({ isUnlocked: false })
            .mockResolvedValue({ isUnlocked: true }),
          unlock,
        },
        quickUnlock: {
          canUseTouchId: jest.fn().mockResolvedValue(false),
          isEnabled: jest.fn().mockResolvedValue(false),
          unlock: jest.fn(),
        },
      },
    });
    ctx.elements['agent-prompt'].value = 'Send transaction';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_tx',
      action: 'wallet_transaction',
      origin: 'https://app.example',
      wallet: {
        kind: 'transaction',
        chainId: 100,
        chainName: 'Gnosis',
        requiresUnlock: true,
        account: {
          index: 0,
          name: 'Main Wallet',
          address: '0x1111111111111111111111111111111111111111',
          type: 'mnemonic',
        },
        to: '0x3333333333333333333333333333333333333333',
        value: '1.0 xDAI',
        maxFee: '0.000024 xDAI',
      },
    });

    ctx.elements['agent-approval-approve'].dispatch('click');
    await flush();
    expect(ctx.elements['agent-wallet-unlock'].hidden).toBe(false);
    expect(ctx.electronAPI.decideAgentApproval).not.toHaveBeenCalled();

    ctx.elements['agent-wallet-password'].value = 'secret';
    ctx.elements['agent-wallet-unlock-submit'].dispatch('click');
    await flush();
    await flush();
    expect(unlock).toHaveBeenCalledWith('secret');
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_tx',
      true
    );
  });

  test('renders a direct transfer as an exact Freedom-native send decision', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Send 0.01 GNO';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_transfer',
      action: 'wallet_transfer',
      operation: 'wallet_transfer',
      origin: '',
      wallet: {
        kind: 'transfer',
        chainId: 100,
        chainName: 'Gnosis',
        requiresUnlock: false,
        account: {
          index: 2,
          name: 'Ledger',
          address: '0x1111111111111111111111111111111111111111',
          type: 'ledger',
        },
        to: 'meinhard.eth · 0x3333333333333333333333333333333333333333',
        value: '0.01 GNO',
        maxFee: '0.000024 xDAI',
        tokenContract: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe(
      'Send these funds from your Freedom wallet?'
    );
    expect(ctx.elements['agent-approval-origin'].textContent).toContain(
      'Prepared directly by Freedom'
    );
    expect(ctx.elements['agent-approval-approve'].textContent).toBe('Send once');
    const summary = ctx.elements['agent-wallet-approval-summary'].children.map(
      (child) => child.textContent
    );
    expect(summary).toEqual(
      expect.arrayContaining([
        'Gnosis',
        '0.01 GNO',
        '0.000024 xDAI',
        '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
      ])
    );
    expect(summary).not.toContain('Site');
  });

  test('uses Touch ID for an Agent-native wallet approval when quick unlock is enabled', async () => {
    const identityUnlock = jest.fn().mockResolvedValue({ success: true });
    const quickUnlock = jest.fn().mockResolvedValue({
      success: true,
      password: 'test-only-touch-id-password',
    });
    const ctx = await loadAgentUi({
      windowGlobals: {
        identity: {
          getStatus: jest.fn().mockResolvedValue({ isUnlocked: false }),
          unlock: identityUnlock,
        },
        quickUnlock: {
          canUseTouchId: jest.fn().mockResolvedValue(true),
          isEnabled: jest.fn().mockResolvedValue(true),
          unlock: quickUnlock,
        },
      },
    });
    ctx.elements['agent-prompt'].value = 'Sign message';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_signature',
      action: 'wallet_signature',
      origin: 'https://app.example',
      wallet: {
        kind: 'signature',
        chainId: 100,
        chainName: 'Gnosis',
        requiresUnlock: true,
        account: {
          index: 0,
          name: 'Main Wallet',
          address: '0x1111111111111111111111111111111111111111',
          type: 'mnemonic',
        },
        signatureType: 'Personal message',
        summary: 'Approve this exact message',
      },
    });

    ctx.elements['agent-approval-approve'].dispatch('click');
    await flush();
    await flush();

    expect(quickUnlock).toHaveBeenCalledTimes(1);
    expect(identityUnlock).toHaveBeenCalledWith('test-only-touch-id-password');
    expect(ctx.elements['agent-wallet-unlock'].hidden).toBe(true);
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_signature',
      true
    );
  });

  test('uses the native picker as the final consent surface for a file upload', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Upload my résumé';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_upload',
      action: 'file_upload',
      operation: 'browser_upload',
      origin: 'https://jobs.example',
      destinationOrigin: 'https://jobs.example',
      label: 'Résumé or CV',
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe(
      'Choose a file to share with jobs.example?'
    );
    expect(ctx.elements['agent-approval-origin'].textContent).toContain('For “Résumé or CV”');
    expect(ctx.elements['agent-approval-origin'].textContent).toContain('never shows Agent');
    expect(ctx.elements['agent-approval-approve'].textContent).toBe('Choose file…');

    ctx.elements['agent-approval-approve'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_upload',
      true
    );
    ctx.emit({
      type: 'approval_resolved',
      runId: 'run_test',
      approvalId: 'approval_upload',
      decision: 'approved',
    });
    expect(ctx.elements['agent-approval-approve'].textContent).toBe('Allow once');
  });

  test('renders a public Swarm publication as an Agent-native decision and receipt', async () => {
    const ctx = await loadAgentUi();
    ctx.elements['agent-prompt'].value = 'Publish the attached site';
    ctx.elements['agent-run'].dispatch('click');
    await flush();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_publish',
      action: 'swarm_publish',
      operation: 'swarm_publish',
      label: 'website',
      publication: {
        kind: 'folder',
        name: 'website',
        public: true,
        indexDocument: 'index.html',
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe('Publish “website” to Swarm?');
    expect(ctx.elements['agent-approval-origin'].textContent).toContain('current contents');
    expect(ctx.elements['agent-approval-origin'].textContent).toContain('public, unencrypted');
    expect(ctx.elements['agent-publication-details'].hidden).toBe(false);
    expect(ctx.elements['agent-publication-summary'].textContent).not.toContain('/Users/');
    expect(ctx.elements['agent-approval-approve'].textContent).toBe('Publish');

    ctx.elements['agent-approval-approve'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_publish',
      true
    );

    const publication = {
      publicationId: `swarm_pub_${'a'.repeat(24)}`,
      state: 'completed',
      applicationState: 'applied',
      kind: 'folder',
      name: 'website',
      public: true,
      progress: 100,
      reference: 'b'.repeat(64),
      bzzUrl: `bzz://${'b'.repeat(64)}`,
      verified: true,
    };
    ctx.emit({
      type: 'tool_started',
      runId: 'run_test',
      toolCallId: 'publish_call',
      operation: 'swarm_publish',
      intent: 'Publishing website',
    });
    ctx.emit({
      type: 'tool_finished',
      runId: 'run_test',
      toolCallId: 'publish_call',
      operation: 'swarm_publish',
      status: 'succeeded',
      label: 'Published website to Swarm',
      publication,
    });
    const card = ctx.elements['agent-transcript'].children[0].children[4].children[0];
    expect(card.dataset.publicationId).toBe(publication.publicationId);
    card.children[1].children[0].dispatch('click');
    await flush();
    expect(ctx.electronAPI.openAgentPublication).toHaveBeenCalledWith(publication.bzzUrl);
  });

  test('identifies a managed project source in the Swarm approval without a host path', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_workspace_publish',
      action: 'swarm_publish',
      operation: 'swarm_publish',
      label: 'dist',
      publication: {
        kind: 'folder',
        name: 'dist',
        workspacePath: 'apps/site/dist',
        public: true,
        indexDocument: 'index.html',
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe('Publish “dist” to Swarm?');
    expect(ctx.elements['agent-approval-origin'].textContent).toContain(
      'managed project source’s current files'
    );
    const summaryText = ctx.elements['agent-publication-summary'].children
      .map((child) => child.textContent)
      .join(' ');
    expect(summaryText).toContain('Managed project folder');
    expect(summaryText).toContain('apps/site/dist');
    expect(summaryText).not.toContain('/Users/');
  });

  test('renders managed workspace enablement as one Agent-native disclosure', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_workspace',
      action: 'workspace_execution',
      operation: 'bash',
      workspace: {
        available: true,
        backend: 'macos-seatbelt',
        network: 'disabled',
        filesystem: 'managed_workspace_only',
        cancellationGuarantee: 'best_effort',
        survivorsPossible: true,
        completeDescendantTermination: false,
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe(
      'Enable a managed project workspace for this conversation?'
    );
    expect(ctx.elements['agent-approval-origin'].textContent).toBe(
      'Agent can create, edit, and delete files inside a Freedom-managed project workspace.'
    );
    expect(ctx.elements['agent-approval-origin'].textContent).not.toContain('Network');
    expect(ctx.elements['agent-approval-origin'].textContent).not.toContain('best-effort');
    expect(ctx.elements['agent-workspace-permission-details'].hidden).toBe(false);
    expect(ctx.elements['agent-workspace-permission-details'].open).toBe(false);
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'removes it when the conversation is deleted'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'protected .git metadata remains read-only'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'separately approved executable packages'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'does not grant internet, localhost, or LAN access'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain('best-effort');
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).not.toContain('/Users/');
    expect(ctx.elements['agent-approval-approve'].textContent).toBe('Enable workspace');

    ctx.elements['agent-approval-approve'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_workspace',
      true
    );
  });

  test('renders exact executable access and can grant it for the conversation', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_executable',
      action: 'workspace_permission',
      operation: 'request_permissions',
      label: 'Run the project validation script',
      workspacePermission: {
        kind: 'command_access',
        command: 'node validate.js',
        workingDirectory: 'site',
        commands: [
          {
            name: 'node',
            status: 'requires_permission',
            executablePath: '/opt/homebrew/Cellar/node/24/bin/node',
            rootPath: '/opt/homebrew/Cellar/node/24',
          },
        ],
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe('Run “node validate.js”?');
    expect(ctx.elements['agent-approval-origin'].textContent).toBe('');
    expect(ctx.elements['agent-workspace-permission-details'].hidden).toBe(false);
    expect(ctx.elements['agent-workspace-permission-details'].open).toBe(false);
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'Working directory: site'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      '/opt/homebrew/Cellar/node/24'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'cannot write there'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'Network access is not part of this request'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'Agent says: Run the project validation script'
    );
    expect(ctx.elements['agent-approval-approve'].textContent).toBe('Allow once');
    expect(ctx.elements['agent-approval'].classList.contains('conversation-approval')).toBe(true);
    expect(ctx.elements['agent-approval-approve'].classList.contains('secondary')).toBe(true);
    expect(ctx.elements['agent-approval-approve'].classList.contains('primary')).toBe(false);
    expect(ctx.elements['agent-approval-allow-conversation'].textContent).toBe(
      'Allow for conversation'
    );
    expect(ctx.elements['agent-approval-allow-conversation'].hidden).toBe(false);

    ctx.elements['agent-approval-allow-conversation'].dispatch('click');
    await flush();
    expect(ctx.electronAPI.decideAgentApproval).toHaveBeenCalledWith(
      'run_test',
      'approval_executable',
      true,
      { workspacePermissionScope: 'conversation' }
    );
  });

  test('shows the network qualifier above collapsed command-specific details', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_network',
      action: 'workspace_permission',
      operation: 'request_permissions',
      label: 'Download project dependencies',
      workspacePermission: {
        kind: 'command_access',
        command: 'npm install',
        workingDirectory: '.',
        commands: [],
        network: {
          posture: 'full',
          publicInternet: true,
          hostLoopback: true,
          privateLan: true,
          hostAbstractUnixSockets: 'reachable',
        },
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe('Run “npm install”?');
    expect(ctx.elements['agent-approval-origin'].textContent).toBe(
      'With access to the internet, localhost, and LAN.'
    );
    expect(ctx.elements['agent-workspace-permission-details'].open).toBe(false);
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'public internet, services on this computer’s localhost, and private/LAN addresses'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'host abstract Unix sockets'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'keeps the disclosed network access available'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).not.toContain(
      'package access'
    );
    expect(ctx.elements['agent-workspace-permission-summary'].textContent).toContain(
      'Agent says: Download project dependencies'
    );
  });

  test('presents inline Swarm text as text rather than inventing a file', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'approval_requested',
      runId: 'run_test',
      approvalId: 'approval_text',
      action: 'swarm_publish',
      operation: 'swarm_publish',
      label: 'Text',
      publication: {
        kind: 'text',
        name: 'Text',
        public: true,
        contentType: 'text/plain; charset=utf-8',
      },
    });

    expect(ctx.elements['agent-approval-action'].textContent).toBe('Publish this text to Swarm?');
    expect(ctx.elements['agent-publication-summary'].textContent).not.toContain('.txt');

    const publication = {
      publicationId: `swarm_pub_${'c'.repeat(24)}`,
      state: 'completed',
      applicationState: 'applied',
      kind: 'text',
      name: 'Text',
      public: true,
      reference: 'd'.repeat(64),
      bzzUrl: `bzz://${'d'.repeat(64)}`,
      verified: true,
    };
    ctx.emit({
      type: 'tool_started',
      runId: 'run_test',
      toolCallId: 'publish_text',
      operation: 'swarm_publish',
      intent: 'Publishing text',
    });
    ctx.emit({
      type: 'tool_finished',
      runId: 'run_test',
      toolCallId: 'publish_text',
      operation: 'swarm_publish',
      status: 'succeeded',
      label: 'Published text to Swarm',
      publication,
    });

    const card = ctx.elements['agent-transcript'].children[0].children[4].children[0];
    expect(card.children[0].children[0].textContent).toBe('Text');
    expect(card.textContent).not.toContain('.txt');
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
    expect(ctx.elements['agent-run'].dataset.action).toBe('send');
    expect(ctx.setAgentControlledTab).toHaveBeenLastCalledWith(null);
  });

  test('renders workspace failures as workspace errors rather than browser failures', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({ type: 'run_started', runId: 'run_test' });
    ctx.emit({
      type: 'tool_started',
      runId: 'run_test',
      toolCallId: 'bash_missing',
      operation: 'bash',
      intent: 'Running missing-tool',
      label: 'Ran missing-tool',
    });
    ctx.emit({
      type: 'tool_finished',
      runId: 'run_test',
      toolCallId: 'bash_missing',
      operation: 'bash',
      status: 'failed',
      errorCode: 'WORKSPACE_COMMAND_NOT_FOUND',
      label: 'Workspace operation failed — missing-tool',
    });

    const row = ctx.elements['agent-transcript'].querySelector('.agent-tool-list').children[0];
    expect(row.children[1].textContent).toContain(
      'A required command is not available in the workspace shell'
    );
    expect(row.children[1].textContent).not.toContain('Browser action failed');
    expect(ctx.elements['agent-run-message'].textContent).toContain(
      'A required command is not available in the workspace shell'
    );
  });

  test('reconciles a yielded workspace process after its Agent run has finished', async () => {
    const ctx = await loadAgentUi();
    ctx.emit({
      type: 'run_started',
      conversationId: 'conversation_test',
      runId: 'run_process',
      userText: 'Start the worker',
    });
    ctx.emit({
      type: 'tool_started',
      conversationId: 'conversation_test',
      runId: 'run_process',
      toolCallId: 'tool_process',
      operation: 'bash',
      intent: 'Starting the worker',
    });
    ctx.emit({
      type: 'tool_finished',
      conversationId: 'conversation_test',
      runId: 'run_process',
      toolCallId: 'tool_process',
      operation: 'bash',
      status: 'succeeded',
      label: 'Process still running',
      workspace: {
        state: 'running',
        processId: 'workspace_process_1234567890abcdef12345678',
        terminationScope: 'pending',
      },
    });
    ctx.emit({
      type: 'run_finished',
      conversationId: 'conversation_test',
      runId: 'run_process',
      status: 'completed',
      durationMs: 12_000,
      actionCount: 1,
    });

    const row = ctx.elements['agent-transcript'].querySelector('.agent-tool-item');
    expect(row.children[1].textContent).toBe('Process still running');
    expect(ctx.elements['agent-run-status'].textContent).toBe('Complete');

    ctx.emit({
      type: 'tool_finished',
      conversationId: 'conversation_test',
      runId: 'run_process',
      toolCallId: 'tool_process',
      operation: 'bash',
      status: 'succeeded',
      label: 'Ran the worker',
      workspace: {
        state: 'completed',
        processId: 'workspace_process_1234567890abcdef12345678',
        terminationScope: 'pid_namespace',
      },
    });

    expect(row.children[0].textContent).toBe('✓');
    expect(row.children[1].textContent).toBe('Ran the worker');
    expect(ctx.elements['agent-run-status'].textContent).toBe('Complete');
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
    expect(ctx.elements['agent-run'].dataset.action).toBe('send');
  });
});
