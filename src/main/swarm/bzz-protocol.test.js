jest.mock('../service-registry', () => ({
  getAntApiUrl: jest.fn(() => 'http://127.0.0.1:1633'),
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
jest.mock('../ens-resolver', () => ({
  resolveEnsContent: (...args) => mockResolveEnsContent(...args),
}));

const {
  buildGatewayUrl,
  sanitizeRequestHeaders,
  handleBzzRequest,
  RETRY_DELAYS_MS,
} = require('./bzz-protocol');
const { getAntApiUrl } = require('../service-registry');

const HASH = 'a'.repeat(64);
const ENCRYPTED_HASH = 'a'.repeat(128);

describe('buildGatewayUrl', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
  });

  test('returns 503 when the Swarm endpoint is not hydrated', async () => {
    getAntApiUrl.mockReturnValue(null);

    await expect(buildGatewayUrl(`bzz://${HASH}/index.html`)).resolves.toMatchObject({
      ok: false,
      status: 503,
      message: 'Swarm node is not ready',
    });
  });

  test('converts bzz://<hash>/path to the Swarm gateway URL', async () => {
    await expect(buildGatewayUrl(`bzz://${HASH}/index.html`)).resolves.toEqual({
      ok: true,
      url: `http://127.0.0.1:1633/bzz/${HASH}/index.html`,
    });
  });

  test('preserves query string and drops fragment (Chromium never sends it)', async () => {
    await expect(buildGatewayUrl(`bzz://${HASH}/page?v=1`)).resolves.toEqual({
      ok: true,
      url: `http://127.0.0.1:1633/bzz/${HASH}/page?v=1`,
    });
  });

  test('supports 128-char encrypted refs', async () => {
    await expect(buildGatewayUrl(`bzz://${ENCRYPTED_HASH}/`)).resolves.toEqual({
      ok: true,
      url: `http://127.0.0.1:1633/bzz/${ENCRYPTED_HASH}/`,
    });
  });

  test('returns null for non-hex non-ENS hosts', async () => {
    await expect(buildGatewayUrl('bzz://not-a-hash/file')).resolves.toBeNull();
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('returns null for too-short hashes that are not ENS', async () => {
    await expect(buildGatewayUrl('bzz://abcdef/file')).resolves.toBeNull();
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('hex host short-circuits the ENS resolver', async () => {
    await buildGatewayUrl(`bzz://${HASH}/x`);
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  describe('ENS hosts', () => {
    test('resolves .eth host via ENS resolver and proxies to the resolved hash', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'bzz',
        decoded: HASH,
        uri: `bzz://${HASH}`,
        name: 'meinhard.eth',
      });

      await expect(buildGatewayUrl('bzz://meinhard.eth/page.html?v=1')).resolves.toEqual({
        ok: true,
        url: `http://127.0.0.1:1633/bzz/${HASH}/page.html?v=1`,
      });
      expect(mockResolveEnsContent).toHaveBeenCalledWith('meinhard.eth');
    });

    test('resolves .box host via ENS resolver', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'bzz',
        decoded: HASH,
        uri: `bzz://${HASH}`,
      });

      await expect(buildGatewayUrl('bzz://myapp.box/')).resolves.toEqual({
        ok: true,
        url: `http://127.0.0.1:1633/bzz/${HASH}/`,
      });
    });

    test('resolves .wei host via WNS resolver result', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        system: 'wns',
        protocol: 'bzz',
        decoded: HASH,
        uri: `bzz://${HASH}`,
      });

      await expect(buildGatewayUrl('bzz://alice.wei/')).resolves.toEqual({
        ok: true,
        url: `http://127.0.0.1:1633/bzz/${HASH}/`,
      });
      expect(mockResolveEnsContent).toHaveBeenCalledWith('alice.wei');
    });

    test('resolves .gwei host via GNS resolver result', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        system: 'gns',
        protocol: 'bzz',
        decoded: HASH,
        uri: `bzz://${HASH}`,
      });

      await expect(buildGatewayUrl('bzz://apoorv.gwei/')).resolves.toEqual({
        ok: true,
        url: `http://127.0.0.1:1633/bzz/${HASH}/`,
      });
      expect(mockResolveEnsContent).toHaveBeenCalledWith('apoorv.gwei');
    });

    test('returns 404 when ENS contenthash is IPFS, not Swarm', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'ipfs',
        decoded: 'QmFakeCid',
        uri: 'ipfs://QmFakeCid',
      });

      const result = await buildGatewayUrl('bzz://vitalik.eth/');
      expect(result).toMatchObject({
        ok: false,
        status: 404,
        message: 'ENS name vitalik.eth resolves to ipfs, not Swarm',
      });
    });

    test('uses WNS label for .wei transport mismatch errors', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        system: 'wns',
        protocol: 'ipfs',
        decoded: 'QmFakeCid',
        uri: 'ipfs://QmFakeCid',
      });

      const result = await buildGatewayUrl('bzz://alice.wei/');
      expect(result).toMatchObject({
        ok: false,
        status: 404,
        message: 'WNS name alice.wei resolves to ipfs, not Swarm',
      });
    });

    test('uses GNS label for .gwei transport mismatch errors', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        system: 'gns',
        protocol: 'ipfs',
        decoded: 'QmFakeCid',
        uri: 'ipfs://QmFakeCid',
      });

      const result = await buildGatewayUrl('bzz://apoorv.gwei/');
      expect(result).toMatchObject({
        ok: false,
        status: 404,
        message: 'GNS name apoorv.gwei resolves to ipfs, not Swarm',
      });
    });

    test('returns 404 when ENS contenthash is IPNS, not Swarm', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'ipns',
        decoded: 'docs.example.com',
        uri: 'ipns://docs.example.com',
      });

      const result = await buildGatewayUrl('bzz://docs.eth/install');
      expect(result).toMatchObject({
        ok: false,
        status: 404,
        message: 'ENS name docs.eth resolves to ipns, not Swarm',
      });
    });

    test('returns 404 when ENS name has no contenthash record', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'not_found',
        reason: 'NO_RESOLVER',
      });

      const result = await buildGatewayUrl('bzz://nothing.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
      expect(result.message).toContain('nothing.eth');
      expect(result.message).toContain('NO_RESOLVER');
    });

    test('returns 415 when contenthash format is unsupported', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'unsupported',
        reason: 'UNSUPPORTED_CONTENTHASH_FORMAT',
        contentHash: '0xdeadbeef',
      });

      const result = await buildGatewayUrl('bzz://exotic.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(415);
    });

    test('returns 502 when providers disagree (conflict)', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'conflict',
        groups: [],
      });

      const result = await buildGatewayUrl('bzz://contested.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.message).toContain('disagree');
    });

    test('returns 502 when the resolver throws (RPC unreachable)', async () => {
      mockResolveEnsContent.mockRejectedValue(new Error('all RPC providers failed'));

      const result = await buildGatewayUrl('bzz://offline.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.message).toContain('all RPC providers failed');
    });

    test('returns 502 when the resolver returns an error result', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'error',
        reason: 'RESOLUTION_ERROR',
        error: 'something broke',
      });

      const result = await buildGatewayUrl('bzz://broken.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
    });

    // ENS subdomains are set by the parent domain's owner with no length
    // constraint — 1–2 char leftmost labels are valid and common (e.g.
    // `a.foo.eth`, `me.brantly.eth`, `1.poap.eth`). Legacy two-char direct
    // `.eth` registrations (`me.eth`, `aa.eth`) from the 2017 auction era
    // are also still valid. The pre-filter must only reject truly empty
    // labels, not short ones.
    test.each([
      ['a.foo.eth', 'bzz://a.foo.eth/'],
      ['x.app.eth', 'bzz://x.app.eth/'],
      ['me.brantly.eth', 'bzz://me.brantly.eth/'],
      ['1.poap.eth', 'bzz://1.poap.eth/'],
      ['me.eth', 'bzz://me.eth/'],
      ['aa.eth', 'bzz://aa.eth/'],
    ])('short-label ENS host %s reaches the resolver', async (name, url) => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'bzz',
        decoded: HASH,
        uri: `bzz://${HASH}`,
        name,
      });

      const result = await buildGatewayUrl(url);
      expect(result).toEqual({ ok: true, url: `http://127.0.0.1:1633/bzz/${HASH}/` });
      expect(mockResolveEnsContent).toHaveBeenCalledWith(name);
    });

    test.each([
      ['bzz://.eth/'],
      ['bzz://foo..eth/'],
    ])('returns null for hosts with empty labels (%s)', async (url) => {
      await expect(buildGatewayUrl(url)).resolves.toBeNull();
      expect(mockResolveEnsContent).not.toHaveBeenCalled();
    });
  });
});

describe('sanitizeRequestHeaders', () => {
  test('strips hop-by-hop and origin headers, injects swarm retrieval hints', () => {
    const input = new Headers({
      'User-Agent': 'test',
      Accept: 'text/html',
      Origin: 'bzz://some-origin',
      Referer: 'bzz://some-origin/page',
      Host: 'whatever',
      Connection: 'keep-alive',
      Cookie: 'session=secret',
      Authorization: 'Bearer token',
    });
    const out = sanitizeRequestHeaders(input);
    expect(out.get('User-Agent')).toBe('test');
    expect(out.get('Accept')).toBe('text/html');
    expect(out.has('Origin')).toBe(false);
    expect(out.has('Referer')).toBe(false);
    expect(out.has('Host')).toBe(false);
    expect(out.has('Connection')).toBe(false);
    expect(out.has('Cookie')).toBe(false);
    expect(out.has('Authorization')).toBe(false);
    expect(out.get('Swarm-Chunk-Retrieval-Timeout')).toBe('30s');
    expect(out.get('Swarm-Redundancy-Strategy')).toBe('3');
    expect(out.get('Swarm-Redundancy-Fallback-Mode')).toBe('true');
  });
});

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

  test('does not retry non-idempotent methods', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 404 }));
    const req = {
      url: `bzz://${HASH}/x`,
      method: 'POST',
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
    };
    const res = await handleBzzRequest(req, { fetchImpl });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

      const p = handleBzzRequest(makeRequest(`bzz://${HASH}/x`), {
        fetchImpl,
        attemptTimeoutMs: 1000,
      });

      // Drain microtasks, then trip the per-attempt timeout.
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1100);
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
    // Still says a bzz request failed to resolve — just not which one.
    expect(text).toContain('resolver threw for <private>');
    expect(text).toContain('502 for bzz://<private>');
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
