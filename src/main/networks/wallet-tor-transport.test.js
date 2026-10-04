const { listen, proxy } = require('../../../test/helpers/tor-socks-fixture');
const http = require('http');
const https = require('https');
const dns = require('dns');
const { once, EventEmitter } = require('events');
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
    if (req.url === '/close') res.setHeader('Connection', 'close');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://leak.example/' });
      res.end();
      return;
    }
    if (req.url === '/large') {
      res.end(Buffer.alloc(4 * 1024 * 1024 + 1));
      return;
    }
    res.end('ok');
  }
  function context(char = '1') {
    return scope.getContext({
      kind: 'public-address',
      principal: `0x${char.repeat(40)}`,
      chainId: 1,
      role: 'rpc',
    });
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
      expect(record).toMatchObject({
        greeting: [5, 1, 2],
        user: '<torS0X>0',
        hostname: 'rpc.example.test',
        addressType: 3,
        port: 80,
      });
      expect(record.token).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(seen).toHaveLength(3);
    expect(JSON.stringify(seen)).not.toContain(socks.records[0].token);
  });

  test.each(['downgrade', 'auth-failure', 'bad-reply'])(
    'refuses SOCKS %s before HTTP data',
    async (behavior) => {
      await socks.close();
      socks = await proxy(server.address().port, behavior);
      await expect(transport.request(context(), 'http://rpc.example.test/')).rejects.toMatchObject({
        code: 'TOR_REQUEST_FAILED',
      });
      expect(seen).toHaveLength(0);
    }
  );

  test('cancels a stalled handshake immediately', async () => {
    await socks.close();
    socks = await proxy(server.address().port, 'stall');
    const controller = new AbortController();
    const pending = transport.request(context(), 'http://rpc.example.test/', {
      signal: controller.signal,
    });
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
    await expect(transport.request(context(), 'http://rpc.example.test/')).rejects.toMatchObject({
      code: 'TOR_NOT_READY',
    });
  });

  test.each(['release', 'deadline', 'endpoint'])(
    'drains queued requests after %s during stalled SOCKS negotiation',
    async (reason) => {
      await socks.close();
      socks = await proxy(server.address().port, 'stall');
      const handle = context();
      const results = Promise.allSettled(
        Array.from({ length: 8 }, () =>
          transport.request(handle, 'http://rpc.example.test/stall', { timeoutMs: 100 })
        )
      );
      await socks.greeting;
      if (reason === 'release') transport.release(handle);
      if (reason === 'endpoint') socks.controller.abort();
      const settled = await results;
      expect(settled).toHaveLength(8);
      expect(settled.every((value) => value.status === 'rejected')).toBe(true);
      expect(settled.map((value) => value.reason.code)).toEqual(
        Array(8).fill(reason === 'deadline' ? 'TOR_REQUEST_TIMEOUT' : 'PRIVACY_REQUEST_ABORTED')
      );
      expect(seen).toHaveLength(0);
    },
    2000
  );

  test.each(['release', 'deadline', 'endpoint'])(
    'drains queued requests after %s with occupied HTTP sockets',
    async (reason) => {
      const handle = context();
      let arrived;
      const both = new Promise((resolve) => {
        arrived = resolve;
      });
      let count = 0;
      server.on('request', () => {
        if (++count === 2) arrived();
      });
      const results = Promise.allSettled(
        Array.from({ length: 8 }, () =>
          transport.request(handle, 'http://rpc.example.test/stall', { timeoutMs: 100 })
        )
      );
      await both;
      if (reason === 'release') transport.release(handle);
      if (reason === 'endpoint') socks.controller.abort();
      const settled = await results;
      expect(settled.map((value) => value.reason.code)).toEqual(
        Array(8).fill(reason === 'deadline' ? 'TOR_REQUEST_TIMEOUT' : 'PRIVACY_REQUEST_ABORTED')
      );
    },
    2000
  );

  test('drains siblings when a reused TLS connection fails with requests queued', async () => {
    const secureServer = https.createServer(fixture, handler);
    const port = await listen(secureServer);
    await socks.close();
    socks = await proxy(port);
    const trusted = createWalletTorTransport({
      getEndpoint: () => socks.endpoint,
      ca: fixture.cert,
    });
    const handle = context();
    try {
      await trusted.request(handle, 'https://rpc.example.test/warm');
      const arrived = once(secureServer, 'request');
      const results = Promise.allSettled(
        Array.from({ length: 8 }, () =>
          trusted
            .request(handle, 'https://rpc.example.test/stall', { timeoutMs: 100 })
            .catch((error) => {
              trusted.release(handle);
              throw error;
            })
        )
      );
      await arrived;
      secureServer.closeAllConnections();
      const settled = await results;
      expect(settled.every((value) => value.status === 'rejected')).toBe(true);
    } finally {
      trusted.close();
      secureServer.closeAllConnections();
      await new Promise((resolve) => secureServer.close(resolve));
    }
  }, 2000);

  test('drains queued requests after concurrent connection failures', async () => {
    await socks.close();
    socks = await proxy(server.address().port, 'bad-reply');
    const handle = context();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        transport.request(handle, 'http://rpc.example.test/', { timeoutMs: 100 }).catch((error) => {
          transport.release(handle);
          throw error;
        })
      )
    );
    expect(results.every((value) => value.status === 'rejected')).toBe(true);
    expect(seen).toHaveLength(0);
  }, 2000);

  test('drains queued requests when both occupied sockets and their replacements fail', async () => {
    await socks.close();
    socks = await proxy(server.address().port, 'fail-replacements');
    const handle = context();
    let arrived;
    const both = new Promise((resolve) => {
      arrived = resolve;
    });
    let count = 0;
    server.on('request', () => {
      if (++count === 2) arrived();
    });
    const results = Promise.allSettled(
      Array.from({ length: 8 }, () =>
        transport.request(handle, 'http://rpc.example.test/stall', { timeoutMs: 200 })
      )
    );
    await both;
    server.closeAllConnections();
    const settled = await results;
    expect(settled.every((value) => value.status === 'rejected')).toBe(true);
    expect(socks.records.length).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(2);
  }, 2000);

  test('lock destroys pools; redirects and oversized responses never complete', async () => {
    await expect(
      transport.request(context(), 'http://rpc.example.test/redirect')
    ).rejects.toMatchObject({ code: 'PRIVATE_REDIRECT_REFUSED' });
    expect(seen.map((r) => r.url)).toEqual(['/redirect']);
    await expect(
      transport.request(context(), 'http://rpc.example.test/large')
    ).rejects.toMatchObject({ code: 'PRIVATE_RESPONSE_TOO_LARGE' });
    await transport.request(context(), 'http://rpc.example.test/warm');
    const closedSockets = Promise.all([...socks.sockets].map((socket) => once(socket, 'close')));
    lifetime.abort();
    await closedSockets;
    expect(() => scope.getContext({})).toThrow('ended');
  });

  test('deadlines bound a stalled response and transport shutdown is terminal', async () => {
    await expect(
      transport.request(context(), 'http://rpc.example.test/stall', { timeoutMs: 30 })
    ).rejects.toMatchObject({ code: 'TOR_REQUEST_TIMEOUT' });
    transport.close();
    await expect(transport.request(context(), 'http://rpc.example.test/')).rejects.toMatchObject({
      code: 'TOR_TRANSPORT_CLOSED',
    });
  });

  test('accepts a complete response whose server closes the connection', async () => {
    const result = await transport.request(context(), 'http://rpc.example.test/close');
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('ok');
  });

  test.each(['release', 'deadline'])(
    'settles %s even when a destroyed queued request emits no error',
    async (reason) => {
      const requests = [];
      jest.spyOn(http, 'request').mockImplementation(() => {
        const req = new EventEmitter();
        req.write = jest.fn();
        req.end = jest.fn();
        req.destroy = jest.fn(() => {
          req.destroyed = true;
        });
        requests.push(req);
        return req;
      });
      const handle = context();
      const results = Promise.allSettled(
        Array.from({ length: 8 }, () =>
          transport.request(handle, 'http://rpc.example.test/', { timeoutMs: 30 })
        )
      );
      if (reason === 'release') transport.release(handle);
      const settled = await results;
      expect(settled.map((value) => value.reason.code)).toEqual(
        Array(8).fill(reason === 'deadline' ? 'TOR_REQUEST_TIMEOUT' : 'PRIVACY_REQUEST_ABORTED')
      );
      for (const req of requests) {
        expect(req.destroyed).toBe(true);
        expect(() => req.emit('error', new Error('late socket assignment'))).not.toThrow();
      }
      expect(seen).toHaveLength(0);
    },
    2000
  );

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
    transport = createWalletTorTransport({
      getEndpoint: () => socks.endpoint,
      allowHttp: true,
      idleMs: 10,
    });
    const a = context();
    await transport.request(a, 'http://rpc.example.test/');
    await Promise.all([...socks.sockets].map((socket) => once(socket, 'close')));
    await transport.request(a, 'http://rpc.example.test/');
    expect(socks.records).toHaveLength(2);
    const privateRead = scope.getContext(
      { kind: 'public-address', principal: `0x${'3'.repeat(40)}`, chainId: 1, role: 'rpc' },
      { content: 'pir' }
    );
    await expect(transport.request(privateRead, 'http://rpc.example.test/')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PRIVACY_REQUIREMENTS',
    });
    expect(socks.records).toHaveLength(2);
  });

  test('explicit operation release permits more than 32 sequential isolated groups without waiting for idle expiry', async () => {
    for (let index = 1; index <= 36; index++) {
      const handle = scope.getContext({
        kind: 'private-account',
        principal: 'fixture',
        protocol: 'ppv2-fixture',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'protocol-rpc',
        operation: `attempt-${index}`,
      });
      await transport.request(handle, 'http://rpc.example.test/');
      transport.release(handle);
    }
    expect(socks.records).toHaveLength(36);
    expect(seen).toHaveLength(36);
  });

  test('requires HTTPS by default, forbids credential URLs and cookie injection', async () => {
    const strict = createWalletTorTransport({ getEndpoint: () => socks.endpoint });
    await expect(strict.request(context(), 'http://rpc.example.test/')).rejects.toMatchObject({
      code: 'INVALID_PRIVATE_REQUEST',
    });
    strict.close();
    await expect(
      transport.request(context(), 'http://user:secret@rpc.example.test/')
    ).rejects.toMatchObject({ code: 'INVALID_PRIVATE_REQUEST' });
    await expect(
      transport.request(context(), 'http://rpc.example.test/', { headers: { cookie: 'id=1' } })
    ).rejects.toMatchObject({ code: 'INVALID_PRIVATE_REQUEST' });
    expect(socks.records).toHaveLength(0);
  });

  test('invalid request diagnostics never return URL credentials or header contents', async () => {
    const error = await transport.request(context(), 'http://secret@example bad/').catch((e) => e);
    expect(error.code).toBe('INVALID_PRIVATE_REQUEST');
    expect(error.input).toBeUndefined();
    expect(error.message).not.toContain('secret');
    await expect(
      transport.request(context(), 'http://rpc.example.test/', {
        headers: { authorization: 'secret\nvalue' },
      })
    ).rejects.toMatchObject({
      code: 'INVALID_PRIVATE_REQUEST',
      message: 'Invalid private request headers',
    });
    expect(socks.records).toHaveLength(0);
  });

  test('verifies TLS certificate and hostname through SOCKS before sending HTTP', async () => {
    const secureServer = https.createServer(fixture, handler);
    const port = await listen(secureServer);
    await socks.close();
    socks = await proxy(port);
    const trusted = createWalletTorTransport({
      getEndpoint: () => socks.endpoint,
      ca: fixture.cert,
    });
    const untrusted = createWalletTorTransport({ getEndpoint: () => socks.endpoint });
    try {
      const response = await trusted.request(context(), 'https://rpc.example.test/');
      expect(response.body.toString()).toBe('ok');
      await expect(
        untrusted.request(context(), 'https://rpc.example.test/untrusted')
      ).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED' });
      await expect(
        trusted.request(context(), 'https://wrong.example.test/wrong')
      ).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED' });
      expect(seen.map((r) => r.url)).toEqual(['/']);
    } finally {
      trusted.close();
      untrusted.close();
      secureServer.closeAllConnections();
      await new Promise((resolve) => secureServer.close(resolve));
    }
  });

  test('low-level connector requires a literal loopback proxy and bounds stalled negotiation', async () => {
    await expect(
      connectIsolatedSocks({
        endpoint: { host: 'proxy.example', port: 1 },
        hostname: 'rpc.example',
        port: 443,
        token: 'a'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'INVALID_SOCKS_REQUEST' });
    await socks.close();
    socks = await proxy(server.address().port, 'stall');
    await expect(
      connectIsolatedSocks({
        endpoint: socks.endpoint,
        hostname: 'rpc.example',
        port: 443,
        token: 'a'.repeat(64),
        timeoutMs: 20,
      })
    ).rejects.toMatchObject({ code: 'SOCKS_TIMEOUT' });
  });
});

describe('wallet Tor response bounds and framing over loopback SOCKS', () => {
  let server, socks, transport, scope, reply, handle;
  let requests, work;
  const send = (options = {}, route = '/') => {
    const pending = transport.request(handle, 'http://response.example.test' + route, options);
    work.push(pending);
    return pending;
  };
  beforeEach(async () => {
    requests = [];
    work = [];
    reply = (_req, res) => res.end('ok');
    server = http.createServer((req, res) => {
      requests.push({ route: req.url, method: req.method, headers: req.headers });
      reply(req, res);
    });
    socks = await proxy(await listen(server));
    scope = createPrivacyScope({
      profileId: 'bounded-response-test',
      signal: new AbortController().signal,
    });
    handle = scope.getContext({
      kind: 'public-address',
      principal: '0x' + '1'.repeat(40),
      chainId: 1,
      role: 'rpc',
    });
    transport = createWalletTorTransport({ getEndpoint: () => socks.endpoint, allowHttp: true });
  });
  afterEach(async () => {
    transport.close();
    await Promise.allSettled(work);
    await transport.closed;
    scope.close();
    await socks.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    jest.restoreAllMocks();
  });

  test.each([0, 1, 2047, 2048])(
    'accepts exactly %i response bytes under a 2048-byte POST cap',
    async (length) => {
      const body = Buffer.alloc(length, 0x61);
      reply = (_req, res) => res.end(body);
      const result = await send({
        method: 'POST',
        body: '{}',
        maxResponseBytes: 2048,
        requireFramedResponse: true,
      });
      expect(result.body).toEqual(body);
      expect(result.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: 'POST',
        headers: { 'accept-encoding': 'identity', 'content-length': '2' },
      });
    }
  );
  test('limit counts UTF-8 bytes rather than decoded characters', async () => {
    reply = (_req, res) => res.end('é'.repeat(1024));
    expect((await send({ maxResponseBytes: 2048 })).body.length).toBe(2048);
    reply = (_req, res) => res.end('é'.repeat(1025));
    await expect(send({ maxResponseBytes: 2048 })).rejects.toMatchObject({
      code: 'PRIVATE_RESPONSE_TOO_LARGE',
    });
    expect(requests).toHaveLength(2);
  });
  test.each([undefined, 4 * 1024 * 1024])(
    'default or explicit maximum %s still accepts 4 MiB',
    async (maxResponseBytes) => {
      reply = (_req, res) => res.end(Buffer.alloc(4 * 1024 * 1024));
      expect((await send({ maxResponseBytes })).body.length).toBe(4 * 1024 * 1024);
    }
  );
  test.each([
    0,
    -1,
    1.5,
    4 * 1024 * 1024 + 1,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    null,
    false,
    '2048',
  ])(
    'invalid response limit %s refuses before endpoint or socket creation',
    async (maxResponseBytes) => {
      transport.close();
      await transport.closed;
      const endpoint = jest.fn(() => socks.endpoint);
      transport = createWalletTorTransport({ getEndpoint: endpoint, allowHttp: true });
      const request = jest.spyOn(http, 'request');
      await expect(send({ maxResponseBytes })).rejects.toMatchObject({
        code: 'INVALID_PRIVATE_REQUEST',
      });
      expect(endpoint).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(socks.records).toEqual([]);
    }
  );
  test.each([null, 0, 1, 'true', {}, []])(
    'invalid framed-response option %# refuses before networking',
    async (requireFramedResponse) => {
      await expect(send({ requireFramedResponse })).rejects.toMatchObject({
        code: 'INVALID_PRIVATE_REQUEST',
      });
      expect(socks.records).toEqual([]);
      expect(requests).toEqual([]);
    }
  );
  test('response limits remain per request when a shared pool handles concurrent requests', async () => {
    reply = (req, res) => res.end(Buffer.alloc(req.url === '/small' ? 2049 : 4096));
    const settled = await Promise.allSettled([
      send({ maxResponseBytes: 2048 }, '/small'),
      send({ maxResponseBytes: 4096 }, '/large'),
    ]);
    expect(settled[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'PRIVATE_RESPONSE_TOO_LARGE' },
    });
    expect(settled[1].status).toBe('fulfilled');
    expect(settled[1].value.body.length).toBe(4096);
    reply = (_req, res) => res.end('x');
    expect((await send({ maxResponseBytes: 1 })).body.toString()).toBe('x');
    expect(requests).toHaveLength(3);
  });
  test.each([200, 503])(
    'oversized streaming status %i rejects before end and closes its response',
    async (status) => {
      let closed;
      const peerClosed = new Promise((resolve) => {
        closed = resolve;
      });
      reply = (_req, res) => {
        res.once('close', closed);
        res.writeHead(status, { 'Transfer-Encoding': 'chunked' });
        res.write(Buffer.alloc(1024));
        setImmediate(() => {
          if (!res.destroyed) res.write(Buffer.alloc(1025));
        });
      };
      await expect(
        send({ maxResponseBytes: 2048, timeoutMs: 1000, requireFramedResponse: true })
      ).rejects.toMatchObject({ code: 'PRIVATE_RESPONSE_TOO_LARGE' });
      await peerClosed;
      expect(requests).toHaveLength(1);
      reply = (_req, res) => res.end('ok');
      expect((await send({ maxResponseBytes: 2048 })).body.toString()).toBe('ok');
    }
  );
  test.each(['chunked', 'ChUnKeD'])(
    'explicit %s framing accepts a complete streamed body at the limit',
    async (encoding) => {
      reply = (_req, res) => {
        res.writeHead(200, { 'Transfer-Encoding': encoding });
        res.write(Buffer.alloc(1024, 0x61));
        res.end(Buffer.alloc(1024, 0x62));
      };
      const result = await send({ maxResponseBytes: 2048, requireFramedResponse: true });
      expect(result.body).toEqual(
        Buffer.concat([Buffer.alloc(1024, 0x61), Buffer.alloc(1024, 0x62)])
      );
    }
  );
  test.each([false, undefined])(
    'default-compatible unframed Connection: close body is accepted with %s',
    async (requireFramedResponse) => {
      reply = (_req, res) => res.socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nok');
      expect((await send({ requireFramedResponse, maxResponseBytes: 2048 })).body.toString()).toBe(
        'ok'
      );
    }
  );
  test.each(['', 'Transfer-Encoding: identity\r\n', 'Transfer-Encoding: gzip, chunked\r\n'])(
    'strict framing refuses absent or unsupported transfer framing %#',
    async (framing) => {
      reply = (_req, res) =>
        res.socket.end(
          'HTTP/1.1 200 OK\r\nConnection: close\r\n' + framing + '\r\n2\r\nok\r\n0\r\n\r\n'
        );
      await expect(
        send({ requireFramedResponse: true, maxResponseBytes: 2048 })
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(PRIVATE_|TOR_)/) });
      expect(requests).toHaveLength(1);
    }
  );
  test.each([
    ['declared length', 'Content-Length: 2048\r\n', 'x'.repeat(2047)],
    ['no declared bytes', 'Content-Length: 1\r\n', ''],
    ['missing final chunk', 'Transfer-Encoding: chunked\r\n', '2\r\nok\r\n'],
    ['partial chunk', 'Transfer-Encoding: chunked\r\n', '3\r\nok'],
  ])('incomplete %s refuses without returning a partial body', async (_name, framing, body) => {
    reply = (_req, res) =>
      res.socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\n' + framing + '\r\n' + body);
    const outcome = await send({ requireFramedResponse: true, maxResponseBytes: 2048 }).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toMatchObject({ code: expect.stringMatching(/^TOR_/) });
    expect(outcome.error.body).toBeUndefined();
    expect(requests).toHaveLength(1);
  });
  test('a valid declared body above the request limit is still bounded', async () => {
    reply = (_req, res) => res.end(Buffer.alloc(2049));
    await expect(
      send({ maxResponseBytes: 2048, requireFramedResponse: true })
    ).rejects.toMatchObject({ code: 'PRIVATE_RESPONSE_TOO_LARGE' });
  });
  test('explicit framing does not allow compression or redirects and never retries', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip' });
      res.end('PRIVATE compressed');
    };
    await expect(
      send({
        headers: { 'accept-encoding': 'gzip' },
        maxResponseBytes: 2048,
        requireFramedResponse: true,
      })
    ).rejects.toMatchObject({ code: 'PRIVATE_ENCODING_REFUSED' });
    expect(requests[0].headers['accept-encoding']).toBe('identity');
    reply = (_req, res) => {
      res.writeHead(302, { location: 'https://PRIVATE.example/path' });
      res.end('redirect');
    };
    await expect(
      send({ maxResponseBytes: 2048, requireFramedResponse: true })
    ).rejects.toMatchObject({ code: 'PRIVATE_REDIRECT_REFUSED' });
    expect(requests).toHaveLength(2);
  });
  test.each(['abort', 'timeout'])(
    'partial framed response %s fails, then transport.closed observes local drain',
    async (reason) => {
      const caller = new AbortController();
      let written;
      const partial = new Promise((resolve) => {
        written = resolve;
      });
      reply = (_req, res) => {
        res.writeHead(200, { 'Content-Length': '2048' });
        res.write('partial');
        written();
      };
      const pending = send({
        signal: caller.signal,
        timeoutMs: reason === 'timeout' ? 50 : 1000,
        maxResponseBytes: 2048,
        requireFramedResponse: true,
      });
      const result = pending.catch((error) => error);
      await partial;
      if (reason === 'abort') caller.abort();
      expect(await result).toMatchObject({
        code: reason === 'abort' ? 'PRIVACY_REQUEST_ABORTED' : 'TOR_REQUEST_TIMEOUT',
      });
      transport.close();
      await expect(transport.closed).resolves.toBeUndefined();
      expect(requests).toHaveLength(1);
    }
  );
  test.each(['close', 'release-then-close'])(
    'closed drains all eight real Agent requests after %s with six queued',
    async (action) => {
      const created = [],
        original = http.request;
      jest.spyOn(http, 'request').mockImplementation((...args) => {
        const request = original(...args);
        created.push(request);
        return request;
      });
      let entered;
      const occupied = new Promise((resolve) => {
        entered = resolve;
      });
      reply = () => {
        if (requests.length === 2) entered();
      };
      const first = Array.from({ length: 2 }, () => send({ timeoutMs: 2000 }));
      await occupied;
      const remaining = Array.from({ length: 6 }, () => send({ timeoutMs: 2000 }));
      const results = Promise.allSettled([...first, ...remaining]);
      expect(requests).toHaveLength(2);
      expect(created).toHaveLength(8);
      const agent = created[0].agent;
      expect(created.every((request) => request.agent === agent)).toBe(true);
      expect(
        Object.values(agent.sockets).reduce((count, entries) => count + entries.length, 0)
      ).toBe(2);
      expect(
        Object.values(agent.requests).reduce((count, entries) => count + entries.length, 0)
      ).toBe(6);
      if (action === 'release-then-close') transport.release(handle);
      transport.close();
      expect((await results).map((result) => result.reason.code)).toEqual(
        Array(8).fill('PRIVACY_REQUEST_ABORTED')
      );
      let timer;
      try {
        await Promise.race([
          transport.closed,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(Error('TRANSPORT_DRAIN_TIMEOUT')), 300);
          }),
        ]);
      } catch (error) {
        // Failure cleanup only: release tracked requests whose real Agent
        // never emitted close, so this regression cannot hang the next test.
        for (const request of created) request.emit('close');
        throw error;
      } finally {
        clearTimeout(timer);
      }
      expect(requests).toHaveLength(2);
    }
  );
  test('closed is stable, remains pending while open and fulfills after idempotent close', async () => {
    const closed = transport.closed;
    expect(closed).toBeInstanceOf(Promise);
    let settled = false;
    closed.then(() => {
      settled = true;
    });
    await send({ maxResponseBytes: 2048 });
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.close();
    transport.close();
    expect(transport.closed).toBe(closed);
    await closed;
    expect(settled).toBe(true);
    await expect(send()).rejects.toMatchObject({ code: 'TOR_TRANSPORT_CLOSED' });
  });
});
