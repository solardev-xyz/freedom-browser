'use strict';

const {
  MAX_MODEL_BASH_OUTPUT_BYTES,
  boundedBashOutput,
  createWorkspaceTools,
  safeWorkspaceError,
  virtualPathToWorkspaceRelative,
} = require('./pi-workspace-tools');
const { skillVirtualPath } = require('./builtin-skills');

function createSdk() {
  const base = {
    createAgentSession: jest.fn(),
    createExtensionRuntime: jest.fn(),
    defineTool: jest.fn((tool) => tool),
    ModelRuntime: jest.fn(),
    SessionManager: jest.fn(),
    SettingsManager: jest.fn(),
  };
  base.createBashTool = jest.fn((_cwd, options) => ({
    name: 'bash',
    execute: async (_id, params, signal) => {
      const chunks = [];
      const result = await options.operations.exec(params.command, '/freedom-agent', {
        onData: (chunk) => chunks.push(Buffer.from(chunk)),
        signal,
        timeout: params.timeout,
      });
      if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}`);
      return { content: [{ type: 'text', text: Buffer.concat(chunks).toString('utf8') }] };
    },
  }));
  base.createReadTool = jest.fn((_cwd, options) => ({
    name: 'read',
    execute: async (_id, params) => {
      const absolute = params.path.startsWith('/') ? params.path : `/freedom-agent/${params.path}`;
      await options.operations.access(absolute);
      const content = await options.operations.readFile(absolute);
      return { content: [{ type: 'text', text: content.toString('utf8') }] };
    },
  }));
  base.createWriteTool = jest.fn((_cwd, options) => ({
    name: 'write',
    execute: async (_id, params) => {
      const absolute = `/freedom-agent/${params.path}`;
      await options.operations.mkdir(absolute.slice(0, absolute.lastIndexOf('/')));
      await options.operations.writeFile(absolute, params.content);
      return { content: [{ type: 'text', text: 'written' }] };
    },
  }));
  base.createEditTool = jest.fn((_cwd, options) => ({
    name: 'edit',
    execute: async (_id, params) => {
      const absolute = `/freedom-agent/${params.path}`;
      await options.operations.access(absolute);
      const original = (await options.operations.readFile(absolute)).toString('utf8');
      const edit = params.edits[0];
      await options.operations.writeFile(absolute, original.replace(edit.oldText, edit.newText));
      return { content: [{ type: 'text', text: 'edited' }] };
    },
  }));
  return base;
}

function createController() {
  return {
    getWorkspace: jest.fn(() => ({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      enabled: true,
      backend: 'linux-bubblewrap',
    })),
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
      kind: 'command',
      command: 'pwd',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      state: 'completed',
      exitCode: 0,
      stdout: '/workspace\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      terminationGuarantee: 'namespace_scoped',
      sideEffects: 'unknown',
    })),
    accessFile: jest.fn(async () => {}),
    readFile: jest.fn(async () => Buffer.from('hello workspace')),
    createDirectory: jest.fn(async () => {}),
    writeFile: jest.fn(async () => {}),
  };
}

describe('Pi managed workspace tools', () => {
  test('exposes standard Pi tool names backed by Freedom operations', async () => {
    const sdk = createSdk();
    const controller = createController();
    controller.getWorkspace.mockReturnValueOnce(null).mockReturnValue({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      enabled: true,
      backend: 'linux-bubblewrap',
    });
    const requestApproval = jest.fn(async () => 'approved');
    const onToolOutcome = jest.fn();
    const tools = await createWorkspaceTools({
      sdk,
      controller,
      conversationId: 'conversation_one',
      requestApproval,
      onToolOutcome,
    });

    expect(tools.map((tool) => tool.name)).toEqual(['bash', 'read', 'write', 'edit']);
    await expect(tools[0].execute('call_one', { command: 'pwd' })).resolves.toEqual({
      content: [{ type: 'text', text: '/workspace\n' }],
    });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'workspace_execution',
      operation: 'bash',
      workspace: expect.objectContaining({ backend: 'linux-bubblewrap' }),
    });
    expect(controller.enable).toHaveBeenCalledWith('conversation_one');
    expect(controller.execute).toHaveBeenCalledWith(
      'conversation_one',
      expect.objectContaining({ command: 'pwd', workingDirectory: '.' })
    );
    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', operation: 'bash' })
    );
  });

  test('delegates bounded file reads, writes, and edits to the managed controller', async () => {
    const controller = createController();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(),
    });

    await expect(tools[1].execute('read_one', { path: 'src/index.js' })).resolves.toEqual({
      content: [{ type: 'text', text: 'hello workspace' }],
    });
    await tools[2].execute('write_one', { path: 'src/new.js', content: 'new text' });
    await tools[3].execute('edit_one', {
      path: 'src/index.js',
      edits: [{ oldText: 'hello', newText: 'goodbye' }],
    });

    expect(controller.readFile).toHaveBeenCalledWith('conversation_one', 'src/index.js');
    expect(controller.createDirectory).toHaveBeenCalledWith('conversation_one', 'src');
    expect(controller.writeFile).toHaveBeenCalledWith('conversation_one', 'src/new.js', 'new text');
    expect(controller.writeFile).toHaveBeenCalledWith(
      'conversation_one',
      'src/index.js',
      'goodbye workspace'
    );
  });

  test('loads exact reviewed skill paths without requesting workspace consent', async () => {
    const controller = createController();
    controller.getWorkspace.mockReturnValue(null);
    const requestApproval = jest.fn();
    const onToolOutcome = jest.fn();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval,
      onToolOutcome,
    });

    const result = await tools[1].execute('skill_read', {
      path: skillVirtualPath('swarm-postage', 'SKILL.md'),
    });
    expect(result.content[0].text).toContain('Swarm postage');
    expect(requestApproval).not.toHaveBeenCalled();
    expect(controller.readFile).not.toHaveBeenCalled();
    expect(onToolOutcome).not.toHaveBeenCalled();
  });

  test('does not execute when the user declines the workspace disclosure', async () => {
    const controller = createController();
    controller.getWorkspace.mockReturnValue(null);
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(async () => 'declined'),
    });

    await expect(tools[0].execute('call_one', { command: 'pwd' })).rejects.toMatchObject({
      code: 'WORKSPACE_EXECUTION_DECLINED',
    });
    expect(controller.enable).not.toHaveBeenCalled();
    expect(controller.execute).not.toHaveBeenCalled();
  });

  test('rejects virtual paths outside the workspace and bounds command output', () => {
    expect(() => virtualPathToWorkspaceRelative('/etc/passwd')).toThrow(
      'inside the managed workspace'
    );
    const receipt = { stdout: 'x'.repeat(MAX_MODEL_BASH_OUTPUT_BYTES + 100), stderr: '' };
    const output = boundedBashOutput(receipt).toString('utf8');
    expect(output).toContain('Freedom omitted earlier command output');
    expect(output.endsWith('x'.repeat(MAX_MODEL_BASH_OUTPUT_BYTES))).toBe(true);
  });

  test('does not expose host paths in model-visible errors', () => {
    expect(
      safeWorkspaceError({
        code: 'WORKSPACE_POLICY_FAILED',
        message: 'Could not access /Users/private/project',
      }).message
    ).toBe(
      '[WORKSPACE_POLICY_FAILED] Freedom could not complete the operation inside the managed workspace'
    );
  });
});
