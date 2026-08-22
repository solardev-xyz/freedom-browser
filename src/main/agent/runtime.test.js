'use strict';

jest.mock('./freedom-agent-service');
jest.mock('./ipc');
jest.mock('./provider-resolver');
jest.mock('./provider-store');

const { FreedomAgentService } = require('./freedom-agent-service');
const { registerFreedomAgentIpc } = require('./ipc');
const { AgentProviderResolver } = require('./provider-resolver');
const { AgentProviderStore } = require('./provider-store');
const { createFreedomAgentRuntime } = require('./runtime');

describe('Freedom agent runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('composes one profile-bound runtime and disposes IPC before the service', async () => {
    const calls = [];
    const providerStore = {};
    const providerResolver = { resolveModel: jest.fn(async () => ({ model: {} })) };
    const service = { dispose: jest.fn(async () => calls.push('service')) };
    const unregisterIpc = jest.fn(async () => calls.push('ipc'));
    AgentProviderStore.mockImplementation(() => providerStore);
    AgentProviderResolver.mockImplementation(() => providerResolver);
    FreedomAgentService.mockImplementation(() => service);
    registerFreedomAgentIpc.mockReturnValue(unregisterIpc);
    const options = {
      ipcMain: {},
      safeStorage: {},
      profile: { id: 'work', userDataDir: '/profiles/work' },
      dataDir: '/profiles/work/agent',
      controller: {},
      automationTabIdForRenderer: jest.fn(),
      isTrustedSender: jest.fn(),
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
    expect(FreedomAgentService).toHaveBeenCalledWith({ controller: options.controller });
    expect(registerFreedomAgentIpc).toHaveBeenCalledWith({
      ipcMain: options.ipcMain,
      service,
      providerResolver,
      resolveModel: expect.any(Function),
      automationTabIdForRenderer: options.automationTabIdForRenderer,
      isTrustedSender: options.isTrustedSender,
    });

    const resolveModel = registerFreedomAgentIpc.mock.calls[0][0].resolveModel;
    await expect(resolveModel()).resolves.toEqual({ model: {} });
    await runtime.dispose();

    expect(unregisterIpc).toHaveBeenCalledTimes(1);
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['ipc', 'service']);
  });
});
