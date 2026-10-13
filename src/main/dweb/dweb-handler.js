/**
 * The `bzz:`, `ipfs:` and `ipns:` handlers' one flow (freedom-core design
 * 0006): main asks the core for a plan, checks it, and executes it.
 *
 * 1. **Bounds:** a URL over 64 KiB is a 414 and headers over 64 KiB in all a
 *    431, counted in UTF-16 code units as `length` counts them (each header
 *    its name, its value and 4 more), before the core is asked.
 * 2. **Plan:** `dweb.open`, through the naming driver's fence, with the
 *    backend main captured when it admitted the request: its mode and
 *    whether it is up, never its URL. The core parses and canonicalizes the
 *    URL, resolves a name host, picks the node, fixes the request's headers,
 *    retries and deadlines, and names the response operations.
 * 3. **Validation before any dial:** a plan that fails the checks is a 502
 *    and a logged core fault (`plan-validation.js`).
 * 4. **Execution:** an error plan is answered as `{ code, message }`, a
 *    redirect plan as itself, and a fetch plan takes a slot in main's fetch
 *    admission, then is dialled against the captured backend
 *    (`plan-executor.js`).
 *
 * Local failures map to HTTP: `busy` is a 503, `deadline` a 504, a full
 * admission queue a 503, and a refused plan a 502. A `dweb.open` error the
 * core answers for main's mistake (`invalid_argument`, `forbidden`) or its
 * own (`internal`) is a 502 and a logged core fault. A cancelled request's
 * answer goes to nobody.
 */

const log = require('../logger');
const naming = require('../core/naming');
const { validatePlan, requestMethod } = require('./plan-validation');
const { executeFetch, jsonErrorResponse } = require('./plan-executor');
const { acquireDwebFetch } = require('./fetch-admission');
const { redactForLog, redactUrlForLog } = require('../private/private-log-context');

/** The longest request URL, and the most header text, in UTF-16 units. */
const MAX_URL_UNITS = 65_536;
const MAX_HEADER_UNITS = 65_536;
/** What each header counts beside its name and value: `: ` and CRLF. */
const HEADER_EXTRA_UNITS = 4;

/** The text a core-less or restarted planner answers with. */
const CORE_UNAVAILABLE = 'The core is unavailable';

// The core's error texts that carry nothing browsing-identifying: logged as
// they are in a private window too, so "node not ready" stays diagnosable.
// Any other message may name what the page asked for, and is redacted.
const PLAIN_ERROR_MESSAGES = new Set([
  'Swarm node is not ready',
  'freedom-ipfs node is not running',
  'external IPFS gateway is not running',
  'method not allowed',
  'freedom-ipfs native gateway supports GET and HEAD',
  'invalid bzz path',
  'invalid bzz reference',
  'invalid ipfs reference',
  'invalid ipns reference',
  ...['ipfs', 'ipns'].map(
    (scheme) =>
      `gateway-form ${scheme} URL has no canonical ipfs:// or ipns:// form; ` +
      "not serving it under the gateway host's origin"
  ),
]);

/** Today's `nameSystemLabelForHost`, for the driver's own "changed
 * repeatedly" failure, which a name's resolver error carries. */
function nameSystemLabelForHost(host) {
  const lower = String(host || '').toLowerCase();
  if (lower.endsWith('.tez')) return 'Tezos Domains';
  if (lower.endsWith('.wei')) return 'WNS';
  if (lower.endsWith('.gwei')) return 'GNS';
  return 'ENS';
}

function headerUnits(headers) {
  return headers.reduce(
    (units, [name, value]) => units + name.length + value.length + HEADER_EXTRA_UNITS,
    0
  );
}

/** A `dweb.open` failure as the page's answer. */
function openFailure(err, url, tag) {
  switch (err?.code) {
    case 'busy':
      return jsonErrorResponse(503, err.message || 'Too many requests');
    case 'admission_full':
      return jsonErrorResponse(503, err.message);
    case 'deadline':
      return jsonErrorResponse(504, err.message || 'Deadline passed');
    case 'core_unavailable':
      return jsonErrorResponse(503, CORE_UNAVAILABLE);
    case 'cancelled':
      return jsonErrorResponse(502, 'Cancelled');
    case 'repeated': {
      // Today's caught throw from `resolveContentName`.
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        // the label falls back to ENS's
      }
      return jsonErrorResponse(
        502,
        `${nameSystemLabelForHost(host)} resolver error: ${err.message}`
      );
    }
    default:
      if (err?.name === 'AbortError') return jsonErrorResponse(502, 'Cancelled');
      log.error(`[Core] dweb.open failed (${err?.code || 'error'}) for ${redactUrlForLog(url)}`, {
        tag,
      });
      return jsonErrorResponse(502, 'dweb planning failed');
  }
}

/**
 * Handles one `bzz:`, `ipfs:` or `ipns:` request.
 *
 * @param {Request} request - as Chromium hands it to the handler
 * @param {object} options
 * @param {object} options.backend - the backend captured at admission:
 *   `ref` (`{ ant | ipfs: mode, up }`, what `dweb.open` is told), `url` and
 *   `request()` (see `plan-executor.js`)
 * @param {string|null} [options.partition] - a private session's partition
 * @param {string} options.tag - the handler's log prefix
 * @returns {Promise<Response>}
 */
async function handleDwebRequest(request, { backend, partition = null, tag }) {
  const { url, signal } = request;
  if (url.length > MAX_URL_UNITS) return jsonErrorResponse(414, 'request URL too long');
  // A Request's headers, or an in-process caller's plain object.
  const headers = [...new Headers(request.headers || {})];
  if (headerUnits(headers) > MAX_HEADER_UNITS) {
    return jsonErrorResponse(431, 'request headers too large');
  }
  // Sent as it came, the core reading it as `(method || 'GET').toUpperCase()`.
  const method = typeof request.method === 'string' ? request.method : '';
  const admitted = { url, method, backend: backend.ref };

  const driver = naming.namingDriver();
  if (!driver) return jsonErrorResponse(503, CORE_UNAVAILABLE);
  let slot = null;
  // A fetch plan waits for its slot here, before it is used, so the
  // driver judges it once more after any wait.
  const ready = async (reply) => {
    if (slot || validatePlan(reply?.plan, admitted) !== null || !reply.plan.fetch) return;
    slot = await acquireDwebFetch({ partition, signal });
  };
  let reply;
  try {
    reply = await driver.open({ url, method, headers, backend: backend.ref }, { signal, ready });
  } catch (err) {
    slot?.release();
    return openFailure(err, url, tag);
  }

  const plan = reply?.plan;
  const refusal = validatePlan(plan, admitted);
  if (refusal || !plan.fetch) slot?.release();
  if (refusal) {
    log.error(`[Core] dweb plan refused (${refusal}) for ${redactUrlForLog(url)}`, { tag });
    return jsonErrorResponse(502, 'dweb plan refused');
  }
  if (plan.error) {
    // The message is the page's, and may name what it asked for: only a
    // redacted variant reaches the persistent log, unless it is one of the
    // core's fixed texts.
    const { message } = plan.error;
    const logged = PLAIN_ERROR_MESSAGES.has(message) ? message : redactForLog(message);
    log.info(`${tag} ${plan.error.status} for ${redactUrlForLog(url)}: ${logged}`);
    return jsonErrorResponse(plan.error.status, plan.error.message);
  }
  if (plan.redirect) {
    return new Response(null, {
      status: plan.redirect.status,
      headers: [['location', plan.redirect.location], ...plan.redirect.headers],
    });
  }

  if (!slot) {
    try {
      slot = await acquireDwebFetch({ partition, signal });
    } catch (err) {
      return openFailure(err, url, tag);
    }
  }
  return executeFetch(plan.fetch, {
    backend,
    method: requestMethod(method),
    signal,
    stop: slot.stop,
    onEnd: slot.release,
    log,
    tag,
    redactUrl: redactUrlForLog,
  });
}

module.exports = {
  handleDwebRequest,
  MAX_URL_UNITS,
  MAX_HEADER_UNITS,
};
