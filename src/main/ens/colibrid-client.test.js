/**
 * The client for one freedom-colibrid process (`colibrid-client.js`,
 * freedom-core design 0014), against `test/helpers/fake-colibrid.js`, with
 * main's clock and timers run by hand:
 * - the process: its arguments for the three kinds, its handshake and each
 *   refusal of it, `restart: false`, its scheduling priority;
 * - `colibri.request`, `colibri.checkpoint`, `colibri.forget` and
 *   `colibri.stats`: the params main writes, the operation a request opens
 *   for main's fetches, and its outcome;
 * - refusals: the recycling one apart from every other;
 * - deadlines: main's cancel at the deadline settles only on the reply, a
 *   step 2 s past it is killed and named, no reply 15 s past it is a hang;
 * - deaths: a death inside a step names that request, one outside any
 *   names nobody, a marker read after the exit still counts, and every
 *   other open request is a bystander;
 * - forged markers kill the process and name nobody;
 * - `shell.colibri_fetch` reaches the executor with the open request's
 *   operation, and is refused for any other.
 *
 * The markers' rules one by one are in colibri-markers.test.js.
 */

const os = require('os');
const {
  ColibridClient,
  colibridArgs,
  validHello,
  lowerPriority,
  COLIBRID_TEXTS,
  DEFAULT_DEADLINE_MS,
  HANG_GRACE_MS,
  SHUTDOWN_GRACE_MS,
} = require('./colibrid-client');
const { OVERRUN_MS } = require('./colibri-markers');
const { ColibriWorkerError } = require('./colibri-worker-host');
const { ColibriFetchPool } = require('./colibri-fetch-pool');
const { makeHop } = require('../core/naming-shell');
const { isColibriFault } = require('../core/chain-verified');
const { isCapacityFailure } = require('../networks/chain-errors');
const {
  fakeColibrid,
  helloFor,
  statsResult,
  CONFINEMENT,
  HELLO,
} = require('../../../test/helpers/fake-colibrid');

const START = 1_700_000_000_000;
const RETRYABLE = /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|no response|timeout/i;
/** A chain outside the package's lists: its only server is the prover. */
const LONE = 7777;
const PROVER = 'http://127.0.0.1:9/prover';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(predicate, what, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 5) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A clock and its timers, run by hand. */
function manualClock() {
  const clock = { now: START, timers: [] };
  clock.setTimer = (fn, ms) => {
    const timer = { fn, at: clock.now + ms, cleared: false, fired: false };
    clock.timers.push(timer);
    return timer;
  };
  clock.clearTimer = (timer) => {
    if (timer) timer.cleared = true;
  };
  clock.advance = (ms) => {
    const until = clock.now + ms;
    for (;;) {
      const due = clock.timers
        .filter((t) => !t.cleared && !t.fired && t.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = due.at;
      due.fired = true;
      due.fn();
    }
    clock.now = until;
  };
  return clock;
}

let clients;
let priority;

beforeEach(() => {
  clients = [];
  // Never a real process's: the fake children's PIDs may be anyone's.
  priority = jest.spyOn(os, 'setPriority').mockImplementation(() => {});
});

afterEach(async () => {
  for (const client of clients) await client.stop();
  jest.restoreAllMocks();
});

/** A client of fake freedom-colibrid children (a private process of chain
 * 100 by default), its clock run by hand, with `extra` options. */
function colibrid({ script = {}, kind = 'private', chain = 100, ...extra } = {}) {
  const fake = fakeColibrid(script);
  const clock = manualClock();
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = new ColibridClient({
    kind,
    chain,
    parentPid: 4242,
    command: '/bin/freedom-colibrid',
    serviceVersion: '0.1.1',
    spawn: fake.spawn,
    log,
    shellVersion: '9.9.9',
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fetchPool: new ColibriFetchPool(),
    platform: 'linux',
    ...extra,
  });
  clients.push(client);
  return { client, fake, children: fake.children, log, clock };
}

/**
 * A started client; `requests` collects main's `colibri.request`s as the
 * child reads them, and `handle(message, child)` answers each once main's
 * write of it has returned, as a real pipe delivers it: the fake reads
 * main's frames inside main's write, and main reads what the fake writes
 * inside the fake's, so a marker written at once would reach main before
 * the request's `onSent`.
 */
async function serving({ handle = () => {}, script = {}, ...options } = {}) {
  const requests = [];
  const made = colibrid({
    ...options,
    script: {
      request: (message, child) => {
        requests.push(message);
        setImmediate(() => handle(message, child));
      },
      ...script,
    },
  });
  await made.client.start();
  return { ...made, child: made.children[0], requests };
}

/** One of the client's Colibri requests. */
function ask(client, fields = {}, options = {}) {
  return client.request(
    { client: 'c1', zk: false, prover: PROVER, method: 'eth_blockNumber', params: [], ...fields },
    options
  );
}

/** A promise's outcome once it settles: `{ result }` or `{ error }`. */
function outcomeOf(promise) {
  const state = { settled: false };
  state.done = promise.then(
    (result) => Object.assign(state, { settled: true, result }),
    (error) => Object.assign(state, { settled: true, error })
  );
  return state;
}

const exitOf = (client) => new Promise((resolve) => client.once('exit', resolve));

describe('the process', () => {
  test('its arguments for the three kinds, and what it refuses to build', () => {
    const chain = { chain: 100, parentPid: 4242 };
    expect(
      colibridArgs('persistent', {
        ...chain,
        dataDir: '/profile/colibri/100',
        lockDir: '/profile/locks',
      })
    ).toEqual([
      'serve',
      '--chain',
      '100',
      '--data-dir',
      '/profile/colibri/100',
      '--lock-dir',
      '/profile/locks',
      '--parent-pid',
      '4242',
    ]);
    expect(colibridArgs('private', chain)).toEqual([
      'serve',
      '--chain',
      '100',
      '--parent-pid',
      '4242',
    ]);
    expect(colibridArgs('checkpoint', { chain: 1, parentPid: 4242 })).toEqual([
      'checkpoint',
      '--chain',
      '1',
      '--parent-pid',
      '4242',
    ]);
    // A private or checkpoint process takes no directory, whatever it is given.
    expect(colibridArgs('private', { ...chain, dataDir: '/d', lockDir: '/l' })).toEqual(
      colibridArgs('private', chain)
    );
    expect(colibridArgs('private', { chain: 1 })).toEqual([
      'serve',
      '--chain',
      '1',
      '--parent-pid',
      String(process.pid),
    ]);
    for (const [kind, options] of [
      ['ephemeral', chain],
      ['persistent', chain],
      ['persistent', { ...chain, dataDir: '/d' }],
      ['persistent', { ...chain, dataDir: '', lockDir: '/l' }],
      ['private', { chain: 0 }],
      ['private', { chain: '1' }],
      ['private', { chain: 1.5 }],
      ['private', { chain: 1, parentPid: 0 }],
    ]) {
      expect(() => colibridArgs(kind, options)).toThrow(TypeError);
    }
  });

  test('each kind is spawned with its arguments, the binary passed in and the scrubbed environment', async () => {
    const kinds = [
      ['persistent', { dataDir: '/profile/colibri/100', lockDir: '/profile/locks' }],
      ['private', {}],
      ['checkpoint', {}],
    ];
    for (const [kind, dirs] of kinds) {
      const { client, fake } = colibrid({ kind, ...dirs });
      await client.start();
      expect(fake.spawned[0].command).toBe('/bin/freedom-colibrid');
      expect(fake.spawned[0].args).toEqual(
        colibridArgs(kind, { chain: 100, parentPid: 4242, ...dirs })
      );
      expect(Object.keys(fake.spawned[0].options.env)).not.toContain('FREEDOM_COLIBRI_BACKEND');
    }
  });

  test("hello: protocol 1, the shell's version and stream frames; a valid result's public part", async () => {
    const { client, children } = colibrid();
    await expect(client.start()).resolves.toEqual({
      protocol: 1,
      service_version: '0.1.1',
      colibri_version: '3.0.3',
      client_version: 196611,
      chain_id: 100,
      build: { op: false, zk: true, prover: false, verify_flags: 2 },
      network: 'offline',
      confinement: { ...CONFINEMENT, reasons: {} },
    });
    expect(children[0].sent('colibri.hello')[0].params).toEqual({
      protocol: 1,
      shell_version: '9.9.9',
      frames: ['stream'],
    });
  });

  test('hello refusals, field by field', () => {
    const good = helloFor(['--chain', '100']);
    const expected = { chain: 100, serviceVersion: '0.1.1' };
    expect(validHello(good, expected)).not.toBeNull();
    const broken = [
      ['no protocol', { protocol: undefined }],
      ['another protocol', { protocol: 2 }],
      ['no service_version (colibrid 0.1.0)', { service_version: undefined }],
      ['another release', { service_version: '0.1.0' }],
      ['a release that is no version', { service_version: '0.1.1 beta' }],
      ['a release as a number', { service_version: 11 }],
      ['another Colibri', { colibri_version: '3.0.4' }],
      ['no Colibri version', { colibri_version: undefined }],
      ['another client version', { client_version: 196612 }],
      ['the client version as text', { client_version: '196611' }],
      ['another chain', { chain_id: 1 }],
      ['the chain as text', { chain_id: '100' }],
      ['a network', { network: 'direct' }],
      ['no network', { network: undefined }],
      ['no build', { build: undefined }],
      ['a build with a prover', { build: { ...HELLO.build, prover: true } }],
      [
        'a build that says nothing of a prover',
        { build: { op: false, zk: true, verify_flags: 2 } },
      ],
      ['a build whose op is no flag', { build: { ...HELLO.build, op: 'no' } }],
      ['a build whose zk is no flag', { build: { ...HELLO.build, zk: 1 } }],
      ['a build without its verify flags', { build: { ...HELLO.build, verify_flags: undefined } }],
      ['no confinement', { confinement: undefined }],
      ['a confinement that is none', { confinement: { ...CONFINEMENT, files: 'maybe' } }],
    ];
    for (const [name, change] of broken) {
      const result = { ...good, ...change };
      for (const [key, value] of Object.entries(change))
        if (value === undefined) delete result[key];
      expect([name, validHello(result, expected)]).toEqual([name, null]);
    }
    expect(validHello(null, expected)).toBeNull();
    expect(validHello([good], expected)).toBeNull();
    // Null takes any release, still only a version's.
    expect(
      validHello({ ...good, service_version: '9.9.9-dev' }, { chain: 100, serviceVersion: null })
    ).not.toBeNull();
    expect(
      validHello({ ...good, service_version: '' }, { chain: 100, serviceVersion: null })
    ).toBeNull();
  });

  test('a hello for another chain is a fault: the process is ended, and nothing restarts it', async () => {
    const { client, children, log } = colibrid({
      script: { hello: (message, child) => child.result(message.id, { ...HELLO, chain_id: 1 }) },
    });
    await expect(client.start()).rejects.toMatchObject({ code: 'colibri_unavailable' });
    expect(log.error).toHaveBeenCalledWith('[colibrid] invalid colibri.hello result');
    expect(children[0].killedWith).toBe('SIGKILL');
    expect(client.state).toBe('stopped');
    expect(children).toHaveLength(1);
  });

  test('the release main expects is required: a string, or null for any', () => {
    expect(() => colibrid({ serviceVersion: undefined })).toThrow(TypeError);
    expect(() => colibrid({ serviceVersion: '' })).toThrow(TypeError);
    expect(() => colibrid({ serviceVersion: null })).not.toThrow();
  });

  test('restart: false: a crash leaves the client stopped, nothing respawned; start() spawns again', async () => {
    const { client, children, log } = colibrid();
    await client.start();
    const exited = exitOf(client);
    children[0].exit(70);
    await exited;
    await tick();
    expect(client.state).toBe('stopped');
    expect(children).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('[colibrid] exited', {
      code: 70,
      signal: null,
      cause: null,
    });
    await client.start();
    expect(children).toHaveLength(2);
  });

  test('after each spawn its priority is lowered: 10, below normal on Windows; a failure is logged and the process goes on', async () => {
    const { client } = colibrid();
    await client.start();
    expect(priority).toHaveBeenCalledWith(7000, 10);

    const windows = colibrid({ platform: 'win32' });
    await windows.client.start();
    expect(priority).toHaveBeenLastCalledWith(7000, os.constants.priority.PRIORITY_BELOW_NORMAL);

    priority.mockImplementation(() => {
      const err = new Error('EACCES: /proc/7000 secret');
      err.code = 'EACCES';
      throw err;
    });
    const refused = colibrid();
    await expect(refused.client.start()).resolves.toMatchObject({ chain_id: 100 });
    expect(refused.log.warn).toHaveBeenCalledWith('[colibrid] could not lower its priority', {
      code: 'EACCES',
    });
    expect(JSON.stringify(refused.log.warn.mock.calls)).not.toContain('secret');

    // On its own: the module and platform it is given.
    const osModule = {
      setPriority: jest.fn(),
      constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } },
    };
    lowerPriority({ pid: 12 }, { platform: 'darwin', osModule, log: refused.log });
    lowerPriority({ pid: 13 }, { platform: 'win32', osModule, log: refused.log });
    expect(osModule.setPriority.mock.calls).toEqual([
      [12, 10],
      [13, 10],
    ]);
  });
});

describe('requests', () => {
  test('colibri.request: the params main writes, the operation it opens, and the result as the service wrote it', async () => {
    const seen = [];
    const { client, requests } = await serving({
      handle: (message, child) => {
        seen.push(client.operations.get(message.id, { generation: client.current.number }));
        child.serve(message, { steps: 2, result: '0x10' });
      },
    });
    await expect(ask(client, {}, { deadlineMs: 5_000 })).resolves.toEqual({
      status: 'success',
      result: '0x10',
    });
    expect(requests[0].params).toEqual({
      client: 'c1',
      zk: false,
      method: 'eth_blockNumber',
      params: '[]',
      min_latest_block_ts: Math.floor(START / 1000) - 60,
      deadline_ms: 5_000,
    });
    expect(seen).toEqual([
      {
        kind: 'request',
        id: requests[0].id,
        chain: 100,
        method: 'eth_blockNumber',
        params: '[]',
        zk: false,
        prover: PROVER,
        deadlineAt: START + 5_000,
        taken: {},
        ended: true,
      },
    ]);
    // Closed with its reply, for the fetches of that process.
    expect(
      client.operations.get(requests[0].id, { generation: client.current.number })
    ).toBeUndefined();

    // The caller's params as JSON text, null and none as the host sends them.
    await ask(client, { method: 'eth_getBlockByNumber', params: ['latest', false], zk: true });
    await ask(client, { method: 'eth_getBlockByNumber', params: null });
    await ask(client, { params: undefined });
    expect(requests.slice(1).map((message) => [message.params.params, message.params.zk])).toEqual([
      ['["latest",false]', true],
      ['[]', false],
      ['[]', false],
    ]);
  });

  test("a request's deadline: 60 s by default, a whole number of milliseconds", async () => {
    const { client, requests } = await serving({
      handle: (message, child) => child.serve(message),
    });
    for (const deadlineMs of [undefined, 0, -5, Number.NaN, 'soon', 1.2]) {
      await ask(client, {}, { deadlineMs });
    }
    expect(requests.map((message) => message.params.deadline_ms)).toEqual([
      DEFAULT_DEADLINE_MS,
      DEFAULT_DEADLINE_MS,
      DEFAULT_DEADLINE_MS,
      DEFAULT_DEADLINE_MS,
      DEFAULT_DEADLINE_MS,
      2,
    ]);
  });

  test("a request whose fields aren't one's is refused before anything is written", async () => {
    const { client, requests } = await serving();
    for (const fields of [
      { client: 7 },
      { client: '' },
      { zk: 'no' },
      { method: '' },
      { prover: undefined },
      { params: { toJSON: () => undefined } },
      { params: 10n },
    ]) {
      await expect(ask(client, fields)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(client.checkpoint()).rejects.toBeInstanceOf(TypeError);
    await tick();
    expect(requests).toEqual([]);
  });

  test('colibri.checkpoint on the checkpoint process: its params, its operation and its result', async () => {
    const seen = [];
    const { client, children } = colibrid({
      kind: 'checkpoint',
      chain: 1,
      script: {
        checkpoint: (message, child) =>
          setImmediate(() => {
            seen.push(client.operations.get(message.id, { generation: client.current.number }));
            child.serve(message, { reply: { decoded: { slot: 1 }, result: true } });
          }),
      },
    });
    await client.start();
    await expect(client.checkpoint({}, { deadlineMs: 90_000 })).resolves.toEqual({
      decoded: { slot: 1 },
      result: true,
    });
    const [message] = children[0].sent('colibri.checkpoint');
    expect(message.params).toEqual({
      min_latest_block_ts: Math.floor(START / 1000) - 60,
      deadline_ms: 90_000,
    });
    expect(seen).toEqual([
      {
        kind: 'checkpoint',
        id: message.id,
        chain: 1,
        deadlineAt: START + 90_000,
        taken: {},
        ended: true,
      },
    ]);
    await client.checkpoint({ minLatestBlockTs: 1234 });
    expect(children[0].sent('colibri.checkpoint')[1].params.min_latest_block_ts).toBe(1234);
    await expect(client.checkpoint({ minLatestBlockTs: -1 })).rejects.toBeInstanceOf(TypeError);
    // The checkpoint process serves no colibri.request.
    await expect(ask(client)).rejects.toBeInstanceOf(TypeError);
  });

  test("colibri.checkpoint's hooks ride on its operation, for the executor: answerRoot and onRefused; a hook that isn't a function is refused before anything is written", async () => {
    const seen = [];
    const answerRoot = async () => `0x${'12'.repeat(32)}`;
    const onRefused = () => {};
    const { client, children } = colibrid({
      kind: 'checkpoint',
      chain: 1,
      script: {
        checkpoint: (message, child) =>
          setImmediate(() => {
            seen.push(client.operations.get(message.id, { generation: client.current.number }));
            child.serve(message, { reply: { status: 'error', stage: 'decode', error: 'x' } });
          }),
      },
    });
    await client.start();
    await expect(client.checkpoint({ answerRoot, onRefused })).resolves.toEqual({
      status: 'error',
      stage: 'decode',
      error: 'x',
    });
    expect(seen).toEqual([expect.objectContaining({ kind: 'checkpoint', answerRoot, onRefused })]);
    // Only the call's own params cross the pipe.
    expect(Object.keys(children[0].sent('colibri.checkpoint')[0].params).sort()).toEqual([
      'deadline_ms',
      'min_latest_block_ts',
    ]);
    await expect(client.checkpoint({ answerRoot: 'main' })).rejects.toBeInstanceOf(TypeError);
    await expect(client.checkpoint({ onRefused: 1 })).rejects.toBeInstanceOf(TypeError);
    expect(children[0].sent('colibri.checkpoint')).toHaveLength(1);
  });

  test('checkpointDone: a checkpoint process that answered is waited for, sent nothing, its exit no news; one that stays is stopped after the grace', async () => {
    const answering = (exit) => ({
      checkpoint: (message, child) =>
        setImmediate(() => {
          child.serve(message, { reply: { status: 'error', stage: 'decode', error: 'x' } });
          if (exit) setImmediate(() => child.exit(0));
        }),
    });
    const leaving = colibrid({ kind: 'checkpoint', chain: 1, script: answering(true) });
    await leaving.client.start();
    await leaving.client.checkpoint();
    await leaving.client.checkpointDone();
    expect(leaving.children[0].exited).toBe(true);
    expect(leaving.children[0].sent('colibri.shutdown')).toEqual([]);
    expect(leaving.children[0].stdinClosed).toBe(false);
    expect(leaving.log.warn).not.toHaveBeenCalled();

    const staying = colibrid({ kind: 'checkpoint', chain: 1, script: answering(false) });
    await staying.client.start();
    await staying.client.checkpoint();
    let gone = false;
    const done = staying.client.checkpointDone().then(() => (gone = true));
    await tick();
    expect(gone).toBe(false);
    expect(staying.children[0].sent('colibri.shutdown')).toEqual([]);
    staying.clock.advance(SHUTDOWN_GRACE_MS);
    await done;
    expect(staying.children[0].sent('colibri.shutdown')).toHaveLength(1);

    // Only the checkpoint process's.
    const { client } = colibrid();
    await expect(client.checkpointDone()).rejects.toBeInstanceOf(TypeError);
  });

  test('colibri.forget and colibri.stats', async () => {
    const { client, child } = await serving();
    await expect(client.forget('c1')).resolves.toEqual({});
    expect(child.sent('colibri.forget')[0].params).toEqual({ client: 'c1' });
    await expect(client.forget(1)).rejects.toBeInstanceOf(TypeError);
    await expect(client.stats()).resolves.toEqual(statsResult());
  });

  test('with no process serving, a request is never written: Colibri service unavailable', async () => {
    const { client } = colibrid();
    const err = await ask(client).catch((error) => error);
    expect(err).toBeInstanceOf(ColibriWorkerError);
    expect(err.message).toBe('Colibri service unavailable');
    expect(err.colibriBystander).toBeUndefined();
    await expect(client.stats()).rejects.toMatchObject({ code: 'colibri_unavailable' });
  });
});

describe('refusals', () => {
  test('the recycling refusal is told apart from every other busy', async () => {
    const replies = [
      (message, child) => child.error(message.id, 'busy', 'recycling', { recycling: true }),
      (message, child) => child.error(message.id, 'busy', 'the open requests are at their bound'),
      (message, child) => child.error(message.id, 'busy', 'recycling', { recycling: false }),
      // The text alone isn't the flag.
      (message, child) => child.error(message.id, 'busy', 'recycling'),
    ];
    const { client, requests } = await serving({
      handle: (message, child) => replies[requests.length - 1](message, child),
    });
    const errors = [];
    for (let i = 0; i < replies.length; i++) errors.push(await ask(client).catch((error) => error));
    expect(errors.map((err) => [err.name, err.message, err.colibriRecycling ?? false])).toEqual([
      ['ColibriWorkerError', 'Colibri service busy', true],
      ['ColibriWorkerError', 'Colibri service busy', false],
      ['ColibriWorkerError', 'Colibri service busy', false],
      ['ColibriWorkerError', 'Colibri service busy', false],
    ]);
    for (const err of errors) {
      expect(err).toBeInstanceOf(ColibriWorkerError);
      expect(err.colibriBystander).toBeUndefined();
      expect(isColibriFault(err)).toBe(false);
    }
    expect(
      client.operations.get(requests[0].id, { generation: client.current.number })
    ).toBeUndefined();
  });

  test('every other refusal is one fixed text, and no fault, retry or capacity failure', async () => {
    const codes = ['invalid_argument', 'too_large', 'cancelled', 'unknown_method', 'internal'];
    const { client, requests } = await serving({
      handle: (message, child) => {
        const code = codes[requests.length - 1];
        // `cancelled` here is one main never asked for.
        if (code === 'cancelled') child.step(message.id);
        if (code === 'cancelled') child.stepped(message.id);
        child.error(message.id, code, `a text of the service's: fetch failed, ${code}`);
      },
    });
    for (const _code of codes) {
      const err = await ask(client).catch((error) => error);
      expect(err).toBeInstanceOf(ColibriWorkerError);
      expect(err.message).toBe(COLIBRID_TEXTS.refused);
    }
    for (const text of Object.values(COLIBRID_TEXTS)) {
      const err = new ColibriWorkerError(text);
      expect([text, isColibriFault(err), RETRYABLE.test(text), isCapacityFailure(err)]).toEqual([
        text,
        text === COLIBRID_TEXTS.replaced,
        false,
        false,
      ]);
    }
  });
});

describe('deadlines', () => {
  test('at its deadline main cancels the request, and it settles only on the reply', async () => {
    const cancels = [];
    const { client, child, clock, requests } = await serving({
      handle: (message, c) => {
        // Waiting on its fetches, between steps.
        c.step(message.id);
        c.stepped(message.id);
      },
      script: { cancel: (message) => cancels.push(message.id) },
    });
    const request = outcomeOf(ask(client, {}, { deadlineMs: 1_000 }));
    await until(() => child.events.length === 2, 'its step');
    const [{ id }] = requests;
    clock.advance(999);
    await tick();
    expect(child.cancels).toEqual([]);
    clock.advance(1);
    await until(() => cancels.length === 1, 'the cancel');
    expect(cancels).toEqual([id]);
    // No step is open: nothing is killed past the 2 s either.
    clock.advance(OVERRUN_MS);
    await tick();
    await tick();
    expect(request.settled).toBe(false);
    expect(child.killedWith).toBeUndefined();

    child.step(id);
    child.stepped(id);
    child.error(id, 'cancelled', 'cancelled');
    await request.done;
    expect(request.error).toBeInstanceOf(ColibriWorkerError);
    expect(request.error.message).toBe('Colibri request cancelled at its deadline');
    expect(request.error.colibriBystander).toBeUndefined();
    expect(isColibriFault(request.error)).toBe(false);
    expect(child.exited).toBe(false);
  });

  test('an answer that crosses the cancel is the outcome', async () => {
    const { client, child, clock, requests } = await serving({
      handle: (message, c) => c.step(message.id),
      script: { cancel: () => {} },
    });
    const request = outcomeOf(ask(client, {}, { deadlineMs: 1_000 }));
    await until(() => child.events.length === 1, 'its step');
    clock.advance(1_000);
    await until(() => child.cancels.length === 1, 'the cancel');
    child.stepped(requests[0].id);
    child.result(requests[0].id, { status: 'success', result: '0x1' });
    await request.done;
    expect(request.result).toEqual({ status: 'success', result: '0x1' });
  });

  test("a step still open 2 s past its request's deadline: the process is killed, that request named, the others bystanders", async () => {
    const { client, child, clock, requests, log } = await serving({
      handle: (message, c) => {
        // The first is stuck in its step.
        if (message.id === requests[0].id) c.step(message.id);
      },
      script: { cancel: () => {} },
    });
    const stuck = outcomeOf(ask(client, {}, { deadlineMs: 1_000 }));
    const other = outcomeOf(ask(client, {}, { deadlineMs: 30_000 }));
    await until(() => client.markers?.openStep === requests[0]?.id, 'the step');
    clock.advance(1_000);
    await until(() => child.cancels.length === 1, 'the cancel');
    clock.advance(OVERRUN_MS - 1);
    await tick();
    expect(child.killedWith).toBeUndefined();
    const exited = exitOf(client);
    clock.advance(1);
    expect(child.killedWith).toBe('SIGKILL');
    await exited;
    await Promise.all([stuck.done, other.done]);

    expect(stuck.error).toBeInstanceOf(ColibriWorkerError);
    expect(stuck.error.message).toBe(
      'Colibri worker replaced: verification still running after its deadline'
    );
    expect(stuck.error.colibriBystander).toBeUndefined();
    expect(isColibriFault(stuck.error)).toBe(true);
    expect(other.error.message).toBe(stuck.error.message);
    expect(other.error.colibriBystander).toBe(true);
    expect(isColibriFault(other.error)).toBe(false);
    expect(client.lastDeath).toMatchObject({ cause: 'overrun', culprit: requests[0].id });
    expect(log.warn).toHaveBeenCalledWith('[colibrid] abandoned', { cause: 'overrun' });
  });

  test('no reply 15 s past the deadline: the service is hung, killed, and nobody named', async () => {
    const { client, child, clock } = await serving({
      handle: (message, c) => {
        c.step(message.id);
        c.stepped(message.id);
      },
      script: { cancel: () => {} },
    });
    const request = outcomeOf(ask(client, {}, { deadlineMs: 1_000 }));
    await until(() => child.events.length === 2, 'its step');
    clock.advance(1_000 + HANG_GRACE_MS - 1);
    await tick();
    expect(child.killedWith).toBeUndefined();
    clock.advance(1);
    await request.done;
    expect(child.killedWith).toBe('SIGKILL');
    expect(request.error.message).toBe('Colibri worker replaced: request hung');
    expect(request.error.colibriBystander).toBe(true);
    expect(client.lastDeath).toMatchObject({ cause: 'hang', culprit: null });
  });
});

describe('deaths', () => {
  /** Two requests open on a served client; `first(message, child)` answers
   * the first, the second waits. */
  async function twoOpen(first, options = {}) {
    const made = await serving({
      ...options,
      handle: (message, child) => {
        if (message.id === made.requests[0].id) first(message, child);
      },
    });
    const a = outcomeOf(ask(made.client));
    const b = outcomeOf(ask(made.client));
    await until(() => made.requests.length === 2, 'both requests');
    return { ...made, a, b, ids: made.requests.map((message) => message.id) };
  }

  test('a death inside a step names its request; every other open request is a bystander', async () => {
    const { client, child, a, b, ids } = await twoOpen((message, c) => c.step(message.id));
    await until(() => client.markers?.openStep === ids[0], 'the step');
    child.exit(null, 'SIGSEGV');
    await Promise.all([a.done, b.done]);
    expect(a.error).toBeInstanceOf(ColibriWorkerError);
    expect(a.error.message).toBe('Colibri worker replaced: service exited (SIGSEGV)');
    expect(a.error.colibriBystander).toBeUndefined();
    expect(isColibriFault(a.error)).toBe(true);
    expect(b.error.message).toBe('Colibri worker replaced: service exited (SIGSEGV)');
    expect(b.error.colibriBystander).toBe(true);
    expect(isColibriFault(b.error)).toBe(false);
    expect(client.lastDeath).toEqual({
      generation: 1,
      code: null,
      signal: 'SIGSEGV',
      cause: null,
      culprit: ids[0],
      reason: 'service exited (SIGSEGV)',
    });
    expect(client.state).toBe('stopped');
  });

  test('a death after the step was cleared names nobody', async () => {
    const { client, child, a, b } = await twoOpen((message, c) => {
      c.step(message.id);
      c.stepped(message.id);
    });
    await until(() => child.events.length === 2, 'the step and its clearing');
    expect(client.markers.openStep).toBeNull();
    child.exit(70);
    await Promise.all([a.done, b.done]);
    for (const outcome of [a, b]) {
      expect(outcome.error.message).toBe('Colibri worker replaced: service exited (70)');
      expect(outcome.error.colibriBystander).toBe(true);
    }
    expect(client.lastDeath).toMatchObject({ code: 70, culprit: null });
  });

  test('a marker still in the pipe at the exit is read before the death is judged, and names its request', async () => {
    const { client, child, a, b, ids } = await twoOpen(() => {});
    child.holdOutput();
    child.step(ids[0]);
    child.exit(null, 'SIGSEGV');
    expect(client.markers.openStep).toBeNull();
    await Promise.all([a.done, b.done]);
    expect(a.error.colibriBystander).toBeUndefined();
    expect(isColibriFault(a.error)).toBe(true);
    expect(b.error.colibriBystander).toBe(true);
    expect(client.lastDeath.culprit).toBe(ids[0]);
  });

  test('a reply still in the pipe at the exit is its request’s outcome; the step after it names the other', async () => {
    const { client, child, a, b, ids } = await twoOpen(() => {});
    child.holdOutput();
    child.serve({ id: ids[0] }, { result: '0x2' });
    child.step(ids[1]);
    child.exit(null, 'SIGABRT');
    await Promise.all([a.done, b.done]);
    expect(a.result).toEqual({ status: 'success', result: '0x2' });
    expect(b.error.message).toBe('Colibri worker replaced: service exited (SIGABRT)');
    expect(b.error.colibriBystander).toBeUndefined();
    expect(client.lastDeath.culprit).toBe(ids[1]);
  });

  test('a death with nothing open names nobody; one before the handshake too', async () => {
    const { client, child } = await serving();
    const exited = exitOf(client);
    child.exit(1);
    await exited;
    expect(client.lastDeath).toMatchObject({ generation: 1, code: 1, culprit: null });
    expect(client.markers).toBeNull();

    const early = colibrid({ script: { hello: (message, c) => setImmediate(() => c.exit(70)) } });
    await expect(early.client.start()).rejects.toMatchObject({ code: 'colibri_unavailable' });
    expect(early.client.lastDeath).toEqual({
      generation: null,
      code: 70,
      signal: null,
      cause: null,
      culprit: null,
      reason: 'service exited (70)',
    });
  });

  test('main stopping the process names nobody: what was open is a bystander', async () => {
    const { client, a, b } = await twoOpen((message, c) => c.step(message.id));
    await until(() => client.markers?.openStep !== null, 'the step');
    await client.stop();
    await Promise.all([a.done, b.done]);
    for (const outcome of [a, b]) {
      expect(outcome.error.message).toBe('Colibri worker replaced: service stopped');
      expect(outcome.error.colibriBystander).toBe(true);
    }
    expect(client.lastDeath).toMatchObject({ cause: 'shutdown', culprit: null });
  });
});

describe('forged markers', () => {
  test.each([
    ['a step for an unknown request', (child) => child.event('colibri.step', { request: 99 })],
    [
      'a step for an ended request',
      (child, ids, answered) => {
        child.step(answered);
      },
    ],
    [
      'a second step while one is open',
      (child, ids) => {
        child.step(ids[0]);
        child.step(ids[1]);
      },
    ],
    [
      'a stepped for another request than the open step',
      (child, ids) => {
        child.step(ids[0]);
        child.stepped(ids[1]);
      },
    ],
  ])('%s kills the process and names nobody', async (_name, forge) => {
    const { client, child, requests, log } = await serving({
      handle: (message, c) => {
        if (message.id === requests[0].id) c.serve(message, { result: '0x1' });
      },
    });
    await expect(ask(client)).resolves.toEqual({ status: 'success', result: '0x1' });
    const answered = requests[0].id;
    const open = [outcomeOf(ask(client)), outcomeOf(ask(client))];
    await until(() => requests.length === 3, 'the requests');
    const ids = requests.slice(1).map((message) => message.id);
    const exited = exitOf(client);
    forge(child, ids, answered);
    // What it writes until it dies is ignored: no second abandon.
    child.step(ids[0]);
    child.event('colibri.step', { request: 1234 });
    await exited;
    await Promise.all(open.map((outcome) => outcome.done));

    expect(child.killedWith).toBe('SIGKILL');
    for (const outcome of open) {
      expect(outcome.error).toBeInstanceOf(ColibriWorkerError);
      expect(outcome.error.message).toBe('Colibri worker replaced: step marker out of order');
      expect(outcome.error.colibriBystander).toBe(true);
      expect(isColibriFault(outcome.error)).toBe(false);
    }
    expect(client.lastDeath).toMatchObject({ cause: 'marker', culprit: null });
    expect(log.warn.mock.calls.filter(([message]) => message === '[colibrid] abandoned')).toEqual([
      ['[colibrid] abandoned', { cause: 'marker' }],
    ]);
    expect(
      log.warn.mock.calls.filter(([message]) => message === '[colibrid] step marker refused')
    ).toHaveLength(1);
  });
});

describe('fetches', () => {
  test('a fetch for an open request reaches the executor with its operation; one for an unknown or ended request is refused', async () => {
    const dialled = [];
    const hop = makeHop({
      fetch: async (url, init) => {
        dialled.push({ url, method: init.method, body: init.body });
        return new Response(Buffer.from('proof'), { status: 200 });
      },
    });
    let op = null;
    const fetches = [];
    const { client, child, requests, log } = await serving({
      chain: LONE,
      hop,
      handle: (message, c) => {
        c.step(message.id);
        c.stepped(message.id);
        op = client.operations.get(message.id, { generation: client.current.number });
        const fetch = c.fetch(message.id, {
          type: 'prover',
          method: 'post',
          path: '',
          payload: { method: 'eth_blockNumber', params: [], version: 196611 },
          accept: 'ssz',
        });
        fetches.push(fetch);
        fetch.done.then((outcome) => {
          c.step(message.id);
          c.stepped(message.id);
          c.result(message.id, { status: 'success', result: outcome.bytes.toString() });
        });
      },
    });
    await expect(ask(client, {}, { deadlineMs: 10_000 })).resolves.toEqual({
      status: 'success',
      result: 'proof',
    });
    await expect(fetches[0].done).resolves.toEqual({ bytes: Buffer.from('proof'), node: 0 });
    expect(dialled).toEqual([
      {
        url: PROVER,
        method: 'POST',
        body: JSON.stringify({ method: 'eth_blockNumber', params: [], version: 196611 }),
      },
    ]);
    expect(op).toMatchObject({
      kind: 'request',
      id: requests[0].id,
      chain: LONE,
      method: 'eth_blockNumber',
      params: '[]',
      prover: PROVER,
      taken: { block: 1 },
      ended: true,
    });

    // The request has its reply: its fetches are refused, as one naming no
    // request of this process is, and nothing is dialled.
    const late = child.fetch(requests[0].id, {
      type: 'prover',
      method: 'post',
      path: '',
      accept: 'ssz',
    });
    const unknown = child.fetch(99, { type: 'prover', method: 'post', path: '', accept: 'ssz' });
    await expect(late.done).resolves.toEqual({ error: 'Colibri fetch refused' });
    await expect(unknown.done).resolves.toEqual({ error: 'Colibri fetch refused' });
    expect(dialled).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('[Colibri] fetch refused', {
      chain: null,
      type: 'prover',
      rule: 'request',
    });
    expect(child.exited).toBe(false);
  });
});
