/**
 * Executes a validated `{ verify }` plan (freedom-core design 0009,
 * `dweb.verify` and Main's side): main asks the core to verify the content,
 * and the core asks main for each piece (`shell.dweb_get`, dweb-shell.js)
 * through the backend this request captured.
 *
 * - **The call:** `dweb.verify { plan, method, partition, private,
 *   deadline_ms }`, and `car` for an IPFS plan (the probe's word on the
 *   gateway, captured with the backend; false until the probe sets it), on
 *   the core process that made the plan, written in the same synchronous
 *   turn as the plan's final judgment. Its pieces' context (the backend,
 *   the plan's retry and timers, the page's signal, the session) is opened
 *   under the ID and generation the client reports as it writes the
 *   request, and closed when the request ends.
 * - **Its answer** is one of two forms, told apart by their members: a head
 *   `{ status, headers, body, trust }`, or 0006's error plan `{ error:
 *   { status, code, message } }`. Anything else is a core fault: a 502,
 *   logged. The only protocol errors are `busy` (a 503, "Too many
 *   requests"), `cancelled` (the page's abort or the session's close: the
 *   answer goes to nobody) and `invalid_argument` (a 502 and a logged
 *   fault); the core's end is a 503, "The core is unavailable".
 * - **A head** is the core's, from verified data: it gets the plan's
 *   response operations and `strip_page_state`, never
 *   `strip_decoded_encoding` (its `Content-Length` describes exactly the
 *   bytes the core sends), and `small_text` for an IPFS GET navigation. Its
 *   redirects are in the bundled node's URL space, which
 *   `canonicalize_redirect` rewrites as it rewrites the node's. Its body
 *   reads the stream's ring through the body idle bound, whose end (the
 *   body's end, its error, its cancel, the session's close) ends the
 *   request: the admission slot, the fence and the lease go then. A HEAD,
 *   or a head without a body, ends it at once.
 * - **The trust** (`{ name, content }`) is the plan's name trust and the
 *   final content label, `verified` or `latest_asserted`. It goes to
 *   `onTrust` just before the head's response is returned, and never with
 *   main's own answer (a body that fails its small-text sniff, say): the
 *   protocol handlers label that response for the trust panel
 *   (`content-trust.js`).
 * - **After the head,** the core's `abort` errors the body, so Chromium
 *   sees it truncated; its code is logged, never a reference or a path in
 *   a private window.
 * - **A failed check** (0009, Failures), the error plan with the plan's
 *   node's "content verification failed" text or the abort
 *   `verification_failed`, is counted against the captured backend for the
 *   nodes panel's notice (`verify-failures.js`). Nothing else is, and the
 *   count changes nothing about this request or the next.
 */

const { CoreError } = require('../core/core-client');
const { CORE_BODY_ABORT_CODES } = require('../core/frame');
const { isPrivateLogContext } = require('../private/private-log-context');
const { idleBoundBody, NULL_BODY_STATUSES } = require('./plan-executor');
const { backendKind, requestMethod, MAX_MESSAGE_UNITS } = require('./plan-validation');
const { respond, sniffSmallText } = require('./response-operations');
const { rootReference, VERIFIED_CONTENT } = require('./verify-plan');
const {
  isVerificationFailure,
  noteVerificationFailure,
  VERIFICATION_FAILED_CODE,
} = require('./verify-failures');

/** The time to the head (0009, Bounds: `dweb.verify`'s `head` deadline). */
const HEAD_DEADLINE_MS = 360_000;
/** The bundled node's URL space, where the core writes its redirects. */
const VERIFIED_ORIGIN = 'http://verified.invalid';
/** At most this many head headers: a head from the core names a few. */
const MAX_HEAD_HEADERS = 64;
const CORE_UNAVAILABLE = 'The core is unavailable';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function exact(value, keys) {
  return (
    isObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** The head `result` is, for `verify` and `method`, or null. */
function readHead(result, verify, method) {
  if (!exact(result, ['status', 'headers', 'body', 'trust'])) return null;
  const { status, headers, body, trust } = result;
  if (!Number.isInteger(status) || status < 200 || status > 599) return null;
  if (typeof body !== 'boolean' || (method === 'HEAD' && body)) return null;
  if (
    !exact(trust, ['name', 'content']) ||
    !VERIFIED_CONTENT.has(trust.content) ||
    trust.name !== verify.trust.name
  ) {
    return null;
  }
  if (!Array.isArray(headers) || headers.length > MAX_HEAD_HEADERS) return null;
  const pairs = headers.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      typeof pair[1] === 'string'
  );
  if (!pairs) return null;
  try {
    return { status, headers: new Headers(headers), body, trust };
  } catch {
    return null;
  }
}

/** 0006's error plan as `dweb.verify` answers it: a 4xx or 5xx, its code
 * the status, a bounded message. */
function isErrorPlan(result) {
  if (!exact(result, ['error'])) return false;
  const { error } = result;
  return (
    exact(error, ['status', 'code', 'message']) &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599 &&
    error.code === error.status &&
    typeof error.message === 'string' &&
    error.message.length <= MAX_MESSAGE_UNITS
  );
}

/** A verified body that failed before main handed it on (`small_text`'s
 * read): the core's abort as its status and text. */
function bodyFailure(err) {
  if (err instanceof CoreError && CORE_BODY_ABORT_CODES.has(err.code)) {
    return { status: err.code === 'busy' ? 503 : 502, message: err.message };
  }
  if (err?.code === 'core_unavailable') return { status: 503, message: CORE_UNAVAILABLE };
  return { status: 502, message: 'dweb response body failed' };
}

/**
 * @param {object} plan - the `{ verify }` plan, validated
 * @param {object} options
 * @param {object} options.verifier - core/dweb-verify.js's `DwebVerifier`
 * @param {object|null} options.gen - the core process that made the plan
 * @param {object} options.backend - the backend captured at admission
 * @param {string} options.method - the request's method, GET or HEAD
 * @param {string|null} [options.partition] - a private session's partition
 * @param {AbortSignal} [options.signal] - the page's
 * @param {AbortSignal} [options.stop] - aborts when the session closes
 * @param {() => void} [options.onEnd] - once the request is over
 * @param {(trust: {name: string|null, content: string}) => void} [options.onTrust] -
 *   the head's trust, just before its response is returned
 * @param {(status: number, message: string) => Response} options.answer -
 *   main's `{ code, message }` answer (the JSON body, or the error page)
 * @param {(error: {status: number, message: string}) => Response} options.planError -
 *   an error plan's answer, logged as the handler logs one
 * @param {object} options.log
 * @param {string} options.tag
 * @param {string} options.url - the request's URL, for logs
 * @param {(url: string) => string} options.redactUrl
 * @returns {Promise<Response>}
 */
async function executeVerify(
  plan,
  {
    verifier,
    gen,
    backend,
    method,
    partition = null,
    signal = null,
    stop = null,
    onEnd = () => {},
    onTrust = () => {},
    answer,
    planError,
    log,
    tag,
    url,
    redactUrl,
  }
) {
  const { verify } = plan;
  const verb = requestMethod(method);
  // The request's life: the page's abort or the session's close cancels it,
  // before the head (`cancel`) and after (its body's stream retires).
  const life = stop && signal ? AbortSignal.any([signal, stop]) : signal || stop;
  const params = {
    plan,
    method: verb,
    partition,
    private: partition !== null || isPrivateLogContext(),
    deadline_ms: HEAD_DEADLINE_MS,
  };
  if (verify.node === 'ipfs') params.car = backend.car === true;

  let sent = null;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    sent?.close();
    onEnd();
  };
  // Written now, in the turn the plan was judged in.
  sent = verifier.send(gen, params, { backend, plan, signal, stop }, life);

  let reply;
  try {
    reply = await sent.head;
  } catch (err) {
    end();
    switch (err?.code) {
      case 'busy':
        return answer(503, 'Too many requests');
      case 'cancelled':
        return answer(502, 'Cancelled');
      case 'core_unavailable':
        return answer(503, CORE_UNAVAILABLE);
      default:
        log.error(`[Core] dweb.verify failed (${err?.code || 'error'}) for ${redactUrl(url)}`, {
          tag,
        });
        return answer(502, 'dweb verification failed');
    }
  }

  const { result, body } = reply;
  const head = readHead(result, verify, verb);
  if (!head || Boolean(body) !== head.body) {
    body?.cancel().catch(() => {});
    end();
    if (isErrorPlan(result)) {
      if (isVerificationFailure(verify.node, result.error)) noteVerificationFailure(backend);
      return planError(result.error);
    }
    log.error(`[Core] dweb.verify answer refused for ${redactUrl(url)}`, { tag });
    return answer(502, 'dweb verification failed');
  }

  const { namespace, reference } = rootReference(verify.root);
  const requestUrl = `${VERIFIED_ORIGIN}/${namespace}/${reference}${verify.path}${verify.query}`;
  // A core head: the plan's operations, never strip_decoded_encoding.
  const operated = respond(verify, 'core', head, requestUrl, head.body && !life?.aborted);
  if (!operated.body || NULL_BODY_STATUSES.has(head.status)) {
    body?.cancel().catch(() => {});
    end();
    onTrust(head.trust);
    return new Response(null, { status: head.status, headers: head.headers });
  }

  const kind = backendKind(backend.ref);
  let out = idleBoundBody(body, verify.timers.body_idle_ms, stop, (err) => {
    // The core's abort after the head: logged by its code.
    if (
      err instanceof CoreError &&
      CORE_BODY_ABORT_CODES.has(err.code) &&
      err.code !== 'cancelled'
    ) {
      log.warn(`${tag} verified body truncated (${err.code}, ${kind}) for ${redactUrl(url)}`);
      if (err.code === VERIFICATION_FAILED_CODE) noteVerificationFailure(backend);
    }
    end();
  });
  if (operated.smallText !== null) {
    try {
      out = await sniffSmallText(head.headers, out, operated.smallText);
    } catch (err) {
      // The bound body has ended already: its read failed or timed out.
      const { status, message } = bodyFailure(err);
      return answer(status, message);
    }
  }
  onTrust(head.trust);
  return new Response(out, { status: head.status, headers: head.headers });
}

module.exports = { executeVerify, HEAD_DEADLINE_MS, VERIFIED_ORIGIN };
