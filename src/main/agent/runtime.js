'use strict';

const { FreedomAgentService } = require('./freedom-agent-service');
const { registerFreedomAgentIpc } = require('./ipc');
const { AgentProviderResolver } = require('./provider-resolver');
const { AgentProviderStore } = require('./provider-store');
const { AgentSessionHistoryStore } = require('./session-history-store');
const { AgentWalletController } = require('./agent-wallet-controller');

function createFreedomAgentRuntime(options = {}) {
  const providerStore = new AgentProviderStore({
    safeStorage: options.safeStorage,
    dataDir: options.dataDir,
    userDataDir: options.profile?.userDataDir,
    profileId: options.profile?.id,
  });
  const providerResolver = new AgentProviderResolver({
    store: providerStore,
    dataDir: options.dataDir,
  });
  const historyStore = new AgentSessionHistoryStore({
    userDataDir: options.profile?.userDataDir,
  });
  historyStore.markStaleRunningAsInterrupted();
  const walletController = new AgentWalletController();
  options.controller.setWalletController(walletController);
  const service = new FreedomAgentService({
    controller: options.controller,
    subscribeTabLifecycle: options.subscribeTabLifecycle,
    historyStore,
    cancelAgentDownloads: options.cancelAgentDownloads,
  });
  const unregisterIpc = registerFreedomAgentIpc({
    ipcMain: options.ipcMain,
    service,
    providerResolver,
    resolveModel: () => providerResolver.resolveModel(),
    automationTabIdForRenderer: options.automationTabIdForRenderer,
    createAutomationPageForHost: options.createAutomationPageForHost,
    desktopBindingForAutomationTab: options.desktopBindingForAutomationTab,
    isTrustedSender: options.isTrustedSender,
    openExternal: options.openExternal,
    walletController,
  });

  return {
    providerStore,
    providerResolver,
    historyStore,
    walletController,
    service,
    async dispose() {
      await unregisterIpc();
      options.controller.setWalletController(null);
      await service.dispose();
      historyStore.close();
    },
  };
}

module.exports = { createFreedomAgentRuntime };
