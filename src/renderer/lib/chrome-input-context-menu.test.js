const originalWindow = global.window;
const originalDocument = global.document;
const originalNavigator = global.navigator;

const createClassList = (initialClasses = []) => {
  const classes = new Set(initialClasses);
  return {
    add: jest.fn((className) => classes.add(className)),
    remove: jest.fn((className) => classes.delete(className)),
    contains: jest.fn((className) => classes.has(className)),
  };
};

const createMenuItem = (action) => ({
  dataset: { action },
  disabled: false,
  closest: jest.fn((selector) => (selector === '.context-menu-item' ? createMenuItem(action) : null)),
});

const createInput = (value = 'hello world') => {
  let selectionStart = 0;
  let selectionEnd = 5;
  const handlers = {};

  const input = {
    value,
    selectionStart,
    selectionEnd,
    focus: jest.fn(),
    select: jest.fn(function selectAll() {
      const end = this.value.length;
      this.setSelectionRange(0, end);
    }),
    setSelectionRange: jest.fn((start, end) => {
      selectionStart = start;
      selectionEnd = end;
      input.selectionStart = start;
      input.selectionEnd = end;
    }),
    dispatchEvent: jest.fn(),
    addEventListener: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    handlers,
  };

  Object.defineProperty(input, 'selectionStart', {
    get: () => selectionStart,
    set: (v) => {
      selectionStart = v;
    },
  });
  Object.defineProperty(input, 'selectionEnd', {
    get: () => selectionEnd,
    set: (v) => {
      selectionEnd = v;
    },
  });

  return input;
};

const createContextMenu = () => {
  const handlers = {};
  const items = {
    cut: createMenuItem('cut'),
    copy: createMenuItem('copy'),
    paste: createMenuItem('paste'),
    'select-all': createMenuItem('select-all'),
  };

  return {
    handlers,
    classList: createClassList(['hidden']),
    style: {},
    querySelector: jest.fn((selector) => items[selector.match(/data-action="([^"]+)"/)[1]]),
    addEventListener: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    getBoundingClientRect: jest.fn(() => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    })),
    items,
  };
};

const loadModule = async ({ input, contextMenu, electronAPI } = {}) => {
  jest.resetModules();

  const addressInput = input ?? createInput();
  const menu = contextMenu ?? createContextMenu();

  const documentHandlers = {};
  global.document = {
    getElementById: jest.fn((id) => {
      if (id === 'address-input') return addressInput;
      if (id === 'chrome-input-context-menu') return menu;
      return null;
    }),
    addEventListener: jest.fn((event, handler) => {
      const existing = documentHandlers[event];
      documentHandlers[event] = existing
        ? (...args) => {
            existing(...args);
            handler(...args);
          }
        : handler;
    }),
  };

  const windowHandlers = {};
  global.window = {
    innerWidth: 800,
    innerHeight: 600,
    electronAPI:
      electronAPI === null
        ? undefined
        : (electronAPI ?? {
            copyText: jest.fn().mockResolvedValue({ success: true }),
            readClipboardText: jest.fn().mockResolvedValue({ success: true, text: 'pasted' }),
          }),
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };

  global.navigator = {
    clipboard: {
      writeText: jest.fn().mockResolvedValue(undefined),
      readText: jest.fn().mockResolvedValue('pasted'),
    },
  };

  jest.doMock('./menu-backdrop.js', () => ({
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  }));

  const mod = await import('./chrome-input-context-menu.js');
  mod.initChromeInputContextMenu();
  return { mod, input: addressInput, menu, documentHandlers, windowHandlers };
};

const openContextMenu = (
  input,
  { collapseSelectionOnOpen = false, skipMousedown = false } = {}
) => {
  if (!skipMousedown) {
    input.handlers.mousedown?.({ button: 2 });
  }
  if (collapseSelectionOnOpen) {
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
  }
  input.handlers.contextmenu({
    preventDefault: jest.fn(),
    clientX: 10,
    clientY: 10,
  });
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const clickMenu = async (menu, action) => {
  const item = menu.items[action];
  item.closest.mockReturnValue(item);
  menu.handlers.click({
    target: item,
  });
  await flushMicrotasks();
};

describe('chrome-input-context-menu', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.navigator = originalNavigator;
    jest.clearAllMocks();
  });

  test('copy writes saved selection via clipboard API', async () => {
    const { input, menu } = await loadModule();
    openContextMenu(input);
    await clickMenu(menu, 'copy');

    expect(window.electronAPI.copyText).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('hello world');
  });

  test('cut removes selected text and writes to clipboard', async () => {
    const { input, menu } = await loadModule();
    openContextMenu(input);
    await clickMenu(menu, 'cut');

    expect(window.electronAPI.copyText).toHaveBeenCalledWith('hello');
    expect(input.value).toBe(' world');
  });

  test('paste inserts clipboard text at saved caret position', async () => {
    const input = createInput('hello world');
    input.setSelectionRange(6, 6);
    const { menu } = await loadModule({ input });

    openContextMenu(input);
    await clickMenu(menu, 'paste');

    expect(window.electronAPI.readClipboardText).toHaveBeenCalled();
    expect(input.value).toBe('hello pastedworld');
  });

  test('falls back to navigator clipboard write when electron copy is unavailable', async () => {
    const { input, menu } = await loadModule({ electronAPI: null });
    openContextMenu(input);
    await clickMenu(menu, 'copy');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
  });

  test('copy uses selection captured on right mousedown when contextmenu collapses it', async () => {
    const input = createInput('copy-via-menu-69');
    input.setSelectionRange(0, input.value.length);
    const { menu } = await loadModule({ input });

    openContextMenu(input, { collapseSelectionOnOpen: true });
    await clickMenu(menu, 'copy');

    expect(window.electronAPI.copyText).toHaveBeenCalledWith('copy-via-menu-69');
  });

  test('falls back to navigator clipboard read when electron read is unavailable', async () => {
    const input = createInput('hello world');
    input.setSelectionRange(6, 6);
    const { menu } = await loadModule({ input, electronAPI: null });

    openContextMenu(input);
    await clickMenu(menu, 'paste');

    expect(navigator.clipboard.readText).toHaveBeenCalled();
    expect(input.value).toBe('hello pastedworld');
  });

  // The other half of the main-process handlers' `{ success, error }` contract:
  // a clipboard failure has to come back as a resolved falsy `success` so this
  // fallback runs. If the handler let the rejection escape as an
  // `ipcRenderer.invoke` rejection instead, `readClipboard` would throw out of
  // the `void runEditAction(...)` call and Paste would silently do nothing.
  test('falls back to navigator clipboard read when the electron read reports failure', async () => {
    const input = createInput('hello world');
    input.setSelectionRange(6, 6);
    const { menu } = await loadModule({
      input,
      electronAPI: {
        copyText: jest.fn().mockResolvedValue({ success: true }),
        readClipboardText: jest
          .fn()
          .mockResolvedValue({ success: false, error: 'clipboard unavailable' }),
      },
    });

    openContextMenu(input);
    await clickMenu(menu, 'paste');

    expect(window.electronAPI.readClipboardText).toHaveBeenCalled();
    expect(navigator.clipboard.readText).toHaveBeenCalled();
    expect(input.value).toBe('hello pastedworld');
  });

  test('paste uses live caret when right-click did not capture a range', async () => {
    const input = createInput('abcdef');
    // User clicks at caret position 3 with no selection; the right-click
    // mousedown captures the live caret rather than a stale earlier range.
    input.setSelectionRange(3, 3);
    const { menu } = await loadModule({ input });

    openContextMenu(input);
    await clickMenu(menu, 'paste');

    expect(input.value).toBe('abcpasteddef');
    expect(input.selectionStart).toBe(3 + 'pasted'.length);
    expect(input.selectionEnd).toBe(3 + 'pasted'.length);
  });

  test('paste honors live caret when contextmenu fires without prior mousedown', async () => {
    const input = createInput('abcdef');
    input.setSelectionRange(2, 2);
    const { menu } = await loadModule({ input });

    openContextMenu(input, { skipMousedown: true });
    await clickMenu(menu, 'paste');

    expect(input.value).toBe('abpastedcdef');
  });

  test('orphaned right-mousedown is cleared by the post-gesture document mouseup', async () => {
    jest.useFakeTimers();
    try {
      const input = createInput('abcdef');
      input.setSelectionRange(0, 3);
      const { menu, documentHandlers } = await loadModule({ input });

      // User right-mousedown inside the input captures [0, 3].
      input.handlers.mousedown({ button: 2 });

      // User released the right button outside the input: no contextmenu
      // on our input, but the document still sees the mouseup, which
      // schedules a deferred clear of the orphaned snapshot.
      documentHandlers.mouseup();
      jest.runAllTimers();

      // Later, the caret moves and the menu opens via the keyboard menu
      // key (no mousedown precedes the contextmenu).
      input.setSelectionRange(5, 5);
      openContextMenu(input, { skipMousedown: true });

      await clickMenu(menu, 'paste');
      expect(input.value).toBe('abcdepastedf');
    } finally {
      jest.useRealTimers();
    }
  });

  test('document mouseup defer does not pre-empt a same-gesture contextmenu', async () => {
    jest.useFakeTimers();
    try {
      const input = createInput('abcdef');
      input.setSelectionRange(0, 3);
      const { menu, documentHandlers } = await loadModule({ input });

      // Real-world gesture: right-mousedown, then mouseup, then contextmenu
      // are dispatched in separate event tasks. The mouseup-scheduled
      // clear must not run before the contextmenu consumes the snapshot.
      input.handlers.mousedown({ button: 2 });
      documentHandlers.mouseup();
      // Browser collapses the selection before contextmenu fires.
      input.setSelectionRange(input.value.length, input.value.length);
      openContextMenu(input, { skipMousedown: true });
      jest.runAllTimers();

      await clickMenu(menu, 'copy');
      expect(window.electronAPI.copyText).toHaveBeenCalledWith('abc');
    } finally {
      jest.useRealTimers();
    }
  });

  test('non-right mousedown clears the captured snapshot', async () => {
    const input = createInput('abcdef');
    input.setSelectionRange(0, 3);
    const { menu } = await loadModule({ input });

    input.handlers.mousedown({ button: 2 });
    // A subsequent left click invalidates the prior right-mousedown snapshot.
    input.handlers.mousedown({ button: 0 });
    input.setSelectionRange(4, 4);

    openContextMenu(input, { skipMousedown: true });
    await clickMenu(menu, 'paste');
    expect(input.value).toBe('abcdpastedef');
  });

  test('input blur clears the captured snapshot', async () => {
    const input = createInput('abcdef');
    input.setSelectionRange(0, 3);
    const { menu } = await loadModule({ input });

    input.handlers.mousedown({ button: 2 });
    input.handlers.blur?.();
    input.setSelectionRange(2, 2);

    openContextMenu(input, { skipMousedown: true });
    await clickMenu(menu, 'paste');
    expect(input.value).toBe('abpastedcdef');
  });

  test('long right-button hold still uses the captured selection', async () => {
    // Reviewer regression: the previous 500ms freshness heuristic
    // discarded valid right-click selections if the user held the
    // button for more than half a second.
    const input = createInput('abcdef');
    input.setSelectionRange(0, 3);
    const { menu } = await loadModule({ input });

    input.handlers.mousedown({ button: 2 });
    // Browser collapses the selection between mousedown and contextmenu
    // on a slow gesture (held button or system pause); no document
    // mouseup fires until the user releases the button.
    input.setSelectionRange(input.value.length, input.value.length);
    openContextMenu(input, { skipMousedown: true });

    await clickMenu(menu, 'copy');
    expect(window.electronAPI.copyText).toHaveBeenCalledWith('abc');
  });

  test('disabled menu items are ignored', async () => {
    const input = createInput('');
    input.setSelectionRange(0, 0);
    const { menu } = await loadModule({ input });
    openContextMenu(input);

    expect(menu.items.cut.disabled).toBe(true);
    expect(menu.items.copy.disabled).toBe(true);
    expect(menu.items['select-all'].disabled).toBe(true);
    expect(menu.items.paste.disabled).toBe(false);

    await clickMenu(menu, 'copy');
    expect(window.electronAPI.copyText).not.toHaveBeenCalled();
  });

  test('cut leaves text untouched when clipboard write fails', async () => {
    const input = createInput('hello world');
    const { menu } = await loadModule({
      input,
      electronAPI: {
        copyText: jest.fn().mockResolvedValue({ success: false }),
        readClipboardText: jest.fn().mockResolvedValue({ success: true, text: '' }),
      },
    });
    navigator.clipboard.writeText.mockRejectedValueOnce(new Error('denied'));

    openContextMenu(input);
    await clickMenu(menu, 'cut');

    expect(input.value).toBe('hello world');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
    expect(input.dispatchEvent).not.toHaveBeenCalled();
  });

  test('select-all preserves the full selection without dispatching input', async () => {
    const input = createInput('select-me');
    input.setSelectionRange(0, 0);
    const { menu } = await loadModule({ input });

    openContextMenu(input);
    await clickMenu(menu, 'select-all');

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('select-me'.length);
    // No synthetic input event - listeners must not reset the range.
    expect(input.dispatchEvent).not.toHaveBeenCalled();
  });

  test('Escape hides the menu', async () => {
    const { input, menu, documentHandlers } = await loadModule();
    openContextMenu(input);
    expect(menu.classList.contains('hidden')).toBe(false);

    documentHandlers.keydown({ key: 'Escape' });
    expect(menu.classList.contains('hidden')).toBe(true);
  });

  test('Window blur hides the menu', async () => {
    const { input, menu, windowHandlers } = await loadModule();
    openContextMenu(input);
    expect(menu.classList.contains('hidden')).toBe(false);

    windowHandlers.blur();
    expect(menu.classList.contains('hidden')).toBe(true);
  });

  test('serializes overlapping actions so paste cannot race a follow-up cut', async () => {
    const input = createInput('hello world');
    let resolveRead;
    const readClipboardText = jest.fn(
      () => new Promise((resolve) => { resolveRead = resolve; })
    );
    const { menu } = await loadModule({
      input,
      electronAPI: {
        copyText: jest.fn().mockResolvedValue({ success: true }),
        readClipboardText,
      },
    });

    input.setSelectionRange(5, 5);
    openContextMenu(input);
    // Start a slow paste; do not await yet.
    menu.handlers.click({ target: menu.items.paste });

    // Reopen and try to cut while paste is still pending.
    openContextMenu(input);
    menu.handlers.click({ target: menu.items.cut });
    await flushMicrotasks();

    // Cut must not have run against the stale range.
    expect(window.electronAPI.copyText).not.toHaveBeenCalled();

    // Let paste complete.
    resolveRead({ success: true, text: 'X' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(input.value).toBe('helloX world');
  });
});
