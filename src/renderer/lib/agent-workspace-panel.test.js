const { createDocument, createElement } = require('../../../test/helpers/fake-dom');
const { createWorkspaceInspector } = require('./agent-workspace-panel');

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

// The fake DOM intentionally implements only class selectors.
const rows = (root) => root.querySelectorAll('.agent-workspace-item');

describe('workspace inspector', () => {
  let panel;
  let compact;
  let inspector;
  let api;
  beforeEach(() => {
    jest.useFakeTimers();
    panel = createElement('div');
    compact = createElement('div');
    global.document = createDocument({ elementsById: { panel, compact } });
    api = jest.fn(async (conversationId, kind) => ({
      ok: true,
      conversationId,
      result:
        kind === 'tree'
          ? { entries: [{ name: 'game.js', type: 'file' }] }
          : kind === 'changes'
            ? { available: true, branch: 'main', changes: [{ path: 'game.js', status: 'added' }] }
            : { text: '<script>window.compromised = true</script>' },
    }));
    global.window = { electronAPI: { inspectAgentWorkspace: api } };
    inspector = createWorkspaceInspector([panel, compact]);
  });
  afterEach(() => {
    inspector.setWorkspace(null);
    jest.useRealTimers();
    delete global.document;
    delete global.window;
  });

  test('shows files in both layouts and renders file bodies as text', async () => {
    inspector.setWorkspace('conversation_one');
    jest.advanceTimersByTime(250);
    await flush();
    expect(rows(panel)).toHaveLength(1);
    expect(rows(compact)).toHaveLength(1);
    expect(rows(panel)[0].children[1].textContent).toBe('game.js');
    rows(compact)[0].dispatch('click');
    await flush();
    expect(document.querySelector('.agent-workspace-file-content').textContent).toContain(
      '<script>'
    );
    expect(window.compromised).toBeUndefined();
    expect(api).toHaveBeenLastCalledWith('conversation_one', 'file', 'game.js', false);
  });

  test('drops stale files and viewers when changing conversations', async () => {
    let resolve;
    api.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    inspector.setWorkspace('conversation_one');
    jest.advanceTimersByTime(250);
    await flush();
    inspector.setWorkspace('conversation_two');
    resolve({
      ok: true,
      conversationId: 'conversation_one',
      result: { entries: [{ name: 'secret-old', type: 'file' }] },
    });
    await flush();
    expect(rows(panel)).toHaveLength(0);
    jest.advanceTimersByTime(250);
    await flush();
    rows(panel)[0].dispatch('click');
    await flush();
    expect(document.querySelector('.agent-workspace-viewer')).not.toBeNull();
    inspector.setWorkspace(null);
    expect(panel.hidden).toBe(true);
    expect(document.querySelector('.agent-workspace-viewer')).toBeNull();
  });

  test('requires a reviewed restore token and exposes named versions without invoking the model', async () => {
    const version = {
      id: 'a'.repeat(40),
      label: 'Working game',
      kind: 'manual',
      fileCount: 1,
      createdAt: 1000,
    };
    const historyApi = jest.fn(async (conversationId, action) => ({
      ok: true,
      conversationId,
      result:
        action === 'list'
          ? { versions: [version] }
          : action === 'prepare_restore'
            ? {
                token: 'restore_' + 'b'.repeat(32),
                changes: [{ path: 'game.js', action: 'write' }],
              }
            : { saved: true },
    }));
    window.electronAPI.agentWorkspaceHistory = historyApi;
    inspector.setWorkspace('conversation_one');
    jest.advanceTimersByTime(250);
    await flush();
    panel.querySelectorAll('.agent-workspace-inspector-tab')[2].dispatch('click');
    await flush();
    const form = panel.querySelector('.agent-workspace-version-save');
    form.children[0].value = 'Before adding enemies';
    form.children[1].dispatch('click');
    await flush();
    expect(historyApi).toHaveBeenCalledWith('conversation_one', 'save', {
      label: 'Before adding enemies',
    });
    panel.querySelector('.agent-workspace-version').children[2].dispatch('click');
    await flush();
    expect(historyApi).toHaveBeenCalledWith('conversation_one', 'prepare_restore', {
      versionId: version.id,
    });
    expect(historyApi.mock.calls.some((call) => call[1] === 'restore')).toBe(false);
    document.querySelector('.agent-workspace-restore-confirm').dispatch('click');
    await flush();
    expect(historyApi).toHaveBeenCalledWith('conversation_one', 'restore', {
      token: 'restore_' + 'b'.repeat(32),
    });
  });

  test('lets the user add and remove contextual exclusions without approving file contents', async () => {
    let exclusions = [];
    const historyApi = jest.fn(async (conversationId, action, options = {}) => {
      if (action === 'exclude') exclusions = [{ path: options.path, reason: options.reason }];
      if (action === 'include') exclusions = [];
      return { ok: true, conversationId, result: { versions: [], exclusions } };
    });
    window.electronAPI.agentWorkspaceHistory = historyApi;
    inspector.setWorkspace('conversation_one');
    jest.advanceTimersByTime(250); await flush();
    panel.querySelectorAll('.agent-workspace-inspector-tab')[2].dispatch('click'); await flush();
    const form = panel.querySelector('.agent-workspace-exclusion-editor').querySelector('.agent-workspace-version-save');
    form.children[0].value = 'customer-export.csv'; form.children[1].value = 'Private customer data';
    form.children[2].dispatch('click'); await flush();
    expect(historyApi).toHaveBeenCalledWith('conversation_one', 'exclude', { path: 'customer-export.csv', reason: 'Private customer data' });
    panel.querySelector('.agent-workspace-version').children[1].dispatch('click'); await flush();
    expect(historyApi).toHaveBeenCalledWith('conversation_one', 'include', expect.objectContaining({ path: 'customer-export.csv' }));
    expect(historyApi.mock.calls.some((call) => ['save', 'restore', 'checkpoint'].includes(call[1]))).toBe(false);
  });

  test('keeps files visible and reports unavailable change inspection', async () => {
    api.mockImplementation(async (conversationId, kind) => ({
      ok: true,
      conversationId,
      result:
        kind === 'tree'
          ? { entries: [{ name: 'game.js', type: 'file' }] }
          : { available: false, message: 'Git unavailable' },
    }));
    inspector.setWorkspace('conversation_one');
    jest.advanceTimersByTime(250);
    await flush();
    expect(rows(panel)).toHaveLength(1);
    panel.querySelectorAll('.agent-workspace-inspector-tab')[1].dispatch('click');
    expect(panel.querySelector('.agent-workspace-note').textContent).toBe('Git unavailable');
  });
});
