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
  // History rows newest first, as history.getRecentHistory returns them.
  const historyRows = options.historyRows || [];
  const historyMock = {
    rows: historyRows,
    getRecentHistory: jest.fn((limit) => historyMock.rows.slice(0, limit)),
  };
  const historyListeners = [];
  const favicons = options.favicons || {};

  // In-memory settings so menu accelerators resolve overrides without
  // touching a real settings.json; settingsListeners captures the menu's
  // rebuild-on-remap subscription.
  const settings = { enableAi: options.enableAi !== false, shortcutOverrides: options.shortcutOverrides || {} };
  const settingsListeners = [];

  // Tests that invoke an item's click() need getTargetWindow() to resolve;
  // without a targetWindow the electron mock has no getFocusedWindow and
  // clicking throws, so the default stays the window-less template build.
  const targetWindow = options.targetWindow || null;
  // Main windows in focus order (last = most recently focused), as
  // mainWindow.js keeps them; focusedWindow overrides what has OS focus.
  const mainWindows = options.mainWindows || (targetWindow ? [targetWindow] : []);
  const focusedWindow = 'focusedWindow' in options ? options.focusedWindow : targetWindow;

  const setApplicationMenu = jest.fn();
  // Every window the test knows of, for BrowserWindow.fromId/fromWebContents.
  const knownWindows = [...mainWindows, ...(options.otherWindows || [])];
  const { mod, dialog, ipcMain, app } = loadMainModule(require.resolve('./menu'), {
    electronOverrides: {
      Menu: {
        buildFromTemplate: jest.fn((template) => {
          capturedTemplate = template;
          return menuInstance;
        }),
        setApplicationMenu,
        getApplicationMenu: jest.fn(() => menuInstance),
      },
      ...((targetWindow || options.mainWindows) && {
        BrowserWindow: {
          getFocusedWindow: jest.fn(() => focusedWindow),
          getAllWindows: jest.fn(() => mainWindows),
          fromId: jest.fn((id) => knownWindows.find((win) => win.id === id) || null),
          fromWebContents: jest.fn(
            (wc) => knownWindows.find((win) => win.webContents === wc) || null
          ),
        },
      }),
      nativeImage: options.nativeImage || {
        createFromDataURL: jest.fn((data) => ({
          data,
          isEmpty: () => data === 'data:image/png;base64,',
          resize: jest.fn(function resize() {
            return { resizedFrom: data };
          }),
        })),
      },
    },
    extraMocks: {
      [require.resolve('./windows/mainWindow')]: () => ({
        isMainBrowserWindow: (win) => mainWindows.includes(win),
        getMainWindows: () => [...mainWindows],
        getLastFocusedMainWindow: () => mainWindows[mainWindows.length - 1] || null,
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
      // The History menu reads this process's history database (#584).
      [require.resolve('./history')]: () => ({
        getRecentHistory: historyMock.getRecentHistory,
        onHistoryChanged: (listener) => {
          historyListeners.push(listener);
          return () => {};
        },
      }),
      [require.resolve('./favicons')]: () => ({
        getCachedFavicon: (url) => favicons[url] || null,
      }),
      [require.resolve('./private/private-windows')]: () => ({
        createPrivateWindow: jest.fn(),
        isPrivateWebContents: (sender) => !!sender?.isPrivate,
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
    historyMock,
    emitHistoryChanged: () => historyListeners.forEach((listener) => listener()),
    ipcMain,
    app,
    menuInstance,
    setApplicationMenu,
  };
}

function findTopLabel(template, label) {
  return template.find((item) => item.label === label);
}

describe('menu', () => {
  test.each(['darwin', 'linux', 'win32'])('AI off does not reserve the Show Agent shortcut on %s', platform => {
    const { capturedTemplate } = loadMenuModule(platform, { enableAi: false });
    const item = findTopLabel(capturedTemplate, 'View').submenu.find(item => item.label === 'Show Agent');
    expect(item.enabled).toBe(false);
    expect(item.accelerator).toBeUndefined();
  });

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

  const pendingSwitch = (platform) => {
    let settle;
    const openOrFocusProfile = jest.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const targetWindow = { setProgressBar: jest.fn(), isDestroyed: () => false };
    const loaded = loadMenuModule(platform, {
      openOrFocusProfile,
      targetWindow,
      keepPlatform: true,
    });
    const beta = findTopLabel(loaded.capturedTemplate, 'Profiles').submenu.find(
      (item) => item.label === 'Beta'
    );
    return { loaded, targetWindow, beta, settle: (value) => settle(value) };
  };

  test('shows a native-menu profile switch in progress on the window until it settles (R2-M2)', async () => {
    for (const platform of ['win32', 'darwin']) {
      const { loaded, targetWindow, beta, settle } = pendingSwitch(platform);
      try {
        const clicked = beta.click();
        // Above 1: an indeterminate bar on Windows and macOS.
        expect(targetWindow.setProgressBar).toHaveBeenLastCalledWith(2);
        settle({ focused: true });
        await clicked;
        expect(targetWindow.setProgressBar).toHaveBeenLastCalledWith(-1);
      } finally {
        loaded.restorePlatform();
      }
    }
  });

  test('on Linux the switch bar fills with the wait and never reads as done (R3-M1)', async () => {
    jest.useFakeTimers();
    const { loaded, targetWindow, beta, settle } = pendingSwitch('linux');
    try {
      const clicked = beta.click();
      // Linux (Unity LauncherEntry) has no indeterminate mode: a value above 1
      // would be drawn as a full, finished bar.
      const values = () => targetWindow.setProgressBar.mock.calls.map(([value]) => value);
      expect(values()[0]).toBeGreaterThan(0);
      expect(values()[0]).toBeLessThan(0.5);
      jest.advanceTimersByTime(4000);
      const halfway = values()[values().length - 1];
      expect(halfway).toBeGreaterThan(values()[0]);
      expect(halfway).toBeLessThan(1);
      jest.advanceTimersByTime(60000);
      expect(Math.max(...values())).toBeLessThan(1);
      settle({ focused: true });
      await clicked;
      expect(targetWindow.setProgressBar).toHaveBeenLastCalledWith(-1);
      const calls = targetWindow.setProgressBar.mock.calls.length;
      jest.advanceTimersByTime(5000);
      expect(targetWindow.setProgressBar.mock.calls.length).toBe(calls);
    } finally {
      loaded.restorePlatform();
      jest.useRealTimers();
    }
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
      // Show All History closes the history part, right above Downloads.
      const labels = history.submenu.map((item) => item.label || item.type);
      expect(labels.slice(-3)).toEqual(['Show All History', 'separator', 'Downloads']);

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

  // R2-M1 (#630): with focus outside every main window (detached DevTools), a
  // menu action goes to the window the user focused last, not the oldest-focused.
  test('menu actions fall back to the last-focused main window', () => {
    const left = { webContents: { send: jest.fn() } };
    const current = { webContents: { send: jest.fn() } };
    const devtools = { webContents: { send: jest.fn() } };
    const { capturedTemplate } = loadMenuModule('linux', {
      mainWindows: [left, current],
      focusedWindow: devtools,
    });
    const history = findTopLabel(capturedTemplate, 'History');
    history.submenu.find((item) => item.id === 'downloads').click();
    expect(current.webContents.send).toHaveBeenCalledWith(
      'tab:new-with-url',
      'freedom://downloads'
    );
    expect(left.webContents.send).not.toHaveBeenCalled();
    expect(devtools.webContents.send).not.toHaveBeenCalled();
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

// #584: the History menu, Chrome-style.
describe('History menu', () => {
  const makeWindow = (id, extra = {}) => ({
    id,
    webContents: { send: jest.fn() },
    focus: jest.fn(),
    restore: jest.fn(),
    isMinimized: () => false,
    isDestroyed: () => false,
    ...extra,
  });
  const historyOf = (template) => findTopLabel(template, 'History').submenu;
  const rowLabels = (submenu) => submenu.map((item) => item.label ?? item.type);
  // Rows of one section: everything after its header up to the next separator.
  const sectionRows = (submenu, header) => {
    const start = submenu.findIndex((item) => item.label === header);
    if (start === -1) return [];
    const rows = [];
    for (const item of submenu.slice(start + 1)) {
      if (item.type === 'separator') break;
      rows.push(item);
    }
    return rows;
  };
  const rows = (n, prefix = 'https://site.test/') =>
    Array.from({ length: n }, (_, i) => ({ url: `${prefix}${i}`, title: `Page ${i}` }));

  afterEach(() => {
    jest.useRealTimers();
  });

  test('Back, Forward, Recently Visited, then Show All History on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform, {
        historyRows: [
          { url: 'https://new.test/', title: 'Newest' },
          { url: 'bzz://abc/', title: 'Swarm site' },
        ],
      });
      const submenu = historyOf(capturedTemplate);
      const expected = [
        'Back',
        'Forward',
        'separator',
        'Recently Visited',
        'Newest',
        'Swarm site',
        'separator',
        'Show All History',
      ];
      if (platform !== 'darwin') expected.push('separator', 'Downloads');
      expect(rowLabels(submenu)).toEqual(expected);

      const back = submenu.find((item) => item.id === 'history-back');
      const forward = submenu.find((item) => item.id === 'history-forward');
      expect(back.accelerator).toBe(platform === 'darwin' ? 'Cmd+[' : 'Alt+Left');
      expect(forward.accelerator).toBe(platform === 'darwin' ? 'Cmd+]' : 'Alt+Right');
      // Off until the active tab reports it can traverse.
      expect(back.enabled).toBe(false);
      expect(forward.enabled).toBe(false);
      // Section headers are labels, not actions.
      expect(submenu.find((item) => item.label === 'Recently Visited').enabled).toBe(false);
    }
  });

  test('an empty history and no closed tabs leave no empty sections', () => {
    const { capturedTemplate } = loadMenuModule('darwin');
    expect(rowLabels(historyOf(capturedTemplate))).toEqual([
      'Back',
      'Forward',
      'separator',
      'Show All History',
    ]);
  });

  test('Recently Visited lists the 15 latest entries, newest first', () => {
    const { capturedTemplate, historyMock } = loadMenuModule('linux', { historyRows: rows(40) });
    const visited = sectionRows(historyOf(capturedTemplate), 'Recently Visited');
    expect(visited).toHaveLength(15);
    expect(visited.map((item) => item.label)).toEqual(
      Array.from({ length: 15 }, (_, i) => `Page ${i}`)
    );
    // One bounded read, never the whole table.
    const limit = historyMock.getRecentHistory.mock.calls[0][0];
    expect(limit).toBeGreaterThanOrEqual(15);
    expect(limit).toBeLessThanOrEqual(100);
  });

  test('internal and error pages are left out, and the cap counts only listed rows', () => {
    const { capturedTemplate } = loadMenuModule('linux', {
      historyRows: [
        { url: 'freedom://settings', title: 'Settings' },
        { url: 'view-source:https://a.test/', title: 'Source' },
        { url: 'file:///app/pages/error.html?url=x', title: 'Error' },
        { url: 'about:blank', title: '' },
        ...rows(20),
      ],
    });
    const visited = sectionRows(historyOf(capturedTemplate), 'Recently Visited');
    expect(visited).toHaveLength(15);
    expect(visited[0].label).toBe('Page 0');
    expect(visited.map((item) => item.label)).not.toEqual(
      expect.arrayContaining(['Settings', 'Source', 'Error'])
    );
  });

  test('a row shows the title, falling back to the address, on one cut line', () => {
    const long = 'A'.repeat(100);
    const { capturedTemplate, mod } = loadMenuModule('linux', {
      historyRows: [
        { url: 'ipfs://bafyuntitled/', title: '' },
        { url: 'https://spaces.test/', title: '  Lots \n of\tspace  ' },
        { url: 'https://long.test/', title: long },
        { url: 'https://qa.test/', title: 'Q&A' },
      ],
    });
    const labels = sectionRows(historyOf(capturedTemplate), 'Recently Visited').map(
      (item) => item.label
    );
    expect(labels[0]).toBe('ipfs://bafyuntitled/');
    expect(labels[1]).toBe('Lots of space');
    expect(Array.from(labels[2])).toHaveLength(mod.HISTORY_LABEL_MAX);
    expect(labels[2].endsWith('…')).toBe(true);
    // A single & is a mnemonic marker to Electron.
    expect(labels[3]).toBe('Q&&A');
  });

  test('a row carries its cached favicon as a 16px icon, and none without one', () => {
    const { capturedTemplate } = loadMenuModule('linux', {
      historyRows: [
        { url: 'https://icon.test/', title: 'Has icon' },
        { url: 'https://none.test/', title: 'No icon' },
        { url: 'https://broken.test/', title: 'Broken icon' },
      ],
      favicons: {
        'https://icon.test/': 'data:image/png;base64,AAAA',
        'https://broken.test/': 'data:image/png;base64,',
      },
    });
    const [withIcon, without, broken] = sectionRows(
      historyOf(capturedTemplate),
      'Recently Visited'
    );
    expect(withIcon.icon).toEqual({ resizedFrom: 'data:image/png;base64,AAAA' });
    expect(without.icon).toBeUndefined();
    expect(broken.icon).toBeUndefined();
  });

  test('a Recently Visited row loads like address-bar input in the active window', () => {
    const win = makeWindow(1);
    const { capturedTemplate } = loadMenuModule('linux', {
      targetWindow: win,
      historyRows: [{ url: 'ens://vitalik.eth/', title: 'Vitalik' }],
    });
    sectionRows(historyOf(capturedTemplate), 'Recently Visited')[0].click();
    // tab:load-url runs the renderer's loadTarget — the address bar's path.
    expect(win.webContents.send).toHaveBeenCalledWith('tab:load-url', 'ens://vitalik.eth/');
  });

  test('Back and Forward drive the active tab of the target window', () => {
    const win = makeWindow(1);
    const { capturedTemplate } = loadMenuModule('linux', { targetWindow: win });
    const submenu = historyOf(capturedTemplate);
    submenu.find((item) => item.id === 'history-back').click();
    submenu.find((item) => item.id === 'history-forward').click();
    expect(win.webContents.send.mock.calls).toEqual([['history:back'], ['history:forward']]);
  });

  // Live MenuItem stand-ins the tab-state handler flips.
  const liveItems = (menuInstance) => {
    const items = {};
    menuInstance.getMenuItemById.mockImplementation((id) => {
      items[id] = items[id] || { enabled: false };
      return items[id];
    });
    return items;
  };

  test("Back/Forward follow the active tab's state, per window", () => {
    const left = makeWindow(1);
    const right = makeWindow(2);
    const ctx = loadMenuModule('linux', { mainWindows: [left, right], focusedWindow: right });
    const items = liveItems(ctx.menuInstance);
    const push = (win, state) =>
      ctx.ipcMain.emit(
        'menu:update-tab-state',
        { sender: win.webContents },
        {
          tabCount: 1,
          activeIndex: 0,
          hasClosedTabs: false,
          closedTabs: [],
          ...state,
        }
      );

    push(right, { canGoBack: true, canGoForward: false });
    expect(items['history-back'].enabled).toBe(true);
    expect(items['history-forward'].enabled).toBe(false);

    // A background window's push does not take over the focused window's rows.
    push(left, { canGoBack: false, canGoForward: true });
    expect(items['history-back'].enabled).toBe(true);
    expect(items['history-forward'].enabled).toBe(false);

    // Focusing it does.
    ctx.app.emit('browser-window-focus', {}, left);
    expect(items['history-back'].enabled).toBe(false);
    expect(items['history-forward'].enabled).toBe(true);
  });

  describe('Recently Closed', () => {
    const closed = (id, url, closedAt, title = `Closed ${id}`) => ({ id, url, title, closedAt });
    const pushClosed = (ctx, win, closedTabs) =>
      ctx.ipcMain.emit(
        'menu:update-tab-state',
        { sender: win.webContents },
        {
          tabCount: 1,
          activeIndex: 0,
          hasClosedTabs: closedTabs.length > 0,
          closedTabs,
        }
      );

    test("lists every normal window's closed tabs, newest first, and reopens in the owner", () => {
      jest.useFakeTimers();
      const left = makeWindow(1);
      const right = makeWindow(2);
      const ctx = loadMenuModule('linux', { mainWindows: [left, right], focusedWindow: right });

      pushClosed(ctx, left, [closed(1, 'https://a.test/', 100), closed(2, 'https://c.test/', 300)]);
      pushClosed(ctx, right, [closed(1, 'https://b.test/', 200)]);
      jest.runOnlyPendingTimers();

      const submenu = historyOf(ctx.capturedTemplate);
      const rowsShown = sectionRows(submenu, 'Recently Closed');
      expect(rowsShown.map((item) => item.label)).toEqual(['Closed 2', 'Closed 1', 'Closed 1']);
      // Closed sits above Visited, as in Chrome.
      const labels = rowLabels(submenu);
      expect(labels.indexOf('Recently Closed')).toBeLessThan(labels.indexOf('Show All History'));

      // The middle row is the right window's entry: it reopens there, by id,
      // even though another window has an entry with the same id.
      rowsShown[1].click();
      expect(right.webContents.send).toHaveBeenCalledWith('tab:reopen-closed', 1);
      expect(right.focus).toHaveBeenCalled();
      expect(left.webContents.send).not.toHaveBeenCalledWith('tab:reopen-closed', 1);
      rowsShown[0].click();
      expect(left.webContents.send).toHaveBeenCalledWith('tab:reopen-closed', 2);
    });

    test('caps the list at 10', () => {
      jest.useFakeTimers();
      const win = makeWindow(1);
      const ctx = loadMenuModule('linux', { targetWindow: win });
      pushClosed(
        ctx,
        win,
        Array.from({ length: 20 }, (_, i) => closed(i + 1, `https://t.test/${i}`, i))
      );
      jest.runOnlyPendingTimers();
      const shown = sectionRows(historyOf(ctx.capturedTemplate), 'Recently Closed');
      expect(shown).toHaveLength(ctx.mod.RECENTLY_CLOSED_LIMIT);
      expect(shown[0].label).toBe('Closed 20');
    });

    test('a private window never contributes, even while focused', () => {
      jest.useFakeTimers();
      const normal = makeWindow(1);
      const priv = makeWindow(2);
      priv.webContents.isPrivate = true;
      const ctx = loadMenuModule('linux', { mainWindows: [normal, priv], focusedWindow: priv });

      pushClosed(ctx, priv, [closed(1, 'https://secret.test/', 500, 'Secret')]);
      pushClosed(ctx, normal, [closed(1, 'https://open.test/', 100, 'Open')]);
      jest.runOnlyPendingTimers();

      const submenu = historyOf(ctx.capturedTemplate);
      expect(sectionRows(submenu, 'Recently Closed').map((item) => item.label)).toEqual(['Open']);
      expect(JSON.stringify(rowLabels(submenu))).not.toContain('Secret');
    });

    test("a closed window's entries leave the menu", () => {
      jest.useFakeTimers();
      const winListeners = {};
      const win = makeWindow(1, {
        on: jest.fn((event, handler) => {
          winListeners[event] = handler;
        }),
      });
      const ctx = loadMenuModule('linux', { targetWindow: win });
      ctx.app.emit('browser-window-created', {}, win);
      pushClosed(ctx, win, [closed(1, 'https://a.test/', 1)]);
      jest.runOnlyPendingTimers();
      expect(sectionRows(historyOf(ctx.capturedTemplate), 'Recently Closed')).toHaveLength(1);

      winListeners.closed();
      jest.runOnlyPendingTimers();
      expect(rowLabels(historyOf(ctx.capturedTemplate))).not.toContain('Recently Closed');
    });

    test('after stopHistoryMenuRefresh (quit), a window close or history write never reads the database', () => {
      jest.useFakeTimers();
      const winListeners = {};
      const win = makeWindow(1, {
        on: jest.fn((event, handler) => {
          winListeners[event] = handler;
        }),
      });
      const ctx = loadMenuModule('linux', { targetWindow: win, historyRows: rows(2) });
      ctx.app.emit('browser-window-created', {}, win);
      pushClosed(ctx, win, [closed(1, 'https://a.test/', 1)]);
      jest.runOnlyPendingTimers();
      const builds = ctx.setApplicationMenu.mock.calls.length;

      // A refresh already armed when the quit starts is dropped too.
      ctx.historyMock.rows = rows(1);
      ctx.emitHistoryChanged();
      ctx.mod.stopHistoryMenuRefresh();
      ctx.historyMock.getRecentHistory.mockClear();

      // windDown destroys the window, then closes history.sqlite.
      winListeners.closed();
      ctx.emitHistoryChanged();
      jest.advanceTimersByTime(ctx.mod.HISTORY_MENU_REFRESH_DELAY_MS * 4);

      expect(jest.getTimerCount()).toBe(0);
      expect(ctx.historyMock.getRecentHistory).not.toHaveBeenCalled();
      expect(ctx.setApplicationMenu.mock.calls).toHaveLength(builds);

      // Any other rebuild during shutdown (an updater state change) still
      // stays off the database.
      ctx.mod.setupApplicationMenu();
      expect(ctx.historyMock.getRecentHistory).not.toHaveBeenCalled();
    });
  });

  describe('refresh on history changes', () => {
    test('clearing history empties Recently Visited after the debounce', () => {
      jest.useFakeTimers();
      const ctx = loadMenuModule('linux', { historyRows: rows(3) });
      expect(sectionRows(historyOf(ctx.capturedTemplate), 'Recently Visited')).toHaveLength(3);
      const builds = ctx.setApplicationMenu.mock.calls.length;

      ctx.historyMock.rows = [];
      ctx.emitHistoryChanged();
      // Debounced: nothing rebuilds synchronously on the write.
      expect(ctx.setApplicationMenu.mock.calls).toHaveLength(builds);
      jest.advanceTimersByTime(ctx.mod.HISTORY_MENU_REFRESH_DELAY_MS);

      expect(ctx.setApplicationMenu.mock.calls).toHaveLength(builds + 1);
      expect(rowLabels(historyOf(ctx.capturedTemplate))).not.toContain('Recently Visited');
    });

    test('a removed entry disappears; a burst of visits rebuilds once', () => {
      jest.useFakeTimers();
      const ctx = loadMenuModule('linux', { historyRows: rows(3) });
      const builds = ctx.setApplicationMenu.mock.calls.length;

      ctx.historyMock.rows = rows(3).filter((row) => row.title !== 'Page 1');
      for (let i = 0; i < 5; i += 1) ctx.emitHistoryChanged();
      jest.advanceTimersByTime(ctx.mod.HISTORY_MENU_REFRESH_DELAY_MS);

      expect(ctx.setApplicationMenu.mock.calls).toHaveLength(builds + 1);
      expect(
        sectionRows(historyOf(ctx.capturedTemplate), 'Recently Visited').map((i) => i.label)
      ).toEqual(['Page 0', 'Page 2']);
    });

    test('no rebuild when the rows would come out the same', () => {
      jest.useFakeTimers();
      const ctx = loadMenuModule('linux', { historyRows: rows(3) });
      const builds = ctx.setApplicationMenu.mock.calls.length;
      // A revisit of the top page: same rows, same order.
      ctx.emitHistoryChanged();
      jest.advanceTimersByTime(ctx.mod.HISTORY_MENU_REFRESH_DELAY_MS);
      expect(ctx.setApplicationMenu.mock.calls).toHaveLength(builds);
    });

    test('a rebuild waits while the History menu is open', () => {
      jest.useFakeTimers();
      const ctx = loadMenuModule('linux', { historyRows: rows(2) });
      const submenuListeners = {};
      ctx.menuInstance.items = [
        {
          label: 'History',
          submenu: {
            on: (event, handler) => {
              submenuListeners[event] = handler;
            },
          },
        },
      ];
      ctx.mod.setupApplicationMenu();
      const builds = ctx.setApplicationMenu.mock.calls.length;

      submenuListeners['menu-will-show']();
      ctx.historyMock.rows = [];
      ctx.emitHistoryChanged();
      jest.advanceTimersByTime(ctx.mod.HISTORY_MENU_REFRESH_DELAY_MS);
      expect(ctx.setApplicationMenu.mock.calls).toHaveLength(builds);

      submenuListeners['menu-will-close']();
      jest.advanceTimersByTime(ctx.mod.HISTORY_MENU_REFRESH_DELAY_MS);
      expect(ctx.setApplicationMenu.mock.calls).toHaveLength(builds + 1);
      expect(rowLabels(historyOf(ctx.capturedTemplate))).not.toContain('Recently Visited');
    });

    test('a rebuild keeps the pushed tab state (Back stays enabled)', () => {
      jest.useFakeTimers();
      const win = makeWindow(1);
      const ctx = loadMenuModule('linux', { targetWindow: win, historyRows: rows(2) });
      const items = liveItems(ctx.menuInstance);
      ctx.ipcMain.emit(
        'menu:update-tab-state',
        { sender: win.webContents },
        {
          tabCount: 1,
          activeIndex: 0,
          canGoBack: true,
          closedTabs: [],
        }
      );
      // Rebuilt items start from the template default (disabled)...
      items['history-back'].enabled = false;
      ctx.historyMock.rows = rows(1);
      ctx.emitHistoryChanged();
      jest.advanceTimersByTime(ctx.mod.HISTORY_MENU_REFRESH_DELAY_MS);
      // ...and the rebuild re-applies the window's state.
      expect(items['history-back'].enabled).toBe(true);
    });
  });

  test('profiles: the lists come only from this process’s own history database', () => {
    // Each profile runs in its own process with its own userData, so the
    // history module's database is the profile's. The menu has no other source.
    const { capturedTemplate, historyMock } = loadMenuModule('linux', { historyRows: rows(2) });
    expect(historyMock.getRecentHistory).toHaveBeenCalled();
    expect(sectionRows(historyOf(capturedTemplate), 'Recently Visited')).toHaveLength(2);
  });

  test('with Back/Forward enabled, no two enabled items share an accelerator', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const { capturedTemplate } = loadMenuModule(platform, { historyRows: rows(15) });
      const submenu = historyOf(capturedTemplate);
      for (const item of submenu) {
        if (item.id === 'history-back' || item.id === 'history-forward') item.enabled = true;
      }
      const seen = new Map();
      for (const binding of collectBindings(capturedTemplate, platform)) {
        expect({ accelerator: binding.accelerator, dup: seen.get(binding.accelerator) }).toEqual({
          accelerator: binding.accelerator,
          dup: undefined,
        });
        seen.set(binding.accelerator, binding.path);
      }
    }
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
