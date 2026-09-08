const EventEmitter = require('events');
const { createAppMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

function loadUpdaterModule(activeProfile, options = {}) {
  const autoUpdater = new EventEmitter();
  autoUpdater.logger = null;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.requestHeaders = null;
  autoUpdater.quitAndInstall = jest.fn();
  autoUpdater.checkForUpdates = jest.fn(() => Promise.resolve());
  autoUpdater.setFeedURL = jest.fn();

  const logger = {
    transports: { file: { level: 'info' } },
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const tryAcquireUpdaterOwnerLock = options.tryAcquireUpdaterOwnerLock || jest.fn(() => ({
    released: false,
    release: jest.fn(),
  }));

  const app = {
    ...createAppMock(),
    getVersion: jest.fn(() => '0.0.0-test'),
    getAppPath: jest.fn(() => '/tmp/freedom-app'),
  };

  const { mod, ipcMain } = loadMainModule(require.resolve('./updater'), {
    app,
    extraMocks: {
      'electron-updater': () => ({ autoUpdater }),
      [require.resolve('./logger')]: () => logger,
      [require.resolve('./settings-store')]: () => ({
        loadSettings: jest.fn(() => ({ autoUpdate: true })),
      }),
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: jest.fn(() => activeProfile),
      }),
      [require.resolve('./updater-owner-lock')]: () => ({
        releaseUpdaterOwnerLock: jest.fn(),
        tryAcquireUpdaterOwnerLock,
      }),
    },
  });

  return { mod, autoUpdater, ipcMain, tryAcquireUpdaterOwnerLock };
}

describe('updater profile relaunch behavior', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('allows restart when the default catalog profile owns install', () => {
    const { mod } = loadUpdaterModule({
      id: 'default',
      displayName: 'Default',
      source: 'catalog',
    });

    expect(mod.getInstallRelaunchMode()).toEqual({
      autoRunAfterInstall: true,
      actionLabel: 'Install now',
      menuLabel: 'Install Update and Restart…',
      readyMessage: null,
    });
  });

  test('uses install-and-close for named catalog profiles', () => {
    const { mod } = loadUpdaterModule({
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
    });

    expect(mod.getInstallRelaunchMode()).toMatchObject({
      autoRunAfterInstall: false,
      actionLabel: 'Install and close',
      menuLabel: 'Install Update and Close…',
    });
  });

  test('uses install-and-close for explicit profile directories', () => {
    const { mod } = loadUpdaterModule({
      id: 'default',
      displayName: 'Default',
      source: 'profile-dir',
    });

    expect(mod.getInstallRelaunchMode()).toMatchObject({
      autoRunAfterInstall: false,
      actionLabel: 'Install and close',
      menuLabel: 'Install Update and Close…',
    });
  });

  test('install action disables auto-run for named profiles', () => {
    const { mod, autoUpdater } = loadUpdaterModule({
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
    });

    autoUpdater.emit('update-downloaded', { version: '1.2.3' });
    mod.installUpdate();

    expect(autoUpdater.autoRunAppAfterInstall).toBe(false);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, false);
  });

  test('install IPC reuses profile-aware install behavior', () => {
    const { autoUpdater, ipcMain } = loadUpdaterModule({
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
    });

    autoUpdater.emit('update-downloaded', { version: '1.2.3' });
    ipcMain.emit('update:restart-and-install');

    expect(autoUpdater.autoRunAppAfterInstall).toBe(false);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, false);
  });

  test('non-owner profile retries and starts update checks after ownership transfers', async () => {
    jest.useFakeTimers();
    const transferredLock = {
      released: false,
      release: jest.fn(),
    };
    const tryAcquireUpdaterOwnerLock = jest.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(transferredLock);
    const { mod, autoUpdater } = loadUpdaterModule({
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
      appRoot: '/tmp/freedom-app-root',
    }, {
      tryAcquireUpdaterOwnerLock,
    });

    expect(mod.initUpdater(null, null, {
      profile: {
        id: 'work',
        displayName: 'Work',
        source: 'catalog',
        appRoot: '/tmp/freedom-app-root',
      },
      ownershipRetryMs: 100,
    })).toBe(false);
    expect(mod.hasUpdaterOwnership()).toBe(false);

    jest.advanceTimersByTime(100);

    expect(mod.hasUpdaterOwnership()).toBe(true);
    expect(tryAcquireUpdaterOwnerLock).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(10000);
    await Promise.resolve();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
