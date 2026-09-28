/**
 * onBeforeRequest guard that keeps web content away from the Ant node's HTTP
 * API (docs/security-audit-electron.md, O-1; #428).
 *
 * The Ant API listens on loopback (`127.0.0.1:<port>`, 1633 by default) and
 * serves its admin endpoints — `/stamps`, `/chequebook`, `/wallet`, `/stake` —
 * on the same port as content retrieval, with no authentication. Chromium
 * shows no Local Network Access prompt for a webview, so before this guard a
 * plain `fetch('http://127.0.0.1:1633/stamps/1/17', {method: 'POST',
 * mode: 'no-cors'})` from any https:, bzz: or ipfs: page bought a postage
 * batch with the user's node funds.
 *
 * Policy (maintainer decision: a hard block, no prompt, no opt-in). A
 * request to the Ant API is allowed only when it is
 *   - a top-level GET navigation (the user typed or clicked the URL — the
 *     node's own gateway pages still open in a tab), or
 *   - made by one of Freedom's internal pages (`renderer/pages/<file>` from
 *     internal-pages.json, top frame), or
 *   - made by the chrome renderer (`renderer/index.html` in a
 *     BrowserWindow). The chrome's own node calls go over IPC today
 *     (`ant:api-get`), so this is belt-and-braces.
 * Everything else — any frame of any tab, whatever its origin (https:, bzz:,
 * ipfs:, data:, an opaque/sandboxed origin), a service or shared worker, a
 * request Chromium cannot attribute to a frame at all — is cancelled. That
 * includes non-GET top-level navigations (a cross-site `<form method=post>`)
 * and sub-frame navigations. dApps that need the node use `window.swarm`.
 *
 * The main process's own node traffic (bzz: handler, publishing, probes) goes
 * over Node's fetch and never reaches `session.webRequest`, so it is not
 * affected. The one exception is the ENS prefetch of a *remote* external
 * node, which dials through Electron's `net.request` (for the session's proxy
 * policy) — and `net.request` does pass through `session.webRequest`, with no
 * frame and no webContents, exactly like a worker's request. That dial
 * announces its exact URL in `ant-api-main-dials.js` for its lifetime, and
 * only a frameless GET/HEAD of that exact URL is let through.
 *
 * Which requests count as "to the Ant API":
 *   - any loopback host — `localhost`, `*.localhost`, `127.0.0.0/8`,
 *     `0.0.0.0`, `[::1]`, `[::]`, IPv4-mapped loopback — on an Ant API port;
 *   - any other host at all — DNS name *or* IP literal — on an Ant API
 *     port. The guard runs before DNS, so a name (`127.0.0.1.nip.io`, a
 *     rebinding domain) may resolve to loopback; and a node bound to
 *     `0.0.0.0` (a reused/Docker Bee with `-p 1633:1633`) also answers on
 *     every other address of this machine — the docker bridge
 *     (`172.17.0.1`), the LAN IP, a public IP. The guard cannot enumerate
 *     those (NAT, port forwards, interfaces coming and going), so it does not
 *     try: on the node's port, every host is the node. A top-level GET
 *     navigation to such a URL is still allowed (see below). The one
 *     exception is a node on a shared web port — the scheme defaults 80/443
 *     or a common HTTP-alternate port such as 8080 (an external
 *     `https://localhost` or `http://localhost:8080` behind a reverse proxy):
 *     that port is other websites', dev servers' and local gateways' too
 *     (Kubo's gateway is :8080), so there only the loopback spellings are
 *     guarded, and a rebinding name or another address of this machine on
 *     that port is not. Any other port fails closed to "every host";
 *   - the exact origin of a configured external Ant API, its host compared
 *     after folding an IPv4-mapped IPv6 literal (`[::ffff:c0a8:10a]`) to the
 *     dotted IPv4 Chromium connects to (`192.168.1.10`); and, when that node
 *     is on a port outside the shared web ports, every host on that port —
 *     the same all-hosts rule as a local node's port, because before DNS a
 *     DNS alias or rebinding name for the remote machine (`nas.lan`) is
 *     indistinguishable from a different site (#445 R4-M2). On a shared web
 *     port (a remote node at `https://my-node.lan`) only that exact origin
 *     (and its mapped-IPv6 spelling) is guarded; an alias of it is not.
 *     Unlike a local node's ports, a remote node's port is all-hosts only
 *     while it is the configured node; after a switch away its exact origin
 *     stays guarded for the session, its port no longer is (#445 R5-M1).
 * The Ant API ports are the default (1633), the port the node was configured
 * or started on, and every port the node has used this session (a restart
 * onto a fallback port must not reopen the previous one while an older
 * daemon may still be listening there). Schemes: http, https, ws, wss.
 */

const log = require('../logger');
const { DEFAULTS, getAntApiUrl } = require('../service-registry');
const { registerWebRequestHandler } = require('../webrequest-dispatcher');
const { internalPageFileForUrl, isChromeIndexUrl } = require('../ipc-sender-policy');
const { isMainProcessAntDial, _resetMainProcessAntDialsForTests } = require('./ant-api-main-dials');

const GUARDED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const DEFAULT_PORTS = { 'http:': '80', 'ws:': '80', 'https:': '443', 'wss:': '443' };
// Ports shared with other websites and local web services, so never "all
// hosts" even when the node is served on one: the scheme defaults, plus the
// common HTTP-alternate ports a reverse proxy, dev server or local gateway
// (Kubo: 8080) listens on (#445 R2-F1, R3-M1). Deliberately a short list —
// a port missing from it only over-blocks (fails closed), it never opens a
// hole; the node's own ports (1633 and its fallback range) are never here.
const SHARED_WEB_PORTS = new Set([
  ...Object.values(DEFAULT_PORTS),
  '591',
  '3000',
  '4000',
  '5000',
  '8000',
  '8008',
  '8080',
  '8081',
  '8443',
  '8888',
]);

// Ports the node has listened on (sticky for the session) and non-loopback
// API origins it has been configured with.
const knownPorts = new Set([String(DEFAULTS.ant.apiPort)]);
const knownRemoteOrigins = new Set();
// The non-shared port of the remote node most recently noted, all-hosts only
// while that node is the configured one. Not sticky like `knownPorts`: a
// remote node's port is no daemon on this machine, so once the user switches
// away (back to bundled, or to another external node) only its exact origin
// stays guarded, and every other site on that port works again (#445 R5-M1).
let noteRemoteAllHostsPort = null;

function effectivePort(parsed) {
  return parsed.port || DEFAULT_PORTS[parsed.protocol] || '';
}

function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isIpv4Literal(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * True for every host spelling Chromium connects to this machine's loopback
 * interface without a DNS lookup. `hostname` is WHATWG-canonical (lower-case,
 * IPv4 shorthand/hex/octal already normalised to dotted decimal, IPv6
 * compressed and bracketed).
 */
function isLoopbackHostname(rawHostname) {
  if (!rawHostname) return false;
  const hostname = rawHostname.replace(/\.$/, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (isIpv4Literal(hostname)) {
    return hostname.startsWith('127.') || hostname === '0.0.0.0';
  }
  const v6 = stripBrackets(hostname);
  if (v6 === hostname) return false;
  if (v6 === '::1' || v6 === '::') return true;
  // IPv4-mapped (`::ffff:7f00:1`) / -compatible loopback and 0.0.0.0.
  const mapped = v6.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    return high >> 8 === 127 || (high === 0 && parseInt(mapped[2], 16) === 0);
  }
  return false;
}

/**
 * The host key an origin comparison uses: lower-case, no trailing dot, and an
 * IPv4-mapped IPv6 literal (`[::ffff:c0a8:10a]`, which Chromium dials as
 * `192.168.1.10`) folded to its dotted IPv4, so the two spellings of one
 * address compare equal (#445 R4-M2).
 */
function hostKey(rawHostname) {
  const hostname = String(rawHostname || '')
    .replace(/\.$/, '')
    .toLowerCase();
  const mapped = stripBrackets(hostname).match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped || stripBrackets(hostname) === hostname) return hostname;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isAntApiPort(port) {
  if (knownPorts.has(port)) return true;
  if (noteRemoteAllHostsPort === port) return true;
  const live = currentApiUrl();
  if (!live || live.port !== port) return false;
  // A remote node's port is all-hosts too unless it is a shared web port.
  return isLoopbackHostname(live.hostname) || !SHARED_WEB_PORTS.has(port);
}

function currentApiUrl() {
  const raw = getAntApiUrl();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return { hostname: parsed.hostname, port: effectivePort(parsed), origin: parsed.origin };
  } catch {
    return null;
  }
}

/**
 * Record an API URL the node is (about to be) served on. Called by
 * ant-manager whenever it picks a URL — before the node is healthy, which is
 * when the registry learns it — so there is no window where the port is live
 * but unguarded.
 */
function noteAntApiUrl(rawUrl) {
  if (!rawUrl) return;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (!GUARDED_PROTOCOLS.has(parsed.protocol)) return;
  const port = effectivePort(parsed);
  if (isLoopbackHostname(parsed.hostname)) {
    knownPorts.add(port);
    noteRemoteAllHostsPort = null;
  } else {
    knownRemoteOrigins.add(`${hostKey(parsed.hostname)}:${port}`);
    // Off the shared web ports, a remote node's port is all-hosts like a
    // local one — its aliases can't be told apart before DNS (#445 R4-M2) —
    // but only while it is the configured node (#445 R5-M1).
    noteRemoteAllHostsPort = SHARED_WEB_PORTS.has(port) ? null : port;
  }
}

/** True when `rawUrl` addresses the Ant API (see the file header). */
function isAntApiRequestUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!GUARDED_PROTOCOLS.has(parsed.protocol)) return false;
  const hostname = parsed.hostname.toLowerCase();
  const port = effectivePort(parsed);

  if (knownRemoteOrigins.has(`${hostKey(hostname)}:${port}`)) return true;
  const live = currentApiUrl();
  if (live && hostKey(live.hostname) === hostKey(hostname) && live.port === port) return true;

  if (!isAntApiPort(port)) return false;
  // 80/443 and the common HTTP-alternate ports are other sites' ports too. A
  // node served on one of them (an external `https://localhost` or
  // `http://localhost:8080` behind a reverse proxy) is guarded on its
  // loopback spellings only; "every host is the node" there would cancel
  // every such site's subresources for the rest of the session
  // (#445 R2-F1, R3-M1).
  if (SHARED_WEB_PORTS.has(port)) return isLoopbackHostname(hostname);
  // On the node's port every host is the node: a DNS name may resolve to
  // loopback (this runs before DNS), and a node bound to 0.0.0.0 answers on
  // every other address of this machine too (see the file header).
  return true;
}

function frameUrlOf(details) {
  try {
    return details?.frame?.url || null;
  } catch {
    // A WebFrameMain whose frame is gone throws on access.
    return null;
  }
}

function isTopFrame(details) {
  try {
    return details?.frame ? details.frame.parent === null : false;
  } catch {
    return false;
  }
}

function webContentsType(details) {
  try {
    return details?.webContents?.getType?.() || null;
  } catch {
    return null;
  }
}

function isAnnouncedMainProcessDial(details, method) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  // A request from a page, a frame or a worker's webContents is never the
  // main process's own dial.
  if (details?.webContentsId !== undefined && details?.webContentsId !== null) return false;
  if (details?.webContents || details?.frame) return false;
  return isMainProcessAntDial(details.url);
}

function isAllowedInitiator(details) {
  const method = String(details?.method || 'GET').toUpperCase();
  if (details?.resourceType === 'mainFrame' && method === 'GET') return true;
  if (isAnnouncedMainProcessDial(details, method)) return true;
  if (!isTopFrame(details)) return false;
  const frameUrl = frameUrlOf(details);
  const type = webContentsType(details);
  if (type === 'webview' && internalPageFileForUrl(frameUrl)) return true;
  if (type === 'window' && isChromeIndexUrl(frameUrl)) return true;
  return false;
}

/**
 * The onBeforeRequest handler. Registered failClosed: a throw cancels.
 */
function guardAntApiRequest(details) {
  if (!details?.url || !isAntApiRequestUrl(details.url)) return null;
  if (isAllowedInitiator(details)) return null;
  log.warn(
    `[ant-api-guard] Blocked a ${String(details.method || 'GET').toUpperCase()} ` +
      `${details.resourceType || 'request'} to the Ant API from web content`
  );
  return { cancel: true };
}

let installed = false;

/**
 * Register the guard with the webRequest dispatcher. Must run before
 * `attachWebRequestDispatcher()` for each session (the handler registry is
 * process-wide), and before the request rewriter so a rewrite can't skip it.
 */
function installAntApiGuard() {
  if (installed) return;
  registerWebRequestHandler('onBeforeRequest', 'ant-api-guard', guardAntApiRequest, {
    failClosed: true,
  });
  installed = true;
}

function _resetAntApiGuardForTests() {
  installed = false;
  knownPorts.clear();
  knownPorts.add(String(DEFAULTS.ant.apiPort));
  knownRemoteOrigins.clear();
  noteRemoteAllHostsPort = null;
  _resetMainProcessAntDialsForTests();
}

module.exports = {
  installAntApiGuard,
  guardAntApiRequest,
  isAntApiRequestUrl,
  isLoopbackHostname,
  noteAntApiUrl,
  _resetAntApiGuardForTests,
};
