'use strict';

const crypto = require('crypto');

const DEFAULT_PROCESS_YIELD_MS = 10_000;
const DEFAULT_PROCESS_POLL_MS = 5_000;
const MAX_PROCESS_YIELD_MS = 30_000;
const MAX_PROCESS_POLL_MS = 30_000;
const MAX_PROCESS_LOG_BYTES = 256 * 1024;
const MAX_PROCESS_INPUT_BYTES = 16 * 1024;
const MAX_ACTIVE_PROCESSES_PER_CONVERSATION = 4;
const TERMINAL_PROCESS_RETENTION_MS = 5 * 60 * 1_000;
const MIN_PREVIEW_PORT = 1_024;
const MAX_PREVIEW_PORT = 65_535;

class ManagedWorkspaceProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedWorkspaceProcessError';
    this.code = code;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) {
    throw new ManagedWorkspaceProcessError(
      'INVALID_WORKSPACE_PROCESS_REQUEST',
      'Workspace process timing must be a finite number'
    );
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function processId(factory = crypto.randomUUID) {
  return `workspace_process_${factory().replace(/-/g, '').slice(0, 24)}`;
}

function processKey(conversationId, id) {
  return `${conversationId}\0${id}`;
}

function validConversationId(value) {
  if (typeof value !== 'string' || !value || value.length > 160 || value.includes('\0')) {
    throw new ManagedWorkspaceProcessError(
      'INVALID_WORKSPACE_PROCESS_REQUEST',
      'A valid conversation is required for workspace process access'
    );
  }
  return value;
}

function validProcessId(value) {
  if (typeof value !== 'string' || !/^workspace_process_[a-f0-9]{24}$/.test(value)) {
    throw new ManagedWorkspaceProcessError(
      'WORKSPACE_PROCESS_NOT_FOUND',
      'The requested workspace process is unavailable'
    );
  }
  return value;
}

function validPreviewPort(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < MIN_PREVIEW_PORT || value > MAX_PREVIEW_PORT) {
    throw new ManagedWorkspaceProcessError(
      'INVALID_WORKSPACE_PROCESS_REQUEST',
      `Workspace preview ports must be integers from ${MIN_PREVIEW_PORT} through ${MAX_PREVIEW_PORT}`
    );
  }
  return value;
}

function timedWait(ms, setTimer, clearTimer) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimer(resolve, ms);
    timer?.unref?.();
  });
  return Object.freeze({
    promise,
    cancel() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  });
}

class ManagedWorkspaceProcessManager {
  constructor(options = {}) {
    if (typeof options.execute !== 'function') {
      throw new TypeError('ManagedWorkspaceProcessManager requires a sandboxed executor');
    }
    this.execute = options.execute;
    this.idFactory = options.idFactory || crypto.randomUUID;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.entries = new Map();
  }

  #append(entry, stream, value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
    if (!buffer.length) return;
    entry.streamed[stream] = true;
    entry.output = Buffer.concat([entry.output, buffer]);
    if (entry.output.length > MAX_PROCESS_LOG_BYTES) {
      const removed = entry.output.length - MAX_PROCESS_LOG_BYTES;
      entry.output = entry.output.subarray(removed);
      entry.deliveredOffset = Math.max(0, entry.deliveredOffset - removed);
      entry.outputTruncated = true;
    }
    entry.revision += 1;
    this.#wake(entry);
  }

  #wake(entry) {
    for (const resolve of entry.waiters) resolve();
    entry.waiters.clear();
  }

  #terminal(entry, receipt) {
    entry.receipt = receipt;
    entry.state = receipt?.state || 'failed';
    if (!entry.streamed.stdout && receipt?.stdout) this.#append(entry, 'stdout', receipt.stdout);
    if (!entry.streamed.stderr && receipt?.stderr) this.#append(entry, 'stderr', receipt.stderr);
    entry.revision += 1;
    this.#wake(entry);
    this.#retainTerminal(entry);
    this.#notifyTerminal(entry);
    return receipt;
  }

  #failed(entry, error) {
    entry.error = error;
    entry.state = 'failed';
    entry.receipt = Object.freeze({
      ...(entry.workspace || {}),
      command: entry.workspace?.command || entry.command,
      workingDirectory: entry.workspace?.workingDirectory || entry.workingDirectory,
      backend: entry.workspace?.backend || 'unavailable',
      ...(entry.previewPort && { previewPort: entry.previewPort }),
      state: 'failed',
      exitCode: null,
      signal: null,
      stdoutTruncated: entry.outputTruncated,
      stderrTruncated: false,
      terminationGuarantee: 'unknown',
      terminationScope: 'unknown',
      sideEffects: 'unknown',
      survivorsPossible: true,
      completeDescendantTermination: false,
    });
    entry.revision += 1;
    this.#wake(entry);
    this.#retainTerminal(entry);
    this.#notifyTerminal(entry);
    return null;
  }

  #retainTerminal(entry) {
    const key = processKey(entry.conversationId, entry.processId);
    if (this.entries.get(key) !== entry) return;
    if (entry.retentionTimer) this.clearTimer(entry.retentionTimer);
    entry.retentionTimer = this.setTimer(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    }, TERMINAL_PROCESS_RETENTION_MS);
    entry.retentionTimer?.unref?.();
  }

  #notifyTerminal(entry) {
    if (!entry.exposed || entry.terminalNotified || !entry.receipt || !entry.onTerminal) return;
    entry.terminalNotified = true;
    const event = Object.freeze({
      processId: entry.processId,
      state: entry.state,
      command: entry.command,
      workingDirectory: entry.workingDirectory,
      ...(entry.workspace && { workspace: entry.workspace }),
      ...(entry.previewPort && { previewPort: entry.previewPort }),
      receipt: entry.receipt,
    });
    try {
      Promise.resolve(entry.onTerminal(event)).catch(() => {});
    } catch {
      // Process completion and cleanup cannot depend on a lifecycle observer.
    }
  }

  #snapshot(entry) {
    const pending = entry.output.subarray(entry.deliveredOffset);
    entry.deliveredOffset = entry.output.length;
    const snapshot = {
      processId: entry.processId,
      state: entry.state,
      command: entry.command,
      workingDirectory: entry.workingDirectory,
      output: pending.toString('utf8'),
      outputTruncated: entry.outputTruncated,
      ...(entry.workspace && { workspace: entry.workspace }),
      ...(entry.previewPort && { previewPort: entry.previewPort }),
      ...(entry.receipt && { receipt: entry.receipt }),
    };
    entry.outputTruncated = false;
    return Object.freeze(snapshot);
  }

  #entry(conversationId, id) {
    const entry = this.entries.get(
      processKey(validConversationId(conversationId), validProcessId(id))
    );
    if (!entry) {
      throw new ManagedWorkspaceProcessError(
        'WORKSPACE_PROCESS_NOT_FOUND',
        'The requested workspace process is unavailable'
      );
    }
    return entry;
  }

  #activeCount(conversationId) {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.conversationId === conversationId && entry.state === 'running') count += 1;
    }
    return count;
  }

  async #waitForChange(entry, revision, timeoutMs, signal) {
    if (entry.revision !== revision || entry.state !== 'running' || signal?.aborted) return;
    let wake;
    const changed = new Promise((resolve) => {
      wake = resolve;
      entry.waiters.add(resolve);
    });
    const deadline = timedWait(timeoutMs, this.setTimer, this.clearTimer);
    let abortWake;
    const aborted = new Promise((resolve) => {
      abortWake = resolve;
      signal?.addEventListener?.('abort', resolve, { once: true });
    });
    try {
      await Promise.race([changed, deadline.promise, aborted]);
    } finally {
      deadline.cancel();
      entry.waiters.delete(wake);
      signal?.removeEventListener?.('abort', abortWake);
    }
  }

  async start(conversationId, request = {}) {
    const owner = validConversationId(conversationId);
    const requestedPreviewPort = validPreviewPort(request.previewPort);
    if (request.onTerminal !== undefined && typeof request.onTerminal !== 'function') {
      throw new ManagedWorkspaceProcessError(
        'INVALID_WORKSPACE_PROCESS_REQUEST',
        'Workspace process completion observer must be a function'
      );
    }
    if (this.#activeCount(owner) >= MAX_ACTIVE_PROCESSES_PER_CONVERSATION) {
      throw new ManagedWorkspaceProcessError(
        'WORKSPACE_PROCESS_LIMIT_REACHED',
        'Too many workspace commands are still running in this conversation'
      );
    }
    const yieldMs = boundedInteger(
      request.yieldMs,
      DEFAULT_PROCESS_YIELD_MS,
      250,
      MAX_PROCESS_YIELD_MS
    );
    const id = processId(this.idFactory);
    const controller = new AbortController();
    const entry = {
      processId: id,
      conversationId: owner,
      command: request.command,
      workingDirectory: request.workingDirectory || '.',
      controller,
      state: 'running',
      receipt: null,
      workspace: null,
      error: null,
      stdin: null,
      output: Buffer.alloc(0),
      deliveredOffset: 0,
      outputTruncated: false,
      streamed: { stdout: false, stderr: false },
      revision: 0,
      waiters: new Set(),
      retentionTimer: null,
      exposed: false,
      terminalNotified: false,
      onTerminal: request.onTerminal || null,
      previewPort: requestedPreviewPort,
    };
    this.entries.set(processKey(owner, id), entry);

    const abort = () => controller.abort();
    request.signal?.addEventListener?.('abort', abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const { onTerminal: _onTerminal, ...executionRequest } = request;
    entry.completion = Promise.resolve()
      .then(() =>
        this.execute(owner, {
          ...executionRequest,
          signal: controller.signal,
          onOutput: (stream, chunk) => this.#append(entry, stream, chunk),
          onStdin: (control) => {
            entry.stdin = control;
          },
          onStarted: (workspace) => {
            entry.workspace = workspace;
            entry.revision += 1;
            this.#wake(entry);
          },
        })
      )
      .then(
        (receipt) => this.#terminal(entry, receipt),
        (error) => this.#failed(entry, error)
      );

    const deadline = timedWait(yieldMs, this.setTimer, this.clearTimer);
    try {
      await Promise.race([entry.completion, deadline.promise]);
    } finally {
      deadline.cancel();
    }
    request.signal?.removeEventListener?.('abort', abort);
    if (entry.error) {
      if (entry.retentionTimer) this.clearTimer(entry.retentionTimer);
      this.entries.delete(processKey(owner, id));
      throw entry.error;
    }
    const snapshot = this.#snapshot(entry);
    if (entry.state === 'running') entry.exposed = true;
    if (entry.state !== 'running') {
      if (entry.retentionTimer) this.clearTimer(entry.retentionTimer);
      this.entries.delete(processKey(owner, id));
    }
    return snapshot;
  }

  async interact(conversationId, id, request = {}) {
    const entry = this.#entry(conversationId, id);
    const input = request.input ?? '';
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_PROCESS_INPUT_BYTES) {
      throw new ManagedWorkspaceProcessError(
        'INVALID_WORKSPACE_PROCESS_REQUEST',
        'Workspace process input must be bounded text'
      );
    }
    const terminate = request.terminate === true;
    if (request.terminate !== undefined && typeof request.terminate !== 'boolean') {
      throw new ManagedWorkspaceProcessError(
        'INVALID_WORKSPACE_PROCESS_REQUEST',
        'Workspace process termination must be a boolean'
      );
    }
    if (entry.state === 'running' && input) {
      if (!entry.stdin?.write(Buffer.from(input))) {
        throw new ManagedWorkspaceProcessError(
          'WORKSPACE_PROCESS_INPUT_UNAVAILABLE',
          'The workspace process is not accepting input'
        );
      }
    }
    if (entry.state === 'running' && terminate) entry.controller.abort();
    const waitMs = boundedInteger(
      request.waitMs,
      input || terminate ? 250 : DEFAULT_PROCESS_POLL_MS,
      0,
      MAX_PROCESS_POLL_MS
    );
    const revision = entry.revision;
    if (waitMs > 0) await this.#waitForChange(entry, revision, waitMs, request.signal);
    if (entry.error) {
      if (entry.retentionTimer) this.clearTimer(entry.retentionTimer);
      this.entries.delete(processKey(entry.conversationId, entry.processId));
      throw entry.error;
    }
    const snapshot = this.#snapshot(entry);
    if (entry.state !== 'running') {
      if (entry.retentionTimer) this.clearTimer(entry.retentionTimer);
      this.entries.delete(processKey(entry.conversationId, entry.processId));
    }
    return snapshot;
  }

  inspect(conversationId, id) {
    const entry = this.#entry(conversationId, id);
    return Object.freeze({
      processId: entry.processId,
      state: entry.state,
      command: entry.command,
      workingDirectory: entry.workingDirectory,
      ...(entry.previewPort && { previewPort: entry.previewPort }),
      ...(entry.workspace && { workspace: entry.workspace }),
      ...(entry.receipt && { receipt: entry.receipt }),
    });
  }

  cancelConversation(conversationId) {
    const owner = validConversationId(conversationId);
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.conversationId !== owner || entry.state !== 'running') continue;
      entry.controller.abort();
      count += 1;
    }
    return count;
  }

  deleteConversation(conversationId) {
    const owner = validConversationId(conversationId);
    this.cancelConversation(owner);
    for (const [key, entry] of this.entries) {
      if (entry.conversationId !== owner) continue;
      if (entry.retentionTimer) this.clearTimer(entry.retentionTimer);
      this.entries.delete(key);
    }
  }

  dispose() {
    for (const entry of this.entries.values()) {
      if (entry.state === 'running') entry.controller.abort();
      if (entry.retentionTimer) this.clearTimer(entry.retentionTimer);
      this.#wake(entry);
    }
    this.entries.clear();
  }
}

module.exports = {
  DEFAULT_PROCESS_POLL_MS,
  DEFAULT_PROCESS_YIELD_MS,
  MAX_ACTIVE_PROCESSES_PER_CONVERSATION,
  MAX_PROCESS_INPUT_BYTES,
  MAX_PROCESS_LOG_BYTES,
  MAX_PROCESS_POLL_MS,
  MAX_PROCESS_YIELD_MS,
  MAX_PREVIEW_PORT,
  MIN_PREVIEW_PORT,
  ManagedWorkspaceProcessError,
  ManagedWorkspaceProcessManager,
  TERMINAL_PROCESS_RETENTION_MS,
};
