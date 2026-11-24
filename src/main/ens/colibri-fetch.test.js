/**
 * The `shell.colibri_fetch` executor (`colibri-fetch.js`, freedom-core
 * design 0014, "Main's fetches"), against loopback HTTP servers: each
 * server of a type's table answers on its own path of one local origin
 * (the transport maps `https://<host>/<path>` there), and the prover is a
 * loopback URL. The body cases run through a two-way ServiceClient to
 * `test/helpers/fake-colibrid.js`, which takes main's head and body as
 * freedom-colibrid does; each also checks that the reservation is given
 * back and that credit, cancels and other requests' frames go on.
 *
 * - every case of design 0014's "Bodies": no Content-Length, one too large
 *   and one that lies low, gzip and brotli bodies inflating past the
 *   maximum, a chunked body, an endless one, one trickling until the
 *   deadline, a cancel mid-body and one mid-stream, the pool exhausted by
 *   parallel fetches while control frames flow, a body shorter than its
 *   declared length;
 * - the order of the servers, `exclude_mask` and the head's `node`;
 * - the request main builds (verb, headers, payload), and refusals;
 * - the error texts, as `fetch_from_servers` writes them;
 * - redirects: the same-variant GET followed, at most three, and every
 *   refusal (another origin, a downgrade, another variant or field, a
 *   POST's, another 3xx).
 *
 * The session itself (its proxy, Tor's PAC, Chromium's decoding) is
 * checked from a real Electron process in
 * `src/main/__tests__/integration/colibri-fetch-proxy.test.js`.
 */

const http = require('http');
const zlib = require('zlib');
const { ServiceClient, StreamedReply } = require('../core/service-client');
const { WINDOW } = require('../core/frame');
const { makeHop } = require('../core/naming-shell');
const { fakeColibrid, testService } = require('../../../test/helpers/fake-colibrid');
const {
  COLIBRI_FETCH_TEXTS,
  MAX_ERROR_UNITS,
  REFUSALS_LOGGED,
  bodyStream,
  colibriFetchHandler,
  cutUnits,
  errorText,
  ownedPieces,
} = require('./colibri-fetch');
const { COLIBRI_FETCH_POOL_BYTES, ColibriFetchPool } = require('./colibri-fetch-pool');
const { COLIBRI_PACKAGE_SERVERS } = require('./colibri-servers');

const KIB = 1024;
const MIB = 1024 * KIB;
const TX = '0x0c13128da2c6f7cb51c325950d65aabd14dd6b556746a9cdf3be566566bf7699';
const ROOT = '0x29a83bd86e77b1cae82c5928dd781ae3a387166d6c574999679ed1aedafe27b2';
const OTHER_ROOT = `0x${'11'.repeat(32)}`;
const FINALITY = 'eth/v1/beacon/states/head/finality_checkpoints';
const BLOCK_NUMBER = Object.freeze({ method: 'eth_blockNumber', params: [], version: 196611 });
/** A chain outside the package's lists: every type's servers are the
 * prover alone. */
const LONE = 7777;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, what, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 5) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Bytes `0..n` of a recognisable body. */
function bytes(n, seed = 1) {
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = (seed + i) % 251;
  return out;
}

async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(Buffer.from(value));
  }
}

/**
 * The local origin. A request's first path segment names the server it
 * stands for (a table host, or `prover`); `healthy` always answers a small
 * JSON body. Every request is recorded (`seen`), and every response torn
 * down before its end (`torn`, by path). `route(req, res, { site, rest })`
 * answers the rest.
 */
async function startOrigin() {
  const upstream = { seen: [], torn: [], timers: new Set(), route: null };
  upstream.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const [, site, ...parts] = req.url.split('/');
      const entry = {
        method: req.method,
        url: req.url,
        site,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      upstream.seen.push(entry);
      res.on('close', () => {
        if (!res.writableFinished) upstream.torn.push(req.url);
      });
      if (site === 'healthy') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"data":"ok"}');
        return;
      }
      upstream.route(req, res, { site, rest: parts.join('/') });
    });
  });
  await new Promise((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
  upstream.url = `http://127.0.0.1:${upstream.server.address().port}`;
  upstream.close = () =>
    new Promise((resolve) => {
      for (const timer of upstream.timers) clearInterval(timer);
      upstream.server.closeAllConnections();
      upstream.server.close(resolve);
    });
  /** Writes `chunk` every `ms` until the response closes. */
  upstream.every = (res, ms, chunk) => {
    const timer = setInterval(() => res.write(chunk), ms);
    upstream.timers.add(timer);
    res.on('close', () => {
      clearInterval(timer);
      upstream.timers.delete(timer);
    });
  };
  return upstream;
}

/**
 * The session's stand-in: Node's fetch (which decodes gzip and brotli, as
 * Chromium does), with every non-loopback URL mapped to its path on the
 * origin. `dialled` lists the URLs main asked for, as it asked.
 */
function transportTo(upstream) {
  const dialled = [];
  const fetchOnOrigin = (url, init) => {
    dialled.push({ url, method: init.method, headers: init.headers, body: init.body });
    const parsed = new URL(url);
    const target =
      parsed.hostname === '127.0.0.1'
        ? url
        : `${upstream.url}/${parsed.host}${parsed.pathname}${parsed.search}`;
    return fetch(target, init);
  };
  return { fetch: fetchOnOrigin, dialled };
}

let upstream;
let transport;
let operations;
let pool;
let log;
let handler;
let nextId;

beforeEach(async () => {
  upstream = await startOrigin();
  transport = transportTo(upstream);
  operations = new Map();
  pool = new ColibriFetchPool();
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  handler = colibriFetchHandler({
    operations,
    pool,
    hop: makeHop({ fetch: transport.fetch }),
    log,
  });
  nextId = 1;
});

afterEach(async () => {
  await upstream.close();
});

/** A `colibri.request` main has open, in the registry. */
function open(method, params, { chain = LONE, zk = false, prover, deadlineMs = 10_000 } = {}) {
  const op = {
    kind: 'request',
    id: nextId++,
    chain,
    method,
    params: JSON.stringify(params),
    zk,
    prover: prover ?? `${upstream.url}/prover`,
    deadlineAt: Date.now() + deadlineMs,
  };
  operations.set(op.id, op);
  return op;
}

const blockNumberOp = (options) => open('eth_blockNumber', [], options);
const txOp = (options) => open('eth_getTransactionByHash', [TX], options);

/** The fetches the tests make, as the service sends them. */
const blockNumber = (op, extra = {}) => ({
  request: op.id,
  type: 'prover',
  method: 'post',
  path: '',
  payload: { ...BLOCK_NUMBER },
  accept: 'ssz',
  exclude_mask: 0,
  ...extra,
});
const finality = (op, extra = {}) => ({
  request: op.id,
  type: 'checkpointz',
  method: 'get',
  path: FINALITY,
  accept: 'json',
  exclude_mask: 0,
  ...extra,
});
const bootstrap = (op, root = ROOT, extra = {}) => ({
  request: op.id,
  type: 'beacon_api',
  method: 'get',
  path: `eth/v1/beacon/light_client/bootstrap/${root}`,
  accept: 'ssz',
  exclude_mask: 0,
  ...extra,
});
const txCache = (op, extra = {}) => ({
  request: op.id,
  type: 'prover',
  method: 'get',
  path: 'tx_cache?max_blocks=256',
  accept: 'ssz',
  exclude_mask: 0,
  max_age: op.chain === 100 ? 2 : 6,
  ...extra,
});

/** One call of the handler: the head and the body read whole, or its
 * error result. */
async function call(params, { signal = new AbortController().signal } = {}) {
  const result = await handler(params, { signal, generation: 1 });
  if (!(result instanceof StreamedReply)) return result;
  return { head: result.result, body: await readAll(result.body) };
}

/** The table's servers for chain 100's `checkpointz`, then the prover's
 * site: the order `handle_request` gives them. */
function gnosisCheckpointzSites() {
  const lists = COLIBRI_PACKAGE_SERVERS[100];
  return [...lists.checkpointz, ...lists.beacon_apis]
    .map((url) => new URL(url).host)
    .concat('prover');
}

describe('the request main builds, and the servers in turn', () => {
  test("a prover POST: the variant's verb, Accept, a JSON Content-Type, the payload as parsed and written again, no Cache-Control", async () => {
    const op = blockNumberOp();
    upstream.route = (req, res) => res.end(bytes(1000));

    const answer = await call(blockNumber(op));

    expect(answer).toEqual({ head: { node: 0, bytes: 1000 }, body: bytes(1000) });
    expect(upstream.seen).toHaveLength(1);
    const [seen] = upstream.seen;
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/prover');
    expect(seen.headers.accept).toBe('application/octet-stream');
    expect(seen.headers['content-type']).toBe('application/json');
    expect(seen.headers['cache-control']).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.body).toBe(JSON.stringify(BLOCK_NUMBER));
    expect(pool.held).toBe(0);
  });

  test("a GET with the variant's max-age: Cache-Control, no Content-Type, no body; JSON's Accept for a json variant", async () => {
    upstream.route = (req, res) => res.end('{}');

    await call(txCache(txOp({ chain: 1 })));
    await call(txCache(txOp({ chain: 100 })));
    await call(finality(blockNumberOp()));

    const [mainnet, gnosis, json] = upstream.seen;
    expect(mainnet).toMatchObject({
      method: 'GET',
      url: '/prover/tx_cache?max_blocks=256',
      body: '',
    });
    expect(mainnet.headers).toMatchObject({
      accept: 'application/octet-stream',
      'cache-control': 'max-age=6',
    });
    expect(mainnet.headers['content-type']).toBeUndefined();
    expect(gnosis.headers['cache-control']).toBe('max-age=2');
    expect(json.headers.accept).toBe('application/json');
    expect(json.headers['cache-control']).toBeUndefined();
  });

  test('servers in turn: the first success wins, and its index in the full list is the node', async () => {
    const sites = gnosisCheckpointzSites();
    expect(sites).toHaveLength(5);
    upstream.route = (req, res, { site }) => {
      if (site === sites[0]) {
        res.writeHead(503);
        res.end('busy');
      } else if (site === sites[1]) {
        req.socket.destroy();
      } else {
        res.end('{"data":"answer"}');
      }
    };

    const answer = await call(finality(blockNumberOp({ chain: 100 })));

    expect(answer.head).toEqual({ node: 2, bytes: 17 });
    expect(upstream.seen.map((entry) => entry.site)).toEqual(sites.slice(0, 3));
    expect(transport.dialled.map((entry) => entry.url)).toEqual([
      `https://checkpoint.gnosischain.com/${FINALITY}`,
      `https://gnosis.colibri-proof.tech/consensus/${FINALITY}`,
      `https://rpc-gbc.gnosischain.com/${FINALITY}`,
    ]);
  });

  test('exclude_mask skips the servers it names; the node is still the index in the full list', async () => {
    const sites = gnosisCheckpointzSites();
    upstream.route = (req, res, { site }) => {
      if (site === sites[1]) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.end('{"data":"answer"}');
    };

    const answer = await call(finality(blockNumberOp({ chain: 100 }), { exclude_mask: 0b101 }));

    expect(answer.head).toEqual({ node: 3, bytes: 17 });
    expect(upstream.seen.map((entry) => entry.site)).toEqual([sites[1], sites[3]]);
  });

  test('a mask that excludes every server: All nodes failed, nothing sent and nothing reserved, even with the pool full', async () => {
    const full = pool.reserve(COLIBRI_FETCH_POOL_BYTES);
    const answer = await call(finality(blockNumberOp(), { exclude_mask: 1 }));
    expect(answer).toEqual({ error: 'All nodes failed' });
    expect(upstream.seen).toEqual([]);
    full.close();
    expect(pool.held).toBe(0);
  });

  test('a server the endpoint policy refuses fails as a transport failure, never dialled', async () => {
    const lan = 'http://192.168.1.20/prover';
    const answer = await call(finality(blockNumberOp({ prover: lan })));
    expect(answer).toEqual({ error: 'Request to <url> failed: fetch failed' });
    expect(transport.dialled).toEqual([]);
  });
});

describe('refusals', () => {
  test('a fetch the contract refuses: Colibri fetch refused, a warn with the chain, the type and the rule, nothing sent', async () => {
    const op = blockNumberOp({ chain: 100 });

    const answers = [
      await call({
        ...blockNumber(op),
        payload: { method: 'eth_chainId', params: [], version: 196611 },
      }),
      await call({ ...finality(op), path: `${FINALITY}?secret=1` }),
      await call({ ...finality(op), type: 'eth_rpc', path: 'rpc' }),
      await call({ ...finality(op), type: 'not a type' }),
      await call({ ...finality(op), request: 999 }),
    ];

    expect(answers).toEqual(Array(5).fill({ error: 'Colibri fetch refused' }));
    expect(log.warn.mock.calls).toEqual([
      ['[Colibri] fetch refused', { chain: 100, type: 'prover', rule: 'derived' }],
      ['[Colibri] fetch refused', { chain: 100, type: 'checkpointz', rule: 'query' }],
      ['[Colibri] fetch refused', { chain: 100, type: 'eth_rpc', rule: 'eth_rpc' }],
      ['[Colibri] fetch refused', { chain: 100, type: 'other', rule: 'type' }],
      ['[Colibri] fetch refused', { chain: null, type: 'checkpointz', rule: 'request' }],
    ]);
    // Never the path or the payload.
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toMatch(/secret|eth_chainId|finality/);
    expect(upstream.seen).toEqual([]);
    expect(pool.held).toBe(0);
  });

  test('an operation past its deadline admits nothing', async () => {
    const op = blockNumberOp({ deadlineMs: -1 });
    await expect(call(finality(op))).resolves.toEqual({ error: 'Colibri fetch refused' });
    expect(log.warn).toHaveBeenCalledWith('[Colibri] fetch refused', {
      chain: LONE,
      type: 'checkpointz',
      rule: 'request',
    });
    expect(upstream.seen).toEqual([]);
  });

  test("a checkpoint's root is never fetched: main answers it from its quorum (the checkpoint path), so here it is refused", async () => {
    const op = { kind: 'checkpoint', id: 50, chain: 1, deadlineAt: Date.now() + 10_000 };
    operations.set(op.id, op);
    const root = {
      request: op.id,
      type: 'checkpointz',
      method: 'get',
      path: 'eth/v1/beacon/blocks/123/root',
      accept: 'json',
      exclude_mask: 0,
    };
    await expect(call(root)).resolves.toEqual({ error: 'Colibri fetch refused' });
    expect(log.warn).toHaveBeenCalledWith('[Colibri] fetch refused', {
      chain: 1,
      type: 'checkpointz',
      rule: 'local',
    });
    expect(transport.dialled).toEqual([]);
  });

  test("a checkpoint's proof, main's own request, once: a second is refused (count)", async () => {
    const op = { kind: 'checkpoint', id: 51, chain: 1, deadlineAt: Date.now() + 10_000 };
    operations.set(op.id, op);
    const proof = {
      request: op.id,
      type: 'checkpoint_proof',
      method: 'post',
      path: '',
      accept: 'ssz',
      exclude_mask: 0,
    };
    upstream.route = (req, res) => res.end(bytes(64));

    await expect(call(proof)).resolves.toMatchObject({ head: { node: 0, bytes: 64 } });
    expect(transport.dialled.map((entry) => entry.url)).toEqual([
      'https://mainnet1.colibri-proof.tech',
    ]);
    expect(JSON.parse(upstream.seen[0].body)).toEqual({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
      version: 196611,
      zk_proof: true,
    });
    await expect(call(proof)).resolves.toEqual({ error: 'Colibri fetch refused' });
    expect(log.warn).toHaveBeenCalledWith('[Colibri] fetch refused', {
      chain: 1,
      type: 'checkpoint_proof',
      rule: 'count',
    });
  });

  test("an operation without its deadline is main's bug", async () => {
    operations.set(77, { ...blockNumberOp(), id: 77, deadlineAt: undefined });
    await expect(handler(finality({ id: 77 }), {})).rejects.toThrow(TypeError);
  });
});

describe("the refusals' warn log, rate-limited per process generation", () => {
  const SECOND = 1000;
  let clock;
  let limited;

  beforeEach(() => {
    clock = 1_000_000;
    limited = colibriFetchHandler({
      operations,
      pool,
      hop: makeHop({ fetch: transport.fetch }),
      log,
      now: () => clock,
    });
  });

  /** A fetch naming no open operation: refused, by `generation`. */
  const refused = (generation = 1) =>
    limited(finality({ id: 999 }), { signal: new AbortController().signal, generation });
  const logged = () =>
    log.warn.mock.calls.filter(([message]) => message === '[Colibri] fetch refused');
  const summaries = () =>
    log.warn.mock.calls.filter(([message]) => message === '[Colibri] fetch refusals not logged');

  test('ten a rolling minute one by one; the rest counted in one warn once a minute has passed; then one by one again', async () => {
    expect(REFUSALS_LOGGED).toBe(10);
    // Fifteen, a second apart: the 11th to the 15th aren't logged.
    for (let i = 0; i < 15; i++) {
      await expect(refused()).resolves.toEqual({ error: 'Colibri fetch refused' });
      clock += SECOND;
    }
    expect(logged()).toHaveLength(10);
    expect(logged()[0]).toEqual([
      '[Colibri] fetch refused',
      { chain: null, type: 'checkpointz', rule: 'request' },
    ]);
    // Still within the minute of the first held back: held back too, no
    // count yet.
    clock = 1_000_000 + 59 * SECOND;
    await refused();
    expect(logged()).toHaveLength(10);
    expect(summaries()).toEqual([]);

    // A minute after the first held back (and the window's ten expired):
    // one count, then this refusal logged on its own.
    clock = 1_000_000 + 70 * SECOND;
    await refused();
    expect(summaries()).toEqual([['[Colibri] fetch refusals not logged', { count: 6 }]]);
    expect(logged()).toHaveLength(11);
    clock += SECOND;
    await refused();
    expect(logged()).toHaveLength(12);
    expect(summaries()).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(13);
    expect(upstream.seen).toEqual([]);
  });

  test('a rolling window: a refusal is logged again as soon as the oldest logged one is a minute old', async () => {
    for (let i = 0; i < 11; i++) await refused();
    expect(logged()).toHaveLength(10);
    clock += 60 * SECOND;
    await refused();
    // The window is free again; the one held back is counted with it.
    expect(logged()).toHaveLength(11);
    expect(summaries()).toEqual([['[Colibri] fetch refusals not logged', { count: 1 }]]);
  });

  test('a new generation has its own budget', async () => {
    for (let i = 0; i < 12; i++) await refused(1);
    expect(logged()).toHaveLength(10);
    for (let i = 0; i < 10; i++) await refused(2);
    expect(logged()).toHaveLength(20);
    await refused(2);
    expect(logged()).toHaveLength(20);
    expect(summaries()).toEqual([]);
  });
});

describe('error texts, as fetch_from_servers writes them', () => {
  test("the last server's error is the answer: HTTP errors with their details, transport failures with the payload, URLs hidden", async () => {
    const sites = gnosisCheckpointzSites();
    upstream.route = (req, res, { site }) => {
      if (site === 'prover') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('upstream https://upstream.example/a?b=c refused, see http://help.example');
        return;
      }
      req.socket.destroy();
    };

    const get = await call(finality(blockNumberOp({ chain: 100 })));
    expect(get).toEqual({
      error: 'HTTP error! Status: 500, Details: upstream <url> refused, see <url>',
    });
    expect(upstream.seen.map((entry) => entry.site)).toEqual(sites);

    upstream.route = (req) => req.socket.destroy();
    const post = await call(blockNumber(blockNumberOp()));
    expect(post).toEqual({
      error: `Request to <url> with payload ${JSON.stringify(BLOCK_NUMBER)} failed: fetch failed`,
    });
    const plain = await call(finality(blockNumberOp()));
    expect(plain).toEqual({ error: 'Request to <url> failed: fetch failed' });
  });

  test("an empty error body, and one that never ends: read to its bound (here the variant's 64 KiB), the rest torn down; the text cut to 2,000 units", async () => {
    upstream.route = (req, res, { rest }) => {
      if (rest.startsWith('empty/')) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(502);
      upstream.every(res, 2, 'é'.repeat(4096));
    };

    const empty = await call(finality(blockNumberOp({ prover: `${upstream.url}/prover/empty` })));
    expect(empty).toEqual({ error: 'HTTP error! Status: 404, Details: ' });

    const endless = await call(
      finality(blockNumberOp({ prover: `${upstream.url}/prover/endless` }))
    );
    const head = 'HTTP error! Status: 502, Details: ';
    expect(endless.error).toBe(`${head}${'é'.repeat(MAX_ERROR_UNITS - head.length)}`);
    await until(() => upstream.torn.length === 1, 'the error body torn down');
  });

  test('the details as response.text() decodes them: a BOM dropped, an unfinished sequence U+FFFD; URLs hidden before the cut, however long', async () => {
    const replacement = String.fromCharCode(0xfffd);
    const bodies = {
      bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('oops')]),
      // The first two bytes of a three-byte character, at the end.
      unfinished: Buffer.concat([Buffer.from('bad'), Buffer.from([0xe2, 0x82])]),
      broken: Buffer.concat([Buffer.from('a'), Buffer.from([0xff]), Buffer.from('b')]),
      url: Buffer.from(`https://long.example/${'a'.repeat(8 * 1024)} sentinel`),
    };
    upstream.route = (req, res, { rest }) => {
      res.writeHead(500);
      res.end(bodies[rest.split('/')[0]]);
    };
    const details = async (name, shape = finality) => {
      const answer = await call(shape(blockNumberOp({ prover: `${upstream.url}/prover/${name}` })));
      return answer.error.replace('HTTP error! Status: 500, Details: ', '');
    };

    expect(await details('bom')).toBe('oops');
    expect(await details('unfinished')).toBe(`bad${replacement}`);
    expect(await details('broken')).toBe(`a${replacement}b`);
    expect(await details('url')).toBe('<url> sentinel');
    expect(await details('url', blockNumber)).toBe('<url> sentinel');
  });

  test('the cut never splits a character, and falls after the URLs are hidden', () => {
    const pair = '😀';
    const text = `${'a'.repeat(MAX_ERROR_UNITS - 1)}${pair}`;
    expect(cutUnits(text, MAX_ERROR_UNITS)).toBe('a'.repeat(MAX_ERROR_UNITS - 1));
    expect(cutUnits(`${'a'.repeat(MAX_ERROR_UNITS - 2)}${pair}b`, MAX_ERROR_UNITS)).toBe(
      `${'a'.repeat(MAX_ERROR_UNITS - 2)}${pair}`
    );
    const url = `https://example.com/${'x'.repeat(5000)}`;
    expect(errorText(`Request to ${url} failed: fetch failed`)).toBe(
      'Request to <url> failed: fetch failed'
    );
    expect(errorText('é'.repeat(3000))).toHaveLength(MAX_ERROR_UNITS);
  });

  test("the texts main answers with besides the servers' own", () => {
    expect(COLIBRI_FETCH_TEXTS).toEqual({
      refused: 'Colibri fetch refused',
      poolFull: 'Colibri fetch pool full',
      allFailed: 'All nodes failed',
    });
  });
});

describe('redirects', () => {
  test('a GET follows a redirect to the same server and the same variant, hex in another case and the headers kept', async () => {
    const op = blockNumberOp();
    let hops = 0;
    upstream.route = (req, res) => {
      hops += 1;
      if (hops === 1) {
        res.writeHead(307, {
          Location: `/prover/eth/v1/beacon/light_client/bootstrap/${ROOT.toUpperCase().replace('0X', '0x')}`,
        });
        res.end();
        return;
      }
      res.end(bytes(10));
    };

    const answer = await call(bootstrap(op));

    expect(answer.head).toEqual({ node: 0, bytes: 10 });
    expect(upstream.seen).toHaveLength(2);
    expect(upstream.seen[1].headers.accept).toBe('application/octet-stream');
  });

  test('at most three, with 301, 302, 303 and 308; a fourth fails that server, and the next is tried', async () => {
    const statuses = [301, 302, 303, 308];
    const sites = gnosisCheckpointzSites();

    // Three hops, then the answer: four requests to the first server.
    const three = blockNumberOp({ chain: 100 });
    upstream.route = (req, res, { site }) => {
      const at = upstream.seen.filter((entry) => entry.site === site).length;
      if (site === sites[0] && at <= 3) {
        res.writeHead(statuses[at - 1], { Location: `https://${site}/${FINALITY}` });
        res.end();
        return;
      }
      res.end('{"data":"answer"}');
    };
    await expect(call(finality(three))).resolves.toMatchObject({ head: { node: 0 } });
    expect(upstream.seen.map((entry) => entry.site)).toEqual(Array(4).fill(sites[0]));

    // A fourth: that server fails, the next answers.
    upstream.seen.length = 0;
    upstream.route = (req, res, { site }) => {
      if (site === sites[0]) {
        res.writeHead(302, { Location: `https://${site}/${FINALITY}` });
        res.end();
        return;
      }
      res.end('{"data":"answer"}');
    };
    await expect(call(finality(blockNumberOp({ chain: 100 })))).resolves.toMatchObject({
      head: { node: 1 },
    });
    expect(upstream.seen.map((entry) => entry.site)).toEqual([
      ...Array(4).fill(sites[0]),
      sites[1],
    ]);

    // Alone, the fourth's text is the answer.
    upstream.seen.length = 0;
    upstream.route = (req, res) => {
      res.writeHead(statuses[3], { Location: `${upstream.url}${req.url}` });
      res.end();
    };
    await expect(call(finality(blockNumberOp()))).resolves.toEqual({
      error: 'HTTP error! Status: 308, Details: redirect refused',
    });
    expect(upstream.seen).toHaveLength(4);
  });

  test('refused, the target never asked: another origin, a downgrade, outside the server, another variant, another field', async () => {
    const elsewhere = await startOrigin();
    elsewhere.route = (req, res) => res.end('{}');
    try {
      const locations = [
        `${elsewhere.url}/prover/${FINALITY}`,
        `http://prover.example/p/${FINALITY}`,
        `https://prover.example/other/${FINALITY}`,
        `https://prover.example/p/eth/v1/beacon/blocks/1/root`,
        `https://prover.example/p/${FINALITY}?x=1`,
      ];
      for (const location of locations) {
        upstream.seen.length = 0;
        upstream.route = (req, res) => {
          res.writeHead(302, { Location: location });
          res.end();
        };
        const op = blockNumberOp({ prover: 'https://prover.example/p' });
        await expect(call(finality(op))).resolves.toEqual({
          error: 'HTTP error! Status: 302, Details: redirect refused',
        });
        expect(upstream.seen).toHaveLength(1);
      }
      // Another field of the same variant: another block root.
      upstream.seen.length = 0;
      upstream.route = (req, res) => {
        res.writeHead(308, {
          Location: `/prover/eth/v1/beacon/light_client/bootstrap/${OTHER_ROOT}`,
        });
        res.end();
      };
      await expect(call(bootstrap(blockNumberOp()))).resolves.toEqual({
        error: 'HTTP error! Status: 308, Details: redirect refused',
      });
      expect(upstream.seen).toHaveLength(1);
      expect(elsewhere.seen).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  test('a POST follows none, any other 3xx follows nothing, and a redirect without a Location is refused', async () => {
    const cases = [
      [blockNumber, 307, { Location: '/prover' }],
      [blockNumber, 301, { Location: '/prover' }],
      [finality, 300, { Location: `/prover/${FINALITY}` }],
      [finality, 304, {}],
      [finality, 302, {}],
    ];
    for (const [shape, status, headers] of cases) {
      upstream.seen.length = 0;
      upstream.route = (req, res) => {
        res.writeHead(status, headers);
        res.end();
      };
      await expect(call(shape(blockNumberOp()))).resolves.toEqual({
        error: `HTTP error! Status: ${status}, Details: redirect refused`,
      });
      expect(upstream.seen).toHaveLength(1);
    }
  });
});

describe('bodies, through the service', () => {
  let fake;
  let twoWay;

  async function serving() {
    fake = fakeColibrid();
    twoWay = new ServiceClient({
      service: testService(),
      spawn: fake.spawn,
      command: '/bin/freedom-colibrid',
      args: ['serve', '--chain', '1', '--parent-pid', '1'],
      log: { info() {}, warn() {}, error() {} },
      shellVersion: 'test',
    });
    twoWay.handle('shell.colibri_fetch', handler, { streams: true });
    await twoWay.start();
    return fake.children[0];
  }

  afterEach(async () => {
    await twoWay?.stop();
    twoWay = null;
  });

  /** The reservation is given back, and the connection goes on: a control
   * request answers, and another fetch brings its body. */
  async function goesOn(child) {
    await until(() => pool.held === 0, 'the reservation given back');
    await expect(twoWay.request('colibri.stats')).resolves.toMatchObject({ open_requests: 0 });
    const op = blockNumberOp({ prover: `${upstream.url}/healthy` });
    await expect(child.fetch(op.id, finality(op)).done).resolves.toEqual({
      bytes: Buffer.from('{"data":"ok"}'),
      node: 0,
    });
    await until(() => twoWay.streamStats().sending === 0, 'the streams done');
    expect(twoWay.streamStats()).toMatchObject({ pieces: 0, held: 0, pending: 0 });
    expect(pool.held).toBe(0);
    expect(child.protocolError).toBeNull();
  }

  test('a body without Content-Length, read to its close: its exact length in the head, then the body', async () => {
    const child = await serving();
    upstream.route = (req) => {
      req.socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${'y'.repeat(50_000)}`);
    };
    const op = blockNumberOp();
    const fetch = child.fetch(op.id, finality(op));
    await expect(fetch.done).resolves.toEqual({ bytes: Buffer.from('y'.repeat(50_000)), node: 0 });
    expect(fetch.head).toEqual({ node: 0, bytes: 50_000, body: true });
    await goesOn(child);
  });

  test('a declared length over the maximum fails that server unread; the next is tried under the same reservation', async () => {
    const child = await serving();
    const sites = gnosisCheckpointzSites();
    let heldAtSecond = null;
    upstream.route = (req, res, { site }) => {
      if (site === sites[0]) {
        res.writeHead(200, { 'Content-Length': String(64 * KIB + 1) });
        res.write('{');
        return;
      }
      heldAtSecond = pool.held;
      res.end('{"data":"answer"}');
    };
    const op = blockNumberOp({ chain: 100 });
    await expect(child.fetch(op.id, finality(op)).done).resolves.toEqual({
      bytes: Buffer.from('{"data":"answer"}'),
      node: 1,
    });
    expect(heldAtSecond).toBe(64 * KIB);
    await until(() => upstream.torn.length === 1, 'the first response torn down');

    // Alone, its text is the answer.
    upstream.route = (req, res) => {
      res.writeHead(200, { 'Content-Length': String(64 * KIB + 1) });
      res.write('{');
    };
    const lone = blockNumberOp();
    await expect(child.fetch(lone.id, finality(lone)).done).resolves.toEqual({
      error: 'Request to <url> failed: response over 65536 bytes',
    });
    await goesOn(child);
  });

  test('a declared length that lies low: main sends the bytes the stack delivered, its head saying exactly those', async () => {
    const child = await serving();
    upstream.route = (req) => {
      req.socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n${'z'.repeat(100 * KIB)}`
      );
    };
    const op = blockNumberOp();
    const fetch = child.fetch(op.id, finality(op));
    await expect(fetch.done).resolves.toEqual({ bytes: Buffer.from('z'.repeat(10)), node: 0 });
    expect(fetch.head.bytes).toBe(10);
    await goesOn(child);
  });

  test.each([
    ['gzip', zlib.gzipSync],
    ['br', zlib.brotliCompressSync],
  ])(
    'a %s body is counted decoded: one inflating past the maximum fails, its small declared length notwithstanding',
    async (encoding, compress) => {
      const child = await serving();
      const fits = Buffer.from(JSON.stringify({ data: 'a'.repeat(60 * KIB) }));
      const bomb = compress(Buffer.alloc(16 * MIB));
      expect(bomb.length).toBeLessThan(64 * KIB);
      upstream.route = (req, res, { rest }) => {
        const body = rest.startsWith('fits/') ? compress(fits) : bomb;
        res.writeHead(200, { 'Content-Encoding': encoding, 'Content-Length': String(body.length) });
        res.end(body);
      };

      const small = blockNumberOp({ prover: `${upstream.url}/prover/fits` });
      const fetch = child.fetch(small.id, finality(small));
      await expect(fetch.done).resolves.toEqual({ bytes: fits, node: 0 });
      expect(fetch.head.bytes).toBe(fits.length);

      const op = blockNumberOp({ prover: `${upstream.url}/prover/bomb` });
      await expect(child.fetch(op.id, finality(op)).done).resolves.toEqual({
        error: 'Request to <url> failed: response over 65536 bytes',
      });
      await goesOn(child);
    }
  );

  test('a chunked body is counted like one without a length', async () => {
    const child = await serving();
    const parts = Array.from({ length: 20 }, (_, i) => bytes(2 * KIB, i));
    upstream.route = async (req, res) => {
      res.writeHead(200);
      for (const part of parts) {
        res.write(part);
        await sleep(1);
      }
      res.end();
    };
    const op = blockNumberOp();
    const fetch = child.fetch(op.id, finality(op));
    await expect(fetch.done).resolves.toEqual({ bytes: Buffer.concat(parts), node: 0 });
    expect(upstream.seen).toHaveLength(1);
    await goesOn(child);

    // Past the maximum, chunked or not, it fails.
    upstream.route = async (req, res) => {
      res.writeHead(200);
      for (let i = 0; i < 40; i++) res.write(bytes(2 * KIB, i));
      res.end();
    };
    const over = blockNumberOp();
    await expect(child.fetch(over.id, finality(over)).done).resolves.toEqual({
      error: 'Request to <url> failed: response over 65536 bytes',
    });
    await goesOn(child);
  });

  test('an endless body stops at the maximum, and its response is torn down', async () => {
    const child = await serving();
    upstream.route = (req, res) => {
      res.writeHead(200);
      upstream.every(res, 2, Buffer.alloc(16 * KIB, 0x61));
    };
    const op = blockNumberOp();
    await expect(child.fetch(op.id, finality(op)).done).resolves.toEqual({
      error: 'Request to <url> failed: response over 65536 bytes',
    });
    await until(() => upstream.torn.length === 1, 'the response torn down');
    await goesOn(child);
  });

  test("a body that trickles ends at the operation's deadline: timeout, the response torn down", async () => {
    const child = await serving();
    upstream.route = (req, res) => {
      res.writeHead(200);
      upstream.every(res, 20, 'x');
    };
    const op = blockNumberOp({ deadlineMs: 300 });
    const started = Date.now();
    await expect(child.fetch(op.id, finality(op)).done).resolves.toEqual({ error: 'Timed out' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await until(() => upstream.torn.length === 1, 'the response torn down');
    await goesOn(child);
  });

  test("the service's cancel mid-body aborts the read and gives back the reservation at once", async () => {
    const child = await serving();
    upstream.route = (req, res) => {
      res.writeHead(200);
      upstream.every(res, 10, 'x');
    };
    const op = blockNumberOp();
    const fetch = child.fetch(op.id, blockNumber(op));
    await until(() => upstream.seen.length === 1 && pool.held === 16 * MIB, 'the read under way');
    fetch.cancel();
    await expect(fetch.done).resolves.toEqual({ cancelled: true, received: 0 });
    await until(() => upstream.torn.length === 1, 'the response torn down');
    await goesOn(child);
  });

  test("the service's cancel mid-stream ends the body cancelled, and gives back what is left of the reservation", async () => {
    const child = await serving();
    const body = bytes(MIB, 9);
    upstream.route = (req, res) => res.end(body);
    const op = blockNumberOp();
    const fetch = child.fetch(op.id, blockNumber(op), { paused: true });
    await until(() => fetch.arrived === WINDOW, "the service's window full");
    // Shrunk to the body at the head, and given back as the service took
    // its window (and main one read ahead).
    expect(pool.held).toBeLessThan(MIB);
    expect(pool.held).toBeGreaterThan(MIB - WINDOW - 128 * KIB);
    fetch.cancel();
    await expect(fetch.done).resolves.toEqual({ cancelled: true, received: 0 });
    await until(() => child.terminals.length === 1, "main's terminal");
    expect(child.terminals).toEqual([{ id: fetch.id, type: 'abort', code: 'cancelled' }]);
    await goesOn(child);
  });

  test('a body given back to the pool keeps no storage behind: its pieces are its own, and those left never hold more than the reservation', async () => {
    const body = bytes(MIB + 1, 5);
    const pieces = ownedPieces(body);
    expect(pieces).toHaveLength(17);
    for (const piece of pieces) {
      expect(piece.buffer).not.toBe(body.buffer);
      expect(piece.byteOffset).toBe(0);
      expect(piece.buffer.byteLength).toBe(piece.byteLength);
      expect(piece.byteLength).toBeLessThanOrEqual(64 * KIB);
    }
    const reservation = pool.reserve(16 * MIB);
    reservation.shrink(body.length);
    const reader = bodyStream(pieces, reservation).getReader({ mode: 'byob' });
    const backing = () => pieces.reduce((sum, piece) => sum + piece.buffer.byteLength, 0);
    const parts = [];
    let taken = 0;
    // Read in odd sizes, as credit allows, pausing mid-piece and with one
    // byte left: what the pieces still hold is always reserved.
    for (const stop of [100_000, body.length - 1]) {
      while (taken < stop) {
        const { value } = await reader.read(new Uint8Array(Math.min(1000, stop - taken)));
        parts.push(Buffer.from(value));
        taken += value.byteLength;
      }
      expect(backing()).toBeLessThanOrEqual(reservation.held);
      expect(pool.held).toBe(reservation.held);
    }
    expect(reservation.held).toBe(1);
    expect(backing()).toBe(1);
    const last = await reader.read(new Uint8Array(1000));
    parts.push(Buffer.from(last.value));
    expect((await reader.read(new Uint8Array(1))).done).toBe(true);
    expect(Buffer.concat(parts)).toEqual(body);
    expect(pieces).toEqual([]);
    expect(pool.held).toBe(0);
  });

  test('a cancelled body lets go of every piece and gives back the reservation', async () => {
    const pieces = ownedPieces(bytes(200 * KIB));
    const reservation = pool.reserve(200 * KIB);
    const reader = bodyStream(pieces, reservation).getReader({ mode: 'byob' });
    await reader.read(new Uint8Array(1000));
    await reader.cancel();
    expect(pieces).toEqual([]);
    expect(pool.held).toBe(0);
  });

  test('the reservation is given back as the service takes the body', async () => {
    const child = await serving();
    const body = bytes(MIB, 3);
    upstream.route = (req, res) => res.end(body);
    const op = blockNumberOp();
    const fetch = child.fetch(op.id, blockNumber(op), { paused: true });
    await until(() => fetch.arrived === WINDOW, "the service's window full");
    const held = pool.held;
    fetch.resume();
    await expect(fetch.done).resolves.toEqual({ bytes: body, node: 0 });
    expect(held).toBeLessThan(MIB);
    await goesOn(child);
  });

  test('the pool exhausted by parallel fetches: the next is answered pool full, unsent, while control frames and cancels go on', async () => {
    const child = await serving();
    const waiting = [];
    upstream.route = (req, res) => waiting.push(res);
    const ops = Array.from({ length: 8 }, () => blockNumberOp());
    const fetches = ops.map((op) => child.fetch(op.id, blockNumber(op)));
    await until(() => waiting.length === 8, 'eight reads under way');
    expect(pool.held).toBe(COLIBRI_FETCH_POOL_BYTES);

    const ninth = blockNumberOp();
    await expect(child.fetch(ninth.id, blockNumber(ninth)).done).resolves.toEqual({
      error: 'Colibri fetch pool full',
    });
    expect(upstream.seen).toHaveLength(8);
    // Control frames go on: a request answers, and a cancel frees its part.
    await expect(twoWay.request('colibri.stats')).resolves.toMatchObject({ open_requests: 0 });
    fetches[0].cancel();
    await until(() => pool.held === COLIBRI_FETCH_POOL_BYTES - 16 * MIB, 'one reservation back');

    for (const res of waiting) {
      if (!res.destroyed) res.end(bytes(100));
    }
    for (const fetch of fetches.slice(1)) {
      await expect(fetch.done).resolves.toEqual({ bytes: bytes(100), node: 0 });
    }
    await goesOn(child);
  });

  test('a body shorter than its declared length fails that server in the stack; the next is tried', async () => {
    const child = await serving();
    const sites = gnosisCheckpointzSites();
    upstream.route = (req, res, { site }) => {
      if (site === sites[0]) {
        res.writeHead(200, { 'Content-Length': '1000' });
        res.write('z'.repeat(500));
        setTimeout(() => req.socket.destroy(), 10);
        return;
      }
      res.end('{"data":"answer"}');
    };
    const op = blockNumberOp({ chain: 100 });
    await expect(child.fetch(op.id, finality(op)).done).resolves.toEqual({
      bytes: Buffer.from('{"data":"answer"}'),
      node: 1,
    });

    upstream.route = (req, res) => {
      res.writeHead(200, { 'Content-Length': '1000' });
      res.write('z'.repeat(500));
      setTimeout(() => req.socket.destroy(), 10);
    };
    const lone = blockNumberOp();
    await expect(child.fetch(lone.id, finality(lone)).done).resolves.toEqual({
      error: 'Request to <url> failed: fetch failed',
    });
    await goesOn(child);
  });

  test('an empty body is a head of zero bytes and an empty stream', async () => {
    const child = await serving();
    upstream.route = (req, res) => res.end();
    const op = blockNumberOp();
    const fetch = child.fetch(op.id, finality(op));
    await expect(fetch.done).resolves.toEqual({ bytes: Buffer.alloc(0), node: 0 });
    expect(fetch.head).toEqual({ node: 0, bytes: 0, body: true });
    await goesOn(child);
  });
});
