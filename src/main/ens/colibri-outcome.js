/**
 * What main builds from freedom-colibrid's reply to `colibri.request`
 * (freedom-core design 0014, "What main builds from an answer"): exactly what
 * the WASM worker host's client gave its caller until COL-6 removed it, so
 * nothing downstream of the client changed with the backend.
 *
 * Three places made that outcome on the WASM path: the package's `request()`
 * rebuilt the C core's error with `ProviderRpcError.createError`
 * (`cjs/types.js:38–58`), the worker's `serializeError` cut its message to
 * 2,000 UTF-16 units and kept `code` and a string `data`, and the host's
 * `reviveError` made an `Error` of those fields again. The service hands
 * main the C core's status instead, with its error text whole, so main does
 * all three here:
 *
 * - `{ status: "success", result? }`: the result, `undefined` when absent;
 * - `{ status: "revert", data }`: `throwRevert`'s
 *   `ProviderRpcError(3, 'execution reverted', data)`. Only calls revert, and
 *   the service serves none, but the core still handles the shape (0005);
 * - `{ status: "error", error }`: `createError` of the whole text. Its message
 *   is `Error in rpc call <method><JSON.stringify(params)> : <text>`, with the
 *   method and params the client was given (an empty text reads
 *   `An unknown error occurred`). Its code comes from the whole text, by
 *   three rules in order: 4200 when it starts with `Method ` and ends with
 *   ` is not supported`; 4900 when it holds `HTTP error!`, `All nodes failed`
 *   or `Failed to fetch`, case-sensitive; else -32603, since a text carries
 *   no code of its own;
 * - the cut, last: the completed message's first 2,000 units, by
 *   `String.prototype.slice` as `serializeError` cut, so a cut can end on
 *   half of a surrogate pair, as it did. `name`, `code` and `data` aren't
 *   cut.
 *
 * Any other reply is none main knows: `replyOutcome` returns null, and its
 * caller treats it as the process's protocol error. Errors main makes itself
 * (`Colibri worker replaced: …`, `Colibri service busy`, `Colibri service
 * unavailable`) never come through here, so nothing cuts them, as the host
 * didn't cut its own. They are `ColibriWorkerError`s, the WASM host's class
 * with its name and fields (`colibriBystander`, `colibriRecycling`, a death's
 * fault text), which chain-verified's fault bit, the routers and #752's
 * backoff read.
 *
 * colibri-outcome.test.js holds these outcomes to the WASM path's, recorded
 * byte for byte before COL-6 removed it
 * (test/fixtures/colibri/reference-outcomes.json).
 */

/**
 * Main's own Colibri errors: what colibrid-client.js and colibri-service.js
 * make of a death, a refusal, a bound or the deadline. The WASM worker
 * host's class, kept by name: its marks (`colibriBystander`,
 * `colibriRecycling`) are set on each error.
 */
class ColibriWorkerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ColibriWorkerError';
  }
}

const MAX_ERROR_MESSAGE = 2000;
const UNKNOWN_ERROR = 'An unknown error occurred';
const TRANSPORT_TEXTS = ['HTTP error!', 'All nodes failed', 'Failed to fetch'];

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `createError`'s code for a text with no code of its own. */
function errorCode(text) {
  if (text.startsWith('Method ') && text.endsWith(' is not supported')) return 4200;
  if (TRANSPORT_TEXTS.some((transport) => text.includes(transport))) return 4900;
  return -32603;
}

/** The error the host revived from what the worker posted: the message cut,
 * the code, and the data only when it is a string. */
function adapterError(message, code, data) {
  const err = new Error(message.slice(0, MAX_ERROR_MESSAGE));
  err.name = 'ProviderRpcError';
  err.code = code;
  if (typeof data === 'string') err.data = data;
  return err;
}

function revertError(data) {
  return adapterError('execution reverted', 3, data);
}

/** `createError` of the C core's error `text`, for the request the client
 * was given. Concatenated as `createError` does it. */
function replyError(text, { method, params } = {}) {
  const message = text || UNKNOWN_ERROR;
  return adapterError(
    'Error in rpc call ' + (method || '') + JSON.stringify(params || []) + ' : ' + message,
    errorCode(message)
  );
}

/**
 * The adapter outcome of `reply`, the service's answer to `request`
 * (`{ method, params }`, as the client's caller passed them): `{ ok: true,
 * result }`, `{ ok: false, error }`, or null for a reply that is none of the
 * three.
 */
function replyOutcome(reply, request) {
  if (!isObject(reply)) return null;
  if (reply.status === 'success') return { ok: true, result: reply.result };
  if (reply.status === 'revert' && typeof reply.data === 'string') {
    return { ok: false, error: revertError(reply.data) };
  }
  if (reply.status === 'error' && typeof reply.error === 'string') {
    return { ok: false, error: replyError(reply.error, request) };
  }
  return null;
}

module.exports = { ColibriWorkerError, replyOutcome };
