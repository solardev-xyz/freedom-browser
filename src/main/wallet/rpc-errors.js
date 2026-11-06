/**
 * RPC errors as they may leave main (#1040).
 *
 * Main's own ethers providers (provider-manager.js) talk to the chain's
 * RPC pool, keyed providers included, and an Alchemy, Infura or dRPC URL
 * has the user's API key in its path. ethers puts the URL of a failed
 * exchange into its error: into the message, `info.requestUrl`, `request`
 * and `response`, and the response body it quotes can hold the key too.
 * Freedom-core design 0011 counts a compromised chrome renderer as an
 * attacker, and wallet handlers send `err.message` to it, so:
 *
 * - `endpointFailure`: what a pool provider throws in place of a failed
 *   exchange. No URL, no body, no cause: RPC_UNAVAILABLE and at most the
 *   HTTP status. The original goes to main's log only, its URLs cut to
 *   their origin as the diagnostics buffer cuts them.
 * - `providerRpcError`: an error as main's providers hand it to their
 *   callers, EIP-1193 shaped. A node's JSON-RPC error answer keeps its
 *   code, its text and its hex data; anything else is RPC_UNAVAILABLE
 *   with a fixed text.
 * - `redactedHandler`: the IPC layer's second line, for the wallet
 *   handlers that answer with `err.message`. The `error` of a reply, and
 *   the text of a thrown error, lose their URLs and every stored API key.
 */

const log = require('../logger');
const { redactUrls } = require('../url-redaction');
const { safeErrorMessage } = require('../networks/chain-errors');

const RPC_UNAVAILABLE = 'RPC_UNAVAILABLE';

/** `text` with no URL beyond its origin and no stored API key in it. */
function redactRpcText(text) {
  const withoutUrls = redactUrls(text);
  try {
    return require('../networks/network-registry').withoutApiKeys(withoutUrls);
  } catch {
    // A registry that can't load has no keys to substitute either.
    return withoutUrls;
  }
}

// Redacted before it is cut, so no cut leaves part of a URL or key behind.
function safeText(text) {
  const redacted = redactRpcText(text);
  return redacted ? safeErrorMessage({ message: redacted }) : '';
}

function coded(message, fields = {}) {
  return Object.assign(new Error(message), { code: RPC_UNAVAILABLE }, fields);
}

/**
 * A pool provider's failed exchange (its `_send`): an HTTP error status,
 * no answer, a timeout or an answer that is no JSON-RPC.
 *
 * @param {Error} err - ethers' error, with the request's URL in it
 * @param {{ chainId: number, method?: string }} context - for the log
 */
function endpointFailure(err, { chainId, method } = {}) {
  log.warn(
    `[ProviderManager] RPC request failed (chain ${chainId}, ${method ?? 'request'}):`,
    safeText(err?.message ?? err)
  );
  const status = Number(err?.response?.statusCode);
  // ethers reports a failure without an answer as its own 599.
  if (Number.isInteger(status) && status >= 400 && status < 599) {
    return coded(`RPC endpoint failed: HTTP ${status}`, { status });
  }
  if (err?.code === 'TIMEOUT') return coded('RPC endpoint failed: timeout');
  return coded('RPC endpoint failed');
}

/** The JSON-RPC error object a node answered with, as ethers keeps it. */
function nodeAnswer(err) {
  const answer = err?.info?.error ?? err?.error;
  return answer !== null &&
    typeof answer === 'object' &&
    !(answer instanceof Error) &&
    Number.isInteger(answer.code) &&
    typeof answer.message === 'string'
    ? answer
    : null;
}

/**
 * An error of main's providers as their callers get it.
 *
 * @param {Error} err - a pool provider's or the FallbackProvider's error
 * @param {number} chainId
 * @param {string} [chainName]
 * @returns {Error & { code: number|string, data?: string }}
 */
function providerRpcError(err, chainId, chainName) {
  const answer = nodeAnswer(err);
  if (answer) {
    const error = new Error(answer.message ? safeText(answer.message) : 'RPC error');
    error.code = answer.code;
    if (typeof answer.data === 'string' && /^0x[0-9a-fA-F]*$/.test(answer.data)) {
      error.data = answer.data;
    }
    return error;
  }
  const name = chainName || `chain ${chainId}`;
  const status = Number.isInteger(err?.status) ? ` (last: HTTP ${err.status})` : '';
  return coded(`No RPC endpoint for ${name} answered${status}`);
}

function redactValue(value, depth = 0) {
  if (typeof value === 'string') return redactRpcText(value);
  if (depth >= 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactValue(item, depth + 1)])
  );
}

/** A handler's reply with its `error` redacted. */
function redactedReply(reply) {
  if (reply === null || typeof reply !== 'object' || !Object.hasOwn(reply, 'error')) {
    return reply;
  }
  return { ...reply, error: redactValue(reply.error) };
}

/** A thrown error as the renderer gets it: its text, redacted. */
function redactedThrow(err) {
  const error = new Error(redactRpcText(err?.message ?? err));
  if (typeof err?.code === 'string' || Number.isInteger(err?.code)) error.code = err.code;
  return error;
}

/**
 * `listener` with its reply's `error` and its thrown errors redacted. A
 * synchronous handler stays synchronous.
 */
function redactedHandler(listener) {
  return (...args) => {
    let reply;
    try {
      reply = listener(...args);
    } catch (err) {
      throw redactedThrow(err);
    }
    if (reply && typeof reply.then === 'function') {
      return reply.then(redactedReply, (err) => {
        throw redactedThrow(err);
      });
    }
    return redactedReply(reply);
  };
}

module.exports = {
  RPC_UNAVAILABLE,
  redactRpcText,
  endpointFailure,
  providerRpcError,
  redactedReply,
  redactedHandler,
};
