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
  const policy = { kind: 'test-policy' };
  const dependencies = {
    store,
    executor,
    detectRuntime: jest.fn(async () => runtime),
    createPolicy: jest.fn(async () => policy),
    now: jest.fn(() => 1_000),
    ...overrides,
  };
  return { controller: new ManagedWorkspaceController(dependencies), dependencies, workspace };
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
    const { controller, dependencies } = createController();

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
        nodeRuntimeRoot: null,
        electronRuntime: expect.objectContaining({ available: true }),
        environment: {
          set: {
            ELECTRON_RUN_AS_NODE: '1',
            FREEDOM_JAVASCRIPT_RUNTIME: '/opt/freedom-toolchain/electron/freedom',
          },
        },
      })
    );
    expect(JSON.stringify(await controller.disclosure('conversation_one'))).not.toContain(
      '/managed/'
    );
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
      { kind: 'test-policy' },
      expect.objectContaining({
        command: '/bin/sh',
        args: [
          '-c',
          'cd "$1" && exec /bin/sh -lc "$2"',
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

  test('runs bounded file reads through the same OS sandbox policy', async () => {
    const { controller, dependencies } = createController();

    await expect(controller.readFile('conversation_one', 'src/index.js')).resolves.toEqual(
      Buffer.from('hello')
    );
    expect(dependencies.executor.execute).toHaveBeenCalledWith(
      { kind: 'test-policy' },
      expect.objectContaining({
        command: '/bin/sh',
        args: expect.arrayContaining(['/workspace', 'read', 'src/index.js']),
        signal: expect.any(AbortSignal),
      })
    );
  });

  test('runs exact bounded writes through the sandbox and refuses protected Git metadata', async () => {
    const { controller, dependencies } = createController();
    await controller.writeFile('conversation_one', 'src/index.js', 'hello');
    expect(dependencies.executor.execute).toHaveBeenCalledWith(
      { kind: 'test-policy' },
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
      { kind: 'test-policy' },
      expect.objectContaining({ args: expect.arrayContaining(['list', '.']) })
    );
    expect(dependencies.executor.execute).toHaveBeenNthCalledWith(
      2,
      { kind: 'test-policy' },
      expect.objectContaining({ args: expect.arrayContaining(['find', '.']) })
    );
    expect(dependencies.executor.execute).toHaveBeenNthCalledWith(
      3,
      { kind: 'test-policy' },
      expect.objectContaining({ args: expect.arrayContaining(['grep', '.']) })
    );
  });

  test('the sandbox file helper rejects symlink and hardlink escapes', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-workspace-helper-'));
    const workspace = path.join(fixture, 'workspace');
    const outside = path.join(fixture, 'outside.txt');
    fs.mkdirSync(workspace, { mode: 0o700 });
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

  test('rejects absolute, parent, and empty command or file requests before execution', () => {
    expect(() => validateWorkingDirectory('/tmp')).toThrow('workspace-relative');
    expect(() => validateWorkingDirectory('../outside')).toThrow('safe workspace-relative');
    expect(() => validateCommand('')).toThrow('command must be non-empty');
    expect(validateWorkspacePath('src/index.js')).toBe('src/index.js');
    expect(() => validateWorkspacePath('../outside')).toThrow('inside the managed workspace');
    expect(() => validateWorkspacePath('/absolute')).toThrow('workspace-relative');
  });
});
