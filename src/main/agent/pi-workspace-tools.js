'use strict';

const path = require('path');
const { getBuiltInSkillResource, isBuiltInSkillResourcePath } = require('./builtin-skills');
const {
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  MAX_WORKSPACE_FIND_RESULTS,
  MAX_WORKSPACE_GREP_MATCHES,
} = require('./managed-workspace-controller');
const { loadPiSdk, validatePiSdk } = require('./pi-sdk');
const { trustBuiltInToolOverride } = require('./pi-trusted-tools');
const { VIRTUAL_AGENT_CWD } = require('./pi-virtual-paths');

const WORKSPACE_TOOL_NAMES = Object.freeze(['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls']);
const READ_ONLY_WORKSPACE_OPERATIONS = new Set(['read', 'grep', 'find', 'ls']);
const MAX_MODEL_BASH_OUTPUT_BYTES = 48 * 1024;
const MAX_MODEL_READ_BYTES = 50 * 1024;
const MAX_MODEL_READ_LINES = 2_000;
const MAX_MODEL_DISCOVERY_OUTPUT_BYTES = 50 * 1024;

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
    'WORKSPACE_FILE_TOO_LARGE',
    'WORKSPACE_FILE_UNAVAILABLE',
    'WORKSPACE_FILE_UNSAFE',
    'WORKSPACE_POLICY_FAILED',
    'WORKSPACE_PROTECTED_PATH',
    'WORKSPACE_RUNTIME_UNAVAILABLE',
    'WORKSPACE_WRITE_FAILED',
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
      : 'Freedom could not complete the operation inside the managed workspace';
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
  }[operation];
}

function workspaceOperationIsReadOnly(operation) {
  return READ_ONLY_WORKSPACE_OPERATIONS.has(operation);
}

function fileWorkspaceReceipt(controller, conversationId, operation, params, state) {
  const workspace = controller.getWorkspace(conversationId);
  return Object.freeze({
    ...(workspace?.workspaceId && { workspaceId: workspace.workspaceId }),
    kind: workspaceOperationKind(operation),
    command: workspaceAction(operation, params),
    workingDirectory: '.',
    backend: 'freedom-workspace-files',
    state,
    stdoutTruncated: false,
    stderrTruncated: false,
    terminationGuarantee: 'not_applicable',
    sideEffects: workspaceOperationIsReadOnly(operation) ? 'none' : 'unknown',
    survivorsPossible: false,
    completeDescendantTermination: true,
  });
}

function failedWorkspaceReceipt(controller, conversationId, operation, params, existing) {
  if (existing) return existing;
  return fileWorkspaceReceipt(controller, conversationId, operation, params, 'sandbox_denied');
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

async function ensureWorkspaceEnabled(options, operation) {
  let workspace = options.controller.getWorkspace(options.conversationId);
  if (workspace?.enabled) return workspace;
  const capabilities = await options.controller.disclosure(options.conversationId);
  const decision = await options.requestApproval({
    action: 'workspace_execution',
    operation,
    workspace: capabilities,
  });
  if (!decisionApproved(decision)) {
    const declined = new Error('The user did not enable managed workspace execution');
    declined.code = 'WORKSPACE_EXECUTION_DECLINED';
    throw declined;
  }
  await options.controller.enable(options.conversationId);
  workspace = options.controller.getWorkspace(options.conversationId);
  return workspace;
}

function readOperations(options) {
  const read = async (filePath) => {
    if (isBuiltInSkillResourcePath(filePath)) return getBuiltInSkillResource(filePath);
    return options.controller.readFile(
      options.conversationId,
      virtualPathToWorkspaceRelative(filePath)
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
        virtualPathToWorkspaceRelative(filePath)
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
        content
      ),
    mkdir: async (directoryPath) =>
      options.controller.createDirectory(
        options.conversationId,
        virtualPathToWorkspaceRelative(directoryPath, { allowRoot: true })
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
        { limit, signal }
      );
      if (signal?.aborted) throw new Error('Operation aborted');
      const lines = result.entries.map(
        (entry) => `${entry.name}${entry.type === 'directory' ? '/' : ''}`
      );
      const bounded = boundedDiscoveryOutput(lines.length ? lines.join('\n') : '(empty directory)');
      let output = bounded.content;
      const details = {};
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
        { pattern: params.pattern, limit, signal }
      );
      if (signal?.aborted) throw new Error('Operation aborted');
      const bounded = boundedDiscoveryOutput(
        result.results.length ? result.results.join('\n') : 'No files found matching pattern'
      );
      let output = bounded.content;
      const details = {};
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
        }
      );
      if (signal?.aborted) throw new Error('Operation aborted');
      let output = result.matchCount ? result.output : 'No matches found';
      const details = {};
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

function bashOperations(options, captureReceipt) {
  return Object.freeze({
    exec: async (command, cwd, execution = {}) => {
      const receipt = await options.controller.execute(options.conversationId, {
        command,
        workingDirectory: virtualPathToWorkspaceRelative(cwd, { allowRoot: true }),
        signal: execution.signal,
        ...(Number.isFinite(execution.timeout) && { timeoutMs: execution.timeout * 1_000 }),
      });
      captureReceipt(receipt);
      const output = boundedBashOutput(receipt);
      if (output.byteLength) execution.onData(output);
      if (receipt.state === 'cancelled') throw new Error('aborted');
      if (receipt.state === 'timed_out') {
        throw new Error(`timeout:${Number.isFinite(execution.timeout) ? execution.timeout : 300}`);
      }
      if (receipt.state === 'sandbox_denied') {
        const error = new Error(receipt.error?.message || 'The workspace sandbox denied execution');
        error.code = receipt.error?.code || 'WORKSPACE_EXECUTION_FAILED';
        throw error;
      }
      return { exitCode: receipt.exitCode };
    },
  });
}

function wrapWorkspaceTool(template, operation, options, createRuntimeTool) {
  const wrapped = {
    ...template,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, onUpdate, context) {
      const skillRead = operation === 'read' && isSkillReadPath(params?.path);
      let receipt = null;
      try {
        if (!skillRead) await ensureWorkspaceEnabled(options, operation);
        const runtimeTool = createRuntimeTool((value) => {
          receipt = value;
        });
        const result = await runtimeTool.execute(toolCallId, params, signal, onUpdate, context);
        if (!skillRead) {
          receipt ||= fileWorkspaceReceipt(
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
        }
        return result;
      } catch (error) {
        if (skillRead) throw error;
        const safe = safeWorkspaceError(error);
        receipt = failedWorkspaceReceipt(
          options.controller,
          options.conversationId,
          operation,
          params,
          receipt
        );
        notify(options.onToolOutcome, {
          toolCallId,
          operation,
          status: 'failed',
          errorCode: safe.code,
          workspace: receipt,
        });
        throw safe;
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

  const bashTemplate = sdk.createBashTool(VIRTUAL_AGENT_CWD, {
    operations: bashOperations(options, () => {}),
    exposeSessionEnvironment: false,
  });
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

  return [
    wrapWorkspaceTool(bashTemplate, 'bash', options, (capture) =>
      sdk.createBashTool(VIRTUAL_AGENT_CWD, {
        operations: bashOperations(options, capture),
        exposeSessionEnvironment: false,
      })
    ),
    wrapWorkspaceTool(readTemplate, 'read', options, () => createStandardReadTool(sdk, options)),
    wrapWorkspaceTool(writeTemplate, 'write', options, () =>
      sdk.createWriteTool(VIRTUAL_AGENT_CWD, { operations: writeOperations(options) })
    ),
    wrapWorkspaceTool(editTemplate, 'edit', options, () =>
      sdk.createEditTool(VIRTUAL_AGENT_CWD, { operations: editOperations(options) })
    ),
    wrapWorkspaceTool(grepTemplate, 'grep', options, () =>
      createStandardGrepTool(grepTemplate, options)
    ),
    wrapWorkspaceTool(findTemplate, 'find', options, () =>
      createStandardFindTool(findTemplate, options)
    ),
    wrapWorkspaceTool(lsTemplate, 'ls', options, () => createStandardLsTool(lsTemplate, options)),
  ];
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
  createWorkspaceTools,
  decisionApproved,
  isSkillReadPath,
  safeWorkspaceError,
  virtualPathToWorkspaceRelative,
  workspaceAction,
  workspaceOperationIsReadOnly,
  workspaceOperationKind,
};
