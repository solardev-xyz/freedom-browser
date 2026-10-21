/**
 * The profile's node on freedom-ipfsd (freedom-core design 0007, step 6),
 * against an in-process fake service on the design's frames
 * (`test/helpers/fake-ipfsd.js`) and a manual clock: today's configuration
 * sent explicitly, instance IDs and captured pairs, the head and its
 * pull-driven body, today's texts for every rejection and truncation, cancel
 * on abort, the hang watchdogs, health from `ipfs.stats`, restarts after an
 * exit and after a retired instance, and the stop. The real binary runs the
 * backend contract suite (`ipfs-backend.contract.test.js`, `ipfsd`).
 */

const path = require('path');
const { FreedomIpfsdNode, BackendBusy } = require('./freedom-ipfsd-node');
const { fakeIpfsd, statsResult, HELLO } = require('../../../test/helpers/fake-ipfsd');

const DATA_DIR = path.join('profile', 'ipfs-data', 'freedom-ipfs');
const LOCK_DIR = path.join('app-data', 'Freedom', 'locks');
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

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

let clock;
let service;
let log;
let failures;
let changes;
let node;

function newNode(script = {}) {
  service = fakeIpfsd(script);
  failures = [];
  changes = [];
  node = new FreedomIpfsdNode({
    dataDir: DATA_DIR,
    lockDir: LOCK_DIR,
    command: 'freedom-ipfsd',
    spawn: service.spawn,
    log,
    shellVersion: '0.9.0-test',
    onFailure: (reason) => failures.push(reason),
    onChange: (state) => changes.push(state),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return node;
}

async function started(script) {
  newNode(script);
  const start = node.start();
  await settle();
  expect(await start).toBe(true);
  return node;
}

const child = (n = -1) => service.children.at(n);

/** One request on what the node serves now. */
function request(init = {}, pair = node.capture()) {
  return node.request(pair, {
    path: `/ipfs/${CID}`,
    method: 'GET',
    headers: new Headers(),
    ...init,
  });
}

/** A body read to its end or error. */
async function readAll(body) {
  const reader = body.getReader();
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(parts), error: null };
      parts.push(Buffer.from(value));
    }
  } catch (error) {
    return { bytes: Buffer.concat(parts), error };
  }
}

const bytes = (length) => Buffer.from(Array.from({ length }, (_, i) => i % 251));

beforeEach(() => {
  clock = manualClock();
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

afterEach(async () => {
  const stopping = node?.stop();
  await settle();
  await clock.advance(10_000);
  await stopping;
});

describe('start', () => {
  test("spawns the persistent process and starts its instance with today's configuration", async () => {
    await started();

    expect(service.spawned).toHaveLength(1);
    const [{ command, args, options }] = service.spawned;
    expect(command).toBe('freedom-ipfsd');
    expect(args).toEqual([
      'serve',
      '--data-dir',
      DATA_DIR,
      '--lock-dir',
      LOCK_DIR,
      '--parent-pid',
      String(process.pid),
    ]);
    // The scrubbed environment: no proxy or FREEDOM_IPFS_* variables.
    expect(Object.keys(options.env).every((key) => !/proxy|^FREEDOM_IPFS/i.test(key))).toBe(true);
    const [hello, start, stats] = child().requests;
    expect(hello).toMatchObject({
      method: 'ipfs.hello',
      params: { protocol: 1, shell_version: '0.9.0-test', frames: ['stream'] },
    });
    // 0007, Parity: the values are exactly today's, sent explicitly.
    expect(start).toMatchObject({
      method: 'ipfs.start',
      params: {
        instance: 'p-1',
        store: { kind: 'disk', max_bytes: 268435456 },
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
      },
    });
    expect(stats).toMatchObject({ method: 'ipfs.stats', params: { instance: 'p-1' } });
    expect(node.state).toBe('running');
    expect(node.isHealthy()).toBe(true);
  });

  test('is running once the first stats reply has come, not at the start reply', async () => {
    let held = null;
    newNode({ stats: (message) => (held = message) });
    let result = null;
    node.start().then((value) => (result = value));
    await settle();

    expect(child().sent('ipfs.start')).toHaveLength(1);
    expect(held).not.toBeNull();
    expect(result).toBeNull();
    expect(node.isHealthy()).toBe(false);

    child().result(held.id, statsResult());
    await settle();
    expect(result).toBe(true);
    expect(node.isHealthy()).toBe(true);
  });

  test('an ipfs.start the service refuses (storage) is a failed start, with no restart', async () => {
    newNode({ start: (message, c) => c.error(message.id, 'storage', "the store won't open") });
    const start = node.start();
    await settle();

    expect(await start).toBe(false);
    expect(node.state).toBe('failed');
    expect(child().sent('ipfs.shutdown')).toHaveLength(1);
    await clock.advance(30_000);
    expect(service.children).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  test('a crash during the start is restarted, and the start still completes', async () => {
    newNode({
      start: (message, c) =>
        c === service.children[0]
          ? c.exit(1)
          : c.result(message.id, { instance: message.params.instance }),
    });
    const start = node.start();
    await settle();
    expect(service.children).toHaveLength(1);

    await clock.advance(500);
    expect(service.children).toHaveLength(2);
    expect(await start).toBe(true);
    expect(child().sent('ipfs.start')[0].params.instance).toBe('p-1');
  });

  test('a handshake from the wrong kind of process is refused', async () => {
    newNode({ hello: (message, c) => c.result(message.id, { ...HELLO, kind: 'ephemeral' }) });
    const start = node.start();
    await settle();
    expect(child(0).sent('ipfs.start')).toHaveLength(0);
    // Ended as a fault, and retried under the crash policy until it gives up.
    await clock.advance(60_000);
    expect(await start).toBe(false);
  });
});

describe('requests', () => {
  test("ipfs.request carries the plan's path, headers and headers_ms; the head is a Response", async () => {
    const body = bytes(300 * 1024);
    await started({
      request: (message, c) => {
        c.head(message.id, {
          status: 206,
          headers: [
            ['content-type', 'application/octet-stream'],
            ['content-range', `bytes 0-${body.length - 1}/${body.length}`],
          ],
        });
        c.body(message.id, body);
      },
    });

    const res = await request({
      headers: new Headers({ Range: 'bytes=0-' }),
      headersTimeoutMs: 1234,
    });

    expect(child().sent('ipfs.request')[0].params).toEqual({
      instance: 'p-1',
      method: 'GET',
      path: `/ipfs/${CID}`,
      headers: [['range', 'bytes=0-']],
      headers_ms: 1234,
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-${body.length - 1}/${body.length}`);
    const read = await readAll(res.body);
    expect(read.error).toBeNull();
    expect(read.bytes.equals(body)).toBe(true);
    // Bytes handed on went back as credit, until its end.
    expect(child().credited).toBeGreaterThan(0);
    expect(child().credited).toBeLessThanOrEqual(body.length);
  });

  test('the body is pulled on demand: a paused reader holds at most the window', async () => {
    const body = bytes(1024 * 1024);
    await started({
      request: (message, c) => {
        c.head(message.id);
        c.body(message.id, body);
      },
    });
    const res = await request();
    const reader = res.body.getReader();
    const first = await reader.read();
    await settle();

    const id = child().sent('ipfs.request')[0].id;
    const { sent, credited } = child().sender.requests.get(id).body;
    expect(credited).toBe(first.value.byteLength);
    expect(sent - credited).toBeLessThanOrEqual(128 * 1024);
    await reader.cancel();
    await settle();
    expect(child().cancels).toEqual([id]);
  });

  test('HEAD and a head without a body: a null body', async () => {
    await started({
      request: (message, c) => c.head(message.id, { status: 200, body: false }),
    });
    const res = await request({ method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  test.each([
    ['invalid_argument', 'freedom-ipfs native request could not be started'],
    ['stopped', 'freedom-ipfs native node is not running'],
    ['deadline', 'freedom-ipfs native request timeout'],
    ['internal', 'freedom-ipfs native gateway error'],
  ])("the service's %s rejects with today's text", async (code, message) => {
    await started({ request: (msg, c) => c.error(msg.id, code, 'from the service') });
    await expect(request()).rejects.toThrow(message);
  });

  test("the service's busy is BackendBusy, which the executor answers 503", async () => {
    await started({ request: (msg, c) => c.error(msg.id, 'busy', 'the memory budget') });
    const err = await request().catch((e) => e);
    expect(err).toBeInstanceOf(BackendBusy);
    expect(err.name).toBe('BackendBusy');
    expect(err.message).toBe('freedom-ipfs native node is busy');
  });

  test.each([
    ['body_stream_error', 'freedom-ipfs native read failed'],
    ['internal', 'freedom-ipfs native read failed'],
    ['busy', 'freedom-ipfs native read failed'],
    ['stopped', 'freedom-ipfs native read failed'],
    ['cancelled', 'freedom-ipfs native request cancelled'],
  ])("an abort with %s truncates the body with today's text", async (code, message) => {
    await started({
      request: (msg, c) => {
        c.head(msg.id);
        c.body(msg.id, bytes(200 * 1024), { abort: { at: 1000, code } });
      },
    });
    const res = await request();
    const { bytes: read, error } = await readAll(res.body);
    // An abort errors the body at once, dropping what it holds.
    expect(read.length).toBeLessThanOrEqual(1000);
    expect(error?.message).toBe(message);
  });

  test('an aborted signal rejects at once, and nothing is sent', async () => {
    await started();
    const controller = new AbortController();
    controller.abort();
    await expect(request({ signal: controller.signal })).rejects.toThrow(
      'freedom-ipfs native request aborted'
    );
    await settle();
    expect(child().sent('ipfs.request')).toHaveLength(0);
  });

  test('an abort before the head sends cancel, and rejects as aborted', async () => {
    await started({ request: () => {} });
    const controller = new AbortController();
    const pending = request({ signal: controller.signal });
    await settle();
    const id = child().sent('ipfs.request')[0].id;

    controller.abort();
    await expect(pending).rejects.toThrow('freedom-ipfs native request aborted');
    await settle();
    expect(child().cancels).toEqual([id]);
  });

  test('an abort mid-body sends cancel, and the body errors as cancelled', async () => {
    await started({
      request: (msg, c) => {
        c.head(msg.id);
        c.body(msg.id, bytes(1024 * 1024));
      },
    });
    const controller = new AbortController();
    const res = await request({ signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read();
    const id = child().sent('ipfs.request')[0].id;

    controller.abort();
    await settle();
    expect(child().cancels).toEqual([id]);
    await expect(reader.read()).rejects.toThrow('freedom-ipfs native request cancelled');
  });
});

describe('captured pairs', () => {
  test('a pair captured before a stop rejects as not running, and sends nothing', async () => {
    await started();
    const pair = node.capture();
    const stopping = node.stop();

    await expect(request({}, pair)).rejects.toThrow('freedom-ipfs native node is not running');
    await settle();
    await clock.advance(10_000);
    await stopping;
    expect(child().sent('ipfs.request')).toHaveLength(0);
  });

  test('a pair captured before a restart never reaches the new process', async () => {
    await started();
    const pair = node.capture();
    child().exit(1);
    await settle();
    expect(node.capture()).toBeNull();
    await clock.advance(500);
    await settle();
    expect(node.state).toBe('running');
    expect(node.capture()).not.toBeNull();

    await expect(request({}, pair)).rejects.toThrow('freedom-ipfs native node is not running');
    expect(child().sent('ipfs.request')).toHaveLength(0);
    // The new generation counts its own instances from p-1.
    expect(child().sent('ipfs.start')[0].params.instance).toBe('p-1');
  });
});

describe('crashes, hangs and restarts', () => {
  test("an exit fails what is open with 'freedom-ipfs service exited', then restarts", async () => {
    await started({
      request: (msg, c) => {
        if (msg.params.path.endsWith('/hang')) return;
        c.head(msg.id);
        c.body(msg.id, bytes(1024 * 1024));
      },
    });
    const res = await request();
    const reader = res.body.getReader();
    await reader.read();
    const head = request({ path: '/ipfs/hang' });
    await settle();

    child().exit(1);
    await settle();
    await expect(reader.read()).rejects.toThrow('freedom-ipfs service exited');
    await expect(head).rejects.toThrow('freedom-ipfs service exited');
    expect(node.state).toBe('restarting');
    expect(node.isHealthy()).toBe(false);

    await clock.advance(500);
    expect(service.children).toHaveLength(2);
    expect(node.state).toBe('running');
    expect(changes).toEqual(['restarting', 'running']);
  });

  test('a head with no reply by headers_ms + 15 s: the process is killed, and restarts', async () => {
    await started({ request: () => {} });
    const pending = request({ headersTimeoutMs: 1000 });
    await settle();

    await clock.advance(15_999);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child(0).killedWith).toBe('SIGKILL');
    await expect(pending).rejects.toThrow('freedom-ipfs service exited');
    await clock.advance(500);
    expect(service.children).toHaveLength(2);
    expect(node.state).toBe('running');
  });

  test('an ipfs.start with no reply by its 10 s + 15 s: the process is killed, and restarts', async () => {
    newNode({
      start: (message, c) => {
        if (c !== service.children[0]) c.result(message.id, { instance: message.params.instance });
      },
    });
    const start = node.start();
    await settle();
    await clock.advance(24_999);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child(0).killedWith).toBe('SIGKILL');
    await clock.advance(500);
    expect(await start).toBe(true);
    expect(service.children).toHaveLength(2);
  });

  test('an ipfs.stats with no reply within 20 s: unhealthy past 15 s, killed at 20 s', async () => {
    let hang = false;
    await started({
      stats: (msg, c) => {
        if (!hang) c.result(msg.id, statsResult());
      },
    });
    hang = true;
    await clock.advance(5_000); // the 5 s check asks, and gets nothing
    const asked = clock.now();
    await clock.advance(9_999);
    expect(node.isHealthy()).toBe(true);
    await clock.advance(1);
    // The last reply came 15 s ago.
    expect(node.isHealthy()).toBe(false);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(asked + 20_000 - clock.now());
    expect(child(0).killedWith).toBe('SIGKILL');
  });

  test('three crashes within 60 s stop the restarts, and the manager is told', async () => {
    await started();
    child().exit(1);
    await settle();
    await clock.advance(500);
    child().exit(1);
    await settle();
    await clock.advance(2_000);
    expect(service.children).toHaveLength(3);
    child().exit(1);
    await settle();
    await clock.advance(30_000);

    expect(service.children).toHaveLength(3);
    expect(node.state).toBe('failed');
    expect(failures).toEqual(['freedom-ipfs service exited']);
  });

  test('a lock held elsewhere (75) is not retried', async () => {
    newNode({ hello: (msg, c) => c.exit(75) });
    const start = node.start();
    await settle();
    await clock.advance(30_000);
    expect(await start).toBe(false);
    expect(service.children).toHaveLength(1);
  });

  test('ipfs.instance_retired: fenced at once, a crash, replaced in the same process after the back-off', async () => {
    await started();
    const pair = node.capture();

    child().event('ipfs.instance_retired', { instance: 'p-1', reason: 'panic' });
    await settle();
    expect(node.capture()).toBeNull();
    await expect(request({}, pair)).rejects.toThrow('freedom-ipfs native node is not running');
    expect(node.state).toBe('restarting');

    await clock.advance(499);
    expect(child().sent('ipfs.start')).toHaveLength(1);
    await clock.advance(1);
    expect(service.children).toHaveLength(1);
    expect(
      child()
        .sent('ipfs.start')
        .map((m) => m.params.instance)
    ).toEqual(['p-1', 'p-2']);
    expect(node.state).toBe('running');
    expect(changes).toEqual(['restarting', 'running']);

    // The second waits 2 s; the third within 60 s shuts the process down.
    child().event('ipfs.instance_retired', { instance: 'p-2', reason: 'panic' });
    await settle();
    await clock.advance(2_000);
    expect(
      child()
        .sent('ipfs.start')
        .map((m) => m.params.instance)
    ).toEqual(['p-1', 'p-2', 'p-3']);
    child().event('ipfs.instance_retired', { instance: 'p-3', reason: 'panic' });
    await settle();
    expect(child().sent('ipfs.shutdown')).toHaveLength(1);
    expect(node.state).toBe('failed');
    expect(failures).toEqual(['freedom-ipfs instance retired repeatedly']);
  });

  test("an instance_retired for an instance that isn't the live one changes nothing", async () => {
    await started();
    child().event('ipfs.instance_retired', { instance: 'p-9', reason: 'panic' });
    await settle();
    expect(node.state).toBe('running');
    expect(node.capture()).not.toBeNull();
  });
});

describe('health and diagnostics', () => {
  test("the diagnostics are the live instance's last stats reply", async () => {
    await started({
      stats: (msg, c) => c.result(msg.id, statsResult({ total_started: 7, bytes_read: 99 })),
    });

    expect(JSON.parse(node.nativeGatewayStatsJson())).toMatchObject({
      total_started: 7,
      bytes_read: 99,
    });
    expect(JSON.parse(node.progressSnapshotJson())).toMatchObject({ active: [], events: [] });
    expect(JSON.parse(node.serviceStatsJson())).toEqual({
      store: { block_count: 3, total_bytes: 1234 },
      budget: { memory: { used: 45088768, limit: 201326592 } },
    });
    expect(node.version).toBe('0.4.6');
    expect(JSON.parse(node.buildInfoJson())).toEqual({
      name: 'freedom-ipfs',
      version: '0.4.6',
      git_commit: HELLO.freedom_ipfs.git_commit,
      service: { name: 'freedom-ipfsd', version: '0.1.0', kind: 'persistent' },
    });

    child().exit(1);
    await settle();
    expect(node.nativeGatewayStatsJson()).toBe('{}');
    expect(node.progressSnapshotJson()).toBe('{"active":[],"events":[]}');
  });

  test('one stats call at a time, every 5 s', async () => {
    await started();
    expect(child().sent('ipfs.stats')).toHaveLength(1);
    node.refreshStats();
    node.refreshStats();
    await settle();
    expect(child().sent('ipfs.stats')).toHaveLength(2);
    await clock.advance(5_000);
    expect(child().sent('ipfs.stats')).toHaveLength(3);
  });
});

describe('stop', () => {
  test('retires the instance, then ipfs.shutdown alone and stdin closed', async () => {
    await started();
    const stopping = node.stop();
    expect(node.capture()).toBeNull();
    await settle();

    const methods = child().requests.map((m) => m.method);
    expect(methods.at(-1)).toBe('ipfs.shutdown');
    expect(child().sent('ipfs.stop')).toHaveLength(0);
    expect(child().stdinClosed).toBe(true);
    await stopping;
    expect(node.state).toBe('stopped');
    expect(failures).toEqual([]);
  });

  test("a service that doesn't exit after ipfs.shutdown is killed 5 s later", async () => {
    await started({ shutdown: () => {} });
    const stopping = node.stop();
    await settle();
    expect(child().sent('ipfs.shutdown')).toHaveLength(1);

    await clock.advance(4_999);
    expect(child().killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child().killedWith).toBe('SIGKILL');
    await settle();
    await stopping;
    expect(node.state).toBe('stopped');
  });
});
