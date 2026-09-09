// `onWindowLostFocus` — the blur filter the backdrop-covered chrome menus
// dismiss on. See `window-blur.js` for why a bare `window` `blur` listener is
// the wrong signal.

const originalWindow = global.window;
const originalDocument = global.document;

const loadModule = async () => {
  const handlers = { blur: [] };
  global.window = {
    addEventListener: jest.fn((event, handler) => {
      if (event === 'blur') handlers.blur.push(handler);
    }),
  };
  global.document = { activeElement: null };

  jest.resetModules();
  const mod = await import('./window-blur.js');
  return { ...mod, handlers };
};

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
});

describe('onWindowLostFocus', () => {
  test('dismisses on a blur that leaves the window', async () => {
    const { onWindowLostFocus, handlers } = await loadModule();
    const dismiss = jest.fn();
    onWindowLostFocus(dismiss);

    // Alt-tab / another app: the chrome still holds the focused element.
    global.document.activeElement = { tagName: 'BUTTON', id: 'menu-button' };
    handlers.blur.forEach((fn) => fn({}));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test('ignores the blur a <webview> guest of this window causes', async () => {
    const { onWindowLostFocus, handlers } = await loadModule();
    const dismiss = jest.fn();
    onWindowLostFocus(dismiss);

    // `<webview>.focus()` on a tab activation: the guest takes focus a beat
    // later and blurs the embedder, but the window never lost focus. The real
    // window-level blur arrives from main as `menus:close` instead.
    global.document.activeElement = { tagName: 'WEBVIEW' };
    handlers.blur.forEach((fn) => fn({}));

    expect(dismiss).not.toHaveBeenCalled();
  });

  test('every handler sees one verdict per blur, whatever the registration order', async () => {
    const { onWindowLostFocus, handlers } = await loadModule();
    const firstDismiss = jest.fn();
    const secondDismiss = jest.fn();
    // The first handler takes the keyboard back — synchronously moving
    // `activeElement` off the guest. The second must still read the blur as an
    // in-window one, or the hamburger survives while its flyout collapses.
    onWindowLostFocus(firstDismiss, () => {
      global.document.activeElement = { tagName: 'BUTTON', id: 'menu-button' };
    });
    onWindowLostFocus(secondDismiss);

    global.document.activeElement = { tagName: 'WEBVIEW' };
    const blur = {};
    handlers.blur.forEach((fn) => fn(blur));

    expect(firstDismiss).not.toHaveBeenCalled();
    expect(secondDismiss).not.toHaveBeenCalled();
  });

  test('dismisses when nothing at all is focused', async () => {
    const { onWindowLostFocus, handlers } = await loadModule();
    const dismiss = jest.fn();
    onWindowLostFocus(dismiss);

    // Fail *closed*: an unattributable blur dismisses, as before.
    global.document.activeElement = null;
    handlers.blur.forEach((fn) => fn({}));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
