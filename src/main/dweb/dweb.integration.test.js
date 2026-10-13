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

// Main's admission, one instance per case where a case needs its own bounds.
let mockAdmission = null;
jest.mock('./fetch-admission', () => {
  const actual = jest.requireActual('./fetch-admission');
  return {
    ...actual,
    acquireDwebFetch: (request) => mockAdmission.acquire(request),
    fenceDwebSession: (partition) => mockAdmission.fence(partition),
  };
});

const { handleBzzRequest } = require('../swarm/bzz-protocol');
const { handleRequest } = require('../ipfs/ipfs-protocol');
const { handleDwebRequest } = require('./dweb-handler');
const { createFetchAdmission } = require('./fetch-admission');
const { ShellError } = require('../core/core-client');
const { runWithPrivateLogContext } = require('../private/private-log-context');
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
    mockAdmission = createFetchAdmission();
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

// The recorded answers a quorum's lookup gets (freedom-core
// vectors/naming-replay.json, `quorum-agree`), beside the chain replay's.
function namingAnswers() {
  const file = process.env.FREEDOM_CORE_VECTORS
    ? path.join(path.dirname(process.env.FREEDOM_CORE_VECTORS), 'naming-replay.json')
    : null;
  if (!file || !fs.existsSync(file)) return null;
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8')).scenarios.find(
    (entry) => entry.id === 'quorum-agree'
  );
  const answers = new Map();
  for (const io of scenario?.io || []) {
    if (io.method && typeof io.answer?.body === 'string' && !answers.has(io.method)) {
      answers.set(io.method, io.answer.body);
    }
  }
  return answers;
}

const recorded = binary && servesDweb(binary) ? namingAnswers() : null;
const describeIfResolving = recorded ? describe : describe.skip;

/** The Universal Resolver's answer for a name whose contenthash is `bzz://<hash>`. */
function resolverAnswer(hash) {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const content = `e40101fa011b20${hash}`;
  const pad = (64 - (content.length % 64)) % 64;
  const inner = word(32) + word(content.length / 2) + content + '0'.repeat(pad);
  const resolver = '22'.repeat(20).padStart(64, '0');
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: `0x${word(64)}${resolver}${word(inner.length / 2)}${inner}`,
  });
}

// The real core resolving names over scripted RPCs, main's lifetime around
// each request: a private window's close, the page's abort and the core's
// end reach a request wherever it is, and the plan is used in the turn it
// is judged.
describeIfResolving('dweb requests over names the real core resolves', () => {
  const NAME_HASH = 'ab'.repeat(32);
  const OTHER_HASH = 'cd'.repeat(32);
  let root;
  let client;
  let config;
  let rpc;
  let dials;
  let backend;
  // What each case holds, released in afterEach whatever happened, so a
  // failure stays in its case and nothing keeps Jest alive: the requests it
  // started (aborted), the slots it took and the RPCs it held.
  let lives;
  let slots;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAdmission = createFetchAdmission();
    lives = [];
    slots = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dweb-names-'));
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
    endpoints = RPC;
    config = new NamingConfig({ client, sources: sources(), log: quietLog });
    rpc = { hash: NAME_HASH, hold: false, held: [] };
    client.handle('shell.rpc', async (params, context) => {
      const { method } = JSON.parse(params.body);
      const answer = () => ({
        status: 200,
        body: Buffer.from(
          method === 'eth_call' ? resolverAnswer(rpc.hash) : recorded.get(method)
        ).toString('base64'),
      });
      if (!rpc.hold) return answer();
      return new Promise((resolve, reject) => {
        rpc.held.push({ context, release: () => resolve(answer()) });
        context.signal.addEventListener('abort', () => reject(new ShellError('cancelled')), {
          once: true,
        });
      });
    });
    client.handle('shell.prefetch', async () => ({}));
    client.handle('shell.tezos', async () => {
      throw new ShellError('network');
    });
    mockDriver = new NamingDriver({ client, config, normalize: (n) => n.toLowerCase() });
    await client.start();
    expect(await config.whenReady()).toBe(true);
    dials = [];
    backend = {
      ref: { ant: 'bundled', up: true },
      url: 'http://127.0.0.1:1633',
      request: async (init) => {
        dials.push({
          path: init.path,
          pending: config.core?.pending,
          serving: client.serves(client.current),
        });
        return new Response('content');
      },
    };
  });
  afterEach(async () => {
    for (const life of lives) life.abort();
    for (const slot of slots) slot.release();
    for (const entry of rpc?.held || []) entry.release();
    await client?.stop();
    mockAdmission = createFetchAdmission();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A request, which afterEach aborts if the case leaves it running. */
  const handle = (url, options = {}) => {
    const life = new AbortController();
    lives.push(life);
    const signal = options.signal ? AbortSignal.any([options.signal, life.signal]) : life.signal;
    return handleDwebRequest(new Request(url, { signal }), {
      backend,
      partition: options.partition ?? null,
      tag: '[bzz-protocol]',
    });
  };
  /** A one-slot admission whose slot this case holds. */
  async function holdTheOnlySlot() {
    mockAdmission = createFetchAdmission({ maxActive: 1, maxWaiting: 1 });
    const slot = await mockAdmission.acquire();
    slots.push(slot);
    return slot;
  }
  /** Waits, in wall-clock time, for daemon work main can only observe. */
  async function until(predicate, what, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const plansSent = (sent) => sent.mock.calls.filter(([, method]) => method === 'dweb.open');

  test('a name resolves to its plan, and the plan is dialled', async () => {
    const res = await handle('bzz://site.eth/index.html');
    expect(res.status).toBe(200);
    expect(dials.map((dial) => dial.path)).toEqual([`/bzz/${NAME_HASH}/index.html`]);
  });

  test("a private window's close during a re-plan held in its slot cancels it and frees the slot", async () => {
    const held = await holdTheOnlySlot();
    const sent = jest.spyOn(client, 'requestTo');
    const pending = runWithPrivateLogContext(true, () =>
      handle('bzz://site.eth/index.html', { partition: 'private-real' })
    );
    await until(() => mockAdmission.stats().waiting === 1, 'the plan to wait for its slot');
    // A provider reset while the plan waits: once admitted, it is overtaken.
    rpc.hash = OTHER_HASH;
    await config.configure({ reset: true });
    rpc.hold = true;
    held.release();
    await until(() => rpc.held.length > 0, "the lookup's RPCs");
    expect(plansSent(sent).map(([, , params]) => params.attempts_used)).toEqual([undefined, 1]);
    expect(plansSent(sent).map(([, , params]) => params.private)).toEqual([true, true]);

    mockAdmission.closeSession('private-real');
    const res = await pending;

    // Cancelled at once, not answered by the lookup's own timeout.
    expect(await res.json()).toEqual({ code: 502, message: 'Cancelled' });
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
    expect(dials).toHaveLength(0);
    // The core was told: it detached the request and answered it (its
    // lookup's session runs on, as design 0004 has it, bounded by naming's
    // own deadline and admission).
    await until(() => client.current.pending.size === 0, 'the core to answer the cancel');
    // Another session's fetch gets the slot.
    (await mockAdmission.acquire()).release();
    for (const entry of rpc.held) entry.release();
  });

  test("the page's abort cancels the core's dweb.open and dials nothing", async () => {
    rpc.hold = true;
    const page = new AbortController();
    const pending = handle('bzz://cancel.eth/', { signal: page.signal });
    await until(() => rpc.held.length > 0, "the lookup's RPCs");
    page.abort();
    const res = await pending;
    expect(res.status).toBe(502);
    await until(() => client.current.pending.size === 0, 'the core to answer the cancel');
    expect(dials).toHaveLength(0);
    expect(mockAdmission.stats().active).toBe(0);
  });

  test('a configuration change asked in the turn after the final judgment comes after the dial', async () => {
    let admitted = false;
    const acquire = mockAdmission.acquire;
    mockAdmission.acquire = async (request) => {
      const slot = await acquire(request);
      admitted = true;
      return slot;
    };
    const idle = config.idle.bind(config);
    let control = null;
    config.idle = (gen) => {
      const quiet = idle(gen);
      if (quiet && admitted && !control) {
        control = Promise.resolve().then(() => {
          rpc.hash = OTHER_HASH;
          return config.configure({ reset: true });
        });
      }
      return quiet;
    };
    const res = await handle('bzz://site.eth/index.html');
    await control;
    expect(res.status).toBe(200);
    // Used in the turn it was judged: before the control, on what was current.
    expect(dials).toEqual([{ path: `/bzz/${NAME_HASH}/index.html`, pending: 0, serving: true }]);
  });

  test('a core that ended while the plan waited for its slot is a 503, never dialled', async () => {
    const held = await holdTheOnlySlot();
    const pending = handle('bzz://site.eth/index.html');
    await until(() => mockAdmission.stats().waiting === 1, 'the plan to wait for its slot');
    // Fenced off before its exit is delivered.
    client.end(client.current, 'protocol');
    held.release();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(dials).toHaveLength(0);
  });
});
