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
  OPERATIONS.NAVIGATE,
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
  OPERATIONS.SELECT,
  OPERATIONS.PRESS,
  OPERATIONS.UPLOAD,
  OPERATIONS.DOWNLOAD,
  OPERATIONS.LIST_DOWNLOADS,
  OPERATIONS.WAIT,
  OPERATIONS.STOP_LOADING,
]);
const SCOPED_SCHEMES = new Set(['http:', 'https:', 'bzz:', 'ipfs:', 'ipns:']);
const PAGE_INTERACTION_OPERATIONS = new Set([
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
  OPERATIONS.SELECT,
  OPERATIONS.PRESS,
  OPERATIONS.UPLOAD,
  OPERATIONS.DOWNLOAD,
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
    effect: ['form_submission', 'file_download', 'file_upload'].includes(element?.effect)
      ? element.effect
      : '',
    label: typeof element?.label === 'string' ? element.label : '',
    navigationTarget: typeof element?.navigationTarget === 'string' ? element.navigationTarget : '',
    formPayloadFingerprint:
      typeof element?.formPayloadFingerprint === 'string' ? element.formPayloadFingerprint : '',
  });
}

function sameActionDescriptor(left, right) {
  return (
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
    this.createWorkspacePage = createWorkspacePage;
    this.onWorkspaceTabCreated = onWorkspaceTabCreated;
    this.transferOwnerId = transferOwnerId;
    this.declinedActions = new Set();
    this.resumeObservation = null;
  }

  async prepareResume() {
    const state = await this.#readActiveState();
    if (!state) {
      this.resumeObservation = 'create_tab';
      return { ok: true, activeTabId: null, workspaceEmpty: true };
    }
    if (!state.ok) return state;
    if (!this.#acceptCurrentOrigin(state)) return this.#originDenied(state);
    this.resumeObservation = 'get_tab';
    return { ok: true, activeTabId: this.activeTabId, workspaceEmpty: false };
  }

  getActiveTabId() {
    return this.activeTabId;
  }

  getWorkspaceState() {
    return {
      tabIds: [...this.ownedTabs.keys()],
      activeTabId: this.activeTabId,
    };
  }

  releaseTab(tabId) {
    if (typeof tabId !== 'string' || !this.ownedTabs.has(tabId)) return false;
    this.ownedTabs.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = this.#fallbackTabId();
    return true;
  }

  async execute(operation, input = {}, execution = {}) {
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
    if (operation === OPERATIONS.CREATE_TAB) {
      if (this.resumeObservation && this.resumeObservation !== 'create_tab') {
        return errorEnvelope(
          this.lastState,
          ERROR_CODES.POLICY_DENIED,
          'After resume, get the current tab and take a fresh snapshot before acting'
        );
      }
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
      if (this.resumeObservation === 'get_tab') this.resumeObservation = 'snapshot';
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
        if (this.activeTabId === input.tabId) this.activeTabId = this.#fallbackTabId();
        result.result.activeTabId = this.activeTabId;
      }
      return result;
    }
    if (!this.#acceptCurrentOrigin(state)) return this.#originDenied(state);

    if (this.resumeObservation) {
      if (operation !== OPERATIONS.SNAPSHOT || this.resumeObservation !== 'snapshot') {
        return errorEnvelope(
          state,
          ERROR_CODES.POLICY_DENIED,
          'After resume, get the current tab and take a fresh snapshot before acting'
        );
      }
    }

    const requestedUrl =
      operation === OPERATIONS.NAVIGATE ||
      (operation === OPERATIONS.WAIT && input.condition === 'url')
        ? input.url
        : null;
    if (requestedUrl && !this.#acceptRequestedOrigin(requestedUrl)) {
      return this.#originDenied(state);
    }

    if (PAGE_INTERACTION_OPERATIONS.has(operation)) {
      const approval = await this.#authorizeAction(operation, input, state);
      if (approval) return approval;
    }

    if (operation === OPERATIONS.FOCUS_TAB) {
      const result = await this.#executeController(operation, input, execution);
      if (result?.ok) this.activeTabId = input.tabId;
      return result;
    }
    const result = await this.#executeController(operation, input, execution);
    if (result?.ok && operation === OPERATIONS.SNAPSHOT) {
      this.resumeObservation = null;
    }
    if (result?.ok && operation === OPERATIONS.NAVIGATE) {
      const navigatedState = await this.#readState(input.tabId);
      if (!navigatedState.ok) return navigatedState;
      if (!this.#acceptCurrentOrigin(navigatedState)) {
        return this.#originDenied(navigatedState);
      }
    }
    return result;
  }

  handleTabLifecycle(event) {
    if (event?.type !== 'tab_closed' || typeof event.tabId !== 'string') return;
    this.ownedTabs.delete(event.tabId);
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

  async #readActiveState() {
    while (this.activeTabId) {
      const tabId = this.activeTabId;
      const state = await this.#readState(tabId);
      if (state?.ok || state?.error?.code !== ERROR_CODES.TAB_NOT_FOUND) return state;
      this.ownedTabs.delete(tabId);
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
      this.#notifyWorkspaceTabCreated(createdTabId);
      this.activeTabId = createdTabId;
      if (this.resumeObservation === 'create_tab') this.resumeObservation = 'snapshot';
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
    const resumingEmptyWorkspace = this.resumeObservation === 'create_tab';
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
    this.#notifyWorkspaceTabCreated(createdTabId);
    this.activeTabId = createdTabId;
    if (resumingEmptyWorkspace) this.resumeObservation = 'snapshot';
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

  async #authorizeAction(operation, input, state) {
    if (
      this.approvalMode === AGENT_APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS &&
      operation !== OPERATIONS.DOWNLOAD &&
      operation !== OPERATIONS.UPLOAD
    ) {
      return null;
    }
    const inspected = await this.controller.inspectAction(operation, input);
    if (!inspected?.ok) return inspected;
    const element = actionDescriptor(inspected.result);
    const actionKey = JSON.stringify([
      operation,
      input.tabId,
      input.ref,
      input.key || '',
      input.value || '',
      input.text || '',
      input.replace !== false,
      element.effect,
      element.label,
      element.navigationTarget,
      element.formPayloadFingerprint,
    ]);
    if (this.declinedActions.has(actionKey)) {
      return errorEnvelope(
        state,
        ERROR_CODES.USER_CANCELLED,
        'The user declined this website interaction'
      );
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
      origin: originScopeForUrl(state?.result?.tab?.url) || '',
      destinationOrigin:
        element.effect === 'file_upload'
          ? originScopeForUrl(state?.result?.tab?.url) || ''
          : originScopeForUrl(element.navigationTarget) || '',
      label: element.label,
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

    const currentState = await this.#readState(input.tabId);
    if (!currentState.ok) return currentState;
    if (!this.#acceptCurrentOrigin(currentState)) return this.#originDenied(currentState);
    const reinspected = await this.controller.inspectAction(operation, input);
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
    createWorkspacePage: options.createWorkspacePage,
    onWorkspaceTabCreated: options.onWorkspaceTabCreated,
    transferOwnerId: options.transferOwnerId,
  });
}

module.exports = {
  ORIGIN_SCOPED_OPERATIONS,
  OriginScopedAutomationController,
  createOriginScopedAutomationController,
  originScopeForUrl,
};
