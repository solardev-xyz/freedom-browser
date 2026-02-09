const { autoUpdater } = require('electron-updater');
const { app, dialog, ipcMain } = require('electron');
const log = require('./logger');
const path = require('path');
const { loadSettings } = require('./settings-store');

// IPC handler for restart and install
ipcMain.on('update:restart-and-install', () => {
  log.info('[updater] Restart and install requested via IPC');
  autoUpdater.quitAndInstall(false, true);
});

// IPC handler for manual update check
ipcMain.on('update:check', () => {
  log.info('[updater] Manual update check requested via IPC');
  checkForUpdatesManually();
});

// Configure logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Configure updater - auto-download, manual install
autoUpdater.autoDownload = true; // Download automatically in background
autoUpdater.autoInstallOnAppQuit = false; // Only install when user clicks "Install now"

// Set custom User-Agent header
const userAgent = `Freedom/${app.getVersion()} (${process.platform}; ${process.arch}) Electron/${process.versions.electron} updater`;
autoUpdater.requestHeaders = { 'User-Agent': userAgent };
log.info('[updater] User-Agent:', userAgent);

// Enable dev update config for testing
if (process.env.NODE_ENV === 'development' || process.env.ENABLE_DEV_UPDATER) {
  const appPath = app.getAppPath();
  const devUpdateConfig = path.join(appPath, 'dev-app-update.yml');
  autoUpdater.updateConfigPath = devUpdateConfig;
  autoUpdater.forceDevUpdateConfig = true;

  // Set the feed URL to local test server
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'http://localhost:8765',
  });

  log.info('[updater] Dev mode: Using local update config at', devUpdateConfig);
  log.info('[updater] Dev mode: Update server at http://localhost:8765');
}

let updateCheckInProgress = false;
let mainWindow = null;
let updateDownloaded = false;
let menuUpdateCallback = null;
let isManualCheck = false;

function setMainWindow(window) {
  mainWindow = window;
}

function isUpdateCheckEnabled() {
  const settings = loadSettings();
  return settings.autoUpdate !== false;
}

function checkForUpdates() {
  if (!isUpdateCheckEnabled()) {
    log.info('[updater] Auto-update is disabled');
    return;
  }

  if (updateCheckInProgress) {
    log.info('[updater] Update check already in progress');
    return;
  }

  // Allow testing in development with ENABLE_DEV_UPDATER=true
  if (process.env.NODE_ENV === 'development' && !process.env.ENABLE_DEV_UPDATER) {
    log.info('[updater] Skipping update check in development mode');
    return;
  }

  updateCheckInProgress = true;
  log.info('[updater] Checking for updates...');
  autoUpdater.checkForUpdates().catch((_err) => {
    // Error is already handled by the 'error' event, this just prevents unhandled rejection
  });
}

// Event: Update available
autoUpdater.on('update-available', (info) => {
  updateCheckInProgress = false;
  isManualCheck = false;
  log.info('[updater] Update available:', info.version);
  // Download happens automatically (autoDownload = true)
  log.info('[updater] Downloading update in background...');
});

// Event: Update not available
autoUpdater.on('update-not-available', () => {
  updateCheckInProgress = false;
  log.info('[updater] No updates available');

  // Only show notification for manual checks
  if (isManualCheck && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('show-update-notification', {
      type: 'up-to-date',
      message: 'Freedom is up to date',
    });
  }
  isManualCheck = false;
});

// Event: Download progress
autoUpdater.on('download-progress', (progressObj) => {
  const message = `Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}%`;
  log.info('[updater]', message);

  if (mainWindow) {
    mainWindow.webContents.send('update-progress', progressObj.percent);
  }
});

// Event: Update downloaded
autoUpdater.on('update-downloaded', (info) => {
  log.info('[updater] Update downloaded:', info.version);
  updateDownloaded = true;

  // Update the application menu to show "Install Update..."
  if (menuUpdateCallback) {
    log.info('[updater] Updating application menu...');
    menuUpdateCallback();
  }

  // Show in-app notification via renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('show-update-notification', {
      type: 'ready',
      version: info.version,
      message: `Update v${info.version} ready to install`,
    });
  }

  // Update will install automatically on next quit (autoInstallOnAppQuit = true)
  log.info('[updater] Update ready - will install on next quit');
});

// Event: Error
autoUpdater.on('error', (error) => {
  updateCheckInProgress = false;
  isManualCheck = false;
  log.error('[updater] Error:', error);

  // Don't show error dialog for expected/recoverable issues
  if (error.message) {
    if (error.message.includes('net::')) {
      log.info('[updater] Network error, will try again later');
      return;
    }
    if (error.message.includes('ENOENT') && error.message.includes('app-update.yml')) {
      log.info('[updater] Update config not found, skipping auto-update');
      return;
    }
  }
});

// Initialize updater
function initUpdater(window, onMenuUpdate) {
  setMainWindow(window);
  menuUpdateCallback = onMenuUpdate;

  // Check for updates 10 seconds after app start
  setTimeout(() => {
    checkForUpdates();
  }, 10000);

  // Check for updates every 6 hours
  setInterval(
    () => {
      checkForUpdates();
    },
    6 * 60 * 60 * 1000
  );
}

// Manual update check (from menu)
function checkForUpdatesManually() {
  if (process.env.NODE_ENV === 'development' && !process.env.ENABLE_DEV_UPDATER) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Updates Disabled',
      message: 'Auto-update is disabled in development mode. Set ENABLE_DEV_UPDATER=true to test.',
    });
    return;
  }

  if (!isUpdateCheckEnabled()) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Updates Disabled',
      message: 'Auto-update is disabled in settings. Enable it to receive updates automatically.',
    });
    return;
  }

  isManualCheck = true;
  checkForUpdates();
}

// Check if update is ready to install
function isUpdateReady() {
  return updateDownloaded;
}

// Manually trigger install
function installUpdate() {
  if (updateDownloaded) {
    log.info('[updater] Manually triggering update install');
    autoUpdater.quitAndInstall(false, true);
  }
}

module.exports = {
  initUpdater,
  checkForUpdates: checkForUpdatesManually,
  isUpdateReady,
  installUpdate,
};
