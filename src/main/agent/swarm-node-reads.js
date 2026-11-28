'use strict';

/**
 * The agent's reads of the Swarm node that no core method serves
 * (freedom-core design 0015, "Every bee-js call, mapped"; the SWM-6 to
 * SWM-9 plan's point 12 and PR 8.4), on the core's Swarm backend:
 *
 * - `getGlobalBatch(id)`: a batch as the chain holds it, `GET /batches/<id>`
 *   (bee-js's `stamp.getGlobal`), and `getChainState()`: `GET /chainstate`
 *   (`status.getChainState`), which swarm-postage-readiness.js reads;
 * - `verifyReachable(reference)`: the publication controller's retrieval
 *   check, `GET /bytes/<reference>` (`data.download`), its body read to the
 *   end and dropped.
 *
 * Each is one dial of the node's transport, ant-storage-api.js's `antGet`
 * (PR 8.1: undici on loopback, a remote node on the default session's stack
 * with its GET announced to the Ant API guard), never retried, and read as
 * bee-js 13.2.0 reads it, so the agent sees the values and errors it saw:
 *
 * - a reply outside 2xx throws bee-js's `BeeResponseError` text, the status
 *   text and the body (`<status text>: <body>`, the body re-serialized when
 *   it is JSON, the status text alone when it is empty), with `status`;
 * - a failure before any reply throws bee-js's text for it: `Request
 *   aborted` for an abort, else the error's message and its cause's;
 * - a 2xx JSON reply is parsed as bee-js parses it (an empty body is null)
 *   and checked as its zod schema checks it (`GetGlobalPostageBatchResponse`,
 *   `GetChainStateResponse`): a missing member, one of another type, a
 *   number that isn't finite, a batch ID or owner that isn't hex of its
 *   length, or an amount that isn't an integer string throws. The values
 *   are mapped as bee-js maps them: the batch's ID and owner as lowercase
 *   hex (`BatchId`, `EthAddress`), its value kept as the integer string;
 *   the chain's `currentPrice` as a number at least 24,000
 *   (`normalizeCurrentPrice`), `minimumValidityBlocks` only when the node
 *   sent it; any other member dropped.
 *
 * Main holds at most 1 MiB of a JSON reply and 64 KiB of an error body
 * (bee-js reads either whole); these replies are a few hundred bytes.
 */

const READ_TIMEOUT_MS = 10_000;
// The controller's own bound on the retrieval check (its 30 s `observe`).
const VERIFY_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
// bee-js's `normalizeCurrentPrice` floor.
const MIN_CURRENT_PRICE = 24_000;

// core-sdk's `Bytes` reads hex of its length, either case, an optional 0x.
const BATCH_ID = /^(?:0x)?[0-9a-fA-F]{64}$/;
const ADDRESS = /^(?:0x)?[0-9a-fA-F]{40}$/;
const REFERENCE = /^(?:0x)?(?:[0-9a-fA-F]{64}){1,2}$/;
// bee-js's `asNumberString`.
const INTEGER_STRING = /^-?\d+$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const lowerHex = (text) => text.replace(/^0x/, '').toLowerCase();
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** bee-js http's `toBeeError`: what a failure before any reply reads as. */
function transportError(err) {
  if (err?.name === 'AbortError') return new Error('Request aborted');
  const cause = err?.cause;
  return new Error(cause?.message ? `${err?.message}: ${cause.message}` : err?.message);
}

/**
 * The reply's body as text, at most `max` bytes of it: past that, the body
 * is cancelled and, with `cut`, the text is what came; without it, the read
 * fails.
 */
async function bodyText(response, signal, max, { cut = false } = {}) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const onAbort = () => reader.cancel(signal.reason).catch(() => {});
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      // A cancelled body ends as if it were done: the abort decides.
      if (signal?.aborted) throw signal.reason;
      if (next.done) break;
      const room = max - total;
      if (next.value.byteLength > room) {
        if (!cut) throw new Error('Swarm node reply too large');
        parts.push(next.value.subarray(0, room));
        total = max;
        reader.cancel().catch(() => {});
        break;
      }
      parts.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(parts, total).toString('utf8');
}

/** bee-js http's `throwHttpError`: a reply outside 2xx. */
async function replyError(response, signal) {
  let raw;
  try {
    raw = await bodyText(response, signal, MAX_ERROR_BYTES, { cut: true });
  } catch {
    // bee-js's `res.text().catch(() => '')`.
    raw = '';
  }
  let data;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  const bodyMsg = typeof data === 'string' ? data : JSON.stringify(data);
  const statusText = response.statusText ?? '';
  const err = new Error(bodyMsg ? `${statusText}: ${bodyMsg}` : statusText);
  err.status = response.status;
  err.statusText = statusText;
  return err;
}

/**
 * `GET <path>` on the node's transport, bounded by `timeoutMs` in all, its
 * reply read by `read(response, signal)` once it is 2xx.
 */
async function nodeGet(path, timeoutMs, read, { antGet } = {}) {
  const get = antGet || require('../swarm/ant-storage-api').antGet;
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await get(path, { signal });
  } catch (err) {
    throw transportError(err);
  }
  if (response.status < 200 || response.status > 299) throw await replyError(response, signal);
  try {
    return await read(response, signal);
  } catch (err) {
    throw transportError(err);
  }
}

/** A 2xx JSON reply, parsed as bee-js parses it (an empty body is null). */
async function jsonOf(response, signal) {
  const text = await bodyText(response, signal, MAX_JSON_BYTES);
  return text ? JSON.parse(text) : null;
}

function schemaError(what) {
  return new TypeError(`The node's ${what} reply is not one bee-js reads`);
}

/**
 * `GetGlobalPostageBatchResponse` (bee-js 13.2.0, types/schema/stamps.js),
 * mapped: `batchID` and `owner` as lowercase hex, `value` the integer
 * string. Throws where its schema throws.
 */
function readGlobalBatch(data) {
  if (!isObject(data)) throw schemaError('/batches');
  const { batchID, batchTTL, bucketDepth, depth, immutable, owner, start, value } = data;
  if (
    typeof batchID !== 'string' ||
    !BATCH_ID.test(batchID) ||
    !finite(batchTTL) ||
    !finite(bucketDepth) ||
    !finite(depth) ||
    typeof immutable !== 'boolean' ||
    typeof owner !== 'string' ||
    !ADDRESS.test(owner) ||
    !finite(start) ||
    typeof value !== 'string' ||
    !INTEGER_STRING.test(value)
  ) {
    throw schemaError('/batches');
  }
  return {
    batchID: lowerHex(batchID),
    batchTTL,
    bucketDepth,
    depth,
    immutable,
    owner: lowerHex(owner),
    start,
    value,
  };
}

/**
 * `GetChainStateResponse` (bee-js 13.2.0, types/schema/states.js), mapped:
 * `currentPrice` as `Number` gives it, at least 24,000 and an integer
 * (`normalizeCurrentPrice`); `minimumValidityBlocks` only when sent.
 */
function readChainState(data) {
  if (!isObject(data)) throw schemaError('/chainstate');
  const { block, chainTip, totalAmount, currentPrice } = data;
  const validity = Object.hasOwn(data, 'minimumValidityBlocks');
  if (
    !finite(block) ||
    !finite(chainTip) ||
    typeof totalAmount !== 'string' ||
    !INTEGER_STRING.test(totalAmount) ||
    typeof currentPrice !== 'string' ||
    (validity && !finite(data.minimumValidityBlocks))
  ) {
    throw schemaError('/chainstate');
  }
  const price = Number(currentPrice);
  return {
    block,
    chainTip,
    totalAmount,
    currentPrice: Number.isInteger(price) && price >= MIN_CURRENT_PRICE ? price : MIN_CURRENT_PRICE,
    ...(validity && { minimumValidityBlocks: data.minimumValidityBlocks }),
  };
}

/**
 * The node's reads, over `deps.antGet` (ant-storage-api.js's by default).
 *
 * @param {{ antGet?: Function }} [deps]
 */
function createNodeReads(deps = {}) {
  return Object.freeze({
    /** bee-js's `stamp.getGlobal(id)`: refused, undialled, for an ID that isn't one. */
    async getGlobalBatch(id) {
      if (typeof id !== 'string' || !BATCH_ID.test(id)) throw new TypeError('Invalid batch ID');
      const data = await nodeGet(`/batches/${lowerHex(id)}`, READ_TIMEOUT_MS, jsonOf, deps);
      return readGlobalBatch(data);
    },

    /** bee-js's `status.getChainState()`. */
    async getChainState() {
      return readChainState(await nodeGet('/chainstate', READ_TIMEOUT_MS, jsonOf, deps));
    },

    /**
     * bee-js's `data.download(reference)` as the controller's check uses
     * it: true once the whole body has come, each piece dropped as it
     * comes; refused, undialled, for a reference that isn't one.
     */
    async verifyReachable(reference) {
      if (typeof reference !== 'string' || !REFERENCE.test(reference)) {
        throw new TypeError('Invalid reference');
      }
      return nodeGet(`/bytes/${lowerHex(reference)}`, VERIFY_TIMEOUT_MS, async (response, signal) => {
        if (!response.body) return true;
        const reader = response.body.getReader();
        const onAbort = () => reader.cancel(signal.reason).catch(() => {});
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        try {
          for (;;) {
            const next = await reader.read();
            if (signal.aborted) throw signal.reason;
            if (next.done) return true;
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      }, deps);
    },
  });
}

const nodeReads = createNodeReads();

module.exports = {
  READ_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  createNodeReads,
  getGlobalBatch: nodeReads.getGlobalBatch,
  getChainState: nodeReads.getChainState,
  verifyReachable: nodeReads.verifyReachable,
  readGlobalBatch,
  readChainState,
};
