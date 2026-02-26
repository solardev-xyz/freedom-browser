const log = require('./logger');
const { BrowserWindow, Menu, app, ipcMain } = require('electron');
const { isMainBrowserWindow, getMainWindows, createMainWindow } = require('./windows/mainWindow');
const { checkForUpdates, isUpdateReady, installUpdate } = require('./updater');

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

let newTabMenuItem = null;
let closeTabMenuItem = null;
let toggleBookmarkBarMenuItem = null;
let isFullScreen = false;


function updateTabMenuItems() {
  const hasWindows = BrowserWindow.getAllWindows().length > 0;
  if (newTabMenuItem) newTabMenuItem.enabled = hasWindows;
  if (closeTabMenuItem) closeTabMenuItem.enabled = hasWindows;
}

function setupApplicationMenu() {
  const updateReady = isUpdateReady();

  const updateMenuItems = updateReady
    ? [
        {
          label: 'Install Update and Restart...',
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

  const template = [
    {
      role: 'appMenu',
      submenu: [
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
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          id: 'new-tab',
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
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
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const mainWindows = getMainWindows();

            // Find a main browser window that is focused
            const focusedMainWindow = mainWindows.find((win) => win.isFocused());

            if (focusedMainWindow) {
              focusedMainWindow.webContents.send('tab:close');
            }
            // If no main window is focused (DevTools has focus), do nothing.
            // User can close DevTools with the X button or Cmd+Option+I
          },
        },
        ...(process.platform !== 'darwin'
          ? [
              {
                label: 'Close Tab',
                accelerator: 'Ctrl+F4',
                click: () => {
                  const win = getTargetWindow();
                  if (win) {
                    win.webContents.send('tab:close');
                  }
                },
              },
            ]
          : []),
        {
          id: 'reopen-closed-tab',
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
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
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            log.info('[menu] New Window clicked');
            createMainWindow();
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'reload',
          label: 'Reload This Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const win = getTargetWindow();
            if (win) {
              win.webContents.send('page:reload');
            }
          },
        },
        {
          label: 'Force Reload This Page',
          accelerator: 'CmdOrCtrl+Shift+R',
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
          accelerator: 'CmdOrCtrl+L',
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
          label: isFullScreen ? 'Exit Full Screen' : 'Enter Full Screen',
          accelerator: 'F11',
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
          accelerator: 'Ctrl+PageDown',
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
          accelerator: 'Ctrl+PageUp',
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
          accelerator: 'Ctrl+Shift+PageDown',
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
          accelerator: 'Ctrl+Shift+PageUp',
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
          accelerator: 'CmdOrCtrl+Shift+B',
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
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => {
            const win = getTargetWindow();
            if (win) {
              win.webContents.send('devtools:toggle');
            }
          },
        },
        ...(!app.isPackaged
          ? [
              {
                id: 'toggle-app-devtools',
                label: 'App Developer Tools',
                accelerator: 'CmdOrCtrl+Shift+Alt+I',
                click: () => {
                  const win = getTargetWindow();
                  if (win) {
                    win.webContents.toggleDevTools();
                  }
                },
              },
            ]
          : []),
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Show All History',
          accelerator: process.platform === 'darwin' ? 'Cmd+Y' : 'Ctrl+H',
          click: () => {
            const win = getTargetWindow();
            if (win) {
              win.webContents.send('tab:new-with-url', 'freedom://history');
            }
          },
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
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
}

// Receive tab state updates from the renderer and apply to menu items immediately
ipcMain.on('menu:update-tab-state', (_event, state) => {
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
});

// Track fullscreen state changes from any window to update menu label
app.on('browser-window-created', (_event, win) => {
  win.on('enter-full-screen', () => updateFullscreenMenuItem(true));
  win.on('leave-full-screen', () => updateFullscreenMenuItem(false));
});

// Allow renderer to enable/disable the bookmark bar toggle menu item
ipcMain.on('menu:set-bookmark-bar-toggle-enabled', (_event, enabled) => {
  if (toggleBookmarkBarMenuItem) {
    toggleBookmarkBarMenuItem.enabled = enabled;
  }
});

// Allow renderer to update the bookmark bar checked state
ipcMain.on('menu:set-bookmark-bar-checked', (_event, checked) => {
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
  setupApplicationMenu,
  updateTabMenuItems,
  updateFullscreenMenuItem,
};
