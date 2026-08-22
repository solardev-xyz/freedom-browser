'use strict';

const { OPERATIONS } = require('./contract/operations');
const { ERROR_CODES } = require('./contract/errors');

const ORIGIN_SCOPED_OPERATIONS = new Set([
  OPERATIONS.GET_TAB,
  OPERATIONS.SNAPSHOT,
  OPERATIONS.NAVIGATE,
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
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

function errorEnvelope(state, code, message) {
  return {
    ok: false,
    ...(state?.runtimeId && { runtimeId: state.runtimeId }),
    ...(state?.contextId && { contextId: state.contextId }),
    ...(state?.tabId && { tabId: state.tabId }),
    ...(Number.isInteger(state?.navigationId) && { navigationId: state.navigationId }),
    error: {
      code,
      message,
      retryable: false,
    },
  };
}

class OriginScopedAutomationController {
  constructor({ controller, tabId, initialState, requestApproval }) {
    this.controller = controller;
    this.tabId = tabId;
    this.scopeOrigin = originScopeForUrl(initialState?.result?.tab?.url);
    this.lastState = initialState;
    this.requestApproval = requestApproval;
    this.declinedCommitActions = new Set();
  }

  async execute(operation, input = {}) {
    if (!ORIGIN_SCOPED_OPERATIONS.has(operation)) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.POLICY_DENIED,
        'This operation is outside the embedded agent capability scope'
      );
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.tabId !== this.tabId) {
      return errorEnvelope(
        this.lastState,
        ERROR_CODES.POLICY_DENIED,
        'The embedded agent is restricted to its assigned browser tab'
      );
    }

    const state = await this.#readState();
    if (!state.ok) return state;
    if (operation === OPERATIONS.GET_TAB) return state;
    // Cancellation authority must survive an unexpected redirect so Freedom
    // can still stop page activity before refusing further observation/action.
    if (operation === OPERATIONS.STOP_LOADING) {
      return this.controller.execute(operation, input);
    }
    if (!this.#acceptCurrentOrigin(state)) return this.#originDenied(state);

    const requestedUrl =
      operation === OPERATIONS.NAVIGATE ||
      (operation === OPERATIONS.WAIT && input.condition === 'url')
        ? input.url
        : null;
    if (requestedUrl && !this.#acceptRequestedOrigin(requestedUrl)) {
      return this.#originDenied(state);
    }

    if (operation === OPERATIONS.CLICK) {
      const approval = await this.#authorizeClick(input.ref, state);
      if (approval) return approval;
    }

    const result = await this.controller.execute(operation, input);
    if (result?.ok && operation === OPERATIONS.NAVIGATE) {
      const navigatedState = await this.#readState();
      if (!navigatedState.ok) return navigatedState;
      if (!this.#acceptCurrentOrigin(navigatedState)) {
        return this.#originDenied(navigatedState);
      }
    }
    return result;
  }

  async #readState() {
    const state = await this.controller.execute(OPERATIONS.GET_TAB, { tabId: this.tabId });
    if (state?.runtimeId) this.lastState = state;
    return state;
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

  async #authorizeClick(ref, state) {
    const inspected = await this.controller.inspectAction(OPERATIONS.CLICK, {
      tabId: this.tabId,
      ref,
    });
    if (!inspected?.ok) return inspected;
    const element = inspected.result;
    if (element?.effect !== 'form_submission') return null;
    const actionKey = `${element.effect}\u0000${element.label || ''}`;
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
    const approved = await this.requestApproval({
      action: 'form_submission',
      operation: OPERATIONS.CLICK,
      origin: this.scopeOrigin || '',
      label: typeof element.label === 'string' ? element.label : '',
    });
    if (approved === true) return null;
    this.declinedCommitActions.add(actionKey);
    return errorEnvelope(state, ERROR_CODES.USER_CANCELLED, 'The user declined form submission');
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
