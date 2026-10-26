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
// Page tools (WebMCP) are decided once per launch (main/agent/webmcp-launch.js),
// so AI on in a launch that started without them offers the same restart the
// title-bar row does (#803). Keyed on what this launch decided, not on the
// toggle: reopening Settings still offers it, and turning AI off and on again
// in a launch that has page tools does not. null (unknown) offers nothing.
const restart = document.getElementById('enable-ai-restart');
let webMcpAtLaunch = null;
const renderRestart = () => {
  restart.hidden = !(enabled && webMcpAtLaunch === false);
};
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
// Setup runs straight through: turning AI on here continues to the provider
// picker when no model is connected yet, and the first model connected opens
// Agent. "First" is judged from real statuses only (the placeholder a failed
// load leaves in providerUi.state, which apply() replays, never counts), and
// only a connect made on this page opens Agent: a model connected in another
// window, or reconnected after removing one here, opens nothing.
let continueToProviders = false;
let sawUnconfigured = false;
let sawConfigured = false;
const updateNext = (state, { userAction = false, real = false } = {}) => {
  next.hidden = !enabled || state?.configured !== true;
  if (enabled && state?.configured && status.textContent === 'Loading providers…')
    status.textContent = '';
  if (!enabled || !state) return;
  const configured = state.configured === true;
  if (continueToProviders) {
    continueToProviders = false;
    // Only from the switch's own page: a user who moved on while the status
    // loaded stays where they went.
    if (!configured && location.hash.slice(1).toLowerCase() === 'ai') location.hash = 'ai/providers/add';
  }
  if (!real) return;
  if (configured && userAction && sawUnconfigured && !sawConfigured) void api.openAgent();
  if (configured) sawConfigured = true;
  else sawUnconfigured = true;
};
const providerUi = createAgentProviderUi({
  api,
  assetBase: '../assets/provider-logos/',
  elements: { runMessage: document.getElementById('agent-provider-message') },
  onStatusChange: (state, { userAction }) => updateNext(state, { userAction, real: true }),
  onScreenChange(screen, providerId) {
    const route =
      screen === 'detail'
        ? `ai/providers/${providerId}`
        : screen === 'browser'
          ? 'ai/providers/add'
          : 'ai/providers';
    // Choosing "API key" on OpenAI's page stays on its route, so no
    // hashchange repaints the heading; do it once the form has rendered.
    if (location.hash.slice(1).toLowerCase() === route) queueMicrotask(() => renderRoute());
    else location.hash = route;
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
  // The provider form decides whether this page is still asking how to
  // connect, so it is shown before the page is named.
  if (loaded) providerUi.showSettingsPage(screen, providerId);
  const title =
    screen === 'home'
      ? 'Models & providers'
      : screen === 'browser'
        ? 'Add a provider'
        : providerUi.providerPageTitle(providerId);
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
  if (focus) heading.focus();
}

async function refresh() {
  if (!enabled || location.hash.slice(1).split('/')[0].toLowerCase() !== 'ai') return;
  const current = ++revision;
  if (location.hash.toLowerCase().startsWith('#ai/voice')) void dictation.refresh();
  // This call's own outcome, not `loaded`: a provider change arriving while it
  // awaits clears `loaded` for the next visit, which is not a failure to load.
  let catalogReady = loaded;
  if (!catalogReady) {
    providerUi.invalidateCatalog();
    status.textContent = 'Loading providers…';
    providerMessage.textContent = status.textContent;
    // That same change invalidates a load in flight (a provider page opened on
    // a day-old catalog refreshes it in the background), so the load comes
    // back empty without having failed. Load again before calling it a
    // failure (#803).
    for (let attempt = 0; attempt < 3 && !catalogReady; attempt += 1) {
      await providerUi.loadProviderCatalog();
      if (current !== revision || !enabled) return;
      catalogReady = providerUi.state.providerCatalog.length > 0;
    }
    loaded = catalogReady;
  }
  await providerUi.refreshProvider();
  if (current !== revision || !enabled) return;
  status.textContent = catalogReady ? '' : 'Could not load providers. Open AI settings again to retry.';
  if (!catalogReady || providerMessage.textContent === 'Loading providers…')
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
  renderRestart();
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
    continueToProviders = requested;
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
restart.addEventListener('click', () => api.relaunchApp());
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
  .getWebMcpLaunchState?.()
  .then((state) => {
    webMcpAtLaunch = typeof state?.enabledAtLaunch === 'boolean' ? state.enabledAtLaunch : null;
    renderRestart();
  })
  .catch(() => {});
api
  .getSettings()
  .then(apply)
  .catch(() => {
    status.textContent = 'Could not load AI settings.';
  });
