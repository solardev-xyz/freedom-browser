/**
 * Electron-hosted probe for `ipfs-gateway-proxy.test.js`.
 *
 * Runs inside a real Electron main process (Chromium's network stack is the
 * thing under test — it cannot be exercised from plain Jest/Node) and drives
 * the *real* modules: `src/main/ipfs/gateway-transport.js` for the transport
 * and `src/main/tor-proxy.js` for the PAC installed on the session.
 *
 * It stands up three local servers:
 *   - an IPFS-gateway-shaped origin (a directory redirect, a gzipped file, a
 *     never-ending stream, and a plain file),
 *   - a SOCKS5 proxy standing in for Arti, which records the hostname:port
 *     Chromium asked it to connect to and then splices the connection to the
 *     origin (so a `.onion` name resolves *at the proxy*, exactly as Tor does),
 *   - an HTTP forward proxy, for the generic "the session has a proxy" case.
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, net: electronNet, session } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { gatewayFetch } = require('../../ipfs/gateway-transport');
const { buildOnionPacScript, applyOnionProxy, clearOnionProxy } = require('../../tor-proxy');
const { prefetchGatewayUrl } = require('../../ens-prefetch');
const { updateService } = require('../../service-registry');

const ONION_GATEWAY_HOST = 'freedomgatewayprobe.onion';
const REMOTE_GATEWAY_HOST = 'gateway.example.test';
const PROBE_PATH = '/ipfs/bafkqaaa';
// Served with Kubo's own immutable-CID caching headers, and with a body that
// changes on every hit so a cached answer is recognisable by its content.
const IMMUTABLE_PATH = '/ipfs/bafkimmutable';
const CONTROL_PATH = '/ipfs/bafkcontrol';
// Same shape, but reached through `ens-prefetch.js`, which builds its own URL
// from the registry — so this one needs a CID its validator accepts.
const PREFETCH_CID = 'bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4';
const PREFETCH_PATH = `/ipfs/${PREFETCH_CID}`;

// A private profile must not leave the profile's own userData behind either,
// so the probe runs against a throwaway one and scans it afterwards.
const PROBE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-gateway-probe-'));
app.setPath('userData', PROBE_USER_DATA);

const socksSeen = [];
const httpProxySeen = [];
const originSeen = [];
let streamSocketClosed = false;
let immutableHits = 0;
let controlHits = 0;
let prefetchHits = 0;

function startOrigin() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      originSeen.push(`${req.headers.host}${req.url}`);
      if (req.url === '/ipfs/bafydir/docs') {
        res.writeHead(301, { Location: '/ipfs/bafydir/docs/', 'X-Ipfs-Path': '/ipfs/bafydir' });
        res.end();
        return;
      }
      if (req.url === '/ipfs/bafygz') {
        const body = zlib.gzipSync(Buffer.from('z'.repeat(4096)));
        res.writeHead(200, {
          'Content-Encoding': 'gzip',
          'Content-Length': String(body.length),
          'Content-Type': 'text/plain',
          'X-Ipfs-Path': '/ipfs/bafygz',
        });
        res.end(body);
        return;
      }
      // Kubo's headers for an immutable CID, verbatim. A body that counts its
      // own hit makes a cached answer self-identifying.
      if (req.url === IMMUTABLE_PATH || req.url === CONTROL_PATH || req.url === PREFETCH_PATH) {
        let hit;
        let marker;
        if (req.url === IMMUTABLE_PATH) {
          hit = immutableHits += 1;
          marker = 'nostoremarker';
        } else if (req.url === CONTROL_PATH) {
          hit = controlHits += 1;
          marker = 'controlmarker';
        } else {
          hit = prefetchHits += 1;
          marker = 'prefetchmarker';
        }
        res.writeHead(200, {
          'Cache-Control': 'public, max-age=29030400, immutable',
          'Content-Type': 'text/plain',
          'X-Ipfs-Path': req.url,
        });
        res.end(`${marker}-hit-${hit}`);
        return;
      }
      if (req.url === '/ipfs/bafystream') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.write('first-chunk');
        const timer = setInterval(() => res.write('more'), 50);
        req.on('close', () => {
          clearInterval(timer);
          streamSocketClosed = true;
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Ipfs-Path': PROBE_PATH });
      res.end('gateway-body');
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Minimal SOCKS5 CONNECT server: records the destination Chromium asked for
// (the whole point — a `.onion` name must travel to the proxy, never to the
// system resolver) and splices the tunnel to the origin.
function startSocks(originPort) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([0x05, 0x00])); // version 5, no auth
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

function startHttpProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      httpProxySeen.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Ipfs-Path': PROBE_PATH });
      res.end('through-http-proxy');
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// The same request the transport makes, minus `cache: 'no-store'` — the
// control that shows Chromium really does cache this response shape, so "the
// transport hit the origin twice" is a fact about the option and not about the
// probe's environment.
function netFetchWithDefaultCache(url) {
  return new Promise((resolve, reject) => {
    const request = electronNet.request({
      method: 'GET',
      url,
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
      bypassCustomProtocolHandlers: true,
    });
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

// Does any file under the profile contain these bytes? Chromium's disk cache
// stores the response body (and the URL) verbatim for an uncompressed entry.
function markersOnDisk(dir, markers) {
  const found = new Set();
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (fs.statSync(full).size > 32 * 1024 * 1024) continue;
        const bytes = fs.readFileSync(full);
        for (const marker of markers) {
          if (bytes.includes(marker)) found.add(marker);
        }
      } catch {
        /* a file Chromium is holding open/rotating is not evidence either way */
      }
    }
  };
  walk(dir);
  return [...found];
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

async function textOf(response) {
  return response.body ? await response.text() : '';
}

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `prefetchGatewayUrl` returns an abort handle, not a promise — it is
// fire-and-forget by design — so its effect is observed at the origin.
async function waitFor(predicate, timeoutMs = 5000) {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (predicate()) return true;
    await settle(50);
  }
  return predicate();
}

async function main() {
  const originPort = await startOrigin();
  const socksPort = await startSocks(originPort);
  const httpProxyPort = await startHttpProxy();
  const ses = session.defaultSession;
  const results = {};

  const onionGateway = `http://${ONION_GATEWAY_HOST}:${originPort}`;
  const remoteGateway = `http://${REMOTE_GATEWAY_HOST}:${originPort}`;
  const loopbackGateway = `http://127.0.0.1:${originPort}`;

  // ---- Tor NOT up yet: the launch window (R2-F1) --------------------------
  // `startIpfs()` probes the configured gateway within ~1s of launch, while
  // `tor-manager` is still waiting for Arti's SOCKS bootstrap (seconds to
  // ~120s), so no PAC is on the session yet and the onion URL resolves DIRECT.
  // The transport must refuse the dial outright: handing the name to Chromium
  // here is handing it to the system resolver.
  socksSeen.length = 0;
  originSeen.length = 0;
  const beforeTor = {
    resolveProxy: await ses.resolveProxy(`${onionGateway}${PROBE_PATH}`),
  };
  try {
    const response = await gatewayFetch(`${onionGateway}${PROBE_PATH}`, { redirect: 'manual' });
    beforeTor.transport = { status: response.status, body: await textOf(response) };
  } catch (err) {
    beforeTor.transport = { error: String(err && err.message) };
  }
  // The control: the same Chromium dial with nothing in front of it — what
  // this path did before. It reaches the system resolver (and, on a runner
  // with an ordinary resolver, fails there), which is the leak itself.
  try {
    beforeTor.unguarded = { body: await netFetchWithDefaultCache(`${onionGateway}${PROBE_PATH}`) };
  } catch (err) {
    beforeTor.unguarded = { error: String(err && err.message) };
  }
  beforeTor.socksSeen = [...socksSeen];
  beforeTor.originSeen = [...originSeen];
  results.onionGatewayBeforeTor = beforeTor;

  // ---- Tor on: the real .onion PAC on the real session --------------------
  await applyOnionProxy(ses, `127.0.0.1:${socksPort}`);
  results.pacScript = buildOnionPacScript(`127.0.0.1:${socksPort}`);
  results.resolveProxy = {
    onionGateway: await ses.resolveProxy(`${onionGateway}${PROBE_PATH}`),
    remoteGateway: await ses.resolveProxy(`${remoteGateway}${PROBE_PATH}`),
    loopbackGateway: await ses.resolveProxy(`${loopbackGateway}${PROBE_PATH}`),
  };

  // A gateway on a .onion host: the request must reach the SOCKS proxy with
  // the onion *name* (remote DNS), which is what makes it work at all.
  socksSeen.length = 0;
  try {
    const response = await gatewayFetch(`${onionGateway}${PROBE_PATH}`, { redirect: 'manual' });
    results.onionGatewayViaTor = {
      status: response.status,
      body: await textOf(response),
      socksSeen: [...socksSeen],
    };
  } catch (err) {
    results.onionGatewayViaTor = { error: String(err && err.message), socksSeen: [...socksSeen] };
  }

  // The transport this replaces: Node's own fetch never sees session.setProxy,
  // so the same URL goes to the system resolver instead of to Tor.
  socksSeen.length = 0;
  try {
    const response = await fetch(`${onionGateway}${PROBE_PATH}`, { redirect: 'manual' });
    results.onionGatewayViaNodeFetch = {
      status: response.status,
      body: await response.text(),
      socksSeen: [...socksSeen],
    };
  } catch (err) {
    results.onionGatewayViaNodeFetch = {
      error: String(err && err.message),
      socksSeen: [...socksSeen],
    };
  }

  // A loopback gateway is unaffected: same PAC, no proxy hop.
  socksSeen.length = 0;
  originSeen.length = 0;
  try {
    const response = await gatewayFetch(`${loopbackGateway}${PROBE_PATH}`, { redirect: 'manual' });
    results.loopbackGatewayUnderTor = {
      status: response.status,
      body: await textOf(response),
      socksSeen: [...socksSeen],
      originSeen: [...originSeen],
    };
  } catch (err) {
    results.loopbackGatewayUnderTor = { error: String(err && err.message) };
  }

  // ---- #351 hardening, over the real Chromium stack, still through Tor ----
  originSeen.length = 0;
  try {
    const response = await gatewayFetch(`${onionGateway}/ipfs/bafydir/docs`, {
      redirect: 'manual',
    });
    results.manualRedirect = {
      status: response.status,
      location: response.headers.get('location'),
      hasBody: !!response.body,
      originRequests: [...originSeen],
    };
  } catch (err) {
    results.manualRedirect = { error: String(err && err.message) };
  }

  try {
    const response = await gatewayFetch(`${onionGateway}/ipfs/bafygz`, { redirect: 'manual' });
    const body = await response.text();
    results.contentEncoding = {
      status: response.status,
      contentEncoding: response.headers.get('content-encoding'),
      contentLength: response.headers.get('content-length'),
      decodedLength: body.length,
      decoded: body.startsWith('zzzz'),
    };
  } catch (err) {
    results.contentEncoding = { error: String(err && err.message) };
  }

  try {
    const controller = new AbortController();
    const response = await gatewayFetch(`${onionGateway}/ipfs/bafystream`, {
      redirect: 'manual',
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    controller.abort();
    let abortName = null;
    try {
      await reader.read();
    } catch (err) {
      abortName = err && err.name;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    results.abort = {
      firstChunk: Buffer.from(first.value).toString('utf8'),
      abortName,
      serverSawSocketClose: streamSocketClosed,
    };
  } catch (err) {
    results.abort = { error: String(err && err.message) };
  }

  // ---- The HTTP cache must not answer, or record, a gateway request -------
  // Kubo marks every `/ipfs/<cid>` immutable for a year, so a cached answer
  // would keep reporting a dead gateway healthy (and would write the visited
  // CID plus the page bytes into the default profile's on-disk cache, private
  // windows included).
  try {
    const first = await gatewayFetch(`${onionGateway}${IMMUTABLE_PATH}`, { redirect: 'manual' });
    const firstBody = await textOf(first);
    const second = await gatewayFetch(`${onionGateway}${IMMUTABLE_PATH}`, { redirect: 'manual' });
    const secondBody = await textOf(second);

    const controlFirst = await netFetchWithDefaultCache(`${onionGateway}${CONTROL_PATH}`);
    const controlSecond = await netFetchWithDefaultCache(`${onionGateway}${CONTROL_PATH}`);

    // Wait for the control entry to reach disk before concluding anything
    // about what is *not* there — a scan that finds neither proves nothing.
    let onDisk = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      onDisk = markersOnDisk(PROBE_USER_DATA, ['controlmarker', 'nostoremarker']);
      if (onDisk.includes('controlmarker')) break;
    }
    // One more settle, so a late no-store write would still be caught.
    await new Promise((resolve) => setTimeout(resolve, 500));
    onDisk = markersOnDisk(PROBE_USER_DATA, ['controlmarker', 'nostoremarker']);

    results.httpCache = {
      transport: { firstBody, secondBody, originHits: immutableHits },
      control: { firstBody: controlFirst, secondBody: controlSecond, originHits: controlHits },
      onDisk,
    };
  } catch (err) {
    results.httpCache = { error: String(err && err.message) };
  }

  // ---- The ENS prefetch dials the same way (R4-F1) ------------------------
  // `ens-prefetch.js` warms the configured gateway for a name the user has
  // resolved but may never visit. It used a bare `net.request`, so it kept
  // both holes this transport closes: it dialled an onion gateway whenever the
  // session happened not to be routing it, and it wrote the warmed bytes into
  // the profile's HTTP cache. It now goes through `gatewayFetch`, driven here
  // exactly as the resolver drives it — through the registry, with no seams.
  try {
    // Every URL Chromium is *asked* to fetch on this session, whether or not
    // it resolves. This is what makes the refusal observable: a dial that dies
    // in the resolver reaches no server, so "nothing was recorded anywhere"
    // looks identical to "nothing was dialled" without it.
    const chromiumSaw = [];
    ses.webRequest.onBeforeRequest((details, callback) => {
      chromiumSaw.push(details.url);
      callback({});
    });

    updateService('ipfs', { gateway: onionGateway, mode: 'external' });
    socksSeen.length = 0;
    originSeen.length = 0;
    chromiumSaw.length = 0;

    // Tor is still on from the block above: the warm-up reaches the gateway,
    // over the proxy, under the onion *name* (so it works, and does not leak —
    // nothing but the SOCKS tunnel can reach an origin by that name)…
    prefetchGatewayUrl(`ipfs://${PREFETCH_CID}`);
    await waitFor(() => prefetchHits >= 1);
    // …and twice in a row means two origin hits: no cache answered the second.
    prefetchGatewayUrl(`ipfs://${PREFETCH_CID}`);
    await waitFor(() => prefetchHits >= 2);
    const viaTor = {
      originHits: prefetchHits,
      originSeen: [...originSeen],
      chromiumSaw: [...chromiumSaw],
      // Chromium pools proxy tunnels, so a warm-up that reuses the tunnel the
      // block above opened records no fresh CONNECT here. Whatever it does
      // record must still be the onion name, never a resolved address.
      socksSeen: [...socksSeen],
    };

    // Tor off, gateway still published (the registry keeps it for up to ~5s
    // after `stopTor`): the dial must not happen at all.
    await clearOnionProxy(ses);
    socksSeen.length = 0;
    originSeen.length = 0;
    chromiumSaw.length = 0;
    const withoutTor = { resolveProxy: await ses.resolveProxy(`${onionGateway}${PREFETCH_PATH}`) };
    prefetchGatewayUrl(`ipfs://${PREFETCH_CID}`);
    await settle(1500);
    withoutTor.originHits = prefetchHits;
    withoutTor.socksSeen = [...socksSeen];
    withoutTor.originSeen = [...originSeen];
    withoutTor.chromiumSaw = [...chromiumSaw];

    // A loopback gateway is still warmed, exactly as before.
    updateService('ipfs', { gateway: loopbackGateway, mode: 'external' });
    originSeen.length = 0;
    prefetchGatewayUrl(`ipfs://${PREFETCH_CID}`);
    await waitFor(() => prefetchHits >= 3);

    // The control (`controlmarker`) from the cache block above proves this
    // scan sees a body Chromium did store, so an absent marker means absent.
    await settle(1000);
    results.prefetch = {
      viaTor,
      withoutTor,
      loopbackOriginHits: prefetchHits,
      onDisk: markersOnDisk(PROBE_USER_DATA, ['controlmarker', 'prefetchmarker']),
    };
  } catch (err) {
    results.prefetch = { error: String(err && err.message) };
  }

  // ---- A plain HTTP proxy on the session (not Tor) ------------------------
  await setPac(
    ses,
    `function FindProxyForURL(u, h) { return "PROXY 127.0.0.1:${httpProxyPort}"; }`
  );
  httpProxySeen.length = 0;
  try {
    const response = await gatewayFetch(`${remoteGateway}${PROBE_PATH}`, { redirect: 'manual' });
    results.remoteGatewayViaHttpProxy = {
      status: response.status,
      body: await textOf(response),
      proxySeen: [...httpProxySeen],
    };
  } catch (err) {
    results.remoteGatewayViaHttpProxy = { error: String(err && err.message) };
  }

  httpProxySeen.length = 0;
  try {
    const response = await gatewayFetch(`${loopbackGateway}${PROBE_PATH}`, { redirect: 'manual' });
    results.loopbackGatewayViaHttpProxy = {
      status: response.status,
      body: await textOf(response),
      proxySeen: [...httpProxySeen],
    };
  } catch (err) {
    results.loopbackGatewayViaHttpProxy = { error: String(err && err.message) };
  }

  await clearOnionProxy(ses);
  try {
    fs.rmSync(PROBE_USER_DATA, { recursive: true, force: true });
  } catch {
    /* a profile Chromium still holds open is cleaned up with the temp dir */
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
