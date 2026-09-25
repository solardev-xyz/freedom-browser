const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

jest.mock('node:worker_threads', () => ({ Worker: jest.fn() }));
const {
  acquireCheckpoint,
  validateCheckpoint,
  CHECKPOINT_NETWORKS,
  DEADLINE_MS,
  MAX_AGE_MS,
} = require('./checkpoint-verifier');

const NOW = Date.UTC(2026, 8, 14, 21);
function checkpoint(chainId = 1) {
  const config = CHECKPOINT_NETWORKS[chainId];
  const slot =
    Math.floor((NOW / 1000 - config.genesis) / config.secondsPerSlot / config.slotsPerEpoch) *
      config.slotsPerEpoch -
    config.slotsPerEpoch;
  return {
    schemaVersion: 2,
    chainId,
    network: config.network,
    root: '0x' + '12'.repeat(32),
    slot,
    verifiedAt: NOW,
    sources: config.sources.slice(0, config.participants),
    finalizedEpoch: slot / config.slotsPerEpoch,
  };
}

describe('checkpoint worker lifecycle', () => {
  let worker;
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    Worker.mockReset();
    Worker.mockImplementation(() => {
      worker = new EventEmitter();
      worker.terminate = jest.fn(() => Promise.resolve(1));
      worker.stdout = { resume: jest.fn() };
      worker.stderr = { resume: jest.fn() };
      return worker;
    });
  });
  afterEach(() => jest.useRealTimers());

  test('a successful narrow result terminates its isolated worker', async () => {
    const promise = acquireCheckpoint(1);
    expect(Worker).toHaveBeenCalledWith(expect.stringMatching(/checkpoint-verifier-worker\.js$/), {
      workerData: { chainId: 1 },
      execArgv: [],
      env: { C4_DISABLE_NATIVE: '1' },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    worker.emit('message', { ok: true, checkpoint: { ...checkpoint(), extra: 'not persisted' } });
    await expect(promise).resolves.toEqual(checkpoint());
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(['1', 10, null, {}, NaN])(
    'rejects unsupported chain %p before spawning',
    async (chainId) => {
      await expect(acquireCheckpoint(chainId)).rejects.toMatchObject({
        code: 'CHECKPOINT_MISMATCH',
      });
      expect(Worker).not.toHaveBeenCalled();
    }
  );

  test('pre-aborted requests never spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireCheckpoint(1, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'CHECKPOINT_UNAVAILABLE',
    });
    expect(Worker).not.toHaveBeenCalled();
  });

  test('abort terminates a busy worker and ignores its late success/error', async () => {
    const controller = new AbortController();
    const promise = acquireCheckpoint(1, { signal: controller.signal });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    worker.emit('message', { ok: true, checkpoint: checkpoint() });
    expect(() => worker.emit('error', new Error('late'))).not.toThrow();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(['success', 'abort'])(
    'waits for worker termination before settling %s',
    async (outcome) => {
      const controller = new AbortController();
      let terminated;
      const promise = acquireCheckpoint(1, { signal: controller.signal });
      worker.terminate.mockImplementation(
        () =>
          new Promise((resolve) => {
            terminated = resolve;
          })
      );
      let completed = false;
      const observed = promise.then(
        (value) => {
          completed = true;
          return value;
        },
        (error) => {
          completed = true;
          return error;
        }
      );
      if (outcome === 'success') worker.emit('message', { ok: true, checkpoint: checkpoint() });
      else controller.abort();
      await Promise.resolve();
      expect(completed).toBe(false);
      worker.emit('error', new Error('late termination error'));
      expect(completed).toBe(false);
      terminated(1);
      const result = await observed;
      if (outcome === 'success') expect(result).toEqual(checkpoint());
      else expect(result.name).toBe('AbortError');
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    }
  );

  test.each(['reject', 'throw'])(
    'termination %s never publishes a successful checkpoint',
    async (failure) => {
      const promise = acquireCheckpoint(1);
      worker.terminate.mockImplementation(() => {
        if (failure === 'throw') throw new Error('termination private details');
        return Promise.reject(new Error('termination private details'));
      });
      worker.emit('message', { ok: true, checkpoint: checkpoint() });
      await expect(promise).rejects.toMatchObject({
        code: 'CHECKPOINT_UNAVAILABLE',
        message: expect.not.stringContaining('private details'),
      });
    }
  );

  test('total deadline terminates work even with no worker event', async () => {
    const promise = acquireCheckpoint(1);
    const rejected = expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
    jest.advanceTimersByTime(DEADLINE_MS);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test.each(['error', 'exit'])('unexpected worker %s fails closed', async (event) => {
    const promise = acquireCheckpoint(1);
    worker.emit(event, event === 'error' ? new Error('private details') : 0);
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
  });

  test('spawn failure is bounded and sanitized', async () => {
    Worker.mockImplementation(() => {
      throw new Error('private path');
    });
    await expect(acquireCheckpoint(1)).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE',
      message: expect.not.stringContaining('private path'),
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([
    'CHECKPOINT_MISMATCH',
    'CHECKPOINT_STALE',
    'CHECKPOINT_RACE',
    'CHECKPOINT_CLOCK',
    'CHECKPOINT_INCOMPATIBLE',
    'CHECKPOINT_QUORUM_UNAVAILABLE',
    'CHECKPOINT_QUORUM_CONFLICT',
  ])(
    'preserves worker error category %s without arbitrary message text',
    async (code) => {
      const promise = acquireCheckpoint(1);
      worker.emit('message', { ok: false, error: { code, message: 'private details' } });
      await expect(promise).rejects.toMatchObject({
        code,
        message: expect.not.stringContaining('private details'),
      });
    }
  );

  test('wrong-chain worker result cannot reach the caller', async () => {
    const promise = acquireCheckpoint(1);
    worker.emit('message', { ok: true, checkpoint: checkpoint(100) });
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
  });

  test('abort actually terminates a worker running synchronous WASM', async () => {
    jest.useRealTimers();
    const { Worker: RealWorker } = jest.requireActual('node:worker_threads');
    const started = new Int32Array(new SharedArrayBuffer(4));
    let realWorker;
    Worker.mockImplementation(() => {
      realWorker = new RealWorker(
        `
        const {workerData} = require('node:worker_threads');
        const module = new WebAssembly.Module(new Uint8Array([
          0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,
          7,8,1,4,115,112,105,110,0,0,10,9,1,7,0,3,64,12,0,11,11
        ]));
        const instance = new WebAssembly.Instance(module);
        Atomics.store(new Int32Array(workerData), 0, 1);
        instance.exports.spin();
      `,
        { eval: true, workerData: started.buffer }
      );
      return realWorker;
    });
    const controller = new AbortController();
    const promise = acquireCheckpoint(1, { signal: controller.signal });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    try {
      const limit = Date.now() + 2000;
      while (!Atomics.load(started, 0) && Date.now() < limit) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(Atomics.load(started, 0)).toBe(1);
      const exited = new Promise((resolve) => realWorker.once('exit', resolve));
      controller.abort();
      await rejected;
      await exited;
      expect(realWorker.threadId).toBe(-1);
    } finally {
      controller.abort();
      await realWorker.terminate();
    }
  }, 5000);

  test('each attempt uses a distinct worker', async () => {
    const first = acquireCheckpoint(1);
    const firstWorker = worker;
    firstWorker.emit('message', { ok: true, checkpoint: checkpoint() });
    await first;
    const second = acquireCheckpoint(1);
    expect(worker).not.toBe(firstWorker);
    worker.emit('message', { ok: true, checkpoint: checkpoint() });
    await second;
    expect(Worker).toHaveBeenCalledTimes(2);
  });
});

describe('checkpoint record validation', () => {
  test.each([1, 100])('validates pinned chain %i', (chainId) => {
    expect(validateCheckpoint(checkpoint(chainId), chainId, { now: NOW })).toEqual(
      checkpoint(chainId)
    );
  });

  test.each([
    { sources: ['https://mainnet1.colibri-proof.tech'] },
    { root: '0x' + '00'.repeat(32) },
    { slot: 1.5 },
    { network: 'gnosis' },
    { schemaVersion: 3 },
    { finalizedEpoch: -1 },
  ])('rejects malformed or unpinned record %p', (patch) => {
    expect(() => validateCheckpoint({ ...checkpoint(), ...patch }, 1, { now: NOW })).toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' })
    );
  });

  test.each([
    [],
    [CHECKPOINT_NETWORKS[1].sources[0]],
    Array(2).fill(CHECKPOINT_NETWORKS[1].sources[0]),
    CHECKPOINT_NETWORKS[1].sources.slice(0, 4),
    ['https://unapproved.invalid', CHECKPOINT_NETWORKS[1].sources[0]],
  ])('missing, duplicate or unapproved voters cannot authorize a record: %p', (...sources) => {
    expect(() => validateCheckpoint({ ...checkpoint(), sources }, 1, { now: NOW })).toThrow();
  });

  test('legacy single-authority records can resume but cannot authorize new recovery', () => {
    const value = { ...checkpoint(), schemaVersion: 1, source: CHECKPOINT_NETWORKS[1].source };
    delete value.sources;
    expect(() => validateCheckpoint(value, 1, { now: NOW })).toThrow();
    expect(validateCheckpoint(value, 1, { now: NOW, fresh: false })).toEqual(value);
  });

  test('aged record is valid structurally for native snapshot freshness evaluation', () => {
    const value = checkpoint();
    const later = NOW + MAX_AGE_MS + 1;
    expect(() => validateCheckpoint(value, 1, { now: later })).toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_STALE' })
    );
    expect(validateCheckpoint(value, 1, { now: later, fresh: false })).toEqual(value);
    expect(() =>
      validateCheckpoint({ ...value, sources: ['https://other.test'] }, 1, { fresh: false })
    ).toThrow(expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' }));
  });

  test('a record verified in the future is a clock error', () => {
    expect(() =>
      validateCheckpoint({ ...checkpoint(), verifiedAt: NOW + 1 }, 1, { now: NOW })
    ).toThrow(expect.objectContaining({ code: 'CHECKPOINT_CLOCK' }));
  });
});
