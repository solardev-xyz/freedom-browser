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
 * resolver → ENS resolver → consensus wave → cache-and-log) would mean a
 * dozen signature changes where a single missed hop is a silent leak.
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
 * Deliberate edge: concurrent resolves of the same name share one
 * in-flight promise. If a private caller creates it and a normal window
 * joins, the shared body logs redacted (safe direction — we lose a
 * diagnostic, not a secret). If a normal caller created it first, its own
 * logging already happened in a normal context, and the private joiner's
 * own log line ("joining in-flight resolution") is still redacted.
 */

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/**
 * Run `fn` with the private-logging context set when `isPrivate`, so every
 * log site reached from it (however deep, however async) redacts.
 * Returns whatever `fn` returns — including its promise.
 */
function runWithPrivateLogContext(isPrivate, fn) {
  if (!isPrivate) return fn();
  return store.run(true, fn);
}

/** True when the current async context serves a private window. */
function isPrivateLogContext() {
  return store.getStore() === true;
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

module.exports = {
  runWithPrivateLogContext,
  isPrivateLogContext,
  redactForLog,
  redactUrlForLog,
  redactedFailure,
};
