/**
 * Sessions for main's writes to a remote Ant: each write goes once, on a new
 * connection, through its request session's proxy (freedom-browser#1344;
 * freedom-core design 0015, point 6: one dial per admitted call, a POST
 * never sent twice).
 *
 * WHY
 *
 * When a request on a reused keep-alive connection gets no response headers
 * before the connection closes, Chromium's network stack sends it again on a
 * new connection (`HttpNetworkTransaction::ShouldResendRequest`: the
 * connection was reused, and no headers came). That happens below
 * `session.webRequest`, so the Ant guard never sees it, and it covers a POST
 * whose whole body Chromium holds, or one with none: a node, or anything on
 * the path, that keeps a connection, takes a write and closes without
 * answering would get `pss_send`, `soc_up`, `chunk_up`, a whole `bzz_file`
 * or a feed manifest twice. A chunked (streamed) body isn't sent twice only
 * because Chromium's network service crashes on the attempt
 * (electron/electron#56077), failing every request in flight. On a new
 * connection Chromium sends nothing again: the write goes once, whole, empty
 * or chunked, and fails `ERR_EMPTY_RESPONSE` when the node hangs up
 * (measured on Electron 45.2.1, over HTTP and through a SOCKS proxy:
 * `swarm-shell-proxy.test.js`).
 *
 * `net.request` has no option that refuses an idle connection, and a
 * session's connections are its own. So a write takes a session of its own
 * from a small pool, closes that session's connections, and dials there; no
 * other request uses that session until the write's reply is over. Reads
 * stay on their request's session, which may send one again: a GET is
 * idempotent (design 0015's amendment of 2026-11-27).
 *
 * THE PROXY
 *
 * A write session takes its request session's proxy for the URL, as Chromium
 * resolves it there (`resolveProxy`: Tor's SOCKS5 for an onion host, a SOCKS
 * or HTTP proxy, a PAC's answer, the system's, or DIRECT), set as a PAC
 * script that returns exactly that list, and read back from the write
 * session before the dial: a mismatch fails the write, undialled. The onion
 * gate (`ipfs/gateway-transport.js`) asks the write session, which answers
 * as the request's would.
 *
 * WHAT IT CARRIES
 *
 * A POST (main's Swarm executor's uploads and sends, ant-storage-api's
 * storage and deposit writes) or a PUT (ant-storage-api's
 * `/v0/settlement/swap`), with a body or none. A lease for any other method
 * is refused before it takes a session: a read stays on its request session,
 * announced to its guard, and main sends the node nothing else.
 *
 * NOTHING ELSE GOES OUT
 *
 * A write session carries its lease's write and nothing else. It has a
 * guard of its own (`webRequest.onBeforeRequest`), installed as the session
 * is made, before it can send anything: it refuses every request but one,
 * the leased write's method to its exact URL (`dialKey`, as the Ant guard
 * matches announcements), armed once the session is ready and spent by the
 * request it admits; the lease's end disarms it. The write isn't announced
 * to the request session's Ant guard (`ant-api-main-dials.js`), which it
 * never meets. A new partition also starts downloading the spell checker's
 * dictionary when `userData/Dictionaries` has none yet, and that download
 * doesn't pass `webRequest` (measured on Electron 45.2.1, #1358): its
 * languages are emptied as the session is made, which stops it at the
 * source, and its spell checker is turned off.
 *
 * THE POOL
 *
 * One per request session, so a private window's writes share no connection
 * or TLS state with another session's. Up to MAX_WRITE_SESSIONS sessions
 * each, made as concurrent writes need them: in-memory partitions with no
 * HTTP cache, which the pool keeps, since Electron never frees a session. A
 * write past that waits for one, in turn, or until its abort.
 */

const { dialKey } = require('./ant-api-main-dials');

/** The methods a write session carries (see WHAT IT CARRIES). */
const WRITE_METHODS = new Set(['POST', 'PUT']);

/** Concurrent writes a request session sends at once; more wait their turn. */
const MAX_WRITE_SESSIONS = 8;

// Preparing a write session (its proxy, its connections closed) that takes
// longer fails the write. A call to the network service that never settles
// (one in flight while it restarts) then holds that session, not the write.
const PREPARE_TIMEOUT_MS = 10_000;

const pools = new WeakMap(); // request session -> { idle, made, waiting }
let partitions = 0;

/**
 * Admits `details` when it is the request `slot`'s lease armed its guard
 * for, which the admission spends; refuses anything else.
 */
function admits(slot, details) {
  const armed = slot.armed;
  if (!armed || details.method !== armed.method || dialKey(details.url) !== armed.key) {
    return false;
  }
  slot.armed = null;
  return true;
}

/**
 * A new write session: an in-memory partition with no HTTP cache, its spell
 * checker's dictionary never fetched, and its guard on before it can send
 * anything (see NOTHING ELSE GOES OUT).
 */
function makeSlot() {
  const { session } = require('electron');
  partitions += 1;
  const ses = session.fromPartition(`freedom-ant-write-${partitions}`, { cache: false });
  ses.setSpellCheckerLanguages?.([]);
  ses.setSpellCheckerEnabled?.(false);
  const slot = { session: ses, proxy: null, armed: null };
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !admits(slot, details) })
  );
  return slot;
}

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

function poolOf(source) {
  let pool = pools.get(source);
  if (!pool) {
    pool = { idle: [], made: 0, waiting: [] };
    pools.set(source, pool);
  }
  return pool;
}

/** A free write session of `pool`, a new one while it has room, or the next to come back. */
function take(pool, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (pool.idle.length) return Promise.resolve(pool.idle.pop());
  if (pool.made < MAX_WRITE_SESSIONS) {
    const slot = makeSlot();
    pool.made += 1;
    return Promise.resolve(slot);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pool.waiting.splice(pool.waiting.indexOf(waiter), 1);
      reject(abortError());
    };
    const waiter = (slot) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(slot);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pool.waiting.push(waiter);
  });
}

function giveBack(pool, slot) {
  const next = pool.waiting.shift();
  if (next) next(slot);
  else pool.idle.push(slot);
}

/** A PAC script that answers `proxy`, Chromium's proxy list, for every URL. */
function pacReturning(proxy) {
  const script = `function FindProxyForURL(url, host) { return ${JSON.stringify(proxy)}; }`;
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script, 'utf-8').toString(
    'base64'
  )}`;
}

/**
 * Sets `slot`'s session to `source`'s proxy for `url` and closes its
 * connections. `slot.proxy` is what its PAC answers, or null when unknown.
 */
async function prepare(slot, source, url) {
  const proxy = await source.resolveProxy(url);
  if (slot.proxy !== proxy) {
    slot.proxy = null;
    await slot.session.setProxy({ mode: 'pac_script', pacScript: pacReturning(proxy) });
    await slot.session.forceReloadProxyConfig();
    slot.proxy = proxy;
  }
  await slot.session.closeAllConnections();
  const mirrored = await slot.session.resolveProxy(url);
  if (mirrored !== proxy) {
    slot.proxy = null;
    throw new Error(
      `a write session resolves its proxy as ${mirrored || '(empty)'}, its request session as ${
        proxy || '(empty)'
      }: not dialled`
    );
  }
}

/**
 * A write session for one write of `method` to `url`, on `source`'s proxy
 * for it, with no connection open: its first request takes a new one. Its
 * guard admits that one request and nothing else. `release()` (idempotent)
 * disarms the guard and hands the session back once the write is over, its
 * reply's body included. Rejects when `signal` aborts the wait for a free
 * one, or the session couldn't be prepared (nothing was dialled), and at
 * once for a method other than POST or PUT.
 *
 * @param {Electron.Session|null} source - the request's session (the
 *   default session when null)
 * @param {string} url
 * @param {'POST'|'PUT'} method - the write's, as its dial sends it
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ session: Electron.Session, release: () => void }>}
 */
async function leaseWriteSession(source, url, method, signal) {
  if (!WRITE_METHODS.has(method)) {
    throw new TypeError(`a write session carries a POST or a PUT (got ${method})`);
  }
  const from = source || require('electron').session.defaultSession;
  const pool = poolOf(from);
  const slot = await take(pool, signal);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot.armed = null;
    giveBack(pool, slot);
  };
  const preparing = prepare(slot, from, url);
  let timer = null;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('a write session was not ready in time: not dialled')),
      PREPARE_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([preparing, late]);
  } catch (err) {
    // Handed back once its preparation is over, never while a call of it is
    // still pending: a late `closeAllConnections` would cut the next write.
    preparing.then(release, release);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  slot.armed = { method, key: dialKey(url) };
  return { session: slot.session, release };
}

module.exports = { leaseWriteSession, MAX_WRITE_SESSIONS, PREPARE_TIMEOUT_MS };
