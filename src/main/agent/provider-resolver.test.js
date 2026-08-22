'use strict';

const {
  FREE_PI_BASE_URL,
  FREE_PI_MODEL_ID,
  OLLAMA_DEFAULT_BASE_URL,
  AgentProviderResolver,
  normalizeOllamaBaseUrl,
} = require('./provider-resolver');

function createRuntime() {
  let configuredSubscription = false;
  const models = new Map([
    ['anthropic/model-a', { provider: 'anthropic', id: 'model-a', name: 'Model A' }],
    ['openai/model-b', { provider: 'openai', id: 'model-b', name: 'Model B' }],
    ['openrouter/model-c', { provider: 'openrouter', id: 'model-c', name: 'Model C' }],
    [
      'openai-codex/codex-model',
      { provider: 'openai-codex', id: 'codex-model', name: 'Codex Model', reasoning: true },
    ],
  ]);
  return {
    getModels: jest.fn((providerId) =>
      [...models.values()].filter((model) => model.provider === providerId)
    ),
    getModel: jest.fn((providerId, modelId) => models.get(`${providerId}/${modelId}`)),
    setRuntimeApiKey: jest.fn(async () => {}),
    refresh: jest.fn(async ({ providers }) => {
      if (providers?.includes('openai-codex')) configuredSubscription = true;
      return { aborted: false, errors: new Map() };
    }),
    hasConfiguredAuth: jest.fn((providerId) =>
      providerId === 'openai-codex' ? configuredSubscription : true
    ),
    login: jest.fn(async () => ({
      type: 'oauth',
      access: 'access-secret',
      refresh: 'refresh-secret',
      expires: Date.now() + 60_000,
    })),
    logout: jest.fn(async () => {}),
    registerProvider: jest.fn((providerId, config) => {
      for (const model of config.models) {
        models.set(`${providerId}/${model.id}`, { provider: providerId, ...model });
      }
    }),
  };
}

function createResolver(selection = null) {
  const runtime = createRuntime();
  const store = {
    isEncryptionAvailable: jest.fn(() => true),
    getPublicStatus: jest.fn(() => ({
      configured: Boolean(selection),
      connections: selection
        ? [
            {
              kind: selection.kind,
              providerId: selection.providerId,
              modelId: selection.modelId,
            },
          ]
        : [],
    })),
    getSelection: jest.fn(() => selection),
    saveHosted: jest.fn(),
    saveOllama: jest.fn(),
    saveSubscription: jest.fn(),
    select: jest.fn(),
    remove: jest.fn(),
    createCredentialStore: jest.fn(() => ({
      read: jest.fn(async (providerId) =>
        providerId === 'openai-codex'
          ? {
              type: 'oauth',
              access: 'access-secret',
              refresh: 'refresh-secret',
              expires: Date.now() + 60_000,
            }
          : undefined
      ),
      list: jest.fn(),
      modify: jest.fn(),
      delete: jest.fn(),
    })),
    clear: jest.fn(),
  };
  const sdk = { ModelRuntime: { create: jest.fn(async () => runtime) } };
  return {
    runtime,
    store,
    resolver: new AgentProviderResolver({
      store,
      dataDir: '/profile/agent',
      loadSdk: jest.fn(async () => sdk),
    }),
  };
}

describe('AgentProviderResolver', () => {
  test('configures and resolves a hosted model with only an in-memory key', async () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'anthropic',
      modelId: 'model-a',
      apiKey: 'sk-secret',
    });

    await ctx.resolver.configureHosted({
      providerId: 'anthropic',
      modelId: 'model-a',
      apiKey: 'sk-new',
    });
    const resolved = await ctx.resolver.resolveModel();

    expect(ctx.store.saveHosted).toHaveBeenCalledWith({
      providerId: 'anthropic',
      modelId: 'model-a',
      apiKey: 'sk-new',
    });
    expect(ctx.runtime.setRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-secret');
    expect(resolved.model).toMatchObject({ provider: 'anthropic', id: 'model-a' });
    expect(resolved.thinkingLevel).toBe('off');
  });

  test('registers and resolves Free Pi through its fixed hosted endpoint', async () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'freepi',
      modelId: FREE_PI_MODEL_ID,
      apiKey: 'test-key',
    });

    await ctx.resolver.configureHosted({
      providerId: 'freepi',
      modelId: FREE_PI_MODEL_ID,
      apiKey: 'new-test-key',
    });
    const resolved = await ctx.resolver.resolveModel();

    expect(ctx.runtime.registerProvider).toHaveBeenCalledWith(
      'freepi',
      expect.objectContaining({
        name: 'Free Pi',
        baseUrl: FREE_PI_BASE_URL,
        api: 'openai-completions',
        models: [
          expect.objectContaining({
            id: FREE_PI_MODEL_ID,
            compat: expect.objectContaining({
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              maxTokensField: 'max_tokens',
            }),
          }),
        ],
      })
    );
    const freePiConfig = ctx.runtime.registerProvider.mock.calls.find(
      ([providerId]) => providerId === 'freepi'
    )[1];
    expect(freePiConfig).not.toHaveProperty('apiKey');
    expect(JSON.stringify(freePiConfig)).not.toContain('test-key');
    expect(ctx.store.saveHosted).toHaveBeenCalledWith({
      providerId: 'freepi',
      modelId: FREE_PI_MODEL_ID,
      apiKey: 'new-test-key',
    });
    expect(ctx.runtime.setRuntimeApiKey).toHaveBeenCalledWith('freepi', 'test-key');
    expect(resolved.model).toMatchObject({ provider: 'freepi', id: FREE_PI_MODEL_ID });
  });

  test('rejects unsupported providers, unknown models, and malformed keys', async () => {
    const ctx = createResolver();
    await expect(
      ctx.resolver.configureHosted({ providerId: 'google', modelId: 'x', apiKey: 'key' })
    ).rejects.toThrow('not supported');
    await expect(
      ctx.resolver.configureHosted({ providerId: 'openai', modelId: 'missing', apiKey: 'key' })
    ).rejects.toThrow('not available');
    await expect(
      ctx.resolver.configureHosted({ providerId: 'openai', modelId: 'model-b', apiKey: ' key ' })
    ).rejects.toThrow('API key is invalid');
  });

  test('registers an explicitly loopback Ollama model', async () => {
    const ctx = createResolver({
      kind: 'ollama',
      providerId: 'ollama',
      modelId: 'qwen2.5:7b',
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
    });

    const resolved = await ctx.resolver.resolveModel();

    expect(ctx.runtime.registerProvider).toHaveBeenCalledWith(
      'ollama',
      expect.objectContaining({
        baseUrl: OLLAMA_DEFAULT_BASE_URL,
        api: 'openai-completions',
        models: [expect.objectContaining({ id: 'qwen2.5:7b' })],
      })
    );
    expect(ctx.runtime.setRuntimeApiKey).toHaveBeenCalledWith('ollama', 'ollama');
    expect(resolved.model).toMatchObject({ provider: 'ollama', id: 'qwen2.5:7b' });
  });

  test('logs in and resolves ChatGPT subscription models through Pi OAuth', async () => {
    const ctx = createResolver({
      kind: 'subscription',
      providerId: 'openai-codex',
      modelId: 'codex-model',
    });
    const interaction = {
      signal: new AbortController().signal,
      prompt: jest.fn(),
      notify: jest.fn(),
    };

    await ctx.resolver.loginSubscription(
      { providerId: 'openai-codex', modelId: 'codex-model' },
      interaction
    );
    const resolved = await ctx.resolver.resolveModel();

    expect(ctx.runtime.login).toHaveBeenCalledWith('openai-codex', 'oauth', interaction);
    expect(ctx.store.saveSubscription).toHaveBeenCalledWith({
      providerId: 'openai-codex',
      modelId: 'codex-model',
    });
    expect(ctx.runtime.refresh).toHaveBeenCalledWith({
      allowNetwork: false,
      providers: ['openai-codex'],
    });
    expect(resolved.model).toMatchObject({ provider: 'openai-codex', id: 'codex-model' });
    expect(resolved.thinkingLevel).toBe('medium');
    expect(ctx.runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(ctx.runtime.registerProvider).not.toHaveBeenCalled();
  });

  test('selects only models exposed by a configured provider connection', async () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'openai',
      modelId: 'model-b',
      apiKey: 'sk-secret',
    });

    await expect(
      ctx.resolver.selectModel({ providerId: 'openai', modelId: 'model-b' })
    ).resolves.toMatchObject({ configured: true });
    expect(ctx.store.select).toHaveBeenCalledWith('openai', 'model-b');
    await expect(
      ctx.resolver.selectModel({ providerId: 'openai', modelId: 'missing' })
    ).rejects.toMatchObject({ code: 'AGENT_MODEL_INVALID' });
    await expect(
      ctx.resolver.selectModel({ providerId: 'anthropic', modelId: 'model-a' })
    ).rejects.toMatchObject({ code: 'AGENT_MODEL_INVALID' });
  });

  test('removes a provider connection without clearing the full store', () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'openai',
      modelId: 'model-b',
      apiKey: 'sk-secret',
    });

    ctx.resolver.removeProvider({ providerId: 'openai' });

    expect(ctx.store.remove).toHaveBeenCalledWith('openai');
    expect(ctx.store.clear).not.toHaveBeenCalled();
  });

  test('refuses subscription login before OAuth when secure storage is unavailable', async () => {
    const ctx = createResolver();
    ctx.store.isEncryptionAvailable.mockReturnValue(false);

    await expect(
      ctx.resolver.loginSubscription(
        { providerId: 'openai-codex', modelId: 'codex-model' },
        { prompt: jest.fn(), notify: jest.fn() }
      )
    ).rejects.toMatchObject({ code: 'AGENT_SECURE_STORAGE_UNAVAILABLE' });
    expect(ctx.runtime.login).not.toHaveBeenCalled();
  });

  test('fails closed when Pi does not accept the stored subscription credential', async () => {
    const ctx = createResolver({
      kind: 'subscription',
      providerId: 'openai-codex',
      modelId: 'codex-model',
    });
    ctx.runtime.hasConfiguredAuth.mockReturnValue(false);

    await expect(ctx.resolver.resolveModel()).rejects.toMatchObject({
      code: 'AGENT_PROVIDER_AUTH_UNAVAILABLE',
    });
    expect(ctx.runtime.refresh).toHaveBeenCalledWith({
      allowNetwork: false,
      providers: ['openai-codex'],
    });
  });

  test.each([
    'https://127.0.0.1:11434/v1',
    'http://192.168.1.5:11434/v1',
    'http://user:pass@localhost:11434/v1',
    'http://localhost:11434/v1?token=secret',
  ])('rejects non-loopback or credential-bearing Ollama URL %s', (url) => {
    expect(() => normalizeOllamaBaseUrl(url)).toThrow('loopback HTTP URL');
  });

  test('normalizes supported Ollama URLs to the OpenAI-compatible v1 endpoint', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434')).toBe(
      'http://localhost:11434/v1'
    );
    expect(normalizeOllamaBaseUrl('http://[::1]:11434/v1/')).toBe(
      'http://[::1]:11434/v1'
    );
  });

  test('returns a renderer-safe hosted catalog without credentials', async () => {
    const ctx = createResolver();
    await expect(ctx.resolver.getCatalog()).resolves.toEqual([
      {
        providerId: 'anthropic',
        name: 'Anthropic',
        authType: 'api_key',
        models: [{ id: 'model-a', name: 'Model A', reasoning: false }],
      },
      {
        providerId: 'openai',
        name: 'OpenAI',
        authType: 'api_key',
        models: [{ id: 'model-b', name: 'Model B', reasoning: false }],
      },
      {
        providerId: 'openrouter',
        name: 'OpenRouter',
        authType: 'api_key',
        models: [{ id: 'model-c', name: 'Model C', reasoning: false }],
      },
      {
        providerId: 'freepi',
        name: 'Free Pi',
        authType: 'api_key',
        models: [
          {
            id: FREE_PI_MODEL_ID,
            name: 'DeepSeek V4 Flash',
            reasoning: false,
          },
        ],
      },
      {
        providerId: 'openai-codex',
        name: 'ChatGPT (Codex)',
        authType: 'subscription',
        models: [
          {
            id: 'codex-model',
            name: 'Codex Model',
            reasoning: true,
          },
        ],
      },
    ]);
    expect(JSON.stringify(await ctx.resolver.getCatalog())).not.toContain('sk-secret');
  });

  test('fails when no model is configured', async () => {
    const ctx = createResolver();
    await expect(ctx.resolver.resolveModel()).rejects.toMatchObject({
      code: 'AGENT_MODEL_UNAVAILABLE',
    });
  });
});
