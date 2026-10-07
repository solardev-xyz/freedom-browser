// Closed TOR_REQUEST_FAILED stages over real loopback SOCKS/TLS sockets. The
// stage is a local lifecycle fact; no URL, header, body or message crosses.
const net = require('net');
const http = require('http');
const https = require('https');
const { once } = require('events');
const { listen, proxy } = require('../../../test/helpers/tor-socks-fixture');
const certificate = require('../../../test/helpers/tor-tls-fixture');
const { createWalletTorTransport } = require('./wallet-tor-transport');
const { createPrivacyScope } = require('./privacy-context');

let server, socks, transport, scope, handle, requests, cleanup;
function routes(req, res) {
  requests.push(req.url);
  if (req.url === '/drop') {
    req.socket.destroy();
    return;
  }
  if (req.url === '/partial-status') {
    req.socket.write('HTTP/1.1 200 O', () => req.socket.destroy());
    return;
  }
  if (req.url === '/headers-then-drop') {
    res.writeHead(200, { 'content-length': '10' });
    res.write('abc', () => req.socket.destroy());
    return;
  }
  res.end('ok');
}
async function open(handler = routes, secure = false) {
  server = secure ? https.createServer(certificate, handler) : http.createServer(handler);
  socks = await proxy(await listen(server));
  transport = createWalletTorTransport({
    getEndpoint: () => socks.endpoint,
    allowHttp: !secure,
  });
}
const send = (route, origin = 'http://stage.example.test') =>
  transport.request(handle, origin + route, { method: 'POST', body: '{}' });

beforeEach(() => {
  requests = [];
  cleanup = [];
  scope = createPrivacyScope({ profileId: 'stage-test', signal: new AbortController().signal });
  handle = scope.getContext({
    kind: 'public-address',
    principal: '0x' + '1'.repeat(40),
    chainId: 1,
    role: 'rpc',
  });
});
afterEach(async () => {
  transport?.close();
  await transport?.closed;
  scope.close();
  await socks?.close();
  for (const run of cleanup) await run();
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  transport = socks = server = undefined;
  jest.restoreAllMocks();
});

test('a server drop on a fresh connection is socket-new and on a kept-alive one socket-reused', async () => {
  await open();
  await expect(send('/drop')).rejects.toMatchObject({
    code: 'TOR_REQUEST_FAILED',
    stage: 'socket-new',
  });
  expect((await send('/ok')).body.toString()).toBe('ok');
  const connections = socks.records.length;
  const error = await send('/drop').catch((value) => value);
  expect(error).toMatchObject({ code: 'TOR_REQUEST_FAILED', stage: 'socket-reused' });
  expect(socks.records).toHaveLength(connections);
  expect(Object.keys(error).sort()).toEqual(['code', 'stage']);
  expect(error.message).toBe('Private HTTP request failed');
  expect(requests).toEqual(['/drop', '/ok', '/drop']);
});

test('any response byte before headers completes makes the failure a response stage', async () => {
  await open();
  await expect(send('/partial-status')).rejects.toMatchObject({
    code: 'TOR_REQUEST_FAILED',
    stage: 'response',
  });
  const error = await send('/headers-then-drop').catch((value) => value);
  // Body truncation keeps its own code; a close race may report it instead
  // as a request failure, but never as a pre-response stage.
  if (error.code === 'TOR_REQUEST_FAILED') expect(error.stage).toBe('response');
  else expect(error.code).toBe('TOR_RESPONSE_FAILED');
});

test.each([
  ['bad-reply', 'connect'],
  ['auth-failure', 'unclassified'],
  ['downgrade', 'unclassified'],
])('SOCKS %s fails before any HTTP byte as %s', async (behavior, stage) => {
  await open();
  await socks.close();
  socks = await proxy(server.address().port, behavior);
  await expect(send('/ok')).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED', stage });
  expect(requests).toEqual([]);
});

test('a SOCKS peer that closes immediately is a connect stage', async () => {
  await open();
  const refusing = net.createServer((socket) => socket.destroy());
  const port = await listen(refusing);
  cleanup.push(() => new Promise((resolve) => refusing.close(resolve)));
  const controller = new AbortController();
  socks.endpoint = Object.freeze({
    host: '127.0.0.1',
    port,
    generation: 2,
    signal: controller.signal,
  });
  await expect(send('/ok')).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED', stage: 'connect' });
  expect(requests).toEqual([]);
});

test('certificate failure is a tls stage and sends no HTTP request', async () => {
  await open(routes, true);
  await expect(send('/ok', 'https://rpc.example.test')).rejects.toMatchObject({
    code: 'TOR_REQUEST_FAILED',
    stage: 'tls',
  });
  expect(requests).toEqual([]);
});

test('the generic fallback for an unexpected exception is unclassified and discloses nothing', async () => {
  await open();
  jest.spyOn(http, 'request').mockImplementationOnce(() => {
    throw Object.assign(Error('raw http://secret.example/'), { code: 'ERR_RAW' });
  });
  const error = await send('/ok').catch((value) => value);
  expect(error).toMatchObject({ code: 'TOR_REQUEST_FAILED', stage: 'unclassified' });
  expect(JSON.stringify({ ...error, message: error.message })).not.toContain('secret');
  expect(requests).toEqual([]);
});

test('cancellation and deadlines keep their own codes without a stage', async () => {
  await open((req) => requests.push(req.url));
  const controller = new AbortController();
  const arrived = once(server, 'request');
  const pending = transport.request(handle, 'http://stage.example.test/stall', {
    signal: controller.signal,
  });
  await arrived;
  controller.abort();
  const aborted = await pending.catch((value) => value);
  expect(aborted.code).toBe('PRIVACY_REQUEST_ABORTED');
  expect(Object.hasOwn(aborted, 'stage')).toBe(false);
  const timedOut = await transport
    .request(handle, 'http://stage.example.test/stall', { timeoutMs: 50 })
    .catch((value) => value);
  expect(timedOut.code).toBe('TOR_REQUEST_TIMEOUT');
  expect(Object.hasOwn(timedOut, 'stage')).toBe(false);
});
