jest.mock('../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const mockGetBeeApiUrl = jest.fn();
jest.mock('../service-registry', () => ({
  getAntApiUrl: mockGetBeeApiUrl,
}));

const {
  startProbe,
  cancelProbe,
  getActiveProbeCount,
} = require('./swarm-probe');

const VALID_HASH = 'a'.repeat(64);

function makeResponse(status) {
  return { status, ok: status >= 200 && status < 300 };
}

function makeAbortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function makeConnRefusedError() {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNREFUSED' };
  return err;
}

const noSleep = () => Promise.resolve();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
});

describe('swarm-probe', () => {
  test('resolves ok on first 200', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(200));
    const { id, promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:1633/bzz/${VALID_HASH}`);
    expect(fetchImpl.mock.calls[0][1].method).toBe('HEAD');
    // After resolution the probe is no longer tracked
    expect(getActiveProbeCount()).toBe(0);
    // Cancelling a finished probe is a no-op
    expect(cancelProbe(id)).toBe(false);
  });

  test('polls through 404s until 200', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(404))
      .mockResolvedValueOnce(makeResponse(404))
      .mockResolvedValueOnce(makeResponse(200));
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('also retries through 500s', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(200));
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('resolves bee_unreachable on ECONNREFUSED', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(makeConnRefusedError());
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: false, reason: 'bee_unreachable' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('resolves bee_unreachable when getAntApiUrl is empty', async () => {
    mockGetBeeApiUrl.mockReturnValue('');
    const fetchImpl = jest.fn();
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: false, reason: 'bee_unreachable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('resolves other for unexpected HTTP status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(403));
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: false, reason: 'other', status: 403 });
  });

  test('keeps polling on per-attempt timeout (AbortError not from cancel)', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(makeAbortError())
      .mockResolvedValueOnce(makeResponse(200));
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('resolves not_found after overall timeout', async () => {
    let fakeNow = 0;
    const now = () => fakeNow;
    const fetchImpl = jest.fn().mockImplementation(async () => {
      fakeNow += 1000;
      return makeResponse(404);
    });
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      now,
      overallTimeoutMs: 2500,
    });
    await expect(promise).resolves.toEqual({ ok: false, reason: 'not_found' });
    // 3 attempts: after each, fakeNow goes 1000 -> 2000 -> 3000.
    // Overall timeout (2500) trips after the third attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('cancelProbe aborts an in-flight probe', async () => {
    let resolveFetch;
    const fetchImpl = jest.fn().mockImplementation(
      (_url, opts) =>
        new Promise((resolve, reject) => {
          resolveFetch = resolve;
          // Reject if aborted, mirroring real fetch behaviour
          opts.signal.addEventListener(
            'abort',
            () => reject(makeAbortError()),
            { once: true }
          );
        })
    );
    const { id, promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    // Give the microtask queue a tick so the fetch has started.
    await Promise.resolve();
    expect(getActiveProbeCount()).toBe(1);
    expect(cancelProbe(id)).toBe(true);
    await expect(promise).resolves.toEqual({ ok: false, reason: 'aborted' });
    expect(getActiveProbeCount()).toBe(0);
    // Resolving after cancel shouldn't matter
    resolveFetch?.(makeResponse(200));
  });

  test('rejects invalid hashes immediately', async () => {
    const fetchImpl = jest.fn();
    const { promise } = startProbe('not-a-hash', { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: false, reason: 'invalid_hash' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getActiveProbeCount()).toBe(0);
  });

  test('accepts 128-char encrypted references', async () => {
    const encHash = 'b'.repeat(128);
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(200));
    const { promise } = startProbe(encHash, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:1633/bzz/${encHash}`);
  });

  test('appends the in-manifest path so index-less manifests probe correctly (#172)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(200));
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      path: '/index.html',
    });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `http://127.0.0.1:1633/bzz/${VALID_HASH}/index.html`
    );
  });

  test('drops query/fragment from the probe path', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(200));
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      path: '/app/index.html?tab=1#top',
    });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `http://127.0.0.1:1633/bzz/${VALID_HASH}/app/index.html`
    );
  });

  test('degrades malformed paths to the bare-hash probe', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(200));
    for (const path of ['index.html', 42, null, undefined, '']) {
      fetchImpl.mockClear();
      const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep, path });
      await expect(promise).resolves.toEqual({ ok: true });
      expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:1633/bzz/${VALID_HASH}`);
    }
  });

  test('rejects double-dot segments that would escape /bzz/*', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(200));
    // fetch normalizes `..` (and its percent-encoded forms) before sending,
    // which would let a path aim the HEAD at other Bee API endpoints. It
    // also treats `\` as a path separator in http URLs, so backslash-
    // delimited double-dot segments must be caught too.
    for (const path of [
      '/..',
      '/../health',
      '/a/../../health',
      '/%2e%2e/health',
      '/.%2e/health',
      '/%2E./health',
      '/..\\..\\health',
      '/a\\..\\../health',
      '/%2e%2e\\health',
    ]) {
      fetchImpl.mockClear();
      const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep, path });
      await expect(promise).resolves.toEqual({ ok: true });
      expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:1633/bzz/${VALID_HASH}`);
    }
    // A single-dot segment is harmless — it normalizes away within /bzz/*.
    fetchImpl.mockClear();
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      path: '/./index.html',
    });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:1633/bzz/${VALID_HASH}/./index.html`);
  });
});
