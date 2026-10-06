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
  if (options.isUpdaterActive) autoUpdater.isUpdaterActive = options.isUpdaterActive;

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

  const settings = { autoUpdate: options.autoUpdate ?? true };
  const settingsListeners = [];
  // Flip the auto-update switch the way a Settings save does.
  const setAutoUpdate = (value) => {
    const previous = { ...settings };
    settings.autoUpdate = value;
    for (const listener of settingsListeners) listener({ ...settings }, previous);
  };

  const webContentsList = options.webContentsList || [{ send: jest.fn() }];
  const dialog = { showMessageBox: jest.fn(), showErrorBox: jest.fn() };
  const { mod, ipcMain } = loadMainModule(require.resolve('./updater'), {
    app,
    webContentsList,
    dialog,
    extraMocks: {
      'electron-updater': () => ({ autoUpdater }),
      [require.resolve('./logger')]: () => logger,
      [require.resolve('./settings-store')]: () => ({
        loadSettings: jest.fn(() => ({ autoUpdate: settings.autoUpdate })),
        onSettingsChanged: jest.fn((listener) => settingsListeners.push(listener)),
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

  return {
    mod,
    autoUpdater,
    ipcMain,
    tryAcquireUpdaterOwnerLock,
    webContentsList,
    dialog,
    setAutoUpdate,
  };
}

const DEFAULT_PROFILE = { id: 'default', displayName: 'Default', source: 'catalog' };

// Every `update:state` payload broadcast to a webContents, in order.
function broadcasts(wc) {
  return wc.send.mock.calls
    .filter(([channel]) => channel === 'update:state')
    .map(([, state]) => state);
}

// Settle the `.then` on autoUpdater.checkForUpdates() (microtasks only, so it
// works under fake timers).
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

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

describe('update state broadcast and IPC (#87)', () => {
  const savedEnv = { NODE_ENV: process.env.NODE_ENV, ENABLE_DEV_UPDATER: process.env.ENABLE_DEV_UPDATER };

  beforeEach(() => {
    // initUpdater arms a 10s first check and a 6h interval; fake timers keep
    // them from holding Jest open.
    jest.useFakeTimers();
    delete process.env.NODE_ENV;
    delete process.env.ENABLE_DEV_UPDATER;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete globalThis.__FREEDOM_TEST_UPDATER__;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('before initUpdater the state is unsupported/inactive, readable over IPC', async () => {
    const { ipcMain } = loadUpdaterModule(DEFAULT_PROFILE);
    const state = await ipcMain.invoke('update:get-state');
    expect(state).toMatchObject({
      status: 'unsupported',
      reason: 'inactive',
      currentVersion: '0.0.0-test',
      canCheck: false,
      message: "Updates aren't checked in this session.",
    });
  });

  test('the owner process goes idle and every updater event is broadcast to all webContents', async () => {
    const second = { send: jest.fn() };
    const { mod, autoUpdater, ipcMain, webContentsList } = loadUpdaterModule(DEFAULT_PROFILE, {
      webContentsList: [{ send: jest.fn() }, second],
    });

    expect(mod.initUpdater(null, null, { profile: DEFAULT_PROFILE })).toBe(true);
    expect(mod.getUpdateState()).toMatchObject({ status: 'idle', canCheck: true });

    // The scheduled first check: `checking` is broadcast before the network
    // answers, electron-updater's own checking-for-update is a no-op on top.
    jest.advanceTimersByTime(10000);
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-available', { version: '9.9.9' });
    autoUpdater.emit('download-progress', {
      percent: 42,
      bytesPerSecond: 1000,
      transferred: 420,
      total: 1000,
    });
    autoUpdater.emit('update-downloaded', { version: '9.9.9' });

    const sent = broadcasts(webContentsList[0]);
    expect(sent.map((state) => state.status)).toEqual([
      'idle',
      'checking',
      'downloading',
      'downloading',
      'ready',
    ]);
    expect(sent[3]).toMatchObject({ percent: 42, version: '9.9.9', message: 'Downloading Freedom 9.9.9… 42%' });
    expect(sent[4]).toMatchObject({
      status: 'ready',
      version: '9.9.9',
      installLabel: 'Restart to update',
      menuInstallLabel: 'Restart to Update',
      canCheck: false,
    });
    expect(broadcasts(second)).toEqual(sent);
    // The dead `update-progress` channel is gone.
    expect(webContentsList[0].send).not.toHaveBeenCalledWith('update-progress', expect.anything());
    await expect(ipcMain.invoke('update:get-state')).resolves.toMatchObject({ status: 'ready' });
  });

  test('named profiles get the install-and-close label', () => {
    const profile = { id: 'work', displayName: 'Work', source: 'catalog' };
    const { mod, autoUpdater } = loadUpdaterModule(profile);
    mod.initUpdater(null, null, { profile });
    autoUpdater.emit('update-downloaded', { version: '9.9.9' });
    expect(mod.getUpdateState()).toMatchObject({
      installLabel: 'Install update and close',
      menuInstallLabel: 'Install Update and Close',
      installNote: expect.stringContaining('Freedom will close after installing'),
    });
  });

  test('update-not-available ends up-to-date; a network error is an error state without the raw message', () => {
    const { mod, autoUpdater } = loadUpdaterModule(DEFAULT_PROFILE);
    mod.initUpdater(null, null, { profile: DEFAULT_PROFILE });

    mod.checkForUpdates();
    expect(mod.getUpdateState().status).toBe('checking');
    autoUpdater.emit('update-not-available', {});
    expect(mod.getUpdateState()).toMatchObject({ status: 'up-to-date', canCheck: true });
    expect(mod.getUpdateState().lastChecked).toEqual(expect.any(Number));

    mod.checkForUpdates();
    autoUpdater.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED https://freedom.baby/x'));
    const state = mod.getUpdateState();
    expect(state).toMatchObject({ status: 'error', error: 'network', canCheck: true });
    expect(JSON.stringify(state)).not.toContain('freedom.baby/x');
  });

  test('idle and error lines only promise background checks while the auto-update switch is on', () => {
    const { mod, autoUpdater, webContentsList, setAutoUpdate } = loadUpdaterModule(
      DEFAULT_PROFILE,
      { autoUpdate: false }
    );
    mod.initUpdater(null, null, { profile: DEFAULT_PROFILE });
    expect(mod.getUpdateState()).toMatchObject({
      status: 'idle',
      message: 'Automatic update checks are off.',
    });

    // Check now still works with the switch off; a failure must not promise a retry.
    mod.checkForUpdates({ manual: true });
    autoUpdater.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'));
    expect(mod.getUpdateState().message).toBe(
      "Couldn't reach the update server. Automatic checks are off, so Freedom won't retry on its own."
    );

    // Turning the switch on re-broadcasts the reworded line to open surfaces.
    const wc = webContentsList[0];
    const before = broadcasts(wc).length;
    setAutoUpdate(true);
    expect(broadcasts(wc).slice(before)).toEqual([
      expect.objectContaining({
        status: 'error',
        message: "Couldn't reach the update server. Freedom will try again later.",
      }),
    ]);

    // A save that leaves the switch alone doesn't re-broadcast.
    const after = broadcasts(wc).length;
    setAutoUpdate(true);
    expect(broadcasts(wc).length).toBe(after);
  });

  test('a missing app-update.yml marks the build unsupported', () => {
    const { mod, autoUpdater } = loadUpdaterModule(DEFAULT_PROFILE);
    mod.initUpdater(null, null, { profile: DEFAULT_PROFILE });
    autoUpdater.emit('error', new Error('ENOENT: no such file or directory, open app-update.yml'));
    expect(mod.getUpdateState()).toMatchObject({ status: 'unsupported', reason: 'build' });
  });

  test('a check electron-updater silently declines (null answer) does not stick on checking', async () => {
    const { mod, autoUpdater } = loadUpdaterModule(DEFAULT_PROFILE);
    autoUpdater.checkForUpdates = jest.fn(() => Promise.resolve(null));
    mod.initUpdater(null, null, { profile: DEFAULT_PROFILE });

    mod.checkForUpdates();
    expect(mod.getUpdateState().status).toBe('checking');
    await flush();
    expect(mod.getUpdateState()).toMatchObject({ status: 'unsupported', reason: 'build' });
  });

  test('a build electron-updater reports inactive is unsupported from the start', () => {
    const { mod, autoUpdater } = loadUpdaterModule(DEFAULT_PROFILE, {
      isUpdaterActive: jest.fn(() => false),
    });
    expect(mod.initUpdater(null, null, { profile: DEFAULT_PROFILE })).toBe(true);
    expect(mod.getUpdateState()).toMatchObject({ status: 'unsupported', reason: 'build', canCheck: false });
    mod.checkForUpdates();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mod.getUpdateState().status).toBe('unsupported');
  });

  test('a dev checkout without ENABLE_DEV_UPDATER says so', () => {
    process.env.NODE_ENV = 'development';
    const { mod } = loadUpdaterModule(DEFAULT_PROFILE);
    mod.initUpdater(null, null, { profile: DEFAULT_PROFILE });
    expect(mod.getUpdateState()).toMatchObject({
      status: 'unsupported',
      reason: 'development',
      message: 'Updates are off in development builds.',
    });
  });

  test('a non-owner profile is unsupported until it takes over the updater', () => {
    const profile = { ...DEFAULT_PROFILE, appRoot: '/tmp/freedom-app-root' };
    const tryAcquireUpdaterOwnerLock = jest
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ released: false, release: jest.fn() });
    const { mod } = loadUpdaterModule(profile, { tryAcquireUpdaterOwnerLock });

    expect(mod.initUpdater(null, null, { profile, ownershipRetryMs: 100 })).toBe(false);
    expect(mod.getUpdateState()).toMatchObject({ status: 'unsupported', reason: 'not-owner' });

    jest.advanceTimersByTime(100);
    expect(mod.getUpdateState()).toMatchObject({ status: 'idle', reason: null });
  });

  test('"Check now" works with the automatic-check switch off; the background check does not', () => {
    const { mod, autoUpdater, dialog } = loadUpdaterModule(DEFAULT_PROFILE, { autoUpdate: false });
    mod.initUpdater(null, null, { profile: DEFAULT_PROFILE });

    jest.advanceTimersByTime(10000);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    mod.checkForUpdates();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(mod.getUpdateState().status).toBe('checking');
  });

  test('the update:check IPC runs a manual check', () => {
    const { mod, autoUpdater, ipcMain } = loadUpdaterModule(DEFAULT_PROFILE);
    mod.initUpdater(null, null, { profile: DEFAULT_PROFILE });
    ipcMain.emit('update:check');
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('the E2E recorder intercepts check and install without touching electron-updater', () => {
    const record = jest.fn();
    globalThis.__FREEDOM_TEST_UPDATER__ = { record };
    const { mod, autoUpdater, ipcMain, dialog } = loadUpdaterModule(DEFAULT_PROFILE);
    autoUpdater.emit('update-downloaded', { version: '9.9.9' });

    ipcMain.emit('update:check');
    ipcMain.emit('update:restart-and-install');
    mod.installUpdate();

    expect(record.mock.calls).toEqual([['check'], ['install'], ['install']]);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
