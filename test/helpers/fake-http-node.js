/**
 * A controllable HTTP origin on 127.0.0.1, for driving the real dweb protocol
 * handlers (`bzz:` against a fake Ant, `ipfs:` against a fake external
 * gateway) over real loopback HTTP instead of a mocked `fetch`.
 *
 * Every request is recorded with its method, URL and headers, plus what the
 * handler did with it afterwards: how many body bytes the fake node managed to
 * send, and whether the client went away before the response finished
 * (`aborted`). That is what the cancel, retry and backpressure tests read.
 *
 * Waits use the `timers` module rather than the globals, so they keep running
 * in real time while a test has Jest's fake timers installed (Jest fakes the
 * globals only).
 */

const http = require('http');
const net = require('net');
const timers = require('timers');

const CHUNK_BYTES = 64 * 1024;

function noop() {}

/**
 * Start a fake node. `handler(req, res, entry)` answers every request that
 * `prelude` did not claim; `prelude(req, res)` returns true when it answered
 * (used for health probes the test does not want in `requests`).
 */
async function startFakeHttpNode({ handler = null, prelude = null } = {}) {
  const requests = [];
  const sockets = new Set();
  let current =
    handler ||
    ((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

  const server = http.createServer((req, res) => {
    res.on('error', noop);
    if (prelude && prelude(req, res)) return;
    const entry = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      req,
      res,
      bytesSent: 0,
      closed: false,
      aborted: false,
    };
    entry.done = new Promise((resolve) => {
      res.once('close', () => {
        entry.closed = true;
        // `close` without `finish`: the client hung up (or the socket was
        // torn down) before the response was complete.
        entry.aborted = !res.writableFinished;
        resolve(entry);
      });
    });
    requests.push(entry);
    current(req, res, entry);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    handle(fn) {
      current = fn;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Write `total` bytes (endlessly with `Infinity`) in 64 KiB writes, never
 * more than one write past the socket's high-water mark: the fake node only
 * sends what the transport below it accepts, so `entry.bytesSent` measures
 * how far the reader on the other side let it get. Stops when the client goes
 * away; `end: false` leaves the response open afterwards.
 */
function streamBody(entry, { total = Infinity, chunkBytes = CHUNK_BYTES, end = true } = {}) {
  const { res } = entry;
  const chunk = Buffer.alloc(chunkBytes, 0x61);
  return new Promise((resolve) => {
    entry.done.then(() => resolve());
    const pump = () => {
      while (!entry.closed && entry.bytesSent < total) {
        const n = Math.min(chunkBytes, total - entry.bytesSent);
        entry.bytesSent += n;
        if (!res.write(n === chunkBytes ? chunk : chunk.subarray(0, n))) {
          res.once('drain', pump);
          return;
        }
      }
      if (!entry.closed && end) res.end();
      resolve();
    };
    pump();
  });
}

/**
 * A byte-range origin over `content`, answering the way Ant and Kubo do
 * (RFC 9110): one range → 206 + `Content-Range`, an unsatisfiable one → 416
 * with an unsatisfied-range `Content-Range` (`bytes` star slash size), a stale
 * `If-Range` → the whole 200, several ranges → 206 `multipart/byteranges`, a
 * matching `If-None-Match` → 304. HEAD gets the headers only (Node's server
 * drops the body).
 */
function rangeResponder({ content, etag, contentType = 'application/octet-stream' }) {
  const size = content.length;
  return function respond(req, res) {
    const base = { ETag: etag, 'Accept-Ranges': 'bytes', 'Content-Type': contentType };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (!range || (ifRange && ifRange !== etag)) {
      res.writeHead(200, { ...base, 'Content-Length': size });
      res.end(content);
      return;
    }
    const parts = range
      .replace(/^bytes=/, '')
      .split(',')
      .map((spec) => {
        const [, from, to] = spec.trim().match(/^(\d*)-(\d*)$/);
        // A suffix longer than the content covers all of it (RFC 9110 14.1.2).
        if (from === '') return [Math.max(0, size - Number(to)), size - 1];
        return [Number(from), to === '' ? size - 1 : Math.min(Number(to), size - 1)];
      });
    if (parts.some(([start, end]) => start >= size || start > end)) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    if (parts.length === 1) {
      const [[start, end]] = parts;
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      res.end(content.subarray(start, end + 1));
      return;
    }
    const body = Buffer.concat([
      ...parts.flatMap(([start, end]) => [
        Buffer.from(
          `--BOUNDARY\r\nContent-Type: ${contentType}\r\n` +
            `Content-Range: bytes ${start}-${end}/${size}\r\n\r\n`
        ),
        content.subarray(start, end + 1),
        Buffer.from('\r\n'),
      ]),
      Buffer.from('--BOUNDARY--\r\n'),
    ]);
    res.writeHead(206, {
      ETag: etag,
      'Content-Type': 'multipart/byteranges; boundary=BOUNDARY',
      'Content-Length': body.length,
    });
    res.end(body);
  };
}

/** One real event-loop turn, whatever Jest has done to the global timers. */
function nextTurn(ms = 0) {
  return new Promise((resolve) =>
    ms ? timers.setTimeout(resolve, ms) : timers.setImmediate(resolve)
  );
}

/** Poll `predicate` in real time until it holds; fail with `what` after ~timeoutMs. */
async function waitFor(predicate, { timeoutMs = 5000, what = 'condition' } = {}) {
  const step = 5;
  for (let waited = 0; waited <= timeoutMs; waited += step) {
    if (predicate()) return;
    await nextTurn(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Wait until `read()` returns the same value `stableFor` polls in a row — the
 * point where a writer blocked by backpressure has stopped making progress.
 */
async function waitUntilStable(read, { intervalMs = 25, stableFor = 4, timeoutMs = 5000 } = {}) {
  let last = read();
  let stable = 0;
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    await nextTurn(intervalMs);
    const value = read();
    stable = value === last ? stable + 1 : 0;
    last = value;
    if (stable >= stableFor) return value;
  }
  throw new Error('value never settled');
}

/** A loopback port nothing listens on (bound, then released), for ECONNREFUSED. */
async function closedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Drain a web ReadableStream (or a reader) and return the bytes as a Buffer. */
async function readAll(streamOrReader) {
  const reader = streamOrReader.getReader ? streamOrReader.getReader() : streamOrReader;
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(Buffer.from(value));
  }
}

/** Read until the stream ends or errors; report the byte count and the error (or null). */
async function readUntilError(reader) {
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes, error: null };
      bytes += value.byteLength;
    }
  } catch (error) {
    return { bytes, error };
  }
}

module.exports = {
  CHUNK_BYTES,
  closedLoopbackPort,
  nextTurn,
  rangeResponder,
  readAll,
  readUntilError,
  startFakeHttpNode,
  streamBody,
  waitFor,
  waitUntilStable,
};
