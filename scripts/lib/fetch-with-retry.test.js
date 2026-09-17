/**
 * The retry policy every `scripts/fetch-*.js` downloader now shares.
 *
 * What this suite pins is the *policy*, not just the plumbing: which failures
 * buy another attempt (5xx, 429, connection errors, timeouts), which ones do
 * not (any other 4xx, a bad redirect, an over-size body, a local write error),
 * what the backoff looks like, and that a streamed download never leaves a
 * partial file where the next step would read it.
 *
 * `https` is mocked rather than served for real (fetch-ant.test.js convention):
 * the module refuses plain HTTP by design, so a local listener cannot stand in
 * without either shipping a certificate in the repo or weakening the rule.
 * A real-socket 500-500-200 run against a local HTTPS server is part of the
 * pull request's verification instead.
 */

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

jest.mock('https');

const {
  MAX_ATTEMPTS,
  TIMEOUTS,
  IDLE_TIMEOUT_MS,
  STALE_TEMP_FILE_MS,
  HttpStatusError,
  isRetryableStatus,
  isRetryableError,
  parseRetryAfter,
  delayForAttempt,
  withRetry,
  fetchBuffer,
  fetchText,
  fetchJson,
  downloadToFile,
} = require('./fetch-with-retry');

const URL_UNDER_TEST = 'https://example.test/asset.bin';

/**
 * Replay scripted responses in order, recording every request. A scripted
 * entry is one of:
 *   { statusCode, headers, body }  — a normal response
 *   { requestError: Error }        — a connection-level failure
 *   { statusCode, body, complete: false } — a response cut short mid-body
 *   { stall: true }                — headers never arrive
 */
function mockResponses(scripts) {
  const calls = [];
  https.get.mockImplementation((url, options, callback) => {
    const scripted = scripts[calls.length];
    const req = new PassThrough();
    req.setTimeout = jest.fn((ms, onTimeout) => {
      req.idleTimeoutMs = ms;
      req.fireIdleTimeout = onTimeout;
    });
    req.destroy = jest.fn((error) => {
      if (error) process.nextTick(() => req.emit('error', error));
    });
    calls.push({ url, headers: options.headers, req });
    if (!scripted) throw new Error(`Unexpected request #${calls.length} to ${url}`);
    if (scripted.stall) return req;

    process.nextTick(() => {
      if (scripted.requestError) {
        req.emit('error', scripted.requestError);
        return;
      }
      const res = new PassThrough();
      res.statusCode = scripted.statusCode;
      res.headers = scripted.headers || {};
      res.complete = scripted.complete !== false;
      callback(res);
      process.nextTick(() => {
        if (scripted.responseError) {
          res.destroy(scripted.responseError);
          return;
        }
        if (scripted.body !== undefined) res.write(Buffer.from(scripted.body));
        res.end();
      });
    });
    return req;
  });
  return calls;
}

const connectionError = (code, message = code) => Object.assign(new Error(message), { code });

/** Never actually wait in a unit test; record what the delay would have been. */
function instantSleep() {
  const delays = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

const quiet = { log: () => {}, random: () => 0 };

afterEach(() => {
  jest.resetAllMocks();
});

describe('retry classification', () => {
  test('5xx and 429 are transient, other 4xx are not', () => {
    for (const status of [500, 502, 503, 504, 429]) {
      expect(isRetryableStatus(status)).toBe(true);
      expect(new HttpStatusError(status, URL_UNDER_TEST).retryable).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 410, 418, 451]) {
      expect(isRetryableStatus(status)).toBe(false);
      expect(new HttpStatusError(status, URL_UNDER_TEST).retryable).toBe(false);
    }
  });

  test('connection-level failures are transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']) {
      expect(isRetryableError(connectionError(code))).toBe(true);
    }
    // undici's global fetch reports a dead connection as an opaque
    // `fetch failed` with the real cause nested underneath.
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(
      isRetryableError(new Error('fetch failed', { cause: connectionError('ECONNRESET') }))
    ).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
  });

  test('an explicit verdict wins over every heuristic', () => {
    // A checksum mismatch mentioning a retryable-looking word must still be final.
    expect(isRetryableError(Object.assign(new Error('ECONNRESET'), { retryable: false }))).toBe(
      false
    );
    expect(isRetryableError(new Error('checksum mismatch'))).toBe(false);
    expect(isRetryableError(new Error('No such asset in the release'))).toBe(false);
  });
});

describe('backoff', () => {
  test('is exponential — 1s, 3s, 9s — before attempts 2, 3 and 4', () => {
    expect([1, 2, 3].map((attempt) => delayForAttempt(attempt, { random: () => 0 }))).toEqual([
      1000, 3000, 9000,
    ]);
  });

  test('adds jitter of up to +25% so parallel downloads do not re-dial in lockstep', () => {
    expect(delayForAttempt(1, { random: () => 1 })).toBe(1250);
    expect(delayForAttempt(2, { random: () => 0.5 })).toBe(3375);
    for (let i = 0; i < 50; i += 1) {
      const delay = delayForAttempt(3);
      expect(delay).toBeGreaterThanOrEqual(9000);
      expect(delay).toBeLessThanOrEqual(11250);
    }
  });

  test('honours a longer Retry-After, capped so a hostile value cannot park a job', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter('not-a-date')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    // Shorter than the backoff: the backoff wins.
    expect(delayForAttempt(3, { retryAfterMs: 2000, random: () => 0 })).toBe(9000);
    expect(delayForAttempt(1, { retryAfterMs: 30_000, random: () => 0 })).toBe(30_000);
    expect(delayForAttempt(1, { retryAfterMs: 86_400_000, random: () => 0 })).toBe(60_000);
  });
});

describe('withRetry', () => {
  test('stops at the first non-transient failure', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        'Test',
        async () => {
          attempts += 1;
          throw Object.assign(new Error('nope'), { retryable: false });
        },
        quiet
      )
    ).rejects.toThrow(/Test failed on attempt 1 and was not retried .*: nope/);
    expect(attempts).toBe(1);
  });

  test(`gives up after ${MAX_ATTEMPTS} attempts and names the attempt count`, async () => {
    const { sleep, delays } = instantSleep();
    let attempts = 0;
    await expect(
      withRetry(
        'Test',
        async () => {
          attempts += 1;
          throw connectionError('ECONNRESET');
        },
        { ...quiet, sleep }
      )
    ).rejects.toThrow(
      `Test failed after ${MAX_ATTEMPTS} attempt(s) of ${MAX_ATTEMPTS}: ECONNRESET`
    );
    expect(attempts).toBe(MAX_ATTEMPTS);
    expect(delays).toEqual([1000, 3000, 9000]);
  });
});

describe('fetchBuffer', () => {
  // The exact shape that failed CI: GitHub answered 500 twice, and the job
  // died instead of asking again.
  test('retries a 500 and succeeds on the third attempt, logging each backoff', async () => {
    const { sleep, delays } = instantSleep();
    const logs = [];
    const calls = mockResponses([
      { statusCode: 500 },
      { statusCode: 500 },
      { statusCode: 200, body: 'payload' },
    ]);
    await expect(
      fetchBuffer(URL_UNDER_TEST, {
        label: 'Ant binary',
        sleep,
        random: () => 0,
        log: (message) => logs.push(message),
      })
    ).resolves.toEqual(Buffer.from('payload'));
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 3000]);
    expect(logs).toEqual([
      `Ant binary: attempt 1/4 failed (HTTP 500 for ${URL_UNDER_TEST}); retrying in 1000ms...`,
      `Ant binary: attempt 2/4 failed (HTTP 500 for ${URL_UNDER_TEST}); retrying in 3000ms...`,
    ]);
  });

  test('retries a 429 and waits at least as long as its Retry-After', async () => {
    const { sleep, delays } = instantSleep();
    const calls = mockResponses([
      { statusCode: 429, headers: { 'retry-after': '5' } },
      { statusCode: 200, body: 'payload' },
    ]);
    await expect(fetchBuffer(URL_UNDER_TEST, { ...quiet, sleep })).resolves.toEqual(
      Buffer.from('payload')
    );
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([5000]);
  });

  test('retries a connection error', async () => {
    const { sleep } = instantSleep();
    const calls = mockResponses([
      { requestError: connectionError('ECONNRESET', 'socket hang up') },
      { statusCode: 200, body: 'payload' },
    ]);
    await expect(fetchBuffer(URL_UNDER_TEST, { ...quiet, sleep })).resolves.toEqual(
      Buffer.from('payload')
    );
    expect(calls).toHaveLength(2);
  });

  test('retries a response that is cut short mid-body', async () => {
    const { sleep } = instantSleep();
    const calls = mockResponses([
      { statusCode: 200, body: 'half', complete: false },
      { statusCode: 200, body: 'payload' },
    ]);
    await expect(fetchBuffer(URL_UNDER_TEST, { ...quiet, sleep })).resolves.toEqual(
      Buffer.from('payload')
    );
    expect(calls).toHaveLength(2);
  });

  // A 404 is an answer. Retrying it delays the failure by 13 seconds and
  // teaches the reader nothing.
  test.each([400, 401, 403, 404, 451])('never retries HTTP %i', async (statusCode) => {
    const calls = mockResponses([{ statusCode }]);
    await expect(fetchBuffer(URL_UNDER_TEST, quiet)).rejects.toThrow(
      new RegExp(`HTTP ${statusCode} for ${URL_UNDER_TEST.replace(/[.]/g, '\\.')}`)
    );
    expect(calls).toHaveLength(1);
  });

  test('reports the attempt count and the URL in the final error', async () => {
    const { sleep } = instantSleep();
    mockResponses(Array.from({ length: MAX_ATTEMPTS }, () => ({ statusCode: 503 })));
    await expect(
      fetchBuffer(URL_UNDER_TEST, { label: 'Ant binary', ...quiet, sleep })
    ).rejects.toThrow(`Ant binary failed after 4 attempt(s) of 4: HTTP 503 for ${URL_UNDER_TEST}`);
  });

  test('bounds each attempt with a deadline and a socket-inactivity timeout', async () => {
    const { sleep } = instantSleep();
    const calls = mockResponses([{ stall: true }, { statusCode: 200, body: 'payload' }]);
    const pending = fetchBuffer(URL_UNDER_TEST, { ...quiet, sleep, timeoutMs: 25 });
    await expect(pending).resolves.toEqual(Buffer.from('payload'));
    expect(calls[0].req.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('timed out after 25ms') })
    );
    expect(calls[0].req.idleTimeoutMs).toBe(IDLE_TIMEOUT_MS);
  });

  test('retries an attempt killed by the inactivity timeout', async () => {
    const { sleep } = instantSleep();
    const calls = mockResponses([{ stall: true }, { statusCode: 200, body: 'payload' }]);
    const pending = fetchBuffer(URL_UNDER_TEST, { ...quiet, sleep, timeoutMs: 60_000 });
    await new Promise((resolve) => setImmediate(resolve));
    calls[0].req.fireIdleTimeout();
    await expect(pending).resolves.toEqual(Buffer.from('payload'));
    expect(calls).toHaveLength(2);
  });

  test('follows https redirects, and refuses to downgrade or loop', async () => {
    const calls = mockResponses([
      { statusCode: 302, headers: { location: '/moved/asset.bin' } },
      { statusCode: 200, body: 'payload' },
    ]);
    await expect(fetchBuffer(URL_UNDER_TEST, quiet)).resolves.toEqual(Buffer.from('payload'));
    expect(calls[1].url).toBe('https://example.test/moved/asset.bin');

    jest.resetAllMocks();
    mockResponses([{ statusCode: 302, headers: { location: 'http://example.test/asset.bin' } }]);
    await expect(fetchBuffer(URL_UNDER_TEST, quiet)).rejects.toThrow(/non-HTTPS redirect/);

    jest.resetAllMocks();
    const loop = mockResponses(
      Array.from({ length: 8 }, () => ({
        statusCode: 302,
        headers: { location: 'https://example.test/loop' },
      }))
    );
    await expect(fetchBuffer(URL_UNDER_TEST, quiet)).rejects.toThrow(/Too many redirects/);
    // 5 redirects are followed, the sixth is refused — and none of it is retried.
    expect(loop).toHaveLength(6);
  });

  // Auth headers must not survive a hop off the host they were minted for.
  test('recomputes headers per hop so a token cannot leak across a redirect', async () => {
    const calls = mockResponses([
      { statusCode: 301, headers: { location: 'https://elsewhere.test/asset.bin' } },
      { statusCode: 200, body: 'payload' },
    ]);
    await fetchBuffer(URL_UNDER_TEST, {
      ...quiet,
      headers: (url) =>
        new URL(url).host === 'example.test'
          ? { Authorization: 'Bearer secret' }
          : { 'User-Agent': 'Freedom' },
    });
    expect(calls[0].headers.Authorization).toBe('Bearer secret');
    expect(calls[1].headers.Authorization).toBeUndefined();
  });

  test('refuses a plain-HTTP URL without issuing a request', async () => {
    const calls = mockResponses([{ statusCode: 200, body: 'payload' }]);
    await expect(fetchBuffer('http://example.test/asset.bin', quiet)).rejects.toThrow(
      /Refusing non-HTTPS URL/
    );
    expect(calls).toHaveLength(0);
  });

  test('stops an over-size body instead of buffering it, and does not retry', async () => {
    const calls = mockResponses([{ statusCode: 200, body: 'x'.repeat(64) }]);
    await expect(fetchBuffer(URL_UNDER_TEST, { ...quiet, maxBytes: 16 })).rejects.toThrow(
      /exceeds the 16-byte limit/
    );
    expect(calls).toHaveLength(1);
  });
});

describe('fetchText and fetchJson', () => {
  test('decode the body, and never retry a body that is simply not JSON', async () => {
    mockResponses([{ statusCode: 200, body: 'hello' }]);
    await expect(fetchText(URL_UNDER_TEST, quiet)).resolves.toBe('hello');

    jest.resetAllMocks();
    const calls = mockResponses([{ statusCode: 200, body: '{"tag_name":"v1"}' }]);
    await expect(fetchJson(URL_UNDER_TEST, quiet)).resolves.toEqual({ tag_name: 'v1' });
    expect(calls).toHaveLength(1);

    jest.resetAllMocks();
    const bad = mockResponses([{ statusCode: 200, body: 'not json' }]);
    await expect(fetchJson(URL_UNDER_TEST, quiet)).rejects.toThrow(/Invalid JSON/);
    expect(bad).toHaveLength(1);
  });
});

describe('downloadToFile', () => {
  let dir;
  let destination;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-with-retry-'));
    destination = path.join(dir, 'nested', 'asset.bin');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes the finished file and nothing else', async () => {
    mockResponses([{ statusCode: 200, body: 'payload' }]);
    await downloadToFile(URL_UNDER_TEST, destination, quiet);
    expect(fs.readFileSync(destination, 'utf8')).toBe('payload');
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['asset.bin']);
  });

  // The half-written-file failure mode: a first attempt that dies mid-body
  // must not leave bytes where the retry (or the checksum step) would find them.
  test('never leaves a partial file behind when an attempt fails mid-body', async () => {
    const { sleep } = instantSleep();
    mockResponses([
      { statusCode: 200, body: 'half a fi', complete: false },
      { statusCode: 200, body: 'a complete file' },
    ]);
    await downloadToFile(URL_UNDER_TEST, destination, { ...quiet, sleep });
    expect(fs.readFileSync(destination, 'utf8')).toBe('a complete file');
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['asset.bin']);
  });

  test('leaves no file at all when every attempt fails', async () => {
    const { sleep } = instantSleep();
    mockResponses(Array.from({ length: MAX_ATTEMPTS }, () => ({ statusCode: 500 })));
    await expect(downloadToFile(URL_UNDER_TEST, destination, { ...quiet, sleep })).rejects.toThrow(
      /HTTP 500/
    );
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(path.dirname(destination))).toEqual([]);
  });

  // A SIGKILL mid-download (a cancelled CI job, a Ctrl-C) runs no cleanup, and
  // every attempt picks a fresh random suffix, so nothing later would ever
  // overwrite the orphan — it just sits in `ant-bin/<os>-<arch>/` until a
  // packaged build's `**/*` extraResources glob ships it.
  test('sweeps the .part-* files a killed download orphaned', async () => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const orphan = `${destination}.part-deadbeefcafe`;
    fs.writeFileSync(orphan, 'half an archive');
    const longAgo = Date.now() / 1000 - STALE_TEMP_FILE_MS / 1000 - 60;
    fs.utimesSync(orphan, longAgo, longAgo);

    mockResponses([{ statusCode: 200, body: 'payload' }]);
    await downloadToFile(URL_UNDER_TEST, destination, quiet);

    expect(fs.readdirSync(path.dirname(destination))).toEqual(['asset.bin']);
  });

  // Another process may be downloading the same asset right now; its temp file
  // is being written to, so it is young, and deleting it would break a download
  // this one knows nothing about.
  test('leaves a young .part-* file alone — it may belong to a live download', async () => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const inFlight = `${destination}.part-0123456789ab`;
    fs.writeFileSync(inFlight, 'someone else is mid-download');

    mockResponses([{ statusCode: 200, body: 'payload' }]);
    await downloadToFile(URL_UNDER_TEST, destination, quiet);

    expect(fs.readdirSync(path.dirname(destination)).sort()).toEqual([
      'asset.bin',
      path.basename(inFlight),
    ]);
  });

  // The sweep is keyed to one destination: an unrelated asset's temp file, and
  // anything that merely looks similar, are none of its business.
  test('sweeps only this destination’s own temp files', async () => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const longAgo = Date.now() / 1000 - STALE_TEMP_FILE_MS / 1000 - 60;
    const others = [
      path.join(path.dirname(destination), 'other.bin.part-deadbeefcafe'),
      path.join(path.dirname(destination), 'asset.bin.partial'),
    ];
    for (const other of others) {
      fs.writeFileSync(other, 'not mine');
      fs.utimesSync(other, longAgo, longAgo);
    }

    mockResponses([{ statusCode: 200, body: 'payload' }]);
    await downloadToFile(URL_UNDER_TEST, destination, quiet);

    expect(fs.readdirSync(path.dirname(destination)).sort()).toEqual([
      'asset.bin',
      'asset.bin.partial',
      'other.bin.part-deadbeefcafe',
    ]);
  });

  test('replaces an existing file only once the new one is complete', async () => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'the previous good copy');
    const { sleep } = instantSleep();
    mockResponses([
      { statusCode: 500 },
      { statusCode: 500 },
      { statusCode: 500 },
      { statusCode: 500 },
    ]);
    await expect(downloadToFile(URL_UNDER_TEST, destination, { ...quiet, sleep })).rejects.toThrow(
      /HTTP 500/
    );
    expect(fs.readFileSync(destination, 'utf8')).toBe('the previous good copy');
  });
});

// The whole point of keeping verification *outside* the retry loop: a body
// that does not match its pinned digest is corruption or tampering, and asking
// the same server three more times neither fixes it nor makes it louder.
describe('checksum verification', () => {
  test('is not retried, because it is not a transient failure', async () => {
    const calls = mockResponses([{ statusCode: 200, body: 'tampered bytes' }]);
    const download = async () => {
      const bytes = await fetchBuffer(URL_UNDER_TEST, quiet);
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== 'f'.repeat(64)) throw new Error(`checksum mismatch for ${URL_UNDER_TEST}`);
      return bytes;
    };
    await expect(download()).rejects.toThrow(/checksum mismatch/);
    expect(calls).toHaveLength(1);
  });
});

describe('per-asset timeouts', () => {
  test('are sized by what is being fetched', () => {
    expect(TIMEOUTS.metadata).toBe(30_000);
    expect(TIMEOUTS.list).toBe(120_000);
    expect(TIMEOUTS.binary).toBe(600_000);
    // The inactivity timeout has to stay well under the binary deadline, or a
    // stalled multi-minute download would only be caught by the deadline.
    expect(IDLE_TIMEOUT_MS).toBeLessThan(TIMEOUTS.binary);
  });
});
