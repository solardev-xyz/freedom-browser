const {
  FakeClientRequest,
  FakeIncomingMessage,
} = require('../../test/helpers/fake-electron-net');

// Every request Chromium was asked to make, in order. A `.onion` dial that is
// refused before the request exists leaves this empty — that is the assertion
// the leak tests are built on.
const mockNetRequests = [];
const mockNetRequest = jest.fn((options) => {
  const request = new FakeClientRequest(options);
  mockNetRequests.push(request);
  return request;
});
// What the session's proxy policy answers for a dialled URL. `DIRECT` is what
// a real session answers for an onion URL while Tor is off or still starting.
let mockResolveProxy = jest.fn(async () => 'DIRECT');

jest.mock('electron', () => ({
  net: { request: (options) => mockNetRequest(options) },
  session: { defaultSession: { resolveProxy: (url) => mockResolveProxy(url) } },
}));

jest.mock('./service-registry', () => ({
  getAntApiUrl: jest.fn(() => 'http://127.0.0.1:1633'),
  getIpfsGatewayUrl: jest.fn(() => 'http://127.0.0.1:8080'),
}));

jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { prefetchGatewayUrl, PREFETCH_TIMEOUT_MS } = require('./ens-prefetch');
const { getAntApiUrl, getIpfsGatewayUrl } = require('./service-registry');

const CID = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';
const HASH = 'a'.repeat(64);
const ONION_ROUTED = 'SOCKS5 127.0.0.1:9150';

let nodeFetch;
let realFetch;

// The transport builds its request inside an async function, so a dial that
// awaits `session.resolveProxy` first lands a microtask later.
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

/** Answer the pending fake request the way Chromium answers a real one. */
function answer(request, { status = 200, chunks = ['hi'], end = true } = {}) {
  const response = new FakeIncomingMessage({ statusCode: status });
  request.emit('response', response);
  for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
  if (end) response.emit('end');
  return response;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockNetRequests.length = 0;
  mockResolveProxy = jest.fn(async () => 'DIRECT');
  realFetch = global.fetch;
  nodeFetch = jest.fn(async () => new Response('hi', { status: 200 }));
  global.fetch = nodeFetch;
  delete process.env.ENS_DISABLE_PREFETCH;
  getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
  getIpfsGatewayUrl.mockReturnValue('http://127.0.0.1:8080');
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = realFetch;
});

describe('prefetchGatewayUrl — a loopback node keeps Node fetch', () => {
  test('fires a GET against the bzz gateway for bzz:// URIs', async () => {
    const handle = prefetchGatewayUrl(`bzz://${HASH}`);

    expect(nodeFetch).toHaveBeenCalledTimes(1);
    expect(nodeFetch.mock.calls[0][0]).toBe(`http://127.0.0.1:1633/bzz/${HASH}`);
    expect(nodeFetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(mockNetRequest).not.toHaveBeenCalled();
    expect(typeof handle.abort).toBe('function');
    await flush();
  });

  test('fires a GET against the ipfs gateway for ipfs:// URIs', async () => {
    prefetchGatewayUrl(`ipfs://${CID}`);

    expect(nodeFetch).toHaveBeenCalledTimes(1);
    expect(nodeFetch.mock.calls[0][0]).toBe(`http://127.0.0.1:8080/ipfs/${CID}`);
    expect(mockNetRequest).not.toHaveBeenCalled();
    await flush();
  });
});

// R4-F1: the prefetch used a bare `net.request`, which only honours a proxy
// policy the session happens to be carrying at that instant and reads/writes
// Chromium's on-disk cache. It now shares `ipfs/gateway-transport.js` with
// every other dial of a configured endpoint.
describe('prefetchGatewayUrl — a remote node goes through the shared transport', () => {
  test.each([
    ['ipfs', `ipfs://${CID}`, 'ipfs.example.test:8080', `/ipfs/${CID}`, getIpfsGatewayUrl],
    // The Ant API is configurable to a remote host in exactly the same way
    // (`startExternalAnt` accepts any http(s) URL), so the sibling branch of
    // this same function needs the same transport.
    ['bzz', `bzz://${HASH}`, 'ant.example.test:1633', `/bzz/${HASH}`, getAntApiUrl],
  ])('a remote %s endpoint is dialled through Chromium', async (_label, uri, host, path, getUrl) => {
    getUrl.mockReturnValue(`http://${host}`);

    prefetchGatewayUrl(uri);
    await flush();

    expect(nodeFetch).not.toHaveBeenCalled();
    expect(mockNetRequest).toHaveBeenCalledTimes(1);
    expect(mockNetRequest.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: `http://${host}${path}`,
      redirect: 'manual',
      // Speculative traffic for a name the user may never visit must not be
      // written into (or answered from) the default profile's disk cache.
      cache: 'no-store',
      credentials: 'omit',
      useSessionCookies: false,
      bypassCustomProtocolHandlers: true,
    });
  });

  test('the response body is drained so the gateway really fetches the content', async () => {
    getIpfsGatewayUrl.mockReturnValue('http://ipfs.example.test:8080');

    prefetchGatewayUrl(`ipfs://${CID}`);
    await flush();

    const request = mockNetRequests[0];
    const response = answer(request, { chunks: ['chunk-1'], end: false });
    await flush();

    // The transport parks the socket as soon as its queue fills; only a
    // consumer that actually reads restarts it. An undrained body leaves this
    // paused forever and the gateway never finishes serving the content.
    expect(response.paused).toBe(false);

    response.emit('end');
    await flush();

    // Completing naturally releases the hygiene timer — no late abort.
    jest.advanceTimersByTime(PREFETCH_TIMEOUT_MS + 100);
    expect(request.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});

// The live leak this PR exists to close, in the path it was still open on: a
// published `.onion` gateway plus a session that is not routing it (Tor off,
// or still bootstrapping) must not hand the onion name to Chromium at all.
describe('prefetchGatewayUrl — an .onion endpoint is only dialled when proxied', () => {
  const ONION_GATEWAY = 'http://freedomgatewayprobe.onion:8080';

  test.each([
    ['DIRECT', 'DIRECT'],
    ['a chain that can fall back to DIRECT', `${ONION_ROUTED};DIRECT`],
    ['an empty resolution', ''],
  ])('%s — no request is made', async (_label, resolved) => {
    getIpfsGatewayUrl.mockReturnValue(ONION_GATEWAY);
    mockResolveProxy = jest.fn(async () => resolved);

    const handle = prefetchGatewayUrl(`ipfs://${CID}`);
    await flush();

    expect(mockResolveProxy).toHaveBeenCalledWith(`${ONION_GATEWAY}/ipfs/${CID}`);
    expect(mockNetRequest).not.toHaveBeenCalled();
    expect(nodeFetch).not.toHaveBeenCalled();
    // A refused dial still degrades silently, like every other failure here.
    expect(() => handle.abort()).not.toThrow();
  });

  test('a session that routes the onion address is dialled', async () => {
    getIpfsGatewayUrl.mockReturnValue(ONION_GATEWAY);
    mockResolveProxy = jest.fn(async () => ONION_ROUTED);

    prefetchGatewayUrl(`ipfs://${CID}`);
    await flush();

    expect(mockNetRequest).toHaveBeenCalledTimes(1);
    expect(mockNetRequest.mock.calls[0][0].url).toBe(`${ONION_GATEWAY}/ipfs/${CID}`);
  });

  test('an abort during proxy resolution never reaches the network', async () => {
    getIpfsGatewayUrl.mockReturnValue(ONION_GATEWAY);
    let release;
    mockResolveProxy = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ONION_ROUTED);
        })
    );

    const handle = prefetchGatewayUrl(`ipfs://${CID}`);
    handle.abort();
    release();
    await flush();

    expect(mockNetRequest).not.toHaveBeenCalled();
  });
});

describe('prefetchGatewayUrl — noop cases', () => {
  test('ipns:// URIs return a noop handle without any network call', () => {
    const handle = prefetchGatewayUrl('ipns://docs.ipfs.io');
    expect(mockNetRequest).not.toHaveBeenCalled();
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(typeof handle.abort).toBe('function');
    // abort on the noop is idempotent and harmless
    handle.abort();
    handle.abort();
  });

  test('malformed URIs return a noop handle', () => {
    prefetchGatewayUrl('');
    prefetchGatewayUrl(null);
    prefetchGatewayUrl('https://example.com');
    prefetchGatewayUrl('bzz://not-a-hash');
    prefetchGatewayUrl('ipfs://');
    expect(mockNetRequest).not.toHaveBeenCalled();
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  test('missing gateway endpoints return a noop handle without any network call', () => {
    getAntApiUrl.mockReturnValue(null);
    prefetchGatewayUrl(`bzz://${HASH}`);

    getIpfsGatewayUrl.mockReturnValue(null);
    prefetchGatewayUrl(`ipfs://${CID}`);

    expect(mockNetRequest).not.toHaveBeenCalled();
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  test('ENS_DISABLE_PREFETCH=1 env var suppresses all network calls', () => {
    process.env.ENS_DISABLE_PREFETCH = '1';
    prefetchGatewayUrl(`bzz://${HASH}`);
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(mockNetRequest).not.toHaveBeenCalled();
  });

  test('only strict "1" disables prefetch — avoids the ENS_DISABLE_PREFETCH=0 foot-gun', async () => {
    // '0' and 'true' look like config intent but should NOT disable,
    // matching the Unix convention used in other env flags.
    for (const value of ['0', 'true', 'yes', 'TRUE', '']) {
      process.env.ENS_DISABLE_PREFETCH = value;
      nodeFetch.mockClear();
      prefetchGatewayUrl(`bzz://${HASH}`);
      expect(nodeFetch).toHaveBeenCalled();
    }
    await flush();
  });
});

describe('prefetchGatewayUrl — lifecycle', () => {
  beforeEach(() => {
    getIpfsGatewayUrl.mockReturnValue('http://ipfs.example.test:8080');
  });

  test('abort() cancels the in-flight request and clears the timer', async () => {
    const handle = prefetchGatewayUrl(`ipfs://${CID}`);
    await flush();
    const request = mockNetRequests[0];
    expect(request.aborted).toBe(false);

    handle.abort();
    expect(request.aborted).toBe(true);

    // Second abort is a no-op (idempotent), and no timer is left to fire.
    handle.abort();
    jest.advanceTimersByTime(PREFETCH_TIMEOUT_MS + 100);
    expect(jest.getTimerCount()).toBe(0);
    await flush();
  });

  test('hygiene timeout fires after PREFETCH_TIMEOUT_MS and aborts', async () => {
    prefetchGatewayUrl(`ipfs://${CID}`);
    await flush();
    const request = mockNetRequests[0];
    expect(request.aborted).toBe(false);

    jest.advanceTimersByTime(PREFETCH_TIMEOUT_MS + 100);

    expect(request.aborted).toBe(true);
    await flush();
  });

  test('a transport error cleans up without throwing', async () => {
    const handle = prefetchGatewayUrl(`ipfs://${CID}`);
    await flush();

    expect(() =>
      mockNetRequests[0].emit('error', new Error('net::ERR_CONNECTION_REFUSED'))
    ).not.toThrow();
    await flush();

    // The hygiene timer is released by the failure, so nothing fires late.
    jest.advanceTimersByTime(PREFETCH_TIMEOUT_MS + 100);
    expect(jest.getTimerCount()).toBe(0);
    expect(() => handle.abort()).not.toThrow();
  });

  test('any thrown exception returns a noop handle (never breaks caller)', async () => {
    // A transport that cannot even build a request must not surface as a
    // rejected promise nobody handles, nor break the resolver that called us.
    mockNetRequest.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const handle = prefetchGatewayUrl(`ipfs://${CID}`);
    expect(typeof handle.abort).toBe('function');
    await flush();
    handle.abort(); // does not throw

    // And a synchronous throw while building the URL degrades the same way.
    getAntApiUrl.mockImplementationOnce(() => {
      throw new Error('registry exploded');
    });
    expect(typeof prefetchGatewayUrl(`bzz://${HASH}`).abort).toBe('function');
  });
});
