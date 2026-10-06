const { autoUpdater } = require('electron-updater');
const { app, dialog, ipcMain } = require('electron');
const log = require('./logger');
const path = require('path');
const { loadSettings, onSettingsChanged } = require('./settings-store');
const { getActiveProfile } = require('./profile-resolver');
const { DEFAULT_PROFILE_ID } = require('./profile-catalog');
const {
  releaseUpdaterOwnerLock,
  tryAcquireUpdaterOwnerLock,
} = require('./updater-owner-lock');
const { broadcastToAllWebContents } = require('./lib/broadcast-to-all-webcontents');
const {
  UNSUPPORTED_REASON,
  initialState,
  reduceUpdateState,
  describeUpdateState,
  canCheckForUpdates,
  classifyUpdaterError,
} = require('./update-state');

// Main → renderer broadcast of the update state snapshot (#87), and the
// matching pull for a surface that opens later (a Settings tab, a new window).
const UPDATE_STATE_CHANNEL = 'update:state';
const UPDATE_GET_STATE_CHANNEL = 'update:get-state';

// IPC handler for restart and install
ipcMain.on('update:restart-and-install', () => {
  log.info('[updater] Restart and install requested via IPC');
  installUpdate();
});

// IPC handler for manual update check
ipcMain.on('update:check', () => {
  log.info('[updater] Manual update check requested via IPC');
  checkForUpdatesManually();
});

// Current update state, for a surface that missed the broadcasts.
ipcMain.handle(UPDATE_GET_STATE_CHANNEL, () => getUpdateState());

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
let updaterOwnerLock = null;
// Set by initUpdater when this copy can't update at all (dev checkout,
// unpacked, a Linux package electron-updater can't replace).
let buildUnsupportedReason = null;
let releaseRegistered = false;
let ownershipRetryInterval = null;
let initialUpdateCheckTimeout = null;
let periodicUpdateCheckInterval = null;

// Until initUpdater runs (it never does in E2E test mode) this process isn't
// updating anything, and the state says so instead of offering a dead button.
let updateState = initialState({
  currentVersion: app.getVersion(),
  reason: UNSUPPORTED_REASON.INACTIVE,
});

const UPDATER_OWNERSHIP_RETRY_MS = 30000;
const INITIAL_UPDATE_CHECK_DELAY_MS = 10000;
const PERIODIC_UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

// The snapshot every renderer gets: the reducer state plus the derived copy,
// so the hamburger item and Settings can't word the same state differently.
function getUpdateState() {
  const mode = getInstallRelaunchMode();
  return {
    ...updateState,
    message: describeUpdateState(updateState, { autoCheck: isUpdateCheckEnabled() }),
    canCheck: canCheckForUpdates(updateState),
    installLabel: mode.autoRunAfterInstall ? 'Restart to update' : 'Install update and close',
    // Title case for the hamburger menu, like its other rows.
    menuInstallLabel: mode.autoRunAfterInstall ? 'Restart to Update' : 'Install Update and Close',
    installNote: mode.readyMessage,
  };
}

// The status line depends on the auto-update switch (idle/error wording), so
// flipping it re-broadcasts the snapshot to every open surface.
onSettingsChanged((merged, previous) => {
  if ((merged?.autoUpdate !== false) === (previous?.autoUpdate !== false)) return;
  broadcastToAllWebContents(UPDATE_STATE_CHANNEL, getUpdateState());
});

function dispatchUpdateEvent(event) {
  const next = reduceUpdateState(updateState, event);
  if (next === updateState) return;
  updateState = next;
  broadcastToAllWebContents(UPDATE_STATE_CHANNEL, getUpdateState());
}

function getInstallRelaunchMode(profile = getActiveProfile()) {
  // Named and explicit profile-dir launches cannot rely on Squirrel preserving profile argv.
  const canRelaunchToSameProfile =
    profile?.source === 'catalog' && profile?.id === DEFAULT_PROFILE_ID;

  if (canRelaunchToSameProfile) {
    return {
      autoRunAfterInstall: true,
      actionLabel: 'Install now',
      menuLabel: 'Install Update and Restart…',
      readyMessage: null,
    };
  }

  return {
    autoRunAfterInstall: false,
    actionLabel: 'Install and close',
    menuLabel: 'Install Update and Close…',
    readyMessage:
      'Freedom will close after installing. Reopen this profile from the profile manager when the update finishes.',
  };
}

function quitAndInstallForActiveProfile() {
  const mode = getInstallRelaunchMode();
  autoUpdater.autoRunAppAfterInstall = mode.autoRunAfterInstall;
  log.info('[updater] Installing update', {
    autoRunAppAfterInstall: mode.autoRunAfterInstall,
    profileId: getActiveProfile()?.id,
    profileSource: getActiveProfile()?.source,
  });
  autoUpdater.quitAndInstall(false, mode.autoRunAfterInstall);
}

function hasUpdaterOwnership() {
  return Boolean(updaterOwnerLock && !updaterOwnerLock.released);
}

function acquireUpdaterOwnership(options = {}) {
  if (hasUpdaterOwnership()) {
    return true;
  }

  const profile = options.profile || getActiveProfile();
  updaterOwnerLock = tryAcquireUpdaterOwnerLock(profile, { logger: log });
  if (!updaterOwnerLock) {
    return false;
  }

  if (!releaseRegistered) {
    releaseRegistered = true;
    app.on('will-quit', () => {
      releaseUpdaterOwnerLock(updaterOwnerLock, { logger: log });
      updaterOwnerLock = null;
    });
  }

  log.info('[updater] This profile owns update checks', {
    profileId: profile?.id,
    appRoot: profile?.appRoot,
  });
  return true;
}

function clearUpdaterTimers() {
  if (ownershipRetryInterval) {
    clearInterval(ownershipRetryInterval);
    ownershipRetryInterval = null;
  }
  if (initialUpdateCheckTimeout) {
    clearTimeout(initialUpdateCheckTimeout);
    initialUpdateCheckTimeout = null;
  }
  if (periodicUpdateCheckInterval) {
    clearInterval(periodicUpdateCheckInterval);
    periodicUpdateCheckInterval = null;
  }
}

function ensureUpdaterCleanupRegistered() {
  if (releaseRegistered) {
    return;
  }

  releaseRegistered = true;
  app.on('will-quit', () => {
    clearUpdaterTimers();
    releaseUpdaterOwnerLock(updaterOwnerLock, { logger: log });
    updaterOwnerLock = null;
  });
}

function scheduleOwnedUpdateChecks() {
  if (initialUpdateCheckTimeout || periodicUpdateCheckInterval) {
    return;
  }

  // Check for updates 10 seconds after this process becomes updater owner.
  initialUpdateCheckTimeout = setTimeout(() => {
    initialUpdateCheckTimeout = null;
    checkForUpdates();
  }, INITIAL_UPDATE_CHECK_DELAY_MS);

  // Check for updates every 6 hours while this process owns updates.
  periodicUpdateCheckInterval = setInterval(
    () => {
      checkForUpdates();
    },
    PERIODIC_UPDATE_CHECK_MS
  );
}

function scheduleOwnershipRetry(options = {}) {
  if (ownershipRetryInterval) {
    return;
  }

  const retryMs = options.ownershipRetryMs || UPDATER_OWNERSHIP_RETRY_MS;
  ownershipRetryInterval = setInterval(() => {
    if (!acquireUpdaterOwnership(options)) {
      return;
    }

    clearInterval(ownershipRetryInterval);
    ownershipRetryInterval = null;
    markUpdaterSupported();
    scheduleOwnedUpdateChecks();
  }, retryMs);
}

function setMainWindow(window) {
  mainWindow = window;
}

function isUpdateCheckEnabled() {
  const settings = loadSettings();
  return settings.autoUpdate !== false;
}

// `manual`: the user asked (menu, Settings → Check now). The "Automatically
// check for updates" switch only governs the background checks.
function checkForUpdates({ manual = false } = {}) {
  if (!hasUpdaterOwnership()) {
    log.info('[updater] Skipping update check; another profile owns updater');
    return;
  }

  if (!manual && !isUpdateCheckEnabled()) {
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
  dispatchUpdateEvent({ type: 'checking' });
  autoUpdater
    .checkForUpdates()
    .then((result) => {
      // electron-updater answers null, with no event at all, when it can't
      // update this copy (unpacked, or a Linux build that isn't an AppImage
      // or a deb/pacman install) — without this the state would sit on
      // "Checking…" forever.
      if (result == null) {
        updateCheckInProgress = false;
        isManualCheck = false;
        dispatchUpdateEvent({ type: 'unsupported', reason: UNSUPPORTED_REASON.BUILD });
      }
    })
    .catch((_err) => {
      // Error is already handled by the 'error' event, this just prevents unhandled rejection
    });
}

autoUpdater.on('checking-for-update', () => {
  dispatchUpdateEvent({ type: 'checking' });
});

// Event: Update available
autoUpdater.on('update-available', (info) => {
  updateCheckInProgress = false;
  isManualCheck = false;
  log.info('[updater] Update available:', info.version);
  dispatchUpdateEvent({ type: 'available', version: info?.version });
  // Download happens automatically (autoDownload = true)
  log.info('[updater] Downloading update in background...');
});

// Event: Update not available
autoUpdater.on('update-not-available', () => {
  updateCheckInProgress = false;
  log.info('[updater] No updates available');
  dispatchUpdateEvent({ type: 'not-available' });

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

  dispatchUpdateEvent({
    type: 'progress',
    percent: progressObj?.percent,
    bytesPerSecond: progressObj?.bytesPerSecond,
    transferred: progressObj?.transferred,
    total: progressObj?.total,
  });
});

// Event: Update downloaded
autoUpdater.on('update-downloaded', (info) => {
  log.info('[updater] Update downloaded:', info.version);
  updateDownloaded = true;
  dispatchUpdateEvent({ type: 'downloaded', version: info?.version });
  const installMode = getInstallRelaunchMode();

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
      message: installMode.readyMessage || `Update v${info.version} ready to install`,
      actionLabel: installMode.actionLabel,
    });
  }

  log.info('[updater] Update ready for manual install');
});

// Event: Error
autoUpdater.on('error', (error) => {
  updateCheckInProgress = false;
  isManualCheck = false;
  log.error('[updater] Error:', error);
  dispatchUpdateEvent(classifyUpdaterError(error));

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
function initUpdater(window, onMenuUpdate, options = {}) {
  setMainWindow(window);
  menuUpdateCallback = onMenuUpdate;
  ensureUpdaterCleanupRegistered();

  // Say up front when this copy can't update, rather than letting the first
  // check discover it 10s later (or never, for the silent null answer).
  buildUnsupportedReason = detectBuildUnsupportedReason();
  if (buildUnsupportedReason) {
    dispatchUpdateEvent({ type: 'unsupported', reason: buildUnsupportedReason });
  }

  if (!acquireUpdaterOwnership(options)) {
    log.info('[updater] Update checks disabled in this profile process');
    if (!buildUnsupportedReason) {
      dispatchUpdateEvent({ type: 'unsupported', reason: UNSUPPORTED_REASON.NOT_OWNER });
    }
    scheduleOwnershipRetry(options);
    return false;
  }

  markUpdaterSupported();
  scheduleOwnedUpdateChecks();
  return true;
}

function detectBuildUnsupportedReason() {
  if (isDevModeWithoutUpdater()) return UNSUPPORTED_REASON.DEVELOPMENT;
  try {
    if (typeof autoUpdater.isUpdaterActive === 'function' && !autoUpdater.isUpdaterActive()) {
      return UNSUPPORTED_REASON.BUILD;
    }
  } catch {
    return UNSUPPORTED_REASON.BUILD;
  }
  return null;
}

// This process owns updates; idle unless the build itself can't update.
function markUpdaterSupported() {
  if (!buildUnsupportedReason) dispatchUpdateEvent({ type: 'supported' });
}

function isDevModeWithoutUpdater() {
  return process.env.NODE_ENV === 'development' && !process.env.ENABLE_DEV_UPDATER;
}

// Manual update check (from menu)
function checkForUpdatesManually() {
  // E2E: record the request instead of reaching for the network or a native
  // dialog (installed by test-harness.js in test mode only).
  if (typeof globalThis.__FREEDOM_TEST_UPDATER__?.record === 'function') {
    globalThis.__FREEDOM_TEST_UPDATER__.record('check');
    return;
  }

  if (!hasUpdaterOwnership()) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Updates Managed Elsewhere',
      message: 'Another open Freedom profile is already handling update checks.',
    });
    return;
  }

  if (isDevModeWithoutUpdater()) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Updates Disabled',
      message: 'Auto-update is disabled in development mode. Set ENABLE_DEV_UPDATER=true to test.',
    });
    return;
  }

  isManualCheck = true;
  checkForUpdates({ manual: true });
}

// Check if update is ready to install
function isUpdateReady() {
  return updateDownloaded;
}

// Manually trigger install
function installUpdate() {
  if (typeof globalThis.__FREEDOM_TEST_UPDATER__?.record === 'function') {
    globalThis.__FREEDOM_TEST_UPDATER__.record('install');
    return;
  }
  if (updateDownloaded) {
    log.info('[updater] Manually triggering update install');
    quitAndInstallForActiveProfile();
  }
}

module.exports = {
  initUpdater,
  checkForUpdates: checkForUpdatesManually,
  isUpdateReady,
  installUpdate,
  hasUpdaterOwnership,
  getInstallRelaunchMode,
  getUpdateState,
  // E2E harness only (test-harness.js): drive the real state machine through
  // the same entry point electron-updater's events use.
  dispatchUpdateEvent,
  UPDATE_STATE_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATER_OWNERSHIP_RETRY_MS,
};
