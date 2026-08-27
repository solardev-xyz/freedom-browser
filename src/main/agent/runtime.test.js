'use strict';

jest.mock('./freedom-agent-service');
jest.mock('./ipc');
jest.mock('./provider-resolver');
jest.mock('./provider-store');
jest.mock('./session-history-store');
jest.mock('./agent-wallet-controller');

const { FreedomAgentService } = require('./freedom-agent-service');
const { registerFreedomAgentIpc } = require('./ipc');
const { AgentProviderResolver } = require('./provider-resolver');
const { AgentProviderStore } = require('./provider-store');
const { AgentSessionHistoryStore } = require('./session-history-store');
const { AgentWalletController } = require('./agent-wallet-controller');
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
    const unregisterIpc = jest.fn(async () => calls.push('ipc'));
    AgentProviderStore.mockImplementation(() => providerStore);
    AgentProviderResolver.mockImplementation(() => providerResolver);
    AgentSessionHistoryStore.mockImplementation(() => historyStore);
    AgentWalletController.mockImplementation(() => walletController);
    FreedomAgentService.mockImplementation(() => service);
    registerFreedomAgentIpc.mockReturnValue(unregisterIpc);
    const options = {
      ipcMain: {},
      safeStorage: {},
      profile: { id: 'work', userDataDir: '/profiles/work' },
      dataDir: '/profiles/work/agent',
      controller: { setWalletController: jest.fn() },
      automationTabIdForRenderer: jest.fn(),
      desktopBindingForAutomationTab: jest.fn(),
      createAutomationPageForHost: jest.fn(),
      subscribeTabLifecycle: jest.fn(() => jest.fn()),
      isTrustedSender: jest.fn(),
      openExternal: jest.fn(),
      walletControllerOptions: { requestTimeoutMs: 250 },
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
    expect(FreedomAgentService).toHaveBeenCalledWith({
      controller: options.controller,
      subscribeTabLifecycle: options.subscribeTabLifecycle,
      historyStore,
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
      walletController,
    });

    const resolveModel = registerFreedomAgentIpc.mock.calls[0][0].resolveModel;
    await expect(resolveModel()).resolves.toEqual({ model: {} });
    await runtime.dispose();

    expect(options.controller.setWalletController).toHaveBeenNthCalledWith(1, walletController);
    expect(options.controller.setWalletController).toHaveBeenNthCalledWith(2, null);

    expect(unregisterIpc).toHaveBeenCalledTimes(1);
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(historyStore.close).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['ipc', 'service', 'history']);
  });
});
