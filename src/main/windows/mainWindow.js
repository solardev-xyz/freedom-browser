const log = require('../logger');
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadSettings } = require('../settings-store');

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

function createMainWindow(initialUrl = null, options = {}) {
  // Private windows carry their non-persisted partition name; it reaches
  // the renderer as a query parameter (same channel as initialUrl) so
  // tabs.js can stamp it on every webview before first load.
  const privatePartition =
    typeof options.privatePartition === 'string' && options.privatePartition
      ? options.privatePartition
      : null;
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  // Linux only: tab strip doubles as the titlebar when the user opts in.
  // `frame` can't change on a live window, so this is read once at creation.
  const linuxFrameless = isLinux && loadSettings().tabsInTitlebar === true;

  // Headless E2E: keep the window hidden so a local test run doesn't pop a
  // window or steal focus. The renderer still loads and is fully driveable via
  // Playwright (DOM/JS), it just never paints to screen.
  const hideWindow = process.env.FREEDOM_TEST_HIDE_WINDOW === '1';

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Freedom',
    show: !hideWindow,
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
    // Linux: drop the OS frame so the in-app tab strip is the titlebar
    ...(linuxFrameless && { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      enableRemoteModule: false,
    },
  });

  // Load index.html with optional initial URL / private partition as query
  // parameters
  const indexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');
  const query = {};
  if (initialUrl) query.initialUrl = initialUrl;
  if (privatePartition) query.privatePartition = privatePartition;
  if (Object.keys(query).length > 0) {
    window.loadFile(indexPath, { query });
  } else {
    window.loadFile(indexPath);
  }

  // Track this window
  mainWindows.add(window);

  // PRIVATE MODE GUARD (window title): `currentWindowTitle` is the shared
  // last-seen title, and private senders deliberately never seed it. Private
  // windows must not CONSUME it either — otherwise a fresh private window's
  // native title (taskbar / window switcher) advertises whatever page the
  // user last had focused in a NORMAL window, e.g. "mybank - Freedom", until
  // its own renderer sends the first window:set-title. Wrong page attributed
  // to the wrong window, in the most visible chrome there is.
  const titleForThisWindow = () => (privatePartition ? 'Freedom' : currentWindowTitle);

  window.on('ready-to-show', () => {
    window.setTitle(titleForThisWindow());

    // Linux cold start: a freshly-spawned profile process has no valid
    // startup-activation token, so Mutter denies focus to the new window and
    // posts a "'Freedom' is ready" notification instead of raising it. Nudge
    // focus with the always-on-top toggle, which bypasses focus-stealing
    // prevention. Skip the headless test path, which deliberately stays hidden.
    if (isLinux && !hideWindow) {
      window.setAlwaysOnTop(true);
      window.focus();
      window.setAlwaysOnTop(false);
    }
  });

  window.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(titleForThisWindow());
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

function focusBrowserWindow(window) {
  if (!window || window.isDestroyed()) {
    return false;
  }

  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }

  try {
    if (process.platform === 'darwin' && app.focus) {
      app.focus({ steal: true });
    } else if (process.platform === 'win32') {
      // Windows foreground-stealing prevention ignores focus() from a
      // process that isn't already foreground (the cross-profile switch
      // case). Briefly toggling always-on-top raises and activates the
      // window without permanently changing its z-order.
      window.setAlwaysOnTop(true);
      window.focus();
      window.setAlwaysOnTop(false);
      if (!window.isFocused()) {
        window.flashFrame(true);
        window.once('focus', () => window.flashFrame(false));
      }
    }
  } catch {
    // Best-effort only; BrowserWindow.focus() below is the real fallback.
  }

  window.focus();
  return true;
}

function focusOrCreateMainWindow(initialUrl = null) {
  let window = [...mainWindows].find((candidate) => !candidate.isDestroyed());
  if (!window) {
    window = createMainWindow(initialUrl);
  } else if (initialUrl) {
    // A window already exists, so createMainWindow's initialUrl path doesn't
    // run — open the target in a new tab on the existing window instead (e.g.
    // the Profiles manager's edit button focusing an already-running profile).
    window.webContents.send('tab:new-with-url', initialUrl);
  }
  focusBrowserWindow(window);
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
  focusOrCreateMainWindow,
  setWindowTitle,
  getWindowTitle,
  isMainBrowserWindow,
  getMainWindows,
};
