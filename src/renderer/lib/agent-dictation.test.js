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
  const nodes = Object.fromEntries(['button', 'optionsButton', 'panel', 'feedback', 'cancelButton'].map(name => [name, createElement()]));
  nodes.panel.hidden = true;
  const state = { ok: true, preferences: { providerId: 'venice', language: 'auto', requireZeroRetention: true },
    options: [{ providerId: 'venice', name: 'Venice', available: true, ready: true, detail: 'Audio goes to Venice.', price: 'Usage charges' }], languages: ['auto', 'de'] };
  let event;
  const api = { getAgentDictationState: jest.fn(async () => state), beginAgentDictation: jest.fn(async () => ({ ok: true, id: 'capture', name: 'Venice' })),
    transcribeAgentDictation: jest.fn(async () => ({ ok: true, text: 'a game' })),
    cancelAgentDictation: jest.fn(async () => ({ ok: true })), chooseAgentDictation: jest.fn(),
    onAgentDictationEvent: jest.fn(handler => { event = handler; return jest.fn(); }) };
  const stream = { getTracks: () => [{ stop: jest.fn() }] };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: jest.fn(async () => stream) } } });
  const recorder = { finish: jest.fn(async () => new Uint8Array(100)), cancel: jest.fn() };
  createDictationRecorder.mockResolvedValue(recorder);
  const onInput = jest.fn(), onBusy = jest.fn();
  const ui = createAgentDictation({ ...nodes, prompt, api, canRecord: () => true, onInput, onBusy });
  return { ...nodes, ui, prompt, api, recorder, state, onInput, onBusy, emit: value => event(value) };
}

afterEach(() => { delete global.document; delete global.window; delete global.navigator; jest.clearAllMocks(); });

test('record, stop, insert at the selection and keep the draft unsent', async () => {
  const ctx = setup();
  ctx.button.dispatch('click'); await flush();
  expect(ctx.ui.busy).toBe(true); expect(ctx.prompt.readOnly).toBe(true);
  expect(ctx.feedback.textContent).toContain('Listening · Venice');
  ctx.button.dispatch('click'); await flush();
  expect(ctx.api.transcribeAgentDictation).toHaveBeenCalledWith('capture', expect.any(Uint8Array));
  expect(ctx.prompt.value).toBe('Build a game please');
  expect(ctx.onInput).toHaveBeenCalledTimes(1); expect(ctx.ui.busy).toBe(false);
  expect(ctx.prompt.readOnly).toBe(false);
});

test('Escape cancels a recording without changing or sending the draft', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  expect(ctx.ui.escape()).toBe(true); await flush();
  expect(ctx.recorder.cancel).toHaveBeenCalled(); expect(ctx.prompt.value).toBe('Build this please');
  expect(ctx.api.transcribeAgentDictation).not.toHaveBeenCalled(); expect(ctx.ui.busy).toBe(false);
});

test('a cancelled in-flight transcription cannot insert late text into a new conversation', async () => {
  const ctx = setup(); let resolve;
  ctx.api.transcribeAgentDictation.mockImplementation(() => new Promise(done => { resolve = done; }));
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

test('first use shows a chooser before starting the microphone', async () => {
  const ctx = setup(); ctx.state.preferences.providerId = null;
  ctx.button.dispatch('click'); await flush();
  expect(ctx.panel.hidden).toBe(false); expect(ctx.api.beginAgentDictation).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  ctx.ui.escape(); expect(ctx.panel.hidden).toBe(true);
});

test('main-process cancellation releases the recorder and ignores any late finish', async () => {
  const ctx = setup(); ctx.button.dispatch('click'); await flush();
  ctx.emit({ type: 'cancelled', id: 'capture' }); await flush();
  expect(ctx.recorder.cancel).toHaveBeenCalled(); expect(ctx.ui.busy).toBe(false);
  expect(ctx.prompt.value).toBe('Build this please');
});
