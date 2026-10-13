// The handler asks the core for a plan (freedom-core design 0006,
// `dweb.open`) and executes it. The URL, host and header decisions are the
// core's, pinned by fc-dweb's vectors; here the core is played by
// `test/helpers/fake-dweb-core.js`, which plans as fc-dweb does, and these
// cases cover what main does with the plans: the dial, the retry loop, the
// response operations and the log.
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external' },
  getAntApiUrl: jest.fn(() => 'http://127.0.0.1:1633'),
  getService: () => ({ mode: 'bundled' }),
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Prefix required by Jest's mock-factory hoisting: the factory runs before
// regular `const` initialisation, so any captured variable must start with
// `mock` to survive the static analyser.
const mockResolveEnsContent = jest.fn();
const {
  createFakeDwebDriver,
  BZZ_RETRY_DELAYS_MS: RETRY_DELAYS_MS,
  BZZ_HEADERS_MS,
} = require('../../../test/helpers/fake-dweb-core');
const mockDriver = createFakeDwebDriver({
  resolveContent: (...args) => mockResolveEnsContent(...args),
});
jest.mock('../core/naming', () => ({ namingDriver: () => mockDriver }));

// A remote Ant is dialled on the session's stack (Chromium's `net.request`).
const mockNetGatewayFetch = jest.fn();
jest.mock('../ipfs/gateway-transport', () => ({
  ...jest.requireActual('../ipfs/gateway-transport'),
  netGatewayFetch: (...args) => mockNetGatewayFetch(...args),
}));

const { handleBzzRequest, antBackend } = require('./bzz-protocol');
const { getAntApiUrl } = require('../service-registry');
const { isMainProcessAntDial } = require('./ant-api-main-dials');
const { OnionGateRefusal } = jest.requireActual('../ipfs/gateway-transport');

const HASH = 'a'.repeat(64);

describe('handleBzzRequest', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
  });

  const makeRequest = (url, { method = 'GET', headers = {} } = {}) => ({
    url,
    method,
    headers: new Headers(headers),
    body: null,
    signal: new AbortController().signal,
  });

  test('returns 400 for invalid bzz refs without calling fetch', async () => {
    const fetchImpl = jest.fn();
    const res = await handleBzzRequest(makeRequest('bzz://not-a-hash/'), { fetchImpl });
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('resolves ENS-host bzz URLs and proxies to the gateway', async () => {
    mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'bzz',
      decoded: HASH,
      uri: `bzz://${HASH}`,
    });
    const fetchImpl = jest.fn().mockResolvedValue(new Response('hello', { status: 200 }));

    const res = await handleBzzRequest(makeRequest('bzz://meinhard.eth/index.html'), { fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:1633/bzz/${HASH}/index.html`);
  });

  test('returns 404 with explanatory body when ENS host has IPFS contenthash', async () => {
    mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'ipfs',
      decoded: 'QmFakeCid',
    });
    const fetchImpl = jest.fn();

    const res = await handleBzzRequest(makeRequest('bzz://vitalik.eth/'), { fetchImpl });
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe(404);
    expect(body.message).toMatch(/resolves to ipfs/);
  });

  test('returns 502 when the ENS resolver throws (no fetch issued)', async () => {
    mockResolveEnsContent.mockRejectedValue(new Error('rpc down'));
    const fetchImpl = jest.fn();

    const res = await handleBzzRequest(makeRequest('bzz://offline.eth/x'), { fetchImpl });
    expect(res.status).toBe(502);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('proxies a 200 through untouched', async () => {
    const body = new Response('hello').body;
    const fetchImpl = jest.fn().mockResolvedValue(new Response(body, { status: 200 }));
    const res = await handleBzzRequest(makeRequest(`bzz://${HASH}/file.txt`), { fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe(`http://127.0.0.1:1633/bzz/${HASH}/file.txt`);
    expect(init.method).toBe('GET');
    expect(init.headers.get('Swarm-Chunk-Retrieval-Timeout')).toBe('30s');
  });

  test('does not retry 404 — fails fast so SPAs can fall back', async () => {
    // 404 used to be retryable to absorb cold-Bee transient misses, but the
    // navigation probe in swarm-probe.js now handles cold-start upstream,
    // so subresource 404s should surface immediately. Otherwise an SPA
    // that feature-detects a missing endpoint hangs ~50s per miss.
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 404 }));
    const res = await handleBzzRequest(makeRequest(`bzz://${HASH}/x`), { fetchImpl });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('retries transient 5xx', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const p = handleBzzRequest(makeRequest(`bzz://${HASH}/x`), { fetchImpl });
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + 10);
      const res = await p;
      expect(res.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  // Security audit O-2 (#429): `bzz:` is read-only, like `rad:`. Chromium
  // enforces no CORS on a custom scheme, so any page could otherwise POST /
  // PUT / DELETE through this handler with the node's authority.
  test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post'])(
    'refuses %s with 405 without contacting the node',
    async (method) => {
      const fetchImpl = jest.fn();
      const req = {
        url: `bzz://${HASH}/x`,
        method,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: new Response('{"x":1}').body,
        signal: new AbortController().signal,
      };
      const res = await handleBzzRequest(req, { fetchImpl });
      expect(res.status).toBe(405);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  test('forwards HEAD (and GET) to the node', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const res = await handleBzzRequest(makeRequest(`bzz://${HASH}/x`, { method: 'HEAD' }), {
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl.mock.calls[0][1].method).toBe('HEAD');
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });

  // O-2: an encoded separator could steer the node's router out of
  // `/bzz/<ref>/` after we already picked the ref.
  test.each([
    `bzz://${HASH}/..%2F..%2Fstamps`,
    `bzz://${HASH}/a%2fb`,
    `bzz://${HASH}/a%5Cb`,
    `bzz://${HASH}/a%5cb`,
    'bzz://meinhard.eth/..%2Fwallet',
  ])('refuses encoded path separators: %s', async (url) => {
    const fetchImpl = jest.fn();
    const res = await handleBzzRequest(makeRequest(url), { fetchImpl });
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('still serves ordinary percent-encoded paths', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await handleBzzRequest(makeRequest(`bzz://${HASH}/my%20file%2Etxt?q=%2F`), {
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `http://127.0.0.1:1633/bzz/${HASH}/my%20file%2Etxt?q=%2F`
    );
  });

  test('forwards only allowlisted request headers to the node', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('ok', { status: 206 }));
    await handleBzzRequest(
      makeRequest(`bzz://${HASH}/video.mp4`, {
        headers: {
          Range: 'bytes=0-99',
          'If-None-Match': '"abc"',
          'If-Modified-Since': 'Tue, 01 Sep 2026 00:00:00 GMT',
          Accept: 'video/*',
          'Accept-Language': 'de',
          'Swarm-Act': 'true',
          'Swarm-Act-Publisher': '02ab',
          'Swarm-Act-History-Address': 'ff',
          'Swarm-Postage-Batch-Id': 'deadbeef',
          'Swarm-Pin': 'true',
          'X-Custom': '1',
          'Content-Type': 'text/plain',
        },
      }),
      { fetchImpl }
    );
    const sent = fetchImpl.mock.calls[0][1].headers;
    expect(sent.get('range')).toBe('bytes=0-99');
    expect(sent.get('if-none-match')).toBe('"abc"');
    expect(sent.get('if-modified-since')).toBe('Tue, 01 Sep 2026 00:00:00 GMT');
    expect(sent.get('accept')).toBe('video/*');
    expect(sent.get('accept-language')).toBe('de');
    const names = [...sent.keys()];
    expect(names.filter((n) => n.startsWith('swarm-')).sort()).toEqual([
      'swarm-chunk-retrieval-timeout',
      'swarm-redundancy-fallback-mode',
      'swarm-redundancy-strategy',
    ]);
    expect(sent.has('x-custom')).toBe(false);
    expect(sent.has('content-type')).toBe(false);
  });

  test('a page cannot override the retrieval hints we set', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await handleBzzRequest(
      makeRequest(`bzz://${HASH}/x`, {
        headers: { 'Swarm-Chunk-Retrieval-Timeout': '999h', 'Swarm-Redundancy-Strategy': '0' },
      }),
      { fetchImpl }
    );
    const sent = fetchImpl.mock.calls[0][1].headers;
    expect(sent.get('swarm-chunk-retrieval-timeout')).toBe('30s');
    expect(sent.get('swarm-redundancy-strategy')).toBe('3');
  });

  // O-12 (#439): a user-configured external Ant gateway's cookies and
  // service-worker scope never reach the bzz:// page.
  test('strips Set-Cookie and Service-Worker-Allowed from the upstream response', async () => {
    const upstreamHeaders = new Headers({
      'Content-Type': 'text/html',
      'Service-Worker-Allowed': '/',
      ETag: '"v1"',
    });
    upstreamHeaders.append('Set-Cookie', 'track=1; Path=/');
    upstreamHeaders.append('Set-Cookie', 'other=2');
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('<p>hi</p>', { status: 200, headers: upstreamHeaders }));
    const res = await handleBzzRequest(makeRequest(`bzz://${HASH}/index.html`), { fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('service-worker-allowed')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('etag')).toBe('"v1"');
    await expect(res.text()).resolves.toBe('<p>hi</p>');
  });

  test('strips page-state headers from a 304 and a rewritten redirect too', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { 'Set-Cookie': 'a=1' } }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 308,
          headers: { location: `/bzz/${HASH}/blog/`, 'Set-Cookie': 'a=1' },
        })
      );
    const notModified = await handleBzzRequest(makeRequest(`bzz://${HASH}/x`), { fetchImpl });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('set-cookie')).toBeNull();
    const redirect = await handleBzzRequest(makeRequest(`bzz://${HASH}/blog`), { fetchImpl });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('./blog/');
    expect(redirect.headers.get('set-cookie')).toBeNull();
  });

  test('does not retry permanent non-retryable statuses (e.g. 403)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 403 }));
    const res = await handleBzzRequest(makeRequest(`bzz://${HASH}/x`), { fetchImpl });
    expect(res.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('returns 503 when Bee is unreachable (ECONNREFUSED)', async () => {
    const err = new Error('connect failed');
    err.code = 'ECONNREFUSED';
    // Fail forever with ECONNREFUSED so every retry slot gets used.
    const fetchImpl = jest.fn().mockRejectedValue(err);

    jest.useFakeTimers();
    try {
      const p = handleBzzRequest(makeRequest(`bzz://${HASH}/x`), { fetchImpl });
      // Drain each retry delay.
      for (const d of RETRY_DELAYS_MS) {
        await Promise.resolve();
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(d + 1);
      }
      const res = await p;
      expect(res.status).toBe(503);
    } finally {
      jest.useRealTimers();
    }
  });

  test('per-attempt timeout aborts a stalled fetch and advances the retry loop', async () => {
    jest.useFakeTimers();
    try {
      // First attempt: fetch hangs forever unless its signal aborts.
      // Second attempt: succeeds immediately.
      const fetchImpl = jest
        .fn()
        .mockImplementationOnce(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener(
                'abort',
                () => {
                  const err = new Error('aborted');
                  err.name = 'AbortError';
                  reject(err);
                },
                { once: true }
              );
            })
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const p = handleBzzRequest(makeRequest(`bzz://${HASH}/x`), { fetchImpl });

      // Drain microtasks, then trip the plan's per-attempt timeout.
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(BZZ_HEADERS_MS + 100);
      // The error from the aborted fetch should now be flowing through the
      // retry loop. Advance past the first retry delay.
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + 10);
      const res = await p;

      expect(res.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('aborted request bails out without exhausting all retries', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 503 }));
      const controller = new AbortController();
      const req = {
        url: `bzz://${HASH}/x`,
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: controller.signal,
      };
      const p = handleBzzRequest(req, { fetchImpl });
      // First attempt runs, schedules a retry, then we abort before it fires.
      while (fetchImpl.mock.calls.length === 0) await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();
      await jest.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + 10);
      const res = await p;
      // The handler returns the last observed 503 since abort interrupts
      // the backoff but doesn't synthesize a new response.
      expect(res.status).toBe(503);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

// PRIVATE MODE GUARD (request logging). The handler is registered once per
// session, so a private window's session gets its own registration — these
// assert that registration is what decides whether the persistent
// <userData>/logs/main.log records where the tab went.
describe('registerBzzProtocol private sessions', () => {
  const log = require('../logger');
  const { registerBzzProtocol } = require('./bzz-protocol');

  function fakeSession() {
    const handlers = new Map();
    return {
      handlers,
      protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) },
    };
  }

  function loggedText() {
    return [log.info, log.warn, log.error]
      .flatMap((fn) => fn.mock.calls)
      .map((call) => call.join(' '))
      .join('\n');
  }

  const makeRequest = (url) => ({
    url,
    method: 'GET',
    headers: new Headers(),
    body: null,
    signal: new AbortController().signal,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveEnsContent.mockReset();
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
  });

  test('a private session redacts the request URL and the resolved name', async () => {
    mockResolveEnsContent.mockRejectedValue(new Error('rpc down'));
    const session = fakeSession();
    registerBzzProtocol(session, { privatePartition: 'private-abcd' });

    await session.handlers.get('bzz')(makeRequest('bzz://secret-site.eth/page.html'));

    const text = loggedText();
    expect(text).not.toContain('secret-site.eth');
    expect(text).not.toContain('page.html');
    expect(text).not.toContain('rpc down');
    // Still says a bzz request failed — just not which one. (The resolver
    // runs in the core now, which logs no URL.)
    expect(text).toContain('502 for bzz://<private>: <private>');
  });

  // Every resolution failure whose page-facing message names the site. The
  // request URL is redacted at the log site, so these are the branches that
  // could still smuggle the destination into main.log via the message.
  const NAME_BEARING_FAILURES = [
    ['no contenthash', { type: 'not_found', reason: 'NO_CONTENTHASH' }, 404],
    ['a non-Swarm contenthash', { type: 'ok', protocol: 'ipfs', decoded: 'QmX' }, 404],
    ['an unsupported codec', { type: 'unsupported', reason: 'UNSUPPORTED' }, 415],
    ['disagreeing providers', { type: 'conflict', groups: [] }, 502],
    [
      'a resolver error naming the site',
      { type: 'error', error: 'no provider answered for secret-site.eth' },
      502,
    ],
  ];

  test.each(NAME_BEARING_FAILURES)(
    'a private session keeps the name out of the log on %s',
    async (_label, resolution, status) => {
      mockResolveEnsContent.mockResolvedValue(resolution);
      const session = fakeSession();
      registerBzzProtocol(session, { privatePartition: 'private-abcd' });

      const res = await session.handlers.get('bzz')(makeRequest('bzz://secret-site.eth/page.html'));

      expect(res.status).toBe(status);
      // The page still gets the full explanation — it already knows where
      // it went; only the persistent log must not.
      await expect(res.json()).resolves.toMatchObject({ code: status });
      const text = loggedText();
      expect(text).not.toContain('secret-site.eth');
      expect(text).not.toContain('page.html');
      expect(text).toContain(`${status} for bzz://<private>`);
    }
  );

  test.each(NAME_BEARING_FAILURES)(
    'a normal session keeps the full diagnostic on %s',
    async (_label, resolution) => {
      mockResolveEnsContent.mockResolvedValue(resolution);
      const session = fakeSession();
      registerBzzProtocol(session);

      await session.handlers.get('bzz')(makeRequest('bzz://public-site.eth/page.html'));

      const text = loggedText();
      expect(text).toContain('bzz://public-site.eth/page.html');
      expect(text).toContain('public-site.eth');
    }
  );

  test('a normal session keeps the full diagnostic URL', async () => {
    mockResolveEnsContent.mockRejectedValue(new Error('rpc down'));
    const session = fakeSession();
    registerBzzProtocol(session);

    await session.handlers.get('bzz')(makeRequest('bzz://public-site.eth/page.html'));

    expect(loggedText()).toContain('bzz://public-site.eth/page.html');
  });

  test('a private session redacts a Swarm ref that only the message carries', async () => {
    getAntApiUrl.mockReturnValue(null);
    const hash = 'c'.repeat(64);
    const session = fakeSession();
    registerBzzProtocol(session, { privatePartition: 'private-abcd' });

    const res = await session.handlers.get('bzz')(makeRequest(`bzz://${hash}/index.html`));

    expect(res.status).toBe(503);
    const text = loggedText();
    expect(text).not.toContain(hash);
    // A failure with nothing browsing-identifying to hide still logs its
    // reason, so "node not ready" stays diagnosable in a private window.
    expect(text).toContain('503 for bzz://<private>: Swarm node is not ready');
  });

  test('the gateway URL is redacted to its origin when the fetch fails', async () => {
    const { runWithPrivateLogContext } = require('../private/private-log-context');
    const hash = 'b'.repeat(64);
    const err = new Error('connect failed');
    err.code = 'ECONNREFUSED';
    const fetchImpl = jest.fn().mockRejectedValue(err);

    jest.useFakeTimers();
    try {
      const p = runWithPrivateLogContext(true, () =>
        handleBzzRequest(makeRequest(`bzz://${hash}/index.html`), { fetchImpl })
      );
      for (const d of RETRY_DELAYS_MS) {
        await Promise.resolve();
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(d + 1);
      }
      await p;
    } finally {
      jest.useRealTimers();
    }

    const text = loggedText();
    expect(text).not.toContain(hash);
    expect(text).toContain('fetch failed for http://127.0.0.1:1633/<private>');
  });
});

// Bee canonicalises a directory URL with a redirect written in its own gateway
// URL space (`/bzz/<ref>/blog/`). Chromium resolves that against the `bzz://`
// request URL it issued, so passing it through verbatim commits
// `bzz://meinhard.eth/bzz/<resolved-hash>/blog/` — a doubled path that 404s and
// leaks the resolved manifest hash into the address bar, `window.location` and
// the storage origin (#95). The handler re-expresses the target as a relative
// reference, which resolves identically in gateway space and in `bzz://` space.
describe('handleBzzRequest redirect canonicalisation', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
  });

  const ensResolvesTo = (decoded, extra = {}) =>
    mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'bzz',
      decoded,
      uri: `bzz://${decoded}`,
      ...extra,
    });

  // Drive the real handler and report what Chromium would commit: the
  // `Location` it hands back, resolved against the `bzz://` URL that was
  // requested — the exact resolution step the bug report reproduces.
  const redirectCase = async (bzzUrl, { status = 301, location, headers = {} } = {}) => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response(null, { status, headers: { location, ...headers } }));
    const res = await handleBzzRequest(
      {
        url: bzzUrl,
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      },
      { fetchImpl }
    );
    const out = res.headers.get('location');
    return {
      status: res.status,
      location: out,
      committed: out ? new URL(out, bzzUrl).toString() : null,
      gatewayUrl: fetchImpl.mock.calls[0][0],
    };
  };

  test("rewrites Bee's hash-rooted directory 301 back into ENS space", async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/blog', { location: `/bzz/${HASH}/blog/` })
    ).resolves.toEqual({
      status: 301,
      location: './blog/',
      committed: 'bzz://meinhard.eth/blog/',
      gatewayUrl: `http://127.0.0.1:1633/bzz/${HASH}/blog`,
    });
  });

  // Bee's own directory canonicalisation is a 308, not a 301 (`pkg/api/bzz.go`
  // calls `http.Redirect(..., StatusPermanentRedirect)`), so the status Bee
  // actually sends is covered explicitly rather than only the 301 shape the
  // issue's report named.
  test("rewrites Bee's 308 directory canonicalisation", async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/blog', { status: 308, location: `/bzz/${HASH}/blog/` })
    ).resolves.toMatchObject({
      status: 308,
      location: './blog/',
      committed: 'bzz://meinhard.eth/blog/',
    });
  });

  test('rewrites a nested directory redirect', async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/blog/2026/posts', {
        location: `/bzz/${HASH}/blog/2026/posts/`,
      })
    ).resolves.toMatchObject({
      location: './posts/',
      committed: 'bzz://meinhard.eth/blog/2026/posts/',
    });
  });

  // Go escapes `!'()*[]|^` in a path where Chromium leaves them literal, and
  // Bee's canonicalisation re-escapes through `EscapedPath()` because appending
  // the slash invalidates the request's `RawPath`. So the `Location` for a
  // directory under such a parent is spelled differently from the gateway path
  // the handler asked for (verified against go1.26.5's own `net/url` +
  // `net/http.Redirect`), and a raw-bytes prefix test reads it as leaving the
  // request's directory and passes it through — back to the doubled path and
  // leaked hash for exactly these names.
  test('rewrites a redirect whose parent segment Bee re-escaped', async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/photos(2024)/blog', {
        status: 308,
        location: `/bzz/${HASH}/photos%282024%29/blog/`,
      })
    ).resolves.toEqual({
      status: 308,
      location: './blog/',
      committed: 'bzz://meinhard.eth/photos(2024)/blog/',
      gatewayUrl: `http://127.0.0.1:1633/bzz/${HASH}/photos(2024)/blog`,
    });
  });

  test('keeps the query string on the rewritten Location', async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/blog?page=2', { location: `/bzz/${HASH}/blog/?page=2` })
    ).resolves.toMatchObject({
      location: './blog/?page=2',
      committed: 'bzz://meinhard.eth/blog/?page=2',
    });
  });

  test('rewrites a same-origin absolute Location too', async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/blog', {
        status: 302,
        location: `http://127.0.0.1:1633/bzz/${HASH}/blog/`,
      })
    ).resolves.toMatchObject({
      status: 302,
      location: './blog/',
      committed: 'bzz://meinhard.eth/blog/',
    });
  });

  test('accounts for a contenthash base path, which never belongs in the URL', async () => {
    ensResolvesTo(HASH, { basePath: '/site' });

    await expect(
      redirectCase('bzz://meinhard.eth/blog', { location: `/bzz/${HASH}/site/blog/` })
    ).resolves.toEqual({
      status: 301,
      location: './blog/',
      committed: 'bzz://meinhard.eth/blog/',
      gatewayUrl: `http://127.0.0.1:1633/bzz/${HASH}/site/blog`,
    });
  });

  // A hash host is its own canonical form: there is no name to restore, and the
  // rewrite must not invent one or drop the trailing slash Bee is asking for.
  test('leaves a hash-host redirect pointing at the same hash host', async () => {
    await expect(
      redirectCase(`bzz://${HASH}/blog`, { location: `/bzz/${HASH}/blog/` })
    ).resolves.toEqual({
      status: 301,
      location: './blog/',
      committed: `bzz://${HASH}/blog/`,
      gatewayUrl: `http://127.0.0.1:1633/bzz/${HASH}/blog`,
    });
  });

  // Already expressed relative to the request: the rewrite is a no-op, and
  // re-running it must not double up the `./` prefix.
  test('is idempotent on an already-canonical relative Location', async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/blog', { location: './blog/' })
    ).resolves.toMatchObject({
      location: './blog/',
      committed: 'bzz://meinhard.eth/blog/',
    });
  });

  // `:` is a legal Swarm manifest path segment, and a *bare* relative reference
  // starting with one parses as an absolute URL with that segment as its scheme
  // (RFC 3986 §4.2), so the `./` prefix is load-bearing, not cosmetic.
  test('keeps a colon-bearing first segment from parsing as a scheme', async () => {
    ensResolvesTo(HASH);

    const { location, committed } = await redirectCase('bzz://meinhard.eth/re:port', {
      location: `/bzz/${HASH}/re:port/`,
    });
    expect(location).toBe('./re:port/');
    expect(committed).toBe('bzz://meinhard.eth/re:port/');
  });

  // Can't be expressed relative to the request's directory without knowing how
  // deep the `/bzz/<ref>` prefix goes, so it is passed through exactly as Bee
  // wrote it rather than guessed at.
  test('leaves a Location that climbs out of the requested path untouched', async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/blog', { location: `/bzz/${'b'.repeat(64)}/blog/` })
    ).resolves.toMatchObject({ location: `/bzz/${'b'.repeat(64)}/blog/` });
  });

  // A hostile or MITM'd gateway must not get its cross-origin target rewritten
  // into the bzz:// origin — Chromium applies the normal cross-origin rules.
  test('leaves a cross-origin Location untouched', async () => {
    ensResolvesTo(HASH);

    await expect(
      redirectCase('bzz://meinhard.eth/blog', { location: 'http://127.0.0.1:5000/secret' })
    ).resolves.toMatchObject({ location: 'http://127.0.0.1:5000/secret' });
  });

  test('drops upstream body framing headers on the rewritten redirect', async () => {
    ensResolvesTo(HASH);
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('moved', {
        status: 301,
        headers: {
          location: `/bzz/${HASH}/blog/`,
          'content-length': '5',
          'content-type': 'text/plain',
        },
      })
    );
    const res = await handleBzzRequest(
      {
        url: 'bzz://meinhard.eth/blog',
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      },
      { fetchImpl }
    );
    expect(res.headers.get('location')).toBe('./blog/');
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/plain');
    await expect(res.text()).resolves.toBe('');
  });

  test('leaves a non-3xx response with a Location header alone', async () => {
    ensResolvesTo(HASH);
    const body = 'created';
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 201, headers: { location: `/bzz/${HASH}/blog/` } })
      );
    const res = await handleBzzRequest(
      {
        url: 'bzz://meinhard.eth/blog',
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      },
      { fetchImpl }
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe(`/bzz/${HASH}/blog/`);
    await expect(res.text()).resolves.toBe(body);
  });

  test('passes a 3xx without a Location through untouched', async () => {
    ensResolvesTo(HASH);
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const res = await handleBzzRequest(
      {
        url: 'bzz://meinhard.eth/blog',
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      },
      { fetchImpl }
    );
    expect(res.status).toBe(304);
    expect(res.headers.get('location')).toBeNull();
  });
});

// Design 0006, deviation `transport` (#360): a non-loopback Ant is dialled on
// the request's session, with manual redirects and the onion refusal, and the
// exact dial is announced to the Ant API guard for its lifetime.
describe('a non-loopback Ant', () => {
  const REMOTE = 'https://ant.example:1633';
  const session = { id: 'the request session' };
  const request = (url) => ({
    url,
    method: 'GET',
    headers: new Headers({ accept: '*/*' }),
    body: null,
    signal: new AbortController().signal,
  });

  beforeEach(() => {
    mockNetGatewayFetch.mockReset();
    getAntApiUrl.mockReturnValue(REMOTE);
  });
  afterEach(() => {
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    jest.useRealTimers();
  });

  test("goes out on the request's session, announced to the guard only while it dials", async () => {
    const dialled = `${REMOTE}/bzz/${HASH}/index.html`;
    let announced = null;
    mockNetGatewayFetch.mockImplementation(async (url) => {
      announced = isMainProcessAntDial(url);
      return new Response('remote content');
    });
    const fetchImpl = jest.fn();

    const res = await handleBzzRequest(request(`bzz://${HASH}/index.html`), {
      session,
      fetchImpl,
    });

    await expect(res.text()).resolves.toBe('remote content');
    expect(fetchImpl).not.toHaveBeenCalled();
    const [url, init, deps] = mockNetGatewayFetch.mock.calls[0];
    expect(url).toBe(dialled);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(deps).toEqual({ session });
    expect(announced).toBe(true);
    // Released once the dial settled: nothing frameless is let through after.
    expect(isMainProcessAntDial(dialled)).toBe(false);
  });

  test("a refused connection is Chromium's, read as undici's: 503 after the schedule", async () => {
    jest.useFakeTimers();
    mockNetGatewayFetch.mockImplementation(async (url) => {
      expect(isMainProcessAntDial(url)).toBe(true);
      throw new Error('net::ERR_CONNECTION_REFUSED');
    });
    const pending = handleBzzRequest(request(`bzz://${HASH}/x`), { session });
    await jest.advanceTimersByTimeAsync(RETRY_DELAYS_MS.reduce((a, b) => a + b));
    const res = await pending;
    expect(mockNetGatewayFetch).toHaveBeenCalledTimes(10);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 503, message: 'bee gateway unreachable' });
    expect(isMainProcessAntDial(`${REMOTE}/bzz/${HASH}/x`)).toBe(false);
  });

  test('an onion Ant the session would resolve DIRECT is never dialled, and is retried', async () => {
    jest.useFakeTimers();
    getAntApiUrl.mockReturnValue('http://antnode.onion:1633');
    mockNetGatewayFetch
      .mockRejectedValueOnce(new OnionGateRefusal('not routed'))
      .mockResolvedValueOnce(new Response('over tor'));
    const pending = handleBzzRequest(request(`bzz://${HASH}/x`), { session });
    await jest.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await expect((await pending).text()).resolves.toBe('over tor');
  });

  test("a loopback Ant keeps Node's fetch, outside the session", async () => {
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const fetchImpl = jest.fn(async () => new Response('local'));
    const res = await handleBzzRequest(request(`bzz://${HASH}/x`), { session, fetchImpl });
    await expect(res.text()).resolves.toBe('local');
    expect(mockNetGatewayFetch).not.toHaveBeenCalled();
  });

  test('the backend is captured with its mode, and the core learns no URL', () => {
    expect(antBackend().ref).toEqual({ ant: 'bundled', up: true });
    getAntApiUrl.mockReturnValue(null);
    expect(antBackend().ref).toEqual({ ant: 'bundled', up: false });
  });
});
