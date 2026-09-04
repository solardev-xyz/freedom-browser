'use strict';

const fs = require('fs');
const path = require('path');
const {
  createWorkspaceExecutionPolicy,
  EXECUTION_STATES,
  insidePath,
  NETWORK_POSTURES,
  restrictWorkspaceExecutionPolicy,
} = require('./workspace-execution/execution-policy');
const { createWorkspaceExecutor } = require('./workspace-execution/workspace-executor');
const { detectElectronJavaScriptRuntime } = require('./workspace-execution/electron-runtime');
const {
  isValidatedExecutableAccessRequest,
  resolveExecutableAccess,
} = require('./workspace-execution/executable-access');
const { captureHostCommandEnvironment } = require('./workspace-execution/host-command-environment');
const {
  CAPABILITY_KINDS,
  WorkspaceCapabilityGrantStore,
  createExecutableRootCapability,
  createFullNetworkCapabilities,
  createWorkspaceCapabilityRequest,
  executableRootForCapability,
  fullNetworkPostureForCapabilities,
  isTrustedWorkspaceCapabilityRequest,
} = require('./workspace-execution/workspace-capabilities');

const FULL_NETWORK_CAPABILITY_KINDS = new Set([
  CAPABILITY_KINDS.NETWORK_PUBLIC,
  CAPABILITY_KINDS.NETWORK_LOOPBACK,
  CAPABILITY_KINDS.NETWORK_PRIVATE,
]);

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_FILE_OPERATION_TIMEOUT_MS = 10_000;
const MAX_COMMAND_LENGTH = 32_000;
const MAX_PERMISSION_COMMAND_LENGTH = 4_096;
const MAX_WORKSPACE_READ_BYTES = 512 * 1024;
const MAX_WORKSPACE_WRITE_BYTES = 64 * 1024;
const MAX_WORKSPACE_PATH_LENGTH = 1_024;
const MAX_WORKSPACE_DIRECTORY_ENTRIES = 500;
const MAX_WORKSPACE_FIND_RESULTS = 1_000;
const MAX_WORKSPACE_GREP_MATCHES = 200;
const MAX_WORKSPACE_SCAN_ENTRIES = 50_000;
const MAX_WORKSPACE_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACE_SEARCH_PATTERN_LENGTH = 1_000;
const WORKSPACE_FILE_HELPER = String.raw`
const fs = require('fs');
const path = require('path');
const READ_LIMIT = 524288;
const WRITE_LIMIT = 65536;
const DIRECTORY_LIMIT = 500;
const FIND_LIMIT = 1000;
const GREP_LIMIT = 200;
const SCAN_ENTRY_LIMIT = 50000;
const SCAN_BYTE_LIMIT = 16777216;
const OUTPUT_LIMIT = 51200;
const PATTERN_LIMIT = 1000;
const LINE_LIMIT = 500;
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
  if (safe === '.') return { safe, target: root };
  const parts = safe.split('/');
  let target = root;
  for (let index = 0; index < parts.length; index += 1) {
    target = path.join(target, parts[index]);
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) fail('WORKSPACE_FILE_UNSAFE');
    if (index < parts.length - 1 && !stats.isDirectory()) fail('WORKSPACE_PATH_TYPE_MISMATCH');
  }
  return { safe, target };
}

function regularFile(target) {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink()) fail('WORKSPACE_FILE_UNSAFE');
  if (!stats.isFile()) fail('WORKSPACE_PATH_TYPE_MISMATCH');
  if (stats.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
  return stats;
}

function directory(target) {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink()) fail('WORKSPACE_FILE_UNSAFE');
  if (!stats.isDirectory()) fail('WORKSPACE_PATH_TYPE_MISMATCH');
  return stats;
}

function optionsPayload() {
  let decoded;
  try {
    const raw = Buffer.from(encoded, 'base64');
    if (raw.byteLength > 8192) fail('INVALID_WORKSPACE_REQUEST');
    decoded = raw.byteLength ? JSON.parse(raw.toString('utf8')) : {};
  } catch (error) {
    if (error && error.code === 'INVALID_WORKSPACE_REQUEST') throw error;
    fail('INVALID_WORKSPACE_REQUEST');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail('INVALID_WORKSPACE_REQUEST');
  return decoded;
}

function boundedInteger(value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) fail('INVALID_WORKSPACE_REQUEST');
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function searchPattern(value) {
  if (typeof value !== 'string' || value.length > PATTERN_LIMIT || value.includes('\0')) fail('INVALID_WORKSPACE_REQUEST');
  return value;
}

function ignoredPath(relativePath) {
  return relativePath.split('/').some((part) => part === '.git' || part === 'node_modules');
}

function boundedDirectoryNames(directoryPath, limit) {
  const names = [];
  const handle = fs.opendirSync(directoryPath);
  try {
    while (names.length <= limit) {
      const entry = handle.readSync();
      if (!entry) break;
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  const limitReached = names.length > limit;
  if (limitReached) names.length = limit;
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { names, limitReached };
}

function matchesGlob(relativePath, pattern) {
  try {
    if (pattern.includes('/')) {
      return path.posix.matchesGlob(relativePath, pattern) || path.posix.matchesGlob(relativePath, '**/' + pattern);
    }
    return path.posix.matchesGlob(path.posix.basename(relativePath), pattern);
  } catch {
    fail('INVALID_WORKSPACE_REQUEST');
  }
}

function walkFiles(relativeRoot, visit) {
  const { target } = targetPath(relativeRoot, true);
  const rootStats = fs.lstatSync(target);
  if (rootStats.isSymbolicLink()) fail('WORKSPACE_FILE_UNSAFE');
  let entriesSeen = 0;
  let bytesRead = 0;
  let scanLimitReached = false;

  const visitFile = (filePath, relativePath, stats) => {
    entriesSeen += 1;
    if (entriesSeen > SCAN_ENTRY_LIMIT) {
      scanLimitReached = true;
      return false;
    }
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > READ_LIMIT) return true;
    if (bytesRead + stats.size > SCAN_BYTE_LIMIT) {
      scanLimitReached = true;
      return false;
    }
    const shouldContinue = visit(filePath, relativePath, stats, () => {
      bytesRead += stats.size;
      return fs.readFileSync(filePath);
    });
    return shouldContinue !== false;
  };

  const walkDirectory = (directoryPath, relativeDirectory) => {
    const remaining = Math.max(1, SCAN_ENTRY_LIMIT - entriesSeen + 1);
    const listing = boundedDirectoryNames(directoryPath, remaining);
    const names = listing.names;
    if (listing.limitReached) scanLimitReached = true;
    for (const name of names) {
      const relativePath = relativeDirectory ? relativeDirectory + '/' + name : name;
      if (ignoredPath(relativePath)) continue;
      entriesSeen += 1;
      if (entriesSeen > SCAN_ENTRY_LIMIT) {
        scanLimitReached = true;
        return false;
      }
      const child = path.join(directoryPath, name);
      let stats;
      try {
        stats = fs.lstatSync(child);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (!walkDirectory(child, relativePath)) return false;
      } else {
        entriesSeen -= 1;
        if (!visitFile(child, relativePath, stats)) return false;
      }
    }
    return true;
  };

  if (rootStats.isDirectory()) walkDirectory(target, '');
  else visitFile(target, path.posix.basename(relativeRoot), rootStats);
  return { scanLimitReached };
}

function boundedLine(value) {
  const normalized = value.replace(/\r/g, '');
  return normalized.length > LINE_LIMIT ? { text: normalized.slice(0, LINE_LIMIT) + '…', truncated: true } : { text: normalized, truncated: false };
}

function boundedOutput(value) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= OUTPUT_LIMIT) return { output: value, truncated: false };
  return { output: buffer.subarray(0, OUTPUT_LIMIT).toString('utf8'), truncated: true };
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function ensureDirectory(relativeDirectory) {
  const safe = checkedRelative(relativeDirectory, true);
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
  } else if (operation === 'list') {
    const requested = optionsPayload();
    const limit = boundedInteger(requested.limit, DIRECTORY_LIMIT, DIRECTORY_LIMIT);
    const { target } = targetPath(relative, true);
    directory(target);
    const listing = boundedDirectoryNames(target, limit);
    const names = listing.names;
    const entries = [];
    for (const name of names) {
      let type = 'other';
      try {
        const stats = fs.lstatSync(path.join(target, name));
        if (stats.isDirectory()) type = 'directory';
        else if (stats.isFile()) type = 'file';
      } catch {
        continue;
      }
      entries.push({ name, type });
    }
    writeJson({ entries, limitReached: listing.limitReached });
  } else if (operation === 'find') {
    const requested = optionsPayload();
    const pattern = searchPattern(requested.pattern);
    const limit = boundedInteger(requested.limit, FIND_LIMIT, FIND_LIMIT);
    const results = [];
    let resultLimitReached = false;
    const scan = walkFiles(relative, (_target, relativePath) => {
      if (!matchesGlob(relativePath, pattern)) return true;
      if (results.length >= limit) {
        resultLimitReached = true;
        return false;
      }
      results.push(relativePath);
      return true;
    });
    writeJson({ results, limitReached: resultLimitReached, scanLimitReached: scan.scanLimitReached });
  } else if (operation === 'grep') {
    const requested = optionsPayload();
    const pattern = searchPattern(requested.pattern);
    const glob = requested.glob === undefined ? null : searchPattern(requested.glob);
    const limit = boundedInteger(requested.limit, 100, GREP_LIMIT);
    const context = requested.context === undefined ? 0 : Math.max(0, Math.min(10, Math.floor(requested.context)));
    if (!Number.isFinite(context)) fail('INVALID_WORKSPACE_REQUEST');
    const literal = requested.literal === true;
    const ignoreCase = requested.ignoreCase === true;
    let matcher;
    if (literal) {
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      matcher = (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
    } else {
      let regex;
      try {
        regex = new RegExp(pattern, ignoreCase ? 'i' : undefined);
      } catch {
        fail('INVALID_WORKSPACE_REQUEST');
      }
      matcher = (line) => regex.test(line);
    }
    const outputLines = [];
    let matchCount = 0;
    let matchLimitReached = false;
    let linesTruncated = false;
    const scan = walkFiles(relative, (_target, relativePath, _stats, read) => {
      if (glob && !matchesGlob(relativePath, glob)) return true;
      const content = read();
      if (content.includes(0)) return true;
      const lines = content.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher(lines[index] || '')) continue;
        matchCount += 1;
        const start = context > 0 ? Math.max(0, index - context) : index;
        const end = context > 0 ? Math.min(lines.length - 1, index + context) : index;
        for (let current = start; current <= end; current += 1) {
          const bounded = boundedLine(lines[current] || '');
          if (bounded.truncated) linesTruncated = true;
          outputLines.push(relativePath + (current === index ? ':' : '-') + (current + 1) + (current === index ? ': ' : '- ') + bounded.text);
        }
        if (matchCount >= limit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    });
    const bounded = boundedOutput(outputLines.join('\n'));
    writeJson({
      output: bounded.output,
      matchCount,
      limitReached: matchLimitReached,
      linesTruncated,
      outputTruncated: bounded.truncated,
      scanLimitReached: scan.scanLimitReached,
    });
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
  const allowed = new Set(['INVALID_WORKSPACE_REQUEST', 'WORKSPACE_FILE_TOO_LARGE', 'WORKSPACE_FILE_UNSAFE', 'WORKSPACE_PATH_TYPE_MISMATCH', 'WORKSPACE_PROTECTED_PATH']);
  const native = new Map([
    ['ENOENT', 'WORKSPACE_PATH_NOT_FOUND'],
    ['ENOTDIR', 'WORKSPACE_PATH_TYPE_MISMATCH'],
    ['EISDIR', 'WORKSPACE_PATH_TYPE_MISMATCH'],
  ]);
  const readOnly = new Set(['read', 'access', 'list', 'find', 'grep']);
  const fallback = readOnly.has(operation) ? 'WORKSPACE_FILE_UNAVAILABLE' : 'WORKSPACE_WRITE_FAILED';
  const code = allowed.has(error && error.code) ? error.code : native.get(error && error.code) || fallback;
  process.stderr.write('FREEDOM_FILE_ERROR:' + code);
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

function workspaceCancelledError() {
  return new ManagedWorkspaceError(
    'WORKSPACE_OPERATION_CANCELLED',
    'The workspace operation was stopped'
  );
}

function throwIfWorkspaceAborted(signal) {
  if (signal?.aborted) throw workspaceCancelledError();
}

function reportWorkspacePhase(request, phase) {
  if (typeof request?.onPhase !== 'function') return;
  try {
    request.onPhase(phase);
  } catch {
    // Workspace authority and execution cannot depend on a progress observer.
  }
}

function awaitWorkspaceStep(value, signal) {
  throwIfWorkspaceAborted(signal);
  if (!signal?.addEventListener) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', abort);
      callback(result);
    };
    const abort = () => finish(reject, workspaceCancelledError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error)
    );
    if (signal.aborted) abort();
  });
}

function workspaceFileErrorMessage(code) {
  return (
    {
      INVALID_WORKSPACE_REQUEST: 'The workspace request is invalid',
      WORKSPACE_FILE_TOO_LARGE: 'The requested workspace file exceeds the supported size limit',
      WORKSPACE_FILE_UNAVAILABLE: 'The requested workspace file could not be accessed',
      WORKSPACE_FILE_UNSAFE: 'The requested workspace path is not a safe regular file or directory',
      WORKSPACE_PATH_NOT_FOUND: 'The requested workspace path does not exist',
      WORKSPACE_PATH_TYPE_MISMATCH: 'The requested workspace path has the wrong file type',
      WORKSPACE_PROTECTED_PATH: 'The requested workspace path is protected',
      WORKSPACE_WRITE_FAILED: 'Freedom could not write the requested workspace file',
    }[code] || 'Freedom could not complete the workspace file operation'
  );
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

function validatePermissionCommand(value) {
  const command = validateCommand(value);
  if (command.length > MAX_PERMISSION_COMMAND_LENGTH) {
    throw new ManagedWorkspaceError(
      'INVALID_EXECUTABLE_REQUEST',
      `Permission-bound commands cannot exceed ${MAX_PERMISSION_COMMAND_LENGTH} characters`
    );
  }
  return command;
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

function validateWorkspaceSearchPattern(value) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_WORKSPACE_SEARCH_PATTERN_LENGTH ||
    value.includes('\0')
  ) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'Search patterns must be bounded text'
    );
  }
  return value;
}

function boundedWorkspaceLimit(value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'Workspace result limits must be finite numbers'
    );
  }
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function encodeWorkspaceHelperOptions(value) {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8');
  if (encoded.byteLength > 8_192) {
    throw new ManagedWorkspaceError(
      'INVALID_WORKSPACE_REQUEST',
      'Workspace discovery options are too large'
    );
  }
  return encoded;
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
    fullNetworkAvailable: Boolean(enforcement.networkFull),
    fullNetworkIncludesHostAbstractUnixSockets:
      enforcement.fullNetworkIncludesHostAbstractUnixSockets === true,
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
    this.restrictPolicy = options.restrictPolicy || restrictWorkspaceExecutionPolicy;
    this.resolveExecutableAccess = options.resolveExecutableAccess || resolveExecutableAccess;
    this.captureHostCommandEnvironment =
      options.captureHostCommandEnvironment || captureHostCommandEnvironment;
    this.executableAccessOptions = options.executableAccessOptions || {};
    this.runtimeOptions = options.runtimeOptions || {};
    this.now = options.now || Date.now;
    this.capabilities = null;
    this.capabilitiesPromise = null;
    this.runtime = null;
    this.runtimePromise = null;
    this.leases = new Map();
    this.leasePromises = new Map();
    this.activeCommands = new Map();
    this.capabilityGrants = options.capabilityGrants || new WorkspaceCapabilityGrantStore();
    this.networkPermissionsEnabled = options.networkPermissionsEnabled === true;
    this.hostCommandEnvironment = null;
    this.hostCommandEnvironmentPromise = null;
  }

  fullNetworkPermissionsEnabled() {
    return this.networkPermissionsEnabled;
  }

  async getCapabilities(request = {}) {
    throwIfWorkspaceAborted(request.signal);
    if (this.capabilities) return this.capabilities;
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = (async () => {
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
      })().finally(() => {
        this.capabilitiesPromise = null;
      });
    }
    return awaitWorkspaceStep(this.capabilitiesPromise, request.signal);
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

  async resolveWorkspacePath(conversationId) {
    const workspace = this.store.getForConversation(conversationId);
    if (!workspace?.enabled) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_EXECUTION_NOT_ENABLED',
        'Managed workspace execution is not enabled for this conversation'
      );
    }
    return Object.freeze({
      workspace,
      path: await this.store.resolvePath(workspace.workspaceId),
    });
  }

  async disclosure(conversationId, request = {}) {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new ManagedWorkspaceError('INVALID_WORKSPACE_REQUEST', 'Conversation ID is required');
    }
    throwIfWorkspaceAborted(request.signal);
    reportWorkspacePhase(request, 'checking_capabilities');
    const capabilities = await this.getCapabilities(request);
    if (!capabilities.available) {
      throw new ManagedWorkspaceError(capabilities.denial.code, capabilities.denial.message);
    }
    reportWorkspacePhase(request, 'checking_runtime');
    await this.#attestedRuntime(request);
    throwIfWorkspaceAborted(request.signal);
    reportWorkspacePhase(request, 'ready_for_approval');
    return capabilities;
  }

  async enable(conversationId, request = {}) {
    const capabilities = request.disclosureVerified
      ? await this.getCapabilities(request)
      : await this.disclosure(conversationId, request);
    reportWorkspacePhase(request, 'creating_workspace');
    const workspace = await awaitWorkspaceStep(
      this.store.ensureForConversation(conversationId),
      request.signal
    );
    reportWorkspacePhase(request, 'validating_boundary');
    await this.#lease(workspace, request);
    throwIfWorkspaceAborted(request.signal);
    reportWorkspacePhase(request, 'enabling_workspace');
    const enabled = this.store.enable(workspace.workspaceId, conversationId, capabilities.backend);
    if (!enabled) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_ENABLE_FAILED',
        'Freedom could not enable the managed workspace'
      );
    }
    reportWorkspacePhase(request, 'workspace_ready');
    return enabled;
  }

  async #attestedRuntime(request = {}) {
    throwIfWorkspaceAborted(request.signal);
    if (this.runtime) return this.runtime;
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        const runtime = await this.detectRuntime(this.runtimeOptions);
        if (!runtime?.available) {
          throw new ManagedWorkspaceError(
            runtime?.denial?.code || 'WORKSPACE_RUNTIME_UNAVAILABLE',
            runtime?.denial?.message || 'Freedom could not verify its sandboxed JavaScript runtime'
          );
        }
        this.runtime = runtime;
        return runtime;
      })().finally(() => {
        this.runtimePromise = null;
      });
    }
    return awaitWorkspaceStep(this.runtimePromise, request.signal);
  }

  async #lease(workspace, request = {}) {
    throwIfWorkspaceAborted(request.signal);
    const existing = this.leases.get(workspace.workspaceId);
    if (existing) return existing;
    let pending = this.leasePromises.get(workspace.workspaceId);
    if (!pending) {
      pending = this.#createLease(workspace).finally(() => {
        this.leasePromises.delete(workspace.workspaceId);
      });
      this.leasePromises.set(workspace.workspaceId, pending);
    }
    return awaitWorkspaceStep(pending, request.signal);
  }

  async #createLease(workspace) {
    const workspaceRoot = await this.store.resolvePath(workspace.workspaceId);
    const runtime = await this.#attestedRuntime();
    const capabilities = await this.getCapabilities();
    const network =
      this.networkPermissionsEnabled && capabilities.fullNetworkAvailable
        ? NETWORK_POSTURES.FULL
        : NETWORK_POSTURES.NONE;
    let policy;
    try {
      const basePolicy = await this.createPolicy({
        workspaceRoot,
        electronRuntime: runtime,
        network,
        environment: {
          set: {
            ELECTRON_RUN_AS_NODE: '1',
          },
        },
        limits: {
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
          stdoutBytes: 1024 * 1024,
          stderrBytes: 1024 * 1024,
        },
      });
      const helperPolicy =
        network === NETWORK_POSTURES.FULL
          ? this.restrictPolicy(basePolicy, { network: NETWORK_POSTURES.NONE })
          : basePolicy;
      const agentPolicy = this.restrictPolicy(helperPolicy, {
        omitRuntimeRootIds: ['electron'],
        omitEnvironmentNames: ['ELECTRON_RUN_AS_NODE'],
      });
      const fullNetworkAgentPolicy =
        network === NETWORK_POSTURES.FULL
          ? this.restrictPolicy(basePolicy, {
              omitRuntimeRootIds: ['electron'],
              omitEnvironmentNames: ['ELECTRON_RUN_AS_NODE'],
            })
          : null;
      policy = { helperPolicy, agentPolicy, fullNetworkAgentPolicy };
    } catch (error) {
      throw new ManagedWorkspaceError(
        typeof error?.code === 'string' ? error.code : 'WORKSPACE_POLICY_FAILED',
        'Freedom could not establish the managed workspace boundary'
      );
    }
    const lease = Object.freeze({ workspaceRoot, runtime, ...policy });
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

  async #enabledLease(conversationId, request = {}) {
    throwIfWorkspaceAborted(request.signal);
    const workspace = this.store.getForConversation(conversationId);
    if (!workspace?.enabled) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_EXECUTION_NOT_ENABLED',
        'The managed workspace has not been enabled for this conversation'
      );
    }
    return { workspace, lease: await this.#lease(workspace, request) };
  }

  async prepareCommandPermissions(conversationId, permissions = {}, request = {}) {
    throwIfWorkspaceAborted(request.signal);
    let prepared;
    let publicNetwork = null;
    let requestedCapabilities;
    try {
      const command = validatePermissionCommand(request.command);
      const capabilities = await this.getCapabilities(request);
      if (!capabilities.available) {
        throw new ManagedWorkspaceError(capabilities.denial.code, capabilities.denial.message);
      }
      const { lease } = await this.#enabledLease(conversationId, request);
      const workingDirectory = await this.#workingDirectory(
        lease,
        request.workingDirectory || '.',
        capabilities.backend
      );
      const executables = permissions.executables ?? [];
      if (!Array.isArray(executables) || executables.length > 16) {
        throw new ManagedWorkspaceError(
          'INVALID_CAPABILITY_REQUEST',
          'Executable permissions must be a short array'
        );
      }
      const requestedNetwork = permissions.network ?? null;
      if (![null, NETWORK_POSTURES.FULL].includes(requestedNetwork)) {
        throw new ManagedWorkspaceError(
          'INVALID_CAPABILITY_REQUEST',
          'The requested network posture is unsupported'
        );
      }
      if (!executables.length && !requestedNetwork) {
        throw new ManagedWorkspaceError(
          'INVALID_CAPABILITY_REQUEST',
          'Request at least one executable or the full network capability'
        );
      }
      let executableAccess = Object.freeze({
        commands: Object.freeze([]),
        runtimeRoots: Object.freeze([]),
      });
      if (executables.length) {
        let hostEnvironment = this.executableAccessOptions.hostEnvironment;
        if (!hostEnvironment && this.resolveExecutableAccess === resolveExecutableAccess) {
          if (!this.hostCommandEnvironment) {
            if (!this.hostCommandEnvironmentPromise) {
              this.hostCommandEnvironmentPromise = this.captureHostCommandEnvironment(
                this.executableAccessOptions
              )
                .then((environment) => {
                  this.hostCommandEnvironment = environment;
                  return environment;
                })
                .finally(() => {
                  this.hostCommandEnvironmentPromise = null;
                });
            }
            await this.hostCommandEnvironmentPromise;
          }
          hostEnvironment = this.hostCommandEnvironment;
        }
        executableAccess = await this.resolveExecutableAccess(executables, {
          ...this.executableAccessOptions,
          ...(hostEnvironment && { hostEnvironment }),
        });
      }
      requestedCapabilities = executableAccess.runtimeRoots.map(createExecutableRootCapability);
      if (requestedNetwork) {
        if (!this.networkPermissionsEnabled || !capabilities.fullNetworkAvailable) {
          throw new ManagedWorkspaceError(
            'NETWORK_PERMISSION_UNAVAILABLE',
            'Experimental direct network permissions are unavailable'
          );
        }
        requestedCapabilities.push(...createFullNetworkCapabilities());
        publicNetwork = Object.freeze({
          posture: NETWORK_POSTURES.FULL,
          publicInternet: true,
          hostLoopback: true,
          privateLan: true,
          hostAbstractUnixSockets: capabilities.fullNetworkIncludesHostAbstractUnixSockets
            ? 'reachable'
            : 'denied',
        });
      }
      const capabilityRequest = requestedCapabilities.length
        ? createWorkspaceCapabilityRequest({
            conversationId,
            command,
            workingDirectory: workingDirectory.relative,
            capabilities: requestedCapabilities,
          })
        : null;
      prepared = Object.freeze({
        kind: 'freedom.command-permissions',
        executableAccess,
        capabilityRequest,
        command,
        workingDirectory: workingDirectory.relative,
        network: requestedNetwork,
      });
    } catch (error) {
      throw new ManagedWorkspaceError(
        typeof error?.code === 'string' ? error.code : 'COMMAND_PERMISSION_PREPARATION_FAILED',
        typeof error?.message === 'string'
          ? error.message
          : 'Freedom could not prepare the requested command permissions'
      );
    }
    return Object.freeze({
      prepared,
      publicRequest: Object.freeze({
        kind: 'command_access',
        command: prepared.command,
        workingDirectory: prepared.workingDirectory,
        commands: prepared.executableAccess.commands,
        ...(publicNetwork && { network: publicNetwork }),
      }),
      approvalRequired: requestedCapabilities.length > 0,
      unavailable: Object.freeze(
        prepared.executableAccess.commands
          .filter((command) => command.status === 'unavailable')
          .map((command) => command.name)
      ),
      available: Object.freeze(
        prepared.executableAccess.commands
          .filter((command) => command.status !== 'unavailable')
          .map((command) => command.name)
      ),
    });
  }

  async prepareExecutableAccess(conversationId, executables, request = {}) {
    return this.prepareCommandPermissions(conversationId, { executables }, request);
  }

  grantCommandPermissions(conversationId, prepared, scope = 'once') {
    const workspace = this.store.getForConversation(conversationId);
    const executableAccess = prepared?.executableAccess;
    if (
      typeof conversationId !== 'string' ||
      !conversationId ||
      !workspace?.enabled ||
      prepared?.kind !== 'freedom.command-permissions' ||
      !executableAccess ||
      !Array.isArray(executableAccess.commands) ||
      (executableAccess.commands.length > 0 &&
        !isValidatedExecutableAccessRequest(executableAccess)) ||
      !isTrustedWorkspaceCapabilityRequest(prepared.capabilityRequest) ||
      !['once', 'conversation'].includes(scope)
    ) {
      throw new ManagedWorkspaceError(
        'INVALID_COMMAND_PERMISSION_GRANT',
        'Freedom refused an invalid command permission grant'
      );
    }
    try {
      this.capabilityGrants.grant(conversationId, prepared.capabilityRequest, scope);
    } catch {
      throw new ManagedWorkspaceError(
        'INVALID_COMMAND_PERMISSION_GRANT',
        'Freedom refused an invalid command permission grant'
      );
    }
    return Object.freeze({
      scope,
      commands: Object.freeze(
        prepared.executableAccess.commands
          .filter((command) => command.status !== 'unavailable')
          .map((command) => command.name)
      ),
      command: prepared.command,
      workingDirectory: prepared.workingDirectory,
      ...(prepared.network && { network: prepared.network }),
    });
  }

  grantExecutableAccess(conversationId, prepared, scope = 'once') {
    return this.grantCommandPermissions(conversationId, prepared, scope);
  }

  clearTurnPermissions(conversationId) {
    return this.capabilityGrants.clearOnce(conversationId);
  }

  #agentPolicy(conversationId, lease, command, workingDirectory) {
    const capabilities = this.capabilityGrants.resolve(conversationId, {
      command,
      workingDirectory,
    });
    const roots = capabilities.map(executableRootForCapability).filter(Boolean);
    let network;
    try {
      network = fullNetworkPostureForCapabilities(capabilities);
    } catch (error) {
      throw new ManagedWorkspaceError(
        typeof error?.code === 'string' ? error.code : 'UNSUPPORTED_WORKSPACE_CAPABILITY',
        'Freedom refused an unsupported workspace capability combination'
      );
    }
    for (const capability of capabilities) {
      if (
        !executableRootForCapability(capability) &&
        !FULL_NETWORK_CAPABILITY_KINDS.has(capability.kind)
      ) {
        throw new ManagedWorkspaceError(
          'UNSUPPORTED_WORKSPACE_CAPABILITY',
          'Freedom refused a workspace capability without a qualified enforcement adapter'
        );
      }
    }
    const basePolicy = network ? lease.fullNetworkAgentPolicy : lease.agentPolicy;
    if (!basePolicy) {
      throw new ManagedWorkspaceError(
        'UNSUPPORTED_WORKSPACE_CAPABILITY',
        'Freedom refused unavailable direct network authority'
      );
    }
    if (!roots.length) return basePolicy;
    const unique = [...new Map(roots.map((root) => [root.id, root])).values()];
    return this.restrictPolicy(basePolicy, { addRuntimeRoots: unique });
  }

  async #fileOperation(conversationId, operation, relativePath, content = null, request = {}) {
    const readOnlyOperations = new Set(['access', 'read', 'list', 'find', 'grep']);
    const rootOperations = new Set(['list', 'find', 'grep']);
    const relative =
      operation === 'mkdir'
        ? relativePath === '.'
          ? '.'
          : assertWritableWorkspacePath(relativePath)
        : operation === 'write'
          ? assertWritableWorkspacePath(relativePath)
          : validateWorkspacePath(relativePath, { allowRoot: rootOperations.has(operation) });
    const capabilities = await this.getCapabilities(request);
    if (!capabilities.available) {
      throw new ManagedWorkspaceError(capabilities.denial.code, capabilities.denial.message);
    }
    const { lease } = await this.#enabledLease(conversationId, request);
    reportWorkspacePhase(request, 'executing_operation');
    const executionRoot =
      capabilities.backend === 'linux-bubblewrap' ? '/workspace' : lease.workspaceRoot;
    const controller = new AbortController();
    const externalSignal = request.signal;
    const abort = () => controller.abort();
    externalSignal?.addEventListener?.('abort', abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const activeToken = {};
    const timeout = setTimeout(() => controller.abort(), DEFAULT_FILE_OPERATION_TIMEOUT_MS);
    this.activeCommands.set(activeToken, { conversationId, controller });
    let receipt;
    try {
      receipt = await this.executor.execute(lease.helperPolicy, {
        command: '/bin/sh',
        args: [
          '-c',
          'cd "$1" && exec "$2" -e "$3" "$4" "$5" "$6"',
          'freedom-workspace-file',
          executionRoot,
          lease.runtime.sandboxExecutablePath,
          WORKSPACE_FILE_HELPER,
          operation,
          relative,
          content ? content.toString('base64') : '',
        ],
        signal: controller.signal,
      });
    } catch {
      throw new ManagedWorkspaceError(
        readOnlyOperations.has(operation) ? 'WORKSPACE_FILE_UNAVAILABLE' : 'WORKSPACE_WRITE_FAILED',
        'Freedom could not complete the workspace file operation'
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.('abort', abort);
      this.activeCommands.delete(activeToken);
    }
    if (receipt.state !== EXECUTION_STATES.COMPLETED || receipt.exitCode !== 0) {
      if (externalSignal?.aborted || receipt.state === EXECUTION_STATES.CANCELLED) {
        throw workspaceCancelledError();
      }
      const reported = /FREEDOM_FILE_ERROR:([A-Z0-9_]{1,120})/.exec(receipt.stderr || '')?.[1];
      const allowed = new Set([
        'INVALID_WORKSPACE_REQUEST',
        'WORKSPACE_FILE_TOO_LARGE',
        'WORKSPACE_FILE_UNAVAILABLE',
        'WORKSPACE_FILE_UNSAFE',
        'WORKSPACE_PATH_NOT_FOUND',
        'WORKSPACE_PATH_TYPE_MISMATCH',
        'WORKSPACE_PROTECTED_PATH',
        'WORKSPACE_WRITE_FAILED',
      ]);
      const code = allowed.has(reported)
        ? reported
        : readOnlyOperations.has(operation)
          ? 'WORKSPACE_FILE_UNAVAILABLE'
          : 'WORKSPACE_WRITE_FAILED';
      throw new ManagedWorkspaceError(code, workspaceFileErrorMessage(code));
    }
    if (receipt.stdoutTruncated) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_FILE_TOO_LARGE',
        `Workspace reads are limited to ${MAX_WORKSPACE_READ_BYTES} bytes`
      );
    }
    return Buffer.from(receipt.stdout || '', 'utf8');
  }

  async #structuredFileOperation(conversationId, operation, relativePath, options, request = {}) {
    const output = await this.#fileOperation(
      conversationId,
      operation,
      relativePath,
      encodeWorkspaceHelperOptions(options),
      request
    );
    try {
      const parsed = JSON.parse(output.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new ManagedWorkspaceError(
        'WORKSPACE_FILE_UNAVAILABLE',
        'Freedom received an invalid workspace discovery result'
      );
    }
  }

  async accessFile(conversationId, relativePath, request = {}) {
    await this.#fileOperation(conversationId, 'access', relativePath, null, request);
  }

  async readFile(conversationId, relativePath, request = {}) {
    return this.#fileOperation(conversationId, 'read', relativePath, null, request);
  }

  async createDirectory(conversationId, relativePath, request = {}) {
    await this.#fileOperation(conversationId, 'mkdir', relativePath, null, request);
  }

  async writeFile(conversationId, relativePath, content, request = {}) {
    const buffer = validateWorkspaceContent(content);
    await this.#fileOperation(conversationId, 'write', relativePath, buffer, request);
  }

  async listDirectory(conversationId, relativePath = '.', options = {}) {
    const limit = boundedWorkspaceLimit(
      options.limit,
      MAX_WORKSPACE_DIRECTORY_ENTRIES,
      MAX_WORKSPACE_DIRECTORY_ENTRIES
    );
    const result = await this.#structuredFileOperation(
      conversationId,
      'list',
      relativePath,
      { limit },
      options
    );
    if (!Array.isArray(result.entries)) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_FILE_UNAVAILABLE',
        'Freedom received an invalid directory listing'
      );
    }
    return Object.freeze({
      entries: Object.freeze(
        result.entries
          .filter(
            (entry) =>
              entry &&
              typeof entry.name === 'string' &&
              entry.name.length <= 1_024 &&
              ['directory', 'file', 'other'].includes(entry.type)
          )
          .slice(0, limit)
          .map((entry) => Object.freeze({ name: entry.name, type: entry.type }))
      ),
      limitReached: result.limitReached === true,
    });
  }

  async findFiles(conversationId, relativePath = '.', options = {}) {
    const pattern = validateWorkspaceSearchPattern(options.pattern);
    const limit = boundedWorkspaceLimit(
      options.limit,
      MAX_WORKSPACE_FIND_RESULTS,
      MAX_WORKSPACE_FIND_RESULTS
    );
    const result = await this.#structuredFileOperation(
      conversationId,
      'find',
      relativePath,
      { pattern, limit },
      options
    );
    if (!Array.isArray(result.results)) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_FILE_UNAVAILABLE',
        'Freedom received an invalid file-search result'
      );
    }
    return Object.freeze({
      results: Object.freeze(
        result.results
          .filter((entry) => typeof entry === 'string' && entry.length <= 1_024)
          .slice(0, limit)
      ),
      limitReached: result.limitReached === true,
      scanLimitReached: result.scanLimitReached === true,
    });
  }

  async grepFiles(conversationId, relativePath = '.', options = {}) {
    const pattern = validateWorkspaceSearchPattern(options.pattern);
    const glob =
      options.glob === undefined ? undefined : validateWorkspaceSearchPattern(options.glob);
    const limit = boundedWorkspaceLimit(options.limit, 100, MAX_WORKSPACE_GREP_MATCHES);
    const context = Number.isFinite(options.context)
      ? Math.max(0, Math.min(10, Math.floor(options.context)))
      : 0;
    const result = await this.#structuredFileOperation(
      conversationId,
      'grep',
      relativePath,
      {
        pattern,
        ...(glob !== undefined && { glob }),
        ignoreCase: options.ignoreCase === true,
        literal: options.literal === true,
        context,
        limit,
      },
      options
    );
    if (typeof result.output !== 'string' || !Number.isFinite(result.matchCount)) {
      throw new ManagedWorkspaceError(
        'WORKSPACE_FILE_UNAVAILABLE',
        'Freedom received an invalid content-search result'
      );
    }
    return Object.freeze({
      output: result.output.slice(0, 52 * 1_024),
      matchCount: Math.max(0, Math.floor(result.matchCount)),
      limitReached: result.limitReached === true,
      linesTruncated: result.linesTruncated === true,
      outputTruncated: result.outputTruncated === true,
      scanLimitReached: result.scanLimitReached === true,
    });
  }

  async execute(conversationId, request = {}) {
    const { workspace, lease } = await this.#enabledLease(conversationId, request);
    const command = validateCommand(request.command);
    const capabilities = await this.getCapabilities(request);
    if (!capabilities.available) {
      throw new ManagedWorkspaceError(capabilities.denial.code, capabilities.denial.message);
    }
    const workingDirectory = await this.#workingDirectory(
      lease,
      request.workingDirectory || '.',
      capabilities.backend
    );
    throwIfWorkspaceAborted(request.signal);
    const agentPolicy = this.#agentPolicy(
      conversationId,
      lease,
      command,
      workingDirectory.relative
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
      receipt = await this.executor.execute(agentPolicy, {
        command: '/bin/sh',
        args: [
          '-c',
          'cd "$1" && exec /bin/sh -c "$2"',
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
        state: EXECUTION_STATES.FAILED,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        terminationGuarantee: 'unknown',
        sideEffects: 'unknown',
        survivorsPossible: true,
        completeDescendantTermination: false,
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
    this.leasePromises.delete(workspace.workspaceId);
    this.capabilityGrants.deleteConversation(conversationId);
    return this.store.deleteConversation(conversationId);
  }

  dispose() {
    for (const active of this.activeCommands.values()) active.controller.abort();
    this.activeCommands.clear();
    this.leases.clear();
    this.leasePromises.clear();
    this.capabilityGrants.clear();
  }
}

module.exports = {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_FILE_OPERATION_TIMEOUT_MS,
  MAX_COMMAND_LENGTH,
  MAX_PERMISSION_COMMAND_LENGTH,
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  MAX_WORKSPACE_FIND_RESULTS,
  MAX_WORKSPACE_GREP_MATCHES,
  MAX_WORKSPACE_READ_BYTES,
  MAX_WORKSPACE_SCAN_BYTES,
  MAX_WORKSPACE_SCAN_ENTRIES,
  MAX_WORKSPACE_SEARCH_PATTERN_LENGTH,
  MAX_WORKSPACE_WRITE_BYTES,
  WORKSPACE_FILE_HELPER,
  ManagedWorkspaceController,
  ManagedWorkspaceError,
  commandSummary,
  publicCapabilities,
  safeReceiptError,
  validateCommand,
  validatePermissionCommand,
  validateWorkspaceSearchPattern,
  validateWorkspacePath,
  validateWorkingDirectory,
};
