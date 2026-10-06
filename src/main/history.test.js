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

// #503: the address bar and the History page get bounded queries, answered
// by the search worker (real worker_threads, real SQLite file here).
describe('history bounded queries', () => {
  let userDataDir;
  let historyModule;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    historyModule = null;
  });

  afterEach(() => {
    historyModule?.closeDb();
    removeTempUserDataDir(userDataDir);
  });

  const load = (extraMocks) => {
    const ipcMain = createIpcMainMock();
    const ctx = loadMainModule(require.resolve('./history'), { userDataDir, ipcMain, extraMocks });
    historyModule = ctx.mod;
    ctx.mod.registerHistoryIpc();
    return { mod: ctx.mod, ipcMain };
  };

  const seed = (mod) => {
    mod.addHistoryEntry({ url: 'https://alpha.example/', title: 'Alpha', protocol: 'https' });
    mod.addHistoryEntry({ url: 'https://beta.example/', title: 'Beta', protocol: 'https' });
    mod.addHistoryEntry({ url: 'https://alpha.example/', title: 'Alpha', protocol: 'https' });
  };

  test('history:autocomplete and history:page answer from the worker', async () => {
    const { mod, ipcMain } = load();
    seed(mod);

    await expect(ipcMain.invoke(IPC.HISTORY_AUTOCOMPLETE, { query: 'ALPHA' })).resolves.toEqual([
      expect.objectContaining({ url: 'https://alpha.example/', visit_count: 2 }),
    ]);
    await expect(ipcMain.invoke(IPC.HISTORY_AUTOCOMPLETE, { query: 42 })).resolves.toEqual([]);
    await expect(
      ipcMain.invoke(IPC.HISTORY_PAGE, { query: '', sort: 'visited', offset: 0, limit: 1 })
    ).resolves.toEqual({
      entries: [expect.objectContaining({ url: 'https://alpha.example/' })],
      matched: 2,
      total: 2,
    });
    await expect(ipcMain.invoke(IPC.HISTORY_PAGE, null)).resolves.toEqual(
      expect.objectContaining({ matched: 2, total: 2 })
    );
  });

  test('falls back to the main thread when the worker cannot run', async () => {
    const realHost = jest.requireActual('./history-search-host');
    const runInWorker = jest.fn(() =>
      Promise.reject(new realHost.HistorySearchUnavailable('no worker'))
    );
    const { mod, ipcMain } = load({
      [require.resolve('./history-search-host')]: () => ({ ...realHost, runInWorker }),
    });
    seed(mod);

    await expect(ipcMain.invoke(IPC.HISTORY_AUTOCOMPLETE, { query: 'beta' })).resolves.toEqual([
      expect.objectContaining({ url: 'https://beta.example/' }),
    ]);
    await expect(ipcMain.invoke(IPC.HISTORY_PAGE, { query: 'beta' })).resolves.toEqual(
      expect.objectContaining({ matched: 1, total: 2 })
    );
    expect(runInWorker).toHaveBeenCalledTimes(2);
  });

  test('a timed-out suggestion lookup yields no history rather than an error', async () => {
    const realHost = jest.requireActual('./history-search-host');
    const runInWorker = jest.fn(() => Promise.reject(new realHost.HistorySearchTimeout('slow')));
    const { mod, ipcMain } = load({
      [require.resolve('./history-search-host')]: () => ({ ...realHost, runInWorker }),
    });
    seed(mod);

    await expect(ipcMain.invoke(IPC.HISTORY_AUTOCOMPLETE, { query: 'beta' })).resolves.toEqual([]);
    // The History page reports it instead.
    await expect(ipcMain.invoke(IPC.HISTORY_PAGE, { query: 'beta' })).rejects.toThrow('slow');
  });

  test('history:get without a limit no longer returns the whole table', async () => {
    const { mod, ipcMain } = load();
    mod.getDb().transaction(() => {
      for (let i = 0; i < 1010; i++) {
        mod.addHistoryEntry({ url: `https://x.example/${i}`, title: 'x', protocol: 'https' });
      }
    })();

    await expect(ipcMain.invoke(IPC.HISTORY_GET)).resolves.toHaveLength(1000);
    await expect(ipcMain.invoke(IPC.HISTORY_GET, { limit: 5000 })).resolves.toHaveLength(1000);
    await expect(ipcMain.invoke(IPC.HISTORY_GET, { limit: 3 })).resolves.toHaveLength(3);
    await expect(ipcMain.invoke(IPC.HISTORY_GET, { query: 'x.example' })).resolves.toHaveLength(50);
    // SQLite reads LIMIT -1 as unlimited: a negative limit must not lift the cap.
    await expect(ipcMain.invoke(IPC.HISTORY_GET, { limit: -1 })).resolves.toHaveLength(1000);
    await expect(ipcMain.invoke(IPC.HISTORY_GET, { limit: 0.5 })).resolves.toHaveLength(1000);
    await expect(ipcMain.invoke(IPC.HISTORY_GET, { limit: 'abc' })).resolves.toHaveLength(1000);
    await expect(
      ipcMain.invoke(IPC.HISTORY_GET, { query: 'x.example', limit: -1 })
    ).resolves.toHaveLength(50);
    await expect(
      ipcMain.invoke(IPC.HISTORY_GET, { query: 'x.example', limit: 5000 })
    ).resolves.toHaveLength(1000);
  });
});

// PRIVATE MODE GUARD coverage: history:add from a private window's
// webContents is rejected in the main process, regardless of what the
// renderer sends.
describe('history private-window guard', () => {
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

  const loadWithPrivateMock = () => {
    const ipcMain = createIpcMainMock();
    // loadHistoryModule pins its own extraMocks, so go through
    // loadMainModule directly to also stub the private-window registry.
    const ctx = loadMainModule(require.resolve('./history'), {
      userDataDir,
      ipcMain,
      extraMocks: {
        'better-sqlite3': () => FakeBetterSqlite3Database,
        [require.resolve('./private/private-windows')]: () => ({
          isPrivateWebContents: (wc) => wc?.isPrivate === true,
        }),
      },
    });
    historyModule = ctx.mod;
    ctx.mod.registerHistoryIpc();
    return { ctx, ipcMain };
  };

  test('history:add from a private sender writes nothing', () => {
    const { ipcMain } = loadWithPrivateMock();
    const handler = ipcMain.handlers.get(IPC.HISTORY_ADD);

    const result = handler(
      { sender: { isPrivate: true } },
      { url: 'https://secret.example', title: 'Secret', protocol: 'https' }
    );

    expect(result).toBeNull();
    expect(historyModule.getHistoryCount()).toBe(0);
  });

  test('history:add from a normal sender still records', () => {
    const { ipcMain } = loadWithPrivateMock();
    const handler = ipcMain.handlers.get(IPC.HISTORY_ADD);

    const result = handler(
      { sender: { isPrivate: false } },
      { url: 'https://public.example', title: 'Public', protocol: 'https' }
    );

    expect(result).toEqual(expect.objectContaining({ url: 'https://public.example' }));
    expect(historyModule.getHistoryCount()).toBe(1);
  });
});
