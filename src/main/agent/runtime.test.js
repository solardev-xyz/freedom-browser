'use strict';

jest.mock('./freedom-agent-service');
jest.mock('./ipc');
jest.mock('./provider-resolver');
jest.mock('./provider-store');
jest.mock('./session-history-store');
jest.mock('./agent-wallet-controller');
jest.mock('../node-status-controller');
jest.mock('../node-diagnostics-controller');

const { FreedomAgentService } = require('./freedom-agent-service');
const { registerFreedomAgentIpc } = require('./ipc');
const { AgentProviderResolver } = require('./provider-resolver');
const { AgentProviderStore } = require('./provider-store');
const { AgentSessionHistoryStore } = require('./session-history-store');
const { AgentWalletController } = require('./agent-wallet-controller');
const { NodeStatusController } = require('../node-status-controller');
const { NodeDiagnosticsController } = require('../node-diagnostics-controller');
const { createFreedomAgentRuntime } = require('./runtime');

describe('Freedom agent runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('composes one profile-bound runtime and disposes IPC before the service', async () => {
    const calls = [];
    const providerStore = {};
    const providerResolver = { resolveModel: jest.fn(async () => ({ model: {} })) };
    const historyStore = {
      markStaleRunningAsInterrupted: jest.fn(),
      close: jest.fn(() => calls.push('history')),
    };
    const service = { dispose: jest.fn(async () => calls.push('service')) };
    const walletController = {};
    const nodeController = {};
    const diagnosticsController = {};
    const unregisterIpc = jest.fn(async () => calls.push('ipc'));
    AgentProviderStore.mockImplementation(() => providerStore);
    AgentProviderResolver.mockImplementation(() => providerResolver);
    AgentSessionHistoryStore.mockImplementation(() => historyStore);
    AgentWalletController.mockImplementation(() => walletController);
    NodeStatusController.mockImplementation(() => nodeController);
    NodeDiagnosticsController.mockImplementation(() => diagnosticsController);
    FreedomAgentService.mockImplementation(() => service);
    registerFreedomAgentIpc.mockReturnValue(unregisterIpc);
    const options = {
      ipcMain: {},
      safeStorage: {},
      profile: { id: 'work', userDataDir: '/profiles/work' },
      dataDir: '/profiles/work/agent',
      controller: {
        setWalletController: jest.fn(),
        setWalletTransferController: jest.fn(),
        setNodeController: jest.fn(),
        setDiagnosticsController: jest.fn(),
      },
      automationTabIdForRenderer: jest.fn(),
      desktopBindingForAutomationTab: jest.fn(),
      createAutomationPageForHost: jest.fn(),
      subscribeTabLifecycle: jest.fn(() => jest.fn()),
      isTrustedSender: jest.fn(),
      openExternal: jest.fn(),
      walletControllerOptions: { requestTimeoutMs: 250 },
      nodeControllerOptions: { fixture: true },
      nodeDiagnosticsControllerOptions: { logBuffer: {} },
    };

    const runtime = createFreedomAgentRuntime(options);

    expect(AgentProviderStore).toHaveBeenCalledWith({
      safeStorage: options.safeStorage,
      dataDir: options.dataDir,
      userDataDir: options.profile.userDataDir,
      profileId: options.profile.id,
    });
    expect(AgentProviderResolver).toHaveBeenCalledWith({
      store: providerStore,
      dataDir: options.dataDir,
    });
    expect(AgentSessionHistoryStore).toHaveBeenCalledWith({
      userDataDir: options.profile.userDataDir,
    });
    expect(historyStore.markStaleRunningAsInterrupted).toHaveBeenCalledTimes(1);
    expect(AgentWalletController).toHaveBeenCalledWith(options.walletControllerOptions);
    expect(NodeStatusController).toHaveBeenCalledWith(options.nodeControllerOptions);
    expect(NodeDiagnosticsController).toHaveBeenCalledWith({
      nodeStatusController: nodeController,
      ...options.nodeDiagnosticsControllerOptions,
    });
    expect(options.controller.setWalletTransferController).toHaveBeenCalledWith(walletController);
    expect(options.controller.setNodeController).toHaveBeenCalledWith(nodeController);
    expect(options.controller.setDiagnosticsController).toHaveBeenCalledWith(
      diagnosticsController
    );
    expect(FreedomAgentService).toHaveBeenCalledWith({
      controller: options.controller,
      subscribeTabLifecycle: options.subscribeTabLifecycle,
      historyStore,
      cancelAgentDownloads: undefined,
      walletController,
    });
    expect(registerFreedomAgentIpc).toHaveBeenCalledWith({
      ipcMain: options.ipcMain,
      service,
      providerResolver,
      resolveModel: expect.any(Function),
      automationTabIdForRenderer: options.automationTabIdForRenderer,
      desktopBindingForAutomationTab: options.desktopBindingForAutomationTab,
      createAutomationPageForHost: options.createAutomationPageForHost,
      isTrustedSender: options.isTrustedSender,
      openExternal: options.openExternal,
    });

    const resolveModel = registerFreedomAgentIpc.mock.calls[0][0].resolveModel;
    await expect(resolveModel()).resolves.toEqual({ model: {} });
    await runtime.dispose();

    expect(options.controller.setWalletController).not.toHaveBeenCalled();

    expect(unregisterIpc).toHaveBeenCalledTimes(1);
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(historyStore.close).toHaveBeenCalledTimes(1);
    expect(options.controller.setWalletTransferController).toHaveBeenLastCalledWith(null);
    expect(options.controller.setNodeController).toHaveBeenLastCalledWith(null);
    expect(options.controller.setDiagnosticsController).toHaveBeenLastCalledWith(null);
    expect(calls).toEqual(['ipc', 'service', 'history']);
  });
});
