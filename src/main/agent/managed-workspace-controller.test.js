'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  ManagedWorkspaceController,
  WORKSPACE_FILE_HELPER,
  validateCommand,
  validateWorkspacePath,
  validateWorkingDirectory,
} = require('./managed-workspace-controller');
const { resolveExecutableAccess } = require('./workspace-execution/executable-access');

function createController(overrides = {}) {
  const workspace = {
    workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
    conversationId: 'conversation_one',
    enabled: true,
    backend: 'linux-bubblewrap',
  };
  const store = {
    getForConversation: jest.fn(() => workspace),
    ensureForConversation: jest.fn(async () => ({ ...workspace, enabled: false })),
    resolvePath: jest.fn(async () => '/managed/workspace_aaaaaaaaaaaaaaaaaaaa'),
    enable: jest.fn(() => workspace),
    startCommand: jest.fn(() => 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb'),
    finishCommand: jest.fn(() => true),
    listCommands: jest.fn(() => []),
    deleteConversation: jest.fn(async () => true),
  };
  const capabilities = {
    available: true,
    backend: 'linux-bubblewrap',
    enforcement: {
      cancellationGuarantee: 'namespace_scoped',
      survivorsPossible: false,
      completeDescendantTermination: true,
    },
  };
  const executor = {
    detectCapabilities: jest.fn(async () => capabilities),
    execute: jest.fn(async () => ({
      backend: 'linux-bubblewrap',
      state: 'completed',
      startedAt: 1_000,
      finishedAt: 1_010,
      durationMs: 10,
      exitCode: 0,
      signal: null,
      stdout: 'hello',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      terminationGuarantee: 'namespace_scoped',
      sideEffects: 'unknown',
      survivorsPossible: false,
      completeDescendantTermination: true,
    })),
  };
  const runtime = {
    available: true,
    sandboxExecutablePath: '/opt/freedom-toolchain/electron/freedom',
  };
  const helperPolicy = { kind: 'test-helper-policy' };
  const agentPolicy = { kind: 'test-agent-policy' };
  const dependencies = {
    store,
    executor,
    detectRuntime: jest.fn(async () => runtime),
    createPolicy: jest.fn(async () => helperPolicy),
    restrictPolicy: jest.fn(() => agentPolicy),
    now: jest.fn(() => 1_000),
    ...overrides,
  };
  return {
    controller: new ManagedWorkspaceController(dependencies),
    dependencies,
    workspace,
    helperPolicy,
    agentPolicy,
  };
}

function completedExecution(stdout) {
  return {
    backend: 'linux-bubblewrap',
    state: 'completed',
    startedAt: 1_000,
    finishedAt: 1_010,
    durationMs: 10,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    terminationGuarantee: 'namespace_scoped',
    sideEffects: 'none',
    survivorsPossible: false,
    completeDescendantTermination: true,
  };
}

describe('ManagedWorkspaceController', () => {
  beforeEach(() => {
    jest
      .spyOn(fs.promises, 'realpath')
      .mockImplementation(async (value) => path.resolve(String(value)));
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ isDirectory: () => true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('discloses only public enforcement properties and establishes one policy lease', async () => {
    const { controller, dependencies, helperPolicy } = createController();

    await expect(controller.disclosure('conversation_one')).resolves.toEqual({
      available: true,
      backend: 'linux-bubblewrap',
      network: 'disabled',
      filesystem: 'managed_workspace_only',
      cancellationGuarantee: 'namespace_scoped',
      survivorsPossible: false,
      completeDescendantTermination: true,
    });
    await expect(controller.enable('conversation_one')).resolves.toMatchObject({ enabled: true });
    expect(dependencies.createPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/managed/workspace_aaaaaaaaaaaaaaaaaaaa',
        electronRuntime: expect.objectContaining({ available: true }),
        environment: {
          set: {
            ELECTRON_RUN_AS_NODE: '1',
          },
        },
      })
    );
    expect(dependencies.restrictPolicy).toHaveBeenCalledWith(helperPolicy, {
      omitRuntimeRootIds: ['electron'],
      omitEnvironmentNames: ['ELECTRON_RUN_AS_NODE'],
    });
    expect(JSON.stringify(await controller.disclosure('conversation_one'))).not.toContain(
      '/managed/'
    );
  });

  test('reports workspace startup phases without exposing host paths', async () => {
    const { controller } = createController();
    const phases = [];

    await controller.enable('conversation_one', { onPhase: (phase) => phases.push(phase) });

    expect(phases).toEqual([
      'checking_capabilities',
      'checking_runtime',
      'ready_for_approval',
      'creating_workspace',
      'validating_boundary',
      'enabling_workspace',
      'workspace_ready',
    ]);
    expect(JSON.stringify(phases)).not.toContain('/managed/');
  });

  test('cancels a workspace enablement wait even when policy construction never settles', async () => {
    let resolvePolicy;
    const policy = new Promise((resolve) => {
      resolvePolicy = resolve;
    });
    const { controller, dependencies, helperPolicy } = createController({
      createPolicy: jest.fn(() => policy),
    });
    const abortController = new AbortController();
    const enablement = controller.enable('conversation_one', {
      signal: abortController.signal,
    });
    for (
      let attempt = 0;
      attempt < 10 && dependencies.createPolicy.mock.calls.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    abortController.abort();
    await expect(enablement).rejects.toMatchObject({ code: 'WORKSPACE_OPERATION_CANCELLED' });
    expect(dependencies.store.enable).not.toHaveBeenCalled();

    resolvePolicy(helperPolicy);
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('executes in a relative directory, returns a structured receipt, and persists it', async () => {
    const { controller, dependencies, workspace } = createController();
    fs.promises.realpath.mockResolvedValueOnce(
      path.join('/managed/workspace_aaaaaaaaaaaaaaaaaaaa', 'site')
    );

    const receipt = await controller.execute('conversation_one', {
      command: 'printf hello',
      workingDirectory: 'site',
    });

    expect(dependencies.executor.execute).toHaveBeenCalledWith(
      { kind: 'test-agent-policy' },
      expect.objectContaining({
        command: '/bin/sh',
        args: [
          '-c',
          'cd "$1" && exec /bin/sh -c "$2"',
          'freedom-workspace',
          '/workspace/site',
          'printf hello',
        ],
        signal: expect.any(AbortSignal),
      })
    );
    expect(receipt).toMatchObject({
      workspaceId: workspace.workspaceId,
      commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
      command: 'printf hello',
      workingDirectory: 'site',
      state: 'completed',
      stdout: 'hello',
      sideEffects: 'unknown',
    });
    expect(dependencies.store.finishCommand).toHaveBeenCalledWith(
      receipt.commandId,
      workspace.workspaceId,
      expect.objectContaining({ state: 'completed' })
    );
  });

  test('binds one-shot executable access to one exact command and working directory', async () => {
    fs.promises.realpath.mockRestore();
    fs.promises.stat.mockRestore();
    const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-controller-tool-'));
    const packageRoot = path.join(fixture, 'runtime');
    const bin = path.join(packageRoot, 'bin');
    await fs.promises.mkdir(bin, { recursive: true });
    await fs.promises.writeFile(path.join(bin, 'tool'), '#!/bin/sh\n', { mode: 0o700 });
    const prepared = await resolveExecutableAccess(['tool'], {
      platform: 'darwin',
      hostEnvironment: { PATH: bin },
    });
    jest
      .spyOn(fs.promises, 'realpath')
      .mockImplementation(async (value) => path.resolve(String(value)));
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ isDirectory: () => true });
    const grantedPolicy = { kind: 'test-granted-policy' };
    const { controller, dependencies, helperPolicy } = createController({
      resolveExecutableAccess: jest.fn(async () => prepared),
      restrictPolicy: jest
        .fn()
        .mockReturnValueOnce({ kind: 'test-agent-policy' })
        .mockReturnValue(grantedPolicy),
    });

    try {
      const resolved = await controller.prepareExecutableAccess('conversation_one', ['tool'], {
        command: 'tool --version',
        workingDirectory: '.',
      });
      expect(resolved.publicRequest).toMatchObject({
        kind: 'command_access',
        command: 'tool --version',
        workingDirectory: '.',
        commands: [expect.objectContaining({ name: 'tool', status: 'requires_permission' })],
      });
      expect(
        controller.grantExecutableAccess('conversation_one', resolved.prepared, 'once')
      ).toEqual({
        scope: 'once',
        commands: ['tool'],
        command: 'tool --version',
        workingDirectory: '.',
      });
      expect(() =>
        controller.grantExecutableAccess('conversation_one', resolved.prepared, 'once')
      ).toThrow(expect.objectContaining({ code: 'INVALID_EXECUTABLE_GRANT' }));

      await controller.execute('conversation_one', { command: 'tool --help' });
      expect(dependencies.executor.execute).toHaveBeenLastCalledWith(
        { kind: 'test-agent-policy' },
        expect.objectContaining({ command: '/bin/sh' })
      );

      await controller.execute('conversation_one', { command: 'tool --version' });
      expect(dependencies.restrictPolicy).toHaveBeenLastCalledWith(helperPolicy, {
        omitRuntimeRootIds: ['electron'],
        omitEnvironmentNames: ['ELECTRON_RUN_AS_NODE'],
        addRuntimeRoots: prepared.runtimeRoots,
      });
      expect(dependencies.executor.execute).toHaveBeenCalledWith(
        grantedPolicy,
        expect.objectContaining({ command: '/bin/sh' })
      );

      await controller.execute('conversation_one', { command: 'tool --version' });
      expect(dependencies.executor.execute).toHaveBeenLastCalledWith(
        { kind: 'test-agent-policy' },
        expect.objectContaining({ command: '/bin/sh' })
      );
      expect(controller.clearTurnPermissions('conversation_one')).toBe(false);

      const conversationPermission = await controller.prepareExecutableAccess(
        'conversation_one',
        ['tool'],
        { command: 'tool later', workingDirectory: '.' }
      );
      controller.grantExecutableAccess(
        'conversation_one',
        conversationPermission.prepared,
        'conversation'
      );
      await controller.execute('conversation_one', { command: 'tool --different' });
      expect(dependencies.executor.execute).toHaveBeenLastCalledWith(
        grantedPolicy,
        expect.objectContaining({ command: '/bin/sh' })
      );
      expect(controller.clearTurnPermissions('conversation_one')).toBe(false);
    } finally {
      await fs.promises.rm(fixture, { recursive: true, force: true });
    }
  });

  test('captures and caches the user command PATH for the default resolver', async () => {
    fs.promises.realpath.mockRestore();
    fs.promises.stat.mockRestore();
    const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-controller-path-'));
    const packageRoot = path.join(fixture, 'runtime');
    const bin = path.join(packageRoot, 'bin');
    await fs.promises.mkdir(bin, { recursive: true });
    await fs.promises.writeFile(path.join(bin, 'tool'), '#!/bin/sh\n', { mode: 0o700 });
    jest
      .spyOn(fs.promises, 'realpath')
      .mockImplementation(async (value) => path.resolve(String(value)));
    jest.spyOn(fs.promises, 'stat').mockImplementation(async (value) => ({
      isDirectory: () =>
        [path.resolve(packageRoot), path.resolve('/managed/workspace_aaaaaaaaaaaaaaaaaaaa')].includes(
          path.resolve(String(value))
        ),
      isFile: () => path.resolve(String(value)) === path.resolve(path.join(bin, 'tool')),
    }));
    const capture = jest.fn(async () => ({ PATH: bin, source: 'login_shell' }));
    const { controller } = createController({
      resolveExecutableAccess,
      captureHostCommandEnvironment: capture,
    });

    try {
      await controller.prepareExecutableAccess('conversation_one', ['tool'], {
        command: 'tool --version',
      });
      await controller.prepareExecutableAccess('conversation_one', ['tool'], {
        command: 'tool --help',
      });
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      await fs.promises.rm(fixture, { recursive: true, force: true });
      fs.promises.realpath.mockRestore();
      fs.promises.stat.mockRestore();
    }
  });

  test('fails closed when a granted capability has no policy enforcement adapter', async () => {
    const capabilityGrants = {
      clear: jest.fn(),
      clearOnce: jest.fn(() => false),
      deleteConversation: jest.fn(() => false),
      grant: jest.fn(),
      resolve: jest.fn(() => [Object.freeze({ kind: 'network_public', version: 1 })]),
    };
    const { controller, dependencies } = createController({ capabilityGrants });

    await expect(
      controller.execute('conversation_one', {
        command: 'printf hello',
        workingDirectory: '.',
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_WORKSPACE_CAPABILITY' });
    expect(dependencies.executor.execute).not.toHaveBeenCalled();
    expect(dependencies.store.startCommand).not.toHaveBeenCalled();
  });

  test('runs bounded file reads through the same OS sandbox policy', async () => {
    const { controller, dependencies } = createController();

    await expect(controller.readFile('conversation_one', 'src/index.js')).resolves.toEqual(
      Buffer.from('hello')
    );
    expect(dependencies.executor.execute).toHaveBeenCalledWith(
      { kind: 'test-helper-policy' },
      expect.objectContaining({
        command: '/bin/sh',
        args: expect.arrayContaining([
          '/workspace',
          '/opt/freedom-toolchain/electron/freedom',
          'read',
          'src/index.js',
        ]),
        signal: expect.any(AbortSignal),
      })
    );
    expect(JSON.stringify(dependencies.executor.execute.mock.calls[0][1])).not.toContain(
      'FREEDOM_JAVASCRIPT_RUNTIME'
    );
  });

  test('runs exact bounded writes through the sandbox and refuses protected Git metadata', async () => {
    const { controller, dependencies } = createController();
    await controller.writeFile('conversation_one', 'src/index.js', 'hello');
    expect(dependencies.executor.execute).toHaveBeenCalledWith(
      { kind: 'test-helper-policy' },
      expect.objectContaining({
        args: expect.arrayContaining([
          'write',
          'src/index.js',
          Buffer.from('hello').toString('base64'),
        ]),
      })
    );
    await expect(
      controller.writeFile('conversation_one', '.git/config', 'unsafe')
    ).rejects.toMatchObject({ code: 'WORKSPACE_PROTECTED_PATH' });
  });

  test('returns bounded structured directory, glob, and content-search results', async () => {
    const { controller, dependencies } = createController();
    dependencies.executor.execute
      .mockResolvedValueOnce(
        completedExecution(
          JSON.stringify({
            entries: [{ name: 'src', type: 'directory' }],
            limitReached: false,
          })
        )
      )
      .mockResolvedValueOnce(
        completedExecution(
          JSON.stringify({
            results: ['src/index.js'],
            limitReached: false,
            scanLimitReached: false,
          })
        )
      )
      .mockResolvedValueOnce(
        completedExecution(
          JSON.stringify({
            output: 'src/index.js:1: hello',
            matchCount: 1,
            limitReached: false,
            linesTruncated: false,
            outputTruncated: false,
            scanLimitReached: false,
          })
        )
      );

    await expect(controller.listDirectory('conversation_one', '.')).resolves.toEqual({
      entries: [{ name: 'src', type: 'directory' }],
      limitReached: false,
    });
    await expect(
      controller.findFiles('conversation_one', '.', { pattern: '*.js' })
    ).resolves.toEqual({
      results: ['src/index.js'],
      limitReached: false,
      scanLimitReached: false,
    });
    await expect(
      controller.grepFiles('conversation_one', '.', { pattern: 'hello' })
    ).resolves.toMatchObject({ output: 'src/index.js:1: hello', matchCount: 1 });

    expect(dependencies.executor.execute).toHaveBeenNthCalledWith(
      1,
      { kind: 'test-helper-policy' },
      expect.objectContaining({ args: expect.arrayContaining(['list', '.']) })
    );
    expect(dependencies.executor.execute).toHaveBeenNthCalledWith(
      2,
      { kind: 'test-helper-policy' },
      expect.objectContaining({ args: expect.arrayContaining(['find', '.']) })
    );
    expect(dependencies.executor.execute).toHaveBeenNthCalledWith(
      3,
      { kind: 'test-helper-policy' },
      expect.objectContaining({ args: expect.arrayContaining(['grep', '.']) })
    );
  });

  test('the sandbox file helper rejects symlink and hardlink escapes', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-workspace-helper-'));
    const workspace = path.join(fixture, 'workspace');
    const outside = path.join(fixture, 'outside.txt');
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.mkdirSync(path.join(workspace, 'directory'), { mode: 0o700 });
    fs.writeFileSync(outside, 'outside secret', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(workspace, 'symlink.txt'));
    fs.symlinkSync(fixture, path.join(workspace, 'parent-link'));
    fs.linkSync(outside, path.join(workspace, 'hardlink.txt'));
    const run = (operation, relative, content = '') =>
      execFileSync(process.execPath, ['-e', WORKSPACE_FILE_HELPER, operation, relative, content], {
        cwd: workspace,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    try {
      expect(() => run('read', 'symlink.txt')).toThrow(
        expect.objectContaining({ stderr: expect.stringContaining('WORKSPACE_FILE_UNSAFE') })
      );
      expect(() => run('read', 'parent-link/outside.txt')).toThrow(
        expect.objectContaining({ stderr: expect.stringContaining('WORKSPACE_FILE_UNSAFE') })
      );
      expect(() =>
        run(
          'grep',
          'parent-link',
          Buffer.from(JSON.stringify({ pattern: 'outside', limit: 100 })).toString('base64')
        )
      ).toThrow(
        expect.objectContaining({ stderr: expect.stringContaining('WORKSPACE_FILE_UNSAFE') })
      );
      expect(() => run('read', 'hardlink.txt')).toThrow(
        expect.objectContaining({ stderr: expect.stringContaining('WORKSPACE_FILE_UNSAFE') })
      );
      expect(() => run('read', 'missing.txt')).toThrow(
        expect.objectContaining({ stderr: expect.stringContaining('WORKSPACE_PATH_NOT_FOUND') })
      );
      expect(() => run('read', 'directory')).toThrow(
        expect.objectContaining({ stderr: expect.stringContaining('WORKSPACE_PATH_TYPE_MISMATCH') })
      );
      expect(() => run('write', '.git/config', Buffer.from('unsafe').toString('base64'))).toThrow(
        expect.objectContaining({ stderr: expect.stringContaining('WORKSPACE_PROTECTED_PATH') })
      );
      expect(run('write', 'src/index.js', Buffer.from('hello').toString('base64'))).toBe('');
      expect(run('read', 'src/index.js')).toBe('hello');
      fs.writeFileSync(path.join(workspace, 'src', 'other.txt'), 'goodbye\nhello again');
      const list = JSON.parse(
        run('list', '.', Buffer.from(JSON.stringify({ limit: 500 })).toString('base64'))
      );
      expect(list).toEqual({
        entries: expect.arrayContaining([
          { name: 'src', type: 'directory' },
          { name: 'hardlink.txt', type: 'file' },
          { name: 'symlink.txt', type: 'other' },
        ]),
        limitReached: false,
      });
      const found = JSON.parse(
        run(
          'find',
          '.',
          Buffer.from(JSON.stringify({ pattern: '*.js', limit: 1000 })).toString('base64')
        )
      );
      expect(found).toMatchObject({ results: ['src/index.js'], limitReached: false });
      const searched = JSON.parse(
        run(
          'grep',
          '.',
          Buffer.from(JSON.stringify({ pattern: 'hello', limit: 100 })).toString('base64')
        )
      );
      expect(searched).toMatchObject({
        matchCount: 2,
        limitReached: false,
        linesTruncated: false,
      });
      expect(searched.output).toContain('src/index.js:1: hello');
      expect(searched.output).toContain('src/other.txt:2: hello again');
      const regexSearch = JSON.parse(
        run(
          'grep',
          '.',
          Buffer.from(JSON.stringify({ pattern: 'hello\\s+again', limit: 100 })).toString('base64')
        )
      );
      expect(regexSearch).toMatchObject({ matchCount: 1 });
      expect(regexSearch.output).toContain('src/other.txt:2: hello again');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('cancels every active command owned by the conversation', async () => {
    const pending = {};
    pending.promise = new Promise((resolve) => {
      pending.resolve = resolve;
    });
    const { controller, dependencies } = createController();
    dependencies.executor.execute.mockImplementation((_policy, request) => {
      request.signal.addEventListener('abort', () => {
        pending.resolve({
          backend: 'linux-bubblewrap',
          state: 'cancelled',
          startedAt: 1_000,
          finishedAt: 1_001,
          durationMs: 1,
          exitCode: null,
          signal: 'SIGKILL',
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          terminationGuarantee: 'namespace_scoped',
          sideEffects: 'unknown',
          survivorsPossible: false,
          completeDescendantTermination: true,
        });
      });
      return pending.promise;
    });

    const execution = controller.execute('conversation_one', { command: 'sleep 100' });
    for (
      let attempt = 0;
      attempt < 10 && dependencies.executor.execute.mock.calls.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(controller.cancelConversation('conversation_one')).toBe(1);
    await expect(execution).resolves.toMatchObject({ state: 'cancelled', signal: 'SIGKILL' });
  });

  test('fails closed when the platform backend is unavailable', async () => {
    const { controller, dependencies } = createController();
    dependencies.executor.detectCapabilities.mockResolvedValue({
      available: false,
      backend: 'unavailable',
      denial: { code: 'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE', message: 'Unavailable' },
    });

    await expect(controller.disclosure('conversation_one')).rejects.toMatchObject({
      code: 'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE',
    });
    expect(dependencies.detectRuntime).not.toHaveBeenCalled();
  });

  test('redacts host paths from persisted and model-visible execution errors', async () => {
    const { controller, dependencies, workspace } = createController();
    dependencies.executor.execute.mockResolvedValue({
      backend: 'linux-bubblewrap',
      state: 'sandbox_denied',
      startedAt: 1_000,
      finishedAt: 1_001,
      durationMs: 1,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      terminationGuarantee: 'not_applicable',
      sideEffects: 'none',
      error: {
        code: 'POLICY_PREPARATION_FAILED',
        message: 'Could not mount /Users/private/project',
      },
    });

    const receipt = await controller.execute('conversation_one', { command: 'pwd' });

    expect(receipt.error).toEqual({
      code: 'POLICY_PREPARATION_FAILED',
      message: 'The workspace command did not complete',
    });
    expect(dependencies.store.finishCommand).toHaveBeenCalledWith(
      receipt.commandId,
      workspace.workspaceId,
      expect.objectContaining({ error: receipt.error })
    );
    expect(JSON.stringify(receipt)).not.toContain('/Users/private');
  });

  test('reports an executor exception as an uncertain launch failure rather than policy denial', async () => {
    const { controller, dependencies } = createController();
    dependencies.executor.execute.mockRejectedValueOnce(new Error('spawn failed'));

    const receipt = await controller.execute('conversation_one', { command: 'pwd' });

    expect(receipt).toMatchObject({
      state: 'failed',
      exitCode: null,
      terminationGuarantee: 'unknown',
      sideEffects: 'unknown',
      survivorsPossible: true,
      completeDescendantTermination: false,
      error: {
        code: 'WORKSPACE_EXECUTION_FAILED',
        message: 'Freedom could not execute the command inside the verified sandbox',
      },
    });
  });

  test('preserves safe missing-path semantics from the private file helper', async () => {
    const { controller, dependencies } = createController();
    dependencies.executor.execute.mockResolvedValue({
      ...completedExecution(''),
      state: 'failed',
      exitCode: 73,
      stderr: 'FREEDOM_FILE_ERROR:WORKSPACE_PATH_NOT_FOUND',
    });

    await expect(controller.readFile('conversation_one', 'missing.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_NOT_FOUND',
      message: 'The requested workspace path does not exist',
    });
  });

  test('rejects absolute, parent, and empty command or file requests before execution', () => {
    expect(() => validateWorkingDirectory('/tmp')).toThrow('workspace-relative');
    expect(() => validateWorkingDirectory('../outside')).toThrow('safe workspace-relative');
    expect(() => validateCommand('')).toThrow('command must be non-empty');
    expect(validateWorkspacePath('src/index.js')).toBe('src/index.js');
    expect(() => validateWorkspacePath('../outside')).toThrow('inside the managed workspace');
    expect(() => validateWorkspacePath('/absolute')).toThrow('workspace-relative');
  });
});
