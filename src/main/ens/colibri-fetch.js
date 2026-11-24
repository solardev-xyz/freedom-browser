/**
 * Main's fetches for the Colibri service (freedom-core design 0014, "Main's
 * fetches"): the `shell.colibri_fetch` executor. For each data request a
 * `freedom-colibrid` process asks for, main does what the WASM path's
 * `fetch_from_servers` did (`cjs/http.js`), through the session, and only
 * for the request shapes the open operation allows
 * (`colibri-fetch-contract.js`).
 *
 * - **Admission:** the fetch's `request` names one of the process's open
 *   operations (the caller's registry). A fetch the contract refuses, or
 *   one for an operation past its deadline, is answered
 *   `Colibri fetch refused` and logged at warn with the chain, the type and
 *   the rule, never the path or the payload. The process isn't killed: the
 *   contract already bounds what it can reach. Nothing else bounds how many
 *   it may send, and warn lines are written synchronously, so each process
 *   generation logs at most 10 refusals in a rolling minute; past that, one
 *   warn a minute counts those it didn't log (written with the next
 *   refusal a minute after the first one held back).
 * - **A checkpoint's roots** (`checkpoint_root`) are never fetched: main
 *   answers them from its quorum, through the operation's `answerRoot`
 *   (checkpoint-colibrid.js gives it to `colibri.checkpoint`), as the one
 *   checkpointz server the process has (node 0): `{"data":{"root":"0x…"}}`,
 *   under the pool, the cancel and the deadline as a fetch. A quorum that
 *   gives no root is `Colibri checkpoint root unavailable`, its reason
 *   kept by the check. An operation without `answerRoot` has them refused,
 *   logged with the rule `local`. Each fetch refused for an operation
 *   that asks (`onRefused`) is told to it, with the rule and the type.
 * - **A checkpoint's proof** (`checkpoint_proof`), main's own request to
 *   the chain's prover, as the WASM path's checkpoint worker made it
 *   (`fetchBytes`): it succeeds on HTTP 200 alone, any other status failing
 *   as an error status does; and each attempt, its body included, has 20 s
 *   at most (`REQUEST_MS`) within the request's deadline. Past them the
 *   attempt fails as a transport failure does (`… failed: fetch failed`),
 *   and the next server is tried (the proof has one).
 * - **The pool:** before the first send, the variant's body maximum is
 *   reserved from main's Colibri fetch pool (`colibri-fetch-pool.js`); with
 *   no room, nothing is sent and the answer is `Colibri fetch pool full`.
 *   A mask that excludes every server sends nothing and reserves nothing:
 *   `All nodes failed`, as `fetch_from_servers` throws its first error.
 * - **The servers,** in turn, through `makeHop()` over `netGatewayFetch`
 *   (the session's proxy and Tor PAC, the onion gate, no cookies and no
 *   cache, `redirect: 'manual'`), the endpoint policy (`validateRpcUrl`) on
 *   every hop. The default hop dials on the default session, for a private
 *   window's process too, as the core's `shell.rpc` does for a private
 *   read (colibri-service.js passes no other `hop`). The request is the contract's: the joined URL, its verb,
 *   `Accept`, `Content-Type` only with a payload, `Cache-Control: max-age`
 *   only where the variant has one. Every attempt is bounded by the
 *   handler's signal (the service's cancel) and the operation's deadline;
 *   past the deadline the fetch is `timeout`, as main's other executors
 *   have it. The first success wins, its index in the type's list is the
 *   head's `node`; otherwise the last server's error is the answer.
 * - **Redirects:** a GET follows at most 3 (301, 302, 303, 307, 308), each
 *   to the same server's origin and to the same variant with the same
 *   fields (the `Location` re-admitted for the same operation, not counted
 *   again); a POST follows none. Any other 3xx fails that server:
 *   `HTTP error! Status: <n>, Details: redirect refused`.
 * - **Bodies:** read whole before the head goes, counted as decoded bytes
 *   (Chromium decodes a compressed body). `Content-Length` is a hint: a
 *   declared length over the maximum fails that server unread. Past the
 *   maximum the read is aborted, and that server fails with
 *   `Request to <url> failed: response over <n> bytes`; the next one is
 *   tried under the same reservation.
 * - **Error texts** as `fetch_from_servers` writes them: `HTTP error!
 *   Status: <n>, Details: <body>` (the body decoded as `response.text()`
 *   decodes it: UTF-8, a BOM dropped, a broken or unfinished sequence
 *   U+FFFD), `Request to <url>[ with payload <JSON>] failed: fetch failed`
 *   (the reason is Node's, whatever the session's stack said), `All nodes
 *   failed`; then URLs replaced by `<url>` (deviation `fetch-error-text`),
 *   then cut to 2,000 UTF-16 units, never inside a character. The service
 *   gets them as the head's `error`, which the C core gets as the fetch's
 *   error. An error body is read up to 1 MiB, or the variant's maximum if
 *   that is less, under the fetch's reservation, then the rest is torn
 *   down: the text is the reference's unless a URL runs past that bound,
 *   where the reference would hide it to its end and go on.
 * - **Success:** the reservation shrinks to the body's length, and the
 *   answer is the head `{ node, bytes }` with the body on the service's
 *   stream (`StreamedReply`; the service client adds `body: true`). The
 *   body is kept as pieces of at most 64 KiB, each its own allocation;
 *   each piece's bytes go back to the reservation once the service's
 *   credit has taken it whole and main has let go of it, the rest when the
 *   stream ends or is cancelled. So what the pool no longer counts, main
 *   no longer holds.
 */

const defaultLog = require('../logger');
const { MAX_DATA } = require('../core/frame');
const { ShellError, StreamedReply } = require('../core/service-client');
const { isOk, makeHop, unlessAborted, withDeadline } = require('../core/naming-shell');
const { validateRpcUrl } = require('../networks/network-registry');
const { admit, joinPath, sameVariant } = require('./colibri-fetch-contract');
const { colibriFetchPool } = require('./colibri-fetch-pool');
const { REQUEST_MS } = require('../myotis/checkpoint-evidence');

/** What main answers the service, besides a server's own error. */
const COLIBRI_FETCH_TEXTS = Object.freeze({
  refused: 'Colibri fetch refused',
  poolFull: 'Colibri fetch pool full',
  allFailed: 'All nodes failed',
  rootUnavailable: 'Colibri checkpoint root unavailable',
});

/** A transport failure's reason: Node's `fetch` text, which
 * `createError` and `retryableColibriError` read today. */
const TRANSPORT_REASON = 'fetch failed';
/** The redirects a GET follows, and how many. */
const FOLLOWED = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
/** The most of an error body main reads for its details (and never more
 * than the variant's maximum, which the fetch has reserved). */
const ERROR_DETAIL_BYTES = 1024 * 1024;
/** The longest text the service gets, in UTF-16 units. */
const MAX_ERROR_UNITS = 2000;
/** As `colibri-resolver.js` hides URLs in its logs. */
const URLS = /https?:\/\/[^\s"'<>]+/gi;
/** The variants main answers itself, never from the network: the
 * checkpoint's roots come from main's quorum (design 0014, the
 * `colibri.checkpoint` row), which the checkpoint path supplies. */
const LOCAL_VARIANTS = new Set(['checkpoint_root']);
/** The variants that succeed on HTTP 200 alone: the checkpoint's proof, as
 * the WASM path's worker took it. */
const EXACTLY_200 = new Set(['checkpoint_proof']);
/** The longest one attempt of a variant may take, its body included, within
 * the request's deadline: the checkpoint's proof, as the WASM path's worker
 * bounded the whole fetch (`fetchBytes`' `REQUEST_MS`). */
const ATTEMPT_MS = Object.freeze({ checkpoint_proof: REQUEST_MS });
/** A root as main's quorum gives it. */
const ROOT = /^0x[0-9a-f]{64}$/;
/** Refusals one process generation logs one by one in a rolling minute. */
const REFUSALS_LOGGED = 10;
const MINUTE_MS = 60_000;
/** The types a fetch may name, as the warn log may print them. */
const LOGGED_TYPES = new Set([
  'prover',
  'beacon_api',
  'checkpointz',
  'checkpoint_proof',
  'eth_rpc',
]);

const isRedirect = (status) => status >= 300 && status < 400;

/** `text`'s first `units` UTF-16 units, never splitting a surrogate pair. */
function cutUnits(text, units) {
  if (text.length <= units) return text;
  const last = text.charCodeAt(units - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? units - 1 : units;
  return text.slice(0, end);
}

/** A text as the service gets it: URLs hidden, then cut. */
function errorText(text) {
  return cutUnits(text.replace(URLS, '<url>'), MAX_ERROR_UNITS);
}

/** An error body's details, as `response.text()` decodes it: UTF-8, its
 * BOM dropped, a broken or unfinished sequence U+FFFD. */
function details(body) {
  return new TextDecoder('utf-8').decode(body);
}

/** The request headers the contract allows (`fetch_from_servers`'). */
function requestHeaders(fetch) {
  const headers = { Accept: fetch.accept };
  if (fetch.payload !== null) headers['Content-Type'] = 'application/json';
  if (fetch.maxAge !== null) headers['Cache-Control'] = `max-age=${fetch.maxAge}`;
  return headers;
}

/** `op` with one fewer fetch of `variant` taken: a redirect re-admits the
 * fetch it continues. */
function withoutOne(op, variant) {
  const taken = op.taken?.[variant] ?? 1;
  return { ...op, taken: { ...op.taken, [variant]: Math.max(0, taken - 1) } };
}

/**
 * Where a GET's redirect may go, or null: a `Location` on the server's
 * origin, under the server's base, whose path the contract admits for the
 * same operation as the same variant with the same fields.
 */
function redirectTarget(location, { server, current, op, params, fetch }) {
  if (typeof location !== 'string' || !location) return null;
  let target;
  let base;
  try {
    target = new URL(location, current);
    base = new URL(server);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  const prefix = base.href.endsWith('/') ? base.href : `${base.href}/`;
  if (!target.href.startsWith(prefix)) return null;
  const path = target.href.slice(prefix.length);
  const again = admit(withoutOne(op, fetch.variant), { ...params, path });
  return !again.refused && sameVariant(fetch, again) ? joinPath(server, path) : null;
}

/**
 * One server: its body, or the error `fetch_from_servers` would record for
 * it (`{ body }` or `{ error }`). A cancel or the deadline throws.
 */
/** One attempt's failure as `fetch_from_servers` records it: `Request to
 * <url>[ with payload <JSON>] failed: <reason>`. */
function attemptFailure(server, fetch, reason) {
  const payload = fetch.payload === null ? '' : ` with payload ${fetch.payload}`;
  return { error: `Request to ${joinPath(server, fetch.path)}${payload} failed: ${reason}` };
}

async function fromServer(server, { fetch, params, op, hop, signal }) {
  const first = joinPath(server, fetch.path);
  const failed = (reason) => attemptFailure(server, fetch, reason);
  const headers = requestHeaders(fetch);
  const ok = EXACTLY_200.has(fetch.variant) ? (status) => status === 200 : isOk;
  let url = first;
  for (let hops = 0; ; hops += 1) {
    if (signal.aborted) throw signal.reason;
    if (validateRpcUrl(url) !== null) return failed(TRANSPORT_REASON);
    let response;
    try {
      response = await hop(url, {
        method: fetch.verb,
        headers,
        body: fetch.payload ?? undefined,
        signal,
        max: fetch.maxBody,
        read: ok,
        excerpt: (status) => (isRedirect(status) ? 0 : Math.min(ERROR_DETAIL_BYTES, fetch.maxBody)),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof ShellError && err.code === 'too_large') {
        return failed(`response over ${fetch.maxBody} bytes`);
      }
      return failed(TRANSPORT_REASON);
    }
    const { status } = response;
    if (isRedirect(status)) {
      const next =
        fetch.verb === 'GET' && FOLLOWED.has(status) && hops < MAX_REDIRECTS
          ? redirectTarget(response.headers.location, { server, current: url, op, params, fetch })
          : null;
      if (next === null)
        return { error: `HTTP error! Status: ${status}, Details: redirect refused` };
      url = next;
      continue;
    }
    if (!ok(status)) {
      return { error: `HTTP error! Status: ${status}, Details: ${details(response.body)}` };
    }
    return { body: response.body };
  }
}

/**
 * One server, within the variant's bound for an attempt (`ATTEMPT_MS`), if
 * it has one: past it, the attempt is a transport failure, as an attempt the
 * hop timed out is. The request's own cancel and deadline still throw.
 */
async function boundedFromServer(server, context) {
  const ms = ATTEMPT_MS[context.fetch.variant];
  if (ms === undefined) return fromServer(server, context);
  const cut = new AbortController();
  const timer = setTimeout(() => cut.abort(), ms);
  try {
    return await fromServer(server, {
      ...context,
      signal: AbortSignal.any([context.signal, cut.signal]),
    });
  } catch (err) {
    if (cut.signal.aborted && !context.signal.aborted) {
      return attemptFailure(server, context.fetch, TRANSPORT_REASON);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The servers in turn: the first body and its node, or the last error,
 * as the service gets it. */
async function fromServers(context) {
  let last = COLIBRI_FETCH_TEXTS.allFailed;
  for (const { url, node } of context.fetch.attempts) {
    const outcome = await boundedFromServer(url, context);
    if (outcome.body) return { body: outcome.body, node };
    last = errorText(outcome.error);
  }
  return { error: last };
}

/**
 * A body as pieces of at most 64 KiB, each copied into an allocation of its
 * own: no piece is a view of the response's buffer, so once every piece is
 * made the response's buffer can go.
 */
function ownedPieces(body) {
  const pieces = [];
  for (let at = 0; at < body.length; at += MAX_DATA) {
    const end = Math.min(at + MAX_DATA, body.length);
    const piece = new Uint8Array(end - at);
    piece.set(body.subarray(at, end));
    pieces.push(piece);
  }
  return pieces;
}

/**
 * A checkpoint's root from main's quorum (`op.answerRoot`), answered as the
 * checkpointz server `node` would: `{"data":{"root"}}`, under the pool,
 * the cancel and the deadline as a fetch. A cancel or the deadline throws;
 * a quorum that gives no root is `rootUnavailable`.
 */
async function rootAnswer(op, fetch, { node, pool, signal, now }) {
  const reservation = pool.reserve(fetch.maxBody);
  if (!reservation) return { error: COLIBRI_FETCH_TEXTS.poolFull };
  let reply = null;
  try {
    const deadline = { deadline_ms: Math.max(0, Math.ceil(op.deadlineAt - now())) };
    const root = await withDeadline(deadline, signal, async (within) => {
      try {
        const asked = Promise.resolve().then(() =>
          op.answerRoot(fetch.fields.slot, { signal: within })
        );
        return await unlessAborted(asked, within);
      } catch (err) {
        if (within.aborted) throw err;
        return null;
      }
    });
    if (typeof root !== 'string' || !ROOT.test(root)) {
      return { error: COLIBRI_FETCH_TEXTS.rootUnavailable };
    }
    const body = Buffer.from(JSON.stringify({ data: { root } }));
    reservation.shrink(body.length);
    reply = new StreamedReply(
      { node, bytes: body.length },
      bodyStream(ownedPieces(body), reservation)
    );
    return reply;
  } finally {
    if (!reply) reservation.close();
  }
}

/**
 * The body as the service client reads it: a byte stream of at most 64 KiB
 * a read, from `pieces`, which it empties as it goes. A piece read whole is
 * let go of, then its bytes go back to the reservation; the rest goes back
 * when the stream ends or is cancelled. So the pieces left hold no more
 * than the reservation counts.
 */
function bodyStream(pieces, reservation) {
  // Bytes of the first piece already read.
  let offset = 0;
  const done = () => {
    pieces.length = 0;
    reservation.close();
  };
  return new ReadableStream(
    {
      type: 'bytes',
      start(controller) {
        if (pieces.length === 0) {
          controller.close();
          done();
        }
      },
      pull(controller) {
        if (pieces.length === 0) return;
        const request = controller.byobRequest;
        const piece = pieces[0];
        const n = Math.min(request ? request.view.byteLength : MAX_DATA, piece.length - offset);
        const part = piece.subarray(offset, offset + n);
        if (request) {
          request.view.set(part);
          request.respond(n);
        } else {
          // A copy: enqueueing a view gives its buffer away.
          controller.enqueue(part.slice());
        }
        offset += n;
        if (offset < piece.length) return;
        offset = 0;
        reservation.release(pieces.shift().length);
        if (pieces.length === 0) {
          controller.close();
          done();
        }
      },
      cancel() {
        done();
      },
    },
    { highWaterMark: 0 }
  );
}

/**
 * The refusals' warn log, rate-limited per process generation: at most
 * `REFUSALS_LOGGED` in a rolling minute, each with its chain, type and
 * rule; those past it are counted, and the count is written once a minute
 * has passed since the first of them, with the next refusal. A new
 * generation starts with its own budget.
 */
function refusalLog(log, now) {
  let state = null;
  return (generation, fields) => {
    const at = now();
    if (state?.generation !== generation) {
      state = { generation, logged: [], held: 0, heldSince: 0 };
    }
    while (state.logged.length && state.logged[0] <= at - MINUTE_MS) state.logged.shift();
    if (state.held > 0 && at - state.heldSince >= MINUTE_MS) {
      log.warn('[Colibri] fetch refusals not logged', { count: state.held });
      state.held = 0;
    }
    if (state.logged.length < REFUSALS_LOGGED) {
      state.logged.push(at);
      log.warn('[Colibri] fetch refused', fields);
      return;
    }
    if (state.held === 0) state.heldSince = at;
    state.held += 1;
  };
}

/**
 * The open operation a fetch names, as `admit` takes it: null for none,
 * and marked ended once past its deadline.
 */
function openOperation(operations, request, generation, now) {
  if (!Number.isSafeInteger(request) || request <= 0) return null;
  const op = operations.get(request, { generation }) ?? null;
  if (!op) return null;
  if (!Number.isFinite(op.deadlineAt)) {
    throw new TypeError('Colibri operation needs its deadline (deadlineAt)');
  }
  return op.deadlineAt <= now() ? { ...op, ended: true } : op;
}

/**
 * The `shell.colibri_fetch` handler for one process's connection, to
 * register with `{ streams: true }`.
 *
 * @param {object} options
 * @param {{get(id: number, context: {generation: number}): object|undefined}} options.operations -
 *   the process's open operations by main's request ID (a Map will do):
 *   each as `admit` takes it (`colibri-fetch-contract.js`), with
 *   `deadlineAt`, the time (`now()`) its deadline passes, and the same
 *   object for its life: each admitted fetch is counted in its `taken`. A
 *   checkpoint's may have `answerRoot(slot, { signal })`, main's quorum
 *   for its roots, and `onRefused(rule, type)`, told of each refusal
 * @param {import('./colibri-fetch-pool').ColibriFetchPool} [options.pool] - the browser's by default
 * @param {Function} [options.hop] - `makeHop()` over the session by default
 * @param {object} [options.log]
 * @param {Function} [options.now] - main's clock, for deadlines and the refusals' log
 * @returns {Function} `(params, { signal, generation })`
 */
function colibriFetchHandler({
  operations,
  pool = colibriFetchPool,
  hop = makeHop(),
  log = defaultLog,
  now = Date.now,
} = {}) {
  if (typeof operations?.get !== 'function') {
    throw new TypeError("The Colibri fetch handler needs the process's operations");
  }
  const logRefusal = refusalLog(log, now);
  const refuse = (generation, op, params, rule) => {
    const type = LOGGED_TYPES.has(params?.type) ? params.type : 'other';
    logRefusal(generation, { chain: op?.chain ?? null, type, rule });
    // The open operation hears of it, if it asks (a checkpoint's check).
    if (op && !op.ended && typeof op.onRefused === 'function') {
      try {
        op.onRefused(rule, type);
      } catch (err) {
        log.warn('[Colibri] refusal hook failed', { code: err?.code || err?.name || 'error' });
      }
    }
    return { error: COLIBRI_FETCH_TEXTS.refused };
  };
  return async (params, { signal = new AbortController().signal, generation = null } = {}) => {
    const op = openOperation(operations, params?.request, generation, now);
    const fetch = admit(op, params);
    if (fetch.refused) return refuse(generation, op, params, fetch.refused);
    const local = LOCAL_VARIANTS.has(fetch.variant);
    if (local && typeof op.answerRoot !== 'function') {
      return refuse(generation, op, params, 'local');
    }
    op.taken = { ...op.taken, [fetch.variant]: (op.taken?.[fetch.variant] ?? 0) + 1 };
    if (fetch.attempts.length === 0) return { error: COLIBRI_FETCH_TEXTS.allFailed };
    if (signal.aborted) throw new ShellError('cancelled');
    if (local) return rootAnswer(op, fetch, { node: fetch.attempts[0].node, pool, signal, now });
    const reservation = pool.reserve(fetch.maxBody);
    if (!reservation) return { error: COLIBRI_FETCH_TEXTS.poolFull };
    let reply = null;
    try {
      const deadline = { deadline_ms: Math.max(0, Math.ceil(op.deadlineAt - now())) };
      const outcome = await withDeadline(deadline, signal, (within) =>
        fromServers({ fetch, params, op, hop, signal: within })
      );
      if (outcome.error !== undefined) return { error: outcome.error };
      const { length } = outcome.body;
      reservation.shrink(length);
      reply = new StreamedReply(
        { node: outcome.node, bytes: length },
        bodyStream(ownedPieces(outcome.body), reservation)
      );
      return reply;
    } finally {
      if (!reply) reservation.close();
    }
  };
}

module.exports = {
  COLIBRI_FETCH_TEXTS,
  ERROR_DETAIL_BYTES,
  MAX_ERROR_UNITS,
  MAX_REDIRECTS,
  REFUSALS_LOGGED,
  bodyStream,
  colibriFetchHandler,
  cutUnits,
  errorText,
  ownedPieces,
};
