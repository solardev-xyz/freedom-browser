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
    const promise = registry.subscribe({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    expect(openSocket).toHaveBeenCalledWith({ kind: 'gsoc', key: GSOC_KEY }, expect.any(Object));

    opened[0].resolveEstablished();
    const { subscriptionId } = await promise;
    expect(typeof subscriptionId).toBe('string');
    expect(subscriptionId).toHaveLength(32);
  });

  test('multiplexes: same (kind, key) shares one socket, distinct keys open their own', async () => {
    const first = registry.subscribe({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    opened[0].resolveEstablished();
    await first;
    await registry.subscribe({ origin: 'b.eth', webContentsId: 2, kind: 'gsoc', key: GSOC_KEY });
    expect(openSocket).toHaveBeenCalledTimes(1);

    await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'pss', key: GSOC_KEY });
    expect(openSocket).toHaveBeenCalledTimes(2);
  });

  test('fans a payload out to every subscription on the socket', async () => {
    const { subscriptionId: subA } = await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    const { subscriptionId: subB } = await registry.subscribe({ origin: 'b.eth', webContentsId: 2, kind: 'gsoc', key: GSOC_KEY });

    const payload = Buffer.from('hello');
    opened[0].handlers.onMessage(payload);

    expect(deliver).toHaveBeenCalledTimes(2);
    const deliveredIds = deliver.mock.calls.map(([sub]) => sub.id).sort();
    expect(deliveredIds).toEqual([subA, subB].sort());
    expect(deliver.mock.calls[0][1]).toBe(payload);
    expect(deliver.mock.calls[0][0]).toMatchObject({ kind: 'gsoc', key: GSOC_KEY });
  });

  test('does not fan out to a subscription that has not established yet', async () => {
    const pending = registry.subscribe({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });

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
      const promise = registry.subscribe({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
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
    const promise = registry.subscribe({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });

    // The page navigated away (or the tab closed) mid-establishment.
    registry.cancelByWebContents(1);
    opened[0].resolveEstablished();

    await expect(promise).rejects.toMatchObject({ reason: 'subscription_cancelled' });
    expect(registry.countByOrigin('a.eth')).toBe(0);
  });

  test('carries the subscribing origin through to the deliverer', async () => {
    await subscribeEstablished({
      origin: 'a.eth',
      webContentsId: 1,
      kind: 'gsoc',
      key: GSOC_KEY,
    });

    opened[0].handlers.onMessage(Buffer.from('hi'));
    // The deliverer re-checks this against the webContents' live URL, so
    // it must reach it — messages can never land in another origin's page.
    expect(deliver.mock.calls[0][0]).toMatchObject({ origin: 'a.eth', webContentsId: 1 });
  });

  test('cancelStaleByWebContents keeps the subscriptions of the origin now loaded', async () => {
    await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    await subscribeEstablished({ origin: 'b.eth', webContentsId: 1, kind: 'gsoc', key: 'bb'.repeat(32) });
    await subscribeEstablished({ origin: 'a.eth', webContentsId: 2, kind: 'gsoc', key: 'cc'.repeat(32) });

    // The webview turned out to be hosting b.eth: a.eth's subscription on
    // that webview is stale, b.eth's is live, and other tabs are untouched.
    registry.cancelStaleByWebContents(1, 'b.eth');

    expect(registry.countByOrigin('b.eth')).toBe(1);
    expect(registry.countByOrigin('a.eth')).toBe(1);
  });

  test('enforces the per-origin cap', async () => {
    for (let i = 0; i < 3; i++) {
      await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: `${i}${i}`.repeat(32) });
    }
    await expect(
      registry.subscribe({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: 'ff'.repeat(32) })
    ).rejects.toMatchObject({ reason: 'too_many_subscriptions' });

    // Other origins are unaffected
    await subscribeEstablished({ origin: 'b.eth', webContentsId: 2, kind: 'gsoc', key: 'ff'.repeat(32) });
  });

  test('a failed establish releases the slot and removes the socket', async () => {
    const promise = registry.subscribe({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    const err = new Error('no lurker slot available');
    err.reason = 'node_subscription_limit';
    opened[0].rejectEstablished(err);

    await expect(promise).rejects.toMatchObject({ reason: 'node_subscription_limit' });
    expect(registry.countByOrigin('a.eth')).toBe(0);

    // A retry opens a fresh socket rather than joining the dead one
    await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    expect(openSocket).toHaveBeenCalledTimes(2);
  });

  test('unsubscribe is origin-scoped and closes the socket with its last subscription', async () => {
    const { subscriptionId } = await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    const { subscriptionId: other } = await registry.subscribe({ origin: 'b.eth', webContentsId: 2, kind: 'gsoc', key: GSOC_KEY });

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
    const { subscriptionId } = await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    await registry.subscribe({ origin: 'b.eth', webContentsId: 2, kind: 'gsoc', key: GSOC_KEY });

    registry.unsubscribe('a.eth', subscriptionId);
    opened[0].handlers.onMessage(Buffer.from('after'));

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].origin).toBe('b.eth');
  });

  test('cancelByWebContents tears down that page only', async () => {
    await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    await subscribeEstablished({ origin: 'a.eth', webContentsId: 7, kind: 'gsoc', key: 'cd'.repeat(32) });

    registry.cancelByWebContents(1);

    expect(registry.countByOrigin('a.eth')).toBe(1);
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);
    expect(opened[1].cancel).not.toHaveBeenCalled();
  });

  test('cancelByOrigin tears down every subscription of the origin', async () => {
    await subscribeEstablished({ origin: 'a.eth', webContentsId: 1, kind: 'gsoc', key: GSOC_KEY });
    await subscribeEstablished({ origin: 'a.eth', webContentsId: 2, kind: 'pss', key: 'cd'.repeat(32) });
    await subscribeEstablished({ origin: 'b.eth', webContentsId: 3, kind: 'gsoc', key: 'ef'.repeat(32) });

    registry.cancelByOrigin('a.eth');

    expect(registry.countByOrigin('a.eth')).toBe(0);
    expect(registry.countByOrigin('b.eth')).toBe(1);
    expect(opened[0].cancel).toHaveBeenCalledTimes(1);
    expect(opened[1].cancel).toHaveBeenCalledTimes(1);
    expect(opened[2].cancel).not.toHaveBeenCalled();
  });
});
