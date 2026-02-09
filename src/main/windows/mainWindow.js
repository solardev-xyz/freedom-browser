const log = require('../logger');
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let currentWindowTitle = 'Freedom';

// Track all main browser windows we create
const mainWindows = new Set();

// Get the app icon path (works in both dev and packaged)
function getIconPath() {
  let iconPath;
  if (app.isPackaged) {
    iconPath = path.join(process.resourcesPath, 'assets', 'icon.png');
  } else {
    iconPath = path.join(__dirname, '..', '..', '..', 'assets', 'icon.png');
  }

  // Log icon path for debugging
  const exists = fs.existsSync(iconPath);
  log.info(`[icon] Path: ${iconPath}, exists: ${exists}`);

  return iconPath;
}

function createMainWindow(initialUrl = null) {
  const isMac = process.platform === 'darwin';

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Freedom',
    backgroundColor: '#1f2020',
    // Set icon for Linux/Windows (macOS uses the app bundle icon)
    // Also hide the menu bar on Windows/Linux
    ...(!isMac && {
      icon: getIconPath(),
      autoHideMenuBar: true,
    }),
    // macOS: use hidden inset title bar with custom traffic light position
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 },
    }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      enableRemoteModule: false,
    },
  });

  // Load index.html with optional initial URL as query parameter
  const indexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');
  if (initialUrl) {
    window.loadFile(indexPath, { query: { initialUrl } });
  } else {
    window.loadFile(indexPath);
  }

  // Track this window
  mainWindows.add(window);

  window.on('ready-to-show', () => {
    window.setTitle(currentWindowTitle);
  });

  window.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(currentWindowTitle);
  });

  window.on('closed', () => {
    mainWindows.delete(window);
  });


  // Close renderer menus when window loses focus (e.g., clicking system menu)
  window.on('blur', () => {
    window.webContents.send('menus:close');
  });

  const wc = window.webContents;
  if (wc) {
    wc.on('render-process-gone', (_event, details) => {
      log.error('[render-process-gone]', details);
    });
    wc.on('unresponsive', () => {
      log.warn('[webcontents] renderer became unresponsive');
    });
    wc.on('responsive', () => {
      console.info('[webcontents] renderer responsive again');
    });
  }

  return window;
}

function setWindowTitle(title) {
  currentWindowTitle = title;
}

function getWindowTitle() {
  return currentWindowTitle;
}

// Check if a window is one of our main browser windows
function isMainBrowserWindow(window) {
  return window && mainWindows.has(window);
}

// Get all main browser windows
function getMainWindows() {
  return [...mainWindows];
}

module.exports = {
  createMainWindow,
  setWindowTitle,
  getWindowTitle,
  isMainBrowserWindow,
  getMainWindows,
};
