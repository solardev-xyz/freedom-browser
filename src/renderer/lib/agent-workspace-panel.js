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
  let history = null;
  let historyBusy = false;
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

  async function openFile(path, kind, versionId = null) {
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
      const result = versionId
        ? await historyRequest('file', { versionId, path })
        : await inspect(kind, path);
      if (!result || sequence !== viewerSequence || version !== generation) return;
      note.textContent =
        result.message ||
        (result.binary
          ? 'Binary file — text preview unavailable.'
          : result.truncated
            ? 'Showing a limited preview (64 KiB maximum).'
            : kind === 'diff'
              ? 'Changes compared with the latest saved version.'
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

  async function historyRequest(action, options = {}) {
    const expected = conversationId;
    const version = generation;
    const response = await window.electronAPI.agentWorkspaceHistory(expected, action, options);
    if (version !== generation || expected !== conversationId) return null;
    if (!response?.ok || response.conversationId !== expected)
      throw new Error(response?.error?.message || 'Workspace history is unavailable.');
    return response.result;
  }

  async function refreshHistory() {
    const version = generation;
    try {
      const result = await historyRequest('list');
      if (result) history = result;
    } catch (error) {
      if (version === generation) history = { versions: [], notice: error.message };
    }
    if (version === generation) render();
  }

  async function saveVersion(label) {
    if (historyBusy || !label.trim()) return;
    const version = generation;
    historyBusy = true;
    error = '';
    render();
    try {
      await historyRequest('save', { label: label.trim() });
      if (version === generation) await refreshHistory();
    } catch (cause) {
      if (version === generation) error = cause.message;
    } finally {
      if (version === generation) {
        historyBusy = false;
        render();
      }
    }
  }

  function historyDialog(title) {
    closeViewer();
    returnFocus = document.activeElement;
    viewer = element('div', 'agent-workspace-viewer-backdrop');
    const dialog = element('section', 'agent-workspace-viewer');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', title);
    const heading = element('div', 'agent-workspace-viewer-heading');
    heading.appendChild(element('strong', '', title));
    const close = button('Close', closeViewer, 'agent-text-button');
    heading.appendChild(close);
    const note = element('p', 'agent-workspace-note', 'Loading…');
    const content = element('div', 'agent-workspace-version-content');
    dialog.appendChild(heading);
    dialog.appendChild(note);
    dialog.appendChild(content);
    viewer.appendChild(dialog);
    document.body.appendChild(viewer);
    viewer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeViewer();
      }
      if (event.key === 'Tab') {
        const targets = [...dialog.querySelectorAll('button')].filter((node) => !node.disabled);
        event.preventDefault();
        const index = targets.indexOf(document.activeElement);
        targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length]?.focus();
      }
    });
    close.focus();
    return { note, content, sequence: viewerSequence, version: generation };
  }

  async function viewVersion(version) {
    const ui = historyDialog(version.label);
    try {
      const result = await historyRequest('files', { versionId: version.id });
      if (!result || ui.sequence !== viewerSequence || ui.version !== generation) return;
      ui.note.textContent = `${result.files.length} saved files. Click a file to inspect this version.`;
      for (const file of result.files)
        ui.content.appendChild(button(file.path, () => openFile(file.path, 'file', version.id)));
      if (result.excluded?.length) {
        ui.content.appendChild(
          element(
            'p',
            'agent-workspace-note',
            'Additional exclusions in this version (up to 20 shown):'
          )
        );
        for (const entry of result.excluded)
          ui.content.appendChild(
            element('p', 'agent-workspace-note', `${entry.path} · ${entry.reason}`)
          );
      }
    } catch (cause) {
      if (ui.sequence === viewerSequence) ui.note.textContent = cause.message;
    }
  }

  async function reviewRestore(version) {
    const ui = historyDialog(`Restore “${version.label}”`);
    try {
      const plan = await historyRequest('prepare_restore', { versionId: version.id });
      if (!plan || ui.sequence !== viewerSequence || ui.version !== generation) return;
      ui.note.textContent =
        'Freedom will back up the already-reviewed current versions, then apply these changes. Unreviewed changes in affected files must be reviewed first. Other project files are left alone.';
      for (const change of plan.changes)
        ui.content.appendChild(
          element(
            'p',
            'agent-workspace-note',
            `${change.action === 'remove' ? 'Remove' : 'Write'} · ${change.path}`
          )
        );
      if (!plan.changes.length)
        ui.content.appendChild(
          element('p', 'agent-workspace-note', 'The eligible files already match this version.')
        );
      const confirm = button(
        'Save current work and restore',
        async () => {
          confirm.disabled = true;
          historyBusy = true;
          ui.note.textContent = 'Saving current work and restoring…';
          try {
            const result = await historyRequest('restore', { token: plan.token });
            if (result && ui.version === generation) {
              closeViewer();
              await refreshHistory();
              void refresh();
            }
          } catch (cause) {
            if (ui.version === generation) {
              ui.note.textContent = cause.message;
              error = cause.message;
            }
          } finally {
            if (ui.version === generation) {
              historyBusy = false;
              render();
            }
          }
        },
        'agent-workspace-restore-confirm'
      );
      confirm.disabled = !plan.changes.length;
      ui.content.appendChild(confirm);
    } catch (cause) {
      if (ui.sequence === viewerSequence) ui.note.textContent = cause.message;
    }
  }

  function renderHistory(body) {
    const form = element('form', 'agent-workspace-version-save');
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 80;
    name.placeholder = 'Name latest checkpoint…';
    name.setAttribute('aria-label', 'Checkpoint name');
    const save = button(
      historyBusy ? 'Saving…' : 'Name checkpoint',
      () => void saveVersion(name.value),
      'agent-text-button'
    );
    save.disabled = historyBusy;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveVersion(name.value);
    });
    form.appendChild(name);
    form.appendChild(save);
    body.appendChild(form);
    body.appendChild(
      element(
        'p',
        'agent-workspace-note',
        'Only agent-reviewed revisions are checkpointed. Other changes stay in your project. Naming a checkpoint adds no new files. Limits: 200 files, 64 KiB per file, 512 KiB total.'
      )
    );
    if (!history) {
      body.appendChild(element('p', 'agent-workspace-note', 'Loading versions…'));
      return;
    }
    if (history.notice) body.appendChild(element('p', 'agent-workspace-note', history.notice));
    const exclusionDetails = element('details', 'agent-workspace-exclusion-editor');
    exclusionDetails.appendChild(element('summary', '', 'Exclude a file from future checkpoints'));
    const exclusionForm = element('form', 'agent-workspace-version-save');
    const excludedPath = document.createElement('input');
    excludedPath.placeholder = 'Project-relative file path';
    excludedPath.setAttribute('aria-label', 'Excluded file path');
    excludedPath.maxLength = 1024;
    const reason = document.createElement('input');
    reason.placeholder = 'Reason (without private details)';
    reason.setAttribute('aria-label', 'Exclusion reason');
    reason.maxLength = 160;
    const exclude = button(
      'Exclude file',
      async () => {
        try {
          await historyRequest('exclude', { path: excludedPath.value, reason: reason.value });
          await refreshHistory();
        } catch (cause) {
          error = cause.message;
          render();
        }
      },
      'agent-text-button'
    );
    exclusionForm.addEventListener('submit', (event) => {
      event.preventDefault();
      exclude.click();
    });
    exclusionForm.appendChild(excludedPath);
    exclusionForm.appendChild(reason);
    exclusionForm.appendChild(exclude);
    exclusionDetails.appendChild(exclusionForm);
    exclusionDetails.appendChild(
      element('p', 'agent-workspace-note', 'Exclusions do not erase copies in earlier versions.')
    );
    body.appendChild(exclusionDetails);
    if (history.exclusions?.length) {
      body.appendChild(element('p', 'agent-workspace-note', 'Additional exclusions'));
      for (const entry of history.exclusions) {
        const row = element('div', 'agent-workspace-version');
        row.appendChild(element('p', 'agent-workspace-note', `${entry.path} · ${entry.reason}`));
        row.appendChild(
          button(
            'Allow review',
            async () => {
              try {
                await historyRequest('include', {
                  path: entry.path,
                  reason: 'User removed the additional exclusion in Versions',
                });
                await refreshHistory();
              } catch (cause) {
                error = cause.message;
                render();
              }
            },
            'agent-text-button'
          )
        );
        body.appendChild(row);
      }
    }
    if (!history.versions.length)
      body.appendChild(element('p', 'agent-workspace-note', 'No versions saved yet.'));
    for (const version of history.versions) {
      const row = element('div', 'agent-workspace-version');
      row.appendChild(button(version.label, () => viewVersion(version)));
      row.appendChild(
        element(
          'p',
          'agent-workspace-note',
          `${version.kind} · ${new Date(version.createdAt).toLocaleString()} · ${version.fileCount} files${version.excludedCount ? ` · ${version.excludedCount} excluded` : ''}`
        )
      );
      const restore = button('Restore…', () => reviewRestore(version), 'agent-text-button');
      restore.disabled = historyBusy || history.running || version.reviewed === false;
      if (version.reviewed === false) row.appendChild(element('p', 'agent-workspace-note', 'Older automatic snapshot — inspect and review files before restoring.'));
      row.appendChild(restore);
      body.appendChild(row);
    }
    if (history.running)
      body.appendChild(
        element('p', 'agent-workspace-note', 'Stop running processes to restore a version.')
      );
    if (history.limitReached)
      body.appendChild(element('p', 'agent-workspace-note', 'Showing the latest 100 versions.'));
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
        ['versions', 'Versions'],
      ]) {
        const tab = button(
          label,
          () => {
            selectedTab = id;
            render();
            if (id === 'versions') void refreshHistory();
          },
          'agent-workspace-inspector-tab'
        );
        tab.setAttribute('aria-pressed', String(selectedTab === id));
        tabs.appendChild(tab);
      }
      host.appendChild(tabs);
      const body = element('div', 'agent-workspace-inspector-body');
      if (error) body.appendChild(element('p', 'agent-workspace-note', error));
      if (selectedTab === 'versions') {
        renderHistory(body);
      } else if (selectedTab === 'files') {
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
      if (selectedTab === 'versions') await refreshHistory();
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
        history = null;
        historyBusy = false;
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
