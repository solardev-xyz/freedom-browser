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
  base.createGrepTool = jest.fn(() => ({ name: 'grep', parameters: {} }));
  base.createFindTool = jest.fn(() => ({ name: 'find', parameters: {} }));
  base.createLsTool = jest.fn(() => ({ name: 'ls', parameters: {} }));
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
    listDirectory: jest.fn(async () => ({
      entries: [
        { name: 'src', type: 'directory' },
        { name: 'README.md', type: 'file' },
      ],
      limitReached: false,
    })),
    findFiles: jest.fn(async () => ({
      results: ['src/index.js'],
      limitReached: false,
      scanLimitReached: false,
    })),
    grepFiles: jest.fn(async () => ({
      output: 'src/index.js:1: hello workspace',
      matchCount: 1,
      limitReached: false,
      linesTruncated: false,
      outputTruncated: false,
      scanLimitReached: false,
    })),
    prepareExecutableAccess: jest.fn(async () => ({
      prepared: { kind: 'trusted-test-request' },
      publicRequest: {
        kind: 'command_access',
        command: 'node validate.js',
        workingDirectory: '.',
        commands: [
          {
            name: 'node',
            status: 'requires_permission',
            executablePath: '/opt/toolchain/bin/node',
            rootPath: '/opt/toolchain',
          },
        ],
      },
      approvalRequired: true,
      available: ['node'],
      unavailable: [],
    })),
    grantExecutableAccess: jest.fn(() => ({
      scope: 'once',
      commands: ['node'],
      command: 'node validate.js',
      workingDirectory: '.',
    })),
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

    expect(tools.map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'grep',
      'find',
      'ls',
      'request_permissions',
    ]);
    await expect(tools[0].execute('call_one', { command: 'pwd' })).resolves.toEqual({
      content: [{ type: 'text', text: '/workspace\n' }],
    });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'workspace_execution',
      operation: 'bash',
      workspace: expect.objectContaining({ backend: 'linux-bubblewrap' }),
    });
    expect(controller.enable).toHaveBeenCalledWith(
      'conversation_one',
      expect.objectContaining({ disclosureVerified: true, onPhase: expect.any(Function) })
    );
    expect(controller.execute).toHaveBeenCalledWith(
      'conversation_one',
      expect.objectContaining({ command: 'pwd', workingDirectory: '.' })
    );
    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', operation: 'bash' })
    );
  });

  test('requests a generic executable grant and applies the user-selected scope', async () => {
    const controller = createController();
    const requestApproval = jest.fn(async () => ({
      status: 'approved',
      workspacePermissionScope: 'conversation',
    }));
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval,
    });
    const permissionTool = tools.find((tool) => tool.name === 'request_permissions');

    await expect(
      permissionTool.execute('permission_one', {
        executables: ['node'],
        reason: 'Run the project validation script',
        command: 'node validate.js',
        workingDirectory: '.',
      })
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'Available: node.' }],
      details: {
        available: ['node'],
        unavailable: [],
        scope: 'conversation',
        command: 'node validate.js',
        workingDirectory: '.',
      },
    });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'workspace_permission',
      operation: 'request_permissions',
      label: 'Run the project validation script',
      workspacePermission: expect.objectContaining({
        kind: 'command_access',
        command: 'node validate.js',
        workingDirectory: '.',
      }),
    });
    expect(controller.prepareExecutableAccess).toHaveBeenCalledWith(
      'conversation_one',
      ['node'],
      expect.objectContaining({
        command: 'node validate.js',
        workingDirectory: '.',
        signal: undefined,
      })
    );
    expect(controller.grantExecutableAccess).toHaveBeenCalledWith(
      'conversation_one',
      { kind: 'trusted-test-request' },
      'conversation'
    );
  });

  test('opens and refreshes a static preview through the scoped tab authority', async () => {
    const previewUrl = `freedom-preview://${'a'.repeat(40)}/index.html`;
    const previewController = {
      createPreview: jest.fn(async () => ({ url: previewUrl, entryPath: 'index.html' })),
    };
    const scopedController = {
      execute: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, result: { tabs: [], activeTabId: null } })
        .mockResolvedValueOnce({
          ok: true,
          result: { activeTabId: 'tab_preview', tab: { tabId: 'tab_preview', url: previewUrl } },
        })
        .mockResolvedValueOnce({
          ok: true,
          result: { tabs: [{ tabId: 'tab_preview', url: previewUrl }] },
        })
        .mockResolvedValueOnce({ ok: true, result: { activeTabId: 'tab_preview' } })
        .mockResolvedValueOnce({
          ok: true,
          result: { activeTabId: 'tab_preview', tab: { tabId: 'tab_preview', url: previewUrl } },
        }),
    };
    const onToolOutcome = jest.fn();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller: createController(),
      previewController,
      scopedController,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(async () => 'approved'),
      onToolOutcome,
    });
    expect(tools.map((tool) => tool.name)).toContain('workspace_preview');
    const previewTool = tools.find((tool) => tool.name === 'workspace_preview');

    await expect(previewTool.execute('call_preview_one', {})).resolves.toMatchObject({
      content: [
        { type: 'text', text: 'Opened the static preview for index.html in an Agent tab.' },
      ],
      details: { entryPath: 'index.html', pageId: 'tab_preview' },
    });
    await previewTool.execute('call_preview_two', { path: '.' });

    expect(previewController.createPreview).toHaveBeenCalledWith('conversation_one', '.');
    expect(scopedController.execute).toHaveBeenCalledWith('browser_create_tab', {
      url: previewUrl,
    });
    expect(scopedController.execute).toHaveBeenCalledWith('browser_focus_tab', {
      tabId: 'tab_preview',
    });
    expect(scopedController.execute).toHaveBeenCalledWith('browser_navigate', {
      tabId: 'tab_preview',
      url: previewUrl,
    });
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'workspace_preview',
        status: 'succeeded',
        pageId: 'tab_preview',
      })
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

    expect(controller.readFile).toHaveBeenCalledWith(
      'conversation_one',
      'src/index.js',
      expect.objectContaining({ onPhase: expect.any(Function) })
    );
    expect(controller.createDirectory).toHaveBeenCalledWith(
      'conversation_one',
      'src',
      expect.objectContaining({ onPhase: expect.any(Function) })
    );
    expect(controller.writeFile).toHaveBeenCalledWith(
      'conversation_one',
      'src/new.js',
      'new text',
      expect.objectContaining({ onPhase: expect.any(Function) })
    );
    expect(controller.writeFile).toHaveBeenCalledWith(
      'conversation_one',
      'src/index.js',
      'goodbye workspace',
      expect.objectContaining({ onPhase: expect.any(Function) })
    );
  });

  test('delegates grep, glob discovery, and directory listing without host tools', async () => {
    const controller = createController();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(),
    });

    await expect(
      tools[4].execute('grep_one', { pattern: 'hello', path: 'src', glob: '*.js' })
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'src/index.js:1: hello workspace' }],
      details: { matchCount: 1 },
    });
    await expect(tools[5].execute('find_one', { pattern: '*.js', path: 'src' })).resolves.toEqual({
      content: [{ type: 'text', text: 'src/index.js' }],
      details: { resultCount: 1 },
    });
    await expect(tools[6].execute('ls_one', { path: '.' })).resolves.toEqual({
      content: [{ type: 'text', text: 'src/\nREADME.md' }],
      details: { entryCount: 2 },
    });

    expect(controller.grepFiles).toHaveBeenCalledWith(
      'conversation_one',
      'src',
      expect.objectContaining({ pattern: 'hello', glob: '*.js', signal: undefined })
    );
    expect(controller.findFiles).toHaveBeenCalledWith(
      'conversation_one',
      'src',
      expect.objectContaining({ pattern: '*.js', signal: undefined })
    );
    expect(controller.listDirectory).toHaveBeenCalledWith(
      'conversation_one',
      '.',
      expect.objectContaining({ signal: undefined })
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

  test('cancels workspace startup independently of Pi tool cancellation', async () => {
    const controller = createController();
    controller.getWorkspace.mockReturnValue(null);
    controller.disclosure.mockImplementation((_conversationId, request) => {
      request.onPhase('checking_capabilities');
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('The workspace operation was stopped');
            error.code = 'WORKSPACE_OPERATION_CANCELLED';
            reject(error);
          },
          { once: true }
        );
      });
    });
    const runAbort = new AbortController();
    const onToolPhase = jest.fn();
    const onToolOutcome = jest.fn();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(),
      getRunSignal: () => runAbort.signal,
      onToolPhase,
      onToolOutcome,
    });

    const execution = tools[0].execute('call_cancelled', { command: 'pwd' });
    runAbort.abort();

    await expect(execution).rejects.toMatchObject({ code: 'WORKSPACE_OPERATION_CANCELLED' });
    expect(controller.enable).not.toHaveBeenCalled();
    expect(controller.execute).not.toHaveBeenCalled();
    expect(onToolPhase).toHaveBeenCalledWith({
      toolCallId: 'call_cancelled',
      operation: 'bash',
      phase: 'checking_capabilities',
    });
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'WORKSPACE_OPERATION_CANCELLED',
        workspace: expect.objectContaining({ state: 'cancelled' }),
      })
    );
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

  test('distinguishes command-not-found and missing files from sandbox denial', async () => {
    const controller = createController();
    const onToolOutcome = jest.fn();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(),
      onToolOutcome,
    });
    controller.execute.mockResolvedValueOnce({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
      kind: 'command',
      command: 'missing-tool',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      state: 'failed',
      exitCode: 127,
      stdout: '',
      stderr: '/bin/sh: missing-tool: command not found\n',
      stdoutTruncated: false,
      stderrTruncated: false,
      terminationGuarantee: 'namespace_scoped',
      sideEffects: 'unknown',
    });

    await expect(
      tools[0].execute('bash_missing', { command: 'missing-tool' })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_COMMAND_NOT_FOUND',
    });
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        errorCode: 'WORKSPACE_COMMAND_NOT_FOUND',
        workspace: expect.objectContaining({ state: 'failed', exitCode: 127 }),
      })
    );

    const missing = new Error('The requested workspace path does not exist');
    missing.code = 'WORKSPACE_PATH_NOT_FOUND';
    controller.accessFile.mockRejectedValueOnce(missing);
    await expect(tools[1].execute('read_missing', { path: 'missing.txt' })).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_NOT_FOUND',
    });
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        errorCode: 'WORKSPACE_PATH_NOT_FOUND',
        workspace: expect.objectContaining({ state: 'failed' }),
      })
    );
  });

  test('keeps an executor launch failure distinct from a command exit or policy denial', async () => {
    const controller = createController();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(),
    });
    controller.execute.mockResolvedValueOnce({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
      kind: 'command',
      command: 'pwd',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      state: 'failed',
      exitCode: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      terminationGuarantee: 'unknown',
      sideEffects: 'unknown',
      survivorsPossible: true,
      completeDescendantTermination: false,
      error: {
        code: 'WORKSPACE_EXECUTION_FAILED',
        message: 'Freedom could not execute the command inside the verified sandbox',
      },
    });

    await expect(tools[0].execute('bash_launch_failed', { command: 'pwd' })).rejects.toMatchObject({
      code: 'WORKSPACE_EXECUTION_FAILED',
    });
  });
});
