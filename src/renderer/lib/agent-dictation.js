import { createDictationChoices } from './dictation-choices.js';
import { createDictationRecorder } from './dictation-recorder.js';
import { createDictationMenu } from './dictation-menu.js';

export function createAgentDictation({ button, optionsButton, panel, menu, feedback, cancelButton, prompt, api,
  canRecord, onBusy = () => {}, onInput = () => {}, connectProvider = () => {}, openSettings = connectProvider, onMenuOpening = () => {} }) {
  if (!button || !panel || !api.getAgentDictationState) return null;
  let generation = 0;
  let session = null;
  let recorder = null;
  let inputStream = null;
  let busy = false;
  let finishing = false;
  let chooserStart = false;
  let snapshot;
  let renderedValue;
  let stableText = '';
  let audioQueue = Promise.resolve();
  let queuedFrames = 0;
  let sequence = 0;
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
    prompt.readOnly = value;
    button.setAttribute('aria-pressed', String(value));
    button.dataset.recording = String(value && !finishing);
    button.setAttribute('aria-label', value ? 'Finish dictation' : 'Dictate task');
    button.title = value ? 'Finish dictation' : 'Dictate task';
    optionsButton.disabled = value;
    cancelButton.hidden = !value;
    onBusy(value);
  };
  const choices = createDictationChoices(panel, api, {
    onChosen() {
      hideChoices();
      if (chooserStart) void start(); else button.focus();
    },
    onCancel() { hideChoices(); button.focus(); },
  });
  const servicesMenu = menu ? createDictationMenu({ host: menu, button: optionsButton, api,
    canOpen: () => !busy && canRecord(), onOpening: onMenuOpening,
    openSettings, onError: message => status(message, true) }) : null;
  panel.addEventListener('dictation-connect', () => { cancel(); connectProvider(); });

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
    button.disabled = false;
    choices.cancel(); hideChoices();
    servicesMenu?.close();
    void api.cancelAgentDictation().catch(() => {});
    setBusy(false);
    snapshot = null;
    if (!keepMessage) status('');
  }

  function renderTranscript(text) {
    if (!snapshot || prompt.value !== renderedValue) throw new Error('Your draft changed while dictating. Please record again.');
    const before = snapshot.value.slice(0, snapshot.start);
    const after = snapshot.value.slice(snapshot.end);
    const insertion = text ? `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}` : '';
    if (before.length + insertion.length + after.length > (prompt.maxLength > 0 ? prompt.maxLength : 32000))
      throw new Error('The transcript would make your prompt too long. Try a shorter recording.');
    prompt.value = renderedValue = text ? before + insertion + after : snapshot.value;
    prompt.setSelectionRange(before.length + insertion.length, before.length + insertion.length);
    onInput();
  }

  function failed(message) {
    // Keep completed phrases after a service failure; Escape/Cancel still
    // restore the pre-dictation draft, including the original selection.
    let kept = false;
    if (stableText && snapshot && prompt.value === renderedValue) {
      try { renderTranscript(stableText); snapshot = null; kept = true; }
      catch { /* An oversized transcript must not prevent microphone release. */ }
    }
    cancel();
    status(`${message}${kept ? ' Text already transcribed was kept.' : ' Your draft is unchanged.'}`, true);
  }

  async function start() {
    if (busy || !canRecord()) return;
    servicesMenu?.close();
    const current = ++generation;
    snapshot = { value: prompt.value, start: prompt.selectionStart ?? prompt.value.length,
      end: prompt.selectionEnd ?? prompt.value.length };
    renderedValue = snapshot.value;
    stableText = ''; audioQueue = Promise.resolve(); queuedFrames = 0; sequence = 0;
    finishing = false;
    setBusy(true); status('Starting microphone…');
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
      } });
      if (current !== generation) { capture.cancel(); return; }
      recorder = capture;
      status(`Listening · ${response.name}${response.local ? ' · audio stays on this device' : ' · audio sent to this service'}`);
    } catch (error) {
      if (current !== generation) return;
      const message = error.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow Freedom to use your microphone in system settings, then try again.'
        : error.name === 'NotFoundError' ? 'No microphone found. Connect one and try again.' : error.message || 'Could not start the microphone.';
      failed(message);
    }
  }

  async function finish() {
    if (!busy || finishing) return;
    if (!recorder || !session) { cancel(); return; }
    const current = generation;
    const id = session.id;
    finishing = true; button.dataset.recording = 'false'; button.disabled = true;
    status(`Transcribing · ${session.name}…`);
    try {
      await recorder.finish();
      recorder = null;
      inputStream = null;
      if (current !== generation) return;
      await audioQueue;
      if (current !== generation) return;
      const response = await api.finishAgentDictation(id);
      if (current !== generation) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Transcription did not complete.');
      const text = response.text;
      if (typeof text !== 'string' || !text.trim()) throw new Error('No speech detected. Please try again.');
      renderTranscript(text);
      snapshot = null;
      status('');
    } catch (error) {
      if (current === generation) failed(error.message || 'Dictation did not complete.');
    } finally {
      if (current === generation) {
        recorder?.cancel(); recorder = null;
        inputStream?.getTracks().forEach(track => track.stop()); inputStream = null;
        session = null; finishing = false; button.disabled = false; setBusy(false); prompt.focus();
      }
    }
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
  button.addEventListener('click', async () => {
    if (busy) { void finish(); return; }
    if (!canRecord()) return;
    const current = ++generation;
    button.disabled = true;
    try {
      const state = await api.getAgentDictationState();
      if (current !== generation || !canRecord()) return;
      if (!state?.ok) throw new Error(state?.error?.message || 'Could not load dictation.');
      const providerId = state.preferences.providerId || state.suggestedProviderId;
      const option = state.options.find(option => option.providerId === providerId && option.available && option.ready);
      if (option) void start(); else await openChoices(true);
    } catch (error) { if (current === generation) status(error.message, true); }
    finally { button.disabled = false; }
  });
  panel.addEventListener('cancel', event => { event.preventDefault(); cancel(); prompt.focus(); });
  cancelButton.addEventListener('click', () => { cancel(); prompt.focus(); });
  const unsubscribe = api.onAgentDictationEvent?.(event => {
    if (event.id !== session?.id) return;
    if (event.type === 'transcript') {
      try { renderTranscript(event.text); stableText = event.stableText; }
      catch (error) { failed(error.message); }
    }
    if (event.type === 'error') { stableText = event.stableText; failed(event.message); }
    if (event.type === 'cancelled' && session?.id === event.id) {
      status('Dictation stopped. Your draft is unchanged.'); cancel({ keepMessage: true });
    }
  });
  const pageHide = () => cancel();
  window.addEventListener('pagehide', pageHide, { once: true });
  return {
    get busy() { return busy; }, cancel,
    escape() {
      if (servicesMenu?.open) { servicesMenu.close(true); return true; }
      if (!busy && panel.hidden) return false;
      cancel(); prompt.focus(); return true;
    },
    closeMenu() { servicesMenu?.close(); },
    dispose() { cancel(); choices.dispose(); servicesMenu?.dispose(); unsubscribe?.(); window.removeEventListener('pagehide', pageHide); },
  };
}
