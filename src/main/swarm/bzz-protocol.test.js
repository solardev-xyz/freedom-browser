jest.mock('../service-registry', () => ({
  getBeeApiUrl: jest.fn(() => 'http://127.0.0.1:1633'),
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
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
  test('converts bzz://<hash>/path to the Bee gateway URL', () => {
    expect(buildGatewayUrl(`bzz://${HASH}/index.html`)).toBe(
      `http://127.0.0.1:1633/bzz/${HASH}/index.html`
    );
  });

  test('preserves query string and drops fragment (Chromium never sends it)', () => {
    expect(buildGatewayUrl(`bzz://${HASH}/page?v=1`)).toBe(
      `http://127.0.0.1:1633/bzz/${HASH}/page?v=1`
    );
  });

  test('supports 128-char encrypted refs', () => {
    expect(buildGatewayUrl(`bzz://${ENCRYPTED_HASH}/`)).toBe(
      `http://127.0.0.1:1633/bzz/${ENCRYPTED_HASH}/`
    );
  });

  test('returns null for non-hex hosts', () => {
    expect(buildGatewayUrl('bzz://not-a-hash/file')).toBeNull();
  });

  test('returns null for too-short hashes', () => {
    expect(buildGatewayUrl('bzz://abcdef/file')).toBeNull();
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
    });
    const out = sanitizeRequestHeaders(input);
    expect(out.get('User-Agent')).toBe('test');
    expect(out.get('Accept')).toBe('text/html');
    expect(out.has('Origin')).toBe(false);
    expect(out.has('Referer')).toBe(false);
    expect(out.has('Host')).toBe(false);
    expect(out.has('Connection')).toBe(false);
    expect(out.get('Swarm-Chunk-Retrieval-Timeout')).toBe('30s');
    expect(out.get('Swarm-Redundancy-Strategy')).toBe('3');
    expect(out.get('Swarm-Redundancy-Fallback-Mode')).toBe('true');
  });
});

describe('handleBzzRequest', () => {
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

  test('retries transient 404 then returns 200', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const p = handleBzzRequest(makeRequest(`bzz://${HASH}/x`), { fetchImpl });
      // Drain the first attempt, then advance past the first retry delay.
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

  test('aborted request bails out without exhausting all retries', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 404 }));
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
      // The handler returns the last observed 404 since abort interrupts
      // the backoff but doesn't synthesize a new response.
      expect(res.status).toBe(404);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
