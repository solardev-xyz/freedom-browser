const { listen, proxy } = require('../../../test/helpers/tor-socks-fixture');
const http = require('http');
const https = require('https');
const dns = require('dns');
const { once } = require('events');
const { createWalletTorTransport } = require('./wallet-tor-transport');
const { connectIsolatedSocks } = require('./isolated-socks');
const { createPrivacyScope } = require('./privacy-context');
const fixture = require('../../../test/helpers/tor-tls-fixture');

describe('wallet Tor transport', () => {
  let server, socks, transport, scope, lifetime;
  const seen = [];
  function handler(req, res) {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/stall') return;
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://leak.example/' }); res.end(); return; }
    if (req.url === '/large') { res.end(Buffer.alloc(4 * 1024 * 1024 + 1)); return; }
    res.end('ok');
  }
  function context(char = '1') {
    return scope.getContext({ kind: 'public-address', principal: `0x${char.repeat(40)}`, chainId: 1, role: 'rpc' });
  }
  beforeEach(async () => {
    seen.length = 0;
    server = http.createServer(handler);
    const port = await listen(server);
    socks = await proxy(port);
    lifetime = new AbortController();
    scope = createPrivacyScope({ profileId: 'test', signal: lifetime.signal });
    transport = createWalletTorTransport({ getEndpoint: () => socks.endpoint, allowHttp: true });
  });
  afterEach(async () => {
    transport.close();
    scope.close();
    await socks.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    jest.restoreAllMocks();
  });

  test('authenticates with opaque tokens, resolves remotely, and reuses only same-context connections', async () => {
    const lookup = jest.spyOn(dns, 'lookup');
    const a = context();
    const b = context('2');
    const [one, two] = await Promise.all([
      transport.request(a, 'http://rpc.example.test/a'),
      transport.request(b, 'http://rpc.example.test/b'),
    ]);
    expect(one.body.toString()).toBe('ok');
    expect(two.status).toBe(200);
    await transport.request(a, 'http://rpc.example.test/again');
    expect(socks.records).toHaveLength(2);
    expect(new Set(socks.records.map((r) => r.token)).size).toBe(2);
    for (const record of socks.records) {
      expect(record).toMatchObject({ greeting: [5, 1, 2], user: '<torS0X>0', hostname: 'rpc.example.test', addressType: 3, port: 80 });
      expect(record.token).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(seen).toHaveLength(3);
    expect(JSON.stringify(seen)).not.toContain(socks.records[0].token);
  });

  test.each(['downgrade', 'auth-failure', 'bad-reply'])("refuses SOCKS %s before HTTP data", async (behavior) => {
    await socks.close();
    socks = await proxy(server.address().port, behavior);
    await expect(transport.request(context(), 'http://rpc.example.test/')).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED' });
    expect(seen).toHaveLength(0);
  });

  test('cancels a stalled handshake immediately', async () => {
    await socks.close();
    socks = await proxy(server.address().port, 'stall');
    const controller = new AbortController();
    const pending = transport.request(context(), 'http://rpc.example.test/', { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
    await socks.greeting;
    controller.abort();
    await rejected;
    expect(seen).toHaveLength(0);
  });

  test('outage aborts active responses and refuses new requests without direct fallback', async () => {
    await transport.request(context(), 'http://rpc.example.test/');
    const arrived = once(server, 'request');
    const pending = transport.request(context(), 'http://rpc.example.test/stall');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
    await arrived;
    socks.controller.abort();
    await rejected;
    await expect(transport.request(context(), 'http://rpc.example.test/')).rejects.toMatchObject({ code: 'TOR_NOT_READY' });
  });

  test('lock destroys pools; redirects and oversized responses never complete', async () => {
    await expect(transport.request(context(), 'http://rpc.example.test/redirect')).rejects.toMatchObject({ code: 'PRIVATE_REDIRECT_REFUSED' });
    expect(seen.map((r) => r.url)).toEqual(['/redirect']);
    await expect(transport.request(context(), 'http://rpc.example.test/large')).rejects.toMatchObject({ code: 'PRIVATE_RESPONSE_TOO_LARGE' });
    await transport.request(context(), 'http://rpc.example.test/warm');
    const closedSockets = Promise.all([...socks.sockets].map((socket) => once(socket, 'close')));
    lifetime.abort();
    await closedSockets;
    expect(() => scope.getContext({})).toThrow('ended');
  });

  test('deadlines bound a stalled response and transport shutdown is terminal', async () => {
    await expect(transport.request(context(), 'http://rpc.example.test/stall', { timeoutMs: 30 })).rejects.toMatchObject({ code: 'TOR_REQUEST_TIMEOUT' });
    transport.close();
    await expect(transport.request(context(), 'http://rpc.example.test/')).rejects.toMatchObject({ code: 'TOR_TRANSPORT_CLOSED' });
  });

  test('restart uses a fresh SOCKS connection instead of old pooled sockets', async () => {
    const a = context();
    await transport.request(a, 'http://rpc.example.test/');
    await socks.close();
    socks = await proxy(server.address().port);
    await transport.request(a, 'http://rpc.example.test/');
    expect(socks.records).toHaveLength(1);
  });

  test('idle pools expire and unsupported content protection fails before networking', async () => {
    transport.close();
    transport = createWalletTorTransport({ getEndpoint: () => socks.endpoint, allowHttp: true, idleMs: 10 });
    const a = context();
    await transport.request(a, 'http://rpc.example.test/');
    await Promise.all([...socks.sockets].map((socket) => once(socket, 'close')));
    await transport.request(a, 'http://rpc.example.test/');
    expect(socks.records).toHaveLength(2);
    const privateRead = scope.getContext({ kind: 'public-address', principal: `0x${'3'.repeat(40)}`, chainId: 1, role: 'rpc' }, { content: 'pir' });
    await expect(transport.request(privateRead, 'http://rpc.example.test/')).rejects.toMatchObject({ code: 'UNSUPPORTED_PRIVACY_REQUIREMENTS' });
    expect(socks.records).toHaveLength(2);
  });

  test('requires HTTPS by default, forbids credential URLs and cookie injection', async () => {
    const strict = createWalletTorTransport({ getEndpoint: () => socks.endpoint });
    await expect(strict.request(context(), 'http://rpc.example.test/')).rejects.toMatchObject({ code: 'INVALID_PRIVATE_REQUEST' });
    strict.close();
    await expect(transport.request(context(), 'http://user:secret@rpc.example.test/')).rejects.toMatchObject({ code: 'INVALID_PRIVATE_REQUEST' });
    await expect(transport.request(context(), 'http://rpc.example.test/', { headers: { cookie: 'id=1' } })).rejects.toMatchObject({ code: 'INVALID_PRIVATE_REQUEST' });
    expect(socks.records).toHaveLength(0);
  });

  test('invalid request diagnostics never return URL credentials or header contents', async () => {
    const error = await transport.request(context(), 'http://secret@example bad/').catch((e) => e);
    expect(error.code).toBe('INVALID_PRIVATE_REQUEST');
    expect(error.input).toBeUndefined();
    expect(error.message).not.toContain('secret');
    await expect(transport.request(context(), 'http://rpc.example.test/', { headers: { authorization: 'secret\nvalue' } }))
      .rejects.toMatchObject({ code: 'INVALID_PRIVATE_REQUEST', message: 'Invalid private request headers' });
    expect(socks.records).toHaveLength(0);
  });

  test('verifies TLS certificate and hostname through SOCKS before sending HTTP', async () => {
    const secureServer = https.createServer(fixture, handler);
    const port = await listen(secureServer);
    await socks.close();
    socks = await proxy(port);
    const trusted = createWalletTorTransport({ getEndpoint: () => socks.endpoint, ca: fixture.cert });
    const untrusted = createWalletTorTransport({ getEndpoint: () => socks.endpoint });
    try {
      const response = await trusted.request(context(), 'https://rpc.example.test/');
      expect(response.body.toString()).toBe('ok');
      await expect(untrusted.request(context(), 'https://rpc.example.test/untrusted')).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED' });
      await expect(trusted.request(context(), 'https://wrong.example.test/wrong')).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED' });
      expect(seen.map((r) => r.url)).toEqual(['/']);
    } finally {
      trusted.close(); untrusted.close();
      secureServer.closeAllConnections();
      await new Promise((resolve) => secureServer.close(resolve));
    }
  });

  test('low-level connector requires a literal loopback proxy and bounds stalled negotiation', async () => {
    await expect(connectIsolatedSocks({ endpoint: { host: 'proxy.example', port: 1 }, hostname: 'rpc.example', port: 443, token: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'INVALID_SOCKS_REQUEST' });
    await socks.close();
    socks = await proxy(server.address().port, 'stall');
    await expect(connectIsolatedSocks({ endpoint: socks.endpoint, hostname: 'rpc.example', port: 443, token: 'a'.repeat(64), timeoutMs: 20 }))
      .rejects.toMatchObject({ code: 'SOCKS_TIMEOUT' });
  });
});
