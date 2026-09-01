'use strict';

const fs = require('fs');
const path = require('path');

const POLICY_VERSION = 1;
const WORKSPACE_MOUNT_PATH = '/workspace';
const PRIVATE_TEMP_PATH = '/tmp';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_PROTECTED_PATHS = Object.freeze(['.git']);
const NETWORK_POSTURES = Object.freeze({
  NONE: 'none',
  BROKERED: 'brokered',
});
const EXECUTION_STATES = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  SANDBOX_DENIED: 'sandbox_denied',
});
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  'BASH_ENV',
  'CDPATH',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'ENV',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_EXEC_PATH',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
  'HOME',
  'HOSTALIASES',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PERL5LIB',
  'PERLLIB',
  'PROMPT_COMMAND',
  'PYTHONHOME',
  'PYTHONPATH',
  'RUBYLIB',
  'SHELLOPTS',
  'SSH_AUTH_SOCK',
  'TMP',
  'TMPDIR',
  'TEMP',
  'XAUTHORITY',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
]);
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:^|_)(?:AUTH|COOKIE|CREDENTIAL|KEY|PASS(?:WORD)?|SECRET|SESSION|TOKEN)(?:_|$)/i;
const SAFE_DEFAULT_INHERITANCE = Object.freeze([
  'COLORTERM',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'TERM',
  'TZ',
]);

class ExecutionPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExecutionPolicyError';
    this.code = code;
    this.details = details;
  }
}

function insidePath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requirePlainObject(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutionPolicyError('INVALID_POLICY', `${label} must be an object`);
  }
  return value;
}

function requireBoundedInteger(value, label, minimum, maximum, fallback) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      `${label} must be an integer between ${minimum} and ${maximum}`,
      { field: label }
    );
  }
  return selected;
}

function validateWorkspaceRelativePath(value, label, { allowDot = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) {
    throw new ExecutionPolicyError('INVALID_POLICY', `${label} must be a safe relative path`);
  }
  if (allowDot && value === '.') return value;
  if (!value || path.isAbsolute(value)) {
    throw new ExecutionPolicyError('INVALID_POLICY', `${label} must be a safe relative path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ExecutionPolicyError('INVALID_POLICY', `${label} must be a safe relative path`);
  }
  return value;
}

function validateEnvironmentName(name) {
  if (
    typeof name !== 'string' ||
    !ENVIRONMENT_NAME.test(name) ||
    FORBIDDEN_ENVIRONMENT_NAMES.has(name) ||
    SENSITIVE_ENVIRONMENT_NAME.test(name)
  ) {
    throw new ExecutionPolicyError(
      'UNSAFE_ENVIRONMENT',
      `Environment variable ${String(name)} is not eligible for sandbox inheritance`,
      { name: String(name) }
    );
  }
  return name;
}

function resolveEnvironment(environment, hostEnvironment) {
  const requested = requirePlainObject(environment, 'environment');
  const inherit = requested.inherit === undefined ? SAFE_DEFAULT_INHERITANCE : requested.inherit;
  if (!Array.isArray(inherit) || inherit.length > 64) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'environment.inherit must be a short array');
  }
  const values = {};
  for (const name of inherit) {
    validateEnvironmentName(name);
    const value = hostEnvironment[name];
    if (typeof value === 'string' && value.length <= 16_384) values[name] = value;
  }
  const explicit = requirePlainObject(requested.set, 'environment.set');
  if (Object.keys(explicit).length > 64) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'environment.set has too many entries');
  }
  for (const [name, value] of Object.entries(explicit)) {
    validateEnvironmentName(name);
    if (typeof value !== 'string' || value.length > 16_384 || value.includes('\0')) {
      throw new ExecutionPolicyError(
        'INVALID_POLICY',
        `Environment variable ${name} must have a bounded string value`
      );
    }
    values[name] = value;
  }
  return Object.freeze(values);
}

async function canonicalDirectory(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    throw new ExecutionPolicyError('INVALID_WORKSPACE', `${label} must be an absolute path`);
  }
  let canonical;
  let stats;
  try {
    canonical = await fs.promises.realpath(input);
    stats = await fs.promises.stat(canonical);
  } catch (error) {
    throw new ExecutionPolicyError('INVALID_WORKSPACE', `${label} is not accessible`, {
      cause: error.code,
    });
  }
  if (!stats.isDirectory()) {
    throw new ExecutionPolicyError('INVALID_WORKSPACE', `${label} must be a directory`);
  }
  if (canonical === path.parse(canonical).root) {
    throw new ExecutionPolicyError('INVALID_WORKSPACE', `${label} cannot be a filesystem root`);
  }
  return canonical;
}

async function validateGitConfiguration(gitDirectory) {
  for (const filename of ['config', 'config.worktree']) {
    const configPath = path.join(gitDirectory, filename);
    let config;
    try {
      const stats = await fs.promises.stat(configPath);
      if (!stats.isFile() || stats.size > 1024 * 1024) {
        throw new ExecutionPolicyError(
          'UNSAFE_GIT_CONFIGURATION',
          'Git configuration must be a bounded regular file'
        );
      }
      config = await fs.promises.readFile(configPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    let section = '';
    for (const rawLine of config.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const sectionMatch = /^\[([^\s\]"]+)/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1].toLowerCase();
        if (section === 'credential' || section === 'include' || section === 'includeif') {
          throw new ExecutionPolicyError(
            'UNSAFE_GIT_CONFIGURATION',
            `Git ${section} configuration is not allowed in a sandbox workspace`
          );
        }
        continue;
      }
      const assignment = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
      if (!assignment) continue;
      const key = assignment[1].toLowerCase();
      const value = assignment[2].trim();
      if (
        (section === 'http' && ['cookiefile', 'extraheader', 'sslkey'].includes(key)) ||
        (section === 'core' && key === 'hookspath')
      ) {
        throw new ExecutionPolicyError(
          'UNSAFE_GIT_CONFIGURATION',
          `Git ${section}.${key} configuration is not allowed in a sandbox workspace`
        );
      }
      if ((key === 'url' || key === 'pushurl') && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        let remote;
        try {
          remote = new URL(value);
        } catch {
          throw new ExecutionPolicyError('UNSAFE_GIT_CONFIGURATION', 'Git remote URL is malformed');
        }
        if (remote.username || remote.password) {
          throw new ExecutionPolicyError(
            'UNSAFE_GIT_CONFIGURATION',
            'Git remote URLs must not contain embedded credentials'
          );
        }
      }
    }
  }
}

async function resolveGitMetadata(workspaceRoot, relativePath) {
  const candidate = path.join(workspaceRoot, relativePath);
  let entry;
  try {
    entry = await fs.promises.lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ExecutionPolicyError(
        'PROTECTED_PATH_MISSING',
        `${relativePath} must exist before the writable workspace can be sandboxed`,
        { relativePath }
      );
    }
    throw error;
  }
  if (entry.isSymbolicLink()) {
    throw new ExecutionPolicyError(
      'AMBIGUOUS_PROTECTED_PATH',
      `${relativePath} cannot be a symbolic link`,
      { relativePath }
    );
  }
  if (entry.isDirectory()) {
    const sourcePath = await fs.promises.realpath(candidate);
    if (!insidePath(workspaceRoot, sourcePath)) {
      throw new ExecutionPolicyError(
        'AMBIGUOUS_PROTECTED_PATH',
        `${relativePath} resolved outside the workspace unexpectedly`,
        { relativePath }
      );
    }
    await validateGitConfiguration(sourcePath);
    return Object.freeze({
      relativePath,
      access: 'read_only',
      kind: 'directory',
      sourcePath,
      mountPath: path.posix.join(WORKSPACE_MOUNT_PATH, relativePath),
    });
  }
  if (!entry.isFile() || entry.size > 4_096) {
    throw new ExecutionPolicyError(
      'AMBIGUOUS_PROTECTED_PATH',
      `${relativePath} must be a Git directory or pointer file`,
      { relativePath }
    );
  }
  const pointer = await fs.promises.readFile(candidate, 'utf8');
  const match = /^gitdir:\s*([^\r\n]+)\s*$/i.exec(pointer);
  if (!match) {
    throw new ExecutionPolicyError(
      'AMBIGUOUS_PROTECTED_PATH',
      `${relativePath} is not a valid Git metadata pointer`,
      { relativePath }
    );
  }
  const unresolvedGitDirectory = path.resolve(workspaceRoot, match[1]);
  const gitDirectory = await canonicalDirectory(unresolvedGitDirectory, 'Git metadata directory');
  let commonDirectory = gitDirectory;
  const commonPointer = path.join(gitDirectory, 'commondir');
  let hasCommonDirectoryPointer = false;
  try {
    const commonStats = await fs.promises.lstat(commonPointer);
    if (!commonStats.isFile() || commonStats.isSymbolicLink() || commonStats.size > 4_096) {
      throw new ExecutionPolicyError(
        'AMBIGUOUS_PROTECTED_PATH',
        'Git commondir metadata must be a bounded regular file'
      );
    }
    hasCommonDirectoryPointer = true;
    const commonValue = (await fs.promises.readFile(commonPointer, 'utf8')).trim();
    if (!commonValue || commonValue.includes('\0')) {
      throw new ExecutionPolicyError(
        'AMBIGUOUS_PROTECTED_PATH',
        'Git commondir metadata is malformed'
      );
    }
    commonDirectory = await canonicalDirectory(
      path.resolve(gitDirectory, commonValue),
      'Git common metadata directory'
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const gitDirectoryPointer = path.join(gitDirectory, 'gitdir');
  let hasGitDirectoryPointer = false;
  try {
    const pointerStats = await fs.promises.lstat(gitDirectoryPointer);
    if (!pointerStats.isFile() || pointerStats.isSymbolicLink() || pointerStats.size > 4_096) {
      throw new ExecutionPolicyError(
        'AMBIGUOUS_PROTECTED_PATH',
        'Git worktree metadata pointer must be a bounded regular file'
      );
    }
    hasGitDirectoryPointer = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await validateGitConfiguration(commonDirectory);
  return Object.freeze({
    relativePath,
    access: 'read_only',
    kind: 'git_pointer',
    sourcePath: candidate,
    gitDirectory,
    commonDirectory,
    hasCommonDirectoryPointer,
    hasGitDirectoryPointer,
    mountPath: path.posix.join(WORKSPACE_MOUNT_PATH, relativePath),
  });
}

async function resolveProtectedPath(workspaceRoot, relativePath) {
  if (relativePath === '.git') return resolveGitMetadata(workspaceRoot, relativePath);
  const candidate = path.join(workspaceRoot, relativePath);
  let entry;
  try {
    entry = await fs.promises.lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ExecutionPolicyError(
        'PROTECTED_PATH_MISSING',
        `${relativePath} must exist before the writable workspace can be sandboxed`,
        { relativePath }
      );
    }
    throw error;
  }
  if (entry.isSymbolicLink()) {
    throw new ExecutionPolicyError(
      'AMBIGUOUS_PROTECTED_PATH',
      `${relativePath} cannot be a symbolic link`,
      { relativePath }
    );
  }
  const sourcePath = await fs.promises.realpath(candidate);
  if (!insidePath(workspaceRoot, sourcePath)) {
    throw new ExecutionPolicyError(
      'AMBIGUOUS_PROTECTED_PATH',
      `${relativePath} resolves outside the workspace`,
      { relativePath }
    );
  }
  return Object.freeze({
    relativePath,
    access: 'read_only',
    kind: entry.isDirectory() ? 'directory' : 'file',
    sourcePath,
    mountPath: path.posix.join(WORKSPACE_MOUNT_PATH, relativePath),
  });
}

async function rejectWritableHardlinks(workspaceRoot, protectedPaths) {
  const protectedPrefixes = protectedPaths.map((value) => `${value}/`);
  const directories = [workspaceRoot];
  let inspectedEntries = 0;
  while (directories.length) {
    const directory = directories.pop();
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      inspectedEntries += 1;
      if (inspectedEntries > 500_000) {
        throw new ExecutionPolicyError(
          'WORKSPACE_VALIDATION_LIMIT',
          'Workspace contains too many entries for safe hardlink validation'
        );
      }
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(workspaceRoot, candidate).split(path.sep).join('/');
      if (
        protectedPaths.includes(relative) ||
        protectedPrefixes.some((prefix) => relative.startsWith(prefix))
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        directories.push(candidate);
        continue;
      }
      if (!entry.isFile()) {
        throw new ExecutionPolicyError(
          'WORKSPACE_SPECIAL_FILE_DENIED',
          'Writable workspaces must not contain sockets, devices, or other special files',
          { relativePath: relative }
        );
      }
      const stats = await fs.promises.lstat(candidate);
      if (stats.nlink > 1) {
        throw new ExecutionPolicyError(
          'WORKSPACE_HARDLINK_DENIED',
          'Writable workspace files must not have additional hard links',
          { relativePath: relative }
        );
      }
    }
  }
}

function resolveAggregateLimits(limits) {
  const aggregate = requirePlainObject(limits.aggregate, 'limits.aggregate');
  const fields = ['cpuTimeMs', 'fileSizeBytes', 'memoryBytes', 'processCount'];
  const normalized = {};
  for (const field of fields) {
    const value = aggregate[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new ExecutionPolicyError(
        'INVALID_POLICY',
        `limits.aggregate.${field} must be a positive integer`
      );
    }
    normalized[field] = value ?? null;
  }
  normalized.required = aggregate.required === true;
  return Object.freeze(normalized);
}

function inferNodeRuntimeRoot(execPath = process.execPath) {
  if (typeof execPath !== 'string') return null;
  const real = fs.realpathSync.native?.(execPath) || fs.realpathSync(execPath);
  if (path.basename(real) !== 'node' || path.basename(path.dirname(real)) !== 'bin') return null;
  if (insidePath('/usr', real) || insidePath('/bin', real)) return null;
  return path.dirname(path.dirname(real));
}

async function createWorkspaceExecutionPolicy(options = {}) {
  const workspaceRoot = await canonicalDirectory(options.workspaceRoot, 'workspaceRoot');
  const workingDirectory = validateWorkspaceRelativePath(
    options.workingDirectory ?? '.',
    'workingDirectory',
    { allowDot: true }
  );
  const workingHostPath = path.resolve(workspaceRoot, workingDirectory);
  let canonicalWorkingDirectory;
  try {
    canonicalWorkingDirectory = await fs.promises.realpath(workingHostPath);
  } catch (error) {
    throw new ExecutionPolicyError('INVALID_WORKSPACE', 'workingDirectory must exist', {
      cause: error.code,
    });
  }
  if (!insidePath(workspaceRoot, canonicalWorkingDirectory)) {
    throw new ExecutionPolicyError(
      'INVALID_WORKSPACE',
      'workingDirectory must resolve inside the workspace'
    );
  }
  const workingStats = await fs.promises.stat(canonicalWorkingDirectory);
  if (!workingStats.isDirectory()) {
    throw new ExecutionPolicyError('INVALID_WORKSPACE', 'workingDirectory must be a directory');
  }

  const protectedInput = options.protectedWorkspacePaths ?? DEFAULT_PROTECTED_PATHS;
  if (!Array.isArray(protectedInput) || protectedInput.length > 32) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      'protectedWorkspacePaths must be a short array'
    );
  }
  const protectedWorkspacePaths = [
    ...new Set(
      protectedInput.map((value) =>
        validateWorkspaceRelativePath(value, 'protectedWorkspacePaths entry')
      )
    ),
  ].sort();
  for (let index = 0; index < protectedWorkspacePaths.length; index += 1) {
    const candidate = protectedWorkspacePaths[index];
    if (
      protectedWorkspacePaths.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (candidate.startsWith(`${other}/`) || other.startsWith(`${candidate}/`))
      )
    ) {
      throw new ExecutionPolicyError(
        'AMBIGUOUS_PROTECTED_PATH',
        'Nested protected workspace paths are not supported',
        { relativePath: candidate }
      );
    }
  }
  const protectedPaths = [];
  for (const relativePath of protectedWorkspacePaths) {
    protectedPaths.push(await resolveProtectedPath(workspaceRoot, relativePath));
  }
  if (options.rejectWritableHardlinks !== false) {
    await rejectWritableHardlinks(workspaceRoot, protectedWorkspacePaths);
  }

  const limitsInput = requirePlainObject(options.limits, 'limits');
  const timeoutMs = requireBoundedInteger(
    limitsInput.timeoutMs,
    'limits.timeoutMs',
    1,
    MAX_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  const stdoutBytes = requireBoundedInteger(
    limitsInput.stdoutBytes,
    'limits.stdoutBytes',
    1,
    MAX_OUTPUT_BYTES,
    DEFAULT_OUTPUT_BYTES
  );
  const stderrBytes = requireBoundedInteger(
    limitsInput.stderrBytes,
    'limits.stderrBytes',
    1,
    MAX_OUTPUT_BYTES,
    DEFAULT_OUTPUT_BYTES
  );
  const network = options.network ?? NETWORK_POSTURES.NONE;
  if (!Object.values(NETWORK_POSTURES).includes(network)) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'network posture is not recognized');
  }

  const runtimeRoots = [];
  const nodeRuntimeRoot = options.nodeRuntimeRoot ?? inferNodeRuntimeRoot();
  if (nodeRuntimeRoot) {
    runtimeRoots.push(
      Object.freeze({
        id: 'node',
        sourcePath: await canonicalDirectory(nodeRuntimeRoot, 'nodeRuntimeRoot'),
        mountPath: '/opt/freedom-toolchain/node',
        access: 'read_only',
      })
    );
  }

  return Object.freeze({
    kind: 'freedom.workspace-execution-policy',
    version: POLICY_VERSION,
    filesystem: Object.freeze({
      readableRoots: Object.freeze([
        Object.freeze({
          id: 'workspace',
          sourcePath: workspaceRoot,
          mountPath: WORKSPACE_MOUNT_PATH,
        }),
      ]),
      writableRoots: Object.freeze([
        Object.freeze({
          id: 'workspace',
          sourcePath: workspaceRoot,
          mountPath: WORKSPACE_MOUNT_PATH,
        }),
      ]),
      protectedPaths: Object.freeze(protectedPaths),
      privateTemporaryStorage: Object.freeze({
        mountPath: PRIVATE_TEMP_PATH,
        lifecycle: 'execution',
      }),
      exposeSystemToolchain: options.exposeSystemToolchain !== false,
      runtimeRoots: Object.freeze(runtimeRoots),
    }),
    workingDirectory: path.posix.join(
      WORKSPACE_MOUNT_PATH,
      workingDirectory === '.' ? '' : workingDirectory
    ),
    environment: Object.freeze({
      inherit: Object.freeze([...(options.environment?.inherit ?? SAFE_DEFAULT_INHERITANCE)]),
      values: resolveEnvironment(options.environment, options.hostEnvironment || process.env),
      sensitiveValuesScrubbed: true,
    }),
    network,
    limits: Object.freeze({
      timeoutMs,
      stdoutBytes,
      stderrBytes,
      aggregate: resolveAggregateLimits(limitsInput),
    }),
    cancellation: Object.freeze({ supported: true, scope: 'descendant_tree' }),
    seccomp: Object.freeze({ requireCustomFilter: options.requireCustomSeccomp === true }),
  });
}

function validateExecutionRequest(request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ExecutionPolicyError('INVALID_REQUEST', 'Execution request must be an object');
  }
  if (
    typeof request.command !== 'string' ||
    !request.command ||
    request.command.length > 4_096 ||
    request.command.includes('\0')
  ) {
    throw new ExecutionPolicyError('INVALID_REQUEST', 'command must be a bounded string');
  }
  const args = request.args ?? [];
  if (!Array.isArray(args) || args.length > 256) {
    throw new ExecutionPolicyError('INVALID_REQUEST', 'args must be a short array');
  }
  let argumentBytes = 0;
  const normalizedArgs = args.map((value) => {
    if (typeof value !== 'string' || value.includes('\0') || value.length > 65_536) {
      throw new ExecutionPolicyError(
        'INVALID_REQUEST',
        'Every command argument must be bounded text'
      );
    }
    argumentBytes += Buffer.byteLength(value);
    return value;
  });
  if (argumentBytes > 1024 * 1024) {
    throw new ExecutionPolicyError('INVALID_REQUEST', 'Command arguments exceed the request limit');
  }
  if (request.signal !== undefined && typeof request.signal?.addEventListener !== 'function') {
    throw new ExecutionPolicyError('INVALID_REQUEST', 'signal must be an AbortSignal');
  }
  return Object.freeze({
    command: request.command,
    args: Object.freeze(normalizedArgs),
    signal: request.signal,
  });
}

module.exports = {
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_TIMEOUT_MS,
  EXECUTION_STATES,
  ExecutionPolicyError,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  NETWORK_POSTURES,
  POLICY_VERSION,
  PRIVATE_TEMP_PATH,
  SAFE_DEFAULT_INHERITANCE,
  WORKSPACE_MOUNT_PATH,
  createWorkspaceExecutionPolicy,
  inferNodeRuntimeRoot,
  insidePath,
  validateEnvironmentName,
  validateExecutionRequest,
  validateGitConfiguration,
};
