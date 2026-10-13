/**
 * One lifetime per dweb request (freedom-core design 0006, "Deadlines,
 * cancel and bounds"): the real handler, the real naming driver and
 * configuration over a scripted core client, and a real admission instance.
 *
 * - A request is fenced to its session from its handler's entry: a closing
 *   private window stops it wherever it is (the lookup, the wait for a slot,
 *   a re-plan held in its slot), and a closed one starts nothing.
 * - The page's abort settles every wait at once, the configuration waits
 *   included, and frees a slot the request holds.
 * - The driver's final judgment and the plan's use are one synchronous step:
 *   nothing can come between them, and a plan whose process has ended is
 *   never dialled.
 */

const { EventEmitter } = require('events');

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../logger', () => mockLog);

let mockDriver = null;
jest.mock('../core/naming', () => ({ namingDriver: () => mockDriver }));

let mockAdmission = null;
jest.mock('./fetch-admission', () => {
  const actual = jest.requireActual('./fetch-admission');
  return {
    ...actual,
    acquireDwebFetch: (request) => mockAdmission.acquire(request),
    fenceDwebSession: (partition) => mockAdmission.fence(partition),
  };
});

const { NamingConfig } = require('../core/naming-config');
const { NamingDriver } = require('../core/naming-driver');
const { handleDwebRequest } = require('./dweb-handler');
const { createFetchAdmission } = require('./fetch-admission');

const HASH = 'ab'.repeat(32);
const HASH2 = 'cd'.repeat(32);
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

const SOURCES = {
  ens: {
    getEffectiveRpcEndpoints: () => ['https://a.rpc.example'],
    getDirectRpcCandidate: () => ({ url: null }),
    resolutionPolicy: () => ({ order: ['quorum'] }),
  },
  tezos: { getRpcEndpoints: () => ['https://t1.tez.example'] },
  registry: { getNetwork: () => ({ quorum: { k: 1, m: 1 } }), getEndpoints: () => [] },
  myotis: { isEnabled: () => false, isReady: () => false },
};

function fetchPlan(hash = HASH) {
  return {
    fetch: {
      node: 'ant',
      path: `/bzz/${hash}/index.html`,
      headers: [
        ['swarm-chunk-retrieval-timeout', '30s'],
        ['swarm-redundancy-fallback-mode', 'true'],
        ['swarm-redundancy-strategy', '3'],
      ],
      retry: { statuses: [], on_error: false, attempts: 1, delays_ms: [] },
      timers: { queue_ms: null, headers_ms: 30000, body_idle_ms: 60000 },
      response: ['canonicalize_redirect', 'strip_page_state'],
      trust: { name: 'verified', content: 'node_asserted' },
    },
  };
}

function cancelledError() {
  return Object.assign(new Error('Cancelled'), { code: 'cancelled' });
}

/**
 * The core client, scripted: naming's controls answer with advanced
 * generations (or are held), and each `dweb.open` is answered by `plan`, or
 * held until `answer()`. A held request settles `cancelled` when its signal
 * aborts, as the real client's does once it has written the core's cancel.
 */
class ScriptedClient extends EventEmitter {
  constructor() {
    super();
    this.current = { id: 'process' };
    this.hello = {};
    this.ended = false;
    this.gens = { ens: 0, tezos: 0, lifecycle: 0 };
    this.calls = [];
    this.opens = [];
    this.holdOpens = false;
    this.holdControls = false;
    this.heldControls = [];
    this.plan = () => fetchPlan();
  }

  serves(gen) {
    return gen === this.current && !this.ended;
  }

  whenReady() {
    return Promise.resolve(this.hello);
  }

  requestTo(gen, method, params, context, options = {}) {
    this.calls.push({ method, params, context, options });
    if (method === 'naming.configure' || method === 'naming.availability') {
      const reply =
        method === 'naming.configure'
          ? { ...this.gens, ens: ++this.gens.ens, lifecycle: ++this.gens.lifecycle }
          : { ...this.gens };
      if (!this.holdControls) return Promise.resolve(reply);
      return new Promise((resolve) => this.heldControls.push(() => resolve(reply)));
    }
    const open = { params, signal: options.signal, cancelled: false };
    this.opens.push(open);
    return new Promise((resolve, reject) => {
      open.answer = (plan = this.plan(params)) =>
        // A name's lookup runs one attempt more than the caller had used.
        resolve({ plan, generations: { ...this.gens }, attempts: (params.attempts_used ?? 0) + 1 });
      options.signal?.addEventListener(
        'abort',
        () => {
          open.cancelled = true;
          reject(cancelledError());
        },
        { once: true }
      );
      if (!this.holdOpens) open.answer();
    });
  }

  releaseControls() {
    for (const release of this.heldControls.splice(0)) release();
  }
}

let client;
let config;
let dials;
let backend;

async function setUp({ maxActive = 256, maxWaiting = 512 } = {}) {
  mockAdmission = createFetchAdmission({ maxActive, maxWaiting });
  client = new ScriptedClient();
  config = new NamingConfig({ client, sources: SOURCES, log: quietLog });
  expect(await config.whenReady()).toBe(true);
  mockDriver = new NamingDriver({ client, config, normalize: (name) => name.toLowerCase() });
  dials = [];
  backend = {
    ref: { ant: 'bundled', up: true },
    url: 'http://127.0.0.1:1633',
    request: async (init) => {
      dials.push({
        path: init.path,
        pending: config.core?.pending,
        serving: client.serves(client.current),
      });
      return new Response('content');
    },
  };
}

const handle = (url, { partition = null, signal } = {}) =>
  handleDwebRequest(new Request(url, signal ? { signal } : {}), {
    backend,
    partition,
    tag: '[bzz-protocol]',
  });

const opens = () => client.calls.filter((call) => call.method === 'dweb.open');

async function until(predicate) {
  for (let turn = 0; turn < 200 && !predicate(); turn++) await tick();
  expect(predicate()).toBe(true);
}

beforeEach(() => jest.clearAllMocks());

describe("a private session's close stops its requests wherever they are", () => {
  test('a closed session plans and dials nothing', async () => {
    await setUp();
    mockAdmission.closeSession('private-1');
    const res = await handle(`bzz://${HASH}/index.html`, { partition: 'private-1' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'Cancelled' });
    expect(opens()).toHaveLength(0);
    expect(dials).toHaveLength(0);
  });

  // A manifest's request carries no page signal: only the fence can end it.
  test("during the lookup: the core's dweb.open is cancelled and nothing is dialled", async () => {
    await setUp();
    client.holdOpens = true;
    const pending = handle('bzz://site.eth/index.html', { partition: 'private-1' });
    await until(() => client.opens.length === 1);

    mockAdmission.closeSession('private-1');
    const res = await pending;

    expect(res.status).toBe(502);
    expect(client.opens[0].cancelled).toBe(true);
    // A late answer is never used.
    client.opens[0].answer();
    await tick();
    expect(dials).toHaveLength(0);
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('before its slot: the waiter is refused, and no slot is left behind', async () => {
    await setUp({ maxActive: 1, maxWaiting: 1 });
    const held = await mockAdmission.acquire();
    const pending = handle('bzz://site.eth/index.html', { partition: 'private-1' });
    await until(() => mockAdmission.stats().waiting === 1);

    mockAdmission.closeSession('private-1');
    expect((await pending).status).toBe(502);
    held.release();
    await tick();
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
    expect(dials).toHaveLength(0);
  });

  test('during a re-plan held in its slot: the re-plan is cancelled and the slot freed', async () => {
    await setUp({ maxActive: 1, maxWaiting: 1 });
    const held = await mockAdmission.acquire();
    const pending = handle('bzz://site.eth/index.html', { partition: 'private-1' });
    await until(() => mockAdmission.stats().waiting === 1);
    // A provider reset while the plan waits: once admitted, it is overtaken.
    await config.configure({ reset: true });
    client.holdOpens = true;
    held.release();
    await until(() => client.opens.length === 2);
    expect(mockAdmission.stats().active).toBe(1);
    expect(opens()[1].params.attempts_used).toBe(1);

    mockAdmission.closeSession('private-1');
    const res = await pending;

    expect(res.status).toBe(502);
    expect(client.opens[1].cancelled).toBe(true);
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
    expect(dials).toHaveLength(0);
    // Another session's fetch gets the slot.
    (await mockAdmission.acquire()).release();
  });
});

describe("the page's abort", () => {
  test('settles a wait for a quiet configuration at once, with nothing sent', async () => {
    await setUp();
    client.holdControls = true;
    const control = config.configure({ reset: true });
    const page = new AbortController();
    const pending = handle(`bzz://${HASH}/index.html`, { signal: page.signal });
    await tick();
    page.abort();

    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'Cancelled' });
    expect(opens()).toHaveLength(0);
    client.releaseControls();
    await control;
  });

  test('settles the wait after admission at once, and frees the slot', async () => {
    await setUp({ maxActive: 1, maxWaiting: 1 });
    const held = await mockAdmission.acquire();
    const page = new AbortController();
    const pending = handle(`bzz://${HASH}/index.html`, { signal: page.signal });
    await until(() => mockAdmission.stats().waiting === 1);
    // A control is in flight when the slot comes: the plan waits for it.
    client.holdControls = true;
    const control = config.configure({ reset: true });
    held.release();
    await until(() => mockAdmission.stats().waiting === 0);
    expect(mockAdmission.stats().active).toBe(1);

    page.abort();
    expect((await pending).status).toBe(502);
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
    expect(dials).toHaveLength(0);
    client.releaseControls();
    await control;
  });
});

describe("the final judgment and the plan's use are one step", () => {
  // A control (or the core's end) asked for in the turn after the final
  // check comes after the dial: nothing runs between them.
  function afterFinalCheck(act) {
    let admitted = false;
    const acquire = mockAdmission.acquire;
    mockAdmission.acquire = async (request) => {
      const slot = await acquire(request);
      admitted = true;
      return slot;
    };
    const idle = config.idle.bind(config);
    let acted = false;
    config.idle = (gen) => {
      const quiet = idle(gen);
      if (quiet && admitted && !acted) {
        acted = true;
        queueMicrotask(act);
      }
      return quiet;
    };
  }

  test('a configuration change in that turn comes after the dial', async () => {
    await setUp();
    let control;
    afterFinalCheck(() => {
      control = config.configure({ reset: true });
    });
    const res = await handle('bzz://site.eth/index.html');
    await control;

    expect(res.status).toBe(200);
    expect(dials).toEqual([{ path: `/bzz/${HASH}/index.html`, pending: 0, serving: true }]);
    expect(client.calls.map((call) => call.method).slice(-2)).toEqual([
      'dweb.open',
      'naming.configure',
    ]);
  });

  test("the core's end in that turn comes after the dial", async () => {
    await setUp();
    afterFinalCheck(() => {
      client.ended = true;
    });
    const res = await handle('bzz://site.eth/index.html');
    expect(res.status).toBe(200);
    expect(dials).toEqual([{ path: `/bzz/${HASH}/index.html`, pending: 0, serving: true }]);
  });

  test('a core that ended while the plan waited for its slot is a 503, never dialled', async () => {
    await setUp({ maxActive: 1, maxWaiting: 1 });
    const held = await mockAdmission.acquire();
    const pending = handle('bzz://site.eth/index.html');
    await until(() => mockAdmission.stats().waiting === 1);
    // Its process is fenced off before its exit is delivered: the
    // configuration still reads as idle.
    client.ended = true;
    held.release();

    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 503, message: 'The core is unavailable' });
    expect(dials).toHaveLength(0);
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('a plan a control overtook while it waited is planned again, with its attempts', async () => {
    await setUp({ maxActive: 1, maxWaiting: 1 });
    const held = await mockAdmission.acquire();
    client.plan = (params) => fetchPlan(params.attempts_used ? HASH2 : HASH);
    const pending = handle('bzz://site.eth/index.html');
    await until(() => mockAdmission.stats().waiting === 1);
    await config.configure({ reset: true });
    held.release();

    expect((await pending).status).toBe(200);
    expect(opens().map((call) => call.params.attempts_used)).toEqual([undefined, 1]);
    expect(dials.map((dial) => dial.path)).toEqual([`/bzz/${HASH2}/index.html`]);
  });
});
