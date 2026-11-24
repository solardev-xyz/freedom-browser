/**
 * Browser full screen hides the chrome (#78): the renderer half. The main
 * process reports the window's state; this module flips the body class the
 * stylesheet hides the chrome on, hides an open sidebar and shows the exit
 * hint. Escape is left alone: it stays the page's and the chrome's.
 */

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

async function load({
  platform = 'linux',
  overrides = {},
  early = [],
  earlyFreeMode = [],
  focused = null,
} = {}) {
  jest.resetModules();
  jest.useFakeTimers();

  const hint = createElement('div');
  hint.hidden = true;
  const dragSensor = createElement('div');
  const dragBar = createElement('div');
  const toggle = createElement('button');
  const barToggle = createElement('button');
  const document = createDocument({
    elementsById: {
      'fullscreen-exit-hint': hint,
      'free-mode-sensor': dragSensor,
      'free-mode-bar': dragBar,
      'free-mode-toggle': toggle,
      'free-mode-bar-toggle': barToggle,
    },
  });
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
  let onFreeMode = null;
  let onBar = null;
  const keydown = [];
  const electronAPI = {
    onFullscreenChanged: jest.fn((cb) => {
      onChange = cb;
    }),
    onFreeModeChanged: jest.fn((cb) => {
      onFreeMode = cb;
    }),
    onFreeModeBarChanged: jest.fn((cb) => {
      onBar = cb;
    }),
    revealFreeModeBar: jest.fn(),
    dragFreeModeBar: jest.fn(),
    maximizeWindow: jest.fn(),
    toggleFreeMode: jest.fn(),
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
  earlyFreeMode.forEach((state) => onFreeMode(state));
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
    dragSensor,
    dragBar,
    toggle,
    barToggle,
    bar: (state) => onBar(state),
    body: document.body,
    electronAPI,
    setSidebarConcealed,
    closeMenus,
    addressInput,
    pageControl,
    change: (state) => onChange(state),
    freeMode: (state) => onFreeMode(state),
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

describe('Free Mode', () => {
  test('hides the chrome as full screen does, with no hint in the shot', async () => {
    const t = await load({ platform: 'darwin' });
    t.freeMode(true);
    expect(t.body.classList.contains('browser-fullscreen')).toBe(true);
    expect(t.body.classList.contains('browser-free-mode')).toBe(true);
    expect(t.mod.isFreeMode()).toBe(true);
    expect(t.mod.isBrowserFullscreen()).toBe(false);
    expect(t.setSidebarConcealed).toHaveBeenLastCalledWith(true);
    expect(t.hint.hidden).toBe(true);

    t.freeMode(false);
    expect(t.body.classList.contains('browser-fullscreen')).toBe(false);
    expect(t.body.classList.contains('browser-free-mode')).toBe(false);
    expect(t.setSidebarConcealed).toHaveBeenLastCalledWith(false);
  });

  test('full screen on top keeps the chrome hidden on the way back out', async () => {
    const t = await load();
    t.freeMode(true);
    t.change(true);
    expect(t.body.classList.contains('browser-free-mode')).toBe(false);
    expect(t.hint.textContent).toBe('Press F11 to exit full screen');
    t.change(false);
    expect(t.body.classList.contains('browser-fullscreen')).toBe(true);
    expect(t.body.classList.contains('browser-free-mode')).toBe(true);
    expect(t.setSidebarConcealed).toHaveBeenCalledTimes(1);
  });

  test('a report before init is held', async () => {
    const t = await load({ earlyFreeMode: [true] });
    expect(t.body.classList.contains('browser-free-mode')).toBe(true);
  });

  test('pointing at the top edge asks main for the bar, only in Free Mode', async () => {
    const t = await load();
    t.dragSensor.dispatch('mouseenter');
    expect(t.electronAPI.revealFreeModeBar).not.toHaveBeenCalled();
    t.freeMode(true);
    t.dragSensor.dispatch('mouseenter');
    expect(t.electronAPI.revealFreeModeBar).toHaveBeenCalledTimes(1);
  });

  test('the bar follows main: shown on reveal, folded the moment main says', async () => {
    const t = await load();
    t.freeMode(true);
    t.bar(true);
    expect(t.dragBar.classList.contains('revealed')).toBe(true);
    t.bar(false);
    expect(t.dragBar.classList.contains('revealed')).toBe(false);
  });

  test('a late reveal after leaving Free Mode shows nothing', async () => {
    const t = await load();
    t.bar(true);
    expect(t.dragBar.classList.contains('revealed')).toBe(false);
  });

  test('leaving Free Mode takes the bar down at once', async () => {
    const t = await load();
    t.freeMode(true);
    t.bar(true);
    t.freeMode(false);
    expect(t.dragBar.classList.contains('revealed')).toBe(false);
  });

  test('both toggles, in the tab strip and in the bar, switch Free Mode', async () => {
    const t = await load();
    t.toggle.dispatch('click');
    t.barToggle.dispatch('click');
    expect(t.electronAPI.toggleFreeMode).toHaveBeenCalledTimes(2);
  });

  describe('dragging the bar', () => {
    const page = { closest: () => null };
    const toggleTarget = { closest: () => ({}) };

    test('reports start, moves and end; the pointer is captured', async () => {
      const t = await load();
      t.freeMode(true);
      t.bar(true);
      t.dragBar.setPointerCapture = jest.fn();
      t.dragBar.dispatch('pointermove', { target: page });
      t.dragBar.dispatch('pointerdown', { button: 0, pointerId: 7, target: page });
      t.dragBar.dispatch('pointermove', { target: page });
      t.dragBar.dispatch('pointermove', { target: page });
      t.dragBar.dispatch('pointerup', { target: page });
      t.dragBar.dispatch('lostpointercapture', { target: page });
      expect(t.dragBar.setPointerCapture).toHaveBeenCalledWith(7);
      expect(t.electronAPI.dragFreeModeBar.mock.calls).toEqual([
        ['start'],
        ['move'],
        ['move'],
        ['end'],
      ]);
    });

    test('not from the toggle or another button', async () => {
      const t = await load();
      t.freeMode(true);
      t.dragBar.dispatch('pointerdown', { button: 0, target: toggleTarget });
      t.dragBar.dispatch('pointerdown', { button: 2, target: page });
      expect(t.electronAPI.dragFreeModeBar).not.toHaveBeenCalled();
    });

    test('ends when the bar folds', async () => {
      const t = await load();
      t.freeMode(true);
      t.bar(true);
      t.dragBar.dispatch('pointerdown', { button: 0, target: page });
      t.freeMode(false);
      t.bar(false);
      expect(t.electronAPI.dragFreeModeBar).toHaveBeenLastCalledWith('end');
    });

    test('a double click zooms the window, as on a title bar', async () => {
      const t = await load();
      t.dragBar.dispatch('dblclick', { target: page });
      t.dragBar.dispatch('dblclick', { target: toggleTarget });
      expect(t.electronAPI.maximizeWindow).toHaveBeenCalledTimes(1);
    });
  });
});

