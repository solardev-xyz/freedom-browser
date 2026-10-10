import { compareText, parsePatch, renderDocument, renderMarkdown } from './workspace-document.js';

function node(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function action(label, handler, className = 'workspace-viewer-action') {
  const result = node('button', className, label); result.type = 'button';
  result.addEventListener('click', event => {
    Promise.resolve().then(() => handler(event)).catch(error => { const message = result.closest?.('.workspace-viewer')?.querySelector('.workspace-viewer-message'); if (message) message.textContent = error.message; });
  }); return result;
}
function select(label, choices, value, handler) {
  const input = node('select', 'workspace-viewer-select'); input.setAttribute('aria-label', label);
  for (const [id, title] of choices) { const option = node('option', '', title); option.value = id; input.appendChild(option); }
  input.value = value;
  input.addEventListener('change', () => handler(input.value)); return input;
}

export function createWorkspaceViewers({ openTab, closeTab, onOpenViewer = () => {}, api = window.electronAPI } = {}) {
  const sessions = new Map(); let conversation = null;
  async function request(session, method, ...args) {
    const response = await api[method](session.conversationId, ...args);
    if (session.closed || conversation !== session.conversationId) return null;
    if (!response?.ok || response.conversationId !== session.conversationId) throw new Error(response?.error?.message || 'Project content is unavailable. Refresh to try again.');
    return response.result;
  }
  const history = (session, type, options = {}) => request(session, 'agentWorkspaceHistory', type, options);
  const inspect = (session, type, path = '.', options = {}) => request(session, 'inspectAgentWorkspace', type, path, type === 'tree', options);
  const current = (session, sequence) => !session.closed && session.sequence === sequence && conversation === session.conversationId;
  const fileOptions = session => ({ versionId: session.version?.id, baseId: session.baseId || undefined });

  function shell(session, subtitle) {
    session.documentScroll = session.document?.scrollTop ?? session.documentScroll ?? 0;
    clearTimeout(session.searchTimer);
    const sequence = ++session.sequence; session.readSequence += 1;
    const header = node('header', 'workspace-viewer-heading');
    const identity = node('div', 'workspace-viewer-identity');
    identity.appendChild(node('strong', '', session.mode === 'history' ? 'History' : session.mode === 'files' ? 'Files' : 'Changes'));
    identity.appendChild(node('span', 'workspace-viewer-caption', subtitle)); header.appendChild(identity);
    const tabs = node('nav', 'workspace-viewer-tabs'); tabs.setAttribute('aria-label', 'Project views');
    for (const [mode, title] of [['files', 'Files'], ['changes', 'Changes'], ['history', 'History']]) {
      const button = action(title, () => {
        session.viewState ||= {};
        session.viewState[session.mode] = { selected: session.selected, filter: session.filter, documentScroll: session.document?.scrollTop || 0 };
        session.mode = mode; session.version = null; session.historyPath = null; session.document = null;
        Object.assign(session, { selected: null, filter: '', documentScroll: 0 }, session.viewState[mode]);
        void show(session);
      });
      button.setAttribute('aria-pressed', String(session.mode === mode)); tabs.appendChild(button);
    }
    header.appendChild(tabs);
    const refresh = action('', () => void show(session), 'agent-workspace-refresh');
    refresh.setAttribute('aria-label', 'Refresh'); refresh.title = 'Refresh';
    refresh.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
    header.appendChild(refresh);
    const controls = node('div', 'workspace-viewer-controls');
    const message = node('p', 'workspace-viewer-message', 'Loading…'); message.setAttribute('role', 'status');
    const body = node('div', 'workspace-viewer-body');
    session.content.replaceChildren(header, controls, message, body);
    return { sequence, header, controls, message, body, valid: () => current(session, sequence) };
  }

  function resize(session, list, ui) {
    list.style.width = `${session.listWidth || 220}px`;
    const handle = node('div', 'workspace-viewer-resize'); handle.tabIndex = 0;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', 'Resize file list');
    const width = value => { session.listWidth = Math.max(150, Math.min(420, value)); list.style.width = `${session.listWidth}px`; handle.setAttribute('aria-valuenow', String(session.listWidth)); };
    handle.setAttribute('aria-valuemin', '150'); handle.setAttribute('aria-valuemax', '420'); width(session.listWidth || 220);
    handle.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); width((session.listWidth || 220) + (event.key === 'ArrowLeft' ? -20 : 20)); } });
    handle.addEventListener('pointerdown', event => { const start = event.clientX, initial = session.listWidth; handle.setPointerCapture(event.pointerId); handle.onpointermove = next => width(initial + next.clientX - start); handle.onpointerup = () => { handle.onpointermove = null; }; });
    ui.body.appendChild(list); ui.body.appendChild(handle);
  }

  function fileList(session, ui, entries, { append = false } = {}) {
    if (!append) {
      session.buttons = []; ui.body.replaceChildren();
      const list = node('nav', 'workspace-viewer-files'); list.setAttribute('aria-label', 'Project files');
      const search = node('input', 'workspace-viewer-search'); search.type = 'search'; search.placeholder = 'Filter files…'; search.setAttribute('aria-label', 'Filter listed files');
      search.value = session.filter || '';
      search.addEventListener('input', () => { session.filter = search.value; for (const button of session.buttons) button.hidden = !button.dataset.path.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()); });
      list.appendChild(search); session.list = list; resize(session, list, ui);
      session.document = node('div', 'workspace-viewer-document'); ui.body.appendChild(session.document);
      list.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        const buttons = session.buttons.filter(button => !button.hidden); const index = buttons.indexOf(document.activeElement);
        if (index < 0) return; event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      });
    }
    for (const entry of entries) {
      const button = action('', () => {
        if (entry.type === 'directory') { session.directory = entry.path; session.selected = null; session.filter = ''; void show(session); }
        else { session.documentScroll = session.selected === entry.path ? session.document.scrollTop : 0; session.selected = entry.path; void readFile(session, ui, entry); }
      }, 'workspace-viewer-file');
      button.dataset.path = entry.path; button.title = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
      button.appendChild(node('span', 'workspace-viewer-path', `${entry.type === 'directory' ? '▸ ' : ''}${entry.name || entry.path}`));
      if (entry.status) button.appendChild(node('span', `agent-workspace-file-status ${entry.status}`, `${entry.status}${entry.staged && entry.unstaged ? ' · staged + unstaged' : entry.staged ? ' · staged' : entry.unstaged ? ' · unstaged' : ''}`));
      if (entry.agentEdited) button.appendChild(node('span', 'workspace-viewer-caption', 'Agent edited'));
      button.hidden = Boolean(session.filter && !entry.path.toLocaleLowerCase().includes(session.filter.toLocaleLowerCase()));
      session.buttons.push(button); session.list.appendChild(button);
    }
    if (!append) {
      const entry = entries.find(item => item.path === session.selected) || entries.find(item => item.type !== 'directory');
      if (entry) { session.selected = entry.path; void readFile(session, ui, entry); }
      else session.document.appendChild(node('p', 'workspace-viewer-message', entries.length ? 'Choose a folder to browse its files.' : 'No files to show'));
    }
  }

  async function projectTree(session, ui) {
    session.expanded ||= new Set();
    const pages = new Map(), loading = new Map(), errors = new Map();
    let searchPages = null, searchExpanded = null, searchSequence = 0;
    const list = node('nav', 'workspace-viewer-files'); list.setAttribute('aria-label', 'Project files');
    const search = node('input', 'workspace-viewer-search'); search.type = 'search'; search.placeholder = 'Search files…'; search.setAttribute('aria-label', 'Search project filenames'); search.maxLength = 200;
    search.value = session.fileQuery || ''; list.appendChild(search);
    const tree = node('div', 'workspace-viewer-tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'Project files'); list.appendChild(tree);
    session.list = list; session.buttons = []; resize(session, list, ui);
    session.document = node('div', 'workspace-viewer-document'); ui.body.appendChild(session.document);
    session.document.appendChild(node('p', 'workspace-viewer-message', 'Choose a file to view.'));

    const paint = () => {
      if (!ui.valid()) return;
      const focus = tree.contains(document.activeElement) ? document.activeElement.dataset.path : null;
      const scroll = list.scrollTop;
      tree.replaceChildren(); session.buttons = [];
      const source = searchPages || pages, expanded = searchPages ? searchExpanded : session.expanded;
      const branch = (path, depth) => {
        const page = source.get(path);
        for (const entry of page?.entries || []) {
          const folder = entry.type === 'directory', open = folder && expanded.has(entry.path);
          const button = action('', async () => {
            if (folder) {
              if (open) expanded.delete(entry.path); else expanded.add(entry.path);
              paint();
              if (!open && !searchPages) await load(entry.path);
            } else {
              session.documentScroll = session.selected === entry.path ? session.document.scrollTop : 0;
              session.selected = entry.path; await readFile(session, ui, entry);
            }
          }, 'workspace-viewer-file workspace-viewer-tree-item');
          button.dataset.path = entry.path; button.dataset.parent = path; button.title = entry.path;
          button.style.paddingLeft = `${10 + depth * 16}px`;
          button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(depth + 1));
          button.setAttribute('aria-selected', String(!folder && session.selected === entry.path));
          if (folder) button.setAttribute('aria-expanded', String(open));
          const chevron = node('span', 'workspace-tree-chevron'); chevron.setAttribute('aria-hidden', 'true');
          if (folder) chevron.classList.add(open ? 'expanded' : 'collapsed');
          button.appendChild(chevron); button.appendChild(node('span', 'workspace-viewer-path', entry.name));
          session.buttons.push(button); tree.appendChild(button);
          if (open) branch(entry.path, depth + 1);
        }
        if (loading.has(path)) tree.appendChild(node('p', 'workspace-viewer-caption', 'Loading folder…'));
        if (errors.has(path)) {
          tree.appendChild(node('p', 'workspace-viewer-message', errors.get(path)));
          tree.appendChild(action('Retry folder', () => load(path, page?.nextOffset || 0)));
        } else if (page?.nextOffset) tree.appendChild(action('Load more files', () => load(path, page.nextOffset)));
        else if (page?.limitReached) tree.appendChild(node('p', 'workspace-viewer-caption', 'Folder listing limit reached.'));
        else if (page && !page.entries.length && !loading.has(path)) tree.appendChild(node('p', 'workspace-viewer-caption', path === '.' ? 'No files found' : 'Empty folder'));
      };
      branch('.', 0); list.scrollTop = scroll;
      session.buttons.find(button => button.dataset.path === focus)?.focus();
    };
    const load = async (path, offset = 0) => {
      if (!ui.valid()) return;
      if (loading.has(path)) return loading.get(path);
      if (!offset && pages.has(path) && !errors.has(path)) return;
      const work = (async () => {
        try {
          const result = await inspect(session, 'tree', path, { offset });
          if (!result || !ui.valid()) return;
          const entries = (result.entries || []).filter(entry => entry.type !== 'other').map(entry => ({ ...entry, path: path === '.' ? entry.name : `${path}/${entry.name}` }));
          pages.set(path, { ...result, entries: [...(offset ? pages.get(path)?.entries || [] : []), ...entries] }); errors.delete(path);
        } catch (error) { if (ui.valid()) errors.set(path, error.message); }
        finally { loading.delete(path); paint(); }
      })();
      loading.set(path, work); paint(); await work;
      // Reload only previously expanded folders, never the entire project.
      for (const entry of pages.get(path)?.entries || []) if (entry.type === 'directory' && session.expanded.has(entry.path) && !searchPages) await load(entry.path);
    };
    const runSearch = async (sequence, query) => {
      if (!ui.valid() || sequence !== searchSequence) return;
      if (!query) { searchPages = null; searchExpanded = null; ui.message.textContent = ''; paint(); await load('.'); return; }
      ui.message.textContent = 'Searching…';
      try {
        const result = await inspect(session, 'search', '.', { query });
        if (!result || !ui.valid() || sequence !== searchSequence) return;
        searchPages = new Map([['.', { entries: [] }]]); searchExpanded = new Set();
        for (const entry of result.entries || []) {
          const parts = entry.path.split('/'); let parent = '.';
          for (let i = 0; i < parts.length; i += 1) {
            const path = parent === '.' ? parts[i] : `${parent}/${parts[i]}`, folder = i < parts.length - 1;
            if (!searchPages.get(parent).entries.some(item => item.path === path)) searchPages.get(parent).entries.push({ path, name: parts[i], type: folder ? 'directory' : 'file' });
            if (folder) { if (!searchPages.has(path)) searchPages.set(path, { entries: [] }); searchExpanded.add(path); }
            parent = path;
          }
        }
        for (const page of searchPages.values()) page.entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
        paint(); ui.message.textContent = result.limitReached ? 'Showing bounded search results. Refine your search.' : `${result.entries.length} ${result.entries.length === 1 ? 'file' : 'files'} found`;
      } catch (error) { if (ui.valid() && sequence === searchSequence) ui.message.textContent = error.message; }
    };
    search.addEventListener('input', () => {
      session.fileQuery = search.value; const sequence = ++searchSequence;
      clearTimeout(session.searchTimer);
      const query = search.value.trim().slice(0, 200);
      if (!query) void runSearch(sequence, '');
      else session.searchTimer = setTimeout(() => void runSearch(sequence, query), 180);
    });
    tree.addEventListener('keydown', event => {
      const active = document.activeElement, index = session.buttons.indexOf(active);
      if (index < 0 || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowDown') session.buttons[Math.min(index + 1, session.buttons.length - 1)]?.focus();
      if (event.key === 'ArrowUp') session.buttons[Math.max(0, index - 1)]?.focus();
      if (event.key === 'Home') session.buttons[0]?.focus();
      if (event.key === 'End') session.buttons.at(-1)?.focus();
      if (event.key === 'ArrowRight') { if (active.getAttribute('aria-expanded') === 'false') active.click(); else if (active.getAttribute('aria-expanded') === 'true') session.buttons[index + 1]?.focus(); }
      if (event.key === 'ArrowLeft') { if (active.getAttribute('aria-expanded') === 'true') active.click(); else session.buttons.find(button => button.dataset.path === active.dataset.parent)?.focus(); }
    });
    await load('.'); if (!ui.valid()) return;
    ui.message.textContent = '';
    if (session.fileQuery?.trim()) await runSearch(++searchSequence, session.fileQuery.trim().slice(0, 200));
    if (!ui.valid()) return;
    const entry = [...pages.values()].flatMap(page => page.entries).find(entry => entry.path === session.selected && entry.type === 'file');
    if (entry) await readFile(session, ui, entry);
  }

  async function readFile(session, ui, entry) {
    const sequence = ++session.readSequence;
    const valid = () => ui.valid() && sequence === session.readSequence;
    for (const button of session.buttons || []) button.setAttribute(button.getAttribute('role') === 'treeitem' ? 'aria-selected' : 'aria-pressed', String(button.dataset.path === entry.path));
    const pane = session.document; pane.replaceChildren();
    const heading = node('div', 'workspace-viewer-file-heading', entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path);
    const tools = node('div', 'workspace-viewer-document-tools');
    const note = node('p', 'workspace-viewer-message', 'Loading file…');
    const code = node('div', 'workspace-viewer-code'); code.tabIndex = 0;
    pane.appendChild(heading); pane.appendChild(tools); pane.appendChild(note); pane.appendChild(code);
    try {
      const comparison = session.mode !== 'files' && !session.browse && entry.preview !== 'file';
      let result, rows, text = '', offset = null, fullFile = false, beforeText = '', afterText = '';
      const historical = Boolean(session.version);
      if (historical && comparison) {
        result = await history(session, 'comparison_file', { ...fileOptions(session), path: entry.path });
        if (!result || !valid()) return;
        beforeText = result.before.text || ''; afterText = result.after.text || '';
        rows = compareText(beforeText, afterText); text = afterText;
        offset = result.before.nextOffset || result.after.nextOffset;
        note.textContent = result.before.message || result.after.message || (result.before.binary || result.after.binary ? 'Binary file — text comparison unavailable.' : result.before.truncated || result.after.truncated ? 'Comparison is limited to the first 64 KiB of each file.' : '');
      } else {
        result = historical ? await history(session, 'file', { versionId: session.version.id, path: entry.path }) : await inspect(session, comparison ? 'diff' : 'file', entry.path, { scope: session.scope || 'all' });
        if (!result || !valid()) return;
        text = result.text || ''; offset = result.nextOffset;
        rows = comparison ? parsePatch(text) : text.split('\n').map((line, index) => ({ kind: 'context', text: line, newLine: index + 1 }));
        note.textContent = result.message || (result.binary ? 'Binary file — text preview unavailable.' : result.truncated ? 'Showing a bounded preview.' : '');
      }
      const paint = () => {
        if (!valid()) return;
        if ((!comparison || fullFile) && /\.(?:md|markdown)$/i.test(entry.path)) { renderMarkdown(code, text, { query: session.find || '' }); return; }
        renderDocument(code, rows, { split: comparison && !fullFile && session.split, query: session.find || '', highlight: /\.(?:[cm]?[jt]sx?|json|css|py|sh|ya?ml)$/.test(entry.path), collapse: comparison && !fullFile });
      };
      const search = node('input', 'workspace-viewer-search'); search.type = 'search'; search.placeholder = 'Find in file…'; search.setAttribute('aria-label', 'Find in file'); search.value = session.find || '';
      search.addEventListener('input', () => { session.find = search.value; paint(); code.querySelector('mark')?.scrollIntoView?.({ block: 'center' }); }); tools.appendChild(search);
      tools.appendChild(action('Copy', async () => { try { await navigator.clipboard.writeText(text); if (valid()) note.textContent = 'Copied.'; } catch { if (valid()) note.textContent = 'Copy unavailable. Select the text and copy it.'; } }));
      if (comparison) {
        tools.appendChild(action('Side by side', () => { session.split = !session.split; paint(); }));
        let index = -1;
        const jump = direction => { const changes = [...code.querySelectorAll('[data-change]')]; if (changes.length) { index = (index + direction + changes.length) % changes.length; changes[index].scrollIntoView?.({ block: 'center' }); } };
        tools.appendChild(action('Previous change', () => jump(-1))); tools.appendChild(action('Next change', () => jump(1)));
        tools.appendChild(action('Full file', async () => {
          if (fullFile) { fullFile = false; await readFile(session, ui, entry); return; }
          const file = historical ? await history(session, 'file', { versionId: session.version.id, path: entry.path }) : await inspect(session, 'file', entry.path);
          if (!file || !valid()) return;
          fullFile = true; text = file.text || ''; rows = text.split('\n').map((line, index) => ({ kind: 'context', text: line, newLine: index + 1 })); note.textContent = file.message || (file.truncated ? 'Full file preview is limited to 64 KiB.' : 'Full file'); paint();
        }));
      }
      if (!historical && /\.(png|jpe?g|gif|webp)$/i.test(entry.path)) tools.appendChild(action('Preview image', async () => {
        const image = await inspect(session, 'image', entry.path); if (!image || !valid()) return;
        if (!image.dataUrl) { note.textContent = image.message; return; }
        const img = node('img', 'workspace-viewer-image'); img.alt = entry.path; img.src = image.dataUrl; code.replaceChildren(img); note.textContent = '';
      }));
      tools.appendChild(action('File history', () => { session.historyPath = entry.path; session.mode = 'history'; session.version = null; session.versions = []; void show(session); }));
      if (historical) tools.appendChild(action('Compare with current', async () => {
        const currentFile = await inspect(session, 'file', entry.path); const old = await history(session, 'file', { versionId: session.version.id, path: entry.path });
        if (!currentFile || !old || !valid()) return;
        if (currentFile.binary || old.binary || currentFile.truncated || old.truncated) { note.textContent = 'This comparison requires two complete text previews.'; return; }
        rows = compareText(old.text, currentFile.text); note.textContent = `${session.version.id.slice(0, 7)} → current file`; renderDocument(code, rows, { split: session.split });
      }));
      if (offset !== null && offset !== undefined) {
        const more = action('Load more', async () => {
          more.disabled = true;
          try {
            if (historical && comparison) {
              const next = await history(session, 'comparison_file', { ...fileOptions(session), path: entry.path, offset });
              if (!next || !valid()) return;
              beforeText += next.before.text || ''; afterText += next.after.text || ''; text = afterText;
              offset = next.before.nextOffset || next.after.nextOffset; rows = compareText(beforeText, afterText); paint(); more.hidden = !offset; note.textContent = offset ? 'Showing a bounded comparison.' : ''; return;
            }
            const file = historical ? await history(session, 'file', { versionId: session.version.id, path: entry.path, offset }) : await inspect(session, comparison ? 'diff' : 'file', entry.path, { offset, revision: result.revision, scope: session.scope || 'all' });
            if (!file || !valid()) return;
            text += file.text || ''; offset = file.nextOffset; rows = comparison ? parsePatch(text) : text.split('\n').map((line, index) => ({ kind: 'context', text: line, newLine: index + 1 })); paint(); more.hidden = !offset; note.textContent = file.truncated ? 'Showing a bounded preview.' : '';
          } catch (error) { if (valid()) note.textContent = error.message; }
          finally { more.disabled = false; }
        }); tools.appendChild(more);
      }
      paint(); pane.scrollTop = session.documentScroll || 0;
    } catch (error) { if (valid()) note.textContent = error.message; }
  }

  async function showHistory(session, ui, cursor = null) {
    const state = await history(session, 'list', { ...(cursor && { cursor }), ...(session.historyPath && { path: session.historyPath }) });
    if (!state || !ui.valid()) return;
    session.versions = cursor ? [...session.versions, ...(state.versions || [])] : state.versions || [];
    ui.message.textContent = state.noRepository ? 'This folder has no Git repository.' : session.historyPath ? `History of ${session.historyPath}` : '';
    ui.body.replaceChildren();
    const list = node('nav', 'workspace-viewer-files'); list.setAttribute('aria-label', 'Commits'); resize(session, list, ui);
    const detail = node('div', 'workspace-viewer-document'); detail.appendChild(node('p', 'workspace-viewer-message', 'Choose a commit to review its changes.')); ui.body.appendChild(detail);
    for (const version of session.versions) {
      const button = action('', () => { session.version = version; session.selected = null; session.browse = false; session.baseId = null; void show(session); }, 'workspace-viewer-file');
      button.appendChild(node('strong', 'workspace-viewer-path', version.label));
      button.appendChild(node('span', 'workspace-viewer-caption', `${version.id.slice(0, 7)} · ${new Date(version.createdAt).toLocaleString()}`)); list.appendChild(button);
    }
    if (state.nextCursor) { const more = action('Load older commits', async () => { more.disabled = true; try { await showHistory(session, ui, state.nextCursor); } finally { more.disabled = false; } }); list.appendChild(more); }
    if (!session.versions.length) detail.replaceChildren(node('p', 'workspace-viewer-message', 'No commits to show'));
    const recovery = await history(session, 'recovery'); if (!recovery || !ui.valid() || !recovery.pending) return;
    const card = node('div', 'workspace-viewer-recovery'); card.appendChild(node('strong', '', 'An interrupted operation needs attention'));
    card.appendChild(node('p', '', recovery.message || 'A restore did not finish. Review the saved backup before recovering.'));
    for (const step of recovery.steps || []) card.appendChild(node('p', '', step));
    if (recovery.candidate) card.appendChild(node('code', '', `Commit ${recovery.candidate}`));
    if (recovery.repairable) card.appendChild(action('Review finalization', () => {
      card.appendChild(node('p', '', 'The commit is already on the original branch. Freedom will finalize its prepared staging index and archive its recovery record. Working files stay unchanged. Editing access is required.'));
      const confirm = action('Finalize this commit', async () => {
        if (!ui.valid() || confirm.disabled) return; confirm.disabled = true;
        const result = await history(session, 'repair_commit', { token: recovery.token });
        if (result && ui.valid()) { session.onChanged?.(); await show(session); }
      }); card.appendChild(confirm);
    }));
    if (recovery.backupId) card.appendChild(action('Review recovery', () => void reviewRestore(session, true)));
    detail.prepend(card);
  }

  async function show(session) {
    const subtitle = session.version ? `Read-only commit · ${session.version.id.slice(0, 7)} · ${session.version.label}` : session.mode === 'changes' ? (session.scope === 'staged' ? 'Staged changes vs latest commit' : session.scope === 'unstaged' ? 'Working files vs staged version' : 'Current files vs latest commit') : 'Read-only project browser';
    const ui = shell(session, subtitle);
    try {
      if (session.mode === 'history' && !session.version) { await showHistory(session, ui); return; }
      if (session.version) {
        const [result, state] = await Promise.all([history(session, session.browse ? 'files' : 'comparison', fileOptions(session)), history(session, 'list')]);
        if (!result || !state || !ui.valid()) return;
        session.versions = [...new Map([...(session.versions || []), ...(state.versions || [])].map(version => [version.id, version])).values()];
        ui.controls.appendChild(action('All commits', () => { session.version = null; void show(session); }));
        ui.controls.appendChild(action(session.browse ? 'Show changes' : 'Browse files at this commit', () => { session.browse = !session.browse; void show(session); }));
        ui.controls.appendChild(select('Compare from', [['', 'Parent commit'], ...session.versions.filter(version => version.id !== session.version.id).map(version => [version.id, `${version.id.slice(0, 7)} · ${version.label}`])], session.baseId || '', value => { session.baseId = value; session.browse = false; void show(session); }));
        if (state.restorable !== false) {
          const restore = action('Restore…', () => void reviewRestore(session)); restore.disabled = state.running || session.version.reviewed === false; restore.title = restore.disabled ? 'Stop processes and review current files before restoring.' : 'Review the exact changes before restoring.'; ui.controls.appendChild(restore);
          const restoreFile = action('Restore file…', () => session.selected ? reviewRestore(session, false, [session.selected]) : Promise.resolve());
          restoreFile.disabled = restore.disabled; restoreFile.title = 'Review restoring only the selected file'; ui.controls.appendChild(restoreFile);
        }
        ui.message.textContent = result.truncated ? 'More files are available below.' : session.browse ? 'Files saved in this commit' : `${result.baseId?.slice(0, 7) || 'Empty project'} → ${session.version.id.slice(0, 7)}`;
        fileList(session, ui, result.files || []);
        let offset = result.nextOffset;
        if (offset) {
          const more = action('Load more files', async () => {
            more.disabled = true;
            try {
              const next = await history(session, session.browse ? 'files' : 'comparison', { ...fileOptions(session), offset });
              if (!next || !ui.valid()) return;
              fileList(session, ui, next.files || [], { append: true }); offset = next.nextOffset; more.hidden = !offset;
            } finally { more.disabled = false; }
          }); ui.controls.appendChild(more);
        }
        return;
      }
      if (session.mode === 'files') { await projectTree(session, ui); return; }
      ui.controls.appendChild(select('Changes to show', [['all', 'All changes'], ['staged', 'Staged changes'], ['unstaged', 'Unstaged changes']], session.scope || 'all', value => { session.scope = value; session.selected = null; void show(session); }));
      const changes = await inspect(session, 'changes', '.', { scope: session.scope || 'all' });
      if (!changes || !ui.valid()) return;
      if (!changes.available) { ui.message.textContent = changes.message; return; }
      ui.message.textContent = changes.recordedEditsOnly ? 'No Git baseline. Only direct edits recorded in this conversation are listed.' : changes.limitReached ? 'Showing the first 500 changes.' : changes.project ? 'Includes existing project edits. “Agent edited” identifies direct edits in this conversation.' : '';
      if (changes.recordedEditsOnly) { ui.controls.querySelector('select').disabled = true; ui.header.querySelector('.workspace-viewer-caption').textContent = 'Recorded edits in this conversation'; }
      fileList(session, ui, changes.changes || []);
    } catch (error) { if (ui.valid()) ui.message.textContent = error.message; }
  }

  async function reviewRestore(session, recovering = false, selectedPaths = null) {
    const ui = shell(session, recovering ? 'Review recovery' : 'Review restore');
    ui.controls.appendChild(action('Back', () => void show(session)));
    try {
      const plan = await history(session, recovering ? 'prepare_recovery' : 'prepare_restore', recovering ? {} : { versionId: session.version.id, ...(selectedPaths && { paths: selectedPaths }) });
      if (!plan || !ui.valid()) return;
      ui.message.textContent = 'Review the changes below. Freedom saves reviewed current files before applying them. Unrelated files are left alone.';
      const review = node('div', 'workspace-viewer-restore'); const selected = new Set(plan.changes.map(change => change.path));
      for (const change of plan.changes) {
        const label = node('label', 'workspace-viewer-restore-file'); const check = node('input', ''); check.type = 'checkbox'; check.checked = true; check.disabled = recovering;
        check.addEventListener('change', () => { if (check.checked) selected.add(change.path); else selected.delete(change.path); });
        label.appendChild(check); label.appendChild(node('span', '', `${change.action === 'remove' ? 'Remove' : 'Write'} · ${change.path}`)); review.appendChild(label);
        const code = node('div', 'workspace-viewer-code'); renderDocument(code, compareText(change.before?.text, change.after?.text)); review.appendChild(code);
      }
      const confirm = action('Back up reviewed work and restore', async () => {
        if (!ui.valid() || confirm.disabled) return;
        if (!selected.size && !recovering) { ui.message.textContent = 'Select at least one file.'; return; }
        if (!recovering && selected.size !== plan.changes.length) { await reviewRestore(session, false, [...selected]); return; }
        confirm.disabled = true; ui.message.textContent = 'Saving backup and restoring…';
        try {
          const result = await history(session, 'restore', { token: plan.token });
          if (result && ui.valid()) { await show(session); session.onChanged?.(); }
        } catch (error) {
          if (ui.valid()) { ui.message.textContent = error.message; review.appendChild(action('Inspect recovery', () => { session.mode = 'history'; session.version = null; void show(session); })); }
        }
      }, 'workspace-viewer-action workspace-viewer-restore-confirm');
      confirm.disabled = !plan.changes.length && !recovering;
      if (recovering && !plan.changes.length) confirm.textContent = 'Finish recovery';
      if (!plan.changes.length) review.appendChild(node('p', '', 'The eligible files already match this commit.'));
      review.appendChild(confirm); ui.body.appendChild(review);
    } catch (error) { if (ui.valid()) ui.message.textContent = error.message; }
  }

  return {
    setConversation(next) { conversation = next; for (const session of [...sessions.values()]) if (session.conversationId !== next) closeTab?.(session.tab.id); },
    open(conversationId, version = null, onChanged = null, mode = version ? 'history' : 'changes') {
      if (conversationId !== conversation || !conversationId || typeof openTab !== 'function') throw new Error('Project viewers are unavailable.');
      const key = version ? `commit:${version.id}` : mode;
      let session = sessions.get(key);
      if (!session) {
        session = { key, conversationId, version, mode, title: version ? version.label : { files: 'Files', history: 'History', changes: 'Changes' }[mode], content: node('section', 'workspace-viewer'), sequence: 0, readSequence: 0, closed: false, onChanged };
        session.content.setAttribute('aria-label', session.title);
        session.content.addEventListener('keydown', event => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault(); event.stopPropagation(); session.document?.querySelector('input[type="search"]')?.focus();
          }
        });
        session.tab = openTab({ key, conversationId, title: session.title, content: session.content, onClose: () => { session.closed = true; clearTimeout(session.searchTimer); sessions.delete(key); } });
        sessions.set(key, session); void show(session);
      } else openTab({ key, conversationId, title: session.title, content: session.content });
      onOpenViewer(); return session.tab;
    },
  };
}
