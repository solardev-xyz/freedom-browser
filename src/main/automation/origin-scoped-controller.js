'use strict';

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
  OPERATIONS.WAIT,
  OPERATIONS.STOP_LOADING,
]);
const SCOPED_SCHEMES = new Set(['http:', 'https:', 'bzz:', 'ipfs:', 'ipns:']);

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
    effect: element?.effect === 'form_submission' ? element.effect : '',
    label: typeof element?.label === 'string' ? element.label : '',
    navigationTarget:
      typeof element?.navigationTarget === 'string' ? element.navigationTarget : '',
  });
}

function sameActionDescriptor(left, right) {
  return (
    left.effect === right.effect &&
    left.label === right.label &&
    left.navigationTarget === right.navigationTarget
  );
}

class OriginScopedAutomationController {
  constructor({ controller, tabId, initialState, requestApproval }) {
    this.controller = controller;
    this.tabId = tabId;
    this.activeTabId = tabId;
    this.ownedTabs = new Map([[tabId, { created: false }]]);
    this.scopeOrigin = originScopeForUrl(initialState?.result?.tab?.url);
    this.lastState = initialState;
    this.requestApproval = requestApproval;
    this.declinedCommitActions = new Set();
    this.resumeObservation = null;
  }

  async prepareResume() {
    const state = await this.#readState(this.activeTabId);
    if (!state.ok) return state;
    if (!this.#acceptCurrentOrigin(state)) return this.#originDenied(state);
    this.resumeObservation = 'get_tab';
    return { ok: true };
  }

  async execute(operation, input = {}) {
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
    if (operation === OPERATIONS.CREATE_TAB) {
      if (this.resumeObservation) {
        return errorEnvelope(
          this.lastState,
          ERROR_CODES.POLICY_DENIED,
          'After resume, get the current tab and take a fresh snapshot before acting'
        );
      }
      return this.#createOwnedTab(input);
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
      this.activeTabId = input.tabId;
      if (this.resumeObservation === 'get_tab') this.resumeObservation = 'snapshot';
      return state;
    }
    // Cancellation authority must survive an unexpected redirect so Freedom
    // can still stop page activity before refusing further observation/action.
    if (operation === OPERATIONS.STOP_LOADING) {
      return this.controller.execute(operation, input);
    }
    if (operation === OPERATIONS.CLOSE_TAB) {
      if (input.tabId === this.tabId) {
        return errorEnvelope(
          state,
          ERROR_CODES.POLICY_DENIED,
          'The agent cannot close the task starting tab'
        );
      }
      const result = await this.controller.execute(operation, input);
      if (result?.ok) {
        this.ownedTabs.delete(input.tabId);
        if (this.activeTabId === input.tabId) this.activeTabId = this.tabId;
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

    if (operation === OPERATIONS.CLICK || operation === OPERATIONS.PRESS) {
      const approval = await this.#authorizeAction(operation, input, state);
      if (approval) return approval;
    }

    if (operation === OPERATIONS.FOCUS_TAB) {
      const result = await this.controller.execute(operation, input);
      if (result?.ok) this.activeTabId = input.tabId;
      return result;
    }
    const result = await this.controller.execute(operation, input);
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
    if (event.tabId === this.tabId) return;
    this.ownedTabs.delete(event.tabId);
    if (this.activeTabId === event.tabId) this.activeTabId = this.tabId;
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
        if (tabId !== this.tabId && state?.error?.code === ERROR_CODES.TAB_NOT_FOUND) {
          this.ownedTabs.delete(tabId);
          continue;
        }
        return state;
      }
      if (!this.#acceptCurrentOrigin(state)) return this.#originDenied(state);
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
      this.activeTabId = createdTabId;
      result.result.activeTabId = createdTabId;
    }
    return result;
  }

  #acceptCurrentOrigin(state) {
    const currentOrigin = originScopeForUrl(state?.result?.tab?.url);
    if (!this.scopeOrigin) {
      if (currentOrigin) this.scopeOrigin = currentOrigin;
      return true;
    }
    return currentOrigin === this.scopeOrigin;
  }

  #acceptRequestedOrigin(url) {
    const requestedOrigin = originScopeForUrl(url);
    if (!requestedOrigin) return false;
    // A browser-owned start page establishes its scope only after navigation
    // succeeds; a failed first attempt must not poison the rest of the run.
    if (!this.scopeOrigin) return true;
    return requestedOrigin === this.scopeOrigin;
  }

  #originDenied(state) {
    return errorEnvelope(
      state,
      ERROR_CODES.POLICY_DENIED,
      "The embedded agent is restricted to the controlled tab's starting site"
    );
  }

  async #authorizeAction(operation, input, state) {
    const inspected = await this.controller.inspectAction(operation, {
      tabId: input.tabId,
      ref: input.ref,
      ...(input.key && { key: input.key }),
    });
    if (!inspected?.ok) return inspected;
    const element = actionDescriptor(inspected.result);
    if (element?.navigationTarget && !this.#acceptRequestedOrigin(element.navigationTarget)) {
      return this.#originDenied(state);
    }
    if (element?.effect !== 'form_submission') return null;
    const actionKey = JSON.stringify([
      operation,
      input.tabId,
      input.key || '',
      element.effect,
      element.label,
      element.navigationTarget,
    ]);
    if (this.declinedCommitActions.has(actionKey)) {
      return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'The user declined form submission');
    }
    if (typeof this.requestApproval !== 'function') {
      return errorEnvelope(
        state,
        ERROR_CODES.APPROVAL_REQUIRED,
        'Form submission requires user approval'
      );
    }
    const decision = await this.requestApproval({
      action: 'form_submission',
      operation,
      origin: this.scopeOrigin || '',
      label: element.label,
    });
    if (decision === 'withdrawn') {
      return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'Form approval was withdrawn');
    }
    if (decision !== 'approved' && decision !== true) {
      this.declinedCommitActions.add(actionKey);
      return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'The user declined form submission');
    }

    const currentState = await this.#readState(input.tabId);
    if (!currentState.ok) return currentState;
    if (!this.#acceptCurrentOrigin(currentState)) return this.#originDenied(currentState);
    const reinspected = await this.controller.inspectAction(operation, {
      tabId: input.tabId,
      ref: input.ref,
      ...(input.key && { key: input.key }),
    });
    if (!reinspected?.ok) return reinspected;
    const currentElement = actionDescriptor(reinspected.result);
    if (
      currentElement.navigationTarget &&
      !this.#acceptRequestedOrigin(currentElement.navigationTarget)
    ) {
      return this.#originDenied(currentState);
    }
    if (!sameActionDescriptor(element, currentElement)) {
      return errorEnvelope(
        currentState,
        ERROR_CODES.STALE_ELEMENT_REFERENCE,
        'The approved form action changed before it could be submitted',
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
  if (typeof options.tabId !== 'string' || !options.tabId.trim()) {
    throw new TypeError('Origin-scoped automation requires a tabId');
  }
  if (options.tabId !== options.tabId.trim()) {
    throw new TypeError('Origin-scoped automation tabId cannot contain surrounding whitespace');
  }
  const initialState = await options.controller.execute(OPERATIONS.GET_TAB, {
    tabId: options.tabId,
  });
  if (!initialState?.ok) {
    throw new Error('The assigned automation tab is unavailable');
  }
  return new OriginScopedAutomationController({
    controller: options.controller,
    tabId: options.tabId,
    initialState,
    requestApproval: options.requestApproval,
  });
}

module.exports = {
  ORIGIN_SCOPED_OPERATIONS,
  OriginScopedAutomationController,
  createOriginScopedAutomationController,
  originScopeForUrl,
};
