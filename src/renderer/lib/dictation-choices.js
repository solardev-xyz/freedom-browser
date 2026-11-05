export const LANGUAGE_NAMES = { auto: 'Detect automatically', en: 'English', de: 'German', es: 'Spanish', fr: 'French',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ja: 'Japanese', zh: 'Chinese', ko: 'Korean', uk: 'Ukrainian' };

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

// "Downloading Whisper Base · 48 MB of 142 MB": one wording for the local
// model download in the composer chooser and in Settings → AI.
export const downloadStatusText = event =>
  `${event.label}${event.bytes ? ` · ${Math.round(event.bytes / 1000000)} MB${event.total ? ` of ${Math.round(event.total / 1000000)} MB` : ''}` : '…'}`;

// The download's progress bar, shared by both surfaces so they look alike.
// An unknown total leaves the bar indeterminate.
export function createDownloadProgress() {
  const bar = element('progress', '', 'voice-download-progress');
  bar.setAttribute('aria-label', 'Local dictation download');
  const update = (bytes = 0, total = 0) => {
    if (total) {
      bar.max = total;
      bar.value = bytes;
    } else bar.removeAttribute('value');
  };
  update();
  return { element: bar, update };
}

// The first-use chooser and Settings → AI share the same choices and wording.
export function createDictationChoices(host, api, { onChosen = () => {}, onCancel = () => {}, onAlternative = () => {}, autoSave = false } = {}) {
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
  const status = element('p', '', 'agent-dictation-help'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  // Same treatment as Settings → AI: failures in the error colour, and a
  // progress bar under the status while the local model downloads.
  const setStatus = (text = '', error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  const progress = createDownloadProgress();
  progress.element.hidden = true;
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
  const form = [...(autoSave ? [] : [heading]), intro, serviceLabel, languageLabel, detail, unavailable, manage, status, progress.element, actions, connect];
  host.replaceChildren(...form);
  const renderSelection = () => {
    const option = state?.options.find(option => option.providerId === service.value);
    detail.textContent = option ? `${option.detail} ${option.price}.` : 'Connect an API-key provider in Settings → AI, or choose local dictation.';
    use.textContent = service.value === 'local' && !option?.ready ? 'Download & use on this device' : 'Use for dictation';
    use.hidden = autoSave && (option?.ready || !option?.available);
    use.disabled = busy || !option?.available;
    service.disabled = busy; language.disabled = busy;
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
    renderSelection();
  };
  const refresh = async () => {
    host.replaceChildren(...form);
    const current = ++generation;
    setStatus('Loading dictation options…');
    try {
      const response = await api.getAgentDictationState();
      if (current !== generation) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Could not load dictation options.');
      render(response); setStatus();
    } catch (error) { if (current === generation) setStatus(error.message, true); }
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
        setStatus('Downloading local dictation…');
        progress.update();
        progress.element.hidden = false;
        const response = await api.installAgentDictation();
        if (current !== generation) return;
        if (!response?.ok) throw new Error(response?.error?.message || 'The local download did not complete.');
      }
      if (current !== generation) return;
      const response = await api.chooseAgentDictation({ providerId: option.providerId, language: language.value });
      if (current !== generation) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Could not select dictation.');
      render(response); setStatus('Dictation is ready.');
      onChosen(response, { downloaded: option.providerId === 'local' && !option.ready });
    } catch (error) { if (current === generation) setStatus(error.message, true); }
    finally { if (current === generation) { busy = false; progress.element.hidden = true; renderSelection(); } }
  };
  for (const control of [service, language]) control.addEventListener('change', () => {
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
    busy = false; setStatus(); progress.element.hidden = true; renderSelection();
  };
  cancel.addEventListener('click', () => { cancelWork(); onCancel(); });
  const unsubscribe = api.onAgentDictationEvent?.(event => {
    if (!busy || event.type !== 'download') return;
    setStatus(downloadStatusText(event));
    progress.update(event.bytes, event.total);
  });
  const reviewConsent = response => {
    generation += 1;
    busy = false;
    state = response;
    const option = state.options.find(item => item.providerId === 'openrouter');
    const title = element('strong', 'Use OpenRouter for dictation?');
    const disclosure = element('p', option.consentDisclosure, 'agent-dictation-help');
    const note = element('p', 'Freedom remembers this choice. Your microphone stays off until you continue.', 'agent-dictation-help');
    const accept = element('button', 'Use OpenRouter', 'agent-button primary'); accept.type = 'button';
    const alternative = element('button', 'Choose another service', 'agent-button secondary'); alternative.type = 'button';
    const dismiss = element('button', 'Cancel', 'agent-text-button'); dismiss.type = 'button';
    const controls = element('div', '', 'agent-dictation-actions'); controls.append(accept, alternative, dismiss);
    setStatus();
    host.replaceChildren(title, disclosure, note, status, controls);
    accept.addEventListener('click', async () => {
      if (busy) return;
      const current = ++generation;
      busy = true; accept.disabled = true; alternative.disabled = true;
      try {
        const chosen = await api.chooseAgentDictation({ providerId: 'openrouter', acceptOpenRouterAudio: true });
        if (current !== generation) return;
        if (!chosen?.ok) throw new Error(chosen?.error?.message || 'Could not save the audio privacy choice.');
        onChosen(chosen);
      } catch (error) { if (current === generation) setStatus(error.message, true); }
      finally { if (current === generation) { busy = false; accept.disabled = false; alternative.disabled = false; } }
    });
    alternative.addEventListener('click', () => { generation += 1; onAlternative(); });
    dismiss.addEventListener('click', () => { cancelWork(); onCancel(); });
    accept.focus();
  };
  return { refresh, reviewConsent, cancel: cancelWork, dispose() { cancelWork(); unsubscribe?.(); } };
}
