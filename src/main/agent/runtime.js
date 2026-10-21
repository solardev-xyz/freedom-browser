'use strict';

const { McpConnectionManager } = require('./mcp-connections');

const { FreedomAgentService } = require('./freedom-agent-service');
const { registerFreedomAgentIpc, registerUnavailableAgentIpc } = require('./ipc');
const log = require('../logger');
const { loadSettings, onSettingsChanged } = require('../settings-store');
const { isSenderAllowed } = require('../ipc-sender-policy');
const { isPrivateWebContents } = require('../private/private-windows');
const { broadcastToAllWebContents } = require('../lib/broadcast-to-all-webcontents');
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
const { SwarmPublicationStore } = require('./swarm-publication-store');
const { SwarmPostageReadiness } = require('./swarm-postage-readiness');
const { SwarmPublicationController } = require('./swarm-publication-controller');
const { PdfProcessor } = require('./pdf-processor');
const { AgentManagedWorkspaceStore } = require('./managed-workspace-store');
const { ManagedWorkspaceController } = require('./managed-workspace-controller');
const { ManagedWorkspaceSourceReader } = require('./managed-workspace-source-reader');
const { WorkspacePreviewController } = require('./workspace-preview-controller');
const { DictationService } = require('./dictation-service');
const { LocalDictation } = require('./dictation-local');
const { registerDictationIpc } = require('./dictation-ipc');

function createFreedomAgentRuntime(options = {}) {
  let featureController = new AbortController();
  const isEnabled = () => loadSettings().enableAi === true;
  const isProviderSettingsSender = event => !isPrivateWebContents(event?.sender) && isSenderAllowed('agent:provider:get-status', event);
  const assertEnabled = () => {
    if (!isEnabled()) throw Object.assign(new Error('AI is disabled'), { code: 'AGENT_DISABLED' });
  };
  const guardedFetch = (url, init = {}) => {
    assertEnabled();
    return fetch(url, { ...init, signal: init.signal
      ? AbortSignal.any([init.signal, featureController.signal]) : featureController.signal });
  };
  const providerStore = new AgentProviderStore({
    safeStorage: options.safeStorage,
    dataDir: options.dataDir,
    userDataDir: options.profile?.userDataDir,
    profileId: options.profile?.id,
  });
  const providerResolver = new AgentProviderResolver({
    store: providerStore,
    dataDir: options.dataDir,
    fetch: guardedFetch,
    assertEnabled,
    featureSignal: () => featureController.signal,
  });
  let historyStore;
  let nodeOperationStore;
  let workspaceStore;
  let publicationStore;
  try {
    // Reconcile persistent state before installing controllers or IPC listeners.
    // Agent storage failure must not prevent ordinary browser startup.
    historyStore = new AgentSessionHistoryStore({ userDataDir: options.profile?.userDataDir });
    nodeOperationStore = new AgentNodeOperationStore({ userDataDir: options.profile?.userDataDir });
    workspaceStore = new AgentManagedWorkspaceStore({ userDataDir: options.profile?.userDataDir });
    publicationStore = new SwarmPublicationStore(options.profile?.userDataDir);
    historyStore.markStaleRunningAsInterrupted();
    nodeOperationStore.markStaleInFlightAsUncertain();
    workspaceStore.markStaleRunningAsInterrupted();
  } catch (error) {
    log.error('[Agent] Storage initialization failed:', error?.code || 'AGENT_STORAGE_INIT_FAILED');
    for (const store of [workspaceStore, nodeOperationStore, historyStore]) {
      try { store?.close(); } catch { log.warn('[Agent] Could not close an unavailable store'); }
    }
    const unregisterIpc = registerUnavailableAgentIpc({ ...options, isProviderSettingsSender });
    return { unavailable: true, dispose: async () => unregisterIpc() };
  }
  const dictation = new DictationService({ dataDir: options.dataDir, providerStore,
    local: new LocalDictation({ dataDir: options.dataDir, fetch: guardedFetch }), fetch: guardedFetch, assertEnabled,
    onEvent: (sender, event) => {
      try { if (!sender.isDestroyed?.()) sender.send('agent:dictation:event', event); }
      catch { /* A closing renderer must not prevent microphone revocation. */ }
    } });
  const unregisterDictation = registerDictationIpc({ ipcMain: options.ipcMain, service: dictation,
    isTrustedSender: options.isTrustedSender, isSettingsSender: isProviderSettingsSender, isEnabled });
  const pdfProcessor = new PdfProcessor({
    BrowserWindow: options.BrowserWindow,
    ipcMain: options.ipcMain,
  });
  const attachmentStore = new ConversationAttachmentStore({
    userDataDir: options.profile?.userDataDir,
    dialog: options.dialog,
    pdfProcessor,
  });
  const workspaceController = new ManagedWorkspaceController({
    store: workspaceStore,
    runtimeOptions: options.workspaceRuntimeOptions,
    networkPermissionsEnabled: options.workspaceNetworkPermissionsEnabled !== false,
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
    store: publicationStore,
    postageReadiness: new SwarmPostageReadiness({ operationStore: nodeOperationStore }),
    ...options.swarmPublicationControllerOptions,
  });
  options.controller.setWalletTransferController(walletController);
  options.controller.setNodeController(nodeController);
  options.controller.setNodeRequestController(nodeRequestController);
  options.controller.setNodeLifecycleController(nodeLifecycleController);
  options.controller.setDiagnosticsController(diagnosticsController);
  options.controller.setPublicationController(publicationController);
  const mcpConnections = new McpConnectionManager({ dataDir: options.dataDir,
    safeStorage: options.safeStorage, openExternal: options.openExternal, fetch: guardedFetch });
  const service = new FreedomAgentService({
    mcpConnections,
    controller: options.controller,
    subscribeTabLifecycle: options.subscribeTabLifecycle,
    historyStore,
    nodeOperationStore,
    publicationController,
    cancelAgentDownloads: options.cancelAgentDownloads,
    walletController,
    attachmentStore,
    workspaceController,
    workspacePreviewController,
  });
  const unregisterIpc = registerFreedomAgentIpc({
    ipcMain: options.ipcMain,
    mcpConnections,
    service,
    providerResolver,
    resolveModel: selection => providerResolver.resolveModel(selection),
    previewPageTools: (tabId) => options.controller.previewPageTools(tabId),
    automationTabIdForRenderer: options.automationTabIdForRenderer,
    createAutomationPageForHost: options.createAutomationPageForHost,
    desktopBindingForAutomationTab: options.desktopBindingForAutomationTab,
    isTrustedSender: options.isTrustedSender,
    isEnabled,
    isProviderSettingsSender,
    onProviderChanged: () => {
      dictation.connectionsChanged();
      broadcastToAllWebContents('agent:provider:changed', {});
    },
    onEnabledChanged: listener => onSettingsChanged((next, previous) => {
      if (next.enableAi === previous.enableAi) return;
      featureController.abort();
      featureController = new AbortController();
      dictation.cancelAll();
      listener(next.enableAi === true);
      if (next.enableAi !== true) {
        // Commands can outlive a model turn, including in other saved chats.
        try { workspaceController.cancelAllConversations({ preserveServers: true }); }
        catch { log.warn('[Agent] Background command cleanup did not complete'); }
        for (const id of mcpConnections.logins.keys()) {
          void mcpConnections.cancelSignIn(id).catch(() => {});
        }
      }
    }),
    openExternal: options.openExternal,
    attachmentStore,
    getOwnerWindow: options.getOwnerWindow,
    dialog: options.dialog,
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
    dictation,
    async dispose() {
      const dictationShutdown = unregisterDictation();
      await unregisterIpc();
      await dictationShutdown;
      await mcpConnections.dispose();
      await service.dispose();
      await nodeRequestController.dispose();
      publicationController.dispose();
      await workspacePreviewController.dispose();
      await workspaceController.dispose();
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
