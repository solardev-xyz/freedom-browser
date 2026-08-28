'use strict';

const { FreedomAgentService } = require('./freedom-agent-service');
const { registerFreedomAgentIpc } = require('./ipc');
const { AgentProviderResolver } = require('./provider-resolver');
const { AgentProviderStore } = require('./provider-store');
const { AgentSessionHistoryStore } = require('./session-history-store');
const { AgentNodeOperationStore } = require('./node-operation-store');
const { AgentWalletController } = require('./agent-wallet-controller');
const { NodeStatusController } = require('../node-status-controller');
const { NodeRequestController } = require('../node-request-controller');
const { NodeLifecycleController } = require('../node-lifecycle-controller');
const { NodeDiagnosticsController } = require('../node-diagnostics-controller');

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
  const nodeOperationStore = new AgentNodeOperationStore({
    userDataDir: options.profile?.userDataDir,
  });
  nodeOperationStore.markStaleInFlightAsUncertain();
  const walletController = new AgentWalletController(options.walletControllerOptions);
  const nodeController = new NodeStatusController(options.nodeControllerOptions);
  const nodeRequestController = new NodeRequestController({
    ...options.nodeRequestControllerOptions,
    operationStore: nodeOperationStore,
  });
  const nodeLifecycleController = new NodeLifecycleController({
    nodeStatusController: nodeController,
    ...options.nodeLifecycleControllerOptions,
  });
  const diagnosticsController = new NodeDiagnosticsController({
    nodeStatusController: nodeController,
    ...options.nodeDiagnosticsControllerOptions,
  });
  options.controller.setWalletTransferController(walletController);
  options.controller.setNodeController(nodeController);
  options.controller.setNodeRequestController(nodeRequestController);
  options.controller.setNodeLifecycleController(nodeLifecycleController);
  options.controller.setDiagnosticsController(diagnosticsController);
  const service = new FreedomAgentService({
    controller: options.controller,
    subscribeTabLifecycle: options.subscribeTabLifecycle,
    historyStore,
    cancelAgentDownloads: options.cancelAgentDownloads,
    walletController,
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
    nodeOperationStore,
    walletController,
    nodeController,
    nodeRequestController,
    nodeLifecycleController,
    diagnosticsController,
    service,
    async dispose() {
      await unregisterIpc();
      await service.dispose();
      await nodeRequestController.dispose();
      historyStore.close();
      nodeOperationStore.close();
      options.controller.setWalletTransferController(null);
      options.controller.setNodeController(null);
      options.controller.setNodeRequestController(null);
      options.controller.setNodeLifecycleController(null);
      options.controller.setDiagnosticsController(null);
    },
  };
}

module.exports = { createFreedomAgentRuntime };
