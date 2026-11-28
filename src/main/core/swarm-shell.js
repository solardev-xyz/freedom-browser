/**
 * Main's executor for the core's Swarm asks (freedom-core design 0015,
 * Node access, Main's Swarm I/O pool, The transport, Deadlines and cancel,
 * Uploads, Messaging, and SWM-5's calls): `shell.swarm_ready`,
 * `shell.swarm_api`, `shell.swarm_part`, `shell.swarm_subscribe` and
 * `shell.swarm_unsubscribe`, for the Swarm requests main sends the core
 * (the **parents**: `swarm.request`, `swarm.publish`, `swarm.feed`,
 * `swarm.stamps`, `swarm.upload_status`). `registerSwarmShell` also
 * registers `shell.swarm_manifest`, a manifest check's fetch (D6; the
 * SWM-6 to SWM-9 plan's point 6), whose `for` is main's `swarm.manifest`
 * check: swarm/permission-manifests.js answers it (`answerManifestAsk`),
 * on the Swarm I/O pool, its failures `{ failed: true }`.
 * Each call is admitted by the operation grammar (swarm-grammar.js) before
 * anything is dialled, and dialled once on the node's transport the parent
 * captured (`antBackend()`, swarm/ant-api-call.js).
 *
 * - **The switch** (swarm/swarm-backend-kind.js): `registerSwarmShell`
 *   registers the handlers whichever backend runs, so a stray ask is
 *   answered `ended` (an `unknown_method` would end the core's
 *   connection), and `open()` throws unless FREEDOM_SWARM_BACKEND selects
 *   `core`: on `js` no parent is ever admitted. The switch is read once,
 *   at the process's first ask, and kept (one backend per process).
 * - **The parent registry:** `open({ generation, id }, capture)`, called
 *   from the parent's `onSent` (service-client.js), before the core can
 *   ask anything for it. A parent keeps its row's `Admission` (built from
 *   the params main sent and the page's key), the backend it captured, its
 *   signal and its session's stop, its deadline and its parts (each part
 *   its params name, with the held buffer or picked file main reads it
 *   from). Its end
 *   (`close()`, the signal, the stop, the deadline) stops every call of it,
 *   dialling or streaming, and nothing more is admitted for it. A `for` at
 *   or below the highest ID opened in its generation has ended (a race);
 *   one above it was never sent (a core fault). Its handle's `asked()`
 *   says whether any ask has named it while it was live.
 * - **Read strictly:** `shell.swarm_ready` is exactly `{ for, check }`;
 *   `shell.swarm_api` exactly the core's members (`for`, `form`, `method`,
 *   `path`, `query`, `headers`, `max_bytes`, `stream`, and `body`, `feed`
 *   and `tree` where they apply), `feed` exactly `{ owner, index }` and
 *   `tree` exactly `{ length, depth }`; `shell.swarm_part` exactly `{ for,
 *   part }`, `part` a `u32`; everything else is the grammar's (types,
 *   forms, values, bounds). A call that fails is refused with the rule it
 *   breaks.
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
 *   it stands, its `{ ok, reason }`; `subscribe` is the probe after
 *   question 4's route test (`proxy-or-tor` for a node not on loopback
 *   that the session reaches through a proxy or Tor, undialled:
 *   swarm/subscription-registry.js `checkRoute`). A ready check whose
 *   parent main has ended is answered `cancelled` once the core cancels it,
 *   never refused (the amendment's disagreement 9): the core ends the
 *   connection on any other error to it.
 * - **`shell.swarm_subscribe { for, kind, key }`** (SWM-4's D16, SWM-7):
 *   once, for a `subscribe` parent whose ready check passed, its `kind` the
 *   params' and its `key` the params' address or a PSS topic's hash (a
 *   GSOC topic's key is the core's mined address). Main opens the
 *   subscription through the subscription registry, bound to the parent's
 *   document (`subscriber`, its key the site's), on the parent's node, the
 *   route tested again just before the socket opens: `{ id }` once it is
 *   open, or `{ failed: { reason?, message } }` with the registry's reason
 *   and text (`proxy-or-tor` among them, with no socket made; and
 *   `subscription_cancelled` when the parent's node is no longer the
 *   configured one). The core's
 *   cancel, or the parent's end, while it opens ends it; an `{ id }` that
 *   would answer after either is closed, never sent. The subscription then
 *   is main's: its messages, its limits, its later end.
 * - **`shell.swarm_unsubscribe { id }`** closes a subscription
 *   `shell.swarm_subscribe` opened on that connection (the core's close
 *   after a refused recheck, which answers `NO_ADDRESS`, or of one whose
 *   request ended), and answers `{}` at once, closed or already gone: the
 *   core ends the connection after 60 s.
 * - **`shell.swarm_api`:** admitted, then, before any dial, a remote node's
 *   header values held to one byte a character (the session's stack would
 *   send U+0080 to U+00FF as their UTF-8; rule `header`); `stopped` when
 *   there is no node to dial (the parent's backend has none, or the node's
 *   URL went since); `busy` when the pool has no room. Then one dial of the
 *   form's method, path and query (`URLSearchParams`' encoding), with main's
 *   two headers and the call's, and a base64 body as bytes: no retry, no
 *   header deadline, 60 s idle on a body (point 6).
 * - **A streamed upload** (a call whose body is `{ stream: n }`: `bzz_file`,
 *   `bzz_tar`, `bytes_up`): main sends the core one `swarm.body { for }`
 *   for that call alone, with its idle watchdog (point 3; the watchdog's
 *   first caller), and pipes the core's answer into the node's request as
 *   the node takes it. Its head must be exactly `{ bytes: n }`; one that
 *   isn't is a core fault: main withdraws the body (its cancel) and answers
 *   `{ failed: "error" }`, undialled (point 12). So is a body that runs
 *   past `n` or ends short of it, which fails the node's request before it
 *   can take a body of another length. A node that answers before it has
 *   taken the whole body has it withdrawn before main answers, so no
 *   credit for it follows the answer (D4); the core's cancel of the call,
 *   or the parent's end, withdraws it at once, in the same turn.
 * - **`shell.swarm_part { for, part }`** streams one of the parent's parts
 *   while one of its streaming calls is open, one part at a time (the
 *   upload's part room, below): its head `{ bytes }`, the length its
 *   params give, then its bytes under the core's credit. A held
 *   buffer goes as views of itself, which the sender copies into its window
 *   as the credit takes them, keeping none; a picked file is read as the
 *   credit allows, straight into the one read buffer the service client
 *   keeps for the piece. Neither is copied here. The part rules
 *   (point 5): another parent's part, or one the params don't have, is
 *   `value`; a part asked twice `count`; one with no streaming call open
 *   `order`; one after the parent ended `ended`. After its head a part
 *   fails only as its stream's `body_stream_error`: a file that can't be
 *   read names its errno (`error_code`); one whose size changes while it
 *   is read names none (point 13), since a head of another length would
 *   end the core's connection (`swarm_part_length`); the parent's end, or
 *   its call's, names none either. Its frames, and the core's credit on
 *   it, are its upload's `swarm.body` progress (D13's one timer), reported
 *   to the watchdog (`watchdogProgress`).
 * - **`swarm.publish`'s watchdog** (design 0015, Deadlines and cancel, D13;
 *   SWM-8, the SWM-6 to SWM-9 plan's PR 8.3): main's idle method among the
 *   parents, sent with its idle watchdog (core-deadlines.js
 *   `idleWatchdogMs`), which nothing holds and its progress moves on
 *   (`watchdogProgress`), mirroring the core's own bounds on its asks
 *   (`ask_bound`: 60 s without progress, 300 s for a whole reply) plus the
 *   margin: 75 s from each ask naming it (a ready check, a call, a part),
 *   each of main's answers to one, each frame and credit of its part
 *   streams and each piece of its upload's body main takes from the core;
 *   315 s from each whole call's ask (the core waits that long for the
 *   node's reply); and 315 s from its upload's body terminal (the core then
 *   waits that long for the node's answer). Main's own cancel of it is the
 *   client's (service-client.js). The other parents carry deadlines, and
 *   their progress moves nothing.
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
 *     (copied as it comes into owned blocks, `m` their storage, never a
 *     view of the transport's chunks), and that body's length more when the
 *     grammar reads the answer (its one copy);
 *   - a streaming call 256 KiB, to its terminal;
 *   - a base64 POST's body, before the grammar decodes it (once, for its
 *     check and the dial): the core's base64 of it, its bytes and the
 *     transport's copy, to the dial's end;
 *   - a streamed upload's `swarm.body` 256 KiB beside its reply's room,
 *     before it is sent, to the node's answer (its 128 KiB ring, the chunk
 *     pulled from it, which goes straight to the transport, and the one the
 *     transport holds); and, when the parent has parts, one part's 256 KiB
 *     (the sender's window of it, the bytes read ahead, the piece's one
 *     read buffer, its file handle), which the upload's parts hold one at a
 *     time (`partRoom`): a part asked while another holds it waits, in the
 *     order asked, with nothing opened or read, and takes it once the other
 *     has left (its last frame written, or its reply dropped). The core
 *     asks a part only once the last one ended, so an honest core never
 *     waits. Once the call's answer is in the pipe, or its reply dropped
 *     (the node's answer, a node error, a body fault, the core's cancel,
 *     the parent's end), a part still waiting fails without opening
 *     anything, and the one holding the room is ended `body_stream_error`,
 *     what the sender holds of it purged, so none of its data and no
 *     normal end follows the answer; neither waits for the core's cancel.
 *     The room goes back once the call and that part have both left.
 *     Without room the call is `busy`, before any `swarm.body`, so a part
 *     never meets a full pool;
 *   - `readData`'s walk, its occurrence map (2,562 slots at 256 bytes),
 *     before the root's answer may fill it; without room the map stays
 *     empty, and the parent's later calls are `busy`;
 *   - a `{ failed }` answer nothing.
 *   Each is released once its reply's last byte is written, or its reply
 *   dropped (service-client.js). The ready probe's body (at most 64 KiB,
 *   until parsed) alone is uncharged: 0015 lets `shell.swarm_ready`
 *   answers go on while the pool is full. A held part is 0011's charge
 *   (the page's IPC value), never copied here.
 * - **Logs:** a refusal at `warn`, with the parent's row, its step and the
 *   rule; a core fault on an upload at `warn`, with the parent's row, its
 *   step and the fault's name; never a path, a value or a body.
 */

const fs = require('fs');
const nodePath = require('path');
const defaultLog = require('../logger');
const { JsonText, ShellError, StreamedReply } = require('./core-client');
const { idleWatchdogMs } = require('./core-deadlines');
const {
  CORE_UPLOAD_ABORT_CODES,
  SWARM_PART_ABORT_CODES,
  SWARM_PIECE_ABORT_CODES,
} = require('./frame');
const {
  Admission,
  B,
  ERROR_REPLY,
  INLINE_BASE64,
  MAIN_HEADERS,
  MAX_PART,
  REPLY_HEADERS,
  ROWS,
  paramParts,
  requestHeaders,
  topicOf,
} = require('./swarm-grammar');
const { isNullish, param } = require('./swarm-typed');
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

/** A part's reads: at most what the service client takes as one chunk. */
const PART_READ = 64 * KIB;
/** `swarm.body`'s idle watchdog after its progress: 75 s (point 3). */
const BODY_PROGRESS_MS = idleWatchdogMs('swarm.body');
/** `swarm.publish`'s idle watchdog (D13): 75 s after its progress, 315 s
 * from a whole call's ask, and 315 s from its upload's body terminal. */
const PUBLISH_PROGRESS_MS = idleWatchdogMs('swarm.publish');
const PUBLISH_WHOLE_CALL_MS = idleWatchdogMs('swarm.publish', 'whole_call');
const PUBLISH_BODY_END_MS = idleWatchdogMs('swarm.publish', 'body_end');

const API_REQUIRED = ['for', 'form', 'method', 'path', 'query', 'headers', 'max_bytes', 'stream'];
const API_OPTIONAL = ['body', 'feed', 'tree'];
const READY_MEMBERS = ['for', 'check'];
const PART_MEMBERS = ['for', 'part'];
const SUBSCRIBE_MEMBERS = ['for', 'kind', 'key'];
const UNSUBSCRIBE_MEMBERS = ['id'];
const KINDS = new Set(['gsoc', 'pss']);
const HEX64 = /^[0-9a-f]{64}$/;
/** A `{ failed }` answer's text: at most this many characters. */
const FAILED_TEXT = 1024;
// fc-protocol's `is_error_code`: the errno name a part's abort may carry.
const ERRNO = /^[A-Z][A-Z0-9_]{0,31}$/;
const CHECKS = new Set(['publish', 'reachable', 'subscribe']);
const FORWARDED = new Set(REPLY_HEADERS.read);

const NODE_STOPPED = Object.freeze({ ok: false, reason: 'node-stopped' });

/** `b64(m)`, design 0015's 4⌈m / 3⌉. */
const b64 = (bytes) => 4 * Math.ceil(bytes / 3);
/** A whole call's charge for `m` bytes of body: the bytes, its base64 and
 * the serialized reply, every copy at once, and the reply's rest. */
const wholeCharge = (m) => m + 2 * b64(m) + REPLY_ROOM;
/** A base64 POST's charge for its `n`-byte body, to the dial's end: the
 * core's base64 of it, which the call holds throughout, the body decoded
 * once (the grammar checks the base64 is canonical by its text, writing
 * no second string), and the copy the transport makes to send it
 * (undici's `extractBody`). */
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

/** `shell.swarm_part`'s params, read strictly: `{ for, part }`, or `{ for,
 * rule }` (`for` null when it isn't an ID). */
function readPart(params) {
  const id = isObject(params) && Number.isSafeInteger(params.for) && params.for >= 1;
  if (!exactly(params, PART_MEMBERS) || !id) return { for: id ? params.for : null, rule: 'form' };
  const { part } = params;
  if (!Number.isSafeInteger(part) || part < 0 || part > MAX_PART) {
    return { for: params.for, rule: 'form' };
  }
  return { for: params.for, part };
}

/** `shell.swarm_subscribe`'s params, read strictly: `{ for, kind, key }`, or null. */
function readSubscribe(params) {
  if (!exactly(params, SUBSCRIBE_MEMBERS)) return null;
  if (!Number.isSafeInteger(params.for) || params.for < 1) return null;
  if (!KINDS.has(params.kind) || typeof params.key !== 'string' || !HEX64.test(params.key)) return null;
  return { for: params.for, kind: params.kind, key: params.key };
}

/**
 * Whether a `subscribe` parent may open `ask`'s subscription now: null, or
 * the rule it breaks. Once (`count`), after a ready check that passed
 * (`order`), of the params' kind, on the params' address or a PSS topic's
 * hash (`value`); only a `subscribe` parent's (`form`), and one that hasn't
 * ended or been refused (`ended`).
 */
function subscribeRule(entry, ask) {
  const { admission } = entry;
  if (admission.ended || admission.refused) return 'ended';
  if (entry.row !== 'subscribe') return 'form';
  if (entry.subscribed) return 'count';
  if (admission.readyState !== 'ok') return 'order';
  const { params } = admission;
  if (param(params, 'kind') !== ask.kind) return 'value';
  const address = param(params, 'address');
  if (ask.kind === 'pss' && topicOf(param(params, 'topic')) !== ask.key) return 'value';
  if (ask.kind === 'gsoc' && !isNullish(address)) {
    if (typeof address !== 'string' || address.toLowerCase() !== ask.key) return 'value';
  }
  return null;
}

/** A failed open's answer: the registry's reason, when it has one, and its text (bounded, well formed). */
function failedOpen(err) {
  const failed = {};
  if (typeof err?.reason === 'string' && err.reason) failed.reason = err.reason;
  const text = typeof err?.message === 'string' && err.message ? err.message : 'Subscription failed';
  failed.message = Array.from(text.toWellFormed()).slice(0, FAILED_TEXT).join('');
  return { failed };
}

/**
 * A parent's parts: each one its params name (`paramParts`), with the
 * source main reads it from, `asked` once a `shell.swarm_part` has taken
 * it. A source is a held buffer, a `Uint8Array` of the part's length (the
 * page's IPC value, or main's own bytes), or a picked file, `{ path, bytes
 * }`: an absolute path main opened for freedom://publish, and the length
 * it gave the params. Throws a TypeError for a part with no source, one of
 * another length, or a source no part names: each main's own bug.
 */
function partsOf(row, params, sources) {
  const declared = paramParts(row, params);
  const given = sources ?? new Map();
  if (!(given instanceof Map)) throw new TypeError("a parent's parts are a Map");
  const parts = new Map();
  for (const [number, length] of declared) {
    const source = given.get(number);
    if (source instanceof Uint8Array) {
      if (source.byteLength !== length) throw new TypeError(`part ${number} isn't its length`);
      parts.set(number, { length, held: source, path: null, asked: false });
    } else if (
      exactly(source, ['path', 'bytes']) &&
      typeof source.path === 'string' &&
      nodePath.isAbsolute(source.path) &&
      source.bytes === length
    ) {
      parts.set(number, { length, held: null, path: source.path, asked: false });
    } else {
      throw new TypeError(`part ${number} has no source of its length`);
    }
  }
  for (const number of given.keys()) {
    if (!declared.has(number)) throw new TypeError(`no part ${number} in its params`);
  }
  return parts;
}

/**
 * A part that fails once its head has gone: its stream ends
 * `body_stream_error`, naming `errorCode` (an errno name, as fc-protocol's
 * `is_error_code` takes it) when the failure has one (the service client
 * reads `errorCode`).
 */
class PartError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'PartError';
    if (typeof code === 'string' && ERRNO.test(code)) this.errorCode = code;
  }
}

/** A read that failed: `body_stream_error` with its errno's name. */
function unreadable(err) {
  return err instanceof PartError ? err : new PartError('the part could not be read', err?.code);
}

/**
 * Runs `fail` with a PartError naming no code once `life` aborts (the
 * parent's end), so the part's stream ends `body_stream_error`. Returns
 * its `off()`.
 */
function failOnEnd(life, fail) {
  const onAbort = () => fail(new PartError("the part's request ended"));
  if (life.aborted) queueMicrotask(onAbort);
  else life.addEventListener('abort', onAbort, { once: true });
  return () => life.removeEventListener('abort', onAbort);
}

/**
 * A held buffer's part: views of it, at most PART_READ each, as the service
 * client pulls them. Nothing is copied here, and no view is kept: the
 * sender copies what the core's credit takes into its own blocks, and the
 * one view it may hold meanwhile is of a buffer main holds anyway (0011's
 * charge). Fails once `life` aborts.
 */
function heldPart(bytes, life) {
  let at = 0;
  let off = () => {};
  return new ReadableStream(
    {
      start(controller) {
        off = failOnEnd(life, (err) => {
          try {
            controller.error(err);
          } catch {
            // Already over.
          }
        });
      },
      pull(controller) {
        if (at >= bytes.byteLength) {
          off();
          controller.close();
          return;
        }
        const n = Math.min(PART_READ, bytes.byteLength - at);
        controller.enqueue(bytes.subarray(at, at + n));
        at += n;
      },
      cancel() {
        off();
      },
    },
    { highWaterMark: 0 }
  );
}

/**
 * A picked file's part, `length` bytes: a byte stream, each read straight
 * into the view the service client asks with (its one read buffer for the
 * piece, as far as the core's credit and its writer allow), at the file's
 * offset, so main holds no copy of its own. It is opened when the stream is made and closed at its end, its
 * failure or its cancel. A read that fails names its errno; a file that
 * ends short of `length`, or has a byte past it, changed size while it was
 * read (point 13) and names none. Fails, naming none, once `life` aborts.
 */
function pickedPart(path, length, life, openFile = (file) => fs.promises.open(file, 'r')) {
  let at = 0;
  let over = false;
  let off = () => {};
  const opened = Promise.resolve().then(() => openFile(path));
  // Its failure is the first read's to report; nothing waits for it before.
  opened.catch(() => {});
  const close = () => {
    if (over) return;
    over = true;
    off();
    opened.then(
      (handle) => handle.close().catch(() => {}),
      () => {}
    );
  };
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      off = failOnEnd(life, (err) => {
        close();
        try {
          controller.error(err);
        } catch {
          // Already over.
        }
      });
    },
    async pull(controller) {
      const request = controller.byobRequest;
      const view = request?.view ?? new Uint8Array(Math.min(PART_READ, Math.max(1, length - at)));
      let bytesRead;
      try {
        const handle = await opened;
        if (over) return;
        // Its whole length read: one more byte means it grew.
        const want = at < length ? Math.min(view.byteLength, length - at) : 1;
        ({ bytesRead } = await handle.read(view, 0, want, at));
      } catch (err) {
        close();
        throw unreadable(err);
      }
      if (over) return;
      if (at === length) {
        if (bytesRead > 0) {
          close();
          throw new PartError('the file grew while it was read');
        }
        close();
        controller.close();
        request?.respond(0);
        return;
      }
      if (bytesRead === 0) {
        close();
        throw new PartError('the file shrank while it was read');
      }
      at += bytesRead;
      if (request) request.respond(bytesRead);
      else controller.enqueue(view.subarray(0, bytesRead));
    },
    cancel() {
      close();
    },
  });
}

/** Whether `result` is exactly `swarm.body`'s head for a body of `length`. */
const isBodyHead = (result, length) => exactly(result, ['bytes']) && result.bytes === length;

/** A promise that never settles: a pull that waits for good. */
const never = () => new Promise(() => {});

/**
 * The core's `swarm.body` as the node's request body: pulled only as the
 * node's transport pulls it, one of the core's chunks at a time, and held
 * to the head's `length`. A byte past it, or an end short of it, is a core
 * fault (`onFault`), and fails the request, so the node never takes a body
 * of another length. `hold()` stops it for good once the node has
 * answered: its pulls wait from then on and read nothing more of the
 * core's, until the transport lets go of it (its cancel). `ended` once its
 * last byte went. `onRead(end)` sees each piece main takes from the core
 * (`end` false) and its terminal (`end` true).
 */
function uploadBody(source, length, onFault, onRead = () => {}) {
  const reader = source.getReader();
  const state = { ended: false, held: false, stream: null };
  let seen = 0;
  state.hold = () => {
    state.held = true;
  };
  state.stream = new ReadableStream(
    {
      async pull(controller) {
        if (state.held) return never();
        let next;
        try {
          next = await reader.read();
        } catch (err) {
          if (state.held) return never();
          throw err;
        }
        if (state.held) return never();
        onRead(next.done);
        if (next.done) {
          if (seen !== length) {
            onFault('short');
            throw new Error("the core's body ended short of its head's length");
          }
          state.ended = true;
          controller.close();
          return undefined;
        }
        seen += next.value.byteLength;
        if (seen > length) {
          onFault('long');
          throw new Error("the core's body ran past its head's length");
        }
        controller.enqueue(next.value);
        return undefined;
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 }
  );
  return state;
}

/**
 * An upload's part room: one stream's reservation in the pool, held by its
 * call and lent to its parts one at a time, in the order the core asked
 * them. The core asks a part only once the last one has ended and its
 * bytes have gone out on the body (fc-swarm-provider's `methods/body.rs`,
 * "one part at a time, each in its turn"), so an honest core never waits;
 * a part asked while another holds the room waits its turn with nothing
 * open, and the room never holds more than one part's stream.
 *
 * - `turn()`: a part's place: `ready` resolves true once it holds the
 *   room, false if it never will (the call ended first, or `leave()`);
 *   `onEnd(fn)` names how to end its stream; `leave()`, from its lease's
 *   `onRelease` (its last frame written, or its reply dropped) or when it
 *   stops waiting, gives the room to the next.
 * - `hold()`: the call is over (the node answered, failed, or the core's
 *   body broke): no part takes the room from now on.
 * - `end()`: the call's answer is handed to the pipe (`onAnswer`), or its
 *   reply dropped: a part still waiting never takes the room, and the one
 *   holding it is ended (`onEnd`: its source, and what the service
 *   client's sender still holds of its stream, `abortStream`), so none of
 *   its data and no normal end follows the answer, only its abort. The
 *   room goes back once the call and the part holding it have both left
 *   (the holder's abort written).
 */
function partRoom(reservation) {
  let call = true;
  let giving = true;
  let owner = null;
  const waiting = [];
  const free = () => {
    if (!call && !owner) reservation.close();
  };
  return {
    turn() {
      const turn = { give: null, stop: null, left: false };
      const ready = new Promise((resolve) => {
        turn.give = resolve;
      });
      if (!giving) turn.give(false);
      else if (owner) waiting.push(turn);
      else {
        owner = turn;
        turn.give(true);
      }
      return {
        ready,
        onEnd(fn) {
          turn.stop = fn;
        },
        leave() {
          if (turn.left) return;
          turn.left = true;
          const at = waiting.indexOf(turn);
          if (at >= 0) waiting.splice(at, 1);
          turn.give(false);
          if (owner !== turn) return;
          owner = null;
          if (giving && waiting.length) {
            owner = waiting.shift();
            owner.give(true);
          }
          free();
        },
      };
    },
    hold() {
      giving = false;
    },
    end() {
      giving = false;
      call = false;
      for (const turn of waiting.splice(0)) turn.give(false);
      owner?.stop?.();
      free();
    },
  };
}

/** A part that never took its upload's room (its call or its parent ended
 * while it waited): its stream fails at once, naming no code, with nothing
 * opened or read. */
function endedPart() {
  return new ReadableStream({
    start(controller) {
      controller.error(new PartError("the part's request ended"));
    },
  });
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

/** A body's blocks: the first at most 4 KiB, then doubling to 64 KiB. */
const BLOCK_FIRST = 4 * KIB;
const BLOCK_MOST = 64 * KIB;

/**
 * A whole body as main holds it: its bytes copied as they come into owned
 * blocks (`allocUnsafeSlow`, so none shares a slab), never a view of a
 * transport buffer, so what is held is the blocks' storage and O(blocks)
 * objects, however small the chunks the transport gives. The first block is
 * the declared length when the node gives one (one block for an honest
 * node), else 4 KiB; each later one doubles what is held, to 64 KiB. No
 * block passes `cap`, the most the reservation counted.
 */
class Blocks {
  constructor(cap, declared) {
    this.cap = cap;
    this.declared = declared;
    this.list = [];
    this.length = 0;
    this.allocated = 0;
  }

  push(chunk) {
    let at = 0;
    while (at < chunk.byteLength) {
      let last = this.list[this.list.length - 1];
      if (!last || last.used === last.buffer.length) last = this.grow();
      const n = Math.min(chunk.byteLength - at, last.buffer.length - last.used);
      last.buffer.set(chunk.subarray(at, at + n), last.used);
      last.used += n;
      at += n;
    }
    this.length += chunk.byteLength;
  }

  grow() {
    const first = this.list.length === 0 && this.declared !== null && this.declared > 0;
    const want = first
      ? this.declared
      : Math.min(BLOCK_MOST, Math.max(BLOCK_FIRST, this.allocated));
    const size = Math.max(1, Math.min(want, this.cap - this.allocated));
    const block = { buffer: Buffer.allocUnsafeSlow(size), used: 0 };
    this.list.push(block);
    this.allocated += size;
    return block;
  }

  /** The bytes held, as views of the blocks: O(blocks). */
  views() {
    return this.list
      .filter((block) => block.used)
      .map((block) => block.buffer.subarray(0, block.used));
  }
}

/**
 * Reads `body` whole, at most `max` bytes, into owned blocks (`Blocks`):
 * `{ chunks, length, allocated }`, `chunks` the blocks' views, `allocated`
 * their storage, or `{ failed }` (its class, or `too_large` past `max`).
 * With `cut`, a longer body is cut at `max` instead (an error status's).
 * `declared` is the length the node gave, when it is to be believed.
 */
async function readWhole(body, max, life, { cut = false, declared = null } = {}) {
  const reader = body.getReader();
  const blocks = new Blocks(max, declared !== null && declared <= max ? declared : null);
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      return { failed: failureOf(err, life) };
    }
    if (chunk.done) break;
    const { value } = chunk;
    if (blocks.length + value.byteLength > max) {
      reader.cancel().catch(() => {});
      if (!cut) return { failed: 'too_large' };
      blocks.push(value.subarray(0, max - blocks.length));
      break;
    }
    blocks.push(value);
  }
  return { chunks: blocks.views(), length: blocks.length, allocated: blocks.allocated };
}

/**
 * The base64 of `chunks`' bytes (a body's blocks), as the strings of their
 * runs, at most two a block: each run a whole number of 3-byte groups but
 * the last, so the strings joined are the bytes' base64, with no copy of
 * the bytes made whole (a carry of at most two bytes moves to the next
 * block).
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
 * base64 in runs, at most two a block. */
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

/**
 * One streamed upload's `swarm.body` (design 0015, Uploads; SWM-5's calls,
 * points 3 and 12): main asks the core for it once, for its call alone,
 * and pipes the core's answer into the node's request. Its call is the
 * parent's open streaming call while it lasts (`entry.upload`), which the
 * parent's parts need (`order` otherwise).
 */
class Upload {
  /**
   * @param {SwarmShell} shell
   * @param {object} entry - the parent's
   * @param {object} call - the admitted call, its body `{ stream: n }`
   * @param {number} step - its step in the row, for the logs
   * @param {object} spec - `{ id, generation, parts }`: the core's ID for
   *   the call (`swarm.body`'s `for`), the process that asked, and the
   *   upload's part room (`partRoom`), or null with no parts
   * @param {AbortSignal} life - the call's end: the core's cancel, or the
   *   parent's
   */
  constructor(shell, entry, call, step, { id, generation, parts }, life) {
    this.shell = shell;
    this.entry = entry;
    this.step = step;
    this.id = id;
    this.generation = generation;
    this.length = call.body.stream;
    this.parts = parts;
    this.life = life;
    // Withdraws main's `swarm.body`: its cancel goes, and no more credit.
    this.stop = new AbortController();
    this.bodyId = null;
    this.body = null;
    this.closed = false;
    // The core's cancel of the call, or the parent's end, withdraws the
    // body in the same turn, before anything main answers is written.
    this.onEnd = () => this.withdraw();
    life.addEventListener('abort', this.onEnd, { once: true });
    entry.upload = this;
    shell.uploads += 1;
  }

  /**
   * Main's one `swarm.body` for the call, with its idle watchdog: the body
   * to pipe into the node's request, or null when there is none to pipe
   * (the core's error for it, the call's end, or a head that isn't exactly
   * `{ bytes }` of the call's length, a core fault, withdrawn).
   */
  async open() {
    const { client } = this.shell;
    const gen = client?.current;
    if (!gen || gen.number !== this.generation) return null;
    let opened;
    try {
      opened = await client.requestStreamTo(
        gen,
        'swarm.body',
        { for: this.id },
        { caller: 'shell' },
        {
          idleWatchdogMs: BODY_PROGRESS_MS,
          signal: this.stop.signal,
          takes: CORE_UPLOAD_ABORT_CODES,
          onSent: (id) => {
            this.bodyId = id;
          },
        }
      );
    } catch {
      return null;
    }
    if (this.stop.signal.aborted) {
      cancelBody(opened.body);
      return null;
    }
    if (!opened.body || !isBodyHead(opened.result, this.length)) {
      this.fault('head');
      return null;
    }
    // The body's head and each piece of it are the parent's progress, its
    // terminal the start of the core's wait for the node's answer.
    this.shell.progressed(this.entry);
    this.body = uploadBody(
      opened.body,
      this.length,
      (why) => this.fault(why),
      (end) => this.shell.progressed(this.entry, end ? PUBLISH_BODY_END_MS : PUBLISH_PROGRESS_MS)
    );
    return this.body.stream;
  }

  /** A core fault on the body: logged, and the body withdrawn. */
  fault(why) {
    this.shell.log.warn('[Core] swarm.body: the core broke its upload', {
      parent: this.entry.row,
      step: this.step,
      fault: why,
    });
    this.withdraw();
  }

  /** The node answered: what it hasn't taken of the body is withdrawn
   * before main answers the call (D4). */
  answered() {
    if (!this.body?.ended) this.withdraw();
  }

  /** Main lets go of the body: its pulls stop, and its cancel goes unless
   * its terminal came. */
  withdraw() {
    this.body?.hold();
    this.stop.abort();
  }

  /** The call is over: it is no longer the parent's open streaming call,
   * a body not taken whole is withdrawn (before main answers), and no part
   * takes its room from now on (`partRoom`'s `hold()`). */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.body?.ended) this.withdraw();
    this.parts?.hold();
    this.life.removeEventListener('abort', this.onEnd);
    if (this.entry.upload === this) this.entry.upload = null;
    this.shell.uploads -= 1;
  }
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
   *   question 4's route test for `subscribe`, given `{ backend, key }` (the
   *   parent's node and the page's key): a reason to answer `ok: false`
   *   with, or null to go on to the probe; by default the subscription
   *   registry's `checkRoute` on the parent's node
   * @param {() => object} [deps.subscriptions] - the subscription registry
   *   (swarm/subscription-registry.js) `shell.swarm_subscribe` opens through
   * @param {() => number} [deps.now]
   * @param {Function} [deps.setTimer]
   * @param {Function} [deps.clearTimer]
   * @param {number} [deps.idleMs] - a body's idle bound (ant-api-call.js)
   * @param {object} [deps.client] - the core's client (core-client.js),
   *   for main's `swarm.body` (`requestStreamTo`, `current`) and the
   *   watchdog's progress (`watchdogProgress`); `registerSwarmShell` gives
   *   the one it registers on
   * @param {Function} [deps.openFile] - `fs.promises.open(path, 'r')`, a
   *   picked part's
   */
  constructor({
    client = null,
    openFile = (path) => fs.promises.open(path, 'r'),
    log = defaultLog,
    pool = swarmIoPool,
    backendKind = () => require('../swarm/swarm-backend-kind').swarmBackendKind(),
    nodeUrl = () => require('../service-registry').getAntApiUrl() || null,
    publishReadiness = () => require('../swarm/publish-setup-service').getPublishReadiness(),
    subscriptions = () => require('../swarm/subscription-registry'),
    subscribeCheck = async ({ backend, key }) =>
      (await subscriptions().checkRoute(backend.url || null, key ?? null))?.reason ?? null,
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
    this.subscriptions = subscriptions;
    this.subscribeCheck = subscribeCheck;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.idleMs = idleMs;
    this.client = client;
    this.openFile = openFile;
    // The live parents, by generation and ID.
    this.live = new Map();
    // The highest ID opened in each generation: a `for` at or below it that
    // isn't live has ended.
    this.highest = new Map();
    // Calls dialling or streaming; their uploads; parts streaming.
    this.calls = 0;
    this.uploads = 0;
    this.parts = 0;
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
   * @param {Map<number, Uint8Array|{path: string, bytes: number}>} [capture.parts] -
   *   the source of each part its params name (`partsOf`), which
   *   `shell.swarm_part` streams: a held buffer, or a picked file
   * @param {{document: string, deliverTo: Function}|null} [capture.subscriber] -
   *   a page's `subscribe`: the document its subscription is bound to and
   *   how its messages go there, as page-swarm.js gives them (`page.document`,
   *   `page.deliverTo`), which `shell.swarm_subscribe` opens it for
   * @returns {{ close(): void, asked(): boolean }}
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
      subscriber = null,
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
    if (
      subscriber !== null &&
      (typeof subscriber?.document !== 'string' || typeof subscriber.deliverTo !== 'function')
    ) {
      throw new TypeError('a subscriber is a document and its delivery');
    }
    const parent = keyOf(generation, id);
    if (this.live.has(parent)) throw new TypeError('that request is open already');
    const entry = {
      row,
      generation,
      id,
      // `swarm.publish`, main's idle method: its watchdog follows its
      // progress (`progressed`).
      idle: row.startsWith('swarm.publish:'),
      admission: new Admission({ row, params, key }),
      backend,
      parts: partsOf(row, params, parts),
      // Its open streaming call (`Upload`), while one is.
      upload: null,
      life: new AbortController(),
      walk: null,
      walkBusy: false,
      timer: null,
      ended: false,
      subscriber,
      // `shell.swarm_subscribe` came for it.
      subscribed: false,
      // An ask named it while it was live (`parentOf`).
      asked: false,
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
    // `asked()`: whether the core asked anything naming it, so far
    // (swarm-own-calls.js reads it at the request's end).
    return { close, asked: () => entry.asked };
  }

  /** What the shell holds, for diagnostics and tests. */
  stats() {
    let walks = 0;
    for (const entry of this.live.values()) if (entry.walk) walks += 1;
    return {
      parents: this.live.size,
      calls: this.calls,
      walks,
      uploads: this.uploads,
      parts: this.parts,
    };
  }

  /**
   * Progress of an idle parent (`swarm.publish`, D13): its watchdog's
   * deadline becomes at least now + `boundMs` (75 s by default). Nothing
   * for a parent with a deadline, or without the client.
   */
  progressed(entry, boundMs = PUBLISH_PROGRESS_MS) {
    if (!entry?.idle || !this.client) return;
    this.client.watchdogProgress(entry.generation, entry.id, boundMs);
  }

  /** An ask naming `entry`: progress now, and again once main's answer to
   * it (whatever it is, a refusal or a `cancelled` among them) is in the
   * pipe. */
  asked(entry, onAnswer) {
    if (!entry?.idle) return;
    this.progressed(entry);
    onAnswer?.(() => this.progressed(entry));
  }

  /**
   * The live parent `id` of `generation`, or whether it has ended. Each
   * call is an ask's (`shell.swarm_ready`, `_api`, `_part`, `_subscribe`):
   * a live parent it finds is marked asked.
   */
  parentOf(generation, id) {
    const entry = id === null ? undefined : this.live.get(keyOf(generation, id));
    if (entry) {
      entry.asked = true;
      return { entry, ended: false };
    }
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
  async ready(params, { signal, generation, onAnswer = null }) {
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
    this.asked(entry, onAnswer);
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
      const reason = await this.subscribeCheck({ backend: entry.backend, key: entry.admission.key });
      if (typeof reason === 'string' && reason) return { ok: false, reason };
    }
    return this.probe(entry, signal);
  }

  // ---- shell.swarm_subscribe, shell.swarm_unsubscribe ----

  /**
   * The handler: one `shell.swarm_subscribe` (D16). Opens the parent's
   * subscription through the registry, bound to its document, on its node,
   * with the core's connection as its opener: `{ id }`, or `{ failed }`.
   * The core's cancel, or the parent's end, while it opens ends it, and the
   * answer waits for the cancel (the core cancels the open as it reads the
   * parent's end): a late `{ id }` is closed, never sent.
   */
  async subscribe(params, { signal, generation }) {
    const ask = readSubscribe(params);
    const found = this.parentOf(generation, ask ? ask.for : null);
    if (!ask) return this.refuse('shell.swarm_subscribe', found.entry, 'form');
    if (!found.entry) {
      if (!found.ended) return this.refuse('shell.swarm_subscribe', null, 'ended');
      this.log.debug?.('[Core] shell.swarm_subscribe for a parent that has ended');
      return untilCancelled(signal);
    }
    const { entry } = found;
    const rule = subscribeRule(entry, ask);
    if (rule) return this.refuse('shell.swarm_subscribe', entry, rule);
    entry.subscribed = true;
    if (!entry.subscriber || typeof entry.admission.key !== 'string') {
      // Main's own bug: a page's subscribe opened without its document or key.
      this.log.warn('[Core] shell.swarm_subscribe for a parent with no document');
      return failedOpen(new Error('The subscription has no document'));
    }
    const life = AbortSignal.any([signal, entry.life.signal]);
    const registry = this.subscriptions();
    let opened;
    try {
      opened = await registry.subscribe({
        origin: entry.admission.key,
        document: entry.subscriber.document,
        deliverTo: entry.subscriber.deliverTo,
        kind: ask.kind,
        key: ask.key,
        nodeUrl: entry.backend.url || null,
        signal: life,
        opener: this.openerOf(generation),
      });
    } catch (err) {
      if (life.aborted) return untilCancelled(signal);
      return failedOpen(err);
    }
    if (life.aborted) {
      // Opened as the request ended: closed, never answered.
      registry.cancelById(opened.subscriptionId);
      return untilCancelled(signal);
    }
    return { id: opened.subscriptionId };
  }

  /**
   * The handler: one `shell.swarm_unsubscribe { id }`, answered `{}` at
   * once: the subscription closed if `shell.swarm_subscribe` opened it on
   * this connection, else already gone. A malformed ask is a core fault
   * (`form`), which ends the connection.
   */
  unsubscribe(params, { generation }) {
    if (!exactly(params, UNSUBSCRIBE_MEMBERS) || typeof params.id !== 'string' || params.id === '') {
      return this.refuse('shell.swarm_unsubscribe', null, 'form');
    }
    this.subscriptions().cancelByOpener(this.openerOf(generation), params.id);
    return {};
  }

  /** The opener a connection's subscriptions carry: one per generation. */
  openerOf(generation) {
    return `core:${generation}`;
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
  async api(params, { id, signal, charge, shrink, onRelease, onAnswer = null, generation }) {
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
    this.asked(entry, onAnswer);
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
    // A whole call's reply may take the core's 300 s from its ask; an
    // upload's (its body streamed) counts from the body's terminal.
    if (!call.stream && !(isObject(call.body) && Object.hasOwn(call.body, 'stream'))) {
      this.progressed(entry, PUBLISH_WHOLE_CALL_MS);
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
    // The reply's room: a stream's, or a whole call's sum.
    const reserve = call.stream ? STREAM_CHARGE : wholeCharge(Math.max(call.max_bytes, ERROR_BODY));
    // A streamed upload's `swarm.body` takes a stream's room beside it, to
    // the node's answer, and its parts one stream's room among them.
    const streamed = isObject(call.body) && Object.hasOwn(call.body, 'stream');
    if (!charge(reserve + (streamed ? STREAM_CHARGE : 0))) {
      over();
      return { failed: 'busy' };
    }
    let parts = null;
    if (streamed && entry.parts.size) {
      const room = this.pool.reserve(STREAM_CHARGE);
      if (!room) {
        over();
        return { failed: 'busy' };
      }
      parts = partRoom(room);
      // The call's answer in the pipe, or its reply dropped: its parts are
      // over too, and none of theirs follows the answer.
      onAnswer?.(() => parts.end());
      onRelease(() => parts.end());
    }
    try {
      return await this.dial(entry, call, verdict.ticket, settle, {
        signal,
        charge,
        shrink,
        reserve,
        upload: streamed ? { id, generation, parts } : null,
      });
    } catch (err) {
      // Main's own fault: the call is over, and answered `{ failed: "error" }`.
      shrink(0);
      settle(null);
      throw err;
    }
  }

  /** One dial of an admitted call, and its reply; a streamed upload's with
   * its `swarm.body` (`upload`: `Upload`'s spec). */
  async dial(
    entry,
    call,
    ticket,
    settle,
    { signal, charge, shrink, reserve, upload: spec = null }
  ) {
    const life = AbortSignal.any([signal, entry.life.signal]);
    const upload =
      spec && !life.aborted ? new Upload(this, entry, call, ticket.step, spec, life) : null;
    const failed = (code) => {
      // A body not taken whole is withdrawn before the answer (D4).
      upload?.withdraw();
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
      // The inline body as the grammar decoded it, never decoded again; or
      // the core's `swarm.body`, piped as the node takes it.
      let sending = ticket.bytes ?? null;
      if (upload) {
        sending = await upload.open();
        if (!sending) return failed(life.aborted ? 'aborted' : 'error');
      }
      let response;
      try {
        response = await callAnt(entry.backend, {
          path: target(call),
          method: call.method,
          headers,
          body: sending,
          signal: life,
          ...(this.idleMs !== undefined && { idleMs: this.idleMs }),
        });
      } catch (err) {
        return failed(failureOf(err, life));
      }
      // The node answered: a body it hasn't taken whole is withdrawn first,
      // so no credit for it follows main's answer (point 12, D4).
      upload?.answered();
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
          onProgress: () => this.progressed(entry),
        });
      }
      if (declared !== null && declared > max) {
        cancelBody(body);
        return failed('too_large');
      }
      const whole = await readWhole(body, ok ? max : ERROR_BODY, life, { cut: !ok, declared });
      if (whole.failed) return failed(whole.failed);
      const { chunks, length, allocated } = whole;
      // The charge, over the body as read: its blocks, its base64 and the
      // serialized reply (0015's sum, the blocks' storage for `m`), and the
      // grammar's one copy of it when the grammar reads this answer.
      const reads = entry.admission.readsReply(ticket);
      const held = wholeCharge(length) - length + allocated + (reads ? length : 0);
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
      upload?.close();
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

  // ---- shell.swarm_part ----

  /**
   * The handler: one `shell.swarm_part`, read strictly and held to the part
   * rules (point 5) before anything is read; then, once it holds its
   * upload's part room (`partRoom`: one part at a time, in the order asked),
   * its head `{ bytes }`, the length its params give, and its bytes as a
   * stream. Past the rules it never throws: a part that fails after its
   * head ends its stream `body_stream_error` (design 0015, Error answers),
   * and so does one whose call or parent ended while it waited, having
   * opened nothing. The core's cancel of a waiting part takes it out of
   * the line; the service client answers that cancel.
   */
  async part(params, { generation, signal, onRelease, onAnswer = null, abortStream = null }) {
    const ask = readPart(params);
    const found = this.parentOf(generation, ask.for);
    if (ask.rule) return this.refuse('shell.swarm_part', found.entry, ask.rule);
    if (!found.entry) {
      if (!found.ended) return this.refuse('shell.swarm_part', null, 'ended');
      // Its parent ended as the core asked: a race, not a fault.
      this.log.debug?.('[Core] shell.swarm_part for a parent that has ended');
      throw new ShellError('invalid_argument', { rule: 'ended' });
    }
    const { entry } = found;
    this.asked(entry, onAnswer);
    const rule = partRule(entry, ask.part);
    if (rule) return this.refuse('shell.swarm_part', entry, rule);
    const part = entry.parts.get(ask.part);
    part.asked = true;
    const { upload } = entry;
    // Its place in the upload's part room (a parent with parts has one for
    // each streaming call), held until its last frame is written or its
    // reply dropped.
    const turn = upload.parts.turn();
    this.parts += 1;
    onRelease(() => {
      this.parts -= 1;
      turn.leave();
    });
    // Its stream fails once the parent ends, or once its call is answered
    // while it holds the room (`end()`): its source, and at the sender what
    // it holds of the stream, its last data and an `end` its source has
    // already given among them.
    const stop = new AbortController();
    turn.onEnd(() => {
      stop.abort();
      abortStream?.(new PartError("the part's call ended"));
    });
    const life = AbortSignal.any([entry.life.signal, stop.signal]);
    // The core's cancel, or the parent's end, while it waits: it leaves
    // the line. Once it holds the room, only its release gives it back.
    const quit = () => turn.leave();
    for (const source of [signal, entry.life.signal]) {
      source?.addEventListener('abort', quit, { once: true });
    }
    let owns;
    try {
      if (signal?.aborted || entry.life.signal.aborted) quit();
      owns = await turn.ready;
    } finally {
      for (const source of [signal, entry.life.signal]) source?.removeEventListener('abort', quit);
    }
    let body;
    if (!owns || life.aborted || signal?.aborted) body = endedPart();
    else if (part.held) body = heldPart(part.held, life);
    else body = pickedPart(part.path, part.length, life, this.openFile);
    // Its frames and the core's credit on it are its upload's progress
    // (D13's one timer), which the watchdog sees only through them, and
    // its parent's (`swarm.publish`'s own watchdog).
    const onProgress = () => {
      this.progressed(entry);
      if (upload.bodyId === null) return;
      this.client?.watchdogProgress(upload.generation, upload.bodyId, BODY_PROGRESS_MS);
    };
    return new StreamedReply({ bytes: part.length }, body, { bodyFlag: false, onProgress });
  }
}

/**
 * The part rules (design 0015, The rules, "Parts"; SWM-5's point 5): a
 * part of a parent that refused or ended is `ended`; another parent's
 * part, or one its params don't have, `value`; a part asked a second time
 * `count`; one asked while none of its parent's streaming calls is open
 * `order`. Null when it is admitted.
 */
function partRule(entry, number) {
  const { admission } = entry;
  if (admission.ended || admission.refused) return 'ended';
  const part = entry.parts.get(number);
  if (!part) return 'value';
  if (part.asked) return 'count';
  if (!entry.upload) return 'order';
  return null;
}

/**
 * Registers the Swarm asks on `client`, whichever backend runs (the
 * switch): `shell.swarm_ready`; `shell.swarm_subscribe` and
 * `shell.swarm_unsubscribe`; `shell.swarm_api` twice, its whole calls
 * (`stream: false`, uploads among them) on the client's own replies, which
 * a large one (a `/stamps` reply's base64 passes one frame) may fragment,
 * and its streaming calls on the duplex, whose bodies may end
 * `too_large`; and `shell.swarm_part` on the duplex, whose parts may end
 * `body_stream_error` naming an errno. Each charges the Swarm I/O pool and
 * races the core's cancel; the first two answer their failures with their
 * failure forms, and a part answers every failure past its rules in its
 * stream. The shell sends `swarm.body` on `client`.
 *
 * And `shell.swarm_manifest { for, url }` (design 0015, D6): `manifestAsk`,
 * permission-manifests.js's `answerManifestAsk` by default, which fetches
 * the manifest of main's running check `for` on its window's session. Its
 * charge goes on the Swarm I/O pool, a throw answers `{ failed: true }`
 * (the check's transport failure), and the core's cancel `cancelled` at
 * once.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {object} [deps] - SwarmShell's test seams, and `manifestAsk`
 * @returns {SwarmShell}
 */
function registerSwarmShell(client, deps = {}) {
  const {
    manifestAsk = (params, context) =>
      require('../swarm/permission-manifests').answerManifestAsk(params, context),
    ...shellDeps
  } = deps;
  const shell = new SwarmShell({ client, ...shellDeps });
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
  client.handle('shell.swarm_part', (params, context) => shell.part(params, context), {
    streams: true,
    sends: SWARM_PART_ABORT_CODES,
    pool,
    race: true,
  });
  client.handle('shell.swarm_subscribe', (params, context) => shell.subscribe(params, context), {
    pool,
    failure: () => failedOpen(new Error('The subscription could not be opened')),
    race: true,
  });
  // Never cancelled (D13), and answered at once.
  client.handle('shell.swarm_unsubscribe', (params, context) => shell.unsubscribe(params, context), {
    pool,
    failure: () => ({}),
  });
  client.handle('shell.swarm_manifest', (params, context) => manifestAsk(params, context), {
    pool,
    failure: () => ({ failed: true }),
    race: true,
  });
  return shell;
}

module.exports = {
  registerSwarmShell,
  SwarmShell,
  BODY_PROGRESS_MS,
  ERROR_BODY,
  PUBLISH_BODY_END_MS,
  PUBLISH_PROGRESS_MS,
  PUBLISH_WHOLE_CALL_MS,
  PART_READ,
  READY_BODY,
  READY_TIMEOUT_MS,
  STREAM_CHARGE,
  WALK_CHARGE,
  postCharge,
  wholeCharge,
};
