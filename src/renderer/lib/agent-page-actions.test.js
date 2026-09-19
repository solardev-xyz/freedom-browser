const { createDocument, createElement } = require('../../../test/helpers/fake-dom');
jest.mock('./popover-bounds.js', () => ({ placePopoverAtPoint: jest.fn() }));
const { createPageActions, pageActionPrompt } = require('./agent-page-actions');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let views;
beforeEach(() => { jest.useFakeTimers(); views = []; });
afterEach(() => { views.forEach((view) => view.dispose()); jest.useRealTimers(); delete global.document; delete global.window; });

function setup() {
  const element = (tag) => {
    const el = createElement(tag);
    el.append = (...children) => children.forEach((child) => el.appendChild(child));
    return el;
  };
  global.document = createDocument({ createElementOverride: element });
  document.removeEventListener = jest.fn();
  global.window = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
  const host = element('section');
  const hint = element('div');
  hint.hidden = true;
  const explore = element('button');
  const dismiss = element('button');
  hint.querySelector = (selector) => selector.includes('explore') ? explore : dismiss;
  const toggle = element('button');
  toggle.setRect({ width: 30, height: 30, right: 800, bottom: 70 });
  let tab = { id: 7, url: 'https://example.test/' };
  let state = { open: false, busy: false, suppressed: false };
  const tools = ['search_flights', 'book_table', 'read_order', 'cancel_order'].map((name) => ({ name, description: `Description for ${name}` }));
  const discover = jest.fn(async () => ({ ok: true, url: tab.url, tools }));
  const onSelect = jest.fn();
  const openPanel = jest.fn(() => { state.open = true; });
  const storage = { getItem: jest.fn(() => '[]'), setItem: jest.fn() };
  const view = createPageActions({ host, hint, toggle, getTab: () => tab, getState: () => state, discover, onSelect, openPanel, storage });
  views.push(view);
  return { view, host, hint, explore, dismiss, discover, tools, onSelect, storage, state,
    setTab: (value) => { tab = value; }, buttons: () => host.children[1].children };
}

test('discovery offers three actions, expands, and shows the hint only once per site', async () => {
  const s = setup();
  await flush();
  expect(s.hint.hidden).toBe(false);
  expect(s.buttons()).toHaveLength(3);
  expect(s.buttons()[0].textContent).toBe('Search flights');
  s.host.children[2].dispatch('click');
  expect(s.buttons()).toHaveLength(4);
  s.explore.dispatch('click');
  expect(s.hint.hidden).toBe(true);
  s.state.open = false;
  s.view.render();
  expect(s.hint.hidden).toBe(true);
  expect(s.onSelect).not.toHaveBeenCalled();
});

test('opening sidebar independently exposes actions without showing a hint', async () => {
  const s = setup();
  s.state.open = true;
  await flush();
  expect(s.host.hidden).toBe(false);
  expect(s.hint.hidden).toBe(true);
  s.state.busy = true;
  s.view.render();
  expect(s.buttons().every((button) => button.disabled)).toBe(true);
});

test('click revalidates live action and hands off once, without supplying execution arguments', async () => {
  const s = setup();
  await flush();
  s.buttons()[0].dispatch('click');
  s.buttons()[0].dispatch('click');
  await flush();
  expect(s.onSelect).toHaveBeenCalledTimes(1);
  expect(s.onSelect).toHaveBeenCalledWith(s.tools[0], { id: 7, url: 'https://example.test/' });
  expect(pageActionPrompt(s.tools[0], 'https://example.test/')).toContain('Ask what');
});

test('navigation discards in-flight discovery and stale buttons; unsupported pages clear actions', async () => {
  const s = setup();
  await flush();
  const oldButton = s.buttons()[0];
  let finish;
  s.discover.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = s.view.refresh();
  s.setTab({ id: 8, url: 'https://other.test/' });
  await s.view.refresh();
  expect(s.host.hidden).toBe(true);
  oldButton.dispatch('click');
  finish({ ok: true, url: 'https://example.test/', tools: s.tools });
  await pending;
  expect(s.host.hidden).toBe(true);
  expect(s.onSelect).not.toHaveBeenCalled();
  s.setTab({ id: 8, url: 'freedom://home' });
  await s.view.refresh();
  expect(s.hint.hidden).toBe(true);
});

test('removed actions cannot be handed off, and site labels remain plain text', async () => {
  const s = setup();
  s.tools[0].name = '<img src=x onerror=alert(1)>';
  await flush();
  expect(s.buttons()[0].textContent).toContain('<img');
  s.discover.mockResolvedValueOnce({ ok: true, url: 'https://example.test/', tools: [] });
  s.buttons()[0].dispatch('click');
  await flush();
  expect(s.onSelect).not.toHaveBeenCalled();
  expect(s.host.hidden).toBe(true);
});

test('click during background discovery waits before revalidating instead of losing the selection', async () => {
  const s = setup();
  await flush();
  let finish;
  s.discover.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const poll = s.view.refresh();
  s.buttons()[0].dispatch('click');
  await flush();
  expect(s.discover).toHaveBeenCalledTimes(2);
  expect(s.onSelect).not.toHaveBeenCalled();
  finish({ ok: true, url: 'https://example.test/', tools: s.tools });
  await poll;
  await flush();
  expect(s.onSelect).toHaveBeenCalledTimes(1);
});
