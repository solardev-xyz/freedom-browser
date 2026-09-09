// Navigation, webview, and address bar handling
import { state, isRadicleDisabledForProfile } from './state.js';
import { pushDebug } from './debug.js';
import { updateBookmarkButtonVisibility } from './bookmarks-ui.js';
import { updateGithubBridgeIcon } from './github-bridge-ui.js';
import {
  applyEnsSuffix,
  buildRadicleDisabledUrl,
  buildTrustRows,
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
  looksLikeBzzInput,
  deriveDisplayValue,
  deriveBzzBaseFromUrl,
  buildEnsDisplayUri,
  isEnsBackedDisplay,
  isSupportedEnsTransport,
  formatOnchainAppUrl,
  formatOnchainAppDisplayUrl,
  looksLikeOnchainAppInput,
} from './url-utils.js';
import { buildSearchUrl } from './search-utils.js';
import { isModalDialogOpen } from './modal-dialog.js';
import {
  applyInputSelection,
  captureInputSelection,
  clearAddressBarEdit,
  isAddressBarEditInProgress,
  setAddressBarEdit,
} from './address-bar-edit.js';
import {
  getActiveWebview,
  getActiveTab,
  getActiveTabState,
  openInNewTabWithTarget,
  routeInternalPageNavigation,
  setOnchainProvenanceChangeHandler,
  setWebviewEventHandler,
  updateActiveTabTitle,
  updateTabFavicon,
  setTabLoading,
  getTabs,
  getTabById,
  getTabIdForWebview,
  isActiveTab,
} from './tabs.js';
import {
  homeUrl,
  homeUrlNormalized,
  internalPages,
  detectProtocol,
  isHistoryRecordable,
  getInternalPageName,
  getOnchainInterstitialTarget,
  getInterstitialDisplayName,
  isErrorPageUrl,
  isInterstitialPageUrl,
  isNewTabPageUrl,
  isOnchainInterstitialPageUrl,
  isTrustInterstitialPageUrl,
  parseEnsInput,
  buildInternalPageUrl,
} from './page-urls.js';
import { isTezosDomainHost } from './origin-utils.js';
import {
  shouldRecordHistory,
  shouldCacheFavicons,
  shouldLearnAutocomplete,
} from './private-mode.js';
import { parseEthereumUri } from './ethereum-uri.js';
import {
  openSendFlow,
  SEND_FLOW_OK,
  SEND_FLOW_DISABLED,
  SEND_FLOW_PRIVATE,
  SEND_FLOW_SETUP,
} from './wallet-ui.js';
import { walletState } from './wallet/wallet-state.js';
import { formatWeiToDecimal } from './wallet/send.js';
import { startIpfsProgressStatus, stopIpfsProgressStatus } from './ipfs-progress-status.js';
import { TOOLTIP_HOVER_DELAY_MS } from './hover-tooltip.js';
import { matchesShortcut } from './shortcuts.js';

// Helper to get active tab's navigation state (with fallback to empty object)
const getNavState = () => getActiveTabState() || {};

// True while the autocomplete dropdown is showing a previewed suggestion, in
// which case that module owns the current Escape press (it returns to the
// user's typed text) and this one stands down for it. index.js wires
// autocomplete's `isSuggestionPreviewActive` in here at startup. The check
// has to live on this side because `initNavigation()` registers its
// address-input keydown listener *before* `initAutocomplete()` does, so a
// `stopPropagation()` in the later listener cannot unwind one that has
// already run. See #310.
let isSuggestionPreviewActive = () => false;

export const setSuggestionPreviewProbe = (probe) => {
  isSuggestionPreviewActive = typeof probe === 'function' ? probe : () => false;
};

// Write a page-derived display value into the address bar, unless the user is
// mid-edit. Chrome's omnibox keeps "user input in progress" text through any
// navigation committing in the tab — a slow page finishing, a client-side
// redirect, a meta refresh, a same-document navigation — and only replaces it
// when the user commits, presses Escape, or the edit is otherwise ended.
// `addressBarSnapshot` always gets the page's own display value so Escape and
// tab switches still have the truthful page URL to fall back to. See #305.
const commitAddressDisplay = (value, navState = getNavState()) => {
  navState.addressBarSnapshot = value;
  if (isAddressBarEditInProgress(navState)) {
    pushDebug(`[AddressBar] Held (user edit in progress), page is: ${value}`);
    return false;
  }
  if (addressInput.value !== value) {
    addressInput.value = value;
  }
  return true;
};

// Maximum number of name-resolution hops a single navigation may take before
// loadTarget gives up. One hop is the normal case (name → content URI); a
// second is slack for a legitimate redirect. Anything beyond that is a
// resolve→navigate loop, not a real site.
const MAX_NAME_RESOLUTION_DEPTH = 3;

// Shown (in the debug trail) when a rad: navigation is refused because the
// active profile has Radicle disabled — the page itself explains the setting.
const RADICLE_DISABLED_MESSAGE =
  'Radicle is disabled for this profile. Enable it in Settings > Nodes';

const isIpfsProgressUrl = (value) => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.startsWith('ipfs://') || normalized.startsWith('ipns://');
};

const nameSystemLabelForName = (name = '') => {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.tez')) return 'Tezos Domains';
  if (lower.endsWith('.wei')) return 'WNS';
  if (lower.endsWith('.gwei')) return 'GNS';
  return 'ENS';
};

const resolverForNameInput = (input) =>
  input?.system === 'tezos' ? electronAPI?.resolveTezosDomain : electronAPI?.resolveEns;

const appendPublishedWebsiteSuffix = (targetUri, suffix = '') => {
  if (!suffix) return targetUri;
  try {
    const target = new URL(targetUri);
    const requested = new URL(suffix, 'https://name.invalid/');
    if (suffix.startsWith('/')) {
      const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
      target.pathname = `${basePath}${requested.pathname}`;
    }
    // Only override query/fragment the suffix actually carries, so a
    // published content URL like `…/page?v=2` keeps its query when the
    // address bar appends a bare path.
    if (requested.search) target.search = requested.search;
    if (requested.hash) target.hash = requested.hash;
    return target.toString();
  } catch {
    return `${targetUri.replace(/\/+$/, '')}${suffix}`;
  }
};

const invalidateContentName = (input) => {
  if (!input?.name) return;
  if (input.system === 'tezos') {
    electronAPI?.invalidateTezosDomain?.(input.name).catch((err) => {
      pushDebug(`[Tezos Domains] cache invalidation failed: ${err?.message || err}`);
    });
    return;
  }
  electronAPI?.invalidateEnsContent?.(input.name).catch((err) => {
    pushDebug(`[ENS] invalidateEnsContent failed: ${err?.message || err}`);
  });
};

// Experimental opt-in (Settings → Experimental, default off). Mirrors the
// `showIpfsProgressStatus` setting, seeded in initNavigation and kept live via
// the `settings:updated` broadcast. While off, the IPFS progress poller never
// starts, so the link bar stays a pure hover-URL surface.
let ipfsProgressStatusEnabled = false;

const shouldShowIpfsProgress = ({ data = {}, tab = null, navState = null } = {}) => {
  if (!ipfsProgressStatusEnabled) return false;
  const candidates = [
    data.url,
    data.pendingNavigationUrl,
    navState?.pendingNavigationUrl,
    tab?.navigationState?.pendingNavigationUrl,
    tab?.url,
    navState?.currentPageUrl,
  ];
  return candidates.some(isIpfsProgressUrl);
};

// The 64- or 128-char hex Swarm reference (unencrypted / encrypted). Single
// source for the gateway-URL helpers below so the patterns can't drift.
const BZZ_REF_SOURCE = '[a-fA-F0-9]{64}(?:[a-fA-F0-9]{64})?';
// `/bzz/<ref>` appearing anywhere in a gateway URL string — deliberately
// unanchored so gateways mounted under a path prefix still match.
const BZZ_REF_ANYWHERE_RE = new RegExp(`/bzz/(${BZZ_REF_SOURCE})`);
// A gateway URL pathname of exactly `/bzz/<ref><in-manifest path>`.
const BZZ_GATEWAY_PATHNAME_RE = new RegExp(`^/bzz/(${BZZ_REF_SOURCE})(/.*)?$`);

// Extract the bzz reference (64- or 128-char hex) from a Bee gateway URL.
const extractBzzHash = (gatewayUrl) => {
  const match = BZZ_REF_ANYWHERE_RE.exec(gatewayUrl || '');
  return match ? match[1] : null;
};

// Parse a Bee gateway URL whose pathname is `/bzz/<ref><path>` into its
// reference, in-manifest path ('' at the manifest root), query, and
// fragment. Returns null when the URL doesn't have that shape.
const parseBzzGatewayUrl = (gatewayUrl) => {
  try {
    const parsed = new URL(gatewayUrl || '');
    const match = BZZ_GATEWAY_PATHNAME_RE.exec(parsed.pathname);
    if (!match) return null;
    return { hash: match[1], path: match[2] || '', search: parsed.search, fragment: parsed.hash };
  } catch {
    return null;
  }
};

// Extract the in-manifest path (sans query/fragment) that follows the bzz
// reference in a Bee gateway URL, e.g. `<bee-api>/bzz/<hash>/index.html?q`
// → `/index.html`. Returns '' when the URL targets the manifest root. The
// probe must HEAD the exact resource the navigation will load: a manifest
// with no root index document 404s on the bare hash forever, which the
// probe can't tell apart from a still-warming node (see swarm-probe.js).
const extractBzzPath = (gatewayUrl) => parseBzzGatewayUrl(gatewayUrl)?.path || '';

// Convert a Bee gateway URL (<bee-api>/bzz/<hash>/path?q#h) into
// the `bzz://<hash>/path?q#h` form that Chromium routes through the custom
// protocol handler. Falls back to the gateway URL if the shape doesn't match.
const gatewayUrlToBzzUrl = (gatewayUrl) => {
  const parsed = parseBzzGatewayUrl(gatewayUrl);
  if (!parsed) return gatewayUrl;
  return `bzz://${parsed.hash}${parsed.path || '/'}${parsed.search}${parsed.fragment}`;
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

// True when the IPFS node can't currently serve content — disabled for this
// profile, or stopped/errored. Used to route ipfs:// / ipns:// navigations to
// the friendly error page instead of letting the ipfs: protocol handler return
// a raw JSON 503 body that Chromium would render verbatim. `starting` and
// `running` are allowed through (the load proceeds normally).
const isIpfsNodeUnavailable = () => {
  // The Nodes-menu switch sets `ipfsDesiredRunning` synchronously, but the
  // actual `window.ipfs.stop()` and the resulting `stopped` status event lag
  // behind (see ipfs-ui.js reconcileIpfsToggle). A navigation fired immediately
  // after flipping the switch off would otherwise still see `currentIpfsStatus:
  // 'running'` and let the load hit the ipfs: handler's raw 503. Honor the
  // just-set intent so the friendly page shows right away. `null` means no
  // pending toggle — fall through to the committed mode/status below.
  if (state.ipfsDesiredRunning === false) return true;
  return (
    state.registry?.ipfs?.mode === 'disabled' ||
    state.currentIpfsStatus === 'stopped' ||
    state.currentIpfsStatus === 'error'
  );
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
// the in-flight work (e.g. ENS resolution), rather than whatever tab
// happens to be active when the promise settles. Without this, a slow
// ENS lookup on Tab A that resolves while the user is viewing Tab B
// would clear Tab B's spinner and leave Tab A's stuck. The global
// helpers (`updateBookmarkButtonVisibility`, `updateGithubBridgeIcon`)
// refresh foreground UI; we only fire them when the affected tab is
// active (or no tab id was supplied).
//
// When `tabId` is null we forward to `setTabLoading` as a single-arg
// call so the synchronous code paths (did-start-loading,
// did-stop-loading, tab-switched) keep their pre-existing call shape.
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

// Update the address bar to show the navigation target. When the target
// tab is the active one (or unknown), this writes through to the visible
// address input and refreshes the protocol icon — same behaviour as before.
// When the target is a backgrounded tab (e.g. an ENS click in Tab A whose
// resolution settled while the user is now on Tab B), we stash the
// display value on that tab's `navigationState.addressBarSnapshot` so the
// `tab-switched` handler picks it up when the user switches back. This
// prevents the resolved URL from clobbering the foreground tab's address
// bar after a slow ENS resolution settles in the background.
//
// `isViewingSourceForTab` writes through to `tab.isViewingSource` (the
// canonical per-tab record owned by tabs.js' did-navigate handler) so a
// switchback after a background-tab view-source dispatch picks up the
// right state.
//
// This helper deliberately never writes `committedDisplayUrl`. That
// field is the post-commit page identity used by reload and by provider
// permission keying; writing it before `webview.loadURL` actually
// commits would let the destination origin briefly stand in for the
// still-loaded previous page (most starkly: `bzz://name.eth` is set
// here before the Bee warm-probe even completes). The committed write
// belongs in tabs.js' per-webview `did-navigate` handler, which fires
// for both active and background tabs once Chromium has actually
// committed the navigation.
//
// The active-tab branch is gated on a value-change check so repeated
// no-op calls (every dispatch + every did-navigate on the hot path) don't
// re-run `updateProtocolIcon`, which walks `state.ensTrustByName` and
// invokes the trust-badge resolver on every call.
const setAddressDisplayForTab = (displayValue, tabId, { isViewingSourceForTab = false } = {}) => {
  if (isActiveTab(tabId) || tabId === null) {
    // Same rule as `commitAddressDisplay`: a resolution settling on the
    // foreground tab (e.g. a slow ENS lookup) must not overwrite text the
    // user is typing. See #305.
    if (isAddressBarEditInProgress()) {
      const navState = getNavState();
      navState.addressBarSnapshot = displayValue;
      pushDebug(`[AddressBar] Held (user edit in progress), page is: ${displayValue}`);
      return;
    }
    if (addressInput.value !== displayValue) {
      addressInput.value = displayValue;
      updateProtocolIcon();
    }
    return;
  }
  const targetTab = tabId !== null && tabId !== undefined ? getTabById(tabId) : null;
  if (!targetTab) return;
  if (targetTab.navigationState) {
    targetTab.navigationState.addressBarSnapshot = displayValue;
  }
  if (isViewingSourceForTab) {
    targetTab.isViewingSource = true;
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

// Screen-reader label for the shield button, keyed on trust level. Updated
// alongside the data-trust attribute so assistive tech announces the state.
const TRUST_ARIA_LABEL = {
  verified: 'Ethereum name resolution trust: verified',
  'user-configured': 'Ethereum name resolution trust: user-configured',
  unverified: 'Ethereum name resolution trust: unverified',
  conflict: 'Ethereum name resolution trust: conflict',
};

// Shrink a long value to fit on a single line in the popover by
// symmetric middle-truncation. Binary-searches the largest head/tail
// length whose rendered width still fits inside the row's clientWidth.
// Operates on the field row's scrollWidth vs clientWidth (the row has
// overflow:hidden), so the row must already be in the laid-out DOM
// (i.e. called after the popover is un-hidden). Only the value span
// is mutated — the label span is left intact.
const fitFieldValueToWidth = (fieldDiv, fullValue) => {
  const valueSpan = fieldDiv.querySelector('.trust-popover-field-value');
  if (!valueSpan) return;

  valueSpan.textContent = fullValue;
  if (fieldDiv.scrollWidth <= fieldDiv.clientWidth) return;

  let lo = 1;
  let hi = Math.floor(fullValue.length / 2);
  let best = 0;
  while (lo <= hi) {
    const k = Math.floor((lo + hi) / 2);
    valueSpan.textContent = `${fullValue.slice(0, k)}…${fullValue.slice(fullValue.length - k)}`;
    if (fieldDiv.scrollWidth <= fieldDiv.clientWidth) {
      best = k;
      lo = k + 1;
    } else {
      hi = k - 1;
    }
  }

  if (best > 0) {
    valueSpan.textContent = `${fullValue.slice(0, best)}…${fullValue.slice(fullValue.length - best)}`;
  } else {
    // Even a 1+1 middle-truncation overflows; fall back to the full
    // value and let the row's text-overflow:ellipsis trim the end
    // rather than rendering a misleading "…x" head.
    valueSpan.textContent = fullValue;
  }
};

// Tooltip state for the "Copy" hover hint and "Copied" post-click
// confirmation. Module-level (rather than per-popover-open closure)
// so setTrustPopoverOpen can cancel pending timers cleanly when the
// popover closes — otherwise a stale "Copied" timer could fire and
// poke at the tooltip after a fresh open.
let trustTooltipShowTimer = null;
let trustTooltipCopiedTimer = null;
let trustTooltipCopiedActive = false;

// Appear delay is shared app-wide (see hover-tooltip.js); the "Copied" hold is
// specific to this copy-confirmation tooltip.
const TRUST_TOOLTIP_HOVER_DELAY_MS = TOOLTIP_HOVER_DELAY_MS;
const TRUST_TOOLTIP_COPIED_HOLD_MS = 1200;

const resetTrustTooltip = () => {
  clearTimeout(trustTooltipShowTimer);
  clearTimeout(trustTooltipCopiedTimer);
  trustTooltipShowTimer = null;
  trustTooltipCopiedTimer = null;
  trustTooltipCopiedActive = false;
  const tooltip = document.getElementById('trust-popover-tooltip');
  if (tooltip) {
    tooltip.hidden = true;
    tooltip.textContent = 'Copy';
  }
};

// Identity of the ENS resolution currently rendered into the popover —
// `{ name, trust }` while open, `null` while closed. Used by the
// stale-popover guard in `updateProtocolIcon` so we can dismiss the
// popover when the address bar moves to a different ENS name, a non-ENS
// URL, an internal page, or a different tab. Comparing the trust
// reference (and not just the name) also catches the rarer case where
// a fresh resolution replaces the stored trust for the same name while
// the popover is open.
let trustPopoverDisplayed = null;

// Toggle popover visibility and the matching aria-expanded state on the
// shield. All popover-content building lives in `toggleTrustPopover` —
// this helper only flips chrome and resets the floating-tooltip state so
// a pending "Copy"/"Copied" hint can't outlive the open it belongs to.
const setTrustPopoverOpen = (open) => {
  if (!trustPopover || !trustShield) return;
  trustPopover.hidden = !open;
  trustShield.setAttribute('aria-expanded', open ? 'true' : 'false');
  resetTrustTooltip();
  if (!open) {
    trustPopoverDisplayed = null;
  }
};

// Public hook so other modules (e.g. menus.js) can dismiss the popover
// without duplicating the open/close logic.
export const closeTrustPopover = () => {
  if (trustPopover && !trustPopover.hidden) {
    setTrustPopoverOpen(false);
  }
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
    onchainProvenance: getActiveTab()?.onchainProvenance,
  });
  if (!badge) return;

  const { trust, name, level } = badge;
  trustPopover.setAttribute('data-trust', level);

  const title = document.getElementById('trust-popover-title');
  const statusEl = document.getElementById('trust-popover-status');
  const trustFieldsEl = document.getElementById('trust-popover-trust-fields');
  const contentEl = document.getElementById('trust-popover-content');
  const contentTitleEl = document.getElementById('trust-popover-content-title');
  const contentFieldsEl = document.getElementById('trust-popover-content-fields');

  if (title) title.textContent = name;

  // Pure helper computes status sentence + the two row arrays. Keeps
  // the level/scheme/proto branching unit-testable and out of the DOM
  // build path below.
  const { status, trustRows, contentRows } = buildTrustRows({
    trust,
    level,
    uri: state.ensUriByName.get(name) || '',
    proto: state.ensProtocols.get(name),
    onchainProvenance: badge.provenance,
  });
  if (contentTitleEl) {
    contentTitleEl.textContent = badge.kind === 'onchain' ? 'Loads from' : 'Resolves to';
  }

  if (statusEl) {
    if (status === null) {
      console.warn('[trust] unknown trust level:', level);
      statusEl.textContent = '';
    } else {
      statusEl.textContent = status;
    }
  }

  // Shared floating tooltip used by all clickable value spans across
  // both field groups. Switches between "Copy" (hover) and "Copied"
  // (post-click). Positioned by JS just below the cursor when first
  // shown; never follows the cursor afterwards.
  const tooltipEl = document.getElementById('trust-popover-tooltip');

  const positionTooltip = (clientX, clientY) => {
    if (!tooltipEl) return;
    tooltipEl.style.left = `${clientX + 12}px`;
    tooltipEl.style.top = `${clientY + 18}px`;
  };

  // Build a single field row: a non-clickable label span + a
  // clickable value span. Only the value carries the cursor:pointer,
  // the data-copy attribute, and the hover/click event handlers.
  const buildRow = (row) => {
    const div = document.createElement('div');
    div.className = 'trust-popover-field';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'trust-popover-field-label';
    labelSpan.textContent = `${row.label}: `;
    div.appendChild(labelSpan);

    const valueSpan = document.createElement('span');
    valueSpan.className = 'trust-popover-field-value';
    valueSpan.textContent = row.display;
    div.appendChild(valueSpan);

    if (row.autoFit) {
      div.dataset.autoFit = row.autoFit;
    }

    if (row.copy) {
      valueSpan.dataset.copy = row.copy;

      valueSpan.addEventListener('mousemove', (e) => {
        // While "Copied" is showing, keep the tooltip pinned where
        // the click happened — don't follow the cursor or let the
        // hover-show timer fire underneath.
        if (trustTooltipCopiedActive) return;
        if (!tooltipEl) return;
        // Once the tooltip is visible, it stays put. Only the
        // *initial* position (captured below) is honoured; further
        // mousemove events while the tooltip is already shown are
        // ignored so the tooltip doesn't drift along with the
        // cursor.
        if (!tooltipEl.hidden) return;
        const x = e.clientX;
        const y = e.clientY;
        clearTimeout(trustTooltipShowTimer);
        trustTooltipShowTimer = setTimeout(() => {
          if (trustTooltipCopiedActive) return;
          if (!tooltipEl) return;
          positionTooltip(x, y);
          tooltipEl.textContent = 'Copy';
          tooltipEl.hidden = false;
        }, TRUST_TOOLTIP_HOVER_DELAY_MS);
      });

      valueSpan.addEventListener('mouseleave', () => {
        // Clear the hover-show timer, but DON'T clear the "Copied"
        // hold timer: the user may have already moved away after
        // clicking, and we still want them to see the confirmation
        // for the rest of its hold window.
        clearTimeout(trustTooltipShowTimer);
        trustTooltipShowTimer = null;
        if (!trustTooltipCopiedActive && tooltipEl) {
          tooltipEl.hidden = true;
        }
      });

      valueSpan.addEventListener('click', async (e) => {
        clearTimeout(trustTooltipShowTimer);
        clearTimeout(trustTooltipCopiedTimer);
        trustTooltipShowTimer = null;
        trustTooltipCopiedActive = true;

        if (tooltipEl) {
          tooltipEl.textContent = 'Copied';
          positionTooltip(e.clientX, e.clientY);
          tooltipEl.hidden = false;
        }

        trustTooltipCopiedTimer = setTimeout(() => {
          trustTooltipCopiedActive = false;
          trustTooltipCopiedTimer = null;
          if (tooltipEl) {
            tooltipEl.hidden = true;
            tooltipEl.textContent = 'Copy';
          }
        }, TRUST_TOOLTIP_COPIED_HOLD_MS);

        const text = valueSpan.dataset.copy || '';
        if (!text) return;
        try {
          await electronAPI?.copyText?.(text);
        } catch (err) {
          console.warn('[trust] copy failed:', err);
        }
      });
    } else {
      // No copy value (e.g. the Network row, or unknown-protocol
      // fallback). No cursor change, no tooltip handlers — the row
      // reads as plain text.
      div.classList.add('trust-popover-field-uncopyable');
    }
    return div;
  };

  if (trustFieldsEl) {
    trustFieldsEl.replaceChildren(...trustRows.map(buildRow));
  }
  if (contentFieldsEl) {
    contentFieldsEl.replaceChildren(...contentRows.map(buildRow));
  }
  if (contentEl) contentEl.hidden = contentRows.length === 0;

  // Record the identity of what's now rendered before we flip the
  // popover open — `setTrustPopoverOpen(true)` doesn't clear it, only
  // the close path does.
  trustPopoverDisplayed = { name, trust };
  setTrustPopoverOpen(true);

  // Fit-to-width truncation runs AFTER the popover is un-hidden so
  // scrollWidth / clientWidth reflect real layout. Each row that
  // carries data-auto-fit gets its value middle-truncated to fit a
  // single line.
  [trustFieldsEl, contentFieldsEl].forEach((groupEl) => {
    if (!groupEl) return;
    groupEl.querySelectorAll('[data-auto-fit]').forEach((div) => {
      fitFieldValueToWidth(div, div.dataset.autoFit);
    });
  });
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
      onchainProvenance: getActiveTab()?.onchainProvenance,
    });
    if (badge) {
      trustShield.setAttribute('data-trust', badge.level);
      trustShield.setAttribute(
        'aria-label',
        badge.kind === 'onchain'
          ? `Onchain application provenance: ${badge.level}`
          : TRUST_ARIA_LABEL[badge.level] || 'Ethereum name resolution trust status'
      );
      trustShield.hidden = false;
    } else {
      trustShield.removeAttribute('data-trust');
      trustShield.setAttribute('aria-label', 'Site provenance status');
      trustShield.hidden = true;
    }

    // Stale-popover guard: if the popover is open but the address bar
    // no longer resolves to the same ENS name + trust object the
    // popover was opened against, dismiss it. Without this, navigating
    // away (to a non-ENS URL, an internal page, or a different ENS
    // name) or switching to another tab would leave a misleading
    // popover behind showing details for the previous resolution —
    // a real risk on a security/trust surface.
    if (trustPopover && !trustPopover.hidden && trustPopoverDisplayed) {
      const stale =
        !badge ||
        badge.name !== trustPopoverDisplayed.name ||
        badge.trust !== trustPopoverDisplayed.trust;
      if (stale) setTrustPopoverOpen(false);
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

// One message per openSendFlow refusal reason: the way out differs for each,
// and telling a private-window user with a fully set-up wallet to flip a
// Settings toggle that is already on leaves them nowhere to go (#240).
const SEND_FLOW_REFUSAL_MESSAGES = {
  [SEND_FLOW_DISABLED]: 'Enable Identity & Wallet (Settings → Experimental) to accept tips.',
  [SEND_FLOW_PRIVATE]:
    'Wallet is unavailable in private windows. Open a normal window to accept tips.',
  [SEND_FLOW_SETUP]: 'Finish setting up Identity & Wallet to accept tips.',
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
  const result = openSendFlow({
    recipient: parsed.target,
    chainId: parsed.chainId,
    amount,
  });
  if (result !== SEND_FLOW_OK) {
    alert(SEND_FLOW_REFUSAL_MESSAGES[result] || SEND_FLOW_REFUSAL_MESSAGES[SEND_FLOW_DISABLED]);
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
  // Probe the same in-manifest path the navigation will load. The gateway
  // URL carries the full path in both the direct-hash and ENS-host cases
  // (the ENS resolution feeds `bzz://<hash><suffix>` back through
  // formatBzzUrl), so extracting it here covers both.
  const probePath = extractBzzPath(gatewayUrl);
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
  // Tab id of the navigation we're probing for — pinned so an ENS
  // resolution that settles after a tab switch updates only the
  // originating tab's spinner.
  const probeTabId = getTabIdForWebview(webview);

  setLoading(true, probeTabId);
  navState.isWebviewLoading = true;
  if (isActiveTab(probeTabId)) {
    reloadBtn.dataset.state = 'stop';
  }
  pushDebug(`[Swarm] Probing ${gatewayUrl} before navigating`);

  electronAPI
    .startSwarmProbe(hash, probePath)
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

      // If the probe target was an ENS-named bzz URL (`bzz://name.eth/`)
      // and the probe failed (404 / await failure / other content
      // unavailability), invalidate the cached contenthash. Otherwise a
      // "Try Again" click immediately re-resolves to the same stale
      // hash and probes the same dead content. `bee_unreachable` and
      // `aborted` aren't content failures — leave the cache alone.
      const ensNameForInvalidation = (() => {
        const match = (target.bzzLoadUrl || '').match(/^bzz:\/\/([^/?#]+)/i);
        return match && parseEnsInput(`bzz://${match[1]}`) ? match[1].toLowerCase() : null;
      })();
      const invalidateOnContentFailure = () => {
        if (!ensNameForInvalidation || !electronAPI?.invalidateEnsContent) return;
        electronAPI.invalidateEnsContent(ensNameForInvalidation).catch((err) => {
          pushDebug(`[Swarm] invalidateEnsContent failed: ${err?.message || err}`);
        });
      };

      if (!awaitResult || awaitResult.success === false) {
        const message = awaitResult?.error?.message || 'failed to await probe';
        pushDebug(`[Swarm] Probe await failed: ${message}`);
        invalidateOnContentFailure();
        webview.loadURL(buildErrorPageUrl('swarm_content_not_found', errorDisplayUrl, errorExtras));
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
        webview.loadURL(buildErrorPageUrl('ERR_CONNECTION_REFUSED', errorDisplayUrl, errorExtras));
        return;
      }

      pushDebug(`[Swarm] Probe failed (${outcome.reason}) — showing error page`);
      invalidateOnContentFailure();
      webview.loadURL(buildErrorPageUrl('swarm_content_not_found', errorDisplayUrl, errorExtras));
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

// `freedom://<page>[/<sub>]` (e.g. freedom://settings/appearance), the only
// shape the internal-page branch below accepts.
const FREEDOM_PAGE_PATTERN = /^freedom:\/\/([a-zA-Z0-9-]+)(?:\/([a-zA-Z0-9-]+))?\/?$/i;

// `{ pageName, subPath }` for a recognised internal page, else null. Parsed up
// front so `loadTarget` can settle *where* the open lands before it runs any
// bookkeeping on the tab it may be about to leave alone; an unknown page name
// stays null here and is reported by the branch further down.
const parseInternalPageTarget = (value) => {
  const match = typeof value === 'string' ? value.match(FREEDOM_PAGE_PATTERN) : null;
  if (!match) return null;
  const pageName = match[1].toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(internalPages, pageName)) return null;
  return { pageName, subPath: match[2]?.toLowerCase() || null };
};

export const loadTarget = (value, displayOverride = null, targetWebview = null, options = {}) => {
  // `options.allowUnverifiedOnce` — skip the unverified-ENS interstitial
  // for this single call. Set by the ens-unverified page's "Continue once"
  // handler. Scope is this single loadTarget invocation.
  //
  // `options.pageInitiated` — this navigation came from the page, not from
  // the browser chrome (an intercepted in-page link or a scripted location
  // change replayed through `navigate-to-url`). It leaves any uncommitted
  // address-bar edit in place; see the `clearAddressBarEdit` call below.
  //
  // `options.continuesNavigation` — this call is the second leg of a
  // navigation that already ran the entry bookkeeping below (a name
  // resolution settling, the search-provider fallback at the tail). Same
  // effect as `pageInitiated` for the edit state, and for the same reason:
  // the user drove the chrome once, at the *first* leg. See the
  // `clearAddressBarEdit` call below.
  //
  // `options.keepsAddressBarEdit` — this call re-runs a navigation the tab is
  // already on (reload / retry of an error page, a settings-driven refresh)
  // rather than committing something the user typed. Chrome keeps user input
  // in progress across a reload, and the plain `webview.reload()` sibling
  // does too by construction, so these callers hold the draft as well.
  // See the `clearAddressBarEdit` call below.
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
  const navState = getTabById(targetTabId)?.navigationState || getNavState();
  if (!webview) {
    pushDebug('No active webview to load target');
    return;
  }

  // An internal-page open can be answered by a *different* tab (Chrome's
  // singleton rule — see the freedom:// branch below for the full story), in
  // which case this tab is never navigated at all. Settle that before any of
  // the entry bookkeeping underneath, all of which acts on *this* tab: a
  // routed-away open must not cancel the in-flight Swarm probe this tab is
  // still waiting on, nor end the address-bar draft the user has half-typed
  // here (#314) — Chrome keeps both on a tab it leaves alone. When the answer
  // is "this tab", the bookkeeping runs exactly as before and the branch below
  // performs the in-place navigation.
  const internalPageTarget = parseInternalPageTarget(value);
  if (
    internalPageTarget &&
    routeInternalPageNavigation(internalPageTarget.pageName, internalPageTarget.subPath, webview)
  ) {
    const { pageName, subPath } = internalPageTarget;
    pushDebug(`Routed internal page to its own tab: ${pageName}${subPath ? `/${subPath}` : ''}`);
    return;
  }

  // A new navigation invalidates any still-pending Swarm content probe for
  // this tab: either a new bzz probe will start below, or the user is
  // leaving Swarm entirely, in which case we don't want the old probe to
  // eventually navigate the webview to a now-stale bzz URL.
  cancelPendingSwarmProbe(navState);

  // Every chrome-initiated navigation funnels through here (address-bar
  // submit, a picked autocomplete suggestion, bookmarks, menu items), so this
  // is the one place that reliably ends an uncommitted address-bar edit for
  // the tab being navigated.
  //
  // `options.pageInitiated` marks the callers that are *not* the user driving
  // the chrome: an in-page link click, and — the case #305 was reported
  // against — a scripted `location.href` to a custom scheme, which the main
  // process cancels and replays through here as `navigate-to-url`. Those must
  // leave a half-typed address alone, exactly like the `did-navigate` path.
  //
  // `options.continuesNavigation` marks loadTarget's own recursive calls (a
  // name resolution settling, the search fallback). Those are not a second
  // user action: for a page-driven navigation there was never an edit to end,
  // and for a chrome-driven one the commit already ended it at the first leg —
  // possibly seconds ago, before a slow name lookup, so anything in the bar
  // now is a *new* draft the user started while the resolution was in flight.
  // Ending it here is the same clobber, one hop later (#305).
  //
  // `options.keepsAddressBarEdit` marks the re-runs of the navigation the tab
  // is already on (reload, error-page retry, a settings-driven refresh). They
  // aren't a commit of the bar's contents, and the `webview.reload()` branch
  // of the very same affordance holds the draft, so these must too.
  if (!options.pageInitiated && !options.continuesNavigation && !options.keepsAddressBarEdit) {
    clearAddressBarEdit(navState);
  }

  // Handle view-source: URLs - need to resolve dweb URLs before loading
  if (value.startsWith('view-source:')) {
    // …but never for one of our own trust interstitials. Those pages are
    // chrome, not content: their source is the shell's own bundled HTML, and
    // committing `view-source:file:///…/pages/onchain-unverified.html?…`
    // publishes the gate's single-use approval token (and the on-disk
    // implementation path) into the address bar, the tab title and the
    // window title — the leak #235 exists to prevent, on every surface that
    // repaints from the committed URL. The context menu hides the item; this
    // also covers a typed or restored URL. See issue #235.
    if (isTrustInterstitialPageUrl(value.slice(12))) {
      pushDebug('[ViewSource] Refused: browser-owned trust interstitial');
      return;
    }
    isViewingSource = true; // Track that this tab is viewing source
    const innerUrl = value.slice(12); // 'view-source:'.length === 12

    // If inner URL is a dweb URL, we need to resolve it first
    // Check for ENS
    const ens = parseEnsInput(innerUrl);
    const resolveName = resolverForNameInput(ens);
    if (ens && resolveName) {
      const systemLabel = nameSystemLabelForName(ens.name);
      const capturedWebview = webview;
      // Tab id pinned for the duration of this async resolution so a tab
      // switch can't redirect the spinner to the wrong tab when the
      // promise settles.
      const capturedTabId = getTabIdForWebview(capturedWebview);
      setLoading(true, capturedTabId);
      // Show the legacy view-source ENS placeholder while resolution is in
      // flight. Once we know the resolved transport we update the address
      // bar to the transport-aware form (e.g. `view-source:bzz://name.eth`).
      // Route through `setAddressDisplayForTab` so a switchback after a
      // background-tab dispatch restores the resolved value rather than
      // clobbering the foreground tab.
      setAddressDisplayForTab(
        `view-source:${ens.system === 'tezos' ? '' : 'ens://'}${ens.name}${ens.suffix || ''}`,
        capturedTabId,
        { isViewingSourceForTab: true }
      );
      resolveName(ens.name)
        .then((result) => {
          setLoading(false, capturedTabId);
          if (!result || result.type !== 'ok') {
            if (isActiveTab(capturedTabId)) {
              alert(
                `${systemLabel} resolution failed for ${ens.name}: ${result?.reason || 'no response'}`
              );
            }
            return;
          }
          // Build target URI with path suffix
          const targetUri = applyEnsSuffix(result.uri, ens.suffix);
          storeEnsResolutionMetadata(targetUri, ens.name, { trackProtocol: false });

          const transportDisplay = buildEnsDisplayUri(result.protocol, ens.name, ens.suffix);
          if (transportDisplay) {
            setAddressDisplayForTab(`view-source:${transportDisplay}`, capturedTabId, {
              isViewingSourceForTab: true,
            });
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
            alert(`${systemLabel} resolution error: ${err.message}`);
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
    setAddressDisplayForTab(viewSourceNavigation.addressValue, targetTabId, {
      isViewingSourceForTab: true,
    });
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
  const fbMatch = value.match(FREEDOM_PAGE_PATTERN);
  if (fbMatch) {
    const pageName = fbMatch[1].toLowerCase();
    const subPath = fbMatch[2]?.toLowerCase() || null;
    const pageUrl = internalPages[pageName];
    if (pageUrl) {
      // Every internal page is a singleton, as in Chrome: an open Settings
      // (History, Profiles, …) tab is focused rather than duplicated, whether
      // the open came from the hamburger menu, the address bar, a bookmark, a
      // same-tab link or an interstitial button — the paths that all funnel
      // through here. `routeInternalPageNavigation` owns that decision and
      // already ran it above (before the entry bookkeeping, so a routed-away
      // open leaves this tab wholly untouched); reaching here means it
      // answered "this tab": it is already the page's tab, it is an empty New
      // Tab to overwrite, or the page is a new-tab page (`freedom://home`,
      // `freedom://private`), which is deliberately not a singleton and always
      // navigates in place. The link paths that never reach loadTarget (a
      // new-tab/background link activation, `tab:new-with-url`) keep their own
      // singleton branch in `openInNewTabWithTarget`. See #325.
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

  // ERC-8244 contract-hosted applications. The standard `web3:` origin is
  // scoped by both contract and chain (`web3://<address>.eip155-<chainId>/`), while
  // the main-process handler reads the document through Freedom's verified
  // chain-data router. No gateway URL or page-owned RPC endpoint is involved.
  const onchainAppUrl = formatOnchainAppUrl(value);
  if (onchainAppUrl) {
    const displayValue = displayOverride || formatOnchainAppDisplayUrl(value) || onchainAppUrl;
    setAddressDisplayForTab(displayValue, targetTabId);
    navState.pendingTitleForUrl = onchainAppUrl;
    navState.pendingNavigationUrl = onchainAppUrl;
    navState.hasNavigatedDuringCurrentLoad = false;
    webview.loadURL(onchainAppUrl);
    pushDebug(`[Onchain App] Loading ${onchainAppUrl}`);
    syncBzzBase(null);
    return;
  }
  if (looksLikeOnchainAppInput(value)) {
    pushDebug(`[Onchain App] Invalid web3 URL: ${value}`);
    alert(
      'Invalid onchain application URL. Expected web3://<contract>:<chainId>/ ' +
        '(Ethereum mainnet is used when the chain is omitted).'
    );
    return;
  }

  // Try Ethereum names first (legacy ens:// plus supported name suffixes)
  const ens = parseEnsInput(value);
  const resolveName = resolverForNameInput(ens);
  if (ens && resolveName) {
    const systemLabel = nameSystemLabelForName(ens.name);
    // Defence in depth against a resolve→navigate loop. A name record is
    // attacker-controlled: if it points back at another dweb name (e.g. a
    // .tez whose website record is `ipns://self.tez`) the recursive
    // loadTarget below re-enters this branch and never terminates. The
    // resolvers reject name-hosted records at the source; this bounds the
    // renderer regardless of what a resolver hands back.
    const resolutionDepth = options.nameResolutionDepth || 0;
    if (resolutionDepth >= MAX_NAME_RESOLUTION_DEPTH) {
      pushDebug(
        `${systemLabel} resolution loop detected for ${ens.name} (depth ${resolutionDepth}) — aborting`
      );
      alert(`${systemLabel} name ${ens.name} resolves in a loop. Navigation aborted.`);
      return;
    }
    // Capture the webview reference before async operation to prevent loading in wrong tab
    const capturedWebview = webview;
    // Capture the tab id too so async callbacks can route per-tab UI
    // updates (spinner, isLoading state) to the originating tab even
    // after the user switches away mid-resolution. Without this, a slow
    // ENS lookup on Tab A that settles while Tab B is active would clear
    // Tab B's spinner and leave Tab A's stuck.
    const capturedTabId = getTabIdForWebview(capturedWebview);
    // `parseEnsInput` already extracted the transport scheme the user
    // explicitly typed (`bzz`, `ipfs`, `ipns`) — null for bare names and
    // the legacy `ens://` form. We treat it as an assertion: the ENS
    // contenthash MUST match. Captured before the async hop so a
    // follow-up edit to the address bar can't change the assertion under
    // our feet.
    const assertedTransport = ens.assertedTransport;
    setLoading(true, capturedTabId);
    // Show the user what's being loaded immediately so the address bar
    // doesn't stall on the previous URL (or stay empty in a new tab) for
    // the 100ms–1s+ ENS roundtrip. The post-resolution recursive
    // loadTarget call overwrites this with the canonical transport-aware
    // display, which is a small flicker but far better than the dead
    // time. Backgrounded-tab routing and protocol-icon refresh are
    // handled inside `setAddressDisplayForTab`.
    setAddressDisplayForTab(displayOverride || value, capturedTabId);
    pushDebug(`Resolving ${systemLabel} name: ${ens.name}`);
    // Surface a resolution failure: log the structured trail unconditionally
    // (so devtools / the in-browser debug console always see it), but only
    // pop the modal alert if the originating tab is still in the foreground.
    // Modal alerts on a tab the user has switched away from read as random
    // interruptions to the unrelated current page.
    const failEnsResolution = (logMessage, alertMessage) => {
      pushDebug(logMessage);
      if (isActiveTab(capturedTabId)) {
        alert(alertMessage);
      }
    };
    resolveName(ens.name)
      .then((result) => {
        setLoading(false, capturedTabId);
        if (!result) {
          failEnsResolution(
            `${systemLabel} resolution failed for ${ens.name}: no response`,
            `${systemLabel} resolution failed: no response`
          );
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
          pushDebug(`${systemLabel} conflict for ${ens.name}: ${groups.length} groups`);
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
          failEnsResolution(
            `${systemLabel} resolution failed for ${ens.name}: ${reason}`,
            `${systemLabel} resolution failed for ${ens.name}: ${reason}`
          );
          return;
        }

        const isExternalTezosWebsite =
          ens.system === 'tezos' && (result.protocol === 'http' || result.protocol === 'https');
        if (isExternalTezosWebsite) {
          if (assertedTransport) {
            failEnsResolution(
              `${systemLabel} transport mismatch for ${ens.name}: asserted ${assertedTransport}, got ${result.protocol}`,
              `${systemLabel} name ${ens.name} resolves to ${result.protocol}, not ${assertedTransport}.`
            );
            return;
          }
          const targetUri = result.redirect
            ? result.uri
            : appendPublishedWebsiteSuffix(result.uri, ens.suffix);
          if (
            result.trust?.level === 'unverified' &&
            state.blockUnverifiedEns &&
            !options.allowUnverifiedOnce
          ) {
            capturedWebview.loadURL(
              buildInternalPageUrl('ens-unverified.html', { name: ens.name, uri: targetUri })
            );
            return;
          }
          pushDebug(`${systemLabel} resolved: ${ens.name} -> ${targetUri}`);
          loadTarget(targetUri, displayOverride || targetUri, capturedWebview, {
            nameResolutionDepth: resolutionDepth + 1,
            continuesNavigation: true,
          });
          return;
        }

        if (!isSupportedEnsTransport(result.protocol)) {
          failEnsResolution(
            `${systemLabel} content for ${ens.name} uses unsupported protocol ${result.protocol}`,
            `${systemLabel} content uses unsupported protocol "${result.protocol}". Supported: Swarm (bzz), IPFS, IPNS.`
          );
          return;
        }

        // Cross-transport assertion: a typed `bzz://name.eth/` must resolve
        // to a Swarm contenthash, not IPFS/IPNS. Same for ipfs:// and
        // ipns://. We surface this as an alert + abort rather than silently
        // switching transports — that mirrors the protocol-handler-side
        // behaviour (404 with explanatory body), so the user gets a clear
        // signal to retry with the correct scheme.
        if (assertedTransport && assertedTransport !== result.protocol) {
          failEnsResolution(
            `${systemLabel} transport mismatch for ${ens.name}: asserted ${assertedTransport}, got ${result.protocol}`,
            `${systemLabel} name ${ens.name} resolves to ${result.protocol}, not ${assertedTransport}. ` +
              `Try ${result.protocol}://${ens.name} instead.`
          );
          return;
        }

        const targetUri = applyEnsSuffix(result.uri, ens.suffix);

        // Unverified = soft block. Interstitial lets the user continue once,
        // bypassing this check for the follow-up load.
        if (
          result.trust?.level === 'unverified' &&
          state.blockUnverifiedEns &&
          !options.allowUnverifiedOnce
        ) {
          pushDebug(`${systemLabel} unverified for ${ens.name} → interstitial`);
          capturedWebview.loadURL(
            buildInternalPageUrl('ens-unverified.html', { name: ens.name, uri: targetUri })
          );
          return;
        }

        pushDebug(`${systemLabel} resolved: ${ens.name} -> ${targetUri}`);

        storeEnsResolutionMetadata(targetUri, ens.name);

        // Build transport-aware display (e.g. `bzz://name.eth/path`,
        // `ipfs://name.eth/path`) so the address bar reflects the actual
        // resolution transport. Falls back to the legacy `ens://` form for
        // unsupported protocols, but the `result.protocol` guard above
        // already rejects anything but bzz/ipfs/ipns.
        const transportDisplay =
          buildEnsDisplayUri(result.protocol, ens.name, ens.suffix) ||
          `ens://${ens.name}${ens.suffix || ''}`;

        // For ENS-backed dweb sites we want Chromium to load
        // `<scheme>://<name>/...` directly: the protocol handler resolves
        // the ENS host on every request (cache hit since we just populated
        // the cache via resolveEns), so DevTools, `window.location`,
        // storage origin, and subresource fetches all see the ENS name
        // rather than the resolved CID/hash. For Swarm the probe still
        // needs the actual hash to gate navigation on Bee warmth, so we
        // pass it separately as `swarmHash`.
        const innerOptions = {
          nameResolutionDepth: resolutionDepth + 1,
          continuesNavigation: true,
        };
        if (result.protocol === 'bzz') {
          innerOptions.bzzLoadUrl = transportDisplay;
          innerOptions.swarmHash = result.decoded;
        } else if (result.protocol === 'ipfs' || result.protocol === 'ipns') {
          innerOptions.ipfsLoadUrl = transportDisplay;
        }

        // Pass captured webview to ensure we load in the correct tab
        loadTarget(targetUri, displayOverride || transportDisplay, capturedWebview, innerOptions);
      })
      .catch((err) => {
        setLoading(false, capturedTabId);
        console.error('ENS resolution error', err);
        // Suppress the modal alert when the originating tab isn't in the
        // foreground (handled by `failEnsResolution`) — interrupting an
        // unrelated current page with a stale alert is more confusing
        // than informative. Console log + debug entry preserve the trail.
        failEnsResolution(
          `${systemLabel} resolution error for ${ens.name}: ${err.message}`,
          `${systemLabel} resolution error for ${ens.name}: ${err.message}`
        );
      });
    return;
  }

  // Try Radicle (rad:RID or rad://RID)
  if (
    value.trim().toLowerCase().startsWith('rad:') ||
    value.trim().toLowerCase().startsWith('rad://')
  ) {
    if (isRadicleDisabledForProfile()) {
      // Radicle is off for this profile: the node can never start, so the
      // generic connection-error panel ("enable Radicle in the Nodes menu")
      // would point at a control this profile doesn't have. Send the user to
      // the panel that explains the profile setting instead.
      pushDebug(RADICLE_DISABLED_MESSAGE);
      const disabledUrl = buildRadicleDisabledUrl(window.location.href, value.trim());
      setAddressDisplayForTab(value.trim(), targetTabId);
      navState.pendingNavigationUrl = disabledUrl;
      navState.hasNavigatedDuringCurrentLoad = false;
      webview.loadURL(disabledUrl);
      syncBzzBase(null);
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
      syncBzzBase(null);
      return;
    }
    // Invalid Radicle ID — show error page
    const withoutScheme = value
      .trim()
      .replace(/^rad:\/\//i, '')
      .replace(/^rad:/i, '');
    pushDebug(`Invalid Radicle ID: ${withoutScheme}`);
    const errorUrl = new URL('pages/rad-browser.html', window.location.href);
    errorUrl.searchParams.set('error', 'invalid-rid');
    errorUrl.searchParams.set('input', withoutScheme);
    setAddressDisplayForTab(value.trim(), targetTabId);
    navState.pendingNavigationUrl = errorUrl.toString();
    navState.hasNavigatedDuringCurrentLoad = false;
    webview.loadURL(errorUrl.toString());
    syncBzzBase(null);
    return;
  }

  // Shared prefix for the IPFS and bzz dweb branches: clear stale
  // hash→name mappings on direct navigation, set the address bar, and
  // populate navState.pending{Title,Navigation}Url. Each branch handles
  // its own loadURL/probe/syncBase calls afterward — they diverge there
  // (IPFS goes straight to the gateway; bzz gates on a probe).
  const commitDwebNavigationPrefix = ({ target, expectedNavUrl, hashKeys }) => {
    if (!isEnsBackedDisplay(displayOverride)) {
      for (const key of hashKeys) {
        if (key) state.knownEnsNames.delete(key);
      }
    }
    const displayValue = displayOverride || target.displayValue;
    setAddressDisplayForTab(displayValue, targetTabId);
    navState.pendingTitleForUrl = expectedNavUrl;
    navState.pendingNavigationUrl = expectedNavUrl;
    navState.hasNavigatedDuringCurrentLoad = false;
    return displayValue;
  };

  // Try IPFS (ipfs://, ipns://, or raw CID)
  const ipfsTarget = formatIpfsUrl(value, state.ipfsRoutePrefix);
  if (ipfsTarget) {
    // Node disabled or not running: surface the friendly "node not running"
    // page rather than letting webview.loadURL hit the ipfs: handler, which
    // returns a raw JSON 503 body Chromium renders verbatim. Reuses error.html
    // via the same ERR_CONNECTION_REFUSED path the Swarm probe uses, and the
    // Radicle disabled gate above. Unlike Swarm, `state.ipfsRoutePrefix` keeps
    // a native fallback even when disabled, so `formatIpfsUrl` still resolves —
    // hence the explicit availability check here.
    if (isIpfsNodeUnavailable()) {
      // Prefer the ENS-named load URL when the resolver supplied one, so the
      // error page's display + retry preserve the ENS host (ipfs://name.eth)
      // rather than the resolved CID — the ipfs: handler re-resolves the host
      // per request, so the named form is loadable. See buildErrorPageUrl's
      // note on ENS-backed retries.
      const ipfsErrorUrl = options.ipfsLoadUrl || ipfsTarget.displayValue;
      const protocol = ipfsErrorUrl.toLowerCase().startsWith('ipns://') ? 'ipns' : 'ipfs';
      pushDebug(`[AddressBar] IPFS node unavailable — error page for ${ipfsErrorUrl}`);
      // Route through the per-tab helper (not a raw `addressInput.value` write):
      // a background ENS/dweb navigation carries a specific `targetWebview`, so a
      // direct write would clobber the foreground tab's address bar and skip
      // storing the snapshot on the target tab. Mirror the normal IPFS path's
      // `displayOverride || ipfsTarget.displayValue` so an ENS-backed target keeps
      // its ENS host in the display.
      setAddressDisplayForTab(displayOverride || ipfsTarget.displayValue, targetTabId);
      const errorUrl = buildErrorPageUrl('ERR_CONNECTION_REFUSED', ipfsErrorUrl, {
        protocol,
        retry: ipfsErrorUrl,
      });
      navState.pendingNavigationUrl = errorUrl;
      navState.hasNavigatedDuringCurrentLoad = false;
      webview.loadURL(errorUrl);
      syncBzzBase(null);
      return;
    }
    const cidMatch = ipfsTarget.displayValue.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
    const ipnsMatch = ipfsTarget.displayValue.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
    // Load via the native `ipfs:`/`ipns:` schemes so the main-process
    // protocol handler dispatches sub-resource fetches (CSS, JS, images,
    // service workers) and the page's URL/origin stays
    // `ipfs://<cid|name>/` rather than the Kubo gateway origin. ENS-host
    // targets carry an explicit `ipfsLoadUrl` from the resolver so
    // Chromium loads `ipfs://<name>/...` even though we resolved to a CID.
    // See README "IPFS / IPNS Content Retrieval".
    const ipfsLoadUrl = options.ipfsLoadUrl || ipfsTarget.displayValue;
    const ipfsDisplayValue = commitDwebNavigationPrefix({
      target: ipfsTarget,
      expectedNavUrl: ipfsLoadUrl,
      hashKeys: [cidMatch?.[1], ipnsMatch?.[1]],
    });
    pushDebug(`[AddressBar] Loading IPFS target, set to: ${ipfsDisplayValue}`);
    webview.loadURL(ipfsLoadUrl);
    pushDebug(`Loading ${ipfsTarget.displayValue} via ${ipfsLoadUrl}`);
    syncBzzBase(null);
    return;
  }

  // Swarm node disabled or not running: `state.bzzRoutePrefix` is null, so
  // `formatBzzUrl` below returns null and the navigation would otherwise fall
  // through to "Ignoring empty input or invalid URL" — a silent failure. Detect
  // the Swarm intent from the raw input and show the same friendly "node not
  // running" page the probe produces for an unreachable node (see
  // startBzzNavigationWithProbe / error.html). Mirrors the Radicle disabled gate
  // above.
  if (!state.bzzRoutePrefix && looksLikeBzzInput(value)) {
    const trimmed = value.trim();
    const bzzForm = /^bzz:/i.test(trimmed) ? trimmed : `bzz://${trimmed}`;
    // Preserve the ENS host on the retry URL when the resolver supplied one
    // (`bzz://name.eth`), mirroring the probe path (startBzzNavigationWithProbe):
    // the bzz: handler re-resolves the host per request, so "Try Again" keeps the
    // ENS name and origin rather than the resolved hash. Non-ENS input keeps the
    // bare bzz form.
    const retry = options.bzzLoadUrl || bzzForm;
    const displayValue = displayOverride || bzzForm;
    pushDebug(`[AddressBar] Swarm node unavailable — error page for ${displayValue}`);
    // Per-tab helper (not a raw `addressInput.value` write) so a background
    // ENS/dweb navigation with an explicit `targetWebview` updates the target
    // tab's snapshot instead of clobbering the foreground address bar.
    setAddressDisplayForTab(displayValue, targetTabId);
    const errorUrl = buildErrorPageUrl('ERR_CONNECTION_REFUSED', displayValue, {
      protocol: 'swarm',
      retry,
    });
    navState.pendingNavigationUrl = errorUrl;
    navState.hasNavigatedDuringCurrentLoad = false;
    webview.loadURL(errorUrl);
    syncBzzBase(null);
    return;
  }

  // Try Swarm/bzz
  const target = formatBzzUrl(value, state.bzzRoutePrefix);
  if (target) {
    const hashMatch = target.displayValue.match(/^bzz:\/\/([a-fA-F0-9]+)/);
    // For ENS-host transport URLs we point pendingNavigationUrl at the
    // ENS-named load URL so the `did-navigate` reconciliation in
    // webcontents-setup matches: Chromium will report `bzz://<name>/`
    // after navigation, not the gateway URL.
    const displayValue = commitDwebNavigationPrefix({
      target,
      expectedNavUrl: options.bzzLoadUrl || target.targetUrl,
      hashKeys: [hashMatch?.[1]?.toLowerCase()],
    });
    pushDebug(`[AddressBar] Loading target, set to: ${displayValue}`);
    syncBzzBase(target.baseUrl || null);

    // Augment with optional ENS-transport overrides. `swarmHash` lets the
    // probe target the resolved Swarm reference; `bzzLoadUrl` is what
    // Chromium actually loads, so the page's URL/origin stays ENS-named.
    const augmented =
      options.bzzLoadUrl || options.swarmHash
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
    return;
  }

  // Fall back to web search: every protocol matcher above (view-source,
  // freedom://, ENS, rad, ipfs/ipns, bzz/hash/domain, http) has rejected the
  // input, so treat it as a query for the user's search provider. The
  // recursive call routes the built https URL through the HTTP branch.
  const searchUrl = buildSearchUrl(value, state.searchProvider, state.customSearchProviders);
  if (searchUrl) {
    pushDebug(`[AddressBar] Searching for input via ${searchUrl}`);
    loadTarget(searchUrl, null, webview, { continuesNavigation: true });
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
    // Stopping a load repaints the address bar with the page it settled on —
    // unless the user is mid-edit, in which case only the snapshot moves
    // (#305). The Escape handler clears the edit before calling this, so the
    // Escape path still repaints.
    commitAddressDisplay(display, navState);
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
  // Going home is a commit: any uncommitted edit is over.
  clearAddressBarEdit(navState);
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

// Hard-reload (Cmd/Ctrl+Shift+R) bypasses Chromium's HTTP cache; the ENS
// analogue is to also bypass the main-process `ensResultCache` (15-min TTL)
// so a hard reload performed shortly after the previous resolution actually
// re-resolves rather than returning the cached result. Fire-and-forget IPC —
// the subsequent `loadTarget` call kicks off a fresh `resolveEns` that misses
// the now-empty cache.
// Shared error-page retry logic used by both reload variants and the reload button
const retryErrorPageOrReload = (webview, hard) => {
  const current = webview.getURL();
  const originalUrl = getOriginalUrlFromErrorPage(current);
  if (originalUrl) {
    // Hard reload of an ENS error page also bypasses `ensResultCache` so the
    // recovery resolution actually re-runs under today's verification method
    // rather than returning the cached contenthash from the failed attempt.
    if (hard) {
      const errorEns = parseEnsInput(originalUrl);
      if (errorEns) invalidateContentName(errorEns);
    }
    pushDebug(`Retrying original URL from error page: ${originalUrl}`);
    // Reload is not a commit of the address bar: an uncommitted edit survives
    // it, exactly as it does on the `webview.reload()` path at the tail.
    loadTarget(originalUrl, null, null, { keepsAddressBarEdit: true });
    return;
  }
  if (isErrorPageUrl(current)) {
    try {
      new URL(current);
    } catch (err) {
      pushDebug(`[Nav] Could not extract original URL from error page: ${err.message}`);
    }
  }

  // ENS pages: reload re-resolves under the currently-configured verification
  // method so the trust badge reflects today's settings, not whatever was in
  // effect at first load. The webview's URL holds the resolved transport URL
  // with the resolved hash/CID (or the ENS-host form like
  // `bzz://name.eth/...`); re-running `webview.reload()` would just refetch
  // the same content hash and never re-enter the ENS resolution path.
  //
  // We key the decision on the active tab's `committedDisplayUrl`, which is
  // written *only* by did-navigate handlers and so represents the last
  // user-facing display URL that actually committed. We deliberately do NOT
  // use `addressInput.value` (reflects in-progress user typing) or
  // `navState.addressBarSnapshot` (gets overwritten by `focusin` and
  // `tab-switched` and so can carry an unsubmitted draft — e.g. typing
  // `vitalik.eth` over an `https://example.com` page, switching tabs, and
  // switching back). Submitting the typed value is the form `submit`
  // handler's job; reload is the "do whatever you do, again" affordance.
  const navState = getNavState();
  const committedDisplay = (navState.committedDisplayUrl || '').trim();
  const ensInput = committedDisplay ? parseEnsInput(committedDisplay) : null;
  if (ensInput) {
    if (hard) invalidateContentName(ensInput);
    pushDebug(
      `${hard ? 'Hard reload' : 'Reload'} re-resolving ${nameSystemLabelForName(ensInput.name)}: ${committedDisplay}`
    );
    loadTarget(committedDisplay, null, null, { keepsAddressBarEdit: true });
    return;
  }

  // A committed dweb URL (`ipfs://<cid>`, `ipns://<name>`, `bzz://<hash>`) whose
  // node has since been disabled/stopped must reload through `loadTarget` so the
  // navigation-layer gate routes it to the friendly error page. A raw
  // `webview.reload()` would re-hit the `ipfs:`/`bzz:` protocol handler and
  // render its 503 JSON body verbatim. When the node is still available we keep
  // the plain reload — no re-probe, preserving the happy-path behaviour.
  const dwebScheme = committedDisplay.match(/^(ipfs|ipns|bzz):\/\//i)?.[1]?.toLowerCase();
  if (dwebScheme) {
    const nodeUnavailable = dwebScheme === 'bzz' ? !state.bzzRoutePrefix : isIpfsNodeUnavailable();
    if (nodeUnavailable) {
      pushDebug(
        `${hard ? 'Hard reload' : 'Reload'} dweb node unavailable — routing ${committedDisplay} to error page`
      );
      loadTarget(committedDisplay, null, null, { keepsAddressBarEdit: true });
      return;
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

    // Update view-source state (important for back/forward navigation).
    // The canonical per-tab record lives on tabs.js' tab.isViewingSource
    // (set from did-navigate); the module-level `isViewingSource` is a
    // render-loop cache for the active tab.
    if (urlIsViewSource !== isViewingSource) {
      isViewingSource = urlIsViewSource;
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
      // Fail safe if a view-source commit on the onchain trust gate lands
      // anyway (session restore, a back/forward entry predating the refusal
      // in `loadTarget`): a blank address bar and title, never the gate's own
      // file:// URL with its single-use approval token. Same fail-safe the
      // tab-switch surface applies. See issue #235.
      const displayUrl = isOnchainInterstitialPageUrl(event.url)
        ? ''
        : `view-source:${displayInner || event.url}`;
      commitAddressDisplay(displayUrl, navState);
      pushDebug(`[AddressBar] View source: ${displayUrl || '(withheld)'}`);
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

    // A web3: protocol response can redirect to Freedom's browser-owned
    // trust interstitial. Keep the requested app identity in chrome instead
    // of exposing the implementation's file:// URL.
    const onchainInterstitialTarget = getOnchainInterstitialTarget(event.url);
    if (onchainInterstitialTarget) {
      const displayUrl = formatOnchainAppDisplayUrl(onchainInterstitialTarget);
      if (displayUrl) commitAddressDisplay(displayUrl, navState);
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

    // Check for internal pages first. New-tab pages (`home`, and the private
    // window's start page) are excluded: they fall through to the generic
    // derivation below, which resolves them to an empty address bar — Chrome
    // shows an empty omnibox on both its NTP and its Incognito NTP. See #312.
    const internalPageName = getInternalPageName(event.url);
    if (internalPageName && !isNewTabPageUrl(event.url)) {
      commitAddressDisplay(`freedom://${internalPageName}`, navState);
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
      // Re-evaluate the protocol icon and trust shield against the new
      // freedom:// URL — without this, navigating to Settings (etc.)
      // from an ENS page leaves the prior page's trust shield stuck on.
      updateProtocolIcon();
      return;
    }

    // Check for rad-browser.html URLs (Radicle protocol)
    const radicleDisplayUrl = getRadicleDisplayUrl(event.url);
    if (radicleDisplayUrl) {
      commitAddressDisplay(radicleDisplayUrl, navState);
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

    // Name-resolution interstitials (unverified soft block, head/contenthash
    // conflict hard block) get the same treatment as the error page: the
    // address bar keeps the name the user asked for, never the interstitial's
    // own `file:///…/pages/ens-*.html` path (#235). The name is empty only if
    // the page was opened without its `name` param — an empty address bar is
    // the fail-safe there, since the on-disk path must not be shown either.
    if (isInterstitialPageUrl(event.url)) {
      const blockedName = getInterstitialDisplayName(event.url) || '';
      commitAddressDisplay(blockedName, navState);
      pushDebug(`[AddressBar] Interstitial -> Blocked name: ${blockedName || '(none)'}`);
    } else if (isErrorPageUrl(event.url)) {
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
          commitAddressDisplay(display, navState);
          pushDebug(`[AddressBar] Error Page -> Original: ${display}`);
        } else {
          commitAddressDisplay('Error', navState);
        }
      } catch (err) {
        pushDebug(`[Nav] Could not parse error page URL: ${err.message}`);
        commitAddressDisplay('Error', navState);
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
      } else if (commitAddressDisplay(derived, navState)) {
        pushDebug(`[AddressBar] Updated to: ${derived} (derived from ${event.url})`);
      }

      // Sync the only protocol still using the HTTP request rewriter (bzz).
      // `ipfs:`/`ipns:` are standard schemes with main-process protocol
      // handlers, so the renderer doesn't track an IPFS base anymore.
      const bzzBase = deriveBzzBaseFromUrl(event.url);
      syncBzzBase(bzzBase);
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

  // Snapshot the live address bar so the `tab-switched` handler and any
  // focusin-style draft restoration can paint the foreground value back
  // when the user comes back to this tab. The dedicated commit-only
  // `committedDisplayUrl` (used by reload and provider permission keying)
  // is written by tabs.js' per-webview did-navigate handler — that's the
  // single source of truth for "what page are we actually on", and it
  // covers background tabs too.
  //
  // The branches above already snapshotted the page's own display value
  // through `commitAddressDisplay`; this tail covers the events that carry
  // no URL. While the user is mid-edit the live input holds their draft, so
  // it must not be written over the page snapshot (#305) — the draft has its
  // own per-tab home in `addressBarPendingInput`.
  if (!isAddressBarEditInProgress(navState)) {
    navState.addressBarSnapshot = addressInput.value;
  }
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
export const onSettingsChanged = (settings = null) => {
  const navState = getNavState();
  // Both refreshes below re-run the page the tab is *on*, so they key on
  // `committedDisplayUrl` — written only by did-navigate — rather than the
  // live input, which under the uncommitted-edit model can hold a half-typed
  // draft the user never submitted (#305). Navigating to that draft (and
  // ending the edit) because a settings broadcast happened to arrive is the
  // clobber this PR exists to remove; they pass `keepsAddressBarEdit` for the
  // same reason reload does.
  const committedDisplay = (navState.committedDisplayUrl || '').trim();
  if (settings?.networkConfigUpdated === true) {
    if (parseEnsInput(committedDisplay)) {
      loadTarget(committedDisplay, null, null, { keepsAddressBarEdit: true });
      return;
    }
  }

  updateProtocolIcon();
  if (navState.currentPageUrl && navState.currentPageUrl.startsWith('bzz://')) {
    loadTarget(committedDisplay || navState.currentPageUrl, null, null, {
      keepsAddressBarEdit: true,
    });
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

  setOnchainProvenanceChangeHandler((tabId) => {
    if (isActiveTab(tabId)) updateProtocolIcon();
  });

  if (trustShield) {
    // Don't stopPropagation: we want the click to bubble to the
    // document-click handlers in menus.js so any open nodes / hamburger
    // menu closes in the same gesture. The popover-closer below is
    // shield-aware (trustShield.contains(e.target)) so it won't dismiss
    // the popover we're about to open.
    trustShield.addEventListener('click', () => {
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
      // A modal <dialog> is above this popover in the top layer, so the press
      // is the dialog's — and consuming it here would cancel the dialog's own
      // close request. See `isModalDialogOpen`.
      if (isModalDialogOpen()) return;
      // Consumed: the window-level Escape below must not also stop the load.
      e.preventDefault();
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
    ipfsProgressStatusEnabled = settings?.showIpfsProgressStatus === true;
  });

  // Keep the IPFS-progress opt-in live. When it's switched off mid-load, stop
  // any running poller so the link bar reverts to hover URLs immediately.
  window.addEventListener('settings:updated', (event) => {
    const next = event.detail?.showIpfsProgressStatus === true;
    if (next === ipfsProgressStatusEnabled) return;
    ipfsProgressStatusEnabled = next;
    if (!next) stopIpfsProgressStatus({ immediate: true });
  });

  // Address bar events
  addressInput.addEventListener('focus', () => {
    addressInput.select();
  });

  addressInput.addEventListener('focusin', () => {
    const navState = getNavState();
    // Focusing a bar that already carries an uncommitted draft (restored on
    // tab switch) must not promote that draft to the page snapshot — the
    // snapshot is what Escape reverts to. See #305/#314.
    if (!isAddressBarEditInProgress(navState)) {
      navState.addressBarSnapshot = addressInput.value;
    }
  });

  // Update protocol icon as user types, and record the edit as
  // "user input in progress" for this tab (Chrome's omnibox model): page
  // commits stop overwriting it (#305) and a tab switch carries it along
  // (#314). Only real user input fires `input` — programmatic writes from
  // the navigation layer don't, which is what keeps derived values out.
  addressInput.addEventListener('input', () => {
    setAddressBarEdit(addressInput.value, captureInputSelection(addressInput));
    updateProtocolIcon();
  });

  addressInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // While a suggestion is previewed in the dropdown, autocomplete.js owns
    // this press: it returns to the typed text and closes the list. This
    // handler takes over from the next press. #310.
    if (isSuggestionPreviewActive()) return;
    event.preventDefault();
    const navState = getNavState();
    // Chrome's Escape sequence in the omnibox: revert an uncommitted edit to
    // the page's URL while *keeping* focus (text selected), and only move
    // focus to the page once there is nothing left to revert. The bar never
    // comes to rest showing text that is neither the page URL nor a live
    // edit. See #310.
    const hadUserEdit = isAddressBarEditInProgress(navState);
    clearAddressBarEdit(navState);
    let pageDisplay = null;
    const stoppedLoad = stopLoadingAndRestore();
    if (!stoppedLoad && navState.addressBarSnapshot) {
      pageDisplay = navState.addressBarSnapshot;
    } else if (navState.pendingTitleForUrl) {
      pageDisplay = deriveDisplayValue(
        navState.pendingTitleForUrl,
        state.bzzRoutePrefix,
        homeUrlNormalized,
        state.ipfsRoutePrefix,
        state.ipnsRoutePrefix,
        state.radicleApiPrefix
      );
    } else if (!stoppedLoad && typeof navState.addressBarSnapshot === 'string') {
      // A page whose display *is* empty — the new-tab/home page — still has a
      // permanent text to revert to: the empty string. Gating on truthiness
      // instead left the typed fragment sitting in the bar with no edit
      // tracking it any more, i.e. exactly the "neither the page URL nor a
      // live edit" resting state #310 exists to remove.
      pageDisplay = '';
    }
    const reverted = pageDisplay !== null && addressInput.value !== pageDisplay;
    if (pageDisplay !== null) {
      addressInput.value = pageDisplay;
    }
    updateProtocolIcon();
    if (hadUserEdit || reverted) {
      addressInput.select();
    } else {
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
        if (shouldShowIpfsProgress({ data, tab: getActiveTab(), navState })) {
          startIpfsProgressStatus();
        } else {
          stopIpfsProgressStatus({ immediate: true });
        }
        navState.isWebviewLoading = true;
        reloadBtn.dataset.state = 'stop';
        pushDebug('Webview started loading.');
        break;

      case 'did-stop-loading':
        setLoading(false);
        stopIpfsProgressStatus({ immediate: true });
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
          // PRIVATE MODE GUARD (favicons): private windows never fetch-and-
          // cache favicons — shouldCacheFavicons() gates the whole block,
          // including the cached-icon read at the end of it. So a private
          // tab shows the default globe after load even when the icon is
          // already cached, and only picks it up on tab switch (which has
          // its own ungated updateTabFavicon call). That is deliberate: the
          // read is harmless, but keeping the guard as one all-or-nothing
          // block is what makes it auditable. Failing toward privacy.
          if (
            activeTab &&
            displayUrl &&
            shouldCacheFavicons() &&
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
          // PRIVATE MODE GUARD (history): navigations in private windows
          // are never recorded (main-process twin: src/main/history.js).
          if (
            shouldRecordHistory() &&
            isHistoryRecordable(displayUrl, internalUrl) &&
            displayUrl !== lastRecordedUrl
          ) {
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
                // PRIVATE MODE GUARD (autocomplete): the suggestion cache
                // only learns from non-private navigation. Unreachable in
                // private windows (no history write) — kept explicit so the
                // learning path is guarded even if the write path changes.
                if (shouldLearnAutocomplete()) {
                  onHistoryRecorded?.();
                }
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
        // Defensive twin of the per-tab gate in `tabs.js`. Chromium fires
        // `did-fail-load` for **any** frame, including third-party iframes
        // and ad-tech pixels. Replacing the main page with `error.html`
        // for a sub-frame failure is wrong (it hijacks the user's
        // top-level navigation on top of a perfectly-loaded main page);
        // tabs.js already filters these out, but keeping the check here
        // too means a future caller of this handler can't reintroduce the
        // bug by accident.
        if (data.event?.isMainFrame === false) {
          pushDebug(
            `Sub-frame did-fail-load ignored: ${data.event?.errorDescription || data.event?.errorCode} (${data.event?.validatedURL || 'unknown url'})`
          );
          break;
        }
        if (webview) webview.classList.remove('hidden');
        setLoading(false);
        stopIpfsProgressStatus({ immediate: true });
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
            // `ens://` is the legacy Ethereum-name form; parseEnsInput
            // deliberately rejects `ens://<name>.tez`, so Tezos names have to
            // go back through loadTarget bare or the continue is a no-op.
            const target = isTezosDomainHost(name) ? name : 'ens://' + name;
            loadTarget(target, null, webview, { allowUnverifiedOnce: true });
          }
        } else if (data.channel === 'ens:open-settings') {
          loadTarget('freedom://settings', null, webview);
        } else if (data.channel === 'onchain:continue-unverified') {
          const payload = data.args?.[0] || {};
          const target = formatOnchainAppUrl(payload.target);
          const token = typeof payload.token === 'string' ? payload.token : '';
          if (target && /^[A-Za-z0-9_-]{43}$/.test(token)) {
            const displayUrl = formatOnchainAppDisplayUrl(target);
            if (displayUrl) setAddressDisplayForTab(displayUrl, data.tabId);
            webview.loadURL(target, {
              extraHeaders: `X-Freedom-Onchain-App-Approval: ${token}`,
            });
          }
        } else if (data.channel === 'onchain:retry') {
          const target = formatOnchainAppUrl(data.args?.[0]?.target);
          if (target) loadTarget(target, null, webview);
        } else if (data.channel === 'onchain:open-rpc-settings') {
          loadTarget('freedom://settings/rpc', null, webview);
        } else if (data.channel === 'link:navigate') {
          const payload = data.args?.[0] || {};
          const url = payload.url;
          if (url) {
            // Dispositions mirror Chrome's link heuristic, resolved in
            // webview-preload from the activation's modifiers: `newTab`
            // (foreground — plain `target="_blank"`, Ctrl+Shift+click,
            // Shift+middle-click), `newBackgroundTab` (Ctrl/Cmd+click,
            // middle-click), `newWindow` (Shift+click). Anything else is a
            // same-tab navigation. See #303.
            const disposition = ['newTab', 'newBackgroundTab', 'newWindow'].includes(
              payload.disposition
            )
              ? payload.disposition
              : 'currentTab';
            const rawTarget = typeof payload.target === 'string' ? payload.target : '';
            // Mirrors webcontents-setup.js: only names without a
            // leading underscore are tracked as named targets. `_blank`,
            // `_self`, `_parent`, `_top` go through the disposition
            // path unchanged.
            const namedTarget = rawTarget && !rawTarget.startsWith('_') ? rawTarget : null;
            pushDebug(
              `Preload intercepted dweb link navigation: ${url} (${disposition}` +
                (namedTarget ? `, target=${namedTarget}` : '') +
                ')'
            );
            if (disposition === 'newWindow') {
              // Shift+click. Same main-process route (and same private-window
              // guard on the sender) the page context menu's "Open Link in
              // New Window" already uses.
              electronAPI?.openUrlInNewWindow?.(url);
            } else if (disposition === 'newTab' || disposition === 'newBackgroundTab') {
              // Mirrors the Chromium → setWindowOpenHandler →
              // tab:new-with-url path, but with the raw mixed-case href
              // intact. openInNewTabWithTarget routes through createTab
              // (and from there loadTarget → formatIpfsUrl), so
              // CIDv0/base58 IPNS hosts get canonicalised exactly the
              // same way as a same-tab navigation, AND named targets
              // reuse their existing tab instead of always opening a
              // new one.
              openInNewTabWithTarget(url, namedTarget, {
                background: disposition === 'newBackgroundTab',
              });
            } else {
              // Same-tab link click: a page-driven commit, so it must not
              // discard an address-bar edit the user has in flight (#305).
              loadTarget(url, null, webview, { pageInitiated: true });
            }
          }
        }
        break;
      }

      case 'tab-switched':
        // Save address bar state to previous tab before switching. The
        // per-tab view-source record (`prev.isViewingSource`) is owned by
        // tabs.js' did-navigate handler and is already up to date — we
        // only persist the address bar snapshot.
        if (previousActiveTabId && previousActiveTabId !== data.tabId) {
          const prevTab = getTabs().find((t) => t.id === previousActiveTabId);
          if (prevTab && prevTab.navigationState) {
            // An uncommitted edit belongs to the tab being left: refresh the
            // draft (and its selection) rather than the page snapshot, so
            // switching back restores what the user was typing. #314.
            if (isAddressBarEditInProgress(prevTab.navigationState)) {
              setAddressBarEdit(
                addressInput.value,
                captureInputSelection(addressInput),
                prevTab.navigationState
              );
            } else if (!data.fromAddressBarCommit) {
              // A switch commanded by the address bar itself (a picked
              // "switch to tab" suggestion) leaves the *target* tab's URL —
              // or the leftover query — in the input, with the edit already
              // cleared by the commit. Adopting that as the leaving tab's
              // page display would make it the value Escape reverts to and
              // the one `deriveSwitchedTabDisplay` paints while that tab
              // loads, i.e. another tab's URL shown as this one's.
              prevTab.navigationState.addressBarSnapshot = addressInput.value;
            }
          }
        }
        previousActiveTabId = data.tabId;

        // Update UI state when switching tabs - restore from tab's navigation state
        if (data.tab) {
          const tabNavState = data.tab.navigationState || {};
          const isLoading = data.tab.isLoading || false;
          const url = data.tab.url || tabNavState.currentPageUrl || '';

          // Restore view-source state for this tab. tabs.js owns
          // `tab.isViewingSource` and updates it from did-navigate; fall
          // back to URL inspection for tabs that haven't navigated yet
          // (e.g. brand-new view-source tabs whose first dispatch is
          // still in flight).
          isViewingSource = data.tab.isViewingSource || url.startsWith('view-source:');

          // If tab is loading, prefer addressBarSnapshot (what user typed/was shown)
          // Otherwise derive from the actual URL
          const display = deriveSwitchedTabDisplay({
            url,
            isLoading,
            addressBarSnapshot: tabNavState.addressBarSnapshot,
            addressBarPendingInput: tabNavState.addressBarPendingInput,
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
          // A tab left mid-edit comes back mid-edit: put the caret/selection
          // back where it was and return focus to the bar, the way Chrome
          // restores per-tab omnibox state. #314.
          if (isAddressBarEditInProgress(tabNavState)) {
            addressInput.focus();
            applyInputSelection(addressInput, tabNavState.addressBarPendingSelection);
          }
          // Update bookmarks bar visibility based on current page
          updateBookmarkBarState(url);
          // Sync bases for the switched-to tab. `ipfs:`/`ipns:` use a
          // standard-scheme protocol handler in the main process, so the
          // renderer doesn't track an IPFS base anymore.
          if (tabNavState.currentBzzBase) {
            syncBzzBase(tabNavState.currentBzzBase);
          }
          // Sync navigationState.currentPageUrl if tab.url is more recent
          if (data.tab.url && data.tab.url !== tabNavState.currentPageUrl) {
            tabNavState.currentPageUrl = data.tab.url;
          }
          // Sync loading state - use tab.isLoading as source of truth
          setLoading(isLoading);
          if (isLoading && shouldShowIpfsProgress({ data, tab: data.tab, navState: tabNavState })) {
            startIpfsProgressStatus();
          } else {
            stopIpfsProgressStatus({ immediate: true });
          }
          tabNavState.isWebviewLoading = isLoading;
          reloadBtn.dataset.state = isLoading ? 'stop' : 'reload';
          // Where focus lands on a NEW tab, and on a switch back to a tab that
          // is sitting on the new-tab page. tabs.js focuses the page itself for
          // every other kind of activation (#304) but defers these two here,
          // because only the address-bar derivation knows whether the tab
          // landed on this window's new-tab page.
          //
          // - New-tab page (the home page in a normal window, the private start
          //   page in a private window — `isNewTabPageUrl`; before #312 the
          //   private form failed this test, so a private new tab left focus on
          //   <body> with nowhere to type): focus the address bar, as Chrome
          //   does on both its NTP and its Incognito NTP.
          // - Anything else (a link opened in a new foreground tab,
          //   view-source, …): focus the page, so focus is never stranded on
          //   the outgoing tab's now-hidden webview.
          //
          // Switching *back* to a tab already on the new-tab page takes the
          // same rule: `home.html`/`private.html` have no focus target, so
          // handing that guest the keyboard drops whatever the user types
          // next. A tab carrying an uncommitted draft is excluded — the #314
          // branch above already focused the bar *and* restored its selection,
          // and re-focusing would only drop the selection. The condition is
          // the exact complement of tabs.js' `switchTab` guard; keep the two
          // in step or a switch ends up with the keyboard nowhere.
          const isEmptyNewTab =
            !isViewingSource && !addressInput.value && (isNewTabPageUrl(url) || !url);
          const ownsFocusForThisSwitch =
            data.isNewTab || (!isAddressBarEditInProgress(tabNavState) && isNewTabPageUrl(url));
          if (ownsFocusForThisSwitch) {
            if (isEmptyNewTab) {
              addressInput.focus();
              // Match the explicit focus-address-bar shortcut (tabs.js), which
              // focuses *and* selects; a no-op while the value is empty, but
              // the two paths should not differ.
              addressInput.select();
            } else {
              data.tab.webview?.focus?.();
            }
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
        // Notify other modules that the active tab changed (permission
        // prompt dismissal + address-bar permission indicator refresh).
        document.dispatchEvent(new CustomEvent('active-tab-changed'));
        break;
    }
  });

  // IPC handler for toggle bookmark bar
  electronAPI?.onToggleBookmarkBar?.(() => {
    toggleBookmarkBar();
  });

  // Keyboard shortcuts — resolved through the shared shortcut registry so
  // user remaps apply live. (Escape stays hardcoded: it's contextual
  // stop-loading behavior, not a remappable shortcut.)
  window.addEventListener('keydown', (event) => {
    // Hard reload (check first, before soft reload)
    if (matchesShortcut(event, 'page.hardReload')) {
      event.preventDefault();
      hardReloadPage();
    }
    // Reload (soft, uses cache)
    else if (matchesShortcut(event, 'page.reload')) {
      event.preventDefault();
      reloadPage();
    } else if (event.key === 'Escape') {
      // Stop-loading is Escape's *last* meaning, the way it is in Chrome: one
      // press closes only the innermost open surface. Every dismissible
      // surface in the chrome (the hamburger and Nodes menus, the tab and page
      // context menus, the bookmark menus, the trust popover, a permission
      // prompt, the chrome-input context menu) calls `preventDefault()` when
      // it consumes the press, and this handler stands down for it — otherwise
      // closing a menu over a still-loading page would also cancel that load,
      // repaint the address bar and blur the focus the menu just handed back.
      // Those handlers all sit on `document` or, for menus.js, earlier on
      // `window`, so their mark is already set by the time this runs;
      // `stopPropagation()` on a same-node listener could not have done it.
      if (event.defaultPrevented) return;
      // A modal <dialog> owns the press the same way, but marks nothing — see
      // `isModalDialogOpen`. Standing down here is what leaves its own
      // Escape-to-cancel intact; a `preventDefault()` below would kill it.
      if (isModalDialogOpen()) return;
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
