/**
 * @jest-environment node
 */
// Drives the real @synonymdev/pubky package (no module mock) against
// loopback fixtures: its load-time side effect on `globalThis.fetch` and the
// guard every SDK dial goes through. No network: `client.fetch` takes raw
// http(s) URLs, and the test policy allows `http:` so a loopback fixture can
// stand in for a homeserver.
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const http = require('node:http');

const fixtures = [];
function startFixture(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url, cookie: req.headers.cookie || null });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      fixtures.push(server);
      resolve({ base: `http://127.0.0.1:${server.address().port}`, hits });
    });
  });
}

afterAll(() => Promise.all(fixtures.map((s) => new Promise((r) => s.close(r)))));

const PUBLIC_FOR_TEST = Object.freeze({
  protocols: ['https:', 'http:'],
  isPublicAddress: () => true,
});
const DEFAULT_WITH_HTTP = (isPublicAddress) =>
  Object.freeze({ protocols: ['https:', 'http:'], isPublicAddress });

let pubky;
let fetchBeforeLoad;

beforeAll(() => {
  fetchBeforeLoad = globalThis.fetch;
  pubky = require('./pubky-protocol');
  pubky.loadSdk();
});

describe('loading the real SDK', () => {
  test('does not leave a cookie jar on the process-wide fetch', async () => {
    // The package's index.cjs runs `globalThis.fetch = makeFetchCookie(fetch)`.
    const { base, hits } = await startFixture((req, res) => {
      res.setHeader('Set-Cookie', 'track=abc; Path=/');
      res.end('ok');
    });
    await (await fetch(`${base}/set`)).text();
    await (await fetch(`${base}/again`)).text();
    expect(hits.map((h) => h.cookie)).toEqual([null, null]);
  });

  test('an outside caller reaches the original fetch with the same arguments', async () => {
    const seen = [];
    const original = fetchBeforeLoad;
    // The router captured the pre-SDK fetch; call through it and check the
    // arguments arrive untouched (no redirect override, no guard).
    const { base, hits } = await startFixture((req, res) => {
      if (req.url === '/hop') {
        res.statusCode = 302;
        res.setHeader('Location', '/landed');
        res.end();
      } else res.end('landed');
    });
    const res = await fetch(`${base}/hop`, { headers: { 'x-probe': '1' } });
    seen.push(res.status, res.redirected, await res.text());
    expect(seen).toEqual([200, true, 'landed']);
    expect(hits.map((h) => h.url)).toEqual(['/hop', '/landed']);
    expect(typeof original).toBe('function');
  });
});

// The SDK wraps a refused dial in its own RequestError, so these assert a
// rejection plus what the fixtures actually saw.
describe('guardedSdkFetch', () => {
  test('serves a file from an allowed homeserver', async () => {
    const { base } = await startFixture((req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end('public file');
    });
    const res = await pubky.guardedSdkFetch(
      `${base}/pub/file.txt`,
      { method: 'GET' },
      PUBLIC_FOR_TEST
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('public file');
  });

  test('passes a homeserver 404 through', async () => {
    const { base } = await startFixture((req, res) => {
      res.statusCode = 404;
      res.end('missing');
    });
    const res = await pubky.guardedSdkFetch(`${base}/pub/nope`, { method: 'GET' }, PUBLIC_FOR_TEST);
    expect(res.status).toBe(404);
  });

  test('never follows a homeserver redirect', async () => {
    const target = await startFixture((req, res) => res.end('loopback secret'));
    const homeserver = await startFixture((req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `${target.base}/secret`);
      res.end();
    });
    await expect(
      pubky.guardedSdkFetch(`${homeserver.base}/pub/x`, { method: 'GET' }, PUBLIC_FOR_TEST)
    ).rejects.toThrow();
    expect(homeserver.hits).toHaveLength(1);
    expect(target.hits).toHaveLength(0);
  });

  test('refuses a homeserver on a loopback address', async () => {
    const { base, hits } = await startFixture((req, res) => res.end('local service'));
    await expect(
      pubky.guardedSdkFetch(
        `${base}/pub/x`,
        { method: 'GET' },
        DEFAULT_WITH_HTTP(pubky.isPublicAddress)
      )
    ).rejects.toThrow();
    expect(hits).toHaveLength(0);
  });

  test('refuses a homeserver whose name resolves to loopback', async () => {
    const { base, hits } = await startFixture((req, res) => res.end('local service'));
    const viaName = base.replace('127.0.0.1', 'localhost');
    await expect(
      pubky.guardedSdkFetch(
        `${viaName}/pub/x`,
        { method: 'GET' },
        DEFAULT_WITH_HTTP(pubky.isPublicAddress)
      )
    ).rejects.toThrow();
    expect(hits).toHaveLength(0);
  });

  test('refuses plain http under the default policy', async () => {
    const { base, hits } = await startFixture((req, res) => res.end('x'));
    await expect(
      pubky.guardedSdkFetch(
        `${base}/pub/x`,
        { method: 'GET' },
        { protocols: ['https:'], isPublicAddress: () => true }
      )
    ).rejects.toThrow();
    expect(hits).toHaveLength(0);
  });
});

describe('isPublicAddress', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fe80::1',
    'fd00::1',
    '64:ff9b::a00:1',
    '64:ff9b::192.168.0.1',
    '2002:7f00:1::1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(pubky.isPublicAddress(address)).toBe(false);
  });

  test.each(['1.1.1.1', '93.184.215.14', '2606:4700:4700::1111', '64:ff9b::101:101'])(
    'allows %s',
    (address) => {
      expect(pubky.isPublicAddress(address)).toBe(true);
    }
  );
});
