'use strict';

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
const { createReadinessOutputForwarder, notifyOutput } = require('./process-io');
const { runLinuxOwner, cleanupProven } = require('./linux-supervisor-process');
const { resolveLinuxSupervisor, assertOutsideWritableRoots } = require('./linux-supervisor-runtime');
const { executableCommandEntries, systemToolchainDirectories } = require('./executable-access');

const DEFAULT_BUBBLEWRAP_PATH = '/usr/bin/bwrap';
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
const PRIVATE_TEMP_SIZE_BYTES = 256 * 1024 * 1024;
const SHARED_MEMORY_SIZE_BYTES = 64 * 1024 * 1024;
const BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH = systemToolchainDirectories('linux').join(':');
const BUBBLEWRAP_SUPERVISOR_SHELL = '/bin/bash';
const DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS = Object.freeze([3, 4, 5, 6, 8]);
const DESCRIPTOR_CLOSURE_ASSERTION_SCRIPT = Object.freeze(
  [
    'for descriptor_path in /proc/self/fd/*; do',
    '  descriptor=${descriptor_path##*/}',
    '  case "$descriptor" in',
    "    ''|*[!0-9]*) continue ;;",
    '  esac',
    '  if [ "$descriptor" -gt 2 ] && target=$(readlink "$descriptor_path" 2>/dev/null); then',
    '    printf "unexpected descriptor %s: %s\\n" "$descriptor" "$target" >&2',
    '    exit 99',
    '  fi',
    'done',
  ].join('\n')
);
const DESCRIPTOR_CLOSURE_PROBE_MARKER = 'freedom-native-descriptor-closure-ready';
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

function collectStream(stream, maximumBytes, onData) {
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
      onData?.(buffer);
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

async function runBoundedProcess(binary, args, options = {}) {
  try {
    const result = await (options.runOwner || runLinuxOwner)(binary, args, {
      ...options, probe: options.probe !== false, timeoutMs: options.timeoutMs || CAPABILITY_PROBE_TIMEOUT_MS,
    });
    return { ...result, code: cleanupProven(result.final) && !result.error &&
      result.transportComplete && result.ownerExit?.code === 0 && result.final.reason === 'completed' ? result.code : null };
  } catch {
    return { code: null, stdout: '', stderr: 'LINUX_OWNER_UNAVAILABLE' };
  }
}

function baseCapabilityProbeArguments(gate = false) {
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
    '/bin',
    '/bin',
    '--ro-bind-try',
    '/sbin',
    '/sbin',
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
    ...(gate ? ['--dir', '/run', '--perms', '0555', '--ro-bind-data', '8', '/run/freedom-workspace-owner'] : []),
    '--remount-ro',
    '/',
    '--clearenv',
    '--setenv',
    'PATH',
    BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH,
    '--chdir',
    '/tmp',
  ];
}

function namespaceCapabilityProbeArguments() {
  return [...baseCapabilityProbeArguments(), '--', '/usr/bin/true'];
}

function capabilityProbeArguments() {
  return [
    ...baseCapabilityProbeArguments(true),
    '--',
    '/run/freedom-workspace-owner',
    '--gate',
    DESCRIPTOR_CLOSURE_PROBE_MARKER,
    BUBBLEWRAP_SUPERVISOR_SHELL,
    '-c',
    DESCRIPTOR_CLOSURE_ASSERTION_SCRIPT,
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
        closedFileDescriptors: false,
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
    if (versionResult.final?.reason === 'unavailable' || versionResult.error ||
        versionResult.stderr === 'LINUX_OWNER_UNAVAILABLE') {
      return unavailable('LINUX_OWNER_UNAVAILABLE',
        'Linux x64 workspace owner requires installed matching helper, clone3/pidfds, close_range and permitted user/PID namespaces',
        { ownerStage: versionResult.final?.stage || 'helper_or_transport', ownerErrno: versionResult.final?.error || null });
    }
    return unavailable('BUBBLEWRAP_VERSION_FAILED', 'Bubblewrap version detection failed', {
      binary,
      diagnostic: boundedText(versionResult.stderr),
    });
  }
  const version = /bubblewrap\s+([^\s]+)/i.exec(versionResult.stdout)?.[1] || 'unknown';
  const namespaceProbe = await runBoundedProcess(
    binary,
    namespaceCapabilityProbeArguments(),
    options
  );
  if (namespaceProbe.code !== 0) {
    return unavailable(
      'BUBBLEWRAP_PROBE_FAILED',
      diagnostics.appArmorRestrictsUnprivilegedUserNamespaces
        ? 'Bubblewrap could not create the required namespaces under the active AppArmor restriction'
        : 'Bubblewrap could not create the required namespaces',
      {
        binary,
        version,
        diagnostic: boundedText(namespaceProbe.stderr),
      }
    );
  }
  const descriptorProbe = await runBoundedProcess(binary, capabilityProbeArguments(), { ...options, probe: false });
  if (
    descriptorProbe.code !== 0 ||
    descriptorProbe.stdout !== `${DESCRIPTOR_CLOSURE_PROBE_MARKER}\n`
  ) {
    return unavailable(
      'NATIVE_DESCRIPTOR_CLOSURE_UNAVAILABLE',
      'Bubblewrap could not prove native gate descriptor closure inside the sandbox',
      {
        binary,
        version,
        bashPath: BUBBLEWRAP_SUPERVISOR_SHELL,
        descriptorClosureProbeDescriptors: DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS,
        diagnostic: boundedText(descriptorProbe.stderr),
      }
    );
  }
  diagnostics.bashPath = BUBBLEWRAP_SUPERVISOR_SHELL;
  diagnostics.descriptorClosureProbe = 'passed';
  diagnostics.descriptorClosureProbeDescriptors = DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS;
  return Object.freeze({
    backend: 'linux-bubblewrap',
    available: true,
    binary,
    version,
    diagnostics: Object.freeze(diagnostics),
    enforcement: Object.freeze({
      filesystem: true,
      networkNone: true,
      networkFull: 'host_namespace',
      loopbackNetworking: 'private_namespace',
      fullNetworkIncludesHostAbstractUnixSockets: true,
      processNamespace: true,
      ipcNamespace: true,
      descendantInheritance: true,
      privateTemporaryStorage: true,
      closedFileDescriptors: true,
      wallTimeout: true,
      outputLimits: true,
      cancellation: true,
      cancellationGuarantee: 'best_effort',
      survivorsPossible: true,
      completeDescendantTermination: false,
      customSeccomp: false,
      nestedUserNamespacesDisabled: true,
      aggregateResourceLimits: false,
    }),
  });
}

function nameServiceSwitchConfiguration(network) {
  // Only the explicit full posture names glibc's dns module, which reads the read-only
  // /etc/resolv.conf mounted for that posture. Every other posture resolves from the
  // staged hosts file alone, so no resolver ever consults DNS from the private namespace.
  const hosts = network === NETWORK_POSTURES.FULL ? 'files dns' : 'files';
  return `passwd: files\ngroup: files\nhosts: ${hosts}\n`;
}

async function createLauncherStagingDirectory(network) {
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
      nameServiceSwitchConfiguration(network),
      { mode: 0o600 }
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
  if (![NETWORK_POSTURES.NONE, NETWORK_POSTURES.FULL].includes(policy.network)) {
    throw new ExecutionPolicyError(
      'UNSUPPORTED_NETWORK_POSTURE',
      'The Linux backend supports only offline or full host networking'
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
  const stagingDirectory = await createLauncherStagingDirectory(policy.network);
  try {
    const args = [
      '--unshare-all',
      ...(policy.network === NETWORK_POSTURES.FULL ? ['--share-net'] : []),
      '--unshare-user',
      '--disable-userns',
      '--assert-userns-disabled',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--hostname',
      'freedom-sandbox',
      '--clearenv',
    ];
    const pathEntries = [];
    const commandEntries = executableCommandEntries(policy.filesystem.runtimeRoots, 'linux');
    if (commandEntries.length) {
      const commandDirectory = '/opt/freedom-toolchain/commands';
      args.push('--dir', commandDirectory);
      for (const { name, executablePath } of commandEntries) {
        args.push('--symlink', executablePath, `${commandDirectory}/${name}`);
      }
      pathEntries.push(commandDirectory);
    }
    for (const runtimeRoot of policy.filesystem.runtimeRoots) {
      args.push('--dir', path.posix.dirname(runtimeRoot.mountPath));
      addReadOnlyMount(args, runtimeRoot.sourcePath, runtimeRoot.mountPath);
      for (const relativePath of runtimeRoot.pathEntries || []) {
        pathEntries.push(
          relativePath === '.'
            ? runtimeRoot.mountPath
            : path.posix.join(
                runtimeRoot.mountPath,
                ...relativePath.split(path.sep).filter(Boolean)
              )
        );
      }
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
      pathEntries.push(...BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH.split(':'));
    }
    for (const name of ['passwd', 'group', 'nsswitch.conf', 'hosts']) {
      addReadOnlyMount(args, path.join(stagingDirectory, name), `/etc/${name}`);
    }
    if (policy.network === NETWORK_POSTURES.FULL && fs.existsSync('/etc/resolv.conf')) {
      addReadOnlyMount(args, fs.realpathSync('/etc/resolv.conf'), '/etc/resolv.conf');
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
    // fd8 is the pinned running native owner's inode, inherited only by bwrap.
    // ro-bind realpaths /proc/self/fd and would reopen a pathname. ro-bind-data
    // instead copies the pinned inode's bytes, then closes fd8 (bwrap v0.9.0).
    args.push('--dir', '/run', '--perms', '0555', '--ro-bind-data', '8', '/run/freedom-workspace-owner');
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
      '/run/freedom-workspace-owner',
      '--gate',
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
    sideEffects: 'none',
    error: Object.freeze({ code, message }),
    diagnostics: Object.freeze(diagnostics),
  });
}

class BubblewrapExecutor {
  constructor(options = {}) {
    this.binary = options.binary || DEFAULT_BUBBLEWRAP_PATH;
    this.runOwner = options.runOwner || runLinuxOwner;
    this.resolveOwner = options.resolveOwner || resolveLinuxSupervisor;
    this.now = options.now || Date.now;
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
    const capabilities = await detectBubblewrapCapabilities({
      binary: this.binary,
      runOwner: this.runOwner,
      resolveRuntime: this.resolveOwner,
      signal: options.signal,
    });
    if (!options.signal?.aborted) this.capabilities = capabilities;
    return capabilities;
  }

  async execute(policy, rawRequest = {}) {
    const startedAt = this.now();
    let capabilities;
    try {
      capabilities = await this.detectCapabilities({ signal: rawRequest.signal });
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
        sideEffects: 'none',
        survivorsPossible: false,
        completeDescendantTermination: true,
      };
      if (cleanupDiagnostics) receipt.diagnostics = cleanupDiagnostics;
      return Object.freeze(receipt);
    }

    let result;
    let runtime;
    const markerPrefix = `${launch.readinessMarker}\n`;
    const forwardStdout = createReadinessOutputForwarder(markerPrefix, launch.request.onOutput);
    const markerBytes = Buffer.from(markerPrefix);
    let prefix = Buffer.alloc(0), outputReady = false, readinessDecided = false;
    let pendingStderr = Buffer.alloc(0);
    try {
      runtime = await this.resolveOwner();
      assertOutsideWritableRoots(runtime, policy, launch.stagingDirectory);
      result = await this.runOwner(this.binary, launch.args, {
        runtime, timeoutMs: policy.limits.timeoutMs, signal: launch.request.signal,
        stdoutBytes: policy.limits.stdoutBytes + Buffer.byteLength(markerPrefix),
        stderrBytes: policy.limits.stderrBytes, onStdin: launch.request.onStdin,
        onOutput: (stream, chunk) => {
          if (stream === 'stdout') {
            if (!readinessDecided) {
              prefix = Buffer.concat([prefix, chunk.subarray(0, Math.max(0, markerBytes.length - prefix.length))]);
              if (prefix.length === markerBytes.length) {
                readinessDecided = true; outputReady = prefix.equals(markerBytes);
                if (outputReady && pendingStderr.length) notifyOutput(launch.request.onOutput, 'stderr', pendingStderr);
                pendingStderr = Buffer.alloc(0);
              }
            }
            forwardStdout(chunk);
          } else if (outputReady) notifyOutput(launch.request.onOutput, stream, chunk);
          else if (!readinessDecided) pendingStderr = Buffer.concat([pendingStderr,
            chunk.subarray(0, Math.max(0, policy.limits.stderrBytes - pendingStderr.length))]);
        },
      });
    } catch {
      if (runtime) await runtime.close().catch(() => {});
      result = { stdout: '', stderr: '', error: 'LINUX_OWNER_UNAVAILABLE', final: null };
    }
    const cleanupDiagnostics = await this.cleanupStagingDirectory(launch.stagingDirectory);
    const final = result.final;
    const complete = cleanupProven(final);
    const cancelled = final && ['cancelled', 'control_eof'].includes(final.reason);
    const timedOut = final?.reason === 'timed_out';
    const normal = final?.reason === 'completed' && complete && !result.error &&
      result.transportComplete && result.ownerExit?.code === 0;
    const denied = final && !final.released && (complete || !final.created);
    const sandboxStarted = result.stdout.startsWith(markerPrefix);
    const state = timedOut ? EXECUTION_STATES.TIMED_OUT : cancelled ? EXECUTION_STATES.CANCELLED :
      denied ? EXECUTION_STATES.SANDBOX_DENIED :
      normal ? (result.code === 0 ? EXECUTION_STATES.COMPLETED : EXECUTION_STATES.FAILED) :
        EXECUTION_STATES.FAILED;
    const finishedAt = this.now();
    // Only a validated native release-state record can establish no side effects.
    const receipt = {
      backend: 'linux-bubblewrap', state, startedAt, finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      exitCode: final?.monitorObserved && final.monitorCode >= 0 ? final.monitorCode : null,
      signal: final?.monitorSignal ? Object.keys(os.constants.signals)
        .find((key) => os.constants.signals[key] === final.monitorSignal) || null : null,
      stdout: sandboxStarted ? result.stdout.slice(markerPrefix.length) : '',
      stderr: sandboxStarted ? result.stderr : '', stdoutTruncated: !!result.stdoutTruncated, stderrTruncated: !!result.stderrTruncated,
      terminationGuarantee: complete ? 'namespace_scoped' : 'unknown',
      sideEffects: final && !final.released ? 'none' : 'unknown',
      survivorsPossible: !complete, completeDescendantTermination: complete,
      terminationScope: 'pid_namespace',
      capabilities: { backend: 'linux-bubblewrap', aggregateResourceLimits: false,
        cancellationGuarantee: complete ? 'namespace_scoped' : 'unknown',
        networkPosture: policy.network,
        publicNetworking: policy.network === NETWORK_POSTURES.FULL ? 'host_network' : 'denied',
        loopbackNetworking: policy.network === NETWORK_POSTURES.FULL ? 'host_network' : 'private_namespace',
        privateNetworking: policy.network === NETWORK_POSTURES.FULL ? 'host_network' : 'denied',
        hostAbstractUnixSockets: policy.network === NETWORK_POSTURES.FULL ? 'reachable' : 'isolated',
        survivorsPossible: !complete, completeDescendantTermination: complete, customSeccomp: false },
      diagnostics: { nativeOwner: final, ownerExit: result.ownerExit || null,
        ...(!sandboxStarted && { initializationDiagnostic: boundedText(result.stderr) }),
        transportComplete: !!result.transportComplete, requestedCancellation: !!result.requested,
        ...(cleanupDiagnostics || {}) },
    };
    if (!normal) receipt.error = { code: result.error || (denied ? 'SANDBOX_INITIALIZATION_FAILED' : 'LINUX_OWNER_INCOMPLETE'),
      message: 'Linux workspace execution did not produce a confirmed normal completion' };
    else if (state === EXECUTION_STATES.FAILED) receipt.error = {
      code: 'COMMAND_FAILED', message: 'The sandboxed command exited unsuccessfully' };
    return Object.freeze(receipt);
  }
}

module.exports = {
  BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH,
  BUBBLEWRAP_SUPERVISOR_SHELL,
  BubblewrapExecutor,
  CAPABILITY_PROBE_TIMEOUT_MS,
  DEFAULT_BUBBLEWRAP_PATH,
  DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS,
  DESCRIPTOR_CLOSURE_PROBE_MARKER,
  PRIVATE_TEMP_SIZE_BYTES,
  SHARED_MEMORY_SIZE_BYTES,
  SYSTEM_CONFIGURATION_PATHS,
  SYSTEM_RUNTIME_PATHS,
  buildBubblewrapArguments,
  capabilityProbeArguments,
  collectStream,
  detectBubblewrapCapabilities,
};
