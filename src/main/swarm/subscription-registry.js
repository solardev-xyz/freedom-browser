/**
 * Subscription Registry
 *
 * Lifecycle state for window.swarm messaging subscriptions. Maps
 * subscription ids to their origin, target webContents, and the shared
 * node socket that feeds them. Deliberately Electron-free: the socket
 * opener and the message deliverer are injected by provider-ipc, so the
 * registry is pure bookkeeping and fully unit-testable.
 *
 * Multiplexing: the Ant node caps live pull pipelines at a small
 * node-wide pool (8 neighborhoods), so the registry opens at most one
 * socket per (kind, key) and fans messages out to every subscription on
 * it. The socket is closed when its last subscription goes away.
 *
 * Establishment is bounded: the socket layer reconnects forever, so a
 * node that stops answering would otherwise leave a subscription pending
 * for the life of the app while still holding a slot in the per-origin
 * cap. subscribe() gives up after `establishTimeoutMs` and releases
 * everything it allocated.
 */

const crypto = require('crypto');

// A subscription that has not established yet holds a slot but must never
// receive messages (its id hasn't reached the page and, for a socket that
// is still connecting, the page may already be gone).
const DEFAULT_ESTABLISH_TIMEOUT_MS = 30_000;

// id → { id, origin, webContentsId, kind, key, socketKey, pending }
const subscriptions = new Map();
// socketKey (`${kind}:${key}`) → { handle, established, subIds: Set }
const sockets = new Map();

let openSocket = null;
let deliver = null;
// configure() owns the real cap (advertised via getCapabilities limits);
// no shadow default here that could drift from it.
let maxSubscriptionsPerOrigin = Infinity;
let establishTimeoutMs = DEFAULT_ESTABLISH_TIMEOUT_MS;

function semanticError(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

/**
 * Wire the registry's collaborators. Must be called before subscribe().
 * @param {Object} config
 * @param {(target: {kind, key}, handlers: {onMessage}) => {established, cancel}} config.openSocket
 * @param {(subscription: Object, payload: Buffer) => void} config.deliver
 * @param {number} config.maxSubscriptionsPerOrigin
 * @param {number} [config.establishTimeoutMs]
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

/**
 * Open (or join) a subscription.
 * @param {{ origin: string, webContentsId: number, kind: 'gsoc'|'pss', key: string }} params
 *   `origin` is the normalized permission key of the subscribing document;
 *   the deliverer re-checks it against the webContents' live URL so
 *   messages can never land in a page from another origin that navigated
 *   in after the subscription was opened.
 * @returns {Promise<{ subscriptionId: string }>}
 * @throws {Error} reason 'too_many_subscriptions' | 'node_subscription_limit'
 *   | 'establish_timeout' | 'subscription_cancelled' | socket errors
 */
async function subscribe({ origin, webContentsId, kind, key }) {
  if (countByOrigin(origin) >= maxSubscriptionsPerOrigin) {
    throw semanticError(
      'too_many_subscriptions',
      `Origin has reached the maximum of ${maxSubscriptionsPerOrigin} subscriptions`
    );
  }

  const socketKey = `${kind}:${key}`;
  let socket = sockets.get(socketKey);
  if (!socket) {
    const handle = openSocket({ kind, key }, { onMessage: (payload) => fanOut(socketKey, payload) });
    socket = { handle, subIds: new Set() };
    sockets.set(socketKey, socket);
  }

  const subscriptionId = crypto.randomBytes(16).toString('hex');
  const subscription = {
    id: subscriptionId,
    origin,
    webContentsId,
    kind,
    key,
    socketKey,
    pending: true,
  };
  subscriptions.set(subscriptionId, subscription);
  socket.subIds.add(subscriptionId);

  try {
    await withEstablishTimeout(socket.handle.established);
  } catch (err) {
    removeSubscription(subscription);
    throw err;
  }

  // Cancelled while we waited (page navigated away, tab closed, grant
  // revoked): the slot is already released — don't hand the page an id
  // for a subscription that no longer exists.
  if (!subscriptions.has(subscriptionId)) {
    throw semanticError('subscription_cancelled', 'Subscription was cancelled before it was established');
  }

  subscription.pending = false;
  return { subscriptionId };
}

function removeSubscription(subscription) {
  subscriptions.delete(subscription.id);
  const socket = sockets.get(subscription.socketKey);
  if (!socket) return;
  socket.subIds.delete(subscription.id);
  if (socket.subIds.size === 0) {
    sockets.delete(subscription.socketKey);
    socket.handle.cancel();
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

function cancelWhere(predicate) {
  for (const subscription of [...subscriptions.values()]) {
    if (predicate(subscription)) removeSubscription(subscription);
  }
}

function cancelByWebContents(webContentsId) {
  cancelWhere((sub) => sub.webContentsId === webContentsId);
}

/**
 * Cancel the subscriptions on `webContentsId` that do NOT belong to
 * `currentOrigin`. Used when the deliverer notices the webview is hosting a
 * different origin than the one that subscribed: those documents are gone,
 * but a subscription the *current* document already opened is still live
 * and must survive.
 */
function cancelStaleByWebContents(webContentsId, currentOrigin) {
  cancelWhere((sub) => sub.webContentsId === webContentsId && sub.origin !== currentOrigin);
}

function cancelByOrigin(origin) {
  cancelWhere((sub) => sub.origin === origin);
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
}

module.exports = {
  configure,
  subscribe,
  unsubscribe,
  cancelByWebContents,
  cancelStaleByWebContents,
  cancelByOrigin,
  countByOrigin,
  _reset,
};
