const fs = require('fs');
const path = require('path');
const FakeBetterSqlite3PublishesDatabase = require('../../../test/helpers/fake-better-sqlite3-publishes');
const {
  createIpcMainMock,
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');

function loadPublishHistoryModule(options = {}) {
  return loadMainModule(require.resolve('./publish-history'), {
    ...options,
    extraMocks: {
      'better-sqlite3': () => FakeBetterSqlite3PublishesDatabase,
      [require.resolve('../logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  });
}

describe('publish-history (sqlite)', () => {
  let userDataDir;
  let mod;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    mod = null;
  });

  afterEach(() => {
    if (mod?.closeDb) mod.closeDb();
    removeTempUserDataDir(userDataDir);
  });

  test('addEntry inserts a row with generated id and uploading status', () => {
    ({ mod } = loadPublishHistoryModule({ userDataDir }));

    const entry = mod.addEntry({ type: 'file', name: 'test.txt', status: 'uploading' });

    expect(entry.id).toEqual(expect.any(Number));
    expect(entry).toEqual(
      expect.objectContaining({
        type: 'file',
        name: 'test.txt',
        status: 'uploading',
        reference: null,
        bzzUrl: null,
        completedAt: null,
      })
    );
    expect(typeof entry.timestamp).toBe('string');
  });

  test('addEntry with completed status sets completedAt immediately', () => {
    ({ mod } = loadPublishHistoryModule({ userDataDir }));

    const entry = mod.addEntry({ type: 'data', status: 'completed', reference: 'abc' });

    expect(entry.status).toBe('completed');
    expect(entry.completedAt).not.toBeNull();
  });

  test('updateEntry transitions status, reference, bzzUrl, tagUid, batchIdUsed', () => {
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    const created = mod.addEntry({ type: 'directory', name: 'site', status: 'uploading' });

    const updated = mod.updateEntry(created.id, {
      status: 'completed',
      reference: 'deadbeef',
      bzzUrl: 'bzz://deadbeef',
      tagUid: 42,
      batchIdUsed: 'batch1',
    });

    expect(updated).toEqual(
      expect.objectContaining({
        status: 'completed',
        reference: 'deadbeef',
        bzzUrl: 'bzz://deadbeef',
        tagUid: 42,
        batchIdUsed: 'batch1',
      })
    );
    expect(updated.completedAt).not.toBeNull();
  });

  test('updateEntry returns null for unknown id', () => {
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    expect(mod.updateEntry(99999, { status: 'failed' })).toBeNull();
  });

  test('updateEntry to status=failed records the error message', () => {
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    const created = mod.addEntry({ type: 'data', status: 'uploading' });

    const updated = mod.updateEntry(created.id, {
      status: 'failed',
      errorMessage: 'stamp expired',
    });

    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toBe('stamp expired');
    expect(updated.completedAt).not.toBeNull();
  });

  test('getEntries returns rows newest-first and includes new columns', () => {
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    mod.addEntry({ type: 'data', name: 'first', origin: 'freedom://publish' });
    // started_at uses Date.now() — bump to guarantee distinct ordering keys.
    const realNow = Date.now;
    Date.now = () => realNow() + 10;
    mod.addEntry({ type: 'directory', name: 'second', origin: 'https://dapp.example' });
    Date.now = realNow;

    const entries = mod.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('second');
    expect(entries[0].origin).toBe('https://dapp.example');
    expect(entries[1].name).toBe('first');
    expect(entries[1].origin).toBe('freedom://publish');
  });

  test('removeEntry deletes by id; clearEntries empties everything', () => {
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    const a = mod.addEntry({ type: 'data', name: 'keep' });
    const b = mod.addEntry({ type: 'data', name: 'drop' });

    expect(mod.removeEntry(b.id)).toBe(true);
    expect(mod.getEntries()).toHaveLength(1);
    expect(mod.getEntries()[0].id).toBe(a.id);

    mod.clearEntries();
    expect(mod.getEntries()).toHaveLength(0);
  });

  test('handles 200+ entries without a cap', () => {
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    for (let i = 0; i < 250; i++) mod.addEntry({ type: 'data', name: `e${i}` });
    expect(mod.getEntries()).toHaveLength(250);
  });

  test('migrates legacy publish-history.json on first open and renames the file', () => {
    const jsonPath = path.join(userDataDir, 'publish-history.json');
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'legacy-1',
            type: 'directory',
            name: 'old-site',
            status: 'completed',
            reference: 'legacyref',
            bzzUrl: 'bzz://legacyref',
            tagUid: 100,
            batchIdUsed: 'legacybatch',
            timestamp: '2026-04-15T19:30:32.540Z',
          },
          {
            id: 'legacy-2',
            type: 'feed-create',
            name: 'feed-x',
            status: 'completed',
            timestamp: '2026-04-15T19:31:00.000Z',
          },
        ],
      })
    );

    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    const entries = mod.getEntries();

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('feed-x'); // newer first
    expect(entries[1]).toEqual(
      expect.objectContaining({
        type: 'directory',
        name: 'old-site',
        status: 'completed',
        reference: 'legacyref',
        bzzUrl: 'bzz://legacyref',
        tagUid: 100,
        batchIdUsed: 'legacybatch',
      })
    );

    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(jsonPath + '.migrated')).toBe(true);
  });

  test('migration is idempotent — no JSON, no error', () => {
    expect(() => {
      ({ mod } = loadPublishHistoryModule({ userDataDir }));
      mod.getEntries();
    }).not.toThrow();
  });

  test('skips re-import when publish-history.json.migrated already exists', () => {
    // Scenario: a prior run successfully migrated (leaving .migrated behind),
    // and a stray .json reappeared — user drop-in, partial restore, etc.
    // Re-importing would double the rows (the table has no unique key), so
    // the stray .json should be dropped instead.
    const jsonPath = path.join(userDataDir, 'publish-history.json');
    const migratedPath = jsonPath + '.migrated';

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            type: 'data',
            name: 'stray',
            status: 'completed',
            timestamp: '2026-04-15T19:30:32.540Z',
          },
        ],
      })
    );
    fs.writeFileSync(migratedPath, '{}');

    ({ mod } = loadPublishHistoryModule({ userDataDir }));

    expect(mod.getEntries()).toHaveLength(0);
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(migratedPath)).toBe(true);
  });

  test('sweepOrphans flips uploading rows to failed when getDb runs', () => {
    // Seed the fake by inserting two uploading rows, then explicitly invoke
    // the sweep path through a new module load. Since the fake DB is in-memory
    // per instance, we simulate the "prior session left orphans" scenario by
    // going through the migrateFromJson path with an uploading entry.
    const jsonPath = path.join(userDataDir, 'publish-history.json');
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            type: 'data',
            name: 'orphan',
            status: 'uploading',
            timestamp: '2026-04-15T19:30:32.540Z',
          },
        ],
      })
    );

    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    const entries = mod.getEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('failed');
    expect(entries[0].errorMessage).toBe(mod.ORPHAN_SWEEP_MESSAGE);
    expect(entries[0].completedAt).not.toBeNull();
  });

  test('registers IPC handlers that wrap getEntries / clearEntries', async () => {
    const ipcMain = createIpcMainMock();
    ({ mod } = loadPublishHistoryModule({ userDataDir, ipcMain }));
    mod.registerPublishHistoryIpc();

    mod.addEntry({ type: 'data', name: 'one' });

    const getResult = await ipcMain.invoke('swarm:get-publish-history');
    expect(getResult.success).toBe(true);
    expect(getResult.entries).toHaveLength(1);

    const clearResult = await ipcMain.invoke('swarm:clear-publish-history');
    expect(clearResult.success).toBe(true);
    expect(mod.getEntries()).toHaveLength(0);
  });
});

// freedom-core design 0015, D10 (design 0017, C5): in a moved profile the
// core copies the profile root's publish-history.json into the Freedom root,
// imports the copy, renames it .migrated there, and drops the original only
// at its own next start (payments_store.rs `hand_over_of`, step 4). A start
// on main's own history before then retires the original as step 4 does,
// and imports nothing; any other state imports as before.
describe("publish-history (sqlite): the core's D10 hand-over, back on main's history", () => {
  let userDataDir;
  let freedomDir;
  let mod;
  const LEGACY = JSON.stringify({
    version: 1,
    entries: [
      { type: 'data', name: 'legacy', status: 'completed', timestamp: '2026-04-15T19:30:32.540Z' },
    ],
  });

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    freedomDir = path.join(userDataDir, 'freedom');
    fs.mkdirSync(freedomDir);
    fs.writeFileSync(path.join(freedomDir, 'layout.json'), JSON.stringify({ version: 1 }));
    fs.writeFileSync(path.join(userDataDir, 'publish-history.json'), LEGACY);
    mod = null;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (mod?.closeDb) mod.closeDb();
    removeTempUserDataDir(userDataDir);
  });

  const files = () => ({
    root: fs.readdirSync(userDataDir).filter((name) => name.startsWith('publish-history')),
    freedom: fs.readdirSync(freedomDir).filter((name) => name.startsWith('publish-history.json')),
  });

  test("the core's import stands: the original is removed, nothing imported", () => {
    fs.writeFileSync(path.join(freedomDir, 'publish-history.json.migrated'), LEGACY);
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    expect(mod.getEntries()).toEqual([]);
    expect(files()).toEqual({ root: [], freedom: ['publish-history.json.migrated'] });
  });

  test("the core's import stands beside a copy of the same bytes, which stays", () => {
    fs.writeFileSync(path.join(freedomDir, 'publish-history.json.migrated'), LEGACY);
    fs.writeFileSync(path.join(freedomDir, 'publish-history.json'), LEGACY);
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    expect(mod.getEntries()).toEqual([]);
    expect(files()).toEqual({
      root: [],
      freedom: ['publish-history.json', 'publish-history.json.migrated'],
    });
  });

  test.each([
    ['a .migrated of other bytes', { 'publish-history.json.migrated': '{"entries":[]}' }],
    [
      'a conflicting copy beside a matching .migrated',
      { 'publish-history.json.migrated': LEGACY, 'publish-history.json': '{"entries":[]}' },
    ],
    ["only the core's copy, not imported yet", { 'publish-history.json': LEGACY }],
    ['no file in the Freedom root', {}],
  ])('%s: imported as before', (_name, freedom) => {
    for (const [name, text] of Object.entries(freedom)) {
      fs.writeFileSync(path.join(freedomDir, name), text);
    }
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    expect(mod.getEntries().map((entry) => entry.name)).toEqual(['legacy']);
    expect(files().root).toEqual(['publish-history.json.migrated']);
  });

  test("the .migrated can't be made durable: the original stays, unimported", () => {
    fs.writeFileSync(path.join(freedomDir, 'publish-history.json.migrated'), LEGACY);
    jest.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('EIO: i/o error, fsync');
    });
    ({ mod } = loadPublishHistoryModule({ userDataDir }));
    expect(mod.getEntries()).toEqual([]);
    expect(files().root).toEqual(['publish-history.json']);
  });
});
