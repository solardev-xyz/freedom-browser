/**
 * Ant storage API client (main process)
 *
 * The Swarm node routes the publish setup reads and writes:
 *
 *   - the Bee-compatible reads readiness is built from (`/health`, `/node`,
 *     `/readiness`, `/stamps`, `/addresses`, `/wallet`, `/chequebook/*`),
 *     and `/settlements` for the browsing credit (browsing-credit-service.js);
 *   - antd's xDAI storage routes: `GET /v0/storage/quote`,
 *     `POST /v0/storage/buy`, `POST /v0/storage/extend` and
 *     `GET|POST /v0/settlement/deposit`. The user sends plain xDAI to the node
 *     wallet; the node swaps it for xBZZ, buys or extends the batch and funds
 *     its chequebook.
 *
 * Every call resolves, never rejects, with `{ ok, status, data, message }`.
 * `status` is 0 when no HTTP response arrived; `notSent` then says whether
 * the request never left Freedom (no node URL), which matters for writes: a
 * write that timed out or lost its connection may still land on chain.
 *
 * Node's `fetch` never passes through `session.webRequest`, so the Ant API
 * guard does not see these calls (see ant-api-main-dials.js). Like the other
 * main-process Swarm call sites it does not honour `session.setProxy` (#360).
 */

const { getAntApiUrl } = require('../service-registry');

const READ_TIMEOUT_MS = 10_000;
// A quote reads the price oracle, both wallet balances and the chequebook
// over RPC; the node's RPC client has no timeout of its own.
const QUOTE_TIMEOUT_MS = 30_000;
// antd caps its storage handlers at 5 minutes; wait a little longer so its
// own 504 reaches us instead of a client-side abort.
const WRITE_TIMEOUT_MS = 330_000;

function apiBase() {
  const base = getAntApiUrl();
  return typeof base === 'string' && base ? base.replace(/\/+$/, '') : null;
}

function buildUrl(base, endpoint, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${base}${endpoint}${qs ? `?${qs}` : ''}`;
}

// Errors (undici puts the socket's on `cause`) raised before a connection
// existed: the request bytes never left Freedom. A reset or a socket closed
// mid-request is not one of them; the node may have acted on it.
const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isConnectFailure(err) {
  const causes = [err, err?.cause, err?.cause?.cause];
  return causes.some((e) => CONNECT_FAILURE_CODES.has(e?.code));
}

async function antRequest(
  method,
  endpoint,
  { query, timeoutMs = READ_TIMEOUT_MS, fetchImpl } = {}
) {
  const base = apiBase();
  if (!base) {
    return { ok: false, status: 0, data: null, message: null, notSent: true };
  }

  let response;
  let text;
  try {
    response = await (fetchImpl || fetch)(buildUrl(base, endpoint, query), {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      data: null,
      message: null,
      timedOut,
      unreachable: !timedOut,
      // No connection was ever made, so a write cannot have reached the node.
      refused: !timedOut && isConnectFailure(err),
    };
  }

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const message = typeof data?.message === 'string' && data.message ? data.message : null;
  return { ok: response.ok, status: response.status, data, message };
}

const getHealth = (opts) => antRequest('GET', '/health', opts);
const getNode = (opts) => antRequest('GET', '/node', opts);
const getReadiness = (opts) => antRequest('GET', '/readiness', opts);
const getStamps = (opts) => antRequest('GET', '/stamps', opts);
const getAddresses = (opts) => antRequest('GET', '/addresses', opts);
const getWallet = (opts) => antRequest('GET', '/wallet', opts);
const getChequebookAddress = (opts) => antRequest('GET', '/chequebook/address', opts);
const getChequebookBalance = (opts) => antRequest('GET', '/chequebook/balance', opts);
const getSettlements = (opts) => antRequest('GET', '/settlements', opts);

/**
 * Price a new batch (`{ depth, days }`) or an extension of an existing one
 * (`{ batchId, days, depth? }`; a `depth` resizes the batch and keeps its
 * expiry, `days` adds time on top).
 */
function getStorageQuote({ depth, days, batchId } = {}, opts = {}) {
  return antRequest('GET', '/v0/storage/quote', {
    timeoutMs: QUOTE_TIMEOUT_MS,
    ...opts,
    query: { batchId, depth, days },
  });
}

function buyStorage({ depth, amountPerChunk, immutable }, opts = {}) {
  return antRequest('POST', '/v0/storage/buy', {
    timeoutMs: WRITE_TIMEOUT_MS,
    ...opts,
    query: { depth, amountPerChunk, immutable: immutable === false ? 'false' : 'true' },
  });
}

function extendStorage({ batchId, amountPerChunk, depth }, opts = {}) {
  return antRequest('POST', '/v0/storage/extend', {
    timeoutMs: WRITE_TIMEOUT_MS,
    ...opts,
    query: { batchId, amountPerChunk, depth },
  });
}

function getSettlementDeposit(opts = {}) {
  return antRequest('GET', '/v0/settlement/deposit', { timeoutMs: QUOTE_TIMEOUT_MS, ...opts });
}

function topUpSettlementDeposit(opts = {}) {
  return antRequest('POST', '/v0/settlement/deposit', { timeoutMs: WRITE_TIMEOUT_MS, ...opts });
}

/**
 * Whether a response says the node has no xDAI storage routes at all: Bee
 * answers an unknown route with a bare 404 "Not Found", an Ant release that
 * predates them with its fallback `501 "not implemented in ant"`. A 404 that
 * names what is missing ("batch not found on chain") comes from the route
 * itself; a 501 with any other message means the routes exist but the node
 * has no write-capable chain.
 */
function isStorageRouteMissing(res) {
  if (!res || res.ok) return false;
  if (res.status === 404) return !res.message || /^not found$/i.test(res.message.trim());
  if (res.status === 405) return true;
  return res.status === 501 && /not implemented/i.test(res.message || '');
}

/**
 * Whether a failed write may still land on chain: the node took the request
 * but its answer never arrived, or it gave up waiting for the receipt. A
 * refused connection (the node was down) never delivered the request.
 */
function isUncertainWrite(res) {
  if (!res || res.ok || res.notSent || res.refused) return false;
  return res.status === 504 || res.timedOut === true || res.unreachable === true;
}

/**
 * Whether an upload failed because storer peers do not know its postage batch
 * yet: antd's `pushsync: postage batch 0x… rejected by N peer(s) as not found
 * on-chain`. For a batch bought moments ago this means the peers have not
 * synced its creation; the node keeps probing and the batch becomes usable
 * again once they have, so the upload is worth retrying shortly.
 */
function isBatchNotYetKnownError(message) {
  return (
    typeof message === 'string' && /rejected by \d+ peer\(s\) as not found on-chain/i.test(message)
  );
}

const BATCH_NOT_YET_KNOWN_MESSAGE =
  'Your storage is still reaching the Swarm network. Try again in a minute.';

/**
 * A sentence for the user from a failed response. `action` names what was
 * attempted ("Buying storage") for the errors whose own message is technical.
 * 400 and 409 bodies are written for users by the node and pass through.
 */
function describeAntError(res, action = 'The request') {
  if (!res) return `${action} failed.`;
  if (res.notSent) return 'The Swarm node is not running.';
  if (res.timedOut) return 'The Swarm node did not answer in time.';
  if (res.unreachable) return 'Cannot reach the Swarm node.';
  if (isStorageRouteMissing(res)) {
    return 'This Swarm node cannot buy storage with xDAI. It needs a newer version of Ant.';
  }
  switch (res.status) {
    case 400:
    case 409:
      return res.message || `${action} was refused by the Swarm node.`;
    case 501:
      return 'The Swarm node cannot send transactions: it has no Gnosis Chain connection or no wallet key.';
    case 503:
      return 'The Swarm node is still connecting to Gnosis Chain. This can take a few minutes after it starts.';
    case 404:
      return `${action} failed: ${res.message || 'not found'}.`;
    case 504:
      return 'Gnosis Chain did not confirm the transaction in time. It may still go through.';
    case 502:
      return `${action} failed on Gnosis Chain${res.message ? `: ${res.message}` : '.'}`;
    default:
      return `${action} failed (HTTP ${res.status})${res.message ? `: ${res.message}` : '.'}`;
  }
}

module.exports = {
  antRequest,
  getHealth,
  getNode,
  getReadiness,
  getStamps,
  getAddresses,
  getWallet,
  getChequebookAddress,
  getChequebookBalance,
  getSettlements,
  getStorageQuote,
  buyStorage,
  extendStorage,
  getSettlementDeposit,
  topUpSettlementDeposit,
  isStorageRouteMissing,
  isUncertainWrite,
  isBatchNotYetKnownError,
  BATCH_NOT_YET_KNOWN_MESSAGE,
  describeAntError,
  READ_TIMEOUT_MS,
  QUOTE_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
};
