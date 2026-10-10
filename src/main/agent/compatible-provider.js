'use strict';

const { randomUUID } = require('crypto');
const isCompatibleId = id => /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id || '');
const failure = (code = 'AGENT_PROVIDER_INVALID') => Object.assign(new Error('Check the custom connection URL, models and credentials.'), { code });
function cleanText(value, max = 200) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && [...value].every(c => c.codePointAt(0) > 31 && c.codePointAt(0) !== 127);
}
function normalizeCompatibleUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 2048) throw failure();
  return url.href.replace(/\/+$/, '');
}
function normalizeCompatibleModels(input) {
  if (!Array.isArray(input) || !input.length || input.length > 128) throw failure();
  const ids = new Set();
  return input.map(item => {
    if (!cleanText(item?.id) || ids.has(item.id)) throw failure();
    ids.add(item.id);
    const contextWindow = item.contextWindow ?? 32768, maxTokens = item.maxTokens ?? 4096;
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10_000_000 ||
        !Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens > contextWindow) throw failure();
    return { id: item.id, name: cleanText(item.name) ? item.name : item.id, contextWindow, maxTokens,
      vision: item.vision === true, reasoning: item.reasoning === true, jsonSchema: item.jsonSchema === true };
  });
}
function isStoredCompatible(connection) {
  try {
    return isCompatibleId(connection.providerId) && cleanText(connection.name, 80) &&
      normalizeCompatibleUrl(connection.baseUrl) === connection.baseUrl &&
      normalizeCompatibleModels(connection.models).some(m => m.id === connection.modelId) &&
      (connection.encryptedApiKey === undefined || (typeof connection.encryptedApiKey === 'string' && connection.encryptedApiKey.length > 0 && connection.encryptedApiKey.length < 128 * 1024));
  } catch { return false; }
}
function compatibleFetch(baseUrl, apiKey, fetchImpl) {
  const allowed = new Set([`${baseUrl}/models`, `${baseUrl}/chat/completions`]);
  return (input, options = {}) => {
    if (!allowed.has(String(input))) throw failure();
    const headers = new Headers(options.headers);
    headers.delete('authorization');
    if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    // Restrict both request destination and redirects, including with Pi's SDK.
    return fetchImpl(input, { ...options, headers, redirect: 'error' });
  };
}
async function discoverCompatibleModels(baseUrl, apiKey, fetchImpl) {
  try {
    const response = await compatibleFetch(baseUrl, apiKey, fetchImpl)(`${baseUrl}/models`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw failure();
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) throw failure();
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(body.data)) throw failure();
    return normalizeCompatibleModels(body.data.map(item => ({ id: item.id })));
  } catch { throw failure('AGENT_CUSTOM_DISCOVERY_FAILED'); }
}
async function resolveCompatible(selection, runtime, fetchImpl, getSelection = () => selection) {
  const baseUrl = normalizeCompatibleUrl(selection.baseUrl);
  const models = normalizeCompatibleModels(selection.models);
  runtime.registerProvider(selection.providerId, { name: selection.name, baseUrl, api: 'openai-completions',
    models: models.map(m => ({ ...m, input: m.vision ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' } })) });
  // Pi requires configured auth. The placeholder is removed by the fetch wrapper.
  await runtime.setRuntimeApiKey(selection.providerId, selection.apiKey || 'freedom-no-auth');
  const model = runtime.getModel(selection.providerId, selection.modelId);
  if (!model) throw failure('AGENT_MODEL_INVALID');
  runtime.supportsClassifierSchema = m => m.provider === selection.providerId && models.some(entry => entry.id === m.id && entry.jsonSchema);
  runtime.privacyDescriptor = () => ({ providerId: selection.providerId, providerName: selection.name, claim: 'unknown', e2ee: false, attestation: false });
  for (const method of ['stream', 'streamSimple', 'complete', 'completeSimple']) {
    const original = runtime[method].bind(runtime);
    runtime[method] = (m, context, options = {}) => {
      if (m.provider !== selection.providerId || m.baseUrl !== baseUrl) throw failure();
      return original(m, context, { ...options, fetch: (input, init) => {
        const current = getSelection();
        if (current?.kind !== 'compatible' || current.baseUrl !== baseUrl || !current.models.some(entry => entry.id === m.id)) throw failure('AGENT_MODEL_UNAVAILABLE');
        return compatibleFetch(baseUrl, current.apiKey, options.fetch || fetchImpl)(input, init);
      } });
    };
  }
  return { model, modelRuntime: runtime, thinkingLevel: 'off' };
}
async function testCompatibleConnection(model, runtime, signal) {
  const nonce = randomUUID();
  const tools = [{ name: 'connection_probe', description: 'Return a synthetic test value. No external effects.',
    parameters: { type: 'object', properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'], additionalProperties: false } }];
  const context = { messages: [{ role: 'user', content: `Call connection_probe with nonce ${nonce}. Then reply with its returned value.`, timestamp: Date.now() }], tools };
  const options = { signal, maxTokens: Math.min(2048, model.maxTokens), maxRetries: 0 };
  const first = await runtime.completeSimple(model, context, options);
  const call = first.content?.find(c => c.type === 'toolCall');
  if (first.stopReason !== 'toolUse' || call?.name !== 'connection_probe' || call.arguments?.nonce !== nonce || first.content.filter(c => c.type === 'toolCall').length !== 1) throw failure('AGENT_CUSTOM_TOOLS_FAILED');
  const value = randomUUID();
  const second = await runtime.completeSimple(model, { ...context, messages: [...context.messages, first,
    { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: value }], isError: false, timestamp: Date.now() }] }, options);
  if (second.stopReason !== 'stop' || !second.content?.some(c => c.type === 'text' && c.text.includes(value))) throw failure('AGENT_CUSTOM_TOOLS_FAILED');
}
module.exports = { isCompatibleId, cleanText, normalizeCompatibleUrl, normalizeCompatibleModels, isStoredCompatible,
  compatibleFetch, discoverCompatibleModels, resolveCompatible, testCompatibleConnection };
