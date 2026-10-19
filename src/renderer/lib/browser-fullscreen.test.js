/**
 * Browser full screen hides the chrome (#78): the renderer half. The main
 * process reports the window's state; this module flips the body class the
 * stylesheet hides the chrome on, hides an open sidebar and shows the exit
 * hint. Escape is left alone: it stays the page's and the chrome's.
 */

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

async function load({ platform = 'linux', overrides = {}, early = [], focused = null } = {}) {
  jest.resetModules();
  jest.useFakeTimers();

  const hint = createElement('div');
  hint.hidden = true;
  const document = createDocument({ elementsById: { 'fullscreen-exit-hint': hint } });
  global.document = document;
  // A toolbar holding one control, and where the keyboard is.
  const toolbar = createElement('header');
  const addressInput = createElement('input');
  addressInput.blur = jest.fn();
  toolbar.appendChild(addressInput);
  const pageControl = createElement('div');
  pageControl.blur = jest.fn();
  document.querySelector = jest.fn((selector) => (selector === '.toolbar' ? toolbar : null));
  document.activeElement =
    focused === 'address' ? addressInput : focused === 'other' ? pageControl : document.body;

  let onChange = null;
  const keydown = [];
  const electronAPI = {
    onFullscreenChanged: jest.fn((cb) => {
      onChange = cb;
    }),
    toggleFullscreen: jest.fn(),
  };
  global.window = {
    electronAPI,
    addEventListener: jest.fn((type, handler) => {
      if (type === 'keydown') keydown.push(handler);
    }),
  };
  global.navigator = { platform: '', userAgent: '' };

  const shortcuts = await import('./shortcuts.js');
  shortcuts.configureShortcuts({ platform, overrides });
  const mod = await import('./browser-fullscreen.js');
  // index.js listens as soon as its script runs, before start-up's awaits.
  mod.listenForFullscreenChanges();
  early.forEach((state) => onChange(state));
  const setSidebarConcealed = jest.fn();
  const closeMenus = jest.fn();
  mod.initBrowserFullscreen({ setSidebarConcealed, closeMenus, platform });

  const press = (init = {}) => {
    const event = {
      key: 'Escape',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
      ...init,
    };
    keydown.forEach((handler) => handler(event));
    return event;
  };

  return {
    mod,
    hint,
    body: document.body,
    electronAPI,
    setSidebarConcealed,
    closeMenus,
    addressInput,
    pageControl,
    change: (state) => onChange(state),
    press,
  };
}

afterEach(() => {
  jest.useRealTimers();
  delete global.document;
  delete global.window;
  delete global.navigator;
});

describe('following the window into and out of full screen', () => {
  test('entering hides the chrome, the sidebar and any open menu; leaving restores', async () => {
    const t = await load();
    t.change(true);
    expect(t.body.classList.contains('browser-fullscreen')).toBe(true);
    expect(t.mod.isBrowserFullscreen()).toBe(true);
    expect(t.setSidebarConcealed).toHaveBeenLastCalledWith(true);
    expect(t.closeMenus).toHaveBeenCalledTimes(1);

    t.change(false);
    expect(t.body.classList.contains('browser-fullscreen')).toBe(false);
    expect(t.mod.isBrowserFullscreen()).toBe(false);
    expect(t.setSidebarConcealed).toHaveBeenLastCalledWith(false);
  });

  test('a repeated report of the same state changes nothing', async () => {
    const t = await load();
    t.change(false);
    expect(t.setSidebarConcealed).not.toHaveBeenCalled();
    t.change(true);
    t.change(true);
    expect(t.setSidebarConcealed).toHaveBeenCalledTimes(1);
    expect(t.closeMenus).toHaveBeenCalledTimes(1);
  });

  test('the exit hint names the live binding and goes away on its own', async () => {
    const t = await load();
    t.change(true);
    expect(t.hint.hidden).toBe(false);
    expect(t.hint.textContent).toBe('Press F11 to exit full screen');
    jest.advanceTimersByTime(t.mod.EXIT_HINT_MS);
    expect(t.hint.hidden).toBe(true);
  });

  test('the hint follows a remap and the platform format', async () => {
    const t = await load({ platform: 'darwin', overrides: { 'view.fullscreen': 'Cmd+Ctrl+F' } });
    t.change(true);
    expect(t.hint.textContent).toBe('Press ⌃⌘F to exit full screen');
  });

  test('leaving takes the hint down at once', async () => {
    const t = await load();
    t.change(true);
    t.change(false);
    expect(t.hint.hidden).toBe(true);
  });
});

// R2-M1: the toolbar folds away but stays focusable, and comes back while it
// holds focus (fullscreen.css), so Ctrl+L / a new tab's address bar can be
// typed into. Entering from inside it must not keep it on screen.
describe('focus on entering', () => {
  test('leaves the toolbar', async () => {
    const t = await load({ focused: 'address' });
    t.change(true);
    expect(t.addressInput.blur).toHaveBeenCalledTimes(1);
  });

  test('is left where it is when it is not in the toolbar', async () => {
    const t = await load({ focused: 'other' });
    t.change(true);
    expect(t.pageControl.blur).not.toHaveBeenCalled();
  });

  test('is left alone on leaving', async () => {
    const t = await load();
    t.change(true);
    document.activeElement = t.addressInput;
    t.change(false);
    expect(t.addressInput.blur).not.toHaveBeenCalled();
  });
});

describe('a report that arrives before start-up reaches init', () => {
  test('is held and applied on init, not lost', async () => {
    const t = await load({ early: [true] });
    expect(t.electronAPI.onFullscreenChanged).toHaveBeenCalledTimes(1);
    expect(t.body.classList.contains('browser-fullscreen')).toBe(true);
    expect(t.setSidebarConcealed).toHaveBeenLastCalledWith(true);
    expect(t.hint.hidden).toBe(false);
  });

  test('only the latest one counts', async () => {
    const t = await load({ early: [true, false] });
    expect(t.body.classList.contains('browser-fullscreen')).toBe(false);
    expect(t.setSidebarConcealed).not.toHaveBeenCalled();
  });
});

describe('Escape', () => {
  test("is not claimed: it stays the page's and the chrome's (#78 review)", async () => {
    const t = await load();
    t.change(true);
    const event = t.press();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(t.electronAPI.toggleFullscreen).not.toHaveBeenCalled();
    expect(t.mod.isBrowserFullscreen()).toBe(true);
  });
});
