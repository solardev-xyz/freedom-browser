/**
 * Sidebar Module
 *
 * Manages the right-side identity & wallet sidebar.
 * Fixed width (320px), toggle open/closed.
 */

import { isSignatureInFlight, onSignatureFlightChange } from './wallet/signature-flight.js';
import { matchesShortcut } from './shortcuts.js';

// Shown on the disabled chrome so the user knows why it will not respond.
const IN_FLIGHT_TITLE = 'Finish the confirmation on your device first';

// State
let isOpen = false;
let featureEnabled = false;
// Browser full screen hides an open sidebar without closing it (#78): a close
// fires 'sidebar-closed', whose cascade tears down any screen the panel holds.
let concealed = false;
// Whether the window is in browser full screen, and whether the panel is in
// view only because a request (an approval, a consent prompt) opened it there.
// Such a panel steps aside again once the request is over, i.e. once the
// panel is back on its home view (see watchHomeView).
let fullscreen = false;
let revealedForRequest = false;
// Whether a screen opened through open()/openForConsent() is up in the panel
// and the panel has not yet gone back to its home view: set by every such
// caller, cleared once the home view returns. That covers requests (an
// approval, a consent prompt, a vault unlock) and also screens the user
// opened, such as Send from an ethereum: link or the Publish setup flow.
// Entering full screen leaves such a panel in view, so a request is not left
// hanging out of sight, and a user-opened screen likewise stays until the
// panel is back on its home view (see conceal()).
let requestOpened = false;

// DOM references
let sidebar;
let toggleBtn;
let closeBtn;
let homeView;

/**
 * Initialize the sidebar module
 */
export function initSidebar() {
  sidebar = document.getElementById('sidebar');
  toggleBtn = document.getElementById('wallet-toggle-btn');
  closeBtn = document.getElementById('sidebar-close');

  if (!sidebar || !toggleBtn) {
    console.error('[Sidebar] Required elements not found');
    return;
  }

  // Load initial feature flag state
  window.electronAPI
    .getSettings()
    .then((settings) => {
      featureEnabled = settings?.enableIdentityWallet === true;
      applyFeatureVisibility();
    })
    .catch(() => {
      featureEnabled = false;
      applyFeatureVisibility();
    });

  // React to settings changes
  window.addEventListener('settings:updated', (event) => {
    const wasEnabled = featureEnabled;
    featureEnabled = event.detail?.enableIdentityWallet === true;
    applyFeatureVisibility();
    // Close sidebar if feature was just disabled while open
    if (wasEnabled && !featureEnabled && isOpen) {
      close();
    }
  });

  // Apply initial state (sidebar starts closed)
  applyState();

  watchHomeView(document.getElementById('sidebar-identity'));

  // Keep the close/toggle chrome in step with the shared signature lock, so
  // it is visibly dead while a device confirmation owns the panel rather
  // than looking clickable and silently refusing.
  onSignatureFlightChange(applyFlightLock);

  // Setup event listeners
  toggleBtn.addEventListener('click', toggle);

  if (closeBtn) {
    closeBtn.addEventListener('click', close);
  }

  // Keyboard shortcut (default Cmd/Ctrl+Shift+W, remappable)
  document.addEventListener('keydown', (e) => {
    if (matchesShortcut(e, 'view.toggleSidebar')) {
      if (!featureEnabled) return;
      e.preventDefault();
      toggle();
    }
  });

  console.log('[Sidebar] Initialized');
}

/**
 * Show/hide the toolbar toggle button based on feature flag
 */
function applyFeatureVisibility() {
  if (!toggleBtn) return;
  toggleBtn.classList.toggle('hidden', !featureEnabled);
}

/**
 * Toggle sidebar open/closed
 */
export function toggle() {
  if (!featureEnabled) return;
  // Collapsing is a close: it hides a live device confirmation just as the
  // X does. Opening is always allowed (it is how the user gets back to a
  // confirmation the panel is holding).
  // A sidebar hidden by full screen is still open; the toggle brings it back
  // into view rather than closing what the user cannot see.
  revealedForRequest = false;
  if (isOpen && concealed) {
    reveal();
    return;
  }
  if (isOpen && refuseSidebarClose()) return;
  const wasOpen = isOpen;
  isOpen = !isOpen;
  applyState();
  // Dispatch events so other modules can react
  if (wasOpen && !isOpen) {
    document.dispatchEvent(new CustomEvent('sidebar-closed'));
  } else if (!wasOpen && isOpen) {
    document.dispatchEvent(new CustomEvent('sidebar-opened'));
  }
}

/**
 * Open the sidebar
 */
export function open() {
  if (!featureEnabled) return;
  requestOpened = true;
  revealForRequest();
  if (!isOpen) {
    isOpen = true;
    applyState();
    document.dispatchEvent(new CustomEvent('sidebar-opened'));
  }
}

/**
 * Refuse a close while a signature is in flight.
 *
 * The panel is the surface the approval screen owns: a hardware signature
 * is a device prompt the renderer cannot recall, so collapsing the sidebar
 * over it strands the user with an un-recallable prompt and no UI — and the
 * 'sidebar-closed' event it fires runs the coordinator's closeAllSubscreens()
 * cascade, which tears the confirmation's neighbours down and un-hides the
 * identity view underneath it. See wallet/signature-flight.js.
 */
function refuseSidebarClose() {
  if (!isSignatureInFlight()) return false;
  console.warn('[Sidebar] Not closing: a signature is in flight');
  return true;
}

/**
 * Open the sidebar for a consent prompt. Unlike open(), this works when
 * any provider that hosts consent screens here is enabled — the Radicle
 * provider prompts must render without the identity-wallet flag.
 */
export function openForConsent() {
  requestOpened = true;
  revealForRequest();
  if (!isOpen) {
    isOpen = true;
    applyState();
    document.dispatchEvent(new CustomEvent('sidebar-opened'));
  }
}

/**
 * Close the sidebar
 */
export function close() {
  if (refuseSidebarClose()) return;
  // A closed panel is no longer hidden by full screen: the next toggle()
  // opens it into view rather than into a still-concealed panel.
  reveal();
  revealedForRequest = false;
  requestOpened = false;
  if (isOpen) {
    isOpen = false;
    applyState();
    // Dispatch event so other modules can clean up
    document.dispatchEvent(new CustomEvent('sidebar-closed'));
  }
}

/**
 * Hide (or show again) an open sidebar for browser full screen, leaving it
 * open underneath so leaving full screen restores it as it was (#78). A
 * sidebar holding a device confirmation stays in view: that prompt cannot be
 * recalled (see refuseSidebarClose). So does one showing a screen opened
 * through open()/openForConsent() that has not yet given way to the home view:
 * an unanswered request (a dApp connect or approval, a Radicle consent, a vault
 * unlock), but also a user-opened screen such as Send or Publish setup. It is
 * marked as revealed for that screen, so it steps aside once the home view
 * comes back, as one opened in full screen does. Anything that opens the
 * panel while it is hidden (an approval request, the shortcut) shows it
 * again, so a request arriving in full screen is never answered out of sight.
 */
export function setFullscreenConcealed(on) {
  fullscreen = Boolean(on);
  revealedForRequest = fullscreen && isOpen && isRequestUp();
  conceal();
}

// A screen opened through open()/openForConsent() (a request, or a
// user-opened one like Send) is up in the panel and the home view has not
// come back since. Without a home view to watch there is no way to tell
// when the request is over, so no request counts as up.
function isRequestUp() {
  return requestOpened && Boolean(homeView?.classList.contains('hidden'));
}

function conceal() {
  concealed = fullscreen && isOpen && !isSignatureInFlight() && !isRequestUp();
  sidebar?.classList.toggle('fullscreen-concealed', concealed);
}

// open()/openForConsent() show the panel over a full-screen page, for a request
// (an approval, a consent) or a screen the user opened (Send, Publish setup).
// That screen replaces the panel's home view while it is up, and each one
// puts the home view back when it is answered or dismissed; at that
// point the panel goes back to how full screen had it (concealed if it is
// still open), instead of staying over the page until the user dismisses it.
// Only a request that is what brings the panel into view marks it: a panel
// already in view over the full-screen page (shown again with the shortcut,
// or opened there by the user) is the user's choice and stays when the
// request is done. A mark from an earlier request still in flight is kept.
function revealForRequest() {
  if (fullscreen && (concealed || !isOpen)) revealedForRequest = true;
  reveal();
}

function watchHomeView(el) {
  // Unwatched, the home view coming back would go unseen and a request would
  // look up for ever; isRequestUp() treats a missing home view as no request.
  if (!el || typeof MutationObserver !== 'function') return;
  homeView = el;
  new MutationObserver(onHomeViewChange).observe(homeView, {
    attributes: true,
    attributeFilter: ['class'],
  });
}

function onHomeViewChange() {
  // Read the settled state, not the records: a request that hands straight
  // over to another (unlock, then connect) shows and hides the home view in
  // one go, and the panel is still in use.
  if (homeView.classList.contains('hidden')) return;
  requestOpened = false;
  if (!revealedForRequest || !fullscreen) return;
  revealedForRequest = false;
  conceal();
}

function reveal() {
  if (!concealed) return;
  concealed = false;
  sidebar?.classList.remove('fullscreen-concealed');
}

/**
 * Check if sidebar is open
 */
export function isVisible() {
  return isOpen;
}

/**
 * Whether the Identity & Wallet feature flag is on (controls the sidebar).
 */
export function isFeatureEnabled() {
  return featureEnabled;
}

/**
 * Disable the chrome that would collapse the panel while a signature is in
 * flight. Only while the panel is open: if it is closed the toggle is the
 * user's way back to the confirmation and must keep working.
 */
function applyFlightLock() {
  const locked = isOpen && isSignatureInFlight();

  if (closeBtn) {
    closeBtn.disabled = locked;
    closeBtn.title = locked ? IN_FLIGHT_TITLE : '';
  }
  if (toggleBtn) {
    toggleBtn.disabled = locked;
    toggleBtn.title = locked ? IN_FLIGHT_TITLE : '';
  }
}

/**
 * Apply current state to DOM
 */
function applyState() {
  if (!sidebar || !toggleBtn) return;

  applyFlightLock();

  if (isOpen) {
    sidebar.classList.remove('collapsed');
    toggleBtn.classList.add('active');
    toggleBtn.setAttribute('aria-expanded', 'true');
  } else {
    sidebar.classList.add('collapsed');
    toggleBtn.classList.remove('active');
    toggleBtn.setAttribute('aria-expanded', 'false');
  }
}
