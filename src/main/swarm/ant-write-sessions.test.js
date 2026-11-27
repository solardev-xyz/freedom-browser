// Write sessions for main's writes to a remote Ant (#1344; freedom-core
// design 0015, point 6). Electron's sessions are played here; that a write
// on one goes once, on a new connection, through the request session's
// proxy, is shown by a real Electron process (`swarm-shell-proxy.test.js`).
const mockMade = [];
const mockDefaultSession = { resolveProxy: jest.fn(async () => 'DIRECT') };
jest.mock('electron', () => ({
  session: {
    get defaultSession() {
      return mockDefaultSession;
    },
    fromPartition: (partition, options) => {
      const calls = [];
      const ses = {
        partition,
        options,
        calls,
        pac: null,
        closeAllConnections: jest.fn(async () => {
          calls.push('closeAllConnections');
        }),
        setProxy: jest.fn(async (config) => {
          calls.push('setProxy');
          ses.pac = Buffer.from(config.pacScript.split(',')[1], 'base64').toString('utf-8');
        }),
        forceReloadProxyConfig: jest.fn(async () => {
          calls.push('forceReloadProxyConfig');
        }),
        // The PAC's answer, as Chromium would resolve it.
        resolveProxy: jest.fn(async () => {
          calls.push('resolveProxy');
          return ses.pac ? JSON.parse(ses.pac.match(/return (".*");/)[1]) : 'DIRECT';
        }),
      };
      mockMade.push(ses);
      return ses;
    },
  },
}));

const {
  leaseWriteSession,
  MAX_WRITE_SESSIONS,
  PREPARE_TIMEOUT_MS,
} = require('./ant-write-sessions');

const URL_ = 'http://ant.example.test:1633/pss/send/topic/ab';
const SOCKS = 'SOCKS5 127.0.0.1:9150';

/** A request session whose proxy for every URL is `proxy`. */
function requestSession(proxy = SOCKS) {
  return {
    proxy,
    resolveProxy: jest.fn(async function () {
      return this.proxy;
    }),
  };
}

beforeEach(() => {
  mockMade.length = 0;
  jest.useRealTimers();
});

describe('a write session', () => {
  test("is an in-memory partition with no cache, on its request session's proxy, its connections closed", async () => {
    const source = requestSession();
    const { session, release } = await leaseWriteSession(source, URL_);
    expect(mockMade).toHaveLength(1);
    expect(session).toBe(mockMade[0]);
    expect(session.partition).toMatch(/^freedom-ant-write-\d+$/);
    expect(session.options).toEqual({ cache: false });
    expect(source.resolveProxy).toHaveBeenCalledWith(URL_);
    expect(session.pac).toBe(`function FindProxyForURL(url, host) { return "${SOCKS}"; }`);
    // The proxy set, then the connections closed, then the proxy read back.
    expect(session.calls).toEqual([
      'setProxy',
      'forceReloadProxyConfig',
      'closeAllConnections',
      'resolveProxy',
    ]);
    release();
  });

  test('every lease closes its connections; the proxy is set again only when it changed', async () => {
    const source = requestSession();
    const first = await leaseWriteSession(source, URL_);
    first.release();
    const second = await leaseWriteSession(source, URL_);
    expect(second.session).toBe(first.session);
    expect(second.session.calls.slice(4)).toEqual(['closeAllConnections', 'resolveProxy']);
    second.release();

    // Tor stopped: the request session now resolves the node DIRECT.
    source.proxy = 'DIRECT';
    const third = await leaseWriteSession(source, URL_);
    expect(third.session).toBe(first.session);
    expect(third.session.calls.slice(6)).toEqual([
      'setProxy',
      'forceReloadProxyConfig',
      'closeAllConnections',
      'resolveProxy',
    ]);
    expect(await third.session.resolveProxy(URL_)).toBe('DIRECT');
    third.release();
  });

  test('a fallback chain is kept as Chromium wrote it', async () => {
    const chain = 'PROXY proxy.example:3128;SOCKS5 127.0.0.1:1080;DIRECT';
    const { session, release } = await leaseWriteSession(requestSession(chain), URL_);
    expect(await session.resolveProxy(URL_)).toBe(chain);
    release();
  });

  test('a proxy it does not read back fails the lease, undialled, and is set again next time', async () => {
    const source = requestSession();
    const first = await leaseWriteSession(source, URL_);
    first.release();
    first.session.resolveProxy.mockResolvedValueOnce('DIRECT');
    await expect(leaseWriteSession(source, URL_)).rejects.toThrow(
      `a write session resolves its proxy as DIRECT, its request session as ${SOCKS}: not dialled`
    );
    // Handed back, its proxy unknown: the next lease sets it again.
    await new Promise(setImmediate);
    const next = await leaseWriteSession(source, URL_);
    expect(next.session).toBe(first.session);
    expect(next.session.calls.slice(-4)).toEqual([
      'setProxy',
      'forceReloadProxyConfig',
      'closeAllConnections',
      'resolveProxy',
    ]);
    next.release();
  });

  test('a request session whose proxy lookup fails fails the lease', async () => {
    const source = requestSession();
    source.resolveProxy.mockRejectedValueOnce(new Error('session.resolveProxy failed'));
    await expect(leaseWriteSession(source, URL_)).rejects.toThrow('session.resolveProxy failed');
    expect(mockMade[0].calls).toEqual([]);
  });

  test('no request session: the default session is the one whose proxy it takes', async () => {
    mockDefaultSession.resolveProxy.mockResolvedValueOnce(SOCKS);
    const { session, release } = await leaseWriteSession(null, URL_);
    expect(mockDefaultSession.resolveProxy).toHaveBeenCalledWith(URL_);
    expect(await session.resolveProxy(URL_)).toBe(SOCKS);
    release();
  });
});

describe('the pool', () => {
  test(`concurrent writes each get a session of their own, up to ${MAX_WRITE_SESSIONS}; the next waits its turn`, async () => {
    const source = requestSession();
    const leases = await Promise.all(
      Array.from({ length: MAX_WRITE_SESSIONS }, () => leaseWriteSession(source, URL_))
    );
    expect(new Set(leases.map((l) => l.session)).size).toBe(MAX_WRITE_SESSIONS);
    expect(mockMade).toHaveLength(MAX_WRITE_SESSIONS);

    const order = [];
    const ninth = leaseWriteSession(source, URL_).then((l) => {
      order.push('ninth');
      return l;
    });
    const tenth = leaseWriteSession(source, URL_).then((l) => {
      order.push('tenth');
      return l;
    });
    await new Promise(setImmediate);
    expect(order).toEqual([]);
    expect(mockMade).toHaveLength(MAX_WRITE_SESSIONS);

    leases[3].release();
    leases[3].release(); // idempotent: one session back, not two
    const got = await ninth;
    expect(got.session).toBe(leases[3].session);
    await new Promise(setImmediate);
    expect(order).toEqual(['ninth']);
    leases[5].release();
    expect((await tenth).session).toBe(leases[5].session);
    expect(order).toEqual(['ninth', 'tenth']);
  });

  test('a write that aborts while it waits takes no session', async () => {
    const source = requestSession();
    const leases = await Promise.all(
      Array.from({ length: MAX_WRITE_SESSIONS }, () => leaseWriteSession(source, URL_))
    );
    const abort = new AbortController();
    const waiting = leaseWriteSession(source, URL_, abort.signal);
    const after = leaseWriteSession(source, URL_);
    abort.abort();
    await expect(waiting).rejects.toThrow('This operation was aborted');
    leases[0].release();
    expect((await after).session).toBe(leases[0].session);
    await expect(leaseWriteSession(source, URL_, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  test("each request session has its own: a private window's writes share none with the default session's", async () => {
    const a = await leaseWriteSession(requestSession(), URL_);
    a.release();
    const b = await leaseWriteSession(requestSession(), URL_);
    expect(b.session).not.toBe(a.session);
    b.release();
  });

  test('a preparation that never settles fails the write in time and keeps its session until it does', async () => {
    jest.useFakeTimers();
    const source = requestSession();
    const first = await leaseWriteSession(source, URL_);
    first.release();
    let settle;
    first.session.closeAllConnections.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve))
    );
    const stuck = leaseWriteSession(source, URL_);
    const failed = expect(stuck).rejects.toThrow(
      'a write session was not ready in time: not dialled'
    );
    await jest.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);
    await failed;
    // Still held: the next write gets another session.
    const other = await leaseWriteSession(source, URL_);
    expect(other.session).not.toBe(first.session);
    other.release();
    // Back once its call settles.
    settle();
    await jest.advanceTimersByTimeAsync(0);
    const again = await leaseWriteSession(source, URL_);
    expect([first.session, other.session]).toContain(again.session);
    again.release();
  });
});
