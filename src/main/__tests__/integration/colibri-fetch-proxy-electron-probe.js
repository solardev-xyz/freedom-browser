/**
 * Electron-hosted probe for `colibri-fetch-proxy.test.js` (freedom-core
 * design 0014, "Main's fetches" → "The rest": through the session).
 *
 * Runs inside a real Electron main process and drives the *real*
 * `shell.colibri_fetch` executor (`src/main/ens/colibri-fetch.js`, its
 * default hop: `makeHop()` over `netGatewayFetch`) against the *real* PAC
 * from `src/main/tor-proxy.js`, as `ccip-proxy-electron-probe.js` does for
 * CCIP-Read, with the same fixtures:
 *   - an HTTPS origin on 127.0.0.1 standing in for a Colibri prover, with
 *     the throwaway certificate in `test/fixtures/ccip-gateway-tls/` (SANs
 *     `ccip.example.test`, `ccipgatewayprobe.onion`), accepted for exactly
 *     those names by `setCertificateVerifyProc`;
 *   - `--host-resolver-rules` mapping `ccip.example.test` to 127.0.0.1, and
 *     nothing else, so an onion name that reaches the resolver still fails;
 *   - a SOCKS5 proxy standing in for Arti, recording the hostname:port
 *     Chromium asked it for and splicing the tunnel to the origin.
 *
 * The operations are on a chain outside the package's lists, so every type's
 * servers are the prover alone: the probe's origin. Results are printed as
 * one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, net: electronNet, session } = require('electron');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const CLEARNET_HOST = 'ccip.example.test';
const ONION_HOST = 'ccipgatewayprobe.onion';
const TRUSTED_TEST_HOSTS = new Set([CLEARNET_HOST, ONION_HOST]);
const FINALITY = 'eth/v1/beacon/states/head/finality_checkpoints';
const TX = '0x0c13128da2c6f7cb51c325950d65aabd14dd6b556746a9cdf3be566566bf7699';
const ROOT = '0x29a83bd86e77b1cae82c5928dd781ae3a387166d6c574999679ed1aedafe27b2';
const LONE = 7777;

app.commandLine.appendSwitch('host-resolver-rules', `MAP ${CLEARNET_HOST} 127.0.0.1`);
const PROBE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-fetch-probe-'));
app.setPath('userData', PROBE_USER_DATA);

const { colibriFetchHandler } = require('../../ens/colibri-fetch');
const { StreamedReply } = require('../../core/service-client');
const { applyOnionProxy, clearOnionProxy } = require('../../tor-proxy');

const socksSeen = [];
const originSeen = [];
// The local ports of the proxy's connections to the origin: a request the
// origin sees from one of them came through the proxy. Chromium keeps a
// tunnel open across requests, so the proxy sees one CONNECT for several.
const tunnelPorts = new Set();

function startOrigin() {
  const fixtures = path.join(__dirname, '../../../../test/fixtures/ccip-gateway-tls');
  const fits = zlib.gzipSync(Buffer.from(JSON.stringify({ data: 'a'.repeat(60 * 1024) })));
  const bomb = zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024));
  return new Promise((resolve) => {
    const server = https.createServer(
      {
        key: fs.readFileSync(path.join(fixtures, 'ccip-gateway-test.key')),
        cert: fs.readFileSync(path.join(fixtures, 'ccip-gateway-test.crt')),
      },
      (req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const route = req.url.split('/')[1];
          originSeen.push({
            host: req.headers.host,
            viaProxy: tunnelPorts.has(req.socket.remotePort),
            method: req.method,
            path: req.url,
            accept: req.headers.accept || null,
            contentType: req.headers['content-type'] || null,
            cacheControl: req.headers['cache-control'] || null,
            cookie: req.headers.cookie || null,
            authorization: req.headers.authorization || null,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          if (route === 'gzip-fits' || route === 'gzip-bomb') {
            const body = route === 'gzip-fits' ? fits : bomb;
            res.writeHead(200, {
              'Content-Encoding': 'gzip',
              'Content-Length': String(body.length),
            });
            res.end(body);
            return;
          }
          if (route === 'redirect-same' && req.url.includes(ROOT)) {
            // Same server, same variant: the root in upper case.
            res.writeHead(307, {
              Location: req.url.replace(ROOT.slice(2), ROOT.slice(2).toUpperCase()),
            });
            res.end();
            return;
          }
          if (route === 'redirect-away') {
            res.writeHead(302, {
              Location: `https://${ONION_HOST}:${req.socket.localPort}/prover/${FINALITY}`,
            });
            res.end();
            return;
          }
          // Cacheable for a year: a second load must still reach the origin.
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
          });
          res.end(Buffer.from('proof-bytes'));
        });
      }
    );
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Minimal SOCKS5 CONNECT server (as the CCIP probe's): records the
// destination Chromium asked for and splices the tunnel to the origin.
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

// The control for the no-cookie assertion: the same Chromium dial *with*
// the session's cookies, proving the cookie set below would travel if the
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

async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(Buffer.from(value));
  }
}

async function main() {
  const originPort = await startOrigin();
  const socksPort = await startSocks(originPort);
  const ses = session.defaultSession;
  const results = {};

  ses.setCertificateVerifyProc((request, callback) => {
    callback(TRUSTED_TEST_HOSTS.has(request.hostname) ? 0 : -3);
  });
  // Every URL Chromium is asked to fetch, whether or not it resolves.
  const chromiumSaw = [];
  ses.webRequest.onBeforeRequest((details, callback) => {
    chromiumSaw.push(details.url);
    callback({});
  });
  const reset = () => {
    socksSeen.length = 0;
    originSeen.length = 0;
    chromiumSaw.length = 0;
  };

  const clearnet = `https://${CLEARNET_HOST}:${originPort}`;
  const onion = `https://${ONION_HOST}:${originPort}`;

  const operations = new Map();
  let nextId = 1;
  const handler = colibriFetchHandler({
    operations,
    log: { info() {}, warn() {}, error() {} },
  });
  const open = (method, params, prover) => {
    const op = {
      kind: 'request',
      id: nextId++,
      chain: LONE,
      method,
      params: JSON.stringify(params),
      zk: false,
      prover,
      deadlineAt: Date.now() + 30_000,
    };
    operations.set(op.id, op);
    return op;
  };
  const shapes = {
    post: (op) => ({
      request: op.id,
      type: 'prover',
      method: 'post',
      path: '',
      payload: { method: 'eth_blockNumber', params: [], version: 196611 },
      accept: 'ssz',
      exclude_mask: 0,
    }),
    txCache: (op) => ({
      request: op.id,
      type: 'prover',
      method: 'get',
      path: 'tx_cache?max_blocks=256',
      accept: 'ssz',
      exclude_mask: 0,
      max_age: 6,
    }),
    finality: (op) => ({
      request: op.id,
      type: 'checkpointz',
      method: 'get',
      path: FINALITY,
      accept: 'json',
      exclude_mask: 0,
    }),
    bootstrap: (op) => ({
      request: op.id,
      type: 'beacon_api',
      method: 'get',
      path: `eth/v1/beacon/light_client/bootstrap/${ROOT}`,
      accept: 'ssz',
      exclude_mask: 0,
    }),
  };
  // One fetch: the head and the body's length, or the error answered.
  const fetchOnce = async (shape, method, params, prover) => {
    const op = open(method, params, prover);
    const result = await handler(shapes[shape](op), {
      signal: new AbortController().signal,
      generation: 1,
    });
    if (!(result instanceof StreamedReply)) return result;
    const body = await readAll(result.body);
    return { head: result.result, length: body.length };
  };
  const blockNumber = (prover) => fetchOnce('post', 'eth_blockNumber', [], `${prover}/prover`);
  const txCache = (prover) =>
    fetchOnce('txCache', 'eth_getTransactionByHash', [TX], `${prover}/prover`);

  // ---- No proxy: a clearnet prover is dialled DIRECT ---------------------
  for (const url of [clearnet, onion]) {
    await ses.cookies.set({ url, name: 'session', value: 'must-not-travel' });
  }
  reset();
  await netWithSessionCookies(`${clearnet}/control`);
  results.cookieControl = originSeen.map((entry) => entry.cookie);

  reset();
  results.clearnetDirect = {
    resolveProxy: await ses.resolveProxy(`${clearnet}/prover`),
    post: await blockNumber(clearnet),
    get: await txCache(clearnet),
    originSeen: [...originSeen],
    socksSeen: [...socksSeen],
  };

  // ---- Chromium decodes, and main counts the decoded bytes ---------------
  reset();
  results.gzip = {
    fits: await fetchOnce('finality', 'eth_blockNumber', [], `${clearnet}/gzip-fits`),
    bomb: await fetchOnce('finality', 'eth_blockNumber', [], `${clearnet}/gzip-bomb`),
  };

  // ---- Redirects: main follows the same variant, Chromium never does -----
  reset();
  results.redirectSame = {
    answer: await fetchOnce('bootstrap', 'eth_blockNumber', [], `${clearnet}/redirect-same`),
    originPaths: originSeen.map((entry) => entry.path),
  };
  reset();
  results.redirectAway = {
    answer: await fetchOnce('finality', 'eth_blockNumber', [], `${clearnet}/redirect-away`),
    originPaths: originSeen.map((entry) => entry.path),
    chromiumSaw: [...chromiumSaw],
  };

  // ---- No cache: a cacheable answer is fetched again ---------------------
  reset();
  await txCache(clearnet);
  await txCache(clearnet);
  results.noCache = { originPaths: originSeen.map((entry) => entry.path) };

  // ---- Tor NOT up yet: an onion prover is refused, never resolved --------
  reset();
  results.onionBeforeTor = {
    resolveProxy: await ses.resolveProxy(`${onion}/prover`),
    answer: await blockNumber(onion),
    chromiumSaw: [...chromiumSaw],
    socksSeen: [...socksSeen],
    originSeen: [...originSeen],
  };

  // ---- Tor on: the real .onion PAC on the real session -------------------
  await applyOnionProxy(ses, `127.0.0.1:${socksPort}`);
  results.resolveProxy = {
    onion: await ses.resolveProxy(`${onion}/prover`),
    clearnet: await ses.resolveProxy(`${clearnet}/prover`),
  };
  reset();
  results.onionViaTor = {
    post: await blockNumber(onion),
    get: await txCache(onion),
    socksSeen: [...socksSeen],
    originSeen: [...originSeen],
  };
  reset();
  results.clearnetWithTor = {
    post: await blockNumber(clearnet),
    socksSeen: [...socksSeen],
    originSeen: [...originSeen],
  };

  // ---- Any proxy on the session: every Colibri fetch goes through it -----
  await setPac(ses, `function FindProxyForURL(u, h) { return "SOCKS5 127.0.0.1:${socksPort}"; }`);
  reset();
  results.viaSessionProxy = {
    post: await blockNumber(clearnet),
    get: await txCache(clearnet),
    finality: await fetchOnce('finality', 'eth_blockNumber', [], `${clearnet}/prover`),
    socksSeen: [...socksSeen],
    originSeen: [...originSeen],
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
