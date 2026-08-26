'use strict';

const {
  OPERATIONS,
  MAX_WAIT_TIMEOUT_MS,
  PRESS_KEYS,
} = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');
const { originScopeForUrl } = require('../automation/origin-scoped-controller');
const { createToolReceipt } = require('./agent-progress');
const { loadPiSdk, validatePiSdk } = require('./pi-sdk');

const EMPTY_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {},
  additionalProperties: false,
});

const TOOL_SPECS = Object.freeze([
  {
    operation: OPERATIONS.LIST_TABS,
    label: 'List task tabs',
    description: 'List only the browser tabs owned by this Agent task and identify the active tab.',
    parameters: EMPTY_PARAMETERS,
    tabMode: 'none',
  },
  {
    operation: OPERATIONS.CREATE_TAB,
    label: 'Create task tab',
    description:
      'Create a visible task-owned tab at a supported web or distributed-web URL and make it the active Agent tab.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', minLength: 1 } },
      required: ['url'],
      additionalProperties: false,
    },
    tabMode: 'current',
  },
  {
    operation: OPERATIONS.GET_TAB,
    label: 'Get tab state',
    description:
      'Get the current URL, title, loading state, and navigation ID of the active task tab.',
    parameters: EMPTY_PARAMETERS,
  },
  {
    operation: OPERATIONS.FOCUS_TAB,
    label: 'Focus task tab',
    description:
      'Focus a task-owned browser tab by ID and make it the active tab for subsequent Agent tools.',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string', minLength: 1 } },
      required: ['tabId'],
      additionalProperties: false,
    },
    tabMode: 'explicit',
  },
  {
    operation: OPERATIONS.CLOSE_TAB,
    label: 'Close task tab',
    description:
      'Close a tab created by this task. The adopted starting tab cannot be closed by the Agent.',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string', minLength: 1 } },
      required: ['tabId'],
      additionalProperties: false,
    },
    tabMode: 'explicit',
  },
  {
    operation: OPERATIONS.SNAPSHOT,
    label: 'Snapshot page',
    description:
      'Read a compact accessibility-oriented snapshot of the active task tab. Use returned element references for interaction.',
    parameters: EMPTY_PARAMETERS,
  },
  {
    operation: OPERATIONS.NAVIGATE,
    label: 'Navigate page',
    description:
      'Navigate the active task tab to an absolute http, https, bzz, ipfs, or ipns URL without embedded credentials.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', minLength: 1 } },
      required: ['url'],
      additionalProperties: false,
    },
    cancellable: true,
  },
  {
    operation: OPERATIONS.CLICK,
    label: 'Click element',
    description:
      'Click an element in the active task tab using a reference from the latest page snapshot.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', minLength: 1 } },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    operation: OPERATIONS.TYPE,
    label: 'Type text',
    description:
      'Type text into an editable element using a reference from the latest page snapshot. Replaces existing text by default.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', minLength: 1 },
        text: { type: 'string' },
        replace: { type: 'boolean' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    operation: OPERATIONS.SELECT,
    label: 'Select option',
    description:
      'Select an enabled option in a single-select control using its value from the latest page snapshot.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', minLength: 1 },
        value: { type: 'string' },
      },
      required: ['ref', 'value'],
      additionalProperties: false,
    },
  },
  {
    operation: OPERATIONS.PRESS,
    label: 'Press key',
    description:
      'Focus an element from the latest page snapshot and press one supported named key.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', minLength: 1 },
        key: { type: 'string', enum: PRESS_KEYS },
      },
      required: ['ref', 'key'],
      additionalProperties: false,
    },
  },
  {
    operation: OPERATIONS.DOWNLOAD,
    label: 'Download file',
    description:
      'Download a file through Freedom using a download link reference from the latest page snapshot. Returns a safe artifact receipt, never a filesystem path.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', minLength: 1 } },
      required: ['ref'],
      additionalProperties: false,
    },
    cancellable: true,
  },
  {
    operation: OPERATIONS.LIST_DOWNLOADS,
    label: 'List task downloads',
    description:
      'List safe receipts for downloads created by this Agent conversation, including whether each file is still available.',
    parameters: EMPTY_PARAMETERS,
    tabMode: 'none',
  },
  {
    operation: OPERATIONS.WAIT,
    label: 'Wait for page',
    description:
      'Wait up to 30 seconds for load completion, a navigation, visible text, or an exact URL in the active task tab.',
    parameters: {
      type: 'object',
      properties: {
        condition: { type: 'string', enum: ['load', 'navigation', 'text', 'url'] },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_WAIT_TIMEOUT_MS },
        text: { type: 'string', minLength: 1 },
        url: { type: 'string', minLength: 1 },
        sinceNavigationId: { type: 'integer', minimum: 0 },
      },
      required: ['condition'],
      additionalProperties: false,
    },
    cancellable: true,
  },
  {
    operation: OPERATIONS.STOP_LOADING,
    label: 'Stop page activity',
    description: 'Stop loading and cancel active waits in the active task tab.',
    parameters: EMPTY_PARAMETERS,
  },
]);

const TOOL_SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.operation, spec]));
class FreedomBrowserToolError extends Error {
  constructor(operation, error) {
    super(`[${error.code}] ${error.message}`);
    this.name = 'FreedomBrowserToolError';
    this.operation = operation;
    this.code = error.code;
    this.retryable = error.retryable === true;
    if (error.suggestedAction) this.suggestedAction = error.suggestedAction;
  }
}

function cancellationError() {
  return {
    code: ERROR_CODES.USER_CANCELLED,
    message: 'The browser operation was cancelled',
    retryable: false,
  };
}

function internalError() {
  return {
    code: ERROR_CODES.INTERNAL_ERROR,
    message: 'The browser operation failed unexpectedly',
    retryable: false,
  };
}

function assertNotAborted(signal, operation) {
  if (signal?.aborted) throw new FreedomBrowserToolError(operation, cancellationError());
}

async function executeCancellable(controller, operation, input, signal, execution = {}) {
  assertNotAborted(signal, operation);
  if (operation === OPERATIONS.DOWNLOAD) {
    return controller.execute(operation, input, { ...execution, signal });
  }
  if (!signal) return controller.execute(operation, input);

  let resolveAbort;
  const abortStarted = new Promise((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => resolveAbort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const operationResult = Promise.resolve(controller.execute(operation, input)).then(
      (envelope) => ({ kind: 'result', envelope }),
      () => ({ kind: 'failure' })
    );
    const abortResult = abortStarted.then(async () => {
      try {
        await controller.execute(OPERATIONS.STOP_LOADING, { tabId: input.tabId });
      } catch {
        // The original operation is still cancelled even if cleanup cannot be confirmed.
      }
      return { kind: 'aborted' };
    });
    const settled = await Promise.race([operationResult, abortResult]);
    if (settled.kind === 'aborted') {
      throw new FreedomBrowserToolError(operation, cancellationError());
    }
    if (settled.kind === 'failure') {
      throw new FreedomBrowserToolError(operation, internalError());
    }
    return settled.envelope;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function executeBrowserTool(controller, tabId, spec, params, signal, execution = {}) {
  assertNotAborted(signal, spec.operation);
  const input =
    spec.tabMode === 'none'
      ? { ...params }
      : spec.tabMode === 'explicit'
        ? { ...params }
        : { ...params, tabId };
  let envelope;
  try {
    envelope = spec.cancellable
      ? await executeCancellable(controller, spec.operation, input, signal, execution)
      : spec.operation === OPERATIONS.DOWNLOAD
        ? await controller.execute(spec.operation, input, execution)
        : await controller.execute(spec.operation, input);
  } catch (error) {
    if (error instanceof FreedomBrowserToolError) throw error;
    throw new FreedomBrowserToolError(spec.operation, internalError());
  }

  if (!envelope || envelope.ok !== true) {
    const error = envelope?.ok === false && envelope.error ? envelope.error : internalError();
    throw new FreedomBrowserToolError(spec.operation, error);
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    details: { operation: spec.operation, envelope },
  };
}

function notifyToolOutcome(listener, outcome) {
  if (typeof listener !== 'function') return;
  try {
    listener(Object.freeze(outcome));
  } catch {
    // Agent lifecycle and policy enforcement cannot depend on an observer.
  }
}

async function createFreedomBrowserTools(options = {}) {
  if (!options.controller || typeof options.controller.execute !== 'function') {
    throw new TypeError('Freedom browser tools require an automation controller');
  }
  if (
    options.tabId !== null &&
    options.tabId !== undefined &&
    (typeof options.tabId !== 'string' || !options.tabId.trim())
  ) {
    throw new TypeError('Freedom browser tools require a valid tabId or an empty workspace');
  }
  if (typeof options.tabId === 'string' && options.tabId !== options.tabId.trim()) {
    throw new TypeError('Freedom browser tool tabId cannot contain surrounding whitespace');
  }

  const sdk = validatePiSdk(options.sdk || (await loadPiSdk()));
  const tabState = { currentTabId: options.tabId };
  const pageOrigins = new Map();
  return TOOL_SPECS.map((spec) =>
    sdk.defineTool({
      name: spec.operation,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      executionMode: 'sequential',
      execute: async (toolCallId, params, signal) => {
        const controllerTabId = options.controller.getActiveTabId?.();
        if (typeof controllerTabId === 'string' || controllerTabId === null) {
          tabState.currentTabId = controllerTabId;
        }
        const targetTabId =
          spec.tabMode === 'none'
            ? undefined
            : spec.tabMode === 'explicit'
              ? params.tabId
              : tabState.currentTabId;
        try {
          const result = await executeBrowserTool(
            options.controller,
            tabState.currentTabId,
            spec,
            params,
            signal,
            {
              onProgress: (progress) =>
                notifyToolOutcome(options.onToolProgress, {
                  toolCallId,
                  operation: spec.operation,
                  progress,
                }),
            }
          );
          const activeTabId = result.details.envelope?.result?.activeTabId;
          if (typeof activeTabId === 'string' && activeTabId) {
            tabState.currentTabId = activeTabId;
          } else if (spec.operation === OPERATIONS.FOCUS_TAB) {
            tabState.currentTabId = params.tabId;
          }
          if (spec.operation === OPERATIONS.LIST_TABS) {
            for (const tab of result.details.envelope?.result?.tabs || []) {
              const origin = originScopeForUrl(tab?.url);
              if (typeof tab?.tabId === 'string' && origin) pageOrigins.set(tab.tabId, origin);
            }
          }
          const resultTabId =
            result.details.envelope?.result?.tab?.tabId ||
            result.details.envelope?.tabId ||
            activeTabId ||
            targetTabId;
          const receipt = createToolReceipt(spec.operation, {
            envelope: result.details.envelope,
            pageId: resultTabId,
            origin: pageOrigins.get(resultTabId),
            requestedUrl: params.url,
          });
          if (receipt.pageId && receipt.origin) pageOrigins.set(receipt.pageId, receipt.origin);
          notifyToolOutcome(options.onToolOutcome, {
            toolCallId,
            operation: spec.operation,
            status: 'succeeded',
            ...(typeof targetTabId === 'string' && { tabId: targetTabId }),
            ...receipt,
          });
          if (spec.operation === OPERATIONS.CLOSE_TAB && typeof targetTabId === 'string') {
            pageOrigins.delete(targetTabId);
          }
          return result;
        } catch (error) {
          const receipt = createToolReceipt(spec.operation, {
            pageId: targetTabId,
            origin: pageOrigins.get(targetTabId),
            requestedUrl: params.url,
          });
          notifyToolOutcome(options.onToolOutcome, {
            toolCallId,
            operation: spec.operation,
            status: 'failed',
            ...(typeof targetTabId === 'string' && { tabId: targetTabId }),
            ...receipt,
            errorCode:
              error instanceof FreedomBrowserToolError ? error.code : ERROR_CODES.INTERNAL_ERROR,
          });
          throw error;
        }
      },
    })
  );
}

module.exports = {
  FreedomBrowserToolError,
  TOOL_SPECS,
  TOOL_SPEC_BY_NAME,
  createFreedomBrowserTools,
  executeBrowserTool,
  notifyToolOutcome,
};
