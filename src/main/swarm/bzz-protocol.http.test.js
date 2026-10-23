/**
 * `bzz:` — the real handler against a fake Ant over real loopback HTTP.
 *
 * Roadmap 4.7, design 0006 ("Tests first"): before the handler's logic moves
 * into the Rust core, pin what it does today with nothing mocked between it
 * and the node but the node itself. `bzz-protocol.test.js` covers the URL and
 * redirect logic against a mocked `fetch`; here the handler registered on a
 * session (`registerBzzProtocol`) is driven with real `Request` objects and
 * talks to a fake Ant with Node's real `fetch`, so Range/206, HEAD, cancel,
 * mid-body errors and backpressure are the transport's real behaviour rather
 * than whatever a mock returns. Only name resolution is mocked.
 *
 * Timing cases (the retry schedule, the 30 s attempt deadline) run under
 * Jest's fake timers: the handler's own timers are fake, the sockets are not.
 */

const mockGetAntApiUrl = jest.fn();
jest.mock('../service-registry', () => ({
  getAntApiUrl: (...args) => mockGetAntApiUrl(...args),
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockResolveEnsContent = jest.fn();
jest.mock('../ens-resolver', () => ({
  resolveEnsContent: (...args) => mockResolveEnsContent(...args),
}));

const { registerBzzProtocol, RETRY_DELAYS_MS, ATTEMPT_TIMEOUT_MS } = require('./bzz-protocol');
const {
  closedLoopbackPort,
  nextTurn,
  rangeResponder,
  readAll,
  readUntilError,
  startFakeHttpNode,
  streamBody,
  waitFor,
  waitUntilStable,
} = require('../../../test/helpers/fake-http-node');

const HASH = 'ab'.repeat(32);
const ETAG = '"v1"';
// 1000 distinct-ish bytes, so a wrong slice can't pass by accident.
const CONTENT = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const MIB = 1024 * 1024;

const realFetch = global.fetch;
let ant;
let handle;

const bzz = (path, init) => new Request(`bzz://${HASH}${path}`, init);

function useFakeClock() {
  // Only the handler's timers: Node's sockets and the helpers' waits stay real.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
}

// Counts the handler's fetch attempts, stamped with the (fake) clock, and how
// many are still waiting for headers. The real fetch does the work.
function instrumentFetch() {
  const attempts = { calls: [], inflight: 0 };
  global.fetch = (...args) => {
    attempts.calls.push({ at: Date.now(), url: String(args[0]) });
    attempts.inflight += 1;
    return realFetch(...args).finally(() => {
      attempts.inflight -= 1;
    });
  };
  return attempts;
}

const gaps = ({ calls }) => calls.slice(1).map((call, i) => call.at - calls[i].at);

// The handler is asleep in its backoff after `count` attempts: the last fetch
// has settled and the one timer left is the sleep.
function inBackoff(attempts, count) {
  return waitFor(
    () => attempts.calls.length === count && attempts.inflight === 0 && jest.getTimerCount() === 1,
    { what: `the backoff after attempt ${count}` }
  );
}

// After attempt `count`: nothing `delay - 1` ms into the backoff, the next
// attempt at `delay`.
async function expectNextAttemptAfter(attempts, count, delay) {
  await inBackoff(attempts, count);
  await jest.advanceTimersByTimeAsync(delay - 1);
  expect(attempts.calls).toHaveLength(count);
  await jest.advanceTimersByTimeAsync(1);
  expect(attempts.calls).toHaveLength(count + 1);
}

const rangeOrigin = rangeResponder({ content: CONTENT, etag: ETAG, contentType: 'video/mp4' });

beforeEach(async () => {
  ant = await startFakeHttpNode();
  mockGetAntApiUrl.mockReset();
  mockGetAntApiUrl.mockReturnValue(ant.origin);
  mockResolveEnsContent.mockReset();
  const handlers = new Map();
  registerBzzProtocol({ protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) } });
  handle = handlers.get('bzz');
});

afterEach(async () => {
  jest.useRealTimers();
  global.fetch = realFetch;
  await ant.close();
});

describe('bzz: Range and conditional requests over HTTP', () => {
  beforeEach(() => ant.handle(rangeOrigin));

  test('forwards Range and passes the 206 and its Content-Range through unmodified', async () => {
    const res = await handle(bzz('/video.mp4', { headers: { Range: 'bytes=100-199' } }));

    expect(ant.requests).toHaveLength(1);
    expect(ant.requests[0].url).toBe(`/bzz/${HASH}/video.mp4`);
    expect(ant.requests[0].headers.range).toBe('bytes=100-199');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT.subarray(100, 200));
  });

  test.each([
    ['an open-ended range', 'bytes=990-', 'bytes 990-999/1000', [990, 1000]],
    ['a suffix range', 'bytes=-10', 'bytes 990-999/1000', [990, 1000]],
    ['a suffix longer than the content', 'bytes=-2000', 'bytes 0-999/1000', [0, 1000]],
    [
      'a range past the end, clamped by the node',
      'bytes=995-5000',
      'bytes 995-999/1000',
      [995, 1000],
    ],
  ])('passes %s through as the node answered it', async (_label, range, contentRange, slice) => {
    const res = await handle(bzz('/video.mp4', { headers: { Range: range } }));

    expect(ant.requests[0].headers.range).toBe(range);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(contentRange);
    expect(res.headers.get('content-length')).toBe(String(slice[1] - slice[0]));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT.subarray(...slice));
  });

  test('passes a 416 through with its Content-Range and does not retry it', async () => {
    useFakeClock();
    const res = await handle(bzz('/video.mp4', { headers: { Range: 'bytes=5000-' } }));

    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
    expect(ant.requests).toHaveLength(1);
    // Answered without any backoff being scheduled.
    expect(jest.getTimerCount()).toBe(0);
  });

  test('forwards If-Range: a matching validator keeps the 206, a stale one gets the whole 200', async () => {
    const fresh = await handle(
      bzz('/video.mp4', { headers: { Range: 'bytes=0-9', 'If-Range': ETAG } })
    );
    expect(ant.requests[0].headers['if-range']).toBe(ETAG);
    expect(fresh.status).toBe(206);
    expect(fresh.headers.get('content-range')).toBe('bytes 0-9/1000');
    expect(Buffer.from(await fresh.arrayBuffer())).toEqual(CONTENT.subarray(0, 10));

    const stale = await handle(
      bzz('/video.mp4', { headers: { Range: 'bytes=0-9', 'If-Range': '"v0"' } })
    );
    expect(ant.requests[1].headers['if-range']).toBe('"v0"');
    expect(stale.status).toBe(200);
    expect(stale.headers.get('content-range')).toBeNull();
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(CONTENT);
  });

  test('passes a multi-range 206 multipart/byteranges body through byte for byte', async () => {
    const res = await handle(bzz('/video.mp4', { headers: { Range: 'bytes=0-9,20-29' } }));

    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('multipart/byteranges; boundary=BOUNDARY');
    const body = Buffer.from(await res.arrayBuffer());
    // The whole multipart body, built here independently of the fake.
    const part = (start, end) => [
      Buffer.from(
        `--BOUNDARY\r\nContent-Type: video/mp4\r\nContent-Range: bytes ${start}-${end}/1000\r\n\r\n`
      ),
      CONTENT.subarray(start, end + 1),
      Buffer.from('\r\n'),
    ];
    const expected = Buffer.concat([
      ...part(0, 9),
      ...part(20, 29),
      Buffer.from('--BOUNDARY--\r\n'),
    ]);
    expect(body.equals(expected)).toBe(true);
    expect(Number(res.headers.get('content-length'))).toBe(expected.length);
  });

  test('passes a 304 for a matching If-None-Match through with no body', async () => {
    const res = await handle(bzz('/video.mp4', { headers: { 'If-None-Match': ETAG } }));

    expect(ant.requests[0].headers['if-none-match']).toBe(ETAG);
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });
});

describe('bzz: HEAD and redirects over HTTP', () => {
  test('HEAD reaches the node as HEAD and comes back with its headers and no body', async () => {
    ant.handle(rangeOrigin);
    const res = await handle(bzz('/video.mp4', { method: 'HEAD' }));

    expect(ant.requests[0].method).toBe('HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe(ETAG);
  });

  test('canonicalises a directory redirect into bzz: space and drops (cancels) its body', async () => {
    mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'bzz',
      decoded: HASH,
      uri: `bzz://${HASH}`,
    });
    // Ant's directory canonicalisation, written in its own gateway URL space.
    // The body never ends, so only a cancel can finish this response.
    ant.handle((_req, res, entry) => {
      res.writeHead(308, {
        Location: `/bzz/${HASH}/blog/`,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(1024 * MIB),
      });
      streamBody(entry);
    });

    const res = await handle(new Request('bzz://meinhard.eth/blog'));

    expect(mockResolveEnsContent).toHaveBeenCalledWith('meinhard.eth');
    expect(ant.requests.map((r) => r.url)).toEqual([`/bzz/${HASH}/blog`]);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('./blog/');
    expect(new URL(res.headers.get('location'), 'bzz://meinhard.eth/blog').href).toBe(
      'bzz://meinhard.eth/blog/'
    );
    // The rewritten redirect describes the empty body it carries now.
    expect(res.body).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // …and the upstream body was cancelled, not left streaming into nothing.
    await waitFor(() => ant.requests[0].closed, { what: 'the redirect body to be cancelled' });
    expect(ant.requests[0].aborted).toBe(true);
  });

  test('passes a cross-origin redirect through untouched, body and all, and never follows it', async () => {
    ant.handle((_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:9/elsewhere', 'Content-Length': '5' });
      res.end('moved');
    });

    const res = await handle(bzz('/x'));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://127.0.0.1:9/elsewhere');
    expect(res.headers.get('content-length')).toBe('5');
    await expect(res.text()).resolves.toBe('moved');
    expect(ant.requests).toHaveLength(1);
  });
});

describe('bzz: header policy over HTTP', () => {
  // What a page may send on (O-2, #429): content negotiation, validators,
  // Range, User-Agent. Values must arrive verbatim.
  const ALLOWED = {
    Accept: 'video/*',
    'Accept-Encoding': 'gzip',
    'Accept-Language': 'de',
    'If-Match': '"m"',
    'If-Modified-Since': 'Tue, 01 Sep 2026 00:00:00 GMT',
    'If-None-Match': '"n"',
    'If-Range': '"r"',
    'If-Unmodified-Since': 'Wed, 02 Sep 2026 00:00:00 GMT',
    'User-Agent': 'FreedomTest/1.0',
  };
  // What must never reach the node: credentials, page identity, and every
  // node-authority `Swarm-*` header (ACT, stamps, pinning, tags …).
  const DROPPED = {
    Authorization: 'Bearer secret',
    Cookie: 'session=1',
    Origin: 'https://evil.example',
    Referer: 'https://evil.example/page',
    'Content-Type': 'application/json',
    'Proxy-Authorization': 'Basic eA==',
    'Sec-Fetch-Dest': 'document',
    'Swarm-Act': 'true',
    'Swarm-Act-History-Address': 'ff',
    'Swarm-Act-Publisher': '02ab',
    'Swarm-Cache': 'false',
    'Swarm-Pin': 'true',
    'Swarm-Postage-Batch-Id': 'deadbeef',
    'Swarm-Tag': '1',
    'X-Custom': '1',
    'X-Forwarded-For': '10.0.0.1',
  };
  const HINTS = {
    'swarm-chunk-retrieval-timeout': '30s',
    'swarm-redundancy-strategy': '3',
    'swarm-redundancy-fallback-mode': 'true',
  };
  // Set by Node's HTTP client itself, never from the page's values. The fetch
  // spec has it add `Cache-Control`/`Pragma: no-cache` to any request that
  // carries an `If-*` validator.
  const CLIENT_OWN = new Set(['host', 'connection', 'sec-fetch-mode', 'cache-control', 'pragma']);

  test('forwards only the allowlist, verbatim, plus the retrieval hints', async () => {
    const res = await handle(
      bzz('/x', {
        headers: {
          ...ALLOWED,
          ...DROPPED,
          Host: 'evil.example',
          // A page cannot loosen the hints the handler sets.
          'Swarm-Chunk-Retrieval-Timeout': '999h',
          'Swarm-Redundancy-Strategy': '0',
          'Swarm-Redundancy-Fallback-Mode': 'false',
        },
      })
    );
    await res.arrayBuffer();
    const seen = ant.requests[0].headers;

    for (const [name, value] of Object.entries(ALLOWED)) {
      expect([name, seen[name.toLowerCase()]]).toEqual([name, value]);
    }
    for (const [name, value] of Object.entries(HINTS)) {
      expect([name, seen[name]]).toEqual([name, value]);
    }
    for (const name of Object.keys(DROPPED)) {
      expect([name, seen[name.toLowerCase()]]).toEqual([name, undefined]);
    }
    expect(seen.host).toBe(`127.0.0.1:${ant.port}`);
    const allowed = new Set([
      ...Object.keys(ALLOWED).map((name) => name.toLowerCase()),
      ...Object.keys(HINTS),
      ...CLIENT_OWN,
    ]);
    expect(Object.keys(seen).filter((name) => !allowed.has(name))).toEqual([]);
  });

  test('forwards Range alongside the allowlist', async () => {
    ant.handle(rangeOrigin);
    await (await handle(bzz('/video.mp4', { headers: { Range: 'bytes=1-2' } }))).arrayBuffer();
    expect(ant.requests[0].headers.range).toBe('bytes=1-2');
  });

  // O-12 (#439): an external Ant's cookies and service-worker scope never
  // reach the bzz:// page, whatever the status and method.
  test.each([
    ['a 200', {}, 200],
    ['a HEAD', { method: 'HEAD' }, 200],
    ['a 206', { headers: { Range: 'bytes=0-9' } }, 206],
    ['a 304', { headers: { 'If-None-Match': ETAG } }, 304],
  ])('strips page-state headers from %s and keeps everything else', async (_l, init, status) => {
    ant.handle((req, res) => {
      res.setHeader('Set-Cookie', ['track=1; Path=/', 'other=2']);
      res.setHeader('Set-Cookie2', 'legacy=1');
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Ant-Header', 'kept');
      rangeOrigin(req, res);
    });

    const res = await handle(bzz('/video.mp4', init));

    expect(res.status).toBe(status);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('set-cookie2')).toBeNull();
    expect(res.headers.get('service-worker-allowed')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-ant-header')).toBe('kept');
    expect(res.headers.get('etag')).toBe(ETAG);
    if (status === 200 && !init.method) {
      expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT);
    } else if (status === 206) {
      expect(res.headers.get('content-range')).toBe('bytes 0-9/1000');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT.subarray(0, 10));
    } else {
      expect(res.body).toBeNull();
    }
  });
});

describe('bzz: the retry loop over HTTP', () => {
  test('retries 5xx after the documented delays, then serves the answer that worked', async () => {
    const statuses = [500, 502, 503, 504];
    ant.handle((_req, res) => {
      const status = statuses.shift() || 200;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(status === 200 ? 'served' : `status ${status}`);
    });
    const attempts = instrumentFetch();
    useFakeClock();

    const pending = handle(bzz('/x'));
    for (const [i, delay] of RETRY_DELAYS_MS.slice(0, 4).entries()) {
      await expectNextAttemptAfter(attempts, i + 1, delay);
    }
    const res = await pending;

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('served');
    expect(ant.requests).toHaveLength(5);
    expect(gaps(attempts)).toEqual([500, 1000, 2000, 3000]);
  });

  // The whole schedule: 10 attempts, 51.5 s of backoff, then the outcome of
  // the last attempt. Also pins the status mapping for transport errors.
  test.each([
    [
      'a node that keeps answering 503: the last 503 is passed through',
      'busy',
      (res) => {
        expect(res.status).toBe(503);
        return expect(res.text()).resolves.toBe('still busy');
      },
    ],
    [
      'a refused connection: 503 "bee gateway unreachable"',
      'refused',
      async (res) => {
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ code: 503, message: 'bee gateway unreachable' });
      },
    ],
    [
      'a connection reset before headers: 502 "bee gateway error"',
      'reset',
      async (res) => {
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ code: 502, message: 'bee gateway error' });
      },
    ],
  ])('%s, after the full schedule', async (_label, mode, check) => {
    if (mode === 'refused') {
      mockGetAntApiUrl.mockReturnValue(`http://127.0.0.1:${await closedLoopbackPort()}`);
    } else if (mode === 'reset') {
      ant.handle((req) => req.socket.destroy());
    } else {
      ant.handle((_req, res) => {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('still busy');
      });
    }
    const attempts = instrumentFetch();
    useFakeClock();

    const pending = handle(bzz('/x'));
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      await expectNextAttemptAfter(attempts, i + 1, delay);
    }
    const res = await pending;

    expect(RETRY_DELAYS_MS).toEqual([500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000]);
    expect(attempts.calls).toHaveLength(10);
    expect(gaps(attempts)).toEqual(RETRY_DELAYS_MS);
    expect(attempts.calls[9].at - attempts.calls[0].at).toBe(51_500);
    expect(ant.requests).toHaveLength(mode === 'refused' ? 0 : 10);
    await check(res);
  });

  test('a connection reset before headers is retried like a 5xx', async () => {
    ant.handle((req, res) => {
      if (ant.requests.length === 1) {
        req.socket.destroy();
        return;
      }
      res.end('second try');
    });
    const attempts = instrumentFetch();
    useFakeClock();

    const pending = handle(bzz('/x'));
    await expectNextAttemptAfter(attempts, 1, RETRY_DELAYS_MS[0]);
    const res = await pending;

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('second try');
  });

  test('404 is final: one request, passed straight through', async () => {
    ant.handle((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('path address not found');
    });
    useFakeClock();

    const res = await handle(bzz('/missing.js'));

    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toBe('path address not found');
    expect(ant.requests).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('cancelling the request during the backoff ends it at once', async () => {
    ant.handle((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('busy');
    });
    const attempts = instrumentFetch();
    useFakeClock();
    const controller = new AbortController();

    const pending = handle(bzz('/x', { signal: controller.signal }));
    await inBackoff(attempts, 1);
    const sleptAt = Date.now();
    controller.abort();
    const res = await pending;

    // No fake time had to pass, and the backoff timer is gone.
    expect(Date.now()).toBe(sleptAt);
    expect(jest.getTimerCount()).toBe(0);
    expect(attempts.calls).toHaveLength(1);
    expect(ant.requests).toHaveLength(1);
    // TODAY: what comes back is the last 503, whose body the loop already
    // cancelled before it went to sleep, so it is unreadable. Nobody reads it:
    // the request it answers is gone.
    expect(res.status).toBe(503);
    expect(res.bodyUsed).toBe(true);
  });

  test("a retried attempt's body is cancelled before the backoff, freeing its connection", async () => {
    ant.handle((_req, res, entry) => {
      if (ant.requests.length === 1) {
        // A 503 whose body never ends: only a cancel can finish it.
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        streamBody(entry);
        return;
      }
      res.end('second try');
    });
    const attempts = instrumentFetch();
    useFakeClock();

    const pending = handle(bzz('/x'));
    await inBackoff(attempts, 1);
    // Still asleep, and the first response is already torn down.
    await waitFor(() => ant.requests[0].closed, { what: 'the 503 body to be cancelled' });
    expect(ant.requests[0].aborted).toBe(true);
    expect(attempts.calls).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    const res = await pending;
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('second try');
  });

  test('cancelling while an attempt waits for headers aborts it and does not retry', async () => {
    ant.handle(() => {}); // never answers
    const controller = new AbortController();

    const pending = handle(bzz('/x', { signal: controller.signal }));
    await waitFor(() => ant.requests.length === 1, { what: 'the attempt to reach the node' });
    controller.abort();
    const res = await pending;

    await waitFor(() => ant.requests[0].closed, { what: 'the attempt to be aborted' });
    expect(ant.requests[0].aborted).toBe(true);
    expect(ant.requests).toHaveLength(1);
    // TODAY: the AbortError maps to the generic 502; nobody reads it.
    expect(res.status).toBe(502);
  });
});

describe('bzz: the 30 s attempt deadline over HTTP', () => {
  test('aborts an attempt with no headers after exactly 30 s, then retries it', async () => {
    ant.handle((_req, res) => {
      if (ant.requests.length === 1) return; // accepted, never answered
      res.end('second try');
    });
    const attempts = instrumentFetch();
    useFakeClock();

    const pending = handle(bzz('/x'));
    await waitFor(() => ant.requests.length === 1, { what: 'the first attempt' });
    await jest.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS - 1);
    await nextTurn(20);
    expect(ant.requests[0].closed).toBe(false);
    expect(attempts.inflight).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    await waitFor(() => ant.requests[0].closed, { what: 'the stalled attempt to be aborted' });
    expect(ant.requests[0].aborted).toBe(true);
    await expectNextAttemptAfter(attempts, 1, RETRY_DELAYS_MS[0]);
    const res = await pending;

    expect(ATTEMPT_TIMEOUT_MS).toBe(30_000);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('second try');
  });

  // Design 0006 deviation `body-idle`: today nothing bounds a body that stops
  // mid-way. When the 60 s body-idle timeout lands, this case changes.
  test('stops applying once headers arrive: a stalled body is never timed out', async () => {
    ant.handle((_req, res) => {
      res.writeHead(200, { 'Content-Length': '200000' });
      res.write(Buffer.alloc(1000, 0x61));
    });
    useFakeClock();

    const res = await handle(bzz('/x'));
    const reader = res.body.getReader();
    const first = await reader.read();

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await nextTurn(20);
    expect(ant.requests[0].closed).toBe(false);

    ant.requests[0].res.end(Buffer.alloc(199_000, 0x62));
    const rest = await readAll(reader);
    expect(first.value.byteLength + rest.length).toBe(200_000);
  });
});

describe('bzz: mid-body over HTTP', () => {
  test('cancelling the body stops the upstream transfer', async () => {
    ant.handle((_req, res, entry) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      streamBody(entry);
    });

    const res = await handle(bzz('/video.mp4'));
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();

    await waitFor(() => ant.requests[0].closed, { what: 'the upstream to stop' });
    expect(ant.requests[0].aborted).toBe(true);
  });

  // TODAY: `fetchOnce` unhooks the request's signal as soon as the headers are
  // in (bzz-protocol.js `finally`), so after that only a body cancel stops the
  // transfer; the request's own abort no longer reaches it.
  test('TODAY: aborting the request after its headers does not reach the upstream body', async () => {
    ant.handle((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first ');
    });
    const controller = new AbortController();

    const res = await handle(bzz('/x', { signal: controller.signal }));
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await nextTurn(20);

    expect(ant.requests[0].closed).toBe(false);
    ant.requests[0].res.end('second');
    await expect(readAll(reader).then(String)).resolves.toBe('second');
  });

  test.each([
    ['with a Content-Length', { 'Content-Length': '100000' }],
    ['chunked', {}],
  ])(
    'an upstream that dies mid-body (%s) errors the stream: truncated, not a short success',
    async (_label, headers) => {
      ant.handle((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...headers });
        res.write(Buffer.alloc(10_000, 0x61), () => req.socket.destroy());
      });

      const res = await handle(bzz('/file.bin'));
      expect(res.status).toBe(200);
      const { bytes, error } = await readUntilError(res.body.getReader());

      // Node's fetch lives in another realm, so compare by name.
      expect(error.name).toBe('TypeError');
      expect(error.message).toBe('terminated');
      expect(bytes).toBeLessThanOrEqual(10_000);
      // No retry once the headers were in.
      expect(ant.requests).toHaveLength(1);
    }
  );
});

describe('bzz: backpressure over HTTP', () => {
  test('a paused reader holds the node back instead of the handler buffering the body', async () => {
    const TOTAL = 64 * MIB;
    ant.handle((_req, res, entry) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(TOTAL),
      });
      streamBody(entry, { total: TOTAL });
    });

    const res = await handle(bzz('/big.bin'));
    const reader = res.body.getReader();
    const first = await reader.read();
    const sentWhilePaused = await waitUntilStable(() => ant.requests[0].bytesSent);

    // Generous: loopback socket buffers (a few MiB) plus the HTTP client's
    // queue. What matters is that it is bounded, far below the body.
    expect(sentWhilePaused).toBeLessThan(16 * MIB);
    expect(ant.requests[0].closed).toBe(false);

    // Nothing was lost: the rest arrives once the reader resumes.
    let received = first.value.byteLength;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
    expect(received).toBe(TOTAL);
  });
});

describe('bzz: node not ready', () => {
  test.each([
    ['a hash host', `bzz://${HASH}/index.html`],
    ['a name host', 'bzz://meinhard.eth/'],
  ])('%s gets an immediate 503 when the Swarm node is not up', async (_label, url) => {
    mockGetAntApiUrl.mockReturnValue(null);
    useFakeClock();

    const res = await handle(new Request(url));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 503, message: 'Swarm node is not ready' });
    expect(ant.requests).toHaveLength(0);
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
