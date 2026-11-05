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

  test('strict offline commands are unavailable and fail before probing or creating files', async () => {
    expect(await executor.detectCapabilities()).toMatchObject({ enforcement: { networkNone: false, networkFull: true } });
    run.mockClear();
    const before = await fs.promises.readdir(directory);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'none' });
    expect(await executor.execute(policy, { command: 'runtime.exe', operation: 'execute-file-helper', trusted: true })).toMatchObject({
      state: 'sandbox_denied', sideEffects: 'none', exitCode: null, terminationGuarantee: 'not_applicable',
      error: { code: 'WINDOWS_FULL_NETWORK_PERMISSION_REQUIRED' },
    });
    expect(run).not.toHaveBeenCalled();
    expect(await fs.promises.readdir(directory)).toEqual(before);
  });

  test('fixed file helper owns its executable, program and stdin frame', async () => {
    const { detectElectronJavaScriptRuntime, ELECTRON_RUNTIME_PROBE_MARKER } = require('./electron-runtime');
    const { WORKSPACE_FILE_HELPER, WINDOWS_FILE_HELPER_BOOTSTRAP } = require('../workspace-file-helper');
    const root = path.join(directory, 'electron');
    const resourcesPath = path.join(root, 'resources');
    const executable = path.join(root, 'electron.exe');
    await fs.promises.mkdir(resourcesPath, { recursive: true });
    await fs.promises.writeFile(executable, 'fixture');
    const runtime = await detectElectronJavaScriptRuntime({ platform: 'win32', execPath: executable, resourcesPath,
      versions: { electron: '44.0.0', node: '24.0.0' },
      run: async () => ({ exitCode: 0, stdout: JSON.stringify({ marker: ELECTRON_RUNTIME_PROBE_MARKER, electron: '44.0.0', node: '24.0.0' }) }) });
    const policy = await createWorkspaceFileReadPolicy({ workspaceRoot: workspace, electronRuntime: runtime });
    run.mockImplementation(async (_runtime, request, options) => {
      if (request.operation === 'probe') return { terminal: { type: 'capabilities', setupComplete: true } };
      if (request.operation === 'remove-tree') return { terminal: { type: 'removed' } };
      expect(request.operation).toBe('execute-file-helper');
      expect(request.network).toBe(false);
      expect(request.writableRoots).toHaveLength(1);
      expect(request.writableRoots).not.toContain(workspace);
      expect(request.command).toEqual([executable, '-e', WINDOWS_FILE_HELPER_BOOTSTRAP]);
      const chunks = [];
      options.onStdin({ write: chunk => chunks.push(chunk) });
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ script: WORKSPACE_FILE_HELPER, args: ['write', 'a.txt', 'eA==', '', ''] });
      return { ready: true, terminal: { type: 'exit', exitCode: 0 } };
    });
    const request = { args: ['write', 'a.txt', 'eA==', '', ''], command: 'malicious.exe', onStdin: jest.fn() };
    expect((await executor.executeTrustedFileHelper(policy, request)).state).toBe('completed');
    expect(request.onStdin).not.toHaveBeenCalled();
    run.mockClear();
    for (const args of [['bash', '.', '', '', ''], ['read'], ['read', '.', {}, '', '']]) {
      expect((await executor.executeTrustedFileHelper(policy, { args })).state).toBe('sandbox_denied');
    }
    const full = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, electronRuntime: runtime, network: 'full' });
    expect((await executor.executeTrustedFileHelper(full, request)).state).toBe('sandbox_denied');
    expect((await executor.executeTrustedFileHelper({}, request)).state).toBe('sandbox_denied');
    expect(run).not.toHaveBeenCalled();
  });

  test('a read-only policy cannot be used to run an arbitrary offline program', async () => {
    const policy = await createWorkspaceFileReadPolicy({ workspaceRoot: workspace });
    expect((await executor.execute(policy, { command: 'runtime.exe' })).state).toBe('sandbox_denied');
    expect(run).not.toHaveBeenCalled();
  });

  test('protects Git metadata and keeps sandbox control files outside project write grants', async () => {
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'full' });
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
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'full' });
    expect((await executor.execute(policy, { command: 'runtime.exe' })).state).toBe('sandbox_denied');
    expect(run.mock.calls.every(([, input]) => input.operation === 'probe')).toBe(true);
  });

  test('long Unicode PowerShell scripts avoid the Windows command-line limit and preserve stdin', async () => {
    const source = "Write-Output 'Grüße'\n#" + 'x'.repeat(32000);
    let scriptPath;
    const onStdin = jest.fn();
    run.mockImplementation(async (_runtime, request, options) => {
      if (request.operation === 'probe') return { terminal: { type: 'capabilities', setupComplete: true } };
      if (request.operation === 'remove-tree') {
        await fs.promises.rm(request.cleanupPath, { recursive: true, force: true });
        return { terminal: { type: 'removed' } };
      }
      scriptPath = request.command.at(-1);
      expect(request.command.join(' ').length).toBeLessThan(24000);
      expect(request.command.slice(-4, -1)).toEqual(['-ExecutionPolicy', 'Bypass', '-File']);
      expect(await fs.promises.readFile(scriptPath, 'utf8')).toBe('\uFEFF' + source);
      expect(request.writableRoots).toContain(path.dirname(scriptPath));
      expect(options.onStdin).toBe(onStdin);
      return { ready: true, terminal: { type: 'exit', exitCode: 0 } };
    });
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'full' });
    expect((await executor.execute(policy, { command: path.resolve('/powershell.exe'),
      args: ['-NoProfile', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], onStdin })).state).toBe('completed');
    expect(fs.existsSync(scriptPath)).toBe(false);
    expect(run.mock.calls.some(([, input]) => input.operation === 'remove-tree')).toBe(true);
  });

  test('a helper failure after launch cannot certify that no side effects occurred', async () => {
    run.mockImplementation(async (_runtime, request) => request.operation === 'probe'
      ? { terminal: { type: 'capabilities', setupComplete: true } }
      : { failure: 'Helper disconnected', ready: false });
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'full' });
    expect(await executor.execute(policy, { command: 'runtime.exe' })).toMatchObject({
      sideEffects: 'unknown', survivorsPossible: true, terminationGuarantee: 'best_effort', terminationScope: 'unknown',
    });
  });

  test('unvalidated policies and unsupported brokered networking fail before launch', async () => {
    expect((await executor.execute({}, { command: 'runtime.exe' })).state).toBe('sandbox_denied');
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'brokered' });
    expect((await executor.execute(policy, { command: 'runtime.exe' })).state).toBe('sandbox_denied');
    expect(run).not.toHaveBeenCalled();
  });
});
