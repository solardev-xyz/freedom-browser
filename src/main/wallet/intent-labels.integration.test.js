/**
 * The wallet's finality labels against the real freedom-cored, with the
 * #712 review's modes: a k=3, m=2 quorum over three endpoints, where A is
 * honest, B is honest but lagging or on an unfinalized fork, and X lies,
 * copying whichever view a mode says. The faster agreeing pair wins each
 * read, so separate reads can be agreed by different honest views, with
 * the core's own trust envelopes (source quorum, verified, m=2, achieved).
 * Skipped unless FREEDOM_CORED_PATH points at a build with the chain
 * thread, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/wallet
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Wallet, Transaction, keccak256 } = require('ethers');
const { CoreClient } = require('../core/core-client');
const { makeHop } = require('../core/naming-shell');
const { ChainConfig } = require('../core/chain-config');
const { BroadcastRecords } = require('../core/chain-broadcasts');
const { registerChainShell } = require('../core/chain-shell');
const { registerChainVerified } = require('../core/chain-verified');
const { ChainDriver } = require('../core/chain-driver');
const { servesChain } = require('../../../test/helpers/core-chain-probe');
const { fakeFinalityChain } = require('../../../test/helpers/fake-finality-chain');

let mockStore;
const mockBroadcast = jest.fn();
jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({
  netGatewayFetch: jest.fn(),
  isOnionHostname: () => false,
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir() } }));
jest.mock('./chains', () => ({ getTxExplorerUrl: () => null }));
// The send path's own reads and broadcasts (the keyed retry), scripted.
jest.mock('../networks/chain-data', () => ({
  request: async (_chainId, method) => {
    if (method === 'eth_getTransactionCount') return { result: '0x8', source: 'direct' };
    throw new Error(`unscripted ${method}`);
  },
  broadcastRawTransaction: (...args) => mockBroadcast(...args),
  getFeeQuote: async () => ({ type: 'eip1559', maxFeePerGas: '2', maxPriorityFeePerGas: '1' }),
}));
jest.mock('./intent-store', () => ({
  ...jest.requireActual('./intent-store'),
  getIntentStore: () => mockStore,
}));

const { readLabel, LABELS } = require('./intent-labels');
const { createIntentTracker } = require('./intent-tracker');
const { createIntentStore } = require('./intent-store');

const binary = process.env.FREEDOM_CORED_PATH;
// A real core reads on real timers.
jest.setTimeout(60_000);
const quietLog = { info() {}, warn() {}, error() {} };
const describeIfChain = servesChain(binary) ? describe : describe.skip;

// A public test key, never funded.
const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const SENDER = ALICE.address.toLowerCase();
const TO = '0x1111111111111111111111111111111111111111';
const OTHER = `0x${'ee'.repeat(32)}`;
const A = 'https://a.example';
const B = 'https://b.example';
const X = 'https://x.example';

describeIfChain('finality labels over a real core quorum (#712 review)', () => {
  let root;
  let client;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-labels-'));
    mockBroadcast.mockReset();
  });
  afterEach(async () => {
    await client?.stop();
    client = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A ready core reading chain 1 through a k=3, m=2 quorum over A, B and X.
   * `mode.b` names B's view; `mode.x(route)` the view X copies for a read;
   * `mode.slow(url, route)` the endpoints that answer late for a read, so
   * the other two agree first.
   */
  async function start(chain, mode) {
    const registry = {
      getAllNetworks: () => ({
        1: {
          name: 'Ethereum',
          access: { readOrder: ['quorum'], broadcastOrder: ['direct'] },
          quorum: { k: 3, m: 2, timeoutMs: 5000 },
        },
      }),
      getEndpoints: (_chainId, role) => (role === 'rpc' ? [A, B, X] : []),
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
      // The endpoints are scripted: none is asked its chain.
      checks: null,
    });
    const broadcasts = new BroadcastRecords();
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const route =
        body.method === 'eth_getBlockByNumber' && body.params[0] !== 'finalized'
          ? 'eth_getBlockByNumber:number'
          : body.method;
      const view = url.startsWith(A) ? 'canonical' : url.startsWith(B) ? mode.b : mode.x(route);
      let reply;
      try {
        reply = { result: chain.answerFrom(view, body.method, body.params) };
      } catch (err) {
        reply = { error: { code: -32000, message: err.message } };
      }
      await new Promise((resolve) => setTimeout(resolve, mode.slow?.(url, route) ? 150 : 1));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...reply }), {
        status: 200,
      });
    };
    registerChainShell(client, config, { broadcasts, hop: makeHop({ fetch }) });
    registerChainVerified(client, config, { broadcasts, adapters: {} });
    const driver = new ChainDriver({ client, config, broadcasts });
    await client.start();
    await config.whenServing();
    const replies = [];
    const request = async (...args) => {
      const reply = await driver.request(...args);
      replies.push({ method: args[1], reply });
      return reply;
    };
    return { request, replies };
  }

  // Our transaction at nonce 7, signed for real.
  async function signed() {
    const tx = {
      type: 2,
      chainId: 1,
      nonce: 7,
      to: TO,
      value: 1n,
      gasLimit: 21000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    };
    const raw = await ALICE.signTransaction(tx);
    return { raw, hash: keccak256(raw) };
  }

  // split-fork-paid: X copies A for the finalized block and the nonce, and
  // B's unfinalized fork (where our transaction is, at 90) for the receipt
  // and the headers by number; A answers those late.
  function splitForkPaid(hash, status = 1) {
    const chain = fakeFinalityChain({ sender: SENDER, startNonce: 7, txs: {} });
    chain.defineView('fork', {
      forkAt: 80,
      forkTxs: { 90: [{ hash, nonce: 7, status }] },
      finalized: 80,
    });
    const forked = new Set(['eth_getTransactionReceipt', 'eth_getBlockByNumber:number']);
    return {
      chain,
      mode: {
        b: 'fork',
        x: (route) => (forked.has(route) ? 'fork' : 'canonical'),
        slow: (url, route) =>
          url === A ? forked.has(route) : url === B ? !forked.has(route) : false,
      },
    };
  }

  test("an honest quorum labels a payment paid, on the core's trust envelopes", async () => {
    const { hash } = await signed();
    const chain = fakeFinalityChain({
      sender: SENDER,
      startNonce: 7,
      txs: { 90: [{ hash, nonce: 7, status: 1 }] },
    });
    const { request, replies } = await start(chain, { b: 'canonical', x: () => 'canonical' });
    const intent = {
      intentId: 'review-0001',
      chainId: 1,
      sender: SENDER,
      nonce: 7,
      hashes: [{ hash }],
    };
    await expect(readLabel(intent, { request })).resolves.toMatchObject({
      label: LABELS.PAID,
      hash,
    });
    for (const { reply } of replies) {
      expect(reply).toMatchObject({
        source: 'quorum',
        verified: true,
        trust: { level: 'verified', method: 'quorum', quorum: { k: 3, m: 2, achieved: true } },
      });
    }
  });

  test('split-fork-paid: a receipt from an unfinalized fork is never paid or failed', async () => {
    for (const status of [1, 0]) {
      const { hash } = await signed();
      const { chain, mode } = splitForkPaid(hash, status);
      const { request, replies } = await start(chain, mode);
      const intent = {
        intentId: 'review-0002',
        chainId: 1,
        sender: SENDER,
        nonce: 7,
        hashes: [{ hash }],
      };
      const label = await readLabel(intent, { request });
      expect(label).toMatchObject({ label: LABELS.HELD });
      // The fork's receipt did come back, agreed by X and B.
      const receipt = replies.find(({ method }) => method === 'eth_getTransactionReceipt');
      expect(receipt.reply.result).toMatchObject({
        transactionHash: hash,
        blockHash: chain.forkHash(90),
      });
      await client.stop();
      client = null;
    }
  });

  test("split-evidence: a lagging pair's null receipt for a paid transaction is never taken", async () => {
    const { hash } = await signed();
    const chain = fakeFinalityChain({
      sender: SENDER,
      startNonce: 7,
      txs: { 90: [{ hash, nonce: 7, status: 1 }] },
    });
    chain.defineView('lagging', { head: 85, finalized: 80 });
    const lagged = new Set(['eth_getTransactionReceipt']);
    const { request } = await start(chain, {
      b: 'lagging',
      x: (route) => (lagged.has(route) ? 'lagging' : 'canonical'),
      slow: (url, route) =>
        url === A ? lagged.has(route) : url === B ? !lagged.has(route) : false,
    });
    const intent = {
      intentId: 'review-0003',
      chainId: 1,
      sender: SENDER,
      nonce: 7,
      hashes: [{ hash }],
    };
    await expect(readLabel(intent, { request })).resolves.toMatchObject({ label: LABELS.HELD });
  });

  test('missing-block-hashes: a receipt and blocks without hashes stay held', async () => {
    const { hash } = await signed();
    const chain = fakeFinalityChain({
      sender: SENDER,
      startNonce: 7,
      txs: { 90: [{ hash, nonce: 7, status: 1 }] },
    });
    chain.reshape('eth_getTransactionReceipt', (answer) => {
      const { blockHash: _, ...rest } = answer;
      return rest;
    });
    chain.reshape('eth_getBlockByNumber:number', (answer) => answer && { number: answer.number });
    chain.reshape('eth_getBlockByHash', (answer) => answer && { number: answer.number });
    const { request } = await start(chain, { b: 'canonical', x: () => 'canonical' });
    const intent = {
      intentId: 'review-0004',
      chainId: 1,
      sender: SENDER,
      nonce: 7,
      hashes: [{ hash }],
    };
    await expect(readLabel(intent, { request })).resolves.toMatchObject({ label: LABELS.HELD });
  });

  test('undefined-receipt: an answer with no result is not absence, so never taken', async () => {
    const { hash } = await signed();
    const chain = fakeFinalityChain({
      sender: SENDER,
      startNonce: 7,
      txs: { 90: [{ hash: OTHER, nonce: 7 }] },
    });
    chain.reshape('eth_getTransactionReceipt', () => undefined);
    const { request, replies } = await start(chain, { b: 'canonical', x: () => 'canonical' });
    const intent = {
      intentId: 'review-0005',
      chainId: 1,
      sender: SENDER,
      nonce: 7,
      hashes: [{ hash }],
    };
    await expect(readLabel(intent, { request })).resolves.toMatchObject({ label: LABELS.HELD });
    const receipt = replies.find(({ method }) => method === 'eth_getTransactionReceipt');
    expect(receipt.reply.result).toBeUndefined();
  });

  test('false-paid-key-retry: the intent stays held and keyed, so its retry resends nonce 7, never signs 8', async () => {
    const { raw, hash } = await signed();
    mockStore = createIntentStore({ filePath: path.join(root, 'intents.jsonl') });
    await mockStore.load();
    const key = 'review-payment-operation';
    const original = await mockStore.commit({
      chainId: 1,
      sender: SENDER,
      nonce: 7,
      raw,
      hash,
      via: 'original',
      context: { kind: 'wallet-send', key },
    });
    const { chain, mode } = splitForkPaid(hash);
    const { request } = await start(chain, mode);
    const tracker = createIntentTracker({
      store: mockStore,
      request,
      recordSettlement: jest.fn(),
      coreReady: () => true,
    });
    await tracker.pass();
    tracker.stop();
    expect(mockStore.get(original.intentId).state).toBe('held');
    expect(mockStore.byKey(key)?.intentId).toBe(original.intentId);

    // The same operation, sent again by its key: the held bytes, at 7.
    mockBroadcast.mockImplementation(async (_chainId, bytes) => ({
      result: keccak256(bytes),
      source: 'direct',
    }));
    const signer = { getAddress: async () => ALICE.address, signTransaction: jest.fn() };
    const { signAndSendTransaction } = require('./transaction-service');
    const again = await signAndSendTransaction(
      {
        chainId: 1,
        to: TO,
        value: '1',
        gasLimit: '21000',
        maxFeePerGas: '2',
        maxPriorityFeePerGas: '1',
      },
      signer,
      { intentKey: key, context: { kind: 'wallet-send' } }
    );
    expect(again.intentId).toBe(original.intentId);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(mockBroadcast.mock.calls.map(([, bytes]) => Transaction.from(bytes).nonce)).toEqual([7]);
  });
});
