'use strict';

const { createWorkspaceTools, safeWorkspaceError } = require('./pi-workspace-tools');

function createSdk() {
  return {
    defineTool: jest.fn((tool) => tool),
    createAgentSession: jest.fn(),
    createExtensionRuntime: jest.fn(),
    createReadTool: jest.fn(),
    ModelRuntime: jest.fn(),
    SessionManager: jest.fn(),
    SettingsManager: jest.fn(),
  };
}

describe('Pi managed workspace tool', () => {
  test('requests one Agent-native disclosure, enables the workspace, and executes', async () => {
    const controller = {
      getWorkspace: jest
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValue({ workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa', enabled: true }),
      disclosure: jest.fn(async () => ({
        available: true,
        backend: 'linux-bubblewrap',
        network: 'disabled',
        filesystem: 'managed_workspace_only',
        cancellationGuarantee: 'namespace_scoped',
        survivorsPossible: false,
        completeDescendantTermination: true,
      })),
      enable: jest.fn(async () => ({ enabled: true })),
      execute: jest.fn(async () => ({
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
        commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
        command: 'pwd',
        workingDirectory: '.',
        backend: 'linux-bubblewrap',
        state: 'completed',
        stdout: '/workspace\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        terminationGuarantee: 'namespace_scoped',
        sideEffects: 'unknown',
      })),
    };
    const requestApproval = jest.fn(async () => 'approved');
    const onToolOutcome = jest.fn();
    const [tool] = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval,
      onToolOutcome,
    });

    await expect(
      tool.execute('call_one', { command: 'pwd' }, new AbortController().signal)
    ).resolves.toMatchObject({
      details: { workspace: expect.objectContaining({ state: 'completed' }) },
    });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'workspace_execution',
      operation: 'workspace_run',
      workspace: expect.objectContaining({ backend: 'linux-bubblewrap' }),
    });
    expect(controller.enable).toHaveBeenCalledWith('conversation_one');
    expect(controller.execute).toHaveBeenCalledWith(
      'conversation_one',
      expect.objectContaining({ command: 'pwd', workingDirectory: '.' })
    );
    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', operation: 'workspace_run' })
    );
  });

  test('does not execute when the user declines the workspace disclosure', async () => {
    const controller = {
      getWorkspace: jest.fn(() => null),
      disclosure: jest.fn(async () => ({ available: true, backend: 'macos-seatbelt' })),
      enable: jest.fn(),
      execute: jest.fn(),
    };
    const [tool] = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(async () => 'declined'),
    });

    await expect(tool.execute('call_one', { command: 'pwd' })).rejects.toMatchObject({
      code: 'WORKSPACE_EXECUTION_DECLINED',
    });
    expect(controller.enable).not.toHaveBeenCalled();
    expect(controller.execute).not.toHaveBeenCalled();
  });

  test('does not expose host paths in model-visible errors', () => {
    expect(
      safeWorkspaceError({
        code: 'WORKSPACE_POLICY_FAILED',
        message: 'Could not access /Users/private/project',
      }).message
    ).toBe(
      '[WORKSPACE_POLICY_FAILED] Freedom could not run the command inside the managed workspace'
    );
  });
});
