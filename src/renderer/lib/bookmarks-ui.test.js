const { createDocument, createElement, FakeElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalAlert = global.alert;
const originalConfirm = global.confirm;
const originalPrompt = global.prompt;
const originalRequestAnimationFrame = global.requestAnimationFrame;
const originalResizeObserver = global.ResizeObserver;
const originalHTMLElement = global.HTMLElement;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createResizeObserver = () => {
  const instances = [];
  const ResizeObserver = jest.fn(function ResizeObserver(callback) {
    this.callback = callback;
    this.observe = jest.fn();
    this.disconnect = jest.fn();
    instances.push(this);
  });

  return {
    ResizeObserver,
    instances,
  };
};

const loadBookmarksModule = async (options = {}) => {
  jest.resetModules();

  let storedBookmarks = (options.initialBookmarks || []).map((bookmark) => ({ ...bookmark }));
  const activeTabRef = {
    current: options.activeTab || {
      id: 1,
      title: 'Active Page',
      isLoading: false,
    },
  };
  const resizeObserverState = createResizeObserver();
  const windowHandlers = {};
  const bookmarksBar = createElement('div', {
    classes: ['bookmarks'],
    rect: {
      left: 0,
      top: 0,
      right: 140,
      bottom: 40,
      width: 140,
      height: 40,
    },
  });
  const body = createElement('body');
  body.appendChild(bookmarksBar);
  const addBookmarkBtn = createElement('button', { classes: ['hidden'] });
  const addBookmarkModal = createElement('dialog');
  const addBookmarkForm = createElement('form');
  const closeAddBookmarkBtn = createElement('button');
  const bookmarkLabelInput = createElement('input');
  const bookmarkTargetInput = createElement('input');
  const bookmarkModalTitle = createElement('div');
  const bookmarkSubmitBtn = createElement('button');
  const addressInput = createElement('input', {
    value: options.addressValue || 'https://active.example',
  });
  const webviewElement = createElement('webview');
  const document = createDocument({
    body,
    elementsById: {
      'add-bookmark-btn': addBookmarkBtn,
      'add-bookmark-modal': addBookmarkModal,
      'add-bookmark-form': addBookmarkForm,
      'close-add-bookmark': closeAddBookmarkBtn,
      'bookmark-label': bookmarkLabelInput,
      'bookmark-target': bookmarkTargetInput,
      'bookmark-modal-title': bookmarkModalTitle,
      'bookmark-submit-btn': bookmarkSubmitBtn,
      'address-input': addressInput,
      'bzz-webview': webviewElement,
    },
    createElementOverride: (tagName) => {
      if (tagName === 'button') {
        return createElement(tagName, {
          rect: {
            left: 0,
            top: 0,
            right: 60,
            bottom: 24,
            width: 60,
            height: 24,
          },
        });
      }

      if (tagName === 'div') {
        return createElement(tagName, {
          rect: {
            left: 0,
            top: 0,
            right: 140,
            bottom: 40,
            width: 140,
            height: 40,
          },
        });
      }

      return createElement(tagName);
    },
  });
  const electronAPI = {
    getBookmarks:
      options.getBookmarks ||
      jest.fn().mockImplementation(async () => storedBookmarks.map((bookmark) => ({ ...bookmark }))),
    getCachedFavicon:
      options.getCachedFavicon ||
      jest.fn().mockImplementation(async (target) => options.cachedFavicons?.[target] || null),
    addBookmark:
      options.addBookmark ||
      jest.fn().mockImplementation(async (bookmark) => {
        if (options.addBookmarkResult === false) return false;
        if (storedBookmarks.some((item) => item.target === bookmark.target)) return false;
        storedBookmarks.push({ ...bookmark });
        return true;
      }),
    updateBookmark:
      options.updateBookmark ||
      jest.fn().mockImplementation(async (originalTarget, bookmark) => {
        if (options.updateBookmarkResult === false) return false;
        if (
          storedBookmarks.some(
            (item) => item.target === bookmark.target && item.target !== originalTarget
          )
        ) {
          return false;
        }

        const index = storedBookmarks.findIndex((item) => item.target === originalTarget);
        if (index === -1) return false;
        storedBookmarks[index] = { ...bookmark };
        return true;
      }),
    removeBookmark:
      options.removeBookmark ||
      jest.fn().mockImplementation(async (target) => {
        storedBookmarks = storedBookmarks.filter((item) => item.target !== target);
        return true;
      }),
  };
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const tabsMocks = {
    getActiveTab: jest.fn(() => activeTabRef.current),
    hideTabContextMenu: jest.fn(),
  };
  const menuMocks = {
    closeMenus: jest.fn(),
  };
  const menuBackdropMocks = {
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  };

  addBookmarkModal.showModal = jest.fn();
  addBookmarkModal.close = jest.fn(() => {
    addBookmarkModal.dispatch('close', { target: addBookmarkModal });
  });
  bookmarkLabelInput.focus = jest.fn();
  bookmarkLabelInput.select = jest.fn();

  global.window = {
    electronAPI,
    innerWidth: 500,
    innerHeight: 400,
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };
  global.document = document;
  global.alert = jest.fn();
  global.confirm = jest.fn(() => options.confirmResult ?? true);
  global.prompt = jest.fn(() => options.promptResult ?? null);
  global.requestAnimationFrame = jest.fn((callback) => callback());
  global.ResizeObserver = resizeObserverState.ResizeObserver;
  global.HTMLElement = FakeElement;

  jest.doMock('./debug.js', () => debugMocks);
  jest.doMock('./tabs.js', () => tabsMocks);
  jest.doMock('./menus.js', () => menuMocks);
  jest.doMock('./menu-backdrop.js', () => menuBackdropMocks);

  const mod = await import('./bookmarks-ui.js');

  return {
    mod,
    electronAPI,
    debugMocks,
    tabsMocks,
    menuMocks,
    menuBackdropMocks,
    windowHandlers,
    resizeObserverInstances: resizeObserverState.instances,
    activeTabRef,
    getStoredBookmarks: () => storedBookmarks.map((bookmark) => ({ ...bookmark })),
    elements: {
      bookmarksBar,
      addBookmarkBtn,
      addBookmarkModal,
      addBookmarkForm,
      closeAddBookmarkBtn,
      bookmarkLabelInput,
      bookmarkTargetInput,
      bookmarkModalTitle,
      bookmarkSubmitBtn,
      addressInput,
      webviewElement,
    },
    helpers: {
      getBookmarksInner: () => bookmarksBar.querySelector('.bookmarks-inner'),
      getOverflowButton: () => bookmarksBar.querySelector('.bookmarks-overflow-btn'),
      getOverflowMenu: () => document.body.querySelector('.bookmarks-overflow-menu'),
      getContextMenu: () => document.body.querySelector('.context-menu'),
    },
  };
};

describe('bookmarks-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.alert = originalAlert;
    global.confirm = originalConfirm;
    global.prompt = originalPrompt;
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.ResizeObserver = originalResizeObserver;
    global.HTMLElement = originalHTMLElement;
    jest.restoreAllMocks();
  });

  test('loads bookmarks, renders overflow items, and loads bookmark targets on click', async () => {
    const onLoadTarget = jest.fn();
    const onContextMenuOpening = jest.fn();
    const ctx = await loadBookmarksModule({
      initialBookmarks: [
        { label: 'Alpha', target: 'https://alpha.example' },
        { label: 'Beta', target: 'https://beta.example' },
        { label: 'Gamma', target: 'https://gamma.example' },
      ],
      cachedFavicons: {
        'https://alpha.example': 'data:image/png;base64,alpha',
      },
    });

    ctx.mod.setOnLoadTarget(onLoadTarget);
    ctx.mod.setOnBookmarkContextMenuOpening(onContextMenuOpening);
    ctx.mod.initBookmarks();
    await ctx.mod.loadBookmarks();
    await flushMicrotasks();

    const bookmarksInner = ctx.helpers.getBookmarksInner();
    const overflowBtn = ctx.helpers.getOverflowButton();
    const overflowMenu = ctx.helpers.getOverflowMenu();
    const firstBookmark = bookmarksInner.children[0];
    const firstIconContainer = firstBookmark.children[0];
    const firstFavicon = firstIconContainer.children[0];

    expect(bookmarksInner.querySelectorAll('.bookmark')).toHaveLength(3);
    expect(ctx.electronAPI.getCachedFavicon).toHaveBeenCalledWith('https://alpha.example');
    expect(firstFavicon.src).toBe('data:image/png;base64,alpha');
    expect(firstIconContainer.dataset.state).toBe('favicon');
    expect(overflowBtn.classList.contains('visible')).toBe(true);
    expect(overflowMenu.children).toHaveLength(1);
    expect(ctx.resizeObserverInstances[0].observe).toHaveBeenCalledWith(ctx.elements.bookmarksBar);

    overflowBtn.dispatch('click', {
      stopPropagation: jest.fn(),
    });

    expect(ctx.menuMocks.closeMenus).toHaveBeenCalled();
    expect(ctx.tabsMocks.hideTabContextMenu).toHaveBeenCalled();
    expect(onContextMenuOpening).toHaveBeenCalled();
    expect(ctx.menuBackdropMocks.showMenuBackdrop).toHaveBeenCalled();
    expect(overflowMenu.classList.contains('hidden')).toBe(false);

    const overflowBookmark = overflowMenu.children[0];
    overflowMenu.dispatch('click', {
      target: overflowBookmark.children[1],
    });

    expect(ctx.elements.addressInput.value).toBe('https://gamma.example');
    expect(onLoadTarget).toHaveBeenCalledWith('https://gamma.example');
    expect(overflowMenu.classList.contains('hidden')).toBe(true);
    expect(ctx.menuBackdropMocks.hideMenuBackdrop).toHaveBeenCalled();
  });

  test('updates add bookmark button visibility and bookmark state', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadBookmarksModule({
      initialBookmarks: [{ label: 'Saved', target: 'https://saved.example' }],
      addressValue: 'https://saved.example',
      activeTab: {
        id: 1,
        title: 'Saved Page',
        isLoading: true,
      },
    });

    ctx.mod.initBookmarks();

    await ctx.mod.updateBookmarkButtonVisibility();
    expect(ctx.elements.addBookmarkBtn.classList.contains('hidden')).toBe(true);

    ctx.activeTabRef.current.isLoading = false;
    await ctx.mod.updateBookmarkButtonVisibility();
    expect(ctx.elements.addBookmarkBtn.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.addBookmarkBtn.classList.contains('bookmarked')).toBe(true);

    ctx.electronAPI.getBookmarks.mockRejectedValueOnce(new Error('status failed'));
    await ctx.mod.updateBookmarkButtonVisibility();
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to check bookmark status',
      expect.any(Error)
    );
    expect(ctx.elements.addBookmarkBtn.classList.contains('bookmarked')).toBe(false);

    ctx.elements.addressInput.value = 'file:///internal-page.html';
    await ctx.mod.updateBookmarkButtonVisibility();
    expect(ctx.elements.addBookmarkBtn.classList.contains('hidden')).toBe(true);
  });

  test('opens the add bookmark modal and saves a new bookmark', async () => {
    const ctx = await loadBookmarksModule({
      addressValue: 'https://new.example',
      activeTab: {
        id: 1,
        title: 'Readable Title',
        isLoading: false,
      },
    });

    ctx.mod.initBookmarks();

    ctx.elements.addBookmarkBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.elements.addBookmarkModal.showModal).toHaveBeenCalled();
    expect(ctx.elements.bookmarkLabelInput.value).toBe('Readable Title');
    expect(ctx.elements.bookmarkTargetInput.value).toBe('https://new.example');
    expect(ctx.elements.bookmarkTargetInput.readOnly).toBe(true);
    expect(ctx.elements.bookmarkModalTitle.textContent).toBe('Add Bookmark');
    expect(ctx.elements.bookmarkSubmitBtn.textContent).toBe('Add Bookmark');
    expect(ctx.elements.bookmarkLabelInput.focus).toHaveBeenCalled();
    expect(ctx.elements.bookmarkLabelInput.select).toHaveBeenCalled();

    ctx.elements.bookmarkLabelInput.value = 'Saved Bookmark';
    ctx.elements.addBookmarkForm.dispatch('submit', {
      preventDefault: jest.fn(),
    });
    await flushMicrotasks();

    expect(ctx.electronAPI.addBookmark).toHaveBeenCalledWith({
      label: 'Saved Bookmark',
      target: 'https://new.example',
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Bookmark added: Saved Bookmark');
    expect(ctx.elements.addBookmarkModal.close).toHaveBeenCalled();
    expect(ctx.getStoredBookmarks()).toContainEqual({
      label: 'Saved Bookmark',
      target: 'https://new.example',
    });
    await ctx.mod.updateBookmarkButtonVisibility();
    expect(ctx.elements.addBookmarkBtn.classList.contains('bookmarked')).toBe(true);
  });

  test('removes existing bookmarks from the add button and supports context-menu edit/delete', async () => {
    const onContextMenuOpening = jest.fn();
    const ctx = await loadBookmarksModule({
      initialBookmarks: [
        { label: 'Old Label', target: 'https://old.example' },
        { label: 'Other', target: 'https://other.example' },
      ],
      addressValue: 'https://old.example',
      activeTab: {
        id: 1,
        title: 'Old Label',
        isLoading: false,
      },
      confirmResult: true,
    });

    ctx.mod.setOnBookmarkContextMenuOpening(onContextMenuOpening);
    ctx.mod.initBookmarks();
    await ctx.mod.loadBookmarks();
    await flushMicrotasks();

    ctx.elements.addBookmarkBtn.dispatch('click');
    await flushMicrotasks();

    expect(global.confirm).toHaveBeenCalledWith('Remove bookmark "Old Label"?');
    expect(ctx.electronAPI.removeBookmark).toHaveBeenCalledWith('https://old.example');
    expect(ctx.elements.addBookmarkModal.showModal).not.toHaveBeenCalled();

    await ctx.mod.loadBookmarks();
    await flushMicrotasks();

    const bookmarksInner = ctx.helpers.getBookmarksInner();
    const contextMenu = ctx.helpers.getContextMenu();
    const remainingBookmark = bookmarksInner.children[0];

    contextMenu.setRect({
      right: 520,
      bottom: 420,
      width: 120,
      height: 50,
    });

    bookmarksInner.dispatch('contextmenu', {
      clientX: 490,
      clientY: 390,
      preventDefault: jest.fn(),
      target: remainingBookmark.children[1],
    });

    expect(ctx.menuMocks.closeMenus).toHaveBeenCalled();
    expect(ctx.tabsMocks.hideTabContextMenu).toHaveBeenCalled();
    expect(onContextMenuOpening).toHaveBeenCalled();
    expect(ctx.menuBackdropMocks.showMenuBackdrop).toHaveBeenCalled();
    expect(contextMenu.classList.contains('hidden')).toBe(false);
    expect(contextMenu.style.left).toBe('372px');
    expect(contextMenu.style.top).toBe('342px');

    contextMenu.dispatch('click', {
      target: {
        dataset: {
          action: 'edit',
        },
      },
    });
    await flushMicrotasks();

    expect(ctx.elements.addBookmarkModal.showModal).toHaveBeenCalledTimes(1);
    expect(ctx.elements.bookmarkLabelInput.value).toBe('Other');
    expect(ctx.elements.bookmarkTargetInput.value).toBe('https://other.example');
    expect(ctx.elements.bookmarkTargetInput.readOnly).toBe(false);
    expect(ctx.elements.bookmarkModalTitle.textContent).toBe('Edit Bookmark');
    expect(ctx.elements.bookmarkSubmitBtn.textContent).toBe('Save');

    ctx.elements.bookmarkLabelInput.value = 'Renamed';
    ctx.elements.bookmarkTargetInput.value = 'https://renamed.example';
    ctx.elements.addBookmarkForm.dispatch('submit', {
      preventDefault: jest.fn(),
    });
    await flushMicrotasks();

    expect(ctx.electronAPI.updateBookmark).toHaveBeenCalledWith('https://other.example', {
      label: 'Renamed',
      target: 'https://renamed.example',
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Bookmark updated: Renamed');

    await ctx.mod.loadBookmarks();
    await flushMicrotasks();

    const renamedBookmark = ctx.helpers.getBookmarksInner().children[0];
    ctx.helpers.getBookmarksInner().dispatch('contextmenu', {
      clientX: 120,
      clientY: 140,
      preventDefault: jest.fn(),
      target: renamedBookmark.children[1],
    });

    contextMenu.dispatch('click', {
      target: {
        dataset: {
          action: 'delete',
        },
      },
    });
    await flushMicrotasks();

    expect(ctx.electronAPI.removeBookmark).toHaveBeenCalledWith('https://renamed.example');
    expect(ctx.getStoredBookmarks()).toHaveLength(0);
    expect(ctx.menuBackdropMocks.hideMenuBackdrop).toHaveBeenCalled();
  });
});
