/**
 * Shared dispatcher for Electron `session.webRequest` events.
 *
 * Electron allows exactly one listener per `webRequest` event per session;
 * registering a second listener silently replaces the first. As the browser
 * grows new features that need to observe / intercept requests (the bzz /
 * rad request rewriter, x402 payment interception, future devtools, …) we
 * need a single owner per event that fans out to multiple consumers.
 *
 * Semantics per event:
 *
 * - `onBeforeRequest`: handlers run in registration order. The first to
 *   return a result with `cancel` or `redirectURL` wins; subsequent
 *   handlers are skipped. A handler that returns `null` / `undefined` /
 *   `{}` passes the request through.
 *
 * - `onBeforeSendHeaders`: handlers chain — each sees the request headers
 *   as accumulated by previous handlers and may return new
 *   `requestHeaders` (full replacement). A `cancel:true` from any handler
 *   short-circuits to a cancel.
 *
 * - `onHeadersReceived`: same chaining shape as `onBeforeSendHeaders` but
 *   for response headers + status line. A `cancel:true` or `redirectURL`
 *   short-circuits.
 *
 * - `onCompleted` / `onErrorOccurred`: notification-only fan-out. Handlers
 *   run in registration order; return values are ignored (Electron's
 *   listener signature for these events has no callback). Useful for
 *   per-request lifecycle cleanup (e.g. x402's request-context map).
 *
 * Handlers may be async; the dispatcher awaits each before calling the
 * next, preserving the "first match wins" semantics across handler I/O.
 * Filtering is the handler's responsibility — the dispatcher attaches
 * with no URL filter so each handler sees every request.
 *
 * Handlers that throw are logged and skipped; subsequent handlers still
 * run and the request is not cancelled. A buggy consumer must not be
 * able to break the browser's request chain.
 */

const log = require('./logger');

const EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onHeadersReceived',
  'onCompleted',
  'onErrorOccurred',
];

const handlers = {
  onBeforeRequest: [],
  onBeforeSendHeaders: [],
  onHeadersReceived: [],
  onCompleted: [],
  onErrorOccurred: [],
};

/**
 * Register a handler for a webRequest event.
 *
 * @param {'onBeforeRequest'|'onBeforeSendHeaders'|'onHeadersReceived'|'onCompleted'|'onErrorOccurred'} event
 * @param {string} name - Identifier used for error logging; must be unique
 *   per event so re-registration is loud, not silent.
 * @param {(details: object) => null | undefined | object | Promise<null | undefined | object>} handler
 */
function registerWebRequestHandler(event, name, handler) {
  if (!handlers[event]) {
    throw new Error(`Unsupported webRequest event: ${event}`);
  }
  if (handlers[event].some((entry) => entry.name === name)) {
    throw new Error(`webRequest handler '${name}' already registered for ${event}`);
  }
  handlers[event].push({ name, handler });
}

function makeOnBeforeRequestListener(eventHandlers) {
  return async (details, callback) => {
    for (const { name, handler } of eventHandlers) {
      let result;
      try {
        result = await handler(details);
      } catch (err) {
        log.error(`[dispatcher:${name}] onBeforeRequest threw: ${err.message}`);
        continue;
      }
      if (result && (result.cancel || result.redirectURL)) {
        callback(result);
        return;
      }
    }
    callback({});
  };
}

function makeHeaderChainListener(eventHandlers, eventName, headersKey) {
  return async (details, callback) => {
    let headers = details[headersKey];
    let statusLine = details.statusLine;
    for (const { name, handler } of eventHandlers) {
      let result;
      try {
        result = await handler({ ...details, [headersKey]: headers, statusLine });
      } catch (err) {
        log.error(`[dispatcher:${name}] ${eventName} threw: ${err.message}`);
        continue;
      }
      if (!result) continue;
      if (result.cancel) {
        callback({ cancel: true });
        return;
      }
      if (result.redirectURL) {
        callback({ redirectURL: result.redirectURL });
        return;
      }
      if (result[headersKey]) headers = result[headersKey];
      if (result.statusLine) statusLine = result.statusLine;
    }
    const out = { [headersKey]: headers };
    if (statusLine) out.statusLine = statusLine;
    callback(out);
  };
}

// Fan-out factory for notification-only events; see file header for
// semantics. Synchronous on purpose: Electron's listener signature has
// no callback, observers can't observe each other's results, and these
// events fire on every request — awaiting each handler would allocate
// a Promise per handler per request for no observable benefit. Sync
// handlers stay on the synchronous stack; thenables get a fire-and-
// forget `.catch` so async errors still surface.
function makeNotificationListener(eventHandlers, eventName) {
  return (details) => {
    for (const { name, handler } of eventHandlers) {
      try {
        const result = handler(details);
        if (result && typeof result.then === 'function') {
          result.catch((err) => log.error(`[dispatcher:${name}] ${eventName} threw: ${err.message}`));
        }
      } catch (err) {
        log.error(`[dispatcher:${name}] ${eventName} threw: ${err.message}`);
      }
    }
  };
}

/**
 * Attach one Electron listener per registered event to the given session.
 *
 * Idempotent across registration churn in tests but should be called
 * exactly once per session at startup, after every consumer has registered.
 *
 * `options.exclude` filters registered handlers by name — a predicate
 * `(name) => boolean` returning true drops that handler from this session's
 * chain. Private windows use this to attach the request rewriter without
 * the x402 payment interception (see src/main/index.js).
 *
 * @param {Electron.Session} session
 * @param {{ exclude?: (name: string) => boolean }} [options]
 */
function attachWebRequestDispatcher(session, options = {}) {
  const exclude = typeof options.exclude === 'function' ? options.exclude : null;
  const select = (event) =>
    exclude ? handlers[event].filter((entry) => !exclude(entry.name)) : handlers[event];

  const onBeforeRequest = select('onBeforeRequest');
  if (onBeforeRequest.length > 0) {
    session.webRequest.onBeforeRequest(makeOnBeforeRequestListener(onBeforeRequest));
  }
  const onBeforeSendHeaders = select('onBeforeSendHeaders');
  if (onBeforeSendHeaders.length > 0) {
    session.webRequest.onBeforeSendHeaders(
      makeHeaderChainListener(onBeforeSendHeaders, 'onBeforeSendHeaders', 'requestHeaders')
    );
  }
  const onHeadersReceived = select('onHeadersReceived');
  if (onHeadersReceived.length > 0) {
    session.webRequest.onHeadersReceived(
      makeHeaderChainListener(onHeadersReceived, 'onHeadersReceived', 'responseHeaders')
    );
  }
  const onCompleted = select('onCompleted');
  if (onCompleted.length > 0) {
    session.webRequest.onCompleted(makeNotificationListener(onCompleted, 'onCompleted'));
  }
  const onErrorOccurred = select('onErrorOccurred');
  if (onErrorOccurred.length > 0) {
    session.webRequest.onErrorOccurred(
      makeNotificationListener(onErrorOccurred, 'onErrorOccurred')
    );
  }
}

/**
 * Clear all handlers. Test-only — Jest's require-cache singleton would
 * otherwise leak handler state between test suites.
 */
function _resetWebRequestHandlers() {
  for (const event of EVENTS) {
    handlers[event] = [];
  }
}

module.exports = {
  registerWebRequestHandler,
  attachWebRequestDispatcher,
  _resetWebRequestHandlers,
};
