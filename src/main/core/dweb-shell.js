/**
 * Main's executor for the core's `shell.dweb_get` (freedom-core design
 * 0009, `shell.dweb_get` and Main's side): one piece of a running
 * `dweb.verify`, fetched through the backend that request captured, under
 * its plan's retry and timers, and answered whole or as a stream under the
 * core's credit.
 *
 * - **Protocol 2 only.** `registerDwebShell` registers the handler only on
 *   a client that asks for protocol 2, so only once a hello has settled it
 *   (any other answer is a mismatch), with `streams: true`. A request that
 *   comes without the duplex is `unknown_method`, as it is at protocol 1.
 *   Against the pinned core, which speaks protocol 1, nothing is
 *   registered.
 * - **`for`** is the envelope ID of main's `dweb.verify`, in the generation
 *   that asks: `open()` keys it by the ID and generation `onSent` reports
 *   (service-client.js). A piece gets that request's captured backend, its
 *   plan's retry and timers, its page signal and its session, so the core
 *   can't send a piece to another node, session or retry policy. The
 *   request's end (`close()`), its page's abort and its session's close stop
 *   every piece of it, dialling or streaming.
 * - **Read strictly, before any dial:** exactly `{ for, path, headers,
 *   stream, max_bytes }`. The path is one of the closed set of forms for the
 *   backend's node; the headers are exactly that form's, at its values; and
 *   `stream` and `max_bytes` are as the form says. Anything else is
 *   `invalid_argument`, logged as a core fault. A `for` that has ended is
 *   refused too, but it is a race, not a fault.
 * - **The dial** is the plan executor's (`plan-executor.js`): its retry
 *   loop and the backend's `request()`, so loopback undici, the session's
 *   stack for a remote Ant or gateway, the onion gate and the Ant guard's
 *   announcement apply as for any dweb fetch. It is always a GET, with the
 *   plan's header deadline. A retried attempt's body is cancelled before the
 *   next.
 * - **The reply** is one of three forms. A whole piece is `{ status,
 *   headers, body_base64 }`, read up to `max_bytes`. A streamed one is
 *   `{ status, headers }` and its body (a `StreamedReply`: `body: true`, then
 *   the bytes, pulled from the node only as the core's credit allows). A
 *   dial that failed is `{ failed }`, its class: `unreachable` (refused,
 *   reset, not found), `error`, `aborted`, or `too_large` (a piece past its
 *   `max_bytes`, before its head). `headers` are only those of the four the
 *   core reads that the node sent: content-type, content-length (not from
 *   the external gateway, whose transport decodes the body, nor beside a
 *   `content-encoding`), content-range and swarm-feed-index. A name or value
 *   past 8 KiB fails the piece (`error`), logged.
 * - **A streamed body** ends with `end`, or aborts with one of a piece's
 *   codes: `stalled` when main's body idle timer fires (a read pending, so
 *   the core's credit outstanding, and no byte for the plan's
 *   `body_idle_ms`); `body_stream_error` when the node's body fails, passes
 *   `max_bytes`, or its request ends; `cancelled` on the core's cancel (the
 *   service client answers it).
 * - **Every terminal path frees the dial and its buffers:** the piece's
 *   end, the core's cancel, the `dweb.verify` request ending, the session
 *   closing.
 *
 * Nothing logged names a path: a piece names what a page asked for.
 */

const defaultLog = require('../logger');
const { ShellError, StreamedReply, PROTOCOL_VERSION_STREAMS } = require('./core-client');
const { backendKind, checkPath, SWARM_HEADERS } = require('../dweb/plan-validation');
const { dialWithRetry, idleBoundBody, UNREACHABLE_CODES } = require('../dweb/plan-executor');

/** The headers a reply may carry: those the core reads (design 0009). */
const REPLY_HEADERS = ['content-type', 'content-length', 'content-range', 'swarm-feed-index'];
/** At most this many, each name and value at most MAX_HEADER bytes. */
const MAX_REPLY_HEADERS = 8;
const MAX_HEADER = 8 * 1024;
/** A whole piece's bound: a chunk, a feed lookup, an IPNS record. */
const MAX_WHOLE = 64 * 1024;
/** A raw block's. */
const MAX_RAW = 2 * 1024 * 1024;
/** The longest path, as 0006 bounds a request URL. */
const MAX_PATH = 65_536;

const PARAMS = ['for', 'path', 'headers', 'stream', 'max_bytes'];

const CAR_ACCEPT = 'application/vnd.ipld.car; version=1; order=dfs; dups=y';
const RAW_ACCEPT = 'application/vnd.ipld.raw';
const RECORD_ACCEPT = 'application/vnd.ipfs.ipns-record';

// A CID as the core writes it: CIDv1 in lowercase base32, or a CIDv0, which
// a dag-pb link may name.
const CID = '(?:b[a-z2-7]{1,269}|Qm[1-9A-HJ-NP-Za-km-z]{44})';
const CID_PATH = new RegExp(`^/ipfs/(${CID})(?:/.*)?$`);
const RAW_PATH = new RegExp(`^/ipfs/${CID}\\?format=raw$`);
// An IPNS name: a CIDv1 of a key, in base36 (`k…`) or base32 (`b…`).
const RECORD_PATH = /^\/ipns\/[kb][0-9A-Za-z]{1,269}\?format=ipns-record$/;
const CAR_QUERY =
  /^format=car&dag-scope=entity(?:&entity-bytes=(?:[0-9]{1,20}|-[0-9]{1,20}):(?:[0-9]{1,20}|\*))?$/;
const CHUNK_PATH = /^\/chunks\/[0-9a-f]{64}$/;
const BYTES_PATH = /^\/bytes\/[0-9a-f]{64}$/;
const FEED_PATH = /^\/feeds\/[0-9a-f]{40}\/[0-9a-f]{64}$/;
const BYTE_RANGE = /^bytes=([0-9]{1,20})-([0-9]{1,20})$/;

/**
 * The forms a piece's path may take, each with what it asks for: whether it
 * streams, its bound (`whole`: at most MAX_WHOLE; `raw`: at most MAX_RAW;
 * null: none), and the headers it carries beyond any fixed ones.
 */
const FORMS = {
  chunk: { stream: false, bound: 'whole' },
  bytes: { stream: true, bound: null },
  feed: { stream: false, bound: 'whole' },
  car: { stream: true, bound: null },
  raw: { stream: true, bound: 'raw' },
  record: { stream: false, bound: 'whole' },
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The piece's form for a backend of `kind`, or null. */
function formOf(path, kind) {
  if (kind === 'ant') {
    if (CHUNK_PATH.test(path)) return 'chunk';
    if (BYTES_PATH.test(path)) return 'bytes';
    if (FEED_PATH.test(path)) return 'feed';
    return null;
  }
  if (RAW_PATH.test(path)) return 'raw';
  if (RECORD_PATH.test(path)) return 'record';
  // A CAR: a CID, a path below it that passes 0006's namespace checks, and
  // the query the core writes.
  const at = path.indexOf('?');
  if (at < 0) return null;
  const pathname = path.slice(0, at);
  if (!CID_PATH.test(pathname) || !CAR_QUERY.test(path.slice(at + 1))) return null;
  return checkPath(pathname, 'ipfs') ? 'car' : null;
}

/** Whether `headers` are exactly the form's: each name once, at its value. */
function headersFit(headers, form) {
  const expected = new Map();
  if (form === 'chunk' || form === 'bytes' || form === 'feed') {
    // Swarm's three retrieval headers, at their fixed values; a `/bytes`
    // stream's range; a feed lookup's root chunk only.
    for (const [name, value] of SWARM_HEADERS) expected.set(name, value);
    if (form === 'bytes') expected.set('range', BYTE_RANGE);
    if (form === 'feed') expected.set('swarm-only-root-chunk', 'true');
  } else {
    expected.set('accept', { car: CAR_ACCEPT, raw: RAW_ACCEPT, record: RECORD_ACCEPT }[form]);
  }
  if (headers.length !== expected.size) return false;
  const seen = new Set();
  for (const [name, value] of headers) {
    if (seen.has(name) || !expected.has(name)) return false;
    seen.add(name);
    const want = expected.get(name);
    if (want === BYTE_RANGE) {
      const range = BYTE_RANGE.exec(value);
      if (!range || BigInt(range[1]) > BigInt(range[2])) return false;
    } else if (value !== want) {
      return false;
    }
  }
  return true;
}

/**
 * The piece `params` ask for, read strictly: `{ for, path, headers, stream,
 * maxBytes }`, or the refusal's name.
 */
function readParams(params) {
  if (!isObject(params)) return 'shape';
  const keys = Object.keys(params);
  if (keys.length !== PARAMS.length || !PARAMS.every((key) => Object.hasOwn(params, key))) {
    return 'shape';
  }
  const { for: id, path, headers, stream, max_bytes: maxBytes } = params;
  if (!Number.isSafeInteger(id) || id < 1) return 'shape';
  if (typeof path !== 'string' || path.length > MAX_PATH) return 'shape';
  if (typeof stream !== 'boolean') return 'shape';
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) return 'shape';
  if (!Array.isArray(headers)) return 'shape';
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2) return 'shape';
    if (typeof pair[0] !== 'string' || typeof pair[1] !== 'string') return 'shape';
  }
  return { for: id, path, headers, stream, maxBytes };
}

/** The piece's form for a backend of `kind`, or the refusal's name. */
function checkPiece(piece, kind) {
  const form = formOf(piece.path, kind);
  if (!form) return { refusal: 'path' };
  if (!headersFit(piece.headers, form)) return { refusal: 'header' };
  const { stream, bound } = FORMS[form];
  if (piece.stream !== stream) return { refusal: 'stream' };
  const max = { whole: MAX_WHOLE, raw: MAX_RAW }[bound] ?? null;
  const fits =
    max === null ? piece.maxBytes === null : piece.maxBytes >= 1 && piece.maxBytes <= max;
  if (!fits) return { refusal: 'max_bytes' };
  return { form };
}

/** The dial's failure class, as the core maps it (fc-dweb's
 * `failure::after_dial`). */
function failureOf(err, life) {
  if (life.aborted) return 'aborted';
  const code = err?.cause?.code || err?.code || '';
  if (UNREACHABLE_CODES.has(code)) return 'unreachable';
  if (err?.name === 'AbortError') return 'aborted';
  return 'error';
}

/** The reply's headers from the node's: null when one is past the bound. */
function replyHeaders(headers, kind) {
  // The body main passes on is the transport's, already decoded.
  const decoded = kind === 'gateway' || headers.has('content-encoding');
  const out = [];
  for (const name of REPLY_HEADERS) {
    if (name === 'content-length' && decoded) continue;
    const value = headers.get(name);
    if (value === null) continue;
    if (Buffer.byteLength(value, 'utf8') > MAX_HEADER) return null;
    out.push([name, value]);
  }
  return out.length <= MAX_REPLY_HEADERS ? out : null;
}

/** The body's length, when the node declares one the bytes will have. */
function declaredLength(headers, kind) {
  if (kind === 'gateway' || headers.has('content-encoding')) return null;
  const value = headers.get('content-length');
  if (value === null || !/^[0-9]{1,16}$/.test(value)) return null;
  return Number(value);
}

class PieceTooLarge extends Error {
  constructor(max) {
    super(`dweb piece past its ${max} bytes`);
    this.name = 'PieceTooLarge';
  }
}

/** `body`, pulled only when read, failed once more than `max` bytes come. */
function boundedBody(body, max) {
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        seen += value.byteLength;
        if (seen > max) {
          reader.cancel().catch(() => {});
          controller.error(new PieceTooLarge(max));
          return;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

function emptyBody() {
  return new ReadableStream({ start: (controller) => controller.close() });
}

function cancelBody(response) {
  try {
    response?.body?.cancel().catch(() => {});
  } catch {
    // Locked or gone.
  }
}

const keyOf = (generation, id) => `${generation}:${id}`;

class DwebShell {
  /**
   * @param {object} [options]
   * @param {object} [options.log]
   */
  constructor({ log = defaultLog } = {}) {
    this.log = log;
    // The live `dweb.verify` requests, by generation and ID.
    this.live = new Map();
    // The highest ID opened in each generation: a `for` at or below it that
    // isn't live has ended.
    this.highest = new Map();
    this.pieces = 0;
  }

  /**
   * A `dweb.verify` main has sent: its pieces may be asked for until
   * `close()`, which the request's end calls (its head's error, its body's
   * end, error or cancel), and which its page's abort or its session's close
   * makes itself.
   *
   * @param {{generation: number, id: number}} key - as `onSent` reports it
   * @param {object} capture
   * @param {object} capture.backend - the backend captured at admission:
   *   `ref` and `request()` (see `plan-executor.js`)
   * @param {object} capture.plan - the `{ verify }` plan, validated: its
   *   `node`, `retry` and `timers`
   * @param {AbortSignal} [capture.signal] - the page's
   * @param {AbortSignal} [capture.stop] - aborts when the session closes
   * @returns {{ close(): void }}
   */
  open({ generation, id }, { backend, plan, signal = null, stop = null }) {
    const kind = backendKind(backend?.ref);
    const verify = plan?.verify;
    if (!kind || typeof backend.request !== 'function') throw new TypeError('no backend');
    if (!isObject(verify) || !isObject(verify.retry) || !isObject(verify.timers)) {
      throw new TypeError('no verify plan');
    }
    if (verify.node !== (kind === 'ant' ? 'ant' : 'ipfs')) {
      throw new TypeError("the plan names another backend's node");
    }
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(id) || id < 1) {
      throw new TypeError('no request ID');
    }
    const key = keyOf(generation, id);
    if (this.live.has(key)) throw new TypeError('that request is open already');
    const life = new AbortController();
    const entry = { kind, backend, retry: verify.retry, timers: verify.timers, life, pieces: 0 };
    this.live.set(key, entry);
    if (id > (this.highest.get(generation) ?? 0)) this.highest.set(generation, id);
    const sources = [signal, stop].filter(Boolean);
    const close = () => {
      for (const source of sources) source.removeEventListener('abort', close);
      if (this.live.get(key) !== entry) return;
      this.live.delete(key);
      life.abort();
    };
    for (const source of sources) {
      if (source.aborted) close();
      else source.addEventListener('abort', close, { once: true });
    }
    return { close };
  }

  /** What the shell holds, for diagnostics and tests. */
  stats() {
    return { verifies: this.live.size, pieces: this.pieces };
  }

  /** The handler: one `shell.dweb_get`. */
  async get(params, { signal, charge, streams, generation }) {
    // Without the duplex the core has no `shell.dweb_get`.
    if (!streams) throw new ShellError('unknown_method');
    const piece = readParams(params);
    if (typeof piece === 'string') return this.refuse(piece);
    const verify = this.live.get(keyOf(generation, piece.for));
    if (!verify) {
      // Above every request main opened in this generation, it was never
      // one; at or below, it has ended, and the core asked as it ended.
      const ended = piece.for <= (this.highest.get(generation) ?? 0);
      return this.refuse('for', { fault: !ended });
    }
    const { form, refusal } = checkPiece(piece, verify.kind);
    if (refusal) return this.refuse(refusal);
    return this.fetch(verify, piece, form, { signal, charge });
  }

  refuse(reason, { fault = true } = {}) {
    if (fault) this.log.error(`[Core] shell.dweb_get refused (${reason})`);
    else this.log.debug?.(`[Core] shell.dweb_get for a dweb.verify that has ended`);
    throw new ShellError('invalid_argument');
  }

  async fetch(verify, piece, form, { signal, charge }) {
    // The core's cancel, or its request's end (its close, its page's abort,
    // its session's close), stops the dial and the body alike.
    const life = AbortSignal.any([signal, verify.life.signal]);
    if (life.aborted) return { failed: 'aborted' };
    verify.pieces += 1;
    this.pieces += 1;
    let open = true;
    const done = () => {
      if (!open) return;
      open = false;
      verify.pieces -= 1;
      this.pieces -= 1;
    };
    let handed = false;
    try {
      let response;
      try {
        response = await dialWithRetry({
          retry: verify.retry,
          signal: life,
          attempt: () =>
            verify.backend
              .request({
                path: piece.path,
                method: 'GET',
                headers: new Headers(piece.headers),
                signal: life,
                headersTimeoutMs: verify.timers.headers_ms ?? null,
              })
              .then(
                (answer) => ({ response: answer }),
                (error) => ({ error })
              ),
          onRetry: (i, delay, result) =>
            this.log.debug?.(
              `[Core] shell.dweb_get retry ${i + 1}/${verify.retry.attempts - 1} in ${delay}ms ` +
                `(status=${result.response?.status ?? result.error?.code ?? 'error'})`
            ),
        });
      } catch (err) {
        return { failed: failureOf(err, life) };
      }
      // The loop stops on an abort with the last answer.
      if (life.aborted) {
        cancelBody(response);
        return { failed: 'aborted' };
      }
      const { status } = response;
      const headers = replyHeaders(response.headers, verify.kind);
      if (!Number.isInteger(status) || status < 100 || status > 599 || !headers) {
        cancelBody(response);
        this.log.warn('[Core] shell.dweb_get: the node answered past the reply bounds');
        return { failed: 'error' };
      }
      const max = piece.maxBytes;
      const declared = declaredLength(response.headers, verify.kind);
      if (max !== null && declared !== null && declared > max) {
        cancelBody(response);
        return { failed: 'too_large' };
      }
      const upstream = response.body && !response.bodyUsed ? response.body : emptyBody();
      const idleMs = verify.timers.body_idle_ms;
      if (FORMS[form].stream) {
        const bounded = max === null ? upstream : boundedBody(upstream, max);
        const body = idleBoundBody(bounded, idleMs, life, done);
        handed = true;
        return new StreamedReply({ status, headers }, body);
      }
      return await this.whole(status, headers, upstream, { max, idleMs, life, charge });
    } finally {
      if (!handed) done();
    }
  }

  /** A whole piece: its body read up to `max`, in the reply as base64. */
  async whole(status, headers, upstream, { max, idleMs, life, charge }) {
    const reader = idleBoundBody(upstream, idleMs, life, () => {}).getReader();
    const parts = [];
    let length = 0;
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        // The idle bound, the node's failure, or an abort.
        return { failed: failureOf(err, life) };
      }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > max) {
        reader.cancel().catch(() => {});
        return { failed: 'too_large' };
      }
      if (!charge(chunk.value.byteLength)) {
        reader.cancel().catch(() => {});
        throw new ShellError('busy');
      }
      parts.push(chunk.value);
    }
    const body = Buffer.concat(parts, length).toString('base64');
    if (!charge(body.length)) throw new ShellError('busy');
    return { status, headers, body_base64: body };
  }
}

/**
 * Registers `shell.dweb_get` on `client` when it speaks protocol 2: the
 * shell, whose `open()` a `dweb.verify` request calls, or null.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {object} [deps] - test seams: log
 * @returns {DwebShell|null}
 */
function registerDwebShell(client, deps = {}) {
  if (client.protocol !== PROTOCOL_VERSION_STREAMS) return null;
  const shell = new DwebShell(deps);
  client.handle('shell.dweb_get', (params, context) => shell.get(params, context), {
    streams: true,
  });
  return shell;
}

module.exports = {
  registerDwebShell,
  DwebShell,
  REPLY_HEADERS,
  MAX_REPLY_HEADERS,
  MAX_HEADER,
  MAX_WHOLE,
  MAX_RAW,
  CAR_ACCEPT,
  RAW_ACCEPT,
  RECORD_ACCEPT,
};
