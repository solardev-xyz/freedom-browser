/**
 * pubky:// protocol handler
 *
 * Serves `pubky://<public-key>/pub/<path>`: a public file on the homeserver
 * the key publishes in its Pkarr record. The Pubky SDK resolves the
 * homeserver through Pkarr relays and fetches the file; the homeserver's
 * status, headers and body go back to the page.
 *
 * `pubky` is a standard scheme (see `registerSchemesAsPrivileged` in
 * index.js), so each key is its own origin. z-base-32 keys are lowercase,
 * so Chromium's host lowercasing is harmless.
 *
 * Contract:
 *  - GET / HEAD only, and only under `/pub/`. Writes and private data need
 *    a signed-in session, which this handler never has.
 *  - Request URLs are not logged: they name the key being read.
 *  - Every dial the SDK makes for a pubky:// request (relays, homeserver
 *    info, the file itself) goes through `guardedFetch`: https only,
 *    redirects never followed, and only to hosts whose every address is
 *    public. The key's owner chooses the homeserver address and anything
 *    it redirects to, so without this a pubky:// page could read loopback
 *    or LAN services (the local Ant API, a router) as same-origin content.
 *    Residual: undici resolves the host again when it connects, so a DNS
 *    answer that changes between our lookup and its dial (rebinding) is
 *    not caught. https-only plus certificate validation still keeps that
 *    from reaching a plain-http loopback/LAN service: the rebound target
 *    would need a certificate valid for the attacker's hostname.
 *  - The homeserver's status and body reach the page, but not its
 *    `Set-Cookie`/`Service-Worker-Allowed` headers (as for bzz:/ipfs:,
 *    O-12) nor its encoding/length/hop-by-hop headers, which describe a
 *    body fetch has already decoded.
 *  - Each request gets FETCH_TIMEOUT_MS (30s, as ipfs-protocol.js's
 *    ATTEMPT_TIMEOUT_MS) for the homeserver's response headers, and its
 *    dials are linked to `request.signal`, as in bzz-/ipfs-protocol.js, so
 *    the page cancelling the request aborts them. A homeserver that accepts
 *    the connection and never answers gets a 504 instead of a tab that
 *    spins until the socket gives up. Once headers are in, the body streams
 *    with no deadline but stays linked to `request.signal`.
 *  - Only `Range`/`If-Range`/`If-None-Match`/`If-Modified-Since` go from
 *    the page to the homeserver (cache revalidation, and byte ranges for a
 *    homeserver that serves them); no cookies, credentials or Referer.
 *  - Error responses carry fixed text, never SDK/WASM error messages.
 */

const dns = require('node:dns');
const net = require('node:net');
const { AsyncLocalStorage } = require('node:async_hooks');
const log = require('../logger');
const { stripPageStateHeaders } = require('../lib/gateway-response-headers');

// 52 z-base-32 characters; the unused final bits are zero, so the last
// character is `y` or `o`. Same rule as Pubky Chromium's IDENTIFIERS.md.
const PUBLIC_KEY_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const HOMESERVER_UNREACHABLE = 'Could not reach the homeserver for this key';
const HOMESERVER_TIMEOUT = 'The homeserver for this key did not answer in time';
const FETCH_TIMEOUT_MS = 30_000;

// Addresses a pubky:// page must never reach through the homeserver dial.
// IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is matched against the IPv4 rules.
const NON_PUBLIC = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  NON_PUBLIC.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds an IPv4 address, possibly a private one
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  NON_PUBLIC.addSubnet(prefix, bits, 'ipv6');
}

// NAT64 (`64:ff9b::/96`, what DNS64 hands out for IPv4-only hosts) is only
// as public as the IPv4 address it embeds.
function embeddedNat64Ipv4(address) {
  const match = /^64:ff9b::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (match) {
    const hi = parseInt(match[1], 16);
    const lo = parseInt(match[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const dotted = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return dotted ? dotted[1] : null;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !NON_PUBLIC.check(address, 'ipv4');
  if (family === 6) {
    const nat64 = embeddedNat64Ipv4(address);
    if (nat64) return isPublicAddress(nat64);
    return !NON_PUBLIC.check(address, 'ipv6');
  }
  return false;
}

const DEFAULT_POLICY = Object.freeze({ protocols: ['https:'], isPublicAddress });

class PubkyDialRefused extends Error {
  constructor() {
    super('pubky dial refused');
    this.name = 'PubkyDialRefused';
  }
}

// The SDK's WASM calls the global `fetch`. A dial made while a pubky
// request is being served (its async context holds a guard state) goes
// through `guardedFetch`; every other caller in the main process reaches
// the original `fetch` with the same arguments.
const sdkContext = new AsyncLocalStorage();
let originalFetch = null;

function installFetchRouter() {
  if (originalFetch) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = function fetch(...args) {
    const state = sdkContext.getStore();
    if (!state) return Reflect.apply(originalFetch, this, args);
    return guardedFetch(state, args[0], args[1]);
  };
}

const lookupAll = (hostname) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses.map((entry) => entry.address))
    );
  });

async function vetDestination(rawUrl, policy) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PubkyDialRefused();
  }
  if (!policy.protocols.includes(url.protocol) || url.username || url.password) {
    throw new PubkyDialRefused();
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await lookupAll(host);
    } catch {
      throw new PubkyDialRefused();
    }
  }
  if (!addresses.length || !addresses.every((address) => policy.isPublicAddress(address))) {
    throw new PubkyDialRefused();
  }
}

// Every response `guardedFetch` hands back, mapped to the policy that vetted
// its dial. `guardedSdkFetch` checks the response the SDK returns against
// this, not against its own async-context state: wasm-bindgen-futures runs
// its queued tasks in one batch, so SDK dials started in the same tick by
// several pubky requests all run under the first request's context. The
// SDK returns the very Response object the dial produced, so identity is
// the reliable link back to the guard.
const vettedResponses = new WeakMap();

async function guardedFetch(state, input, init) {
  // `redirect: 'manual'` on every dial: a 3xx comes back as itself and is
  // refused below instead of being followed to wherever it points.
  const request = new Request(input, { ...init, redirect: 'manual' });
  await vetDestination(request.url, state.policy);
  const response = await originalFetch(request);
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    response.body?.cancel().catch(() => {});
    throw new PubkyDialRefused();
  }
  vettedResponses.set(response, state.policy);
  return response;
}

const newGuardState = (policy = DEFAULT_POLICY) => ({ policy });

// ponytail: the SDK loads its WASM on first use, so a profile that never
// opens a pubky:// address never pays for it.
//
// Requiring the package's CJS entry replaces `globalThis.fetch` with a
// fetch-cookie wrapper (one cookie jar for the whole main process, shared
// by normal and private windows). Put the original back straight away:
// public reads need no cookies, and no other main-process caller may
// inherit a jar.
let sdk;
const loadSdk = () => {
  if (!sdk) {
    const before = globalThis.fetch;
    let mod;
    try {
      mod = require('@synonymdev/pubky');
    } finally {
      globalThis.fetch = before;
    }
    installFetchRouter();
    // Built inside a guard context, so anything the client starts on its
    // own is guarded too.
    const client = sdkContext.run(newGuardState(), () => new mod.Pubky().client);
    sdk = { client, resolvePubky: mod.resolvePubky };
  }
  return sdk;
};

// Settles with `promise`, or rejects as soon as `signal` aborts. A response
// that arrives after the abort has its body cancelled.
function settleOrAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      promise.then(
        (late) => late?.body?.cancel().catch(() => {}),
        () => {}
      );
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Fetches `url` with the SDK client, every dial guarded by `policy`.
 * Rejects with PubkyDialRefused when a dial is refused or the response
 * did not come from a dial the guard vetted under `policy` (fails closed
 * should the async context ever be lost inside the SDK, or carry another
 * request's policy).
 */
function guardedSdkFetch(url, init, policy = DEFAULT_POLICY) {
  const state = newGuardState(policy);
  return sdkContext.run(state, async () => {
    const { client } = loadSdk();
    init?.signal?.throwIfAborted();
    // The SDK passes `init.signal` on to the file dial; the race also frees
    // the caller if an abort lands while the SDK is still resolving the
    // homeserver (relay dials it may not hand the signal to).
    const response = await settleOrAbort(
      client.fetch(url, { ...init, redirect: 'manual' }),
      init?.signal
    );
    const status = response.status;
    if (
      response.redirected ||
      vettedResponses.get(response) !== policy ||
      (status >= 300 && status < 400 && status !== 304)
    ) {
      response.body?.cancel().catch(() => {});
      throw new PubkyDialRefused();
    }
    return response;
  });
}

// A 204/205/304 carries no body, and `Response` refuses one for them.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Body-describing and hop-by-hop headers fetch leaves on an already-decoded
// body; forwarding `content-encoding: gzip` with the compressed length would
// misdescribe it to the page. Same list as ipfs-manager.js.
const DROPPED_UPSTREAM_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
];

function toPageResponse(upstream) {
  const headers = new Headers(upstream.headers);
  for (const name of DROPPED_UPSTREAM_RESPONSE_HEADERS) headers.delete(name);
  stripPageStateHeaders(headers);
  return new Response(NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// Page request headers the homeserver dial carries: conditional reads (so a
// cached file revalidates to a 304) and byte ranges. The reference
// homeserver (pubky-core d95161af, routes/tenants/read.rs) answers
// If-None-Match/If-Modified-Since but ignores Range and returns 200 with
// the whole file, so media there can seek only within what's buffered;
// Range is forwarded so a homeserver that does serve 206 gets it, and a
// 200 answer to a range request is still valid for the page. An allowlist, not ipfs-protocol.js's
// denylist: the homeserver is whatever the key's owner chose, so cookies,
// credentials, Referer and the rest of the page's headers stay here.
const FORWARDED_REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];

function forwardedRequestHeaders(request) {
  const out = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers?.get?.(name);
    if (value) out[name] = value;
  }
  return out;
}

const textResponse = (status, message) =>
  new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

/**
 * Returns `pubky<key>/<path>` (the SDK's address form) for a valid
 * `pubky://<key>/pub/...` URL, or null.
 */
function toPubkyAddress(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'pubky:' || url.port || !PUBLIC_KEY_RE.test(url.hostname)) return null;
  // The URL parser has already collapsed `.` and `..` segments.
  if (!url.pathname.startsWith('/pub/')) return null;
  return `pubky${url.hostname}${url.pathname}${url.search}`;
}

async function handlePubkyRequest(request, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const method = (request.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return textResponse(405, 'Method not allowed');

  const address = toPubkyAddress(request.url);
  if (!address) {
    return textResponse(400, 'Expected pubky://<public-key>/pub/<path>');
  }

  // Linked to the page's own cancellation for the whole response, body
  // included; the deadline covers only the wait for response headers.
  const controller = new AbortController();
  const pageSignal = request.signal;
  if (pageSignal) {
    if (pageSignal.aborted) controller.abort(pageSignal.reason);
    else
      pageSignal.addEventListener('abort', () => controller.abort(pageSignal.reason), {
        once: true,
      });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const { resolvePubky } = loadSdk();
    return toPageResponse(
      await guardedSdkFetch(resolvePubky(address), {
        method,
        headers: forwardedRequestHeaders(request),
        signal: controller.signal,
      })
    );
  } catch (err) {
    if (timedOut && !pageSignal?.aborted) {
      log.warn(`[pubky-protocol] request timed out after ${timeoutMs}ms`);
      return textResponse(504, HOMESERVER_TIMEOUT);
    }
    log.warn(`[pubky-protocol] request failed: ${err?.name || 'Error'}`);
    return textResponse(502, HOMESERVER_UNREACHABLE);
  } finally {
    clearTimeout(timer);
  }
}

function registerPubkyProtocol(targetSession) {
  try {
    targetSession.protocol.handle('pubky', (request) => handlePubkyRequest(request));
    log.info('[pubky-protocol] handler registered');
  } catch (err) {
    log.error('[pubky-protocol] failed to register handler:', err);
  }
}

module.exports = {
  registerPubkyProtocol,
  handlePubkyRequest,
  FETCH_TIMEOUT_MS,
  toPubkyAddress,
  isPublicAddress,
  // Exported for pubky-sdk-guard.test.js, which drives the real SDK
  // against loopback fixtures with a test policy.
  guardedSdkFetch,
  loadSdk,
};
