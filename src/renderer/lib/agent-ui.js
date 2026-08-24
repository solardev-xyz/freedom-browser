import { isPrivateWindow } from './private-mode.js';
import { close as closeWalletSidebar, isVisible as isWalletSidebarVisible } from './sidebar.js';
import { isSignatureInFlight, onSignatureFlightChange } from './wallet/signature-flight.js';

const PROVIDER_NAMES = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'ChatGPT (Codex)',
  openrouter: 'OpenRouter',
  freepi: 'Free Pi',
  ollama: 'Ollama',
});
const APPROVAL_MODES = Object.freeze({
  EVERY_INTERACTION: 'every_interaction',
  ALLOW_WEBSITE_INTERACTIONS: 'allow_website_interactions',
});
const APPROVAL_MODE_LABELS = Object.freeze({
  [APPROVAL_MODES.EVERY_INTERACTION]: 'Ask every action',
  [APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS]: 'Allow website actions',
});

let elements = {};
let getActiveTab = () => null;
let getOpenTabs = () => [];
let switchToTab = () => {};
let setAgentControlledTab = () => {};
let providerCatalog = [];
let providerCatalogPromise = null;
let providerStatus = null;
let providerReady = false;
let providerLoginPending = false;
let currentConversationId = null;
let conversationRendererTabId = null;
let pendingPromptText = '';
let currentRunId = null;
let currentRunStatus = 'idle';
let lastFinishedRunId = null;
let takeoverRequestedRunId = null;
let pendingApproval = null;
let panelOpen = false;
let agentView = 'loading';
let approvalMode = APPROVAL_MODES.EVERY_INTERACTION;
let agentEventUnsubscribe = null;
let providerAuthEventUnsubscribe = null;
let tabPresentationUnsubscribe = null;
let openTabs = [];
let taskTabProjection = [];
let agentFirstMode = false;
let sessionSidebarOpen = true;
let workspaceSidebarOpen = true;
let conversationTitle = 'New task';
const toolRows = new Map();
const turnViews = new Map();

function byId(id) {
  return document.getElementById(id);
}

function responseMessage(response, fallback) {
  return typeof response?.error?.message === 'string' && response.error.message
    ? response.error.message
    : fallback;
}

function setMessage(element, message = '', isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function providerName(providerId) {
  return PROVIDER_NAMES[providerId] || providerId || 'Model';
}

function providerPrivacyMessage(providerId) {
  if (providerId === 'ollama') {
    return 'Model requests stay on this device and are sent only to your local Ollama server.';
  }
  if (providerId === 'openai-codex') {
    return 'Your task and page content the agent reads may be sent to OpenAI through your ChatGPT subscription. Avoid using Agent on pages containing sensitive information.';
  }
  return `Your task and page content the agent reads may be sent to ${providerName(providerId)}. Avoid using Agent on pages containing sensitive information.`;
}

function providerAuthType(providerId) {
  return (
    providerCatalog.find((candidate) => candidate.providerId === providerId)?.authType ||
    (providerId === 'openai-codex' ? 'subscription' : 'api_key')
  );
}

function providerConnections() {
  if (Array.isArray(providerStatus?.connections)) return providerStatus.connections;
  if (!providerStatus?.configured) return [];
  return [
    {
      kind: providerStatus.kind,
      providerId: providerStatus.providerId,
      modelId: providerStatus.modelId,
      ...(providerStatus.kind === 'ollama' && {
        baseUrl: providerStatus.baseUrl,
        modelIds: [providerStatus.modelId],
      }),
    },
  ];
}

function providerConnection(providerId) {
  return providerConnections().find((connection) => connection.providerId === providerId);
}

function catalogModel(providerId, modelId) {
  return providerCatalog
    .find((provider) => provider.providerId === providerId)
    ?.models?.find((model) => model.id === modelId);
}

function modelName(providerId, modelId) {
  return catalogModel(providerId, modelId)?.name || modelId || 'Model';
}

function configuredModels() {
  return providerConnections().flatMap((connection) => {
    const models =
      connection.kind === 'ollama'
        ? (connection.modelIds || [connection.modelId]).map((modelId) => ({
            id: modelId,
            name: modelId,
          }))
        : providerCatalog.find((provider) => provider.providerId === connection.providerId)
            ?.models || [{ id: connection.modelId, name: connection.modelId }];
    return models.map((model) => ({
      providerId: connection.providerId,
      modelId: model.id,
      name: model.name || model.id,
    }));
  });
}

function closeComposerPopovers() {
  elements.modelMenu.hidden = true;
  elements.approvalModePopover.hidden = true;
  elements.modelMenuButton.setAttribute('aria-expanded', 'false');
  elements.approvalModeButton.setAttribute('aria-expanded', 'false');
}

function setApprovalMode(nextMode) {
  if (
    !Object.hasOwn(APPROVAL_MODE_LABELS, nextMode) ||
    currentRunStatus !== 'idle' ||
    currentConversationId
  ) {
    return;
  }
  approvalMode = nextMode;
  elements.activeApprovalModeLabel.textContent = APPROVAL_MODE_LABELS[nextMode];
  const askEvery = nextMode === APPROVAL_MODES.EVERY_INTERACTION;
  elements.approvalModeEvery.classList.toggle('active', askEvery);
  elements.approvalModeEvery.setAttribute('aria-pressed', String(askEvery));
  elements.approvalModeEvery.querySelector('.agent-approval-mode-check').textContent = askEvery
    ? '✓'
    : '';
  elements.approvalModeAllow.classList.toggle('active', !askEvery);
  elements.approvalModeAllow.setAttribute('aria-pressed', String(!askEvery));
  elements.approvalModeAllow.querySelector('.agent-approval-mode-check').textContent = askEvery
    ? ''
    : '✓';
  closeComposerPopovers();
}

function setAgentView(nextView) {
  if (nextView !== 'workspace' && agentFirstMode) setAgentFirstMode(false);
  agentView = nextView;
  elements.loadingView.hidden = nextView !== 'loading';
  elements.setupView.hidden = nextView !== 'setup';
  elements.workspaceView.hidden = nextView !== 'workspace';
  const setup = nextView === 'setup';
  const canReturn = setup && providerStatus?.configured === true;
  elements.back.hidden = !canReturn;
  elements.title.textContent = setup ? (canReturn ? 'Models' : 'Set up Agent') : 'Agent';
  elements.subtitle.textContent = setup
    ? canReturn
      ? 'Add or manage providers'
      : 'Connect a model to continue'
    : 'Give Agent a task';
  elements.agentFirstToggle.hidden = nextView !== 'workspace';
  closeComposerPopovers();
}

function taskPageLocation(url) {
  if (typeof url !== 'string' || !url) return 'New page';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:' || parsed.protocol === 'freedom:') return 'Freedom';
    return parsed.host || parsed.protocol.replace(':', '');
  } catch {
    return 'Page';
  }
}

function taskPageIcon(tab) {
  const icon = document.createElement('span');
  icon.className = 'agent-task-page-icon';
  if (typeof tab.favicon === 'string' && tab.favicon) {
    const image = document.createElement('img');
    image.src = tab.favicon;
    image.alt = '';
    image.addEventListener('error', () => image.remove());
    icon.appendChild(image);
  } else {
    icon.textContent =
      (tab.title || taskPageLocation(tab.url)).trim().charAt(0).toUpperCase() || '•';
  }
  return icon;
}

function titleFromPrompt(prompt) {
  const normalized = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'New task';
  return normalized.length > 64 ? `${normalized.slice(0, 63).trimEnd()}…` : normalized;
}

function setConversationTitle(nextTitle) {
  conversationTitle = titleFromPrompt(nextTitle);
  elements.agentFirstTitle.textContent = conversationTitle;
  elements.currentSessionTitle.textContent = conversationTitle;
}

function renderSessionSidebar() {
  const hasConversation = Boolean(currentConversationId);
  elements.currentSession.hidden = !hasConversation;
  elements.sessionHistoryEmpty.hidden = hasConversation;
  elements.sessionNewChat.disabled = currentRunStatus !== 'idle';
  elements.agentFirstTitle.textContent = conversationTitle;
  elements.currentSessionTitle.textContent = conversationTitle;
}

function workspacePages() {
  const tabById = new Map(openTabs.map((tab) => [tab.id, tab]));
  const projected = taskTabProjection
    .map((entry) => ({ ...entry, tab: tabById.get(entry.rendererTabId) }))
    .filter((entry) => entry.tab);
  const activeTab = openTabs.find((tab) => tab.isActive);
  if (currentConversationId) return projected;
  return activeTab
    ? [{ rendererTabId: activeTab.id, agentActive: false, tab: activeTab, startsHere: true }]
    : [];
}

function ensureWorkspacePageVisible() {
  if (!agentFirstMode) return;
  const pages = workspacePages();
  if (!pages.length || pages.some((entry) => entry.tab.isActive)) return;
  const preferred = pages.find((entry) => entry.agentActive) || pages[0];
  switchToTab(preferred.rendererTabId);
}

function renderTaskPages() {
  if (!elements.taskPageList) return;
  const pages = workspacePages();

  const cards = pages.map((entry) => {
    const tab = entry.tab;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'agent-task-page';
    card.dataset.rendererTabId = String(entry.rendererTabId);
    card.classList.toggle('viewing', tab.isActive === true);
    card.classList.toggle('agent-active', entry.agentActive === true);
    card.title = [
      tab.title || 'New tab',
      taskPageLocation(tab.url),
      ...(entry.agentActive ? ['Agent active'] : []),
      ...(tab.isLoading ? ['Loading'] : []),
    ].join(' — ');
    card.setAttribute('aria-label', card.title);
    card.appendChild(taskPageIcon(tab));

    const copy = document.createElement('span');
    copy.className = 'agent-task-page-copy';
    const title = document.createElement('span');
    title.className = 'agent-task-page-title';
    title.textContent = tab.title || 'New tab';
    const location = document.createElement('span');
    location.className = 'agent-task-page-location';
    location.textContent = taskPageLocation(tab.url);
    copy.appendChild(title);
    copy.appendChild(location);

    const badges = document.createElement('span');
    badges.className = 'agent-task-page-badges';
    const badgeLabels = [
      ...(entry.startsHere ? ['Starts here'] : []),
      ...(entry.agentActive ? ['Agent active'] : []),
      ...(tab.isActive ? ['Viewing'] : []),
      ...(tab.isLoading ? ['Loading'] : []),
    ];
    badgeLabels.forEach((label) => {
      const badge = document.createElement('span');
      badge.className = 'agent-task-page-badge';
      badge.classList.toggle('active', label === 'Agent active');
      badge.textContent = label;
      badges.appendChild(badge);
    });
    if (badgeLabels.length) copy.appendChild(badges);
    card.appendChild(copy);
    card.addEventListener('click', () => {
      switchToTab(entry.rendererTabId);
    });
    return card;
  });

  elements.taskPageList.replaceChildren(...cards);
  elements.taskPageCount.textContent = String(pages.length);
  elements.taskPagesEmpty.hidden = pages.length > 0;
  document.body.classList.toggle('agent-workspace-page-empty', pages.length === 0);
  elements.taskPagesNote.textContent = currentConversationId
    ? 'Only pages belonging to this conversation are shown.'
    : 'Agent will start from the page you are currently viewing.';
}

function applyWorkspaceProjection(state) {
  taskTabProjection = Array.isArray(state?.taskTabs)
    ? state.taskTabs.filter(
        (entry) =>
          Number.isSafeInteger(entry?.rendererTabId) &&
          entry.rendererTabId > 0 &&
          typeof entry.agentActive === 'boolean'
      )
    : [];
  renderTaskPages();
  ensureWorkspacePageVisible();
}

async function refreshWorkspaceProjection() {
  try {
    const response = await window.electronAPI.getAgentState();
    const state = response?.ok ? response.state : null;
    if (!state) return;
    if (
      currentConversationId &&
      state.conversationId &&
      state.conversationId !== currentConversationId
    ) {
      return;
    }
    applyWorkspaceProjection(state);
  } catch {
    // Keep the last trusted renderer projection when state refresh fails.
  }
}

function setAgentFirstMode(nextMode) {
  agentFirstMode = nextMode === true && panelOpen && agentView === 'workspace';
  document.body.classList.toggle('agent-first-mode', agentFirstMode);
  document.body.classList.toggle('agent-session-sidebar-closed', !sessionSidebarOpen);
  document.body.classList.toggle('agent-workspace-sidebar-closed', !workspaceSidebarOpen);
  elements.taskPages.hidden = !agentFirstMode;
  elements.sessionSidebar.hidden = !agentFirstMode;
  elements.agentFirstTitlebar.hidden = !agentFirstMode;
  elements.agentFirstToggle.setAttribute('aria-pressed', String(agentFirstMode));
  elements.agentFirstToggle.setAttribute(
    'aria-label',
    agentFirstMode ? 'Return to browser view' : 'Make Agent the main view'
  );
  elements.agentFirstToggle.title = agentFirstMode ? 'Browser view' : 'Agent-first view';
  if (agentFirstMode) {
    openTabs = getOpenTabs();
    renderTaskPages();
    renderSessionSidebar();
    ensureWorkspacePageVisible();
    void refreshWorkspaceProjection();
  }
}

function setSessionSidebarOpen(nextOpen) {
  sessionSidebarOpen = nextOpen === true;
  document.body.classList.toggle('agent-session-sidebar-closed', !sessionSidebarOpen);
  elements.sessionSidebarToggle.setAttribute('aria-expanded', String(sessionSidebarOpen));
  elements.sessionSidebarToggle.setAttribute(
    'aria-label',
    sessionSidebarOpen ? 'Hide sessions sidebar' : 'Show sessions sidebar'
  );
}

function setWorkspaceSidebarOpen(nextOpen) {
  workspaceSidebarOpen = nextOpen === true;
  document.body.classList.toggle('agent-workspace-sidebar-closed', !workspaceSidebarOpen);
  elements.workspaceSidebarToggle.setAttribute('aria-expanded', String(workspaceSidebarOpen));
  elements.workspaceSidebarToggle.setAttribute(
    'aria-label',
    workspaceSidebarOpen ? 'Hide workspace sidebar' : 'Show workspace sidebar'
  );
}

function showPrimaryView() {
  if (!providerReady) setAgentView('loading');
  else setAgentView(providerStatus?.configured ? 'workspace' : 'setup');
}

function showProviderSetup() {
  setAgentView('setup');
  renderConnectedProviders();
  elements.provider.focus();
}

function setPanelOpen(nextOpen) {
  panelOpen = nextOpen;
  elements.panel.classList.toggle('collapsed', !panelOpen);
  elements.toggle.setAttribute('aria-expanded', String(panelOpen));
}

function closePanel() {
  if (agentFirstMode) setAgentFirstMode(false);
  if (panelOpen) setPanelOpen(false);
}

function openPanel() {
  if (isPrivateWindow() || isSignatureInFlight()) return;
  if (isWalletSidebarVisible()) {
    closeWalletSidebar();
    if (isWalletSidebarVisible()) return;
  }
  setPanelOpen(true);
  showPrimaryView();
  loadProviderCatalog().then(() => {
    renderConnectedProviders();
    renderModelMenu();
  });
  document.dispatchEvent(new CustomEvent('agent-sidebar-opened'));
}

function togglePanel() {
  if (panelOpen) closePanel();
  else openPanel();
}

function renderProviderFields() {
  const providerId = elements.provider.value;
  const isOllama = providerId === 'ollama';
  const isSubscription = providerAuthType(providerId) === 'subscription';
  const connection = providerConnection(providerId);
  const isConnectedSubscription = connection?.kind === 'subscription';
  elements.providerPrivacy.textContent = providerPrivacyMessage(providerId);
  elements.hostedFields.classList.toggle('hidden', isOllama);
  elements.ollamaFields.classList.toggle('hidden', !isOllama);
  elements.apiKeyField.classList.toggle('hidden', isSubscription);
  elements.subscriptionFields.classList.toggle('hidden', !isSubscription);
  elements.saveProvider.hidden = isSubscription;
  elements.loginProvider.hidden =
    !isSubscription || isConnectedSubscription || providerLoginPending;
  elements.cancelProviderLogin.hidden = !isSubscription || !providerLoginPending;
  elements.provider.disabled = providerLoginPending;
  elements.model.disabled = providerLoginPending;
  if (!isOllama) renderModelOptions(providerId);
}

function renderModelOptions(providerId) {
  const selectedModel =
    providerStatus?.providerId === providerId ? providerStatus.modelId : elements.model.value;
  const provider = providerCatalog.find((candidate) => candidate.providerId === providerId);
  const options = (provider?.models || []).map((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name || model.id;
    return option;
  });
  elements.model.replaceChildren(...options);
  if (options.some((option) => option.value === selectedModel)) {
    elements.model.value = selectedModel;
  } else if (options[0]) {
    elements.model.value = options[0].value;
  }
}

function renderConnectedProviders() {
  const connections = providerConnections();
  elements.connectedProviders.hidden = connections.length === 0;
  const rows = connections.map((connection) => {
    const row = document.createElement('div');
    row.className = 'agent-connected-provider';
    const copy = document.createElement('div');
    copy.className = 'agent-connected-provider-copy';
    const name = document.createElement('strong');
    name.textContent = providerName(connection.providerId);
    const model = document.createElement('span');
    const count =
      connection.kind === 'ollama' ? (connection.modelIds || [connection.modelId]).length : null;
    model.textContent =
      count && count > 1
        ? `${count} local models`
        : modelName(connection.providerId, connection.modelId);
    copy.appendChild(name);
    copy.appendChild(model);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'agent-provider-remove';
    remove.textContent = 'Disconnect';
    remove.addEventListener('click', () => removeProviderConnection(connection.providerId));
    row.appendChild(copy);
    row.appendChild(remove);
    return row;
  });
  elements.connectedProviderList.replaceChildren(...rows);
}

function renderModelMenu() {
  const models = configuredModels();
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.providerId)) groups.set(model.providerId, []);
    groups.get(model.providerId).push(model);
  }
  const content = [];
  for (const [providerId, providerModels] of groups) {
    const label = document.createElement('div');
    label.className = 'agent-model-group-label';
    label.textContent = providerName(providerId);
    content.push(label);
    for (const model of providerModels) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'agent-model-option';
      option.setAttribute('role', 'menuitemradio');
      const active =
        providerStatus?.providerId === model.providerId &&
        providerStatus?.modelId === model.modelId;
      option.classList.toggle('active', active);
      option.setAttribute('aria-checked', String(active));
      const name = document.createElement('span');
      name.textContent = model.name;
      const check = document.createElement('span');
      check.textContent = active ? '✓' : '';
      option.appendChild(name);
      option.appendChild(check);
      option.addEventListener('click', () => selectModel(model.providerId, model.modelId));
      content.push(option);
    }
  }
  elements.modelMenuList.replaceChildren(...content);
}

function renderActiveModel() {
  const configured = providerStatus?.configured === true;
  elements.activeModelLabel.textContent = configured
    ? modelName(providerStatus.providerId, providerStatus.modelId)
    : 'Choose model';
  elements.modelMenuButton.title = configured
    ? `${providerName(providerStatus.providerId)} · ${providerStatus.modelId}`
    : '';
  renderModelMenu();
}

function renderProviderStatus(status) {
  providerStatus = status;
  const configured = status?.configured === true;
  elements.providerStatus.textContent = configured
    ? `${providerName(status.providerId)} · ${status.modelId}`
    : 'Not configured';
  elements.providerStatus.classList.toggle('active', configured);
  if (configured && Object.hasOwn(PROVIDER_NAMES, status.providerId)) {
    elements.provider.value = status.providerId;
    if (status.providerId === 'ollama') {
      elements.ollamaModel.value = status.modelId || '';
      elements.ollamaUrl.value = status.baseUrl || 'http://127.0.0.1:11434/v1';
    }
  }
  renderProviderFields();
  renderConnectedProviders();
  renderActiveModel();
  updateSendAvailability();
  if (agentView === 'loading') showPrimaryView();
}

async function refreshProvider() {
  try {
    const response = await window.electronAPI.getAgentProviderStatus();
    if (!response?.ok) {
      setMessage(
        elements.providerMessage,
        responseMessage(response, 'Could not load the agent model'),
        true
      );
      providerReady = true;
      providerStatus = { configured: false, connections: [] };
      showPrimaryView();
      return;
    }
    providerReady = true;
    renderProviderStatus(response.status);
  } catch {
    providerReady = true;
    providerStatus = { configured: false, connections: [] };
    setMessage(elements.providerMessage, 'Could not load the agent model', true);
    showPrimaryView();
  }
}

async function loadProviderCatalog() {
  if (providerCatalog.length) return providerCatalog;
  if (providerCatalogPromise) return providerCatalogPromise;
  providerCatalogPromise = (async () => {
    try {
      const response = await window.electronAPI.getAgentProviderCatalog();
      if (!response?.ok || !Array.isArray(response.catalog)) return providerCatalog;
      providerCatalog = response.catalog;
      renderProviderFields();
      renderConnectedProviders();
      renderActiveModel();
      return providerCatalog;
    } catch {
      // A saved Ollama model remains usable even if the hosted catalog cannot load.
      return providerCatalog;
    } finally {
      providerCatalogPromise = null;
    }
  })();
  return providerCatalogPromise;
}

async function selectModel(providerId, modelId) {
  if (currentRunStatus !== 'idle' || currentConversationId) return;
  elements.modelMenuButton.disabled = true;
  try {
    const response = await window.electronAPI.selectAgentModel(providerId, modelId);
    if (!response?.ok) {
      setMessage(elements.runMessage, responseMessage(response, 'Could not select model'), true);
      return;
    }
    renderProviderStatus(response.status);
    closeComposerPopovers();
  } catch {
    setMessage(elements.runMessage, 'Could not select model', true);
  } finally {
    elements.modelMenuButton.disabled =
      currentRunStatus !== 'idle' || Boolean(currentConversationId);
  }
}

async function removeProviderConnection(providerId) {
  const label = providerName(providerId);
  if (!window.confirm(`Disconnect ${label} from Agent?`)) return;
  try {
    const response = await window.electronAPI.removeAgentProvider(providerId);
    if (!response?.ok) {
      setMessage(
        elements.providerMessage,
        responseMessage(response, `Could not disconnect ${label}`),
        true
      );
      return;
    }
    renderProviderStatus(response.status);
    if (!response.status?.configured) setAgentView('setup');
  } catch {
    setMessage(elements.providerMessage, `Could not disconnect ${label}`, true);
  }
}

async function saveProvider() {
  const providerId = elements.provider.value;
  elements.saveProvider.disabled = true;
  setMessage(elements.providerMessage, 'Saving…');
  try {
    let response;
    if (providerId === 'ollama') {
      response = await window.electronAPI.configureOllamaAgentProvider(
        elements.ollamaModel.value.trim(),
        elements.ollamaUrl.value.trim()
      );
    } else {
      response = await window.electronAPI.configureHostedAgentProvider(
        providerId,
        elements.model.value,
        elements.apiKey.value
      );
    }
    elements.apiKey.value = '';
    if (!response?.ok) {
      setMessage(elements.providerMessage, responseMessage(response, 'Could not save model'), true);
      return;
    }
    renderProviderStatus(response.status);
    setMessage(elements.providerMessage, 'Model saved for this profile');
    setAgentView('workspace');
    elements.prompt.focus();
  } catch {
    elements.apiKey.value = '';
    setMessage(elements.providerMessage, 'Could not save model', true);
  } finally {
    elements.saveProvider.disabled = false;
  }
}

function handleProviderAuthEvent(event) {
  if (
    !providerLoginPending ||
    event?.type !== 'device_code' ||
    event.providerId !== 'openai-codex' ||
    typeof event.userCode !== 'string'
  ) {
    return;
  }
  elements.authUserCode.textContent = event.userCode;
  elements.authCode.hidden = false;
  setMessage(elements.providerMessage, 'Finish signing in on the OpenAI page');
}

async function loginSubscriptionProvider() {
  const providerId = elements.provider.value;
  const modelId = elements.model.value;
  if (providerAuthType(providerId) !== 'subscription' || !modelId) {
    setMessage(elements.providerMessage, 'Choose a subscription model first', true);
    return;
  }
  providerLoginPending = true;
  elements.authCode.hidden = true;
  elements.authUserCode.textContent = '';
  setMessage(elements.providerMessage, 'Starting ChatGPT sign-in…');
  renderProviderFields();
  try {
    const response = await window.electronAPI.loginSubscriptionAgentProvider(providerId, modelId);
    if (!response?.ok) {
      setMessage(
        elements.providerMessage,
        responseMessage(response, 'Could not sign in with ChatGPT'),
        response?.error?.code !== 'AGENT_PROVIDER_AUTH_CANCELLED'
      );
      return;
    }
    renderProviderStatus(response.status);
    setMessage(elements.providerMessage, 'ChatGPT connected for this profile');
    setAgentView('workspace');
    elements.prompt.focus();
  } catch {
    setMessage(elements.providerMessage, 'Could not sign in with ChatGPT', true);
  } finally {
    providerLoginPending = false;
    renderProviderFields();
  }
}

async function cancelProviderLogin() {
  if (!providerLoginPending) return;
  elements.cancelProviderLogin.disabled = true;
  setMessage(elements.providerMessage, 'Cancelling sign-in…');
  try {
    await window.electronAPI.cancelAgentProviderLogin();
  } catch {
    setMessage(elements.providerMessage, 'Could not cancel sign-in', true);
  } finally {
    elements.cancelProviderLogin.disabled = false;
  }
}

function setRunState(status, label) {
  const active = status !== 'idle';
  currentRunStatus = status;
  elements.run.disabled = active || !elements.prompt.value.trim() || !providerStatus?.configured;
  elements.pause.hidden = status !== 'running';
  elements.pause.disabled = status !== 'running';
  elements.resume.hidden = status !== 'paused';
  elements.resume.disabled = status !== 'paused';
  elements.stop.hidden = !active;
  elements.stop.disabled = !active || !currentRunId;
  elements.prompt.disabled = active;
  elements.modelMenuButton.disabled = active || Boolean(currentConversationId);
  elements.approvalModeButton.disabled = active || Boolean(currentConversationId);
  elements.newChat.hidden = !currentConversationId;
  elements.newChat.disabled = active;
  elements.runStatus.textContent = label;
  elements.runStatus.classList.toggle('active', active);
  renderSessionSidebar();
}

function updateSendAvailability() {
  elements.run.disabled =
    currentRunStatus !== 'idle' || !elements.prompt.value.trim() || !providerStatus?.configured;
}

function resetConversationUi() {
  toolRows.clear();
  turnViews.clear();
  elements.transcript.replaceChildren();
  elements.transcript.hidden = true;
  elements.emptyState.hidden = false;
  clearApproval();
  setMessage(elements.runMessage);
}

function createTurnView(turn) {
  for (const previous of turnViews.values()) {
    previous.output.removeAttribute('id');
    previous.toolList.removeAttribute('id');
  }

  const section = document.createElement('section');
  section.className = 'agent-turn';
  section.dataset.runId = turn.runId;

  const userRow = document.createElement('div');
  userRow.className = 'agent-message-row user';
  const userMessage = document.createElement('div');
  userMessage.className = 'agent-user-message';
  userMessage.textContent = turn.userText || '';
  userRow.appendChild(userMessage);

  const assistantRow = document.createElement('div');
  assistantRow.className = 'agent-message-row assistant';
  const output = document.createElement('div');
  output.id = 'agent-output';
  output.className = 'agent-output';
  output.textContent = turn.assistantText || '';
  assistantRow.appendChild(output);

  const activity = document.createElement('details');
  activity.className = 'agent-turn-activity';
  activity.open = true;
  activity.hidden = true;
  const activitySummary = document.createElement('summary');
  activitySummary.textContent = 'Working…';
  const toolList = document.createElement('ol');
  toolList.id = 'agent-tool-list';
  toolList.className = 'agent-tool-list';
  activity.appendChild(activitySummary);
  activity.appendChild(toolList);

  section.appendChild(userRow);
  section.appendChild(assistantRow);
  section.appendChild(activity);
  elements.transcript.appendChild(section);
  elements.transcript.hidden = false;
  elements.emptyState.hidden = true;

  const view = {
    section,
    output,
    activity,
    activitySummary,
    toolList,
    assistantText: turn.assistantText || '',
    actionCount: 0,
  };
  turnViews.set(turn.runId, view);
  section.scrollIntoView?.({ block: 'end' });
  return view;
}

function turnView(runId) {
  return turnViews.get(runId) || null;
}

function formatDuration(durationMs) {
  const seconds = Math.max(1, Math.round((Number(durationMs) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function renderAssistantMarkdown(view) {
  if (!view?.assistantText || !window.marked?.parse || !window.DOMPurify?.sanitize) return;
  try {
    const rendered = window.marked.parse(view.assistantText, { gfm: true, breaks: true });
    if (typeof rendered !== 'string') return;
    view.output.innerHTML = window.DOMPurify.sanitize(rendered, {
      ALLOWED_TAGS: [
        'p',
        'br',
        'strong',
        'em',
        'del',
        'code',
        'pre',
        'blockquote',
        'ul',
        'ol',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'hr',
      ],
      ALLOWED_ATTR: [],
    });
    view.output.classList.add('rendered-markdown');
  } catch {
    view.output.textContent = view.assistantText;
    view.output.classList.remove('rendered-markdown');
  }
}

function restoreTranscript(transcript = []) {
  resetConversationUi();
  for (const turn of transcript) {
    if (!turn || typeof turn.runId !== 'string') continue;
    const view = createTurnView(turn);
    for (const item of Array.isArray(turn.activity) ? turn.activity : []) {
      addToolRow({ ...item, runId: turn.runId });
      if (item.status !== 'running') finishToolRow({ ...item, runId: turn.runId });
    }
    if (
      turn.status &&
      !['starting', 'running', 'pausing', 'paused', 'resuming'].includes(turn.status)
    ) {
      finishTurnView(turn.runId, turn);
    }
    if (view.assistantText && turn.status === 'completed') renderAssistantMarkdown(view);
  }
}

function clearApproval() {
  pendingApproval = null;
  elements.approval.hidden = true;
  elements.approvalApprove.disabled = false;
  elements.approvalDecline.disabled = false;
  setMessage(elements.approvalMessage);
}

function renderApproval(request) {
  if (!request || typeof request.approvalId !== 'string') return;
  pendingApproval = request;
  const label = typeof request.label === 'string' && request.label ? request.label : 'this element';
  const interactionCopy = {
    browser_click: `Let Agent click “${label}”?`,
    browser_type: `Let Agent type in “${label}”?`,
    browser_select: `Let Agent change “${label}”?`,
    browser_press: `Let Agent press a key on “${label}”?`,
  };
  elements.approvalAction.textContent =
    request.action === 'form_submission'
      ? `Submit this form using “${label}”?`
      : interactionCopy[request.operation] || `Let Agent interact with “${label}”?`;
  elements.approvalOrigin.textContent = request.origin
    ? `Site: ${request.origin}`
    : 'Site origin unavailable';
  elements.approvalApprove.disabled = false;
  elements.approvalDecline.disabled = false;
  setMessage(elements.approvalMessage, 'The agent is paused until you decide.');
  elements.approval.hidden = false;
}

async function decideApproval(approved) {
  const request = pendingApproval;
  if (!request || !currentRunId) return;
  elements.approvalApprove.disabled = true;
  elements.approvalDecline.disabled = true;
  setMessage(elements.approvalMessage, approved ? 'Approving…' : 'Declining…');
  try {
    const response = await window.electronAPI.decideAgentApproval(
      currentRunId,
      request.approvalId,
      approved
    );
    if (!response?.ok && pendingApproval === request) {
      elements.approvalApprove.disabled = false;
      elements.approvalDecline.disabled = false;
      setMessage(
        elements.approvalMessage,
        responseMessage(response, 'Could not record the decision'),
        true
      );
    }
  } catch {
    if (pendingApproval !== request) return;
    elements.approvalApprove.disabled = false;
    elements.approvalDecline.disabled = false;
    setMessage(elements.approvalMessage, 'Could not record the decision', true);
  }
}

function formatOperation(operation) {
  return String(operation || 'browser action')
    .replace(/^browser_/, '')
    .replaceAll('_', ' ');
}

function addToolRow(event) {
  const view = turnView(event.runId);
  if (!view || typeof event.toolCallId !== 'string') return;
  const row = document.createElement('li');
  row.className = 'agent-tool-item';
  const state = document.createElement('span');
  state.className = 'agent-tool-state';
  state.textContent = '•';
  const label = document.createElement('span');
  label.textContent = formatOperation(event.operation);
  row.appendChild(state);
  row.appendChild(label);
  view.toolList.appendChild(row);
  view.activity.hidden = false;
  view.activity.open = true;
  view.actionCount += 1;
  toolRows.set(`${event.runId}:${event.toolCallId}`, { row, state });
}

function finishToolRow(event) {
  const record = toolRows.get(`${event.runId}:${event.toolCallId}`);
  if (!record) return;
  record.state.textContent = event.status === 'failed' ? '×' : '✓';
  record.row.classList.toggle('failed', event.status === 'failed');
}

function finishTurnView(runId, event = {}) {
  const view = turnView(runId);
  if (!view) return;
  const actionCount = Number.isSafeInteger(event.actionCount)
    ? event.actionCount
    : view.actionCount;
  if (actionCount > 0) {
    view.activity.hidden = false;
    view.activity.open = false;
    view.activitySummary.textContent = `Worked for ${formatDuration(event.durationMs)} · ${actionCount} ${actionCount === 1 ? 'action' : 'actions'}`;
  } else {
    view.activity.hidden = true;
  }
  if (event.status === 'completed') renderAssistantMarkdown(view);
}

function applyConversationCleared() {
  currentConversationId = null;
  conversationRendererTabId = null;
  pendingPromptText = '';
  currentRunId = null;
  lastFinishedRunId = null;
  takeoverRequestedRunId = null;
  setConversationTitle('New task');
  setAgentControlledTab(null);
  taskTabProjection = [];
  renderTaskPages();
  resetConversationUi();
  setRunState('idle', 'Idle');
  renderSessionSidebar();
}

function handleAgentEvent(event) {
  if (event?.type === 'conversation_cleared') {
    if (!currentConversationId || event.conversationId === currentConversationId) {
      applyConversationCleared();
    }
    return;
  }
  if (!event || typeof event.runId !== 'string') return;
  if (
    currentConversationId &&
    typeof event.conversationId === 'string' &&
    event.conversationId !== currentConversationId
  ) {
    return;
  }
  if (currentRunId && currentRunId !== event.runId) return;
  if (event.type === 'run_started') {
    if (!currentConversationId && typeof event.userText === 'string') {
      setConversationTitle(event.userText);
    }
    currentConversationId =
      typeof event.conversationId === 'string' ? event.conversationId : currentConversationId;
    currentRunId = event.runId;
    lastFinishedRunId = null;
    if (!turnView(event.runId)) {
      createTurnView({
        runId: event.runId,
        userText: typeof event.userText === 'string' ? event.userText : pendingPromptText,
        assistantText: '',
      });
    }
    pendingPromptText = '';
    setRunState('running', 'Running');
    elements.emptyState.hidden = true;
    setMessage(
      elements.runMessage,
      'Agent stays attached to this tab if you switch tabs. Choose Take over to stop it.'
    );
    return;
  }
  if (!currentRunId) return;
  if (event.type === 'assistant_text_delta' && typeof event.text === 'string') {
    const view = turnView(event.runId);
    if (!view) return;
    view.assistantText += event.text;
    view.output.textContent = view.assistantText;
    view.section.scrollIntoView?.({ block: 'end' });
    elements.emptyState.hidden = true;
  } else if (event.type === 'tool_started') {
    addToolRow(event);
    elements.emptyState.hidden = true;
  } else if (event.type === 'tool_finished') {
    finishToolRow(event);
    void refreshWorkspaceProjection();
  } else if (event.type === 'run_retrying') {
    setMessage(elements.runMessage, `Provider retry ${event.attempt} of ${event.maxAttempts}…`);
  } else if (event.type === 'context_compaction_started') {
    setMessage(elements.runMessage, 'Making room for more conversation…');
  } else if (event.type === 'context_compaction_finished') {
    setMessage(
      elements.runMessage,
      event.status === 'failed'
        ? 'Could not compact the conversation; continuing with available context.'
        : 'Conversation compacted. Continuing…',
      event.status === 'failed'
    );
  } else if (event.type === 'approval_requested') {
    renderApproval(event);
    setRunState('running', 'Approval needed');
  } else if (
    event.type === 'approval_resolved' &&
    pendingApproval?.approvalId === event.approvalId
  ) {
    clearApproval();
    setRunState('running', 'Running');
  } else if (event.type === 'run_pausing') {
    setRunState('pausing', 'Pausing');
    setMessage(elements.runMessage, 'Pausing after the current browser operation settles…');
  } else if (event.type === 'run_paused') {
    clearApproval();
    setRunState('paused', 'Paused');
    setMessage(elements.runMessage, 'You can change the page, then resume this task.');
  } else if (event.type === 'run_resuming') {
    setRunState('resuming', 'Resuming');
    setMessage(elements.runMessage, 'Checking the page before the agent continues…');
  } else if (event.type === 'run_resumed') {
    setRunState('running', 'Running');
    setMessage(elements.runMessage, 'Agent is re-reading the current page before acting.');
  } else if (event.type === 'run_finished') {
    const status = event.status || 'finished';
    const wasTakeover = status === 'cancelled' && takeoverRequestedRunId === event.runId;
    setRunState('idle', wasTakeover ? 'Taken over' : status === 'completed' ? 'Complete' : status);
    if (wasTakeover) {
      setMessage(elements.runMessage, 'You took control of the tab');
    } else if (event.error?.message) {
      setMessage(elements.runMessage, event.error.message, true);
    } else {
      setMessage(elements.runMessage);
    }
    finishTurnView(event.runId, event);
    lastFinishedRunId = event.runId;
    currentRunId = null;
    takeoverRequestedRunId = null;
    clearApproval();
    setAgentControlledTab(null);
    void refreshWorkspaceProjection();
  }
}

async function startRun() {
  const prompt = elements.prompt.value.trim();
  const tab = getActiveTab();
  if (!prompt) {
    setMessage(elements.runMessage, 'Describe what you want the agent to do', true);
    return;
  }
  const rendererTabId = currentConversationId ? conversationRendererTabId : tab?.id;
  if (!Number.isSafeInteger(rendererTabId) || rendererTabId < 1) {
    setMessage(elements.runMessage, 'The current tab is not ready for the agent', true);
    return;
  }
  const startsConversation = !currentConversationId;
  if (startsConversation) setConversationTitle(prompt);
  pendingPromptText = prompt;
  elements.prompt.value = '';
  if (!currentConversationId) conversationRendererTabId = rendererTabId;
  setAgentControlledTab(conversationRendererTabId);
  setRunState('starting', 'Starting');
  setMessage(elements.runMessage);
  try {
    const response = await window.electronAPI.startAgent(rendererTabId, prompt, approvalMode);
    if (!response?.ok) {
      currentRunId = null;
      if (!currentConversationId) {
        conversationRendererTabId = null;
        setAgentControlledTab(null);
        setConversationTitle('New task');
      }
      if (!elements.prompt.value) elements.prompt.value = pendingPromptText;
      pendingPromptText = '';
      setRunState('idle', 'Idle');
      setMessage(elements.runMessage, responseMessage(response, 'Could not start the agent'), true);
      return;
    }
    currentConversationId = response.conversationId || currentConversationId;
    void refreshWorkspaceProjection();
    pendingPromptText = '';
    if (lastFinishedRunId !== response.runId) {
      currentRunId = response.runId;
      setRunState('running', 'Running');
    } else {
      setRunState('idle', elements.runStatus.textContent || 'Complete');
    }
  } catch {
    currentRunId = null;
    if (!currentConversationId) {
      conversationRendererTabId = null;
      setAgentControlledTab(null);
      setConversationTitle('New task');
    }
    if (!elements.prompt.value) elements.prompt.value = pendingPromptText;
    pendingPromptText = '';
    setRunState('idle', 'Idle');
    setMessage(elements.runMessage, 'Could not start the agent', true);
  }
}

async function clearConversation() {
  if (!currentConversationId || currentRunStatus !== 'idle') return;
  elements.newChat.disabled = true;
  setMessage(elements.runMessage, 'Starting a new chat…');
  try {
    const response = await window.electronAPI.clearAgentConversation();
    if (!response?.ok) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not start a new chat'),
        true
      );
      elements.newChat.disabled = false;
      return;
    }
    applyConversationCleared();
    elements.prompt.focus();
  } catch {
    setMessage(elements.runMessage, 'Could not start a new chat', true);
    elements.newChat.disabled = false;
  }
}

async function startNewSessionFromSidebar() {
  if (currentRunStatus !== 'idle') return;
  if (currentConversationId) {
    await clearConversation();
    return;
  }
  elements.prompt.focus();
}

async function pauseRun() {
  if (!currentRunId || currentRunStatus !== 'running') return;
  const runId = currentRunId;
  setRunState('pausing', 'Pausing');
  setMessage(elements.runMessage, 'Pausing…');
  try {
    const response = await window.electronAPI.pauseAgent(runId);
    if ((!response?.ok || response.paused !== true) && currentRunId === runId) {
      setRunState('running', 'Running');
      setMessage(elements.runMessage, responseMessage(response, 'Could not pause the agent'), true);
    }
  } catch {
    if (currentRunId !== runId) return;
    setRunState('running', 'Running');
    setMessage(elements.runMessage, 'Could not pause the agent', true);
  }
}

async function resumeRun() {
  if (!currentRunId || currentRunStatus !== 'paused') return;
  const runId = currentRunId;
  setRunState('resuming', 'Resuming');
  setMessage(elements.runMessage, 'Checking the page before the agent continues…');
  try {
    const response = await window.electronAPI.resumeAgent(runId);
    if ((!response?.ok || response.resumed !== true) && currentRunId === runId) {
      setRunState('paused', 'Paused');
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not resume the agent'),
        true
      );
    }
  } catch {
    if (currentRunId !== runId) return;
    setRunState('paused', 'Paused');
    setMessage(elements.runMessage, 'Could not resume the agent', true);
  }
}

async function stopRun() {
  if (!currentRunId) return;
  const previousStatus = currentRunStatus;
  takeoverRequestedRunId = currentRunId;
  setRunState('stopping', 'Taking over');
  setMessage(elements.runMessage, 'Taking over…');
  try {
    const response = await window.electronAPI.stopAgent(currentRunId);
    if (!response?.ok) {
      takeoverRequestedRunId = null;
      setRunState(
        previousStatus === 'paused' ? 'paused' : 'running',
        previousStatus === 'paused' ? 'Paused' : 'Running'
      );
      setMessage(elements.runMessage, responseMessage(response, 'Could not stop the agent'), true);
    }
  } catch {
    takeoverRequestedRunId = null;
    setRunState(
      previousStatus === 'paused' ? 'paused' : 'running',
      previousStatus === 'paused' ? 'Paused' : 'Running'
    );
    setMessage(elements.runMessage, 'Could not stop the agent', true);
  }
}

async function restoreRunState() {
  try {
    const response = await window.electronAPI.getAgentState();
    const state = response?.ok ? response.state : null;
    applyWorkspaceProjection(state);
    if (!state?.conversationId) return;
    if (Object.hasOwn(APPROVAL_MODE_LABELS, state.approvalMode)) {
      setApprovalMode(state.approvalMode);
    }
    currentConversationId = state.conversationId;
    const restoredTranscript = Array.isArray(state.transcript) ? state.transcript : [];
    setConversationTitle(restoredTranscript[0]?.userText || 'Current task');
    renderTaskPages();
    conversationRendererTabId = Number.isSafeInteger(state.rendererTabId)
      ? state.rendererTabId
      : null;
    restoreTranscript(restoredTranscript);

    if (state.runId && state.status !== 'ready') {
      currentRunId = state.runId;
      if (conversationRendererTabId) setAgentControlledTab(conversationRendererTabId);
      const restoredStatus = ['paused', 'pausing', 'resuming'].includes(state.status)
        ? state.status
        : 'running';
      const restoredLabel =
        restoredStatus === 'paused'
          ? 'Paused'
          : restoredStatus === 'pausing'
            ? 'Pausing'
            : restoredStatus === 'resuming'
              ? 'Resuming'
              : 'Running';
      setRunState(restoredStatus, restoredLabel);
      setMessage(elements.runMessage, 'This run began before the panel was loaded');
      if (state.pendingApproval) {
        renderApproval(state.pendingApproval);
        setRunState('running', 'Approval needed');
      }
    } else {
      setRunState('idle', 'Ready');
    }
  } catch {
    // Idle is the safe renderer default when lifecycle state cannot be restored.
  }
}

export function initAgentUi(options = {}) {
  elements = {
    toggle: byId('agent-toggle-btn'),
    panel: byId('agent-sidebar'),
    close: byId('agent-sidebar-close'),
    agentFirstToggle: byId('agent-first-toggle'),
    agentFirstTitlebar: byId('agent-first-titlebar'),
    agentFirstTitle: byId('agent-first-title'),
    browserReturn: byId('agent-first-browser-return'),
    sessionSidebarToggle: byId('agent-session-sidebar-toggle'),
    workspaceSidebarToggle: byId('agent-workspace-sidebar-toggle'),
    sessionSidebar: byId('agent-session-sidebar'),
    sessionNewChat: byId('agent-session-new-chat'),
    currentSession: byId('agent-current-session'),
    currentSessionTitle: byId('agent-current-session-title'),
    sessionHistoryEmpty: byId('agent-session-history-empty'),
    taskPages: byId('agent-task-pages'),
    taskPageCount: byId('agent-task-page-count'),
    taskPageList: byId('agent-task-page-list'),
    taskPagesEmpty: byId('agent-task-pages-empty'),
    taskPagesNote: byId('agent-task-pages-note'),
    back: byId('agent-sidebar-back'),
    title: byId('agent-sidebar-title'),
    subtitle: byId('agent-sidebar-subtitle'),
    loadingView: byId('agent-loading-view'),
    setupView: byId('agent-setup-view'),
    workspaceView: byId('agent-workspace-view'),
    connectedProviders: byId('agent-connected-providers'),
    connectedProviderList: byId('agent-connected-provider-list'),
    provider: byId('agent-provider-select'),
    providerStatus: byId('agent-provider-status'),
    providerPrivacy: byId('agent-provider-privacy'),
    hostedFields: byId('agent-hosted-fields'),
    apiKeyField: byId('agent-api-key-field'),
    subscriptionFields: byId('agent-subscription-fields'),
    ollamaFields: byId('agent-ollama-fields'),
    model: byId('agent-model-select'),
    apiKey: byId('agent-api-key'),
    ollamaModel: byId('agent-ollama-model'),
    ollamaUrl: byId('agent-ollama-url'),
    saveProvider: byId('agent-provider-save'),
    loginProvider: byId('agent-provider-login'),
    cancelProviderLogin: byId('agent-provider-cancel-login'),
    authCode: byId('agent-auth-code'),
    authUserCode: byId('agent-auth-user-code'),
    providerMessage: byId('agent-provider-message'),
    prompt: byId('agent-prompt'),
    run: byId('agent-run'),
    newChat: byId('agent-new-chat'),
    pause: byId('agent-pause'),
    resume: byId('agent-resume'),
    stop: byId('agent-stop'),
    runStatus: byId('agent-run-status'),
    runMessage: byId('agent-run-message'),
    approval: byId('agent-approval'),
    approvalAction: byId('agent-approval-action'),
    approvalOrigin: byId('agent-approval-origin'),
    approvalApprove: byId('agent-approval-approve'),
    approvalDecline: byId('agent-approval-decline'),
    approvalMessage: byId('agent-approval-message'),
    transcript: byId('agent-transcript'),
    emptyState: byId('agent-empty-state'),
    modelMenuButton: byId('agent-model-menu-button'),
    activeModelLabel: byId('agent-active-model-label'),
    modelMenu: byId('agent-model-menu'),
    modelMenuList: byId('agent-model-menu-list'),
    manageProviders: byId('agent-manage-providers'),
    approvalModeButton: byId('agent-approval-mode-button'),
    activeApprovalModeLabel: byId('agent-active-approval-mode-label'),
    approvalModePopover: byId('agent-approval-mode-popover'),
    approvalModeEvery: byId('agent-approval-mode-every'),
    approvalModeSensitive: byId('agent-approval-mode-sensitive'),
    approvalModeAllow: byId('agent-approval-mode-allow'),
  };
  if (Object.values(elements).some((element) => !element)) return;
  getActiveTab = typeof options.getActiveTab === 'function' ? options.getActiveTab : () => null;
  getOpenTabs = typeof options.getOpenTabs === 'function' ? options.getOpenTabs : () => [];
  switchToTab = typeof options.switchTab === 'function' ? options.switchTab : () => {};
  setAgentControlledTab =
    typeof options.setAgentControlledTab === 'function' ? options.setAgentControlledTab : () => {};
  if (isPrivateWindow()) {
    elements.toggle.classList.add('hidden');
    return;
  }

  elements.toggle.addEventListener('click', togglePanel);
  elements.close.addEventListener('click', closePanel);
  elements.agentFirstToggle.addEventListener('click', () => setAgentFirstMode(!agentFirstMode));
  elements.browserReturn.addEventListener('click', () => setAgentFirstMode(false));
  elements.sessionSidebarToggle.addEventListener('click', () =>
    setSessionSidebarOpen(!sessionSidebarOpen)
  );
  elements.workspaceSidebarToggle.addEventListener('click', () =>
    setWorkspaceSidebarOpen(!workspaceSidebarOpen)
  );
  elements.sessionNewChat.addEventListener('click', startNewSessionFromSidebar);
  elements.currentSession.addEventListener('click', () => elements.prompt.focus());
  elements.back.addEventListener('click', () => setAgentView('workspace'));
  elements.provider.addEventListener('change', renderProviderFields);
  elements.saveProvider.addEventListener('click', saveProvider);
  elements.loginProvider.addEventListener('click', loginSubscriptionProvider);
  elements.cancelProviderLogin.addEventListener('click', cancelProviderLogin);
  elements.run.addEventListener('click', startRun);
  elements.newChat.addEventListener('click', clearConversation);
  elements.prompt.addEventListener('input', updateSendAvailability);
  elements.prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!elements.run.disabled) startRun();
  });
  elements.pause.addEventListener('click', pauseRun);
  elements.resume.addEventListener('click', resumeRun);
  elements.stop.addEventListener('click', stopRun);
  elements.approvalApprove.addEventListener('click', () => decideApproval(true));
  elements.approvalDecline.addEventListener('click', () => decideApproval(false));
  elements.modelMenuButton.addEventListener('click', () => {
    const opening = elements.modelMenu.hidden;
    closeComposerPopovers();
    elements.modelMenu.hidden = !opening;
    elements.modelMenuButton.setAttribute('aria-expanded', String(opening));
  });
  elements.approvalModeButton.addEventListener('click', () => {
    const opening = elements.approvalModePopover.hidden;
    closeComposerPopovers();
    elements.approvalModePopover.hidden = !opening;
    elements.approvalModeButton.setAttribute('aria-expanded', String(opening));
  });
  elements.approvalModeEvery.addEventListener('click', () =>
    setApprovalMode(APPROVAL_MODES.EVERY_INTERACTION)
  );
  elements.approvalModeAllow.addEventListener('click', () =>
    setApprovalMode(APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS)
  );
  elements.manageProviders.addEventListener('click', showProviderSetup);
  document.addEventListener('click', (event) => {
    if (
      !elements.modelMenu.hidden &&
      !elements.modelMenu.contains(event.target) &&
      !elements.modelMenuButton.contains(event.target)
    ) {
      closeComposerPopovers();
    }
    if (
      !elements.approvalModePopover.hidden &&
      !elements.approvalModePopover.contains(event.target) &&
      !elements.approvalModeButton.contains(event.target)
    ) {
      closeComposerPopovers();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const popoverWasOpen = !elements.modelMenu.hidden || !elements.approvalModePopover.hidden;
    closeComposerPopovers();
    if (!popoverWasOpen && agentFirstMode) setAgentFirstMode(false);
  });
  document.addEventListener('sidebar-opened', closePanel);
  onSignatureFlightChange((inFlight) => {
    elements.toggle.disabled = inFlight;
    if (inFlight) closePanel();
  });
  agentEventUnsubscribe?.();
  agentEventUnsubscribe = window.electronAPI.onAgentEvent(handleAgentEvent);
  providerAuthEventUnsubscribe?.();
  providerAuthEventUnsubscribe =
    window.electronAPI.onAgentProviderAuthEvent(handleProviderAuthEvent);
  tabPresentationUnsubscribe?.();
  tabPresentationUnsubscribe =
    typeof options.subscribeTabPresentation === 'function'
      ? options.subscribeTabPresentation((tabs) => {
          openTabs = Array.isArray(tabs) ? tabs : [];
          renderTaskPages();
          ensureWorkspacePageVisible();
        })
      : null;
  setPanelOpen(false);
  setSessionSidebarOpen(true);
  setWorkspaceSidebarOpen(true);
  setConversationTitle('New task');
  setAgentFirstMode(false);
  setAgentView('loading');
  renderProviderFields();
  updateSendAvailability();
  renderSessionSidebar();
  refreshProvider();
  restoreRunState();
}

export { formatOperation, handleAgentEvent, providerPrivacyMessage, responseMessage };
