'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// URLs and transport choices belong to Freedom, never to remote model metadata.
const PROVIDER_DEFINITIONS = Object.freeze({
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    catalogUrl: 'https://api.openai.com/v1/models',
    catalogKey: true,
    group: 'Model labs',
    privacy: 'Requests go to OpenAI under its API data policy.',
  },
  anthropic: {
    name: 'Anthropic',
    group: 'Model labs',
    privacy: 'Requests go to Anthropic under its API data policy.',
  },
  xai: {
    name: 'xAI (Grok)',
    group: 'Model labs',
    privacy:
      'Requests go to xAI. Standard API retention applies; this connection does not enable account-level zero retention.',
  },
  meta: {
    name: 'Meta (Muse)',
    group: 'Model labs',
    baseUrl: 'https://api.meta.ai/v1',
    privacy: 'Requests go to the Meta Model API under your developer account’s data policy.',
  },
  openrouter: {
    name: 'OpenRouter',
    group: 'Model marketplaces',
    baseUrl: 'https://openrouter.ai/api/v1',
    catalogUrl: 'https://openrouter.ai/api/v1/models',
    privacy:
      'Requests go through OpenRouter to an inference provider. Zero data retention restricts routing; it is a provider policy, not end-to-end encryption.',
    policies: [
      ['standard', 'Standard routing'],
      ['zdr', 'Require zero data retention'],
    ],
  },
  venice: {
    name: 'Venice',
    group: 'Model marketplaces',
    baseUrl: 'https://api.venice.ai/api/v1',
    catalogUrl: 'https://api.venice.ai/api/v1/models?type=text',
    catalogKey: true,
    privacy:
      'Privacy varies by model. Private and TEE labels are reported by Venice, not independently verified by Freedom. Provider search, scraping and added system prompts are disabled.',
    policies: [
      ['standard', 'All supported models'],
      ['private', 'Private or TEE models only'],
      ['tee', 'TEE models only'],
    ],
  },
  'near-ai': {
    name: 'NEAR AI',
    group: 'Model marketplaces',
    baseUrl: 'https://cloud-api.near.ai/v1',
    catalogUrl: 'https://cloud-api.near.ai/v1/model/list?limit=2000',
    privacy:
      'NEAR lists both TEE-hosted and external models. TEE labels are provider claims; Freedom does not independently verify attestation or enable end-to-end encryption.',
    policies: [
      ['standard', 'All supported models'],
      ['tee', 'TEE models only'],
    ],
  },
  'openai-codex': {
    name: 'OpenAI · ChatGPT',
    baseUrl: 'https://chatgpt.com/backend-api',
    // Catalog compatibility revision from OpenAI's Astra metadata (2026-09-17).
    // This is Codex's version namespace, not Pi's package version; originator stays pi.
    catalogUrl: 'https://chatgpt.com/backend-api/codex/models?client_version=0.153.0',
    catalogKey: true,
    group: 'Subscriptions',
    authType: 'subscription',
    privacy: 'Uses your ChatGPT subscription. Requests go to OpenAI.',
  },
  ollama: {
    name: 'Ollama (local)',
    group: 'On this device',
    authType: 'local',
    privacy: 'Model requests go only to your local Ollama server.',
  },
});
const CUSTOM_PROVIDERS = new Set(['meta', 'venice', 'near-ai']);
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 2000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function catalogError(code = 'AGENT_CATALOG_UNAVAILABLE') {
  return Object.assign(new Error('Model catalog could not be refreshed'), { code });
}

function text(value, max = 200) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    [...value].every((c) => c.codePointAt(0) > 31 && c.codePointAt(0) !== 127)
    ? value
    : null;
}

function positive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000_000 ? value : fallback;
}

function price(value, multiplier = 1) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value) * multiplier;
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000 ? number : null;
}

function decimalPrice(value) {
  if (
    value?.currency !== 'USD' ||
    !Number.isInteger(value.scale) ||
    value.scale < 0 ||
    value.scale > 18
  )
    return null;
  return price(value.amount, 1_000_000 / 10 ** value.scale);
}

// Maintained fallback from OpenAI's model documentation and Codex models.json.
// Account discovery remains authoritative; this is not an entitlement assertion.
const ASTRA = Object.freeze({
  id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 1_050_000, maxTokens: 128_000,
  reasoning: true, vision: true, tools: true, available: true, privacy: 'standard',
});

function normalizeModels(providerId, body, knownModels = []) {
  const entries = ['near-ai', 'openai-codex'].includes(providerId) ? body?.models : body?.data;
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > MAX_MODELS ||
    (providerId === 'near-ai' && body.total > entries.length)
  )
    throw catalogError();
  const seen = new Set();
  const models = [];
  for (const item of entries) {
    const id = text(item?.id ?? item?.modelId ?? item?.slug);
    if (!id || seen.has(id)) continue;
    const spec = item.model_spec || {};
    const metadata = item.metadata || {};
    const capabilities = spec.capabilities || {};
    let model;
    if (providerId === 'openai' || providerId === 'openai-codex') {
      const known = knownModels.find((candidate) => candidate.id === id) || (id === ASTRA.id ? { ...ASTRA, ...(providerId === 'openai-codex' && { contextWindow: 272_000 }) } : null);
      // /v1/models contains audio, image, embedding and other non-agent products.
      // Unknown API capabilities must not be invented from a model's name.
      if (providerId === 'openai' && !known) continue;
      if (providerId === 'openai-codex' && item.visibility !== 'list') continue;
      model = {
        id, name: text(item.display_name) || known?.name || id,
        contextWindow: positive(item.context_window, known?.contextWindow || 32_768),
        maxTokens: positive(known?.maxTokens, 8192),
        reasoning: Array.isArray(item.supported_reasoning_levels)
          ? item.supported_reasoning_levels.some((level) => level.effort !== 'none') : known?.reasoning === true,
        vision: Array.isArray(item.input_modalities) ? item.input_modalities.includes('image') : known?.vision === true || known?.input?.includes('image') === true,
        tools: true, available: true, privacy: 'standard', inputPrice: null, outputPrice: null,
      };
    } else if (providerId === 'venice') {
      if (item.type !== 'text') continue;
      const privacy = ['private', 'tee', 'e2ee', 'anonymized'].includes(spec.privacy)
        ? spec.privacy
        : 'unknown';
      model = {
        id,
        name: text(spec.name) || id,
        contextWindow: positive(spec.availableContextTokens, 32_768),
        reasoning: capabilities.supportsReasoning === true,
        vision: capabilities.supportsVision === true,
        tools:
          typeof capabilities.supportsFunctionCalling === 'boolean'
            ? capabilities.supportsFunctionCalling
            : null,
        privacy,
        // E2EE requires a distinct, verified client protocol. Never downgrade it to plaintext.
        available: spec.offline !== true && privacy !== 'e2ee',
        inputPrice: price(spec.pricing?.input?.usd),
        outputPrice: price(spec.pricing?.output?.usd),
      };
    } else if (providerId === 'near-ai') {
      const output = metadata.architecture?.outputModalities;
      if (Array.isArray(output) && !output.includes('text')) continue;
      const features = metadata.supportedFeatures;
      model = {
        id,
        name: text(metadata.modelDisplayName) || id,
        contextWindow: positive(metadata.contextLength, 32_768),
        maxTokens: positive(metadata.maxOutputLength, 8192),
        tools:
          Array.isArray(features) && features.length
            ? features.includes('tools') || features.includes('tool_calling')
            : null,
        reasoning: Array.isArray(features) && features.includes('reasoning'),
        vision: metadata.architecture?.inputModalities?.includes('image') === true,
        privacy:
          metadata.providerType === 'vllm' &&
          metadata.verifiable === true &&
          metadata.attestationSupported === true
            ? 'tee'
            : 'external',
        available: metadata.isReady !== false,
        inputPrice: decimalPrice(item.inputCostPerToken),
        outputPrice: decimalPrice(item.outputCostPerToken),
      };
    } else if (providerId === 'openrouter') {
      if (
        item.architecture?.output_modalities &&
        !item.architecture.output_modalities.includes('text')
      )
        continue;
      model = {
        id,
        name: text(item.name) || id,
        contextWindow: positive(item.context_length, 32_768),
        maxTokens: positive(item.top_provider?.max_completion_tokens, 8192),
        tools: Array.isArray(item.supported_parameters)
          ? item.supported_parameters.includes('tools')
          : null,
        reasoning: item.supported_parameters?.includes('reasoning') === true,
        vision: item.architecture?.input_modalities?.includes('image') === true,
        privacy: 'routing',
        available: true,
        inputPrice: price(item.pricing?.prompt, 1_000_000),
        outputPrice: price(item.pricing?.completion, 1_000_000),
      };
    } else throw catalogError();
    model.maxTokens = Math.min(positive(model.maxTokens, 8192), model.contextWindow);
    seen.add(id);
    models.push(model);
  }
  if (!models.length) throw catalogError();
  return models;
}

function modelAllowed(model, policy = 'standard') {
  return (
    Boolean(model) &&
    model.available !== false &&
    model.tools !== false &&
    (policy !== 'private' || ['private', 'tee'].includes(model.privacy)) &&
    (policy !== 'tee' || model.privacy === 'tee')
  );
}

function runtimeModel(model) {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning === true,
    input: model.vision ? ['text', 'image'] : ['text'],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { ...ZERO_COST, input: model.inputPrice ?? 0, output: model.outputPrice ?? 0 },
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    },
  };
}

class ProviderCatalog {
  constructor({ dataDir, fetch: fetchImpl = globalThis.fetch }) {
    this.filePath = path.join(dataDir, 'provider-catalog.json');
    this.fetch = fetchImpl;
    this.entries = {};
    try {
      const stat = fs.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return;
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [id, entry] of Object.entries(saved)) {
        if (!PROVIDER_DEFINITIONS[id]?.catalogUrl || !Number.isFinite(entry.updatedAt)) continue;
        // Re-normalize the allowlisted cache instead of trusting stored URLs/options.
        const models = entry.models;
        if (!Array.isArray(models) || !models.length || models.length > MAX_MODELS) continue;
        if (
          !models.every(
            (m) =>
              text(m.id) &&
              text(m.name) &&
              positive(m.contextWindow) &&
              positive(m.maxTokens) &&
              typeof m.available === 'boolean' &&
              ['unknown', 'private', 'tee', 'e2ee', 'anonymized', 'external', 'routing', 'standard'].includes(
                m.privacy
              )
          )
        )
          continue;
        this.entries[id] = {
          updatedAt: entry.updatedAt,
          models: models.map((m) => ({
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            available: m.available && m.privacy !== 'e2ee',
            privacy: m.privacy,
            tools: typeof m.tools === 'boolean' ? m.tools : null,
            reasoning: m.reasoning === true,
            vision: m.vision === true,
            inputPrice: price(m.inputPrice),
            outputPrice: price(m.outputPrice),
          })),
        };
      }
    } catch {
      /* A missing or invalid cache never prevents bundled models from loading. */
    }
  }

  get(providerId) {
    if (providerId === 'meta')
      return {
        models: [
          {
            id: 'muse-spark-1.3',
            name: 'Muse Spark 1.3',
            contextWindow: 1_048_576,
            maxTokens: 8192,
            reasoning: true,
            vision: true,
            tools: true,
            available: true,
            privacy: 'standard',
          },
        ],
      };
    return this.entries[providerId] || { models: ['openai', 'openai-codex'].includes(providerId) ? [{ ...ASTRA, ...(providerId === 'openai-codex' && { contextWindow: 272_000 }) }] : [] };
  }

  async refresh(providerId, apiKey, options = {}) {
    const definition = PROVIDER_DEFINITIONS[providerId];
    if (!definition?.catalogUrl) throw catalogError();
    if (definition.catalogKey && !apiKey) throw catalogError('AGENT_CATALOG_KEY_REQUIRED');
    if (providerId === 'openai-codex' && !text(options.accountId)) throw catalogError('AGENT_CATALOG_AUTH_FAILED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetch(definition.catalogUrl, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(definition.catalogKey && { Authorization: `Bearer ${apiKey}` }),
          ...(providerId === 'openai-codex' && { originator: 'pi', 'ChatGPT-Account-ID': options.accountId }),
        },
      });
      if (!response.ok)
        throw catalogError(
          response.status === 401 || response.status === 403
            ? 'AGENT_CATALOG_AUTH_FAILED'
            : undefined
        );
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw catalogError();
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) {
          controller.abort();
          throw catalogError();
        }
        chunks.push(Buffer.from(chunk));
      }
      const models = normalizeModels(
        providerId,
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        options.knownModels
      );
      const entry = { models, updatedAt: Date.now() };
      const entries = { ...this.entries, [providerId]: entry };
      const encoded = JSON.stringify(entries);
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw catalogError();
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      // Publish only complete snapshots. Renaming replaces a symlink rather than following it.
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      const fd = fs.openSync(temporaryPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, encoded);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporaryPath, this.filePath);
      this.entries = entries;
      return entry;
    } catch (error) {
      if (error?.code?.startsWith('AGENT_CATALOG_')) throw error;
      throw catalogError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  PROVIDER_DEFINITIONS,
  CUSTOM_PROVIDERS,
  ProviderCatalog,
  normalizeModels,
  runtimeModel,
  modelAllowed,
};
