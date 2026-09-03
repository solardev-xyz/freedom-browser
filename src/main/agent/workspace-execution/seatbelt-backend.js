'use strict';

const { execFile, execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EXECUTION_STATES,
  ExecutionPolicyError,
  NETWORK_POSTURES,
  insidePath,
  isValidatedWorkspaceExecutionPolicy,
  validateExecutionRequest,
} = require('./execution-policy');

const DEFAULT_SEATBELT_PATH = '/usr/bin/sandbox-exec';
const PROBE_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCED_RECEIPT_DELAY_MS = 250;
const PRIVATE_DIRECTORY_PREFIX = 'freedom-seatbelt-';
const SYSTEM_READ_PATHS = Object.freeze(['/System', '/usr', '/bin', '/sbin']);
const OPTIONAL_SYSTEM_READ_PATHS = Object.freeze([
  '/Library/Apple',
  '/Library/Developer/CommandLineTools',
  '/private/etc/hosts',
  '/private/etc/passwd',
  '/private/etc/group',
  '/private/etc/protocols',
  '/private/etc/services',
  '/private/etc/ssl/cert.pem',
]);
// Keep this list explicit. In particular, do not admit kern.proc.*, net.routetable.*,
// vm.loadavg or a hw.optional.arm.* prefix: those disclose host process/network state or
// grant substantially more authority than the qualified Node/Electron workloads require.
const SEATBELT_SYSCTL_READ_NAMES = Object.freeze([
  'hw.activecpu',
  'hw.byteorder',
  'hw.cacheconfig',
  'hw.cachelinesize_compat',
  'hw.cpufamily',
  'hw.cputype',
  'hw.l1dcachesize_compat',
  'hw.l1icachesize_compat',
  'hw.l2cachesize_compat',
  'hw.l3cachesize_compat',
  'hw.logicalcpu',
  'hw.logicalcpu_max',
  'hw.machine',
  'hw.ncpu',
  'hw.nperflevels',
  'hw.optional.arm.FEAT_BF16',
  'hw.optional.arm.FEAT_DotProd',
  'hw.optional.arm.FEAT_FCMA',
  'hw.optional.arm.FEAT_FHM',
  'hw.optional.arm.FEAT_FP16',
  'hw.optional.arm.FEAT_I8MM',
  'hw.optional.arm.FEAT_JSCVT',
  'hw.optional.arm.FEAT_LSE',
  'hw.optional.arm.FEAT_RDM',
  'hw.optional.arm.FEAT_SHA512',
  'hw.optional.armv8_2_sha512',
  'hw.packages',
  'hw.pagesize',
  'hw.pagesize_compat',
  'hw.perflevel0.cpusperl2',
  'hw.perflevel0.l1dcachesize',
  'hw.perflevel0.l1icachesize',
  'hw.perflevel0.l2cachesize',
  'hw.perflevel0.logicalcpu',
  'hw.perflevel0.logicalcpu_max',
  'hw.perflevel0.name',
  'hw.perflevel0.physicalcpu',
  'hw.perflevel0.physicalcpu_max',
  'hw.perflevel1.cpusperl2',
  'hw.perflevel1.l1dcachesize',
  'hw.perflevel1.l1icachesize',
  'hw.perflevel1.l2cachesize',
  'hw.perflevel1.logicalcpu',
  'hw.perflevel1.logicalcpu_max',
  'hw.perflevel1.name',
  'hw.perflevel1.physicalcpu',
  'hw.perflevel1.physicalcpu_max',
  'hw.physicalcpu',
  'hw.physicalcpu_max',
  'hw.vectorunit',
  'kern.argmax',
  'kern.hostname',
  'kern.maxfilesperproc',
  'kern.osproductversion',
  'kern.osrelease',
  'kern.ostype',
  'kern.osvariant_status',
  'kern.osversion',
  'kern.secure_kernel',
  'kern.sysv.semmns',
  'kern.tcsm_available',
  'kern.tcsm_enable',
  'kern.usrstack64',
  'kern.version',
  'sysctl.proc_cputype',
]);
const SEATBELT_NETWORK_MACH_SERVICES = Object.freeze([
  'com.apple.SecurityServer',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.SystemConfiguration.configd',
  'com.apple.networkd',
  'com.apple.ocspd',
  'com.apple.trustd.agent',
]);

function boundedText(value, maximum = 512) {
  return String(value || '').slice(0, maximum);
}

function signalProcessGroup(processGroupId, signal, killProcess = process.kill) {
  try {
    killProcess(-processGroupId, signal);
    return null;
  } catch (error) {
    if (error?.code === 'ESRCH') return null;
    return Object.freeze({
      signal,
      code: boundedText(error?.code || 'UNKNOWN', 64),
    });
  }
}

function execFileResult(binary, args, options = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, options, (error, stdout, stderr) => {
      resolve({
        error,
        exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
        signal: error?.signal || null,
        stdout: boundedText(stdout),
        stderr: boundedText(stderr),
      });
    });
  });
}

function seatbeltString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function pathRule(action, operation, filter, candidate) {
  return `(${action} ${operation} (${filter} ${seatbeltString(candidate)}))`;
}

function sysctlReadRule() {
  return [
    '(allow sysctl-read',
    ...SEATBELT_SYSCTL_READ_NAMES.map((name) => `  (sysctl-name ${seatbeltString(name)})`),
    ')',
  ].join('\n');
}

function fullNetworkRules() {
  return [
    '(allow network-outbound)',
    '(allow network-inbound)',
    [
      '(allow system-socket',
      '  (require-all',
      '    (socket-domain AF_SYSTEM)',
      '    (socket-protocol 2)',
      '  )',
      ')',
    ].join('\n'),
    [
      '(allow mach-lookup',
      ...SEATBELT_NETWORK_MACH_SERVICES.map(
        (service) => `  (global-name ${seatbeltString(service)})`
      ),
      ')',
    ].join('\n'),
    '(allow sysctl-read (sysctl-name-regex #"^net\\.routetable"))',
  ];
}

function protectedPathFilter(protectedPath) {
  return protectedPath.kind === 'file' || protectedPath.kind === 'git_pointer'
    ? 'literal'
    : 'subpath';
}

function systemReadPaths() {
  return [...SYSTEM_READ_PATHS, ...OPTIONAL_SYSTEM_READ_PATHS].filter((value) =>
    fs.existsSync(value)
  );
}

function systemToolchainPath() {
  return ['/Library/Developer/CommandLineTools/usr/bin', '/usr/bin', '/bin']
    .filter((value) => fs.existsSync(value))
    .join(':');
}

function capabilityProbeProfile() {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info-pidinfo (target same-sandbox))',
    sysctlReadRule(),
    '(allow file-read-metadata)',
    pathRule('allow', 'file-read-data', 'literal', '/'),
  ];
  for (const systemPath of systemReadPaths()) {
    const directory = fs.statSync(systemPath).isDirectory();
    const filter = directory ? 'subpath' : 'literal';
    lines.push(pathRule('allow', 'file-read*', filter, systemPath));
    if (directory) lines.push(pathRule('allow', 'process-exec', filter, systemPath));
  }
  lines.push('(deny network*)');
  return lines.join('');
}

function discoverRuntimeReadPaths(runtimeRoots) {
  const paths = new Set();
  for (const runtimeRoot of runtimeRoots) {
    for (const executable of runtimeRoot.executablePaths || []) {
      if (!fs.existsSync(executable)) continue;
      let output;
      try {
        output = execFileSync('/usr/bin/otool', ['-L', executable], {
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS,
        });
      } catch {
        continue;
      }
      for (const line of output.split('\n').slice(1)) {
        const dependency = line.trim().split(/\s+/)[0];
        if (
          !dependency?.startsWith('/') ||
          dependency.startsWith('/System/') ||
          dependency.startsWith('/usr/')
        ) {
          continue;
        }
        const homebrewMatch = /^(\/opt\/homebrew\/opt\/[^/]+)/.exec(dependency);
        const exposedPath = homebrewMatch?.[1] || dependency;
        paths.add(exposedPath);
        if (homebrewMatch) {
          const configurationPath = path.join('/opt/homebrew/etc', path.basename(homebrewMatch[1]));
          if (fs.existsSync(configurationPath)) paths.add(configurationPath);
        }
        try {
          paths.add(fs.realpathSync(exposedPath));
        } catch {
          // The dynamic loader will fail closed if a declared dependency disappears.
        }
      }
    }
  }
  return [...paths];
}

function buildSeatbeltProfile(policy, privateDirectory) {
  if (!isValidatedWorkspaceExecutionPolicy(policy)) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      'Execution policy was not issued by the trusted Freedom policy validator'
    );
  }
  if (![NETWORK_POSTURES.NONE, NETWORK_POSTURES.FULL].includes(policy.network)) {
    throw new ExecutionPolicyError(
      'UNSUPPORTED_NETWORK_POSTURE',
      'The macOS backend supports only offline or full IP networking'
    );
  }
  if (policy.seccomp.requireCustomFilter) {
    throw new ExecutionPolicyError(
      'SECCOMP_UNAVAILABLE',
      'Seatbelt cannot provide the requested Linux seccomp property'
    );
  }
  if (policy.limits.aggregate.required) {
    throw new ExecutionPolicyError(
      'RESOURCE_LIMIT_UNAVAILABLE',
      'Requested aggregate descendant-tree resource limits are unavailable on macOS'
    );
  }
  let canonicalPrivateDirectory;
  try {
    canonicalPrivateDirectory = fs.realpathSync(privateDirectory);
  } catch {
    canonicalPrivateDirectory = null;
  }
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (
    typeof privateDirectory !== 'string' ||
    canonicalPrivateDirectory !== privateDirectory ||
    path.dirname(canonicalPrivateDirectory || '') !== temporaryRoot ||
    path.basename(canonicalPrivateDirectory || '').startsWith(PRIVATE_DIRECTORY_PREFIX) === false
  ) {
    throw new ExecutionPolicyError(
      'INVALID_PRIVATE_DIRECTORY',
      'Seatbelt private storage must be a validated absolute execution directory'
    );
  }
  const workspace = policy.filesystem.writableRoots.find((root) => root.id === 'workspace');
  if (!workspace) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'Policy has no writable workspace root');
  }
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info-pidinfo (target same-sandbox))',
    sysctlReadRule(),
    // dyld and common command-line runtimes probe parent directories before opening allowed files.
    // This reveals pathname metadata, not file contents; the residual disclosure is documented.
    '(allow file-read-metadata)',
    pathRule('allow', 'file-read-data', 'literal', '/'),
    pathRule('allow', 'file-read*', 'literal', '/dev/null'),
    pathRule('allow', 'file-write*', 'literal', '/dev/null'),
    pathRule('allow', 'file-read*', 'literal', '/dev/urandom'),
    pathRule('allow', 'file-read*', 'literal', '/dev/random'),
  ];
  if (policy.filesystem.exposeSystemToolchain) {
    for (const systemPath of systemReadPaths()) {
      const directory = fs.statSync(systemPath).isDirectory();
      const filter = directory ? 'subpath' : 'literal';
      lines.push(pathRule('allow', 'file-read*', filter, systemPath));
      if (directory) lines.push(pathRule('allow', 'process-exec', filter, systemPath));
    }
  }
  if (
    fs.existsSync('/usr/local') &&
    !policy.filesystem.runtimeRoots.some((root) => insidePath('/usr/local', root.sourcePath))
  ) {
    lines.push(pathRule('deny', 'file-read*', 'subpath', '/usr/local'));
  }
  for (const runtimeRoot of policy.filesystem.runtimeRoots) {
    lines.push(pathRule('allow', 'file-read*', 'subpath', runtimeRoot.sourcePath));
    lines.push(pathRule('allow', 'process-exec', 'subpath', runtimeRoot.sourcePath));
  }
  for (const runtimePath of discoverRuntimeReadPaths(policy.filesystem.runtimeRoots)) {
    const filter = fs.statSync(runtimePath).isDirectory() ? 'subpath' : 'literal';
    lines.push(pathRule('allow', 'file-read*', filter, runtimePath));
  }
  lines.push(pathRule('allow', 'file-read*', 'subpath', workspace.sourcePath));
  lines.push(pathRule('allow', 'file-write*', 'subpath', workspace.sourcePath));
  lines.push(pathRule('allow', 'process-exec', 'subpath', workspace.sourcePath));
  lines.push(pathRule('allow', 'file-read*', 'subpath', privateDirectory));
  lines.push(pathRule('allow', 'file-write*', 'subpath', privateDirectory));
  lines.push(pathRule('allow', 'process-exec', 'subpath', privateDirectory));
  for (const protectedPath of policy.filesystem.protectedPaths) {
    lines.push(
      pathRule('deny', 'file-write*', protectedPathFilter(protectedPath), protectedPath.sourcePath)
    );
    if (protectedPath.kind === 'git_pointer') {
      for (const metadataPath of new Set([
        protectedPath.gitDirectory,
        protectedPath.commonDirectory,
      ])) {
        lines.push(pathRule('allow', 'file-read*', 'subpath', metadataPath));
        lines.push(pathRule('deny', 'file-write*', 'subpath', metadataPath));
      }
    }
  }
  if (policy.network === NETWORK_POSTURES.FULL) {
    lines.push(...fullNetworkRules());
  } else {
    lines.push('(deny network*)');
  }
  return `${lines.join('\n')}\n`;
}

function unavailableCapabilities(denial, diagnostics = {}) {
  return Object.freeze({
    backend: 'macos-seatbelt',
    available: false,
    denial: Object.freeze(denial),
    diagnostics: Object.freeze(diagnostics),
    enforcement: Object.freeze({
      filesystem: false,
      networkNone: false,
      loopbackNetworking: 'unavailable',
      descendantInheritance: false,
      privateTemporaryStorage: false,
      closedFileDescriptors: false,
      executableRootsScoped: false,
      wallTimeout: false,
      outputLimits: false,
      cancellation: false,
      cancellationGuarantee: 'best_effort',
      survivorsPossible: false,
      completeDescendantTermination: false,
      aggregateResourceLimits: false,
    }),
  });
}

async function createPrivateDirectory() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), PRIVATE_DIRECTORY_PREFIX));
  await fs.promises.chmod(directory, 0o700);
  for (const name of ['home', 'tmp', 'cache', 'config', 'data']) {
    await fs.promises.mkdir(path.join(directory, name), { mode: 0o700 });
  }
  return fs.promises.realpath(directory);
}

async function detectSeatbeltCapabilities(options = {}) {
  const binary = options.binary || DEFAULT_SEATBELT_PATH;
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const release = options.release || os.release();
  const run = options.run || execFileResult;
  if (platform !== 'darwin') {
    return unavailableCapabilities(
      { code: 'SEATBELT_PLATFORM_UNAVAILABLE', message: 'Seatbelt requires macOS' },
      { platform, architecture, release }
    );
  }
  let stats;
  try {
    stats = await fs.promises.stat(binary);
  } catch (error) {
    return unavailableCapabilities(
      { code: 'SANDBOX_EXEC_NOT_FOUND', message: 'The macOS Seatbelt launcher was not found' },
      { platform, architecture, release, cause: error.code }
    );
  }
  if (!stats.isFile()) {
    return unavailableCapabilities(
      { code: 'SANDBOX_EXEC_NOT_FOUND', message: 'The macOS Seatbelt launcher is not a file' },
      { platform, architecture, release }
    );
  }
  const initialization = await run(binary, ['-p', capabilityProbeProfile(), '/usr/bin/true'], {
    timeout: PROBE_TIMEOUT_MS,
  });
  const diagnostics = {
    platform,
    architecture,
    release,
    binary,
    deprecatedPublicInterface: true,
  };
  if (initialization.exitCode !== 0) {
    return unavailableCapabilities(
      {
        code: 'SEATBELT_INITIALIZATION_FAILED',
        message: 'Freedom could not initialize a representative Seatbelt profile',
      },
      {
        ...diagnostics,
        initializationDiagnostic: boundedText(initialization.stderr),
        initializationSignal: initialization.signal,
      }
    );
  }
  return Object.freeze({
    backend: 'macos-seatbelt',
    available: true,
    binary,
    diagnostics: Object.freeze({
      ...diagnostics,
      profileApplicationReadiness: 'passed',
      denialSemanticsProbe: 'not_run',
    }),
    enforcement: Object.freeze({
      filesystem: true,
      networkNone: true,
      networkFull: 'seatbelt_ip',
      loopbackNetworking: 'denied',
      fullNetworkIncludesHostUnixSockets: false,
      descendantInheritance: true,
      privateTemporaryStorage: true,
      closedFileDescriptors: true,
      executableRootsScoped: true,
      wallTimeout: true,
      outputLimits: true,
      cancellation: true,
      cancellationGuarantee: 'best_effort',
      survivorsPossible: true,
      completeDescendantTermination: false,
      processVisibility: 'same_sandbox_only',
      aggregateResourceLimits: false,
    }),
  });
}

function collectStream(stream, limit) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  stream?.on('data', (chunk) => {
    const buffer = Buffer.from(chunk);
    const available = Math.max(0, limit - bytes);
    if (available > 0) {
      const accepted = buffer.subarray(0, available);
      chunks.push(accepted);
      bytes += accepted.length;
    }
    if (buffer.length > available) truncated = true;
  });
  return Object.freeze({
    result() {
      return Object.freeze({ text: Buffer.concat(chunks).toString('utf8'), truncated });
    },
    stop() {
      stream?.destroy();
    },
  });
}

function deniedReceipt(startedAt, finishedAt, code, message, diagnostics = {}) {
  return Object.freeze({
    backend: 'macos-seatbelt',
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
    error: Object.freeze({ code, message }),
    diagnostics: Object.freeze(diagnostics),
  });
}

function hostWorkingDirectory(policy, workspace) {
  const relative = path.posix.relative('/workspace', policy.workingDirectory);
  return path.join(workspace.sourcePath, ...relative.split('/').filter(Boolean));
}

class SeatbeltExecutor {
  constructor(options = {}) {
    this.binary = options.binary || DEFAULT_SEATBELT_PATH;
    this.spawnProcess = options.spawnProcess || spawn;
    this.killProcess = options.killProcess || process.kill;
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.removePrivateDirectory =
      options.removePrivateDirectory ||
      ((directory) => fs.promises.rm(directory, { recursive: true, force: true }));
    this.capabilityOptions = options.capabilityOptions || {};
    this.capabilities = null;
  }

  async detectCapabilities(options = {}) {
    if (this.capabilities && !options.force) return this.capabilities;
    this.capabilities = await detectSeatbeltCapabilities({
      binary: this.binary,
      ...this.capabilityOptions,
      ...options,
    });
    return this.capabilities;
  }

  async cleanupPrivateDirectory(directory) {
    try {
      await this.removePrivateDirectory(directory);
      return null;
    } catch (error) {
      return Object.freeze({
        privateDirectoryCleanupFailed: true,
        cause: boundedText(error?.code || 'UNKNOWN', 64),
      });
    }
  }

  async execute(policy, rawRequest = {}) {
    const startedAt = this.now();
    if (!isValidatedWorkspaceExecutionPolicy(policy)) {
      return deniedReceipt(
        startedAt,
        this.now(),
        'INVALID_POLICY',
        'Execution policy was not issued by the trusted Freedom policy validator'
      );
    }
    let request;
    try {
      request = validateExecutionRequest(rawRequest);
    } catch (error) {
      return deniedReceipt(startedAt, this.now(), error.code, error.message);
    }
    const capabilities = await this.detectCapabilities();
    if (!capabilities.available) {
      return deniedReceipt(
        startedAt,
        this.now(),
        capabilities.denial.code,
        capabilities.denial.message,
        capabilities.diagnostics
      );
    }
    let privateDirectory;
    let profile;
    const readinessMarker = `freedom-seatbelt-ready-${crypto.randomUUID()}`;
    try {
      privateDirectory = await createPrivateDirectory();
      profile = buildSeatbeltProfile(policy, privateDirectory);
      await fs.promises.writeFile(path.join(privateDirectory, 'profile.sb'), profile, {
        mode: 0o600,
      });
    } catch (error) {
      if (privateDirectory) await this.cleanupPrivateDirectory(privateDirectory);
      const code = error instanceof ExecutionPolicyError ? error.code : 'POLICY_PREPARATION_FAILED';
      return deniedReceipt(
        startedAt,
        this.now(),
        code,
        error instanceof ExecutionPolicyError
          ? error.message
          : 'Freedom could not prepare the macOS sandbox policy'
      );
    }
    if (request.signal?.aborted) {
      const cleanup = await this.cleanupPrivateDirectory(privateDirectory);
      const finishedAt = this.now();
      return Object.freeze({
        backend: 'macos-seatbelt',
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
        ...(cleanup ? { diagnostics: cleanup } : {}),
      });
    }

    const workspace = policy.filesystem.writableRoots.find((root) => root.id === 'workspace');
    const runtimePath = policy.filesystem.runtimeRoots.flatMap((root) =>
      (root.pathEntries || []).map((relativePath) =>
        relativePath === '.' ? root.sourcePath : path.join(root.sourcePath, relativePath)
      )
    );
    const environment = {
      ...policy.environment.values,
      GIT_OPTIONAL_LOCKS: '0',
      HOME: path.join(privateDirectory, 'home'),
      LOGNAME: 'sandbox',
      PATH: [...runtimePath, systemToolchainPath()].join(':'),
      SHELL: '/bin/sh',
      TMP: path.join(privateDirectory, 'tmp'),
      TMPDIR: path.join(privateDirectory, 'tmp'),
      TEMP: path.join(privateDirectory, 'tmp'),
      USER: 'sandbox',
      XDG_CACHE_HOME: path.join(privateDirectory, 'cache'),
      XDG_CONFIG_HOME: path.join(privateDirectory, 'config'),
      XDG_DATA_HOME: path.join(privateDirectory, 'data'),
    };
    const markerPrefix = `${readinessMarker}\n`;
    const args = [
      '-f',
      path.join(privateDirectory, 'profile.sb'),
      '/bin/sh',
      '-c',
      'printf "%s\\n" "$1"; shift; exec "$@"',
      'freedom-seatbelt-supervisor',
      readinessMarker,
      request.command,
      ...request.args,
    ];

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnProcess(this.binary, args, {
          cwd: hostWorkingDirectory(policy, workspace),
          detached: true,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        this.cleanupPrivateDirectory(privateDirectory).then((cleanup) => {
          resolve(
            deniedReceipt(
              startedAt,
              this.now(),
              'SEATBELT_LAUNCH_FAILED',
              'Freedom could not launch the macOS sandbox',
              cleanup || {}
            )
          );
        });
        return;
      }

      const stdout = collectStream(
        child.stdout,
        policy.limits.stdoutBytes + Buffer.byteLength(markerPrefix)
      );
      const stderr = collectStream(child.stderr, policy.limits.stderrBytes);
      let requestedState = null;
      let spawnError = null;
      let terminationTimer = null;
      let forcedReceiptTimer = null;
      let wallTimer = null;
      let abortListener = null;
      let settled = false;
      const processGroupSignalErrors = [];

      const signalGroup = (signal, phase) => {
        const error = signalProcessGroup(child.pid, signal, this.killProcess);
        if (error) {
          processGroupSignalErrors.push(
            Object.freeze({
              phase,
              ...error,
            })
          );
        }
      };
      const finalize = async (exitCode, signal, forced = false) => {
        if (settled) return;
        settled = true;
        // Direct-child close does not imply that every member of its process group exited.
        // Make cleanup an invariant of every spawned receipt before clearing escalation timers.
        signalGroup('SIGKILL', 'finalization');
        if (wallTimer) this.clearTimeout(wallTimer);
        if (terminationTimer) this.clearTimeout(terminationTimer);
        if (forcedReceiptTimer) this.clearTimeout(forcedReceiptTimer);
        request.signal?.removeEventListener('abort', abortListener);
        if (forced) {
          stdout.stop();
          stderr.stop();
          child.unref?.();
        }
        const rawOutput = stdout.result();
        const errorOutput = stderr.result();
        const sandboxStarted = rawOutput.text.startsWith(markerPrefix);
        const cleanup = await this.cleanupPrivateDirectory(privateDirectory);
        const finishedAt = this.now();
        if (!sandboxStarted && !requestedState) {
          resolve(
            deniedReceipt(
              startedAt,
              finishedAt,
              spawnError ? 'SEATBELT_LAUNCH_FAILED' : 'SEATBELT_INITIALIZATION_FAILED',
              'Freedom refused to run the command because Seatbelt initialization failed',
              {
                cause: spawnError?.code || null,
                signal,
                processGroupFinalKillAttempted: true,
                ...(processGroupSignalErrors.length > 0
                  ? { processGroupSignalErrors: Object.freeze([...processGroupSignalErrors]) }
                  : {}),
                ...(cleanup || {}),
              }
            )
          );
          return;
        }
        const state =
          requestedState || (exitCode === 0 ? EXECUTION_STATES.COMPLETED : EXECUTION_STATES.FAILED);
        const receipt = {
          backend: 'macos-seatbelt',
          state,
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          exitCode:
            state === EXECUTION_STATES.COMPLETED || state === EXECUTION_STATES.FAILED
              ? exitCode
              : null,
          signal: signal || (requestedState ? 'SIGTERM' : null),
          stdout: sandboxStarted ? rawOutput.text.slice(markerPrefix.length) : '',
          stderr: errorOutput.text,
          stdoutTruncated: rawOutput.truncated,
          stderrTruncated: errorOutput.truncated,
          terminationGuarantee: 'best_effort',
          sideEffects: 'unknown',
          survivorsPossible: true,
          completeDescendantTermination: false,
          terminationScope: 'original_process_group',
          capabilities: Object.freeze({
            backend: 'macos-seatbelt',
            aggregateResourceLimits: false,
            cancellationGuarantee: 'best_effort',
            executableRootsScoped: true,
            networkPosture: policy.network,
            publicNetworking:
              policy.network === NETWORK_POSTURES.FULL ? 'host_network' : 'denied',
            loopbackNetworking:
              policy.network === NETWORK_POSTURES.FULL ? 'host_network' : 'denied',
            privateNetworking:
              policy.network === NETWORK_POSTURES.FULL ? 'host_network' : 'denied',
            hostUnixSockets: 'denied_unless_filesystem_authorized',
            platformNetworkServices:
              policy.network === NETWORK_POSTURES.FULL ? 'dns_tls_configuration' : 'denied',
            survivorsPossible: true,
            completeDescendantTermination: false,
          }),
        };
        if (state === EXECUTION_STATES.FAILED) {
          receipt.error = Object.freeze({
            code: 'COMMAND_FAILED',
            message: 'The sandboxed command exited unsuccessfully',
          });
        }
        receipt.diagnostics = Object.freeze({
          processGroupFinalKillAttempted: true,
          ...(processGroupSignalErrors.length > 0
            ? { processGroupSignalErrors: Object.freeze([...processGroupSignalErrors]) }
            : {}),
          ...(forced ? { processGroupCleanupBoundExpired: true } : {}),
          ...(cleanup || {}),
        });
        resolve(Object.freeze(receipt));
      };
      const terminate = (state) => {
        if (requestedState) return;
        requestedState = state;
        signalGroup('SIGTERM', 'termination_requested');
        terminationTimer = this.setTimeout(() => {
          signalGroup('SIGKILL', 'termination_grace_expired');
          forcedReceiptTimer = this.setTimeout(
            () => finalize(null, 'SIGKILL', true),
            FORCED_RECEIPT_DELAY_MS
          );
        }, TERMINATION_GRACE_MS);
      };

      wallTimer = this.setTimeout(
        () => terminate(EXECUTION_STATES.TIMED_OUT),
        policy.limits.timeoutMs
      );
      abortListener = () => terminate(EXECUTION_STATES.CANCELLED);
      request.signal?.addEventListener('abort', abortListener, { once: true });
      if (request.signal?.aborted) terminate(EXECUTION_STATES.CANCELLED);
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (exitCode, signal) => finalize(exitCode, signal));
    });
  }
}

module.exports = {
  DEFAULT_SEATBELT_PATH,
  FORCED_RECEIPT_DELAY_MS,
  OPTIONAL_SYSTEM_READ_PATHS,
  PRIVATE_DIRECTORY_PREFIX,
  PROBE_TIMEOUT_MS,
  SEATBELT_SYSCTL_READ_NAMES,
  SEATBELT_NETWORK_MACH_SERVICES,
  SYSTEM_READ_PATHS,
  SeatbeltExecutor,
  TERMINATION_GRACE_MS,
  buildSeatbeltProfile,
  capabilityProbeProfile,
  collectStream,
  createPrivateDirectory,
  detectSeatbeltCapabilities,
  discoverRuntimeReadPaths,
  hostWorkingDirectory,
  seatbeltString,
  signalProcessGroup,
  sysctlReadRule,
};
