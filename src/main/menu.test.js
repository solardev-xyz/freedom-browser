const fs = require('fs');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');
const {
  SHORTCUTS,
  getDefaultAccelerator,
  getAliasAccelerators,
  normalizeAccelerator,
} = require('../shared/shortcuts');

// Electron gives most menu *roles* an implicit default accelerator that never
// appears in the template — which is how `{ role: 'close' }` silently claimed
// Cmd/Ctrl+W next to Close Tab and closed the whole window on Windows/Linux
// (#97). A template-only duplicate check is blind to that, so the accelerator
// sweep below resolves roles through this table.
//
// Some of those defaults are platform-conditional, so this table is keyed by
// platform wherever Electron's own is: a flat table would sweep the win32 and
// darwin legs below against chords the real menu never registers there (and
// miss the ones it does).
//
// Provenance, both legs cross-checked on 2026-09-16 against the Electron the
// repo shipped at the time (44.3.0; 44.4.1 since #346, a patch bump that
// touches none of the role defaults below):
//   - linux: read empirically, by building a menu of every role used in this
//     file under the real Electron binary and printing each
//     MenuItem#accelerator (Electron resolves the role default into that
//     getter). Every value in the `linux` column below came back verbatim.
//   - darwin/win32: cannot be built on a Linux box — Electron resolves
//     `process.platform` when its internal menu-item-roles module is first
//     evaluated, which happens before any app code runs, so faking the
//     platform does not reach it. Taken instead from the three `isMac`/
//     `isWindows` ternaries in that module at the shipped tag,
//     electron/electron v44.3.0 lib/browser/api/menu-item-roles.ts:135
//     (pasteandmatchstyle), :150 (quit), :155 (redo) — confirmed to be the
//     code actually shipped by finding those exact literals, in that order,
//     in the binary's own string pool (`Cmd+Option+Shift+V`,
//     `Shift+CommandOrControl+V`, a single `CommandOrControl+Q`, `Control+Y`,
//     `Shift+CommandOrControl+Z`).
//
// test-e2e/close-tab-shortcut.spec.js re-derives ownership from the *real*
// built menu on ubuntu/windows/macOS, but only for the Cmd/Ctrl+W chord — it
// is not a general backstop for this table, so a role default that changes on
// a chord other than Cmd/Ctrl+W is caught only by re-probing here.
//
// A value is either one accelerator (or null) for every platform, or a map
// that must name all three. Any role not listed here throws rather than being
// assumed accelerator-free — a new role has to be probed and added.
const ROLE_DEFAULT_ACCELERATORS = {
  // Submenu containers.
  appmenu: null,
  editmenu: null,
  windowmenu: null,
  // Leaf roles.
  about: null,
  close: 'CommandOrControl+W',
  copy: 'CommandOrControl+C',
  cut: 'CommandOrControl+X',
  delete: null,
  front: null,
  hide: 'Command+H',
  hideothers: 'Command+Alt+H',
  minimize: 'CommandOrControl+M',
  paste: 'CommandOrControl+V',
  pasteandmatchstyle: {
    darwin: 'Cmd+Option+Shift+V',
    win32: 'Shift+CommandOrControl+V',
    linux: 'Shift+CommandOrControl+V',
  },
  // Windows gets no accelerator at all: its Exit row is unbound.
  quit: { darwin: 'CommandOrControl+Q', win32: null, linux: 'CommandOrControl+Q' },
  redo: {
    darwin: 'Shift+CommandOrControl+Z',
    win32: 'Control+Y',
    linux: 'Shift+CommandOrControl+Z',
  },
  selectall: 'CommandOrControl+A',
  services: null,
  startspeaking: null,
  stopspeaking: null,
  undo: 'CommandOrControl+Z',
  unhide: null,
  zoom: null,
};

// The role's implicit default accelerator on `platform`, unnormalized.
function roleDefaultAccelerator(role, platform) {
  if (!(role in ROLE_DEFAULT_ACCELERATORS)) {
    throw new Error(
      `Unmodelled menu role "${role}" — probe its default accelerator ` +
        'and add it to ROLE_DEFAULT_ACCELERATORS so the #97 collision sweep stays honest.'
    );
  }
  const modelled = ROLE_DEFAULT_ACCELERATORS[role];
  if (modelled === null || typeof modelled === 'string') return modelled;
  if (!(platform in modelled)) {
    throw new Error(
      `Menu role "${role}" has no modelled default for platform "${platform}" — ` +
        'probe it and add it to ROLE_DEFAULT_ACCELERATORS.'
    );
  }
  return modelled[platform];
}

// Accelerator a built menu item would actually answer to on `platform`:
// its explicit accelerator, else its role's implicit default, else none.
function effectiveAccelerator(item, platform) {
  if (!item || item.type === 'separator') return null;
  if (item.accelerator !== undefined && item.accelerator !== null) {
    return normalizeAccelerator(item.accelerator, platform);
  }
  if (item.role) {
    const roleAccelerator = roleDefaultAccelerator(String(item.role).toLowerCase(), platform);
    return roleAccelerator ? normalizeAccelerator(roleAccelerator, platform) : null;
  }
  return null;
}

// Every (item, accelerator) pair a menu template would register on `platform`,
// walking submenus. Disabled rows are skipped: Electron does not fire them.
function collectBindings(items, platform, trail = [], found = []) {
  for (const item of items || []) {
    const label = item.label ?? item.role ?? item.type ?? '(unnamed)';
    const path = [...trail, label];
    if (item.enabled !== false) {
      const accelerator = effectiveAccelerator(item, platform);
      if (accelerator) {
        found.push({
          accelerator,
          path: path.join(' > '),
          id: item.id ?? null,
          role: item.role ?? null,
        });
      }
    }
    if (Array.isArray(item.submenu)) {
      collectBindings(item.submenu, platform, path, found);
    }
  }
  return found;
}

function loadMenuModule(platform, options = {}) {
  let capturedTemplate = null;
  const menuInstance = {
    on: jest.fn(),
    getMenuItemById: jest.fn(),
  };
  const openOrFocusProfile = options.openOrFocusProfile || jest.fn();

  // In-memory settings so menu accelerators resolve overrides without
  // touching a real settings.json; settingsListeners captures the menu's
  // rebuild-on-remap subscription.
  const settings = { shortcutOverrides: options.shortcutOverrides || {} };
  const settingsListeners = [];

  // Tests that invoke an item's click() need getTargetWindow() to resolve;
  // without a targetWindow the electron mock has no getFocusedWindow and
  // clicking throws, so the default stays the window-less template build.
  const targetWindow = options.targetWindow || null;

  const { mod, dialog } = loadMainModule(require.resolve('./menu'), {
    electronOverrides: {
      Menu: {
        buildFromTemplate: jest.fn((template) => {
          capturedTemplate = template;
          return menuInstance;
        }),
        setApplicationMenu: jest.fn(),
        getApplicationMenu: jest.fn(() => menuInstance),
      },
      ...(targetWindow && {
        BrowserWindow: {
          getFocusedWindow: jest.fn(() => targetWindow),
          getAllWindows: jest.fn(() => [targetWindow]),
        },
      }),
    },
    extraMocks: {
      [require.resolve('./windows/mainWindow')]: () => ({
        isMainBrowserWindow: () => true,
        getMainWindows: () => (targetWindow ? [targetWindow] : []),
        createMainWindow: jest.fn(),
      }),
      [require.resolve('./updater')]: () => ({
        checkForUpdates: jest.fn(),
        getInstallRelaunchMode: () => ({ menuLabel: 'Install Update and Restart…' }),
        isUpdateReady: () => false,
        installUpdate: jest.fn(),
      }),
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: () => ({ id: 'alpha', source: 'catalog', isActive: true }),
        listProfilesForActiveApp: () => [
          { id: 'alpha', displayName: 'Alpha', isActive: true },
          { id: 'beta', displayName: 'Beta' },
        ],
      }),
      [require.resolve('./profile-launcher')]: () => ({
        openOrFocusProfile,
      }),
      [require.resolve('./settings-store')]: () => ({
        loadSettings: () => settings,
        onSettingsChanged: (listener) => {
          settingsListeners.push(listener);
          return () => {};
        },
      }),
    },
  });

  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });

  // Keep the mocked platform active for the returned emitter too — the
  // rebuild path resolves accelerators against process.platform.
  const restorePlatform = () =>
    Object.defineProperty(process, 'platform', { value: originalPlatform });

  const emitSettingsChanged = (merged, previous) => {
    settings.shortcutOverrides = merged.shortcutOverrides || {};
    for (const listener of settingsListeners) listener(merged, previous);
  };

  try {
    mod.setupApplicationMenu();
  } finally {
    if (!options.keepPlatform) restorePlatform();
  }

  return {
    get capturedTemplate() {
      return capturedTemplate;
    },
    mod,
    dialog,
    openOrFocusProfile,
    emitSettingsChanged,
    restorePlatform,
  };
}

function findTopLabel(template, label) {
  return template.find((item) => item.label === label);
}

describe('menu', () => {
  test('Windows template omits macOS-only appMenu and windowMenu', () => {
    const { capturedTemplate } = loadMenuModule('win32');

    expect(capturedTemplate.some((item) => item.role === 'appMenu')).toBe(false);
    expect(capturedTemplate.some((item) => item.role === 'windowMenu')).toBe(false);
    expect(findTopLabel(capturedTemplate, 'File')).toBeTruthy();
    expect(findTopLabel(capturedTemplate, 'Edit')).toBeTruthy();
  });

  test('Windows and Linux place Edit immediately after File', () => {
    for (const platform of ['win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const labels = capturedTemplate.map((item) => item.label ?? item.role);
      const fileIndex = labels.indexOf('File');
      const editIndex = labels.indexOf('Edit');
      const viewIndex = labels.indexOf('View');

      expect(fileIndex).toBeGreaterThanOrEqual(0);
      expect(editIndex).toBe(fileIndex + 1);
      expect(viewIndex).toBeGreaterThan(editIndex);
    }
  });

  test('Linux template uses explicit Edit roles for clipboard accelerators', () => {
    const { capturedTemplate } = loadMenuModule('linux');
    const edit = findTopLabel(capturedTemplate, 'Edit');

    expect(edit?.submenu?.map((item) => item.role)).toEqual(
      expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll'])
    );
    expect(capturedTemplate.some((item) => item.role === 'appMenu')).toBe(false);
    expect(capturedTemplate.some((item) => item.role === 'windowMenu')).toBe(false);
  });

  test('Profiles menu lists profiles plus create/manage actions', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const profiles = findTopLabel(capturedTemplate, 'Profiles');

      expect(profiles).toBeTruthy();
      const labels = profiles.submenu.map((item) => item.label ?? item.type);
      expect(labels).toEqual(
        expect.arrayContaining(['Alpha', 'Beta', 'Create Profile…', 'Manage Profiles…'])
      );

      // Current profile is a checked + disabled checkbox; the other is a plain
      // selectable item (NOT a checkbox — macOS auto-checks checkbox items on
      // click, which would leave a phantom checkmark after switching).
      const alpha = profiles.submenu.find((item) => item.label === 'Alpha');
      const beta = profiles.submenu.find((item) => item.label === 'Beta');
      expect(alpha.type).toBe('checkbox');
      expect(alpha.checked).toBe(true);
      expect(alpha.enabled).toBe(false);
      expect(beta.type).not.toBe('checkbox');
      expect(beta.checked).toBeFalsy();
      expect(beta.enabled).not.toBe(false);
      expect(typeof beta.click).toBe('function');
    }
  });

  test('surfaces a dialog when a native-menu profile switch does not complete', async () => {
    // openOrFocusProfile resolves with { error } (it doesn't throw) when the
    // target profile is running but never acked the focus request — the native
    // menu must not swallow that.
    const openOrFocusProfile = jest.fn().mockResolvedValue({
      focused: false,
      error: 'The running profile did not respond',
    });
    const { capturedTemplate, dialog } = loadMenuModule('darwin', { openOrFocusProfile });

    const profiles = findTopLabel(capturedTemplate, 'Profiles');
    const beta = profiles.submenu.find((item) => item.label === 'Beta');

    await beta.click();

    expect(openOrFocusProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'alpha' }),
      'beta'
    );
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Could not switch profile',
      'The running profile did not respond'
    );
  });

  test('File menu no longer includes the profile management entry', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const file = findTopLabel(capturedTemplate, 'File');

      expect(file?.submenu?.map((item) => item.label)).not.toContain('Manage Profiles…');
    }
  });

  // Chrome's placement (#326): Window > Downloads on macOS, next to History on
  // Linux/Windows. It used to sit in the File menu on every platform.
  test('Downloads sits in the macOS Window menu with the Chromium-standard accelerator', () => {
    const { capturedTemplate } = loadMenuModule('darwin');
    const windowMenu = capturedTemplate.find((item) => item.role === 'windowMenu');
    const downloads = windowMenu?.submenu?.find((item) => item.id === 'downloads');

    expect(downloads).toEqual(
      expect.objectContaining({
        label: 'Downloads',
        accelerator: 'CmdOrCtrl+Shift+J',
      })
    );
    expect(typeof downloads.click).toBe('function');

    // The role's own rows survive alongside it.
    const roles = windowMenu.submenu.map((item) => item.role).filter(Boolean);
    expect(roles).toEqual(expect.arrayContaining(['minimize', 'zoom', 'front']));

    // ...and it is not repeated in File or History.
    expect(
      findTopLabel(capturedTemplate, 'File').submenu.some((item) => item.id === 'downloads')
    ).toBe(false);
    expect(
      findTopLabel(capturedTemplate, 'History').submenu.some((item) => item.id === 'downloads')
    ).toBe(false);
  });

  test('Downloads sits next to History on Linux/Windows, not in File', () => {
    for (const platform of ['win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const history = findTopLabel(capturedTemplate, 'History');
      const downloads = history?.submenu?.find((item) => item.id === 'downloads');

      expect(downloads).toEqual(
        expect.objectContaining({
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+Shift+J',
        })
      );
      expect(typeof downloads.click).toBe('function');
      expect(history.submenu[0].label).toBe('Show All History');

      const file = findTopLabel(capturedTemplate, 'File');
      expect(file.submenu.some((item) => item.id === 'downloads')).toBe(false);
    }
  });

  test('Downloads routes through the freedom://downloads singleton on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const send = jest.fn();
      const { capturedTemplate } = loadMenuModule(platform, {
        targetWindow: { webContents: { send } },
      });
      const owner =
        platform === 'darwin'
          ? capturedTemplate.find((item) => item.role === 'windowMenu')
          : findTopLabel(capturedTemplate, 'History');

      owner.submenu.find((item) => item.id === 'downloads').click();
      expect(send).toHaveBeenCalledWith('tab:new-with-url', 'freedom://downloads');
    }
  });

  test('File menu offers New Private Window right after New Window', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const file = findTopLabel(capturedTemplate, 'File');
      const labels = file.submenu.map((item) => item.label);

      const privateItem = file.submenu.find((item) => item.id === 'new-private-window');
      expect(privateItem).toEqual(
        expect.objectContaining({
          label: 'New Private Window',
          accelerator: 'CmdOrCtrl+Shift+N',
        })
      );
      expect(typeof privateItem.click).toBe('function');
      expect(labels.indexOf('New Private Window')).toBe(labels.indexOf('New Window') + 1);
    }
  });

  test('Profiles menu sits between History and the Window menu on macOS', () => {
    const { capturedTemplate } = loadMenuModule('darwin');
    const labels = capturedTemplate.map((item) => item.label ?? item.role);
    const historyIndex = labels.indexOf('History');
    const profilesIndex = labels.indexOf('Profiles');
    const windowIndex = labels.indexOf('windowMenu');

    expect(profilesIndex).toBe(historyIndex + 1);
    expect(windowIndex).toBeGreaterThan(profilesIndex);
  });

  test('macOS template keeps appMenu and editMenu roles', () => {
    const { capturedTemplate } = loadMenuModule('darwin');

    expect(capturedTemplate.some((item) => item.role === 'appMenu')).toBe(true);
    expect(capturedTemplate.some((item) => item.role === 'editMenu')).toBe(true);
    expect(capturedTemplate.some((item) => item.role === 'windowMenu')).toBe(true);
    expect(findTopLabel(capturedTemplate, 'Edit')).toBeFalsy();
  });

  // The `Check for Updates…` row lives only in the macOS appMenu, so the
  // Linux/Windows templates — and any e2e run on them — can never show this
  // label. It is the one native label that has to be asserted from a mocked
  // darwin build, and it is the one #257 left on ASCII dots next to the
  // hamburger flyout's `Check for Updates…`. See src/main/main-copy.test.js.
  test('macOS appMenu update rows use the one ellipsis character', () => {
    const { capturedTemplate } = loadMenuModule('darwin');
    const appMenu = capturedTemplate.find((item) => item.role === 'appMenu');
    const labels = appMenu.submenu.map((item) => item.label).filter(Boolean);

    expect(labels).toContain('Check for Updates…');
    expect(labels.filter((label) => label.includes('...'))).toEqual([]);
  });

  test('Edit menu carries Find in Page with CmdOrCtrl+F on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const edit = capturedTemplate.find(
        (item) => item.label === 'Edit' || item.role === 'editMenu'
      );
      const find = edit?.submenu?.find((item) => item.id === 'find-in-page');

      expect(find).toBeTruthy();
      expect(find.accelerator).toBe('CmdOrCtrl+F');
      expect(typeof find.click).toBe('function');
    }
  });

  test('View menu carries the zoom group ahead of Full Screen on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const send = jest.fn();
      const { capturedTemplate } = loadMenuModule(platform, {
        targetWindow: { webContents: { send } },
      });
      const view = findTopLabel(capturedTemplate, 'View');

      const cases = [
        ['zoom-in', 'Zoom In', 'CmdOrCtrl+=', 'page:zoom-in'],
        ['zoom-out', 'Zoom Out', 'CmdOrCtrl+-', 'page:zoom-out'],
        ['zoom-reset', 'Actual Size', 'CmdOrCtrl+0', 'page:zoom-reset'],
      ];

      for (const [id, label, accelerator, channel] of cases) {
        const item = view.submenu.find((entry) => entry.id === id);
        expect(item).toEqual(expect.objectContaining({ label, accelerator }));

        send.mockClear();
        item.click();
        expect(send).toHaveBeenCalledWith(channel);
      }

      // Chromium order: zoom sits directly above the fullscreen toggle.
      const ids = view.submenu.map((entry) => entry.id);
      expect(ids.indexOf('zoom-reset')).toBeLessThan(ids.indexOf('fullscreen'));
      expect(ids.indexOf('zoom-in')).toBeLessThan(ids.indexOf('zoom-out'));
    }
  });

  test('zoom aliases get hidden rows, so no action is duplicated in the View menu', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const send = jest.fn();
      const { capturedTemplate } = loadMenuModule(platform, {
        targetWindow: { webContents: { send } },
      });
      const view = findTopLabel(capturedTemplate, 'View');

      const cases = [
        ['Zoom In', 'page.zoomIn', 'page:zoom-in'],
        ['Zoom Out', 'page.zoomOut', 'page:zoom-out'],
        ['Actual Size', 'page.zoomReset', 'page:zoom-reset'],
      ];

      for (const [label, id, channel] of cases) {
        const rows = view.submenu.filter((entry) => entry.label === label);
        const aliases = getAliasAccelerators(id, platform);
        expect(aliases.length).toBeGreaterThan(0);
        expect(rows).toHaveLength(1 + aliases.length);

        // Exactly one visible row per action; every alias is hidden but
        // still carries its accelerator and the same click target.
        const visible = rows.filter((row) => row.visible !== false);
        expect(visible).toHaveLength(1);
        const hidden = rows.filter((row) => row.visible === false);
        expect(hidden.map((row) => row.accelerator)).toEqual(aliases);

        for (const row of hidden) {
          send.mockClear();
          row.click();
          expect(send).toHaveBeenCalledWith(channel);
        }
      }
    }
  });

  test('zoom accelerators follow a user remap', () => {
    const { capturedTemplate } = loadMenuModule('linux', {
      shortcutOverrides: { 'page.zoomIn': 'Ctrl+Shift+Up' },
    });
    const view = findTopLabel(capturedTemplate, 'View');

    expect(view.submenu.find((entry) => entry.id === 'zoom-in').accelerator).toBe('Ctrl+Shift+Up');
    expect(view.submenu.find((entry) => entry.id === 'zoom-out').accelerator).toBe('CmdOrCtrl+-');
  });

  // #97: the File menu used to bind Cmd/Ctrl+W twice — the explicit Close Tab
  // item and `{ role: 'close' }`, whose implicit default is the same chord.
  // Windows and Linux gave the role the chord, so Ctrl+W closed the whole
  // window (every tab at once) instead of the active tab.
  describe('Cmd/Ctrl+W (#97)', () => {
    const closeTabChord = (platform) => normalizeAccelerator('CmdOrCtrl+W', platform);

    test('the accelerator sweep resolves a role default, not just explicit accelerators', () => {
      // Guards the guard: if this returned null, every assertion below would
      // pass against the bug it exists to catch.
      expect(effectiveAccelerator({ role: 'close' }, 'linux')).toBe(closeTabChord('linux'));
      expect(effectiveAccelerator({ role: 'close' }, 'darwin')).toBe(closeTabChord('darwin'));
      expect(() => effectiveAccelerator({ role: 'notARole' }, 'linux')).toThrow(/Unmodelled/);
    });

    test('platform-conditional role defaults resolve per platform', () => {
      // Electron picks these three from process.platform (see the table's
      // provenance note). Pinned literally so the win32/darwin legs of the
      // sweep below cannot silently drift back onto the Linux values.
      expect(effectiveAccelerator({ role: 'redo' }, 'win32')).toBe('Ctrl+Y');
      expect(effectiveAccelerator({ role: 'redo' }, 'linux')).toBe('Ctrl+Shift+Z');
      expect(effectiveAccelerator({ role: 'redo' }, 'darwin')).toBe('Shift+Cmd+Z');

      expect(effectiveAccelerator({ role: 'pasteAndMatchStyle' }, 'darwin')).toBe(
        'Alt+Shift+Cmd+V'
      );
      expect(effectiveAccelerator({ role: 'pasteAndMatchStyle' }, 'win32')).toBe('Ctrl+Shift+V');

      // Windows leaves Exit unbound; every other platform gets Cmd/Ctrl+Q.
      expect(effectiveAccelerator({ role: 'quit' }, 'win32')).toBeNull();
      expect(effectiveAccelerator({ role: 'quit' }, 'linux')).toBe('Ctrl+Q');
      expect(effectiveAccelerator({ role: 'quit' }, 'darwin')).toBe('Cmd+Q');

      // A platform the table does not model is an error, never a silent
      // "this role is accelerator-free here".
      expect(() => effectiveAccelerator({ role: 'quit' }, 'freebsd')).toThrow(
        /no modelled default for platform/
      );
    });

    test('exactly one enabled menu item owns it, and it is Close Tab', () => {
      for (const platform of ['darwin', 'win32', 'linux']) {
        const { capturedTemplate } = loadMenuModule(platform);
        const owners = collectBindings(capturedTemplate, platform).filter(
          (binding) => binding.accelerator === closeTabChord(platform)
        );

        expect(owners.map((binding) => binding.path)).toEqual(['File > Close Tab']);
        expect(owners[0].id).toBe('close-tab');
      }
    });

    test('Close Window is still in the File menu, with no accelerator of its own', () => {
      for (const platform of ['darwin', 'win32', 'linux']) {
        const { capturedTemplate } = loadMenuModule(platform);
        const file = findTopLabel(capturedTemplate, 'File');
        const closeWindow = file.submenu.find((item) => item.id === 'close-window');

        expect(closeWindow).toEqual(expect.objectContaining({ label: 'Close Window' }));
        expect(closeWindow.accelerator).toBeUndefined();
        // Not a role either: `{ role: 'close' }` would drag its implicit
        // Cmd/Ctrl+W back in without ever naming it in the template.
        expect(closeWindow.role).toBeUndefined();
      }
    });

    test('Close Window closes the focused window; Close Tab closes only the tab', () => {
      const send = jest.fn();
      const close = jest.fn();
      const targetWindow = {
        webContents: { send },
        close,
        isFocused: () => true,
      };
      const { capturedTemplate } = loadMenuModule('linux', { targetWindow });
      const file = findTopLabel(capturedTemplate, 'File');

      file.submenu.find((item) => item.id === 'close-tab').click();
      expect(send).toHaveBeenCalledWith('tab:close');
      expect(close).not.toHaveBeenCalled();

      send.mockClear();
      file.submenu.find((item) => item.id === 'close-window').click();
      expect(close).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });

    test('a remapped Close Tab takes the whole binding with it', () => {
      // The collision was invisible to the registry's own conflict checks
      // (a role carries no registry entry), so re-run the sweep against a
      // remap: nothing may inherit the freed Cmd/Ctrl+W.
      const { capturedTemplate } = loadMenuModule('linux', {
        shortcutOverrides: { 'tab.close': 'Ctrl+Shift+K' },
      });
      const bindings = collectBindings(capturedTemplate, 'linux');

      expect(bindings.filter((b) => b.accelerator === closeTabChord('linux'))).toEqual([]);
      expect(bindings.find((b) => b.id === 'close-tab').accelerator).toBe(
        normalizeAccelerator('Ctrl+Shift+K', 'linux')
      );
    });

    test('no two enabled menu items share an accelerator on any platform', () => {
      for (const platform of ['darwin', 'win32', 'linux']) {
        const { capturedTemplate } = loadMenuModule(platform);
        const byAccelerator = new Map();
        for (const binding of collectBindings(capturedTemplate, platform)) {
          const paths = byAccelerator.get(binding.accelerator) || [];
          paths.push(binding.path);
          byAccelerator.set(binding.accelerator, paths);
        }

        const collisions = [...byAccelerator.entries()]
          .filter(([, paths]) => paths.length > 1)
          .map(([accelerator, paths]) => `${accelerator}: ${paths.join(' / ')}`);

        expect({ platform, collisions }).toEqual({ platform, collisions: [] });
      }
    });
  });

  test('macOS places editMenu immediately after File', () => {
    const { capturedTemplate } = loadMenuModule('darwin');
    const labels = capturedTemplate.map((item) => item.label ?? item.role);
    const fileIndex = labels.indexOf('File');
    const editIndex = labels.indexOf('editMenu');
    const viewIndex = labels.indexOf('View');

    expect(fileIndex).toBeGreaterThanOrEqual(0);
    expect(editIndex).toBe(fileIndex + 1);
    expect(viewIndex).toBeGreaterThan(editIndex);
  });
});

describe('menu ↔ shortcut registry', () => {
  // Collect every explicit accelerator in a built menu template.
  function collectAccelerators(items, found = []) {
    for (const item of items || []) {
      if (item.accelerator !== undefined) {
        found.push(item.accelerator);
      }
      if (Array.isArray(item.submenu)) {
        collectAccelerators(item.submenu, found);
      }
    }
    return found;
  }

  test('menu.js carries no accelerator literals — everything resolves through the registry', () => {
    const source = fs.readFileSync(require.resolve('./menu'), 'utf-8');
    // Any accelerator assigned from a string (or template/ternary) literal
    // means a shortcut bypassed src/shared/shortcuts.js. Add the shortcut
    // to the registry and use acc()/aliasAcc() instead.
    const literalAccelerator = /accelerator:\s*(['"`]|isMac)/;
    expect(source).not.toMatch(literalAccelerator);
    expect(source).toMatch(/require\('\.\.\/shared\/shortcuts'\)/);
  });

  test('every template accelerator is a registry default or fixed alias', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const registryAccelerators = new Set();
      for (const entry of SHORTCUTS) {
        registryAccelerators.add(getDefaultAccelerator(entry, platform));
        for (const alias of getAliasAccelerators(entry, platform)) {
          registryAccelerators.add(alias);
        }
      }

      const { capturedTemplate } = loadMenuModule(platform);
      const used = collectAccelerators(capturedTemplate);
      expect(used.length).toBeGreaterThan(0);
      for (const accelerator of used) {
        expect(registryAccelerators).toContain(accelerator);
      }
    }
  });

  test('user overrides replace default accelerators in the built menu', () => {
    const ctx = loadMenuModule('linux', {
      shortcutOverrides: { 'tab.new': 'Ctrl+Shift+U' },
    });

    const file = ctx.capturedTemplate.find((item) => item.label === 'File');
    const newTab = file.submenu.find((item) => item.id === 'new-tab');
    expect(newTab.accelerator).toBe('Ctrl+Shift+U');

    // Untouched shortcuts keep their registry defaults.
    const closeTab = file.submenu.find((item) => item.id === 'close-tab');
    expect(closeTab.accelerator).toBe('CmdOrCtrl+W');
  });

  test('the menu rebuilds when shortcut overrides change and not otherwise', () => {
    const ctx = loadMenuModule('linux', { keepPlatform: true });
    try {
      const before = ctx.capturedTemplate;

      // Unrelated settings change → no rebuild.
      ctx.emitSettingsChanged({ theme: 'dark', shortcutOverrides: {} }, { shortcutOverrides: {} });
      expect(ctx.capturedTemplate).toBe(before);

      // Shortcut remap → rebuild with the new accelerator.
      ctx.emitSettingsChanged(
        { shortcutOverrides: { 'tab.new': 'Ctrl+Shift+U' } },
        { shortcutOverrides: {} }
      );
      expect(ctx.capturedTemplate).not.toBe(before);
      const file = ctx.capturedTemplate.find((item) => item.label === 'File');
      expect(file.submenu.find((item) => item.id === 'new-tab').accelerator).toBe('Ctrl+Shift+U');
    } finally {
      ctx.restorePlatform();
    }
  });

  test('menu-context registry entries all surface in the menu template', () => {
    // Renderer-only shortcuts (context: 'renderer') have no menu item; every
    // other entry's default accelerator must appear in the built template on
    // a platform where the entry applies.
    const { capturedTemplate } = loadMenuModule('linux');
    const used = new Set(collectAccelerators(capturedTemplate));

    for (const entry of SHORTCUTS) {
      if (entry.context === 'renderer') continue;
      expect(used).toContain(getDefaultAccelerator(entry, 'linux'));
    }
  });
});
