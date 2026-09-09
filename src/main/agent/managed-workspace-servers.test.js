'use strict';

const { ManagedWorkspaceServers } = require('./managed-workspace-servers');
const id = `workspace_server_${'a'.repeat(24)}`;
const recipe = { serverId: id, command: 'npm run dev', workingDirectory: 'game', port: 5173, previewToken: 'b'.repeat(40) };
const launch = { command: recipe.command, workingDirectory: recipe.workingDirectory, previewPort: recipe.port };

describe('saved workspace server restart', () => {
  let servers, store, processes, start, assertNetwork, checkPort;
  beforeEach(() => {
    store = { listServers: owner => owner === 'one' ? [recipe] : [] };
    processes = { inspect: jest.fn(() => ({ state: 'running' })),
      terminate: jest.fn(async () => ({ state: 'cancelled', receipt: {} })) };
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
    finish({ state: 'cancelled' }); await first;
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('uncertain Stop and occupied ports never authorize a replacement', async () => {
    processes.terminate.mockResolvedValue({ state: 'running' });
    await expect(servers.restart('one', id, launch)).rejects.toThrow('unconfirmed');
    processes.terminate.mockResolvedValue({ state: 'cancelled' });
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
});
