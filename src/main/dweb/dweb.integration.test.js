/**
 * The `bzz:`, `ipfs:` and `ipns:` handlers against the real freedom-cored
 * (freedom-core design 0006, implementation step 4): each request is planned
 * by the core's `dweb.open` through main's naming driver, checked by main's
 * validation, and executed against a fake Ant over loopback HTTP or an
 * injected native request function.
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build that serves
 * `dweb.open` (the pinned v0.4.0 doesn't), e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/dweb
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CoreClient } = require('../core/core-client');
const { NamingConfig } = require('../core/naming-config');
const { registerNamingShell } = require('../core/naming-shell');
const { registerNamingVerified } = require('../core/naming-verified');
const { NamingDriver } = require('../core/naming-driver');
const { servesDweb } = require('../../../test/helpers/core-chain-probe');
const {
  rangeResponder,
  readAll,
  startFakeHttpNode,
} = require('../../../test/helpers/fake-http-node');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({
  ...jest.requireActual('../ipfs/gateway-transport'),
  netGatewayFetch: jest.fn(),
}));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

let mockAntUrl = null;
jest.mock('../service-registry', () => ({
  ...jest.requireActual('../service-registry'),
  getAntApiUrl: () => mockAntUrl,
  getService: () => ({ mode: 'bundled' }),
}));

let mockDriver = null;
jest.mock('../core/naming', () => ({ namingDriver: () => mockDriver }));

const { handleBzzRequest } = require('../swarm/bzz-protocol');
const { handleRequest } = require('../ipfs/ipfs-protocol');
const log = require('../logger');

const binary = process.env.FREEDOM_CORED_PATH;
const describeIfDweb = binary && servesDweb(binary) ? describe : describe.skip;
// A real core plans on real timers.
jest.setTimeout(20_000);

const quietLog = { info() {}, warn() {}, error() {} };
const RPC = ['https://a.rpc.example', 'https://b.rpc.example', 'https://c.rpc.example'];
const HASH = 'ab'.repeat(32);
const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CIDV0_AS_BASE32 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34';
const CONTENT = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const NAVIGATION_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8';

let endpoints = RPC;
function sources() {
  return {
    ens: {
      getEffectiveRpcEndpoints: () => endpoints,
      getDirectRpcCandidate: () => ({ url: null }),
      resolutionPolicy: () => ({ order: ['quorum'] }),
    },
    tezos: { getRpcEndpoints: () => ['https://t1.tez.example'] },
    registry: { getNetwork: () => ({ quorum: { k: 3, m: 2 } }), getEndpoints: () => [] },
    myotis: { isEnabled: () => false, isReady: () => false },
  };
}

// Every RPC endpoint fails: a name's lookup ends in today's error.
const failing = jest.fn(async () => ({
  status: 500,
  headers: {},
  body: Buffer.from('{"error":"down"}'),
}));

describeIfDweb('the dweb handlers with the real freedom-cored', () => {
  let root;
  let client;
  let ant;

  beforeEach(async () => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dweb-'));
    endpoints = RPC;
    ant = await startFakeHttpNode();
    mockAntUrl = ant.origin;
  });
  afterEach(async () => {
    await client?.stop();
    await ant.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function start(hop = failing) {
    client = new CoreClient({
      spawn,
      command: binary,
      args: [
        'serve',
        '--data-dir',
        path.join(root, 'identity'),
        '--lock-dir',
        path.join(root, 'locks'),
        '--parent-pid',
        String(process.pid),
      ],
      log: quietLog,
      shellVersion: 'jest',
    });
    const config = new NamingConfig({ client, sources: sources(), log: quietLog });
    registerNamingShell(client, config, { hop });
    registerNamingVerified(client, config, { adapters: {} });
    mockDriver = new NamingDriver({ client, config, normalize: (n) => n.toLowerCase() });
    await client.start();
    expect(await config.whenReady()).toBe(true);
    return { config };
  }

  test("a hash host: the core's plan, checked and executed against the Ant", async () => {
    await start();
    ant.handle((req, res) => {
      res.setHeader('Set-Cookie', 'track=1');
      rangeResponder({ content: CONTENT, etag: '"v1"', contentType: 'video/mp4' })(req, res);
    });

    const res = await handleBzzRequest(
      new Request(`bzz://${HASH}/video.mp4?t=1`, {
        headers: { Range: 'bytes=100-199', Cookie: 'session=1', 'X-Custom': '1' },
      })
    );

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT.subarray(100, 200));
    const [seen] = ant.requests;
    expect(seen.url).toBe(`/bzz/${HASH}/video.mp4?t=1`);
    // The core's allowlist and Swarm's retrieval hints.
    expect(seen.headers.range).toBe('bytes=100-199');
    expect(seen.headers['swarm-chunk-retrieval-timeout']).toBe('30s');
    expect(seen.headers['swarm-redundancy-strategy']).toBe('3');
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['x-custom']).toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
  });

  test("the core's 405 and 400 are answered without a dial", async () => {
    await start();
    const post = await handleBzzRequest(new Request(`bzz://${HASH}/x`, { method: 'POST' }));
    expect(post.status).toBe(405);
    const encoded = await handleBzzRequest(new Request(`bzz://${HASH}/..%2F..%2Fstamps`));
    expect(encoded.status).toBe(400);
    expect(await encoded.json()).toEqual({ code: 400, message: 'invalid bzz path' });
    expect(ant.requests).toHaveLength(0);
  });

  test("an Ant that isn't up is the core's 503, before any name is resolved", async () => {
    await start();
    mockAntUrl = null;
    const res = await handleBzzRequest(new Request('bzz://vitalik.eth/'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 503, message: 'Swarm node is not ready' });
    expect(failing).not.toHaveBeenCalled();
  });

  test("a name host is resolved in the core: every endpoint failing is today's 502", async () => {
    await start();
    const res = await handleBzzRequest(new Request('bzz://vitalik.eth/'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      code: 502,
      message: 'ENS resolver error: Single-provider anchor fetch failed: could not read the head',
    });
    expect(failing).toHaveBeenCalled();
    expect(ant.requests).toHaveLength(0);
  });

  test('a lookup a configuration change overtook is planned again with attempts_used', async () => {
    let held = null;
    const hop = jest.fn((url, init) => {
      if (!held) {
        return new Promise((resolve, reject) => {
          held = resolve;
          init.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      }
      return failing(url, init);
    });
    const { config } = await start(hop);
    const sent = jest.spyOn(client, 'requestTo');
    const pending = handleBzzRequest(new Request('bzz://nick.eth/'));
    while (!held) await new Promise(setImmediate);
    const before = config.generations.ens;
    endpoints = [...RPC.slice(1), 'https://d.rpc.example'];
    await config.configure({ reset: true });
    expect(config.generations.ens).toBeGreaterThan(before);
    held(await failing());
    const res = await pending;
    expect(res.status).toBe(502);
    const plans = sent.mock.calls.filter(([, method]) => method === 'dweb.open');
    expect(plans.map(([, , params]) => params.attempts_used)).toEqual([undefined, 1]);
    expect(plans.map(([, , , context]) => context)).toEqual([
      { caller: 'shell' },
      { caller: 'shell' },
    ]);
  });

  test("a gateway-form ipfs: URL gets the core's 307, which main's validation accepts", async () => {
    await start();
    const requestImpl = jest.fn();
    const res = await handleRequest(
      'ipfs',
      new Request(`ipfs://localhost/ipfs/${CIDV0}/a/b.html?x=1`),
      { requestImpl }
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`ipfs://${CIDV0_AS_BASE32}/a/b.html?x=1`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(requestImpl).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  test('a CIDv0 host is planned in base32, and a navigation to small text relabelled', async () => {
    await start();
    const requestImpl = jest.fn(
      async () =>
        new Response('hello from ipfs\n', {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': '16',
            'set-cookie': 'a=1',
          },
        })
    );
    const res = await handleRequest(
      'ipfs',
      new Request(`ipfs://${CIDV0}/`, { headers: { Accept: NAVIGATION_ACCEPT, Cookie: 'x=1' } }),
      { requestImpl }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await readAll(res.body)).toString()).toBe('hello from ipfs\n');
    const [init] = requestImpl.mock.calls[0];
    expect(init.path).toBe(`/ipfs/${CIDV0_AS_BASE32}/`);
    expect(init.headersTimeoutMs).toBe(30_000);
    // The core's strip-list.
    expect(init.headers.get('cookie')).toBeNull();
    expect(init.headers.get('accept')).toBe(NAVIGATION_ACCEPT);
  });

  test('an IPNS DNSLink host reaches the node as /ipns/<host>', async () => {
    await start();
    const requestImpl = jest.fn(async () => new Response('ipns page'));
    const res = await handleRequest('ipns', new Request('ipns://docs.ipfs.tech/install?x=1'), {
      requestImpl,
    });
    await expect(res.text()).resolves.toBe('ipns page');
    expect(requestImpl.mock.calls[0][0].path).toBe('/ipns/docs.ipfs.tech/install?x=1');
  });
});
