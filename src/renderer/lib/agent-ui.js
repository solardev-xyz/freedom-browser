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
let setAgentControlledTab = () => {};
let providerCatalog = [];
let providerCatalogPromise = null;
let providerStatus = null;
let providerReady = false;
let providerLoginPending = false;
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
const toolRows = new Map();

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
  if (!Object.hasOwn(APPROVAL_MODE_LABELS, nextMode) || currentRunStatus !== 'idle') return;
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
    : 'Give this tab a task';
  closeComposerPopovers();
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
  if (currentRunStatus !== 'idle') return;
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
    elements.modelMenuButton.disabled = currentRunStatus !== 'idle';
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
  elements.modelMenuButton.disabled = active;
  elements.approvalModeButton.disabled = active;
  elements.runStatus.textContent = label;
  elements.runStatus.classList.toggle('active', active);
}

function updateSendAvailability() {
  elements.run.disabled =
    currentRunStatus !== 'idle' || !elements.prompt.value.trim() || !providerStatus?.configured;
}

function resetRunOutput() {
  toolRows.clear();
  elements.toolList.replaceChildren();
  elements.output.textContent = '';
  elements.transcript.hidden = true;
  elements.activity.hidden = true;
  elements.emptyState.hidden = true;
  clearApproval();
  setMessage(elements.runMessage);
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
  const row = document.createElement('li');
  row.className = 'agent-tool-item';
  const state = document.createElement('span');
  state.className = 'agent-tool-state';
  state.textContent = '•';
  const label = document.createElement('span');
  label.textContent = formatOperation(event.operation);
  row.appendChild(state);
  row.appendChild(label);
  elements.toolList.appendChild(row);
  elements.activity.hidden = false;
  toolRows.set(event.toolCallId, { row, state });
}

function finishToolRow(event) {
  const record = toolRows.get(event.toolCallId);
  if (!record) return;
  record.state.textContent = event.status === 'failed' ? '×' : '✓';
  record.row.classList.toggle('failed', event.status === 'failed');
}

function handleAgentEvent(event) {
  if (!event || typeof event.runId !== 'string') return;
  if (currentRunId && currentRunId !== event.runId) return;
  if (event.type === 'run_started') {
    currentRunId = event.runId;
    lastFinishedRunId = null;
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
    elements.output.textContent += event.text;
    elements.transcript.hidden = false;
    elements.emptyState.hidden = true;
  } else if (event.type === 'tool_started') {
    addToolRow(event);
    elements.emptyState.hidden = true;
  } else if (event.type === 'tool_finished') {
    finishToolRow(event);
  } else if (event.type === 'run_retrying') {
    setMessage(elements.runMessage, `Provider retry ${event.attempt} of ${event.maxAttempts}…`);
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
    const wasTabClosed = event.error?.code === 'AGENT_TAB_CLOSED';
    setRunState(
      'idle',
      wasTakeover
        ? 'Taken over'
        : wasTabClosed
          ? 'Tab closed'
          : status === 'completed'
            ? 'Complete'
            : status
    );
    if (wasTakeover) {
      setMessage(elements.runMessage, 'You took control of the tab');
    } else if (event.error?.message) {
      setMessage(elements.runMessage, event.error.message, true);
    } else {
      setMessage(elements.runMessage);
    }
    lastFinishedRunId = event.runId;
    currentRunId = null;
    takeoverRequestedRunId = null;
    clearApproval();
    setAgentControlledTab(null);
  }
}

async function startRun() {
  const prompt = elements.prompt.value.trim();
  const tab = getActiveTab();
  if (!prompt) {
    setMessage(elements.runMessage, 'Describe what you want the agent to do', true);
    return;
  }
  if (!Number.isSafeInteger(tab?.id) || tab.id < 1) {
    setMessage(elements.runMessage, 'The current tab is not ready for the agent', true);
    return;
  }
  resetRunOutput();
  setAgentControlledTab(tab.id);
  setRunState('starting', 'Starting');
  try {
    const response = await window.electronAPI.startAgent(tab.id, prompt, approvalMode);
    if (!response?.ok) {
      currentRunId = null;
      setAgentControlledTab(null);
      setRunState('idle', 'Idle');
      setMessage(elements.runMessage, responseMessage(response, 'Could not start the agent'), true);
      return;
    }
    if (lastFinishedRunId !== response.runId) {
      currentRunId = response.runId;
      setRunState('running', 'Running');
    }
  } catch {
    currentRunId = null;
    setAgentControlledTab(null);
    setRunState('idle', 'Idle');
    setMessage(elements.runMessage, 'Could not start the agent', true);
  }
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
    if (response?.ok && response.state?.status !== 'idle' && response.state?.runId) {
      currentRunId = response.state.runId;
      if (Number.isSafeInteger(response.state.rendererTabId)) {
        setAgentControlledTab(response.state.rendererTabId);
      }
      const restoredStatus = ['paused', 'pausing', 'resuming'].includes(response.state.status)
        ? response.state.status
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
      if (response.state.pendingApproval) {
        renderApproval(response.state.pendingApproval);
        setRunState('running', 'Approval needed');
      }
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
    output: byId('agent-output'),
    activity: byId('agent-activity'),
    toolList: byId('agent-tool-list'),
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
  setAgentControlledTab =
    typeof options.setAgentControlledTab === 'function' ? options.setAgentControlledTab : () => {};
  if (isPrivateWindow()) {
    elements.toggle.classList.add('hidden');
    return;
  }

  elements.toggle.addEventListener('click', togglePanel);
  elements.close.addEventListener('click', closePanel);
  elements.back.addEventListener('click', () => setAgentView('workspace'));
  elements.provider.addEventListener('change', renderProviderFields);
  elements.saveProvider.addEventListener('click', saveProvider);
  elements.loginProvider.addEventListener('click', loginSubscriptionProvider);
  elements.cancelProviderLogin.addEventListener('click', cancelProviderLogin);
  elements.run.addEventListener('click', startRun);
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
    if (event.key === 'Escape') closeComposerPopovers();
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
  setPanelOpen(false);
  setAgentView('loading');
  renderProviderFields();
  updateSendAvailability();
  refreshProvider();
  restoreRunState();
}

export { formatOperation, handleAgentEvent, providerPrivacyMessage, responseMessage };
