/**
 * Admission control for `rad:` repository reads (R-3).
 *
 * Any page can fetch `rad:` URLs, and every one becomes libradicle work:
 * a libuv thread held for the whole read, under the add-on's global node
 * mutex, building a whole blob or diff as one string. Unbounded, one page
 * can queue thousands, stall every other Radicle read (the add-on runs one
 * at a time anyway) and every libuv user in main behind them, and pile the
 * results up in memory.
 *
 * So reads go through here:
 *  - at most IN_FLIGHT run at once, across every window;
 *  - each requester (the requesting tab, in its session) may have at most
 *    PER_REQUESTER waiting, and no more than QUEUE_MAX wait in all; past
 *    that a read is refused at once (503);
 *  - each requester waits in its own FIFO, and a free slot goes to the
 *    requesters in turn (round-robin), not to whoever queued first: a tab
 *    keeping its queue full of slow reads gets one slot per turn, so another
 *    tab's read waits behind at most one read per requester ahead of it,
 *    not behind that tab's whole backlog;
 *  - a read that waits longer than WAIT_MS for a slot is refused (503);
 *  - a read that runs longer than RUN_MS is answered 504. Native work cannot
 *    be cancelled, so its slot stays taken until the add-on returns: the
 *    concurrency bound holds even for reads the page has given up on;
 *  - a read whose page goes away (navigation, tab or window closed: the
 *    request's AbortSignal) leaves the queue without reaching the add-on;
 *  - a running read is handed a work signal, aborted once its caller has
 *    gone or its run time is up. The read starts no native call after
 *    that, and it keeps its slot only until the call it's in returns.
 *
 * Response size is capped by the caller (radicle-api-protocol.js).
 */

const LIMITS = Object.freeze({
  IN_FLIGHT: 2,
  PER_REQUESTER: 8,
  QUEUE_MAX: 32,
  WAIT_MS: 15 * 1000,
  RUN_MS: 30 * 1000,
});

class RadReadRefused extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RadReadRefused';
    this.status = status;
  }
}

class RadReadAborted extends Error {
  constructor() {
    super('The page that asked for this read went away');
    this.name = 'AbortError';
  }
}

function createRadReadAdmission({
  limits = LIMITS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let running = 0;
  let waitingTotal = 0;
  // key -> FIFO of { key, start, reject, cleanup }. Map order is the
  // rotation: the key at the front is served next, then goes to the back
  // if it still has reads waiting.
  const queues = new Map();

  const countFor = (key) => queues.get(key)?.length || 0;

  function enqueue(entry) {
    const queue = queues.get(entry.key);
    if (queue) queue.push(entry);
    else queues.set(entry.key, [entry]);
    waitingTotal += 1;
  }

  function dequeue(entry) {
    const queue = queues.get(entry.key);
    const index = queue ? queue.indexOf(entry) : -1;
    if (index === -1) return false;
    queue.splice(index, 1);
    if (queue.length === 0) queues.delete(entry.key);
    waitingTotal -= 1;
    entry.cleanup();
    return true;
  }

  function takeNext() {
    const [key, queue] = queues.entries().next().value;
    const entry = queue.shift();
    queues.delete(key);
    if (queue.length) queues.set(key, queue); // back of the rotation
    waitingTotal -= 1;
    return entry;
  }

  function pump() {
    while (running < limits.IN_FLIGHT && waitingTotal > 0) {
      const entry = takeNext();
      entry.cleanup();
      entry.start();
    }
  }

  /**
   * Run `read` once a slot is free.
   * @param {string} key - the requester (session and page origin)
   * @param {AbortSignal|undefined} signal - the request's signal
   * @param {(work: AbortSignal) => Promise<T>} read - given a signal that
   *   aborts when the read has ended for its caller (abort or run timeout)
   * @returns {Promise<T>}
   * @throws {RadReadRefused} busy (503) or too slow (504)
   * @throws {RadReadAborted} the page went away first
   */
  function run(key, signal, read) {
    if (signal?.aborted) return Promise.reject(new RadReadAborted());

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const start = () => {
        running += 1;
        let runTimer = null;
        const ended = new AbortController();
        const onAbort = () => {
          ended.abort();
          finish(reject, new RadReadAborted());
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        runTimer = setTimer(() => {
          ended.abort();
          finish(reject, new RadReadRefused(504, 'Radicle read timed out'));
        }, limits.RUN_MS);
        let work;
        try {
          work = Promise.resolve(read(ended.signal));
        } catch (err) {
          work = Promise.reject(err);
        }
        work
          .then(
            (value) => finish(resolve, value),
            (err) => finish(reject, err)
          )
          .finally(() => {
            // The slot is released when the add-on is done, not when the
            // page stopped waiting.
            clearTimer(runTimer);
            signal?.removeEventListener?.('abort', onAbort);
            running -= 1;
            pump();
          });
      };

      if (running < limits.IN_FLIGHT && waitingTotal === 0) {
        start();
        return;
      }
      if (countFor(key) >= limits.PER_REQUESTER || waitingTotal >= limits.QUEUE_MAX) {
        finish(reject, new RadReadRefused(503, 'Too many Radicle reads waiting; try again'));
        return;
      }

      let waitTimer = null;
      let onAbort = null;
      const entry = {
        key,
        start: () => {
          if (!settled) start();
        },
        cleanup: () => {
          clearTimer(waitTimer);
          if (onAbort) signal?.removeEventListener?.('abort', onAbort);
        },
      };
      onAbort = () => {
        if (dequeue(entry)) finish(reject, new RadReadAborted());
      };
      waitTimer = setTimer(() => {
        if (dequeue(entry)) {
          finish(reject, new RadReadRefused(503, 'Radicle is busy; try again'));
        }
      }, limits.WAIT_MS);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      enqueue(entry);
    });
  }

  return {
    run,
    stats: () => ({ running, waiting: waitingTotal }),
  };
}

module.exports = {
  LIMITS,
  RadReadRefused,
  RadReadAborted,
  createRadReadAdmission,
};
