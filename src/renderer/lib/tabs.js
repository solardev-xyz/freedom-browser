// Tab management module
import { pushDebug } from './debug.js';
import { closeMenus } from './menus.js';
import { hideBookmarkContextMenu } from './bookmarks-ui.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';
import { setupWebviewContextMenu } from './page-context-menu.js';
import { homeUrl, getInternalPageName, internalPages } from './page-urls.js';
import { getPrivatePartition, isPrivateWindow } from './private-mode.js';
import { setupWebviewProvider, setActiveWebview } from './dapp-provider.js';
import { setupSwarmProvider } from './swarm-provider.js';
import { setupRadicleProvider } from './radicle-provider.js';
import { closeFindBar, notifyFindBarNavigated } from './find-bar.js';
import { matchesShortcut } from './shortcuts.js';
import {
  clearLinkStatus,
  clearHoverStatus,
  showLinkStatus,
  setLinkStatusSide,
} from './link-status.js';

const electronAPI = window.electronAPI;

// Callback for when context menu opens (to close other dropdowns like autocomplete)
let onContextMenuOpening = null;
export const setOnContextMenuOpening = (callback) => {
  onContextMenuOpening = callback;
};

// Set loading state for a specific tab (or active tab if no tabId).
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

  // Skip for internal pages or empty URLs — internal pages that want a
  // favicon declare it via <link rel="icon"> and are picked up by the
  // page-favicon-updated webview event instead of the HTTP fetch pipeline.
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

// Get a tab by its numeric id, or null when no match is found.
export const getTabById = (tabId) => {
  if (tabId === null || tabId === undefined) return null;
  return tabState.tabs.find((t) => t.id === tabId) || null;
};

// Resolve the tab id stored on a webview's `data-tab-id` attribute, or
// null when the webview is unmanaged or missing the attribute. Centralised
// so the renderer doesn't sprinkle `Number(webview.dataset.tabId)` across
// async-tab-routing call sites.
export const getTabIdForWebview = (webview) => {
  if (!webview) return null;
  const raw = webview.dataset?.tabId;
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

// True when `tabId` matches the currently active tab. Used by async
// callbacks that want to gate UI updates (alerts, address bar writes,
// favicon refresh) on the originating tab still being foregrounded.
export const isActiveTab = (tabId) =>
  tabId !== null && tabId !== undefined && tabId === tabState.activeTabId;

/**
 * Get the committed display URL for a specific webview.
 * Reads from the tab's `committedDisplayUrl` — the last URL committed
 * by a `did-navigate` event for this tab's webview. Never falls back
 * to the live address bar input or to `addressBarSnapshot`, which is
 * transient draft/restoration state (overwritten on `focusin` and on
 * `tab-switched`, so it can carry unsubmitted typed-but-not-yet-loaded
 * values).
 *
 * This is critical for provider permission checks — if a page fires a
 * request while the user is typing in the address bar (or has switched
 * away from a tab whose snapshot now carries a draft), we must derive
 * the origin from the committed navigation identity, not partial input.
 *
 * Returns the empty string for tabs that haven't yet committed a
 * navigation. New tabs initialize `committedDisplayUrl: ''` and the
 * value is populated on the first `did-navigate`.
 *
 * @param {HTMLElement} webview - The webview element
 * @returns {string} The committed display URL for this webview's tab
 */
export const getDisplayUrlForWebview = (webview) => {
  const tab = tabState.tabs.find((t) => t.webview === webview);
  if (!tab) return '';
  return tab.navigationState?.committedDisplayUrl || '';
};

export const getNavigationKeyForWebview = (webview) => {
  const tab = tabState.tabs.find((candidate) => candidate.webview === webview);
  if (!tab) return '';
  return `${tab.id}:${tab.navigationState?.committedNavigationSequence || 0}`;
};

// Create default navigation state for a tab
const createNavigationState = () => ({
  currentPageUrl: '',
  pendingNavigationUrl: '',
  pendingTitleForUrl: null,
  hasNavigatedDuringCurrentLoad: false,
  isWebviewLoading: false,
  currentBzzBase: null,
  // `addressBarSnapshot` is transient draft/restoration state — it's
  // overwritten with `addressInput.value` on focusin and on tab-switched, so
  // it can hold unsubmitted user input (e.g. typed-but-not-submitted ENS
  // names). Reload and other commit-keyed decisions must NOT key on it; use
  // `committedDisplayUrl` instead.
  addressBarSnapshot: '',
  // `committedDisplayUrl` is the URL Chromium committed for this tab's
  // last navigation (`webview.getURL()` at did-navigate time, including
  // any view-source: prefix). It's written only by tabs.js' per-webview
  // did-navigate handler — never by focusin, tab-switched, or
  // setAddressDisplayForTab — so it stays a stable identity for the
  // active page even while the user is mid-typing or while a slow
  // navigation is in flight. Reload reads this to decide whether the
  // current page is ENS-backed, and `getDisplayUrlForWebview` returns
  // it so provider permission keys never see unsubmitted drafts or
  // pending destinations.
  committedDisplayUrl: '',
  committedNavigationSequence: 0,
  cachedWebContentsId: null,
  resolvingWebContentsId: null,
  pendingSwarmProbeId: null,
  swarmProbeVersion: 0,
});

// --- Tab audio state (indicator + mute) ------------------------------------

/**
 * Pure reducer for the tab-strip audio indicator.
 * Muted wins over audible so a muted tab keeps showing the muted-speaker
 * affordance (and stays unmutable) even while no sound is being produced.
 *
 * @param {{isMuted?: boolean, isAudible?: boolean}|null} tab
 * @returns {'muted'|'audible'|null} indicator to render, or null for none
 */
export const getTabAudioState = (tab) => {
  if (!tab) return null;
  if (tab.isMuted === true) return 'muted';
  if (tab.isAudible === true) return 'audible';
  return null;
};

// Sample a webview's audibility and update the tab flag. `fallback` is what
// the triggering media event implies, used when isCurrentlyAudible isn't
// available (tests, detached webviews) or throws (guest not attached yet).
const applyTabAudibleState = (tabId, fallback) => {
  const tab = tabState.tabs.find((t) => t.id === tabId);
  if (!tab || !tab.webview) return;
  let audible = fallback === true;
  try {
    if (typeof tab.webview.isCurrentlyAudible === 'function') {
      audible = tab.webview.isCurrentlyAudible() === true;
    }
  } catch {
    audible = fallback === true;
  }
  if (tab.isAudible !== audible) {
    tab.isAudible = audible;
    renderTabs();
  }
};

// One delayed re-sample per media edge (never self-rescheduling) so the
// indicator converges on the real audible state without a standing poll.
const AUDIBLE_RECHECK_MS = 1000;
const scheduleAudibleRecheck = (tabId) => {
  const tab = tabState.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tab.audioStateTimer) {
    clearTimeout(tab.audioStateTimer);
  }
  tab.audioStateTimer = setTimeout(() => {
    tab.audioStateTimer = null;
    applyTabAudibleState(tabId, tab.isAudible);
  }, AUDIBLE_RECHECK_MS);
};

// Push tab.isMuted down to the webview. Webview methods throw until the
// guest is attached, so failures are swallowed here and the flag — which
// lives on the tab, not the webview — is re-applied by the dom-ready
// handler. Muting is webContents-level, so it survives navigation without
// any extra bookkeeping.
const applyMuteToWebview = (tab) => {
  if (!tab?.webview || typeof tab.webview.setAudioMuted !== 'function') return;
  try {
    tab.webview.setAudioMuted(tab.isMuted === true);
  } catch {
    // Guest not attached yet — dom-ready re-applies.
  }
};

// Toggle mute for a tab: flips the tab flag immediately (indicator updates)
// and pushes it to the webview, with dom-ready as the fallback apply point.
export const toggleMuteTab = (tabId) => {
  const tab = tabState.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.isMuted = tab.isMuted !== true;
  applyMuteToWebview(tab);
  renderTabs();
  pushDebug(`${tab.isMuted ? 'Muted' : 'Unmuted'} tab ${tabId}`);
};

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

// The friendly URL of the private start page; private windows open new
// tabs here instead of the home page.
const PRIVATE_START_URL = 'freedom://private';

// URL every fresh tab in this window starts on.
const defaultNewTabUrl = () => (isPrivateWindow() ? PRIVATE_START_URL : homeUrl);

// True for both forms the private start page appears as in tab.url —
// the friendly freedom:// form while resolving and the resolved
// file://…/pages/private.html form once loaded.
//
// The resolved form is a bare suffix match, so it is scoped to private
// windows: in a NORMAL window a perfectly ordinary web page whose path ends
// in /pages/private.html (https://example.com/pages/private.html) would
// otherwise be silently excluded from the Ctrl/Cmd+Shift+T reopen stack.
// The internal page only ever loads from a file:// URL inside a private
// window, so the narrower check loses nothing.
const isPrivateStartUrl = (url) =>
  url === PRIVATE_START_URL ||
  (isPrivateWindow() &&
    typeof url === 'string' &&
    url.startsWith('file:') &&
    url.endsWith('/pages/private.html'));

// Create a webview element
const createWebview = (tabId, initialUrl) => {
  const webview = document.createElement('webview');
  // PRIVATE MODE GUARD (partition): in a private window every webview runs
  // on the window's unique non-persisted `private-<uuid>` session. The
  // partition attribute only takes effect before the first navigation, so
  // it is stamped here — before `src` is assigned — and never mutated.
  const privatePartition = getPrivatePartition();
  if (privatePartition) {
    webview.setAttribute('partition', privatePartition);
  }
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
        // A real load is starting — the phantom stop that proactive
        // suppression guards against has either already fired, been
        // elided by Chromium, or is interleaved earlier in this same
        // event-loop tick. Disarm so the paired real did-stop-loading
        // isn't swallowed. This is what keeps fast-scheme clicks
        // (freedom://, rad:, ethereum:) from getting a stuck spinner
        // when their real stop lands inside the 200 ms safety window.
        if (tab.suppressNextStop) {
          tab.suppressNextStop = false;
          if (tab.suppressNextStopTimer) {
            clearTimeout(tab.suppressNextStopTimer);
            tab.suppressNextStopTimer = null;
          }
        }
        tab.isLoading = true;
        renderTabs();
      }
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('did-start-loading', {
          tabId,
          url: webview.getURL(),
          pendingNavigationUrl: tab?.navigationState?.pendingNavigationUrl || '',
        });
      }
    },
    'did-stop-loading': () => {
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab) {
        // Paired suppression for the will-navigate intercept (see did-fail-load
        // below). The aborted nav fires `did-fail-load -3` then
        // `did-stop-loading`; both describe a phantom load that never had a
        // real start — they don't represent the real navigation we're about
        // to perform via `loadTarget`. Swallowing them entirely (including
        // the active-tab `onWebviewEvent` forwarding) prevents the
        // navigation-side handler from clearing `isLoading`, resetting the
        // reload button, or pushing the aborted URL into history mid-ENS-
        // resolution.
        if (tab.suppressNextStop) {
          tab.suppressNextStop = false;
          if (tab.suppressNextStopTimer) {
            clearTimeout(tab.suppressNextStopTimer);
            tab.suppressNextStopTimer = null;
          }
          return;
        }
        tab.isLoading = false;
        tab.url = webview.getURL();
        renderTabs();
      }
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('did-stop-loading', { tabId, url: webview.getURL() });
      }
    },
    'did-fail-load': (event) => {
      // Chromium fires `did-fail-load` for **any** frame, including hidden
      // sub-frames (verify-API attestation iframes, ad-tech cookie-sync
      // pixels, third-party widgets, etc.). Without this guard, every
      // failed sub-resource iframe load would clear the main-frame loading
      // state and — via the navigation-side handler — replace the entire
      // page with `pages/error.html`. That breaks WalletConnect-using
      // dapps and any site with heavy ad-tech under Freedom.
      //
      // Treat undefined as main-frame for backward compatibility with
      // tests that don't synthesize the field; production Electron always
      // sets it.
      if (event.isMainFrame === false) {
        return;
      }
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab) {
        // When the main process intercepts a `will-navigate` for a custom
        // protocol (bzz://, ens://, ipfs://, ipns://, freedom://, rad:,
        // ethereum:) it calls `event.preventDefault()` on the source
        // webview. Chromium emits `did-fail-load -3` (ERR_ABORTED) +
        // `did-stop-loading` for the cancelled navigation. We swallow
        // exactly that pair so the spinner survives the slow resolution
        // that follows. The aborted URL must match `tab.pendingAbortUrl`
        // — comparing URLs (rather than gating only on the flag's
        // presence) prevents an unrelated abort during the suppression
        // window (Stop button, programmatic abort) from being silently
        // consumed.
        //
        // Active-tab `onWebviewEvent` forwarding is also skipped for the
        // suppressed event since the navigation-side handler
        // unconditionally calls `setLoading(false)` and resets the
        // reload button — both wrong for the phantom abort.
        const abortedUrl = event.validatedURL || event.url || null;
        if (event.errorCode === -3 && tab.pendingAbortUrl && abortedUrl === tab.pendingAbortUrl) {
          tab.pendingAbortUrl = null;
          if (tab.pendingAbortTimer) {
            clearTimeout(tab.pendingAbortTimer);
            tab.pendingAbortTimer = null;
          }
          tab.suppressNextStop = true;
          return;
        }
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
        // Commit the post-navigation page identity for both active and
        // background tabs. This is the single source of truth for reload
        // ("what page are we actually on?") and for provider permission
        // keying (Swarm/dapp prompts), which must never see destination
        // URLs of in-flight navigations or unsubmitted address-bar drafts.
        // about:blank is skipped because Chromium fires did-navigate
        // through about:blank during "open in new window" before the real
        // loadURL runs; clobbering the previous commit there would lose
        // the actual page identity.
        if (tab.navigationState && event.url && event.url !== 'about:blank') {
          tab.navigationState.committedDisplayUrl = webviewUrl;
          tab.navigationState.committedNavigationSequence += 1;
        }
        // Clear any stale favicon from the previous page when navigating to
        // an internal page — page-favicon-updated will paint one back in if
        // the page declares a <link rel="icon">.
        if (isInternalPageUrl(event.url)) {
          tab.favicon = null;
          renderTabs();
        }
        // Reset title to "New Tab" on home-page navigation (e.g., back button)
        if (homeUrl && (event.url === homeUrl || event.url.endsWith('/pages/home.html'))) {
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
      // Navigation invalidates find-in-page results for the foreground
      // tab; the bar stays open with its query so Enter re-searches on
      // the new page.
      if (tabId === tabState.activeTabId) {
        notifyFindBarNavigated();
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
    'page-favicon-updated': (event) => {
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      // Only honor this event for internal pages. External sites flow through
      // the HTTP favicon pipeline (updateTabFavicon) which handles per-domain
      // caching across sessions; letting this event override it would race
      // with the cached value on subsequent loads.
      if (!isInternalPageUrl(webview.getURL())) return;
      const icon = event.favicons?.[0];
      if (!icon) return;
      tab.favicon = icon;
      renderTabs();
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
      // Re-apply the tab-level mute flag once the webview is attached and
      // ready. Covers mutes toggled before attach (races right after
      // createTab) — webview methods throw until the guest is live, so
      // this is the reliable apply point.
      const tab = tabState.tabs.find((t) => t.id === tabId);
      if (tab?.isMuted) {
        applyMuteToWebview(tab);
      }
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('dom-ready', { tabId });
      }
    },
    // Audio indicator state. Electron's <webview> emits media-started-playing /
    // media-paused (there is no per-webview audio-state-changed event — that
    // one only exists on main-process webContents), so on each media edge we
    // sample isCurrentlyAudible() where available and fall back to what the
    // event implies. A single delayed re-sample catches audibility settling
    // after the event (e.g. a video whose audio track fades in, or another
    // media element still playing when one pauses).
    'media-started-playing': () => {
      applyTabAudibleState(tabId, true);
      scheduleAudibleRecheck(tabId);
    },
    'media-paused': () => {
      applyTabAudibleState(tabId, false);
      scheduleAudibleRecheck(tabId);
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
    'ipc-message': (event) => {
      // Link-hover preview cursor-zone updates from webview-preload — flip
      // the bar to the opposite corner so it never covers the hovered link.
      // Handled directly here (not via navigation.js) because it doesn't
      // touch tab/navigation state.
      if (event.channel === 'link-status:zone') {
        if (tabId === tabState.activeTabId) {
          const tab = tabState.tabs.find((t) => t.id === tabId);
          const inLeftZone = event.args?.[0]?.inLeftZone === true;
          // Remember per-tab so switchTab can restore without waiting for
          // the preload to re-emit. The preload only emits on zone
          // transitions, and a hidden webview's `linkStatusInZone` freezes
          // at whatever value it held when the tab was backgrounded — so
          // without per-tab state, returning to a tab whose pointer is
          // still in the bottom-left band would leave the bar on the
          // default `left` side and paint it over the hovered link until
          // the pointer leaves and re-enters the zone.
          if (tab) {
            tab.linkStatusInLeftZone = inLeftZone;
          }
          setLinkStatusSide(inLeftZone ? 'right' : 'left');
        }
        return;
      }
      // Messages from internal pages (e.g. ens-unverified interstitial
      // bubbling a "Continue once" signal). Route through the registered
      // onWebviewEvent handler so navigation.js can stay the sole owner
      // of tab-state mutations.
      if (tabId === tabState.activeTabId && onWebviewEvent) {
        onWebviewEvent('ipc-message', { tabId, channel: event.channel, args: event.args });
      }
    },
    'update-target-url': (event) => {
      // Gate at the tab edge (same shape as `link-status:zone`) so the
      // link-status module never sees background-tab hover events. Empty
      // url → fade out; non-empty → start the show pipeline.
      if (tabId !== tabState.activeTabId) return;
      const url = typeof event.url === 'string' ? event.url : '';
      if (url) {
        showLinkStatus(url);
      } else {
        clearHoverStatus();
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

  // Set up providers (window.ethereum + window.swarm)
  setupWebviewProvider(webview);
  setupSwarmProvider(webview);
  setupRadicleProvider(webview);

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

// Internal pages are served from the bundled renderer (freedom:// or
// file:///…/pages/…). The HTTP favicon fetch pipeline skips them, so their
// favicons come in via the webview's page-favicon-updated event.
const isInternalPageUrl = (url) =>
  typeof url === 'string' && (url.startsWith('freedom://') || url.includes('/pages/'));

// Loading spinner (same style as address bar)
const SPINNER_HTML = `<span class="tab-icon-spinner"></span>`;

// Audio indicator icons — speaker (tab is audible) and muted speaker (tab is
// muted). Both live inside the .tab-audio button; CSS picks one via the
// tab's data-audio-state attribute.
const AUDIO_ON_SVG = `<svg class="tab-audio-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;
const AUDIO_MUTED_SVG = `<svg class="tab-audio-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;

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
  tabEl.dataset.test = 'tab';
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

  // Audio indicator / mute toggle (hidden unless the tab is audible or
  // muted — visibility driven by the tab's data-audio-state attribute).
  const audioBtn = document.createElement('button');
  audioBtn.className = 'tab-audio';
  audioBtn.dataset.test = 'tab-audio';
  audioBtn.innerHTML = AUDIO_ON_SVG + AUDIO_MUTED_SVG;
  audioBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMuteTab(tab.id);
  });
  tabEl.appendChild(audioBtn);

  // Tab title
  const titleEl = document.createElement('span');
  titleEl.className = 'tab-title';
  titleEl.textContent = tab.title || 'New Tab';
  tabEl.appendChild(titleEl);

  // Close button
  const closeEl = document.createElement('button');
  closeEl.className = 'tab-close';
  closeEl.dataset.test = 'tab-close';
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

  // Update audio indicator (speaker / muted speaker / hidden)
  const audioState = getTabAudioState(tab);
  if (audioState) {
    tabEl.dataset.audioState = audioState;
  } else {
    delete tabEl.dataset.audioState;
  }
  const audioBtn = tabEl.querySelector('.tab-audio');
  if (audioBtn) {
    audioBtn.title = audioState === 'muted' ? 'Unmute tab' : 'Mute tab';
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

// URLs `createTab` is allowed to load directly as the initial webview
// `src`. Everything else — dweb schemes, hostile `file://`/`data:`/
// `javascript:`, anything we don't recognise — is parked on
// `about:blank` and dispatched to `loadTarget`, which routes the
// schemes it understands and silently drops the rest. This narrow
// allowlist is what keeps `createTab('file:///etc/passwd')` (e.g. from
// a malicious `tab:new-with-url` IPC or `setWindowOpenHandler` flow)
// from turning into a direct local-file navigation.
const isDirectLoadUrl = (url) => {
  if (!url) return true;
  if (url === 'about:blank') return true;
  if (url === homeUrl) return true;
  return /^https?:\/\//i.test(url);
};

// Resolve a trusted `freedom://<page>[/<sub>]` URL to the real internal page URL
// (file://…/pages/<page>.html[#<sub>]) it ultimately loads, or null if `url`
// isn't a recognised internal page. This mirrors loadTarget's freedom://
// handling, but lets `createTab` load the resolved URL as the webview's *initial*
// src — so a freshly opened internal-page tab never parks on about:blank first.
// Parking it (the generic non-direct path) left an about:blank entry in the
// webview's back history, so the toolbar Back button landed on a blank page.
// Only URLs derived from the known internalPages map resolve here; arbitrary
// file:// stays excluded and keeps flowing through about:blank + loadTarget.
const resolveInternalPageUrl = (url) => {
  const target = freedomInternalPageTarget(url);
  if (!target) return null;
  const pageUrl = internalPages[target.pageName];
  if (!pageUrl) return null;
  return target.subPath ? `${pageUrl}#${target.subPath}` : pageUrl;
};

// Create a new tab
export const createTab = (url = null) => {
  const tabId = tabState.nextTabId++;
  // Direct loads: empty/null (use homeUrl), http(s), about:blank, and
  // the app's own `homeUrl` (production: file:///…/pages/home.html).
  // Anything else parks on about:blank while `onLoadTarget` resolves
  // it — this keeps dweb URLs working (their resolution pipeline takes
  // ~50 ms) without producing the GUEST_VIEW_MANAGER_CALL log noise
  // that pointing the webview at homeUrl first did, and prevents
  // hostile schemes from ever becoming a direct webview navigation.
  // Trusted internal freedom:// pages resolve to their real file://…/pages URL up
  // front and load directly — no about:blank parking step (which otherwise leaves
  // a blank entry in the back history; see resolveInternalPageUrl). tab.url keeps
  // the friendly freedom:// form so the address bar and singleton-tab reuse still
  // match on it while the page loads.
  // Empty/null falls back to this window's default new-tab page — the
  // private start page in private windows, the home page otherwise.
  const fallbackUrl = defaultNewTabUrl();
  const resolvedInternalUrl = resolveInternalPageUrl(url || fallbackUrl);
  const isDirect = resolvedInternalUrl != null || isDirectLoadUrl(url);
  const webviewUrl = resolvedInternalUrl || (isDirect ? url || fallbackUrl : 'about:blank');
  const webview = createWebview(tabId, webviewUrl);

  const tab = {
    id: tabId,
    url: url || fallbackUrl,
    title: 'New Tab',
    isLoading: false,
    isAudible: false,
    isMuted: false,
    webview,
    navigationState: createNavigationState(),
  };

  tabState.tabs.push(tab);
  webviewContainer?.appendChild(webview);

  // Switch to the new tab
  switchTab(tabId, { isNewTab: true });

  // Anything that isn't a direct-load URL flows through the resolution
  // pipeline. For routed schemes (bzz://, ipfs://, ens://, rad:,
  // ethereum:, view-source:, bare ENS names, and freedom:// pages that
  // aren't recognised internal pages) loadTarget performs the real
  // navigation; for unrecognised inputs (file://, data:, javascript:,
  // etc.) it falls through to a debug-log no-op, leaving the tab on
  // about:blank. Recognised freedom:// pages took the direct path above.
  if (!isDirect) {
    setTimeout(() => {
      if (onLoadTarget) onLoadTarget(url);
    }, 50);
  }

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

  // Save to closed tabs stack for reopening later (skip blank/empty tabs
  // and the private start page). The stack itself is per-window renderer
  // state, so a private window's closed tabs die with the window and can
  // never be resurrected from a normal window's Cmd/Ctrl+Shift+T.
  const tabUrl = tab.url || tab.navigationState?.currentPageUrl;
  if (tabUrl && tabUrl !== 'about:blank' && tabUrl !== homeUrl && !isPrivateStartUrl(tabUrl)) {
    closedTabsStack.push({ url: tabUrl, title: tab.title });
    if (closedTabsStack.length > MAX_CLOSED_TABS) {
      closedTabsStack.shift();
    }
  }

  // Close DevTools before removing webview (prevents crash)
  if (tab.webview?.isDevToolsOpened?.()) {
    tab.webview.closeDevTools();
  }

  // Cancel the phantom-abort safety-net timers if they're still pending —
  // otherwise they would fire on a detached tab object (writing to a dead
  // tab and pinning it for up to 1.5s after close).
  if (tab.pendingAbortTimer) {
    clearTimeout(tab.pendingAbortTimer);
    tab.pendingAbortTimer = null;
  }
  if (tab.suppressNextStopTimer) {
    clearTimeout(tab.suppressNextStopTimer);
    tab.suppressNextStopTimer = null;
  }
  if (tab.audioStateTimer) {
    clearTimeout(tab.audioStateTimer);
    tab.audioStateTimer = null;
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

  // Update mute button text
  const muteBtn = tabContextMenu.querySelector('[data-action="mute"]');
  if (muteBtn) {
    muteBtn.textContent = tab.isMuted ? 'Unmute Tab' : 'Mute Tab';
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
  // Already foreground — nothing to swap, and running the swap anyway has
  // real side effects (closing an open find bar, re-hiding webviews).
  if (tabState.activeTabId === tabId) return;

  // Reset the link-hover preview before swapping active tabs:
  // - immediate clear so the previous tab's URL never trails into the new tab
  // - restore side from the incoming tab's last-known cursor-zone state
  //   rather than blindly resetting to `left`. The preload's zone tracker
  //   only emits on transitions, and a hidden webview's `linkStatusInZone`
  //   freezes at whatever value it held when the tab was backgrounded —
  //   so the next zone IPC may never arrive until the pointer leaves and
  //   re-enters the band. Without restoring per-tab state, returning to
  //   a tab whose pointer is in the bottom-left band would leave the bar
  //   on `left` and paint it over the hovered link.
  clearLinkStatus({ immediate: true });
  setLinkStatusSide(tab.linkStatusInLeftZone ? 'right' : 'left');
  tabState.activeTabId = tabId;

  // Find state follows the foreground page: close the bar and clear the
  // outgoing tab's highlights. Called after the activeTabId flip so the
  // close never returns focus to the (now background) searched webview —
  // the find module captured that webview when its session started.
  closeFindBar();

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

/**
 * Open a URL in a new tab, honouring named-target tab reuse.
 *
 * If `targetName` is a non-empty string and a tab is already mapped to
 * that name (via a previous call from this function or the
 * `setWindowOpenHandler` → `tab:new-with-url` IPC path), the existing
 * tab is switched to and re-navigated to the new URL. Otherwise a new
 * tab is created and (if the target name is named, i.e. not `_blank`
 * passed through verbatim) registered under that name.
 *
 * Used by both the main-process `tab:new-with-url` IPC handler (for
 * `setWindowOpenHandler`-routed http(s) windows) and the renderer's
 * `link:navigate` handler (for dweb-link clicks intercepted in
 * `webview-preload.js`). Centralising the named-target logic here
 * keeps both paths consistent — without it, `target="docs"` on a
 * `<a href="ipfs://...">` would silently lose its tab-reuse semantics
 * because dweb clicks bypass `setWindowOpenHandler` (so the click can
 * be intercepted before Chromium lowercases the host).
 *
 * @param {string} url - target URL
 * @param {string|null} targetName - HTML `target` attribute, if any
 * @returns {object|null} the (possibly new) tab, or null on noop
 */
// Parse a `freedom://<page>[/<sub>]` URL into `{ pageName, subPath }` when
// `<page>` is a recognised internal page, else null. A single sub-path segment
// is accepted (e.g. `freedom://settings/profile`) so deep links still resolve
// to the page's singleton tab — the sub-path routes the (possibly reused) tab
// to the right section. Anything deeper or unrecognised returns null.
const freedomInternalPageTarget = (url) => {
  const match = /^freedom:\/\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/?$/i.exec(url || '');
  if (!match || !internalPages) return null;
  const pageName = match[1].toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(internalPages, pageName)) return null;
  return { pageName, subPath: match[2] ? match[2].toLowerCase() : null };
};

export const openInNewTabWithTarget = (url, targetName) => {
  if (!url) return null;

  // EVERY freedom:// internal page (profiles, history, settings, …) is treated
  // as a singleton: an untargeted open focuses the existing tab instead of
  // opening a duplicate — same behaviour as the hamburger menu, and deliberately
  // applied to all internal pages, not just profiles. (Trade-off: you can no
  // longer open two history/settings tabs via a link or tab:new-with-url; use a
  // named target to keep the explicit reuse semantics below.) A sub-path
  // (settings/profile) reuses the base page's tab and routes it to that section.
  if (!targetName) {
    const internal = freedomInternalPageTarget(url);
    if (internal) return openOrFocusInternalPage(internal.pageName, internal.subPath);
  }

  if (targetName && namedTargets.has(targetName)) {
    const existingTabId = namedTargets.get(targetName);
    const existingTab = tabState.tabs.find((t) => t.id === existingTabId);
    if (existingTab) {
      pushDebug(`Reusing tab ${existingTabId} for target "${targetName}": ${url}`);
      switchTab(existingTabId);
      setTimeout(() => {
        if (onLoadTarget) {
          onLoadTarget(url);
        }
      }, 50);
      return existingTab;
    }
    namedTargets.delete(targetName);
  }

  pushDebug(`Opening new tab with URL: ${url}${targetName ? ` (target: ${targetName})` : ''}`);

  // Pass the target URL through to createTab (not homeUrl). createTab
  // already does the right thing for both shapes: direct URLs load
  // straight into the webview (no home-page flash), and dweb URLs
  // (ens://, bzz://, ipfs://, ipns://, etc.) keep the webview on
  // homeUrl while routing through `onLoadTarget` for resolution.
  // Critically, this also makes `tab.url` reflect the actual target,
  // so the `tab-switched` handler can derive a meaningful address bar
  // value immediately instead of leaving it empty until ENS resolves.
  const newTab = createTab(url);

  if (targetName && newTab) {
    namedTargets.set(targetName, newTab.id);
  }

  return newTab;
};

/**
 * Open an internal page (e.g. 'profiles', 'settings') in its own tab. If a tab
 * already has that page open, switch to it instead of opening a duplicate.
 *
 * `tab.url` holds the resolved `file://…/pages/<page>.html` form once loaded,
 * but the `freedom://<page>` form while the tab is still resolving — match both.
 *
 * An optional `subPath` (e.g. 'profile' for `freedom://settings/profile`)
 * routes the page to a section: a reused tab is navigated there, and a freshly
 * opened tab is created on the deep link. Tab matching is always by base page,
 * so the edit pencil's `settings/profile` reuses a plain `settings` tab.
 *
 * @param {string} pageName - internal page name, e.g. 'profiles'
 * @param {string|null} [subPath] - optional section within the page
 * @returns {object|null} the focused or newly created tab, or null on noop
 */
export const openOrFocusInternalPage = (pageName, subPath = null) => {
  if (!pageName) return null;

  const fullUrl = subPath ? `freedom://${pageName}/${subPath}` : `freedom://${pageName}`;

  const existingTab = tabState.tabs.find((tab) => {
    if (!tab.url) return false;
    // Resolved file://…/pages/<page>.html form (page already loaded).
    if ((getInternalPageName(tab.url) || '').split('/')[0] === pageName) return true;
    // Unresolved freedom://<page>[/<sub>] form while the tab is still resolving.
    // Matching by base page (sub-path and all) lets a rapid second open of
    // e.g. freedom://settings/profile reuse the in-flight tab instead of
    // racing it to a duplicate. getInternalPageName only recognises the
    // resolved file:// form, so this arm is what covers the resolving window.
    return freedomInternalPageTarget(tab.url)?.pageName === pageName;
  });

  if (existingTab) {
    pushDebug(`Focusing existing ${pageName} tab ${existingTab.id}`);
    switchTab(existingTab.id);
    // Route the reused tab to the requested section. switchTab makes it active,
    // so onLoadTarget lands in its webview. (Same switch-then-load handoff the
    // named-target reuse path above uses.) Bare pages need no re-navigation.
    if (subPath && onLoadTarget) {
      setTimeout(() => onLoadTarget(fullUrl), 50);
    }
    return existingTab;
  }

  pushDebug(`Opening ${pageName} in a new tab`);
  return createTab(fullUrl);
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
        case 'mute':
          toggleMuteTab(contextMenuTabId);
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
    createTab(defaultNewTabUrl());
  });

  // Menu IPC handlers
  electronAPI?.onNewTab?.(() => {
    createTab(defaultNewTabUrl());
  });

  electronAPI?.onCloseTab?.(() => {
    if (tabState.activeTabId) {
      closeTab(tabState.activeTabId);
    }
  });

  electronAPI?.onNewTabWithUrl?.((url, targetName) => {
    if (url) {
      openInNewTabWithTarget(url, targetName || null);
    }
  });

  electronAPI?.onNavigateToUrl?.((url) => {
    if (url && onLoadTarget) {
      pushDebug(`Navigating to URL: ${url}`);
      // The main process intercepted a will-navigate for a custom protocol
      // (`bzz://`, `ens://`, `ipfs://`, `ipns://`, `freedom://`, `rad:`,
      // `ethereum:`) and called `event.preventDefault()`. That prevent
      // causes Chromium to emit a phantom `did-stop-loading` (sometimes
      // also preceded by `did-fail-load -3`) on the source webview for
      // the cancelled navigation, which would clear `tab.isLoading` and
      // kill the spinner during the slow ENS lookup that follows.
      //
      // We mark the active tab here so the per-tab handlers in
      // `createWebview` can swallow exactly that one phantom. Active tab
      // is correct because the user just clicked a link in the
      // foreground. `pendingAbortUrl` (1500 ms self-clear) is the primary
      // matcher used by `did-fail-load` when Chromium emits one.
      //
      // We also arm `suppressNextStop` proactively (with its own 200 ms
      // self-clear) for two reasons exposed by live tracing:
      //   1. The `<webview>` events and the `navigate-to-url` IPC
      //      travel on independent channels, so the phantom can land
      //      *after* this handler runs but *before* `did-fail-load`
      //      arrives — there is no time for the existing chain
      //      (did-fail-load → arm `suppressNextStop`) to fire.
      //   2. Chromium can elide `did-fail-load -3` entirely for an
      //      intercepted navigation, emitting only `did-start-loading`
      //      → `did-stop-loading`. Without proactive arming, the
      //      paired `did-stop-loading` has no entry point that would
      //      mark it as a phantom.
      // The 200 ms cap is far shorter than any real `did-stop-loading`
      // following the ENS resolution + content fetch, so an unconsumed
      // flag can't swallow a legitimate later stop.
      const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
      if (activeTab) {
        activeTab.pendingAbortUrl = url;
        if (activeTab.pendingAbortTimer) {
          clearTimeout(activeTab.pendingAbortTimer);
        }
        activeTab.pendingAbortTimer = setTimeout(() => {
          activeTab.pendingAbortUrl = null;
          activeTab.pendingAbortTimer = null;
        }, 1500);

        activeTab.suppressNextStop = true;
        if (activeTab.suppressNextStopTimer) {
          clearTimeout(activeTab.suppressNextStopTimer);
        }
        activeTab.suppressNextStopTimer = setTimeout(() => {
          activeTab.suppressNextStop = false;
          activeTab.suppressNextStopTimer = null;
        }, 200);
      }
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

  // Keyboard shortcuts (fallback for when menu doesn't handle it).
  // Every binding resolves through the shared shortcut registry — including
  // fixed aliases (Ctrl+Tab, Ctrl+F4, F12, …) and any user remaps, which
  // apply live via settings:updated.
  window.addEventListener('keydown', (event) => {
    // New tab
    if (matchesShortcut(event, 'tab.new')) {
      event.preventDefault();
      createTab(defaultNewTabUrl());
    }
    // New private window (fallback for when the menu accelerator doesn't
    // handle it — e.g. the frameless/auto-hidden menu bar on Linux)
    if (matchesShortcut(event, 'window.newPrivate')) {
      event.preventDefault();
      electronAPI?.newPrivateWindow?.();
    }
    // Close tab (skip pinned tabs)
    if (matchesShortcut(event, 'tab.close')) {
      event.preventDefault();
      if (tabState.activeTabId) {
        const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
        if (activeTab && !activeTab.pinned) {
          closeTab(tabState.activeTabId);
        }
      }
    }
    // Toggle DevTools (Cmd/Ctrl+Alt+I, Ctrl+Shift+I, F12)
    if (matchesShortcut(event, 'devtools.toggle')) {
      event.preventDefault();
      toggleDevTools();
    }
    // Focus address bar
    if (matchesShortcut(event, 'view.focusAddressBar')) {
      event.preventDefault();
      const addressInput = document.getElementById('address-input');
      if (addressInput) {
        addressInput.focus();
        addressInput.select();
      }
    }
    // Next tab (Ctrl+PageDown; aliases Ctrl+Tab, Cmd+Shift+])
    if (matchesShortcut(event, 'tab.next')) {
      event.preventDefault();
      switchToNextTab();
    }
    // Previous tab (Ctrl+PageUp; aliases Ctrl+Shift+Tab, Cmd+Shift+[)
    if (matchesShortcut(event, 'tab.previous')) {
      event.preventDefault();
      switchToPrevTab();
    }
    // Move tab right
    if (matchesShortcut(event, 'tab.moveRight')) {
      event.preventDefault();
      moveTab('right');
    }
    // Move tab left
    if (matchesShortcut(event, 'tab.moveLeft')) {
      event.preventDefault();
      moveTab('left');
    }
    // Reopen closed tab
    if (matchesShortcut(event, 'tab.reopenClosed')) {
      event.preventDefault();
      reopenLastClosedTab();
    }
    // Toggle fullscreen
    if (matchesShortcut(event, 'view.fullscreen')) {
      event.preventDefault();
      electronAPI?.toggleFullscreen?.();
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
    createTab(defaultNewTabUrl());
  }
};
