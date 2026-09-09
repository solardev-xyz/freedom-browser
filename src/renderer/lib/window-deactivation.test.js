// The one rule that tells "the user left the window" apart from "a <webview>
// guest took the keyboard" (#328).

const originalWindow = global.window;
const originalDocument = global.document;

const load = async ({ hasFocus } = {}) => {
  jest.resetModules();

  const windowHandlers = {};
  global.window = {
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };
  global.document = hasFocus === undefined ? {} : { hasFocus: jest.fn(() => hasFocus) };

  const mod = await import('./window-deactivation.js');
  return { mod, windowHandlers, document: global.document };
};

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
});

describe('onWindowDeactivated', () => {
  test('runs the handler when the window really lost focus', async () => {
    const { mod, windowHandlers } = await load({ hasFocus: false });
    const handler = jest.fn();

    mod.onWindowDeactivated(handler);
    expect(typeof windowHandlers.blur).toBe('function');

    windowHandlers.blur();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('ignores the blur a <webview> guest raises while the window stays focused', async () => {
    // The bug this module exists for: every tab activation hands the page
    // focus (#304) and the guest's ack lands asynchronously, so this `blur`
    // can arrive after the user has opened a menu. `document.hasFocus()` is
    // still true — the window never went anywhere.
    const { mod, windowHandlers, document } = await load({ hasFocus: true });
    const handler = jest.fn();

    mod.onWindowDeactivated(handler);
    windowHandlers.blur();

    expect(document.hasFocus).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test('falls back to dismissing when the environment has no hasFocus()', async () => {
    // The renderer unit-test harnesses build a bare `document`. "Cannot tell"
    // must fail towards the dismissal, never towards a surface that can never
    // be closed.
    const { mod, windowHandlers } = await load();
    const handler = jest.fn();

    mod.onWindowDeactivated(handler);
    windowHandlers.blur();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
