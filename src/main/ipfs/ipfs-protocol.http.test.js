/**
 * `ipfs:` / `ipns:` in external-gateway mode — the real handlers, the real
 * ipfs-manager and the real gateway transport against a fake gateway over
 * real loopback HTTP.
 *
 * Roadmap 4.7, design 0006 ("Tests first"). `ipfs-manager.test.js` covers the
 * external backend against a mocked `fetch`; here the handlers registered on
 * a session ask the core for a plan and execute it on the backend
 * `ipfsBackend` captured → `gatewayFetch` → Node's `fetch` → a fake gateway,
 * so Range/206, redirects, header stripping, cancels and backpressure are
 * what the wire actually does. Native mode is in
 * `ipfs-protocol.native.test.js`.
 *
 * The core is played by `test/helpers/fake-dweb-core.js`, which plans as
 * fc-dweb does (checked against the core's own vectors); only the name
 * resolution it asks for is mocked, as before.
 */

const zlib = require('zlib');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { createFakeDwebDriver } = require('../../../test/helpers/fake-dweb-core');
const {
  closedLoopbackPort,
  nextTurn,
  rangeResponder,
  readUntilError,
  startFakeHttpNode,
  streamBody,
  waitFor,
  waitUntilStable,
} = require('../../../test/helpers/fake-http-node');

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CIDV0_AS_BASE32 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34';
const PROBE_PATH = '/ipfs/bafkqaaa';
const ETAG = `"${CID}"`;
const CONTENT = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const MIB = 1024 * 1024;
const NAVIGATION_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
  'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

const rangeOrigin = rangeResponder({ content: CONTENT, etag: ETAG, contentType: 'video/mp4' });

// The manager's reachability probe, answered like a real gateway and kept out
// of `gateway.requests`.
function answerProbe(req, res) {
  if (req.url !== PROBE_PATH) return false;
  res.writeHead(200, { 'X-Ipfs-Path': PROBE_PATH });
  res.end();
  return true;
}

// Load ipfs-manager (external mode, pointed at `externalGateway`) and the
// protocol module in one module registry, register both handlers on a fake
// session and start the node. Everything below the handler is real except the
// profile, the logger and the core's planner. The transport refuses any URL but
// the gateway's: the manager's background Kubo RPC version probe would
// otherwise dial :5001 on this machine.
async function loadExternalStack(externalGateway) {
  const refused = [];
  const mockResolveEnsContent = jest.fn();
  const driver = createFakeDwebDriver({
    resolveContent: (...args) => mockResolveEnsContent(...args),
  });
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const { mod: manager } = loadMainModule(require.resolve('../ipfs-manager'), {
    extraMocks: {
      [require.resolve('../logger')]: () => log,
      [require.resolve('../service-registry')]: () => ({
        MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', DISABLED: 'disabled', NONE: 'none' },
        updateService: jest.fn(),
        setStatusMessage: jest.fn(),
        setErrorState: jest.fn(),
        clearErrorState: jest.fn(),
        clearService: jest.fn(),
      }),
      [require.resolve('../profile-resolver')]: () => ({
        getActiveProfile: () => ({
          metadata: { nodes: { ipfs: { mode: 'external', externalGateway } } },
        }),
      }),
      [require.resolve('./gateway-transport')]: () => {
        const actual = jest.requireActual('./gateway-transport');
        return {
          ...actual,
          gatewayFetch: async (url, init) => {
            if (!String(url).startsWith(`${externalGateway}/`)) {
              refused.push(String(url));
              throw new TypeError('fetch failed');
            }
            return actual.gatewayFetch(url, init);
          },
        };
      },
      [require.resolve('../core/naming')]: () => ({ namingDriver: () => driver }),
    },
  });
  const { registerIpfsProtocol, registerIpnsProtocol } = require('./ipfs-protocol');
  const handlers = new Map();
  const session = { protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) } };
  registerIpfsProtocol(session);
  registerIpnsProtocol(session);
  await manager.startIpfs();
  return {
    manager,
    log,
    refused,
    mockResolveEnsContent,
    ipfs: handlers.get('ipfs'),
    ipns: handlers.get('ipns'),
    stats: () => JSON.parse(manager.getNativeDiagnostics().nativeGatewayStats),
  };
}

let gateway;
let stack;

const ipfs = (path, init) => stack.ipfs(new Request(`ipfs://${CID}${path}`, init));

beforeEach(async () => {
  gateway = await startFakeHttpNode({ prelude: answerProbe });
  stack = await loadExternalStack(gateway.origin);
});

afterEach(async () => {
  jest.useRealTimers();
  await stack.manager.stopIpfs();
  await gateway.close();
});

describe('ipfs: external gateway, Range over HTTP', () => {
  beforeEach(() => gateway.handle(rangeOrigin));

  test('serves from the fake gateway and dials nothing else', () => {
    expect(stack.manager.getNativeDiagnostics().externalGateway).toBe(gateway.origin);
    // Only the Kubo RPC version probe was kept off the network.
    expect(stack.refused).toEqual(['http://127.0.0.1:5001/api/v0/version']);
  });

  test('forwards Range and passes the 206 and its Content-Range through', async () => {
    const res = await ipfs('/video.mp4', { headers: { Range: 'bytes=100-199' } });

    expect(gateway.requests.map((r) => r.url)).toEqual([`/ipfs/${CID}/video.mp4`]);
    expect(gateway.requests[0].headers.range).toBe('bytes=100-199');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe(ETAG);
    // TODAY: the proxy drops every upstream Content-Length (it can't tell a
    // decoded body's length), so the 206 reaches Chromium without one.
    expect(res.headers.get('content-length')).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT.subarray(100, 200));
  });

  test('passes a 416 through with its Content-Range', async () => {
    const res = await ipfs('/video.mp4', { headers: { Range: 'bytes=5000-' } });

    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
    expect(gateway.requests).toHaveLength(1);
  });

  test('forwards If-Range: a matching validator keeps the 206, a stale one gets the whole 200', async () => {
    const fresh = await ipfs('/video.mp4', { headers: { Range: 'bytes=0-9', 'If-Range': ETAG } });
    expect(gateway.requests[0].headers['if-range']).toBe(ETAG);
    expect(fresh.status).toBe(206);
    expect(Buffer.from(await fresh.arrayBuffer())).toEqual(CONTENT.subarray(0, 10));

    const stale = await ipfs('/video.mp4', { headers: { Range: 'bytes=0-9', 'If-Range': '"x"' } });
    expect(gateway.requests[1].headers['if-range']).toBe('"x"');
    expect(stale.status).toBe(200);
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(CONTENT);
  });

  test('HEAD reaches the gateway as HEAD and comes back without a body', async () => {
    const res = await ipfs('/video.mp4', { method: 'HEAD' });

    expect(gateway.requests[0].method).toBe('HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('etag')).toBe(ETAG);
  });

  test('releases the in-flight handle and counts the bytes once a body is read', async () => {
    const res = await ipfs('/video.mp4');
    expect(stack.stats().active_native_handles).toBe(1);
    await res.arrayBuffer();
    expect(stack.stats()).toEqual({ active_native_handles: 0, bytes_read: CONTENT.length });
  });
});

describe('ipfs: external gateway, redirects over HTTP', () => {
  test("rewrites Kubo's directory redirect into ipfs: space and does not follow it", async () => {
    gateway.handle((_req, res) => {
      res.writeHead(301, { Location: `/ipfs/${CID}/docs/`, 'Content-Type': 'text/html' });
      res.end('<a href="/ipfs/x/docs/">Moved Permanently</a>.');
    });

    const res = await ipfs('/docs');

    expect(gateway.requests.map((r) => r.url)).toEqual([`/ipfs/${CID}/docs`]);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('./docs/');
    expect(new URL(res.headers.get('location'), `ipfs://${CID}/docs`).href).toBe(
      `ipfs://${CID}/docs/`
    );
    // TODAY: unlike bzz:, the external proxy streams a redirect's body on
    // rather than dropping it.
    await expect(res.text()).resolves.toBe('<a href="/ipfs/x/docs/">Moved Permanently</a>.');
  });

  test('leaves a cross-origin Location untouched', async () => {
    gateway.handle((_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:9/secret' });
      res.end();
    });

    const res = await ipfs('/x');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://127.0.0.1:9/secret');
    expect(gateway.requests).toHaveLength(1);
  });
});

describe('ipfs: external gateway, header policy over HTTP', () => {
  test('drops content-encoding and content-length for the body Node already decoded', async () => {
    const plain = Buffer.from('<!doctype html><p>' + 'decoded '.repeat(512) + '</p>');
    const gzipped = zlib.gzipSync(plain);
    gateway.handle((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Encoding': 'gzip',
        'Content-Length': gzipped.length,
      });
      res.end(gzipped);
    });

    // What the transport hands the proxy: the decoded body, still labelled
    // with the upstream encoding and its compressed length.
    const direct = await fetch(`${gateway.origin}/ipfs/${CID}/`);
    expect(direct.headers.get('content-encoding')).toBe('gzip');
    expect(Number(direct.headers.get('content-length'))).toBe(gzipped.length);
    expect(Buffer.from(await direct.arrayBuffer())).toEqual(plain);

    const res = await ipfs('/');

    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(plain);
  });

  test('drops hop-by-hop response headers', async () => {
    gateway.handle((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        Connection: 'keep-alive',
        'Keep-Alive': 'timeout=5',
        'Transfer-Encoding': 'chunked',
        'X-Ipfs-Path': `/ipfs/${CID}/`,
      });
      res.end('body');
    });

    const direct = await fetch(`${gateway.origin}/ipfs/${CID}/`);
    await direct.arrayBuffer();
    expect(direct.headers.get('keep-alive')).toBe('timeout=5');
    expect(direct.headers.get('transfer-encoding')).toBe('chunked');

    const res = await ipfs('/');

    for (const name of ['connection', 'keep-alive', 'transfer-encoding']) {
      expect([name, res.headers.get(name)]).toEqual([name, null]);
    }
    expect(res.headers.get('x-ipfs-path')).toBe(`/ipfs/${CID}/`);
    await expect(res.text()).resolves.toBe('body');
  });

  // O-12 (#439).
  test('strips Set-Cookie, Set-Cookie2 and Service-Worker-Allowed', async () => {
    gateway.handle((_req, res) => {
      res.setHeader('Set-Cookie', ['track=1; Path=/', 'other=2']);
      res.setHeader('Set-Cookie2', 'legacy=1');
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'public, max-age=29030400, immutable');
      res.end('page');
    });

    const res = await ipfs('/');

    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('set-cookie2')).toBeNull();
    expect(res.headers.get('service-worker-allowed')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=29030400, immutable');
    await expect(res.text()).resolves.toBe('page');
  });

  // A strip-list, not bzz:'s allowlist (design 0006, open question 3): page
  // identity, credentials and hop-by-hop headers go; everything else —
  // arbitrary custom headers included — reaches the gateway.
  test('forwards every request header but the strip-list', async () => {
    const res = await ipfs('/', {
      headers: {
        Accept: 'text/html',
        Range: 'bytes=0-1',
        'X-Custom': '1',
        'Swarm-Act': 'true',
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        Cookie: 'session=1',
        Origin: 'https://evil.example',
        Referer: 'https://evil.example/page',
        Host: 'evil.example',
        'Proxy-Authorization': 'Basic eA==',
        TE: 'trailers',
        Trailer: 'Expires',
        Upgrade: 'websocket',
      },
    });
    await res.arrayBuffer();
    const seen = gateway.requests[0].headers;

    expect(seen.accept).toBe('text/html');
    expect(seen.range).toBe('bytes=0-1');
    expect(seen['x-custom']).toBe('1');
    expect(seen['swarm-act']).toBe('true');
    expect(seen['content-type']).toBe('application/json');
    for (const name of [
      'authorization',
      'cookie',
      'origin',
      'referer',
      'proxy-authorization',
      'te',
      'trailer',
      'upgrade',
    ]) {
      expect([name, seen[name]]).toEqual([name, undefined]);
    }
    expect(seen.host).toBe(`127.0.0.1:${gateway.port}`);
  });

  // TODAY: the small-text navigation rule needs a Content-Length, and the
  // external proxy has already dropped it — so in external mode a small
  // extensionless text file always stays application/octet-stream (native
  // mode relabels it; see ipfs-protocol.native.test.js).
  test('TODAY: the small-text navigation rule never fires in external mode', async () => {
    const fixture = 'Hello from IPFS Gateway Checker\n';
    gateway.handle((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': Buffer.byteLength(fixture),
      });
      res.end(fixture);
    });

    const res = await ipfs('/', { headers: { Accept: NAVIGATION_ACCEPT } });

    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBeNull();
    await expect(res.text()).resolves.toBe(fixture);
  });
});

describe('ipfs: external gateway, cancel and errors over HTTP', () => {
  test('cancelling before the headers aborts the gateway request', async () => {
    gateway.handle(() => {}); // never answers
    const controller = new AbortController();

    const pending = ipfs('/x', { signal: controller.signal });
    await waitFor(() => gateway.requests.length === 1, {
      what: 'the request to reach the gateway',
    });
    controller.abort();
    const res = await pending;

    await waitFor(() => gateway.requests[0].closed, { what: 'the gateway request to be aborted' });
    expect(gateway.requests[0].aborted).toBe(true);
    expect(stack.stats().active_native_handles).toBe(0);
    // TODAY: the AbortError is rethrown by the manager and the protocol
    // handler turns it into a 502 carrying its message; nobody reads it.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'This operation was aborted' });
  });

  test('cancelling the body stops the gateway transfer and releases the handle', async () => {
    gateway.handle((_req, res, entry) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      streamBody(entry);
    });

    const res = await ipfs('/video.mp4');
    const reader = res.body.getReader();
    const first = await reader.read();
    await reader.cancel();

    await waitFor(() => gateway.requests[0].closed, { what: 'the gateway transfer to stop' });
    expect(gateway.requests[0].aborted).toBe(true);
    expect(stack.stats()).toEqual({
      active_native_handles: 0,
      bytes_read: first.value.byteLength,
    });
  });

  // Unlike bzz:, the request's signal is handed to the transport itself, so it
  // still reaches the body after the headers are in.
  test('aborting the request mid-body errors the stream and stops the gateway transfer', async () => {
    gateway.handle((_req, res, entry) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      streamBody(entry);
    });
    const controller = new AbortController();

    const res = await ipfs('/video.mp4', { signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    const { error } = await readUntilError(reader);

    expect(error?.name).toBe('AbortError');
    await waitFor(() => gateway.requests[0].closed, { what: 'the gateway transfer to stop' });
    expect(gateway.requests[0].aborted).toBe(true);
    expect(stack.stats().active_native_handles).toBe(0);
  });

  test('a gateway that dies mid-body errors the stream: truncated, not a short success', async () => {
    gateway.handle((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '100000',
      });
      res.write(Buffer.alloc(10_000, 0x61), () => req.socket.destroy());
    });

    const res = await ipfs('/file.bin');
    expect(res.status).toBe(200);
    const { bytes, error } = await readUntilError(res.body.getReader());

    expect(error?.name).toBe('TypeError');
    expect(error.message).toBe('terminated');
    expect(bytes).toBeLessThanOrEqual(10_000);
    expect(stack.stats().active_native_handles).toBe(0);
  });

  test('a paused reader holds the gateway back instead of buffering the body', async () => {
    const TOTAL = 64 * MIB;
    gateway.handle((_req, res, entry) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(TOTAL),
      });
      streamBody(entry, { total: TOTAL });
    });

    const res = await ipfs('/big.bin');
    const reader = res.body.getReader();
    const first = await reader.read();
    const sentWhilePaused = await waitUntilStable(() => gateway.requests[0].bytesSent);

    expect(sentWhilePaused).toBeLessThan(16 * MIB);
    let received = first.value.byteLength;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
    expect(received).toBe(TOTAL);
    expect(stack.stats()).toEqual({ active_native_handles: 0, bytes_read: TOTAL });
  });

  // TODAY: external mode has no deadline of its own — only the page's abort.
  test('TODAY: no deadline — a gateway that never answers is waited on indefinitely', async () => {
    gateway.handle(() => {}); // never answers
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    let settled = false;

    const pending = ipfs('/x').then((res) => {
      settled = true;
      return res;
    });
    await waitFor(() => gateway.requests.length === 1, {
      what: 'the request to reach the gateway',
    });
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await nextTurn(20);

    expect(settled).toBe(false);
    expect(gateway.requests[0].closed).toBe(false);
    gateway.requests[0].res.end('late');
    await expect((await pending).text()).resolves.toBe('late');
  });
});

describe('ipfs: external gateway not answering', () => {
  test('a gateway that was down at start leaves ipfs:// answering 503 at once', async () => {
    await stack.manager.stopIpfs();
    stack = await loadExternalStack(`http://127.0.0.1:${await closedLoopbackPort()}`);

    const res = await ipfs('/index.html');

    expect(res.status).toBe(503);
    // TODAY: the standby state is not "serving external", so the native
    // node's message answers.
    expect(await res.json()).toEqual({ code: 503, message: 'freedom-ipfs node is not running' });
  });
});

// O-3: a gateway-form URL never gets content under the gateway host's origin;
// the handler answers with a redirect to the canonical form before any
// backend is asked. A name host, by contrast, is resolved and then fetched.
describe('ipfs: URL forms through the registered handlers', () => {
  test.each([
    [
      'ipfs',
      `ipfs://localhost/ipfs/${CIDV0}/a/b.html?x=1`,
      `ipfs://${CIDV0_AS_BASE32}/a/b.html?x=1`,
    ],
    ['ipfs', 'ipfs://dweb.link/ipns/docs.ipfs.tech/install', 'ipns://docs.ipfs.tech/install'],
    ['ipns', `ipns://127.0.0.1:8080/ipfs/${CID}/`, `ipfs://${CID}/`],
  ])('%s: %s → 307 to %s', async (scheme, url, location) => {
    for (const method of ['GET', 'HEAD']) {
      const res = await stack[scheme](
        new Request(url, { method, headers: { Accept: NAVIGATION_ACCEPT } })
      );

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(location);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect([...res.headers.keys()].sort()).toEqual(['access-control-allow-origin', 'location']);
      expect(res.body).toBeNull();
    }
    expect(gateway.requests).toHaveLength(0);
    expect(stack.mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('a gateway-form URL with no canonical form is refused, not served', async () => {
    const res = await stack.ipfs(new Request(`ipfs://localhost/ipfs/${CIDV0.toLowerCase()}/`));

    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect((await res.json()).message).toMatch(/gateway-form ipfs URL has no canonical/);
    expect(gateway.requests).toHaveLength(0);
  });

  test('a name host is resolved, then fetched from the gateway under the resolved CID', async () => {
    stack.mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'ipfs',
      decoded: CID,
      uri: `ipfs://${CID}`,
    });
    gateway.handle(rangeOrigin);

    const res = await stack.ipfs(new Request('ipfs://vitalik.eth/video.mp4?t=1'));

    expect(stack.mockResolveEnsContent).toHaveBeenCalledWith('vitalik.eth');
    expect(gateway.requests.map((r) => r.url)).toEqual([`/ipfs/${CID}/video.mp4?t=1`]);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT);
  });
});
