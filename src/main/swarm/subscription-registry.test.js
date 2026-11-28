const registry = require('./subscription-registry');

function makeSocketFactory() {
  const opened = [];
  const openSocket = jest.fn((target, handlers) => {
    let resolveEstablished;
    let rejectEstablished;
    const handle = {
      target,
      handlers,
      cancel: jest.fn(),
      established: new Promise((resolve, reject) => {
        resolveEstablished = resolve;
        rejectEstablished = reject;
      }),
    };
    handle.resolveEstablished = resolveEstablished;
    handle.rejectEstablished = rejectEstablished;
    opened.push(handle);
    return handle;
  });
  return { openSocket, opened };
}

describe('subscription-registry', () => {
  let openSocket;
  let opened;
  let deliver;

  const GSOC_KEY = 'ab'.repeat(32);

  beforeEach(() => {
    registry._reset();
    ({ openSocket, opened } = makeSocketFactory());
    deliver = jest.fn();
    registry.configure({ openSocket, deliver, maxSubscriptionsPerOrigin: 3, establishTimeoutMs: 5000 });
  });

  async function subscribeEstablished(params) {
    const promise = registry.subscribe(params);
    opened[opened.length - 1].resolveEstablished();
    return promise;
  }

  test('subscribe opens a socket and resolves once established', async () => {
    const promise = registry.subscribe({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
    expect(openSocket).toHaveBeenCalledWith({ kind: 'gsoc', key: GSOC_KEY }, expect.any(Object));

    opened[0].resolveEstablished();
    const { subscriptionId } = await promise;
    expect(typeof subscriptionId).toBe('string');
    expect(subscriptionId).toHaveLength(32);
  });

  test('multiplexes: same (kind, key) shares one socket, distinct keys open their own', async () => {
    const first = registry.subscribe({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
    opened[0].resolveEstablished();
    await first;
    await registry.subscribe({ origin: 'b.eth', document: '2:1', kind: 'gsoc', key: GSOC_KEY });
    expect(openSocket).toHaveBeenCalledTimes(1);

    await subscribeEstablished({ origin: 'a.eth', document: '1:1', kind: 'pss', key: GSOC_KEY });
    expect(openSocket).toHaveBeenCalledTimes(2);
  });

  test('fans a payload out to every subscription on the socket', async () => {
    const { subscriptionId: subA } = await subscribeEstablished({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
    const { subscriptionId: subB } = await registry.subscribe({ origin: 'b.eth', document: '2:1', kind: 'gsoc', key: GSOC_KEY });

    const payload = Buffer.from('hello');
    opened[0].handlers.onMessage(payload);

    expect(deliver).toHaveBeenCalledTimes(2);
    const deliveredIds = deliver.mock.calls.map(([sub]) => sub.id).sort();
    expect(deliveredIds).toEqual([subA, subB].sort());
    expect(deliver.mock.calls[0][1]).toBe(payload);
    expect(deliver.mock.calls[0][0]).toMatchObject({ kind: 'gsoc', key: GSOC_KEY });
  });

  test('does not fan out to a subscription that has not established yet', async () => {
    const pending = registry.subscribe({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });

    // A message arriving before establishment has no id the page could
    // correlate it with, and the page may already be gone.
    opened[0].handlers.onMessage(Buffer.from('early'));
    expect(deliver).not.toHaveBeenCalled();

    opened[0].resolveEstablished();
    await pending;

    opened[0].handlers.onMessage(Buffer.from('late'));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1].toString()).toBe('late');
  });

  test('gives up on an establishment that never settles and releases the slot', async () => {
    jest.useFakeTimers();
    try {
      registry.configure({ openSocket, deliver, maxSubscriptionsPerOrigin: 3, establishTimeoutMs: 100 });
      // The socket layer reconnects forever, so `established` never settles.
      const promise = registry.subscribe({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
      const assertion = expect(promise).rejects.toMatchObject({ reason: 'establish_timeout' });

      jest.advanceTimersByTime(100);
      await assertion;
    } finally {
      jest.useRealTimers();
    }

    // Slot released and the socket closed — the origin is not bricked.
    expect(registry.countByOrigin('a.eth')).toBe(0);
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);
  });

  test('a subscription cancelled while establishing never reaches the page', async () => {
    const promise = registry.subscribe({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });

    // The origin's messaging grant was revoked mid-establishment.
    registry.cancelByOrigin('a.eth');
    opened[0].resolveEstablished();

    await expect(promise).rejects.toMatchObject({ reason: 'subscription_cancelled' });
    expect(registry.countByOrigin('a.eth')).toBe(0);
  });

  test('carries the subscribing origin and document through to the deliverer', async () => {
    const deliverTo = jest.fn();
    await subscribeEstablished({
      origin: 'a.eth',
      document: '1:1',
      deliverTo,
      kind: 'gsoc',
      key: GSOC_KEY,
    });

    opened[0].handlers.onMessage(Buffer.from('hi'));
    // The deliverer sends to the subscribing document alone, so it must
    // reach it.
    expect(deliver.mock.calls[0][0]).toMatchObject({ origin: 'a.eth', document: '1:1', deliverTo });
  });

  test('enforces the per-origin cap', async () => {
    for (let i = 0; i < 3; i++) {
      await subscribeEstablished({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: `${i}${i}`.repeat(32) });
    }
    await expect(
      registry.subscribe({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: 'ff'.repeat(32) })
    ).rejects.toMatchObject({ reason: 'too_many_subscriptions' });

    // Other origins are unaffected
    await subscribeEstablished({ origin: 'b.eth', document: '2:1', kind: 'gsoc', key: 'ff'.repeat(32) });
  });

  test('a failed establish releases the slot and removes the socket', async () => {
    const promise = registry.subscribe({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
    const err = new Error('no lurker slot available');
    err.reason = 'node_subscription_limit';
    opened[0].rejectEstablished(err);

    await expect(promise).rejects.toMatchObject({ reason: 'node_subscription_limit' });
    expect(registry.countByOrigin('a.eth')).toBe(0);

    // A retry opens a fresh socket rather than joining the dead one
    await subscribeEstablished({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
    expect(openSocket).toHaveBeenCalledTimes(2);
  });

  test('unsubscribe is origin-scoped and closes the socket with its last subscription', async () => {
    const { subscriptionId } = await subscribeEstablished({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
    const { subscriptionId: other } = await registry.subscribe({ origin: 'b.eth', document: '2:1', kind: 'gsoc', key: GSOC_KEY });

    expect(() => registry.unsubscribe('b.eth', subscriptionId)).toThrow(
      expect.objectContaining({ reason: 'subscription_not_found' })
    );

    registry.unsubscribe('a.eth', subscriptionId);
    expect(opened[0].cancel).not.toHaveBeenCalled();

    registry.unsubscribe('b.eth', other);
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);

    expect(() => registry.unsubscribe('a.eth', subscriptionId)).toThrow(
      expect.objectContaining({ reason: 'subscription_not_found' })
    );
  });

  test('no delivery after unsubscribe', async () => {
    const { subscriptionId } = await subscribeEstablished({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
    await registry.subscribe({ origin: 'b.eth', document: '2:1', kind: 'gsoc', key: GSOC_KEY });

    registry.unsubscribe('a.eth', subscriptionId);
    opened[0].handlers.onMessage(Buffer.from('after'));

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].origin).toBe('b.eth');
  });

  test('cancelByOrigin tears down every subscription of the origin', async () => {
    await subscribeEstablished({ origin: 'a.eth', document: '1:1', kind: 'gsoc', key: GSOC_KEY });
    await subscribeEstablished({ origin: 'a.eth', document: '2:1', kind: 'pss', key: 'cd'.repeat(32) });
    await subscribeEstablished({ origin: 'b.eth', document: '3:1', kind: 'gsoc', key: 'ef'.repeat(32) });

    registry.cancelByOrigin('a.eth');

    expect(registry.countByOrigin('a.eth')).toBe(0);
    expect(registry.countByOrigin('b.eth')).toBe(1);
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);
    expect(opened[1].cancel).toHaveBeenCalledTimes(1);
    expect(opened[2].cancel).not.toHaveBeenCalled();
  });
});

// A page's subscription through main (freedom-core design 0011, PRQ-7b):
// bound to its document.
describe('subscription-registry: subscriptions bound to a document', () => {
  let opened;

  beforeEach(() => {
    registry._reset();
    const factory = makeSocketFactory();
    opened = factory.opened;
    registry.configure({ openSocket: factory.openSocket, deliver: jest.fn(), maxSubscriptionsPerOrigin: 3, establishTimeoutMs: 5000 });
  });

  async function open(document, origin = 'a.eth', key = 'cd'.repeat(32)) {
    const promise = registry.subscribe({ origin, document, deliverTo: jest.fn(), kind: 'pss', key });
    opened[opened.length - 1].resolveEstablished();
    return (await promise).subscriptionId;
  }

  test('a document\'s subscriptions end with it, and no other\'s', async () => {
    await open('7:1');
    await open('7:1');
    const other = await open('8:1');
    registry.cancelByDocument('7:1');
    expect(registry.countByOrigin('a.eth')).toBe(1);
    expect(() => registry.unsubscribeDocument('8:1', other)).not.toThrow();
    expect(registry.countByOrigin('a.eth')).toBe(0);
    expect(opened[0].cancel).toHaveBeenCalled();
  });

  test('unsubscribeDocument closes only the document\'s own; one bound to no document is none of a document\'s', async () => {
    const own = await open('7:1');
    const theirs = await open('8:1');
    const unbound = registry.subscribe({ origin: 'a.eth', kind: 'pss', key: 'cd'.repeat(32) });
    const { subscriptionId: none } = await unbound;
    for (const id of [theirs, none, 'nope']) {
      expect(() => registry.unsubscribeDocument('7:1', id)).toThrow(expect.objectContaining({ reason: 'subscription_not_found' }));
    }
    registry.unsubscribeDocument('7:1', own);
    expect(registry.countByOrigin('a.eth')).toBe(2);
    // A document's end never closes one bound to no document.
    registry.cancelByDocument(undefined);
    expect(registry.countByOrigin('a.eth')).toBe(2);
  });

  test('a document that ends while its subscription establishes gets no id, and holds no slot', async () => {
    const promise = registry.subscribe({ origin: 'a.eth', document: '7:1', deliverTo: jest.fn(), kind: 'pss', key: 'ef'.repeat(32) });
    registry.cancelByDocument('7:1');
    opened[0].resolveEstablished();
    await expect(promise).rejects.toMatchObject({ reason: 'subscription_cancelled' });
    expect(registry.countByOrigin('a.eth')).toBe(0);
  });

  test('a closed subscription is marked closed, and its onClosed hears it once', async () => {
    const id = await open('7:1');
    const onClosed = jest.fn();
    // The registry hands its own object to deliver(); a test reaches it
    // through a message.
    let held = null;
    registry.configure({ openSocket: () => ({ established: Promise.resolve(), cancel: () => {} }), deliver: (sub) => { held = sub; }, maxSubscriptionsPerOrigin: 3 });
    opened[0].handlers.onMessage(Buffer.from('x'));
    expect(held.id).toBe(id);
    held.onClosed = onClosed;
    registry.cancelByDocument('7:1');
    expect(held.closed).toBe(true);
    expect(onClosed).toHaveBeenCalledTimes(1);
    registry.cancelById(id);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test('cancelById closes one, if still open', async () => {
    const id = await open('7:1');
    registry.cancelById(id);
    registry.cancelById(id);
    expect(registry.countByOrigin('a.eth')).toBe(0);
  });
});

// Question 4 (freedom-core design 0015, Messaging; SWM-6 to SWM-9's plan,
// point 10): no socket to a node the session reaches through a proxy or
// Tor, tested just before every open and reconnect, on every change and
// every 30 s while a remote socket is open.
describe('subscription-registry: the route test', () => {
  const REMOTE = 'https://ant.example';
  const LOOPBACK = 'http://127.0.0.1:1633';
  const ARTI = '127.0.0.1:19150';
  const KEY = 'cd'.repeat(32);
  let opened;
  let openSocket;
  let proxy;
  let resolveProxy;
  let refused;
  let nodeUrl;
  let restarting;

  function configure(extra = {}) {
    registry.configure({
      openSocket,
      deliver: jest.fn(),
      maxSubscriptionsPerOrigin: 3,
      establishTimeoutMs: 5000,
      route: { nodeUrl: () => nodeUrl, resolveProxy, torEndpoint: () => ARTI, restartingUrl: () => restarting },
      onRefused: (event) => refused.push(event),
      ...extra,
    });
  }

  beforeEach(() => {
    registry._reset();
    ({ openSocket, opened } = makeSocketFactory());
    proxy = 'DIRECT';
    resolveProxy = jest.fn(async () => proxy);
    refused = [];
    nodeUrl = REMOTE;
    restarting = null;
    configure();
  });

  afterEach(() => {
    registry._reset();
  });

  // A socket opened after the route test's wait (or none, joining one).
  async function socketAfter(before) {
    for (let i = 0; i < 20 && opened.length === before; i++) await Promise.resolve();
    return opened.length > before ? opened[opened.length - 1] : null;
  }

  async function openOne(params = {}) {
    const before = opened.length;
    const promise = registry.subscribe({ origin: 'a.eth', document: '7:1', deliverTo: jest.fn(), kind: 'pss', key: KEY, ...params });
    (await socketAfter(before))?.resolveEstablished();
    return (await promise).subscriptionId;
  }

  test.each([
    ['the bundled node', LOOPBACK, 'PROXY proxy.example:8080', null, false],
    ['a node at localhost', 'http://localhost:1633', 'PROXY proxy.example:8080', null, false],
    ['a node at [::1]', 'http://[::1]:1633', 'PROXY proxy.example:8080', null, false],
    ['a remote node reached directly', REMOTE, 'DIRECT', null, true],
    ['a remote node, DIRECT in any case', REMOTE, ' direct ', null, true],
    ['a remote node behind a proxy', REMOTE, 'PROXY proxy.example:8080', 'proxy', true],
    ['a remote node behind a proxy list ending DIRECT', REMOTE, 'PROXY proxy.example:8080; DIRECT', 'proxy', true],
    ["a remote node behind Arti's endpoint", REMOTE, `SOCKS5 ${ARTI}`, 'tor', true],
    ['a remote node behind another SOCKS proxy', REMOTE, 'SOCKS5 127.0.0.1:1080', 'proxy', true],
    ['an onion node, Tor off', 'http://abcdef.onion', 'DIRECT', 'tor', false],
    ['an onion node, Tor on', 'http://abcdef.onion:1633', `SOCKS5 ${ARTI}`, 'tor', false],
    ['no node', null, 'PROXY proxy.example:8080', null, false],
  ])('routeRefusal: %s', async (_label, url, answer, via, asked) => {
    const ask = jest.fn(async () => answer);
    const refusal = await registry.routeRefusal(url, { resolveProxy: ask, torEndpoint: () => ARTI });
    expect(refusal).toEqual(via ? { reason: 'proxy-or-tor', via } : null);
    expect(ask).toHaveBeenCalledTimes(asked ? 1 : 0);
  });

  test("routeRefusal fails closed when the proxy can't be resolved, and names a proxy with Tor off", async () => {
    const failing = jest.fn(async () => {
      throw new Error('network service gone');
    });
    expect(await registry.routeRefusal(REMOTE, { resolveProxy: failing })).toEqual({ reason: 'proxy-or-tor', via: 'proxy' });
    expect(
      await registry.routeRefusal(REMOTE, { resolveProxy: async () => `SOCKS5 ${ARTI}`, torEndpoint: () => null })
    ).toEqual({ reason: 'proxy-or-tor', via: 'proxy' });
  });

  test('a refused open opens no socket, releases its slot and is reported', async () => {
    proxy = `SOCKS5 ${ARTI}`;
    await expect(
      registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY })
    ).rejects.toMatchObject({ reason: 'proxy-or-tor', message: 'Node not available: proxy-or-tor', via: 'tor' });
    expect(openSocket).not.toHaveBeenCalled();
    expect(registry.countByOrigin('a.eth')).toBe(0);
    expect(refused).toEqual([{ origin: 'a.eth', via: 'tor', ended: false }]);
  });

  test('an open dials the URL it tested, the given one before the node now, and asks before each reconnect', async () => {
    await openOne();
    expect(openSocket).toHaveBeenLastCalledWith(
      { kind: 'pss', key: KEY, url: REMOTE },
      { onMessage: expect.any(Function), beforeReconnect: expect.any(Function) }
    );
    expect(resolveProxy).toHaveBeenLastCalledWith(REMOTE);
    // The given one (the parent's node, on the core) when it is the node now.
    await openOne({ key: 'ef'.repeat(32), nodeUrl: `${REMOTE}/` });
    expect(opened[1].target.url).toBe(`${REMOTE}/`);
    expect(resolveProxy).toHaveBeenLastCalledWith(`${REMOTE}/`);
  });

  test('the slot is held through the test, and an end meanwhile opens nothing', async () => {
    let answer;
    resolveProxy = jest.fn(() => new Promise((resolve) => (answer = resolve)));
    configure();
    const promise = registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY });
    expect(registry.countByOrigin('a.eth')).toBe(1);
    registry.cancelByDocument('7:1');
    answer('DIRECT');
    await expect(promise).rejects.toMatchObject({ reason: 'subscription_cancelled' });
    expect(openSocket).not.toHaveBeenCalled();
  });

  test('a reconnect the route refuses ends the socket and its subscriptions, reported once each', async () => {
    await openOne();
    await openOne({ origin: 'b.eth', document: '8:1' });
    proxy = 'PROXY proxy.example:8080';
    await expect(opened[0].handlers.beforeReconnect()).resolves.toBe(false);
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);
    expect(registry.countByOrigin('a.eth')).toBe(0);
    expect(registry.countByOrigin('b.eth')).toBe(0);
    expect(refused).toEqual([
      { origin: 'a.eth', via: 'proxy', ended: true },
      { origin: 'b.eth', via: 'proxy', ended: true },
    ]);
    // A later ask of the ended socket's is a no as well.
    proxy = 'DIRECT';
    await expect(opened[0].handlers.beforeReconnect()).resolves.toBe(false);
  });

  test('a reconnect on a route that still holds goes ahead', async () => {
    await openOne();
    await expect(opened[0].handlers.beforeReconnect()).resolves.toBe(true);
    expect(registry.countByOrigin('a.eth')).toBe(1);
  });

  test('recheckRoutes ends the sockets now refused, and keeps the loopback ones', async () => {
    await openOne();
    nodeUrl = LOOPBACK;
    await openOne({ key: 'ef'.repeat(32), document: '8:1' });
    proxy = 'PROXY proxy.example:8080';
    await registry.recheckRoutes();
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);
    expect(opened[1].cancel).not.toHaveBeenCalled();
    expect(registry.countByOrigin('a.eth')).toBe(1);
  });

  test('a subscription a recheck ends while it establishes is refused proxy-or-tor', async () => {
    const promise = registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY });
    await socketAfter(0);
    proxy = 'PROXY proxy.example:8080';
    await registry.recheckRoutes();
    await expect(promise).rejects.toMatchObject({ reason: 'proxy-or-tor', via: 'proxy' });
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);
    // Reported once, as a refused open.
    expect(refused).toEqual([{ origin: 'a.eth', via: 'proxy', ended: false }]);
  });

  test('every 30 s while a remote socket is open, and not at all for loopback ones', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      nodeUrl = LOOPBACK;
      await openOne();
      await jest.advanceTimersByTimeAsync(registry.ROUTE_RECHECK_MS * 2);
      expect(resolveProxy).not.toHaveBeenCalled();
      expect(opened[0].cancel).not.toHaveBeenCalled();
      registry.cancelByDocument('7:1');

      nodeUrl = REMOTE;
      await openOne({ key: 'ef'.repeat(32), document: '8:1' });
      expect(resolveProxy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(registry.ROUTE_RECHECK_MS);
      expect(resolveProxy).toHaveBeenCalledTimes(2);
      proxy = 'PROXY proxy.example:8080';
      await jest.advanceTimersByTimeAsync(registry.ROUTE_RECHECK_MS);
      expect(opened[1].cancel).toHaveBeenCalledTimes(1);
      // No remote socket left: no more tests.
      await jest.advanceTimersByTimeAsync(registry.ROUTE_RECHECK_MS * 3);
      expect(resolveProxy).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('checkRoute: the first check, reported for a site; nothing while no route is configured', async () => {
    proxy = 'PROXY proxy.example:8080';
    expect(await registry.checkRoute(REMOTE)).toEqual({ reason: 'proxy-or-tor', via: 'proxy' });
    expect(refused).toEqual([]);
    expect(await registry.checkRoute(REMOTE, 'a.eth')).toEqual({ reason: 'proxy-or-tor', via: 'proxy' });
    expect(refused).toEqual([{ origin: 'a.eth', via: 'proxy', ended: false }]);
    registry.configure({ openSocket, deliver: jest.fn(), route: null });
    expect(await registry.checkRoute(REMOTE, 'a.eth')).toBeNull();
  });

  describe("the node's URL changes (Codex round 1 on #1375)", () => {
    const OTHER = 'https://other.example';

    test.each([
      ['another node reached directly', OTHER, `${OTHER}`],
      ['a node on loopback', LOOPBACK, LOOPBACK],
    ])('to %s: the old socket ends at the recheck, unreported, and a same-key subscription opens on the new node', async (_label, next) => {
      await openOne();
      await openOne({ origin: 'b.eth', document: '8:1' });
      expect(openSocket).toHaveBeenCalledTimes(1);
      nodeUrl = next;
      await registry.recheckRoutes();
      expect(opened[0].cancel).toHaveBeenCalledTimes(1);
      expect(registry.countByOrigin('a.eth')).toBe(0);
      expect(registry.countByOrigin('b.eth')).toBe(0);
      // The old node's route still holds: no refusal to report.
      expect(refused).toEqual([]);
      await expect(opened[0].handlers.beforeReconnect()).resolves.toBe(false);
      await openOne();
      expect(openSocket).toHaveBeenCalledTimes(2);
      expect(opened[1].target).toEqual({ kind: 'pss', key: KEY, url: next });
    });

    test('to an onion node: the old socket ends, and a same-key subscription is refused with no socket', async () => {
      await openOne();
      nodeUrl = 'http://abcdefghijklmnop.onion';
      await registry.recheckRoutes();
      expect(opened[0].cancel).toHaveBeenCalledTimes(1);
      await expect(
        registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY })
      ).rejects.toMatchObject({ reason: 'proxy-or-tor', via: 'tor' });
      expect(openSocket).toHaveBeenCalledTimes(1);
    });

    test("a same-key subscription never joins a socket to another node, even before the recheck", async () => {
      await openOne();
      nodeUrl = OTHER;
      await openOne({ origin: 'b.eth', document: '8:1' });
      expect(openSocket).toHaveBeenCalledTimes(2);
      expect(opened[1].target.url).toBe(OTHER);
      await registry.recheckRoutes();
      expect(opened[0].cancel).toHaveBeenCalledTimes(1);
      expect(opened[1].cancel).not.toHaveBeenCalled();
      expect(registry.countByOrigin('b.eth')).toBe(1);
    });

    test('a reconnect to a node that is no longer the configured one ends the socket, before any route test', async () => {
      await openOne();
      resolveProxy.mockClear();
      nodeUrl = OTHER;
      await expect(opened[0].handlers.beforeReconnect()).resolves.toBe(false);
      expect(resolveProxy).not.toHaveBeenCalled();
      expect(opened[0].cancel).toHaveBeenCalledTimes(1);
      expect(registry.countByOrigin('a.eth')).toBe(0);
    });

    test('a node URL given for the open that is no longer the configured one opens nothing', async () => {
      await expect(
        registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY, nodeUrl: OTHER })
      ).rejects.toMatchObject({ reason: 'subscription_cancelled' });
      expect(openSocket).not.toHaveBeenCalled();
      expect(registry.countByOrigin('a.eth')).toBe(0);
      // A trailing slash is the same node.
      await openOne({ nodeUrl: `${REMOTE}/` });
      expect(openSocket).toHaveBeenCalledTimes(1);
    });

    test('a socket establishing on the old node is cancelled, not refused', async () => {
      const promise = registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY });
      await socketAfter(0);
      nodeUrl = OTHER;
      await registry.recheckRoutes();
      await expect(promise).rejects.toMatchObject({ reason: 'subscription_cancelled' });
      expect(refused).toEqual([]);
    });

    test.each([
      ['a stop of the external node'],
      ['the node disabled'],
    ])('no node configured after %s: the socket ends at the recheck and at a reconnect, unreported', async () => {
      await openOne();
      await openOne({ key: 'ef'.repeat(32), document: '8:1' });
      nodeUrl = null;
      await registry.recheckRoutes();
      expect(opened[0].cancel).toHaveBeenCalledTimes(1);
      expect(registry.countByOrigin('a.eth')).toBe(0);
      await expect(opened[1].handlers.beforeReconnect()).resolves.toBe(false);
      expect(refused).toEqual([]);
      // Nor does a new subscription open while there is none.
      await expect(
        registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY })
      ).rejects.toMatchObject({ reason: 'subscription_cancelled' });
      expect(openSocket).toHaveBeenCalledTimes(2);
    });

    describe('the node cleared while resolveProxy is held (Codex round 2)', () => {
      let answer;
      beforeEach(() => {
        resolveProxy = jest.fn(() => new Promise((resolve) => (answer = resolve)));
        configure();
      });

      test('an open dials nothing', async () => {
        const promise = registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY });
        nodeUrl = null;
        answer('DIRECT');
        await expect(promise).rejects.toMatchObject({ reason: 'subscription_cancelled' });
        expect(openSocket).not.toHaveBeenCalled();
        expect(registry.countByOrigin('a.eth')).toBe(0);
      });

      test('a reconnect dials nothing, and its socket ends', async () => {
        const opening = registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY });
        answer('DIRECT');
        (await socketAfter(0)).resolveEstablished();
        await opening;
        const asked = opened[0].handlers.beforeReconnect();
        nodeUrl = null;
        answer('DIRECT');
        await expect(asked).resolves.toBe(false);
        expect(opened[0].cancel).toHaveBeenCalledTimes(1);
        expect(registry.countByOrigin('a.eth')).toBe(0);
      });

      test('a recheck ends the socket', async () => {
        const opening = registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY });
        answer('DIRECT');
        (await socketAfter(0)).resolveEstablished();
        await opening;
        const checking = registry.recheckRoutes();
        nodeUrl = null;
        answer('DIRECT');
        await checking;
        expect(opened[0].cancel).toHaveBeenCalledTimes(1);
      });
    });

    test("the bundled node's restart (ant-manager's restartingUrl): its socket waits, and goes ahead when it is back at that URL", async () => {
      nodeUrl = LOOPBACK;
      await openOne();
      nodeUrl = null;
      restarting = LOOPBACK;
      await registry.recheckRoutes();
      await expect(opened[0].handlers.beforeReconnect()).resolves.toBe('later');
      expect(opened[0].cancel).not.toHaveBeenCalled();
      expect(registry.countByOrigin('a.eth')).toBe(1);
      nodeUrl = LOOPBACK;
      restarting = null;
      await expect(opened[0].handlers.beforeReconnect()).resolves.toBe(true);
    });

    test.each([
      ['back at another URL', 'http://127.0.0.1:1733', null],
      ['not back when the restart is over', null, null],
      ['a restart of another node', null, 'http://127.0.0.1:1733'],
    ])("the bundled node's restart, %s: its socket ends", async (_label, back, restartUrl) => {
      nodeUrl = LOOPBACK;
      await openOne();
      nodeUrl = null;
      restarting = restartUrl ?? LOOPBACK;
      if (restartUrl === null) await expect(opened[0].handlers.beforeReconnect()).resolves.toBe('later');
      nodeUrl = back;
      if (restartUrl === null) restarting = null;
      await expect(opened[0].handlers.beforeReconnect()).resolves.toBe(false);
      expect(opened[0].cancel).toHaveBeenCalledTimes(1);
    });
  });

  test('its signal ends a subscription that establishes; only its opener closes it by id', async () => {
    const controller = new AbortController();
    const promise = registry.subscribe({ origin: 'a.eth', document: '7:1', kind: 'pss', key: KEY, signal: controller.signal });
    await socketAfter(0);
    controller.abort();
    // At once, though the socket's mock never settles.
    await expect(promise).rejects.toMatchObject({ reason: 'subscription_cancelled' });
    expect(registry.countByOrigin('a.eth')).toBe(0);
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);

    const id = await openOne({ opener: 'core:1' });
    expect(registry.cancelByOpener('core:2', id)).toBe(false);
    expect(registry.cancelByOpener(undefined, id)).toBe(false);
    expect(registry.countByOrigin('a.eth')).toBe(1);
    expect(registry.cancelByOpener('core:1', id)).toBe(true);
    expect(registry.cancelByOpener('core:1', id)).toBe(false);
    expect(registry.countByOrigin('a.eth')).toBe(0);
  });
});
