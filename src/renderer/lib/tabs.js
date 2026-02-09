// Tab management module
import { pushDebug } from './debug.js';
import { closeMenus } from './menus.js';
import { hideBookmarkContextMenu } from './bookmarks-ui.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';
import { setupWebviewContextMenu } from './page-context-menu.js';
import { homeUrl } from './page-urls.js';
import { setupWebviewProvider, setActiveWebview } from './dapp-provider.js';

const electronAPI = window.electronAPI;

// Callback for when context menu opens (to close other dropdowns like autocomplete)
let onContextMenuOpening = null;
export const setOnContextMenuOpening = (callback) => {
  onContextMenuOpening = callback;
};

// Set loading state for a specific tab (or active tab if no tabId)
export const setTabLoading = (isLoading, tabId = null) => {
  const tab = tabId
    ? tabState.tabs.find((t) => t.id === tabId)
    : tabState.tabs.find((t) => t.id === tabState.activeTabId);
  if (tab) {
    tab.isLoading = isLoading;
    renderTabs();
  }
};

// Update favicon for a specific tab
export const updateTabFavicon = async (tabId, pageUrl) => {
  const tab = tabState.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Skip for internal pages or empty URLs
  if (!pageUrl || pageUrl.startsWith('freedom://') || pageUrl.includes('/pages/')) {
    tab.favicon = null;
    renderTabs();
    return;
  }

  // Try to get cached favicon
  try {
    const favicon = await electronAPI?.getCachedFavicon?.(pageUrl);
    if (favicon) {
      tab.favicon = favicon;
      renderTabs();
    }
  } catch (err) {
    pushDebug(`[Tabs] Favicon cache lookup failed: ${err.message}`);
  }
};

// Tab state
const tabState = {
  tabs: [],
  activeTabId: null,
  nextTabId: 1,
};

// Map of named link targets to tab IDs (e.g. "mywindow" -> 3)
// Used to reuse tabs when links specify target="mywindow"
const namedTargets = new Map();

// Stack of recently closed tabs for Ctrl+Shift+T (reopen closed tab)
const closedTabsStack = [];
const MAX_CLOSED_TABS = 20;

// Push current tab state to the main process for menu item enable/disable
const pushTabMenuState = () => {
  const activeIndex = tabState.tabs.findIndex((t) => t.id === tabState.activeTabId);
  electronAPI?.updateTabMenuState?.({
    tabCount: tabState.tabs.length,
    activeIndex,
    hasClosedTabs: closedTabsStack.length > 0,
  });
};

// DOM elements (initialized in initTabs)
let tabBar = null;
let newTabBtn = null;
let webviewContainer = null;
let tabContextMenu = null;

// Context menu state
let contextMenuTabId = null;

// Webview preload path for internal pages (fetched at init)
let webviewPreloadPath = null;

// Event handler references (set by navigation.js)
let onWebviewEvent = null;
let onLoadTarget = null;
let onReload = null;
let onHardReload = null;

export const setWebviewEventHandler = (handler) => {
  onWebviewEvent = handler;
};

export const setLoadTargetHandler = (handler) => {
  onLoadTarget = handler;
};

export const setReloadHandler = (handler) => {
  onReload = handler;
};

export const setHardReloadHandler = (handler) => {
  onHardReload = handler;
};

// Get the currently active tab
export const getActiveTab = () => {
  return tabState.tabs.find((t) => t.id === tabState.activeTabId) || null;
};

// Get all open tabs (for autocomplete)
export const getOpenTabs = () => {
  return tabState.tabs.map((tab) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    isActive: tab.id === tabState.activeTabId,
  }));
};

// Get the webview of the currently active tab
export const getActiveWebview = () => {
  const tab = getActiveTab();
  return tab ? tab.webview : null;
};

// Toggle DevTools for the active webview (pop-out window)
export const toggleDevTools = () => {
  const webview = getActiveWebview();
  if (!webview) return;

  if (webview.isDevToolsOpened()) {
    webview.closeDevTools();
    pushDebug('DevTools closed');
  } else {
    webview.openDevTools();
    pushDebug('DevTools opened');
  }
};

// Close DevTools for the active webview (if open)
export const closeDevTools = () => {
  const webview = getActiveWebview();
  if (!webview) return;

  if (webview.isDevToolsOpened()) {
    webview.closeDevTools();
    pushDebug('DevTools closed');
  }
};

// Close DevTools for all tabs (used during app quit)
export const closeAllDevTools = () => {
  for (const tab of tabState.tabs) {
    if (tab.webview?.isDevToolsOpened?.()) {
      try {
        tab.webview.closeDevTools();
      } catch (e) {
        pushDebug(`[Tabs] closeDevTools failed: ${e.message}`);
      }
    }
  }
  pushDebug('All DevTools closed');
};

// Get all tabs
export const getTabs = () => tabState.tabs;

// Create default navigation state for a tab
const createNavigationState = () => ({
  currentPageUrl: '',
  pendingNavigationUrl: '',
  pendingTitleForUrl: null,
  hasNavigatedDuringCurrentLoad: false,
  isWebviewLoading: false,
  currentBzzBase: null,
  addressBarSnapshot: '',
  cachedWebContentsId: null,
  resolvingWebContentsId: null,
});

// Get navigation state of the active tab
export const getActiveTabState = () => {
  const tab = getActiveTab();
  return tab ? tab.navigationState : null;
};

// Update the active tab's title and re-render
export const updateActiveTabTitle = (title) => {
  const tab = getActiveTab();
  if (tab) {
    tab.title = title;
    renderTabs();
  }
};

// Create a webview element
const createWebview = (tabId, initialUrl) => {
  const webview = document.createElement('webview');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('allowfullscreen', '');
  webview.setAttribute(
    'webpreferences',
    'contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes,enableRemoteModule=no'
  );

  // Always set preload for API access (internal pages use freedomAPI)
  if (webviewPreloadPath) {
    webview.setAttribute('preload', `file://${webviewPreloadPath}`);
  }

  webview.setAttribute('src', initialUrl);
  webview.dataset.tabId = tabId;

  // Create named event handlers so they can be removed later
  const handlers = {
    'did-start-loading': () => {
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab) {
        tab.isLoading = true;
        renderTabs();
      }
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('did-start-loading', { tabId });
      }
    },
    'did-stop-loading': () => {
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab) {
        tab.isLoading = false;
        tab.url = webview.getURL();
        renderTabs();
      }
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('did-stop-loading', { tabId, url: webview.getURL() });
      }
    },
    'did-fail-load': (event) => {
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab) {
        tab.isLoading = false;
      }
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('did-fail-load', { tabId, event });
      }
    },
    'did-navigate': (event) => {
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab) {
        // Use webview.getURL() for full URL (includes view-source: prefix)
        // event.url doesn't include the view-source: prefix
        const webviewUrl = webview.getURL();
        tab.url = webviewUrl;
        tab.hasCertError = false; // Reset cert error on new navigation
        // Track view-source state directly on tab for reliable detection in page-title-updated
        tab.isViewingSource = webviewUrl.startsWith('view-source:');
        // Clear favicon and set title for home page navigation (e.g., when hitting back)
        if (homeUrl && (event.url === homeUrl || event.url.endsWith('/pages/home.html'))) {
          tab.favicon = null;
          tab.title = 'New Tab';
          renderTabs();
          if (tabId === tabState.activeTabId) {
            electronAPI?.setWindowTitle?.('');
          }
        }
        // Clear favicon for view-source pages (they should use default globe icon)
        if (tab.isViewingSource) {
          tab.favicon = null;
          renderTabs();
        }
      }
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('did-navigate', { tabId, event });
      }
    },
    'did-navigate-in-page': (event) => {
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('did-navigate-in-page', { tabId, event });
      }
    },
    'page-title-updated': (event) => {
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab) {
        const currentUrl = webview.getURL();
        // For home page, always use "New Tab" regardless of what the page reports
        if (homeUrl && (currentUrl === homeUrl || currentUrl.endsWith('/pages/home.html'))) {
          if (tab.title !== 'New Tab') {
            tab.title = 'New Tab';
            renderTabs();
            if (tabId === tabState.activeTabId) {
              electronAPI?.setWindowTitle?.('');
            }
          }
          return;
        }
        // For view-source pages, keep the "view-source:<address>" title set by navigation.js
        // Don't override with the page's <title> content
        if (tab.isViewingSource) {
          return;
        }
        const title = event.title?.trim();
        // Only update if we have a meaningful title (not empty and not just the URL)
        if (title && title !== currentUrl) {
          tab.title = title;
          renderTabs();
          if (tabId === tabState.activeTabId) {
            electronAPI?.setWindowTitle?.(title);
          }
        }
      }
    },
    'dom-ready': () => {
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('dom-ready', { tabId });
      }
    },
    'console-message': (event) => {
      if (tabId === tabState.activeTabId) {
        const location = event.sourceId ? `${event.sourceId}:${event.line}` : '';
        pushDebug(
          `Console level-${event.level}: ${event.message}${location ? ` (${location})` : ''}`
        );
      }
    },
    'certificate-error': (event) => {
      // Track certificate errors for security indicator
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab) {
        tab.hasCertError = true;
      }
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('certificate-error', { tabId, event });
      }
    },
  };

  // Attach event listeners
  for (const [eventName, handler] of Object.entries(handlers)) {
    webview.addEventListener(eventName, handler);
  }

  // Store handlers reference for cleanup
  webview._eventHandlers = handlers;

  // Set up context menu listener
  setupWebviewContextMenu(webview);

  // Set up Ethereum provider (window.ethereum)
  setupWebviewProvider(webview);

  return webview;
};

// SVG for the inverse corner curves (connects active tab to toolbar)
// These create concave curves that bow INWARD toward the corner
// Left: curve from top-right to bottom-left, bowing toward bottom-right corner
// Right: curve from top-left to bottom-right, bowing toward bottom-left corner
const CORNER_LEFT_SVG = `<svg viewBox="0 0 10 10"><path d="M10 0C10 5.52 5.52 10 0 10H10Z"/></svg>`;
const CORNER_RIGHT_SVG = `<svg viewBox="0 0 10 10"><path d="M0 0C0 5.52 4.48 10 10 10H0Z"/></svg>`;

// Default globe icon (same as address bar HTTP icon)
const GLOBE_ICON_SVG = `<svg class="tab-icon-default" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

// Loading spinner (same style as address bar)
const SPINNER_HTML = `<span class="tab-icon-spinner"></span>`;

// Map to track existing tab DOM elements by tab ID
const tabElements = new Map();

// Drag state for tab reordering
let draggedTabId = null;
let isDragging = false;

// Create a new tab DOM element
const createTabElement = (tab) => {
  const tabEl = document.createElement('button');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = tab.id;
  tabEl.draggable = true;

  // Tab icon container (favicon, spinner, or default globe)
  const iconContainer = document.createElement('span');
  iconContainer.className = 'tab-icon-container';

  // Add default globe icon and spinner first (via innerHTML)
  iconContainer.innerHTML = GLOBE_ICON_SVG + SPINNER_HTML;

  // Favicon image (hidden by default) - append after innerHTML to preserve element
  const faviconEl = document.createElement('img');
  faviconEl.className = 'tab-favicon';
  faviconEl.alt = '';
  faviconEl.src = tab.favicon || '';
  iconContainer.appendChild(faviconEl);

  // Set initial state
  if (tab.isLoading) {
    iconContainer.dataset.state = 'loading';
  } else if (tab.favicon) {
    iconContainer.dataset.state = 'favicon';
  } else {
    iconContainer.dataset.state = 'default';
  }

  tabEl.appendChild(iconContainer);

  // Tab title
  const titleEl = document.createElement('span');
  titleEl.className = 'tab-title';
  titleEl.textContent = tab.title || 'New Tab';
  tabEl.appendChild(titleEl);

  // Close button
  const closeEl = document.createElement('button');
  closeEl.className = 'tab-close';
  closeEl.innerHTML =
    '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>';
  closeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });
  tabEl.appendChild(closeEl);

  // Corner placeholders (will be populated when active)
  const cornerLeft = document.createElement('div');
  cornerLeft.className = 'tab-corner tab-corner-left';
  tabEl.appendChild(cornerLeft);

  const cornerRight = document.createElement('div');
  cornerRight.className = 'tab-corner tab-corner-right';
  tabEl.appendChild(cornerRight);

  // Separator placeholder
  const separator = document.createElement('div');
  separator.className = 'tab-separator';
  tabEl.appendChild(separator);

  tabEl.addEventListener('click', () => {
    // Don't switch tabs if we just finished dragging
    if (isDragging) return;
    switchTab(tab.id);
  });

  // Middle-click to close tab
  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      // Middle mouse button
      e.preventDefault();
      closeTab(tab.id);
    }
  });

  // Right-click context menu
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, tab.id);
  });

  // Drag-and-drop reordering
  tabEl.addEventListener('dragstart', (e) => {
    isDragging = true;
    draggedTabId = tab.id;
    tabEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.id.toString());
  });

  tabEl.addEventListener('dragend', () => {
    draggedTabId = null;
    tabEl.classList.remove('dragging');
    // Remove drag-over classes from all tabs
    for (const el of tabElements.values()) {
      el.classList.remove('drag-over-left', 'drag-over-right');
    }
    // Reset isDragging after a short delay to prevent the click from firing
    setTimeout(() => {
      isDragging = false;
    }, 0);
  });

  tabEl.addEventListener('dragover', (e) => {
    if (draggedTabId === null || draggedTabId === tab.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Determine if we're on the left or right half of the tab
    const rect = tabEl.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    const isLeft = e.clientX < midpoint;

    // Update visual indicator
    tabEl.classList.toggle('drag-over-left', isLeft);
    tabEl.classList.toggle('drag-over-right', !isLeft);
  });

  tabEl.addEventListener('dragleave', () => {
    tabEl.classList.remove('drag-over-left', 'drag-over-right');
  });

  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (draggedTabId === null || draggedTabId === tab.id) return;

    const draggedIndex = tabState.tabs.findIndex((t) => t.id === draggedTabId);
    const targetIndex = tabState.tabs.findIndex((t) => t.id === tab.id);
    if (draggedIndex === -1 || targetIndex === -1) return;

    // Determine insert position based on drop position
    const rect = tabEl.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    const insertBefore = e.clientX < midpoint;

    // Remove the dragged tab from its current position
    const [draggedTab] = tabState.tabs.splice(draggedIndex, 1);

    // Calculate new index (accounting for the removal)
    let newIndex = targetIndex;
    if (draggedIndex < targetIndex) {
      newIndex--; // Adjust because we removed an item before the target
    }
    if (!insertBefore) {
      newIndex++; // Insert after the target
    }

    // Insert at new position
    tabState.tabs.splice(newIndex, 0, draggedTab);

    // Clean up drag state
    tabEl.classList.remove('drag-over-left', 'drag-over-right');

    renderTabs();
    pushTabMenuState();
    pushDebug(`Reordered tab ${draggedTabId} to position ${newIndex}`);
  });

  return tabEl;
};

// Update an existing tab element with current state
const updateTabElement = (tabEl, tab, isActive, isBeforeActive) => {
  // Update classes
  tabEl.classList.toggle('active', isActive);
  tabEl.classList.toggle('before-active', isBeforeActive);
  tabEl.classList.toggle('pinned', !!tab.pinned);

  // Update icon container state (loading, favicon, or default)
  const iconContainer = tabEl.querySelector('.tab-icon-container');
  const faviconEl = tabEl.querySelector('.tab-favicon');

  if (iconContainer) {
    if (tab.isLoading) {
      iconContainer.dataset.state = 'loading';
    } else if (tab.favicon) {
      iconContainer.dataset.state = 'favicon';
      if (faviconEl) {
        faviconEl.src = tab.favicon;
        faviconEl.onerror = () => {
          iconContainer.dataset.state = 'default';
        };
      }
    } else {
      iconContainer.dataset.state = 'default';
    }
  }

  // Update title
  const titleEl = tabEl.querySelector('.tab-title');
  const newTitle = tab.title || 'New Tab';
  if (titleEl.textContent !== newTitle) {
    titleEl.textContent = newTitle;
  }

  // Update corner SVGs (only present when active)
  const cornerLeft = tabEl.querySelector('.tab-corner-left');
  const cornerRight = tabEl.querySelector('.tab-corner-right');

  if (isActive) {
    if (!cornerLeft.innerHTML) cornerLeft.innerHTML = CORNER_LEFT_SVG;
    if (!cornerRight.innerHTML) cornerRight.innerHTML = CORNER_RIGHT_SVG;
  } else {
    if (cornerLeft.innerHTML) cornerLeft.innerHTML = '';
    if (cornerRight.innerHTML) cornerRight.innerHTML = '';
  }

  // Update separator visibility (via CSS, but control presence)
  const separator = tabEl.querySelector('.tab-separator');
  separator.style.display = !isActive && !isBeforeActive ? '' : 'none';
};

// Render the tab bar incrementally
const renderTabs = () => {
  if (!tabBar) return;

  const activeIndex = tabState.tabs.findIndex((t) => t.id === tabState.activeTabId);
  const currentTabIds = new Set(tabState.tabs.map((t) => t.id));

  // Remove DOM elements for tabs that no longer exist
  for (const [tabId, tabEl] of tabElements) {
    if (!currentTabIds.has(tabId)) {
      tabEl.remove();
      tabElements.delete(tabId);
    }
  }

  // Update or create tab elements in order
  let previousSibling = null;
  tabState.tabs.forEach((tab, index) => {
    const isActive = tab.id === tabState.activeTabId;
    const isBeforeActive = index === activeIndex - 1;

    let tabEl = tabElements.get(tab.id);

    if (!tabEl) {
      // Create new tab element
      tabEl = createTabElement(tab);
      tabElements.set(tab.id, tabEl);
    }

    // Update the element state
    updateTabElement(tabEl, tab, isActive, isBeforeActive);

    // Ensure correct DOM order
    const expectedNextSibling = previousSibling ? previousSibling.nextSibling : tabBar.firstChild;
    if (tabEl !== expectedNextSibling) {
      if (previousSibling) {
        previousSibling.after(tabEl);
      } else {
        tabBar.prepend(tabEl);
      }
    }

    previousSibling = tabEl;
  });
};

// Create a new tab
export const createTab = (url = null) => {
  const tabId = tabState.nextTabId++;
  const targetUrl = url || homeUrl;
  const webview = createWebview(tabId, targetUrl);

  const tab = {
    id: tabId,
    url: targetUrl,
    title: 'New Tab',
    isLoading: false,
    webview,
    navigationState: createNavigationState(),
  };

  tabState.tabs.push(tab);
  webviewContainer?.appendChild(webview);

  // Switch to the new tab
  switchTab(tabId, { isNewTab: true });

  pushDebug(`Created tab ${tabId}`);
  return tab;
};

// Remove webview event listeners to prevent memory leaks
const cleanupWebview = (webview) => {
  if (!webview) return;

  const handlers = webview._eventHandlers;
  if (handlers) {
    for (const [eventName, handler] of Object.entries(handlers)) {
      webview.removeEventListener(eventName, handler);
    }
    delete webview._eventHandlers;
  }
};

// Close a tab
export const closeTab = (tabId) => {
  const tabIndex = tabState.tabs.findIndex((t) => t.id === tabId);
  if (tabIndex === -1) return;

  const tab = tabState.tabs[tabIndex];

  // Save to closed tabs stack for reopening later (skip blank/empty tabs)
  const tabUrl = tab.url || tab.navigationState?.currentPageUrl;
  if (tabUrl && tabUrl !== 'about:blank' && tabUrl !== homeUrl) {
    closedTabsStack.push({ url: tabUrl, title: tab.title });
    if (closedTabsStack.length > MAX_CLOSED_TABS) {
      closedTabsStack.shift();
    }
  }

  // Close DevTools before removing webview (prevents crash)
  if (tab.webview?.isDevToolsOpened?.()) {
    tab.webview.closeDevTools();
  }

  // Remove event listeners before removing webview (prevents memory leak)
  cleanupWebview(tab.webview);

  // Remove webview from DOM
  tab.webview?.remove();

  // Remove tab element from DOM and map
  const tabEl = tabElements.get(tabId);
  if (tabEl) {
    tabEl.remove();
    tabElements.delete(tabId);
  }

  // Clean up named target association
  for (const [targetName, tid] of namedTargets) {
    if (tid === tabId) {
      namedTargets.delete(targetName);
      break;
    }
  }

  // Remove from array
  tabState.tabs.splice(tabIndex, 1);

  // If this was the active tab, switch to another
  if (tabState.activeTabId === tabId) {
    if (tabState.tabs.length > 0) {
      // Switch to the tab at the same index or the last one
      const newIndex = Math.min(tabIndex, tabState.tabs.length - 1);
      switchTab(tabState.tabs[newIndex].id);
    } else {
      // No more tabs - close window via IPC
      tabState.activeTabId = null;
      electronAPI?.closeWindow?.();
    }
  }

  renderTabs();
  pushTabMenuState();
  pushDebug(`Closed tab ${tabId}`);
};

// Close all tabs except the specified one
const closeOtherTabs = (tabId) => {
  const tabsToClose = tabState.tabs.filter((t) => t.id !== tabId && !t.pinned);
  for (const tab of tabsToClose) {
    closeTab(tab.id);
  }
  pushDebug(`Closed ${tabsToClose.length} other tabs`);
};

// Close all tabs to the right of the specified one
const closeTabsToRight = (tabId) => {
  const tabIndex = tabState.tabs.findIndex((t) => t.id === tabId);
  if (tabIndex === -1) return;

  const tabsToClose = tabState.tabs.slice(tabIndex + 1).filter((t) => !t.pinned);
  for (const tab of tabsToClose) {
    closeTab(tab.id);
  }
  pushDebug(`Closed ${tabsToClose.length} tabs to the right`);
};

// Reopen the last closed tab
export const reopenLastClosedTab = () => {
  const entry = closedTabsStack.pop();
  if (!entry) {
    pushDebug('No closed tabs to reopen');
    return;
  }
  pushDebug(`Reopening closed tab: ${entry.url}`);
  createTab(entry.url);
};

// Move the active tab left or right
export const moveTab = (direction) => {
  if (tabState.tabs.length < 2) return;

  const currentIndex = tabState.tabs.findIndex((t) => t.id === tabState.activeTabId);
  if (currentIndex === -1) return;

  let newIndex;
  if (direction === 'left') {
    if (currentIndex === 0) return; // Already at the start
    newIndex = currentIndex - 1;
  } else {
    if (currentIndex === tabState.tabs.length - 1) return; // Already at the end
    newIndex = currentIndex + 1;
  }

  // Swap positions
  const [tab] = tabState.tabs.splice(currentIndex, 1);
  tabState.tabs.splice(newIndex, 0, tab);

  renderTabs();
  pushTabMenuState();
  pushDebug(`Moved tab ${tabState.activeTabId} ${direction} to position ${newIndex}`);
};

// Switch to the next tab (wrapping around)
export const switchToNextTab = () => {
  if (tabState.tabs.length <= 1) return;
  const currentIndex = tabState.tabs.findIndex((t) => t.id === tabState.activeTabId);
  const nextIndex = (currentIndex + 1) % tabState.tabs.length;
  switchTab(tabState.tabs[nextIndex].id);
};

// Switch to the previous tab (wrapping around)
export const switchToPrevTab = () => {
  if (tabState.tabs.length <= 1) return;
  const currentIndex = tabState.tabs.findIndex((t) => t.id === tabState.activeTabId);
  const prevIndex = (currentIndex - 1 + tabState.tabs.length) % tabState.tabs.length;
  switchTab(tabState.tabs[prevIndex].id);
};

// Toggle pin state for a tab
const togglePinTab = (tabId) => {
  const tab = tabState.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  tab.pinned = !tab.pinned;

  // Reorder tabs: pinned tabs go to the left
  const pinnedTabs = tabState.tabs.filter((t) => t.pinned);
  const unpinnedTabs = tabState.tabs.filter((t) => !t.pinned);
  tabState.tabs = [...pinnedTabs, ...unpinnedTabs];

  renderTabs();
  pushTabMenuState();
  pushDebug(`${tab.pinned ? 'Pinned' : 'Unpinned'} tab ${tabId}`);
};

// Show context menu at position
const showContextMenu = (x, y, tabId) => {
  if (!tabContextMenu) return;

  // Close other menus first
  closeMenus();
  hideBookmarkContextMenu();
  onContextMenuOpening?.();
  showMenuBackdrop();

  contextMenuTabId = tabId;
  const tab = tabState.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Update pin button text
  const pinBtn = tabContextMenu.querySelector('[data-action="pin"]');
  if (pinBtn) {
    pinBtn.textContent = tab.pinned ? 'Unpin Tab' : 'Pin Tab';
  }

  // Disable "Close Tabs to the Right" if there are no tabs to the right (excluding pinned)
  const tabIndex = tabState.tabs.findIndex((t) => t.id === tabId);
  const tabsToRight = tabState.tabs.slice(tabIndex + 1).filter((t) => !t.pinned);
  const closeRightBtn = tabContextMenu.querySelector('[data-action="close-right"]');
  if (closeRightBtn) {
    closeRightBtn.disabled = tabsToRight.length === 0;
  }

  // Disable "Close Other Tabs" if there are no other closable tabs
  const otherTabs = tabState.tabs.filter((t) => t.id !== tabId && !t.pinned);
  const closeOthersBtn = tabContextMenu.querySelector('[data-action="close-others"]');
  if (closeOthersBtn) {
    closeOthersBtn.disabled = otherTabs.length === 0;
  }

  // Position menu
  tabContextMenu.style.left = `${x}px`;
  tabContextMenu.style.top = `${y}px`;
  tabContextMenu.classList.remove('hidden');

  // Adjust if menu goes off screen
  const rect = tabContextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    tabContextMenu.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight) {
    tabContextMenu.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
};

// Hide context menu
export const hideTabContextMenu = () => {
  const wasVisible = tabContextMenu && !tabContextMenu.classList.contains('hidden');
  if (tabContextMenu) {
    tabContextMenu.classList.add('hidden');
  }
  contextMenuTabId = null;
  if (wasVisible) {
    hideMenuBackdrop();
  }
};

// Switch to a tab
export const switchTab = (tabId, options = {}) => {
  const tab = tabState.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  tabState.activeTabId = tabId;

  // Hide all webviews, show active one
  for (const t of tabState.tabs) {
    if (t.webview) {
      t.webview.classList.toggle('hidden', t.id !== tabId);
    }
  }

  // Update active webview for dApp provider
  if (tab.webview) {
    setActiveWebview(tab.webview);
  }

  // Update window title
  if (tab.title) {
    electronAPI?.setWindowTitle?.(tab.title);
  }

  // Notify navigation module
  if (onWebviewEvent) {
    onWebviewEvent('tab-switched', { tabId, tab, isNewTab: options.isNewTab || false });
  }

  renderTabs();
  pushTabMenuState();

  pushDebug(`Switched to tab ${tabId}`);
};

// Initialize tabs module
export const initTabs = async () => {
  // Initialize DOM elements
  tabBar = document.getElementById('tab-bar');
  newTabBtn = document.getElementById('new-tab-btn');
  webviewContainer = document.getElementById('webview-container');
  tabContextMenu = document.getElementById('tab-context-menu');

  // Context menu event handlers
  if (tabContextMenu) {
    tabContextMenu.addEventListener('click', (e) => {
      const action = e.target.dataset?.action;
      if (!action || !contextMenuTabId) return;

      switch (action) {
        case 'close':
          closeTab(contextMenuTabId);
          break;
        case 'close-others':
          closeOtherTabs(contextMenuTabId);
          break;
        case 'close-right':
          closeTabsToRight(contextMenuTabId);
          break;
        case 'pin':
          togglePinTab(contextMenuTabId);
          break;
      }
      hideTabContextMenu();
    });
  }

  // Hide context menu when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (tabContextMenu && !tabContextMenu.contains(e.target)) {
      hideTabContextMenu();
    }
  });

  // Hide context menu on escape or when window loses focus
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideTabContextMenu();
    }
  });
  window.addEventListener('blur', hideTabContextMenu);

  // Hide context menu when webview gets focus
  const webviewElement = document.getElementById('bzz-webview');
  webviewElement?.addEventListener('focus', hideTabContextMenu);
  webviewElement?.addEventListener('mousedown', hideTabContextMenu);

  // Fetch webview preload path for internal pages
  try {
    webviewPreloadPath = await electronAPI?.getWebviewPreloadPath?.();
    if (webviewPreloadPath) {
      pushDebug(`[Tabs] Webview preload path: ${webviewPreloadPath}`);
    }
  } catch (err) {
    console.error('[Tabs] Failed to get webview preload path:', err);
  }

  // New tab button
  newTabBtn?.addEventListener('click', () => {
    createTab(homeUrl);
  });

  // Menu IPC handlers
  electronAPI?.onNewTab?.(() => {
    createTab(homeUrl);
  });

  electronAPI?.onCloseTab?.(() => {
    if (tabState.activeTabId) {
      closeTab(tabState.activeTabId);
    }
  });

  electronAPI?.onNewTabWithUrl?.((url, targetName) => {
    if (url) {
      // Check if we should reuse an existing tab with this target name
      if (targetName && namedTargets.has(targetName)) {
        const existingTabId = namedTargets.get(targetName);
        const existingTab = tabState.tabs.find((t) => t.id === existingTabId);
        if (existingTab) {
          pushDebug(`Reusing tab ${existingTabId} for target "${targetName}": ${url}`);
          switchTab(existingTabId);
          // Navigate the existing tab to the new URL
          setTimeout(() => {
            if (onLoadTarget) {
              onLoadTarget(url);
            }
          }, 50);
          return;
        }
        // Tab no longer exists, clean up stale entry
        namedTargets.delete(targetName);
      }

      pushDebug(`Opening new tab with URL: ${url}${targetName ? ` (target: ${targetName})` : ''}`);

      // For http/https URLs, load directly without going through homeUrl first
      // This avoids the brief flash of the home page before navigation
      const isDirectUrl = url.startsWith('http://') || url.startsWith('https://');
      const newTab = createTab(isDirectUrl ? url : homeUrl);

      // Associate this tab with the target name if specified
      if (targetName && newTab) {
        namedTargets.set(targetName, newTab.id);
      }

      // For dweb URLs (ipfs://, ipns://, bzz://), use loadTarget for URL resolution
      if (!isDirectUrl) {
        setTimeout(() => {
          if (onLoadTarget) {
            onLoadTarget(url);
          }
        }, 50);
      }
    }
  });

  electronAPI?.onNavigateToUrl?.((url) => {
    if (url && onLoadTarget) {
      pushDebug(`Navigating to URL: ${url}`);
      onLoadTarget(url);
    }
  });

  // Handle loading URL in current tab (used by new window with URL)
  electronAPI?.onLoadUrl?.((url) => {
    if (url && onLoadTarget) {
      pushDebug(`Loading URL: ${url}`);
      onLoadTarget(url);
    }
  });

  electronAPI?.onToggleDevTools?.(() => {
    toggleDevTools();
  });

  electronAPI?.onCloseDevTools?.(() => {
    closeDevTools();
  });

  electronAPI?.onCloseAllDevTools?.(() => {
    closeAllDevTools();
  });

  electronAPI?.onFocusAddressBar?.(() => {
    const addressInput = document.getElementById('address-input');
    if (addressInput) {
      addressInput.focus();
      addressInput.select();
    }
  });

  electronAPI?.onReload?.(() => {
    if (onReload) {
      onReload();
    }
  });

  electronAPI?.onHardReload?.(() => {
    if (onHardReload) {
      onHardReload();
    }
  });

  electronAPI?.onNextTab?.(() => {
    switchToNextTab();
  });

  electronAPI?.onPrevTab?.(() => {
    switchToPrevTab();
  });

  electronAPI?.onMoveTabLeft?.(() => {
    moveTab('left');
  });

  electronAPI?.onMoveTabRight?.(() => {
    moveTab('right');
  });

  electronAPI?.onReopenClosedTab?.(() => {
    reopenLastClosedTab();
  });

  // Keyboard shortcuts (fallback for when menu doesn't handle it)
  window.addEventListener('keydown', (event) => {
    // Cmd+T - New tab (exclude Shift to avoid conflict with Cmd+Shift+T)
    if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      createTab(homeUrl);
    }
    // Cmd+W - Close tab (skip pinned tabs)
    if (event.metaKey && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      if (tabState.activeTabId) {
        const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
        if (activeTab && !activeTab.pinned) {
          closeTab(tabState.activeTabId);
        }
      }
    }
    // Cmd+Option+I (Mac) or Ctrl+Shift+I (Win/Linux) - Toggle DevTools
    if (
      (event.metaKey && event.altKey && event.key.toLowerCase() === 'i') ||
      (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'i')
    ) {
      event.preventDefault();
      toggleDevTools();
    }
    // Cmd+L (Mac) or Ctrl+L (Win/Linux) - Focus address bar
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      const addressInput = document.getElementById('address-input');
      if (addressInput) {
        addressInput.focus();
        addressInput.select();
      }
    }
    // Ctrl+Tab / Ctrl+PageDown - Next tab (all platforms)
    // Cmd+Shift+] - Next tab (macOS alternative)
    if (
      (event.ctrlKey && event.key === 'Tab' && !event.shiftKey) ||
      (event.ctrlKey && event.key === 'PageDown' && !event.shiftKey) ||
      (event.metaKey && event.shiftKey && event.key === ']')
    ) {
      event.preventDefault();
      switchToNextTab();
    }
    // Ctrl+Shift+Tab / Ctrl+PageUp - Previous tab (all platforms)
    // Cmd+Shift+[ - Previous tab (macOS alternative)
    if (
      (event.ctrlKey && event.key === 'Tab' && event.shiftKey) ||
      (event.ctrlKey && event.key === 'PageUp' && !event.shiftKey) ||
      (event.metaKey && event.shiftKey && event.key === '[')
    ) {
      event.preventDefault();
      switchToPrevTab();
    }
    // Ctrl+Shift+PageDown - Move tab right
    if (event.ctrlKey && event.shiftKey && event.key === 'PageDown') {
      event.preventDefault();
      moveTab('right');
    }
    // Ctrl+Shift+PageUp - Move tab left
    if (event.ctrlKey && event.shiftKey && event.key === 'PageUp') {
      event.preventDefault();
      moveTab('left');
    }
    // Ctrl+F4 - Close tab (Windows/Linux)
    if (event.ctrlKey && event.key === 'F4') {
      event.preventDefault();
      if (tabState.activeTabId) {
        const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
        if (activeTab && !activeTab.pinned) {
          closeTab(tabState.activeTabId);
        }
      }
    }
    // Cmd+Shift+T / Ctrl+Shift+T - Reopen closed tab
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      reopenLastClosedTab();
    }
    // F11 - Toggle fullscreen
    if (event.key === 'F11') {
      event.preventDefault();
      electronAPI?.toggleFullscreen?.();
    }
    // F12 - Toggle DevTools
    if (event.key === 'F12') {
      event.preventDefault();
      toggleDevTools();
    }
  });

  // Create initial tab - check for initialUrl query parameter (from "open in new window")
  const urlParams = new URLSearchParams(window.location.search);
  const initialUrl = urlParams.get('initialUrl');
  if (initialUrl) {
    // Create tab with about:blank to avoid home page flash, then navigate to target
    const tab = createTab('about:blank');
    if (tab && onLoadTarget) {
      // Set address bar immediately so user sees the URL while loading
      const addressInput = document.getElementById('address-input');
      if (addressInput) {
        addressInput.value = initialUrl;
      }
      // Use loadTarget for proper URL resolution (handles dweb URLs, ENS, etc.)
      setTimeout(() => onLoadTarget(initialUrl), 50);
    }
  } else {
    createTab(homeUrl);
  }
};
