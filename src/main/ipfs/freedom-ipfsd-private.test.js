/**
 * Private windows' instances on the ephemeral freedom-ipfsd process
 * (freedom-core design 0007, "Private windows"), against the in-process fake
 * service (`test/helpers/fake-ipfsd.js`) and a manual clock: the cold start
 * inside `request()`, one per instance, under each waiter's own deadline;
 * leases and pins; slots, eviction and `BackendBusy`; fences before
 * anything is sent; a partition's close; the process's idle shutdown, lazy
 * respawn and crash record. The real binary runs the backend contract suite
 * and `freedom-ipfsd-private.integration.test.js`.
 */

const { PrivateInstances, MAX_INSTANCES } = require('./freedom-ipfsd-private');
const { fakeIpfsd, HELLO } = require('../../../test/helpers/fake-ipfsd');

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const CAPACITY = 'Too many private windows are loading IPFS content';

/** Timers that run only when the test advances the clock. */
function manualClock() {
  let now = 1_000_000;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    /** How many timers are armed. */
    pending: () => timers.size,
    /** Runs every timer due within `ms`, in order, letting I/O settle between. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/** Lets the pipes and promises run. */
async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

const ephemeralHello = (message, child) =>
  child.result(message.id, { ...HELLO, kind: 'ephemeral' });
const serve = (message, child) => {
  child.head(message.id, { status: 200, headers: [['content-type', 'text/plain']] });
  child.body(message.id, Buffer.from(`private ${message.params.instance}`));
};
/** A script handler that holds its messages, to answer them later. */
function holding() {
  const held = [];
  const handler = (message, child) => held.push({ message, child });
  return { held, handler };
}

let clock;
let service;
let log;
let instances;

function newInstances(script = {}) {
  service = fakeIpfsd({ hello: ephemeralHello, request: serve, ...script });
  instances = new PrivateInstances({
    command: 'freedom-ipfsd',
    spawn: service.spawn,
    log,
    shellVersion: '0.9.0-test',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return instances;
}

const child = (n = -1) => service.children.at(n);
const sent = (method) => service.children.flatMap((c) => c.sent(method));
const init = (extra = {}) => ({
  path: `/ipfs/${CID}`,
  method: 'GET',
  headers: new Headers(),
  ...extra,
});

/** A body read to its end, as text. */
async function text(res) {
  const reader = res.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts).toString();
    parts.push(Buffer.from(value));
  }
}

/** One load through a new lease on `partition`, released at its end. */
async function load(partition, extra) {
  const lease = instances.lease(partition);
  try {
    return await text(await lease.request(init(extra)));
  } finally {
    lease.release();
  }
}

beforeEach(() => {
  clock = manualClock();
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

afterEach(async () => {
  const stopping = instances?.stop();
  await settle();
  await clock.advance(10_000);
  await stopping;
});

describe('the cold start', () => {
  test('a first private load spawns the ephemeral process and starts a memory instance for it', async () => {
    newInstances();
    expect(service.spawned).toHaveLength(0);

    expect(await load('private-a')).toBe('private e-1');

    expect(service.spawned).toHaveLength(1);
    expect(service.spawned[0].args).toEqual([
      'serve',
      '--ephemeral',
      '--parent-pid',
      String(process.pid),
    ]);
    const [start] = sent('ipfs.start');
    // Today's configuration (0007, Parity), on a memory store of 32 MiB.
    expect(start.params).toEqual({
      instance: 'e-1',
      store: { kind: 'memory', max_bytes: 32 * 1024 * 1024 },
      routing: {
        mode: 'auto',
        delegated_routers: [
          'https://delegated-ipfs.dev/routing/v1',
          'https://cid.contact/routing/v1',
        ],
        dht_query_timeout_s: 3,
        dht_max_providers: 32,
      },
      gateway: { max_concurrent_requests: 8, request_queue_timeout_ms: 15000 },
      network: { mode: 'direct' },
    });
    const [request] = sent('ipfs.request');
    expect(request.params).toMatchObject({ instance: 'e-1', method: 'GET', headers_ms: 30000 });
    // It stays, idle, to serve its partition again.
    expect(await load('private-a')).toBe('private e-1');
    expect(sent('ipfs.start')).toHaveLength(1);
  });

  test('each partition gets an instance of its own, in the one process', async () => {
    newInstances();
    expect(await load('private-a')).toBe('private e-1');
    expect(await load('private-b')).toBe('private e-2');
    expect(await load('private-a')).toBe('private e-1');
    expect(service.spawned).toHaveLength(1);
  });

  test('concurrent first loads in one partition share one start', async () => {
    newInstances();
    const loads = await Promise.all([load('private-a'), load('private-a'), load('private-a')]);
    expect(loads).toEqual(['private e-1', 'private e-1', 'private e-1']);
    expect(sent('ipfs.start')).toHaveLength(1);
    expect(sent('ipfs.request')).toHaveLength(3);
  });

  test("the head deadline covers the start: the request gets what is left of it, or the start's wait times out", async () => {
    const starts = holding();
    newInstances({ start: starts.handler });
    const lease = instances.lease('private-a');
    const pending = lease.request(init({ headersTimeoutMs: 1_000 }));
    await settle();
    await clock.advance(600);
    const { message, child: c } = starts.held[0];
    c.result(message.id, { instance: message.params.instance });
    expect(await text(await pending)).toBe('private e-1');
    expect(sent('ipfs.request')[0].params.headers_ms).toBe(400);
    lease.release();

    const late = instances.lease('private-b');
    const timedOut = late.request(init({ headersTimeoutMs: 1_000 })).catch((err) => err);
    await settle();
    await clock.advance(1_000);
    expect((await timedOut).message).toBe('freedom-ipfs native request timeout');
    late.release();
  });
});

describe('waiters with different deadlines', () => {
  test("the first waiter's abort leaves the start running for the others", async () => {
    const starts = holding();
    newInstances({ start: starts.handler });
    const first = instances.lease('private-a');
    const second = instances.lease('private-a');
    const controller = new AbortController();
    const aborted = first.request(init({ signal: controller.signal })).catch((err) => err);
    const served = second.request(init());
    await settle();

    controller.abort();
    expect((await aborted).message).toBe('freedom-ipfs native request aborted');
    first.release();
    expect(instances.pins('private-a')).toBe(1);
    expect(sent('ipfs.stop')).toHaveLength(0);

    const { message, child: c } = starts.held[0];
    c.result(message.id, { instance: message.params.instance });
    expect(await text(await served)).toBe('private e-1');
    second.release();
    expect(instances.pins('private-a')).toBe(0);
  });

  test("the last waiter's abort cancels the start: its ID is stopped, and nothing else is sent to it", async () => {
    const starts = holding();
    newInstances({ start: starts.handler });
    const lease = instances.lease('private-a');
    const controller = new AbortController();
    const aborted = lease.request(init({ signal: controller.signal })).catch((err) => err);
    await settle();

    controller.abort();
    expect((await aborted).message).toBe('freedom-ipfs native request aborted');
    lease.release();
    await settle();
    expect(instances.pins('private-a')).toBe(0);
    expect(sent('ipfs.stop').map((m) => m.params)).toEqual([{ instance: 'e-1' }]);

    // The start's late answer starts nothing more.
    const { message, child: c } = starts.held[0];
    c.error(message.id, 'stopped', 'the instance is retired or unknown');
    await settle();
    expect(sent('ipfs.request')).toHaveLength(0);
    // With nothing left, the process went; the partition's next request
    // starts a new instance in a new one.
    expect(child(0).exited).toBe(true);
    starts.held.length = 0;
    const next = load('private-a');
    await settle();
    const again = starts.held[0];
    again.child.result(again.message.id, { instance: again.message.params.instance });
    expect(await next).toBe('private e-1');
    expect(service.spawned).toHaveLength(2);
  });
});

describe('leases and capacity', () => {
  test('a lease pins its partition; a second release is harmless', () => {
    newInstances();
    const first = instances.lease('private-a');
    const second = instances.lease('private-a');
    expect(instances.pins('private-a')).toBe(2);
    first.release();
    first.release();
    expect(instances.pins('private-a')).toBe(1);
    second.release();
    expect(instances.pins('private-a')).toBe(0);
    expect(instances.pins('private-other')).toBe(0);
  });

  test('a lease released before any request frees its pending instance, and spawns nothing', async () => {
    newInstances();
    for (let i = 0; i < MAX_INSTANCES * 2; i++) instances.lease(`private-${i}`).release();
    await settle();
    expect(service.spawned).toHaveLength(0);
  });

  test('all 8 pinned: each serves again, a ninth is BackendBusy, and a release makes room by evicting that instance', async () => {
    newInstances();
    const partitions = Array.from({ length: MAX_INSTANCES }, (_, i) => `private-${i}`);
    const pinned = [];
    for (const partition of partitions) {
      const lease = instances.lease(partition);
      pinned.push(lease);
      await text(await lease.request(init()));
    }
    for (const partition of partitions) expect(await load(partition)).toMatch(/^private e-\d$/);
    expect(sent('ipfs.start')).toHaveLength(MAX_INSTANCES);

    let refused = null;
    try {
      instances.lease('private-ninth');
    } catch (err) {
      refused = err;
    }
    expect(refused).toMatchObject({ name: 'BackendBusy', message: CAPACITY });
    expect(instances.up).toBe(true);

    pinned[3].release();
    expect(await load('private-ninth')).toBe('private e-9');
    expect(sent('ipfs.stop').map((m) => m.params)).toEqual([{ instance: 'e-4' }]);
    for (const lease of pinned) lease.release();
  });

  test('eviction takes the least recently used instance no lease pins, never a pinned one', async () => {
    newInstances();
    const pinned = [];
    for (let i = 0; i < MAX_INSTANCES; i++) {
      const lease = instances.lease(`private-${i}`);
      await text(await lease.request(init()));
      // The oldest stay pinned; two later ones go idle.
      if (i === 5 || i === 6) lease.release();
      else pinned.push(lease);
      await clock.advance(1_000);
    }
    expect(await load('private-ninth')).toBe('private e-9');
    // private-5 (e-6) was used least recently of the unpinned two.
    expect(sent('ipfs.stop').map((m) => m.params)).toEqual([{ instance: 'e-6' }]);
    expect(await load('private-6')).toBe('private e-7');
    for (const lease of pinned) lease.release();
  });

  test("a start in an evicted slot waits for that instance's teardown", async () => {
    const stops = holding();
    newInstances({ stop: stops.handler });
    for (let i = 0; i < MAX_INSTANCES; i++) await load(`private-${i}`);

    const ninth = load('private-ninth');
    await settle();
    expect(sent('ipfs.stop').map((m) => m.params)).toEqual([{ instance: 'e-1' }]);
    expect(sent('ipfs.start')).toHaveLength(MAX_INSTANCES);

    const { message, child: c } = stops.held[0];
    c.result(message.id, { instance: message.params.instance });
    expect(await ninth).toBe('private e-9');
    expect(sent('ipfs.start')).toHaveLength(MAX_INSTANCES + 1);
  });

  test('a ninth partition evicting while another plans takes only unpinned instances', async () => {
    newInstances();
    // Seven partitions pinned through planning; one idle.
    const planning = [];
    for (let i = 0; i < MAX_INSTANCES; i++) {
      const lease = instances.lease(`private-${i}`);
      await text(await lease.request(init()));
      if (i === 0) lease.release();
      else planning.push(lease);
    }
    const ninth = instances.lease('private-ninth');
    expect(await text(await ninth.request(init()))).toBe('private e-9');
    expect(sent('ipfs.stop').map((m) => m.params)).toEqual([{ instance: 'e-1' }]);
    // A tenth partition finds nothing left to evict.
    expect(() => instances.lease('private-tenth')).toThrow(CAPACITY);
    ninth.release();
    // The pinned partitions are served by their own instances still.
    for (const lease of planning)
      expect(await text(await lease.request(init()))).toMatch(/e-[2-8]$/);
    for (const lease of planning) lease.release();
  });
});

describe('fences', () => {
  test('a request on a released lease, or with an aborted signal, sends nothing', async () => {
    newInstances();
    const lease = instances.lease('private-a');
    const controller = new AbortController();
    controller.abort();
    await expect(lease.request(init({ signal: controller.signal }))).rejects.toThrow(
      'freedom-ipfs native request aborted'
    );
    lease.release();
    await expect(lease.request(init())).rejects.toThrow('freedom-ipfs native node is not running');
    expect(service.spawned).toHaveLength(0);
  });

  test("a partition's close during the cold start cancels it and releases its leases; a closed partition is served no more", async () => {
    const starts = holding();
    newInstances({ start: starts.handler });
    const lease = instances.lease('private-a');
    const pending = lease.request(init()).catch((err) => err);
    await settle();

    instances.close('private-a');
    expect(instances.pins('private-a')).toBe(0);
    expect((await pending).message).toBe('freedom-ipfs native node is not running');
    await settle();
    expect(sent('ipfs.stop').map((m) => m.params)).toEqual([{ instance: 'e-1' }]);
    lease.release();

    const after = instances.lease('private-a');
    await expect(after.request(init())).rejects.toThrow('freedom-ipfs native node is not running');
    after.release();
    expect(sent('ipfs.start')).toHaveLength(1);
  });

  test("a live instance's close: its open body is aborted by its teardown, and its ID gets nothing more", async () => {
    newInstances();
    expect(await load('private-a')).toBe('private e-1');
    instances.close('private-a');
    await settle();
    expect(sent('ipfs.stop').map((m) => m.params)).toEqual([{ instance: 'e-1' }]);
    expect(sent('ipfs.request')).toHaveLength(1);
  });
});

describe('a start against what can end it', () => {
  test("a process crash fails a cold start waiting for an evicted instance's teardown", async () => {
    const stops = holding();
    newInstances({ stop: stops.handler });
    for (let i = 0; i < MAX_INSTANCES; i++) await load(`private-${i}`);
    const lease = instances.lease('private-ninth');
    let outcome = 'pending';
    const pending = lease.request(init()).then(
      () => (outcome = 'served'),
      (err) => (outcome = err.message)
    );
    await settle();
    expect(stops.held).toHaveLength(1);

    child().exit(70);
    await settle();
    expect(outcome).toBe('freedom-ipfs service exited');
    await clock.advance(500);
    await pending;
    expect(outcome).toBe('freedom-ipfs service exited');
    expect(service.spawned).toHaveLength(1);
    lease.release();
  });

  test('a start waiting for an idle shutdown to end goes on in the next process', async () => {
    const shutdowns = holding();
    newInstances({ shutdown: shutdowns.handler });
    await load('private-a');
    instances.close('private-a');
    await settle();
    expect(shutdowns.held).toHaveLength(1);

    const next = load('private-b');
    await settle();
    shutdowns.held[0].child.exit(0);
    expect(await next).toBe('private e-1');
    expect(service.spawned).toHaveLength(2);
  });
});

describe('the process', () => {
  test('goes once its last instance has, and is spawned again on the next private load', async () => {
    newInstances();
    expect(await load('private-a')).toBe('private e-1');
    instances.close('private-a');
    await settle();
    expect(child(0).sent('ipfs.shutdown')).toHaveLength(1);
    expect(child(0).exited).toBe(true);

    // A new generation, its IDs from e-1 again.
    expect(await load('private-b')).toBe('private e-1');
    expect(service.spawned).toHaveLength(2);
  });

  test('stays while a teardown is unproven', async () => {
    const stops = holding();
    newInstances({ stop: stops.handler });
    await load('private-a');
    instances.close('private-a');
    await settle();
    expect(child(0).sent('ipfs.shutdown')).toHaveLength(0);
    const { message, child: c } = stops.held[0];
    c.result(message.id, { instance: message.params.instance });
    await settle();
    expect(child(0).sent('ipfs.shutdown')).toHaveLength(1);
  });

  test('a crash retires every instance, and the process comes back only when needed, after its back-off', async () => {
    newInstances();
    await load('private-a');
    const stale = instances.lease('private-a');
    child(0).exit(null, 'SIGKILL');
    await settle();
    await expect(stale.request(init())).rejects.toThrow('freedom-ipfs native node is not running');
    stale.release();

    // Nothing respawns on its own.
    await clock.advance(30_000);
    expect(service.spawned).toHaveLength(1);
    // Past its back-off, the next load spawns it at once: a new generation.
    expect(await load('private-a')).toBe('private e-1');
    expect(service.spawned).toHaveLength(2);

    // A second crash within the minute: the next load waits its 2 s.
    child(1).exit(null, 'SIGKILL');
    await settle();
    const next = load('private-a');
    await settle();
    await clock.advance(1_999);
    expect(service.spawned).toHaveLength(2);
    await clock.advance(1);
    expect(await next).toBe('private e-1');
    expect(service.spawned).toHaveLength(3);
  });

  test('a crash on first use does not loop: the third within 60 s fails the private instances', async () => {
    newInstances({ start: (message, c) => c.exit(70) });
    for (const backoff of [0, 500, 2_000]) {
      const lease = instances.lease('private-a');
      const pending = lease.request(init()).catch((err) => err);
      await settle();
      await clock.advance(backoff);
      expect((await pending).message).toBe('freedom-ipfs service exited');
      lease.release();
    }
    expect(service.spawned).toHaveLength(3);
    expect(instances.up).toBe(false);
    const dead = instances.lease('private-b');
    await expect(dead.request(init())).rejects.toThrow('freedom-ipfs native node is not running');
    dead.release();
    expect(service.spawned).toHaveLength(3);
    expect(log.error).toHaveBeenCalledWith('[IPFS] private freedom-ipfs instances unavailable', {
      reason: 'three crashes within a minute',
    });
  });

  test("the crash record outlives the process's idle shutdowns", async () => {
    newInstances();
    for (let i = 0; i < 2; i++) {
      await clock.advance(10_000);
      await load('private-a');
      child().exit(null, 'SIGKILL');
      await settle();
    }
    // An idle shutdown in between.
    await clock.advance(10_000);
    await load('private-b');
    instances.close('private-b');
    await settle();
    expect(child().exited).toBe(true);

    await clock.advance(10_000);
    await load('private-c');
    child().exit(null, 'SIGKILL');
    await settle();
    expect(instances.up).toBe(false);
  });

  test.each([
    ['a usage exit (64)', (message, c) => c.exit(64)],
    [
      'a protocol mismatch',
      (message, c) => c.result(message.id, { ...HELLO, kind: 'ephemeral', protocol: 2 }),
    ],
  ])('%s fails the private instances at once', async (_label, hello) => {
    newInstances({ hello });
    const lease = instances.lease('private-a');
    await expect(lease.request(init())).rejects.toThrow();
    lease.release();
    await settle();
    expect(instances.up).toBe(false);
    expect(service.spawned).toHaveLength(1);
  });

  test("the service retiring an instance after a panic: that partition's only, counted as a crash", async () => {
    newInstances();
    await load('private-a');
    await load('private-b');
    const stale = instances.lease('private-a');
    child().event('ipfs.instance_retired', { instance: 'e-1', reason: 'panic' });
    await settle();

    await expect(stale.request(init())).rejects.toThrow('freedom-ipfs native node is not running');
    stale.release();
    // The panicking partition's next load starts a new instance, cold, after
    // the back-off of a crash: the process lives on, serving the other.
    const next = load('private-a');
    await settle();
    expect(await load('private-b')).toBe('private e-2');
    await clock.advance(499);
    expect(sent('ipfs.start')).toHaveLength(2);
    await clock.advance(1);
    expect(await next).toBe('private e-3');
    expect(sent('ipfs.stop')).toHaveLength(0);
    expect(service.spawned).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('[IPFS] private freedom-ipfs instance retired', {
      instance: 'e-1',
      reason: 'panic',
    });

    // Two more within the minute fail them.
    for (const instance of ['e-2', 'e-3']) {
      child().event('ipfs.instance_retired', { instance, reason: 'panic' });
      await settle();
    }
    expect(instances.up).toBe(false);
  });

  // The back-off is the process's (0007: a panic retirement counts as a
  // crash of its process): every start waits for it, a new partition's too.
  test("a crash's back-off holds every instance start, whether the process restarts or lives on", async () => {
    newInstances();
    await load('private-a');
    await load('private-b');
    child().event('ipfs.instance_retired', { instance: 'e-1', reason: 'panic' });
    await settle();
    const fresh = load('private-new');
    await clock.advance(499);
    expect(sent('ipfs.start')).toHaveLength(2);
    await clock.advance(1);
    expect(await fresh).toBe('private e-3');
    expect(service.spawned).toHaveLength(1);
  });

  test('a start the service refuses on its storage fails the private instances: no restart until a new manager', async () => {
    newInstances({
      start: (message, c) => c.error(message.id, 'storage', 'the memory store cannot open'),
    });
    const first = instances.lease('private-a');
    await expect(first.request(init())).rejects.toThrow('freedom-ipfs native gateway error');
    first.release();
    await settle();

    expect(instances.up).toBe(false);
    const second = instances.lease('private-a');
    await expect(second.request(init())).rejects.toThrow('freedom-ipfs native node is not running');
    second.release();
    expect(sent('ipfs.start')).toHaveLength(1);
    expect(service.spawned).toHaveLength(1);
    expect(child().sent('ipfs.shutdown')).toHaveLength(1);
  });

  test.each([
    ['its last lease', (lease) => lease.release()],
    ["its partition's close", () => instances.close('private-b')],
    ['the stop', () => instances.stop()],
  ])('a start waiting out the back-off leaves no timer once %s goes', async (_label, end) => {
    newInstances();
    await load('private-a');
    child().exit(null, 'SIGKILL');
    await settle();
    expect(clock.pending()).toBe(0);

    const lease = instances.lease('private-b');
    const pending = lease.request(init()).catch((err) => err);
    await settle();
    // The back-off's timer, and the waiter's head deadline.
    expect(clock.pending()).toBe(2);
    end(lease);
    expect((await pending).message).toBe('freedom-ipfs native node is not running');
    lease.release();
    await settle();
    expect(clock.pending()).toBe(0);
    expect(instances.life).toBeNull();
    expect(service.spawned).toHaveLength(1);
  });

  test('a start the service refuses for memory is BackendBusy, and the next request tries again', async () => {
    let refuse = true;
    newInstances({
      start: (message, c) => {
        if (refuse) c.error(message.id, 'busy', 'the memory budget is full');
        else c.result(message.id, { instance: message.params.instance });
      },
    });
    const lease = instances.lease('private-a');
    await expect(lease.request(init())).rejects.toMatchObject({
      name: 'BackendBusy',
      message: 'freedom-ipfs native node is busy',
    });
    lease.release();
    refuse = false;
    expect(await load('private-a')).toMatch(/^private e-\d$/);
    expect(sent('ipfs.start')).toHaveLength(2);
  });

  test('stop retires everything and shuts the process down; nothing starts again', async () => {
    newInstances();
    await load('private-a');
    const lease = instances.lease('private-b');
    const stopping = instances.stop();
    await settle();
    await stopping;
    expect(child(0).sent('ipfs.shutdown')).toHaveLength(1);
    expect(instances.up).toBe(false);
    await expect(lease.request(init())).rejects.toThrow('freedom-ipfs native node is not running');
    lease.release();
    const after = instances.lease('private-c');
    await expect(after.request(init())).rejects.toThrow('freedom-ipfs native node is not running');
    expect(service.spawned).toHaveLength(1);
  });
});
