const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

jest.mock('node:worker_threads', () => ({ Worker: jest.fn() }));
const mockLogWarn = jest.fn();
jest.mock('../logger', () => ({ warn: (...args) => mockLogWarn(...args), info: jest.fn() }));

const host = require('./colibri-worker-host');

const STORAGE_DIR = '/tmp/freedom-test-userdata/colibri';
const CONFIG = { chainId: 1, proverUrl: 'https://p.example', zkProof: true };
let spawned;

function lastWorker() {
  return spawned[spawned.length - 1];
}

function sentRequests(worker) {
  return worker.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'request');
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

// Start a request and let the fake worker report ready so it gets posted.
async function startRequest(client, args, opts) {
  const promise = client.request(args, opts);
  promise.catch(() => {});
  await flush();
  const worker = lastWorker();
  if (!worker.readySent) {
    worker.readySent = true;
    worker.emit('message', { type: 'ready' });
    await flush();
  }
  return { promise, worker, id: sentRequests(worker).at(-1).id };
}

beforeEach(() => {
  jest.useFakeTimers();
  spawned = [];
  mockLogWarn.mockReset();
  Worker.mockReset();
  Worker.mockImplementation(() => {
    const worker = new EventEmitter();
    jest.spyOn(worker, 'on');
    worker.postMessage = jest.fn();
    worker.terminate = jest.fn(() => Promise.resolve(1));
    worker.unref = jest.fn();
    spawned.push(worker);
    return worker;
  });
  host.resetForTest({ storageDir: STORAGE_DIR });
});

afterEach(() => {
  host.resetForTest();
  jest.useRealTimers();
});

describe('colibri worker host', () => {
  test('spawns one isolated, unref’d worker per chain with the storage dir', async () => {
    const client = host.createClient(CONFIG);
    const { promise, worker, id } = await startRequest(client, { method: 'eth_blockNumber' });
    expect(Worker).toHaveBeenCalledWith(expect.stringMatching(/colibri-worker\.js$/), {
      workerData: { storageDir: STORAGE_DIR },
      execArgv: [],
      env: { C4_DISABLE_NATIVE: '1' },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    // unref() after the listeners: adding a 'message' listener re-refs it.
    expect(worker.unref).toHaveBeenCalled();
    expect(worker.unref.mock.invocationCallOrder[0])
      .toBeGreaterThan(Math.max(...worker.on.mock.invocationCallOrder));
    expect(sentRequests(worker)[0]).toEqual({
      type: 'request', id, clientId: expect.any(Number), config: CONFIG,
      method: 'eth_blockNumber', params: [],
    });
    worker.emit('message', { type: 'result', id, ok: true, result: '0x10' });
    await expect(promise).resolves.toBe('0x10');

    // Same chain, another client: same worker. Another chain: its own worker.
    await startRequest(host.createClient(CONFIG), { method: 'eth_chainId' });
    expect(Worker).toHaveBeenCalledTimes(1);
    await startRequest(host.createClient({ ...CONFIG, chainId: 100 }), { method: 'eth_chainId' });
    expect(Worker).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(2);
  });

  test('revives worker errors with code and revert data for ethers/the router', async () => {
    const { promise, worker, id } =
      await startRequest(host.createClient(CONFIG), { method: 'eth_call', params: [{}] });
    worker.emit('message', {
      type: 'result', id, ok: false,
      error: { name: 'ProviderRpcError', message: 'execution reverted', code: 3, data: '0xdead' },
    });
    await expect(promise).rejects.toMatchObject({
      name: 'ProviderRpcError', message: 'execution reverted', code: 3, data: '0xdead',
    });
  });

  test('a request settling before its deadline leaves no timers or probes', async () => {
    const { promise, worker, id } =
      await startRequest(host.createClient(CONFIG), { method: 'eth_call' }, { deadlineMs: 2000 });
    worker.emit('message', { type: 'result', id, ok: true, result: '0x' });
    await promise;
    jest.advanceTimersByTime(10 * 60_000);
    expect(worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  test('terminates a worker still verifying past the deadline and starts a fresh one', async () => {
    const client = host.createClient(CONFIG);
    const { promise, worker } = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(2000);
    const ping = worker.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'ping');
    expect(ping).toBeDefined();
    // Busy in synchronous WASM: no pong.
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toThrow(/Colibri worker replaced: verification still running/);
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringMatching(/chain 1 worker replaced/));

    // A late 'exit' from the terminated worker is absorbed, and the next
    // request gets a new worker rather than the stuck one.
    worker.emit('exit', 1);
    const next = await startRequest(client, { method: 'eth_blockNumber' });
    expect(next.worker).not.toBe(worker);
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  test('leaves a responsive worker waiting on the network until the abandon cap', async () => {
    const { promise, worker } =
      await startRequest(host.createClient(CONFIG), { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(2000);
    const ping = worker.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'ping');
    worker.emit('message', { type: 'pong', id: ping.id });
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(worker.terminate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(host.ABANDONED_MS);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toThrow(/request abandoned after its deadline/);
  });

  test('requests without a caller deadline get the default liveness check', async () => {
    const { worker } = await startRequest(host.createClient(CONFIG), { method: 'eth_call' });
    jest.advanceTimersByTime(host.DEFAULT_DEADLINE_MS - 1);
    expect(worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(false);
    jest.advanceTimersByTime(1);
    expect(worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
  });

  test('a WASM trap retires the worker once its in-flight requests drain', async () => {
    const client = host.createClient(CONFIG);
    const a = await startRequest(client, { method: 'eth_getTransactionReceipt' });
    const b = await startRequest(client, { method: 'eth_blockNumber' });
    const trapped = a.worker;
    trapped.emit('message', { type: 'trap', message: 'memory access out of bounds' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 WASM verifier trapped (memory access out of bounds); replacing the worker'
    );
    // New work goes to a fresh worker straight away.
    const c = await startRequest(client, { method: 'eth_chainId' });
    expect(c.worker).not.toBe(trapped);
    trapped.emit('message', {
      type: 'result', id: a.id, ok: false,
      error: { name: 'RuntimeError', message: 'memory access out of bounds' },
    });
    await expect(a.promise).rejects.toMatchObject({ name: 'RuntimeError' });
    expect(trapped.terminate).not.toHaveBeenCalled();
    trapped.emit('message', { type: 'result', id: b.id, ok: true, result: '0x1' });
    await expect(b.promise).resolves.toBe('0x1');
    expect(trapped.terminate).toHaveBeenCalledTimes(1);
    expect(c.worker.terminate).not.toHaveBeenCalled();
  });

  test('a worker that exits fails its requests instead of leaving them pending', async () => {
    const { promise, worker } = await startRequest(host.createClient(CONFIG), { method: 'eth_call' });
    worker.emit('error', new Error('Worker terminated due to reaching memory limit'));
    await expect(promise).rejects.toThrow(/memory limit/);
    worker.emit('exit', 1);
  });

  test('an init failure rejects waiting callers and the next call respawns', async () => {
    const client = host.createClient(CONFIG);
    const promise = client.request({ method: 'eth_call' });
    promise.catch(() => {});
    await flush();
    lastWorker().emit('message', { type: 'init-error', error: { message: 'EACCES' } });
    await expect(promise).rejects.toThrow(/failed to start: init failed \(EACCES\)/);
    host.ensureWorker(1).catch(() => {});
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  test('destroy tells every worker the client used to drop it', async () => {
    const client = host.createClient(CONFIG);
    const { worker, id } = await startRequest(client, { method: 'eth_chainId' });
    worker.emit('message', { type: 'result', id, ok: true, result: '0x1' });
    client.destroy();
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'destroy', clientId: sentRequests(worker)[0].clientId,
    });
    await expect(client.request({ method: 'eth_chainId' })).rejects.toThrow(/destroyed/);
  });
});
