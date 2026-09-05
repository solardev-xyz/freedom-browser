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
