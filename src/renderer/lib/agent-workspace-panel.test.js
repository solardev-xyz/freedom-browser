const { createDocument, createElement } = require('../../../test/helpers/fake-dom');
const mockViewers = { open: jest.fn(), setConversation: jest.fn() };
jest.mock('./workspace-viewers', () => ({ createWorkspaceViewers: () => mockViewers }));
const { createWorkspaceInspector } = require('./agent-workspace-panel');
const flush = async () => { for (let n = 0; n < 16; n += 1) await Promise.resolve(); };
const find = (root, text) => root.querySelectorAll('.agent-text-button, .agent-workspace-item').find((node) => node.textContent === text);
const popup = () => document.querySelector('.agent-workspace-popover');
const checkpoint = { id: 'a'.repeat(40), label: 'Working game', createdAt: 1000, reviewed: true };

describe('workspace summary and popovers', () => {
  let panel, compact, refreshControl, inspector, api, historyApi;
  const start = async () => { inspector.setWorkspace('one'); jest.advanceTimersByTime(250); await flush(); };
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks();
    panel = createElement('div'); compact = createElement('div'); refreshControl = createElement('button');
    global.document = createDocument({ elementsById: { panel, compact } });
    api = jest.fn(async (conversationId) => ({ ok: true, conversationId, result: { available: true, changes: [] } }));
    historyApi = jest.fn(async (conversationId) => ({ ok: true, conversationId, result: { versions: [checkpoint] } }));
    global.window = { addEventListener: jest.fn(), innerWidth: 1000, innerHeight: 700, electronAPI: { inspectAgentWorkspace: api, agentWorkspaceHistory: historyApi } };
    inspector = createWorkspaceInspector([panel, compact], {}, { compactHost: compact, refreshControl });
  });
  afterEach(() => { inspector.setWorkspace(null); jest.useRealTimers(); delete global.document; delete global.window; });

  test('shows only two summary rows with no file tree, checkpoint list or redundant subtitle', async () => {
    await start();
    for (const host of [panel, compact]) {
      expect(host.querySelectorAll('.agent-workspace-summary')).toHaveLength(2);
      expect(host.querySelector('.agent-workspace-checkpoint')).toBeNull();
      expect(host.querySelector('.agent-workspace-baseline')).toBeNull();
      expect(host.querySelector('.agent-workspace-inspector-tab')).toBeNull();
      expect(host.querySelectorAll('.agent-workspace-summary')[0].children[1].textContent).toBe('0 files');
      expect(host.querySelectorAll('.agent-workspace-summary')[1].children[1].textContent).toBe('1');
    }
    expect(api).toHaveBeenCalledWith('one', 'changes', '.', false);
    expect(api).toHaveBeenCalledTimes(1);
    expect(compact.querySelector('.agent-workspace-inspector-heading')).toBeNull();
    expect(panel.querySelector('.agent-workspace-refresh')).not.toBeNull();
  });

  test('refreshes directly from either header without opening or collapsing content', async () => {
    await start();
    expect(refreshControl.hidden).toBe(false);
    refreshControl.dispatch('click');
    expect(refreshControl.disabled).toBe(true);
    await flush();
    expect(api).toHaveBeenCalledTimes(2);
    expect(historyApi).toHaveBeenCalledTimes(2);
    expect(popup()).toBeNull();
    expect(refreshControl.disabled).toBe(false);
    panel.querySelector('.agent-workspace-refresh').dispatch('click');
    await flush();
    expect(api).toHaveBeenCalledTimes(3);
    inspector.setWorkspace(null);
    expect(refreshControl.hidden).toBe(true);
  });

  test('opens changes as a viewer and checkpoints as a non-modal anchored list', async () => {
    await start();
    panel.querySelectorAll('.agent-workspace-summary')[0].dispatch('click');
    expect(mockViewers.open).toHaveBeenCalledWith('one', null, expect.any(Function));
    compact.querySelectorAll('.agent-workspace-summary')[1].dispatch('click');
    expect(popup().attributes['aria-modal']).toBeUndefined();
    expect(popup().attributes['aria-label']).toBe('Checkpoints');
    expect(popup().querySelectorAll('.agent-workspace-checkpoint')).toHaveLength(1);
    popup().querySelector('.agent-workspace-checkpoint').dispatch('click');
    expect(mockViewers.open).toHaveBeenLastCalledWith('one', checkpoint, expect.any(Function));
    expect(popup()).toBeNull();
  });

  test('preserves contextual exclusions behind settings', async () => {
    let exclusions = [];
    historyApi.mockImplementation(async (conversationId, action, options = {}) => {
      if (action === 'exclude') exclusions = [options];
      if (action === 'include') exclusions = [];
      return { ok: true, conversationId, result: { versions: [checkpoint], exclusions } };
    });
    await start(); panel.querySelectorAll('.agent-workspace-summary')[1].dispatch('click');
    find(popup(), 'Checkpoint settings').dispatch('click');
    const form = popup().querySelector('.agent-workspace-version-save');
    form.children[0].value = 'private.csv'; form.children[1].value = 'Private data'; form.children[2].dispatch('click'); await flush();
    expect(historyApi).toHaveBeenCalledWith('one', 'exclude', { path: 'private.csv', reason: 'Private data' });
    find(popup(), 'Allow review').dispatch('click'); await flush();
    expect(historyApi).toHaveBeenCalledWith('one', 'include', expect.objectContaining({ path: 'private.csv' }));
    expect(historyApi.mock.calls.some((args) => args[1] === 'save')).toBe(false);
  });

  test('dismisses popovers on Escape and clears conversation-owned viewers on switch', async () => {
    await start(); panel.querySelectorAll('.agent-workspace-summary')[1].dispatch('click');
    const event = { key: 'Escape', preventDefault: jest.fn(), stopImmediatePropagation: jest.fn() };
    document.handlers.keydown(event);
    expect(popup()).toBeNull(); expect(event.stopImmediatePropagation).toHaveBeenCalled();
    inspector.setWorkspace('two');
    expect(mockViewers.setConversation).toHaveBeenLastCalledWith('two');
  });

  test('does not turn failed inspection into a clean zero', async () => {
    api.mockResolvedValue({ ok: false }); await start();
    expect(panel.querySelectorAll('.agent-workspace-summary')[0].children[1].textContent).toBe('Unavailable');
  });

  test.each([false, true])('counts available checkpoints with a history notice (limit reached: %s)', async (limitReached) => {
    const notice = 'Only explicitly reviewed file versions are checkpointed. Later edits and unselected files remain outside saved history.';
    historyApi.mockImplementation(async (conversationId) => ({ ok: true, conversationId, result: { versions: [checkpoint], notice, limitReached } }));
    await start();
    for (const host of [panel, compact]) {
      expect(host.querySelectorAll('.agent-workspace-summary')[1].children[1].textContent).toBe(limitReached ? '1+' : '1');
    }
    panel.querySelectorAll('.agent-workspace-summary')[1].dispatch('click');
    expect(popup().querySelectorAll('.agent-workspace-checkpoint')).toHaveLength(1);
    if (!limitReached) expect(popup().querySelector('.agent-workspace-note').textContent).toBe(notice);
  });

  test('distinguishes a failed history request from an available empty history and recovers', async () => {
    historyApi.mockRejectedValueOnce(new Error('History busy'));
    await start();
    expect(panel.querySelectorAll('.agent-workspace-summary')[1].children[1].textContent).toBe('Unavailable');
    panel.querySelectorAll('.agent-workspace-summary')[1].dispatch('click');
    expect(popup().querySelector('.agent-workspace-note').textContent).toBe('Checkpoints could not be refreshed. Try again.');
    historyApi.mockImplementation(async (conversationId) => ({ ok: true, conversationId, result: { versions: [], notice: 'Later edits remain outside saved history.' } }));
    await start();
    expect(panel.querySelectorAll('.agent-workspace-summary')[1].children[1].textContent).toBe('0');
  });
});
