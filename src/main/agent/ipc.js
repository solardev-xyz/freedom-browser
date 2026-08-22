'use strict';

const IPC = require('../../shared/ipc-channels');
const { AGENT_ERROR_CODES, FreedomAgentError } = require('./freedom-agent-service');

const AGENT_IPC_ERROR_CODES = Object.freeze({
  TAB_NOT_BOUND: 'AGENT_TAB_NOT_BOUND',
  MODEL_UNAVAILABLE: 'AGENT_MODEL_UNAVAILABLE',
  NOT_OWNER: 'AGENT_NOT_OWNER',
  INTERNAL_ERROR: 'AGENT_INTERNAL_ERROR',
});
const SAFE_PROVIDER_ERROR_MESSAGES = Object.freeze({
  AGENT_SECURE_STORAGE_UNAVAILABLE: 'Secure credential storage is unavailable',
  AGENT_CREDENTIAL_UNAVAILABLE: 'The saved provider credential is unavailable',
  AGENT_PROVIDER_STORE_UNSAFE: 'Agent provider storage is unsafe',
  AGENT_PROVIDER_STORE_INVALID: 'Agent provider storage is invalid',
  AGENT_PROVIDER_INVALID: 'Agent provider configuration is invalid',
  AGENT_MODEL_INVALID: 'Selected agent model is invalid',
  AGENT_MODEL_UNAVAILABLE: 'No configured agent model is available',
});

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
  return { rendererTabId: payload.rendererTabId, prompt: payload.prompt };
}

function registerFreedomAgentIpc(options = {}) {
  const {
    ipcMain,
    service,
    automationTabIdForRenderer,
    resolveModel,
    providerResolver,
    isTrustedSender,
  } = options;
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('Freedom agent IPC requires ipcMain');
  }
  if (
    !service ||
    typeof service.start !== 'function' ||
    typeof service.stop !== 'function' ||
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
    typeof providerResolver.clear !== 'function'
  ) {
    throw new TypeError('Freedom agent IPC requires a provider resolver');
  }
  if (typeof isTrustedSender !== 'function') {
    throw new TypeError('Freedom agent IPC requires a trusted chrome sender check');
  }

  let owner = null;
  let startPending = false;

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
      const { rendererTabId, prompt } = validateStartPayload(rawPayload);
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
      } catch {
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

  const handleGetState = (event) => {
    if (!owner || owner.sender !== event?.sender) return { ok: true, state: { status: 'idle' } };
    return { ok: true, state: service.getState() };
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
  const handleConfigureHosted = (event, payload) =>
    handleProviderRequest(event, async () => ({
      status: await providerResolver.configureHosted(payload),
    }));
  const handleConfigureOllama = (event, payload) =>
    handleProviderRequest(event, () => ({ status: providerResolver.configureOllama(payload) }));
  const handleClearProvider = (event) =>
    handleProviderRequest(event, () => ({ status: providerResolver.clear() }));

  ipcMain.handle(IPC.AGENT_START, handleStart);
  ipcMain.handle(IPC.AGENT_STOP, handleStop);
  ipcMain.handle(IPC.AGENT_GET_STATE, handleGetState);
  ipcMain.handle(IPC.AGENT_PROVIDER_GET_STATUS, handleProviderStatus);
  ipcMain.handle(IPC.AGENT_PROVIDER_GET_CATALOG, handleProviderCatalog);
  ipcMain.handle(IPC.AGENT_PROVIDER_CONFIGURE_HOSTED, handleConfigureHosted);
  ipcMain.handle(IPC.AGENT_PROVIDER_CONFIGURE_OLLAMA, handleConfigureOllama);
  ipcMain.handle(IPC.AGENT_PROVIDER_CLEAR, handleClearProvider);

  return async () => {
    ipcMain.removeHandler?.(IPC.AGENT_START);
    ipcMain.removeHandler?.(IPC.AGENT_STOP);
    ipcMain.removeHandler?.(IPC.AGENT_GET_STATE);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_GET_STATUS);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_GET_CATALOG);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CONFIGURE_HOSTED);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CONFIGURE_OLLAMA);
    ipcMain.removeHandler?.(IPC.AGENT_PROVIDER_CLEAR);
    unsubscribe();
    if (owner) {
      const runId = owner.runId;
      detachOwner();
      if (runId) await service.stop(runId);
    }
  };
}

module.exports = {
  AGENT_IPC_ERROR_CODES,
  registerFreedomAgentIpc,
  safeProviderError,
  safeServiceError,
  validateStartPayload,
};
