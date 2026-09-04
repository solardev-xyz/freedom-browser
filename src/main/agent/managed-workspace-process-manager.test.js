'use strict';

const {
  MAX_PROCESS_LOG_BYTES,
  ManagedWorkspaceProcessManager,
} = require('./managed-workspace-process-manager');

function receipt(overrides = {}) {
  return {
    workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
    commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
    command: 'node server.js',
    workingDirectory: '.',
    backend: 'linux-bubblewrap',
    networkPosture: 'none',
    state: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    terminationGuarantee: 'namespace_scoped',
    sideEffects: 'unknown',
    survivorsPossible: false,
    completeDescendantTermination: true,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe('ManagedWorkspaceProcessManager', () => {
  test('returns ordinary commands directly when they finish before yielding', async () => {
    const manager = new ManagedWorkspaceProcessManager({
      execute: jest.fn(async (_conversationId, request) => {
        request.onOutput('stdout', Buffer.from('hello\n'));
        return receipt({ stdout: 'hello\n' });
      }),
      idFactory: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });

    await expect(manager.start('conversation_one', { command: 'node hello.js' })).resolves.toEqual(
      expect.objectContaining({
        processId: 'workspace_process_aaaaaaaaaaaaaaaaaaaaaaaa',
        state: 'completed',
        output: 'hello\n',
        receipt: expect.objectContaining({ state: 'completed' }),
      })
    );
  });

  test('yields a running process, streams later output, accepts input, and reports completion', async () => {
    const completion = deferred();
    let request;
    const write = jest.fn(() => true);
    const manager = new ManagedWorkspaceProcessManager({
      execute: jest.fn(async (_conversationId, value) => {
        request = value;
        value.onStarted({
          workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
          commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
          command: 'node server.js',
          workingDirectory: '.',
          backend: 'linux-bubblewrap',
          networkPosture: 'none',
          state: 'running',
        });
        value.onStdin({ write });
        value.onOutput('stdout', Buffer.from('ready\n'));
        return completion.promise;
      }),
      idFactory: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });

    const started = await manager.start('conversation_one', {
      command: 'node server.js',
      yieldMs: 1,
    });
    expect(started).toEqual(
      expect.objectContaining({
        processId: 'workspace_process_bbbbbbbbbbbbbbbbbbbbbbbb',
        state: 'running',
        output: 'ready\n',
        workspace: expect.objectContaining({
          commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
          state: 'running',
        }),
      })
    );

    request.onOutput('stderr', Buffer.from('request\n'));
    const interaction = manager.interact('conversation_one', started.processId, {
      input: 'reload\n',
      waitMs: 0,
    });
    await expect(interaction).resolves.toEqual(
      expect.objectContaining({ state: 'running', output: 'request\n' })
    );
    expect(write).toHaveBeenCalledWith(Buffer.from('reload\n'));

    completion.resolve(receipt({ stdout: 'ready\n', stderr: 'request\n' }));
    await expect(
      manager.interact('conversation_one', started.processId, { waitMs: 1_000 })
    ).resolves.toEqual(expect.objectContaining({ state: 'completed' }));
  });

  test('binds process access to its conversation and terminates through the retained signal', async () => {
    let request;
    const manager = new ManagedWorkspaceProcessManager({
      execute: jest.fn(async (_conversationId, value) => {
        request = value;
        await new Promise((resolve) =>
          value.signal.addEventListener('abort', resolve, { once: true })
        );
        return receipt({ state: 'cancelled', exitCode: null, signal: 'SIGKILL' });
      }),
      idFactory: () => 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    });
    const started = await manager.start('conversation_one', {
      command: 'node server.js',
      yieldMs: 1,
    });

    await expect(
      manager.interact('conversation_two', started.processId, { waitMs: 0 })
    ).rejects.toMatchObject({ code: 'WORKSPACE_PROCESS_NOT_FOUND' });
    const stopped = manager.interact('conversation_one', started.processId, {
      terminate: true,
      waitMs: 1_000,
    });
    await expect(stopped).resolves.toEqual(
      expect.objectContaining({
        state: 'cancelled',
        receipt: expect.objectContaining({ signal: 'SIGKILL' }),
      })
    );
    expect(request.signal.aborted).toBe(true);
  });

  test('keeps only bounded undelivered output', async () => {
    const completion = deferred();
    let request;
    const manager = new ManagedWorkspaceProcessManager({
      execute: jest.fn(async (_conversationId, value) => {
        request = value;
        return completion.promise;
      }),
      idFactory: () => 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    });
    const started = await manager.start('conversation_one', {
      command: 'yes',
      yieldMs: 1,
    });
    request.onOutput('stdout', Buffer.alloc(MAX_PROCESS_LOG_BYTES + 10, 'x'));

    const polled = await manager.interact('conversation_one', started.processId, { waitMs: 0 });
    expect(Buffer.byteLength(polled.output)).toBe(MAX_PROCESS_LOG_BYTES);
    expect(polled.outputTruncated).toBe(true);
    manager.dispose();
    completion.resolve(receipt({ state: 'cancelled' }));
  });

  test('expires a process that fails after its initial result was yielded', async () => {
    const completion = deferred();
    const retention = [];
    const manager = new ManagedWorkspaceProcessManager({
      execute: jest.fn(async () => completion.promise),
      idFactory: () => 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      setTimer: (callback, delay) => {
        if (delay === 250) queueMicrotask(callback);
        else retention.push(callback);
        return { unref: jest.fn() };
      },
      clearTimer: jest.fn(),
    });
    const started = await manager.start('conversation_one', {
      command: 'node server.js',
      yieldMs: 250,
    });
    completion.reject(Object.assign(new Error('launch failed'), { code: 'LAUNCH_FAILED' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(retention).toHaveLength(1);
    retention[0]();
    await expect(
      manager.interact('conversation_one', started.processId, { waitMs: 0 })
    ).rejects.toMatchObject({ code: 'WORKSPACE_PROCESS_NOT_FOUND' });
  });
});
