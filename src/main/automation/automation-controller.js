'use strict';

const crypto = require('crypto');
const { OPERATIONS, validateOperationInput } = require('./contract/operations');
const { AutomationError, ERROR_CODES, toErrorPayload } = require('./contract/errors');
const { PageRegistry } = require('./page-registry');

function opaqueId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

class AutomationController {
  constructor(options = {}) {
    if (!options.policyController || typeof options.policyController.authorize !== 'function') {
      throw new TypeError('AutomationController requires a policyController');
    }
    this.policyController = options.policyController;
    this.runtimeId = options.runtimeId || opaqueId('runtime');
    this.contextId = options.contextId || opaqueId('context');
    this.pages = options.pageRegistry || new PageRegistry(options);
  }

  registerPage(adapter, metadata) {
    return this.pages.register(adapter, metadata);
  }

  unregisterPage(tabId) {
    return this.pages.unregister(tabId);
  }

  async execute(operation, rawInput = {}) {
    let input;
    let entry;
    try {
      input = validateOperationInput(operation, rawInput);
      if (input.tabId) entry = this.pages.require(input.tabId);

      const decision = await this.policyController.authorize({
        operation,
        input,
        runtimeId: this.runtimeId,
        contextId: this.contextId,
        tab: entry ? { tabId: entry.tabId, kind: entry.kind, ...entry.adapter.getState() } : null,
      });
      if (!decision?.allowed) {
        const code = decision?.approvalRequired
          ? ERROR_CODES.APPROVAL_REQUIRED
          : ERROR_CODES.POLICY_DENIED;
        throw new AutomationError(
          code,
          decision?.reason || 'Automation policy denied the operation'
        );
      }

      const result = await this.#dispatch(operation, input, entry);
      return this.#successEnvelope(entry, result);
    } catch (error) {
      const rawTabId = typeof rawInput?.tabId === 'string' ? rawInput.tabId.trim() : '';
      return this.#errorEnvelope(input?.tabId || rawTabId || undefined, entry, error);
    }
  }

  async #dispatch(operation, input, entry) {
    switch (operation) {
      case OPERATIONS.LIST_TABS:
        return { tabs: this.pages.list() };
      case OPERATIONS.GET_TAB:
        return { tab: { tabId: entry.tabId, kind: entry.kind, ...entry.adapter.getState() } };
      case OPERATIONS.NAVIGATE:
        return entry.adapter.navigate(input.url);
      case OPERATIONS.SNAPSHOT:
        return entry.adapter.snapshot();
      case OPERATIONS.CLICK:
        return entry.adapter.click(input.ref);
      case OPERATIONS.TYPE:
        return entry.adapter.type(input.ref, input.text, { replace: input.replace });
      case OPERATIONS.SCREENSHOT:
        return entry.adapter.screenshot();
      case OPERATIONS.WAIT:
        return entry.adapter.wait(input);
      case OPERATIONS.STOP_LOADING:
        return entry.adapter.stopLoading();
      default:
        throw new AutomationError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          `Automation operation is not implemented: ${operation}`
        );
    }
  }

  #successEnvelope(entry, result) {
    return {
      ok: true,
      runtimeId: this.runtimeId,
      contextId: this.contextId,
      ...(entry && {
        tabId: entry.tabId,
        navigationId: entry.adapter.getState().navigationId,
      }),
      result: result ?? {},
    };
  }

  #errorEnvelope(tabId, entry, error) {
    return {
      ok: false,
      runtimeId: this.runtimeId,
      contextId: this.contextId,
      ...(tabId && { tabId }),
      ...(entry && { navigationId: entry.adapter.getState().navigationId }),
      error: toErrorPayload(error),
    };
  }
}

module.exports = {
  AutomationController,
};
