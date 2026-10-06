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
