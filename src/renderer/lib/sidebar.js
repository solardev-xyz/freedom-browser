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
// The Radicle provider's consent prompts live in this sidebar too, and the
// Radicle integration is gated independently of the identity wallet —
// consent-driven opens must work when either flag is on.
let radicleEnabled = false;

// DOM references
let sidebar;
let toggleBtn;
let closeBtn;

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
      radicleEnabled = settings?.enableRadicleIntegration === true;
      applyFeatureVisibility();
    })
    .catch(() => {
      featureEnabled = false;
      radicleEnabled = false;
      applyFeatureVisibility();
    });

  // React to settings changes
  window.addEventListener('settings:updated', (event) => {
    const wasEnabled = featureEnabled;
    featureEnabled = event.detail?.enableIdentityWallet === true;
    radicleEnabled = event.detail?.enableRadicleIntegration === true;
    applyFeatureVisibility();
    // Close sidebar if feature was just disabled while open
    if (wasEnabled && !featureEnabled && isOpen) {
      close();
    }
  });

  // Apply initial state (sidebar starts closed)
  applyState();

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
  if (!featureEnabled && !radicleEnabled) return;
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
  if (isOpen) {
    isOpen = false;
    applyState();
    // Dispatch event so other modules can clean up
    document.dispatchEvent(new CustomEvent('sidebar-closed'));
  }
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
