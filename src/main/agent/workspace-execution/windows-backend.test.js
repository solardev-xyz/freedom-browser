'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WindowsWorkspaceExecutor } = require('./windows-backend');
const { createWorkspaceExecutionPolicy, createWorkspaceFileReadPolicy } = require('./execution-policy');

describe('Windows sandbox policy boundary', () => {
  let directory;
  let workspace;
  let executor;
  let run;
  beforeEach(async () => {
    directory = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-windows-unit-')));
    workspace = path.join(directory, 'project');
    await fs.promises.mkdir(workspace);
    await fs.promises.mkdir(path.join(directory, 'sandbox-home'));
    require('node:child_process').execFileSync('git', ['init', '--quiet', workspace]);
    run = jest.fn(async (_runtime, request) => request.operation === 'probe'
      ? { terminal: { type: 'capabilities', setupComplete: true } }
      : { ready: true, terminal: { type: 'exit', exitCode: 0, reason: 'exited' } });
    executor = new WindowsWorkspaceExecutor({ home: path.join(directory, 'sandbox-home'), temporaryRoot: directory,
      resolveRuntime: async () => ({ directory: path.join(directory, 'helpers'), executablePath: '/test/helper.exe' }), run });
  });
  afterEach(async () => { await fs.promises.rm(directory, { recursive: true, force: true }); });

  test('read-only policy never grants the workspace as a write root', async () => {
    const policy = await createWorkspaceFileReadPolicy({ workspaceRoot: workspace });
    expect((await executor.execute(policy, { command: 'runtime.exe' })).state).toBe('completed');
    const request = run.mock.calls.find(([, input]) => input.operation === 'execute')[1];
    expect(request.writableRoots).toHaveLength(1);
    expect(request.writableRoots).not.toContain(workspace);
    expect(request.network).toBe(false);
    expect(request.environment).not.toHaveProperty('OPENAI_API_KEY');
  });

  test('protects Git metadata and keeps sandbox control files outside project write grants', async () => {
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace });
    expect((await executor.execute(policy, { command: 'runtime.exe' })).state).toBe('completed');
    const request = run.mock.calls.find(([, input]) => input.operation === 'execute')[1];
    expect(request.writableRoots).toContain(workspace);
    expect(request.protectedPaths).toContain(path.join(workspace, '.git'));
    executor.home = path.join(workspace, 'control');
    await fs.promises.mkdir(executor.home);
    run.mockClear();
    expect((await executor.execute(policy, { command: 'runtime.exe' })).state).toBe('sandbox_denied');
    expect(run.mock.calls.some(([, input]) => input.operation === 'execute')).toBe(false);
  });

  test('missing setup is disclosed and cannot silently fall back or trigger elevation during execution', async () => {
    run.mockResolvedValue({ terminal: { type: 'capabilities', setupComplete: false } });
    expect(await executor.detectCapabilities()).toMatchObject({ available: true, setupRequired: true });
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace });
    expect((await executor.execute(policy, { command: 'runtime.exe' })).state).toBe('sandbox_denied');
    expect(run.mock.calls.every(([, input]) => input.operation === 'probe')).toBe(true);
  });

  test('a helper failure after launch cannot certify that no side effects occurred', async () => {
    run.mockImplementation(async (_runtime, request) => request.operation === 'probe'
      ? { terminal: { type: 'capabilities', setupComplete: true } }
      : { failure: 'Helper disconnected', ready: false });
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace });
    expect(await executor.execute(policy, { command: 'runtime.exe' })).toMatchObject({
      sideEffects: 'unknown', survivorsPossible: true, terminationGuarantee: 'best_effort',
    });
  });

  test('unvalidated policies and unsupported brokered networking fail before launch', async () => {
    expect((await executor.execute({}, { command: 'runtime.exe' })).state).toBe('sandbox_denied');
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'brokered' });
    expect((await executor.execute(policy, { command: 'runtime.exe' })).state).toBe('sandbox_denied');
    expect(run).not.toHaveBeenCalled();
  });
});
