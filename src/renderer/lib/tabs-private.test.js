/**
 * Private-window behaviour of the tabs module:
 *  - every webview gets the window's private partition, stamped BEFORE the
 *    src attribute (partition only applies before first load)
 *  - new tabs open the private start page instead of the home page
 *  - the closed-tabs stack never records the private start page
 *
 * Kept separate from tabs.test.js because the private flag is read from
 * window.location at module load — this suite boots the module inside a
 * private window, the main suite inside a normal one.
 */

const PARTITION = 'private-123e4567-e89b-42d3-a456-426614174000';

const mockElectronAPI = {
  setWindowTitle: jest.fn(),
  getSettings: jest.fn(() => Promise.resolve({})),
  updateTabMenuState: jest.fn(),
};

const createdWebviews = [];

const createMockWebview = () => {
  const attributes = {};
  const setAttributeOrder = [];
  const webview = {
    attributes,
    setAttributeOrder,
    setAttribute: jest.fn((name, value) => {
      attributes[name] = value;
      setAttributeOrder.push(name);
    }),
    getAttribute: jest.fn((name) => attributes[name]),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    classList: { toggle: jest.fn(), add: jest.fn(), remove: jest.fn() },
    dataset: {},
    getURL: jest.fn(() => 'about:blank'),
    remove: jest.fn(),
  };
  createdWebviews.push(webview);
  return webview;
};

beforeAll(() => {
  global.window = {
    electronAPI: mockElectronAPI,
    location: {
      href: `file:///app/index.html?privatePartition=${PARTITION}`,
      search: `?privatePartition=${PARTITION}`,
    },
    addEventListener: jest.fn(),
    internalPages: {
      routable: {
        home: 'home.html',
        private: 'private.html',
        history: 'history.html',
        settings: 'settings.html',
      },
    },
  };

  global.document = {
    createElement: jest.fn((tag) => {
      if (tag === 'webview') {
        return createMockWebview();
      }
      return {
        className: '',
        classList: { add: jest.fn(), toggle: jest.fn() },
        dataset: {},
        appendChild: jest.fn(),
        addEventListener: jest.fn(),
        innerHTML: '',
      };
    }),
    getElementById: jest.fn((id) => {
      if (id === 'tab-bar') return { innerHTML: '', appendChild: jest.fn() };
      if (id === 'webview-container') return { appendChild: jest.fn() };
      if (id === 'new-tab-btn') return { addEventListener: jest.fn() };
      return null;
    }),
    addEventListener: jest.fn(),
  };

  global.URL = URL;
});

describe('tabs in a private window', () => {
  test('webviews carry the window partition, set before src', async () => {
    const { createTab } = await import('./tabs.js');

    createTab('https://example.com/');
    const webview = createdWebviews[createdWebviews.length - 1];

    expect(webview.attributes.partition).toBe(PARTITION);
    // partition must be stamped before the first navigation — i.e. before
    // the src attribute is assigned.
    const partitionIndex = webview.setAttributeOrder.indexOf('partition');
    const srcIndex = webview.setAttributeOrder.indexOf('src');
    expect(partitionIndex).toBeGreaterThanOrEqual(0);
    expect(srcIndex).toBeGreaterThan(partitionIndex);
  });

  test('a default new tab opens the private start page', async () => {
    const { createTab } = await import('./tabs.js');

    const tab = createTab();
    expect(tab.url).toBe('freedom://private');

    const webview = createdWebviews[createdWebviews.length - 1];
    // Resolved directly to the internal page file (no about:blank parking).
    expect(webview.attributes.src).toMatch(/pages\/private\.html$/);
  });

  test('closing a private-start-page tab never enters the closed-tabs stack', async () => {
    const { createTab, closeTab, getTabs } = await import('./tabs.js');

    // A page tab first, so the window doesn't try to close itself when the
    // last tab goes away.
    createTab('https://keep-me-open.example/');

    const startTab = createTab();
    closeTab(startTab.id);

    // Now close a real page tab — that one becomes reopenable.
    const pageTab = createTab('https://visited-in-private.example/');
    closeTab(pageTab.id);

    // Reopen must resurrect the page tab (top of stack), not the start page.
    const { reopenLastClosedTab } = await import('./tabs.js');
    reopenLastClosedTab();
    const tabs = getTabs();
    expect(tabs[tabs.length - 1].url).toBe('https://visited-in-private.example/');

    // And the stack must not contain the private start page below it:
    // popping again (stack should now be empty) must be a no-op.
    const countBefore = getTabs().length;
    reopenLastClosedTab();
    expect(getTabs().length).toBe(countBefore);
  });
});
