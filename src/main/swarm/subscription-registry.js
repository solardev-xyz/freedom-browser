/**
 * Subscription Registry
 *
 * Lifecycle state for window.swarm messaging subscriptions. Maps
 * subscription ids to their origin, the document they are bound to, and
 * the shared node socket that feeds them. Deliberately Electron-free: the socket
 * opener and the message deliverer are injected by provider-ipc, so the
 * registry is pure bookkeeping and fully unit-testable.
 *
 * Multiplexing: the Ant node caps live pull pipelines at a small
 * node-wide pool (8 neighborhoods), so the registry opens at most one
 * socket per (kind, key) on a node and fans messages out to every
 * subscription on it. The socket is closed when its last subscription goes
 * away.
 *
 * Establishment is bounded: the socket layer reconnects forever, so a
 * node that stops answering would otherwise leave a subscription pending
 * for the life of the app while still holding a slot in the per-origin
 * cap. subscribe() gives up after `establishTimeoutMs` and releases
 * everything it allocated.
 *
 * The route (freedom-core design 0015, Messaging, question 4, decided
 * 2026-11-24; SWM-6 to SWM-9's plan, point 10): a subscription's socket is
 * Node's own `WebSocket`, which no session proxy and no Tor carries (F-6,
 * #360). So no socket goes to a node the session would reach through a
 * proxy or Tor. `routeRefusal` is the test, in one function, and the
 * registry runs it for both backends (the JS provider's subscriptions and
 * the ones the core has main open, `shell.swarm_subscribe`):
 * - just before every open, after every wait of the caller's (a GSOC
 *   topic's mining among them): refused, the caller gets reason
 *   `proxy-or-tor`, which the page reads as 4900 `Node not available:
 *   proxy-or-tor`, and no socket is created;
 * - before every reconnect of a socket (`beforeReconnect`, which the socket
 *   layer asks);
 * - when the route may have changed: Tor's state or the node's URL
 *   (`recheckRoutes`, which provider-ipc calls on those changes), and every
 *   ROUTE_RECHECK_MS while a socket to a node not on loopback is open (a
 *   system or PAC proxy changes with no event).
 * A socket the test refuses ends with every subscription on it
 * (`cancelWhere`) and is never reconnected. So does a socket to a node that
 * is no longer the configured one (the node's URL changed, or no node is
 * configured: stopped, disabled, cleared): each socket keeps the URL it
 * dials, and a recheck or a reconnect ends it, before any route test and
 * after every wait, whatever that node's route. The one exception is the
 * bundled node's restart, which ant-manager reports (`restartingUrl`):
 * while no node is configured, a socket to the URL it restarts from dials
 * nothing and asks again at its next try, going ahead only if the node
 * comes back at that URL. A subscription never joins a socket to another
 * node: sockets are shared per node. `checkRoute` gives the same
 * test to the first check, before the caller's waits (`shell.swarm_ready`'s
 * `subscribe`, the JS provider's before its probe). `onRefused` hears each
 * refused open and each subscription a refusal ended, with the site's key
 * and whether Tor or a proxy is in the way (`via`), for the notice the
 * user is shown (SWM-7's PR 7.5).
 */

const crypto = require('crypto');
const { isLoopbackGatewayUrl, isOnionGatewayUrl } = require('../ipfs/gateway-transport');

// A subscription that has not established yet holds a slot but must never
// receive messages (its id hasn't reached the page and, for a socket that
// is still connecting, the page may already be gone).
const DEFAULT_ESTABLISH_TIMEOUT_MS = 30_000;
// How often the route of a socket to a node not on loopback is tested again
// while one is open (question 4).
const ROUTE_RECHECK_MS = 30_000;
// Question 4's reason, and the text a page gets with it (design 0015,
// Messaging: today's unavailable shape).
const PROXY_OR_TOR = 'proxy-or-tor';
const PROXY_OR_TOR_MESSAGE = `Node not available: ${PROXY_OR_TOR}`;

// id → { id, origin, document, deliverTo, kind, key, socketKey, pending,
//        opener, attached, endedBy, onEnd }
//
// A page's subscription through main (freedom-core design 0011, PRQ-7b) is
// bound to its document: `document` names it (`${guest}:${navigation}`),
// `deliverTo(data)` sends it a message, and it ends with the document
// (`cancelByDocument`). `opener` names who else may close it by its id (the
// core's connection, for one `shell.swarm_subscribe` opened:
// `cancelByOpener`); `attached` says it is on its socket; `endedBy` is the
// route refusal that ended it; `onEnd` ends its subscribe()'s wait.
const subscriptions = new Map();
// socketKey (`${kind}:${key}@${url}`, or `${kind}:${key}` with no URL) →
// { handle, subIds: Set, url }, `url` the node it dials (null when the
// socket layer chose it: no route configured).
const sockets = new Map();

let openSocket = null;
let deliver = null;
// configure() owns the real cap (advertised via getCapabilities limits);
// no shadow default here that could drift from it.
let maxSubscriptionsPerOrigin = Infinity;
let establishTimeoutMs = DEFAULT_ESTABLISH_TIMEOUT_MS;
// Question 4's collaborators, `{ nodeUrl(), resolveProxy(url),
// torEndpoint(), restartingUrl() }`, or null where nobody configured them (the bookkeeping's
// unit tests): then no route is tested. provider-ipc configures them at
// startup, before any page can subscribe.
let route = null;
let onRefused = () => {};
let recheckTimer = null;

function semanticError(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

/** The error a refused open answers: reason `proxy-or-tor`, `via` saying what is in the way. */
function proxyOrTorError(refusal) {
  const err = semanticError(PROXY_OR_TOR, PROXY_OR_TOR_MESSAGE);
  err.via = refusal.via;
  return err;
}

/**
 * Question 4's test (design 0015, Messaging; the plan's point 10 and U-1's
 * recommended option), in one place so it is easy to change: may a
 * subscription's socket, which goes around every session proxy and Tor,
 * dial the node at `nodeUrl`? Null when it may: a node on loopback (the
 * bundled one, or an external one at `http://127.0.0.1:1633`), or one the
 * session reaches DIRECT. Otherwise the refusal, `{ reason: 'proxy-or-tor',
 * via }`: `via` is `tor` when what is in the way is Arti's endpoint, and
 * `proxy` for any other proxy. Freedom's Tor carries only `.onion` names
 * (tor-proxy.js), so Tor being on doesn't put a node at a normal address
 * behind it. An onion node is always refused (`tor`): only Tor reaches it,
 * and Node's socket would hand its name to the system resolver. A proxy
 * that can't be resolved is refused (`proxy`): fail closed. No node is
 * none of this test's business (null): the open fails on its own.
 *
 * @param {string|null} nodeUrl - the node's API URL
 * @param {object} deps
 * @param {(url: string) => Promise<string>} deps.resolveProxy - the
 *   session's `resolveProxy`: `DIRECT`, or Chromium's proxy list
 * @param {() => (string|null)} [deps.torEndpoint] - Arti's SOCKS endpoint
 *   (`host:port`) while Tor runs, else null
 * @returns {Promise<null|{reason: string, via: 'tor'|'proxy'}>}
 */
async function routeRefusal(nodeUrl, { resolveProxy, torEndpoint = () => null }) {
  if (typeof nodeUrl !== 'string' || nodeUrl === '') return null;
  if (isLoopbackGatewayUrl(nodeUrl)) return null;
  if (isOnionGatewayUrl(nodeUrl)) return { reason: PROXY_OR_TOR, via: 'tor' };
  let proxies;
  try {
    proxies = String(await resolveProxy(nodeUrl)).trim();
  } catch {
    return { reason: PROXY_OR_TOR, via: 'proxy' };
  }
  if (proxies.toUpperCase() === 'DIRECT') return null;
  // Chromium's list (`SOCKS5 127.0.0.1:19150; DIRECT`): its first entry is
  // what the session dials.
  const first = proxies.split(';')[0].trim().split(/\s+/)[1]?.toLowerCase() ?? '';
  let arti;
  try {
    arti = torEndpoint()?.toLowerCase() ?? null;
  } catch {
    arti = null;
  }
  return { reason: PROXY_OR_TOR, via: arti && first === arti ? 'tor' : 'proxy' };
}

/**
 * The route test for `nodeUrl` now, with the configured collaborators:
 * null to go on, or the refusal. With `origin` (a site's key), a refusal is
 * reported to `onRefused` as a refused open of that site's. Null while no
 * route is configured.
 */
async function checkRoute(nodeUrl, origin = null) {
  if (!route) return null;
  const refusal = await routeRefusal(nodeUrl, route);
  if (refusal && typeof origin === 'string') report(origin, refusal, false);
  return refusal;
}

function report(origin, refusal, ended) {
  try {
    onRefused({ origin, via: refusal.via, ended });
  } catch {
    // The notice never stops the refusal.
  }
}

/**
 * Wire the registry's collaborators. Must be called before subscribe().
 * @param {Object} config
 * @param {(target: {kind, key, url?}, handlers: {onMessage, beforeReconnect?}) => {established, cancel}} config.openSocket -
 *   `url` the node to dial, the one the route test passed; the socket asks
 *   `beforeReconnect()` before each reconnect, and dials again only when it
 *   resolves true (`'later'`: ask again at the next try; anything else:
 *   stop for good)
 * @param {(subscription: Object, payload: Buffer) => void} config.deliver
 * @param {number} config.maxSubscriptionsPerOrigin
 * @param {number} [config.establishTimeoutMs]
 * @param {{nodeUrl: Function, resolveProxy: Function, torEndpoint?: Function, restartingUrl?: Function}|null} [config.route] -
 *   question 4's collaborators (`routeRefusal`): the node's URL now, the
 *   session's `resolveProxy`, Arti's endpoint, and the URL the bundled
 *   node restarts from while ant-manager restarts it
 * @param {(event: {origin: string, via: string, ended: boolean}) => void} [config.onRefused] -
 *   each refused open of a site's (`ended` false) and each of its
 *   subscriptions a refusal ended (`ended` true)
 */
function configure(config) {
  openSocket = config.openSocket;
  deliver = config.deliver;
  if (typeof config.maxSubscriptionsPerOrigin === 'number') {
    maxSubscriptionsPerOrigin = config.maxSubscriptionsPerOrigin;
  }
  if (typeof config.establishTimeoutMs === 'number') {
    establishTimeoutMs = config.establishTimeoutMs;
  }
  if (Object.hasOwn(config, 'route')) route = config.route ?? null;
  if (typeof config.onRefused === 'function') onRefused = config.onRefused;
}

function countByOrigin(origin) {
  let count = 0;
  for (const sub of subscriptions.values()) {
    if (sub.origin === origin) count++;
  }
  return count;
}

function fanOut(socketKey, payload) {
  const socket = sockets.get(socketKey);
  if (!socket) return;
  for (const subId of [...socket.subIds]) {
    const sub = subscriptions.get(subId);
    // `pending` subscriptions have not been acknowledged to the page yet:
    // the caller is still awaiting establishment, so the page has no id to
    // correlate the message with — and may not even be on screen any more.
    if (sub && !sub.pending) deliver(sub, payload);
  }
}

/**
 * Reject if `established` has not settled within the configured window.
 * The socket layer reconnects indefinitely, so without this a subscription
 * to an unreachable node stays pending (and slot-holding) forever.
 */
function withEstablishTimeout(established) {
  if (!Number.isFinite(establishTimeoutMs)) return established;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        semanticError(
          'establish_timeout',
          `Subscription did not establish within ${establishTimeoutMs}ms`
        )
      );
    }, establishTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    established.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function cancelledError() {
  return semanticError('subscription_cancelled', 'Subscription was cancelled before it was established');
}

/** Whether two node URLs name the same node (a trailing slash aside). */
function sameNode(a, b) {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** Whether `url` is the configured node's now (none configured: no). */
function isCurrentNode(url) {
  const now = route?.nodeUrl?.() || null;
  return Boolean(url && now && sameNode(url, now));
}

/**
 * Whether a socket to `url` waits, dialling nothing: no node is configured
 * now, and ant-manager is restarting the bundled node from `url`.
 */
function suspended(url) {
  if (!route || !url || route.nodeUrl?.()) return false;
  let restarting;
  try {
    restarting = route.restartingUrl?.() || null;
  } catch {
    restarting = null;
  }
  return Boolean(restarting && sameNode(url, restarting));
}

/**
 * Whether a socket to `url` must end: it isn't the configured node's now
 * (another node, or none: stopped, disabled, cleared), and it doesn't wait
 * through the bundled node's restart. Never for a socket the socket layer
 * chose the node of (no route configured).
 */
function staleNode(url) {
  if (!route || !url) return false;
  return !isCurrentNode(url) && !suspended(url);
}

/**
 * Open (or join) a subscription. With a route configured, the route test
 * runs just before the open, after every wait of the caller's, on the URL
 * the socket will dial: refused, it throws `proxy-or-tor` and no socket is
 * created.
 * @param {{ origin: string, document: string, deliverTo: Function, kind: 'gsoc'|'pss', key: string,
 *   nodeUrl?: string|null, signal?: AbortSignal, opener?: * }} params
 *   `origin` is the normalized permission key of the subscribing document,
 *   which `document` names and `deliverTo` sends the messages to.
 *   `nodeUrl` is the node to dial (the configured node's URL now when it is
 *   absent); `signal` ends the subscription while it establishes (its
 *   caller gave up); `opener` may close it by its id (`cancelByOpener`).
 * @returns {Promise<{ subscriptionId: string }>}
 * @throws {Error} reason 'too_many_subscriptions' | 'proxy-or-tor' | 'node_subscription_limit'
 *   | 'establish_timeout' | 'subscription_cancelled' | socket errors
 */
async function subscribe({ origin, document, deliverTo, kind, key, nodeUrl, signal = null, opener }) {
  if (countByOrigin(origin) >= maxSubscriptionsPerOrigin) {
    throw semanticError(
      'too_many_subscriptions',
      `Origin has reached the maximum of ${maxSubscriptionsPerOrigin} subscriptions`
    );
  }
  if (signal?.aborted) throw cancelledError();

  // The node it dials, which its socket is shared on.
  const url = (nodeUrl === undefined ? route?.nodeUrl?.() : nodeUrl) || null;
  const socketKey = url ? `${kind}:${key}@${url}` : `${kind}:${key}`;
  const subscriptionId = crypto.randomBytes(16).toString('hex');
  const subscription = {
    id: subscriptionId,
    origin,
    document: typeof document === 'string' ? document : undefined,
    deliverTo: typeof deliverTo === 'function' ? deliverTo : undefined,
    kind,
    key,
    socketKey,
    pending: true,
    opener,
    attached: false,
    endedBy: null,
  };
  // It holds its slot from here, through the route test's wait. Its end
  // while it establishes (page navigated away, tab closed, grant revoked,
  // its caller gone, the route refused) ends the wait at once, whatever the
  // socket it shares does.
  subscriptions.set(subscriptionId, subscription);
  const ended = new Promise((_resolve, reject) => {
    subscription.onEnd = () => reject(cancelledError());
  });
  ended.catch(() => {});
  const onAbort = () => cancelById(subscriptionId);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (route) {
      const refusal = await routeRefusal(url, route);
      if (!subscriptions.has(subscriptionId)) throw cancelledError();
      // Only the configured node gets a socket: none while there is none.
      if (!isCurrentNode(url)) {
        throw semanticError('subscription_cancelled', 'The Swarm node changed before the subscription opened');
      }
      if (refusal) {
        subscription.endedBy = refusal;
        throw proxyOrTorError(refusal);
      }
    }
    attach(subscription, url);
    await Promise.race([withEstablishTimeout(sockets.get(socketKey).handle.established), ended]);
  } catch (err) {
    removeSubscription(subscription);
    if (!subscription.endedBy) throw err;
    report(origin, subscription.endedBy, false);
    throw proxyOrTorError(subscription.endedBy);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // Cancelled as it established: the slot is already released — don't
  // hand the page an id for a subscription that no longer exists.
  if (!subscriptions.has(subscriptionId)) throw cancelledError();

  subscription.pending = false;
  return { subscriptionId };
}

/** Puts `subscription` on its socket, opening the socket (to `url`) when there is none. */
function attach(subscription, url) {
  const { socketKey, kind, key } = subscription;
  let socket = sockets.get(socketKey);
  if (!socket) {
    socket = { handle: null, subIds: new Set(), url: url || null };
    const opened = socket;
    const handlers = { onMessage: (payload) => fanOut(socketKey, payload) };
    if (route) handlers.beforeReconnect = () => mayReconnect(socketKey, opened);
    socket.handle = openSocket(url ? { kind, key, url } : { kind, key }, handlers);
    sockets.set(socketKey, socket);
    watchRoutes();
  }
  socket.subIds.add(subscription.id);
  subscription.attached = true;
}

/**
 * The socket layer's ask before it dials `socket` again: true to dial,
 * `'later'` to dial nothing now and ask again at its next try (the bundled
 * node restarts from its URL), false to stop for good. A socket to a node
 * that isn't the configured one, or one the route test refuses, ends with
 * every subscription on it, so it never dials again. The node is read
 * again after the route test's wait.
 */
async function mayReconnect(socketKey, socket) {
  const verdict = () => {
    if (sockets.get(socketKey) !== socket) return false;
    if (suspended(socket.url)) return 'later';
    if (staleNode(socket.url)) {
      endSocket(socketKey, socket, null);
      return false;
    }
    return true;
  };
  const before = verdict();
  if (before !== true || !route) return before;
  const refusal = await routeRefusal(socket.url, route);
  const after = verdict();
  if (after !== true) return after;
  if (refusal) {
    endSocket(socketKey, socket, refusal);
    return false;
  }
  return true;
}

/**
 * Ends `socket` and every subscription on it: for the route refusal
 * `refusal`, reported, or with none for a node that is no longer the
 * configured one (one still establishing is then `subscription_cancelled`).
 */
function endSocket(socketKey, socket, refusal) {
  if (refusal) {
    for (const subId of socket.subIds) {
      const sub = subscriptions.get(subId);
      if (!sub) continue;
      sub.endedBy = refusal;
      // One still establishing is refused from its subscribe(), which
      // reports it as a refused open.
      if (!sub.pending) report(sub.origin, refusal, true);
    }
  }
  cancelWhere((sub) => sub.attached && sub.socketKey === socketKey && sockets.get(socketKey) === socket);
}

/**
 * Tests every open socket again (question 4): Tor's state or the node's
 * URL changed, or ROUTE_RECHECK_MS passed. First each socket to a node that
 * is no longer the configured one ends, whatever that node's route; then
 * each socket the route test now refuses. Neither is reconnected.
 */
async function recheckRoutes() {
  if (!route) return;
  for (const [socketKey, socket] of [...sockets]) {
    if (staleNode(socket.url)) endSocket(socketKey, socket, null);
  }
  const byUrl = new Map();
  for (const [socketKey, socket] of sockets) {
    if (!socket.url) continue;
    if (!byUrl.has(socket.url)) byUrl.set(socket.url, []);
    byUrl.get(socket.url).push([socketKey, socket]);
  }
  await Promise.all(
    [...byUrl].map(async ([url, held]) => {
      const refusal = await routeRefusal(url, route);
      for (const [socketKey, socket] of held) {
        if (sockets.get(socketKey) !== socket) continue;
        // The node read again after the wait.
        if (staleNode(url)) endSocket(socketKey, socket, null);
        else if (refusal && !suspended(url)) endSocket(socketKey, socket, refusal);
      }
    })
  );
}

/** Runs `recheckRoutes` every ROUTE_RECHECK_MS while a socket to a node not on loopback is open. */
function watchRoutes() {
  const remote = [...sockets.values()].some((socket) => socket.url && !isLoopbackGatewayUrl(socket.url));
  if (remote && !recheckTimer) {
    recheckTimer = setInterval(() => {
      recheckRoutes().catch(() => {});
    }, ROUTE_RECHECK_MS);
    if (typeof recheckTimer.unref === 'function') recheckTimer.unref();
  } else if (!remote && recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = null;
  }
}

function removeSubscription(subscription) {
  // Once: a subscription cancelled while it establishes is removed again
  // when its establishment then fails.
  if (subscription.closed) return;
  subscriptions.delete(subscription.id);
  // Whatever waits to be delivered for it goes with it.
  subscription.closed = true;
  if (typeof subscription.onClosed === 'function') {
    try {
      subscription.onClosed();
    } catch {
      // Closing never fails on its listener.
    }
  }
  // A subscribe() still waiting for it to establish stops waiting.
  subscription.onEnd?.();
  if (!subscription.attached) return;
  subscription.attached = false;
  const socket = sockets.get(subscription.socketKey);
  if (!socket || !socket.subIds.delete(subscription.id)) return;
  if (socket.subIds.size === 0) {
    sockets.delete(subscription.socketKey);
    socket.handle.cancel();
    watchRoutes();
  }
}

/**
 * Close a subscription. Origin-scoped: an origin can only close its own.
 * @throws {Error} reason 'subscription_not_found'
 */
function unsubscribe(origin, subscriptionId) {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription || subscription.origin !== origin) {
    throw semanticError('subscription_not_found', `No active subscription: ${subscriptionId}`);
  }
  removeSubscription(subscription);
}

/**
 * Close one of a document's own subscriptions (a page's, through main):
 * only that document's, whatever its key now.
 * @throws {Error} reason 'subscription_not_found'
 */
function unsubscribeDocument(document, subscriptionId) {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription || subscription.document === undefined || subscription.document !== document) {
    throw semanticError('subscription_not_found', `No active subscription: ${subscriptionId}`);
  }
  removeSubscription(subscription);
}

/** Close a subscription by its id, if it is still open. */
function cancelById(subscriptionId) {
  const subscription = subscriptions.get(subscriptionId);
  if (subscription) removeSubscription(subscription);
}

/**
 * Close a subscription by its id, if it is still open and `opener` opened
 * it (subscribe's `opener`): the core's close of one it had main open.
 * @returns {boolean} whether one was closed
 */
function cancelByOpener(opener, subscriptionId) {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription || opener === undefined || subscription.opener !== opener) return false;
  removeSubscription(subscription);
  return true;
}

function cancelWhere(predicate) {
  for (const subscription of [...subscriptions.values()]) {
    if (predicate(subscription)) removeSubscription(subscription);
  }
}

function cancelByOrigin(origin) {
  cancelWhere((sub) => sub.origin === origin);
}

/** A page's document ended: its subscriptions end with it. */
function cancelByDocument(document) {
  cancelWhere((sub) => sub.document !== undefined && sub.document === document);
}

// Exported for testing
function _reset() {
  for (const socket of sockets.values()) {
    try {
      socket.handle.cancel();
    } catch {
      // best-effort teardown
    }
  }
  subscriptions.clear();
  sockets.clear();
  route = null;
  onRefused = () => {};
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
}

module.exports = {
  configure,
  subscribe,
  unsubscribe,
  cancelByOrigin,
  cancelByDocument,
  cancelById,
  cancelByOpener,
  unsubscribeDocument,
  countByOrigin,
  checkRoute,
  recheckRoutes,
  routeRefusal,
  PROXY_OR_TOR,
  PROXY_OR_TOR_MESSAGE,
  ROUTE_RECHECK_MS,
  _reset,
};
