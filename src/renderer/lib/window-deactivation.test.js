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

describe('onGuestTookKeyboard', () => {
  test('runs the handler on the blur a guest raises inside an active window', async () => {
    const { mod, windowHandlers } = await load({ hasFocus: true });
    const handler = jest.fn();

    mod.onGuestTookKeyboard(handler);
    windowHandlers.blur();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('ignores a real deactivation', async () => {
    const { mod, windowHandlers } = await load({ hasFocus: false });
    const handler = jest.fn();

    mod.onGuestTookKeyboard(handler);
    windowHandlers.blur();

    expect(handler).not.toHaveBeenCalled();
  });

  test('ignores a blur it cannot classify', async () => {
    // No `document.hasFocus`: the same "cannot tell" case reads as a
    // departure for both halves, so a surface dismisses itself rather than
    // dragging the keyboard back into a window that may be gone.
    const { mod, windowHandlers } = await load();
    const handler = jest.fn();

    mod.onGuestTookKeyboard(handler);
    windowHandlers.blur();

    expect(handler).not.toHaveBeenCalled();
  });

  test('is the exact complement of onWindowDeactivated', async () => {
    for (const hasFocus of [true, false, undefined]) {
      const options = hasFocus === undefined ? undefined : { hasFocus };

      const dismissal = await load(options);
      const dismissed = jest.fn();
      dismissal.mod.onWindowDeactivated(dismissed);
      dismissal.windowHandlers.blur();

      const reclaim = await load(options);
      const reclaimed = jest.fn();
      reclaim.mod.onGuestTookKeyboard(reclaimed);
      reclaim.windowHandlers.blur();

      // Never both, and never neither: one window `blur` always means exactly
      // one of "the user left" and "a guest took the keyboard".
      expect(dismissed.mock.calls.length + reclaimed.mock.calls.length).toBe(1);
    }
  });
});
