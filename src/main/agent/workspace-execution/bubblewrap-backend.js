'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EXECUTION_STATES,
  ExecutionPolicyError,
  NETWORK_POSTURES,
  isValidatedWorkspaceExecutionPolicy,
  validateExecutionRequest,
} = require('./execution-policy');

const DEFAULT_BUBBLEWRAP_PATH = '/usr/bin/bwrap';
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
const PRIVATE_TEMP_SIZE_BYTES = 256 * 1024 * 1024;
const SHARED_MEMORY_SIZE_BYTES = 64 * 1024 * 1024;
const SYSTEM_RUNTIME_PATHS = Object.freeze(['/usr', '/bin', '/sbin', '/lib', '/lib64']);
const SYSTEM_CONFIGURATION_PATHS = Object.freeze([
  '/etc/alternatives',
  '/etc/ca-certificates',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/localtime',
  '/etc/ssl/certs',
]);

function boundedText(value, maximum = 2_048) {
  if (typeof value !== 'string') return '';
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('')
    .slice(0, maximum);
}

async function readText(file) {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readInteger(file) {
  const value = await readText(file);
  if (value === null) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function collectStream(stream, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  if (!stream) {
    return {
      done: Promise.resolve(),
      result: () => ({ bytes: 0, text: '', truncated: false }),
    };
  }
  const done = new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maximumBytes - bytes);
      if (remaining > 0) {
        const retained = buffer.subarray(0, remaining);
        chunks.push(retained);
        bytes += retained.length;
      }
      if (buffer.length > remaining) truncated = true;
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return {
    done,
    result: () => ({
      bytes,
      text: Buffer.concat(chunks, bytes).toString('utf8'),
      truncated,
    }),
  };
}

function runBoundedProcess(binary, args, options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const timeoutMs = options.timeoutMs || CAPABILITY_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(binary, args, {
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, error, stdout: '', stderr: '' });
      return;
    }
    const stdout = collectStream(child.stdout, 64 * 1024);
    const stderr = collectStream(child.stderr, 64 * 1024);
    let spawnError = null;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      await Promise.allSettled([stdout.done, stderr.done]);
      resolve({
        code,
        signal,
        error: spawnError,
        stdout: stdout.result().text,
        stderr: stderr.result().text,
      });
    });
  });
}

function capabilityProbeArguments() {
  return [
    '--unshare-all',
    '--unshare-user',
    '--disable-userns',
    '--assert-userns-disabled',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--size',
    String(SHARED_MEMORY_SIZE_BYTES),
    '--perms',
    '1777',
    '--tmpfs',
    '/dev/shm',
    '--remount-ro',
    '/dev',
    '--size',
    String(PRIVATE_TEMP_SIZE_BYTES),
    '--perms',
    '1777',
    '--tmpfs',
    '/tmp',
    '--remount-ro',
    '/proc',
    '--remount-ro',
    '/',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--chdir',
    '/tmp',
    '--',
    '/usr/bin/true',
  ];
}

async function detectBubblewrapCapabilities(options = {}) {
  const binary = options.binary || DEFAULT_BUBBLEWRAP_PATH;
  const diagnostics = {
    platform: process.platform,
    runningAsRoot: typeof process.geteuid === 'function' && process.geteuid() === 0,
    appArmorEnabled: (await readText('/sys/module/apparmor/parameters/enabled'))?.trim() === 'Y',
    appArmorRestrictsUnprivilegedUserNamespaces:
      (await readInteger('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')) === 1,
    unprivilegedUserNamespacesEnabled:
      (await readInteger('/proc/sys/kernel/unprivileged_userns_clone')) !== 0,
    maximumUserNamespaces: await readInteger('/proc/sys/user/max_user_namespaces'),
  };
  const unavailable = (code, message, extra = {}) =>
    Object.freeze({
      backend: 'linux-bubblewrap',
      available: false,
      denial: Object.freeze({ code, message }),
      diagnostics: Object.freeze({ ...diagnostics, ...extra }),
      enforcement: Object.freeze({
        filesystem: false,
        networkNone: false,
        processNamespace: false,
        ipcNamespace: false,
        customSeccomp: false,
        aggregateResourceLimits: false,
      }),
    });

  if (process.platform !== 'linux') {
    return unavailable('UNSUPPORTED_PLATFORM', 'Bubblewrap execution is available only on Linux');
  }
  let stats;
  try {
    stats = await fs.promises.stat(binary);
  } catch (error) {
    return unavailable('BUBBLEWRAP_NOT_FOUND', 'The Bubblewrap executable is unavailable', {
      binary,
      cause: error.code,
    });
  }
  if (!stats.isFile()) {
    return unavailable('BUBBLEWRAP_INVALID', 'The Bubblewrap path is not a regular file', {
      binary,
    });
  }
  if ((stats.mode & 0o4_000) !== 0) {
    return unavailable('SETUID_BUBBLEWRAP_DENIED', 'Setuid Bubblewrap is not supported', {
      binary,
    });
  }
  if (!diagnostics.unprivilegedUserNamespacesEnabled || diagnostics.maximumUserNamespaces === 0) {
    return unavailable(
      'USER_NAMESPACES_UNAVAILABLE',
      'Unprivileged user namespaces are disabled by the running system',
      { binary }
    );
  }
  const versionResult = await runBoundedProcess(binary, ['--version'], options);
  if (versionResult.code !== 0) {
    return unavailable('BUBBLEWRAP_VERSION_FAILED', 'Bubblewrap version detection failed', {
      binary,
      diagnostic: boundedText(versionResult.stderr),
    });
  }
  const version = /bubblewrap\s+([^\s]+)/i.exec(versionResult.stdout)?.[1] || 'unknown';
  const probe = await runBoundedProcess(binary, capabilityProbeArguments(), options);
  if (probe.code !== 0) {
    return unavailable(
      'BUBBLEWRAP_PROBE_FAILED',
      diagnostics.appArmorRestrictsUnprivilegedUserNamespaces
        ? 'Bubblewrap could not create the required namespaces under the active AppArmor restriction'
        : 'Bubblewrap could not create the required namespaces',
      {
        binary,
        version,
        diagnostic: boundedText(probe.stderr),
      }
    );
  }
  return Object.freeze({
    backend: 'linux-bubblewrap',
    available: true,
    binary,
    version,
    diagnostics: Object.freeze(diagnostics),
    enforcement: Object.freeze({
      filesystem: true,
      networkNone: true,
      processNamespace: true,
      ipcNamespace: true,
      descendantInheritance: true,
      privateTemporaryStorage: true,
      closedFileDescriptors: true,
      wallTimeout: true,
      outputLimits: true,
      cancellation: true,
      cancellationGuarantee: 'namespace_scoped',
      customSeccomp: false,
      nestedUserNamespacesDisabled: true,
      aggregateResourceLimits: false,
    }),
  });
}

async function createLauncherStagingDirectory() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-bwrap-'));
  await fs.promises.chmod(directory, 0o700);
  await fs.promises.mkdir(path.join(directory, 'empty'), { mode: 0o755 });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 65_534;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 65_534;
  await Promise.all([
    fs.promises.writeFile(
      path.join(directory, 'passwd'),
      `sandbox:x:${uid}:${gid}:Freedom Sandbox:/tmp/home:/bin/sh\n`,
      { mode: 0o600 }
    ),
    fs.promises.writeFile(path.join(directory, 'group'), `sandbox:x:${gid}:\n`, { mode: 0o600 }),
    fs.promises.writeFile(
      path.join(directory, 'nsswitch.conf'),
      'passwd: files\ngroup: files\nhosts: files\n',
      {
        mode: 0o600,
      }
    ),
    fs.promises.writeFile(path.join(directory, 'hosts'), '127.0.0.1 localhost\n::1 localhost\n', {
      mode: 0o600,
    }),
  ]);
  return directory;
}

function addReadOnlyMount(args, sourcePath, mountPath) {
  args.push('--ro-bind', sourcePath, mountPath);
}

async function addProtectedMounts(args, policy, stagingDirectory) {
  let gitIndex = 0;
  for (const protectedPath of policy.filesystem.protectedPaths) {
    if (protectedPath.kind !== 'git_pointer') {
      addReadOnlyMount(args, protectedPath.sourcePath, protectedPath.mountPath);
      continue;
    }
    gitIndex += 1;
    const gitRoot = `/freedom-git-${gitIndex}`;
    const pointerFile = path.join(stagingDirectory, `git-pointer-${gitIndex}`);
    await fs.promises.writeFile(pointerFile, `gitdir: ${gitRoot}/gitdir\n`, { mode: 0o600 });
    args.push('--dir', gitRoot);
    addReadOnlyMount(args, protectedPath.gitDirectory, `${gitRoot}/gitdir`);
    if (protectedPath.hasGitDirectoryPointer) {
      const worktreePointer = path.join(stagingDirectory, `worktree-pointer-${gitIndex}`);
      await fs.promises.writeFile(worktreePointer, '/workspace/.git\n', { mode: 0o600 });
      addReadOnlyMount(args, worktreePointer, `${gitRoot}/gitdir/gitdir`);
    }
    if (protectedPath.commonDirectory !== protectedPath.gitDirectory) {
      addReadOnlyMount(args, protectedPath.commonDirectory, `${gitRoot}/common`);
    }
    if (protectedPath.hasCommonDirectoryPointer) {
      const commonPointer = path.join(stagingDirectory, `commondir-${gitIndex}`);
      await fs.promises.writeFile(
        commonPointer,
        protectedPath.commonDirectory === protectedPath.gitDirectory ? '.\n' : '../common\n',
        { mode: 0o600 }
      );
      addReadOnlyMount(args, commonPointer, `${gitRoot}/gitdir/commondir`);
    }
    addReadOnlyMount(args, pointerFile, protectedPath.mountPath);
  }
}

async function buildBubblewrapArguments(policy, request) {
  if (!isValidatedWorkspaceExecutionPolicy(policy)) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      'Execution policy was not issued by the trusted Freedom policy validator'
    );
  }
  if (policy.network !== NETWORK_POSTURES.NONE) {
    throw new ExecutionPolicyError(
      'UNSUPPORTED_NETWORK_POSTURE',
      'The Linux spike supports only network: none'
    );
  }
  if (policy.seccomp.requireCustomFilter) {
    throw new ExecutionPolicyError(
      'SECCOMP_UNAVAILABLE',
      'A reviewed custom seccomp filter is not available in this spike'
    );
  }
  if (!policy.filesystem.exposeSystemToolchain) {
    throw new ExecutionPolicyError(
      'SYSTEM_TOOLCHAIN_REQUIRED',
      'The first Linux backend requires the read-only system toolchain view'
    );
  }
  if (policy.limits.aggregate.required) {
    throw new ExecutionPolicyError(
      'RESOURCE_LIMIT_UNAVAILABLE',
      'Requested aggregate resource limits cannot be enforced by this backend'
    );
  }
  const normalizedRequest = validateExecutionRequest(request);
  const readinessMarker = `freedom-sandbox-ready-${crypto.randomUUID()}`;
  const stagingDirectory = await createLauncherStagingDirectory();
  try {
    const args = [
      '--unshare-all',
      '--unshare-user',
      '--disable-userns',
      '--assert-userns-disabled',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--hostname',
      'freedom-sandbox',
      '--json-status-fd',
      '3',
      '--clearenv',
    ];
    const pathEntries = [];
    for (const runtimeRoot of policy.filesystem.runtimeRoots) {
      args.push('--dir', path.posix.dirname(runtimeRoot.mountPath));
      addReadOnlyMount(args, runtimeRoot.sourcePath, runtimeRoot.mountPath);
      pathEntries.push(`${runtimeRoot.mountPath}/bin`);
    }
    if (policy.filesystem.exposeSystemToolchain) {
      for (const sourcePath of SYSTEM_RUNTIME_PATHS) {
        if (!fs.existsSync(sourcePath)) continue;
        addReadOnlyMount(args, sourcePath, sourcePath);
      }
      addReadOnlyMount(args, path.join(stagingDirectory, 'empty'), '/usr/local');
      args.push('--dir', '/etc');
      for (const sourcePath of SYSTEM_CONFIGURATION_PATHS) {
        if (!fs.existsSync(sourcePath)) continue;
        addReadOnlyMount(args, sourcePath, sourcePath);
      }
      pathEntries.push('/usr/bin', '/bin');
    }
    for (const name of ['passwd', 'group', 'nsswitch.conf', 'hosts']) {
      addReadOnlyMount(args, path.join(stagingDirectory, name), `/etc/${name}`);
    }
    args.push(
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--size',
      String(SHARED_MEMORY_SIZE_BYTES),
      '--perms',
      '1777',
      '--tmpfs',
      '/dev/shm',
      '--remount-ro',
      '/dev',
      '--size',
      String(PRIVATE_TEMP_SIZE_BYTES),
      '--perms',
      '1777',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/tmp/home',
      '--dir',
      '/tmp/cache',
      '--dir',
      '/tmp/config',
      '--dir',
      '/tmp/data'
    );
    const workspace = policy.filesystem.writableRoots.find((root) => root.id === 'workspace');
    if (!workspace) {
      throw new ExecutionPolicyError('INVALID_POLICY', 'Policy has no writable workspace root');
    }
    args.push('--bind', workspace.sourcePath, workspace.mountPath);
    await addProtectedMounts(args, policy, stagingDirectory);
    args.push('--remount-ro', '/proc', '--remount-ro', '/');

    const fixedEnvironment = {
      HOME: '/tmp/home',
      LOGNAME: 'sandbox',
      PATH: pathEntries.join(':'),
      SHELL: '/bin/sh',
      TMP: '/tmp',
      TMPDIR: '/tmp',
      TEMP: '/tmp',
      USER: 'sandbox',
      XDG_CACHE_HOME: '/tmp/cache',
      XDG_CONFIG_HOME: '/tmp/config',
      XDG_DATA_HOME: '/tmp/data',
    };
    for (const [name, value] of Object.entries({
      ...policy.environment.values,
      ...fixedEnvironment,
    })) {
      args.push('--setenv', name, value);
    }
    args.push(
      '--chdir',
      policy.workingDirectory,
      '--',
      '/bin/sh',
      '-c',
      'printf "%s\\n" "$1"; shift; exec 3>&-; exec "$@"',
      'freedom-sandbox-supervisor',
      readinessMarker,
      normalizedRequest.command,
      ...normalizedRequest.args
    );
    return Object.freeze({
      args: Object.freeze(args),
      request: normalizedRequest,
      stagingDirectory,
      readinessMarker,
      exposedSystemPaths: Object.freeze(
        policy.filesystem.exposeSystemToolchain
          ? [...SYSTEM_RUNTIME_PATHS, ...SYSTEM_CONFIGURATION_PATHS].filter((value) =>
              fs.existsSync(value)
            )
          : []
      ),
    });
  } catch (error) {
    try {
      await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
    } catch {
      // Preserve the policy-preparation failure that prevented command execution.
    }
    throw error;
  }
}

function parseStatusStream(stream, onStatus) {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      while (pending.includes('\n')) {
        const boundary = pending.indexOf('\n');
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        if (!line) continue;
        try {
          onStatus(JSON.parse(line));
        } catch {
          // A malformed status stream is handled as a sandbox initialization failure.
        }
      }
    });
    stream.on('end', () => {
      const line = pending.trim();
      if (line) {
        try {
          onStatus(JSON.parse(line));
        } catch {
          // See the initialization check in execute().
        }
      }
      resolve();
    });
    stream.on('error', reject);
  });
}

function selectInitialSandboxPid(currentPid, status) {
  if (currentPid !== null) return currentPid;
  const reportedPid = status?.['child-pid'];
  return Number.isSafeInteger(reportedPid) && reportedPid > 0 ? reportedPid : null;
}

function deniedReceipt(startedAt, now, code, message, diagnostics = {}) {
  return Object.freeze({
    backend: 'linux-bubblewrap',
    state: EXECUTION_STATES.SANDBOX_DENIED,
    startedAt,
    finishedAt: now,
    durationMs: Math.max(0, now - startedAt),
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    terminationGuarantee: 'not_applicable',
    error: Object.freeze({ code, message }),
    diagnostics: Object.freeze(diagnostics),
  });
}

class BubblewrapExecutor {
  constructor(options = {}) {
    this.binary = options.binary || DEFAULT_BUBBLEWRAP_PATH;
    this.spawnProcess = options.spawnProcess || spawn;
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.removeStagingDirectory =
      options.removeStagingDirectory ||
      ((directory) => fs.promises.rm(directory, { recursive: true, force: true }));
    this.capabilities = null;
  }

  async cleanupStagingDirectory(directory) {
    try {
      await this.removeStagingDirectory(directory);
      return null;
    } catch (error) {
      return Object.freeze({
        stagingCleanupFailed: true,
        cause: boundedText(error?.code || 'UNKNOWN', 64),
      });
    }
  }

  async detectCapabilities(options = {}) {
    if (this.capabilities && !options.force) return this.capabilities;
    this.capabilities = await detectBubblewrapCapabilities({
      binary: this.binary,
      spawnProcess: this.spawnProcess,
    });
    return this.capabilities;
  }

  async execute(policy, rawRequest = {}) {
    const startedAt = this.now();
    let capabilities;
    try {
      capabilities = await this.detectCapabilities();
    } catch {
      return deniedReceipt(
        startedAt,
        this.now(),
        'CAPABILITY_DETECTION_FAILED',
        'Freedom could not verify the Linux sandbox backend'
      );
    }
    if (!capabilities.available) {
      return deniedReceipt(
        startedAt,
        this.now(),
        capabilities.denial.code,
        capabilities.denial.message,
        capabilities.diagnostics
      );
    }
    let launch;
    try {
      launch = await buildBubblewrapArguments(policy, rawRequest);
    } catch (error) {
      const code = error instanceof ExecutionPolicyError ? error.code : 'POLICY_PREPARATION_FAILED';
      return deniedReceipt(
        startedAt,
        this.now(),
        code,
        error instanceof ExecutionPolicyError
          ? error.message
          : 'Freedom could not prepare the sandbox policy'
      );
    }
    if (launch.request.signal?.aborted) {
      const cleanupDiagnostics = await this.cleanupStagingDirectory(launch.stagingDirectory);
      const finishedAt = this.now();
      const receipt = {
        backend: 'linux-bubblewrap',
        state: EXECUTION_STATES.CANCELLED,
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
      };
      if (cleanupDiagnostics) receipt.diagnostics = cleanupDiagnostics;
      return Object.freeze(receipt);
    }

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnProcess(this.binary, launch.args, {
          env: { PATH: '/usr/bin:/bin' },
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        });
      } catch {
        this.cleanupStagingDirectory(launch.stagingDirectory).then((cleanupDiagnostics) => {
          resolve(
            deniedReceipt(
              startedAt,
              this.now(),
              'BUBBLEWRAP_LAUNCH_FAILED',
              'Freedom could not launch Bubblewrap',
              cleanupDiagnostics || {}
            )
          );
        });
        return;
      }

      const markerPrefix = `${launch.readinessMarker}\n`;
      const stdout = collectStream(
        child.stdout,
        policy.limits.stdoutBytes + Buffer.byteLength(markerPrefix)
      );
      const stderr = collectStream(child.stderr, policy.limits.stderrBytes);
      let namespaceCreated = false;
      let sandboxPid = null;
      let requestedState = null;
      let spawnError = null;
      let wallTimer = null;
      let abortListener = null;

      const statusDone = parseStatusStream(child.stdio?.[3], (status) => {
        const reportedPid = selectInitialSandboxPid(sandboxPid, status);
        if (sandboxPid === null && reportedPid !== null) {
          namespaceCreated = true;
          sandboxPid = reportedPid;
        }
      });

      const sendSignal = (signal) => {
        if (sandboxPid) {
          try {
            process.kill(sandboxPid, signal);
          } catch {
            // The namespace init may already have exited.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // The Bubblewrap supervisor may already have exited.
        }
      };
      const terminate = (state) => {
        if (requestedState) return;
        requestedState = state;
        // Killing Bubblewrap's namespace init tears down every descendant immediately. A TERM
        // sent to that init is not a graceful TERM delivery contract for the sandboxed command.
        sendSignal('SIGKILL');
      };

      wallTimer = this.setTimeout(
        () => terminate(EXECUTION_STATES.TIMED_OUT),
        policy.limits.timeoutMs
      );
      abortListener = () => terminate(EXECUTION_STATES.CANCELLED);
      launch.request.signal?.addEventListener('abort', abortListener, { once: true });
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', async (exitCode, signal) => {
        if (wallTimer) this.clearTimeout(wallTimer);
        launch.request.signal?.removeEventListener('abort', abortListener);
        await Promise.allSettled([stdout.done, stderr.done, statusDone]);
        const cleanupDiagnostics = await this.cleanupStagingDirectory(launch.stagingDirectory);
        const finishedAt = this.now();
        const rawOutput = stdout.result();
        const sandboxStarted = rawOutput.text.startsWith(markerPrefix);
        if (!sandboxStarted && !requestedState) {
          resolve(
            deniedReceipt(
              startedAt,
              finishedAt,
              spawnError ? 'BUBBLEWRAP_LAUNCH_FAILED' : 'SANDBOX_INITIALIZATION_FAILED',
              'Freedom refused to run the command because sandbox initialization failed',
              {
                cause: spawnError?.code || null,
                namespaceCreated,
                ...(cleanupDiagnostics || {}),
              }
            )
          );
          return;
        }
        const output = {
          text: rawOutput.text.slice(markerPrefix.length),
          truncated: rawOutput.truncated,
        };
        const errorOutput = stderr.result();
        const state =
          requestedState || (exitCode === 0 ? EXECUTION_STATES.COMPLETED : EXECUTION_STATES.FAILED);
        const receipt = {
          backend: 'linux-bubblewrap',
          state,
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          exitCode:
            state === EXECUTION_STATES.COMPLETED || state === EXECUTION_STATES.FAILED
              ? exitCode
              : null,
          signal: requestedState ? 'SIGKILL' : signal,
          stdout: output.text,
          stderr: errorOutput.text,
          stdoutTruncated: output.truncated,
          stderrTruncated: errorOutput.truncated,
          terminationGuarantee: 'namespace_scoped',
          capabilities: Object.freeze({
            backend: 'linux-bubblewrap',
            aggregateResourceLimits: false,
            customSeccomp: false,
          }),
        };
        if (state === EXECUTION_STATES.FAILED) {
          receipt.error = Object.freeze({
            code: 'COMMAND_FAILED',
            message: 'The sandboxed command exited unsuccessfully',
          });
        }
        if (cleanupDiagnostics) receipt.diagnostics = cleanupDiagnostics;
        resolve(Object.freeze(receipt));
      });
    });
  }
}

module.exports = {
  BubblewrapExecutor,
  CAPABILITY_PROBE_TIMEOUT_MS,
  DEFAULT_BUBBLEWRAP_PATH,
  PRIVATE_TEMP_SIZE_BYTES,
  SHARED_MEMORY_SIZE_BYTES,
  SYSTEM_CONFIGURATION_PATHS,
  SYSTEM_RUNTIME_PATHS,
  buildBubblewrapArguments,
  capabilityProbeArguments,
  collectStream,
  detectBubblewrapCapabilities,
  selectInitialSandboxPid,
};
