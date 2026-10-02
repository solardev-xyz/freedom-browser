// Theme bootstrap and chrome-side reactions to settings:updated broadcasts.
// The settings form itself lives at freedom://settings.

import { pushDebug } from './debug.js';

const electronAPI = window.electronAPI;

let previous = {
  theme: 'system',
  enableTorIntegration: false,
};

const systemPrefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export const applyTheme = (mode) => {
  const isDark = mode === 'system' ? systemPrefersDark() : mode === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
  }
};

export const initTheme = async () => {
  const settings = await electronAPI.getSettings();
  previous = {
    theme: settings?.theme || 'system',
    enableTorIntegration: settings?.enableTorIntegration === true,
  };
  applyTheme(previous.theme);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (previous.theme === 'system') {
      applyTheme('system');
    }
  });
};

export const initSettingsEffects = (onSettingsChanged) => {
  window.addEventListener('settings:updated', (event) => {
    const next = event.detail;
    if (!next) return;

    const prev = previous;
    previous = {
      theme: next.theme || 'system',
      enableTorIntegration: next.enableTorIntegration === true,
    };

    if (prev.theme !== previous.theme) {
      applyTheme(previous.theme);
    }

    if (prev.enableTorIntegration && !previous.enableTorIntegration) {
      window.tor?.stop?.().catch(() => {});
    }

    pushDebug('Settings updated');
    onSettingsChanged?.(next, prev);
  });
};
