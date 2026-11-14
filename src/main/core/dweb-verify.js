/**
 * Main's side of the core's `dweb.verify` and `dweb.forget` (freedom-core
 * design 0009): what the `{ verify }` plans' executor (dweb/
 * verify-executor.js) sends through, and the private partitions' end.
 *
 * - **Protocol 2.** `attachDwebVerify` attaches a verifier to the core
 *   client, which speaks only protocol 2 (the pinned core, 0.15.0, refuses
 *   1), beside dweb-shell.js's `shell.dweb_get`, so the app's client has
 *   it. Without one (no core, or no dweb shell) `dwebVerifier()` is null:
 *   a `{ verify }` plan is refused, and nothing is sent when a partition
 *   closes.
 * - **`send`** writes `dweb.verify` to the core process that made the plan,
 *   with a hang watchdog of the head deadline and 0001's margin, and opens
 *   its pieces' context in dweb-shell.js under the envelope ID and
 *   generation the client reports as it writes it (`onSent`), so a
 *   `shell.dweb_get` naming it is served from this request's backend,
 *   plan, page signal and session. `close()` ends that context; the
 *   request's end calls it.
 * - **`dweb.forget { partition }`** goes to the core once a private
 *   partition closes (`onDwebSessionClosed`, after its requests were
 *   stopped), so the core drops the partition's structure cache and IPNS
 *   floors. A core that isn't serving gets nothing: a restarted core holds
 *   nothing of the partition, and an exited one nothing at all. A failure
 *   is logged by its code; a partition's name is never logged.
 */

const defaultLog = require('../logger');
const { WATCHDOG_MARGIN_MS, IMMEDIATE_WATCHDOG_MS } = require('./core-deadlines');
const { onDwebSessionClosed } = require('../dweb/fetch-admission');

class DwebVerifier {
  /**
   * @param {object} options
   * @param {import('./core-client').CoreClient} options.client
   * @param {import('./dweb-shell').DwebShell} options.shell
   * @param {object} [options.log]
   */
  constructor({ client, shell, log = defaultLog }) {
    this.client = client;
    this.shell = shell;
    this.log = log;
  }

  /**
   * Sends `dweb.verify` to `gen`: `{ head, close }`. `head` resolves to the
   * client's `{ result, body }` (the body a byte stream when the head says
   * `body: true`) or rejects with the request's failure; `close()` ends its
   * pieces' context.
   *
   * @param {object} gen - the core process that made the plan
   * @param {object} params - `dweb.verify`'s params
   * @param {object} capture - dweb-shell.js `open()`'s: `backend`, `plan`,
   *   `signal`, `stop`
   * @param {AbortSignal|null} signal - the request's life: cancels it
   */
  send(gen, params, capture, signal) {
    let handle = null;
    let closed = false;
    const close = () => {
      closed = true;
      handle?.close();
      handle = null;
    };
    const head = this.client.requestStreamTo(
      gen,
      'dweb.verify',
      params,
      { caller: 'shell' },
      {
        signal,
        watchdogMs: params.deadline_ms + WATCHDOG_MARGIN_MS,
        onSent: (id, generation) => {
          if (closed) return;
          try {
            handle = this.shell.open({ id, generation }, capture);
          } catch (err) {
            // Its pieces are refused, and the core answers its error plan.
            this.log.error(`[Core] dweb.verify's pieces can't be served: ${err.message}`);
          }
        },
      }
    );
    return { head, close };
  }

  /**
   * `dweb.forget` for a closed private partition: true once the core has
   * dropped what it held of it, false when no core serves or it failed.
   *
   * @param {string} partition
   * @returns {Promise<boolean>}
   */
  forget(partition) {
    const gen = this.client.current;
    if (!this.client.serves(gen)) return Promise.resolve(false);
    return this.client
      .requestTo(
        gen,
        'dweb.forget',
        { partition },
        { caller: 'shell' },
        { watchdogMs: IMMEDIATE_WATCHDOG_MS }
      )
      .then(
        () => true,
        (err) => {
          if (err?.code !== 'core_unavailable') {
            this.log.warn(`[Core] dweb.forget failed (${err?.code || 'error'})`);
          }
          return false;
        }
      );
  }
}

let verifier = null;
let unlisten = null;

/**
 * Attaches the verifier to `client` when it has the dweb shell, and sends `dweb.forget` for each private partition that
 * closes from then on. The verifier, or null.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {import('./dweb-shell').DwebShell|null} shell - registerDwebShell's
 * @param {object} [deps] - test seams: log, onSessionClosed
 * @returns {DwebVerifier|null}
 */
function attachDwebVerify(client, shell, deps = {}) {
  detachDwebVerify();
  if (!shell) return null;
  const { onSessionClosed = onDwebSessionClosed, ...rest } = deps;
  const attached = new DwebVerifier({ client, shell, ...rest });
  verifier = attached;
  unlisten = onSessionClosed((partition) => {
    // The profile's session never closes while the core runs; only a
    // private partition's cache is forgotten.
    if (partition !== null) attached.forget(partition);
  });
  return attached;
}

function detachDwebVerify() {
  unlisten?.();
  unlisten = null;
  verifier = null;
}

/** The attached verifier, or null (no core, or no dweb shell). */
function dwebVerifier() {
  return verifier;
}

module.exports = {
  DwebVerifier,
  attachDwebVerify,
  detachDwebVerify,
  dwebVerifier,
};
