'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const {
  DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT,
  VIRTUAL_AGENT_CWD,
  createIsolatedPiSession,
  createNoDiscoveryResourceLoader,
  hydrateVisibleTranscript,
  validateCustomTools,
} = require('./pi-session-factory');

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
    createExtensionRuntime: jest.fn(() => extensionRuntime),
    createReadTool: jest.fn(() => ({ name: 'read', execute: jest.fn() })),
    defineTool: jest.fn(),
    ModelRuntime: jest.fn(),
    SessionManager,
    SettingsManager,
  };
}

describe('isolated Pi session factory', () => {
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
      retry: { enabled: true, maxRetries: 2 },
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
        customTools: [browserTool],
        resourceLoader: created.resourceLoader,
        sessionManager: created.sessionManager,
        settingsManager: created.settingsManager,
      })
    );
    expect(created.toolNames).toEqual(['browser_snapshot']);
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
      skills: [expect.objectContaining({ name: 'swarm-postage' })],
      diagnostics: [],
    });
    expect(sdk.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['node_request', 'read'],
        customTools: [browserTool, expect.objectContaining({ name: 'read' })],
      })
    );
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
          prompt: created.session.agent.state.systemPrompt,
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
      skills: 1,
      contextFiles: 0,
    });
    expect(result.prompt).toContain('swarm-postage');
    expect(result.prompt).toContain('/freedom-agent/skills/swarm-postage/SKILL.md');
    expect(result.prompt).toContain(DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT);
  });
});
