/**
 * Sidebar Module
 *
 * Manages the right-side identity & wallet sidebar.
 * Fixed width (320px), toggle open/closed.
 */

// State
let isOpen = false;
let featureEnabled = false;

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
  window.electronAPI.getSettings().then((settings) => {
    featureEnabled = settings?.enableIdentityWallet === true;
    applyFeatureVisibility();
  }).catch(() => {
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

  // Setup event listeners
  toggleBtn.addEventListener('click', toggle);

  if (closeBtn) {
    closeBtn.addEventListener('click', close);
  }

  // Keyboard shortcut: Cmd/Ctrl+Shift+W
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'W') {
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
 * Close the sidebar
 */
export function close() {
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
 * Apply current state to DOM
 */
function applyState() {
  if (!sidebar || !toggleBtn) return;

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
