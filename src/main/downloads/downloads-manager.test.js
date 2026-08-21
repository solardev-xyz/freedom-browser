const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const IPC = require('../../shared/ipc-channels');
const FakeBetterSqlite3DownloadsDatabase = require('../../../test/helpers/fake-better-sqlite3-downloads');
const {
  createIpcMainMock,
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');

class FakeDownloadItem extends EventEmitter {
  constructor({ url, filename, mimeType = 'application/octet-stream', totalBytes = 0 } = {}) {
    super();
    this.url = url;
    this.filename = filename;
    this.mimeType = mimeType;
    this.totalBytes = totalBytes;
    this.receivedBytes = 0;
    this.savePath = '';
    this.saveDialogOptions = null;
    this.paused = false;
    this.resumable = false;
    this.pause = jest.fn(() => {
      this.paused = true;
      this.resumable = true;
    });
    this.resume = jest.fn(() => {
      this.paused = false;
    });
    this.cancel = jest.fn();
  }

  getURL() {
    return this.url;
  }
  getFilename() {
    return this.filename;
  }
  getMimeType() {
    return this.mimeType;
  }
  getTotalBytes() {
    return this.totalBytes;
  }
  getReceivedBytes() {
    return this.receivedBytes;
  }
  setSavePath(savePath) {
    this.savePath = savePath;
  }
  getSavePath() {
    return this.savePath;
  }
  setSaveDialogOptions(options) {
    this.saveDialogOptions = options;
  }
  isPaused() {
    return this.paused;
  }
  canResume() {
    return this.resumable;
  }
}

describe('downloads-manager', () => {
  let userDataDir;
  let downloadsDir;
  let ipcMain;
  let ownerWindow;
  let session;
  let shell;

  const loadManager = () => {
    ipcMain = createIpcMainMock();
    ownerWindow = {
      isDestroyed: () => false,
      webContents: { send: jest.fn() },
    };
    shell = {
      openPath: jest.fn(async () => ''),
      showItemInFolder: jest.fn(),
    };
    const { mod } = loadMainModule(require.resolve('./downloads-manager'), {
      userDataDir,
      appPaths: { userData: userDataDir, downloads: downloadsDir },
      ipcMain,
      electronOverrides: {
        shell,
        BrowserWindow: {
          getAllWindows: jest.fn(() => [ownerWindow]),
          fromWebContents: jest.fn(() => ownerWindow),
        },
        webContents: { getAllWebContents: jest.fn(() => []) },
      },
      extraMocks: {
        'better-sqlite3': () => FakeBetterSqlite3DownloadsDatabase,
      },
    });
    session = new EventEmitter();
    mod.attachDownloadsManager(session);
    mod.registerDownloadsIpc();
    return mod;
  };

  const startDownload = (itemProps) => {
    const item = new FakeDownloadItem(itemProps);
    const webContents = { hostWebContents: { id: 42 } };
    session.emit('will-download', {}, item, webContents);
    return item;
  };

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    downloadsDir = path.join(userDataDir, 'downloads');
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  describe('sanitizeFilename', () => {
    test('strips directory components and traversal', () => {
      const { mod } = loadMainModule(require.resolve('./downloads-manager'), {
        userDataDir,
        extraMocks: { 'better-sqlite3': () => FakeBetterSqlite3DownloadsDatabase },
      });
      expect(mod.sanitizeFilename('../../etc/passwd')).toBe('passwd');
      expect(mod.sanitizeFilename('dir\\sub\\file.txt')).toBe('file.txt');
      expect(mod.sanitizeFilename('..\\..\\boot.ini')).toBe('boot.ini');
    });

    test('removes control characters and unsafe punctuation', () => {
      const { mod } = loadMainModule(require.resolve('./downloads-manager'), {
        userDataDir,
        extraMocks: { 'better-sqlite3': () => FakeBetterSqlite3DownloadsDatabase },
      });
      expect(mod.sanitizeFilename('a\x00b\x1fc.txt')).toBe('abc.txt');
      expect(mod.sanitizeFilename('re<po>rt:v1?.pdf')).toBe('re_po_rt_v1_.pdf');
    });

    test('rejects hidden-file dots and empty names', () => {
      const { mod } = loadMainModule(require.resolve('./downloads-manager'), {
        userDataDir,
        extraMocks: { 'better-sqlite3': () => FakeBetterSqlite3DownloadsDatabase },
      });
      expect(mod.sanitizeFilename('...bashrc')).toBe('bashrc');
      expect(mod.sanitizeFilename('')).toBe('download');
      expect(mod.sanitizeFilename('..')).toBe('download');
      expect(mod.sanitizeFilename(null)).toBe('download');
    });

    test('strips trailing dots and defangs Windows reserved device names', () => {
      const { mod } = loadMainModule(require.resolve('./downloads-manager'), {
        userDataDir,
        extraMocks: { 'better-sqlite3': () => FakeBetterSqlite3DownloadsDatabase },
      });
      expect(mod.sanitizeFilename('report.pdf.')).toBe('report.pdf');
      expect(mod.sanitizeFilename('notes.txt. . ')).toBe('notes.txt');
      expect(mod.sanitizeFilename('CON')).toBe('_CON');
      expect(mod.sanitizeFilename('con.txt')).toBe('_con.txt');
      expect(mod.sanitizeFilename('NUL.tar.gz')).toBe('_NUL.tar.gz');
      expect(mod.sanitizeFilename('COM1')).toBe('_COM1');
      expect(mod.sanitizeFilename('LPT9.log')).toBe('_LPT9.log');
      // Not reserved: prefix-similar names pass through untouched.
      expect(mod.sanitizeFilename('CONSOLE.txt')).toBe('CONSOLE.txt');
      expect(mod.sanitizeFilename('COM10.txt')).toBe('COM10.txt');
    });

    test('caps overlong names while keeping the extension', () => {
      const { mod } = loadMainModule(require.resolve('./downloads-manager'), {
        userDataDir,
        extraMocks: { 'better-sqlite3': () => FakeBetterSqlite3DownloadsDatabase },
      });
      const long = 'a'.repeat(400) + '.txt';
      const sanitized = mod.sanitizeFilename(long);
      expect(sanitized.length).toBeLessThanOrEqual(255);
      expect(sanitized.endsWith('.txt')).toBe(true);
    });
  });

  describe('uniqueSavePath', () => {
    test('appends " (n)" before the extension on collision', () => {
      const { mod } = loadMainModule(require.resolve('./downloads-manager'), {
        userDataDir,
        extraMocks: { 'better-sqlite3': () => FakeBetterSqlite3DownloadsDatabase },
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dl-'));
      try {
        expect(mod.uniqueSavePath(dir, 'file.txt')).toBe(path.join(dir, 'file.txt'));
        fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
        expect(mod.uniqueSavePath(dir, 'file.txt')).toBe(path.join(dir, 'file (1).txt'));
        fs.writeFileSync(path.join(dir, 'file (1).txt'), 'x');
        expect(mod.uniqueSavePath(dir, 'file.txt')).toBe(path.join(dir, 'file (2).txt'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('will-download saves to the downloads dir, records the row, and notifies the owner', async () => {
    loadManager();

    const item = startDownload({
      url: 'https://example.com/report.pdf',
      filename: 'report.pdf',
      totalBytes: 2048,
    });

    expect(item.savePath).toBe(path.join(downloadsDir, 'report.pdf'));
    expect(item.saveDialogOptions).toBeNull();

    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        filename: 'report.pdf',
        state: 'in_progress',
        total_bytes: 2048,
      })
    );

    expect(ownerWindow.webContents.send).toHaveBeenCalledWith(
      IPC.DOWNLOADS_UPDATED,
      expect.objectContaining({ id: rows[0].id, state: 'in_progress' })
    );
  });

  test('sanitizes a hostile suggested filename before choosing the save path', () => {
    loadManager();

    const item = startDownload({
      url: 'https://evil.example/x',
      filename: '../../../etc/cron.d/evil',
    });

    expect(item.savePath).toBe(path.join(downloadsDir, 'evil'));
  });

  test('done → completed persists the terminal state and broadcasts it', async () => {
    loadManager();

    const item = startDownload({
      url: 'https://example.com/file.bin',
      filename: 'file.bin',
      totalBytes: 100,
    });
    item.receivedBytes = 100;
    item.emit('done', {}, 'completed');

    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    expect(rows[0]).toEqual(
      expect.objectContaining({
        state: 'completed',
        received_bytes: 100,
        end_time: expect.any(Number),
      })
    );

    const finalCall = ownerWindow.webContents.send.mock.calls.at(-1);
    expect(finalCall[0]).toBe(IPC.DOWNLOADS_UPDATED);
    expect(finalCall[1]).toEqual(expect.objectContaining({ state: 'completed' }));
  });

  test('done → cancelled and interrupted map to their store states', async () => {
    loadManager();

    const cancelled = startDownload({ url: 'https://a.example/a', filename: 'a.bin' });
    const interrupted = startDownload({ url: 'https://b.example/b', filename: 'b.bin' });
    cancelled.emit('done', {}, 'cancelled');
    interrupted.emit('done', {}, 'interrupted');

    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    const byName = Object.fromEntries(rows.map((row) => [row.filename, row.state]));
    expect(byName).toEqual({ 'a.bin': 'cancelled', 'b.bin': 'interrupted' });
  });

  test('pause / resume / cancel IPC act on the live item only', async () => {
    loadManager();

    const item = startDownload({ url: 'https://example.com/big.iso', filename: 'big.iso' });
    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    const id = rows[0].id;

    await expect(ipcMain.invoke(IPC.DOWNLOADS_PAUSE, id)).resolves.toBe(true);
    expect(item.pause).toHaveBeenCalled();
    await expect(ipcMain.invoke(IPC.DOWNLOADS_RESUME, id)).resolves.toBe(true);
    expect(item.resume).toHaveBeenCalled();
    await expect(ipcMain.invoke(IPC.DOWNLOADS_CANCEL, id)).resolves.toBe(true);
    expect(item.cancel).toHaveBeenCalled();

    // Settled item drops out of the live map — controls become no-ops.
    item.emit('done', {}, 'cancelled');
    await expect(ipcMain.invoke(IPC.DOWNLOADS_PAUSE, id)).resolves.toBe(false);
    await expect(ipcMain.invoke(IPC.DOWNLOADS_CANCEL, id)).resolves.toBe(false);
  });

  test('resume is refused when the item cannot resume', async () => {
    loadManager();

    const item = startDownload({ url: 'https://example.com/x.bin', filename: 'x.bin' });
    item.resumable = false;
    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});

    await expect(ipcMain.invoke(IPC.DOWNLOADS_RESUME, rows[0].id)).resolves.toBe(false);
    expect(item.resume).not.toHaveBeenCalled();
  });

  test('ask-where-to-save routes through the native save dialog', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ askWhereToSave: true }),
      'utf-8'
    );
    loadManager();

    const item = startDownload({ url: 'https://example.com/pick.bin', filename: 'pick.bin' });

    expect(item.savePath).toBe('');
    expect(item.saveDialogOptions).toEqual({
      defaultPath: path.join(downloadsDir, 'pick.bin'),
    });
  });

  test('open-file refuses incomplete downloads and missing files, never auto-opens', async () => {
    loadManager();

    const item = startDownload({ url: 'https://example.com/doc.pdf', filename: 'doc.pdf' });
    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    const id = rows[0].id;

    // In progress → refused.
    await expect(ipcMain.invoke(IPC.DOWNLOADS_OPEN_FILE, id)).resolves.toEqual(
      expect.objectContaining({ success: false })
    );

    // Completed but the file is gone → refused.
    item.emit('done', {}, 'completed');
    await expect(ipcMain.invoke(IPC.DOWNLOADS_OPEN_FILE, id)).resolves.toEqual(
      expect.objectContaining({ success: false, error: 'File no longer exists' })
    );
    expect(shell.openPath).not.toHaveBeenCalled();

    // Completed with the file on disk → opens.
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.writeFileSync(item.savePath, 'content');
    await expect(ipcMain.invoke(IPC.DOWNLOADS_OPEN_FILE, id)).resolves.toEqual({ success: true });
    expect(shell.openPath).toHaveBeenCalledWith(item.savePath);
  });

  test('show-in-folder resolves the stored path, not renderer input', async () => {
    loadManager();

    const item = startDownload({ url: 'https://example.com/pic.png', filename: 'pic.png' });
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.writeFileSync(item.savePath, 'content');
    item.emit('done', {}, 'completed');
    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});

    await expect(ipcMain.invoke(IPC.DOWNLOADS_SHOW_IN_FOLDER, rows[0].id)).resolves.toEqual({
      success: true,
    });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(item.savePath);
  });

  test('remove refuses in-flight downloads and clear keeps them', async () => {
    loadManager();

    const active = startDownload({ url: 'https://example.com/live.bin', filename: 'live.bin' });
    const settled = startDownload({ url: 'https://example.com/old.bin', filename: 'old.bin' });
    settled.emit('done', {}, 'completed');

    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    const activeRow = rows.find((row) => row.filename === 'live.bin');
    const settledRow = rows.find((row) => row.filename === 'old.bin');

    await expect(ipcMain.invoke(IPC.DOWNLOADS_REMOVE, activeRow.id)).resolves.toBe(false);
    await expect(ipcMain.invoke(IPC.DOWNLOADS_REMOVE, settledRow.id)).resolves.toBe(true);

    await expect(ipcMain.invoke(IPC.DOWNLOADS_CLEAR)).resolves.toBe(0);
    const remaining = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].filename).toBe('live.bin');
    // Keep `active` referenced so the live map survives until here.
    expect(active.cancel).not.toHaveBeenCalled();
  });

  test('collision with an existing file lands on a numbered filename', () => {
    loadManager();

    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.writeFileSync(path.join(downloadsDir, 'dup.txt'), 'existing');

    const item = startDownload({ url: 'https://example.com/dup.txt', filename: 'dup.txt' });
    expect(item.savePath).toBe(path.join(downloadsDir, 'dup (1).txt'));
  });

  test('concurrent same-name downloads never share a save path', () => {
    loadManager();

    // Chromium creates the file lazily, so nothing exists on disk yet when
    // the second will-download fires — only the in-flight claim separates them.
    const first = startDownload({ url: 'https://a.example/report.pdf', filename: 'report.pdf' });
    const second = startDownload({ url: 'https://b.example/report.pdf', filename: 'report.pdf' });
    const third = startDownload({ url: 'https://c.example/report.pdf', filename: 'report.pdf' });

    expect(first.savePath).toBe(path.join(downloadsDir, 'report.pdf'));
    expect(second.savePath).toBe(path.join(downloadsDir, 'report (1).pdf'));
    expect(third.savePath).toBe(path.join(downloadsDir, 'report (2).pdf'));
    expect(new Set([first.savePath, second.savePath, third.savePath]).size).toBe(3);
  });

  test('a settled download releases its claimed name for reuse', () => {
    loadManager();

    const cancelled = startDownload({ url: 'https://a.example/x.bin', filename: 'x.bin' });
    expect(cancelled.savePath).toBe(path.join(downloadsDir, 'x.bin'));
    // Cancelled — no file left behind, so the plain name is free again.
    cancelled.emit('done', {}, 'cancelled');

    const next = startDownload({ url: 'https://b.example/x.bin', filename: 'x.bin' });
    expect(next.savePath).toBe(path.join(downloadsDir, 'x.bin'));
  });

  test("an 'interrupted' updated-state surfaces resume affordances without settling the row", async () => {
    loadManager();

    const item = startDownload({
      url: 'https://example.com/big.iso',
      filename: 'big.iso',
      totalBytes: 1000,
    });
    item.receivedBytes = 400;
    item.emit('updated', {}, 'progressing');
    const sendCallsBefore = ownerWindow.webContents.send.mock.calls.length;

    // Connection drops: Chromium keeps the item live and resumable.
    item.resumable = true;
    item.emit('updated', {}, 'interrupted');

    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    expect(rows[0]).toEqual(
      expect.objectContaining({
        state: 'in_progress',
        is_interrupted: true,
        is_paused: false,
        can_resume: true,
      })
    );

    // The transition flushes past the progress throttle — the UI must not sit
    // on a stale "still downloading" render.
    expect(ownerWindow.webContents.send.mock.calls.length).toBeGreaterThan(sendCallsBefore);
    expect(ownerWindow.webContents.send.mock.calls.at(-1)[1]).toEqual(
      expect.objectContaining({ state: 'in_progress', is_interrupted: true, can_resume: true })
    );

    // Pause is a no-op on an interrupted item — refused rather than faked.
    await expect(ipcMain.invoke(IPC.DOWNLOADS_PAUSE, rows[0].id)).resolves.toBe(false);
    expect(item.pause).not.toHaveBeenCalled();
    await expect(ipcMain.invoke(IPC.DOWNLOADS_RESUME, rows[0].id)).resolves.toBe(true);
    expect(item.resume).toHaveBeenCalled();

    // Back to progressing → the flag clears.
    item.emit('updated', {}, 'progressing');
    const resumedRows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    expect(resumedRows[0].is_interrupted).toBe(false);
  });

  test("a done 'interrupted' clears the live interrupted flag", async () => {
    loadManager();

    const item = startDownload({ url: 'https://example.com/y.bin', filename: 'y.bin' });
    item.emit('updated', {}, 'interrupted');
    item.emit('done', {}, 'interrupted');

    const rows = await ipcMain.invoke(IPC.DOWNLOADS_GET, {});
    expect(rows[0].state).toBe('interrupted');
    expect(rows[0].is_interrupted).toBeUndefined();
    expect(ownerWindow.webContents.send.mock.calls.at(-1)[1]).toEqual(
      expect.objectContaining({ state: 'interrupted', is_interrupted: false, can_resume: false })
    );
  });
});

// PRIVATE MODE GUARD coverage: private-window downloads must never touch
// the profile SQLite store — their rows live in the in-memory partition
// store, are merged only into the owning private window's queries, and
// evaporate when the partition is dropped. A crash can never leave private
// rows on disk because none are ever written.
describe('downloads-manager private sessions', () => {
  const PARTITION = 'private-e2e';

  // The manager resolves a requester's partition through
  // private-windows.getPartitionForWebContents; the module is mocked below
  // to read this marker property off the fake senders.
  const privateSender = { privatePartition: PARTITION };
  const normalSender = {};

  let userDataDir;
  let downloadsDir;
  let ipcMain;
  let ownerWindow;
  let allWebContents;
  let shell;
  let mod;
  let store;
  let privateStore;
  let log;

  const load = () => {
    ipcMain = createIpcMainMock();
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    allWebContents = [];
    ownerWindow = {
      isDestroyed: () => false,
      webContents: { send: jest.fn() },
    };
    shell = { openPath: jest.fn(async () => ''), showItemInFolder: jest.fn() };
    ({ mod } = loadMainModule(require.resolve('./downloads-manager'), {
      userDataDir,
      appPaths: { userData: userDataDir, downloads: downloadsDir },
      ipcMain,
      electronOverrides: {
        shell,
        BrowserWindow: {
          getAllWindows: jest.fn(() => [ownerWindow]),
          fromWebContents: jest.fn(() => ownerWindow),
        },
        webContents: { getAllWebContents: jest.fn(() => allWebContents) },
      },
      extraMocks: {
        'better-sqlite3': () => FakeBetterSqlite3DownloadsDatabase,
        [require.resolve('../private/private-windows')]: () => ({
          getPartitionForWebContents: (wc) => wc?.privatePartition || null,
        }),
        [require.resolve('../logger')]: () => log,
      },
    }));
    // Same jest module registry → the exact store instances the manager uses.
    store = require('./downloads-store');
    privateStore = require('./private-downloads-store');
  };

  // IPC events carry the requesting sender so partition scoping can be
  // asserted (the shared mock's invoke() always passes an empty event).
  const invokeAs = (sender, channel, ...args) => {
    const handler = ipcMain.handlers.get(channel);
    if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
    return handler({ sender }, ...args);
  };

  const startOn = (session, itemProps) => {
    const item = new FakeDownloadItem(itemProps);
    session.emit('will-download', {}, item, { hostWebContents: { id: 7 } });
    return item;
  };

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    downloadsDir = path.join(userDataDir, 'downloads');
    load();
  });

  afterEach(() => {
    privateStore._resetState();
    store.closeDb();
    removeTempUserDataDir(userDataDir);
  });

  test('a private download never touches the SQLite store', () => {
    const insertSpy = jest.spyOn(store, 'insertDownload');
    const updateSpy = jest.spyOn(store, 'updateDownload');

    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });

    const item = startOn(privateSession, {
      url: 'https://example.com/secret.bin',
      filename: 'secret.bin',
      totalBytes: 100,
    });
    item.receivedBytes = 50;
    item.emit('updated');
    item.receivedBytes = 100;
    item.emit('done', {}, 'completed');

    // Full lifecycle — start, progress, terminal state — with zero SQLite
    // writes; the row lives only in the in-memory partition store.
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(store.getDownloadCount()).toBe(0);
    expect(privateStore.getCount()).toBe(1);
    expect(privateStore.getDownloads(PARTITION)[0]).toEqual(
      expect.objectContaining({
        filename: 'secret.bin',
        state: 'completed',
        received_bytes: 100,
        is_private: 1,
        session_partition: PARTITION,
      })
    );
  });

  // The in-memory private store exists so nothing durable records what was
  // fetched; log.info goes to the persistent <userData>/logs/main.log, which
  // outlives the window and the app, so the filename must not appear there.
  test('a private download never writes its filename to the persistent log', () => {
    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });

    const item = startOn(privateSession, {
      url: 'https://example.com/secret.bin',
      filename: 'secret.bin',
      totalBytes: 100,
    });
    item.emit('done', {}, 'completed');

    // Both the start and the terminal line are emitted (the id is still
    // traceable) — neither carries the filename.
    const lines = log.info.mock.calls.map((call) => call.join(' '));
    expect(lines.filter((line) => line.includes('[Downloads] Download')).length).toBe(2);
    expect(lines.join('\n')).not.toContain('secret.bin');

    // Normal downloads keep the diagnostic filename.
    const normalSession = new EventEmitter();
    mod.attachDownloadsManager(normalSession);
    const normalItem = startOn(normalSession, {
      url: 'https://example.com/public.bin',
      filename: 'public.bin',
      totalBytes: 10,
    });
    normalItem.emit('done', {}, 'completed');
    expect(log.info.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('public.bin');
  });

  test('private rows merge into the private window view only; ids are negative', async () => {
    const defaultSession = new EventEmitter();
    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(defaultSession);
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });
    mod.registerDownloadsIpc();

    startOn(privateSession, { url: 'https://example.com/secret.bin', filename: 'secret.bin' });
    startOn(defaultSession, { url: 'https://example.com/public.bin', filename: 'public.bin' });

    // The owning private window sees the merged view.
    const privateView = await invokeAs(privateSender, IPC.DOWNLOADS_GET, {});
    expect(privateView.map((r) => r.filename).sort()).toEqual(['public.bin', 'secret.bin']);
    const privateRow = privateView.find((r) => r.filename === 'secret.bin');
    expect(privateRow.id).toBeLessThan(0);
    expect(privateRow).toEqual(
      expect.objectContaining({ is_private: 1, session_partition: PARTITION })
    );

    // Normal windows — and other private windows — never see private rows.
    const normalView = await invokeAs(normalSender, IPC.DOWNLOADS_GET, {});
    expect(normalView.map((r) => r.filename)).toEqual(['public.bin']);
    const otherPrivateView = await invokeAs(
      { privatePartition: 'private-other' },
      IPC.DOWNLOADS_GET,
      {}
    );
    expect(otherPrivateView.map((r) => r.filename)).toEqual(['public.bin']);

    // Search queries scope the same way.
    const privateSearch = await invokeAs(privateSender, IPC.DOWNLOADS_GET, { query: 'secret' });
    expect(privateSearch).toHaveLength(1);
    const normalSearch = await invokeAs(normalSender, IPC.DOWNLOADS_GET, { query: 'secret' });
    expect(normalSearch).toHaveLength(0);
  });

  test('private change hints reach only the private window renderers', () => {
    const privateWc = { privatePartition: PARTITION, send: jest.fn() };
    const normalWc = { send: jest.fn() };
    allWebContents.push(privateWc, normalWc);

    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });
    startOn(privateSession, { url: 'https://example.com/secret.bin', filename: 'secret.bin' });

    // Shelf update goes to the owning window; the downloads:changed hint
    // (which carries URL and save path) stays inside the private window.
    expect(ownerWindow.webContents.send).toHaveBeenCalledWith(
      IPC.DOWNLOADS_UPDATED,
      expect.objectContaining({ is_private: 1 })
    );
    expect(privateWc.send).toHaveBeenCalledWith(
      IPC.DOWNLOADS_CHANGED,
      expect.objectContaining({ filename: 'secret.bin' })
    );
    expect(normalWc.send).not.toHaveBeenCalled();
  });

  test('open / show / remove on a private row are refused for other windows', async () => {
    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });
    mod.registerDownloadsIpc();

    fs.mkdirSync(downloadsDir, { recursive: true });
    const item = startOn(privateSession, {
      url: 'https://example.com/secret.pdf',
      filename: 'secret.pdf',
    });
    fs.writeFileSync(item.savePath, 'content');
    item.emit('done', {}, 'completed');

    const [row] = await invokeAs(privateSender, IPC.DOWNLOADS_GET, {});
    expect(row.id).toBeLessThan(0);

    // A normal window cannot act on (or probe) the private row by id.
    await expect(invokeAs(normalSender, IPC.DOWNLOADS_OPEN_FILE, row.id)).resolves.toEqual(
      expect.objectContaining({ success: false })
    );
    expect(await invokeAs(normalSender, IPC.DOWNLOADS_SHOW_IN_FOLDER, row.id)).toEqual(
      expect.objectContaining({ success: false })
    );
    expect(await invokeAs(normalSender, IPC.DOWNLOADS_REMOVE, row.id)).toBe(false);
    expect(shell.openPath).not.toHaveBeenCalled();

    // The owning private window can.
    await expect(invokeAs(privateSender, IPC.DOWNLOADS_OPEN_FILE, row.id)).resolves.toEqual({
      success: true,
    });
    expect(shell.openPath).toHaveBeenCalledWith(item.savePath);
    expect(await invokeAs(privateSender, IPC.DOWNLOADS_REMOVE, row.id)).toBe(true);
    expect(privateStore.getCount()).toBe(0);
  });

  test('pause / resume / cancel on a private download are refused for other windows', async () => {
    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });
    mod.registerDownloadsIpc();

    const item = startOn(privateSession, {
      url: 'https://example.com/secret.iso',
      filename: 'secret.iso',
    });

    const [row] = await invokeAs(privateSender, IPC.DOWNLOADS_GET, {});
    expect(row.id).toBeLessThan(0);

    // A normal window cannot control the private window's live download,
    // even though private ids are predictable negative integers.
    expect(await invokeAs(normalSender, IPC.DOWNLOADS_PAUSE, row.id)).toBe(false);
    expect(await invokeAs(normalSender, IPC.DOWNLOADS_RESUME, row.id)).toBe(false);
    expect(await invokeAs(normalSender, IPC.DOWNLOADS_CANCEL, row.id)).toBe(false);

    // Neither can a different private window (another partition).
    const otherPrivateSender = { privatePartition: 'private-other' };
    expect(await invokeAs(otherPrivateSender, IPC.DOWNLOADS_PAUSE, row.id)).toBe(false);
    expect(await invokeAs(otherPrivateSender, IPC.DOWNLOADS_RESUME, row.id)).toBe(false);
    expect(await invokeAs(otherPrivateSender, IPC.DOWNLOADS_CANCEL, row.id)).toBe(false);

    expect(item.pause).not.toHaveBeenCalled();
    expect(item.resume).not.toHaveBeenCalled();
    expect(item.cancel).not.toHaveBeenCalled();

    // The owning private window still can.
    expect(await invokeAs(privateSender, IPC.DOWNLOADS_PAUSE, row.id)).toBe(true);
    expect(item.pause).toHaveBeenCalled();
    expect(await invokeAs(privateSender, IPC.DOWNLOADS_RESUME, row.id)).toBe(true);
    expect(item.resume).toHaveBeenCalled();
    expect(await invokeAs(privateSender, IPC.DOWNLOADS_CANCEL, row.id)).toBe(true);
    expect(item.cancel).toHaveBeenCalled();
  });

  test('dropping the partition clears the memory store (window-close hook)', async () => {
    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });
    mod.registerDownloadsIpc();

    const item = startOn(privateSession, {
      url: 'https://example.com/a.bin',
      filename: 'a.bin',
    });
    item.emit('done', {}, 'completed');
    expect(privateStore.getCount()).toBe(1);

    // This is the cleanup hook src/main/index.js registers for window close.
    expect(privateStore.dropPartition(PARTITION)).toBe(1);
    expect(privateStore.getCount()).toBe(0);
    expect(await invokeAs(privateSender, IPC.DOWNLOADS_GET, {})).toEqual([]);
  });

  test('closing a private window cancels its in-flight downloads', async () => {
    const privateSession = new EventEmitter();
    const otherPrivateSession = new EventEmitter();
    const normalSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });
    mod.attachDownloadsManager(otherPrivateSession, { privatePartition: 'private-other' });
    mod.attachDownloadsManager(normalSession);
    mod.registerDownloadsIpc();

    const item = startOn(privateSession, {
      url: 'https://example.com/big.iso',
      filename: 'big.iso',
    });
    const otherItem = startOn(otherPrivateSession, {
      url: 'https://example.com/other.iso',
      filename: 'other.iso',
    });
    const normalItem = startOn(normalSession, {
      url: 'https://example.com/public.iso',
      filename: 'public.iso',
    });

    // The window-close hook src/main/index.js registers, in order.
    expect(mod.cancelPartitionDownloads(PARTITION)).toBe(1);
    expect(item.cancel).toHaveBeenCalled();
    // Other partitions — private or not — keep transferring.
    expect(otherItem.cancel).not.toHaveBeenCalled();
    expect(normalItem.cancel).not.toHaveBeenCalled();
    privateStore.dropPartition(PARTITION);

    // Bookkeeping is unwound synchronously: the cancelled item is no longer
    // live (so DOWNLOADS_REMOVE would not refuse it) and its claimed save
    // path is free again for the next download of the same name.
    item.emit('done', {}, 'cancelled');
    const reclaimed = startOn(normalSession, {
      url: 'https://example.com/big.iso',
      filename: 'big.iso',
    });
    expect(reclaimed.getSavePath()).toBe(path.join(downloadsDir, 'big.iso'));
  });

  // `reservedSavePaths` is a plain Set, not refcounted. cancelPartitionDownloads
  // releases the claim synchronously and Chromium's 'done' arrives afterwards
  // for the same item; if 'done' released it a SECOND time it would free
  // whatever new download had meanwhile reserved that path, and the next
  // same-named download would be handed the identical path — two transfers
  // writing one file.
  test('a cancelled private download does not free a later download of the same name', () => {
    const privateSession = new EventEmitter();
    const normalSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });
    mod.attachDownloadsManager(normalSession);

    const item = startOn(privateSession, {
      url: 'https://example.com/big.iso',
      filename: 'big.iso',
    });
    expect(item.getSavePath()).toBe(path.join(downloadsDir, 'big.iso'));

    // Private window closes: the claim on big.iso is released here.
    expect(mod.cancelPartitionDownloads(PARTITION)).toBe(1);

    // A new download reclaims the freed name BEFORE the cancelled item's
    // asynchronous 'done' lands. This is the race window.
    const reclaimed = startOn(normalSession, {
      url: 'https://example.com/big.iso',
      filename: 'big.iso',
    });
    expect(reclaimed.getSavePath()).toBe(path.join(downloadsDir, 'big.iso'));

    // The late 'done' for the already-unwound item must NOT release the
    // reservation now owned by `reclaimed`.
    item.emit('done', {}, 'cancelled');

    const third = startOn(normalSession, {
      url: 'https://example.com/big.iso',
      filename: 'big.iso',
    });
    expect(third.getSavePath()).toBe(path.join(downloadsDir, 'big (1).iso'));
  });

  test('cancelPartitionDownloads ignores a missing/blank partition', () => {
    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });
    const item = startOn(privateSession, { url: 'https://example.com/a.bin', filename: 'a.bin' });

    expect(mod.cancelPartitionDownloads(null)).toBe(0);
    expect(mod.cancelPartitionDownloads('private-nobody')).toBe(0);
    expect(item.cancel).not.toHaveBeenCalled();
  });

  test('crash scenario: nothing was persisted, so the next run has nothing to sweep', () => {
    const privateSession = new EventEmitter();
    mod.attachDownloadsManager(privateSession, { privatePartition: PARTITION });

    // Simulate a crash mid-download: no window-close hook ever runs.
    startOn(privateSession, { url: 'https://example.com/secret.bin', filename: 'secret.bin' });

    // Nothing reached the profile database…
    expect(store.getDownloadCount()).toBe(0);
    // …so the startup legacy sweep of the "next run" finds nothing.
    expect(store.removeAllPrivateDownloads()).toBe(0);
    expect(store.getAllDownloads()).toEqual([]);
  });

  test('registerDownloadsIpc sweeps legacy private rows written by old builds', () => {
    store.insertDownload({
      url: 'https://example.com/stale.bin',
      filename: 'stale.bin',
      isPrivate: true,
      partition: 'private-crashed',
    });
    store.insertDownload({
      url: 'https://example.com/keep.bin',
      filename: 'keep.bin',
    });

    mod.registerDownloadsIpc();

    const rows = store.getAllDownloads();
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('keep.bin');
  });
});
