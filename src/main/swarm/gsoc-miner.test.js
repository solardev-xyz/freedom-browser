const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

jest.mock('node:worker_threads', () => ({ Worker: jest.fn() }));
const mockLogWarn = jest.fn();
jest.mock('../logger', () => ({ warn: (...args) => mockLogWarn(...args), info: jest.fn() }));

const miner = require('./gsoc-miner');

let spawned;
const OVERLAY = new Uint8Array(32).fill(1);
const IDENTIFIER = new Uint8Array(32).fill(2);

function lastWorker() {
  return spawned[spawned.length - 1];
}

function jobs(worker) {
  return worker.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'mine');
}

// Let finishCurrent's deferred dispatch run.
async function flush() {
  await jest.advanceTimersByTimeAsync(0);
}

function start(owner) {
  const promise = miner.mineSigner(OVERLAY, IDENTIFIER, 12, owner === undefined ? undefined : { owner });
  promise.catch(() => {});
  return promise;
}

beforeEach(() => {
  jest.useFakeTimers();
  spawned = [];
  mockLogWarn.mockReset();
  Worker.mockReset();
  Worker.mockImplementation(() => {
    const worker = new EventEmitter();
    worker.postMessage = jest.fn();
    worker.terminate = jest.fn(() => Promise.resolve(1));
    worker.unref = jest.fn();
    spawned.push(worker);
    return worker;
  });
  miner.resetForTest();
});

afterEach(() => {
  miner.resetForTest();
  jest.useRealTimers();
});

test('spawns the worker lazily, unref’d, and resolves with its signer', async () => {
  expect(Worker).not.toHaveBeenCalled();
  const promise = start();
  expect(Worker).toHaveBeenCalledWith(expect.stringMatching(/gsoc-miner-worker\.js$/), {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  const worker = lastWorker();
  expect(worker.unref).toHaveBeenCalled();
  const [job] = jobs(worker);
  expect(job).toMatchObject({ proximity: 12 });
  expect(Array.from(job.targetOverlay)).toEqual(Array.from(OVERLAY));
  expect(Array.from(job.identifier)).toEqual(Array.from(IDENTIFIER));

  worker.emit('message', { type: 'result', id: job.id, ok: true, signer: 'ab'.repeat(32) });
  await expect(promise).resolves.toBe('ab'.repeat(32));
  // The hard-timeout timer is cleared once the job settles. (Jest's fake
  // timers also count the deferred queueMicrotask dispatch; flush it first.)
  await flush();
  expect(jest.getTimerCount()).toBe(0);
});

test('dispatches one job at a time and reuses the worker', async () => {
  const first = start();
  const second = start();
  const worker = lastWorker();
  expect(jobs(worker)).toHaveLength(1);

  worker.emit('message', { type: 'result', id: jobs(worker)[0].id, ok: true, signer: '01' });
  await expect(first).resolves.toBe('01');
  await flush();
  expect(jobs(worker)).toHaveLength(2);
  worker.emit('message', { type: 'result', id: jobs(worker)[1].id, ok: true, signer: '02' });
  await expect(second).resolves.toBe('02');
  expect(Worker).toHaveBeenCalledTimes(1);
});

test('a queued job’s clock starts only when it is dispatched', async () => {
  const first = start();
  const second = start();
  const worker = lastWorker();
  await jest.advanceTimersByTimeAsync(miner.MINE_TIMEOUT_MS - 1);
  worker.emit('message', { type: 'result', id: jobs(worker)[0].id, ok: true, signer: '01' });
  await expect(first).resolves.toBe('01');
  await flush();

  // The second job waited ~15 s in the queue but has its own full budget.
  await jest.advanceTimersByTimeAsync(miner.MINE_TIMEOUT_MS - 1);
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.emit('message', { type: 'result', id: jobs(worker)[1].id, ok: true, signer: '02' });
  await expect(second).resolves.toBe('02');
});

test('queued jobs are served round-robin across owners, not FIFO', async () => {
  // Origin A queues a backlog first; B's job must not wait behind all of it.
  const order = [];
  const settle = (label) => (signer) => order.push(`${label}:${signer}`);
  start('https://a.example').then(settle('a1'));
  start('https://a.example').then(settle('a2'));
  start('https://a.example').then(settle('a3'));
  start('https://b.example').then(settle('b1'));
  start('https://b.example').then(settle('b2'));
  start().then(settle('none1'));
  const worker = lastWorker();
  for (let i = 0; i < 6; i += 1) {
    const all = jobs(worker);
    expect(all).toHaveLength(i + 1);
    worker.emit('message', { type: 'result', id: all[i].id, ok: true, signer: String(i) });
    await flush();
  }
  // a1 was already running; A never gets two turns in a row, and no owner
  // waits for more than one job of each other owner: none1 (queued last, behind
  // A's and B's whole backlogs) is third, not sixth.
  expect(order).toEqual(['a1:0', 'b1:1', 'a2:2', 'none1:3', 'b2:4', 'a3:5']);
});

test('a joined job runs at the joiner’s turn, once, and leaves both queues', async () => {
  // A has a backlog ending in a shared topic T; B joins T. B has no job of its
  // own, so without the join B would wait out A's whole backlog.
  const order = [];
  const settle = (label) => (signer) => order.push(`${label}:${signer}`);
  const keyed = (owner, key) => {
    const p = miner.mineSigner(OVERLAY, IDENTIFIER, 12, { owner, key });
    p.catch(() => {});
    return p;
  };
  keyed('https://a.example', 'a1').then(settle('a1'));
  keyed('https://a.example', 'a2').then(settle('a2'));
  keyed('https://a.example', 'a3').then(settle('a3'));
  const shared = keyed('https://a.example', 'T');
  shared.then(settle('T'));
  expect(miner.joinJob('T', { owner: 'https://b.example' })).toBe(true);
  // Joining twice, or as an owner it already has, queues nothing extra.
  expect(miner.joinJob('T', { owner: 'https://b.example' })).toBe(true);
  expect(miner.joinJob('T', { owner: 'https://a.example' })).toBe(true);
  expect(miner.joinJob('nope', { owner: 'https://b.example' })).toBe(false);

  const worker = lastWorker();
  for (let i = 0; i < 4; i += 1) {
    const all = jobs(worker);
    expect(all).toHaveLength(i + 1);
    worker.emit('message', { type: 'result', id: all[i].id, ok: true, signer: String(i) });
    await flush();
  }
  // a1 was running; B's turn comes next and runs T. T is not run a second time
  // at A's turn.
  expect(order).toEqual(['a1:0', 'T:1', 'a2:2', 'a3:3']);
  expect(jobs(worker)).toHaveLength(4);
  // A settled job's key is forgotten.
  expect(miner.joinJob('T', { owner: 'https://c.example' })).toBe(false);
});

test('joining a job that is already running queues nothing', async () => {
  const running = miner.mineSigner(OVERLAY, IDENTIFIER, 12, { owner: 'https://a.example', key: 'T' });
  const worker = lastWorker();
  expect(miner.joinJob('T', { owner: 'https://b.example' })).toBe(true);
  worker.emit('message', { type: 'result', id: jobs(worker)[0].id, ok: true, signer: '01' });
  await expect(running).resolves.toBe('01');
  await flush();
  expect(jobs(worker)).toHaveLength(1);
  // A failed keyed job is forgotten too.
  const failing = miner.mineSigner(OVERLAY, IDENTIFIER, 12, { owner: 'https://a.example', key: 'F' });
  failing.catch(() => {});
  await flush();
  worker.emit('message', { type: 'result', id: jobs(worker)[1].id, ok: false, error: 'boom' });
  await expect(failing).rejects.toMatchObject({ reason: 'gsoc_mining_failed' });
  expect(miner.joinJob('F', { owner: 'https://b.example' })).toBe(false);
});

test('a runaway job is terminated at the hard timeout and the next job gets a fresh worker', async () => {
  const runaway = start();
  const next = start();
  const stuck = lastWorker();

  await jest.advanceTimersByTimeAsync(miner.MINE_TIMEOUT_MS);
  expect(stuck.terminate).toHaveBeenCalledTimes(1);
  await expect(runaway).rejects.toMatchObject({
    name: 'GsocMiningError',
    reason: 'gsoc_mining_timeout',
    message: expect.stringMatching(/timed out after 15000 ms/),
  });
  expect(mockLogWarn).toHaveBeenCalledWith(expect.stringMatching(/terminating the worker/));

  await flush();
  expect(Worker).toHaveBeenCalledTimes(2);
  const fresh = lastWorker();
  // The killed worker's exit and any late result must not touch the new job.
  stuck.emit('exit', 1);
  stuck.emit('message', { type: 'result', id: jobs(stuck)[0].id, ok: true, signer: 'late' });
  fresh.emit('message', { type: 'result', id: jobs(fresh)[0].id, ok: true, signer: '03' });
  await expect(next).resolves.toBe('03');
});

test('a worker that exits or errors fails its job and is replaced', async () => {
  const lost = start();
  lastWorker().emit('exit', 1);
  await expect(lost).rejects.toMatchObject({ reason: 'gsoc_mining_failed' });

  const errored = start();
  expect(Worker).toHaveBeenCalledTimes(2);
  lastWorker().emit('error', new Error('boom'));
  await expect(errored).rejects.toThrow(/worker error: boom/);
  expect(lastWorker().terminate).toHaveBeenCalled();
});

test('a mining error from the worker rejects the job but keeps the worker', async () => {
  const failed = start();
  const worker = lastWorker();
  worker.emit('message', { type: 'result', id: jobs(worker)[0].id, ok: false, error: 'Could not mine a valid signer' });
  await expect(failed).rejects.toMatchObject({
    reason: 'gsoc_mining_failed',
    message: 'GSOC mining failed: Could not mine a valid signer',
  });
  expect(worker.terminate).not.toHaveBeenCalled();
});

test('a worker that fails to construct rejects the job, and the next one retries', async () => {
  Worker.mockImplementationOnce(() => { throw new Error('no threads'); });
  await expect(start()).rejects.toThrow(/failed to start: no threads/);
  start();
  expect(Worker).toHaveBeenCalledTimes(2);
});
