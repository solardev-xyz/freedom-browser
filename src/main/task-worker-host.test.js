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
  WORKER_START_TIMEOUT_MS,
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
  jest.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Fake only the host's request/start timers: worker threads, their messages and
// the promise plumbing stay real, so a test decides exactly how much "time" a
// request has had, however slowly the machine starts threads.
function fakeTimeouts() {
  jest.useFakeTimers({
    doNotFake: [
      'Date',
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
    ],
  });
}

// Explicit readiness: yield (in real time; setImmediate is not faked) until
// `condition` holds. Bounded so a regression fails here instead of spinning
// past the test's own timeout.
async function until(condition, what) {
  const giveUpAt = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() > giveUpAt) throw new Error(`gave up waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Let pending worker messages and promise callbacks land without moving fake time.
async function settleEvents(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

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
  // Fake timeouts (#545): with real ones, the replacement worker's start on a
  // loaded machine could eat `b`'s whole budget. Here time moves only when
  // the test says so.
  fakeTimeouts();
  host.resetForTest({ timeoutMs: 200 });
  const first = await host.run('echo', { value: 'a' });
  let hungSettled = false;
  const hung = host.run('echo', { value: 'hang' });
  hung.catch(() => {}).finally(() => (hungSettled = true));
  const queued = host.run('echo', { value: 'b' });
  // Just short of the limit, the hang has not timed out yet.
  jest.advanceTimersByTime(199);
  await settleEvents();
  expect(hungSettled).toBe(false);
  jest.advanceTimersByTime(1);
  await expect(hung).rejects.toBeInstanceOf(TaskWorkerTimeout);
  const next = await queued;
  expect(next).toMatch(/^echo:b/);
  expect(next.split(':')[2]).not.toBe(first.split(':')[2]);
});

test("a fresh worker's start is not charged to the request it is handed", async () => {
  fakeTimeouts();
  host.resetForTest({ timeoutMs: 200 });
  const armed = jest.spyOn(global, 'setTimeout');
  let settled = false;
  const hung = host.run('echo', { value: 'hang' });
  hung.catch(() => {}).finally(() => (settled = true));
  // The worker cannot be online yet: its 'online' event needs a turn of the
  // event loop. Spend 150 of the 200 ms on the start.
  expect(armed).toHaveBeenCalledTimes(1); // the start bound only
  jest.advanceTimersByTime(150);
  // Wait until the worker is online and the host has armed the request's own
  // timer.
  await until(() => armed.mock.calls.length >= 2, "the request's timer");
  // Charged from dispatch, the request would time out 50 ms after start-up.
  // It has the whole 200 ms of worker time instead.
  jest.advanceTimersByTime(199);
  await settleEvents();
  expect(settled).toBe(false);
  jest.advanceTimersByTime(1);
  await expect(hung).rejects.toBeInstanceOf(TaskWorkerTimeout);
});

test('a worker that does not come online within the start limit is disabled for the session', async () => {
  fakeTimeouts();
  host.resetForTest({ timeoutMs: 200 });
  const pending = host.run('echo', { value: 'a' });
  // Synchronously, before the worker can report online: its 'online' event
  // needs a turn of the event loop.
  jest.advanceTimersByTime(WORKER_START_TIMEOUT_MS);
  await expect(pending).rejects.toBeInstanceOf(TaskWorkerUnavailable);
  await expect(host.run('echo', { value: 'a' })).rejects.toThrow('worker disabled');
  expect(log.warn).toHaveBeenCalledWith(
    expect.stringContaining(`not online after ${WORKER_START_TIMEOUT_MS} ms`)
  );
});

test('a replacement that misses the start limit after earlier answers times out, not disables', async () => {
  fakeTimeouts();
  host.resetForTest({ timeoutMs: 200 });
  const first = await host.run('echo', { value: 'a' });
  // Retire the answering worker: the hang times out and the next request
  // needs a replacement.
  const hung = host.run('echo', { value: 'hang' });
  jest.advanceTimersByTime(200);
  await expect(hung).rejects.toBeInstanceOf(TaskWorkerTimeout);
  // Synchronously, before the replacement can report online.
  const pending = host.run('echo', { value: 'b' });
  jest.advanceTimersByTime(WORKER_START_TIMEOUT_MS);
  const err = await pending.catch((e) => e);
  expect(err).toBeInstanceOf(TaskWorkerTimeout);
  expect(err.message).toContain(`not online after ${WORKER_START_TIMEOUT_MS} ms`);
  // Not disabled: the next request gets a fresh worker.
  jest.useRealTimers();
  const next = await host.run('echo', { value: 'c' });
  expect(next).toMatch(/^echo:c/);
  expect(next.split(':')[2]).not.toBe(first.split(':')[2]);
  expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('running on the main thread'));
});

test('the timeout counts from when the worker takes a request, not from when it was queued', async () => {
  // The worker answers only when the test releases it, and (fake) time moves
  // only when the test advances it, so this does not depend on how fast the
  // machine is. Three requests queued together each get 150 ms of worker time,
  // 450 ms in all, against a 200 ms per-request limit; none may time out.
  fakeTimeouts();
  const channelName = `task-worker-host-release-${path.basename(dir)}`;
  const gated = path.join(dir, 'gated-worker.js');
  fs.writeFileSync(
    gated,
    `const { parentPort, BroadcastChannel } = require('node:worker_threads');
     const pending = [];
     let releases = 0;
     const flush = () => {
       while (pending.length && releases) {
         releases--;
         const m = pending.shift();
         parentPort.postMessage({ id: m.id, ok: true, result: m.value });
       }
     };
     new BroadcastChannel(${JSON.stringify(channelName)}).onmessage = () => { releases++; flush(); };
     parentPort.on('message', (m) => {
       if (m.value === 'warm') parentPort.postMessage({ id: m.id, ok: true, result: m.value });
       else { pending.push(m); flush(); }
     });`
  );
  const release = new BroadcastChannel(channelName);
  try {
    host.resetForTest({ path: gated, timeoutMs: 200 });
    // Worker startup is not what this measures.
    await host.run('echo', { value: 'warm' });
    const armed = jest.spyOn(global, 'setTimeout');
    const values = ['1', '2', '3'];
    const all = Promise.all(values.map((value) => host.run('echo', { value })));
    for (let i = 1; i <= values.length; i++) {
      // Request i is in the worker once its timer is armed.
      await until(() => armed.mock.calls.length >= i, `request ${i}'s timer`);
      jest.advanceTimersByTime(150);
      release.postMessage('release');
    }
    await expect(all).resolves.toEqual(values);
  } finally {
    release.close();
  }
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
