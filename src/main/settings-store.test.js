const fs = require('fs');
const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createIpcMainMock,
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

function loadSettingsStore(options = {}) {
  const logger = { error: jest.fn(), warn: jest.fn() };
  const loaded = loadMainModule(require.resolve('./settings-store'), {
    ...options,
    extraMocks: {
      ...(options.extraMocks || {}),
      [require.resolve('./logger')]: () => logger,
    },
  });
  return { ...loaded, logger };
}

describe('settings-store', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  test('loads defaults and applies the system theme when no file exists', () => {
    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings()).toEqual(
      expect.objectContaining({
        theme: 'system',
        enableIdentityWallet: true,
        antNodeMode: 'ultraLight',
        startAntAtLaunch: true,
        startIpfsAtLaunch: true,
        startRadicleAtLaunch: false,
        enableTorIntegration: false,
        startTorAtLaunch: false,
        autoUpdate: true,
        showBookmarkBar: false,
        searchProvider: 'duckduckgo',
        customSearchProviders: [],
        sidebarOpen: false,
        sidebarWidth: 320,
        blockUnverifiedEns: true,
        showIpfsProgressStatus: false,
      })
    );
    expect(nativeTheme.themeSource).toBe('system');
  });

  test('merges persisted settings with defaults and applies the saved theme', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', autoUpdate: false, antNodeMode: 'light' }),
      'utf-8'
    );

    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings()).toEqual(
      expect.objectContaining({
        theme: 'dark',
        autoUpdate: false,
        antNodeMode: 'light',
        startAntAtLaunch: true,
        showBookmarkBar: false,
      })
    );
    expect(nativeTheme.themeSource).toBe('dark');
  });

  test('migrates bee-era keys to ant-named keys and drops the old keys', () => {
    const settingsPath = path.join(userDataDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'dark', beeNodeMode: 'light', startBeeAtLaunch: false }),
      'utf-8'
    );

    const { mod } = loadSettingsStore({ userDataDir });

    const loaded = mod.loadSettings();
    expect(loaded.antNodeMode).toBe('light');
    expect(loaded.startAntAtLaunch).toBe(false);
    expect(loaded).not.toHaveProperty('beeNodeMode');
    expect(loaded).not.toHaveProperty('startBeeAtLaunch');

    // Live file is rewritten with the new keys and no old keys.
    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(persisted.antNodeMode).toBe('light');
    expect(persisted.startAntAtLaunch).toBe(false);
    expect(persisted).not.toHaveProperty('beeNodeMode');
    expect(persisted).not.toHaveProperty('startBeeAtLaunch');
  });

  test('does not overwrite an ant-named key already present when migrating', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ beeNodeMode: 'light', antNodeMode: 'ultraLight' }),
      'utf-8'
    );

    const { mod } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings().antNodeMode).toBe('ultraLight');
  });

  test('removes the obsolete Radicle feature gate without changing startup intent', () => {
    const settingsPath = path.join(userDataDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ enableRadicleIntegration: false, startRadicleAtLaunch: true }),
      'utf-8'
    );

    const { mod } = loadSettingsStore({ userDataDir });

    const loaded = mod.loadSettings();
    expect(loaded).not.toHaveProperty('enableRadicleIntegration');
    expect(loaded.startRadicleAtLaunch).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(persisted).not.toHaveProperty('enableRadicleIntegration');
    expect(persisted.startRadicleAtLaunch).toBe(true);
  });

  test('falls back to defaults when the settings file is invalid', () => {
    fs.writeFileSync(path.join(userDataDir, 'settings.json'), '{not-valid-json', 'utf-8');

    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings()).toEqual(
      expect.objectContaining({
        theme: 'system',
        antNodeMode: 'ultraLight',
        autoUpdate: true,
      })
    );
    expect(nativeTheme.themeSource).toBe('system');
  });

  test('saveSettings persists a merged payload and updates the theme', () => {
    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.saveSettings({ theme: 'light', autoUpdate: false, antNodeMode: 'light' })).toBe(
      true
    );

    expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8'))).toEqual(
      expect.objectContaining({
        theme: 'light',
        autoUpdate: false,
        antNodeMode: 'light',
        startAntAtLaunch: true,
      })
    );
    expect(nativeTheme.themeSource).toBe('light');
  });

  test('saveSettings persists the search provider and it survives a reload', () => {
    const { mod } = loadSettingsStore({ userDataDir });

    expect(
      mod.saveSettings({
        searchProvider: 'custom:searx',
        customSearchProviders: [
          {
            id: 'searx',
            name: 'SearxNG',
            searchUrlTemplate: 'https://search.example/?q=%s',
          },
        ],
      })
    ).toBe(true);

    const { mod: reloaded } = loadSettingsStore({ userDataDir });
    expect(reloaded.loadSettings()).toEqual(
      expect.objectContaining({
        searchProvider: 'custom:searx',
        customSearchProviders: [
          {
            id: 'searx',
            name: 'SearxNG',
            searchUrlTemplate: 'https://search.example/?q={searchTerms}',
          },
        ],
      })
    );
  });

  test('normalizes malformed custom providers loaded from disk', () => {
    const settingsPath = path.join(userDataDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        customSearchProviders: [
          {
            id: 'valid',
            name: ' Valid Search ',
            searchUrlTemplate: 'https://search.example/?q=%s',
          },
          {
            id: 'unsafe',
            name: 'Unsafe',
            searchUrlTemplate: 'javascript:{searchTerms}',
          },
          {
            id: 'valid',
            name: 'Duplicate',
            searchUrlTemplate: 'https://duplicate.example/?q={searchTerms}',
          },
        ],
      }),
      'utf-8'
    );

    const { mod } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings().customSearchProviders).toEqual([
      {
        id: 'valid',
        name: 'Valid Search',
        searchUrlTemplate: 'https://search.example/?q={searchTerms}',
      },
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).customSearchProviders).toEqual(
      mod.loadSettings().customSearchProviders
    );
  });

  test('saveSettings broadcasts settings:updated to all webContents', () => {
    const send = jest.fn();
    const webContents = {
      getAllWebContents: jest.fn(() => [{ send }, { send }]),
    };
    const { mod } = loadSettingsStore({ userDataDir, webContents });

    expect(mod.saveSettings({ theme: 'light' })).toBe(true);

    expect(webContents.getAllWebContents).toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      IPC.SETTINGS_UPDATED,
      expect.objectContaining({ theme: 'light' })
    );
  });

  test('saveSettings is a no-op when the merged payload is unchanged', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', autoUpdate: true }),
      'utf-8'
    );
    const send = jest.fn();
    const webContents = {
      getAllWebContents: jest.fn(() => [{ send }]),
    };
    const { mod } = loadSettingsStore({ userDataDir, webContents });
    mod.loadSettings();

    const filePath = path.join(userDataDir, 'settings.json');
    const sizeBefore = fs.statSync(filePath).size;

    expect(mod.saveSettings({ theme: 'dark' })).toBe(true);

    expect(send).not.toHaveBeenCalled();
    expect(fs.statSync(filePath).size).toBe(sizeBefore);
  });

  test('saveSettings treats an equivalent custom provider list as unchanged', () => {
    const providers = [
      {
        id: 'searx',
        name: 'SearxNG',
        searchUrlTemplate: 'https://search.example/?q={searchTerms}',
      },
    ];
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ customSearchProviders: providers }),
      'utf-8'
    );
    const send = jest.fn();
    const webContents = { getAllWebContents: jest.fn(() => [{ send }]) };
    const { mod } = loadSettingsStore({ userDataDir, webContents });
    mod.loadSettings();

    expect(
      mod.saveSettings({ customSearchProviders: providers.map((entry) => ({ ...entry })) })
    ).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  test('saveSettings drops keys that are not part of DEFAULT_SETTINGS', () => {
    const { mod } = loadSettingsStore({ userDataDir });

    expect(mod.saveSettings({ theme: 'light', injected: 'value', extra: 1 })).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8'));
    expect(persisted.theme).toBe('light');
    expect(persisted).not.toHaveProperty('injected');
    expect(persisted).not.toHaveProperty('extra');
  });

  test('saveSettings rebuilds the adblock engine only when an adblock key changes', () => {
    const refreshEngine = jest.fn(() => Promise.resolve());
    const { mod } = loadSettingsStore({
      userDataDir,
      extraMocks: {
        [require.resolve('./adblock/service')]: () => ({ refreshEngine }),
      },
    });

    expect(mod.saveSettings({ adblockCookies: true })).toBe(true);
    expect(refreshEngine).toHaveBeenCalledTimes(1);

    expect(mod.saveSettings({ theme: 'dark' })).toBe(true);
    expect(refreshEngine).toHaveBeenCalledTimes(1);
  });

  test('saveSettings swallows send errors from destroyed webContents', () => {
    const webContents = {
      getAllWebContents: jest.fn(() => [
        {
          send: () => {
            throw new Error('Object has been destroyed');
          },
        },
      ]),
    };
    const { mod } = loadSettingsStore({ userDataDir, webContents });

    expect(mod.saveSettings({ theme: 'dark' })).toBe(true);
  });

  test('persists sanitized shortcut overrides and notifies main-process listeners', () => {
    const { mod } = loadSettingsStore({ userDataDir });
    const listener = jest.fn();
    mod.onSettingsChanged(listener);

    expect(
      mod.saveSettings({
        shortcutOverrides: {
          'tab.new': 'Shift+Ctrl+u', // valid → normalized
          'devtools.toggle': 'Ctrl+U', // non-editable → dropped
          bogus: 'Ctrl+U', // unknown id → dropped
          'page.reload': 'F12', // reserved → dropped
        },
      })
    ).toBe(true);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8')
    );
    expect(persisted.shortcutOverrides).toEqual({ 'tab.new': 'Ctrl+Shift+U' });

    expect(listener).toHaveBeenCalledTimes(1);
    const [merged, previous] = listener.mock.calls[0];
    expect(merged.shortcutOverrides).toEqual({ 'tab.new': 'Ctrl+Shift+U' });
    expect(previous.shortcutOverrides).toEqual({});

    // Saving the identical overrides again is a no-op — no second notify.
    expect(mod.saveSettings({ shortcutOverrides: { 'tab.new': 'Ctrl+Shift+U' } })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('sanitizes shortcut overrides already on disk at load time', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        shortcutOverrides: {
          'tab.new': 'Ctrl+Shift+U',
          'devtools.toggle': 'Ctrl+U',
          garbage: true,
        },
      }),
      'utf-8'
    );

    const { mod } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings().shortcutOverrides).toEqual({ 'tab.new': 'Ctrl+Shift+U' });
    expect(mod.getRevertedShortcutOverrides()).toEqual({});
  });

  test('reverts a stored remap whose chord a newer default has claimed', () => {
    // Recorded when Ctrl+0 was free — the zoom entries claimed it later, so
    // keeping it would fire two actions on one press.
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        shortcutOverrides: { 'view.focusAddressBar': 'Ctrl+0', 'tab.new': 'Ctrl+Shift+U' },
      }),
      'utf-8'
    );

    const { mod, logger } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings().shortcutOverrides).toEqual({ 'tab.new': 'Ctrl+Shift+U' });
    expect(mod.getRevertedShortcutOverrides()).toEqual({
      'view.focusAddressBar': {
        accelerator: 'Ctrl+0',
        conflictId: 'page.zoomReset',
        conflict: 'Actual Size',
      },
    });
    // One log line, at load, naming both sides.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('view.focusAddressBar');
    expect(logger.warn.mock.calls[0][0]).toContain('Actual Size');
    // Cached: a second read does not re-log.
    mod.loadSettings();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // The next settings write persists the sanitized map, so the stale
    // override leaves the file for good, and the notice stops once the user
    // rebinds something.
    expect(mod.saveSettings({ shortcutOverrides: { 'tab.new': 'Ctrl+Shift+X' } })).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8'));
    expect(persisted.shortcutOverrides).toEqual({ 'tab.new': 'Ctrl+Shift+X' });
    expect(mod.getRevertedShortcutOverrides()).toEqual({});
  });

  test('a Reset that hands a default back never drops a sibling remap silently', () => {
    const { mod, logger } = loadSettingsStore({ userDataDir });

    // Two remaps the interactive path allows: Reload moves off Ctrl+R and
    // New Tab takes the freed chord.
    expect(
      mod.saveSettings({
        shortcutOverrides: { 'page.reload': 'Ctrl+Shift+U', 'tab.new': 'Ctrl+R' },
      })
    ).toBe(true);
    expect(mod.loadSettings().shortcutOverrides).toEqual({
      'page.reload': 'Ctrl+Shift+U',
      'tab.new': 'Ctrl+R',
    });
    expect(mod.getRevertedShortcutOverrides()).toEqual({});
    logger.warn.mockClear();

    // Reset on Reload's row — resetOverride saves the map minus that entry.
    // Ctrl+R goes back to Reload, so New Tab's remap cannot stay.
    expect(mod.saveSettings({ shortcutOverrides: { 'tab.new': 'Ctrl+R' } })).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8'));
    expect(persisted.shortcutOverrides).toEqual({});
    // Not silent: same record and same log line as the load path, so
    // getShortcutState puts the notice on the New Tab row.
    expect(mod.getRevertedShortcutOverrides()).toEqual({
      'tab.new': {
        accelerator: 'Ctrl+R',
        conflictId: 'page.reload',
        conflict: 'Reload This Page',
      },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('tab.new');
    expect(logger.warn.mock.calls[0][0]).toContain('Reload This Page');

    // The next conflict-free save clears the notice again.
    expect(mod.saveSettings({ shortcutOverrides: { 'tab.new': 'Ctrl+Shift+U' } })).toBe(true);
    expect(mod.getRevertedShortcutOverrides()).toEqual({});
  });

  test('registers IPC handlers for loading and saving settings', async () => {
    const ipcMain = createIpcMainMock();
    const { mod, nativeTheme } = loadSettingsStore({ userDataDir, ipcMain });

    mod.registerSettingsIpc();

    await expect(ipcMain.invoke(IPC.SETTINGS_GET)).resolves.toEqual(
      expect.objectContaining({
        theme: 'system',
        antNodeMode: 'ultraLight',
      })
    );
    await expect(
      ipcMain.invoke(IPC.SETTINGS_SAVE, { theme: 'dark', antNodeMode: 'light' })
    ).resolves.toBe(true);

    expect(nativeTheme.themeSource).toBe('dark');
  });
});

// The search-template validator exists in three copies: here (main), the
// renderer's search-utils.js, and inline in settings.html. If the renderer
// copy drifts looser than this one, a template the form accepts is silently
// dropped by normalizeCustomSearchProviders while the UI reports "saved".
// This parity suite pins main vs search-utils over the tricky vectors (the
// settings.html inline copy has no import seam — keep it in sync by hand).
describe('normalizeSearchUrlTemplate parity (main vs renderer)', () => {
  const {
    normalizeSearchUrlTemplate: rendererNormalize,
  } = require('../renderer/lib/search-utils.js');

  let userDataDir;
  beforeEach(() => {
    userDataDir = createTempUserDataDir();
  });
  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  const VECTORS = [
    'https://example.com/search?q={searchTerms}',
    'https://example.com/search?q=%s',
    '  https://example.com/?q={searchTerms}  ',
    'https://example.com/search', // no placeholder
    'https://example.com/?a={searchTerms}&b={searchTerms}', // two placeholders
    'https://example.com/?a={searchTerms}&b=%s', // mixed placeholder forms
    'http://example.com/?q={searchTerms}', // http non-loopback
    'http://localhost:3000/?q={searchTerms}',
    'http://127.0.0.1/?q={searchTerms}',
    'http://[::1]:8080/?q={searchTerms}',
    'https://user:pass@example.com/?q={searchTerms}', // credentials
    'ftp://example.com/?q={searchTerms}',
    'not a url {searchTerms}',
    '{searchTerms}',
    '',
    'https://example.com/?q={SEARCHTERMS}', // wrong case
    `https://example.com/?q={searchTerms}&pad=${'x'.repeat(2048)}`, // over length cap
  ];

  test.each(VECTORS.map((v) => [v]))('agrees on %s', (vector) => {
    const { mod } = loadSettingsStore({ userDataDir });
    expect(mod.normalizeSearchUrlTemplate(vector)).toBe(rendererNormalize(vector));
  });

  test('agrees on non-string inputs', () => {
    const { mod } = loadSettingsStore({ userDataDir });
    for (const vector of [null, undefined, 42, {}, []]) {
      expect(mod.normalizeSearchUrlTemplate(vector)).toBe(rendererNormalize(vector));
    }
  });
});
