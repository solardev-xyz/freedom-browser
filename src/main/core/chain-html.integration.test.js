/**
 * The `web3:` handler against the real freedom-cored binary: the handler,
 * chain data, main's drivers, the configuration and the executors (over a
 * scripted fetch), with the core's `chain.html` reading, decoding, capping,
 * hashing and classifying the document (freedom-core design 0006). Skipped
 * unless FREEDOM_CORED_PATH points at a build that serves `chain.html`
 * (after v0.4.0), e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/core
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { keccak256 } = require('ethers');
const { CoreClient } = require('./core-client');
const { FrameDecoder } = require('./frame');
const { makeHop } = require('./naming-shell');
const { ChainConfig } = require('./chain-config');
const { BroadcastRecords } = require('./chain-broadcasts');
const { registerChainShell } = require('./chain-shell');
const { registerChainVerified } = require('./chain-verified');
const { ChainDriver } = require('./chain-driver');
const { servesChainHtml } = require('../../../test/helpers/core-chain-probe');
const { waitFor } = require('../../../test/helpers/fake-http-node');

jest.mock('../logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({
  netGatewayFetch: jest.fn(),
  isOnionHostname: () => false,
}));
// The handler names the network in its provenance; the executors check
// URLs with the real registry's rules.
jest.mock('../networks/network-registry', () => ({
  ...jest.requireActual('../networks/network-registry'),
  getNetwork: jest.fn(() => ({ name: 'Ethereum' })),
}));
jest.mock('./chain', () => ({ chainDriver: jest.fn(() => null) }));

const chain = require('./chain');
const {
  APPROVAL_HEADER,
  GATE_HEADER,
  PROVENANCE_HEADER,
  createOnchainAppTrustState,
  decodeOnchainProvenance,
  handleOnchainAppRequest,
} = require('../onchain/onchain-app-protocol');

const binary = process.env.FREEDOM_CORED_PATH;
// A real core reads on real timers; the 8 MiB case moves 16 MiB of hex.
jest.setTimeout(60_000);
const quietLog = { info() {}, warn() {}, error() {} };
const describeIfHtml = servesChainHtml(binary) ? describe : describe.skip;

const CONTRACT = '0x00000095643CFfA7D9fae407a84dfCB6406456c6';
const APP_URL = `web3://${CONTRACT.toLowerCase()}.eip155-1/`;
// The core's cap on a document (design 0006, `chain.html`).
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const TOO_LARGE = "html() response exceeds Freedom's 8 MiB limit";

// The ABI encoding of `html()`'s string result, built by hand: ethers takes
// seconds to encode the 8 MiB boundary documents.
function encodeHtml(html) {
  const bytes = Buffer.from(html, 'utf8');
  const word = (n) => n.toString(16).padStart(64, '0');
  const padding = (32 - (bytes.length % 32)) % 32;
  return `0x${word(32)}${word(bytes.length)}${bytes.toString('hex')}${'00'.repeat(padding)}`;
}

const hashOf = (html) => keccak256(Buffer.from(html, 'utf8'));

describeIfHtml('the web3: handler through the real core (design 0006, chain.html)', () => {
  let root;
  let client;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-chain-html-'));
  });
  afterEach(async () => {
    chain.chainDriver.mockReturnValue(null);
    await client?.stop();
    client = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A ready core configured with chain 1, read through Direct at
   * `world.url` (switched by a test), a source the user added when
   * `world.userConfigured`. The RPC answers `html()` with `world.html`
   * unless `world.answer` says otherwise. `wire` records the requests main
   * writes to the core; `exchanges` the RPC requests the executors make.
   */
  async function start() {
    const world = {
      url: 'https://a.example',
      userConfigured: true,
      html: '<h1>app</h1>',
      answer: null,
    };
    const registry = {
      getAllNetworks: () => ({
        1: {
          name: 'Ethereum',
          access: { readOrder: ['direct'], broadcastOrder: ['direct'] },
          quorum: { k: 1, m: 1, timeoutMs: 5000 },
        },
      }),
      getEndpoints: (_chainId, role) => (role === 'rpc' ? [world.url] : []),
      getEndpointSources: () =>
        world.userConfigured ? [{ id: 'mine', coverage: { 1: world.url } }] : [],
      getEndpointSourceList: () => [{ id: 'mine', builtin: false }],
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
      // The endpoints are scripted: none is asked its chain.
      checks: null,
    });
    const broadcasts = new BroadcastRecords();
    const exchanges = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      exchanges.push({ url, body, signal: init.signal });
      const answer = (await world.answer?.(body, url, init)) ?? {
        result: encodeHtml(world.html),
      };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer }), {
        status: 200,
      });
    };
    registerChainShell(client, config, { broadcasts, hop: makeHop({ fetch }) });
    registerChainVerified(client, config, { broadcasts, adapters: {} });
    const driver = new ChainDriver({ client, config, broadcasts });
    await client.start();
    await config.whenServing();
    const gen = client.current;
    const wire = [];
    const decoder = new FrameDecoder();
    const write = gen.child.stdin.write.bind(gen.child.stdin);
    gen.child.stdin.write = (bytes, ...rest) => {
      for (const { message } of decoder.push(bytes)) {
        if (message?.type === 'request') wire.push(message.method);
      }
      return write(bytes, ...rest);
    };
    chain.chainDriver.mockReturnValue(driver);
    return { world, config, exchanges, wire, gen };
  }

  const get = (headers = {}, signal) => new Request(APP_URL, { headers, signal });

  test('an 8 MiB document is served whole; one byte more is the core’s own 413', async () => {
    const x = await start();
    x.world.html = 'a'.repeat(MAX_HTML_BYTES);
    const served = await handleOnchainAppRequest(get());
    expect(served.status).toBe(200);
    expect(served.headers.get('x-freedom-onchain-app-source')).toBe('direct');
    expect(served.headers.get('x-freedom-onchain-app-verified')).toBe('false');
    const provenance = decodeOnchainProvenance(served.headers.get(PROVENANCE_HEADER));
    expect(provenance.htmlHash).toBe(hashOf(x.world.html));
    expect(provenance.trust.level).toBe('user-configured');
    expect(provenance.trust.agreed).toEqual(['a.example']);
    const text = await served.text();
    expect(text.length).toBe(MAX_HTML_BYTES);
    expect(text === x.world.html).toBe(true);
    // The core called html() as today's handler did.
    expect(x.exchanges[0].body).toMatchObject({
      method: 'eth_call',
      params: [{ to: CONTRACT, data: '0x33c34ac3' }, 'latest'],
    });

    x.world.html = 'a'.repeat(MAX_HTML_BYTES + 1);
    const tooLarge = await handleOnchainAppRequest(get());
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.text()).resolves.toBe(TOO_LARGE);
  });

  // Deviation `web3-413`: only the core's own size error is a 413.
  test('a node’s error carrying the size code is a 502', async () => {
    const x = await start();
    x.world.answer = () => ({ error: { code: 'ONCHAIN_APP_TOO_LARGE', message: TOO_LARGE } });
    const res = await handleOnchainAppRequest(get());
    expect(res.status).toBe(502);
    await expect(res.text()).resolves.toContain('did not return a valid ERC-8244');
  });

  test('a document that does not decode is a 502', async () => {
    const x = await start();
    x.world.answer = () => ({ result: '0x' });
    expect((await handleOnchainAppRequest(get())).status).toBe(502);
  });

  test('an unverified endpoint’s document is gated, and its approval needs no second read', async () => {
    const x = await start();
    x.world.userConfigured = false;
    await x.config.configure();
    const trustState = createOnchainAppTrustState();
    const blocked = await handleOnchainAppRequest(get(), { trustState });
    expect(blocked.status).toBe(451);
    const gate = new URL(
      Buffer.from(blocked.headers.get(GATE_HEADER), 'base64url').toString('utf8')
    );
    expect(gate.searchParams.get('hash')).toBe(hashOf(x.world.html));
    expect(gate.searchParams.get('source')).toBe('a.example');
    const token = gate.searchParams.get('token');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const approved = await handleOnchainAppRequest(get({ [APPROVAL_HEADER]: token }), {
      trustState,
    });
    expect(approved.status).toBe(200);
    await expect(approved.text()).resolves.toBe(x.world.html);
    expect(x.wire.filter((method) => method === 'chain.html')).toHaveLength(1);
  });

  // Deviation `web3-cancel`: the abort reaches the core, and the core's
  // read of the node is cancelled with it.
  test('an aborted navigation cancels the core’s read', async () => {
    const x = await start();
    x.world.answer = (_body, _url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const controller = new AbortController();
    const pending = handleOnchainAppRequest(get({}, controller.signal));
    await waitFor(() => x.exchanges.length === 1, { what: 'the node read to start' });
    controller.abort();
    const res = await pending;
    expect(res.status).toBe(504);
    await waitFor(() => x.exchanges[0].signal.aborted, {
      what: "the core to cancel the node's read",
    });
    expect(x.wire.filter((method) => method === 'chain.html')).toHaveLength(1);
  });

  test("the handler's deadline cancels the read too", async () => {
    const x = await start();
    x.world.answer = (_body, _url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const res = await handleOnchainAppRequest(get(), { timeoutMs: 500 });
    expect(res.status).toBe(504);
    await waitFor(() => x.exchanges[0]?.signal.aborted, {
      what: "the core to cancel the node's read",
    });
  });

  // A configuration change while the read runs: the core answers it under
  // the old generation, and main sends it again once, under the new one.
  test('a configuration change mid-read is answered under the new configuration', async () => {
    const x = await start();
    let change;
    x.world.answer = async (_body, url) => {
      if (url.includes('a.example')) {
        x.world.url = 'https://b.example';
        change = x.config.configure();
        await change;
        return { result: encodeHtml('<h1>from a</h1>') };
      }
      return { result: encodeHtml('<h1>from b</h1>') };
    };
    const res = await handleOnchainAppRequest(get());
    await change;
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('<h1>from b</h1>');
    expect(x.exchanges.map(({ url }) => new URL(url).host)).toEqual(['a.example', 'b.example']);
    expect(x.wire.filter((method) => method === 'chain.html')).toHaveLength(2);
  });
});
