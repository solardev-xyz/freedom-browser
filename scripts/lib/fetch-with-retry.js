'use strict';

/**
 * Bounded, retrying HTTPS downloads for the `scripts/fetch-*.js` fetchers.
 *
 * Every fetcher used to carry its own copy of "GET this, follow redirects,
 * time it out, try again a few times", and the copies had drifted: different
 * attempt counts, different backoff, two of them retried *every* failure
 * (burning four attempts on a 404), one had no per-request timeout at all, and
 * one wrote straight into the destination file so a half-written body survived
 * a failed attempt. A single 500 on a GitHub release asset still failed a
 * required CI job (run 35211828052, `e2e-onboarding-identity (windows-latest)`)
 * because the retry there wrapped the *request*, not the status check.
 *
 * The policy this module implements:
 *
 *   - **Retry** HTTP 5xx, HTTP 429, connection-level errors (ECONNRESET,
 *     ETIMEDOUT, EAI_AGAIN, undici's opaque `fetch failed`, a socket hang up,
 *     a truncated response) and per-attempt timeouts.
 *   - **Never retry** any other 4xx, a non-HTTPS URL or redirect, a redirect
 *     loop, an over-size body, or a local filesystem error. Those are answers,
 *     not weather: retrying only delays the failure and hides its cause.
 *   - 4 attempts, exponential backoff with jitter: ~1s, ~3s, ~9s (jitter adds
 *     up to +25%, so several parallel downloads hitting the same degraded
 *     endpoint do not re-dial in lockstep). A `Retry-After` on a 429/503 wins
 *     when it asks for longer, capped at 60s so a hostile value cannot park a
 *     CI job.
 *   - Two timeouts per attempt, because they catch different failures: a
 *     wall-clock deadline sized for the asset (`TIMEOUTS`), and a socket
 *     inactivity timeout (`IDLE_TIMEOUT_MS`) that fires when bytes stop
 *     arriving even though the deadline has not expired. Node resets the
 *     inactivity timer on socket activity, so a slow-but-steady large transfer
 *     is bounded only by the deadline, never by the idle timeout.
 *   - Streaming downloads write to a temp file next to the destination and
 *     rename on success, deleting it on failure — an interrupted attempt can
 *     never leave a partial file where the next step expects a complete one,
 *     and the rename is atomic on the same filesystem. A download whose process
 *     was killed outright never runs that cleanup, so each download also sweeps
 *     the temp files a previous run orphaned (`removeStaleTempFiles`).
 *
 * **Checksum verification stays outside the retry loop.** A body that does not
 * match its pinned digest is not a transient failure: it is either corruption
 * or tampering, and re-downloading it either wastes time or papers over the
 * signal. Callers verify what this module returns, and a mismatch fails the
 * run immediately.
 *
 * Node's `https` is used rather than the global `fetch`: when a server drops
 * the connection mid-body, Node 24's undici can die on an internal assertion
 * (`assert(!this.paused)`) that surfaces as an *uncaught* exception, outside
 * any try/catch — the v0.8.5-rc.1 release run failed exactly that way. The
 * `https` client reports the same condition as a catchable `'error'`, which is
 * what makes a retry loop possible at all.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

/** Attempts per download, including the first. */
const MAX_ATTEMPTS = 4;
/** Backoff before attempt 2; ×3 per further attempt (1s, 3s, 9s). */
const BASE_DELAY_MS = 1000;
const BACKOFF_FACTOR = 3;
/** Jitter added on top of the nominal delay, as a fraction of it. */
const JITTER_RATIO = 0.25;
/** Upper bound on a server-supplied `Retry-After`. */
const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Per-attempt wall-clock deadlines, by what is being fetched. A release JSON
 * or a SHA256SUMS file that has not arrived in 30s is not going to; a 200 MB
 * binary over a slow runner link legitimately takes minutes.
 */
const TIMEOUTS = {
  metadata: 30_000,
  list: 120_000,
  binary: 600_000,
};

/** Socket inactivity timeout: no bytes for this long ends the attempt. */
const IDLE_TIMEOUT_MS = 60_000;

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Connection-level failures worth another attempt. `EAI_AGAIN` is a temporary
 * DNS failure; `ENOTFOUND` is deliberately absent, since a name that does not
 * resolve is usually a wrong URL rather than weather.
 */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ERR_STREAM_PREMATURE_CLOSE',
  // undici (global fetch) codes, for callers that still hand us one of its
  // errors — `fetch failed` itself carries no code, hence the message test.
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Transient failures whose only distinguishing mark is the message: undici's
 * opaque `fetch failed`, Node's `socket hang up`, and our own timeout/truncation
 * errors when they cross a boundary that drops the `retryable` flag.
 */
const RETRYABLE_MESSAGE_PATTERN =
  /(fetch failed|socket hang up|timed out|timeout|stalled|connection closed|truncated|premature close|EAI_AGAIN|ECONNRESET|ETIMEDOUT)/i;

/** 5xx is the server's problem and usually passes; 429 says "later". */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** An HTTP status this module refuses to accept, carrying its retry verdict. */
class HttpStatusError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
    this.retryable = isRetryableStatus(status);
  }
}

/** Tag an error with an explicit retry verdict, which `isRetryableError` honours. */
function markRetryable(error, retryable) {
  error.retryable = retryable;
  return error;
}

/**
 * Should another attempt be made? An explicit `retryable` flag always wins —
 * everything this module raises sets one — so the heuristics below only ever
 * see errors thrown by Node, undici or a caller's own fetch code.
 */
function isRetryableError(error, depth = 0) {
  if (!error || depth > 3) return false;
  if (typeof error.retryable === 'boolean') return error.retryable;
  if (typeof error.status === 'number') return isRetryableStatus(error.status);
  if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) return true;
  if (error.cause && error.cause !== error && isRetryableError(error.cause, depth + 1)) return true;
  return RETRYABLE_MESSAGE_PATTERN.test(String(error.message || ''));
}

/**
 * `Retry-After` in milliseconds, accepting both forms the RFC allows (delta
 * seconds and an HTTP date). Anything unparseable, negative or absurd is
 * ignored in favour of the normal backoff.
 * @param {string|undefined} value
 * @param {number} [now]
 */
function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

/**
 * Delay before `attempt + 1`, given `attempt` just failed: the nominal
 * exponential step plus up to `JITTER_RATIO` of it, or the server's
 * `Retry-After` when that asks for longer (capped).
 * @param {number} attempt 1-based number of the attempt that just failed
 * @param {{retryAfterMs?: number|null, random?: () => number}} [options]
 */
function delayForAttempt(attempt, options = {}) {
  const random = options.random || Math.random;
  const nominal = BASE_DELAY_MS * BACKOFF_FACTOR ** (attempt - 1);
  const jittered = Math.round(nominal * (1 + JITTER_RATIO * random()));
  const retryAfterMs = options.retryAfterMs;
  if (typeof retryAfterMs === 'number' && retryAfterMs > jittered) {
    return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  return jittered;
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The final error a caller sees: it names what failed, how many attempts were
 * spent and why the last one failed, and keeps the original as `cause` (plus
 * `status`/`code`, which callers and tests match on).
 */
function exhaustedError(label, error, attempt, attempts, retried) {
  const summary = retried
    ? `${label} failed after ${attempt} attempt(s) of ${attempts}`
    : `${label} failed on attempt ${attempt} and was not retried (not a transient failure)`;
  const wrapped = new Error(`${summary}: ${error.message}`, { cause: error });
  if (error.status !== undefined) wrapped.status = error.status;
  if (error.code !== undefined) wrapped.code = error.code;
  if (error.url !== undefined) wrapped.url = error.url;
  wrapped.attempts = attempt;
  wrapped.retryable = false;
  return wrapped;
}

/**
 * Run `fn` until it succeeds, it fails with something not worth retrying, or
 * the attempts run out.
 *
 * @param {string} label human-readable name for the logs and the final error
 * @param {(attempt: number) => Promise<any>} fn
 * @param {{
 *   attempts?: number,
 *   log?: (message: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   isRetryable?: (error: Error) => boolean,
 * }} [options]
 */
async function withRetry(label, fn, options = {}) {
  const attempts = options.attempts || MAX_ATTEMPTS;
  const log = options.log || ((message) => console.warn(message));
  const sleep = options.sleep || sleepFor;
  const retryable = options.isRetryable || isRetryableError;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!retryable(error)) throw exhaustedError(label, error, attempt, attempts, false);
      if (attempt === attempts) break;
      const delayMs = delayForAttempt(attempt, {
        retryAfterMs: error.retryAfterMs,
        random: options.random,
      });
      log(
        `${label}: attempt ${attempt}/${attempts} failed (${error.message}); ` +
          `retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }
  throw exhaustedError(label, lastError, attempts, attempts, true);
}

/** Resolve the per-request headers, which may depend on the (redirected) URL. */
function headersFor(headers, url) {
  const resolved = typeof headers === 'function' ? headers(url) : headers;
  return resolved || {};
}

/**
 * One HTTPS GET, following redirects, with the response body either buffered
 * or streamed to a file. Rejects with an error carrying an explicit
 * `retryable` verdict; never retries by itself.
 *
 * @param {string} url
 * @param {object} options see `fetchBuffer`/`downloadToFile`
 * @param {{destination?: string}} sink
 * @param {object} state shared across redirect hops of one attempt
 */
function performRequest(url, options, sink, state) {
  return new Promise((resolve, reject) => {
    const idleTimeoutMs = options.idleTimeoutMs || IDLE_TIMEOUT_MS;
    const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
    const maxBytes = options.maxBytes || 0;

    let target;
    try {
      target = new URL(url);
    } catch {
      reject(markRetryable(new Error(`Invalid URL: ${url}`), false));
      return;
    }
    // Refusing plain HTTP outright (rather than only on a redirect) keeps the
    // pinned-checksum trust model honest: every byte these fetchers install
    // arrives over TLS.
    if (target.protocol !== 'https:') {
      reject(markRetryable(new Error(`Refusing non-HTTPS URL: ${url}`), false));
      return;
    }

    let settled = false;
    let file = null;
    const tempPath = sink.tempPath || null;

    const cleanupFile = (done) => {
      if (!tempPath) return done();
      if (file) file.destroy();
      fs.unlink(tempPath, () => done());
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      state.abort = null;
      cleanupFile(() => reject(error));
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      state.abort = null;
      resolve(value);
    };

    state.url = url;

    const request = https.get(url, { headers: headersFor(options.headers, url) }, (response) => {
      // A response we hand off or abandon still needs an 'error' listener: an
      // unhandled 'error' on an EventEmitter takes down the whole process.
      response.on('error', (error) => fail(markRetryable(error, isRetryableError(error))));

      const status = response.statusCode;

      if (REDIRECT_STATUS_CODES.has(status)) {
        // Drain so the socket can be reused; the next hop owns completion.
        response.resume();
        if (!response.headers.location) {
          fail(
            markRetryable(new Error(`Redirect ${status} with no Location header for ${url}`), false)
          );
          return;
        }
        if (state.redirects >= maxRedirects) {
          fail(markRetryable(new Error(`Too many redirects for ${url}`), false));
          return;
        }
        let location;
        try {
          location = new URL(response.headers.location, url);
        } catch {
          fail(
            markRetryable(
              new Error(`Invalid redirect for ${url}: ${response.headers.location}`),
              false
            )
          );
          return;
        }
        if (location.protocol !== 'https:') {
          fail(markRetryable(new Error(`Refusing non-HTTPS redirect for ${url}`), false));
          return;
        }
        if (options.onRedirect) options.onRedirect(location, url, status);
        state.redirects += 1;
        settled = true;
        state.abort = null;
        performRequest(location.href, options, sink, state).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        const error = new HttpStatusError(status, url);
        const retryAfterMs = parseRetryAfter(response.headers['retry-after']);
        if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
        fail(error);
        return;
      }

      let size = 0;
      const overSize = () => {
        response.destroy();
        fail(markRetryable(new Error(`${url} exceeds the ${maxBytes}-byte limit`), false));
      };

      response.on('aborted', () =>
        fail(markRetryable(new Error(`${url}: connection closed mid-response`), true))
      );

      if (tempPath) {
        file = fs.createWriteStream(tempPath);
        // A local write failure (no space, no permission) is an answer, not
        // weather — fail the run rather than spending three more attempts.
        file.on('error', (error) => fail(markRetryable(error, false)));
        response.pipe(file);
        if (maxBytes) {
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) overSize();
          });
        }
        file.on('finish', () => {
          if (settled) return;
          if (!response.complete) {
            fail(markRetryable(new Error(`${url}: response truncated`), true));
            return;
          }
          file.close((error) => {
            if (error) {
              fail(markRetryable(error, false));
              return;
            }
            succeed(undefined);
          });
        });
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (maxBytes && size > maxBytes) {
          overSize();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        if (!response.complete) {
          fail(markRetryable(new Error(`${url}: response truncated`), true));
          return;
        }
        succeed(Buffer.concat(chunks));
      });
    });

    state.request = request;
    // Whoever owns the current hop is who a deadline hit has to abort.
    state.abort = (error) => {
      request.destroy(error);
      fail(error);
    };

    request.on('error', (error) => fail(markRetryable(error, isRetryableError(error))));
    request.setTimeout(idleTimeoutMs, () => {
      request.destroy(
        markRetryable(new Error(`${url}: stalled for ${idleTimeoutMs}ms with no data`), true)
      );
    });
  });
}

/**
 * One attempt, bounded by a wall-clock deadline that spans every redirect hop.
 */
function runAttempt(url, options, sink) {
  const timeoutMs = options.timeoutMs || TIMEOUTS.metadata;
  const state = { redirects: 0, request: null, abort: null, url };
  const timer = setTimeout(() => {
    const error = markRetryable(new Error(`${state.url}: timed out after ${timeoutMs}ms`), true);
    if (state.abort) state.abort(error);
    else if (state.request) state.request.destroy(error);
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return performRequest(url, options, sink, state).finally(() => clearTimeout(timer));
}

/**
 * Common options for every function below:
 *   `label`          name used in retry logs and the final error
 *   `headers`        object, or `(url) => object` when a header must not
 *                    survive a redirect off-host (e.g. an auth token)
 *   `timeoutMs`      per-attempt wall-clock deadline (default `TIMEOUTS.metadata`)
 *   `idleTimeoutMs`  socket inactivity timeout (default `IDLE_TIMEOUT_MS`)
 *   `maxRedirects`, `maxBytes`, `attempts`, `onRedirect`, `log`, `sleep`, `random`
 */

/** A single buffered GET, with no retry. Exported for tests and for callers that retry themselves. */
function fetchBufferOnce(url, options = {}) {
  return runAttempt(url, options, {});
}

/** Buffered GET with the retry policy applied. */
function fetchBuffer(url, options = {}) {
  return withRetry(
    options.label || `Download ${url}`,
    () => fetchBufferOnce(url, options),
    options
  );
}

/** Retrying GET decoded as UTF-8 text. */
async function fetchText(url, options = {}) {
  return (await fetchBuffer(url, options)).toString('utf8');
}

/**
 * Retrying GET parsed as JSON. A body that is not JSON is not retried: the
 * request succeeded, the answer is simply not what we asked for.
 */
async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw markRetryable(new Error(`Invalid JSON from ${url}: ${error.message}`), false);
  }
}

/**
 * Age past which a `<destination>.part-*` file cannot belong to a live
 * download: an attempt is bounded by the longest deadline this module hands
 * out, and a running one touches its temp file at least every
 * `IDLE_TIMEOUT_MS`. Anything older was orphaned by a process that never got
 * to clean up.
 */
const STALE_TEMP_FILE_MS = TIMEOUTS.binary;

/**
 * Delete `<destination>.part-*` files left behind by a download that was killed
 * outright — a cancelled CI job, a Ctrl-C — rather than failing: that process
 * never reached its own cleanup, and since every attempt picks a fresh random
 * suffix, nothing later ever overwrites or removes the orphan. It then ships:
 * the packaged build's `extraResources` globs (`ant-bin/**\/*` and friends) take
 * whatever is in the directory, junk partial archives included.
 *
 * Only files older than `STALE_TEMP_FILE_MS` are touched, so a download of the
 * same destination running in another process cannot have its in-flight temp
 * file deleted out from under it. Best-effort throughout: a temp file that
 * cannot be read or removed is not worth failing a download over.
 *
 * @param {string} destination
 * @param {{now?: number}} [options]
 */
function removeStaleTempFiles(destination, options = {}) {
  const now = options.now ?? Date.now();
  const directory = path.dirname(destination);
  const prefix = `${path.basename(destination)}.part-`;
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const orphan = path.join(directory, entry);
    try {
      if (now - fs.statSync(orphan).mtimeMs < STALE_TEMP_FILE_MS) continue;
      fs.unlinkSync(orphan);
    } catch {
      // best-effort cleanup
    }
  }
}

/** A single streamed download to `destination`, with no retry. */
function downloadToFileOnce(url, destination, options = {}) {
  // Temp file in the destination directory so the rename is atomic (same
  // filesystem) and a crashed attempt cannot leave a partial file behind
  // under the name the next step reads.
  const tempPath = `${destination}.part-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  removeStaleTempFiles(destination);
  return runAttempt(url, options, { destination, tempPath }).then(() => {
    fs.renameSync(tempPath, destination);
  });
}

/** Streamed download with the retry policy applied; the file appears only on success. */
function downloadToFile(url, destination, options = {}) {
  return withRetry(
    options.label || `Download ${url}`,
    () => downloadToFileOnce(url, destination, options),
    options
  );
}

module.exports = {
  MAX_ATTEMPTS,
  BASE_DELAY_MS,
  BACKOFF_FACTOR,
  JITTER_RATIO,
  RETRY_AFTER_CAP_MS,
  TIMEOUTS,
  IDLE_TIMEOUT_MS,
  STALE_TEMP_FILE_MS,
  MAX_REDIRECTS,
  REDIRECT_STATUS_CODES,
  RETRYABLE_ERROR_CODES,
  HttpStatusError,
  isRetryableStatus,
  isRetryableError,
  markRetryable,
  parseRetryAfter,
  delayForAttempt,
  withRetry,
  fetchBufferOnce,
  fetchBuffer,
  fetchText,
  fetchJson,
  removeStaleTempFiles,
  downloadToFileOnce,
  downloadToFile,
};
