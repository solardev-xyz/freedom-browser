/**
 * Tests for guest main-frame attribution of <webview> ipc-message events
 * (security audit O-6, #433). The provider suites drive this through their
 * real ipc-message listeners; this file pins the matcher's edge cases.
 */

const { createElement } = require('../../../test/helpers/fake-dom.js');

let trackGuestMainFrame;
let isFromGuestMainFrame;

beforeAll(async () => {
  ({ trackGuestMainFrame, isFromGuestMainFrame } = await import('./guest-main-frame.js'));
});

const commit = (webview, frameProcessId, frameRoutingId, isMainFrame = true) =>
  webview.dispatch('did-frame-navigate', { isMainFrame, frameProcessId, frameRoutingId });

describe('guest-main-frame', () => {
  test('matches only the committed main frame pair', () => {
    const webview = createElement('webview');
    trackGuestMainFrame(webview);
    commit(webview, 7, 4);

    expect(isFromGuestMainFrame(webview, { frameId: [7, 4] })).toBe(true);
    expect(isFromGuestMainFrame(webview, { frameId: [7, 5] })).toBe(false);
    expect(isFromGuestMainFrame(webview, { frameId: [8, 4] })).toBe(false);
  });

  test('rejects malformed or missing frame ids', () => {
    const webview = createElement('webview');
    trackGuestMainFrame(webview);
    commit(webview, 7, 4);

    for (const frameId of [undefined, null, 7, '7,4', [7], [7, 4, 0], ['7', '4'], [7.5, 4]]) {
      expect(isFromGuestMainFrame(webview, { frameId })).toBe(false);
    }
    expect(isFromGuestMainFrame(webview, undefined)).toBe(false);
  });

  test('fails closed before any main-frame commit and for untracked webviews', () => {
    const tracked = createElement('webview');
    trackGuestMainFrame(tracked);
    commit(tracked, 8, 5, false);
    expect(isFromGuestMainFrame(tracked, { frameId: [8, 5] })).toBe(false);

    const untracked = createElement('webview');
    expect(isFromGuestMainFrame(untracked, { frameId: [7, 4] })).toBe(false);
  });

  test('a commit event without ids never matches', () => {
    const webview = createElement('webview');
    trackGuestMainFrame(webview);
    webview.dispatch('did-frame-navigate', { isMainFrame: true });
    expect(isFromGuestMainFrame(webview, { frameId: [undefined, undefined] })).toBe(false);
  });

  test('tracking twice registers one listener', () => {
    const webview = createElement('webview');
    const spy = jest.spyOn(webview, 'addEventListener');
    trackGuestMainFrame(webview);
    trackGuestMainFrame(webview);
    expect(spy.mock.calls.filter(([name]) => name === 'did-frame-navigate')).toHaveLength(1);
  });
});
