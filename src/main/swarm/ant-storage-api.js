/**
 * Ant storage API client (main process)
 *
 * The Swarm node routes the publish setup reads and writes:
 *
 *   - the Bee-compatible reads readiness is built from (`/health`, `/node`,
 *     `/readiness`, `/stamps`, `/addresses`, `/wallet`, `/chequebook/*`),
 *     and `/settlements` for the browsing credit (browsing-credit-service.js);
 *   - the node's `swap-enable` switch, `GET|PUT /v0/settlement/swap`, on Ant
 *     releases with freedom-hq/ant#126 (they also report it in `/node`'s
 *     `settlement` object; older ones lack both);
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
 * Each call is one dial on the node's transport (`antBackend()`,
 * bzz-protocol.js; freedom-core design 0015, The transport, which SWM-8
 * moves main's own reads onto, closing F-6 for them), never retried:
 *   - the bundled node, or any loopback one, with Node's `fetch` (undici),
 *     outside `session.webRequest`, as before;
 *   - a remote node on the default session's stack (`net.request`), so its
 *     proxy, Tor and the onion gate apply (#360). A GET goes on that
 *     session, announced to the Ant API guard with its one method and exact
 *     URL for the dial's lifetime (ant-api-main-dials.js); a POST or PUT on
 *     a write session of its own (ant-write-sessions.js), on that session's
 *     proxy and a new connection, so Chromium sends it once, and it is
 *     never announced.
 * A call's timeout bounds the whole of it, its reply's body included, as
 * `AbortSignal.timeout` on `fetch` did. Redirects are answered as they come,
 * never followed (the transport's `redirect: 'manual'`).
 */

const { getAntApiUrl } = require('../service-registry');
const { OnionGateRefusal } = require('../ipfs/onion-gate');
const { AntNotDialled } = require('./ant-write-sessions');

const READ_TIMEOUT_MS = 10_000;
// A quote reads the price oracle, both wallet balances and the chequebook
// over RPC; the node's RPC client has no timeout of its own.
const QUOTE_TIMEOUT_MS = 30_000;
// antd caps its storage handlers at 5 minutes; wait a little longer so its
// own 504 reaches us instead of a client-side abort.
const WRITE_TIMEOUT_MS = 330_000;

function hasNodeUrl() {
  const base = getAntApiUrl();
  return typeof base === 'string' && base.replace(/\/+$/, '') !== '';
}

/**
 * The node's transport, captured for one call. bzz-protocol.js is loaded on
 * the first call, not with this module: it brings the dweb handler's graph,
 * which this module's importers (readiness, the browsing credit, the agent)
 * don't otherwise load, and main has loaded it by then for `bzz:`.
 */
function nodeBackend(transport) {
  return require('./bzz-protocol').antBackend(transport);
}

/** `endpoint` with `query`'s set members, the path `request()` joins to the node's root. */
function buildPath(endpoint, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${endpoint}${qs ? `?${qs}` : ''}`;
}

// Errors (undici puts the socket's on `cause`) raised before a connection
// existed: the request bytes never left Freedom. A reset or a socket closed
// mid-request is not one of them; the node may have acted on it. The
// transport reads Chromium's refused connection and unresolved name as
// ECONNREFUSED and ENOTFOUND (bzz-protocol.js).
const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

// A lost route: before the request only when the socket's own `connect`
// failed with it. The same codes from a write or read on a connected socket
// may follow some or all of the request (Codex round 5 on #1369).
const ROUTE_FAILURE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH']);

// The same failures on the session's stack (a remote node), as Chromium
// names them: undici's others (EADDRNOTAVAIL, a connect timeout,
// EAI_AGAIN), and a proxy the connection to the node had to go through
// refusing or failing it, before the request was written.
// Not `ERR_INTERNET_DISCONNECTED` or `ERR_ADDRESS_UNREACHABLE`: Chromium
// also ends a request it already wrote with them when the connection or the
// route is lost, so a write may have landed.
const CHROMIUM_CONNECT_FAILURES = new Set([
  'net::ERR_ADDRESS_INVALID',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_NAME_RESOLUTION_FAILED',
  'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
  'net::ERR_TUNNEL_CONNECTION_FAILED',
]);

/**
 * Main's own refusals before the request existed, whenever they came, the
 * call's deadline included: the onion gate's (onion-gate.js), and the
 * transport's `AntNotDialled` (ant-write-sessions.js): a write session that
 * couldn't be prepared, a write that ended while it waited for one or while
 * it was prepared, the cap on abandoned dials.
 */
function neverDialled(err) {
  return err instanceof OnionGateRefusal || err instanceof AntNotDialled;
}

function isConnectFailure(err) {
  const causes = [err, err?.cause, err?.cause?.cause];
  return causes.some(
    (e) =>
      CONNECT_FAILURE_CODES.has(e?.code) ||
      (ROUTE_FAILURE_CODES.has(e?.code) && e?.syscall === 'connect') ||
      CHROMIUM_CONNECT_FAILURES.has(String(e?.message || '').trim())
  );
}

/**
 * The reply's body as text, read until `signal` aborts: then the body is
 * cancelled, so the transport lets its connection (and a write session) go,
 * and the read fails with the abort's reason.
 */
async function readText(response, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const onAbort = () => reader.cancel(signal.reason).catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const parts = [];
  try {
    for (;;) {
      let next;
      try {
        next = await reader.read();
      } catch (err) {
        throw signal.aborted ? signal.reason : err;
      }
      if (signal.aborted) throw signal.reason;
      if (next.done) break;
      parts.push(next.value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/**
 * One call of the node's API, on its transport (see the file header).
 * `fetchImpl` is a test seam for the loopback dial.
 */
async function antRequest(
  method,
  endpoint,
  { query, body, timeoutMs = READ_TIMEOUT_MS, fetchImpl } = {}
) {
  const notSent = { ok: false, status: 0, data: null, message: null, notSent: true };
  if (!hasNodeUrl()) return notSent;

  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let text;
  try {
    const backend = nodeBackend(fetchImpl ? { fetchImpl } : {});
    // The node went away since: nothing goes.
    if (!backend.url) return notSent;
    response = await backend.request({
      path: buildPath(endpoint, query),
      method,
      signal,
      // The call's timeout bounds it; the transport sets no deadline of its own.
      headersTimeoutMs: null,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify(body)),
          }),
    });
    text = await readText(response, signal);
  } catch (err) {
    // The call's own deadline, never any abort: the session's stack fails a
    // reply the node cut off mid-body with an AbortError, which undici
    // reported as `terminated` (unreachable).
    const timedOut = signal.aborted || err?.name === 'TimeoutError';
    return {
      ok: false,
      status: 0,
      data: null,
      message: null,
      timedOut,
      unreachable: !timedOut,
      // No connection was ever made, so a write cannot have reached the node.
      refused: neverDialled(err) || (!timedOut && isConnectFailure(err)),
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

/**
 * Top the chequebook deposit up to the node's target, or, with `amountPlur`
 * (a PLUR integer string), deposit that much more whatever the target. Only
 * Ant releases with freedom-hq/ant#126 read `amount`; an older one ignores it
 * and tops up to its target, so callers check `/node`'s `settlement` first.
 */
function topUpSettlementDeposit({ amountPlur } = {}, opts = {}) {
  return antRequest('POST', '/v0/settlement/deposit', {
    timeoutMs: WRITE_TIMEOUT_MS,
    ...opts,
    query: { amount: amountPlur },
  });
}

// antd waits up to 5 s for its node loop to apply the switch.
const SWAP_SWITCH_TIMEOUT_MS = 15_000;

/**
 * Flip the running node's `swap-enable` (`{ swapEnabled }`): downloads and
 * uploads alike, no restart. Answers the node's settlement state afterwards.
 * Not persisted by antd: ant-manager writes the setting into config.yaml for
 * the next start. Main-process fetches send no `Origin`, which the route's
 * web-page guard lets through.
 */
function setSwapEnabled(enabled, opts = {}) {
  return antRequest('PUT', '/v0/settlement/swap', {
    timeoutMs: SWAP_SWITCH_TIMEOUT_MS,
    ...opts,
    body: { swapEnabled: enabled === true },
  });
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
  setSwapEnabled,
  isStorageRouteMissing,
  isUncertainWrite,
  isBatchNotYetKnownError,
  BATCH_NOT_YET_KNOWN_MESSAGE,
  describeAntError,
  READ_TIMEOUT_MS,
  QUOTE_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
};
