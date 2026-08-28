'use strict';

const { OPERATIONS, MAX_NODE_RESPONSE_BYTES } = require('./automation/contract/operations');
const { AutomationError, ERROR_CODES } = require('./automation/contract/errors');
const { EFFECTS, decideEffectPolicy, unknownClassification } = require('./agent/effect-classifier');

const DEFAULT_TIMEOUT_MS = 10_000;
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'location',
  'swarm-blocklist',
  'swarm-feed-index',
  'swarm-tag',
]);

function defaultGetAntApiUrl() {
  return require('./service-registry').getAntApiUrl();
}

function minimumEffectForMethod(method) {
  if (method === 'GET' || method === 'HEAD') return EFFECTS.READ;
  if (method === 'DELETE') return EFFECTS.DESTRUCTIVE;
  return EFFECTS.REVERSIBLE_ADMIN;
}

function approved(decision) {
  return (
    decision === true ||
    decision === 'approved' ||
    (decision && typeof decision === 'object' && decision.status === 'approved')
  );
}

function fixedEndpoint(base, path) {
  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new AutomationError(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      'The Ant node API endpoint is unavailable'
    );
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new AutomationError(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      'The Ant node API endpoint is unavailable'
    );
  }
  const target = new URL(path, `${baseUrl.origin}/`);
  if (target.origin !== baseUrl.origin) {
    throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'Node requests cannot change host');
  }
  return target;
}

async function readBoundedResponse(response, maxBytes = MAX_NODE_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AutomationError(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      `Node response exceeds the ${maxBytes}-byte limit`
    );
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Node response exceeds the ${maxBytes}-byte limit`
      );
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AutomationError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          `Node response exceeds the ${maxBytes}-byte limit`
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function safeResponseHeaders(headers) {
  const result = {};
  if (!headers || typeof headers.entries !== 'function') return result;
  for (const [name, value] of headers.entries()) {
    if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) result[name.toLowerCase()] = value;
  }
  return result;
}

class NodeRequestController {
  constructor(options = {}) {
    this.getAntApiUrl = options.getAntApiUrl || defaultGetAntApiUrl;
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = Number.isFinite(options.maxResponseBytes)
      ? Math.max(1, options.maxResponseBytes)
      : MAX_NODE_RESPONSE_BYTES;
    if (typeof this.fetch !== 'function') {
      throw new TypeError('Node requests require an HTTP transport');
    }
  }

  async request(input, context = {}) {
    const endpoint = this.getAntApiUrl();
    if (!endpoint) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'The Ant node API is not currently available'
      );
    }
    const target = fixedEndpoint(endpoint, input.request.path);
    const classification =
      typeof context.classifyEffect === 'function'
        ? await context.classifyEffect({
            domain: 'node',
            action: {
              service: input.service,
              transport: input.transport,
              request: input.request,
            },
            trustedContext: {
              endpointAuthority: 'Freedom service registry',
              wireProtocol: 'Bee HTTP API',
            },
          })
        : unknownClassification('classifier_unavailable');
    const policy = decideEffectPolicy(classification, {
      minimumEffect: minimumEffectForMethod(input.request.method),
    });
    if (policy.decision === 'approval') {
      if (typeof context.requestApproval !== 'function') {
        throw new AutomationError(
          ERROR_CODES.APPROVAL_REQUIRED,
          'This node request requires user approval'
        );
      }
      const decision = await context.requestApproval({
        action: 'node_request',
        operation: OPERATIONS.NODE_REQUEST,
        label: `${input.request.method} ${input.request.path}`,
        nodeRequest: {
          service: input.service,
          transport: input.transport,
          request: input.request,
          effect: policy.effect,
          classification: policy.classification,
        },
      });
      if (!approved(decision)) {
        throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The user declined the node request');
      }
    }

    const abortController = new AbortController();
    const abortFromCaller = () => abortController.abort();
    if (context.signal?.aborted) abortFromCaller();
    context.signal?.addEventListener?.('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    let response;
    let body;
    try {
      response = await this.fetch(target, {
        method: input.request.method,
        headers: input.request.headers,
        ...(input.request.body !== undefined && { body: input.request.body }),
        redirect: 'error',
        signal: abortController.signal,
      });
      body =
        input.request.method === 'HEAD'
          ? ''
          : await readBoundedResponse(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof AutomationError) throw error;
      if (context.signal?.aborted) {
        throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The node request was cancelled');
      }
      throw new AutomationError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'The Ant node request failed', {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener?.('abort', abortFromCaller);
    }
    const bytes = Buffer.byteLength(body, 'utf8');
    return Object.freeze({
      service: input.service,
      transport: input.transport,
      effect: policy.effect,
      request: Object.freeze({ method: input.request.method, path: input.request.path }),
      response: Object.freeze({
        status: response.status,
        statusText: response.statusText || '',
        headers: Object.freeze(safeResponseHeaders(response.headers)),
        body,
        bytes,
      }),
      summary: Object.freeze({
        service: input.service,
        effect: policy.effect,
        method: input.request.method,
        path: input.request.path,
        status: response.status,
        bytes,
      }),
    });
  }
}

module.exports = {
  NodeRequestController,
  fixedEndpoint,
  minimumEffectForMethod,
  readBoundedResponse,
  safeResponseHeaders,
};
