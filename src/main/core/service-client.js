/**
 * The client for one of main's service processes (freedom-core design 0001,
 * "Process model" and "Messages"; design 0007, "Main's side"): the
 * supervision freedom-cored and the service processes share. Each process
 * configures its own instance (`service`): its handshake, its shutdown
 * method, its log label and the texts that name it. `CoreClient`
 * (core-client.js) is freedom-cored's.
 *
 * One ServiceClient supervises one profile's process:
 * - spawn with a scrubbed environment and stdio pipes;
 * - the handshake within 10 s;
 * - JSON requests framed over stdin/stdout;
 * - events from the process;
 * - restarts after 0.5 s, 2 s, then 10 s, until three crashes within 60 s;
 * - no restart after a protocol mismatch, a requested stop, or the exit
 *   codes that mean "don't retry" (64 usage, 74 storage, 75 lock held, 77
 *   confinement);
 * - no restart after exit 0 that follows a start step's error (a request
 *   sent with `endsOnError`; freedom-core design 0008, Errors): the process
 *   answered the error and ended, as it said it would, and main has read
 *   the error;
 * - a deferred spawn (`deferSpawn`): before each spawn, restarts included,
 *   the caller may make the client wait, with nothing running, which
 *   neither fails it nor counts as a crash (0008: a start on a locked vault
 *   waits for the unlock).
 *
 * **Generations.** Each child is one `Generation` record: its pending
 * requests, its writer budget, its decoder, stderr and timers. Its lifecycle
 * is live → exited (the process is gone; stdout may still hold final
 * replies, which are delivered) → retired (stdio closed; remaining requests
 * are rejected). Nothing from an exited or retired generation can emit
 * events or make the client ready, and callbacks of a retired generation do
 * nothing.
 *
 * **Stopping is sticky.** Once `stop()` is called, no handshake, timer or
 * exit can make the client ready or restart it, until `start()` is called
 * again after the stop completed.
 *
 * **Fragmented responses** (design 0005, Frames): main's hello offers
 * them, so a response of the process over one frame, up to 32 MiB, comes as
 * a begin, fragments and a last fragment. Its bytes are reserved at the
 * begin, which must name a pending request while the process holds main's
 * bulk credit. Main returns the credit (`0x13`) once the request's caller
 * has the response. Every malformed sequence is a protocol fault. The other
 * way, a reply to one of the process's requests over one frame goes
 * fragmented, if the process offered `fragments`: begun only while main
 * holds its credit, then written to its end, with whole frames going first
 * and between its fragments.
 *
 * **Streams** (design 0007, Frames and Main's side), for a process whose
 * handshake granted `stream` (`service.streams(hello)`): from then on its
 * decoder takes the stream frames, and the generation has one
 * `StreamReceiver` and one `StreamOutbox`. `callStream` resolves to a
 * request's head and, for a head that says `body: true`, a byte
 * ReadableStream pulled on demand: each pull copies up to 64 KiB of the
 * stream's 128 KiB ring and returns those bytes as credit; `end` closes it
 * once every byte is read; `abort` errors it with the abort's code. Its
 * cancel, or its signal, retires the stream: `cancel` goes, with no more
 * credit, and its frames are dropped until the terminal. Credit and
 * cancels are written through the outbox, one write in flight and the
 * rest merged, so what waits is at most one of each per stream. Every
 * request counts against the process's bound (`service.maxPending`; 512 for
 * a stream service) until its reply or terminal, retiring ones included.
 * The rings are main's stream storage, apart from the chain I/O pool
 * below. A generation that ends, or breaks the protocol, errors its open
 * bodies at once, and nothing of it reaches a later one.
 *
 * **Streams both ways** (freedom-core design 0009, Streams in the core),
 * for the core's connection once its hello has settled protocol 2
 * (`service.duplex(hello)`): its decoder takes all four stream frames, and
 * the generation has one `StreamDuplex`. Main's own requests' bodies are as
 * above, ending only with the core's verified bodies' codes. The core's
 * requests to a handler registered with `streams: true` go through the
 * duplex's sender: their one reply, or a head and a body when the handler
 * answers with a `StreamedReply`. Its body is read only as the core's
 * credit and the writer's cap allow, at most 64 KiB ahead, which counts
 * against the cap until the sender takes it: a byte stream through a BYOB
 * reader, asked for no more than that and the room; any other stream a
 * chunk at a time, and a chunk past 64 KiB ends it as `body_stream_error`
 * (a source main can't bound). It ends with `end`, or with an abort
 * (`stalled` or `body_stream_error`; design 0015's handlers give their
 * bodies codes of their own, `handle(…, { sends })`, which may also end
 * `too_large` or name a part's error code), and the core's cancel aborts
 * it with `cancelled` and cancels the body. Main's own requests may give
 * the codes their bodies take likewise (`requestStreamTo(…, { takes })`,
 * the core's `swarm.body` uploads). Credit main owes, its cancels and the
 * sender's frames are written in that order, one write in flight.
 *
 * **A two-way service** (freedom-core design 0014, COL-3: a service
 * connection that takes main's bodies, freedom-colibrid's) has the same
 * duplex, with its own kinds and codes (`SERVICE_DUPLEX`): its decoder
 * takes all four stream frames and no fragments (`serviceKinds('both')`),
 * and the bodies it sends main end with a service's codes, 0007's five.
 * The service's requests to a `streams: true` handler are answered as the
 * core's are (`shell.colibri_fetch`: a head, then main's body under the
 * service's credit). A one-way service is as before: credit from it is a
 * protocol error, and a `StreamedReply` is an internal error.
 *
 * **What a service's owner may take over** (design 0014, Spawn, The step
 * marker, Crashes): events read after the process's exit, until its pipe
 * closes (`service.eventsUntilClose`), so a marker written just before a
 * death still reaches the owner, ahead of the client's `exit`; restarts
 * (`restart: false`: an exit leaves the client stopped, with nothing
 * armed, and the owner decides when to start it again); a step after each
 * spawn (`afterSpawn`, its scheduling priority); and the end of a process
 * it no longer trusts (`abandon`).
 *
 * **Order on the wire.** A frame main writes outside the stream writer (a
 * request, a reply, a fragment, the bulk credit) goes after every stream
 * control frame main made before it: what waits for the stream writer's
 * write in flight, but for data and an `end` behind it, is written first
 * (`flushControl`). So a request never overtakes an earlier cancel, and a
 * cancel never goes ahead of its request.
 *
 * **Main's cancels** (0001): a request sent with a `signal` is cancelled
 * when it aborts. Its caller gets `cancelled` at once, and the process a
 * `cancel`; the process's one response still comes, and is consumed and
 * dropped.
 *
 * **Main's chain I/O pool** (design 0005, Main's pool): 192 MiB for what
 * main holds for the process until it is written. Handlers charge the
 * bodies they read and the results they hold; a reply of 64 KiB or more is
 * charged from serialization until written or dropped. Past it, a reply is
 * `busy`. Control frames (credit, cancels, shutdown) and smaller replies
 * are never held back by it.
 *
 * **A pool of the handler's own** (freedom-core design 0015, Main's Swarm
 * I/O pool): a handler registered with `handle(…, { pool })` charges that
 * pool, never the chain I/O pool, and what it charged is held until its
 * reply's last byte is written (a streamed reply's terminal), or until the
 * reply is dropped; a reply of 64 KiB or more is charged there for what
 * the handler didn't. A request main sends with `{ pool }` has its
 * response charged there (design 0015, Results for pages): a fragmented
 * one twice the size its begin declares, before its buffer is made; a
 * whole one of 64 KiB or more twice its payload's length as it is decoded,
 * before anything holds it past its frame. Its result goes to the caller
 * with a release (`{ result, release }`), and stays charged until the
 * caller calls it, once it has handed the result on (to the page). One
 * main can't charge is never held: a fragmented one is read with no buffer
 * and dropped, a whole one let go of, and the caller gets `busy`.
 *
 * **Idle watchdogs** (design 0015, D13): a request with no total deadline
 * goes with `idleWatchdogMs`, a hang watchdog whose deadline its progress
 * moves on (`watchdogProgress`), never held. For a stream request it runs
 * to the body's terminal, not its head, and the core's head, data and
 * terminal and main's credit for that body are its progress. A service's
 * idle methods (`service.idleMethod`) are sent only with one.
 *
 * **Device watchdogs** (freedom-core design 0016, "The device lane"): a
 * request that drives a Ledger goes with `deviceWatchdogMs`, a hang
 * watchdog whose deadline main sets again, earlier or later, at each of
 * the process's `shell.ledger_apdu` naming it and at each answer to one
 * (`watchdogReset`), never held. It ends at the response.
 *
 * **Logs** carry fixed categories and validated public fields only: never
 * request or response bodies, peer-supplied IDs, types or error text.
 */

const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { isPrivateLogContext, privateContextSession } = require('../private/private-log-context');
const {
  encodeBegin,
  encodeCredit,
  encodeFrame,
  encodeJsonFrame,
  frameHeader,
  serviceKinds,
  CORE_KINDS,
  FrameDecoder,
  FrameError,
  StreamDuplex,
  StreamOutbox,
  StreamReceiver,
  CORE_BODY_ABORT_CODES,
  CORE_STREAM_KINDS,
  CORE_UPLOAD_ABORT_CODES,
  SERVICE_ABORT_CODES,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_FRAGMENT,
  KIND_JSON,
  KIND_LAST,
  KIND_STREAM_CREDIT,
  MAX_DATA,
  MAX_MESSAGE,
  MAX_PAYLOAD,
  MAX_PULL,
  Reassembler,
} = require('./frame');

const STREAM_FRAME_KINDS = new Set([KIND_DATA, KIND_END, KIND_ABORT, KIND_STREAM_CREDIT]);
// The most the duplex's writer takes into one write (design 0009): its
// frames are cancellable until taken.
const STREAM_WRITE_BYTES = 256 * 1024;
// The most main reads ahead of a body it sends the core, per read: one data
// frame. A byte stream is asked for at most this (and the room); any other
// stream's chunk past it can't be bounded, and ends the body.
const MAX_READ_AHEAD = MAX_DATA;
// How a body main sends the core ends when it fails (design 0009,
// `shell.dweb_get`): a piece's codes, and design 0015's `too_large` for a
// stream whose codes take it, with fixed messages.
const PIECE_ABORTS = Object.freeze({
  stalled: 'The body stalled',
  body_stream_error: 'The body failed',
  too_large: 'The body is too large',
});
// A two-way service's duplex (design 0014, COL-3), for its `service` to
// spread beside `duplex(hello)`: all four stream frames both ways and no
// fragments, and its own bodies' codes a service's. The core's are the
// defaults (`CORE_STREAM_KINDS`, `CORE_BODY_ABORT_CODES`).
const SERVICE_DUPLEX = Object.freeze({
  duplexKinds: serviceKinds('both'),
  duplexTakes: SERVICE_ABORT_CODES,
});
// Every set the core's bodies may end with: its verified bodies' and its
// `swarm.body` uploads' (design 0015), whose requests give theirs.
const CORE_TAKES = Object.freeze([CORE_BODY_ABORT_CODES, CORE_UPLOAD_ABORT_CODES]);
// Why an owner abandons its process (`abandon`): a fixed name, safe to log.
const ABANDON_CAUSE = /^[a-z][a-z0-9_]{0,31}$/;

const MAX_ID = Number.MAX_SAFE_INTEGER; // 2^53 - 1: exact in JS
const HELLO_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 3_000;
// After the process exits, how long its stdout may take to close.
const DRAIN_MS = 2_000;
const RESTART_DELAYS_MS = [500, 2_000, 10_000];
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 3;
// sysexits codes after which the process must not be restarted: usage (64),
// storage or refused filesystem (74), lock held by another process (75), and
// 77, the service refusing its own confinement (freedom-core design 0010: a
// thread or descriptor it didn't expect, or its rules refused), which a
// restart would meet again. 76 (protocol) is restarted under the crash
// policy, unless the handshake reported a protocol mismatch.
const NO_RESTART_EXIT_CODES = new Set([64, 74, 75, 77]);
// A native library out of memory under the service's memory cap (design
// 0010, "The memory cap"): SQLite's or libgit2's allocation failed. It is a
// crash, restarted under the crash policy; its owner may name it.
const OUT_OF_MEMORY_EXIT_CODE = 71;
// Admission limits per generation. Control frames (hello, shutdown) don't
// count, so they always get through.
const MAX_PENDING = 256;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
// A failed SIGKILL is retried this often, this many times in all.
const KILL_RETRY_MS = 1_000;
const MAX_KILL_ATTEMPTS = 3;
// The longest stderr line kept; longer lines are truncated.
const MAX_STDERR_LINE = 16 * 1024;
const MAX_FORWARDED_TEXT = 1024;
const LOG_LEVELS = { error: 'error', warn: 'warn', info: 'info', debug: 'info' };
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
// The process's requests to main (`shell.*`, design 0004): at most this many
// are outstanding, as the process bounds them.
const METHOD_NAME = EVENT_NAME;
const MAX_INCOMING = 256;
// Main's chain I/O pool (design 0005, Main's pool): what main holds for the
// process until it is written. Handlers charge the bodies they read and the
// verifier results they hold, until their reply is serialized; a reply of
// POOL_EXEMPT_BYTES or more is charged from serialization until it is
// written or dropped, a fragmented one whole for as long as its buffer is
// referenced. Past the pool, an exchange or a reply is `busy`. Smaller
// replies are exempt: main's limit of 256 outstanding requests bounds them
// at 16 MiB.
const POOL_BYTES = 192 * 1024 * 1024;
const POOL_EXEMPT_BYTES = 64 * 1024;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
// fc-protocol's ErrorCode (crates/fc-protocol/src/error.rs). Only these are
// ever logged; callers still get any well-formed code.
const KNOWN_ERROR_CODES = new Set([
  'vault_locked',
  'incorrect_password',
  'throttled',
  'no_vault',
  'vault_exists',
  'unsupported_vault_version',
  'corrupt_vault',
  'invalid_mnemonic',
  'invalid_argument',
  'weak_password',
  'storage',
  'node_identity_corrupt',
  'forbidden',
  'busy',
  'cancelled',
  'deadline',
  'protocol_mismatch',
  'unknown_method',
  'internal',
]);
// The only environment variables a process gets by default (design 0001).
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'RUST_LOG', 'SystemRoot'];

const STATE = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  FAILED: 'failed',
};

// A request whose `requires` the process it would be written to doesn't
// meet: refused in main, nothing written (see send).
const REQUIREMENT_UNMET = 'requirement_unmet';

class CoreError extends Error {
  /**
   * @param {string} code - fc-protocol error code, or `core_unavailable`
   * @param {string} message
   * @param {object} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.data = data;
  }
}

/**
 * The terminal errors main sends for the process's requests, each with its
 * fixed message (design 0004, Transport errors): none carries a URL or a
 * server's text.
 */
const SHELL_ERRORS = Object.freeze({
  timeout: 'Timed out',
  network: 'Network error',
  refused: 'Refused',
  too_large: 'Too large',
  cancelled: 'Cancelled',
  stale_generation: 'Stale generation',
  // Main has no room to hold the reply (design 0005, Main's pool).
  busy: 'Busy',
  unknown_method: 'Unknown method',
  internal: 'Internal error',
  // Params main refuses before doing anything for them (design 0009,
  // `shell.dweb_get`: read strictly).
  invalid_argument: 'Invalid argument',
});

/**
 * The grammar's rules a Swarm refusal names (design 0015, "The operation
 * grammar"; the core's `wire.rs` `rule()`, which takes no other): the only
 * `data` a Swarm handler's `invalid_argument` may carry, as `{ rule }`.
 */
const REFUSAL_RULES = new Set([
  'form',
  'order',
  'count',
  'value',
  'header',
  'query',
  'body',
  'ended',
]);

/** A handler's terminal error for one of the process's requests: one of
 * SHELL_ERRORS' codes (anything else is sent as internal), with `data`, an
 * object, when the error carries more (design 0015: a refusal's
 * `{ rule }`). */
class ShellError extends Error {
  constructor(code, data) {
    super(code);
    if (data !== undefined && !isObject(data)) {
      throw new TypeError("A shell error's data is an object");
    }
    this.name = 'ShellError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** A request's params already serialized: `json` is sent as it is. */
class JsonParams {
  /** @param {string} json - one JSON value's text */
  constructor(json) {
    this.json = json;
  }
}

/**
 * A result already written as JSON: the parts of its text, in order, each
 * an ASCII string or a Buffer of UTF-8 JSON. A reply carrying one is
 * assembled straight into its frame's buffer, with no JSON.stringify of
 * the whole, no measuring of its UTF-8 and no re-encode: for a large body
 * (base64 of up to 18 MiB) those cost main's thread more than everything
 * else in the reply. The text must be exactly what JSON.stringify of the
 * result would write, and a string part must be ASCII (an escape-free
 * base64 body, digits, punctuation), so its length is its size in bytes.
 */
class JsonText {
  /** @param {Array<string|Buffer>} parts */
  constructor(parts) {
    this.parts = parts;
    this.length = parts.reduce((bytes, part) => bytes + part.length, 0);
  }

  /** Writes the text into `buffer` from `offset`; returns where it ends. */
  writeInto(buffer, offset) {
    let at = offset;
    for (const part of this.parts) {
      at += typeof part === 'string' ? buffer.write(part, at, 'latin1') : part.copy(buffer, at);
    }
    return at;
  }
}

/**
 * A handler's answer with a body (design 0009, `shell.dweb_get` with
 * `stream: true`), for a handler registered with `streams: true`, on the
 * core's connection at protocol 2 or a two-way service's (design 0014,
 * `shell.colibri_fetch`): `result`, the head's result, goes with
 * `body: true`, then `body`, a ReadableStream of its bytes. The body is read
 * only as the core's credit allows, at most 64 KiB ahead: a byte stream
 * (`type: "bytes"`) through a BYOB reader, asked for at most that and the
 * room; any other in its own chunks, each at most 64 KiB, or the stream ends
 * `body_stream_error`. Its close ends the stream once the bytes before it
 * have gone; its error aborts it at once, read or not and with no credit
 * needed, with the code the error's `abortCode` names where its stream's
 * codes take it (`stalled`, main's body idle timer; `too_large`, a node's
 * body past its call's `max_bytes`, design 0015), and `body_stream_error`
 * otherwise, naming the error's `errorCode` (an errno name) where they
 * take one (a `shell.swarm_part` part's). The core's cancel, or the
 * generation's end, cancels it.
 *
 * `bodyFlag: false` sends the head's result as it is, with no `body`
 * member: design 0015's Swarm heads (`shell.swarm_api`'s `{ status,
 * status_text, headers }`, `shell.swarm_part`'s `{ bytes }`), which the
 * core reads strictly, refusing any other member (freedom-cored's
 * `swarm/wire.rs`, `api_reply`; `swarm/stream.rs`, `part_head`), and whose
 * stream it opens by its own ask, not by a flag.
 *
 * `onProgress()` runs for each of main's frames of the stream as it is
 * written (its head, its data, its terminal) and for each credit the
 * process sends for it, until its terminal: design 0015's D13, where a
 * part's frames and the core's credit on it are the progress of the
 * upload's `swarm.body`, which main's idle watchdog sees only through
 * them. A throw in it is dropped.
 */
class StreamedReply {
  /**
   * @param {object} result - the head's result, e.g. `{ status, headers }`
   * @param {ReadableStream} body
   * @param {object} [options]
   * @param {boolean} [options.bodyFlag] - false to leave `body: true` out
   *   of the head (design 0015's Swarm heads)
   * @param {(() => void)|null} [options.onProgress] - the stream's frames
   *   and credit, as they happen
   */
  constructor(result, body, { bodyFlag = true, onProgress = null } = {}) {
    if (!isObject(result)) throw new TypeError('A streamed reply needs a result object');
    if (typeof body?.getReader !== 'function') {
      throw new TypeError('A streamed reply needs a ReadableStream body');
    }
    if (onProgress !== null && typeof onProgress !== 'function') {
      throw new TypeError("A streamed reply's onProgress is a function");
    }
    this.result = result;
    this.body = body;
    this.bodyFlag = bodyFlag !== false;
    this.onProgress = onProgress;
  }

  /** Lets go of a body that was never read. */
  discard() {
    try {
      this.body.cancel().catch(() => {});
    } catch {
      // Locked or gone: nothing to let go of.
    }
  }
}

/** Main's chain I/O pool: bytes held, within a limit. */
class IoPool {
  constructor(limit) {
    this.limit = limit;
    this.held = 0;
  }

  /** Charges `bytes`: false, and nothing charged, when they don't fit. */
  take(bytes) {
    if (bytes > this.limit - this.held) return false;
    this.held += bytes;
    return true;
  }

  release(bytes) {
    this.held -= bytes;
  }

  /** An account for one of the process's requests (`leaseOf`). */
  lease() {
    return leaseOf(this);
  }
}

/**
 * An account in `pool` (anything with `take(bytes)` and `release(bytes)`)
 * for one of the process's requests: `charge(bytes)` charges what its
 * handler holds (false, and nothing charged, past the pool), `shrink(bytes)`
 * gives back all of it but `bytes`, `held` is what it holds, and `close()`
 * releases it all. A closed account charges nothing more.
 *
 * One `untilWritten` (a handler's own pool, `handle(…, { pool })`) outlives
 * its handler: once its reply is serialized, `keep()` stops its charges and
 * hands over the release, which runs once; its `close()` then does nothing.
 *
 * `onRelease(fn)` runs `fn` once everything it charged is released (at
 * once if it already is): for a handler's own pool, when its reply's last
 * byte is written or the reply is dropped. A throw in `fn` is dropped.
 */
function leaseOf(pool, { untilWritten = false } = {}) {
  let held = 0;
  let open = true;
  let kept = false;
  const released = [];
  const run = (fn) => {
    try {
      fn();
    } catch {
      // The release stands.
    }
  };
  const close = () => {
    if (!open) return;
    open = false;
    pool.release(held);
    held = 0;
    for (const fn of released.splice(0)) run(fn);
  };
  return {
    untilWritten,
    get held() {
      return held;
    },
    onRelease: (fn) => {
      if (typeof fn !== 'function') throw new TypeError('onRelease takes a function');
      if (open) released.push(fn);
      else run(fn);
    },
    charge: (bytes) => {
      if (!open || kept || !Number.isSafeInteger(bytes) || bytes < 0 || !pool.take(bytes)) {
        return false;
      }
      held += bytes;
      return true;
    },
    shrink: (bytes) => {
      if (!open || !Number.isSafeInteger(bytes) || bytes < 0 || bytes >= held) return;
      pool.release(held - bytes);
      held = bytes;
    },
    keep: () => {
      kept = true;
      return close;
    },
    close: () => {
      if (!kept) close();
    },
  };
}

/** A request main cancelled: its caller's answer. */
function cancelled() {
  return new CoreError('cancelled', 'Cancelled');
}

/** Whether process `gen` meets a request's `requires`: its own hello, once
 * ready, answers true. No hello, or a throw, doesn't. */
function meets(gen, requires) {
  if (!gen.ready || !gen.hello) return false;
  try {
    return requires(gen.hello) === true;
  } catch {
    return false;
  }
}

/** A handler's failure as a reply's error: a ShellError's code (and data),
 * cancelled once the signal aborted, and otherwise `internal`, never its
 * text. */
function shellErrorBody(err, signal) {
  if (err instanceof ShellError) return shellError(err.code, err.data);
  if (signal.aborted) return shellError('cancelled');
  return shellError('internal');
}

/** `code`'s error body, with its fixed message and `data` if any; an
 * unknown code is internal, with none. */
function shellError(code, data) {
  if (typeof code !== 'string' || !Object.hasOwn(SHELL_ERRORS, code)) {
    return { code: 'internal', message: SHELL_ERRORS.internal };
  }
  return data === undefined
    ? { code, message: SHELL_ERRORS[code] }
    : { code, message: SHELL_ERRORS[code], data };
}

/**
 * A handler's failure as its outcome. A handler registered with `failure`
 * (design 0015's Swarm handlers: the core takes only `cancelled`, for an
 * ask it cancelled, or `invalid_argument` with `data: { rule }` exactly,
 * and any other error ends its connection) answers just those two as
 * errors, and anything else, a throw, another ShellError or a refusal of
 * any other shape, with the result `failure(code)` gives
 * (`{ failed: "error" }`), never `internal`.
 */
function failedOutcome(err, signal, failure) {
  if (!failure) return { error: shellErrorBody(err, signal) };
  if (signal.aborted) return { error: shellError('cancelled') };
  const rule = refusalRule(err);
  if (rule !== null) return { error: shellError('invalid_argument', { rule }) };
  const code = err instanceof ShellError && err.code !== 'cancelled' ? err.code : 'internal';
  return failedWith(code, failure);
}

/**
 * The rule of a refusal the core takes from a Swarm handler: a ShellError
 * `invalid_argument` whose data is exactly `{ rule }`, one member, a rule
 * the core knows (REFUSAL_RULES). Null for any other error, which the core
 * would read as a fault and end its connection for.
 */
function refusalRule(err) {
  if (!(err instanceof ShellError) || err.code !== 'invalid_argument') return null;
  const { data } = err;
  if (!isObject(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'rule')) {
    return null;
  }
  return typeof data.rule === 'string' && REFUSAL_RULES.has(data.rule) ? data.rule : null;
}

/** What main answers in place of a reply it can't send as it is (`code`:
 * `internal`, `busy`, `too_large`, or `cancelled` once the process
 * cancelled it): that error, or for a handler registered with `failure`,
 * the result it gives for the code, `cancelled` aside. */
function failedWith(code, failure) {
  if (!failure || code === 'cancelled') return { error: shellError(code) };
  try {
    return { result: failure(code) };
  } catch {
    return { error: shellError('internal') };
  }
}

function clip(text) {
  return text.length > MAX_FORWARDED_TEXT
    ? `${text.slice(0, MAX_FORWARDED_TEXT)} …(truncated)`
    : text;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `confinement`'s statuses, mechanism and gaps (freedom-core design 0010,
// "Reporting").
const STATUSES = new Set(['enforced', 'partial', 'unavailable', 'blocked', 'none']);
const PROPERTIES = ['files', 'exec', 'ipc', 'network'];
// What resolves names while confined: glibc's resolver (`system`, or
// `files_only` when it can't reach DNS) or, for freedom-ipfsd from 0.3.0, its
// own one DNS configuration: /etc/resolv.conf as parsed (`resolv_conf`), or
// its built-in servers where that can't be read or parsed (`fallback`, with
// the reason).
const RESOLUTIONS = new Set(['system', 'files_only', 'resolv_conf', 'fallback']);
const MECHANISM = /^[a-z0-9+-]{1,64}$/;
const GAP = /^[a-z_]{1,32}$/;
const MAX_GAPS = 16;
const MAX_REASON = 512;

/**
 * The public part of `confinement` (freedom-core design 0010, "Reporting"):
 * its mechanism, each property's status, the gaps a `partial` leaves, the
 * reasons, on Linux in `direct` mode `resolution`, and `memory_cap` ("The
 * memory cap"): the cap in bytes as read back, or null where there is none
 * (macOS, `unsupported`, or a limit refused from outside), with its reason.
 * A process whose policy has no cap (the core) leaves `memory_cap` out, and
 * so does its public part. Null if it isn't one.
 */
function validConfinement(confinement) {
  if (!isObject(confinement)) return null;
  const { mechanism, gaps = [], reasons = {}, resolution = null } = confinement;
  if (typeof mechanism !== 'string' || !MECHANISM.test(mechanism)) return null;
  const statuses = {};
  for (const property of PROPERTIES) {
    if (!STATUSES.has(confinement[property])) return null;
    statuses[property] = confinement[property];
  }
  if (
    !Array.isArray(gaps) ||
    gaps.length > MAX_GAPS ||
    !gaps.every((gap) => typeof gap === 'string' && GAP.test(gap))
  ) {
    return null;
  }
  if (!isObject(reasons)) return null;
  const kept = {};
  for (const name of [...PROPERTIES, 'resolution', 'memory_cap']) {
    const reason = reasons[name];
    if (reason === undefined) continue;
    if (typeof reason !== 'string') return null;
    kept[name] = reason.slice(0, MAX_REASON);
  }
  if (resolution !== null && !RESOLUTIONS.has(resolution)) return null;
  const report = { mechanism, ...statuses, gaps: [...gaps], reasons: kept, resolution };
  if (!Object.hasOwn(confinement, 'memory_cap')) return report;
  const cap = confinement.memory_cap;
  if (cap !== null && !(Number.isSafeInteger(cap) && cap >= 0)) return null;
  return { ...report, memory_cap: cap };
}

/** `confinement` as a log line carries it: the statuses, the gaps and the
 * memory cap where it has one, without the reasons' text. */
function confinementLog(confinement) {
  const { mechanism, files, exec, ipc, network, gaps, resolution } = confinement;
  const line = { mechanism, files, exec, ipc, network, gaps, resolution };
  if (confinement.memory_cap !== undefined) line.memory_cap = confinement.memory_cap;
  return line;
}

function scrubbedEnv(env = process.env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

/** One child process and everything bound to it. */
class Generation {
  constructor(number, kinds) {
    this.number = number;
    this.child = null;
    this.pending = new Map(); // id -> { settle(outcome) }
    // The process's requests, by id, from arrival until their reply is written:
    // MAX_INCOMING bounds them and their pending replies together.
    this.incoming = new Map(); // id -> AbortController
    this.lastIncomingId = 0;
    // Bytes of replies to the process still being written: their own account,
    // apart from requests' admission.
    this.replyBytes = 0;
    this.nextId = 1;
    this.writeBytes = 0;
    this.decoder = new FrameDecoder({ kinds });
    // Design 0007's streams, once the handshake has granted them: main's
    // side of every stream (one 128 KiB ring per open one, retirement
    // records), the credit and cancels it writes (one write in flight, the
    // rest merged), and the bodies handed to callers, by request ID.
    this.streams = null;
    this.outbox = null;
    this.outboxWriting = false;
    this.bodies = new Map();
    // The core's connection at protocol 2 (design 0009), or a two-way
    // service's (design 0014): both directions' streams, and the bodies
    // main sends (`StreamedReply`), by the process's request ID, with the
    // pool charges of the replies its sender holds.
    this.duplex = null;
    this.pieces = new Map(); // id -> { id, reader, byob, pending, eof, reading, claimed }
    this.pieceCharges = new Map(); // id -> release
    // A handler's own pool's charge for a streamed reply, held to its
    // terminal (`handle(…, { pool })`).
    this.streamCharges = new Map(); // id -> release
    // A streamed reply's `onProgress`, to its terminal: main's frames of
    // its stream as they are written, and the process's credit for it.
    this.streamProgress = new Map(); // id -> () => void
    // A handler's `onAnswer`, until main hands its answer to the pipe.
    this.answers = new Map(); // id -> [() => void]
    // Main's requests' idle watchdogs (`idleWatchdogMs`), to their response,
    // or to their body's terminal.
    this.idleWatchdogs = new Map(); // id -> { deadline, idleMs }
    // The process's fragmented responses: one at a time, while it holds main's
    // bulk credit.
    this.reassembler = new Reassembler();
    // Main's fragmented replies: only if the process offered them, one at a
    // time while main holds the process's credit. Those waiting to begin, and
    // the one being written.
    this.fragments = false;
    this.credit = false;
    this.bulk = [];
    this.sending = null; // { id, controller, payload, release, offset, writing }
    // The pool charges of its replies until written or dropped, each a
    // release that runs once; retirement releases what is left.
    this.charges = new Set();
    this.stderrText = new StringDecoder('utf8');
    this.stderrLine = '';
    this.stderrDropping = false;
    this.timers = new Set();
    this.helloTimer = null;
    this.ready = false; // a valid handshake completed while live
    this.readyAt = null; // when (`now()`) the handshake completed
    this.hello = null; // its handshake's result, once ready (`requires`)
    // A start step answered with an error (`endsOnError`): the process ends
    // after it, and its exit 0 is no crash.
    this.stepFailed = false;
    this.exited = false; // the process is gone (stdout may still drain)
    this.retired = false; // stdio closed; nothing more is accepted
    this.ending = false; // we killed it or asked it to stop
    this.stopping = false; // stop() closed stdin and armed the grace kill
    this.exitAwaited = false; // awaitExit: it exits by itself; nothing more is written
    this.killing = false; // inside child.kill (it can emit 'error' synchronously)
    this.killAttempts = 0;
    this.distrusted = false; // a protocol fault: its output is ignored
    this.stdinEnded = false;
    // shutdown | mismatch | protocol | transport | handshake_timeout | spawn | hang |
    // start_failed
    this.cause = null;
    this.exitCode = null;
    this.exitSignal = null;
  }
}

class ServiceClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.service - the process: `label` (its log prefix,
   *   e.g. `[Core]`), `noun` (how texts name it, e.g. `core`),
   *   `unavailableCode` (its unavailability's error code), `helloMethod`
   *   and `helloParams(client)` (its handshake), `validHello(result)` (the
   *   public part of a valid hello result, or null), `protocol` (its
   *   protocol version, to tell a mismatch), `shutdownMethod`,
   *   `shutdownGraceMs` (how long after it the process is killed; 3 s),
   *   `fragments(hello)` (whether it takes main's fragmented replies), and
   *   for a stream service `streams(hello)` (whether the handshake granted
   *   `stream`), `initialKinds` (the frame kinds before it: `JSON_KINDS`;
   *   the core's are `CORE_KINDS`) and `maxPending` (512); for the core at
   *   protocol 2, `duplex(hello)` (whether the connection carries streams
   *   both ways, design 0009); for a two-way service (design 0014, COL-3)
   *   also `duplexKinds` (the frame kinds from the hello on; the core's
   *   `CORE_STREAM_KINDS` by default, which must take streams both ways)
   *   and `duplexTakes` (the abort codes the process's bodies may end
   *   with; the core's `CORE_BODY_ABORT_CODES` by default): a service
   *   spreads `SERVICE_DUPLEX`. `eventsUntilClose`: the process's events
   *   are delivered after its exit too, until its pipe closes (design
   *   0014, The step marker), not only while it lives. `idleMethod(method)`:
   *   whether a method has no total deadline, only idle bounds, so it is
   *   sent only with `idleWatchdogMs` (the core's, design 0015, D5).
   *   `headOpens(method)`: whether a stream request's head opens its body
   *   whatever it says, with no `body: true` (the core's `swarm.body`,
   *   whose head is `{ bytes }`, design 0015)
   * @param {Function} options.spawn - child_process.spawn (injectable)
   * @param {string} options.command - path to the binary
   * @param {string[]} options.args - e.g. ['serve', '--data-dir', …]
   * @param {object} [options.log] - { info, warn, error }
   * @param {string} [options.shellVersion]
   * @param {Function} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   * @param {number} [options.poolBytes] - main's chain I/O pool (a test seam)
   * @param {Function} [options.beforeSpawn] - () => null, or why the process
   *   may not be spawned now: checked before every spawn, restarts
   *   included. A refusal spawns nothing and fails the client.
   * @param {Function} [options.deferSpawn] - () => null, or a promise the
   *   spawn waits for: asked before every spawn, restarts included, before
   *   `beforeSpawn`, and again each time a wait ends. While it waits nothing
   *   runs, the client stays `starting` with its waiters, and nothing counts
   *   as a crash. A stop ends the wait: nothing is spawned when it settles.
   *   A wait that rejects, or a call that throws, fails the client.
   * @param {Function} [options.env] - () => the process's environment, for
   *   each spawn; the scrubbed one (`scrubbedEnv`) by default. It may
   *   throw, which fails that spawn as a spawn error.
   * @param {boolean} [options.restart] - false: the owner restarts the
   *   process itself (design 0014, Crashes: its own lazy back-off). An exit
   *   the client would restart after leaves it `stopped` instead, with no
   *   timer armed and no crash counted, and fails whoever waits for it to
   *   be ready; `start()` spawns again. The exits that fail the client
   *   (a protocol mismatch, a start step's error, the exit codes that
   *   mean "don't retry") still fail it. True by default.
   * @param {Function} [options.afterSpawn] - (child) => anything, once
   *   each process is spawned, before its handshake is sent (design 0014,
   *   Spawn: its scheduling priority). Only for a child that has a PID:
   *   `os.setPriority` without one would set main's own. A throw is logged,
   *   and the process goes on.
   */
  constructor(options) {
    super();
    this.service = options.service;
    this.label = options.service.label;
    if (options.service.duplexKinds && options.service.duplexKinds.streams !== 'both') {
      throw new TypeError('A duplex takes stream frames both ways');
    }
    // Requests outstanding per process: the core's 256; a stream service's
    // 512, retiring ones included (design 0007, Bounds).
    this.maxPending = options.service.maxPending ?? MAX_PENDING;
    this.spawnFn = options.spawn;
    this.beforeSpawn = options.beforeSpawn ?? null;
    this.deferSpawn = options.deferSpawn ?? null;
    this.afterSpawn = options.afterSpawn ?? null;
    this.restart = options.restart ?? true;
    this.env = options.env ?? scrubbedEnv;
    this.command = options.command;
    this.args = options.args;
    this.log = options.log || console;
    this.shellVersion = options.shellVersion || 'unknown';
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    // One pool for every process this client runs: what a retired
    // one held is released with it.
    this.pool = new IoPool(options.poolBytes ?? POOL_BYTES);

    this.state = STATE.STOPPED;
    this.generations = 0;
    this.current = null; // the live or draining Generation, if any
    this.hello = null;
    this.stopRequested = false;
    this.crashTimes = [];
    this.restartTimer = null;
    // The deferred spawn's wait in progress (`deferSpawn`), or null.
    this.spawnWait = null;
    this.readyWaiters = [];
    this.stopWaiters = [];
    // Requests waiting for readiness, and their serialized parameter bytes.
    this.waitingRequests = 0;
    this.waitingBytes = 0;
    // Handlers for the process's requests, by method; and those that take only
    // the requests whose params they accept, tried first.
    this.handlers = new Map();
    this.shapedHandlers = new Map();
    // Those that may answer with a body (`StreamedReply`).
    this.streamHandlers = new WeakSet();
    // The abort codes their bodies end with, where not a piece's (`sends`).
    this.streamSends = new WeakMap();
    // Those with a pool of their own, a failure result, or that race their
    // signal (`handle`).
    this.handlerOptions = new WeakMap();
  }

  /**
   * Registers the handler for the process's requests named `method`. It is
   * called with (params, { signal, charge }) and returns the result (or a
   * promise of it); a ShellError is the terminal error reply. `signal`
   * aborts when the process cancels the request or its generation ends; the
   * handler still settles, and exactly one reply goes back. `charge(bytes)`
   * charges what the handler holds for its reply to main's pool, until the
   * reply is serialized: false, and nothing charged, past the pool.
   *
   * The process's naming and chain threads share method names (`shell.rpc`,
   * `shell.verified`), and tell their requests apart by their params. A
   * handler registered with `when(params)` takes the requests it accepts,
   * before the one registered without, which takes the rest.
   *
   * With `streams: true`, on the core's connection at protocol 2 (design
   * 0009) or a two-way service's (design 0014, `SERVICE_DUPLEX`), the
   * handler may answer with a `StreamedReply`, and is called with
   * `streams: true` there; its requests' replies, cancels and bodies
   * go through the duplex. Elsewhere `streams` is false, and a
   * `StreamedReply` is an internal error. `sends` is the set of abort codes
   * its bodies may end with, a piece's by default: design 0015's
   * `SWARM_PIECE_ABORT_CODES` for `shell.swarm_api`, which take
   * `too_large`, and `SWARM_PART_ABORT_CODES` for `shell.swarm_part`, whose
   * `body_stream_error` may name an error code (`StreamedReply`). Like
   * `streams`, it is the handler's: one function registered for two
   * methods has one set.
   *
   * Every handler is called as `handler(params, { id, signal, charge,
   * shrink, onRelease, onAnswer, abortStream, streams, generation, private,
   * privateSession })`: `id` is the process's ID for the request (which
   * main's own requests about it name: design 0015's `swarm.body { for }`);
   * `shrink(bytes)` gives back all it charged but `bytes`; `onRelease(fn)`
   * runs `fn` once everything it charged is released (`leaseOf`);
   * `onAnswer(fn)` runs `fn` once its answer is handed to the pipe, ahead
   * of any later frame of main's (`onAnswer`); `abortStream(err)` ends the
   * stream its reply opened as its body's failure `err` would, what the
   * sender still holds of it included (`abortStream`); `generation` is the
   * number of the process that asked, as `onSent` (requestTo) reports it
   * for main's own requests. `private` is whether the request may serve a
   * private window, and `privateSession` the private session it would
   * serve, or null when that can't be told (`privacyOf`, from the requests
   * of main's it names).
   *
   * For design 0015's Swarm handlers, whose answers the core reads
   * strictly:
   * - `pool`: the pool its charges go to (`take(bytes)`, `release(bytes)`:
   *   the Swarm I/O pool, swarm-io-pool.js), never the chain I/O pool. They
   *   are held until the reply's last byte is written, a streamed reply's
   *   until its terminal, or until the reply is dropped; `shrink(bytes)`
   *   gives back all of them but `bytes` (a body read short of its cap). A
   *   reply of POOL_EXEMPT_BYTES or more is charged there for whatever of
   *   it the handler didn't charge, and is `busy` past it.
   * - `failure(code)`: the result its failures answer with, a throw's
   *   (`code` `internal`), another ShellError's (its code) and main's own
   *   (`busy`, `too_large`, `internal`): `{ failed: "error" }`, never an
   *   error the core can't take. Only `cancelled`, once the signal aborted,
   *   and a refusal that carries its rule (a ShellError `invalid_argument`
   *   whose data is exactly `{ rule }`, one of REFUSAL_RULES) still go as
   *   errors.
   * - `race`: the process's cancel is answered `cancelled` at once, without
   *   waiting for the handler (on the duplex its sender answers it so
   *   anyway); the handler's outcome is dropped once it settles, and its
   *   charges go then.
   */
  handle(
    method,
    handler,
    { when = null, streams = false, sends = null, pool = null, failure = null, race = false } = {}
  ) {
    if (sends && !streams) throw new TypeError('Only a streams handler sends bodies');
    if (streams) this.streamHandlers.add(handler);
    if (sends) this.streamSends.set(handler, sends);
    if (pool || failure || race) this.handlerOptions.set(handler, { pool, failure, race });
    if (!when) {
      this.handlers.set(method, handler);
      return;
    }
    const shaped = this.shapedHandlers.get(method) || [];
    shaped.push({ when, handler });
    this.shapedHandlers.set(method, shaped);
  }

  /** The handler for one of the process's requests, or undefined. */
  handlerFor(method, params) {
    const shaped = this.shapedHandlers.get(method)?.find((route) => route.when(params));
    return shaped ? shaped.handler : this.handlers.get(method);
  }

  /** The error a request gets when the process can't take it. */
  unavailable(message = `The ${this.service.noun} is not running`) {
    return new CoreError(this.service.unavailableCode, message);
  }

  /** Spawns the process and completes the handshake. */
  start() {
    if (this.state === STATE.STOPPING) {
      return Promise.reject(this.unavailable(`The ${this.service.noun} is stopping`));
    }
    if (this.state === STATE.STOPPED || this.state === STATE.FAILED) {
      this.stopRequested = false;
      this.crashTimes = [];
      this.spawnGeneration();
    }
    return this.whenReady();
  }

  /**
   * Sends a request and resolves with its result.
   * @param {string} method
   * @param {object} [params]
   * @param {object} [context] - { caller: 'chrome' | 'shell', page? }
   * @param {object} [options]
   * @param {number|null} [options.watchdogMs] - the request's hang watchdog
   *   (see requestTo), from when it is sent; none if null
   * @param {number|null} [options.idleWatchdogMs] - an idle method's
   *   watchdog instead (see requestTo)
   * @param {number|null} [options.deviceWatchdogMs] - a device request's
   *   resettable watchdog instead (see requestTo)
   * @param {object|null} [options.pool] - the pool its response is
   *   charged to; it then resolves with `{ result, release }` (see
   *   requestTo)
   * @param {AbortSignal|null} [options.signal] - cancels it (see requestTo)
   * @param {Function|null} [options.onSent] - `(id, generation)` once it is
   *   written (see requestTo)
   * @param {Function|null} [options.requires] - `(hello) => boolean`, the
   *   process the request may go to, checked against the hello of the one
   *   it is written to as it is written (see requestTo). One waiting for
   *   readiness is checked against the next process's hello, never the one
   *   that exited.
   */
  async request(
    method,
    params = {},
    context = { caller: 'chrome' },
    {
      watchdogMs = null,
      idleWatchdogMs = null,
      deviceWatchdogMs = null,
      pool = null,
      signal = null,
      onSent = null,
      requires = null,
    } = {}
  ) {
    if (this.state !== STATE.READY) {
      // Requests waiting for readiness are bounded like those in flight:
      // by count, and by the size of the whole request as it will be framed
      // (method, params and context, with the largest possible ID).
      let size;
      try {
        const request = { type: 'request', id: MAX_ID, method, params, context };
        size = Buffer.byteLength(JSON.stringify(request), 'utf8');
      } catch {
        throw new CoreError('invalid_argument', 'Request is not serializable');
      }
      if (size > MAX_PAYLOAD) throw new CoreError('invalid_argument', 'Request too large');
      if (this.waitingRequests >= MAX_PENDING || this.waitingBytes + size > MAX_WRITE_BYTES) {
        throw new CoreError('busy', `Too many requests waiting for the ${this.service.noun}`);
      }
      this.waitingRequests += 1;
      this.waitingBytes += size;
      try {
        await this.whenReady();
      } finally {
        this.waitingRequests -= 1;
        this.waitingBytes -= size;
      }
    }
    return this.send(this.current, method, params, context, {
      watchdogMs,
      idleWatchdogMs,
      deviceWatchdogMs,
      pool,
      signal,
      onSent,
      requires,
    });
  }

  /**
   * Holds the hang watchdog of main's request `id` to process `generation`
   * (the number `onSent` reported) while main answers one of the process's
   * own requests for it: freedom-core design 0012's `Steps` class, whose
   * request has no overall deadline while one of its prompts is open
   * (`eip1193.request`'s `approval.request`). The watchdog counts only the
   * time outside its holds: held, it stops with what it had left, and once
   * every hold is released it runs on with that. Returns the release, which
   * does nothing a second time; a request that isn't pending, or has no
   * watchdog, holds nothing.
   * @param {number} generation
   * @param {number} id
   * @returns {() => void}
   */
  holdWatchdog(generation, id) {
    const gen = this.current;
    const entry = gen && gen.number === generation ? gen.pending.get(id) : undefined;
    return entry?.watchdog ? entry.watchdog.hold() : () => {};
  }

  /**
   * Progress of main's idle request `id` to process `generation` (the
   * number `onSent` reported), which the client can't see itself: one of
   * the process's requests naming it, or a frame of another stream it
   * waits on (design 0015, D13; core-deadlines.js `idleWatchdogMs` gives
   * each kind's bound). Its watchdog's deadline becomes the later of what
   * it was and now + `boundMs`. Returns whether it had one: a request that
   * has ended, or has no idle watchdog, has nothing to move.
   * @param {number} generation
   * @param {number} id
   * @param {number} boundMs
   * @returns {boolean}
   */
  watchdogProgress(generation, id, boundMs) {
    if (!Number.isSafeInteger(boundMs) || boundMs <= 0) {
      throw new TypeError('A watchdog bound is a positive number of ms');
    }
    const gen = this.current;
    const dog = gen && gen.number === generation ? gen.idleWatchdogs.get(id) : undefined;
    if (!dog) return false;
    dog.deadline = Math.max(dog.deadline, this.now() + boundMs);
    return true;
  }

  /**
   * Sets the deadline of main's device request `id` to process
   * `generation` (the number `onSent` reported) to now + `ms`, earlier or
   * later than it was (freedom-core design 0016, "The device lane"): one
   * of the process's `shell.ledger_apdu` naming it, or main's answer to
   * one, gives it that APDU's `deadline_ms` plus the margin
   * (core-deadlines.js `apduWatchdogMs`). Returns whether it had one: a
   * request that has ended, or has no device watchdog, has nothing to set.
   * @param {number} generation
   * @param {number} id
   * @param {number} ms
   * @returns {boolean}
   */
  watchdogReset(generation, id, ms) {
    if (!Number.isSafeInteger(ms) || ms <= 0) {
      throw new TypeError('A watchdog bound is a positive number of ms');
    }
    const gen = this.current;
    const entry = gen && gen.number === generation ? gen.pending.get(id) : undefined;
    return entry?.deviceWatchdog ? entry.deviceWatchdog.reset(ms) : false;
  }

  /**
   * Sends a request to one process, the ready one `gen` names (the
   * client's `current` when it emitted 'ready'), without waiting: once that
   * process has ended it fails `unavailable`, so it never reaches another.
   * `watchdogMs` is the request's hang watchdog: the process's deadline for it
   * plus 15 s.
   *
   * `idleWatchdogMs` is an idle method's instead (design 0015, D13): it
   * has no total deadline, so the watchdog fires `idleWatchdogMs` after
   * the request is sent unless progress moves it on (`watchdogProgress`),
   * and nothing holds it. For a stream request it runs on past the head to
   * the body's terminal, and the process's head, data and terminal and
   * main's credit for that body move it on by `idleWatchdogMs` themselves.
   * A service's idle method (`service.idleMethod`) goes only with it, and
   * no other method takes it: either way round, nothing is sent and the
   * request fails `invalid_argument`.
   *
   * `deviceWatchdogMs` is a device request's instead (freedom-core design
   * 0016, "The device lane"; core-deadlines.js `deviceWatchdogMs`): the
   * watchdog fires `deviceWatchdogMs` after the request is sent unless
   * `watchdogReset` sets its deadline again, earlier or later, and nothing
   * holds it. It ends at the response, a cancelled request's included, as
   * the hang watchdog does. It goes alone, never with another watchdog, and
   * never for an idle method: nothing is sent otherwise, and the request
   * fails `invalid_argument`.
   *
   * `pool` charges the request's response (design 0015, Results for
   * pages): a fragmented one twice the size its begin declares, before its
   * buffer is made; a whole one of POOL_EXEMPT_BYTES or more twice its
   * payload's length as it is decoded, before anything holds it past its
   * frame (a smaller one is charged nothing). One main can't charge is
   * never held: the caller gets `busy` at once, and the response is let go
   * of (a fragmented one read to its end with no buffer, its credit
   * returned), the request ended as a response ends it. The request then
   * resolves with `{ result, release }`: the charge is held until the
   * caller calls `release()` (once; again does nothing), once it has
   * handed the result on (page-requests, once the page has it), and from
   * then on it is the caller's: the generation's end doesn't release it.
   * An error releases it as it is answered, as does a result the caller no
   * longer waits for (its signal answered it `cancelled`).
   *
   * `signal` cancels it (0001's `cancel`): the caller gets `cancelled` at
   * once and the process is told, unless its response came first. A signal
   * already aborted sends nothing. With `untilResponse`, the process is told
   * and the caller still gets its one response: a broadcast's is its
   * outcome, which a cancel doesn't make unknown (design 0005,
   * Cancellation).
   *
   * `fence()` is the caller's last word: it runs once the request is
   * encoded and the signal checked, with nothing between it and the ID
   * being taken and the frame written. False sends nothing, and the
   * request fails `fenced`. `params` may be a JsonParams, already
   * serialized, so no caller code runs while the request is encoded.
   *
   * `onSent(id, generation)` runs once the frame is written, before
   * anything the process sends is read: the request's envelope ID and the
   * generation's number, which the process's own requests about this one
   * name (design 0009, `shell.dweb_get`'s `for`). It must not throw.
   *
   * `requires(hello)` is what the process must be for the request: it runs
   * with the hello of the very process the frame is written to, in the same
   * synchronous run as the write, so a request can't pass on one process's
   * hello and go to another's (the client's own `hello` is the exited
   * process's until it is retired). Anything but true, or a throw, sends
   * nothing, and the request fails `requirement_unmet`. A request is never
   * written again to another process: one cut off by an exit fails
   * unavailable.
   *
   * `endsOnError` marks a start step (freedom-core design 0008, Errors):
   * the process answers its error and then exits 0. Once the process has
   * answered it with an error, the generation is ending: main sends it
   * nothing more, closes its stdin, and kills it after the service's
   * shutdown grace if it hasn't exited; and its exit 0 then is no crash, so
   * the client fails without a restart (`startStepFailed`).
   */
  requestTo(
    gen,
    method,
    params = {},
    context = { caller: 'chrome' },
    {
      watchdogMs = null,
      idleWatchdogMs = null,
      deviceWatchdogMs = null,
      pool = null,
      signal = null,
      untilResponse = false,
      fence = null,
      onSent = null,
      endsOnError = false,
      requires = null,
    } = {}
  ) {
    if (!this.serves(gen)) return Promise.reject(this.unavailable());
    return this.send(gen, method, params, context, {
      watchdogMs,
      idleWatchdogMs,
      deviceWatchdogMs,
      pool,
      signal,
      untilResponse,
      fence,
      onSent,
      endsOnError,
      requires,
    });
  }

  /** Whether `gen` is the process requests go to now: the current one,
   * past its handshake, and neither exited, ending, retired nor awaited to
   * exit (`awaitExit`). */
  serves(gen) {
    return Boolean(
      gen?.ready &&
      gen === this.current &&
      !gen.exited &&
      !gen.retired &&
      !gen.ending &&
      !gen.exitAwaited &&
      !gen.stdinEnded
    );
  }

  /**
   * Graceful shutdown: the shutdown method (if the handshake completed), close
   * stdin, SIGKILL after the service's grace (3 s). Resolves once the child
   * is gone.
   */
  stop() {
    this.stopRequested = true;
    // A deferred spawn's wait ends: nothing is spawned when it settles.
    this.spawnWait = null;
    if (this.restartTimer) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.rejectReadyWaiters(`The ${this.service.noun} is stopping`);
    const gen = this.current;
    if (!gen) {
      this.state = STATE.STOPPED;
      return Promise.resolve();
    }
    this.state = STATE.STOPPING;
    const stopped = new Promise((resolve) => this.stopWaiters.push(resolve));
    // Also for a generation already ending after a fault: stdin is closed
    // once and the grace kill is armed.
    this.fence(gen);
    if (!gen.exited && !gen.stopping) {
      gen.stopping = true;
      gen.cause = gen.cause || 'shutdown';
      const shutdown = gen.ready && !gen.ending;
      gen.ending = true;
      if (shutdown) {
        this.send(
          gen,
          this.service.shutdownMethod,
          {},
          { caller: 'shell' },
          { control: true, onReply: () => {} }
        );
      }
      this.endStdin(gen);
      this.timer(gen, () => this.kill(gen), this.service.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
    }
    return stopped;
  }

  /**
   * Waits for the process to exit by itself, as one that has done its one
   * job does (design 0014, Spawn: the checkpoint process serves one
   * `colibri.checkpoint`, then exits 0). Nothing more is written to it:
   * main's requests fail unavailable, and its own are served no more. Its
   * exit is a stop main asked for: no warn, no restart, nothing that fails
   * the client, which is left stopped; the `exit` event reports it as it
   * was (its code, signal and cause). Resolves once the process is gone, as
   * `stop()` does, and with any `stop()` called meanwhile. One still running
   * after `graceMs` is stopped (`stop()`: the shutdown method, stdin closed,
   * killed after the service's grace). Without a process past its
   * handshake, it is `stop()`.
   * @param {object} options
   * @param {number} options.graceMs - how long the process has to exit
   * @returns {Promise<void>}
   */
  awaitExit({ graceMs } = {}) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      return Promise.reject(new TypeError('awaitExit needs its grace (graceMs)'));
    }
    const gen = this.current;
    if (!gen?.ready || gen.retired || this.stopRequested) return this.stop();
    this.stopRequested = true;
    this.state = STATE.STOPPING;
    gen.exitAwaited = true;
    // Its own requests are served no more, and no reply goes for them.
    this.fence(gen);
    const gone = new Promise((resolve) => this.stopWaiters.push(resolve));
    if (!gen.exited) this.timer(gen, () => this.stop(), graceMs);
    return gone;
  }

  /**
   * Ends the process because its owner no longer trusts it (design 0014,
   * The step marker: a forged or out-of-order marker; Cancel and
   * deadlines: a step past its request's deadline): `cause` is recorded,
   * as the `exit` event's, and the process is killed. Nothing more is
   * sent to it, and its own requests are dropped; what it wrote before
   * the kill is still read, its replies (and with `eventsUntilClose` its
   * events) until its pipe closes. Its exit is then judged as any other:
   * a crash, or with `restart: false` a stop.
   *
   * With `generation` (the number `onSent` reported), only that process:
   * a later one is left alone. Returns whether this call ended a process:
   * not when none is running, it has exited already, it is ending already
   * (an earlier abandon's kill, or a `stop()` under way: that cause
   * stands), or it isn't `generation`.
   * @param {string} cause - a fixed name (lower case, digits and `_`),
   *   safe to log
   * @param {object} [options]
   * @param {number|null} [options.generation]
   * @returns {boolean}
   */
  abandon(cause, { generation = null } = {}) {
    if (typeof cause !== 'string' || !ABANDON_CAUSE.test(cause)) {
      throw new TypeError('abandon needs a fixed cause');
    }
    const gen = this.current;
    if (!gen || gen.exited || gen.retired || gen.ending) return false;
    if (generation !== null && gen.number !== generation) return false;
    this.log.warn(`${this.label} abandoned`, { cause });
    this.end(gen, cause);
    return true;
  }

  whenReady() {
    if (this.state === STATE.READY) return Promise.resolve(this.hello);
    if (this.state !== STATE.STARTING) return Promise.reject(this.unavailable());
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  /** Whether the client waits to spawn (`deferSpawn`), with nothing running. */
  get spawnDeferred() {
    return this.spawnWait !== null;
  }

  // ---- generations ----

  spawnGeneration() {
    if (this.deferSpawn && this.waitToSpawn()) return;
    // The caller's last word before each spawn, a restart's too (design
    // 0010, step 7: main's check of a service's grant).
    let refused;
    try {
      refused = this.beforeSpawn?.() ?? null;
    } catch (err) {
      refused = `the check before the spawn failed: ${err?.code || err?.name || 'error'}`;
    }
    if (refused) {
      this.current = null;
      this.fail('spawn refused');
      return;
    }
    this.generations += 1;
    const gen = new Generation(this.generations, this.service.initialKinds ?? CORE_KINDS);
    this.current = gen;
    this.state = STATE.STARTING;
    let child;
    try {
      child = this.spawnFn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env(),
        windowsHide: true,
      });
    } catch {
      this.log.error(`${this.label} spawn failed`);
      gen.cause = 'spawn';
      gen.exited = true;
      this.retire(gen);
      return;
    }
    gen.child = child;

    child.stdout.on('data', (chunk) => this.onStdout(gen, chunk));
    child.stdout.on('end', () => this.onStdoutEnd(gen));
    child.stderr.on('data', (chunk) => {
      try {
        this.onStderr(gen, chunk);
      } catch {
        // Malformed log input never escapes the data handler.
      }
    });
    for (const name of ['stdin', 'stdout', 'stderr']) {
      child[name].on('error', () => this.connectionFailed(gen, `${name}_error`));
    }
    child.on('error', () => this.onChildError(gen));
    child.on('exit', (code, signal) => this.onChildExit(gen, code, signal));
    child.on('close', () => this.retire(gen));
    this.runAfterSpawn(child);

    gen.helloTimer = this.timer(
      gen,
      () => {
        if (gen.ready || gen.exited) return;
        this.log.error(`${this.label} no ${this.service.helloMethod} reply within 10 s`);
        this.end(gen, 'handshake_timeout');
      },
      HELLO_TIMEOUT_MS
    );
    this.send(
      gen,
      this.service.helloMethod,
      this.service.helloParams(this),
      { caller: 'shell' },
      { control: true, onReply: (outcome) => this.onHelloReply(gen, outcome) }
    );
  }

  /**
   * The owner's step once a process is spawned (`afterSpawn`), for a child
   * with a PID only: a spawn that failed has none, and `os.setPriority`
   * given none would lower main's own priority. A throw is logged, with no
   * text of its own, and the process goes on.
   */
  runAfterSpawn(child) {
    if (!this.afterSpawn || !Number.isSafeInteger(child.pid) || child.pid < 1) return;
    try {
      this.afterSpawn(child);
    } catch {
      this.log.warn(`${this.label} the step after the spawn failed`);
    }
  }

  /**
   * The deferred spawn (`deferSpawn`): true while the spawn waits, the
   * client `starting` with nothing running, or once the client has failed;
   * false to spawn now. A wait that ends asks again, so the spawn waits as
   * long as the caller says.
   */
  waitToSpawn() {
    let wait;
    try {
      wait = this.deferSpawn();
    } catch {
      this.current = null;
      this.fail('spawn deferral failed');
      return true;
    }
    if (!wait || typeof wait.then !== 'function') return false;
    const waiting = {};
    this.spawnWait = waiting;
    this.current = null;
    this.state = STATE.STARTING;
    const resume = (ended) => {
      // A stop, or a later start's own wait, took over.
      if (this.spawnWait !== waiting) return;
      this.spawnWait = null;
      if (this.stopRequested) return;
      if (ended) this.spawnGeneration();
      else this.fail('spawn wait failed');
    };
    Promise.resolve(wait).then(
      () => resume(true),
      () => resume(false)
    );
    return true;
  }

  onHelloReply(gen, outcome) {
    if (gen.exited || gen.retired || gen.ending) return;
    if (outcome.error) {
      if (outcome.error.code === 'protocol_mismatch') {
        this.log.error(`${this.label} protocol mismatch`);
        this.end(gen, 'mismatch');
      } else {
        const { code } = outcome.error;
        this.log.error(`${this.label} handshake refused`, {
          code: KNOWN_ERROR_CODES.has(code) ? code : 'unknown',
        });
        this.end(gen, 'protocol');
      }
      return;
    }
    const hello = this.service.validHello(outcome.result);
    if (!hello) {
      const result = outcome.result;
      const mismatch =
        isObject(result) &&
        Number.isInteger(result.protocol) &&
        result.protocol !== this.service.protocol;
      this.log.error(
        mismatch
          ? `${this.label} protocol mismatch`
          : `${this.label} invalid ${this.service.helloMethod} result`
      );
      this.end(gen, mismatch ? 'mismatch' : 'protocol');
      return;
    }
    this.cancelTimer(gen, gen.helloTimer);
    // A process that offers fragments takes main's fragmented replies, and
    // the handshake grants main its credit.
    gen.fragments = this.service.fragments(hello);
    gen.credit = gen.fragments;
    // The core at protocol 2 (design 0009), or a two-way service (design
    // 0014, COL-3: its own kinds and codes, `SERVICE_DUPLEX`): stream frames
    // both ways from here on. A process whose handshake granted `stream`
    // (design 0007): its stream frames are taken from here on.
    if (this.service.duplex?.(hello)) {
      const takes = this.service.duplexTakes;
      gen.duplex = new StreamDuplex({
        takes: takes ?? CORE_BODY_ABORT_CODES,
        allTakes: takes ? [takes] : CORE_TAKES,
      });
      gen.streams = gen.duplex.receiver;
      gen.outbox = gen.duplex.outbox;
      gen.decoder.setKinds(this.service.duplexKinds ?? CORE_STREAM_KINDS);
    } else if (this.service.streams?.(hello)) {
      gen.streams = new StreamReceiver();
      gen.outbox = new StreamOutbox();
      gen.decoder.setKinds(serviceKinds('receiver'));
    }
    if (this.stopRequested || gen !== this.current) return;
    gen.ready = true;
    gen.readyAt = this.now();
    gen.hello = hello;
    this.hello = hello;
    this.state = STATE.READY;
    this.emit('ready', hello);
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve(hello);
  }

  /** The process exited. Its stdout may still hold final replies. */
  onChildExit(gen, code, signal) {
    if (gen.exited || gen.retired) return;
    gen.exited = true;
    this.fence(gen);
    gen.exitCode = code;
    gen.exitSignal = signal;
    this.cancelTimer(gen, gen.helloTimer);
    if (this.state === STATE.READY && gen === this.current) this.state = STATE.STARTING;
    // Normally 'close' follows once stdio is closed; don't wait forever.
    this.timer(gen, () => this.retire(gen), DRAIN_MS);
  }

  /**
   * A ChildProcess 'error': the spawn failed (no pid; the process never
   * existed), or a signal couldn't be delivered (the process may live on, so
   * nothing is released until it actually exits).
   */
  onChildError(gen) {
    if (gen.retired) return;
    if (gen.child && gen.child.pid === undefined) {
      this.log.error(`${this.label} spawn failed`);
      gen.cause = gen.cause || 'spawn';
      gen.exited = true;
      this.retire(gen);
      return;
    }
    if (gen.exited) return;
    this.log.error(`${this.label} child process error`);
    if (gen.killing) {
      // The SIGKILL itself failed (emitted synchronously from child.kill):
      // retry on a timer, a bounded number of times, never recursively.
      if (gen.killAttempts < MAX_KILL_ATTEMPTS) {
        this.timer(gen, () => this.kill(gen), KILL_RETRY_MS);
      }
      return;
    }
    this.end(gen, 'transport');
  }

  /**
   * Final: stdio is closed (or the drain timed out). Rejects what is still
   * pending, then decides between stopped, failed and a restart.
   */
  retire(gen) {
    if (gen.retired) return;
    gen.retired = true;
    gen.exited = true;
    for (const timer of gen.timers) this.clearTimer(timer);
    gen.timers.clear();
    this.teardown(gen);
    // A response cut short by EOF is discarded with its reservation.
    gen.reassembler.discard();
    // The process's requests die with it: their handlers stop, and their
    // replies have nowhere to go.
    this.fence(gen);
    // Writes its stdio held may never report back: what they held goes now.
    for (const release of [...gen.charges]) release();
    // Open bodies end with it, and every stream record and ring goes.
    this.failBodies(gen, this.unavailable(`The ${this.service.noun} exited`));
    gen.streams = null;
    gen.outbox = null;
    gen.duplex = null;
    const pending = [...gen.pending.values()];
    gen.pending.clear();
    for (const entry of pending) {
      entry.settle({ error: this.unavailable(`The ${this.service.noun} exited`) });
    }
    if (gen !== this.current) return;
    this.current = null;
    this.hello = null;
    const code = gen.exitCode;
    // Why the exit fails the client, if it does.
    let failure = null;
    if (gen.cause === 'mismatch') {
      failure = 'protocol mismatch';
    } else if (gen.stepFailed && code === 0) {
      // The end a start step's error announced (0008, Errors): main read
      // the error, and the process exited as it said it would.
      failure = 'start step failed';
    } else if (code !== null && NO_RESTART_EXIT_CODES.has(code)) {
      failure = `exit code ${code}`;
    }
    // The owner restarts it (`restart: false`): an exit the client would
    // restart after leaves it stopped, before the owner hears of it, so the
    // owner's listener may start it again at once; and whoever waited for
    // the process that is gone is failed, not left waiting for one that
    // won't come.
    const ownerRestarts = !this.restart && !this.stopRequested && failure === null;
    if (ownerRestarts) {
      this.state = STATE.STOPPED;
      this.rejectReadyWaiters(`The ${this.service.noun} exited`);
    }
    this.emit('exit', { code, signal: gen.exitSignal, cause: gen.cause });

    if (this.stopRequested) {
      this.state = STATE.STOPPED;
      for (const resolve of this.stopWaiters.splice(0)) resolve();
      return;
    }
    if (failure !== null) {
      this.fail(failure);
      return;
    }
    if (ownerRestarts) {
      // Nothing armed, and no crash counted: the back-off is the owner's.
      this.log.warn(`${this.label} exited`, { code, signal: gen.exitSignal, cause: gen.cause });
      return;
    }
    const delay = this.recordCrash();
    if (delay === null) {
      this.fail('three crashes within a minute');
      return;
    }
    this.log.warn(`${this.label} exited; restarting`, {
      code,
      signal: gen.exitSignal,
      cause: gen.cause,
      delay_ms: delay,
    });
    this.state = STATE.STARTING;
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      if (!this.stopRequested) this.spawnGeneration();
    }, delay);
  }

  /**
   * Counts a crash now: the back-off before the next try (0.5 s, 2 s, then
   * 10 s), or null for the third within 60 s, when the restarts stop. A
   * process's exit counts, and so does whatever its service counts as one
   * (design 0007: an instance retired after a request panic).
   */
  recordCrash() {
    const now = this.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    if (this.crashTimes.length >= MAX_CRASHES_IN_WINDOW) return null;
    return RESTART_DELAYS_MS[Math.min(this.crashTimes.length - 1, RESTART_DELAYS_MS.length - 1)];
  }

  fail(reason) {
    this.log.error(`${this.label} giving up`, { reason });
    this.state = STATE.FAILED;
    this.emit('failed', reason);
    this.rejectReadyWaiters(reason);
  }

  rejectReadyWaiters(reason) {
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(this.unavailable(reason));
  }

  /**
   * A start step's error (`endsOnError`) from the process: it ends after
   * answering (0008, Errors), so the generation is ending. Main sends it
   * nothing more and closes its stdin, and kills it after the service's
   * shutdown grace if it hasn't exited by then. Its exit 0 then fails the
   * client without a restart (`retire`); any other end is judged as usual.
   */
  startStepFailed(gen) {
    if (gen.retired || gen.stepFailed) return;
    gen.stepFailed = true;
    gen.cause = gen.cause || 'start_failed';
    // Gone already, its reply read from what stdout still held.
    if (gen.exited) return;
    gen.ending = true;
    this.fence(gen);
    this.endStdin(gen);
    this.timer(gen, () => this.kill(gen), this.service.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
  }

  /** Ends a generation we no longer trust: records why, then kills it. */
  end(gen, cause) {
    if (gen.retired) return;
    gen.cause = gen.cause || cause;
    gen.ending = true;
    this.fence(gen);
    this.kill(gen);
  }

  kill(gen) {
    if (gen.exited || !gen.child || gen.killing) return;
    gen.killing = true;
    gen.killAttempts += 1;
    try {
      gen.child.kill('SIGKILL');
    } catch {
      // Reported through 'error' if it matters.
    } finally {
      gen.killing = false;
    }
  }

  /**
   * Releases a retired generation: destroys its stdio (a pipe held open by
   * someone else would otherwise stay alive) and detaches its listeners,
   * keeping error sinks so teardown can't raise unhandled errors.
   */
  teardown(gen) {
    const { child } = gen;
    if (!child) return;
    const sink = () => {};
    for (const name of ['stdin', 'stdout', 'stderr']) {
      const stream = child[name];
      if (!stream) continue;
      stream.removeAllListeners();
      stream.on('error', sink);
      stream.destroy();
    }
    child.removeAllListeners();
    child.on('error', sink);
  }

  endStdin(gen) {
    if (gen.stdinEnded || !gen.child) return;
    gen.stdinEnded = true;
    try {
      gen.child.stdin.end();
    } catch {
      // Already closed.
    }
  }

  connectionFailed(gen, category) {
    if (gen.retired || gen.exited) return;
    this.log.error(`${this.label} connection failed`, { category });
    this.end(gen, 'transport');
  }

  protocolFault(gen, category) {
    if (gen.retired || gen.distrusted) return;
    gen.distrusted = true;
    this.fence(gen);
    // Nothing more of its bodies can be trusted to come.
    this.failBodies(gen, this.unavailable(`The ${this.service.noun} failed`));
    this.log.error(`${this.label} protocol error`, { category });
    this.end(gen, 'protocol');
  }

  timer(gen, fn, ms) {
    const timer = this.setTimer(() => {
      gen.timers.delete(timer);
      fn();
    }, ms);
    gen.timers.add(timer);
    return timer;
  }

  cancelTimer(gen, timer) {
    if (!timer || !gen.timers.has(timer)) return;
    gen.timers.delete(timer);
    this.clearTimer(timer);
  }

  // ---- writing ----

  /**
   * Writes one request. `control` frames (hello, shutdown) skip the
   * admission limits; `onReply` receives the outcome synchronously instead
   * of a promise; `signal` cancels it, its caller waiting for the process's
   * response with `untilResponse`; a `fence` that fails sends nothing.
   */
  send(gen, method, params, context, options) {
    const {
      control = false,
      onReply = null,
      watchdogMs = null,
      idleWatchdogMs = null,
      deviceWatchdogMs = null,
      pool = null,
      signal = null,
      untilResponse = false,
      fence = null,
      stream = false,
      onSent = null,
      endsOnError = false,
      requires = null,
      takes = null,
    } = options || {};
    // Callback-style callers get every outcome through the callback.
    const refuse = (error) => {
      if (!onReply) return Promise.reject(error);
      onReply({ error });
      return null;
    };
    // An idle method goes with its idle watchdog alone, and only it takes
    // one (design 0015, D13): main never sends one unwatched.
    const idle = this.service.idleMethod?.(method) === true;
    const idleForm = Number.isSafeInteger(idleWatchdogMs) && idleWatchdogMs > 0;
    if (
      idle ? !idleForm || watchdogMs !== null || deviceWatchdogMs !== null : idleWatchdogMs !== null
    ) {
      return refuse(
        new CoreError(
          'invalid_argument',
          idle
            ? 'An idle method is sent with its idle watchdog'
            : 'An idle watchdog is only for an idle method'
        )
      );
    }
    // A device request's watchdog (design 0016) is its only one.
    const deviceForm = Number.isSafeInteger(deviceWatchdogMs) && deviceWatchdogMs > 0;
    if (deviceWatchdogMs !== null && (!deviceForm || watchdogMs !== null)) {
      return refuse(
        new CoreError(
          'invalid_argument',
          "A device watchdog is a positive number of ms, and the request's only watchdog"
        )
      );
    }
    if (
      !gen ||
      gen.retired ||
      gen.exited ||
      gen.stdinEnded ||
      ((gen.ending || gen.exitAwaited) && !control)
    ) {
      return refuse(this.unavailable());
    }
    if (signal?.aborted) return refuse(cancelled());
    if (stream && !gen.streams) {
      return refuse(new CoreError('invalid_argument', 'The connection has no streams'));
    }
    // On a stream connection, retiring requests count too: their records
    // are kept until their terminal frame or reply.
    const outstanding = gen.streams ? gen.streams.outstanding() : gen.pending.size;
    if (!control && outstanding >= this.maxPending) {
      return refuse(new CoreError('busy', 'Too many requests in flight'));
    }
    if (gen.nextId > MAX_ID) {
      this.protocolFault(gen, 'ids_exhausted');
      return refuse(this.unavailable());
    }
    const id = gen.nextId;
    let frame;
    try {
      frame =
        params instanceof JsonParams
          ? encodeJsonFrame(
              `{"type":"request","id":${id},"method":${JSON.stringify(method)},` +
                `"params":${params.json},"context":${JSON.stringify(context)}}`
            )
          : encodeFrame({ type: 'request', id, method, params, context });
    } catch (err) {
      if (err instanceof FrameError) {
        return refuse(new CoreError('invalid_argument', 'Request too large'));
      }
      return refuse(new CoreError('invalid_argument', 'Request is not serializable'));
    }
    // Serializing ran the params' own code (a getter, a toJSON), which may
    // have aborted the signal: an abort's event isn't replayed to a listener
    // added later, so it is checked again. Cancelled before it is written,
    // the request is never sent.
    if (signal?.aborted) return refuse(cancelled());
    if (!control && gen.writeBytes + frame.length > MAX_WRITE_BYTES) {
      return refuse(new CoreError('busy', 'Too much data in flight'));
    }
    // The process this frame is written to must be what the request
    // requires: its own hello, read in this run, which writes the frame
    // without yielding (see requestTo).
    if (requires && !meets(gen, requires)) {
      return refuse(
        new CoreError(REQUIREMENT_UNMET, `The ${this.service.noun} can't take this request`)
      );
    }
    // After everything that ran the caller's code, and before anything is
    // taken or written.
    if (fence && !fence()) return refuse(new CoreError('fenced', 'Fenced'));
    gen.nextId += 1;
    // Every request main sends on a stream connection: a frame for an ID
    // above the highest is a protocol error. A body ends only with `takes`,
    // the connection's codes by default.
    if (gen.duplex) gen.duplex.ask(id, takes);
    else gen.streams?.request(id, takes);

    let promise = null;
    let entry;
    if (onReply) {
      entry = { settle: onReply };
    } else {
      promise = new Promise((resolve, reject) => {
        entry = {
          settle: (outcome) => (outcome.error ? reject(outcome.error) : resolve(outcome.result)),
        };
      });
    }
    if (stream) {
      entry.stream = true;
      entry.signal = signal;
      // A head that opens its body whatever it says (design 0015's
      // `swarm.body`, whose head is `{ bytes }`).
      entry.headOpens = this.service.headOpens?.(method) === true;
    }
    if (endsOnError) entry.endsOnError = true;
    // Sent for a private window, as its async context says, and in which
    // private session (private/private-log-context.js): see `privacyOf`.
    entry.private = isPrivateLogContext();
    entry.privateSession = entry.private ? privateContextSession() : null;
    if (signal) this.cancellable(gen, id, entry, signal, untilResponse);
    if (pool && !stream) this.chargeable(gen, entry, pool);
    if (watchdogMs !== null) {
      // The hang watchdog (design 0001): the process enforces the request's
      // deadline and always replies, so no reply by deadline + 15 s means
      // it is hung. It is killed, which fails what it holds, and restarted.
      // It counts only the time outside its holds (`holdWatchdog`).
      const settle = entry.settle;
      const dog = { left: watchdogMs, since: 0, timer: null, holds: 0, done: false };
      const arm = () => {
        dog.since = this.now();
        dog.timer = this.timer(
          gen,
          () => {
            dog.timer = null;
            if (gen.pending.get(id) !== entry) return;
            this.log.error(`${this.label} request hung; restarting the ${this.service.noun}`, {
              method,
            });
            this.end(gen, 'hang');
          },
          dog.left
        );
      };
      arm();
      entry.watchdog = {
        hold: () => {
          if (dog.done) return () => {};
          dog.holds += 1;
          if (dog.holds === 1 && dog.timer) {
            this.cancelTimer(gen, dog.timer);
            dog.timer = null;
            dog.left = Math.max(0, dog.left - (this.now() - dog.since));
          }
          let released = false;
          return () => {
            if (released) return;
            released = true;
            dog.holds -= 1;
            if (dog.holds === 0 && !dog.done) arm();
          };
        },
      };
      entry.settle = (outcome) => {
        dog.done = true;
        this.cancelTimer(gen, dog.timer);
        settle(outcome);
      };
    }
    if (deviceWatchdogMs !== null) this.deviceWatchdog(gen, id, entry, method, deviceWatchdogMs);
    gen.pending.set(id, entry);
    gen.writeBytes += frame.length;
    const written = (err) => {
      gen.writeBytes -= frame.length;
      if (err) this.connectionFailed(gen, 'stdin_error');
    };
    try {
      this.writeInOrder(gen, frame, written);
    } catch {
      gen.pending.delete(id);
      gen.writeBytes -= frame.length;
      this.connectionFailed(gen, 'stdin_error');
      entry.settle({ error: this.unavailable() });
      return promise;
    }
    if (idle) this.idleWatchdog(gen, id, method, idleWatchdogMs);
    // The request is on its way, under this ID in this generation: the
    // caller may key what the process's requests about it will name (design
    // 0009: `shell.dweb_get`'s `for`). Nothing the process sends is read
    // before this returns.
    onSent?.(id, gen.number);
    return promise;
  }

  /**
   * The device watchdog of main's request `id` (freedom-core design 0016,
   * "The device lane"): the process is hung once its deadline passes, and
   * is killed, which fails what it holds, and restarted. The deadline is
   * `ms` from now, and each `watchdogReset` sets it again, earlier or
   * later, with a timer of its own. It ends at the response, as the hang
   * watchdog does: a cancelled request's runs on until the process answers
   * it.
   */
  deviceWatchdog(gen, id, entry, method, ms) {
    const settle = entry.settle;
    const dog = { timer: null, done: false };
    const arm = (after) => {
      this.cancelTimer(gen, dog.timer);
      dog.timer = this.timer(
        gen,
        () => {
          dog.timer = null;
          if (gen.pending.get(id) !== entry) return;
          this.log.error(`${this.label} request hung; restarting the ${this.service.noun}`, {
            method,
          });
          this.end(gen, 'hang');
        },
        after
      );
    };
    arm(ms);
    entry.deviceWatchdog = {
      reset: (after) => {
        if (dog.done) return false;
        arm(after);
        return true;
      },
    };
    entry.settle = (outcome) => {
      dog.done = true;
      this.cancelTimer(gen, dog.timer);
      dog.timer = null;
      settle(outcome);
    };
  }

  /**
   * The idle watchdog of main's request `id` (design 0015, D13): the
   * process is hung once `deadline` passes with no progress moving it on,
   * and is killed, which fails what it holds, and restarted. Its timer
   * wakes at the deadline it last saw and sleeps again for the rest, so
   * progress costs no timer. It ends at the response, or at the body's
   * terminal (`idleEnded`, from `onResponse` and `onStreamFrame`).
   */
  idleWatchdog(gen, id, method, idleMs) {
    const dog = { deadline: this.now() + idleMs, idleMs };
    gen.idleWatchdogs.set(id, dog);
    const arm = () => {
      dog.timer = this.timer(
        gen,
        () => {
          if (gen.idleWatchdogs.get(id) !== dog) return;
          if (dog.deadline > this.now()) {
            arm();
            return;
          }
          gen.idleWatchdogs.delete(id);
          this.log.error(`${this.label} request hung; restarting the ${this.service.noun}`, {
            method,
          });
          this.end(gen, 'hang');
        },
        Math.max(1, dog.deadline - this.now())
      );
    };
    arm();
  }

  /** Progress of main's idle request `id` that the client sees itself: its
   * response's head, or its body's data or credit. */
  idleProgress(gen, id) {
    const dog = gen.idleWatchdogs.get(id);
    if (dog) dog.deadline = Math.max(dog.deadline, this.now() + dog.idleMs);
  }

  /** The end of main's idle request `id`: its response, or its body's
   * terminal. */
  idleEnded(gen, id) {
    const dog = gen.idleWatchdogs.get(id);
    if (!dog) return;
    gen.idleWatchdogs.delete(id);
    this.cancelTimer(gen, dog.timer);
  }

  /**
   * Charges a request's response to `pool` (`requestTo`'s `pool`; design
   * 0015, Results for pages): a fragmented one twice the size its begin
   * declares, before the buffer for it is made (`admitResponse`); a whole
   * one of POOL_EXEMPT_BYTES or more twice its payload's length as it is
   * decoded (`onResponse`). One that doesn't fit is never held: the caller
   * is answered `busy` at once, and the response is let go of
   * (`onDroppedResponse`; a fragmented one is read to its end with no
   * buffer first). Its watchdog runs on to that end, as a cancelled
   * request's does.
   *
   * The result goes to the caller with its release, `{ result, release }`,
   * and the charge is the caller's from then: held until it calls
   * `release()`, once it has handed the result on. Until then the
   * generation's retirement releases what the response holds. An error, or
   * a result its caller no longer waits for (`entry.cancelled`), releases
   * it at once.
   */
  chargeable(gen, entry, pool) {
    const settle = entry.settle;
    let answered = false;
    let held = 0;
    const release = () => {
      gen.charges.delete(release);
      pool.release(held);
      held = 0;
    };
    entry.charge = (bytes) => {
      if (pool.take(bytes)) {
        held += bytes;
        gen.charges.add(release);
        return true;
      }
      if (!answered) {
        answered = true;
        settle({ error: new CoreError('busy', 'No room for the response') });
      }
      return false;
    };
    entry.settle = (outcome) => {
      if (answered || outcome.error || entry.cancelled) {
        release();
        if (answered) return;
        answered = true;
        settle(outcome);
        return;
      }
      answered = true;
      // Handed to the caller with the charge: nothing of the generation's
      // releases it any more.
      gen.charges.delete(release);
      const charged = held;
      held = 0;
      let released = false;
      const handedOn = () => {
        if (released) return;
        released = true;
        pool.release(charged);
      };
      settle({ result: Object.freeze({ result: outcome.result, release: handedOn }) });
    };
  }

  /** A fragmented response of `bytes` to main's request `id` begins:
   * whether main holds it, its pool charged twice its size first
   * (`chargeable`). One sent without a pool is held as before. */
  admitResponse(gen, id, bytes) {
    const charge = gen.pending.get(id)?.charge;
    return charge ? charge(2 * bytes) : true;
  }

  /**
   * A response main declined (`chargeable`): a fragmented one at its begin
   * (`admitResponse`), read to its end with no buffer, or a whole one as it
   * was decoded (`whole`, `onResponse`). Its request ends as a response
   * ends it, its caller has had `busy`, and for a fragmented one the
   * process's credit goes back; a whole one took none.
   */
  onDroppedResponse(gen, id, { whole = false } = {}) {
    const entry = gen.pending.get(id);
    if (!entry) return this.protocolFault(gen, 'unsolicited_response');
    if (gen.streams) {
      try {
        if (gen.duplex) gen.duplex.answered(id, false);
        else gen.streams.reply(id, false);
      } catch (err) {
        return this.protocolFault(gen, err instanceof FrameError ? err.category : 'stream');
      }
    }
    this.idleEnded(gen, id);
    gen.pending.delete(id);
    entry.settle({ error: new CoreError('busy', 'No room for the response') });
    if (!whole && !gen.distrusted) this.returnCredit(gen);
    return undefined;
  }

  /**
   * Main's cancel (0001), once `signal` aborts: the caller gets `cancelled`
   * at once, and the process a `cancel`. The request stays pending until the
   * process's one response, which is consumed and dropped; a fragmented one
   * still returns its credit, as a delivered one does (design 0005, Main's
   * pool). A response that came first answers the caller, and nothing is
   * cancelled. `untilResponse` leaves the caller waiting for that one
   * response, which then answers it.
   */
  cancellable(gen, id, entry, signal, untilResponse = false) {
    const settle = entry.settle;
    let answered = false;
    const onAbort = () => {
      if (answered || gen.pending.get(id) !== entry) return;
      this.writeCancel(gen, id);
      if (untilResponse) return;
      answered = true;
      // The caller has its answer: a result that comes later is dropped,
      // and its pool charge with it (`chargeable`).
      entry.cancelled = true;
      settle({ error: cancelled() });
    };
    entry.settle = (outcome) => {
      signal.removeEventListener('abort', onAbort);
      if (answered) return;
      answered = true;
      settle(outcome);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  /**
   * Writes main's `cancel` for its request `id`: a control frame, one per
   * outstanding request, so it skips the requests' admission and is never
   * held back by them or by main's pool.
   */
  writeCancel(gen, id) {
    if (gen.retired || gen.exited || gen.stdinEnded || !gen.child) return;
    if (gen.streams) {
      // Through the outbox, which drops the request's unwritten credit; its
      // record retires until its reply or terminal frame.
      this.retireStream(gen, id);
      return;
    }
    try {
      this.writeInOrder(gen, encodeFrame({ type: 'cancel', id }), (err) => {
        if (err) this.connectionFailed(gen, 'stdin_error');
        else this.idleProgress(gen, id);
      });
    } catch {
      this.connectionFailed(gen, 'stdin_error');
    }
  }

  /**
   * Writes one of main's frames that the stream writer doesn't (a request,
   * a reply, a fragment's header, the bulk credit), after the stream
   * control frames main made before it (`flushControl`). Throws as
   * `stdin.write` does.
   */
  writeInOrder(gen, bytes, written) {
    this.flushControl(gen);
    gen.child.stdin.write(bytes, written);
  }

  /**
   * The stream writer keeps one write in flight, and what main makes
   * meanwhile waits in its queues: a frame written past them would reach
   * the process first (a `dweb.forget` ahead of the cancels of its
   * partition's requests). So before such a frame, the control frames
   * waiting go at once, in one write: credit and cancels, and on the
   * core's connection at protocol 2 the sender's heads, replies, aborts
   * and every `end` whose bytes have all gone (`StreamDuplex#nextControl`).
   * Data stays queued, under the writer's cap and the process's credit, as
   * does an `end` after it.
   */
  flushControl(gen) {
    if (!gen.outboxWriting || gen.distrusted) return;
    if (gen.retired || gen.exited || gen.stdinEnded || !gen.child) return;
    const frames = [];
    const wrote = [];
    if (gen.duplex) {
      for (let next = gen.duplex.nextControl(); next; next = gen.duplex.nextControl()) {
        frames.push(next.bytes);
        wrote.push(next.wrote);
        this.frameTaken(gen, next.wrote);
      }
    } else {
      for (let frame = gen.outbox.next(); frame; frame = gen.outbox.next()) frames.push(frame);
    }
    if (!frames.length) return;
    const written = (err) => {
      if (err) {
        this.connectionFailed(gen, 'stdin_error');
        return;
      }
      if (!gen.duplex) return;
      for (const entry of wrote) this.streamWritten(gen, entry);
      this.pumpPieces(gen);
      this.flushStreams(gen);
    };
    // Corked, they go together without being copied (a reply may be 1 MiB).
    const { stdin } = gen.child;
    stdin.cork();
    try {
      const last = frames.pop();
      for (const frame of frames) stdin.write(frame);
      stdin.write(last, written);
    } finally {
      stdin.uncork();
    }
  }

  // ---- reading ----

  onStdout(gen, chunk) {
    // After a protocol fault nothing more from this child is trusted.
    if (gen.retired || gen.distrusted) return;
    let frames;
    try {
      frames = gen.decoder.push(chunk);
    } catch (err) {
      this.protocolFault(gen, err instanceof FrameError ? err.category : 'decode');
      return;
    }
    for (const frame of frames) {
      if (gen.retired || gen.distrusted) return;
      if (STREAM_FRAME_KINDS.has(frame.kind)) {
        this.onStreamFrame(gen, frame);
        continue;
      }
      let delivery;
      try {
        // A begin must name a request still waiting for its response, and
        // one sent with a pool is charged before its buffer is made.
        delivery = gen.reassembler.push(
          frame,
          (id) => gen.pending.has(id),
          (id, bytes) => this.admitResponse(gen, id, bytes)
        );
      } catch (err) {
        this.protocolFault(gen, err instanceof FrameError ? err.category : 'decode');
        return;
      }
      if (!delivery) continue;
      try {
        if (delivery.type === 'message') {
          this.onMessage(gen, delivery.message, delivery.size);
        } else if (delivery.type === 'response') {
          this.onFragmentedResponse(gen, delivery.id, delivery.message);
        } else if (delivery.type === 'dropped') {
          this.onDroppedResponse(gen, delivery.id);
        } else {
          this.onCredit(gen);
        }
      } catch {
        this.protocolFault(gen, 'handler');
      }
    }
  }

  onStdoutEnd(gen) {
    if (gen.retired) return;
    if (!gen.decoder.isAtBoundary()) {
      this.log.warn(`${this.label} stdout closed in the middle of a frame`);
    }
    if (gen.reassembler.inProgress()) {
      this.log.warn(`${this.label} stdout closed in the middle of a fragmented response`);
    }
    // A live child that closes stdout can't answer any more; one main asked
    // to stop closes it as it exits, and the grace kill bounds the rest.
    if (!gen.exited && !gen.stopping) this.connectionFailed(gen, 'stdout_closed');
  }

  /** A whole message of the process's: `size` its frame's payload length. */
  onMessage(gen, message, size = 0) {
    if (!isObject(message)) return this.protocolFault(gen, 'not_object');
    if (message.type === 'response') return this.onResponse(gen, message, size);
    if (message.type === 'event') return this.onEvent(gen, message);
    if (message.type === 'request') return this.onCoreRequest(gen, message);
    if (message.type === 'cancel') return this.onCoreCancel(gen, message);
    return this.protocolFault(gen, 'unknown_type');
  }

  /**
   * One of the process's requests (design 0004, Requests the process makes): its
   * IDs only increase, at most MAX_INCOMING are outstanding, and each gets
   * exactly one reply.
   */
  onCoreRequest(gen, message) {
    const { id, method, params } = message;
    // Taken as the request arrives: a response read in the same chunk can
    // settle one of the requests it names before the handler starts.
    const forPrivate = this.privacyOf(gen, isObject(params) ? params.serves : undefined);
    if (!Number.isSafeInteger(id) || id < 1) return this.protocolFault(gen, 'bad_id');
    if (id <= gen.lastIncomingId) return this.protocolFault(gen, 'reused_id');
    if (typeof method !== 'string' || !METHOD_NAME.test(method)) {
      return this.protocolFault(gen, 'bad_method');
    }
    if (params !== undefined && !isObject(params)) return this.protocolFault(gen, 'bad_params');
    if (gen.incoming.size >= MAX_INCOMING) return this.protocolFault(gen, 'too_many_requests');
    gen.lastIncomingId = id;
    // A generation on its way out serves nothing more.
    if (!this.serving(gen)) return undefined;
    const controller = new AbortController();
    gen.incoming.set(id, controller);
    const handler = this.handlerFor(method, params ?? {});
    if (!handler) {
      this.respond(gen, id, controller, { error: shellError('unknown_method') });
      return undefined;
    }
    // One that may answer with a body, on the core's connection at protocol
    // 2 or a two-way service's: its reply and its cancel go through the
    // duplex's sender. Only these are the sender's (the process's IDs
    // increase, so these do too): credit naming another of the process's
    // requests is late below the highest of them and a protocol error
    // above it, as for one never sent.
    const streams = Boolean(gen.duplex) && this.streamHandlers.has(handler);
    if (streams) {
      try {
        gen.duplex.request(id, this.streamSends.get(handler));
      } catch (err) {
        return this.protocolFault(gen, err instanceof FrameError ? err.category : 'stream');
      }
    }
    // What the handler holds for its reply: in main's pool until the reply
    // is serialized (or dropped), or in a pool of its own until the reply
    // is written (`handle(…, { pool })`).
    const { pool = null, failure = null, race = false } = this.handlerOptions.get(handler) ?? {};
    const lease = pool ? leaseOf(pool, { untilWritten: true }) : this.pool.lease();
    // Answered once: by the handler's outcome, or by the cancel it races.
    let answered = false;
    if (race && !streams) {
      // A streams handler's cancel is its sender's to answer, at once.
      controller.signal.addEventListener(
        'abort',
        () => {
          if (answered) return;
          answered = true;
          this.respond(gen, id, controller, { error: shellError('cancelled') });
        },
        { once: true }
      );
    }
    Promise.resolve()
      .then(() => {
        // Fenced before it started (its generation ended), or cancelled in
        // the same read as it arrived: the handler never runs.
        // Checked and started in the same job: nothing can fence or
        // cancel it in between.
        if (gen.incoming.get(id) !== controller) return null;
        if (controller.signal.aborted) return { error: shellError('cancelled') };
        let pending;
        try {
          pending = handler(params ?? {}, {
            id,
            signal: controller.signal,
            charge: lease.charge,
            shrink: lease.shrink,
            onRelease: lease.onRelease,
            onAnswer: (fn) => this.onAnswer(gen, id, fn),
            abortStream: (err) => this.abortStream(gen, id, err),
            streams,
            generation: gen.number,
            private: forPrivate.private,
            privateSession: forPrivate.session,
          });
        } catch (err) {
          return failedOutcome(err, controller.signal, failure);
        }
        return Promise.resolve(pending).then(
          (result) => ({ result: result ?? {} }),
          (err) => failedOutcome(err, controller.signal, failure)
        );
      })
      .then((outcome) => {
        try {
          if (!outcome) return;
          if (answered) {
            // Its cancel was answered first: the outcome is let go of.
            if (outcome.result instanceof StreamedReply) outcome.result.discard();
            return;
          }
          answered = true;
          if (streams) this.respondStreamed(gen, id, controller, outcome, lease, failure);
          else this.respond(gen, id, controller, outcome, lease, failure);
        } finally {
          lease.close();
        }
      });
    return undefined;
  }

  /**
   * PRIVATE MODE GUARD (#1058): whether a request the process makes may
   * serve a private window, and in which private session. The core's
   * `shell.verified` names the requests of main's it serves, by their IDs
   * in this generation (`serves`, freedom-core #285): the chain request
   * that made it, or the lookups waiting on the naming session that made
   * it. Each is still pending when the request arrives, as the core sends
   * it before their responses, and a request stays pending until its
   * response (a stream's head), even once cancelled.
   *
   * So the request is private exactly when one of those was sent from a
   * private window's async context. It fails closed: without `serves` (a
   * request that names none, or an older core), with none in it (a naming
   * session no lookup waits for any more), with an ID that isn't pending,
   * or with anything but IDs, it counts as private, in no session.
   *
   * `session` is the private session the private requests it names were
   * sent in, when they all share one; null when they don't, or were sent
   * with no private window open. A private window's lookup can outlive its
   * session (the last private window closes while it waits on Myotis): the
   * core's request for it then names the ended session, and Colibri refuses
   * it rather than start the next session's store. Used for Colibri's store
   * (naming-verified.js `runVerified`).
   * @returns {{ private: boolean, session: number|null }}
   */
  privacyOf(gen, serves) {
    const unknown = { private: true, session: null };
    if (!Array.isArray(serves) || serves.length === 0) return unknown;
    const sessions = new Set();
    for (const id of serves) {
      const entry = Number.isSafeInteger(id) ? gen.pending.get(id) : undefined;
      if (!entry) return unknown;
      if (entry.private) sessions.add(entry.privateSession ?? null);
    }
    if (sessions.size === 0) return { private: false, session: null };
    const [only] = sessions;
    return { private: true, session: sessions.size === 1 ? only : null };
  }

  /** Whether `gen` still serves the process's requests. */
  serving(gen) {
    return (
      gen === this.current &&
      !gen.ending &&
      !gen.exitAwaited &&
      !gen.exited &&
      !gen.retired &&
      !gen.distrusted
    );
  }

  /** The generation stops serving the process's requests: their handlers
   * abort, and no reply goes for them, nor more of one being written. */
  fence(gen) {
    const incoming = [...gen.incoming.values()];
    gen.incoming.clear();
    gen.answers.clear();
    this.dropBulk(gen);
    for (const piece of [...gen.pieces.values()]) this.dropPiece(gen, piece);
    for (const controller of incoming) controller.abort();
  }

  /** The process stopped waiting: the handler's signal aborts, and its one
   * reply still goes. A cancel for a request already answered is ignored. */
  onCoreCancel(gen, message) {
    const { id } = message;
    if (!Number.isSafeInteger(id) || id < 1) return this.protocolFault(gen, 'bad_id');
    gen.incoming.get(id)?.abort();
    this.replaceCancelledBulk(gen, id);
    if (gen.duplex) {
      // A request the duplex holds: `cancelled` is its one reply, or its
      // body's abort, and the body is let go of. Any other is late.
      let cancel;
      try {
        cancel = gen.duplex.cancel(id);
      } catch (err) {
        return this.protocolFault(gen, err instanceof FrameError ? err.category : 'stream');
      }
      if (cancel === 'cancelled') {
        const piece = gen.pieces.get(id);
        if (piece) this.dropPiece(gen, piece);
        this.flushStreams(gen);
      }
    }
    return undefined;
  }

  /**
   * A reply over one frame still waiting to begin, for a request the process
   * has cancelled: the process drops whatever answers a cancelled request (its
   * one terminal reply is still due), so `cancelled` goes in its place at
   * once, one small frame, and the waiting reply's buffer and its pool
   * charge go. A reply already begun is written to its end.
   */
  replaceCancelledBulk(gen, id) {
    const at = gen.bulk.findIndex((reply) => reply.id === id);
    if (at < 0) return;
    const [reply] = gen.bulk.splice(at, 1);
    reply.release();
    if (!this.owes(gen, id, reply.controller)) return;
    const error = shellError('cancelled');
    this.writeReply(gen, id, reply.controller, encodeFrame({ type: 'response', id, error }));
  }

  /** Whether a reply is still owed and can be written: its entry is the
   * current one and its generation's stdin is open. One that can't is
   * dropped. */
  owes(gen, id, controller) {
    if (gen.incoming.get(id) !== controller) return false;
    if (gen.retired || gen.exited || gen.stdinEnded || !gen.child) {
      gen.incoming.delete(id);
      return false;
    }
    return true;
  }

  /**
   * Writes the reply to one of the process's requests, unless its generation
   * fenced it. Its entry is held until the write completes, so the process's
   * MAX_INCOMING bounds pending replies too; their bytes are their own
   * account, so they never take the room requests (vault.lock, shutdown)
   * need.
   *
   * A reply over one frame goes fragmented, to a process that offered
   * fragments and within the message cap; otherwise it is `too_large`.
   *
   * Main's pool (design 0005): once the reply is serialized, what its
   * handler held for it (`lease`) is released, and a reply of
   * POOL_EXEMPT_BYTES or more is charged in its place until it is written or
   * dropped. Past the pool, it is `busy`. A handler's own pool keeps its
   * lease to the write instead (`charged`).
   *
   * `failure` is the handler's (`handle`): what a reply main can't send
   * answers with in place of its error.
   */
  respond(gen, id, controller, outcome, lease = null, failure = null) {
    if (outcome.result instanceof StreamedReply) {
      // Only a streams handler, on the core's connection at protocol 2 or
      // a two-way service's, may send a body.
      outcome.result.discard();
      outcome = failedWith('internal', failure);
    }
    if (!this.owes(gen, id, controller)) return;
    if (outcome.result instanceof JsonText) {
      this.respondText(gen, id, controller, outcome.result, lease, failure);
      return;
    }
    // Serialized once, so a result's toJSON runs once and what is checked
    // is what is sent: a result JSON can't represent (a function, a symbol,
    // a toJSON returning nothing) leaves the bare envelope, and is internal
    // instead. The text is compared, so a large reply isn't parsed back.
    let json;
    try {
      json = JSON.stringify({ type: 'response', id, ...outcome });
      if (json === JSON.stringify({ type: 'response', id })) json = null;
    } catch {
      json = null;
    }
    if (!lease?.untilWritten) lease?.close();
    // Serializing ran the result's own code, which may have fenced it.
    if (!this.owes(gen, id, controller)) return;
    let code = 'internal';
    if (json !== null) {
      const size = Buffer.byteLength(json, 'utf8');
      const whole = size <= MAX_PAYLOAD;
      if (whole || (gen.fragments && size <= MAX_MESSAGE)) {
        const release = this.charged(gen, lease, size);
        if (release && whole) {
          this.writeReply(gen, id, controller, encodeJsonFrame(json), release);
          return;
        }
        if (release) {
          this.queueBulk(gen, { id, controller, payload: Buffer.from(json, 'utf8'), release });
          return;
        }
        code = 'busy';
      } else {
        code = 'too_large';
      }
    }
    const failed = failedWith(code, failure);
    this.writeReply(gen, id, controller, encodeFrame({ type: 'response', id, ...failed }));
  }

  /**
   * `respond` for a result already written as JSON ({@link JsonText}): the
   * same reply, byte for byte, as JSON.stringify of the envelope would make
   * (`{"type":"response","id":…,"result":…}`), its size known without
   * measuring, and the pool's rules unchanged. The handler's lease is
   * released, then a reply of POOL_EXEMPT_BYTES or more is charged whole
   * before its buffer is made, until it is written or dropped; past the
   * pool it is `busy`, past one frame for a process that didn't offer
   * fragments (or past the message cap) `too_large`. A handler's own pool
   * keeps its lease to the write instead (`charged`).
   */
  respondText(gen, id, controller, text, lease, failure = null) {
    const head = `{"type":"response","id":${JSON.stringify(id)},"result":`;
    const size = head.length + text.length + 1;
    if (!lease?.untilWritten) lease?.close();
    let code = 'too_large';
    const whole = size <= MAX_PAYLOAD;
    // The process cancelled it before it was ready: as for one waiting to
    // begin (`replaceCancelledBulk`), `cancelled` goes in its place, and no
    // buffer is made.
    if (!whole && controller.signal.aborted) {
      code = 'cancelled';
    } else if (whole || (gen.fragments && size <= MAX_MESSAGE)) {
      const release = this.charged(gen, lease, size);
      if (release) {
        // A whole reply is written into its frame, after the frame's
        // header, in one buffer: never assembled once and copied again
        // (a Swarm reply's charge counts one serialized copy, design 0015).
        const header = whole ? frameHeader(KIND_JSON, size) : null;
        const offset = header ? header.length : 0;
        const buffer = Buffer.allocUnsafe(offset + size);
        if (header) header.copy(buffer, 0);
        const at = text.writeInto(buffer, offset + buffer.write(head, offset, 'latin1'));
        buffer.write('}', at, 'latin1');
        if (whole) this.writeReply(gen, id, controller, buffer, release);
        else this.queueBulk(gen, { id, controller, payload: buffer, release });
        return;
      }
      code = 'busy';
    }
    const failed = failedWith(code, failure);
    this.writeReply(gen, id, controller, encodeFrame({ type: 'response', id, ...failed }));
  }

  /**
   * What a reply of `size` bytes holds until it is written or dropped: a
   * release that runs once, or null past its pool (`busy`). A reply of
   * POOL_EXEMPT_BYTES or more is charged to main's pool (`hold`), the
   * handler's lease released already. A handler with a pool of its own
   * (`handle(…, { pool })`, design 0015's Swarm I/O pool) keeps its lease
   * instead, which counted the reply in what it reserved, and it is charged
   * there only for what such a reply passes it by. Its retirement releases
   * whatever is still held.
   */
  charged(gen, lease, size) {
    const large = size >= POOL_EXEMPT_BYTES;
    if (!lease?.untilWritten) return this.hold(gen, large ? size : 0);
    if (!lease.charge(large ? Math.max(0, size - lease.held) : 0)) return null;
    const close = lease.keep();
    const release = () => {
      if (gen.charges.delete(release)) close();
    };
    gen.charges.add(release);
    return release;
  }

  /**
   * Charges `bytes` of `gen`'s to main's pool: a release that runs once, or
   * null past the pool. Its retirement releases whatever is still held.
   */
  hold(gen, bytes) {
    if (bytes === 0) return () => {};
    if (!this.pool.take(bytes)) return null;
    const release = () => {
      if (!gen.charges.delete(release)) return;
      this.pool.release(bytes);
    };
    gen.charges.add(release);
    return release;
  }

  /** Writes a reply in one frame; `release` returns its pool charge once
   * it is written. */
  writeReply(gen, id, controller, frame, release = null) {
    gen.replyBytes += frame.length;
    const written = (err) => {
      gen.replyBytes -= frame.length;
      release?.();
      if (gen.incoming.get(id) === controller) gen.incoming.delete(id);
      if (err) this.connectionFailed(gen, 'stdin_error');
    };
    try {
      this.writeInOrder(gen, frame, written);
    } catch {
      written(true);
    }
    this.answerGiven(gen, id);
  }

  /** A reply over one frame waits for the process's credit, in order. */
  queueBulk(gen, reply) {
    gen.bulk.push(reply);
    this.pumpBulk(gen);
  }

  /**
   * Begins the next waiting reply while main holds the process's credit and
   * none is being written. Beginning spends the credit, before the begin is
   * written, so the process's `0x13` can't come first.
   */
  pumpBulk(gen) {
    while (!gen.sending && gen.credit && gen.bulk.length) {
      const reply = gen.bulk.shift();
      if (!this.owes(gen, reply.id, reply.controller)) {
        reply.release();
        continue;
      }
      gen.credit = false;
      gen.sending = { ...reply, offset: 0, writing: false };
      try {
        this.writeInOrder(gen, encodeBegin(reply.id, reply.payload.length));
      } catch {
        this.connectionFailed(gen, 'stdin_error');
        return;
      }
      this.writeFragment(gen);
    }
  }

  /**
   * Writes the next fragment of the reply being sent. The one after goes
   * once this one is written, so the whole frames written meanwhile go
   * between them. Once begun, a reply is written to its end; its entry goes
   * with its last fragment.
   *
   * Each fragment is a view of the reply's buffer, so the buffer stays
   * charged whole until the last write that holds it completes: its last
   * fragment's, or the one in flight when the rest was dropped.
   */
  writeFragment(gen) {
    const sending = gen.sending;
    const { payload, offset } = sending;
    const end = Math.min(payload.length, offset + MAX_PAYLOAD);
    const last = end === payload.length;
    sending.offset = end;
    sending.writing = true;
    const written = (err) => {
      sending.writing = false;
      // Its generation ended meanwhile, and the rest was dropped; or the
      // write failed; or this was the last fragment.
      const done = err || gen.sending !== sending || last;
      if (!done) {
        this.writeFragment(gen);
        return;
      }
      sending.release();
      if (gen.sending !== sending) return;
      gen.sending = null;
      if (err) {
        this.connectionFailed(gen, 'stdin_error');
        return;
      }
      if (gen.incoming.get(sending.id) === sending.controller) gen.incoming.delete(sending.id);
      this.pumpBulk(gen);
    };
    try {
      // The header and its payload go together: nothing between them.
      this.writeInOrder(gen, frameHeader(last ? KIND_LAST : KIND_FRAGMENT, end - offset));
      gen.child.stdin.write(payload.subarray(offset, end), written);
    } catch {
      written(true);
    }
    if (last) this.answerGiven(gen, sending.id);
  }

  /** Drops the replies waiting to begin, and the rest of the one being
   * written: the process reads no more of this generation's. A fragment still
   * being written holds its reply's buffer: its write releases the charge. */
  dropBulk(gen) {
    if (gen.sending && !gen.sending.writing) gen.sending.release();
    gen.sending = null;
    for (const reply of gen.bulk) reply.release();
    gen.bulk = [];
  }

  /**
   * A response to one of main's requests: a whole one with its frame's
   * payload length (`size`), or a fragmented one, reassembled, with none
   * (charged at its begin).
   */
  onResponse(gen, message, size = 0) {
    const { id } = message;
    if (!Number.isSafeInteger(id) || id < 1) return this.protocolFault(gen, 'bad_id');
    const entry = gen.pending.get(id);
    if (!entry) return this.protocolFault(gen, 'unsolicited_response');
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    if (hasResult === hasError) return this.protocolFault(gen, 'result_and_error');
    let outcome;
    if (hasError) {
      const { error } = message;
      if (
        !isObject(error) ||
        typeof error.code !== 'string' ||
        !ERROR_CODE.test(error.code) ||
        typeof error.message !== 'string'
      ) {
        return this.protocolFault(gen, 'bad_error');
      }
      outcome = { error: new CoreError(error.code, error.message, error.data) };
    } else {
      outcome = { result: message.result };
    }
    // A whole response of POOL_EXEMPT_BYTES or more to a request sent with
    // a pool, charged twice its payload as it is decoded, before anything
    // holds it past its frame (design 0015, Results for pages). One main
    // can't charge is let go of, as a fragmented one is at its begin.
    if (entry.charge && size >= POOL_EXEMPT_BYTES && !entry.charge(2 * size)) {
      return this.onDroppedResponse(gen, id, { whole: true });
    }
    let body = null;
    // A head that says `body: true` opens the stream of a stream request, as
    // any head of a method whose head always does (`headOpens`).
    const opens = Boolean(
      entry.stream &&
      hasResult &&
      isObject(message.result) &&
      (message.result.body === true || entry.headOpens)
    );
    if (gen.streams) {
      let replied;
      try {
        replied = gen.duplex ? gen.duplex.answered(id, opens) : gen.streams.reply(id, opens);
      } catch (err) {
        return this.protocolFault(gen, err instanceof FrameError ? err.category : 'stream');
      }
      // A request main cancelled is retiring: its caller already has its
      // answer, and its body's frames are dropped until the terminal.
      if (opens && replied === 'deliver') body = this.openBody(gen, id, entry.signal);
    }
    if (entry.stream && hasResult) outcome = { result: { result: message.result, body } };
    // An idle request's watchdog runs on to its body's terminal, if its
    // head opens one, and ends here otherwise.
    if (opens) this.idleProgress(gen, id);
    else this.idleEnded(gen, id);
    gen.pending.delete(id);
    // A start step's error: the process ends after it.
    if (hasError && entry.endsOnError) this.startStepFailed(gen);
    entry.settle(outcome);
    return undefined;
  }

  // ---- streams (design 0007) ----

  /**
   * Sends a request whose response may open a stream, to the process
   * requests go to now (it must be ready, and have granted `stream`).
   * Resolves to `{ result, body }`: the head's result, and for a head that
   * says `body: true` a byte ReadableStream pulled on demand, else null.
   *
   * The body: each pull takes up to 64 KiB of the stream's ring, and its
   * bytes go back to the process as credit; it ends when every byte has
   * been read after `end`, and errors on `abort` (with the abort's code),
   * on the process's end, or on a protocol fault. Its `cancel()`, or
   * `signal` aborting, retires the stream: main sends `cancel` and no more
   * credit, and drops what is left. Options are `requestTo`'s, and `takes`:
   * the abort codes the body may end with, the connection's by default
   * (design 0015's `CORE_UPLOAD_ABORT_CODES` for `swarm.body`).
   */
  callStream(method, params = {}, context = { caller: 'shell' }, options = {}) {
    return this.requestStreamTo(this.current, method, params, context, options);
  }

  /** `callStream` to the ready process `gen` names, as `requestTo`: an
   * idle method's watchdog (`idleWatchdogMs`) runs to its body's terminal.
   * A stream request takes no `pool`. */
  requestStreamTo(gen, method, params = {}, context = { caller: 'shell' }, options = {}) {
    if (!this.serves(gen)) return Promise.reject(this.unavailable());
    const {
      watchdogMs = null,
      idleWatchdogMs = null,
      signal = null,
      fence = null,
      onSent = null,
      requires = null,
      takes = null,
    } = options;
    return this.send(gen, method, params, context, {
      watchdogMs,
      idleWatchdogMs,
      signal,
      fence,
      onSent,
      requires,
      takes,
      stream: true,
    });
  }

  /** What main holds for `gen`'s streams, for diagnostics and tests. */
  streamStats(gen = this.current) {
    if (!gen?.streams) return null;
    const stats = {
      outstanding: gen.streams.outstanding(),
      ringBytes: gen.streams.ringBytes(),
      bodies: gen.bodies.size,
      outbox: gen.outbox.size,
    };
    if (gen.duplex) {
      // The bodies main sends the core, and the core's requests the
      // sender holds.
      stats.pieces = gen.pieces.size;
      stats.sending = gen.duplex.sender.live();
      stats.held = gen.duplex.sender.held;
      // Read ahead of a body, or claimed by a read in flight, not yet
      // taken by the sender.
      stats.pending = gen.duplex.sender.reserved;
    }
    return stats;
  }

  /** A stream frame from the process: through the duplex on the core's
   * connection at protocol 2, else through main's receiver. */
  onStreamFrame(gen, frame) {
    let delivery;
    try {
      delivery = gen.duplex ? gen.duplex.receive(frame) : gen.streams.receive(frame);
    } catch (err) {
      this.protocolFault(gen, err instanceof FrameError ? err.category : 'stream');
      return;
    }
    if (delivery.type === 'credit') {
      // Room for one of the bodies main sends, and its progress.
      this.streamProgressed(gen, delivery.id, false);
      const piece = gen.pieces.get(delivery.id);
      if (piece) this.pumpPiece(gen, piece);
      this.flushStreams(gen);
      return;
    }
    // A frame of the body of one of main's requests, retiring or not: an
    // idle one's progress, or with its terminal, its end.
    if (frame.kind === KIND_DATA) this.idleProgress(gen, frame.id);
    else this.idleEnded(gen, frame.id);
    const body = gen.bodies.get(delivery.id);
    if (!body) return; // retiring: dropped
    if (delivery.type === 'abort') {
      // At once, read or not (freedom-core design 0007, "End of a body"): its
      // bytes are dropped, and whatever its consumer holds goes with it.
      this.endBody(gen, delivery.id, body, new CoreError(delivery.code, delivery.message));
      return;
    }
    if (delivery.type === 'end') body.ended = true;
    this.wakeBody(body);
  }

  /** The body of stream `id`, a byte ReadableStream pulled on demand. */
  openBody(gen, id, signal) {
    const body = {
      controller: null,
      waiter: null,
      ended: false,
      done: false,
      signal,
      onAbort: null,
    };
    gen.bodies.set(id, body);
    if (signal) {
      body.onAbort = () => this.abortBody(gen, id, body, cancelled());
      signal.addEventListener('abort', body.onAbort, { once: true });
    }
    return new ReadableStream(
      {
        start: (controller) => {
          body.controller = controller;
        },
        pull: () => this.pullBody(gen, id, body),
        cancel: () => this.abortBody(gen, id, body, null),
      },
      { highWaterMark: 0 }
    );
  }

  /** A consumer's read: the next bytes of the ring, the end, or a wait for
   * the next frame of the stream. (An abort ends the body as it comes.) */
  pullBody(gen, id, body) {
    if (body.done) return undefined;
    // The duplex owes the credit itself.
    const pulled = gen.duplex ? gen.duplex.pull(id, MAX_PULL) : gen.streams.pull(id, MAX_PULL);
    if (pulled) {
      if (pulled.credit !== null) {
        if (!gen.duplex) gen.outbox.credit(id, pulled.credit);
        this.flushOutbox(gen);
      }
      if (pulled.chunk.length) body.controller.enqueue(pulled.chunk);
      if (pulled.eof) return this.endBody(gen, id, body, null);
      if (pulled.chunk.length) return undefined;
    } else if (body.ended) {
      // `end` came with nothing left: the record is gone.
      return this.endBody(gen, id, body, null);
    } else {
      return this.endBody(gen, id, body, this.unavailable());
    }
    return new Promise((resolve) => {
      body.waiter = resolve;
    }).then(() => this.pullBody(gen, id, body));
  }

  wakeBody(body) {
    const waiter = body.waiter;
    body.waiter = null;
    waiter?.();
  }

  /** The body is over: closed, or errored with `error`. */
  endBody(gen, id, body, error) {
    if (body.done) return;
    body.done = true;
    gen.bodies.delete(id);
    if (body.onAbort) body.signal.removeEventListener('abort', body.onAbort);
    if (error) body.controller.error(error);
    else body.controller.close();
    this.wakeBody(body);
  }

  /** The caller let go of the body (its cancel, or `signal`): the stream
   * retires, and the body errors with `error`, if any. */
  abortBody(gen, id, body, error) {
    if (body.done) return;
    if (error) {
      this.endBody(gen, id, body, error);
    } else {
      body.done = true;
      gen.bodies.delete(id);
      if (body.onAbort) body.signal.removeEventListener('abort', body.onAbort);
      this.wakeBody(body);
    }
    if (!gen.retired && !gen.exited && !gen.stdinEnded && gen.child) this.retireStream(gen, id);
  }

  /** A local cancel of request `id` on a stream connection: its record
   * retires (or goes, if its end had come), and `cancel` is queued. */
  retireStream(gen, id) {
    if (gen.duplex) {
      if (gen.duplex.withdraw(id) === 'send_cancel') this.flushStreams(gen);
      return;
    }
    if (gen.streams.cancel(id) !== 'send_cancel') return;
    gen.outbox.cancel(id);
    this.flushOutbox(gen);
  }

  /**
   * Writes the outbox's credit and cancels: everything waiting in one
   * write, then nothing more until it has gone, so what can't be written
   * yet merges in the outbox (at most one credit and one cancel per
   * stream).
   */
  flushOutbox(gen) {
    if (gen.duplex) {
      this.flushStreams(gen);
      return;
    }
    if (gen.outboxWriting || gen.retired || gen.exited || gen.stdinEnded || !gen.child) return;
    const frames = [];
    for (let frame = gen.outbox.next(); frame; frame = gen.outbox.next()) frames.push(frame);
    if (!frames.length) return;
    gen.outboxWriting = true;
    try {
      gen.child.stdin.write(Buffer.concat(frames), (err) => {
        gen.outboxWriting = false;
        if (err) {
          this.connectionFailed(gen, 'stdin_error');
          return;
        }
        this.flushOutbox(gen);
      });
    } catch {
      gen.outboxWriting = false;
      this.connectionFailed(gen, 'stdin_error');
    }
  }

  // ---- the bodies main sends the core (design 0009) ----

  /**
   * The outcome of one of the core's requests to a streams handler, on the
   * core's connection at protocol 2: queued with the duplex's sender, as a
   * head and its body for a `StreamedReply`, otherwise as the one reply.
   * A reply over one frame is `too_large`; one of POOL_EXEMPT_BYTES or more
   * is charged to main's pool until it is written, and is `busy` past it.
   * A handler's own pool keeps its lease instead (`charged`): to the reply's
   * write, or for a body to its terminal (design 0015: a stream's charge
   * goes at its terminal). A request the core cancelled meanwhile already
   * has its reply, and the outcome is dropped. `failure` is `respond`'s.
   */
  respondStreamed(gen, id, controller, outcome, lease, failure = null) {
    const streamed = outcome.result instanceof StreamedReply ? outcome.result : null;
    let json = null;
    let code = null;
    try {
      if (streamed) {
        const result = streamed.bodyFlag ? { ...streamed.result, body: true } : streamed.result;
        json = Buffer.from(JSON.stringify({ type: 'response', id, result }), 'utf8');
      } else if (outcome.result instanceof JsonText) {
        const head = `{"type":"response","id":${id},"result":`;
        const size = head.length + outcome.result.length + 1;
        if (size > MAX_PAYLOAD) {
          code = 'too_large';
        } else {
          json = Buffer.allocUnsafe(size);
          const at = outcome.result.writeInto(json, json.write(head, 0, 'latin1'));
          json.write('}', at, 'latin1');
        }
      } else {
        const text = JSON.stringify({ type: 'response', id, ...outcome });
        if (text !== JSON.stringify({ type: 'response', id })) json = Buffer.from(text, 'utf8');
      }
    } catch {
      json = null;
    }
    if (!lease?.untilWritten) lease?.close();
    if (!code && !json) code = 'internal';
    if (!code && json.length > MAX_PAYLOAD) code = 'too_large';
    // Serializing ran the result's own code, which may have fenced it.
    if (!this.owes(gen, id, controller) || !gen.duplex) {
      streamed?.discard();
      return;
    }
    let release = null;
    if (!code && (lease?.untilWritten || json.length >= POOL_EXEMPT_BYTES)) {
      release = this.charged(gen, lease, json.length);
      if (!release) code = 'busy';
    }
    if (code) {
      streamed?.discard();
      const failed = failedWith(code, failure);
      json = Buffer.from(JSON.stringify({ type: 'response', id, ...failed }));
    }
    const sender = gen.duplex.sender;
    const opens = Boolean(streamed) && !code;
    const queued = opens ? sender.head(id, json, true) : sender.reply(id, json);
    if (queued !== 'ok') {
      // Cancelled meanwhile: its `cancelled` is queued or written.
      release?.();
      if (opens) streamed.discard();
      return;
    }
    if (release) {
      // A body's own pool charge goes at its terminal, any other at the
      // head or reply.
      const charges = opens && lease?.untilWritten ? gen.streamCharges : gen.pieceCharges;
      charges.set(id, release);
    }
    if (opens && streamed.onProgress) gen.streamProgress.set(id, streamed.onProgress);
    if (opens) {
      let reader;
      let byob = false;
      try {
        // A byte stream is read into views of the size main asks for.
        try {
          reader = streamed.body.getReader({ mode: 'byob' });
          byob = true;
        } catch {
          reader = streamed.body.getReader();
        }
      } catch {
        sender.abort(id, 'body_stream_error', PIECE_ABORTS.body_stream_error);
        this.flushStreams(gen);
        return;
      }
      const piece = {
        id,
        reader,
        byob,
        pending: null,
        eof: false,
        reading: false,
        claimed: 0,
        scratch: null,
      };
      gen.pieces.set(id, piece);
      // The body's failure ends the stream as it happens, a read pending or
      // not: an abort goes ahead of the data and needs no credit, and the
      // piece's pending bytes and any read's claim go with it (`dropPiece`).
      // Its close doesn't: the bytes before it still go, under credit.
      reader.closed.then(
        () => {},
        (err) => {
          if (gen.pieces.get(id) !== piece) return;
          this.abortPiece(gen, piece, err);
        }
      );
      this.pumpPiece(gen, piece);
    }
    this.flushStreams(gen);
  }

  /**
   * Moves a body into its stream as the core's credit and the writer's cap
   * allow: it reads only while the stream has room, at most MAX_READ_AHEAD
   * at a time (a byte stream at most the room, too), and holds what the
   * sender hasn't taken, charged to the writer's cap, reading nothing more
   * until it has gone. A read's room is claimed from the cap before the
   * read starts (`StreamSender#claim`), so the reads of many bodies started
   * at once never count the same room: a byte stream's the size of its
   * view, any other's MAX_READ_AHEAD, the most a chunk may be.
   */
  pumpPiece(gen, piece) {
    const sender = gen.duplex?.sender;
    while (sender && gen.pieces.get(piece.id) === piece) {
      if (piece.pending) {
        const bytes = piece.pending;
        // Charged as the queue's once taken, as the cap's until then.
        sender.release(bytes.length);
        const pushed = sender.push(piece.id, bytes);
        if (pushed.refused) {
          piece.pending = null;
          this.dropPiece(gen, piece);
          return;
        }
        piece.pending = pushed.taken === bytes.length ? null : bytes.subarray(pushed.taken);
        // The rest waits for credit, or for the writer to make room.
        if (piece.pending) {
          sender.reserve(piece.pending.length);
          return;
        }
        continue;
      }
      if (piece.eof) {
        // `end` follows the last byte; the body is done.
        gen.pieces.delete(piece.id);
        sender.finish(piece.id);
        return;
      }
      if (piece.reading) return;
      const claimed = piece.byob
        ? sender.claim(piece.id, MAX_READ_AHEAD)
        : sender.claim(piece.id, Math.min(MAX_READ_AHEAD, sender.dataCap), { whole: true });
      if (claimed === null) {
        this.dropPiece(gen, piece);
        return;
      }
      if (claimed > 0) this.readPiece(gen, piece, sender, claimed);
      return;
    }
  }

  /** A byte stream's view to read `claimed` bytes into: its piece's one
   * buffer of MAX_READ_AHEAD, made once and handed back by each read
   * (BYOB reads transfer it), never one a read. */
  scratchView(piece, claimed) {
    const scratch = piece.scratch ?? new ArrayBuffer(MAX_READ_AHEAD);
    piece.scratch = null;
    return new Uint8Array(scratch, 0, claimed);
  }

  /** One read of a body, into the `claimed` room of `sender`'s cap: its
   * bytes keep as much of it as they take, and the rest goes back. */
  readPiece(gen, piece, sender, claimed) {
    piece.reading = true;
    piece.claimed = claimed;
    // The read is over: its claim, unless the piece was let go of (and the
    // claim with it) meanwhile.
    const over = () => {
      piece.reading = false;
      const held = piece.claimed;
      piece.claimed = 0;
      return held;
    };
    let read;
    try {
      read = piece.byob ? piece.reader.read(this.scratchView(piece, claimed)) : piece.reader.read();
    } catch (err) {
      read = Promise.reject(err);
    }
    Promise.resolve(read).then(
      (chunk) => {
        const held = over();
        if (gen.pieces.get(piece.id) !== piece) {
          sender.release(held);
          return;
        }
        if (chunk?.done) {
          sender.release(held);
          piece.eof = true;
        } else if (ArrayBuffer.isView(chunk?.value)) {
          const { buffer, byteOffset, byteLength } = chunk.value;
          // Past the room the read claimed: a source main can't bound.
          if (byteLength > held) {
            sender.release(held);
            this.abortPiece(gen, piece, null);
            return;
          }
          // The claim passes to the bytes read; what they didn't take goes.
          sender.release(held - byteLength);
          if (byteLength) piece.pending = Buffer.from(buffer, byteOffset, byteLength);
          // The read's buffer comes back: the next read reuses it, once
          // these bytes have gone to the sender (`pumpPiece` reads only
          // with nothing pending), so a source of small chunks costs no
          // buffer a read.
          if (piece.byob && buffer.byteLength === MAX_READ_AHEAD) piece.scratch = buffer;
        } else {
          sender.release(held);
          this.abortPiece(gen, piece, null);
          return;
        }
        this.pumpPiece(gen, piece);
        this.flushStreams(gen);
      },
      (err) => {
        sender.release(over());
        if (gen.pieces.get(piece.id) !== piece) return;
        this.abortPiece(gen, piece, err);
      }
    );
  }

  /**
   * The body failed with `err` (null for a source main can't bound): its
   * stream ends with the code `err.abortCode` names, `stalled` (main's body
   * idle timer) or `too_large` (design 0015), or else `body_stream_error`,
   * naming `err.errorCode`, an errno name. A code, or a name, the stream's
   * codes don't take (`handle(…, { sends })`) ends it `body_stream_error`
   * alone.
   */
  abortPiece(gen, piece, err) {
    this.dropPiece(gen, piece);
    this.abortSent(gen, piece.id, err);
  }

  /** Stream `id`'s abort for `err`, as `abortPiece` names it, in the
   * sender: what it holds of the stream and hasn't written (its data, an
   * `end` after them) goes. Nothing once its terminal is written. */
  abortSent(gen, id, err) {
    const named = err?.abortCode === 'stalled' || err?.abortCode === 'too_large';
    const code = named ? err.abortCode : 'body_stream_error';
    const errorCode = named ? null : (err?.errorCode ?? null);
    const sender = gen.duplex?.sender;
    if (sender?.abort(id, code, PIECE_ABORTS[code], errorCode).refused === 'code') {
      sender.abort(id, 'body_stream_error', PIECE_ABORTS.body_stream_error);
    }
    this.flushStreams(gen);
  }

  /**
   * A handler's `abortStream(err)`: ends the stream its reply opened as
   * the body's failure `err` would (`abortPiece`), until its terminal is
   * written. A body still being read is let go of; one read to its end may
   * still have its last bytes and its `end` waiting in the sender, and
   * they go too, so neither is written after the abort is asked for.
   * Nothing before the reply has opened a stream, or once its terminal is
   * written.
   */
  abortStream(gen, id, err) {
    if (!gen.duplex) return;
    const piece = gen.pieces.get(id);
    if (piece) this.dropPiece(gen, piece);
    this.abortSent(gen, id, err);
  }

  /**
   * A handler's `onAnswer(fn)`: `fn` runs once, when main hands request
   * `id`'s answer to the pipe, so any frame main writes after it follows
   * the answer: a whole reply as its write is issued (its `cancelled` for
   * the process's cancel among them), a fragmented one with its last
   * fragment, and one through the duplex's sender (a streams handler's
   * head or reply, or the sender's `cancelled`) as its frame is taken for
   * a write, before any other frame is (`frameTaken`). It runs once. An
   * answer never handed over (its generation fenced) runs none. A throw in
   * `fn` is dropped.
   */
  onAnswer(gen, id, fn) {
    if (typeof fn !== 'function') throw new TypeError('onAnswer takes a function');
    const hooks = gen.answers.get(id);
    if (hooks) hooks.push(fn);
    else gen.answers.set(id, [fn]);
  }

  /**
   * One of the sender's frames, taken for a write (in the order the pipe
   * gets them): an answer (a head, a reply, a `cancelled`) runs its
   * request's `onAnswer` hooks now, before another frame is taken, so what
   * they purge never goes and what they queue goes after it.
   */
  frameTaken(gen, wrote) {
    if (wrote.type === 'head' || wrote.type === 'reply' || wrote.type === 'cancelled') {
      this.answerGiven(gen, wrote.id);
    }
  }

  /** Request `id`'s answer is in the pipe: its `onAnswer` hooks run. */
  answerGiven(gen, id) {
    const hooks = gen.answers.get(id);
    if (!hooks) return;
    gen.answers.delete(id);
    for (const fn of hooks) {
      try {
        fn();
      } catch {
        // The answer stands.
      }
    }
  }

  /** Lets go of a body main sends: its reader is cancelled, unless it
   * ended. */
  dropPiece(gen, piece) {
    if (gen.pieces.get(piece.id) !== piece) return;
    gen.pieces.delete(piece.id);
    if (piece.pending) gen.duplex?.sender.release(piece.pending.length);
    piece.pending = null;
    // A read in flight gives back its claim now; its answer is dropped.
    if (piece.claimed) gen.duplex?.sender.release(piece.claimed);
    piece.claimed = 0;
    if (piece.eof) return;
    try {
      piece.reader.cancel().catch(() => {});
    } catch {
      // Already released.
    }
  }

  /** Every body main sends that may have room again. */
  pumpPieces(gen) {
    for (const piece of [...gen.pieces.values()]) this.pumpPiece(gen, piece);
  }

  /**
   * Writes the duplex's frames (design 0009, Streams in the core): what
   * main owes first (credit, and its cancels), then the sender's control
   * entries, then its streams round-robin. Up to STREAM_WRITE_BYTES go in
   * one write, then nothing more until it has gone: a frame not yet taken
   * can still be purged by an abort or a cancel.
   */
  flushStreams(gen) {
    if (!gen.duplex || gen.outboxWriting || gen.distrusted) return;
    if (gen.retired || gen.exited || gen.stdinEnded || !gen.child) return;
    const frames = [];
    const wrote = [];
    let bytes = 0;
    // Held while the frames are taken: what an answer's hook asks to be
    // written (`frameTaken`) joins this write, or the next, never one ahead.
    gen.outboxWriting = true;
    while (bytes < STREAM_WRITE_BYTES) {
      const next = gen.duplex.nextFrame();
      if (!next) break;
      frames.push(next.bytes);
      wrote.push(next.wrote);
      bytes += next.bytes.length;
      this.frameTaken(gen, next.wrote);
    }
    if (!frames.length) {
      gen.outboxWriting = false;
      return;
    }
    const written = (err) => {
      gen.outboxWriting = false;
      if (err) {
        this.connectionFailed(gen, 'stdin_error');
        return;
      }
      for (const entry of wrote) this.streamWritten(gen, entry);
      this.pumpPieces(gen);
      this.flushStreams(gen);
    };
    try {
      gen.child.stdin.write(frames.length === 1 ? frames[0] : Buffer.concat(frames), written);
    } catch {
      gen.outboxWriting = false;
      this.connectionFailed(gen, 'stdin_error');
    }
  }

  /** One of the duplex's frames is written. A reply, or a body's terminal,
   * is the core's request's last: its entry goes. */
  streamWritten(gen, wrote) {
    // Main's credit for the body of one of its own requests, or its cancel
    // of one: an idle one's progress (the core has D13's 60 s to answer a
    // cancel).
    if (wrote.type === 'credit' || wrote.type === 'cancel') {
      this.idleProgress(gen, wrote.id);
      return;
    }
    // One of main's frames of a body it sends: a streamed reply's progress,
    // to its terminal.
    this.streamProgressed(gen, wrote.id, wrote.type !== 'head' && wrote.type !== 'data');
    if (wrote.type === 'data') return;
    const release = gen.pieceCharges.get(wrote.id);
    if (release) {
      gen.pieceCharges.delete(wrote.id);
      release();
    }
    if (wrote.type === 'head') return;
    const held = gen.streamCharges.get(wrote.id);
    if (held) {
      gen.streamCharges.delete(wrote.id);
      held();
    }
    gen.incoming.delete(wrote.id);
    const piece = gen.pieces.get(wrote.id);
    if (piece) this.dropPiece(gen, piece);
  }

  /** A frame or a credit of the stream main sends for the process's request
   * `id`: its `onProgress`, if it has one; with `terminal`, its last. */
  streamProgressed(gen, id, terminal) {
    const progress = gen.streamProgress.get(id);
    if (!progress) return;
    if (terminal) gen.streamProgress.delete(id);
    try {
      progress();
    } catch {
      // Progress is a report: the stream goes on.
    }
  }

  /** Ends every open body of `gen` with `error`. */
  failBodies(gen, error) {
    for (const [id, body] of [...gen.bodies]) this.endBody(gen, id, body, error);
  }

  /**
   * A fragmented response, reassembled: it must be the response its begin
   * named. Once its caller has it, the process's credit goes back, so it may
   * begin another.
   */
  onFragmentedResponse(gen, id, message) {
    if (!isObject(message) || message.type !== 'response' || message.id !== id) {
      return this.protocolFault(gen, 'fragmented_not_its_response');
    }
    this.onResponse(gen, message);
    if (!gen.distrusted) this.returnCredit(gen);
    return undefined;
  }

  /**
   * Returns the process's bulk credit (`0x13`), a control frame written at
   * once. A generation that can no longer take it is going away, and the
   * credit with it.
   */
  returnCredit(gen) {
    if (gen.retired || gen.exited || gen.ending || gen.stdinEnded || !gen.child) return;
    gen.reassembler.grant();
    try {
      this.writeInOrder(gen, encodeCredit(), (err) => {
        if (err) this.connectionFailed(gen, 'stdin_error');
      });
    } catch {
      this.connectionFailed(gen, 'stdin_error');
    }
  }

  /** The process returned main's credit: a waiting reply may begin. One main
   * wasn't owed (the process didn't offer fragments, or main holds its credit)
   * is a protocol fault. */
  onCredit(gen) {
    if (!gen.fragments || gen.credit) return this.protocolFault(gen, 'unsolicited_credit');
    gen.credit = true;
    this.pumpBulk(gen);
    return undefined;
  }

  onEvent(gen, message) {
    if (typeof message.event !== 'string' || !EVENT_NAME.test(message.event)) {
      return this.protocolFault(gen, 'bad_event');
    }
    const hasData = Object.prototype.hasOwnProperty.call(message, 'data');
    if (hasData && !isObject(message.data)) return this.protocolFault(gen, 'bad_event');
    // Only a live, ready, current generation speaks for the process; for a
    // service that reads its events to the pipe's end (`eventsUntilClose`,
    // design 0014's step marker), one that has exited too, until its pipe
    // closes and it retires, so an event it wrote just before its death
    // reaches the owner ahead of the client's `exit`.
    const speaks = !gen.exited || (this.service.eventsUntilClose === true && !gen.retired);
    if (!speaks || !gen.ready || gen !== this.current) return undefined;
    this.emit('event', message.event, hasData ? message.data : {});
    return undefined;
  }

  // ---- stderr ----

  onStderr(gen, chunk) {
    if (gen.retired) return;
    let text = gen.stderrText.write(chunk);
    while (text.length) {
      const newline = text.indexOf('\n');
      const part = newline === -1 ? text : text.slice(0, newline);
      text = newline === -1 ? '' : text.slice(newline + 1);
      if (!gen.stderrDropping) {
        gen.stderrLine += part;
        if (gen.stderrLine.length > MAX_STDERR_LINE) {
          this.forwardLog(gen.stderrLine);
          gen.stderrLine = '';
          gen.stderrDropping = newline === -1;
          continue;
        }
      }
      if (newline !== -1) {
        if (!gen.stderrDropping) this.forwardLog(gen.stderrLine);
        gen.stderrLine = '';
        gen.stderrDropping = false;
      }
    }
  }

  /** Forwards one of the process's log lines (JSON from its logger, or plain text). */
  forwardLog(line) {
    if (!line) return;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      // Plain text, e.g. a panic message.
    }
    if (!isObject(entry) || typeof entry.msg !== 'string') {
      this.log.info(this.label, clip(line));
      return;
    }
    const { level, msg, ...fields } = entry;
    const name =
      typeof level === 'string' && Object.hasOwn(LOG_LEVELS, level) ? LOG_LEVELS[level] : 'info';
    const logger = typeof this.log[name] === 'function' ? this.log[name] : this.log.info;
    logger.call(this.log, `${this.label} ${clip(msg)}`, Object.keys(fields).length ? fields : '');
  }
}

module.exports = {
  ServiceClient,
  CoreError,
  REQUIREMENT_UNMET,
  JsonParams,
  JsonText,
  ShellError,
  StreamedReply,
  SERVICE_DUPLEX,
  SHELL_ERRORS,
  REFUSAL_RULES,
  MAX_INCOMING,
  scrubbedEnv,
  isObject,
  validConfinement,
  confinementLog,
  CONFINEMENT_PROPERTIES: PROPERTIES,
  NO_RESTART_EXIT_CODES,
  OUT_OF_MEMORY_EXIT_CODE,
  RESTART_DELAYS_MS,
  CRASH_WINDOW_MS,
  MAX_CRASHES_IN_WINDOW,
  MAX_PENDING,
  MAX_WRITE_BYTES,
  POOL_BYTES,
  POOL_EXEMPT_BYTES,
};
