const { bindExplorerLink } = require('./explorer-link.js');

function fakeAnchor() {
  const listeners = {};
  return {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire(type, init = {}) {
      const event = { type, button: 0, defaultPrevented: false, ...init };
      event.preventDefault = () => { event.defaultPrevented = true; };
      for (const fn of listeners[type] || []) fn(event);
      return event;
    },
  };
}

describe('bindExplorerLink', () => {
  const URL = 'https://gnosisscan.io/tx/0xabc';

  test('a plain click opens a foreground tab instead of a popup', () => {
    const a = fakeAnchor();
    const open = jest.fn();
    bindExplorerLink(a, () => URL, open);
    expect(a.fire('click').defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(URL, { background: false });
  });

  test('a middle-click (auxclick, never click) opens a background tab', () => {
    const a = fakeAnchor();
    const open = jest.fn();
    bindExplorerLink(a, () => URL, open);
    expect(a.fire('auxclick', { button: 1 }).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(URL, { background: true });
  });

  test('a right-button auxclick is not an activation', () => {
    const a = fakeAnchor();
    const open = jest.fn();
    bindExplorerLink(a, () => URL, open);
    expect(a.fire('auxclick', { button: 2 }).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  test.each([
    [{ ctrlKey: true }, true],
    [{ metaKey: true }, true],
    [{ ctrlKey: true, shiftKey: true }, false],
  ])('modifier click %o → background %s', (mods, background) => {
    const a = fakeAnchor();
    const open = jest.fn();
    bindExplorerLink(a, () => URL, open);
    a.fire('click', mods);
    expect(open).toHaveBeenCalledWith(URL, { background });
  });

  test('a placeholder or missing URL opens nothing but still suppresses the popup', () => {
    for (const url of ['#', '', null, undefined]) {
      const a = fakeAnchor();
      const open = jest.fn();
      bindExplorerLink(a, () => url, open);
      expect(a.fire('click').defaultPrevented).toBe(true);
      expect(a.fire('auxclick', { button: 1 }).defaultPrevented).toBe(true);
      expect(open).not.toHaveBeenCalled();
    }
  });

  test('a missing anchor is a no-op', () => {
    expect(() => bindExplorerLink(null, () => URL, jest.fn())).not.toThrow();
  });
});
