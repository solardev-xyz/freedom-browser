// Hamburger-menu update item and the dot on the hamburger button (#87).
//
// Both render from the main process's update state (src/main/update-state.js,
// broadcast on `update:state`, read once through `getUpdateState()` for the
// first paint). Settings → About Freedom → Updates renders the same snapshot; the long-form
// status sentence (`state.message`) is main's copy and goes in the row's
// tooltip here, the row itself only has room for a short label.

const CHECK_LABEL = 'Check for Updates…';

/**
 * What the menu row shows for one snapshot.
 * `action`: 'check' (ask main to check), 'install' (restart to update),
 * 'settings' (open Settings → About Freedom → Updates, which says why updates are off), or
 * null for a row that is disabled while something is in flight.
 */
export function describeUpdateMenuItem(state) {
  const status = state?.status || 'unsupported';
  const base = { status, title: state?.message || '', percent: null, badge: false };
  switch (status) {
    case 'checking':
      return { ...base, label: 'Checking for Updates…', detail: '', action: null };
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Number(state.percent) || 0));
      return {
        ...base,
        label: 'Downloading Update…',
        detail: `${Math.floor(percent)}%`,
        percent,
        action: null,
      };
    }
    case 'ready':
      return {
        ...base,
        label: state.menuInstallLabel || 'Restart to Update',
        detail: state.version ? `v${state.version}` : '',
        action: 'install',
        badge: true,
      };
    case 'up-to-date':
      return { ...base, label: CHECK_LABEL, detail: 'Up to date', action: 'check' };
    case 'error':
      return { ...base, label: CHECK_LABEL, detail: 'Failed', action: 'check' };
    case 'idle':
      return { ...base, label: CHECK_LABEL, detail: '', action: 'check' };
    case 'unsupported':
    default:
      return { ...base, label: CHECK_LABEL, detail: 'Unavailable', action: 'settings' };
  }
}

export function renderUpdateMenuItem(els, state) {
  const view = describeUpdateMenuItem(state);
  const { button, label, detail, progress, progressBar, badge, menuButton } = els;
  button.dataset.updateStatus = view.status;
  button.dataset.updateAction = view.action || '';
  button.disabled = view.action === null;
  button.title = view.title;
  label.textContent = view.label;
  detail.textContent = view.detail;
  detail.hidden = !view.detail;
  progress.hidden = view.percent === null;
  if (view.percent !== null) progressBar.style.width = `${view.percent}%`;
  badge.hidden = !view.badge;
  menuButton?.setAttribute('aria-label', view.badge ? 'Menu (update ready)' : 'Menu');
  return view;
}

export function initUpdateStatusUi({ electronAPI = window.electronAPI, closeMenus, openSettings }) {
  const els = {
    button: document.getElementById('check-updates-btn'),
    label: document.getElementById('update-menu-label'),
    detail: document.getElementById('update-menu-status'),
    progress: document.getElementById('update-menu-progress'),
    progressBar: document.getElementById('update-menu-progress-bar'),
    badge: document.getElementById('menu-update-badge'),
    menuButton: document.getElementById('menu-button'),
  };
  if (!els.button || !els.label || !els.detail || !els.progress || !els.badge) return null;

  let latest = null;
  const paint = (state) => {
    if (!state) return;
    latest = state;
    renderUpdateMenuItem(els, state);
  };

  els.button.addEventListener('click', () => {
    const action = describeUpdateMenuItem(latest).action;
    if (!action) return;
    closeMenus?.();
    if (action === 'install') electronAPI?.restartAndInstallUpdate?.();
    else if (action === 'settings') openSettings?.();
    else electronAPI?.checkForUpdates?.();
  });

  electronAPI?.onUpdateState?.(paint);
  Promise.resolve(electronAPI?.getUpdateState?.())
    .then((state) => {
      // A broadcast that landed while this was in flight is newer.
      if (!latest) paint(state);
    })
    .catch(() => {
      // Keep the static "Check for Updates…" row; a later broadcast repaints.
    });

  return { paint };
}
