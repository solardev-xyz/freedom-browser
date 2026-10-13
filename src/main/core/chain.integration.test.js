/**
 * Chain data's executors against the real freedom-cored binary: main
 * drives raw `chain.configure`, `chain.request` and `chain.broadcast`, and
 * the executors serve the chain thread's real `shell.rpc` (over a local
 * JSON-RPC server) and `shell.verified` (over scripted adapters). Skipped
 * unless FREEDOM_CORED_PATH points at a build with the chain thread
 * (freedom-core #57), e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/core
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { CoreClient } = require('./core-client');
const { KIND_BEGIN } = require('./frame');
const { makeHop } = require('./naming-shell');
const { registerChainShell } = require('./chain-shell');
const { registerChainVerified } = require('./chain-verified');
const { servesChain } = require('../../../test/helpers/core-chain-probe');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));

const binary = process.env.FREEDOM_CORED_PATH;
// A real core reads on real timers.
jest.setTimeout(30_000);
const quietLog = { info() {}, warn() {}, error() {} };
const MIB = 1024 * 1024;

const describeIfChain = servesChain(binary) ? describe : describe.skip;

/** A signed transaction and its hash (freedom-core vectors/chain.json). */
const RAW =
  '0xf85f8001825208941111111111111111111111111111111111111111018026a045df4733a45ed06c5628f22221a73e0b2faa3959f649cc47e6c2a15c9792ae07a00ea422e4923de6e5b4c52d7fbd39046e96acf73b2037a5f11918ec6c2a64b40a';
const HASH = '0xdff97f6d2d938656e056527357e2ee12f38c03923ab1d11bc556fb5cc123e578';
const ADDRESS = '0x1111111111111111111111111111111111111111';
// 3 MiB of hex: main's reply to the core, and the core's to main, both go
// in fragments.
const LARGE = `0x${'ab'.repeat(1.5 * MIB)}`;

/**
 * A local JSON-RPC node. `/` answers by method; `/redirect` is a 307 to
 * `/` (an absolute location, which naming's rule follows); `/away?to=…` a
 * 307 to `to`; `/limited` a 429; `/reset` drops the connection. Every
 * request is recorded.
 */
async function node() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
      if (req.url === '/redirect') {
        res.writeHead(307, { location: `http://${req.headers.host}/` }).end();
        return;
      }
      if (req.url.startsWith('/away?')) {
        const to = new URL(req.url, 'http://node').searchParams.get('to');
        res.writeHead(307, { location: to }).end();
        return;
      }
      if (req.url === '/limited') {
        res.writeHead(429, { 'retry-after': '1' }).end('{"error":"slow down"}');
        return;
      }
      if (req.url === '/reset') {
        req.socket.destroy();
        return;
      }
      const { id, method } = JSON.parse(body);
      const result = method === 'eth_call' ? LARGE : '0x10';
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Chain 1's snapshot (design 0005, Configuration). */
function snapshot(extra = {}) {
  return {
    chain_id: 1,
    display_name: 'Ethereum',
    read_order: ['direct'],
    broadcast_order: ['direct'],
    quorum: { k: 1, m: 1, timeout_ms: 5000 },
    rpc: [],
    prover: null,
    myotis: false,
    blockscout: null,
    ...extra,
  };
}

describeIfChain("chain data's executors with the real freedom-cored", () => {
  let root;
  let client;
  let rpc;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-chain-'));
    rpc = await node();
  });
  afterEach(async () => {
    await client?.stop();
    client = null;
    await rpc.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A ready core, its executors on main's references (`refs`, chain 1's)
   * and the generation main last learned (`generation`, or the one
   * `ahead` overrides it with). `transport` stands in for the session's
   * stack: Node's own fetch unless a test says otherwise.
   */
  async function start(adapters = {}, { transport = fetch } = {}) {
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
    const main = { refs: new Map(), generation: 0, ahead: null };
    const config = {
      endpoint: (ref) => (main.refs.has(ref) ? { url: main.refs.get(ref), chainId: 1 } : null),
      generation: () => main.ahead ?? main.generation,
    };
    registerChainShell(client, config, { hop: makeHop({ fetch: transport }) });
    registerChainVerified(client, config, { adapters });
    await client.start();
    const gen = client.current;
    const call = (method, params) =>
      client.requestTo(gen, method, params, { caller: 'chrome' }, { watchdogMs: 60_000 });
    main.configure = async (chain) => {
      const { generations } = await call('chain.configure', { chains: [chain] });
      main.generation = generations['1'];
    };
    main.read = (method, params) =>
      call('chain.request', {
        chain_id: 1,
        method,
        params,
        include_trust: false,
        background: false,
        profile: 'default',
        deadline_ms: 20_000,
      });
    return { gen, call, main };
  }

  test("the core's shell.rpc: one POST of its body, redirects followed, a 429 answered once", async () => {
    const { main } = await start();
    main.refs.set('e1', `${rpc.base}/`);
    await main.configure(snapshot({ rpc: [{ endpoint: 'e1', user_configured: true }] }));
    expect(await main.read('eth_blockNumber', [])).toEqual({
      result: '0x10',
      source: 'direct',
      verified: false,
      undefined_keys: [],
      generation: main.generation,
    });
    expect(rpc.seen).toHaveLength(1);
    const [exchange] = rpc.seen;
    expect(exchange).toMatchObject({ method: 'POST', url: '/', type: 'application/json' });
    expect(JSON.parse(exchange.body)).toMatchObject({
      jsonrpc: '2.0',
      method: 'eth_blockNumber',
      params: [],
    });

    // A 307: followed with the method and body kept.
    main.refs.set('e2', `${rpc.base}/redirect`);
    await main.configure(snapshot({ rpc: [{ endpoint: 'e2', user_configured: true }] }));
    expect((await main.read('eth_blockNumber', [])).result).toBe('0x10');
    const [hop, followed] = rpc.seen.slice(1);
    expect([hop.url, followed.url]).toEqual(['/redirect', '/']);
    expect(followed.method).toBe('POST');
    expect(followed.body).toBe(hop.body);

    // A 429 is the answer: no back-off, no second attempt.
    main.refs.set('e3', `${rpc.base}/limited`);
    await main.configure(snapshot({ rpc: [{ endpoint: 'e3', user_configured: true }] }));
    const limited = await main.read('eth_blockNumber', []).catch((e) => e);
    expect(limited.code).toBe('chain_error');
    expect(limited.data).toMatchObject({ message: 'HTTP 429' });
    expect(rpc.seen.filter((s) => s.url === '/limited')).toHaveLength(1);
  });

  test('a multi-MiB answer reaches the core in fragments, and its result comes back in fragments', async () => {
    const { gen, main } = await start();
    main.refs.set('e1', `${rpc.base}/`);
    await main.configure(snapshot({ rpc: [{ endpoint: 'e1', user_configured: true }] }));
    let begins = 0;
    const write = gen.child.stdin.write.bind(gen.child.stdin);
    gen.child.stdin.write = (chunk, ...rest) => {
      if (Buffer.isBuffer(chunk) && chunk[4] === KIND_BEGIN && chunk.length < 64) begins += 1;
      return write(chunk, ...rest);
    };
    const credits = jest.spyOn(client, 'returnCredit');
    const reply = await main.read('eth_call', [{ to: ADDRESS, data: '0x' }, 'latest']);
    expect(reply.result).toBe(LARGE);
    // Main's reply to the core was begun; the core's to main was too, and
    // main returned its credit.
    expect(begins).toBe(1);
    expect(credits).toHaveBeenCalledTimes(1);
    while (!gen.credit) await new Promise(setImmediate);
    expect(client.pool.held).toBe(0);
    expect(client.serves(gen)).toBe(true);
  });

  // Review of #692 (security, M1): an answer that fails once the request was
  // sent, its error naming the onion gate, is no proof the bytes stayed home.
  test('a broadcast whose answer fails after it was sent stays uncertain, and is reconciled', async () => {
    const failing = async (url, init) => {
      const response = await fetch(url, init);
      if (JSON.parse(init.body).method !== 'eth_sendRawTransaction') return response;
      await response.arrayBuffer();
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('.onion gateway body failed after sending'));
        },
      });
      return new Response(body, { status: 200 });
    };
    const { call, main } = await start({}, { transport: failing });
    main.refs.set('e1', `${rpc.base}/`);
    await main.configure(snapshot({ rpc: [{ endpoint: 'e1', user_configured: true }] }));
    const outcome = await call('chain.broadcast', { chain_id: 1, raw: RAW, deadline_ms: 30_000 });
    expect(outcome).toMatchObject({ hash: HASH, outcome: 'uncertain' });
    // The node had the transaction, and the core asked after it.
    expect(rpc.seen.map((s) => JSON.parse(s.body).method)).toEqual([
      'eth_sendRawTransaction',
      'eth_getTransactionByHash',
    ]);
    expect(JSON.parse(rpc.seen[0].body).params).toEqual([RAW]);
  });

  // Review of #692 (security, M2): the node behind another loopback port is
  // no endpoint the user configured.
  test('a redirect to another loopback port is refused: that node never sees the transaction', async () => {
    const other = await node();
    try {
      const { call, main } = await start();
      const away = `${rpc.base}/away?to=${encodeURIComponent(`${other.base}/admin`)}`;
      main.refs.set('e1', away);
      await main.configure(snapshot({ rpc: [{ endpoint: 'e1', user_configured: true }] }));
      const outcome = await call('chain.broadcast', { chain_id: 1, raw: RAW, deadline_ms: 30_000 });
      // The configured node had the bytes; the redirect was refused, so it
      // stays uncertain.
      expect(outcome).toMatchObject({ hash: HASH, outcome: 'uncertain' });
      expect(other.seen).toEqual([]);
      expect(JSON.parse(rpc.seen[0].body)).toMatchObject({ method: 'eth_sendRawTransaction' });
    } finally {
      await other.close();
    }
  });

  test('the core takes not_sent and transport failures, and serves on', async () => {
    const { gen, main } = await start();
    // A reference main doesn't know: not_sent.
    await main.configure(snapshot({ rpc: [{ endpoint: 'e9', user_configured: true }] }));
    expect((await main.read('eth_blockNumber', []).catch((e) => e)).code).toBe('chain_error');
    // A generation main has seen pass: not_sent, nothing dialled.
    main.refs.set('e1', `${rpc.base}/`);
    await main.configure(snapshot({ rpc: [{ endpoint: 'e1', user_configured: true }] }));
    main.ahead = main.generation + 1;
    expect((await main.read('eth_blockNumber', []).catch((e) => e)).code).toBe('chain_error');
    expect(rpc.seen).toEqual([]);
    main.ahead = null;
    // A dropped connection: network.
    main.refs.set('e4', `${rpc.base}/reset`);
    await main.configure(snapshot({ rpc: [{ endpoint: 'e4', user_configured: true }] }));
    expect((await main.read('eth_blockNumber', []).catch((e) => e)).code).toBe('chain_error');
    expect(rpc.seen.map((s) => s.url)).toEqual(['/reset']);
    // Still served, and still reading.
    expect(client.serves(gen)).toBe(true);
    await main.configure(snapshot({ rpc: [{ endpoint: 'e1', user_configured: true }] }));
    expect((await main.read('eth_blockNumber', [])).result).toBe('0x10');
  });

  test('verified operations answer in their exact shapes', async () => {
    const adapters = {
      myotisStatus: jest.fn(() => ({ optimisticBlockNumber: 21_000_000 })),
      myotisAccount: jest.fn(async () => ({
        status: 'ok',
        verifyMethod: 'proof',
        exists: true,
        balanceWei: '5',
        nonce: 1,
      })),
      myotisBroadcast: jest.fn(async () => ({ txHash: HASH })),
      colibriRequest: jest.fn(async () => '0x10'),
    };
    const { call, main } = await start(adapters);
    await main.configure(
      snapshot({
        read_order: ['myotis', 'colibri'],
        broadcast_order: ['myotis'],
        prover: { endpoint: 'p1', zk: true },
        myotis: true,
      })
    );
    await call('chain.availability', { chain_id: 1, ready: true });
    // A Myotis read: its payload, keys in snake_case.
    expect(await main.read('eth_getBalance', [ADDRESS, 'latest'])).toMatchObject({
      result: '0x5',
      source: 'myotis',
      verified: true,
    });
    expect(adapters.myotisAccount).toHaveBeenCalledWith(ADDRESS, 1);
    // Myotis serves no block number: Colibri's result.
    expect(await main.read('eth_blockNumber', [])).toMatchObject({
      result: '0x10',
      source: 'colibri',
      verified: true,
    });
    expect(adapters.colibriRequest).toHaveBeenCalledWith(1, 'eth_blockNumber', [], {
      deadlineMs: expect.any(Number),
    });
    // A Myotis broadcast: its hash.
    expect(await call('chain.broadcast', { chain_id: 1, raw: RAW, deadline_ms: 30_000 })).toEqual({
      hash: HASH,
      source: 'myotis',
      outcome: 'sent',
      generation: main.generation,
    });
    expect(adapters.myotisBroadcast).toHaveBeenCalledWith(RAW, 1);
  });
});
