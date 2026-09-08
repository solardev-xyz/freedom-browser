'use strict';

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));
jest.mock('./logger', () => ({ warn: jest.fn() }));
jest.mock('./automation/runtime', () => ({}));
jest.mock('./service-registry', () => ({}));
jest.mock('./private/private-log-context', () => ({}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { app } = require('electron');
const previousMode = process.env.FREEDOM_TEST_MODE;
process.env.FREEDOM_TEST_MODE = '1';
const { prepareAgentExitScenario } = require('./test-harness');

describe('bounded app-exit fixture evidence without native execution', () => {
  let root;
  let workspaceRoot;
  let runtime;
  let controller;
  let receipt;
  let delegated;
  const token = `freedom-agent-app-exit-${'a'.repeat(24)}`;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-agent-app-exit-'));
    workspaceRoot = path.join(root, 'workspace');
    await fs.promises.mkdir(workspaceRoot);
    app.getPath.mockReturnValue(root);
    jest.spyOn(net, 'createServer').mockImplementation(() => ({
      once() {}, listen(_options, callback) { callback(); },
      address: () => ({ port: 12345 }), close(callback) { callback(); },
    }));
    receipt = { backend: 'macos-seatbelt', state: 'cancelled',
      diagnostics: { nativeSupervisor: true, nativeRootReaped: true } };
    const executor = {
      spawnProcess: jest.fn(() => ({ pid: 123 })),
      execute: jest.fn(async function (policy, request) {
        delegated = { policy, request };
        const spawn = this.spawnProcess;
        spawn('/protected/freedom-workspace-supervisor',
          ['--supervise', '1000', '/private/profile', '--', request.command, ...request.args], {});
        return receipt;
      }),
    };
    controller = {
      executor, processManager: {}, enable: jest.fn(),
      getWorkspace: () => ({ workspaceId: 'workspace' }),
      leases: new Map([['workspace', { workspaceRoot }]]),
      prepareCommandPermissions: async () => ({ prepared: {} }), grantCommandPermissions() {},
      startProcess: jest.fn(async (_conversation, request) => {
        const policy = {};
        const execution = { command: '/bin/sh', args: ['-c', 'wrapper', 'freedom-workspace', workspaceRoot, request.command] };
        expect(await executor.execute(policy, execution)).toBe(receipt);
        expect(delegated).toEqual({ policy, request: execution });
        request.onTerminal({ receipt: { backend: receipt.backend, state: receipt.state } });
        fs.writeFileSync(path.join(workspaceRoot, 'running.pid'), '456');
        fs.writeFileSync(path.join(workspaceRoot, 'running.ready'), 'ready');
        return { processId: 'managed', workspace: {} };
      }),
    };
    runtime = { service: { workspaceController: controller }, workspaceController: controller,
      workspacePreviewController: { workspaceController: controller,
        createProcessPreview: () => ({ url: 'https://fixture.invalid' }),
        handleRequest: async () => new Response('agent-exit-preview'),
      } };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  afterAll(() => {
    if (previousMode === undefined) delete process.env.FREEDOM_TEST_MODE;
    else process.env.FREEDOM_TEST_MODE = previousMode;
  });

  test('persists raw and mapped receipts separately without changing executor results', async () => {
    const execute = controller.executor.execute;
    const spawn = controller.executor.spawnProcess;
    const fixture = await prepareAgentExitScenario(runtime, { mode: 'running', token, expirySeconds: 12 });
    expect(JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8')).receipt).toEqual(receipt);
    expect(JSON.parse(fs.readFileSync(fixture.terminalPath, 'utf8')).terminal.receipt).not.toHaveProperty('diagnostics');
    expect(JSON.parse(fs.readFileSync(fixture.supervisorPath, 'utf8'))).toMatchObject({ pid: 123 });
    expect(path.dirname(fixture.receiptPath)).toBe(fs.realpathSync(root));
    expect(controller.executor.execute).toBe(execute);
    expect(controller.executor.spawnProcess).toBe(spawn);
    expect(fixture).toMatchObject({ expirySeconds: 12, appOwnedService: true, appOwnedWorkspaceController: true });
    const source = fs.readFileSync(path.join(workspaceRoot, 'app-exit-running.py'), 'utf8');
    expect(source.indexOf('signal.alarm(12)')).toBeLessThan(source.indexOf('import http.server'));
    expect(source).toContain('alarmArmedBeforeMonotonicNs');
    expect(source).toContain('alarmArmedAfterMonotonicNs');
    expect(source).toContain('alarmArmedBeforeWallNs');
    expect(source).toContain('alarmArmedAfterWallNs');
    expect(source).toContain("'clockDomain': 'clock_gettime:CLOCK_MONOTONIC'");
    expect(source.indexOf('alarm_before = time.clock_gettime_ns(time.CLOCK_MONOTONIC)'))
      .toBeLessThan(source.indexOf('signal.alarm(12)'));
    expect(source.indexOf('alarm_after = time.clock_gettime_ns(time.CLOCK_MONOTONIC)'))
      .toBeGreaterThan(source.indexOf('signal.alarm(12)'));
    expect(fs.statSync(fixture.receiptPath).mode & 0o777).toBe(0o600);
  });

  test.each([0, 16, 1.5, '15'])('rejects invalid expiry before enabling a workspace: %s', async (expirySeconds) => {
    await expect(prepareAgentExitScenario(runtime, { mode: 'running', token, expirySeconds })).rejects.toThrow('expiry');
    expect(controller.enable).not.toHaveBeenCalled();
  });

  test('restores executor observation on preparation failure without replacing the error', async () => {
    const execute = controller.executor.execute;
    const spawn = controller.executor.spawnProcess;
    const failure = new Error('launch failed');
    controller.startProcess.mockRejectedValue(failure);
    await expect(prepareAgentExitScenario(runtime, { mode: 'running', token })).rejects.toBe(failure);
    expect(controller.executor.execute).toBe(execute);
    expect(controller.executor.spawnProcess).toBe(spawn);
  });

  test('an evidence write failure cannot replace the real executor result', async () => {
    const write = fs.writeFileSync;
    jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('-executor.json')) throw new Error('fixture disk failure');
      return write(file, ...args);
    });
    const fixture = await prepareAgentExitScenario(runtime, { mode: 'running', token });
    expect(fs.existsSync(fixture.receiptPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(fixture.terminalPath, 'utf8')).terminal.receipt.state).toBe('cancelled');
    expect(controller.executor.execute).toHaveBeenCalledTimes(1);
  });

  test('a native execution rejection is preserved and restores observation', async () => {
    const execute = controller.executor.execute;
    const spawn = controller.executor.spawnProcess;
    const failure = new Error('native rejection');
    execute.mockRejectedValueOnce(failure);
    await expect(prepareAgentExitScenario(runtime, { mode: 'running', token })).rejects.toBe(failure);
    expect(controller.executor.execute).toBe(execute);
    expect(controller.executor.spawnProcess).toBe(spawn);
  });

  test('mismatched app composition is observable instead of returning literal success', async () => {
    runtime.service.workspaceController = {};
    const fixture = await prepareAgentExitScenario(runtime, { mode: 'idle', token });
    expect(fixture.appOwnedService).toBe(false);
    expect(fixture.appOwnedProcessManager).toBe(false);
  });

  test('reserves a fixture token before workspace preparation and rejects reuse', async () => {
    fs.writeFileSync(path.join(root, `${token}-intent.json`), '{}');
    await expect(prepareAgentExitScenario(runtime, { mode: 'running', token })).rejects.toThrow('already been used');
    expect(controller.enable).not.toHaveBeenCalled();
  });

  test('large output is bounded in evidence without changing native truncation flags', async () => {
    receipt.stdout = 'x'.repeat(300000);
    receipt.stdoutTruncated = false;
    const fixture = await prepareAgentExitScenario(runtime, { mode: 'running', token });
    const recorded = JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8'));
    expect(recorded.receipt.stdout).toHaveLength(4096);
    expect(recorded.receipt.stdoutTruncated).toBe(false);
    expect(recorded.outputCapture.stdoutBytesOmitted).toBe(300000 - 4096);
    expect(receipt.stdout).toHaveLength(300000);
  });

  test('retains observation across yielding and passes unrelated helper calls through', async () => {
    let finish;
    let completion;
    const execute = controller.executor.execute;
    const pending = new Promise((resolve) => { finish = resolve; });
    const helperReceipt = { state: 'completed' };
    execute.mockImplementation((_policy, request) => request.args[2] === 'freedom-workspace' ? pending : helperReceipt);
    controller.startProcess.mockImplementation(async (_conversation, request) => {
      completion = controller.executor.execute({}, { command: '/bin/sh',
        args: ['-c', 'wrapper', 'freedom-workspace', workspaceRoot, request.command] });
      expect(await controller.executor.execute({}, { command: '/bin/sh',
        args: ['-c', 'helper', 'freedom-workspace-file', workspaceRoot, request.command] })).toBe(helperReceipt);
      fs.writeFileSync(path.join(workspaceRoot, 'running.pid'), '456');
      fs.writeFileSync(path.join(workspaceRoot, 'running.ready'), 'ready');
      return { processId: 'managed', workspace: {} };
    });
    const fixture = await prepareAgentExitScenario(runtime, { mode: 'running', token });
    expect(controller.executor.execute).not.toBe(execute);
    expect(fs.existsSync(fixture.receiptPath)).toBe(false);
    finish(receipt);
    expect(await completion).toBe(receipt);
    expect(controller.executor.execute).toBe(execute);
    expect(JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8')).receipt).toEqual(receipt);
  });

  test('cannot prepare fixtures when test mode is disabled', async () => {
    process.env.FREEDOM_TEST_MODE = '0';
    let prepare;
    jest.isolateModules(() => { prepare = require('./test-harness').prepareAgentExitScenario; });
    process.env.FREEDOM_TEST_MODE = '1';
    await expect(prepare(runtime, { mode: 'idle', token })).rejects.toThrow('test mode');
    expect(controller.enable).not.toHaveBeenCalled();
  });
});
