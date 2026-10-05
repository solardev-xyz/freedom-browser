/**
 * Blockscout's index of ERC-20 transfers, read over its keyless API v2.
 *
 * The router uses it as a second, independent source for a range-capped log
 * scan that no quorum of RPC endpoints can serve: an RPC's full-range
 * eth_getLogs answer is checked against Blockscout's own index of the same
 * transfers (see answerFromIndex in chain-data-router.js). Blockscout runs
 * its own nodes and indexer, so agreement means two providers agree.
 *
 * Gnosis Chain's instance answers at gnosisscan.io (gnosis.blockscout.com
 * redirects there since 2026-10). Redirects are followed by hand, at most
 * MAX_REDIRECTS hops, and every hop's URL must pass the caller's `validateUrl`
 * (the router passes the registry's https-or-loopback check, the one every
 * main-process-fetched endpoint URL gets). That check lets a *configured*
 * URL use plaintext http on loopback (a self-hosted Blockscout), which a
 * redirect must not borrow: a hop that leaves the configured URL's origin must
 * also use https and must not name a loopback or unspecified address (see
 * redirectRefusal). So a remote Blockscout cannot turn the request into a
 * plaintext, LAN or local-service fetch carrying the wallet address.
 */

const net = require('node:net');

// A wallet with more transfers than this (50 per page) is not checked: the
// scan then takes the range-capped path instead.
const MAX_PAGES = 100;
const PAGE_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

// Without a validator from the caller, only https URLs are fetched.
function httpsOnly(url) {
  try {
    return new URL(url).protocol === 'https:' ? null : 'Blockscout URL must use https://';
  } catch {
    return 'Blockscout URL must be a valid URL';
  }
}

// Addresses that reach this machine: 127.0.0.0/8, ::1, their IPv4-mapped and
// -compatible IPv6 forms, and the unspecified 0.0.0.0/8 and :: (which Linux
// and macOS route to the local host). The URL parser has already canonicalised
// shorthand forms such as 127.1, 0x7f.1 and [::ffff:127.0.0.1].
const LOCAL_ADDRESSES = new net.BlockList();
LOCAL_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4');
LOCAL_ADDRESSES.addAddress('::1', 'ipv6');
LOCAL_ADDRESSES.addAddress('::', 'ipv6');
LOCAL_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
LOCAL_ADDRESSES.addSubnet('::ffff:0.0.0.0', 104, 'ipv6');
LOCAL_ADDRESSES.addSubnet('::127.0.0.0', 104, 'ipv6');

function isLocalHostname(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = net.isIP(host);
  if (!version) return false;
  return LOCAL_ADDRESSES.check(host, version === 4 ? 'ipv4' : 'ipv6');
}

// Why a redirect from `origin` (the configured URL's origin) to `target` is
// refused, or null. Staying on the configured origin is fine, whatever its
// scheme: the user chose that server. Leaving it needs https to a host that
// is not this machine, on top of the caller's own check.
function redirectRefusal(target, origin) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return 'redirect to an invalid URL';
  }
  if (parsed.origin === origin) return null;
  if (parsed.protocol !== 'https:') return 'redirect off the configured origin must use https://';
  if (isLocalHostname(parsed.hostname)) return 'redirect to a loopback host';
  return null;
}

class IndexUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndexUnavailableError';
  }
}

async function getJson(url, signal, validateUrl = httpsOnly) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]);
  let target = url;
  let origin = null;
  try {
    origin = new URL(url).origin;
  } catch {
    // validateUrl refuses it below.
  }
  let response;
  for (let hop = 0; ; hop += 1) {
    const invalid = validateUrl(target) || (hop > 0 ? redirectRefusal(target, origin) : null);
    if (invalid) throw new IndexUnavailableError(`Blockscout URL refused: ${invalid}`);
    try {
      response = await fetch(target, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: timeout,
      });
    } catch (err) {
      throw new IndexUnavailableError(`Blockscout request failed: ${err.name || err.message}`);
    }
    const location =
      response.status >= 300 && response.status < 400 && response.headers?.get?.('location');
    if (!location) break;
    response.body?.cancel?.().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new IndexUnavailableError('Blockscout redirected too often');
    try {
      target = new URL(location, target).href;
    } catch {
      throw new IndexUnavailableError('Blockscout redirected to an invalid URL');
    }
  }
  if (!response.ok) {
    response.body?.cancel?.().catch(() => {});
    throw new IndexUnavailableError(`Blockscout answered HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new IndexUnavailableError('Blockscout answered no JSON');
  }
}

/**
 * The newest block Blockscout has indexed, when its block indexing is
 * complete. Blockscout indexes new blocks as they come and catches up on
 * history separately: until it reports that catch-up finished, an old
 * transfer may be missing although the newest block is current, so the index
 * cannot vouch for a range and IndexUnavailableError is thrown.
 */
async function indexedHeight(baseUrl, { signal, validateUrl } = {}) {
  const live = signal || new AbortController().signal;
  const [status, blocks] = await Promise.all([
    getJson(`${baseUrl}/main-page/indexing-status`, live, validateUrl),
    getJson(`${baseUrl}/main-page/blocks`, live, validateUrl),
  ]);
  if (status?.finished_indexing_blocks !== true) {
    throw new IndexUnavailableError('Blockscout has not finished indexing blocks');
  }
  const height = Number(blocks?.[0]?.height);
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new IndexUnavailableError('Blockscout reported no indexed height');
  }
  return height;
}

/**
 * Every ERC-20 transfer of `token` sent by `from`, newest first, as
 * Blockscout's items. Throws IndexUnavailableError when a page fails, the
 * whole read takes longer than TOTAL_TIMEOUT_MS, or the wallet has more than
 * MAX_PAGES pages.
 */
async function tokenTransfersFrom(baseUrl, { from, token, signal, validateUrl } = {}) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TOTAL_TIMEOUT_MS)].filter(Boolean));
  const base = `${baseUrl}/addresses/${from}/token-transfers`;
  const items = [];
  let next = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ type: 'ERC-20', filter: 'from', token, ...(next || {}) });
    const body = await getJson(`${base}?${query}`, deadline, validateUrl);
    if (!Array.isArray(body?.items)) {
      throw new IndexUnavailableError('Blockscout answered no transfer list');
    }
    items.push(...body.items);
    next = body.next_page_params;
    if (!next) return items;
  }
  throw new IndexUnavailableError(`More than ${MAX_PAGES} pages of transfers`);
}

module.exports = {
  indexedHeight,
  tokenTransfersFrom,
  IndexUnavailableError,
  MAX_PAGES,
  MAX_REDIRECTS,
  PAGE_TIMEOUT_MS,
  isLocalHostname,
  TOTAL_TIMEOUT_MS,
};
