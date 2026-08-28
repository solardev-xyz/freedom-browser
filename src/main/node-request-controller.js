'use strict';

const crypto = require('crypto');
const { OPERATIONS, MAX_NODE_RESPONSE_BYTES } = require('./automation/contract/operations');
const { AutomationError, ERROR_CODES } = require('./automation/contract/errors');
const { EFFECTS, decideEffectPolicy, unknownClassification } = require('./agent/effect-classifier');
const { OPERATION_STATES } = require('./agent/node-operation-store');

const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 10_000;
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 300_000;
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

function defaultGetRadicleApiUrl() {
  return require('./service-registry').getRadicleApiUrl();
}

function defaultServeIpfsRequest(request) {
  return require('./ipfs-manager').serveNativeGatewayRequest(request);
}

const SERVICE_PROTOCOLS = Object.freeze({
  ant: Object.freeze({ transport: 'http', wireProtocol: 'Bee HTTP API' }),
  radicle: Object.freeze({ transport: 'http', wireProtocol: 'radicle-httpd HTTP API' }),
  ipfs: Object.freeze({ transport: 'gateway', wireProtocol: 'Freedom IPFS native gateway' }),
});

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

function opaqueOperationId() {
  return `node_op_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function observeOperation(promise, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      resolve(result);
    };
    const handleAbort = () => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      finish({ kind: 'aborted' });
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
    promise.then(finish, (error) => finish({ kind: 'error', error }));
  });
}

class MemoryNodeOperationStore {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.operations = new Map();
  }

  create(entry) {
    const operation = {
      ...entry,
      state: OPERATION_STATES.NOT_DISPATCHED,
      createdAt: entry.createdAt || this.now(),
      updatedAt: entry.createdAt || this.now(),
    };
    this.operations.set(entry.operationId, operation);
    return Object.freeze({ ...operation });
  }

  markInFlight(operationId) {
    return this.#update(operationId, {
      state: OPERATION_STATES.IN_FLIGHT,
      error: undefined,
    });
  }

  markResponded(operationId, response) {
    return this.#update(operationId, {
      state: OPERATION_STATES.RESPONDED,
      response,
      error: undefined,
    });
  }

  markDeliveryUncertain(operationId, error) {
    return this.#update(operationId, {
      state: OPERATION_STATES.DELIVERY_UNCERTAIN,
      error,
    });
  }

  get(operationId, ownerId) {
    const operation = this.operations.get(operationId);
    return operation?.ownerId === ownerId ? Object.freeze({ ...operation }) : null;
  }

  getAny(operationId) {
    const operation = this.operations.get(operationId);
    return operation ? Object.freeze({ ...operation }) : null;
  }

  listRecent(ownerId, limit = 20) {
    return [...this.operations.values()]
      .filter((operation) => operation.ownerId === ownerId)
      .sort((first, second) => second.updatedAt - first.updatedAt)
      .slice(0, limit)
      .map((operation) => Object.freeze({ ...operation }));
  }

  #update(operationId, changes) {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    const updated = { ...operation, ...changes, updatedAt: this.now() };
    this.operations.set(operationId, updated);
    return Object.freeze({ ...updated });
  }
}

function fixedEndpoint(base, path, service = 'node') {
  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new AutomationError(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      `The ${service} node API endpoint is unavailable`
    );
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new AutomationError(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      `The ${service} node API endpoint is unavailable`
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
    this.getRadicleApiUrl = options.getRadicleApiUrl || defaultGetRadicleApiUrl;
    this.serveIpfsRequest = options.serveIpfsRequest || defaultServeIpfsRequest;
    this.fetch = options.fetch || globalThis.fetch;
    const legacyTimeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : null;
    this.readTimeoutMs = Number.isFinite(options.readTimeoutMs)
      ? Math.max(1, options.readTimeoutMs)
      : legacyTimeoutMs || DEFAULT_READ_TIMEOUT_MS;
    this.interactiveTimeoutMs = Number.isFinite(options.interactiveTimeoutMs)
      ? Math.max(1, options.interactiveTimeoutMs)
      : legacyTimeoutMs || DEFAULT_INTERACTIVE_TIMEOUT_MS;
    this.mutationTimeoutMs = Number.isFinite(options.mutationTimeoutMs)
      ? Math.max(1, options.mutationTimeoutMs)
      : DEFAULT_MUTATION_TIMEOUT_MS;
    this.statusWaitTimeoutMs = Number.isFinite(options.statusWaitTimeoutMs)
      ? Math.max(1, options.statusWaitTimeoutMs)
      : DEFAULT_STATUS_WAIT_TIMEOUT_MS;
    this.maxResponseBytes = Number.isFinite(options.maxResponseBytes)
      ? Math.max(1, options.maxResponseBytes)
      : MAX_NODE_RESPONSE_BYTES;
    this.operationStore = options.operationStore || new MemoryNodeOperationStore(options);
    this.operationIdFactory = options.operationIdFactory || opaqueOperationId;
    this.activeOperations = new Map();
    this.disposed = false;
    if (typeof this.fetch !== 'function') {
      throw new TypeError('Node requests require an HTTP transport');
    }
  }

  async request(input, context = {}) {
    const protocol = SERVICE_PROTOCOLS[input.service];
    if (!protocol || protocol.transport !== input.transport) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'This node request transport is unavailable'
      );
    }
    if (input.service !== 'ipfs') this.#httpEndpointFor(input.service);
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
              endpointAuthority:
                input.service === 'ipfs'
                  ? 'Freedom-managed native node instance'
                  : 'Freedom service registry',
              wireProtocol: protocol.wireProtocol,
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

    if (this.disposed) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Direct node requests are shutting down'
      );
    }
    if (context.signal?.aborted) {
      throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The node request was cancelled');
    }

    const ownerId =
      typeof context.conversationId === 'string' && context.conversationId
        ? context.conversationId
        : 'local';
    const operationId = this.operationIdFactory();
    const bodySha256 =
      input.request.body === undefined
        ? null
        : crypto.createHash('sha256').update(input.request.body).digest('hex');
    this.operationStore.create({
      operationId,
      ownerId,
      service: input.service,
      transport: input.transport,
      effect: policy.effect,
      request: {
        method: input.request.method,
        path: input.request.path,
        headerNames: Object.keys(input.request.headers || {}).sort(),
        ...(bodySha256 && { bodySha256 }),
      },
    });
    this.operationStore.markInFlight(operationId);

    const stateChanging = policy.effect !== EFFECTS.READ;
    const active = this.#beginOperation(input, operationId, {
      stateChanging,
      timeoutMs: stateChanging ? this.mutationTimeoutMs : this.readTimeoutMs,
    });
    this.activeOperations.set(operationId, active);
    void active.promise.finally(() => this.activeOperations.delete(operationId));

    const observed = await observeOperation(
      active.promise,
      stateChanging ? this.interactiveTimeoutMs : this.readTimeoutMs,
      context.signal
    );
    if (observed.kind === 'result') return observed.value;
    if (observed.kind === 'error') throw observed.error;

    if (stateChanging) {
      return this.#operationResult(this.operationStore.getAny(operationId));
    }

    active.abort(observed.kind === 'aborted' ? 'caller' : 'deadline');
    const settled = await active.promise;
    if (settled.kind === 'result') return settled.value;
    throw settled.error;
  }

  async status(input, context = {}) {
    const ownerId =
      typeof context.conversationId === 'string' && context.conversationId
        ? context.conversationId
        : 'local';
    if (!input.operationId) {
      const operations = this.operationStore.listRecent(ownerId, 20);
      return Object.freeze({
        operations: Object.freeze(operations.map((operation) => this.#operationSummary(operation))),
        summary: Object.freeze({
          count: operations.length,
          inFlight: operations.filter((operation) => operation.state === OPERATION_STATES.IN_FLIGHT)
            .length,
          uncertain: operations.filter(
            (operation) => operation.state === OPERATION_STATES.DELIVERY_UNCERTAIN
          ).length,
        }),
      });
    }
    const operation = this.operationStore.get(input.operationId, ownerId);
    if (!operation) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'This node operation is unavailable in the current conversation'
      );
    }
    const active = this.activeOperations.get(input.operationId);
    if (operation.state === OPERATION_STATES.IN_FLIGHT && active) {
      await observeOperation(active.promise, this.statusWaitTimeoutMs);
    }
    return this.#operationResult(this.operationStore.get(input.operationId, ownerId));
  }

  async dispose() {
    this.disposed = true;
    const active = [...this.activeOperations.values()];
    for (const operation of active) operation.abort('shutdown');
    await Promise.allSettled(active.map((operation) => operation.promise));
    this.activeOperations.clear();
  }

  #beginOperation(input, operationId, options) {
    const abortController = new AbortController();
    let abortReason = null;
    const abort = (reason) => {
      if (abortController.signal.aborted) return;
      abortReason = reason;
      abortController.abort();
    };
    const timeout = setTimeout(() => abort('deadline'), options.timeoutMs);
    timeout.unref?.();
    const promise = (async () => {
      try {
        const response = await this.#dispatch(input, abortController.signal);
        const body =
          input.request.method === 'HEAD'
            ? ''
            : await readBoundedResponse(response, this.maxResponseBytes);
        const normalizedResponse = Object.freeze({
          status: response.status,
          statusText: response.statusText || '',
          headers: Object.freeze(safeResponseHeaders(response.headers)),
          body,
          bytes: Buffer.byteLength(body, 'utf8'),
        });
        const operation = this.operationStore.markResponded(operationId, normalizedResponse);
        return { kind: 'result', value: this.#operationResult(operation) };
      } catch (error) {
        if (options.stateChanging) {
          const operation = this.operationStore.markDeliveryUncertain(operationId, {
            code: 'NODE_DELIVERY_UNCERTAIN',
            message:
              abortReason === 'shutdown'
                ? 'Freedom shut down before the node response was received'
                : abortReason === 'deadline'
                  ? 'Freedom reached its background deadline before the node responded'
                  : 'Freedom lost observability after attempting to dispatch the node request',
          });
          return { kind: 'result', value: this.#operationResult(operation) };
        }
        this.operationStore.markDeliveryUncertain(operationId, {
          code: 'NODE_RESPONSE_UNAVAILABLE',
          message: 'Freedom did not receive a complete response from the node',
        });
        const normalizedError =
          abortReason === 'caller'
            ? new AutomationError(ERROR_CODES.USER_CANCELLED, 'The node request was cancelled')
            : error instanceof AutomationError
              ? error
              : new AutomationError(
                  ERROR_CODES.CAPABILITY_UNAVAILABLE,
                  `The ${input.service} node request failed`,
                  { cause: error }
                );
        return { kind: 'error', error: normalizedError };
      } finally {
        clearTimeout(timeout);
      }
    })();
    return { promise, abort };
  }

  #operationResult(operation) {
    const retrySafety = operation.effect === EFFECTS.READ ? 'safe' : 'unsafe';
    const publicOperation = Object.freeze({
      operationId: operation.operationId,
      state: operation.state,
      retrySafety,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      ...(operation.error && { error: operation.error }),
    });
    return Object.freeze({
      service: operation.service,
      transport: operation.transport,
      effect: operation.effect,
      request: Object.freeze({
        method: operation.request.method,
        path: operation.request.path,
      }),
      operation: publicOperation,
      ...(operation.response && { response: operation.response }),
      summary: Object.freeze({
        operationId: operation.operationId,
        state: operation.state,
        retrySafety,
        service: operation.service,
        effect: operation.effect,
        method: operation.request.method,
        path: operation.request.path,
        ...(operation.response && {
          status: operation.response.status,
          bytes: operation.response.bytes,
        }),
      }),
    });
  }

  #operationSummary(operation) {
    return Object.freeze({
      operationId: operation.operationId,
      state: operation.state,
      retrySafety: operation.effect === EFFECTS.READ ? 'safe' : 'unsafe',
      service: operation.service,
      effect: operation.effect,
      method: operation.request.method,
      path: operation.request.path,
      ...(operation.response && {
        status: operation.response.status,
        bytes: operation.response.bytes,
      }),
      ...(operation.error && { error: operation.error }),
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
  }

  #httpEndpointFor(service) {
    const endpoint = service === 'ant' ? this.getAntApiUrl() : this.getRadicleApiUrl();
    if (!endpoint) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `The ${service} node API is not currently available`
      );
    }
    return fixedEndpoint(endpoint, '/', service);
  }

  #dispatch(input, signal) {
    if (input.service === 'ipfs') {
      return this.serveIpfsRequest({
        path: input.request.path,
        method: input.request.method,
        headers: new Headers(input.request.headers || {}),
        signal,
      });
    }
    const endpoint = this.#httpEndpointFor(input.service);
    const target = fixedEndpoint(endpoint, input.request.path, input.service);
    return this.fetch(target, {
      method: input.request.method,
      headers: input.request.headers,
      ...(input.request.body !== undefined && { body: input.request.body }),
      redirect: 'error',
      signal,
    });
  }
}

module.exports = {
  NodeRequestController,
  fixedEndpoint,
  minimumEffectForMethod,
  readBoundedResponse,
  safeResponseHeaders,
  SERVICE_PROTOCOLS,
};
