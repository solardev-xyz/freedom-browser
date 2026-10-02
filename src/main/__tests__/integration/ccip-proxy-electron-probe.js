/**
 * Electron-hosted probe for `ens-ccip-proxy.test.js` (#359).
 *
 * Runs inside a real Electron main process and drives the *real*
 * `src/main/ens/ccip-fetch.js` (through `src/main/ipfs/gateway-transport.js`)
 * against the *real* PAC from `src/main/tor-proxy.js` — the sibling of
 * `gateway-proxy-electron-probe.js`, which does the same for the external IPFS
 * gateway path.
 *
 * `ccipReadFetch` only dials HTTPS URLs on DNS names that are not loopback-ish,
 * so the probe needs:
 *   - an HTTPS CCIP-gateway-shaped origin on 127.0.0.1, using the throwaway
 *     test certificate in `test/fixtures/ccip-gateway-tls/` (SANs: `ccip.example.test`,
 *     `ccipgatewayprobe.onion`), accepted for exactly those two names by a
 *     `setCertificateVerifyProc` on the session;
 *   - `--host-resolver-rules` mapping `ccip.example.test` to 127.0.0.1, so the
 *     clearnet leg can be dialled DIRECT without a real DNS name — it maps
 *     nothing else, so an onion name that reaches the resolver still fails;
 *   - a SOCKS5 proxy standing in for Arti, which records the hostname:port
 *     Chromium asked it for and splices the tunnel to the origin.
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, net: electronNet, session } = require('electron');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const CLEARNET_HOST = 'ccip.example.test';
const ONION_HOST = 'ccipgatewayprobe.onion';
const TRUSTED_TEST_HOSTS = new Set([CLEARNET_HOST, ONION_HOST]);

app.commandLine.appendSwitch('host-resolver-rules', `MAP ${CLEARNET_HOST} 127.0.0.1`);
const PROBE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ccip-probe-'));
app.setPath('userData', PROBE_USER_DATA);

const { ccipReadFetch } = require('../../ens/ccip-fetch');
const { applyOnionProxy, clearOnionProxy } = require('../../tor-proxy');
const { isGatewayTransportRequest } = require('../../ipfs/gateway-transport');

const TX = { to: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' };
const ANSWER = '0xcafe';

const socksSeen = [];
const originSeen = [];
const socketsClosed = new Set();
let endlessBytesSent = 0;

function startOrigin() {
  const fixtures = path.join(__dirname, '../../../../test/fixtures/ccip-gateway-tls');
  return new Promise((resolve) => {
    const server = https.createServer(
      {
        key: fs.readFileSync(path.join(fixtures, 'ccip-gateway-test.key')),
        cert: fs.readFileSync(path.join(fixtures, 'ccip-gateway-test.crt')),
      },
      (req, res) => {
        const pathname = req.url.split('?')[0];
        const route = pathname.split('/')[1];
        originSeen.push({
          host: req.headers.host,
          method: req.method,
          path: pathname,
          cookie: req.headers.cookie || null,
          authorization: req.headers.authorization || null,
        });
        req.on('close', () => socketsClosed.add(route));
        const json = (body) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (route === 'ok') {
          json({ data: ANSWER });
          return;
        }
        if (route === 'post') {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => {
            const received = Buffer.concat(chunks).toString('utf8');
            originSeen[originSeen.length - 1].body = received;
            originSeen[originSeen.length - 1].contentType = req.headers['content-type'];
            json({ data: ANSWER });
          });
          return;
        }
        if (route === 'redirect') {
          // Same origin, so the only thing refusing the hop is `redirect: 'error'`
          // (a cross-origin or HTTPS→HTTP hop would be refused all the more).
          res.writeHead(302, { Location: `https://${req.headers.host}/redirect-target/0x` });
          res.end();
          return;
        }
        if (route === 'huge-declared') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': String(5 * 1024 * 1024),
          });
          res.write('{"data":"0x');
          return; // holds the rest back: only the declared length can reject it
        }
        if (route === 'endless') {
          // No content-length, never ends: only the running byte count stops it.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const chunk = Buffer.alloc(64 * 1024, 0x61);
          const timer = setInterval(() => {
            endlessBytesSent += chunk.length;
            res.write(chunk);
          }, 5);
          req.on('close', () => clearInterval(timer));
          return;
        }
        if (route === 'stall') return; // never answers
        res.writeHead(404);
        res.end();
      }
    );
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Minimal SOCKS5 CONNECT server (same as the IPFS gateway probe's): records
// the destination Chromium asked for and splices the tunnel to the origin.
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

// The control for the no-cookie assertion: the same Chromium dial *with* the
// session's cookies, proving the cookie set below really would travel if the
// transport let it.
function netWithSessionCookies(url) {
  return new Promise((resolve, reject) => {
    const request = electronNet.request({
      url,
      credentials: 'include',
      useSessionCookies: true,
      cache: 'no-store',
      bypassCustomProtocolHandlers: true,
    });
    request.on('response', (response) => {
      response.on('data', () => {});
      response.on('end', resolve);
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (predicate()) return true;
    await settle(25);
  }
  return predicate();
}

// Run one `ccipReadFetch` and report what it returned and how long it took.
async function attempt(urls, signal) {
  const started = Date.now();
  try {
    const value = await ccipReadFetch(TX, '0x', urls, signal);
    return { value, ms: Date.now() - started };
  } catch (err) {
    return { error: String(err && err.message), code: err && err.code, ms: Date.now() - started };
  }
}

async function main() {
  const originPort = await startOrigin();
  const socksPort = await startSocks(originPort);
  const ses = session.defaultSession;
  const results = {};

  ses.setCertificateVerifyProc((request, callback) => {
    // Only the fixture's own names; everything else keeps Chromium's verdict.
    callback(TRUSTED_TEST_HOSTS.has(request.hostname) ? 0 : -3);
  });
  // Every URL Chromium is asked to fetch, whether or not it resolves: a dial
  // that dies in the resolver reaches no server, so without this "refused"
  // and "dialled and failed" look the same.
  const chromiumSaw = [];
  // What the app's page-facing webRequest handlers (adblock, x402-detect) are
  // handed for each dial, and whether they can tell it is the transport's own
  // (`isGatewayTransportRequest`, #462 R1-M1/M2) — at both events they act on.
  const listenerSaw = [];
  const recordListener = (event, details) =>
    listenerSaw.push({
      event,
      path: new URL(details.url).pathname,
      webContentsId: details.webContentsId ?? null,
      own: isGatewayTransportRequest(details),
    });
  ses.webRequest.onBeforeRequest((details, callback) => {
    chromiumSaw.push(details.url);
    recordListener('onBeforeRequest', details);
    callback({});
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    recordListener('onHeadersReceived', details);
    callback({});
  });
  const reset = () => {
    socksSeen.length = 0;
    originSeen.length = 0;
    chromiumSaw.length = 0;
    listenerSaw.length = 0;
  };

  const clearnet = `https://${CLEARNET_HOST}:${originPort}`;
  const onion = `https://${ONION_HOST}:${originPort}`;

  // ---- No proxy: a clearnet gateway is dialled DIRECT, as before ----------
  // A cookie on the session for both hosts: the transport must not send it.
  for (const url of [clearnet, onion]) {
    await ses.cookies.set({ url, name: 'session', value: 'must-not-travel' });
  }
  reset();
  await netWithSessionCookies(`${clearnet}/ok/control`);
  results.cookieControl = originSeen.map((entry) => entry.cookie);
  // A bare `net.request` that is not the transport's: no handler may skip it.
  results.listenerControl = [...listenerSaw];

  reset();
  results.clearnetDirect = {
    resolveProxy: await ses.resolveProxy(`${clearnet}/ok/0x`),
    ...(await attempt([`${clearnet}/ok/{data}`])),
    originSeen: [...originSeen],
    socksSeen: [...socksSeen],
    listenerSaw: [...listenerSaw],
  };
  results.clearnetDirect.ownAfterwards = isGatewayTransportRequest({
    url: `${clearnet}/ok/0x`,
  });

  // ---- Tor NOT up yet: an onion gateway is refused, not resolved ----------
  reset();
  results.onionBeforeTor = {
    resolveProxy: await ses.resolveProxy(`${onion}/ok/0x`),
    ...(await attempt([`${onion}/ok/{data}`])),
    chromiumSaw: [...chromiumSaw],
    socksSeen: [...socksSeen],
    originSeen: [...originSeen],
  };

  // ---- Tor on: the real .onion PAC on the real session --------------------
  await applyOnionProxy(ses, `127.0.0.1:${socksPort}`);
  results.resolveProxy = {
    onion: await ses.resolveProxy(`${onion}/ok/0x`),
    clearnet: await ses.resolveProxy(`${clearnet}/ok/0x`),
  };

  reset();
  results.onionViaTor = {
    ...(await attempt([`${onion}/ok/{data}`])),
    socksSeen: [...socksSeen],
    originSeen: [...originSeen],
  };

  // The transport this replaces: Node's own fetch never sees the PAC, so the
  // same URL goes to the system resolver instead of to the proxy.
  reset();
  try {
    const response = await fetch(`${onion}/ok/0x`, { redirect: 'error' });
    results.onionViaNodeFetch = { status: response.status, socksSeen: [...socksSeen] };
  } catch (err) {
    results.onionViaNodeFetch = {
      error: String(err && (err.cause?.code || err.message)),
      socksSeen: [...socksSeen],
    };
  }

  // ---- Every CCIP bound, over the real stack, through the proxy -----------
  reset();
  results.post = { ...(await attempt([`${onion}/post`])), originSeen: [...originSeen] };

  reset();
  results.redirect = {
    ...(await attempt([`${onion}/redirect/{data}`, `${onion}/ok/{data}`])),
    originPaths: originSeen.map((entry) => entry.path),
  };

  reset();
  socketsClosed.clear();
  results.hugeDeclared = { ...(await attempt([`${onion}/huge-declared/{data}`])) };
  results.hugeDeclared.serverSawSocketClose = await waitFor(() =>
    socketsClosed.has('huge-declared')
  );

  reset();
  endlessBytesSent = 0;
  results.endless = { ...(await attempt([`${onion}/endless/{data}`])) };
  results.endless.serverSawSocketClose = await waitFor(() => socketsClosed.has('endless'));
  results.endless.bytesSentByServer = endlessBytesSent;

  reset();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  results.callerAbort = {
    ...(await attempt([`${onion}/stall/{data}`, `${onion}/ok/{data}`], controller.signal)),
  };
  results.callerAbort.serverSawSocketClose = await waitFor(() => socketsClosed.has('stall'));
  results.callerAbort.originPaths = originSeen.map((entry) => entry.path);

  // The 15s wall clock, for real: the socket has to be torn down, not merely
  // abandoned.
  reset();
  socketsClosed.clear();
  results.deadline = { ...(await attempt([`${onion}/stall/{data}`])) };
  results.deadline.serverSawSocketClose = await waitFor(() => socketsClosed.has('stall'));

  // ---- Any proxy on the session, not just Tor's: clearnet follows it too --
  await setPac(ses, `function FindProxyForURL(u, h) { return "SOCKS5 127.0.0.1:${socksPort}"; }`);
  reset();
  results.clearnetViaSessionProxy = {
    ...(await attempt([`${clearnet}/ok/{data}`])),
    socksSeen: [...socksSeen],
  };

  await clearOnionProxy(ses);
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
