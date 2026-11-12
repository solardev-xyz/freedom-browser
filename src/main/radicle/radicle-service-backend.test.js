/**
 * The reads of the Radicle node on freedom-radicled (freedom-core design
 * 0008, "JSON results" and Main's side, "Other callers"; the radicled
 * step-5 plan's B7), main's side of 0008 §Tests first, "JSON results":
 * a real RadicledNode on an in-process fake service (fake-radicled.js),
 * whose `rad.read` replies are freedom-radicled's (a head of `{
 * content_type, bytes }` that opens its stream without saying `body: true`,
 * then the JSON under 0007's credit), and a manual clock for main's waits.
 *
 * - four maximum-size bodies with slow consumers: main holds one ring per
 *   stream, and nothing of them is collected;
 * - the caps: at its cap a result is parsed, one byte past it is
 *   `too_large`, its body cancelled unread;
 * - the 16 MiB collection budget: `busy` once a call has waited 5 s;
 * - an aborted collect releases its bytes at once;
 * - a paused 4 MiB scope, aborted, keeps its reservation until its callback
 *   settles, and a new call can't use it;
 * - the other callers' 64 outstanding and 64 waiting.
 *
 * The golden vectors against the binary are the contract suite's
 * (`FREEDOM_RADICLE_CONTRACT_BACKEND=radicled`), and node_info's three
 * contracts there and in radicle-manager.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-grant', () => ({ radicleGrantRefusal: jest.fn(() => null) }));

const { RadicledNode } = require('./radicled-node');
const {
  RadicleServiceBackend,
  COLLECTED_CAPS,
  COLLECTION_BUDGET_BYTES,
  RESERVE_WAIT_MS,
  MAX_OUTSTANDING,
  MAX_WAITING,
} = require('./radicle-service-backend');
const { fakeRadicled } = require('../../../test/helpers/fake-radicled');

const KIB = 1024;
const MIB = 1024 * KIB;
/** A data frame's most, and the one ring main keeps per stream (0007). */
const CHUNK = 64 * KIB;
const RING = 128 * KIB;
/** The largest JSON a read answers (0008, "Pools and budgets"). */
const MAX_JSON = 32 * MIB;

/** Lets the pipes and promises run. */
async function settle(turns = 30) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Timers that run only when the test advances the clock. */
function manualClock() {
  let now = 0;
  const timers = new Set();
  return {
    setTimer(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
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

/** A JSON object of exactly `bytes` bytes: `{"pad":"x…x"}`. */
function jsonOf(bytes) {
  return JSON.stringify({ pad: 'x'.repeat(bytes - '{"pad":""}'.length) });
}

/** A promise and the functions that settle it. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What a promise has done so far, without waiting for it. */
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error })
  );
  return state;
}

let root;
let nodes;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-service-backend-'));
  nodes = [];
});

afterEach(async () => {
  for (const node of nodes) await node.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A running node whose service answers each `rad.read` through `read(message,
 * child)`, and a backend on it with a manual clock.
 */
async function running(read = () => {}, options = {}) {
  const service = fakeRadicled({ read: (message, child) => read(message, child) });
  const node = new RadicledNode({
    home: path.join(root, 'home'),
    lockDir: path.join(root, 'locks'),
    ownHome: path.join(root, 'radicled-home'),
    keys: {
      status: async () => ({ exists: true, unlocked: true }),
      seal: async () => ({ enc: 'ZW5j', ciphertext: 'Y2lwaGVydGV4dA==' }),
      switchHome: async () => ({ status: 'installed' }),
      onVaultEvent: () => () => {},
    },
    guard: { blockReason: () => null, block() {}, unblock() {} },
    removeStaleSocket: async () => false,
    spawn: service.spawn,
    log: { info() {}, warn() {}, error() {} },
    shellVersion: 'jest',
    // Inert: the node's own timers (its stats poll, the watchdogs) never fire.
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  nodes.push(node);
  void node.start();
  await settle();
  expect(node.generation).not.toBeNull();
  const clock = manualClock();
  const backend = new RadicleServiceBackend({
    node: () => node,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
  return { service, child: service.children[0], node, backend, clock };
}

/** The `rad.read` requests a child got. */
const reads = (child) => child.sent('rad.read');

describe('callStream: a read passed through', () => {
  test("the head's length and the service's bytes, the read as main sent it; its slot held until the body ends", async () => {
    const text = '{"rid":"rad:z1","name":"café"}';
    const { child, backend } = await running((m, c) => c.readReply(m.id, text));
    const { head, body } = await backend.callStream('repo_info', { rid: 'rad:z1' });
    expect(head).toEqual({ content_type: 'application/json', bytes: Buffer.byteLength(text) });
    expect(reads(child).map((m) => m.params)).toEqual([
      { op: 'repo_info', args: { rid: 'rad:z1' } },
    ]);
    expect(backend.callers()).toEqual({ outstanding: 1, waiting: 0 });
    expect(Buffer.from(await new Response(body).arrayBuffer()).toString('utf8')).toBe(text);
    expect(backend.callers()).toEqual({ outstanding: 0, waiting: 0 });
    expect(backend.streamStats()).toEqual({ streams: 0, buffered: 0 });
    expect(backend.collectionBudget()).toEqual({ held: 0, limit: COLLECTION_BUDGET_BYTES });
  });

  test('four maximum-size bodies with slow consumers: one ring each in main, nothing collected', async () => {
    // One buffer for the four, so the test holds 32 MiB, not 128.
    const big = Buffer.alloc(MAX_JSON, 0x20);
    const { child, node, backend } = await running((m, c) => c.readReply(m.id, big));
    const readers = [];
    for (let i = 0; i < 4; i++) {
      const { head, body } = await backend.callStream('commit', { rid: 'rad:z1', revision: 'a' });
      expect(head.bytes).toBe(MAX_JSON);
      const reader = body.getReader();
      const first = await reader.read();
      expect(first.value.byteLength).toBeLessThanOrEqual(CHUNK);
      readers.push(reader);
    }
    // Paused: the service waits for credit, and main holds a ring each.
    await settle(60);
    const { streams, buffered } = backend.streamStats();
    expect(streams).toBe(4);
    expect(buffered).toBeLessThanOrEqual(4 * RING);
    const stats = node.streamStats();
    expect(stats.ringBytes).toBe(buffered);
    // The service never got more credit than one window past what was read.
    expect(child.credited).toBeLessThanOrEqual(4 * CHUNK);
    expect(backend.callers().outstanding).toBe(4);
    expect(backend.collectionBudget().held).toBe(0);

    // One read to its end, a chunk at a time.
    let total = CHUNK;
    for (;;) {
      const { done, value } = await readers[0].read();
      if (done) break;
      expect(value.byteLength).toBeLessThanOrEqual(CHUNK);
      total += value.byteLength;
    }
    expect(total).toBe(MAX_JSON);
    // The others cancelled: `cancel` goes, the rings go, the slots come back.
    for (const reader of readers.slice(1)) await reader.cancel();
    await settle();
    const ids = reads(child).map((m) => m.id);
    expect(child.cancels).toEqual(ids.slice(1));
    expect(backend.streamStats()).toEqual({ streams: 0, buffered: 0 });
    expect(backend.callers()).toEqual({ outstanding: 0, waiting: 0 });
  }, 60_000);

  test("an abort before the head: cancelled, the service's cancel, and the slot back", async () => {
    const { child, backend } = await running();
    const controller = new AbortController();
    const call = backend.callStream('repo_info', { rid: 'rad:z1' }, { signal: controller.signal });
    await settle();
    expect(backend.callers().outstanding).toBe(1);
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: 'cancelled' });
    await settle();
    expect(child.cancels).toEqual([reads(child)[0].id]);
    expect(backend.callers()).toEqual({ outstanding: 0, waiting: 0 });
  });

  test('an abort during the body errors it and gives the slot back, read or not', async () => {
    const { child, backend } = await running((m, c) => c.readReply(m.id, Buffer.alloc(MIB, 0x20)));
    const controller = new AbortController();
    const { body } = await backend.callStream(
      'commit',
      { rid: 'rad:z1', revision: 'a' },
      { signal: controller.signal }
    );
    controller.abort();
    await settle();
    expect(backend.callers().outstanding).toBe(0);
    await expect(body.getReader().read()).rejects.toMatchObject({ code: 'cancelled' });
    expect(child.cancels).toHaveLength(1);
    expect(backend.streamStats()).toEqual({ streams: 0, buffered: 0 });
  });

  test("the service's errors keep their code and message, and give the slot back", async () => {
    const { backend } = await running((m, c) => c.error(m.id, 'not_found', 'repository not found'));
    await expect(backend.callStream('repo_info', { rid: 'rad:z1' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'repository not found',
    });
    expect(backend.callers().outstanding).toBe(0);
  });

  test("a head that isn't a JSON head is internal, its body cancelled", async () => {
    const { child, backend } = await running((m, c) => {
      // An IPFS-shaped head, its body past one window: still open.
      c.head(m.id, { status: 200, headers: [] });
      c.body(m.id, Buffer.alloc(MIB, 0x20));
    });
    await expect(backend.callStream('repo_info', { rid: 'rad:z1' })).rejects.toMatchObject({
      code: 'internal',
    });
    await settle();
    expect(child.cancels).toHaveLength(1);
    expect(backend.callers().outstanding).toBe(0);
  });

  test('with no node running, a read is stopped, and nothing is sent', async () => {
    const backend = new RadicleServiceBackend({ node: () => null });
    await expect(backend.callStream('status', {})).rejects.toMatchObject({ code: 'stopped' });
    expect(backend.callers().outstanding).toBe(0);
    // A node that hasn't started: its generation doesn't serve yet.
    const idle = new RadicledNode({ home: root, lockDir: root, ownHome: root });
    const before = new RadicleServiceBackend({ node: () => idle });
    await expect(before.callStream('status', {})).rejects.toMatchObject({ code: 'stopped' });
  });
});

describe('callScoped: the collected results', () => {
  test('the closed list, with its caps: 64 KiB, and 4 MiB for the two listings', () => {
    expect(COLLECTED_CAPS).toEqual({
      status: 64 * KIB,
      identity: 64 * KIB,
      repo_info: 64 * KIB,
      seeders: 64 * KIB,
      node_info: 64 * KIB,
      list_seeded_repos: 4 * MIB,
      list_repos: 4 * MIB,
    });
    expect(COLLECTION_BUDGET_BYTES).toBe(16 * MIB);
    expect(RESERVE_WAIT_MS).toBe(5_000);
  });

  test('each at its cap is parsed in the scope; one byte past it is too_large, its body cancelled unread, and the scope never runs', async () => {
    let size = 0;
    const { child, backend } = await running((m, c) => c.readReply(m.id, jsonOf(size)));
    for (const [op, cap] of Object.entries(COLLECTED_CAPS)) {
      size = cap;
      let held = null;
      const value = await backend.callScoped(op, {}, async (parsed) => {
        held = backend.collectionBudget().held;
        return parsed.pad.length;
      });
      expect(value).toBe(cap - '{"pad":""}'.length);
      // The text and the value parsed from it, while the scope runs.
      expect(held).toBe(2 * cap);
      expect(backend.collectionBudget().held).toBe(0);

      size = cap + 1;
      const cancels = child.cancels.length;
      const scope = jest.fn();
      await expect(backend.callScoped(op, {}, scope)).rejects.toMatchObject({ code: 'too_large' });
      expect(scope).not.toHaveBeenCalled();
      await settle();
      // Its stream retired: a body past one window is cancelled at the
      // service; a smaller one had ended, and its ring is just dropped.
      expect(child.cancels).toHaveLength(cancels + (cap + 1 > RING ? 1 : 0));
      expect(backend.streamStats()).toEqual({ streams: 0, buffered: 0 });
      expect(backend.collectionBudget().held).toBe(0);
      expect(backend.callers().outstanding).toBe(0);
    }
  }, 30_000);

  test('an op outside the closed list is refused, and nothing is sent', async () => {
    const { child, backend } = await running();
    for (const op of ['commit', 'blob_at', 'issues_page', 'repos_meta', 'tree']) {
      await expect(backend.callScoped(op, {}, async () => {})).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    }
    expect(reads(child)).toHaveLength(0);
  });

  test('the 16 MiB budget: past the cap too_large, then a call with no room waits 5 s and is busy', async () => {
    const listing = jsonOf(4 * MIB);
    const { child, backend, clock } = await running((m, c) => c.readReply(m.id, listing));
    // Two 4 MiB listings fill it: each is charged its text and its value.
    const scopes = [deferred(), deferred()];
    const held = scopes.map((scope) =>
      track(backend.callScoped('list_seeded_repos', {}, () => scope.promise))
    );
    await settle(60);
    expect(backend.collectionBudget()).toEqual({ held: 16 * MIB, limit: 16 * MIB });

    // A third: its head comes, and it waits for room, its body unread.
    const third = track(backend.callScoped('list_repos', {}, async () => 'third'));
    await settle(60);
    expect(third.settled).toBe(false);
    await clock.advance(RESERVE_WAIT_MS - 1);
    expect(third.settled).toBe(false);
    await clock.advance(1);
    expect(third.error).toMatchObject({ code: 'busy' });
    await settle();
    expect(child.cancels).toEqual([reads(child)[2].id]);
    expect(backend.collectionBudget().held).toBe(16 * MIB);

    // A call that gets room within its 5 s goes on.
    const fourth = track(backend.callScoped('list_repos', {}, async () => 'fourth'));
    await settle(60);
    await clock.advance(RESERVE_WAIT_MS - 1);
    expect(fourth.settled).toBe(false);
    scopes[0].resolve('first');
    await settle(60);
    expect(fourth.value).toBe('fourth');
    expect(held[0].value).toBe('first');

    scopes[1].resolve('second');
    await settle();
    expect(held[1].value).toBe('second');
    expect(backend.collectionBudget().held).toBe(0);
    expect(backend.callers()).toEqual({ outstanding: 0, waiting: 0 });
  }, 30_000);

  test('waiting calls are let in in the order they came', async () => {
    const listing = jsonOf(4 * MIB);
    const { backend } = await running((m, c) => c.readReply(m.id, listing));
    const order = [];
    const scopes = [deferred(), deferred()];
    for (const scope of scopes) {
      void backend.callScoped('list_seeded_repos', {}, () => scope.promise);
    }
    await settle(60);
    const waiting = ['a', 'b', 'c'].map((name) =>
      backend.callScoped('list_repos', {}, async () => order.push(name))
    );
    await settle(60);
    scopes[0].resolve();
    scopes[1].resolve();
    await Promise.all(waiting);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(backend.collectionBudget().held).toBe(0);
  }, 30_000);

  test('an aborted collect releases its bytes at once, and cancels the read', async () => {
    let read = null;
    const { child, backend } = await running((m, c) => {
      read = m;
      // Its head, and part of its body: the rest never comes.
      c.readHead(m.id, 4 * MIB);
      c.sender.push(m.id, Buffer.alloc(CHUNK, 0x20));
      c.pump();
    });
    const controller = new AbortController();
    const scope = jest.fn();
    const call = backend.callScoped('list_repos', {}, scope, { signal: controller.signal });
    await settle(60);
    expect(backend.collectionBudget().held).toBe(8 * MIB);
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: 'cancelled' });
    expect(backend.collectionBudget().held).toBe(0);
    expect(scope).not.toHaveBeenCalled();
    await settle();
    expect(child.cancels).toEqual([read.id]);
    expect(backend.callers().outstanding).toBe(0);
  });

  test('an abort while a call waits for room leaves the queue: cancelled, its read cancelled', async () => {
    const listing = jsonOf(4 * MIB);
    const { child, backend } = await running((m, c) => c.readReply(m.id, listing));
    const scopes = [deferred(), deferred()];
    for (const scope of scopes) {
      void backend.callScoped('list_seeded_repos', {}, () => scope.promise);
    }
    await settle(60);
    const controller = new AbortController();
    const waiting = backend.callScoped('list_repos', {}, async () => {}, {
      signal: controller.signal,
    });
    await settle(60);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    await settle();
    expect(child.cancels).toEqual([reads(child)[2].id]);
    expect(backend.collectionBudget().held).toBe(16 * MIB);
    for (const scope of scopes) scope.resolve();
    await settle();
    expect(backend.collectionBudget().held).toBe(0);
  }, 30_000);

  test("a paused 4 MiB scope, then aborted: its allowance stays reserved until the callback settles, and a new call can't use it", async () => {
    const listing = jsonOf(4 * MIB);
    const { backend, clock } = await running((m, c) => c.readReply(m.id, listing));
    const controller = new AbortController();
    const paused = deferred();
    let seen = null;
    const first = track(
      backend.callScoped(
        'list_seeded_repos',
        {},
        (value, { signal }) => {
          seen = { value, signal };
          return paused.promise;
        },
        { signal: controller.signal }
      )
    );
    const other = deferred();
    void backend.callScoped('list_seeded_repos', {}, () => other.promise);
    await settle(60);
    expect(backend.collectionBudget().held).toBe(16 * MIB);

    // The abort reaches the scope as its signal; the value is still its.
    controller.abort();
    await settle();
    expect(seen.signal.aborted).toBe(true);
    expect(seen.value.pad).toHaveLength(4 * MIB - '{"pad":""}'.length);
    expect(first.settled).toBe(false);
    expect(backend.collectionBudget().held).toBe(16 * MIB);

    // A new call finds no room while the callback holds the value.
    const next = track(backend.callScoped('list_repos', {}, async () => 'next'));
    await settle(60);
    await clock.advance(RESERVE_WAIT_MS - 1);
    expect(next.settled).toBe(false);

    // Settled, its allowance goes to the call that waited.
    paused.resolve('done');
    await settle(60);
    expect(first.value).toBe('done');
    expect(next.value).toBe('next');
    other.resolve();
    await settle();
    expect(backend.collectionBudget().held).toBe(0);
  }, 30_000);

  test("a scope's rejection is the call's, its bytes released; collect keeps the value", async () => {
    const { backend } = await running((m, c) => c.readReply(m.id, '{"did":"did:key:z6Mk"}'));
    await expect(
      backend.callScoped('identity', {}, async () => {
        throw new Error('the scope failed');
      })
    ).rejects.toThrow('the scope failed');
    expect(backend.collectionBudget().held).toBe(0);
    await expect(backend.collect('identity', {})).resolves.toEqual({ did: 'did:key:z6Mk' });
    expect(backend.collectionBudget().held).toBe(0);
  });

  test("a body longer or shorter than its head, or that isn't JSON, is internal, and released", async () => {
    let reply;
    const { backend } = await running((m, c) => reply(m, c));
    for (const [head, text] of [
      [2, '{"a":1}'],
      [20, '{"a":1}'],
      [3, 'nope'.slice(0, 3)],
    ]) {
      reply = (m, c) => {
        c.readHead(m.id, head);
        c.body(m.id, Buffer.from(text));
      };
      await expect(backend.callScoped('status', {}, async () => {})).rejects.toMatchObject({
        code: 'internal',
      });
      expect(backend.collectionBudget().held).toBe(0);
      expect(backend.callers().outstanding).toBe(0);
    }
  });
});

describe('other callers: 64 outstanding at the service, 64 waiting in main', () => {
  test('past 64 a call waits; past 64 waiting it is busy; a body that ends lets the next go', async () => {
    expect([MAX_OUTSTANDING, MAX_WAITING]).toEqual([64, 64]);
    const { child, backend } = await running((m, c) => c.readReply(m.id, '{"connectedPeers":0}'));
    const bodies = [];
    for (let i = 0; i < MAX_OUTSTANDING; i++) {
      bodies.push((await backend.callStream('status', {})).body);
    }
    expect(backend.callers()).toEqual({ outstanding: 64, waiting: 0 });

    const controllers = Array.from({ length: MAX_WAITING }, () => new AbortController());
    const waiting = controllers.map((controller) =>
      track(backend.callStream('status', {}, { signal: controller.signal }))
    );
    await settle();
    expect(backend.callers()).toEqual({ outstanding: 64, waiting: 64 });
    // Nothing more reached the service.
    expect(reads(child)).toHaveLength(64);
    await expect(backend.callStream('status', {})).rejects.toMatchObject({ code: 'busy' });
    await expect(backend.callScoped('status', {}, async () => {})).rejects.toMatchObject({
      code: 'busy',
    });

    // A waiter that gives up leaves the queue.
    controllers[0].abort();
    await settle();
    expect(waiting[0].error).toMatchObject({ code: 'cancelled' });
    expect(backend.callers()).toEqual({ outstanding: 64, waiting: 63 });

    // A body read to its end, and one cancelled: the next two go, in order.
    await new Response(bodies[0]).text();
    await bodies[1].cancel();
    await settle(60);
    expect(backend.callers()).toEqual({ outstanding: 64, waiting: 61 });
    expect(reads(child)).toHaveLength(66);
    expect(waiting[1].value.head.bytes).toBe(20);
    expect(waiting[2].value.head.bytes).toBe(20);
    expect(waiting[3].settled).toBe(false);

    // The rest let every waiter in, whose bodies then go too.
    for (const body of bodies.slice(2)) await body.cancel();
    await settle(60);
    expect(waiting.slice(1).every((state) => state.value)).toBe(true);
    for (const state of waiting.slice(1)) await state.value.body.cancel();
    await settle(60);
    expect(backend.callers()).toEqual({ outstanding: 0, waiting: 0 });
  }, 30_000);
});
