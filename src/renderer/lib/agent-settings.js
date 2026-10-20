import { createAgentProviderUi } from './agent-provider-ui.js';
import { createDictationChoices } from './dictation-choices.js';

const api = window.freedomAPI;
const toggle = document.getElementById('enable-ai');
const providers = document.getElementById('ai-provider-settings');
const note = document.getElementById('ai-disabled-note');
const status = document.getElementById('ai-settings-status');
const next = document.getElementById('ai-next-step');
const open = document.getElementById('ai-open-agent');
let enabled = false;
let revision = 0;
let pending = false;
let loaded = false;
const dictationHost = document.getElementById('ai-dictation-settings');
const dictation = createDictationChoices(dictationHost, api, { autoSave: true });
dictationHost.addEventListener('dictation-connect', () => {
  location.hash = 'ai';
  document.getElementById('agent-provider-add').click();
});
const updateNext = (state) => {
  next.hidden = !enabled || state?.configured !== true;
  if (enabled && state?.configured && status.textContent === 'Loading providers…')
    status.textContent = '';
};
const providerUi = createAgentProviderUi({
  api,
  assetBase: '../assets/provider-logos/',
  elements: { runMessage: document.getElementById('agent-provider-message') },
  onStatusChange: updateNext,
  context: {
    conversationId: null,
    runStatus: 'idle',
    view: 'settings',
    privacy: null,
    showPrimaryView() {},
    focusComposer() {},
    updateSendAvailability() {},
    closeComposerPopovers() {},
    setAgentView(view) {
      if (view === 'workspace') void api.openAgent();
    },
  },
});

async function refresh() {
  if (!enabled || !location.hash.replace(/^#/, '').startsWith('ai')) return;
  const current = ++revision;
  void dictation.refresh();
  if (!loaded) {
    providerUi.invalidateCatalog();
    status.textContent = 'Loading providers…';
    await providerUi.loadProviderCatalog();
    if (current !== revision || !enabled) return;
    loaded = providerUi.state.providerCatalog.length > 0;
  }
  await providerUi.refreshProvider();
  if (current !== revision || !enabled) return;
  status.textContent = loaded ? '' : 'Could not load providers. Open AI settings again to retry.';
}

function apply(settings) {
  const changed = enabled !== (settings?.enableAi === true);
  enabled = settings?.enableAi === true;
  toggle.checked = enabled;
  providers.hidden = !enabled;
  dictationHost.hidden = !enabled;
  document.getElementById('voice').hidden = !enabled;
  note.hidden = enabled;
  updateNext(providerUi.state.providerStatus);
  if (!enabled) {
    dictation.cancel();
    revision += 1;
    loaded = false;
    providerUi.invalidateCatalog();
    status.textContent = '';
  } else if (changed) void refresh();
}

toggle.addEventListener('change', async () => {
  if (pending) return;
  pending = true;
  toggle.disabled = true;
  const requested = toggle.checked;
  status.textContent = requested ? 'Enabling AI…' : 'Stopping AI…';
  try {
    if (!(await api.saveSettings({ enableAi: requested }))) throw new Error();
    apply(await api.getSettings());
    if (!requested) status.textContent = 'AI is off. Chats, connections and projects are kept.';
  } catch {
    toggle.checked = enabled;
    status.textContent = 'Could not change AI settings. Please try again.';
  } finally {
    pending = false;
    toggle.disabled = false;
  }
});
open.addEventListener('click', async () => {
  if (!enabled) return;
  const response = await api.openAgent();
  if (!response?.ok) status.textContent = 'Could not open Agent. Please try again.';
});
api.onSettingsUpdated?.(apply);
api.onAgentProviderAuthEvent?.(providerUi.handleProviderAuthEvent);
api.onAgentProviderChanged?.(() => {
  if (!enabled) return;
  // A different Settings tab may have changed a connection. Keep a partially
  // edited form intact; the next visit refreshes its model catalogue.
  loaded = false;
  const editing = document.getElementById('agent-provider-home').hidden;
  providerUi.invalidateCatalog({ keepModels: editing });
  if (editing) return;
  void refresh();
});
for (const id of ['agent-provider-detail-back', 'agent-provider-list-back']) {
  document.getElementById(id).addEventListener('click', () => {
    if (!loaded) void refresh();
  });
}
window.addEventListener('hashchange', refresh);
window.addEventListener(
  'pagehide',
  () => {
    dictation.dispose();
    revision += 1;
    void providerUi.cancelProviderLogin();
  },
  { once: true }
);
api
  .getSettings()
  .then(apply)
  .catch(() => {
    status.textContent = 'Could not load AI settings.';
  });
