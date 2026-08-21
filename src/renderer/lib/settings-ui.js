// Theme bootstrap and chrome-side reactions to settings:updated broadcasts.
// The settings form itself lives at freedom://settings.

import { pushDebug } from './debug.js';

const electronAPI = window.electronAPI;

let previous = {
  theme: 'system',
  antNodeMode: 'ultraLight',
  enableRadicleIntegration: false,
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
    antNodeMode: settings?.antNodeMode === 'light' ? 'light' : 'ultraLight',
    enableRadicleIntegration: settings?.enableRadicleIntegration === true,
    enableTorIntegration: settings?.enableTorIntegration === true,
  };
  applyTheme(previous.theme);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (previous.theme === 'system') {
      applyTheme('system');
    }
  });
};

const applyAntModeChange = async (nextAntNodeMode) => {
  if (!window.ant?.getStatus) return;

  let registry = null;
  try {
    registry = await window.serviceRegistry?.getRegistry?.();
  } catch {
    // Fall back to restart check below when we can't inspect registry state.
  }

  if (registry?.ant?.mode === 'reused') {
    pushDebug(
      'Swarm light mode setting saved. Using an existing Swarm node, so the change only applies to bundled nodes.'
    );
    return;
  }

  try {
    const { status } = await window.ant.getStatus();
    if (status !== 'running' && status !== 'starting') return;

    pushDebug(
      `Restarting Swarm node to apply ${nextAntNodeMode === 'light' ? 'light' : 'ultra-light'} mode`
    );
    await window.ant.stop();
    await window.ant.start();
  } catch (err) {
    pushDebug(`Failed to restart Swarm node after mode change: ${err.message}`);
  }
};

export const initSettingsEffects = (onSettingsChanged) => {
  window.addEventListener('settings:updated', async (event) => {
    const next = event.detail;
    if (!next) return;

    const prev = previous;
    previous = {
      theme: next.theme || 'system',
      antNodeMode: next.antNodeMode === 'light' ? 'light' : 'ultraLight',
      enableRadicleIntegration: next.enableRadicleIntegration === true,
      enableTorIntegration: next.enableTorIntegration === true,
    };

    if (prev.theme !== previous.theme) {
      applyTheme(previous.theme);
    }

    if (prev.enableRadicleIntegration && !previous.enableRadicleIntegration) {
      window.radicle?.stop?.().catch(() => {});
    }

    if (prev.enableTorIntegration && !previous.enableTorIntegration) {
      window.tor?.stop?.().catch(() => {});
    }

    pushDebug('Settings updated');
    onSettingsChanged?.(next, prev);

    if (prev.antNodeMode !== previous.antNodeMode) {
      await applyAntModeChange(previous.antNodeMode);
    }
  });
};
