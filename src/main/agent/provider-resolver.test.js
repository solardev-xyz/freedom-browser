'use strict';

const {
  OLLAMA_DEFAULT_BASE_URL,
  AgentProviderResolver,
  normalizeOllamaBaseUrl,
} = require('./provider-resolver');

function createRuntime() {
  const models = new Map([
    ['anthropic/model-a', { provider: 'anthropic', id: 'model-a', name: 'Model A' }],
    ['openai/model-b', { provider: 'openai', id: 'model-b', name: 'Model B' }],
    ['openrouter/model-c', { provider: 'openrouter', id: 'model-c', name: 'Model C' }],
  ]);
  return {
    getModels: jest.fn((providerId) =>
      [...models.values()].filter((model) => model.provider === providerId)
    ),
    getModel: jest.fn((providerId, modelId) => models.get(`${providerId}/${modelId}`)),
    setRuntimeApiKey: jest.fn(async () => {}),
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
    getPublicStatus: jest.fn(() => ({ configured: Boolean(selection) })),
    getSelection: jest.fn(() => selection),
    saveHosted: jest.fn(),
    saveOllama: jest.fn(),
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
        models: [{ id: 'model-a', name: 'Model A', reasoning: false }],
      },
      {
        providerId: 'openai',
        name: 'OpenAI',
        models: [{ id: 'model-b', name: 'Model B', reasoning: false }],
      },
      {
        providerId: 'openrouter',
        name: 'OpenRouter',
        models: [{ id: 'model-c', name: 'Model C', reasoning: false }],
      },
    ]);
    expect(JSON.stringify(await ctx.resolver.getCatalog())).not.toContain('key');
  });

  test('fails when no model is configured', async () => {
    const ctx = createResolver();
    await expect(ctx.resolver.resolveModel()).rejects.toMatchObject({
      code: 'AGENT_MODEL_UNAVAILABLE',
    });
  });
});
