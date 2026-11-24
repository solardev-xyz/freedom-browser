/**
 * Colibri's native backend (`colibri-service.js`, freedom-core design 0014,
 * COL-5) against fake freedom-colibrid children
 * (`test/helpers/fake-colibrid.js`), its clock and timers run by hand, its
 * chain directories in a temporary `<userData>/colibri`:
 * - requests: the process each goes to, the reply as the adapter's outcome,
 *   a reply that is none, and `destroy`;
 * - the browser-wide bounds: the 7-chain walk in sequence and in parallel
 *   (never more than 3 live processes or 6 chain directories; busy at once
 *   with none idle; open requests complete with their slots held), private
 *   processes counted, idle retirement;
 * - private sessions: nothing under userData, the processes end with the
 *   session, an ended session spawns nothing;
 * - restarts: the back-off, the no-culprit stop, the directory clear, the
 *   exits that stop a lane, a recycle (no fault; exit 75 after it), a
 *   bystander resent once, the culprit never, a refused grant;
 * - the quit.
 *
 * One process's own rules (markers, deadlines, refusals) are in
 * colibrid-client.test.js; the switch in colibri-resolver.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
jest.mock('../logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: (...args) => mockLogWarn(...args),
  error: (...args) => mockLogError(...args),
}));

const service = require('./colibri-service');
const { isColibriFault } = require('../core/chain-verified');
const { fakeColibrid, helloFor } = require('../../../test/helpers/fake-colibrid');

const { ColibriWorkerError, SERVICE_TEXTS } = service;
/** Design 0014's idle retirement. */
const IDLE_MS = 10 * 60_000;
const START = 1_700_000_000_000;
const PROVER = 'https://prover.example/';
const BUSY = 'Colibri service busy';
const UNAVAILABLE = 'Colibri service unavailable';
/** Seven chains: the package's, and one outside its lists (prover only). */
const CHAINS = [1, 100, 10, 137, 8453, 42161, 7777];

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(predicate, what, rounds = 2000) {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await tick();
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
    const end = clock.now + ms;
    for (;;) {
      const due = clock.timers
        .filter((t) => !t.cleared && !t.fired && t.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = due.at;
      due.fired = true;
      due.fn();
    }
    clock.now = end;
  };
  return clock;
}

let tmp;
let root;
let clock;
let fake;
let alive;
let grants;
let grantRefusal;

beforeEach(() => {
  // Never a real process's: the fake children's PIDs may be anyone's.
  jest.spyOn(os, 'setPriority').mockImplementation(() => {});
  mockLogWarn.mockReset();
  mockLogError.mockReset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-service-'));
  root = path.join(tmp, 'colibri');
});

afterEach(async () => {
  await service.resetForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

/** Serves each request once main's write of it has returned, as a real
 * pipe delivers it: one step, then `result`. */
const serveLater =
  (result = '0x10') =>
  (message, child) =>
    setImmediate(() => child.serve(message, { result }));

/** Keeps each request open in `held` until the test answers it. */
function holding() {
  const held = [];
  return { held, request: (message, child) => held.push({ message, child }) };
}

const answer = ({ message, child }, result = '0x10') => child.serve(message, { result });

/** Takes `child`'s entry out of `held`. */
function take(held, child) {
  const at = held.findIndex((entry) => entry.child === child);
  return held.splice(at, 1)[0];
}

/**
 * A fresh service over fake children: `request(message, child)` answers
 * each `colibri.request`, the rest of `script` the other methods. Records
 * how many children were alive at each spawn, the new one included.
 */
async function world({ request = serveLater(), ...script } = {}) {
  clock = manualClock();
  fake = fakeColibrid({ request: (message, child) => request(message, child), ...script });
  alive = [];
  grants = [];
  grantRefusal = null;
  const spawn = (command, args, options) => {
    alive.push(fake.children.filter((child) => !child.exited).length + 1);
    return fake.spawn(command, args, options);
  };
  await service.resetForTest({
    storageDir: root,
    spawn,
    command: '/bin/freedom-colibrid',
    lockDir: '/profile/locks',
    serviceVersion: '0.1.1',
    parentPid: 4242,
    shellVersion: '9.9.9',
    checkGrant: (dir, chain) => {
      grants.push([dir, chain]);
      return grantRefusal;
    },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

function client(chainId, extra = {}) {
  return service.createClient({ chainId, proverUrl: PROVER, zkProof: true, ...extra });
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

const ask = (c, method = 'eth_blockNumber', params = [], options = {}) =>
  outcomeOf(c.request({ method, params }, options));

/** The chain directories under the storage root. */
function chainDirs() {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a) - Number(b));
}

const liveChildren = () => fake.children.filter((child) => !child.exited);
const childOf = (chain, nth = 0) => fake.children.filter((child) => child.chain === chain)[nth];
const warned = (text) => mockLogWarn.mock.calls.some(([line]) => String(line).includes(text));

describe('requests', () => {
  test("a request goes to its chain's process as colibri.request; its reply is the adapter's outcome", async () => {
    await world();
    const c = client(1);
    await expect(c.request({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
    expect(fake.spawned[0]).toMatchObject({
      command: '/bin/freedom-colibrid',
      args: [
        'serve',
        '--chain',
        '1',
        '--data-dir',
        path.join(root, '1'),
        '--lock-dir',
        '/profile/locks',
        '--parent-pid',
        '4242',
      ],
    });
    const [sent] = fake.children[0].sent('colibri.request');
    expect(sent.params).toEqual({
      client: expect.any(String),
      zk: true,
      method: 'eth_blockNumber',
      params: '[]',
      min_latest_block_ts: Math.floor(START / 1000) - 60,
      deadline_ms: 60_000,
    });
    // Main's check of the grant before the spawn, and the directory made
    // with the spawn's time.
    expect(grants).toEqual([[path.join(root, '1'), 1]]);
    expect(fs.statSync(path.join(root, '1')).mtimeMs).toBe(START);
    // The deadline passed is what the caller gave.
    await c.request({ method: 'eth_chainId', params: null }, { deadlineMs: 5_000 });
    expect(fake.children[0].sent('colibri.request')[1].params).toMatchObject({
      method: 'eth_chainId',
      params: '[]',
      deadline_ms: 5_000,
    });
    expect(fake.children).toHaveLength(1);
  });

  test("an error reply is createError's, cut to 2,000 units; a revert is the adapter's", async () => {
    const replies = [
      { status: 'error', error: 'HTTP error! Status: 503, Details: down' },
      { status: 'error', error: 'x'.repeat(3000) },
      { status: 'revert', data: '0xdeadbeef' },
    ];
    await world({
      request: (message, child) =>
        setImmediate(() => child.serve(message, { reply: replies.shift() })),
    });
    const c = client(1);
    await expect(
      c.request({ method: 'eth_getBalance', params: ['0xabc', 'latest'] })
    ).rejects.toMatchObject({
      name: 'ProviderRpcError',
      code: 4900,
      message:
        'Error in rpc call eth_getBalance["0xabc","latest"] : HTTP error! Status: 503, Details: down',
    });
    const long = await c.request({ method: 'eth_blockNumber' }).catch((err) => err);
    expect(long.code).toBe(-32603);
    expect(long.message).toHaveLength(2000);
    expect(long.message.startsWith('Error in rpc call eth_blockNumber[] : xxx')).toBe(true);
    await expect(c.request({ method: 'eth_call', params: [{}] })).rejects.toMatchObject({
      name: 'ProviderRpcError',
      code: 3,
      message: 'execution reverted',
      data: '0xdeadbeef',
    });
  });

  test('a reply that is none of the service’s ends the process, naming nobody; its request is resent once', async () => {
    await world({
      request: (message, child) =>
        setImmediate(() => child.serve(message, { reply: { status: 'maybe' } })),
    });
    const outcome = ask(client(1));
    await until(() => fake.children[0].exited, 'the kill');
    expect(fake.children[0].killedWith).toBe('SIGKILL');
    // A bystander of the death: it waits out the back-off for the next
    // process, whose reply is no better, and is not sent a third time.
    await flush();
    expect(outcome.settled).toBe(false);
    clock.advance(500);
    await outcome.done;
    expect(outcome.error).toBeInstanceOf(ColibriWorkerError);
    expect(outcome.error.message).toBe(SERVICE_TEXTS.protocol);
    expect(outcome.error.colibriBystander).toBe(true);
    expect(isColibriFault(outcome.error)).toBe(false);
    expect(fake.children).toHaveLength(2);
    expect(fake.children[1].killedWith).toBe('SIGKILL');
    expect(fake.children.map((child) => child.sent('colibri.request').length)).toEqual([1, 1]);
  });

  test('a protocol error’s request and the other open one go once to the next process, never to the dying one', async () => {
    const held = [];
    await world({
      request: (message, child) => {
        if (child === fake.children[0]) held.push({ message, child });
        else serveLater('0x20')(message, child);
      },
    });
    const c = client(1);
    const garbled = ask(c, 'eth_blockNumber');
    const other = ask(c, 'eth_chainId');
    await until(() => held.length === 2, 'both open');
    const [first] = fake.children;
    first.serve(held[0].message, { reply: { status: 'maybe' } });
    await until(() => first.exited, 'the kill');
    expect(first.killedWith).toBe('SIGKILL');
    // Both wait out the back-off the death started, then go to its
    // successor.
    await flush();
    expect(garbled.settled).toBe(false);
    expect(other.settled).toBe(false);
    clock.advance(500);
    await Promise.all([garbled.done, other.done]);
    expect(garbled.result).toBe('0x20');
    expect(other.result).toBe('0x20');
    expect(fake.children).toHaveLength(2);
    expect(first.sent('colibri.request')).toHaveLength(2);
    expect(
      fake.children[1]
        .sent('colibri.request')
        .map((m) => m.params.method)
        .sort()
    ).toEqual(['eth_blockNumber', 'eth_chainId']);
  });

  test('destroy sends colibri.forget to each process the client used, once', async () => {
    await world();
    const normal = client(1);
    const priv = client(1, { private: true });
    await normal.request({ method: 'eth_blockNumber' });
    await priv.request({ method: 'eth_blockNumber' });
    const [first, second] = fake.children;
    const [{ params }] = first.sent('colibri.request');
    normal.destroy();
    normal.destroy();
    await flush();
    expect(first.sent('colibri.forget').map((m) => m.params)).toEqual([{ client: params.client }]);
    expect(second.sent('colibri.forget')).toHaveLength(0);
    await expect(normal.request({ method: 'eth_blockNumber' })).rejects.toThrow(
      'Colibri client was destroyed'
    );
  });
});

describe('the browser-wide bounds (design 0014, How many)', () => {
  test('the 7-chain walk in sequence: never more than 3 live or 6 directories; the WASM files stay', async () => {
    await world();
    // The WASM path's flat files and a directory that names no chain.
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'states_1'), 'wasm');
    fs.writeFileSync(path.join(root, 'sync_1_1234'), 'wasm');
    for (const chain of CHAINS) {
      clock.advance(1_000);
      await expect(client(chain).request({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
      expect(liveChildren().length).toBeLessThanOrEqual(3);
      expect(chainDirs().length).toBeLessThanOrEqual(6);
    }
    expect(Math.max(...alive)).toBe(3);
    expect(fake.children.map((child) => child.chain)).toEqual(CHAINS);
    // The first four were retired, least recently used first, for the
    // last four; each exited 0, which is no crash.
    for (const chain of [1, 100, 10, 137]) {
      expect(childOf(chain).exitCode).toBe(0);
      expect(childOf(chain).sent('colibri.shutdown')).toHaveLength(1);
      expect(warned(`chain ${chain} service retired (browser-wide limit)`)).toBe(true);
    }
    expect(mockLogWarn.mock.calls.some(([line]) => /crashed|killed/.test(line))).toBe(false);
    // Before the seventh directory, the oldest without a process went.
    expect(chainDirs()).toEqual(
      ['10', '100', '137', '7777', '8453', '42161'].sort((a, b) => a - b)
    );
    expect(warned('chain 1 store removed: at most 6 are kept')).toBe(true);
    expect(fs.readFileSync(path.join(root, 'states_1'), 'utf8')).toBe('wasm');
    expect(fs.existsSync(path.join(root, 'sync_1_1234'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'tmp'))).toBe(true);
    // A chain whose directory exists spawns into it without removing any.
    clock.advance(1_000);
    await client(10).request({ method: 'eth_blockNumber' });
    expect(chainDirs()).toHaveLength(6);
    expect(Math.max(...alive)).toBe(3);
  });

  test('the 7-chain walk in parallel: busy at once with none idle, open requests complete with their slots held', async () => {
    const { held, request } = holding();
    await world({ request });
    const wave1 = CHAINS.map((chain) => ask(client(chain)));
    await until(() => held.length === 3, 'three requests on three processes');
    // The other four failed at once, while the three were still open:
    // nothing spawned for them, and nothing counts them as a fault.
    await Promise.all(wave1.slice(3).map((o) => o.done));
    for (const outcome of wave1.slice(3)) {
      expect(outcome.error).toBeInstanceOf(ColibriWorkerError);
      expect(outcome.error.message).toBe(BUSY);
      expect(isColibriFault(outcome.error)).toBe(false);
    }
    expect(wave1.slice(0, 3).every((o) => !o.settled)).toBe(true);
    expect(fake.children).toHaveLength(3);
    // The open ones complete on their processes.
    held.splice(0).forEach((entry) => answer(entry, '0x1'));
    await Promise.all(wave1.slice(0, 3).map((o) => o.done));
    expect(wave1.slice(0, 3).map((o) => o.result)).toEqual(['0x1', '0x1', '0x1']);

    // The next four: three idle processes are retired for three of them,
    // and the fourth has none left.
    clock.advance(1_000);
    const wave2 = CHAINS.slice(3).map((chain) => ask(client(chain)));
    await wave2[3].done;
    expect(wave2[3].error.message).toBe(BUSY);
    await until(() => held.length === 3, 'three requests on the three new processes');
    expect(held.map(({ child }) => child.chain).sort((a, b) => a - b)).toEqual([137, 8453, 42161]);
    expect(CHAINS.slice(0, 3).map((chain) => childOf(chain).exitCode)).toEqual([0, 0, 0]);
    held.splice(0).forEach((entry) => answer(entry));
    await Promise.all(wave2.slice(0, 3).map((o) => o.done));
    expect(wave2.slice(0, 3).map((o) => o.result)).toEqual(['0x10', '0x10', '0x10']);

    // The last chain gets its place, and its directory the oldest one's.
    clock.advance(1_000);
    const last = ask(client(7777));
    await until(() => held.length === 1, 'the seventh chain');
    answer(held.pop());
    await last.done;
    expect(last.result).toBe('0x10');
    expect(Math.max(...alive)).toBe(3);
    expect(chainDirs()).toHaveLength(6);
    expect(chainDirs()).not.toContain('1');
  });

  test('private processes count toward the 3 and make no directory', async () => {
    const { held, request } = holding();
    await world({ request });
    const opened = [ask(client(1)), ask(client(1, { private: true })), ask(client(100))];
    await until(() => held.length === 3, 'three open requests');
    const busy = ask(client(10));
    await busy.done;
    expect(busy.error.message).toBe(BUSY);
    const privateChild = fake.children[1];
    expect(fake.spawned[1].args).toEqual(['serve', '--chain', '1', '--parent-pid', '4242']);
    expect(chainDirs()).toEqual(['1', '100']);
    expect(grants.map(([, chain]) => chain)).toEqual([1, 100]);
    // The private process answers first, so it is the least recently used
    // one, and is retired for the next chain like any other.
    answer(take(held, privateChild));
    await opened[1].done;
    clock.advance(1_000);
    held.splice(0).forEach((entry) => answer(entry));
    await Promise.all(opened.map((o) => o.done));
    const tenth = ask(client(10));
    await until(() => held.length === 1, 'the tenth chain');
    expect(privateChild.exitCode).toBe(0);
    expect(held[0].child.chain).toBe(10);
    answer(held.pop());
    await tenth.done;
    expect(tenth.result).toBe('0x10');
    expect(chainDirs()).toEqual(['1', '10', '100']);
  });

  test('idle for 10 minutes: colibri.shutdown, exit 0, no fault, no bystander, no back-off', async () => {
    await world();
    const c = client(1);
    await c.request({ method: 'eth_blockNumber' });
    const [child] = fake.children;
    clock.advance(IDLE_MS - 1);
    expect(child.sent('colibri.shutdown')).toHaveLength(0);
    clock.advance(1);
    expect(child.sent('colibri.shutdown')).toHaveLength(1);
    await until(() => child.exited, 'the exit');
    await flush();
    expect(child.exitCode).toBe(0);
    expect(warned('chain 1 service retired (idle for 10 minutes)')).toBe(true);
    expect(mockLogWarn.mock.calls.some(([line]) => /crashed|killed|stopped/.test(line))).toBe(
      false
    );
    // No back-off: the next request spawns at once.
    await expect(c.request({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
    expect(fake.children).toHaveLength(2);
  });

  test('a request keeps its process from idling out until it is answered', async () => {
    const { held, request } = holding();
    await world({ request });
    const outcome = ask(client(1), 'eth_blockNumber', [], { deadlineMs: 2 * IDLE_MS });
    await until(() => held.length === 1, 'the request');
    clock.advance(IDLE_MS);
    expect(fake.children[0].sent('colibri.shutdown')).toHaveLength(0);
    answer(held.pop());
    await outcome.done;
    clock.advance(IDLE_MS);
    expect(fake.children[0].sent('colibri.shutdown')).toHaveLength(1);
  });

  test('ensureWorker spawns under the bound: busy at once when none is idle', async () => {
    const { held, request } = holding();
    await world({ request });
    await service.ensureWorker(1);
    await service.ensureWorker(1, { private: true });
    await service.ensureWorker(100);
    expect(fake.children).toHaveLength(3);
    // All three idle: the least recently used is retired for a fourth.
    clock.advance(1_000);
    const opened = [ask(client(1, { private: true })), ask(client(100))];
    await until(() => held.length === 2, 'two open requests');
    await service.ensureWorker(10);
    expect(fake.children[0].exitCode).toBe(0);
    const tenth = ask(client(10));
    await until(() => held.length === 3, 'a third');
    await expect(service.ensureWorker(137)).rejects.toThrow(BUSY);
    held.splice(0).forEach((entry) => answer(entry));
    await Promise.all([...opened, tenth].map((o) => o.done));
  });
});

describe('private sessions', () => {
  test('private reads write nothing under userData', async () => {
    await world();
    const c = client(1, { private: true });
    await c.request({ method: 'eth_blockNumber' });
    await c.request({ method: 'eth_getBalance', params: ['0xabc', 'latest'] });
    await client(100, { private: true }).request({ method: 'eth_blockNumber' });
    expect(fs.existsSync(tmp) && fs.readdirSync(tmp)).toEqual([]);
    expect(grants).toEqual([]);
    for (const { args } of fake.spawned) {
      expect(args).not.toContain('--data-dir');
      expect(args).not.toContain('--lock-dir');
    }
  });

  test('the session’s processes end with it; what was open fails as a bystander, never resent', async () => {
    const { held, request } = holding();
    await world({ request });
    const priv = client(1, { private: true });
    const normal = client(1);
    const privateRead = ask(priv);
    const normalRead = ask(normal);
    await until(() => held.length === 2, 'both open');
    const [privateChild, normalChild] = [childOf(1, 0), childOf(1, 1)];
    expect(fake.spawned[0].args).not.toContain('--data-dir');

    service.endPrivateSession();
    expect(privateChild.sent('colibri.shutdown')).toHaveLength(1);
    // Its request settles only once the process has exited.
    expect(privateRead.settled).toBe(false);
    await privateRead.done;
    expect(privateChild.exited).toBe(true);
    expect(privateRead.error).toBeInstanceOf(ColibriWorkerError);
    expect(privateRead.error.message).toBe(SERVICE_TEXTS.sessionStopped);
    expect(privateRead.error.colibriBystander).toBe(true);
    expect(isColibriFault(privateRead.error)).toBe(false);
    expect(
      warned('chain 1 (private) service retired (private session ended); 1 request(s) open')
    ).toBe(true);
    // The normal lane is untouched.
    expect(normalChild.exited).toBe(false);
    const normalEntry = take(held, normalChild);
    held.splice(0);
    answer(normalEntry);
    await normalRead.done;
    expect(normalRead.result).toBe('0x10');

    // A client of the ended session is refused, and spawns nothing.
    const children = fake.children.length;
    await expect(priv.request({ method: 'eth_chainId' })).rejects.toMatchObject({
      message: 'Colibri private session ended',
      colibriBystander: true,
    });
    expect(fake.children).toHaveLength(children);

    // The next session's first read starts a new private process.
    const next = ask(client(1, { private: true }));
    await until(() => held.length === 1, 'the next session’s read');
    expect(held[0].child).not.toBe(privateChild);
    expect(fake.spawned.at(-1).args).not.toContain('--data-dir');
    answer(held.pop());
    await next.done;
    expect(next.result).toBe('0x10');
    expect(chainDirs()).toEqual(['1']);
  });

  test('a reply after the session’s end, before the exit, is never the outcome: a bystander once exited', async () => {
    const { held, request } = holding();
    await world({ request });
    const priv = client(1, { private: true });
    const privateRead = ask(priv);
    await until(() => held.length === 1, 'the open read');
    const [privateChild] = fake.children;
    // The process takes its time to exit after main's shutdown, and
    // answers meanwhile.
    privateChild.holdExit();
    service.endPrivateSession();
    expect(privateChild.sent('colibri.shutdown')).toHaveLength(1);
    answer(held.pop(), '0x1a7e');
    await flush();
    expect(privateChild.exited).toBe(false);
    expect(privateRead.settled).toBe(false);
    privateChild.exit(0);
    await privateRead.done;
    expect(privateRead.error).toBeInstanceOf(ColibriWorkerError);
    expect(privateRead.error.message).toBe(SERVICE_TEXTS.sessionStopped);
    expect(privateRead.error.colibriBystander).toBe(true);
    expect(isColibriFault(privateRead.error)).toBe(false);
    // Never sent again.
    expect(fake.children).toHaveLength(1);
    expect(privateChild.sent('colibri.request')).toHaveLength(1);
  });

  test('a private bystander waiting out the back-off when the session ends spawns nothing', async () => {
    const { held, request } = holding();
    await world({ request });
    const priv = client(1, { private: true });
    const culprit = ask(priv);
    const bystander = ask(priv);
    await until(() => held.length === 2, 'both open');
    fake.children[0].step(held[0].message.id);
    await tick();
    fake.children[0].exit(null, 'SIGSEGV');
    await culprit.done;
    await flush();
    expect(bystander.settled).toBe(false);
    service.endPrivateSession();
    clock.advance(500);
    await bystander.done;
    expect(bystander.error.message).toBe('Colibri private session ended');
    expect(bystander.error.colibriBystander).toBe(true);
    expect(fake.children).toHaveLength(1);
  });

  test('a private process waiting for its slot when the session ends is never spawned', async () => {
    const { held, request } = holding();
    await world({ request });
    const opened = [ask(client(1)), ask(client(100))];
    await until(() => held.length === 2, 'two open');
    await service.ensureWorker(10);
    // The idle one is retired for the private read, which waits for its
    // exit; the session ends meanwhile.
    clock.advance(1_000);
    const privateRead = ask(client(7777, { private: true }));
    await tick();
    service.endPrivateSession();
    await privateRead.done;
    expect(privateRead.error.message).toBe('Colibri private session ended');
    expect(privateRead.error.colibriBystander).toBe(true);
    await until(() => childOf(10).exited, 'the retired one');
    await flush();
    expect(fake.children.map((child) => child.chain)).toEqual([1, 100, 10]);
    held.splice(0).forEach((entry) => answer(entry));
    await Promise.all(opened.map((o) => o.done));
  });
});

/** A request handler that crashes inside a step of the request (naming
 * it), outside any step (`step: false`, naming nobody), or serves it. */
function crashing(plan) {
  return (message, child) =>
    setImmediate(() => {
      const next = plan.shift() ?? 'serve';
      if (next === 'serve') {
        child.serve(message, { result: '0x10' });
      } else if (next === 'step') {
        child.step(message.id);
        setImmediate(() => child.exit(null, 'SIGSEGV'));
      } else {
        child.exit(70);
      }
    });
}

describe('restarts (design 0014, Crashes)', () => {
  test('the back-off: 0.5 s, 2 s, then 10 s after abnormal exits, unavailable meanwhile; reset after 60 s', async () => {
    const plan = ['step', 'step', 'step', 'serve', 'step'];
    await world({ request: crashing(plan) });
    const c = client(1);
    const crash = async () => {
      const outcome = ask(c);
      await outcome.done;
      expect(outcome.error.message).toBe('Colibri worker replaced: service exited (SIGSEGV)');
      // The culprit of a death inside its step: a fault, never resent.
      expect(outcome.error.colibriBystander).toBeUndefined();
      expect(isColibriFault(outcome.error)).toBe(true);
      await flush();
    };
    const refusedFor = async (ms) => {
      const children = fake.children.length;
      clock.advance(ms - 1);
      await expect(c.request({ method: 'eth_blockNumber' })).rejects.toThrow(UNAVAILABLE);
      expect(fake.children).toHaveLength(children);
      clock.advance(1);
    };
    await crash();
    expect(
      warned(
        'chain 1 service crashed (service exited (SIGSEGV)); the request in its step is named; 1 request(s) open; next start after 500 ms'
      )
    ).toBe(true);
    await refusedFor(500);
    await crash();
    await refusedFor(2_000);
    await crash();
    await refusedFor(10_000);
    await expect(c.request({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
    // A minute without an abnormal exit starts the back-off over.
    clock.advance(60_000);
    await crash();
    await refusedFor(500);
    // Crashes that name a culprit never stop the lane. The fifth crash was
    // the fourth process's, still running after its reply.
    expect(warned('stopped')).toBe(false);
    expect(fake.children).toHaveLength(4);
  });

  test('three exits within 60 s naming no culprit stop the lane until its configuration changes', async () => {
    await world();
    const same = client(1);
    for (const wait of [0, 500, 2_000]) {
      clock.advance(wait);
      await service.ensureWorker(1);
      fake.children.at(-1).exit(70);
      await flush();
    }
    expect(warned('chain 1 stopped (three exits within a minute named no culprit)')).toBe(true);
    clock.advance(60_000);
    await expect(service.ensureWorker(1)).rejects.toThrow(UNAVAILABLE);
    // The same configuration keeps it stopped; another one lets it start.
    client(1);
    await expect(same.request({ method: 'eth_blockNumber' })).rejects.toThrow(UNAVAILABLE);
    expect(fake.children).toHaveLength(3);
    const changed = client(1, { proverUrl: 'https://other-prover.example/' });
    await expect(changed.request({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
    expect(fake.children).toHaveLength(4);
    // Another chain was never stopped.
    await expect(client(100).request({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
  });

  test('a bystander is resent once to the next process, with what is left of its deadline; never twice', async () => {
    const { held, request } = holding();
    await world({ request });
    const c = client(1);
    const culprit = ask(c, 'eth_getTransactionReceipt', ['0x01']);
    const bystander = ask(c, 'eth_blockNumber', [], { deadlineMs: 10_000 });
    await until(() => held.length === 2, 'both open');
    const [first] = fake.children;
    clock.advance(3_000);
    first.step(held[0].message.id);
    await tick();
    first.exit(null, 'SIGSEGV');
    held.splice(0);
    await culprit.done;
    expect(isColibriFault(culprit.error)).toBe(true);
    // The bystander waits out the back-off, then goes to the next process.
    await flush();
    expect(bystander.settled).toBe(false);
    clock.advance(500);
    await until(() => held.length === 1, 'the resend');
    const second = fake.children[1];
    expect(held[0].child).toBe(second);
    expect(held[0].message.params).toMatchObject({ method: 'eth_blockNumber', deadline_ms: 6_500 });
    // A second death outside any step fails it, marked a bystander.
    clock.advance(1_000);
    second.exit(70);
    held.splice(0);
    await bystander.done;
    expect(bystander.error.message).toBe('Colibri worker replaced: service exited (70)');
    expect(bystander.error.colibriBystander).toBe(true);
    expect(isColibriFault(bystander.error)).toBe(false);
    expect(fake.children).toHaveLength(2);
  });

  test('a bystander whose deadline the back-off would outlast fails at once', async () => {
    const { held, request } = holding();
    await world({ request });
    const c = client(1);
    const culprit = ask(c);
    const bystander = ask(c, 'eth_blockNumber', [], { deadlineMs: 1_000 });
    await until(() => held.length === 2, 'both open');
    clock.advance(800);
    fake.children[0].step(held[0].message.id);
    await tick();
    fake.children[0].exit(null, 'SIGSEGV');
    await Promise.all([culprit.done, bystander.done]);
    expect(bystander.error.message).toBe('Colibri worker replaced: service exited (SIGSEGV)');
    expect(bystander.error.colibriBystander).toBe(true);
    expect(fake.children).toHaveLength(1);
  });

  test('three abnormal exits in a row with no reply between clear the directory; a reply resets the count', async () => {
    const plan = ['step', 'step', 'serve', 'step', 'step', 'step'];
    await world({ request: crashing(plan) });
    const store = path.join(root, '1');
    const c = client(1);
    const next = async (wait) => {
      clock.advance(wait);
      await ask(c).done;
      await flush();
    };
    await next(0);
    fs.writeFileSync(path.join(store, 'states_1'), 'state');
    await next(500);
    // Two exits, then a reply: the count starts over.
    await next(2_000);
    expect(fs.existsSync(path.join(store, 'states_1'))).toBe(true);
    // A minute on (the back-off starts over too), the replying process and
    // two more exit without a reply between.
    await next(60_000);
    await next(500);
    expect(fs.existsSync(path.join(store, 'states_1'))).toBe(true);
    await next(2_000);
    expect(fs.existsSync(store)).toBe(false);
    expect(warned('chain 1 store cleared after 3 abnormal exits in a row')).toBe(true);
    // The next process starts with an empty directory.
    clock.advance(10_000);
    await expect(c.request({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
    expect(fs.readdirSync(store)).toEqual([]);
  });

  test('a due clear that fails spawns nothing and stops the lane, logging no path', async () => {
    await world({ request: crashing(['step', 'step', 'step']) });
    const store = path.join(root, '1');
    const rmSync = fs.rmSync;
    const removal = jest.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      if (target !== store) return rmSync(target, opts);
      throw Object.assign(new Error(`EACCES: permission denied, rmdir '${store}'`), {
        code: 'EACCES',
      });
    });
    const c = client(1);
    for (const wait of [0, 500, 2_000]) {
      clock.advance(wait);
      await ask(c).done;
      await flush();
    }
    // The clear after the third exit failed; the next spawn tries it again,
    // and refuses.
    expect(warned('chain 1 store could not be cleared')).toBe(true);
    clock.advance(10_000);
    await expect(c.request({ method: 'eth_blockNumber' })).rejects.toThrow(UNAVAILABLE);
    expect(fake.children).toHaveLength(3);
    expect(grants).toHaveLength(4);
    expect(warned('chain 1 stopped')).toBe(true);
    expect(fs.existsSync(store)).toBe(true);
    // Once the removal would work, the lane is still stopped.
    removal.mockRestore();
    clock.advance(60_000);
    await expect(c.request({ method: 'eth_blockNumber' })).rejects.toThrow(UNAVAILABLE);
    expect(fake.children).toHaveLength(3);
    const logged = JSON.stringify([...mockLogWarn.mock.calls, ...mockLogError.mock.calls]);
    expect(logged).not.toContain(tmp);
  });

  test.each([64, 74, 75, 77])('exit %i stops the lane', async (code) => {
    await world();
    await service.ensureWorker(1);
    fake.children[0].exit(code);
    await flush();
    expect(warned(`chain 1 stopped (exit ${code})`)).toBe(true);
    clock.advance(60_000);
    await expect(service.ensureWorker(1)).rejects.toThrow(UNAVAILABLE);
    expect(fake.children).toHaveLength(1);
  });

  test('a refused grant spawns nothing and stops the lane', async () => {
    await world();
    grantRefusal = "the grant lies inside this profile's identity directory";
    await expect(client(1).request({ method: 'eth_blockNumber' })).rejects.toThrow(UNAVAILABLE);
    expect(fake.spawned).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith('[colibri] chain 1 store directory refused', {
      reason: "the grant lies inside this profile's identity directory",
    });
    expect(fs.existsSync(path.join(root, '1'))).toBe(false);
    grantRefusal = null;
    await expect(service.ensureWorker(1)).rejects.toThrow(UNAVAILABLE);
    expect(grants).toHaveLength(1);
    // Private processes have no directory to check.
    await expect(client(1, { private: true }).request({ method: 'eth_blockNumber' })).resolves.toBe(
      '0x10'
    );
  });
});

describe('a recycle (design 0014, Crashes)', () => {
  const recycling = (message, child) =>
    setImmediate(() => child.error(message.id, 'busy', 'recycling', { recycling: true }));

  test('is no fault: the refused request goes to the successor, and the old process exits 0 with no back-off', async () => {
    let first = true;
    await world({
      request: (message, child) => {
        if (first) {
          first = false;
          recycling(message, child);
        } else {
          serveLater('0x2')(message, child);
        }
      },
    });
    const c = client(1);
    await expect(c.request({ method: 'eth_blockNumber' })).resolves.toBe('0x2');
    const [old, successor] = fake.children;
    expect(successor.sent('colibri.request')).toHaveLength(1);
    expect(warned('chain 1 service recycling; its successor takes new requests')).toBe(true);
    // The recycling process finishes and exits 0 on its own.
    old.exit(0);
    await flush();
    expect(warned('chain 1 service recycled')).toBe(true);
    expect(mockLogWarn.mock.calls.some(([line]) => /crashed|killed|stopped/.test(line))).toBe(
      false
    );
    await expect(c.request({ method: 'eth_blockNumber' })).resolves.toBe('0x2');
    expect(fake.children).toHaveLength(2);
  });

  test('at the limit: the successor waits for the old process’s exit, and new requests are busy meanwhile', async () => {
    const { held, request } = holding();
    await world({ request });
    const opened = [ask(client(1)), ask(client(100)), ask(client(10))];
    await until(() => held.length === 3, 'three open');
    const old = childOf(1);
    const refused = ask(client(1));
    await until(() => held.length === 4, 'the refused one');
    recycling(held.pop().message, old);
    await flush();
    // Nowhere to spawn its successor: busy for the chain's new requests.
    await expect(client(1).request({ method: 'eth_blockNumber' })).rejects.toThrow(BUSY);
    expect(refused.settled).toBe(false);
    expect(fake.children).toHaveLength(3);
    // The old process finishes what it had and exits; the successor takes
    // its slot and the refused request.
    answer(take(held, old));
    await opened[0].done;
    old.exit(0);
    await until(() => held.length === 3, 'the refused request on the successor');
    expect(held.at(-1).child).toBe(childOf(1, 1));
    answer(held.pop(), '0x3');
    await refused.done;
    expect(refused.result).toBe('0x3');
    expect(Math.max(...alive)).toBe(3);
    held.splice(0).forEach((entry) => answer(entry));
    await Promise.all(opened.map((o) => o.done));
  });

  test('exit 75 after a recycle waits for the recycling process’s exit and tries once more', async () => {
    let requests = 0;
    let hellos = 0;
    const held = [];
    await world({
      hello: (message, child) => {
        hellos += 1;
        // The successor spawned beside the recycling process finds the
        // store locked.
        if (hellos === 2) setImmediate(() => child.exit(75));
        else child.result(message.id, helloFor(child.args));
      },
      request: (message, child) => {
        requests += 1;
        if (requests === 2) recycling(message, child);
        else held.push({ message, child });
      },
    });
    const c = client(1);
    const open = ask(c);
    await until(() => held.length === 1, 'the open one');
    const refused = ask(c);
    await until(
      () => fake.children.length === 2 && fake.children[1].exited,
      'the locked successor'
    );
    await flush();
    expect(
      warned(
        'chain 1 store still locked (exit 75); trying once more when the recycling process has exited'
      )
    ).toBe(true);
    expect(refused.settled).toBe(false);
    await expect(c.request({ method: 'eth_blockNumber' })).rejects.toThrow(BUSY);
    answer(held.shift());
    await open.done;
    fake.children[0].exit(0);
    await until(() => held.length === 1, 'the refused request on the retry');
    expect(held[0].child).toBe(fake.children[2]);
    answer(held.pop(), '0x4');
    await refused.done;
    expect(refused.result).toBe('0x4');
    expect(warned('stopped')).toBe(false);
  });

  test('exit 75 again on the retry stops the lane', async () => {
    let hellos = 0;
    let requests = 0;
    const held = [];
    await world({
      hello: (message, child) => {
        hellos += 1;
        if (hellos >= 2) setImmediate(() => child.exit(75));
        else child.result(message.id, helloFor(child.args));
      },
      request: (message, child) => {
        requests += 1;
        if (requests === 2) recycling(message, child);
        else held.push({ message, child });
      },
    });
    const c = client(1);
    const open = ask(c);
    await until(() => held.length === 1, 'the open one');
    const refused = ask(c);
    await until(
      () => fake.children.length === 2 && fake.children[1].exited,
      'the locked successor'
    );
    answer(held.shift());
    await open.done;
    fake.children[0].exit(0);
    await refused.done;
    expect(refused.error.message).toBe(UNAVAILABLE);
    expect(fake.children).toHaveLength(3);
    expect(warned('chain 1 stopped (exit 75)')).toBe(true);
  });
});

describe('the quit', () => {
  test('stopAll stops every process, resolves once each has exited, and nothing spawns after it', async () => {
    const { held, request } = holding();
    await world({ request });
    const open = ask(client(1));
    await until(() => held.length === 1, 'the open one');
    await service.ensureWorker(1, { private: true });
    await service.stopAll();
    expect(fake.children.every((child) => child.exited)).toBe(true);
    expect(fake.children.every((child) => child.sent('colibri.shutdown').length === 1)).toBe(true);
    await open.done;
    expect(open.error.colibriBystander).toBe(true);
    await expect(client(100).request({ method: 'eth_blockNumber' })).rejects.toThrow(UNAVAILABLE);
    expect(fake.children).toHaveLength(2);
  });
});

describe('the release hello must report', () => {
  test('the pin’s when packaged; any for a developer’s binary; the tag’s for another release', () => {
    const { expectedColibridVersion } = service;
    const { PINNED_COLIBRID_VERSION } = require('./colibrid-pin');
    expect(expectedColibridVersion({ packaged: true, env: { FREEDOM_COLIBRID_PATH: '/x' } })).toBe(
      PINNED_COLIBRID_VERSION
    );
    expect(expectedColibridVersion({ packaged: false, env: {} })).toBe(PINNED_COLIBRID_VERSION);
    expect(
      expectedColibridVersion({ packaged: false, env: { FREEDOM_COLIBRID_PATH: '/x' } })
    ).toBeNull();
    expect(
      expectedColibridVersion({
        packaged: false,
        env: { FREEDOM_COLIBRID_RELEASE_TAG: 'colibrid-v0.2.0' },
      })
    ).toBe('0.2.0');
    expect(
      expectedColibridVersion({ packaged: false, env: { FREEDOM_COLIBRID_RELEASE_TAG: 'latest' } })
    ).toBeNull();
  });
});
