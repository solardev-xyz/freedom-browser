'use strict';

const path = require('path');
const { loadPiSdk } = require('./pi-sdk');
const {
  PROVIDER_DEFINITIONS,
  CUSTOM_PROVIDERS,
  ProviderCatalog,
  runtimeModel,
  modelAllowed,
} = require('./provider-catalog');

const HOSTED_PROVIDERS = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_DEFINITIONS)
      .filter(([, definition]) => !definition.authType)
      .map(([id, definition]) => [id, definition.name])
  )
);
const SUBSCRIPTION_PROVIDERS = Object.freeze({
  'openai-codex': 'ChatGPT (Codex)',
});
const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

class AgentProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentProviderError';
    this.code = code;
  }
}

function requireIdentifier(value, field) {
  const hasControlCharacter =
    typeof value === 'string' &&
    [...value].some((character) => {
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
    this.fetch = options.fetch || globalThis.fetch;
    this.catalog =
      options.catalog || new ProviderCatalog({ dataDir: this.dataDir, fetch: options.fetch });
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
      group: PROVIDER_DEFINITIONS[providerId].group,
      privacy: PROVIDER_DEFINITIONS[providerId].privacy,
      policies: PROVIDER_DEFINITIONS[providerId].policies || [],
      canRefresh: Boolean(PROVIDER_DEFINITIONS[providerId].catalogUrl),
      updatedAt: this.catalog.get(providerId).updatedAt || null,
      models: runtime
        .getModels(providerId)
        .filter(
          (model) =>
            !this.catalog.get(providerId).updatedAt ||
            this.catalog.get(providerId).models.some((item) => item.id === model.id)
        )
        .map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning === true,
          contextWindow: model.contextWindow,
          vision: model.input?.includes('image') === true,
          ...this.catalog.get(providerId).models.find((candidate) => candidate.id === model.id),
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
      input.apiKey.length > 16_384 ||
      (input.apiKey && input.apiKey !== input.apiKey.trim())
    ) {
      throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Provider API key is invalid');
    }
    const apiKey = input.apiKey || this.store.getSelection(providerId)?.apiKey;
    if (!apiKey)
      throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Provider API key is invalid');
    const runtime = await this.#createRuntime();
    if (!runtime.getModel(providerId, modelId)) {
      throw new AgentProviderError('AGENT_MODEL_INVALID', 'Selected model is not available');
    }
    const privacyPolicy = input.privacyPolicy;
    if (
      privacyPolicy !== undefined &&
      !(PROVIDER_DEFINITIONS[providerId].policies || [['standard']]).some(
        ([id]) => id === privacyPolicy
      )
    ) {
      throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Privacy policy is invalid');
    }
    this.#assertModelPolicy(providerId, modelId, privacyPolicy);
    this.store.saveHosted({
      providerId,
      modelId,
      apiKey,
      ...(privacyPolicy !== undefined && { privacyPolicy }),
    });
    return this.getStatus();
  }

  async configureOllama(input = {}, { activate = true } = {}) {
    const baseUrl = normalizeOllamaBaseUrl(input.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let modelIds;
    try {
      const response = await this.fetch(`${baseUrl.slice(0, -3)}/api/tags`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Ollama discovery failed');
      const maxBytes = 1024 * 1024;
      if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Response too large');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('Response too large');
        chunks.push(Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data.models)) throw new Error('Missing models');
      modelIds = [...new Set(data.models.map((model) => requireIdentifier(model?.name, 'model name')))];
      if (modelIds.length > 128) {
        throw new AgentProviderError('AGENT_OLLAMA_MODEL_LIMIT', 'Ollama model list exceeds the supported limit');
      }
    } catch (error) {
      if (error.code === 'AGENT_OLLAMA_MODEL_LIMIT') throw error;
      throw new AgentProviderError('AGENT_OLLAMA_DISCOVERY_FAILED', 'Could not discover Ollama models');
    } finally {
      controller.abort();
      clearTimeout(timeout);
    }
    if (!modelIds.length) {
      throw new AgentProviderError('AGENT_OLLAMA_NO_MODELS', 'No installed Ollama models');
    }
    const previous = this.getStatus().connections?.find((connection) => connection.providerId === 'ollama');
    const preferred = input.modelId || (previous?.baseUrl === baseUrl ? previous.modelId : undefined);
    const modelId = modelIds.includes(preferred) ? preferred : modelIds[0];
    this.store.saveOllama({ modelId, modelIds, baseUrl, activate });
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

  async selectModel(input = {}) {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    const modelId = requireIdentifier(input.modelId, 'modelId');
    const connection = this.getStatus().connections.find(
      (candidate) => candidate.providerId === providerId
    );
    if (!connection) {
      throw new AgentProviderError('AGENT_MODEL_INVALID', 'Selected model is not configured');
    }
    if (providerId !== 'ollama') {
      const runtime = await this.#createRuntime();
      if (!runtime.getModel(providerId, modelId)) {
        throw new AgentProviderError('AGENT_MODEL_INVALID', 'Selected model is not available');
      }
    }
    this.#assertModelPolicy(providerId, modelId);
    this.store.select(providerId, modelId);
    return this.getStatus();
  }

  removeProvider(input = {}) {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    this.store.remove(providerId);
    return this.getStatus();
  }

  clear() {
    this.store.clear();
    return this.getStatus();
  }

  async refreshModels(input = {}) {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    if (providerId === 'ollama') {
      const connection = this.getStatus().connections?.find((item) => item.providerId === 'ollama');
      if (!connection) throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Connect Ollama before refreshing models');
      await this.configureOllama({ baseUrl: connection.baseUrl }, { activate: false });
      return this.getCatalog();
    }
    let apiKey;
    if (input.apiKey !== undefined && input.apiKey !== '') {
      if (
        typeof input.apiKey !== 'string' ||
        input.apiKey.length > 16_384 ||
        input.apiKey !== input.apiKey.trim()
      ) {
        throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Provider API key is invalid');
      }
      apiKey = input.apiKey;
    } else if (PROVIDER_DEFINITIONS[providerId]?.catalogKey) {
      apiKey = this.store.getSelection(providerId)?.apiKey;
    }
    const runtime = await this.#createRuntime();
    const options = { knownModels: runtime.getModels(providerId) };
    if (providerId === 'openai-codex') {
      if (!this.store.getSelection(providerId)) throw new AgentProviderError('AGENT_CATALOG_KEY_REQUIRED', 'Connect ChatGPT first');
      // Resolve through the app-owned OAuth store so expired tokens are refreshed.
      let auth;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try { auth = await runtime.getAuth(providerId, { signal: controller.signal }); }
      catch { throw new AgentProviderError('AGENT_CATALOG_AUTH_FAILED', 'Could not resolve ChatGPT account'); }
      finally { clearTimeout(timeout); }
      apiKey = auth?.auth?.apiKey;
      try {
        const payload = JSON.parse(Buffer.from(apiKey.split('.')[1], 'base64url').toString('utf8'));
        options.accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id;
      } catch { /* Malformed credentials produce the same safe auth error. */ }
      if (!options.accountId) throw new AgentProviderError('AGENT_CATALOG_AUTH_FAILED', 'Could not resolve ChatGPT account');
    }
    await this.catalog.refresh(providerId, apiKey, options);
    return this.getCatalog();
  }

  setPreferences(input = {}) {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    const definition = PROVIDER_DEFINITIONS[providerId];
    const connection = this.getStatus().connections.find((item) => item.providerId === providerId);
    if (!definition || !connection)
      throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Provider is not connected');
    const patch = {};
    if (input.privacyPolicy !== undefined) {
      if (!(definition.policies || [['standard']]).some(([id]) => id === input.privacyPolicy)) {
        throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Privacy policy is invalid');
      }
      patch.privacyPolicy = input.privacyPolicy;
    }
    if (input.favoriteModelIds !== undefined) {
      if (!Array.isArray(input.favoriteModelIds) || input.favoriteModelIds.length > 128) {
        throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Favorites are invalid');
      }
      patch.favoriteModelIds = [
        ...new Set(input.favoriteModelIds.map((id) => requireIdentifier(id, 'modelId'))),
      ];
    }
    this.store.savePreferences(providerId, patch);
    return this.getStatus();
  }

  #assertModelPolicy(providerId, modelId, policy) {
    const connection = this.getStatus().connections.find((item) => item.providerId === providerId);
    const metadata = this.catalog.get(providerId).models.find((model) => model.id === modelId);
    const requirement = policy ?? connection?.privacyPolicy;
    const entry = this.catalog.get(providerId);
    if (
      (CUSTOM_PROVIDERS.has(providerId) || metadata || entry.updatedAt) &&
      !modelAllowed(metadata, requirement)
    ) {
      throw new AgentProviderError(
        'AGENT_MODEL_POLICY',
        'Model is unavailable or does not meet the selected privacy policy'
      );
    }
    if (
      ['private', 'tee'].includes(requirement) &&
      (!entry.updatedAt || Date.now() - entry.updatedAt > 86_400_000)
    ) {
      throw new AgentProviderError(
        'AGENT_CATALOG_EXPIRED',
        'Refresh the model catalog to check its privacy classification'
      );
    }
  }

  #enforceRequestPolicy(runtime, providerId) {
    if (!['openrouter', 'venice', 'near-ai', 'meta'].includes(providerId)) return;
    for (const method of ['stream', 'streamSimple']) {
      if (typeof runtime[method] !== 'function') continue;
      const original = runtime[method].bind(runtime);
      runtime[method] = (model, context, options = {}) =>
        original(model, context, {
          ...options,
          onPayload: async (payload, requestModel) => {
            const result = await options.onPayload?.(payload, requestModel);
            const connection = this.getStatus().connections.find(
              (item) => item.providerId === providerId
            );
            if (!connection || model.provider !== providerId)
              throw new AgentProviderError('AGENT_MODEL_POLICY', 'Provider connection changed');
            this.#assertModelPolicy(providerId, model.id);
            const body = { ...(result || payload), model: model.id };
            if (providerId === 'openrouter' && connection.privacyPolicy === 'zdr') {
              body.provider = {
                ...body.provider,
                zdr: true,
                data_collection: 'deny',
                require_parameters: true,
              };
              body.plugins = [];
              delete body.models;
              delete body.route;
            }
            if (providerId === 'venice')
              body.venice_parameters = {
                include_venice_system_prompt: false,
                enable_web_search: 'off',
                enable_web_scraping: false,
                enable_x_search: false,
              };
            return body;
          },
        });
    }
  }

  async testConnection(input = {}) {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    const modelId = requireIdentifier(input.modelId, 'modelId');
    const { model, modelRuntime } = await this.resolveModel({ providerId, modelId });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const startedAt = Date.now();
    try {
      const response = await modelRuntime.completeSimple(
        model,
        {
          messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
        },
        { signal: controller.signal, maxTokens: 32, maxRetries: 0, timeoutMs: 20_000 }
      );
      if (response.stopReason === 'length') {
        return { elapsedMs: Date.now() - startedAt, outcome: 'token_limit' };
      }
      if (
        ['error', 'aborted'].includes(response.stopReason) ||
        !response.content?.some((item) => item.type === 'text' && item.text.trim())
      ) {
        throw new AgentProviderError('AGENT_PROVIDER_TEST_FAILED', 'Test prompt failed');
      }
      return { elapsedMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timeout);
    }
  }

  async resolveModel(input) {
    const saved = this.store.getSelection(input?.providerId);
    const selection = saved && { ...saved, ...(input?.modelId && { modelId: input.modelId }) };
    if (!selection) {
      throw new AgentProviderError('AGENT_MODEL_UNAVAILABLE', 'No agent model is configured');
    }
    if (selection.kind === 'hosted' && !Object.hasOwn(HOSTED_PROVIDERS, selection.providerId)) {
      throw new AgentProviderError('AGENT_PROVIDER_INVALID', 'Hosted provider is not supported');
    }
    const runtime = await this.#createRuntime();
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
      if (!credential) {
        throw new AgentProviderError(
          'AGENT_CREDENTIAL_UNAVAILABLE',
          'The saved provider credential is unavailable'
        );
      }
      await runtime.refresh({ allowNetwork: false, providers: [selection.providerId] });
      if (!runtime.hasConfiguredAuth(selection.providerId)) {
        throw new AgentProviderError(
          'AGENT_PROVIDER_AUTH_UNAVAILABLE',
          'The model provider did not accept the saved credential'
        );
      }
    }
    const model = runtime.getModel(selection.providerId, selection.modelId);
    if (!model) {
      throw new AgentProviderError(
        'AGENT_MODEL_UNAVAILABLE',
        'Configured agent model is unavailable'
      );
    }
    this.#assertModelPolicy(selection.providerId, selection.modelId);
    this.#enforceRequestPolicy(runtime, selection.providerId);
    return {
      model,
      modelRuntime: runtime,
      thinkingLevel: selection.kind === 'subscription' || model.id === 'gpt-6-astra' ? 'medium' : 'off',
    };
  }

  async #createRuntime() {
    const sdk = await this.loadSdk();
    const runtime = await sdk.ModelRuntime.create({
      credentials: this.credentials,
      modelsPath: null,
      modelsStorePath: path.join(this.dataDir, 'pi-model-cache.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    for (const [providerId, definition] of Object.entries(PROVIDER_DEFINITIONS)) {
      const models = this.catalog.get(providerId).models;
      if (!models.length || (!CUSTOM_PROVIDERS.has(providerId) && !['openrouter', 'openai', 'openai-codex'].includes(providerId)))
        continue;
      runtime.registerProvider(providerId, {
        name: definition.name,
        baseUrl: definition.baseUrl,
        api: providerId === 'openai' ? 'openai-responses' : providerId === 'openai-codex' ? 'openai-codex-responses' : 'openai-completions',
        models: [...runtime.getModels(providerId).filter((model) =>
          ['openai', 'openai-codex'].includes(providerId) && !models.some((entry) => entry.id === model.id)), ...models.map((model) => {
          const bundled = runtime.getModel(providerId, model.id);
          return {
            ...runtimeModel(model),
            ...(['openai', 'openai-codex'].includes(providerId) && { compat: undefined }),
            ...(bundled && {
              compat: bundled.compat,
              api: bundled.api,
              thinkingLevelMap: bundled.thinkingLevelMap,
            }),
          };
        })],
      });
    }
    return runtime;
  }
}

module.exports = {
  HOSTED_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  OLLAMA_DEFAULT_BASE_URL,
  AgentProviderError,
  AgentProviderResolver,
  normalizeOllamaBaseUrl,
  requireIdentifier,
};
