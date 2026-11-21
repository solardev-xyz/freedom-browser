/**
 * Main's copy of the pending Safe transactions (pending-store.js, design
 * 0013 PRF-6(d)) through the real CoreClient and vault-backend, over fake
 * core processes: the copy belongs to one process. A process that exits is
 * marked ended at once (ServiceClient's `onChildExit`), while the client
 * tells its `exit` only once its output has closed (or drained): from the
 * first, nothing reads the copy, and a write begun in that window never
 * reaches the next process ahead of its load, nor over an entry it holds
 * otherwise (Codex round 3 on #1298).
 */

const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const mockCore = { client: null };
jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockCore.client,
}));

const { CoreClient, RESTART_DELAYS_MS } = require('../../core/core-client');
const { encodeFrame, FrameDecoder, Reassembler } = require('../../core/frame');
const pendingStore = require('./pending-store');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise(setImmediate);
const until = async (condition) => {
  for (let i = 0; i < 200 && !condition(); i += 1) await tick();
  expect(condition()).toBe(true);
};
const entry = (hash, signatures = []) => ({ safeTxHash: hash, threshold: 2, signatures });

/**
 * A fake freedom-cored process serving `store` (`{ [index]: entry }`) for
 * `safe_pending.*`, its hello echoing the build's stores. Like Node's
 * ChildProcess it emits 'exit', and 'close' only once `close()` is called.
 */
class FakeProcess extends EventEmitter {
  constructor(store) {
    super();
    this.pid = 4242;
    this.store = store;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.requests = [];
    const decoder = new FrameDecoder();
    const reassembler = new Reassembler();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of decoder.push(chunk)) {
          const delivery = reassembler.push(frame, () => false);
          if (delivery?.type === 'message') this.handle(delivery.message);
        }
        callback();
      },
    });
  }

  handle(message) {
    this.requests.push(message.method);
    // Held: received, never answered (the process exits first).
    if (message.method === this.hold) return;
    const { index, entry: value } = message.params || {};
    let result;
    switch (message.method) {
      case 'core.hello':
        result = {
          protocol: 2,
          core_version: '0.1.0',
          capabilities: ['streams'],
          store_moved: message.params.store_moved,
        };
        break;
      case 'safe_pending.list':
        result = { indices: Object.keys(this.store).map(Number) };
        break;
      case 'safe_pending.get':
        result = {
          entry: this.store[index] ? JSON.parse(JSON.stringify(this.store[index])) : null,
        };
        break;
      case 'safe_pending.set':
        this.store[index] = JSON.parse(JSON.stringify(value));
        result = { durable: true };
        break;
      case 'safe_pending.clear':
        result = { cleared: index in this.store, durable: true };
        delete this.store[index];
        break;
      default:
        result = {};
    }
    this.stdout.write(encodeFrame({ type: 'response', id: message.id, result }));
    if (message.method === 'core.shutdown') setImmediate(() => this.end());
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.emit('exit', 0, null);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.emit('close', 1, null);
  }

  kill() {
    setImmediate(() => this.end());
    return true;
  }
}

/** A CoreClient whose processes serve `stores` in turn, its timers run by hand. */
function makeCore(stores) {
  const processes = [];
  const timers = [];
  const client = new CoreClient({
    spawn: () => {
      const child = new FakeProcess(stores[Math.min(processes.length, stores.length - 1)]);
      processes.push(child);
      return child;
    },
    command: '/bin/freedom-cored',
    args: ['serve'],
    log: quietLog,
    shellVersion: 'jest',
    grantRoot: os.tmpdir(),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  const runTimers = (ms) => {
    for (const timer of timers.splice(0)) {
      if (!timer.cleared && timer.ms === ms) timer.fn();
      else if (!timer.cleared) timers.push(timer);
    }
  };
  return { client, processes, runTimers };
}

const storeRequests = (child) =>
  child.requests.filter((method) => method.startsWith('safe_pending.'));

beforeEach(() => {
  pendingStore._reset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  jest.restoreAllMocks();
  await mockCore.client?.stop().catch(() => {});
  mockCore.client = null;
});

/**
 * The first process loaded; then it exits, its output still open: the
 * client has marked it ended, and hasn't told its `exit`.
 */
async function exitedWithOutputOpen(first, second) {
  const core = makeCore([first, second]);
  mockCore.client = core.client;
  pendingStore.attachCore(core.client);
  await core.client.start();
  await pendingStore.ready;
  const held = pendingStore.getPending(5);
  expect(held).toEqual(entry('0x05'));
  const told = jest.fn();
  core.client.on('exit', told);
  core.processes[0].emit('exit', 1, null);
  expect(told).not.toHaveBeenCalled();
  return { ...core, held, told };
}

/** Its output closes: the client tells its `exit`, then starts the next process. */
async function restart(core) {
  core.processes[0].close();
  await until(() => core.told.mock.calls.length === 1);
  core.runTimers(RESTART_DELAYS_MS[0]);
  await until(() => core.processes.length === 2 && core.client.state === 'ready');
}

test("from the process's exit, before the client tells it, nothing reads the copy", async () => {
  const core = await exitedWithOutputOpen({ 5: entry('0x05') }, { 5: entry('0x05') });
  expect(pendingStore.getPending(5)).toBeNull();
  expect(pendingStore.listPendingIndexes()).toEqual([]);
  await restart(core);
  await pendingStore.ready;
  // Confirmed as it was by the next process's load: the same object.
  expect(pendingStore.getPending(5)).toBe(core.held);
});

test("a write begun in that window reaches neither process, and never the next one's different entry", async () => {
  const second = { 5: entry('0x55') };
  const core = await exitedWithOutputOpen({ 5: entry('0x05') }, second);
  core.held.signatures = [{ signer: '0x1', data: '0x01' }];
  const writing = pendingStore.setPending(5, core.held);
  await tick();
  await restart(core);
  await expect(writing).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
  expect(storeRequests(core.processes[0])).toEqual(['safe_pending.list', 'safe_pending.get']);
  expect(storeRequests(core.processes[1])).toEqual(['safe_pending.list', 'safe_pending.get']);
  expect(second).toEqual({ 5: entry('0x55') });
  expect(pendingStore.getPending(5)).toEqual(entry('0x55'));
});

test("a write begun in that window over an entry the next process's load keeps goes to that process, after its load", async () => {
  const second = { 5: entry('0x05') };
  const core = await exitedWithOutputOpen({ 5: entry('0x05') }, second);
  const writing = pendingStore.setPending(5, entry('0x05', [{ signer: '0x1', data: '0x01' }]));
  await tick();
  await restart(core);
  await writing;
  expect(storeRequests(core.processes[0])).toEqual(['safe_pending.list', 'safe_pending.get']);
  expect(storeRequests(core.processes[1])).toEqual([
    'safe_pending.list',
    'safe_pending.get',
    'safe_pending.set',
  ]);
  expect(second[5].signatures).toHaveLength(1);
});

test('a write in flight when its process exits fails, and its read back goes to that process only, never to the next one ahead of its load', async () => {
  const second = { 5: entry('0x55') };
  const core = makeCore([{ 5: entry('0x05') }, second]);
  mockCore.client = core.client;
  pendingStore.attachCore(core.client);
  await core.client.start();
  await pendingStore.ready;
  const held = pendingStore.getPending(5);
  core.processes[0].hold = 'safe_pending.set';
  const writing = pendingStore.setPending(5, entry('0x05', [{ signer: '0x1', data: '0x01' }]));
  await until(() => core.processes[0].requests.includes('safe_pending.set'));
  const told = jest.fn();
  core.client.on('exit', told);
  core.processes[0].emit('exit', 1, null);
  expect(pendingStore.getPending(5)).toBeNull();
  // Its output closes: the request in flight fails, its outcome unknown.
  core.processes[0].close();
  await expect(writing).rejects.toMatchObject({ code: 'core_unavailable' });
  await until(() => told.mock.calls.length === 1);
  core.runTimers(RESTART_DELAYS_MS[0]);
  await until(() => core.processes.length === 2 && core.client.state === 'ready');
  await pendingStore.ready;
  // The next process was asked nothing before its own load.
  expect(storeRequests(core.processes[1])).toEqual(['safe_pending.list', 'safe_pending.get']);
  expect(pendingStore.getPending(5)).not.toBe(held);
  expect(pendingStore.getPending(5)).toEqual(entry('0x55'));
});

test("a clear begun in that window never clears the next process's different entry", async () => {
  const second = { 5: entry('0x55') };
  const core = await exitedWithOutputOpen({ 5: entry('0x05') }, second);
  const clearing = pendingStore.clearPending(5);
  await tick();
  await restart(core);
  await expect(clearing).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
  expect(storeRequests(core.processes[1])).toEqual(['safe_pending.list', 'safe_pending.get']);
  expect(second).toEqual({ 5: entry('0x55') });
});
