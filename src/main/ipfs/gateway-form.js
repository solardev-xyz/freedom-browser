/**
 * Gateway-form `ipfs:` / `ipns:` URLs (security audit O-3) and the canonical
 * URL each one redirects to.
 *
 * The core plans these requests (freedom-core design 0006, `dweb.open`): a
 * gateway-form URL is answered with a 307 to its canonical form. Main keeps
 * today's `gatewayFormRedirect` for one reason, to check that plan before it
 * answers: a redirect plan's `Location` must be exactly the canonical form
 * computed here for the request's own URL (design 0006, "Validation before
 * any dial"). Moved unchanged from `ipfs-protocol.js`.
 */

const {
  cidV0ToV1Base32,
  cidV1B58btcToBase32,
  ipnsMhToCidV1Base36,
} = require('../../shared/cid-utils');

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
  // `bagu…` (dag-json), `bah…` and others: the codec varint decides the
  // third character.
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

// Gateway-form match: a known gateway / loopback OUTER host carrying the
// real content reference in a path-gateway path (`/ipfs/<cid>/…`,
// `/ipns/<key|dnslink-name>/…`). Typical sources: Kubo directory listings'
// protocol-relative links (`//localhost:8080/ipfs/<cid>`) resolved against
// an `ipfs:` page, old gateway-form bookmarks, and hand-written
// `<iframe src="ipfs://localhost/ipfs/<cid>/">`.
//
// The gate is an explicit known-public-gateway / loopback host allowlist
// (see isKnownGatewayHost). Earlier versions used a negative "host doesn't
// look like a content reference" check, which over-fired for DNSLink hosts:
// e.g. `ipns://docs.ipfs.tech/ipfs/coverage` would try to rewrite even
// though `docs.ipfs.tech` is the actual content host (a DNSLink site that
// genuinely serves a `/ipfs/coverage` page).
//
// `pathname` keeps original case (Chromium only lowercases the host segment
// for standard schemes), so an embedded CIDv0, CIDv1 base58btc, or base58
// IPNS key survives intact and is canonicalised here where possible.
//
// Returns `{ ns, ref, rest }` (ref canonicalised when it could be), or null
// when the URL is not gateway-form.
function matchGatewayForm(host, pathname) {
  if (!isKnownGatewayHost(host)) return null;
  const gatewayMatch = pathname.match(/^\/(ipfs|ipns)\/([^/]+)(.*)$/);
  if (!gatewayMatch) return null;
  const ns = gatewayMatch[1];
  let ref = gatewayMatch[2];
  // For /ipfs/, the embedded ref must be a CID (looksLikeContentKey).
  // For /ipns/, also accept DNSLink-shaped names so e.g.
  // `ipfs://dweb.link/ipns/docs.ipfs.tech/install` rewrites to
  // `ipns://docs.ipfs.tech/install`. Ethereum-name-style hosts are valid
  // DNSLink targets too and route through the resolver branch.
  const refOk = looksLikeContentKey(ref) || (ns === 'ipns' && isLikelyDnsLinkName(ref));
  if (!refOk) return null;
  if (ns === 'ipfs') {
    // CIDv0 (Qm…) → CIDv1 base32, OR CIDv1 base58btc (z…) → base32.
    const canonical = cidV0ToV1Base32(ref) || cidV1B58btcToBase32(ref);
    if (canonical) ref = canonical;
  } else if (looksLikeContentKey(ref)) {
    // Base58 peer ID → libp2p-key base36, or CIDv1 base58btc → base32.
    // DNSLink-shaped names skip canonicalisation and pass through.
    const canonical = ipnsMhToCidV1Base36(ref) || cidV1B58btcToBase32(ref);
    if (canonical) ref = canonical;
  }
  return { ns, ref, rest: gatewayMatch[3] || '/' };
}

// A canonical host must survive Chromium lowercasing the host of a
// standard-scheme URL unchanged in meaning: CIDv1 base32 (`ba…`),
// libp2p-key base36 (`k…`, IPNS only) and DNSLink / Ethereum names (IPNS
// only). A base58 ref that could not be re-encoded (bad multihash, a
// lowercased `qm…`) has no such form.
function isCaseSafeCanonicalRef(ns, ref) {
  if (/^ba[a-z2-7]{49,}$/i.test(ref)) return true;
  if (ns !== 'ipns') return false;
  return /^k[a-z0-9]{40,}$/i.test(ref) || isLikelyDnsLinkName(ref);
}

/**
 * O-3: a gateway-form URL (`ipfs://localhost/ipfs/<cid>/…`,
 * `ipfs://dweb.link/ipns/<name>/…`, any `*.localhost` host) must not have
 * its content served under the gateway host's origin — every CID loaded
 * that way would share one localStorage / IndexedDB / cookie jar. The
 * renderer rewrites top-level address-bar input and page-initiated
 * top-level navigations (PR #352), but iframes (no `will-navigate`) and
 * sub-resources reach the handler as-is.
 *
 * Returns:
 *  - null                 — not gateway-form; serve normally.
 *  - `{ location }`       — redirect to this canonical `ipfs://<cid>/…` /
 *                           `ipns://<name>/…` URL (path and query kept; a
 *                           fragment never reaches the handler).
 *  - `{ refuse: true }`   — gateway-form, but there is no canonical URL to
 *                           send it to; refuse rather than serve it under
 *                           the gateway origin.
 */
function gatewayFormRedirect(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }
  const match = matchGatewayForm(parsed.hostname, parsed.pathname);
  if (!match) return null;
  if (!isCaseSafeCanonicalRef(match.ns, match.ref)) return { refuse: true };
  return {
    location: `${match.ns}://${match.ref.toLowerCase()}${match.rest}${parsed.search}`,
  };
}

module.exports = { gatewayFormRedirect, KNOWN_GATEWAY_HOSTS };
