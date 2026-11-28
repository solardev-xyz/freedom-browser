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
        guard: null,
        // A request through the session's webRequest: whether its guard lets it go.
        sends: (method, url) =>
          new Promise((resolve) =>
            ses.guard({ method, url, resourceType: 'other' }, ({ cancel }) => resolve(!cancel))
          ),
        webRequest: {
          onBeforeRequest: jest.fn((listener) => {
            calls.push('guard');
            ses.guard = listener;
          }),
        },
        setSpellCheckerLanguages: jest.fn(() => calls.push('spellCheckerLanguages')),
        setSpellCheckerEnabled: jest.fn(() => calls.push('spellCheckerEnabled')),
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
  AntNotDialled,
  MAX_WRITE_SESSIONS,
  PREPARE_TIMEOUT_MS,
} = require('./ant-write-sessions');

// What a lease rejects with when nothing of its write was dialled.
const notDialled = (message) =>
  expect.objectContaining({
    name: 'AntNotDialled',
    code: 'ERR_ANT_NOT_DIALLED',
    message: expect.stringContaining(message),
  });

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
    const { session, release } = await leaseWriteSession(source, URL_, 'POST');
    expect(mockMade).toHaveLength(1);
    expect(session).toBe(mockMade[0]);
    expect(session.partition).toMatch(/^freedom-ant-write-\d+$/);
    expect(session.options).toEqual({ cache: false });
    expect(source.resolveProxy).toHaveBeenCalledWith(URL_);
    expect(session.pac).toBe(`function FindProxyForURL(url, host) { return "${SOCKS}"; }`);
    // As it is made, before anything can go out: the spell checker's
    // dictionary never fetched, and its guard on. Then the proxy set, the
    // connections closed, and the proxy read back.
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledWith([]);
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
    expect(session.calls).toEqual([
      'spellCheckerLanguages',
      'spellCheckerEnabled',
      'guard',
      'setProxy',
      'forceReloadProxyConfig',
      'closeAllConnections',
      'resolveProxy',
    ]);
    release();
  });

  test('every lease closes its connections; the proxy is set again only when it changed', async () => {
    const source = requestSession();
    const first = await leaseWriteSession(source, URL_, 'POST');
    first.release();
    const second = await leaseWriteSession(source, URL_, 'POST');
    expect(second.session).toBe(first.session);
    expect(second.session.calls.slice(7)).toEqual(['closeAllConnections', 'resolveProxy']);
    second.release();

    // Tor stopped: the request session now resolves the node DIRECT.
    source.proxy = 'DIRECT';
    const third = await leaseWriteSession(source, URL_, 'POST');
    expect(third.session).toBe(first.session);
    expect(third.session.calls.slice(9)).toEqual([
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
    const { session, release } = await leaseWriteSession(requestSession(chain), URL_, 'POST');
    expect(await session.resolveProxy(URL_)).toBe(chain);
    release();
  });

  test('a proxy it does not read back fails the lease, undialled, and is set again next time', async () => {
    const source = requestSession();
    const first = await leaseWriteSession(source, URL_, 'POST');
    first.release();
    first.session.resolveProxy.mockResolvedValueOnce('DIRECT');
    const refusal = leaseWriteSession(source, URL_, 'POST');
    await expect(refusal).rejects.toThrow(
      `a write session resolves its proxy as DIRECT, its request session as ${SOCKS}: not dialled`
    );
    await expect(refusal).rejects.toBeInstanceOf(AntNotDialled);
    // Handed back, its proxy unknown: the next lease sets it again.
    await new Promise(setImmediate);
    const next = await leaseWriteSession(source, URL_, 'POST');
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
    const failure = new Error('session.resolveProxy failed');
    source.resolveProxy.mockRejectedValueOnce(failure);
    const refusal = leaseWriteSession(source, URL_, 'POST');
    await expect(refusal).rejects.toEqual(notDialled('session.resolveProxy failed'));
    await expect(refusal).rejects.toHaveProperty('cause', failure);
    expect(mockMade[0].calls).toEqual(['spellCheckerLanguages', 'spellCheckerEnabled', 'guard']);
  });

  test.each(['setProxy', 'forceReloadProxyConfig', 'closeAllConnections'])(
    'a %s that fails fails the lease as not dialled',
    async (call) => {
      const source = requestSession();
      const first = await leaseWriteSession(source, URL_, 'POST');
      first.release();
      // Another proxy, so the lease sets it again.
      source.proxy = 'PROXY 127.0.0.1:3128';
      first.session[call].mockRejectedValueOnce(new Error(`${call} failed`));
      await expect(leaseWriteSession(source, URL_, 'POST')).rejects.toEqual(
        notDialled(`${call} failed`)
      );
    }
  );

  test('no request session: the default session is the one whose proxy it takes', async () => {
    mockDefaultSession.resolveProxy.mockResolvedValueOnce(SOCKS);
    const { session, release } = await leaseWriteSession(null, URL_, 'POST');
    expect(mockDefaultSession.resolveProxy).toHaveBeenCalledWith(URL_);
    expect(await session.resolveProxy(URL_)).toBe(SOCKS);
    release();
  });
});

// Nothing goes out of a write session but its lease's one write.
describe("a write session's guard", () => {
  const OTHER = 'http://ant.example.test:1633/pss/send/topic/cd';
  const DICTIONARY = 'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic';

  test('refuses everything until a lease is ready, then admits that one write once', async () => {
    const source = requestSession();
    let settle;
    source.resolveProxy.mockImplementationOnce(
      () => new Promise((resolve) => (settle = () => resolve(SOCKS)))
    );
    const leasing = leaseWriteSession(source, URL_, 'POST');
    const [ses] = mockMade;
    // Made and guarded, not yet ready: nothing goes, the write included.
    expect(await ses.sends('POST', URL_)).toBe(false);
    expect(await ses.sends('GET', DICTIONARY)).toBe(false);
    settle();
    const { release } = await leasing;
    expect(await ses.sends('GET', DICTIONARY)).toBe(false);
    expect(await ses.sends('POST', OTHER)).toBe(false);
    expect(await ses.sends('GET', URL_)).toBe(false);
    // The leased write, as Chromium reports its URL, once.
    expect(await ses.sends('POST', URL_)).toBe(true);
    expect(await ses.sends('POST', URL_)).toBe(false);
    release();
  });

  test("the lease's end disarms it, unspent; the next lease arms it for its own write only", async () => {
    const source = requestSession();
    const first = await leaseWriteSession(source, URL_, 'POST');
    const ses = first.session;
    first.release();
    expect(await ses.sends('POST', URL_)).toBe(false);
    const second = await leaseWriteSession(source, OTHER, 'POST');
    expect(second.session).toBe(ses);
    expect(await ses.sends('POST', URL_)).toBe(false);
    expect(await ses.sends('POST', OTHER)).toBe(true);
    second.release();
  });

  test('a URL is matched as the Ant guard matches announcements: canonical, without its fragment', async () => {
    const raw = 'http://Ant.example.test:1633/bzz?name=a b.tar#x';
    const { session, release } = await leaseWriteSession(requestSession(), raw, 'POST');
    expect(await session.sends('POST', 'http://ant.example.test:1633/bzz?name=a%20b.tar')).toBe(
      true
    );
    release();
  });

  test("a PUT is a write too (ant-storage-api's swap switch): admitted once, as itself only", async () => {
    const swap = 'http://ant.example.test:1633/v0/settlement/swap';
    const { session, release } = await leaseWriteSession(requestSession(), swap, 'PUT');
    expect(await session.sends('POST', swap)).toBe(false);
    expect(await session.sends('PUT', OTHER)).toBe(false);
    expect(await session.sends('PUT', swap)).toBe(true);
    expect(await session.sends('PUT', swap)).toBe(false);
    release();
  });

  test.each(['GET', 'HEAD', 'DELETE', 'PATCH', 'OPTIONS', 'put', undefined])(
    'a lease for %s is refused before it takes or makes a session',
    async (method) => {
      const source = requestSession();
      await expect(leaseWriteSession(source, URL_, method)).rejects.toEqual(
        notDialled(`a write session carries a POST or a PUT (got ${method})`)
      );
      expect(mockMade).toHaveLength(0);
      expect(source.resolveProxy).not.toHaveBeenCalled();
    }
  );

  test('a lease that fails leaves it disarmed', async () => {
    const source = requestSession();
    const first = await leaseWriteSession(source, URL_, 'POST');
    first.release();
    first.session.resolveProxy.mockResolvedValueOnce('DIRECT');
    await expect(leaseWriteSession(source, URL_, 'POST')).rejects.toThrow('not dialled');
    expect(await first.session.sends('POST', URL_)).toBe(false);
  });
});

describe('the pool', () => {
  test(`concurrent writes each get a session of their own, up to ${MAX_WRITE_SESSIONS}; the next waits its turn`, async () => {
    const source = requestSession();
    const leases = await Promise.all(
      Array.from({ length: MAX_WRITE_SESSIONS }, () => leaseWriteSession(source, URL_, 'POST'))
    );
    expect(new Set(leases.map((l) => l.session)).size).toBe(MAX_WRITE_SESSIONS);
    expect(mockMade).toHaveLength(MAX_WRITE_SESSIONS);

    const order = [];
    const ninth = leaseWriteSession(source, URL_, 'POST').then((l) => {
      order.push('ninth');
      return l;
    });
    const tenth = leaseWriteSession(source, URL_, 'POST').then((l) => {
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
      Array.from({ length: MAX_WRITE_SESSIONS }, () => leaseWriteSession(source, URL_, 'POST'))
    );
    const abort = new AbortController();
    const waiting = leaseWriteSession(source, URL_, 'POST', abort.signal);
    const after = leaseWriteSession(source, URL_, 'POST');
    abort.abort();
    await expect(waiting).rejects.toThrow('This operation was aborted');
    leases[0].release();
    expect((await after).session).toBe(leases[0].session);
    await expect(
      leaseWriteSession(source, URL_, 'POST', AbortSignal.abort())
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  test("each request session has its own: a private window's writes share none with the default session's", async () => {
    const a = await leaseWriteSession(requestSession(), URL_, 'POST');
    a.release();
    const b = await leaseWriteSession(requestSession(), URL_, 'POST');
    expect(b.session).not.toBe(a.session);
    b.release();
  });

  test('a preparation that never settles fails the write in time and keeps its session until it does', async () => {
    jest.useFakeTimers();
    const source = requestSession();
    const first = await leaseWriteSession(source, URL_, 'POST');
    first.release();
    let settle;
    first.session.closeAllConnections.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve))
    );
    const stuck = leaseWriteSession(source, URL_, 'POST');
    const failed = expect(stuck).rejects.toEqual(
      notDialled('a write session was not ready in time: not dialled')
    );
    await jest.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);
    await failed;
    // Still held: the next write gets another session.
    const other = await leaseWriteSession(source, URL_, 'POST');
    expect(other.session).not.toBe(first.session);
    other.release();
    // Back once its call settles.
    settle();
    await jest.advanceTimersByTimeAsync(0);
    const again = await leaseWriteSession(source, URL_, 'POST');
    expect([first.session, other.session]).toContain(again.session);
    again.release();
  });
});
