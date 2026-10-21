import { createAgentProviderUi } from './agent-provider-ui.js';
import { createDictationSettings } from './dictation-settings.js';

const api = window.freedomAPI;
const toggle = document.getElementById('enable-ai');
const providers = document.getElementById('ai-provider-settings');
const note = document.getElementById('ai-disabled-note');
const status = document.getElementById('ai-settings-status');
const providerMessage = document.getElementById('agent-provider-message');
const next = document.getElementById('ai-next-step');
const open = document.getElementById('ai-open-agent');
let enabled = false;
let revision = 0;
let pending = false;
let loaded = false;
const dictationHost = document.getElementById('ai-dictation-settings');
const dictation = createDictationSettings(dictationHost, api, {
  heading: document.getElementById('ai-voice-page-title'),
  breadcrumbs: document.getElementById('ai-voice-breadcrumbs'),
  navigate(providerId, replace = false) {
    const route = providerId ? `ai/voice/${providerId}` : 'ai/voice';
    if (replace) {
      history.replaceState(null, '', `#${route}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else location.hash = route;
  },
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
  onScreenChange(screen, providerId) {
    location.hash =
      screen === 'detail'
        ? `ai/providers/${providerId}`
        : screen === 'browser'
          ? 'ai/providers/add'
          : 'ai/providers';
  },
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

function renderRoute({ focus = false } = {}) {
  const [section, page, providerId] = location.hash.slice(1).toLowerCase().split('/');
  if (section !== 'ai') {
    void providerUi.cancelProviderLogin();
    return;
  }
  if (!enabled && page) {
    history.replaceState(null, '', '#ai');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  if (page !== 'providers') {
    void providerUi.cancelProviderLogin();
    if (page === 'voice') dictation.setPage(providerId, { focus });
    return;
  }
  const screen = !providerId ? 'home' : providerId === 'add' ? 'browser' : 'detail';
  if (screen !== 'detail') void providerUi.cancelProviderLogin();
  if (
    loaded &&
    screen === 'detail' &&
    !['openai-compatible', 'ollama'].includes(providerId) &&
    !providerUi.state.providerCatalog.some((item) => item.providerId === providerId) &&
    !providerUi.state.providerStatus?.connections?.some((item) => item.providerId === providerId)
  ) {
    history.replaceState(null, '', '#ai/providers');
    renderRoute({ focus });
    return;
  }
  const title =
    screen === 'home'
      ? 'Models & providers'
      : screen === 'browser'
        ? 'Add a provider'
        : providerUi.providerName(providerId);
  const heading = document.getElementById('ai-provider-page-title');
  heading.textContent = title;
  const crumbs = document.getElementById('ai-provider-breadcrumbs');
  crumbs.replaceChildren();
  const crumb = (label, href) => {
    if (crumbs.childNodes.length) {
      const separator = document.createElement('span');
      separator.textContent = '›';
      separator.setAttribute('aria-hidden', 'true');
      crumbs.appendChild(separator);
    }
    const item = document.createElement(href ? 'a' : 'span');
    item.textContent = label;
    if (href) {
      item.href = href;
      item.className = 'ai-breadcrumb-link';
    } else item.setAttribute('aria-current', 'page');
    crumbs.appendChild(item);
  };
  crumb('AI', '#ai');
  crumb('Models & providers', screen === 'home' ? null : '#ai/providers');
  if (screen !== 'home') crumb(title);
  if (loaded) providerUi.showSettingsPage(screen, providerId);
  if (focus) heading.focus();
}

async function refresh() {
  if (!enabled || location.hash.slice(1).split('/')[0].toLowerCase() !== 'ai') return;
  const current = ++revision;
  if (location.hash.toLowerCase().startsWith('#ai/voice')) void dictation.refresh();
  if (!loaded) {
    providerUi.invalidateCatalog();
    status.textContent = 'Loading providers…';
    providerMessage.textContent = status.textContent;
    await providerUi.loadProviderCatalog();
    if (current !== revision || !enabled) return;
    loaded = providerUi.state.providerCatalog.length > 0;
  }
  await providerUi.refreshProvider();
  if (current !== revision || !enabled) return;
  status.textContent = loaded ? '' : 'Could not load providers. Open AI settings again to retry.';
  if (!loaded || providerMessage.textContent === 'Loading providers…')
    providerMessage.textContent = status.textContent;
  renderRoute();
}

function apply(settings) {
  const changed = enabled !== (settings?.enableAi === true);
  enabled = settings?.enableAi === true;
  toggle.checked = enabled;
  providers.hidden = !enabled;
  document.getElementById('ai-settings-links').hidden = !enabled;
  document.getElementById('providers').hidden = !enabled;
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
  renderRoute();
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
  const editing = location.hash.toLowerCase().startsWith('#ai/providers/');
  providerUi.invalidateCatalog({ keepModels: editing });
  if (editing) return;
  void refresh();
});
window.addEventListener('focus', () => {
  if (enabled && location.hash.toLowerCase().startsWith('#ai/voice')) void dictation.refresh();
});
window.addEventListener('hashchange', () => {
  renderRoute({ focus: true });
  void refresh();
});
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
