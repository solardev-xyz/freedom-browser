const { createDocument, createElement } = require('../../../test/helpers/fake-dom');
const { createDictationSettings } = require('./dictation-settings');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tree = (root) => [root, ...root.children.flatMap(tree)];
const text = (root) => [root.textContent, ...root.children.map(text)].join(' ');
const find = (root, label) => tree(root).find((el) => el.textContent === label);

function setup({ localReady = false } = {}) {
  const element = (tag) => {
    const el = createElement(tag);
    el.append = (...items) => items.forEach((item) => el.appendChild(item));
    Object.defineProperty(el, 'childNodes', { get: () => el.children });
    return el;
  };
  global.document = createDocument({ createElementOverride: element });
  document.createElementNS = (_ns, tag) => element(tag);
  document.createTextNode = (value) => {
    const el = element('text');
    el.textContent = value;
    return el;
  };
  const host = element('div'),
    heading = element('h2'),
    breadcrumbs = element('nav');
  let state = {
    ok: true,
    preferences: { providerId: 'openai', language: 'auto', requireZeroRetention: true },
    suggestedProviderId: 'openai',
    languages: ['auto', 'de'],
    options: [
      {
        providerId: 'local',
        name: 'On this device',
        model: 'Whisper Base',
        ready: localReady,
        available: true,
        detail: 'Audio stays on this device.',
        price: 'No usage charges',
      },
      { providerId: 'openai', name: 'OpenAI', model: 'live', ready: true, available: true },
      {
        providerId: 'openrouter',
        name: 'OpenRouter',
        model: 'whisper',
        ready: true,
        available: true,
      },
    ],
  };
  let event;
  const unsubscribe = jest.fn();
  const api = {
    getAgentDictationState: jest.fn(async () => state),
    chooseAgentDictation: jest.fn(async (preferences) => {
      state = { ...state, preferences };
      return state;
    }),
    installAgentDictation: jest.fn(),
    cancelAgentDictation: jest.fn(async () => ({ ok: true })),
    onAgentDictationEvent: jest.fn((listener) => {
      event = listener;
      return unsubscribe;
    }),
  };
  const navigate = jest.fn();
  const view = createDictationSettings(host, api, { heading, breadcrumbs, navigate });
  return {
    view,
    api,
    host,
    heading,
    breadcrumbs,
    navigate,
    unsubscribe,
    emit: (value) => event(value),
    setState: (value) => {
      state = value;
    },
    getState: () => state,
  };
}

afterEach(() => {
  delete global.document;
});

test('lists services and their active state without selecting or downloading anything', async () => {
  const ctx = setup();
  await ctx.view.refresh();
  expect(text(ctx.host)).toContain('In use');
  expect(text(ctx.host)).toContain('Download needed');
  expect(find(ctx.host, 'On this device')).toBeTruthy();
  expect(ctx.api.chooseAgentDictation).not.toHaveBeenCalled();
  expect(ctx.api.installAgentDictation).not.toHaveBeenCalled();
  ctx.view.setPage('openrouter');
  expect(ctx.heading.textContent).toBe('OpenRouter');
  expect(text(ctx.breadcrumbs)).toContain('Voice dictation');
  expect(ctx.api.chooseAgentDictation).not.toHaveBeenCalled();
  find(ctx.host, 'Use for dictation').dispatch('click');
  await flush();
  expect(ctx.api.chooseAgentDictation).toHaveBeenCalledWith({
    providerId: 'openrouter',
    language: 'auto',
    requireZeroRetention: true,
  });
  expect(find(ctx.host, 'Used for dictation').disabled).toBe(true);
});

test('language and non-active service privacy changes preserve the selected service', async () => {
  const ctx = setup();
  await ctx.view.refresh();
  let language = tree(ctx.host).find(
    (el) => el.getAttribute('aria-label') === 'Dictation language'
  );
  language.value = 'de';
  language.dispatch('change');
  await flush();
  ctx.view.setPage('openrouter');
  const zero = tree(ctx.host).find(
    (el) => el.getAttribute('aria-label') === 'Require zero data retention'
  );
  zero.checked = false;
  zero.dispatch('change');
  await flush();
  expect(ctx.getState().preferences).toEqual({
    providerId: 'openai',
    language: 'de',
    requireZeroRetention: false,
  });
  ctx.view.setPage();
  language = tree(ctx.host).find((el) => el.getAttribute('aria-label') === 'Dictation language');
  expect(language.value).toBe('de');
});

test('failed preference changes restore the saved value and allow retry', async () => {
  const ctx = setup();
  await ctx.view.refresh();
  ctx.api.chooseAgentDictation.mockResolvedValueOnce({
    ok: false,
    error: { message: 'Try again' },
  });
  let language = tree(ctx.host).find(
    (el) => el.getAttribute('aria-label') === 'Dictation language'
  );
  language.value = 'de';
  language.dispatch('change');
  await flush();
  expect(text(ctx.host)).toContain('Try again');
  language = tree(ctx.host).find((el) => el.getAttribute('aria-label') === 'Dictation language');
  expect(language.value).toBe('auto');
  expect(language.disabled).toBe(false);
  language.value = 'de';
  language.dispatch('change');
  await flush();
  expect(ctx.getState().preferences.language).toBe('de');
});

test('local download requires a click, reports progress and ignores late completion after cancel', async () => {
  const ctx = setup();
  await ctx.view.refresh();
  ctx.view.setPage('local');
  expect(ctx.api.installAgentDictation).not.toHaveBeenCalled();
  let finish;
  ctx.api.installAgentDictation.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  find(ctx.host, 'Download & use on this device').dispatch('click');
  ctx.emit({ type: 'download', label: 'Downloading model', bytes: 10000000, total: 20000000 });
  expect(text(ctx.host)).toContain('10 MB of 20 MB');
  const progress = tree(ctx.host).find((el) => el.tagName === 'PROGRESS');
  expect(progress.value).toBe(10000000);
  find(ctx.host, 'Cancel download').dispatch('click');
  finish({ ok: true });
  await flush();
  expect(ctx.api.cancelAgentDictation).toHaveBeenCalledTimes(1);
  expect(ctx.api.chooseAgentDictation).not.toHaveBeenCalled();
  expect(find(ctx.host, 'Download & use on this device').disabled).toBe(false);
  ctx.view.dispose();
  expect(ctx.unsubscribe).toHaveBeenCalled();
});

test('download errors remain visible and a downloaded local model can be selected without another download', async () => {
  const ctx = setup();
  await ctx.view.refresh();
  ctx.view.setPage('local');
  ctx.api.installAgentDictation.mockResolvedValue({
    ok: false,
    error: { message: 'Download unavailable' },
  });
  find(ctx.host, 'Download & use on this device').dispatch('click');
  await flush();
  expect(text(ctx.host)).toContain('Download unavailable');
  const state = ctx.getState();
  state.options[0].ready = true;
  ctx.setState(state);
  await ctx.view.refresh();
  find(ctx.host, 'Use for dictation').dispatch('click');
  await flush();
  expect(ctx.api.installAgentDictation).toHaveBeenCalledTimes(1);
  expect(ctx.getState().preferences.providerId).toBe('local');
});

test('unconnected services lead to connection setup and unknown routes return to voice overview', async () => {
  const ctx = setup();
  await ctx.view.refresh();
  ctx.view.setPage('venice');
  expect(find(ctx.host, 'Connect provider').href).toBe('#ai/providers/venice');
  expect(find(ctx.host, 'Use for dictation')).toBeUndefined();
  ctx.view.setPage('bogus');
  expect(ctx.navigate).toHaveBeenCalledWith(null, true);
  expect(ctx.heading.textContent).toBe('Voice dictation');
});

test('connection-enforced zero retention stays locked and is preserved when selecting the service', async () => {
  const ctx = setup();
  const state = ctx.getState();
  state.preferences.requireZeroRetention = false;
  state.options.find((option) => option.providerId === 'openrouter').requireZeroRetention = true;
  await ctx.view.refresh();
  ctx.view.setPage('openrouter');
  const zero = tree(ctx.host).find(
    (el) => el.getAttribute('aria-label') === 'Require zero data retention'
  );
  expect(zero.checked).toBe(true);
  expect(zero.disabled).toBe(true);
  find(ctx.host, 'Use for dictation').dispatch('click');
  await flush();
  expect(ctx.getState().preferences).toMatchObject({
    providerId: 'openrouter',
    requireZeroRetention: true,
  });
});
