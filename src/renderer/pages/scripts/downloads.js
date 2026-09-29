// freedomAPI is exposed globally by webview-preload.js via contextBridge

const container = document.getElementById('downloads-container');
const searchInput = document.getElementById('search-input');
const clearBtn = document.getElementById('clear-btn');
const statsEl = document.getElementById('stats');

let allDownloads = [];

// Build an element with an optional class list and text. Text always goes in
// through textContent: filenames and URLs are remote-controlled, so nothing
// site-derived is ever parsed as HTML on this page (#432).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Static glyphs (no interpolation) for the row icon and the remove button.
const FILE_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
const CLOSE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex++;
  }
  return `${scaled.toFixed(1)} ${units[unitIndex]}`;
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

// Transient per-row action failures (e.g. Open on a since-deleted
// file). Rendered into the row's status line — a direct DOM poke would
// be wiped by the next downloads:changed re-render, so the error lives
// here and expires after a few seconds.
const actionErrors = new Map();
const ACTION_ERROR_MS = 5000;
function showActionError(id, message) {
  actionErrors.set(id, message);
  applyFilter();
  setTimeout(() => {
    if (actionErrors.get(id) === message) {
      actionErrors.delete(id);
      applyFilter();
    }
  }, ACTION_ERROR_MS);
}

function statusText(entry) {
  const received = formatBytes(entry.received_bytes || 0);
  const total = entry.total_bytes > 0 ? formatBytes(entry.total_bytes) : null;
  switch (entry.state) {
    case 'completed':
      return formatBytes(entry.received_bytes || entry.total_bytes || 0);
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Failed — download interrupted';
    default:
      // A live item can be stalled two ways: paused by the user, or
      // interrupted mid-transfer (connection dropped) but not yet given
      // up on by Chromium.
      if (entry.is_interrupted) {
        return total ? `Interrupted — ${received} of ${total}` : `Interrupted — ${received}`;
      }
      if (entry.is_paused) {
        return total ? `Paused — ${received} of ${total}` : `Paused — ${received}`;
      }
      return total ? `${received} of ${total}` : received;
  }
}

function actionButton(action, id, label, extraClass) {
  const btn = el('button', extraClass ? `action-btn ${extraClass}` : 'action-btn', label);
  btn.dataset.action = action;
  btn.dataset.id = String(id);
  return btn;
}

function renderActions(entry) {
  if (entry.state === 'in_progress') {
    // Pause only makes sense while bytes are moving; a paused or
    // interrupted item offers Resume when Chromium says it can.
    const stalled = entry.is_paused || entry.is_interrupted;
    const buttons = [];
    if (!stalled) buttons.push(actionButton('pause', entry.id, 'Pause'));
    else if (entry.can_resume) buttons.push(actionButton('resume', entry.id, 'Resume'));
    buttons.push(actionButton('cancel', entry.id, 'Cancel', 'danger'));
    return buttons;
  }
  if (entry.state === 'completed') {
    return [
      actionButton('open', entry.id, 'Open'),
      actionButton('show', entry.id, 'Show in folder'),
    ];
  }
  return [];
}

// Built with DOM APIs, not an HTML string: the filename and URL come from
// the downloading site (#432).
function renderEntry(entry) {
  const inProgress = entry.state === 'in_progress';
  const percent =
    entry.total_bytes > 0
      ? Math.min(100, Math.round((entry.received_bytes / entry.total_bytes) * 100))
      : null;
  const actionError = actionErrors.get(entry.id);
  const failed =
    Boolean(actionError) || entry.state === 'interrupted' || (inProgress && entry.is_interrupted);

  const item = el('div', 'download-item');
  if (/^[\w-]+$/.test(entry.state || '')) item.classList.add(`state-${entry.state}`);
  item.dataset.id = String(entry.id);

  const icon = el('div', 'file-icon');
  icon.innerHTML = FILE_ICON;

  const content = el('div', 'download-content');
  const name = el('div', 'download-name', entry.filename || '');
  if (entry.is_private) {
    const badge = el('span', 'private-badge', 'Private');
    badge.dataset.test = 'download-private-badge';
    name.append(badge);
  }
  content.append(
    name,
    el('div', 'download-url', entry.url || ''),
    el(
      'div',
      failed ? 'download-status error' : 'download-status',
      actionError || statusText(entry)
    )
  );
  if (inProgress && percent !== null) {
    const bar = el('div', 'progress-bar');
    const fill = el('div', 'progress-fill');
    fill.style.width = `${percent}%`;
    bar.append(fill);
    content.append(bar);
  }

  const actions = el('div', 'download-actions');
  actions.append(...renderActions(entry));

  item.append(
    icon,
    content,
    el('div', 'download-meta', formatTime(entry.end_time || entry.start_time)),
    actions
  );

  if (!inProgress) {
    const removeBtn = el('button', 'remove-btn');
    removeBtn.dataset.action = 'remove';
    removeBtn.dataset.id = String(entry.id);
    removeBtn.title = 'Remove from list';
    removeBtn.innerHTML = CLOSE_ICON;
    item.append(removeBtn);
  }
  return item;
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

function updateStats(shown) {
  const active = allDownloads.filter((entry) => entry.state === 'in_progress').length;
  const label = formatCount(shown, allDownloads.length, 'download');
  statsEl.textContent = active ? `${label} — ${active} in progress` : label;
}

function renderDownloads(entries) {
  updateStats(entries?.length || 0);
  if (!entries || entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <p>No downloads yet</p>
      </div>
    `;
    return;
  }

  const list = el('div', 'download-list');
  list.append(...entries.map(renderEntry));
  container.replaceChildren(list);
}

// Single delegated handler survives re-renders (live progress
// re-renders the list on every downloads:changed broadcast).
container.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  if (!id) return;

  switch (btn.dataset.action) {
    case 'pause':
      await freedomAPI.pauseDownload?.(id);
      break;
    case 'resume':
      await freedomAPI.resumeDownload?.(id);
      break;
    case 'cancel':
      await freedomAPI.cancelDownload?.(id);
      break;
    case 'open': {
      const res = await freedomAPI.openDownloadedFile?.(id);
      if (res && res.success === false) {
        showActionError(id, res.error || 'Could not open file');
        return;
      }
      break;
    }
    case 'show': {
      const res = await freedomAPI.showDownloadInFolder?.(id);
      if (res && res.success === false) {
        showActionError(id, res.error || 'Could not show file in folder');
        return;
      }
      break;
    }
    case 'remove':
      await freedomAPI.removeDownload?.(id);
      break;
  }
  loadDownloads();
});

function applyFilter() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    renderDownloads(allDownloads);
    return;
  }
  const filtered = allDownloads.filter(
    (entry) =>
      (entry.filename && entry.filename.toLowerCase().includes(q)) ||
      (entry.url && entry.url.toLowerCase().includes(q))
  );
  renderDownloads(filtered);
}

async function loadDownloads() {
  try {
    if (!freedomAPI?.getDownloads) {
      container.innerHTML = '<div class="empty-state"><p>Downloads API not available</p></div>';
      return;
    }

    allDownloads = await freedomAPI.getDownloads();
    applyFilter();
  } catch (err) {
    console.error('Failed to load downloads:', err);
    container.innerHTML = '<div class="empty-state"><p>Failed to load downloads</p></div>';
  }
}

async function clearAllDownloads() {
  if (!confirm('Clear all downloads from the list? Downloaded files are kept.')) return;
  try {
    if (freedomAPI?.clearDownloads) {
      await freedomAPI.clearDownloads();
      loadDownloads();
    }
  } catch (err) {
    console.error('Failed to clear downloads:', err);
  }
}

searchInput.addEventListener('input', applyFilter);
clearBtn.addEventListener('click', clearAllDownloads);

// Live refresh — main broadcasts on every row mutation, so in-flight
// items progress in place. Auto-unsubscribed on pagehide by preload.
freedomAPI.onDownloadsChanged?.(() => loadDownloads());

// Initial load
loadDownloads();
