/**
 * How much a finality tracker pass keeps live while it walks headers, run
 * as `node --expose-gc test/helpers/finality-memory-probe.js <depth> <txs>`
 * (intent-labels.memory.test.js). One intent whose receipt is `depth`
 * blocks below the finalized block: the pass walks `depth` headers, each
 * a JSON-parsed reply with `txs` transaction hashes, as an RPC answers
 * `eth_getBlockByNumber(n, false)`. Prints the live heap's largest
 * increase during the walk (sampled after a GC every 256 headers), what is
 * left after the pass, and the reads made, as one JSON line.
 */
'use strict';

const Module = require('node:module');
const path = require('node:path');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../logger') return quiet;
  return load.call(this, request, parent, isMain);
};

const { createIntentTracker } = require(
  path.join(__dirname, '../../src/main/wallet/intent-tracker')
);

const depth = Number(process.argv[2] || 512);
const txCount = Number(process.argv[3] || 1024);
const H = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const sender = `0x${'11'.repeat(20)}`;
const hash = `0x${'aa'.repeat(32)}`;
const top = depth + 1;

let state = 'held';
const intent = {
  intentId: 'memory-probe',
  chainId: 1,
  sender,
  nonce: 7,
  hashes: [{ hash }],
  handoffs: [],
};
const store = {
  ready: Promise.resolve(),
  held: () => (state === 'held' ? [{ ...intent, state }] : []),
  get: () => ({ ...intent, state }),
  settle: async () => {
    state = 'settled';
  },
  onChange: () => () => {},
};

let headers = 0;
let active = 0;
let maxActive = 0;
let peak = 0;
const block = (n) => ({
  number: `0x${n.toString(16)}`,
  hash: H(n),
  parentHash: H(n - 1),
  transactions: [],
});

const tracker = createIntentTracker({
  store,
  coreReady: () => true,
  recordSettlement() {},
  request: async (_chainId, method, params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    let result;
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? top : Number(BigInt(params[0]));
      result = block(n);
      if (params[0] !== 'finalized') {
        result.transactions = Array.from({ length: txCount }, (_, i) =>
          H(1_000_000 + n * txCount + i)
        );
        headers += 1;
      }
    } else if (method === 'eth_getTransactionCount') {
      result = '0x8';
    } else if (method === 'eth_getTransactionReceipt') {
      result = {
        transactionHash: hash,
        from: sender,
        blockNumber: '0x1',
        blockHash: H(1),
        status: '0x1',
      };
    } else {
      throw new Error(`unscripted ${method}`);
    }
    // A decoded RPC reply: flat strings, as the driver hands them over.
    const reply = JSON.parse(
      JSON.stringify({
        result,
        source: 'quorum',
        verified: true,
        trust: { level: 'verified', method: 'quorum', quorum: { k: 3, m: 2, achieved: true } },
      })
    );
    if (headers % 256 === 0 || headers === depth) {
      global.gc();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    active -= 1;
    return reply;
  },
});

global.gc();
const before = process.memoryUsage().heapUsed;
tracker
  .pass()
  .then(() => {
    global.gc();
    const after = process.memoryUsage().heapUsed;
    process.stdout.write(
      `${JSON.stringify({
        depth,
        txCount,
        headers,
        settled: state === 'settled',
        maxActive,
        liveHeapIncrease: peak - before,
        retainedAfterPass: after - before,
      })}\n`
    );
  })
  .catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
