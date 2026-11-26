/**
 * Main's executor for the core's Swarm asks (freedom-core design 0015,
 * Node access, Main's Swarm I/O pool, The transport, Deadlines and cancel,
 * and SWM-5's calls): `shell.swarm_ready` and `shell.swarm_api`, for the
 * Swarm requests main sends the core (the **parents**: `swarm.request`,
 * `swarm.publish`, `swarm.feed`, `swarm.stamps`, `swarm.upload_status`).
 * Each call is admitted by the operation grammar (swarm-grammar.js) before
 * anything is dialled, and dialled once on the node's transport the parent
 * captured (`antBackend()`, swarm/ant-api-call.js).
 *
 * - **The switch** (swarm/swarm-backend-kind.js): `registerSwarmShell`
 *   registers the handlers whichever backend runs, so a stray ask is
 *   answered `ended` (an `unknown_method` would end the core's
 *   connection), and `open()` throws unless FREEDOM_SWARM_BACKEND selects
 *   `core`: on `js` no parent is ever admitted.
 * - **The parent registry:** `open({ generation, id }, capture)`, called
 *   from the parent's `onSent` (service-client.js), before the core can
 *   ask anything for it. A parent keeps its row's `Admission` (built from
 *   the params main sent and the page's key), the backend it captured, its
 *   signal and its session's stop, its deadline and its parts. Its end
 *   (`close()`, the signal, the stop, the deadline) stops every call of it,
 *   dialling or streaming, and nothing more is admitted for it. A `for` at
 *   or below the highest ID opened in its generation has ended (a race);
 *   one above it was never sent (a core fault).
 * - **Read strictly:** `shell.swarm_ready` is exactly `{ for, check }`;
 *   `shell.swarm_api` exactly the core's members (`for`, `form`, `method`,
 *   `path`, `query`, `headers`, `max_bytes`, `stream`, and `body`, `feed`
 *   and `tree` where they apply), `feed` exactly `{ owner, index }` and
 *   `tree` exactly `{ length, depth }`; everything else is the grammar's
 *   (types, forms, values, bounds). A call that fails is refused with the
 *   rule it breaks.
 * - **Error answers** are only the two the core reads (SWM-5's point 4):
 *   `invalid_argument` with `data: { rule }`, for a refused call (or a
 *   ready check main can't take, which the core reads as a fault), and
 *   `cancelled`, which the service client sends at once for the core's
 *   cancel (`race`; a handler's charges go once it settles). Anything else
 *   is the ask's own failure form: `{ failed: "error" }` for a call, `{
 *   ok: false, reason: "node-stopped" }` for a ready check.
 * - **`shell.swarm_ready`** (point 11): once per parent, with its row's
 *   check. `reachable` is `GET /node` on the parent's transport, 5 s in
 *   all, its body read to at most 64 KiB and parsed as JSON, as
 *   `checkBeeReachable` reads it; `publish` is `getPublishReadiness()` as
 *   it stands, its `{ ok, reason }`; `subscribe` is the probe after the
 *   proxy check, a seam SWM-7 fills (question 4). A ready check whose
 *   parent main has ended is answered `cancelled` once the core cancels it,
 *   never refused (the amendment's disagreement 9): the core ends the
 *   connection on any other error to it.
 * - **`shell.swarm_api`:** admitted, then, before any dial, a remote node's
 *   header values held to one byte a character (the session's stack would
 *   send U+0080 to U+00FF as their UTF-8; rule `header`); `stopped` when
 *   there is no node to dial (the parent's backend has none, or the node's
 *   URL went since); `busy` when the pool has no room. Then one dial of the
 *   form's method, path and query (`URLSearchParams`' encoding), with main's
 *   two headers and the call's, and a base64 body as bytes: no retry, no
 *   header deadline, 60 s idle on a body (point 6).
 * - **The reply:** a status outside 200–299 is answered whole, its body
 *   read to 8 KiB and cut there. A 2xx whole call is `{ status,
 *   status_text, headers, body_base64 }`, its body at most `max_bytes`
 *   (`too_large` past it, or when its declared length is). A 2xx streaming
 *   call (`bytes`, `feed_latest`) is the head `{ status, status_text,
 *   headers }`, with no `body` member, then its bytes under the core's
 *   credit, ended `too_large` past `max_bytes` (at once, before any piece,
 *   when its declared length is). Only the five headers the core reads are
 *   forwarded, in `Headers`' order (a `content-length` beside a
 *   `content-encoding` already dropped), each value at most 1 KiB, and the
 *   reason phrase at most 1 KiB, or the call fails `error`.
 * - **The Swarm I/O pool** (swarm-io-pool.js), charged through the
 *   handlers' leases for every buffer main holds at once for a call, each
 *   before it exists:
 *   - a whole call `m + 2 × b64(m) + 16 KiB`, `m` the larger of its
 *     `max_bytes` and 8 KiB, shrunk to the same sum over the body it read
 *     (kept as the transport's chunks, never copied whole), and that body's
 *     length more when the grammar reads the answer (its one copy);
 *   - a streaming call 256 KiB, to its terminal;
 *   - a base64 POST's body, before the grammar decodes it (once, for its
 *     check and the dial): its bytes, the base64 the check writes back and
 *     the transport's copy, to the dial's end;
 *   - `readData`'s walk, its occurrence map (2,562 slots at 256 bytes),
 *     before the root's answer may fill it; without room the map stays
 *     empty, and the parent's later calls are `busy`;
 *   - a `{ failed }` answer nothing.
 *   Each is released once its reply's last byte is written, or its reply
 *   dropped (service-client.js). The ready probe's body (at most 64 KiB,
 *   until parsed) alone is uncharged: 0015 lets `shell.swarm_ready`
 *   answers go on while the pool is full.
 * - **Logs:** a refusal at `warn`, with the parent's row, its step and the
 *   rule; never a path, a value or a body.
 *
 * Not here yet: streamed uploads (`{ stream }` bodies, `swarm.body`,
 * `shell.swarm_part`) are SWM-5's sixth step. Until then such a call is
 * admitted and answered `{ failed: "error" }`, never dialled.
 */

const defaultLog = require('../logger');
const { JsonText, ShellError, StreamedReply } = require('./core-client');
const { SWARM_PIECE_ABORT_CODES } = require('./frame');
const {
  Admission,
  B,
  ERROR_REPLY,
  INLINE_BASE64,
  MAIN_HEADERS,
  REPLY_HEADERS,
  ROWS,
  requestHeaders,
} = require('./swarm-grammar');
const { CHUNK_SIZE, MAX_SLOTS, SLOT_CHARGE, decodeSpan } = require('./swarm-tree');
const { swarmIoPool } = require('./swarm-io-pool');
const { pieceBody } = require('./dweb-shell');
const { callAnt } = require('../swarm/ant-api-call');
const { UNREACHABLE_CODES } = require('../dweb/plan-executor');
const { isLoopbackGatewayUrl } = require('../ipfs/gateway-transport');

const KIB = 1024;
/** A whole call's room for the rest of its serialized reply. */
const REPLY_ROOM = 16 * KIB;
/** A stream's charge: its window, the frame being built, the transport's buffer. */
const STREAM_CHARGE = 256 * KIB;
/** An error status's body: read whole to this, and cut there. */
const ERROR_BODY = ERROR_REPLY.whole;
/** `readData`'s occurrence map, reserved when its walk starts. */
const WALK_CHARGE = MAX_SLOTS * SLOT_CHARGE;
/** `shell.swarm_ready`'s `GET /node`: 5 s in all, its body at most 64 KiB. */
const READY_TIMEOUT_MS = 5_000;
const READY_BODY = 64 * KIB;

const API_REQUIRED = ['for', 'form', 'method', 'path', 'query', 'headers', 'max_bytes', 'stream'];
const API_OPTIONAL = ['body', 'feed', 'tree'];
const READY_MEMBERS = ['for', 'check'];
const CHECKS = new Set(['publish', 'reachable', 'subscribe']);
const FORWARDED = new Set(REPLY_HEADERS.read);

const NODE_STOPPED = Object.freeze({ ok: false, reason: 'node-stopped' });

/** `b64(m)`, design 0015's 4⌈m / 3⌉. */
const b64 = (bytes) => 4 * Math.ceil(bytes / 3);
/** A whole call's charge for `m` bytes of body: the bytes, its base64 and
 * the serialized reply, every copy at once, and the reply's rest. */
const wholeCharge = (m) => m + 2 * b64(m) + REPLY_ROOM;
/** A base64 POST's charge for its `n`-byte body, to the dial's end: the
 * body decoded once, the base64 the grammar writes back to check it is
 * canonical, and the copy the transport makes to send it (undici's
 * `extractBody`). */
const postCharge = (n) => 2 * n + b64(n);

/** A base64 POST's decoded size, from its base64's length alone (nothing
 * decoded); null for a call with none, or one the grammar refuses by its
 * length before decoding it. */
function inlineBytes(call) {
  const text = call.body?.base64;
  if (typeof text !== 'string' || text.length > INLINE_BASE64) return null;
  return Buffer.byteLength(text, 'base64');
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = (generation, id) => `${generation}:${id}`;
/** Whether `value` is exactly `members`, an object with those keys. */
const exactly = (value, members) =>
  isObject(value) &&
  Object.keys(value).length === members.length &&
  members.every((member) => Object.hasOwn(value, member));
/** Whether a string is one byte a character on every stack: ASCII. */
const ascii = (text) => Buffer.byteLength(text, 'utf8') === text.length;

/** `shell.swarm_ready`'s params, read strictly: `{ for, check }`, or null. */
function readReady(params) {
  if (!exactly(params, READY_MEMBERS)) return null;
  if (!Number.isSafeInteger(params.for) || params.for < 1) return null;
  return CHECKS.has(params.check) ? { for: params.for, check: params.check } : null;
}

/**
 * `shell.swarm_api`'s params, read strictly: `{ for, call }`, the call as
 * the Admission takes it, or `{ for, rule }` (`for` null when it isn't an
 * ID). Every member's type and value is then the grammar's.
 */
function readCall(params) {
  if (!isObject(params)) return { for: null, rule: 'form' };
  const id = Number.isSafeInteger(params.for) && params.for >= 1 ? params.for : null;
  const keys = Object.keys(params);
  const known = keys.every((key) => API_REQUIRED.includes(key) || API_OPTIONAL.includes(key));
  if (id === null || !known || !API_REQUIRED.every((key) => Object.hasOwn(params, key))) {
    return { for: id, rule: 'form' };
  }
  if (Object.hasOwn(params, 'body') && !isObject(params.body)) return { for: id, rule: 'body' };
  if (Object.hasOwn(params, 'feed') && !exactly(params.feed, ['owner', 'index'])) {
    return { for: id, rule: 'value' };
  }
  if (Object.hasOwn(params, 'tree') && !exactly(params.tree, ['length', 'depth'])) {
    return { for: id, rule: 'value' };
  }
  const call = {};
  for (const key of keys) if (key !== 'for') call[key] = params[key];
  return { for: id, call };
}

/** The call's path from the node's root: the form's path and its query,
 * encoded as `URLSearchParams` encodes it. */
function target(call) {
  return call.query.length ? `${call.path}?${new URLSearchParams(call.query)}` : call.path;
}

/** The headers main forwards: the five the core reads, as `Headers` gives
 * them; null when one is past the bounds the core holds them to. */
function forwarded(headers) {
  const out = [];
  for (const [name, value] of headers) {
    if (!FORWARDED.has(name)) continue;
    if (Buffer.byteLength(value, 'utf8') > REPLY_HEADERS.value_bytes) return null;
    out.push([name, value]);
  }
  return out.length <= REPLY_HEADERS.max ? out : null;
}

/** The length the node declares, from the forwarded headers, or null. */
function declaredLength(pairs) {
  const pair = pairs.find(([name]) => name === 'content-length');
  return pair && /^[0-9]{1,16}$/.test(pair[1]) ? Number(pair[1]) : null;
}

/** A dial's failure class (0009's, as fc-dweb's `failure::after_dial`). */
function failureOf(err, life) {
  if (life.aborted) return 'aborted';
  const code = err?.cause?.code || err?.code || '';
  if (UNREACHABLE_CODES.has(code)) return 'unreachable';
  if (err?.name === 'AbortError') return 'aborted';
  return 'error';
}

function cancelBody(body) {
  try {
    body?.cancel().catch(() => {});
  } catch {
    // Locked or gone.
  }
}

function emptyBody() {
  return new ReadableStream({ start: (controller) => controller.close() });
}

/** A node's body past its call's `max_bytes`: the stream ends `too_large`. */
class NodeBodyTooLarge extends Error {
  constructor(max) {
    super(`node body past its ${max} bytes`);
    this.name = 'NodeBodyTooLarge';
    this.abortCode = 'too_large';
  }
}

/** `body`, pulled only when read, failed `too_large` before any byte past
 * `max` goes, and failed as soon as `body` fails, read or not. */
function boundedBody(body, max) {
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream(
    {
      start(controller) {
        reader.closed.then(
          () => {},
          (err) => controller.error(err)
        );
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        seen += value.byteLength;
        if (seen > max) {
          reader.cancel().catch(() => {});
          controller.error(new NodeBodyTooLarge(max));
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

/** A body that ends `too_large` at once, before any piece: the node
 * declared more than `max_bytes`. */
function tooLargeBody(max) {
  return new ReadableStream({
    type: 'bytes',
    start: (controller) => controller.error(new NodeBodyTooLarge(max)),
  });
}

/** A chunk the transport gave, as a Buffer over the same bytes: no copy. */
const viewOf = (chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

/**
 * Reads `body` whole, at most `max` bytes: `{ chunks, length }`, the
 * transport's own chunks, never copied into one buffer (that copy would be
 * a second decoded body the reservation doesn't count), or `{ failed }`
 * (its class, or `too_large` past `max`). With `cut`, a longer body is cut
 * at `max` instead (an error status's).
 */
async function readWhole(body, max, life, { cut = false } = {}) {
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      return { failed: failureOf(err, life) };
    }
    if (chunk.done) break;
    const value = viewOf(chunk.value);
    if (length + value.byteLength > max) {
      reader.cancel().catch(() => {});
      if (!cut) return { failed: 'too_large' };
      chunks.push(value.subarray(0, max - length));
      length = max;
      break;
    }
    if (value.byteLength) chunks.push(value);
    length += value.byteLength;
  }
  return { chunks, length };
}

/**
 * The base64 of `chunks`' bytes, as the strings of their runs: each run a
 * whole number of 3-byte groups but the last, so the strings joined are the
 * bytes' base64, with no copy of the bytes made whole (a carry of at most
 * two bytes moves to the next chunk).
 */
function base64Runs(chunks) {
  const runs = [];
  let carry = null;
  for (let chunk of chunks) {
    if (carry) {
      const need = 3 - carry.length;
      if (chunk.length < need) {
        carry = Buffer.concat([carry, chunk]);
        continue;
      }
      runs.push(Buffer.concat([carry, chunk.subarray(0, need)]).toString('base64'));
      chunk = chunk.subarray(need);
      carry = null;
    }
    const whole = chunk.length - (chunk.length % 3);
    if (whole) runs.push(chunk.subarray(0, whole).toString('base64'));
    if (whole < chunk.length) carry = Buffer.from(chunk.subarray(whole));
  }
  if (carry) runs.push(carry.toString('base64'));
  return runs;
}

/** The first `n` bytes of `chunks` (fewer when they hold fewer). */
function headOf(chunks, n) {
  const parts = [];
  let length = 0;
  for (const chunk of chunks) {
    if (length >= n) break;
    const part = chunk.subarray(0, n - length);
    parts.push(part);
    length += part.length;
  }
  return Buffer.concat(parts, length);
}

/** A JSON text part as JsonText takes it: ASCII as a string, else UTF-8. */
function jsonPart(value) {
  const text = JSON.stringify(value);
  return ascii(text) ? text : Buffer.from(text, 'utf8');
}

/** A whole reply, written straight into its frame (`JsonText`): its body's
 * base64 in runs, one per chunk read. */
function wholeReply(status, statusText, headers, chunks) {
  return new JsonText([
    `{"status":${status},"status_text":`,
    jsonPart(statusText),
    ',"headers":',
    jsonPart(headers),
    ',"body_base64":"',
    ...base64Runs(chunks),
    '"}',
  ]);
}

/** `getPublishReadiness()`'s answer as the core reads it. */
function readinessOf(readiness) {
  if (readiness?.ok === true) return { ok: true };
  const { reason } = readiness ?? {};
  return typeof reason === 'string' && reason ? { ok: false, reason } : NODE_STOPPED;
}

/** Settles once `signal` aborts: a ready check the core will cancel. Its
 * value is never sent, the cancel's `cancelled` having gone first. */
function untilCancelled(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(NODE_STOPPED);
    else signal.addEventListener('abort', () => resolve(NODE_STOPPED), { once: true });
  });
}

class SwarmShell {
  /**
   * @param {object} [deps] - test seams
   * @param {object} [deps.log]
   * @param {object} [deps.pool] - the Swarm I/O pool (swarm-io-pool.js)
   * @param {() => string} [deps.backendKind] - the switch: `core` or `js`
   * @param {() => string|null} [deps.nodeUrl] - the node's API URL now, or
   *   null while it has none
   * @param {() => Promise<object>} [deps.publishReadiness] -
   *   `getPublishReadiness()`
   * @param {(parent: object) => (string|null|Promise<string|null>)} [deps.subscribeCheck] -
   *   SWM-7's proxy check for `subscribe` (question 4), given `{ backend }`:
   *   a reason to answer `ok: false` with, or null to go on to the probe
   * @param {() => number} [deps.now]
   * @param {Function} [deps.setTimer]
   * @param {Function} [deps.clearTimer]
   * @param {number} [deps.idleMs] - a body's idle bound (ant-api-call.js)
   */
  constructor({
    log = defaultLog,
    pool = swarmIoPool,
    backendKind = () => require('../swarm/swarm-backend-kind').swarmBackendKind(),
    nodeUrl = () => require('../service-registry').getAntApiUrl() || null,
    publishReadiness = () => require('../swarm/publish-setup-service').getPublishReadiness(),
    subscribeCheck = () => null,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
    idleMs,
  } = {}) {
    this.log = log;
    this.pool = pool;
    this.backendKind = backendKind;
    this.nodeUrl = nodeUrl;
    this.publishReadiness = publishReadiness;
    this.subscribeCheck = subscribeCheck;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.idleMs = idleMs;
    // The live parents, by generation and ID.
    this.live = new Map();
    // The highest ID opened in each generation: a `for` at or below it that
    // isn't live has ended.
    this.highest = new Map();
    // Calls dialling or streaming.
    this.calls = 0;
  }

  /**
   * A parent main has sent, from its `onSent`: its calls may be asked for
   * until `close()`, which its end calls (its response, its cancel), and
   * which its signal, its session's stop and its deadline make themselves.
   * Throws unless the switch runs the core's backend.
   *
   * @param {{generation: number, id: number}} sent - as `onSent` reports it
   * @param {object} capture
   * @param {string} capture.row - its grammar row (swarm-grammar.js `rowFor`)
   * @param {*} capture.params - the params main sent: a page's typed form
   *   read back (swarm-typed.js), or main's own JSON
   * @param {string|null} [capture.key] - the page's key (0011)
   * @param {object} capture.backend - the backend captured with it
   *   (`antBackend()`): `url` and `request()`
   * @param {AbortSignal} [capture.signal] - its page's, or main's own
   * @param {AbortSignal} [capture.stop] - aborts when its session closes
   * @param {number|null} [capture.deadlineAt] - when its deadline passes
   *   (`now()`), or null for an idle method's
   * @param {*} [capture.parts] - the payload parts it holds, which
   *   `shell.swarm_part` streams (SWM-5's sixth step)
   * @returns {{ close(): void }}
   */
  open(
    { generation, id } = {},
    {
      row,
      params,
      key = null,
      backend,
      signal = null,
      stop = null,
      deadlineAt = null,
      parts = null,
    } = {}
  ) {
    if (this.backendKind() !== 'core') {
      throw new Error("Swarm runs on its JS backend: the core's executor admits no request");
    }
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(id) || id < 1) {
      throw new TypeError('no request ID');
    }
    if (typeof row !== 'string' || !Object.hasOwn(ROWS, row)) throw new TypeError('no grammar row');
    if (!backend || typeof backend.request !== 'function') throw new TypeError('no backend');
    if (deadlineAt !== null && !Number.isFinite(deadlineAt)) {
      throw new TypeError('a deadline is a time');
    }
    const parent = keyOf(generation, id);
    if (this.live.has(parent)) throw new TypeError('that request is open already');
    const entry = {
      row,
      admission: new Admission({ row, params, key }),
      backend,
      parts,
      life: new AbortController(),
      walk: null,
      walkBusy: false,
      timer: null,
      ended: false,
    };
    this.live.set(parent, entry);
    if (id > (this.highest.get(generation) ?? 0)) this.highest.set(generation, id);
    const sources = [signal, stop].filter(Boolean);
    const close = () => {
      for (const source of sources) source.removeEventListener('abort', close);
      if (this.live.get(parent) !== entry) return;
      this.live.delete(parent);
      entry.ended = true;
      entry.admission.end();
      if (entry.timer !== null) this.clearTimer(entry.timer);
      entry.timer = null;
      entry.walk?.close();
      entry.walk = null;
      entry.life.abort();
    };
    for (const source of sources) {
      if (source.aborted) {
        close();
        break;
      }
      source.addEventListener('abort', close, { once: true });
    }
    if (deadlineAt !== null && !entry.ended) {
      entry.timer = this.setTimer(close, Math.max(0, deadlineAt - this.now()));
    }
    return { close };
  }

  /** What the shell holds, for diagnostics and tests. */
  stats() {
    let walks = 0;
    for (const entry of this.live.values()) if (entry.walk) walks += 1;
    return { parents: this.live.size, calls: this.calls, walks };
  }

  /** The live parent `id` of `generation`, or whether it has ended. */
  parentOf(generation, id) {
    const entry = id === null ? undefined : this.live.get(keyOf(generation, id));
    if (entry) return { entry, ended: false };
    return { entry: null, ended: id !== null && id <= (this.highest.get(generation) ?? 0) };
  }

  /**
   * A refusal: `invalid_argument` with its rule, logged with the parent's
   * row and step; the parent refuses every later call. A later call of a
   * parent already refused is logged at debug only.
   */
  refuse(method, entry, rule) {
    const admission = entry?.admission;
    if (admission && rule === 'ended' && admission.refused) {
      this.log.debug?.(`[Core] ${method} for a refused parent`);
    } else {
      if (admission && !admission.refused) admission.refused = rule;
      const fields = admission ? { parent: entry.row, step: admission.position, rule } : { rule };
      this.log.warn(`[Core] ${method} refused`, fields);
    }
    throw new ShellError('invalid_argument', { rule });
  }

  /** Whether there is a node to dial: the parent's backend has one, and
   * the node's URL hasn't gone since. */
  nodeUp(entry) {
    if (!entry.backend.url) return false;
    try {
      return Boolean(this.nodeUrl());
    } catch {
      return false;
    }
  }

  // ---- shell.swarm_ready ----

  /** The handler: one `shell.swarm_ready`. */
  async ready(params, { signal, generation }) {
    const ask = readReady(params);
    const found = this.parentOf(generation, ask ? ask.for : null);
    if (!ask) return this.refuse('shell.swarm_ready', found.entry, 'form');
    if (!found.entry) {
      // Never sent: a core fault, which ends the connection.
      if (!found.ended) return this.refuse('shell.swarm_ready', null, 'ended');
      // A parent main ended: the core cancels this as it reads that end,
      // and the cancel is answered `cancelled`.
      this.log.debug?.('[Core] shell.swarm_ready for a parent that has ended');
      return untilCancelled(signal);
    }
    const { entry } = found;
    const rule = entry.admission.ready(ask.check);
    if (rule) return this.refuse('shell.swarm_ready', entry, rule);
    let answer;
    try {
      answer = await this.readiness(entry, ask.check, signal);
    } catch {
      answer = NODE_STOPPED;
    }
    if (entry.ended || signal.aborted) {
      entry.admission.readyAnswered(false);
      return untilCancelled(signal);
    }
    entry.admission.readyAnswered(answer.ok);
    return answer;
  }

  async readiness(entry, check, signal) {
    if (check === 'publish') return readinessOf(await this.publishReadiness());
    if (check === 'subscribe') {
      const reason = await this.subscribeCheck({ backend: entry.backend });
      if (typeof reason === 'string' && reason) return { ok: false, reason };
    }
    return this.probe(entry, signal);
  }

  /**
   * `GET /node` on the parent's transport, 5 s in all, its body at most
   * 64 KiB of JSON: `{ ok: true }`, or `node-stopped`. Uncharged: design
   * 0015 exempts `shell.swarm_ready` answers, which go on while the pool is
   * full; the probe's body is held only until it is parsed, decoded chunk
   * by chunk, never copied whole.
   */
  async probe(entry, signal) {
    if (!this.nodeUp(entry)) return NODE_STOPPED;
    const timeout = new AbortController();
    const timer = this.setTimer(() => timeout.abort(), READY_TIMEOUT_MS);
    const life = AbortSignal.any([signal, entry.life.signal, timeout.signal]);
    try {
      const response = await callAnt(entry.backend, {
        path: '/node',
        method: 'GET',
        headers: new Headers(Object.entries(MAIN_HEADERS)),
        signal: life,
        ...(this.idleMs !== undefined && { idleMs: this.idleMs }),
      });
      const body = response.body ?? emptyBody();
      if (response.status < 200 || response.status > 299) {
        cancelBody(body);
        return NODE_STOPPED;
      }
      const read = await readWhole(body, READY_BODY, life);
      if (!read.chunks) return NODE_STOPPED;
      // As `res.json()` reads it: UTF-8, a leading BOM dropped, decoded
      // chunk by chunk.
      const decoder = new TextDecoder();
      let text = '';
      for (const chunk of read.chunks) text += decoder.decode(chunk, { stream: true });
      JSON.parse(text + decoder.decode());
      return { ok: true };
    } catch {
      return NODE_STOPPED;
    } finally {
      this.clearTimer(timer);
    }
  }

  // ---- shell.swarm_api ----

  /** The handler: one `shell.swarm_api`. */
  async api(params, { signal, charge, shrink, generation }) {
    const read = readCall(params);
    const found = this.parentOf(generation, read.for);
    if (read.rule) return this.refuse('shell.swarm_api', found.entry, read.rule);
    if (!found.entry) {
      if (!found.ended) return this.refuse('shell.swarm_api', null, 'ended');
      // Its parent ended as the core asked: a race, not a fault.
      this.log.debug?.('[Core] shell.swarm_api for a parent that has ended');
      throw new ShellError('invalid_argument', { rule: 'ended' });
    }
    const { entry } = found;
    const { call } = read;
    // A walk whose map had no room: its calls are busy, never admitted.
    if (entry.walkBusy) return { failed: 'busy' };
    // A base64 POST's body is charged before the grammar decodes it, once,
    // for its check and the dial alike; without room, busy, undialled.
    const sent = inlineBytes(call);
    if (sent !== null && !charge(postCharge(sent))) return { failed: 'busy' };
    const verdict = entry.admission.admit(call);
    if (verdict.rule) {
      shrink(0);
      return this.refuse('shell.swarm_api', entry, verdict.rule);
    }
    let settled = false;
    const settle = (reply) => {
      if (settled) return;
      settled = true;
      entry.admission.settle(verdict.ticket, reply);
    };
    // Before any dial: the call is over, and nothing of it is held.
    const over = () => {
      shrink(0);
      settle(null);
    };
    // The session's stack, a remote node's, sends U+0080 to U+00FF as their
    // UTF-8 (#1338): such a value is refused before the dial.
    if (!isLoopbackGatewayUrl(entry.backend.url) && !call.headers.every(([, v]) => ascii(v))) {
      over();
      return this.refuse('shell.swarm_api', entry, 'header');
    }
    if (!this.nodeUp(entry)) {
      over();
      return { failed: 'stopped' };
    }
    if (call.body && Object.hasOwn(call.body, 'stream')) {
      // A streamed upload: SWM-5's sixth step. Admitted, never dialled.
      over();
      this.log.warn('[Core] shell.swarm_api: a streamed upload, not sent by this build', {
        parent: entry.row,
        step: verdict.ticket.step,
      });
      return { failed: 'error' };
    }
    const reserve = call.stream ? STREAM_CHARGE : wholeCharge(Math.max(call.max_bytes, ERROR_BODY));
    if (!charge(reserve)) {
      over();
      return { failed: 'busy' };
    }
    try {
      return await this.dial(entry, call, verdict.ticket, settle, {
        signal,
        charge,
        shrink,
        reserve,
      });
    } catch (err) {
      // Main's own fault: the call is over, and answered `{ failed: "error" }`.
      shrink(0);
      settle(null);
      throw err;
    }
  }

  /** One dial of an admitted call, and its reply. */
  async dial(entry, call, ticket, settle, { signal, charge, shrink, reserve }) {
    const life = AbortSignal.any([signal, entry.life.signal]);
    const failed = (code) => {
      shrink(0);
      settle(null);
      return { failed: code };
    };
    if (life.aborted) return failed('aborted');
    this.calls += 1;
    let open = true;
    const done = () => {
      if (!open) return;
      open = false;
      this.calls -= 1;
    };
    let handed = false;
    try {
      let headers;
      try {
        headers = new Headers(requestHeaders(call));
      } catch {
        // A value past U+00FF, which no stack sends: as the reference fails.
        return failed('error');
      }
      let response;
      try {
        response = await callAnt(entry.backend, {
          path: target(call),
          method: call.method,
          headers,
          // The inline body as the grammar decoded it: never decoded again.
          body: ticket.bytes ?? null,
          signal: life,
          ...(this.idleMs !== undefined && { idleMs: this.idleMs }),
        });
      } catch (err) {
        return failed(failureOf(err, life));
      }
      // The dial is over: its request body, and the charge for it, go.
      ticket.bytes = null;
      shrink(reserve);
      const body = response.body ?? emptyBody();
      if (life.aborted) {
        cancelBody(body);
        return failed('aborted');
      }
      const { status } = response;
      const statusText = typeof response.statusText === 'string' ? response.statusText : '';
      const replyHeaders = forwarded(response.headers);
      if (
        !Number.isInteger(status) ||
        status < 100 ||
        status > 599 ||
        !replyHeaders ||
        Buffer.byteLength(statusText, 'utf8') > REPLY_HEADERS.reason_bytes
      ) {
        cancelBody(body);
        this.log.warn('[Core] shell.swarm_api: the node answered past the reply bounds', {
          parent: entry.row,
          step: ticket.step,
        });
        return failed('error');
      }
      const ok = status >= 200 && status <= 299;
      const max = call.max_bytes;
      const declared = ok ? declaredLength(replyHeaders) : null;
      if (ok && call.stream) {
        const head = { status, status_text: statusText, headers: replyHeaders };
        // The call is over at its stream's terminal.
        const end = () => {
          done();
          settle({ status, headers: replyHeaders });
        };
        handed = true;
        if (declared !== null && declared > max) {
          cancelBody(body);
          end();
          return new StreamedReply(head, tooLargeBody(max), { bodyFlag: false });
        }
        return new StreamedReply(head, pieceBody(boundedBody(body, max), life, end), {
          bodyFlag: false,
        });
      }
      if (declared !== null && declared > max) {
        cancelBody(body);
        return failed('too_large');
      }
      const whole = await readWhole(body, ok ? max : ERROR_BODY, life, { cut: !ok });
      if (whole.failed) return failed(whole.failed);
      const { chunks, length } = whole;
      // The charge, over the body as read: its chunks, its base64 and the
      // serialized reply (0015's sum), and the grammar's one copy of it
      // when the grammar reads this answer.
      const reads = entry.admission.readsReply(ticket);
      const held = wholeCharge(length) + (reads ? length : 0);
      if (held <= reserve) shrink(held);
      else if (!charge(held - reserve)) return failed('busy');
      // readData's walk: its map is reserved before its root's answer may
      // fill it, and without room is never filled.
      const walk =
        ok && entry.row === 'readData' && ticket.step === 0 ? this.startWalk(entry, chunks) : null;
      settle({ status, headers: replyHeaders, ...(walk !== false && { body: chunks }) });
      return wholeReply(status, statusText, replyHeaders, chunks);
    } finally {
      if (!handed) done();
    }
  }

  /**
   * `readData`'s walk starts once the root main returned has a size it
   * walks: its occurrence map is reserved before the root's answer fills
   * it. False, with nothing reserved, when the pool has no room: the root's
   * answer is then settled unread, so nothing fills the map, and the
   * parent's later calls are `busy`. Null for a root that starts no walk.
   */
  startWalk(entry, chunks) {
    if (entry.ended || entry.walk || entry.walkBusy) return null;
    const span = headOf(chunks, 8);
    if (span.length < 8) return null;
    const { size } = decodeSpan(span);
    if (size <= BigInt(CHUNK_SIZE) || size > BigInt(B)) return null;
    entry.walk = this.pool.reserve(WALK_CHARGE);
    if (entry.walk) return true;
    entry.walkBusy = true;
    return false;
  }
}

/**
 * Registers the Swarm asks on `client`, whichever backend runs (the
 * switch): `shell.swarm_ready`, and `shell.swarm_api` twice, its whole
 * calls (`stream: false`) on the client's own replies, which a large one
 * (a `/stamps` reply's base64 passes one frame) may fragment, and its
 * streaming calls on the duplex, whose bodies may end `too_large`. Each
 * charges the Swarm I/O pool, answers its failures with its failure form,
 * and races the core's cancel.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {object} [deps] - SwarmShell's test seams
 * @returns {SwarmShell}
 */
function registerSwarmShell(client, deps = {}) {
  const shell = new SwarmShell(deps);
  const { pool } = shell;
  const callFailed = () => ({ failed: 'error' });
  client.handle('shell.swarm_ready', (params, context) => shell.ready(params, context), {
    pool,
    failure: () => NODE_STOPPED,
    race: true,
  });
  client.handle('shell.swarm_api', (params, context) => shell.api(params, context), {
    when: (params) => params.stream === false,
    pool,
    failure: callFailed,
    race: true,
  });
  client.handle('shell.swarm_api', (params, context) => shell.api(params, context), {
    streams: true,
    sends: SWARM_PIECE_ABORT_CODES,
    pool,
    failure: callFailed,
    race: true,
  });
  return shell;
}

module.exports = {
  registerSwarmShell,
  SwarmShell,
  ERROR_BODY,
  READY_BODY,
  READY_TIMEOUT_MS,
  STREAM_CHARGE,
  WALK_CHARGE,
  postCharge,
  wholeCharge,
};
