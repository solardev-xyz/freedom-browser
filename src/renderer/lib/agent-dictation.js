import { createDictationChoices } from './dictation-choices.js';
import { createDictationRecorder } from './dictation-recorder.js';
import { createDictationMenu } from './dictation-menu.js';
import { matchesShortcut } from './shortcuts.js';

export function createAgentDictation({ button, optionsButton, panel, menu, feedback, spectrum, prompt, api,
  canRecord, onBusy = () => {}, onInput = () => {}, connectProvider = () => {}, openSettings = connectProvider, onMenuOpening = () => {}, onSubmit = () => {} }) {
  if (!button || !panel || !api.getAgentDictationState) return null;
  let generation = 0;
  let session = null;
  let recorder = null;
  let inputStream = null;
  let busy = false;
  let finishing = false;
  let chooserStart = false;
  let destinationRevision = 0;
  let destination = 'Dictate task';
  let snapshot;
  let renderedValue;
  let startup = Promise.resolve();
  let completion = null;
  let sendAfterFinish = false;
  let insertionLength = 0;
  let audioQueue = Promise.resolve();
  let queuedFrames = 0;
  let sequence = 0;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const hideChoices = () => {
    if (panel.open) panel.close();
    panel.hidden = true;
    optionsButton.setAttribute('aria-expanded', 'false');
  };
  const status = (message, error = false) => {
    feedback.textContent = message;
    feedback.classList.toggle('error', error);
    feedback.hidden = !message;
  };
  const setBusy = value => {
    busy = value;
    prompt.readOnly = value && finishing;
    if (spectrum) {
      spectrum.hidden = !value;
      spectrum.dataset.state = !value ? 'idle' : finishing ? 'finishing' : 'starting';
    }
    button.setAttribute('aria-pressed', String(value));
    button.dataset.recording = String(value && !finishing);
    button.setAttribute('aria-label', value ? 'Finish dictation' : destination);
    button.title = value ? 'Finish dictation' : destination;
    optionsButton.disabled = value;
    onBusy(value);
  };
  const choices = createDictationChoices(panel, api, {
    onChosen(_state, { downloaded } = {}) {
      hideChoices();
      void refreshDestination();
      if (chooserStart && !downloaded) void requestStart();
      else {
        if (downloaded) status('Local dictation is ready. Click the microphone to start.');
        button.focus();
      }
    },
    onCancel() { hideChoices(); button.focus(); },
    onAlternative() {
      hideChoices();
      if (servicesMenu) void servicesMenu.show({ recordAfterChoice: chooserStart });
      else void openChoices(chooserStart);
    },
  });
  const servicesMenu = menu ? createDictationMenu({ host: menu, button: optionsButton, api,
    canOpen: () => !busy && canRecord(), onOpening: onMenuOpening,
    openSettings, onChosen: (_state, { recordAfterChoice } = {}) => {
      status('');
      void refreshDestination();
      if (recordAfterChoice) void requestStart();
    }, onError: message => status(message, true) }) : null;
  panel.addEventListener('dictation-connect', () => { cancel(); connectProvider(); });
  panel.addEventListener('dictation-settings', event => { cancel(); openSettings(event.detail?.providerId); });

  function cancel({ keepMessage = false } = {}) {
    if (busy && snapshot && prompt.value === renderedValue) {
      const changed = prompt.value !== snapshot.value;
      prompt.value = snapshot.value;
      prompt.setSelectionRange(snapshot.start, snapshot.end);
      if (changed) onInput();
    }
    generation += 1;
    recorder?.cancel(); recorder = null;
    inputStream?.getTracks().forEach(track => track.stop()); inputStream = null;
    session = null;
    finishing = false;
    sendAfterFinish = false;
    completion = null;
    button.disabled = false;
    choices.cancel(); hideChoices();
    servicesMenu?.close();
    void api.cancelAgentDictation().catch(() => {});
    setBusy(false);
    snapshot = null;
    if (!keepMessage) status('');
  }

  function reconcileDraft() {
    if (!snapshot || prompt.value === renderedValue) return;
    const value = prompt.value;
    let start = 0;
    while (start < renderedValue.length && start < value.length && renderedValue[start] === value[start]) start += 1;
    let oldEnd = renderedValue.length, newEnd = value.length;
    while (oldEnd > start && newEnd > start && renderedValue[oldEnd - 1] === value[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
    const replacement = value.slice(start, newEnd);
    if (oldEnd <= snapshot.start) {
      snapshot.value = snapshot.value.slice(0, start) + replacement + snapshot.value.slice(oldEnd);
      const shift = replacement.length - (oldEnd - start);
      snapshot.start += shift; snapshot.end += shift;
    } else if (start >= snapshot.start + insertionLength) {
      const shift = (snapshot.end - snapshot.start) - insertionLength;
      snapshot.value = snapshot.value.slice(0, start + shift) + replacement + snapshot.value.slice(oldEnd + shift);
    } else {
      throw new Error('Dictation stopped because you edited the dictated words.');
    }
    renderedValue = value;
  }

  function renderTranscript(text) {
    reconcileDraft();
    if (!snapshot) throw new Error('Dictation is no longer active.');
    const before = snapshot.value.slice(0, snapshot.start);
    const after = snapshot.value.slice(snapshot.end);
    const insertion = text ? `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}` : '';
    if (before.length + insertion.length + after.length > (prompt.maxLength > 0 ? prompt.maxLength : 32000))
      throw new Error('The transcript would make your prompt too long. Try a shorter recording.');
    insertionLength = text ? insertion.length : snapshot.end - snapshot.start;
    prompt.value = renderedValue = text ? before + insertion + after : snapshot.value;
    prompt.setSelectionRange(before.length + insertion.length, before.length + insertion.length);
    onInput();
  }

  function failed(message) {
    // Service failures and interruptions must never erase visible dictated text
    // or manual edits. Only lifecycle cancellation restores the original draft.
    snapshot = null;
    cancel();
    status(`${message} Your draft was kept.`, true);
  }

  const draftEdited = () => {
    if (!busy) return;
    try { reconcileDraft(); } catch (error) { failed(error.message); }
  };
  prompt.addEventListener('input', draftEdited);

  function start() {
    if (busy || !canRecord()) return;
    servicesMenu?.close();
    const current = ++generation;
    snapshot = { value: prompt.value, start: prompt.selectionStart ?? prompt.value.length,
      end: prompt.selectionEnd ?? prompt.value.length };
    renderedValue = snapshot.value;
    insertionLength = snapshot.end - snapshot.start;
    audioQueue = Promise.resolve(); queuedFrames = 0; sequence = 0;
    sendAfterFinish = false; completion = null;
    finishing = false;
    setBusy(true); status('Starting microphone…');
    prompt.focus();
    startup = (async () => {
      try {
        const response = await api.beginAgentDictation();
        if (current !== generation) return;
        if (!response?.ok) throw new Error(response?.error?.message || 'Dictation could not start.');
        session = response;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
        if (current !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
        inputStream = stream;
        const capture = await createDictationRecorder(stream, () => void finish(), () => {
          if (current === generation) failed('Recording stopped unexpectedly. Please try again.');
        }, { sampleRate: response.sampleRate || 16000, onChunk: audio => {
          if (current !== generation) return;
          if (++queuedFrames > 100) { failed('The audio connection cannot keep up. Please try again.'); return; }
          const index = sequence++;
          audioQueue = audioQueue.then(async () => {
            if (current !== generation) return;
            const result = await api.appendAgentDictation(response.id, index, audio);
            if (!result?.ok) throw new Error(result?.error?.message || 'Audio could not be transcribed.');
          }).catch(error => { if (current === generation) failed(error.message); })
            .finally(() => { if (current === generation) queuedFrames -= 1; });
        }, onSpectrum: levels => {
          if (current !== generation || finishing || !spectrum || reducedMotion?.matches) return;
          const bars = spectrum.children;
          for (let index = 0; index < bars.length; index += 1) {
            const position = index * (levels.length - 1) / Math.max(1, bars.length - 1);
            const low = Math.floor(position);
            const blend = position - low;
            const level = (levels[low] || 0) * (1 - blend) + (levels[low + 1] || 0) * blend;
            bars[index].style.transform = `scaleY(${0.08 + 0.92 * level})`;
          }
        } });
        if (current !== generation) { capture.cancel(); return; }
        recorder = capture;
        if (!finishing) {
          if (spectrum) spectrum.dataset.state = 'listening';
          status(`Listening · ${response.name}${response.local ? ' · audio stays on this device' : ' · audio sent to this service'}`);
        }
      } catch (error) {
        if (current !== generation) return;
        const message = error.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow Freedom to use your microphone in system settings, then try again.'
          : error.name === 'NotFoundError' ? 'No microphone found. Connect one and try again.' : error.message || 'Could not start the microphone.';
        failed(message);
      }
    })();
    return startup;
  }

  function finish({ send = false } = {}) {
    if (!busy) return Promise.resolve(false);
    sendAfterFinish = send;
    if (finishing) return completion;
    const current = generation;
    finishing = true; setBusy(true); button.disabled = true;
    status('Finishing dictation…');
    completion = (async () => {
      let succeeded = false;
      try {
        // Return/Escape may arrive while microphone permission or capture is
        // starting. Finish that same generation once its recorder is ready.
        await startup;
        if (current !== generation || !recorder || !session) return false;
        const id = session.id;
        await recorder.finish();
        recorder = null;
        inputStream = null;
        if (current !== generation) return false;
        await audioQueue;
        if (current !== generation) return false;
        const response = await api.finishAgentDictation(id);
        if (current !== generation) return false;
        if (!response?.ok) throw new Error(response?.error?.message || 'Transcription did not complete.');
        const text = response.text;
        if (typeof text !== 'string' || !text.trim()) throw new Error('No speech detected. Please try again.');
        renderTranscript(text);
        snapshot = null;
        status('');
        succeeded = true;
      } catch (error) {
        if (current === generation) failed(error.message || 'Dictation did not complete.');
      } finally {
        if (current === generation) {
          recorder?.cancel(); recorder = null;
          inputStream?.getTracks().forEach(track => track.stop()); inputStream = null;
          session = null; finishing = false; button.disabled = false; setBusy(false); prompt.focus();
          const submit = succeeded && sendAfterFinish && canRecord();
          sendAfterFinish = false;
          completion = null;
          if (submit) onSubmit();
        }
      }
      return succeeded;
    })();
    return completion;
  }

  const openChoices = async (startAfterChoice = false) => {
    if (busy || !canRecord()) return;
    chooserStart = startAfterChoice;
    panel.hidden = false;
    panel.showModal?.();
    optionsButton.setAttribute('aria-expanded', 'true');
    await choices.refresh();
    if (!panel.hidden) panel.querySelector('select')?.focus();
  };
  async function requestStart() {
    if (busy || button.disabled || !canRecord()) return;
    const current = ++generation;
    button.disabled = true;
    try {
      const state = await api.getAgentDictationState();
      if (current !== generation || !canRecord()) return;
      if (!state?.ok) throw new Error(state?.error?.message || 'Could not load dictation.');
      const providerId = state.preferences.providerId || state.suggestedProviderId;
      const option = state.options.find(option => option.providerId === providerId && option.available && option.ready);
      updateDestination(state);
      if (option?.consentRequired) {
        chooserStart = true;
        panel.hidden = false; panel.showModal?.();
        optionsButton.setAttribute('aria-expanded', 'true');
        choices.reviewConsent(state);
      } else if (option) void start();
      else if (state.preferences.providerId && servicesMenu) {
        const saved = state.options.find(item => item.providerId === state.preferences.providerId);
        status(saved?.detail || 'Your saved dictation service is no longer connected. Choose a service.');
        await servicesMenu.show({ recordAfterChoice: true });
      } else await openChoices(true);
    } catch (error) { if (current === generation) status(error.message, true); }
    finally { button.disabled = finishing; }
  }
  const startFromShortcut = event => {
    if (event.defaultPrevented || event.isComposing || !matchesShortcut(event, 'agent.startDictation')) return;
    event.preventDefault();
    if (!event.repeat) void requestStart();
  };
  prompt.addEventListener('keydown', startFromShortcut);
  button.addEventListener('click', () => {
    if (busy) void finish(); else void requestStart();
  });
  panel.addEventListener('cancel', event => { event.preventDefault(); cancel(); prompt.focus(); });
  const unsubscribe = api.onAgentDictationEvent?.(event => {
    if (event.id !== session?.id) return;
    if (event.type === 'transcript') {
      try { renderTranscript(event.text); }
      catch (error) { failed(error.message); }
    }
    if (event.type === 'error') failed(event.message);
    if (event.type === 'cancelled' && session?.id === event.id) {
      failed('Dictation stopped.');
    }
  });
  function updateDestination(state) {
    const id = state.preferences.providerId || state.suggestedProviderId;
    const option = state.options.find(item => item.providerId === id && item.available && item.ready);
    destination = option ? `Dictate with ${option.name} · ${id === 'local' ? 'audio stays on this device' : 'audio sent to this service'}`
      : state.preferences.providerId ? 'Choose a dictation service' : 'Set up voice dictation';
    if (!busy) { button.title = destination; button.setAttribute('aria-label', destination); }
  }
  async function refreshDestination() {
    const current = ++destinationRevision;
    try {
      const state = await api.getAgentDictationState();
      if (!state?.ok || current !== destinationRevision) return;
      updateDestination(state);
    } catch { /* Availability is rechecked on every explicit microphone click. */ }
  }
  button.addEventListener('pointerenter', refreshDestination);
  button.addEventListener('focus', refreshDestination);
  void refreshDestination();
  window.addEventListener('focus', refreshDestination);
  const pageHide = () => cancel();
  window.addEventListener('pagehide', pageHide, { once: true });
  return {
    get busy() { return busy; }, cancel, finish,
    interrupt(message) { if (busy) failed(message); },
    refreshDestination,
    escape({ menusOnly = false } = {}) {
      if (servicesMenu?.open) { servicesMenu.close(true); return true; }
      if (menusOnly) return false;
      if (!busy && panel.hidden) return false;
      if (busy) void finish(); else { cancel(); prompt.focus(); }
      return true;
    },
    closeMenu() { servicesMenu?.close(); },
    dispose() { prompt.removeEventListener('keydown', startFromShortcut); prompt.removeEventListener('input', draftEdited); destinationRevision += 1; button.removeEventListener('pointerenter', refreshDestination); button.removeEventListener('focus', refreshDestination); window.removeEventListener('focus', refreshDestination); cancel(); choices.dispose(); servicesMenu?.dispose(); unsubscribe?.(); window.removeEventListener('pagehide', pageHide); },
  };
}
