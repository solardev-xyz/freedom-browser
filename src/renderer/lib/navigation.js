// Navigation, webview, and address bar handling
import { state } from './state.js';
import { pushDebug } from './debug.js';
import { updateBookmarkButtonVisibility } from './bookmarks-ui.js';
import { updateGithubBridgeIcon } from './github-bridge-ui.js';
import {
  formatBzzUrl,
  formatIpfsUrl,
  formatRadicleUrl,
  deriveDisplayValue,
  deriveBzzBaseFromUrl,
  deriveIpfsBaseFromUrl,
  deriveRadBaseFromUrl,
  applyEnsNamePreservation,
} from './url-utils.js';
import {
  getActiveWebview,
  getActiveTab,
  getActiveTabState,
  setWebviewEventHandler,
  updateActiveTabTitle,
  updateTabFavicon,
  setTabLoading,
  getTabs,
} from './tabs.js';
import {
  homeUrl,
  homeUrlNormalized,
  errorUrlBase,
  internalPages,
  detectProtocol,
  isHistoryRecordable,
  getInternalPageName,
  parseEnsInput,
} from './page-urls.js';

// Helper to get active tab's navigation state (with fallback to empty object)
const getNavState = () => getActiveTabState() || {};

const electronAPI = window.electronAPI;

// DOM elements (initialized in initNavigation)
let addressInput = null;
let navForm = null;
let backBtn = null;
let forwardBtn = null;
let reloadBtn = null;
let homeBtn = null;
let bookmarksBar = null;
let protocolIcon = null;

// Track previous active tab ID to save address bar state when switching
let previousActiveTabId = null;

// Bookmark bar toggle state: true = always show, false = hide on non-home pages (default)
let bookmarkBarOverride = false;

// Last recorded URL to avoid duplicates in quick succession
let lastRecordedUrl = null;

// Track if current tab is viewing source (view-source: URLs report inner URL in events)
let isViewingSource = false;

// Callback when history is recorded (for autocomplete cache refresh)
let onHistoryRecorded = null;
export const setOnHistoryRecorded = (callback) => {
  onHistoryRecorded = callback;
};

const setLoading = (isLoading) => {
  setTabLoading(isLoading);
  updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
};

// Track certificate status for current page
let currentPageSecure = false;

// Update protocol icon based on address bar value
const updateProtocolIcon = () => {
  if (!protocolIcon) return;

  const value = (addressInput?.value || '').toLowerCase();
  let protocol = 'http'; // Default to HTTP/globe icon

  if (value.startsWith('ens://') || value.endsWith('.eth') || value.endsWith('.box')) {
    // For ENS names, show the underlying protocol icon
    const ensName = value.startsWith('ens://') ? value.slice(6).split('/')[0] : value.split('/')[0];
    const resolvedProtocol = state.ensProtocols.get(ensName);
    protocol = resolvedProtocol || 'http'; // Fallback to http if not yet resolved
  } else if (value.startsWith('bzz://')) {
    protocol = 'swarm';
  } else if (value.startsWith('ipfs://')) {
    protocol = 'ipfs';
  } else if (value.startsWith('ipns://')) {
    protocol = 'ipns';
  } else if (value.startsWith('rad://')) {
    protocol = 'radicle';
  } else if (value.startsWith('freedom://')) {
    // Internal pages - no icon
    protocol = null;
  } else if (value.startsWith('https://') || currentPageSecure) {
    // HTTPS pages without certificate errors
    protocol = 'https';
  }
  // For empty or any other input, use default 'http'

  if (protocol) {
    protocolIcon.setAttribute('data-protocol', protocol);
    protocolIcon.classList.add('visible');
  } else {
    protocolIcon.removeAttribute('data-protocol');
    protocolIcon.classList.remove('visible');
  }
};

// Set page security status (called from certificate-error handler)
export const setPageSecure = (secure) => {
  currentPageSecure = secure;
  updateProtocolIcon();
};

const updateNavigationState = () => {
  const webview = getActiveWebview();
  if (!webview) {
    if (backBtn) backBtn.disabled = true;
    if (forwardBtn) forwardBtn.disabled = true;
    return;
  }
  try {
    if (backBtn) backBtn.disabled = !webview.canGoBack();
    if (forwardBtn) forwardBtn.disabled = !webview.canGoForward();
  } catch (err) {
    pushDebug(`[Nav] Webview not ready for canGoBack/canGoForward: ${err.message}`);
    if (backBtn) backBtn.disabled = true;
    if (forwardBtn) forwardBtn.disabled = true;
  }
};

const ensureWebContentsId = () => {
  const navState = getNavState();
  if (navState.cachedWebContentsId) {
    return Promise.resolve(navState.cachedWebContentsId);
  }
  if (navState.resolvingWebContentsId) {
    return navState.resolvingWebContentsId;
  }
  navState.resolvingWebContentsId = new Promise((resolve) => {
    const attempt = () => {
      const webview = getActiveWebview();
      if (webview && typeof webview.getWebContentsId === 'function') {
        const value = webview.getWebContentsId();
        if (typeof value === 'number' && value > 0) {
          navState.cachedWebContentsId = value;
          resolve(value);
          return;
        }
      }
      setTimeout(attempt, 50);
    };
    attempt();
  });
  return navState.resolvingWebContentsId;
};

const syncBzzBase = (nextBase) => {
  const navState = getNavState();
  if (!electronAPI || (!electronAPI.setBzzBase && !electronAPI.clearBzzBase)) {
    return;
  }
  if (navState.currentBzzBase === nextBase) {
    return;
  }
  navState.currentBzzBase = nextBase || null;
  ensureWebContentsId()
    .then((id) => {
      if (!id) return;
      if (navState.currentBzzBase) {
        electronAPI.setBzzBase?.(id, navState.currentBzzBase);
      } else {
        electronAPI.clearBzzBase?.(id);
      }
    })
    .catch((err) => {
      console.error('Failed to sync bzz base', err);
    });
};

const syncIpfsBase = (nextBase) => {
  const navState = getNavState();
  if (!electronAPI || (!electronAPI.setIpfsBase && !electronAPI.clearIpfsBase)) {
    return;
  }
  if (navState.currentIpfsBase === nextBase) {
    return;
  }
  navState.currentIpfsBase = nextBase || null;
  ensureWebContentsId()
    .then((id) => {
      if (!id) return;
      if (navState.currentIpfsBase) {
        electronAPI.setIpfsBase?.(id, navState.currentIpfsBase);
      } else {
        electronAPI.clearIpfsBase?.(id);
      }
    })
    .catch((err) => {
      console.error('Failed to sync ipfs base', err);
    });
};

const syncRadBase = (nextBase) => {
  const navState = getNavState();
  if (!electronAPI || (!electronAPI.setRadBase && !electronAPI.clearRadBase)) {
    return;
  }
  if (navState.currentRadBase === nextBase) {
    return;
  }
  navState.currentRadBase = nextBase || null;
  ensureWebContentsId()
    .then((id) => {
      if (!id) return;
      if (navState.currentRadBase) {
        electronAPI.setRadBase?.(id, navState.currentRadBase);
      } else {
        electronAPI.clearRadBase?.(id);
      }
    })
    .catch((err) => {
      console.error('Failed to sync rad base', err);
    });
};

export const loadTarget = (value, displayOverride = null, targetWebview = null) => {
  // Use provided webview or fall back to active webview
  const webview = targetWebview || getActiveWebview();
  const navState = getNavState();
  if (!webview) {
    pushDebug('No active webview to load target');
    return;
  }

  // Handle view-source: URLs - need to resolve dweb URLs before loading
  if (value.startsWith('view-source:')) {
    isViewingSource = true; // Track that this tab is viewing source
    const innerUrl = value.slice(12); // 'view-source:'.length === 12

    // If inner URL is a dweb URL, we need to resolve it first
    // Check for ENS
    const ens = parseEnsInput(innerUrl);
    if (ens && electronAPI?.resolveEns) {
      const capturedWebview = webview;
      setLoading(true);
      addressInput.value = `view-source:ens://${ens.name}`;
      updateProtocolIcon();
      electronAPI
        .resolveEns(ens.name)
        .then((result) => {
          setLoading(false);
          if (!result || result.type !== 'ok') {
            alert(`ENS resolution failed for ${ens.name}: ${result?.reason || 'no response'}`);
            return;
          }
          // Build target URI with path suffix
          let targetUri = result.uri;
          if (ens.suffix) {
            try {
              const composed = new URL(ens.suffix, targetUri);
              targetUri = composed.toString();
            } catch {
              targetUri = `${targetUri.replace(/\/+$/, '')}${ens.suffix}`;
            }
          }

          // Store ENS name mapping
          const bzzMatch = targetUri.match(/^bzz:\/\/([a-fA-F0-9]+)/);
          if (bzzMatch) {
            state.knownEnsNames.set(bzzMatch[1].toLowerCase(), ens.name);
          }
          const ipfsMatch = targetUri.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
          if (ipfsMatch) {
            state.knownEnsNames.set(ipfsMatch[1], ens.name);
          }
          const ipnsMatch = targetUri.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
          if (ipnsMatch) {
            state.knownEnsNames.set(ipnsMatch[1], ens.name);
          }

          // Convert dweb URI to gateway URL
          let gatewayUrl;
          if (result.protocol === 'bzz' && bzzMatch) {
            gatewayUrl = `${state.bzzRoutePrefix}${targetUri.slice(6)}`; // Remove 'bzz://'
          } else if (result.protocol === 'ipfs' && ipfsMatch) {
            gatewayUrl = `${state.ipfsRoutePrefix}${targetUri.slice(7)}`; // Remove 'ipfs://'
          } else if (result.protocol === 'ipns' && ipnsMatch) {
            gatewayUrl = `${state.ipnsRoutePrefix}${targetUri.slice(7)}`; // Remove 'ipns://'
          } else {
            alert(`Unsupported protocol: ${result.protocol}`);
            return;
          }
          capturedWebview.loadURL(`view-source:${gatewayUrl}`);
        })
        .catch((err) => {
          setLoading(false);
          alert(`ENS resolution error: ${err.message}`);
        });
      return;
    }

    // Check for bzz:// URLs
    const bzzMatch = innerUrl.match(/^bzz:\/\/([a-fA-F0-9]+)(\/.*)?$/);
    if (bzzMatch) {
      const hash = bzzMatch[1];
      const path = bzzMatch[2] || '/';
      const gatewayUrl = `${state.bzzRoutePrefix}${hash}${path}`;
      addressInput.value = value;
      updateProtocolIcon();
      webview.loadURL(`view-source:${gatewayUrl}`);
      return;
    }

    // Check for ipfs:// URLs
    const ipfsMatch = innerUrl.match(/^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/);
    if (ipfsMatch) {
      const cid = ipfsMatch[1];
      const path = ipfsMatch[2] || '';
      const gatewayUrl = `${state.ipfsRoutePrefix}${cid}${path}`;
      addressInput.value = value;
      updateProtocolIcon();
      webview.loadURL(`view-source:${gatewayUrl}`);
      return;
    }

    // Check for ipns:// URLs
    const ipnsMatch = innerUrl.match(/^ipns:\/\/([A-Za-z0-9.-]+)(\/.*)?$/);
    if (ipnsMatch) {
      const name = ipnsMatch[1];
      const path = ipnsMatch[2] || '';
      const gatewayUrl = `${state.ipnsRoutePrefix}${name}${path}`;
      addressInput.value = value;
      updateProtocolIcon();
      webview.loadURL(`view-source:${gatewayUrl}`);
      return;
    }

    // For other URLs (http/https, already gateway URLs), load directly
    let displayInner = deriveDisplayValue(
      innerUrl,
      state.bzzRoutePrefix,
      homeUrlNormalized,
      state.ipfsRoutePrefix,
      state.ipnsRoutePrefix,
      state.radicleApiPrefix
    );
    displayInner = applyEnsNamePreservation(displayInner, state.knownEnsNames);
    const displayUrl = `view-source:${displayInner || innerUrl}`;
    addressInput.value = displayUrl;
    updateProtocolIcon();
    webview.loadURL(value);
    return;
  }

  // Not viewing source for regular navigation
  isViewingSource = false;

  // Handle freedom:// protocol for internal pages
  const fbMatch = value.match(/^freedom:\/\/([a-zA-Z0-9-]+)$/i);
  if (fbMatch) {
    const pageName = fbMatch[1].toLowerCase();
    const pageUrl = internalPages[pageName];
    if (pageUrl) {
      webview.loadURL(pageUrl);
      pushDebug(`Loading internal page: ${pageName}`);
    } else {
      pushDebug(`Unknown internal page: ${pageName}`);
      alert(
        `Unknown internal page: ${pageName}\nAvailable: ${Object.keys(internalPages).join(', ')}`
      );
    }
    return;
  }

  // Try ENS first (ens:// or .eth/.box addresses)
  const ens = parseEnsInput(value);
  if (ens && electronAPI?.resolveEns) {
    // Capture the webview reference before async operation to prevent loading in wrong tab
    const capturedWebview = webview;
    setLoading(true);
    pushDebug(`Resolving ENS name: ${ens.name}`);
    electronAPI
      .resolveEns(ens.name)
      .then((result) => {
        setLoading(false);
        if (!result) {
          alert('ENS resolution failed: no response');
          return;
        }

        if (result.type !== 'ok') {
          const reason = result.reason || 'Unknown error';
          pushDebug(`ENS resolution failed for ${ens.name}: ${reason}`);
          alert(`ENS resolution failed for ${ens.name}: ${reason}`);
          return;
        }

        if (result.protocol !== 'bzz' && result.protocol !== 'ipfs' && result.protocol !== 'ipns') {
          pushDebug(`ENS content for ${ens.name} uses unsupported protocol ${result.protocol}`);
          alert(
            `ENS content uses unsupported protocol "${result.protocol}". Supported: Swarm (bzz), IPFS, IPNS.`
          );
          return;
        }

        let targetUri = result.uri;
        if (ens.suffix) {
          try {
            const composed = new URL(ens.suffix, targetUri);
            targetUri = composed.toString();
          } catch {
            targetUri = `${targetUri.replace(/\/+$/, '')}${ens.suffix}`;
          }
        }

        pushDebug(`ENS resolved: ${ens.name} -> ${targetUri}`);

        // Store ENS name mapping for Swarm
        const bzzMatch = targetUri.match(/^bzz:\/\/([a-fA-F0-9]+)/);
        if (bzzMatch) {
          state.knownEnsNames.set(bzzMatch[1].toLowerCase(), ens.name);
          state.ensProtocols.set(ens.name, 'swarm');
        }

        // Store ENS name mapping for IPFS
        const ipfsMatch = targetUri.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
        if (ipfsMatch) {
          state.knownEnsNames.set(ipfsMatch[1], ens.name);
          state.ensProtocols.set(ens.name, 'ipfs');
        }

        // Store ENS name mapping for IPNS
        const ipnsMatch = targetUri.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
        if (ipnsMatch) {
          state.knownEnsNames.set(ipnsMatch[1], ens.name);
          state.ensProtocols.set(ens.name, 'ipfs'); // IPNS uses IPFS icon
        }

        // Pass captured webview to ensure we load in the correct tab
        loadTarget(
          targetUri,
          displayOverride || 'ens://' + ens.name + (ens.suffix || ''),
          capturedWebview
        );
      })
      .catch((err) => {
        setLoading(false);
        console.error('ENS resolution error', err);
        pushDebug(`ENS resolution error for ${ens.name}: ${err.message}`);
        alert(`ENS resolution error for ${ens.name}: ${err.message}`);
      });
    return;
  }

  // Try Radicle (rad:RID or rad://RID)
  if (value.trim().toLowerCase().startsWith('rad:') || value.trim().toLowerCase().startsWith('rad://')) {
    const radicleTarget = formatRadicleUrl(value, state.radicleBase);
    if (radicleTarget) {
      addressInput.value = displayOverride || radicleTarget.displayValue;
      pushDebug(`[AddressBar] Loading Radicle target, set to: ${addressInput.value}`);
      navState.pendingTitleForUrl = radicleTarget.targetUrl;
      navState.pendingNavigationUrl = radicleTarget.targetUrl;
      navState.hasNavigatedDuringCurrentLoad = false;
      // If node is offline, pass status param so rad-browser.html shows error immediately
      if (state.currentRadicleStatus === 'stopped' || state.currentRadicleStatus === 'error') {
        const offlineUrl = new URL(radicleTarget.targetUrl);
        offlineUrl.searchParams.set('status', 'offline');
        webview.loadURL(offlineUrl.toString());
      } else {
        webview.loadURL(radicleTarget.targetUrl);
      }
      pushDebug(`Loading ${radicleTarget.displayValue} via ${radicleTarget.targetUrl}`);
      // rad-browser.html handles its own API calls, no base sync needed
      syncRadBase(null);
      syncBzzBase(null);
      syncIpfsBase(null);
      updateProtocolIcon();
      return;
    }
    // Invalid Radicle ID — show error page
    const withoutScheme = value.trim().replace(/^rad:\/\//i, '').replace(/^rad:/i, '');
    pushDebug(`Invalid Radicle ID: ${withoutScheme}`);
    const errorUrl = new URL('pages/rad-browser.html', window.location.href);
    errorUrl.searchParams.set('error', 'invalid-rid');
    errorUrl.searchParams.set('input', withoutScheme);
    addressInput.value = value.trim();
    navState.pendingNavigationUrl = errorUrl.toString();
    navState.hasNavigatedDuringCurrentLoad = false;
    webview.loadURL(errorUrl.toString());
    syncRadBase(null);
    syncBzzBase(null);
    syncIpfsBase(null);
    return;
  }

  // Try IPFS (ipfs://, ipns://, or raw CID)
  const ipfsTarget = formatIpfsUrl(value, state.ipfsRoutePrefix);
  if (ipfsTarget) {
    // Clear ENS mapping if directly navigating (not via ENS resolution)
    if (!displayOverride?.startsWith('ens://')) {
      const cidMatch = ipfsTarget.displayValue.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
      const ipnsMatch = ipfsTarget.displayValue.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
      if (cidMatch) state.knownEnsNames.delete(cidMatch[1]);
      if (ipnsMatch) state.knownEnsNames.delete(ipnsMatch[1]);
    }
    addressInput.value = displayOverride || ipfsTarget.displayValue;
    pushDebug(`[AddressBar] Loading IPFS target, set to: ${addressInput.value}`);
    navState.pendingTitleForUrl = ipfsTarget.targetUrl;
    navState.pendingNavigationUrl = ipfsTarget.targetUrl;
    navState.hasNavigatedDuringCurrentLoad = false;
    webview.loadURL(ipfsTarget.targetUrl);
    pushDebug(`Loading ${ipfsTarget.displayValue} via ${ipfsTarget.targetUrl}`);
    syncIpfsBase(ipfsTarget.baseUrl || null);
    syncBzzBase(null); // Clear bzz base when loading IPFS
    syncRadBase(null); // Clear rad base when loading IPFS
    return;
  }

  // Try Swarm/bzz
  const target = formatBzzUrl(value, state.bzzRoutePrefix);
  if (target) {
    // Clear ENS mapping if directly navigating (not via ENS resolution)
    if (!displayOverride?.startsWith('ens://')) {
      const hashMatch = target.displayValue.match(/^bzz:\/\/([a-fA-F0-9]+)/);
      if (hashMatch) state.knownEnsNames.delete(hashMatch[1].toLowerCase());
    }
    addressInput.value = displayOverride || target.displayValue;
    pushDebug(`[AddressBar] Loading target, set to: ${addressInput.value}`);
    navState.pendingTitleForUrl = target.targetUrl;
    navState.pendingNavigationUrl = target.targetUrl;
    navState.hasNavigatedDuringCurrentLoad = false;
    webview.loadURL(target.targetUrl);
    pushDebug(`Loading ${target.displayValue} via ${target.targetUrl}`);
    syncBzzBase(target.baseUrl || null);
    syncIpfsBase(null); // Clear ipfs base when loading bzz
    syncRadBase(null); // Clear rad base when loading bzz
    return;
  }

  // Try HTTP/HTTPS URLs
  if (value.startsWith('http://') || value.startsWith('https://')) {
    addressInput.value = displayOverride || value;
    pushDebug(`[AddressBar] Loading HTTP(S) target: ${value}`);
    navState.pendingTitleForUrl = value;
    navState.pendingNavigationUrl = value;
    navState.hasNavigatedDuringCurrentLoad = false;
    webview.loadURL(value);
    pushDebug(`Loading ${value}`);
    syncBzzBase(null);
    syncIpfsBase(null);
    syncRadBase(null);
    return;
  }

  pushDebug('Ignoring empty input or invalid URL.');
};

const stopLoadingAndRestore = () => {
  const navState = getNavState();
  if (!navState.isWebviewLoading) {
    return false;
  }
  const webview = getActiveWebview();
  if (webview) {
    webview.stop();
  }
  navState.isWebviewLoading = false;
  const targetUrl = navState.hasNavigatedDuringCurrentLoad
    ? navState.pendingNavigationUrl || navState.currentPageUrl
    : navState.currentPageUrl;
  if (targetUrl) {
    const display = deriveDisplayValue(
      targetUrl,
      state.bzzRoutePrefix,
      homeUrlNormalized,
      state.ipfsRoutePrefix,
      state.ipnsRoutePrefix,
      state.radicleApiPrefix
    );
    addressInput.value = display;
    pushDebug(`[AddressBar] Restored to: ${display} (raw: ${targetUrl})`);
  }
  reloadBtn.dataset.state = 'reload';
  return true;
};

export const loadHomePage = () => {
  const webview = getActiveWebview();
  const navState = getNavState();
  if (!webview) {
    pushDebug('No active webview to load home page');
    return;
  }
  syncBzzBase(null);
  syncIpfsBase(null);
  syncRadBase(null);
  addressInput.value = '';
  updateProtocolIcon();
  navState.pendingNavigationUrl = homeUrlNormalized;
  navState.hasNavigatedDuringCurrentLoad = false;
  webview.loadURL(homeUrl);
  updateActiveTabTitle('New Tab');
  electronAPI?.setWindowTitle?.('');
  // Clear favicon for home page
  const activeTab = getActiveTab();
  if (activeTab) {
    updateTabFavicon(activeTab.id, null);
  }
  pushDebug('Loading home page');
};

// Shared error-page retry logic used by both reload variants and the reload button
const retryErrorPageOrReload = (webview, hard) => {
  const current = webview.getURL();
  if (current.startsWith(errorUrlBase) || current.includes('/error.html?')) {
    try {
      const originalUrl = new URL(current).searchParams.get('url');
      if (originalUrl) {
        pushDebug(`Retrying original URL from error page: ${originalUrl}`);
        loadTarget(originalUrl);
        return;
      }
    } catch (err) {
      pushDebug(`[Nav] Could not extract original URL from error page: ${err.message}`);
    }
  }

  if (hard) {
    webview.reloadIgnoringCache();
    pushDebug('Hard reload triggered');
  } else {
    webview.reload();
    pushDebug('Reload triggered');
  }
};

export const reloadPage = () => {
  const webview = getActiveWebview();
  if (!webview) return;
  retryErrorPageOrReload(webview, false);
};

export const hardReloadPage = () => {
  const webview = getActiveWebview();
  if (!webview) return;
  retryErrorPageOrReload(webview, true);
};

// Convert rad-browser.html URL back to rad:// format
const getRadicleDisplayUrl = (url) => {
  if (!url || !url.includes('rad-browser.html')) return null;
  try {
    const parsed = new URL(url);
    const rid = parsed.searchParams.get('rid');
    const path = parsed.searchParams.get('path') || '';
    if (rid) {
      return `rad://${rid}${path}`;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
};

const handleNavigationEvent = (event) => {
  const navState = getNavState();
  const webview = getActiveWebview();
  if (event.url) {
    pushDebug(`[Navigation] Event URL: ${event.url}`);

    // Check if we're on a view-source page by examining the actual webview URL
    // (event.url doesn't include the view-source: prefix, but webview.getURL() does)
    const webviewUrl = webview?.getURL?.() || '';
    const urlIsViewSource = webviewUrl.startsWith('view-source:');

    // Update view-source state (important for back/forward navigation)
    if (urlIsViewSource !== isViewingSource) {
      isViewingSource = urlIsViewSource;
      navState.isViewingSource = urlIsViewSource;
      pushDebug(
        `[Navigation] isViewingSource updated to: ${isViewingSource} (webview URL: ${webviewUrl})`
      );
    }

    // Handle view-source pages - derive display URL and update tab title
    if (urlIsViewSource) {
      // Skip home page navigation events during view-source load
      if (event.url === homeUrl || event.url === homeUrlNormalized) {
        return;
      }
      let displayInner = deriveDisplayValue(
        event.url,
        state.bzzRoutePrefix,
        homeUrlNormalized,
        state.ipfsRoutePrefix,
        state.ipnsRoutePrefix,
        state.radicleApiPrefix
      );
      displayInner = applyEnsNamePreservation(displayInner, state.knownEnsNames);
      const displayUrl = `view-source:${displayInner || event.url}`;
      addressInput.value = displayUrl;
      pushDebug(`[AddressBar] View source: ${displayUrl}`);
      navState.currentPageUrl = webviewUrl;
      // Update tab title to "view-source:<address>"
      updateActiveTabTitle(displayUrl);
      electronAPI?.setWindowTitle?.(displayUrl);
      updateNavigationState();
      updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
      updateProtocolIcon();
      return;
    }

    // Check for internal pages first
    const internalPageName = getInternalPageName(event.url);
    if (internalPageName && internalPageName !== 'home') {
      addressInput.value = `freedom://${internalPageName}`;
      pushDebug(`[AddressBar] Internal page: freedom://${internalPageName}`);
      electronAPI?.setWindowTitle?.(
        `${internalPageName.charAt(0).toUpperCase() + internalPageName.slice(1)}`
      );
      navState.pendingTitleForUrl = event.url;
      navState.pendingNavigationUrl = event.url;
      navState.currentPageUrl = event.url;
      navState.hasNavigatedDuringCurrentLoad = true;
      updateNavigationState();
      updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
      return;
    }

    // Check for rad-browser.html URLs (Radicle protocol)
    const radicleDisplayUrl = getRadicleDisplayUrl(event.url);
    if (radicleDisplayUrl) {
      addressInput.value = radicleDisplayUrl;
      pushDebug(`[AddressBar] Radicle page: ${radicleDisplayUrl}`);
      navState.pendingTitleForUrl = event.url;
      navState.pendingNavigationUrl = event.url;
      navState.currentPageUrl = event.url;
      navState.hasNavigatedDuringCurrentLoad = true;
      updateNavigationState();
      updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
      updateProtocolIcon();
      return;
    }

    if (event.url.startsWith(errorUrlBase)) {
      try {
        const parsed = new URL(event.url);
        const originalUrl = parsed.searchParams.get('url');
        if (originalUrl) {
          const display = deriveDisplayValue(
            originalUrl,
            state.bzzRoutePrefix,
            homeUrlNormalized,
            state.ipfsRoutePrefix,
            state.ipnsRoutePrefix,
            state.radicleApiPrefix
          );
          addressInput.value = display;
          pushDebug(`[AddressBar] Error Page -> Original: ${display}`);
        } else {
          addressInput.value = 'Error';
        }
      } catch (err) {
        pushDebug(`[Nav] Could not parse error page URL: ${err.message}`);
        addressInput.value = 'Error';
      }
      electronAPI?.setWindowTitle?.('Error');
    } else {
      let derived = deriveDisplayValue(
        event.url,
        state.bzzRoutePrefix,
        homeUrlNormalized,
        state.ipfsRoutePrefix,
        state.ipnsRoutePrefix,
        state.radicleApiPrefix
      );
      derived = applyEnsNamePreservation(derived, state.knownEnsNames);

      // Don't clear address bar if navigating to about:blank and it has a value
      // (happens during "open in new window" before loadTarget runs)
      if (event.url === 'about:blank' && addressInput.value) {
        pushDebug(`[AddressBar] Preserved (about:blank navigation)`);
      } else if (addressInput.value !== derived) {
        addressInput.value = derived;
        pushDebug(`[AddressBar] Updated to: ${derived} (derived from ${event.url})`);
      } else {
        pushDebug(`[AddressBar] Skipped update (already ${derived})`);
      }

      // Sync bases for all protocols
      const bzzBase = deriveBzzBaseFromUrl(event.url);
      const ipfsBase = deriveIpfsBaseFromUrl(event.url);
      const radBase = deriveRadBaseFromUrl(event.url);
      syncBzzBase(bzzBase);
      syncIpfsBase(ipfsBase);
      syncRadBase(radBase);
    }

    navState.pendingTitleForUrl = event.url;
    navState.pendingNavigationUrl = event.url;
    navState.currentPageUrl = event.url;
    navState.hasNavigatedDuringCurrentLoad = true;

    pushDebug(`Navigated to ${event.url}`);
  }
  updateNavigationState();
  updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
  updateProtocolIcon();
};

// Update bookmark bar visibility based on toggle state and current page
// Like Chrome: bookmark bar always shows on new tab page; toggle only affects other pages
const updateBookmarkBarState = (url) => {
  if (!bookmarksBar) return;
  const isHomePage = url === homeUrlNormalized || url === homeUrl || !url;
  if (isHomePage) {
    // Always show on new tab page regardless of toggle
    bookmarksBar.classList.remove('hidden');
  } else if (bookmarkBarOverride) {
    bookmarksBar.classList.remove('hidden');
  } else {
    bookmarksBar.classList.add('hidden');
  }
  // Disable the menu item on the new tab page (toggle has no effect there)
  electronAPI?.setBookmarkBarToggleEnabled?.(!isHomePage);
};

// Toggle bookmark bar visibility and persist to settings
export const toggleBookmarkBar = async () => {
  bookmarkBarOverride = !bookmarkBarOverride;
  // Apply immediately
  const webview = getActiveWebview();
  const url = webview?.getURL?.() || '';
  updateBookmarkBarState(url);
  // Sync checkbox state in system menu
  electronAPI?.setBookmarkBarChecked?.(bookmarkBarOverride);
  pushDebug(`Bookmark bar: ${bookmarkBarOverride ? 'always shown' : 'always hidden'}`);
  // Persist to settings
  const settings = await electronAPI?.getSettings?.();
  if (settings) {
    settings.showBookmarkBar = bookmarkBarOverride;
    await electronAPI?.saveSettings?.(settings);
  }
};

// Called when settings change to refresh current page if needed
export const onSettingsChanged = () => {
  const navState = getNavState();
  if (navState.currentPageUrl && navState.currentPageUrl.startsWith('bzz://')) {
    loadTarget(addressInput.value);
  }
};

export const initNavigation = () => {
  // Initialize DOM elements
  addressInput = document.getElementById('address-input');
  navForm = document.getElementById('nav-form');
  backBtn = document.getElementById('back-btn');
  forwardBtn = document.getElementById('forward-btn');
  reloadBtn = document.getElementById('reload-btn');
  homeBtn = document.getElementById('home-btn');
  bookmarksBar = document.querySelector('.bookmarks');
  protocolIcon = document.getElementById('protocol-icon');

  // Load bookmark bar visibility from saved settings
  electronAPI?.getSettings?.().then((settings) => {
    if (settings && typeof settings.showBookmarkBar === 'boolean') {
      bookmarkBarOverride = settings.showBookmarkBar;
      electronAPI?.setBookmarkBarChecked?.(bookmarkBarOverride);
    }
  });

  // Address bar events
  addressInput.addEventListener('focus', () => {
    addressInput.select();
  });

  addressInput.addEventListener('focusin', () => {
    const navState = getNavState();
    navState.addressBarSnapshot = addressInput.value;
  });

  // Update protocol icon as user types
  addressInput.addEventListener('input', () => {
    updateProtocolIcon();
  });

  addressInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      const navState = getNavState();
      if (!stopLoadingAndRestore() && navState.addressBarSnapshot) {
        addressInput.value = navState.addressBarSnapshot;
      } else if (navState.pendingTitleForUrl) {
        addressInput.value = deriveDisplayValue(
          navState.pendingTitleForUrl,
          state.bzzRoutePrefix,
          homeUrlNormalized,
          state.ipfsRoutePrefix,
          state.ipnsRoutePrefix,
          state.radicleApiPrefix
        );
      }
      updateProtocolIcon();
      addressInput.blur();
    }
  });

  // Form submission (navigate)
  navForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = addressInput.value;

    // Handle freedom:// protocol for internal pages
    const fbMatch = raw.match(/^freedom:\/\/([a-zA-Z0-9-]+)$/i);
    if (fbMatch) {
      const pageName = fbMatch[1].toLowerCase();
      const pageUrl = internalPages[pageName];
      if (pageUrl) {
        const webview = getActiveWebview();
        if (webview) {
          webview.loadURL(pageUrl);
          pushDebug(`Loading internal page: ${pageName}`);
        }
      } else {
        pushDebug(`Unknown internal page: ${pageName}`);
        alert(
          `Unknown internal page: ${pageName}\nAvailable: ${Object.keys(internalPages).join(', ')}`
        );
      }
      addressInput.blur();
      return;
    }

    const ens = parseEnsInput(raw);

    if (ens && electronAPI?.resolveEns) {
      // Capture the webview reference before async operation to prevent loading in wrong tab
      const capturedWebview = getActiveWebview();
      setLoading(true);
      pushDebug(`Resolving ENS name: ${ens.name}`);
      electronAPI
        .resolveEns(ens.name)
        .then((result) => {
          setLoading(false);
          if (!result) {
            alert('ENS resolution failed: no response');
            return;
          }

          if (result.type !== 'ok') {
            const reason = result.reason || 'Unknown error';
            pushDebug(`ENS resolution failed for ${ens.name}: ${reason}`);
            alert(`ENS resolution failed for ${ens.name}: ${reason}`);
            return;
          }

          // Support both Swarm (bzz) and IPFS protocols
          if (
            result.protocol !== 'bzz' &&
            result.protocol !== 'ipfs' &&
            result.protocol !== 'ipns'
          ) {
            pushDebug(`ENS content for ${ens.name} uses unsupported protocol ${result.protocol}`);
            alert(
              `ENS content uses unsupported protocol "${result.protocol}". Supported: Swarm (bzz), IPFS, IPNS.`
            );
            return;
          }

          let targetUri = result.uri;
          if (ens.suffix) {
            try {
              const composed = new URL(ens.suffix, targetUri);
              targetUri = composed.toString();
            } catch {
              targetUri = `${targetUri.replace(/\/+$/, '')}${ens.suffix}`;
            }
          }

          pushDebug(`ENS resolved: ${ens.name} -> ${targetUri}`);

          // Store ENS name mapping for Swarm
          const bzzMatch = targetUri.match(/^bzz:\/\/([a-fA-F0-9]+)/);
          if (bzzMatch) {
            state.knownEnsNames.set(bzzMatch[1].toLowerCase(), ens.name);
            state.ensProtocols.set(ens.name, 'swarm');
          }

          // Store ENS name mapping for IPFS
          const ipfsMatch = targetUri.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
          if (ipfsMatch) {
            state.knownEnsNames.set(ipfsMatch[1], ens.name);
            state.ensProtocols.set(ens.name, 'ipfs');
          }

          // Store ENS name mapping for IPNS
          const ipnsMatch = targetUri.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
          if (ipnsMatch) {
            state.knownEnsNames.set(ipnsMatch[1], ens.name);
            state.ensProtocols.set(ens.name, 'ipfs'); // IPNS uses IPFS icon
          }

          // Pass captured webview to ensure we load in the correct tab
          loadTarget(targetUri, 'ens://' + ens.name + (ens.suffix || ''), capturedWebview);
          addressInput.blur();
        })
        .catch((err) => {
          setLoading(false);
          console.error('ENS resolution error', err);
          pushDebug(`ENS resolution error for ${ens.name}: ${err.message}`);
          alert(`ENS resolution error for ${ens.name}: ${err.message}`);
        });
    } else {
      const target = formatBzzUrl(raw, state.bzzRoutePrefix);
      if (target) {
        let hashToCheck = null;
        if (target.targetUrl.startsWith('bzz://')) {
          const match = target.targetUrl.match(/^bzz:\/\/([a-fA-F0-9]+)/);
          if (match) hashToCheck = match[1];
        } else if (target.baseUrl) {
          const match = target.baseUrl.match(/\/bzz\/([a-fA-F0-9]+)/);
          if (match) hashToCheck = match[1];
        }
        if (hashToCheck) {
          state.knownEnsNames.delete(hashToCheck.toLowerCase());
        }
      }

      loadTarget(raw);
      addressInput.blur();
    }
  });

  // Navigation buttons
  backBtn.addEventListener('click', () => {
    const webview = getActiveWebview();
    if (webview?.canGoBack()) webview.goBack();
  });

  forwardBtn.addEventListener('click', () => {
    const webview = getActiveWebview();
    if (webview?.canGoForward()) webview.goForward();
  });

  reloadBtn.addEventListener('click', (e) => {
    const navState = getNavState();
    if (navState.isWebviewLoading) {
      stopLoadingAndRestore();
      reloadBtn.dataset.state = 'reload';
      return;
    }

    const webview = getActiveWebview();
    if (!webview) return;

    retryErrorPageOrReload(webview, e.shiftKey);
  });

  homeBtn?.addEventListener('click', () => {
    loadHomePage();
  });

  // Register webview event handler with tabs module
  setWebviewEventHandler((eventName, data) => {
    const webview = getActiveWebview();
    const navState = getNavState();

    switch (eventName) {
      case 'did-start-loading':
        setLoading(true);
        navState.isWebviewLoading = true;
        reloadBtn.dataset.state = 'stop';
        pushDebug('Webview started loading.');
        break;

      case 'did-stop-loading':
        setLoading(false);
        navState.isWebviewLoading = false;
        navState.hasNavigatedDuringCurrentLoad = false;
        navState.pendingNavigationUrl = '';
        reloadBtn.dataset.state = 'reload';
        if (data.url) {
          updateBookmarkBarState(data.url);
        }
        updateNavigationState();

        // Record history entry after successful page load
        {
          const displayUrl = addressInput?.value;
          const internalUrl = data.url;
          const activeTab = getActiveTab();

          // Update favicon for current tab (always, not just when recording history)
          // Skip internal pages and view-source pages (view-source should use default globe icon)
          if (
            activeTab &&
            displayUrl &&
            !displayUrl.startsWith('freedom://') &&
            !displayUrl.startsWith('view-source:')
          ) {
            // Fetch and cache favicon in background, then update tab favicon
            // Use displayUrl as cache key (so bzz://, ipfs:// sites get unique favicons)
            // Use internalUrl for fetching (the actual HTTP gateway URL)
            electronAPI
              ?.fetchFaviconWithKey?.(internalUrl, displayUrl)
              .then((favicon) => {
                if (favicon) {
                  updateTabFavicon(activeTab.id, displayUrl);
                }
              })
              .catch((err) => {
                pushDebug(`[Nav] Favicon fetch failed for ${displayUrl}: ${err.message}`);
              });

            // Also try to show cached favicon immediately
            updateTabFavicon(activeTab.id, displayUrl);
          }

          // Record history (only once per URL)
          if (isHistoryRecordable(displayUrl, internalUrl) && displayUrl !== lastRecordedUrl) {
            const title = activeTab?.title || '';
            const protocol = detectProtocol(displayUrl);

            electronAPI
              ?.addHistory?.({
                url: displayUrl,
                title,
                protocol,
              })
              .then(() => {
                pushDebug(`[History] Recorded: ${displayUrl}`);
                // Notify autocomplete to refresh cache
                onHistoryRecorded?.();
              })
              .catch((err) => {
                console.error('[History] Failed to record:', err);
              });

            lastRecordedUrl = displayUrl;
          }
        }

        pushDebug('Webview finished loading.');
        break;

      case 'did-fail-load':
        if (webview) webview.classList.remove('hidden');
        setLoading(false);
        navState.isWebviewLoading = false;
        navState.hasNavigatedDuringCurrentLoad = false;
        reloadBtn.dataset.state = 'reload';
        updateNavigationState();

        if (data.event && data.event.errorCode !== -3 && webview) {
          const errorUrl = new URL('pages/error.html', window.location.href);
          errorUrl.searchParams.set('error', data.event.errorDescription || data.event.errorCode);
          errorUrl.searchParams.set('url', data.event.validatedURL || data.event.url || '');
          webview.loadURL(errorUrl.toString());
        }

        pushDebug(
          `Webview failed: ${data.event?.errorDescription || data.event?.errorCode} (${data.event?.validatedURL || 'unknown url'})`
        );
        break;

      case 'did-navigate':
        if (webview) webview.classList.add('hidden');
        // Update bookmarks bar visibility based on destination
        updateBookmarkBarState(data.event?.url);
        // Check if navigated to HTTPS (assume secure until certificate-error fires)
        if (data.event?.url?.startsWith('https://')) {
          currentPageSecure = true;
        } else {
          currentPageSecure = false;
        }
        pushDebug(`did-navigate event fired: ${data.event?.url}`);
        if (data.event) handleNavigationEvent(data.event);
        break;

      case 'certificate-error':
        // Certificate error occurred - mark page as insecure
        currentPageSecure = false;
        updateProtocolIcon();
        pushDebug(`Certificate error: ${data.event?.error}`);
        break;

      case 'did-navigate-in-page':
        if (data.event) handleNavigationEvent(data.event);
        break;

      case 'dom-ready':
        if (webview) webview.classList.remove('hidden');
        updateNavigationState();
        ensureWebContentsId();
        pushDebug('Webview ready.');
        break;

      case 'tab-switched':
        // Save address bar state to previous tab before switching
        if (previousActiveTabId && previousActiveTabId !== data.tabId) {
          const prevTab = getTabs().find((t) => t.id === previousActiveTabId);
          if (prevTab && prevTab.navigationState) {
            prevTab.navigationState.addressBarSnapshot = addressInput.value;
            prevTab.navigationState.isViewingSource = isViewingSource;
          }
        }
        previousActiveTabId = data.tabId;

        // Update UI state when switching tabs - restore from tab's navigation state
        if (data.tab) {
          const tabNavState = data.tab.navigationState || {};
          const isLoading = data.tab.isLoading || false;
          const url = data.tab.url || tabNavState.currentPageUrl || '';

          // Restore view-source state for this tab (check URL for new tabs)
          isViewingSource = tabNavState.isViewingSource || url.startsWith('view-source:');

          // If tab is loading, prefer addressBarSnapshot (what user typed/was shown)
          // Otherwise derive from the actual URL
          let display;
          if (isLoading && tabNavState.addressBarSnapshot) {
            display = tabNavState.addressBarSnapshot;
          } else {
            // Handle view-source URLs - derive display from inner URL
            const urlToDerive = url.startsWith('view-source:') ? url.slice(12) : url;
            // Check for internal pages first
            const switchedInternalPage = getInternalPageName(urlToDerive);
            if (switchedInternalPage && switchedInternalPage !== 'home') {
              display = `freedom://${switchedInternalPage}`;
            } else {
              display = deriveDisplayValue(
                urlToDerive,
                state.bzzRoutePrefix,
                homeUrlNormalized,
                state.ipfsRoutePrefix,
                state.ipnsRoutePrefix,
                state.radicleApiPrefix
              );
              // Apply ENS name preservation to show ens:// URLs instead of resolved bzz/ipfs URLs
              display = applyEnsNamePreservation(display, state.knownEnsNames);
            }
            if (display === homeUrlNormalized) display = '';
            // Prepend view-source: for view-source tabs
            if (isViewingSource && display) {
              display = `view-source:${display}`;
            }
          }
          // Don't clear address bar if it has a value and we're on about:blank
          // (happens during "open in new window" before loadTarget runs)
          if (url === 'about:blank' && addressInput.value) {
            // Keep existing address bar value
          } else {
            addressInput.value = display;
          }
          // Update bookmarks bar visibility based on current page
          updateBookmarkBarState(url);
          // Sync bases for the switched-to tab
          if (tabNavState.currentBzzBase) {
            syncBzzBase(tabNavState.currentBzzBase);
          }
          if (tabNavState.currentIpfsBase) {
            syncIpfsBase(tabNavState.currentIpfsBase);
          }
          if (tabNavState.currentRadBase) {
            syncRadBase(tabNavState.currentRadBase);
          }
          // Sync navigationState.currentPageUrl if tab.url is more recent
          if (data.tab.url && data.tab.url !== tabNavState.currentPageUrl) {
            tabNavState.currentPageUrl = data.tab.url;
          }
          // Sync loading state - use tab.isLoading as source of truth
          setLoading(isLoading);
          tabNavState.isWebviewLoading = isLoading;
          reloadBtn.dataset.state = isLoading ? 'stop' : 'reload';
          // Focus address bar only for new empty tabs (home page)
          // Don't focus for: view-source, links opened in new tab/window, etc.
          const isEmptyNewTab =
            !isViewingSource &&
            !addressInput.value &&
            (url === homeUrl || url === homeUrlNormalized || !url);
          if (data.isNewTab && isEmptyNewTab) {
            addressInput.focus();
          }
          // Update favicon for the switched-to tab (in case it wasn't set)
          if (!data.tab.favicon && display && !display.startsWith('freedom://')) {
            updateTabFavicon(data.tab.id, display);
          }
        }
        updateNavigationState();
        updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
        updateProtocolIcon();
        break;
    }
  });

  // IPC handler for toggle bookmark bar
  electronAPI?.onToggleBookmarkBar?.(() => {
    toggleBookmarkBar();
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (event) => {
    // Cmd+Shift+R / Ctrl+Shift+R - Hard Reload (check first, before soft reload)
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.key &&
      event.key.toLowerCase() === 'r' &&
      !event.altKey
    ) {
      event.preventDefault();
      hardReloadPage();
    }
    // Cmd+R / Ctrl+R - Reload (soft, uses cache)
    else if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.key &&
      event.key.toLowerCase() === 'r' &&
      !event.altKey
    ) {
      event.preventDefault();
      reloadPage();
    } else if (event.key === 'Escape') {
      if (stopLoadingAndRestore()) {
        event.preventDefault();
        if (
          document.activeElement &&
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== addressInput
        ) {
          document.activeElement.blur();
        }
      }
    }
  });

  // Note: No initial loadHomePage() - tabs module handles the first tab
};
