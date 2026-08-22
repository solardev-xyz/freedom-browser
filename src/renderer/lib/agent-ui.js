import { isPrivateWindow } from './private-mode.js';
import { close as closeWalletSidebar, isVisible as isWalletSidebarVisible } from './sidebar.js';
import { isSignatureInFlight, onSignatureFlightChange } from './wallet/signature-flight.js';

const PROVIDER_NAMES = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
});

let elements = {};
let getActiveTab = () => null;
let providerCatalog = [];
let providerCatalogPromise = null;
let providerStatus = null;
let currentRunId = null;
let lastFinishedRunId = null;
let panelOpen = false;
let agentEventUnsubscribe = null;
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
  elements.hostedFields.classList.toggle('hidden', isOllama);
  elements.ollamaFields.classList.toggle('hidden', !isOllama);
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
  setMessage(elements.runMessage);
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
  } else if (event.type === 'run_finished') {
    const status = event.status || 'finished';
    setRunActive(false, status === 'completed' ? 'Complete' : status);
    if (event.error?.message) setMessage(elements.runMessage, event.error.message, true);
    lastFinishedRunId = event.runId;
    currentRunId = null;
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
  setRunActive(true, 'Starting');
  try {
    const response = await window.electronAPI.startAgent(tab.id, prompt);
    if (!response?.ok) {
      currentRunId = null;
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
    setRunActive(false, 'Idle');
    setMessage(elements.runMessage, 'Could not start the agent', true);
  }
}

async function stopRun() {
  if (!currentRunId) return;
  elements.stop.disabled = true;
  setMessage(elements.runMessage, 'Stopping…');
  try {
    const response = await window.electronAPI.stopAgent(currentRunId);
    if (!response?.ok) {
      elements.stop.disabled = false;
      setMessage(elements.runMessage, responseMessage(response, 'Could not stop the agent'), true);
    }
  } catch {
    elements.stop.disabled = false;
    setMessage(elements.runMessage, 'Could not stop the agent', true);
  }
}

async function restoreRunState() {
  try {
    const response = await window.electronAPI.getAgentState();
    if (response?.ok && response.state?.status !== 'idle' && response.state?.runId) {
      currentRunId = response.state.runId;
      setRunActive(true, 'Running');
      setMessage(elements.runMessage, 'This run began before the panel was loaded');
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
    hostedFields: byId('agent-hosted-fields'),
    ollamaFields: byId('agent-ollama-fields'),
    model: byId('agent-model-select'),
    apiKey: byId('agent-api-key'),
    ollamaModel: byId('agent-ollama-model'),
    ollamaUrl: byId('agent-ollama-url'),
    saveProvider: byId('agent-provider-save'),
    clearProvider: byId('agent-provider-clear'),
    providerMessage: byId('agent-provider-message'),
    prompt: byId('agent-prompt'),
    run: byId('agent-run'),
    stop: byId('agent-stop'),
    runStatus: byId('agent-run-status'),
    runMessage: byId('agent-run-message'),
    transcript: byId('agent-transcript'),
    output: byId('agent-output'),
    activity: byId('agent-activity'),
    toolList: byId('agent-tool-list'),
  };
  if (Object.values(elements).some((element) => !element)) return;
  getActiveTab = typeof options.getActiveTab === 'function' ? options.getActiveTab : () => null;
  if (isPrivateWindow()) {
    elements.toggle.classList.add('hidden');
    return;
  }

  elements.toggle.addEventListener('click', togglePanel);
  elements.close.addEventListener('click', closePanel);
  elements.provider.addEventListener('change', renderProviderFields);
  elements.saveProvider.addEventListener('click', saveProvider);
  elements.clearProvider.addEventListener('click', clearProvider);
  elements.run.addEventListener('click', startRun);
  elements.stop.addEventListener('click', stopRun);
  document.addEventListener('sidebar-opened', closePanel);
  onSignatureFlightChange((inFlight) => {
    elements.toggle.disabled = inFlight;
    if (inFlight) closePanel();
  });
  agentEventUnsubscribe?.();
  agentEventUnsubscribe = window.electronAPI.onAgentEvent(handleAgentEvent);
  setPanelOpen(false);
  renderProviderFields();
  refreshProvider();
  restoreRunState();
}

export { formatOperation, handleAgentEvent, responseMessage };
