// Menu dropdown handling
import { state } from './state.js';
import { startBeeInfoPolling, stopBeeInfoPolling } from './bee-ui.js';
import { startIpfsInfoPolling, stopIpfsInfoPolling } from './ipfs-ui.js';
import { startRadicleInfoPolling, stopRadicleInfoPolling } from './radicle-ui.js';
import { hideTabContextMenu, getActiveWebview } from './tabs.js';
import { hideBookmarkContextMenu, hideOverflowMenu } from './bookmarks-ui.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';

const electronAPI = window.electronAPI;

// DOM elements (initialized in initMenus)
let menuButton = null;
let menuDropdown = null;
let historyBtn = null;
let newTabMenuBtn = null;
let newWindowMenuBtn = null;
let zoomOutBtn = null;
let zoomInBtn = null;
let zoomLevelDisplay = null;
let fullscreenBtn = null;
let printBtn = null;
let devtoolsBtn = null;
let aboutBtn = null;
let checkUpdatesBtn = null;

// Callback for opening history (set by external module)
let onOpenHistory = null;
export const setOnOpenHistory = (callback) => {
  onOpenHistory = callback;
};

// Callback for creating a new tab (set by external module)
let onNewTab = null;
export const setOnNewTab = (callback) => {
  onNewTab = callback;
};

// Callback for when any menu opens (to close other dropdowns like autocomplete)
let onMenuOpening = null;
export const setOnMenuOpening = (callback) => {
  onMenuOpening = callback;
};
let beeMenuButton = null;
let beeMenuDropdown = null;
let webviewElement = null;
let beePeersCount = null;
let beeNetworkPeers = null;
let beeVersionText = null;
let beeInfoPanel = null;

export const setMenuOpen = (open) => {
  state.menuOpen = open;
  if (menuDropdown) {
    menuDropdown.classList.toggle('open', open);
  }
  if (menuButton) {
    menuButton.setAttribute('aria-expanded', String(open));
  }
  if (open) {
    setBeeMenuOpen(false);
    hideTabContextMenu();
    hideBookmarkContextMenu();
    hideOverflowMenu();
    onMenuOpening?.();
    showMenuBackdrop();
  } else if (!state.beeMenuOpen) {
    hideMenuBackdrop();
  }
};

export const setBeeMenuOpen = (open) => {
  state.beeMenuOpen = open;
  beeMenuDropdown?.classList.toggle('open', open);
  beeMenuButton?.setAttribute('aria-expanded', String(open));
  if (open) {
    setMenuOpen(false);
    hideTabContextMenu();
    hideBookmarkContextMenu();
    hideOverflowMenu();
    onMenuOpening?.();
    showMenuBackdrop();
    startBeeInfoPolling();
    startIpfsInfoPolling();
    startRadicleInfoPolling();
  } else {
    if (!state.menuOpen) {
      hideMenuBackdrop();
    }
    stopBeeInfoPolling();
    stopIpfsInfoPolling();
    stopRadicleInfoPolling();
    if (beePeersCount) beePeersCount.textContent = '0';
    if (beeNetworkPeers) beeNetworkPeers.textContent = '0';
    if (beeVersionText)
      beeVersionText.textContent = state.beeVersionFetched ? state.beeVersionValue : '';
    if (beeInfoPanel) beeInfoPanel.classList.remove('visible');
  }
};

export const closeMenus = () => {
  setMenuOpen(false);
  setBeeMenuOpen(false);
};

// Update zoom level display for the active webview
export const updateZoomDisplay = () => {
  const webview = getActiveWebview();
  if (webview && zoomLevelDisplay) {
    try {
      const zoomFactor = webview.getZoomFactor();
      zoomLevelDisplay.textContent = `${Math.round(zoomFactor * 100)}%`;
    } catch {
      zoomLevelDisplay.textContent = '100%';
    }
  }
};

// Format keyboard shortcuts for the current platform
const formatShortcut = (shortcut, isMac) => {
  if (!shortcut) return '';

  return shortcut
    .replace('CmdOrCtrl', isMac ? '⌘' : 'Ctrl')
    .replace('Alt', isMac ? '⌥' : 'Alt')
    .replace('Shift', isMac ? '⇧' : 'Shift')
    .replace(/\+/g, '');
};

// Initialize keyboard shortcuts based on platform
const initKeyboardShortcuts = async () => {
  const platform = await electronAPI?.getPlatform?.();
  const isMac = platform === 'darwin';

  document.querySelectorAll('.menu-item-shortcut[data-shortcut]').forEach((el) => {
    const shortcut = el.dataset.shortcut;
    el.textContent = formatShortcut(shortcut, isMac);
  });
};

export const initMenus = () => {
  // Initialize platform-specific keyboard shortcuts
  initKeyboardShortcuts();

  // Initialize DOM elements
  menuButton = document.getElementById('menu-button');
  menuDropdown = document.getElementById('menu-dropdown');
  historyBtn = document.getElementById('history-btn');
  newTabMenuBtn = document.getElementById('new-tab-menu-btn');
  newWindowMenuBtn = document.getElementById('new-window-menu-btn');
  zoomOutBtn = document.getElementById('zoom-out-btn');
  zoomInBtn = document.getElementById('zoom-in-btn');
  zoomLevelDisplay = document.getElementById('zoom-level');
  fullscreenBtn = document.getElementById('fullscreen-btn');
  printBtn = document.getElementById('print-btn');
  devtoolsBtn = document.getElementById('devtools-btn');
  aboutBtn = document.getElementById('about-btn');
  checkUpdatesBtn = document.getElementById('check-updates-btn');
  beeMenuButton = document.getElementById('bee-menu-button');
  beeMenuDropdown = document.getElementById('bee-menu-dropdown');
  webviewElement = document.getElementById('bzz-webview');
  beePeersCount = document.getElementById('bee-peers-count');
  beeNetworkPeers = document.getElementById('bee-network-peers');
  beeVersionText = document.getElementById('bee-version-text');
  beeInfoPanel = document.querySelector('.bee-info');

  menuButton?.addEventListener('click', () => {
    setMenuOpen(!state.menuOpen);
    if (state.menuOpen) {
      updateZoomDisplay();
    }
  });

  // New Tab button
  newTabMenuBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    onNewTab?.();
  });

  // New Window button
  newWindowMenuBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.newWindow?.();
  });

  // History button
  historyBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    onOpenHistory?.();
  });

  // Zoom controls
  zoomOutBtn?.addEventListener('click', () => {
    const webview = getActiveWebview();
    if (webview) {
      const currentZoom = webview.getZoomFactor();
      const newZoom = Math.max(0.25, currentZoom - 0.1);
      webview.setZoomFactor(newZoom);
      updateZoomDisplay();
    }
  });

  zoomInBtn?.addEventListener('click', () => {
    const webview = getActiveWebview();
    if (webview) {
      const currentZoom = webview.getZoomFactor();
      const newZoom = Math.min(5, currentZoom + 0.1);
      webview.setZoomFactor(newZoom);
      updateZoomDisplay();
    }
  });

  // Fullscreen button
  fullscreenBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.toggleFullscreen?.();
  });

  // Print
  printBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    const webview = getActiveWebview();
    if (webview) {
      webview.print();
    }
  });

  // Developer Tools
  devtoolsBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    const webview = getActiveWebview();
    if (webview) {
      if (webview.isDevToolsOpened()) {
        webview.closeDevTools();
      } else {
        webview.openDevTools();
      }
    }
  });

  // About
  aboutBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.showAbout?.();
  });

  // Check for Updates
  checkUpdatesBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.checkForUpdates?.();
  });

  beeMenuButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    setBeeMenuOpen(!state.beeMenuOpen);
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (state.menuOpen && !menuButton?.contains(target) && !menuDropdown?.contains(target)) {
      setMenuOpen(false);
    }
    if (
      state.beeMenuOpen &&
      !beeMenuButton?.contains(target) &&
      !beeMenuDropdown?.contains(target)
    ) {
      setBeeMenuOpen(false);
    }
  });

  webviewElement?.addEventListener('focus', closeMenus);
  webviewElement?.addEventListener('mousedown', closeMenus);

  // Close menus when window loses focus (switching windows or backgrounding app)
  window.addEventListener('blur', closeMenus);
};
