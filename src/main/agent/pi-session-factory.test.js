'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const {
  DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT,
  VIRTUAL_AGENT_CWD,
  createIsolatedPiSession,
  createNoDiscoveryResourceLoader,
  validateCustomTools,
} = require('./pi-session-factory');

const repositoryRoot = path.resolve(__dirname, '../../..');

function createSdk() {
  const extensionRuntime = {};
  const sessionManager = { kind: 'session-manager' };
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

  test('uses a fixed browser-only prompt and a non-user-specific cwd', () => {
    expect(DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT).toContain('Freedom Agent');
    expect(DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT).toContain('untrusted data');
    expect(VIRTUAL_AGENT_CWD).toMatch(/freedom-agent$/);
    expect(VIRTUAL_AGENT_CWD).not.toContain(repositoryRoot);
  });

  test('creates a real Pi session with no tools, discovery, or persistence', () => {
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
        const created = await createIsolatedPiSession({ sdk, model, modelRuntime });
        const result = {
          tools: created.session.agent.state.tools.map((tool) => tool.name),
          prompt: created.session.agent.state.systemPrompt,
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
      tools: [],
      prompt: `${DEFAULT_FREEDOM_AGENT_SYSTEM_PROMPT}\nCurrent working directory: ${VIRTUAL_AGENT_CWD}\n`,
      extensions: 0,
      sessionFile: null,
      skills: 0,
      contextFiles: 0,
    });
  });
});
