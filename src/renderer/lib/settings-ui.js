// Theme bootstrap and chrome-side reactions to settings:updated broadcasts.
// The settings form itself lives at freedom://settings.

import { pushDebug } from './debug.js';

const electronAPI = window.electronAPI;

let previous = { theme: 'system', beeNodeMode: 'ultraLight', enableRadicleIntegration: false };

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
    beeNodeMode: settings?.beeNodeMode === 'light' ? 'light' : 'ultraLight',
    enableRadicleIntegration: settings?.enableRadicleIntegration === true,
  };
  applyTheme(previous.theme);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (previous.theme === 'system') {
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
    // Fall back to restart check below when we can't inspect registry state.
  }

  if (registry?.bee?.mode === 'reused') {
    pushDebug(
      'Swarm light mode setting saved. Using an existing Swarm node, so the change only applies to bundled nodes.'
    );
    return;
  }

  try {
    const { status } = await window.bee.getStatus();
    if (status !== 'running' && status !== 'starting') return;

    pushDebug(
      `Restarting Swarm node to apply ${nextBeeNodeMode === 'light' ? 'light' : 'ultra-light'} mode`
    );
    await window.bee.stop();
    await window.bee.start();
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
      beeNodeMode: next.beeNodeMode === 'light' ? 'light' : 'ultraLight',
      enableRadicleIntegration: next.enableRadicleIntegration === true,
    };

    if (prev.theme !== previous.theme) {
      applyTheme(previous.theme);
    }

    if (prev.enableRadicleIntegration && !previous.enableRadicleIntegration) {
      window.radicle?.stop?.().catch(() => {});
    }

    pushDebug('Settings updated');
    onSettingsChanged?.();

    if (prev.beeNodeMode !== previous.beeNodeMode) {
      await applyBeeModeChange(previous.beeNodeMode);
    }
  });
};
