jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Stands in for the package's index.cjs, including its load-time side
// effect: it replaces `globalThis.fetch` with a cookie-jar wrapper. The
// client's fetch calls the global fetch, as the WASM does. The real package
// is driven in pubky-sdk-guard.test.js.
jest.mock('@synonymdev/pubky', () => {
  globalThis.fetch = function cookieJarFetch() {
    throw new Error('the SDK cookie wrapper must not stay installed');
  };
  return {
    Pubky: jest.fn(() => ({ client: { fetch: (url, init) => globalThis.fetch(url, init) } })),
    // An IP literal, so the guard needs no DNS.
    resolvePubky: (address) => `https://93.184.215.14/storage/${address}`,
  };
});

const KEY = 'gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo';

const upstream = jest.fn();
const withUrl = (response, url) => Object.defineProperty(response, 'url', { value: url });

let handlePubkyRequest;
let toPubkyAddress;
let loadSdk;
let originalUpstream;

beforeAll(() => {
  globalThis.fetch = upstream;
  originalUpstream = upstream;
  ({ handlePubkyRequest, toPubkyAddress, loadSdk } = require('./pubky-protocol'));
});

beforeEach(() => upstream.mockReset());

describe('toPubkyAddress', () => {
  test.each([
    [`pubky://${KEY}/pub/app/index.html`, `pubky${KEY}/pub/app/index.html`],
    [`pubky://${KEY}/pub/a/../b.txt?x=1`, `pubky${KEY}/pub/b.txt?x=1`],
  ])('accepts %s', (input, address) => {
    expect(toPubkyAddress(input)).toBe(address);
  });

  test.each([
    [`pubky://${KEY}/`, 'outside /pub/'],
    [`pubky://${KEY}/session`, 'outside /pub/'],
    [`pubky://${KEY}/pub/../session`, 'climbs out of /pub/'],
    [`pubky://${KEY.slice(0, -1)}a/pub/x`, 'non-zero trailing bits'],
    [`pubky://${KEY.slice(1)}/pub/x`, 'short key'],
    [`pubky://www.${KEY}/pub/x`, 'label before the key'],
    [`pubky://${KEY}:8080/pub/x`, 'port'],
    [`https://${KEY}/pub/x`, 'other scheme'],
  ])('rejects %s (%s)', (input) => {
    expect(toPubkyAddress(input)).toBeNull();
  });
});

describe('loadSdk', () => {
  test('undoes the package replacing the process-wide fetch', async () => {
    loadSdk();
    // The router now in place hands a call made outside a pubky request
    // to the original fetch with the same arguments.
    const init = { headers: { 'x-probe': '1' } };
    upstream.mockResolvedValue('passed through');
    await expect(globalThis.fetch('https://example.test/x', init)).resolves.toBe('passed through');
    expect(upstream).toHaveBeenCalledWith('https://example.test/x', init);
  });
});

describe('handlePubkyRequest', () => {
  const fileUrl = `https://93.184.215.14/storage/pubky${KEY}/pub/x`;

  test('returns the homeserver response', async () => {
    const response = withUrl(new Response('hi', { status: 404 }), fileUrl);
    upstream.mockResolvedValue(response);
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'HEAD' });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('hi');
    const [request] = upstream.mock.calls[0];
    expect(request.url).toBe(fileUrl);
    expect(request.method).toBe('HEAD');
    expect(request.redirect).toBe('manual');
  });

  test('refuses a homeserver redirect with fixed text', async () => {
    upstream.mockResolvedValue(
      withUrl(
        new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:1633/' } }),
        fileUrl
      )
    );
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'GET' });
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toBe('Could not reach the homeserver for this key');
  });

  test('drops page-state, encoding and hop-by-hop headers from the homeserver', async () => {
    const headers = new Headers({
      'content-type': 'text/html',
      'cache-control': 'max-age=60',
      'content-encoding': 'gzip',
      'content-length': '87',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'service-worker-allowed': '/',
    });
    headers.append('set-cookie', 'track=abc; Path=/');
    upstream.mockResolvedValue(withUrl(new Response('<p>decoded</p>', { headers }), fileUrl));
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'GET' });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual({
      'content-type': 'text/html',
      'cache-control': 'max-age=60',
    });
    expect(await res.text()).toBe('<p>decoded</p>');
  });

  test('forwards range and conditional headers, and nothing else', async () => {
    const pageHeaders = new Headers({
      range: 'bytes=100-199',
      'if-range': '"v1"',
      'if-none-match': '"v1"',
      'if-modified-since': 'Tue, 01 Sep 2026 00:00:00 GMT',
      cookie: 'session=secret',
      authorization: 'Bearer secret',
      referer: `pubky://${KEY}/pub/page.html`,
      'x-custom': '1',
    });
    upstream.mockResolvedValue(
      withUrl(
        new Response('partial', {
          status: 206,
          headers: { 'content-range': 'bytes 100-199/1000', 'accept-ranges': 'bytes' },
        }),
        fileUrl
      )
    );
    const res = await handlePubkyRequest({
      url: `pubky://${KEY}/pub/clip.mp4`,
      method: 'GET',
      headers: pageHeaders,
    });
    const [request] = upstream.mock.calls[0];
    expect(Object.fromEntries(request.headers)).toEqual({
      range: 'bytes=100-199',
      'if-range': '"v1"',
      'if-none-match': '"v1"',
      'if-modified-since': 'Tue, 01 Sep 2026 00:00:00 GMT',
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(await res.text()).toBe('partial');
  });

  test('passes a bodiless 304 through', async () => {
    upstream.mockResolvedValue(withUrl(new Response(null, { status: 304 }), fileUrl));
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'GET' });
    expect(res.status).toBe(304);
  });

  test('refuses a response the guard did not vet', async () => {
    // As if the SDK lost the async context and dialled the original fetch
    // directly: the response never passed through the guard.
    const { client } = loadSdk();
    const sdkFetch = client.fetch;
    client.fetch = (url, init) => originalUpstream(url, init);
    try {
      upstream.mockResolvedValue(withUrl(new Response('unguarded'), fileUrl));
      const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'GET' });
      expect(res.status).toBe(502);
    } finally {
      client.fetch = sdkFetch;
    }
  });

  test('refuses writes without calling the SDK', async () => {
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'PUT' });
    expect(res.status).toBe(405);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('rejects an invalid address', async () => {
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/session`, method: 'GET' });
    expect(res.status).toBe(400);
  });

  test('maps a failure to 502 without echoing the error text', async () => {
    upstream.mockRejectedValue(new Error('relay https://internal.example/secret said no'));
    const res = await handlePubkyRequest({ url: `pubky://${KEY}/pub/x`, method: 'GET' });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toBe('Could not reach the homeserver for this key');
    expect(body).not.toMatch(/internal|relay/);
  });
});

describe('handlePubkyRequest deadline and cancellation', () => {
  const fileUrl = `https://93.184.215.14/storage/pubky${KEY}/pub/x`;
  // A homeserver that accepted the connection and never answers: the dial
  // settles only when its signal aborts.
  const hangUntilAborted = (request) =>
    new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), {
        once: true,
      });
    });

  test('the default deadline is 30s, as ipfs-protocol.js', () => {
    expect(require('./pubky-protocol').FETCH_TIMEOUT_MS).toBe(30_000);
  });

  test('a homeserver that never answers gets a 504 and its dial aborted', async () => {
    let dial;
    upstream.mockImplementation((request) => {
      dial = request;
      return hangUntilAborted(request);
    });
    const res = await handlePubkyRequest(
      { url: `pubky://${KEY}/pub/x`, method: 'GET' },
      { timeoutMs: 30 }
    );
    expect(res.status).toBe(504);
    expect(await res.text()).toBe('The homeserver for this key did not answer in time');
    expect(dial.signal.aborted).toBe(true);
  });

  test('the deadline still answers when the SDK never settles', async () => {
    // Stands in for a hang the signal does not reach (e.g. a relay dial).
    const { client } = loadSdk();
    const sdkFetch = client.fetch;
    client.fetch = () => new Promise(() => {});
    try {
      const res = await handlePubkyRequest(
        { url: `pubky://${KEY}/pub/x`, method: 'GET' },
        { timeoutMs: 30 }
      );
      expect(res.status).toBe(504);
    } finally {
      client.fetch = sdkFetch;
    }
  });

  test('the page cancelling the request aborts the dial', async () => {
    const page = new AbortController();
    let dial;
    upstream.mockImplementation((request) => {
      dial = request;
      setTimeout(() => page.abort(), 10);
      return hangUntilAborted(request);
    });
    const res = await handlePubkyRequest({
      url: `pubky://${KEY}/pub/x`,
      method: 'GET',
      signal: page.signal,
    });
    expect(dial.signal.aborted).toBe(true);
    // Not reported as a homeserver timeout: nobody is waiting for it.
    expect(res.status).toBe(502);
  });

  test('a request the page already cancelled never dials', async () => {
    const page = new AbortController();
    page.abort();
    const res = await handlePubkyRequest({
      url: `pubky://${KEY}/pub/x`,
      method: 'GET',
      signal: page.signal,
    });
    expect(res.status).toBe(502);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('the deadline stops once headers arrive; the body streams past it', async () => {
    let dial;
    let push;
    upstream.mockImplementation((request) => {
      dial = request;
      const body = new ReadableStream({
        start(controller) {
          push = controller;
        },
      });
      return Promise.resolve(withUrl(new Response(body, { status: 200 }), fileUrl));
    });
    const res = await handlePubkyRequest(
      { url: `pubky://${KEY}/pub/x`, method: 'GET' },
      { timeoutMs: 20 }
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));
    expect(dial.signal.aborted).toBe(false);
    push.enqueue(new TextEncoder().encode('late body'));
    push.close();
    expect(await res.text()).toBe('late body');
  });
});
