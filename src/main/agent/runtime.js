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
const { ConversationAttachmentStore } = require('./conversation-attachment-store');
const { SwarmPublicationController } = require('./swarm-publication-controller');
const { PdfProcessor } = require('./pdf-processor');
const { AgentManagedWorkspaceStore } = require('./managed-workspace-store');
const { ManagedWorkspaceController } = require('./managed-workspace-controller');
const { ManagedWorkspaceSourceReader } = require('./managed-workspace-source-reader');
const { WorkspacePreviewController } = require('./workspace-preview-controller');

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
  const pdfProcessor = new PdfProcessor({
    BrowserWindow: options.BrowserWindow,
    ipcMain: options.ipcMain,
  });
  const attachmentStore = new ConversationAttachmentStore({
    userDataDir: options.profile?.userDataDir,
    dialog: options.dialog,
    pdfProcessor,
  });
  const nodeOperationStore = new AgentNodeOperationStore({
    userDataDir: options.profile?.userDataDir,
  });
  nodeOperationStore.markStaleInFlightAsUncertain();
  const workspaceStore = new AgentManagedWorkspaceStore({
    userDataDir: options.profile?.userDataDir,
  });
  workspaceStore.markStaleRunningAsInterrupted();
  const workspaceController = new ManagedWorkspaceController({
    store: workspaceStore,
    runtimeOptions: options.workspaceRuntimeOptions,
    networkPermissionsEnabled: options.workspaceNetworkPermissionsEnabled === true,
  });
  const workspaceSourceReader = new ManagedWorkspaceSourceReader({ workspaceController });
  const workspacePreviewController = new WorkspacePreviewController({ workspaceController });
  if (options.protocolSession) workspacePreviewController.register(options.protocolSession);
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
  const publicationController = new SwarmPublicationController({
    attachmentStore,
    workspaceSourceReader,
    ...options.swarmPublicationControllerOptions,
  });
  options.controller.setWalletTransferController(walletController);
  options.controller.setNodeController(nodeController);
  options.controller.setNodeRequestController(nodeRequestController);
  options.controller.setNodeLifecycleController(nodeLifecycleController);
  options.controller.setDiagnosticsController(diagnosticsController);
  options.controller.setPublicationController(publicationController);
  const service = new FreedomAgentService({
    controller: options.controller,
    subscribeTabLifecycle: options.subscribeTabLifecycle,
    historyStore,
    cancelAgentDownloads: options.cancelAgentDownloads,
    walletController,
    attachmentStore,
    workspaceController,
    workspacePreviewController,
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
    attachmentStore,
    getOwnerWindow: options.getOwnerWindow,
  });

  return {
    providerStore,
    providerResolver,
    historyStore,
    attachmentStore,
    nodeOperationStore,
    workspaceStore,
    workspaceController,
    workspaceSourceReader,
    workspacePreviewController,
    walletController,
    nodeController,
    nodeRequestController,
    nodeLifecycleController,
    diagnosticsController,
    publicationController,
    service,
    async dispose() {
      await unregisterIpc();
      await service.dispose();
      await nodeRequestController.dispose();
      publicationController.dispose();
      await workspacePreviewController.dispose();
      workspaceController.dispose();
      attachmentStore.dispose();
      pdfProcessor.dispose();
      historyStore.close();
      nodeOperationStore.close();
      workspaceStore.close();
      options.controller.setWalletTransferController(null);
      options.controller.setNodeController(null);
      options.controller.setNodeRequestController(null);
      options.controller.setNodeLifecycleController(null);
      options.controller.setDiagnosticsController(null);
      options.controller.setPublicationController(null);
    },
  };
}

module.exports = { createFreedomAgentRuntime };
