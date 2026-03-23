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
let enableBeeLightModeCheckbox = null;
let enableRadicleIntegrationCheckbox = null;
let startRadicleRow = null;
let startRadicleAtLaunchCheckbox = null;
let enableIdentityWalletCheckbox = null;
let autoUpdateCheckbox = null;
let experimentalSection = null;
let isWindows = false;

// Current theme mode setting
let currentThemeMode = 'system';
let currentBeeNodeMode = 'ultraLight';
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
  currentBeeNodeMode = settings?.beeNodeMode === 'light' ? 'light' : 'ultraLight';
  currentRadicleIntegrationEnabled = settings?.enableRadicleIntegration === true;
  applyTheme(currentThemeMode);

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemeMode === 'system') {
      applyTheme('system');
    }
  });
};

const applyBeeModeChange = async (nextBeeNodeMode) => {
  if (!window.bee?.getStatus) return;

  let registry = null;
  try {
    registry = await window.serviceRegistry?.getRegistry?.();
  } catch {
    // Fall back to restarting the bundled node if we can't inspect registry state.
  }

  if (registry?.bee?.mode === 'reused') {
    pushDebug(
      'Swarm light mode setting saved. Using an existing Swarm node, so the change only applies to bundled nodes.'
    );
    return;
  }

  try {
    const { status } = await window.bee.getStatus();
    if (status !== 'running' && status !== 'starting') {
      return;
    }

    pushDebug(
      `Restarting Swarm node to apply ${nextBeeNodeMode === 'light' ? 'light' : 'ultra-light'} mode`
    );
    await window.bee.stop();
    await window.bee.start();
  } catch (err) {
    pushDebug(`Failed to restart Swarm node after mode change: ${err.message}`);
  }
};

// Save current settings state
const saveSettings = async () => {
  const previousBeeNodeMode = currentBeeNodeMode;
  const wasRadicleIntegrationEnabled = currentRadicleIntegrationEnabled;
  const newSettings = {
    theme: themeModeSelect?.value || 'system',
    beeNodeMode: enableBeeLightModeCheckbox?.checked ? 'light' : 'ultraLight',
    startBeeAtLaunch: startBeeAtLaunchCheckbox?.checked ?? true,
    startIpfsAtLaunch: startIpfsAtLaunchCheckbox?.checked ?? true,
    enableRadicleIntegration: isWindows ? false : (enableRadicleIntegrationCheckbox?.checked ?? false),
    startRadicleAtLaunch: isWindows ? false : (startRadicleAtLaunchCheckbox?.checked ?? false),
    enableIdentityWallet: enableIdentityWalletCheckbox?.checked ?? false,
    autoUpdate: autoUpdateCheckbox?.checked ?? true,
  };

  const success = await electronAPI.saveSettings(newSettings);
  if (success) {
    if (wasRadicleIntegrationEnabled && !newSettings.enableRadicleIntegration) {
      window.radicle?.stop?.().catch(() => {});
    }
    pushDebug('Settings saved');
    currentThemeMode = newSettings.theme;
    currentBeeNodeMode = newSettings.beeNodeMode;
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
    if (previousBeeNodeMode !== newSettings.beeNodeMode) {
      await applyBeeModeChange(newSettings.beeNodeMode);
    }
  } else {
    pushDebug('Failed to save settings');
  }
};

export const initSettings = async () => {
  // Initialize DOM elements
  settingsBtn = document.getElementById('settings-btn');
  settingsModal = document.getElementById('settings-modal');
  closeSettingsBtn = document.getElementById('close-settings');
  themeModeSelect = document.getElementById('theme-mode');
  startBeeAtLaunchCheckbox = document.getElementById('start-bee-at-launch');
  startIpfsAtLaunchCheckbox = document.getElementById('start-ipfs-at-launch');
  enableBeeLightModeCheckbox = document.getElementById('enable-bee-light-mode');
  enableRadicleIntegrationCheckbox = document.getElementById('enable-radicle-integration');
  startRadicleRow = document.getElementById('start-radicle-row');
  startRadicleAtLaunchCheckbox = document.getElementById('start-radicle-at-launch');
  enableIdentityWalletCheckbox = document.getElementById('enable-identity-wallet');
  autoUpdateCheckbox = document.getElementById('auto-update');
  experimentalSection = document.getElementById('experimental-section');

  // No official Radicle binaries for Windows yet — hide the section entirely
  const platform = await electronAPI.getPlatform();
  isWindows = platform === 'win32';
  if (isWindows && experimentalSection) {
    experimentalSection.style.display = 'none';
  }

  // Auto-save on any setting change
  themeModeSelect?.addEventListener('change', saveSettings);
  startBeeAtLaunchCheckbox?.addEventListener('change', saveSettings);
  startIpfsAtLaunchCheckbox?.addEventListener('change', saveSettings);
  enableBeeLightModeCheckbox?.addEventListener('change', saveSettings);
  enableRadicleIntegrationCheckbox?.addEventListener('change', () => {
    updateRadicleSettingsVisibility();
    saveSettings();
  });
  startRadicleAtLaunchCheckbox?.addEventListener('change', saveSettings);
  enableIdentityWalletCheckbox?.addEventListener('change', saveSettings);
  autoUpdateCheckbox?.addEventListener('change', saveSettings);
  window.addEventListener('settings:updated', (event) => {
    currentBeeNodeMode = event.detail?.beeNodeMode === 'light' ? 'light' : 'ultraLight';
  });

  settingsBtn?.addEventListener('click', async () => {
    setMenuOpen(false);
    const settings = await electronAPI.getSettings();
    if (settings) {
      if (themeModeSelect) themeModeSelect.value = settings.theme || 'system';
      if (startBeeAtLaunchCheckbox)
        startBeeAtLaunchCheckbox.checked = settings.startBeeAtLaunch !== false;
      if (startIpfsAtLaunchCheckbox)
        startIpfsAtLaunchCheckbox.checked = settings.startIpfsAtLaunch !== false;
      if (enableBeeLightModeCheckbox)
        enableBeeLightModeCheckbox.checked = settings.beeNodeMode === 'light';
      currentBeeNodeMode = settings?.beeNodeMode === 'light' ? 'light' : 'ultraLight';
      if (enableRadicleIntegrationCheckbox)
        enableRadicleIntegrationCheckbox.checked = settings.enableRadicleIntegration === true;
      currentRadicleIntegrationEnabled = settings.enableRadicleIntegration === true;
      if (startRadicleAtLaunchCheckbox)
        startRadicleAtLaunchCheckbox.checked = settings.startRadicleAtLaunch === true;
      if (enableIdentityWalletCheckbox)
        enableIdentityWalletCheckbox.checked = settings.enableIdentityWallet === true;
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
