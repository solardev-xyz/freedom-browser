const IPC = require('../shared/ipc-channels');
const FakeBetterSqlite3Database = require('../../test/helpers/fake-better-sqlite3');
const {
  createIpcMainMock,
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

function loadHistoryModule(options = {}) {
  return loadMainModule(require.resolve('./history'), {
    ...options,
    extraMocks: {
      'better-sqlite3': () => FakeBetterSqlite3Database,
    },
  });
}

describe('history', () => {
  let userDataDir;
  let historyModule;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    historyModule = null;
  });

  afterEach(() => {
    if (historyModule?.closeDb) {
      historyModule.closeDb();
    }
    removeTempUserDataDir(userDataDir);
  });

  test('adds history entries and returns them from the database', () => {
    const { mod } = loadHistoryModule({ userDataDir });
    historyModule = mod;

    const entry = mod.addHistoryEntry({
      url: 'https://example.com',
      title: 'Example',
      protocol: 'https',
    });

    expect(entry).toEqual(
      expect.objectContaining({
        url: 'https://example.com',
        title: 'Example',
        protocol: 'https',
      })
    );
    expect(mod.getHistoryCount()).toBe(1);
    expect(mod.getAllHistory()).toEqual([
      expect.objectContaining({
        url: 'https://example.com',
        title: 'Example',
        protocol: 'https',
        visit_count: 1,
      }),
    ]);
  });

  test('upserts duplicate URLs and increments visit count', () => {
    const { mod } = loadHistoryModule({ userDataDir });
    historyModule = mod;

    mod.addHistoryEntry({
      url: 'https://example.com',
      title: 'First title',
      protocol: 'https',
    });
    mod.addHistoryEntry({
      url: 'https://example.com',
      title: 'Updated title',
      protocol: 'https',
    });

    expect(mod.getHistoryCount()).toBe(1);
    expect(mod.getAllHistory()).toEqual([
      expect.objectContaining({
        url: 'https://example.com',
        title: 'Updated title',
        visit_count: 2,
      }),
    ]);
  });

  test('searches, removes, and clears history entries', () => {
    const { mod } = loadHistoryModule({ userDataDir });
    historyModule = mod;

    mod.addHistoryEntry({
      url: 'https://example.com',
      title: 'Example',
      protocol: 'https',
    });
    mod.addHistoryEntry({
      url: 'https://freedom.browser',
      title: 'Freedom',
      protocol: 'https',
    });

    const searchResults = mod.searchHistory('Freedom');
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].url).toBe('https://freedom.browser');

    expect(mod.removeHistoryEntry(searchResults[0].id)).toBe(true);
    expect(mod.getHistoryCount()).toBe(1);
    expect(mod.clearHistory()).toBe(1);
    expect(mod.getHistoryCount()).toBe(0);
  });

  test('registers IPC handlers for history workflows', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadHistoryModule({ userDataDir, ipcMain });
    historyModule = mod;

    mod.registerHistoryIpc();

    await expect(ipcMain.invoke(IPC.HISTORY_ADD, {})).resolves.toBeNull();

    const created = await ipcMain.invoke(IPC.HISTORY_ADD, {
      url: 'https://example.com',
      title: 'Example',
      protocol: 'https',
    });
    expect(created).toEqual(
      expect.objectContaining({
        url: 'https://example.com',
        title: 'Example',
      })
    );

    await expect(ipcMain.invoke(IPC.HISTORY_GET, { limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        url: 'https://example.com',
      }),
    ]);
    await expect(ipcMain.invoke(IPC.HISTORY_REMOVE, created.id)).resolves.toBe(true);
    await expect(ipcMain.invoke(IPC.HISTORY_CLEAR)).resolves.toBe(0);
  });
});
