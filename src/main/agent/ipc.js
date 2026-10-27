'use strict';

const IPC = require('../../shared/ipc-channels');
const { normalizeAgentApprovalMode } = require('../../shared/agent-approval-modes');
const { AGENT_ERROR_CODES, FreedomAgentError } = require('./freedom-agent-service');

const AGENT_IPC_ERROR_CODES = Object.freeze({
  TAB_NOT_BOUND: 'AGENT_TAB_NOT_BOUND',
  MODEL_UNAVAILABLE: 'AGENT_MODEL_UNAVAILABLE',
  NOT_OWNER: 'AGENT_NOT_OWNER',
  INTERNAL_ERROR: 'AGENT_INTERNAL_ERROR',
  SESSION_NOT_FOUND: 'AGENT_SESSION_NOT_FOUND',
});
const OPENAI_DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device';
const SAFE_PROVIDER_ERROR_MESSAGES = Object.freeze({
  AGENT_DISABLED: 'AI is off. Enable AI features in Settings → AI.',
  AGENT_CLAUDE_VERSION: 'Update Claude Code to version 2.1.290 or newer, then connect again.',
  AGENT_CLAUDE_MANAGED: 'This connection supports personal Claude Pro and Max accounts without managed policies. Managed Claude installations can run hooks outside Freedom’s permissions; use the Anthropic API connection instead.',
  AGENT_CLAUDE_UNAVAILABLE: 'Could not connect to Claude Code. Install or update its native CLI, run claude auth login with your subscription in a terminal, then try again.',
  AGENT_SECURE_STORAGE_UNAVAILABLE: 'Secure credential storage is unavailable',
  AGENT_CREDENTIAL_UNAVAILABLE: 'The saved provider credential is unavailable',
  AGENT_PROVIDER_STORE_UNSAFE: 'Agent provider storage is unsafe',
  AGENT_PROVIDER_STORE_INVALID: 'Agent provider storage is invalid',
  AGENT_PROVIDER_INVALID: 'Agent provider configuration is invalid',
  AGENT_CUSTOM_DISCOVERY_FAILED: 'Could not discover models. Check the endpoint and key, or enter model IDs manually.',
  AGENT_CUSTOM_ENDPOINT_IMMUTABLE: 'Add a new connection to use a different endpoint. Existing chats keep their original destination.',
  AGENT_CUSTOM_TOOLS_FAILED: 'The model did not complete the tool-call test. Check that this model and endpoint support tool calling.',
  AGENT_OLLAMA_DISCOVERY_FAILED: 'Could not load models from Ollama. Make sure Ollama is running and check the local URL in connection settings.',
  AGENT_OLLAMA_NO_MODELS: 'Ollama is running, but no models are installed. Download a model in Ollama, then connect again.',
  AGENT_OLLAMA_MODEL_LIMIT: 'This Ollama server has more than the supported 128 models.',
  AGENT_MODEL_INVALID: 'Selected agent model is invalid',
  AGENT_MODEL_UNAVAILABLE: 'No configured agent model is available',
  AGENT_PROVIDER_AUTH_BUSY: 'A provider sign-in is already in progress',
  AGENT_PROVIDER_AUTH_CANCELLED: 'Provider sign-in was cancelled',
  AGENT_PROVIDER_AUTH_UNSUPPORTED: 'The provider sign-in flow is unsupported',
  AGENT_CATALOG_UNAVAILABLE: 'Could not refresh models. The previous catalog is still available.',
  AGENT_CATALOG_KEY_REQUIRED: 'Enter a Venice API key to load its models.',
  AGENT_CATALOG_AUTH_FAILED: 'The provider did not accept this API key.',
  AGENT_CATALOG_EXPIRED: 'Refresh this provider’s model catalog before using its private or TEE-only setting.',
  AGENT_PROVIDER_TEST_FAILED: 'The test prompt failed. Check your API key, model access and account balance.',
  AGENT_MODEL_POLICY: 'This model is unavailable or does not meet your privacy settings. Choose another model.',
});

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSubscriptionAuthEvent(event, providerId = 'openai-codex') {
  if (providerId === 'openai-chatgpt' && event?.type === 'auth_url') {
    try {
      const url = new URL(event.url);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.hash) return null;
      return { type: 'auth_url', providerId, url: url.href };
    } catch { return null; }
  }
  if (!['openai-codex', 'meta-subscription'].includes(providerId) || event?.type !== 'device_code') return null;
  if (typeof event.userCode !== 'string' || event.userCode !== event.userCode.trim() ||
      !/^[A-Za-z0-9._-]{4,64}$/.test(event.userCode)) return null;
  let verificationUri;
  try {
    const url = new URL(event.verificationUri);
    if (url.username || url.password || url.hash) return null;
    if (providerId === 'meta-subscription') {
      if (url.origin !== 'https://auth.meta.com') return null;
    } else if (event.verificationUri !== OPENAI_DEVICE_VERIFICATION_URL) return null;
    verificationUri = url.href;
  } catch { return null; }
  return { type: 'device_code', providerId, userCode: event.userCode, verificationUri };
}

function errorEnvelope(code, message) {
  return { ok: false, error: { code, message } };
}

function registerUnavailableAgentIpc({ ipcMain, isTrustedSender, isProviderSettingsSender, isAgentLauncherSender }) {
  const channels = Object.entries(IPC)
    .filter(([name]) => name.startsWith('AGENT_') && !name.endsWith('_EVENT'))
    .map(([, channel]) => channel);
  for (const channel of channels) {
    ipcMain.handle(channel, (event) => {
      const settingsRequest = channel.startsWith('agent:provider:') && isProviderSettingsSender?.(event);
      const launcherRequest = [IPC.AGENT_OPEN, IPC.AGENT_SETUP_STATE].includes(channel) && (isAgentLauncherSender?.(event) || isProviderSettingsSender?.(event));
      if (!isTrustedSender(event.sender) && !settingsRequest && !launcherRequest)
        return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'Agent requests require trusted browser chrome');
      if (channel === IPC.AGENT_WALLET_REQUEST) return { handled: false };
      return errorEnvelope(
        'AGENT_STORAGE_UNAVAILABLE',
        'Agent storage is unavailable. Restart Freedom; if this persists, check profile-folder access or restore Agent data from a backup.'
      );
    });
  }
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function safeServiceError(error) {
  if (error instanceof FreedomAgentError) return errorEnvelope(error.code, error.message);
  return errorEnvelope(
    AGENT_IPC_ERROR_CODES.INTERNAL_ERROR,
    'The embedded agent request failed unexpectedly'
  );
}

function safeProviderError(error) {
  const message = SAFE_PROVIDER_ERROR_MESSAGES[error?.code];
  return message
    ? errorEnvelope(error.code, message)
    : errorEnvelope(
        AGENT_IPC_ERROR_CODES.INTERNAL_ERROR,
        'The embedded agent request failed unexpectedly'
      );
}

function validateStartPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new FreedomAgentError(AGENT_ERROR_CODES.INVALID_ARGUMENT, 'Agent input is required');
  }
  if (
    payload.rendererTabId !== null &&
    payload.rendererTabId !== undefined &&
    (!Number.isSafeInteger(payload.rendererTabId) || payload.rendererTabId < 1)
  ) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent input requires a valid renderer tab ID or no shared page'
    );
  }
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent prompt must be a non-empty string'
    );
  }
  const approvalMode = normalizeAgentApprovalMode(payload.approvalMode);
  if (!approvalMode) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent input requires a supported approval mode'
    );
  }
  const attachmentIds = payload.attachmentIds === undefined ? [] : payload.attachmentIds;
  if (
    !Array.isArray(attachmentIds) ||
    attachmentIds.length > 10 ||
    attachmentIds.some(
      (selectionId) =>
        typeof selectionId !== 'string' || !/^selection_[a-f0-9]{20}$/.test(selectionId)
    )
  ) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent attachments require valid pending selection IDs'
    );
  }
  return {
    rendererTabId: Number.isSafeInteger(payload.rendererTabId) ? payload.rendererTabId : null,
    prompt: payload.prompt,
    approvalMode,
    attachmentIds: [...new Set(attachmentIds)],
    ...(typeof payload.privacySettings?.requireZeroRetention === 'boolean' &&
      { privacySettings: { requireZeroRetention: payload.privacySettings.requireZeroRetention } }),
  };
}

function validateConversationPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent session input is required'
    );
  }
  if (
    typeof payload.conversationId !== 'string' ||
    !payload.conversationId.trim() ||
    payload.conversationId.length > 160
  ) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent session input requires a valid conversation ID'
    );
  }
  const result = { conversationId: payload.conversationId.trim() };
  if (options.title) {
    if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 120) {
      throw new FreedomAgentError(
        AGENT_ERROR_CODES.INVALID_ARGUMENT,
        'Agent session title must contain between 1 and 120 characters'
      );
    }
    result.title = payload.title.trim();
  }
  return result;
}

function validateTabClaimPayload(payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Number.isSafeInteger(payload.rendererTabId) ||
    payload.rendererTabId < 1
  ) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Claiming an Agent tab requires a valid renderer tab ID'
    );
  }
  return { rendererTabId: payload.rendererTabId };
}

function registerFreedomAgentIpc(options = {}) {
  const {
    ipcMain,
    service,
    automationTabIdForRenderer,
    previewPageTools,
    createAutomationPageForHost,
    desktopBindingForAutomationTab,
    resolveModel,
    providerResolver,
    isTrustedSender,
    openExternal,
    attachmentStore,
    getOwnerWindow,
    dialog,
  } = options;
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('Freedom agent IPC requires ipcMain');
  }
  if (
    !service ||
    typeof service.start !== 'function' ||
    typeof service.steer !== 'function' ||
    typeof service.pause !== 'function' ||
    typeof service.resume !== 'function' ||
    typeof service.stop !== 'function' ||
    typeof service.clearConversation !== 'function' ||
    typeof service.listConversations !== 'function' ||
    typeof service.listAgentTabs !== 'function' ||
    typeof service.stopWorkspaceProcess !== 'function' ||
    typeof service.openWorkspaceProcessPreview !== 'function' ||
    typeof service.claimTab !== 'function' ||
    typeof service.openConversation !== 'function' ||
    typeof service.renameConversation !== 'function' ||
    typeof service.updateApprovalMode !== 'function' ||
    typeof service.revokeAttachment !== 'function' ||
    typeof service.deleteConversation !== 'function' ||
    typeof service.decideApproval !== 'function' ||
    typeof service.handleWalletRequest !== 'function' ||
    typeof service.subscribe !== 'function' ||
    typeof service.getState !== 'function' ||
    typeof service.getWorkspaceState !== 'function'
  ) {
    throw new TypeError('Freedom agent IPC requires an agent service');
  }
  if (typeof automationTabIdForRenderer !== 'function') {
    throw new TypeError('Freedom agent IPC requires the desktop tab binding resolver');
  }
  if (typeof createAutomationPageForHost !== 'function') {
    throw new TypeError('Freedom agent IPC requires the desktop tab creation capability');
  }
  if (typeof desktopBindingForAutomationTab !== 'function') {
    throw new TypeError('Freedom agent IPC requires the desktop tab presentation resolver');
  }
  if (typeof resolveModel !== 'function') {
    throw new TypeError('Freedom agent IPC requires a main-process model resolver');
  }
  if (
    !providerResolver ||
    typeof providerResolver.getStatus !== 'function' ||
    typeof providerResolver.getCatalog !== 'function' ||
    typeof providerResolver.configureHosted !== 'function' ||
    typeof providerResolver.configureOllama !== 'function' ||
    typeof providerResolver.loginSubscription !== 'function' ||
    typeof providerResolver.selectModel !== 'function' ||
    typeof providerResolver.removeProvider !== 'function' ||
    typeof providerResolver.clear !== 'function'
  ) {
    throw new TypeError('Freedom agent IPC requires a provider resolver');
  }
  if (typeof isTrustedSender !== 'function') {
    throw new TypeError('Freedom agent IPC requires a trusted chrome sender check');
  }
  if (typeof openExternal !== 'function') {
    throw new TypeError('Freedom agent IPC requires an external URL opener');
  }
  if (
    !attachmentStore ||
    typeof attachmentStore.pickFiles !== 'function' ||
    typeof attachmentStore.pickFolder !== 'function' ||
    typeof attachmentStore.removeStaged !== 'function' ||
    typeof attachmentStore.clearStaged !== 'function' ||
    typeof attachmentStore.renderPreview !== 'function'
  ) {
    throw new TypeError('Freedom agent IPC requires an attachment store');
  }
  let owner = null;
  let startPending = false;
  let enableGeneration = 0;
  let providerLogin = null;
  let providerMutationPending = false;
  const attachmentOwnerCleanup = new Map();

  const trackAttachmentOwner = (sender) => {
    if (attachmentOwnerCleanup.has(sender)) return;
    const ownerId = String(sender.id);
    const onDestroyed = () => {
      attachmentStore.clearStaged(ownerId);
      attachmentOwnerCleanup.delete(sender);
    };
    attachmentOwnerCleanup.set(sender, onDestroyed);
    sender.once?.('destroyed', onDestroyed);
  };

  const detachOwner = () => {
    if (!owner) return;
    owner.sender.off?.('destroyed', owner.onDestroyed);
    owner = null;
  };

  const disposeOwnedConversation = (owned) => {
    void Promise.resolve(owned.runId ? service.stop(owned.runId) : true)
      .catch(() => false)
      .then(() => service.clearConversation())
      .catch(() => {})
      .finally(() => {
        if (owner === owned) detachOwner();
      });
  };

  const stopOwnedConversation = () => {
    if (!owner || owner.stopping) return;
    owner.stopping = true;
    const owned = owner;
    if (owned.starting && !owned.runId) return;
    disposeOwnedConversation(owned);
  };

  const sendEvent = (event) => {
    if (
      !owner ||
      // A custody refresh hint carries no conversation data; every chrome
      // owner repaints its Agent tab badges from its own state request.
      (event.type !== 'agent_tabs_changed' &&
        owner.conversationId && owner.conversationId !== event.conversationId) ||
      (owner.runId && event.runId && owner.runId !== event.runId)
    ) {
      return;
    }
    if (owner.starting) {
      owner.buffer.push(event);
      return;
    }
    try {
      if (owner.sender.isDestroyed?.()) {
        stopOwnedConversation();
        return;
      }
      owner.sender.send(IPC.AGENT_EVENT, event);
    } catch {
      stopOwnedConversation();
      return;
    }
    if (event.type === 'run_finished' && owner.runId === event.runId) {
      owner.runId = null;
      if (!owner.sender.isDestroyed?.()) owner.stopping = false;
    } else if (event.type === 'conversation_cleared') {
      detachOwner();
    }
  };

  const unsubscribe = service.subscribe(sendEvent);
  const isEnabled = options.isEnabled || (() => true);
  const disabled = () => errorEnvelope('AGENT_DISABLED', 'AI is off. Enable AI features in Settings → AI.');
  const unsubscribeSettings = options.onEnabledChanged?.((enabled) => {
    enableGeneration += 1;
    if (enabled) return;
    providerLogin?.controller.abort();
    void service.stop(undefined, { preserveServers: true }).catch(() => {});
  });

  const handleStart = async (event, rawPayload) => {
    if (startPending || owner?.runId) {
      return errorEnvelope(AGENT_ERROR_CODES.BUSY, 'Freedom agent already has an active run');
    }
    startPending = true;
    const generation = enableGeneration;
    try {
      if (!isTrustedSender(event?.sender)) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'The sender is not trusted browser chrome'
        );
      }
      const { rendererTabId, prompt, approvalMode, attachmentIds, privacySettings } =
        validateStartPayload(rawPayload);
      const continuing = Boolean(owner);
      if (continuing && owner.sender !== event?.sender) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'The sender does not own the current agent conversation'
        );
      }
      if (!event?.sender || event.sender.isDestroyed?.()) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'The browser window is no longer available'
        );
      }

      let pendingOwner = owner;
      let tabId;
      let resolved;
      const conversationState = continuing ? service.getState() : null;
      const needsRuntime = !continuing || conversationState.runtimeAvailable !== true;
      if (needsRuntime) {
        tabId = rendererTabId ? automationTabIdForRenderer(event?.sender, rendererTabId) : null;
        if (rendererTabId && !tabId) {
          return errorEnvelope(
            AGENT_IPC_ERROR_CODES.TAB_NOT_BOUND,
            'The selected browser tab is not ready for the agent'
          );
        }
        try {
          const savedModel = continuing && conversationState.providerId && conversationState.modelId
            ? { providerId: conversationState.providerId, modelId: conversationState.modelId } : null;
          if (continuing && !savedModel && conversationState.transcript?.length) {
            return errorEnvelope(AGENT_IPC_ERROR_CODES.MODEL_UNAVAILABLE, 'This saved chat has no model information. Start a new chat.');
          }
          // Opening a project creates an empty conversation before a model is chosen.
          resolved = savedModel ? await resolveModel(savedModel) : await resolveModel();
        } catch (error) {
          const errorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
          console.error('[agent] Model resolution failed:', errorCode);
          if (['AGENT_MODEL_POLICY', 'AGENT_CATALOG_EXPIRED'].includes(errorCode)) {
            return safeProviderError(error);
          }
          return errorEnvelope(
            AGENT_IPC_ERROR_CODES.MODEL_UNAVAILABLE,
            continuing ? 'Reconnect this chat’s model in Settings → AI, or start a new chat.' : 'No configured agent model is available'
          );
        }
        if (!resolved?.model || !resolved?.modelRuntime) {
          return errorEnvelope(
            AGENT_IPC_ERROR_CODES.MODEL_UNAVAILABLE,
            continuing ? 'Reconnect this chat’s model in Settings → AI, or start a new chat.' : 'No configured agent model is available'
          );
        }
        if (!continuing) {
          pendingOwner = {
            sender: event.sender,
            rendererTabId,
            conversationId: null,
            runId: null,
            buffer: [],
            starting: true,
            stopping: false,
            onDestroyed: () => stopOwnedConversation(),
          };
          owner = pendingOwner;
          event.sender.once?.('destroyed', pendingOwner.onDestroyed);
        } else {
          pendingOwner.rendererTabId = rendererTabId;
        }
      }
      if (continuing) {
        pendingOwner.starting = true;
        pendingOwner.buffer = [];
      }

      if (!isEnabled() || generation !== enableGeneration) {
        pendingOwner.starting = false;
        pendingOwner.buffer = [];
        if (!continuing && owner === pendingOwner) detachOwner();
        return disabled();
      }
      let started;
      try {
        started = await service.start({
          prompt,
          approvalMode,
          ...(privacySettings && { privacySettings }),
          ...(attachmentIds.length && {
            attachmentIds,
            attachmentOwnerId: String(event.sender.id),
          }),
          ...(needsRuntime && {
            tabId,
            createWorkspacePage: (url) => createAutomationPageForHost(pendingOwner.sender, url),
            model: resolved.model,
            modelRuntime: resolved.modelRuntime,
            ...(resolved.connectionProviderId && { connectionProviderId: resolved.connectionProviderId }),
            thinkingLevel: resolved.thinkingLevel,
          }),
        });
      } catch (error) {
        pendingOwner.starting = false;
        pendingOwner.buffer = [];
        if (!continuing && owner === pendingOwner) detachOwner();
        return safeServiceError(error);
      }

      if (owner !== pendingOwner) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.INTERNAL_ERROR,
          'The embedded agent request failed unexpectedly'
        );
      }
      pendingOwner.conversationId = started.conversationId;
      pendingOwner.runId = started.runId;
      pendingOwner.starting = false;
      if (pendingOwner.stopping || pendingOwner.sender.isDestroyed?.()) {
        pendingOwner.stopping = true;
        disposeOwnedConversation(pendingOwner);
      }
      const buffered = pendingOwner.buffer;
      pendingOwner.buffer = [];
      for (const bufferedEvent of buffered) sendEvent(bufferedEvent);
      return {
        ok: true,
        runId: started.runId,
        conversationId: started.conversationId,
      };
    } catch (error) {
      return safeServiceError(error);
    } finally {
      startPending = false;
    }
  };

  const handleStop = async (event, payload = {}) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      typeof payload?.runId !== 'string' ||
      payload.runId !== owner.runId
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that agent run'
      );
    }
    if (Object.hasOwn(payload, 'taskId')) {
      if (typeof payload.taskId !== 'string' || !/^delegate_[a-f0-9]{24}$/.test(payload.taskId)) {
        return errorEnvelope(AGENT_ERROR_CODES.INVALID_ARGUMENT, 'Choose a running helper from this task.');
      }
      return { ok: true, stopped: await service.stopHelper(owner.runId, payload.taskId) };
    }
    return { ok: true, stopped: await service.stop(owner.runId) };
  };

  const handlePause = async (event, payload = {}) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      typeof payload?.runId !== 'string' ||
      payload.runId !== owner.runId
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that agent run'
      );
    }
    return { ok: true, paused: await service.pause(owner.runId) };
  };

  const handleSteer = async (event, payload = {}) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      typeof payload?.runId !== 'string' ||
      payload.runId !== owner.runId
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that agent run'
      );
    }
    try {
      const guidance = await service.steer(owner.runId, payload.prompt);
      return guidance
        ? { ok: true, guidance }
        : errorEnvelope(AGENT_ERROR_CODES.BUSY, 'Agent cannot accept guidance right now');
    } catch (error) {
      return safeServiceError(error);
    }
  };

  const handleResume = async (event, payload = {}) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      typeof payload?.runId !== 'string' ||
      payload.runId !== owner.runId
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that agent run'
      );
    }
    try {
      return { ok: true, resumed: await service.resume(owner.runId, payload.prompt) };
    } catch (error) {
      return safeServiceError(error);
    }
  };

  const handleApprovalDecision = async (event, payload = {}) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      typeof payload?.runId !== 'string' ||
      payload.runId !== owner.runId ||
      typeof payload.approvalId !== 'string' ||
      !payload.approvalId ||
      typeof payload.approved !== 'boolean'
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that agent approval'
      );
    }
    let decision = payload.approved;
    const stringArray = (value, max) => Array.isArray(value) && value.length <= max &&
      value.every(item => typeof item === 'string' && item.length <= 1_024) ? [...value] : null;
    const publicationFixPaths = stringArray(payload.publicationFix?.paths, 200);
    if (!payload.approved && publicationFixPaths?.length) {
      decision = { approved: false, publicationFix: { paths: publicationFixPaths } };
    }
    if (payload.approved) {
      const publicationExclusions = stringArray(payload.publicationExclusions, 200);
      const publicationAcknowledged = stringArray(payload.publicationAcknowledged, 200);
      const walletIndex =
        Number.isSafeInteger(payload.walletIndex) && payload.walletIndex >= 0
          ? payload.walletIndex
          : null;
      const diagnosticScope = payload.diagnosticScope === 'conversation' ? 'conversation' : null;
      const workspacePermissionScope =
        payload.workspacePermissionScope === 'conversation' ? 'conversation' : null;
      if (walletIndex !== null || diagnosticScope || workspacePermissionScope ||
          publicationExclusions?.length || publicationAcknowledged?.length) {
        decision = {
          approved: true,
          ...(walletIndex !== null && { walletIndex }),
          ...(diagnosticScope && { diagnosticScope }),
          ...(workspacePermissionScope && { workspacePermissionScope }),
          ...(publicationExclusions?.length && { publicationExclusions }),
          ...(publicationAcknowledged?.length && { publicationAcknowledged }),
        };
      }
    }
    const decided = await service.decideApproval(owner.runId, payload.approvalId, decision);
    return decided
      ? { ok: true, decided: true }
      : errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'The sender does not own that agent approval'
        );
  };

  const handleAgentWalletRequest = async (event, payload = {}) => {
    let trusted;
    try {
      trusted = isTrustedSender(event?.sender);
    } catch {
      trusted = false;
    }
    if (
      !trusted ||
      !Number.isSafeInteger(payload.rendererTabId) ||
      payload.rendererTabId < 1 ||
      !payload.request ||
      typeof payload.request !== 'object' ||
      Array.isArray(payload.request)
    ) {
      return { handled: false };
    }
    const tabId = automationTabIdForRenderer(event.sender, payload.rendererTabId);
    if (!tabId) return { handled: false };
    return service.handleWalletRequest(tabId, payload.request);
  };

  const handleGetState = (event) => {
    let trusted;
    try {
      trusted = isTrustedSender(event?.sender);
    } catch {
      trusted = false;
    }
    if (!trusted) return { ok: true, state: { status: 'idle', taskTabs: [], agentTabs: [] } };
    const ownsSelectedConversation = Boolean(owner && owner.sender === event.sender);
    const selectedState = ownsSelectedConversation ? service.getState() : { status: 'idle' };
    const workspace = ownsSelectedConversation
      ? service.getWorkspaceState()
      : { tabIds: [], activeTabId: null };
    const sharedPageBinding = ownsSelectedConversation
      ? desktopBindingForAutomationTab(selectedState.tabId)
      : null;
    const sharedPageRendererTabId =
      sharedPageBinding?.hostWebContents === event.sender &&
      Number.isSafeInteger(sharedPageBinding.rendererTabId) &&
      sharedPageBinding.rendererTabId > 0
        ? sharedPageBinding.rendererTabId
        : null;
    const taskTabs = [];
    for (const automationTabId of workspace.tabIds) {
      const binding = desktopBindingForAutomationTab(automationTabId);
      if (
        binding?.hostWebContents !== event.sender ||
        !Number.isSafeInteger(binding.rendererTabId) ||
        binding.rendererTabId < 1
      ) {
        continue;
      }
      taskTabs.push({
        rendererTabId: binding.rendererTabId,
        agentActive: automationTabId === workspace.activeTabId,
      });
    }
    const agentTabs = [];
    for (const record of service.listAgentTabs()) {
      const binding = desktopBindingForAutomationTab(record.tabId);
      if (
        binding?.hostWebContents !== event.sender ||
        !Number.isSafeInteger(binding.rendererTabId) ||
        binding.rendererTabId < 1
      ) {
        continue;
      }
      agentTabs.push({
        rendererTabId: binding.rendererTabId,
        provenance: 'agent',
        custody: 'agent',
        conversationId: record.conversationId,
      });
    }
    return {
      ok: true,
      state: {
        ...selectedState,
        rendererTabId: sharedPageRendererTabId,
        taskTabs,
        agentTabs,
      },
    };
  };

  const handleProcessAction = async (event, payload, action) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload.processId !== 'string' ||
      !/^workspace_process_[a-f0-9]{24}$/.test(payload.processId)
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that workspace process'
      );
    }
    try {
      const result = await action(payload.processId);
      return { ok: true, result, state: handleGetState(event).state };
    } catch (error) {
      return safeServiceError(error);
    }
  };

  const handleWorkspaceInspect = async (event, payload) => {
    if (!owner || owner.sender !== event?.sender) {
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'The sender does not own this workspace');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        typeof payload.conversationId !== 'string' || payload.conversationId.length > 160 ||
        !['tree', 'changes', 'file', 'diff', 'image', 'search'].includes(payload.kind) ||
        typeof payload.path !== 'string' || payload.path.length > 1024 ||
        (payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > 1048576)) ||
        (payload.revision !== undefined && !/^[a-f0-9]{64}$/.test(payload.revision)) ||
        (payload.query !== undefined && (typeof payload.query !== 'string' || !payload.query.trim() || payload.query.length > 200)) ||
        (payload.scope !== undefined && !['all', 'staged', 'unstaged'].includes(payload.scope)) ||
        (payload.showGenerated !== undefined && typeof payload.showGenerated !== 'boolean')) {
      return errorEnvelope(AGENT_ERROR_CODES.INVALID_ARGUMENT, 'Invalid workspace inspection');
    }
    if (payload.conversationId !== owner.conversationId) {
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'The sender does not own this workspace');
    }
    try {
      const ownerAtStart = owner;
      const result = await service.inspectWorkspace(payload.conversationId, {
        kind: payload.kind, path: payload.path, showGenerated: payload.showGenerated === true, offset: payload.offset, scope: payload.scope, revision: payload.revision, query: payload.query,
      });
      if (owner !== ownerAtStart || owner.conversationId !== payload.conversationId) return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'Workspace ownership changed');
      return { ok: true, conversationId: payload.conversationId, result };
    } catch (error) {
      return safeServiceError(error);
    }
  };

  const handleWorkspaceHistory = async (event, payload) => {
    if (!owner || owner.sender !== event?.sender || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.conversationId !== owner.conversationId) {
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'The sender does not own this workspace');
    }
    const { conversationId, action, versionId, label, path, token, reason, baseId, cursor, offset, paths } = payload;
    if (!['list', 'files', 'file', 'comparison', 'comparison_file', 'recovery', 'save', 'prepare_restore', 'prepare_recovery', 'repair_commit', 'restore', 'include', 'exclude'].includes(action) ||
        (['files', 'file', 'comparison', 'comparison_file', 'prepare_restore'].includes(action) && !/^[a-f0-9]{40}$/.test(versionId || '')) ||
        (['file', 'comparison_file', 'include', 'exclude'].includes(action) && (typeof path !== 'string' || !path || path.length > 1024)) ||
        (['include', 'exclude'].includes(action) && (typeof reason !== 'string' || !reason.trim() || reason.length > 160)) ||
        (baseId !== undefined && baseId !== null && !/^[a-f0-9]{40}$/.test(baseId)) ||
        (cursor !== undefined && cursor !== null && !/^[a-f0-9]{40}$/.test(cursor)) ||
        (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 1048576)) ||
        (path !== undefined && (typeof path !== 'string' || path.length > 1024)) ||
        (paths !== undefined && (action !== 'prepare_restore' || !Array.isArray(paths) || !paths.length || paths.length > 200 || paths.some(value => typeof value !== 'string' || !value || value.length > 1024))) ||
        (action === 'save' && (typeof label !== 'string' || !label.trim() || label.length > 80)) ||
        (action === 'repair_commit' && !/^[a-f0-9]{64}$/.test(token || '')) ||
        (action === 'restore' && !/^restore_[a-f0-9]{32}$/.test(token || ''))) {
      return errorEnvelope(AGENT_ERROR_CODES.INVALID_ARGUMENT, 'Invalid workspace version request');
    }
    const ownerAtStart = owner;
    try {
      const result = await service.workspaceHistory(conversationId, { action, versionId, label, path, token, reason, baseId, cursor, offset, paths });
      if (owner !== ownerAtStart || owner.conversationId !== conversationId) return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'Workspace ownership changed');
      return { ok: true, conversationId, result };
    } catch (error) { return safeServiceError(error); }
  };

  const handleProcessStop = (event, payload) =>
    handleProcessAction(event, payload, (processId) => service.stopWorkspaceProcess(processId));

  const handleProcessPreviewOpen = (event, payload) =>
    handleProcessAction(event, payload, (processId) =>
      service.openWorkspaceProcessPreview(processId)
    );

  const handleClearConversation = async (event) => {
    if (!owner || owner.sender !== event?.sender) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own the current agent conversation'
      );
    }
    if (owner.runId || owner.starting) {
      return errorEnvelope(
        AGENT_ERROR_CODES.BUSY,
        'Take over the active turn before starting a new conversation'
      );
    }
    const cleared = await service.clearConversation();
    return cleared
      ? { ok: true, cleared: true }
      : errorEnvelope(AGENT_ERROR_CODES.BUSY, 'The agent conversation is still active');
  };

  const trustedHistoryRequest = (event, action) => {
    try {
      if (!isTrustedSender(event?.sender)) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'The sender is not trusted browser chrome'
        );
      }
      return action();
    } catch (error) {
      return safeServiceError(error);
    }
  };

  const handleHelperReports = (event, payload) => trustedHistoryRequest(event, () => {
    if (!owner || owner.sender !== event.sender || payload?.conversationId !== owner.conversationId) {
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'Open this conversation before reading its helper reports.');
    }
    if (!/^report_[a-f0-9]{64}$/.test(payload?.reportId || '') ||
        !Number.isSafeInteger(payload.offset) || payload.offset < 0) {
      return errorEnvelope(AGENT_ERROR_CODES.INVALID_ARGUMENT, 'Choose a saved helper report and a valid text offset.');
    }
    return { ok: true, result: service.helperReports(owner.conversationId, { action: 'read', reportId: payload.reportId, offset: payload.offset, limit: 16000 }) };
  });

  const handleHistoryList = (event) =>
    trustedHistoryRequest(event, () => ({ ok: true, sessions: service.listConversations() }));

  const handleHistoryOpen = async (event, payload) => {
    const trusted = trustedHistoryRequest(event, () => ({ ok: true }));
    if (!trusted.ok) return trusted;
    if (owner?.runId || owner?.starting) {
      return errorEnvelope(
        AGENT_ERROR_CODES.BUSY,
        'Take over the active turn before switching sessions'
      );
    }
    if (owner && owner.sender !== event.sender) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'Another browser window owns the current agent conversation'
      );
    }
    try {
      const { conversationId } = validateConversationPayload(payload);
      const state = await service.openConversation(conversationId);
      if (!state) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.SESSION_NOT_FOUND,
          'That saved Agent session is no longer available'
        );
      }
      if (!owner) {
        const pendingOwner = {
          sender: event.sender,
          rendererTabId: null,
          conversationId,
          runId: null,
          buffer: [],
          starting: false,
          stopping: false,
          onDestroyed: () => stopOwnedConversation(),
        };
        owner = pendingOwner;
        event.sender.once?.('destroyed', pendingOwner.onDestroyed);
      } else {
        owner.conversationId = conversationId;
        owner.rendererTabId = null;
      }
      return { ok: true, state: handleGetState(event).state };
    } catch (error) {
      return safeServiceError(error);
    }
  };

  const handleHistoryRename = (event, payload) =>
    trustedHistoryRequest(event, () => {
      const { conversationId, title } = validateConversationPayload(payload, { title: true });
      const session = service.renameConversation(conversationId, title);
      return session
        ? { ok: true, session }
        : errorEnvelope(
            AGENT_IPC_ERROR_CODES.SESSION_NOT_FOUND,
            'That saved Agent session is no longer available'
          );
    });

  let projectSelectionPending = false;
  const handleProjectAccess = async (event, payload = {}) => {
    if (!isTrustedSender(event?.sender) || event.sender.isDestroyed?.() ||
        (owner && owner.sender !== event.sender)) {
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'This window does not own the project.');
    }
    const action = payload?.action;
    if (!['open', 'reconnect', 'read', 'write', 'remove'].includes(action) ||
        (action !== 'open' && (!owner || payload.conversationId !== owner.conversationId))) {
      return errorEnvelope(AGENT_ERROR_CODES.INVALID_ARGUMENT, 'Invalid project request.');
    }
    if (projectSelectionPending || owner?.runId || owner?.starting) {
      return errorEnvelope(AGENT_ERROR_CODES.BUSY, 'Finish the current task before changing project access.');
    }
    const ownerAtStart = owner;
    const conversationAtStart = owner?.conversationId;
    projectSelectionPending = true;
    try {
      let selectedPath = null;
      if (['open', 'reconnect'].includes(action)) {
        const options = { title: action === 'open' ? 'Open project — read-only access' : 'Reconnect project',
          buttonLabel: action === 'open' ? 'Open project' : 'Reconnect', properties: ['openDirectory', 'dontAddToRecent'] };
        const window = getOwnerWindow?.(event.sender);
        const selection = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        if (selection.canceled || !selection.filePaths?.[0]) return { ok: true, cancelled: true };
        selectedPath = selection.filePaths[0];
      }
      if (event.sender.isDestroyed?.() || owner !== ownerAtStart || owner?.conversationId !== conversationAtStart || owner?.runId || owner?.starting) {
        return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'The conversation changed. Select the project again.');
      }
      const state = action === 'open' ? await service.openProject(selectedPath)
        : await service.setProjectAccess(payload.conversationId, action, selectedPath);
      if (!state?.conversationId) throw new Error('The project could not be opened.');
      if (event.sender.isDestroyed?.() || owner !== ownerAtStart || owner?.conversationId !== conversationAtStart) {
        await service.setProjectAccess(state.conversationId, 'remove');
        return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'The project window changed. Reconnect to continue.');
      }
      if (!owner) {
        owner = { sender: event.sender, rendererTabId: null, conversationId: state.conversationId,
          runId: null, buffer: [], starting: false, stopping: false, onDestroyed: () => stopOwnedConversation() };
        event.sender.once?.('destroyed', owner.onDestroyed);
      } else { owner.conversationId = state.conversationId; owner.rendererTabId = null; }
      return { ok: true, state: handleGetState(event).state };
    } catch (error) {
      return errorEnvelope(AGENT_ERROR_CODES.INVALID_ARGUMENT,
        /^PROJECT_/.test(error?.code || '') ? error.message : 'Project access could not be changed.');
    } finally { projectSelectionPending = false; }
  };

  const handleHistoryDelete = async (event, payload) => {
    const trusted = trustedHistoryRequest(event, () => ({ ok: true }));
    if (!trusted.ok) return trusted;
    try {
      const { conversationId } = validateConversationPayload(payload);
      if (owner?.conversationId === conversationId && (owner.runId || owner.starting)) {
        return errorEnvelope(
          AGENT_ERROR_CODES.BUSY,
          'Take over the active turn before deleting this session'
        );
      }
      const deleted = await service.deleteConversation(conversationId);
      if (!deleted) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.SESSION_NOT_FOUND,
          'That saved Agent session is no longer available'
        );
      }
      if (owner?.conversationId === conversationId) detachOwner();
      return { ok: true, deleted: true };
    } catch (error) {
      return safeServiceError(error);
    }
  };

  const handleTabClaim = async (event, payload) => {
    const trusted = trustedHistoryRequest(event, () => ({ ok: true }));
    if (!trusted.ok) return trusted;
    try {
      const { rendererTabId } = validateTabClaimPayload(payload);
      const tabId = automationTabIdForRenderer(event.sender, rendererTabId);
      if (!tabId) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.TAB_NOT_BOUND,
          'That browser tab is no longer available'
        );
      }
      const claimed = await service.claimTab(tabId);
      if (!claimed) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'That tab is not currently owned by Agent'
        );
      }
      return { ok: true, claimed: true, state: handleGetState(event).state };
    } catch (error) {
      return safeServiceError(error);
    }
  };

  const handleOpenPublication = async (event, payload) => {
    let trusted;
    try {
      trusted = isTrustedSender(event?.sender);
    } catch {
      trusted = false;
    }
    if (!trusted) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender is not trusted browser chrome'
      );
    }
    const bzzUrl = typeof payload?.bzzUrl === 'string' ? payload.bzzUrl.trim() : '';
    // 128 hex: an encrypted private draft link (reference plus key).
    if (!/^bzz:\/\/[a-f0-9]{64}(?:[a-f0-9]{64})?$/.test(bzzUrl)) {
      return errorEnvelope(
        AGENT_ERROR_CODES.INVALID_ARGUMENT,
        'Opening a publication requires a valid Swarm URL'
      );
    }
    event.sender.send('tab:new-with-url', bzzUrl);
    return { ok: true, opened: true };
  };

  const handleProviderRequest = async (event, action) => {
    let trusted;
    try {
      trusted = isTrustedSender(event?.sender) || options.isProviderSettingsSender?.(event);
    } catch {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender is not trusted browser chrome'
      );
    }
    if (!trusted) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender is not trusted browser chrome'
      );
    }
    try {
      return { ok: true, ...(await action()) };
    } catch (error) {
      return safeProviderError(error);
    }
  };

  const handleMcpConnections = (event, payload) => {
    if (!isTrustedSender(event?.sender)) return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'Connected services require browser chrome');
    return handleProviderRequest(event, async () => {
      const manager = options.mcpConnections;
      if (!manager) return { connections: [] };
      const actions = {
        list: () => manager.list(),
        add: () => manager.add({ name: payload.name, url: payload.url }),
        reconnect: () => manager.reconnect(payload.id),
        signin: () => manager.signIn(payload.id),
        cancel: () => manager.cancelSignIn(payload.id),
        remove: () => manager.remove(payload.id),
      };
      if (!Object.hasOwn(actions, payload?.action)) return { error: { message: 'Unknown connection action.' }, ok: false };
      try { return { connections: await actions[payload.action]() }; }
      catch { return { ok: false, error: { message: 'Connection action failed. Check the URL, try signing in or reconnect, and ensure the system keyring is available.' } }; }
    });
  };

  const handleProviderStatus = (event) =>
    handleProviderRequest(event, () => ({ status: providerResolver.getStatus() }));
  const handleProviderCatalog = (event) =>
    handleProviderRequest(event, async () => ({ catalog: await providerResolver.getCatalog() }));
  const handleProviderMutation = (event, action) =>
    handleProviderRequest(event, async () => {
      if (providerMutationPending) {
        throw providerError(
          'AGENT_PROVIDER_AUTH_BUSY',
          'A provider sign-in is already in progress'
        );
      }
      providerMutationPending = true;
      try {
        const result = await action();
        await options.onProviderChanged?.();
        return result;
      } finally {
        providerMutationPending = false;
      }
    });
  const handleConfigureHosted = (event, payload) =>
    handleProviderMutation(event, async () => ({
      status: await providerResolver.configureHosted(payload),
    }));
  const handleRefreshModels = (event, payload) =>
    handleProviderMutation(event, async () => ({
      catalog: await providerResolver.refreshModels(payload),
      status: providerResolver.getStatus(),
    }));
  const handleProviderPreferences = (event, payload) =>
    handleProviderMutation(event, () => ({ status: providerResolver.setPreferences(payload) }));
  const handleTestConnection = (event, payload) =>
    handleProviderMutation(event, async () => ({ result: await providerResolver.testConnection(payload) }));
  const handleConfigureOllama = (event, payload) =>
    handleProviderMutation(event, async () => ({ status: await providerResolver.configureOllama(payload) }));
  const handleLoginSubscription = (event, payload) =>
    handleProviderMutation(event, async () => {
      if (providerLogin) {
        throw providerError(
          'AGENT_PROVIDER_AUTH_BUSY',
          'A provider sign-in is already in progress'
        );
      }
      const controller = new AbortController();
      const pending = {
        requestId: require('crypto').randomUUID(),
        sender: event.sender,
        controller,
        onDestroyed: () => controller.abort(),
      };
      const loginTimeout = setTimeout(() => controller.abort(), 5 * 60_000);
      providerLogin = pending;
      event.sender.once?.('destroyed', pending.onDestroyed);
      try {
        const status = await providerResolver.loginSubscription(payload, {
          signal: controller.signal,
          prompt: async (prompt) => {
            if (payload?.providerId === 'openai-chatgpt' && prompt?.type === 'manual_code') {
              const signal = AbortSignal.any([controller.signal, ...(prompt.signal ? [prompt.signal] : [])]);
              signal.throwIfAborted();
              return new Promise((resolve, reject) => {
                const finish = (error, value) => {
                  signal.removeEventListener('abort', abort);
                  pending.submit = null;
                  if (error) reject(error); else resolve(value);
                };
                const abort = () => finish(providerError('AGENT_PROVIDER_AUTH_CANCELLED', 'Provider sign-in was cancelled'));
                pending.submit = value => finish(null, value);
                signal.addEventListener('abort', abort, { once: true });
                pending.sender.send(IPC.AGENT_PROVIDER_AUTH_EVENT, {
                  type: 'manual_code', providerId: 'openai-chatgpt', requestId: pending.requestId,
                });
              });
            }
            if (
              prompt?.type === 'select' &&
              prompt.options?.some((option) => option?.id === 'device_code')
            ) {
              return 'device_code';
            }
            throw providerError(
              'AGENT_PROVIDER_AUTH_UNSUPPORTED',
              'The provider sign-in flow is unsupported'
            );
          },
          notify: (authEvent) => {
            const normalized = normalizeSubscriptionAuthEvent(authEvent, payload?.providerId);
            if (!normalized || controller.signal.aborted) return;
            try {
              // Authorization URLs stay in main; they contain per-login state.
              pending.sender.send(IPC.AGENT_PROVIDER_AUTH_EVENT, normalized.type === 'auth_url'
                ? { type: 'auth_url', providerId: normalized.providerId } : normalized);
              Promise.resolve(openExternal(normalized.url || normalized.verificationUri)).catch(() => {
                controller.abort();
              });
            } catch {
              controller.abort();
            }
          },
        });
        return { status };
      } catch (error) {
        if (controller.signal.aborted) {
          throw providerError('AGENT_PROVIDER_AUTH_CANCELLED', 'Provider sign-in was cancelled');
        }
        throw error;
      } finally {
        clearTimeout(loginTimeout);
        pending.sender.off?.('destroyed', pending.onDestroyed);
        if (providerLogin === pending) providerLogin = null;
      }
    });
  const handleSubmitProviderLogin = (event, payload) =>
    handleProviderRequest(event, () => {
      if (!providerLogin || providerLogin.sender !== event.sender ||
          payload?.requestId !== providerLogin.requestId || !providerLogin.submit) {
        throw providerError('AGENT_PROVIDER_AUTH_CANCELLED', 'This sign-in is no longer waiting for a callback');
      }
      let url;
      try {
        if (typeof payload.callbackUrl !== 'string' || payload.callbackUrl.length > 16384) throw new Error();
        url = new URL(payload.callbackUrl);
      } catch { throw providerError('AGENT_PROVIDER_INVALID', 'Paste the complete sign-in callback URL'); }
      if (url.origin !== 'http://127.0.0.1:1455' || url.pathname !== '/auth/callback' || url.username || url.password || url.hash) {
        throw providerError('AGENT_PROVIDER_INVALID', 'Paste the complete sign-in callback URL');
      }
      providerLogin.submit(url.href);
      return { submitted: true };
    });
  const handleCancelProviderLogin = (event) =>
    handleProviderRequest(event, () => {
      if (!providerLogin || providerLogin.sender !== event?.sender) {
        throw providerError('AGENT_PROVIDER_AUTH_CANCELLED', 'Provider sign-in was cancelled');
      }
      providerLogin.controller.abort();
      return { cancelled: true };
    });
  const handleAttachmentRequest = async (event, action) => {
    if (!isTrustedSender(event?.sender) || event.sender.isDestroyed?.()) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender is not trusted browser chrome'
      );
    }
    try {
      trackAttachmentOwner(event.sender);
      return {
        ok: true,
        selections: await action({
          ownerId: String(event.sender.id),
          ownerWindow: typeof getOwnerWindow === 'function' ? getOwnerWindow(event.sender) : null,
        }),
      };
    } catch (error) {
      return errorEnvelope(
        AGENT_ERROR_CODES.INVALID_ARGUMENT,
        typeof error?.message === 'string' && error.message
          ? error.message.slice(0, 240)
          : 'The attachment could not be added'
      );
    }
  };
  const handlePickFiles = (event) =>
    handleAttachmentRequest(event, (context) => attachmentStore.pickFiles(context));
  const handleDropFiles = (event, payload) =>
    handleAttachmentRequest(event, (context) => attachmentStore.stageFiles({ ...context, filePaths: payload?.filePaths }));
  const handlePickFolder = (event) =>
    handleAttachmentRequest(event, (context) => attachmentStore.pickFolder(context));
  const handleRemoveAttachment = (event, payload = {}) => {
    if (
      !isTrustedSender(event?.sender) ||
      typeof payload.selectionId !== 'string' ||
      !/^selection_[a-f0-9]{20}$/.test(payload.selectionId)
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The attachment selection is not owned by this browser window'
      );
    }
    return {
      ok: true,
      removed: attachmentStore.removeStaged(String(event.sender.id), payload.selectionId),
    };
  };
  const handleRevokeAttachment = async (event, payload = {}) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      payload.conversationId !== owner.conversationId ||
      !/^conversation_[a-f0-9]{16}$/.test(payload.conversationId || '') ||
      !/^folder_[a-f0-9]{20}$/.test(payload.resourceId || '')
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that shared folder'
      );
    }
    try {
      const result = await service.revokeAttachment(payload.conversationId, payload.resourceId);
      return result
        ? { ok: true, revoked: true, resources: result.resources }
        : errorEnvelope(
            AGENT_IPC_ERROR_CODES.SESSION_NOT_FOUND,
            'That shared folder is no longer available'
          );
    } catch (error) {
      return safeServiceError(error);
    }
  };
  const handleAttachmentPreview = async (event, payload = {}) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      payload.conversationId !== owner.conversationId ||
      !/^conversation_[a-f0-9]{16}$/.test(payload.conversationId || '') ||
      !/^attachment_[a-f0-9]{20}$/.test(payload.resourceId || '')
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that attachment preview'
      );
    }
    try {
      const preview = await attachmentStore.renderPreview(
        payload.conversationId,
        payload.resourceId
      );
      return {
        ok: true,
        preview: {
          sourceKind: preview.sourceKind,
          width: preview.width,
          height: preview.height,
          dataUrl: `data:image/png;base64,${preview.data.toString('base64')}`,
        },
      };
    } catch (error) {
      return safeServiceError(error);
    }
  };
  const handleSetPrivacySettings = async (event, payload = {}) => {
    if (!isTrustedSender(event?.sender) || !owner || owner.sender !== event?.sender ||
      payload.conversationId !== owner.conversationId ||
      !/^conversation_[a-f0-9]{16}$/.test(payload.conversationId || '')) {
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'The sender does not own that Agent conversation');
    }
    try { return { ok: true, ...await service.updatePrivacySettings(payload.conversationId, payload.settings) }; }
    catch (error) { return safeServiceError(error); }
  };
  const handleSetApprovalMode = async (event, payload = {}) => {
    if (
      !owner ||
      owner.sender !== event?.sender ||
      payload.conversationId !== owner.conversationId ||
      !/^conversation_[a-f0-9]{16}$/.test(payload.conversationId || '')
    ) {
      return errorEnvelope(
        AGENT_IPC_ERROR_CODES.NOT_OWNER,
        'The sender does not own that Agent conversation'
      );
    }
    if (owner.runId) {
      return errorEnvelope(
        AGENT_ERROR_CODES.BUSY,
        'Finish the current Agent turn before changing its approval setting'
      );
    }
    const approvalMode = normalizeAgentApprovalMode(payload.approvalMode);
    if (typeof payload.approvalMode !== 'string' || !approvalMode) {
      return errorEnvelope(
        AGENT_ERROR_CODES.INVALID_ARGUMENT,
        'The requested Agent approval setting is unavailable'
      );
    }
    try {
      const result = await service.updateApprovalMode(payload.conversationId, approvalMode);
      return { ok: true, ...result };
    } catch (error) {
      return safeServiceError(error);
    }
  };
  const handleSelectModel = (event, payload) =>
    handleProviderMutation(event, async () => ({
      status: await providerResolver.selectModel(payload),
    }));
  const handleRemoveProvider = (event, payload) =>
    handleProviderMutation(event, () => ({
      status: providerResolver.removeProvider(payload),
    }));
  const handleClearProvider = (event) =>
    handleProviderMutation(event, () => {
      if (providerLogin) {
        throw providerError(
          'AGENT_PROVIDER_AUTH_BUSY',
          'A provider sign-in is already in progress'
        );
      }
      return { status: providerResolver.clear() };
    });

  // Trusted chrome only; binding resolution confines discovery to this window.
  const previewPending = new WeakSet();
  const availableWhileOff = new Set([
    IPC.AGENT_GET_STATE, IPC.AGENT_STOP, IPC.AGENT_PAUSE, IPC.AGENT_CLEAR_CONVERSATION,
    IPC.AGENT_HISTORY_LIST, IPC.AGENT_HISTORY_OPEN, IPC.AGENT_HISTORY_RENAME, IPC.AGENT_HISTORY_DELETE,
    IPC.AGENT_HELPER_REPORTS, IPC.AGENT_TAB_CLAIM, IPC.AGENT_WORKSPACE_INSPECT,
    IPC.AGENT_PROCESS_STOP, IPC.AGENT_PROCESS_PREVIEW_OPEN, IPC.AGENT_PUBLICATION_OPEN,
    IPC.AGENT_PROVIDER_GET_STATUS, IPC.AGENT_PROVIDER_REMOVE, IPC.AGENT_PROVIDER_CLEAR,
    IPC.AGENT_PROVIDER_CANCEL_LOGIN, IPC.AGENT_ATTACHMENTS_REMOVE, IPC.AGENT_ATTACHMENTS_REVOKE,
    IPC.AGENT_SETUP_STATE,
  ]);
  const handle = (channel, handler) => ipcMain.handle(channel, (event, payload) => {
    if (!isEnabled() && !availableWhileOff.has(channel)) {
      if (channel === IPC.AGENT_WALLET_REQUEST) return { handled: false };
      return disabled();
    }
    return handler(event, payload);
  });

  handle(IPC.AGENT_PAGE_ACTIONS, async (event, payload) => {
    if (!isTrustedSender(event?.sender) || event.sender.isDestroyed?.())
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'The sender is not trusted browser chrome');
    if (previewPending.has(event.sender)) return { ok: false };
    try {
      const { rendererTabId } = validateTabClaimPayload(payload);
      const tabId = automationTabIdForRenderer(event.sender, rendererTabId);
      if (!tabId) return errorEnvelope(AGENT_IPC_ERROR_CODES.TAB_NOT_BOUND, 'The page is not ready');
      previewPending.add(event.sender);
      const preview = await previewPageTools?.(tabId);
      if (event.sender.isDestroyed?.() || automationTabIdForRenderer(event.sender, rendererTabId) !== tabId)
        return { ok: false };
      return { ok: true, ...preview };
    } catch {
      return { ok: false };
    } finally {
      previewPending.delete(event.sender);
    }
  });

  // `freshPage` asks the chrome to move to a start page before it shows the
  // panel, so Agent does not open over the page that asked for it (Settings
  // after the first model is connected, #864).
  handle(IPC.AGENT_OPEN, (event, request) => {
    if (!isTrustedSender(event?.sender) && !options.isProviderSettingsSender?.(event) && !options.isAgentLauncherSender?.(event))
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'Open Agent from the start page or Settings');
    const window = getOwnerWindow?.(event.sender);
    if (!window || window.isDestroyed?.()) return { ok: false };
    if (request?.freshPage === true) window.webContents.send('agent:show', { freshPage: true });
    else window.webContents.send('agent:show');
    return { ok: true };
  });
  // The start page's setup banner needs one bit: is a model connected. Not the
  // provider status itself, which stays with Settings and the chrome.
  handle(IPC.AGENT_SETUP_STATE, (event) => {
    if (!isTrustedSender(event?.sender) && !options.isProviderSettingsSender?.(event) && !options.isAgentLauncherSender?.(event))
      return errorEnvelope(AGENT_IPC_ERROR_CODES.NOT_OWNER, 'Read Agent setup from the start page or Settings');
    try {
      return { ok: true, configured: providerResolver.getStatus()?.configured === true };
    } catch (error) {
      return safeProviderError(error);
    }
  });
  handle(IPC.AGENT_START, handleStart);
  handle(IPC.AGENT_STEER, handleSteer);
  handle(IPC.AGENT_PAUSE, handlePause);
  handle(IPC.AGENT_RESUME, handleResume);
  handle(IPC.AGENT_STOP, handleStop);
  handle(IPC.AGENT_APPROVAL_DECIDE, handleApprovalDecision);
  handle(IPC.AGENT_WALLET_REQUEST, handleAgentWalletRequest);
  handle(IPC.AGENT_GET_STATE, handleGetState);
  handle(IPC.AGENT_CLEAR_CONVERSATION, handleClearConversation);
  handle(IPC.AGENT_HELPER_REPORTS, handleHelperReports);
  handle(IPC.AGENT_HISTORY_LIST, handleHistoryList);
  handle(IPC.AGENT_HISTORY_OPEN, handleHistoryOpen);
  handle(IPC.AGENT_HISTORY_RENAME, handleHistoryRename);
  handle(IPC.AGENT_HISTORY_DELETE, handleHistoryDelete);
  handle(IPC.AGENT_ATTACHMENTS_PICK_FILES, handlePickFiles);
  handle(IPC.AGENT_ATTACHMENTS_DROP_FILES, handleDropFiles);
  handle(IPC.AGENT_ATTACHMENTS_PICK_FOLDER, handlePickFolder);
  handle(IPC.AGENT_ATTACHMENTS_REMOVE, handleRemoveAttachment);
  handle(IPC.AGENT_ATTACHMENTS_REVOKE, handleRevokeAttachment);
  handle(IPC.AGENT_ATTACHMENTS_PREVIEW, handleAttachmentPreview);
  handle(IPC.AGENT_PRIVACY_SETTINGS_SET, handleSetPrivacySettings);
  handle(IPC.AGENT_APPROVAL_MODE_SET, handleSetApprovalMode);
  handle(IPC.AGENT_TAB_CLAIM, handleTabClaim);
  handle(IPC.AGENT_WORKSPACE_HISTORY, handleWorkspaceHistory);
  handle(IPC.AGENT_WORKSPACE_INSPECT, handleWorkspaceInspect);
  handle(IPC.AGENT_PROJECT_ACCESS, handleProjectAccess);
  handle(IPC.AGENT_PROCESS_STOP, handleProcessStop);
  handle(IPC.AGENT_PROCESS_PREVIEW_OPEN, handleProcessPreviewOpen);
  handle(IPC.AGENT_PUBLICATION_OPEN, handleOpenPublication);
  handle(IPC.AGENT_MCP_CONNECTIONS, handleMcpConnections);
  handle(IPC.AGENT_PROVIDER_GET_STATUS, handleProviderStatus);
  handle(IPC.AGENT_PROVIDER_GET_CATALOG, handleProviderCatalog);
  handle(IPC.AGENT_PROVIDER_REFRESH_MODELS, handleRefreshModels);
  handle(IPC.AGENT_PROVIDER_SET_PREFERENCES, handleProviderPreferences);
  handle(IPC.AGENT_PROVIDER_TEST_CONNECTION, handleTestConnection);
  handle(IPC.AGENT_PROVIDER_CONFIGURE_HOSTED, handleConfigureHosted);
  handle(IPC.AGENT_PROVIDER_CONFIGURE_OLLAMA, handleConfigureOllama);
  handle(IPC.AGENT_PROVIDER_LOGIN_SUBSCRIPTION, handleLoginSubscription);
  handle(IPC.AGENT_PROVIDER_CANCEL_LOGIN, handleCancelProviderLogin);
  handle(IPC.AGENT_PROVIDER_SUBMIT_LOGIN, handleSubmitProviderLogin);
  handle(IPC.AGENT_PROVIDER_SELECT_MODEL, handleSelectModel);
  handle(IPC.AGENT_PROVIDER_REMOVE, handleRemoveProvider);
  handle(IPC.AGENT_PROVIDER_CLEAR, handleClearProvider);

  return async () => {
    unsubscribeSettings?.();
    ipcMain.removeHandler?.(IPC.AGENT_OPEN);
    ipcMain.removeHandler?.(IPC.AGENT_SETUP_STATE);
    ipcMain.removeHandler?.(IPC.AGENT_MCP_CONNECTIONS);
    ipcMain.removeHandler?.(IPC.AGENT_START);
    ipcMain.removeHandler?.(IPC.AGENT_STEER);
    ipcMain.removeHandler?.(IPC.AGENT_PAUSE);
    ipcMain.removeHandler?.(IPC.AGENT_RESUME);
    ipcMain.removeHandler?.(IPC.AGENT_STOP);
    ipcMain.removeHandler?.(IPC.AGENT_APPROVAL_DECIDE);
    ipcMain.removeHandler?.(IPC.AGENT_WALLET_REQUEST);
    ipcMain.removeHandler?.(IPC.AGENT_GET_STATE);
    ipcMain.removeHandler?.(IPC.AGENT_PAGE_ACTIONS);
    ipcMain.removeHandler?.(IPC.AGENT_CLEAR_CONVERSATION);
    ipcMain.removeHandler?.(IPC.AGENT_HELPER_REPORTS);
    ipcMain.removeHandler?.(IPC.AGENT_HISTORY_LIST);
    ipcMain.removeHandler?.(IPC.AGENT_HISTORY_OPEN);
    ipcMain.removeHandler?.(IPC.AGENT_HISTORY_RENAME);
    ipcMain.removeHandler?.(IPC.AGENT_HISTORY_DELETE);
    ipcMain.removeHandler?.(IPC.AGENT_ATTACHMENTS_PICK_FILES);
    ipcMain.removeHandler?.(IPC.AGENT_ATTACHMENTS_DROP_FILES);
    ipcMain.removeHandler?.(IPC.AGENT_ATTACHMENTS_PICK_FOLDER);
    ipcMain.removeHandler?.(IPC.AGENT_ATTACHMENTS_REMOVE);
    ipcMain.removeHandler?.(IPC.AGENT_ATTACHMENTS_REVOKE);
    ipcMain.removeHandler?.(IPC.AGENT_ATTACHMENTS_PREVIEW);
    ipcMain.removeHandler?.(IPC.AGENT_APPROVAL_MODE_SET);
    ipcMain.removeHandler?.(IPC.AGENT_PRIVACY_SETTINGS_SET);
    ipcMain.removeHandler?.(IPC.AGENT_TAB_CLAIM);
    ipcMain.removeHandler?.(IPC.AGENT_WORKSPACE_HISTORY);
    ipcMain.removeHandler?.(IPC.AGENT_WORKSPACE_INSPECT);
    ipcMain.removeHandler?.(IPC.AGENT_PROJECT_ACCESS);
    ipcMain.removeHandler?.(IPC.AGENT_PROCESS_STOP);
    ipcMain.removeHandler?.(IPC.AGENT_PROCESS_PREVIEW_OPEN);
    ipcMain.removeHandler?.(IPC.AGENT_PUBLICATION_OPEN);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_GET_STATUS);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_GET_CATALOG);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_REFRESH_MODELS);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_SET_PREFERENCES);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_TEST_CONNECTION);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CONFIGURE_HOSTED);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CONFIGURE_OLLAMA);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_LOGIN_SUBSCRIPTION);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CANCEL_LOGIN);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_SUBMIT_LOGIN);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_SELECT_MODEL);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_REMOVE);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CLEAR);
    unsubscribe();
    if (providerLogin) {
      providerLogin.controller.abort();
      providerLogin.sender.off?.('destroyed', providerLogin.onDestroyed);
      providerLogin = null;
    }
    for (const [sender, onDestroyed] of attachmentOwnerCleanup) {
      sender.off?.('destroyed', onDestroyed);
      attachmentStore.clearStaged(String(sender.id));
    }
    attachmentOwnerCleanup.clear();
    if (owner) {
      const runId = owner.runId;
      detachOwner();
      if (runId) await service.stop(runId);
      await service.clearConversation();
    }
  };
}

module.exports = {
  AGENT_IPC_ERROR_CODES,
  OPENAI_DEVICE_VERIFICATION_URL,
  normalizeSubscriptionAuthEvent,
  registerFreedomAgentIpc,
  registerUnavailableAgentIpc,
  safeProviderError,
  safeServiceError,
  validateStartPayload,
  validateConversationPayload,
};
