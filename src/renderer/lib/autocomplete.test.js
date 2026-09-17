const originalWindow = global.window;
const originalDocument = global.document;
const originalNavigator = global.navigator;

const escapeHtml = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const createClassList = (initialClasses = []) => {
  const classes = new Set(initialClasses);

  return {
    add: jest.fn((className) => {
      classes.add(className);
    }),
    remove: jest.fn((className) => {
      classes.delete(className);
    }),
    toggle: jest.fn((className, force) => {
      if (force === undefined) {
        if (classes.has(className)) {
          classes.delete(className);
          return false;
        }

        classes.add(className);
        return true;
      }

      if (force) {
        classes.add(className);
      } else {
        classes.delete(className);
      }

      return force;
    }),
    contains: jest.fn((className) => classes.has(className)),
  };
};

const createElement = (initialClasses = []) => {
  const handlers = {};

  return {
    handlers,
    classList: createClassList(initialClasses),
    dataset: {},
    innerHTML: '',
    value: '',
    addEventListener: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    blur: jest.fn(),
    querySelectorAll: jest.fn(() => []),
  };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadAutocompleteModule = async (options = {}) => {
  jest.resetModules();

  const {
    openTabs = [{ id: 11, title: 'Open Tab', url: 'https://tab.example' }],
    history = [{ title: 'History Entry', url: 'https://history.example' }],
    bookmarks = [{ title: 'Bookmark Entry', url: 'https://bookmark.example' }],
    suggestionResolver = (query) => [
      {
        title: `Tab Result ${query}`,
        url: 'https://tab.example',
        protocol: 'https',
        type: 'tab',
        tabId: 11,
      },
      {
        title: `Bookmark <Result> ${query}`,
        url: 'ipfs://bookmark',
        protocol: 'ipfs',
        type: 'bookmark',
      },
    ],
    faviconBehavior = async (url) => {
      if (url === 'https://tab.example') {
        return 'data:image/png;base64,tab';
      }
      if (url === 'ipfs://bookmark') {
        throw new Error('favicon fetch failed');
      }
      return null;
    },
    includeElements = true,
  } = options;

  let renderedItems = [];
  let iconContainers = [];
  const createdImages = [];
  const documentHandlers = {};
  const windowHandlers = {};
  const dropdown = createElement(['hidden']);
  const addressInput = createElement();
  const webviewElement = createElement();
  const electronAPI = {
    getHistory: jest.fn().mockResolvedValue(history),
    getBookmarks: jest.fn().mockResolvedValue(bookmarks),
    getCachedFavicon: jest.fn((url) => faviconBehavior(url)),
  };
  // Per-tab navigation state the address-bar edit tracker writes through
  // (`address-bar-edit.js` reads it via `getActiveTabState`).
  const navState = { addressBarPendingInput: null, addressBarPendingSelection: null };
  const tabsMocks = {
    getOpenTabs: jest.fn(() => openTabs),
    switchTab: jest.fn(),
    hideTabContextMenu: jest.fn(),
    getActiveTabState: jest.fn(() => navState),
  };
  const menusMocks = {
    closeMenus: jest.fn(),
  };
  const bookmarkUiMocks = {
    hideBookmarkContextMenu: jest.fn(),
  };
  const backdropMocks = {
    showMenuBackdrop: jest.fn(),
    hideMenuBackdrop: jest.fn(),
  };
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const autocompleteUtilsMocks = {
    generateSuggestions: jest.fn((query, data) => {
      const suggestions = suggestionResolver(query, data);

      renderedItems = suggestions.map(() => ({
        classList: createClassList(),
        scrollIntoView: jest.fn(),
      }));

      iconContainers = suggestions.map((item) => {
        const placeholder = {
          replaceWith: jest.fn(),
        };
        const protocolBadge = {
          classList: createClassList([`protocol-${item.protocol}`]),
          style: {},
        };

        return {
          dataset: {
            faviconUrl: item.url,
          },
          placeholder,
          protocolBadge,
          querySelector: jest.fn((selector) => {
            if (selector === '.autocomplete-icon-placeholder') {
              return placeholder;
            }
            if (selector === '.autocomplete-protocol-badge') {
              return protocolBadge;
            }
            return null;
          }),
        };
      });

      iconContainers.push({
        dataset: {},
        querySelector: jest.fn(() => null),
      });

      return suggestions;
    }),
    getPlaceholderLetter: jest.fn(() => 'A'),
  };

  dropdown.querySelectorAll = jest.fn((selector) => {
    if (selector === '.autocomplete-item') {
      return renderedItems;
    }
    if (selector === '.autocomplete-icon-container') {
      return iconContainers;
    }
    return [];
  });

  global.window = {
    electronAPI,
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };

  global.document = {
    getElementById: jest.fn((id) => {
      if (!includeElements) return null;
      if (id === 'autocomplete-dropdown') return dropdown;
      if (id === 'address-input') return addressInput;
      if (id === 'bzz-webview') return webviewElement;
      return null;
    }),
    createElement: jest.fn((tagName) => {
      if (tagName === 'div') {
        let innerHTML = '';

        return {
          set textContent(value) {
            innerHTML = escapeHtml(String(value));
          },
          get innerHTML() {
            return innerHTML;
          },
        };
      }

      if (tagName === 'img') {
        const image = {
          className: '',
          src: '',
          alt: '',
          onerror: null,
          replaceWith: jest.fn(),
        };

        createdImages.push(image);
        return image;
      }

      return {};
    }),
    addEventListener: jest.fn((event, handler) => {
      documentHandlers[event] = handler;
    }),
  };

  global.navigator = {
    clipboard: {
      writeText: jest.fn(),
    },
  };

  jest.doMock('./debug.js', () => debugMocks);
  jest.doMock('./tabs.js', () => tabsMocks);
  jest.doMock('./menus.js', () => menusMocks);
  jest.doMock('./bookmarks-ui.js', () => bookmarkUiMocks);
  jest.doMock('./menu-backdrop.js', () => backdropMocks);
  jest.doMock('./autocomplete-utils.js', () => autocompleteUtilsMocks);

  const mod = await import('./autocomplete.js');

  return {
    mod,
    navState,
    dropdown,
    addressInput,
    webviewElement,
    createdImages,
    renderedItems: () => renderedItems,
    iconContainers: () => iconContainers,
    documentHandlers,
    windowHandlers,
    electronAPI,
    tabsMocks,
    menusMocks,
    bookmarkUiMocks,
    backdropMocks,
    debugMocks,
    autocompleteUtilsMocks,
  };
};

describe('autocomplete', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.navigator = originalNavigator;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('logs an error when required elements are missing', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { mod } = await loadAutocompleteModule({ includeElements: false });

    mod.initAutocomplete();

    expect(consoleErrorSpy).toHaveBeenCalledWith('[Autocomplete] Required elements not found');
  });

  test('refreshes cache, renders suggestions, escapes html, and loads favicons', async () => {
    jest.useFakeTimers();

    const {
      mod,
      dropdown,
      addressInput,
      createdImages,
      iconContainers,
      electronAPI,
      menusMocks,
      tabsMocks,
      bookmarkUiMocks,
      backdropMocks,
      debugMocks,
      autocompleteUtilsMocks,
    } = await loadAutocompleteModule({
      suggestionResolver: (query) => [
        {
          title: `<b>${query}</b>`,
          url: 'https://tab.example',
          protocol: 'https',
          type: 'tab',
          tabId: 11,
        },
        {
          title: 'Bookmark Result',
          url: 'ipfs://bookmark',
          protocol: 'ipfs',
          type: 'bookmark',
        },
      ],
    });

    mod.initAutocomplete();
    await flushMicrotasks();

    expect(debugMocks.pushDebug).toHaveBeenCalledWith(
      '[Autocomplete] Cache refreshed: 1 history, 1 bookmarks'
    );
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('[Autocomplete] Initialized');

    addressInput.value = 'example';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();

    expect(autocompleteUtilsMocks.generateSuggestions).toHaveBeenCalledWith('example', {
      openTabs: [{ id: 11, title: 'Open Tab', url: 'https://tab.example' }],
      historyItems: [{ title: 'History Entry', url: 'https://history.example' }],
      bookmarks: [{ title: 'Bookmark Entry', url: 'https://bookmark.example' }],
    });
    expect(dropdown.innerHTML).toContain('&lt;b&gt;example&lt;/b&gt;');
    expect(dropdown.innerHTML).toContain('tab-badge');
    expect(dropdown.innerHTML).toContain('★');
    expect(menusMocks.closeMenus).toHaveBeenCalled();
    expect(tabsMocks.hideTabContextMenu).toHaveBeenCalled();
    expect(bookmarkUiMocks.hideBookmarkContextMenu).toHaveBeenCalled();
    expect(backdropMocks.showMenuBackdrop).toHaveBeenCalled();
    expect(dropdown.classList.remove).toHaveBeenCalledWith('hidden');

    expect(electronAPI.getCachedFavicon).toHaveBeenCalledWith('https://tab.example');
    expect(electronAPI.getCachedFavicon).toHaveBeenCalledWith('ipfs://bookmark');
    expect(createdImages).toHaveLength(1);
    expect(iconContainers()[0].placeholder.replaceWith).toHaveBeenCalledWith(createdImages[0]);
    expect(iconContainers()[0].protocolBadge.style.display).toBe('none');

    createdImages[0].onerror();

    expect(createdImages[0].replaceWith).toHaveBeenCalledWith(iconContainers()[0].placeholder);
    expect(iconContainers()[0].protocolBadge.style.display).toBe('block');
  });

  test('supports keyboard navigation for switching tabs, navigating, tab completion, and escape', async () => {
    jest.useFakeTimers();

    const { mod, navState, dropdown, addressInput, tabsMocks, backdropMocks } =
      await loadAutocompleteModule({
        suggestionResolver: () => [
          {
            title: 'Open Tab',
            url: 'https://tab.example',
            protocol: 'https',
            type: 'tab',
            tabId: 11,
          },
          {
            title: 'Navigate Here',
            url: 'https://navigate.example',
            protocol: 'https',
            type: 'history',
          },
        ],
      });
    const onNavigate = jest.fn();

    mod.setOnNavigate(onNavigate);
    mod.initAutocomplete();
    await flushMicrotasks();

    addressInput.value = 'nav';
    addressInput.handlers.keydown({
      key: 'ArrowDown',
      preventDefault: jest.fn(),
    });
    jest.runAllTimers();
    await flushMicrotasks();

    addressInput.handlers.keydown({
      key: 'ArrowDown',
      preventDefault: jest.fn(),
    });

    expect(dropdown.querySelectorAll('.autocomplete-item')[0].classList.toggle).toHaveBeenCalledWith(
      'selected',
      true
    );
    expect(dropdown.querySelectorAll('.autocomplete-item')[0].scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
    });

    // Previewing a row is an uncommitted edit of this tab's address bar, so
    // it is tracked as one (page commits must not clobber it — #305).
    expect(navState.addressBarPendingInput).toBe('https://tab.example');

    addressInput.handlers.keydown({
      key: 'Enter',
      preventDefault: jest.fn(),
    });

    // The switch is flagged as address-bar-driven so the tab being left does
    // not adopt the previewed target URL as its own page display (#310 M3).
    expect(tabsMocks.switchTab).toHaveBeenCalledWith(11, { fromAddressBarCommit: true });
    expect(addressInput.blur).toHaveBeenCalled();
    expect(backdropMocks.hideMenuBackdrop).toHaveBeenCalled();
    // Committing a suggestion ends the edit for the tab being left.
    expect(navState.addressBarPendingInput).toBeNull();

    addressInput.value = 'nav';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();

    // ArrowDown stops on the last row instead of wrapping to the first (#313).
    addressInput.handlers.keydown({ key: 'ArrowDown', preventDefault: jest.fn() });
    addressInput.handlers.keydown({ key: 'ArrowDown', preventDefault: jest.fn() });
    expect(addressInput.value).toBe('https://navigate.example');
    addressInput.handlers.keydown({ key: 'ArrowDown', preventDefault: jest.fn() });
    expect(addressInput.value).toBe('https://navigate.example');

    addressInput.handlers.keydown({
      key: 'Tab',
      preventDefault: jest.fn(),
    });

    expect(addressInput.value).toBe('https://navigate.example');

    addressInput.value = 'nav';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();

    addressInput.handlers.keydown({ key: 'ArrowDown', preventDefault: jest.fn() });
    addressInput.handlers.keydown({ key: 'ArrowDown', preventDefault: jest.fn() });
    addressInput.handlers.keydown({
      key: 'Enter',
      preventDefault: jest.fn(),
    });

    expect(onNavigate).toHaveBeenCalledWith('https://navigate.example', {
      commitsAddressBar: true,
    });
    expect(addressInput.value).toBe('https://navigate.example');

    addressInput.value = 'nav';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();

    addressInput.handlers.keydown({
      key: 'Escape',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });

    expect(dropdown.classList.add).toHaveBeenCalledWith('hidden');
  });

  test('arrow keys stop at both ends of the list and return to the typed text', async () => {
    jest.useFakeTimers();

    const { mod, navState, dropdown, addressInput } = await loadAutocompleteModule({
      suggestionResolver: () => [
        { title: 'First', url: 'https://first.example', protocol: 'https', type: 'history' },
        { title: 'Second', url: 'https://second.example', protocol: 'https', type: 'history' },
      ],
    });

    mod.initAutocomplete();
    await flushMicrotasks();

    addressInput.value = 'bzz';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();

    // ArrowUp with nothing highlighted stays on the typed text — it must not
    // teleport to the bottom of the list (#313).
    addressInput.handlers.keydown({ key: 'ArrowUp', preventDefault: jest.fn() });
    expect(addressInput.value).toBe('bzz');
    expect(mod.isSuggestionPreviewActive()).toBe(false);

    addressInput.handlers.keydown({ key: 'ArrowDown', preventDefault: jest.fn() });
    expect(addressInput.value).toBe('https://first.example');
    expect(mod.isSuggestionPreviewActive()).toBe(true);

    // ArrowUp off the first suggestion goes back to what the user typed,
    // with nothing highlighted, and stays there.
    addressInput.handlers.keydown({ key: 'ArrowUp', preventDefault: jest.fn() });
    expect(addressInput.value).toBe('bzz');
    expect(navState.addressBarPendingInput).toBe('bzz');
    expect(mod.isSuggestionPreviewActive()).toBe(false);
    expect(dropdown.querySelectorAll('.autocomplete-item')[0].classList.toggle).toHaveBeenCalledWith(
      'selected',
      false
    );

    addressInput.handlers.keydown({ key: 'ArrowUp', preventDefault: jest.fn() });
    expect(addressInput.value).toBe('bzz');

    // Hovering a row moves the highlight, so Enter commits the row under the
    // cursor rather than the typed text (#313) — but it leaves the bar's text
    // alone, so it does not count as a preview and does not cost the user an
    // extra Escape press (#310).
    dropdown.handlers.mousemove({
      target: { closest: () => ({ dataset: { index: '1' } }) },
    });
    expect(mod.isSuggestionPreviewActive()).toBe(false);
    expect(addressInput.value).toBe('bzz');
    const onNavigate = jest.fn();
    mod.setOnNavigate(onNavigate);
    addressInput.handlers.keydown({ key: 'Enter', preventDefault: jest.fn() });
    expect(onNavigate).toHaveBeenCalledWith('https://second.example', {
      commitsAddressBar: true,
    });
  });

  test('escape with a previewed suggestion restores the typed text and keeps focus', async () => {
    jest.useFakeTimers();

    const { mod, dropdown, addressInput } = await loadAutocompleteModule({
      suggestionResolver: () => [
        { title: 'First', url: 'https://first.example', protocol: 'https', type: 'history' },
      ],
    });

    mod.initAutocomplete();
    await flushMicrotasks();

    addressInput.value = 'bzz';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();
    addressInput.handlers.keydown({ key: 'ArrowDown', preventDefault: jest.fn() });
    expect(addressInput.value).toBe('https://first.example');

    const escape = {
      key: 'Escape',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    addressInput.handlers.keydown(escape);

    // The typed text comes back, the list closes, focus stays in the bar and
    // navigation.js' handler is left out of this press (#310).
    expect(addressInput.value).toBe('bzz');
    expect(dropdown.classList.add).toHaveBeenCalledWith('hidden');
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(addressInput.blur).not.toHaveBeenCalled();
    expect(mod.isSuggestionPreviewActive()).toBe(false);
  });

  test('escape after a mere hover leaves the bar to navigation.js (#310)', async () => {
    jest.useFakeTimers();

    const { mod, dropdown, addressInput } = await loadAutocompleteModule({
      suggestionResolver: () => [
        { title: 'First', url: 'https://first.example', protocol: 'https', type: 'history' },
      ],
    });

    mod.initAutocomplete();
    await flushMicrotasks();

    addressInput.value = 'bzz';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();

    // Hover highlights the row but never rewrites the bar…
    dropdown.handlers.mousemove({
      target: { closest: () => ({ dataset: { index: '0' } }) },
    });
    expect(addressInput.value).toBe('bzz');
    expect(mod.isSuggestionPreviewActive()).toBe(false);

    // …so this module has nothing to restore: it only closes the list, and
    // navigation.js (whose listener ran first, since it stood down only for a
    // real preview) keeps its revert to the page URL. One press, like Chrome.
    addressInput.value = 'display:https://page-a.example/';
    addressInput.handlers.keydown({
      key: 'Escape',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
    expect(addressInput.value).toBe('display:https://page-a.example/');
    expect(dropdown.classList.add).toHaveBeenCalledWith('hidden');
  });

  test('handles click selection, empty queries, blur interactions, and refresh errors', async () => {
    jest.useFakeTimers();

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const {
      mod,
      dropdown,
      addressInput,
      webviewElement,
      windowHandlers,
      tabsMocks,
      electronAPI,
    } = await loadAutocompleteModule({
      suggestionResolver: () => [
        {
          title: 'Open Tab',
          url: 'https://tab.example',
          protocol: 'https',
          type: 'tab',
          tabId: 11,
        },
        {
          title: 'Navigate Here',
          url: 'https://navigate.example',
          protocol: 'https',
          type: 'history',
        },
      ],
    });
    const onNavigate = jest.fn();

    mod.setOnNavigate(onNavigate);
    mod.initAutocomplete();
    await flushMicrotasks();

    addressInput.value = '';
    addressInput.handlers.input();
    expect(dropdown.classList.add).toHaveBeenCalledWith('hidden');

    addressInput.value = 'navigate';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();

    dropdown.handlers.click({
      target: {
        closest: jest.fn(() => ({
          dataset: {
            tabId: '11',
          },
        })),
      },
    });
    expect(tabsMocks.switchTab).toHaveBeenCalledWith(11, { fromAddressBarCommit: true });

    addressInput.value = 'navigate';
    addressInput.handlers.input();
    jest.runAllTimers();
    await flushMicrotasks();

    dropdown.handlers.click({
      target: {
        closest: jest.fn(() => ({
          dataset: {
            url: 'https://navigate.example',
          },
        })),
      },
    });
    expect(onNavigate).toHaveBeenCalledWith('https://navigate.example', {
      commitsAddressBar: true,
    });

    dropdown.handlers.click({
      target: {
        closest: jest.fn(() => null),
      },
    });

    windowHandlers.blur();

    expect(dropdown.classList.add).toHaveBeenCalledWith('hidden');
    // The `#bzz-webview` focus/mousedown dismissal is gone: webviews are
    // created id-less, so the lookup was always null and those listeners never
    // existed (#306). The fake DOM does resolve that id, so this asserts they
    // are really gone rather than merely never firing.
    expect(webviewElement.handlers.focus).toBeUndefined();
    expect(webviewElement.handlers.mousedown).toBeUndefined();

    electronAPI.getHistory.mockRejectedValueOnce(new Error('history unavailable'));
    await mod.refreshCache();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Autocomplete] Failed to refresh cache:',
      expect.any(Error)
    );
  });
});
