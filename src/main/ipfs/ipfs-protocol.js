/**
 * ipfs:// and ipns:// protocol handlers
 *
 * Registers main-process handlers for the `ipfs:` and `ipns:` schemes
 * (standard, secure, streaming, CORS-enabled; see
 * `registerSchemesAsPrivileged` in `src/main/index.js`). Every
 * `ipfs://<cid|name>/<path>` and `ipns://<key|name>/<path>` request —
 * top-level navigation, sub-resource, `fetch`, media `Range`, CSS `url(...)`,
 * service worker — flows through one of these handlers and into the embedded
 * freedom-ipfs native request API.
 *
 * Why this lives in the main process and not the renderer's URL pipeline:
 *
 * Older Freedom builds translated `ipfs://` URLs to the IPFS path-gateway
 * (`http://localhost:8080/ipfs/<cid>/`). Chromium then followed Kubo's
 * subdomain redirect to `<cidv1>.ipfs.localhost:8080`, so DevTools,
 * `window.location`, cookies, localStorage, IndexedDB, and service workers
 * all saw the gateway origin. Pinning the page origin to `ipfs://<cid>/`
 * (or `ipfs://<name>/` for Ethereum-name-backed sites) requires Chromium to never see
 * a gateway URL.
 *
 * Production now keeps the `ipfs://` / `ipns://` origin and calls the native
 * freedom-ipfs request API directly. `buildGatewayUrl` still returns a
 * gateway-shaped URL as the shared canonical intermediate because it preserves
 * the long-standing `/ipfs/...` and `/ipns/...` path contract used by tests and
 * by the native request wrapper. The production path extracts only that
 * gateway path; it does not fetch the URL over HTTP.
 *
 * Contract:
 *  - Single attempt per request. IPFS retrieval does not have Bee's
 *    cold-content transient-5xx retry contract. (Add later if real-world
 *    reliability data warrants.)
 *  - 4xx and 5xx responses pass through to the page so SPAs that feature-
 *    detect missing endpoints can render their own fallback.
 *  - Response body is streamed (no buffering), so large files and media Range
 *    requests don't balloon memory. `Range` headers pass through unmodified to
 *    the native request API.
 *  - Cross-transport mismatches return 404 with an explanatory body —
 *    typing `ipfs://name.eth` whose contenthash is `bzz` (or `ipns`) is
 *    treated as user intent and we don't silently switch transports. Same
 *    rule the bzz handler enforces.
 *  - Native request deadlines live in the native-node wrapper. Tests that
 *    inject a `fetchImpl` use `ATTEMPT_TIMEOUT_MS` to exercise the same
 *    bounded-request behavior without constructing a native node.
 */

const log = require('../logger');
const {
  joinPublishedPath,
  nameSystemLabelForHost,
  nameSystemLabelForResult,
  resolveContentName,
} = require('../content-name-resolver');
const { serveNativeGatewayRequest } = require('../ipfs-manager');
const { isDwebNameHost } = require('../../shared/origin-utils');
const {
  runWithPrivateLogContext,
  redactForLog,
  redactUrlForLog,
  redactedFailure,
} = require('../private/private-log-context');
const {
  cidV0ToV1Base32,
  cidV1B58btcToBase32,
  ipnsMhToCidV1Base36,
} = require('../../shared/cid-utils');

// CIDv0 (Qm + 44 base58), CIDv1 base32 (b + base32 chars), CIDv1 base58btc (z…).
// Mirrors the validation in `src/main/ens-prefetch.js` and the renderer's
// `url-utils.js` — keep all in sync.
//
// CIDv1 base32 always starts with `b` (the base32-lower multibase prefix).
// The 2nd char is always `a` because the version byte (0x01) contributes
// 0b00000 = 0 = `a` to the first 5-bit base32 chunk. The 3rd char varies
// with the codec — `bafy…` (dag-pb), `bafk…` (raw / sha-256), `bafzbei…`
// (libp2p-key), `bagu…` (dag-json — the dag-json codec varint 0x0129
// encodes as 0xa9 0x02, whose top 2 bits push the 3rd 5-bit chunk to
// `g`), `bah…` for other codecs whose varint top 2 bits are 0b11, and
// so on. The earlier regex hard-coded `baf` and false-rejected every
// non-`baf` codec at the protocol-handler layer (the renderer
// canonicalised correctly, but the lowercase-canonical form was then
// rejected here as "invalid ipfs reference").
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{49,}|z[1-9A-HJ-NP-Za-km-z]{40,})$/i;

// IPNS host: libp2p key (k51..., 12D3..., Qm...) or DNSLink name. Same
// shape accepted by the `/ipns/<host>` gateway path. Ethereum name hosts
// match this pattern too — the buildGatewayUrl branch order routes them to the
// name resolver instead of the raw IPNS branch.
const IPNS_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/;

// Per-attempt deadline for tests that inject fetchImpl. Production native
// request deadlines live in FreedomIpfsNativeNode. Single-shot — no retry loop
// here, see file header.
const ATTEMPT_TIMEOUT_MS = 30_000;
const NATIVE_GATEWAY_BASE = 'http://freedom-ipfs.localhost';

// Request headers we should not forward to the native gateway — either
// Chromium-injected privileged-scheme noise or headers that refer to the
// ipfs:// origin and would confuse the request backend. Mirrors the bzz
// handler's strip set.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'authorization',
  // Connection / hop-by-hop
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function sanitizeRequestHeaders(requestHeaders) {
  const out = new Headers();
  for (const [name, value] of requestHeaders.entries()) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out.append(name, value);
  }
  return out;
}

/**
 * Translate `<namespace>://<host>/<path>?<q>` into a gateway-shaped URL.
 *
 * `namespace` is `'ipfs'` or `'ipns'`. `<host>` is either:
 *  - a CID (ipfs) / IPNS key or DNSLink name (ipns), routed to the raw
 *    `/ipfs/...` or `/ipns/...` path, OR
 *  - a supported Ethereum name, resolved via the in-process ens-resolver
 *    cache. Resolving here (not just in the renderer's address-bar
 *    pipeline) is what makes `ipfs://name.eth/` survive as the URL
 *    Chromium loads — DevTools, `window.location`, storage origin, and
 *    subresource fetches all see the name rather than the resolved
 *    CID.
 *
 * Returns one of:
 *  - `{ ok: true, url }`              — gateway-shaped URL with usable path.
 *  - `{ ok: false, status, message, logMessage }` — semantic failure (404
 *    mismatch / no contenthash, 415 unsupported codec, 502 resolver
 *    conflict/error). `message` goes to the page, `logMessage` to the
 *    persistent log — see `redactedFailure`, which builds both.
 *  - `null`                           — malformed input. Caller emits 400.
 */
async function buildGatewayUrl(namespace, sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }

  let host = parsed.hostname;
  let pathname = parsed.pathname;
  let effectiveNs = namespace;

  // Gateway-form rewrite — see the equivalent comment in
  // `src/renderer/lib/url-utils.js#parseIpfsInput` for the full rationale.
  // Reaches here for sub-resource requests (`<img>`, `<script>`, `fetch`,
  // CSS `url(...)`, etc.) that bypass the renderer's address-bar pipeline
  // — top-level navigations get rewritten upstream so the address bar
  // and origin both end up canonical. Sub-resources keep the original
  // `ipfs://localhost/...` URL (and therefore the wrong storage origin)
  // but at least the bytes load.
  //
  // The gate is now an explicit known-public-gateway / loopback host
  // allowlist (see isKnownGatewayHost). Earlier versions used a negative
  // "host doesn't look like a content reference" check, which over-fired
  // for DNSLink hosts: e.g. `ipns://docs.ipfs.tech/ipfs/coverage` would
  // try to rewrite even though `docs.ipfs.tech` is the actual content
  // host (a DNSLink site that genuinely serves a `/ipfs/coverage` page).
  // Restricting the rewrite to outer hosts we recognize as gateways
  // disambiguates that case purely from the URL.
  //
  // `parsed.pathname` keeps original case (Chromium only lowercases the
  // host segment for standard schemes), so an embedded CIDv0, CIDv1
  // base58btc, or base58 IPNS key survives intact and can be
  // canonicalised below.
  if (isKnownGatewayHost(host)) {
    const gatewayMatch = pathname.match(/^\/(ipfs|ipns)\/([^/]+)(.*)$/);
    if (gatewayMatch) {
      const innerNs = gatewayMatch[1];
      const ref = gatewayMatch[2];
      // For /ipfs/, the embedded ref must be a CID (looksLikeContentKey).
      // For /ipns/, also accept DNSLink-shaped names so e.g.
      // `ipfs://dweb.link/ipns/docs.ipfs.tech/install` rewrites to
      // `ipns://docs.ipfs.tech/install`. Ethereum-name-style hosts are valid
      // DNSLink targets too and route through the
      // resolver branch below.
      const refOk = looksLikeContentKey(ref) || (innerNs === 'ipns' && isLikelyDnsLinkName(ref));
      if (refOk) {
        effectiveNs = innerNs;
        let embeddedRef = ref;
        if (innerNs === 'ipfs') {
          // CIDv0 (Qm…) → CIDv1 base32, OR CIDv1 base58btc (z…) → base32.
          const canonical = cidV0ToV1Base32(embeddedRef) || cidV1B58btcToBase32(embeddedRef);
          if (canonical) embeddedRef = canonical;
        } else if (looksLikeContentKey(embeddedRef)) {
          // Base58 peer ID → libp2p-key base36, or CIDv1 base58btc → base32.
          // DNSLink-shaped names skip canonicalisation and pass through.
          const canonical = ipnsMhToCidV1Base36(embeddedRef) || cidV1B58btcToBase32(embeddedRef);
          if (canonical) embeddedRef = canonical;
        }
        host = embeddedRef;
        pathname = gatewayMatch[3] || '/';
      }
    }
  }

  const gw = NATIVE_GATEWAY_BASE;

  if (effectiveNs === 'ipfs' && CID_RE.test(host)) {
    // CIDv0 / CIDv1-base58btc hosts are case-sensitive. Sub-resource
    // requests (`<img src="ipfs://Qm.../">`, `<img src="ipfs://z.../">`,
    // `fetch('ipfs://...')`, etc.) bypass the renderer's formatIpfsUrl
    // pipeline; by the time the handler sees the URL, Chromium's
    // standard-scheme parser has already lowercased the host. The
    // canonicalisers below (`cidV0ToV1Base32`, `cidV1B58btcToBase32`)
    // detect the lowercased shape and refuse to re-encode (the original
    // bytes are unrecoverable), so this branch effectively just produces
    // the actionable 400. The "we can re-encode" framing applied to an
    // earlier draft that called these helpers from the JS surface with
    // mixed-case input still intact — it doesn't apply once Chromium
    // has parsed the URL. Keeping the structure for the JS-surface case
    // (eg. unit tests, internal IPC) so input that *does* arrive mixed-
    // case still canonicalises rather than 400ing. CIDv1 base32 (`baf…`)
    // is already lowercase-canonical and falls through unchanged.
    if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/i.test(host)) {
      const canonical = cidV0ToV1Base32(host);
      if (canonical) {
        host = canonical;
      } else {
        return redactedFailure(
          400,
          (ref) =>
            `lowercased CIDv0 host "${ref}" is not a valid IPFS reference. ` +
            `Chromium's standard-scheme URL parser lowercased the host segment ` +
            `and destroyed the case-sensitive base58btc encoding. Publish the ` +
            `resource with its CIDv1 base32 (bafy...) form for sub-resource use.`,
          host
        );
      }
    } else if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(host)) {
      const canonical = cidV1B58btcToBase32(host);
      if (canonical) {
        host = canonical;
      } else {
        return redactedFailure(
          400,
          (ref) =>
            `lowercased CIDv1 base58btc host "${ref}" is not a valid IPFS reference. ` +
            `Chromium's standard-scheme URL parser lowercased the host segment ` +
            `and destroyed the case-sensitive base58btc encoding. Publish the ` +
            `resource with its CIDv1 base32 (bafy...) form for sub-resource use.`,
          host
        );
      }
    }
    return {
      ok: true,
      url: `${gw}/ipfs/${host}${pathname}${parsed.search}`,
    };
  }

  if (effectiveNs === 'ipns' && !isDwebNameHost(host) && IPNS_HOST_RE.test(host)) {
    // base58btc IPNS peer-ID hosts (`12D3Koo...`, `16Uiu2H...`, `Qm...`)
    // and CIDv1-base58btc IPNS keys (`z...` libp2p-key) are case-
    // sensitive; same recovery / rejection rule as CIDv0 above. Already-
    // canonical libp2p-key base36 (`k51...`) and DNSLink names are
    // lowercase and pass through unchanged.
    if (/^(12D3|16Uiu2H|Qm)/i.test(host)) {
      const canonical = ipnsMhToCidV1Base36(host);
      if (canonical) {
        host = canonical;
      } else {
        return redactedFailure(
          400,
          (ref) =>
            `lowercased base58btc IPNS host "${ref}" is not a valid IPNS reference. ` +
            `Chromium's standard-scheme URL parser lowercased the host segment ` +
            `and destroyed the case-sensitive encoding. Publish the resource with ` +
            `its libp2p-key base36 (k51.../k2k4...) form for sub-resource use.`,
          host
        );
      }
    } else if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(host)) {
      const canonical = cidV1B58btcToBase32(host);
      if (canonical) {
        host = canonical;
      } else {
        return redactedFailure(
          400,
          (ref) =>
            `lowercased CIDv1 base58btc IPNS host "${ref}" is not a valid IPNS reference. ` +
            `Chromium's standard-scheme URL parser lowercased the host segment ` +
            `and destroyed the case-sensitive base58btc encoding. Publish the ` +
            `resource with its libp2p-key base36 (k51.../k2k4...) or CIDv1 base32 ` +
            `(bafy...) form for sub-resource use.`,
          host
        );
      }
    }
    return {
      ok: true,
      url: `${gw}/ipns/${host}${pathname}${parsed.search}`,
    };
  }

  if (isDwebNameHost(host) && !hasEmptyLabel(host)) {
    return resolveEnsToGatewayUrl(effectiveNs, host, { pathname, search: parsed.search }, gw);
  }

  return null;
}

// Mirrored in src/renderer/lib/url-utils.js — kept in sync intentionally.
// (Not extracted to a shared module because the regexes are tiny and
// duplicating them avoids dragging more cross-context plumbing in.)
//
// Returns true for the embedded ref of a gateway-form path that we'll
// rewrite to the canonical `<scheme>://<ref>/...` form. Stricter than the
// full IPNS-host shape: Ethereum names are excluded here because their
// gateway-form embedded representation is vanishingly rare and ambiguous
// with arbitrary DNSLink subpaths; name routing happens at the outer host.
function looksLikeContentKey(ref) {
  if (typeof ref !== 'string' || !ref) return false;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/i.test(ref)) return true;
  // `ba…` covers all CIDv1 base32 codecs: `bafy…`/`bafk…` (dag-pb / raw),
  // `bagu…` (dag-json), `bah…` and others — see the CID_RE comment.
  if (/^ba[a-z2-7]{49,}$/i.test(ref)) return true;
  if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(ref)) return true;
  if (/^k[a-z0-9]{40,}$/i.test(ref)) return true;
  if (/^(12D3|16Uiu2H)[a-zA-Z0-9]{30,}$/i.test(ref)) return true;
  return false;
}

// Hostname-shaped string with at least one dot — used to recognise
// DNSLink targets in the embedded ref of `ipfs://<gateway>/ipns/<name>/...`
// gateway-form URLs. RFC 1123-ish: dot-separated labels of alphanumerics
// and hyphens, label-internal-only hyphens, total length capped at the
// DNS limit. Only meaningful when the surrounding namespace is `ipns`
// — DNSLink doesn't apply under `/ipfs/`.
function isLikelyDnsLinkName(ref) {
  if (typeof ref !== 'string' || !ref) return false;
  if (ref.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(ref);
}

// Hosts we recognise as IPFS gateways for the gateway-form rewrite.
// Conservative allowlist: loopback variants plus the most common public
// gateways. Self-hosted gateways aren't matched here — but their content
// authors can publish canonical `ipfs://<cid>/...` URLs directly without
// needing the rewrite. The previous heuristic (any non-content-key host)
// over-fired on DNSLink hosts like `docs.ipfs.tech`.
const KNOWN_GATEWAY_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '::1',
  'dweb.link',
  'ipfs.io',
  'gateway.ipfs.io',
  'cf-ipfs.com',
  'cloudflare-ipfs.com',
  'gateway.pinata.cloud',
  'nftstorage.link',
  'w3s.link',
  '4everland.io',
  'ipfs.fleek.co',
  'dweb.eu.org',
]);

function isKnownGatewayHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const lower = host.toLowerCase();
  if (KNOWN_GATEWAY_HOSTS.has(lower)) return true;
  // *.localhost (gateway subdomain forms can leak into the host slot when
  // relative URLs in directory listings are resolved against the page's
  // `ipfs:` origin).
  if (lower.endsWith('.localhost')) return true;
  return false;
}

// Cheap pre-filter for hosts with empty labels (e.g. `.eth`, `foo..eth`).
// Mirrors the bzz handler's hasEmptyLabel — see that file for the rationale
// (don't enforce a minimum label length; legacy two-char `.eth` registrations
// and single-char subdomains are both valid).
function hasEmptyLabel(host) {
  return host.split('.').some((label) => label.length === 0);
}

// Second arg is destructured to `{ pathname, search }` so both the
// non-rewritten path (top-level `ipfs://name.eth/...`) and the rewritten
// path (sub-resource `ipfs://localhost/ipfs/<cid>/...` → effectively
// `ipfs://<cid>/...`) flow in cleanly.
async function resolveEnsToGatewayUrl(namespace, host, parsed, gw) {
  let result;
  const fallbackSystemLabel = nameSystemLabelForHost(host);
  try {
    result = await resolveContentName(host);
  } catch (err) {
    // The resolver's own error text routinely names what it was asked to
    // resolve, so it is redacted here and in the failure's log variant.
    log.warn(
      `[${namespace}-protocol] ${fallbackSystemLabel} resolver threw for ${redactForLog(host)}: ` +
        `${redactForLog(err.message)}`
    );
    return redactedFailure(
      502,
      (detail) => `${fallbackSystemLabel} resolver error: ${detail}`,
      err.message
    );
  }

  if (!result) {
    return redactedFailure(
      502,
      (name) => `${fallbackSystemLabel} resolver returned no result for ${name}`,
      host
    );
  }

  if (result.type === 'ok') {
    const systemLabel = nameSystemLabelForResult(result, host);
    if (result.protocol !== namespace) {
      return redactedFailure(
        404,
        (name) =>
          `${systemLabel} name ${name} resolves to ${result.protocol}, ` +
          `not ${namespace.toUpperCase()}`,
        host
      );
    }
    return {
      ok: true,
      url: `${gw}/${namespace}/${result.decoded}${joinPublishedPath(result.basePath, parsed.pathname)}${parsed.search}`,
    };
  }

  if (result.type === 'not_found') {
    const systemLabel = nameSystemLabelForResult(result, host);
    const reason = result.reason || 'unknown';
    return redactedFailure(
      404,
      (name) => `${systemLabel} name ${name} has no contenthash (${reason})`,
      host
    );
  }

  if (result.type === 'unsupported') {
    const systemLabel = nameSystemLabelForResult(result, host);
    return redactedFailure(
      415,
      (name) => `${systemLabel} name ${name} contenthash format unsupported`,
      host
    );
  }

  if (result.type === 'conflict') {
    const systemLabel = nameSystemLabelForResult(result, host);
    return redactedFailure(502, (name) => `${systemLabel} providers disagree on ${name}`, host);
  }

  const systemLabel = nameSystemLabelForResult(result, host);
  return redactedFailure(
    502,
    (name, detail) => `${systemLabel} resolution failed for ${name}: ${detail}`,
    host,
    result.error || result.reason || 'unknown'
  );
}

function jsonErrorResponse(status, message) {
  return new Response(JSON.stringify({ code: status, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Core handler, exported for testability. Production calls the native
 * freedom-ipfs request API. Tests may still inject `fetchImpl` to exercise
 * the long-standing URL canonicalisation and timeout behavior without
 * constructing a native node.
 */
async function handleRequest(
  namespace,
  request,
  {
    fetchImpl = null,
    requestImpl = serveNativeGatewayRequest,
    attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  } = {}
) {
  const built = await buildGatewayUrl(namespace, request.url);
  if (!built) {
    return jsonErrorResponse(400, `invalid ${namespace} reference`);
  }
  if (!built.ok) {
    // `built.message` is the page-facing text and embeds the requested
    // name or CID; only the failure's own log variant may reach the
    // persistent log. Fail closed: a failure that didn't declare one is
    // assumed to name the destination.
    log.info(
      `[${namespace}-protocol] ${built.status} for ${redactUrlForLog(request.url)}: ` +
        `${built.logMessage ?? redactForLog(built.message)}`
    );
    return jsonErrorResponse(built.status, built.message);
  }

  const headers = sanitizeRequestHeaders(request.headers);
  const method = request.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : request.body;

  if (!fetchImpl) {
    if (body) {
      return jsonErrorResponse(405, 'freedom-ipfs native gateway supports GET and HEAD');
    }
    const gatewayPath = gatewayPathFromUrl(built.url);
    if (!gatewayPath) {
      return jsonErrorResponse(400, `invalid ${namespace} reference`);
    }
    try {
      return await requestImpl({
        path: gatewayPath,
        method,
        headers,
        signal: request.signal,
      });
    } catch (err) {
      log.warn(
        `[${namespace}-protocol] native request failed for ${redactForLog(gatewayPath)}: ${err?.message || err}`
      );
      return jsonErrorResponse(502, err?.message || 'freedom-ipfs native gateway error');
    }
  }

  // Per-attempt AbortController, linked to the upstream request signal so
  // a webview cancellation still aborts the in-flight fetch, but with its
  // own timeout so a stalled injected fetch can't hang the page load
  // indefinitely. Mirrors the bzz handler's pattern.
  const attemptCtl = new AbortController();
  const upstream = request.signal;
  const relayAbort = () => attemptCtl.abort();
  if (upstream) {
    if (upstream.aborted) attemptCtl.abort();
    else upstream.addEventListener('abort', relayAbort, { once: true });
  }
  const timer = setTimeout(() => attemptCtl.abort(), attemptTimeoutMs);

  // Kept for fetchImpl-based tests and legacy gateway smoke paths. Production
  // native requests do not fetch built.url over HTTP.
  const init = { method, headers, signal: attemptCtl.signal, redirect: 'follow' };
  if (body) {
    init.body = body;
    init.duplex = 'half';
  }

  try {
    return await fetchImpl(built.url, init);
  } catch (err) {
    // Translate our attempt-level abort into a 504 with a useful message
    // (rather than letting the raw AbortError surface as a 502). If the
    // upstream signal is what aborted, the caller already cancelled the
    // request and there's nothing useful to return.
    if (attemptCtl.signal.aborted && !upstream?.aborted) {
      log.warn(
        `[${namespace}-protocol] fetch timed out after ${attemptTimeoutMs}ms for ${redactUrlForLog(built.url)}`
      );
      return jsonErrorResponse(504, 'freedom-ipfs gateway timeout');
    }
    const code = err?.cause?.code || err?.code || '';
    const isConnRefused = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND';
    log.warn(
      `[${namespace}-protocol] fetch failed for ${redactUrlForLog(built.url)}: ${err?.message || err}` +
        (code ? ` (${code})` : '')
    );
    return jsonErrorResponse(
      isConnRefused ? 503 : 502,
      isConnRefused ? 'freedom-ipfs gateway unreachable' : 'freedom-ipfs gateway error'
    );
  } finally {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener('abort', relayAbort);
  }
}

function gatewayPathFromUrl(gatewayUrl) {
  try {
    const parsed = new URL(gatewayUrl);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
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
        runWithPrivateLogContext(isPrivate, () => handleRequest(namespace, request))
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
  buildGatewayUrl,
  gatewayPathFromUrl,
  sanitizeRequestHeaders,
  ATTEMPT_TIMEOUT_MS,
  NATIVE_GATEWAY_BASE,
};
