/**
 * ipfs:// and ipns:// protocol handlers
 *
 * Registers main-process handlers for the `ipfs:` and `ipns:` schemes
 * (standard, secure, streaming, CORS-enabled; see
 * `registerSchemesAsPrivileged` in `src/main/index.js`). Every
 * `ipfs://<cid|name>/<path>` and `ipns://<key|name>/<path>` request —
 * top-level navigation, sub-resource, `fetch`, media `Range`, CSS `url(...)`,
 * service worker — flows through one of these handlers and into the IPFS
 * backend: the embedded freedom-ipfs native request API, or the configured
 * external gateway.
 *
 * Why this lives in the main process and not the renderer's URL pipeline:
 * pinning the page origin to `ipfs://<cid>/` (or `ipfs://<name>/` for
 * Ethereum-name-backed sites) requires Chromium to never see a gateway URL,
 * so DevTools, `window.location`, cookies, storage and service workers all
 * see the content reference rather than a gateway origin.
 *
 * The core plans each request (freedom-core design 0006, `dweb.open`): it
 * canonicalizes CID and IPNS-key hosts (a host Chromium's parser lowercased
 * beyond recovery gets an actionable 400), answers gateway-form URLs with a
 * 307 to their canonical form (O-3), resolves name hosts (a contenthash for
 * another transport is a 404: a typed scheme is user intent), applies the
 * header strip-list, refuses other methods (405), and names the small-text
 * rule for a GET navigation to the native node. Main checks the plan and
 * executes it (`dweb/dweb-handler.js`) against the backend captured when the
 * request is admitted (`ipfs-manager.js` `ipfsBackend`), for the request's
 * partition, whose lease the handler releases on every exit. A single
 * attempt per request: IPFS has no retry contract, and 4xx and 5xx pass
 * through.
 *
 * A capture can be refused for capacity (freedom-core design 0007, "Private
 * windows"): a private partition that needs an instance of its own when
 * every one is pinned by another. `ipfsBackend()` then throws `BackendBusy`,
 * answered 503 before anything is planned, as admission's own is. That is
 * not the 503 of a node that isn't running: `ref.up` stays readiness.
 */

const log = require('../logger');
const { ipfsBackend } = require('../ipfs-manager');
const { handleDwebRequest } = require('../dweb/dweb-handler');
const { jsonErrorResponse } = require('../dweb/plan-executor');
const { BackendBusy } = require('./freedom-ipfsd-node');
const { isPrivateLogContext, runWithPrivateLogContext } = require('../private/private-log-context');

/**
 * Serves one `ipfs:` or `ipns:` request. Exported for tests and harnesses.
 *
 * @param {'ipfs'|'ipns'} namespace - the scheme the handler is registered for
 * @param {Request} request
 * @param {object} [options]
 * @param {string|null} [options.partition] - a private session's partition
 * @param {boolean} [options.isPrivate] - a private window's request
 * @param {Function} [options.requestImpl] - a native node's `request()`, in
 *   place of the running backend's: an up native backend that it serves
 */
function handleRequest(
  namespace,
  request,
  { partition = null, isPrivate = isPrivateLogContext(), requestImpl = null } = {}
) {
  let backend;
  try {
    backend = requestImpl
      ? { ref: { ipfs: 'native', up: true }, url: null, request: requestImpl }
      : ipfsBackend({ partition });
  } catch (err) {
    // The type itself, not its name: any other fault surfaces.
    if (!(err instanceof BackendBusy)) throw err;
    return Promise.resolve(jsonErrorResponse(503, err.message));
  }
  return runWithPrivateLogContext(isPrivate, () =>
    handleDwebRequest(request, { backend, partition, tag: `[${namespace}-protocol]` })
  );
}

/**
 * Build a `register*Protocol(targetSession)` function for the given
 * namespace. Two registrations are exported (ipfs / ipns) so the wire-up
 * in `index.js` mirrors the bzz registration.
 *
 * Call after `app.whenReady()`. Both schemes must already have been
 * registered privileged via `protocol.registerSchemesAsPrivileged` before
 * `app.ready` — see `src/main/index.js`.
 */
function makeRegister(namespace) {
  return function register(targetSession, { privatePartition = null } = {}) {
    if (!targetSession?.protocol?.handle) {
      log.warn(`[${namespace}-protocol] session.protocol.handle unavailable — skipping`);
      return;
    }
    // PRIVATE MODE GUARD (request logging): see registerBzzProtocol — one
    // registration per session, so the private session's handler marks
    // every request it serves as private for the duration.
    const isPrivate = !!privatePartition;
    try {
      targetSession.protocol.handle(namespace, (request) =>
        handleRequest(namespace, request, { partition: privatePartition, isPrivate })
      );
      log.info(`[${namespace}-protocol] handler registered`);
    } catch (err) {
      log.error(`[${namespace}-protocol] failed to register handler:`, err);
    }
  };
}

const registerIpfsProtocol = makeRegister('ipfs');
const registerIpnsProtocol = makeRegister('ipns');

module.exports = {
  registerIpfsProtocol,
  registerIpnsProtocol,
  handleRequest,
};
