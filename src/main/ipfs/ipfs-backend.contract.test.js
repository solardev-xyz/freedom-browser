/**
 * The IPFS backend contract (freedom-core design 0007, "Tests first" and
 * "Main's side"): what `ipfsBackend({ partition })`, its `ref`, `url` and
 * `request()`, and the `ipfs:` handler on top of them, must do, whatever
 * runs the node. It runs against a real backend, chosen by
 * FREEDOM_IPFS_CONTRACT_BACKEND (`test/helpers/ipfs-contract-backends.js`):
 * today's freedom-ipfs add-on (`addon`), and later freedom-ipfsd, unchanged.
 * Without it, the suite is skipped.
 *
 * The content is local: UnixFS blocks built by the test, served by loopback
 * servers that are the node's delegated router and its only HTTP providers
 * (`test/helpers/ipfs-fixture.js`). Nothing reaches the public network. Each
 * test builds its own content, so no test is served from another's cache,
 * and a test that makes a provider fail or stall takes one of its own.
 *
 * What the design adds beyond today's contract (private instances, leases,
 * `BackendBusy`, automatic restarts) is written here too, pending: a test
 * named `[pending: <feature>]` runs only against a backend that honours the
 * feature, or when FREEDOM_IPFS_CONTRACT_PENDING names it (or is `all`).
 *
 * The cases that need a scripted node or a fake clock (the exact 30 s head
 * deadline, the 60 s body idle bound, which add-on events pull a read) stay
 * with the fake add-on in `ipfs-protocol.native.test.js`.
 */

const {
  BACKENDS,
  FEATURES,
  TODAY_CONFIG,
  contractBackendName,
  forcedFeatures,
} = require('../../../test/helpers/ipfs-contract-backends');
const {
  IpfsContent,
  startIpfsFixture,
  CHUNK_BYTES,
} = require('../../../test/helpers/ipfs-fixture');
const {
  nextTurn,
  readAll,
  readUntilError,
  waitFor,
} = require('../../../test/helpers/fake-http-node');

const BACKEND = contractBackendName();
const describeContract = BACKEND ? describe : describe.skip;
const FORCED = forcedFeatures();

const NAVIGATION_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
  'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const HEADERS_MS = 30_000;
const PRIVATE = 'private-contract-1';
const OTHER_PRIVATE = 'private-contract-2';

let content;
let fixture;
let backend;
let seed = 0;

/** Bytes no other test has, and no two blocks of them alike: xorshift32
 * from a fresh seed. */
function uniqueBytes(length) {
  seed += 1;
  let x = (0x9e3779b9 ^ seed) >>> 0;
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

/** A test for a feature the design adds: pending until the backend honours
 * it, or the run forces it. */
function pendingTest(feature, name, fn, timeout) {
  if (!FEATURES.includes(feature)) throw new Error(`unknown contract feature: ${feature}`);
  const run =
    BACKEND !== null && (BACKENDS[BACKEND].honours.includes(feature) || FORCED.has(feature));
  (run ? test : test.skip)(`[pending: ${feature}] ${name}`, fn, timeout);
}

const stats = () => JSON.parse(backend.manager.getNativeDiagnostics().nativeGatewayStats);
const idle = (what = 'the backend to hold no request') =>
  waitFor(() => stats().active_native_handles === 0, { timeoutMs: 10_000, what });

/**
 * Every `ipfsBackend()` capture, the handler's and the suite's, in order:
 * the partition it named, and how many times its `release()` was called.
 * The backends route the handler's captures through the manager's exports
 * at call time, so `recordCaptures` sees them.
 */
const captures = [];

function recordCaptures(manager) {
  const ipfsBackend = manager.ipfsBackend;
  manager.ipfsBackend = (options) => {
    const captured = ipfsBackend.call(manager, options);
    const entry = { partition: options?.partition ?? null, releases: 0 };
    captures.push(entry);
    if (typeof captured.release !== 'function') return captured;
    return Object.assign(Object.create(captured), {
      release() {
        entry.releases += 1;
        return captured.release();
      },
    });
  };
}

/** The handler's one capture since `mark`: it named `partition`. */
function handlerCapture(mark, partition) {
  const made = captures.slice(mark);
  expect(made.map((entry) => entry.partition)).toEqual([partition]);
  return made[0];
}

/**
 * The suite's own captures still held. Each is released on its terminal
 * path (`drop`), and whatever a failed test left is released after it, so
 * the suite never holds a lease past its test.
 */
const held = new Set();

/** `ipfsBackend({ partition })`, as the handler captures it at admission,
 * held by the suite until `drop`. */
function capture(partition = null) {
  const captured = backend.manager.ipfsBackend({ partition });
  held.add(captured);
  return captured;
}

/** Releases a capture of the suite's, once. */
function drop(captured) {
  if (held.delete(captured)) captured.release?.();
}

/** What `read` makes of a capture taken only to look at it. */
function inspect(partition, read) {
  const captured = capture(partition);
  try {
    return read(captured);
  } finally {
    drop(captured);
  }
}

const isUp = (partition = null) => inspect(partition, (captured) => captured.ref.up);

/** `body`, pulled only on demand as the executor's is, calling `onEnd` once
 * it ends, errors or is cancelled. */
function releasingBody(body, onEnd) {
  const reader = body.getReader();
  return new ReadableStream(
    {
      async pull(controller) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (err) {
          onEnd();
          controller.error(err);
          return;
        }
        if (chunk.done) {
          onEnd();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      cancel(reason) {
        onEnd();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

/** One request through a captured backend, as the plan executor makes it.
 * The capture is released when the request is over: its rejection, or its
 * body's end, error or cancel. */
async function request(
  path,
  { partition = null, method = 'GET', headers = {}, signal, headersTimeoutMs = HEADERS_MS } = {}
) {
  const captured = capture(partition);
  let res;
  try {
    res = await captured.request({
      path,
      method,
      headers: new Headers(headers),
      signal,
      headersTimeoutMs,
    });
  } catch (err) {
    drop(captured);
    throw err;
  }
  if (!res.body) {
    drop(captured);
    return res;
  }
  return new Response(
    releasingBody(res.body, () => drop(captured)),
    { status: res.status, statusText: res.statusText, headers: res.headers }
  );
}

/** One `ipfs:` request through the handler, as Chromium makes it. */
function ipfs(url, init = {}, { partition = null } = {}) {
  return backend.handleRequest('ipfs', new Request(url, init), {
    partition,
    isPrivate: partition !== null,
  });
}

/** A whole body, or null for none. */
const bodyOf = async (res) => (res.body ? readAll(res.body) : null);

/** Starts `promise` and reports how long it took to settle. */
async function timed(promise) {
  const started = Date.now();
  try {
    return { value: await promise, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

/** The backend running again, as a user's restart would leave it. */
async function ensureRunning() {
  if (isUp()) return;
  await backend.settle();
  await backend.manager.startIpfs();
  expect(isUp()).toBe(true);
}

describeContract(`IPFS backend contract (${BACKEND})`, () => {
  // A file of several leaves, a small text file, an empty file, and the
  // directories that hold them.
  let site;
  let bigBytes;

  beforeAll(async () => {
    content = new IpfsContent();
    bigBytes = uniqueBytes(3 * CHUNK_BYTES + 1234);
    const big = content.file(bigBytes);
    site = {
      big,
      text: content.file('hello contract\n'),
      empty: content.file(''),
      index: content.file('<h1>index</h1>'),
    };
    site.root = content.dir({
      'index.html': site.index,
      'big.bin': big,
      'a.txt': site.text,
      'empty.txt': site.empty,
      sub: content.dir({ 'b.txt': content.file('bee\n') }),
    });
    site.bare = content.dir({ 'x.txt': content.file('x\n'), 'y.bin': content.file('yy') });
    fixture = await startIpfsFixture(content);
    backend = await BACKENDS[BACKEND].load({ router: fixture.router });
    recordCaptures(backend.manager);
    await backend.manager.startIpfs();
  }, 60_000);

  afterAll(async () => {
    await backend?.close();
    await fixture?.close();
  }, 60_000);

  // Each test leaves the node idle and running. One that failed half-way
  // may leave requests open: the node is restarted, so the next test starts
  // clean instead of failing behind it.
  afterEach(async () => {
    for (const captured of [...held]) drop(captured);
    fixture.reset();
    if (isUp()) {
      try {
        await idle();
      } catch {
        await backend.manager.stopIpfs();
      }
    }
    await ensureRunning();
  }, 30_000);

  describe('the node', () => {
    test('starts with the parity table configuration', () => {
      expect(backend.startConfig()).toEqual(TODAY_CONFIG);
    });

    test('the backend reference: native, up, no URL, for the profile and a private partition alike', () => {
      for (const partition of [null, PRIVATE]) {
        inspect(partition, (captured) => {
          expect(captured.ref).toEqual({ ipfs: 'native', up: true });
          expect(captured.url).toBeNull();
          expect(typeof captured.request).toBe('function');
        });
      }
    });
  });

  describe('GET and HEAD', () => {
    test('a single-block file: its bytes, length, type and validators', async () => {
      const res = await request(`/ipfs/${site.text.cid}`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe('15');
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('etag')).toContain(site.text.cid);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect((await bodyOf(res)).toString()).toBe('hello contract\n');
      await idle();
    });

    test('a file of several blocks, byte for byte', async () => {
      const res = await request(`/ipfs/${site.root.cid}/big.bin`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(bigBytes.length));
      expect((await bodyOf(res)).equals(bigBytes)).toBe(true);
      await idle();
    });

    test('HEAD: the same head, and no body', async () => {
      const get = await request(`/ipfs/${site.root.cid}/a.txt`);
      await bodyOf(get);
      const head = await request(`/ipfs/${site.root.cid}/a.txt`, { method: 'HEAD' });

      expect(head.status).toBe(200);
      expect(head.body).toBeNull();
      expect([...head.headers]).toEqual([...get.headers]);
      await idle();
    });

    test('a zero-length file: a 200 with Content-Length 0 and an empty body; HEAD alike', async () => {
      const res = await request(`/ipfs/${site.root.cid}/empty.txt`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe('0');
      expect((await bodyOf(res)) ?? Buffer.alloc(0)).toHaveLength(0);

      const head = await request(`/ipfs/${site.root.cid}/empty.txt`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe('0');
      expect(head.body).toBeNull();
      await idle();
    });
  });

  // Roadmap 4.7: real 206s, from a real node.
  describe('Range', () => {
    const total = () => bigBytes.length;
    const range = async (value, method = 'GET') => {
      const res = await request(`/ipfs/${site.root.cid}/big.bin`, {
        method,
        headers: { range: value },
      });
      return { res, bytes: await bodyOf(res) };
    };

    test('bytes=100-199: a 206 with its Content-Range and exactly those bytes', async () => {
      const { res, bytes } = await range('bytes=100-199');

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 100-199/${total()}`);
      expect(res.headers.get('content-length')).toBe('100');
      expect(bytes.equals(bigBytes.subarray(100, 200))).toBe(true);
    });

    test('a range across a block boundary', async () => {
      const start = CHUNK_BYTES - 10;
      const end = 2 * CHUNK_BYTES + 10;
      const { res, bytes } = await range(`bytes=${start}-${end}`);

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/${total()}`);
      expect(bytes.equals(bigBytes.subarray(start, end + 1))).toBe(true);
    });

    test('bytes=-N: the last N bytes', async () => {
      const { res, bytes } = await range('bytes=-10');

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(
        `bytes ${total() - 10}-${total() - 1}/${total()}`
      );
      expect(bytes.equals(bigBytes.subarray(total() - 10))).toBe(true);
    });

    test('bytes=N-: from N to the end', async () => {
      const start = total() - 1000;
      const { res, bytes } = await range(`bytes=${start}-`);

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${total() - 1}/${total()}`);
      expect(bytes.equals(bigBytes.subarray(start))).toBe(true);
    });

    test('an end past EOF is clamped to the last byte', async () => {
      const start = total() - 5;
      const { res, bytes } = await range(`bytes=${start}-99999999`);

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${total() - 1}/${total()}`);
      expect(res.headers.get('content-length')).toBe('5');
      expect(bytes.equals(bigBytes.subarray(start))).toBe(true);
    });

    test('a start past EOF is a 416 head with a body', async () => {
      const { res, bytes } = await range(`bytes=${total()}-`);

      expect(res.status).toBe(416);
      expect(bytes.length).toBeGreaterThan(0);
      await idle();
    });

    test('a range of a zero-length file is a 416', async () => {
      const res = await request(`/ipfs/${site.root.cid}/empty.txt`, {
        headers: { range: 'bytes=0-' },
      });

      expect(res.status).toBe(416);
      await bodyOf(res);
    });

    test('HEAD with a range: the 206 head, no body', async () => {
      const { res, bytes } = await range('bytes=100-199', 'HEAD');

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 100-199/${total()}`);
      expect(bytes).toBeNull();
      await idle();
    });
  });

  describe('directories', () => {
    test('a directory with index.html serves it, with or without the trailing slash', async () => {
      for (const path of [`/ipfs/${site.root.cid}/`, `/ipfs/${site.root.cid}`]) {
        const res = await request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html');
        expect((await bodyOf(res)).toString()).toBe('<h1>index</h1>');
      }
    });

    test('a directory without one is listed, as HTML naming its entries', async () => {
      const res = await request(`/ipfs/${site.bare.cid}/`);
      const html = (await bodyOf(res)).toString();

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(html).toContain('x.txt');
      expect(html).toContain('y.bin');
    });

    test('a nested path is resolved, and typed by its name', async () => {
      const res = await request(`/ipfs/${site.root.cid}/sub/b.txt`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain');
      expect((await bodyOf(res)).toString()).toBe('bee\n');
    });

    test('a missing entry is a 404 head with a body', async () => {
      const res = await request(`/ipfs/${site.root.cid}/missing.txt`);

      expect(res.status).toBe(404);
      expect((await bodyOf(res)).length).toBeGreaterThan(0);
      await idle();
    });
  });

  describe('errors and status mapping', () => {
    test('HTTP failures are heads: an invalid CID is a 400', async () => {
      const res = await request('/ipfs/notacid/');

      expect(res.status).toBe(400);
      await bodyOf(res);
      await idle();
    });

    test('content nobody provides is a 502 head', async () => {
      const unknown = new IpfsContent().raw(uniqueBytes(100)).cid;
      const res = await request(`/ipfs/${unknown}`);

      expect(res.status).toBe(502);
      await bodyOf(res);
      await idle();
    });

    // Retrieval gives a failing provider up after its own budget (about
    // 10 s in v0.4.5), well inside the head deadline.
    test('a block the provider fails is a 502 head', async () => {
      const file = content.file(uniqueBytes(1000));
      const provider = await fixture.isolate(file);
      provider.fail(file.cid, 500);
      const res = await request(`/ipfs/${file.cid}`);

      expect(res.status).toBe(502);
      await bodyOf(res);
      await idle();
    }, 30_000);

    test('a method other than GET or HEAD rejects as not started, and nothing is fetched', async () => {
      const before = fixture.requests.length;
      await expect(request(`/ipfs/${site.text.cid}`, { method: 'POST' })).rejects.toThrow(
        'freedom-ipfs native request could not be started'
      );
      expect(fixture.requests).toHaveLength(before);
      await idle();
    });

    test('a body that fails mid-way errors: a truncation, never a short success', async () => {
      // The node fetches a few blocks before it answers the head: the one
      // that fails sits well past them.
      const bytes = uniqueBytes(8 * CHUNK_BYTES);
      const file = content.file(bytes);
      expect(file.leaves).toHaveLength(8);
      const provider = await fixture.isolate(file);
      provider.fail(file.leaves[5].cid, 500);

      const res = await request(`/ipfs/${file.cid}`);
      expect(res.status).toBe(200);
      const { bytes: read, error } = await readUntilError(res.body.getReader());

      expect(read).toBeLessThan(bytes.length);
      expect(error?.message).toBe('freedom-ipfs native read failed');
      await idle();
    }, 30_000);

    test('through the handler: a stopped node is a 503, and nothing is requested', async () => {
      await backend.manager.stopIpfs();
      const before = fixture.requests.length;

      const res = await ipfs(`ipfs://${site.text.cid}/`);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: 503, message: 'freedom-ipfs node is not running' });
      expect(fixture.requests).toHaveLength(before);
    });

    test("through the handler: a rejection is a 502 with the backend's message", async () => {
      const file = content.file(uniqueBytes(2000));
      (await fixture.isolate(file)).stall(file.cid);
      const controller = new AbortController();

      const pending = ipfs(`ipfs://${file.cid}/`, { signal: controller.signal });
      await waitFor(() => fixture.asked(file.cid), { what: 'the block request' });
      controller.abort();
      const res = await pending;

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        code: 502,
        message: 'freedom-ipfs native request aborted',
      });
      await idle();
    });

    test('through the handler: Range in, the 206 out with its Content-Range', async () => {
      const res = await ipfs(`ipfs://${site.root.cid}/big.bin`, {
        headers: { Range: 'bytes=10-19' },
      });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 10-19/${bigBytes.length}`);
      expect((await bodyOf(res)).equals(bigBytes.subarray(10, 20))).toBe(true);
    });

    // The 15 s queue behind the 8 header permits: the ninth waiting request
    // gets the gateway's own 503, which passes through unchanged.
    test('past the header permits and the 15 s queue: 503 gateway_busy with Retry-After: 1', async () => {
      const held = Array.from({ length: 8 }, () => content.file(uniqueBytes(500)));
      const provider = await fixture.isolate(...held);
      for (const file of held) provider.stall(file.cid);
      const busyBefore = stats().total_gateway_busy_responses;
      const holders = held.map((file) => request(`/ipfs/${file.cid}`));
      await waitFor(() => held.every((file) => fixture.asked(file.cid)), {
        timeoutMs: 10_000,
        what: 'eight requests holding the permits',
      });

      const { value: res, ms } = await timed(request(`/ipfs/${site.text.cid}`));

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(ms).toBeGreaterThanOrEqual(TODAY_CONFIG.requestQueueTimeoutMs - 100);
      await bodyOf(res);
      expect(stats().total_gateway_busy_responses).toBe(busyBefore + 1);

      for (const file of held) provider.release(file.cid);
      for (const answer of await Promise.all(holders)) {
        expect(answer.status).toBe(200);
        await bodyOf(answer);
      }
      await idle();
    }, 45_000);
  });

  describe('deadlines', () => {
    test('no head within headersTimeoutMs: rejected as a timeout at the deadline, and freed', async () => {
      const file = content.file(uniqueBytes(3000));
      (await fixture.isolate(file)).stall(file.cid);

      const { error, ms } = await timed(request(`/ipfs/${file.cid}`, { headersTimeoutMs: 500 }));

      expect(error?.message).toBe('freedom-ipfs native request timeout');
      expect(ms).toBeGreaterThanOrEqual(490);
      expect(ms).toBeLessThan(3000);
      await idle();
    });

    test('routing counts toward the deadline: a provider lookup that never answers times out', async () => {
      const file = content.file(uniqueBytes(3000));
      fixture.stallRouting();

      const { error, ms } = await timed(request(`/ipfs/${file.cid}`, { headersTimeoutMs: 500 }));

      expect(error?.message).toBe('freedom-ipfs native request timeout');
      expect(ms).toBeLessThan(3000);
      await idle();
    });

    test('the deadline ends at the head: a reader paused past it still reads every byte', async () => {
      const bytes = uniqueBytes(2 * CHUNK_BYTES + 77);
      const file = content.file(bytes);

      const res = await request(`/ipfs/${file.cid}`, { headersTimeoutMs: 1000 });
      const reader = res.body.getReader();
      const first = Buffer.from((await reader.read()).value);
      await nextTurn(2500);
      const rest = await readAll(reader);

      expect(Buffer.concat([first, rest]).equals(bytes)).toBe(true);
      await idle();
    });
  });

  describe('cancel', () => {
    test('aborted before the call: rejected at once, and nothing is started', async () => {
      const controller = new AbortController();
      controller.abort();
      const started = stats().total_started;
      const before = fixture.requests.length;

      await expect(
        request(`/ipfs/${site.text.cid}`, { signal: controller.signal })
      ).rejects.toThrow('freedom-ipfs native request aborted');
      expect(stats().total_started).toBe(started);
      expect(fixture.requests).toHaveLength(before);
    });

    test('aborted before the head: rejected at once, and freed', async () => {
      const file = content.file(uniqueBytes(4000));
      (await fixture.isolate(file)).stall(file.cid);
      const controller = new AbortController();

      const pending = timed(request(`/ipfs/${file.cid}`, { signal: controller.signal }));
      await waitFor(() => fixture.asked(file.cid), { what: 'the block request' });
      controller.abort();
      const { error, ms } = await pending;

      expect(error?.message).toBe('freedom-ipfs native request aborted');
      expect(ms).toBeLessThan(HEADERS_MS);
      await idle();
    });

    test('aborted mid-body: the body errors as cancelled, and the request is freed', async () => {
      const controller = new AbortController();
      const cancelled = stats().total_cancelled;
      const res = await request(`/ipfs/${site.root.cid}/big.bin`, { signal: controller.signal });
      const reader = res.body.getReader();
      await reader.read();

      controller.abort();
      const { error } = await readUntilError(reader);

      expect(error?.message).toBe('freedom-ipfs native request cancelled');
      await idle();
      expect(stats().total_cancelled).toBeGreaterThan(cancelled);
    });

    test('the body cancelled by its consumer: the request is freed', async () => {
      const res = await request(`/ipfs/${site.root.cid}/big.bin`);
      const reader = res.body.getReader();
      await reader.read();

      await reader.cancel();

      await idle();
    });

    test('a paused body aborted: it errors at once, and is freed', async () => {
      const controller = new AbortController();
      const res = await request(`/ipfs/${site.root.cid}/big.bin`, { signal: controller.signal });
      const reader = res.body.getReader();
      await reader.read();
      await nextTurn(200);

      controller.abort();
      await idle();
      const { error } = await readUntilError(reader);

      expect(error?.message).toBe('freedom-ipfs native request cancelled');
    });

    test('cancels leak nothing: after more cancels than permits, the next request is served at once', async () => {
      const file = content.file(uniqueBytes(5000));
      const provider = await fixture.isolate(file);
      provider.stall(file.cid);
      for (let i = 0; i < 10; i++) {
        const controller = new AbortController();
        const pending = request(`/ipfs/${file.cid}`, { signal: controller.signal });
        await nextTurn(20);
        controller.abort();
        await expect(pending).rejects.toThrow('freedom-ipfs native request aborted');
      }
      provider.release(file.cid);
      await idle();

      const { value: res, ms } = await timed(request(`/ipfs/${site.text.cid}`));

      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(5000);
      await bodyOf(res);
    }, 30_000);
  });

  describe('backpressure', () => {
    test('a paused consumer: the backend reads no further ahead than its window', async () => {
      const bytes = uniqueBytes(8 * CHUNK_BYTES);
      const file = content.file(bytes);
      const readBefore = stats().bytes_read;

      const res = await request(`/ipfs/${file.cid}`);
      const reader = res.body.getReader();
      let consumed = (await reader.read()).value.byteLength;
      await nextTurn(500);
      expect(stats().bytes_read - readBefore - consumed).toBeLessThanOrEqual(
        backend.readAheadBytes
      );

      for (let i = 0; i < 6; i++) {
        consumed += (await reader.read()).value.byteLength;
        await nextTurn(100);
        expect(stats().bytes_read - readBefore - consumed).toBeLessThanOrEqual(
          backend.readAheadBytes
        );
      }
      await reader.cancel();
      await idle();
    });
  });

  // The small-text rule (dweb/response-operations.js) on a real node's
  // answers: a bare file has no name to type it by, so the node answers
  // application/octet-stream.
  describe('the small_text rule on real answers', () => {
    const navigate = async (bytes, { accept = NAVIGATION_ACCEPT, method = 'GET' } = {}) => {
      const file = content.file(bytes);
      const res = await ipfs(`ipfs://${file.cid}/`, {
        method,
        headers: accept === null ? {} : { Accept: accept },
      });
      return { res, body: await bodyOf(res) };
    };

    test.each([
      ['plain text', 'Hello from IPFS Gateway Checker\n'],
      ['HTML-looking text, still only text', '<script>alert(1)</script>'],
      ['multi-byte UTF-8', `caf${String.fromCharCode(0xe9)} ${String.fromCodePoint(0x1f680)}\n`],
      ['exactly 4096 bytes', 'a'.repeat(4096)],
    ])('relabels %s as text/plain + nosniff, bytes intact', async (_label, text) => {
      const { res, body } = await navigate(Buffer.from(text));

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(body.equals(Buffer.from(text))).toBe(true);
    });

    test.each([
      ['4097 bytes', Buffer.from('a'.repeat(4097)), {}],
      ['a NUL byte', Buffer.from([0x61, 0x00, 0x62]), {}],
      ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0x41]), {}],
      ['a fetch Accept', Buffer.from('text\n'), { accept: '*/*' }],
      ['no Accept', Buffer.from('text\n'), { accept: null }],
    ])('leaves %s as the node typed it, bytes intact', async (_label, bytes, options) => {
      const { res, body } = await navigate(bytes, options);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('x-content-type-options')).toBeNull();
      expect(body.equals(bytes)).toBe(true);
    });

    test('leaves a HEAD alone', async () => {
      const { res, body } = await navigate(Buffer.from('text\n'), { method: 'HEAD' });

      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(body).toBeNull();
    });
  });

  // `ref.up` is node readiness, and the backend a request captured stays the
  // one it uses ("Instance IDs": a continuation never reaches a replacement).
  describe('readiness and capture', () => {
    test('a stopped node: ref.up is false for every partition, and its URL stays null', async () => {
      await backend.manager.stopIpfs();

      for (const partition of [null, PRIVATE]) {
        inspect(partition, (captured) => {
          expect(captured.ref).toEqual({ ipfs: 'native', up: false });
          expect(captured.url).toBeNull();
        });
      }
    });

    test('a backend captured before a stop rejects as not running, and sends nothing', async () => {
      const captured = capture();
      await backend.manager.stopIpfs();
      const before = fixture.requests.length;

      await expect(
        captured.request({
          path: `/ipfs/${site.text.cid}`,
          method: 'GET',
          headers: new Headers(),
          headersTimeoutMs: HEADERS_MS,
        })
      ).rejects.toThrow('freedom-ipfs native node is not running');
      drop(captured);
      expect(fixture.requests).toHaveLength(before);
    });

    test('a backend captured before a restart never reaches the new node', async () => {
      const captured = capture();
      await backend.manager.stopIpfs();
      await backend.manager.startIpfs();
      const started = stats().total_started;

      await expect(
        captured.request({
          path: `/ipfs/${site.text.cid}`,
          method: 'GET',
          headers: new Headers(),
          headersTimeoutMs: HEADERS_MS,
        })
      ).rejects.toThrow('freedom-ipfs native node is not running');
      drop(captured);
      expect(stats().total_started).toBe(started);
      // The new node serves its own requests.
      const res = await request(`/ipfs/${site.text.cid}`);
      expect(res.status).toBe(200);
      await bodyOf(res);
    });

    test('a backend that ends: its open body truncates, ref.up turns false, and the handler answers 503', async () => {
      const res = await request(`/ipfs/${site.root.cid}/big.bin`);
      const reader = res.body.getReader();
      await reader.read();

      backend.crash();
      const { error } = await readUntilError(reader);
      await waitFor(() => !isUp(), { what: 'the backend to be down' });
      const next = await ipfs(`ipfs://${site.text.cid}/`);

      expect(error?.message).toBe(backend.exitText);
      expect(next.status).toBe(503);
      expect(await next.json()).toEqual({ code: 503, message: 'freedom-ipfs node is not running' });
    });

    pendingTest(
      'auto-restart',
      'a backend that ends is restarted with back-off, and serves again on its own',
      async () => {
        backend.crash();
        await waitFor(() => !isUp(), { what: 'the backend to be down' });
        await waitFor(() => isUp(), { timeoutMs: 15_000, what: 'the restart' });

        const res = await request(`/ipfs/${site.text.cid}`);
        expect(res.status).toBe(200);
        await bodyOf(res);
      },
      30_000
    );
  });

  describe('private partitions', () => {
    test("a private partition's backend is up while the node is, and serves its requests", async () => {
      const res = await request(`/ipfs/${site.root.cid}/a.txt`, { partition: PRIVATE });

      expect(res.status).toBe(200);
      expect((await bodyOf(res)).toString()).toBe('hello contract\n');
      await idle();
    });

    test('through the handler, in a private window', async () => {
      const res = await ipfs(`ipfs://${site.root.cid}/sub/b.txt`, {}, { partition: PRIVATE });

      expect(res.status).toBe(200);
      expect((await bodyOf(res)).toString()).toBe('bee\n');
    });

    // Loaded in one place, then its provider fails: only the cache that
    // loaded it may still serve it.
    const loadThenFail = async (partition) => {
      const file = content.file(uniqueBytes(2000));
      const provider = await fixture.isolate(file);
      const first = await request(`/ipfs/${file.cid}`, { partition });
      expect(first.status).toBe(200);
      await bodyOf(first);
      provider.fail(file.cid, 500);
      return file;
    };
    const servedFromCache = async (file, partition) => {
      const res = await request(`/ipfs/${file.cid}`, { partition, headersTimeoutMs: 5000 }).catch(
        () => null
      );
      if (res) await bodyOf(res);
      return res?.status === 200;
    };

    pendingTest(
      'private-instances',
      "the profile's cache never serves a private partition",
      async () => {
        const file = await loadThenFail(null);
        expect(await servedFromCache(file, null)).toBe(true);
        expect(await servedFromCache(file, PRIVATE)).toBe(false);
      },
      30_000
    );

    pendingTest(
      'private-instances',
      "a private partition's loads reach neither the profile's cache nor another partition's",
      async () => {
        const file = await loadThenFail(PRIVATE);
        expect(await servedFromCache(file, PRIVATE)).toBe(true);
        expect(await servedFromCache(file, null)).toBe(false);
        expect(await servedFromCache(file, OTHER_PRIVATE)).toBe(false);
      },
      30_000
    );

    pendingTest(
      'leases',
      'the backend carries release(): a lease pins its partition, and a second release is harmless',
      () => {
        expect(typeof backend.pins).toBe('function');
        const first = capture(PRIVATE);
        const second = capture(PRIVATE);
        expect(typeof first.release).toBe('function');
        expect(backend.pins(PRIVATE)).toBe(2);

        first.release();
        first.release();

        // The second call took nothing from the other lease.
        expect(backend.pins(PRIVATE)).toBe(1);
        drop(second);
        expect(backend.pins(PRIVATE)).toBe(0);
      }
    );

    pendingTest(
      'backend-busy',
      'eight pinned partitions: each serves again, a ninth is BackendBusy (503 through the handler) with ref.up true, and a release makes room',
      async () => {
        const partitions = Array.from({ length: 8 }, (_, i) => `private-busy-${i}`);
        const ninthPartition = 'private-busy-ninth';
        const viaCapture = async (captured) => {
          const res = await captured.request({
            path: `/ipfs/${site.text.cid}`,
            method: 'GET',
            headers: new Headers(),
            headersTimeoutMs: HEADERS_MS,
          });
          expect(res.status).toBe(200);
          await bodyOf(res);
        };
        // These leases are held on purpose, and released whatever happens.
        const pinned = [];
        try {
          for (const partition of partitions) {
            const captured = capture(partition);
            pinned.push(captured);
            await viaCapture(captured);
          }
          // Another request from each pinned partition still succeeds.
          for (const partition of partitions) {
            const extra = capture(partition);
            try {
              await viaCapture(extra);
            } finally {
              drop(extra);
            }
          }

          let refused = null;
          try {
            drop(capture(ninthPartition));
          } catch (err) {
            refused = err;
          }
          expect(refused?.name).toBe('BackendBusy');
          const answer = await ipfs(`ipfs://${site.text.cid}/`, {}, { partition: ninthPartition });
          expect(answer.status).toBe(503);
          expect((await answer.json()).message).toBe(
            'Too many private windows are loading IPFS content'
          );
          // Capacity is not readiness: the node is still up.
          expect(isUp(partitions[0])).toBe(true);

          drop(pinned[0]);
          const ninth = capture(ninthPartition);
          try {
            await viaCapture(ninth);
          } finally {
            drop(ninth);
          }
        } finally {
          for (const captured of pinned) drop(captured);
        }
      },
      60_000
    );
  });

  // "Main's side", the lease: the handler captures the request's partition
  // once, at admission, holds that lease through an unfinished body, and
  // releases it exactly once on every exit. Read from the captures the
  // handler made (`recordCaptures`), not only from the pins.
  describe('leases', () => {
    const pins = (partition = PRIVATE) => {
      expect(typeof backend.pins).toBe('function');
      return backend.pins(partition);
    };

    // Exits that hand a body on: the lease is live while it is unfinished,
    // and released once when it ends. Multi-block bodies check the lease
    // again after their first chunk (`stillLive`), so a release during
    // streaming fails, not only one at the head.
    const bodyExits = [
      [
        'a body read to its end',
        '/a.txt',
        {},
        200,
        async (reader) => {
          await readAll(reader);
        },
      ],
      [
        'a multi-block body read to its end',
        '/big.bin',
        {},
        200,
        async (reader, controller, stillLive) => {
          await reader.read();
          await stillLive();
          await readAll(reader);
        },
      ],
      [
        'a body cancelled by its consumer',
        '/big.bin',
        {},
        200,
        async (reader, controller, stillLive) => {
          await reader.read();
          await stillLive();
          await reader.cancel();
        },
      ],
      [
        'a body aborted mid-way',
        '/big.bin',
        { abort: true },
        200,
        async (reader, controller, stillLive) => {
          await reader.read();
          await stillLive();
          controller.abort();
          await readUntilError(reader);
        },
      ],
      [
        "an HTTP failure head's body (404)",
        '/missing',
        {},
        404,
        async (reader) => {
          await readAll(reader);
        },
      ],
    ];
    for (const [exit, path, { abort = false }, status, finish] of bodyExits) {
      pendingTest('leases', `held through ${exit}, then released once`, async () => {
        const controller = new AbortController();
        const mark = captures.length;

        const res = await ipfs(
          `ipfs://${site.root.cid}${path}`,
          abort ? { signal: controller.signal } : {},
          { partition: PRIVATE }
        );
        expect(res.status).toBe(status);
        const lease = handlerCapture(mark, PRIVATE);
        // The body is handed on and unfinished: its lease is live.
        expect(lease.releases).toBe(0);
        expect(pins()).toBe(1);

        // After a chunk has been read, the body is still unfinished: the
        // same lease is still held, and nothing has released it.
        const stillLive = async () => {
          await new Promise((resolve) => setImmediate(resolve));
          expect(lease.releases).toBe(0);
          expect(pins()).toBe(1);
        };
        await finish(res.body.getReader(), controller, stillLive);

        await waitFor(() => lease.releases > 0, { what: 'the lease to be released' });
        expect(lease.releases).toBe(1);
        expect(pins()).toBe(0);
        expect(captures.length).toBe(mark + 1);
      });
    }

    // Exits with no body to hand on: released once by the time the answer
    // is back.
    const immediateExits = [
      [
        'a HEAD, which has no body',
        200,
        () => ipfs(`ipfs://${site.root.cid}/a.txt`, { method: 'HEAD' }, { partition: PRIVATE }),
      ],
      [
        'an error plan (405)',
        405,
        () => ipfs(`ipfs://${site.text.cid}/`, { method: 'POST' }, { partition: PRIVATE }),
      ],
      [
        'a redirect plan (a gateway-form URL)',
        307,
        () => ipfs(`ipfs://ipfs.io/ipfs/${site.text.cid}`, {}, { partition: PRIVATE }),
      ],
      [
        'an abort before the fetch',
        502,
        () => {
          const controller = new AbortController();
          controller.abort();
          return ipfs(
            `ipfs://${site.text.cid}/`,
            { signal: controller.signal },
            { partition: PRIVATE }
          );
        },
      ],
      [
        'a rejected request()',
        502,
        async () => {
          const file = content.file(uniqueBytes(1500));
          (await fixture.isolate(file)).stall(file.cid);
          const controller = new AbortController();
          const pending = ipfs(
            `ipfs://${file.cid}/`,
            { signal: controller.signal },
            { partition: PRIVATE }
          );
          await waitFor(() => fixture.asked(file.cid), { what: 'the block request' });
          controller.abort();
          return pending;
        },
      ],
    ];
    for (const [exit, status, run] of immediateExits) {
      pendingTest('leases', `released once on ${exit}`, async () => {
        const mark = captures.length;

        const res = await run();

        expect(res.status).toBe(status);
        const lease = handlerCapture(mark, PRIVATE);
        expect(lease.releases).toBe(1);
        expect(pins()).toBe(0);
      });
    }

    pendingTest('leases', "closing the partition's session releases what is left", async () => {
      const partition = 'private-contract-closing';
      const left = capture(partition);
      expect(pins(partition)).toBe(1);

      backend.closeDwebSession(partition);

      await waitFor(() => pins(partition) === 0, { what: 'the pins to return to zero' });
      expect(() => drop(left)).not.toThrow();
      expect(pins(partition)).toBe(0);
    });
  });
});
