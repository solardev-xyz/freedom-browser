/**
 * Settles as `promise` does, or rejects with the abort as `signal` aborts
 * first: a wait the caller can always leave, even on work that ignores the
 * abort (a session's proxy lookup, a configuration barrier). The promise is
 * observed whichever wins, so a rejection that comes after the abort is
 * never left unhandled.
 *
 * Shared by naming's hops (`core/naming-shell.js`), the naming driver's
 * waits and the `bzz:` handler's remote Ant dial.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function unlessAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { unlessAborted };
