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
  return loadMainModule(require.resolve('./settings-store'), options);
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

    expect(mod.loadSettings()).toEqual({
      theme: 'system',
      enableRadicleIntegration: false,
      startBeeAtLaunch: true,
      startIpfsAtLaunch: true,
      startRadicleAtLaunch: false,
      autoUpdate: true,
      showBookmarkBar: false,
    });
    expect(nativeTheme.themeSource).toBe('system');
  });

  test('merges persisted settings with defaults and applies the saved theme', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', autoUpdate: false }),
      'utf-8'
    );

    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings()).toEqual(
      expect.objectContaining({
        theme: 'dark',
        autoUpdate: false,
        startBeeAtLaunch: true,
        showBookmarkBar: false,
      })
    );
    expect(nativeTheme.themeSource).toBe('dark');
  });

  test('falls back to defaults when the settings file is invalid', () => {
    fs.writeFileSync(path.join(userDataDir, 'settings.json'), '{not-valid-json', 'utf-8');

    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings()).toEqual(
      expect.objectContaining({
        theme: 'system',
        autoUpdate: true,
      })
    );
    expect(nativeTheme.themeSource).toBe('system');
  });

  test('saveSettings persists a merged payload and updates the theme', () => {
    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.saveSettings({ theme: 'light', autoUpdate: false })).toBe(true);

    expect(
      JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8'))
    ).toEqual(
      expect.objectContaining({
        theme: 'light',
        autoUpdate: false,
        startBeeAtLaunch: true,
      })
    );
    expect(nativeTheme.themeSource).toBe('light');
  });

  test('registers IPC handlers for loading and saving settings', async () => {
    const ipcMain = createIpcMainMock();
    const { mod, nativeTheme } = loadSettingsStore({ userDataDir, ipcMain });

    mod.registerSettingsIpc();

    await expect(ipcMain.invoke(IPC.SETTINGS_GET)).resolves.toEqual(
      expect.objectContaining({
        theme: 'system',
      })
    );
    await expect(ipcMain.invoke(IPC.SETTINGS_SAVE, { theme: 'dark' })).resolves.toBe(true);

    expect(nativeTheme.themeSource).toBe('dark');
  });
});
