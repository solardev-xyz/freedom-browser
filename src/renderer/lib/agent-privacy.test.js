const { createDocument, createElement } = require('../../../test/helpers/fake-dom');
jest.mock('./popover-bounds.js', () => ({ placePopoverAtPoint: jest.fn() }));
const { createAgentPrivacy, privacyLabel } = require('./agent-privacy');

test('labels hardware advisories and partial evidence without claiming verified inference', () => {
  expect(privacyLabel({ routes: [{ hardware: { status: 'advisory' } }] })).toBe('Hardware needs security updates');
  expect(privacyLabel({ routes: [{ hardware: { status: 'checked' } }] })).toBe('Hardware checked; privacy not proven');
  expect(privacyLabel({ routes: [{ providerId: 'ollama', origin: 'http://localhost.evil.test' }] })).toBe('Provider privacy claims');
  expect(privacyLabel({ routes: [{ providerId: 'ollama', origin: 'http://127.0.0.1:11434' }] })).toBe('Local model endpoint');
});

test('renders evidence as text, supports Escape and clears when switching conversations', () => {
  const element = tag => {
    const node = createElement(tag);
    node.append = (...items) => items.forEach(item => node.appendChild(item));
    return node;
  };
  global.document = createDocument({ createElementOverride: element });
  global.window = { addEventListener: jest.fn() };
  const button = element('button');
  const panel = element('section');
  panel.hidden = true;
  const view = createAgentPrivacy(button, panel);
  view.update({ version: 1, earlierUnknown: true, routes: [{ modelId: '<script>secret</script>',
    providerId: 'near-ai', role: 'permission', requests: 2, origin: 'https://cloud-api.near.ai', claim: 'tee',
    hardware: { status: 'advisory', reports: [{ tcb: 'OutOfDate', advisories: ['INTEL-SA-01192'] }] } }] });
  expect(button.hidden).toBe(false);
  button.dispatch('click');
  expect(panel.hidden).toBe(false);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const text = node => [node.textContent, ...node.children.map(text)].join(' ');
  expect(text(panel)).toContain('Responses are not independently verified.');
  expect(text(panel)).toContain('End-to-end encryption is off');
  expect(text(panel)).toContain('Permission checks · 2 request attempts');
  expect(view.escape()).toBe(true);
  expect(panel.hidden).toBe(true);
  view.update(null);
  expect(button.hidden).toBe(true);
  delete global.document;
  delete global.window;
});

test('model previews distinguish claims, available checks and encryption that is not enabled', () => {
  const { modelPrivacyInfo } = require('./agent-privacy');
  expect(modelPrivacyInfo('near-ai', { privacy: 'tee', attestation: true }).label).toContain('Connection + response checks');
  expect(modelPrivacyInfo('venice', { privacy: 'private', attestation: true, e2ee: true }).label)
    .toBe('Protected hardware (claimed) · Hardware check only · E2EE when supported');
  expect(modelPrivacyInfo('venice', { id: 'e2ee-qwen', privacy: 'private' }).label).not.toContain('E2EE offered');
  expect(modelPrivacyInfo('near-ai', { privacy: 'external' }).label).toBe('External model provider');
  expect(modelPrivacyInfo('ollama', {}, 'http://127.0.0.1:11434/v1').label).toBe('On this device');
  expect(modelPrivacyInfo('ollama', {}, 'http://localhost.evil.test/v1').label).toBe('Your Ollama server');
  expect(modelPrivacyInfo('openrouter', {}).label).toBe('Zero retention required');
  expect(modelPrivacyInfo('venice', {}).label).toBe('Privacy not reported');
});

test('OpenRouter shield toggles future requests and preserves mixed historical coverage', async () => {
  const element = tag => { const node = createElement(tag); node.append = (...items) => items.forEach(item => node.appendChild(item)); return node; };
  global.document = createDocument({ createElementOverride: element });
  global.window = { addEventListener: jest.fn() };
  const button = element('button'), panel = element('section'); panel.hidden = true;
  const save = jest.fn(async () => {});
  const view = createAgentPrivacy(button, panel, save);
  view.setProvider('openrouter');
  expect(button.hidden).toBe(false);
  view.update({ version: 1, settings: { requireZeroRetention: true }, routes: [
    { modelId: 'qwen', providerId: 'openrouter', requests: 2, retention: 'required' },
    { modelId: 'qwen', providerId: 'openrouter', requests: 1, retention: 'not-required' },
  ] });
  button.dispatch('click');
  const text = node => [node.textContent, ...node.children.map(text)].join(' ');
  expect(text(panel)).toContain('2 of 3 requests required zero-retention routes');
  const input = panel.children.find(n => n.tagName === 'LABEL').children[0];
  expect(input.checked).toBe(true);
  input.checked = false; input.dispatch('change');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(save).toHaveBeenCalledWith({ requireZeroRetention: false });
  expect(view.settings()).toEqual({ requireZeroRetention: false });
  view.update(null);
  expect(view.settings()).toEqual({ requireZeroRetention: true });
  delete global.document; delete global.window;
});


test('privacy symbols distinguish conditional encryption, retention policy and local destinations', () => {
  const { modelPrivacyInfo } = require('./agent-privacy');
  const kinds = (...args) => modelPrivacyInfo(...args).symbols.map(symbol => symbol.kind);
  expect(kinds('venice', { attestation: true, e2ee: true })).toEqual(['shield', 'partial-lock']);
  expect(kinds('venice', { id: 'e2ee-name-only', privacy: 'private' })).toEqual(['policy']);
  for (const provider of ['openai', 'openai-chatgpt', 'openai-codex', 'anthropic', 'anthropic-claude', 'meta', 'meta-subscription']) {
    expect(kinds(provider, { privacy: 'standard' })).toEqual([]);
  }
  expect(kinds('openrouter', { id: 'openai/gpt', privacy: 'routing' })).toEqual(['no-retention']);
  expect(kinds('openrouter', {})).toEqual(['no-retention']);
  expect(kinds('openrouter', {}, '', { requireZeroRetention: false })).toEqual(['retention']);
  expect(kinds('ollama', {}, 'http://localhost:11434')).toEqual(['device']);
  expect(kinds('ollama', {}, 'https://localhost.evil.test')).toEqual(['server']);
  expect(kinds('near-ai', { privacy: 'external' })).toEqual(['external']);
  expect(kinds('venice', {})).toEqual(['unknown']);
  expect(modelPrivacyInfo('venice', { e2ee: true }).symbols[0].detail).toContain('fall back to HTTPS');
});
