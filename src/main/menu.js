const log = require('./logger');
const electron = require('electron');
const { BrowserWindow, Menu, app, dialog, ipcMain } = electron;
const {
  isMainBrowserWindow,
  getMainWindows,
  getLastFocusedMainWindow,
  createMainWindow,
} = require('./windows/mainWindow');
const { createPrivateWindow, isPrivateWebContents } = require('./private/private-windows');
const {
  checkForUpdates,
  getInstallRelaunchMode,
  isUpdateReady,
  installUpdate,
} = require('./updater');
const { getActiveProfile, listProfilesForActiveApp } = require('./profile-resolver');
const { openOrFocusProfile } = require('./profile-launcher');
const IPC = require('../shared/ipc-channels');
const { getEffectiveAccelerator, getAliasAccelerators } = require('../shared/shortcuts');
const { loadSettings, onSettingsChanged } = require('./settings-store');
const { getRecentHistory, onHistoryChanged } = require('./history');
const { getCachedFavicon } = require('./favicons');

// Every menu accelerator comes from the shared shortcut registry
// (src/shared/shortcuts.js) — menu.test.js rejects accelerator literals in
// this file so new shortcuts land in the registry first. `acc` resolves the
// per-profile override (Settings > Shortcuts) over the registry default;
// aliases are fixed and never remapped.
const currentOverrides = () => {
  try {
    return loadSettings()?.shortcutOverrides || {};
  } catch {
    return {};
  }
};
const acc = (id, platform = process.platform) =>
  getEffectiveAccelerator(id, currentOverrides(), platform);
const aliasAcc = (id, index, platform = process.platform) =>
  getAliasAccelerators(id, platform)[index];

// Hidden rows carrying a shortcut's fixed aliases. An accelerator only fires
// if a menu item owns it, but a second visible row per alias would duplicate
// the action in the menu — so alias rows are `visible: false`, the same shape
// as the hidden Force Reload item below.
const aliasMenuItems = (id, label, channel, platform = process.platform) =>
  getAliasAccelerators(id, platform).map((accelerator) => ({
    label,
    accelerator,
    visible: false,
    click: () => {
      const win = getTargetWindow();
      if (win) {
        win.webContents.send(channel);
      }
    },
  }));

// Rebuild the application menu when the user remaps shortcuts so the new
// accelerators take effect without a restart.
onSettingsChanged((merged, previous) => {
  const before = JSON.stringify(previous?.shortcutOverrides || {});
  const after = JSON.stringify(merged?.shortcutOverrides || {});
  if (before !== after) {
    setupApplicationMenu();
  }
});

// Helper to get the best target window for tab operations
// Only returns main browser windows we created (not DevTools or other system windows).
// With focus elsewhere (detached DevTools), fall back to the main window the
// user focused last, not getMainWindows()[0]: that list is kept in focus
// order, so its first entry is the window left longest ago.
function getTargetWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && isMainBrowserWindow(focused)) {
    return focused;
  }
  return getLastFocusedMainWindow();
}

function openProfilesManager() {
  const win = getTargetWindow();
  if (win) {
    win.webContents.send('tab:new-with-url', 'freedom://profiles');
    return;
  }
  createMainWindow('freedom://profiles');
}

// Switch to another profile, mirroring the renderer's PROFILE_OPEN handler:
// focus the profile's window if it's already running, otherwise launch it.
async function switchToProfile(profileId) {
  const activeProfile = getActiveProfile();
  if (!activeProfile || activeProfile.source !== 'catalog') return;
  if (!profileId || profileId === activeProfile.id) return;
  // A switch can take a few seconds before it lands or fails (on GNOME
  // Wayland it waits for the other profile to confirm an xdg-open switch, and
  // one that does not land then tries the focus-request file), and the native
  // menu is closed by then. Show the wait as a progress bar on the window's
  // taskbar/dock entry, where the desktop draws one (setSwitchBusy).
  const busyWindow = switchFeedbackWindow();
  const stopBusy = setSwitchBusy(busyWindow);
  try {
    // openOrFocusProfile resolves with { error } (it does NOT throw) when the
    // profile is running but never acknowledged the focus request. The native
    // menu has no status line like the hamburger flyout, so surface it with a
    // dialog instead of failing silently — mirrors the renderer's
    // PROFILE_FOCUS_FAILED handling.
    const result = await openOrFocusProfile(activeProfile, profileId);
    if (result?.error) {
      log.warn('[menu] Profile switch did not complete:', result.error);
      dialog.showErrorBox('Could not switch profile', result.error);
    }
  } catch (err) {
    log.error('[menu] Failed to switch profile:', err?.message || err);
    dialog.showErrorBox(
      'Could not switch profile',
      err?.message || 'The profile could not be opened.'
    );
  } finally {
    stopBusy();
  }
}

function switchFeedbackWindow() {
  try {
    return getTargetWindow();
  } catch {
    return null;
  }
}

// How long the Linux bar takes to fill to SWITCH_BUSY_LINUX_CAP: about the
// longest a switch waits (profile-switch-scheme.js's 6 s ack budget, then up to
// 1.8 s of focus-request file hand-off).
const SWITCH_BUSY_LINUX_FILL_MS = 8000;
const SWITCH_BUSY_LINUX_CAP = 0.9;
const SWITCH_BUSY_LINUX_TICK_MS = 250;

// Show a switch in progress on `win`; returns the function that clears it.
// Windows and macOS draw a progress value above 1 as an indeterminate bar.
// Linux does not: Electron sets it on the Unity LauncherEntry (Ubuntu Dock,
// KDE's task manager), which has no indeterminate mode ("Indeterminate mode is
// not supported", Electron 44's setProgressBar docs), so a 2 there would read
// as a full, finished bar. On Linux the bar instead fills with the time spent
// waiting and stops short of full, so it never reads as done.
function setSwitchBusy(win, { platform = process.platform } = {}) {
  const set = (value) => {
    try {
      if (!win || win.isDestroyed?.()) return false;
      win.setProgressBar?.(value);
      return true;
    } catch {
      // Feedback only.
      return false;
    }
  };
  if (platform !== 'linux') {
    set(2);
    return () => set(-1);
  }
  const startedAt = Date.now();
  const fill = () =>
    Math.min(SWITCH_BUSY_LINUX_CAP, (Date.now() - startedAt) / SWITCH_BUSY_LINUX_FILL_MS);
  // Start visibly above zero: a 0 bar is drawn as nothing on some docks.
  set(Math.max(0.05, fill()));
  const timer = setInterval(() => {
    if (!set(Math.max(0.05, fill()))) clearInterval(timer);
  }, SWITCH_BUSY_LINUX_TICK_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    set(-1);
  };
}

// Build the Profiles menu dynamically from the catalog, mirroring the
// hamburger flyout: profile list (current checked + disabled) → separator →
// Create Profile… → Manage Profiles….
function buildProfilesSubmenu() {
  const submenu = [];
  let profiles;
  try {
    profiles = listProfilesForActiveApp() || [];
  } catch {
    profiles = [];
  }
  const activeProfile = getActiveProfile();
  const registered = profiles.filter((profile) => profile?.isUnregistered !== true);

  for (const profile of registered) {
    const isCurrent = profile.isActive === true || profile.id === activeProfile?.id;
    if (isCurrent) {
      // The current profile is a checked, disabled checkbox.
      submenu.push({
        label: profile.displayName || profile.id,
        type: 'checkbox',
        checked: true,
        enabled: false,
      });
    } else {
      // Other profiles are plain items. Deliberately NOT checkboxes: macOS
      // auto-toggles a checkbox item's checkmark on click, and switching opens
      // a new profile process without rebuilding this menu — a checkbox here
      // would be left showing a phantom second checkmark next to the current
      // profile.
      submenu.push({
        label: profile.displayName || profile.id,
        click: () => switchToProfile(profile.id),
      });
    }
  }

  if (submenu.length) {
    submenu.push({ type: 'separator' });
  }

  submenu.push(
    {
      label: 'Create Profile…',
      click: () => {
        // Open the shared chrome create-modal in the focused window.
        const win = getTargetWindow();
        if (win) {
          win.webContents.send(IPC.PROFILE_SHOW_CREATE_MODAL);
        }
      },
    },
    {
      label: 'Manage Profiles…',
      click: () => {
        log.info('[menu] Manage Profiles clicked');
        openProfilesManager();
      },
    }
  );

  return submenu;
}

let newTabMenuItem = null;
let closeTabMenuItem = null;
let toggleBookmarkBarMenuItem = null;
let isFullScreen = false;

function updateTabMenuItems() {
  const hasWindows = BrowserWindow.getAllWindows().length > 0;
  if (newTabMenuItem) newTabMenuItem.enabled = hasWindows;
  if (closeTabMenuItem) closeTabMenuItem.enabled = hasWindows;
}

function buildAppMenuSubmenu(updateMenuItems) {
  return [
    { role: 'about' },
    { type: 'separator' },
    ...updateMenuItems,
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' },
  ];
}

// Close Window is spelled out instead of `{ role: 'close' }`, and carries no
// accelerator at all. Every Electron menu role has an implicit default
// accelerator and `close`'s is CommandOrControl+W — the chord Close Tab above
// already owns. Windows and Linux resolve that collision in the role's favour,
// so Ctrl+W closed the whole window instead of the active tab (#97); macOS's
// NSMenu picks the first matching row (Close Tab) and hid the bug.
//
// Probed against the Electron the repo shipped at the time (44.3.0, Linux,
// 2026-09-16; 44.4.1 since #346) with
// a real Ctrl+W keypress, because neither alternative holds up:
//   { role: 'close' }                            → window closes (the bug)
//   { role: 'close', accelerator: null }         → window closes; a null
//                                                  accelerator falls back to
//                                                  the role's own default
//   { role: 'close', registerAccelerator: false} → Close Tab fires, but the
//                                                  row still prints "Ctrl+W",
//                                                  advertising a chord it no
//                                                  longer answers
// A plain item with no role and no accelerator is the only shape that leaves
// Cmd/Ctrl+W solely owned by Close Tab on every platform. Chrome's own Close
// Window chord (Ctrl+Shift+W) is not free here — view.toggleSidebar owns it —
// so this row stays accelerator-less rather than taking a chord off another
// shortcut. Closing the last tab still closes the window (tabs.js closeTab).
function buildCloseWindowMenuItem() {
  return {
    id: 'close-window',
    label: 'Close Window',
    click: () => {
      // Same target the `close` role used: whichever window has focus.
      const win = BrowserWindow.getFocusedWindow();
      if (win) {
        win.close();
      }
    },
  };
}

function buildFileSubmenu(isMac) {
  const submenu = [
    {
      id: 'new-tab',
      label: 'New Tab',
      accelerator: acc('tab.new'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:new');
        }
      },
    },
    {
      id: 'close-tab',
      label: 'Close Tab',
      accelerator: acc('tab.close'),
      click: () => {
        const mainWindows = getMainWindows();
        const focusedMainWindow = mainWindows.find((win) => win.isFocused());

        if (focusedMainWindow) {
          focusedMainWindow.webContents.send('tab:close');
        }
        // If no main window is focused (DevTools has focus), do nothing.
        // User can close DevTools with the X button or Cmd+Option+I
      },
    },
  ];

  if (!isMac) {
    submenu.push({
      label: 'Close Tab',
      // Fixed Ctrl+F4 alias from the registry (win/linux only).
      accelerator: aliasAcc('tab.close', 0),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:close');
        }
      },
    });
  }

  submenu.push(
    {
      id: 'reopen-closed-tab',
      label: 'Reopen Closed Tab',
      accelerator: acc('tab.reopenClosed'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:reopen-closed');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'New Window',
      accelerator: acc('window.new'),
      click: () => {
        log.info('[menu] New Window clicked');
        createMainWindow();
      },
    },
    {
      id: 'new-private-window',
      label: 'New Private Window',
      accelerator: acc('window.newPrivate'),
      click: () => {
        log.info('[menu] New Private Window clicked');
        createPrivateWindow();
      },
    },
    { type: 'separator' },
    buildCloseWindowMenuItem()
  );

  if (!isMac) {
    submenu.push({ type: 'separator' }, { role: 'quit' });
  }

  return submenu;
}

function buildViewSubmenu({ isFullScreen: fullScreen, showAppDevtools }) {
  const submenu = [
    {
      id: 'reload',
      label: 'Reload This Page',
      accelerator: acc('page.reload'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('page:reload');
        }
      },
    },
    {
      label: 'Force Reload This Page',
      accelerator: acc('page.hardReload'),
      visible: false,
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('page:hard-reload');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Focus Address Bar',
      accelerator: acc('view.focusAddressBar'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('menus:close');
          win.webContents.send('focus:address-bar');
        }
      },
    },
    { type: 'separator' },
    // Zoom targets the active <webview>, so it goes through the renderer
    // rather than Electron's zoomIn/zoomOut/resetZoom roles — those step
    // zoomLevel on the focused webContents (the chrome, when the address
    // bar has focus) and carry accelerators this registry cannot remap.
    // Each visible row is followed by hidden rows for its registry aliases
    // (Ctrl+Shift+=, Ctrl+Plus, keypad) so those chords fire too without
    // duplicating the action in the menu.
    {
      id: 'zoom-in',
      label: 'Zoom In',
      accelerator: acc('page.zoomIn'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('page:zoom-in');
        }
      },
    },
    ...aliasMenuItems('page.zoomIn', 'Zoom In', 'page:zoom-in'),
    {
      id: 'zoom-out',
      label: 'Zoom Out',
      accelerator: acc('page.zoomOut'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('page:zoom-out');
        }
      },
    },
    ...aliasMenuItems('page.zoomOut', 'Zoom Out', 'page:zoom-out'),
    {
      id: 'zoom-reset',
      label: 'Actual Size',
      accelerator: acc('page.zoomReset'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('page:zoom-reset');
        }
      },
    },
    ...aliasMenuItems('page.zoomReset', 'Actual Size', 'page:zoom-reset'),
    { type: 'separator' },
    {
      id: 'fullscreen',
      label: fullScreen ? 'Exit Full Screen' : 'Enter Full Screen',
      accelerator: acc('view.fullscreen'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.setFullScreen(!win.isFullScreen());
        }
      },
    },
    { type: 'separator' },
    {
      id: 'next-tab',
      label: 'Next Tab',
      accelerator: acc('tab.next'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:next');
        }
      },
    },
    {
      id: 'prev-tab',
      label: 'Previous Tab',
      accelerator: acc('tab.previous'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:prev');
        }
      },
    },
    {
      id: 'move-tab-right',
      label: 'Move Tab Right',
      accelerator: acc('tab.moveRight'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:move-right');
        }
      },
    },
    {
      id: 'move-tab-left',
      label: 'Move Tab Left',
      accelerator: acc('tab.moveLeft'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:move-left');
        }
      },
    },
    { type: 'separator' },
    {
      id: 'toggle-bookmark-bar',
      label: 'Always Show Bookmarks Bar',
      type: 'checkbox',
      checked: false,
      accelerator: acc('view.toggleBookmarksBar'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('bookmarks:toggle-bar');
        }
      },
    },
    // Agent floats over the page, so its chord has to reach the chrome while
    // the page holds the keyboard: the renderer's own keydown only sees it
    // when focus is already in the chrome.
    {
      id: 'toggle-agent',
      label: 'Show Agent',
      accelerator: acc('view.toggleAgent'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('agent:toggle');
        }
      },
    },
    { type: 'separator' },
    {
      id: 'toggle-devtools',
      label: 'Developer Tools',
      accelerator: acc('devtools.toggle'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('devtools:toggle');
        }
      },
    },
  ];

  if (showAppDevtools) {
    submenu.push({
      id: 'toggle-app-devtools',
      label: 'App Developer Tools',
      accelerator: acc('devtools.toggleApp'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.toggleDevTools();
        }
      },
    });
  }

  return submenu;
}

// Downloads lives where Chrome puts it: the Window menu on macOS, next to
// History on Linux/Windows (#326). One builder so the two placements can never
// drift in label, accelerator or behaviour.
function buildDownloadsMenuItem() {
  return {
    id: 'downloads',
    label: 'Downloads',
    accelerator: acc('downloads.show'),
    click: () => {
      const win = getTargetWindow();
      if (win) {
        // Singleton internal page: the renderer focuses an existing
        // freedom://downloads tab instead of opening a duplicate.
        win.webContents.send('tab:new-with-url', 'freedom://downloads');
      }
    },
  };
}

// ── History menu (#584) ─────────────────────────────────────────────────
//
// Chrome's History menu: Back / Forward, Recently Closed, Recently Visited,
// then Show All History. The two lists are rebuilt (debounced) whenever what
// they show changes — see scheduleHistoryMenuRefresh below.

const RECENTLY_VISITED_LIMIT = 15;
const RECENTLY_CLOSED_LIMIT = 10;
// Native menus have no text-overflow; a long title would stretch the whole
// menu across the screen. Chrome cuts its History rows at about this width.
const HISTORY_LABEL_MAX = 60;

// Addresses that never make a menu row: the browser's own pages (Chrome
// leaves out chrome://), and schemes that only ever name chrome-internal or
// one-off documents (error and interstitial pages are file: URLs). History
// recording already skips these (isHistoryRecordable); this is the read-side
// twin, so nothing that slipped into an older database surfaces here.
const UNLISTED_URL_PREFIXES = [
  'freedom:',
  'view-source:',
  'about:',
  'file:',
  'chrome:',
  'devtools:',
  'data:',
  'blob:',
  'javascript:',
];

function isHistoryMenuUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  const lower = url.trim().toLowerCase();
  return !UNLISTED_URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// Title, or the address when the page has none; one line, cut to a sane
// width. `&` is doubled because Electron reads a single one as a mnemonic
// marker (Windows/Linux) or drops it (macOS) — a page titled "Q&A" would
// otherwise show as "QA" with an underlined A.
function historyMenuLabel(title, url) {
  const text =
    String(title || '')
      .replace(/\s+/g, ' ')
      .trim() || String(url || '').trim();
  const chars = Array.from(text);
  const cut =
    chars.length > HISTORY_LABEL_MAX ? `${chars.slice(0, HISTORY_LABEL_MAX - 1).join('')}…` : text;
  return cut.replace(/&/g, '&&');
}

// Cached favicon for a page, as a 16px menu icon, or undefined. Never fetches:
// a menu rebuild must not wait on the network.
const faviconImageCache = new Map();
function historyMenuIcon(url) {
  const nativeImage = electron.nativeImage;
  if (!nativeImage?.createFromDataURL) return undefined;
  let data;
  try {
    data = getCachedFavicon(url);
  } catch {
    return undefined;
  }
  if (typeof data !== 'string' || !data.startsWith('data:')) return undefined;
  if (faviconImageCache.has(data)) return faviconImageCache.get(data) || undefined;
  let image = null;
  try {
    const decoded = nativeImage.createFromDataURL(data);
    if (decoded && !decoded.isEmpty()) {
      image = decoded.resize({ width: 16, height: 16, quality: 'best' });
    }
  } catch {
    image = null;
  }
  if (faviconImageCache.size > 200) faviconImageCache.clear();
  faviconImageCache.set(data, image);
  return image || undefined;
}

// The latest visits, newest first. Reads this process's history database —
// one per profile (each profile runs in its own process with its own
// userData), and private windows never write to it (history.js guard).
function getRecentlyVisited() {
  let rows;
  try {
    // Over-fetch so filtered rows don't leave the list short.
    rows = getRecentHistory(RECENTLY_VISITED_LIMIT * 3) || [];
  } catch (err) {
    log.warn('[menu] Could not read recent history:', err?.message || err);
    return [];
  }
  const seen = new Set();
  const visited = [];
  for (const row of rows) {
    if (!isHistoryMenuUrl(row?.url) || seen.has(row.url)) continue;
    seen.add(row.url);
    visited.push({ url: row.url, title: row.title || '' });
    if (visited.length >= RECENTLY_VISITED_LIMIT) break;
  }
  return visited;
}

// Closed-tab lists pushed by each normal window's renderer (tabs.js
// closedTabsStack), keyed by BrowserWindow id. Private windows are never
// stored (see the update-tab-state handler).
const closedTabsByWindow = new Map();

// Every normal window's closed tabs, newest first — what Reopen Closed Tab
// would bring back in each window, merged the way Chrome's profile-wide list
// reads.
function getRecentlyClosed() {
  const all = [];
  for (const [windowId, entries] of closedTabsByWindow) {
    for (const entry of entries) {
      if (!isHistoryMenuUrl(entry?.url)) continue;
      all.push({
        windowId,
        id: entry.id,
        url: entry.url,
        title: entry.title || '',
        closedAt: Number(entry.closedAt) || 0,
      });
    }
  }
  all.sort((a, b) => b.closedAt - a.closedAt);
  return all.slice(0, RECENTLY_CLOSED_LIMIT);
}

function reopenClosedEntry(entry) {
  const win = BrowserWindow.fromId?.(entry.windowId);
  if (!win || win.isDestroyed?.()) return;
  if (win.isMinimized?.()) win.restore();
  win.focus?.();
  win.webContents.send('tab:reopen-closed', entry.id);
}

// A Recently Visited row loads its address in the active tab through the
// renderer's loadTarget — the address bar's own path — so bzz://, ipfs://,
// ENS names and the rest resolve exactly as if typed, not as a raw URL load.
function openVisitedEntry(url) {
  const win = getTargetWindow();
  if (win) {
    win.webContents.send('tab:load-url', url);
    return;
  }
  createMainWindow(url);
}

function collectHistoryMenuData() {
  // After stopHistoryMenuRefresh() (app wind-down) the history database is
  // about to be, or already is, closed; reading it here would reopen it.
  if (historyMenuStopped) return { closed: [], visited: [] };
  return { closed: getRecentlyClosed(), visited: getRecentlyVisited() };
}

// What the two lists show, for skipping a rebuild that would change nothing
// (a revisit of the page already on top only bumps its timestamp).
function historyMenuSignature({ closed, visited }) {
  return JSON.stringify([
    closed.map((entry) => [entry.windowId, entry.id, entry.url, entry.title]),
    visited.map((entry) => [entry.url, entry.title, !!getCachedFaviconSafe(entry.url)]),
  ]);
}

function getCachedFaviconSafe(url) {
  try {
    return getCachedFavicon(url);
  } catch {
    return null;
  }
}

function buildHistorySubmenu(isMac, data = collectHistoryMenuData()) {
  const { closed, visited } = data;
  const submenu = [
    {
      id: 'history-back',
      label: 'Back',
      accelerator: acc('nav.back'),
      // Enabled by applyTabState once the active tab reports it can go back.
      enabled: false,
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('history:back');
        }
      },
    },
    {
      id: 'history-forward',
      label: 'Forward',
      accelerator: acc('nav.forward'),
      enabled: false,
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('history:forward');
        }
      },
    },
  ];

  if (closed.length) {
    submenu.push(
      { type: 'separator' },
      { id: 'history-recently-closed', label: 'Recently Closed', enabled: false }
    );
    for (const entry of closed) {
      submenu.push({
        label: historyMenuLabel(entry.title, entry.url),
        icon: historyMenuIcon(entry.url),
        click: () => reopenClosedEntry(entry),
      });
    }
  }

  if (visited.length) {
    submenu.push(
      { type: 'separator' },
      { id: 'history-recently-visited', label: 'Recently Visited', enabled: false }
    );
    for (const entry of visited) {
      submenu.push({
        label: historyMenuLabel(entry.title, entry.url),
        icon: historyMenuIcon(entry.url),
        click: () => openVisitedEntry(entry.url),
      });
    }
  }

  submenu.push(
    { type: 'separator' },
    {
      label: 'Show All History',
      accelerator: acc('history.showAll'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:new-with-url', 'freedom://history');
        }
      },
    }
  );

  // On macOS the item belongs to the Window menu instead (Chrome:
  // Window > Downloads ⇧⌘J), so it is not repeated here.
  if (!isMac) {
    submenu.push({ type: 'separator' }, buildDownloadsMenuItem());
  }

  return submenu;
}

// Keep the `windowMenu` role (native label + macOS window-list semantics) but
// spell out its submenu so Downloads can be appended — the same shape the
// `editMenu` role uses for Find in Page. The listed roles mirror the role's
// default macOS submenu.
function buildWindowMenuEntry() {
  return {
    role: 'windowMenu',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      buildDownloadsMenuItem(),
      { type: 'separator' },
      { role: 'front' },
    ],
  };
}

// Find in Page needs a custom click handler (main → renderer IPC), so it
// can't come from a role. The renderer's find-bar module listens on the
// other end and drives the active webview's findInPage().
function buildFindMenuItem() {
  return {
    id: 'find-in-page',
    label: 'Find in Page…',
    accelerator: acc('page.findInPage'),
    click: () => {
      const win = getTargetWindow();
      if (win) {
        win.webContents.send(IPC.FIND_IN_PAGE_OPEN);
      }
    },
  };
}

function buildEditMenuEntry(isMac) {
  if (isMac) {
    // Keep the `editMenu` role (native label + placement semantics) but
    // spell out its submenu so Find in Page can be appended — a bare role
    // entry can't carry extra items. The listed roles mirror the role's
    // default macOS submenu.
    return {
      role: 'editMenu',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        buildFindMenuItem(),
        { type: 'separator' },
        {
          label: 'Speech',
          submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
        },
      ],
    };
  }

  return {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
      { type: 'separator' },
      buildFindMenuItem(),
    ],
  };
}

function buildSharedMenuEntries(ctx) {
  const { isMac, isFullScreen: fullScreen, isPackaged, historyData } = ctx;

  return [
    { label: 'File', submenu: buildFileSubmenu(isMac) },
    buildEditMenuEntry(isMac),
    {
      label: 'View',
      submenu: buildViewSubmenu({
        isFullScreen: fullScreen,
        showAppDevtools: !isPackaged,
      }),
    },
    { label: 'History', submenu: buildHistorySubmenu(isMac, historyData) },
    { label: 'Profiles', submenu: buildProfilesSubmenu() },
  ];
}

function buildDarwinMenuTemplate(ctx) {
  return [
    { role: 'appMenu', submenu: buildAppMenuSubmenu(ctx.updateMenuItems) },
    ...buildSharedMenuEntries(ctx),
    buildWindowMenuEntry(),
  ];
}

function buildWinLinuxMenuTemplate(ctx) {
  return buildSharedMenuEntries(ctx);
}

function buildApplicationMenuTemplate({
  platform = process.platform,
  updateMenuItems,
  isFullScreen: fullScreen = false,
  isPackaged = app.isPackaged,
  historyData = collectHistoryMenuData(),
} = {}) {
  const ctx = {
    platform,
    updateMenuItems,
    isMac: platform === 'darwin',
    isFullScreen: fullScreen,
    isPackaged,
    historyData,
  };

  return ctx.isMac ? buildDarwinMenuTemplate(ctx) : buildWinLinuxMenuTemplate(ctx);
}

function setupApplicationMenu() {
  const updateReady = isUpdateReady();

  const updateMenuItems = updateReady
    ? [
        {
          label: getInstallRelaunchMode().menuLabel,
          click: () => {
            installUpdate();
          },
        },
        {
          label: 'Check for Updates…',
          enabled: false,
        },
      ]
    : [
        {
          label: 'Check for Updates…',
          click: () => {
            checkForUpdates();
          },
        },
      ];

  const historyData = collectHistoryMenuData();
  const template = buildApplicationMenuTemplate({
    updateMenuItems,
    isFullScreen,
    isPackaged: app.isPackaged,
    historyData,
  });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  lastHistorySignature = historyMenuSignature(historyData);
  historyRefreshPending = false;
  trackHistorySubmenuOpen(menu);

  // Close renderer menus when system menu opens
  menu.on('menu-will-show', () => {
    const windows = getMainWindows();
    windows.forEach((win) => {
      win.webContents.send('menus:close');
    });
  });

  // Store references to menu items for dynamic enable/disable
  newTabMenuItem = menu.getMenuItemById('new-tab');
  closeTabMenuItem = menu.getMenuItemById('close-tab');
  toggleBookmarkBarMenuItem = menu.getMenuItemById('toggle-bookmark-bar');
  updateTabMenuItems();
  // Restore renderer-pushed state the rebuild just reset.
  const tabStateToApply = tabStateForTargetWindow() || lastTabState;
  if (tabStateToApply) applyTabState(tabStateToApply);
  if (toggleBookmarkBarMenuItem && lastBookmarkBarEnabled !== null) {
    toggleBookmarkBarMenuItem.enabled = lastBookmarkBarEnabled;
  }
  if (toggleBookmarkBarMenuItem && lastBookmarkBarChecked !== null) {
    toggleBookmarkBarMenuItem.checked = lastBookmarkBarChecked;
  }
}

// Last renderer-pushed dynamic state, re-applied after any menu rebuild
// (shortcut remap, fullscreen label flip) — rebuilt items otherwise reset
// to template defaults until the renderer's next push.
let lastTabState = null;
let lastBookmarkBarEnabled = null;
let lastBookmarkBarChecked = null;

// Each window's last pushed tab state, by BrowserWindow id. The menu is
// app-wide but Back/Forward (and the tab rows) describe one window's active
// tab, so focusing another window re-applies that window's state rather than
// leaving whichever window pushed last in charge.
const tabStateByWindow = new Map();

function windowIdForSender(sender) {
  try {
    const win = BrowserWindow.fromWebContents?.(sender);
    return win && !win.isDestroyed?.() ? win.id : null;
  } catch {
    return null;
  }
}

function tabStateForTargetWindow() {
  if (!tabStateByWindow.size) return null;
  const target = getTargetWindow();
  if (!target) return null;
  return tabStateByWindow.get(target.id) || null;
}

function closedTabsSignature(entries) {
  return JSON.stringify((entries || []).map((entry) => [entry.id, entry.url, entry.title]));
}

// Remember a window's closed tabs for History > Recently Closed. PRIVATE
// MODE GUARD (history menu): a private window's list is never stored, even
// if its renderer sent one (tabs.js sends an empty list from a private
// window; this is the main-process twin).
function noteClosedTabs(windowId, sender, closedTabs) {
  if (windowId === null) return;
  const before = closedTabsSignature(closedTabsByWindow.get(windowId));
  if (isPrivateWebContents(sender) || !Array.isArray(closedTabs) || !closedTabs.length) {
    closedTabsByWindow.delete(windowId);
  } else {
    closedTabsByWindow.set(
      windowId,
      closedTabs
        .filter((entry) => entry && typeof entry.url === 'string')
        .map(({ id, url, title, closedAt }) => ({
          id,
          url,
          title: typeof title === 'string' ? title : '',
          closedAt,
        }))
    );
  }
  if (closedTabsSignature(closedTabsByWindow.get(windowId)) !== before) {
    scheduleHistoryMenuRefresh();
  }
}

// Receive tab state updates from the renderer and apply to menu items immediately
ipcMain.on('menu:update-tab-state', (event, state) => {
  if (!state || typeof state !== 'object') return;
  const windowId = windowIdForSender(event?.sender);
  noteClosedTabs(windowId, event?.sender, state.closedTabs);
  lastTabState = state;
  if (windowId !== null) tabStateByWindow.set(windowId, state);
  // Only the window the menu acts on drives the enabled state; a background
  // window's push (a page finishing loading there) is kept for when it gets
  // focus.
  const target = getTargetWindow();
  if (windowId === null || !target || target.id === windowId) {
    applyTabState(state);
  }
});

// ── History menu refresh ────────────────────────────────────────────────
//
// The Recently Visited / Recently Closed rows are part of the template, so
// a change means a menu rebuild. Rebuilds are debounced (a page load can
// record several visits in a burst), skipped when the rows would come out
// the same, and held while the History menu is open so it never changes
// under the pointer.
const HISTORY_MENU_REFRESH_DELAY_MS = 250;
let historyRefreshTimer = null;
let historyRefreshPending = false;
let historySubmenuOpen = false;
let lastHistorySignature = null;
let historyMenuStopped = false;

function scheduleHistoryMenuRefresh() {
  if (historyMenuStopped || historyRefreshTimer) return;
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null;
    refreshHistoryMenu();
  }, HISTORY_MENU_REFRESH_DELAY_MS);
  historyRefreshTimer.unref?.();
}

// Called by the quit path before it closes windows and the history
// database: drops a pending refresh and ignores later triggers (a window's
// 'closed' event, a late history write), so no timer can fire after
// closeDb() and reopen history.sqlite, or rebuild the menu, mid-shutdown.
function stopHistoryMenuRefresh() {
  historyMenuStopped = true;
  historyRefreshPending = false;
  if (historyRefreshTimer) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
  }
}

function refreshHistoryMenu() {
  if (historyMenuStopped || !Menu.getApplicationMenu()) return;
  if (historySubmenuOpen) {
    historyRefreshPending = true;
    return;
  }
  let signature;
  try {
    signature = historyMenuSignature(collectHistoryMenuData());
  } catch (err) {
    log.warn('[menu] Could not refresh the History menu:', err?.message || err);
    return;
  }
  if (signature === lastHistorySignature) return;
  setupApplicationMenu();
}

function trackHistorySubmenuOpen(menu) {
  historySubmenuOpen = false;
  const items = Array.isArray(menu?.items) ? menu.items : [];
  const submenu = items.find((item) => item?.label === 'History')?.submenu;
  if (!submenu?.on) return;
  submenu.on('menu-will-show', () => {
    historySubmenuOpen = true;
  });
  submenu.on('menu-will-close', () => {
    historySubmenuOpen = false;
    if (historyRefreshPending) {
      historyRefreshPending = false;
      scheduleHistoryMenuRefresh();
    }
  });
}

// A visit, a removed entry, a cleared history: re-read Recently Visited.
onHistoryChanged(scheduleHistoryMenuRefresh);

function applyTabState(state) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;

  const { tabCount, activeIndex, hasClosedTabs, canGoBack, canGoForward } = state;
  const hasMultipleTabs = tabCount > 1;
  const hasTabs = tabCount > 0;

  const setEnabled = (id, enabled) => {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = enabled;
  };

  setEnabled('reload', hasTabs);
  setEnabled('next-tab', hasMultipleTabs);
  setEnabled('prev-tab', hasMultipleTabs);
  setEnabled('move-tab-right', hasMultipleTabs && activeIndex < tabCount - 1);
  setEnabled('move-tab-left', hasMultipleTabs && activeIndex > 0);
  setEnabled('reopen-closed-tab', hasClosedTabs);
  setEnabled('toggle-devtools', hasTabs);
  setEnabled('history-back', canGoBack === true);
  setEnabled('history-forward', canGoForward === true);
}

// Track fullscreen state changes from any window to update menu label
app.on('browser-window-created', (_event, win) => {
  win.on('enter-full-screen', () => updateFullscreenMenuItem(true));
  win.on('leave-full-screen', () => updateFullscreenMenuItem(false));
  // A closed window's tabs can no longer be reopened (Freedom does not
  // restore windows), so its Recently Closed rows go with it.
  const windowId = win.id;
  win.on('closed', () => {
    tabStateByWindow.delete(windowId);
    if (closedTabsByWindow.delete(windowId)) scheduleHistoryMenuRefresh();
  });
});

// Back/Forward and the tab rows follow the window the user is in.
app.on('browser-window-focus', (_event, win) => {
  const state = win ? tabStateByWindow.get(win.id) : null;
  if (state) applyTabState(state);
});

// Allow renderer to enable/disable the bookmark bar toggle menu item
ipcMain.on('menu:set-bookmark-bar-toggle-enabled', (_event, enabled) => {
  lastBookmarkBarEnabled = enabled;
  if (toggleBookmarkBarMenuItem) {
    toggleBookmarkBarMenuItem.enabled = enabled;
  }
});

// Allow renderer to update the bookmark bar checked state
ipcMain.on('menu:set-bookmark-bar-checked', (_event, checked) => {
  lastBookmarkBarChecked = checked;
  if (toggleBookmarkBarMenuItem) {
    toggleBookmarkBarMenuItem.checked = checked;
  }
});

function updateFullscreenMenuItem(newIsFullScreen) {
  if (isFullScreen !== newIsFullScreen) {
    isFullScreen = newIsFullScreen;
    setupApplicationMenu();
  }
}

module.exports = {
  buildApplicationMenuTemplate,
  historyMenuLabel,
  isHistoryMenuUrl,
  RECENTLY_VISITED_LIMIT,
  RECENTLY_CLOSED_LIMIT,
  HISTORY_LABEL_MAX,
  HISTORY_MENU_REFRESH_DELAY_MS,
  setupApplicationMenu,
  stopHistoryMenuRefresh,
  updateTabMenuItems,
  updateFullscreenMenuItem,
};
