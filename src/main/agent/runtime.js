'use strict';

const { FreedomAgentService } = require('./freedom-agent-service');
const { registerFreedomAgentIpc } = require('./ipc');
const { AgentProviderResolver } = require('./provider-resolver');
const { AgentProviderStore } = require('./provider-store');
const { AgentSessionHistoryStore } = require('./session-history-store');

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
  const service = new FreedomAgentService({
    controller: options.controller,
    subscribeTabLifecycle: options.subscribeTabLifecycle,
    historyStore,
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
  });

  return {
    providerStore,
    providerResolver,
    historyStore,
    service,
    async dispose() {
      await unregisterIpc();
      await service.dispose();
      historyStore.close();
    },
  };
}

module.exports = { createFreedomAgentRuntime };
