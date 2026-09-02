'use strict';

const fs = require('fs');
const path = require('path');
const {
  createWorkspaceExecutionPolicy,
  EXECUTION_STATES,
  insidePath,
  NETWORK_POSTURES,
} = require('./workspace-execution/execution-policy');
const { createWorkspaceExecutor } = require('./workspace-execution/workspace-executor');
const { detectElectronJavaScriptRuntime } = require('./workspace-execution/electron-runtime');

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_FILE_OPERATION_TIMEOUT_MS = 10_000;
const MAX_COMMAND_LENGTH = 32_000;
const MAX_WORKSPACE_READ_BYTES = 512 * 1024;
const MAX_WORKSPACE_WRITE_BYTES = 64 * 1024;
const MAX_WORKSPACE_PATH_LENGTH = 1_024;
const WORKSPACE_FILE_HELPER = String.raw`
const fs = require('fs');
const path = require('path');
const READ_LIMIT = 524288;
const WRITE_LIMIT = 65536;
const [operation, relative, encoded = ''] = process.argv.slice(1);
const root = fs.realpathSync(process.cwd());

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function checkedRelative(value, allowRoot = false) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) fail('INVALID_WORKSPACE_REQUEST');
  if (value === '.' && allowRoot) return value;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('INVALID_WORKSPACE_REQUEST');
  return parts.join('/');
}

function targetPath(value, allowRoot = false) {
  const safe = checkedRelative(value, allowRoot);
  const target = safe === '.' ? root : path.resolve(root, ...safe.split('/'));
  const relation = path.relative(root, target);
  if (relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) fail('INVALID_WORKSPACE_REQUEST');
  return { safe, target };
}

function regularFile(target) {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
  return stats;
}

function ensureDirectory(relativeDirectory) {
  const { safe } = targetPath(relativeDirectory, true);
  if (safe === '.') return root;
  let current = root;
  for (const part of safe.split('/')) {
    current = path.join(current, part);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) fail('WORKSPACE_FILE_UNSAFE');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
}

function writablePath(value) {
  const safe = checkedRelative(value);
  if (safe === '.git' || safe.startsWith('.git/')) fail('WORKSPACE_PROTECTED_PATH');
  return safe;
}

try {
  if (operation === 'access' || operation === 'read') {
    const { target } = targetPath(relative);
    const stats = regularFile(target);
    if (stats.size > READ_LIMIT) fail('WORKSPACE_FILE_TOO_LARGE');
    if (operation === 'read') process.stdout.write(fs.readFileSync(target));
  } else if (operation === 'mkdir') {
    ensureDirectory(relative === '.' ? '.' : writablePath(relative));
  } else if (operation === 'write') {
    const safe = writablePath(relative);
    const content = Buffer.from(encoded, 'base64');
    if (content.byteLength > WRITE_LIMIT) fail('WORKSPACE_FILE_TOO_LARGE');
    const parent = ensureDirectory(path.posix.dirname(safe));
    const target = path.join(parent, path.posix.basename(safe));
    try {
      regularFile(target);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stats = fs.fstatSync(fd);
      if (!stats.isFile() || stats.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    fail('INVALID_WORKSPACE_REQUEST');
  }
} catch (error) {
  const allowed = new Set(['INVALID_WORKSPACE_REQUEST', 'WORKSPACE_FILE_TOO_LARGE', 'WORKSPACE_FILE_UNSAFE', 'WORKSPACE_PROTECTED_PATH']);
  const fallback = operation === 'read' || operation === 'access' ? 'WORKSPACE_FILE_UNAVAILABLE' : 'WORKSPACE_WRITE_FAILED';
  process.stderr.write('FREEDOM_FILE_ERROR:' + (allowed.has(error && error.code) ? error.code : fallback));
  process.exit(73);
}
`;

class ManagedWorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedWorkspaceError';
    this.code = code;
  }
}

function validateWorkingDirectory(value = '.') {
  if (typeof value !== 'string' || !value || value.length > 1_024 || value.includes('\0')) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'workingDirectory must be a bounded workspace-relative path'
    );
  }
  if (value === '.') return value;
  if (path.isAbsolute(value) || value.includes('\\')) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'workingDirectory must be a workspace-relative path'
    );
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'workingDirectory must be a safe workspace-relative path'
    );
  }
  return value;
}

function validateCommand(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_COMMAND_LENGTH ||
    value.includes('\0')
  ) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      `command must be non-empty text of at most ${MAX_COMMAND_LENGTH} characters`
    );
  }
  return value;
}

function validateWorkspacePath(value, options = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_WORKSPACE_PATH_LENGTH ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value)
  ) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'File paths must be bounded workspace-relative paths'
    );
  }
  if (value === '.' && options.allowRoot === true) return value;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'File paths must remain inside the managed workspace'
    );
  }
  return segments.join('/');
}

function assertWritableWorkspacePath(value) {
  const relative = validateWorkspacePath(value);
  if (relative === '.git' || relative.startsWith('.git/')) {
    throw new ManagedWorkspaceError(
      'WORKSPACE_PROTECTED_PATH',
      'Git metadata is read-only inside the managed workspace'
    );
  }
  return relative;
}

function validateWorkspaceContent(content) {
  if (typeof content !== 'string') {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'Workspace file content must be text'
    );
  }
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength > MAX_WORKSPACE_WRITE_BYTES) {
    throw new ManagedWorkspaceError(
      'WORKSPACE_FILE_TOO_LARGE',
      `Workspace writes are limited to ${MAX_WORKSPACE_WRITE_BYTES} bytes`
    );
  }
  return buffer;
}

function commandSummary(command) {
  // eslint-disable-next-line no-control-regex
  const firstLine = command.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}

function safeReceiptError(value) {
  if (!value || typeof value !== 'object') return null;
  const code = /^[A-Z0-9_]{1,120}$/.test(value.code) ? value.code : 'WORKSPACE_EXECUTION_FAILED';
  const candidate =
    typeof value.message === 'string'
      ? // eslint-disable-next-line no-control-regex
        value.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
      : '';
  const message =
    candidate && !candidate.includes('/') && !candidate.includes('\\')
      ? candidate.slice(0, 512)
      : 'The workspace command did not complete';
  return Object.freeze({ code, message });
}

function publicCapabilities(capabilities) {
  if (!capabilities?.available) {
    return Object.freeze({
      available: false,
      backend: capabilities?.backend || 'unavailable',
      denial: Object.freeze({
        code: capabilities?.denial?.code || 'WORKSPACE_EXECUTION_UNAVAILABLE',
        message: capabilities?.denial?.message || 'Sandboxed workspace execution is unavailable',
      }),
    });
  }
  const enforcement = capabilities.enforcement || {};
  return Object.freeze({
    available: true,
    backend: capabilities.backend,
    network: 'disabled',
    filesystem: 'managed_workspace_only',
    cancellationGuarantee: enforcement.cancellationGuarantee || 'backend_reported',
    survivorsPossible: enforcement.survivorsPossible === true,
    completeDescendantTermination: enforcement.completeDescendantTermination === true,
  });
}

class ManagedWorkspaceController {
  constructor(options = {}) {
    if (!options.store || typeof options.store.ensureForConversation !== 'function') {
      throw new TypeError('ManagedWorkspaceController requires a workspace store');
    }
    this.store = options.store;
    this.executor = options.executor || createWorkspaceExecutor();
    this.detectRuntime = options.detectRuntime || detectElectronJavaScriptRuntime;
    this.createPolicy = options.createPolicy || createWorkspaceExecutionPolicy;
    this.runtimeOptions = options.runtimeOptions || {};
    this.now = options.now || Date.now;
    this.capabilities = null;
    this.runtime = null;
    this.leases = new Map();
    this.activeCommands = new Map();
  }

  async getCapabilities() {
    if (this.capabilities) return this.capabilities;
    let capabilities;
    try {
      capabilities = await this.executor.detectCapabilities();
    } catch {
      capabilities = {
        backend: 'unavailable',
        available: false,
        denial: {
          code: 'WORKSPACE_CAPABILITY_DETECTION_FAILED',
          message: 'Freedom could not verify the workspace sandbox',
        },
      };
    }
    this.capabilities = publicCapabilities(capabilities);
    return this.capabilities;
  }

  getWorkspace(conversationId) {
    const workspace = this.store.getForConversation(conversationId);
    return workspace
      ? Object.freeze({
          workspaceId: workspace.workspaceId,
          enabled: workspace.enabled,
          backend: workspace.backend,
          commands: this.store.listCommands(conversationId, 50).map((command) => {
            const error = safeReceiptError(command.error);
            return {
              commandId: command.commandId,
              command: commandSummary(command.command),
              workingDirectory: command.workingDirectory,
              state: command.state,
              backend: command.backend,
              startedAt: command.startedAt,
              ...(Number.isFinite(command.finishedAt) && { finishedAt: command.finishedAt }),
              ...(Number.isFinite(command.durationMs) && { durationMs: command.durationMs }),
              ...(Number.isInteger(command.exitCode) && { exitCode: command.exitCode }),
              terminationGuarantee: command.terminationGuarantee,
              sideEffects: command.sideEffects,
              ...(error && { error }),
            };
          }),
        })
      : null;
  }

  async disclosure(conversationId) {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new ManagedWorkspaceError('INVALID_WORKSPACE_REQUEST', 'Conversation ID is required');
    }
    const capabilities = await this.getCapabilities();
    if (!capabilities.available) {
      throw new ManagedWorkspaceError(capabilities.denial.code, capabilities.denial.message);
    }
    await this.#attestedRuntime();
    return capabilities;
  }

  async enable(conversationId) {
    const capabilities = await this.disclosure(conversationId);
    const workspace = await this.store.ensureForConversation(conversationId);
    await this.#lease(workspace);
    const enabled = this.store.enable(workspace.workspaceId, conversationId, capabilities.backend);
    if (!enabled) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_ENABLE_FAILED',
        'Freedom could not enable the managed workspace'
      );
    }
    return enabled;
  }

  async #attestedRuntime() {
    if (this.runtime) return this.runtime;
    const runtime = await this.detectRuntime(this.runtimeOptions);
    if (!runtime?.available) {
      throw new ManagedWorkspaceError(
        runtime?.denial?.code || 'WORKSPACE_RUNTIME_UNAVAILABLE',
        runtime?.denial?.message || 'Freedom could not verify its sandboxed JavaScript runtime'
      );
    }
    this.runtime = runtime;
    return runtime;
  }

  async #lease(workspace) {
    const existing = this.leases.get(workspace.workspaceId);
    if (existing) return existing;
    const workspaceRoot = await this.store.resolvePath(workspace.workspaceId);
    const runtime = await this.#attestedRuntime();
    let policy;
    try {
      policy = await this.createPolicy({
        workspaceRoot,
        nodeRuntimeRoot: null,
        electronRuntime: runtime,
        network: NETWORK_POSTURES.NONE,
        environment: {
          set: {
            ELECTRON_RUN_AS_NODE: '1',
            FREEDOM_JAVASCRIPT_RUNTIME: runtime.sandboxExecutablePath,
          },
        },
        limits: {
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
          stdoutBytes: 1024 * 1024,
          stderrBytes: 1024 * 1024,
        },
      });
    } catch (error) {
      throw new ManagedWorkspaceError(
        typeof error?.code === 'string' ? error.code : 'WORKSPACE_POLICY_FAILED',
        'Freedom could not establish the managed workspace boundary'
      );
    }
    const lease = Object.freeze({ workspaceRoot, runtime, policy });
    this.leases.set(workspace.workspaceId, lease);
    return lease;
  }

  async #workingDirectory(lease, value, backend) {
    const relative = validateWorkingDirectory(value);
    const candidate = path.resolve(lease.workspaceRoot, relative);
    if (!insidePath(lease.workspaceRoot, candidate)) {
      throw new ManagedWorkspaceError(
        'INVALID_WORKSPACE_REQUEST',
        'workingDirectory must remain inside the managed workspace'
      );
    }
    let canonical;
    let stats;
    try {
      canonical = await fs.promises.realpath(candidate);
      stats = await fs.promises.stat(canonical);
    } catch {
      throw new ManagedWorkspaceError(
        'WORKSPACE_DIRECTORY_UNAVAILABLE',
        'The requested workspace directory does not exist'
      );
    }
    if (!stats.isDirectory() || !insidePath(lease.workspaceRoot, canonical)) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_DIRECTORY_UNAVAILABLE',
        'The requested workspace directory is unavailable'
      );
    }
    const normalizedRelative = path.relative(lease.workspaceRoot, canonical);
    const sandboxPath = normalizedRelative
      ? path.posix.join('/workspace', ...normalizedRelative.split(path.sep))
      : '/workspace';
    return {
      relative: normalizedRelative ? normalizedRelative.split(path.sep).join('/') : '.',
      executionPath: backend === 'linux-bubblewrap' ? sandboxPath : canonical,
    };
  }

  async #enabledLease(conversationId) {
    const workspace = this.store.getForConversation(conversationId);
    if (!workspace?.enabled) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_EXECUTION_NOT_ENABLED',
        'The managed workspace has not been enabled for this conversation'
      );
    }
    return { workspace, lease: await this.#lease(workspace) };
  }

  async #fileOperation(conversationId, operation, relativePath, content = null) {
    const relative =
      operation === 'mkdir'
        ? relativePath === '.'
          ? '.'
          : assertWritableWorkspacePath(relativePath)
        : operation === 'write'
          ? assertWritableWorkspacePath(relativePath)
          : validateWorkspacePath(relativePath);
    const capabilities = await this.getCapabilities();
    if (!capabilities.available) {
      throw new ManagedWorkspaceError(capabilities.denial.code, capabilities.denial.message);
    }
    const { lease } = await this.#enabledLease(conversationId);
    const executionRoot =
      capabilities.backend === 'linux-bubblewrap' ? '/workspace' : lease.workspaceRoot;
    const controller = new AbortController();
    const activeToken = {};
    const timeout = setTimeout(() => controller.abort(), DEFAULT_FILE_OPERATION_TIMEOUT_MS);
    this.activeCommands.set(activeToken, { conversationId, controller });
    let receipt;
    try {
      receipt = await this.executor.execute(lease.policy, {
        command: '/bin/sh',
        args: [
          '-c',
          'cd "$1" && exec "$FREEDOM_JAVASCRIPT_RUNTIME" -e "$2" "$3" "$4" "$5"',
          'freedom-workspace-file',
          executionRoot,
          WORKSPACE_FILE_HELPER,
          operation,
          relative,
          content ? content.toString('base64') : '',
        ],
        signal: controller.signal,
      });
    } catch {
      throw new ManagedWorkspaceError(
        operation === 'read' || operation === 'access'
          ? 'WORKSPACE_FILE_UNAVAILABLE'
          : 'WORKSPACE_WRITE_FAILED',
        'Freedom could not complete the workspace file operation'
      );
    } finally {
      clearTimeout(timeout);
      this.activeCommands.delete(activeToken);
    }
    if (receipt.state !== EXECUTION_STATES.COMPLETED || receipt.exitCode !== 0) {
      const reported = /FREEDOM_FILE_ERROR:([A-Z0-9_]{1,120})/.exec(receipt.stderr || '')?.[1];
      const allowed = new Set([
        'INVALID_WORKSPACE_REQUEST',
        'WORKSPACE_FILE_TOO_LARGE',
        'WORKSPACE_FILE_UNAVAILABLE',
        'WORKSPACE_FILE_UNSAFE',
        'WORKSPACE_PROTECTED_PATH',
        'WORKSPACE_WRITE_FAILED',
      ]);
      const code = allowed.has(reported)
        ? reported
        : operation === 'read' || operation === 'access'
          ? 'WORKSPACE_FILE_UNAVAILABLE'
          : 'WORKSPACE_WRITE_FAILED';
      throw new ManagedWorkspaceError(
        code,
        'Freedom could not complete the workspace file operation'
      );
    }
    if (receipt.stdoutTruncated) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_FILE_TOO_LARGE',
        `Workspace reads are limited to ${MAX_WORKSPACE_READ_BYTES} bytes`
      );
    }
    return Buffer.from(receipt.stdout || '', 'utf8');
  }

  async accessFile(conversationId, relativePath) {
    await this.#fileOperation(conversationId, 'access', relativePath);
  }

  async readFile(conversationId, relativePath) {
    return this.#fileOperation(conversationId, 'read', relativePath);
  }

  async createDirectory(conversationId, relativePath) {
    await this.#fileOperation(conversationId, 'mkdir', relativePath);
  }

  async writeFile(conversationId, relativePath, content) {
    const buffer = validateWorkspaceContent(content);
    await this.#fileOperation(conversationId, 'write', relativePath, buffer);
  }

  async execute(conversationId, request = {}) {
    const { workspace, lease } = await this.#enabledLease(conversationId);
    const command = validateCommand(request.command);
    const capabilities = await this.getCapabilities();
    if (!capabilities.available) {
      throw new ManagedWorkspaceError(capabilities.denial.code, capabilities.denial.message);
    }
    const workingDirectory = await this.#workingDirectory(
      lease,
      request.workingDirectory || '.',
      capabilities.backend
    );
    const controller = new AbortController();
    const externalSignal = request.signal;
    const abort = () => controller.abort();
    externalSignal?.addEventListener?.('abort', abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const requestedTimeoutMs = Number.isFinite(request.timeoutMs)
      ? Math.max(1, Math.min(DEFAULT_COMMAND_TIMEOUT_MS, Math.floor(request.timeoutMs)))
      : DEFAULT_COMMAND_TIMEOUT_MS;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestedTimeoutMs);
    const startedAt = this.now();
    const commandId = this.store.startCommand({
      workspaceId: workspace.workspaceId,
      conversationId,
      command,
      workingDirectory: workingDirectory.relative,
      backend: capabilities.backend,
      startedAt,
    });
    this.activeCommands.set(commandId, { conversationId, controller });
    let receipt;
    try {
      receipt = await this.executor.execute(lease.policy, {
        command: '/bin/sh',
        args: [
          '-c',
          'cd "$1" && exec /bin/sh -lc "$2"',
          'freedom-workspace',
          workingDirectory.executionPath,
          command,
        ],
        signal: controller.signal,
      });
    } catch {
      const finishedAt = this.now();
      receipt = Object.freeze({
        backend: capabilities.backend,
        state: EXECUTION_STATES.SANDBOX_DENIED,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        terminationGuarantee: 'not_applicable',
        sideEffects: 'none',
        error: Object.freeze({
          code: 'WORKSPACE_EXECUTION_FAILED',
          message: 'Freedom could not execute the command inside the verified sandbox',
        }),
      });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.('abort', abort);
      this.activeCommands.delete(commandId);
    }
    const error = safeReceiptError(receipt.error);
    const result = Object.freeze({
      workspaceId: workspace.workspaceId,
      commandId,
      command: commandSummary(command),
      workingDirectory: workingDirectory.relative,
      backend: receipt.backend || capabilities.backend,
      state:
        timedOut && receipt.state === EXECUTION_STATES.CANCELLED
          ? EXECUTION_STATES.TIMED_OUT
          : receipt.state,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      durationMs: receipt.durationMs,
      exitCode: receipt.exitCode,
      signal: receipt.signal,
      stdout: receipt.stdout || '',
      stderr: receipt.stderr || '',
      stdoutTruncated: receipt.stdoutTruncated === true,
      stderrTruncated: receipt.stderrTruncated === true,
      terminationGuarantee: receipt.terminationGuarantee || 'not_applicable',
      sideEffects: receipt.sideEffects || 'unknown',
      survivorsPossible: receipt.survivorsPossible === true,
      completeDescendantTermination: receipt.completeDescendantTermination === true,
      ...(error && { error }),
    });
    this.store.finishCommand(commandId, workspace.workspaceId, result);
    return result;
  }

  cancelConversation(conversationId) {
    let count = 0;
    for (const active of this.activeCommands.values()) {
      if (active.conversationId !== conversationId) continue;
      active.controller.abort();
      count += 1;
    }
    return count;
  }

  async deleteConversation(conversationId) {
    this.cancelConversation(conversationId);
    const workspace = this.store.getForConversation(conversationId);
    if (!workspace) return false;
    this.leases.delete(workspace.workspaceId);
    return this.store.deleteConversation(conversationId);
  }

  dispose() {
    for (const active of this.activeCommands.values()) active.controller.abort();
    this.activeCommands.clear();
    this.leases.clear();
  }
}

module.exports = {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_FILE_OPERATION_TIMEOUT_MS,
  MAX_COMMAND_LENGTH,
  MAX_WORKSPACE_READ_BYTES,
  MAX_WORKSPACE_WRITE_BYTES,
  WORKSPACE_FILE_HELPER,
  ManagedWorkspaceController,
  ManagedWorkspaceError,
  commandSummary,
  publicCapabilities,
  safeReceiptError,
  validateCommand,
  validateWorkspacePath,
  validateWorkingDirectory,
};
