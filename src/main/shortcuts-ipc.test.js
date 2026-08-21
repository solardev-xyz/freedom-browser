const { loadMainModule } = require('../../test/helpers/main-process-test-utils');
const IPC = require('../shared/ipc-channels');

// In-memory settings store standing in for src/main/settings-store.js —
// mirrors its contract: saveSettings merges shortcutOverrides (already
// sanitized upstream in the real store; these tests exercise the IPC
// module's own validation).
function loadShortcutsIpc({ platform = 'linux', initialOverrides = {} } = {}) {
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
