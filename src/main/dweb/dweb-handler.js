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
 *    (`plan-executor.js`). The driver hands the plan over (`use`) in the
 *    same synchronous turn as its final judgment, and the dial starts in it.
 *    A `{ verify }` plan (freedom-core design 0009) takes a slot too, and
 *    its `dweb.verify` is written in that turn, to the core process that
 *    made the plan (`verify-executor.js`). Only a core that speaks protocol
 *    2 has the verifier (`core/dweb-verify.js`): against any other, a
 *    verify plan is refused at `shape`, as it was before 0009.
 *
 * **The error page** (0009, decision 4): with the verifier attached, a
 * navigation-like request (a GET whose first `Accept` token is `text/html`)
 * gets a page in plain words wherever main would answer `{ code, message }`
 * (`error-page.js`). Every other request keeps the JSON body, and against a
 * protocol-1 core every request does.
 *
 * **One lifetime per request.** At entry the request is fenced to its
 * session, before anything is planned: its scope is the page's abort and its
 * session's close. Every wait in its life observes it (`dweb.open`, its
 * re-plans, the configuration waits, admission, the dial and the body), so a
 * closing private window stops its requests wherever they are, and a closed
 * one starts none. The fence, the slot and the backend's lease are released
 * once, whichever way the request ends.
 *
 * **The lease** (freedom-core design 0007, "Main's side"): the backend
 * captured at admission may pin what serves it (a private partition's
 * instance), and its `release()` gives the pin back. It is called exactly
 * once, on every exit: a bound's refusal, a closed session, a failed lookup
 * or an unavailable core, an error or redirect plan, admission's 503, a
 * refused plan, and a fetch's end, when its body ends, errors or is
 * cancelled, or it had none. While a body is handed on, the lease is held.
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
const { executeVerify } = require('./verify-executor');
const { isNavigation } = require('./dweb-open');
const { errorPage } = require('./error-page');
const { STRICT_MESSAGES } = require('./verify-plan');
const { dwebVerifier } = require('../core/dweb-verify');
const { acquireDwebFetch, fenceDwebSession } = require('./fetch-admission');
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
  // Strict mode's refusals (freedom-core design 0009): fixed, one per cause.
  ...STRICT_MESSAGES,
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

/** A `dweb.open` failure as the page's answer, through `answer`. */
function openFailure(err, url, tag, answer) {
  switch (err?.code) {
    case 'busy':
      return answer(503, err.message || 'Too many requests');
    case 'admission_full':
      return answer(503, err.message);
    case 'deadline':
      return answer(504, err.message || 'Deadline passed');
    case 'core_unavailable':
      return answer(503, CORE_UNAVAILABLE);
    case 'cancelled':
      return answer(502, 'Cancelled');
    case 'repeated': {
      // Today's caught throw from `resolveContentName`.
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        // the label falls back to ENS's
      }
      return answer(502, `${nameSystemLabelForHost(host)} resolver error: ${err.message}`);
    }
    default:
      if (err?.name === 'AbortError') return answer(502, 'Cancelled');
      log.error(`[Core] dweb.open failed (${err?.code || 'error'}) for ${redactUrlForLog(url)}`, {
        tag,
      });
      return answer(502, 'dweb planning failed');
  }
}

/**
 * Handles one `bzz:`, `ipfs:` or `ipns:` request.
 *
 * @param {Request} request - as Chromium hands it to the handler
 * @param {object} options
 * @param {object} options.backend - the backend captured at admission:
 *   `ref` (`{ ant | ipfs: mode, up }`, what `dweb.open` is told), `url` and
 *   `request()` (see `plan-executor.js`), and its lease's `release()`, if it
 *   has one
 * @param {string|null} [options.partition] - a private session's partition
 * @param {string} options.tag - the handler's log prefix
 * @param {(trust: {name: string|null, content: string}) => void} [options.onTrust] -
 *   a verified head's trust, for the trust panel (0009, Labels)
 * @returns {Promise<Response>}
 */
async function handleDwebRequest(request, options) {
  // The lease is this request's from its first line: released once, by an
  // answer, a fetch's end, or a throw from anywhere in the handling (a
  // malformed in-process request, say). Only a body handed on keeps it.
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    options.backend.release?.();
  };
  try {
    return await handle(request, options, release);
  } catch (err) {
    release();
    throw err;
  }
}

/** Whether the request is navigation-like: a GET whose first `Accept`
 * token is `text/html` (0009, The error page). */
function navigationLike(request) {
  const method = typeof request.method === 'string' ? request.method : '';
  if (requestMethod(method) !== 'GET') return false;
  try {
    return isNavigation(new Headers(request.headers || {}));
  } catch {
    return false;
  }
}

async function handle(request, { backend, partition = null, tag, onTrust }, release) {
  const { url, signal } = request;
  // Main's `{ code, message }` answers: the error page for a navigation
  // once the core speaks protocol 2, else the JSON body.
  const navigation = navigationLike(request);
  const answer = (status, message) =>
    navigation && dwebVerifier()
      ? errorPage(status, message, url)
      : jsonErrorResponse(status, message);
  // An answer before the request is fenced: its lease goes with it.
  const refuse = (status, message) => {
    release();
    return answer(status, message);
  };
  if (url.length > MAX_URL_UNITS) return refuse(414, 'request URL too long');
  // A Request's headers, or an in-process caller's plain object.
  const headers = [...new Headers(request.headers || {})];
  if (headerUnits(headers) > MAX_HEADER_UNITS) {
    return refuse(431, 'request headers too large');
  }
  // Sent as it came, the core reading it as `(method || 'GET').toUpperCase()`.
  const method = typeof request.method === 'string' ? request.method : '';
  const admitted = { url, method, backend: backend.ref };
  // An error plan's answer. Its message is the page's, and may name what it
  // asked for: only a redacted variant reaches the persistent log, unless it
  // is one of the core's fixed texts.
  const planError = ({ status, message }) => {
    const logged = PLAIN_ERROR_MESSAGES.has(message) ? message : redactForLog(message);
    log.info(`${tag} ${status} for ${redactUrlForLog(url)}: ${logged}`);
    return answer(status, message);
  };

  const driver = naming.namingDriver();
  if (!driver) return refuse(503, CORE_UNAVAILABLE);
  let fence;
  try {
    fence = fenceDwebSession(partition);
  } catch {
    // Its session has closed: nothing is planned or dialled for it.
    return refuse(502, 'Cancelled');
  }
  let slot = null;
  let over = false;
  // Every terminal path ends here, once: a fetch's when its body is over.
  const finish = () => {
    if (over) return;
    over = true;
    slot?.release();
    fence.dispose();
    release();
  };
  // A fetch plan waits for its slot here, before it is used, so the driver
  // judges it once more after any wait. `life` aborts with the request.
  const ready = async (reply, life) => {
    if (slot || validatePlan(reply?.plan, admitted) !== null) return;
    if (!reply.plan.fetch && !(reply.plan.verify && dwebVerifier())) return;
    const granted = await acquireDwebFetch({ partition, signal: life });
    // Granted as the request ended: freed at once.
    if (over) granted.release();
    else slot = granted;
  };
  // The plan's use: synchronous up to the dial, so nothing comes between the
  // driver's final judgment and it.
  const use = (reply, gen = null) => {
    const plan = reply?.plan;
    // A verify plan needs the core's verifier: without it (a protocol-1
    // core), it is an unknown variant, as before 0009.
    const verifier = plan?.verify ? dwebVerifier() : null;
    const refusal = plan?.verify && !verifier ? 'shape' : validatePlan(plan, admitted);
    if (refusal) {
      finish();
      log.error(`[Core] dweb plan refused (${refusal}) for ${redactUrlForLog(url)}`, { tag });
      return answer(502, 'dweb plan refused');
    }
    if (plan.error) {
      finish();
      return planError(plan.error);
    }
    if (plan.redirect) {
      finish();
      return new Response(null, {
        status: plan.redirect.status,
        headers: [['location', plan.redirect.location], ...plan.redirect.headers],
      });
    }
    if (!slot) {
      // The driver runs `ready` on every plan it hands over.
      finish();
      log.error(`[dweb] a fetch plan came without its admission for ${redactUrlForLog(url)}`);
      return answer(503, 'Too many dweb requests');
    }
    if (plan.verify) {
      return executeVerify(plan, {
        verifier,
        gen,
        backend,
        method,
        partition,
        signal,
        stop: fence.signal,
        onEnd: finish,
        onTrust,
        answer,
        planError,
        log,
        tag,
        url,
        redactUrl: redactUrlForLog,
      });
    }
    return executeFetch(plan.fetch, {
      backend,
      method: requestMethod(method),
      signal,
      stop: fence.signal,
      onEnd: finish,
      errorResponse: answer,
      log,
      tag,
      redactUrl: redactUrlForLog,
    });
  };
  try {
    // In the try, as everything after the fence is: a throw here still
    // disposes the fence and frees the slot and the lease (finish).
    const scope = signal ? AbortSignal.any([signal, fence.signal]) : fence.signal;
    return await driver.open(
      { url, method, headers, backend: backend.ref },
      { signal: scope, ready, use }
    );
  } catch (err) {
    finish();
    return openFailure(err, url, tag, answer);
  }
}

module.exports = {
  handleDwebRequest,
  MAX_URL_UNITS,
  MAX_HEADER_UNITS,
};
