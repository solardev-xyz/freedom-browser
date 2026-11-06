/**
 * Page loads through the real handler and the real freedom-cored at
 * protocol 2 (freedom-core design 0009, step 6): the core's `dweb.open`
 * plans a `{ verify }` plan for a backend whose verification is on, main
 * validates it and sends `dweb.verify`, the core asks main for each piece
 * (`shell.dweb_get`, dweb-shell.js) from a local fake node serving the
 * honest content of freedom-core's `vectors/dweb-verify.json`, and the page
 * gets the verified head and body, byte for byte; or the error page.
 *
 * Skipped unless FREEDOM_CORED_PATH names a core that speaks protocol 2 and
 * FREEDOM_CORE_DWEB_VECTORS names freedom-core's `vectors` directory, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored \
 *   FREEDOM_CORE_DWEB_VECTORS=…/freedom-core/vectors \
 *   npx jest src/main/dweb/dweb-verify.integration.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  SITE_A,
  SITE_V1,
  INDEX_HTML,
  content,
  honest,
  fakeNode,
  loopbackBackend,
} = require('../../../test/helpers/dweb-verify-world');

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
let mockDriver = null;
jest.mock('../core/naming', () => ({ namingDriver: () => mockDriver }));
let mockAdmission = null;
jest.mock('./fetch-admission', () => {
  const actual = jest.requireActual('./fetch-admission');
  return {
    ...actual,
    acquireDwebFetch: (request) => mockAdmission.acquire(request),
    fenceDwebSession: (partition) => mockAdmission.fence(partition),
  };
});

const { CoreClient } = require('../core/core-client');
const { NamingConfig } = require('../core/naming-config');
const { registerNamingShell } = require('../core/naming-shell');
const { NamingDriver } = require('../core/naming-driver');
const { registerDwebShell } = require('../core/dweb-shell');
const { attachDwebVerify, detachDwebVerify } = require('../core/dweb-verify');
const { handleDwebRequest } = require('./dweb-handler');
const { createFetchAdmission } = require('./fetch-admission');
const { STRICT_MESSAGE } = require('./verify-plan');
const log = require('../logger');

const binary = process.env.FREEDOM_CORED_PATH;
const vectorsDir = process.env.FREEDOM_CORE_DWEB_VECTORS;
const describeIfCore = binary && vectorsDir ? describe : describe.skip;
jest.setTimeout(30_000);

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
const NAVIGATION = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

function sources() {
  return {
    ens: {
      getEffectiveRpcEndpoints: () => ['https://a.rpc.example'],
      getDirectRpcCandidate: () => ({ url: null }),
      resolutionPolicy: () => ({ order: ['quorum'] }),
    },
    tezos: { getRpcEndpoints: () => ['https://t1.tez.example'] },
    registry: { getNetwork: () => ({ quorum: { k: 3, m: 2 } }), getEndpoints: () => [] },
    myotis: { isEnabled: () => false, isReady: () => false },
  };
}

describeIfCore('verified page loads with the real freedom-cored at protocol 2', () => {
  let root;
  let client;
  let shell;
  let verifier;
  let node;
  let world;

  beforeAll(() => {
    world = honest(vectorsDir);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAdmission = createFetchAdmission();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dweb-verify-'));
    node = await fakeNode(world);
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
    registerNamingShell(client, config, {
      hop: async () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }),
    });
    mockDriver = new NamingDriver({ client, config, normalize: (n) => n.toLowerCase() });
    shell = registerDwebShell(client, { log: quietLog });
    verifier = attachDwebVerify(client, shell, {
      log: quietLog,
      onSessionClosed: mockAdmission.onSessionClosed,
    });
    const hello = await client.start();
    expect(hello.protocol).toBe(2);
    expect(await config.whenReady()).toBe(true);
  });

  afterEach(async () => {
    detachDwebVerify();
    await client?.stop();
    await new Promise((resolve) => node.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ant = (url = node.url) => loopbackBackend({ ant: 'external', up: true, verify: true }, url);
  const gateway = (extra = {}, url = node.url) => ({
    ...loopbackBackend({ ipfs: 'gateway', up: true, verify: true }, url),
    ...extra,
  });
  const load = (url, backend, { init = {}, partition = null, onTrust } = {}) =>
    handleDwebRequest(new Request(url, init), { backend, partition, tag: '[dweb]', onTrust });

  test('Swarm: a navigation, a subresource and a seek, each verified byte for byte', async () => {
    const onTrust = jest.fn();
    const page = await load(`bzz://${SITE_A}/index.html`, ant(), {
      init: { headers: NAVIGATION },
      onTrust,
    });
    expect(page.status).toBe(200);
    expect(Buffer.from(await page.arrayBuffer()).equals(content('site-index', 300))).toBe(true);
    expect(onTrust).toHaveBeenCalledWith({ name: null, content: 'verified' });

    const style = await load(`bzz://${SITE_A}/style.css`, ant());
    expect(Number(style.headers.get('content-length'))).toBe(5000);
    expect(Buffer.from(await style.arrayBuffer()).equals(content('site-style', 5000))).toBe(true);

    const seek = await load(`bzz://${SITE_A}/style.css`, ant(), {
      init: { headers: { Range: 'bytes=100-199' } },
    });
    expect(seek.status).toBe(206);
    expect(seek.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect(
      Buffer.from(await seek.arrayBuffer()).equals(content('site-style', 5000).subarray(100, 200))
    ).toBe(true);

    const head = await load(`bzz://${SITE_A}/style.css`, ant(), { init: { method: 'HEAD' } });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();

    // Every piece one of the forms main admits; nothing fetched as /bzz.
    expect(node.asked.length).toBeGreaterThan(0);
    for (const asked of node.asked) expect(asked.url).toMatch(/^\/(chunks|bytes)\/[0-9a-f]{64}$/);
    // Every request ended: its slot, and its pieces' context.
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
    expect(shell.stats()).toEqual({ verifies: 0, pieces: 0 });
    expect(log.error).not.toHaveBeenCalled();
  });

  test("Swarm: a path the verified manifest doesn't hold is Ant's own 404, as content", async () => {
    const res = await load(`bzz://${SITE_A}/missing.html`, ant(), {
      init: { headers: NAVIGATION },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toMatch(/text\/html/);
    await res.arrayBuffer();
    expect(mockAdmission.stats().active).toBe(0);
  });

  test('IPFS: raw blocks, and a CAR the gateway does not serve falling back to them', async () => {
    for (const car of [false, true]) {
      node.asked.length = 0;
      const res = await load(`ipfs://${SITE_V1}/index.html`, gateway({ car }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
      expect(node.asked.filter(({ url }) => url.includes('format=car')).length).toBe(car ? 1 : 0);
    }
    expect(shell.stats()).toEqual({ verifies: 0, pieces: 0 });
  });

  test("the verifier's 8 KiB bound: a long IPFS query verifies; past it, the core's 414 or 431", async () => {
    // An IPFS query isn't counted: it only ties the plan to its URL.
    const query = `?${'q'.repeat(32_767)}`;
    const long = await load(`ipfs://${SITE_V1}/index.html${query}`, gateway());
    expect(long.status).toBe(200);
    expect(await long.text()).toBe(INDEX_HTML);
    // A path past it, a Swarm path and query together, a kept header.
    for (const [url, backend, headers, status, message] of [
      [
        `ipfs://${SITE_V1}/${'p'.repeat(8192)}`,
        gateway(),
        {},
        414,
        'request URL too long to verify',
      ],
      [
        `bzz://${SITE_A}/index.html?${'q'.repeat(8192)}`,
        ant(),
        {},
        414,
        'request URL too long to verify',
      ],
      [
        `bzz://${SITE_A}/style.css`,
        ant(),
        { Range: `bytes=${'0'.repeat(8186)}-` },
        431,
        'request header too large to verify',
      ],
    ]) {
      const res = await load(url, backend, { init: { headers } });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ code: status, message });
    }
    // Each an error plan main took: no refused plan, no core fault.
    expect(log.error).not.toHaveBeenCalled();
    expect(shell.stats()).toEqual({ verifies: 0, pieces: 0 });
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
  });

  // The members main captures from the setting and the probe
  // (ipfs-manager.js, bzz-protocol.js): a gateway the probe found without
  // raw blocks, and a node whose verification is off, get today's fetch.
  test('`unsupported`, and verification off: the core plans an unverified fetch', async () => {
    for (const ref of [
      { ipfs: 'gateway', up: true, unsupported: true },
      { ipfs: 'gateway', up: true },
    ]) {
      node.asked.length = 0;
      const res = await load(`ipfs://${SITE_V1}/index.html`, loopbackBackend(ref, node.url));
      // The fake node serves blocks only: the fetch's own 404, passed on.
      expect(res.status).toBe(404);
      await res.arrayBuffer();
      expect(node.asked.map(({ url }) => url)).toEqual([`/ipfs/${SITE_V1}/index.html`]);
    }
    const off = await load(
      `bzz://${SITE_A}/index.html`,
      loopbackBackend({ ant: 'external', up: true }, node.url)
    );
    expect(off.status).toBe(404);
    await off.arrayBuffer();
    expect(shell.stats()).toEqual({ verifies: 0, pieces: 0 });
    expect(mockAdmission.stats().active).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  // Strict mode (0009, Strict mode): the members main captures from the
  // profile's setting (bzz-protocol.js, ipfs-manager.js). The core plans each
  // unverified cause's 403 before anything is fetched, main takes it, and a
  // navigation gets the error page; verified content, and the verifier's
  // bound, are as without it.
  test("strict mode: the core's 403 for each unverified cause; verified content still loads", async () => {
    const strict = (ref) => loopbackBackend({ ...ref, strict: true }, node.url);
    // A secp256k1 peer ID: an IPNS name whose key type can't be verified.
    const secp256k1 = '16Uiu2HAmSWMwdVs6WACXRjGWiBRqkfBV1tFnL4yhAxscizU2PeRA';
    for (const [url, ref, message] of [
      [`bzz://${SITE_A}/index.html`, { ant: 'external', up: true }, STRICT_MESSAGE.off],
      [`ipfs://${SITE_V1}/index.html`, { ipfs: 'gateway', up: true }, STRICT_MESSAGE.off],
      [
        `ipfs://${SITE_V1}/index.html`,
        { ipfs: 'gateway', up: true, unsupported: true },
        STRICT_MESSAGE.unsupported,
      ],
      [
        'ipns://docs.example.org/',
        { ipfs: 'gateway', up: true, verify: true },
        STRICT_MESSAGE.dnslink,
      ],
      [`ipns://${secp256k1}/`, { ipfs: 'gateway', up: true, verify: true }, STRICT_MESSAGE.key],
      [
        `bzz://${SITE_A}${'a1b2'.repeat(16)}/`,
        { ant: 'external', up: true, verify: true },
        STRICT_MESSAGE.encrypted,
      ],
    ]) {
      const res = await load(url, strict(ref));
      expect([url, res.status]).toEqual([url, 403]);
      expect(await res.json()).toEqual({ code: 403, message });
    }
    expect(node.asked).toEqual([]);

    // A navigation: the error page, in plain words, with the core's text.
    const nav = await load(
      'ipns://docs.example.org/',
      strict({ ipfs: 'gateway', up: true, verify: true }),
      {
        init: { headers: NAVIGATION },
      }
    );
    expect(nav.status).toBe(403);
    expect(nav.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await nav.text();
    expect(html).toContain('<title>This profile loads only verified content</title>');
    expect(html).toContain('a DNSLink name, which Freedom can&#39;t verify');

    // Verified content loads, byte for byte, Swarm's and IPFS's.
    const swarm = await load(
      `bzz://${SITE_A}/index.html`,
      strict({ ant: 'external', up: true, verify: true })
    );
    expect(swarm.status).toBe(200);
    expect(Buffer.from(await swarm.arrayBuffer()).equals(content('site-index', 300))).toBe(true);
    const ipfs = await load(
      `ipfs://${SITE_V1}/index.html`,
      strict({ ipfs: 'gateway', up: true, verify: true })
    );
    expect(ipfs.status).toBe(200);
    expect(await ipfs.text()).toBe(INDEX_HTML);

    // Past the verifier's bound, still the 414.
    const long = await load(
      `ipfs://${SITE_V1}/${'p'.repeat(8192)}`,
      strict({ ipfs: 'gateway', up: true, verify: true })
    );
    expect(long.status).toBe(414);
    expect(await long.json()).toEqual({ code: 414, message: 'request URL too long to verify' });

    // Every plan one main took: no refused plan, no core fault.
    expect(log.error).not.toHaveBeenCalled();
    expect(shell.stats()).toEqual({ verifies: 0, pieces: 0 });
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test("a node that is down: the core's error plan, and the error page for a navigation", async () => {
    const down = await fakeNode(world);
    const downUrl = down.url;
    await new Promise((resolve) => down.server.close(resolve));
    const nav = await load(`ipfs://${SITE_V1}/index.html`, gateway({}, downUrl), {
      init: { headers: NAVIGATION },
    });
    expect(nav.status).toBeGreaterThanOrEqual(500);
    expect(nav.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(nav.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    );
    expect(await nav.text()).toContain('Try again');
    const sub = await load(`ipfs://${SITE_V1}/index.html`, gateway({}, downUrl));
    const json = await sub.json();
    expect(json).toEqual({ code: sub.status, message: expect.any(String) });
    // The connection is intact: main broke no rule.
    await expect(client.request('vault.status')).resolves.toMatchObject({ exists: false });
  });

  test('a private partition: its requests name it, and its close sends dweb.forget', async () => {
    const res = await load(`bzz://${SITE_A}/index.html`, ant(), { partition: 'private-1' });
    expect(Buffer.from(await res.arrayBuffer()).equals(content('site-index', 300))).toBe(true);
    const forget = jest.spyOn(verifier, 'forget');
    mockAdmission.closeSession('private-1');
    expect(forget).toHaveBeenCalledWith('private-1');
    await expect(forget.mock.results[0].value).resolves.toBe(true);
    // A closed partition plans nothing more.
    const after = await load(`bzz://${SITE_A}/index.html`, ant(), { partition: 'private-1' });
    expect(after.status).toBe(502);
  });
});
