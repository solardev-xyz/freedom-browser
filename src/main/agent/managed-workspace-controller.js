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

const WORKSPACE_TOOL_NAME = 'workspace_run';
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_COMMAND_LENGTH = 32_000;

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

  async execute(conversationId, request = {}) {
    const workspace = this.store.getForConversation(conversationId);
    if (!workspace?.enabled) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_EXECUTION_NOT_ENABLED',
        'The managed workspace has not been enabled for this conversation'
      );
    }
    const command = validateCommand(request.command);
    const capabilities = await this.getCapabilities();
    if (!capabilities.available) {
      throw new ManagedWorkspaceError(capabilities.denial.code, capabilities.denial.message);
    }
    const lease = await this.#lease(workspace);
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
      state: receipt.state,
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
  MAX_COMMAND_LENGTH,
  ManagedWorkspaceController,
  ManagedWorkspaceError,
  WORKSPACE_TOOL_NAME,
  commandSummary,
  publicCapabilities,
  safeReceiptError,
  validateCommand,
  validateWorkingDirectory,
};
