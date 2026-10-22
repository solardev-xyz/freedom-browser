import { LANGUAGE_NAMES, createDownloadProgress, downloadStatusText } from './dictation-choices.js';

// Settings presents services as connections, while the first-use chooser stays
// compact. Capabilities, availability and billing copy still come from main.
const SERVICES = {
  openai: { name: 'OpenAI', logo: 'openai.png' },
  openrouter: { name: 'OpenRouter', logo: 'openrouter.png' },
  venice: { name: 'Venice', logo: 'venice.png' },
  'near-ai': { name: 'NEAR AI', logo: 'near-ai.svg' },
};
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const link = (text, href, className = 'agent-button secondary') => {
  const el = node('a', text, className);
  el.href = href;
  return el;
};

export function createDictationSettings(host, api, { heading, breadcrumbs, navigate }) {
  let state;
  let page;
  let busy = false;
  let installing = false;
  let operation = 0;
  let revision = 0;
  let downloaded = 0;
  let total = 0;
  const status = node('p', '', 'agent-message');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const progress = createDownloadProgress();

  const optionFor = (id) => state?.options.find((option) => option.providerId === id);
  const nameFor = (id) => (id === 'local' ? 'On this device' : SERVICES[id]?.name);
  const message = (text = '', error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  const avatar = (id) => {
    const icon = node('span', '', 'agent-provider-avatar');
    icon.setAttribute('aria-hidden', 'true');
    if (id === 'local') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.5');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        'M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm8 14v4m-5 0h10'
      );
      svg.appendChild(path);
      icon.appendChild(svg);
    } else {
      const image = node('img', '', 'agent-provider-logo');
      image.src = `../assets/provider-logos/${SERVICES[id].logo}`;
      image.alt = '';
      image.width = 32;
      image.height = 32;
      image.draggable = false;
      icon.appendChild(image);
    }
    return icon;
  };
  const serviceRow = (id, adding = false) => {
    const option = optionFor(id);
    const row = link('', `#ai/voice/${id}`, 'agent-connected-provider voice-service');
    const copy = node('span', '', 'agent-connected-provider-copy');
    copy.append(
      node('strong', nameFor(id)),
      node(
        'span',
        id === 'local'
          ? 'Private transcription on your device'
          : option?.model || 'Connect an API account'
      )
    );
    const active = (state.preferences.providerId || state.suggestedProviderId) === id && option?.ready && option?.available && !option?.consentRequired;
    let label = active
      ? 'In use'
      : !option
        ? 'Connect'
        : !option.available
          ? option.blockedLabel || 'Unavailable'
          : option.consentRequired
            ? 'Review audio privacy'
          : option.ready
            ? 'Connected'
            : 'Download needed';
    if (id === 'local' && option?.ready && !active) label = 'Downloaded';
    if (id === 'local' && installing) label = 'Downloading…';
    const badge = node('span', label, `agent-badge${active ? ' active' : ''}`);
    if (active) badge.prepend(document.createTextNode('✓ '));
    const chevron = node('span', '›', 'net-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    row.append(avatar(id), copy, badge, chevron);
    if (adding) row.classList.add('voice-service-choice');
    return row;
  };
  const section = (title, children) => {
    const group = node('div', '', 'voice-settings-group');
    if (title) group.appendChild(node('h3', title, 'subsection-title'));
    group.append(...children);
    return group;
  };
  const preferenceRow = (label, help, control) => {
    const row = node('div', '', 'row');
    row.setAttribute('data-settings-route', page ? `ai/voice/${page}` : 'ai/voice');
    const body = node('div', '', 'row-body');
    const title = node(control ? 'label' : 'p', label, 'row-label');
    if (control) {
      control.id = `voice-${label.toLowerCase().replaceAll(' ', '-')}`;
      title.htmlFor = control.id;
    }
    body.append(title, node('p', help, 'row-help'));
    row.appendChild(body);
    if (control) {
      const holder = node('div', '', 'row-control');
      holder.appendChild(control);
      row.appendChild(holder);
    }
    return row;
  };
  const renderHeader = () => {
    const title = page === 'add' ? 'Add a dictation service' : nameFor(page) || 'Voice dictation';
    heading.textContent = title;
    breadcrumbs.replaceChildren();
    const entries = [
      ['AI', '#ai'],
      ['Voice dictation', page ? '#ai/voice' : null],
    ];
    if (page) entries.push([title]);
    for (const [label, href] of entries) {
      if (breadcrumbs.childNodes.length) {
        const separator = node('span', '›');
        separator.setAttribute('aria-hidden', 'true');
        breadcrumbs.appendChild(separator);
      }
      const crumb = href ? link(label, href, 'ai-breadcrumb-link') : node('span', label);
      if (!href) crumb.setAttribute('aria-current', 'page');
      breadcrumbs.appendChild(crumb);
    }
  };
  const renderLanguage = () => {
    const language = node('select');
    language.setAttribute('aria-label', 'Dictation language');
    for (const id of state.languages) {
      const option = node('option', LANGUAGE_NAMES[id] || id);
      option.value = id;
      language.appendChild(option);
    }
    language.value = state.preferences.language;
    language.disabled = busy || !state.options.some((option) => option.available);
    language.addEventListener('change', () => void savePreferences({ language: language.value }));
    const card = node('div', '', 'card');
    card.appendChild(preferenceRow('Language', 'Used by all dictation services.', language));
    return card;
  };
  const overview = () => {
    const intro = node(
      'p',
      'Choose where your speech becomes text. Your chat model stays the same.',
      'section-description'
    );
    const local = section('On your device', [serviceRow('local')]);
    const connected = state.options.filter((option) => option.providerId !== 'local');
    const list = node('div', '', 'agent-connected-provider-list');
    if (connected.length) list.append(...connected.map((option) => serviceRow(option.providerId)));
    else list.appendChild(node('p', 'No connected dictation services', 'voice-empty row-help'));
    const cloud = section('Connected services', [list, link('Add service', '#ai/voice/add')]);
    return [intro, local, cloud, section('Preferences', [renderLanguage()])];
  };
  const detail = () => {
    const option = optionFor(page);
    const local = page === 'local';
    const summary = node('div', '', 'voice-service-summary');
    const copy = node('div');
    copy.append(
      node('strong', local ? 'Local transcription' : 'Cloud transcription'),
      node(
        'p',
        option?.detail || 'Connect this provider with an API key to use it for dictation.',
        'row-help'
      )
    );
    summary.append(avatar(page), copy);
    const card = node('div', '', 'card settings-search-skip');
    card.appendChild(
      preferenceRow('Transcription model', option?.model || 'Available after connecting')
    );
    if (option?.price) card.appendChild(preferenceRow('Billing', option.price));
    const children = [summary, card];
    if (page === 'openrouter' && option) {
      const privacy = node('div', '', 'card');
      privacy.appendChild(preferenceRow('Audio privacy', option.consentDisclosure));
      children.push(section('Privacy', [privacy]));
    }
    const actions = node('div', '', 'agent-config-actions');
    if (option?.available) {
      const active = (state.preferences.providerId || state.suggestedProviderId) === page && option.ready && !option.consentRequired;
      const use = node(
        'button',
        installing && local
          ? 'Downloading…'
          : active
            ? 'Used for dictation'
            : option.consentRequired
              ? 'Use with standard routing'
            : local && !option.ready
              ? 'Download & use on this device'
              : 'Use for dictation',
        'agent-button primary'
      );
      use.type = 'button';
      use.disabled = busy || active;
      use.addEventListener('click', () => void useService(option));
      actions.appendChild(use);
    }
    if (installing) {
      progress.update(downloaded, total);
      if (local) children.push(progress.element);
      const cancel = node('button', 'Cancel download', 'agent-button secondary');
      cancel.type = 'button';
      cancel.addEventListener('click', cancelWork);
      actions.appendChild(cancel);
    }
    if (!local)
      actions.appendChild(
        link(option ? 'Manage connection' : 'Connect provider', `#ai/providers/${page}`)
      );
    else if (!option?.available)
      children.push(node('p', 'Local dictation is not available on this device.', 'row-help'));
    children.push(actions);
    return children;
  };
  function render() {
    renderHeader();
    if (!state) {
      host.replaceChildren(status);
      return;
    }
    const content =
      page === 'add'
        ? [
            node(
              'p',
              'Connect an API account for cloud dictation. Chat subscriptions do not include transcription access.',
              'section-description'
            ),
            ...Object.keys(SERVICES).map((id) => serviceRow(id, true)),
          ]
        : page
          ? detail()
          : overview();
    host.replaceChildren(...content, status);
  }
  const refresh = async () => {
    if (busy) return;
    const current = ++revision;
    if (!state) message('Loading dictation services…');
    try {
      const response = await api.getAgentDictationState();
      if (current !== revision) return;
      if (!response?.ok)
        throw new Error(response?.error?.message || 'Could not load dictation services.');
      state = response;
      message();
      render();
    } catch (error) {
      if (current === revision) {
        message(error.message, true);
        render();
      }
    }
  };
  const savePreferences = async (patch = {}) => {
    if (busy || !state) return;
    const current = ++operation;
    const focusId = document.activeElement?.id;
    const previousPage = page;
    revision += 1;
    busy = true;
    message('Updating dictation settings…');
    render();
    try {
      const response = await save(patch);
      if (current !== operation) return;
      state = response;
      message('Settings updated.');
    } catch (error) {
      if (current === operation) message(error.message, true);
    } finally {
      if (current === operation) {
        busy = false;
        render();
        if (previousPage === page && focusId)
          document.getElementById(focusId)?.focus({ preventScroll: true });
      }
    }
  };
  const save = async (preferences) => {
    const response = await api.chooseAgentDictation(preferences);
    if (!response?.ok)
      throw new Error(response?.error?.message || 'Could not change dictation settings.');
    return response;
  };
  const useService = async (option) => {
    if (busy) return;
    const current = ++operation;
    revision += 1;
    busy = true;
    installing = option.providerId === 'local' && !option.ready;
    downloaded = 0;
    total = 0;
    message(installing ? 'Downloading local dictation…' : 'Changing dictation service…');
    render();
    try {
      if (installing) {
        const result = await api.installAgentDictation();
        if (current !== operation) return;
        if (!result?.ok)
          throw new Error(result?.error?.message || 'The local download did not complete.');
      }
      if (current !== operation) return;
      const response = await save({ providerId: option.providerId, language: state.preferences.language,
        ...(option.consentRequired ? { acceptOpenRouterAudio: true } : {}) });
      if (current !== operation) return;
      state = response;
      message('Dictation is ready.');
    } catch (error) {
      if (current === operation) message(error.message, true);
    } finally {
      if (current === operation) {
        busy = false;
        installing = false;
        render();
      }
    }
  };
  function cancelWork() {
    operation += 1;
    revision += 1;
    if (installing) void api.cancelAgentDictation();
    busy = false;
    installing = false;
    message();
    render();
  }
  const unsubscribe = api.onAgentDictationEvent?.((event) => {
    if (!installing || event.type !== 'download') return;
    downloaded = event.bytes || 0;
    total = event.total || 0;
    progress.update(downloaded, total);
    message(downloadStatusText(event));
  });
  render();
  return {
    refresh,
    setPage(id, { focus = false } = {}) {
      if (page !== id && !busy) message();
      page = id;
      if (page && page !== 'local' && page !== 'add' && !Object.hasOwn(SERVICES, page)) {
        page = undefined;
        navigate(null, true);
      }
      render();
      if (focus) heading.focus();
    },
    cancel: cancelWork,
    dispose() {
      cancelWork();
      unsubscribe?.();
    },
  };
}
