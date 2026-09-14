// Read-only chrome surfaces. Content is rendered as text, never as a page or HTML.
function node(tag, className, text) {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function action(label, handler, className = 'workspace-viewer-action') {
  const result = node('button', className, label);
  result.type = 'button';
  result.addEventListener('click', handler);
  return result;
}

export function createWorkspaceViewers({ openTab, closeTab, onOpenViewer = () => {} } = {}) {
  const sessions = new Map();
  let conversation = null;

  async function request(session, api, ...args) {
    const response = await window.electronAPI[api](session.conversationId, ...args);
    if (session.closed || conversation !== session.conversationId) return null;
    if (!response?.ok || response.conversationId !== session.conversationId) throw new Error(response?.error?.message || 'Workspace content is unavailable.');
    return response.result;
  }
  const history = (session, type, options = {}) => request(session, 'agentWorkspaceHistory', type, options);
  const inspect = (session, type, path = '.') => request(session, 'inspectAgentWorkspace', type, path, false);
  const current = (session, sequence) => !session.closed && session.sequence === sequence && conversation === session.conversationId;

  function shell(session, subtitle) {
    const sequence = ++session.sequence;
    session.readSequence += 1;
    const header = node('header', 'workspace-viewer-heading');
    const identity = node('div', 'workspace-viewer-identity');
    identity.appendChild(node('strong', '', session.title));
    identity.appendChild(node('span', 'workspace-viewer-caption', subtitle));
    header.appendChild(identity);
    const close = action('Close', () => closeTab(session.tab.id));
    header.appendChild(close);
    const message = node('p', 'workspace-viewer-message', 'Loading…');
    const body = node('div', 'workspace-viewer-body');
    session.content.replaceChildren(header, message, body);
    return { sequence, header, message, body, valid: () => current(session, sequence) };
  }

  async function readFile(session, ui, entry, content, buttons) {
    const readSequence = ++session.readSequence;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.path === entry.path));
    const heading = node('div', 'workspace-viewer-file-heading', entry.path);
    const note = node('p', 'workspace-viewer-message', 'Loading file…');
    const pre = node('pre', 'workspace-viewer-code');
    pre.tabIndex = 0;
    content.replaceChildren(heading, note, pre);
    try {
      const result = session.version
        ? await history(session, 'file', { versionId: session.version.id, path: entry.path })
        : await inspect(session, 'diff', entry.path);
      if (!result || !ui.valid() || readSequence !== session.readSequence) return;
      note.textContent = result.message || (result.binary ? 'Binary file — text preview unavailable.'
        : result.truncated ? 'Limited preview — file content was truncated.' : '');
      const lines = result.binary ? [] : (result.text || '').split('\n');
      if (lines.length > 2000) note.textContent = 'Showing the first 2,000 lines.';
      for (const line of lines.slice(0, 2000)) {
        const row = node('span', !session.version && line.startsWith('+') ? 'agent-diff-added'
          : !session.version && line.startsWith('-') ? 'agent-diff-deleted'
            : !session.version && line.startsWith('@@') ? 'agent-diff-hunk' : '', `${line}\n`);
        pre.appendChild(row);
      }
    } catch (cause) {
      if (ui.valid() && readSequence === session.readSequence) note.textContent = cause.message;
    }
  }

  function fileList(session, ui, entries) {
    const list = node('nav', 'workspace-viewer-files');
    list.setAttribute('aria-label', session.version ? 'Checkpoint files' : 'Changed files');
    const content = node('div', 'workspace-viewer-document');
    const buttons = [];
    for (const entry of entries) {
      const button = action('', () => void readFile(session, ui, entry, content, buttons), 'workspace-viewer-file');
      button.dataset.path = entry.path;
      button.title = entry.path;
      button.appendChild(node('span', 'workspace-viewer-path', entry.path));
      if (entry.status) button.appendChild(node('span', `agent-workspace-file-status ${entry.status}`,
        { added: 'Added', modified: 'Modified', deleted: 'Deleted', conflicted: 'Conflict' }[entry.status] || 'Changed'));
      buttons.push(button);
      list.appendChild(button);
    }
    ui.body.appendChild(list);
    ui.body.appendChild(content);
    if (entries.length) void readFile(session, ui, entries[0], content, buttons);
    else content.appendChild(node('p', 'workspace-viewer-message', session.version ? 'No files in this checkpoint' : 'No changes since the latest checkpoint'));
  }

  async function show(session) {
    const ui = shell(session, session.version ? `Read-only checkpoint · ${new Date(session.version.createdAt).toLocaleString()}` : 'Read-only · Changes since the latest checkpoint');
    ui.header.insertBefore(action('Refresh', () => void show(session)), ui.header.lastChild);
    try {
      if (session.version) {
        const [files, state] = await Promise.all([history(session, 'files', { versionId: session.version.id }), history(session, 'list')]);
        if (!files || !state || !ui.valid()) return;
        ui.message.textContent = '';
        const restore = action('Restore…', () => void reviewRestore(session));
        restore.disabled = state.running || session.version.reviewed === false;
        restore.title = state.running ? 'Stop running processes before restoring' : session.version.reviewed === false ? 'This older snapshot must be reviewed before restoring' : 'Review the affected files before confirming';
        ui.header.insertBefore(restore, ui.header.lastChild);
        fileList(session, ui, files.files);
      } else {
        const changes = await inspect(session, 'changes');
        if (!changes || !ui.valid()) return;
        if (!changes.available) { ui.message.textContent = changes.message; return; }
        ui.message.textContent = changes.limitReached ? 'Showing the first 500 changes. Ignored files are excluded.' : '';
        fileList(session, ui, changes.changes);
      }
    } catch (cause) {
      if (ui.valid()) ui.message.textContent = cause.message;
    }
  }

  async function reviewRestore(session) {
    const ui = shell(session, 'Review restore');
    ui.header.insertBefore(action('Back', () => void show(session)), ui.header.firstChild);
    try {
      const plan = await history(session, 'prepare_restore', { versionId: session.version.id });
      if (!plan || !ui.valid()) return;
      ui.message.textContent = 'Freedom backs up already-reviewed current versions before applying these changes. Unreviewed changes must be reviewed first. Other project files are left alone.';
      const review = node('div', 'workspace-viewer-restore');
      for (const change of plan.changes) review.appendChild(node('p', '', `${change.action === 'remove' ? 'Remove' : 'Write'} · ${change.path}`));
      const confirm = action('Back up reviewed work and restore', async () => {
        if (!ui.valid() || confirm.disabled) return;
        confirm.disabled = true;
        ui.message.textContent = 'Backing up reviewed work and restoring…';
        try {
          const result = await history(session, 'restore', { token: plan.token });
          if (result && ui.valid()) { await show(session); session.onChanged?.(); }
        } catch (cause) {
          if (ui.valid()) ui.message.textContent = cause.message;
          // A restore can have partially applied. Never retry the consumed plan.
        }
      }, 'workspace-viewer-action workspace-viewer-restore-confirm');
      confirm.disabled = !plan.changes.length;
      if (!plan.changes.length) review.appendChild(node('p', '', 'The eligible files already match this checkpoint.'));
      review.appendChild(confirm);
      ui.body.appendChild(review);
    } catch (cause) {
      if (ui.valid()) ui.message.textContent = cause.message;
    }
  }

  return {
    setConversation(next) {
      conversation = next;
      for (const session of [...sessions.values()]) if (session.conversationId !== next) closeTab?.(session.tab.id);
    },
    open(conversationId, version = null, onChanged = null) {
      if (conversationId !== conversation || !conversationId || typeof openTab !== 'function') throw new Error('Workspace viewers are unavailable.');
      const key = version ? `checkpoint:${version.id}` : 'changes';
      let session = sessions.get(key);
      if (!session) {
        session = { key, conversationId, version, title: version ? version.label : 'Changes', content: node('section', 'workspace-viewer'), sequence: 0, readSequence: 0, closed: false, onChanged };
        session.content.setAttribute('aria-label', session.title);
        session.tab = openTab({ key, conversationId, title: session.title, content: session.content, onClose: () => { session.closed = true; sessions.delete(key); } });
        sessions.set(key, session);
        void show(session);
      } else openTab({ key, conversationId, title: session.title, content: session.content });
      onOpenViewer();
      return session.tab;
    },
  };
}
