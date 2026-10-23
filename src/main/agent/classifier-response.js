'use strict';

const log = require('../logger');
const { runIsolatedPiTextRequest } = require('./pi-session-factory');
const FAILURE_REASONS = new Set([
  'classifier_cancelled', 'classifier_timeout', 'classifier_session_unavailable',
  'classifier_provider_error', 'classifier_empty_output', 'classifier_invalid_json',
  'classifier_invalid_schema', 'classifier_output_too_large',
  'classifier_truncated_output', 'classifier_unexpected_tool', 'invalid_classifier_output',
]);

function parseClassifierObject(text, maxBytes) {
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  if (typeof text !== 'string') fail('classifier_empty_output');
  if (Buffer.byteLength(text) > maxBytes) fail('classifier_output_too_large');
  let source = text.trim();
  if (!source) fail('classifier_empty_output');
  // Only a single whole-response fence is presentation. Never extract a JSON
  // substring from prose, strip reasoning, repair syntax, or choose an object.
  const fence = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
  if (fence && !fence[1].includes('```')) source = fence[1];
  let parsed;
  try { parsed = JSON.parse(source); }
  catch { fail('classifier_invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('classifier_invalid_schema');
  return parsed;
}

function classifierSchema(key, values, lists) {
  const properties = {
    [key]: { type: 'string', enum: values },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
  };
  for (const name of lists) properties[name] = { type: 'array', items: { type: 'string' } };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function validClassifierFields(parsed, schema) {
  return Object.keys(parsed).every(key => Object.hasOwn(schema.properties, key)) &&
    schema.required.every(key => {
      const value = parsed[key], spec = schema.properties[key];
      if (spec.enum) return spec.enum.includes(value);
      if (spec.type === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
      if (spec.type === 'array') return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim());
      return typeof value === 'string' && Boolean(value.trim());
    });
}

function structuredClassifierRuntime(runtime, model, schema) {
  if (model.api !== 'openai-completions' || runtime.supportsClassifierSchema?.(model) !== true) return runtime;
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'streamSimple') return (requestModel, context, options = {}) => target.streamSimple(requestModel, context, {
        ...options,
        onPayload: async (payload, selectedModel) => {
          const body = { ...(await options.onPayload?.(payload, selectedModel) || payload),
            response_format: { type: 'json_schema', json_schema: { name: 'freedom_classification', strict: true, schema } },
          };
          if (requestModel.provider === 'openrouter') body.provider = { ...body.provider, require_parameters: true };
          return body;
        },
      });
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runClassification({ schema, parse, fallback, ...options }) {
  const deadline = Date.now() + options.timeoutMs;
  const original = options.sessionOptions;
  const modelRuntime = structuredClassifierRuntime(original.modelRuntime, original.model, schema);
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (options.signal?.aborted) return fallback('classifier_cancelled');
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fallback('classifier_timeout');
    const result = await runIsolatedPiTextRequest({ ...options,
      timeoutMs: remaining,
      sessionOptions: { ...original, modelRuntime },
      prompt: options.prompt + (attempt === 2
        ? '\n\nReturn only the complete JSON object specified by the system instructions. Include every required field with its specified type. Do not include Markdown or commentary.' : ''),
    });
    const classification = result.reason ? fallback(result.reason) : parse(result.output);
    const reason = classification.uncertainties[0];
    // These are internal fallback results, never retry an actual model judgment.
    const failed = FAILURE_REASONS.has(reason) && classification.confidence === 0 &&
      classification.summary === fallback().summary;
    if (!failed) return classification;
    try {
      // Metadata only: never persist prompts, page text, raw replies, or provider errors.
      log.warn('[AgentClassifier]', {
        provider: String(original.model.provider || '').slice(0, 120),
        model: String(original.model.id || '').slice(0, 200),
        attempt, reason, outputBytes: Buffer.byteLength(result.output || ''),
        fenced: typeof result.output === 'string' && result.output.trim().startsWith('```'),
      });
    } catch { /* Diagnostic failures must not change the permission decision. */ }
    if (attempt === 2 || !['classifier_empty_output', 'classifier_invalid_json', 'classifier_invalid_schema'].includes(reason)) return classification;
  }
}

module.exports = { parseClassifierObject, classifierSchema, validClassifierFields, runClassification, structuredClassifierRuntime };
