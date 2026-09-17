'use strict';

const {
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

function createResolver(selection = null, options = {}) {
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
              baseUrl: selection.baseUrl,
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
      ...options,
    }),
  };
}

describe('AgentProviderResolver', () => {
  test('discovers installed Ollama models without a model name or inference', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({ models: [
      { name: 'qwen3:8b' }, { name: 'llama3.2:3b' }, { name: 'qwen3:8b' },
    ] })));
    const { resolver, store } = createResolver(null, { fetch });
    await resolver.configureOllama();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.objectContaining({
      method: 'GET', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    expect(store.saveOllama).toHaveBeenCalledWith({
      modelId: 'qwen3:8b', modelIds: ['qwen3:8b', 'llama3.2:3b'], baseUrl: OLLAMA_DEFAULT_BASE_URL, activate: true,
    });
  });

  test('rediscovery preserves an installed selection on the same server', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({ models: [
      { name: 'qwen3:8b' }, { name: 'llama3.2:3b' },
    ] })));
    const { resolver, store } = createResolver({
      kind: 'ollama', providerId: 'ollama', modelId: 'llama3.2:3b', baseUrl: OLLAMA_DEFAULT_BASE_URL,
    }, { fetch });
    await resolver.configureOllama();
    expect(store.saveOllama).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'llama3.2:3b' }));
    await resolver.refreshModels({ providerId: 'ollama' });
    expect(store.saveOllama).toHaveBeenLastCalledWith(expect.objectContaining({ modelId: 'llama3.2:3b', activate: false }));
  });

  test.each([
    ['empty', () => new Response('{"models":[]}'), 'AGENT_OLLAMA_NO_MODELS'],
    ['offline', () => { throw new Error('connection refused'); }, 'AGENT_OLLAMA_DISCOVERY_FAILED'],
    ['HTTP error', () => new Response('{}', { status: 500 }), 'AGENT_OLLAMA_DISCOVERY_FAILED'],
    ['malformed JSON', () => new Response('oops'), 'AGENT_OLLAMA_DISCOVERY_FAILED'],
    ['missing models', () => new Response('{}'), 'AGENT_OLLAMA_DISCOVERY_FAILED'],
    ['invalid name', () => new Response('{"models":[{"name":"bad\\nname"}]}'), 'AGENT_OLLAMA_DISCOVERY_FAILED'],
    ['oversized body', () => new Response('x'.repeat(1024 * 1024 + 1)), 'AGENT_OLLAMA_DISCOVERY_FAILED'],
    ['too many models', () => new Response(JSON.stringify({ models: Array.from({ length: 129 }, (_, i) => ({ name: `model-${i}` })) })), 'AGENT_OLLAMA_MODEL_LIMIT'],
  ])('leaves the saved connection intact on %s discovery', async (_name, response, code) => {
    const { resolver, store } = createResolver(null, { fetch: jest.fn(async () => response()) });
    await expect(resolver.configureOllama()).rejects.toMatchObject({ code });
    expect(store.saveOllama).not.toHaveBeenCalled();
  });

  test('rejects a remote Ollama URL before making a discovery request', async () => {
    const fetch = jest.fn();
    const { resolver } = createResolver(null, { fetch });
    await expect(resolver.configureOllama({ baseUrl: 'http://example.com' })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_INVALID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects unsupported privacy settings and validates bounded favorites', () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'openrouter',
      modelId: 'model-c',
      apiKey: 'secret',
    });
    ctx.store.savePreferences = jest.fn();
    expect(() =>
      ctx.resolver.setPreferences({ providerId: 'openrouter', privacyPolicy: 'tee' })
    ).toThrow();
    expect(() =>
      ctx.resolver.setPreferences({ providerId: 'openrouter', favoriteModelIds: ['bad\nmodel'] })
    ).toThrow();
    ctx.resolver.setPreferences({
      providerId: 'openrouter',
      privacyPolicy: 'zdr',
      favoriteModelIds: ['one', 'one', 'two'],
    });
    expect(ctx.store.savePreferences).toHaveBeenCalledWith('openrouter', {
      privacyPolicy: 'zdr',
      favoriteModelIds: ['one', 'two'],
    });
  });

  test('private selection blocks unsupported, reclassified and expired catalog entries', async () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'venice',
      modelId: 'private-model',
      apiKey: 'secret',
    });
    const model = {
      id: 'private-model',
      name: 'Private',
      tools: true,
      available: true,
      privacy: 'private',
      contextWindow: 32000,
      maxTokens: 4096,
    };
    const entry = { updatedAt: Date.now(), models: [model] };
    ctx.resolver.catalog = { get: (id) => (id === 'venice' ? entry : { models: [] }) };
    ctx.store.getPublicStatus.mockReturnValue({
      connections: [{ providerId: 'venice', privacyPolicy: 'private' }],
    });
    await expect(ctx.resolver.resolveModel()).resolves.toMatchObject({
      model: { id: 'private-model' },
    });
    model.privacy = 'anonymized';
    await expect(ctx.resolver.resolveModel()).rejects.toMatchObject({ code: 'AGENT_MODEL_POLICY' });
    model.privacy = 'private';
    entry.updatedAt = Date.now() - 86_400_001;
    await expect(ctx.resolver.resolveModel()).rejects.toMatchObject({
      code: 'AGENT_CATALOG_EXPIRED',
    });
    expect(ctx.store.select).not.toHaveBeenCalled();
  });

  test('a refresh uses only the selected provider credential and never saves an entered key', async () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'venice',
      modelId: 'test',
      apiKey: 'saved',
    });
    ctx.resolver.catalog.refresh = jest.fn();
    await ctx.resolver.refreshModels({ providerId: 'venice' });
    expect(ctx.store.getSelection).toHaveBeenCalledWith('venice');
    expect(ctx.resolver.catalog.refresh).toHaveBeenCalledWith('venice', 'saved', expect.any(Object));
    await ctx.resolver.refreshModels({ providerId: 'venice', apiKey: 'entered' });
    expect(ctx.resolver.catalog.refresh).toHaveBeenLastCalledWith('venice', 'entered', expect.any(Object));
    expect(ctx.store.saveHosted).not.toHaveBeenCalled();
  });

  test('connection test sends only a fixed, bounded prompt and exposes no provider output', async () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'openai',
      modelId: 'model-b',
      apiKey: 'secret',
    });
    ctx.runtime.completeSimple = jest
      .fn()
      .mockResolvedValue({
        stopReason: 'stop',
        content: [{ type: 'text', text: 'sensitive diagnostic' }],
      });
    const result = await ctx.resolver.testConnection({
      providerId: 'openai',
      modelId: 'model-b',
      prompt: 'private user content',
    });
    expect(result).toEqual({ elapsedMs: expect.any(Number) });
    ctx.runtime.completeSimple.mockResolvedValue({ stopReason: 'length', content: [] });
    await expect(ctx.resolver.testConnection({ providerId: 'openai', modelId: 'model-b' })).resolves.toMatchObject({ outcome: 'token_limit' });
    expect(ctx.runtime.completeSimple).toHaveBeenCalledWith(
      expect.any(Object),
      {
        messages: [{ role: 'user', content: 'Reply with OK.', timestamp: expect.any(Number) }],
      },
      expect.objectContaining({ maxTokens: 32, maxRetries: 0, signal: expect.any(AbortSignal) })
    );
    ctx.runtime.completeSimple.mockResolvedValue({
      stopReason: 'error',
      errorMessage: 'raw credential',
    });
    await expect(
      ctx.resolver.testConnection({ providerId: 'openai', modelId: 'model-b' })
    ).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TEST_FAILED' });
  });

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

  test('rejects retired Free Pi configuration and runtime selection before supplying a key', async () => {
    const ctx = createResolver({
      kind: 'hosted',
      providerId: 'freepi',
      modelId: 'retired-model',
      apiKey: 'test-key',
    });
    await expect(
      ctx.resolver.configureHosted({
        providerId: 'freepi',
        modelId: 'retired-model',
        apiKey: 'test-key',
      })
    ).rejects.toMatchObject({ code: 'AGENT_PROVIDER_INVALID' });
    await expect(ctx.resolver.resolveModel()).rejects.toMatchObject({
      code: 'AGENT_PROVIDER_INVALID',
    });
    expect(ctx.store.saveHosted).not.toHaveBeenCalled();
    expect(ctx.runtime.registerProvider).not.toHaveBeenCalled();
    expect(ctx.runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(ctx.resolver.loadSdk).not.toHaveBeenCalled();
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
    expect(ctx.runtime.registerProvider).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({ api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' })
    );
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
    expect(normalizeOllamaBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(normalizeOllamaBaseUrl('http://[::1]:11434/v1/')).toBe('http://[::1]:11434/v1');
  });

  test('returns a renderer-safe hosted catalog without credentials', async () => {
    const ctx = createResolver();
    const catalog = await ctx.resolver.getCatalog();
    expect(catalog.map((provider) => provider.providerId)).toEqual([
      'openai',
      'anthropic',
      'xai',
      'meta',
      'openrouter',
      'venice',
      'near-ai',
      'openai-codex',
    ]);
    expect(catalog.find((p) => p.providerId === 'anthropic').models).toEqual([
      expect.objectContaining({ id: 'model-a', name: 'Model A', reasoning: false }),
    ]);
    expect(catalog.find((p) => p.providerId === 'meta').models).toEqual([
      expect.objectContaining({ id: 'muse-spark-1.3', tools: true }),
    ]);
    expect(catalog.find((p) => p.providerId === 'venice')).toMatchObject({ canRefresh: true });
    expect(JSON.stringify(await ctx.resolver.getCatalog())).not.toContain('sk-secret');
  });

  test('fails when no model is configured', async () => {
    const ctx = createResolver();
    await expect(ctx.resolver.resolveModel()).rejects.toMatchObject({
      code: 'AGENT_MODEL_UNAVAILABLE',
    });
  });
});
