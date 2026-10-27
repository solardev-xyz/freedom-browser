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
const connect = document.getElementById('ai-connect-model');
const nextHelp = document.getElementById('ai-next-help');
// Turning AI on only turns it on (#836): with no model connected yet, the
// next-step row offers "Connect a model" (the provider picker) instead of
// navigating there under the user's hand. The first model connected on this
// page then opens Agent. "First" and "no model" are judged from real statuses
// only (the placeholder a failed load leaves in providerUi.state, which
// apply() replays, never counts: the page shows the load error instead), and
// only a connect made on this page opens Agent: a model connected in another
// window, or reconnected after removing one here, opens nothing. realStatus is
// the status this enable has actually loaded: turning AI off forgets it, so
// turning it on again offers Connect only once refresh() has loaded a fresh
// one, and a failed load (which leaves the placeholder without telling us)
// takes the offer down again. A status that lands while AI is off (a refresh
// still in flight when it was turned off) is not recorded, so it cannot undo
// that reset and be replayed by the next enable.
let realStatus = null;
let realStatuses = 0;
let sawUnconfigured = false;
let sawConfigured = false;
const updateNext = (state, { userAction = false, real = false } = {}) => {
  if (real && enabled) {
    realStatus = state;
    realStatuses += 1;
  }
  const configured = state?.configured === true;
  const needsModel = !configured && Boolean(state) && state === realStatus;
  next.hidden = !enabled || !(configured || needsModel);
  open.hidden = !configured;
  connect.hidden = configured;
  nextHelp.textContent = configured
    ? 'Your current conversation and draft stay in place.'
    : 'Choose a provider account or a local model for Agent to use.';
  if (enabled && configured && status.textContent === 'Loading providers…')
    status.textContent = '';
  if (!enabled || !state || !real) return;
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
  const statusesBefore = realStatuses;
  await providerUi.refreshProvider();
  if (current !== revision || !enabled) return;
  // A failed status load sets the placeholder without onStatusChange, so the
  // next-step row would keep whatever it showed before; repaint it from the
  // placeholder (never real, so no Connect) and say so on this page too, not
  // only on the providers page's own message line.
  const statusReady = realStatuses !== statusesBefore;
  if (!statusReady) {
    realStatus = null;
    updateNext(providerUi.state.providerStatus);
  }
  status.textContent = !catalogReady
    ? 'Could not load providers. Open AI settings again to retry.'
    : !statusReady
      ? 'Could not load the agent model. Open AI settings again to retry.'
      : '';
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
  if (!enabled) realStatus = null;
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
connect.addEventListener('click', () => {
  if (enabled) location.hash = 'ai/providers/add';
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
