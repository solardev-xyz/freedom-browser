/**
 * Main's chain-data drivers against the real freedom-cored binary: the
 * configuration, the executors (over a scripted fetch) and the drivers, as
 * chain-data.js calls them, with what goes on the wire to the core recorded.
 * The reviews of #698 found each case here; their expected values are the
 * pinned router's. Skipped unless FREEDOM_CORED_PATH points at a build
 * with the chain thread, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/core
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CoreClient } = require('./core-client');
const { FrameDecoder } = require('./frame');
const { makeHop } = require('./naming-shell');
const { ChainConfig } = require('./chain-config');
const { BroadcastRecords } = require('./chain-broadcasts');
const { registerChainShell } = require('./chain-shell');
const { registerChainVerified } = require('./chain-verified');
const { ChainDriver, RECONFIGURED } = require('./chain-driver');
const { servesChain } = require('../../../test/helpers/core-chain-probe');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({
  netGatewayFetch: jest.fn(),
  isOnionHostname: () => false,
}));
jest.mock('./chain', () => ({ chainDriver: jest.fn(() => null) }));

const chain = require('./chain');
const chainData = require('../networks/chain-data');

const binary = process.env.FREEDOM_CORED_PATH;
// A real core reads on real timers.
jest.setTimeout(30_000);
const quietLog = { info() {}, warn() {}, error() {} };
const describeIfChain = servesChain(binary) ? describe : describe.skip;

/** A signed transaction and its hash (freedom-core vectors/chain.json). */
const RAW =
  '0xf85f8001825208941111111111111111111111111111111111111111018026a045df4733a45ed06c5628f22221a73e0b2faa3959f649cc47e6c2a15c9792ae07a00ea422e4923de6e5b4c52d7fbd39046e96acf73b2037a5f11918ec6c2a64b40a';
const HASH = '0xdff97f6d2d938656e056527357e2ee12f38c03923ab1d11bc556fb5cc123e578';
const TO = '0x1111111111111111111111111111111111111111';

describeIfChain("chain data's drivers with the real freedom-cored", () => {
  let root;
  let client;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-chain-drivers-'));
  });
  afterEach(async () => {
    chain.chainDriver.mockReturnValue(null);
    await client?.stop();
    client = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A ready core configured with chain 1, read and broadcast through Direct
   * at `world.url` (switched by a test); its RPC answers by endpoint (a
   * says 0xa, b 0xb) unless `world.answer` does. `wire` records every
   * request main writes to the core, with the controls in flight as it
   * went.
   */
  async function start({ quorum = { k: 1, m: 1, timeoutMs: 5000 } } = {}) {
    const world = { url: 'https://a.example', answer: null, now: () => performance.now() };
    const registry = {
      getAllNetworks: () => ({
        1: {
          name: 'Ethereum',
          access: { readOrder: ['direct'], broadcastOrder: ['direct'] },
          quorum,
        },
      }),
      getEndpoints: (_chainId, role) => (role === 'rpc' ? [world.url] : []),
      getEndpointSources: () => [],
      getEndpointSourceList: () => [],
    };
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
    const config = new ChainConfig({
      client,
      sources: { registry, myotis: { NETWORKS: new Map() }, logIndexUrls: {} },
      log: quietLog,
    });
    const broadcasts = new BroadcastRecords();
    const exchanges = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      exchanges.push({ url, body });
      const answer = world.answer?.(body, url) ?? {
        result:
          body.method === 'eth_sendRawTransaction'
            ? HASH
            : url.includes('a.example')
              ? '0xa'
              : '0xb',
      };
      const text =
        typeof answer === 'string'
          ? answer
          : JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer });
      return new Response(text, { status: 200 });
    };
    registerChainShell(client, config, { broadcasts, hop: makeHop({ fetch }) });
    registerChainVerified(client, config, { broadcasts, adapters: {} });
    const driver = new ChainDriver({ client, config, broadcasts, now: () => world.now() });
    await client.start();
    await config.whenServing();
    const gen = client.current;
    const wire = [];
    const decoder = new FrameDecoder();
    const write = gen.child.stdin.write.bind(gen.child.stdin);
    gen.child.stdin.write = (bytes, ...rest) => {
      for (const { message } of decoder.push(bytes)) {
        if (message?.type === 'request') {
          wire.push({
            method: message.method,
            pending: config.core.pending,
            deadline: message.params?.deadline_ms,
          });
        }
      }
      return write(bytes, ...rest);
    };
    chain.chainDriver.mockReturnValue(driver);
    return { world, config, driver, broadcasts, exchanges, wire, gen };
  }

  /** A settings change: chain 1's endpoint becomes b, sent to the core. */
  const toB = ({ world, config }) => {
    world.url = 'https://b.example';
    return config.configure();
  };

  test('a broadcast waits for a control queued just after its last wait, and goes once', async () => {
    const x = await start();
    const idle = x.config.idle.bind(x.config);
    let armed = true;
    let change;
    x.config.idle = (gen) => {
      const quiet = idle(gen);
      if (quiet && armed) {
        armed = false;
        queueMicrotask(() => {
          change = toB(x);
        });
      }
      return quiet;
    };
    expect(await chainData.broadcastRawTransaction(1, RAW)).toEqual({
      result: HASH,
      source: 'direct',
    });
    await change;
    expect(x.wire.map(({ method, pending }) => [method, pending])).toEqual([
      ['chain.configure', 1],
      ['chain.broadcast', 0],
    ]);
    // Under the configuration main had moved to.
    expect(x.exchanges.map(({ url }) => url)).toEqual(['https://b.example']);
  });

  test("a control the caller's params queue while serialized goes first", async () => {
    const x = await start();
    let serializations = 0;
    let change;
    const params = {
      toJSON() {
        serializations += 1;
        change = toB(x);
        return [];
      },
    };
    expect(await chainData.request(1, 'eth_blockNumber', params)).toEqual({
      result: '0xb',
      source: 'direct',
      verified: false,
    });
    await change;
    expect(x.wire.map(({ method, pending }) => [method, pending])).toEqual([
      ['chain.configure', 1],
      ['chain.request', 0],
    ]);
    expect(serializations).toBe(1);
  });

  test('a reply a change overtook in the pipe is sent again once; a second time, it fails', async () => {
    for (const twice of [false, true]) {
      const x = await start();
      let clock = 0;
      x.world.now = () => clock;
      // As each read's reply reaches main, a settings change is asked for.
      const stdout = client.onStdout.bind(client);
      const decoder = new FrameDecoder();
      const changes = [];
      let replies = 0;
      client.onStdout = (gen, chunk) => {
        const frames = decoder.push(chunk);
        stdout(gen, chunk);
        for (const { message } of frames) {
          if (message?.type !== 'response' || message.result?.source !== 'direct') continue;
          replies += 1;
          if (replies === 1 || twice) {
            clock = 50_000 * replies;
            x.world.url = replies === 1 ? 'https://b.example' : 'https://c.example';
            changes.push(x.config.configure());
          }
        }
      };
      const result = await chainData.request(1, 'eth_blockNumber').catch((err) => err);
      await Promise.all(changes);
      const reads = x.wire.filter(({ method }) => method === 'chain.request');
      // The same deadline: what was left of it for the second attempt.
      expect(reads.map(({ deadline }) => deadline)).toEqual([120_000, 70_000]);
      if (twice) expect(result.message).toBe(RECONFIGURED);
      else expect(result.result).toBe('0xb');
      await client.stop();
      client = null;
    }
  });

  test('a broadcast cancelled once sent waits for the outcome the core still answers', async () => {
    const x = await start();
    const controller = new AbortController();
    x.world.answer = (body) => {
      if (body.method === 'eth_sendRawTransaction') controller.abort();
      return { result: null };
    };
    const outcome = await chainData.broadcastRawTransaction(1, RAW, { signal: controller.signal });
    expect(outcome).toEqual({ result: HASH, source: 'direct', outcome: 'uncertain' });
    expect(x.gen.pending.size).toBe(0);
    while (client.pool.held > 0) await new Promise(setImmediate);
  });

  test("a call object's BigInt quantities reach the node as the router's hex", async () => {
    const x = await start();
    expect(
      await chainData.request(1, 'eth_call', [{ to: TO, value: 3n, gas: 21000n }, 'latest'])
    ).toEqual({ result: '0xa', source: 'direct', verified: false });
    // The router's exchange: the same body, its id aside.
    expect(x.exchanges.map(({ body }) => [body.method, body.params])).toEqual([
      ['eth_call', [{ to: TO, value: '0x3', gas: '0x5208' }, 'latest']],
    ]);
  });

  test("results and node errors are the router's: key order, own properties, hosts", async () => {
    const x = await start();
    x.world.url = 'https://a.rpc.example:8545/v1/key';
    await x.config.configure();
    x.world.answer = () => ({});
    const missing = await chainData.request(1, 'eth_call', [], { includeTrust: true });
    expect(Object.keys(missing)).toEqual(['result', 'source', 'verified', 'trust']);
    expect(Object.hasOwn(missing, 'result')).toBe(true);
    expect(missing.result).toBeUndefined();
    expect(missing.trust).toEqual({
      level: 'unverified',
      method: 'direct',
      block: null,
      agreed: ['a.rpc.example:8545'],
      dissented: [],
      queried: ['a.rpc.example:8545'],
      quorum: { k: 1, m: 1, achieved: false },
    });
    const errors = [
      [
        { code: 3, message: 'execution reverted', data: '0x1234' },
        Error,
        'execution reverted',
        [
          ['code', 3],
          ['data', '0x1234'],
        ],
      ],
      [
        { code: -32000, message: 'nonce too low' },
        Error,
        'nonce too low',
        [
          ['code', -32000],
          ['data', undefined],
        ],
      ],
      [
        { message: 'empty code and data' },
        Error,
        'empty code and data',
        [
          ['code', undefined],
          ['data', undefined],
        ],
      ],
      [
        JSON.parse('{"code":null,"message":{"x":1},"data":{"ref":"must-stay-data","__proto__":7}}'),
        Error,
        '[object Object]',
        [
          ['code', null],
          ['data', JSON.parse('{"ref":"must-stay-data","__proto__":7}')],
        ],
      ],
      [
        JSON.parse('{"code":3,"message":{"toString":"not-callable"}}'),
        TypeError,
        'Cannot convert object to primitive value',
        [],
      ],
    ];
    for (const [error, Constructor, message, props] of errors) {
      x.world.answer = () => ({ error });
      const thrown = await chainData.request(1, 'eth_call', []).catch((err) => err);
      expect(thrown.constructor).toBe(Constructor);
      expect(thrown.message).toBe(message);
      expect(Object.entries(thrown)).toEqual(props);
    }
    x.world.answer = () => 'null';
    const typeError = await chainData.request(1, 'eth_call', []).catch((err) => err);
    expect(typeError.constructor).toBe(TypeError);
    expect(typeError.message).toBe("Cannot read properties of null (reading 'error')");
    x.world.answer = (body) => ({ result: body.method === 'eth_gasPrice' ? '0x10' : '0x2' });
    const quote = await chainData.getFeeQuote(1);
    expect(Object.entries(quote)).toEqual([
      ['type', 'eip1559'],
      ['baseFee', '14'],
      ['maxPriorityFeePerGas', '2'],
      ['maxFeePerGas', '30'],
      ['effectiveGasPrice', '16'],
      ['source', 'direct'],
      ['verified', false],
    ]);
  });
});
