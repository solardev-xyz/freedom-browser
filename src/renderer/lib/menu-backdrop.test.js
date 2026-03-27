describe('menu-backdrop', () => {
  const originalDocument = global.document;

  const loadModule = async (backdrop) => {
    jest.resetModules();
    global.document = {
      getElementById: jest.fn((id) => (id === 'menu-backdrop' ? backdrop : null)),
    };
    return import('./menu-backdrop.js');
  };

  afterEach(() => {
    global.document = originalDocument;
  });

  test('initializes the backdrop and closes menus on mousedown', async () => {
    const closeAllMenus = jest.fn();
    let mousedownHandler = null;
    const backdrop = {
      addEventListener: jest.fn((event, handler) => {
        if (event === 'mousedown') {
          mousedownHandler = handler;
        }
      }),
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
      },
    };

    const mod = await loadModule(backdrop);
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
    const mod = await loadModule(null);

    expect(() => {
      mod.initMenuBackdrop(jest.fn());
      mod.showMenuBackdrop();
      mod.hideMenuBackdrop();
    }).not.toThrow();
  });
});
