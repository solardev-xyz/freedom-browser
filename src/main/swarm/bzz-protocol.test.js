jest.mock('../service-registry', () => ({
  getBeeApiUrl: jest.fn(() => 'http://127.0.0.1:1633'),
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

const HASH = 'a'.repeat(64);
const ENCRYPTED_HASH = 'a'.repeat(128);

describe('buildGatewayUrl', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
  });

  test('converts bzz://<hash>/path to the Bee gateway URL', async () => {
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

    test('returns 404 when ENS contenthash is IPFS, not Swarm', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'ipfs',
        decoded: 'QmFakeCid',
        uri: 'ipfs://QmFakeCid',
      });

      const result = await buildGatewayUrl('bzz://vitalik.eth/');
      expect(result).toEqual({
        ok: false,
        status: 404,
        message: 'ENS name vitalik.eth resolves to ipfs, not Swarm',
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
      expect(result).toEqual({
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
