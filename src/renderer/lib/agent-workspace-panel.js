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

export function createWorkspaceInspector(hosts) {
  let conversationId = null;
  let generation = 0;
  let refreshSequence = 0;
  let viewerSequence = 0;
  let refreshTimer = null;
  let selectedTab = 'files';
  let showGenerated = false;
  let directories = new Map();
  let expanded = new Set();
  let changes = null;
  let loading = false;
  let refreshQueued = false;
  let error = '';
  let viewer = null;
  let returnFocus = null;

  function closeViewer() {
    viewerSequence += 1;
    if (!viewer) return;
    viewer.remove();
    viewer = null;
    returnFocus?.focus?.();
    returnFocus = null;
  }

  async function inspect(kind, path = '.') {
    const expected = conversationId;
    const version = generation;
    const response = await window.electronAPI.inspectAgentWorkspace(
      expected,
      kind,
      path,
      showGenerated
    );
    if (version !== generation || expected !== conversationId) return null;
    if (!response?.ok || response.conversationId !== expected)
      throw new Error('This workspace item could not be read.');
    return response.result;
  }

  async function openFile(path, kind) {
    closeViewer();
    const sequence = ++viewerSequence;
    const version = generation;
    returnFocus = document.activeElement;
    viewer = element('div', 'agent-workspace-viewer-backdrop');
    const dialog = element('section', 'agent-workspace-viewer');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `${kind === 'diff' ? 'Changes in' : 'File'} ${path}`);
    const heading = element('div', 'agent-workspace-viewer-heading');
    heading.appendChild(element('strong', '', path));
    const close = button('Close', closeViewer, 'agent-text-button');
    heading.appendChild(close);
    const note = element('p', 'agent-workspace-note', 'Loading…');
    const content = element('pre', 'agent-workspace-file-content');
    content.tabIndex = 0;
    dialog.appendChild(heading);
    dialog.appendChild(note);
    dialog.appendChild(content);
    viewer.appendChild(dialog);
    document.body.appendChild(viewer);
    viewer.addEventListener('click', (event) => {
      if (event.target === viewer) closeViewer();
    });
    viewer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeViewer();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        (document.activeElement === close ? content : close).focus();
      }
    });
    close.focus();
    try {
      const result = await inspect(kind, path);
      if (!result || sequence !== viewerSequence || version !== generation) return;
      note.textContent =
        result.message ||
        (result.binary
          ? 'Binary file — text preview unavailable.'
          : result.truncated
            ? 'Showing a limited preview (64 KiB maximum).'
            : kind === 'diff'
              ? 'Changes compared with the latest commit. No checkpoints are saved automatically yet.'
              : 'Read-only file preview');
      if (kind === 'diff') {
        const lines = (result.text || '').split('\n');
        if (lines.length > 2000) note.textContent = 'Showing the first 2,000 diff lines.';
        for (const line of lines.slice(0, 2000)) {
          content.appendChild(
            element(
              'span',
              line.startsWith('+')
                ? 'agent-diff-added'
                : line.startsWith('-')
                  ? 'agent-diff-deleted'
                  : line.startsWith('@@')
                    ? 'agent-diff-hunk'
                    : '',
              `${line}\n`
            )
          );
        }
      } else content.textContent = result.text || '';
    } catch {
      if (sequence === viewerSequence && version === generation)
        note.textContent = 'This workspace item could not be read. Refresh and try again.';
    }
  }

  async function toggleDirectory(path) {
    const version = generation;
    if (expanded.has(path)) {
      expanded.delete(path);
      render();
      return;
    }
    if (expanded.size >= 20) {
      error = 'Close a folder before opening another (20-folder limit).';
      render();
      return;
    }
    expanded.add(path);
    render();
    try {
      const result = await inspect('tree', path);
      if (result) directories.set(path, result);
    } catch {
      if (version !== generation) return;
      error = 'This folder could not be read. Refresh and try again.';
    }
    render();
  }

  function appendDirectory(container, directory, depth = 0) {
    const listing = directories.get(directory);
    if (!listing) {
      container.appendChild(element('p', 'agent-workspace-note', 'Loading files…'));
      return;
    }
    for (const entry of listing.entries || []) {
      const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
      const isDirectory = entry.type === 'directory';
      const row = button('', () => (isDirectory ? toggleDirectory(path) : openFile(path, 'file')));
      row.style.paddingLeft = `${10 + depth * 12}px`;
      row.title = path;
      row.disabled = entry.type === 'other';
      if (isDirectory) row.setAttribute('aria-expanded', String(expanded.has(path)));
      row.appendChild(
        element(
          'span',
          'agent-workspace-file-icon',
          isDirectory ? (expanded.has(path) ? '▾' : '▸') : '·'
        )
      );
      row.appendChild(element('span', 'agent-workspace-file-name', entry.name));
      const change = changes?.changes?.find((change) => change.path === path);
      if (change)
        row.appendChild(
          element(
            'span',
            `agent-workspace-file-status ${change.status}`,
            change.status === 'added' ? 'A' : change.status === 'deleted' ? 'D' : 'M'
          )
        );
      container.appendChild(row);
      if (isDirectory && expanded.has(path)) appendDirectory(container, path, depth + 1);
    }
    if (!listing.entries?.length)
      container.appendChild(element('p', 'agent-workspace-note', 'Empty folder'));
    if (listing.limitReached)
      container.appendChild(element('p', 'agent-workspace-note', 'Showing the first 500 entries.'));
    if (listing.hiddenCount)
      container.appendChild(
        element('p', 'agent-workspace-note', `${listing.hiddenCount} generated items hidden`)
      );
  }

  function render() {
    for (const host of hosts) {
      if (!host) continue;
      host.hidden = !conversationId;
      host.replaceChildren();
      if (!conversationId) continue;
      const heading = element('div', 'agent-workspace-inspector-heading');
      heading.appendChild(element('strong', '', 'Workspace'));
      const refreshButton = button(
        loading ? 'Refreshing…' : 'Refresh',
        () => refresh(),
        'agent-text-button'
      );
      refreshButton.disabled = loading;
      heading.appendChild(refreshButton);
      host.appendChild(heading);
      const tabs = element('div', 'agent-workspace-inspector-tabs');
      for (const [id, label] of [
        ['files', 'Files'],
        [
          'changes',
          `Changes${changes?.available ? ` · ${changes.changes.length}${changes.limitReached ? '+' : ''}` : ''}`,
        ],
      ]) {
        const tab = button(
          label,
          () => {
            selectedTab = id;
            render();
          },
          'agent-workspace-inspector-tab'
        );
        tab.setAttribute('aria-pressed', String(selectedTab === id));
        tabs.appendChild(tab);
      }
      host.appendChild(tabs);
      const body = element('div', 'agent-workspace-inspector-body');
      if (error) body.appendChild(element('p', 'agent-workspace-note', error));
      if (selectedTab === 'files') {
        const label = element('label', 'agent-workspace-generated-toggle');
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = showGenerated;
        toggle.addEventListener('change', () => {
          showGenerated = toggle.checked;
          void refresh();
        });
        label.appendChild(toggle);
        label.appendChild(element('span', '', 'Show generated files'));
        body.appendChild(label);
        appendDirectory(body, '.');
      } else if (!changes)
        body.appendChild(element('p', 'agent-workspace-note', 'Loading changes…'));
      else if (!changes.available)
        body.appendChild(element('p', 'agent-workspace-note', changes.message));
      else {
        body.appendChild(element('p', 'agent-workspace-note', `Local Git · ${changes.branch}`));
        if (!changes.changes.length)
          body.appendChild(
            element('p', 'agent-workspace-note', 'No changes. Ignored files are excluded.')
          );
        for (const change of changes.changes) {
          const row = button('', () => openFile(change.path, 'diff'));
          row.title = change.path;
          row.appendChild(element('span', 'agent-workspace-file-name', change.path));
          row.appendChild(
            element(
              'span',
              `agent-workspace-file-status ${change.status}`,
              change.status === 'added'
                ? 'A'
                : change.status === 'deleted'
                  ? 'D'
                  : change.status === 'conflicted'
                    ? '!'
                    : 'M'
            )
          );
          body.appendChild(row);
        }
        if (changes.limitReached)
          body.appendChild(element('p', 'agent-workspace-note', 'Showing the first 500 changes.'));
      }
      host.appendChild(body);
    }
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    if (!conversationId) return;
    if (loading) {
      refreshQueued = true;
      return;
    }
    refreshQueued = false;
    const sequence = ++refreshSequence;
    const version = generation;
    loading = true;
    error = '';
    render();
    try {
      // Keep concurrency bounded: two helpers, then expanded folders sequentially.
      const [tree, git] = await Promise.allSettled([inspect('tree'), inspect('changes')]);
      if (version !== generation || sequence !== refreshSequence) return;
      if (tree.status === 'fulfilled' && tree.value) directories.set('.', tree.value);
      else error = 'Files could not be refreshed. Try again.';
      if (git.status === 'fulfilled' && git.value) changes = git.value;
      else changes = { available: false, message: 'Changes could not be refreshed. Try again.' };
      for (const path of expanded) {
        if (version !== generation || sequence !== refreshSequence) return;
        const listing = await inspect('tree', path).catch(() => null);
        if (version !== generation || sequence !== refreshSequence) return;
        if (listing) directories.set(path, listing);
        else {
          directories.delete(path);
          expanded.delete(path);
        }
      }
    } finally {
      if (version === generation && sequence === refreshSequence) {
        loading = false;
        render();
        if (refreshQueued) void refresh();
      }
    }
  }

  return {
    setWorkspace(nextConversationId) {
      if (nextConversationId !== conversationId) {
        generation += 1;
        closeViewer();
        conversationId = nextConversationId;
        directories = new Map();
        expanded = new Set();
        changes = null;
        error = '';
        loading = false;
        refreshQueued = false;
        render();
      }
      clearTimeout(refreshTimer);
      if (conversationId) refreshTimer = setTimeout(() => void refresh(), 250);
    },
  };
}
