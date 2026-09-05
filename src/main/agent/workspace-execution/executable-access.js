'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_EXECUTABLE_REQUESTS = 16;
const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const validatedExecutableRoots = new WeakSet();
const validatedExecutableRequests = new WeakSet();
const SYSTEM_TOOLCHAIN_DIRECTORIES = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

function systemToolchainDirectories(platform) {
  const directories = [...SYSTEM_TOOLCHAIN_DIRECTORIES];
  if (platform === 'darwin' && fs.existsSync('/Library/Developer/CommandLineTools/usr/bin')) {
    directories.unshift('/Library/Developer/CommandLineTools/usr/bin');
  }
  return directories;
}

class ExecutableAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutableAccessError';
    this.code = code;
  }
}

function insidePath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateExecutableNames(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_EXECUTABLE_REQUESTS) {
    throw new ExecutableAccessError(
      'INVALID_EXECUTABLE_REQUEST',
      `Request between 1 and ${MAX_EXECUTABLE_REQUESTS} executable names`
    );
  }
  const names = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !EXECUTABLE_NAME.test(value)) {
      throw new ExecutableAccessError(
        'INVALID_EXECUTABLE_REQUEST',
        'Executable requests must use bounded command names without paths'
      );
    }
    if (!seen.has(value)) names.push(value);
    seen.add(value);
  }
  return names;
}

function hostPathEntries(hostEnvironment) {
  const raw = typeof hostEnvironment?.PATH === 'string' ? hostEnvironment.PATH : '';
  return raw
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && !entry.includes('\0'))
    .slice(0, 64);
}

async function findExecutable(name, pathEntries) {
  for (const directory of pathEntries) {
    const candidate = path.join(directory, name);
    try {
      const stats = await fs.promises.stat(candidate);
      if (!stats.isFile()) continue;
      await fs.promises.access(candidate, fs.constants.X_OK);
      return {
        invokedPath: candidate,
        executablePath: await fs.promises.realpath(candidate),
      };
    } catch {
      // Continue through the bounded host PATH. An unavailable candidate grants nothing.
    }
  }
  return null;
}

function isSystemExecutable(executablePath, platform) {
  if (insidePath('/usr/local', executablePath)) return false;
  const roots =
    platform === 'darwin'
      ? ['/System', '/usr/bin', '/usr/sbin', '/bin', '/sbin']
      : ['/usr/bin', '/usr/sbin', '/bin', '/sbin'];
  return roots.some((root) => insidePath(root, executablePath));
}

function packageRootForExecutable(executablePath) {
  const executableDirectory = path.dirname(executablePath);
  const leaf = path.basename(executableDirectory);
  const candidate =
    leaf === 'bin' || leaf === 'sbin' ? path.dirname(executableDirectory) : executableDirectory;
  const home = path.resolve(os.homedir());
  if (
    candidate === path.parse(candidate).root ||
    candidate === home ||
    insidePath(candidate, home)
  ) {
    throw new ExecutableAccessError(
      'EXECUTABLE_SCOPE_TOO_BROAD',
      'Freedom refused an executable whose package root would expose a broad host directory'
    );
  }
  return candidate;
}

function runtimeRootId(sourcePath) {
  return `approved_${crypto.createHash('sha256').update(sourcePath).digest('hex').slice(0, 16)}`;
}

function publicPath(value) {
  return value.length <= 1_024 ? value : `${value.slice(0, 1_021)}…`;
}

async function resolveExecutableAccess(executables, options = {}) {
  const names = validateExecutableNames(executables);
  const platform = options.platform || process.platform;
  if (!['darwin', 'linux'].includes(platform)) {
    throw new ExecutableAccessError(
      'EXECUTABLE_ACCESS_PLATFORM_UNAVAILABLE',
      'Approved executable access is currently available only on macOS and Linux'
    );
  }
  const pathEntries = hostPathEntries(options.hostEnvironment || process.env);
  const rootBuilders = new Map();
  const commands = [];
  for (const name of names) {
    // Merely living beneath a system root does not make a name shell-resolvable.
    // Preserve explicit host toolchain selection, with the sandbox baseline as fallback.
    const baseline = await findExecutable(name, systemToolchainDirectories(platform));
    const found = (await findExecutable(name, pathEntries)) || baseline;
    if (!found) {
      commands.push(Object.freeze({ name, status: 'unavailable' }));
      continue;
    }
    if (isSystemExecutable(found.executablePath, platform)) {
      commands.push(Object.freeze({
        name,
        status: baseline?.executablePath === found.executablePath ? 'available' : 'unavailable',
      }));
      continue;
    }
    const sourcePath = await fs.promises.realpath(packageRootForExecutable(found.executablePath));
    const executableDirectory = path.dirname(found.executablePath);
    const pathEntryRelative = path.relative(sourcePath, executableDirectory) || '.';
    if (
      pathEntryRelative === '..' ||
      pathEntryRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(pathEntryRelative)
    ) {
      throw new ExecutableAccessError(
        'INVALID_EXECUTABLE_ROOT',
        'Freedom could not derive a contained executable package root'
      );
    }
    let builder = rootBuilders.get(sourcePath);
    if (!builder) {
      builder = {
        id: runtimeRootId(sourcePath),
        sourcePath,
        mountPath: `/opt/freedom-toolchain/approved/${runtimeRootId(sourcePath)}`,
        access: 'read_execute',
        pathEntries: new Set(),
        executablePaths: new Set(),
        commands: new Set(),
      };
      rootBuilders.set(sourcePath, builder);
    }
    builder.pathEntries.add(pathEntryRelative);
    builder.executablePaths.add(found.executablePath);
    builder.commands.add(name);
    commands.push(
      Object.freeze({
        name,
        status: 'requires_permission',
        executablePath: publicPath(found.executablePath),
        rootPath: publicPath(sourcePath),
      })
    );
  }

  const runtimeRoots = [...rootBuilders.values()].map((builder) => {
    const root = Object.freeze({
      id: builder.id,
      sourcePath: builder.sourcePath,
      mountPath: builder.mountPath,
      access: builder.access,
      pathEntries: Object.freeze([...builder.pathEntries].sort()),
      executablePaths: Object.freeze([...builder.executablePaths].sort()),
      commands: Object.freeze([...builder.commands].sort()),
    });
    validatedExecutableRoots.add(root);
    return root;
  });
  const request = Object.freeze({
    kind: 'freedom.executable-access-request',
    commands: Object.freeze(commands),
    runtimeRoots: Object.freeze(runtimeRoots),
  });
  validatedExecutableRequests.add(request);
  return request;
}

function isValidatedExecutableRoot(value) {
  return Boolean(value && typeof value === 'object' && validatedExecutableRoots.has(value));
}

function isValidatedExecutableAccessRequest(value) {
  return Boolean(value && typeof value === 'object' && validatedExecutableRequests.has(value));
}

module.exports = {
  SYSTEM_TOOLCHAIN_DIRECTORIES,
  EXECUTABLE_NAME,
  MAX_EXECUTABLE_REQUESTS,
  ExecutableAccessError,
  isValidatedExecutableAccessRequest,
  isValidatedExecutableRoot,
  resolveExecutableAccess,
  systemToolchainDirectories,
  validateExecutableNames,
};
