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
    this.pageLifecycle = null;
    if (options.pageLifecycle) this.setPageLifecycle(options.pageLifecycle);
    this.downloadController = null;
    if (options.downloadController) this.setDownloadController(options.downloadController);
    this.uploadController = null;
    if (options.uploadController) this.setUploadController(options.uploadController);
  }

  setPageLifecycle(pageLifecycle) {
    if (pageLifecycle === null) {
      this.pageLifecycle = null;
      return;
    }
    if (
      !pageLifecycle ||
      typeof pageLifecycle.createPage !== 'function' ||
      typeof pageLifecycle.closePage !== 'function'
    ) {
      throw new TypeError('Automation page lifecycle requires createPage() and closePage()');
    }
    this.pageLifecycle = pageLifecycle;
  }

  setDownloadController(downloadController) {
    if (downloadController === null) {
      this.downloadController = null;
      return;
    }
    if (
      !downloadController ||
      typeof downloadController.download !== 'function' ||
      typeof downloadController.list !== 'function'
    ) {
      throw new TypeError('Automation download controller requires download() and list()');
    }
    this.downloadController = downloadController;
  }

  setUploadController(uploadController) {
    if (uploadController === null) {
      this.uploadController = null;
      return;
    }
    if (!uploadController || typeof uploadController.upload !== 'function') {
      throw new TypeError('Automation upload controller requires upload()');
    }
    this.uploadController = uploadController;
  }

  registerPage(adapter, metadata) {
    return this.pages.register(adapter, metadata);
  }

  unregisterPage(tabId) {
    return this.pages.unregister(tabId);
  }

  async execute(operation, rawInput = {}, execution = {}) {
    let input;
    let entry;
    try {
      input = validateOperationInput(operation, rawInput);
      if (input.tabId) entry = this.pages.require(input.tabId);
      const policyEntry =
        entry || (input.openerTabId ? this.pages.require(input.openerTabId) : undefined);

      const decision = await this.policyController.authorize({
        operation,
        input,
        runtimeId: this.runtimeId,
        contextId: this.contextId,
        tab: policyEntry
          ? {
              tabId: policyEntry.tabId,
              kind: policyEntry.kind,
              ...policyEntry.adapter.getState(),
            }
          : null,
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

      const result = await this.#dispatch(operation, input, entry, execution);
      return this.#successEnvelope(entry, result);
    } catch (error) {
      const rawTabId = typeof rawInput?.tabId === 'string' ? rawInput.tabId.trim() : '';
      return this.#errorEnvelope(input?.tabId || rawTabId || undefined, entry, error);
    }
  }

  async inspectAction(operation, rawInput = {}) {
    let input;
    let entry;
    try {
      input = validateOperationInput(operation, rawInput);
      if (
        ![
          OPERATIONS.CLICK,
          OPERATIONS.TYPE,
          OPERATIONS.SELECT,
          OPERATIONS.PRESS,
          OPERATIONS.UPLOAD,
          OPERATIONS.DOWNLOAD,
        ].includes(operation)
      ) {
        throw new AutomationError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          `Automation action inspection is not implemented: ${operation}`
        );
      }
      entry = this.pages.require(input.tabId);
      if (typeof entry.adapter.inspectAction !== 'function') {
        throw new AutomationError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          'Automation action inspection is unavailable for this page'
        );
      }
      const result = await entry.adapter.inspectAction(input.ref, {
        operation,
        ...(input.key && { key: input.key }),
      });
      return this.#successEnvelope(entry, result);
    } catch (error) {
      const rawTabId = typeof rawInput?.tabId === 'string' ? rawInput.tabId.trim() : '';
      return this.#errorEnvelope(input?.tabId || rawTabId || undefined, entry, error);
    }
  }

  async #dispatch(operation, input, entry, execution) {
    switch (operation) {
      case OPERATIONS.LIST_TABS:
        return { tabs: this.pages.list() };
      case OPERATIONS.CREATE_TAB: {
        const lifecycle = this.#requirePageLifecycle();
        const tabId = await lifecycle.createPage(input.url, {
          openerTabId: input.openerTabId || null,
        });
        const created = this.pages.require(tabId);
        return {
          tab: {
            tabId: created.tabId,
            kind: created.kind,
            ...created.adapter.getState(),
          },
        };
      }
      case OPERATIONS.GET_TAB:
        return { tab: { tabId: entry.tabId, kind: entry.kind, ...entry.adapter.getState() } };
      case OPERATIONS.FOCUS_TAB: {
        const lifecycle = this.#requirePageLifecycle();
        if (typeof lifecycle.focusPage !== 'function') {
          throw new AutomationError(
            ERROR_CODES.CAPABILITY_UNAVAILABLE,
            'The automation tab cannot be focused by this runtime'
          );
        }
        const focused = await lifecycle.focusPage(entry.tabId);
        if (!focused) {
          throw new AutomationError(
            ERROR_CODES.CAPABILITY_UNAVAILABLE,
            'The automation tab cannot be focused by this runtime'
          );
        }
        return { focused: true, tabId: entry.tabId };
      }
      case OPERATIONS.CLOSE_TAB: {
        const closed = await this.#requirePageLifecycle().closePage(entry.tabId);
        if (!closed) {
          throw new AutomationError(
            ERROR_CODES.CAPABILITY_UNAVAILABLE,
            'The automation tab cannot be closed by this runtime'
          );
        }
        return { closed: true, tabId: entry.tabId };
      }
      case OPERATIONS.NAVIGATE:
        return entry.adapter.navigate(input.url);
      case OPERATIONS.SNAPSHOT:
        return entry.adapter.snapshot();
      case OPERATIONS.CLICK:
        return entry.adapter.click(input.ref);
      case OPERATIONS.TYPE:
        return entry.adapter.type(input.ref, input.text, { replace: input.replace });
      case OPERATIONS.SELECT:
        return entry.adapter.select(input.ref, input.value);
      case OPERATIONS.PRESS:
        return entry.adapter.press(input.ref, input.key);
      case OPERATIONS.UPLOAD:
        return this.#requireUploadController().upload({
          pageAdapter: entry.adapter,
          ref: input.ref,
          signal: execution?.signal,
        });
      case OPERATIONS.DOWNLOAD:
        return this.#requireDownloadController().download({
          pageAdapter: entry.adapter,
          ref: input.ref,
          conversationId: execution?.conversationId,
          signal: execution?.signal,
          onProgress: execution?.onProgress,
        });
      case OPERATIONS.LIST_DOWNLOADS:
        return { artifacts: this.#requireDownloadController().list(execution?.conversationId) };
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

  #requirePageLifecycle() {
    if (!this.pageLifecycle) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Automation tab lifecycle is unavailable in this runtime'
      );
    }
    return this.pageLifecycle;
  }

  #requireDownloadController() {
    if (!this.downloadController) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Controlled downloads are unavailable in this runtime'
      );
    }
    return this.downloadController;
  }

  #requireUploadController() {
    if (!this.uploadController) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Controlled file uploads are unavailable in this runtime'
      );
    }
    return this.uploadController;
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
