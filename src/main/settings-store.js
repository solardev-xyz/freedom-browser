const log = require('./logger');
const { app, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');

// Apply theme to nativeTheme so webviews get correct prefers-color-scheme
function applyNativeTheme(theme) {
  if (theme === 'light') {
    nativeTheme.themeSource = 'light';
  } else if (theme === 'dark') {
    nativeTheme.themeSource = 'dark';
  } else {
    nativeTheme.themeSource = 'system';
  }
}

const SETTINGS_FILE = 'settings.json';
const DEFAULT_SETTINGS = {
  theme: 'system',
  enableRadicleIntegration: false,
  startBeeAtLaunch: true,
  startIpfsAtLaunch: true,
  startRadicleAtLaunch: false,
  autoUpdate: true,
  showBookmarkBar: false,
};

let cachedSettings = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function loadSettings() {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const filePath = getSettingsPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      cachedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    } else {
      cachedSettings = { ...DEFAULT_SETTINGS };
    }
  } catch (err) {
    log.error('Failed to load settings:', err);
    cachedSettings = { ...DEFAULT_SETTINGS };
  }

  // Apply theme to nativeTheme
  applyNativeTheme(cachedSettings.theme);

  return cachedSettings;
}

function saveSettings(newSettings) {
  try {
    const merged = { ...loadSettings(), ...newSettings };
    const filePath = getSettingsPath();
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
    cachedSettings = merged;

    // Apply theme if it changed
    if (newSettings.theme) {
      applyNativeTheme(newSettings.theme);
    }

    return true;
  } catch (err) {
    log.error('Failed to save settings:', err);
    return false;
  }
}

function registerSettingsIpc() {
  ipcMain.handle(IPC.SETTINGS_GET, () => {
    return loadSettings();
  });

  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, newSettings) => {
    return saveSettings(newSettings);
  });
}

module.exports = {
  loadSettings,
  saveSettings,
  registerSettingsIpc,
};
