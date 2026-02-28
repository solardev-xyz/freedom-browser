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
let enableEnsCustomRpcCheckbox = null;
let ensRpcField = null;
let ensRpcUrlInput = null;
let ensRpcTestBtn = null;
let ensRpcStatus = null;

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

// Toggle a dependent field's disabled state based on a checkbox
const setFieldEnabled = (checkbox, field, ...inputs) => {
  const enabled = checkbox?.checked === true;
  field?.classList.toggle('disabled', !enabled);
  for (const input of inputs) {
    if (input) input.disabled = !enabled;
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
    enableEnsCustomRpc: enableEnsCustomRpcCheckbox?.checked ?? false,
    ensRpcUrl: ensRpcUrlInput?.value?.trim() || '',
  };

  const saved = await electronAPI.saveSettings(newSettings);
  if (saved) {
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

// Set ENS RPC status feedback
const setEnsRpcStatus = (text, type) => {
  if (!ensRpcStatus) return;
  ensRpcStatus.textContent = text;
  ensRpcStatus.className = 'field-status' + (type ? ` ${type}` : '');
};

// Test ENS RPC endpoint
const testEnsRpc = async () => {
  const url = ensRpcUrlInput?.value?.trim();
  if (!url) {
    setEnsRpcStatus('Enter a URL to test', 'error');
    return;
  }

  setEnsRpcStatus('Testing...', 'testing');
  if (ensRpcTestBtn) ensRpcTestBtn.disabled = true;

  try {
    const result = await electronAPI.testEnsRpc(url);
    if (result.success) {
      setEnsRpcStatus(`Connected (block #${result.blockNumber})`, 'success');
    } else {
      setEnsRpcStatus(result.error?.message || 'Connection failed', 'error');
    }
  } catch (err) {
    setEnsRpcStatus(err.message || 'Test failed', 'error');
  } finally {
    setFieldEnabled(enableEnsCustomRpcCheckbox, ensRpcField, ensRpcUrlInput, ensRpcTestBtn);
  }
};

// Debounce timer for ENS RPC URL auto-save
let ensRpcSaveTimer = null;

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
  enableEnsCustomRpcCheckbox = document.getElementById('enable-ens-custom-rpc');
  ensRpcField = document.getElementById('ens-rpc-field');
  ensRpcUrlInput = document.getElementById('ens-rpc-url');
  ensRpcTestBtn = document.getElementById('ens-rpc-test');
  ensRpcStatus = document.getElementById('ens-rpc-status');

  // Auto-save on any setting change
  themeModeSelect?.addEventListener('change', saveSettings);
  startBeeAtLaunchCheckbox?.addEventListener('change', saveSettings);
  startIpfsAtLaunchCheckbox?.addEventListener('change', saveSettings);
  enableRadicleIntegrationCheckbox?.addEventListener('change', () => {
    setFieldEnabled(enableRadicleIntegrationCheckbox, startRadicleRow, startRadicleAtLaunchCheckbox);
    saveSettings();
  });
  startRadicleAtLaunchCheckbox?.addEventListener('change', saveSettings);
  autoUpdateCheckbox?.addEventListener('change', saveSettings);

  // ENS RPC toggle
  enableEnsCustomRpcCheckbox?.addEventListener('change', () => {
    setFieldEnabled(enableEnsCustomRpcCheckbox, ensRpcField, ensRpcUrlInput, ensRpcTestBtn);
    saveSettings();
  });

  // ENS RPC: debounced save on input, flush on blur
  ensRpcUrlInput?.addEventListener('input', () => {
    clearTimeout(ensRpcSaveTimer);
    setEnsRpcStatus('', '');
    ensRpcSaveTimer = setTimeout(saveSettings, 800);
  });
  ensRpcUrlInput?.addEventListener('blur', () => {
    if (ensRpcSaveTimer) {
      clearTimeout(ensRpcSaveTimer);
      ensRpcSaveTimer = null;
      saveSettings();
    }
  });
  ensRpcTestBtn?.addEventListener('click', testEnsRpc);

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
      if (enableEnsCustomRpcCheckbox)
        enableEnsCustomRpcCheckbox.checked = settings.enableEnsCustomRpc === true;
      if (ensRpcUrlInput) ensRpcUrlInput.value = settings.ensRpcUrl || '';
      setEnsRpcStatus('', '');
      setFieldEnabled(enableRadicleIntegrationCheckbox, startRadicleRow, startRadicleAtLaunchCheckbox);
      setFieldEnabled(enableEnsCustomRpcCheckbox, ensRpcField, ensRpcUrlInput, ensRpcTestBtn);
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
