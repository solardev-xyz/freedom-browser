/**
 * Admission for dweb fetches in main (freedom-core design 0006, "Deadlines,
 * cancel and bounds"; deviation `fetch-admission`).
 *
 * At most 256 fetches are active across sessions, and 512 wait for a slot; a
 * request beyond that gets 503 at once. A fetch is active from its admission
 * until it is over: its body ended, errored or was cancelled, or it had none.
 * It owns its node handle, its sniff buffer and its retry state, and frees
 * them on every terminal path, the session closing included: a private
 * window's fetches, waiting or active, are stopped when its session goes.
 *
 * Only plans bound for a node take a slot; a redirect or an error plan is
 * answered without one.
 *
 * A request's session is fenced from its handler's entry, before anything is
 * planned (`fence`): a closing session aborts every fence it holds, so a
 * request still planning, waiting or streaming stops, and a closed session
 * fences and admits nothing more. Private partitions are never reused, so
 * the closed ones are remembered for the process's lifetime: one name per
 * private window closed.
 */

const MAX_ACTIVE = 256;
const MAX_WAITING = 512;

/** No slot and no room to wait: the request is answered 503 at once. */
class AdmissionFull extends Error {
  constructor() {
    super('Too many dweb requests');
    this.name = 'AdmissionFull';
    this.code = 'admission_full';
  }
}

function abortError(message = 'The operation was aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * @param {{maxActive?: number, maxWaiting?: number}} [limits]
 */
function createFetchAdmission({ maxActive = MAX_ACTIVE, maxWaiting = MAX_WAITING } = {}) {
  let active = 0;
  const waiting = [];
  // A session's active fetches, by partition (null: the default session),
  // each with the controller that stops it when the session closes.
  const sessions = new Map();
  // Each session's fenced requests, by partition, and the partitions closed.
  const fences = new Map();
  const closed = new Set();
  const isClosed = (partition) => partition !== null && closed.has(partition);

  /**
   * Fences one request to its session, from its handler's entry: `signal`
   * aborts when the session closes; `dispose` (idempotent) ends the fence
   * once the request is over. Throws an AbortError for a session already
   * closed.
   */
  function fence(partition = null) {
    if (isClosed(partition)) throw abortError('The session closed');
    const controller = new AbortController();
    let held = fences.get(partition);
    if (!held) {
      held = new Set();
      fences.set(partition, held);
    }
    held.add(controller);
    return {
      signal: controller.signal,
      dispose() {
        held.delete(controller);
        if (held.size === 0 && fences.get(partition) === held) fences.delete(partition);
      },
    };
  }

  function grant(partition, waited) {
    active += 1;
    const stop = new AbortController();
    let fetches = sessions.get(partition);
    if (!fetches) {
      fetches = new Set();
      sessions.set(partition, fetches);
    }
    fetches.add(stop);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      fetches.delete(stop);
      if (fetches.size === 0 && sessions.get(partition) === fetches) sessions.delete(partition);
      pump();
    };
    return { release, stop: stop.signal, waited };
  }

  function pump() {
    while (active < maxActive && waiting.length > 0) {
      const entry = waiting.shift();
      entry.detach();
      entry.resolve(grant(entry.partition, true));
    }
  }

  function dequeue(entry) {
    const at = waiting.indexOf(entry);
    if (at >= 0) waiting.splice(at, 1);
    entry.detach();
  }

  /**
   * A slot for one fetch: `{ release, stop, waited }`, once one is free.
   * `stop` aborts when the fetch's session closes; `release` frees the slot
   * (idempotent). Rejects at once with `AdmissionFull` when the queue is
   * full, and with an AbortError when `signal` aborts or the session closes
   * while it waits.
   *
   * @param {{partition?: string|null, signal?: AbortSignal|null}} [request]
   */
  function acquire({ partition = null, signal = null } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    // A closed session admits nothing more, however late its request asks.
    if (isClosed(partition)) return Promise.reject(abortError('The session closed'));
    if (active < maxActive && waiting.length === 0) {
      return Promise.resolve(grant(partition, false));
    }
    if (waiting.length >= maxWaiting) return Promise.reject(new AdmissionFull());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        dequeue(entry);
        reject(abortError());
      };
      const entry = {
        partition,
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(entry);
    });
  }

  /** A session has closed: its fenced requests are stopped wherever they
   * are, its waiting fetches refused and its active ones stopped, and it
   * fences and admits nothing more. Each active fetch frees its slot as it
   * ends. */
  function closeSession(partition) {
    if (partition !== null) closed.add(partition);
    for (const controller of [...(fences.get(partition) || [])]) {
      controller.abort(abortError('The session closed'));
    }
    for (const entry of waiting.filter((waiter) => waiter.partition === partition)) {
      dequeue(entry);
      entry.reject(abortError('The session closed'));
    }
    for (const stop of sessions.get(partition) || []) {
      stop.abort(abortError('The session closed'));
    }
  }

  return {
    fence,
    acquire,
    closeSession,
    stats: () => ({ active, waiting: waiting.length }),
  };
}

const admission = createFetchAdmission();

module.exports = {
  fenceDwebSession: (partition) => admission.fence(partition),
  acquireDwebFetch: (request) => admission.acquire(request),
  closeDwebSession: (partition) => admission.closeSession(partition),
  dwebFetchStats: () => admission.stats(),
  createFetchAdmission,
  AdmissionFull,
  MAX_ACTIVE,
  MAX_WAITING,
};
