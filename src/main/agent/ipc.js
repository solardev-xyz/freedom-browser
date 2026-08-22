'use strict';

const IPC = require('../../shared/ipc-channels');
const { normalizeAgentNavigationScope } = require('../../shared/agent-navigation-scopes');
const { AGENT_ERROR_CODES, FreedomAgentError } = require('./freedom-agent-service');

const AGENT_IPC_ERROR_CODES = Object.freeze({
  TAB_NOT_BOUND: 'AGENT_TAB_NOT_BOUND',
  MODEL_UNAVAILABLE: 'AGENT_MODEL_UNAVAILABLE',
  NOT_OWNER: 'AGENT_NOT_OWNER',
  INTERNAL_ERROR: 'AGENT_INTERNAL_ERROR',
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
  const navigationScope = normalizeAgentNavigationScope(payload.navigationScope);
  if (!navigationScope) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent input requires a valid navigation scope'
    );
  }
  return { rendererTabId: payload.rendererTabId, prompt: payload.prompt, navigationScope };
}

function registerFreedomAgentIpc(options = {}) {
  const {
    ipcMain,
    service,
    automationTabIdForRenderer,
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
    typeof service.decideApproval !== 'function' ||
    typeof service.subscribe !== 'function' ||
    typeof service.getState !== 'function'
  ) {
    throw new TypeError('Freedom agent IPC requires an agent service');
  }
  if (typeof automationTabIdForRenderer !== 'function') {
    throw new TypeError('Freedom agent IPC requires the desktop tab binding resolver');
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

  const stopOwnedRun = () => {
    if (!owner || owner.stopping) return;
    owner.stopping = true;
    Promise.resolve(service.stop(owner.runId || undefined)).catch(() => {});
  };

  const sendEvent = (event) => {
    if (!owner || (owner.runId && owner.runId !== event.runId)) return;
    if (!owner.runId) {
      owner.buffer.push(event);
      return;
    }
    try {
      if (owner.sender.isDestroyed?.()) {
        stopOwnedRun();
        if (event.type === 'run_finished') detachOwner();
        return;
      }
      owner.sender.send(IPC.AGENT_EVENT, event);
    } catch {
      stopOwnedRun();
      if (event.type === 'run_finished') detachOwner();
      return;
    }
    if (event.type === 'run_finished') detachOwner();
  };

  const unsubscribe = service.subscribe(sendEvent);

  const handleStart = async (event, rawPayload) => {
    if (owner || startPending) {
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
      const { rendererTabId, prompt, navigationScope } = validateStartPayload(rawPayload);
      const tabId = automationTabIdForRenderer(event?.sender, rendererTabId);
      if (!tabId) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.TAB_NOT_BOUND,
          'The selected browser tab is not ready for the agent'
        );
      }

      let resolved;
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
      if (!event?.sender || event.sender.isDestroyed?.()) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.NOT_OWNER,
          'The browser window is no longer available'
        );
      }

      const pendingOwner = {
        sender: event.sender,
        rendererTabId,
        runId: null,
        buffer: [],
        stopping: false,
        onDestroyed: () => stopOwnedRun(),
      };
      owner = pendingOwner;
      event.sender.once?.('destroyed', pendingOwner.onDestroyed);

      let started;
      try {
        started = await service.start({
          prompt,
          tabId,
          navigationScope,
          model: resolved.model,
          modelRuntime: resolved.modelRuntime,
          thinkingLevel: resolved.thinkingLevel,
        });
      } catch (error) {
        if (owner === pendingOwner) detachOwner();
        return safeServiceError(error);
      }

      if (owner !== pendingOwner) {
        return errorEnvelope(
          AGENT_IPC_ERROR_CODES.INTERNAL_ERROR,
          'The embedded agent request failed unexpectedly'
        );
      }
      pendingOwner.runId = started.runId;
      if (pendingOwner.stopping || pendingOwner.sender.isDestroyed?.()) {
        pendingOwner.stopping = true;
        Promise.resolve(service.stop(started.runId)).catch(() => {});
      }
      const buffered = pendingOwner.buffer;
      pendingOwner.buffer = [];
      for (const bufferedEvent of buffered) sendEvent(bufferedEvent);
      return { ok: true, runId: started.runId };
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
    if (!owner || owner.sender !== event?.sender) return { ok: true, state: { status: 'idle' } };
    return {
      ok: true,
      state: { ...service.getState(), rendererTabId: owner.rendererTabId },
    };
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
};
