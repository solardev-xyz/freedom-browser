const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');
const IPC = require('../shared/ipc-channels');

// In-memory settings store standing in for src/main/settings-store.js —
// mirrors its contract: saveSettings merges shortcutOverrides (already
// sanitized upstream in the real store; these tests exercise the IPC
// module's own validation).
function loadShortcutsIpc({ platform = 'linux', initialOverrides = {}, reverted = {} } = {}) {
  let settings = { shortcutOverrides: { ...initialOverrides } };
  const saveSettings = jest.fn((patch) => {
    settings = { ...settings, ...patch };
    return true;
  });

  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });

  const loaded = loadMainModule(require.resolve('./shortcuts-ipc'), {
    extraMocks: {
      [require.resolve('./settings-store')]: () => ({
        loadSettings: () => settings,
        saveSettings,
        onSettingsChanged: jest.fn(),
        getRevertedShortcutOverrides: () => reverted,
      }),
    },
  });

  loaded.mod.registerShortcutsIpc();

  return {
    ...loaded,
    saveSettings,
    getSettings: () => settings,
    restorePlatform: () => Object.defineProperty(process, 'platform', { value: originalPlatform }),
  };
}

const recordedKey = (key, code, mods = {}) => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('shortcuts IPC', () => {
  let ctx;

  afterEach(() => {
    ctx?.restorePlatform();
    ctx = null;
  });

  test('get-state returns every registry entry with effective + formatted bindings', async () => {
    ctx = loadShortcutsIpc({ initialOverrides: { 'tab.new': 'Ctrl+Shift+U' } });
    const state = await ctx.ipcMain.invoke(IPC.SHORTCUTS_GET_STATE);

    expect(state.platform).toBe('linux');
    const byId = Object.fromEntries(state.entries.map((entry) => [entry.id, entry]));

    expect(byId['tab.new']).toMatchObject({
      accelerator: 'Ctrl+Shift+U',
      formatted: 'Ctrl+Shift+U',
      defaultAccelerator: 'CmdOrCtrl+T',
      defaultFormatted: 'Ctrl+T',
      isOverridden: true,
      editable: true,
    });
    expect(byId['tab.close']).toMatchObject({
      accelerator: 'CmdOrCtrl+W',
      isOverridden: false,
      warnOnEdit: true,
    });
    expect(byId['tab.next'].aliases).toEqual(['Ctrl+Tab']);
    expect(byId['devtools.toggle'].editable).toBe(false);
    expect(byId['tab.new'].reverted).toBeNull();
  });

  test('get-state surfaces remaps the store reverted as conflicting', async () => {
    // The store drops a stored override whose chord a newer default has
    // taken (e.g. a pre-zoom Ctrl+0 remap) — the settings page has to say so
    // rather than let the binding silently snap back to its default.
    ctx = loadShortcutsIpc({
      reverted: {
        'view.focusAddressBar': {
          accelerator: 'Ctrl+0',
          conflictId: 'page.zoomReset',
          conflict: 'Actual Size',
        },
      },
    });
    const state = await ctx.ipcMain.invoke(IPC.SHORTCUTS_GET_STATE);
    const byId = Object.fromEntries(state.entries.map((entry) => [entry.id, entry]));

    expect(byId['view.focusAddressBar'].reverted).toEqual({
      formatted: 'Ctrl+0',
      conflict: 'Actual Size',
    });
    expect(byId['view.focusAddressBar'].accelerator).toBe('CmdOrCtrl+L');
    expect(byId['page.zoomReset'].reverted).toBeNull();
  });

  test('a Reset that claims a sibling’s chord back shows the notice on its row', async () => {
    // Against the *real* settings store, since this is about what its save
    // path does: the two-click sequence the settings page produces, then
    // Reset. Restoring Reload's default takes Ctrl+R back from New Tab —
    // the row has to say so instead of the remap just vanishing.
    const userDataDir = createTempUserDataDir();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const { mod, ipcMain } = loadMainModule(require.resolve('./shortcuts-ipc'), {
        userDataDir,
        extraMocks: {
          // Undo the in-memory stand-in the other tests register, so this one
          // runs against the store's own sanitize/notice plumbing.
          [require.resolve('./settings-store')]: () => jest.requireActual('./settings-store'),
          [require.resolve('./logger')]: () => ({ error: jest.fn(), warn: jest.fn() }),
        },
      });
      mod.registerShortcutsIpc();

      await expect(
        ipcMain.invoke(IPC.SHORTCUTS_SET_OVERRIDE, {
          id: 'page.reload',
          accelerator: 'Ctrl+Shift+U',
        })
      ).resolves.toEqual({ ok: true });
      await expect(
        ipcMain.invoke(IPC.SHORTCUTS_SET_OVERRIDE, { id: 'tab.new', accelerator: 'Ctrl+R' })
      ).resolves.toEqual({ ok: true });
      await expect(ipcMain.invoke(IPC.SHORTCUTS_RESET, { id: 'page.reload' })).resolves.toEqual({
        ok: true,
      });

      const state = await ipcMain.invoke(IPC.SHORTCUTS_GET_STATE);
      const byId = Object.fromEntries(state.entries.map((entry) => [entry.id, entry]));

      expect(byId['page.reload'].accelerator).toBe('CmdOrCtrl+R');
      expect(byId['tab.new'].accelerator).toBe('CmdOrCtrl+T');
      expect(byId['tab.new'].reverted).toEqual({
        formatted: 'Ctrl+R',
        conflict: 'Reload This Page',
      });
      expect(byId['page.reload'].reverted).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      removeTempUserDataDir(userDataDir);
    }
  });

  test('preview validates recorded keydowns and reports conflicts', async () => {
    ctx = loadShortcutsIpc();

    // Free combo — ok, no conflict.
    const free = await ctx.ipcMain.invoke(IPC.SHORTCUTS_PREVIEW_BINDING, {
      id: 'tab.new',
      event: recordedKey('u', 'KeyU', { ctrlKey: true, shiftKey: true }),
    });
    expect(free).toMatchObject({ ok: true, accelerator: 'Ctrl+Shift+U', conflict: null });

    // Modifier-only — keep recording.
    const incomplete = await ctx.ipcMain.invoke(IPC.SHORTCUTS_PREVIEW_BINDING, {
      id: 'tab.new',
      event: recordedKey('Shift', 'ShiftLeft', { shiftKey: true }),
    });
    expect(incomplete).toEqual({ ok: false, reason: 'incomplete' });

    // Reserved combo.
    const reserved = await ctx.ipcMain.invoke(IPC.SHORTCUTS_PREVIEW_BINDING, {
      id: 'tab.new',
      event: recordedKey('q', 'KeyQ', { ctrlKey: true }),
    });
    expect(reserved.ok).toBe(false);
    expect(reserved.reason).toBe('reserved');

    // Bare character on a menu-context shortcut.
    const bare = await ctx.ipcMain.invoke(IPC.SHORTCUTS_PREVIEW_BINDING, {
      id: 'tab.new',
      event: recordedKey('k', 'KeyK'),
    });
    expect(bare.reason).toBe('needs-modifier');

    // Bare character on a renderer-only shortcut — it listens globally too.
    const bareRenderer = await ctx.ipcMain.invoke(IPC.SHORTCUTS_PREVIEW_BINDING, {
      id: 'view.toggleSidebar',
      event: recordedKey('w', 'KeyW'),
    });
    expect(bareRenderer.reason).toBe('needs-modifier');

    // Bare editing key (Enter would fire while typing anywhere).
    const bareEnter = await ctx.ipcMain.invoke(IPC.SHORTCUTS_PREVIEW_BINDING, {
      id: 'tab.new',
      event: recordedKey('Enter', 'Enter'),
    });
    expect(bareEnter.reason).toBe('needs-modifier');

    // Conflict with another shortcut's default.
    const conflicted = await ctx.ipcMain.invoke(IPC.SHORTCUTS_PREVIEW_BINDING, {
      id: 'tab.new',
      event: recordedKey('w', 'KeyW', { ctrlKey: true }),
    });
    expect(conflicted.ok).toBe(true);
    expect(conflicted.conflict).toMatchObject({ id: 'tab.close', fixed: false });
    expect(conflicted.conflict.swapFormatted).toBe('Ctrl+T');
  });

  test('set-override persists a valid remap through the settings store', async () => {
    ctx = loadShortcutsIpc();
    const result = await ctx.ipcMain.invoke(IPC.SHORTCUTS_SET_OVERRIDE, {
      id: 'tab.new',
      accelerator: 'Ctrl+Shift+U',
    });

    expect(result).toEqual({ ok: true });
    expect(ctx.saveSettings).toHaveBeenCalledWith({
      shortcutOverrides: { 'tab.new': 'Ctrl+Shift+U' },
    });
  });

  test('set-override refuses conflicts unless the caller asks for a swap', async () => {
    ctx = loadShortcutsIpc();

    const refused = await ctx.ipcMain.invoke(IPC.SHORTCUTS_SET_OVERRIDE, {
      id: 'tab.new',
      accelerator: 'Ctrl+W',
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('conflict');
    expect(refused.conflict.id).toBe('tab.close');
    expect(ctx.saveSettings).not.toHaveBeenCalled();

    const swapped = await ctx.ipcMain.invoke(IPC.SHORTCUTS_SET_OVERRIDE, {
      id: 'tab.new',
      accelerator: 'Ctrl+W',
      swapWithConflict: true,
    });
    expect(swapped).toEqual({ ok: true });
    // tab.new takes Ctrl+W; tab.close inherits tab.new's previous Ctrl+T.
    expect(ctx.getSettings().shortcutOverrides).toEqual({
      'tab.new': 'Ctrl+W',
      'tab.close': 'Ctrl+T',
    });
  });

  test('set-override never swaps against fixed aliases or reserved targets', async () => {
    ctx = loadShortcutsIpc();

    const fixedAlias = await ctx.ipcMain.invoke(IPC.SHORTCUTS_SET_OVERRIDE, {
      id: 'tab.new',
      accelerator: 'Ctrl+Tab',
      swapWithConflict: true,
    });
    expect(fixedAlias.ok).toBe(false);
    expect(fixedAlias.reason).toBe('conflict');
    expect(fixedAlias.conflict).toMatchObject({ id: 'tab.next', fixed: true });

    const notEditable = await ctx.ipcMain.invoke(IPC.SHORTCUTS_SET_OVERRIDE, {
      id: 'devtools.toggle',
      accelerator: 'Ctrl+Shift+U',
    });
    expect(notEditable.reason).toBe('not-editable');

    expect(ctx.saveSettings).not.toHaveBeenCalled();
  });

  test('reset clears one override or all of them', async () => {
    ctx = loadShortcutsIpc({
      initialOverrides: { 'tab.new': 'Ctrl+Shift+U', 'page.reload': 'Ctrl+Shift+Y' },
    });

    await ctx.ipcMain.invoke(IPC.SHORTCUTS_RESET, { id: 'tab.new' });
    expect(ctx.getSettings().shortcutOverrides).toEqual({ 'page.reload': 'Ctrl+Shift+Y' });

    await ctx.ipcMain.invoke(IPC.SHORTCUTS_RESET, {});
    expect(ctx.getSettings().shortcutOverrides).toEqual({});
  });
});
