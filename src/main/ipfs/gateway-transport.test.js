const {
  FakeClientRequest,
  FakeIncomingMessage,
} = require('../../../test/helpers/fake-electron-net');

const {
  gatewayFetch,
  netGatewayFetch,
  isLoopbackHostname,
  isLoopbackGatewayUrl,
  isOnionHostname,
  isOnionGatewayUrl,
} = require('./gateway-transport');

// What the Tor PAC resolves an onion URL to once Arti is up. Dials in these
// tests hand it in through the `resolveProxy` seam, because a `.onion` URL is
// only dialled when the session proves it is proxied (see the onion block).
const ONION_ROUTED = 'SOCKS5 127.0.0.1:9150';
const routedProxy = () => jest.fn(async () => ONION_ROUTED);

function startNetFetch(url, init = {}) {
  let request = null;
  const requestImpl = jest.fn((options) => {
    request = new FakeClientRequest(options);
    return request;
  });
  const promise = netGatewayFetch(url, init, { requestImpl });
  // The request is built synchronously inside the promise executor.
  return { promise, requestImpl, request };
}

async function readAll(response) {
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const REMOTE = 'http://gateway.example:8080/ipfs/bafkqaaa';

describe('isLoopbackHostname / isLoopbackGatewayUrl', () => {
  test.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['localhost', true],
    ['LOCALHOST', true],
    ['::1', true],
    ['[::1]', true],
    // A `127.` prefix test would accept these; they resolve wherever their
    // owner points them, so they are remote and must be proxied like any
    // other remote host.
    ['127.evil.example', false],
    ['127.0.0.1.evil.example', false],
    ['127x0x0x1', false],
    ['gateway.example', false],
    ['1.2.3.4', false],
    ['abc.onion', false],
    ['', false],
  ])('isLoopbackHostname(%s) === %s', (hostname, expected) => {
    expect(isLoopbackHostname(hostname)).toBe(expected);
  });

  test('a URL that cannot be parsed is not treated as loopback (fail closed)', () => {
    expect(isLoopbackGatewayUrl('not a url')).toBe(false);
    expect(isLoopbackGatewayUrl(null)).toBe(false);
    expect(isLoopbackGatewayUrl('http://127.0.0.1:8080/ipfs/bafkqaaa')).toBe(true);
  });
});

describe('gatewayFetch transport selection', () => {
  // #355: a remote gateway must go through Chromium so the session's proxy
  // policy (the `.onion` PAC tor-proxy.js installs) applies. Node's fetch has
  // its own socket stack and never sees `session.setProxy`.
  test.each([
    'http://gateway.example:8080/ipfs/bafkqaaa',
    'https://ipfs.io/ipfs/bafkqaaa',
    'http://abcdefgh.onion:8080/ipfs/bafkqaaa',
    'http://192.168.1.9:8080/ipfs/bafkqaaa',
    'http://127.evil.example:8080/ipfs/bafkqaaa',
  ])('a remote gateway (%s) is dialled through Electron net', async (url) => {
    const nodeFetch = jest.fn();
    const requestImpl = jest.fn((options) => {
      const request = new FakeClientRequest(options);
      setImmediate(() => request.emit('response', new FakeIncomingMessage({ statusCode: 204 })));
      return request;
    });

    const response = await gatewayFetch(
      url,
      { redirect: 'manual' },
      { nodeFetch, requestImpl, resolveProxy: routedProxy() }
    );

    expect(response.status).toBe(204);
    expect(requestImpl).toHaveBeenCalledTimes(1);
    expect(requestImpl.mock.calls[0][0].url).toBe(url);
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  // The documented Kubo/IPFS Desktop setup. Chromium bypasses proxies for
  // loopback anyway (measured), so nothing is gained by moving it — and the
  // local path stays exactly what it was before this change.
  test.each([
    'http://127.0.0.1:8080/ipfs/bafkqaaa',
    'http://localhost:8080/ipfs/bafkqaaa',
    'http://127.1.2.3:8080/ipfs/bafkqaaa',
    'http://[::1]:8080/ipfs/bafkqaaa',
  ])('a loopback gateway (%s) keeps Node fetch', async (url) => {
    const nodeFetch = jest.fn(async () => new Response('local', { status: 200 }));
    const requestImpl = jest.fn();

    const response = await gatewayFetch(url, { redirect: 'manual' }, { nodeFetch, requestImpl });

    expect(await response.text()).toBe('local');
    expect(nodeFetch).toHaveBeenCalledWith(url, { redirect: 'manual' });
    expect(requestImpl).not.toHaveBeenCalled();
  });
});

// R2-F1: moving this path onto Chromium only stops the onion-hostname leak
// once the session actually carries the Tor PAC. At launch it does not —
// `startIpfs()` probes the configured gateway within ~1s while Arti is still
// bootstrapping (seconds to ~120s) — and an unproxied `.onion` dial hands the
// name straight to the system resolver (measured on Electron 44.3.0:
// `resolveProxy` → `DIRECT`, dial → `net::ERR_NAME_NOT_RESOLVED` in 12ms). So
// the dial is refused unless the session proves the URL is proxied.
describe('an .onion gateway is only dialled when the session proxies it', () => {
  const ONION = 'http://freedomgatewayprobe.onion:8080/ipfs/bafkqaaa';

  test.each([
    ['abc.onion', true],
    ['ABC.ONION', true],
    ['sub.abc.onion', true],
    // The PAC matches a bare `onion` host too (`host === "onion"`), and a
    // trailing root dot is the same name to Chromium and to the resolver.
    ['onion', true],
    ['abc.onion.', true],
    ['abc.onion.example', false],
    ['onionsite.example', false],
    ['gateway.example', false],
    ['127.0.0.1', false],
    ['', false],
  ])('isOnionHostname(%s) === %s', (hostname, expected) => {
    expect(isOnionHostname(hostname)).toBe(expected);
  });

  test('a URL that cannot be parsed is not onion (it takes the ordinary path)', () => {
    expect(isOnionGatewayUrl('not a url')).toBe(false);
    expect(isOnionGatewayUrl(null)).toBe(false);
    expect(isOnionGatewayUrl(ONION)).toBe(true);
  });

  // Every one of these resolutions ends up asking the system resolver for the
  // onion name — either immediately (DIRECT) or on the proxy's first failure
  // (a `;DIRECT` fallback chain) — so none of them may be dialled.
  test.each([
    ['DIRECT', 'DIRECT'],
    ['a lower-cased DIRECT', 'direct'],
    ['a proxy chain that can fall back to DIRECT', `${ONION_ROUTED};DIRECT`],
    ['an empty resolution', ''],
  ])('%s is refused before any request exists', async (_label, resolved) => {
    const requestImpl = jest.fn();
    const resolveProxy = jest.fn(async () => resolved);

    await expect(
      netGatewayFetch(ONION, { redirect: 'manual' }, { requestImpl, resolveProxy })
    ).rejects.toThrow('not routed through a proxy');

    expect(resolveProxy).toHaveBeenCalledWith(ONION);
    // The point of the whole guard: Chromium is never handed the name.
    expect(requestImpl).not.toHaveBeenCalled();
  });

  // Fail closed, like the unusable-`net` case: a session we cannot ask is not
  // a session we can trust to proxy.
  test('a session that cannot be asked is refused, not dialled anyway', async () => {
    const requestImpl = jest.fn();
    const resolveProxy = jest.fn(async () => {
      throw new Error('session gone');
    });

    await expect(
      netGatewayFetch(ONION, { redirect: 'manual' }, { requestImpl, resolveProxy })
    ).rejects.toThrow('proxy route could not be resolved: session gone');
    expect(requestImpl).not.toHaveBeenCalled();
  });

  test('with no session at all (no resolveProxy on it) the dial is refused', async () => {
    // The default seam reads `session.defaultSession.resolveProxy`, which the
    // Jest electron mock does not provide — the same shape as a main process
    // whose session cannot answer.
    await expect(netGatewayFetch(ONION, { redirect: 'manual' })).rejects.toThrow(
      'proxy route could not be resolved'
    );
  });

  test.each([ONION_ROUTED, 'PROXY 127.0.0.1:3128', `${ONION_ROUTED};SOCKS5 127.0.0.1:9151`])(
    'a session that resolves %s dials the onion name itself (remote DNS at the proxy)',
    async (resolved) => {
      const requestImpl = jest.fn((options) => {
        const request = new FakeClientRequest(options);
        setImmediate(() => request.emit('response', new FakeIncomingMessage({ statusCode: 204 })));
        return request;
      });

      const response = await netGatewayFetch(
        ONION,
        { redirect: 'manual' },
        { requestImpl, resolveProxy: jest.fn(async () => resolved) }
      );

      expect(response.status).toBe(204);
      expect(requestImpl.mock.calls[0][0].url).toBe(ONION);
    }
  );

  // R3-F1: that session round-trip is awaited, so a caller's deadline (the
  // gateway probe's 2s timer) can land while `resolveProxy` is in flight. An
  // already-aborted signal never fires `addEventListener('abort')`, so dialling
  // at that point would create a request nothing can cancel and leave the
  // promise pending until the network settled it — with the probe's caller
  // (startExternalIpfs, inside the serialized op queue) stalled behind it.
  test('an abort that lands while the proxy is resolving is honoured, not dialled', async () => {
    const controller = new AbortController();
    const requestImpl = jest.fn();
    const resolveProxy = jest.fn(async () => {
      controller.abort();
      return ONION_ROUTED;
    });

    await expect(
      netGatewayFetch(
        ONION,
        { redirect: 'manual', signal: controller.signal },
        { requestImpl, resolveProxy }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(resolveProxy).toHaveBeenCalledWith(ONION);
    expect(requestImpl).not.toHaveBeenCalled();
  });

  // The check costs a session round-trip, so it stays on the one host class
  // that needs it: everything else dials exactly as before.
  test.each([
    'http://gateway.example:8080/ipfs/bafkqaaa',
    'https://ipfs.io/ipfs/bafkqaaa',
    'http://192.168.1.9:8080/ipfs/bafkqaaa',
  ])('a non-onion gateway (%s) never consults the session', async (url) => {
    const resolveProxy = jest.fn();
    const requestImpl = jest.fn((options) => {
      const request = new FakeClientRequest(options);
      setImmediate(() => request.emit('response', new FakeIncomingMessage({ statusCode: 204 })));
      return request;
    });

    await netGatewayFetch(url, { redirect: 'manual' }, { requestImpl, resolveProxy });

    expect(resolveProxy).not.toHaveBeenCalled();
    expect(requestImpl).toHaveBeenCalledTimes(1);
  });
});

describe('netGatewayFetch', () => {
  test('dials with the options that keep the request identical to the undici one', () => {
    const headers = new Headers({ range: 'bytes=0-10', accept: 'text/html' });
    const { requestImpl, request } = startNetFetch(REMOTE, { method: 'GET', headers });

    expect(requestImpl.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: REMOTE,
      // Never followed — see the SSRF note in serveExternalGatewayRequest.
      redirect: 'manual',
      // Nothing of the session travels to a third-party gateway but its proxy
      // policy: no cookies, no stored credentials.
      credentials: 'omit',
      useSessionCookies: false,
      // undici had no HTTP cache; Chromium's default one would both answer the
      // reachability probe from a stale 200 (Kubo marks `/ipfs/<cid>`
      // `immutable, max-age=29030400`) and write private-window `ipfs://`
      // bytes into the default profile's on-disk cache.
      cache: 'no-store',
      // Straight to the network, never into a registered http(s) protocol
      // handler (the e2e harness registers one).
      bypassCustomProtocolHandlers: true,
    });
    expect(request.sentHeaders).toEqual({ accept: 'text/html', range: 'bytes=0-10' });
    expect(request.ended).toBe(true);
  });

  test('forwards a plain-object headers bag too, rather than sending none', () => {
    const { request } = startNetFetch(REMOTE, { headers: { range: 'bytes=0-10' } });

    expect(request.sentHeaders).toEqual({ range: 'bytes=0-10' });
  });

  test('aborts the request it created when a header cannot be set', async () => {
    let request = null;
    const requestImpl = jest.fn((options) => {
      request = new FakeClientRequest(options);
      request.setHeader = () => {
        throw new TypeError('Invalid header name');
      };
      return request;
    });

    await expect(
      netGatewayFetch(REMOTE, { headers: { 'bad header': 'x' } }, { requestImpl })
    ).rejects.toThrow('Invalid header name');
    // The only exit path that used to leave the created request neither
    // ended nor aborted.
    expect(request.ended).toBe(false);
    expect(request.aborted).toBe(true);
  });

  test('refuses any redirect mode but manual', async () => {
    await expect(netGatewayFetch(REMOTE, { redirect: 'follow' })).rejects.toThrow(
      /redirect: 'manual' only/
    );
    await expect(netGatewayFetch(REMOTE, { redirect: 'error' })).rejects.toThrow(
      /redirect: 'manual' only/
    );
  });

  test('surfaces a 3xx with its Location instead of following it', async () => {
    const { promise, request } = startNetFetch(REMOTE, { redirect: 'manual' });
    request.emit('redirect', 301, 'GET', 'http://gateway.example:8080/ipfs/bafkqaaa/', {
      location: ['/ipfs/bafkqaaa/'],
      'x-ipfs-path': ['/ipfs/bafkqaaa'],
      'content-length': ['0'],
    });

    const response = await promise;

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/ipfs/bafkqaaa/');
    expect(response.headers.get('x-ipfs-path')).toBe('/ipfs/bafkqaaa');
    expect(response.body).toBeNull();
    // Aborting the request is what stops Chromium from taking the hop.
    expect(request.aborted).toBe(true);
  });

  test('streams a body and reports the headers the proxy hop has to strip', async () => {
    const { promise, request } = startNetFetch(REMOTE);
    const upstream = new FakeIncomingMessage({
      statusCode: 200,
      statusMessage: 'OK',
      headers: {
        // Chromium hands back a *decoded* body while still reporting the
        // upstream encoding and its compressed length — exactly like undici,
        // which is why DROPPED_UPSTREAM_RESPONSE_HEADERS is still needed.
        'content-encoding': 'gzip',
        'content-length': '41',
        'content-type': 'text/plain',
        'set-cookie': ['a=1', 'b=2'],
      },
    });
    request.emit('response', upstream);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-length')).toBe('41');
    expect(response.headers.get('set-cookie')).toContain('a=1');
    expect(response.headers.get('set-cookie')).toContain('b=2');

    const read = readAll(response);
    upstream.emit('data', Buffer.from('hello '));
    upstream.emit('data', Buffer.from('world'));
    upstream.emit('end');
    expect((await read).toString()).toBe('hello world');
  });

  test.each([
    ['a 204', { statusCode: 204, statusMessage: 'No Content' }, 'GET'],
    ['a 304', { statusCode: 304, statusMessage: 'Not Modified' }, 'GET'],
    ['a HEAD', { statusCode: 200, statusMessage: 'OK' }, 'HEAD'],
  ])('%s response carries no body', async (_label, resInit, method) => {
    const { promise, request } = startNetFetch(REMOTE, { method });
    const upstream = new FakeIncomingMessage({ ...resInit, headers: { 'x-ipfs-path': '/ipfs/x' } });
    request.emit('response', upstream);

    const response = await promise;

    expect(response.status).toBe(resInit.statusCode);
    expect(response.body).toBeNull();
    expect(response.headers.get('x-ipfs-path')).toBe('/ipfs/x');
  });

  // An Electron IncomingMessage is an EventEmitter: an 'error' emitted on one
  // with no listener is an uncaught main-process exception. Both responses the
  // transport abandons (drained for a null body, destroyed after the promise
  // already settled) have to keep one attached.
  test('a drained null-body response tolerates a late socket error', async () => {
    const { promise, request } = startNetFetch(REMOTE, { method: 'HEAD' });
    const upstream = new FakeIncomingMessage({ statusCode: 200, statusMessage: 'OK' });
    request.emit('response', upstream);
    await promise;

    expect(() => upstream.emit('error', new Error('net::ERR_CONNECTION_RESET'))).not.toThrow();
  });

  test('a response arriving after the request settled tolerates a late socket error', async () => {
    const controller = new AbortController();
    const { promise, request } = startNetFetch(REMOTE, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    const upstream = new FakeIncomingMessage({ statusCode: 200 });
    request.emit('response', upstream);
    expect(upstream.destroyed).toBe(true);
    expect(() => upstream.emit('error', new Error('net::ERR_CONNECTION_RESET'))).not.toThrow();
  });

  // `new Response(…, { status })` accepts 200-599 only, so an informational
  // status would throw a RangeError inside the 'response' handler — an uncaught
  // main-process exception rather than a failed request. Chromium does not
  // surface one as a final response today; this is the guard for if it ever does.
  test.each([
    ['101', 101, 'GET'],
    ['103', 103, 'GET'],
    ['103 on HEAD', 103, 'HEAD'],
  ])(
    'a %s final response fails the request instead of throwing',
    async (_label, status, method) => {
      const { promise, request } = startNetFetch(REMOTE, { method });
      const upstream = new FakeIncomingMessage({
        statusCode: status,
        statusMessage: 'Early Hints',
      });

      expect(() => request.emit('response', upstream)).not.toThrow();
      await expect(promise).rejects.toThrow(/could not be represented \(status 10[13]\)/);
      expect(request.aborted).toBe(true);
    }
  );

  test('rejects with an AbortError when the signal fires before the response', async () => {
    const controller = new AbortController();
    const { promise, request } = startNetFetch(REMOTE, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.aborted).toBe(true);
  });

  test('an already-aborted signal never opens a connection', async () => {
    const controller = new AbortController();
    controller.abort();
    const requestImpl = jest.fn();

    await expect(
      netGatewayFetch(REMOTE, { signal: controller.signal }, { requestImpl })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestImpl).not.toHaveBeenCalled();
  });

  test('aborting mid-stream tears down the request and errors the body', async () => {
    const controller = new AbortController();
    const { promise, request } = startNetFetch(REMOTE, { signal: controller.signal });
    const upstream = new FakeIncomingMessage({});
    request.emit('response', upstream);
    const response = await promise;

    const reader = response.body.getReader();
    upstream.emit('data', Buffer.from('partial'));
    expect(Buffer.from((await reader.read()).value).toString()).toBe('partial');

    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.aborted).toBe(true);
  });

  test('cancelling the body stream aborts the upstream request', async () => {
    const { promise, request } = startNetFetch(REMOTE);
    const upstream = new FakeIncomingMessage({});
    request.emit('response', upstream);
    const response = await promise;

    await response.body.cancel();

    expect(request.aborted).toBe(true);
  });

  test('a connection failure rejects with the network error', async () => {
    const { promise, request } = startNetFetch(REMOTE);
    request.emit('error', new Error('net::ERR_CONNECTION_REFUSED'));

    await expect(promise).rejects.toThrow('net::ERR_CONNECTION_REFUSED');
  });

  test('a stream that dies mid-body errors the reader', async () => {
    const { promise, request } = startNetFetch(REMOTE);
    const upstream = new FakeIncomingMessage({});
    request.emit('response', upstream);
    const response = await promise;
    const reader = response.body.getReader();
    upstream.emit('data', Buffer.from('half'));
    await reader.read();

    upstream.emit('error', new Error('net::ERR_CONNECTION_RESET'));

    await expect(reader.read()).rejects.toThrow('net::ERR_CONNECTION_RESET');
  });

  test('applies backpressure instead of buffering the whole gateway response', async () => {
    const { promise, request } = startNetFetch(REMOTE);
    const upstream = new FakeIncomingMessage({});
    request.emit('response', upstream);
    const response = await promise;

    // Nobody has read yet: one chunk fills the default queue.
    upstream.emit('data', Buffer.alloc(64 * 1024));
    expect(upstream.paused).toBe(true);

    const reader = response.body.getReader();
    await reader.read();
    await new Promise((resolve) => setImmediate(resolve));
    expect(upstream.paused).toBe(false);
  });

  // Fail closed: with no usable `net`, the request must fail rather than fall
  // back to a transport that ignores the session proxy.
  test('fails when Electron net is unavailable rather than dialling around it', async () => {
    await expect(netGatewayFetch(REMOTE)).rejects.toThrow('Electron net.request is unavailable');
  });
});
