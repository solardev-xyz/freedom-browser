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

function unsupportedInterpreter(name) {
  return new ExecutableAccessError(
    'EXECUTABLE_INTERPRETER_UNSUPPORTED',
    `Freedom cannot safely resolve the script interpreter required by ${name}`
  );
}

async function scriptInterpreter(executablePath, name) {
  // Inspect a bounded header without executing the program or following a changed symlink.
  const file = await fs.promises.open(
    executablePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    if (!(await file.stat()).isFile()) throw unsupportedInterpreter(name);
    const header = Buffer.alloc(4_096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (header[0] !== 35 || header[1] !== 33) return null;
    const text = header.subarray(0, bytesRead).toString('utf8');
    if (!text.includes('\n') && bytesRead === header.length) throw unsupportedInterpreter(name);
    const line = text.split('\n', 1)[0];
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line)) throw unsupportedInterpreter(name);
    const match = /^#![ \t]*(\/[^ \t]+)(?:[ \t]+(.*))?$/.exec(line);
    if (!match) throw unsupportedInterpreter(name);
    const interpreterPath = match[1];
    if (interpreterPath === '/usr/bin/env' || interpreterPath === '/bin/env') {
      if (!(await findExecutable('env', [path.dirname(interpreterPath)]))) {
        throw unsupportedInterpreter(name);
      }
      const args = (match[2] || '').trim().split(/[ \t]+/);
      const split = args[0] === '-S';
      if (split) args.shift();
      if (
        typeof args[0] !== 'string' || !EXECUTABLE_NAME.test(args[0]) ||
        (!split && args.length !== 1) ||
        args.slice(1).some((arg) => !/^--?[A-Za-z0-9][A-Za-z0-9._=+-]*$/.test(arg))
      ) {
        throw unsupportedInterpreter(name);
      }
      return { name: args[0], exactPath: null };
    }
    const interpreterName = path.basename(interpreterPath);
    if (!EXECUTABLE_NAME.test(interpreterName)) throw unsupportedInterpreter(name);
    return { name: interpreterName, exactPath: interpreterPath };
  } finally {
    await file.close();
  }
}

async function resolveCommandInterpreters(names, pathEntries, platform) {
  const resolved = new Map();
  const visited = new Set();
  async function visit(name, parent = null, exactPath = null, ancestors = []) {
    const baseline = await findExecutable(name, systemToolchainDirectories(platform));
    const found = exactPath
      ? await findExecutable(name, [path.dirname(exactPath)])
      : (await findExecutable(name, pathEntries)) || baseline;
    if (parent && (!found || (!exactPath && isSystemExecutable(found.executablePath, platform) &&
        baseline?.executablePath !== found.executablePath))) {
      throw new ExecutableAccessError(
        'EXECUTABLE_INTERPRETER_UNAVAILABLE',
        `The interpreter ${name} required by ${parent} is unavailable in the installed command environment`
      );
    }
    const previous = resolved.get(name);
    if (previous?.found?.executablePath && previous.found.executablePath !== found?.executablePath) {
      throw unsupportedInterpreter(parent || name);
    }
    if (found && (ancestors.includes(found.executablePath) || ancestors.length >= 4)) {
      throw unsupportedInterpreter(parent || name);
    }
    // Linux remaps external package roots: an absolute external shebang would still
    // address the host layout. Refuse it rather than silently broadening mount authority.
    if (exactPath && platform === 'linux' && !isSystemExecutable(found.executablePath, platform)) {
      throw unsupportedInterpreter(parent || name);
    }
    resolved.set(name, { found, baseline });
    if (resolved.size > MAX_EXECUTABLE_REQUESTS) throw unsupportedInterpreter(parent || name);
    if (!found || visited.has(found.executablePath)) return;
    const interpreter = await scriptInterpreter(found.executablePath, name);
    if (interpreter) {
      await visit(interpreter.name, name, interpreter.exactPath, [...ancestors, found.executablePath]);
    }
    visited.add(found.executablePath);
  }
  for (const name of names) await visit(name);
  return resolved;
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
  const resolved = await resolveCommandInterpreters(names, pathEntries, platform);
  const rootBuilders = new Map();
  const commands = [];
  for (const [name, { found, baseline }] of resolved) {
    // Merely living beneath a system root does not make a name shell-resolvable.
    // Preserve explicit host toolchain selection, with the sandbox baseline as fallback.
    if (!found) {
      commands.push(Object.freeze({ name, status: 'unavailable' }));
      continue;
    }
    if (isSystemExecutable(found.executablePath, platform)) {
      if (!names.includes(name)) continue; // Already present in the sandbox's system toolchain.
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
        commandEntries: [],
      };
      rootBuilders.set(sourcePath, builder);
    }
    builder.pathEntries.add(pathEntryRelative);
    builder.executablePaths.add(found.executablePath);
    builder.commands.add(name);
    builder.commandEntries.push(Object.freeze({ name, executablePath: found.executablePath }));
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
      commandEntries: Object.freeze(builder.commandEntries),
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

function mergeExecutableRoots(previous, next) {
  if (
    !isValidatedExecutableRoot(previous) || !isValidatedExecutableRoot(next) ||
    previous.id !== next.id || previous.sourcePath !== next.sourcePath ||
    previous.mountPath !== next.mountPath
  ) {
    throw new ExecutableAccessError(
      'INVALID_EXECUTABLE_ROOT', 'Only identical approved package roots can be combined'
    );
  }
  const commands = new Map(previous.commandEntries.map((entry) => [entry.name, entry]));
  for (const entry of next.commandEntries) {
    const existing = commands.get(entry.name);
    if (existing && existing.executablePath !== entry.executablePath) {
      throw new ExecutableAccessError(
        'AMBIGUOUS_EXECUTABLE_COMMAND', 'An approved command entry point changed'
      );
    }
    commands.set(entry.name, entry);
  }
  if (commands.size > 256) {
    throw new ExecutableAccessError(
      'INVALID_EXECUTABLE_ROOT', 'An approved package has too many command entries'
    );
  }
  const root = Object.freeze({
    ...next,
    pathEntries: Object.freeze([...new Set([...previous.pathEntries, ...next.pathEntries])].sort()),
    executablePaths: Object.freeze(
      [...new Set([...previous.executablePaths, ...next.executablePaths])].sort()
    ),
    commands: Object.freeze([...commands.keys()].sort()),
    commandEntries: Object.freeze([...commands.values()]),
  });
  validatedExecutableRoots.add(root);
  return root;
}

// Preserve command names independently of the basename of a symlink's target. Adding
// that target directory to PATH alone can select a different, same-named launcher.
function executableCommandEntries(runtimeRoots, platform) {
  const entries = new Map();
  for (const root of runtimeRoots) {
    if (!isValidatedExecutableRoot(root)) continue; // Electron runtime has its own attestation.
    for (const entry of root.commandEntries) {
      const executablePath =
        platform === 'linux'
          ? path.posix.join(
              root.mountPath,
              ...path.relative(root.sourcePath, entry.executablePath).split(path.sep)
            )
          : entry.executablePath;
      const previous = entries.get(entry.name);
      if (previous && previous !== executablePath) {
        throw new ExecutableAccessError(
          'AMBIGUOUS_EXECUTABLE_COMMAND',
          'Approved executable roots disagree on a command entry point'
        );
      }
      entries.set(entry.name, executablePath);
    }
  }
  return [...entries].map(([name, executablePath]) => ({ name, executablePath }));
}

function isValidatedExecutableAccessRequest(value) {
  return Boolean(value && typeof value === 'object' && validatedExecutableRequests.has(value));
}

module.exports = {
  SYSTEM_TOOLCHAIN_DIRECTORIES,
  EXECUTABLE_NAME,
  MAX_EXECUTABLE_REQUESTS,
  ExecutableAccessError,
  executableCommandEntries,
  mergeExecutableRoots,
  isValidatedExecutableAccessRequest,
  isValidatedExecutableRoot,
  resolveExecutableAccess,
  systemToolchainDirectories,
  validateExecutableNames,
};
