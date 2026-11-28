/**
 * The main process's own in-flight dials of the Ant API that go through
 * Electron's `net.request` (and so through `session.webRequest`, where
 * `ant-api-guard.js` would otherwise cancel them).
 *
 * Almost all of the main process's node traffic uses Node's `fetch`, which
 * never reaches `session.webRequest`. The exceptions dial a *remote* external
 * node through the shared gateway transport, so the session's proxy policy
 * applies: the `bzz:` handler's content requests (`swarm/bzz-protocol.js`),
 * the ENS prefetch (`ens-prefetch.js`) and main's own calls
 * (`swarm/ant-storage-api.js`). In webRequest such a dial looks
 * like a worker's request — no frame, no webContents — so the guard cannot
 * tell it apart by shape. Instead the caller announces the exact URL here for
 * the lifetime of the dial, with the one method the dial sends, and the guard
 * lets a frameless request of exactly that method to exactly that URL through
 * (freedom-core design 0015, The transport). An announced GET lets no HEAD,
 * POST or any other method of the same URL through, nor an announced POST a
 * GET. Main's Swarm executor and ant-storage-api read a remote node on this
 * path; their writes (POST, and ant-storage-api's PUT) go on write sessions
 * of their own, each with its own guard, armed for the one write it carries,
 * and announce nothing here (`ant-write-sessions.js`, #1344).
 *
 * Kept free of dependencies so both the guard and its callers can load it.
 */

const pending = new Map();

/**
 * The comparison key for a dial URL. The caller builds its URL as a raw string
 * (`bzz://<hash>/some page.html#x` → `…/bzz/<hash>/some page.html#x`), while
 * webRequest reports Chromium's canonical form. Probed in Electron 44 with a
 * `net.request` of `http://Ant.example.test:1633/bzz/<hash>/some page
 * {x}|^\`.html?q=a b#frag`: onBeforeRequest saw the host lower-cased and
 * `%20%7Bx%7D%7C%5E%60` in the path and `%20` in the query (the fragment was
 * kept). WHATWG leaves `|` and `^` unescaped, so both sides go through WHATWG
 * parsing with the fragment dropped (never sent to the node), then
 * `decodeURI`, which undoes the escaping the two parsers disagree on but
 * leaves reserved escapes (`%2F`, `%3F`, `%23`) alone, so the key still names
 * one path.
 */
function dialKey(url) {
  const raw = String(url);
  let key;
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    key = parsed.href;
  } catch {
    return raw;
  }
  try {
    return decodeURI(key);
  } catch {
    return key;
  }
}

// The methods main dials the node with: the dweb handler's GET and HEAD, the
// ENS prefetch's GET, the Swarm executor's and ant-storage-api's GET, and
// POST for a dial on the request's session (the executor's own go on write
// sessions). A PUT is never announced: ant-storage-api's goes on a write
// session too.
const METHODS = new Set(['GET', 'HEAD', 'POST']);

/** The method's key, as webRequest reports it (upper case), or null. */
function methodKey(method) {
  if (typeof method !== 'string') return null;
  const key = method.toUpperCase();
  return METHODS.has(key) ? key : null;
}

/**
 * Announce a main-process dial of `url` with `method`, the one the dial
 * sends. Returns a release function; call it once the dial has settled
 * (idempotent). Throws on a method main never dials, so a caller can't
 * announce more than it sends.
 */
function announceMainProcessAntDial(url, method) {
  const verb = methodKey(method);
  if (!verb) throw new TypeError(`an Ant dial announces GET, HEAD or POST (got ${method})`);
  const key = `${verb} ${dialKey(url)}`;
  pending.set(key, (pending.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (pending.get(key) || 0) - 1;
    if (count > 0) pending.set(key, count);
    else pending.delete(key);
  };
}

/** True while a dial of `url` with `method` is announced. */
function isMainProcessAntDial(url, method) {
  const verb = methodKey(method);
  return verb !== null && pending.has(`${verb} ${dialKey(url)}`);
}

function _resetMainProcessAntDialsForTests() {
  pending.clear();
}

module.exports = {
  announceMainProcessAntDial,
  dialKey,
  isMainProcessAntDial,
  _resetMainProcessAntDialsForTests,
};
