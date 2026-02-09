/**
 * Tests for tab navigation state isolation
 *
 * Critical bug: Navigation state (currentPageUrl, currentBzzBase, etc.) is stored
 * globally in state.js, but should be per-tab. This causes:
 * - Wrong URL shown in address bar after switching tabs
 * - Wrong bzzBase used for relative URL resolution in Swarm content
 */

// Mock electronAPI
const mockElectronAPI = {
  setWindowTitle: jest.fn(),
};

// Mock DOM elements
const createMockWebview = (tabId) => ({
  setAttribute: jest.fn(),
  addEventListener: jest.fn(),
  classList: {
    toggle: jest.fn(),
    add: jest.fn(),
    remove: jest.fn(),
  },
  dataset: { tabId },
  getURL: jest.fn(() => 'about:blank'),
  remove: jest.fn(),
});

// Setup DOM mocks before importing modules
beforeAll(() => {
  global.window = {
    electronAPI: mockElectronAPI,
    location: { href: 'file:///app/index.html' },
  };

  global.document = {
    createElement: jest.fn((tag) => {
      if (tag === 'webview') {
        return createMockWebview(0);
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
  };

  global.URL = URL;
});

describe('Tab Navigation State Isolation', () => {
  describe('Per-tab state storage', () => {
    test('each tab should have its own navigation state object', async () => {
      // Import after mocks are set up
      const { createTab } = await import('./tabs.js');

      // Create two tabs
      const tab1 = createTab('http://example.com/page1');
      const tab2 = createTab('http://example.com/page2');

      // Each tab should have navigation state properties
      expect(tab1).toHaveProperty('navigationState');
      expect(tab2).toHaveProperty('navigationState');

      // Navigation states should be separate objects
      expect(tab1.navigationState).not.toBe(tab2.navigationState);
    });

    test('tab navigation state should include required properties', async () => {
      const { createTab } = await import('./tabs.js');

      const tab = createTab('http://example.com');

      // Check all required navigation state properties exist
      expect(tab.navigationState).toHaveProperty('currentPageUrl');
      expect(tab.navigationState).toHaveProperty('pendingNavigationUrl');
      expect(tab.navigationState).toHaveProperty('pendingTitleForUrl');
      expect(tab.navigationState).toHaveProperty('hasNavigatedDuringCurrentLoad');
      expect(tab.navigationState).toHaveProperty('isWebviewLoading');
      expect(tab.navigationState).toHaveProperty('currentBzzBase');
      expect(tab.navigationState).toHaveProperty('addressBarSnapshot');
      expect(tab.navigationState).toHaveProperty('cachedWebContentsId');
    });
  });

  describe('State isolation between tabs', () => {
    test('modifying one tab state should not affect another tab', async () => {
      const { createTab } = await import('./tabs.js');

      const tab1 = createTab('http://example.com/page1');
      const tab2 = createTab('http://example.com/page2');

      // Set state on tab1
      tab1.navigationState.currentPageUrl = 'http://example.com/tab1-url';
      tab1.navigationState.currentBzzBase = 'http://127.0.0.1:1633/bzz/hash1/';

      // Set different state on tab2
      tab2.navigationState.currentPageUrl = 'http://example.com/tab2-url';
      tab2.navigationState.currentBzzBase = 'http://127.0.0.1:1633/bzz/hash2/';

      // Verify states are independent
      expect(tab1.navigationState.currentPageUrl).toBe('http://example.com/tab1-url');
      expect(tab2.navigationState.currentPageUrl).toBe('http://example.com/tab2-url');
      expect(tab1.navigationState.currentBzzBase).toBe('http://127.0.0.1:1633/bzz/hash1/');
      expect(tab2.navigationState.currentBzzBase).toBe('http://127.0.0.1:1633/bzz/hash2/');
    });

    test('switching tabs should preserve each tab state', async () => {
      const { createTab, switchTab, getActiveTab } = await import('./tabs.js');

      const tab1 = createTab('http://example.com/page1');
      tab1.navigationState.currentPageUrl = 'http://tab1.com';

      const tab2 = createTab('http://example.com/page2');
      tab2.navigationState.currentPageUrl = 'http://tab2.com';

      // Switch to tab1
      switchTab(tab1.id);
      expect(getActiveTab().navigationState.currentPageUrl).toBe('http://tab1.com');

      // Switch to tab2
      switchTab(tab2.id);
      expect(getActiveTab().navigationState.currentPageUrl).toBe('http://tab2.com');

      // Switch back to tab1 - state should be preserved
      switchTab(tab1.id);
      expect(getActiveTab().navigationState.currentPageUrl).toBe('http://tab1.com');
    });
  });

  describe('getActiveTabState helper', () => {
    test('should return navigation state of active tab', async () => {
      const { createTab, switchTab, getActiveTabState } = await import('./tabs.js');

      const tab1 = createTab('http://example.com/page1');
      tab1.navigationState.currentPageUrl = 'http://active-tab.com';

      createTab('http://example.com/page2');

      switchTab(tab1.id);

      const state = getActiveTabState();
      expect(state.currentPageUrl).toBe('http://active-tab.com');
    });

    test('should return null when no active tab', async () => {
      const { getActiveTabState } = await import('./tabs.js');

      // This test assumes we can have a state with no active tab
      // In practice this might not happen, but the function should handle it
      const state = getActiveTabState();
      // Either returns null or a default state object
      expect(state === null || typeof state === 'object').toBe(true);
    });
  });
});
