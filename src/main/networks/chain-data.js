/**
 * Chain data for main's callers: the wallet, the `web3:` handler, the Ant
 * bridge and publish setup. A read, a fee quote or a broadcast is a
 * `chain.*` request to the core, through main's drivers
 * (core/chain-driver.js): the core routes it as the JS router it replaced
 * did (freedom-core design 0005; the pinned chain-data-router.js of
 * freedom-browser fb540328 is its reference). The calls keep the router's
 * signatures and results, with the design's deviations:
 *
 * - `request(chainId, method, params, options)` takes `includeTrust`,
 *   `routingContext`, `signal` and `background` as the router did; the Ant
 *   bridge's log scans name their options as one profile, `ant_scan`.
 * - `getFeeReference(chainId, options)` is the core's `chain.fee_reference`:
 *   the evidence the wallet's fee check reads (design 0005, A), new with
 *   the core, not one of the router's calls.
 * - `chainHtml(chainId, contract, options)` is the `web3:` handler's
 *   `html()` read as the core's `chain.html` (design 0006): the document
 *   decoded, capped, hashed and classified there, within the handler's
 *   deadline and cancelled with its signal (core/chain-driver.js).
 * - `broadcastRawTransaction()` resolves `{ result, source }` once sent, and
 *   `{ result, source, outcome: 'uncertain' }` when the transaction may
 *   have been sent; `rejected` and `not_sent` throw today's error, tagged
 *   with that `outcome` (Broadcast).
 *
 * `isReadMethod` stays in main (Methods main calls): a read of anything
 * else is refused here, with the router's text, before the core is asked.
 */

const READ_METHODS = new Set([
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getLogs',
  'web3_clientVersion',
  'web3_sha3',
]);

// Served by one direct endpoint only: the core routes them there.
const SINGLE_NODE_METHODS = new Set([
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_uninstallFilter',
  'web3_clientVersion',
  'web3_sha3',
]);

function isReadMethod(method) {
  return READ_METHODS.has(method) || SINGLE_NODE_METHODS.has(method);
}

// The core's drivers. Without them (the core not attached yet, or stopped
// for good), a call fails as the driver's own does when no core process
// serves it.
function chainDriver() {
  const { chainDriver: attached } = require('../core/chain');
  const driver = attached();
  if (!driver) {
    const { UNAVAILABLE } = require('../core/chain-driver');
    throw new Error(UNAVAILABLE);
  }
  return driver;
}

async function request(chainId, method, params = [], options = {}) {
  if (!isReadMethod(method)) throw new Error(`Unsupported read method: ${method}`);
  return chainDriver().request(chainId, method, params, options);
}

async function getFeeQuote(chainId) {
  return chainDriver().feeQuote(chainId);
}

// The evidence for the fee check at confirmation (design 0005, A):
// `{ header, lowest_priority, quote }`, within `options.deadlineMs`.
async function getFeeReference(chainId, options = {}) {
  return chainDriver().feeReference(chainId, options);
}

async function chainHtml(chainId, contract, options = {}) {
  return chainDriver().chainHtml(chainId, contract, options);
}

async function broadcastRawTransaction(chainId, rawTransaction, { signal } = {}) {
  let driver;
  try {
    driver = chainDriver();
  } catch (err) {
    err.outcome = 'not_sent';
    throw err;
  }
  return driver.broadcast(chainId, rawTransaction, { signal });
}

module.exports = {
  READ_METHODS,
  SINGLE_NODE_METHODS,
  isReadMethod,
  request,
  getFeeQuote,
  getFeeReference,
  chainHtml,
  broadcastRawTransaction,
};
