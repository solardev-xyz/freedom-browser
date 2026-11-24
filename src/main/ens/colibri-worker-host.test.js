/**
 * Colibri's backends (freedom-core design 0014, COL-5) in two parts:
 *
 * - **The contract**, once per backend (`test/helpers/colibri-backends.js`):
 *   colibri-worker-host.js on its real worker threads and the package's
 *   WASM verifier, and colibri-service.js on the real freedom-colibrid
 *   binary, against a scripted prover on loopback. What a backend answers
 *   there, and how its processes come and go, is the interface both keep:
 *   a chain's lanes, a failed remote proof byte for byte, a refusal, a
 *   death, the private session, `destroy`. An expectation that differs by
 *   design names its deviation.
 * - **The WASM host's own mechanics,** its workers scripted: its worker
 *   messages, the liveness ping (`STUCK_PROBE_MS`) and the suspects it
 *   blames, the abandon cap (`ABANDONED_MS`) and traps. The service's own
 *   are colibri-service.test.js's and colibrid-client.test.js's.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

// The scripted part gives Worker its fakes; the contract part the real
// worker threads (colibri-backends.js's `realWorker`).
jest.mock('node:worker_threads', () =>
  require('../../../test/helpers/colibri-backends').workerThreads()
);
const mockLogWarn = jest.fn();
jest.mock('../logger', () => ({
  warn: (...args) => mockLogWarn(...args),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const host = require('./colibri-worker-host');
const { isColibriFault } = require('../core/chain-verified');
const {
  PROVER_DOWN,
  describeBackends,
  deviation,
  outcomeOf,
  proverWorld,
  realWorker,
  startBackend,
} = require('../../../test/helpers/colibri-backends');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a promise has come to: its result, its error, or `'open'`. */
const settledOf = (promise) => {
  const state = { value: 'open' };
  promise.then(
    (result) => {
      state.value = { result };
    },
    (err) => {
      state.value = err;
    }
  );
  return state;
};

describeBackends('the Colibri backend contract', (backend) => {
  const ACCOUNT = '0x00000000000000000000000000000000000000aa';
  const BALANCE = { method: 'eth_getBalance', params: [ACCOUNT, 'latest'] };
  const CODE = { method: 'eth_getCode', params: [ACCOUNT, 'latest'] };
  /** The prover request either backend sends first for BALANCE, with an
   * empty store: the account's proof, at Colibri's version, with ZK. */
  const BALANCE_PROOF =
    `{"method":"eth_getProof","params":["${ACCOUNT}",[],"latest"],` +
    '"version":196611,"zk_proof":true}';
  /** createError's message for a failed remote proof (#1059, #1080). */
  const failedProof = ({ method, params }, text) =>
    `Error in rpc call ${method}${JSON.stringify(params)} : ` +
    `remote proof failed (no local proving): ${text}`;
  const outage = (read, text = 'HTTP error! Status: 503, Details: prover down') => ({
    name: 'ProviderRpcError',
    code: 4900,
    message: failedProof(read, text),
    data: undefined,
  });

  let userData;
  let world;
  let started;
  const config = (extra) => ({ chainId: 1, proverUrl: world.url, zkProof: true, ...extra });
  const client = (extra) => started.host.createClient(config(extra));
  const lanes = () => started.spawned.map((proc) => (proc.private ? 'private' : 'normal'));

  beforeEach(async () => {
    Worker.mockImplementation(realWorker);
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-contract-'));
    world = await proverWorld();
    started = await startBackend(backend, { userData });
  });

  afterEach(async () => {
    world.release();
    await started.close();
    await world.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test("a chain's clients share its process; another chain gets its own [deviation storage-per-chain]", async () => {
    await expect(client().request(BALANCE).catch(outcomeOf)).resolves.toEqual(outage(BALANCE));
    await expect(client().request(CODE).catch(outcomeOf)).resolves.toEqual(outage(CODE));
    expect(lanes()).toEqual(['normal']);
    await expect(client({ chainId: 100 }).request(BALANCE).catch(outcomeOf)).resolves.toEqual(
      outage(BALANCE)
    );
    const store = path.join(userData, 'colibri');
    expect(started.spawned.map((proc) => proc.storageDir)).toEqual(
      deviation('storage-per-chain', backend, {
        wasm: [store, store],
        service: [path.join(store, '1'), path.join(store, '100')],
      })
    );
    expect(world.requests.map(({ method }) => method)).toEqual(['POST', 'POST', 'POST']);
  });

  // #1059: the prover's error is the whole answer, never a local proof, and
  // the adapter's outcome is the same on both, cut at 2,000 units after
  // createError's prefix.
  test.each([
    ['a short body', 'prover down'],
    ['a body that is not ASCII', 'Überlastet – 稍后再试 🙂'],
    ['a body that takes the message past 2,000 units', 'x'.repeat(1_900)],
    ['a body past 2,000 units of its own', 'y'.repeat(2_500)],
  ])('a failed remote proof with %s reaches the caller byte for byte', async (_label, body) => {
    world.answer = { status: 503, body };
    const message = failedProof(BALANCE, `HTTP error! Status: 503, Details: ${body}`);
    await expect(client().request(BALANCE).catch(outcomeOf)).resolves.toEqual({
      ...outage(BALANCE),
      message: message.slice(0, 2_000),
    });
    expect(world.requests.map(({ body: sent }) => sent)).toEqual([BALANCE_PROOF]);
  });

  test('a transport failure is no HTTP error [deviation fetch-error-text]', async () => {
    world.answer = 'transport';
    const url = deviation('fetch-error-text', backend, { wasm: world.url, service: '<url>' });
    const err = await client().request(BALANCE).catch((caught) => caught);
    expect(outcomeOf(err)).toEqual({
      ...outage(BALANCE),
      code: -32603,
      message: failedProof(BALANCE, `Request to ${url} with payload ${BALANCE_PROOF} failed: fetch failed`),
    });
    expect(isColibriFault(err)).toBe(false);
  });

  test('a method neither serves is refused before any fetch', async () => {
    const read = { method: 'eth_unknownMethod', params: [{}] };
    await expect(client().request(read).catch(outcomeOf)).resolves.toEqual({
      name: 'ProviderRpcError',
      code: 4200,
      message: 'Error in rpc call eth_unknownMethod[{}] : Method eth_unknownMethod is not supported',
      data: undefined,
    });
    expect(world.requests).toEqual([]);
  });

  test("a store that can't be opened fails the read, as main's own error [deviation storage-per-chain]", async () => {
    fs.writeFileSync(path.join(userData, 'colibri'), 'not a directory');
    const errors = [];
    for (let i = 0; i < 2; i += 1) {
      const err = await client().request(BALANCE).catch((caught) => caught);
      expect(err).toBeInstanceOf(started.host.ColibriWorkerError);
      expect(isColibriFault(err)).toBe(false);
      errors.push(err.message);
    }
    expect(world.requests).toEqual([]);
    expect({ errors, lanes: lanes() }).toEqual(
      deviation('storage-per-chain', backend, {
        // Each read spawns a worker, whose store fails to open.
        wasm: {
          errors: new Array(2).fill(
            expect.stringMatching(/^Colibri worker failed to start: init failed \(EEXIST\b/)
          ),
          lanes: ['normal', 'normal'],
        },
        // The chain directory can't be made: nothing spawns, and the lane
        // stops until a client of another configuration or the next launch.
        service: { errors: new Array(2).fill('Colibri service unavailable'), lanes: [] },
      })
    );
    // A private read has no store to open.
    await expect(client({ private: true }).request(BALANCE).catch(outcomeOf)).resolves.toEqual(
      outage(BALANCE)
    );
  });

  test('eth_getLogs [deviation colibri-unserved]', async () => {
    const read = { method: 'eth_getLogs', params: [{}] };
    await expect(client().request(read).catch(outcomeOf)).resolves.toEqual(
      deviation('colibri-unserved', backend, {
        wasm: outage(read),
        service: {
          name: 'ProviderRpcError',
          code: 4200,
          message: 'Error in rpc call eth_getLogs[{}] : Method eth_getLogs is not supported',
          data: undefined,
        },
      })
    );
    expect(world.requests.map(({ body }) => JSON.parse(body).method)).toEqual(
      deviation('colibri-unserved', backend, { wasm: ['eth_getLogs'], service: [] })
    );
  });

  test('eth_chainId [deviation colibri-unserved]', async () => {
    const read = { method: 'eth_chainId', params: [] };
    const answer = await client()
      .request(read)
      .then((result) => ({ result }), outcomeOf);
    expect(answer).toEqual(
      deviation('colibri-unserved', backend, {
        wasm: { result: '0x1' },
        service: {
          name: 'ProviderRpcError',
          code: 4200,
          message: 'Error in rpc call eth_chainId[] : Method eth_chainId is not supported',
          data: undefined,
        },
      })
    );
    expect(world.requests).toEqual([]);
  });

  test('a request still waiting on the prover at its deadline [deviation colibri-deadline]', async () => {
    world.answer = 'hold';
    const reader = client();
    const state = settledOf(reader.request(BALANCE, { deadlineMs: 300 }));
    await world.until(1);
    const ended = deviation('colibri-deadline', backend, { wasm: false, service: true });
    if (ended) {
      while (state.value === 'open') await sleep(5);
    } else {
      // The worker answers its ping: it only waits on the network.
      await sleep(300 + host.STUCK_PROBE_MS + 500);
    }
    if (!ended) {
      expect(state.value).toBe('open');
      world.release();
      while (state.value === 'open') await sleep(5);
      expect(outcomeOf(state.value)).toEqual(outage(BALANCE));
    } else {
      // Two answers race at the deadline: main's cancel (`cancelled`), and
      // the service's own bound on its fetch, whose error the C core gets
      // as the remote proof's and ends the read with. Either is no fault
      // and ends nothing else.
      // TODO(design 0014 amendment, the deadline's outcome): main decides,
      // so any reply but a result read at or after the deadline is
      // `Colibri request cancelled at its deadline`. Accept only that once
      // colibrid-client.js's fix is merged forward.
      expect([
        {
          name: 'ColibriWorkerError',
          code: undefined,
          message: 'Colibri request cancelled at its deadline',
          data: undefined,
        },
        {
          ...outage(BALANCE),
          code: -32603,
          message: failedProof(BALANCE, 'Colibri fetch deadline passed'),
        },
      ]).toContainEqual(outcomeOf(state.value));
      expect(state.value.colibriBystander).toBeUndefined();
      expect(isColibriFault(state.value)).toBe(false);
    }
    // Nothing else ended: the same process serves the next read.
    world.answer = PROVER_DOWN;
    await expect(reader.request(CODE).catch(outcomeOf)).resolves.toEqual(outage(CODE));
    expect(lanes()).toEqual(['normal']);
  }, 15_000);

  test('a process that dies under open requests [deviation colibri-culprit]', async () => {
    world.answer = 'hold';
    const first = settledOf(client().request(BALANCE, { deadlineMs: 20_000 }));
    const second = settledOf(client().request(CODE, { deadlineMs: 20_000 }));
    await world.until(2);
    world.answer = PROVER_DOWN;
    started.spawned[0].kill();
    await started.spawned[0].exited;
    while (first.value === 'open' || second.value === 'open') await sleep(5);
    const outcomes = deviation('colibri-culprit', backend, {
      // Each fails as its own fault: the exit names no culprit, and a
      // fault-pattern error without `colibriBystander` counts as one.
      wasm: [
        { name: 'ColibriWorkerError', message: 'Colibri worker replaced: worker exited (1)' },
        { name: 'ColibriWorkerError', message: 'Colibri worker replaced: worker exited (1)' },
      ],
      // Waiting on a fetch, neither was in a step: the death names nobody,
      // and both go once more to the lane's next process.
      service: [outage(BALANCE), outage(CODE)],
    });
    expect(outcomeOf(first.value)).toMatchObject(outcomes[0]);
    expect(outcomeOf(second.value)).toMatchObject(outcomes[1]);
    expect([first.value, second.value].map(isColibriFault)).toEqual(
      deviation('colibri-culprit', backend, { wasm: [true, true], service: [false, false] })
    );
    expect(lanes()).toEqual(
      deviation('colibri-culprit', backend, { wasm: ['normal'], service: ['normal', 'normal'] })
    );
  }, 15_000);

  test('a fourth chain while three are busy [deviation colibri-processes]', async () => {
    world.answer = 'hold';
    const busy = [1, 100, 11155111].map((chainId) =>
      settledOf(client({ chainId }).request(BALANCE, { deadlineMs: 20_000 }))
    );
    await world.until(3);
    const fourth = settledOf(client({ chainId: 10200 }).request(BALANCE, { deadlineMs: 20_000 }));
    const fourthLane = deviation('colibri-processes', backend, { wasm: 4, service: 3 });
    if (fourthLane === 4) await world.until(4);
    else while (fourth.value === 'open') await sleep(5);
    expect(started.spawned).toHaveLength(fourthLane);
    if (backend.kind === 'service') {
      expect(outcomeOf(fourth.value)).toMatchObject({
        name: 'ColibriWorkerError',
        message: 'Colibri service busy',
      });
      expect(isColibriFault(fourth.value)).toBe(false);
    }
    world.release();
    for (const state of [...busy, fourth]) {
      while (state.value === 'open') await sleep(5);
    }
    for (const state of busy) expect(outcomeOf(state.value)).toEqual(outage(BALANCE));
    if (backend.kind === 'wasm') expect(outcomeOf(fourth.value)).toEqual(outage(BALANCE));
  }, 15_000);

  test("a destroyed client's requests are refused", async () => {
    const reader = client();
    await expect(reader.request(BALANCE).catch(outcomeOf)).resolves.toEqual(outage(BALANCE));
    reader.destroy();
    await expect(reader.request(BALANCE)).rejects.toMatchObject({
      name: 'ColibriWorkerError',
      message: 'Colibri client was destroyed',
    });
    expect(world.requests).toHaveLength(1);
  });

  // #1058: Colibri's store names what a read touched, so private windows'
  // reads run on a process of their own whose store is in memory.
  describe('private windows', () => {
    test('a private client runs on the private process, which has no store', async () => {
      await expect(client().request(BALANCE).catch(outcomeOf)).resolves.toEqual(outage(BALANCE));
      await expect(client({ private: true }).request(BALANCE).catch(outcomeOf)).resolves.toEqual(
        outage(BALANCE)
      );
      // Every private client of the chain shares it; a normal one keeps the
      // normal process.
      await expect(client({ private: true }).request(CODE).catch(outcomeOf)).resolves.toEqual(
        outage(CODE)
      );
      await expect(client().request(CODE).catch(outcomeOf)).resolves.toEqual(outage(CODE));
      expect(lanes()).toEqual(['normal', 'private']);
      expect(started.spawned[1].storageDir).toBeNull();
    });

    test('ensureWorker readies the private process only when asked for it', async () => {
      await expect(started.host.ensureWorker(1, { private: true })).resolves.toBeUndefined();
      expect(lanes()).toEqual(['private']);
      await expect(started.host.ensureWorker(1)).resolves.toBeUndefined();
      expect(lanes()).toEqual(['private', 'normal']);
    });

    test('the end of the private session ends the private process only', async () => {
      world.answer = 'hold';
      const normal = settledOf(client().request(BALANCE, { deadlineMs: 20_000 }));
      const privateReader = client({ private: true });
      const pending = settledOf(privateReader.request(BALANCE, { deadlineMs: 20_000 }));
      await world.until(2);

      started.host.endPrivateSession();
      await started.spawned[1].exited;
      while (pending.value === 'open') await sleep(5);
      // Nobody's fault: a bystander, which the router's backoff skips.
      expect(pending.value).toMatchObject({
        name: 'ColibriWorkerError',
        message: 'Colibri worker replaced: private session ended',
        colibriBystander: true,
      });
      expect(isColibriFault(pending.value)).toBe(false);
      expect(normal.value).toBe('open');

      // A client of the ended session is refused, and nothing is spawned.
      await expect(privateReader.request(CODE)).rejects.toMatchObject({
        message: 'Colibri private session ended',
        colibriBystander: true,
      });
      expect(lanes()).toEqual(['normal', 'private']);

      world.answer = PROVER_DOWN;
      world.release();
      while (normal.value === 'open') await sleep(5);
      expect(outcomeOf(normal.value)).toEqual(outage(BALANCE));
      // The next private window's first read starts a new private process.
      await expect(client({ private: true }).request(BALANCE).catch(outcomeOf)).resolves.toEqual(
        outage(BALANCE)
      );
      expect(lanes()).toEqual(['normal', 'private', 'private']);
    });

    test('a private process still starting when the session ends fails its waiter as a bystander', async () => {
      const pending = client({ private: true }).request(BALANCE);
      started.host.endPrivateSession();
      await expect(pending).rejects.toMatchObject({
        message: 'Colibri private session ended',
        colibriBystander: true,
      });
      expect(world.requests).toEqual([]);
    });
  });
});

describe('the WASM worker host, its workers scripted', () => {
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

  // #750: one unknown-hash lookup keeping the worker busy past its deadline
  // used to fail every unrelated request on that worker with it.
  test('a stuck-worker kill sends bystanders still inside their deadline to the new worker', async () => {
    const client = host.createClient(CONFIG);
    const stuck = await startRequest(client, { method: 'eth_getTransactionReceipt' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1500);
    const bystander = await startRequest(client, { method: 'eth_call', params: [{ to: '0xabc' }] },
      { deadlineMs: 2000 });
    expect(bystander.worker).toBe(stuck.worker);
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    expect(stuck.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(stuck.promise).rejects.toThrow(/verification still running after its deadline/);
    // Two requests of different methods were on the worker: whose deadline
    // fired first says nothing about which one the verifier was spinning in.
    await expect(stuck.promise).rejects.toHaveProperty('colibriBystander', true);
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed, 1 sent to the new worker'
    );

    await flush();
    const fresh = lastWorker();
    expect(fresh).not.toBe(stuck.worker);
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_call', params: [{ to: '0xabc' }] });
    fresh.emit('message', { type: 'result', id: resent.id, ok: true, result: '0x01' });
    await expect(bystander.promise).resolves.toBe('0x01');
  });

  test('a resent bystander keeps what is left of its deadline and is not resent twice', async () => {
    const client = host.createClient(CONFIG);
    const stuck = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1500);
    const bystander = await startRequest(client, { method: 'eth_chainId' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    await expect(stuck.promise).rejects.toThrow(/still running/);
    await flush();
    const fresh = lastWorker();
    fresh.emit('message', { type: 'ready' });
    await flush();
    expect(sentRequests(fresh)).toHaveLength(1);
    // It spent 1500 of its 2000 ms on the killed worker: its deadline ping
    // comes 500 ms later, not a full 2000 ms later.
    jest.advanceTimersByTime(499);
    expect(fresh.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(false);
    jest.advanceTimersByTime(1);
    expect(fresh.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    // Overdue on the fresh worker too: it fails with it this time.
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    await expect(bystander.promise).rejects.toThrow(/still running/);
    await flush();
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  test('a stuck-worker kill does not resend a destroyed client’s request', async () => {
    const stuck = await startRequest(host.createClient(CONFIG), { method: 'eth_call' }, { deadlineMs: 2000 });
    const other = host.createClient(CONFIG);
    jest.advanceTimersByTime(1500);
    const bystander = await startRequest(other, { method: 'eth_chainId' }, { deadlineMs: 2000 });
    other.destroy();
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    await expect(stuck.promise).rejects.toThrow(/still running/);
    await expect(bystander.promise).rejects.toThrow(/Colibri worker replaced/);
    await expect(bystander.promise).rejects.toHaveProperty('colibriBystander', true);
    await flush();
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  // The router's per-method fault backoff skips an error marked this way: an
  // eth_call that only queued behind an unknown-hash lookup did not fault.
  test('a bystander already past its own deadline fails, marked as a bystander', async () => {
    const client = host.createClient(CONFIG);
    const stuck = await startRequest(client, { method: 'eth_getTransactionReceipt' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1500);
    const overdue = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 1000 });
    // Its own deadline (2500) passes; the stuck request's probe (3000) kills
    // the worker before its own (3500) would.
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    expect(stuck.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(stuck.promise).rejects.toHaveProperty('colibriBystander', true);
    await expect(overdue.promise).rejects.toThrow(/Colibri worker replaced/);
    await expect(overdue.promise).rejects.toHaveProperty('colibriBystander', true);
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '2 request(s) failed'
    );
  });

  test('a stuck worker with one request on it blames that request', async () => {
    const { promise } =
      await startRequest(host.createClient(CONFIG), { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(2000 + host.STUCK_PROBE_MS);
    await expect(promise).rejects.toThrow(/verification still running/);
    await expect(promise).rejects.not.toHaveProperty('colibriBystander');
  });

  // R2-M1: a receipt lookup with the configured timeout spins the verifier; a
  // page eth_call's shorter deadline fires first. eth_call must not be blamed,
  // and the receipt lookup, resent, is blamed once it spins alone.
  test('the request whose deadline fires first is not blamed for another one spinning', async () => {
    const client = host.createClient(CONFIG);
    const spinner = await startRequest(client, { method: 'eth_getTransactionReceipt' }, { deadlineMs: 5000 });
    const call = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    expect(call.worker).toBe(spinner.worker);
    jest.advanceTimersByTime(2000 + host.STUCK_PROBE_MS);
    expect(spinner.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(call.promise).rejects.toThrow(/verification still running/);
    await expect(call.promise).rejects.toHaveProperty('colibriBystander', true);

    await flush();
    const fresh = lastWorker();
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_getTransactionReceipt' });
    // Spins again, alone this time: now it is the known culprit.
    jest.advanceTimersByTime(2000 + host.STUCK_PROBE_MS);
    await expect(spinner.promise).rejects.toThrow(/verification still running/);
    await expect(spinner.promise).rejects.not.toHaveProperty('colibriBystander');
  });

  // R3-M1: a dApp polling a pending-tx receipt every second queues its next
  // poll behind the spinning lookup during the 1s probe. That poll was posted
  // after the ping, so it never reached the stuck worker: the spinner is still
  // the only suspect, is blamed (counts toward the router's fault backoff),
  // and the poll is resent.
  test('a request posted after the liveness ping is not a suspect', async () => {
    const client = host.createClient(CONFIG);
    const spinner = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xunknown'] },
      { deadlineMs: 2000 });
    jest.advanceTimersByTime(2000);
    expect(spinner.worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    jest.advanceTimersByTime(500);
    const poll = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xunknown'] },
      { deadlineMs: 2000 });
    expect(poll.worker).toBe(spinner.worker);
    jest.advanceTimersByTime(host.STUCK_PROBE_MS - 500);
    expect(spinner.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(spinner.promise).rejects.toThrow(/verification still running after its deadline/);
    await expect(spinner.promise).rejects.not.toHaveProperty('colibriBystander');
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed, 1 sent to the new worker'
    );

    await flush();
    const fresh = lastWorker();
    expect(fresh).not.toBe(spinner.worker);
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    fresh.emit('message', { type: 'result', id: resent.id, ok: true, result: null });
    await expect(poll.promise).resolves.toBeNull();
  });

  // R4-M1: the same dApp poll, but posted a second after the spinner and so
  // before the ping (1s poll, 2s deadline). Both are suspects; they share a
  // method, and the router's fault backoff is per method, so the deadline
  // holder is blamed. The poll, out of deadline as the probe expires, fails
  // as a bystander: exactly one fault is counted.
  test('suspects of a single method are attributed to it', async () => {
    const client = host.createClient(CONFIG);
    const spinner = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpending'] },
      { deadlineMs: 2000 });
    jest.advanceTimersByTime(1000);
    const poll = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpending'] },
      { deadlineMs: 2000 });
    expect(poll.worker).toBe(spinner.worker);
    jest.advanceTimersByTime(1000);
    expect(spinner.worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(spinner.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(spinner.promise).rejects.toThrow(/verification still running after its deadline/);
    await expect(spinner.promise).rejects.not.toHaveProperty('colibriBystander');
    await expect(poll.promise).rejects.toHaveProperty('colibriBystander', true);
  });

  test('of single-method suspects with deadline left, only the blamed one is not resent', async () => {
    const client = host.createClient(CONFIG);
    const spinner = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpending'] },
      { deadlineMs: 2000 });
    jest.advanceTimersByTime(1000);
    const poll = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpending'] },
      { deadlineMs: 5000 });
    jest.advanceTimersByTime(1000 + host.STUCK_PROBE_MS);
    await expect(spinner.promise).rejects.not.toHaveProperty('colibriBystander');
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed, 1 sent to the new worker'
    );
    await flush();
    const fresh = lastWorker();
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_getTransactionReceipt', params: ['0xpending'] });
    fresh.emit('message', { type: 'result', id: resent.id, ok: true, result: null });
    await expect(poll.promise).resolves.toBeNull();
  });

  // R5-M1: of single-method suspects, the deadline holder is blamed even when
  // it is not the oldest. A page's 2s receipt lookup lands behind a wallet
  // waitForTransaction lookup running on the configured timeout: the page's
  // overdue request is blamed, the wallet's older one (deadline left) resent.
  test('of single-method suspects, the deadline holder is blamed, not the oldest', async () => {
    const client = host.createClient(CONFIG);
    const wallet = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xwallet'] },
      { deadlineMs: 10_000 });
    jest.advanceTimersByTime(500);
    const page = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpage'] },
      { deadlineMs: 2000 });
    expect(page.worker).toBe(wallet.worker);
    jest.advanceTimersByTime(2000);
    expect(wallet.worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(wallet.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(page.promise).rejects.toThrow(/verification still running after its deadline/);
    await expect(page.promise).rejects.not.toHaveProperty('colibriBystander');
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed, 1 sent to the new worker'
    );
    await flush();
    const fresh = lastWorker();
    expect(fresh).not.toBe(wallet.worker);
    fresh.emit('message', { type: 'ready' });
    await flush();
    const sent = sentRequests(fresh);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'eth_getTransactionReceipt', params: ['0xwallet'] });
    fresh.emit('message', { type: 'result', id: sent[0].id, ok: true, result: null });
    await expect(wallet.promise).resolves.toBeNull();
  });

  // R4-M2: the deadline holder settles during the probe, so the worker then
  // blocked in the one other suspect. That one is blamed and, although it has
  // deadline left, failed rather than resent: it would spin again.
  test('a suspect blamed for a stuck worker is failed, not resent', async () => {
    const client = host.createClient(CONFIG);
    const holder = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1000);
    const blocker = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xunknown'] },
      { deadlineMs: 5000 });
    jest.advanceTimersByTime(1000);
    expect(holder.worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    holder.worker.emit('message', { type: 'result', id: holder.id, ok: true, result: '0x2' });
    await expect(holder.promise).resolves.toBe('0x2');
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(holder.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(blocker.promise).rejects.toThrow(/verification still running after its deadline/);
    await expect(blocker.promise).rejects.not.toHaveProperty('colibriBystander');
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed'
    );
    await flush();
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  test('after a trap, a request the retired instance refused is retried once on a fresh worker', async () => {
    const client = host.createClient(CONFIG);
    const a = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xunknown'] });
    const b = await startRequest(client, { method: 'eth_blockNumber' });
    const trapped = a.worker;
    trapped.emit('message', { type: 'trap', message: 'memory access out of bounds' });
    // The trapping request itself fails: asking again would trap again.
    trapped.emit('message', {
      type: 'result', id: a.id, ok: false,
      error: { name: 'ProviderRpcError', message: 'memory access out of bounds', code: -32603 },
    });
    await expect(a.promise).rejects.toThrow(/memory access out of bounds/);
    await expect(a.promise).rejects.not.toHaveProperty('colibriBystander');
    const refused = {
      name: 'ProviderRpcError',
      message: 'Colibri WASM runtime was retired after a trap; refusing execute()',
    };
    trapped.emit('message', { type: 'result', id: b.id, ok: false, error: refused, retry: true });
    expect(trapped.terminate).toHaveBeenCalledTimes(1);
    await flush();
    const fresh = lastWorker();
    expect(fresh).not.toBe(trapped);
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_blockNumber' });

    // Refused again on the fresh worker: no second retry.
    fresh.emit('message', { type: 'trap', message: 'memory access out of bounds' });
    fresh.emit('message', { type: 'result', id: resent.id, ok: false, error: refused, retry: true });
    await expect(b.promise).rejects.toThrow(/retired after a trap/);
    await expect(b.promise).rejects.toHaveProperty('colibriBystander', true);
    await flush();
    expect(Worker).toHaveBeenCalledTimes(2);
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

  // #1058: private windows' reads run on a worker of their own with no
  // storage dir (the contract above); a trap's draining worker is the WASM
  // host's own.
  describe('private windows', () => {
    const PRIVATE = { ...CONFIG, private: true };

    test('the end of the session reaches a private worker still draining after a trap', async () => {
      const client = host.createClient(PRIVATE);
      const a = await startRequest(client, { method: 'eth_getTransactionReceipt' });
      a.worker.emit('message', { type: 'trap', message: 'memory access out of bounds' });
      expect(mockLogWarn).toHaveBeenCalledWith(
        '[colibri] chain 1 (private) WASM verifier trapped (memory access out of bounds); replacing the worker'
      );
      const b = await startRequest(client, { method: 'eth_chainId' });
      expect(b.worker).not.toBe(a.worker);
      expect(a.worker.terminate).not.toHaveBeenCalled();

      host.endPrivateSession();

      expect(a.worker.terminate).toHaveBeenCalledTimes(1);
      expect(b.worker.terminate).toHaveBeenCalledTimes(1);
      await expect(a.promise).rejects.toMatchObject({ colibriBystander: true });
      await expect(b.promise).rejects.toMatchObject({ colibriBystander: true });
    });
  });
});
