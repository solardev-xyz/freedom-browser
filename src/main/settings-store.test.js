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
  return loadMainModule(require.resolve('./settings-store'), {
    ...options,
    extraMocks: {
      ...(options.extraMocks || {}),
      [require.resolve('./logger')]: () => ({
        error: jest.fn(),
      }),
    },
  });
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
        enableRadicleIntegration: false,
        enableIdentityWallet: true,
        beeNodeMode: 'ultraLight',
        startBeeAtLaunch: true,
        startIpfsAtLaunch: true,
        startRadicleAtLaunch: false,
        autoUpdate: true,
        showBookmarkBar: false,
        sidebarOpen: false,
        sidebarWidth: 320,
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
      })
    );
    expect(nativeTheme.themeSource).toBe('system');
  });

  test('merges persisted settings with defaults and applies the saved theme', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', autoUpdate: false, beeNodeMode: 'light' }),
      'utf-8'
    );

    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.loadSettings()).toEqual(
      expect.objectContaining({
        theme: 'dark',
        autoUpdate: false,
        beeNodeMode: 'light',
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
        beeNodeMode: 'ultraLight',
        autoUpdate: true,
      })
    );
    expect(nativeTheme.themeSource).toBe('system');
  });

  test('saveSettings persists a merged payload and updates the theme', () => {
    const { mod, nativeTheme } = loadSettingsStore({ userDataDir });

    expect(mod.saveSettings({ theme: 'light', autoUpdate: false, beeNodeMode: 'light' })).toBe(
      true
    );

    expect(
      JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8'))
    ).toEqual(
      expect.objectContaining({
        theme: 'light',
        autoUpdate: false,
        beeNodeMode: 'light',
        startBeeAtLaunch: true,
      })
    );
    expect(nativeTheme.themeSource).toBe('light');
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

  test('saveSettings drops keys that are not part of DEFAULT_SETTINGS', () => {
    const { mod } = loadSettingsStore({ userDataDir });

    expect(mod.saveSettings({ theme: 'light', injected: 'value', extra: 1 })).toBe(true);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8')
    );
    expect(persisted.theme).toBe('light');
    expect(persisted).not.toHaveProperty('injected');
    expect(persisted).not.toHaveProperty('extra');
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

  test('registers IPC handlers for loading and saving settings', async () => {
    const ipcMain = createIpcMainMock();
    const { mod, nativeTheme } = loadSettingsStore({ userDataDir, ipcMain });

    mod.registerSettingsIpc();

    await expect(ipcMain.invoke(IPC.SETTINGS_GET)).resolves.toEqual(
      expect.objectContaining({
        theme: 'system',
        beeNodeMode: 'ultraLight',
      })
    );
    await expect(ipcMain.invoke(IPC.SETTINGS_SAVE, { theme: 'dark', beeNodeMode: 'light' }))
      .resolves.toBe(true);

    expect(nativeTheme.themeSource).toBe('dark');
  });
});
