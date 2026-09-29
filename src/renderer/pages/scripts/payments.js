// freedomAPI is exposed globally by webview-preload.js via contextBridge.

const resultsEl = document.getElementById('results');
const statsEl = document.getElementById('stats');
const searchInput = document.getElementById('search-input');
const kindSelect = document.getElementById('kind-select');
const chainSelect = document.getElementById('chain-select');
const clearBtn = document.getElementById('clear-btn');

// The page fetches up to PAGE_LIMIT rows server-side (matching the
// store's MAX_LIMIT clamp) and does search + per-chain filtering
// client-side. For day-one volume this is fine; once anyone breaks
// 500 payments we'll wire a "Load more" pager onto the bottom.
const PAGE_LIMIT = 500;

let payments = []; // current server-filtered page
let chainsById = new Map(); // chainId → { name, shortName, blockExplorer }
let tokensByKey = new Map(); // `chainId:address` → { symbol, decimals }

// Single source of truth for the three kind values: the renderer label,
// the CSS class, and the "this row didn't carry an origin" fallback.
// Unknown kinds fall back to a neutral pill with the raw value.
const KIND_META = {
  x402: { label: 'x402', cls: 'kind-x402', anonLabel: '—' },
  'wallet-send': { label: 'send', cls: 'kind-wallet-send', anonLabel: 'wallet send' },
  'dapp-send': { label: 'dapp', cls: 'kind-dapp-send', anonLabel: 'dapp send' },
  'safe-send': { label: 'safe', cls: 'kind-safe', anonLabel: 'safe send' },
  'safe-deploy': { label: 'safe setup', cls: 'kind-safe', anonLabel: 'safe activation' },
};
const KIND_FALLBACK = { label: '', cls: '', anonLabel: '—' };

// Atomic-units → decimal string with `decimals` precision, trailing
// zeroes stripped. Deliberately NOT the wallet's formatRawTokenBalance:
// that one caps display at 4 decimals and emits "<0.0001" — wrong for
// a payment-history audit log where cents matter.
function formatAtomic(amount, decimals) {
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return '--';
  // Without decimals we can't render a meaningful human amount; showing
  // "1000000" next to a token symbol would read as a million tokens.
  if (typeof decimals !== 'number') return '--';
  try {
    const value = BigInt(amount);
    const divisor = 10n ** BigInt(decimals);
    const integer = value / divisor;
    const frac = value % divisor;
    if (frac === 0n) return integer.toString();
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${integer}.${fracStr}`;
  } catch {
    return '--';
  }
}

function truncateAddress(addr, head = 6, tail = 4) {
  if (!addr || typeof addr !== 'string') return '';
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

// Build an element with an optional class list, text and tooltip. Text always
// goes in through textContent: the origin, addresses and hashes are
// site- or chain-controlled, so nothing row-derived is ever parsed as HTML on
// this page (#432).
function el(tag, className, text, title) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text == null ? '' : String(text);
  if (title !== undefined) node.title = title == null ? '' : String(title);
  return node;
}

// Only link out to an http(s) block explorer; anything else (a malformed or
// hostile network config) renders as plain text instead of an href.
function explorerTxUrl(blockExplorer, txHash) {
  try {
    const url = new URL(`${blockExplorer}/tx/${txHash}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function formatWhen(createdAt) {
  const d = new Date(createdAt);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function kindMeta(kind) {
  return KIND_META[kind] || { ...KIND_FALLBACK, label: kind || '' };
}

function siteCell(payment) {
  if (payment.origin) {
    return el('span', '', payment.origin, payment.origin);
  }
  return el('span', 'anon', kindMeta(payment.kind).anonLabel);
}

function amountCell(payment) {
  const tokenKey = payment.asset ? `${payment.chainId}:${payment.asset}` : null;
  const token = tokenKey ? tokensByKey.get(tokenKey) : null;
  const decimals = token?.decimals;
  const symbol = token?.symbol || (payment.asset ? 'token' : 'native');
  const pretty = formatAtomic(payment.amount, decimals);
  return [document.createTextNode(pretty), el('span', 'amount-asset', symbol)];
}

function chainCell(payment) {
  const chain = chainsById.get(payment.chainId);
  const label = chain?.shortName || chain?.name || `chain ${payment.chainId}`;
  return el('span', 'badge chain-badge', label, label);
}

function txCell(payment) {
  if (!payment.txHash) return el('span', 'tx-empty', 'no hash');
  const chain = chainsById.get(payment.chainId);
  const short = truncateAddress(payment.txHash, 10, 8);
  const url = chain?.blockExplorer ? explorerTxUrl(chain.blockExplorer, payment.txHash) : null;
  if (url) {
    const link = el('a', 'tx-link', short, payment.txHash);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    return link;
  }
  return el('span', 'addr', short, payment.txHash);
}

function cell(className, ...content) {
  const td = el('td', className);
  td.append(...content.flat());
  return td;
}

// Built with DOM APIs, not an HTML string (#432).
function renderRow(p) {
  const kind = kindMeta(p.kind);
  const tr = document.createElement('tr');
  const when = el('td', 'when', formatWhen(p.createdAt), new Date(p.createdAt).toLocaleString());
  const kindBadge = el('span', 'badge', kind.label);
  if (kind.cls) kindBadge.classList.add(kind.cls);
  const status = el('span', 'status-pill', p.status);
  if (/^[\w-]+$/.test(p.status || '')) status.classList.add(`status-${p.status}`);
  tr.append(
    when,
    cell('', kindBadge),
    cell('site', siteCell(p)),
    cell('amount', amountCell(p)),
    el('td', 'addr', truncateAddress(p.toAddress), p.toAddress || ''),
    cell('', chainCell(p)),
    cell('', status),
    cell('', txCell(p))
  );
  return tr;
}

function applyClientFilters(rows) {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((p) => {
    const hay =
      `${p.origin || ''} ${p.toAddress || ''} ${p.fromAddress || ''} ${p.txHash || ''} ${p.url || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

// Subtitle counter, shared by the sibling list pages (history, downloads,
// payments): pluralise the noun, and name how much of the whole list is
// showing while a filter is active (#254). Duplicated per page because
// these classic page scripts cannot import that ES module; the copies are held
// identical to src/renderer/lib/ui-format.js by
// src/renderer/pages/list-page-counters.test.js.
function formatCount(shown, total, singular, plural = `${singular}s`) {
  const noun = total === 1 ? singular : plural;
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

const TABLE_HEADINGS = ['When', 'Kind', 'Site', 'Amount', 'To', 'Chain', 'Status', 'Tx'];

function render() {
  const filtered = applyClientFilters(payments);

  statsEl.textContent = formatCount(filtered.length, payments.length, 'payment');

  if (filtered.length === 0) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="6" width="20" height="12" rx="2"></rect>
          <circle cx="12" cy="12" r="2"></circle>
        </svg>
        <p>${payments.length === 0 ? 'No payments yet' : 'No payments match your filters'}</p>
      </div>
    `;
    return;
  }

  const headRow = document.createElement('tr');
  for (const heading of TABLE_HEADINGS) headRow.append(el('th', '', heading));
  const thead = document.createElement('thead');
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  tbody.append(...filtered.map(renderRow));
  const table = document.createElement('table');
  table.append(thead, tbody);
  const wrap = el('div', 'table-wrap');
  wrap.append(table);
  resultsEl.replaceChildren(wrap);
}

function showLoadError(message) {
  const empty = el('div', 'empty-state');
  empty.append(el('p', '', `Failed to load: ${message}`));
  resultsEl.replaceChildren(empty);
}

async function loadMetadata() {
  // Networks: build chainId → {name, shortName, blockExplorer}.
  const networks = await window.freedomAPI.getNetworkConfig();
  if (networks?.success && networks.networks) {
    for (const [id, chain] of Object.entries(networks.networks)) {
      chainsById.set(Number(id), chain);
    }
    for (const [id, chain] of chainsById) {
      const option = el('option', '', chain.name || `chain ${id}`);
      option.value = String(id);
      chainSelect.append(option);
    }
  }

  // Tokens across every known chain. One IPC per chainId today;
  // GH issue noted for a future tokens:get-all consolidation once
  // we have enough chains for the fan-out to matter.
  const chainIds = Array.from(chainsById.keys());
  const results = await Promise.all(
    chainIds.map((id) => window.freedomAPI.getTokens(id).catch(() => null))
  );
  results.forEach((r) => {
    if (!r?.success || !r.tokens) return;
    for (const [key, token] of Object.entries(r.tokens)) {
      tokensByKey.set(key, token);
    }
  });
}

async function loadPayments() {
  const kind = kindSelect.value || undefined;
  const chainId = chainSelect.value ? Number(chainSelect.value) : undefined;
  const result = await window.freedomAPI.getPayments({ kind, chainId, limit: PAGE_LIMIT });
  if (!result?.success) {
    showLoadError(result?.error || 'unknown error');
    return;
  }
  payments = result.payments || [];
  render();
}

// Wire up controls. Search filters in-memory; kind + chain go
// server-side so >PAGE_LIMIT histories filter correctly.
searchInput.addEventListener('input', render);
kindSelect.addEventListener('change', loadPayments);
chainSelect.addEventListener('change', loadPayments);
clearBtn.addEventListener('click', async () => {
  if (!confirm('Clear all payment history? This cannot be undone.')) return;
  const result = await window.freedomAPI.clearPayments();
  if (result?.success) {
    payments = [];
    render();
  } else {
    console.error('[payments] clear failed:', result?.error);
  }
});

// Initial load. Metadata and payments are independent — fire both
// concurrently and re-render once metadata lands so the first paint
// shows the table immediately (with raw chain ids / unknown asset
// symbols), upgraded in place when chain + token lookups resolve.
Promise.all([
  loadMetadata()
    .then(render)
    .catch((err) => console.error('[payments] metadata failed:', err)),
  loadPayments().catch((err) => {
    console.error('[payments] load failed:', err);
    showLoadError(err.message);
  }),
]);

// Live refresh on every row mutation. Main broadcasts this after
// append / pending→confirmed / pending→failed / clear / removeById
// and after x402 settlement receipts land. Trailing-edge debounce
// coalesces bursts (concurrent Range segments, repollPending
// resolving N pending rows on boot) into a single re-query.
let refreshTimer = null;
window.freedomAPI.onPaymentRecorded?.(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadPayments().catch((err) => console.error('[payments] live refresh failed:', err));
  }, 150);
});
