const fs = require('fs');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');
const { SHORTCUTS, getDefaultAccelerator, getAliasAccelerators } = require('../shared/shortcuts');

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
        getInstallRelaunchMode: () => ({ menuLabel: 'Install Update and Restart...' }),
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
        expect.arrayContaining(['Alpha', 'Beta', 'Create Profile...', 'Manage Profiles...'])
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

      expect(file?.submenu?.map((item) => item.label)).not.toContain('Manage Profiles...');
    }
  });

  test('File menu offers Downloads with the Chromium-standard accelerator', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform);
      const file = findTopLabel(capturedTemplate, 'File');
      const downloads = file?.submenu?.find((item) => item.id === 'downloads');

      expect(downloads).toEqual(
        expect.objectContaining({
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+Shift+J',
        })
      );
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
