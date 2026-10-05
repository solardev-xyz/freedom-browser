const fs = require('fs');
const os = require('os');
const path = require('path');
const { FiltersEngine, Request } = require('@ghostery/adblocker');

const mockLog = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('../logger', () => mockLog);

const {
  buildEngine,
  EngineBuildTimeout,
  _setWorkerPathForTests,
  _setBuildDeadlineForTests,
} = require('./engine-build-host');
const engineBuild = require('./engine-build');

const CONFIG = { loadCosmeticFilters: true, loadExtendedSelectors: false };

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-build-host-'));
  fs.writeFileSync(path.join(dir, 'ads.txt'), '||ads.tracker.test^\nnews.example##.ad');
  fs.writeFileSync(path.join(dir, 'privacy.txt'), '||telemetry.test^');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  _setWorkerPathForTests();
  _setBuildDeadlineForTests();
  jest.restoreAllMocks();
  mockLog.warn.mockClear();
});

const job = (lists) => ({
  lists: lists.map((name) => ({
    category: name,
    path: path.join(dir, `${name}.txt`),
    trusted: false,
  })),
  config: CONFIG,
});

const blocks = (bytes, url) =>
  FiltersEngine.deserialize(bytes).match(
    Request.fromRawDetails({ url, sourceUrl: 'https://news.example/', type: 'script' })
  ).match;

test('builds in a worker thread and hands back a serialized engine', async () => {
  const inProcess = jest.spyOn(engineBuild, 'buildSerializedEngine');
  const result = await buildEngine(job(['ads', 'privacy']));
  expect(result.inWorker).toBe(true);
  expect(inProcess).not.toHaveBeenCalled();
  expect(result.bytes).toBeInstanceOf(Uint8Array);
  expect(blocks(result.bytes, 'https://ads.tracker.test/a.js')).toBe(true);
  expect(blocks(result.bytes, 'https://telemetry.test/b.js')).toBe(true);
  expect(blocks(result.bytes, 'https://fine.test/c.js')).toBe(false);
});

test('reports unreadable lists as warnings and builds from the rest', async () => {
  const result = await buildEngine(job(['ads', 'missing']));
  expect(result.warnings).toEqual([expect.stringMatching(/^skipping unreadable list 'missing'/)]);
  expect(blocks(result.bytes, 'https://ads.tracker.test/a.js')).toBe(true);
});

test('no readable list at all yields no engine', async () => {
  const result = await buildEngine(job(['missing']));
  expect(result.bytes).toBe(null);
});

test('a worker that cannot run falls back to building on the main thread', async () => {
  _setWorkerPathForTests(path.join(dir, 'no-such-worker.js'));
  const result = await buildEngine(job(['ads']));
  expect(result.inWorker).toBe(false);
  expect(blocks(result.bytes, 'https://ads.tracker.test/a.js')).toBe(true);
  expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('building on the main thread'));
});

test('a build that fails in the worker rejects instead of retrying on main', async () => {
  const inProcess = jest.spyOn(engineBuild, 'buildSerializedEngine');
  await expect(
    buildEngine({ ...job(['ads']), resources: { text: 'not json', checksum: 'x' } })
  ).rejects.toThrow();
  expect(inProcess).not.toHaveBeenCalled();
  expect(mockLog.warn).not.toHaveBeenCalled();
});

test('a wedged worker is terminated at the deadline and the build rejects, not retried on main', async () => {
  // A worker spinning forever posts nothing and never exits on its own.
  const wedged = path.join(dir, 'wedged-worker.js');
  fs.writeFileSync(
    wedged,
    "require('node:worker_threads').parentPort.once('message', () => { for (;;) {} });"
  );
  _setWorkerPathForTests(wedged);
  _setBuildDeadlineForTests(300);
  const inProcess = jest.spyOn(engineBuild, 'buildSerializedEngine');
  const started = Date.now();
  await expect(buildEngine(job(['ads']))).rejects.toBeInstanceOf(EngineBuildTimeout);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(inProcess).not.toHaveBeenCalled();
  expect(mockLog.warn).not.toHaveBeenCalled();
});
