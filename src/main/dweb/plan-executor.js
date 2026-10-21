/**
 * Main executes a dweb fetch plan (freedom-core design 0006, "Main executes
 * the plan"): it dials the backend main admitted, retries as the plan says,
 * runs the response operations and streams the body to Chromium. The core
 * plans; the bytes never leave main.
 *
 * - **Retry:** up to the plan's attempts, after its delays, on its statuses
 *   (and on a thrown dial when it says so). The loop and its back-off stop
 *   when the page's signal aborts, and a retried attempt's body is cancelled
 *   before the next attempt, freeing its connection.
 * - **Headers deadline:** per attempt, the plan's `headers_ms`, run by the
 *   backend's transport (`backend.request`): Ant's dial, the native IPFS
 *   node, or none for the external gateway (the plan's `null`), which only
 *   the page's abort ends.
 * - **Body idle (deviation `body-idle`):** the body is wrapped in a
 *   `ReadableStream` with `highWaterMark: 0`, so a pull means a consumer is
 *   waiting. The clock runs only while bytes are asked for and none have
 *   come: a paused video, which asks for nothing, is never cut off. A read
 *   left pending for the plan's `body_idle_ms` fails the body as truncated,
 *   and the upstream is cancelled and freed.
 */

const { respond, sniffSmallText } = require('./response-operations');
const { backendKind } = require('./plan-validation');

// Statuses that never carry a body; `new Response` refuses one with them.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// After the dial: Ant's unreachable node is a 503, anything else a 502 (the
// transport's `cause.code || code`, as today).
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND']);

class BodyIdleError extends Error {
  constructor(ms) {
    super(`dweb response body idle for ${ms} ms`);
    this.name = 'BodyIdleError';
  }
}

function jsonErrorResponse(status, message) {
  return new Response(JSON.stringify({ code: status, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * The answer for a dial that threw, after any retries, by backend (fc-dweb's
 * `failure::after_dial`, with the same vectors):
 *  - Ant: 503 when the node refused, reset or wasn't found, else 502;
 *  - the native IPFS node: 502 with the error's message;
 *  - the external gateway: an abort with its message, else a fixed 502.
 */
function failure(kind, err) {
  if (kind === 'ant') {
    const code = err?.cause?.code || err?.code || '';
    return UNREACHABLE_CODES.has(code)
      ? { status: 503, message: 'bee gateway unreachable' }
      : { status: 502, message: 'bee gateway error' };
  }
  if (kind === 'gateway' && err?.name !== 'AbortError') {
    return { status: 502, message: 'external IPFS gateway request failed' };
  }
  return { status: 502, message: err?.message || 'freedom-ipfs native gateway error' };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function shouldRetry(result, retry) {
  if (result.error) return retry.on_error;
  return retry.statuses.includes(result.response.status);
}

async function dialWithRetry({ retry, attempt, signal, onRetry }) {
  let result = await attempt();
  for (let i = 0; i < retry.attempts - 1; i++) {
    if (!shouldRetry(result, retry)) break;
    if (signal?.aborted) break;
    // Release the previous answer's connection before the next attempt.
    if (result.response) {
      try {
        await result.response.body?.cancel();
      } catch {
        // ignored — the body may already be closed
      }
    }
    const delay = retry.delays_ms[i];
    onRetry(i, delay, result);
    await sleep(delay, signal);
    if (signal?.aborted) break;
    result = await attempt();
  }
  if (result.error) throw result.error;
  return result.response;
}

/**
 * The body as Chromium reads it: pulled only when a consumer asks, failed as
 * truncated when a pending read waits `idleMs` for bytes, or when `stop`
 * aborts (the session closed). `onEnd` runs once, on every terminal path:
 * the end, an error, a cancel, the idle bound or the stop.
 */
function idleBoundBody(body, idleMs, stop, onEnd) {
  const reader = body.getReader();
  let controller = null;
  let ended = false;
  let timer = null;
  // Fails the body: the consumer sees `err`, the upstream is cancelled.
  const fail = (err) => {
    if (ended) return;
    controller.error(err);
    reader.cancel(err).catch(() => {});
    end();
  };
  const onStop = () => fail(stop.reason);
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    timer = null;
    stop?.removeEventListener('abort', onStop);
    onEnd();
  };
  return new ReadableStream(
    {
      start(streamController) {
        controller = streamController;
        if (stop?.aborted) onStop();
        else stop?.addEventListener('abort', onStop, { once: true });
      },
      pull() {
        return new Promise((resolve) => {
          let settled = false;
          const settle = (fn) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            timer = null;
            if (!ended) fn();
            resolve();
          };
          timer = setTimeout(() => settle(() => fail(new BodyIdleError(idleMs))), idleMs);
          reader.read().then(
            ({ done, value }) =>
              settle(() => {
                if (!done) {
                  controller.enqueue(value);
                  return;
                }
                controller.close();
                end();
              }),
            (err) =>
              settle(() => {
                controller.error(err);
                end();
              })
          );
        });
      },
      cancel(reason) {
        end();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

/**
 * Executes a validated fetch plan.
 *
 * @param {object} fetch - the plan's `fetch`, validated
 * @param {object} options
 * @param {object} options.backend - the backend main admitted: `ref` (what
 *   `dweb.open` was told), `url` (an HTTP node's origin) and `request({ path,
 *   method, headers, signal, headersTimeoutMs })`, one attempt
 * @param {string} options.method - the request's method, GET or HEAD
 * @param {AbortSignal} [options.signal] - the page's
 * @param {AbortSignal} [options.stop] - aborts when the request's session
 *   closes: it stops the dial and the body alike
 * @param {() => void} [options.onEnd] - once the fetch is over: its body
 *   ended, errored or was cancelled, or it had none
 * @param {object} options.log
 * @param {string} options.tag - the handler's log prefix
 * @param {(url: string) => string} options.redactUrl
 * @returns {Promise<Response>}
 */
async function executeFetch(
  fetch,
  { backend, method, signal = null, stop = null, onEnd = () => {}, log, tag, redactUrl }
) {
  // The dial and its back-off stop on the page's abort or the session's.
  const dialSignal = stop && signal ? AbortSignal.any([signal, stop]) : signal || stop;
  const kind = backendKind(backend.ref);
  const requestUrl = backend.url ? `${backend.url}${fetch.path}` : fetch.path;
  const headers = new Headers(fetch.headers);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  const fail = (err) => {
    end();
    const code = err?.cause?.code || err?.code || '';
    log.warn(
      `${tag} fetch failed for ${redactUrl(requestUrl)}: ${err?.message || err}` +
        (code ? ` (${code})` : '')
    );
    // The native node's capacity, not its failure (design 0007, "Main's
    // side": the service's `busy`): a 503, as admission's own.
    if (err?.name === 'BackendBusy') return jsonErrorResponse(503, err.message);
    const { status, message } = failure(kind, err);
    return jsonErrorResponse(status, message);
  };

  let upstream;
  try {
    upstream = await dialWithRetry({
      retry: fetch.retry,
      signal: dialSignal,
      attempt: () =>
        backend
          .request({
            path: fetch.path,
            method,
            headers,
            signal: dialSignal,
            headersTimeoutMs: fetch.timers.headers_ms,
          })
          .then(
            (response) => ({ response }),
            (error) => ({ error })
          ),
      onRetry: (i, delay, result) =>
        log.debug(
          `${tag} retry ${i + 1}/${fetch.retry.attempts - 1} in ${delay}ms ` +
            `(status=${result.response?.status ?? result.error?.code ?? 'error'}) ` +
            `${redactUrl(requestUrl)}`
        ),
    });
  } catch (err) {
    return fail(err);
  }

  const head = { status: upstream.status, headers: new Headers(upstream.headers) };
  // The loop stops on the page's abort with the last answer, whose body it
  // may already have cancelled. Nobody reads what comes back, but it still
  // gets every operation; only its body is gone.
  const bodyPresent = upstream.body !== null && !upstream.bodyUsed;
  const operated = respond(fetch, kind, head, requestUrl, bodyPresent && !dialSignal?.aborted);
  const keep = operated.body && !NULL_BODY_STATUSES.has(head.status);
  if (!keep) {
    if (bodyPresent) upstream.body.cancel().catch(() => {});
    end();
    return new Response(null, {
      status: head.status,
      statusText: upstream.statusText,
      headers: head.headers,
    });
  }

  let body = idleBoundBody(upstream.body, fetch.timers.body_idle_ms, stop, end);
  if (operated.smallText !== null) {
    try {
      body = await sniffSmallText(head.headers, body, operated.smallText);
    } catch (err) {
      // The bound body has ended already: its read failed or timed out.
      return fail(err);
    }
  }
  return new Response(body, {
    status: head.status,
    statusText: upstream.statusText,
    headers: head.headers,
  });
}

module.exports = {
  executeFetch,
  failure,
  jsonErrorResponse,
  BodyIdleError,
  NULL_BODY_STATUSES,
};
