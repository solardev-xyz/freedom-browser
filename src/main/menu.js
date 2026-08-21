const log = require('./logger');
const { BrowserWindow, Menu, app, dialog, ipcMain } = require('electron');
const { isMainBrowserWindow, getMainWindows, createMainWindow } = require('./windows/mainWindow');
const { createPrivateWindow } = require('./private/private-windows');
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
// Only returns main browser windows we created (not DevTools or other system windows)
function getTargetWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && isMainBrowserWindow(focused)) {
    return focused;
  }
  const mainWindows = getMainWindows();
  return mainWindows[0] || null;
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
  }
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
      label: 'Create Profile...',
      click: () => {
        // Open the shared chrome create-modal in the focused window.
        const win = getTargetWindow();
        if (win) {
          win.webContents.send(IPC.PROFILE_SHOW_CREATE_MODAL);
        }
      },
    },
    {
      label: 'Manage Profiles...',
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
    { role: 'close' }
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

function buildHistorySubmenu() {
  return [
    {
      label: 'Show All History',
      accelerator: acc('history.showAll'),
      click: () => {
        const win = getTargetWindow();
        if (win) {
          win.webContents.send('tab:new-with-url', 'freedom://history');
        }
      },
    },
  ];
}

// Find in Page needs a custom click handler (main → renderer IPC), so it
// can't come from a role. The renderer's find-bar module listens on the
// other end and drives the active webview's findInPage().
function buildFindMenuItem() {
  return {
    id: 'find-in-page',
    label: 'Find in Page...',
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
  const { isMac, isFullScreen: fullScreen, isPackaged } = ctx;

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
    { label: 'History', submenu: buildHistorySubmenu() },
    { label: 'Profiles', submenu: buildProfilesSubmenu() },
  ];
}

function buildDarwinMenuTemplate(ctx) {
  return [
    { role: 'appMenu', submenu: buildAppMenuSubmenu(ctx.updateMenuItems) },
    ...buildSharedMenuEntries(ctx),
    { role: 'windowMenu' },
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
} = {}) {
  const ctx = {
    platform,
    updateMenuItems,
    isMac: platform === 'darwin',
    isFullScreen: fullScreen,
    isPackaged,
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
          label: 'Check for Updates...',
          enabled: false,
        },
      ]
    : [
        {
          label: 'Check for Updates...',
          click: () => {
            checkForUpdates();
          },
        },
      ];

  const template = buildApplicationMenuTemplate({
    updateMenuItems,
    isFullScreen,
    isPackaged: app.isPackaged,
  });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

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
  if (lastTabState) applyTabState(lastTabState);
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

// Receive tab state updates from the renderer and apply to menu items immediately
ipcMain.on('menu:update-tab-state', (_event, state) => {
  lastTabState = state;
  applyTabState(state);
});

function applyTabState(state) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;

  const { tabCount, activeIndex, hasClosedTabs } = state;
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
}

// Track fullscreen state changes from any window to update menu label
app.on('browser-window-created', (_event, win) => {
  win.on('enter-full-screen', () => updateFullscreenMenuItem(true));
  win.on('leave-full-screen', () => updateFullscreenMenuItem(false));
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
  setupApplicationMenu,
  updateTabMenuItems,
  updateFullscreenMenuItem,
};
