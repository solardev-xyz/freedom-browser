/**
 * Electron-hosted probe for `swarm-post-proxy.test.js` (freedom-core design
 * 0015, The transport: POST on the node's transport, and the Ant guard's
 * announcements bound to one method).
 *
 * Runs inside a real Electron main process and drives the *real* Ant backend
 * (`antBackend()`, `src/main/swarm/bzz-protocol.js`) through main's Swarm
 * call (`callAnt`, `src/main/swarm/ant-api-call.js`) at a remote node, on
 * Chromium's stack (`netGatewayFetch`): a POST on a write session of its
 * own with the default session's proxy (`swarm/ant-write-sessions.js`), a
 * GET on the default session, with the *real* Ant API guard installed on
 * that session's webRequest dispatcher, as index.js does.
 * The fixtures are `colibri-fetch-proxy-electron-probe.js`'s:
 *   - an HTTP origin on 127.0.0.1 standing in for a remote Ant node, at
 *     `ant.example.test`;
 *   - `--host-resolver-rules` mapping `ant.example.test` to 127.0.0.1, for
 *     the legs with no proxy;
 *   - a SOCKS5 proxy, recording the hostname:port Chromium asked it for and
 *     splicing the tunnel to the origin.
 * Then main's own calls (`swarm/ant-storage-api.js`, SWM-8 PR 8.1): its
 * reads, a POST and the swap switch's PUT through the same proxy, and a PUT
 * the node hangs up on, after a write left a connection open: sent once.
 * It also measures what the plan's risks asked for (SWM-5 plan, section 4):
 * whether Chromium keeps main's `accept-encoding: identity`, which bytes a
 * header value in U+0080–U+00FF goes out as on each stack (#1328), and what a
 * `content-length` beside a streamed (chunked) body does.
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, net: electronNet, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const NODE_HOST = 'ant.example.test';
const KIB = 1024;
const CHUNK = 64 * KIB;
const BATCH = 'b'.repeat(64);

app.commandLine.appendSwitch('host-resolver-rules', `MAP ${NODE_HOST} 127.0.0.1`);
const PROBE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-swarm-post-probe-'));
app.setPath('userData', PROBE_USER_DATA);

const { antBackend } = require('../../swarm/bzz-protocol');
const { callAnt } = require('../../swarm/ant-api-call');
const antStorageApi = require('../../swarm/ant-storage-api');
const { announceMainProcessAntDial } = require('../../swarm/ant-api-main-dials');
const { installAntApiGuard, noteAntApiUrl } = require('../../swarm/ant-api-guard');
const {
  registerWebRequestHandler,
  attachWebRequestDispatcher,
} = require('../../webrequest-dispatcher');
const { updateService } = require('../../service-registry');

const socksSeen = [];
const originSeen = [];
// The local ports of the proxy's connections to the origin: a request the
// origin sees from one of them came through the proxy.
const tunnelPorts = new Set();
// Requests the origin holds unread (`/hold`), resumed by the probe.
const held = [];
// When set, the origin takes the next PUT whole and closes its connection
// without answering; a later delivery of it would be answered.
let hangUpPut = false;

// The raw bytes of a header value: Node's server reads header bytes as
// latin1, one character a byte.
const rawHeader = (req, name) => {
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) {
      return Buffer.from(req.rawHeaders[i + 1], 'latin1').toString('hex');
    }
  }
  return null;
};

function startOrigin() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const hash = crypto.createHash('sha256');
      req.socket.served = (req.socket.served || 0) + 1;
      const entry = {
        host: req.headers.host,
        viaProxy: tunnelPorts.has(req.socket.remotePort),
        // Whether its connection served a request before.
        reused: req.socket.served > 1,
        method: req.method,
        path: req.url,
        contentType: req.headers['content-type'] || null,
        contentTypeHex: rawHeader(req, 'content-type'),
        contentLength: req.headers['content-length'] || null,
        transferEncoding: req.headers['transfer-encoding'] || null,
        acceptEncoding: req.headers['accept-encoding'] || null,
        accept: req.headers.accept || null,
        batch: req.headers['swarm-postage-batch-id'] || null,
        cookie: req.headers.cookie || null,
        bytes: 0,
        digest: null,
        complete: false,
      };
      originSeen.push(entry);
      req.on('data', (chunk) => {
        entry.bytes += chunk.length;
        hash.update(chunk);
      });
      req.on('error', () => {});
      res.on('error', () => {});
      req.on('end', () => {
        entry.complete = true;
        entry.digest = hash.digest('hex');
        if (req.method === 'PUT' && hangUpPut) {
          hangUpPut = false;
          req.socket.destroy();
          return;
        }
        if (req.url.startsWith('/stamps')) {
          const body = zlib.gzipSync(Buffer.from(JSON.stringify({ stamps: 'a'.repeat(60 * KIB) })));
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': String(body.length),
          });
          res.end(body);
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json', 'Swarm-Tag': '7' });
        res.end(JSON.stringify({ reference: 'ab'.repeat(32), bytes: entry.bytes }));
      });
      if (req.url.startsWith('/hold')) {
        req.pause();
        held.push(req);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Minimal SOCKS5 CONNECT server (as the Colibri probe's).
function startSocks(originPort) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([0x05, 0x00]));
        socket.once('data', (request) => {
          const atyp = request[3];
          let host = '';
          let offset = 0;
          if (atyp === 0x03) {
            const len = request[4];
            host = request.subarray(5, 5 + len).toString('utf8');
            offset = 5 + len;
          } else if (atyp === 0x01) {
            host = Array.from(request.subarray(4, 8)).join('.');
            offset = 8;
          }
          const port = request.readUInt16BE(offset);
          socksSeen.push(`${host}:${port}`);
          const upstream = net.connect(originPort, '127.0.0.1', () => {
            tunnelPorts.add(upstream.localPort);
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
        });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function setPac(targetSession, script) {
  const pacUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(
    script,
    'utf-8'
  ).toString('base64')}`;
  await targetSession.setProxy({ mode: 'pac_script', pacScript: pacUrl });
  await targetSession.forceReloadProxyConfig?.();
  await targetSession.closeAllConnections?.();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 10_000) {
  for (let waited = 0; waited < timeoutMs; waited += 10) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

// Waits until `read()` returns the same value for 300 ms.
async function stable(read, timeoutMs = 10_000) {
  let last = read();
  let since = Date.now();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(25);
    const value = read();
    if (value !== last) {
      last = value;
      since = Date.now();
    } else if (Date.now() - since >= 300) {
      return value;
    }
  }
  return null;
}

// A body the transport pulls: `chunks` fresh 64 KiB chunks, each read
// counted, the bytes hashed.
function pulledBody(chunks) {
  const state = { pulls: 0, cancelled: false };
  const hash = crypto.createHash('sha256');
  state.stream = new ReadableStream(
    {
      pull(controller) {
        if (state.pulls === chunks) {
          state.digest = hash.digest('hex');
          controller.close();
          return;
        }
        state.pulls += 1;
        const chunk = Buffer.alloc(CHUNK, state.pulls % 251);
        hash.update(chunk);
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return state;
}

async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(Buffer.from(value));
  }
}

const headers = (extra = {}) =>
  new Headers({
    accept: 'application/json, text/plain, */*',
    'accept-encoding': 'identity',
    ...extra,
  });

// One call through main's Swarm call: the reply's head and its body's text,
// or the error's name and message.
async function swarmCall(backend, call) {
  try {
    const reply = await callAnt(backend, {
      method: 'GET',
      headers: headers(),
      signal: new AbortController().signal,
      ...call,
    });
    const body = reply.body ? await readAll(reply.body) : Buffer.alloc(0);
    return {
      status: reply.status,
      contentLength: reply.headers.get('content-length'),
      contentEncoding: reply.headers.get('content-encoding'),
      swarmTag: reply.headers.get('swarm-tag'),
      length: body.length,
      json:
        reply.headers.get('content-type') === 'application/json' &&
        !reply.headers.get('content-encoding')
          ? JSON.parse(body.toString('utf8'))
          : null,
    };
  } catch (err) {
    return { error: `${err?.name}: ${err?.message}` };
  }
}

// A bare frameless `net.request` of the node, as a worker's request looks
// to the guard: its outcome, never announced by this probe itself.
function rawNetRequest(url, method, body = null) {
  return new Promise((resolve) => {
    const request = electronNet.request({
      url,
      method,
      credentials: 'omit',
      useSessionCookies: false,
      cache: 'no-store',
      bypassCustomProtocolHandlers: true,
    });
    request.on('response', (response) => {
      response.on('data', () => {});
      response.on('end', () => resolve({ status: response.statusCode }));
      response.on('error', (err) => resolve({ error: err.message }));
    });
    request.on('error', (err) => resolve({ error: err.message }));
    if (body) request.write(body);
    request.end();
  });
}

// What the guard saw, and what it cancelled.
const guardSaw = [];
const cancelled = [];

async function main() {
  const originPort = await startOrigin();
  const socksPort = await startSocks(originPort);
  const ses = session.defaultSession;
  // Before anything loads: Electron's spell checker downloads its Hunspell
  // dictionary through the session (a gvt1.com fetch on Linux and Windows),
  // which would take the proxy the legs below set.
  ses.setSpellCheckerEnabled(false);
  const remote = `http://${NODE_HOST}:${originPort}`;
  const results = { remote };

  // The node is a remote external one, guarded as ant-manager notes it.
  updateService('ant', { api: remote, gateway: remote, mode: 'external' });
  noteAntApiUrl(remote);
  registerWebRequestHandler('onBeforeRequest', 'probe-recorder', (details) => {
    guardSaw.push({
      method: details.method,
      path: details.url.slice(remote.length),
      resourceType: details.resourceType,
      webContentsId: details.webContentsId ?? null,
      frame: Boolean(details.frame),
    });
    return null;
  });
  installAntApiGuard();
  registerWebRequestHandler('onErrorOccurred', 'probe-errors', (details) => {
    cancelled.push({
      method: details.method,
      path: details.url.slice(remote.length),
      error: details.error,
    });
  });
  attachWebRequestDispatcher(ses);
  await ses.cookies.set({ url: remote, name: 'session', value: 'must-not-travel' });

  const reset = () => {
    socksSeen.length = 0;
    originSeen.length = 0;
    guardSaw.length = 0;
    cancelled.length = 0;
  };
  const backend = () => antBackend({ session: ses });

  // ---- Any proxy on the session: main's POSTs go through it ------------
  await setPac(ses, `function FindProxyForURL(u, h) { return "SOCKS5 127.0.0.1:${socksPort}"; }`);
  reset();
  const streamed = pulledBody(16);
  results.viaSessionProxy = {
    resolveProxy: await ses.resolveProxy(`${remote}/bzz`),
    stream: await swarmCall(backend(), {
      path: '/bzz?name=site.tar',
      method: 'POST',
      headers: headers({
        'content-type': 'application/x-tar',
        'swarm-postage-batch-id': BATCH,
        'swarm-collection': 'true',
      }),
      body: streamed.stream,
    }),
    streamDigest: streamed.digest,
    bytes: await swarmCall(backend(), {
      path: '/chunks',
      method: 'POST',
      headers: headers({
        'content-type': 'application/octet-stream',
        'swarm-postage-batch-id': BATCH,
      }),
      body: new Uint8Array(4104).fill(7),
    }),
    socksSeen: [...socksSeen],
    originSeen: [...originSeen],
    guardSaw: [...guardSaw],
    cancelled: [...cancelled],
  };

  // ---- ant-storage-api's calls: the same proxy, writes sent once -------
  reset();
  const storage = {
    health: await antStorageApi.getHealth(),
    settlements: await antStorageApi.getSettlements(),
    quote: await antStorageApi.getStorageQuote({ depth: 20, days: 30 }),
    buy: await antStorageApi.buyStorage({ depth: 20, amountPerChunk: '65676' }),
    swap: await antStorageApi.setSwapEnabled(true),
  };
  storage.originSeen = [...originSeen];
  storage.guardSaw = [...guardSaw];
  storage.cancelled = [...cancelled];
  storage.socksSeen = [...socksSeen];
  // A write the node answers on a connection it keeps, then the swap
  // switch's PUT, which it takes whole and drops without headers.
  reset();
  storage.warm = await antStorageApi.topUpSettlementDeposit();
  hangUpPut = true;
  storage.hungUp = await antStorageApi.setSwapEnabled(false);
  // Anything Chromium still sends for it lands before the next call.
  await sleep(300);
  hangUpPut = false;
  storage.hangUpSeen = originSeen.map(({ method, path: p, reused, viaProxy, bytes, digest }) => ({
    method,
    path: p,
    reused,
    viaProxy,
    bytes,
    digest,
  }));
  results.storage = storage;

  // ---- The guard binds an announcement's method and URL ---------------
  await ses.setProxy({ mode: 'direct' });
  await ses.closeAllConnections?.();
  const releases = [];
  const guarded = {};
  reset();
  guarded.unannounced = await rawNetRequest(`${remote}/bytes`, 'POST', 'x');
  releases.push(announceMainProcessAntDial(`${remote}/bytes`, 'GET'));
  guarded.postWhileGetAnnounced = await rawNetRequest(`${remote}/bytes`, 'POST', 'x');
  releases.push(announceMainProcessAntDial(`${remote}/bytes`, 'POST'));
  guarded.getOfAnnouncedPostUrlOtherPath = await rawNetRequest(`${remote}/stamps`, 'GET');
  guarded.postToOtherPath = await rawNetRequest(`${remote}/chunks`, 'POST', 'x');
  guarded.postToStampsPurchase = await rawNetRequest(`${remote}/stamps/1/17`, 'POST');
  guarded.putOfAnnouncedUrl = await rawNetRequest(`${remote}/bytes`, 'PUT', 'x');
  guarded.announcedPost = await rawNetRequest(`${remote}/bytes`, 'POST', 'x');
  for (const release of releases) release();
  guarded.postAfterRelease = await rawNetRequest(`${remote}/bytes`, 'POST', 'x');
  guarded.originPaths = originSeen.map((entry) => `${entry.method} ${entry.path}`);
  guarded.cancelled = cancelled.map((entry) => `${entry.method} ${entry.path} ${entry.error}`);
  results.guard = guarded;

  // ---- Back-pressure: a node that stops reading stops the pulls --------
  reset();
  const total = 1024; // 64 MiB
  const upload = pulledBody(total);
  const pending = swarmCall(backend(), {
    path: '/hold/bytes',
    method: 'POST',
    headers: headers({
      'content-type': 'application/octet-stream',
      'swarm-postage-batch-id': BATCH,
    }),
    body: upload.stream,
  });
  await until(() => held.length === 1);
  const stalledAt = await stable(() => upload.pulls);
  const originAtStall = originSeen[0]?.bytes ?? null;
  held.shift().resume();
  results.backpressure = {
    total,
    stalledAt,
    originAtStall,
    answer: await pending,
    pulls: upload.pulls,
    digest: upload.digest,
    origin: { bytes: originSeen[0]?.bytes, digest: originSeen[0]?.digest },
  };

  // ---- A cancel mid-upload cancels the body, nothing drained -----------
  reset();
  const cut = pulledBody(total);
  const cancel = new AbortController();
  const cutCall = swarmCall(backend(), {
    path: '/hold/bytes',
    method: 'POST',
    headers: headers({
      'content-type': 'application/octet-stream',
      'swarm-postage-batch-id': BATCH,
    }),
    body: cut.stream,
    signal: cancel.signal,
  });
  await until(() => held.length === 1);
  const cutAt = await stable(() => cut.pulls);
  cancel.abort();
  const cutAnswer = await cutCall;
  await sleep(300);
  held.shift().resume();
  await sleep(200);
  results.cancel = {
    stalledAt: cutAt,
    answer: cutAnswer,
    pullsAfter: cut.pulls,
    sourceCancelled: cut.cancelled,
    originComplete: originSeen[0]?.complete ?? null,
  };

  // ---- An empty stream goes as no body ----------------------------------
  reset();
  results.empty = {
    answer: await swarmCall(backend(), {
      path: '/bytes',
      method: 'POST',
      headers: headers({ 'content-type': 'application/octet-stream' }),
      body: pulledBody(0).stream,
    }),
    origin: originSeen.map(({ contentLength, transferEncoding, bytes }) => ({
      contentLength,
      transferEncoding,
      bytes,
    })),
  };

  // ---- The plan's risks: header bytes and lengths, per stack ------------
  // U+00E9 in a page's content-type: Node's fetch sends it as one byte
  // (0xe9); what does Chromium send?
  const latin1 = 'text/plain; name=caf\u00e9';
  reset();
  const risks = {};
  risks.latin1Net = await swarmCall(backend(), {
    path: '/bytes',
    method: 'POST',
    headers: headers({ 'content-type': latin1 }),
    body: new Uint8Array(10),
  });
  risks.latin1NetSeen = originSeen.map((entry) => entry.contentTypeHex);
  // The same node on its loopback address: Node's fetch.
  reset();
  updateService('ant', { api: `http://127.0.0.1:${originPort}` });
  const loopback = antBackend({ session: ses });
  updateService('ant', { api: remote });
  risks.latin1Undici = await swarmCall(loopback, {
    path: '/bytes',
    method: 'POST',
    headers: headers({ 'content-type': latin1 }),
    body: new Uint8Array(10),
  });
  risks.latin1UndiciSeen = originSeen.map((entry) => entry.contentTypeHex);
  risks.latin1UndiciGuardSaw = guardSaw.length;
  // A node that gzips despite main's `identity`, with the encoded length.
  reset();
  risks.gzipNet = await swarmCall(backend(), { path: '/stamps' });
  risks.gzipUndici = await swarmCall(loopback, { path: '/stamps' });
  risks.gzipAcceptEncodingSeen = originSeen.map((entry) => entry.acceptEncoding);
  // A content-length beside a streamed body.
  reset();
  risks.lengthWithStreamNet = await swarmCall(backend(), {
    path: '/bytes',
    method: 'POST',
    headers: headers({ 'content-length': String(2 * CHUNK) }),
    body: pulledBody(2).stream,
  });
  risks.lengthWithStreamNetSeen = originSeen.map(({ contentLength, transferEncoding, bytes }) => ({
    contentLength,
    transferEncoding,
    bytes,
  }));
  results.risks = risks;
  results.acceptEncodingSeen = results.viaSessionProxy.originSeen.map(
    (entry) => entry.acceptEncoding
  );

  await ses.setProxy({ mode: 'direct' });
  try {
    fs.rmSync(PROBE_USER_DATA, { recursive: true, force: true });
  } catch {
    /* cleaned up with the temp dir */
  }
  process.stdout.write(`PROBE-RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    process.stdout.write(`PROBE-FAILED ${err && err.stack}\n`);
    app.exit(1);
  })
);
