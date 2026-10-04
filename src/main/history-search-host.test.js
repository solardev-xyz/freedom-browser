// The history search worker host (#503): requests run in a real
// worker_threads worker — the real history-search-worker.js against a real
// SQLite file, or a scripted stand-in for the failure paths.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const host = require('./history-search-host');
const { HistorySearchUnavailable, HistorySearchTimeout } = host;

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-search-host-'));
  host.resetForTest();
});

afterEach(() => {
  host.resetForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

function createHistoryFile(rows) {
  const dbPath = path.join(dir, 'history.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE NOT NULL, title TEXT,
    timestamp INTEGER NOT NULL, visit_count INTEGER DEFAULT 1, protocol TEXT)`);
  const insert = db.prepare(
    'INSERT INTO history (url, title, timestamp, visit_count, protocol) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) insert.run(row.url, row.title, row.timestamp, 1, 'https');
  return { dbPath, db };
}

// A stand-in worker: answers `{ ok, result: 'echo:<query>' }`, never answers
// "hang", exits on "crash", and reports the database unavailable on "noopen".
function scriptedWorker() {
  const file = path.join(dir, 'scripted-worker.js');
  fs.writeFileSync(
    file,
    `const { parentPort, threadId } = require('node:worker_threads');
     parentPort.on('message', (m) => {
       if (m.query === 'hang') return;
       if (m.query === 'crash') process.exit(3);
       if (m.query === 'noopen') {
         parentPort.postMessage({ id: m.id, ok: false, unavailable: true, error: 'cannot open' });
         return;
       }
       parentPort.postMessage({ id: m.id, ok: true, result: 'echo:' + m.query + ':' + threadId });
     });`
  );
  return file;
}

test('answers from the real worker, reading what the main connection wrote', async () => {
  const { dbPath, db } = createHistoryFile([
    { url: 'https://a.example/', title: 'Alpha', timestamp: 1 },
    { url: 'https://b.example/', title: 'Beta', timestamp: 2 },
  ]);
  await expect(host.runInWorker(dbPath, 'autocomplete', { query: 'alpha' })).resolves.toEqual([
    expect.objectContaining({ url: 'https://a.example/', title: 'Alpha' }),
  ]);

  // A visit written by the main connection after the worker opened its own.
  db.prepare(
    "INSERT INTO history (url, title, timestamp, visit_count, protocol) VALUES ('https://c.example/', 'Alpha two', 3, 1, 'https')"
  ).run();
  const rows = await host.runInWorker(dbPath, 'autocomplete', { query: 'alpha' });
  expect(rows.map((row) => row.url)).toEqual(['https://c.example/', 'https://a.example/']);

  await expect(
    host.runInWorker(dbPath, 'page', { options: { query: 'b', sort: 'recent' } })
  ).resolves.toEqual({
    entries: [expect.objectContaining({ url: 'https://b.example/' })],
    matched: 1,
    total: 3,
  });
  db.close();
});

test('a worker that cannot open the database turns itself off for the session', async () => {
  const missing = path.join(dir, 'missing.sqlite');
  await expect(host.runInWorker(missing, 'autocomplete', { query: 'x' })).rejects.toBeInstanceOf(
    HistorySearchUnavailable
  );
  // Not retried: the caller searches on the main thread from now on.
  await expect(host.runInWorker(missing, 'autocomplete', { query: 'x' })).rejects.toThrow(
    'worker disabled'
  );
});

test('a request still unanswered at the deadline times out and the worker is replaced', async () => {
  host.resetForTest({ timeoutMs: 200, path: scriptedWorker() });
  const first = await host.runInWorker('db', 'autocomplete', { query: 'one' });
  const hung = host.runInWorker('db', 'autocomplete', { query: 'hang' });
  await expect(hung).rejects.toBeInstanceOf(HistorySearchTimeout);
  // Not disabled: the next request gets a fresh worker (another thread id).
  const next = await host.runInWorker('db', 'autocomplete', { query: 'two' });
  expect(next).toMatch(/^echo:two:/);
  expect(next.split(':')[2]).not.toBe(first.split(':')[2]);
});

test('requests queued behind a timed-out one time out too, without a main-thread fallback', async () => {
  host.resetForTest({ timeoutMs: 200, path: scriptedWorker() });
  const hung = host.runInWorker('db', 'page', { query: 'hang' });
  // Queued on the same worker; the scripted worker never answers either.
  const queued = host.runInWorker('db', 'autocomplete', { query: 'hang' });
  queued.catch(() => {});
  await expect(hung).rejects.toBeInstanceOf(HistorySearchTimeout);
  const err = await queued.catch((e) => e);
  expect(err).toBeInstanceOf(HistorySearchTimeout);
  expect(err).not.toBeInstanceOf(HistorySearchUnavailable);
  // Not disabled either: the next request gets a fresh worker.
  await expect(host.runInWorker('db', 'autocomplete', { query: 'ok' })).resolves.toMatch(
    /^echo:ok/
  );
});

test('a worker that dies mid-request fails it as unavailable, and the next one respawns', async () => {
  host.resetForTest({ path: scriptedWorker() });
  await expect(host.runInWorker('db', 'autocomplete', { query: 'ok' })).resolves.toMatch(
    /^echo:ok/
  );
  await expect(host.runInWorker('db', 'autocomplete', { query: 'crash' })).rejects.toBeInstanceOf(
    HistorySearchUnavailable
  );
  // It had answered before, so it was not a can't-run worker: respawn.
  await expect(host.runInWorker('db', 'autocomplete', { query: 'again' })).resolves.toMatch(
    /^echo:again/
  );
});

test('an "unavailable" report disables the worker', async () => {
  host.resetForTest({ path: scriptedWorker() });
  await expect(host.runInWorker('db', 'autocomplete', { query: 'noopen' })).rejects.toBeInstanceOf(
    HistorySearchUnavailable
  );
  await expect(host.runInWorker('db', 'autocomplete', { query: 'ok' })).rejects.toThrow(
    'worker disabled'
  );
});

test('stopping the worker fails pending requests without a main-thread fallback', async () => {
  host.resetForTest({ path: scriptedWorker() });
  const pending = host.runInWorker('db', 'autocomplete', { query: 'hang' });
  host.stopWorker();
  const err = await pending.catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(HistorySearchUnavailable);
  // Stopping is not a failure: a later request starts a new worker.
  await expect(host.runInWorker('db', 'autocomplete', { query: 'ok' })).resolves.toMatch(
    /^echo:ok/
  );
});
