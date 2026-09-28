'use strict';

const {
  AGENT_APPROVAL_MODES,
  normalizeAgentApprovalMode,
} = require('../../shared/agent-approval-modes');
const { normalizeAgentNavigationScope } = require('../../shared/agent-navigation-scopes');
const { OPERATIONS } = require('./contract/operations');
const { ERROR_CODES } = require('./contract/errors');

const ORIGIN_SCOPED_OPERATIONS = new Set([
  OPERATIONS.LIST_TABS,
  OPERATIONS.CREATE_TAB,
  OPERATIONS.GET_TAB,
  OPERATIONS.FOCUS_TAB,
  OPERATIONS.CLOSE_TAB,
  OPERATIONS.SNAPSHOT,
  OPERATIONS.LIST_FRAMES,
  OPERATIONS.READ_FRAME,
  OPERATIONS.TARGET_POINT,
  OPERATIONS.SCREENSHOT,
  OPERATIONS.NAVIGATE,
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
  OPERATIONS.SELECT,
  OPERATIONS.LIST_PAGE_TOOLS,
  OPERATIONS.CALL_PAGE_TOOL,
  OPERATIONS.GET_DIALOG,
  OPERATIONS.HANDLE_DIALOG,
  OPERATIONS.PRESS,
  OPERATIONS.SCROLL,
  OPERATIONS.UPLOAD,
  OPERATIONS.DOWNLOAD,
  OPERATIONS.WALLET_ACTION,
  OPERATIONS.WALLET_TRANSFER,
  OPERATIONS.NODE_STATUS,
  OPERATIONS.NODE_REQUEST,
  OPERATIONS.NODE_OPERATION_STATUS,
  OPERATIONS.NODE_LIFECYCLE,
  OPERATIONS.NODE_DIAGNOSTICS,
  OPERATIONS.APP_DIAGNOSTICS,
  OPERATIONS.SWARM_PUBLISH,
  OPERATIONS.SWARM_PUBLICATION_STATUS,
  OPERATIONS.LIST_DOWNLOADS,
  OPERATIONS.WAIT,
  OPERATIONS.STOP_LOADING,
]);
const SCOPED_SCHEMES = new Set(['http:', 'https:', 'bzz:', 'ipfs:', 'ipns:', 'freedom-preview:']);
// Helpers receive page capabilities only, never node, wallet, transfer or
// publication tools. The ordinary scope still decides each page approval.
const DELEGATED_BROWSER_OPERATIONS = new Set([
  OPERATIONS.LIST_TABS, OPERATIONS.CREATE_TAB, OPERATIONS.GET_TAB, OPERATIONS.FOCUS_TAB,
  OPERATIONS.CLOSE_TAB, OPERATIONS.SNAPSHOT, OPERATIONS.LIST_FRAMES, OPERATIONS.READ_FRAME,
  OPERATIONS.TARGET_POINT, OPERATIONS.SCREENSHOT, OPERATIONS.NAVIGATE, OPERATIONS.CLICK,
  OPERATIONS.TYPE, OPERATIONS.SELECT, OPERATIONS.LIST_PAGE_TOOLS, OPERATIONS.CALL_PAGE_TOOL,
  OPERATIONS.GET_DIALOG, OPERATIONS.HANDLE_DIALOG, OPERATIONS.PRESS, OPERATIONS.SCROLL,
  OPERATIONS.WAIT, OPERATIONS.STOP_LOADING,
]);
const TRUSTED_INPUT_EFFECT_SETTLE_MS = 50;
const MIN_AUTONOMOUS_INTERACTION_CONFIDENCE = 0.85;
const INTERACTION_CLASSIFICATION_KINDS = new Set([
  'ordinary',
  'consequential',
  'uncertain',
]);
const PAGE_INTERACTION_OPERATIONS = new Set([
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
  OPERATIONS.SELECT,
  OPERATIONS.PRESS,
  OPERATIONS.SCROLL,
  OPERATIONS.UPLOAD,
  OPERATIONS.DOWNLOAD,
  OPERATIONS.WALLET_ACTION,
]);

function originScopeForUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!SCOPED_SCHEMES.has(url.protocol) || !url.hostname) return null;
    const host = `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}`;
    return `${url.protocol}//${host}`;
  } catch {
    return null;
  }
}

function errorEnvelope(state, code, message, options = {}) {
  return {
    ok: false,
    ...(state?.runtimeId && { runtimeId: state.runtimeId }),
    ...(state?.contextId && { contextId: state.contextId }),
    ...(state?.tabId && { tabId: state.tabId }),
    ...(Number.isInteger(state?.navigationId) && { navigationId: state.navigationId }),
    error: {
      code,
      message,
      retryable: options.retryable === true,
    },
  };
}

function actionDescriptor(element) {
  return Object.freeze({
    ...(element?.visual === true && { visual: true }),
    effect: ['form_submission', 'file_download', 'file_upload'].includes(element?.effect)
      ? element.effect
      : '',
    label: typeof element?.label === 'string' ? element.label.slice(0, 160) : '',
    navigationTarget: typeof element?.navigationTarget === 'string' ? element.navigationTarget : '',
    ...(typeof element?.frameRef === 'string' && { frameRef: element.frameRef, origin: element.origin || '' }),
    formPayloadFingerprint:
      typeof element?.formPayloadFingerprint === 'string' ? element.formPayloadFingerprint : '',
  });
}

function uncertainInteractionClassification(reason = 'classification_unavailable') {
  return Object.freeze({
    kind: 'uncertain',
    confidence: 0,
    summary: 'The intended consequence could not be classified reliably.',
    uncertainties: Object.freeze([reason]),
  });
}

function normalizeInteractionClassification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return uncertainInteractionClassification();
  }
  const kind = INTERACTION_CLASSIFICATION_KINDS.has(value.kind) ? value.kind : 'uncertain';
  const confidence = Number(value.confidence);
  const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, 240) : '';
  if (
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    !summary ||
    !Array.isArray(value.uncertainties)
  ) {
    return uncertainInteractionClassification('invalid_classifier_output');
  }
  const uncertainties = Object.freeze(
    value.uncertainties
      .filter((item) => typeof item === 'string' && item.trim())
      .slice(0, 12)
      .map((item) => item.trim().slice(0, 240))
  );
  return Object.freeze({ kind, confidence, summary, uncertainties });
}

function interactionMayProceed(classification) {
  return (
    classification.kind === 'ordinary' &&
    classification.confidence >= MIN_AUTONOMOUS_INTERACTION_CONFIDENCE &&
    classification.uncertainties.length === 0
  );
}

function sameActionDescriptor(left, right) {
  return (
    left.visual === right.visual && left.frameRef === right.frameRef && left.origin === right.origin &&
    left.effect === right.effect &&
    left.label === right.label &&
    left.navigationTarget === right.navigationTarget &&
    left.formPayloadFingerprint === right.formPayloadFingerprint
  );
}

class OriginScopedAutomationController {
  constructor({
    controller,
    tabId,
    initialState,
    approvalMode,
    requestApproval,
    classifyEffect,
    classifyInteraction,
    createWorkspacePage,
    onWorkspaceTabCreated,
    transferOwnerId,
  }) {
    this.controller = controller;
    this.adoptedTabId = tabId;
    this.activeTabId = tabId;
    this.ownedTabs = tabId ? new Map([[tabId, { created: false }]]) : new Map();
    this.workspaceEstablished = Boolean(originScopeForUrl(initialState?.result?.tab?.url));
    this.approvalMode = approvalMode;
    this.lastState = initialState;
    this.requestApproval = requestApproval;
    this.classifyEffect = classifyEffect;
    this.classifyInteraction = classifyInteraction;
    this.createWorkspacePage = createWorkspacePage;
    this.onWorkspaceTabCreated = onWorkspaceTabCreated;
    this.transferOwnerId = transferOwnerId;
    this.declinedActions = new Set();
    this.diagnosticGrant = false;
    this.declinedDiagnostics = new Set();
    this.externalApprovalBarriers = new Set();
    this.delegatedBrowsers = new Set();
    this.pendingTabOperations = new Map();
    this.freshReferences = new Map();
  }

  setApprovalMode(value) {
    const approvalMode = normalizeAgentApprovalMode(value);
    if (typeof value !== 'string' || !approvalMode) {
      throw new TypeError('Origin-scoped automation requires a supported approval mode');
    }
    this.approvalMode = approvalMode;
    for (const child of this.delegatedBrowsers) child.setApprovalMode(approvalMode);
    return approvalMode;
  }

  async prepareResume() {
    const state = await this.#readActiveState();
    if (!state) {
      return { ok: true, activeTabId: null, workspaceEmpty: true };
    }
    if (!state.ok) return state;
    if (!this.#acceptCurrentOrigin(state)) return this.#originDenied(state);
    for (const tabId of this.ownedTabs.keys()) this.freshReferences.set(tabId, new Set());
    return { ok: true, activeTabId: this.activeTabId, workspaceEmpty: false };
  }

  // Only the host calls this for new user input, never for an agent retry or
  // automatic resume. A refusal suppresses repeat prompts within that turn.
  beginUserTurn() {
    this.declinedDiagnostics.clear();
  }

  getActiveTabId() {
    return this.activeTabId;
  }

  getWorkspaceState() {
    return {
      tabIds: [...this.ownedTabs.keys(), ...[...this.delegatedBrowsers].flatMap(child => [...child.ownedTabs.keys()])],
      activeTabId: this.activeTabId,
    };
  }

  releaseTab(tabId) {
    for (const child of this.delegatedBrowsers) if (child.releaseTab(tabId)) return true;
    if (typeof tabId !== 'string' || !this.ownedTabs.has(tabId)) return false;
    this.ownedTabs.delete(tabId);
    this.freshReferences.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = this.#fallbackTabId();
    return true;
  }

  setExternalApprovalBarrier(promise) {
    for (const child of this.delegatedBrowsers) child.setExternalApprovalBarrier(promise);
    const barrier = Promise.resolve(promise).catch(() => undefined);
    this.externalApprovalBarriers.add(barrier);
    void barrier.finally(() => {
      this.externalApprovalBarriers.delete(barrier);
    });
  }

  async execute(operation, input = {}, execution = {}) {
    return this.#execute(operation, input, execution);
  }

  getTabController(tabId) {
    return [...this.delegatedBrowsers].find(child => child.ownedTabs.has(tabId)) ||
      (this.ownedTabs.has(tabId) ? this : null);
  }

  createDelegatedBrowser({ signal, requestApproval, tabIds: assignedTabIds = [] }) {
    const fail = message => { throw Object.assign(new Error(message), { code: 'BROWSER_DELEGATION_UNAVAILABLE' }); };
    if (!Array.isArray(assignedTabIds) || assignedTabIds.length > 4 ||
        assignedTabIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) ||
        new Set(assignedTabIds).size !== assignedTabIds.length) fail('Supply up to four distinct task tab IDs from browser_list_tabs.');
    if (signal?.aborted) fail('Delegation was stopped. Reconcile the latest user guidance before starting another helper.');
    for (const id of assignedTabIds) {
      if (!this.ownedTabs.has(id)) fail('A requested tab is not available to the parent. List current task tabs, wait for its owning helper, or choose another tab.');
      if (this.pendingTabOperations.has(id)) fail('A requested tab has an unfinished browser action. Wait for that action or approval to settle, then delegate again.');
    }
    let closed = false;
    let pending = 0;
    let created = 0;
    const tabIds = new Set();
    const actions = [];
    const cancelled = () => errorEnvelope(null, ERROR_CODES.USER_CANCELLED,
      'Browser helper stopped. Return to the parent and review any earlier page actions; do not retry.');
    const available = () => !closed && !signal?.aborted;
    // Check again at the raw dispatch boundary, including after classification
    // or approval awaits. A cancelled helper must never dispatch a late click.
    const guarded = new Proxy(this.controller, {
      get: (target, key) => typeof target[key] !== 'function' ? target[key] : (...args) => {
        if (!available()) return Promise.resolve(cancelled());
        if (['execute', 'inspectAction'].includes(key) && args[1]?.tabId &&
            !child.ownedTabs.has(args[1].tabId)) return Promise.resolve(errorEnvelope(null, ERROR_CODES.POLICY_DENIED,
          'This helper no longer owns that tab. Return to the parent; do not reuse earlier references.'));
        if (key === 'execute') args[2] = { ...args[2], signal };
        const value = target[key](...args);
        if (key === 'execute' && args[0] === OPERATIONS.CREATE_TAB) return Promise.resolve(value).then(result => {
          if (result?.ok && result.result?.tab?.tabId) rememberTab(result.result.tab.tabId);
          return result;
        });
        return value;
      },
    });
    const child = new OriginScopedAutomationController({
      controller: guarded, tabId: null, initialState: null, approvalMode: this.approvalMode,
      requestApproval, classifyEffect: this.classifyEffect, classifyInteraction: this.classifyInteraction,
      transferOwnerId: this.transferOwnerId,
      createWorkspacePage: this.createWorkspacePage && (async url => {
        if (!available()) throw new Error('Browser helper stopped');
        const tabId = await this.createWorkspacePage(url);
        if (typeof tabId === 'string' && tabId) rememberTab(tabId);
        return tabId;
      }),
      onWorkspaceTabCreated: tabId => rememberTab(tabId),
    });
    child.delegationSignal = signal;
    // Transfer synchronously after validating the complete set. Preserve original
    // user-tab protection and declined actions across the ownership boundary.
    child.adoptedTabId = this.adoptedTabId;
    if (assignedTabIds.length) child.workspaceEstablished = this.workspaceEstablished;
    child.declinedActions = this.declinedActions;
    for (const id of assignedTabIds) {
      child.ownedTabs.set(id, this.ownedTabs.get(id));
      child.freshReferences.set(id, new Set());
      this.ownedTabs.delete(id);
      this.freshReferences.delete(id);
      tabIds.add(id);
    }
    child.activeTabId = assignedTabIds[0] || null;
    if (assignedTabIds.includes(this.activeTabId)) this.activeTabId = this.#fallbackTabId();
    for (const barrier of this.externalApprovalBarriers) child.setExternalApprovalBarrier(barrier);
    const rememberTab = tabId => {
      child.ownedTabs.set(tabId, { created: true });
      if (!tabIds.has(tabId)) { tabIds.add(tabId); this.#notifyWorkspaceTabCreated(tabId); }
      if (!available()) stopTab(tabId);
    };
    this.delegatedBrowsers.add(child);
    const handBack = () => {
      if (!closed || pending) return;
      for (const [tabId, metadata] of child.ownedTabs) {
        this.ownedTabs.set(tabId, metadata);
        this.freshReferences.set(tabId, new Set());
      }
      if (!this.activeTabId) this.activeTabId = this.#fallbackTabId();
      child.ownedTabs.clear();
      child.activeTabId = null;
      this.delegatedBrowsers.delete(child);
    };
    const stopTab = tabId => {
      pending++;
      Promise.resolve().then(() => child.ownedTabs.has(tabId) ? this.controller.execute(OPERATIONS.STOP_LOADING, { tabId }) : undefined)
        .catch(() => {}).finally(() => { pending--; handBack(); });
    };
    const release = ({ stopLoading = true } = {}) => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', release);
      // Stop loading, but preserve tabs and completed effects for review.
      if (stopLoading) for (const tabId of child.ownedTabs.keys()) stopTab(tabId);
      handBack();
    };
    signal?.addEventListener('abort', release, { once: true });
    if (signal?.aborted) release();
    return {
      controller: {
        getActiveTabId: () => child.getActiveTabId(),
        execute: async (operation, input, execution) => {
          if (!available()) return cancelled();
          if (!DELEGATED_BROWSER_OPERATIONS.has(operation)) return errorEnvelope(null, ERROR_CODES.POLICY_DENIED,
            'This capability is unavailable to browser helpers. Ask the parent to perform it.');
          if (operation === OPERATIONS.CREATE_TAB && ++created > 4) return errorEnvelope(null, ERROR_CODES.POLICY_DENIED,
            'Helper tab limit reached. Reuse an owned tab or return your findings to the parent.');
          pending++;
          try { return await child.execute(operation, input, execution); }
          finally { pending--; handBack(); }
        },
      },
      recordOutcome: outcome => { if (available() && actions.length < 48) actions.push(outcome); },
      evidence: () => ({ tabIds: [...tabIds], browserActions: [...actions], browserPending: pending > 0 }),
      release,
    };
  }

  // Called only by Freedom's preview controller consumers, after they resolve a
  // conversation-owned preview. This is not a model-facing browser operation.
  // Opening a known preview needs no old page references; preserve the
  // observation barrier for subsequent page interactions instead of clearing it.
  async openWorkspacePreview(url) {
    if (
      typeof url !== 'string' ||
      !/^freedom-preview:\/\/[a-f0-9]{20,128}\/[^?#\s]*$/.test(url)
    ) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.POLICY_DENIED,
        'A workspace preview URL is required'
      );
    }
    const listed = await this.execute(OPERATIONS.LIST_TABS, {});
    if (!listed?.ok) return listed;
    const existing = listed.result.tabs.find((tab) => tab.url === url);
    let opened;
    if (existing?.tabId) {
      const focused = await this.#execute(OPERATIONS.FOCUS_TAB, { tabId: existing.tabId });
      if (!focused?.ok) return focused;
      opened = await this.#execute(OPERATIONS.NAVIGATE, { tabId: existing.tabId, url });
    } else {
      opened = await this.#execute(
        OPERATIONS.CREATE_TAB,
        {
          url,
          ...(listed.result.activeTabId && { tabId: listed.result.activeTabId }),
        }
      );
    }
    if (opened?.ok) {
      opened.result = { ...opened.result, activeTabId: this.activeTabId };
    }
    return opened;
  }

  async #execute(operation, input = {}, execution = {}) {
    if (DELEGATED_BROWSER_OPERATIONS.has(operation) && typeof input?.tabId === 'string' && !this.ownedTabs.has(input.tabId)) {
      if (!this.ownedTabs.size && !this.delegatedBrowsers.size) return errorEnvelope(this.lastState, ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'No task tab remains. Create a fresh task tab before using this browser tool.', { retryable: true });
      if ([...this.delegatedBrowsers].some(child => child.ownedTabs.has(input.tabId))) {
        return errorEnvelope(this.lastState, ERROR_CODES.TAB_BUSY,
          'A helper currently controls this tab. Wait for its result or use another task-owned tab; after handoff, observe the page again.', { retryable: true });
      }
      return errorEnvelope(this.lastState, ERROR_CODES.POLICY_DENIED,
        'This tab is outside this task. Use browser_list_tabs to choose a task-owned tab.');
    }
    // Include approval/classification waits, not only the final page dispatch.
    // This prevents an in-flight parent action from racing a tab handoff.
    const tabs = operation === OPERATIONS.LIST_TABS ? [...this.ownedTabs.keys()]
      : this.ownedTabs.has(input?.tabId) ? [input.tabId] : [];
    for (const id of tabs) this.pendingTabOperations.set(id, (this.pendingTabOperations.get(id) || 0) + 1);
    try { return await this.#executeScoped(operation, input, execution); }
    finally {
      for (const id of tabs) {
        const remaining = this.pendingTabOperations.get(id) - 1;
        if (remaining) this.pendingTabOperations.set(id, remaining); else this.pendingTabOperations.delete(id);
      }
    }
  }

  async #executeScoped(operation, input = {}, execution = {}) {
    await this.#awaitExternalApprovalBarrier();
    if (!ORIGIN_SCOPED_OPERATIONS.has(operation)) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.POLICY_DENIED,
        'This operation is outside the embedded agent capability scope'
      );
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.POLICY_DENIED,
        'The embedded agent is restricted to its assigned browser tab'
      );
    }

    if (operation === OPERATIONS.LIST_TABS) return this.#listOwnedTabs();
    if (operation === OPERATIONS.LIST_DOWNLOADS) {
      return this.#executeController(operation, input, execution);
    }
    if (operation === OPERATIONS.NODE_STATUS) {
      return this.#executeController(operation, input, execution);
    }
    if (operation === OPERATIONS.NODE_REQUEST) {
      return this.#executeController(operation, input, {
        ...execution,
        classifyEffect: this.classifyEffect,
        requestApproval: this.requestApproval,
      });
    }
    if (operation === OPERATIONS.NODE_OPERATION_STATUS) {
      return this.#executeController(operation, input, execution);
    }
    if (operation === OPERATIONS.SWARM_PUBLISH) {
      return this.#executeController(operation, input, {
        ...execution,
        requestApproval: this.requestApproval,
      });
    }
    if (operation === OPERATIONS.SWARM_PUBLICATION_STATUS) {
      return this.#executeController(operation, input, execution);
    }
    if (operation === OPERATIONS.NODE_LIFECYCLE) {
      return this.#executeController(operation, input, {
        ...execution,
        classifyEffect: this.classifyEffect,
        requestApproval: this.requestApproval,
      });
    }
    if (
      operation === OPERATIONS.NODE_DIAGNOSTICS ||
      operation === OPERATIONS.APP_DIAGNOSTICS
    ) {
      return this.#executeController(operation, input, {
        ...execution,
        requestApproval: (request) => this.#requestDiagnosticApproval(request),
      });
    }
    if (operation === OPERATIONS.WALLET_TRANSFER) {
      return this.#executeController(operation, input, {
        ...execution,
        requestApproval: this.requestApproval,
      });
    }
    if (operation === OPERATIONS.CREATE_TAB) {
      // Creating a tab from an explicit URL does not depend on observed page
      // content. Require fresh references for page actions; ownership and URL
      // checks still run in #createOwnedTab.
      return this.#createOwnedTab(input);
    }
    if (this.ownedTabs.size === 0) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'No task tab remains. Create a fresh task tab before using this browser tool.',
        { retryable: true }
      );
    }
    if (typeof input.tabId !== 'string' || !this.ownedTabs.has(input.tabId)) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.POLICY_DENIED,
        'The embedded agent can only access tabs owned by this task'
      );
    }

    const state = await this.#readState(input.tabId);
    if (!state.ok) return state;
    if (operation === OPERATIONS.GET_TAB) {
      if (!this.#acceptCurrentOrigin(state)) return this.#originDenied(state);
      this.activeTabId = input.tabId;
      return state;
    }
    // Cancellation authority must survive an unexpected redirect so Freedom
    // can still stop page activity before refusing further observation/action.
    if (operation === OPERATIONS.STOP_LOADING) {
      return this.#executeController(operation, input, execution);
    }
    if (operation === OPERATIONS.CLOSE_TAB) {
      if (input.tabId === this.adoptedTabId) {
        return errorEnvelope(
          state,
          ERROR_CODES.POLICY_DENIED,
          'The agent cannot close the originally adopted user tab'
        );
      }
      const result = await this.#executeController(operation, input, execution);
      if (result?.ok) {
        this.ownedTabs.delete(input.tabId);
        this.freshReferences.delete(input.tabId);
        if (this.activeTabId === input.tabId) this.activeTabId = this.#fallbackTabId();
        result.result.activeTabId = this.activeTabId;
      }
      return result;
    }
    if (!this.#acceptCurrentOrigin(state)) return this.#originDenied(state);
    // Fresh observations are always permitted. Only references from before a
    // user turn or ownership handoff need refreshing, independently for each tab.
    const fresh = this.freshReferences.get(input.tabId);
    const reference = operation === OPERATIONS.CALL_PAGE_TOOL ? input.toolRef
      : operation === OPERATIONS.TARGET_POINT ? input.captureRef : input.ref;
    if (fresh && (PAGE_INTERACTION_OPERATIONS.has(operation) ||
        [OPERATIONS.CALL_PAGE_TOOL, OPERATIONS.TARGET_POINT].includes(operation)) &&
        typeof reference === 'string' && !fresh.has(reference)) {
      const instruction = operation === OPERATIONS.CALL_PAGE_TOOL
        ? 'Call browser_list_page_tools on this tab and use a newly returned toolRef.'
        : operation === OPERATIONS.TARGET_POINT || reference.startsWith('visual_')
          ? 'Take a fresh browser_screenshot of this tab, then use browser_target_point with its captureRef.'
          : reference.startsWith('frame_element_')
            ? 'Call browser_list_frames then browser_read_frame on this tab and use newly returned element references.'
            : 'Take a fresh browser_snapshot of this tab and use newly returned element references.';
      return errorEnvelope(state, ERROR_CODES.OBSERVATION_REQUIRED,
        `${instruction} The action was not run. Continue the authorized task after refreshing; no new permission is needed.`,
        { retryable: true });
    }

    const requestedUrl =
      operation === OPERATIONS.NAVIGATE ||
      (operation === OPERATIONS.WAIT && input.condition === 'url')
        ? input.url
        : null;
    if (requestedUrl && !this.#acceptRequestedOrigin(requestedUrl)) {
      return this.#originDenied(state);
    }

    if (operation === OPERATIONS.GET_DIALOG) {
      const observed = await this.#executeController(operation, input, execution);
      if (observed.ok && observed.result.dialog && !this.#acceptRequestedOrigin(observed.result.dialog.url))
        return this.#originDenied(state);
      return observed;
    }
    if (operation === OPERATIONS.CALL_PAGE_TOOL) {
      const inspected = await this.controller.inspectAction(operation, input);
      if (!inspected.ok) return inspected;
      const tool = inspected.result;
      if (!this.#acceptRequestedOrigin(tool.url) ||
          (tool.formAction && !this.#acceptRequestedOrigin(tool.formAction))) return this.#originDenied(state);
      const expectedPageTool = JSON.stringify(tool);
      const { toolRef: _toolRef, ...decisionTool } = tool;
      const key = `${input.tabId}:${JSON.stringify(decisionTool)}`;
      if (this.declinedActions.has(key)) return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'This page tool invocation was declined');
      if (typeof this.requestApproval !== 'function') return errorEnvelope(state, ERROR_CODES.APPROVAL_REQUIRED, 'Page tool invocations require approval');
      const monitored = await this.controller.preparePageDialogs?.(input.tabId);
      if (monitored?.ok && monitored.result.dialog)
        return errorEnvelope(state, ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Handle the pending native dialog before invoking a page tool');
      const decision = await this.requestApproval({
        action: 'browser_interaction', operation, tabId: input.tabId,
        origin: originScopeForUrl(tool.url), destinationOrigin: originScopeForUrl(tool.formAction) || '',
        label: tool.name,
        pageTool: { name: tool.name, argumentsJSON: JSON.stringify(tool.arguments), manualSubmit: tool.manualSubmit },
      });
      const decisionStatus = typeof decision === 'object' ? decision?.status : decision;
      if (decisionStatus !== 'approved' && decisionStatus !== true) {
        if (decisionStatus !== 'withdrawn') this.declinedActions.add(key);
        return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'Page tool approval was declined or withdrawn');
      }
      const current = await this.#readState(input.tabId);
      if (!current.ok) return current;
      if (!this.#acceptCurrentOrigin(current)) return this.#originDenied(current);
      if (!this.ownedTabs.has(input.tabId))
        return errorEnvelope(current, ERROR_CODES.POLICY_DENIED, 'This task no longer controls the page');
      const result = await this.#executeController(operation, input, { ...execution, expectedPageTool });
      // A tool can trigger the same provider/wallet requests as DOM input.
      await new Promise((resolve) => setTimeout(resolve, TRUSTED_INPUT_EFFECT_SETTLE_MS));
      await this.#awaitExternalApprovalBarrier();
      const after = await this.#readState(input.tabId);
      if (!after.ok) return after;
      if (!this.#acceptCurrentOrigin(after)) return this.#originDenied(after);
      return result;
    }
    if (operation === OPERATIONS.HANDLE_DIALOG) {
      const inspected = await this.controller.inspectAction(operation, input);
      if (!inspected.ok) return inspected;
      const dialog = inspected.result;
      if (dialog.navigationTarget && !this.#acceptRequestedOrigin(dialog.navigationTarget)) return this.#originDenied(state);
      if (!this.#acceptRequestedOrigin(dialog.url)) return this.#originDenied(state);
      const expectedDialog = JSON.stringify({ ...dialog, accept: input.accept, promptText: input.promptText });
      const key = `${input.tabId}:${expectedDialog}`;
      if (this.declinedActions.has(key)) return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'This dialog response was declined');
      if (typeof this.requestApproval !== 'function') return errorEnvelope(state, ERROR_CODES.APPROVAL_REQUIRED, 'Dialog responses require approval');
      const label = dialog.navigationCancelled
        ? (input.accept ? 'Leave page and retry the cancelled navigation' : 'Stay on this page')
        : `${input.accept ? 'Accept' : 'Dismiss'} ${dialog.type}${input.promptText !== undefined ? ` with text “${input.promptText}”` : ''}`;
      const decision = await this.requestApproval({
        action: 'browser_interaction', operation, tabId: input.tabId,
        origin: originScopeForUrl(dialog.url), destinationOrigin: originScopeForUrl(dialog.navigationTarget) || '', label,
        interaction: { kind: 'consequential', confidence: 1,
          summary: `${label.slice(0, 155)}: ${dialog.message.slice(0, 75)}`,
          uncertainties: ['Dialog text is untrusted website content. The page may act on either response.'] },
      });
      if (decision !== 'approved' && decision !== true) {
        if (decision !== 'withdrawn') this.declinedActions.add(key);
        return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'Dialog response approval was declined or withdrawn');
      }
      const current = await this.#readState(input.tabId);
      if (!current.ok) return current;
      if (!this.#acceptCurrentOrigin(current)) return this.#originDenied(current);
      const result = await this.#executeController(operation, input, { ...execution, expectedDialog });
      if (result?.ok) {
        // A dialog callback can trigger the same wallet/provider IPC as a click.
        await new Promise((resolve) => setTimeout(resolve, TRUSTED_INPUT_EFFECT_SETTLE_MS));
        await this.#awaitExternalApprovalBarrier();
        if (result.result?.navigationRetried) {
          const navigated = await this.#readState(input.tabId);
          if (!navigated.ok) return navigated;
          if (!this.#acceptCurrentOrigin(navigated)) return this.#originDenied(navigated);
        }
      }
      return result;
    }

    if (operation === OPERATIONS.READ_FRAME) {
      execution.authorizeFrame = (frame) => this.#acceptRequestedOrigin(frame?.origin);
    }

    if (PAGE_INTERACTION_OPERATIONS.has(operation) || operation === OPERATIONS.NAVIGATE) {
      const monitored = await this.controller.preparePageDialogs?.(input.tabId);
      if (monitored?.ok && monitored.result.dialog)
        return errorEnvelope(state, ERROR_CODES.CAPABILITY_UNAVAILABLE,
          'A native dialog is pending. Use browser_get_dialog before further page interaction.');
    }

    if (PAGE_INTERACTION_OPERATIONS.has(operation)) {
      if (typeof input.ref === 'string' && input.ref.startsWith('frame_element_')) {
        execution = { ...execution, authorizeFrame: (frame) => this.#acceptRequestedOrigin(frame?.origin) };
      }
      const approval = await this.#authorizeAction(operation, input, state, execution);
      if (approval) return approval;
    }

    if (operation === OPERATIONS.FOCUS_TAB) {
      const result = await this.#executeController(operation, input, execution);
      if (result?.ok) this.activeTabId = input.tabId;
      return result;
    }
    const result = await this.#executeController(operation, input, execution);
    if (result?.ok && PAGE_INTERACTION_OPERATIONS.has(operation)) {
      // Trusted input is queued into the guest renderer. Allow the resulting
      // event handler and its guest/host IPC to settle so a synchronously
      // triggered provider request can install its approval barrier before Pi
      // is allowed to take another step or finish the turn.
      await new Promise((resolve) => setTimeout(resolve, TRUSTED_INPUT_EFFECT_SETTLE_MS));
      await this.#awaitExternalApprovalBarrier();
    }
    if (result?.ok && fresh) {
      const refs = [];
      if ([OPERATIONS.SNAPSHOT, OPERATIONS.READ_FRAME].includes(operation)) {
        refs.push(...(result.result?.elements || []).map(element => element.ref),
          ...(result.result?.frames || []).map(frame => frame.viewport?.ref));
      } else if (operation === OPERATIONS.SCREENSHOT) refs.push(result.result?.captureRef);
      else if (operation === OPERATIONS.TARGET_POINT) refs.push(result.result?.ref);
      else if (operation === OPERATIONS.LIST_PAGE_TOOLS) refs.push(...(result.result?.tools || []).map(tool => tool.toolRef));
      for (const ref of refs) if (typeof ref === 'string' && ref) fresh.add(ref);
    }
    if (result?.ok && operation === OPERATIONS.NAVIGATE) {
      fresh?.clear();
      const navigatedState = await this.#readState(input.tabId);
      if (!navigatedState.ok) return navigatedState;
      if (!this.#acceptCurrentOrigin(navigatedState)) {
        return this.#originDenied(navigatedState);
      }
    }
    return result;
  }

  handleTabLifecycle(event) {
    for (const child of this.delegatedBrowsers) child.handleTabLifecycle(event);
    if (event?.type !== 'tab_closed' || typeof event.tabId !== 'string') return;
    this.ownedTabs.delete(event.tabId);
    this.freshReferences.delete(event.tabId);
    if (this.activeTabId === event.tabId) this.activeTabId = this.#fallbackTabId();
  }

  #fallbackTabId() {
    return [...this.ownedTabs.keys()].at(-1) || null;
  }

  #executeController(operation, input, execution = {}) {
    if (!this.transferOwnerId && Object.keys(execution).length === 0) {
      return this.controller.execute(operation, input);
    }
    return this.controller.execute(operation, input, {
      ...execution,
      conversationId: this.transferOwnerId,
    });
  }

  async #awaitExternalApprovalBarrier() {
    while (this.externalApprovalBarriers.size) {
      await Promise.allSettled([...this.externalApprovalBarriers]);
    }
  }

  async #readActiveState() {
    while (this.activeTabId) {
      const tabId = this.activeTabId;
      const state = await this.#readState(tabId);
      if (state?.ok || state?.error?.code !== ERROR_CODES.TAB_NOT_FOUND) return state;
      this.ownedTabs.delete(tabId);
      this.freshReferences.delete(tabId);
      this.activeTabId = this.#fallbackTabId();
    }
    return null;
  }

  async #readState(tabId) {
    const state = await this.controller.execute(OPERATIONS.GET_TAB, { tabId });
    if (state?.runtimeId) this.lastState = state;
    return state;
  }

  async #listOwnedTabs() {
    const tabs = [];
    for (const tabId of [...this.ownedTabs.keys()]) {
      const state = await this.#readState(tabId);
      if (!state?.ok) {
        if (state?.error?.code === ERROR_CODES.TAB_NOT_FOUND) {
          this.ownedTabs.delete(tabId);
          this.freshReferences.delete(tabId);
          if (this.activeTabId === tabId) this.activeTabId = this.#fallbackTabId();
          continue;
        }
        return state;
      }
      if (!this.#acceptCurrentOrigin(state)) {
        tabs.push({
          tabId,
          kind: state.result.tab?.kind || 'unknown',
          url: '',
          title: 'Unavailable task tab',
          available: false,
          unavailableReason: 'outside_supported_workspace',
        });
        continue;
      }
      tabs.push(state.result.tab);
    }
    return {
      ok: true,
      ...(this.lastState?.runtimeId && { runtimeId: this.lastState.runtimeId }),
      ...(this.lastState?.contextId && { contextId: this.lastState.contextId }),
      result: { tabs, activeTabId: this.activeTabId },
    };
  }

  async #createOwnedTab(input) {
    if (this.ownedTabs.size === 0) return this.#createFirstWorkspaceTab(input.url);
    if (typeof input.tabId !== 'string' || !this.ownedTabs.has(input.tabId)) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.POLICY_DENIED,
        'A task-owned opener tab is required to create a tab'
      );
    }
    const openerState = await this.#readState(input.tabId);
    if (!openerState.ok) return openerState;
    if (!this.#acceptCurrentOrigin(openerState)) return this.#originDenied(openerState);
    if (!this.#acceptRequestedOrigin(input.url)) return this.#originDenied(openerState);
    const result = await this.controller.execute(OPERATIONS.CREATE_TAB, {
      url: input.url,
      openerTabId: input.tabId,
    });
    const createdTabId = result?.result?.tab?.tabId;
    if (result?.ok && typeof createdTabId === 'string') {
      if (!this.#acceptCurrentOrigin({ result: { tab: result.result.tab } })) {
        await this.controller.execute(OPERATIONS.CLOSE_TAB, { tabId: createdTabId });
        return this.#originDenied(openerState);
      }
      this.ownedTabs.set(createdTabId, { created: true });
      this.freshReferences.set(createdTabId, new Set());
      this.#notifyWorkspaceTabCreated(createdTabId);
      this.activeTabId = createdTabId;
      result.result.activeTabId = createdTabId;
    }
    return result;
  }

  async #createFirstWorkspaceTab(url) {
    if (typeof this.createWorkspacePage !== 'function') {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'A fresh task tab cannot be created in this browser window',
        { retryable: true }
      );
    }
    if (!this.#acceptRequestedOrigin(url)) return this.#originDenied(this.lastState);
    let createdTabId;
    try {
      createdTabId = await this.createWorkspacePage(url);
    } catch {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'A fresh task tab could not be created in this browser window',
        { retryable: true }
      );
    }
    if (typeof createdTabId !== 'string' || !createdTabId) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.INTERNAL_ERROR,
        'The fresh task tab did not receive a valid browser binding'
      );
    }
    const state = await this.#readState(createdTabId);
    if (!state?.ok) {
      await this.controller.execute(OPERATIONS.CLOSE_TAB, { tabId: createdTabId });
      return state;
    }
    if (!this.#acceptCurrentOrigin(state)) {
      await this.controller.execute(OPERATIONS.CLOSE_TAB, { tabId: createdTabId });
      return this.#originDenied(state);
    }
    this.ownedTabs.set(createdTabId, { created: true });
    this.freshReferences.set(createdTabId, new Set());
    this.#notifyWorkspaceTabCreated(createdTabId);
    this.activeTabId = createdTabId;
    return {
      ...state,
      result: { tab: state.result.tab, activeTabId: createdTabId },
    };
  }

  #acceptCurrentOrigin(state) {
    const currentOrigin = originScopeForUrl(state?.result?.tab?.url);
    if (currentOrigin) {
      this.workspaceEstablished = true;
      return true;
    }
    return !this.workspaceEstablished;
  }

  #notifyWorkspaceTabCreated(tabId) {
    if (typeof this.onWorkspaceTabCreated !== 'function') return;
    try {
      this.onWorkspaceTabCreated(tabId);
    } catch {
      // Presentation metadata cannot invalidate an already-created browser tab.
    }
  }

  #acceptRequestedOrigin(url) {
    return Boolean(originScopeForUrl(url));
  }

  #originDenied(state) {
    return errorEnvelope(
      state,
      ERROR_CODES.POLICY_DENIED,
      'The task workspace can only use supported web and distributed-web pages'
    );
  }

  async #requestDiagnosticApproval(request) {
    if (this.diagnosticGrant) {
      return { status: 'approved', diagnosticScope: 'conversation' };
    }
    const key = JSON.stringify([
      request?.operation || '',
      request?.diagnostic?.scope || '',
      request?.diagnostic?.service || '',
    ]);
    if (this.declinedDiagnostics.has(key) || typeof this.requestApproval !== 'function') {
      return 'declined';
    }
    const decision = await this.requestApproval(request);
    const status = typeof decision === 'object' ? decision?.status : decision;
    if (
      status === 'approved' &&
      typeof decision === 'object' &&
      decision.diagnosticScope === 'conversation'
    ) {
      this.diagnosticGrant = true;
    } else if (status !== 'approved' && decision !== true) {
      this.declinedDiagnostics.add(key);
    }
    return decision;
  }

  #inspectAction(operation, input) {
    return typeof input.ref === 'string' && input.ref.startsWith('frame_element_')
      ? this.controller.inspectAction(operation, input, { authorizeFrame: (frame) => this.#acceptRequestedOrigin(frame?.origin) })
      : this.controller.inspectAction(operation, input);
  }

  async #authorizeAction(operation, input, state, execution) {
    if (
      this.approvalMode === AGENT_APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS &&
      operation !== OPERATIONS.DOWNLOAD &&
      operation !== OPERATIONS.UPLOAD &&
      !input.ref?.startsWith('frame_element_') && !input.ref?.startsWith('visual_')
    ) {
      return null;
    }
    const inspected = await this.#inspectAction(operation, input);
    if (!inspected?.ok) return inspected;
    const element = actionDescriptor(inspected.result);
    if (element.visual) {
      execution.expectedVisualAction = element;
      if (this.approvalMode === AGENT_APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS) return null;
    }
    if (element.frameRef) {
      if (!this.#acceptRequestedOrigin(element.origin)) return this.#originDenied(state);
      execution.expectedFrameAction = element;
      if (this.approvalMode === AGENT_APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS) return null;
    }
    const actionKey = JSON.stringify([
      operation,
      input.tabId,
      input.ref,
      input.key || '',
      input.direction || '',
      input.pages ?? 1,
      input.values ?? input.value ?? '',
      input.text || '',
      input.replace !== false,
      element.effect,
      element.label,
      element.navigationTarget,
      element.formPayloadFingerprint,
      element.frameRef || '', element.origin || '',
    ]);
    if (this.declinedActions.has(actionKey)) {
      return errorEnvelope(
        state,
        ERROR_CODES.USER_CANCELLED,
        'The user declined this website interaction'
      );
    }
    let interaction = null;
    if (
      this.approvalMode === AGENT_APPROVAL_MODES.SENSITIVE_ACTIONS &&
      operation !== OPERATIONS.DOWNLOAD &&
      operation !== OPERATIONS.UPLOAD
    ) {
      if (element.visual) {
        interaction = uncertainInteractionClassification('visual_effect_unknown');
      } else if (element.effect === 'form_submission') {
        interaction = Object.freeze({
          kind: 'consequential',
          confidence: 1,
          summary: `Submit ${element.label ? `“${element.label}”` : 'this form'}.`,
          uncertainties: Object.freeze([]),
        });
      } else {
        try {
          interaction = normalizeInteractionClassification(
            typeof this.classifyInteraction === 'function'
              ? await this.classifyInteraction({
                  action: {
                    operation,
                    intent:
                      typeof input.intent === 'string' ? input.intent.trim().slice(0, 240) : '',
                    ...(operation === OPERATIONS.PRESS && { key: input.key || '' }),
                    ...(operation === OPERATIONS.SCROLL && {
                      direction: input.direction,
                      pages: input.pages ?? 1,
                    }),
                    ...(operation === OPERATIONS.TYPE && {
                      characters: typeof input.text === 'string' ? input.text.length : 0,
                      replace: input.replace !== false,
                    }),
                    ...(operation === OPERATIONS.SELECT && {
                      ...(Array.isArray(input.values) ? { values: input.values.map((value) => value.slice(0, 240)) } : { value: typeof input.value === 'string' ? input.value.slice(0, 240) : '' }),
                    }),
                  },
                  trustedContext: {
                    origin: element.origin || originScopeForUrl(state?.result?.tab?.url) || '',
                    mechanism: element.effect || 'generic_interaction',
                    destinationOrigin: originScopeForUrl(element.navigationTarget) || '',
                  },
                  untrustedContext: { label: element.label },
                })
              : null
          );
        } catch {
          interaction = uncertainInteractionClassification('classifier_provider_error');
        }
      }
      if (interactionMayProceed(interaction)) {
        return this.#revalidateAuthorizedAction(operation, input, element);
      }
    }
    if (typeof this.requestApproval !== 'function') {
      return errorEnvelope(
        state,
        ERROR_CODES.APPROVAL_REQUIRED,
        'This website interaction requires user approval'
      );
    }
    const decision = await this.requestApproval({
      action:
        element.effect === 'form_submission'
          ? 'form_submission'
          : element.effect === 'file_download'
            ? 'file_download'
            : element.effect === 'file_upload'
              ? 'file_upload'
              : 'browser_interaction',
      operation,
      tabId: input.tabId,
      origin: element.origin || originScopeForUrl(state?.result?.tab?.url) || '',
      destinationOrigin:
        element.effect === 'file_upload'
          ? originScopeForUrl(state?.result?.tab?.url) || ''
          : originScopeForUrl(element.navigationTarget) || '',
      label: element.label,
      ...(interaction && { interaction }),
    });
    if (decision === 'withdrawn') {
      return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'Interaction approval was withdrawn');
    }
    if (decision !== 'approved' && decision !== true) {
      this.declinedActions.add(actionKey);
      return errorEnvelope(
        state,
        ERROR_CODES.USER_CANCELLED,
        'The user declined this website interaction'
      );
    }

    return this.#revalidateAuthorizedAction(operation, input, element);
  }

  async #revalidateAuthorizedAction(operation, input, element) {
    const currentState = await this.#readState(input.tabId);
    if (!currentState.ok) return currentState;
    if (!this.#acceptCurrentOrigin(currentState)) return this.#originDenied(currentState);
    const reinspected = await this.#inspectAction(operation, input);
    if (!reinspected?.ok) return reinspected;
    const currentElement = actionDescriptor(reinspected.result);
    if (!sameActionDescriptor(element, currentElement)) {
      return errorEnvelope(
        currentState,
        ERROR_CODES.STALE_ELEMENT_REFERENCE,
        'The approved website interaction changed before it could run',
        { retryable: true }
      );
    }
    return null;
  }
}

async function createOriginScopedAutomationController(options = {}) {
  if (!options.controller || typeof options.controller.execute !== 'function') {
    throw new TypeError('Origin-scoped automation requires a controller');
  }
  if (typeof options.controller.inspectAction !== 'function') {
    throw new TypeError('Origin-scoped automation requires action inspection');
  }
  if (
    options.tabId !== null &&
    options.tabId !== undefined &&
    (typeof options.tabId !== 'string' || !options.tabId.trim())
  ) {
    throw new TypeError('Origin-scoped automation requires a valid tabId or an empty workspace');
  }
  if (typeof options.tabId === 'string' && options.tabId !== options.tabId.trim()) {
    throw new TypeError('Origin-scoped automation tabId cannot contain surrounding whitespace');
  }
  if (
    options.createWorkspacePage !== undefined &&
    typeof options.createWorkspacePage !== 'function'
  ) {
    throw new TypeError('Origin-scoped automation requires a valid workspace page creator');
  }
  if (
    options.onWorkspaceTabCreated !== undefined &&
    typeof options.onWorkspaceTabCreated !== 'function'
  ) {
    throw new TypeError('Origin-scoped automation requires a valid workspace tab observer');
  }
  const navigationScope = normalizeAgentNavigationScope(options.navigationScope);
  if (!navigationScope) {
    throw new TypeError('Origin-scoped automation requires a valid navigation scope');
  }
  const approvalMode = normalizeAgentApprovalMode(options.approvalMode);
  if (!approvalMode) {
    throw new TypeError('Origin-scoped automation requires a supported approval mode');
  }
  let initialState = null;
  if (typeof options.tabId === 'string') {
    initialState = await options.controller.execute(OPERATIONS.GET_TAB, {
      tabId: options.tabId,
    });
    if (!initialState?.ok) {
      throw new Error('The assigned automation tab is unavailable');
    }
  }
  return new OriginScopedAutomationController({
    controller: options.controller,
    tabId: options.tabId,
    initialState,
    approvalMode,
    requestApproval: options.requestApproval,
    classifyEffect: options.classifyEffect,
    classifyInteraction: options.classifyInteraction,
    createWorkspacePage: options.createWorkspacePage,
    onWorkspaceTabCreated: options.onWorkspaceTabCreated,
    transferOwnerId: options.transferOwnerId,
  });
}

module.exports = {
  DELEGATED_BROWSER_OPERATIONS,
  ORIGIN_SCOPED_OPERATIONS,
  OriginScopedAutomationController,
  createOriginScopedAutomationController,
  originScopeForUrl,
};
