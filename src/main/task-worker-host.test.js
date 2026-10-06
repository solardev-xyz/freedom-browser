// task-worker-host (#503): a scripted worker_threads worker drives every
// settle path — answer, reported failure, log, hang, crash, can't start.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('./logger');
const {
  createTaskWorkerHost,
  TaskWorkerUnavailable,
  TaskWorkerTimeout,
} = require('./task-worker-host');

let dir;
let host;

// Answers `echo:<value>:<threadId>`, never answers "hang", exits on "crash",
// reports `code` on "fail", and logs on "log".
function scriptedWorker() {
  const file = path.join(dir, 'scripted-worker.js');
  fs.writeFileSync(
    file,
    `const { parentPort, threadId, workerData } = require('node:worker_threads');
     parentPort.on('message', (m) => {
       if (m.value === 'hang') return;
       if (m.value === 'crash') process.exit(3);
       if (m.value === 'fail') {
         parentPort.postMessage({ id: m.id, ok: false, error: 'nope', code: 'E_NOPE' });
         return;
       }
       if (m.value === 'log') parentPort.postMessage({ type: 'log', level: 'error', message: 'hi' });
       parentPort.postMessage({
         id: m.id, ok: true, result: m.op + ':' + m.value + ':' + threadId + ':' + workerData.tag,
       });
     });`
  );
  return file;
}

beforeEach(() => {
  jest.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-worker-host-'));
  host = createTaskWorkerHost({
    name: 'Test',
    workerPath: scriptedWorker(),
    workerData: () => ({ tag: 't' }),
    timeoutMs: 5_000,
  });
});

afterEach(() => {
  host.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('answers a request in the worker, with its workerData', async () => {
  await expect(host.run('echo', { value: 'a' })).resolves.toMatch(/^echo:a:\d+:t$/);
});

test('a reported failure rejects with the message and code, and keeps the worker', async () => {
  const first = await host.run('echo', { value: 'a' });
  const err = await host.run('echo', { value: 'fail' }).catch((e) => e);
  expect(err).not.toBeInstanceOf(TaskWorkerUnavailable);
  expect(err.message).toBe('nope');
  expect(err.code).toBe('E_NOPE');
  const next = await host.run('echo', { value: 'b' });
  expect(next.split(':')[2]).toBe(first.split(':')[2]);
});

test('worker log lines reach the main logger', async () => {
  await host.run('echo', { value: 'log' });
  expect(log.error).toHaveBeenCalledWith('[Test] hi');
});

test('a hung request times out and the worker is replaced; requests behind it still run', async () => {
  host.resetForTest({ timeoutMs: 200 });
  const first = await host.run('echo', { value: 'a' });
  const hung = host.run('echo', { value: 'hang' });
  const queued = host.run('echo', { value: 'b' });
  await expect(hung).rejects.toBeInstanceOf(TaskWorkerTimeout);
  const next = await queued;
  expect(next).toMatch(/^echo:b/);
  expect(next.split(':')[2]).not.toBe(first.split(':')[2]);
});

test('the timeout counts from when the worker takes a request, not from when it was queued', async () => {
  // Each answer takes ~150 ms of worker time; eight queued back to back need
  // ~1.2 s, twice the 600 ms per-request limit, and none of them may time out.
  const slow = path.join(dir, 'slow-worker.js');
  fs.writeFileSync(
    slow,
    `const { parentPort } = require('node:worker_threads');
     parentPort.on('message', (m) => {
       const until = Date.now() + (m.value === 'warm' ? 0 : 150);
       while (Date.now() < until) {}
       parentPort.postMessage({ id: m.id, ok: true, result: m.value });
     });`
  );
  host.resetForTest({ path: slow, timeoutMs: 600 });
  // Worker startup is not what this measures.
  await host.run('echo', { value: 'warm' });
  const values = ['1', '2', '3', '4', '5', '6', '7', '8'];
  await expect(Promise.all(values.map((value) => host.run('echo', { value })))).resolves.toEqual(
    values
  );
});

test('aborting a queued request drops it without touching the worker', async () => {
  const first = await host.run('echo', { value: 'a' });
  const controller = new AbortController();
  const blocker = host.run('echo', { value: 'b' });
  const queued = host.run('echo', { value: 'c' }, { signal: controller.signal });
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  const kept = await blocker;
  expect(kept.split(':')[2]).toBe(first.split(':')[2]);
});

test('aborting the request the worker is on stops that worker; the next one runs fresh', async () => {
  const first = await host.run('echo', { value: 'a' });
  const controller = new AbortController();
  const hung = host.run('echo', { value: 'hang' }, { signal: controller.signal });
  const queued = host.run('echo', { value: 'b' });
  controller.abort();
  const err = await hung.catch((e) => e);
  expect(err.name).toBe('AbortError');
  expect(err).not.toBeInstanceOf(TaskWorkerUnavailable);
  const next = await queued;
  expect(next.split(':')[2]).not.toBe(first.split(':')[2]);
});

test('an already-aborted signal rejects without queueing', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    host.run('echo', { value: 'a' }, { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' });
});

test('a worker that dies after answering fails only its request as unavailable, then respawns', async () => {
  await host.run('echo', { value: 'a' });
  const crashed = host.run('echo', { value: 'crash' });
  const queued = host.run('echo', { value: 'b' });
  await expect(crashed).rejects.toBeInstanceOf(TaskWorkerUnavailable);
  await expect(queued).resolves.toMatch(/^echo:b/);
  await expect(host.run('echo', { value: 'c' })).resolves.toMatch(/^echo:c/);
});

test('a worker that dies before answering anything is disabled for the session', async () => {
  const crashed = host.run('echo', { value: 'crash' });
  const queued = host.run('echo', { value: 'a' });
  await expect(crashed).rejects.toBeInstanceOf(TaskWorkerUnavailable);
  await expect(queued).rejects.toBeInstanceOf(TaskWorkerUnavailable);
  await expect(host.run('echo', { value: 'a' })).rejects.toThrow('worker disabled');
});

test('a worker script that cannot load is disabled for the session', async () => {
  host.resetForTest({ path: path.join(dir, 'missing.js') });
  await expect(host.run('echo', { value: 'a' })).rejects.toBeInstanceOf(TaskWorkerUnavailable);
  await expect(host.run('echo', { value: 'a' })).rejects.toThrow('worker disabled');
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('[Test] worker'));
});

test('stopping fails pending requests without the unavailable fallback', async () => {
  const pending = host.run('echo', { value: 'hang' });
  const queued = host.run('echo', { value: 'a' });
  host.stop();
  for (const err of [await pending.catch((e) => e), await queued.catch((e) => e)]) {
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TaskWorkerUnavailable);
  }
  await expect(host.run('echo', { value: 'a' })).resolves.toMatch(/^echo:a/);
});
