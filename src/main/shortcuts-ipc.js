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
  isShortcutActive,
  formatAccelerator,
} = require('../shared/shortcuts');
const { loadSettings, saveSettings, getRevertedShortcutOverrides } = require('./settings-store');
const { registerTabSwitchKeysIpc } = require('./tab-switch-keys');

const getOverrides = () => loadSettings()?.shortcutOverrides || {};
// AI shortcuts (Show Agent, Start dictation) only exist while AI is on.
const getFeatures = () => ({ aiEnabled: loadSettings()?.enableAi === true });

// Full render model for the settings page.
function getShortcutState(platform = process.platform) {
  const overrides = getOverrides();
  const features = getFeatures();
  // Remaps the store had to revert because another entry's default or fixed
  // alias claimed the chord — at load (a newer release's default) or on a
  // save (Reset handing a default back). Shown on the row so the change is
  // visible rather than silent.
  const reverted = getRevertedShortcutOverrides() || {};
  const entries = SHORTCUTS.map((entry) => {
    const defaultAccelerator = getDefaultAccelerator(entry, platform);
    const accelerator = getEffectiveAccelerator(entry, overrides, platform);
    return {
      id: entry.id,
      description: entry.description,
      settingsLabel: entry.settingsLabel || entry.description,
      category: entry.category,
      context: entry.context,
      editable: entry.editable !== false,
      warnOnEdit: entry.warnOnEdit === true,
      // Dev-only entries (App Developer Tools) have no menu item in
      // packaged builds, and AI entries do nothing while AI is off — don't
      // list a shortcut that doesn't exist.
      hidden: (entry.devOnly === true && app.isPackaged === true) || !isShortcutActive(entry, features),
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
      reverted: reverted[entry.id]
        ? {
            formatted: formatAccelerator(reverted[entry.id].accelerator, platform),
            conflict: reverted[entry.id].conflict,
          }
        : null,
    };
  });
  return { platform, entries };
}

// Turn a captured keydown (recording mode) into a validated candidate
// binding, including conflict info so the UI can offer a swap.
function previewBinding({ id, event } = {}, platform = process.platform) {
  const entry = getShortcutById(id);
  const features = getFeatures();
  if (!entry || !isShortcutActive(entry, features)) return { ok: false, reason: 'unknown-shortcut' };

  const accelerator = acceleratorFromEvent(event, platform);
  // Only modifiers held so far — the UI keeps listening.
  if (!accelerator) return { ok: false, reason: 'incomplete' };

  const validity = validateBinding(entry, accelerator, platform);
  if (!validity.ok) return { ok: false, reason: validity.reason, accelerator };

  const overrides = getOverrides();
  const conflict = findConflict(entry, accelerator, overrides, platform, features);
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
  const features = getFeatures();
  if (!entry || !isShortcutActive(entry, features)) return { ok: false, reason: 'unknown-shortcut' };

  const validity = validateBinding(entry, accelerator, platform);
  if (!validity.ok) return { ok: false, reason: validity.reason };

  const overrides = { ...getOverrides() };
  const normalized = normalizeAccelerator(accelerator, platform);
  const conflict = findConflict(entry, normalized, overrides, platform, features);

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

// Reset one shortcut (id given) or all of them (no id) to defaults. "All"
// means every shortcut the page lists: a remap of an AI shortcut made
// before AI was turned off is kept for when it is turned back on.
function resetOverride({ id } = {}) {
  const overrides = { ...getOverrides() };
  if (id === undefined || id === null) {
    const features = getFeatures();
    const kept = Object.fromEntries(
      Object.entries(overrides).filter(([key]) => !isShortcutActive(key, features))
    );
    const saved = saveSettings({ shortcutOverrides: kept });
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
  registerTabSwitchKeysIpc(ipcMain);
}

module.exports = {
  getShortcutState,
  previewBinding,
  setOverride,
  resetOverride,
  registerShortcutsIpc,
};
