/**
 * Shortcuts IPC — backs the Settings > Shortcuts page.
 *
 * All shortcut logic (registry, accelerator parsing, validation, conflict
 * detection, formatting) lives in src/shared/shortcuts.js and runs here in
 * the main process; the settings page only renders the state it gets back.
 * Overrides persist in the per-profile settings store, whose save path
 * sanitizes them again (defense in depth) and broadcasts SETTINGS_UPDATED —
 * which rebuilds the application menu (menu.js) and refreshes the renderer
 * keydown matcher live.
 */

const { app, ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');
const {
  SHORTCUTS,
  getShortcutById,
  getDefaultAccelerator,
  getAliasAccelerators,
  getEffectiveAccelerator,
  normalizeAccelerator,
  acceleratorFromEvent,
  validateBinding,
  findConflict,
  formatAccelerator,
} = require('../shared/shortcuts');
const { loadSettings, saveSettings } = require('./settings-store');

const getOverrides = () => loadSettings()?.shortcutOverrides || {};

// Full render model for the settings page.
function getShortcutState(platform = process.platform) {
  const overrides = getOverrides();
  const entries = SHORTCUTS.map((entry) => {
    const defaultAccelerator = getDefaultAccelerator(entry, platform);
    const accelerator = getEffectiveAccelerator(entry, overrides, platform);
    return {
      id: entry.id,
      description: entry.description,
      category: entry.category,
      context: entry.context,
      editable: entry.editable !== false,
      warnOnEdit: entry.warnOnEdit === true,
      // Dev-only entries (App Developer Tools) have no menu item in
      // packaged builds — don't list a shortcut that doesn't exist.
      hidden: entry.devOnly === true && app.isPackaged === true,
      accelerator,
      formatted: formatAccelerator(accelerator, platform),
      defaultAccelerator,
      defaultFormatted: formatAccelerator(defaultAccelerator, platform),
      isOverridden:
        normalizeAccelerator(accelerator, platform) !==
        normalizeAccelerator(defaultAccelerator, platform),
      aliases: getAliasAccelerators(entry, platform).map((alias) =>
        formatAccelerator(alias, platform)
      ),
    };
  });
  return { platform, entries };
}

// Turn a captured keydown (recording mode) into a validated candidate
// binding, including conflict info so the UI can offer a swap.
function previewBinding({ id, event } = {}, platform = process.platform) {
  const entry = getShortcutById(id);
  if (!entry) return { ok: false, reason: 'unknown-shortcut' };

  const accelerator = acceleratorFromEvent(event, platform);
  // Only modifiers held so far — the UI keeps listening.
  if (!accelerator) return { ok: false, reason: 'incomplete' };

  const validity = validateBinding(entry, accelerator, platform);
  if (!validity.ok) return { ok: false, reason: validity.reason, accelerator };

  const overrides = getOverrides();
  const conflict = findConflict(entry, accelerator, overrides, platform);
  return {
    ok: true,
    accelerator,
    formatted: formatAccelerator(accelerator, platform),
    conflict: conflict
      ? {
          ...conflict,
          // What the swap would hand the conflicting shortcut: this
          // shortcut's current (pre-remap) binding.
          swapFormatted: formatAccelerator(
            getEffectiveAccelerator(entry, overrides, platform),
            platform
          ),
        }
      : null,
  };
}

// Persist a remap. `swapWithConflict` gives the conflicting shortcut this
// shortcut's previous binding instead of refusing.
function setOverride(
  { id, accelerator, swapWithConflict = false } = {},
  platform = process.platform
) {
  const entry = getShortcutById(id);
  if (!entry) return { ok: false, reason: 'unknown-shortcut' };

  const validity = validateBinding(entry, accelerator, platform);
  if (!validity.ok) return { ok: false, reason: validity.reason };

  const overrides = { ...getOverrides() };
  const normalized = normalizeAccelerator(accelerator, platform);
  const conflict = findConflict(entry, normalized, overrides, platform);

  if (conflict) {
    if (conflict.fixed || !swapWithConflict) {
      return { ok: false, reason: 'conflict', conflict };
    }
    // Swap: the conflicting shortcut inherits this shortcut's previous
    // binding. sanitizeOverrides drops it again if that equals its default.
    const previous = getEffectiveAccelerator(entry, overrides, platform);
    overrides[conflict.id] = normalizeAccelerator(previous, platform);
  }

  overrides[id] = normalized;
  const saved = saveSettings({ shortcutOverrides: overrides });
  return saved ? { ok: true } : { ok: false, reason: 'save-failed' };
}

// Reset one shortcut (id given) or all of them (no id) to defaults.
function resetOverride({ id } = {}) {
  const overrides = { ...getOverrides() };
  if (id === undefined || id === null) {
    const saved = saveSettings({ shortcutOverrides: {} });
    return saved ? { ok: true } : { ok: false, reason: 'save-failed' };
  }
  if (!getShortcutById(id)) return { ok: false, reason: 'unknown-shortcut' };
  delete overrides[id];
  const saved = saveSettings({ shortcutOverrides: overrides });
  return saved ? { ok: true } : { ok: false, reason: 'save-failed' };
}

function registerShortcutsIpc() {
  ipcMain.handle(IPC.SHORTCUTS_GET_STATE, () => getShortcutState());
  ipcMain.handle(IPC.SHORTCUTS_PREVIEW_BINDING, (_event, payload) => previewBinding(payload));
  ipcMain.handle(IPC.SHORTCUTS_SET_OVERRIDE, (_event, payload) => setOverride(payload));
  ipcMain.handle(IPC.SHORTCUTS_RESET, (_event, payload) => resetOverride(payload));
}

module.exports = {
  getShortcutState,
  previewBinding,
  setOverride,
  resetOverride,
  registerShortcutsIpc,
};
