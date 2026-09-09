describe('menu-backdrop', () => {
  const originalDocument = global.document;
  const originalWindow = global.window;

  // `hasFocus` decides which half of the window `blur` fires: `true` is a
  // `<webview>` guest taking the keyboard while the window stays active,
  // `false` is the user actually leaving the window (#328).
  const loadModule = async (backdrop, { hasFocus = true, activeElement = null } = {}) => {
    jest.resetModules();
    const documentHandlers = {};
    const windowHandlers = {};
    global.document = {
      getElementById: jest.fn((id) => (id === 'menu-backdrop' ? backdrop : null)),
      addEventListener: jest.fn((event, handler) => {
        documentHandlers[event] = handler;
      }),
      hasFocus: jest.fn(() => hasFocus),
      activeElement,
      body: { tagName: 'BODY' },
    };
    global.window = {
      addEventListener: jest.fn((event, handler) => {
        windowHandlers[event] = handler;
      }),
    };
    const mod = await import('./menu-backdrop.js');
    return { mod, documentHandlers, windowHandlers };
  };

  const makeBackdrop = ({ hidden = true } = {}) => {
    const classes = new Set(hidden ? ['hidden'] : []);
    return {
      addEventListener: jest.fn(),
      classList: {
        add: jest.fn((name) => classes.add(name)),
        remove: jest.fn((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
      },
    };
  };

  // The reclaim is deferred by one turn of the event loop (the guest's focus
  // is still in flight when the `blur` fires), so every assertion about it
  // runs the pending timer first.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    global.document = originalDocument;
    global.window = originalWindow;
  });

  const settle = () => jest.runOnlyPendingTimers();

  test('initializes the backdrop and closes menus on mousedown', async () => {
    const closeAllMenus = jest.fn();
    let mousedownHandler = null;
    const backdrop = makeBackdrop();
    backdrop.addEventListener = jest.fn((event, handler) => {
      if (event === 'mousedown') {
        mousedownHandler = handler;
      }
    });

    const { mod } = await loadModule(backdrop);
    mod.initMenuBackdrop(closeAllMenus);
    mod.showMenuBackdrop();
    mod.hideMenuBackdrop();
    mousedownHandler();

    expect(backdrop.addEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function));
    expect(backdrop.classList.remove).toHaveBeenCalledWith('hidden');
    expect(backdrop.classList.add).toHaveBeenCalledWith('hidden');
    expect(closeAllMenus).toHaveBeenCalled();
  });

  test('handles missing backdrop elements safely', async () => {
    const { mod, windowHandlers } = await loadModule(null);

    expect(() => {
      mod.initMenuBackdrop(jest.fn());
      mod.showMenuBackdrop();
      mod.hideMenuBackdrop();
      windowHandlers.blur();
      settle();
    }).not.toThrow();
  });

  test('takes the keyboard back when a guest grabs it under an open surface', async () => {
    const backdrop = makeBackdrop();
    const { mod, documentHandlers, windowHandlers } = await loadModule(backdrop);
    mod.initMenuBackdrop(jest.fn());

    const menuButton = { tagName: 'BUTTON', focus: jest.fn(), isConnected: true };
    documentHandlers.focusin({ target: menuButton });
    mod.showMenuBackdrop();

    // The guest's late ack: window `blur`, window still focused, the
    // `<webview>` holding the keyboard.
    global.document.activeElement = { tagName: 'WEBVIEW' };
    windowHandlers.blur();
    settle();

    expect(menuButton.focus).toHaveBeenCalledTimes(1);
  });

  test('leaves the keyboard alone when no surface is up', async () => {
    const backdrop = makeBackdrop();
    const { mod, documentHandlers, windowHandlers } = await loadModule(backdrop);
    mod.initMenuBackdrop(jest.fn());

    const menuButton = { tagName: 'BUTTON', focus: jest.fn(), isConnected: true };
    documentHandlers.focusin({ target: menuButton });

    global.document.activeElement = { tagName: 'WEBVIEW' };
    windowHandlers.blur();
    settle();

    expect(menuButton.focus).not.toHaveBeenCalled();
  });

  test('leaves the keyboard alone when the window really lost focus', async () => {
    const backdrop = makeBackdrop();
    const { mod, documentHandlers, windowHandlers } = await loadModule(backdrop, {
      hasFocus: false,
    });
    mod.initMenuBackdrop(jest.fn());

    const menuButton = { tagName: 'BUTTON', focus: jest.fn(), isConnected: true };
    documentHandlers.focusin({ target: menuButton });
    mod.showMenuBackdrop();

    global.document.activeElement = { tagName: 'WEBVIEW' };
    windowHandlers.blur();

    // Dragging focus back would fight the window the user just switched to;
    // the surfaces dismiss themselves through `onWindowDeactivated` instead.
    expect(menuButton.focus).not.toHaveBeenCalled();
  });

  test('does not undo a click that moved focus inside the chrome', async () => {
    const backdrop = makeBackdrop();
    const { mod, documentHandlers, windowHandlers } = await loadModule(backdrop);
    mod.initMenuBackdrop(jest.fn());

    const menuButton = { tagName: 'BUTTON', focus: jest.fn(), isConnected: true };
    documentHandlers.focusin({ target: menuButton });
    mod.showMenuBackdrop();

    global.document.activeElement = { tagName: 'INPUT', id: 'address-input' };
    windowHandlers.blur();
    settle();

    expect(menuButton.focus).not.toHaveBeenCalled();
  });

  test('never hands the keyboard back to a guest it remembered', async () => {
    const backdrop = makeBackdrop();
    const { mod, documentHandlers, windowHandlers } = await loadModule(backdrop);
    mod.initMenuBackdrop(jest.fn());

    const menuButton = { tagName: 'BUTTON', focus: jest.fn(), isConnected: true };
    documentHandlers.focusin({ target: menuButton });
    // A guest focus is not a chrome focus: remembering it would make the
    // reclaim a no-op that hands the page the keyboard right back.
    const guest = { tagName: 'WEBVIEW', focus: jest.fn(), isConnected: true };
    documentHandlers.focusin({ target: guest });
    mod.showMenuBackdrop();

    global.document.activeElement = guest;
    windowHandlers.blur();
    settle();

    expect(guest.focus).not.toHaveBeenCalled();
    expect(menuButton.focus).toHaveBeenCalledTimes(1);
  });

  test('drops the reclaim when the surface closed while it was deferred', async () => {
    const backdrop = makeBackdrop();
    const { mod, documentHandlers, windowHandlers } = await loadModule(backdrop);
    mod.initMenuBackdrop(jest.fn());

    const menuButton = { tagName: 'BUTTON', focus: jest.fn(), isConnected: true };
    documentHandlers.focusin({ target: menuButton });
    mod.showMenuBackdrop();

    global.document.activeElement = { tagName: 'WEBVIEW' };
    windowHandlers.blur();
    // The row's own handler closed the menu in the meantime: the page is the
    // rightful owner of the keyboard again, so the deferred reclaim must not
    // yank it back out.
    mod.hideMenuBackdrop();
    settle();

    expect(menuButton.focus).not.toHaveBeenCalled();
  });

  test('skips an element that has since left the document', async () => {
    const backdrop = makeBackdrop();
    const { mod, documentHandlers, windowHandlers } = await loadModule(backdrop);
    mod.initMenuBackdrop(jest.fn());

    const row = { tagName: 'BUTTON', focus: jest.fn(), isConnected: false };
    documentHandlers.focusin({ target: row });
    mod.showMenuBackdrop();

    global.document.activeElement = { tagName: 'WEBVIEW' };
    expect(() => {
      windowHandlers.blur();
      settle();
    }).not.toThrow();
    expect(row.focus).not.toHaveBeenCalled();
  });
});
