/**
 * The network operations of the Radicle node on freedom-radicled
 * (freedom-core design 0008, Methods `rad.connect_seeds` and `rad.clone`,
 * Progress, deviation `progress-summary`; the radicled step-5 plan's B9):
 * a real RadicledNode on an in-process fake service (fake-radicled.js),
 * `radicle-embedded.js` on it under `FREEDOM_RADICLE_BACKEND=service`, and
 * `seed-status.js` over them, as the manager's seed paths use them.
 *
 * The fake service runs a clone as the service does: its start claims the
 * request (main's cancel reaches libradicle's token alone from then on),
 * its progress goes through the service's bounded queue, one event written
 * at a time (fake-radicled-progress.js, held to freedom-core's `queue`
 * vectors in radicle-vectors.test.js), and it answers once its queue is
 * written.
 *
 * - `connectSeeds`: today's report, as the service writes it;
 * - a clone: each `rad.progress` event parsed, in order, the terminal one
 *   last, before the clone settles; the service's errors with their codes;
 * - `cancelClone(rid)`: the cancel's timing before the clone starts, once
 *   it has started, and while it waits for a slot in main;
 * - more than 16 failed candidates with a paused reader, then a cancel: the
 *   summary counts every failure, and `cancelled` arrives last;
 * - the other callers' slots, which a network operation holds until its
 *   answer.
 *
 * The same against the real binary: radicled-network.integration.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-grant', () => ({ radicleGrantRefusal: jest.fn(() => null) }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { RadicledNode } = require('./radicled-node');
const { RadicleServiceBackend } = require('./radicle-service-backend');
const { fakeRadicled } = require('../../../test/helpers/fake-radicled');
const { MAX_ENVELOPE } = require('../../../test/helpers/fake-radicled-progress');

const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const FREEDOM_BROWSER_RID = 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE';
const NID = 'z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';

/** Lets the pipes and promises run. */
async function settle(turns = 30) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
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

/**
 * One `rad.clone` as the service runs it, which the test drives: `start()`
 * claims the request (false if main's cancel came first: answered
 * `cancelled`, nothing starts), `emit(event)` is libradicle's progress
 * callback, and `answer(result)` or `fail(code, message, data)` answers once
 * its queue is written.
 */
class CloneRun {
  constructor(message, child) {
    this.message = message;
    this.child = child;
    this.id = message.id;
    this.token = null;
  }

  get params() {
    return this.message.params;
  }

  start() {
    this.token = this.child.claim(this.id);
    return this.token !== null;
  }

  /** Whether main's cancel reached the clone's token. */
  get cancelled() {
    return Boolean(this.token?.cancelled);
  }

  get hub() {
    return this.child.progress(this.id);
  }

  emit(event) {
    if (this.params.progress) this.hub.push(event);
  }

  async answer(result) {
    await this.hub.flush();
    this.child.result(this.id, result);
  }

  async fail(code, message, data) {
    await this.hub.flush();
    const error = data === undefined ? { code, message } : { code, message, data };
    this.child.sender.reply(
      this.id,
      Buffer.from(JSON.stringify({ type: 'response', id: this.id, error }))
    );
    this.child.pump();
  }
}

/** libradicle's events for candidate `index` of `total` that fails. */
const failedCandidate = (index, total, reason = `refused ${index}`) => [
  { phase: 'connecting', nid: NID, addr: `seed${index}.example:8776`, index, total },
  { phase: 'fetching', nid: NID, index, total },
  { phase: 'peer-failed', nid: NID, index, total, reason },
];

let root;
let nodes;
let seedStatus;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-service-network-'));
  nodes = [];
  process.env.FREEDOM_RADICLE_BACKEND = 'service';
  // An add-on that must never load.
  process.env.FREEDOM_RADICLE_ADDON = path.join(os.tmpdir(), 'no-such', 'libradicle.node');
});

afterEach(async () => {
  for (const node of nodes) await node.stop();
  seedStatus?._reset();
  delete process.env.FREEDOM_RADICLE_BACKEND;
  delete process.env.FREEDOM_RADICLE_ADDON;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A running node on a fake service whose clones the test drives (`runs`)
 * and whose `rad.connect_seeds` answers `connectSeeds(message, child)`, with
 * `radicle-embedded.js` and `seed-status.js` on it, loaded afresh.
 */
async function running({ connectSeeds = null, ...script } = {}) {
  const runs = [];
  const service = fakeRadicled({
    clone: (message, child) => runs.push(new CloneRun(message, child)),
    ...(connectSeeds ? { connect_seeds: connectSeeds } : {}),
    ...script,
  });
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
  let embedded;
  let log;
  jest.isolateModules(() => {
    embedded = require('../radicle-embedded');
    seedStatus = require('./seed-status');
    log = require('../logger');
  });
  embedded.setServiceNodeSource(() => node);
  return { service, child: service.children[0], node, embedded, runs, log };
}

describe('connectSeeds: rad.connect_seeds', () => {
  test("{ timeout_ms } (15000 by default), and today's report as the service writes it", async () => {
    const report = {
      attempted: 14,
      connected: 1,
      target: 4,
      targetReached: false,
      elapsedMs: 15000,
      failures: [{ nid: NID, addr: 'café.example:8776', reason: 'café 🚀 timed out' }],
    };
    const { child, embedded } = await running({
      connectSeeds: (m, c) => c.result(m.id, report),
    });
    await expect(embedded.connectSeeds()).resolves.toEqual(report);
    await expect(embedded.connectSeeds(2500)).resolves.toEqual(report);
    expect(child.sent('rad.connect_seeds').map((m) => m.params)).toEqual([
      { timeout_ms: 15000 },
      { timeout_ms: 2500 },
    ]);
  });

  test("the service's error keeps its code and message; a report that isn't one is internal", async () => {
    let answer = (m, c) => c.error(m.id, 'failed', 'node thread: the node is not running');
    const { embedded } = await running({ connectSeeds: (m, c) => answer(m, c) });
    await expect(embedded.connectSeeds()).rejects.toMatchObject({
      code: 'failed',
      message: 'node thread: the node is not running',
    });
    answer = (m, c) => c.result(m.id, [1, 2]);
    await expect(embedded.connectSeeds()).rejects.toMatchObject({ code: 'internal' });
  });

  test('with no node running: stopped, and nothing is sent', async () => {
    const { child, embedded } = await running();
    embedded.setServiceNodeSource(() => null);
    await expect(embedded.connectSeeds()).rejects.toMatchObject({ code: 'stopped' });
    await expect(embedded.cloneRepoWithProgress(RID, 1000, () => {})).rejects.toMatchObject({
      code: 'stopped',
    });
    expect(child.sent('rad.connect_seeds')).toEqual([]);
    expect(child.sent('rad.clone')).toEqual([]);
  });
});

describe('a clone: rad.clone and its progress', () => {
  test('{ rid, timeout_ms, progress }: each event reaches the callback parsed, in order, the terminal last, before the clone settles', async () => {
    const { embedded, runs } = await running();
    const seen = [];
    const done = embedded
      .cloneRepoWithProgress(RID, 120000, (event) => seen.push(event))
      .then((result) => {
        seen.push({ settled: result });
      });
    await settle();
    const [run] = runs;
    expect(run.params).toEqual({ rid: RID, timeout_ms: 120000, progress: true });
    expect(run.start()).toBe(true);
    const events = [
      { phase: 'resolving', candidates: 2 },
      ...failedCandidate(1, 2, 'refused: "x" \\ café 🚀'),
      { phase: 'connecting', nid: NID, addr: 'seed2.example:8776', index: 2, total: 2 },
      { phase: 'fetching', nid: NID, index: 2, total: 2 },
      { phase: 'done' },
    ];
    // libradicle's pace: each event written before the next.
    for (const event of events) {
      run.emit(event);
      await settle(5);
    }
    await run.answer({ ok: true });
    await done;
    expect(seen).toEqual([...events, { settled: { ok: true } }]);
  });

  test("cloneRepo is the manager's background clone: no progress, { ok: true }, 120 s by default", async () => {
    const { embedded, runs } = await running();
    const done = embedded.cloneRepo(FREEDOM_BROWSER_RID);
    await settle();
    expect(runs[0].params).toEqual({
      rid: FREEDOM_BROWSER_RID,
      timeout_ms: 120000,
      progress: false,
    });
    runs[0].start();
    await runs[0].answer({ ok: true });
    await expect(done).resolves.toEqual({ ok: true });
  });

  test.each([
    ['failed', 'no seeds found for rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5', undefined],
    [
      'not_found',
      'fetching rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 failed: repository not found',
      undefined,
    ],
    [
      'quarantined',
      "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 is quarantined: Radicle couldn't repair it",
      { kind: 'namespace', step: null },
    ],
    ['stopped', 'the repository is being repaired', undefined],
    ['deadline', 'past its deadline', undefined],
    ['stopped', 'the Radicle service is stopping', undefined],
  ])(
    "the service's %s keeps its code and message, after the terminal event",
    async (code, message, data) => {
      const { embedded, runs } = await running();
      const seen = [];
      const done = embedded.cloneRepoWithProgress(RID, 120000, (event) => seen.push(event));
      await settle();
      runs[0].start();
      runs[0].emit({ phase: 'failed', reason: message });
      await runs[0].fail(code, message, data);
      const err = await done.catch((e) => e);
      expect(err).toMatchObject({ code, message, ...(data ? { data } : {}) });
      expect(seen).toEqual([{ phase: 'failed', reason: message }]);
    }
  );

  test('an answer that is neither { ok } nor { cancelled } is internal', async () => {
    const { embedded, runs } = await running();
    const done = embedded.cloneRepoWithProgress(RID, 120000, () => {});
    await settle();
    runs[0].start();
    await runs[0].answer({ ok: 'yes' });
    await expect(done).rejects.toMatchObject({ code: 'internal' });
  });

  test("an event that isn't JSON is logged, redacted, and dropped; the next still come", async () => {
    const { child, embedded, runs, log } = await running();
    const seen = [];
    const done = embedded.cloneRepoWithProgress(RID, 120000, (event) => seen.push(event));
    await settle();
    runs[0].start();
    child.event('rad.progress', { id: runs[0].id, event: '{"phase":' });
    runs[0].emit({ phase: 'done' });
    await runs[0].answer({ ok: true });
    await done;
    expect(seen).toEqual([{ phase: 'done' }]);
    expect(log.warn).toHaveBeenCalledWith(
      '[RadicleEmbedded] Ignoring invalid clone progress event:',
      expect.any(String)
    );
  });
});

describe("cancelClone(rid): the cancel of that RID's progress clone", () => {
  test('with no clone of the RID in flight: { cancelled: false }, and nothing is sent', async () => {
    const { child, embedded, runs } = await running();
    await expect(embedded.cancelClone(RID)).resolves.toEqual({ cancelled: false });
    // A background clone isn't found by RID, as on the add-on.
    const background = track(embedded.cloneRepo(RID));
    await settle();
    await expect(embedded.cancelClone(RID)).resolves.toEqual({ cancelled: false });
    expect(child.cancels).toEqual([]);
    runs[0].start();
    await runs[0].answer({ ok: true });
    await settle();
    expect(background.value).toEqual({ ok: true });
    // A clone that has settled is no longer found.
    const done = embedded.cloneRepoWithProgress(RID, 1000, () => {});
    await settle();
    runs[1].start();
    await runs[1].answer({ ok: true });
    await done;
    await expect(embedded.cancelClone(RID)).resolves.toEqual({ cancelled: false });
    expect(child.cancels).toEqual([]);
  });

  test("before the clone starts (queued in the service): the cancel goes at once, and the clone settles { cancelled: true } at the service's answer, nothing fetched", async () => {
    const { child, embedded, runs } = await running();
    const clone = track(embedded.cloneRepoWithProgress(RID, 120000, () => {}));
    await settle();
    expect(child.cancels).toEqual([]);
    await expect(embedded.cancelClone(RID)).resolves.toEqual({ cancelled: true });
    await settle();
    expect(child.cancels).toEqual([runs[0].id]);
    expect(clone.value).toEqual({ cancelled: true });
    // Its start finds the cancel: nothing starts.
    expect(runs[0].start()).toBe(false);
  });

  test('once it has started: the cancel goes at once, and the clone settles when it stops, with its events until then and cancelled last', async () => {
    const { child, embedded, runs } = await running();
    const order = [];
    const clone = embedded
      .cloneRepoWithProgress(RID, 120000, (event) => order.push(event.phase))
      .then((result) => {
        order.push(result);
        return result;
      });
    const settled = track(clone);
    await settle();
    const [run] = runs;
    run.start();
    run.emit({ phase: 'resolving', candidates: 3 });
    run.emit(failedCandidate(1, 3)[0]);
    await settle();
    // The cancel: answered at once, as the add-on's token flip was.
    await expect(embedded.cancelClone(RID)).resolves.toEqual({ cancelled: true });
    order.push('cancel answered');
    await settle();
    expect(child.cancels).toEqual([run.id]);
    expect(run.cancelled).toBe(true);
    // The fetch in flight finishes first: its failure still reaches main.
    expect(settled.settled).toBe(false);
    run.emit(failedCandidate(1, 3)[1]);
    run.emit(failedCandidate(1, 3)[2]);
    await settle();
    expect(settled.settled).toBe(false);
    // libradicle sees its token before the next candidate.
    run.emit({ phase: 'cancelled' });
    await run.answer({ cancelled: true });
    await expect(clone).resolves.toEqual({ cancelled: true });
    expect(order).toEqual([
      'resolving',
      'connecting',
      'cancel answered',
      'fetching',
      'peer-failed',
      'cancelled',
      { cancelled: true },
    ]);
  });

  test('a fetch that succeeds before the cancel reaches libradicle: { ok: true }, as on the add-on', async () => {
    const { embedded, runs } = await running();
    const clone = embedded.cloneRepoWithProgress(RID, 120000, () => {});
    await settle();
    runs[0].start();
    await embedded.cancelClone(RID);
    runs[0].emit({ phase: 'done' });
    await runs[0].answer({ ok: true });
    await expect(clone).resolves.toEqual({ ok: true });
  });

  test('two progress clones of a RID: the cancel reaches both', async () => {
    const { child, embedded, runs } = await running();
    const first = embedded.cloneRepoWithProgress(RID, 120000, () => {});
    const second = embedded.cloneRepoWithProgress(RID, 120000, () => {});
    await settle();
    for (const run of runs) run.start();
    await expect(embedded.cancelClone(RID)).resolves.toEqual({ cancelled: true });
    await settle();
    expect(child.cancels.sort()).toEqual(runs.map((run) => run.id).sort());
    for (const run of runs) {
      run.emit({ phase: 'cancelled' });
      await run.answer({ cancelled: true });
    }
    await expect(first).resolves.toEqual({ cancelled: true });
    await expect(second).resolves.toEqual({ cancelled: true });
    await expect(embedded.cancelClone(RID)).resolves.toEqual({ cancelled: false });
  });

  test('more than 16 failed candidates with a paused reader, then a cancel: the summary counts every failure, and cancelled arrives last', async () => {
    // A stdout that holds one byte before a write waits for main to read.
    const { child, embedded, runs } = await running({ stdoutHighWaterMark: 1 });
    const statuses = [];
    const events = [];
    const fetch = seedStatus.startFetch(RID, {
      fetchRepo: (rid, onProgress) =>
        embedded.cloneRepoWithProgress(rid, 120000, (event) => {
          events.push(event);
          onProgress(event);
        }),
      onStatus: (status) => statuses.push(status),
    });
    await settle();
    const [run] = runs;
    run.start();
    const TOTAL = 21;
    run.emit({ phase: 'resolving', candidates: TOTAL });
    await settle();
    expect(events).toEqual([{ phase: 'resolving', candidates: TOTAL }]);

    // Main stops reading: what the service writes waits in the pipe, and
    // what libradicle emits meanwhile waits in the clone's queue.
    child.stdout.pause();
    const FAILED = 20;
    for (let index = 1; index <= FAILED; index += 1) {
      for (const event of failedCandidate(index, TOTAL)) run.emit(event);
    }
    run.emit({
      phase: 'connecting',
      nid: NID,
      addr: 'seed21.example:8776',
      index: 21,
      total: TOTAL,
    });
    await settle();
    expect(events).toHaveLength(1);

    // The cancel still goes, while main reads nothing.
    await expect(embedded.cancelClone(RID)).resolves.toEqual({ cancelled: true });
    await settle();
    expect(child.cancels).toEqual([run.id]);
    expect(run.cancelled).toBe(true);
    // libradicle sees its token before the 21st fetch, and the clone answers
    // once its queue is written: not before main reads again.
    run.emit({ phase: 'cancelled' });
    const answered = run.answer({ cancelled: true });
    await settle();
    expect(events).toHaveLength(1);
    expect(statuses.at(-1).state).toBe('fetching');

    child.stdout.resume();
    await answered;
    await fetch.done;

    // Main got exactly what the service wrote, in order: the queue's bounds
    // held what it couldn't write (one event in the pipe, one latest phase,
    // 8 failures and one summary, then the terminal).
    const written = run.hub.written.map((text) => JSON.parse(JSON.parse(text).data.event));
    expect(events).toEqual(written);
    expect(run.hub.written.length).toBeLessThanOrEqual(1 + 1 + 1 + 8 + 1 + 1);
    for (const text of run.hub.written) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_ENVELOPE);
    }
    const failures = events.filter((event) => event.phase === 'peer-failed');
    const summaries = failures.filter((event) => event.summary);
    expect(summaries).toHaveLength(1);
    expect(failures.length - summaries.length + summaries[0].summary.count).toBe(FAILED);
    expect(summaries[0].summary.reasons).toEqual([
      'refused 17',
      'refused 18',
      'refused 19',
      'refused 20',
    ]);
    expect(events.at(-1)).toEqual({ phase: 'cancelled' });

    // seed-status counted them all, and its last status is the cancel.
    const counted = statuses.filter((s) => s.progress?.phase === 'peer-failed');
    expect(
      counted.reduce(
        (sum, s) => sum + (Number.isInteger(s.progress.count) ? s.progress.count : 1),
        0
      )
    ).toBe(FAILED);
    expect(statuses.at(-2)).toMatchObject({ state: 'fetching', progress: { phase: 'cancelled' } });
    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', progress: { phase: 'cancelled' } });
    expect(statuses.at(-1).recentAttempts.map((a) => a.error)).toEqual([
      'refused 8',
      'refused 17',
      'refused 18',
      'refused 19',
      'refused 20',
    ]);
  });
});

describe("the other callers' slots (0008, Main's side)", () => {
  /** A backend on `node` with `max` slots and none waiting past `waiting`. */
  const backendOn = (node, max = 1, waiting = 64) =>
    new RadicleServiceBackend({ node: () => node, maxOutstanding: max, maxWaiting: waiting });

  test('a network operation holds one until its answer; a read waits behind it', async () => {
    const reads = [];
    const { child, node, runs } = await running({ read: (m) => reads.push(m) });
    const backend = backendOn(node);
    const clone = backend.cloneRepoWithProgress(RID, 120000, () => {});
    await settle();
    expect(backend.callers()).toEqual({ outstanding: 1, waiting: 0 });
    const read = backend.callStream('status', {});
    await settle();
    expect(backend.callers()).toEqual({ outstanding: 1, waiting: 1 });
    expect(reads).toEqual([]);
    runs[0].start();
    await runs[0].answer({ ok: true });
    await expect(clone).resolves.toEqual({ ok: true });
    await settle();
    expect(reads).toHaveLength(1);
    child.readReply(reads[0].id, '{"version":"x"}');
    const { body } = await read;
    await new Response(body).text();
    expect(backend.callers()).toEqual({ outstanding: 0, waiting: 0 });
  });

  test('a clone waiting for a slot, cancelled: never sent, and { cancelled: true } at once', async () => {
    const seeds = [];
    const { child, node } = await running({ connectSeeds: (m) => seeds.push(m) });
    const backend = backendOn(node);
    const connect = backend.connectSeeds(15000);
    const clone = track(backend.cloneRepoWithProgress(RID, 120000, () => {}));
    await settle();
    expect(backend.callers()).toEqual({ outstanding: 1, waiting: 1 });
    expect(backend.cancelClone(RID)).toEqual({ cancelled: true });
    await settle();
    expect(clone.value).toEqual({ cancelled: true });
    expect(backend.callers()).toEqual({ outstanding: 1, waiting: 0 });
    expect(child.sent('rad.clone')).toEqual([]);
    child.result(seeds[0].id, {
      attempted: 0,
      connected: 0,
      target: 0,
      targetReached: true,
      elapsedMs: 0,
      failures: [],
    });
    await connect;
    expect(backend.callers()).toEqual({ outstanding: 0, waiting: 0 });
  });

  test('past the waiting bound, a network operation is busy at once', async () => {
    const { node } = await running({ connectSeeds: () => {} });
    const backend = backendOn(node, 1, 0);
    void backend.connectSeeds(15000).catch(() => {});
    await settle();
    await expect(backend.cloneRepo(RID, 1000)).rejects.toMatchObject({ code: 'busy' });
  });

  test("a clone the service ends (its stop) gives its slot back with the service's error", async () => {
    const { node, runs } = await running();
    const backend = backendOn(node);
    const clone = backend.cloneRepoWithProgress(RID, 120000, () => {});
    await settle();
    runs[0].start();
    await runs[0].fail('stopped', 'the Radicle service is stopping');
    await expect(clone).rejects.toMatchObject({ code: 'stopped' });
    expect(backend.callers()).toEqual({ outstanding: 0, waiting: 0 });
    expect(backend.cancelClone(RID)).toEqual({ cancelled: false });
  });
});
