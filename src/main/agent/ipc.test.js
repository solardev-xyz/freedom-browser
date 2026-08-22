'use strict';

const { EventEmitter } = require('events');
const IPC = require('../../shared/ipc-channels');
const { AGENT_ERROR_CODES, FreedomAgentError } = require('./freedom-agent-service');
const { AGENT_IPC_ERROR_CODES, registerFreedomAgentIpc } = require('./ipc');

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: jest.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: jest.fn((channel) => handlers.delete(channel)),
  };
}

function createSender() {
  const sender = new EventEmitter();
  sender.send = jest.fn();
  sender.isDestroyed = jest.fn(() => false);
  return sender;
}

function createService(options = {}) {
  let listener;
  return {
    start: options.start || jest.fn(async () => ({ runId: 'run_test' })),
    stop: options.stop || jest.fn(async () => true),
    getState: jest.fn(() => ({ status: 'running', runId: 'run_test', tabId: 'tab_bound' })),
    subscribe: jest.fn((nextListener) => {
      listener = nextListener;
      return jest.fn();
    }),
    emit: (event) => listener(event),
  };
}

function register(overrides = {}) {
  const ipcMain = createIpcMain();
  const service = overrides.service || createService();
  const sender = overrides.sender || createSender();
  const otherSender = createSender();
  const automationTabIdForRenderer = jest.fn((candidate, rendererTabId) =>
    candidate === sender && rendererTabId === 7 ? 'tab_bound' : null
  );
  const resolveModel = jest.fn(async () => ({
    model: { id: 'model_test' },
    modelRuntime: { kind: 'runtime' },
    thinkingLevel: 'low',
  }));
  const dispose = registerFreedomAgentIpc({
    ipcMain,
    service,
    automationTabIdForRenderer,
    resolveModel,
    ...overrides,
  });
  return {
    ipcMain,
    service,
    sender,
    otherSender,
    automationTabIdForRenderer,
    resolveModel,
    dispose,
  };
}

describe('Freedom agent IPC', () => {
  test('resolves a renderer tab through its exact chrome sender and keeps models in main', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await expect(
      start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Summarize this page' })
    ).resolves.toEqual({ ok: true, runId: 'run_test' });

    expect(ctx.automationTabIdForRenderer).toHaveBeenCalledWith(ctx.sender, 7);
    expect(ctx.resolveModel).toHaveBeenCalledWith();
    expect(ctx.service.start).toHaveBeenCalledWith({
      prompt: 'Summarize this page',
      tabId: 'tab_bound',
      model: { id: 'model_test' },
      modelRuntime: { kind: 'runtime' },
      thinkingLevel: 'low',
    });
  });

  test('rejects another window and an unbound tab', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await expect(
      start({ sender: ctx.otherSender }, { rendererTabId: 7, prompt: 'Task' })
    ).resolves.toEqual({
      ok: false,
      error: {
        code: AGENT_IPC_ERROR_CODES.TAB_NOT_BOUND,
        message: 'The selected browser tab is not ready for the agent',
      },
    });
    expect(ctx.resolveModel).not.toHaveBeenCalled();
    expect(ctx.service.start).not.toHaveBeenCalled();
  });

  test('buffers immediate service events and sends them only to the owning chrome', async () => {
    const service = createService();
    service.start.mockImplementation(async () => {
      service.emit({ type: 'run_started', runId: 'run_test', sequence: 1 });
      service.emit({ type: 'assistant_text_delta', runId: 'run_test', sequence: 2, text: 'Hi' });
      return { runId: 'run_test' };
    });
    const ctx = register({ service });
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    service.emit({ type: 'run_finished', runId: 'run_test', sequence: 3, status: 'completed' });

    expect(ctx.sender.send.mock.calls).toEqual([
      [IPC.AGENT_EVENT, { type: 'run_started', runId: 'run_test', sequence: 1 }],
      [
        IPC.AGENT_EVENT,
        { type: 'assistant_text_delta', runId: 'run_test', sequence: 2, text: 'Hi' },
      ],
      [IPC.AGENT_EVENT, { type: 'run_finished', runId: 'run_test', sequence: 3, status: 'completed' }],
    ]);
    expect(ctx.otherSender.send).not.toHaveBeenCalled();
  });

  test('allows only the owning sender and exact run ID to stop', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    const stop = ctx.ipcMain.handlers.get(IPC.AGENT_STOP);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await expect(stop({ sender: ctx.otherSender }, { runId: 'run_test' })).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
    await expect(stop({ sender: ctx.sender }, { runId: 'run_stale' })).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.NOT_OWNER },
    });
    await expect(stop({ sender: ctx.sender }, { runId: 'run_test' })).resolves.toEqual({
      ok: true,
      stopped: true,
    });
    expect(ctx.service.stop).toHaveBeenCalledTimes(1);
  });

  test('stops the run when its chrome renderer is destroyed', async () => {
    const ctx = register();
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);
    await start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    ctx.sender.emit('destroyed');
    await Promise.resolve();

    expect(ctx.service.stop).toHaveBeenCalledWith('run_test');
  });

  test('redacts model resolver and unexpected service failures', async () => {
    const modelFailure = register({
      resolveModel: jest.fn(async () => {
        throw new Error('sk-secret-key');
      }),
    });
    await expect(
      modelFailure.ipcMain.handlers
        .get(IPC.AGENT_START)(
          { sender: modelFailure.sender },
          { rendererTabId: 7, prompt: 'Task' }
        )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.MODEL_UNAVAILABLE },
    });

    const serviceFailure = createService({
      start: jest.fn(async () => {
        throw new Error('sk-other-secret');
      }),
    });
    const serviceContext = register({ service: serviceFailure });
    const response = await serviceContext.ipcMain.handlers
      .get(IPC.AGENT_START)(
        { sender: serviceContext.sender },
        { rendererTabId: 7, prompt: 'Task' }
      );
    expect(response).toMatchObject({
      ok: false,
      error: { code: AGENT_IPC_ERROR_CODES.INTERNAL_ERROR },
    });
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  test('preserves safe service errors and validates input', async () => {
    const service = createService({
      start: jest.fn(async () => {
        throw new FreedomAgentError(AGENT_ERROR_CODES.BUSY, 'Agent is busy');
      }),
    });
    const ctx = register({ service });
    const start = ctx.ipcMain.handlers.get(IPC.AGENT_START);

    await expect(start({ sender: ctx.sender }, null)).resolves.toMatchObject({
      ok: false,
      error: { code: AGENT_ERROR_CODES.INVALID_ARGUMENT },
    });
    await expect(
      start({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' })
    ).resolves.toEqual({ ok: false, error: { code: AGENT_ERROR_CODES.BUSY, message: 'Agent is busy' } });
  });

  test('removes handlers and stops an owned run on disposal', async () => {
    const ctx = register();
    await ctx.ipcMain.handlers
      .get(IPC.AGENT_START)({ sender: ctx.sender }, { rendererTabId: 7, prompt: 'Task' });

    await ctx.dispose();

    expect(ctx.ipcMain.handlers.size).toBe(0);
    expect(ctx.service.stop).toHaveBeenCalledWith('run_test');
  });
});
