/**
 * One call of main's Swarm executor on the node's transport (freedom-core
 * design 0015, The transport and Main's Swarm I/O pool; the SWM-5 plan's
 * point 6), and the POST body the backend's `request()` carries: the real
 * Ant backend (`antBackend()`) against a fake node over real loopback HTTP,
 * with Node's real `fetch`.
 *
 * The remote node's dial (the session's stack, the guard's announcement) is
 * in `bzz-protocol.test.js`; the stack's own stream writer in
 * `ipfs/gateway-transport.test.js`; a remote POST through a real session's
 * proxy in `__tests__/integration/swarm-post-proxy.test.js`.
 */

const crypto = require('crypto');
const zlib = require('zlib');

const mockRegistry = { url: null };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => ({ mode: 'bundled' }),
}));
jest.mock('../core/dweb-verify', () => ({ dwebVerifier: () => null }));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { antBackend } = require('./bzz-protocol');
const { callAnt, ANT_BODY_IDLE_MS } = require('./ant-api-call');
const {
  closedLoopbackPort,
  nextTurn,
  readAll,
  readUntilError,
  startFakeHttpNode,
  streamBody,
  waitFor,
  waitUntilStable,
} = require('../../../test/helpers/fake-http-node');

const KIB = 1024;
const MIB = 1024 * KIB;

let node;

beforeEach(async () => {
  node = await startFakeHttpNode();
  mockRegistry.url = node.origin;
});

afterEach(async () => {
  jest.useRealTimers();
  await node.close();
});

function useFakeClock() {
  // Only main's timers: the sockets and the helpers' waits stay real.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
}

// Node's fetch, counted: every dial the backend makes.
function countedFetch() {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url: String(url), init });
    return fetch(url, init);
  };
  return { calls, fetchImpl };
}

const call = (over = {}) => ({
  path: '/stamps',
  method: 'GET',
  headers: new Headers({ accept: 'application/json, text/plain, */*' }),
  signal: new AbortController().signal,
  ...over,
});

// A request body the transport pulls: `chunks` fresh chunks of `size` bytes,
// each read counted in `pulls`, the bytes hashed as they go.
function pulledBody({ chunks, size = 64 * KIB }) {
  const state = { pulls: 0, hash: crypto.createHash('sha256'), cancelled: null };
  state.stream = new ReadableStream(
    {
      pull(controller) {
        if (state.pulls === chunks) {
          controller.close();
          return;
        }
        state.pulls += 1;
        const chunk = Buffer.alloc(size, state.pulls % 251);
        state.hash.update(chunk);
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      },
      cancel(reason) {
        state.cancelled = reason;
      },
    },
    { highWaterMark: 0 }
  );
  return state;
}

// The node reads a request's body and answers 201 with its length and hash.
function readingNode({ pause = false } = {}) {
  const seen = {};
  node.handle((req, res) => {
    const hash = crypto.createHash('sha256');
    seen.bytes = 0;
    seen.req = req;
    req.on('data', (chunk) => {
      seen.bytes += chunk.length;
      hash.update(chunk);
    });
    req.on('end', () => {
      seen.digest = hash.digest('hex');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reference: 'ab'.repeat(32) }));
    });
    if (pause) req.pause();
  });
  return seen;
}

describe('callAnt: one dial per admitted call', () => {
  test('no retry: a 503 is the answer, from one dial', async () => {
    node.handle((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"code":503,"message":"node busy"}');
    });
    const { calls, fetchImpl } = countedFetch();

    const reply = await callAnt(antBackend({ fetchImpl }), call());
    expect(reply.status).toBe(503);
    await expect(readAll(reply.body)).resolves.toEqual(
      Buffer.from('{"code":503,"message":"node busy"}')
    );
    await nextTurn(50);
    expect(calls).toHaveLength(1);
    expect(node.requests).toHaveLength(1);
  });

  test("no retry: a refused connection rejects once, with the transport's code", async () => {
    mockRegistry.url = `http://127.0.0.1:${await closedLoopbackPort()}`;
    const { calls, fetchImpl } = countedFetch();

    const err = await callAnt(antBackend({ fetchImpl }), call()).catch((error) => error);
    expect(err?.cause?.code || err?.code).toBe('ECONNREFUSED');
    await nextTurn(50);
    expect(calls).toHaveLength(1);
  });

  test('a POST is never sent twice: a connection reset mid-upload is the answer', async () => {
    node.handle((req) => {
      req.once('data', () => req.socket.destroy());
    });
    const body = pulledBody({ chunks: 64 });
    const { calls, fetchImpl } = countedFetch();

    const err = await callAnt(
      antBackend({ fetchImpl }),
      call({ path: '/bytes', method: 'POST', body: body.stream })
    ).catch((error) => error);
    expect(err?.message).toBe('fetch failed');
    await nextTurn(50);
    expect(calls).toHaveLength(1);
    expect(node.requests).toHaveLength(1);
  });

  test('no header deadline: main waits as long as the call lives', async () => {
    let answer;
    node.handle((_req, res) => {
      answer = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"stamps":[]}');
      };
    });
    useFakeClock();
    let settled = false;
    const pending = callAnt(antBackend(), call()).finally(() => {
      settled = true;
    });
    await waitFor(() => answer, { what: 'the dial' });

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    await nextTurn(20);
    expect(settled).toBe(false);

    answer();
    const reply = await pending;
    expect(reply.status).toBe(200);
    await expect(readAll(reply.body)).resolves.toEqual(Buffer.from('{"stamps":[]}'));
  });

  test("the call's cancel aborts a dial that has no answer yet", async () => {
    node.handle(() => {});
    const cancel = new AbortController();
    const pending = callAnt(antBackend(), call({ signal: cancel.signal }));
    await waitFor(() => node.requests.length === 1, { what: 'the dial' });

    cancel.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => node.requests[0].closed, { what: 'the node to see the abort' });
  });
});

describe("callAnt: the reply's headers", () => {
  test('content-length is dropped beside a content-encoding: the stack decoded the body', async () => {
    const plain = Buffer.from(JSON.stringify({ stamps: 'a'.repeat(100 * KIB) }));
    const gzipped = zlib.gzipSync(plain);
    node.handle((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': String(gzipped.length),
      });
      res.end(gzipped);
    });

    const reply = await callAnt(antBackend(), call());
    expect(reply.headers.get('content-encoding')).toBe('gzip');
    expect(reply.headers.has('content-length')).toBe(false);
    expect(reply.headers.get('content-type')).toBe('application/json');
    // The decoded body, far past the length the node declared.
    const body = await readAll(reply.body);
    expect(body.equals(plain)).toBe(true);
    expect(body.length).toBeGreaterThan(gzipped.length * 10);
  });

  test("without a content-encoding, the node's content-length stays", async () => {
    node.handle((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '13' });
      res.end('{"stamps":[]}');
    });

    const reply = await callAnt(antBackend(), call());
    expect(reply.headers.get('content-length')).toBe('13');
    expect(reply.statusText).toBe('OK');
  });

  test('a reply without a body has none, and nothing to end', async () => {
    node.handle((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const onEnd = jest.fn();

    const reply = await callAnt(antBackend(), call({ onEnd }));
    expect(reply.status).toBe(204);
    expect(reply.body).toBeNull();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe("callAnt: a body's 60 s idle bound", () => {
  test('a whole body that gets no byte for 60 s fails, and the node is let go', async () => {
    node.handle((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(MIB) });
      res.write(Buffer.alloc(1000, 0x61));
    });
    useFakeClock();
    const onEnd = jest.fn();

    const reply = await callAnt(antBackend(), call({ onEnd }));
    const reader = reply.body.getReader();
    await reader.read();
    const stalled = readUntilError(reader);
    await nextTurn(20);
    expect(ANT_BODY_IDLE_MS).toBe(60_000);
    await jest.advanceTimersByTimeAsync(ANT_BODY_IDLE_MS - 1);
    expect(node.requests[0].closed).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    const { error } = await stalled;
    expect(error.name).toBe('BodyIdleError');
    expect(onEnd).toHaveBeenCalledWith(error);
    await waitFor(() => node.requests[0].closed, { what: 'the upstream to be aborted' });
    expect(node.requests[0].aborted).toBe(true);
  });

  test('a body that trickles inside the bound is read whole', async () => {
    const parts = [];
    node.handle((_req, res) => {
      res.writeHead(200, { 'Content-Length': '3' });
      parts.push(res);
      res.write('a');
    });
    useFakeClock();

    const reply = await callAnt(antBackend(), call());
    const all = readAll(reply.body);
    for (const byte of ['b', 'c']) {
      await nextTurn(20);
      await jest.advanceTimersByTimeAsync(ANT_BODY_IDLE_MS - 1);
      if (byte === 'c') parts[0].end(byte);
      else parts[0].write(byte);
    }
    await expect(all).resolves.toEqual(Buffer.from('abc'));
  });

  // A streamed reply is read only as the core's credit allows: with no read
  // pending (no credit outstanding), its clock doesn't run.
  test('a body nobody is reading is never timed out', async () => {
    node.handle((_req, res, entry) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      streamBody(entry);
    });
    useFakeClock();

    const reply = await callAnt(antBackend(), call({ path: `/bytes/${'ab'.repeat(32)}` }));
    const reader = reply.body.getReader();
    await reader.read();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await nextTurn(20);
    expect(node.requests[0].closed).toBe(false);

    const next = await reader.read();
    expect(next.done).toBe(false);
    expect(next.value.byteLength).toBeGreaterThan(0);
    await reader.cancel();
    await waitFor(() => node.requests[0].closed, { what: 'the upstream to stop' });
  });

  test("the call's cancel fails the body at once, read or not", async () => {
    node.handle((_req, res, entry) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      streamBody(entry);
    });
    const cancel = new AbortController();
    const onEnd = jest.fn();

    const reply = await callAnt(antBackend(), call({ signal: cancel.signal, onEnd }));
    const reader = reply.body.getReader();
    await reader.read();
    cancel.abort();
    const { error } = await readUntilError(reader);
    expect(error.name).toBe('AbortError');
    expect(onEnd).toHaveBeenCalledTimes(1);
    await waitFor(() => node.requests[0].closed, { what: 'the upstream to stop' });
  });
});

describe("the backend's request(): a POST body", () => {
  test('bytes go whole, with their length', async () => {
    const seen = readingNode();
    const bytes = crypto.randomBytes(300 * KIB);

    const reply = await callAnt(
      antBackend(),
      call({ path: '/bytes', method: 'POST', body: new Uint8Array(bytes) })
    );
    expect(reply.status).toBe(201);
    expect(node.requests[0].method).toBe('POST');
    expect(node.requests[0].headers['content-length']).toBe(String(bytes.length));
    expect(node.requests[0].headers['transfer-encoding']).toBeUndefined();
    expect(seen.digest).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  test("a stream goes chunked, pulled as the socket takes it, with undici's half duplex", async () => {
    const seen = readingNode();
    const body = pulledBody({ chunks: 40 });
    const { calls, fetchImpl } = countedFetch();

    const reply = await callAnt(
      antBackend({ fetchImpl }),
      call({ path: '/bzz?name=site.tar', method: 'POST', body: body.stream })
    );
    expect(reply.status).toBe(201);
    expect(calls[0].init.duplex).toBe('half');
    expect(typeof calls[0].init.body.getReader).toBe('function');
    expect(node.requests[0].url).toBe('/bzz?name=site.tar');
    expect(node.requests[0].headers['transfer-encoding']).toBe('chunked');
    expect(seen.bytes).toBe(40 * 64 * KIB);
    expect(seen.digest).toBe(body.hash.digest('hex'));
  });

  test('a whole body needs no duplex', async () => {
    readingNode();
    const { calls, fetchImpl } = countedFetch();
    await callAnt(
      antBackend({ fetchImpl }),
      call({ path: '/chunks', method: 'POST', body: new Uint8Array(4104) })
    );
    expect(calls[0].init.duplex).toBeUndefined();
  });

  test.each([
    ['a GET with bytes', { method: 'GET', body: new Uint8Array(1) }, /GET request cannot carry/],
    ['a HEAD with a stream', { method: 'HEAD', body: new ReadableStream() }, /HEAD request/],
    ['a string body', { method: 'POST', body: 'text' }, /bytes or a stream/],
    ['an object body', { method: 'POST', body: { a: 1 } }, /bytes or a stream/],
  ])('%s is refused before any dial', async (_label, over, message) => {
    const { calls, fetchImpl } = countedFetch();
    await expect(callAnt(antBackend({ fetchImpl }), call(over))).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
    expect(node.requests).toHaveLength(0);
  });

  // Design 0015, The transport: a body is pulled from the core only as the
  // node takes it. A node that stops reading stops the pulls once the
  // sockets' buffers are full (the kernel's, and one chunk in undici's
  // writer, which waits for the socket's drain); reading again lets the rest
  // through, byte for byte. The stack's writer holding exactly one chunk is
  // pinned in `gateway-transport.test.js`.
  test('a stopped reader holds back the body: back-pressure from the node to the stream', async () => {
    const seen = readingNode({ pause: true });
    const total = 1024; // chunks of 64 KiB: 64 MiB
    const body = pulledBody({ chunks: total });

    const pending = callAnt(
      antBackend(),
      call({ path: '/bytes', method: 'POST', body: body.stream })
    );
    await waitFor(() => seen.req, { what: 'the upload to start' });
    const stalledAt = await waitUntilStable(() => body.pulls, { stableFor: 8 });
    // Stopped by the node, far short of the body.
    expect(stalledAt).toBeGreaterThan(0);
    expect(stalledAt).toBeLessThan(total / 2);
    expect(seen.bytes).toBe(0);
    await nextTurn(100);
    expect(body.pulls).toBe(stalledAt);

    seen.req.resume();
    const reply = await pending;
    expect(reply.status).toBe(201);
    expect(body.pulls).toBe(total);
    expect(seen.bytes).toBe(total * 64 * KIB);
    expect(seen.digest).toBe(body.hash.digest('hex'));
    expect(body.cancelled).toBeNull();
  });

  // Node's fetch, once aborted, reads a stream body to its end and drops it
  // (undici's `processBodyChunk`): without the backend's own end of the
  // upload, the core's whole body would be pulled for nothing.
  test('a cancel mid-upload cancels the body: nothing more is pulled, nothing drained', async () => {
    const seen = readingNode({ pause: true });
    const body = pulledBody({ chunks: 1024 });
    const cancel = new AbortController();

    const pending = callAnt(
      antBackend(),
      call({ path: '/bytes', method: 'POST', body: body.stream, signal: cancel.signal })
    );
    await waitFor(() => seen.req, { what: 'the upload to start' });
    const stalledAt = await waitUntilStable(() => body.pulls);
    cancel.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => body.cancelled !== null, { what: 'the body to be cancelled' });
    await nextTurn(100);
    expect(body.pulls).toBe(stalledAt);
    // The node, reading again, finds the upload cut off.
    seen.req.resume();
    await waitFor(() => node.requests[0].closed, { what: 'the node to see the abort' });
    expect(seen.digest).toBeUndefined();
  });

  test("a cancel after an early answer ends the upload with the answer's body", async () => {
    let started = null;
    node.handle((req, res) => {
      started = req;
      req.pause();
      // The node answers before it has read the body (an early 413).
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.write('{"message":"too large"');
    });
    const body = pulledBody({ chunks: 1024 });
    const cancel = new AbortController();

    const reply = await callAnt(
      antBackend(),
      call({ path: '/bytes', method: 'POST', body: body.stream, signal: cancel.signal })
    );
    expect(reply.status).toBe(413);
    const reader = reply.body.getReader();
    await reader.read();
    const stalledAt = await waitUntilStable(() => body.pulls);
    expect(stalledAt).toBeLessThan(1024);
    cancel.abort();
    const { error } = await readUntilError(reader);
    expect(error.name).toBe('AbortError');
    await waitFor(() => body.cancelled !== null, { what: 'the body to be cancelled' });
    await nextTurn(100);
    expect(body.pulls).toBe(stalledAt);
    started.resume();
  });
});
