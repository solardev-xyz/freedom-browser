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

let elements = {};
let getActiveTab = () => null;
let setAgentControlledTab = () => {};
let providerCatalog = [];
let providerCatalogPromise = null;
let providerStatus = null;
let providerLoginPending = false;
let currentRunId = null;
let lastFinishedRunId = null;
let takeoverRequestedRunId = null;
let pendingApproval = null;
let panelOpen = false;
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
  loadProviderCatalog();
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
  const isConnectedSubscription =
    providerStatus?.configured === true &&
    providerStatus.kind === 'subscription' &&
    providerStatus.providerId === providerId;
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

function renderProviderStatus(status) {
  providerStatus = status;
  const configured = status?.configured === true;
  elements.providerStatus.textContent = configured
    ? `${providerName(status.providerId)} · ${status.modelId}`
    : 'Not configured';
  elements.providerStatus.classList.toggle('active', configured);
  elements.clearProvider.hidden = !configured;
  if (configured && Object.hasOwn(PROVIDER_NAMES, status.providerId)) {
    elements.provider.value = status.providerId;
    if (status.providerId === 'ollama') {
      elements.ollamaModel.value = status.modelId || '';
      elements.ollamaUrl.value = status.baseUrl || 'http://127.0.0.1:11434/v1';
    }
  }
  renderProviderFields();
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
      return;
    }
    renderProviderStatus(response.status);
  } catch {
    setMessage(elements.providerMessage, 'Could not load the agent model', true);
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

async function clearProvider() {
  elements.clearProvider.disabled = true;
  try {
    const response = await window.electronAPI.clearAgentProvider();
    if (!response?.ok) {
      setMessage(
        elements.providerMessage,
        responseMessage(response, 'Could not clear model'),
        true
      );
      return;
    }
    renderProviderStatus(response.status);
    setMessage(elements.providerMessage, 'Saved model cleared');
  } catch {
    setMessage(elements.providerMessage, 'Could not clear model', true);
  } finally {
    elements.clearProvider.disabled = false;
  }
}

function setRunActive(active, label) {
  elements.run.disabled = active;
  elements.stop.disabled = !active;
  elements.prompt.disabled = active;
  elements.runStatus.textContent = label;
  elements.runStatus.classList.toggle('active', active);
}

function resetRunOutput() {
  toolRows.clear();
  elements.toolList.replaceChildren();
  elements.output.textContent = '';
  elements.transcript.hidden = true;
  elements.activity.hidden = true;
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
  const label = typeof request.label === 'string' && request.label ? request.label : 'Submit form';
  elements.approvalAction.textContent = `Submit this form using “${label}”?`;
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
    setRunActive(true, 'Running');
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
  } else if (event.type === 'tool_started') {
    addToolRow(event);
  } else if (event.type === 'tool_finished') {
    finishToolRow(event);
  } else if (event.type === 'run_retrying') {
    setMessage(elements.runMessage, `Provider retry ${event.attempt} of ${event.maxAttempts}…`);
  } else if (event.type === 'approval_requested') {
    renderApproval(event);
    setRunActive(true, 'Approval needed');
  } else if (
    event.type === 'approval_resolved' &&
    pendingApproval?.approvalId === event.approvalId
  ) {
    clearApproval();
    setRunActive(true, 'Running');
  } else if (event.type === 'run_finished') {
    const status = event.status || 'finished';
    const wasTakeover = status === 'cancelled' && takeoverRequestedRunId === event.runId;
    const wasTabClosed = event.error?.code === 'AGENT_TAB_CLOSED';
    setRunActive(
      false,
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
  setRunActive(true, 'Starting');
  try {
    const response = await window.electronAPI.startAgent(tab.id, prompt);
    if (!response?.ok) {
      currentRunId = null;
      setAgentControlledTab(null);
      setRunActive(false, 'Idle');
      setMessage(elements.runMessage, responseMessage(response, 'Could not start the agent'), true);
      return;
    }
    if (lastFinishedRunId !== response.runId) {
      currentRunId = response.runId;
      setRunActive(true, 'Running');
    }
  } catch {
    currentRunId = null;
    setAgentControlledTab(null);
    setRunActive(false, 'Idle');
    setMessage(elements.runMessage, 'Could not start the agent', true);
  }
}

async function stopRun() {
  if (!currentRunId) return;
  takeoverRequestedRunId = currentRunId;
  elements.stop.disabled = true;
  setMessage(elements.runMessage, 'Taking over…');
  try {
    const response = await window.electronAPI.stopAgent(currentRunId);
    if (!response?.ok) {
      takeoverRequestedRunId = null;
      elements.stop.disabled = false;
      setMessage(elements.runMessage, responseMessage(response, 'Could not stop the agent'), true);
    }
  } catch {
    takeoverRequestedRunId = null;
    elements.stop.disabled = false;
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
      setRunActive(true, 'Running');
      setMessage(elements.runMessage, 'This run began before the panel was loaded');
      if (response.state.pendingApproval) {
        renderApproval(response.state.pendingApproval);
        setRunActive(true, 'Approval needed');
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
    clearProvider: byId('agent-provider-clear'),
    authCode: byId('agent-auth-code'),
    authUserCode: byId('agent-auth-user-code'),
    providerMessage: byId('agent-provider-message'),
    prompt: byId('agent-prompt'),
    run: byId('agent-run'),
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
  elements.provider.addEventListener('change', renderProviderFields);
  elements.saveProvider.addEventListener('click', saveProvider);
  elements.loginProvider.addEventListener('click', loginSubscriptionProvider);
  elements.cancelProviderLogin.addEventListener('click', cancelProviderLogin);
  elements.clearProvider.addEventListener('click', clearProvider);
  elements.run.addEventListener('click', startRun);
  elements.stop.addEventListener('click', stopRun);
  elements.approvalApprove.addEventListener('click', () => decideApproval(true));
  elements.approvalDecline.addEventListener('click', () => decideApproval(false));
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
  renderProviderFields();
  refreshProvider();
  restoreRunState();
}

export { formatOperation, handleAgentEvent, providerPrivacyMessage, responseMessage };
