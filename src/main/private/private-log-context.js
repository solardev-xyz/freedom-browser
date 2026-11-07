/**
 * PRIVATE MODE GUARD (dweb protocol + name-resolution logging).
 *
 * `log.info`/`log.warn` land in the persistent <userData>/logs/main.log,
 * which outlives the private window and the app. The dweb protocol
 * handlers (bzz:/ipfs:/ipns:/rad:) and the name resolvers behind them
 * (ENS/WNS/GNS, Tezos Domains) interpolate the requested URL — and the
 * resolved name and target — straight into that log, which is exactly the
 * history-grade trace private windows exist to prevent.
 *
 * Those layers are session-agnostic by design: a resolver is a pure
 * name→contenthash function shared by every window, and threading an
 * `isPrivate` flag through every hop (protocol handler → content-name
 * resolver → ENS resolver → the naming core's driver) would mean a dozen
 * signature changes where a single missed hop is a silent leak.
 *
 * Instead the two entry points that DO know the session mark the whole
 * async subtree once:
 *   - the protocol handlers, at registration time (a private session gets
 *     its own handler registration — see src/main/index.js), and
 *   - the ENS/name IPC handlers, from `event.sender`.
 * Everything they call — across `await`s, timers and promise chains —
 * then sees `isPrivateLogContext()`, and each log site redacts its
 * browsing-identifying values through `redactForLog()`.
 *
 * Name resolution itself runs in the naming core (freedom-core design
 * 0004), which logs no names; the driver still tells it, with each lookup,
 * whether the lookup is private.
 *
 * The same marker picks Colibri's store (src/main/ens/colibri-resolver.js,
 * #1058): a read in a private context runs on the chain's private worker,
 * whose verifier store is in memory only, instead of the one on disk under
 * <userData>/colibri. Colibri's reads come from the cores' `shell.verified`
 * requests, which name the requests of main's they serve (freedom-core
 * #285): core/service-client.js `privacyOf` tells from those whether one
 * serves a private window, and core/naming-verified.js `runVerified` sets
 * the marker from it.
 */

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

// The private session (#1058): from the first private window opening to the
// last one closing (private-windows.js). A private context remembers the
// session it was entered in, or none when no private window was open then,
// so work that outlives its session can tell (`privateSessionLive`):
// Colibri's private store must not take a read from a session that ended.
let session = 0;
let sessionOpen = false;

/**
 * Run `fn` with the private-logging context set when `isPrivate`, so every
 * log site reached from it (however deep, however async) redacts.
 * Returns whatever `fn` returns — including its promise.
 */
function runWithPrivateLogContext(isPrivate, fn) {
  if (!isPrivate) return fn();
  return store.run({ session: sessionOpen ? session : null }, fn);
}

/**
 * Run `fn` with the marker set to exactly `isPrivate`, either way: unlike
 * `runWithPrivateLogContext`, a false one also leaves a private context. A
 * private one belongs to `session`, the private session its work was
 * entered in (`privateContextSession` where it was), or to none. For code
 * that learns the window some other way than its caller's async context:
 * the core's requests (core/naming-verified.js `runVerified`).
 */
function runWithLogContext(isPrivate, fn, session = null) {
  return store.run(isPrivate === true ? { session: session ?? null } : null, fn);
}

/**
 * The private session the current private context was entered in, or null:
 * for a normal context, and for a private one entered with no private
 * window open. A request that leaves main carries it (core/service-client.js).
 */
function privateContextSession() {
  return isPrivateLogContext() ? store.getStore().session : null;
}

/** True when the current async context serves a private window. */
function isPrivateLogContext() {
  const context = store.getStore();
  return typeof context === 'object' && context !== null;
}

/**
 * True when the current async context is private and was entered in the
 * private session that is still open. False for a normal context, and for
 * a private one whose session has ended (or that began with none open).
 */
function privateSessionLive() {
  if (!isPrivateLogContext()) return false;
  const entered = store.getStore().session;
  return sessionOpen && entered !== null && entered === session;
}

/** A private window opened: the private session is open (idempotent). */
function openPrivateSession() {
  sessionOpen = true;
}

/** The last private window closed: its session has ended. */
function endPrivateSession() {
  if (!sessionOpen) return;
  sessionOpen = false;
  session += 1;
}

/**
 * The value to log: the real thing normally, a placeholder when the
 * current async context serves a private window.
 */
function redactForLog(value, placeholder = '<private>') {
  return isPrivateLogContext() ? placeholder : value;
}

/**
 * The full URL normally; in a private context, only the part that says
 * *which transport or gateway* was involved — never where the user went.
 * `bzz://secret.eth/x` → `bzz://<private>`, and a gateway URL
 * `http://localhost:1633/bzz/<hash>` → `http://localhost:1633/<private>`
 * (the hash is the content reference, i.e. the secret).
 */
function redactUrlForLog(rawUrl, placeholder = '<private>') {
  if (!isPrivateLogContext()) return rawUrl;
  if (!rawUrl || typeof rawUrl !== 'string') return placeholder;
  try {
    const parsed = new URL(rawUrl);
    // Non-special schemes (bzz:, ipfs:, ipns:, rad:) have no origin.
    if (!parsed.origin || parsed.origin === 'null') return `${parsed.protocol}//<private>`;
    return `${parsed.origin}/<private>`;
  } catch {
    const scheme = rawUrl.split('://')[0];
    return scheme && scheme !== rawUrl ? `${scheme}://<private>` : placeholder;
  }
}

/**
 * Build a dweb protocol handler's semantic `{ ok: false }` failure with two
 * texts that cannot drift apart:
 *  - `message`    — returned to the page in the JSON error body. The page
 *                   already knows the name it asked for, so it stays whole.
 *  - `logMessage` — headed for the persistent main.log, where a private
 *                   window's destination must never appear.
 *
 * `build` is called twice with the same template: once with the real
 * browsing-identifying values (the requested name, a resolver's own error
 * text) and once with each of them passed through `redactForLog`. Editing
 * the wording therefore updates both variants at once — the failure mode
 * that let `built.message` carry an ENS name into main.log beside the
 * `<private>` marker for the request URL.
 *
 * Failures with nothing browsing-identifying to hide ("Swarm node is not
 * ready") call it with no values and get identical texts; the log sites
 * fail closed and redact wholesale for any failure that supplies no
 * `logMessage` at all.
 */
function redactedFailure(status, build, ...browsingValues) {
  return {
    ok: false,
    status,
    message: build(...browsingValues),
    logMessage: build(...browsingValues.map((value) => redactForLog(value))),
  };
}

/**
 * A transport error's code for the persistent log (`ECONNREFUSED`,
 * `UND_ERR_SOCKET`, `native_gateway_error`), or '' when it has none shaped
 * like one. The dweb transports log this instead of the error's message,
 * whose text can carry the URL or path that was fetched — in a normal
 * window as much as in a private one.
 */
function errorCodeForLog(err) {
  const code = err?.cause?.code || err?.code;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_:.-]{0,63}$/.test(code) ? code : '';
}

module.exports = {
  runWithPrivateLogContext,
  runWithLogContext,
  isPrivateLogContext,
  privateContextSession,
  privateSessionLive,
  openPrivateSession,
  endPrivateSession,
  redactForLog,
  redactUrlForLog,
  redactedFailure,
  errorCodeForLog,
};
