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
  AGENT_SECURE_STORAGE_UNAVAILABLE: 'Secure credential storage is unavailable',
  AGENT_CREDENTIAL_UNAVAILABLE: 'The saved provider credential is unavailable',
  AGENT_PROVIDER_STORE_UNSAFE: 'Agent provider storage is unsafe',
  AGENT_PROVIDER_STORE_INVALID: 'Agent provider storage is invalid',
  AGENT_PROVIDER_INVALID: 'Agent provider configuration is invalid',
  AGENT_MODEL_INVALID: 'Selected agent model is invalid',
  AGENT_MODEL_UNAVAILABLE: 'No configured agent model is available',
  AGENT_PROVIDER_AUTH_BUSY: 'A provider sign-in is already in progress',
  AGENT_PROVIDER_AUTH_CANCELLED: 'Provider sign-in was cancelled',
  AGENT_PROVIDER_AUTH_UNSUPPORTED: 'The provider sign-in flow is unsupported',
});

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSubscriptionAuthEvent(event) {
  if (event?.type !== 'device_code') return null;
  if (
    typeof event.userCode !== 'string' ||
    event.userCode !== event.userCode.trim() ||
    !/^[A-Za-z0-9._-]{4,64}$/.test(event.userCode) ||
    event.verificationUri !== OPENAI_DEVICE_VERIFICATION_URL
  ) {
    return null;
  }
  return {
    type: 'device_code',
    providerId: 'openai-codex',
    userCode: event.userCode,
    verificationUri: OPENAI_DEVICE_VERIFICATION_URL,
  };
}

function errorEnvelope(code, message) {
  return { ok: false, error: { code, message } };
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
  if (!Number.isSafeInteger(payload.rendererTabId) || payload.rendererTabId < 1) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent input requires a valid renderer tab ID'
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
  return { rendererTabId: payload.rendererTabId, prompt: payload.prompt, approvalMode };
}

function validateConversationPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new FreedomAgentError(AGENT_ERROR_CODES.INVALID_ARGUMENT, 'Agent session input is required');
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
    createAutomationPageForHost,
    desktopBindingForAutomationTab,
    resolveModel,
    providerResolver,
    isTrustedSender,
    openExternal,
  } = options;
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('Freedom agent IPC requires ipcMain');
  }
  if (
    !service ||
    typeof service.start !== 'function' ||
    typeof service.pause !== 'function' ||
    typeof service.resume !== 'function' ||
    typeof service.stop !== 'function' ||
    typeof service.clearConversation !== 'function' ||
    typeof service.listConversations !== 'function' ||
    typeof service.listAgentTabs !== 'function' ||
    typeof service.claimTab !== 'function' ||
    typeof service.openConversation !== 'function' ||
    typeof service.renameConversation !== 'function' ||
    typeof service.deleteConversation !== 'function' ||
    typeof service.decideApproval !== 'function' ||
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

  let owner = null;
  let startPending = false;
  let providerLogin = null;
  let providerMutationPending = false;

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
      (owner.conversationId && owner.conversationId !== event.conversationId) ||
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

  const handleStart = async (event, rawPayload) => {
    if (startPending || owner?.runId) {
      return errorEnvelope(AGENT_ERROR_CODES.BUSY, 'Freedom agent already has an active run');
    }
    startPending = true;
    try {
      if (!isTrustedSender(event?.sender)) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'The sender is not trusted browser chrome'
        );
      }
      const { rendererTabId, prompt, approvalMode } = validateStartPayload(rawPayload);
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
      const needsRuntime = !continuing || service.getState().runtimeAvailable !== true;
      if (needsRuntime) {
        tabId = automationTabIdForRenderer(event?.sender, rendererTabId);
        if (!tabId) {
          return errorEnvelope(
            AGENT_IPC_ERROR_CODES.TAB_NOT_BOUND,
            'The selected browser tab is not ready for the agent'
          );
        }
        try {
          resolved = await resolveModel();
        } catch (error) {
          const errorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
          console.error('[agent] Model resolution failed:', errorCode);
          return errorEnvelope(
            AGENT_IPC_ERROR_CODES.MODEL_UNAVAILABLE,
            'No configured agent model is available'
          );
        }
        if (!resolved?.model || !resolved?.modelRuntime) {
          return errorEnvelope(
            AGENT_IPC_ERROR_CODES.MODEL_UNAVAILABLE,
            'No configured agent model is available'
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

      let started;
      try {
        started = await service.start({
          prompt,
          approvalMode,
          ...(needsRuntime && {
            tabId,
            createWorkspacePage: (url) =>
              createAutomationPageForHost(pendingOwner.sender, url),
            model: resolved.model,
            modelRuntime: resolved.modelRuntime,
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
      return { ok: true, resumed: await service.resume(owner.runId) };
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
    const decided = await service.decideApproval(
      owner.runId,
      payload.approvalId,
      payload.approved
    );
    return decided
      ? { ok: true, decided: true }
      : errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'The sender does not own that agent approval'
        );
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
    const workspace = ownsSelectedConversation
      ? service.getWorkspaceState()
      : { tabIds: [], activeTabId: null };
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
        ...(ownsSelectedConversation ? service.getState() : { status: 'idle' }),
        rendererTabId: ownsSelectedConversation ? owner.rendererTabId : null,
        taskTabs,
        agentTabs,
      },
    };
  };

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

  const handleHistoryList = (event) =>
    trustedHistoryRequest(event, () => ({ ok: true, sessions: service.listConversations() }));

  const handleHistoryOpen = async (event, payload) => {
    const trusted = trustedHistoryRequest(event, () => ({ ok: true }));
    if (!trusted.ok) return trusted;
    if (owner?.runId || owner?.starting) {
      return errorEnvelope(AGENT_ERROR_CODES.BUSY, 'Take over the active turn before switching sessions');
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

  const handleProviderRequest = async (event, action) => {
    let trusted;
    try {
      trusted = isTrustedSender(event?.sender);
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
        return await action();
      } finally {
        providerMutationPending = false;
      }
    });
  const handleConfigureHosted = (event, payload) =>
    handleProviderMutation(event, async () => ({
      status: await providerResolver.configureHosted(payload),
    }));
  const handleConfigureOllama = (event, payload) =>
    handleProviderMutation(event, () => ({ status: providerResolver.configureOllama(payload) }));
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
        sender: event.sender,
        controller,
        onDestroyed: () => controller.abort(),
      };
      providerLogin = pending;
      event.sender.once?.('destroyed', pending.onDestroyed);
      try {
        const status = await providerResolver.loginSubscription(payload, {
          signal: controller.signal,
          prompt: async (prompt) => {
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
            const normalized = normalizeSubscriptionAuthEvent(authEvent);
            if (!normalized || controller.signal.aborted) return;
            try {
              pending.sender.send(IPC.AGENT_PROVIDER_AUTH_EVENT, normalized);
              Promise.resolve(openExternal(normalized.verificationUri)).catch(() => {});
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
        pending.sender.off?.('destroyed', pending.onDestroyed);
        if (providerLogin === pending) providerLogin = null;
      }
    });
  const handleCancelProviderLogin = (event) =>
    handleProviderRequest(event, () => {
      if (!providerLogin || providerLogin.sender !== event?.sender) {
        throw providerError('AGENT_PROVIDER_AUTH_CANCELLED', 'Provider sign-in was cancelled');
      }
      providerLogin.controller.abort();
      return { cancelled: true };
    });
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

  ipcMain.handle(IPC.AGENT_START, handleStart);
  ipcMain.handle(IPC.AGENT_PAUSE, handlePause);
  ipcMain.handle(IPC.AGENT_RESUME, handleResume);
  ipcMain.handle(IPC.AGENT_STOP, handleStop);
  ipcMain.handle(IPC.AGENT_APPROVAL_DECIDE, handleApprovalDecision);
  ipcMain.handle(IPC.AGENT_GET_STATE, handleGetState);
  ipcMain.handle(IPC.AGENT_CLEAR_CONVERSATION, handleClearConversation);
  ipcMain.handle(IPC.AGENT_HISTORY_LIST, handleHistoryList);
  ipcMain.handle(IPC.AGENT_HISTORY_OPEN, handleHistoryOpen);
  ipcMain.handle(IPC.AGENT_HISTORY_RENAME, handleHistoryRename);
  ipcMain.handle(IPC.AGENT_HISTORY_DELETE, handleHistoryDelete);
  ipcMain.handle(IPC.AGENT_TAB_CLAIM, handleTabClaim);
  ipcMain.handle(IPC.AGENT_PROVIDER_GET_STATUS, handleProviderStatus);
  ipcMain.handle(IPC.AGENT_PROVIDER_GET_CATALOG, handleProviderCatalog);
  ipcMain.handle(IPC.AGENT_PROVIDER_CONFIGURE_HOSTED, handleConfigureHosted);
  ipcMain.handle(IPC.AGENT_PROVIDER_CONFIGURE_OLLAMA, handleConfigureOllama);
  ipcMain.handle(IPC.AGENT_PROVIDER_LOGIN_SUBSCRIPTION, handleLoginSubscription);
  ipcMain.handle(IPC.AGENT_PROVIDER_CANCEL_LOGIN, handleCancelProviderLogin);
  ipcMain.handle(IPC.AGENT_PROVIDER_SELECT_MODEL, handleSelectModel);
  ipcMain.handle(IPC.AGENT_PROVIDER_REMOVE, handleRemoveProvider);
  ipcMain.handle(IPC.AGENT_PROVIDER_CLEAR, handleClearProvider);

  return async () => {
    ipcMain.removeHandler?.(IPC.AGENT_START);
    ipcMain.removeHandler?.(IPC.AGENT_PAUSE);
    ipcMain.removeHandler?.(IPC.AGENT_RESUME);
    ipcMain.removeHandler?.(IPC.AGENT_STOP);
    ipcMain.removeHandler?.(IPC.AGENT_APPROVAL_DECIDE);
    ipcMain.removeHandler?.(IPC.AGENT_GET_STATE);
    ipcMain.removeHandler?.(IPC.AGENT_CLEAR_CONVERSATION);
    ipcMain.removeHandler?.(IPC.AGENT_HISTORY_LIST);
    ipcMain.removeHandler?.(IPC.AGENT_HISTORY_OPEN);
    ipcMain.removeHandler?.(IPC.AGENT_HISTORY_RENAME);
    ipcMain.removeHandler?.(IPC.AGENT_HISTORY_DELETE);
    ipcMain.removeHandler?.(IPC.AGENT_TAB_CLAIM);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_GET_STATUS);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_GET_CATALOG);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CONFIGURE_HOSTED);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CONFIGURE_OLLAMA);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_LOGIN_SUBSCRIPTION);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CANCEL_LOGIN);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_SELECT_MODEL);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_REMOVE);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CLEAR);
    unsubscribe();
    if (providerLogin) {
      providerLogin.controller.abort();
      providerLogin.sender.off?.('destroyed', providerLogin.onDestroyed);
      providerLogin = null;
    }
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
  safeProviderError,
  safeServiceError,
  validateStartPayload,
  validateConversationPayload,
};
