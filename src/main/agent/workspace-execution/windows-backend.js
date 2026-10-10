'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EXECUTION_STATES, NETWORK_POSTURES, isValidatedWorkspaceExecutionPolicy, validateExecutionRequest } = require('./execution-policy');
const { resolveWindowsSandbox, assertWindowsRuntimeOutsideWrites } = require('./windows-sandbox-runtime');
const { runWindowsSandbox } = require('./windows-sandbox-process');

class WindowsWorkspaceExecutor {
  constructor(options = {}) {
    this.options = options;
    this.resolveRuntime = options.resolveRuntime || resolveWindowsSandbox;
    this.run = options.run || runWindowsSandbox;
    // One setup per Windows user, shared by Freedom profiles. Separate profile
    // credential stores would rotate the same machine accounts underneath one another.
    this.home = options.home || path.join(process.env.LOCALAPPDATA || os.homedir(), 'FreedomBrowser', 'Sandbox');
    this.runtime = null;
  }

  async detectCapabilities() {
    try {
      this.runtime = await this.resolveRuntime(this.options);
      const result = await this.run(this.runtime, { version: 1, operation: 'probe', backend: 'elevated', home: this.home });
      if (result.terminal?.type !== 'capabilities') throw new Error('Sandbox probe failed');
      const ready = result.terminal?.type === 'capabilities' && result.terminal.setupComplete === true;
      return Object.freeze({ backend: 'windows-elevated', available: true, setupRequired: !ready,
        enforcement: Object.freeze({ filesystem: true, filesystemReadScope: 'windows_user_readable',
          networkNone: true, networkFull: true, loopbackNetworking: true, descendantInheritance: true,
          privateTemporaryStorage: true, closedFileDescriptors: true, executableRootsScoped: false,
          wallTimeout: true, outputLimits: true, cancellation: true, cancellationGuarantee: 'best_effort',
          survivorsPossible: true, completeDescendantTermination: false, aggregateResourceLimits: false }),
      });
    } catch {
      return Object.freeze({ backend: 'windows-elevated', available: false,
        denial: { code: 'WINDOWS_SANDBOX_HELPER_UNAVAILABLE', message: 'The Windows project protection helper is missing or incompatible; rebuild or reinstall Freedom' }, enforcement: {} });
    }
  }

  async setup(request = {}) {
    const runtime = await this.resolveRuntime(this.options);
    const result = await this.run(runtime, { version: 1, operation: 'setup-interactive', backend: 'elevated', home: this.home },
      { timeoutMs: 180000, signal: request.signal });
    if (result.terminal?.type !== 'setup' || result.terminal.complete !== true) {
      throw new Error('Windows project protection was not set up. An administrator must approve the Windows setup prompt.');
    }
  }

  async execute(policy, rawRequest) {
    const startedAt = Date.now();
    let privateDirectory;
    let result;
    try {
      if (!isValidatedWorkspaceExecutionPolicy(policy)) throw new Error('Execution requires a validated workspace policy');
      const request = validateExecutionRequest(rawRequest);
      if (request.signal?.aborted) return this.receipt(startedAt, { cancellation: 'cancelled' });
      if (policy.network === NETWORK_POSTURES.BROKERED || policy.seccomp.requireCustomFilter || policy.limits.aggregate.required) {
        throw new Error('The requested isolation controls are unavailable on Windows');
      }
      const capabilities = await this.detectCapabilities();
      if (!capabilities.available) throw new Error(capabilities.denial.message);
      if (capabilities.setupRequired) throw new Error('Windows project protection requires administrator setup');
      privateDirectory = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(this.options.temporaryRoot || os.tmpdir(), 'freedom-win-workspace-')));
      const canonicalHome = await fs.promises.realpath(this.home);
      const workspace = policy.filesystem.readableRoots[0].sourcePath;
      const writableRoots = [...policy.filesystem.writableRoots.map(root => root.sourcePath), privateDirectory];
      assertWindowsRuntimeOutsideWrites(this.runtime, canonicalHome, writableRoots);
      const runtimePaths = policy.filesystem.runtimeRoots.flatMap(root => root.pathEntries?.length
        ? root.pathEntries.map(entry => path.join(root.sourcePath, entry)) : [root.sourcePath]);
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const environment = { ...policy.environment.values, SystemRoot: systemRoot, WINDIR: systemRoot,
        COMSPEC: path.join(systemRoot, 'System32/cmd.exe'),
        PATH: [...runtimePaths, path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(';'),
        PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: privateDirectory, HOME: privateDirectory,
        APPDATA: privateDirectory, LOCALAPPDATA: privateDirectory, TEMP: privateDirectory, TMP: privateDirectory,
        npm_config_cache: path.join(privateDirectory, 'npm-cache') };
      const cwd = path.join(workspace, path.posix.relative('/workspace', policy.workingDirectory));
      result = await this.run(this.runtime, { version: 1, operation: 'execute', backend: 'elevated', home: this.home,
        command: [request.command, ...request.args], workspace, cwd, writableRoots,
        protectedPaths: policy.filesystem.protectedPaths.map(entry => entry.sourcePath),
        environment, network: policy.network === NETWORK_POSTURES.FULL, timeoutMs: policy.limits.timeoutMs },
      { ...request, ...policy.limits, timeoutMs: policy.limits.timeoutMs + 15000 });
    } catch (error) {
      result = { failure: error.message };
    } finally {
      if (privateDirectory) await fs.promises.rm(privateDirectory, { recursive: true, force: true }).catch(() => {});
    }
    return this.receipt(startedAt, result);
  }

  receipt(startedAt, result) {
    const finishedAt = Date.now();
    const reason = result.cancellation || result.terminal?.reason;
    const failure = result.failure || (result.terminal?.type === 'error' ? 'Windows project protection could not start the command' : null);
    const state = reason === 'cancelled' ? EXECUTION_STATES.CANCELLED
      : reason === 'timed_out' ? EXECUTION_STATES.TIMED_OUT
        : failure ? (result.ready ? EXECUTION_STATES.FAILED : EXECUTION_STATES.SANDBOX_DENIED)
          : result.terminal?.exitCode === 0 ? EXECUTION_STATES.COMPLETED : EXECUTION_STATES.FAILED;
    return Object.freeze({ backend: 'windows-elevated', state, startedAt, finishedAt, durationMs: finishedAt - startedAt,
      exitCode: result.terminal?.exitCode ?? null, signal: null, stdout: result.stdout || '', stderr: result.stderr || '',
      stdoutTruncated: result.stdoutTruncated === true, stderrTruncated: result.stderrTruncated === true,
      terminationGuarantee: result.ready ? 'best_effort' : 'not_applicable', survivorsPossible: result.ready === true,
      completeDescendantTermination: false, sideEffects: result.ready ? 'unknown' : 'none',
      error: failure ? { code: 'WORKSPACE_EXECUTION_FAILED', message: failure } : undefined });
  }
}

module.exports = { WindowsWorkspaceExecutor };
