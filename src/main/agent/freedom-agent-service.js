'use strict';

const crypto = require('crypto');
const {
  AGENT_APPROVAL_MODES,
  normalizeAgentApprovalMode,
} = require('../../shared/agent-approval-modes');
const {
  AGENT_NAVIGATION_SCOPES,
} = require('../../shared/agent-navigation-scopes');
const { ERROR_CODES } = require('../automation/contract/errors');
const {
  createOriginScopedAutomationController,
} = require('../automation/origin-scoped-controller');
const { createFreedomBrowserTools } = require('./pi-browser-tools');
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
  TAB_CLOSED: 'AGENT_TAB_CLOSED',
  TAB_UNAVAILABLE: 'TAB_UNAVAILABLE',
  RUN_FAILED: 'RUN_FAILED',
});
const AUTOMATION_ERROR_CODE_SET = new Set(Object.values(ERROR_CODES));
const RESUME_PROMPT = `The user resumed this task after potentially changing the page. Treat the current page as authoritative. Do not reuse earlier element references or assumptions. Get the current tab state and take a fresh snapshot before acting. Preserve user changes unless they conflict with the task.`;
const EVERY_INTERACTION_SYSTEM_PROMPT = `${DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT}

This run requires user approval before every page interaction. Reading pages, navigating, and managing task-owned tabs do not require approval. Click, type, select, and press tools pause until the user approves or declines the exact interaction.`;

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

function opaqueApprovalId() {
  return `approval_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function validateStartOptions(options) {
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
  if (typeof options.tabId !== 'string' || !options.tabId.trim()) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent run requires an assigned tab ID'
    );
  }
  if (options.tabId !== options.tabId.trim()) {
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
  const approvalMode = normalizeAgentApprovalMode(options.approvalMode);
  if (!approvalMode) {
    throw new FreedomAgentError(
      AGENT_ERROR_CODES.INVALID_ARGUMENT,
      'Agent run requires a supported approval mode'
    );
  }
  return { prompt: options.prompt.trim(), tabId: options.tabId, approvalMode };
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
    return {
      type: 'tool_started',
      toolCallId: String(event.toolCallId),
      operation: String(event.toolName),
    };
  }
  if (event.type === 'tool_execution_end') {
    const errorCode =
      event.isError && toolOutcome?.status === 'failed' ? toolOutcome.errorCode : undefined;
    return {
      type: 'tool_finished',
      toolCallId: String(event.toolCallId),
      operation: String(event.toolName),
      status: event.isError ? 'failed' : 'succeeded',
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
  return null;
}

function terminalError(code, message) {
  return Object.freeze({ code, message });
}

function normalizeApprovalRequest(request) {
  return Object.freeze({
    action:
      request?.action === 'form_submission' ? 'form_submission' : 'browser_interaction',
    operation: typeof request?.operation === 'string' ? request.operation.slice(0, 80) : '',
    origin: typeof request?.origin === 'string' ? request.origin.slice(0, 512) : '',
    label: typeof request?.label === 'string' ? request.label.slice(0, 160) : '',
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
    this.runIdFactory = options.runIdFactory || opaqueRunId;
    this.listeners = new Set();
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
    if (!this.activeRun) return { status: 'idle' };
    return {
      status: this.activeRun.status,
      runId: this.activeRun.runId,
      tabId: this.activeRun.tabId,
      ...(this.activeRun.pendingApproval && {
        pendingApproval: this.activeRun.pendingApproval.publicRequest,
      }),
    };
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

    const { prompt, tabId, approvalMode } = validateStartOptions(options);
    const completion = createDeferred();
    const run = {
      runId: this.runIdFactory(),
      tabId,
      approvalMode,
      status: 'starting',
      completion,
      session: null,
      scopedController: null,
      unsubscribe: null,
      stopRequested: false,
      pauseRequested: false,
      resumePending: false,
      failure: null,
      lastAssistant: null,
      toolOutcomes: new Map(),
      pendingApproval: null,
      finished: false,
    };
    this.activeRun = run;
    this.#emit(run, { type: 'run_started', tabId, approvalMode });

    try {
      const sdk = await this.loadSdk();
      const scopedController = await this.createControllerScope({
        controller: this.controller,
        tabId,
        navigationScope: AGENT_NAVIGATION_SCOPES.WORKSPACE,
        approvalMode,
        requestApproval: (request) => this.#requestApproval(run, request),
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
        onToolOutcome: (outcome) => this.#handleToolOutcome(run, outcome),
      });
      const created = await this.createSession({
        sdk,
        model: options.model,
        modelRuntime: options.modelRuntime,
        thinkingLevel: options.thinkingLevel,
        customTools,
        ...(approvalMode === AGENT_APPROVAL_MODES.EVERY_INTERACTION && {
          systemPrompt: EVERY_INTERACTION_SYSTEM_PROMPT,
        }),
      });
      const session = created?.session;
      if (
        !session ||
        typeof session.subscribe !== 'function' ||
        typeof session.prompt !== 'function' ||
        typeof session.abort !== 'function' ||
        typeof session.dispose !== 'function'
      ) {
        throw new TypeError('Pi session factory returned an invalid session');
      }
      run.session = session;
      run.unsubscribe = session.subscribe((event) => this.#handlePiEvent(run, event));

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
      return { runId: run.runId };
    } catch {
      const error =
        run.failure ||
        terminalError(
          AGENT_ERROR_CODES.SESSION_START_FAILED,
          'The agent session could not be started'
        );
      await this.#finish(run, 'failed', error);
      throw new FreedomAgentError(error.code, error.message);
    }
  }

  async stop(runId) {
    const run = this.activeRun;
    if (!run || (runId !== undefined && run.runId !== runId)) return false;
    run.stopRequested = true;
    this.#resolveApproval(run, 'declined');
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
    return !run.finished && run.status === 'paused';
  }

  async resume(runId) {
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
    this.#emit(run, { type: 'run_resuming' });
    run.status = 'running';
    this.#emit(run, { type: 'run_resumed' });
    this.#launchTurn(run, RESUME_PROMPT);
    return true;
  }

  async decideApproval(runId, approvalId, approved) {
    const run = this.activeRun;
    if (
      !run ||
      run.runId !== runId ||
      typeof approvalId !== 'string' ||
      run.pendingApproval?.publicRequest.approvalId !== approvalId ||
      typeof approved !== 'boolean'
    ) {
      return false;
    }
    this.#resolveApproval(run, approved ? 'approved' : 'declined');
    return true;
  }

  async waitForIdle() {
    const run = this.activeRun;
    if (run) await run.completion.promise;
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

  #handlePiEvent(run, event) {
    if (run.finished || this.activeRun !== run) return;
    if (event?.type === 'message_end' && event.message?.role === 'assistant') {
      run.lastAssistant = {
        stopReason: event.message.stopReason,
      };
    }

    const toolCallId = event?.type === 'tool_execution_end' ? String(event.toolCallId) : null;
    const toolOutcome = toolCallId ? run.toolOutcomes.get(toolCallId) : undefined;
    const normalized = normalizePiEvent(event, toolOutcome);
    if (toolCallId) run.toolOutcomes.delete(toolCallId);
    if (normalized) this.#emit(run, normalized);
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
    });
    run.toolOutcomes.set(normalized.toolCallId, normalized);
    if (
      normalized.errorCode === ERROR_CODES.TAB_NOT_FOUND &&
      (outcome.tabId === undefined || outcome.tabId === run.tabId) &&
      !run.failure
    ) {
      run.failure = terminalError(
        AGENT_ERROR_CODES.TAB_UNAVAILABLE,
        'The assigned browser tab is no longer available'
      );
      const execution = run.execution;
      void Promise.resolve(run.session?.abort())
        .catch(() => {})
        .then(async () => {
          if (execution) await execution;
          if (!run.finished) await this.#finish(run, 'failed', run.failure);
        });
    }
  }

  #handleTabLifecycle(event) {
    const run = this.activeRun;
    if (run?.scopedController?.handleTabLifecycle) {
      try {
        run.scopedController.handleTabLifecycle(event);
      } catch {
        // The task scope must not break terminal starting-tab handling.
      }
    }
    if (
      !run ||
      run.finished ||
      event?.type !== 'tab_closed' ||
      event.tabId !== run.tabId ||
      run.failure
    ) {
      return;
    }
    run.failure = terminalError(
      AGENT_ERROR_CODES.TAB_CLOSED,
      'The controlled browser tab was closed'
    );
    run.stopRequested = true;
    this.#resolveApproval(run, 'declined');
    const execution = run.execution;
    void Promise.resolve(run.session?.abort())
      .catch(() => {})
      .then(async () => {
        if (execution) await execution;
        if (!run.finished) await this.#finish(run, 'failed', run.failure);
      });
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
      ...normalizeApprovalRequest(request),
    });
    run.pendingApproval = { decision, publicRequest };
    this.#emit(run, { type: 'approval_requested', ...publicRequest });
    return decision.promise;
  }

  #resolveApproval(run, decision) {
    const pending = run.pendingApproval;
    if (!pending) return;
    run.pendingApproval = null;
    pending.decision.resolve(decision);
    this.#emit(run, {
      type: 'approval_resolved',
      approvalId: pending.publicRequest.approvalId,
      decision,
    });
  }

  async #finish(run, status, error) {
    if (run.finished) return;
    this.#resolveApproval(run, 'declined');
    run.finished = true;
    run.status = status;
    if (run.unsubscribe) {
      try {
        run.unsubscribe();
      } catch {
        // Session disposal below remains authoritative.
      }
      run.unsubscribe = null;
    }
    if (run.session) {
      try {
        run.session.dispose();
      } catch {
        // Cleanup failures are not exposed across the service boundary.
      }
      run.session = null;
    }
    if (this.activeRun === run) this.activeRun = null;
    this.#emit(run, {
      type: 'run_finished',
      status,
      ...(error && { error }),
    });
    run.completion.resolve({ status, error });
  }

  #emit(run, event) {
    const normalized = Object.freeze({
      version: AGENT_EVENT_VERSION,
      sequence: ++this.sequence,
      runId: run.runId,
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
}

module.exports = {
  AGENT_ERROR_CODES,
  AGENT_EVENT_VERSION,
  MAX_AGENT_PROMPT_LENGTH,
  FreedomAgentError,
  FreedomAgentService,
  normalizePiEvent,
  validateStartOptions,
};
