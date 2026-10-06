// Settings → About Freedom → Updates (#87): current version, live update status with
// download progress, last check, "Check now" and "Restart to update".
//
// Everything shown comes from one snapshot the main process builds
// (src/main/update-state.js via updater.js): `getUpdateState()` paints the
// page once, `onUpdateState` repaints on every change. The status sentence
// (`state.message`) is main's copy, shared with the hamburger menu item, so
// the two surfaces can't word the same state differently.
//
// Classic page script, loaded after settings.js. The render helpers are also
// exported for Jest (settings-updates.test.js); in the page `module` is
// undefined and only the IIFE at the bottom runs.

function formatUpdateBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// "12 MB of 98 MB · 2.1 MB/s" — whatever parts electron-updater reported.
function describeDownloadDetail(state) {
  const parts = [];
  const done = formatUpdateBytes(state.transferred);
  const total = formatUpdateBytes(state.total);
  if (done && total) parts.push(`${done} of ${total}`);
  const speed = formatUpdateBytes(state.bytesPerSecond);
  if (speed && state.bytesPerSecond > 0) parts.push(`${speed}/s`);
  return parts.join(' · ');
}

// Relative for the first hour ("just now", "5 minutes ago"), a date after
// that. The page repaints this line every 30s (see LAST_CHECKED_REFRESH_MS).
function describeLastChecked(lastChecked, now = Date.now()) {
  if (!Number.isFinite(lastChecked)) return 'Not checked yet this session.';
  const minutes = Math.floor(Math.max(0, now - lastChecked) / 60_000);
  if (minutes < 1) return 'Last checked just now.';
  if (minutes < 60) return `Last checked ${minutes} minute${minutes === 1 ? '' : 's'} ago.`;
  const when = new Date(lastChecked).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `Last checked ${when}.`;
}

const LAST_CHECKED_REFRESH_MS = 30_000;

// Pure view model for one snapshot: what each element of the section shows.
function updateSectionView(state, now = Date.now()) {
  const status = state?.status || 'unsupported';
  const downloading = status === 'downloading';
  const ready = status === 'ready';
  const percent = downloading ? Math.max(0, Math.min(100, Number(state.percent) || 0)) : null;
  const detail = downloading ? describeDownloadDetail(state) : '';
  let message = state?.message || '';
  if (ready && state.installNote) message = `${message} ${state.installNote}`;
  return {
    status,
    version: state?.currentVersion ? `Freedom ${state.currentVersion}` : 'Freedom',
    message,
    detail,
    percent,
    // Nothing was ever checked when this copy can't update; "Not checked
    // yet" would only suggest it might be.
    lastChecked: status === 'unsupported' ? '' : describeLastChecked(state?.lastChecked, now),
    showCheck: !ready,
    checkEnabled: Boolean(state?.canCheck),
    checkLabel: status === 'checking' ? 'Checking…' : 'Check now',
    showRestart: ready,
    restartLabel: state?.installLabel || 'Restart to update',
  };
}

function renderUpdateSection(els, state, now = Date.now()) {
  const view = updateSectionView(state, now);
  els.row.dataset.updateStatus = view.status;
  els.version.textContent = view.version;
  els.message.textContent = view.message;
  els.detail.textContent = view.detail;
  els.detail.hidden = !view.detail;
  els.progress.hidden = view.percent === null;
  if (view.percent !== null) {
    els.progress.setAttribute('aria-valuenow', String(Math.floor(view.percent)));
    els.progressBar.style.width = `${view.percent}%`;
  }
  els.lastChecked.textContent = view.lastChecked;
  els.lastChecked.hidden = !view.lastChecked;
  els.check.hidden = !view.showCheck;
  els.check.disabled = !view.checkEnabled;
  els.check.textContent = view.checkLabel;
  els.restart.hidden = !view.showRestart;
  els.restart.textContent = view.restartLabel;
  els.restart.disabled = false;
  return view;
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    formatUpdateBytes,
    describeDownloadDetail,
    describeLastChecked,
    updateSectionView,
    renderUpdateSection,
  };
} else {
  (() => {
    const byId = (id) => document.getElementById(id);
    const els = {
      row: byId('update-status-row'),
      version: byId('update-current-version'),
      message: byId('update-status-message'),
      detail: byId('update-status-detail'),
      progress: byId('update-progress'),
      progressBar: byId('update-progress-bar'),
      lastChecked: byId('update-last-checked'),
      check: byId('update-check-now'),
      restart: byId('update-restart'),
    };
    if (Object.values(els).some((el) => !el)) return;

    let latest = null;
    const paint = (state) => {
      if (!state) return;
      latest = state;
      renderUpdateSection(els, state);
    };

    // No optimistic "Checking…": main moves to `checking` synchronously when
    // it actually starts a check and the broadcast repaints this, while a
    // request main declines (one already running) leaves the state as is.
    els.check.addEventListener('click', () => {
      Promise.resolve(freedomAPI.checkForUpdates()).catch((err) =>
        console.error('[settings] update check failed:', err)
      );
    });

    els.restart.addEventListener('click', () => {
      els.restart.disabled = true;
      Promise.resolve(freedomAPI.restartToUpdate()).catch((err) => {
        console.error('[settings] restart to update failed:', err);
        if (latest) paint(latest);
      });
    });

    // Keep "5 minutes ago" true while the page stays open.
    setInterval(() => {
      if (latest && !document.hidden) paint(latest);
    }, LAST_CHECKED_REFRESH_MS);

    freedomAPI.onUpdateState?.(paint);
    freedomAPI
      .getUpdateState()
      .then((state) => {
        // A broadcast that landed while this was in flight is newer.
        if (!latest) paint(state);
      })
      .catch((err) => {
        console.error('[settings] could not read update state:', err);
        els.message.textContent = 'Update status is unavailable.';
        els.check.disabled = true;
      });
  })();
}
