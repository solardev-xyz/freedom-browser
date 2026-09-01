'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EXECUTION_STATES,
  ExecutionPolicyError,
  isValidatedWorkspaceExecutionPolicy,
  validateExecutionRequest,
} = require('./execution-policy');

const DEFAULT_SEATBELT_PATH = '/usr/bin/sandbox-exec';
const QUALIFIED_MACOS_VERSION = '15.6';
const QUALIFIED_MACOS_BUILD = '24G84';
const QUALIFIED_ARCHITECTURE = 'arm64';
const PROBE_TIMEOUT_MS = 5_000;

function boundedText(value, maximum = 512) {
  return String(value || '').slice(0, maximum);
}

function execFileResult(binary, args, options = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, options, (error, stdout, stderr) => {
      resolve({
        error,
        exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
        stdout: boundedText(stdout),
        stderr: boundedText(stderr),
      });
    });
  });
}

function seatbeltString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function addPathRule(lines, operation, filter, candidate) {
  lines.push(`(allow ${operation} (${filter} ${seatbeltString(candidate)}))`);
}

function buildSeatbeltProfile(policy, privateDirectory) {
  if (!isValidatedWorkspaceExecutionPolicy(policy)) {
    throw new ExecutionPolicyError(
      'INVALID_POLICY',
      'Execution policy was not issued by the trusted Freedom policy validator'
    );
  }
  if (policy.network !== 'none') {
    throw new ExecutionPolicyError(
      'UNSUPPORTED_NETWORK_POSTURE',
      'The macOS spike supports only network: none'
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
  if (typeof privateDirectory !== 'string' || !path.isAbsolute(privateDirectory)) {
    throw new ExecutionPolicyError(
      'INVALID_PRIVATE_DIRECTORY',
      'Seatbelt private storage must be an absolute path'
    );
  }

  const workspace = policy.filesystem.writableRoots.find((root) => root.id === 'workspace');
  if (!workspace) {
    throw new ExecutionPolicyError('INVALID_POLICY', 'Policy has no writable workspace root');
  }
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
  ];
  if (policy.filesystem.exposeSystemToolchain) {
    for (const systemPath of ['/System', '/usr', '/bin', '/sbin']) {
      addPathRule(lines, 'file-read*', 'subpath', systemPath);
    }
  }
  for (const runtimeRoot of policy.filesystem.runtimeRoots) {
    addPathRule(lines, 'file-read*', 'subpath', runtimeRoot.sourcePath);
  }
  addPathRule(lines, 'file-read*', 'subpath', workspace.sourcePath);
  addPathRule(lines, 'file-write*', 'subpath', workspace.sourcePath);
  addPathRule(lines, 'file-read*', 'subpath', privateDirectory);
  addPathRule(lines, 'file-write*', 'subpath', privateDirectory);
  for (const protectedPath of policy.filesystem.protectedPaths) {
    addPathRule(lines, 'file-write*', 'subpath', protectedPath.sourcePath);
    lines[lines.length - 1] = lines[lines.length - 1].replace('(allow ', '(deny ');
    if (protectedPath.kind === 'git_pointer') {
      for (const metadataPath of [protectedPath.gitDirectory, protectedPath.commonDirectory]) {
        addPathRule(lines, 'file-read*', 'subpath', metadataPath);
        addPathRule(lines, 'file-write*', 'subpath', metadataPath);
        lines[lines.length - 1] = lines[lines.length - 1].replace('(allow ', '(deny ');
      }
    }
  }
  lines.push('(deny network*)');
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
      processIsolation: false,
      descendantInheritance: true,
      privateTemporaryStorage: false,
      closedFileDescriptors: false,
      wallTimeout: true,
      outputLimits: true,
      cancellation: false,
      aggregateResourceLimits: false,
    }),
  });
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
  const [versionResult, buildResult] = await Promise.all([
    run('/usr/bin/sw_vers', ['-productVersion'], { timeout: PROBE_TIMEOUT_MS }),
    run('/usr/bin/sw_vers', ['-buildVersion'], { timeout: PROBE_TIMEOUT_MS }),
  ]);
  const version = versionResult.stdout.trim();
  const build = buildResult.stdout.trim();
  const diagnostics = { platform, architecture, release, version, build, binary };
  if (
    architecture !== QUALIFIED_ARCHITECTURE ||
    version !== QUALIFIED_MACOS_VERSION ||
    build !== QUALIFIED_MACOS_BUILD
  ) {
    return unavailableCapabilities(
      {
        code: 'UNQUALIFIED_MACOS_BUILD',
        message: 'This macOS build has not been qualified for the experimental Seatbelt backend',
      },
      diagnostics
    );
  }
  const initialization = await run(
    binary,
    [
      '-p',
      '(version 1)(allow default)(deny network*)',
      '/usr/bin/true',
    ],
    { timeout: PROBE_TIMEOUT_MS }
  );
  if (initialization.exitCode !== 0) {
    return unavailableCapabilities(
      {
        code: 'SEATBELT_INITIALIZATION_FAILED',
        message: 'Freedom could not initialize a representative Seatbelt profile',
      },
      { ...diagnostics, initializationDiagnostic: boundedText(initialization.stderr) }
    );
  }
  const sessionEscape = await run(
    binary,
    [
      '-p',
      '(version 1)(allow default)(deny process-info-setcontrol)',
      '/usr/bin/python3',
      '-c',
      'import os; os.setsid()',
    ],
    { timeout: PROBE_TIMEOUT_MS }
  );
  return unavailableCapabilities(
    {
      code: 'DESCENDANT_CANCELLATION_UNAVAILABLE',
      message:
        'Seatbelt cannot prevent descendants from escaping process-group ownership, so complete cancellation cannot be guaranteed',
    },
    {
      ...diagnostics,
      profileInitialization: 'passed',
      setsidEscape: sessionEscape.exitCode === 0 ? 'confirmed' : 'not_confirmed',
      setsidDiagnostic: boundedText(sessionEscape.stderr),
    }
  );
}

function deniedReceipt(startedAt, finishedAt, code, message, diagnostics = {}) {
  return Object.freeze({
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
    error: Object.freeze({ code, message }),
    diagnostics: Object.freeze(diagnostics),
  });
}

class SeatbeltExecutor {
  constructor(options = {}) {
    this.options = options;
    this.now = options.now || Date.now;
    this.capabilities = null;
  }

  async detectCapabilities(options = {}) {
    if (this.capabilities && !options.force) return this.capabilities;
    this.capabilities = await detectSeatbeltCapabilities({ ...this.options, ...options });
    return this.capabilities;
  }

  async execute(policy, request = {}) {
    const startedAt = this.now();
    if (!isValidatedWorkspaceExecutionPolicy(policy)) {
      return deniedReceipt(
        startedAt,
        this.now(),
        'INVALID_POLICY',
        'Execution policy was not issued by the trusted Freedom policy validator'
      );
    }
    try {
      validateExecutionRequest(request);
    } catch (error) {
      return deniedReceipt(startedAt, this.now(), error.code, error.message);
    }
    const capabilities = await this.detectCapabilities();
    return deniedReceipt(
      startedAt,
      this.now(),
      capabilities.denial.code,
      capabilities.denial.message,
      capabilities.diagnostics
    );
  }
}

module.exports = {
  DEFAULT_SEATBELT_PATH,
  PROBE_TIMEOUT_MS,
  QUALIFIED_ARCHITECTURE,
  QUALIFIED_MACOS_BUILD,
  QUALIFIED_MACOS_VERSION,
  SeatbeltExecutor,
  buildSeatbeltProfile,
  detectSeatbeltCapabilities,
  seatbeltString,
};
