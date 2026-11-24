/**
 * What Colibri 3.0.3 proves, as the browser asks it (freedom-core designs
 * 0005, "Colibri", and 0014, "What the service serves"): the read methods it
 * serves, and for each the block forms it ties to the requested block.
 *
 * This is freedom-core's `fc-colibri` (`colibri_request_params`, #279, which
 * is freedom-browser #1048's rule), ported, with `freedom-colibrid`'s own
 * check on top (`served.rs`). The core's router applies the rule before
 * Colibri is asked and the Colibri service applies it again to what main
 * sends it; main applies it a third time to the operation a
 * `shell.colibri_fetch` names, so a form the service doesn't serve admits no
 * fetch (`colibri-fetch-contract.js`). The texts are the service's, byte for
 * byte: `Method <m> is not supported` for a method outside the list, and
 * `Colibri cannot prove <method> <why>` for a block form outside #279's.
 *
 * Params are the caller's JSON text, as `colibri.request` carries them. Block
 * strings are compared exactly, after JSON decoding.
 */

/**
 * The read methods Colibri serves, in the router's `READ_METHODS` order:
 * every read method but the single-node ones, `eth_getLogs` and
 * {@link COLIBRI_UNPROVEN_METHODS}.
 */
const COLIBRI_SERVED_METHODS = Object.freeze([
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
]);

/**
 * The read methods Colibri never serves (#1046): `eth_gasPrice` and
 * `eth_feeHistory`, which 3.0.3 answers from a public RPC host (F-1), and
 * `eth_call` and `eth_estimateGas`, which it runs on unchecked code in
 * privacy mode (F-11).
 */
const COLIBRI_UNPROVEN_METHODS = Object.freeze([
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_call',
  'eth_estimateGas',
]);

/**
 * Where each served method takes its block parameter, as 3.0.3 reads it
 * (`eth_block_tag_index`), as `[method, position]` pairs. Methods not listed
 * take none (`eth_getBlockByHash`'s hash is at 0, but it isn't a block tag).
 */
const COLIBRI_BLOCK_PARAM = Object.freeze([
  Object.freeze(['eth_getBalance', 1]),
  Object.freeze(['eth_getCode', 1]),
  Object.freeze(['eth_getTransactionCount', 1]),
  Object.freeze(['eth_getStorageAt', 2]),
  Object.freeze(['eth_getBlockByNumber', 0]),
]);

/**
 * The account reads, which 3.0.3 ties to the requested block only at
 * `latest` (#1060), with the block last (F-12).
 */
const COLIBRI_LATEST_ONLY = Object.freeze([
  'eth_getBalance',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getStorageAt',
]);

/** How the refusal names a block that isn't a string. */
const COLIBRI_NOT_A_STRING = "at a block that isn't a string";

/** What `colibriLatestAppended` adds to the params' length, at most. */
const LATEST_APPENDED = ',"latest"';

const AS_SENT = Object.freeze({ kind: 'as-sent' });
const LATEST = Object.freeze({ kind: 'latest-appended' });

function refused(why) {
  return Object.freeze({ kind: 'refused', why });
}

/** `method`'s block parameter position, or `undefined`. */
function blockParam(method) {
  return COLIBRI_BLOCK_PARAM.find(([name]) => name === method)?.[1];
}

/** `0x` and at most 16 hex digits without a leading zero (`0x0` is one). */
function isBlockNumber(value) {
  return typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/.test(value);
}

/** `0x` and 64 hex digits. */
function isBlockHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * `colibriRequestParams(method, params)`: whether Colibri is asked this read,
 * and with what (`params` is JSON text):
 * - `{ kind: 'as-sent' }`: the params as sent (every method without a block
 *   rule, and params that don't parse, are asked as sent);
 * - `{ kind: 'latest-appended' }`: an account read without its block, which
 *   the router asks with `latest` appended;
 * - `{ kind: 'refused', why }`: refused before Colibri is asked; `why`
 *   completes `Colibri cannot prove <method> `.
 */
function colibriRequestParams(method, params) {
  let position = blockParam(method);
  if (position === undefined && method === 'eth_getBlockByHash') position = 0;
  if (position === undefined) return AS_SENT;
  let root;
  try {
    root = JSON.parse(params);
  } catch {
    return AS_SENT;
  }
  const latestOnly = COLIBRI_LATEST_ONLY.includes(method);
  const byHash = method === 'eth_getBlockByHash';
  if (!Array.isArray(root)) {
    if (byHash) return refused('without a block hash');
    // Colibri reads params that aren't an array as `[params]`, and `null` as
    // `[]`.
    if (latestOnly || root !== null) return refused("with params that aren't an array");
    return AS_SENT;
  }
  const length = root.length;
  if (latestOnly) {
    if (length === position) return LATEST;
    if (length < position || length > position + 1) {
      return refused(`with params of length ${length}`);
    }
  } else if (length <= position) {
    return byHash ? refused('without a block hash') : AS_SENT;
  }
  const block = root[position];
  if (typeof block !== 'string') return refused(COLIBRI_NOT_A_STRING);
  let served;
  if (latestOnly) served = block === 'latest';
  else if (byHash) served = isBlockHash(block);
  else served = block === 'latest' || isBlockNumber(block) || isBlockHash(block);
  return served ? AS_SENT : refused(`at block "${block}"`);
}

/**
 * `[...params, 'latest']` as `JSON.stringify` writes it, for params that are
 * an array (JSON text); `null` otherwise.
 */
function colibriLatestAppended(params) {
  let root;
  try {
    root = JSON.parse(params);
  } catch {
    return null;
  }
  return Array.isArray(root) ? JSON.stringify([...root, 'latest']) : null;
}

/**
 * The service's check (`served.rs`): `null` when it serves `method` with
 * `params` (JSON text), or the error text it answers instead. An account
 * read without its block counts as params too short: the router appends
 * `latest` before Colibri is asked, and the service never changes params.
 */
function colibriServiceRefusal(method, params) {
  if (!COLIBRI_SERVED_METHODS.includes(method)) return `Method ${method} is not supported`;
  const asked = colibriRequestParams(method, params);
  if (asked.kind === 'as-sent') return null;
  const why =
    asked.kind === 'latest-appended'
      ? `with params of length ${blockParam(method) ?? 0}`
      : asked.why;
  return `Colibri cannot prove ${method} ${why}`;
}

module.exports = {
  COLIBRI_SERVED_METHODS,
  COLIBRI_UNPROVEN_METHODS,
  COLIBRI_BLOCK_PARAM,
  COLIBRI_LATEST_ONLY,
  COLIBRI_NOT_A_STRING,
  LATEST_APPENDED,
  colibriRequestParams,
  colibriLatestAppended,
  colibriServiceRefusal,
  isBlockNumber,
  isBlockHash,
};
