'use strict';

const { ManagedWorkspaceServers, confirmedServerExit } = require('./managed-workspace-servers');
const id = `workspace_server_${'a'.repeat(24)}`;
const recipe = { serverId: id, command: 'npm run dev', workingDirectory: 'game', port: 5173, previewToken: 'b'.repeat(40) };
const launch = { command: recipe.command, workingDirectory: recipe.workingDirectory, previewPort: recipe.port };

describe('saved workspace server restart', () => {
  let servers, store, processes, start, assertNetwork, checkPort;
  beforeEach(() => {
    store = { listServers: owner => owner === 'one' ? [recipe] : [] };
    processes = { inspect: jest.fn(() => ({ state: 'running' })),
      terminate: jest.fn(async () => ({ state: 'cancelled', receipt: { processExitConfirmed: true } })) };
    start = jest.fn(async () => ({ state: 'running', processId: 'new' }));
    assertNetwork = jest.fn(async () => {}); checkPort = jest.fn(async () => {});
    servers = new ManagedWorkspaceServers({ store, processes, start, assertNetwork, checkPort });
    servers.bindings.set(id, 'old');
  });

  test('validates fresh permission, waits for Stop and checks the port before a new owned launch', async () => {
    await servers.restart('one', id, launch);
    expect(assertNetwork.mock.invocationCallOrder[0]).toBeLessThan(processes.terminate.mock.invocationCallOrder[0]);
    expect(processes.terminate.mock.invocationCallOrder[0]).toBeLessThan(checkPort.mock.invocationCallOrder[0]);
    expect(checkPort.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
    expect(servers.get('one', id).processId).toBe('new');
  });

  test('refuses foreign IDs, changed commands and missing permission without stopping a healthy server', async () => {
    await expect(servers.restart('other', id, launch)).rejects.toThrow();
    await expect(servers.restart('one', id, { ...launch, command: 'other' })).rejects.toThrow('changed');
    assertNetwork.mockRejectedValue(new Error('Permission required'));
    await expect(servers.restart('one', id, launch)).rejects.toThrow('Permission');
    expect(processes.terminate).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  test('refuses a duplicate restart even when both permission checks resolve together', async () => {
    let finish;
    processes.terminate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = servers.restart('one', id, launch);
    const second = servers.restart('one', id, launch);
    await expect(second).rejects.toThrow('already');
    finish({ state: 'cancelled', receipt: { processExitConfirmed: true } }); await first;
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('uncertain Stop and occupied ports never authorize a replacement', async () => {
    processes.terminate.mockResolvedValue({ state: 'running' });
    await expect(servers.restart('one', id, launch)).rejects.toThrow('unconfirmed');
    processes.terminate.mockResolvedValue({ state: 'cancelled', receipt: { processExitConfirmed: true } });
    checkPort.mockRejectedValue(new Error('Port occupied'));
    await expect(servers.restart('one', id, launch)).rejects.toThrow('occupied');
    expect(start).not.toHaveBeenCalled();
  });

  test('new browser controller restores recipes but no live IDs or permissions', async () => {
    const restored = new ManagedWorkspaceServers({ store, processes, start, assertNetwork, checkPort });
    expect(restored.get('one', id)).toMatchObject({ state: 'needs_restart', serverId: id });
    expect(restored.get('one', id).processId).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    const abort = new AbortController(); abort.abort();
    await expect(restored.restart('one', id, { ...launch, signal: abort.signal })).rejects.toThrow('stopped');
    expect(start).not.toHaveBeenCalled();
  });

  test.each(['.', 'app', 'app/nested'])('restarts the exact canonical directory %s', async workingDirectory => {
    store.listServers = () => [{ ...recipe, workingDirectory }];
    await servers.restart('one', id, { ...launch, workingDirectory });
    expect(start).toHaveBeenCalledWith('one', expect.objectContaining({ workingDirectory }));
  });

  test('rejects noncanonical replacements before touching a live process and clears deleted bindings', async () => {
    for (const workingDirectory of ['game/', './game', 'game/../game']) {
      await expect(servers.restart('one', id, { ...launch, workingDirectory })).rejects.toThrow('changed');
    }
    expect(processes.terminate).not.toHaveBeenCalled();
    servers.deleteConversation('one');
    expect(servers.bindings.size).toBe(0);
  });

  test('does not treat a cancelled label as proof of exit, even after its process handle expires', async () => {
    processes.terminate.mockResolvedValue({ state: 'cancelled', receipt: {} });
    await expect(servers.restart('one', id, launch)).rejects.toThrow('unconfirmed');
    expect(checkPort).not.toHaveBeenCalled();
    servers.recordCompletion('one', recipe.port, { backend: 'macos-seatbelt', state: 'cancelled' });
    servers.bindings.clear();
    expect(servers.get('one', id).state).toBe('exit_unconfirmed');
    await expect(servers.restart('one', id, launch)).rejects.toThrow('unconfirmed');
    expect(start).not.toHaveBeenCalled();
    servers.deleteConversation('one');
    expect(servers.unconfirmedPorts.size).toBe(0);
  });

  test('derives direct-root or namespace exit from backend evidence without claiming all Mac descendants', () => {
    const mac = { backend: 'macos-seatbelt', state: 'cancelled', survivorsPossible: true,
      completeDescendantTermination: false, diagnostics: { nativeSupervisor: true,
        nativeReason: 'cancelled', nativeRootExitObserved: true, nativeRootReaped: true, nativeCleanupUncertain: false } };
    expect(confirmedServerExit(mac)).toBe(true);
    expect(confirmedServerExit({ ...mac, diagnostics: { ...mac.diagnostics,
      nativeCleanupUncertain: true, processGroupSignalErrors: [{ code: 'EPERM' }] } })).toBe(true);
    for (const facts of [{ nativeRootReaped: false }, { nativeRootExitObserved: false },
      { nativeReason: 'supervisor_failed' }, { nativeReason: undefined }, { supervisorProtocolFailed: true }]) {
      expect(confirmedServerExit({ ...mac, diagnostics: { ...mac.diagnostics, ...facts } })).toBe(false);
    }
    expect(confirmedServerExit({ backend: 'linux-bubblewrap', state: 'cancelled',
      terminationGuarantee: 'namespace_scoped', terminationScope: 'pid_namespace',
      survivorsPossible: false, completeDescendantTermination: true })).toBe(true);
  });

  test('rechecks completion and generation after an asynchronous permission check', async () => {
    assertNetwork.mockImplementation(async () => {
      servers.recordCompletion('one', recipe.port, { state: 'cancelled' });
    });
    await expect(servers.restart('one', id, launch)).rejects.toThrow('unconfirmed');
    servers.unconfirmedPorts.clear();
    assertNetwork.mockImplementation(async () => { servers.bindings.set(id, 'replacement'); });
    await expect(servers.restart('one', id, launch)).rejects.toThrow('changed');
    expect(processes.terminate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
