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
const { FrameDecoder, KIND_BEGIN } = require('./frame');
const { makeHop } = require('./naming-shell');
const { registerChainShell } = require('./chain-shell');
const { registerChainVerified } = require('./chain-verified');
const { servesChain } = require('../../../test/helpers/core-chain-probe');
const { proverOutageError } = require('../../../test/helpers/colibri-prover-outage');

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
/** The widest `eth_getLogs` span the local node serves. */
const LOG_CAP = 10_000;

/**
 * A local JSON-RPC node. `/` answers by method; `/redirect` is a 307 to
 * `/` (an absolute location, which naming's rule follows); `/away?to=…` a
 * 307 to `to`; `/limited` a 429; `/reset` drops the connection. An
 * `eth_getLogs` over more than 10,000 blocks is refused as a capped
 * endpoint refuses it, and one within them finds no log. A GET under
 * `/blockscout/` is a Blockscout page with no transfer, the last. Every
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
      if (req.method === 'GET' && req.url.startsWith('/blockscout/')) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ items: [], next_page_params: null }));
        return;
      }
      const { id, method, params } = JSON.parse(body);
      if (method === 'eth_getLogs') {
        const [{ fromBlock, toBlock }] = params;
        const capped = Number(toBlock) - Number(fromBlock) + 1 > LOG_CAP;
        const answer = capped
          ? { error: { code: -32701, message: `exceed maximum block range: ${LOG_CAP}` } }
          : { result: [] };
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
        return;
      }
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
    const main = { refs: new Map(), chainId: 1, generation: 0, ahead: null };
    const config = {
      endpoint: (ref) =>
        main.refs.has(ref) ? { url: main.refs.get(ref), chainId: main.chainId } : null,
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
      main.chainId = chain.chain_id;
      main.generation = generations[String(chain.chain_id)];
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
  // Myotis v0.1.15 (ABI 44, main's a1dff495): bytes that are no transaction
  // Myotis relays are refused with -32602 and never gossiped. The router
  // threw that refusal and asked no second broadcaster; the core ends the
  // broadcast `rejected` the same way, and Direct never sees the bytes.
  // A core that reads a refusal's code (freedom-core design 0005, The rest)
  // gets it, and rebuilds the router's error exactly: -32602,
  // `invalid-params`. An older core, such as a release before it, gets
  // `{ rejected: { reason } }` and answers today's -32000, `rejected`; told
  // its core is older, main sends any core that form.
  test.each([
    ['as its core offers', false],
    ['to an older core', true],
  ])(
    "a Myotis -32602 send refusal is rejected, and Direct isn't asked, %s",
    async (_name, older) => {
      const reason = 'invalid raw transaction: malformed type 0x2 transaction';
      const refusal = Object.assign(new Error(reason), {
        code: -32602,
        myotisRefusal: 'invalid-params',
      });
      const adapters = { myotisBroadcast: jest.fn(async () => Promise.reject(refusal)) };
      const { gen, call, main } = await start(adapters);
      if (older) {
        const capabilities = client.hello.capabilities.filter((c) => c !== 'myotis_refusal_codes');
        client.hello = { ...client.hello, capabilities };
      }
      const coded = client.hello.capabilities.includes('myotis_refusal_codes');
      const replies = written(gen);
      main.refs.set('e1', `${rpc.base}/`);
      await main.configure(
        snapshot({
          broadcast_order: ['myotis', 'direct'],
          rpc: [{ endpoint: 'e1', user_configured: true }],
          myotis: true,
        })
      );
      await call('chain.availability', { chain_id: 1, ready: true });
      const failure = await call('chain.broadcast', {
        chain_id: 1,
        raw: RAW,
        deadline_ms: 30_000,
      }).catch((err) => err);
      expect(failure).toMatchObject({
        code: 'chain_error',
        data: {
          kind: 'core',
          constructor: 'Error',
          message: reason,
          props: coded
            ? { code: -32602, myotisRefusal: 'invalid-params' }
            : { code: -32000, myotisRefusal: 'rejected' },
          undefined_keys: [],
          outcome: 'rejected',
        },
      });
      // The props in the router's order: the code, then the marker.
      expect(Object.keys(failure.data.props)).toEqual(['code', 'myotisRefusal']);
      expect(replies.map((r) => r.result)).toContainEqual({
        rejected: coded ? { reason, code: -32602 } : { reason },
      });
      expect(adapters.myotisBroadcast).toHaveBeenCalledTimes(1);
      expect(rpc.seen).toEqual([]);
    }
  );

  /** Main's replies to the core's requests, as main writes them. */
  function written(gen) {
    const replies = [];
    const decoder = new FrameDecoder();
    const write = gen.child.stdin.write.bind(gen.child.stdin);
    gen.child.stdin.write = (chunk, ...rest) => {
      for (const { message } of decoder.push(chunk)) {
        if (message?.type === 'response') replies.push(message);
      }
      return write(chunk, ...rest);
    };
    return replies;
  }

  /** Colibri alone, with a prover, for chain 1. */
  const colibriOnly = () =>
    snapshot({ read_order: ['colibri'], prover: { endpoint: 'p1', zk: true } });

  // PRIVATE MODE GUARD (#1058, freedom-core #285): the core's `shell.verified`
  // names the request it serves, so each Colibri read runs in exactly that
  // request's window. A normal window's read while a private one's waits is
  // normal (the heuristic this replaces made it private: Codex review of
  // #1071, round 2), and a private one's keeps its session, even once that
  // session has ended.
  test('each Colibri read runs in the window of the request it serves', async () => {
    const logContext = require('../private/private-log-context');
    const seen = [];
    const release = [];
    const adapters = {
      colibriRequest: jest.fn((_chainId, _method, params) => {
        seen.push({
          address: params[0],
          private: logContext.isPrivateLogContext(),
          session: logContext.privateContextSession(),
        });
        return new Promise((resolve) => release.push(() => resolve('0x10')));
      }),
    };
    const { call, main } = await start(adapters);
    await main.configure(colibriOnly());
    const read = (address) =>
      call('chain.request', {
        chain_id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest'],
        include_trust: false,
        background: false,
        profile: 'default',
        deadline_ms: 20_000,
      });
    const until = async (count) => {
      for (let i = 0; i < 500 && seen.length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(seen).toHaveLength(count);
    };
    const [first, second, normal] = [
      ADDRESS,
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
    ];
    logContext.openPrivateSession();
    let reads;
    let sessions;
    try {
      const firstSession = logContext.runWithPrivateLogContext(true, () =>
        logContext.privateContextSession()
      );
      const firstRead = logContext.runWithPrivateLogContext(true, () => read(first));
      await until(1);
      // The last private window closes while its read waits, and a new one
      // opens and reads.
      logContext.endPrivateSession();
      logContext.openPrivateSession();
      const secondSession = logContext.runWithPrivateLogContext(true, () =>
        logContext.privateContextSession()
      );
      const secondRead = logContext.runWithPrivateLogContext(true, () => read(second));
      await until(2);
      const normalRead = read(normal);
      await until(3);
      for (const done of release) done();
      reads = await Promise.all([firstRead, secondRead, normalRead]);
      sessions = [firstSession, secondSession];
    } finally {
      logContext.endPrivateSession();
    }
    expect(reads.map((r) => r.source)).toEqual(['colibri', 'colibri', 'colibri']);
    expect(sessions[1]).not.toBe(sessions[0]);
    expect(seen).toEqual([
      { address: first, private: true, session: sessions[0] },
      { address: second, private: true, session: sessions[1] },
      { address: normal, private: false, session: null },
    ]);
  });

  // Review of #692 (parity, P2-1), with freedom-core #58: as today's router,
  // the app's route is blocked, and the revert keeps its data.
  test("a Colibri revert that is also a capacity failure keeps its data, and blocks the app's route", async () => {
    const adapters = {
      colibriRequest: jest.fn(async () => {
        throw Object.assign(new Error('out of gas'), { code: 3, data: '0x' });
      }),
    };
    const { gen, call, main } = await start(adapters);
    const replies = written(gen);
    await main.configure(colibriOnly());
    // Two identical reads from one app: an account read at `latest`, since
    // Colibri serves no call from 0.12.0 (freedom-core #279), whose own test
    // of this path asks the same.
    const read = () =>
      call('chain.request', {
        chain_id: 1,
        method: 'eth_getBalance',
        params: [ADDRESS, 'latest'],
        include_trust: false,
        origin: 'https://app.example',
        background: false,
        profile: 'default',
        deadline_ms: 20_000,
      }).catch((e) => e);
    const first = await read();
    expect(first.code).toBe('chain_error');
    expect(first.data).toMatchObject({
      message: 'execution reverted',
      props: { code: 3, data: '0x' },
    });
    expect(replies.map((r) => r.result)).toContainEqual({ revert: { data: '0x' }, capacity: true });
    const second = await read();
    expect(second.code).toBe('chain_error');
    expect(second.data.message).toBe(
      'All chain sources failed for eth_getBalance (colibri: temporarily bypassed for this app workload)'
    );
    expect(adapters.colibriRequest).toHaveBeenCalledTimes(1);
    expect(client.serves(gen)).toBe(true);
  });

  // Review of #692 (parity, P2-2), with freedom-core #58: today's router
  // returns an own `result: undefined`, verified.
  test('a Colibri success of undefined is a verified result, its value undefined', async () => {
    const adapters = { colibriRequest: jest.fn(async () => undefined) };
    const { gen, call, main } = await start(adapters);
    const replies = written(gen);
    await main.configure(colibriOnly());
    const read = (trust) =>
      call('chain.request', {
        chain_id: 1,
        method: 'eth_blockNumber',
        params: [],
        include_trust: trust,
        background: false,
        profile: 'default',
        deadline_ms: 20_000,
      });
    expect(await read(false)).toEqual({
      source: 'colibri',
      verified: true,
      undefined_keys: ['result'],
      generation: main.generation,
    });
    const trusted = await read(true);
    expect(trusted).toMatchObject({
      source: 'colibri',
      verified: true,
      undefined_keys: ['result'],
      generation: main.generation,
    });
    expect(Object.hasOwn(trusted, 'result')).toBe(false);
    expect(trusted.trust).toMatchObject({ level: 'verified', method: 'colibri' });
    expect(replies.map((r) => r.result)).toEqual([
      { undefined_keys: ['result'] },
      { undefined_keys: ['result'] },
    ]);
    expect(adapters.colibriRequest).toHaveBeenCalledTimes(2);
  });

  // #1059: Colibri no longer proves a read itself when its prover is down;
  // the prover's error is its whole answer, and the read moves on.
  test('a failed remote proof falls through to the next source, labelled as that source', async () => {
    const outage = proverOutageError();
    const adapters = { colibriRequest: jest.fn(async () => Promise.reject(outage)) };
    const { main } = await start(adapters);
    main.refs.set('e1', `${rpc.base}/`);
    await main.configure(
      snapshot({
        read_order: ['colibri', 'direct'],
        prover: { endpoint: 'p1', zk: true },
        rpc: [{ endpoint: 'e1', user_configured: true }],
      })
    );
    for (let i = 0; i < 3; i += 1) {
      expect(await main.read('eth_getBalance', [ADDRESS, 'latest'])).toEqual({
        result: '0x10',
        source: 'direct',
        verified: false,
        undefined_keys: [],
        generation: main.generation,
      });
    }
    // No verifier fault: Colibri is asked every time.
    expect(adapters.colibriRequest).toHaveBeenCalledTimes(3);
    expect(rpc.seen).toHaveLength(3);
  }, 60_000);

  /** Colibri, then Direct over the local node, with a prover, for chain 1. */
  async function colibriThenDirect(adapters) {
    const { main } = await start(adapters);
    main.refs.set('e1', `${rpc.base}/`);
    await main.configure(
      snapshot({
        read_order: ['colibri', 'direct'],
        prover: { endpoint: 'p1', zk: true },
        rpc: [{ endpoint: 'e1', user_configured: true }],
      })
    );
    return main;
  }

  // freedom-core #279 (main's #1046): Colibri proves no gas price or fee
  // history, and in privacy mode runs a call or a gas estimate on contract
  // code it never checks, so from 0.12.0 it serves none of them. Direct
  // answers, labelled as itself, and Colibri isn't asked.
  test('Colibri answers no fee method, call or gas estimate: the next source does, as itself', async () => {
    const adapters = { colibriRequest: jest.fn(async () => '0x1') };
    const main = await colibriThenDirect(adapters);
    const reads = [
      ['eth_gasPrice', []],
      ['eth_feeHistory', ['0x1', 'latest', []]],
      ['eth_call', [{ to: ADDRESS, data: '0x1234' }, 'latest']],
      ['eth_estimateGas', [{ to: ADDRESS, data: '0x1234' }]],
    ];
    for (const [method, params] of reads) {
      const reply = await main.read(method, params);
      expect({
        method,
        source: reply.source,
        verified: reply.verified,
        direct: reply.result === (method === 'eth_call' ? LARGE : '0x10'),
      }).toEqual({ method, source: 'direct', verified: false, direct: true });
    }
    expect(adapters.colibriRequest).not.toHaveBeenCalled();
    expect(rpc.seen.map(({ body }) => JSON.parse(body).method)).toEqual(
      reads.map(([method]) => method)
    );
  }, 60_000);

  // freedom-core #279 (main's #1060): Colibri proves an account read from
  // an authenticated block without checking that it is the one asked for,
  // so from 0.12.0 it answers one only at `latest`, whose proof it holds to
  // a freshness gate, with `latest` appended where the block is left out.
  // A block by number or hash is still Colibri's, as it checks that block;
  // `safe`, `finalized`, `pending`, `earliest`, a block number or hash for
  // an account read, and a block object (EIP-1898) aren't. Those go to
  // Direct, and Colibri isn't asked.
  test('Colibri answers only at the blocks it binds: account reads at latest, blocks by number or hash', async () => {
    const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
    const BLOCK = { number: '0x10', hash: BLOCK_HASH };
    const adapters = {
      colibriRequest: jest.fn(async (_chainId, method) =>
        method.startsWith('eth_getBlockBy') ? BLOCK : '0x1'
      ),
    };
    const main = await colibriThenDirect(adapters);
    const bound = [
      ['eth_getBalance', [ADDRESS, 'latest'], [ADDRESS, 'latest'], '0x1'],
      ['eth_getTransactionCount', [ADDRESS], [ADDRESS, 'latest'], '0x1'],
      ['eth_getBlockByNumber', ['latest', false], ['latest', false], BLOCK],
      ['eth_getBlockByNumber', ['0x10', false], ['0x10', false], BLOCK],
      ['eth_getBlockByHash', [BLOCK_HASH, false], [BLOCK_HASH, false], BLOCK],
    ];
    for (const [method, params, asked, result] of bound) {
      adapters.colibriRequest.mockClear();
      expect(await main.read(method, params)).toMatchObject({
        result,
        source: 'colibri',
        verified: true,
      });
      expect(adapters.colibriRequest).toHaveBeenCalledWith(1, method, asked, {
        deadlineMs: expect.any(Number),
      });
    }
    adapters.colibriRequest.mockClear();
    const unbound = [
      ['eth_getBalance', [ADDRESS, '0x10']],
      ['eth_getBalance', [ADDRESS, BLOCK_HASH]],
      ['eth_getBalance', [ADDRESS, { blockHash: BLOCK_HASH }]],
      ['eth_getCode', [ADDRESS, 'finalized']],
      ['eth_getTransactionCount', [ADDRESS, 'safe']],
      ['eth_getStorageAt', [ADDRESS, '0x0', 'pending']],
      ['eth_getBalance', [ADDRESS, 'earliest']],
      ['eth_getBlockByNumber', ['finalized', false]],
      ['eth_getBlockByNumber', ['safe', false]],
    ];
    for (const [method, params] of unbound) {
      const reply = await main.read(method, params);
      expect({ method, params, source: reply.source, verified: reply.verified }).toEqual({
        method,
        params,
        source: 'direct',
        verified: false,
      });
    }
    expect(adapters.colibriRequest).not.toHaveBeenCalled();
    expect(rpc.seen).toHaveLength(unbound.length);
  }, 60_000);

  // The wallet's finality labels take a quorum read as evidence only with
  // m ≥ 2 (intent-labels.js): the core's trust label must carry m.
  test('a quorum read with trust carries its quorum, m among it: what a wallet label needs', async () => {
    const { isVerifiedEvidence } = require('../wallet/intent-labels');
    const { call, main } = await start();
    main.refs.set('q1', `${rpc.base}/`);
    main.refs.set('q2', `${rpc.base}/?second`);
    const read = () =>
      call('chain.request', {
        chain_id: 1,
        method: 'eth_getBlockByNumber',
        params: ['finalized', false],
        include_trust: true,
        background: true,
        profile: 'default',
        deadline_ms: 20_000,
      });
    const rpcs = [
      { endpoint: 'q1', user_configured: false },
      { endpoint: 'q2', user_configured: false },
    ];

    await main.configure(
      snapshot({ read_order: ['quorum'], quorum: { k: 2, m: 2, timeout_ms: 5000 }, rpc: rpcs })
    );
    const agreed = await read();
    expect(agreed).toMatchObject({
      source: 'quorum',
      verified: true,
      trust: { level: 'verified', method: 'quorum', quorum: { k: 2, m: 2, achieved: true } },
    });
    expect(isVerifiedEvidence(agreed)).toBe(true);

    // A quorum of one is labeled a quorum too; its m says it is no evidence.
    await main.configure(
      snapshot({ read_order: ['quorum'], quorum: { k: 1, m: 1, timeout_ms: 5000 }, rpc: rpcs })
    );
    const single = await read();
    expect(single.trust).toMatchObject({ method: 'quorum', quorum: { m: 1 } });
    expect(isVerifiedEvidence(single)).toBe(false);

    // Direct: no evidence.
    await main.configure(snapshot({ read_order: ['direct'], rpc: rpcs }));
    const direct = await read();
    expect(direct).toMatchObject({ source: 'direct', verified: false });
    expect(isVerifiedEvidence(direct)).toBe(false);
  });

  // freedom-core #297 (main's #1097): Blockscout's newest blocks are the
  // RPC quorum's, so from 0.12.1 its answer is verified only where that
  // quorum's is, with m > 1. At m = 1 it is one endpoint's word: unverified,
  // and so is its trust's level. The trust's quorum is the pair's own, two
  // of two, either way. The scans are the Ant profile's, as the core's own
  // test of this rule makes them.
  test.each([
    [1, false, 'unverified'],
    [2, true, 'verified'],
  ])(
    "Blockscout's label follows its quorum's: at m = %i, verified is %s",
    async (m, verified, level) => {
      const { call, main } = await start();
      main.refs.set('a', `${rpc.base}/`);
      main.refs.set('b', `${rpc.base}/?second`);
      main.refs.set('index', `${rpc.base}/blockscout`);
      await main.configure(
        snapshot({
          chain_id: 100,
          display_name: 'Gnosis',
          read_order: ['quorum'],
          quorum: { k: 2, m, timeout_ms: 5000 },
          rpc: [
            { endpoint: 'a', user_configured: false },
            { endpoint: 'b', user_configured: false },
          ],
          blockscout: { endpoint: 'index' },
        })
      );
      // An xBZZ Transfer scan by sender, 500 blocks wider than an endpoint
      // serves.
      const to = 30_000_000;
      const hex = (n) => `0x${n.toString(16)}`;
      const scan = () =>
        call('chain.request', {
          chain_id: 100,
          method: 'eth_getLogs',
          params: [
            {
              address: '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da',
              fromBlock: hex(to - LOG_CAP - 499),
              toBlock: hex(to),
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                `0x${'0'.repeat(24)}971f31aaeac713b47aa55e50c06409afc1de46b9`,
              ],
            },
          ],
          include_trust: true,
          background: true,
          profile: 'ant_scan',
          deadline_ms: 60_000,
        });
      const pages = () => rpc.seen.filter(({ url }) => url.startsWith('/blockscout/'));
      // The first teaches the core the endpoints' cap: both refuse it, and
      // Blockscout isn't asked while a quorum may serve the span.
      expect((await scan().catch((e) => e)).code).toBe('chain_error');
      expect(pages()).toEqual([]);
      // The second is Blockscout's: an endpoint pairs with it for the older
      // blocks, the quorum reads the newest, and all agree on no log.
      const reply = await scan();
      expect(reply).toMatchObject({
        result: [],
        source: 'blockscout',
        verified,
        trust: {
          level,
          method: 'blockscout',
          agreed: [{ ref: 'index' }, { ref: expect.stringMatching(/^[ab]$/) }],
          dissented: [],
          quorum: { k: 2, m: 2, achieved: true },
        },
      });
      expect(pages()).toHaveLength(1);
    },
    120_000
  );
});
