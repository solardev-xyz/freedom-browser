export const LANGUAGE_NAMES = { auto: 'Detect automatically', en: 'English', de: 'German', es: 'Spanish', fr: 'French',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ja: 'Japanese', zh: 'Chinese', ko: 'Korean', uk: 'Ukrainian' };

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

// The first-use chooser and Settings → AI share the same choices and wording.
export function createDictationChoices(host, api, { onChosen = () => {}, onCancel = () => {}, autoSave = false } = {}) {
  let state;
  let busy = false;
  let generation = 0;
  const heading = element('strong', 'Voice dictation');
  const intro = element('p', 'Words appear while you speak. Choose where your speech becomes text. Your chat model stays the same.', `agent-dictation-help${autoSave ? ' row-help' : ''}`);
  const serviceLabel = element('label', 'Transcription');
  const service = element('select'); service.setAttribute('aria-label', 'Dictation service'); serviceLabel.appendChild(service);
  const languageLabel = element('label', 'Language');
  const language = element('select'); language.setAttribute('aria-label', 'Dictation language'); languageLabel.appendChild(language);
  const detail = element('p', '', 'agent-dictation-help');
  const unavailable = element('p', '', 'agent-dictation-help');
  const manage = element('a', 'Voice dictation settings…', 'agent-dictation-help');
  manage.href = '#';
  manage.addEventListener('click', event => {
    event.preventDefault();
    const blocked = state?.options.find(option => !option.available && option.providerId === state.preferences.providerId) ||
      state?.options.find(option => !option.available && option.providerId !== 'local');
    host.dispatchEvent(new CustomEvent('dictation-settings', { bubbles: true, detail: { providerId: blocked?.providerId } }));
  });
  const zeroLabel = element('label', '', 'agent-dictation-retention');
  const zero = element('input'); zero.type = 'checkbox';
  zeroLabel.append(zero, document.createTextNode('Require zero data retention on OpenRouter'));
  const status = element('p', '', 'agent-dictation-help'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = element('div', '', 'agent-dictation-actions');
  const use = element('button', 'Use for dictation', 'agent-button primary'); use.type = 'button';
  const cancel = element('button', autoSave ? 'Cancel download' : 'Cancel', 'agent-text-button'); cancel.type = 'button';
  const connect = element('a', autoSave ? 'Add a provider' : 'Connect another provider in Settings → AI');
  connect.href = '#'; connect.className = 'agent-dictation-help';
  connect.addEventListener('click', event => {
    event.preventDefault();
    host.dispatchEvent(new CustomEvent('dictation-connect', { bubbles: true }));
  });
  actions.append(use, cancel);
  host.replaceChildren(...(autoSave ? [] : [heading]), intro, serviceLabel, languageLabel, detail, unavailable, manage, zeroLabel, status, actions, connect);
  const renderSelection = () => {
    const option = state?.options.find(option => option.providerId === service.value);
    detail.textContent = option ? `${option.detail} ${option.price}.` : 'Connect an API-key provider in Settings → AI, or choose local dictation.';
    zeroLabel.hidden = service.value !== 'openrouter';
    if (option?.requireZeroRetention) zero.checked = true;
    use.textContent = service.value === 'local' && !option?.ready ? 'Download & use on this device' : 'Use for dictation';
    use.hidden = autoSave && (option?.ready || !option?.available);
    use.disabled = busy || !option?.available;
    service.disabled = busy; language.disabled = busy; zero.disabled = busy || option?.requireZeroRetention === true;
    cancel.hidden = autoSave && !busy;
  };
  const render = response => {
    state = response;
    unavailable.textContent = state.options.filter(option => !option.available && option.providerId !== 'local').map(option => `${option.name}: ${option.detail}`).join(' ');
    unavailable.hidden = !unavailable.textContent;
    service.replaceChildren(); language.replaceChildren();
    for (const option of state.options) {
      const node = element('option', `${option.name}${option.available ? '' : ' (unavailable)'}`);
      node.value = option.providerId; node.disabled = !option.available; service.appendChild(node);
    }
    const selected = state.options.find(option => option.providerId === state.preferences.providerId && option.available)?.providerId ||
      state.suggestedProviderId || state.options.find(option => option.available)?.providerId || '';
    service.value = selected;
    for (const id of state.languages) { const node = element('option', LANGUAGE_NAMES[id] || id); node.value = id; language.appendChild(node); }
    language.value = state.preferences.language;
    zero.checked = state.preferences.requireZeroRetention !== false;
    renderSelection();
  };
  const refresh = async () => {
    const current = ++generation;
    status.textContent = 'Loading dictation options…';
    try {
      const response = await api.getAgentDictationState();
      if (current !== generation) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Could not load dictation options.');
      render(response); status.textContent = '';
    } catch (error) { if (current === generation) status.textContent = error.message; }
  };
  const choose = async () => {
    if (busy) return;
    const option = state?.options.find(option => option.providerId === service.value);
    if (!option?.available || (autoSave && !option.ready && service.value === 'local')) return;
    await save(option);
  };
  const save = async option => {
    const current = ++generation;
    busy = true; renderSelection();
    try {
      if (option.providerId === 'local' && !option.ready) {
        status.textContent = 'Downloading local dictation…';
        const response = await api.installAgentDictation();
        if (current !== generation) return;
        if (!response?.ok) throw new Error(response?.error?.message || 'The local download did not complete.');
      }
      if (current !== generation) return;
      const response = await api.chooseAgentDictation({ providerId: option.providerId, language: language.value, requireZeroRetention: zero.checked });
      if (current !== generation) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Could not select dictation.');
      render(response); status.textContent = 'Dictation is ready.';
      onChosen(response, { downloaded: option.providerId === 'local' && !option.ready });
    } catch (error) { if (current === generation) status.textContent = error.message; }
    finally { if (current === generation) { busy = false; renderSelection(); } }
  };
  for (const control of [service, language, zero]) control.addEventListener('change', () => {
    renderSelection();
    if (autoSave) void choose();
  });
  use.addEventListener('click', () => {
    const option = state?.options.find(option => option.providerId === service.value && option.available);
    if (option && !busy) void save(option);
  });
  const cancelWork = () => {
    generation += 1;
    if (busy) void api.cancelAgentDictation();
    busy = false; status.textContent = ''; renderSelection();
  };
  cancel.addEventListener('click', () => { cancelWork(); onCancel(); });
  const unsubscribe = api.onAgentDictationEvent?.(event => {
    if (!busy || event.type !== 'download') return;
    status.textContent = `${event.label}${event.bytes ? ` · ${Math.round(event.bytes / 1000000)} MB${event.total ? ` of ${Math.round(event.total / 1000000)} MB` : ''}` : '…'}`;
  });
  return { refresh, cancel: cancelWork, dispose() { cancelWork(); unsubscribe?.(); } };
}
