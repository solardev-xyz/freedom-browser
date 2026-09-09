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
    electronAPI: { ...mockElectronAPI, getSettings: jest.fn(() => Promise.resolve({})) },
    location: { href: 'file:///app/index.html' },
    addEventListener: jest.fn(),
    // Lets page-urls.js build the internal-page map used to dedupe
    // freedom://<page> tabs.
    internalPages: {
      routable: { profiles: 'profiles.html', history: 'history.html', settings: 'settings.html' },
    },
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
      expect(tab.navigationState).toHaveProperty('committedDisplayUrl');
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

  describe('getDisplayUrlForWebview', () => {
    // Provider permission checks (swarm-provider.js etc.) call this helper
    // to derive the page origin for keying prompts and storing decisions.
    // It must return the *committed* display identity, never the user's
    // unsubmitted address-bar draft — otherwise a Swarm site could fire a
    // request while the user is mid-typing and have its permission prompt
    // keyed on the typed-but-not-loaded URL instead of the actual page.
    test('returns committedDisplayUrl, ignoring an unsubmitted draft in addressBarSnapshot', async () => {
      const { createTab, getDisplayUrlForWebview } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      // Mirror the production did-navigate commit shape: committedDisplayUrl
      // is the source of truth for the active page identity.
      tab.navigationState.committedDisplayUrl = 'https://example.com/';
      // addressBarSnapshot can carry an unsubmitted draft (focusin /
      // tab-switched both write the live address-bar value into it). It
      // must NOT be the value getDisplayUrlForWebview returns.
      tab.navigationState.addressBarSnapshot = 'vitalik.eth';

      expect(getDisplayUrlForWebview(tab.webview)).toBe('https://example.com/');
    });

    test('returns empty string when committedDisplayUrl is empty (no fallback to addressBarSnapshot)', async () => {
      // `addressBarSnapshot` is overwritten with the live address-bar
      // value on focusin and tab-switched, so it can carry an
      // unsubmitted draft. Falling back to it would leak that draft
      // into provider permission keying — instead, an unset
      // `committedDisplayUrl` must surface as the empty string so
      // callers explicitly handle the "no committed page yet" case.
      const { createTab, getDisplayUrlForWebview } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.navigationState.committedDisplayUrl = '';
      tab.navigationState.addressBarSnapshot = 'vitalik.eth';

      expect(getDisplayUrlForWebview(tab.webview)).toBe('');
    });

    test('returns empty string when the webview is not tracked', async () => {
      const { getDisplayUrlForWebview } = await import('./tabs.js');

      const orphan = createMockWebview(999);
      expect(getDisplayUrlForWebview(orphan)).toBe('');
    });
  });

  describe('did-navigate populates committedDisplayUrl', () => {
    // The committed display identity is the source of truth for reload
    // ("what page are we actually on?") and for provider permission
    // keying. It must be written on the per-webview `did-navigate`
    // event (which fires after Chromium actually commits the
    // navigation) for every tab — not pre-commit by the dispatch path,
    // and not gated on the tab being active. Otherwise either:
    //   - a pre-commit write lets the destination origin briefly stand
    //     in for the still-loaded previous page, or
    //   - a background ENS load that finishes while its tab is
    //     inactive never populates the committed identity, so a later
    //     reload falls through to webview.reload() instead of
    //     re-resolving under today's verification method.
    test('writes committedDisplayUrl for the active tab on did-navigate', async () => {
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.webview.getURL.mockReturnValue('https://example.com/page');
      tab.webview._eventHandlers['did-navigate']({ url: 'https://example.com/page' });

      expect(tab.navigationState.committedDisplayUrl).toBe('https://example.com/page');
    });

    test('writes committedDisplayUrl for a background tab on did-navigate', async () => {
      const { createTab, switchTab } = await import('./tabs.js');

      const tabA = createTab('https://a.example/');
      const tabB = createTab('https://b.example/');
      // Foreground tabB so tabA is the background tab whose did-navigate
      // we exercise.
      switchTab(tabB.id);

      tabA.webview.getURL.mockReturnValue('ipfs://vitalik.eth');
      tabA.webview._eventHandlers['did-navigate']({ url: 'ipfs://vitalik.eth' });

      expect(tabA.navigationState.committedDisplayUrl).toBe('ipfs://vitalik.eth');
    });

    test('reverse-maps an onchain Chromium origin before committing its display URL', async () => {
      const { createTab } = await import('./tabs.js');
      const address = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
      const navigationUrl = `web3://${address}.eip155-100/swap?x=1#route`;
      const tab = createTab(navigationUrl);
      tab.webview.getURL.mockReturnValue(navigationUrl);
      tab.webview._eventHandlers['did-navigate']({ url: navigationUrl });

      expect(tab.url).toBe(navigationUrl);
      expect(tab.navigationState.committedDisplayUrl).toBe(
        `web3://${address}:100/swap?x=1#route`
      );
    });

    test('preserves committedDisplayUrl when did-navigate fires for about:blank', async () => {
      // about:blank navigations happen during "open in new window" before
      // the real loadURL runs. Letting them clobber `committedDisplayUrl`
      // would lose the actual page identity for the brief window between
      // the about:blank commit and the real navigation committing.
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.navigationState.committedDisplayUrl = 'https://example.com/';
      tab.webview.getURL.mockReturnValue('about:blank');
      tab.webview._eventHandlers['did-navigate']({ url: 'about:blank' });

      expect(tab.navigationState.committedDisplayUrl).toBe('https://example.com/');
    });

    test('captures view-source: prefix from webview.getURL() on did-navigate', async () => {
      // `webview.getURL()` is the canonical source for the committed
      // URL because event.url omits the view-source: prefix. Reload
      // checks downstream depend on the prefix being preserved here.
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.webview.getURL.mockReturnValue('view-source:https://example.com/');
      tab.webview._eventHandlers['did-navigate']({ url: 'https://example.com/' });

      expect(tab.navigationState.committedDisplayUrl).toBe('view-source:https://example.com/');
    });
  });

  describe('did-navigate clears the previous document title (#236)', () => {
    // Chromium fires `page-title-updated` only when the new document
    // actually declares a title, so a page without a <title> — the Swarm
    // error page being the reported case — otherwise keeps showing, and
    // recording in history, the title of the page visited before it.
    test('clears the carried-over title when a different URL commits', async () => {
      const { createTab, switchTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      switchTab(tab.id);
      tab.title = 'RPC servers disagreed';
      mockElectronAPI.setWindowTitle.mockClear();

      tab.webview.getURL.mockReturnValue('file:///app/pages/error.html?error=x');
      tab.webview._eventHandlers['did-navigate']({
        url: 'file:///app/pages/error.html?error=x',
      });

      expect(tab.title).toBe('');
      expect(mockElectronAPI.setWindowTitle).toHaveBeenCalledWith('');
    });

    test('keeps the title when the same URL re-commits (reload)', async () => {
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.webview.getURL.mockReturnValue('https://example.com/page');
      tab.webview._eventHandlers['did-navigate']({ url: 'https://example.com/page' });
      tab.title = 'Example Page';

      tab.webview._eventHandlers['did-navigate']({ url: 'https://example.com/page' });

      expect(tab.title).toBe('Example Page');
    });

    test('keeps the title through an about:blank commit', async () => {
      // Same reasoning as committedDisplayUrl: "open in new window" passes
      // through about:blank before the real navigation commits.
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.title = 'Example Page';
      tab.webview.getURL.mockReturnValue('about:blank');
      tab.webview._eventHandlers['did-navigate']({ url: 'about:blank' });

      expect(tab.title).toBe('Example Page');
    });

    test('leaves a view-source title alone (navigation.js owns it)', async () => {
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.title = 'view-source:https://example.com/';
      tab.webview.getURL.mockReturnValue('view-source:https://example.com/other');
      tab.webview._eventHandlers['did-navigate']({ url: 'https://example.com/other' });

      expect(tab.title).toBe('view-source:https://example.com/');
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

describe('openOrFocusInternalPage', () => {
  test('opens a new tab the first time and focuses the same tab afterwards', async () => {
    const { openOrFocusInternalPage, createTab, getTabs, getActiveTab } = await import('./tabs.js');

    const before = getTabs().length;

    const first = openOrFocusInternalPage('profiles');
    expect(first).toBeTruthy();
    expect(first.url).toBe('freedom://profiles');
    expect(getTabs().length).toBe(before + 1);

    // Open a different tab so 'profiles' is no longer active.
    createTab('http://example.com/');

    const second = openOrFocusInternalPage('profiles');
    expect(second.id).toBe(first.id); // reused, not duplicated
    expect(getTabs().length).toBe(before + 2); // only the example.com tab was added
    expect(getActiveTab().id).toBe(first.id); // switched back to it
  });

  test('openInNewTabWithTarget focuses an existing internal page (system menu path)', async () => {
    const { openInNewTabWithTarget, openOrFocusInternalPage, getTabs } = await import('./tabs.js');

    // Ensure a profiles tab exists, then simulate the native "Manage Profiles"
    // menu item, which routes through tab:new-with-url → openInNewTabWithTarget.
    const existing = openOrFocusInternalPage('profiles');
    const before = getTabs().length;

    const reused = openInNewTabWithTarget('freedom://profiles', null);
    expect(reused.id).toBe(existing.id); // focused, not duplicated
    expect(getTabs().length).toBe(before); // no new tab opened
  });

  // Runs before any bare `freedom://settings` tab is created below — a
  // `settings/profile` URL only reuses a base `settings` tab, and none exists
  // yet, so this must open a fresh deep-link tab.
  test('openInNewTabWithTarget opens a deep-link tab when no settings tab exists', async () => {
    const { openInNewTabWithTarget, getTabs } = await import('./tabs.js');

    const before = getTabs().length;
    const opened = openInNewTabWithTarget('freedom://settings/profile', null);

    expect(getTabs().length).toBe(before + 1); // a new tab, since none to reuse
    expect(opened.url).toBe('freedom://settings/profile'); // tab.url keeps the friendly form

    // A trusted internal page is resolved to its real file:// URL and loaded as
    // the webview's initial src — NOT parked on about:blank first. Parking left a
    // blank entry in the back history, so the toolbar Back button went blank.
    const srcCalls = opened.webview.setAttribute.mock.calls.filter(([attr]) => attr === 'src');
    const srcValue = srcCalls.at(-1)?.[1];
    expect(srcValue).toBe('file:///app/pages/settings.html#profile');
    expect(srcValue).not.toBe('about:blank');
  });

  test('openInNewTabWithTarget reuses a settings tab for a settings sub-path', async () => {
    jest.useFakeTimers();
    try {
      const { openInNewTabWithTarget, openOrFocusInternalPage, getTabs, setLoadTargetHandler } =
        await import('./tabs.js');

      const onLoadTarget = jest.fn();
      setLoadTargetHandler(onLoadTarget);

      // A plain settings tab is open; the profile-manager edit pencil opens
      // freedom://settings/profile, which must reuse it (not open a duplicate)
      // and route the reused tab to the profile section.
      const existing = openOrFocusInternalPage('settings');
      const before = getTabs().length;

      const reused = openInNewTabWithTarget('freedom://settings/profile', null);
      expect(reused.id).toBe(existing.id); // focused, not duplicated
      expect(getTabs().length).toBe(before); // no new tab opened

      jest.runOnlyPendingTimers();
      // Routed to the section, in the reused tab's own webview — named
      // explicitly so a background open (#303) can't land the navigation in
      // whatever tab the user is still looking at.
      expect(onLoadTarget).toHaveBeenCalledWith(
        'freedom://settings/profile',
        null,
        existing.webview
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('reuses a still-resolving sub-path tab instead of racing it to a duplicate', async () => {
    const { openOrFocusInternalPage, getTabs } = await import('./tabs.js');

    // First open lands a tab whose url is still the unresolved
    // freedom://history/recent form (not yet loaded to file://…/history.html).
    const first = openOrFocusInternalPage('history', 'recent');
    expect(first.url).toBe('freedom://history/recent');
    const after = getTabs().length;

    // A rapid second open (before the tab resolves) must reuse it. The matcher
    // recognises the freedom://<page>/<sub> form, so no duplicate is created.
    const second = openOrFocusInternalPage('history', 'recent');
    expect(second.id).toBe(first.id);
    expect(getTabs().length).toBe(after);

    // The bare-page open also reuses the resolving sub-path tab.
    const third = openOrFocusInternalPage('history');
    expect(third.id).toBe(first.id);
    expect(getTabs().length).toBe(after);
  });
});
