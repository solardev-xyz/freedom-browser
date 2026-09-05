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
      required: ['reason', 'command', 'workingDirectory'],
      anyOf: [{ required: ['executables'] }, { required: ['network'] }],
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
    const stopped = new AbortController(); stopped.abort();
    const calls = controller.reviewWorkspaceHistory.mock.calls.length;
    await expect(tool.execute('call_three', { action: 'checkpoint', reviewIds: [] }, stopped.signal)).rejects.toThrow('stopped');
    expect(controller.reviewWorkspaceHistory).toHaveBeenCalledTimes(calls);
  });
});
