/**
 * Blockscout's index of ERC-20 transfers, read over its keyless API v2.
 *
 * The router uses it as a second, independent source for a range-capped log
 * scan that no quorum of RPC endpoints can serve: an RPC's full-range
 * eth_getLogs answer is checked against Blockscout's own index of the same
 * transfers (see verifyWithIndexer in chain-data-router.js). Blockscout runs
 * its own nodes and indexer, so agreement means two providers agree.
 *
 * Gnosis Chain's instance answers at gnosisscan.io (gnosis.blockscout.com
 * redirects there since 2026-10); redirects are followed.
 */

// A wallet with more transfers than this (50 per page) is not checked: the
// scan then takes the range-capped path instead.
const MAX_PAGES = 100;
const PAGE_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 60_000;

class IndexUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndexUnavailableError';
  }
}

async function getJson(url, signal) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]),
    });
  } catch (err) {
    throw new IndexUnavailableError(`Blockscout request failed: ${err.name || err.message}`);
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
 * The newest block Blockscout has indexed.
 */
async function indexedHeight(baseUrl, { signal } = {}) {
  const blocks = await getJson(
    `${baseUrl}/main-page/blocks`,
    signal || new AbortController().signal
  );
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
async function tokenTransfersFrom(baseUrl, { from, token, signal } = {}) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TOTAL_TIMEOUT_MS)].filter(Boolean));
  const base = `${baseUrl}/addresses/${from}/token-transfers`;
  const items = [];
  let next = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ type: 'ERC-20', filter: 'from', token, ...(next || {}) });
    const body = await getJson(`${base}?${query}`, deadline);
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
  PAGE_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
};
