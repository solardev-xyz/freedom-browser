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
 *   and parsed by bee-js's own schemas (`GetGlobalPostageBatchResponse`,
 *   `GetChainStateResponse`), copied member for member into zod, the
 *   library bee-js parses them with (the copy bee-js itself resolves), so a
 *   reply out of schema throws the error bee-js throws: zod's `ZodError`,
 *   its issues and its message naming each failing member with what was
 *   expected and what came, or, from a member's transform, the error of
 *   core-sdk's `BatchId` or `EthAddress` for a batch ID or owner that isn't
 *   hex of its length, and `asNumberString`'s for an amount that isn't an
 *   integer string. The values are mapped as bee-js maps them: the batch's
 *   ID and owner as lowercase hex (`toHex()`), its value kept as the
 *   integer string; the chain's `currentPrice` as a number at least 24,000
 *   (`normalizeCurrentPrice`), `minimumValidityBlocks` only when the node
 *   sent it; any other member dropped.
 *
 * Main holds at most 1 MiB of a JSON reply and 64 KiB of an error body
 * (bee-js reads either whole); these replies are a few hundred bytes.
 */

// bee-js's own dependency: the zod it resolves (no copy of its own under
// node_modules/@ethersphere/bee-js), so its errors are the ones bee-js throws.
const { z } = require('zod');

const READ_TIMEOUT_MS = 10_000;
// The controller's own bound on the retrieval check (its 30 s `observe`).
const VERIFY_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

const REFERENCE = /^(?:0x)?(?:[0-9a-fA-F]{64}){1,2}$/;

const lowerHex = (text) => text.replace(/^0x/, '').toLowerCase();

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

/**
 * `new BatchId(text)` (`length` 32) and `new EthAddress(text)` (20) of
 * core-sdk 0.2.2, bee-js's, for a string (dist/bytes/index.cjs: `Bytes`'s
 * constructor, with `HEX_PATTERN` and `hexToUint8Array`): the same checks
 * in the same order, each failure its error and text; the bytes as
 * `toHex()` gives them, lowercase without 0x.
 */
function hexBytes(text, length) {
  if (!text) throw new Error(`Bytes#constructor: constructor parameter is falsy: ${text}`);
  if (!/^(0x)?[0-9a-fA-F]*$/i.test(text) || text.replace(/^0x/i, '').length % 2 !== 0) {
    throw new Error(`Bytes#constructor: invalid hex string: ${text}`);
  }
  const hex = text.replace(/^0x/i, '').toLowerCase();
  if (hex.length / 2 !== length) {
    throw new Error(`Bytes#checkByteLength: bytes length is ${hex.length / 2} but expected ${length}`);
  }
  return hex;
}

/**
 * bee-js 13.2.0's `asNumberString` (dist/cjs/utils/type.js) for the string
 * its schemas hand it, with neither `min` nor `max`.
 */
function asNumberString(value, options) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new TypeError(`${options?.name ?? 'value'} is not a valid integer string, got: ${value}`);
  }
  return value;
}

/** bee-js 13.2.0's `normalizeCurrentPrice` (dist/cjs/utils/workaround.js). */
function normalizeCurrentPrice(currentPrice) {
  if (!Number.isInteger(currentPrice)) return 24000;
  if (currentPrice < 24000) return 24000;
  return currentPrice;
}

/**
 * bee-js 13.2.0's `GetGlobalPostageBatchResponse`
 * (dist/cjs/types/schema/stamps.js), member for member; `batchID` and
 * `owner` give the hex of the `BatchId` and `EthAddress` bee-js makes.
 */
const GetGlobalPostageBatchResponse = z.object({
  batchID: z.string().transform((s) => hexBytes(s, 32)),
  batchTTL: z.number(),
  bucketDepth: z.number(),
  depth: z.number(),
  immutable: z.boolean(),
  owner: z.string().transform((s) => hexBytes(s, 20)),
  start: z.number(),
  value: z.string().transform((s) => asNumberString(s, { name: 'value' })),
});

/**
 * bee-js 13.2.0's `GetChainStateResponse` (dist/cjs/types/schema/states.js),
 * member for member.
 */
const GetChainStateResponse = z.object({
  block: z.number(),
  chainTip: z.number(),
  totalAmount: z.string().transform((s) => asNumberString(s, { name: 'totalAmount' })),
  currentPrice: z
    .string()
    .transform(Number)
    .transform((s) => normalizeCurrentPrice(s)),
  minimumValidityBlocks: z.number().optional(),
});

/** A `/batches/<id>` reply as bee-js's `getGlobalPostageBatch` reads it: its schema's value, or its error. */
function readGlobalBatch(data) {
  return GetGlobalPostageBatchResponse.parse(data);
}

/** A `/chainstate` reply as bee-js's `getChainState` reads it: its schema's value, or its error. */
function readChainState(data) {
  return GetChainStateResponse.parse(data);
}

/**
 * The node's reads, over `deps.antGet` (ant-storage-api.js's by default).
 *
 * @param {{ antGet?: Function }} [deps]
 */
function createNodeReads(deps = {}) {
  return Object.freeze({
    /**
     * bee-js's `stamp.getGlobal(id)`: refused, undialled, for an ID that
     * isn't one, with `new BatchId(id)`'s error.
     */
    async getGlobalBatch(id) {
      if (typeof id !== 'string') throw new TypeError('Invalid batch ID');
      const data = await nodeGet(`/batches/${hexBytes(id, 32)}`, READ_TIMEOUT_MS, jsonOf, deps);
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
