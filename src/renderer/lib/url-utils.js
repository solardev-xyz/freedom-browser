import { isDwebNameHost, isEnsHost } from './origin-utils.js';
import { cidV0ToV1Base32, cidV1B58btcToBase32, ipnsMhToCidV1Base36 } from './cid-utils.js';

export const ensureTrailingSlash = (value = '') => (value.endsWith('/') ? value : `${value}/`);

export const DEFAULT_ONCHAIN_APP_CHAIN_ID = 1;
const ETHEREUM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

/**
 * Parse Freedom's ERC-8244 application URL.
 *
 * Freedom presents the ERC-4804-style `web3://<contract>:<chainId>/` form to
 * users, while Chromium navigates to the equivalent
 * `web3://<contract>.eip155-<chainId>/` origin internally. Chromium's
 * standard-scheme parser mistakes a bare all-hex `0x…` host for an oversized
 * IPv4 literal, and a port-shaped chain id both hits unsafe-port rules and
 * caps chain ids at 65535. Keeping both forms in this one codec prevents that
 * browser implementation detail from leaking into user-facing URL surfaces.
 */
export const parseOnchainAppUrl = (input) => {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;

  const canonicalMatch = raw.match(
    /^web3:\/\/(0x[0-9a-f]{40})\.eip155-([0-9]+)([/?#].*)?$/i
  );
  const friendlyMatch = raw.match(/^web3:\/\/(0x[0-9a-f]{40})(?::([0-9]+))?([/?#].*)?$/i);
  const match = canonicalMatch || friendlyMatch;
  if (!match || !ETHEREUM_ADDRESS_RE.test(match[1])) return null;

  const chainId = Number(match[2] || DEFAULT_ONCHAIN_APP_CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;

  const address = match[1].toLowerCase();
  const rawSuffix = match[3] || '/';
  const suffix = rawSuffix.startsWith('/') ? rawSuffix : `/${rawSuffix}`;
  const canonicalUrl = `web3://${address}.eip155-${chainId}${suffix}`;
  const displayChain = chainId === DEFAULT_ONCHAIN_APP_CHAIN_ID ? '' : `:${chainId}`;
  const displayUrl = `web3://${address}${displayChain}${suffix}`;
  let parsed;
  try {
    parsed = new URL(canonicalUrl);
  } catch {
    return null;
  }

  return {
    address,
    chainId,
    displayUrl,
    url: parsed.toString(),
  };
};

export const looksLikeOnchainAppInput = (input) => /^web3:/i.test((input || '').trim());

export const formatOnchainAppUrl = (input) => parseOnchainAppUrl(input)?.url || null;

export const formatOnchainAppDisplayUrl = (input) => {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw.startsWith('view-source:')) {
    const innerDisplay = formatOnchainAppDisplayUrl(raw.slice('view-source:'.length));
    return innerDisplay ? `view-source:${innerDisplay}` : null;
  }
  return parseOnchainAppUrl(raw)?.displayUrl || null;
};

// Set of transports an Ethereum name contenthash can resolve to that the renderer
// knows how to dispatch. Anything outside this set is treated as
// "unsupported transport" — the navigation surface alerts and aborts
// rather than synthesising a URL we can't load. Single source of truth
// so adding a new transport (e.g. ipfs5) only touches one place.
export const SUPPORTED_ENS_TRANSPORTS = ['bzz', 'ipfs', 'ipns'];

export const isSupportedEnsTransport = (protocol) =>
  typeof protocol === 'string' && SUPPORTED_ENS_TRANSPORTS.includes(protocol);

// decodeURIComponent throws on malformed `%` sequences that show up in
// user-typed URLs; fall back to the raw value in that case.
const decodeAndTrim = (value) => {
  try {
    return decodeURIComponent(value).replace(/\/+$/, '');
  } catch {
    return value.replace(/\/+$/, '');
  }
};

// Check if a string looks like a valid Swarm reference (64 or 128 hex characters)
const isValidSwarmHash = (str) => /^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/.test(str);

// Check if a string looks like a valid IPFS CID
// CIDv0: Starts with Qm, 46 characters, base58
// CIDv1 base32: starts with `b` (multibase) followed by 50+ base32 chars.
//   The 2nd char is always `a` (version byte 0x01 contributes the first
//   5-bit chunk = 0). The 3rd char varies with the codec varint:
//   `bafy…`/`bafk…` for dag-pb / raw, `bagu…` for dag-json (multi-byte
//   codec varint 0xa9 0x02), `bah…` for codecs whose varint top 2 bits
//   are 0b11, etc. An earlier regex hard-coded `baf` and false-rejected
//   every non-`baf` codec, breaking dag-json / blake2b CIDs end-to-end.
// CIDv1 base58btc: starts with z
export const isValidCid = (str) => {
  if (!str || typeof str !== 'string') return false;

  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(str)) {
    return true;
  }

  if (/^ba[a-z2-7]{49,}$/i.test(str)) {
    return true;
  }

  if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(str)) {
    return true;
  }

  return false;
};

// Check if a string looks like a valid Radicle ID (RID)
// RIDs are base58 strings starting with 'z', variable length
export const isValidRadicleId = (str) => {
  if (!str || typeof str !== 'string') return false;

  // Radicle IDs start with 'z' followed by base58 characters
  // Length varies - e.g. z3gqcJUoA1n9HaHKufZs5FCSGazv5 is 30 chars
  if (/^z[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(str)) {
    return true;
  }

  return false;
};

// Check if a string looks like a domain name (not a Swarm hash)
const looksLikeDomain = (str) => {
  // Must contain at least one dot
  if (!str.includes('.')) return false;

  // Extract the part before any path/query
  const hostPart = str.split(/[/?#]/)[0];

  // Should not be a valid Swarm hash
  if (isValidSwarmHash(hostPart)) return false;

  // Check for common domain patterns
  // - Has a TLD-like ending (2-10 chars after last dot)
  // - No spaces
  // - Reasonable characters for a domain
  const domainRegex =
    /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,10}$/;
  return domainRegex.test(hostPart);
};

export const parseHashInput = (rawInput, bzzRoutePrefix) => {
  if (!bzzRoutePrefix) {
    return null;
  }

  const withoutScheme = rawInput.replace(/^bzz:\/\//i, '').replace(/^\/+/, '');
  if (!withoutScheme) {
    return null;
  }

  let working = withoutScheme;
  let fragment = '';
  let query = '';

  const hashIndex = working.indexOf('#');
  if (hashIndex !== -1) {
    fragment = working.slice(hashIndex);
    working = working.slice(0, hashIndex);
  }

  const queryIndex = working.indexOf('?');
  if (queryIndex !== -1) {
    query = working.slice(queryIndex);
    working = working.slice(0, queryIndex);
  }

  const slashIndex = working.indexOf('/');
  let hash = working;
  let path = '';
  if (slashIndex !== -1) {
    hash = working.slice(0, slashIndex);
    path = working.slice(slashIndex);
  }

  if (!hash) {
    return null;
  }

  const tail = `${path}${query}${fragment}`;
  const baseUrl = ensureTrailingSlash(`${bzzRoutePrefix}${hash}`);

  return {
    hash,
    tail,
    baseUrl,
    displayValue: `bzz://${hash}${tail}`,
  };
};

export const composeTargetUrl = (baseUrl, suffix = '') => {
  // Ensure suffix doesn't start with / if we want to append it relative to base
  const cleanSuffix = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  try {
    return new URL(cleanSuffix, baseUrl).toString();
  } catch {
    return `${baseUrl}${cleanSuffix}`;
  }
};

export const deriveBzzBaseFromUrl = (input) => {
  if (!input) {
    return null;
  }
  try {
    const parsed = typeof input === 'string' ? new URL(input) : input;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2 && segments[0].toLowerCase() === 'bzz') {
      const hash = segments[1];
      if (hash) {
        return ensureTrailingSlash(`${parsed.origin}/bzz/${hash}`);
      }
    }
  } catch {
    return null;
  }
  return null;
};

// True when `input` is intended as a Swarm/bzz navigation target — either the
// `bzz:` / `bzz://` scheme or a bare Swarm hash. `formatBzzUrl` returns null
// when the route prefix is unavailable (node disabled/stopped), so callers use
// this to detect Swarm intent and surface a friendly "node not running" page
// instead of dropping the navigation silently. Mirrors the hash/scheme
// detection `formatBzzUrl` itself performs.
export const looksLikeBzzInput = (input) => {
  const raw = (input || '').trim();
  if (!raw) return false;
  if (/^bzz:/i.test(raw)) return true;
  return isValidSwarmHash(raw.split('/')[0]);
};

export const formatBzzUrl = (input, bzzRoutePrefix) => {
  const raw = (input || '').trim();
  if (!raw) {
    return null;
  }

  try {
    const asUrl = new URL(raw);
    if (asUrl.protocol === 'bzz:') {
      const hashInput = `${asUrl.hostname}${asUrl.pathname}${asUrl.search}${asUrl.hash}`;
      const parsedBzz = parseHashInput(hashInput, bzzRoutePrefix);
      if (!parsedBzz) {
        return null;
      }
      return {
        targetUrl: composeTargetUrl(parsedBzz.baseUrl, parsedBzz.tail || ''),
        displayValue: parsedBzz.displayValue,
        baseUrl: parsedBzz.baseUrl,
      };
    }
    const derivedBase = deriveBzzBaseFromUrl(asUrl);
    const displayValue = deriveDisplayValue(asUrl.toString(), bzzRoutePrefix, '');
    return {
      targetUrl: asUrl.toString(),
      displayValue,
      baseUrl: derivedBase,
    };
  } catch {
    // URL parsing failed - could be a domain without protocol or a Swarm hash

    // Check if it looks like a regular domain (e.g., "spiegel.de", "example.com/path")
    if (looksLikeDomain(raw)) {
      // Tor onion services default to http:// — the .onion address itself
      // provides end-to-end encryption, and most are http-only, so defaulting
      // to https would break them. Routing through Tor is handled at the
      // session layer (see src/main/tor-proxy.js); the address bar just needs
      // to produce a loadable http(s) URL.
      const hostPart = raw.split(/[/?#]/)[0].toLowerCase();
      // Allow an optional :port so e.g. `abc.onion:8080` is still detected.
      const scheme = /\.onion(:\d+)?$/.test(hostPart) ? 'http' : 'https';
      const urlWithProtocol = `${scheme}://${raw}`;
      return {
        targetUrl: urlWithProtocol,
        displayValue: urlWithProtocol,
        baseUrl: null,
      };
    }

    // Extract potential hash (first segment before /)
    const firstSegment = raw.split('/')[0].replace(/^bzz:\/\//i, '');

    // Only treat as Swarm reference if it's valid hex (64 or 128 chars)
    if (!isValidSwarmHash(firstSegment)) {
      return null;
    }

    const parsed = parseHashInput(raw, bzzRoutePrefix);
    if (!parsed) {
      return null;
    }
    return {
      targetUrl: composeTargetUrl(parsed.baseUrl, parsed.tail || ''),
      displayValue: parsed.displayValue,
      baseUrl: parsed.baseUrl,
    };
  }
};

/**
 * Build a transport-aware name display URI.
 *
 * Given a resolved transport ('bzz' | 'ipfs' | 'ipns') and a name + path
 * suffix, returns a display URL whose host is the name and whose scheme
 * matches the resolved transport. Used in two places:
 *
 *   - When name resolution succeeds, navigation derives the address-bar value
 *     from this helper instead of always emitting `ens://<name>`.
 *   - View-source on name-backed content reuses the same shape with a
 *     `view-source:` prefix added by the caller.
 *
 * The legacy `ens://<name>` form is intentionally NOT produced here — it
 * stays parseable for compatibility with existing bookmarks, but is no
 * longer the canonical display.
 *
 * @param {'bzz'|'ipfs'|'ipns'} protocol - resolved contenthash transport
 * @param {string} name - name (already normalized/lowercased upstream)
 * @param {string} [suffix] - optional path/query/fragment, including any leading '/'
 * @returns {string|null} display URI, or null when protocol is unsupported
 */
export const buildEnsDisplayUri = (protocol, name, suffix = '') => {
  if (!name) return null;
  if (!isSupportedEnsTransport(protocol)) return null;
  return `${protocol}://${name}${suffix || ''}`;
};

/**
 * True when `displayUrl` is a name-backed display value the address bar
 * should treat as name resolution. Recognises the bare-name form
 * (`vitalik.eth/path`), the legacy `ens://` form, and the transport-aware
 * `bzz://`/`ipfs://`/`ipns://` forms whose host is a supported Ethereum name.
 *
 * Used to gate the "clear known name mappings on direct navigation" branches
 * in `loadTarget`, so that transport name URLs (post-resolution display) do
 * not delete the hash→name mapping that the new display relies on.
 *
 * Mirrors what `parseEnsInput` accepts, but kept here as a window-free
 * helper so url-utils doesn't pull in page-urls' module-init `window`
 * dependencies (homeUrl, internalPages). The test suite asserts both
 * stay in sync.
 *
 * @param {string} displayUrl
 * @returns {boolean}
 */
export const isEnsBackedDisplay = (displayUrl) => {
  if (!displayUrl) return false;
  const trimmed = displayUrl.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('ens://')) return true;
  const transportMatch = lower.match(/^(?:bzz|ipfs|ipns):\/\/([^/?#]+)/);
  if (transportMatch) {
    return isDwebNameHost(transportMatch[1]);
  }
  return isDwebNameHost(trimmed.split(/[/?#]/)[0]);
};

/**
 * Convert a legacy `ens://name.eth[/path]` bookmark target to the bare-name
 * form (`name.eth[/path]`) so it enters the same navigation flow as a typed
 * name. Non-name inputs are returned unchanged.
 *
 * The migration plan keeps `ens://` parseable for compatibility but moves
 * the canonical address-bar form to the resolved transport
 * (`bzz://name.eth`, `ipfs://name.eth`, `ipns://name.eth`). Stored bookmarks
 * predating that change still carry `ens://`; rewriting them at open time
 * avoids re-displaying the legacy form after resolution lands.
 *
 * @param {string} url
 * @returns {string} bare-name form, or original input if not a legacy ens:// URL
 */
export const normalizeLegacyEnsBookmarkUrl = (url) => {
  if (typeof url !== 'string') return url;
  const match = url.match(/^ens:\/\/([^/?#]+)(.*)$/i);
  if (!match) return url;
  if (!isEnsHost(match[1])) return url;
  return `${match[1].toLowerCase()}${match[2] || ''}`;
};

/**
 * Apply name preservation to a display URL.
 * If the URL is a bzz/ipfs/ipns URL with a hash/CID that has a known name,
 * substitute the name as the host, preserving the resolved transport
 * scheme (e.g. `bzz://<hash>/path` → `bzz://<name>/path`). The legacy
 * `ens://<name>` form is intentionally not produced here — see
 * `buildEnsDisplayUri` and the ENS link migration notes.
 *
 * @param {string} displayUrl - Display URL like "bzz://abc123/path" or "ipfs://QmHash/path"
 * @param {Map} knownEnsNames - Map of hash/CID -> name
 * @returns {string} Display URL with name substituted if applicable
 */
export const applyEnsNamePreservation = (displayUrl, knownEnsNames) => {
  if (!displayUrl || !knownEnsNames || knownEnsNames.size === 0) {
    return displayUrl;
  }

  // Handle view-source: prefix - apply name preservation to inner URL and prepend view-source:
  if (displayUrl.startsWith('view-source:')) {
    const innerUrl = displayUrl.slice(12); // 'view-source:'.length === 12
    const innerResult = applyEnsNamePreservation(innerUrl, knownEnsNames);
    return `view-source:${innerResult}`;
  }

  let derived = displayUrl;

  // Apply ENS name preservation for Swarm
  const bzzMatch = derived.match(/^bzz:\/\/([a-fA-F0-9]+)/);
  if (bzzMatch) {
    const hash = bzzMatch[1].toLowerCase();
    const name = knownEnsNames.get(hash);
    if (name) {
      const prefixLen = bzzMatch[0].length;
      const path = derived.slice(prefixLen);
      derived = `bzz://${name}${path}`;
    }
  }

  // Apply ENS name preservation for IPFS
  const ipfsMatch = derived.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
  if (ipfsMatch) {
    const cid = ipfsMatch[1];
    const name = knownEnsNames.get(cid);
    if (name) {
      const prefixLen = ipfsMatch[0].length;
      const path = derived.slice(prefixLen);
      derived = `ipfs://${name}${path}`;
    }
  }

  // Apply ENS name preservation for IPNS
  const ipnsMatch = derived.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
  if (ipnsMatch) {
    const id = ipnsMatch[1];
    const name = knownEnsNames.get(id);
    if (name) {
      const prefixLen = ipnsMatch[0].length;
      const path = derived.slice(prefixLen);
      derived = `ipns://${name}${path}`;
    }
  }

  return derived;
};

export const deriveDisplayValue = (
  url,
  bzzRoutePrefix,
  homeUrlNormalized,
  ipfsRoutePrefix = null,
  ipnsRoutePrefix = null,
  radicleApiPrefix = null
) => {
  if (!url) {
    return '';
  }

  if (url === 'about:blank' || url === homeUrlNormalized) {
    return '';
  }

  // Handle view-source: prefix - derive display value for inner URL and prepend view-source:
  if (url.startsWith('view-source:')) {
    const innerUrl = url.slice(12); // 'view-source:'.length === 12
    const innerDisplay = deriveDisplayValue(
      innerUrl,
      bzzRoutePrefix,
      homeUrlNormalized,
      ipfsRoutePrefix,
      ipnsRoutePrefix
    );
    return innerDisplay ? `view-source:${innerDisplay}` : url;
  }

  const onchainDisplay = formatOnchainAppDisplayUrl(url);
  if (onchainDisplay) {
    return onchainDisplay;
  }

  if (bzzRoutePrefix && url.startsWith(bzzRoutePrefix)) {
    const decoded = decodeAndTrim(url.slice(bzzRoutePrefix.length));
    return decoded ? `bzz://${decoded}` : '';
  }

  if (ipfsRoutePrefix && url.startsWith(ipfsRoutePrefix)) {
    const decoded = decodeAndTrim(url.slice(ipfsRoutePrefix.length));
    return decoded ? `ipfs://${decoded}` : '';
  }

  if (ipnsRoutePrefix && url.startsWith(ipnsRoutePrefix)) {
    const decoded = decodeAndTrim(url.slice(ipnsRoutePrefix.length));
    return decoded ? `ipns://${decoded}` : '';
  }

  if (radicleApiPrefix && url.startsWith(radicleApiPrefix)) {
    const decoded = decodeAndTrim(url.slice(radicleApiPrefix.length));
    return decoded ? `rad://${decoded}` : '';
  }

  return url;
};

// ============ IPFS URL Utilities ============

/**
 * Parse an IPFS input (CID with optional path/query/fragment)
 * @param {string} rawInput - Input like "QmHash/path" or "ipfs://QmHash/path"
 * @param {string} ipfsRoutePrefix - Gateway prefix like "http://127.0.0.1:8080/ipfs/"
 * @returns {object|null} Parsed result with cid, tail, baseUrl, displayValue
 */
// Mirrored in src/main/ipfs/ipfs-protocol.js — keep in sync.
//
// Returns true for the embedded ref of a gateway-form path that we'll
// rewrite to the canonical `<scheme>://<ref>/...` form. Stricter than
// the full IPNS-host shape: Ethereum names are excluded here because their
// gateway-form embedded representation is vanishingly rare and ambiguous
// with arbitrary DNSLink subpaths.
const looksLikeContentKey = (ref) => {
  if (typeof ref !== 'string' || !ref) return false;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/i.test(ref)) return true;
  // `ba…` covers all CIDv1 base32 codecs: `bafy…`/`bafk…` (dag-pb / raw),
  // `bagu…` (dag-json), `bah…` and others — see the `isValidCid` comment.
  if (/^ba[a-z2-7]{49,}$/i.test(ref)) return true;
  if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(ref)) return true;
  if (/^k[a-z0-9]{40,}$/i.test(ref)) return true;
  if (/^(12D3|16Uiu2H)[a-zA-Z0-9]{30,}$/i.test(ref)) return true;
  return false;
};

// Hostname-shaped string with at least one dot — used to recognise
// DNSLink targets in the embedded ref of `ipfs://<gateway>/ipns/<name>/...`
// gateway-form URLs. Only meaningful when the surrounding namespace is
// `ipns` (DNSLink doesn't apply under `/ipfs/`).
const isLikelyDnsLinkName = (ref) => {
  if (typeof ref !== 'string' || !ref) return false;
  if (ref.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(ref);
};

// Hosts we recognise as IPFS gateways for the gateway-form rewrite.
// Conservative allowlist — see the matching `KNOWN_GATEWAY_HOSTS` in
// src/main/ipfs/ipfs-protocol.js for the full rationale.
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

// Strip a trailing `:<port>` from a host slot to compare against the
// gateway allowlist. `parseIpfsInput` is intentionally byte-level (it
// avoids `new URL()` so base58btc hosts survive Chromium's standard-
// scheme lowercasing — see the comment in `parseIpfsInput`), so port
// handling has to be done here too. Kubo emits protocol-relative anchors
// like `<a href="//localhost:<gateway-port>/ipfs/<cid>">`, which Chromium resolves
// against the page's `ipfs://` origin to `ipfs://localhost:<gateway-port>/ipfs/<cid>`;
// without stripping the port the allowlist comparison would miss and the
// rewrite would fall through, leaving the address bar permanently on
// the gateway-origin form. `[::1]:8080` and bare `[::1]` are handled by
// looking for a closing bracket first.
const stripPort = (host) => {
  if (typeof host !== 'string' || !host) return host;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
};

const isKnownGatewayHost = (host) => {
  if (typeof host !== 'string' || !host) return false;
  const lower = stripPort(host).toLowerCase();
  if (KNOWN_GATEWAY_HOSTS.has(lower)) return true;
  if (lower.endsWith('.localhost')) return true;
  return false;
};

export const parseIpfsInput = (rawInput, ipfsRoutePrefix) => {
  if (!ipfsRoutePrefix) {
    return null;
  }

  // Remove ipfs:// or ipns:// scheme
  let withoutScheme = rawInput
    .replace(/^ipfs:\/\//i, '')
    .replace(/^ipns:\/\//i, '')
    .replace(/^\/+/, '');
  let isIpns = /^ipns:\/\//i.test(rawInput);

  if (!withoutScheme) {
    return null;
  }

  let working = withoutScheme;
  let fragment = '';
  let query = '';

  const hashIndex = working.indexOf('#');
  if (hashIndex !== -1) {
    fragment = working.slice(hashIndex);
    working = working.slice(0, hashIndex);
  }

  const queryIndex = working.indexOf('?');
  if (queryIndex !== -1) {
    query = working.slice(queryIndex);
    working = working.slice(0, queryIndex);
  }

  const slashIndex = working.indexOf('/');
  let cid = working;
  let path = '';
  if (slashIndex !== -1) {
    cid = working.slice(0, slashIndex);
    path = working.slice(slashIndex);
  }

  if (!cid) {
    return null;
  }

  // Gateway-form rewrite. When the path looks like a path-gateway URL
  // (`/ipfs/<cid>/...` or `/ipns/<key>/...`) and the OUTER host is a
  // recognised public-gateway / loopback hostname, the embedded
  // reference is the actual content target. The most common source is
  // Kubo's auto-generated directory listings: those emit
  // `<a href="//localhost:<gateway-port>/ipfs/<cid>">` which Chromium resolves
  // against the page's `ipfs:` scheme to `ipfs://localhost/ipfs/<cid>`.
  // Without this rewrite, every link in a Kubo dir listing 404s.
  //
  // The gate is an explicit known-gateway allowlist (mirrors
  // src/main/ipfs/ipfs-protocol.js) — earlier versions used a negative
  // "host doesn't look like a content reference" check, which over-fired
  // for DNSLink hosts (e.g. `ipns://docs.ipfs.tech/ipfs/coverage` would
  // try to rewrite even though `docs.ipfs.tech` is the actual content
  // host). For `/ipns/`, the embedded ref is also allowed to be a
  // DNSLink-shaped name so `ipfs://dweb.link/ipns/docs.ipfs.tech/install`
  // rewrites to `ipns://docs.ipfs.tech/install`.
  if (isKnownGatewayHost(cid)) {
    const gatewayMatch = path.match(/^\/(ipfs|ipns)\/([^/]+)(.*)$/);
    if (gatewayMatch) {
      const innerNs = gatewayMatch[1];
      const ref = gatewayMatch[2];
      const refOk =
        looksLikeContentKey(ref) || (innerNs === 'ipns' && isLikelyDnsLinkName(ref));
      if (refOk) {
        isIpns = innerNs === 'ipns';
        cid = ref;
        path = gatewayMatch[3] || '';
      }
    }
  }

  // Canonicalise the CID/key to a lowercase form before we hand it to
  // anything that might re-parse it as a hostname. `ipfs:`/`ipns:` are
  // standard schemes (see src/main/index.js), so Chromium's URL parser
  // lowercases the host, which destroys base58btc-encoded CIDv0 ("Qm..."),
  // CIDv1 base58btc ("z..."), and base58btc IPNS peer-ID multihashes
  // ("12D3...", "16Uiu2H...", "Qm..."). Converting CIDv0 / CIDv1-base58btc
  // → CIDv1 base32 and base58 IPNS peer IDs → libp2p-key base36 keeps the
  // round-trip intact. DNSLink and ENS hosts fall through unchanged.
  if (isIpns) {
    const ipnsBase36 = ipnsMhToCidV1Base36(cid);
    if (ipnsBase36) {
      cid = ipnsBase36;
    } else {
      const zToBase32 = cidV1B58btcToBase32(cid);
      if (zToBase32) cid = zToBase32;
    }
  } else {
    const ipfsBase32 = cidV0ToV1Base32(cid) || cidV1B58btcToBase32(cid);
    if (ipfsBase32) cid = ipfsBase32;
  }

  const tail = `${path}${query}${fragment}`;
  const protocol = isIpns ? 'ipns' : 'ipfs';
  // For IPNS, use ipns route prefix instead
  const routePrefix = isIpns ? ipfsRoutePrefix.replace('/ipfs/', '/ipns/') : ipfsRoutePrefix;
  const baseUrl = ensureTrailingSlash(`${routePrefix}${cid}`);

  return {
    cid,
    tail,
    baseUrl,
    protocol,
    displayValue: `${protocol}://${cid}${tail}`,
  };
};

/**
 * Derive IPFS base URL from a gateway URL.
 * Accepts the path-gateway form ("http://localhost:<gateway-port>/ipfs/CID/path").
 * The subdomain-gateway form is no longer recognised here — Chromium never
 * sees `<cid>.ipfs.localhost` URLs since `ipfs:`/`ipns:` are standard
 * schemes and the protocol handler in `src/main/ipfs/ipfs-protocol.js`
 * follows Kubo's redirect internally.
 * @param {string|URL} input
 * @returns {string|null} Base URL with trailing slash
 */
export const deriveIpfsBaseFromUrl = (input) => {
  if (!input) {
    return null;
  }
  try {
    const parsed = typeof input === 'string' ? new URL(input) : input;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const prefix = segments[0].toLowerCase();
      if (prefix === 'ipfs' || prefix === 'ipns') {
        const cid = segments[1];
        if (cid) {
          return ensureTrailingSlash(`${parsed.origin}/${prefix}/${cid}`);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
};

/**
 * Format user input into an IPFS gateway URL
 * @param {string} input - User input (CID, ipfs://CID, ipns://name, etc.)
 * @param {string} ipfsRoutePrefix - Gateway prefix like "http://127.0.0.1:8080/ipfs/"
 * @returns {object|null} Object with targetUrl, displayValue, baseUrl, protocol
 */
export const formatIpfsUrl = (input, ipfsRoutePrefix) => {
  const raw = (input || '').trim();
  if (!raw) {
    return null;
  }

  // Handle ipfs:// and ipns:// via the case-preserving string parser
  // *before* `new URL` gets a chance to lowercase the host. Because these
  // schemes are now registered standard schemes, `new URL('ipfs://Qm.../')`
  // yields `hostname === 'qm...'`, which destroys base58btc CIDv0 and
  // IPNS peer-ID multihashes. parseIpfsInput preserves case and then
  // canonicalises CIDv0 -> CIDv1 base32 / base58 IPNS -> libp2p-key
  // base36, both lowercase encodings that round-trip cleanly through
  // Chromium's URL parser.
  if (/^ipfs:\/\//i.test(raw) || /^ipns:\/\//i.test(raw)) {
    const parsed = parseIpfsInput(raw, ipfsRoutePrefix);
    if (!parsed) {
      return null;
    }
    return {
      targetUrl: composeTargetUrl(parsed.baseUrl, parsed.tail || ''),
      displayValue: parsed.displayValue,
      baseUrl: parsed.baseUrl,
      protocol: parsed.protocol,
    };
  }

  try {
    const asUrl = new URL(raw);

    // Check if it's already a gateway URL
    const derivedBase = deriveIpfsBaseFromUrl(asUrl);
    if (derivedBase) {
      const isIpns = asUrl.pathname.toLowerCase().startsWith('/ipns/');
      const ipnsRoutePrefix = ipfsRoutePrefix
        ? ipfsRoutePrefix.replace('/ipfs/', '/ipns/')
        : null;
      return {
        targetUrl: asUrl.toString(),
        displayValue: deriveDisplayValue(
          asUrl.toString(),
          '',
          '',
          ipfsRoutePrefix,
          ipnsRoutePrefix
        ),
        baseUrl: derivedBase,
        protocol: isIpns ? 'ipns' : 'ipfs',
      };
    }

    return null;
  } catch {
    // URL parsing failed - check if it's a raw CID
    const firstSegment = raw
      .split('/')[0]
      .replace(/^ipfs:\/\//i, '')
      .replace(/^ipns:\/\//i, '');

    // Check if it looks like a CID
    if (isValidCid(firstSegment)) {
      const parsed = parseIpfsInput(raw, ipfsRoutePrefix);
      if (!parsed) {
        return null;
      }
      return {
        targetUrl: composeTargetUrl(parsed.baseUrl, parsed.tail || ''),
        displayValue: parsed.displayValue,
        baseUrl: parsed.baseUrl,
        protocol: parsed.protocol,
      };
    }

    return null;
  }
};

// ============ Radicle URL Utilities ============

/**
 * Parse a Radicle input (RID with optional path)
 * Accepts both rad:RID and rad://RID formats
 * @param {string} rawInput - Input like "zRID", "rad:zRID/tree/main/path", or "rad://zRID"
 * @param {string} radicleApiPrefix - Internal API prefix like "radapi://local/api/v1/repos/"
 * @returns {object|null} Parsed result with rid, tail, baseUrl, displayValue
 */
export const parseRadicleInput = (rawInput, radicleApiPrefix) => {
  if (!radicleApiPrefix) {
    return null;
  }

  // Remove rad: or rad:// prefix
  let withoutScheme = rawInput.replace(/^rad:\/\//i, '').replace(/^rad:/i, '').replace(/^\/+/, '');

  if (!withoutScheme) {
    return null;
  }

  let working = withoutScheme;
  let fragment = '';
  let query = '';

  const hashIndex = working.indexOf('#');
  if (hashIndex !== -1) {
    fragment = working.slice(hashIndex);
    working = working.slice(0, hashIndex);
  }

  const queryIndex = working.indexOf('?');
  if (queryIndex !== -1) {
    query = working.slice(queryIndex);
    working = working.slice(0, queryIndex);
  }

  const slashIndex = working.indexOf('/');
  let rid = working;
  let path = '';
  if (slashIndex !== -1) {
    rid = working.slice(0, slashIndex);
    path = working.slice(slashIndex);
  }

  if (!rid) {
    return null;
  }

  const tail = `${path}${query}${fragment}`;
  const baseUrl = ensureTrailingSlash(`${radicleApiPrefix}${rid}`);

  return {
    rid,
    tail,
    baseUrl,
    displayValue: `rad://${rid}${tail}`,
  };
};

/**
 * Format user input into a Radicle browser page URL
 * @param {string} input - User input (RID, rad:RID, etc.)
 * @param {string} radicleBase - Internal Radicle API base URL
 * @returns {object|null} Object with targetUrl, displayValue, protocol
 */
export const formatRadicleUrl = (input, radicleBase) => {
  const raw = (input || '').trim();
  if (!raw) {
    return null;
  }
  if (!radicleBase) {
    return null;
  }

  // Helper to build rad-browser.html URL
  const buildBrowserUrl = (rid, path) => {
    const browserUrl = new URL('pages/rad-browser.html', window.location.href);
    browserUrl.searchParams.set('rid', rid);
    browserUrl.searchParams.set('base', radicleBase);
    if (path) {
      browserUrl.searchParams.set('path', path);
    }
    return browserUrl.toString();
  };

  // Check if it starts with rad: or rad:// prefix
  if (raw.toLowerCase().startsWith('rad:')) {
    // Handle both rad:RID and rad://RID formats
    const withoutScheme = raw.replace(/^rad:\/\//i, '').replace(/^rad:/i, '').replace(/^\/+/, '');
    if (!withoutScheme) return null;

    const slashIndex = withoutScheme.indexOf('/');
    const rid = slashIndex === -1 ? withoutScheme : withoutScheme.slice(0, slashIndex);
    const path = slashIndex === -1 ? '' : withoutScheme.slice(slashIndex);

    if (!rid || !isValidRadicleId(rid)) return null;

    return {
      targetUrl: buildBrowserUrl(rid, path),
      displayValue: `rad://${rid}${path}`,
      protocol: 'radicle',
    };
  }

  // Check if it's a raw Radicle ID (starts with z)
  const slashIndex = raw.indexOf('/');
  const firstSegment = slashIndex === -1 ? raw : raw.slice(0, slashIndex);

  if (isValidRadicleId(firstSegment)) {
    const rid = firstSegment;
    const path = slashIndex === -1 ? '' : raw.slice(slashIndex);

    return {
      targetUrl: buildBrowserUrl(rid, path),
      displayValue: `rad://${rid}${path}`,
      protocol: 'radicle',
    };
  }

  return null;
};

/**
 * Derive display value for Radicle URLs
 * @param {string} url - API URL like "http://127.0.0.1:8080/api/v1/repos/zRID/tree/main"
 * @param {string} radicleApiPrefix - API prefix to strip
 * @returns {string} Display value like "rad://zRID/tree/main"
 */
export const deriveRadicleDisplayValue = (url, radicleApiPrefix) => {
  if (!url || !radicleApiPrefix) return url;

  if (url.startsWith(radicleApiPrefix)) {
    const decoded = decodeAndTrim(url.slice(radicleApiPrefix.length));
    return decoded ? `rad://${decoded}` : '';
  }

  return url;
};
