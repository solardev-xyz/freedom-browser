'use strict';

const path = require('path');
const { OPERATIONS } = require('../automation/contract/operations');
const { getBuiltInSkillResource, isBuiltInSkillResourcePath } = require('./builtin-skills');
const {
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  MAX_WORKSPACE_FIND_RESULTS,
  MAX_WORKSPACE_GREP_MATCHES,
} = require('./managed-workspace-controller');
const { loadPiSdk, validatePiSdk } = require('./pi-sdk');
const { trustBuiltInToolOverride } = require('./pi-trusted-tools');
const { VIRTUAL_AGENT_CWD } = require('./pi-virtual-paths');

const WORKSPACE_TOOL_NAMES = Object.freeze([
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
  'request_permissions',
  'write_stdin',
  'workspace_preview',
]);
const READ_ONLY_WORKSPACE_OPERATIONS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'request_permissions',
]);
const MAX_MODEL_BASH_OUTPUT_BYTES = 48 * 1024;
const MAX_MODEL_READ_BYTES = 50 * 1024;
const MAX_MODEL_READ_LINES = 2_000;
const MAX_MODEL_DISCOVERY_OUTPUT_BYTES = 50 * 1024;
const WORKSPACE_POLICY_ERROR_CODES = new Set([
  'INVALID_WORKSPACE_REQUEST',
  'WORKSPACE_EXECUTION_NOT_ENABLED',
  'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE',
  'WORKSPACE_FILE_UNSAFE',
  'WORKSPACE_POLICY_FAILED',
  'WORKSPACE_PREVIEW_NETWORK_REQUIRED',
  'WORKSPACE_PROTECTED_PATH',
  'WORKSPACE_RUNTIME_UNAVAILABLE',
  'WORKSPACE_SANDBOX_DENIED',
]);
const WORKSPACE_ERROR_MESSAGES = Object.freeze({
  INVALID_WORKSPACE_REQUEST: 'The workspace request is invalid',
  EXECUTABLE_ACCESS_DECLINED: 'The user did not grant access to the requested executables',
  EXECUTABLE_ACCESS_PLATFORM_UNAVAILABLE:
    'Approved executable access is unavailable on this platform',
  EXECUTABLE_RESOLUTION_FAILED: 'Freedom could not resolve the requested executables',
  EXECUTABLE_SCOPE_TOO_BROAD: 'Freedom refused an executable with an unsafe package boundary',
  COMMAND_PERMISSION_DECLINED: 'The user did not grant the requested command permissions',
  COMMAND_PERMISSION_PREPARATION_FAILED:
    'Freedom could not prepare the requested command permissions',
  INVALID_COMMAND_PERMISSION_GRANT: 'Freedom refused an invalid command permission grant',
  INVALID_CAPABILITY_REQUEST: 'The requested command permissions are invalid',
  INVALID_EXECUTABLE_GRANT: 'Freedom refused an invalid executable grant',
  INVALID_EXECUTABLE_REQUEST: 'The executable permission request is invalid',
  NETWORK_PERMISSION_UNAVAILABLE: 'Direct network permission is unavailable in this build',
  UNSUPPORTED_CAPABILITY_COMBINATION:
    'Freedom refused an unsupported combination of command permissions',
  UNSUPPORTED_WORKSPACE_CAPABILITY:
    'Freedom cannot enforce one of the requested workspace permissions',
  UNTRUSTED_CAPABILITY_AUTHORITY: 'Freedom refused untrusted workspace authority',
  WORKSPACE_COMMAND_CANCELLED: 'The workspace command was stopped',
  WORKSPACE_COMMAND_FAILED: 'The workspace command exited unsuccessfully',
  WORKSPACE_COMMAND_NOT_FOUND: 'A required command is not available in the workspace shell',
  WORKSPACE_COMMAND_TIMED_OUT: 'The workspace command timed out',
  WORKSPACE_PROCESS_INPUT_UNAVAILABLE: 'The workspace process is not accepting input',
  WORKSPACE_PROCESS_LIMIT_REACHED: 'Too many workspace commands are still running',
  WORKSPACE_PROCESS_NOT_FOUND: 'The workspace process is no longer available',
  INVALID_WORKSPACE_PROCESS_REQUEST: 'The workspace process request is invalid',
  WORKSPACE_PREVIEW_NETWORK_REQUIRED:
    'A managed server preview requires explicit network permission for its launch command',
  WORKSPACE_PREVIEW_UNAVAILABLE: 'The requested workspace preview is unavailable',
  WORKSPACE_PREVIEW_UNSAFE: 'Freedom blocked an unsafe workspace preview request',
  WORKSPACE_PREVIEW_TOO_LARGE: 'The workspace preview exceeded its bounded size limit',
  WORKSPACE_EXECUTION_FAILED: 'Freedom could not start the workspace command',
  WORKSPACE_FILE_TOO_LARGE: 'The requested workspace file exceeds the supported size limit',
  WORKSPACE_FILE_UNAVAILABLE: 'The requested workspace file could not be accessed',
  WORKSPACE_FILE_UNSAFE: 'The requested workspace path is unsafe',
  WORKSPACE_OPERATION_CANCELLED: 'The workspace operation was stopped',
  WORKSPACE_PATH_NOT_FOUND: 'The requested workspace path does not exist',
  WORKSPACE_PATH_TYPE_MISMATCH: 'The requested workspace path has the wrong file type',
  WORKSPACE_PROTECTED_PATH: 'The requested workspace path is protected',
  WORKSPACE_SANDBOX_DENIED: 'Freedom denied the command before it entered the workspace sandbox',
  WORKSPACE_WRITE_FAILED: 'Freedom could not write the requested workspace file',
});

function decisionApproved(value) {
  return value === 'approved' || value?.status === 'approved';
}

function safeWorkspaceError(error, options = {}) {
  const safeCodes = new Set([
    'INVALID_WORKSPACE_REQUEST',
    'EXECUTABLE_ACCESS_DECLINED',
    'EXECUTABLE_ACCESS_PLATFORM_UNAVAILABLE',
    'EXECUTABLE_RESOLUTION_FAILED',
    'EXECUTABLE_SCOPE_TOO_BROAD',
    'COMMAND_PERMISSION_DECLINED',
    'COMMAND_PERMISSION_PREPARATION_FAILED',
    'INVALID_COMMAND_PERMISSION_GRANT',
    'INVALID_EXECUTABLE_GRANT',
    'INVALID_EXECUTABLE_REQUEST',
    'WORKSPACE_CAPABILITY_DETECTION_FAILED',
    'WORKSPACE_DIRECTORY_UNAVAILABLE',
    'WORKSPACE_EXECUTION_FAILED',
    'WORKSPACE_EXECUTION_NOT_ENABLED',
    'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE',
    'WORKSPACE_EXECUTION_DECLINED',
    'WORKSPACE_ENABLE_FAILED',
    'WORKSPACE_COMMAND_CANCELLED',
    'WORKSPACE_COMMAND_FAILED',
    'WORKSPACE_COMMAND_NOT_FOUND',
    'WORKSPACE_COMMAND_TIMED_OUT',
    'WORKSPACE_PROCESS_INPUT_UNAVAILABLE',
    'WORKSPACE_PROCESS_LIMIT_REACHED',
    'WORKSPACE_PROCESS_NOT_FOUND',
    'INVALID_WORKSPACE_PROCESS_REQUEST',
    'WORKSPACE_FILE_TOO_LARGE',
    'WORKSPACE_FILE_UNAVAILABLE',
    'WORKSPACE_FILE_UNSAFE',
    'WORKSPACE_OPERATION_CANCELLED',
    'WORKSPACE_PATH_NOT_FOUND',
    'WORKSPACE_PATH_TYPE_MISMATCH',
    'WORKSPACE_POLICY_FAILED',
    'WORKSPACE_PREVIEW_UNAVAILABLE',
    'WORKSPACE_PREVIEW_UNSAFE',
    'WORKSPACE_PREVIEW_TOO_LARGE',
    'WORKSPACE_PREVIEW_NETWORK_REQUIRED',
    'WORKSPACE_PROTECTED_PATH',
    'WORKSPACE_RUNTIME_UNAVAILABLE',
    'WORKSPACE_SANDBOX_DENIED',
    'WORKSPACE_WRITE_FAILED',
    'INVALID_CAPABILITY_REQUEST',
    'NETWORK_PERMISSION_UNAVAILABLE',
    'UNSUPPORTED_CAPABILITY_COMBINATION',
    'UNSUPPORTED_WORKSPACE_CAPABILITY',
    'UNTRUSTED_CAPABILITY_AUTHORITY',
    'ELECTRON_RUNTIME_PLATFORM_UNAVAILABLE',
    'ELECTRON_MAIN_PROCESS_REQUIRED',
    'ELECTRON_EXECUTABLE_UNAVAILABLE',
    'ELECTRON_BUNDLE_UNAVAILABLE',
    'ELECTRON_NODE_RUNTIME_UNAVAILABLE',
  ]);
  let code = safeCodes.has(error?.code) ? error.code : 'WORKSPACE_EXECUTION_FAILED';
  const receipt = options.receipt;
  if (options.operation === 'bash' && receipt) {
    if (receipt.state === 'sandbox_denied') code = 'WORKSPACE_SANDBOX_DENIED';
    else if (receipt.state === 'timed_out') code = 'WORKSPACE_COMMAND_TIMED_OUT';
    else if (receipt.state === 'cancelled') code = 'WORKSPACE_COMMAND_CANCELLED';
    else if (receipt.state === 'failed' && receipt.error?.code === 'WORKSPACE_EXECUTION_FAILED') {
      code = 'WORKSPACE_EXECUTION_FAILED';
    } else if (receipt.state === 'failed' && receipt.exitCode === 127) {
      code = 'WORKSPACE_COMMAND_NOT_FOUND';
    } else if (receipt.state === 'failed') code = 'WORKSPACE_COMMAND_FAILED';
  }
  const message =
    WORKSPACE_ERROR_MESSAGES[code] ||
    (typeof error?.message === 'string' &&
    error.message &&
    !error.message.includes('/') &&
    !error.message.includes('\\')
      ? error.message.slice(0, 512)
      : 'Freedom could not complete the operation inside the managed workspace');
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

function combinedAbortSignal(...signals) {
  const active = signals.filter((signal) => signal?.addEventListener);
  if (!active.length) return { signal: undefined, dispose: () => {} };
  if (active.length === 1) return { signal: active[0], dispose: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of active) {
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of active) signal.removeEventListener?.('abort', abort);
    },
  };
}

function virtualPathToWorkspaceRelative(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    const error = new Error('A workspace-relative path is required');
    error.code = 'INVALID_WORKSPACE_REQUEST';
    throw error;
  }
  const resolved = path.resolve(filePath);
  const relative = path.relative(path.resolve(VIRTUAL_AGENT_CWD), resolved);
  if (relative === '' && options.allowRoot === true) return '.';
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    const error = new Error('The path must remain inside the managed workspace');
    error.code = 'INVALID_WORKSPACE_REQUEST';
    throw error;
  }
  return relative.split(path.sep).join('/');
}

function resolveVirtualToolPath(filePath) {
  const normalized =
    typeof filePath === 'string' && filePath.startsWith('@') ? filePath.slice(1) : filePath;
  return path.resolve(VIRTUAL_AGENT_CWD, normalized);
}

function modelPathLabel(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    return 'requested path';
  }
  try {
    return virtualPathToWorkspaceRelative(resolveVirtualToolPath(filePath), { allowRoot: true });
  } catch {
    return 'requested path';
  }
}

function isSkillReadPath(filePath) {
  return (
    typeof filePath === 'string' && isBuiltInSkillResourcePath(resolveVirtualToolPath(filePath))
  );
}

function workspaceAction(operation, params = {}) {
  if (operation === 'bash') {
    const command = typeof params.command === 'string' ? params.command : '';
    // eslint-disable-next-line no-control-regex
    const summary = command.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary || 'shell command';
  }
  if (operation === 'write_stdin') {
    const id = typeof params.session_id === 'string' ? params.session_id.slice(-8) : 'process';
    return params.terminate === true ? `Stop process ${id}` : `Check process ${id}`;
  }
  const target = modelPathLabel(params.path || '.');
  if (operation === 'grep') {
    const pattern = typeof params.pattern === 'string' ? params.pattern.slice(0, 120) : 'pattern';
    return `Search for ${pattern} in ${target}`;
  }
  if (operation === 'find') {
    const pattern = typeof params.pattern === 'string' ? params.pattern.slice(0, 120) : 'pattern';
    return `Find ${pattern} in ${target}`;
  }
  if (operation === 'ls') return `List ${target}`;
  if (operation === 'request_permissions') {
    const names = Array.isArray(params.executables) ? params.executables.slice(0, 16) : [];
    return `Use ${names.join(', ') || 'requested executables'}`;
  }
  if (operation === 'workspace_preview') {
    return params.processId ? 'Preview managed server' : `Preview ${target}`;
  }
  const verb = { read: 'Read', write: 'Write', edit: 'Edit' }[operation] || 'Access';
  return `${verb} ${target}`;
}

function workspaceOperationKind(operation) {
  return {
    bash: 'command',
    read: 'file_read',
    write: 'file_write',
    edit: 'file_edit',
    grep: 'file_search',
    find: 'file_find',
    ls: 'directory_list',
    request_permissions: 'permission',
    write_stdin: 'process',
    workspace_preview: 'static_preview',
  }[operation];
}

function assertBrowserEnvelope(envelope) {
  if (envelope?.ok === true) return envelope;
  const error = new Error('Freedom could not open the workspace preview tab');
  error.code = 'WORKSPACE_PREVIEW_UNAVAILABLE';
  throw error;
}

function createWorkspacePreviewTool(sdk, options) {
  const serverPreviewEnabled = options.serverPreviewEnabled === true;
  return sdk.defineTool({
    name: 'workspace_preview',
    label: 'Preview website',
    description: serverPreviewEnabled
      ? 'Open either a static workspace HTML path or a running managed server in a visible isolated Agent tab. For a server, pass the opaque processId returned by bash after launching it with previewPort and explicit full-network permission. Preview pages remain isolated from external network destinations.'
      : 'Open a workspace HTML file, or a directory containing index.html, in a visible isolated Agent tab. The preview reads current workspace files and has no external network access. Call again after edits to refresh it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1_024 },
        ...(serverPreviewEnabled && {
          processId: {
            type: 'string',
            pattern: '^workspace_process_[a-f0-9]{24}$',
          },
        }),
      },
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (toolCallId, params = {}, signal) => {
      const operation = 'workspace_preview';
      const conflictingTargets = Boolean(params.processId && params.path);
      const toolParams = params.processId
        ? { processId: params.processId }
        : { path: params.path || '.' };
      const operationAbort = combinedAbortSignal(signal, options.getRunSignal?.());
      const operationSignal = operationAbort.signal;
      const operationPhase = (phase) =>
        notify(options.onToolPhase, { toolCallId, operation, phase });
      let receipt;
      try {
        if (conflictingTargets) {
          const invalid = new Error('Choose either a static path or a managed process preview');
          invalid.code = 'INVALID_WORKSPACE_REQUEST';
          throw invalid;
        }
        if (toolParams.processId && !serverPreviewEnabled) {
          const unavailable = new Error('Managed server previews are unavailable');
          unavailable.code = 'WORKSPACE_PREVIEW_UNAVAILABLE';
          throw unavailable;
        }
        if (operationSignal?.aborted) {
          const cancelled = new Error('The workspace operation was stopped');
          cancelled.code = 'WORKSPACE_OPERATION_CANCELLED';
          throw cancelled;
        }
        await ensureWorkspaceEnabled(options, operation, toolCallId, operationSignal);
        operationPhase('executing_operation');
        const preview = toolParams.processId
          ? options.previewController.createProcessPreview(
              options.conversationId,
              toolParams.processId
            )
          : await options.previewController.createPreview(
              options.conversationId,
              toolParams.path
            );
        if (operationSignal?.aborted) {
          const cancelled = new Error('The workspace operation was stopped');
          cancelled.code = 'WORKSPACE_OPERATION_CANCELLED';
          throw cancelled;
        }
        const listed = assertBrowserEnvelope(
          await options.scopedController.execute(OPERATIONS.LIST_TABS, {})
        );
        const existing = listed.result?.tabs?.find((tab) => tab.url === preview.url);
        let opened;
        if (existing?.tabId) {
          assertBrowserEnvelope(
            await options.scopedController.execute(OPERATIONS.FOCUS_TAB, {
              tabId: existing.tabId,
            })
          );
          opened = assertBrowserEnvelope(
            await options.scopedController.execute(OPERATIONS.NAVIGATE, {
              tabId: existing.tabId,
              url: preview.url,
            })
          );
        } else {
          opened = assertBrowserEnvelope(
            await options.scopedController.execute(OPERATIONS.CREATE_TAB, { url: preview.url })
          );
        }
        const pageId = opened.result?.tab?.tabId || opened.result?.activeTabId || existing?.tabId;
        receipt = fileWorkspaceReceipt(
          options.controller,
          options.conversationId,
          operation,
          toolParams,
          'completed',
          preview.kind === 'server'
            ? {
                kind: 'server_preview',
                command: `Preview server on port ${preview.port}`,
                backend: 'freedom-workspace-server-preview',
                networkPosture: 'full',
              }
            : {}
        );
        notify(options.onToolOutcome, {
          toolCallId,
          operation,
          status: 'succeeded',
          ...(pageId && { pageId }),
          workspace: receipt,
        });
        return {
          content: [
            {
              type: 'text',
              text:
                preview.kind === 'server'
                  ? `Opened the managed server preview on port ${preview.port} in an Agent tab.`
                  : `Opened the static preview for ${preview.entryPath} in an Agent tab.`,
            },
          ],
          details: {
            kind: preview.kind || 'static',
            entryPath: preview.entryPath,
            ...(preview.processId && { processId: preview.processId }),
            ...(Number.isSafeInteger(preview.port) && { port: preview.port }),
            ...(pageId && { pageId }),
          },
        };
      } catch (error) {
        const safe = safeWorkspaceError(error, { operation, receipt });
        receipt = failedWorkspaceReceipt(
          options.controller,
          options.conversationId,
          operation,
          toolParams,
          receipt,
          safe.code
        );
        notify(options.onToolOutcome, {
          toolCallId,
          operation,
          status: 'failed',
          errorCode: safe.code,
          workspace: receipt,
        });
        throw safe;
      } finally {
        operationAbort.dispose();
      }
    },
  });
}

function workspaceOperationIsReadOnly(operation) {
  return READ_ONLY_WORKSPACE_OPERATIONS.has(operation);
}

function fileWorkspaceReceipt(controller, conversationId, operation, params, state, result = {}) {
  const workspace = controller.getWorkspace(conversationId);
  return Object.freeze({
    ...(workspace?.workspaceId && { workspaceId: workspace.workspaceId }),
    kind: result.kind || workspaceOperationKind(operation),
    command: result.command || workspaceAction(operation, params),
    workingDirectory: '.',
    backend: result.backend || 'freedom-workspace-files',
    networkPosture: result.networkPosture === 'full' ? 'full' : 'none',
    state,
    stdoutTruncated: false,
    stderrTruncated: false,
    terminationGuarantee: 'not_applicable',
    sideEffects: workspaceOperationIsReadOnly(operation) ? 'none' : 'unknown',
    survivorsPossible: false,
    completeDescendantTermination: true,
    ...(Number.isSafeInteger(result.entryCount) && result.entryCount >= 0
      ? { entryCount: result.entryCount }
      : {}),
    ...(Number.isSafeInteger(result.resultCount) && result.resultCount >= 0
      ? { resultCount: result.resultCount }
      : {}),
    ...(Number.isSafeInteger(result.matchCount) && result.matchCount >= 0
      ? { matchCount: result.matchCount }
      : {}),
  });
}

function workspaceBashTemplate(template, options = {}) {
  return {
    ...template,
    description:
      'Execute a bash command inside the managed project workspace. Optionally select a workspace-relative working directory. Returns bounded stdout and stderr.',
    promptGuidelines: [
      ...(Array.isArray(template.promptGuidelines) ? template.promptGuidelines : []),
      'Use workingDirectory when the command must run in a workspace subdirectory. It must be relative to the project workspace.',
    ],
    parameters: {
      ...template.parameters,
      properties: {
        ...template.parameters?.properties,
        workingDirectory: {
          type: 'string',
          minLength: 1,
          maxLength: 1_024,
          description: 'Workspace-relative working directory (optional; defaults to .)',
        },
        yield_time_ms: {
          type: 'number',
          minimum: 250,
          maximum: 30_000,
          description:
            'Wait before returning a session ID for a command that is still running (optional; defaults to 10000 ms)',
        },
        ...(options.serverPreviewEnabled === true && {
          previewPort: {
            type: 'integer',
            minimum: 1_024,
            maximum: 65_535,
            description:
              'Port declared before launch for a managed server preview. Requires full-network permission for this exact command.',
          },
        }),
      },
      additionalProperties: false,
    },
  };
}

function workspaceBashCwd(value = '.') {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1_024 ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value)
  ) {
    const error = new Error('A safe workspace-relative working directory is required');
    error.code = 'INVALID_WORKSPACE_REQUEST';
    throw error;
  }
  const segments = value === '.' ? [] : value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    const error = new Error('The working directory must remain inside the managed workspace');
    error.code = 'INVALID_WORKSPACE_REQUEST';
    throw error;
  }
  return segments.length ? path.join(VIRTUAL_AGENT_CWD, ...segments) : VIRTUAL_AGENT_CWD;
}

function failedWorkspaceReceipt(
  controller,
  conversationId,
  operation,
  params,
  existing,
  errorCode
) {
  if (existing) return existing;
  if (errorCode === 'WORKSPACE_OPERATION_CANCELLED') {
    return fileWorkspaceReceipt(controller, conversationId, operation, params, 'cancelled');
  }
  return fileWorkspaceReceipt(
    controller,
    conversationId,
    operation,
    params,
    WORKSPACE_POLICY_ERROR_CODES.has(errorCode) ? 'sandbox_denied' : 'failed'
  );
}

function boundedBashOutput(receipt) {
  const output = `${receipt.stdout || ''}${receipt.stderr || ''}`;
  const buffer = Buffer.from(output, 'utf8');
  if (buffer.byteLength <= MAX_MODEL_BASH_OUTPUT_BYTES) return buffer;
  const tail = buffer.subarray(buffer.byteLength - MAX_MODEL_BASH_OUTPUT_BYTES).toString('utf8');
  return Buffer.from(
    `[Freedom omitted earlier command output; showing the final ${MAX_MODEL_BASH_OUTPUT_BYTES} bytes.]\n${tail}`,
    'utf8'
  );
}

async function ensureWorkspaceEnabled(options, operation, toolCallId, signal) {
  const onPhase = (phase) =>
    notify(options.onToolPhase, {
      toolCallId,
      operation,
      phase,
    });
  let workspace = options.controller.getWorkspace(options.conversationId);
  if (workspace?.enabled) return workspace;
  const capabilities = await options.controller.disclosure(options.conversationId, {
    signal,
    onPhase,
  });
  onPhase('waiting_for_approval');
  const decision = await options.requestApproval({
    action: 'workspace_execution',
    operation,
    workspace: capabilities,
  });
  if (signal?.aborted) {
    const cancelled = new Error('The workspace operation was stopped');
    cancelled.code = 'WORKSPACE_OPERATION_CANCELLED';
    throw cancelled;
  }
  if (!decisionApproved(decision)) {
    const declined = new Error('The user did not enable managed workspace execution');
    declined.code = 'WORKSPACE_EXECUTION_DECLINED';
    throw declined;
  }
  await options.controller.enable(options.conversationId, {
    signal,
    onPhase,
    disclosureVerified: true,
  });
  workspace = options.controller.getWorkspace(options.conversationId);
  return workspace;
}

function workspaceRequest(options) {
  return {
    ...(options.operationSignal && { signal: options.operationSignal }),
    ...(options.operationPhase && { onPhase: options.operationPhase }),
  };
}

function readOperations(options) {
  const read = async (filePath) => {
    if (isBuiltInSkillResourcePath(filePath)) return getBuiltInSkillResource(filePath);
    return options.controller.readFile(
      options.conversationId,
      virtualPathToWorkspaceRelative(filePath),
      workspaceRequest(options)
    );
  };
  return Object.freeze({
    readFile: read,
    access: async (filePath) => {
      if (isBuiltInSkillResourcePath(filePath)) {
        getBuiltInSkillResource(filePath);
        return;
      }
      await options.controller.accessFile(
        options.conversationId,
        virtualPathToWorkspaceRelative(filePath),
        workspaceRequest(options)
      );
    },
    detectImageMimeType: async () => null,
  });
}

function writeOperations(options) {
  return Object.freeze({
    writeFile: async (filePath, content) =>
      options.controller.writeFile(
        options.conversationId,
        virtualPathToWorkspaceRelative(filePath),
        content,
        workspaceRequest(options)
      ),
    mkdir: async (directoryPath) =>
      options.controller.createDirectory(
        options.conversationId,
        virtualPathToWorkspaceRelative(directoryPath, { allowRoot: true }),
        workspaceRequest(options)
      ),
  });
}

function editOperations(options) {
  const reads = readOperations(options);
  const writes = writeOperations(options);
  return Object.freeze({
    readFile: reads.readFile,
    writeFile: writes.writeFile,
    access: reads.access,
  });
}

function truncateReadText(text) {
  const lines = text.split('\n');
  const selectedLines = lines.slice(0, MAX_MODEL_READ_LINES);
  let content = selectedLines.join('\n');
  let truncatedBy = lines.length > MAX_MODEL_READ_LINES ? 'lines' : null;
  const encoded = Buffer.from(content, 'utf8');
  if (encoded.byteLength > MAX_MODEL_READ_BYTES) {
    content = encoded.subarray(0, MAX_MODEL_READ_BYTES).toString('utf8');
    truncatedBy = 'bytes';
  }
  return { content, truncatedBy, totalLines: lines.length };
}

function createStandardReadTool(sdk, options) {
  const operations = readOperations(options);
  return sdk.defineTool({
    name: 'read',
    label: 'read',
    description:
      'Read a bounded text file from this conversation’s private Freedom-managed workspace, or load an exact reviewed Freedom skill path from the skills catalog. Host files are unavailable. Use offset and limit to continue through large files.',
    promptSnippet: 'Read file contents',
    promptGuidelines: ['Use read to examine files instead of cat or sed.'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1_024 },
        offset: { type: 'number', minimum: 1 },
        limit: { type: 'number', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted');
      const absolutePath = resolveVirtualToolPath(params.path);
      await operations.access(absolutePath);
      if (signal?.aborted) throw new Error('Operation aborted');
      const buffer = await operations.readFile(absolutePath);
      if (signal?.aborted) throw new Error('Operation aborted');
      const lines = buffer.toString('utf8').split('\n');
      const start = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset) - 1) : 0;
      if (start >= lines.length) {
        throw new Error(
          `Offset ${params.offset} is beyond end of file (${lines.length} lines total)`
        );
      }
      const requested = Number.isFinite(params.limit)
        ? lines.slice(start, start + Math.floor(params.limit)).join('\n')
        : lines.slice(start).join('\n');
      const truncated = truncateReadText(requested);
      const shownLines = truncated.content.split('\n').length;
      const nextOffset = start + shownLines + 1;
      const hasMore = start + shownLines < lines.length;
      const notice =
        truncated.truncatedBy || hasMore
          ? `\n\n[Showing from line ${start + 1}. Use offset=${nextOffset} to continue.]`
          : '';
      return {
        content: [{ type: 'text', text: `${truncated.content}${notice}` }],
        details: truncated.truncatedBy
          ? {
              truncation: {
                truncated: true,
                truncatedBy: truncated.truncatedBy,
                totalLines: truncated.totalLines,
                outputLines: shownLines,
                maxLines: MAX_MODEL_READ_LINES,
                maxBytes: MAX_MODEL_READ_BYTES,
              },
            }
          : undefined,
      };
    },
  });
}

function boundedDiscoveryLimit(value, fallback, maximum) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function discoveryRelativePath(value) {
  return virtualPathToWorkspaceRelative(resolveVirtualToolPath(value || '.'), { allowRoot: true });
}

function boundedDiscoveryOutput(value) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= MAX_MODEL_DISCOVERY_OUTPUT_BYTES) {
    return { content: value, truncated: false };
  }
  return {
    content: buffer.subarray(0, MAX_MODEL_DISCOVERY_OUTPUT_BYTES).toString('utf8'),
    truncated: true,
  };
}

function createStandardLsTool(template, options) {
  return {
    ...template,
    async execute(_toolCallId, params = {}, signal) {
      if (signal?.aborted) throw new Error('Operation aborted');
      const limit = boundedDiscoveryLimit(
        params.limit,
        MAX_WORKSPACE_DIRECTORY_ENTRIES,
        MAX_WORKSPACE_DIRECTORY_ENTRIES
      );
      const result = await options.controller.listDirectory(
        options.conversationId,
        discoveryRelativePath(params.path),
        {
          limit,
          signal,
          ...(options.operationPhase && { onPhase: options.operationPhase }),
        }
      );
      if (signal?.aborted) throw new Error('Operation aborted');
      const lines = result.entries.map(
        (entry) => `${entry.name}${entry.type === 'directory' ? '/' : ''}`
      );
      const bounded = boundedDiscoveryOutput(lines.length ? lines.join('\n') : '(empty directory)');
      let output = bounded.content;
      const details = {};
      details.entryCount = result.entries.length;
      if (bounded.truncated) {
        output += '\n\n[Output byte limit reached. Narrow the directory to continue.]';
        details.outputTruncated = true;
      }
      if (result.limitReached) {
        output += `\n\n[${limit} entries limit reached. Narrow the directory to continue.]`;
        details.entryLimitReached = limit;
      }
      return {
        content: [{ type: 'text', text: output }],
        details: Object.keys(details).length ? details : undefined,
      };
    },
  };
}

function createStandardFindTool(template, options) {
  return {
    ...template,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('Operation aborted');
      const limit = boundedDiscoveryLimit(
        params.limit,
        MAX_WORKSPACE_FIND_RESULTS,
        MAX_WORKSPACE_FIND_RESULTS
      );
      const result = await options.controller.findFiles(
        options.conversationId,
        discoveryRelativePath(params.path),
        {
          pattern: params.pattern,
          limit,
          signal,
          ...(options.operationPhase && { onPhase: options.operationPhase }),
        }
      );
      if (signal?.aborted) throw new Error('Operation aborted');
      const bounded = boundedDiscoveryOutput(
        result.results.length ? result.results.join('\n') : 'No files found matching pattern'
      );
      let output = bounded.content;
      const details = {};
      details.resultCount = result.results.length;
      const notices = [];
      if (bounded.truncated) {
        details.outputTruncated = true;
        notices.push('output byte limit reached; narrow the path or pattern');
      }
      if (result.limitReached) {
        details.resultLimitReached = limit;
        notices.push(`${limit} results limit reached`);
      }
      if (result.scanLimitReached) {
        details.scanLimitReached = true;
        notices.push('workspace scan limit reached; narrow the path or pattern');
      }
      if (notices.length) output += `\n\n[${notices.join('. ')}]`;
      return {
        content: [{ type: 'text', text: output }],
        details: Object.keys(details).length ? details : undefined,
      };
    },
  };
}

function createStandardGrepTool(template, options) {
  return {
    ...template,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('Operation aborted');
      const limit = boundedDiscoveryLimit(params.limit, 100, MAX_WORKSPACE_GREP_MATCHES);
      const result = await options.controller.grepFiles(
        options.conversationId,
        discoveryRelativePath(params.path),
        {
          pattern: params.pattern,
          ...(params.glob !== undefined && { glob: params.glob }),
          ignoreCase: params.ignoreCase === true,
          literal: params.literal === true,
          context: params.context,
          limit,
          signal,
          ...(options.operationPhase && { onPhase: options.operationPhase }),
        }
      );
      if (signal?.aborted) throw new Error('Operation aborted');
      let output = result.matchCount ? result.output : 'No matches found';
      const details = {};
      details.matchCount = result.matchCount;
      const notices = [];
      if (result.limitReached) {
        details.matchLimitReached = limit;
        notices.push(`${limit} matches limit reached`);
      }
      if (result.linesTruncated) {
        details.linesTruncated = true;
        notices.push('long lines truncated; use read for the complete line');
      }
      if (result.outputTruncated) {
        details.outputTruncated = true;
        notices.push('output byte limit reached');
      }
      if (result.scanLimitReached) {
        details.scanLimitReached = true;
        notices.push('workspace scan limit reached; narrow the path or pattern');
      }
      if (notices.length) output += `\n\n[${notices.join('. ')}]`;
      return {
        content: [{ type: 'text', text: output }],
        details: Object.keys(details).length ? details : undefined,
      };
    },
  };
}

function createRequestPermissionsTool(sdk, options) {
  const networkPermissionsEnabled = options.controller.fullNetworkPermissionsEnabled?.() === true;
  const properties = {
    executables: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    reason: { type: 'string', minLength: 1, maxLength: 240 },
    command: { type: 'string', minLength: 1, maxLength: 4_096 },
    workingDirectory: { type: 'string', minLength: 1, maxLength: 1_024 },
    ...(networkPermissionsEnabled && {
      network: {
        type: 'string',
        enum: ['full'],
        description:
          'Direct networking is one indivisible grant covering public internet, host localhost, and private/LAN addresses.',
      },
    }),
  };
  return sdk.defineTool({
    name: 'request_permissions',
    label: 'Request command access',
    description: networkPermissionsEnabled
      ? 'Request the exact executable and/or full direct-network access needed to run one intended workspace command. Full networking includes public internet, host localhost, and private/LAN addresses. Never guess host paths.'
      : 'Resolve named executables from the user’s installed command-line environment and request the exact access needed to run one intended workspace command. Use this before retrying an unavailable command, or when you know a required executable is outside the current workspace shell. Never guess host paths.',
    promptSnippet: 'Request access for an exact workspace command',
    promptGuidelines: [
      'When requesting executable access, include only the exact executable names needed for the task.',
      'Provide the exact command and workspace-relative working directory you intend to use next. If the user allows it once, only that matching call can consume the permission.',
      'If an executable is unavailable, explain that it is not installed; do not claim permission can install it.',
      ...(networkPermissionsEnabled
        ? [
            'Request network: full only when the exact command needs direct networking. It is one combined public-internet, host-localhost, and private/LAN grant.',
          ]
        : []),
    ],
    parameters: {
      type: 'object',
      properties,
      required: networkPermissionsEnabled
        ? ['reason', 'command', 'workingDirectory']
        : ['executables', 'reason', 'command', 'workingDirectory'],
      ...(networkPermissionsEnabled && {
        anyOf: [{ required: ['executables'] }, { required: ['network'] }],
      }),
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (toolCallId, params, signal) => {
      const operation = 'request_permissions';
      const operationAbort = combinedAbortSignal(signal, options.getRunSignal?.());
      const operationSignal = operationAbort.signal;
      let receipt;
      try {
        await ensureWorkspaceEnabled(options, operation, toolCallId, operationSignal);
        const resolved = await options.controller.prepareCommandPermissions(
          options.conversationId,
          {
            executables: params.executables || [],
            ...(params.network && { network: params.network }),
          },
          {
            command: params.command,
            workingDirectory: params.workingDirectory || '.',
            signal: operationSignal,
          }
        );
        let scope = 'already_available';
        if (resolved.approvalRequired) {
          const decision = await options.requestApproval({
            action: 'workspace_permission',
            operation,
            label: params.reason,
            workspacePermission: resolved.publicRequest,
          });
          if (operationSignal?.aborted) {
            const cancelled = new Error('The workspace permission request was stopped');
            cancelled.code = 'WORKSPACE_OPERATION_CANCELLED';
            throw cancelled;
          }
          if (!decisionApproved(decision)) {
            const declined = new Error('The user did not grant the requested command permissions');
            declined.code = 'COMMAND_PERMISSION_DECLINED';
            throw declined;
          }
          scope = decision?.workspacePermissionScope === 'conversation' ? 'conversation' : 'once';
          options.controller.grantCommandPermissions(
            options.conversationId,
            resolved.prepared,
            scope
          );
        }
        receipt = fileWorkspaceReceipt(
          options.controller,
          options.conversationId,
          operation,
          params,
          'completed'
        );
        notify(options.onToolOutcome, {
          toolCallId,
          operation,
          status: 'succeeded',
          workspace: receipt,
        });
        const executableSummary = resolved.available.length
          ? `Available: ${resolved.available.join(', ')}.`
          : resolved.unavailable.length
            ? 'No requested executable is available.'
            : '';
        const unavailable = resolved.unavailable.length
          ? `${executableSummary ? ' ' : ''}Unavailable on this computer: ${resolved.unavailable.join(', ')}.`
          : '';
        const network = resolved.publicRequest.network
          ? `${executableSummary || unavailable ? ' ' : ''}Full direct networking is available for the approved scope.`
          : '';
        return {
          content: [{ type: 'text', text: `${executableSummary}${unavailable}${network}` }],
          details: {
            available: resolved.available,
            unavailable: resolved.unavailable,
            scope,
            command: resolved.publicRequest.command,
            workingDirectory: resolved.publicRequest.workingDirectory,
            ...(resolved.publicRequest.network && { network: 'full' }),
          },
        };
      } catch (error) {
        const safe = safeWorkspaceError(error, { operation, receipt });
        receipt = failedWorkspaceReceipt(
          options.controller,
          options.conversationId,
          operation,
          params,
          receipt,
          safe.code
        );
        notify(options.onToolOutcome, {
          toolCallId,
          operation,
          status: 'failed',
          errorCode: safe.code,
          workspace: receipt,
        });
        throw safe;
      } finally {
        operationAbort.dispose();
      }
    },
  });
}

function bashOperations(options, captureReceipt, toolParams = {}) {
  return Object.freeze({
    exec: async (command, cwd, execution = {}) => {
      const process = await options.controller.startProcess(options.conversationId, {
        command,
        workingDirectory: virtualPathToWorkspaceRelative(cwd, { allowRoot: true }),
        signal: execution.signal,
        ...(Number.isFinite(execution.timeout) && { timeoutMs: execution.timeout * 1_000 }),
        ...(Number.isFinite(toolParams.yield_time_ms) && { yieldMs: toolParams.yield_time_ms }),
        ...(Number.isSafeInteger(toolParams.previewPort) && {
          previewPort: toolParams.previewPort,
        }),
        ...(options.operationPhase && { onPhase: options.operationPhase }),
        ...(options.onProcessTerminal && {
          onTerminal: (terminal) =>
            notify(options.onProcessTerminal, {
              toolCallId: options.toolCallId,
              operation: 'bash',
              workspace: terminal.workspace,
            }),
        }),
      });
      const receipt = process.workspace;
      captureReceipt(receipt);
      const output = boundedBashOutput({ stdout: process.output || '', stderr: '' });
      if (output.byteLength) execution.onData(output);
      if (process.state === 'running') {
        execution.onData(
          Buffer.from(
            `${output.byteLength ? '\n' : ''}Command still running with session ID ${process.processId}. Use write_stdin to read more output, send input, or stop it.\n`,
            'utf8'
          )
        );
        return { exitCode: 0 };
      }
      if (receipt.state === 'cancelled') {
        const error = new Error('The workspace command was stopped');
        error.code = 'WORKSPACE_COMMAND_CANCELLED';
        throw error;
      }
      if (receipt.state === 'timed_out') {
        const error = new Error(
          `timeout:${Number.isFinite(execution.timeout) ? execution.timeout : 300}`
        );
        error.code = 'WORKSPACE_COMMAND_TIMED_OUT';
        throw error;
      }
      if (receipt.state === 'sandbox_denied') {
        const error = new Error(receipt.error?.message || 'The workspace sandbox denied execution');
        error.code = 'WORKSPACE_SANDBOX_DENIED';
        throw error;
      }
      return { exitCode: receipt.exitCode };
    },
  });
}

function createWriteStdinTool(sdk, options) {
  return trustBuiltInToolOverride(
    sdk.defineTool({
      name: 'write_stdin',
      label: 'Workspace process',
      description:
        'Read new output from an existing workspace command session, send bounded text to its standard input, or stop it. Empty input polls without writing.',
      parameters: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: {
            type: 'string',
            pattern: '^workspace_process_[a-f0-9]{24}$',
            description: 'Session identifier returned by bash for a command that is still running',
          },
          chars: {
            type: 'string',
            maxLength: 16_384,
            description:
              'Text to write to the running process; omit or use an empty string to poll',
          },
          yield_time_ms: {
            type: 'number',
            minimum: 0,
            maximum: 30_000,
            description: 'Wait for new output or completion (optional)',
          },
          terminate: {
            type: 'boolean',
            description: 'Stop the sandboxed process and its descendants',
          },
        },
        additionalProperties: false,
      },
      executionMode: 'parallel',
      async execute(toolCallId, params = {}, signal) {
        const operation = 'write_stdin';
        let receipt;
        try {
          if (signal?.aborted) {
            const cancelled = new Error('The workspace operation was stopped');
            cancelled.code = 'WORKSPACE_OPERATION_CANCELLED';
            throw cancelled;
          }
          const process = await options.controller.interactProcess(
            options.conversationId,
            params.session_id,
            {
              input: params.chars || '',
              ...(Number.isFinite(params.yield_time_ms) && { waitMs: params.yield_time_ms }),
              terminate: params.terminate === true,
              signal,
            }
          );
          if (signal?.aborted) {
            const cancelled = new Error('The workspace operation was stopped');
            cancelled.code = 'WORKSPACE_OPERATION_CANCELLED';
            throw cancelled;
          }
          receipt = process.workspace;
          const status =
            process.state === 'running' ? 'still running' : `finished: ${process.state}`;
          const output = boundedBashOutput({ stdout: process.output || '', stderr: '' }).toString(
            'utf8'
          );
          notify(options.onToolOutcome, {
            toolCallId,
            operation,
            status: ['failed', 'cancelled', 'timed_out', 'sandbox_denied'].includes(process.state)
              ? 'failed'
              : 'succeeded',
            workspace: receipt,
          });
          return {
            content: [
              {
                type: 'text',
                text: `${output}${output && !output.endsWith('\n') ? '\n' : ''}Process ${process.processId} is ${status}.`,
              },
            ],
            details: {
              sessionId: process.processId,
              state: process.state,
              outputTruncated: process.outputTruncated === true,
              ...(receipt?.exitCode !== undefined && receipt?.exitCode !== null
                ? { exitCode: receipt.exitCode }
                : {}),
            },
          };
        } catch (error) {
          const safe = safeWorkspaceError(error, { operation, receipt });
          notify(options.onToolOutcome, {
            toolCallId,
            operation,
            status: 'failed',
            errorCode: safe.code,
            ...(receipt && { workspace: receipt }),
          });
          throw safe;
        }
      },
    })
  );
}

function wrapWorkspaceTool(template, operation, options, createRuntimeTool) {
  const wrapped = {
    ...template,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, onUpdate, context) {
      const skillRead = operation === 'read' && isSkillReadPath(params?.path);
      const operationAbort = combinedAbortSignal(signal, options.getRunSignal?.());
      const operationSignal = operationAbort.signal;
      const operationPhase = (phase) =>
        notify(options.onToolPhase, { toolCallId, operation, phase });
      const executionOptions = {
        ...options,
        toolCallId,
        operationSignal,
        operationPhase,
      };
      let receipt = null;
      try {
        if (!skillRead) {
          await ensureWorkspaceEnabled(options, operation, toolCallId, operationSignal);
        }
        const runtimeTool = createRuntimeTool(
          (value) => {
            receipt = value;
          },
          executionOptions,
          params
        );
        const result = await runtimeTool.execute(
          toolCallId,
          params,
          operationSignal,
          onUpdate,
          context
        );
        if (!skillRead) {
          receipt ||= fileWorkspaceReceipt(
            options.controller,
            options.conversationId,
            operation,
            params,
            'completed',
            result?.details
          );
          notify(options.onToolOutcome, {
            toolCallId,
            operation,
            status: 'succeeded',
            workspace: receipt,
          });
        }
        return result;
      } catch (error) {
        if (skillRead) throw error;
        const safe = safeWorkspaceError(error, { operation, receipt });
        receipt = failedWorkspaceReceipt(
          options.controller,
          options.conversationId,
          operation,
          params,
          receipt,
          safe.code
        );
        notify(options.onToolOutcome, {
          toolCallId,
          operation,
          status: 'failed',
          errorCode: safe.code,
          workspace: receipt,
        });
        throw safe;
      } finally {
        operationAbort.dispose();
      }
    },
  };
  return trustBuiltInToolOverride(wrapped);
}

async function createWorkspaceTools(options = {}) {
  const controller = options.controller;
  if (
    !controller ||
    [
      'execute',
      'accessFile',
      'readFile',
      'createDirectory',
      'writeFile',
      'listDirectory',
      'findFiles',
      'grepFiles',
      'prepareCommandPermissions',
      'grantCommandPermissions',
      'startProcess',
      'interactProcess',
    ].some((method) => typeof controller[method] !== 'function')
  ) {
    throw new TypeError('Workspace tools require a managed workspace controller');
  }
  if (typeof options.conversationId !== 'string' || !options.conversationId) {
    throw new TypeError('Workspace tools require a conversation ID');
  }
  if (typeof options.requestApproval !== 'function') {
    throw new TypeError('Workspace tools require an Agent-native approval boundary');
  }
  const sdk = validatePiSdk(options.sdk || (await loadPiSdk()));
  const serverPreviewEnabled = controller.fullNetworkPermissionsEnabled?.() === true;
  const toolOptions = { ...options, serverPreviewEnabled };
  const previewEnabled = options.previewController || options.scopedController;
  if (
    previewEnabled &&
    (typeof options.previewController?.createPreview !== 'function' ||
      typeof options.scopedController?.execute !== 'function')
  ) {
    throw new TypeError('Static previews require preview and scoped browser controllers');
  }
  if (
    previewEnabled &&
    serverPreviewEnabled &&
    (typeof controller.inspectProcess !== 'function' ||
      typeof options.previewController?.createProcessPreview !== 'function')
  ) {
    throw new TypeError('Managed server previews require process inspection support');
  }

  const bashTemplate = workspaceBashTemplate(
    sdk.createBashTool(VIRTUAL_AGENT_CWD, {
      operations: bashOperations(options, () => {}),
      exposeSessionEnvironment: false,
    }),
    { serverPreviewEnabled }
  );
  const readTemplate = createStandardReadTool(sdk, options);
  const writeTemplate = sdk.createWriteTool(VIRTUAL_AGENT_CWD, {
    operations: writeOperations(options),
  });
  const editTemplate = sdk.createEditTool(VIRTUAL_AGENT_CWD, {
    operations: editOperations(options),
  });
  const grepTemplate = sdk.createGrepTool(VIRTUAL_AGENT_CWD);
  const findTemplate = sdk.createFindTool(VIRTUAL_AGENT_CWD);
  const lsTemplate = sdk.createLsTool(VIRTUAL_AGENT_CWD);

  const tools = [
    wrapWorkspaceTool(bashTemplate, 'bash', options, (capture, executionOptions, params = {}) =>
      sdk.createBashTool(workspaceBashCwd(params.workingDirectory), {
        operations: bashOperations(executionOptions, capture, params),
        exposeSessionEnvironment: false,
      })
    ),
    wrapWorkspaceTool(readTemplate, 'read', options, (_capture, executionOptions) =>
      createStandardReadTool(sdk, executionOptions)
    ),
    wrapWorkspaceTool(writeTemplate, 'write', options, (_capture, executionOptions) =>
      sdk.createWriteTool(VIRTUAL_AGENT_CWD, { operations: writeOperations(executionOptions) })
    ),
    wrapWorkspaceTool(editTemplate, 'edit', options, (_capture, executionOptions) =>
      sdk.createEditTool(VIRTUAL_AGENT_CWD, { operations: editOperations(executionOptions) })
    ),
    wrapWorkspaceTool(grepTemplate, 'grep', options, (_capture, executionOptions) =>
      createStandardGrepTool(grepTemplate, executionOptions)
    ),
    wrapWorkspaceTool(findTemplate, 'find', options, (_capture, executionOptions) =>
      createStandardFindTool(findTemplate, executionOptions)
    ),
    wrapWorkspaceTool(lsTemplate, 'ls', options, (_capture, executionOptions) =>
      createStandardLsTool(lsTemplate, executionOptions)
    ),
    createRequestPermissionsTool(sdk, options),
    createWriteStdinTool(sdk, options),
  ];
  if (previewEnabled) tools.push(createWorkspacePreviewTool(sdk, toolOptions));
  return tools;
}

module.exports = {
  MAX_MODEL_BASH_OUTPUT_BYTES,
  MAX_MODEL_DISCOVERY_OUTPUT_BYTES,
  MAX_MODEL_READ_BYTES,
  MAX_MODEL_READ_LINES,
  WORKSPACE_TOOL_NAMES,
  boundedBashOutput,
  createStandardFindTool,
  createStandardGrepTool,
  createStandardLsTool,
  createRequestPermissionsTool,
  createWriteStdinTool,
  createWorkspacePreviewTool,
  createWorkspaceTools,
  decisionApproved,
  isSkillReadPath,
  safeWorkspaceError,
  virtualPathToWorkspaceRelative,
  workspaceAction,
  workspaceOperationIsReadOnly,
  workspaceOperationKind,
};
