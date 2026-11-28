/**
 * Subscriptions on the core's backend (freedom-core design 0015, Messaging
 * and SWM-4's D16; SWM-7's PR 7.3): main's `shell.swarm_subscribe` and
 * `shell.swarm_unsubscribe` (core/swarm-shell.js), and question 4's route
 * test in `shell.swarm_ready`'s `subscribe` check and just before the open.
 * Through a real CoreClient against a scripted core
 * (test/helpers/fake-swarm-core.js), with the real subscription registry
 * and messaging-service's real socket, a spy on the `WebSocket`
 * constructor, and the session's `resolveProxy` scripted:
 * - a node behind a proxy: the ready check `proxy-or-tor`, undialled; a
 *   proxy that comes on between the check and the open: `{ failed: {
 *   reason: "proxy-or-tor", message } }` and no socket;
 * - `{ id }` once open, bound to the parent's document, on its node;
 * - D16: the core's cancel or the parent's end while it opens closes it (a
 *   late `{ id }` is never sent); a crossed recheck's close answered `{}`
 *   at once, the subscription closed before the core answers `NO_ADDRESS`;
 * - the strict readers and the rules, each refusal a core fault.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
const mockRegistry = { url: null };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => ({ mode: 'external' }),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => null }));
jest.mock('./dweb-verify', () => ({ dwebVerifier: () => null }));
jest.mock('./naming', () => ({ namingDriver: () => null }));
jest.mock('../swarm/gsoc-miner', () => ({ mineSigner: jest.fn(), joinJob: jest.fn() }));

const { ShellError } = require('./core-client');
const { SwarmShell } = require('./swarm-shell');
const { topicOf } = require('./swarm-grammar');
const registry = require('../swarm/subscription-registry');
const { openSubscriptionSocket } = require('../swarm/messaging-service');
const { parentOf, sleep, startSwarmCore, until } = require('../../../test/helpers/fake-swarm-core');

const KEY = 'https://app.example';
const REMOTE = 'https://ant.example';
const ARTI = '127.0.0.1:19150';
const TOPIC = 'room:lobby';
const TOPIC_HEX = topicOf(TOPIC);
const ADDRESS = 'ab'.repeat(32);
const PSS = { kind: 'pss', topic: TOPIC };
const NO_ADDRESS = { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } };

function quietLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** Node's WebSocket, as messaging-service drives it. */
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = [];
    FakeWebSocket.made.push(this);
  }
  close(code) {
    this.closed.push(code);
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(text) {
    const bytes = Buffer.from(text);
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}
FakeWebSocket.made = [];

/** A node that answers `GET /node`, recording each dial. */
function node(url = REMOTE) {
  const out = { dials: [] };
  out.backend = {
    ref: { ant: 'external', up: true },
    url,
    request: jest.fn(async (init) => {
      out.dials.push(init);
      return new Response('{}', { status: 200 });
    }),
  };
  return out;
}

function subscriber(document = '7:1') {
  return { document, deliverTo: jest.fn(async () => ({ ok: true })) };
}

let WebSocketSpy;
let proxy;
let refused;

beforeEach(() => {
  registry._reset();
  FakeWebSocket.made = [];
  WebSocketSpy = jest.fn((url) => new FakeWebSocket(url));
  global.WebSocket = WebSocketSpy;
  proxy = 'DIRECT';
  refused = [];
  mockRegistry.url = REMOTE;
  registry.configure({
    openSocket: openSubscriptionSocket,
    deliver: (subscription, payload) => subscription.deliverTo(payload),
    maxSubscriptionsPerOrigin: 32,
    route: {
      nodeUrl: () => mockRegistry.url,
      resolveProxy: jest.fn(async () => proxy),
      torEndpoint: () => ARTI,
    },
    onRefused: (event) => refused.push(event),
  });
});

afterEach(() => {
  registry._reset();
  delete global.WebSocket;
});

describe('through the client: question 4 and D16', () => {
  let harness;
  let core;

  beforeEach(async () => {
    harness = await startSwarmCore({
      log: quietLog(),
      deps: { backendKind: () => 'core', nodeUrl: () => REMOTE },
    });
    core = harness.core();
  });

  afterEach(async () => {
    await harness.client.stop();
  });

  /** A `subscribe` parent, open in the shell, its ready check asked and answered. */
  async function readyParent({ params = PSS, sub = subscriber(), at = node(), capture = {} } = {}) {
    const parent = parentOf(harness.client, harness.shell, {
      row: 'subscribe',
      params,
      key: KEY,
      backend: at.backend,
      subscriber: sub,
      ...capture,
    });
    await until(() => parent.handle || parent.error, 'the parent');
    const ready = core.ready(parent.id, 'subscribe');
    await until(() => core.reply(ready), 'the ready answer');
    return { parent, ready: core.reply(ready), sub, at };
  }

  /** Asks `shell.swarm_subscribe`, and lets its socket establish once it is made. */
  async function opened(parent, key = TOPIC_HEX, kind = 'pss') {
    const ask = core.ask('shell.swarm_subscribe', { for: parent.id, kind, key });
    await until(() => WebSocketSpy.mock.calls.length > 0, 'the socket');
    FakeWebSocket.made[0].open();
    await until(() => core.reply(ask), 'the subscribe answer', 3000);
    return { ask, reply: core.reply(ask) };
  }

  test('a remote node behind a proxy: the ready check is proxy-or-tor, undialled, and reported', async () => {
    proxy = 'PROXY proxy.example:8080';
    const { ready, at } = await readyParent();
    expect(ready.result).toEqual({ ok: false, reason: 'proxy-or-tor' });
    expect(at.dials).toHaveLength(0);
    expect(refused).toEqual([{ origin: KEY, via: 'proxy', ended: false }]);
  });

  test("behind Arti's endpoint, and an onion node: the same", async () => {
    proxy = `SOCKS5 ${ARTI}`;
    const tor = await readyParent();
    expect(tor.ready.result).toEqual({ ok: false, reason: 'proxy-or-tor' });
    proxy = 'DIRECT';
    const onion = await readyParent({ at: node('http://abcdefghijklmnop.onion') });
    expect(onion.ready.result).toEqual({ ok: false, reason: 'proxy-or-tor' });
    expect(tor.at.dials).toHaveLength(0);
    expect(onion.at.dials).toHaveLength(0);
    expect(refused.map((event) => event.via)).toEqual(['tor', 'tor']);
  });

  test('a loopback node still subscribes with a proxy on', async () => {
    proxy = 'PROXY proxy.example:8080';
    const { parent, ready, at } = await readyParent({ at: node('http://127.0.0.1:1633') });
    expect(ready.result).toEqual({ ok: true });
    expect(at.dials.map((dial) => dial.path)).toEqual(['/node']);
    const { reply } = await opened(parent);
    expect(reply.result).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(FakeWebSocket.made[0].url).toBe(`ws://127.0.0.1:1633/pss/subscribe/${TOPIC_HEX}`);
  });

  test("{ id } once open, on the parent's node, its messages to the parent's document", async () => {
    const { parent, ready, sub } = await readyParent();
    expect(ready.result).toEqual({ ok: true });
    const { reply } = await opened(parent);
    expect(reply.result).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(FakeWebSocket.made[0].url).toBe(`wss://ant.example/pss/subscribe/${TOPIC_HEX}`);
    expect(registry.countByOrigin(KEY)).toBe(1);
    FakeWebSocket.made[0].message('hello');
    expect(sub.deliverTo).toHaveBeenCalledTimes(1);
    expect(Buffer.from(sub.deliverTo.mock.calls[0][0]).toString()).toBe('hello');
    // The document's end ends it, as any page subscription's.
    registry.cancelByDocument(sub.document);
    expect(FakeWebSocket.made[0].closed).toEqual([1000]);
  });

  test('checked again just before the open: a proxy that came on refuses, and no socket is made', async () => {
    const { parent, ready } = await readyParent();
    expect(ready.result).toEqual({ ok: true });
    proxy = 'PROXY proxy.example:8080';
    const ask = core.ask('shell.swarm_subscribe', { for: parent.id, kind: 'pss', key: TOPIC_HEX });
    await until(() => core.reply(ask), 'the subscribe answer');
    expect(core.reply(ask).result).toEqual({
      failed: { reason: 'proxy-or-tor', message: 'Node not available: proxy-or-tor' },
    });
    expect(WebSocketSpy).not.toHaveBeenCalled();
    expect(registry.countByOrigin(KEY)).toBe(0);
    expect(refused).toEqual([{ origin: KEY, via: 'proxy', ended: false }]);
  });

  test('a proxy that comes on ends the open subscription, with no reconnect', async () => {
    const { parent } = await readyParent();
    await opened(parent);
    proxy = 'PROXY proxy.example:8080';
    await registry.recheckRoutes();
    expect(registry.countByOrigin(KEY)).toBe(0);
    expect(FakeWebSocket.made[0].closed).toEqual([1000]);
    FakeWebSocket.made[0].onclose?.({ code: 1000, reason: '' });
    await sleep(1200);
    expect(WebSocketSpy).toHaveBeenCalledTimes(1);
    expect(refused).toEqual([{ origin: KEY, via: 'proxy', ended: true }]);
  });

  test("D16's late { id }: the core's cancel while it opens closes it, and only `cancelled` goes", async () => {
    const { parent } = await readyParent();
    const ask = core.ask('shell.swarm_subscribe', { for: parent.id, kind: 'pss', key: TOPIC_HEX });
    await until(() => WebSocketSpy.mock.calls.length > 0, 'the socket');
    core.cancel(ask);
    await until(() => core.reply(ask), 'the cancel answer');
    expect(core.reply(ask).error).toMatchObject({ code: 'cancelled' });
    expect(FakeWebSocket.made[0].closed).toEqual([1000]);
    expect(registry.countByOrigin(KEY)).toBe(0);
    // The socket opening after it changes nothing: no second answer.
    FakeWebSocket.made[0].open();
    await sleep(700);
    expect(core.messages.filter((m) => m?.type === 'response' && m.id === ask)).toHaveLength(1);
    expect(registry.countByOrigin(KEY)).toBe(0);
  });

  test("D16's late { id }: the parent's end while it opens closes it; the answer waits for the core's cancel", async () => {
    const controller = new AbortController();
    const { parent } = await readyParent({ capture: { signal: controller.signal } });
    const ask = core.ask('shell.swarm_subscribe', { for: parent.id, kind: 'pss', key: TOPIC_HEX });
    await until(() => WebSocketSpy.mock.calls.length > 0, 'the socket');
    controller.abort();
    await until(() => FakeWebSocket.made[0].closed.length > 0, 'the close');
    expect(registry.countByOrigin(KEY)).toBe(0);
    await sleep(20);
    expect(core.reply(ask)).toBeUndefined();
    // The core reads main's cancel of the parent, and cancels its open.
    expect(core.messages.some((m) => m?.type === 'cancel' && m.id === parent.id)).toBe(true);
    core.cancel(ask);
    await until(() => core.reply(ask), 'the cancel answer');
    expect(core.reply(ask).error).toMatchObject({ code: 'cancelled' });
  });

  test('a crossed recheck: the close is answered {} at once and closes it, before the core answers NO_ADDRESS', async () => {
    const { parent, sub } = await readyParent();
    const { reply } = await opened(parent);
    const close = core.ask('shell.swarm_unsubscribe', { id: reply.result.id });
    // Answered with the client's clock never moved: well within D13's 60 s.
    await until(() => core.reply(close), 'the close answer', 1000);
    expect(core.reply(close).result).toEqual({});
    expect(FakeWebSocket.made[0].closed).toEqual([1000]);
    expect(registry.countByOrigin(KEY)).toBe(0);
    FakeWebSocket.made[0].message('after');
    expect(sub.deliverTo).not.toHaveBeenCalled();
    core.respond(parent.id, { error: NO_ADDRESS });
    expect(await parent.answered).toEqual({ error: NO_ADDRESS });
    // A second close of the same id: already gone, still {}.
    const again = core.ask('shell.swarm_unsubscribe', { id: reply.result.id });
    await until(() => core.reply(again), 'the second close answer', 1000);
    expect(core.reply(again).result).toEqual({});
  });

  test("a close of a subscription this connection didn't open (a JS page's) closes nothing, and answers {}", async () => {
    const pending = registry.subscribe({
      origin: KEY,
      document: '9:1',
      deliverTo: jest.fn(),
      kind: 'gsoc',
      key: ADDRESS,
      nodeUrl: 'http://127.0.0.1:1633',
    });
    await until(() => WebSocketSpy.mock.calls.length > 0, 'the socket');
    FakeWebSocket.made[0].open();
    const { subscriptionId } = await pending;
    for (const id of [subscriptionId, 'nope']) {
      const close = core.ask('shell.swarm_unsubscribe', { id });
      await until(() => core.reply(close), 'the close answer', 1000);
      expect(core.reply(close).result).toEqual({});
    }
    expect(registry.countByOrigin(KEY)).toBe(1);
    expect(FakeWebSocket.made[0].closed).toEqual([]);
  });
});

describe('the readers and the rules (direct)', () => {
  let nextId = 1;
  const log = quietLog();

  function shell(deps = {}) {
    return new SwarmShell({
      log,
      backendKind: () => 'core',
      nodeUrl: () => REMOTE,
      subscribeCheck: async () => null,
      ...deps,
    });
  }

  function ctx(generation = 1) {
    const controller = new AbortController();
    return { signal: controller.signal, controller, generation };
  }

  async function outcome(pending) {
    try {
      return { result: await pending };
    } catch (err) {
      if (err instanceof ShellError && err.code === 'invalid_argument') return { rule: err.data.rule };
      throw err;
    }
  }

  function parent(s, row = 'subscribe', params = PSS, capture = {}) {
    const id = nextId++;
    s.open({ generation: 1, id }, { row, params, key: KEY, backend: node().backend, subscriber: subscriber(), ...capture });
    return id;
  }

  async function readied(s, params = PSS) {
    const id = parent(s, 'subscribe', params);
    expect(await s.ready({ for: id, check: 'subscribe' }, ctx())).toEqual({ ok: true });
    return id;
  }

  test.each([
    ['not an object', null],
    ['a member missing', { for: 1, kind: 'pss' }],
    ['an unknown member', { for: 1, kind: 'pss', key: TOPIC_HEX, x: 1 }],
    ['no ID', { for: 0, kind: 'pss', key: TOPIC_HEX }],
    ['another kind', { for: 1, kind: 'feed', key: TOPIC_HEX }],
    ['a key in capitals', { for: 1, kind: 'pss', key: TOPIC_HEX.toUpperCase() }],
    ['a short key', { for: 1, kind: 'pss', key: 'ab' }],
  ])('shell.swarm_subscribe read strictly: %s is form', async (_label, params) => {
    expect(await outcome(shell().subscribe(params, ctx()))).toEqual({ rule: 'form' });
  });

  test('the rules: ended, form, order, value, count', async () => {
    const s = shell();
    // A parent never sent: a core fault.
    expect(await outcome(s.subscribe({ for: 999_999, kind: 'pss', key: TOPIC_HEX }, ctx()))).toEqual({ rule: 'ended' });
    // Another row's parent.
    const chunk = parent(s, 'readChunk', { reference: ADDRESS });
    expect(await outcome(s.subscribe({ for: chunk, kind: 'pss', key: TOPIC_HEX }, ctx()))).toEqual({ rule: 'form' });
    // Before its ready check, or after one that failed.
    const early = parent(s);
    expect(await outcome(s.subscribe({ for: early, kind: 'pss', key: TOPIC_HEX }, ctx()))).toEqual({ rule: 'order' });
    const refusing = shell({ subscribeCheck: async () => 'proxy-or-tor' });
    const refused = parent(refusing);
    expect(await refusing.ready({ for: refused, check: 'subscribe' }, ctx())).toEqual({ ok: false, reason: 'proxy-or-tor' });
    expect(await outcome(refusing.subscribe({ for: refused, kind: 'pss', key: TOPIC_HEX }, ctx()))).toEqual({ rule: 'order' });
    // Another kind, or another key than the params give.
    const pssKind = await readied(s);
    expect(await outcome(s.subscribe({ for: pssKind, kind: 'gsoc', key: TOPIC_HEX }, ctx()))).toEqual({ rule: 'value' });
    const pssKey = await readied(s);
    expect(await outcome(s.subscribe({ for: pssKey, kind: 'pss', key: ADDRESS }, ctx()))).toEqual({ rule: 'value' });
    const gsoc = await readied(s, { kind: 'gsoc', address: ADDRESS.toUpperCase() });
    expect(await outcome(s.subscribe({ for: gsoc, kind: 'gsoc', key: 'cd'.repeat(32) }, ctx()))).toEqual({ rule: 'value' });
    // A refused parent refuses what follows.
    expect(await outcome(s.subscribe({ for: gsoc, kind: 'gsoc', key: ADDRESS }, ctx()))).toEqual({ rule: 'ended' });
  });

  test('once: a second shell.swarm_subscribe is count', async () => {
    const opens = [];
    const subscriptions = {
      subscribe: jest.fn(async (args) => {
        opens.push(args);
        return { subscriptionId: `s${opens.length}` };
      }),
      cancelById: jest.fn(),
      cancelByOpener: jest.fn(),
    };
    const s = shell({ subscriptions: () => subscriptions });
    const gsoc = await readied(s, { kind: 'gsoc', address: ADDRESS.toUpperCase() });
    expect(await outcome(s.subscribe({ for: gsoc, kind: 'gsoc', key: ADDRESS }, ctx()))).toEqual({ result: { id: 's1' } });
    expect(opens[0]).toMatchObject({
      origin: KEY,
      document: '7:1',
      kind: 'gsoc',
      key: ADDRESS,
      nodeUrl: REMOTE,
      opener: 'core:1',
      signal: expect.any(AbortSignal),
    });
    expect(await outcome(s.subscribe({ for: gsoc, kind: 'gsoc', key: ADDRESS }, ctx()))).toEqual({ rule: 'count' });
    // A GSOC topic's key is the core's mined address, which main takes.
    const topic = await readied(s, { kind: 'gsoc', topic: TOPIC });
    expect(await outcome(s.subscribe({ for: topic, kind: 'gsoc', key: 'ef'.repeat(32) }, ctx()))).toEqual({ result: { id: 's2' } });
  });

  test("the registry's failure is { failed: { reason?, message } }, its text bounded", async () => {
    const errors = [
      Object.assign(new Error('Origin has reached the maximum of 32 subscriptions'), { reason: 'too_many_subscriptions' }),
      new Error('x'.repeat(5000)),
      new Error(''),
    ];
    const subscriptions = {
      subscribe: jest.fn(async () => {
        throw errors.shift();
      }),
    };
    const s = shell({ subscriptions: () => subscriptions });
    const answers = [];
    for (let i = 0; i < 3; i++) {
      const id = await readied(s);
      answers.push((await outcome(s.subscribe({ for: id, kind: 'pss', key: TOPIC_HEX }, ctx()))).result);
    }
    expect(answers[0]).toEqual({
      failed: { reason: 'too_many_subscriptions', message: 'Origin has reached the maximum of 32 subscriptions' },
    });
    expect(answers[1]).toEqual({ failed: { message: 'x'.repeat(1024) } });
    expect(answers[2]).toEqual({ failed: { message: 'Subscription failed' } });
  });

  test('a parent with no document fails its open; a subscriber is a document and its delivery', async () => {
    const s = shell();
    const id = nextId++;
    s.open({ generation: 1, id }, { row: 'subscribe', params: PSS, key: KEY, backend: node().backend });
    expect(await s.ready({ for: id, check: 'subscribe' }, ctx())).toEqual({ ok: true });
    expect(await outcome(s.subscribe({ for: id, kind: 'pss', key: TOPIC_HEX }, ctx()))).toEqual({
      result: { failed: { message: 'The subscription has no document' } },
    });
    expect(() =>
      s.open({ generation: 1, id: nextId++ }, { row: 'subscribe', params: PSS, backend: node().backend, subscriber: { document: '1:1' } })
    ).toThrow(TypeError);
  });

  test('a parent that has ended waits for the cancel', async () => {
    const s = shell();
    const ended = new AbortController();
    const id = parent(s, 'subscribe', PSS, { signal: ended.signal });
    ended.abort();
    const c = ctx();
    let settled = false;
    const pending = s.subscribe({ for: id, kind: 'pss', key: TOPIC_HEX }, c).then(() => {
      settled = true;
    });
    await sleep(10);
    expect(settled).toBe(false);
    c.controller.abort();
    await pending;
    expect(settled).toBe(true);
  });

  test('shell.swarm_unsubscribe: read strictly, closes only its own connection\'s, answers {}', async () => {
    const subscriptions = { cancelByOpener: jest.fn(() => true) };
    const s = shell({ subscriptions: () => subscriptions });
    for (const params of [null, {}, { id: '' }, { id: 1 }, { id: 'a', for: 1 }]) {
      expect(await outcome(Promise.resolve().then(() => s.unsubscribe(params, ctx())))).toEqual({ rule: 'form' });
    }
    expect(s.unsubscribe({ id: 's1' }, ctx(3))).toEqual({});
    expect(subscriptions.cancelByOpener).toHaveBeenCalledWith('core:3', 's1');
  });
});
