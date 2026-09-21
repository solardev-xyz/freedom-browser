'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const {
  DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT,
  VIRTUAL_AGENT_CWD,
  createDiagnosticModelRuntime,
  currentTimeContext,
  createIsolatedPiSession,
  createNoDiscoveryResourceLoader,
  createProviderDiagnosticFetch,
  hydrateVisibleTranscript,
  validateCustomTools,
} = require('./pi-session-factory');
const { trustBuiltInToolOverride } = require('./pi-trusted-tools');

const repositoryRoot = path.resolve(__dirname, '../../..');

function createSdk() {
  const extensionRuntime = {};
  const sessionManager = { kind: 'session-manager', appendMessage: jest.fn() };
  const settingsManager = { kind: 'settings-manager' };
  const SessionManager = jest.fn();
  const SettingsManager = jest.fn();
  SessionManager.inMemory = jest.fn(() => sessionManager);
  SettingsManager.inMemory = jest.fn(() => settingsManager);
  return {
    createAgentSession: jest.fn().mockResolvedValue({
      session: { dispose: jest.fn() },
      extensionsResult: { extensions: [], errors: [], runtime: extensionRuntime },
    }),
    createBashTool: jest.fn(),
    createEditTool: jest.fn(),
    createExtensionRuntime: jest.fn(() => extensionRuntime),
    createFindTool: jest.fn(),
    createGrepTool: jest.fn(),
    createLsTool: jest.fn(),
    createReadTool: jest.fn(() => ({ name: 'read', execute: jest.fn() })),
    createWriteTool: jest.fn(),
    defineTool: jest.fn(),
    ModelRuntime: jest.fn(),
    SessionManager,
    SettingsManager,
  };
}

describe('isolated Pi session factory', () => {
  test('traces each model request and headers without consuming the stream or logging content', async () => {
    const events = [];
    const response = { status: 200, body: 'private-response' };
    const fetchImpl = jest.fn(async () => response);
    const stream = { privateState: 'private-stream', [Symbol.asyncIterator]: jest.fn() };
    let requestOptions;
    const modelRuntime = {
      streamSimple: jest.fn((_model, _context, options) => {
        requestOptions = options;
        return stream;
      }),
    };
    const runtime = createDiagnosticModelRuntime(modelRuntime, () => (event) => events.push(event));
    expect(runtime.streamSimple({ id: 'private-model' }, { text: 'private-prompt' }, {
      fetch: fetchImpl,
    })).toBe(stream);
    expect(await requestOptions.fetch('https://private-host', {
      headers: { Authorization: 'private-token' }, body: 'private-body',
    })).toBe(response);
    expect(events.map((event) => event.phase)).toEqual([
      'model_request_started', 'fetch_started', 'response_headers_received',
    ]);
    expect(events.every((event) => event.requestSequenceId === 1)).toBe(true);
    expect(events.at(-1).status).toBe(200);
    expect(JSON.stringify(events)).not.toContain('private-');
    expect(stream[Symbol.asyncIterator]).not.toHaveBeenCalled();
    runtime.streamSimple({}, {}, { fetch: fetchImpl });
    expect(events.at(-1).requestSequenceId).toBe(2);
  });

  test('diagnostic failures cannot prevent requests or alter their errors', async () => {
    const failure = new Error('request failed');
    const modelRuntime = {
      streamSimple: (_model, _context, options) => options.fetch('https://private-host'),
    };
    const runtime = createDiagnosticModelRuntime(modelRuntime, () => () => {
      throw new Error('logger failed');
    });
    const fetchImpl = jest.fn().mockRejectedValue(failure);
    await expect(runtime.streamSimple({}, {}, { fetch: fetchImpl })).rejects.toBe(failure);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('preserves sanitized nested fetch causes before Pi flattens provider errors', async () => {
    const cause = Object.assign(
      new Error('Connect Timeout Error Authorization: Bearer private-provider-token'),
      { code: 'UND_ERR_CONNECT_TIMEOUT' }
    );
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed', { cause }));
    const diagnosticFetch = createProviderDiagnosticFetch(fetchImpl);

    await expect(diagnosticFetch('https://provider.test')).rejects.toMatchObject({
      name: 'TypeError',
      message: expect.stringContaining('UND_ERR_CONNECT_TIMEOUT'),
    });
    await diagnosticFetch('https://provider.test').catch((error) => {
      expect(error.message).toContain('fetch failed');
      expect(error.message).toContain('Authorization: [redacted]');
      expect(error.message).not.toContain('private-provider-token');
      expect(error.cause).toBeInstanceOf(TypeError);
    });
  });

  test('injects diagnostic fetch into model streaming without changing other runtime methods', () => {
    const fetchImpl = jest.fn();
    const modelRuntime = {
      kind: 'model-runtime',
      streamSimple: jest.fn((_model, _context, options) => options),
      getModels() {
        return this.kind;
      },
    };
    const runtime = createDiagnosticModelRuntime(modelRuntime);
    const options = runtime.streamSimple({}, {}, { fetch: fetchImpl, signal: 'signal' });

    expect(options).toMatchObject({ signal: 'signal', fetch: expect.any(Function) });
    expect(options.fetch).not.toBe(fetchImpl);
    expect(runtime.getModels()).toBe('model-runtime');
  });

  test('provides no discovered resources or appended instructions', async () => {
    const sdk = createSdk();
    const loader = createNoDiscoveryResourceLoader(sdk, 'Freedom prompt');

    await expect(loader.reload()).resolves.toBeUndefined();
    expect(loader.getExtensions()).toEqual({ extensions: [], errors: [], runtime: {} });
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getSystemPrompt()).toBe('Freedom prompt');
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
  });

  test('enables only explicit custom tools with in-memory state', async () => {
    const sdk = createSdk();
    const model = { id: 'test-model', provider: 'test' };
    const modelRuntime = { kind: 'model-runtime' };
    const browserTool = { name: 'browser_snapshot', execute: jest.fn() };

    const created = await createIsolatedPiSession({
      sdk,
      model,
      modelRuntime,
      customTools: [browserTool],
    });

    expect(sdk.SessionManager.inMemory).toHaveBeenCalledWith(VIRTUAL_AGENT_CWD);
    expect(sdk.SettingsManager.inMemory).toHaveBeenCalledWith({
      compaction: { enabled: true },
      cacheWarming: 'off',
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 2_000,
        provider: { maxRetries: 0 },
      },
    });
    expect(sdk.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: VIRTUAL_AGENT_CWD,
        agentDir: VIRTUAL_AGENT_CWD,
        model,
        thinkingLevel: 'off',
        modelRuntime,
        noTools: 'builtin',
        tools: ['browser_snapshot'],
        customTools: [expect.objectContaining({ name: browserTool.name, execute: expect.any(Function) })],
        resourceLoader: created.resourceLoader,
        sessionManager: created.sessionManager,
        settingsManager: created.settingsManager,
      })
    );
    expect(created.toolNames).toEqual(['browser_snapshot']);
  });

  test('supplies configured identity even with a custom system prompt, without connection secrets', async () => {
    const created = await createIsolatedPiSession({
      sdk: createSdk(),
      model: { id: 'qwen3:8b', provider: 'ollama', baseUrl: 'http://private-host', apiKey: 'secret' },
      modelRuntime: {},
      systemPrompt: 'App task instructions',
    });
    const prompt = created.resourceLoader.getSystemPrompt();
    expect(prompt).toContain('App task instructions');
    expect(prompt).toContain('{"modelId":"qwen3:8b","providerId":"ollama"}');
    expect(prompt).toContain('served through Ollama');
    expect(prompt).not.toContain('private-host');
    expect(prompt).not.toContain('secret');
  });

  test('adds native Pi skill discovery and a virtual read tool only when enabled', async () => {
    const sdk = createSdk();
    const browserTool = { name: 'node_request', execute: jest.fn() };

    const created = await createIsolatedPiSession({
      sdk,
      model: { id: 'test-model', provider: 'test' },
      modelRuntime: {},
      customTools: [browserTool],
      enableBuiltInSkills: true,
    });

    expect(created.toolNames).toEqual(['node_request', 'read']);
    expect(created.resourceLoader.getSkills()).toEqual({
      skills: [
        expect.objectContaining({ name: 'workspace-history' }),
        expect.objectContaining({ name: 'swarm-postage' }),
        expect.objectContaining({ name: 'swarm-publishing' }),
      ],
      diagnostics: [],
    });
    expect(sdk.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['node_request', 'read'],
        customTools: [expect.objectContaining({ name: browserTool.name }), expect.objectContaining({ name: 'read' })],
      })
    );
  });

  test('uses a trusted standard read override for both workspace files and built-in skills', async () => {
    const sdk = createSdk();
    const readOverride = trustBuiltInToolOverride({ name: 'read', execute: jest.fn() });

    const created = await createIsolatedPiSession({
      sdk,
      model: { id: 'test-model', provider: 'test' },
      modelRuntime: {},
      customTools: [readOverride],
      enableBuiltInSkills: true,
    });

    expect(created.toolNames).toEqual(['read']);
    expect(sdk.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ customTools: [expect.objectContaining({ name: 'read' })], tools: ['read'] })
    );
    expect(sdk.createReadTool).not.toHaveBeenCalled();
    expect(created.resourceLoader.getSkills().skills).toHaveLength(3);
  });

  test('rejects built-in, unnamed, and duplicate tool names', () => {
    expect(() => validateCustomTools({})).toThrow('customTools must be an array');
    expect(() => validateCustomTools([{}])).toThrow('requires a name');
    expect(() => validateCustomTools([{ name: 'bash' }])).toThrow('built-in Pi tool name');
    expect(() => validateCustomTools([{ name: ' browser_wait' }])).toThrow(
      'cannot contain surrounding whitespace'
    );
    expect(() => validateCustomTools([{ name: 'browser_wait' }, { name: 'browser_wait' }])).toThrow(
      'Duplicate Pi custom tool name'
    );
  });

  test('restores only visible user and assistant text into Pi context', async () => {
    const sdk = createSdk();
    await createIsolatedPiSession({
      sdk,
      model: { id: 'gpt-test', provider: 'openai', api: 'responses' },
      modelRuntime: {},
      restoredTranscript: [
        {
          userText: 'Compare the pages',
          assistantText: 'The first page is newer.',
          startedAt: 1_000,
          durationMs: 250,
          guidance: [
            {
              text: 'Use primary sources only',
              createdAt: 1_100,
              status: 'applied',
            },
          ],
          activity: [
            {
              operation: 'browser_snapshot',
              arguments: { rawPageContents: 'must not be restored' },
            },
          ],
        },
        {
          userText: 'Retry the request that never reached the provider',
          assistantText: 'An incomplete provider response',
          status: 'failed',
          startedAt: 2_000,
          guidance: [],
          activity: [],
        },
      ],
    });

    expect(sdk.SessionManager.inMemory().appendMessage.mock.calls).toEqual([
      [{ role: 'user', content: 'Compare the pages', timestamp: 1_000 }],
      [{ role: 'user', content: 'Use primary sources only', timestamp: 1_100 }],
      [
        expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: 'The first page is newer.' }],
          api: 'responses',
          provider: 'openai',
          model: 'gpt-test',
          stopReason: 'stop',
          timestamp: 1_250,
        }),
      ],
    ]);
    expect(JSON.stringify(sdk.SessionManager.inMemory().appendMessage.mock.calls)).not.toContain(
      'rawPageContents'
    );
    expect(JSON.stringify(sdk.SessionManager.inMemory().appendMessage.mock.calls)).not.toContain(
      'never reached the provider'
    );
    expect(JSON.stringify(sdk.SessionManager.inMemory().appendMessage.mock.calls)).not.toContain(
      'incomplete provider response'
    );
  });

  test('rejects transcript restoration without an appendable session manager', () => {
    expect(() => hydrateVisibleTranscript({}, [{ userText: 'Task' }], {})).toThrow(
      'requires a session manager'
    );
  });

  test('uses a fixed browser-only prompt and a non-user-specific cwd', () => {
    expect(DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT).toContain('Freedom Agent');
    expect(DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT).toContain('untrusted data');
    expect(VIRTUAL_AGENT_CWD).toMatch(/freedom-agent$/);
    expect(VIRTUAL_AGENT_CWD).not.toContain(repositoryRoot);
  });

  test('real Pi tool loop preserves instructions, clock, recovery text and JSON results', () => {
    const script = `
      (async () => {
        const assert = require('node:assert/strict');
        const { loadPiSdk } = require('./src/main/agent/pi-sdk');
        const { createIsolatedPiSession } = require('./src/main/agent/pi-session-factory');
        const sdk = await loadPiSdk();
        const runtime = await sdk.ModelRuntime.create({
          credentials: { read: async () => undefined, list: async () => [] },
          modelsPath: null, modelsStorePath: null, refreshOnCreate: false,
          allowModelNetwork: false,
        });
        runtime.registerProvider('freedom-test', {
          baseUrl: 'https://provider.invalid/v1', api: 'openai-completions',
          models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'],
            contextWindow: 128000, maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: { supportsDeveloperRole: false } }],
        });
        await runtime.setRuntimeApiKey('freedom-test', 'test-not-a-credential');
        const requests = [];
        globalThis.fetch = async (_url, init) => {
          requests.push(JSON.parse(init.body));
          const index = requests.length;
          const delta = index < 4 ? { tool_calls: [{ index: 0, id: 'probe-' + index,
            type: 'function', function: { name: 'probe', arguments: '{"value":"test"}' } }] }
            : { content: 'Done' };
          const chunk = { id: 'response-' + index, object: 'chat.completion.chunk',
            created: 1, model: 'test', choices: [{ index: 0, delta,
              finish_reason: index < 4 ? 'tool_calls' : 'stop' }] };
          return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        };
        const { createFreedomBrowserTools } = require('./src/main/agent/pi-browser-tools');
        const { createWorkspaceTools } = require('./src/main/agent/pi-workspace-tools');
        const { createConversationAttachmentTools } = require('./src/main/agent/pi-attachment-tools');
        const unexpected = () => { throw new Error('Unexpected real tool execution'); };
        const controller = Object.fromEntries([
          'execute', 'accessFile', 'readFile', 'createDirectory', 'writeFile', 'listDirectory',
          'findFiles', 'grepFiles', 'prepareCommandPermissions', 'grantCommandPermissions',
          'startProcess', 'interactProcess', 'reviewWorkspaceHistory',
        ].map(name => [name, unexpected]));
        const productionTools = [
          ...await createFreedomBrowserTools({ sdk, controller, tabId: 'test-tab' }),
          ...await createWorkspaceTools({ sdk, controller, conversationId: 'test', requestApproval: unexpected }),
          ...await createConversationAttachmentTools({ sdk, conversationId: 'test',
            store: { listResources: unexpected, read: unexpected, renderPdfPage: unexpected } }),
        ];
        let now = Date.parse('2026-09-19T12:00:00Z');
        let executions = 0;
        const created = await createIsolatedPiSession({ sdk, modelRuntime: runtime,
          model: runtime.getModel('freedom-test', 'test'), now: () => now,
          systemPrompt: 'Preserve Freedom instructions.',
          customTools: [...productionTools, { name: 'probe', label: 'Probe', description: 'A test-only probe.',
            parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            execute: async (_id, args) => {
              assert.equal(args.value, 'test');
              executions++;
              now = Date.parse('2026-09-20T12:00:00Z');
              if (executions === 1) throw Object.assign(new Error('Stale reference'), { code: 'STALE_ELEMENT_REFERENCE' });
              if (executions === 2) return { isError: true, content: [{ type: 'text', text: 'Unconfirmed result' }], details: { evidence: 'retained' } };
              return { content: [{ type: 'text', text: 'Checked' }], details: { checked: true, items: ['test'] } };
            } }],
        });
        try {
          await created.session.prompt('Run the probe');
          assert.equal(requests.length, 4);
          assert.equal(executions, 3);
          for (const [index, request] of requests.entries()) {
            const instructions = request.messages.filter(m => m.role === 'system').map(m => m.content).join(' ');
            assert.ok(instructions.includes('Preserve Freedom instructions.'));
            assert.ok(instructions.includes('Configured model runtime'));
            assert.equal(instructions.split('Current time from Freedom').length - 1, 1);
            assert.ok(instructions.includes(index === 0 ? '2026-09-19T12:00:00.000Z' : '2026-09-20T12:00:00.000Z'));
            const names = request.tools.map(tool => tool.function.name);
            for (const name of ['probe', 'browser_call_page_tool', 'request_permissions', 'workspace_history', 'read', 'write', 'bash', 'attachment_list']) {
              assert.ok(names.includes(name), name + ' must remain registered');
            }
          }
          const error = requests[1].messages.find(m => m.role === 'tool');
          assert.ok(error.content.includes('STALE_ELEMENT_REFERENCE'));
          assert.ok(error.content.includes('Recovery:'));
          const results = created.session.agent.state.messages.filter(m => m.role === 'toolResult');
          assert.equal(results[0].isError, true);
          assert.equal(results[1].isError, true);
          assert.deepEqual(results[1].details, { evidence: 'retained' });
          assert.ok(results[1].content.at(-1).text.includes('Recovery:'));
          assert.deepEqual(results[2].details, { checked: true, items: ['test'] });
          assert.equal(created.settingsManager.getCacheWarmingMode(), 'off');
          assert.ok(!JSON.stringify(created.session.agent.state.messages).includes('Current time from Freedom'));
          process.stdout.write('passed');
        } finally { created.session.dispose(); }
      })().catch(error => { console.error(error); process.exit(1); });
    `;
    expect(execFileSync(process.execPath, ['-e', script], {
      cwd: repositoryRoot, encoding: 'utf8', timeout: 15000,
    })).toBe('passed');
  });

  test('creates a real Pi session with restored visible context and no hidden persistence', () => {
    const script = `
      (async () => {
        const crypto = require('crypto');
        const os = require('os');
        const path = require('path');
        const { loadPiSdk } = require('./src/main/agent/pi-sdk');
        const { createIsolatedPiSession } = require('./src/main/agent/pi-session-factory');
        const sdk = await loadPiSdk();
        const suffix = crypto.randomUUID();
        const modelRuntime = await sdk.ModelRuntime.create({
          authPath: path.join(os.tmpdir(), 'freedom-pi-auth-' + suffix + '.json'),
          modelsPath: null,
          modelsStorePath: path.join(os.tmpdir(), 'freedom-pi-models-' + suffix + '.json'),
          refreshOnCreate: false,
        });
        const model = modelRuntime.getModels('anthropic')[0];
        const created = await createIsolatedPiSession({
          sdk,
          model,
          modelRuntime,
          enableBuiltInSkills: true,
          restoredTranscript: [{
            userText: 'Find the release date',
            assistantText: 'The visible page said August 25.',
            startedAt: 1000,
            durationMs: 250,
            activity: [{ operation: 'browser_snapshot', secret: 'must-not-survive' }],
          }],
        });
        const result = {
          tools: created.session.agent.state.tools.map((tool) => tool.name),
          prompt: created.session.systemPrompt,
          messages: created.session.agent.state.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          extensions: created.extensionsResult.extensions.length,
          sessionFile: created.session.sessionFile || null,
          skills: created.resourceLoader.getSkills().skills.length,
          contextFiles: created.resourceLoader.getAgentsFiles().agentsFiles.length,
        };
        created.session.dispose();
        process.stdout.write(JSON.stringify(result));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    const result = JSON.parse(
      execFileSync(process.execPath, ['-e', script], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
    );

    expect(result).toEqual({
      tools: ['read'],
      prompt: expect.stringContaining('<available_skills>'),
      messages: [
        { role: 'user', content: 'Find the release date' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'The visible page said August 25.' }],
        },
      ],
      extensions: 0,
      sessionFile: null,
      skills: 3,
      contextFiles: 0,
    });
    expect(result.prompt).toContain('swarm-postage');
    expect(result.prompt).toContain('/freedom-agent/skills/swarm-postage/SKILL.md');
    expect(result.prompt).toContain(DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT);
  });
});


describe('live device clock context', () => {
  test('uses the local calendar date rather than UTC across midnight', () => {
    const context = currentTimeContext(Date.parse('2026-09-19T22:30:00Z'), 'Europe/Berlin');
    expect(context).toContain('"localDate":"2026-09-20"');
    expect(context).toContain('"weekday":"Sunday"');
    expect(context).toContain('"localTime":"00:30:00"');
    expect(context).toContain('"timeZone":"Europe/Berlin"');
    expect(context).toContain('"utcOffset":"UTC+02:00"');
    expect(context).toContain('2026-09-19T22:30:00.000Z');
  });

  test.each([
    ['2026-10-25T00:30:00Z', 'Europe/Berlin', '02:30:00', 'UTC+02:00'],
    ['2026-10-25T01:30:00Z', 'Europe/Berlin', '02:30:00', 'UTC+01:00'],
    ['2026-09-19T20:00:00Z', 'Asia/Kathmandu', '01:45:00', 'UTC+05:45'],
    ['2026-09-19T02:00:00Z', 'America/Los_Angeles', '19:00:00', 'UTC-07:00'],
  ])('handles daylight saving and non-hour offsets: %s %s', (utc, zone, localTime, offset) => {
    const context = currentTimeContext(Date.parse(utc), zone);
    expect(context).toContain(`"localTime":"${localTime}"`);
    expect(context).toContain(`"utcOffset":"${offset}"`);
  });

  test('unavailable timezone explicitly falls back to UTC without claiming it is local time', () => {
    const context = currentTimeContext(Date.parse('2026-09-19T12:00:00Z'), 'invalid-zone');
    expect(context).toContain('2026-09-19T12:00:00.000Z');
    expect(context).toContain('device timezone is unavailable');
    expect(context).not.toContain('localDate');
  });

  test.each(['openai-completions', 'openai-responses', 'anthropic-messages'])(
    '%s serializes the request-only clock alongside system instructions and tools', (api) => {
      const script = `
        (async () => {
          const assert = require('node:assert/strict');
          const { loadPiSdk } = require('./src/main/agent/pi-sdk');
          const { createDiagnosticModelRuntime } = require('./src/main/agent/pi-session-factory');
          const sdk = await loadPiSdk();
          const runtime = await sdk.ModelRuntime.create({
            credentials: { read: async () => undefined, list: async () => [] },
            modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
          });
          runtime.registerProvider('freedom-test', {
            baseUrl: 'https://provider.invalid/v1', api: ${JSON.stringify(api)},
            models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'],
              contextWindow: 128000, maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          });
          await runtime.setRuntimeApiKey('freedom-test', 'test-not-a-credential');
          let body;
          const fetch = async (_url, init) => {
            body = JSON.parse(init.body);
            return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Test capture complete' } }),
              { status: 400, headers: { 'content-type': 'application/json' } });
          };
          const context = { messages: [
            { role: 'system', content: 'Original instructions', timestamp: 0,
              toolsAdded: [{ name: 'probe', description: 'Test', parameters: { type: 'object', properties: {} } }] },
            { role: 'user', content: 'Test', timestamp: 1 },
            { role: 'system', content: 'Later instructions', timestamp: 2 },
          ] };
          const wrapped = createDiagnosticModelRuntime(runtime, null, () => 'Fresh device clock');
          await wrapped.streamSimple(runtime.getModel('freedom-test', 'test'), context,
            { fetch, maxRetries: 0 }).result();
          assert.ok(body, 'the real provider adapter must reach the fake transport');
          for (const text of ['Original instructions', 'Later instructions', 'Fresh device clock', 'probe']) {
            assert.ok(JSON.stringify(body).includes(text), text + ' missing from serialized provider request');
          }
          assert.equal(context.messages.length, 3);
          process.stdout.write('passed');
        })().catch(error => { console.error(error); process.exit(1); });
      `;
      expect(execFileSync(process.execPath, ['-e', script], {
        cwd: repositoryRoot, encoding: 'utf8', timeout: 15000,
      })).toBe('passed');
    }
  );

  test('session wiring refreshes the outgoing system context on each request without rewriting history', async () => {
    const sdk = createSdk();
    const stream = { stream: true };
    const modelRuntime = { streamSimple: jest.fn(() => stream) };
    let now = Date.parse('2026-09-19T12:00:00Z');
    const model = { id: 'test', provider: 'ollama' };
    const created = await createIsolatedPiSession({ sdk, model, modelRuntime, now: () => now });
    const wrapped = sdk.createAgentSession.mock.calls[0][0].modelRuntime;
    const messages = Object.freeze([
      Object.freeze({ role: 'system', content: created.resourceLoader.getSystemPrompt(), timestamp: 0 }),
      Object.freeze({ role: 'user', content: 'What is today?', timestamp: 1 }),
      Object.freeze({ role: 'system', content: 'Updated instructions', toolsAdded: [{ name: 'example' }], timestamp: 2 }),
    ]);
    const context = Object.freeze({ messages });
    expect(wrapped.streamSimple(model, context, {})).toBe(stream);
    now = Date.parse('2026-09-20T12:00:00Z');
    expect(wrapped.streamSimple(model, context, {})).toBe(stream);
    const first = modelRuntime.streamSimple.mock.calls[0][1];
    const second = modelRuntime.streamSimple.mock.calls[1][1];
    expect(first.messages.at(-1).sections.freedom_current_time).toContain('2026-09-19T12:00:00.000Z');
    expect(second.messages.at(-1).sections.freedom_current_time).toContain('2026-09-20T12:00:00.000Z');
    expect(JSON.stringify(second)).not.toContain('2026-09-19T12:00:00.000Z');
    expect(JSON.stringify(second).match(/Current time from Freedom/g)).toHaveLength(1);
    expect(first.messages.slice(0, -1)).toEqual(messages);
    expect(second.messages.slice(0, -1)).toEqual(messages);
    expect(first.messages[2]).toBe(messages[2]);
    expect(context.messages).toBe(messages);
    expect(messages[0].content).toContain('Configured model runtime');
    expect(JSON.stringify(context)).not.toContain('Current time from Freedom');
  });
});
