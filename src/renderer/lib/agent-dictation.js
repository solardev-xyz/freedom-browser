import { createDictationChoices } from './dictation-choices.js';
import { createDictationRecorder } from './dictation-recorder.js';

export function createAgentDictation({ button, optionsButton, panel, feedback, cancelButton, prompt, api,
  canRecord, onBusy = () => {}, onInput = () => {}, connectProvider = () => {} }) {
  if (!button || !panel || !api.getAgentDictationState) return null;
  let generation = 0;
  let session = null;
  let recorder = null;
  let inputStream = null;
  let busy = false;
  let finishing = false;
  let chooserStart = false;
  let snapshot;
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
  panel.addEventListener('dictation-connect', () => { cancel(); connectProvider(); });

  function cancel({ keepMessage = false } = {}) {
    generation += 1;
    recorder?.cancel(); recorder = null;
    inputStream?.getTracks().forEach(track => track.stop()); inputStream = null;
    session = null;
    finishing = false;
    button.disabled = false;
    choices.cancel(); hideChoices();
    void api.cancelAgentDictation().catch(() => {});
    setBusy(false);
    if (!keepMessage) status('');
  }

  async function start() {
    if (busy || !canRecord()) return;
    const current = ++generation;
    snapshot = { value: prompt.value, start: prompt.selectionStart ?? prompt.value.length,
      end: prompt.selectionEnd ?? prompt.value.length };
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
        status('Recording stopped unexpectedly. Your draft is unchanged. Please try again.', true);
        cancel({ keepMessage: true });
      });
      if (current !== generation) { capture.cancel(); return; }
      recorder = capture;
      status(`Listening · ${response.name}${response.local ? ' · audio stays on this device' : ' · audio sent to this service'}`);
    } catch (error) {
      if (current !== generation) return;
      const message = error.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow Freedom to use your microphone in system settings, then try again.'
        : error.name === 'NotFoundError' ? 'No microphone found. Connect one and try again.' : error.message || 'Could not start the microphone.';
      status(message, true); cancel({ keepMessage: true });
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
      const audio = await recorder.finish();
      recorder = null;
      inputStream = null;
      if (current !== generation) return;
      const response = await api.transcribeAgentDictation(id, audio);
      if (current !== generation) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Transcription did not complete.');
      // Never replace a draft changed by another lifecycle event while waiting.
      if (prompt.value !== snapshot.value) throw new Error('Your draft changed while transcribing. Please record again.');
      const text = response.text;
      if (typeof text !== 'string' || !text.trim()) throw new Error('No speech detected. Please try again.');
      const before = snapshot.value.slice(0, snapshot.start);
      const after = snapshot.value.slice(snapshot.end);
      const insertion = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}`;
      if (before.length + insertion.length + after.length > (prompt.maxLength > 0 ? prompt.maxLength : 32000))
        throw new Error('The transcript would make your prompt too long. Try a shorter recording.');
      prompt.value = before + insertion + after;
      prompt.setSelectionRange(before.length + insertion.length, before.length + insertion.length);
      status('');
      onInput();
    } catch (error) {
      if (current === generation) status(error.message || 'Dictation did not complete. Your draft is unchanged.', true);
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
  optionsButton.addEventListener('click', () => void openChoices());
  panel.addEventListener('cancel', event => { event.preventDefault(); cancel(); prompt.focus(); });
  cancelButton.addEventListener('click', () => { cancel(); prompt.focus(); });
  const unsubscribe = api.onAgentDictationEvent?.(event => {
    if (event.type === 'cancelled' && session?.id === event.id) {
      status('Dictation stopped. Your draft is unchanged.'); cancel({ keepMessage: true });
    }
  });
  const pageHide = () => cancel();
  window.addEventListener('pagehide', pageHide, { once: true });
  return {
    get busy() { return busy; }, cancel,
    escape() {
      if (!busy && panel.hidden) return false;
      cancel(); prompt.focus(); return true;
    },
    dispose() { cancel(); choices.dispose(); unsubscribe?.(); window.removeEventListener('pagehide', pageHide); },
  };
}
