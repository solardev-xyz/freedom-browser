/** Offline Node/Electron qualification of real HTTP/TLS through a loopback
 * SOCKS peer. Public test certificate only; no Arti, live service or wallet.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { once } = require('events');
const { createHash } = require('crypto');
const { listen, proxy } = require('../test/helpers/tor-socks-fixture');
const fixture = require('../test/helpers/tor-tls-fixture');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { createWalletTorTransport } = require('../src/main/networks/wallet-tor-transport');
const app = process.versions.electron ? require('electron').app : null;
const sources = [
  'scripts/qualify-wallet-tor-transport.js',
  'src/main/networks/wallet-tor-transport.js',
  'src/main/networks/wallet-tor-transport.test.js',
  'src/main/networks/wallet-tor-transport-lifecycle.test.js',
  'src/main/networks/isolated-socks.js',
  'src/main/networks/isolated-socks.test.js',
  'src/main/networks/privacy-context.js',
  'test/helpers/tor-socks-fixture.js',
  'test/helpers/tor-tls-fixture.js',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((name) => [
      name,
      createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', name)))
        .digest('hex'),
    ])
  );
let phase = 'setup';
const fail = (error) => {
  const line = /qualify-wallet-tor-transport\.js:(\d+):/.exec(error?.stack || '')?.[1];
  console.error(JSON.stringify({ phase, failed: true, line: line ? Number(line) : null }));
  if (app) app.exit(1);
  else process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
// Keep this timer referenced: even a broken cleanup barrier must fail the run.
const watchdog = setTimeout(fail, 60000);
async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  if (app) await app.whenReady();
  const before = hashes(),
    started = performance.now();
  let httpRequests = 0,
    encodingMismatches = 0;
  const server = https.createServer(fixture, (req, res) => {
    httpRequests++;
    req.resume();
    if (req.headers['accept-encoding'] !== 'identity') encodingMismatches++;
    if (req.url === '/close-delimited') {
      res.socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nok');
      return;
    }
    if (req.url === '/encoding') res.setHeader('Content-Encoding', 'gzip');
    if (req.url === '/over-chunked') {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.write(Buffer.alloc(2000, 65));
      setImmediate(() => {
        if (!res.destroyed) res.end(Buffer.alloc(49, 65));
      });
      return;
    }
    if (['/chunked', '/truncated-chunked'].includes(req.url)) {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.write(Buffer.alloc(req.url === '/chunked' ? 2048 : 7, 65));
      if (req.url !== '/truncated-chunked') res.end();
      else res.socket.end();
      return;
    }
    if (req.url === '/framed-close') res.setHeader('Connection', 'close');
    const size = req.url === '/over' ? 2049 : 2048;
    res.writeHead(200, { 'Content-Length': size });
    if (['/truncated-length', '/partial', '/queued'].includes(req.url)) {
      res.write(Buffer.alloc(7, 65));
      if (req.url === '/truncated-length') res.socket.end();
    } else res.end(Buffer.alloc(size, 65));
  });
  server.on('tlsClientError', () => {});
  const port = await listen(server);
  const peers = [],
    transports = [],
    runs = [];
  const lifetime = new AbortController();
  const scope = createPrivacyScope({
    profileId: 'offline-transport-qualification',
    signal: lifetime.signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    protocol: 'railgun',
    deployment: 'sepolia',
    principal: 'railgun:0',
    chainId: 11155111,
    role: 'poi',
    operation: 'fixture',
  });
  const create = (peer, trusted = true) => {
    const transport = createWalletTorTransport({
      getEndpoint: () => peer.endpoint,
      ...(trusted ? { ca: fixture.cert } : {}),
    });
    transports.push(transport);
    return transport;
  };
  const close = async (transport) => {
    transport.close();
    assert.ok(transport.closed instanceof Promise);
    await transport.closed;
    // Remote loopback close can arrive after the local barrier. Observe that
    // eventual peer cleanup separately; delayed local ordering is unit-tested.
    const deadline = performance.now() + 5000;
    while (peers.some((peer) => peer.sockets.size)) {
      assert.ok(performance.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const options = {
    method: 'POST',
    body: '{}',
    maxResponseBytes: 2048,
    requireFramedResponse: true,
  };
  try {
    const peer = await proxy(port);
    peers.push(peer);
    for (const [route, success] of [
      ['exact', true],
      ['over', false],
      ['over-chunked', false],
      ['framed-close', true],
      ['chunked', true],
      ['truncated-length', false],
      ['truncated-chunked', false],
      ['close-delimited', false],
      ['encoding', false],
    ]) {
      phase = route;
      const transport = create(peer),
        count = httpRequests;
      let result, error;
      try {
        result = await transport.request(handle, `https://rpc.example.test/${route}`, options);
      } catch (caught) {
        error = caught;
      }
      if (success) {
        assert.equal(error, undefined);
        assert.equal(result.status, 200);
        assert.equal(result.body.length, 2048);
        assert.ok(result.body.equals(Buffer.alloc(2048, 65)));
      } else {
        assert.equal(result, undefined);
        const expected = {
          over: ['PRIVATE_RESPONSE_TOO_LARGE'],
          'over-chunked': ['PRIVATE_RESPONSE_TOO_LARGE'],
          'close-delimited': ['PRIVATE_FRAMING_REFUSED'],
          encoding: ['PRIVATE_ENCODING_REFUSED'],
          'truncated-length': ['TOR_RESPONSE_FAILED', 'TOR_REQUEST_FAILED'],
          'truncated-chunked': ['TOR_RESPONSE_FAILED', 'TOR_REQUEST_FAILED'],
        };
        assert.ok(error && expected[route].includes(error.code));
      }
      await close(transport);
      assert.equal(httpRequests - count, 1);
      runs.push({
        mode: route,
        completeBodyReturned: success,
        closedResolved: true,
        requests: 1,
      });
    }
    phase = 'default-close-delimited';
    const compatible = create(peer);
    const ordinary = await compatible.request(handle, 'https://rpc.example.test/close-delimited');
    assert.equal(ordinary.body.toString(), 'ok');
    await close(compatible);
    runs.push({ mode: phase, defaultCompatible: true, closedResolved: true });

    phase = 'partial-cancel';
    const cancelled = create(peer),
      controller = new AbortController();
    const arrived = once(server, 'request');
    const pending = cancelled.request(handle, 'https://rpc.example.test/partial', {
      ...options,
      signal: controller.signal,
    });
    const observed = pending.then(
      () => ({ fulfilled: true }),
      (error) => ({ code: error.code })
    );
    await arrived;
    controller.abort();
    assert.equal((await observed).code, 'PRIVACY_REQUEST_ABORTED');
    await close(cancelled);
    runs.push({ mode: phase, refused: true, closedResolved: true });

    for (const mode of ['queued-close', 'queued-release-close']) {
      phase = mode;
      const queued = create(peer),
        beforeRequests = httpRequests;
      const occupied = new Promise((resolve) => {
        const onRequest = (request) => {
          if (request.url === '/queued' && httpRequests - beforeRequests === 2) {
            server.removeListener('request', onRequest);
            resolve();
          }
        };
        server.on('request', onRequest);
      });
      const request = () =>
        queued.request(handle, 'https://rpc.example.test/queued', options).then(
          () => ({ fulfilled: true }),
          (error) => ({ code: error.code })
        );
      // Occupy the real agent sockets before adding the queue: launching all
      // eight during asynchronous SOCKS/TLS setup does not prove six queued.
      const pending = [request(), request()];
      await occupied;
      pending.push(...Array.from({ length: 6 }, request));
      if (mode === 'queued-release-close') queued.release(handle);
      queued.close();
      const results = await Promise.all(pending);
      assert.ok(results.every((result) => result.code === 'PRIVACY_REQUEST_ABORTED'));
      await close(queued);
      assert.equal(httpRequests - beforeRequests, 2);
      runs.push({ mode, requestsRejected: 8, httpRequests: 2, closedResolved: true });
    }

    phase = 'untrusted-tls';
    const untrusted = create(peer, false),
      count = httpRequests;
    await assert.rejects(untrusted.request(handle, 'https://rpc.example.test/exact', options));
    await close(untrusted);
    assert.equal(httpRequests, count);
    runs.push({ mode: phase, noHttpRequest: true, closedResolved: true });

    phase = 'failed-socks';
    const badPeer = await proxy(port, 'auth-failure');
    peers.push(badPeer);
    const failed = create(badPeer);
    await assert.rejects(failed.request(handle, 'https://rpc.example.test/exact', options));
    await close(failed);
    assert.equal(httpRequests, count);
    runs.push({ mode: phase, noHttpRequest: true, closedResolved: true });

    phase = 'invalid-before-network';
    let endpointReads = 0;
    const invalid = createWalletTorTransport({
      getEndpoint: () => {
        endpointReads++;
        return peer.endpoint;
      },
    });
    transports.push(invalid);
    await assert.rejects(
      invalid.request(handle, 'https://rpc.example.test/exact', {
        ...options,
        maxResponseBytes: 0,
      }),
      { code: 'INVALID_PRIVATE_REQUEST' }
    );
    assert.equal(endpointReads, 0);
    await close(invalid);
    runs.push({ mode: phase, endpointReads: 0, closedResolved: true });
    assert.equal(runs.length, 16);
    assert.equal(httpRequests, 15);
    assert.equal(encodingMismatches, 0);
    for (const record of peer.records) {
      assert.equal(record.hostname, 'rpc.example.test');
      assert.equal(record.port, 443);
    }
    assert.deepEqual(hashes(), before);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          fixture: 'offline-loopback-wallet-tor-transport',
          runtime: app ? 'electron-main' : 'node',
          node: process.versions.node,
          electron: process.versions.electron || null,
          elapsedMs: Math.round(performance.now() - started),
          sourceSha256: before,
          runs,
          httpRequests,
          peerSocketClosureObservedAfterBarrier: true,
          allDestinationsLoopbackFixture: true,
          liveQueries: 0,
          walletLoaded: false,
          poiSubmission: false,
          artiCircuitQualification: false,
          physicalDrainOrderingNegativeCases: 'separate-unit-tests',
          retainedBodyLimitBytes: 2048,
          wireByteLimitClaimed: false,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    console.log(JSON.stringify({ runs: runs.length, httpRequests, liveQueries: 0 }));
  } finally {
    for (const transport of transports) transport.close();
    await Promise.all(transports.map((transport) => transport.closed));
    scope.close();
    for (const peer of peers) await peer.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().then(() => {
  clearTimeout(watchdog);
  if (app) app.exit(0);
}, fail);
