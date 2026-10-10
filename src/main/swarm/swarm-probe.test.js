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

const { startProbe, cancelProbe, getActiveProbeCount } = require('./swarm-probe');

const VALID_HASH = 'a'.repeat(64);

function makeResponse(status) {
  return { status, ok: status >= 200 && status < 300 };
}

// A node that answers the probe's HEADs from `heads` (the last one repeats),
// a GET on a 404 with `body404`, and `/peers` with `peers` entries.
function fakeNode({ heads, body404 = { code: 404, message: 'Not Found' }, peers = null, onHead }) {
  let i = 0;
  return jest.fn().mockImplementation(async (url, opts = {}) => {
    if (opts.method === 'HEAD') {
      if (onHead) onHead();
      return makeResponse(heads[Math.min(i++, heads.length - 1)]);
    }
    if (url.endsWith('/peers')) {
      if (peers === null) return { status: 404, json: async () => ({}) };
      return {
        status: 200,
        json: async () => ({ peers: Array.from({ length: peers }, () => ({})) }),
      };
    }
    return { status: 404, json: async () => body404 };
  });
}

const headCalls = (fetchImpl) => fetchImpl.mock.calls.filter(([, o]) => o?.method === 'HEAD');
const urlsOf = (fetchImpl) =>
  fetchImpl.mock.calls.map(([url, o]) => `${o?.method || 'GET'} ${url}`);

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
    const fetchImpl = fakeNode({ heads: [404, 404, 200] });
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(headCalls(fetchImpl)).toHaveLength(3);
  });

  test('gives up early on a path the manifest does not contain (#175)', async () => {
    const fetchImpl = fakeNode({
      heads: [404],
      body404: { code: 404, message: 'path address not found' },
    });
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep, path: '/nope.html' });
    await expect(promise).resolves.toEqual({ ok: false, reason: 'path_not_found' });
    // One HEAD and the GET that reads its message. Since Ant v0.5.64 that
    // answer is exact on a cold node too (freedom-hq/ant#154), so there is
    // no second confirmation and no warm-up lookup of the site root.
    const base = `http://127.0.0.1:1633/bzz/${VALID_HASH}`;
    expect(urlsOf(fetchImpl)).toEqual([`HEAD ${base}/nope.html`, `GET ${base}/nope.html`]);
  });

  test('a Not Found (nothing retrievable yet) keeps polling', async () => {
    const bodies = [{ message: 'Not Found' }, { message: 'Not Found' }];
    const fetchImpl = jest.fn().mockImplementation(async (_url, opts = {}) => {
      if (opts.method === 'HEAD') return makeResponse(bodies.length ? 404 : 200);
      return { status: 404, json: async () => bodies.shift() };
    });
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep, path: '/a.html' });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(headCalls(fetchImpl)).toHaveLength(3);
  });

  test('a slow 404 (a retrieval that failed) is not re-read for its message', async () => {
    let fakeNow = 0;
    const fetchImpl = fakeNode({
      heads: [404, 200],
      body404: { message: 'path address not found' },
      onHead: () => {
        fakeNow += 15_000;
      },
    });
    const { promise } = startProbe(VALID_HASH, { fetchImpl, sleep: noSleep, now: () => fakeNow });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('a cold path miss of a few seconds is still read, and confirmed once', async () => {
    // Ant answers a missing path on a cold node in about 2.5 s: under the
    // quick-404 window, so it is read, but a cold answer needs the next
    // attempt to agree before the probe ends.
    let fakeNow = 0;
    const fetchImpl = fakeNode({
      heads: [404],
      body404: { message: 'path address not found' },
      onHead: () => {
        fakeNow += 2_500;
      },
    });
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      now: () => fakeNow,
      path: '/nope.html',
    });
    await expect(promise).resolves.toEqual({ ok: false, reason: 'path_not_found' });
    expect(headCalls(fetchImpl)).toHaveLength(2);
  });

  test('a cold path miss that the next attempt finds is not final (feed on an older update)', async () => {
    // A feed-backed site on a cold node: the first lookup can land on an
    // older update that lacks a page the latest one has.
    let fakeNow = 0;
    const fetchImpl = fakeNode({
      heads: [404, 200],
      body404: { message: 'path address not found' },
      onHead: () => {
        fakeNow += 2_500;
      },
    });
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      now: () => fakeNow,
      path: '/new.html',
    });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(headCalls(fetchImpl)).toHaveLength(2);
  });

  test('a cold miss needs consecutive confirmation; anything in between resets it', async () => {
    let fakeNow = 0;
    const heads = [404, 404, 503, 404, 404];
    const bodies = ['path address not found', 'Not Found', 'path address not found'];
    let headIndex = 0;
    const fetchImpl = jest.fn().mockImplementation(async (_url, opts = {}) => {
      if (opts.method === 'HEAD') {
        fakeNow += 2_500;
        return makeResponse(heads[Math.min(headIndex++, heads.length - 1)]);
      }
      return {
        status: 404,
        json: async () => ({ message: bodies.shift() ?? 'path address not found' }),
      };
    });
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      now: () => fakeNow,
      path: '/x.html',
    });
    await expect(promise).resolves.toEqual({ ok: false, reason: 'path_not_found' });
    // missing (cold), Not Found (resets), 503 (resets), missing (cold), missing → final.
    expect(headCalls(fetchImpl)).toHaveLength(5);
  });

  test('a hung 404 body read is cut off after the side-request cap', async () => {
    jest.useFakeTimers();
    try {
      let bodyReadAborted = false;
      const heads = [404, 200];
      const fetchImpl = jest.fn().mockImplementation((url, opts = {}) => {
        if (opts.method !== 'HEAD') {
          return new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              bodyReadAborted = true;
              reject(makeAbortError());
            });
          });
        }
        return Promise.resolve(makeResponse(heads.shift()));
      });
      let outcome = null;
      startProbe(VALID_HASH, { fetchImpl, sleep: noSleep, path: '/a.html' }).promise.then((o) => {
        outcome = o;
      });
      await jest.advanceTimersByTimeAsync(4_999);
      expect(bodyReadAborted).toBe(false);
      expect(outcome).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(bodyReadAborted).toBe(true);
      await jest.advanceTimersByTimeAsync(0);
      expect(outcome).toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
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

  test.each([502, 503, 504])('retries through %i (node not ready yet)', async (status) => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(status))
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
    const fetchImpl = fakeNode({
      heads: [404],
      peers: 3,
      onHead: () => {
        fakeNow += 1000;
      },
    });
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      now,
      overallTimeoutMs: 2500,
    });
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'not_found',
      lastStatus: 404,
      peers: 3,
    });
    // 3 attempts: after each, fakeNow goes 1000 -> 2000 -> 3000.
    // Overall timeout (2500) trips after the third attempt.
    expect(headCalls(fetchImpl)).toHaveLength(3);
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('http://127.0.0.1:1633/peers');
  });

  test('not_found reports a 5xx, a silent node and an unknown peer count', async () => {
    let fakeNow = 0;
    const fetchImpl = jest.fn().mockImplementation(async (url) => {
      if (url.endsWith('/peers')) throw new Error('boom');
      fakeNow += 1000;
      if (fakeNow < 2000) return makeResponse(503);
      throw makeAbortError();
    });
    const { promise } = startProbe(VALID_HASH, {
      fetchImpl,
      sleep: noSleep,
      now: () => fakeNow,
      overallTimeoutMs: 2500,
    });
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'not_found',
      lastStatus: 'no_response',
      peers: null,
    });
  });

  test('cancelProbe aborts an in-flight probe', async () => {
    let resolveFetch;
    const fetchImpl = jest.fn().mockImplementation(
      (_url, opts) =>
        new Promise((resolve, reject) => {
          resolveFetch = resolve;
          // Reject if aborted, mirroring real fetch behaviour
          opts.signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
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
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:1633/bzz/${VALID_HASH}/index.html`);
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
