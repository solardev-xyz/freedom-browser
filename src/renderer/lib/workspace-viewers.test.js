const { createDocument, createElement } = require('../../../test/helpers/fake-dom');
const { createWorkspaceViewers } = require('./workspace-viewers');
const flush = async () => { for (let n = 0; n < 16; n += 1) await Promise.resolve(); };
const find = (root, text) => root.querySelectorAll('.workspace-viewer-action, .workspace-viewer-restore-confirm').find((node) => node.textContent === text);
function renderElement(tag) {
  const result = createElement(tag);
  Object.defineProperty(result, 'lastChild', { get: () => result.children.at(-1) || null });
  result.insertBefore = (child, before) => { if (!before) return result.appendChild(child); const i = result.children.indexOf(before); child.remove(); child.parentNode = result; result.children.splice(i, 0, child); return child; };
  return result;
}

describe('read-only workspace viewers', () => {
  let viewers, tabs, openTab, closeTab, inspect, history;
  const version = { id: 'a'.repeat(40), label: 'Working game', createdAt: 1000, reviewed: true };
  beforeEach(() => {
    global.document = createDocument({ createElementOverride: renderElement });
    inspect = jest.fn(async (conversationId, type) => ({ ok: true, conversationId, result: type === 'changes'
      ? { available: true, changes: [{ path: 'game.js', status: 'modified' }] } : { text: '@@ -0,0 +1 @@\n+<script>untrusted</script>' } }));
    history = jest.fn(async (conversationId, type) => ({ ok: true, conversationId, result: type === 'list' ? { versions: [version], running: false }
      : ['files', 'comparison'].includes(type) ? { files: [{ path: 'game.js' }] } : type === 'comparison_file' ? { before: { text: '' }, after: { text: '<script>untrusted</script>' } } : type === 'file' ? { text: '<script>untrusted</script>' }
        : type === 'prepare_restore' ? { token: 'plan_one', changes: [{ path: 'game.js', action: 'write' }] } : { restored: true } }));
    global.window = { electronAPI: { inspectAgentWorkspace: inspect, agentWorkspaceHistory: history } };
    tabs = [];
    openTab = jest.fn((options) => { const old = tabs.find((tab) => tab.key === options.key); if (old) return old; const tab = { ...options, id: tabs.length + 1 }; tabs.push(tab); document.body.appendChild(tab.content); return tab; });
    closeTab = jest.fn((id) => { const tab = tabs.find((entry) => entry.id === id); tab.onClose(); tab.content.remove(); tabs = tabs.filter((entry) => entry !== tab); });
    viewers = createWorkspaceViewers({ openTab, closeTab }); viewers.setConversation('one');
  });
  afterEach(() => { viewers.setConversation(null); jest.useRealTimers(); delete global.document; delete global.window; });

  test('expands folders inline and restores the tree when live search clears, ignoring stale results', async () => {
    jest.useFakeTimers();
    let finishOld;
    inspect.mockImplementation(async (conversationId, type, path, _generated, options) => {
      const result = type === 'tree' ? { entries: path === '.' ? [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' }] : [{ name: 'planet.js', type: 'file' }] }
        : type === 'search' ? options.query === 'old' ? await new Promise(resolve => { finishOld = resolve; }) : { entries: [{ path: 'other/moon.js', type: 'file' }] }
          : { text: '# Project\nSafe documentation' };
      return { ok: true, conversationId, result };
    });
    viewers.open('one', null, null, 'files'); await flush();
    const host = tabs[0].content;
    const paths = () => host.querySelectorAll('.workspace-viewer-tree-item').map(button => button.dataset.path);
    const folder = () => host.querySelectorAll('.workspace-viewer-tree-item').find(button => button.dataset.path === 'src');
    expect(paths()).toEqual(['src', 'README.md']);
    expect(inspect).toHaveBeenCalledWith('one', 'tree', '.', true, { offset: 0 });
    folder().dispatch('click'); await flush();
    expect(paths()).toEqual(['src', 'src/planet.js', 'README.md']);
    host.querySelectorAll('.workspace-viewer-tree-item').find(button => button.dataset.path === 'README.md').dispatch('click'); await flush();
    const pane = host.querySelector('.workspace-viewer-document');
    expect(pane.querySelector('.workspace-markdown')).not.toBeNull();
    expect(find(host, 'Wrap')).toBeUndefined(); expect(find(host, 'Markdown preview')).toBeUndefined(); expect(find(host, 'Up')).toBeUndefined();
    const search = host.querySelector('.workspace-viewer-search');
    search.value = 'old'; search.dispatch('input'); jest.advanceTimersByTime(180); await flush();
    search.value = 'moon'; search.dispatch('input'); jest.advanceTimersByTime(180); await flush();
    expect(paths()).toEqual(['other', 'other/moon.js']);
    search.value = ''; search.dispatch('input'); await flush();
    expect(paths()).toEqual(['src', 'src/planet.js', 'README.md']);
    finishOld({ entries: [{ path: 'stale.js', type: 'file' }] }); await flush();
    expect(paths()).toEqual(['src', 'src/planet.js', 'README.md']);
    expect(host.querySelector('.workspace-viewer-document')).toBe(pane);
    folder().dispatch('click'); await flush(); expect(paths()).toEqual(['src', 'README.md']);
    folder().dispatch('click'); await flush(); expect(paths()).toContain('src/planet.js');
    expect(inspect.mock.calls.filter(args => args[1] === 'tree' && args[2] === 'src')).toHaveLength(1);
  });

  test('opens separate reusable Changes and checkpoint tabs and renders code only as text', async () => {
    viewers.open('one'); viewers.open('one', version); await flush();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].content.querySelectorAll('.workspace-code-text').some(row => row.textContent.includes('<script>') || row.children.some(child => child.textContent.includes('<script>')))).toBe(true);
    expect(tabs[1].content.querySelectorAll('.workspace-code-text').some(row => row.textContent.includes('<script>') || row.children.some(child => child.textContent.includes('<script>')))).toBe(true);
    expect(tabs[1].content.querySelector('.workspace-viewer-code').attributes.contenteditable).toBeUndefined();
    expect(history).toHaveBeenCalledWith('one', 'comparison_file', { versionId: version.id, baseId: undefined, path: 'game.js' });
    viewers.open('one'); expect(tabs).toHaveLength(2);
    expect(tabs[0].content.querySelectorAll('.workspace-viewer-file')).toHaveLength(1);
  });

  test('restore is a reviewed in-tab plan with one explicit settlement and no automatic retry', async () => {
    viewers.open('one', version); await flush();
    find(tabs[0].content, 'Restore…').dispatch('click'); await flush();
    expect(history).toHaveBeenCalledWith('one', 'prepare_restore', { versionId: version.id });
    expect(history.mock.calls.some((args) => args[1] === 'restore')).toBe(false);
    history.mockImplementation(async (conversationId, action) => action === 'restore' ? { ok: false, error: { message: 'Partial restore; backup retained.' } } : { ok: true, conversationId, result: {} });
    const confirm = find(tabs[0].content, 'Back up reviewed work and restore'); confirm.dispatch('click'); await flush(); confirm.dispatch('click');
    expect(history.mock.calls.filter((args) => args[1] === 'restore')).toHaveLength(1);
    expect(tabs[0].content.querySelector('.workspace-viewer-message').textContent).toBe('Partial restore; backup retained.');
    expect(confirm.disabled).toBe(true);
  });

  test('disables restore of an unreviewed snapshot and while a process is running', async () => {
    viewers.open('one', { ...version, reviewed: false }); await flush();
    expect(find(tabs[0].content, 'Restore…').disabled).toBe(true);
    closeTab(tabs[0].id);
    history.mockImplementation(async (conversationId, type) => ({ ok: true, conversationId, result: type === 'list' ? { running: true } : ['files', 'comparison'].includes(type) ? { files: [] } : {} }));
    viewers.open('one', version); await flush();
    expect(find(tabs[0].content, 'Restore…').disabled).toBe(true);
  });

  test('external repository commits are viewable without a restore action', async () => {
    history.mockImplementation(async (conversationId, type) => ({ ok: true, conversationId,
      result: type === 'list' ? { restorable: false, source: 'repository' } : ['files', 'comparison'].includes(type) ? { files: [] } : {} }));
    viewers.open('one', { ...version, source: 'repository' }); await flush();
    expect(find(tabs[0].content, 'Restore…')).toBeUndefined();
    expect(tabs[0].content.querySelector('.workspace-viewer-caption').textContent).toContain('Read-only commit');
  });

  test('closing a tab or changing conversations discards pending reads and all viewer content', async () => {
    let resolve;
    inspect.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    viewers.open('one'); const content = tabs[0].content;
    viewers.setConversation('two');
    expect(closeTab).toHaveBeenCalledTimes(1); expect(content.parentNode).toBeNull();
    resolve({ ok: true, conversationId: 'one', result: { available: true, changes: [{ path: 'old', status: 'added' }] } }); await flush();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(content.querySelector('.workspace-viewer-file')).toBeNull();
    expect(() => viewers.open('one')).toThrow('unavailable');
  });
});
