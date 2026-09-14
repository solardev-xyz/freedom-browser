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
      ? { available: true, changes: [{ path: 'game.js', status: 'modified' }] } : { text: '+<script>untrusted</script>' } }));
    history = jest.fn(async (conversationId, type) => ({ ok: true, conversationId, result: type === 'list' ? { versions: [version], running: false }
      : type === 'files' ? { files: [{ path: 'game.js' }] } : type === 'file' ? { text: '<script>untrusted</script>' }
        : type === 'prepare_restore' ? { token: 'plan_one', changes: [{ path: 'game.js', action: 'write' }] } : { restored: true } }));
    global.window = { electronAPI: { inspectAgentWorkspace: inspect, agentWorkspaceHistory: history } };
    tabs = [];
    openTab = jest.fn((options) => { const old = tabs.find((tab) => tab.key === options.key); if (old) return old; const tab = { ...options, id: tabs.length + 1 }; tabs.push(tab); document.body.appendChild(tab.content); return tab; });
    closeTab = jest.fn((id) => { const tab = tabs.find((entry) => entry.id === id); tab.onClose(); tab.content.remove(); tabs = tabs.filter((entry) => entry !== tab); });
    viewers = createWorkspaceViewers({ openTab, closeTab }); viewers.setConversation('one');
  });
  afterEach(() => { viewers.setConversation(null); delete global.document; delete global.window; });

  test('opens separate reusable Changes and checkpoint tabs and renders code only as text', async () => {
    viewers.open('one'); viewers.open('one', version); await flush();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].content.querySelector('.workspace-viewer-code').children[0].textContent).toContain('<script>');
    expect(tabs[1].content.querySelector('.workspace-viewer-code').children[0].textContent).toContain('<script>');
    expect(tabs[1].content.querySelector('.workspace-viewer-code').attributes.contenteditable).toBeUndefined();
    expect(history).toHaveBeenCalledWith('one', 'file', { versionId: version.id, path: 'game.js' });
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
    history.mockImplementation(async (conversationId, type) => ({ ok: true, conversationId, result: type === 'list' ? { running: true } : type === 'files' ? { files: [] } : {} }));
    viewers.open('one', version); await flush();
    expect(find(tabs[0].content, 'Restore…').disabled).toBe(true);
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
