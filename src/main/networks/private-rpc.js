/** Main-only RPC connection pinned to one context, endpoint and Tor generation.
 * Callers own method/intent authorization and result schemas. No retry/fallback.
 */
const { randomUUID } = require('crypto');
const { isProxy } = require('util').types;
const registry = require('./network-registry');
const { getPrivacyContext, privacyError } = require('./privacy-context');
const { createWalletTorTransport } = require('./wallet-tor-transport');
let transport;
const instances = new WeakMap(),
  destinations = new WeakMap();
const destinationFailure = () =>
  privacyError('PRIVATE_RPC_DESTINATION_REFUSED', 'Private RPC destination unavailable');

function getPrivateRpcDestination(client, handle) {
  try {
    const entry = instances.get(client);
    if (!entry || entry.handle !== handle) throw destinationFailure();
    entry.assertActive();
    return entry.observation;
  } catch {
    throw destinationFailure();
  }
}

function assertPrivateRpcDestination(client, handle, observation) {
  const actual = getPrivateRpcDestination(client, handle);
  if (actual !== observation) throw destinationFailure();
  return actual;
}

// Explicit trusted-main disclosure only. The observation itself serializes as
// {} and carries no URL, URL hash, context identifier or transport authority.
function getPrivateRpcDestinationDetails(observation) {
  try {
    const entry = destinations.get(observation);
    if (!entry) throw destinationFailure();
    entry.assertActive();
    return entry.details;
  } catch {
    throw destinationFailure();
  }
}

// Operation-local restrictions derived from genuine observations. They grant no
// consent or method authority and never disclose a URL through their token.
const destinationConstraints = new WeakMap();
const stableSubject = (subject) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(subject)
        .filter(([key]) => key !== 'operation')
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );
function createPrivateRpcDestinationConstraint(options) {
  let close;
  try {
    plain(options, ['observation', 'signal', 'deadline']);
    const { observation, signal, deadline } = options;
    const entry = destinations.get(observation);
    if (!entry || isProxy(signal) || !(signal instanceof AbortSignal) || signal.aborted)
      throw destinationFailure();
    entry.assertActive();
    const started = performance.now();
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(deadline) ||
      deadline <= started ||
      deadline - started > 900000
    )
      throw destinationFailure();
    const controller = new AbortController(),
      constraint = Object.freeze({});
    let closed = false,
      timer,
      lastNow = started;
    close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', close);
      entry.signal.removeEventListener('abort', close);
      controller.abort();
    };
    const current = () => {
      try {
        const now = performance.now();
        if (
          closed ||
          signal.aborted ||
          entry.signal.aborted ||
          !Number.isFinite(now) ||
          now < lastNow ||
          now >= deadline
        )
          throw destinationFailure();
        lastNow = now;
        entry.assertActive();
        const checkedAt = performance.now();
        if (
          closed ||
          signal.aborted ||
          controller.signal.aborted ||
          !Number.isFinite(checkedAt) ||
          checkedAt < lastNow ||
          checkedAt >= deadline
        )
          throw destinationFailure();
        lastNow = checkedAt;
      } catch {
        close();
        throw destinationFailure();
      }
    };
    signal.addEventListener('abort', close, { once: true });
    entry.signal.addEventListener('abort', close, { once: true });
    timer = setTimeout(close, Math.max(1, Math.ceil(deadline - performance.now())));
    timer.unref?.();
    current();
    destinationConstraints.set(constraint, { entry, current, signal: controller.signal });
    return Object.freeze({ constraint, signal: controller.signal, close });
  } catch {
    close?.();
    throw destinationFailure();
  }
}
function destinationConstraint(value, context, role, url) {
  if (value === undefined) return;
  const state = destinationConstraints.get(value);
  if (!state) throw destinationFailure();
  state.current();
  if (
    state.entry.profileId !== context.profileId ||
    state.entry.subject !== stableSubject(context.subject) ||
    state.entry.details.role !== role ||
    (url !== undefined && state.entry.details.url !== new URL(url).href)
  )
    throw destinationFailure();
  return state;
}

// Budgets restrict admission; they establish neither consent nor response trust.
const readBudgets = new WeakMap();
const budgetFailure = () =>
  privacyError('PRIVATE_RPC_READ_BUDGET_REFUSED', 'Private RPC read budget unavailable');
const requireBudget = (value) => {
  if (!value) throw budgetFailure();
};
function plain(value, required, optional = []) {
  requireBudget(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  requireBudget(
    required.every((key) => keys.includes(key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key)) &&
      keys.every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
  );
}
function blockNumber(value) {
  requireBudget(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value));
  requireBudget(value.length <= 16);
  const number = Number(BigInt(value));
  requireBudget(Number.isSafeInteger(number) && number >= 0);
  return number;
}
function boundedArray(value, maximum) {
  requireBudget(
    !isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  );
  requireBudget(value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1);
  for (let index = 0; index < value.length; index++)
    requireBudget(
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(index)) || {}, 'value')
    );
}
function readEnvelope(value) {
  plain(value, ['headers'], ['logs', 'eventHeaders']);
  boundedArray(value.headers, 5);
  const headers = new Map();
  for (const item of value.headers) {
    plain(item, ['tag', 'maxRequests']);
    if (item.tag !== 'finalized') blockNumber(item.tag);
    requireBudget(!headers.has(item.tag));
    requireBudget(
      Number.isSafeInteger(item.maxRequests) && item.maxRequests >= 1 && item.maxRequests <= 4
    );
    headers.set(item.tag, item.maxRequests);
  }
  let logs = null,
    range = null;
  if (Object.hasOwn(value, 'logs')) {
    plain(value.logs, ['address', 'fromBlock', 'toBlock']);
    const { address, fromBlock, toBlock } = value.logs;
    requireBudget(typeof address === 'string' && /^0x[0-9a-f]{40}$/.test(address));
    requireBudget(blockNumber(fromBlock) <= blockNumber(toBlock));
    logs = { address, fromBlock, toBlock };
  }
  if (Object.hasOwn(value, 'eventHeaders')) {
    plain(value.eventHeaders, ['fromBlock', 'toBlock', 'maxRequests']);
    const { fromBlock, toBlock, maxRequests } = value.eventHeaders;
    const from = blockNumber(fromBlock),
      to = blockNumber(toBlock);
    requireBudget(from <= to);
    requireBudget(Number.isSafeInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 512);
    range = { from, to, maximum: maxRequests, used: new Set() };
  }
  return { headers, logs, range };
}
function finishBudget(state) {
  if (!state.reason || state.pending || state.finished) return;
  state.finished = true;
  clearTimeout(state.timer);
  state.caller.removeEventListener('abort', state.onCancel);
  state.entry.signal.removeEventListener('abort', state.onFatal);
  state.entry = state.caller = state.envelope = null;
  state.resolveClosed();
}
function stopBudget(state, reason) {
  if (state.finished) return;
  if (state.fatal || !state.reason) state.reason = state.fatal ? 'fatal' : reason;
  clearTimeout(state.timer);
  // Set terminal state before synchronous abort listeners can reenter.
  state.controller.abort();
  finishBudget(state);
}
const failureRank = { revoked: 1, transport: 2, response: 3 };
function strongerFailure(previous, next) {
  return (failureRank[next] || 0) > (failureRank[previous] || 0) ? next : previous;
}
function fatalBudget(state, failure) {
  if (!state.finished) {
    state.fatal = true;
    state.failure = strongerFailure(state.failure, failure);
  }
  stopBudget(state, 'fatal');
  return budgetFailure();
}
function refuseAdmission(state) {
  stopBudget(state, 'admission-refused');
  return budgetFailure();
}
function currentBudget(state) {
  if (state.finished) throw budgetFailure();
  try {
    state.entry.assertActive();
  } catch {
    throw fatalBudget(state, 'revoked');
  }
  const now = performance.now();
  if (!Number.isFinite(now) || now < state.lastNow || now >= state.deadline)
    stopBudget(state, 'expired');
  state.lastNow = now;
  if (state.caller?.aborted) stopBudget(state, 'cancelled');
  if (state.reason) throw budgetFailure();
}
function budgetFacade(budget, signal, closed) {
  return Object.freeze({
    budget,
    signal,
    closed,
    close() {
      stopBudget(readBudgets.get(budget), 'completed');
    },
  });
}
// Protocol reads only. Admission refusals are terminal but do not imply corrupt
// source data. Response/validator/real-lifetime failures remain sticky, including
// during local cancellation drain. close/closed never closes the pooled transport.
function createPrivateRpcReadBudget(options) {
  try {
    plain(options, ['client', 'handle', 'destination', 'signal', 'deadline', 'envelope']);
    const { client, handle, destination, signal, deadline } = options;
    const entry = instances.get(client);
    requireBudget(
      entry &&
        entry.handle === handle &&
        entry.observation === destination &&
        entry.details.role === 'protocol-rpc'
    );
    entry.assertActive();
    requireBudget(!isProxy(signal) && signal instanceof AbortSignal && !signal.aborted);
    const started = performance.now();
    requireBudget(
      Number.isFinite(started) &&
        Number.isFinite(deadline) &&
        deadline > started &&
        deadline - started <= 180000
    );
    const envelope = readEnvelope(options.envelope);
    const budget = Object.freeze({}),
      controller = new AbortController();
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const state = {
      entry,
      caller: signal,
      envelope,
      started,
      lastNow: started,
      deadline,
      controller,
      resolveClosed,
      pending: 0,
      reason: null,
      fatal: false,
      failure: null,
      finished: false,
      admissions: { chainId: 0, headers: 0, eventHeaders: 0, logs: 0 },
    };
    state.onCancel = () => stopBudget(state, 'cancelled');
    state.onFatal = () => fatalBudget(state, 'revoked');
    readBudgets.set(budget, state);
    signal.addEventListener('abort', state.onCancel, { once: true });
    entry.signal.addEventListener('abort', state.onFatal, { once: true });
    state.timer = setTimeout(
      () => stopBudget(state, 'expired'),
      Math.ceil(deadline - performance.now())
    );
    state.timer.unref?.();
    currentBudget(state);
    return budgetFacade(budget, controller.signal, closed);
  } catch {
    throw budgetFailure();
  }
}
// A genuine outcome read checks currency and can finalize an idle budget.
// Once drained it retains only the historical classification/counters.
function getPrivateRpcReadBudgetOutcome(budget) {
  const state = readBudgets.get(budget);
  if (!state) throw budgetFailure();
  if (!state.finished) {
    try {
      currentBudget(state);
    } catch {
      /* Outcome remains readable after revocation. */
    }
  }
  return Object.freeze({
    status: state.finished ? 'closed' : state.reason ? 'draining' : 'active',
    reason: state.reason,
    fatal: state.fatal,
    failure: state.failure,
    integrityFailure: state.failure === 'response',
    pending: state.pending,
    admissions: Object.freeze({ ...state.admissions }),
  });
}
function snapshotReadParams(method, params) {
  boundedArray(params, 2);
  if (method === 'eth_getBlockByNumber') {
    requireBudget(params.length === 2 && params[1] === false);
    if (params[0] !== 'finalized') blockNumber(params[0]);
    return Object.freeze([params[0], false]);
  }
  requireBudget(method === 'eth_getLogs' && params.length === 1);
  plain(params[0], ['address', 'fromBlock', 'toBlock']);
  const { address, fromBlock, toBlock } = params[0];
  requireBudget(typeof address === 'string' && /^0x[0-9a-f]{40}$/.test(address));
  requireBudget(blockNumber(fromBlock) <= blockNumber(toBlock));
  return Object.freeze([Object.freeze({ address, fromBlock, toBlock })]);
}
function chargeBudget(state, method, params, consume = true) {
  currentBudget(state);
  try {
    const { headers, range, logs } = state.envelope;
    if (method === 'eth_chainId') {
      requireBudget(state.admissions.chainId === 0);
      if (consume) state.admissions.chainId++;
    } else if (method === 'eth_getBlockByNumber') {
      const tag = params[0],
        left = headers.get(tag) || 0;
      if (left) {
        if (consume) {
          headers.set(tag, left - 1);
          state.admissions.headers++;
        }
      } else {
        const number = blockNumber(tag);
        requireBudget(range && number >= range.from && number <= range.to);
        requireBudget(range.used.size < range.maximum && !range.used.has(number));
        if (consume) {
          range.used.add(number);
          state.admissions.eventHeaders++;
        }
      }
    } else {
      requireBudget(method === 'eth_getLogs' && logs && state.admissions.logs === 0);
      requireBudget(Object.keys(logs).every((key) => params[0][key] === logs[key]));
      if (consume) state.admissions.logs++;
    }
  } catch {
    throw refuseAdmission(state);
  }
}

// One request's admission deadline ({ admissionDeadline }): the monotonic
// instant (performance.now()) from which that request is not admitted to the
// transport. It bounds admission, not when bytes leave: a request admitted
// just before it on a reused keep-alive socket is written on the next tick,
// but on a new SOCKS+TLS connection its bytes leave only once the Tor stream
// and TLS handshake are up, after the deadline by up to that connect time.
// Data that can only refuse: it never cancels an admitted request, revokes
// the client or grants method authority (a destination constraint's deadline
// is the one that aborts in-flight work). Unbudgeted requests only; a read
// budget's own deadline already gates its admission in chargeBudget().
function admissionDeadline(value, budget) {
  if (value === undefined) return;
  try {
    plain(value, ['admissionDeadline']);
    requireBudget(budget === undefined && Number.isFinite(value.admissionDeadline));
  } catch {
    throw privacyError('PRIVATE_RPC_ADMISSION_INVALID', 'Invalid private RPC admission deadline');
  }
  return value.admissionDeadline;
}
function admitBefore(deadline) {
  if (deadline !== undefined && !(performance.now() < deadline))
    throw privacyError('PRIVATE_RPC_ADMISSION_EXPIRED', 'Private RPC admission deadline passed');
}

function createPrivateRpc(handle, role, { signal, destinationConstraint: constraint } = {}) {
  const context = getPrivacyContext(handle);
  const restriction = destinationConstraint(constraint, context, role);
  const { subject, requirements } = context;
  if (!require('../settings-store').isWalletTorExperimentAvailable()) {
    throw privacyError(
      'PRIVACY_TRANSPORT_UNAVAILABLE',
      'Experimental wallet transport is unavailable'
    );
  }
  const allowedSubject =
    role === 'protocol-rpc'
      ? subject.kind === 'private-account'
      : subject.kind === 'public-address';
  if (
    subject.chainId !== 11155111 ||
    !allowedSubject ||
    subject.role !== role ||
    requirements.content !== 'public' ||
    requirements.correctness !== 'any' ||
    requirements.maxAgeMs !== null
  ) {
    throw privacyError(
      'UNSUPPORTED_PRIVACY_REQUIREMENTS',
      'Experimental RPC cannot meet these requirements'
    );
  }
  const network = registry.getNetwork(subject.chainId);
  if (
    !network ||
    !(network.access?.readOrder || ['colibri', 'quorum', 'direct']).includes('direct')
  ) {
    throw privacyError('PRIVATE_SOURCE_UNAVAILABLE', 'No eligible source under this chain policy');
  }
  const sources = registry.getEndpointSources(subject.chainId, 'rpc');
  const eligible = new Set(
    sources
      .filter((source) => !source.keyed)
      .map((source) => source.coverage?.[String(subject.chainId)])
  );
  const url = registry.getEndpoints(subject.chainId, 'rpc').find((value) => {
    if (!eligible.has(value)) return false;
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === 'https:' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  });
  if (!url)
    throw privacyError('PRIVATE_SOURCE_UNAVAILABLE', 'No eligible unkeyed HTTPS RPC endpoint');
  destinationConstraint(constraint, context, role, url);
  const tor = require('../tor-manager');
  const endpoint = tor.getWalletSocksEndpoint();
  if (!endpoint || endpoint.signal.aborted)
    throw privacyError('TOR_NOT_READY', 'Managed Tor is not ready');
  const lifetime = AbortSignal.any([
    context.signal,
    endpoint.signal,
    ...(signal ? [signal] : []),
    ...(restriction ? [restriction.signal] : []),
  ]);
  const trust = Object.freeze({
    level: 'unverified',
    method: 'direct',
    block: null,
    agreed: Object.freeze([new URL(url).host]),
    dissented: Object.freeze([]),
    queried: Object.freeze([new URL(url).host]),
    quorum: Object.freeze({ k: 1, m: 1, achieved: false }),
  });
  const privacy = Object.freeze({
    mode: 'tor-experimental',
    transport: 'authenticated-socks',
    circuitIsolation: 'unqualified',
  });
  let chainCheck;
  function assertActive() {
    getPrivacyContext(handle);
    const currentEndpoint = tor.getWalletSocksEndpoint();
    restriction?.current();
    if (lifetime.aborted || endpoint !== currentEndpoint) {
      throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private RPC lifetime ended');
    }
  }
  async function raw(method, params, budgetState, shared, deadline) {
    const failed = (failure) => {
      if (shared) shared.failure = strongerFailure(shared.failure, failure);
      if (budgetState) fatalBudget(budgetState, failure);
    };
    try {
      assertActive();
    } catch (error) {
      failed('revoked');
      throw error;
    }
    try {
      transport ||= createWalletTorTransport();
    } catch (error) {
      failed('transport');
      throw error;
    }
    const id = randomUUID();
    const options = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: lifetime,
      timeoutMs: Math.min(120000, Math.max(500, Number(network.quorum?.timeoutMs) || 30000)),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    };
    // Public chain metadata can wait for circuit setup within its already
    // bounded request. Calls carrying nullifiers, calldata or signed sends
    // retain the transport's 10 s setup cap. ready() is still followed by the
    // original admission check before any subsequent sensitive request.
    if (method === 'eth_chainId' || method === 'eth_getBlockByNumber')
      options.connectTimeoutMs = options.timeoutMs;
    // Factory and JSON serialization can synchronously revoke the operation.
    // Check again at the last admission boundary, including hidden chain-ID.
    try {
      assertActive();
    } catch (error) {
      failed('revoked');
      throw error;
    }
    // This is the last gate before transport admission, including hidden ready().
    if (budgetState) {
      try {
        chargeBudget(budgetState, method, params);
      } catch (error) {
        if (shared) {
          if (budgetState.reason && !budgetState.fatal) shared.noAdmission = true;
          else if (budgetState.fatal) shared.failure = budgetState.failure;
        }
        throw error;
      }
    }
    // An unbudgeted request's admission deadline is checked last: the awaited
    // ready(), the factory, serialization and every check above may cross it.
    // Nothing but the transport call follows, synchronously.
    admitBefore(deadline);
    if (shared) shared.admitted = true;
    let response;
    try {
      response = await transport.request(handle, url, options);
    } catch (error) {
      failed('transport');
      throw error;
    }
    // Budgeted replies (including a legacy starter's joined budgets) must be
    // checked despite lifetime revocation, so known invalid data can upgrade it.
    if (!budgetState && !shared?.joined.size) {
      try {
        assertActive();
      } catch (error) {
        failed('revoked');
        throw error;
      }
    }
    try {
      let data;
      try {
        data = JSON.parse(response.body.toString('utf8'));
      } catch {
        throw privacyError('PRIVATE_RPC_INVALID', 'Invalid private RPC response');
      }
      if (
        response.status !== 200 ||
        !data ||
        Array.isArray(data) ||
        data.jsonrpc !== '2.0' ||
        data.id !== id ||
        Object.hasOwn(data, 'error') ||
        !Object.hasOwn(data, 'result')
      ) {
        throw privacyError('PRIVATE_RPC_INVALID', 'Invalid private RPC response');
      }
      return data.result;
    } catch (error) {
      failed('response');
      throw error;
    }
  }
  async function ready(budgetState) {
    assertActive();
    if (budgetState) currentBudget(budgetState);
    if (!chainCheck) {
      const shared = { admitted: false, noAdmission: false, failure: null, joined: new Set() };
      // Install before raw/factory/transport can synchronously reenter ready().
      let resolveShared, rejectShared;
      shared.promise = new Promise((resolve, reject) => {
        resolveShared = resolve;
        rejectShared = reject;
      });
      chainCheck = shared;
      if (budgetState) shared.joined.add(budgetState);
      const run = async () => {
        try {
          const chain = await raw('eth_chainId', [], budgetState, shared);
          if (!isQuantity(chain) || BigInt(chain) !== BigInt(subject.chainId)) {
            shared.failure = 'response';
            throw privacyError('PRIVATE_CHAIN_MISMATCH', 'RPC endpoint returned a different chain');
          }
          try {
            assertActive();
          } catch (error) {
            shared.failure = 'revoked';
            throw error;
          }
        } catch (error) {
          for (const joined of shared.joined) {
            if (shared.noAdmission) stopBudget(joined, 'shared-no-admission');
            else fatalBudget(joined, shared.failure || 'transport');
          }
          if (chainCheck === shared) chainCheck = null;
          throw error;
        }
      };
      run().then(resolveShared, rejectShared);
    }
    const shared = chainCheck;
    if (budgetState) shared.joined.add(budgetState);
    try {
      await shared.promise;
      assertActive();
      if (budgetState) currentBudget(budgetState);
    } finally {
      if (budgetState) shared.joined.delete(budgetState);
    }
  }
  async function request(method, params, validate, budget, admission) {
    // Refused on entry too, so a passed deadline sends no hidden chain-ID.
    const deadline = admissionDeadline(admission, budget);
    admitBefore(deadline);
    let state;
    if (budget !== undefined) {
      state = readBudgets.get(budget);
      // Wrong instances/tokens must not revoke another operation's budget.
      if (!state || state.entry !== instances.get(client)) throw budgetFailure();
      currentBudget(state);
      if (state.pending >= 534) throw refuseAdmission(state);
      state.pending++;
    }
    try {
      if (state) {
        try {
          requireBudget(typeof validate === 'function');
          params = snapshotReadParams(method, params);
        } catch {
          throw refuseAdmission(state);
        }
        chargeBudget(state, method, params, false);
      }
      await ready(state);
      if (state) currentBudget(state);
      const result = await raw(method, params, state, undefined, deadline);
      // Even canceled operations validate admitted replies before local currency.
      if (state) {
        try {
          if ((await validate(result)) !== true) throw budgetFailure();
        } catch {
          throw fatalBudget(state, 'response');
        }
        currentBudget(state);
      } else if (!validate(result)) {
        throw privacyError('PRIVATE_RPC_INVALID', 'Invalid private RPC result');
      }
      return {
        result,
        source: 'direct',
        verified: false,
        trust,
        privacy,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (state) {
        // Shared failures are latched by ready(); genuine lifetime loss is fatal.
        try {
          state.entry?.assertActive();
        } catch {
          fatalBudget(state, 'revoked');
        }
        throw budgetFailure();
      }
      throw error;
    } finally {
      if (state) {
        state.pending--;
        finishBudget(state);
      }
    }
  }
  const client = Object.freeze({
    request,
    ready: () => ready(),
    assertActive,
    signal: lifetime,
    trust,
    privacy,
    release: () => transport?.release(handle),
  });
  if (restriction) assertActive();
  const observation = Object.freeze({});
  const entry = {
    handle,
    profileId: context.profileId,
    subject: stableSubject(subject),
    signal: lifetime,
    assertActive,
    observation,
    details: Object.freeze({
      version: 1,
      url: new URL(url).href,
      chainId: subject.chainId,
      role,
      transport: 'tor-experimental',
    }),
  };
  instances.set(client, entry);
  destinations.set(observation, entry);
  return client;
}

function isQuantity(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value);
}

module.exports = {
  createPrivateRpc,
  createPrivateRpcDestinationConstraint,
  createPrivateRpcReadBudget,
  getPrivateRpcReadBudgetOutcome,
  isQuantity,
  getPrivateRpcDestination,
  assertPrivateRpcDestination,
  getPrivateRpcDestinationDetails,
};
