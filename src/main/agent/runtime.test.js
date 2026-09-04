'use strict';

jest.mock('./freedom-agent-service');
jest.mock('./ipc');
jest.mock('./provider-resolver');
jest.mock('./provider-store');
jest.mock('./session-history-store');
jest.mock('./node-operation-store');
jest.mock('./conversation-attachment-store');
jest.mock('./agent-wallet-controller');
jest.mock('../node-status-controller');
jest.mock('../node-request-controller');
jest.mock('../node-lifecycle-controller');
jest.mock('../node-diagnostics-controller');
jest.mock('./swarm-publication-controller');
jest.mock('./pdf-processor');
jest.mock('./managed-workspace-store');
jest.mock('./managed-workspace-controller');
jest.mock('./managed-workspace-source-reader');
jest.mock('./workspace-preview-controller');

const { FreedomAgentService } = require('./freedom-agent-service');
const { registerFreedomAgentIpc } = require('./ipc');
const { AgentProviderResolver } = require('./provider-resolver');
const { AgentProviderStore } = require('./provider-store');
const { AgentSessionHistoryStore } = require('./session-history-store');
const { AgentNodeOperationStore } = require('./node-operation-store');
const { ConversationAttachmentStore } = require('./conversation-attachment-store');
const { AgentWalletController } = require('./agent-wallet-controller');
const { NodeStatusController } = require('../node-status-controller');
const { NodeRequestController } = require('../node-request-controller');
const { NodeLifecycleController } = require('../node-lifecycle-controller');
const { NodeDiagnosticsController } = require('../node-diagnostics-controller');
const { SwarmPublicationController } = require('./swarm-publication-controller');
const { PdfProcessor } = require('./pdf-processor');
const { AgentManagedWorkspaceStore } = require('./managed-workspace-store');
const { ManagedWorkspaceController } = require('./managed-workspace-controller');
const { ManagedWorkspaceSourceReader } = require('./managed-workspace-source-reader');
const { WorkspacePreviewController } = require('./workspace-preview-controller');
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
    const nodeOperationStore = {
      markStaleInFlightAsUncertain: jest.fn(),
      close: jest.fn(() => calls.push('node-operations')),
    };
    const attachmentStore = {
      resolvePublicationSource: jest.fn(),
      dispose: jest.fn(() => calls.push('attachments')),
    };
    const pdfProcessor = { dispose: jest.fn(() => calls.push('pdf')) };
    const service = { dispose: jest.fn(async () => calls.push('service')) };
    const walletController = {};
    const nodeController = {};
    const nodeRequestController = { dispose: jest.fn(async () => calls.push('node-requests')) };
    const nodeLifecycleController = {};
    const diagnosticsController = {};
    const publicationController = { dispose: jest.fn(() => calls.push('publications')) };
    const workspaceStore = {
      markStaleRunningAsInterrupted: jest.fn(),
      close: jest.fn(() => calls.push('workspaces')),
    };
    const workspaceController = { dispose: jest.fn(() => calls.push('workspace-controller')) };
    const workspaceSourceReader = {};
    const workspacePreviewController = {
      dispose: jest.fn(() => calls.push('workspace-preview-controller')),
    };
    const unregisterIpc = jest.fn(async () => calls.push('ipc'));
    AgentProviderStore.mockImplementation(() => providerStore);
    AgentProviderResolver.mockImplementation(() => providerResolver);
    AgentSessionHistoryStore.mockImplementation(() => historyStore);
    AgentNodeOperationStore.mockImplementation(() => nodeOperationStore);
    ConversationAttachmentStore.mockImplementation(() => attachmentStore);
    PdfProcessor.mockImplementation(() => pdfProcessor);
    AgentWalletController.mockImplementation(() => walletController);
    NodeStatusController.mockImplementation(() => nodeController);
    NodeRequestController.mockImplementation(() => nodeRequestController);
    NodeLifecycleController.mockImplementation(() => nodeLifecycleController);
    NodeDiagnosticsController.mockImplementation(() => diagnosticsController);
    SwarmPublicationController.mockImplementation(() => publicationController);
    AgentManagedWorkspaceStore.mockImplementation(() => workspaceStore);
    ManagedWorkspaceController.mockImplementation(() => workspaceController);
    ManagedWorkspaceSourceReader.mockImplementation(() => workspaceSourceReader);
    WorkspacePreviewController.mockImplementation(() => workspacePreviewController);
    FreedomAgentService.mockImplementation(() => service);
    registerFreedomAgentIpc.mockReturnValue(unregisterIpc);
    const options = {
      BrowserWindow: jest.fn(),
      ipcMain: {},
      safeStorage: {},
      dialog: {},
      profile: { id: 'work', userDataDir: '/profiles/work' },
      dataDir: '/profiles/work/agent',
      controller: {
        setWalletController: jest.fn(),
        setWalletTransferController: jest.fn(),
        setNodeController: jest.fn(),
        setNodeRequestController: jest.fn(),
        setNodeLifecycleController: jest.fn(),
        setDiagnosticsController: jest.fn(),
        setPublicationController: jest.fn(),
      },
      automationTabIdForRenderer: jest.fn(),
      desktopBindingForAutomationTab: jest.fn(),
      createAutomationPageForHost: jest.fn(),
      subscribeTabLifecycle: jest.fn(() => jest.fn()),
      isTrustedSender: jest.fn(),
      openExternal: jest.fn(),
      getOwnerWindow: jest.fn(),
      walletControllerOptions: { requestTimeoutMs: 250 },
      nodeControllerOptions: { fixture: true },
      nodeRequestControllerOptions: { timeoutMs: 250 },
      nodeLifecycleControllerOptions: { verifyTimeoutMs: 250 },
      nodeDiagnosticsControllerOptions: { logBuffer: {} },
      workspaceRuntimeOptions: { packaged: true, freedomVersion: '0.8.1-dev' },
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
    expect(PdfProcessor).toHaveBeenCalledWith({
      BrowserWindow: options.BrowserWindow,
      ipcMain: options.ipcMain,
    });
    expect(ConversationAttachmentStore).toHaveBeenCalledWith({
      userDataDir: options.profile.userDataDir,
      dialog: options.dialog,
      pdfProcessor,
    });
    expect(AgentNodeOperationStore).toHaveBeenCalledWith({
      userDataDir: options.profile.userDataDir,
    });
    expect(nodeOperationStore.markStaleInFlightAsUncertain).toHaveBeenCalledTimes(1);
    expect(AgentManagedWorkspaceStore).toHaveBeenCalledWith({
      userDataDir: options.profile.userDataDir,
    });
    expect(workspaceStore.markStaleRunningAsInterrupted).toHaveBeenCalledTimes(1);
    expect(ManagedWorkspaceController).toHaveBeenCalledWith({
      store: workspaceStore,
      runtimeOptions: options.workspaceRuntimeOptions,
      networkPermissionsEnabled: true,
    });
    expect(ManagedWorkspaceSourceReader).toHaveBeenCalledWith({ workspaceController });
    expect(WorkspacePreviewController).toHaveBeenCalledWith({ workspaceController });
    expect(AgentWalletController).toHaveBeenCalledWith(options.walletControllerOptions);
    expect(NodeStatusController).toHaveBeenCalledWith(options.nodeControllerOptions);
    expect(NodeRequestController).toHaveBeenCalledWith({
      ...options.nodeRequestControllerOptions,
      operationStore: nodeOperationStore,
    });
    expect(NodeLifecycleController).toHaveBeenCalledWith({
      nodeStatusController: nodeController,
      ...options.nodeLifecycleControllerOptions,
    });
    expect(NodeDiagnosticsController).toHaveBeenCalledWith({
      nodeStatusController: nodeController,
      ...options.nodeDiagnosticsControllerOptions,
    });
    expect(options.controller.setWalletTransferController).toHaveBeenCalledWith(walletController);
    expect(options.controller.setNodeController).toHaveBeenCalledWith(nodeController);
    expect(options.controller.setNodeRequestController).toHaveBeenCalledWith(nodeRequestController);
    expect(options.controller.setNodeLifecycleController).toHaveBeenCalledWith(
      nodeLifecycleController
    );
    expect(options.controller.setDiagnosticsController).toHaveBeenCalledWith(diagnosticsController);
    expect(SwarmPublicationController).toHaveBeenCalledWith({
      attachmentStore,
      workspaceSourceReader,
    });
    expect(options.controller.setPublicationController).toHaveBeenCalledWith(publicationController);
    expect(FreedomAgentService).toHaveBeenCalledWith({
      controller: options.controller,
      subscribeTabLifecycle: options.subscribeTabLifecycle,
      historyStore,
      cancelAgentDownloads: undefined,
      walletController,
      attachmentStore,
      workspaceController,
      workspacePreviewController,
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
      attachmentStore,
      getOwnerWindow: options.getOwnerWindow,
    });

    const resolveModel = registerFreedomAgentIpc.mock.calls[0][0].resolveModel;
    await expect(resolveModel()).resolves.toEqual({ model: {} });
    await runtime.dispose();

    expect(options.controller.setWalletController).not.toHaveBeenCalled();

    expect(unregisterIpc).toHaveBeenCalledTimes(1);
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(nodeRequestController.dispose).toHaveBeenCalledTimes(1);
    expect(publicationController.dispose).toHaveBeenCalledTimes(1);
    expect(workspacePreviewController.dispose).toHaveBeenCalledTimes(1);
    expect(workspaceController.dispose).toHaveBeenCalledTimes(1);
    expect(attachmentStore.dispose).toHaveBeenCalledTimes(1);
    expect(pdfProcessor.dispose).toHaveBeenCalledTimes(1);
    expect(historyStore.close).toHaveBeenCalledTimes(1);
    expect(nodeOperationStore.close).toHaveBeenCalledTimes(1);
    expect(workspaceStore.close).toHaveBeenCalledTimes(1);
    expect(options.controller.setWalletTransferController).toHaveBeenLastCalledWith(null);
    expect(options.controller.setNodeController).toHaveBeenLastCalledWith(null);
    expect(options.controller.setNodeRequestController).toHaveBeenLastCalledWith(null);
    expect(options.controller.setNodeLifecycleController).toHaveBeenLastCalledWith(null);
    expect(options.controller.setDiagnosticsController).toHaveBeenLastCalledWith(null);
    expect(options.controller.setPublicationController).toHaveBeenLastCalledWith(null);
    expect(calls).toEqual([
      'ipc',
      'service',
      'node-requests',
      'publications',
      'workspace-preview-controller',
      'workspace-controller',
      'attachments',
      'pdf',
      'history',
      'node-operations',
      'workspaces',
    ]);
  });
});
