/**
 * Electron-hosted probe for `swarm-shell-proxy.test.js` (freedom-core
 * design 0015, SWM-5's gates: "with a remote node and a session proxy,
 * every call goes through the proxy").
 *
 * Runs inside a real Electron main process and drives main's *real* Swarm
 * executor (`core/swarm-shell.js`), with the switch on
 * (FREEDOM_SWARM_BACKEND=core, which the test sets), against a remote node
 * on the default session's stack: the *real* Ant backend
 * (`antBackend({ session })`, `swarm/bzz-protocol.js`) and the *real* Ant
 * API guard on the session's webRequest dispatcher, as index.js installs
 * it. Every honest scenario of freedom-core's `vectors/swarm-grammar.json`
 * is played through the executor as `swarm-shell.test.js` plays it, the
 * node answering each call with the scenario's reply, and one
 * `swarm.stamps { id }` besides (the `stamp` form, which no scenario
 * calls). Each streamed upload's body (the core's `swarm.body`, here a
 * scripted client's) is a pattern of the head's length, which the node
 * hashes. The fixtures are `swarm-post-proxy-electron-probe.js`'s:
 *   - an HTTP origin on 127.0.0.1 standing in for a remote Ant node at
 *     `ant.example.test`, recording what came through the proxy, and on
 *     which of its connections;
 *   - a SOCKS5 proxy on the session, recording the hostname:port Chromium
 *     asked it for and splicing the tunnel to the origin.
 *
 * Then the resend leg (design 0015, point 6: one dial per admitted call, a
 * POST never sent twice), over HTTP and through the SOCKS proxy: the node
 * keeps a connection open with a first answer, takes the next call on it
 * whole and closes without headers, and answers any later delivery of that
 * call. Each of the forms that carry a body or none (`pss_send` with a
 * message and without, `soc_up`, `chunk_up`, a base64 `bzz_file`,
 * `feed_manifest`) goes through the executor; a chunk read, and a whole
 * body sent as main sent it before (the control), go beside them.
 *
 * Needs freedom-core's Swarm vectors (FREEDOM_CORE_SWARM_VECTORS, as the
 * test passes it). Results are printed as one JSON line prefixed with
 * `PROBE-RESULT `, or `PROBE-SKIPPED <reason>`.
 */

const { app, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const NODE_HOST = 'ant.example.test';
const BATCH = 'a1'.repeat(32);

app.commandLine.appendSwitch('host-resolver-rules', `MAP ${NODE_HOST} 127.0.0.1`);
const PROBE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-swarm-shell-probe-'));
app.setPath('userData', PROBE_USER_DATA);

const { antBackend } = require('../../swarm/bzz-protocol');
const { announceMainProcessAntDial } = require('../../swarm/ant-api-main-dials');
const { netGatewayFetch } = require('../../ipfs/gateway-transport');
const { installAntApiGuard, noteAntApiUrl } = require('../../swarm/ant-api-guard');
const {
  registerWebRequestHandler,
  attachWebRequestDispatcher,
} = require('../../webrequest-dispatcher');
const { updateService } = require('../../service-registry');
const { ShellError, StreamedReply } = require('../../core/core-client');
const { SwarmShell } = require('../../core/swarm-shell');
const { swarmBackendKind } = require('../../swarm/swarm-backend-kind');
const vectors = require('../../../../test/helpers/swarm-vectors');
const { bodyClient, unreadParts } = require('../../../../test/helpers/swarm-upload-fixtures');

// ---- The node, the proxy ---------------------------------------------------

const socksSeen = [];
// What the origin saw: each request, tagged with the call main was making.
const originSeen = [];
const tunnelPorts = new Set();
// The reply the origin gives the next call (not `/node`), as the scenario
// recorded it: `{ status, headers, body }`, or `{ status: null }` for a
// transport failure (the connection dropped). `{ status: null, then }`
// drops the connection once and answers a later delivery with `then`, so a
// call sent again would succeed, silently.
let pending = null;
let connections = 0;
let readyOk = true;
let currentForm = null;

function startOrigin() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const hash = crypto.createHash('sha256');
      const { socket } = req;
      const entry = {
        // Which of the origin's connections, and whether it served a request before.
        conn: socket.conn,
        reused: socket.served > 0,
        viaProxy: tunnelPorts.has(req.socket.remotePort),
        host: req.headers.host,
        method: req.method,
        path: req.url,
        form: req.url === '/node' ? 'ready' : currentForm,
        transferEncoding: req.headers['transfer-encoding'] || null,
        contentLength: req.headers['content-length'] || null,
        cookie: req.headers.cookie || null,
        bytes: 0,
        digest: null,
      };
      socket.served += 1;
      originSeen.push(entry);
      req.on('data', (chunk) => {
        entry.bytes += chunk.length;
        hash.update(chunk);
      });
      req.on('error', () => {});
      res.on('error', () => {});
      req.on('end', () => {
        entry.digest = hash.digest('hex');
        if (req.url === '/node') {
          res.writeHead(readyOk ? 200 : 503, { 'content-type': 'application/json' });
          res.end(readyOk ? '{}' : '');
          return;
        }
        const reply = pending;
        pending = reply?.then ?? null;
        if (!reply || reply.status === null) {
          req.socket.destroy();
          return;
        }
        const body = reply.body ?? Buffer.alloc(0);
        const headers = { 'content-length': String(body.length) };
        for (const [name, value] of reply.headers) headers[name] = value;
        res.writeHead(reply.status, headers);
        res.end(body);
      });
    });
    server.keepAliveTimeout = 60_000;
    server.on('connection', (socket) => {
      connections += 1;
      socket.conn = connections;
      socket.served = 0;
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Minimal SOCKS5 CONNECT server (as the Colibri and Swarm POST probes').
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
  await closeConnections(targetSession);
}

// ---- The executor's side -----------------------------------------------------

let nextAsk = 1;

/** The context the core's client calls a handler with (swarm-shell-uploads.test.js's). */
function context() {
  const controller = new AbortController();
  const released = [];
  const answered = [];
  const ctx = {
    id: nextAsk++,
    signal: controller.signal,
    generation: 1,
    streams: true,
    charge: () => true,
    shrink: () => {},
    onRelease: (fn) => released.push(fn),
    onAnswer: (fn) => answered.push(fn),
    abortStream: () => {},
    release: () => {
      for (const fn of answered.splice(0)) fn();
      for (const fn of released.splice(0)) fn();
    },
  };
  return ctx;
}

/** A refusal's rule, or the result (a streamed reply read to its end). */
async function outcome(pending) {
  try {
    const result = await pending;
    if (result instanceof StreamedReply) {
      const reader = result.body.getReader();
      try {
        for (;;) if ((await reader.read()).done) break;
      } catch {
        // A stream ended `too_large` or by its node: still a reply.
      }
    }
    return { result };
  } catch (err) {
    if (err instanceof ShellError && err.code === 'invalid_argument')
      return { rule: err.data.rule };
    return { thrown: `${err?.name}: ${err?.message}` };
  }
}

/** `n` bytes of a pattern, as a byte stream of 64 KiB views, and its digest. */
function patterned(n) {
  const block = Buffer.alloc(64 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff;
  const hash = crypto.createHash('sha256');
  for (let left = n; left > 0; left -= block.length) {
    hash.update(block.subarray(0, Math.min(left, block.length)));
  }
  let left = n;
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (!left) {
          controller.close();
          return;
        }
        const k = Math.min(left, block.length);
        controller.enqueue(new Uint8Array(block.subarray(0, k)));
        left -= k;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, digest: hash.digest('hex') };
}

/**
 * Plays one scenario through the executor on `backend`: the first refusal
 * `{ at, rule }` or null, the calls it dialled, and the uploads it
 * streamed with their expected digests.
 */
async function play(s, backend, files) {
  const params = vectors.scenarioParams(s);
  const references = vectors.uploadReferences(s, files.grammar, files.swarm);
  const uploads = [];
  let length = 0;
  const client = bodyClient({
    answer: () => {
      const body = patterned(length);
      uploads.push({ bytes: length, digest: body.digest });
      return { result: { bytes: length }, body: body.stream };
    },
  });
  const shell = new SwarmShell({
    client,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    nodeUrl: () => backend.url,
    publishReadiness: async () =>
      s.ready?.ok ? { ok: true } : { ok: false, reason: 'node-not-ready', message: 'x' },
  });
  const id = 1;
  shell.open(
    { generation: 1, id },
    { row: s.row, params, key: s.key ?? null, backend, parts: unreadParts(s.row, params) }
  );
  readyOk = s.ready?.ok ?? true;
  // Calls the node saw other than once: a call is one dial (point 6).
  const verdict = { at: null, rule: null, failures: 0, uploads, dials: [] };
  if (s.ready) {
    currentForm = 'ready';
    const ready = await outcome(shell.ready({ for: id, check: s.ready.check }, context()));
    if (ready.rule) return { ...verdict, at: -1, rule: ready.rule };
  }
  for (const [at, c] of s.calls.entries()) {
    const call = vectors.coreCall(c, params);
    pending = vectors.replyOf(c, files.dwebVerify.swarm.chunks, references);
    currentForm = c.form;
    length = call.body?.stream ?? 0;
    const ctx = context();
    const seen = originSeen.length;
    const out = await outcome(shell.api({ for: id, ...call }, ctx));
    ctx.release();
    if (out.rule) return { ...verdict, at, rule: out.rule };
    const dials = originSeen.slice(seen).filter((e) => e.path !== '/node').length;
    if (dials !== 1) verdict.dials.push({ at, form: c.form, method: c.method, dials });
    if (out.thrown || out.result?.failed) verdict.failures += 1;
  }
  return verdict;
}

// ---- The resend leg ----------------------------------------------------------

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

// The network service's exits, as Electron reports them.
const networkGone = [];
app.on('child-process-gone', (_event, details) => {
  if (details.serviceName === 'network.mojom.NetworkService') {
    networkGone.push({ reason: details.reason, exitCode: details.exitCode });
  }
});

// `closeAllConnections`, which never settles once the network service has
// gone: false when it didn't within 3 s.
async function closeConnections(ses) {
  return Promise.race([
    ses.closeAllConnections().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
}
// What the node answers a call delivered again: a success, so a second
// send would pass for one.
const CREATED = {
  status: 201,
  headers: [['content-type', 'application/json']],
  body: Buffer.from('{"reference":"' + 'ab'.repeat(32) + '"}'),
};
const STAMPS = {
  status: 200,
  headers: [['content-type', 'application/json']],
  body: Buffer.from('{"stamps":[]}'),
};

// A call of the forms these legs use, `swarm.stamps {}`'s list.
const STAMPS_CALL = {
  form: 'stamps',
  method: 'GET',
  path: '/stamps',
  query: [],
  headers: [],
  max_bytes: 1048576,
  stream: false,
};

/** One call through main's executor, as its own `swarm.stamps {}` parent. */
async function stampsCall(backend) {
  const shell = new SwarmShell({ client: bodyClient(), log: QUIET, nodeUrl: () => backend.url });
  shell.open({ generation: 1, id: 1 }, { row: 'swarm.stamps', params: {}, backend });
  pending = STAMPS;
  currentForm = 'stamps';
  const ctx = context();
  const out = await outcome(shell.api({ for: 1, ...STAMPS_CALL }, ctx));
  ctx.release();
  pending = null;
  return out;
}

/** What the origin saw from `from` on, the ready probe aside. */
function deliveredSince(from) {
  return originSeen
    .slice(from)
    .filter((e) => e.path !== '/node')
    .map(({ conn, reused, method, path: p, transferEncoding, contentLength, bytes, digest }) => ({
      conn,
      reused,
      method,
      path: p,
      transferEncoding,
      contentLength,
      bytes,
      digest,
    }));
}

/** A call's answer as the leg reports it. */
function answerOf(out) {
  if (out.rule) return { rule: out.rule };
  if (out.thrown) return { thrown: out.thrown };
  if (out.result?.failed) return { failed: out.result.failed };
  return { ok: true };
}

/**
 * One case of the resend leg: a first call answered on a fresh connection
 * (`swarm.stamps {}`), then scenario `s` through the executor, its calls
 * answered as recorded, up to call `at`, which the node takes whole on the
 * kept connection and drops without headers; a later delivery of it would
 * be answered. Then one more call on the session (`after`).
 */
async function hangUpCase(ses, s, at, backend, files) {
  const closed = await closeConnections(ses);
  const gone = networkGone.length;
  const warm = await stampsCall(backend);
  const params = vectors.scenarioParams(s);
  const references = vectors.uploadReferences(s, files.grammar, files.swarm);
  const shell = new SwarmShell({
    client: bodyClient(),
    log: QUIET,
    nodeUrl: () => backend.url,
    publishReadiness: async () => ({ ok: true }),
  });
  shell.open(
    { generation: 1, id: 1 },
    { row: s.row, params, key: s.key ?? null, backend, parts: unreadParts(s.row, params) }
  );
  readyOk = true;
  if (s.ready) {
    currentForm = 'ready';
    await outcome(shell.ready({ for: 1, check: s.ready.check }, context()));
  }
  let target = null;
  for (const [k, c] of s.calls.slice(0, at + 1).entries()) {
    const call = vectors.coreCall(c, params);
    const reply = vectors.replyOf(c, files.dwebVerify.swarm.chunks, references);
    currentForm = c.form;
    if (k === at) {
      const body = call.body?.base64 ? Buffer.from(call.body.base64, 'base64') : Buffer.alloc(0);
      target = {
        form: c.form,
        method: c.method,
        bytes: body.length,
        digest: crypto.createHash('sha256').update(body).digest('hex'),
        from: originSeen.length,
      };
      pending = { status: null, then: reply.status === null ? CREATED : reply };
    } else {
      pending = reply;
    }
    const ctx = context();
    const out = await outcome(shell.api({ for: 1, ...call }, ctx));
    ctx.release();
    if (k === at) target.answer = answerOf(out);
  }
  pending = null;
  // Anything Chromium still sends for the call lands before the next one.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const delivered = deliveredSince(target.from);
  const afterFrom = originSeen.length;
  const after = answerOf(await stampsCall(backend));
  return {
    id: s.id,
    closed,
    networkGone: networkGone.slice(gone),
    warm: answerOf(warm),
    form: target.form,
    method: target.method,
    bytes: target.bytes,
    digest: target.digest,
    answer: target.answer,
    delivered,
    after: { answer: after, delivered: deliveredSince(afterFrom).length },
  };
}

/**
 * The control: the same hang-up for a POST whose whole body is written
 * with `write` and `end`, as main sent one to a remote node before
 * (`netGatewayFetch` with bytes), announced to the guard as the backend
 * announces its dials.
 */
async function wholeBodyControl(ses, backend) {
  const closed = await closeConnections(ses);
  const gone = networkGone.length;
  const warm = await stampsCall(backend);
  const url = `${backend.url}/pss/send/chat/abcd`;
  const body = Buffer.from('hi');
  const from = originSeen.length;
  pending = { status: null, then: CREATED };
  currentForm = 'control';
  const release = announceMainProcessAntDial(url, 'POST');
  let answer;
  try {
    const res = await netGatewayFetch(
      url,
      {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body,
        redirect: 'manual',
      },
      { session: ses }
    );
    await res.arrayBuffer();
    answer = { status: res.status };
  } catch (err) {
    answer = { thrown: String(err?.message || err) };
  } finally {
    release();
    pending = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    closed,
    networkGone: networkGone.slice(gone),
    warm: answerOf(warm),
    bytes: body.length,
    answer,
    delivered: deliveredSince(from),
  };
}

// The resend leg's cases: [scenario, call], every form that carries a body
// or none, and a read.
const RESEND_WRITES = [
  ['send-pss-node-hangs-up', 1],
  ['send-pss-sent-empty', 1],
  ['write-soc-no-feed-grant', 1],
  ['publish-chunk-4096', 1],
  ['publish-data-string', 1],
  ['create-feed-name-64', 1],
];
const RESEND_READS = [['read-chunk-found', 0]];

async function resendLeg(ses, backend, files, socksPort) {
  const byId = new Map(files.grammar.honest.map((s) => [s.id, s]));
  const routes = {};
  for (const route of ['http', 'socks']) {
    if (route === 'http') await ses.setProxy({ mode: 'direct' });
    else {
      await setPac(
        ses,
        `function FindProxyForURL(u, h) { return "SOCKS5 127.0.0.1:${socksPort}"; }`
      );
    }
    const leg = { resolveProxy: await ses.resolveProxy(`${backend.url}/bzz`), writes: [] };
    leg.control = await wholeBodyControl(ses, backend);
    for (const [id, at] of RESEND_WRITES) {
      leg.writes.push(await hangUpCase(ses, byId.get(id), at, backend, files));
    }
    leg.reads = [];
    for (const [id, at] of RESEND_READS) {
      leg.reads.push(await hangUpCase(ses, byId.get(id), at, backend, files));
    }
    routes[route] = leg;
  }
  await closeConnections(ses);
  return routes;
}

// ---- The guard -------------------------------------------------------------

const guardSaw = [];
const cancelled = [];

async function main() {
  if (!vectors.swarmVectors('swarm-grammar.json')) {
    process.stdout.write(`PROBE-SKIPPED no Swarm vectors at ${vectors.swarmVectorsDir}\n`);
    app.exit(0);
    return;
  }
  const files = {
    grammar: vectors.swarmVectors('swarm-grammar.json'),
    swarm: vectors.swarmVectors('swarm.json'),
    dwebVerify: vectors.swarmVectors('dweb-verify.json'),
  };
  const originPort = await startOrigin();
  const socksPort = await startSocks(originPort);
  const ses = session.defaultSession;
  // Before anything loads: Electron's spell checker would fetch its
  // dictionary through the session's proxy.
  ses.setSpellCheckerEnabled(false);
  const remote = `http://${NODE_HOST}:${originPort}`;
  updateService('ant', { api: remote, gateway: remote, mode: 'external' });
  noteAntApiUrl(remote);
  registerWebRequestHandler('onBeforeRequest', 'probe-recorder', (details) => {
    if (details.url.startsWith(remote)) {
      guardSaw.push({
        method: details.method,
        resourceType: details.resourceType,
        frame: Boolean(details.frame),
      });
    }
    return null;
  });
  installAntApiGuard();
  registerWebRequestHandler('onErrorOccurred', 'probe-errors', (details) => {
    if (details.error === 'net::ERR_BLOCKED_BY_CLIENT') {
      cancelled.push(`${details.method} ${details.url.slice(remote.length)}`);
    }
  });
  attachWebRequestDispatcher(ses);
  await ses.cookies.set({ url: remote, name: 'session', value: 'must-not-travel' });
  await setPac(ses, `function FindProxyForURL(u, h) { return "SOCKS5 127.0.0.1:${socksPort}"; }`);

  const results = {
    remote,
    switch: swarmBackendKind(),
    resolveProxy: await ses.resolveProxy(`${remote}/bzz`),
    played: 0,
    wrong: [],
    failures: 0,
    dials: [],
    uploads: [],
  };
  const backend = antBackend({ session: ses });
  for (const s of files.grammar.honest) {
    const expected = vectors.playScenario(s, files);
    const before = originSeen.length;
    const got = await play(s, backend, files);
    // After a hang-up on a streamed write, Chromium fails the session's next
    // request to the node once, unsent (the resend leg's `after`): each
    // scenario starts on fresh connections.
    if (s.calls.some((c) => c.reply && c.reply.status === null)) {
      await closeConnections(ses);
    }
    results.played += 1;
    results.failures += got.failures;
    for (const d of got.dials) results.dials.push({ id: s.id, ...d });
    const want = expected && { at: expected.at, rule: expected.rule };
    const have = got.rule && { at: got.at, rule: got.rule };
    if (JSON.stringify(want) !== JSON.stringify(have)) results.wrong.push({ id: s.id, want, have });
    // Each streamed upload the node took: chunked, whole, the core's bytes.
    const took = originSeen.slice(before).filter((e) => e.transferEncoding === 'chunked');
    got.uploads.forEach((upload, k) => {
      results.uploads.push({ id: s.id, ...upload, took: took[k] ?? null });
    });
  }

  // `stamp`: swarm.stamps with a batch's ID, the one form no scenario calls.
  {
    const shell = new SwarmShell({
      client: bodyClient(),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      nodeUrl: () => backend.url,
    });
    shell.open({ generation: 1, id: 1 }, { row: 'swarm.stamps', params: { id: BATCH }, backend });
    pending = {
      status: 200,
      headers: [['content-type', 'application/json']],
      body: Buffer.from(JSON.stringify({ batchID: BATCH })),
    };
    currentForm = 'stamp';
    const out = await outcome(
      shell.api(
        {
          for: 1,
          form: 'stamp',
          method: 'GET',
          path: `/stamps/${BATCH}`,
          query: [],
          headers: [],
          max_bytes: 65536,
          stream: false,
        },
        context()
      )
    );
    results.stamp = out.rule ? { rule: out.rule } : { ok: !out.thrown && !out.result?.failed };
  }

  // The grammar's plays and `stamp`, before the resend leg.
  const played = originSeen.length;
  const guardSawPlayed = guardSaw.length;
  results.resend = await resendLeg(ses, backend, files, socksPort);
  results.resendGuardSaw = guardSaw.length - guardSawPlayed;
  results.resendOriginSeen = originSeen.length - played;
  results.networkGone = networkGone;
  originSeen.length = played;

  results.originSeen = originSeen.map(({ viaProxy, host, method, form, cookie }) => ({
    viaProxy,
    host,
    method,
    form,
    cookie,
  }));
  results.socksSeen = [...new Set(socksSeen)];
  results.guardSaw = guardSawPlayed;
  results.guardKinds = [...new Set(guardSaw.map((g) => `${g.resourceType}:${g.frame}`))];
  results.cancelled = cancelled;

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
