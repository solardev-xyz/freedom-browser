// Markdown button in the address bar (#1035): it follows the view each tab's
// page reports, only for the active tab, forgets a page that navigated away,
// and asks the page to switch views.

// `var` (not let) avoids the TDZ under jest.mock hoisting.
var mockActiveTab = null;
var mockWebviewCreated = [];
jest.mock('./tabs.js', () => ({
  getActiveTab: jest.fn(() => mockActiveTab),
  onWebviewCreated: jest.fn((listener) => mockWebviewCreated.push(listener)),
}));
jest.mock('./debug.js', () => ({ pushDebug: jest.fn() }));

import { initMarkdownViewUi, getMarkdownView, _resetForTests } from './markdown-view-ui.js';

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const makeTab = (id) => {
  const webview = createElement('webview');
  webview.send = jest.fn();
  for (const listener of mockWebviewCreated) listener(webview);
  return { id, webview };
};

describe('markdown-view-ui', () => {
  let button;
  let doc;
  let tabA;
  let tabB;

  const shown = () => !button.classList.contains('hidden');
  const report = (tab, view) =>
    tab.webview.dispatch('ipc-message', { channel: 'markdown:state', args: [{ view }] });
  const switchTo = (tab) => {
    mockActiveTab = tab;
    doc.handlers['active-tab-changed']();
  };

  beforeEach(() => {
    _resetForTests();
    mockWebviewCreated = [];
    button = createElement('button', { classes: ['hidden'] });
    button.setAttribute('aria-pressed', 'false');
    doc = createDocument({ elementsById: { 'markdown-toggle-btn': button } });
    global.document = doc;
    initMarkdownViewUi();
    tabA = makeTab(1);
    tabB = makeTab(2);
    mockActiveTab = tabA;
  });

  afterEach(() => {
    delete global.document;
  });

  test('hidden until the page reports a rendered Markdown file', () => {
    expect(shown()).toBe(false);
    report(tabA, 'formatted');
    expect(shown()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.title).toBe('Show Markdown source');
  });

  test('pressed, and offering the formatted page, while the source shows', () => {
    report(tabA, 'source');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe('Show formatted page');
  });

  test('ignores other channels and views it does not know', () => {
    tabA.webview.dispatch('ipc-message', { channel: 'link-status:zone', args: [{}] });
    report(tabA, 'raw');
    tabA.webview.dispatch('ipc-message', { channel: 'markdown:state', args: [] });
    expect(shown()).toBe(false);
    expect(getMarkdownView(tabA.webview)).toBeNull();
  });

  test('a background tab is remembered and shown when it becomes active', () => {
    report(tabB, 'source');
    expect(shown()).toBe(false);
    switchTo(tabB);
    expect(shown()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    switchTo(tabA);
    expect(shown()).toBe(false);
  });

  test('a committed navigation forgets the page; a crash does too', () => {
    report(tabA, 'formatted');
    tabA.webview.dispatch('did-navigate', { url: 'https://example.org/' });
    expect(shown()).toBe(false);
    expect(getMarkdownView(tabA.webview)).toBeNull();

    report(tabA, 'formatted');
    tabA.webview.dispatch('render-process-gone', {});
    expect(shown()).toBe(false);
  });

  test('a background navigation leaves the active tab alone', () => {
    report(tabA, 'formatted');
    report(tabB, 'formatted');
    tabB.webview.dispatch('did-navigate', { url: 'https://example.org/' });
    expect(shown()).toBe(true);
    expect(getMarkdownView(tabB.webview)).toBeNull();
  });

  test('a click asks the active page to switch views', () => {
    report(tabA, 'formatted');
    report(tabB, 'formatted');
    button.dispatch('click');
    expect(tabA.webview.send).toHaveBeenCalledWith('markdown:toggle');
    expect(tabB.webview.send).not.toHaveBeenCalled();
  });

  test('a click with no Markdown page sends nothing', () => {
    button.dispatch('click');
    expect(tabA.webview.send).not.toHaveBeenCalled();
  });
});
