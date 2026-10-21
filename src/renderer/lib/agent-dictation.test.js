const { createDocument, createElement } = require('../../../test/helpers/fake-dom');
jest.mock('./dictation-recorder', () => ({ createDictationRecorder: jest.fn() }));
const { createDictationRecorder } = require('./dictation-recorder');
const { createAgentDictation } = require('./agent-dictation');
const flush = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

function setup() {
  global.document = createDocument();
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag); node.append = (...children) => children.forEach(child => node.appendChild(child)); return node;
  };
  document.createTextNode = text => { const node = createElement(); node.textContent = text; return node; };
  global.window = { addEventListener: jest.fn() };
  const prompt = createElement(); prompt.value = 'Build this please'; prompt.selectionStart = 6; prompt.selectionEnd = 10;
  prompt.setSelectionRange = jest.fn();
  const nodes = Object.fromEntries(['button', 'optionsButton', 'panel', 'menu', 'feedback', 'cancelButton'].map(name => [name, createElement()]));
  nodes.panel.hidden = true;
  nodes.menu.hidden = true;
  const state = { ok: true, preferences: { providerId: 'venice', language: 'auto', openrouterAudioConsent: false },
    options: [{ providerId: 'venice', name: 'Venice', available: true, ready: true, detail: 'Audio goes to Venice.', price: 'Usage charges' }], languages: ['auto', 'de'] };
  let event;
  const api = { getAgentDictationState: jest.fn(async () => state), beginAgentDictation: jest.fn(async () => ({ ok: true, id: 'capture', name: 'Venice' })),
    finishAgentDictation: jest.fn(async () => ({ ok: true, text: 'a game' })), appendAgentDictation: jest.fn(async () => ({ ok: true })),
    cancelAgentDictation: jest.fn(async () => ({ ok: true })), chooseAgentDictation: jest.fn(async input => {
      if (input.providerId) state.preferences.providerId = input.providerId;
      if (input.language) state.preferences.language = input.language;
      if (input.acceptOpenRouterAudio) state.preferences.openrouterAudioConsent = true;
      const option = state.options.find(item => item.providerId === 'openrouter');
      if (option) option.consentRequired = !state.preferences.openrouterAudioConsent;
      return state;
    }),
    onAgentDictationEvent: jest.fn(handler => { event = handler; return jest.fn(); }) };
  const stream = { getTracks: () => [{ stop: jest.fn() }] };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: jest.fn(async () => stream) } } });
  const recorder = { finish: jest.fn(async () => new Uint8Array(100)), cancel: jest.fn() };
  createDictationRecorder.mockResolvedValue(recorder);
  const onInput = jest.fn(), onBusy = jest.fn();
  const openSettings = jest.fn();
  const ui = createAgentDictation({ ...nodes, prompt, api, canRecord: () => true, onInput, onBusy, openSettings });
  return { ...nodes, ui, prompt, api, recorder, state, onInput, onBusy, openSettings, emit: value => event(value) };
}

afterEach(() => { delete global.document; delete global.window; delete global.navigator; jest.clearAllMocks(); });

test('record, stop, insert at the selection and keep the draft unsent', async () => {
  const ctx = setup();
  ctx.button.dispatch('click'); await flush();
  expect(ctx.ui.busy).toBe(true); expect(ctx.prompt.readOnly).toBe(true);
  expect(ctx.feedback.textContent).toContain('Listening · Venice');
  ctx.button.dispatch('click'); await flush();
  expect(ctx.api.finishAgentDictation).toHaveBeenCalledWith('capture');
  expect(ctx.prompt.value).toBe('Build a game please');
  expect(ctx.onInput).toHaveBeenCalledTimes(1); expect(ctx.ui.busy).toBe(false);
  expect(ctx.prompt.readOnly).toBe(false);
});

test('Escape cancels a recording without changing or sending the draft', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  expect(ctx.ui.escape()).toBe(true); await flush();
  expect(ctx.recorder.cancel).toHaveBeenCalled(); expect(ctx.prompt.value).toBe('Build this please');
  expect(ctx.api.finishAgentDictation).not.toHaveBeenCalled(); expect(ctx.ui.busy).toBe(false);
});

test('a cancelled in-flight transcription cannot insert late text into a new conversation', async () => {
  const ctx = setup(); let resolve;
  ctx.api.finishAgentDictation.mockImplementation(() => new Promise(done => { resolve = done; }));
  ctx.button.dispatch('click'); await flush(); ctx.button.dispatch('click'); await flush();
  expect(ctx.button.disabled).toBe(true);
  ctx.ui.cancel(); ctx.prompt.value = 'New conversation draft';
  expect(ctx.button.disabled).toBe(false);
  resolve({ ok: true, text: 'late' }); await flush();
  expect(ctx.prompt.value).toBe('New conversation draft'); expect(ctx.onInput).not.toHaveBeenCalled();
  ctx.button.dispatch('click'); await flush();
  expect(ctx.ui.busy).toBe(true);
});

test('microphone denial is actionable and preserves draft and selection', async () => {
  const ctx = setup(); navigator.mediaDevices.getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  ctx.button.dispatch('click'); await flush();
  expect(ctx.feedback.textContent).toContain('Microphone access is blocked');
  expect(ctx.prompt.value).toBe('Build this please'); expect(ctx.ui.busy).toBe(false);
});

test('first use starts the suggested connected service without showing setup', async () => {
  const ctx = setup(); ctx.state.preferences.providerId = null; ctx.state.suggestedProviderId = 'venice';
  ctx.button.dispatch('click'); await flush();
  expect(ctx.panel.hidden).toBe(true); expect(ctx.api.beginAgentDictation).toHaveBeenCalledTimes(1);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(ctx.feedback.textContent).toContain('Listening · Venice');
});

test('the chevron opens a provider menu without starting the microphone or showing setup', async () => {
  const ctx = setup(); ctx.state.preferences.providerId = null; ctx.state.suggestedProviderId = 'venice';
  ctx.optionsButton.dispatch('click'); await flush();
  expect(ctx.panel.hidden).toBe(true); expect(ctx.menu.hidden).toBe(false);
  expect(ctx.menu.querySelector('[data-provider-id="venice"]').getAttribute('aria-checked')).toBe('true');
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});

test('provider selection preserves language and retention preferences and never starts recording', async () => {
  const ctx = setup();
  ctx.state.preferences.language = 'de';
  ctx.state.options.push({ providerId: 'openrouter', name: 'OpenRouter', available: true, ready: true });
  ctx.optionsButton.dispatch('click'); await flush();
  ctx.menu.querySelector('[data-provider-id="openrouter"]').dispatch('click'); await flush();
  expect(ctx.api.chooseAgentDictation).toHaveBeenCalledWith({ providerId: 'openrouter', language: 'de' });
  expect(ctx.menu.hidden).toBe(true); expect(ctx.panel.hidden).toBe(true);
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
});

test('an uninstalled local choice opens Settings rather than downloading or showing setup', async () => {
  const ctx = setup();
  ctx.state.options.push({ providerId: 'local', name: 'On this device', available: true, ready: false });
  ctx.optionsButton.dispatch('click'); await flush();
  ctx.menu.querySelector('[data-provider-id="local"]').dispatch('click'); await flush();
  expect(ctx.openSettings).toHaveBeenCalledTimes(1); expect(ctx.panel.hidden).toBe(true);
  expect(ctx.api.chooseAgentDictation).not.toHaveBeenCalled();
});

test('Escape dismisses the menu first and a late options response cannot reopen it', async () => {
  const ctx = setup(); let resolve;
  ctx.api.getAgentDictationState.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  ctx.optionsButton.dispatch('click'); await flush();
  expect(ctx.ui.escape()).toBe(true);
  resolve(ctx.state); await flush();
  expect(ctx.menu.hidden).toBe(true); expect(ctx.optionsButton.getAttribute('aria-expanded')).toBe('false');
});

test('without a suitable connection first use shows setup before starting the microphone', async () => {
  const ctx = setup(); ctx.state.preferences.providerId = null;
  ctx.state.options = [{ providerId: 'local', name: 'On this device', available: true, ready: false }];
  ctx.button.dispatch('click'); await flush();
  expect(ctx.panel.hidden).toBe(false); expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  ctx.ui.escape(); expect(ctx.panel.hidden).toBe(true);
});

test('a saved unavailable service offers the compact menu without silently choosing another connection', async () => {
  const ctx = setup(); ctx.state.preferences.providerId = 'near-ai'; ctx.state.suggestedProviderId = 'venice';
  ctx.button.dispatch('click'); await flush();
  expect(ctx.panel.hidden).toBe(true); expect(ctx.menu.hidden).toBe(false);
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  ctx.menu.querySelector('[data-provider-id="venice"]').dispatch('click'); await flush();
  expect(ctx.api.beginAgentDictation).toHaveBeenCalledTimes(1);
});

test('a blocked saved service links to its settings and a later chevron choice never starts capture', async () => {
  const ctx = setup();
  ctx.state.preferences.providerId = 'openrouter';
  ctx.state.options.push({ providerId: 'openrouter', name: 'OpenRouter', available: false, ready: true,
    blockedLabel: 'Blocked by retention setting', detail: 'Zero data retention is required.' });
  ctx.button.dispatch('click'); await flush();
  expect(ctx.feedback.textContent).toContain('Zero data retention');
  ctx.menu.querySelector('[data-provider-id="openrouter"]').dispatch('click'); await flush();
  expect(ctx.openSettings).toHaveBeenCalledWith('openrouter');
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  ctx.optionsButton.dispatch('click'); await flush();
  ctx.menu.querySelector('[data-provider-id="venice"]').dispatch('click'); await flush();
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
});

test('main-process cancellation releases the recorder and ignores any late finish', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  ctx.emit({ type: 'cancelled', id: 'capture' }); await flush();
  expect(ctx.recorder.cancel).toHaveBeenCalled(); expect(ctx.ui.busy).toBe(false);
  expect(ctx.prompt.value).toBe('Build this please');
});

test('live text replaces provisional words without duplicating the final answer or sending the prompt', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  ctx.emit({ type: 'transcript', id: 'capture', text: 'a guess', stableText: '' });
  expect(ctx.prompt.value).toBe('Build a guess please');
  ctx.emit({ type: 'transcript', id: 'capture', text: 'a game', stableText: 'a game' });
  expect(ctx.prompt.value).toBe('Build a game please');
  expect(ctx.api.finishAgentDictation).not.toHaveBeenCalled();
  ctx.button.dispatch('click'); await flush();
  expect(ctx.prompt.value).toBe('Build a game please'); expect(ctx.prompt.readOnly).toBe(false);
});

test('Escape restores the original selected text after live transcription and discards late events', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  ctx.emit({ type: 'transcript', id: 'capture', text: 'a game', stableText: 'a game' });
  ctx.ui.escape();
  expect(ctx.prompt.value).toBe('Build this please');
  ctx.emit({ type: 'transcript', id: 'capture', text: 'late words', stableText: 'late words' });
  expect(ctx.prompt.value).toBe('Build this please');
});

test('a service failure preserves completed phrases and drops the unfinished tail', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  ctx.emit({ type: 'transcript', id: 'capture', text: 'a game unfinished', stableText: 'a game' });
  ctx.emit({ type: 'error', id: 'capture', stableText: 'a game', message: 'Connection lost.' });
  expect(ctx.prompt.value).toBe('Build a game please'); expect(ctx.ui.busy).toBe(false);
  expect(ctx.feedback.textContent).toContain('Text already transcribed was kept');
});

test('captured PCM frames reach main in sequence and Stop waits for the last frame acknowledgement', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  const { onChunk } = createDictationRecorder.mock.calls[0][3];
  let resolve;
  ctx.api.appendAgentDictation.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  onChunk(new Uint8Array([1, 2])); onChunk(new Uint8Array([3, 4]));
  ctx.button.dispatch('click'); await flush();
  expect(ctx.api.finishAgentDictation).not.toHaveBeenCalled();
  resolve({ ok: true }); await flush();
  expect(ctx.api.appendAgentDictation.mock.calls.map(call => call[1])).toEqual([0, 1]);
  expect(ctx.api.finishAgentDictation).toHaveBeenCalledTimes(1);
});

test('an oversized live phrase preserves the last fitting text and always releases the microphone', async () => {
  const ctx = setup(); ctx.prompt.maxLength = 24;
  ctx.button.dispatch('click'); await flush();
  ctx.emit({ type: 'transcript', id: 'capture', text: 'a game', stableText: 'a game' });
  expect(() => ctx.emit({ type: 'transcript', id: 'capture', text: 'x'.repeat(100), stableText: 'x'.repeat(100) })).not.toThrow();
  expect(ctx.prompt.value).toBe('Build a game please'); expect(ctx.ui.busy).toBe(false);
  expect(ctx.recorder.cancel).toHaveBeenCalled();
});


test('approval interruption keeps completed text, stops capture and ignores late phrases', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  ctx.emit({ type: 'transcript', id: 'capture', text: 'a game unfinished', stableText: 'a game' });
  ctx.ui.interrupt('Dictation stopped for an approval request.');
  expect(ctx.prompt.value).toBe('Build a game please'); expect(ctx.ui.busy).toBe(false);
  expect(ctx.recorder.cancel).toHaveBeenCalled(); expect(ctx.feedback.textContent).toContain('kept');
  ctx.emit({ type: 'transcript', id: 'capture', text: 'late', stableText: 'late' });
  expect(ctx.prompt.value).toBe('Build a game please');
});

test('the microphone names its automatic audio destination before capture', async () => {
  const ctx = setup(); await flush();
  expect(ctx.button.getAttribute('aria-label')).toContain('Venice');
  expect(ctx.button.title).toContain('audio sent to this service');
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});


test('a delayed local installation requires a fresh microphone click', async () => {
  const ctx = setup();
  ctx.state.preferences.providerId = null;
  ctx.state.options = [{ providerId: 'local', name: 'On this device', available: true, ready: false }];
  let installed;
  ctx.api.installAgentDictation = jest.fn(() => new Promise(resolve => { installed = resolve; }));
  ctx.api.chooseAgentDictation.mockImplementation(async () => ({ ...ctx.state, preferences: { ...ctx.state.preferences, providerId: 'local' },
    options: [{ providerId: 'local', name: 'On this device', available: true, ready: true }] }));
  ctx.button.dispatch('click'); await flush();
  ctx.panel.children.find(el => el.classList.contains('agent-dictation-actions')).children[0].dispatch('click'); await flush();
  installed({ ok: true }); await flush();
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(ctx.feedback.textContent).toContain('Click the microphone');
});


test('hover and microphone clicks refresh a changed audio destination', async () => {
  const ctx = setup(); await flush();
  ctx.state.preferences.providerId = 'local';
  ctx.state.options.push({ providerId: 'local', name: 'On this device', available: true, ready: true });
  ctx.button.dispatch('pointerenter'); await flush();
  expect(ctx.button.title).toContain('audio stays on this device');
  ctx.state.preferences.providerId = 'venice';
  ctx.button.dispatch('click'); await flush();
  ctx.ui.cancel();
  expect(ctx.button.title).toContain('Venice');
  expect(ctx.button.title).toContain('audio sent to this service');
});


const descendants = root => [root, ...root.children.flatMap(descendants)];
const action = (root, text) => descendants(root).find(el => el.textContent === text);
function addOpenRouter(ctx) {
  ctx.state.preferences.providerId = 'openrouter';
  ctx.state.options.push({ providerId: 'openrouter', name: 'OpenRouter', available: true, ready: true, consentRequired: true,
    consentDisclosure: 'Audio uses standard routing. Zero data retention is unavailable. Chat privacy settings do not apply.' });
}

test('OpenRouter audio disclosure precedes capture; accepting is remembered without changing chat policy', async () => {
  const ctx = setup(); addOpenRouter(ctx);
  ctx.button.dispatch('click'); await flush();
  expect(ctx.panel.hidden).toBe(false);
  expect(action(ctx.panel, 'Use OpenRouter for dictation?')).toBeTruthy();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  action(ctx.panel, 'Use OpenRouter').dispatch('click'); await flush();
  expect(ctx.api.chooseAgentDictation).toHaveBeenCalledWith({ providerId: 'openrouter', acceptOpenRouterAudio: true });
  expect(ctx.api.beginAgentDictation).toHaveBeenCalledTimes(1);
  ctx.button.dispatch('click'); await flush();
  ctx.button.dispatch('click'); await flush();
  expect(ctx.panel.hidden).toBe(true);
  expect(ctx.api.beginAgentDictation).toHaveBeenCalledTimes(2);
});

test('choosing another service or cancelling OpenRouter consent never captures audio or accepts it', async () => {
  const ctx = setup(); addOpenRouter(ctx);
  ctx.button.dispatch('click'); await flush();
  action(ctx.panel, 'Choose another service').dispatch('click'); await flush();
  expect(ctx.menu.hidden).toBe(false); expect(ctx.panel.hidden).toBe(true);
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  ctx.ui.escape();
  ctx.button.dispatch('click'); await flush();
  action(ctx.panel, 'Cancel').dispatch('click'); await flush();
  expect(ctx.api.chooseAgentDictation).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(ctx.state.preferences.openrouterAudioConsent).toBe(false);
});

test('a late acknowledgement cannot start the microphone after Escape or a conversation change', async () => {
  const ctx = setup(); addOpenRouter(ctx); let resolve;
  ctx.api.chooseAgentDictation.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  ctx.button.dispatch('click'); await flush();
  action(ctx.panel, 'Use OpenRouter').dispatch('click'); await flush();
  ctx.ui.cancel();
  resolve({ ...ctx.state, preferences: { ...ctx.state.preferences, openrouterAudioConsent: true } }); await flush();
  expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});
