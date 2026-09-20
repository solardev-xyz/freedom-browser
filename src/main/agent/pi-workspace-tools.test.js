'use strict';

const {
  MAX_MODEL_BASH_OUTPUT_BYTES,
  boundedBashOutput,
  createWorkspaceTools,
  safeWorkspaceError,
  virtualPathToWorkspaceRelative,
} = require('./pi-workspace-tools');
const { skillVirtualPath } = require('./builtin-skills');
const { ExternalProjectAccess } = require('./external-project-access');
const { WorkspaceHistoryError } = require('./managed-workspace-history');

function createSdk() {
  const base = {
    createAgentSession: jest.fn(),
    createExtensionRuntime: jest.fn(),
    defineTool: jest.fn((tool) => tool),
    ModelRuntime: jest.fn(),
    SessionManager: jest.fn(),
    SettingsManager: jest.fn(),
  };
  base.createBashTool = jest.fn((cwd, options) => ({
    name: 'bash',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' },
      },
    },
    execute: async (_id, params, signal) => {
      const chunks = [];
      const result = await options.operations.exec(params.command, cwd, {
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
  const controller = {
    fullNetworkPermissionsEnabled: jest.fn(() => false),
    getWorkspace: jest.fn(() => ({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      enabled: true,
      backend: 'linux-bubblewrap',
      networkPosture: 'none',
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
      terminationScope: 'pid_namespace',
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
    inspectProcess: jest.fn(),
    prepareCommandPermissions: jest.fn(async () => ({
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
    grantCommandPermissions: jest.fn(() => ({
      scope: 'once',
      commands: ['node'],
      command: 'node validate.js',
      workingDirectory: '.',
    })),
  };
  controller.startProcess = jest.fn(async (conversationId, request) => {
    const workspace = await controller.execute(conversationId, request);
    return {
      processId: 'workspace_process_cccccccccccccccccccccccc',
      state: workspace.state,
      output: `${workspace.stdout || ''}${workspace.stderr || ''}`,
      outputTruncated: workspace.stdoutTruncated || workspace.stderrTruncated,
      receipt: workspace,
      workspace,
    };
  });
  controller.interactProcess = jest.fn(async () => ({
    processId: 'workspace_process_cccccccccccccccccccccccc',
    state: 'running',
    output: '',
    outputTruncated: false,
    workspace: {
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      processId: 'workspace_process_cccccccccccccccccccccccc',
      kind: 'process',
      command: 'node server.js',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      networkPosture: 'none',
      state: 'running',
      stdoutTruncated: false,
      stderrTruncated: false,
      terminationGuarantee: 'pending',
      terminationScope: 'pending',
      sideEffects: 'unknown',
      survivorsPossible: true,
      completeDescendantTermination: false,
    },
  }));
  return controller;
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
      'write_stdin',
    ]);
    expect(tools[0].parameters.properties).not.toHaveProperty('previewPort');
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
    expect(tools[0].parameters.properties.workingDirectory).toMatchObject({
      type: 'string',
      maxLength: 1_024,
    });
    expect(tools[0].parameters.properties.yield_time_ms).toMatchObject({
      type: 'number',
      maximum: 30_000,
    });
    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', operation: 'bash' })
    );
  });

  test('yields long-running bash commands and continues them through write_stdin', async () => {
    const controller = createController();
    const onToolOutcome = jest.fn();
    const onProcessTerminal = jest.fn();
    controller.startProcess.mockResolvedValueOnce({
      processId: 'workspace_process_cccccccccccccccccccccccc',
      state: 'running',
      output: 'server ready\n',
      outputTruncated: false,
      workspace: {
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
        commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
        processId: 'workspace_process_cccccccccccccccccccccccc',
        kind: 'command',
        command: 'node server.js',
        workingDirectory: '.',
        backend: 'linux-bubblewrap',
        networkPosture: 'full',
        state: 'running',
        stdoutTruncated: false,
        stderrTruncated: false,
        terminationGuarantee: 'pending',
        sideEffects: 'unknown',
        survivorsPossible: true,
        completeDescendantTermination: false,
      },
    });
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(),
      onToolOutcome,
      onProcessTerminal,
    });

    await expect(
      tools[0].execute('bash_server', {
        command: 'node server.js',
        yield_time_ms: 250,
      })
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: expect.stringContaining(
            'Command still running with session ID workspace_process_cccccccccccccccccccccccc'
          ),
        },
      ],
    });
    expect(controller.startProcess).toHaveBeenCalledWith(
      'conversation_one',
      expect.objectContaining({
        command: 'node server.js',
        yieldMs: 250,
        onTerminal: expect.any(Function),
      })
    );
    controller.startProcess.mock.calls[0][1].onTerminal({
      workspace: { state: 'completed' },
    });
    expect(onProcessTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'bash_server',
        operation: 'bash',
        workspace: expect.objectContaining({ state: 'completed' }),
      })
    );

    const processTool = tools.find((tool) => tool.name === 'write_stdin');
    await processTool.execute('process_poll', {
      session_id: 'workspace_process_cccccccccccccccccccccccc',
      yield_time_ms: 0,
    });
    expect(controller.interactProcess).toHaveBeenCalledWith(
      'conversation_one',
      'workspace_process_cccccccccccccccccccccccc',
      expect.objectContaining({ input: '', waitMs: 0, terminate: false })
    );
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'write_stdin', status: 'succeeded' })
    );
  });

  test('runs bash in a requested workspace-relative working directory', async () => {
    const controller = createController();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(),
    });

    await tools[0].execute('call_subdirectory', {
      command: 'npm test',
      workingDirectory: 'packages/site',
    });

    expect(controller.execute).toHaveBeenCalledWith(
      'conversation_one',
      expect.objectContaining({ command: 'npm test', workingDirectory: 'packages/site' })
    );
  });

  test('rejects bash working directories outside the managed workspace', async () => {
    const controller = createController();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(),
    });

    await expect(
      tools[0].execute('call_outside', { command: 'pwd', workingDirectory: '../outside' })
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_REQUEST' });
    await expect(
      tools[0].execute('call_absolute', { command: 'pwd', workingDirectory: '/freedom-agent' })
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_REQUEST' });
    expect(controller.execute).not.toHaveBeenCalled();
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
      content: [{ type: 'text', text: 'Installed; access granted for this conversation: node.' }],
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
    expect(controller.prepareCommandPermissions).toHaveBeenCalledWith(
      'conversation_one',
      { executables: ['node'] },
      expect.objectContaining({
        command: 'node validate.js',
        workingDirectory: '.',
        signal: undefined,
      })
    );
    expect(controller.grantCommandPermissions).toHaveBeenCalledWith(
      'conversation_one',
      { kind: 'trusted-test-request' },
      'conversation'
    );
    expect(permissionTool.parameters.properties).not.toHaveProperty('network');
  });

  test('requests the gated full-network bundle without requiring an executable', async () => {
    const controller = createController();
    controller.fullNetworkPermissionsEnabled.mockReturnValue(true);
    controller.prepareCommandPermissions.mockResolvedValue({
      prepared: { kind: 'trusted-network-request' },
      publicRequest: {
        kind: 'command_access',
        command: 'curl https://example.com',
        workingDirectory: '.',
        commands: [],
        network: {
          posture: 'full',
          publicInternet: true,
          hostLoopback: true,
          privateLan: true,
          hostAbstractUnixSockets: 'reachable',
        },
      },
      approvalRequired: true,
      available: [],
      unavailable: [],
    });
    const requestApproval = jest.fn(async () => ({
      status: 'approved',
      workspacePermissionScope: 'once',
    }));
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      conversationId: 'conversation_one',
      requestApproval,
    });
    const permissionTool = tools.find((tool) => tool.name === 'request_permissions');

    expect(permissionTool.parameters).toMatchObject({
      required: ['reason'],
      oneOf: [expect.objectContaining({ required: ['project'] }), expect.objectContaining({ required: ['command', 'workingDirectory'], anyOf: [{ required: ['executables'] }, { required: ['network'] }] })],
      properties: { network: { enum: ['full'] } },
    });
    await expect(
      permissionTool.execute('permission_network', {
        network: 'full',
        reason: 'Download project dependencies',
        command: 'curl https://example.com',
        workingDirectory: '.',
      })
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'Full direct networking is available for the approved scope.',
        },
      ],
      details: {
        available: [],
        unavailable: [],
        commands: [],
        scope: 'once',
        command: 'curl https://example.com',
        workingDirectory: '.',
        network: 'full',
      },
    });
    expect(controller.prepareCommandPermissions).toHaveBeenCalledWith(
      'conversation_one',
      { executables: [], network: 'full' },
      expect.objectContaining({
        command: 'curl https://example.com',
        workingDirectory: '.',
      })
    );
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'workspace_permission',
      operation: 'request_permissions',
      label: 'Download project dependencies',
      workspacePermission: expect.objectContaining({
        network: expect.objectContaining({ posture: 'full' }),
      }),
    });
    expect(controller.grantCommandPermissions).toHaveBeenCalledWith(
      'conversation_one',
      { kind: 'trusted-network-request' },
      'once'
    );
  });

  test('reopens and switches static projects across turns without clearing page observation checks', async () => {
    const { OriginScopedAutomationController } = require('../automation/origin-scoped-controller');
    const tabs = new Map();
    const browser = {
      execute: jest.fn(async (operation, input) => {
        if (operation === 'browser_create_tab') {
          const tab = { tabId: `tab_${tabs.size + 1}`, url: input.url };
          tabs.set(tab.tabId, tab);
          return { ok: true, result: { tab } };
        }
        const tab = tabs.get(input.tabId);
        if (!tab) return { ok: false, error: { code: 'TAB_NOT_FOUND' } };
        if (operation === 'browser_navigate') tab.url = input.url;
        return { ok: true, result: { tab, elements: [] } };
      }),
    };
    const scope = new OriginScopedAutomationController({
      controller: browser,
      createWorkspacePage: async (url) => {
        const created = await browser.execute('browser_create_tab', { url });
        return created.result.tab.tabId;
      },
    });
    const previewController = {
      createPreview: jest.fn(async (_conversation, path) => ({
        url: `freedom-preview://${(path === 'game-two/index.html' ? 'b' : 'a').repeat(40)}/index.html`,
        entryPath: path,
      })),
    };
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller: createController(),
      previewController,
      scopedController: scope,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(async () => 'approved'),
    });
    const preview = tools.find((tool) => tool.name === 'workspace_preview');
    await expect(preview.execute('first', { path: 'game-one/index.html' })).resolves.toMatchObject({
      details: { pageId: 'tab_1' },
    });
    await scope.prepareResume();
    await expect(preview.execute('reopen', { path: 'game-one/index.html' })).resolves.toMatchObject({
      details: { pageId: 'tab_1' },
    });
    expect(tabs.size).toBe(1);
    await scope.prepareResume();
    await expect(preview.execute('switch', { path: 'game-two/index.html' })).resolves.toMatchObject({
      details: { pageId: 'tab_2' },
    });
    expect(browser.execute).toHaveBeenCalledWith('browser_create_tab', {
      url: `freedom-preview://${'b'.repeat(40)}/index.html`,
      openerTabId: 'tab_1',
    });
    await scope.prepareResume();
    await expect(preview.execute('return', { path: 'game-one/index.html' })).resolves.toMatchObject({
      details: { pageId: 'tab_1' },
    });
    expect(tabs.size).toBe(2);
    for (const operation of ['browser_click', 'browser_navigate']) {
      await expect(
        scope.execute(operation, { tabId: 'tab_1', url: 'https://example.com', ref: 'stale' })
      ).resolves.toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    }
    await expect(scope.execute('browser_snapshot', { tabId: 'tab_1' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'POLICY_DENIED' },
    });
    await scope.execute('browser_get_tab', { tabId: 'tab_1' });
    await scope.execute('browser_snapshot', { tabId: 'tab_1' });
    await expect(
      scope.execute('browser_navigate', { tabId: 'tab_1', url: tabs.get('tab_1').url })
    ).resolves.toMatchObject({ ok: true });
    for (const url of [
      'https://example.com',
      'file:///private/index.html',
      'freedom-preview://bad/index.html',
    ]) {
      await expect(scope.openWorkspacePreview(url)).resolves.toMatchObject({
        ok: false,
        error: { code: 'POLICY_DENIED' },
      });
    }
  });

  test('declares and opens a gated managed server preview through one process identity', async () => {
    const processId = 'workspace_process_dddddddddddddddddddddddd';
    const previewUrl = `freedom-preview://${'b'.repeat(40)}/`;
    const controller = createController();
    controller.fullNetworkPermissionsEnabled.mockReturnValue(true);
    controller.startProcess.mockResolvedValue({
      processId,
      state: 'running',
      output: 'ready\n',
      workspace: {
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
        processId,
        command: 'node server.js',
        workingDirectory: '.',
        backend: 'linux-bubblewrap',
        networkPosture: 'full',
        previewPort: 4_173,
        state: 'running',
        terminationGuarantee: 'pending',
        terminationScope: 'pending',
        sideEffects: 'unknown',
        survivorsPossible: false,
        completeDescendantTermination: false,
      },
    });
    const previewController = {
      createPreview: jest.fn(),
      createProcessPreview: jest.fn(() => ({
        kind: 'server',
        url: previewUrl,
        entryPath: 'server on port 4173',
        processId,
        port: 4_173,
      })),
    };
    const scopedController = {
      openWorkspacePreview: jest.fn().mockResolvedValueOnce({
          ok: true,
          result: { activeTabId: 'tab_server', tab: { tabId: 'tab_server', url: previewUrl } },
        }),
    };
    const onToolOutcome = jest.fn();
    const tools = await createWorkspaceTools({
      sdk: createSdk(),
      controller,
      previewController,
      scopedController,
      conversationId: 'conversation_one',
      requestApproval: jest.fn(async () => 'approved'),
      onToolOutcome,
    });
    const bash = tools.find((tool) => tool.name === 'bash');
    const preview = tools.find((tool) => tool.name === 'workspace_preview');
    expect(bash.parameters.properties.previewPort).toMatchObject({
      minimum: 1_024,
      maximum: 65_535,
    });
    expect(preview.parameters.properties.processId).toBeDefined();

    await expect(
      bash.execute('call_invalid_fractional_port', {
        command: 'node server.js',
        previewPort: 4_173.5,
      })
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_PROCESS_REQUEST' });
    await expect(
      bash.execute('call_invalid_string_port', {
        command: 'node server.js',
        previewPort: '4173',
      })
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_PROCESS_REQUEST' });
    expect(controller.startProcess).not.toHaveBeenCalled();

    await expect(
      bash.execute('call_server', {
        command: 'node server.js',
        previewPort: 4_173,
        yield_time_ms: 250,
      })
    ).resolves.toMatchObject({ content: [expect.objectContaining({ type: 'text' })] });
    expect(controller.startProcess).toHaveBeenCalledWith(
      'conversation_one',
      expect.objectContaining({
        command: 'node server.js',
        previewPort: 4_173,
        yieldMs: 250,
      })
    );

    await expect(preview.execute('call_preview_server', { processId })).resolves.toMatchObject({
      content: [
        {
          type: 'text',
          text: 'Opened the managed server preview on port 4173 in an Agent tab.',
        },
      ],
      details: { kind: 'server', processId, port: 4_173, pageId: 'tab_server' },
    });
    expect(previewController.createProcessPreview).toHaveBeenCalledWith(
      'conversation_one',
      processId
    );
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'workspace_preview',
        status: 'succeeded',
        workspace: expect.objectContaining({
          kind: 'server_preview',
          networkPosture: 'full',
        }),
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
    expect(safeWorkspaceError({
      code: 'EXECUTABLE_INTERPRETER_UNAVAILABLE',
      message: 'The interpreter node required by npm is unavailable in the installed command environment',
    }).message).toContain('node required by npm');
    expect(safeWorkspaceError({
      code: 'EXECUTABLE_INTERPRETER_UNSUPPORTED', message: 'Cannot read /private/launcher',
    }).message).not.toContain('/private');
  });

  test.each(['PROJECT_RECONNECT_REQUIRED', 'PROJECT_READ_ONLY', 'PROJECT_CHANGED', 'WORKSPACE_HISTORY_CHANGED'])('preserves actionable %s without leaking host paths', (code) => {
    const result = safeWorkspaceError({ code, message: '/private/user/project secret' });
    expect(result.code).toBe(code);
    expect(result.message).not.toContain('/private');
    expect(result.message).not.toContain('secret');
  });

  test('returns bounded failed-command diagnostics to Pi without persisting output in activity', async () => {
    const controller = createController();
    const onToolOutcome = jest.fn();
    controller.startProcess.mockResolvedValueOnce({
      state: 'failed', output: 'install starting\nCannot find module npm-prefix.js\n',
      workspace: {
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
        kind: 'command', command: 'npm install', workingDirectory: '.',
        state: 'failed', exitCode: 1, backend: 'macos-seatbelt', sideEffects: 'unknown',
      },
    });
    const tools = await createWorkspaceTools({
      sdk: createSdk(), controller, conversationId: 'conversation_one',
      requestApproval: jest.fn(), onToolOutcome,
    });
    await expect(tools[0].execute('install_failed', { command: 'npm install' })).rejects.toMatchObject({
      code: 'WORKSPACE_COMMAND_FAILED',
      message: expect.stringContaining('install starting\nCannot find module npm-prefix.js'),
    });
    expect(JSON.stringify(onToolOutcome.mock.calls)).not.toContain('Cannot find module');
    const safe = safeWorkspaceError(new Error('private infrastructure error'), {
      operation: 'bash', receipt: { state: 'failed', exitCode: 1 },
      commandOutput: 'discarded-prefix' + 'x'.repeat(MAX_MODEL_BASH_OUTPUT_BYTES) + 'diagnostic-tail',
    });
    expect(safe.message).toContain('diagnostic-tail');
    expect(safe.message).not.toMatch(/discarded-prefix|private infrastructure error/);
    expect(safe.message.length).toBeLessThan(MAX_MODEL_BASH_OUTPUT_BYTES + 512);
    expect(safeWorkspaceError(new Error('/private/launch'), {
      operation: 'bash', receipt: { state: 'failed', error: { code: 'WORKSPACE_EXECUTION_FAILED' } },
      commandOutput: '/private/launch details',
    }).message).not.toContain('/private');
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
      terminationScope: 'pid_namespace',
      sideEffects: 'unknown',
    });

    await expect(
      tools[0].execute('bash_missing', { command: 'missing-tool' })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_COMMAND_NOT_FOUND',
      message: expect.stringContaining('Next: call request_permissions'),
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

  test.each([false, true])('command discovery guidance remains present with networking enabled: %s', async (networkEnabled) => {
    const controller = createController();
    controller.fullNetworkPermissionsEnabled = () => networkEnabled;
    const tools = await createWorkspaceTools({
      sdk: createSdk(), controller, conversationId: 'conversation_one', requestApproval: jest.fn(),
    });
    const permission = tools.find(({ name }) => name === 'request_permissions');
    expect(permission.description).toMatch(/(Resolve|resolve)/);
    expect(permission.promptGuidelines.join(' ')).toContain('does not establish that software is absent');
    expect(permission.parameters.properties.reason.description).toContain('version and source');
    const failure = safeWorkspaceError(new Error('hidden infrastructure path /private/example'), {
      operation: 'bash', receipt: { state: 'failed', exitCode: 127 },
    });
    expect(failure.message).toContain('before retrying or switching to another download/install method');
    expect(failure.message).toContain('exact failed command');
    expect(failure.message).toContain('same workingDirectory');
    expect(failure.message).not.toContain('/private/example');
  });

  test('permission results distinguish installed access, missing names, and unsupported entry points', async () => {
    const controller = createController();
    const prepared = await controller.prepareCommandPermissions();
    prepared.publicRequest.commands.push(
      { name: 'sh', status: 'available' },
      { name: 'missing', status: 'unavailable', resolution: 'not_found' },
      { name: 'alias', status: 'unavailable', resolution: 'unsupported_entry_point' },
      { name: 'legacy', status: 'unavailable' }
    );
    prepared.available = ['node', 'sh'];
    prepared.unavailable = ['missing', 'alias', 'legacy'];
    controller.prepareCommandPermissions.mockResolvedValue(prepared);
    const tools = await createWorkspaceTools({
      sdk: createSdk(), controller, conversationId: 'conversation_one',
      requestApproval: jest.fn(async () => 'approved'),
    });
    const result = await tools.find(({ name }) => name === 'request_permissions').execute('discovery', {
      executables: ['node', 'sh', 'missing', 'alias', 'legacy'],
      reason: 'Check installed project tools', command: 'node validate.js', workingDirectory: '.',
    });
    expect(result.details.commands).toEqual([
      { name: 'node', status: 'access_granted' },
      { name: 'sh', status: 'already_available' },
      { name: 'missing', status: 'not_found' },
      { name: 'alias', status: 'unsupported_entry_point' },
      { name: 'legacy', status: 'unavailable' },
    ]);
    expect(result.content[0].text).toContain('Installed; access granted for this exact command and directory: node.');
    expect(result.content[0].text).toContain('Not found in the supported installed command environment: missing.');
    expect(result.content[0].text).toContain('entry point cannot be exposed');
    expect(result.content[0].text).toContain('installation status is unknown: legacy.');
    expect(JSON.stringify(result)).not.toContain('/opt/toolchain');
    expect(controller.startProcess).not.toHaveBeenCalled();
    expect(controller.grantCommandPermissions).toHaveBeenCalledWith('conversation_one', prepared.prepared, 'once');
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
      terminationScope: 'unknown',
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


describe('reviewed workspace history tool', () => {
  test.each(['approved', 'declined', 'cancelled', 'already_available'])('project write permission: %s', async (decision) => {
    const controller = createController();
    const prepared = Object.freeze({});
    controller.prepareProjectWriteAccess = jest.fn(async () => ({ prepared,
      approvalRequired: decision !== 'already_available', publicRequest: { name: 'Cookbook', mode: 'write', scope: 'conversation' } }));
    controller.grantProjectWriteAccess = jest.fn(async () => {});
    const abort = new AbortController();
    const requestApproval = jest.fn(async () => {
      if (decision === 'cancelled') abort.abort();
      return decision === 'declined' ? 'declined' : 'approved';
    });
    const tools = await createWorkspaceTools({ controller, conversationId: 'conversation_one', sdk: createSdk(), requestApproval });
    const tool = tools.find(entry => entry.name === 'request_permissions');
    const result = tool.execute('access', { project: 'write', reason: 'Commit the reviewed cookbook changes' }, abort.signal);
    if (['approved', 'already_available'].includes(decision)) {
      expect((await result).content[0].text).toContain('Re-read affected files');
    } else {
      await expect(result).rejects.toMatchObject({ code: decision === 'declined' ? 'PROJECT_WRITE_DECLINED' : 'WORKSPACE_OPERATION_CANCELLED', recovery: { action: 'stop' } });
    }
    expect(controller.grantProjectWriteAccess).toHaveBeenCalledTimes(decision === 'approved' ? 1 : 0);
    if (decision !== 'already_available') expect(requestApproval).toHaveBeenCalledWith({ action: 'project_write', operation: 'request_permissions',
      label: 'Commit the reviewed cookbook changes', projectAccess: { name: 'Cookbook', mode: 'write', scope: 'conversation' } });
    else expect(requestApproval).not.toHaveBeenCalled();
    expect(controller.prepareCommandPermissions).not.toHaveBeenCalled();
    expect(controller.grantCommandPermissions).not.toHaveBeenCalled();
  });

  test('rejects mixing project access with command permissions before approval', async () => {
    const controller = createController();
    const requestApproval = jest.fn();
    const tools = await createWorkspaceTools({ controller, conversationId: 'conversation_one', sdk: createSdk(), requestApproval });
    await expect(tools.find(entry => entry.name === 'request_permissions').execute('mixed', { project: 'write', reason: 'Edit', command: 'run something' }))
      .rejects.toMatchObject({ code: 'INVALID_WORKSPACE_REQUEST', recovery: { action: 'correct_input' } });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(controller.prepareCommandPermissions).not.toHaveBeenCalled();
  });

  test('reports the real read-only access refusal to the model and activity', async () => {
    const access = new ExternalProjectAccess({ userDataDir: '/unused-profile' });
    const workspaceId = 'workspace_aaaaaaaaaaaaaaaaaaaa';
    access.grant(workspaceId, { root: '/unused-project', dev: '1', ino: '2' }, 'read');
    const controller = createController();
    controller.reviewWorkspaceHistory = jest.fn(() => access.resolve(workspaceId, { write: true }));
    const outcome = jest.fn();
    const tools = await createWorkspaceTools({ controller, conversationId: 'conversation_one', sdk: createSdk(), requestApproval: jest.fn(), onToolOutcome: outcome });
    const tool = tools.find(entry => entry.name === 'workspace_history');
    await expect(tool.execute('commit_read_only', { action: 'commit', reviewIds: ['review_one'], label: 'Update cookbook' })).rejects.toMatchObject({
      code: 'PROJECT_READ_ONLY', message: expect.stringContaining('request_permissions'),
    });
    expect(outcome).toHaveBeenLastCalledWith(expect.objectContaining({
      errorCode: 'PROJECT_READ_ONLY', status: 'failed', workspace: expect.objectContaining({ state: 'failed' }),
    }));
    expect(access.grants.get(workspaceId).mode).toBe('read');
    expect(controller.reviewWorkspaceHistory).toHaveBeenCalledTimes(1);
  });

  test.each(['PROJECT_RECONNECT_REQUIRED', 'PROJECT_CHANGED'])('preserves %s during history operations without leaking host paths', async (code) => {
    const controller = createController();
    controller.reviewWorkspaceHistory = jest.fn().mockRejectedValue(Object.assign(new Error('/private/project sensitive'), { code }));
    const outcome = jest.fn();
    const tools = await createWorkspaceTools({ controller, conversationId: 'conversation_one', sdk: createSdk(), requestApproval: jest.fn(), onToolOutcome: outcome });
    const tool = tools.find(entry => entry.name === 'workspace_history');
    await expect(tool.execute('history_access', { action: 'status' })).rejects.toMatchObject({ code, message: expect.stringContaining('Reconnect') });
    expect(outcome).toHaveBeenLastCalledWith(expect.objectContaining({ errorCode: code }));
    expect(JSON.stringify(outcome.mock.calls)).not.toMatch(/private|sensitive/);
  });

  test('retains uncertain commit recovery instructions even when cancelled', async () => {
    const stopped = new AbortController();
    const controller = createController();
    const message = `The outcome of commit ${'c'.repeat(40)} is uncertain. Inspect Git history and the retained recovery record before retrying.`;
    controller.reviewWorkspaceHistory = jest.fn(async () => { stopped.abort(); throw new WorkspaceHistoryError(message); });
    const tools = await createWorkspaceTools({ controller, conversationId: 'conversation_one', sdk: createSdk(), requestApproval: jest.fn() });
    await expect(tools.find(entry => entry.name === 'workspace_history').execute('uncertain_commit', { action: 'commit' }, stopped.signal))
      .rejects.toMatchObject({ code: 'WORKSPACE_HISTORY_UNAVAILABLE', message: expect.stringContaining(message) });
  });

  test.each([true, false])('records the actual checkpoint result (saved=%s)', async (saved) => {
    const controller = createController();
    controller.getWorkspace.mockReturnValue({ enabled: true, workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa' });
    controller.reviewWorkspaceHistory = jest.fn(async () => ({ saved, id: 'b'.repeat(40), label: 'Private label' }));
    const outcome = jest.fn();
    const tools = await createWorkspaceTools({ controller, conversationId: 'conversation_one', sdk: createSdk(), requestApproval: jest.fn(), onToolOutcome: outcome });
    await tools.find(entry => entry.name === 'workspace_history').execute('save', { action: 'checkpoint', reviewIds: ['review_' + 'a'.repeat(32)] });
    expect(outcome.mock.calls[0][0].workspace.history).toEqual({ action: 'checkpoint', source: 'repository', saved, checkpointId: 'b'.repeat(40) });
    expect(JSON.stringify(outcome.mock.calls)).not.toContain('Private label');
  });

  test('binds history to its conversation and never exposes restore or arbitrary Git commands', async () => {
    const controller = createController();
    controller.getWorkspace.mockReturnValue({ enabled: true, workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa' });
    controller.reviewWorkspaceHistory = jest.fn(async () => ({ reviewId: 'review_' + 'a'.repeat(32), text: 'reviewed source' }));
    const outcome = jest.fn();
    const tools = await createWorkspaceTools({ controller, conversationId: 'conversation_one', sdk: createSdk(), requestApproval: jest.fn(), onToolOutcome: outcome });
    const tool = tools.find((entry) => entry.name === 'workspace_history');
    expect(tool.parameters.properties.action.enum).not.toContain('restore');
    const result = await tool.execute('call_one', { action: 'review', path: 'game.js' }, new AbortController().signal);
    expect(controller.reviewWorkspaceHistory).toHaveBeenCalledWith('conversation_one', { action: 'review', path: 'game.js' }, expect.objectContaining({ signal: expect.anything() }));
    expect(result.content[0].text).toContain('reviewed source');
    expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ workspace: expect.objectContaining({ kind: 'history', networkPosture: 'none' }) }));
    controller.reviewWorkspaceHistory.mockRejectedValueOnce(new Error('/private/host/secret'));
    await expect(tool.execute('call_two', { action: 'status' })).rejects.toThrow('unavailable or stopped');
    expect(outcome).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: expect.objectContaining({
      state: 'failed', history: { action: 'status', source: 'repository' },
    }) }));
    const stopped = new AbortController(); stopped.abort();
    const calls = controller.reviewWorkspaceHistory.mock.calls.length;
    await expect(tool.execute('call_three', { action: 'checkpoint', reviewIds: [] }, stopped.signal)).rejects.toThrow('stopped');
    expect(controller.reviewWorkspaceHistory).toHaveBeenCalledTimes(calls);
    expect(outcome).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: expect.objectContaining({
      state: 'cancelled', history: { action: 'checkpoint', source: 'repository' },
    }) }));
  });

  test('restarts an exact saved command through bash and reattaches in a separate observed action', async () => {
    const controller = createController();
    controller.fullNetworkPermissionsEnabled.mockReturnValue(true);
    const serverId = `workspace_server_${'a'.repeat(24)}`;
    const processId = `workspace_process_${'b'.repeat(24)}`;
    const server = { serverId, command: 'npm run dev', workingDirectory: 'game', port: 5173, state: 'stopped' };
    controller.listServers = () => [{ serverId, command: server.command, workingDirectory: 'game', previewPort: 5173, state: server.state }];
    controller.getServer = (_owner, id) => { if (id !== serverId) throw new Error('Unavailable'); return { ...server }; };
    controller.startProcess.mockImplementation(async () => {
      server.processId = processId; server.state = 'running';
      return { state: 'running', processId, serverId, output: '', workspace: {
        state: 'running', processId, command: server.command, networkPosture: 'full', previewPort: 5173,
      } };
    });
    const previewController = { createPreview: jest.fn(), createProcessPreview: jest.fn(() => ({
      kind: 'server', url: `freedom-preview://${'a'.repeat(40)}/`, processId, port: 5173,
    })) };
    const scopedController = { openWorkspacePreview: jest.fn(async () => ({ ok: true, result: { activeTabId: 'tab_server' } })) };
    const outcome = jest.fn();
    const tools = await createWorkspaceTools({ sdk: createSdk(), controller, previewController, scopedController,
      conversationId: 'one', requestApproval: jest.fn(async () => 'approved'), onToolOutcome: outcome });
    const tool = tools.find(entry => entry.name === 'workspace_server');
    expect((await tool.execute('list', { action: 'list' })).details.servers[0].command).toBe('npm run dev');
    expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'list', operation: 'workspace_server',
      status: 'succeeded', workspace: expect.objectContaining({ state: 'completed', sideEffects: 'none' }) }));
    await expect(tool.execute('attach', { action: 'reattach', serverId })).rejects.toThrow('stopped');
    expect(outcome.mock.calls.filter(([event]) => event.toolCallId === 'attach')).toEqual([
      [expect.objectContaining({ operation: 'workspace_server', status: 'failed' })],
    ]);
    const abort = new AbortController(); abort.abort();
    await expect(tool.execute('aborted', { action: 'list' }, abort.signal)).rejects.toThrow('stopped');
    expect(outcome.mock.calls.filter(([event]) => event.toolCallId === 'aborted')).toHaveLength(1);
    await tool.execute('restart', { action: 'restart', serverId });
    expect(controller.startProcess).toHaveBeenCalledWith('one', expect.objectContaining({
      restartServerId: serverId, command: 'npm run dev', workingDirectory: 'game', previewPort: 5173,
    }));
    expect(scopedController.openWorkspacePreview).not.toHaveBeenCalled();
    expect(outcome.mock.calls.filter(([event]) => event.toolCallId === 'restart')).toHaveLength(1);
    await tool.execute('attach', { action: 'reattach', serverId });
    expect(previewController.createProcessPreview).toHaveBeenCalledWith('one', processId);
    expect(scopedController.openWorkspacePreview).toHaveBeenCalledTimes(1);
  });
});


describe('structured workspace failure recovery', () => {
  test('a read-only shell refusal directs the model to read tools or an editing request', async () => {
    const controller = createController();
    controller.startProcess.mockRejectedValueOnce(Object.assign(new Error('/private/project'), { code: 'PROJECT_READ_ONLY' }));
    const tools = await createWorkspaceTools({ sdk: createSdk(), controller, conversationId: 'test', requestApproval: jest.fn() });
    await expect(tools.find(tool => tool.name === 'bash').execute('id', { command: 'git diff HEAD -- README.md' }))
      .rejects.toMatchObject({ code: 'PROJECT_READ_ONLY', recovery: { tool: 'request_permissions' },
        message: expect.stringContaining('workspace_history (status/diff/review)') });
  });

  test.each([
    ['failed', 127, 'WORKSPACE_COMMAND_NOT_FOUND', 'request_permission'],
    ['failed', 1, 'WORKSPACE_COMMAND_FAILED', 'inspect_outcome'],
    ['timed_out', null, 'WORKSPACE_COMMAND_TIMED_OUT', 'inspect_outcome'],
    ['cancelled', null, 'WORKSPACE_COMMAND_CANCELLED', 'stop'],
    ['sandbox_denied', null, 'WORKSPACE_SANDBOX_DENIED', 'stop'],
  ])('process polling propagates %s/%s with guidance and bounded output', async (state, exitCode, code, action) => {
    const controller = createController();
    controller.interactProcess = jest.fn(async () => ({ state, output: 'diagnostic output',
      workspace: { state, exitCode, kind: 'command', command: 'test', workingDirectory: '.' } }));
    const onToolOutcome = jest.fn();
    const tools = await createWorkspaceTools({ sdk: createSdk(), controller, conversationId: 'test', requestApproval: jest.fn(), onToolOutcome });
    await expect(tools.find(tool => tool.name === 'write_stdin').execute('id', { session_id: 'workspace_process_' + 'a'.repeat(24) }))
      .rejects.toMatchObject({ code, recovery: { action } });
    expect(onToolOutcome).toHaveBeenCalledTimes(1);
    expect(onToolOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: code }));
    expect(JSON.stringify(onToolOutcome.mock.calls)).not.toContain('diagnostic output');
  });

  test('preserves a structured refusal carried by a terminal receipt', () => {
    expect(safeWorkspaceError(new Error('SDK failure'), { operation: 'bash',
      receipt: { state: 'failed', exitCode: null, error: { code: 'PROJECT_READ_ONLY' } } }))
      .toMatchObject({ code: 'PROJECT_READ_ONLY' });
  });
});


test('installed Pi preserves project recovery through its real bash and edit adapters', () => {
  const { execFileSync } = require('child_process');
  const script = `
    (async () => {
      const assert = require('node:assert/strict');
      const { loadPiSdk } = require('./src/main/agent/pi-sdk');
      const { createWorkspaceTools } = require('./src/main/agent/pi-workspace-tools');
      const failure = code => { throw Object.assign(new Error('/private/project'), { code }); };
      const controller = Object.fromEntries([
        'execute', 'accessFile', 'readFile', 'createDirectory', 'writeFile', 'listDirectory',
        'findFiles', 'grepFiles', 'prepareCommandPermissions', 'grantCommandPermissions', 'startProcess', 'interactProcess',
      ].map(name => [name, async () => failure('PROJECT_READ_ONLY')]));
      controller.getWorkspace = () => ({ enabled: true });
      controller.accessFile = async () => failure('PROJECT_RECONNECT_REQUIRED');
      const tools = await createWorkspaceTools({ sdk: await loadPiSdk(), controller, conversationId: 'test',
        requestApproval: async () => { throw new Error('Must not request permission automatically'); } });
      await assert.rejects(tools.find(t => t.name === 'bash').execute('id', { command: 'git diff HEAD -- README.md' }), error => {
        assert.equal(error.code, 'PROJECT_READ_ONLY');
        assert.equal(error.recovery.tool, 'request_permissions');
        assert.ok(error.message.includes('workspace_history (status/diff/review)'));
        assert.ok(!error.message.includes('/private'));
        return true;
      });
      await assert.rejects(tools.find(t => t.name === 'edit').execute('id', { path: 'README.md', edits: [{ oldText: 'a', newText: 'b' }] }), error => {
        assert.equal(error.code, 'PROJECT_RECONNECT_REQUIRED');
        assert.equal(error.recovery.action, 'ask_user');
        assert.ok(!error.message.includes('/private'));
        return true;
      });
      process.stdout.write('passed');
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  expect(execFileSync(process.execPath, ['-e', script], {
    cwd: require('path').resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 15000,
  })).toBe('passed');
});
