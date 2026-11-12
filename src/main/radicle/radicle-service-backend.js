/**
 * The reads of the Radicle node on freedom-radicled (freedom-core design
 * 0008, "JSON results" and Main's side, "Other callers"), for
 * radicle-embedded.js under `FREEDOM_RADICLE_BACKEND=service`. The node is
 * radicled-node.js's; each read is a `rad.read { op, args }` on its running
 * generation, answered with a head, `{ content_type: "application/json",
 * bytes, body: true }`, and the JSON as a body stream.
 *
 * - **`callStream(op, args, { signal })`** passes a read through: its head
 *   and its body, a byte stream main pulls on demand, holding one 128 KiB
 *   ring for it and nothing more (0007's streams, service-client.js). The
 *   handlers' reads take this route: the pass-through ops, those of main's
 *   serialization, and the composed `readme_at`, `repo_meta`, `repos_meta`,
 *   `issues_page` and `patches_page`. `signal`, or the body's `cancel()`,
 *   cancels it.
 * - **`callScoped(op, args, scope, { signal })`** is for callers that need
 *   a parsed value, and only for the closed list of small results, each
 *   with its cap (`COLLECTED_CAPS`): 64 KiB for `status`, `identity`,
 *   `repo_info`, `seeders` and the composed `node_info`, and 3 MiB for
 *   `list_seeded_repos` and `list_repos` (see CHARGE_PER_BYTE). A head over
 *   its cap is `too_large`, and nothing of its body is read. Any other op
 *   is refused: no caller parses a whole body outside a scope.
 *   - **The collection budget**, 16 MiB, is main's for what collecting
 *     holds: the bytes being collected and the parsed value. A call reserves
 *     as its bytes arrive: at its head, which says how many follow, before
 *     any of them is collected. It reserves CHARGE_PER_BYTE times the head's
 *     length, what its text and the value parsed from it can hold at worst,
 *     and waits, in the order the calls came, while that doesn't fit. A call
 *     that can't reserve within 5 s fails `busy`.
 *   - **The scope** is the value's lifetime: `scope(value, { signal, bytes
 *     })` is called once the body is parsed (`bytes`, its JSON's length),
 *     and the reservation is released when what it returns settles. The
 *     value can't leave the scope: a scope that resolves to the value itself
 *     is refused (`invalid_argument`). Only `keep` hands one out: an
 *     `identity` or `status` whose JSON is under 4 KiB, which 0008 lets
 *     outlive its scope uncharged.
 *   - **Before the handoff,** an abort cancels the call: the read is
 *     cancelled, and what was reserved is released at once (`cancelled`).
 *     **After it,** the scope owns the value: the abort reaches it as
 *     `signal`, and the reservation stays until it settles, so its
 *     allowance isn't reused while it may still hold the value.
 * - **Other callers** (the manager, cob-service.js, the provider, the
 *   GitHub bridge) aren't admitted by main's dweb admission, which the
 *   handlers' reads will take. Together they hold at most 64 requests
 *   outstanding at the service, with 64 more waiting in main for one to
 *   end; a call past that fails `busy`. A request is outstanding until its
 *   body ends: read to its end, cancelled or failed.
 *
 * - **The network operations** (0008, Methods `rad.connect_seeds` and
 *   `rad.clone`, Progress): `connectSeeds(timeoutMs)` is today's seed
 *   report, and `cloneRepo` and `cloneRepoWithProgress` a clone, `{ ok:
 *   true }` or `{ cancelled: true }`, its `rad.progress` events, each
 *   libradicle's JSON text, handed to the callback in order, the terminal
 *   one last, before the clone settles. Each holds one of the other
 *   callers' slots until its answer.
 *   - **`cancelClone(rid)`** replaces the add-on's token found by RID: it
 *     cancels the requests of the progress clones of `rid` (the add-on
 *     registered no other), and answers `{ cancelled }`, whether there was
 *     one. The cancel goes at once; the clone settles when it actually
 *     stops, `{ cancelled: true }`, as the add-on's did: the service
 *     answers once libradicle has returned, a fetch in flight finishing
 *     first. A clone cancelled before it started (waiting for a slot here,
 *     or queued in the service) settles `{ cancelled: true }` at once.
 *   - The service's own end of a clone, its deadline (`deadline`) or its
 *     stop (`stopped`), is an error, as any other of the service's.
 *
 * Every failure carries the service's code, or main's: `stopped` with no
 * node running, `busy`, `too_large`, `cancelled`, and `internal` for a
 * reply main can't read as the design says.
 */

const { StringDecoder } = require('string_decoder');
const { CoreError, isObject } = require('../core/service-client');

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * The collected results and their caps (0008, "JSON results"). The two
 * listings' are 3 MiB, under 0008's 4 MiB: at CHARGE_PER_BYTE, the worst
 * 3 MiB listing is charged 15 MiB, which fits the 16 MiB budget; a 4 MiB
 * one, charged 20 MiB, never would.
 */
const COLLECTED_CAPS = Object.freeze({
  status: 64 * KIB,
  identity: 64 * KIB,
  repo_info: 64 * KIB,
  seeders: 64 * KIB,
  node_info: 64 * KIB,
  list_seeded_repos: 3 * MIB,
  list_repos: 3 * MIB,
});
/** Main's collection budget: what collected results hold, in all. */
const COLLECTION_BUDGET_BYTES = 16 * MIB;
/** How long a collecting call waits for room in the budget. */
const RESERVE_WAIT_MS = 5_000;
/**
 * What a collected result is charged per byte of its JSON, for every shape
 * the service writes: the decoded text and the value parsed from it, held
 * together from the parse until the scope settles (V8 slices a listing's
 * strings out of the text, so its value keeps the whole text alive).
 * Measured, not assumed (test/helpers/radicle-collected-heap.js, which
 * radicle-service-backend.test.js runs), each shape at its cap in its worst
 * form, the heap and what lies outside it:
 * - a listing whose strings are long and held at two bytes a character, as
 *   is the text (one character past U+00FF anywhere makes it so): 4.24
 *   times its JSON in Node's V8, 4.09 in Electron's;
 * - an object-dense listing, entries with two-character names in such a
 *   text: 4.03, and 3.42 in Electron; with empty or null names, 3.49;
 * - each 64 KiB shape filled by one such string: 4.00; `repo_info`'s allow
 *   list of DIDs: 2.37.
 * 5 leaves a margin over the worst of these for V8's versions and what the
 * measurement misses. Twice the JSON, this step's first guess, isn't a bound.
 */
const CHARGE_PER_BYTE = 5;
/** The collected results that may outlive their scope, uncharged, when
 * their JSON is under KEEP_BYTES (0008: `identity`, `status`). */
const KEEPABLE = new Set(['identity', 'status']);
const KEEP_BYTES = 4 * KIB;
/** The other callers' requests outstanding at the service, and waiting in
 * main for one of them to end. */
const MAX_OUTSTANDING = 64;
const MAX_WAITING = 64;

const NOT_RUNNING = 'The Radicle node is not running';

function cancelled() {
  return new CoreError('cancelled', 'Cancelled');
}

function busy(message) {
  return new CoreError('busy', message);
}

function tooLarge(op, cap) {
  return new CoreError('too_large', `${op}'s result is over its cap of ${cap} bytes`);
}

function badReply(message) {
  return new CoreError('internal', `freedom-radicled answered a read ${message}`);
}

function badNetworkReply(method) {
  return new CoreError('internal', `freedom-radicled answered ${method} with a result main can't read`);
}

/** A clone's answer as the add-on gave it: `{ ok: true }` or `{ cancelled:
 * true }`; any other is `internal`. */
function cloneOutcome(result) {
  if (isObject(result) && result.ok === true) return { ok: true };
  if (isObject(result) && result.cancelled === true) return { cancelled: true };
  throw badNetworkReply('rad.clone');
}

/** Calls `fn` once, however many times the function it returns is called. */
function once(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/**
 * A wait queue in arrival order: `wait({ signal, ms, onTimeout })` resolves
 * when `admit` lets the front waiter in, or rejects with `cancelled` when
 * `signal` aborts, or with `onTimeout()` after `ms`.
 */
class WaitQueue {
  constructor({ setTimer, clearTimer }) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.waiters = [];
  }

  get length() {
    return this.waiters.length;
  }

  front() {
    return this.waiters[0] ?? null;
  }

  wait(entry, { signal = null, ms = null, onTimeout = null } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = { ...entry, resolve, reject, signal, timer: null, onAbort: null };
      if (ms !== null) {
        waiter.timer = this.setTimer(() => this.drop(waiter, onTimeout()), ms);
        waiter.timer?.unref?.();
      }
      if (signal) {
        waiter.onAbort = () => this.drop(waiter, cancelled());
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Takes the front waiter off the queue, for `admit` to resolve. */
  shift() {
    const waiter = this.waiters.shift();
    this.forget(waiter);
    return waiter;
  }

  drop(waiter, error) {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    this.forget(waiter);
    waiter.reject(error);
    this.onDrop?.();
  }

  forget(waiter) {
    if (waiter.timer !== null) this.clearTimer(waiter.timer);
    if (waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}

/**
 * Main's collection budget: `reserve(bytes, { signal })` resolves to the
 * function that releases them, once they fit, in arrival order; `busy`
 * after `waitMs`, `cancelled` when `signal` aborts.
 */
class CollectionBudget {
  constructor({ limit, waitMs, setTimer, clearTimer }) {
    this.limit = limit;
    this.waitMs = waitMs;
    this.held = 0;
    this.queue = new WaitQueue({ setTimer, clearTimer });
    this.queue.onDrop = () => this.admit();
  }

  reserve(bytes, { signal = null } = {}) {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (bytes > this.limit) {
      return Promise.reject(
        new CoreError('too_large', `${bytes} bytes is over the collection budget`)
      );
    }
    if (this.queue.length === 0 && this.held + bytes <= this.limit) {
      return Promise.resolve(this.take(bytes));
    }
    return this.queue.wait(
      { bytes },
      {
        signal,
        ms: this.waitMs,
        onTimeout: () => busy('No room to collect the Radicle result'),
      }
    );
  }

  take(bytes) {
    this.held += bytes;
    return once(() => {
      this.held -= bytes;
      this.admit();
    });
  }

  admit() {
    for (;;) {
      const front = this.queue.front();
      if (!front || this.held + front.bytes > this.limit) return;
      this.queue.shift().resolve(this.take(front.bytes));
    }
  }
}

/**
 * The other callers' slots: `take({ signal })` resolves to the function
 * that gives the slot back, once one of `max` is free, waiting in arrival
 * order; with `maxWaiting` already waiting, `busy` at once.
 */
class CallerSlots {
  constructor({ max, maxWaiting, setTimer, clearTimer }) {
    this.max = max;
    this.maxWaiting = maxWaiting;
    this.outstanding = 0;
    this.queue = new WaitQueue({ setTimer, clearTimer });
  }

  take({ signal = null } = {}) {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.queue.length === 0 && this.outstanding < this.max) {
      return Promise.resolve(this.slot());
    }
    if (this.queue.length >= this.maxWaiting) {
      return Promise.reject(busy('Too many Radicle requests are waiting'));
    }
    return this.queue.wait({}, { signal });
  }

  slot() {
    this.outstanding += 1;
    return once(() => {
      this.outstanding -= 1;
      this.admit();
    });
  }

  admit() {
    while (this.queue.length > 0 && this.outstanding < this.max) {
      this.queue.shift().resolve(this.slot());
    }
  }
}

/**
 * `body`, a byte stream, with `release` called once it is over: read to its
 * end, errored, or cancelled.
 */
function releasingBody(body, release) {
  const reader = body.getReader();
  return new ReadableStream(
    {
      async pull(controller) {
        let next;
        try {
          next = await reader.read();
        } catch (err) {
          release();
          controller.error(err);
          return;
        }
        if (next.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      },
      cancel(reason) {
        release();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

class RadicleServiceBackend {
  /**
   * @param {object} options
   * @param {Function} options.node - () => the running node
   *   (radicled-node.js's RadicledNode), or null
   * @param {number} [options.budgetBytes] - the collection budget
   * @param {number} [options.reserveWaitMs] - how long a call waits for it
   * @param {number} [options.maxOutstanding] - the other callers' requests
   *   at the service
   * @param {number} [options.maxWaiting] - and waiting in main
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor({
    node = () => null,
    budgetBytes = COLLECTION_BUDGET_BYTES,
    reserveWaitMs = RESERVE_WAIT_MS,
    maxOutstanding = MAX_OUTSTANDING,
    maxWaiting = MAX_WAITING,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.node = node;
    this.budget = new CollectionBudget({
      limit: budgetBytes,
      waitMs: reserveWaitMs,
      setTimer,
      clearTimer,
    });
    this.slots = new CallerSlots({
      max: maxOutstanding,
      maxWaiting,
      setTimer,
      clearTimer,
    });
    // The progress clones in flight, by RID, as `cancelClone` finds them:
    // rid -> Set of their cancels.
    this.clones = new Map();
  }

  /**
   * A read passed through: `{ head: { content_type, bytes }, body }`, `body`
   * a byte stream of exactly `bytes` bytes of JSON. Until the body is over
   * (read to its end, cancelled or failed), the read holds one of the other
   * callers' slots.
   */
  async callStream(op, args = {}, { signal = null } = {}) {
    const release = await this.slots.take({ signal });
    let read;
    try {
      read = await this.read(op, args, signal);
    } catch (err) {
      release();
      throw err;
    }
    // An abort errors the body: the slot goes back then, read or not.
    const over = once(() => {
      signal?.removeEventListener('abort', over);
      release();
    });
    signal?.addEventListener('abort', over, { once: true });
    if (signal?.aborted) over();
    return { head: read.head, body: releasingBody(read.body, over) };
  }

  /** `rad.read` on the running node: its head, checked, and its body. */
  async read(op, args, signal) {
    const node = this.node();
    if (!node) throw new CoreError('stopped', NOT_RUNNING);
    const { result, body } = await node.read(op, args, { signal });
    if (
      !body ||
      !isObject(result) ||
      result.content_type !== 'application/json' ||
      !Number.isSafeInteger(result.bytes) ||
      result.bytes < 0
    ) {
      await body?.cancel().catch(() => {});
      throw badReply('without a JSON head');
    }
    return { head: { content_type: result.content_type, bytes: result.bytes }, body };
  }

  /**
   * A collected result, parsed in a scope: resolves to what `scope(value,
   * { signal })` resolves to. Only the ops in COLLECTED_CAPS, each under
   * its cap; see the module's doc for the budget and ownership.
   */
  async callScoped(op, args, scope, { signal = null } = {}) {
    return this.scoped(op, args, scope, { signal, leaves: false });
  }

  /**
   * A collected `identity` or `status` that outlives its scope, uncharged
   * from then on: only one whose JSON is under 4 KiB (0008, "JSON
   * results"); a larger one is `too_large`. Every other result is used
   * inside `callScoped`.
   */
  keep(op, args, { signal = null } = {}) {
    if (!KEEPABLE.has(op)) {
      return Promise.reject(
        new CoreError('invalid_argument', `${op}'s value can't outlive its scope: use callScoped`)
      );
    }
    const scope = (value, { bytes }) => {
      if (bytes >= KEEP_BYTES) {
        throw new CoreError(
          'too_large',
          `${op}'s value is ${bytes} bytes; only one under ${KEEP_BYTES} outlives its scope`
        );
      }
      return value;
    };
    return this.scoped(op, args, scope, { signal, leaves: true });
  }

  /** callScoped's work; `leaves` lets the value itself out (`keep`). */
  async scoped(op, args, scope, { signal, leaves }) {
    const cap = Object.hasOwn(COLLECTED_CAPS, op) ? COLLECTED_CAPS[op] : null;
    if (cap === null) {
      throw new CoreError('invalid_argument', `${op} isn't a collected result: stream it`);
    }
    if (typeof scope !== 'function') throw new TypeError('callScoped needs a scope');
    let release = null;
    let value;
    let bytes;
    let reader = null;
    try {
      const { head, body } = await this.callStream(op, args, { signal });
      reader = body.getReader();
      bytes = head.bytes;
      if (bytes > cap) throw tooLarge(op, cap);
      release = await this.budget.reserve(bytes * CHARGE_PER_BYTE, { signal });
      value = await collect(reader, bytes);
      reader = null;
      if (signal?.aborted) throw cancelled();
    } catch (err) {
      reader?.cancel().catch(() => {});
      release?.();
      throw err;
    }
    // The handoff: the scope owns the value, and its reservation stays
    // until the scope settles. The value doesn't leave it.
    let result;
    try {
      result = await scope(value, { signal, bytes });
    } finally {
      release();
    }
    if (!leaves && result === value && typeof value === 'object' && value !== null) {
      throw new CoreError('invalid_argument', `${op}'s value can't leave its scope: use it there`);
    }
    return result;
  }

  /**
   * `rad.connect_seeds { timeout_ms }` on the running node: today's report,
   * the object libradicle's `json::seed_report` writes. One of the other
   * callers' slots until its answer.
   */
  async connectSeeds(timeoutMs, { signal = null } = {}) {
    return this.withSlot(signal, async (node) => {
      const report = await node.connectSeeds(timeoutMs, { signal });
      if (!isObject(report)) throw badNetworkReply('rad.connect_seeds');
      return report;
    });
  }

  /** A clone of `rid`, without progress (the manager's background clone):
   * `{ ok: true }`. `cancelClone` doesn't find it, as it found no such
   * clone on the add-on. */
  cloneRepo(rid, timeoutMs) {
    return this.clone(rid, timeoutMs, null);
  }

  /**
   * A clone of `rid` with progress: `onProgress(text)` for each event, its
   * JSON text, until the clone settles, `{ ok: true }` or `{ cancelled: true
   * }` (`cancelClone`).
   */
  cloneRepoWithProgress(rid, timeoutMs, onProgress) {
    if (typeof onProgress !== 'function') {
      return Promise.reject(new TypeError('cloneRepoWithProgress needs a progress callback'));
    }
    return this.clone(rid, timeoutMs, onProgress);
  }

  /**
   * Cancels the progress clones of `rid` in flight: `{ cancelled }`, whether
   * there was one. They settle once they stop.
   */
  cancelClone(rid) {
    const cancels = this.clones.get(rid);
    if (!cancels) return { cancelled: false };
    for (const cancel of cancels) cancel.abort();
    return { cancelled: true };
  }

  /** `rad.clone` on the running node; with `onProgress`, registered under
   * `rid` for `cancelClone` until it settles. */
  async clone(rid, timeoutMs, onProgress) {
    const cancel = onProgress ? new AbortController() : null;
    const signal = cancel?.signal ?? null;
    if (cancel) this.register(rid, cancel);
    try {
      return await this.withSlot(signal, async (node) =>
        cloneOutcome(await node.clone(rid, timeoutMs, { onProgress, signal }))
      );
    } catch (err) {
      // Main's cancel before the clone started: the slot's wait, or the
      // service, answered `cancelled`. Nothing was fetched.
      if (signal?.aborted && err?.code === 'cancelled') return { cancelled: true };
      throw err;
    } finally {
      if (cancel) this.unregister(rid, cancel);
    }
  }

  register(rid, cancel) {
    let cancels = this.clones.get(rid);
    if (!cancels) {
      cancels = new Set();
      this.clones.set(rid, cancels);
    }
    cancels.add(cancel);
  }

  unregister(rid, cancel) {
    const cancels = this.clones.get(rid);
    if (!cancels) return;
    cancels.delete(cancel);
    if (cancels.size === 0) this.clones.delete(rid);
  }

  /** `work(node)` on the running node, holding one of the other callers'
   * slots until it settles; `signal` gives up the wait for one. */
  async withSlot(signal, work) {
    const release = await this.slots.take({ signal });
    try {
      const node = this.node();
      if (!node) throw new CoreError('stopped', NOT_RUNNING);
      return await work(node);
    } finally {
      release();
    }
  }

  /** The collection budget's use: `{ held, limit }`, in bytes. */
  collectionBudget() {
    return { held: this.budget.held, limit: this.budget.limit };
  }

  /** The other callers' requests: `{ outstanding, waiting }`. */
  callers() {
    return { outstanding: this.slots.outstanding, waiting: this.slots.queue.length };
  }

  /** What main holds for the node's streams: `{ streams, buffered }`, its
   * bodies open and the bytes their rings hold. */
  streamStats() {
    const stats = this.node()?.streamStats() ?? null;
    return stats
      ? { streams: stats.bodies, buffered: stats.ringBytes }
      : { streams: 0, buffered: 0 };
  }
}

/**
 * Reads `reader` to its end, exactly `bytes` bytes of JSON, as text. It is
 * decoded chunk by chunk, so no copy of the whole body is made beside it.
 */
async function readText(reader, bytes) {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > bytes) throw badReply('with a body longer than its head said');
    text += decoder.write(value);
  }
  if (received !== bytes) throw badReply('with a body shorter than its head said');
  return text + decoder.end();
}

/** Reads `reader` to its end, exactly `bytes` bytes of JSON, and parses it. */
async function collect(reader, bytes) {
  const text = await readText(reader, bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw badReply('with a body that is not JSON');
  }
}

module.exports = {
  RadicleServiceBackend,
  CollectionBudget,
  CallerSlots,
  COLLECTED_CAPS,
  COLLECTION_BUDGET_BYTES,
  RESERVE_WAIT_MS,
  CHARGE_PER_BYTE,
  KEEPABLE,
  KEEP_BYTES,
  MAX_OUTSTANDING,
  MAX_WAITING,
  // How a collected body is decoded, for the heap measurement.
  readText,
};
