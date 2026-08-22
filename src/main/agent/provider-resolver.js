'use strict';

const path = require('path');
const { loadPiSdk } = require('./pi-sdk');

const HOSTED_PROVIDERS = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  freepi: 'Free Pi',
});
const SUBSCRIPTION_PROVIDERS = Object.freeze({
  'openai-codex': 'ChatGPT (Codex)',
});
const FREE_PI_BASE_URL = 'https://sponsored-api-pilot-production.up.railway.app/api/v1';
const FREE_PI_MODEL_ID = 'deepseek/deepseek-v4-flash';
const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function registerFreePi(runtime) {
  runtime.registerProvider('freepi', {
    name: HOSTED_PROVIDERS.freepi,
    baseUrl: FREE_PI_BASE_URL,
    api: 'openai-completions',
    models: [
      {
        id: FREE_PI_MODEL_ID,
        name: 'DeepSeek V4 Flash',
        reasoning: false,
        input: ['text'],
        cost: ZERO_COST,
        contextWindow: 128_000,
        maxTokens: 8_192,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
          maxTokensField: 'max_tokens',
        },
      },
    ],
  });
}

class AgentProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentProviderError';
    this.code = code;
  }
}

function requireIdentifier(value, field) {
  const hasControlCharacter =
    typeof value === 'string' && [...value].some((character) => {
      const code = character.codePointAt(0);
      return code <= 31 || code === 127;
    });
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 200 ||
    hasControlCharacter
  ) {
    throw new AgentProviderError('AGENT_PROVIDER_INVALID', `${field} is invalid`);
  }
  return value;
}

function normalizeOllamaBaseUrl(value = OLLAMA_DEFAULT_BASE_URL) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Ollama URL must be absolute');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new AgentProviderError(
      'AGENT_PROVIDER_INVALID',
      'Ollama must use an uncredentialed loopback HTTP URL'
    );
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '') || ''}/v1`.replace('/v1/v1', '/v1');
  return parsed.toString().replace(/\/$/, '');
}

class AgentProviderResolver {
  constructor(options = {}) {
    if (!options.store) throw new TypeError('AgentProviderResolver requires a provider store');
    if (typeof options.dataDir !== 'string' || !options.dataDir) {
      throw new TypeError('AgentProviderResolver requires a profile data directory');
    }
    this.store = options.store;
    this.dataDir = path.resolve(options.dataDir);
    this.loadSdk = options.loadSdk || loadPiSdk;
    if (typeof this.store.createCredentialStore !== 'function') {
      throw new TypeError('AgentProviderResolver requires an app-owned credential store');
    }
    this.credentials = this.store.createCredentialStore();
  }

  getStatus() {
    return this.store.getPublicStatus();
  }

  async getCatalog() {
    const runtime = await this.#createRuntime();
    registerFreePi(runtime);
    const catalogProviders = [
      ...Object.entries(HOSTED_PROVIDERS).map(([providerId, name]) => ({
        providerId,
        name,
        authType: 'api_key',
      })),
      ...Object.entries(SUBSCRIPTION_PROVIDERS).map(([providerId, name]) => ({
        providerId,
        name,
        authType: 'subscription',
      })),
    ];
    return catalogProviders.map(({ providerId, name, authType }) => ({
      providerId,
      name,
      authType,
      models: runtime.getModels(providerId).map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning === true,
      })),
    }));
  }

  async configureHosted(input = {}) {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    const modelId = requireIdentifier(input.modelId, 'modelId');
    if (!Object.hasOwn(HOSTED_PROVIDERS, providerId)) {
      throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Hosted provider is not supported');
    }
    if (
      typeof input.apiKey !== 'string' ||
      !input.apiKey.trim() ||
      input.apiKey !== input.apiKey.trim() ||
      input.apiKey.length > 16_384
    ) {
      throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Provider API key is invalid');
    }
    const runtime = await this.#createRuntime();
    registerFreePi(runtime);
    if (!runtime.getModel(providerId, modelId)) {
      throw new AgentProviderError('AGENT_MODEL_INVALID', 'Selected model is not available');
    }
    this.store.saveHosted({ providerId, modelId, apiKey: input.apiKey });
    return this.getStatus();
  }

  configureOllama(input = {}) {
    const modelId = requireIdentifier(input.modelId, 'modelId');
    const baseUrl = normalizeOllamaBaseUrl(input.baseUrl);
    this.store.saveOllama({ modelId, baseUrl });
    return this.getStatus();
  }

  async loginSubscription(input = {}, interaction) {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    const modelId = requireIdentifier(input.modelId, 'modelId');
    if (!Object.hasOwn(SUBSCRIPTION_PROVIDERS, providerId)) {
      throw new AgentProviderError(
        'AGENT_PROVIDER_INVALID',
        'Subscription provider is not supported'
      );
    }
    if (this.store.isEncryptionAvailable() !== true) {
      throw new AgentProviderError(
        'AGENT_SECURE_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable'
      );
    }
    if (
      !interaction ||
      typeof interaction.prompt !== 'function' ||
      typeof interaction.notify !== 'function'
    ) {
      throw new AgentProviderError(
        'AGENT_PROVIDER_INVALID',
        'Provider login interaction is invalid'
      );
    }
    const runtime = await this.#createRuntime();
    if (!runtime.getModel(providerId, modelId)) {
      throw new AgentProviderError('AGENT_MODEL_INVALID', 'Selected model is not available');
    }
    await runtime.login(providerId, 'oauth', interaction);
    try {
      this.store.saveSubscription({ providerId, modelId });
    } catch (error) {
      await runtime.logout(providerId).catch(() => {});
      throw error;
    }
    return this.getStatus();
  }

  clear() {
    this.store.clear();
    return this.getStatus();
  }

  async resolveModel() {
    const selection = this.store.getSelection();
    if (!selection) {
      throw new AgentProviderError('AGENT_MODEL_UNAVAILABLE', 'No agent model is configured');
    }
    const runtime = await this.#createRuntime();
    registerFreePi(runtime);
    if (selection.kind === 'hosted') {
      await runtime.setRuntimeApiKey(selection.providerId, selection.apiKey);
    } else if (selection.kind === 'ollama') {
      runtime.registerProvider('ollama', {
        name: 'Ollama',
        baseUrl: selection.baseUrl,
        api: 'openai-completions',
        models: [
          {
            id: selection.modelId,
            name: selection.modelId,
            reasoning: false,
            input: ['text'],
            cost: ZERO_COST,
            contextWindow: 128_000,
            maxTokens: 16_384,
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          },
        ],
      });
      await runtime.setRuntimeApiKey('ollama', 'ollama');
    } else if (selection.kind === 'subscription') {
      const credential = await this.credentials.read(selection.providerId);
      if (!credential || !runtime.hasConfiguredAuth(selection.providerId)) {
        throw new AgentProviderError(
          'AGENT_CREDENTIAL_UNAVAILABLE',
          'The saved provider credential is unavailable'
        );
      }
    }
    const model = runtime.getModel(selection.providerId, selection.modelId);
    if (!model) {
      throw new AgentProviderError('AGENT_MODEL_UNAVAILABLE', 'Configured agent model is unavailable');
    }
    return {
      model,
      modelRuntime: runtime,
      thinkingLevel: selection.kind === 'subscription' ? 'medium' : 'off',
    };
  }

  async #createRuntime() {
    const sdk = await this.loadSdk();
    return sdk.ModelRuntime.create({
      credentials: this.credentials,
      modelsPath: null,
      modelsStorePath: path.join(this.dataDir, 'pi-model-cache.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  }
}

module.exports = {
  FREE_PI_BASE_URL,
  FREE_PI_MODEL_ID,
  HOSTED_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  OLLAMA_DEFAULT_BASE_URL,
  AgentProviderError,
  AgentProviderResolver,
  normalizeOllamaBaseUrl,
  requireIdentifier,
};
