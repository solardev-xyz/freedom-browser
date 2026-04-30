// Navigation, webview, and address bar handling
import { state } from './state.js';
import { pushDebug } from './debug.js';
import { updateBookmarkButtonVisibility } from './bookmarks-ui.js';
import { updateGithubBridgeIcon } from './github-bridge-ui.js';
import {
  applyEnsSuffix,
  buildRadicleDisabledUrl,
  buildViewSourceNavigation,
  deriveDisplayAddress,
  deriveSwitchedTabDisplay,
  extractEnsResolutionMetadata,
  getBookmarkBarState,
  getOriginalUrlFromErrorPage,
  getRadicleDisplayUrl,
  resolveProtocolIconType,
  resolveTrustBadge,
} from './navigation-utils.js';
import {
  formatBzzUrl,
  formatIpfsUrl,
  formatRadicleUrl,
  deriveDisplayValue,
  deriveBzzBaseFromUrl,
  deriveIpfsBaseFromUrl,
  deriveRadBaseFromUrl,
  buildEnsDisplayUri,
  isEnsBackedDisplay,
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
  buildInternalPageUrl,
} from './page-urls.js';
import { parseEthereumUri } from './ethereum-uri.js';
import { openSendFlow } from './wallet-ui.js';
import { walletState } from './wallet/wallet-state.js';
import { formatWeiToDecimal } from './wallet/send.js';

// Helper to get active tab's navigation state (with fallback to empty object)
const getNavState = () => getActiveTabState() || {};

// Extract the bzz reference (64- or 128-char hex) from a Bee gateway URL.
const extractBzzHash = (gatewayUrl) => {
  const match = /\/bzz\/([a-fA-F0-9]{64}(?:[a-fA-F0-9]{64})?)/.exec(gatewayUrl || '');
  return match ? match[1] : null;
};

// Detect a transport scheme that the user explicitly asserted in the input
// (e.g. typed `bzz://swarm.eth/`). Used to enforce transport assertion on
// ENS resolution: if the contenthash for `swarm.eth` is IPFS, a typed
// `bzz://` request fails rather than silently switching transports. Bare
// names and the legacy `ens://` form make no assertion and accept any
// transport. See `research/ens_hosts_in_dweb_handlers.md` §3.
const detectAssertedTransport = (input) => {
  const trimmed = (input || '').trim().toLowerCase();
  if (trimmed.startsWith('bzz://')) return 'bzz';
  if (trimmed.startsWith('ipfs://')) return 'ipfs';
  if (trimmed.startsWith('ipns://')) return 'ipns';
  return null;
};

// Convert a Bee gateway URL (http://127.0.0.1:1633/bzz/<hash>/path?q#h) into
// the `bzz://<hash>/path?q#h` form that Chromium routes through the custom
// protocol handler. Falls back to the gateway URL if the shape doesn't match.
const gatewayUrlToBzzUrl = (gatewayUrl) => {
  try {
    const parsed = new URL(gatewayUrl);
    const match = /^\/bzz\/([a-fA-F0-9]{64}(?:[a-fA-F0-9]{64})?)(\/.*)?$/.exec(parsed.pathname);
    if (!match) return gatewayUrl;
    const [, hash, tail] = match;
    const path = tail || '/';
    return `bzz://${hash}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return gatewayUrl;
  }
};

// Build a file:// URL for error.html. `targetUrl` is the user-facing URL
// shown in the address bar and on the page. `extras` can include:
//   - protocol: explicit protocol hint ('swarm' | 'ipfs' | 'ipns')
//   - retry: URL the in-page "Try Again" button should navigate to. Should
//     always be a scheme Chromium can load (bzz://<hash>, http(s)://, …).
//     If the display URL is an ENS-backed form (legacy ens:// or transport
//     ENS like bzz://name.eth) the retry must point at the resolved
//     transport URL, since the ENS host can't be loaded by Chromium directly.
const buildErrorPageUrl = (errorCode, targetUrl, extras = {}) => {
  const errorUrl = new URL('pages/error.html', window.location.href);
  errorUrl.searchParams.set('error', errorCode);
  errorUrl.searchParams.set('url', targetUrl || '');
  if (extras.protocol) errorUrl.searchParams.set('protocol', extras.protocol);
  if (extras.retry) errorUrl.searchParams.set('retry', extras.retry);
  return errorUrl.toString();
};

// Cancel any pending Swarm content probe on the given navState and clear it.
//
// Bumps `swarmProbeVersion` even when no `pendingSwarmProbeId` is set yet,
// because the user can hit stop in the small window between
// `startSwarmProbe` (the IPC) and the `.then()` that records the returned
// probeId. If we only checked the id, that early-cancel would no-op and
// the probe would eventually navigate the webview after the user told it
// to stop.
const cancelPendingSwarmProbe = (navState) => {
  if (!navState) return;
  navState.swarmProbeVersion = (navState.swarmProbeVersion || 0) + 1;
  if (!navState.pendingSwarmProbeId) return;
  const probeId = navState.pendingSwarmProbeId;
  navState.pendingSwarmProbeId = null;
  electronAPI?.cancelSwarmProbe?.(probeId).catch((err) => {
    pushDebug(`[Swarm] cancelSwarmProbe failed: ${err?.message || err}`);
  });
};

const electronAPI = window.electronAPI;
const RADICLE_DISABLED_MESSAGE =
  'Radicle integration is disabled. Enable it in Settings > Experimental';

// DOM elements (initialized in initNavigation)
let addressInput = null;
let navForm = null;
let backBtn = null;
let forwardBtn = null;
let reloadBtn = null;
let homeBtn = null;
let bookmarksBar = null;
let protocolIcon = null;
let trustShield = null;
let trustPopover = null;

// Bookmark bar toggle state: true = always show, false = hide on non-home pages (default)
let bookmarkBarOverride = false;

// Track previous active tab ID to save address bar state when switching
let previousActiveTabId = null;



// Last recorded URL to avoid duplicates in quick succession
let lastRecordedUrl = null;

// Track if current tab is viewing source (view-source: URLs report inner URL in events)
let isViewingSource = false;

// Callback when history is recorded (for autocomplete cache refresh)
let onHistoryRecorded = null;
export const setOnHistoryRecorded = (callback) => {
  onHistoryRecorded = callback;
};

// `tabId` lets callers in async paths target the tab that actually owns
// the in-flight work (e.g. ENS resolution, view-source ENS resolution),
// rather than whatever tab happens to be active when the promise settles.
// Without this, a slow ENS lookup on Tab A that resolves while the user
// is viewing Tab B would clear Tab B's spinner and leave Tab A's stuck.
// `updateBookmarkButtonVisibility` / `updateGithubBridgeIcon` are global
// (active-tab) helpers and are skipped for off-screen updates so we don't
// flicker the foreground UI based on background work.
//
// When no `tabId` is supplied we forward the call as a single-arg
// invocation so the active-tab default in `setTabLoading` kicks in — and
// callers / tests that pre-date this signature stay byte-identical.
const setLoading = (isLoading, tabId = null) => {
  if (tabId === null) {
    setTabLoading(isLoading);
  } else {
    setTabLoading(isLoading, tabId);
  }
  if (tabId === null || tabId === getActiveTab()?.id) {
    updateBookmarkButtonVisibility();
    updateGithubBridgeIcon();
  }
};

const getTabIdForWebview = (webview) => {
  if (!webview) return null;
  const raw = webview.dataset?.tabId;
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const isActiveTab = (tabId) => tabId !== null && tabId === getActiveTab()?.id;

const getTabById = (tabId) => {
  if (tabId === null) return null;
  return getTabs().find((t) => t.id === tabId) || null;
};

// Update the address bar to show the navigation target. When the target
// tab is the active one (or unknown), this writes through to the visible
// address input and refreshes the protocol icon — same behaviour as before.
// When the target is a backgrounded tab (e.g. an ENS click in Tab A whose
// resolution settled while the user is now on Tab B), we instead stash the
// display value on that tab's `navigationState.addressBarSnapshot` so the
// `tab-switched` handler picks it up when the user switches back. This
// prevents the resolved URL from clobbering the foreground tab's address
// bar after a slow ENS resolution settles in the background.
const setAddressDisplayForTab = (displayValue, tabId, { isViewingSourceForTab = false } = {}) => {
  if (isActiveTab(tabId) || tabId === null) {
    addressInput.value = displayValue;
    updateProtocolIcon();
    return;
  }
  const tab = getTabById(tabId);
  if (tab?.navigationState) {
    tab.navigationState.addressBarSnapshot = displayValue;
    tab.navigationState.isViewingSource = isViewingSourceForTab;
  }
};

const storeEnsResolutionMetadata = (targetUri, ensName, { trackProtocol = true } = {}) => {
  const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(targetUri, ensName);

  for (const [key, name] of knownEnsPairs) {
    state.knownEnsNames.set(key, name);
  }

  if (trackProtocol && resolvedProtocol) {
    state.ensProtocols.set(ensName, resolvedProtocol);
  }
};

// Track certificate status for current page
let currentPageSecure = false;

// Copy map for the trust popover — each level gets a short, user-facing
// sentence. Phrased as cross-check language ("RPCs agreed") rather than
// "trusted" / "safe", per the threat model discussion.
const TRUST_SUMMARY = {
  verified: (trust) => {
    const agreed = (trust.agreed || []).length;
    return agreed > 0
      ? `Verified: quorum reached with ${agreed} matching public RPC responses.`
      : 'Verified.';
  },
  'user-configured': () => 'Resolved via your configured RPC. Single source — no cross-check performed.',
  unverified: () => 'Only one RPC answered in time. The browser could not cross-check this resolution.',
  conflict: () => 'RPC servers disagreed. Navigation was blocked.',
};

// Screen-reader label for the shield button, keyed on trust level. Updated
// alongside the data-trust attribute so assistive tech announces the state.
const TRUST_ARIA_LABEL = {
  verified: 'ENS resolution trust: verified',
  'user-configured': 'ENS resolution trust: user-configured',
  unverified: 'ENS resolution trust: unverified',
  conflict: 'ENS resolution trust: conflict',
};

// Build display text for the popover. The resolver's trust shape has
// `agreed` and `queried` hostname arrays; we surface counts in the summary
// and full lists in the sections below.
const setTrustPopoverOpen = (open) => {
  if (!trustPopover || !trustShield) return;
  trustPopover.hidden = !open;
  trustShield.setAttribute('aria-expanded', open ? 'true' : 'false');
};

const toggleTrustPopover = () => {
  if (!trustPopover || !trustShield) return;
  if (!trustPopover.hidden) {
    setTrustPopoverOpen(false);
    return;
  }

  const badge = resolveTrustBadge({
    value: addressInput?.value || '',
    ensTrustByName: state.ensTrustByName,
  });
  if (!badge) return;

  const { trust, name, level } = badge;
  trustPopover.setAttribute('data-trust', level);

  const title = document.getElementById('trust-popover-title');
  const subtitle = document.getElementById('trust-popover-subtitle');
  const summary = document.getElementById('trust-popover-summary');
  const blockEl = document.getElementById('trust-popover-block');
  const agreedEl = document.getElementById('trust-popover-agreed');
  const dissentedEl = document.getElementById('trust-popover-dissented');
  const dissentedSection = document.getElementById('trust-popover-dissented-section');
  const agreedSection = document.getElementById('trust-popover-agreed-section');

  if (title) title.textContent = name;
  if (subtitle) {
    // Full resolved URI (e.g. bzz://<hash>, ipfs://<CID>) — the content
    // address the ENS record points at. Falls back to protocol-only if
    // the URI wasn't captured (shouldn't happen for successful resolves).
    const uri = state.ensUriByName.get(name);
    const proto = state.ensProtocols.get(name);
    subtitle.textContent = uri || (proto ? `Resolved as ${proto}://…` : '');
  }
  if (summary) {
    const buildSummary = TRUST_SUMMARY[level];
    if (!buildSummary) {
      console.warn('[trust] unknown trust level:', level);
      summary.textContent = 'Unknown trust state.';
    } else {
      summary.textContent = buildSummary(trust);
    }
  }
  if (blockEl) {
    if (trust.block?.number) {
      const hash = trust.block.hash || '';
      const short = hash ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : '';
      blockEl.textContent = `#${trust.block.number}${short ? '  ' + short : ''}`;
    } else {
      blockEl.textContent = '(not recorded)';
    }
  }
  if (agreedEl && agreedSection) {
    const agreed = trust.agreed || [];
    if (agreed.length > 0) {
      agreedEl.textContent = agreed.join(', ');
      agreedSection.hidden = false;
    } else {
      agreedSection.hidden = true;
    }
  }
  if (dissentedEl && dissentedSection) {
    const dissented = trust.dissented || [];
    if (dissented.length > 0) {
      dissentedEl.textContent = dissented.join(', ');
      dissentedSection.hidden = false;
    } else {
      dissentedSection.hidden = true;
    }
  }

  setTrustPopoverOpen(true);
};

// Update protocol icon AND trust shield from the current address-bar value.
// Called from every site that might change either (nav events, tab switches,
// address-bar edits). Trust shield is hidden for non-ENS URLs; the protocol
// icon keeps indicating bzz://, ipfs://, https://, etc. as before.
const updateProtocolIcon = () => {
  if (protocolIcon) {
    const protocol = resolveProtocolIconType({
      value: addressInput?.value || '',
      ensProtocols: state.ensProtocols,
      enableRadicleIntegration: state.enableRadicleIntegration,
      currentPageSecure,
    });
    if (protocol) {
      protocolIcon.setAttribute('data-protocol', protocol);
      protocolIcon.classList.add('visible');
    } else {
      protocolIcon.removeAttribute('data-protocol');
      protocolIcon.classList.remove('visible');
    }
  }

  if (trustShield) {
    const badge = resolveTrustBadge({
      value: addressInput?.value || '',
      ensTrustByName: state.ensTrustByName,
    });
    if (badge) {
      trustShield.setAttribute('data-trust', badge.level);
      trustShield.setAttribute(
        'aria-label',
        TRUST_ARIA_LABEL[badge.level] || 'ENS resolution trust status'
      );
      trustShield.hidden = false;
    } else {
      trustShield.removeAttribute('data-trust');
      trustShield.setAttribute('aria-label', 'ENS resolution trust status');
      trustShield.hidden = true;
    }
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

// EIP-681 carries value in the chain's base unit (wei for ETH et al.); we
// assume 18 decimals for the native token, correct for every chain freedom
// currently ships with.
const handleEthereumUri = (value) => {
  const parsed = parseEthereumUri(value);
  if (!parsed.ok) {
    if (parsed.reason === 'UNSUPPORTED_FUNCTION') {
      alert('ERC-20 and other contract-call ethereum: URIs are not yet supported.');
    } else {
      alert(`Malformed ethereum: URI: ${value}`);
    }
    return;
  }

  const chains = walletState.registeredChains;
  if (!chains || Object.keys(chains).length === 0) {
    alert('Wallet is still initializing — please try again in a moment.');
    return;
  }
  if (!chains[parsed.chainId]) {
    alert(`Chain ${parsed.chainId} is not supported by this wallet.`);
    return;
  }

  const amount = parsed.value ? formatWeiToDecimal(BigInt(parsed.value)) : undefined;
  const opened = openSendFlow({
    recipient: parsed.target,
    chainId: parsed.chainId,
    amount,
  });
  if (!opened) {
    alert('Enable Identity & Wallet (Settings → Experimental) to accept tips.');
  }
};

/**
 * Gate a bzz:// navigation on the main-process content probe. Keeps the tab
 * spinner running while the Bee node is still connecting to peers, then loads
 * the webview once the content is retrievable. On bee unreachable / timeout
 * we route to the existing error page.
 *
 * `displayUrl` is the user-facing URL (e.g. `ens://swarm.eth` or
 * `bzz://<hash>`) that appears in the address bar, and is what we want the
 * error page to surface — not the internal Bee gateway URL.
 *
 * `target.swarmHash` overrides hash extraction from the gateway URL, and
 * `target.bzzLoadUrl` overrides the URL passed to `webview.loadURL`. Both
 * are populated by the ENS-host transport path (`bzz://name.eth/`) so the
 * probe runs against the resolved hash while Chromium loads the ENS-named
 * URL — keeping DevTools, `window.location`, and storage origin pinned to
 * the ENS name. The bzz protocol handler resolves the host on every
 * request (cache hit after the renderer already resolved upstream).
 */
const startBzzNavigationWithProbe = (webview, target, navState, displayUrl) => {
  const gatewayUrl = target.targetUrl;
  const hash = target.swarmHash || extractBzzHash(gatewayUrl);
  const errorDisplayUrl = displayUrl || target.displayValue || gatewayUrl;

  if (!hash || !electronAPI?.startSwarmProbe) {
    // No hash or no probe support — fall back to the pre-existing behaviour.
    const fallbackLoadUrl = target.bzzLoadUrl || gatewayUrl;
    webview.loadURL(fallbackLoadUrl);
    pushDebug(`Loading ${target.displayValue} via ${fallbackLoadUrl} (no probe)`);
    return;
  }

  // Cancel any earlier Swarm probe still in flight for this tab.
  cancelPendingSwarmProbe(navState);

  // Capture the version after the cancel-and-bump above, so any subsequent
  // bump (stop button, second navigation) invalidates this probe — even
  // before `startSwarmProbe` has resolved and given us a probeId.
  const myVersion = navState.swarmProbeVersion || 0;
  // Tab id of the navigation we're probing for — see `setLoading` doc on
  // why async setLoading needs a tab id.
  const probeTabId = getTabIdForWebview(webview);

  setLoading(true, probeTabId);
  navState.isWebviewLoading = true;
  if (isActiveTab(probeTabId)) {
    reloadBtn.dataset.state = 'stop';
  }
  pushDebug(`[Swarm] Probing ${gatewayUrl} before navigating`);

  electronAPI
    .startSwarmProbe(hash)
    .then((startResult) => {
      if (!startResult || startResult.success === false) {
        const message = startResult?.error?.message || 'failed to start probe';
        throw new Error(message);
      }
      const probeId = startResult.id;
      // If the user cancelled (or another navigation started) before the
      // start IPC resolved, swarmProbeVersion has been bumped. Tell the
      // main process to drop the probe rather than letting it run to
      // completion and waste cycles.
      if (navState.swarmProbeVersion !== myVersion) {
        pushDebug(`[Swarm] Probe ${probeId} cancelled before start IPC resolved`);
        electronAPI?.cancelSwarmProbe?.(probeId).catch((err) => {
          pushDebug(`[Swarm] cancelSwarmProbe failed: ${err?.message || err}`);
        });
        return null;
      }
      navState.pendingSwarmProbeId = probeId;
      return electronAPI.awaitSwarmProbe(probeId).then((awaitResult) => ({
        probeId,
        awaitResult,
      }));
    })
    .then((result) => {
      if (!result) return;
      const { probeId, awaitResult } = result;
      // Guard: a stop / second navigation may have happened during the
      // await. swarmProbeVersion catches both the supersedence case and
      // the early-cancel case where pendingSwarmProbeId was never set.
      if (navState.swarmProbeVersion !== myVersion) {
        pushDebug(`[Swarm] Probe ${probeId} superseded — discarding result`);
        return;
      }
      navState.pendingSwarmProbeId = null;

      // Retry URL prefers the ENS-named load URL (so the user's "Try Again"
      // button preserves the ENS host and DevTools/origin stay stable). If
      // none was supplied, fall back to the hash form, which Chromium can
      // load directly via the bzz protocol handler.
      const retryUrl = target.bzzLoadUrl || `bzz://${hash}`;
      const errorExtras = { protocol: 'swarm', retry: retryUrl };

      if (!awaitResult || awaitResult.success === false) {
        const message = awaitResult?.error?.message || 'failed to await probe';
        pushDebug(`[Swarm] Probe await failed: ${message}`);
        webview.loadURL(
          buildErrorPageUrl('swarm_content_not_found', errorDisplayUrl, errorExtras)
        );
        return;
      }

      const outcome = awaitResult.outcome || { ok: false, reason: 'other' };
      if (outcome.ok) {
        // Navigate via the custom `bzz:` scheme so sub-resource fetches go
        // through the main-process protocol handler (retries, redundancy
        // headers, streaming Range support). See README "Swarm Content
        // Retrieval". The handler ultimately proxies to the same gateway.
        // For ENS-host targets we keep the name in the loaded URL so the
        // protocol handler resolves on every request and the page's origin
        // is `bzz://<name>` rather than `bzz://<hash>`.
        const bzzUrl = target.bzzLoadUrl || gatewayUrlToBzzUrl(gatewayUrl);
        pushDebug(`[Swarm] Probe ok — loading ${bzzUrl}`);
        webview.loadURL(bzzUrl);
        return;
      }

      if (outcome.reason === 'aborted') {
        // Cancelled by the user (stop button / next navigation). Nothing to do.
        pushDebug('[Swarm] Probe aborted');
        return;
      }

      if (outcome.reason === 'bee_unreachable') {
        pushDebug('[Swarm] Probe: Bee unreachable');
        webview.loadURL(
          buildErrorPageUrl('ERR_CONNECTION_REFUSED', errorDisplayUrl, errorExtras)
        );
        return;
      }

      pushDebug(`[Swarm] Probe failed (${outcome.reason}) — showing error page`);
      webview.loadURL(
        buildErrorPageUrl('swarm_content_not_found', errorDisplayUrl, errorExtras)
      );
    })
    .catch((err) => {
      pushDebug(`[Swarm] Probe error: ${err?.message || err}`);
      // Don't surface an error page if the user (or a subsequent navigation)
      // already cancelled this probe — they'd see the error flash on top of
      // their actual destination.
      if (navState.swarmProbeVersion !== myVersion) return;
      navState.pendingSwarmProbeId = null;
      const retryUrl = target.bzzLoadUrl || `bzz://${hash}`;
      webview.loadURL(
        buildErrorPageUrl('swarm_content_not_found', errorDisplayUrl, {
          protocol: 'swarm',
          retry: retryUrl,
        })
      );
    });
};

export const loadTarget = (value, displayOverride = null, targetWebview = null, options = {}) => {
  // `options.allowUnverifiedOnce` — skip the unverified-ENS interstitial
  // for this single call. Set by the ens-unverified page's "Continue once"
  // handler. Scope is this single loadTarget invocation.
  //
  // `options.bzzLoadUrl` / `options.swarmHash` — set by the ENS resolution
  // path when an ENS name resolves to Swarm content: the recursive call
  // into the bzz branch carries the ENS-named load URL plus the resolved
  // hash separately so Chromium loads `bzz://<name>/` while the navigation
  // probe still runs against the actual content reference. See
  // `startBzzNavigationWithProbe` for how the two are split.
  // Use provided webview or fall back to active webview
  const webview = targetWebview || getActiveWebview();
  // Target tab id and nav state. For the synchronous, top-level call this
  // resolves to the active tab and matches the previous behaviour. For
  // recursive calls from the ENS path (which pass `capturedWebview` so the
  // resolution still wins on the originating tab even if the user switched
  // away mid-flight) we route nav-state mutations onto the captured tab's
  // state instead of the foreground tab's. Without this, an ENS resolution
  // that settles after a tab switch would clobber the foreground tab's
  // address bar with the resolved URL of a backgrounded tab.
  const targetTabId = getTabIdForWebview(webview);
  const navState =
    getTabById(targetTabId)?.navigationState || getNavState();
  if (!webview) {
    pushDebug('No active webview to load target');
    return;
  }

  // A new navigation invalidates any still-pending Swarm content probe for
  // this tab: either a new bzz probe will start below, or the user is
  // leaving Swarm entirely, in which case we don't want the old probe to
  // eventually navigate the webview to a now-stale bzz URL.
  cancelPendingSwarmProbe(navState);

  // Handle view-source: URLs - need to resolve dweb URLs before loading
  if (value.startsWith('view-source:')) {
    isViewingSource = true; // Track that this tab is viewing source
    const innerUrl = value.slice(12); // 'view-source:'.length === 12

    // If inner URL is a dweb URL, we need to resolve it first
    // Check for ENS
    const ens = parseEnsInput(innerUrl);
    if (ens && electronAPI?.resolveEns) {
      const capturedWebview = webview;
      // Tab id pinned for the duration of this async resolution so a tab
      // switch can't redirect the spinner to the wrong tab when the
      // promise settles.
      const capturedTabId = getTabIdForWebview(capturedWebview);
      setLoading(true, capturedTabId);
      // Show the legacy view-source ENS placeholder while resolution is in
      // flight. Once we know the resolved transport we update the address
      // bar to the transport-aware form (e.g. `view-source:bzz://name.eth`).
      addressInput.value = `view-source:ens://${ens.name}${ens.suffix || ''}`;
      updateProtocolIcon();
      electronAPI
        .resolveEns(ens.name)
        .then((result) => {
          setLoading(false, capturedTabId);
          if (!result || result.type !== 'ok') {
            if (isActiveTab(capturedTabId)) {
              alert(`ENS resolution failed for ${ens.name}: ${result?.reason || 'no response'}`);
            }
            return;
          }
          // Build target URI with path suffix
          const targetUri = applyEnsSuffix(result.uri, ens.suffix);
          storeEnsResolutionMetadata(targetUri, ens.name, { trackProtocol: false });

          const transportDisplay = buildEnsDisplayUri(result.protocol, ens.name, ens.suffix);
          if (transportDisplay && isActiveTab(capturedTabId)) {
            addressInput.value = `view-source:${transportDisplay}`;
            updateProtocolIcon();
          }

          const { loadUrl } = buildViewSourceNavigation({
            value: `view-source:${targetUri}`,
            bzzRoutePrefix: state.bzzRoutePrefix,
            homeUrlNormalized,
            ipfsRoutePrefix: state.ipfsRoutePrefix,
            ipnsRoutePrefix: state.ipnsRoutePrefix,
            radicleApiPrefix: state.radicleApiPrefix,
            knownEnsNames: state.knownEnsNames,
          });

          if (loadUrl === `view-source:${targetUri}`) {
            if (isActiveTab(capturedTabId)) {
              alert(`Unsupported protocol: ${result.protocol}`);
            }
            return;
          }
          capturedWebview.loadURL(loadUrl);
        })
        .catch((err) => {
          setLoading(false, capturedTabId);
          if (isActiveTab(capturedTabId)) {
            alert(`ENS resolution error: ${err.message}`);
          }
        });
      return;
    }

    const viewSourceNavigation = buildViewSourceNavigation({
      value,
      bzzRoutePrefix: state.bzzRoutePrefix,
      homeUrlNormalized,
      ipfsRoutePrefix: state.ipfsRoutePrefix,
      ipnsRoutePrefix: state.ipnsRoutePrefix,
      radicleApiPrefix: state.radicleApiPrefix,
      knownEnsNames: state.knownEnsNames,
    });
    addressInput.value = viewSourceNavigation.addressValue;
    updateProtocolIcon();
    webview.loadURL(viewSourceNavigation.loadUrl);
    return;
  }

  // Not viewing source for regular navigation
  isViewingSource = false;

  // ethereum: URIs route to the wallet sidebar — no page load.
  if (value.trim().toLowerCase().startsWith('ethereum:')) {
    handleEthereumUri(value);
    return;
  }

  // Handle freedom:// protocol for internal pages, with optional sub-path
  // (e.g. freedom://settings/appearance → pages/settings.html#appearance).
  // The sub-path is carried as a URL fragment so client-side routing inside
  // the page can show the matching section without a full reload.
  const fbMatch = value.match(/^freedom:\/\/([a-zA-Z0-9-]+)(?:\/([a-zA-Z0-9-]+))?\/?$/i);
  if (fbMatch) {
    const pageName = fbMatch[1].toLowerCase();
    const subPath = fbMatch[2]?.toLowerCase() || null;
    const pageUrl = internalPages[pageName];
    if (pageUrl) {
      const targetUrl = subPath ? `${pageUrl}#${subPath}` : pageUrl;
      webview.loadURL(targetUrl);
      pushDebug(`Loading internal page: ${pageName}${subPath ? `/${subPath}` : ''}`);
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
    // Capture the tab id too so async callbacks can route per-tab UI
    // updates (spinner, isLoading state) to the originating tab even
    // after the user switches away mid-resolution. Without this, a slow
    // ENS lookup on Tab A that settles while Tab B is active would clear
    // Tab B's spinner and leave Tab A's stuck.
    const capturedTabId = getTabIdForWebview(capturedWebview);
    // If the user typed a transport-prefixed input (e.g. `bzz://name.eth/`),
    // treat the scheme as an assertion: the ENS contenthash MUST match.
    // Bare names and the legacy `ens://` form make no assertion. Captured
    // before the async hop so a follow-up edit to the address bar can't
    // change the assertion under our feet.
    const assertedTransport = detectAssertedTransport(value);
    setLoading(true, capturedTabId);
    // Show the user what's being loaded immediately. Without this the
    // address bar keeps showing the previous page's URL (same-tab clicks)
    // or stays empty (new tabs, where tab.url collapses to homeUrl) for
    // the entire ENS resolution roundtrip — which can be 100ms–1s+ on a
    // cold lookup and reads as the browser stalling. After resolution the
    // recursive loadTarget call overwrites this with the canonical
    // transport-aware display (e.g. `vitalik.eth` → `ipfs://vitalik.eth`),
    // a small flicker that's far better than the prior dead time.
    //
    // `setAddressDisplayForTab` also handles the case where this loadTarget
    // is operating on a backgrounded tab (e.g. `tab:new-with-url` for an
    // ENS link) by stashing the value on the tab's navigationState
    // instead of clobbering the foreground tab's bar.
    //
    // Refresh of the protocol icon happens inside the helper too: the
    // transport scheme the user typed (e.g. `bzz://name.eth` → swarm) is
    // reflected immediately while resolution is in flight, instead of
    // waiting until the page actually loads. Bare names without a cached
    // `ensProtocols` entry still fall back to the http icon.
    setAddressDisplayForTab(displayOverride || value, capturedTabId);
    pushDebug(`Resolving ENS name: ${ens.name}`);
    electronAPI
      .resolveEns(ens.name)
      .then((result) => {
        setLoading(false, capturedTabId);
        // Modal alerts surfaced for an inactive tab read as random
        // interruptions to the foreground task — gate them on the tab
        // still being active. The pushDebug entries below are unconditional
        // so devtools and the user-visible debug console keep the trail.
        if (!result) {
          if (isActiveTab(capturedTabId)) {
            alert('ENS resolution failed: no response');
          }
          return;
        }

        if (result.trust) {
          state.ensTrustByName.set(ens.name, result.trust);
        }
        if (result.uri) {
          state.ensUriByName.set(ens.name, result.uri);
        }

        // Conflict = hard block. Render the interstitial with the disputed
        // groups so the user can see which providers claimed what; no
        // attempt to load the resolved URI.
        if (result.type === 'conflict') {
          // Defensive cap: the resolver already bounds groups by K (≤9),
          // but a malformed payload shouldn't be able to explode the URL.
          const groups = (result.groups || []).slice(0, 10);
          pushDebug(`ENS conflict for ${ens.name}: ${groups.length} groups`);
          capturedWebview.loadURL(
            buildInternalPageUrl('ens-conflict.html', {
              name: ens.name,
              block: JSON.stringify(result.trust?.block || {}),
              groups: JSON.stringify(groups),
            })
          );
          return;
        }

        if (result.type !== 'ok') {
          const reason = result.reason || 'Unknown error';
          pushDebug(`ENS resolution failed for ${ens.name}: ${reason}`);
          if (isActiveTab(capturedTabId)) {
            alert(`ENS resolution failed for ${ens.name}: ${reason}`);
          }
          return;
        }

        if (result.protocol !== 'bzz' && result.protocol !== 'ipfs' && result.protocol !== 'ipns') {
          pushDebug(`ENS content for ${ens.name} uses unsupported protocol ${result.protocol}`);
          if (isActiveTab(capturedTabId)) {
            alert(
              `ENS content uses unsupported protocol "${result.protocol}". Supported: Swarm (bzz), IPFS, IPNS.`
            );
          }
          return;
        }

        // Cross-transport assertion: a typed `bzz://name.eth/` must resolve
        // to a Swarm contenthash, not IPFS/IPNS. Same for ipfs:// and
        // ipns://. We surface this as an alert + abort rather than silently
        // switching transports — that mirrors the protocol-handler-side
        // behaviour (404 with explanatory body) and matches the
        // transport-assertion principle in
        // research/ens_hosts_in_dweb_handlers.md §3.
        if (assertedTransport && assertedTransport !== result.protocol) {
          pushDebug(
            `ENS transport mismatch for ${ens.name}: asserted ${assertedTransport}, got ${result.protocol}`
          );
          if (isActiveTab(capturedTabId)) {
            alert(
              `ENS name ${ens.name} resolves to ${result.protocol}, not ${assertedTransport}. ` +
                `Try ${result.protocol}://${ens.name} instead.`
            );
          }
          return;
        }

        const targetUri = applyEnsSuffix(result.uri, ens.suffix);

        // Unverified = soft block. Interstitial lets the user continue once,
        // bypassing this check for the follow-up load.
        if (
          result.trust?.level === 'unverified'
          && state.blockUnverifiedEns
          && !options.allowUnverifiedOnce
        ) {
          pushDebug(`ENS unverified for ${ens.name} → interstitial`);
          capturedWebview.loadURL(
            buildInternalPageUrl('ens-unverified.html', { name: ens.name, uri: targetUri })
          );
          return;
        }

        pushDebug(`ENS resolved: ${ens.name} -> ${targetUri}`);

        storeEnsResolutionMetadata(targetUri, ens.name);

        // Build transport-aware display (e.g. `bzz://name.eth/path`,
        // `ipfs://name.eth/path`) so the address bar reflects the actual
        // resolution transport. Falls back to the legacy `ens://` form for
        // unsupported protocols, but the `result.protocol` guard above
        // already rejects anything but bzz/ipfs/ipns.
        const transportDisplay =
          buildEnsDisplayUri(result.protocol, ens.name, ens.suffix)
          || `ens://${ens.name}${ens.suffix || ''}`;

        // For Swarm-backed ENS we want Chromium to load `bzz://<name>/...`
        // directly: the bzz protocol handler resolves the ENS host on
        // every request (cache hit since we just populated the cache via
        // resolveEns), so DevTools, `window.location`, storage origin, and
        // subresource fetches all see the ENS name rather than the
        // resolved hash. The probe still needs the actual hash to gate
        // navigation on Bee warmth, so we pass it separately.
        // IPFS/IPNS don't have a custom protocol handler yet, so they
        // continue to load via the gateway URL (DevTools shows the gateway
        // URL there — separate from this fix).
        const innerOptions =
          result.protocol === 'bzz'
            ? { bzzLoadUrl: transportDisplay, swarmHash: result.decoded }
            : {};

        // Pass captured webview to ensure we load in the correct tab
        loadTarget(targetUri, displayOverride || transportDisplay, capturedWebview, innerOptions);
      })
      .catch((err) => {
        setLoading(false, capturedTabId);
        console.error('ENS resolution error', err);
        pushDebug(`ENS resolution error for ${ens.name}: ${err.message}`);
        // Suppress the modal alert if the user has switched to a different
        // tab — surfacing it on top of unrelated content is more confusing
        // than informative. The console log + debug entry preserve the
        // diagnostic trail for the foreground/devtools.
        if (isActiveTab(capturedTabId)) {
          alert(`ENS resolution error for ${ens.name}: ${err.message}`);
        }
      });
    return;
  }

  // Try Radicle (rad:RID or rad://RID)
  if (value.trim().toLowerCase().startsWith('rad:') || value.trim().toLowerCase().startsWith('rad://')) {
    if (!state.enableRadicleIntegration) {
      pushDebug(RADICLE_DISABLED_MESSAGE);
      const disabledUrl = buildRadicleDisabledUrl(window.location.href, value.trim());
      addressInput.value = value.trim();
      navState.pendingNavigationUrl = disabledUrl;
      navState.hasNavigatedDuringCurrentLoad = false;
      webview.loadURL(disabledUrl);
      syncRadBase(null);
      syncBzzBase(null);
      syncIpfsBase(null);
      return;
    }
    const radicleTarget = formatRadicleUrl(value, state.radicleBase);
    if (radicleTarget) {
      const radicleDisplayValue = displayOverride || radicleTarget.displayValue;
      setAddressDisplayForTab(radicleDisplayValue, targetTabId);
      pushDebug(`[AddressBar] Loading Radicle target, set to: ${radicleDisplayValue}`);
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
    // Clear ENS mapping if directly navigating (not via ENS resolution).
    // `isEnsBackedDisplay` recognises both the legacy `ens://name.eth` form
    // and the new transport-aware form (`ipfs://name.eth`, `ipns://name.eth`,
    // `bzz://name.eth`), so post-resolution display values don't accidentally
    // delete the hash→name mapping the address bar relies on.
    if (!isEnsBackedDisplay(displayOverride)) {
      const cidMatch = ipfsTarget.displayValue.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
      const ipnsMatch = ipfsTarget.displayValue.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
      if (cidMatch) state.knownEnsNames.delete(cidMatch[1]);
      if (ipnsMatch) state.knownEnsNames.delete(ipnsMatch[1]);
    }
    const ipfsDisplayValue = displayOverride || ipfsTarget.displayValue;
    setAddressDisplayForTab(ipfsDisplayValue, targetTabId);
    pushDebug(`[AddressBar] Loading IPFS target, set to: ${ipfsDisplayValue}`);
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
    // Clear ENS mapping if directly navigating (not via ENS resolution).
    // See note on the IPFS branch above for why `isEnsBackedDisplay` is the
    // right gate here instead of a literal `ens://` prefix check.
    if (!isEnsBackedDisplay(displayOverride)) {
      const hashMatch = target.displayValue.match(/^bzz:\/\/([a-fA-F0-9]+)/);
      if (hashMatch) state.knownEnsNames.delete(hashMatch[1].toLowerCase());
    }
    const displayValue = displayOverride || target.displayValue;
    setAddressDisplayForTab(displayValue, targetTabId);
    pushDebug(`[AddressBar] Loading target, set to: ${displayValue}`);
    // For ENS-host transport URLs we point pendingNavigationUrl at the
    // ENS-named load URL so the `did-navigate` reconciliation in
    // webcontents-setup matches: Chromium will report `bzz://<name>/`
    // after navigation, not the gateway URL.
    const expectedNavUrl = options.bzzLoadUrl || target.targetUrl;
    navState.pendingTitleForUrl = expectedNavUrl;
    navState.pendingNavigationUrl = expectedNavUrl;
    navState.hasNavigatedDuringCurrentLoad = false;
    syncBzzBase(target.baseUrl || null);
    syncIpfsBase(null); // Clear ipfs base when loading bzz
    syncRadBase(null); // Clear rad base when loading bzz

    // Augment with optional ENS-transport overrides. `swarmHash` lets the
    // probe target the resolved Swarm reference; `bzzLoadUrl` is what
    // Chromium actually loads, so the page's URL/origin stays ENS-named.
    const augmented = options.bzzLoadUrl || options.swarmHash
      ? { ...target, bzzLoadUrl: options.bzzLoadUrl, swarmHash: options.swarmHash }
      : target;

    // Probe the Bee gateway first so the tab spinner stays active while the
    // node's peer set warms up; only load the webview once the content is
    // actually retrievable (or bail to the error page).
    startBzzNavigationWithProbe(webview, augmented, navState, displayValue);
    return;
  }

  // Try HTTP/HTTPS URLs
  if (value.startsWith('http://') || value.startsWith('https://')) {
    const httpDisplayValue = displayOverride || value;
    setAddressDisplayForTab(httpDisplayValue, targetTabId);
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
  cancelPendingSwarmProbe(navState);
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
  const originalUrl = getOriginalUrlFromErrorPage(current, errorUrlBase);
  if (originalUrl) {
    pushDebug(`Retrying original URL from error page: ${originalUrl}`);
    loadTarget(originalUrl);
    return;
  }
  if (current.startsWith(errorUrlBase) || current.includes('/error.html?')) {
    try {
      new URL(current);
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
      const displayInner = deriveDisplayAddress({
        url: event.url,
        bzzRoutePrefix: state.bzzRoutePrefix,
        homeUrlNormalized,
        ipfsRoutePrefix: state.ipfsRoutePrefix,
        ipnsRoutePrefix: state.ipnsRoutePrefix,
        radicleApiPrefix: state.radicleApiPrefix,
        knownEnsNames: state.knownEnsNames,
      });
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
      navState.addressBarSnapshot = addressInput.value;
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
      navState.addressBarSnapshot = addressInput.value;
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
      navState.addressBarSnapshot = addressInput.value;
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
      const derived = deriveDisplayAddress({
        url: event.url,
        bzzRoutePrefix: state.bzzRoutePrefix,
        homeUrlNormalized,
        ipfsRoutePrefix: state.ipfsRoutePrefix,
        ipnsRoutePrefix: state.ipnsRoutePrefix,
        radicleApiPrefix: state.radicleApiPrefix,
        knownEnsNames: state.knownEnsNames,
      });

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

  // Snapshot the committed display URL for provider origin derivation.
  // This ensures getDisplayUrlForWebview() reads the post-navigation identity,
  // not a stale or user-edited address bar value.
  navState.addressBarSnapshot = addressInput.value;
};

// Update bookmark bar visibility for a URL change
const updateBookmarkBarState = (url) => {
  if (!bookmarksBar) return;
  const bookmarkBarState = getBookmarkBarState({
    url,
    bookmarkBarOverride,
    homeUrl,
    homeUrlNormalized,
  });
  if (bookmarkBarState.visible) {
    // Always show on new tab page regardless of toggle
    bookmarksBar.classList.remove('hidden');
  } else {
    bookmarksBar.classList.add('hidden');
  }
  // Disable the menu item on the new tab page (toggle has no effect there)
  electronAPI?.setBookmarkBarToggleEnabled?.(!bookmarkBarState.isHomePage);
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
  updateProtocolIcon();
  if (!state.enableRadicleIntegration && addressInput?.value?.trim().toLowerCase().startsWith('rad:')) {
    loadTarget(addressInput.value);
    return;
  }
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
  trustShield = document.getElementById('trust-shield');
  trustPopover = document.getElementById('trust-popover');

  if (trustShield) {
    trustShield.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTrustPopover();
    });
  }
  document.addEventListener('click', (e) => {
    if (!trustPopover || trustPopover.hidden) return;
    if (trustPopover.contains(e.target)) return;
    if (trustShield && trustShield.contains(e.target)) return;
    setTrustPopoverOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && trustPopover && !trustPopover.hidden) {
      setTrustPopoverOpen(false);
    }
  });
  // Clicks inside the <webview> don't bubble to the main renderer's
  // document (out-of-process frame), so a document-click listener alone
  // misses them. window.blur fires when focus shifts to the webview,
  // which covers any click into loaded page content.
  window.addEventListener('blur', () => {
    if (trustPopover && !trustPopover.hidden) setTrustPopoverOpen(false);
  });

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
    // loadTarget handles all protocol dispatch (ENS, freedom://, bzz://,
    // ipfs://, https://, rad://) and owns the ENS trust state mutation.
    // Earlier this handler duplicated the ENS path, which bypassed the
    // trust updates and left the shield empty for typed-address flows.
    loadTarget(addressInput.value);
    addressInput.blur();
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
        // Notify other modules that navigation completed (for dApp connection banner)
        document.dispatchEvent(new CustomEvent('navigation-completed'));
        break;

      case 'certificate-error':
        // Certificate error occurred - mark page as insecure
        currentPageSecure = false;
        updateProtocolIcon();
        pushDebug(`Certificate error: ${data.event?.error}`);
        break;

      case 'did-navigate-in-page':
        if (data.event) handleNavigationEvent(data.event);
        // Notify other modules that navigation completed (for dApp connection banner)
        document.dispatchEvent(new CustomEvent('navigation-completed'));
        break;

      case 'dom-ready':
        if (webview) webview.classList.remove('hidden');
        updateNavigationState();
        ensureWebContentsId();
        pushDebug('Webview ready.');
        break;

      case 'ipc-message': {
        if (data.channel === 'ens:continue-unverified') {
          const name = data.args?.[0]?.name;
          if (name) {
            pushDebug(`ENS continue-unverified requested for ${name}`);
            loadTarget('ens://' + name, null, webview, { allowUnverifiedOnce: true });
          }
        } else if (data.channel === 'ens:open-settings') {
          loadTarget('freedom://settings', null, webview);
        }
        break;
      }

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
          const display = deriveSwitchedTabDisplay({
            url,
            isLoading,
            addressBarSnapshot: tabNavState.addressBarSnapshot,
            isViewingSource,
            bzzRoutePrefix: state.bzzRoutePrefix,
            homeUrlNormalized,
            ipfsRoutePrefix: state.ipfsRoutePrefix,
            ipnsRoutePrefix: state.ipnsRoutePrefix,
            radicleApiPrefix: state.radicleApiPrefix,
            knownEnsNames: state.knownEnsNames,
          });
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
