'use strict';

const crypto = require('crypto');
const {
  AGENT_APPROVAL_MODES,
  normalizeAgentApprovalMode,
} = require('../../shared/agent-approval-modes');
const { AGENT_NAVIGATION_SCOPES } = require('../../shared/agent-navigation-scopes');
const { OPERATIONS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');
const { getPermissionKey } = require('../../shared/origin-utils');
const log = require('../logger');
const {
  createOriginScopedAutomationController,
  originScopeForUrl,
} = require('../automation/origin-scoped-controller');
const { createFreedomBrowserTools } = require('./pi-browser-tools');
const { EffectClassifier } = require('./effect-classifier');
const {
  activityProgress,
  buildAgentOutcome,
  normalizeArtifact,
  normalizeDiagnosticReceipt,
  normalizeNodeRequestReceipt,
  normalizeNodeStatusReceipt,
  normalizeUpload,
  normalizeWalletReceipt,
} = require('./agent-progress');
const { loadPiSdk } = require('./pi-sdk');
const {
  createIsolatedPiSession,
  DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT,
} = require('./pi-session-factory');

const AGENT_EVENT_VERSION = 1;
const MAX_AGENT_PROMPT_LENGTH = 32_000;
const AGENT_ERROR_CODES = Object.freeze({
  BUSY: 'AGENT_BUSY',
  DISPOSED: 'AGENT_DISPOSED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  SESSION_START_FAILED: 'SESSION_START_FAILED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  MODEL_OUTPUT_LIMIT: 'MODEL_OUTPUT_LIMIT',
  RESUME_SCOPE_CHANGED: 'AGENT_RESUME_SCOPE_CHANGED',
  TAB_UNAVAILABLE: 'TAB_UNAVAILABLE',
  RUN_FAILED: 'RUN_FAILED',
});
const AUTOMATION_ERROR_CODE_SET = new Set(Object.values(ERROR_CODES));
const RESUME_PROMPT = `The user resumed this task after potentially changing the browser workspace. Do not reuse earlier element references or assumptions. If a task tab remains, get its current state and take a fresh snapshot before acting. If no task tab remains, create a fresh task tab before continuing. Preserve user changes unless they conflict with the task.`;
const EVERY_INTERACTION_SYSTEM_PROMPT = `${DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT}

This run requires user approval before every page interaction. Reading pages, navigating, and managing task-owned tabs do not require approval. Click, type, select, and press tools pause until the user approves or declines the exact interaction.`;
const EMPTY_WORKSPACE_SYSTEM_PROMPT = `No existing browser page was shared with this conversation. You cannot inspect unrelated user tabs. Create a fresh task tab before reading or interacting with the web.`;
const RESTORED_SESSION_PROMPT = `This conversation was restored from Freedom's saved session history. Only the visible user and assistant conversation was retained. Earlier browser tool results, page snapshots, element references, and control grants were deliberately not restored. Reinspect the current browser workspace before acting and do not assume an earlier page or action is still available.`;
const PROVIDER_LABELS = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  freepi: 'Free Pi',
  'openai-codex': 'ChatGPT (Codex)',
  ollama: 'Ollama',
});

class FreedomAgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FreedomAgentError';
    this.code = code;
  }
}

function opaqueRunId() {
  return `run_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function opaqueConversationId() {
  return `conversation_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function opaqueApprovalId() {
  return `approval_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function opaqueGuidanceId() {
  return `guidance_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function validatePromptOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent run options are required'
    );
  }
  if (typeof options.prompt !== 'string' || !options.prompt.trim()) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent prompt must be a non-empty string'
    );
  }
  if (options.prompt.length > MAX_AGENT_PROMPT_LENGTH) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      `Agent prompt cannot exceed ${MAX_AGENT_PROMPT_LENGTH} characters`
    );
  }
  const approvalMode = normalizeAgentApprovalMode(options.approvalMode);
  if (!approvalMode) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent run requires a supported approval mode'
    );
  }
  return { prompt: options.prompt.trim(), approvalMode };
}

function validateGuidanceText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent guidance must be a non-empty string'
    );
  }
  if (value.length > MAX_AGENT_PROMPT_LENGTH) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      `Agent guidance cannot exceed ${MAX_AGENT_PROMPT_LENGTH} characters`
    );
  }
  return value.trim();
}

function piMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function validateStartOptions(options) {
  const promptOptions = validatePromptOptions(options);
  if (
    options.tabId !== null &&
    options.tabId !== undefined &&
    (typeof options.tabId !== 'string' || !options.tabId.trim())
  ) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent run requires a valid assigned tab ID or an empty workspace'
    );
  }
  if (typeof options.tabId === 'string' && options.tabId !== options.tabId.trim()) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent tab ID cannot contain surrounding whitespace'
    );
  }
  if (!options.model || !options.modelRuntime) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent run requires a selected model and model runtime'
    );
  }
  if (typeof options.createWorkspacePage !== 'function') {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent run requires a browser workspace tab creation capability'
    );
  }
  return {
    ...promptOptions,
    tabId: typeof options.tabId === 'string' ? options.tabId : null,
    createWorkspacePage: options.createWorkspacePage,
  };
}

function normalizePiEvent(event, toolOutcome) {
  if (!event || typeof event !== 'object') return null;

  if (
    event.type === 'message_update' &&
    event.assistantMessageEvent?.type === 'text_delta' &&
    typeof event.assistantMessageEvent.delta === 'string'
  ) {
    return { type: 'assistant_text_delta', text: event.assistantMessageEvent.delta };
  }
  if (event.type === 'tool_execution_start') {
    const progress = activityProgress(String(event.toolName), {
      origin:
        event.toolName === 'browser_create_tab' || event.toolName === 'browser_navigate'
          ? event.args?.url
          : undefined,
    });
    return {
      type: 'tool_started',
      toolCallId: String(event.toolCallId),
      operation: String(event.toolName),
      ...progress,
    };
  }
  if (event.type === 'tool_execution_end') {
    const errorCode =
      event.isError && toolOutcome?.status === 'failed' ? toolOutcome.errorCode : undefined;
    const progress = toolOutcome?.progress || activityProgress(String(event.toolName));
    return {
      type: 'tool_finished',
      toolCallId: String(event.toolCallId),
      operation: String(event.toolName),
      status: event.isError ? 'failed' : 'succeeded',
      ...progress,
      ...(toolOutcome?.artifact && { artifact: toolOutcome.artifact }),
      ...(toolOutcome?.upload && { upload: toolOutcome.upload }),
      ...(toolOutcome?.wallet && { wallet: toolOutcome.wallet }),
      ...(toolOutcome?.nodeStatus && { nodeStatus: toolOutcome.nodeStatus }),
      ...(toolOutcome?.nodeRequest && { nodeRequest: toolOutcome.nodeRequest }),
      ...(toolOutcome?.diagnostic && { diagnostic: toolOutcome.diagnostic }),
      ...(toolOutcome?.artifacts && { artifacts: toolOutcome.artifacts }),
      ...(errorCode && { errorCode }),
    };
  }
  if (event.type === 'auto_retry_start') {
    return {
      type: 'run_retrying',
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
    };
  }
  if (event.type === 'compaction_start') {
    return {
      type: 'context_compaction_started',
      reason: ['threshold', 'overflow'].includes(event.reason) ? event.reason : 'manual',
    };
  }
  if (event.type === 'compaction_end') {
    return {
      type: 'context_compaction_finished',
      reason: ['threshold', 'overflow'].includes(event.reason) ? event.reason : 'manual',
      status: event.aborted || event.errorMessage ? 'failed' : 'succeeded',
    };
  }
  return null;
}

function terminalError(code, message) {
  return Object.freeze({ code, message });
}

function normalizeDiagnosticApproval(value, recipient = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scope = value.scope === 'node' ? 'node' : value.scope === 'app' ? 'app' : null;
  if (!scope) return null;
  const service = typeof value.service === 'string' ? value.service.slice(0, 40) : '';
  if (scope === 'node' && !service) return null;
  const providerId =
    typeof recipient.providerId === 'string' ? recipient.providerId.slice(0, 80) : '';
  const modelId = typeof recipient.modelId === 'string' ? recipient.modelId.slice(0, 160) : '';
  return Object.freeze({
    scope,
    ...(service && { service }),
    maxLines: Number.isSafeInteger(value.maxLines) ? value.maxLines : 200,
    maxBytes: Number.isSafeInteger(value.maxBytes) ? value.maxBytes : 49_152,
    providerId,
    providerLabel: PROVIDER_LABELS[providerId] || providerId || 'the selected model provider',
    modelId,
    local: providerId === 'ollama',
  });
}

function normalizeApprovalRequest(request, recipient) {
  const wallet = normalizeWalletApproval(request?.wallet);
  const diagnostic = normalizeDiagnosticApproval(request?.diagnostic, recipient);
  const nodeRequest = normalizeNodeRequestApproval(request?.nodeRequest, recipient);
  const origin = wallet
    ? getPermissionKey(request?.origin) || ''
    : originScopeForUrl(request?.origin) || '';
  return Object.freeze({
    action: nodeRequest
      ? 'node_request'
      : diagnostic
      ? 'diagnostic_data'
      : request?.action === 'form_submission'
        ? 'form_submission'
        : request?.action === 'file_download'
          ? 'file_download'
          : request?.action === 'file_upload'
            ? 'file_upload'
            : [
                  'wallet_connection',
                  'wallet_transaction',
                  'wallet_signature',
                  'wallet_transfer',
                ].includes(
                  request?.action
                )
              ? request.action
              : 'browser_interaction',
    operation: typeof request?.operation === 'string' ? request.operation.slice(0, 80) : '',
    origin,
    destinationOrigin: wallet
      ? getPermissionKey(request?.destinationOrigin) || origin
      : originScopeForUrl(request?.destinationOrigin) || '',
    label: typeof request?.label === 'string' ? request.label.slice(0, 160) : '',
    ...(wallet && { wallet }),
    ...(diagnostic && { diagnostic }),
    ...(nodeRequest && { nodeRequest }),
  });
}

function normalizeNodeRequestApproval(value, recipient = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.service !== 'ant' || value.transport !== 'http') return null;
  const request = value.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const method = typeof request.method === 'string' ? request.method.slice(0, 12) : '';
  const path = typeof request.path === 'string' ? request.path.slice(0, 2_048) : '';
  if (!method || !path) return null;
  const headers = {};
  for (const [name, headerValue] of Object.entries(request.headers || {}).slice(0, 32)) {
    if (typeof headerValue === 'string') headers[name.slice(0, 120)] = headerValue.slice(0, 4_096);
  }
  const classification = value.classification;
  const providerId =
    typeof recipient.providerId === 'string' ? recipient.providerId.slice(0, 80) : '';
  return Object.freeze({
    service: 'ant',
    transport: 'http',
    request: Object.freeze({
      method,
      path,
      ...(Object.keys(headers).length && { headers: Object.freeze(headers) }),
      ...(typeof request.body === 'string' && { body: request.body.slice(0, 65_536) }),
    }),
    effect: [
      'read',
      'reversible_admin',
      'persistent_change',
      'financial',
      'destructive',
      'unknown',
    ].includes(value.effect)
      ? value.effect
      : 'unknown',
    classification: Object.freeze({
      summary:
        typeof classification?.summary === 'string'
          ? classification.summary.slice(0, 240)
          : 'The effect could not be classified reliably.',
      confidence: Number.isFinite(classification?.confidence)
        ? Math.max(0, Math.min(1, classification.confidence))
        : 0,
      uncertainties: Object.freeze(
        Array.isArray(classification?.uncertainties)
          ? classification.uncertainties
              .filter((item) => typeof item === 'string')
              .slice(0, 12)
              .map((item) => item.slice(0, 240))
          : []
      ),
    }),
    providerId,
    providerLabel: PROVIDER_LABELS[providerId] || providerId || 'the selected model provider',
    modelId: typeof recipient.modelId === 'string' ? recipient.modelId.slice(0, 160) : '',
    local: providerId === 'ollama',
  });
}

function normalizeWalletApproval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!['connection', 'transaction', 'signature', 'transfer'].includes(value.kind)) return null;
  const normalizeAccount = (account) => {
    if (!Number.isSafeInteger(account?.index) || account.index < 0 || !account.address) return null;
    return Object.freeze({
      index: account.index,
      name: typeof account.name === 'string' ? account.name.slice(0, 80) : '',
      address: typeof account.address === 'string' ? account.address.slice(0, 80) : '',
      type: ['mnemonic', 'ledger', 'remote'].includes(account.type) ? account.type : 'mnemonic',
    });
  };
  const wallets = Array.isArray(value.wallets)
    ? value.wallets.map(normalizeAccount).filter(Boolean).slice(0, 50)
    : [];
  const account = normalizeAccount(value.account);
  return Object.freeze({
    kind: value.kind,
    chainId: Number.isSafeInteger(value.chainId) ? value.chainId : 0,
    chainName: typeof value.chainName === 'string' ? value.chainName.slice(0, 80) : '',
    ...(wallets.length && { wallets }),
    ...(account && { account }),
    ...(Number.isSafeInteger(value.defaultWalletIndex) && value.defaultWalletIndex >= 0
      ? { defaultWalletIndex: value.defaultWalletIndex }
      : {}),
    ...(typeof value.to === 'string' && { to: value.to.slice(0, 400) }),
    ...(typeof value.value === 'string' && { value: value.value.slice(0, 100) }),
    ...(typeof value.maxFee === 'string' && { maxFee: value.maxFee.slice(0, 100) }),
    ...(typeof value.data === 'string' && { data: value.data.slice(0, 65_536) }),
    ...(typeof value.tokenContract === 'string' && {
      tokenContract: value.tokenContract.slice(0, 100),
    }),
    ...(typeof value.recipientVerification === 'string' && {
      recipientVerification: value.recipientVerification.slice(0, 160),
    }),
    ...(typeof value.signatureType === 'string' && {
      signatureType: value.signatureType.slice(0, 80),
    }),
    ...(typeof value.summary === 'string' && { summary: value.summary.slice(0, 65_536) }),
    requiresUnlock: value.requiresUnlock === true,
  });
}

class FreedomAgentService {
  constructor(options = {}) {
    if (!options.controller || typeof options.controller.execute !== 'function') {
      throw new TypeError('FreedomAgentService requires an automation controller');
    }
    this.controller = options.controller;
    this.loadSdk = options.loadSdk || loadPiSdk;
    this.createControllerScope =
      options.createControllerScope || createOriginScopedAutomationController;
    this.createTools = options.createTools || createFreedomBrowserTools;
    this.createSession = options.createSession || createIsolatedPiSession;
    this.effectClassifier = options.effectClassifier || new EffectClassifier();
    if (!this.effectClassifier || typeof this.effectClassifier.classify !== 'function') {
      throw new TypeError('FreedomAgentService requires a valid effect classifier');
    }
    if (
      options.cancelAgentDownloads !== undefined &&
      typeof options.cancelAgentDownloads !== 'function'
    ) {
      throw new TypeError('FreedomAgentService requires a valid Agent download canceller');
    }
    this.cancelAgentDownloads = options.cancelAgentDownloads || (() => 0);
    if (
      options.walletController !== undefined &&
      typeof options.walletController?.handleRequest !== 'function'
    ) {
      throw new TypeError('FreedomAgentService requires a valid Agent wallet controller');
    }
    this.walletController = options.walletController || null;
    this.historyStore = options.historyStore || null;
    if (
      this.historyStore &&
      [
        'createSession',
        'startTurn',
        'finishTurn',
        'listSessions',
        'getSession',
        'updateTurnGuidance',
        'renameSession',
        'deleteSession',
      ].some((method) => typeof this.historyStore[method] !== 'function')
    ) {
      throw new TypeError('FreedomAgentService requires a complete Agent history store');
    }
    this.runIdFactory = options.runIdFactory || opaqueRunId;
    this.conversationIdFactory = options.conversationIdFactory || opaqueConversationId;
    this.guidanceIdFactory = options.guidanceIdFactory || opaqueGuidanceId;
    this.now = options.now || Date.now;
    this.listeners = new Set();
    this.conversations = new Map();
    this.agentTabs = new Map();
    this.conversation = null;
    this.activeRun = null;
    this.disposed = false;
    this.sequence = 0;
    this.unsubscribeTabLifecycle = null;
    if (options.subscribeTabLifecycle !== undefined) {
      if (typeof options.subscribeTabLifecycle !== 'function') {
        throw new TypeError('FreedomAgentService requires a tab lifecycle subscriber');
      }
      const unsubscribe = options.subscribeTabLifecycle((event) => this.#handleTabLifecycle(event));
      if (typeof unsubscribe !== 'function') {
        throw new TypeError(
          'Automation tab lifecycle subscription must return an unsubscribe function'
        );
      }
      this.unsubscribeTabLifecycle = unsubscribe;
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Freedom agent event listener must be a function');
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState() {
    if (this.disposed) return { status: 'disposed' };
    const conversation = this.conversation;
    if (!conversation) return { status: 'idle' };
    const transcript = conversation.turns.map((turn) => ({
      runId: turn.runId,
      userText: turn.userText,
      assistantText: turn.assistantText,
      status: turn.status,
      startedAt: turn.startedAt,
      ...(Number.isFinite(turn.durationMs) && { durationMs: turn.durationMs }),
      activity: turn.activity.map((item) => ({ ...item })),
      guidance: turn.guidance.map((item) => ({ ...item })),
      outcome: turn.outcome || buildAgentOutcome(turn.activity, turn.status, turn.error),
      ...(turn.error && { error: turn.error }),
    }));
    if (!this.activeRun) {
      return {
        status: 'ready',
        conversationId: conversation.conversationId,
        tabId: conversation.tabId,
        approvalMode: conversation.approvalMode,
        title: conversation.title,
        runtimeAvailable: Boolean(conversation.session && conversation.scopedController),
        transcript,
      };
    }
    return {
      status: this.activeRun.status,
      conversationId: conversation.conversationId,
      runId: this.activeRun.runId,
      tabId: this.activeRun.tabId,
      approvalMode: conversation.approvalMode,
      title: conversation.title,
      runtimeAvailable: Boolean(conversation.session && conversation.scopedController),
      transcript,
      ...(this.activeRun.pendingApproval && {
        pendingApproval: this.activeRun.pendingApproval.publicRequest,
      }),
    };
  }

  listConversations() {
    return this.historyStore ? this.historyStore.listSessions() : [];
  }

  listAgentTabs() {
    return [...this.agentTabs.values()]
      .filter((record) => record.custody === 'agent')
      .map((record) => ({ ...record }));
  }

  async openConversation(conversationId) {
    if (this.disposed || this.activeRun || !this.historyStore) return null;
    const liveConversation = this.conversations.get(conversationId);
    if (liveConversation) {
      this.conversation = liveConversation;
      return this.getState();
    }
    const stored = this.historyStore.getSession(conversationId);
    if (!stored) return null;
    this.conversation = {
      conversationId: stored.conversationId,
      title: stored.title,
      tabId: null,
      approvalMode: stored.approvalMode,
      session: null,
      scopedController: null,
      unsubscribe: null,
      turns: stored.transcript.map((turn) => ({
        ...turn,
        activity: turn.activity.map((item) => ({ ...item })),
        guidance: Array.isArray(turn.guidance) ? turn.guidance.map((item) => ({ ...item })) : [],
        activeRun: null,
        finished: true,
      })),
      activeRun: null,
      restored: true,
      providerId: stored.providerId || '',
      providerLabel:
        PROVIDER_LABELS[stored.providerId] || stored.providerId || 'the selected model provider',
      modelId: stored.modelId || '',
    };
    this.conversations.set(stored.conversationId, this.conversation);
    return this.getState();
  }

  renameConversation(conversationId, title) {
    if (!this.historyStore) return null;
    const renamed = this.historyStore.renameSession(conversationId, title);
    const liveConversation = this.conversations.get(conversationId);
    if (renamed && liveConversation) {
      liveConversation.title = renamed.title;
    }
    return renamed;
  }

  async deleteConversation(conversationId) {
    if (!this.historyStore || this.activeRun) return false;
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      this.conversations.delete(conversationId);
      if (this.conversation === conversation) {
        this.conversation = null;
      }
      this.#disposeConversation(conversation);
      for (const record of this.agentTabs.values()) {
        if (record.conversationId === conversationId) record.conversationId = null;
      }
    }
    if (conversation) {
      this.#broadcast({ type: 'conversation_cleared', conversationId });
    }
    return this.historyStore.deleteSession(conversationId);
  }

  async claimTab(tabId) {
    if (this.disposed || typeof tabId !== 'string' || !tabId) return false;
    const record = this.agentTabs.get(tabId);
    if (!record || record.custody !== 'agent') return false;
    if (this.activeRun && this.#conversationHasTab(this.conversation, tabId)) {
      await this.stop(this.activeRun.runId);
    }
    for (const conversation of this.conversations.values()) {
      conversation.scopedController?.releaseTab?.(tabId);
    }
    record.custody = 'user';
    record.conversationId = null;
    return true;
  }

  getWorkspaceState() {
    const scopedController = this.conversation?.scopedController;
    if (!scopedController || typeof scopedController.getWorkspaceState !== 'function') {
      return { tabIds: [], activeTabId: null };
    }
    const workspace = scopedController.getWorkspaceState();
    return {
      tabIds: Array.isArray(workspace?.tabIds)
        ? workspace.tabIds.filter((tabId) => typeof tabId === 'string' && tabId)
        : [],
      activeTabId:
        typeof workspace?.activeTabId === 'string' && workspace.activeTabId
          ? workspace.activeTabId
          : null,
    };
  }

  async handleWalletRequest(tabId, payload) {
    const run = this.activeRun;
    if (
      !this.walletController ||
      !run ||
      run.finished ||
      run.stopRequested ||
      run.pauseRequested ||
      run.status !== 'running' ||
      typeof tabId !== 'string' ||
      run.scopedController?.getActiveTabId?.() !== tabId ||
      !this.#conversationHasTab(this.conversation, tabId)
    ) {
      return { handled: false };
    }
    const pageState = this.controller.getPageState?.(tabId);
    if (!pageState?.url) return { handled: false };

    const handling = this.#handleActiveWalletRequest(run, tabId, pageState, payload);
    run.pendingWalletRequests.add(handling);
    run.scopedController?.setExternalApprovalBarrier?.(handling);
    try {
      return await handling;
    } finally {
      run.pendingWalletRequests.delete(handling);
    }
  }

  async start(options) {
    if (this.disposed) {
      throw new FreedomAgentError(
        AGENT_ERROR_CODES.DISPOSED,
        'Freedom agent service has been disposed'
      );
    }
    if (this.activeRun) {
      throw new FreedomAgentError(
        AGENT_ERROR_CODES.BUSY,
        'Freedom agent already has an active run'
      );
    }

    const existingConversation = this.conversation;
    const needsRuntime = !existingConversation?.session || !existingConversation?.scopedController;
    const validated = needsRuntime ? validateStartOptions(options) : validatePromptOptions(options);
    const { prompt, approvalMode } = validated;
    if (existingConversation && approvalMode !== existingConversation.approvalMode) {
      throw new FreedomAgentError(
        AGENT_ERROR_CODES.INVALID_ARGUMENT,
        'Start a new conversation to change the interaction approval setting'
      );
    }
    const tabId = needsRuntime ? validated.tabId : existingConversation.tabId;
    const completion = createDeferred();
    const run = {
      runId: this.runIdFactory(),
      conversationId: existingConversation?.conversationId || this.conversationIdFactory(),
      tabId,
      approvalMode,
      status: 'starting',
      userText: prompt,
      assistantText: '',
      activity: [],
      guidance: [],
      startedAt: this.now(),
      durationMs: null,
      completion,
      session: needsRuntime ? null : existingConversation.session,
      scopedController: needsRuntime ? null : existingConversation.scopedController,
      stopRequested: false,
      pauseRequested: false,
      resumePending: false,
      failure: null,
      lastAssistant: null,
      toolOutcomes: new Map(),
      pendingApproval: null,
      pendingWalletRequests: new Set(),
      finished: false,
      providerId: existingConversation?.providerId || options.model?.provider || '',
      providerLabel:
        existingConversation?.providerLabel ||
        PROVIDER_LABELS[options.model?.provider] ||
        options.model?.provider ||
        'the selected model provider',
      modelId: existingConversation?.modelId || options.model?.id || '',
    };
    this.activeRun = run;
    let conversation = existingConversation;
    if (conversation) conversation.activeRun = run;
    this.#emit(run, { type: 'run_started', tabId, approvalMode, userText: prompt });

    try {
      if (needsRuntime) {
        const sdk = await this.loadSdk();
        const scopedController = await this.createControllerScope({
          controller: this.controller,
          tabId,
          navigationScope: AGENT_NAVIGATION_SCOPES.WORKSPACE,
          approvalMode,
          createWorkspacePage: validated.createWorkspacePage,
          onWorkspaceTabCreated: (createdTabId) =>
            this.#registerAgentTab(createdTabId, run.conversationId),
          transferOwnerId: run.conversationId,
          requestApproval: (request) =>
            this.activeRun ? this.#requestApproval(this.activeRun, request) : 'declined',
          classifyEffect: (input) =>
            this.effectClassifier.classify(input, {
              model: options.model,
              modelRuntime: options.modelRuntime,
            }),
        });
        if (
          !scopedController ||
          typeof scopedController.execute !== 'function' ||
          typeof scopedController.prepareResume !== 'function'
        ) {
          throw new TypeError('Agent controller scope does not support safe resume');
        }
        run.scopedController = scopedController;
        const customTools = await this.createTools({
          sdk,
          controller: scopedController,
          tabId,
          onToolOutcome: (outcome) => {
            if (this.activeRun) this.#handleToolOutcome(this.activeRun, outcome);
          },
          onToolProgress: (outcome) => {
            if (this.activeRun) this.#handleToolProgress(this.activeRun, outcome);
          },
        });
        let systemPrompt =
          approvalMode === AGENT_APPROVAL_MODES.EVERY_INTERACTION
            ? EVERY_INTERACTION_SYSTEM_PROMPT
            : DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT;
        if (!tabId) systemPrompt = `${systemPrompt}\n\n${EMPTY_WORKSPACE_SYSTEM_PROMPT}`;
        if (existingConversation?.restored) {
          systemPrompt = `${systemPrompt}\n\n${RESTORED_SESSION_PROMPT}`;
        }
        const created = await this.createSession({
          sdk,
          model: options.model,
          modelRuntime: options.modelRuntime,
          thinkingLevel: options.thinkingLevel,
          customTools,
          ...(existingConversation?.restored && {
            restoredTranscript: existingConversation.turns.map((turn) => ({
              runId: turn.runId,
              userText: turn.userText,
              assistantText: turn.assistantText,
              status: turn.status,
              startedAt: turn.startedAt,
              ...(Number.isFinite(turn.durationMs) && { durationMs: turn.durationMs }),
              guidance: turn.guidance.map((item) => ({ ...item })),
            })),
          }),
          systemPrompt,
        });
        const session = created?.session;
        if (
          !session ||
          typeof session.subscribe !== 'function' ||
          typeof session.prompt !== 'function' ||
          typeof session.steer !== 'function' ||
          typeof session.clearQueue !== 'function' ||
          typeof session.abort !== 'function' ||
          typeof session.dispose !== 'function'
        ) {
          throw new TypeError('Pi session factory returned an invalid session');
        }
        if (!conversation) {
          conversation = {
            conversationId: run.conversationId,
            title: prompt.slice(0, 120),
            tabId,
            approvalMode,
            session,
            scopedController,
            unsubscribe: null,
            turns: [],
            activeRun: run,
            restored: false,
            providerId: run.providerId,
            providerLabel: run.providerLabel,
            modelId: run.modelId,
          };
          this.conversation = conversation;
          this.conversations.set(conversation.conversationId, conversation);
          this.#persistHistory('createSession', {
            conversationId: conversation.conversationId,
            title: conversation.title,
            approvalMode,
            providerId: options.model?.provider,
            modelId: options.model?.id,
            thinkingLevel: options.thinkingLevel,
            createdAt: run.startedAt,
          });
        } else {
          conversation.tabId = tabId;
          conversation.session = session;
          conversation.scopedController = scopedController;
          conversation.activeRun = run;
          conversation.restored = false;
        }
        run.session = session;
        conversation.unsubscribe = session.subscribe((event) =>
          this.#handlePiEvent(conversation, event)
        );
      } else {
        const readiness = await conversation.scopedController.prepareResume();
        if (!readiness?.ok) {
          throw new FreedomAgentError(
            readiness?.error?.code === ERROR_CODES.POLICY_DENIED
              ? AGENT_ERROR_CODES.RESUME_SCOPE_CHANGED
              : AGENT_ERROR_CODES.TAB_UNAVAILABLE,
            "The conversation's browser workspace could not be resumed"
          );
        }
      }
      conversation.turns.push(run);
      this.#persistHistory('startTurn', {
        conversationId: conversation.conversationId,
        runId: run.runId,
        position: conversation.turns.length - 1,
        userText: run.userText,
        startedAt: run.startedAt,
      });

      if (run.failure) {
        await this.#finish(run, 'failed', run.failure);
        return { runId: run.runId };
      }
      if (run.stopRequested || this.disposed) {
        await this.#finish(run, 'cancelled');
        return { runId: run.runId };
      }

      run.status = 'running';
      this.#launchTurn(run, prompt);
      return { runId: run.runId, conversationId: run.conversationId };
    } catch (cause) {
      const error =
        run.failure ||
        (cause instanceof FreedomAgentError
          ? terminalError(cause.code, cause.message)
          : terminalError(
              AGENT_ERROR_CODES.SESSION_START_FAILED,
              'The agent session could not be started'
            ));
      await this.#finish(run, 'failed', error);
      if (!existingConversation && this.conversation?.conversationId === run.conversationId) {
        const failedConversation = this.conversation;
        this.conversation = null;
        this.conversations.delete(run.conversationId);
        this.#disposeConversation(failedConversation);
      }
      throw new FreedomAgentError(error.code, error.message);
    }
  }

  async stop(runId) {
    const run = this.activeRun;
    if (!run || (runId !== undefined && run.runId !== runId)) return false;
    run.stopRequested = true;
    this.#resolveApproval(run, 'declined');
    try {
      this.cancelAgentDownloads(run.conversationId);
    } catch (error) {
      log.warn('[Agent] Could not cancel conversation downloads:', error?.message || error);
    }
    const execution = run.execution;
    if (run.session) {
      try {
        await run.session.abort();
      } catch {
        // The run loop owns terminal-state reporting and cleanup.
      }
    }
    if (execution) await execution;
    if (!run.finished) await this.#finish(run, 'cancelled');
    return true;
  }

  async pause(runId) {
    const run = this.activeRun;
    if (!run || run.runId !== runId || run.status !== 'running' || !run.execution) return false;
    run.pauseRequested = true;
    run.status = 'pausing';
    this.#resolveApproval(run, 'withdrawn');
    this.#emit(run, { type: 'run_pausing' });
    try {
      await run.session.abort();
    } catch {
      // The active turn converts provider failures to a terminal run result.
    }
    await run.execution;
    if (!run.finished && run.status === 'paused') {
      try {
        run.session.clearQueue();
      } catch {
        // Resume still uses Freedom's retained guidance projection.
      }
      for (const guidance of run.guidance.filter((item) => item.status === 'applying')) {
        this.#setGuidanceStatus(run, guidance, 'queued');
      }
    }
    return !run.finished && run.status === 'paused';
  }

  async steer(runId, text) {
    const run = this.activeRun;
    if (!run || run.runId !== runId || run.status !== 'running' || !run.execution) return null;
    const guidance = this.#createGuidance(run, validateGuidanceText(text), 'queued');
    try {
      await run.session.steer(guidance.text);
    } catch {
      this.#setGuidanceStatus(run, guidance, 'cancelled');
      throw new FreedomAgentError(
        AGENT_ERROR_CODES.RUN_FAILED,
        'The guidance could not be queued for Agent'
      );
    }
    return { ...guidance };
  }

  async resume(runId, instruction) {
    const run = this.activeRun;
    if (
      !run ||
      run.runId !== runId ||
      run.status !== 'paused' ||
      run.execution ||
      run.resumePending
    ) {
      return false;
    }
    const guidanceText = instruction === undefined ? null : validateGuidanceText(instruction);
    run.resumePending = true;
    let readiness;
    try {
      readiness = await run.scopedController.prepareResume();
    } finally {
      run.resumePending = false;
    }
    if (this.activeRun !== run || run.finished || run.status !== 'paused') return false;
    if (!readiness?.ok) {
      if (readiness?.error?.code === ERROR_CODES.POLICY_DENIED) {
        throw new FreedomAgentError(
          AGENT_ERROR_CODES.RESUME_SCOPE_CHANGED,
          'The controlled tab left the supported task workspace. Start a new task to continue.'
        );
      }
      throw new FreedomAgentError(
        AGENT_ERROR_CODES.TAB_UNAVAILABLE,
        'The assigned browser tab is no longer available'
      );
    }
    run.status = 'resuming';
    run.lastAssistant = null;
    if (guidanceText) this.#createGuidance(run, guidanceText, 'queued');
    const queuedGuidance = run.guidance.filter((item) => item.status === 'queued');
    this.#emit(run, { type: 'run_resuming' });
    run.status = 'running';
    this.#emit(run, { type: 'run_resumed' });
    for (const item of queuedGuidance) this.#setGuidanceStatus(run, item, 'applying');
    const guidanceBlock = queuedGuidance.map((item) => item.text).join('\n\n');
    this.#launchTurn(
      run,
      guidanceBlock
        ? `${RESUME_PROMPT}\n\nThe user added this guidance before resuming:\n${guidanceBlock}`
        : RESUME_PROMPT
    );
    return true;
  }

  async decideApproval(runId, approvalId, approved) {
    const run = this.activeRun;
    if (
      !run ||
      run.runId !== runId ||
      typeof approvalId !== 'string' ||
      run.pendingApproval?.publicRequest.approvalId !== approvalId ||
      !(
        typeof approved === 'boolean' ||
        (approved && typeof approved === 'object' && approved.approved === true)
      )
    ) {
      return false;
    }
    this.#resolveApproval(
      run,
      typeof approved === 'object'
        ? {
            status: 'approved',
            ...(Number.isSafeInteger(approved.walletIndex) && {
              walletIndex: approved.walletIndex,
            }),
            ...(approved.diagnosticScope === 'conversation' && {
              diagnosticScope: 'conversation',
            }),
          }
        : approved
          ? 'approved'
          : 'declined'
    );
    return true;
  }

  async waitForIdle() {
    const run = this.activeRun;
    if (run) await run.completion.promise;
  }

  async clearConversation() {
    if (this.disposed) return false;
    if (this.activeRun) return false;
    const conversation = this.conversation;
    if (!conversation) return true;
    this.conversation = null;
    this.#broadcast({
      type: 'conversation_cleared',
      conversationId: conversation.conversationId,
    });
    return true;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.unsubscribeTabLifecycle) {
      try {
        this.unsubscribeTabLifecycle();
      } catch {
        // Active-run cancellation and session cleanup remain authoritative.
      }
      this.unsubscribeTabLifecycle = null;
    }
    const run = this.activeRun;
    if (run) {
      await this.stop(run.runId);
      await run.completion.promise;
    }
    this.conversation = null;
    for (const conversation of this.conversations.values()) {
      this.#disposeConversation(conversation);
    }
    this.conversations.clear();
    this.agentTabs.clear();
    this.listeners.clear();
  }

  #launchTurn(run, prompt) {
    const execution = this.#executeTurn(run, prompt);
    run.execution = execution;
    void execution.then(
      () => {
        if (run.execution === execution) run.execution = null;
      },
      () => {
        if (run.execution === execution) run.execution = null;
      }
    );
  }

  async #executeTurn(run, prompt) {
    let status = 'completed';
    let error;
    try {
      await run.session.prompt(prompt, {
        expandPromptTemplates: false,
        source: 'interactive',
      });
      while (run.pendingWalletRequests.size) {
        await Promise.allSettled([...run.pendingWalletRequests]);
      }
      if (run.stopRequested) {
        status = 'cancelled';
      } else if (run.pauseRequested) {
        status = 'paused';
      } else if (run.failure) {
        status = 'failed';
        error = run.failure;
      } else if (run.lastAssistant?.stopReason === 'error') {
        status = 'failed';
        error = terminalError(
          AGENT_ERROR_CODES.PROVIDER_ERROR,
          'The model provider request failed'
        );
      } else if (run.lastAssistant?.stopReason === 'length') {
        status = 'failed';
        error = terminalError(
          AGENT_ERROR_CODES.MODEL_OUTPUT_LIMIT,
          'The model reached its output limit'
        );
      } else if (run.lastAssistant?.stopReason === 'aborted') {
        status = 'failed';
        error = terminalError(AGENT_ERROR_CODES.RUN_FAILED, 'The agent run ended unexpectedly');
      }
    } catch {
      if (run.stopRequested) {
        status = 'cancelled';
      } else if (run.pauseRequested) {
        status = 'paused';
      } else {
        status = 'failed';
        error = terminalError(
          AGENT_ERROR_CODES.PROVIDER_ERROR,
          'The model provider request failed'
        );
      }
    }
    if (run.failure) {
      status = 'failed';
      error = run.failure;
    }
    if (status === 'paused') {
      run.pauseRequested = false;
      run.status = 'paused';
      this.#emit(run, { type: 'run_paused' });
      return;
    }
    await this.#finish(run, status, error);
  }

  #handlePiEvent(conversation, event) {
    const run = this.activeRun;
    if (
      !run ||
      run.finished ||
      this.conversation !== conversation ||
      conversation.activeRun !== run
    ) {
      return;
    }
    if (event?.type === 'message_start' && event.message?.role === 'user') {
      const text = piMessageText(event.message);
      const guidance = run.guidance.find((item) => item.status === 'queued' && item.text === text);
      if (guidance) this.#setGuidanceStatus(run, guidance, 'applying');
    }
    if (event?.type === 'message_end' && event.message?.role === 'assistant') {
      run.lastAssistant = {
        stopReason: event.message.stopReason,
      };
      for (const guidance of run.guidance.filter((item) => item.status === 'applying')) {
        this.#setGuidanceStatus(run, guidance, 'applied');
      }
    }

    const toolCallId = event?.type === 'tool_execution_end' ? String(event.toolCallId) : null;
    const toolOutcome = toolCallId ? run.toolOutcomes.get(toolCallId) : undefined;
    const normalized = normalizePiEvent(event, toolOutcome);
    if (toolCallId) run.toolOutcomes.delete(toolCallId);
    if (!normalized) return;
    if (normalized.type === 'assistant_text_delta') {
      run.assistantText += normalized.text;
    } else if (normalized.type === 'tool_started') {
      run.activity.push({
        toolCallId: normalized.toolCallId,
        operation: normalized.operation,
        status: 'running',
        label: normalized.label,
        intent: normalized.intent,
        effect: normalized.effect,
        ...(normalized.origin && { origin: normalized.origin }),
        ...(normalized.pageId && { pageId: normalized.pageId }),
        ...(Number.isSafeInteger(normalized.pageCount) && {
          pageCount: normalized.pageCount,
        }),
      });
    } else if (normalized.type === 'tool_finished') {
      const item = run.activity.find((candidate) => candidate.toolCallId === normalized.toolCallId);
      if (item) {
        item.status = normalized.status;
        item.label = normalized.label;
        item.intent = normalized.intent;
        item.effect = normalized.effect;
        if (normalized.origin) item.origin = normalized.origin;
        if (normalized.pageId) item.pageId = normalized.pageId;
        if (Number.isSafeInteger(normalized.pageCount)) item.pageCount = normalized.pageCount;
        if (normalized.errorCode) item.errorCode = normalized.errorCode;
        if (normalized.artifact) item.artifact = normalized.artifact;
        if (normalized.upload) item.upload = normalized.upload;
        if (normalized.wallet) item.wallet = normalized.wallet;
        if (normalized.nodeStatus) item.nodeStatus = normalized.nodeStatus;
        if (normalized.nodeRequest) item.nodeRequest = normalized.nodeRequest;
        if (normalized.diagnostic) item.diagnostic = normalized.diagnostic;
        if (normalized.artifacts) item.artifacts = normalized.artifacts;
        if (item.approval) normalized.approval = item.approval;
      }
    }
    this.#emit(run, normalized);
  }

  #handleToolOutcome(run, outcome) {
    if (
      run.finished ||
      this.activeRun !== run ||
      !outcome ||
      typeof outcome.toolCallId !== 'string' ||
      !outcome.toolCallId
    ) {
      return;
    }
    const normalized = Object.freeze({
      toolCallId: outcome.toolCallId,
      operation: typeof outcome.operation === 'string' ? outcome.operation : '',
      status: outcome.status === 'failed' ? 'failed' : 'succeeded',
      ...(AUTOMATION_ERROR_CODE_SET.has(outcome.errorCode) && {
        errorCode: outcome.errorCode,
      }),
      ...(normalizeArtifact(outcome.artifact) && {
        artifact: normalizeArtifact(outcome.artifact),
      }),
      ...(normalizeUpload(outcome.upload) && { upload: normalizeUpload(outcome.upload) }),
      ...(normalizeWalletReceipt(outcome.wallet) && {
        wallet: normalizeWalletReceipt(outcome.wallet),
      }),
      ...(normalizeNodeStatusReceipt(outcome.nodeStatus) && {
        nodeStatus: normalizeNodeStatusReceipt(outcome.nodeStatus),
      }),
      ...(normalizeNodeRequestReceipt(outcome.nodeRequest) && {
        nodeRequest: normalizeNodeRequestReceipt(outcome.nodeRequest),
      }),
      ...(normalizeDiagnosticReceipt(outcome.diagnostic) && {
        diagnostic: normalizeDiagnosticReceipt(outcome.diagnostic),
      }),
      ...(Array.isArray(outcome.artifacts) && {
        artifacts: outcome.artifacts.map(normalizeArtifact).filter(Boolean).slice(0, 100),
      }),
      progress: activityProgress(outcome.operation, {
        origin: outcome.origin,
        pageId: outcome.pageId || outcome.tabId,
        pageCount: outcome.pageCount,
        artifact: outcome.artifact,
        upload: outcome.upload,
        wallet: outcome.wallet,
        nodeStatus: outcome.nodeStatus,
        diagnostic: outcome.diagnostic,
      }),
    });
    run.toolOutcomes.set(normalized.toolCallId, normalized);
  }

  #handleToolProgress(run, outcome) {
    if (
      run.finished ||
      this.activeRun !== run ||
      !outcome ||
      typeof outcome.toolCallId !== 'string' ||
      outcome.operation !== OPERATIONS.DOWNLOAD
    ) {
      return;
    }
    const progress = outcome.progress;
    if (!progress || typeof progress !== 'object') return;
    const receivedBytes = Math.max(0, Number(progress.receivedBytes) || 0);
    const totalBytes = Math.max(0, Number(progress.totalBytes) || 0);
    const normalizedArtifact = normalizeArtifact(progress.receipt);
    const artifact =
      normalizedArtifact?.state === 'completed' && normalizedArtifact.available
        ? normalizedArtifact
        : null;
    const item = run.activity.find((candidate) => candidate.toolCallId === outcome.toolCallId);
    if (item && artifact) item.artifact = artifact;
    this.#emit(run, {
      type: 'tool_progress',
      toolCallId: outcome.toolCallId,
      operation: OPERATIONS.DOWNLOAD,
      receivedBytes,
      totalBytes,
      state: ['in_progress', 'interrupted', 'completed', 'cancelled'].includes(progress.state)
        ? progress.state
        : 'in_progress',
      ...(artifact && { artifact }),
    });
  }

  #handleTabLifecycle(event) {
    const run = this.activeRun;
    for (const conversation of this.conversations.values()) {
      if (conversation.scopedController?.handleTabLifecycle) {
        try {
          conversation.scopedController.handleTabLifecycle(event);
        } catch {
          // A malformed lifecycle event cannot break another conversation.
        }
      }
    }
    if (event?.type === 'tab_closed' && typeof event.tabId === 'string') {
      this.agentTabs.delete(event.tabId);
    }
    if (
      run &&
      !run.finished &&
      event?.type === 'tab_closed' &&
      event.tabId === run.pendingApproval?.tabId
    ) {
      this.#resolveApproval(run, 'withdrawn');
    }
  }

  async #handleActiveWalletRequest(run, tabId, pageState, payload) {
    const toolCallId = `wallet_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const progress = activityProgress(OPERATIONS.WALLET_ACTION, {
      origin: pageState.url,
      pageId: tabId,
    });
    const activityItem = {
      toolCallId,
      operation: OPERATIONS.WALLET_ACTION,
      status: 'running',
      label: progress.label,
      intent: progress.intent,
      effect: progress.effect,
      ...(progress.origin && { origin: progress.origin }),
      ...(progress.pageId && { pageId: progress.pageId }),
    };
    run.activity.push(activityItem);
    this.#emit(run, {
      type: 'tool_started',
      toolCallId,
      operation: OPERATIONS.WALLET_ACTION,
      ...progress,
    });

    const outcome = await this.walletController.handleRequest(
      {
        tabId,
        pageUrl: pageState.url,
        conversationId: run.conversationId,
        requestApproval: (request) => this.#requestApproval(run, request),
      },
      payload
    );
    const succeeded = outcome?.handled === true && !outcome.error;
    activityItem.status = succeeded ? 'succeeded' : 'failed';
    if (outcome?.errorCode && AUTOMATION_ERROR_CODE_SET.has(outcome.errorCode)) {
      activityItem.errorCode = outcome.errorCode;
    }
    this.#emit(run, {
      type: 'tool_finished',
      toolCallId,
      operation: OPERATIONS.WALLET_ACTION,
      status: succeeded ? 'succeeded' : 'failed',
      ...progress,
      ...(activityItem.errorCode && { errorCode: activityItem.errorCode }),
    });

    const event = outcome?.receipt
      ? { status: 'completed', wallet: outcome.receipt.wallet }
      : outcome?.errorCode === ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER
        ? {
            status: 'declined',
            method: typeof payload?.method === 'string' ? payload.method : '',
            origin: getPermissionKey(pageState.url) || '',
          }
        : null;
    if (event && this.activeRun === run && !run.finished && !run.stopRequested) {
      try {
        await run.session.steer(
          `Freedom wallet event (trusted browser result): ${JSON.stringify(event)}`
        );
      } catch {
        // The page still receives the authoritative provider result. A later
        // snapshot remains available if Pi's current turn has already ended.
      }
    }

    return {
      handled: outcome?.handled === true,
      ...(outcome?.result !== undefined && { result: outcome.result }),
      ...(outcome?.error && { error: outcome.error }),
    };
  }

  async #requestApproval(run, request) {
    if (
      run.finished ||
      run.stopRequested ||
      run.pauseRequested ||
      run.status !== 'running' ||
      this.activeRun !== run ||
      run.pendingApproval
    ) {
      return 'declined';
    }
    const decision = createDeferred();
    const publicRequest = Object.freeze({
      approvalId: opaqueApprovalId(),
      ...normalizeApprovalRequest(request, run),
    });
    const activityItem = [...run.activity]
      .reverse()
      .find(
        (item) =>
          item.status === 'running' &&
          (!publicRequest.operation || item.operation === publicRequest.operation)
      );
    if (activityItem) {
      activityItem.approval = 'requested';
      if (publicRequest.destinationOrigin) {
        activityItem.destinationOrigin = publicRequest.destinationOrigin;
      }
    }
    run.pendingApproval = {
      decision,
      publicRequest,
      ...(activityItem?.toolCallId && { toolCallId: activityItem.toolCallId }),
      ...(typeof request?.tabId === 'string' && { tabId: request.tabId }),
    };
    this.#emit(run, {
      type: 'approval_requested',
      ...publicRequest,
      ...(activityItem?.toolCallId && { toolCallId: activityItem.toolCallId }),
    });
    return decision.promise;
  }

  #resolveApproval(run, decision) {
    const pending = run.pendingApproval;
    if (!pending) return;
    run.pendingApproval = null;
    const activityItem = pending.toolCallId
      ? run.activity.find((item) => item.toolCallId === pending.toolCallId)
      : null;
    const status = typeof decision === 'object' ? decision.status : decision;
    if (activityItem) activityItem.approval = status;
    pending.decision.resolve(decision);
    this.#emit(run, {
      type: 'approval_resolved',
      approvalId: pending.publicRequest.approvalId,
      decision: status,
      ...(pending.toolCallId && { toolCallId: pending.toolCallId }),
    });
  }

  async #finish(run, status, error) {
    if (run.finished) return;
    this.#resolveApproval(run, 'declined');
    if (status !== 'completed') {
      try {
        run.session?.clearQueue?.();
      } catch {
        // Terminal cleanup below remains authoritative.
      }
    }
    for (const guidance of run.guidance.filter(
      (item) => item.status === 'queued' || item.status === 'applying'
    )) {
      this.#setGuidanceStatus(
        run,
        guidance,
        status === 'completed' && guidance.status === 'applying' ? 'applied' : 'cancelled'
      );
    }
    run.finished = true;
    run.status = status;
    run.durationMs = Math.max(0, this.now() - run.startedAt);
    run.error = error;
    run.outcome = buildAgentOutcome(run.activity, status, error);
    const cancelledActionCount = run.activity.filter(
      (item) =>
        item.errorCode === ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER ||
        item.errorCode === ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER
    ).length;
    if (this.activeRun === run) this.activeRun = null;
    if (this.conversation?.activeRun === run) this.conversation.activeRun = null;
    this.#emit(run, {
      type: 'run_finished',
      status,
      durationMs: run.durationMs,
      actionCount: run.activity.length,
      failedActionCount: run.activity.filter(
        (item) =>
          item.status === 'failed' &&
          item.errorCode !== ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER &&
          item.errorCode !== ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER
      ).length,
      ...(cancelledActionCount && { cancelledActionCount }),
      outcome: run.outcome,
      ...(error && { error }),
    });
    this.#persistHistory('finishTurn', {
      conversationId: run.conversationId,
      runId: run.runId,
      assistantText: run.assistantText,
      status,
      durationMs: run.durationMs,
      activity: run.activity,
      guidance: run.guidance,
      error,
    });
    run.completion.resolve({ status, error });
  }

  #emit(run, event) {
    this.#broadcast({
      conversationId: run.conversationId,
      runId: run.runId,
      ...event,
    });
  }

  #broadcast(event) {
    const normalized = Object.freeze({
      version: AGENT_EVENT_VERSION,
      sequence: ++this.sequence,
      ...event,
    });
    for (const listener of this.listeners) {
      try {
        listener(normalized);
      } catch {
        // One chrome subscriber cannot break the agent lifecycle or other subscribers.
      }
    }
  }

  #persistHistory(method, payload) {
    if (!this.historyStore) return null;
    try {
      return this.historyStore[method](payload);
    } catch (error) {
      log.warn(`[AgentHistory] ${method} failed:`, error?.message || 'unknown error');
      return null;
    }
  }

  #createGuidance(run, text, status) {
    const guidance = {
      guidanceId: this.guidanceIdFactory(),
      text,
      status,
      createdAt: this.now(),
    };
    run.guidance.push(guidance);
    this.#persistGuidance(run);
    this.#emit(run, { type: 'guidance_queued', guidance: { ...guidance } });
    return guidance;
  }

  #setGuidanceStatus(run, guidance, status) {
    if (!guidance || guidance.status === status) return;
    guidance.status = status;
    this.#persistGuidance(run);
    this.#emit(run, {
      type:
        status === 'queued'
          ? 'guidance_queued'
          : status === 'applying'
            ? 'guidance_applying'
            : status === 'applied'
              ? 'guidance_applied'
              : 'guidance_cancelled',
      ...(status === 'queued'
        ? { guidance: { ...guidance } }
        : { guidanceId: guidance.guidanceId }),
    });
  }

  #persistGuidance(run) {
    this.#persistHistory('updateTurnGuidance', {
      conversationId: run.conversationId,
      runId: run.runId,
      guidance: run.guidance,
    });
  }

  #registerAgentTab(tabId, conversationId) {
    if (typeof tabId !== 'string' || !tabId) return;
    this.agentTabs.set(tabId, {
      tabId,
      provenance: 'agent',
      custody: 'agent',
      conversationId,
    });
    const run = this.activeRun;
    if (run && !run.finished && run.conversationId === conversationId) {
      this.#emit(run, { type: 'workspace_changed' });
    }
  }

  #conversationHasTab(conversation, tabId) {
    if (!conversation?.scopedController?.getWorkspaceState) return false;
    const workspace = conversation.scopedController.getWorkspaceState();
    return Array.isArray(workspace?.tabIds) && workspace.tabIds.includes(tabId);
  }

  #disposeConversation(conversation) {
    if (conversation.unsubscribe) {
      try {
        conversation.unsubscribe();
      } catch {
        // Session disposal below remains authoritative.
      }
      conversation.unsubscribe = null;
    }
    try {
      conversation.session?.dispose();
    } catch {
      // Cleanup failures are not exposed across the service boundary.
    }
    conversation.session = null;
  }
}

module.exports = {
  AGENT_ERROR_CODES,
  AGENT_EVENT_VERSION,
  MAX_AGENT_PROMPT_LENGTH,
  FreedomAgentError,
  FreedomAgentService,
  normalizePiEvent,
  validatePromptOptions,
  validateStartOptions,
};
