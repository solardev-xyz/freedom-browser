/**
 * Main-process privacy context capabilities. Tokens and account identifiers
 * never appear on the opaque handle (including when it is serialized/logged).
 * This module owns lifetimes, not transport or response-verification claims.
 */
const { randomBytes, randomUUID } = require('crypto');
const { setMaxListeners } = require('events');

const contexts = new WeakMap();
const MAX_CONTEXTS = 256;
const MAX_PENDING_TASKS = 32;

function privacyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw privacyError('INVALID_PRIVACY_CONTEXT', `Invalid privacy ${field}`);
  }
  return value;
}

function normalizeRequirements(input = {}) {
  const defaults = { origin: 'tor', content: 'public', correctness: 'any', maxAgeMs: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw privacyError('INVALID_PRIVACY_REQUIREMENTS', 'Invalid privacy requirements');
  }
  if (Object.keys(input).some((key) => !Object.hasOwn(defaults, key))) {
    throw privacyError('INVALID_PRIVACY_REQUIREMENTS', 'Unknown privacy requirement');
  }
  const result = { ...defaults, ...input };
  if (
    result.origin !== 'tor' ||
    !['public', 'pir'].includes(result.content) ||
    !['any', 'quorum', 'proof'].includes(result.correctness) ||
    (result.maxAgeMs !== null && (!Number.isSafeInteger(result.maxAgeMs) || result.maxAgeMs < 0))
  ) {
    throw privacyError('INVALID_PRIVACY_REQUIREMENTS', 'Unsupported privacy requirements');
  }
  return Object.freeze(result);
}

function normalizeSubject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw privacyError('INVALID_PRIVACY_CONTEXT', 'Invalid privacy subject');
  }
  const kind = input.kind;
  if (!['public-address', 'private-account', 'service'].includes(kind)) {
    throw privacyError('INVALID_PRIVACY_CONTEXT', 'Invalid privacy principal kind');
  }
  let principal = requiredString(input.principal, 'principal');
  if (kind === 'public-address') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(principal)) {
      throw privacyError('INVALID_PRIVACY_CONTEXT', 'Invalid privacy address');
    }
    principal = principal.toLowerCase();
  }
  const chainId = Number(input.chainId);
  if (
    !['number', 'string'].includes(typeof input.chainId) ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    throw privacyError('INVALID_PRIVACY_CONTEXT', 'Invalid privacy chain');
  }
  const protocol = input.protocol === undefined ? null : requiredString(input.protocol, 'protocol');
  const deployment =
    input.deployment === undefined ? null : requiredString(input.deployment, 'deployment');
  if (kind === 'private-account' && (!protocol || !deployment)) {
    throw privacyError(
      'INVALID_PRIVACY_CONTEXT',
      'Private accounts require protocol and deployment'
    );
  }
  return Object.freeze({
    kind,
    principal,
    chainId,
    protocol,
    deployment,
    role: requiredString(input.role, 'service role'),
    operation: input.operation === undefined ? null : requiredString(input.operation, 'operation'),
  });
}

function getPrivacyContext(handle, chainId) {
  const entry = contexts.get(handle);
  if (!entry) throw privacyError('INVALID_PRIVACY_CONTEXT', 'Unknown privacy context');
  entry.assertActive();
  if (chainId !== undefined && Number(chainId) !== entry.value.subject.chainId) {
    throw privacyError('PRIVACY_CHAIN_MISMATCH', 'Privacy context belongs to another chain');
  }
  return entry.value;
}

/** One wallet-owned scope per profile/unlock lifetime; closed scopes never reopen. */
function createPrivacyScope({ profileId, signal, isCurrent = () => true }) {
  requiredString(profileId, 'profile');
  if (!signal || typeof signal.addEventListener !== 'function' || typeof isCurrent !== 'function') {
    throw privacyError('INVALID_PRIVACY_CONTEXT', 'Privacy scope requires a lifetime signal');
  }
  const controller = new AbortController();
  // Tasks and context-owned transport pools each subscribe to this lifetime.
  setMaxListeners(MAX_PENDING_TASKS + MAX_CONTEXTS + 1, controller.signal);
  const generation = randomUUID();
  const handles = new Map();
  const ownedHandles = new WeakSet();
  let pendingTasks = 0;

  function close() {
    signal.removeEventListener('abort', close);
    handles.clear();
    controller.abort(privacyError('PRIVACY_CONTEXT_REVOKED', 'Privacy session ended'));
  }

  function assertActive() {
    if (signal.aborted || !isCurrent()) close();
    if (controller.signal.aborted) throw controller.signal.reason;
  }

  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();

  function assertOwned(handle) {
    assertActive();
    if (!ownedHandles.has(handle)) {
      throw privacyError('INVALID_PRIVACY_CONTEXT', 'Context belongs to another privacy session');
    }
    return getPrivacyContext(handle);
  }

  function getContext(input, requirements) {
    assertActive();
    const subject = normalizeSubject(input);
    const policy = normalizeRequirements(requirements);
    const key = JSON.stringify([subject, policy]);
    if (handles.has(key)) return handles.get(key);
    if (handles.size >= MAX_CONTEXTS) {
      throw privacyError('PRIVACY_CONTEXT_LIMIT', 'Privacy context limit reached');
    }
    const handle = Object.freeze(Object.create(null));
    const value = Object.freeze({
      profileId,
      generation,
      subject,
      requirements: policy,
      isolationToken: randomBytes(32).toString('hex'),
      signal: controller.signal,
    });
    contexts.set(handle, { value, assertActive });
    ownedHandles.add(handle);
    handles.set(key, handle);
    return handle;
  }

  // Tasks must use the signal for their own I/O and return results without
  // committing state. This rejects promptly even if a dependency ignores abort.
  // Both fulfillment and rejection stay observed after cancellation.
  function run(handle, task) {
    assertOwned(handle);
    if (typeof task !== 'function') throw new TypeError('Privacy task must be a function');
    if (pendingTasks >= MAX_PENDING_TASKS) {
      throw privacyError('PRIVACY_TASK_LIMIT', 'Privacy task limit reached');
    }
    pendingTasks += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => finish(controller.signal.reason);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        pendingTasks -= 1;
        controller.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(result);
      }
      controller.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          assertOwned(handle);
          return task(controller.signal);
        })
        .then((result) => {
          assertOwned(handle);
          finish(null, result);
        })
        .catch((error) => {
          // A task may reject with a falsy value; preserve rejection semantics.
          if (settled) return;
          settled = true;
          pendingTasks -= 1;
          controller.signal.removeEventListener('abort', onAbort);
          reject(error);
        });
    });
  }

  // Check again at the state-write boundary after awaiting run(). The callback
  // must be synchronous; it must not enqueue an unchecked later cache write.
  function commit(handle, write) {
    assertOwned(handle);
    return write();
  }

  return Object.freeze({ getContext, run, commit, close, signal: controller.signal });
}

module.exports = { createPrivacyScope, getPrivacyContext, privacyError };
