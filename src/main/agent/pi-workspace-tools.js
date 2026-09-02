'use strict';

const { loadPiSdk, validatePiSdk } = require('./pi-sdk');
const { WORKSPACE_TOOL_NAME } = require('./managed-workspace-controller');

function decisionApproved(value) {
  return value === 'approved' || value?.status === 'approved';
}

function safeWorkspaceError(error) {
  const safeCodes = new Set([
    'INVALID_WORKSPACE_REQUEST',
    'WORKSPACE_CAPABILITY_DETECTION_FAILED',
    'WORKSPACE_DIRECTORY_UNAVAILABLE',
    'WORKSPACE_EXECUTION_FAILED',
    'WORKSPACE_EXECUTION_NOT_ENABLED',
    'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE',
    'WORKSPACE_EXECUTION_DECLINED',
    'WORKSPACE_ENABLE_FAILED',
    'WORKSPACE_POLICY_FAILED',
    'WORKSPACE_RUNTIME_UNAVAILABLE',
    'ELECTRON_RUNTIME_PLATFORM_UNAVAILABLE',
    'ELECTRON_MAIN_PROCESS_REQUIRED',
    'ELECTRON_EXECUTABLE_UNAVAILABLE',
    'ELECTRON_BUNDLE_UNAVAILABLE',
    'ELECTRON_NODE_RUNTIME_UNAVAILABLE',
  ]);
  const code = safeCodes.has(error?.code) ? error.code : 'WORKSPACE_EXECUTION_FAILED';
  const message =
    typeof error?.message === 'string' &&
    error.message &&
    !error.message.includes('/') &&
    !error.message.includes('\\')
      ? error.message.slice(0, 512)
      : 'Freedom could not run the command inside the managed workspace';
  const safe = new Error(`[${code}] ${message}`);
  safe.code = code;
  return safe;
}

function notify(listener, value) {
  if (typeof listener !== 'function') return;
  try {
    listener(Object.freeze(value));
  } catch {
    // Workspace enforcement and tool completion cannot depend on an observer.
  }
}

async function createWorkspaceTools(options = {}) {
  if (!options.controller || typeof options.controller.execute !== 'function') {
    throw new TypeError('Workspace tools require a managed workspace controller');
  }
  if (typeof options.conversationId !== 'string' || !options.conversationId) {
    throw new TypeError('Workspace tools require a conversation ID');
  }
  if (typeof options.requestApproval !== 'function') {
    throw new TypeError('Workspace tools require an Agent-native approval boundary');
  }
  const sdk = validatePiSdk(options.sdk || (await loadPiSdk()));
  return [
    sdk.defineTool({
      name: WORKSPACE_TOOL_NAME,
      label: 'Run workspace command',
      description:
        'Run one shell command inside this conversation’s private Freedom-managed project workspace. The workspace is writable, but host files and all networking are blocked by the OS sandbox. Use workspace-relative paths only. JavaScript is available through $FREEDOM_JAVASCRIPT_RUNTIME rather than assuming a host node command. The first use requires the user to enable workspace execution.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 32_000 },
          workingDirectory: { type: 'string', minLength: 1, maxLength: 1_024 },
        },
        required: ['command'],
        additionalProperties: false,
      },
      executionMode: 'sequential',
      execute: async (toolCallId, params, signal) => {
        try {
          let workspace = options.controller.getWorkspace(options.conversationId);
          if (!workspace?.enabled) {
            const capabilities = await options.controller.disclosure(options.conversationId);
            const decision = await options.requestApproval({
              action: 'workspace_execution',
              operation: WORKSPACE_TOOL_NAME,
              workspace: capabilities,
            });
            if (!decisionApproved(decision)) {
              const declined = new Error('The user did not enable managed workspace execution');
              declined.code = 'WORKSPACE_EXECUTION_DECLINED';
              throw declined;
            }
            await options.controller.enable(options.conversationId);
            workspace = options.controller.getWorkspace(options.conversationId);
          }
          const receipt = await options.controller.execute(options.conversationId, {
            command: params.command,
            workingDirectory: params.workingDirectory || '.',
            signal,
          });
          notify(options.onToolOutcome, {
            toolCallId,
            operation: WORKSPACE_TOOL_NAME,
            status: receipt.state === 'completed' ? 'succeeded' : 'failed',
            workspace: receipt,
            ...(receipt.error?.code && { errorCode: receipt.error.code }),
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }],
            details: { workspace: receipt },
          };
        } catch (error) {
          const safe = safeWorkspaceError(error);
          notify(options.onToolOutcome, {
            toolCallId,
            operation: WORKSPACE_TOOL_NAME,
            status: 'failed',
            errorCode: safe.code,
            workspace: {
              state: 'sandbox_denied',
              command: typeof params?.command === 'string' ? params.command.slice(0, 160) : '',
              workingDirectory:
                typeof params?.workingDirectory === 'string' ? params.workingDirectory : '.',
              backend: 'unavailable',
              terminationGuarantee: 'not_applicable',
              sideEffects: 'none',
            },
          });
          throw safe;
        }
      },
    }),
  ];
}

module.exports = {
  createWorkspaceTools,
  decisionApproved,
  safeWorkspaceError,
};
