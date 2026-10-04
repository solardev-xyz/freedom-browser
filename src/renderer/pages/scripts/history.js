// freedomAPI is exposed globally by webview-preload.js via contextBridge

const container = document.getElementById('history-container');
const searchInput = document.getElementById('search-input');
const clearBtn = document.getElementById('clear-btn');
const sortSelect = document.getElementById('sort-select');
const statsEl = document.getElementById('stats');

// The list is loaded a page at a time (#503): before, this page pulled the
// whole history table over IPC on every load, search keystroke aside. Search,
// sort and paging run in main's history search worker (`history:page`).
const PAGE_SIZE = 200;
// What's loaded so far for the current search + sort, in display order.
let loadedEntries = [];
// Rows the current search matches (every row with no search), and all rows.
let matchedCount = 0;
let totalCount = 0;
// Bumped by every new load, so a slower, older response never paints.
let loadGeneration = 0;
let searchTimer = null;
let currentSort = localStorage.getItem('history-sort') || 'recent';

// Initialize sort dropdown
sortSelect.value = currentSort;

// Format relative timestamp (e.g., "5 minutes ago", "2 hours ago")
function formatRelativeTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  // Less than 1 minute
  if (diffSec < 60) {
    return 'Just now';
  }

  // Less than 1 hour
  if (diffMin < 60) {
    return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  }

  // Less than 24 hours
  if (diffHour < 24) {
    return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  // Within this year
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // Older
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

// Get date group key for an entry
function getDateGroup(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);

  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  if (date >= weekAgo) return 'Last 7 Days';
  if (date >= monthAgo) return 'Last 30 Days';

  // Return month and year for older entries
  return date.toLocaleDateString([], { year: 'numeric', month: 'long' });
}

// Group entries by date
function groupByDate(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = getDateGroup(entry.timestamp);
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group).push(entry);
  }
  return groups;
}

// Check if protocol needs a badge when favicon is present
function needsProtocolBadge(protocol) {
  return protocol && !['http', 'https', 'unknown'].includes(protocol);
}

// Close glyph for the per-row remove button. Static markup only — nothing
// site-controlled is ever parsed as HTML on this page (#432).
const CLOSE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

// Build an element with an optional class list and text. Text always goes in
// through textContent: titles and URLs are site-controlled.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The protocol doubles as a class name (per-protocol colours).
const SAFE_CLASS = /^[\w-]+$/;

// Render a single history entry. Built with DOM APIs, not an HTML string:
// the title and URL come from the visited site (#432).
function renderEntry(entry) {
  const protocol = entry.protocol || 'unknown';
  const protocolLabel = protocol.slice(0, 3).toUpperCase();

  const item = el('div', 'history-item');
  item.dataset.url = entry.url || '';
  item.dataset.id = String(entry.id);
  item.dataset.protocol = protocol;

  const faviconContainer = el('div', 'favicon-container');
  faviconContainer.dataset.faviconUrl = entry.url || '';
  const protocolIcon = el('div', 'protocol-icon-full', protocolLabel);
  if (SAFE_CLASS.test(protocol)) protocolIcon.classList.add(protocol);
  const protocolBadge = el('span', 'protocol-badge', protocolLabel);
  if (SAFE_CLASS.test(protocol)) protocolBadge.classList.add(protocol);
  faviconContainer.append(protocolIcon, protocolBadge);

  const content = el('div', 'history-content');
  content.append(
    el('div', 'history-title', entry.title || entry.url || ''),
    el('div', 'history-url', entry.url || '')
  );

  const meta = el('div', 'history-meta');
  meta.append(
    el('span', 'history-visits', `${entry.visit_count} visit${entry.visit_count !== 1 ? 's' : ''}`),
    el('span', 'history-time', formatRelativeTime(entry.timestamp))
  );

  const deleteBtn = el('button', 'delete-btn');
  deleteBtn.dataset.id = String(entry.id);
  deleteBtn.title = 'Remove from history';
  deleteBtn.innerHTML = CLOSE_ICON;

  item.append(faviconContainer, content, meta, deleteBtn);
  return item;
}

// A `.history-list` holding one rendered row per entry.
function renderList(entries) {
  const list = el('div', 'history-list');
  list.append(...entries.map(renderEntry));
  return list;
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

// "Show more" under the list while the search has rows not loaded yet.
function renderShowMore() {
  const remaining = matchedCount - loadedEntries.length;
  if (remaining <= 0) return null;
  const wrap = el('div', 'show-more');
  const btn = el('button', 'btn', `Show more (${remaining.toLocaleString()} remaining)`);
  btn.id = 'show-more-btn';
  btn.type = 'button';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    loadHistory({ append: true });
  });
  wrap.append(btn);
  return wrap;
}

// Render history list with date grouping. `entries` arrive sorted by main.
function renderHistory(entries) {
  statsEl.textContent = formatCount(matchedCount, totalCount, 'page');
  if (!entries || entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <p>No history yet</p>
      </div>
    `;
    return;
  }

  // For "Most Recent" sort, group by date; otherwise show flat list
  if (currentSort === 'recent') {
    const groups = groupByDate(entries);
    const fragment = document.createDocumentFragment();
    for (const [groupName, groupEntries] of groups) {
      const group = el('div', 'date-group');
      group.append(el('div', 'date-header', groupName), renderList(groupEntries));
      fragment.append(group);
    }
    container.replaceChildren(fragment);
  } else {
    // Flat list for other sort options
    container.replaceChildren(renderList(entries));
  }
  const showMore = renderShowMore();
  if (showMore) container.append(showMore);

  // Attach click handlers
  container.querySelectorAll('.history-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.delete-btn')) return;
      const url = item.dataset.url;
      if (url) {
        // Open in new tab
        freedomAPI.openInNewTab(url);
      }
    });
  });

  container.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      if (id && freedomAPI?.removeHistory) {
        const removed = await freedomAPI.removeHistory(id);
        // Drop the row in place rather than reloading every page shown.
        const before = loadedEntries.length;
        loadedEntries = loadedEntries.filter((entry) => entry.id !== id);
        if (removed && loadedEntries.length < before) {
          matchedCount = Math.max(0, matchedCount - 1);
          totalCount = Math.max(0, totalCount - 1);
        }
        renderHistory(loadedEntries);
      }
    });
  });

  // Load favicons for visible entries
  loadFavicons();
}

// Load favicons asynchronously
async function loadFavicons() {
  if (!freedomAPI?.getCachedFavicon) return;

  const containers = container.querySelectorAll('.favicon-container');
  for (const faviconContainer of containers) {
    const url = faviconContainer.dataset.faviconUrl;
    if (!url) continue;

    try {
      const favicon = await freedomAPI.getCachedFavicon(url);
      if (favicon) {
        const protocolIcon = faviconContainer.querySelector('.protocol-icon-full');
        const protocolBadge = faviconContainer.querySelector('.protocol-badge');
        const historyItem = faviconContainer.closest('.history-item');
        const protocol = historyItem?.dataset.protocol;

        if (protocolIcon) {
          // Replace protocol icon with favicon
          const img = document.createElement('img');
          img.className = 'favicon';
          img.src = favicon;
          img.alt = '';
          img.onerror = () => {
            // Put back the protocol icon on error
            img.replaceWith(protocolIcon);
            if (protocolBadge) protocolBadge.classList.remove('show');
          };
          protocolIcon.replaceWith(img);

          // Show protocol badge only for non-HTTP protocols
          if (protocolBadge && needsProtocolBadge(protocol)) {
            protocolBadge.classList.add('show');
          }
        }
      }
    } catch {
      // Keep protocol icon on error
    }
  }
}

// Load the first page for the current search + sort, or with `append` the
// next page after what's shown.
async function loadHistory({ append = false } = {}) {
  const generation = ++loadGeneration;
  try {
    if (!freedomAPI?.getHistoryPage) {
      container.innerHTML = '<div class="empty-state"><p>History API not available</p></div>';
      return;
    }

    const page = await freedomAPI.getHistoryPage({
      query: searchInput.value,
      sort: currentSort,
      offset: append ? loadedEntries.length : 0,
      limit: PAGE_SIZE,
    });
    if (generation !== loadGeneration) return;

    if (append) {
      // A visit recorded since the last page shifts the offsets by a row;
      // never show the same entry twice.
      const seen = new Set(loadedEntries.map((entry) => entry.id));
      loadedEntries = loadedEntries.concat(page.entries.filter((entry) => !seen.has(entry.id)));
    } else {
      loadedEntries = page.entries;
    }
    matchedCount = page.matched;
    totalCount = page.total;
    renderHistory(loadedEntries);
  } catch (err) {
    if (generation !== loadGeneration) return;
    console.error('Failed to load history:', err);
    container.innerHTML = '<div class="empty-state"><p>Failed to load history</p></div>';
  }
}

// Clear all history
async function clearAllHistory() {
  if (!confirm('Are you sure you want to clear all browsing history?')) return;

  try {
    if (freedomAPI?.clearHistory) {
      await freedomAPI.clearHistory();
      loadHistory();
    }
  } catch (err) {
    console.error('Failed to clear history:', err);
  }
}

// Event listeners
searchInput.addEventListener('input', () => {
  // Each search is a query in main; don't send one per keystroke.
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadHistory(), 120);
});

sortSelect.addEventListener('change', (e) => {
  currentSort = e.target.value;
  localStorage.setItem('history-sort', currentSort);
  // Reload with the current search filter
  clearTimeout(searchTimer);
  loadHistory();
});

clearBtn.addEventListener('click', clearAllHistory);

// Initial load
loadHistory();
