'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ProviderCatalog,
  normalizeModels,
  modelAllowed,
  runtimeModel,
} = require('./provider-catalog');

function venice(privacy = 'private', capabilities = {}) {
  return {
    data: [
      {
        id: 'test-model',
        type: 'text',
        model_spec: {
          name: 'Test model',
          privacy,
          availableContextTokens: 64000,
          capabilities: { supportsFunctionCalling: true, ...capabilities },
          pricing: { input: { usd: 0.2 }, output: { usd: 0.8 } },
        },
      },
    ],
  };
}

function createCatalog(fetch) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-provider-catalog-'));
  return { dataDir, catalog: new ProviderCatalog({ dataDir, fetch }) };
}

describe('provider model discovery', () => {
  test('normalizes Venice capabilities and blocks E2EE-only and non-tool models', () => {
    const [model] = normalizeModels('venice', venice());
    expect(model).toMatchObject({
      privacy: 'private',
      contextWindow: 64000,
      tools: true,
      inputPrice: 0.2,
    });
    expect(modelAllowed(model, 'private')).toBe(true);
    expect(modelAllowed(model, 'tee')).toBe(false);
    expect(modelAllowed(normalizeModels('venice', venice('e2ee'))[0])).toBe(false);
    expect(
      modelAllowed(
        normalizeModels('venice', venice('private', { supportsFunctionCalling: false }))[0]
      )
    ).toBe(false);
    expect(modelAllowed(normalizeModels('venice', venice('anonymized'))[0], 'private')).toBe(false);
  });

  test('NEAR requires all TEE assertions and ignores model-supplied origins and headers', () => {
    const raw = {
      models: [
        {
          modelId: 'test',
          metadata: {
            modelDisplayName: 'Test',
            contextLength: 128000,
            providerType: 'external',
            verifiable: true,
            attestationSupported: true,
            supportedFeatures: ['tools', 'reasoning'],
            inferenceUrl: 'https://untrusted.example',
            providerConfig: { headers: { Authorization: 'secret' } },
            architecture: { inputModalities: ['text', 'image'], outputModalities: ['text'] },
          },
          inputCostPerToken: { amount: 200, scale: 9, currency: 'USD' },
        },
      ],
    };
    let model = normalizeModels('near-ai', raw)[0];
    expect(model).toMatchObject({ privacy: 'external', inputPrice: 0.2, vision: true });
    expect(modelAllowed(model, 'tee')).toBe(false);
    expect(JSON.stringify(runtimeModel(model))).not.toMatch(/untrusted|Authorization|secret/);
    raw.models[0].metadata.providerType = 'vllm';
    model = normalizeModels('near-ai', raw)[0];
    expect(modelAllowed(model, 'tee')).toBe(true);
  });

  test('unknown capabilities remain unknown; malformed and incomplete catalogs are rejected', () => {
    expect(normalizeModels('openrouter', { data: [{ id: 'test' }] })[0].tools).toBeNull();
    expect(() => normalizeModels('venice', { data: [] })).toThrow();
    expect(() => normalizeModels('near-ai', { models: [{}], total: 2001 })).toThrow();
    expect(() => normalizeModels('openrouter', { data: [{ id: 'bad\nmodel' }] })).toThrow();
  });

  test('refresh uses a fixed origin, bounded request, and saves no credential', async () => {
    const fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(venice())));
    const { catalog, dataDir } = createCatalog(fetch);
    await catalog.refresh('venice', 'test-secret');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.venice.ai/api/v1/models?type=text',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', Authorization: 'Bearer test-secret' },
      })
    );
    expect(fs.readFileSync(catalog.filePath, 'utf8')).not.toContain('test-secret');
    expect(new ProviderCatalog({ dataDir }).get('venice')).toEqual(catalog.get('venice'));
    await expect(catalog.refresh('evil', 'test-secret')).rejects.toMatchObject({
      code: 'AGENT_CATALOG_UNAVAILABLE',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('public catalogs never receive a supplied key and refresh failure keeps the last good snapshot', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'test' }] })));
    const { catalog } = createCatalog(fetch);
    await catalog.refresh('openrouter', 'test-secret');
    expect(fetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' });
    const before = fs.readFileSync(catalog.filePath, 'utf8');
    fetch.mockResolvedValue(new Response('credential echo', { status: 401 }));
    await expect(catalog.refresh('openrouter')).rejects.toMatchObject({
      code: 'AGENT_CATALOG_AUTH_FAILED',
    });
    expect(fs.readFileSync(catalog.filePath, 'utf8')).toBe(before);
    fetch.mockResolvedValue(
      new Response('bad', { headers: { 'content-length': String(5 * 1024 * 1024) } })
    );
    await expect(catalog.refresh('openrouter')).rejects.toMatchObject({
      code: 'AGENT_CATALOG_UNAVAILABLE',
    });
    expect(fs.readFileSync(catalog.filePath, 'utf8')).toBe(before);
  });

  test('streamed oversized catalogs are bounded even without content-length', async () => {
    const fetch = jest.fn().mockResolvedValue(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    const { catalog } = createCatalog(fetch);
    await expect(catalog.refresh('openrouter')).rejects.toMatchObject({
      code: 'AGENT_CATALOG_UNAVAILABLE',
    });
    expect(fs.existsSync(catalog.filePath)).toBe(false);
  });

  test('a catalog request times out without replacing saved models', async () => {
    jest.useFakeTimers();
    try {
      const fetch = jest.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const { catalog } = createCatalog(fetch);
      const assertion = expect(catalog.refresh('openrouter')).rejects.toMatchObject({
        code: 'AGENT_CATALOG_UNAVAILABLE',
      });
      await jest.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});

test('OpenAI discovery filters non-agent products and preserves known capabilities', () => {
  const models = normalizeModels('openai', { data: [{ id: 'gpt-6-astra' }, { id: 'embedding' }, { id: 'known' }] }, [
    { id: 'known', name: 'Known', contextWindow: 128000, maxTokens: 16000, input: ['text', 'image'] },
  ]);
  expect(models.map((model) => model.id)).toEqual(['gpt-6-astra', 'known']);
  expect(models[0]).toMatchObject({ reasoning: true, vision: true, contextWindow: 1050000 });
  expect(models[1]).toMatchObject({ vision: true, contextWindow: 128000, maxTokens: 16000 });
});

test('subscription discovery uses its own catalog, strips remote instructions and caches safe metadata', async () => {
  const fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', context_window: 1050000,
      supported_reasoning_levels: [{ effort: 'medium' }], input_modalities: ['text', 'image'], base_instructions: 'untrusted', base_url: 'https://evil.example' },
    { slug: 'hidden', visibility: 'hide' },
  ] })));
  const { catalog, dataDir } = createCatalog(fetch);
  await catalog.refresh('openai-codex', 'test-token', { accountId: 'test-account' });
  expect(fetch.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.153.0');
  expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer test-token', 'ChatGPT-Account-ID': 'test-account', originator: 'pi' });
  expect(catalog.get('openai-codex').models).toHaveLength(1);
  const serialized = fs.readFileSync(catalog.filePath, 'utf8');
  expect(serialized).not.toMatch(/test-token|test-account|untrusted|evil/);
  expect(new ProviderCatalog({ dataDir }).get('openai-codex')).toEqual(catalog.get('openai-codex'));
  await expect(catalog.refresh('openai-codex', 'token')).rejects.toMatchObject({ code: 'AGENT_CATALOG_AUTH_FAILED' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
