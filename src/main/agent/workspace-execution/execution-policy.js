'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isValidatedElectronJavaScriptRuntime,
  statValidatedElectronPackageArchive,
} = require('./electron-runtime');
const { isValidatedExecutableRoot } = require('./executable-access');

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
  FULL: 'full',
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
  /(?:AUTH|AUTHTOKEN|COOKIE|CREDENTIAL|PASS|PASSWD|PASSWORD|PWD|SECRET|SESSION|TOKEN|(?:^|_)KEY(?:_|$))/i;
const FORBIDDEN_ENVIRONMENT_PREFIXES = Object.freeze(['DYLD_', 'LD_']);
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
const validatedPolicies = new WeakSet();

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
    FORBIDDEN_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
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

function assertAuthorizedGitMetadataPath(workspaceRoot, candidate, authorizedGitMetadataPaths) {
  if (insidePath(workspaceRoot, candidate)) {
    throw new ExecutionPolicyError(
      'AMBIGUOUS_PROTECTED_PATH',
      'Git pointer metadata cannot remain reachable through the writable workspace'
    );
  }
  if (!authorizedGitMetadataPaths.has(candidate)) {
    throw new ExecutionPolicyError(
      'EXTERNAL_GIT_METADATA_DENIED',
      'External Git metadata was not explicitly authorized by trusted workspace state'
    );
  }
}

async function resolveGitMetadata(workspaceRoot, relativePath, authorizedGitMetadataPaths) {
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
      `${relativePath} resolved outside the workspace unexpectedly`,
      { relativePath }
    );
  }
  const resolvedRelativePath = path.relative(workspaceRoot, sourcePath).split(path.sep).join('/');
  if (resolvedRelativePath !== relativePath) {
    throw new ExecutionPolicyError(
      'PROTECTED_PATH_CASE_MISMATCH',
      `${relativePath} must use its canonical on-disk casing`,
      { relativePath, resolvedRelativePath }
    );
  }
  if (entry.isDirectory()) {
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
  assertAuthorizedGitMetadataPath(workspaceRoot, gitDirectory, authorizedGitMetadataPaths);
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
    assertAuthorizedGitMetadataPath(workspaceRoot, commonDirectory, authorizedGitMetadataPaths);
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
  if (gitDirectory !== commonDirectory) {
    await validateGitConfiguration(gitDirectory);
  }
  return Object.freeze({
    relativePath,
    access: 'read_only',
    kind: 'git_pointer',
    sourcePath,
    gitDirectory,
    commonDirectory,
    hasCommonDirectoryPointer,
    hasGitDirectoryPointer,
    mountPath: path.posix.join(WORKSPACE_MOUNT_PATH, relativePath),
  });
}

async function resolveProtectedPath(workspaceRoot, relativePath, authorizedGitMetadataPaths) {
  if (relativePath === '.git') {
    return resolveGitMetadata(workspaceRoot, relativePath, authorizedGitMetadataPaths);
  }
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
  if (sourcePath !== candidate) {
    throw new ExecutionPolicyError(
      'AMBIGUOUS_PROTECTED_PATH',
      `${relativePath} must not resolve through a symbolic-link or case-folded parent`,
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

function workspaceAccess(relativePath, protectedPaths, protectedPrefixes) {
  return protectedPaths.includes(relativePath) ||
    protectedPrefixes.some((prefix) => relativePath.startsWith(prefix))
    ? 'protected'
    : 'writable';
}

function workspaceEntryKind(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'special';
}

function workspaceEntrySignature(stats, kind) {
  return [
    kind,
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(':');
}

function workspaceChanged(relativePath, cause = null) {
  return new ExecutionPolicyError(
    'WORKSPACE_CHANGED_DURING_VALIDATION',
    'Workspace entries changed while filesystem identity was being validated',
    { relativePath, ...(cause ? { cause } : {}) }
  );
}

async function scanWorkspaceIdentities(workspaceRoot, protectedPaths) {
  const protectedPrefixes = protectedPaths.map((value) => `${value}/`);
  const directories = [{ candidate: workspaceRoot, expectedSignature: null, relativePath: '.' }];
  const entriesByPath = new Map();
  const regularFilesByIdentity = new Map();
  let inspectedEntries = 0;
  while (directories.length) {
    const directory = directories.pop();
    let before;
    let names;
    try {
      before = await fs.promises.lstat(directory.candidate, { bigint: true });
      names = await fs.promises.readdir(directory.candidate);
    } catch (error) {
      throw workspaceChanged(directory.relativePath, error.code);
    }
    const beforeKind = workspaceEntryKind(before);
    const beforeSignature = workspaceEntrySignature(before, beforeKind);
    if (
      beforeKind !== 'directory' ||
      (directory.expectedSignature !== null && beforeSignature !== directory.expectedSignature)
    ) {
      throw workspaceChanged(directory.relativePath);
    }
    if (directory.relativePath === '.') entriesByPath.set('.', beforeSignature);

    for (const name of names.sort()) {
      inspectedEntries += 1;
      if (inspectedEntries > 500_000) {
        throw new ExecutionPolicyError(
          'WORKSPACE_VALIDATION_LIMIT',
          'Workspace contains too many entries for safe hardlink validation'
        );
      }
      const candidate = path.join(directory.candidate, name);
      const relative = path.relative(workspaceRoot, candidate).split(path.sep).join('/');
      let stats;
      try {
        stats = await fs.promises.lstat(candidate, { bigint: true });
      } catch (error) {
        throw workspaceChanged(relative, error.code);
      }
      const kind = workspaceEntryKind(stats);
      const signature = workspaceEntrySignature(stats, kind);
      entriesByPath.set(relative, signature);
      const access = workspaceAccess(relative, protectedPaths, protectedPrefixes);

      if (kind === 'symlink') continue;
      if (kind === 'directory') {
        directories.push({ candidate, expectedSignature: signature, relativePath: relative });
        continue;
      }
      if (kind === 'special') {
        if (access === 'protected') continue;
        throw new ExecutionPolicyError(
          'WORKSPACE_SPECIAL_FILE_DENIED',
          'Writable workspaces must not contain sockets, devices, or other special files',
          { relativePath: relative }
        );
      }

      const identity = `${stats.dev}:${stats.ino}`;
      let group = regularFilesByIdentity.get(identity);
      if (!group) {
        group = { accesses: new Set(), paths: [], reportedLinkCounts: new Set() };
        regularFilesByIdentity.set(identity, group);
      }
      group.accesses.add(access);
      group.paths.push(relative);
      group.reportedLinkCounts.add(stats.nlink.toString());
    }

    let after;
    try {
      after = await fs.promises.lstat(directory.candidate, { bigint: true });
    } catch (error) {
      throw workspaceChanged(directory.relativePath, error.code);
    }
    if (workspaceEntrySignature(after, workspaceEntryKind(after)) !== beforeSignature) {
      throw workspaceChanged(directory.relativePath);
    }
  }

  for (const group of regularFilesByIdentity.values()) {
    const relativePath = group.paths[0];
    if (group.reportedLinkCounts.size !== 1) {
      throw new ExecutionPolicyError(
        'WORKSPACE_HARDLINK_DENIED',
        'Workspace hardlink identity reported inconsistent link counts',
        { relativePath }
      );
    }
    const reportedLinks = BigInt([...group.reportedLinkCounts][0]);
    if (reportedLinks < 1n || reportedLinks !== BigInt(group.paths.length)) {
      throw new ExecutionPolicyError(
        'WORKSPACE_HARDLINK_DENIED',
        'Workspace hardlink identity has links outside the accounted workspace tree',
        {
          relativePath,
          observedLinks: group.paths.length,
          reportedLinks: reportedLinks.toString(),
        }
      );
    }
    if (group.accesses.size !== 1) {
      throw new ExecutionPolicyError(
        'WORKSPACE_HARDLINK_DENIED',
        'Workspace hardlink identity crosses protected and writable paths',
        { relativePath }
      );
    }
  }

  return entriesByPath;
}

async function validateWorkspaceHardlinks(workspaceRoot, protectedPaths) {
  // Repeating the bounded identity scan detects changes during validation. A separate same-UID
  // host process can still race after this check; managed-workspace lifecycle must close that gap.
  const firstScan = await scanWorkspaceIdentities(workspaceRoot, protectedPaths);
  const secondScan = await scanWorkspaceIdentities(workspaceRoot, protectedPaths);
  if (firstScan.size !== secondScan.size) throw workspaceChanged('.');
  for (const [relativePath, signature] of firstScan) {
    if (secondScan.get(relativePath) !== signature) throw workspaceChanged(relativePath);
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

async function canonicalExecutableRuntimeRoot(input) {
  if (!isValidatedExecutableRoot(input)) {
    throw new ExecutionPolicyError(
      'UNTRUSTED_EXECUTABLE_ROOT',
      'Executable roots must come from Freedom executable resolution'
    );
  }
  const sourcePath = await canonicalDirectory(input.sourcePath, 'runtimeRoots sourcePath');
  if (sourcePath !== input.sourcePath) {
    throw new ExecutionPolicyError(
      'EXECUTABLE_ROOT_CHANGED',
      'The approved executable root changed before policy construction'
    );
  }
  for (const executablePath of input.executablePaths) {
    let canonical;
    let stats;
    try {
      canonical = await fs.promises.realpath(executablePath);
      stats = await fs.promises.stat(canonical);
    } catch (error) {
      throw new ExecutionPolicyError(
        'EXECUTABLE_ROOT_CHANGED',
        'An approved executable is no longer available',
        { cause: error.code }
      );
    }
    if (canonical !== executablePath || !stats.isFile() || !insidePath(sourcePath, canonical)) {
      throw new ExecutionPolicyError(
        'EXECUTABLE_ROOT_CHANGED',
        'An approved executable no longer belongs to its approved package root'
      );
    }
  }
  return input;
}

async function canonicalMacElectronRuntimeRoot(input) {
  const runtimeRoot = await canonicalDirectory(input, 'electronRuntime.runtimeRoot');
  if (path.extname(runtimeRoot) !== '.app') {
    throw new ExecutionPolicyError(
      'INVALID_ELECTRON_RUNTIME',
      'electronRuntime.runtimeRoot must identify one canonical macOS application bundle'
    );
  }
  let executableDirectory;
  try {
    executableDirectory = await fs.promises.stat(path.join(runtimeRoot, 'Contents', 'MacOS'));
  } catch (error) {
    throw new ExecutionPolicyError(
      'INVALID_ELECTRON_RUNTIME',
      'electronRuntime.runtimeRoot does not contain a macOS executable directory',
      { cause: error.code }
    );
  }
  if (!executableDirectory.isDirectory()) {
    throw new ExecutionPolicyError(
      'INVALID_ELECTRON_RUNTIME',
      'electronRuntime.runtimeRoot does not contain a macOS executable directory'
    );
  }
  return runtimeRoot;
}

async function canonicalElectronRuntime(input) {
  if (!isValidatedElectronJavaScriptRuntime(input)) {
    throw new ExecutionPolicyError(
      'UNTRUSTED_ELECTRON_RUNTIME',
      'electronRuntime must be the active runtime attested by Freedom'
    );
  }
  const descriptor = requirePlainObject(input, 'electronRuntime');
  const sourcePath = await canonicalDirectory(
    descriptor.runtimeRoot,
    'electronRuntime.runtimeRoot'
  );
  if (
    typeof descriptor.executablePath !== 'string' ||
    !path.isAbsolute(descriptor.executablePath) ||
    descriptor.executablePath.includes('\0')
  ) {
    throw new ExecutionPolicyError(
      'INVALID_ELECTRON_RUNTIME',
      'electronRuntime.executablePath must be one trusted absolute path'
    );
  }
  let executablePath;
  let executableStats;
  try {
    executablePath = await fs.promises.realpath(descriptor.executablePath);
    executableStats = await fs.promises.stat(executablePath);
  } catch (error) {
    throw new ExecutionPolicyError(
      'INVALID_ELECTRON_RUNTIME',
      'electronRuntime.executablePath is unavailable',
      { cause: error.code }
    );
  }
  if (!executableStats.isFile() || !insidePath(sourcePath, executablePath)) {
    throw new ExecutionPolicyError(
      'INVALID_ELECTRON_RUNTIME',
      'electronRuntime executable must be a regular file inside its runtime root'
    );
  }
  if (descriptor.platform === 'darwin') {
    await canonicalMacElectronRuntimeRoot(sourcePath);
    if (
      descriptor.applicationBundleRoot !== sourcePath ||
      path.dirname(executablePath) !== path.join(sourcePath, 'Contents', 'MacOS')
    ) {
      throw new ExecutionPolicyError(
        'INVALID_ELECTRON_RUNTIME',
        'electronRuntime does not match its attested macOS application bundle'
      );
    }
  } else if (descriptor.platform !== 'linux') {
    throw new ExecutionPolicyError(
      'INVALID_ELECTRON_RUNTIME',
      'electronRuntime platform must be linux or darwin'
    );
  } else {
    const resourcesPath = await canonicalDirectory(
      descriptor.resourcesPath,
      'electronRuntime.resourcesPath'
    );
    if (
      path.basename(resourcesPath) !== 'resources' ||
      path.dirname(resourcesPath) !== sourcePath ||
      path.dirname(executablePath) !== sourcePath
    ) {
      throw new ExecutionPolicyError(
        'INVALID_ELECTRON_RUNTIME',
        'electronRuntime does not match one Linux executable and resources tree'
      );
    }
    if (descriptor.packaged) {
      let archiveStats;
      try {
        archiveStats = await statValidatedElectronPackageArchive(input);
      } catch (error) {
        throw new ExecutionPolicyError(
          'INVALID_ELECTRON_RUNTIME',
          'Packaged electronRuntime does not contain resources/app.asar',
          { cause: error.code }
        );
      }
      if (!archiveStats.isFile()) {
        throw new ExecutionPolicyError(
          'INVALID_ELECTRON_RUNTIME',
          'Packaged electronRuntime does not contain resources/app.asar'
        );
      }
      if (insidePath(os.homedir(), sourcePath)) {
        throw new ExecutionPolicyError(
          'INVALID_ELECTRON_RUNTIME',
          'Packaged Linux electronRuntime cannot grant access to a home-directory tree'
        );
      }
    }
  }
  const relativeExecutablePath = path.relative(sourcePath, executablePath);
  const sandboxExecutablePath =
    descriptor.platform === 'linux'
      ? path.posix.join(
          '/opt/freedom-toolchain/electron',
          ...relativeExecutablePath.split(path.sep)
        )
      : executablePath;
  return Object.freeze({
    id: 'electron',
    sourcePath,
    mountPath: '/opt/freedom-toolchain/electron',
    access: 'read_only',
    executablePath,
    relativeExecutablePath,
    sandboxExecutablePath,
  });
}

async function createWorkspaceExecutionPolicy(options = {}) {
  const workspaceRoot = await canonicalDirectory(options.workspaceRoot, 'workspaceRoot');
  const authorizedInput = options.authorizedGitMetadataPaths ?? [];
  if (!Array.isArray(authorizedInput) || authorizedInput.length > 16) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      'authorizedGitMetadataPaths must be a short trusted array'
    );
  }
  const authorizedGitMetadataPaths = new Set();
  for (const authorizedPath of authorizedInput) {
    authorizedGitMetadataPaths.add(
      await canonicalDirectory(authorizedPath, 'authorized Git metadata path')
    );
  }
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

  const protectedInput = options.protectedWorkspacePaths ?? [];
  if (!Array.isArray(protectedInput) || protectedInput.length > 32) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      'protectedWorkspacePaths must be a short array'
    );
  }
  const protectedWorkspacePaths = [
    ...new Set(
      DEFAULT_PROTECTED_PATHS.concat(
        protectedInput.map((value) =>
          validateWorkspaceRelativePath(value, 'protectedWorkspacePaths entry')
        )
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
    protectedPaths.push(
      await resolveProtectedPath(workspaceRoot, relativePath, authorizedGitMetadataPaths)
    );
  }
  await validateWorkspaceHardlinks(workspaceRoot, protectedWorkspacePaths);

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

  const runtimeRootsInput = options.runtimeRoots ?? [];
  if (!Array.isArray(runtimeRootsInput) || runtimeRootsInput.length > 16) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'runtimeRoots must be a short trusted array');
  }
  const runtimeRoots = [];
  for (const runtimeRoot of runtimeRootsInput) {
    runtimeRoots.push(await canonicalExecutableRuntimeRoot(runtimeRoot));
  }
  if (options.electronRuntime) {
    runtimeRoots.push(await canonicalElectronRuntime(options.electronRuntime));
  }
  if (new Set(runtimeRoots.map((root) => root.id)).size !== runtimeRoots.length) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'Runtime root IDs must be unique');
  }

  const policy = Object.freeze({
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
    cancellation: Object.freeze({
      supported: true,
      scope: 'descendant_tree',
      guarantee: 'backend_reported',
    }),
    seccomp: Object.freeze({ requireCustomFilter: options.requireCustomSeccomp === true }),
  });
  validatedPolicies.add(policy);
  return policy;
}

function restrictWorkspaceExecutionPolicy(policy, options = {}) {
  if (!isValidatedWorkspaceExecutionPolicy(policy)) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      'Only a trusted Freedom workspace policy can be restricted'
    );
  }
  const requested = requirePlainObject(options, 'restrictions');
  const network = requested.network ?? policy.network;
  if (
    network !== policy.network &&
    !(policy.network === NETWORK_POSTURES.FULL && network === NETWORK_POSTURES.NONE)
  ) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      'A derived execution policy may only remove direct network authority'
    );
  }
  const omittedRuntimeRootIds = requested.omitRuntimeRootIds ?? [];
  const addedRuntimeRoots = requested.addRuntimeRoots ?? [];
  const omittedEnvironmentNames = requested.omitEnvironmentNames ?? [];
  if (!Array.isArray(omittedRuntimeRootIds) || omittedRuntimeRootIds.length > 16) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'omitRuntimeRootIds must be a short array');
  }
  if (!Array.isArray(omittedEnvironmentNames) || omittedEnvironmentNames.length > 64) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'omitEnvironmentNames must be a short array');
  }
  if (
    !Array.isArray(addedRuntimeRoots) ||
    addedRuntimeRoots.length > 16 ||
    addedRuntimeRoots.some((root) => !isValidatedExecutableRoot(root))
  ) {
    throw new ExecutionPolicyError(
      'UNTRUSTED_EXECUTABLE_ROOT',
      'Added runtime roots must come from Freedom executable resolution'
    );
  }
  const runtimeRootIds = new Set();
  for (const value of omittedRuntimeRootIds) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
      throw new ExecutionPolicyError('INVALID_POLICY', 'Runtime root IDs must be bounded names');
    }
    runtimeRootIds.add(value);
  }
  const environmentNames = new Set();
  for (const value of omittedEnvironmentNames) {
    if (typeof value !== 'string' || !ENVIRONMENT_NAME.test(value)) {
      throw new ExecutionPolicyError(
        'INVALID_POLICY',
        'Environment names to omit must be bounded names'
      );
    }
    environmentNames.add(value);
  }
  const environmentValues = Object.fromEntries(
    Object.entries(policy.environment.values).filter(([name]) => !environmentNames.has(name))
  );
  const retainedRuntimeRoots = policy.filesystem.runtimeRoots.filter(
    (root) => !runtimeRootIds.has(root.id)
  );
  const combinedRuntimeRoots = retainedRuntimeRoots.concat(addedRuntimeRoots);
  if (
    combinedRuntimeRoots.length > 17 ||
    new Set(combinedRuntimeRoots.map((root) => root.id)).size !== combinedRuntimeRoots.length
  ) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'Derived runtime roots must be unique');
  }
  const restricted = Object.freeze({
    ...policy,
    network,
    filesystem: Object.freeze({
      ...policy.filesystem,
      runtimeRoots: Object.freeze(combinedRuntimeRoots),
    }),
    environment: Object.freeze({
      ...policy.environment,
      values: Object.freeze(environmentValues),
    }),
  });
  validatedPolicies.add(restricted);
  return restricted;
}

function isValidatedWorkspaceExecutionPolicy(policy) {
  return Boolean(policy && typeof policy === 'object' && validatedPolicies.has(policy));
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
  if (request.onOutput !== undefined && typeof request.onOutput !== 'function') {
    throw new ExecutionPolicyError('INVALID_REQUEST', 'onOutput must be a function');
  }
  if (request.onStdin !== undefined && typeof request.onStdin !== 'function') {
    throw new ExecutionPolicyError('INVALID_REQUEST', 'onStdin must be a function');
  }
  return Object.freeze({
    command: request.command,
    args: Object.freeze(normalizedArgs),
    signal: request.signal,
    onOutput: request.onOutput,
    onStdin: request.onStdin,
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
  insidePath,
  isValidatedWorkspaceExecutionPolicy,
  restrictWorkspaceExecutionPolicy,
  validateEnvironmentName,
  validateExecutionRequest,
  validateGitConfiguration,
};
