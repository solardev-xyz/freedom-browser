/**
 * Electron-hosted probe for `dweb-range-electron.test.js`.
 *
 * Runs inside a real Electron main process: the real `bzz:` handler
 * (`registerBzzProtocol`) is registered on the default session exactly as
 * `index.js` does it, with the same scheme privileges, and requests reach it
 * through Chromium's network stack via `session.fetch` — so what comes back
 * has crossed `protocol.handle`'s Response → Chromium conversion, the part a
 * Node-only test cannot see. No window is opened (the CI `test` job has no
 * display).
 *
 * A fake Ant on 127.0.0.1 serves a byte-range file, a directory redirect in
 * gateway space, and a body that never ends (to watch cancel and
 * backpressure from the node's side).
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, protocol, session } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// The test creates the throwaway profile and removes it whatever happens to
// this process; a probe run by hand makes its own.
const PROBE_USER_DATA =
  process.env.FREEDOM_PROBE_USER_DATA ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dweb-range-probe-'));
app.setPath('userData', PROBE_USER_DATA);

// The privileges index.js registers `bzz` with (DWEB_PROTOCOL_PRIVILEGES).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bzz',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      allowServiceWorkers: true,
    },
  },
]);

const { registerBzzProtocol } = require('../../swarm/bzz-protocol');
const { updateService } = require('../../service-registry');

const HASH = 'ab'.repeat(32);
const ETAG = '"v1"';
const CONTENT = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

const seen = [];
const streams = [];

function serveEndless(res) {
  const entry = { closed: false, aborted: false, sent: 0 };
  streams.push(entry);
  res.on('error', () => {});
  res.on('close', () => {
    entry.closed = true;
    entry.aborted = !res.writableFinished;
  });
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  const pump = () => {
    while (!entry.closed) {
      entry.sent += CHUNK.length;
      if (!res.write(CHUNK)) {
        res.once('drain', pump);
        return;
      }
    }
  };
  pump();
}

function origin(req, res) {
  seen.push({ method: req.method, url: req.url, range: req.headers.range || null });
  const file = req.url.slice(`/bzz/${HASH}`.length);
  if (file === '/blog') {
    // Ant's directory canonicalisation, written in its own URL space.
    res.writeHead(308, { Location: `/bzz/${HASH}/blog/` });
    res.end('Permanent Redirect');
    return;
  }
  if (file === '/blog/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('blog index');
    return;
  }
  if (file === '/endless') {
    serveEndless(res);
    return;
  }
  const base = { ETag: ETAG, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' };
  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  if (range === 'bytes=5000-') {
    res.writeHead(416, { 'Content-Range': `bytes */${CONTENT.length}` });
    res.end();
    return;
  }
  if (range && (!ifRange || ifRange === ETAG)) {
    const [, from, to] = range.match(/^bytes=(\d+)-(\d+)$/);
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${from}-${to}/${CONTENT.length}`,
      'Content-Length': Number(to) - Number(from) + 1,
    });
    res.end(CONTENT.subarray(Number(from), Number(to) + 1));
    return;
  }
  res.writeHead(200, { ...base, 'Content-Length': CONTENT.length });
  res.end(CONTENT);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 5000) {
  for (let waited = 0; waited < timeoutMs && !predicate(); waited += 20) await sleep(20);
  return predicate();
}

async function summary(response) {
  return {
    status: response.status,
    contentRange: response.headers.get('content-range'),
    contentLength: response.headers.get('content-length'),
    body: Buffer.from(await response.arrayBuffer()).toString('base64'),
  };
}

async function main() {
  const server = http.createServer(origin);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  updateService('ant', { api: `http://127.0.0.1:${server.address().port}` });
  registerBzzProtocol(session.defaultSession);

  const ses = session.defaultSession;
  const url = (file) => `bzz://${HASH}${file}`;
  const results = { content: CONTENT.toString('base64') };

  results.range = await summary(
    await ses.fetch(url('/video.mp4'), { headers: { Range: 'bytes=100-199' } })
  );
  results.unsatisfiable = await summary(
    await ses.fetch(url('/video.mp4'), { headers: { Range: 'bytes=5000-' } })
  );
  results.freshIfRange = await summary(
    await ses.fetch(url('/video.mp4'), { headers: { Range: 'bytes=0-9', 'If-Range': ETAG } })
  );
  results.staleIfRange = await summary(
    await ses.fetch(url('/video.mp4'), { headers: { Range: 'bytes=0-9', 'If-Range': '"v0"' } })
  );
  const head = await ses.fetch(url('/video.mp4'), { method: 'HEAD' });
  results.head = { status: head.status, contentLength: head.headers.get('content-length') };

  const seenBeforeRedirect = seen.length;
  const redirected = await ses.fetch(url('/blog'));
  results.redirect = {
    status: redirected.status,
    body: await redirected.text(),
    nodeSaw: seen.slice(seenBeforeRedirect).map((entry) => entry.url),
  };

  // A consumer that reads one chunk and then stops reading.
  const slow = await ses.fetch(url('/endless'));
  const slowReader = slow.body.getReader();
  await slowReader.read();
  let last = -1;
  for (let i = 0; i < 100 && streams[0].sent !== last; i++) {
    last = streams[0].sent;
    await sleep(50);
  }
  results.pausedSent = streams[0].sent;
  results.pausedClosed = streams[0].closed;

  // The same consumer aborting mid-body.
  const controller = new AbortController();
  const aborted = await ses.fetch(url('/endless'), { signal: controller.signal });
  const abortedReader = aborted.body.getReader();
  await abortedReader.read();
  controller.abort();
  try {
    await abortedReader.read();
    results.abortError = null;
  } catch (err) {
    results.abortError = err && err.name;
  }
  results.abortReachedNode = await until(() => streams[1] && streams[1].closed);
  results.abortedAtNode = Boolean(streams[1] && streams[1].aborted);

  results.seen = seen;
  server.closeAllConnections();
  server.close();
  process.stdout.write(`PROBE-RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    process.stdout.write(`PROBE-FAILED ${err && err.stack}\n`);
    app.exit(1);
  })
);
