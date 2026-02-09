// Renderer process entry point
import { updateRegistry } from './lib/state.js';
import { initBeeUi, updateBeeStatusLine, updateBeeToggleState } from './lib/bee-ui.js';
import { initIpfsUi, updateIpfsStatusLine, updateIpfsToggleState } from './lib/ipfs-ui.js';
import {
  initRadicleUi,
  updateRadicleStatusLine,
  updateRadicleToggleState,
} from './lib/radicle-ui.js';
import {
  initMenus,
  setOnOpenHistory,
  setOnNewTab,
  setOnMenuOpening,
  closeMenus,
} from './lib/menus.js';
import { initSettings, setOnSettingsChanged, initTheme } from './lib/settings-ui.js';
import {
  initBookmarks,
  loadBookmarks,
  setOnLoadTarget,
  hideBookmarkContextMenu,
  setOnBookmarkContextMenuOpening,
} from './lib/bookmarks-ui.js';
import {
  initTabs,
  setLoadTargetHandler,
  setReloadHandler,
  setHardReloadHandler,
  hideTabContextMenu,
  setOnContextMenuOpening as setOnTabContextMenuOpening,
  createTab,
} from './lib/tabs.js';
import {
  initNavigation,
  loadTarget,
  reloadPage,
  hardReloadPage,
  onSettingsChanged,
  setOnHistoryRecorded,
} from './lib/navigation.js';
import {
  initAutocomplete,
  setOnNavigate,
  refreshCache as refreshAutocompleteCache,
  hide as hideAutocomplete,
} from './lib/autocomplete.js';
import { initGithubBridgeUi, setOnOpenRadicleUrl } from './lib/github-bridge-ui.js';
import { initMenuBackdrop } from './lib/menu-backdrop.js';
import { initPageContextMenu, hidePageContextMenu } from './lib/page-context-menu.js';
import { pushDebug } from './lib/debug.js';
import { initOnboarding, checkAndShowOnboarding } from './lib/onboarding.js';
import { initSidebar } from './lib/sidebar.js';
import { initWalletUi, updateIdentityState } from './lib/wallet-ui.js';

const electronAPI = window.electronAPI;

// Apply theme early to avoid flash
initTheme();

// Listen for service registry updates from main process
window.serviceRegistry?.onUpdate?.((registry) => {
  pushDebug(`[ServiceRegistry] Update received: ${JSON.stringify(registry)}`);
  updateRegistry(registry);
  updateBeeStatusLine();
  updateBeeToggleState();
  updateIpfsStatusLine();
  updateIpfsToggleState();
  updateRadicleStatusLine();
  updateRadicleToggleState();
});

// Fetch initial registry state
window.serviceRegistry?.getRegistry?.().then((registry) => {
  if (registry) {
    pushDebug(`[ServiceRegistry] Initial state: ${JSON.stringify(registry)}`);
    updateRegistry(registry);
  }
});

// Wire up cross-module callbacks
setOnSettingsChanged(onSettingsChanged);
setOnLoadTarget(loadTarget);
setLoadTargetHandler(loadTarget);
setReloadHandler(reloadPage);
setHardReloadHandler(hardReloadPage);
setOnNavigate(loadTarget);
setOnHistoryRecorded(refreshAutocompleteCache);
setOnOpenHistory(() => loadTarget('freedom://history'));
setOnNewTab(() => createTab());
setOnOpenRadicleUrl((url) => loadTarget(url));
setOnMenuOpening(hideAutocomplete);
setOnTabContextMenuOpening(hideAutocomplete);
setOnBookmarkContextMenuOpening(hideAutocomplete);

// Initialize platform-specific UI adjustments
async function initPlatformUI() {
  const platform = await electronAPI.getPlatform();

  if (platform === 'linux') {
    document.body.classList.add('platform-linux');
  }
}

// Close all menus and context menus
const closeAllMenus = () => {
  closeMenus();
  hideTabContextMenu();
  hideBookmarkContextMenu();
  hidePageContextMenu();
};

// Close everything including autocomplete (used by backdrop)
const closeAllOverlays = () => {
  closeAllMenus();
  hideAutocomplete();
};

// Listen for close menus from main process (e.g., system menu clicked)
// Don't close autocomplete here - mirrors browser behavior where address bar stays open
electronAPI.onCloseMenus?.(closeAllMenus);

// Initialize update notification toast
function initUpdateNotifications() {
  const toast = document.getElementById('update-toast');
  const message = document.getElementById('update-toast-message');
  const actionBtn = document.getElementById('update-toast-action');
  const closeBtn = document.getElementById('update-toast-close');

  if (!toast || !message || !actionBtn || !closeBtn) return;

  let autoHideTimeout = null;

  const showToast = (text, showAction = false) => {
    message.textContent = text;
    actionBtn.hidden = !showAction;
    actionBtn.textContent = 'Install now';
    actionBtn.disabled = false;
    toast.hidden = false;

    // Clear any existing timeout
    if (autoHideTimeout) clearTimeout(autoHideTimeout);

    // Auto-hide after 8 seconds (unless action button is shown)
    if (!showAction) {
      autoHideTimeout = setTimeout(() => hideToast(), 8000);
    }
  };

  const hideToast = () => {
    toast.hidden = true;
  };

  closeBtn.addEventListener('click', hideToast);

  actionBtn.addEventListener('click', () => {
    actionBtn.textContent = 'Installing…';
    actionBtn.disabled = true;
    electronAPI.restartAndInstallUpdate?.();
  });

  // Listen for update notifications from main process
  electronAPI.onUpdateNotification?.((data) => {
    pushDebug(`[update] Received notification: ${data.type}`);
    if (data.type === 'ready') {
      showToast(data.message, true);
    } else {
      // checking, downloading, up-to-date
      showToast(data.message, false);
    }
  });
}

// Listen for open-url-new-tab custom event from context menu
document.addEventListener('open-url-new-tab', (e) => {
  const url = e.detail?.url;
  if (url) {
    createTab(url);
  }
});

// Initialize all modules
window.addEventListener('DOMContentLoaded', async () => {
  initMenuBackdrop(closeAllOverlays);
  initMenus();
  initBeeUi();
  initIpfsUi();
  initRadicleUi();
  initGithubBridgeUi();
  initSettings();
  initBookmarks();
  initNavigation(); // Sets up event handler with tabs module
  initTabs(); // Creates first tab and starts loading home page
  initAutocomplete(); // Address bar autocomplete
  initPageContextMenu(); // Page context menu for webviews
  initOnboarding();  // Identity onboarding wizard
  initSidebar();     // Identity & wallet sidebar
  initWalletUi();    // Wallet & identity display in sidebar
  loadBookmarks();
  initPlatformUI();
  initUpdateNotifications();

  // Check if onboarding is needed (first run)
  await checkAndShowOnboarding();
});
