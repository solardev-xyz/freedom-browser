jest.mock('electron', () => ({
  net: { fetch: jest.fn() },
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// The handlers ask the core for a plan (freedom-core design 0006,
// `dweb.open`) and execute it. CID and IPNS-key canonicalization, the
// gateway-form redirects, name resolution and the header strip-list are the
// core's, pinned by fc-dweb's vectors; here the core is played by
// `test/helpers/fake-dweb-core.js`, which plans as fc-dweb does, and these
// cases cover what main does with the plans against an injected native
// request function: the dial, the response operations and the log.
//
// Prefix required by Jest's mock-factory hoisting: the factory runs before
// regular `const` initialisation, so any captured variable must start with
// `mock` to survive the static analyser.
const mockResolveEnsContent = jest.fn();
const mockResolveTezosDomain = jest.fn();
const { createFakeDwebDriver } = require('../../../test/helpers/fake-dweb-core');
const mockDriver = createFakeDwebDriver({
  resolveContent: (...args) => mockResolveEnsContent(...args),
  resolveTezos: (...args) => mockResolveTezosDomain(...args),
});
jest.mock('../core/naming', () => ({ namingDriver: () => mockDriver }));

const { handleRequest } = require('./ipfs-protocol');

const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
// Canonical CIDv1 base32 (`bafy...`) form of `CIDV0`; used to assert that
// the handler converts mixed-case CIDv0 hosts before forwarding to freedom-ipfs.
const CIDV0_AS_BASE32 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34';
const CIDV1_BASE32 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CIDV1_BASE58 = 'zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA';
// Canonical CIDv1 base32 (`bafk…` raw) form of `CIDV1_BASE58`; used to
// assert that the handler converts mixed-case `z…` hosts before forwarding
// to native gateway (base58btc is case-sensitive and Chromium lowercases standard-
// scheme hosts, so re-encoding to lowercase-canonical base32 is the only
// way to round-trip cleanly).
const CIDV1_BASE58_AS_BASE32 = 'bafkreidon73zkcrwdb5iafqtijxildoonbwnpv7dyd6ef3qdgads2jc4su';
const IPNS_KEY_BASE36 = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const IPNS_KEY_BASE58_ED25519 = '12D3KooWGuQafLgPqRRRkRSUNqZNQwL2gMZcQ27GiNpoVxz3vMWj';

describe('handleRequest', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
  });

  const makeRequest = (url, { method = 'GET', headers = {} } = {}) => ({
    url,
    method,
    headers: new Headers(headers),
    body: null,
    signal: new AbortController().signal,
  });

  test.each([
    ['ipfs', 'ipfs://not-a-cid/', 'invalid ipfs reference'],
    ['ipns', 'ipns://!bad-host!/', 'invalid ipns reference'],
  ])('answers an invalid %s reference with 400 without dialling', async (ns, url, message) => {
    const requestImpl = jest.fn();
    const res = await handleRequest(ns, makeRequest(url), { requestImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(message);
    expect(requestImpl).not.toHaveBeenCalled();
  });

  test('serves a CIDv1 base32 host through the native request API', async () => {
    const requestImpl = jest.fn().mockResolvedValue(new Response('hello', { status: 200 }));
    const res = await handleRequest('ipfs', makeRequest(`ipfs://${CIDV1_BASE32}/file.txt`), {
      requestImpl,
    });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('hello');
    expect(requestImpl).toHaveBeenCalledTimes(1);
    const [init] = requestImpl.mock.calls[0];
    expect(init.path).toBe(`/ipfs/${CIDV1_BASE32}/file.txt`);
    expect(init.method).toBe('GET');
    // The plan's header deadline goes to the node, which runs it.
    expect(init.headersTimeoutMs).toBe(30_000);
  });

  test.each([
    ['ipfs', 'ipfs://vitalik.eth/index.html', 'ipfs', CIDV0, `/ipfs/${CIDV0}/index.html`],
    [
      'ipns',
      'ipns://jalil.eth/',
      'ipns',
      IPNS_KEY_BASE58_ED25519,
      `/ipns/${IPNS_KEY_BASE58_ED25519}/`,
    ],
  ])(
    'serves a %s name host under its resolved reference',
    async (ns, url, protocol, decoded, path) => {
      mockResolveEnsContent.mockResolvedValue({ type: 'ok', protocol, decoded });
      const requestImpl = jest.fn().mockResolvedValue(new Response('hi', { status: 200 }));
      const res = await handleRequest(ns, makeRequest(url), { requestImpl });
      expect(res.status).toBe(200);
      expect(requestImpl.mock.calls[0][0].path).toBe(path);
    }
  );

  test('answers an ipfs:// name with a Swarm contenthash 404, explained, without dialling', async () => {
    mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'bzz',
      decoded: 'a'.repeat(64),
    });
    const requestImpl = jest.fn();
    const res = await handleRequest('ipfs', makeRequest('ipfs://swarm.eth/'), { requestImpl });
    expect(res.status).toBe(404);
    expect(requestImpl).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe(404);
    expect(body.message).toMatch(/resolves to bzz/);
  });

  test('passes 4xx and 5xx through to the page (no retry)', async () => {
    // Unlike bzz:, IPFS doesn't retry transient 5xx — 5xx surfaces at once,
    // so SPAs can fall back without a multi-second hang.
    for (const status of [503, 404]) {
      const requestImpl = jest.fn().mockResolvedValue(new Response('', { status }));
      const res = await handleRequest('ipfs', makeRequest(`ipfs://${CIDV0}/x`), { requestImpl });
      expect(res.status).toBe(status);
      expect(requestImpl).toHaveBeenCalledTimes(1);
    }
  });

  test("a native request that fails is a 502 with the node's message", async () => {
    const requestImpl = jest.fn().mockRejectedValue(new Error('block not found'));
    const res = await handleRequest('ipfs', makeRequest(`ipfs://${CIDV0}/x`), { requestImpl });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'block not found' });
  });

  // O-12: the native gateway is read-only; anything but GET/HEAD is a 405,
  // whether or not the request carries a body.
  test.each([
    ['POST with a body', 'POST', 'payload'],
    ['POST without a body', 'POST', null],
    ['PUT without a body', 'PUT', null],
    ['DELETE', 'DELETE', null],
    ['OPTIONS', 'OPTIONS', null],
    ['PATCH', 'PATCH', null],
    ['lower-case post', 'post', null],
  ])('answers %s with 405 without touching the node', async (_l, method, body) => {
    const requestImpl = jest.fn();
    const res = await handleRequest(
      'ipfs',
      {
        url: `ipfs://${CIDV1_BASE32}/api`,
        method,
        headers: new Headers(),
        body,
        signal: new AbortController().signal,
      },
      { requestImpl }
    );
    expect(res.status).toBe(405);
    expect(requestImpl).not.toHaveBeenCalled();
  });

  test.each(['GET', 'HEAD'])('serves %s', async (method) => {
    const requestImpl = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const res = await handleRequest(
      'ipfs',
      {
        url: `ipfs://${CIDV1_BASE32}/file.txt`,
        method,
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      },
      { requestImpl }
    );
    expect(res.status).toBe(200);
    expect(requestImpl).toHaveBeenCalledWith(
      expect.objectContaining({ method, path: `/ipfs/${CIDV1_BASE32}/file.txt` })
    );
  });
});

// O-3: gateway-form URLs must never be served under the gateway host's
// origin — `ipfs://localhost/ipfs/<cidA>/` and `ipfs://localhost/ipfs/<cidB>/`
// would otherwise share one localStorage/IndexedDB/cookie jar. The handler
// redirects them to the canonical per-CID origin before serving anything.
describe('gateway-form redirect (O-3)', () => {
  const NAVIGATION_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const call = async (namespace, url, { method = 'GET', accept = NAVIGATION_ACCEPT } = {}) => {
    const requestImpl = jest.fn().mockResolvedValue(new Response('bytes', { status: 200 }));
    const res = await handleRequest(
      namespace,
      new Request(url, { method, headers: accept ? { accept } : {} }),
      { requestImpl }
    );
    return { res, requestImpl };
  };

  test.each([
    [
      'localhost /ipfs/<cidv1>',
      'ipfs',
      `ipfs://localhost/ipfs/${CIDV1_BASE32}/`,
      `ipfs://${CIDV1_BASE32}/`,
    ],
    [
      'loopback with Kubo port + query',
      'ipfs',
      `ipfs://127.0.0.1:8080/ipfs/${CIDV1_BASE32}/a/b.html?x=1`,
      `ipfs://${CIDV1_BASE32}/a/b.html?x=1`,
    ],
    [
      'bare gateway root (no trailing path)',
      'ipfs',
      `ipfs://localhost/ipfs/${CIDV1_BASE32}`,
      `ipfs://${CIDV1_BASE32}/`,
    ],
    [
      '*.localhost host',
      'ipfs',
      `ipfs://evil.localhost/ipfs/${CIDV1_BASE32}/x`,
      `ipfs://${CIDV1_BASE32}/x`,
    ],
    [
      'public gateway, CIDv0 → base32',
      'ipfs',
      `ipfs://ipfs.io/ipfs/${CIDV0}/sub`,
      `ipfs://${CIDV0_AS_BASE32}/sub`,
    ],
    [
      'CIDv1 base58btc → base32',
      'ipfs',
      `ipfs://dweb.link/ipfs/${CIDV1_BASE58}/img.png`,
      `ipfs://${CIDV1_BASE58_AS_BASE32}/img.png`,
    ],
    [
      'dweb.link /ipns/<dnslink-name>',
      'ipfs',
      'ipfs://dweb.link/ipns/docs.ipfs.tech/install',
      'ipns://docs.ipfs.tech/install',
    ],
    [
      '/ipns/<base36 key>',
      'ipfs',
      `ipfs://localhost/ipns/${IPNS_KEY_BASE36}/p`,
      `ipns://${IPNS_KEY_BASE36}/p`,
    ],
    [
      '/ipns/<base58 peer id> → base36',
      'ipfs',
      `ipfs://localhost/ipns/${IPNS_KEY_BASE58_ED25519}/foo`,
      'ipns://k51qzi5uqu5dit2ibca2nikouuslvo21d3trnsklq7f1c3zdelrq38i7nahsgk/foo',
    ],
    [
      'ipns: outer scheme, /ipfs/ inner',
      'ipns',
      `ipns://localhost/ipfs/${CIDV1_BASE32}/`,
      `ipfs://${CIDV1_BASE32}/`,
    ],
    ['/ipns/<ens name>', 'ipfs', 'ipfs://localhost/ipns/vitalik.eth/', 'ipns://vitalik.eth/'],
  ])('redirects %s to the canonical origin', async (_l, ns, url, location) => {
    for (const accept of [NAVIGATION_ACCEPT, '*/*', 'image/avif,image/webp,*/*', null]) {
      for (const method of ['GET', 'HEAD']) {
        const { res, requestImpl } = await call(ns, url, { accept, method });
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toBe(location);
        expect(requestImpl).not.toHaveBeenCalled();
      }
    }
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('two CIDs behind one gateway host land on two different origins', async () => {
    const other = CIDV0_AS_BASE32;
    const a = await call('ipfs', `ipfs://localhost/ipfs/${CIDV1_BASE32}/`);
    const b = await call('ipfs', `ipfs://localhost/ipfs/${other}/`);
    // Node's URL has no notion of `ipfs:` as a standard scheme (origin is
    // "null"), so compare the host that Chromium keys the origin on.
    const originA = new URL(a.res.headers.get('location')).host;
    const originB = new URL(b.res.headers.get('location')).host;
    expect(originA).toBe(CIDV1_BASE32);
    expect(originB).toBe(other);
    expect(originA).not.toBe(originB);
  });

  test.each([
    // Looks like a CIDv0 but its base58 was lowercased, so it has no
    // canonical, case-safe form to redirect to.
    ['lower-cased CIDv0', 'ipfs', `ipfs://localhost/ipfs/${CIDV0.toLowerCase()}/`],
    // A libp2p key under /ipfs/ is not a CID.
    ['IPNS key under /ipfs/', 'ipfs', `ipfs://localhost/ipfs/${IPNS_KEY_BASE36}/`],
  ])('refuses %s instead of serving it under the gateway origin', async (_l, ns, url) => {
    const { res, requestImpl } = await call(ns, url);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/gateway-form .* has no canonical/);
    expect(res.headers.get('location')).toBeNull();
    expect(requestImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['a CID host', `ipfs://${CIDV1_BASE32}/index.html`, `/ipfs/${CIDV1_BASE32}/index.html`],
    [
      'a CID host whose own path starts with /ipfs/',
      `ipfs://${CIDV1_BASE32}/ipfs/somefile`,
      `/ipfs/${CIDV1_BASE32}/ipfs/somefile`,
    ],
  ])('does not redirect %s', async (_l, url, path) => {
    const { res, requestImpl } = await call('ipfs', url);
    expect(res.status).toBe(200);
    expect(requestImpl).toHaveBeenCalledWith(expect.objectContaining({ path }));
  });

  test('does not redirect a DNSLink host that is not a known gateway', async () => {
    const { res, requestImpl } = await call('ipns', 'ipns://docs.ipfs.tech/ipfs/coverage');
    expect(res.status).toBe(200);
    expect(requestImpl).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/ipns/docs.ipfs.tech/ipfs/coverage' })
    );
  });

  test('a non-GET gateway-form request is a 405, not a redirect', async () => {
    const { res } = await call('ipfs', `ipfs://localhost/ipfs/${CIDV1_BASE32}/`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
  });
});

// PRIVATE MODE GUARD (request logging) — same contract as the bzz handler,
// for both namespaces this module registers.
describe('registerIpfsProtocol / registerIpnsProtocol private sessions', () => {
  const log = require('../logger');
  const { registerIpfsProtocol, registerIpnsProtocol } = require('./ipfs-protocol');

  function fakeSession() {
    const handlers = new Map();
    return {
      handlers,
      protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) },
    };
  }

  function loggedText() {
    return [log.info, log.warn, log.error]
      .flatMap((fn) => fn.mock.calls)
      .map((call) => call.join(' '))
      .join('\n');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveEnsContent.mockReset();
    mockResolveEnsContent.mockRejectedValue(new Error('rpc down'));
  });

  test.each([
    ['ipfs', registerIpfsProtocol],
    ['ipns', registerIpnsProtocol],
  ])('a private %s session redacts the request URL and the resolved name', async (ns, register) => {
    const session = fakeSession();
    register(session, { privatePartition: 'private-abcd' });

    await session.handlers.get(ns)({ url: `${ns}://secret-site.eth/page.html`, headers: {} });

    const text = loggedText();
    expect(text).not.toContain('secret-site.eth');
    expect(text).not.toContain('page.html');
    expect(text).not.toContain('rpc down');
    // The resolver runs in the core now, which logs no URL.
    expect(text).toContain(`502 for ${ns}://<private>: <private>`);
  });

  // Every resolution failure whose page-facing message names the site. The
  // request URL is redacted at the log site, so these are the branches that
  // could still smuggle the destination into main.log via the message.
  const NAME_BEARING_FAILURES = [
    ['no contenthash', { type: 'not_found', reason: 'NO_CONTENTHASH' }, 404],
    ['a cross-transport contenthash', { type: 'ok', protocol: 'bzz', decoded: 'ab12' }, 404],
    ['an unsupported codec', { type: 'unsupported', reason: 'UNSUPPORTED' }, 415],
    ['disagreeing providers', { type: 'conflict', groups: [] }, 502],
    [
      'a resolver error naming the site',
      { type: 'error', error: 'no provider answered for secret-site.eth' },
      502,
    ],
  ];

  test.each(
    ['ipfs', 'ipns'].flatMap((ns) =>
      NAME_BEARING_FAILURES.map(([label, resolution, status]) => [ns, label, resolution, status])
    )
  )(
    'a private %s session keeps the name out of the log on %s',
    async (ns, _label, resolution, status) => {
      const register = ns === 'ipfs' ? registerIpfsProtocol : registerIpnsProtocol;
      mockResolveEnsContent.mockReset();
      mockResolveEnsContent.mockResolvedValue(resolution);
      const session = fakeSession();
      register(session, { privatePartition: 'private-abcd' });

      const res = await session.handlers.get(ns)({
        url: `${ns}://secret-site.eth/page.html`,
        headers: {},
      });

      expect(res.status).toBe(status);
      const text = loggedText();
      expect(text).not.toContain('secret-site.eth');
      expect(text).not.toContain('page.html');
      expect(text).toContain(`${status} for ${ns}://<private>`);
    }
  );

  test.each(NAME_BEARING_FAILURES)(
    'a normal session keeps the full diagnostic on %s',
    async (_label, resolution) => {
      mockResolveEnsContent.mockReset();
      mockResolveEnsContent.mockResolvedValue(resolution);
      const session = fakeSession();
      registerIpfsProtocol(session);

      await session.handlers.get('ipfs')({ url: 'ipfs://public-site.eth/page.html', headers: {} });

      expect(loggedText()).toContain('public-site.eth');
    }
  );

  test('a private session redacts a CID that only the message carries', async () => {
    const session = fakeSession();
    registerIpfsProtocol(session, { privatePartition: 'private-abcd' });

    // Lowercased CIDv0 host: the 400 explains the problem by quoting the
    // unrecoverable reference, which is the destination.
    const host = 'qm' + 'a'.repeat(44);
    const res = await session.handlers.get('ipfs')({ url: `ipfs://${host}/x`, headers: {} });

    expect(res.status).toBe(400);
    // The page still gets the explanation; the log, whose message is the
    // core's, gets none of it.
    expect((await res.json()).message).toContain(`lowercased CIDv0 host "${host}"`);
    const text = loggedText();
    expect(text).not.toContain(host);
    expect(text).toContain('400 for ipfs://<private>: <private>');
  });

  test('a normal session keeps the full diagnostic URL', async () => {
    const session = fakeSession();
    registerIpfsProtocol(session);

    await session.handlers.get('ipfs')({ url: 'ipfs://public-site.eth/page.html', headers: {} });

    expect(loggedText()).toContain('ipfs://public-site.eth/page.html');
  });
});

describe('extensionless IPFS text navigation', () => {
  const fixture = 'Hello from IPFS Gateway Checker\n';
  // Chromium's fixed navigation Accept header — the only signal a
  // `protocol.handle` request carries that distinguishes a document load
  // from a subresource (no Sec-Fetch-Dest on custom schemes; `destination`
  // is always '' and `mode` always 'cors'). The core's navigation rule reads it.
  const NAVIGATION_ACCEPT =
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
    'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
  async function response(body, headers = {}, method = 'GET', accept = NAVIGATION_ACCEPT) {
    return handleRequest(
      'ipfs',
      new Request(`ipfs://${CIDV1_BASE32}/`, { method, headers: accept ? { accept } : {} }),
      {
        requestImpl: async () =>
          new Response(method === 'HEAD' ? null : body, {
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(Buffer.byteLength(body)),
              ...headers,
            },
          }),
      }
    );
  }
  test('renders the checker fixture inline as text, never HTML', async () => {
    const result = await response(fixture);
    expect(result.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await result.text()).toBe(fixture);
    const html = await response('<script>alert(1)</script>');
    expect(html.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });
  test.each([
    ['attachment', { 'content-disposition': 'attachment; filename="test.txt"' }],
    ['nosniff', { 'x-content-type-options': 'nosniff' }],
    ['range', { 'content-range': 'bytes 0-31/32' }],
  ])('preserves explicit %s metadata', async (_label, headers) => {
    const result = await response(fixture, headers);
    expect(result.headers.get('content-type')).toBe('application/octet-stream');
    expect(await result.text()).toBe(fixture);
  });
  test.each([Buffer.from([0, 1, 2]), Buffer.from([255, 254]), Buffer.alloc(4097, 65)])(
    'preserves binary/large data',
    async (body) => {
      const result = await response(body);
      expect(result.headers.get('content-type')).toBe('application/octet-stream');
      expect(Buffer.from(await result.arrayBuffer())).toEqual(body);
    }
  );
  test('does not trust an understated length or consume HEAD bodies', async () => {
    const body = 'a'.repeat(5000);
    const result = await response(body, { 'content-length': '32' });
    expect(result.headers.get('content-type')).toBe('application/octet-stream');
    expect(await result.text()).toBe(body);
    const head = await response(fixture, {}, 'HEAD');
    expect(head.headers.get('content-type')).toBe('application/octet-stream');
  });
  // A subresource relabelled `text/plain; nosniff` is one Chromium refuses
  // to execute or apply, so an existing page loading a small bare-CID
  // script or stylesheet would silently lose it. Only document loads get
  // the rewrite; every subresource Accept below is Chromium's real one.
  test.each([
    ['script/fetch', '*/*'],
    ['stylesheet', 'text/css,*/*;q=0.1'],
    ['image', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'],
    ['no Accept at all', ''],
  ])('leaves a %s subresource untouched', async (_label, accept) => {
    const result = await response(fixture, {}, 'GET', accept);
    expect(result.headers.get('content-type')).toBe('application/octet-stream');
    expect(result.headers.get('x-content-type-options')).toBeNull();
    expect(await result.text()).toBe(fixture);
  });
});
