// Settings modal UI
import { pushDebug } from './debug.js';
import { setMenuOpen } from './menus.js';

const electronAPI = window.electronAPI;

// DOM elements (initialized in initSettings)
let settingsBtn = null;
let settingsModal = null;
let closeSettingsBtn = null;
let themeModeSelect = null;
let startBeeAtLaunchCheckbox = null;
let startIpfsAtLaunchCheckbox = null;
let enableRadicleIntegrationCheckbox = null;
let startRadicleRow = null;
let startRadicleAtLaunchCheckbox = null;
let autoUpdateCheckbox = null;

// Current theme mode setting
let currentThemeMode = 'system';
let currentRadicleIntegrationEnabled = false;

// Callback for when settings change (set by navigation module)
let onSettingsChanged = null;

export const setOnSettingsChanged = (callback) => {
  onSettingsChanged = callback;
};

// Check if system prefers dark mode
const systemPrefersDark = () => {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const updateRadicleSettingsVisibility = () => {
  const enabled = enableRadicleIntegrationCheckbox?.checked === true;
  startRadicleRow?.classList.toggle('disabled', !enabled);
  if (startRadicleAtLaunchCheckbox) {
    startRadicleAtLaunchCheckbox.disabled = !enabled;
  }
};

// Apply theme to document based on mode
export const applyTheme = (mode) => {
  let isDark;
  if (mode === 'system') {
    isDark = systemPrefersDark();
  } else {
    isDark = mode === 'dark';
  }

  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
  }
};

// Load and apply theme on startup
export const initTheme = async () => {
  const settings = await electronAPI.getSettings();
  currentThemeMode = settings?.theme || 'system';
  currentRadicleIntegrationEnabled = settings?.enableRadicleIntegration === true;
  applyTheme(currentThemeMode);

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemeMode === 'system') {
      applyTheme('system');
    }
  });
};

// Save current settings state
const saveSettings = async () => {
  const wasRadicleIntegrationEnabled = currentRadicleIntegrationEnabled;
  const newSettings = {
    theme: themeModeSelect?.value || 'system',
    startBeeAtLaunch: startBeeAtLaunchCheckbox?.checked ?? true,
    startIpfsAtLaunch: startIpfsAtLaunchCheckbox?.checked ?? true,
    enableRadicleIntegration: enableRadicleIntegrationCheckbox?.checked ?? false,
    startRadicleAtLaunch: startRadicleAtLaunchCheckbox?.checked ?? false,
    autoUpdate: autoUpdateCheckbox?.checked ?? true,
  };

  const success = await electronAPI.saveSettings(newSettings);
  if (success) {
    if (wasRadicleIntegrationEnabled && !newSettings.enableRadicleIntegration) {
      window.radicle?.stop?.().catch(() => {});
    }
    pushDebug('Settings saved');
    currentThemeMode = newSettings.theme;
    currentRadicleIntegrationEnabled = newSettings.enableRadicleIntegration;
    applyTheme(currentThemeMode);
    window.dispatchEvent(
      new CustomEvent('settings:updated', {
        detail: newSettings,
      })
    );
    if (onSettingsChanged) {
      onSettingsChanged();
    }
  } else {
    pushDebug('Failed to save settings');
  }
};

export const initSettings = () => {
  // Initialize DOM elements
  settingsBtn = document.getElementById('settings-btn');
  settingsModal = document.getElementById('settings-modal');
  closeSettingsBtn = document.getElementById('close-settings');
  themeModeSelect = document.getElementById('theme-mode');
  startBeeAtLaunchCheckbox = document.getElementById('start-bee-at-launch');
  startIpfsAtLaunchCheckbox = document.getElementById('start-ipfs-at-launch');
  enableRadicleIntegrationCheckbox = document.getElementById('enable-radicle-integration');
  startRadicleRow = document.getElementById('start-radicle-row');
  startRadicleAtLaunchCheckbox = document.getElementById('start-radicle-at-launch');
  autoUpdateCheckbox = document.getElementById('auto-update');

  // Auto-save on any setting change
  themeModeSelect?.addEventListener('change', saveSettings);
  startBeeAtLaunchCheckbox?.addEventListener('change', saveSettings);
  startIpfsAtLaunchCheckbox?.addEventListener('change', saveSettings);
  enableRadicleIntegrationCheckbox?.addEventListener('change', () => {
    updateRadicleSettingsVisibility();
    saveSettings();
  });
  startRadicleAtLaunchCheckbox?.addEventListener('change', saveSettings);
  autoUpdateCheckbox?.addEventListener('change', saveSettings);

  settingsBtn?.addEventListener('click', async () => {
    setMenuOpen(false);
    const settings = await electronAPI.getSettings();
    if (settings) {
      if (themeModeSelect) themeModeSelect.value = settings.theme || 'system';
      if (startBeeAtLaunchCheckbox)
        startBeeAtLaunchCheckbox.checked = settings.startBeeAtLaunch !== false;
      if (startIpfsAtLaunchCheckbox)
        startIpfsAtLaunchCheckbox.checked = settings.startIpfsAtLaunch !== false;
      if (enableRadicleIntegrationCheckbox)
        enableRadicleIntegrationCheckbox.checked = settings.enableRadicleIntegration === true;
      currentRadicleIntegrationEnabled = settings.enableRadicleIntegration === true;
      if (startRadicleAtLaunchCheckbox)
        startRadicleAtLaunchCheckbox.checked = settings.startRadicleAtLaunch === true;
      if (autoUpdateCheckbox) autoUpdateCheckbox.checked = settings.autoUpdate !== false;
      updateRadicleSettingsVisibility();
    }
    settingsModal?.showModal();
  });

  closeSettingsBtn?.addEventListener('click', () => {
    settingsModal?.close();
  });

  settingsModal?.addEventListener('click', (event) => {
    if (event.target === settingsModal) {
      settingsModal.close();
    }
  });
};
