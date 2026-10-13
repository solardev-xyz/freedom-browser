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

  /** A session has closed: its waiting fetches are refused and its active
   * ones stopped. Each active one frees its slot as it ends. */
  function closeSession(partition) {
    for (const entry of waiting.filter((waiter) => waiter.partition === partition)) {
      dequeue(entry);
      entry.reject(abortError('The session closed'));
    }
    for (const stop of sessions.get(partition) || []) {
      stop.abort(abortError('The session closed'));
    }
  }

  return {
    acquire,
    closeSession,
    stats: () => ({ active, waiting: waiting.length }),
  };
}

const admission = createFetchAdmission();

module.exports = {
  acquireDwebFetch: (request) => admission.acquire(request),
  closeDwebSession: (partition) => admission.closeSession(partition),
  dwebFetchStats: () => admission.stats(),
  createFetchAdmission,
  AdmissionFull,
  MAX_ACTIVE,
  MAX_WAITING,
};
