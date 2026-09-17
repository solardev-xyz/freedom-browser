import { boundPopoverToViewport } from './popover-bounds.js';

import { createWorkspaceViewers } from './workspace-viewers.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, className = 'agent-workspace-item') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function createWorkspaceInspector(hosts, viewerOptions = {}, { compactHost = null, refreshControl = null } = {}) {
  let conversationId = null;
  let generation = 0;
  let refreshTimer = null;
  let loading = false;
  let refreshQueued = false;
  let changes = null;
  let history = null;
  let historyLoadFailed = false;
  let error = '';
  let popup = null;
  let anchorHost = null;
  let anchorKey = null;
  let popupSequence = 0;
  const viewers = createWorkspaceViewers(viewerOptions);
  function configureRefresh(control) {
    control.setAttribute('aria-label', 'Refresh workspace');
    control.title = 'Refresh workspace';
    control.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
    control.addEventListener('click', () => { if (!control.disabled) void refresh(); });
  }
  if (refreshControl) configureRefresh(refreshControl);


  const findAnchor = () => [...(anchorHost?.querySelectorAll('[data-workspace-focus]') || [])]
    .find((node) => node.dataset.workspaceFocus === anchorKey);
  function closePopup(focus = true) {
    popupSequence += 1;
    popup?.remove();
    popup = null;
    if (focus) findAnchor()?.focus();
  }
  function positionPopup() {
    if (!popup) return;
    const anchor = findAnchor();
    if (!anchor || (anchor.getClientRects && !anchor.getClientRects().length)) { closePopup(false); return; }
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const height = Math.min(440, window.innerHeight - 24);
    const beside = rect.left >= width + 20;
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.left = `${Math.max(12, Math.min(beside ? rect.left - width - 8 : rect.left, window.innerWidth - width - 12))}px`;
    popup.style.top = `${Math.max(12, Math.min(beside ? rect.top : rect.bottom + 6, window.innerHeight - popup.offsetHeight - 12))}px`;
    boundPopoverToViewport(popup);
  }
  document.addEventListener('click', (event) => {
    if (!popup) return;
    const path = event.composedPath?.() || [];
    if (!path.includes(popup) && !popup.contains(event.target) && !path.includes(findAnchor()) && !findAnchor()?.contains(event.target)) closePopup(false);
  });
  document.addEventListener('keydown', (event) => {
    if (popup && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePopup();
    }
  }, true);
  window.addEventListener('resize', positionPopup);

  function popover(title, anchor = null, back = null) {
    if (anchor) {
      anchorHost = hosts.find((host) => host?.contains(anchor));
      anchorKey = anchor.dataset.workspaceFocus;
    }
    closePopup(false);
    const sequence = popupSequence;
    const version = generation;
    popup = element('section', 'agent-workspace-popover chrome-popover');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', title);
    const header = element('header', 'agent-workspace-popover-heading');
    if (back) header.appendChild(button('‹ Back', back, 'agent-text-button'));
    header.appendChild(element('strong', '', title));
    header.appendChild(button('Close', () => closePopup(), 'agent-text-button'));
    const note = element('p', 'agent-workspace-note', '');
    note.hidden = true;
    const body = element('div', 'agent-workspace-popover-body');
    popup.appendChild(header); popup.appendChild(note); popup.appendChild(body);
    popup.addEventListener('click', (event) => event.stopPropagation());
    document.body.appendChild(popup);
    const finish = () => {
      positionPopup();
      popup?.querySelector('button, input')?.focus();
    };
    const fail = (message) => { note.hidden = false; note.textContent = message; positionPopup(); };
    return { body, finish, fail, valid: () => Boolean(popup) && sequence === popupSequence && version === generation };
  }

  async function historyRequest(action, options = {}) {
    const expected = conversationId;
    const version = generation;
    const response = await window.electronAPI.agentWorkspaceHistory(expected, action, options);
    if (version !== generation || expected !== conversationId) return null;
    if (!response?.ok || response.conversationId !== expected) throw new Error(response?.error?.message || 'Checkpoints are unavailable.');
    return response.result;
  }

  function openViewer(version = null) {
    closePopup(false);
    try { viewers.open(conversationId, version, () => void refresh()); }
    catch (cause) { error = cause.message; render(); }
  }

  function showCheckpoints(anchor = null) {
    const ui = popover('Checkpoints', anchor);
    if (historyLoadFailed) ui.fail('Checkpoints could not be refreshed. Try again.');
    else if (!history) ui.fail('Loading checkpoints…');
    else if (history.notice) ui.fail(history.notice);
    else if (!history.versions.length) ui.fail('No checkpoints yet');
    for (const version of history?.versions || []) {
      const row = button('', () => openViewer(version), 'agent-workspace-item agent-workspace-checkpoint');
      row.appendChild(element('span', 'agent-workspace-file-name', version.label));
      const minutes = Math.max(0, Math.floor((Date.now() - version.createdAt) / 60000));
      const time = element('time', 'agent-workspace-time', minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`);
      row.title = `${version.label} · ${new Date(version.createdAt).toLocaleString()}`;
      row.appendChild(time);
      ui.body.appendChild(row);
    }
    if (history?.limitReached) ui.fail('Showing the latest 100 checkpoints.');
    const actions = element('div', 'agent-workspace-checkpoint-actions');
    actions.appendChild(button('Checkpoint settings', showSettings));
    ui.body.appendChild(actions);
    ui.finish();
  }

  function showSettings() {
    const ui = popover('Checkpoint settings', null, () => showCheckpoints());
    ui.fail('Only Agent-reviewed revisions are saved. Limits: 200 files, 64 KiB per file, 512 KiB total.');
    const form = element('form', 'agent-workspace-version-save');
    const path = element('input', ''); path.placeholder = 'Project-relative file path'; path.maxLength = 1024; path.setAttribute('aria-label', 'Excluded file path');
    const reason = element('input', ''); reason.placeholder = 'Reason (without private details)'; reason.maxLength = 160; reason.setAttribute('aria-label', 'Exclusion reason');
    const exclude = button('Exclude file', () => void change('exclude', { path: path.value, reason: reason.value }, exclude), 'agent-text-button');
    async function change(action, options, control) {
      if (!ui.valid() || control.disabled) return;
      control.disabled = true;
      try {
        await historyRequest(action, options);
        if (!ui.valid()) return;
        await refresh();
        if (ui.valid()) showSettings();
      } catch (cause) { if (ui.valid()) { ui.fail(cause.message); control.disabled = false; } }
    }
    form.addEventListener('submit', (event) => { event.preventDefault(); exclude.click(); });
    form.appendChild(path); form.appendChild(reason); form.appendChild(exclude); ui.body.appendChild(form);
    ui.body.appendChild(element('p', 'agent-workspace-note', 'Exclusions do not erase copies in earlier checkpoints.'));
    for (const entry of history?.exclusions || []) {
      const row = element('div', 'agent-workspace-version');
      row.appendChild(element('p', 'agent-workspace-note', `${entry.path} · ${entry.reason}`));
      const allow = button('Allow review', () => void change('include', { path: entry.path, reason: 'User removed the additional exclusion in Checkpoint settings' }, allow), 'agent-text-button');
      row.appendChild(allow); ui.body.appendChild(row);
    }
    ui.finish();
  }

  function render() {
    if (refreshControl) {
      refreshControl.hidden = !conversationId;
      refreshControl.disabled = loading || !conversationId;
    }
    for (const host of hosts) {
      if (!host) continue;
      const activeKey = host.contains(document.activeElement) ? document.activeElement?.dataset?.workspaceFocus : null;
      host.hidden = !conversationId;
      host.replaceChildren();
      if (!conversationId) continue;
      if (host !== compactHost) {
        const heading = element('div', 'agent-workspace-inspector-heading');
        heading.appendChild(element('strong', '', 'Workspace'));
        const refreshButton = element('button', 'agent-workspace-refresh');
        refreshButton.type = 'button';
        refreshButton.dataset.workspaceFocus = 'refresh';
        refreshButton.disabled = loading;
        configureRefresh(refreshButton);
        heading.appendChild(refreshButton); host.appendChild(heading);
      }
      const body = element('div', 'agent-workspace-overview');
      const summary = (label, count, key, onClick) => {
        const row = button('', () => onClick(row), 'agent-workspace-item agent-workspace-summary');
        row.dataset.workspaceFocus = key;
        row.setAttribute('aria-label', `${label} · ${count}`);
        row.appendChild(element('span', 'agent-workspace-file-name', label));
        row.appendChild(element('span', 'agent-workspace-time', count));
        const chevron = element('span', 'agent-workspace-chevron', '›'); chevron.setAttribute('aria-hidden', 'true'); row.appendChild(chevron);
        body.appendChild(row);
      };
      const count = changes?.changes?.length || 0;
      summary('Changes', changes?.available ? `${count}${changes.limitReached ? '+' : ''} ${count === 1 ? 'file' : 'files'}` : loading ? 'Loading…' : 'Unavailable', 'changes', () => openViewer());
      summary('Checkpoints', history ? `${history.versions.length}${history.limitReached ? '+' : ''}` : loading ? 'Loading…' : 'Unavailable', 'checkpoints', showCheckpoints);
      if (error) body.appendChild(element('p', 'agent-workspace-note', error));
      host.appendChild(body);
      if (activeKey) [...host.querySelectorAll('[data-workspace-focus]')].find((node) => node.dataset.workspaceFocus === activeKey)?.focus();
    }
    positionPopup();
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    if (!conversationId) return;
    if (loading) { refreshQueued = true; return; }
    const version = generation;
    const expected = conversationId;
    loading = true; error = ''; refreshQueued = false; render();
    try {
      const [git, saved] = await Promise.allSettled([
        window.electronAPI.inspectAgentWorkspace(expected, 'changes', '.', false), historyRequest('list'),
      ]);
      if (version !== generation) return;
      changes = git.status === 'fulfilled' && git.value?.ok && git.value.conversationId === expected
        ? git.value.result : { available: false };
      history = saved.status === 'fulfilled' && saved.value ? saved.value : null;
      historyLoadFailed = !history;
    } finally {
      if (version === generation) { loading = false; render(); if (refreshQueued) void refresh(); }
    }
  }

  return {
    dismissPopover: () => closePopup(false),
    setWorkspace(next) {
      if (next !== conversationId) {
        generation += 1;
        closePopup(false);
        conversationId = next;
        viewers.setConversation(next);
        changes = null; history = null; historyLoadFailed = false; error = ''; loading = false; refreshQueued = false;
        render();
      }
      clearTimeout(refreshTimer);
      if (conversationId) refreshTimer = setTimeout(() => void refresh(), 250);
    },
  };
}
