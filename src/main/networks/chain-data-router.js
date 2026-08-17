const log = require('../logger');
const registry = require('./network-registry');
const myotis = require('../myotis/myotis-manager');

const READ_METHODS = new Set([
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getLogs',
]);

const COLIBRI_UNSUPPORTED = new Set([
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_uninstallFilter',
]);
const DIRECT_ONLY_METHODS = new Set([
  ...COLIBRI_UNSUPPORTED,
  'web3_clientVersion',
  'web3_sha3',
]);
READ_METHODS.add('web3_clientVersion');
READ_METHODS.add('web3_sha3');

const DEFAULT_READ_ORDER = ['myotis', 'colibri', 'quorum', 'direct'];
const DEFAULT_NON_MYOTIS_READ_ORDER = ['colibri', 'quorum', 'direct'];
const DEFAULT_BROADCAST_ORDER = ['myotis', 'direct'];
const INTERACTIVE_SOURCE_DEADLINE_MS = 2000;
const SOURCE_TIMEOUT_COOLDOWNS_MS = [15_000, 30_000, 60_000];
const MAX_COLIBRI_IN_FLIGHT = 8;
const MAX_COLIBRI_IN_FLIGHT_PER_ROUTE = 2;
const MAX_ADAPTIVE_SOURCE_ROUTES = 1024;

// These are deliberately process-local. A source that struggles with one
// app's call shape should not reorder the user's chain policy, affect another
// app, or stay demoted after Freedom restarts.
const adaptiveSourceState = new Map();
const colibriInFlight = new Set();
const colibriInFlightByRoute = new Map();

class SourceUnavailableError extends Error {
  constructor(message, failureKind = null) {
    super(message);
    this.name = 'SourceUnavailableError';
    this.failureKind = failureKind;
  }
}

class SourceDeadlineError extends SourceUnavailableError {
  constructor(source, timeoutMs) {
    super(`${source} exceeded its ${timeoutMs}ms interactive deadline`, 'timeout');
    this.name = 'SourceDeadlineError';
  }
}

function safeErrorMessage(error) {
  return (error?.message || String(error))
    .replace(/0x[0-9a-fA-F]{128,}/g, (hex) =>
      `${hex.slice(0, 10)}…(${Math.floor((hex.length - 2) / 2)} bytes)`)
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function normalizeRoutingOrigin(routingContext) {
  const origin = routingContext?.origin;
  if (typeof origin !== 'string') return null;
  // The renderer supplies its canonical permission key. Do not lowercase it
  // again here: content-addressed identifiers such as CIDv0 are case-sensitive.
  const normalized = origin.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized.length > 2048 || hasControlCharacter) {
    return null;
  }
  return normalized;
}

function requestTarget(method, params) {
  let target;
  if (CALL_OBJECT_METHODS.has(method)) target = params?.[0]?.to;
  else if (['eth_getBalance', 'eth_getCode', 'eth_getStorageAt',
    'eth_getTransactionCount'].includes(method)) target = params?.[0];
  else if (method === 'eth_getLogs') target = params?.[0]?.address;
  if (Array.isArray(target)) {
    const addresses = target
      .filter((address) => typeof address === 'string' && /^0x[0-9a-f]{40}$/i.test(address))
      .map((address) => address.toLowerCase())
      .sort();
    return addresses.length ? addresses.join(',') : '*';
  }
  return typeof target === 'string' && /^0x[0-9a-f]{40}$/i.test(target.trim())
    ? target.trim().toLowerCase()
    : '*';
}

function adaptiveRouteKey(source, chainId, method, params, routingContext) {
  const origin = normalizeRoutingOrigin(routingContext);
  if (!origin) return null;
  return JSON.stringify([source, Number(chainId), origin, method, requestTarget(method, params)]);
}

function isCapacityFailure(error) {
  if (error?.failureKind === 'capacity') return true;
  const message = safeErrorMessage(error);
  return /out of gas|execution (?:gas|resource) limit|exceeds? (?:the )?(?:gas|execution) limit/i
    .test(message);
}

function failureKind(error) {
  if (isCapacityFailure(error)) return 'capacity';
  if (error?.failureKind === 'timeout' || error?.name === 'AbortError') return 'timeout';
  return null;
}

function adaptiveSourceUnavailable(routeKey, now = Date.now()) {
  if (!routeKey) return false;
  const state = adaptiveSourceState.get(routeKey);
  if (!state) return false;
  return state.sessionBlocked === true || state.openUntil > now;
}

function recordAdaptiveSuccess(routeKey) {
  if (!routeKey) return;
  // A deterministic execution ceiling is a capability boundary for this app
  // session, not a health fluctuation. A lighter concurrent call succeeding
  // against the same contract must not erase it.
  if (adaptiveSourceState.get(routeKey)?.sessionBlocked) return;
  adaptiveSourceState.delete(routeKey);
}

function setAdaptiveSourceState(routeKey, state) {
  if (!adaptiveSourceState.has(routeKey) &&
      adaptiveSourceState.size >= MAX_ADAPTIVE_SOURCE_ROUTES) {
    adaptiveSourceState.delete(adaptiveSourceState.keys().next().value);
  }
  adaptiveSourceState.set(routeKey, state);
}

function recordAdaptiveFailure(routeKey, error, now = Date.now()) {
  if (!routeKey) return;
  const kind = failureKind(error);
  if (!kind) return;
  const previous = adaptiveSourceState.get(routeKey) || {
    timeoutCount: 0,
    openUntil: 0,
    sessionBlocked: false,
  };
  if (kind === 'capacity') {
    setAdaptiveSourceState(routeKey, { ...previous, sessionBlocked: true });
    return;
  }
  const timeoutCount = previous.timeoutCount + 1;
  const cooldownMs = SOURCE_TIMEOUT_COOLDOWNS_MS[
    Math.min(timeoutCount - 1, SOURCE_TIMEOUT_COOLDOWNS_MS.length - 1)
  ];
  setAdaptiveSourceState(routeKey, {
    ...previous,
    timeoutCount,
    openUntil: now + cooldownMs,
  });
}

function withSourceDeadline(promise, source, timeoutMs = INTERACTIVE_SOURCE_DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SourceDeadlineError(source, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function clearAdaptiveRoutingForTest() {
  adaptiveSourceState.clear();
  colibriInFlight.clear();
  colibriInFlightByRoute.clear();
}

function isReadMethod(method) {
  return READ_METHODS.has(method) || COLIBRI_UNSUPPORTED.has(method);
}

function quantity(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    return `0x${BigInt(value).toString(16)}`;
  }
  return `0x${BigInt(value || 0).toString(16)}`;
}

function decimal(value) {
  if (value == null || value === '') return '0';
  return BigInt(value).toString(10);
}

// Numeric fields of a JSON-RPC call object are QUANTITYs and have to travel as
// hex. Internal callers work in decimal wei (ethers' parseUnits output), and a
// raw decimal makes strict nodes answer -32602, which silently drops the read
// out of the quorum tier. Normalise once here — the boundary every source
// shares — so all endpoints also see a byte-identical body to agree on.
const CALL_OBJECT_METHODS = new Set(['eth_call', 'eth_estimateGas']);
const CALL_QUANTITY_FIELDS = [
  'value',
  'gas',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
];

// `input` is the standardised calldata field of a call object and `data` the
// legacy alias; libraries send one or the other (web3.js v4 sends `input`).
// Sources read `data` — the Myotis path most of all, where a missing alias
// would execute empty calldata against head state and return that answer as
// verified. Canonicalise the alias into `data` here so every tier, including
// the byte-identical quorum bodies, sees the same calldata.
function calldata(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === '0x') return null;
  return trimmed;
}

function normalizeCallObject(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return call;
  let normalized = call;
  const data = calldata(call.data);
  const input = calldata(call.input);
  if (input && !data) {
    normalized = { ...call };
    normalized.data = call.input;
  }
  for (const field of CALL_QUANTITY_FIELDS) {
    const value = call[field];
    if (value == null || value === '') continue;
    if (!['string', 'number', 'bigint'].includes(typeof value)) continue;
    let hex;
    try {
      hex = quantity(value);
    } catch {
      // Not a number we can encode; leave it for the node to reject.
      continue;
    }
    if (hex === value) continue;
    if (normalized === call) normalized = { ...call };
    normalized[field] = hex;
  }
  return normalized;
}

function normalizeParams(method, params) {
  if (!CALL_OBJECT_METHODS.has(method) || !Array.isArray(params) || !params.length) return params;
  const call = normalizeCallObject(params[0]);
  if (call === params[0]) return params;
  return [call, ...params.slice(1)];
}

function nativeResult(payload, ...keys) {
  if (!payload || payload.error || payload.status === 'error') {
    throw new Error(payload?.error || payload?.message || 'Myotis request failed');
  }
  for (const key of keys) {
    if (payload[key] != null) return payload[key];
  }
  throw new Error('Myotis returned an unexpected response');
}

function optionalNativeResult(payload, ...keys) {
  for (const key of keys) {
    if (payload?.[key] != null) return payload[key];
  }
  return null;
}

function feeQuote(source, gasPriceValue, priorityValue = null) {
  const gasPrice = BigInt(gasPriceValue);
  if (gasPrice <= 0n) throw new Error(`${source} returned a non-positive gas price`);

  const metadata = {
    source,
    verified: source === 'myotis' || source === 'colibri' || source === 'quorum',
  };
  if (priorityValue == null) {
    return {
      type: 'legacy',
      gasPrice: gasPrice.toString(),
      effectiveGasPrice: gasPrice.toString(),
      ...metadata,
    };
  }

  const priority = BigInt(priorityValue);
  // A provider can implement both methods yet return fee hints that cannot
  // form a valid type-2 transaction. Keep the usable gas price from that same
  // source and fall back to a legacy transaction instead of combining it with
  // another provider's priority fee.
  if (priority < 0n || priority > gasPrice) {
    log.verbose(
      `[chain-data] ${source} returned an inconsistent fee quote ` +
        `(gasPrice=${gasPrice}, priorityFee=${priority}); using legacy fees`
    );
    return {
      type: 'legacy',
      gasPrice: gasPrice.toString(),
      effectiveGasPrice: gasPrice.toString(),
      ...metadata,
    };
  }

  const baseFee = gasPrice - priority;
  return {
    type: 'eip1559',
    baseFee: baseFee.toString(),
    maxPriorityFeePerGas: priority.toString(),
    // The base fee can rise 12.5% per block between quoting and inclusion, so
    // the signed cap needs headroom the quoted gas price does not have. Two
    // full blocks of growth is the market preset the wallet has always used.
    maxFeePerGas: (baseFee * 2n + priority).toString(),
    effectiveGasPrice: gasPrice.toString(),
    ...metadata,
  };
}

// Myotis answers account reads from its verified head state and takes no block
// parameter. Any explicit tag other than `latest` — notably the `pending` nonce
// a new transaction needs — has to come from a source that honours the tag.
function assertMyotisBlockTag(method, blockTag) {
  if (blockTag == null || blockTag === 'latest') return;
  throw new SourceUnavailableError(`Myotis cannot serve ${method} at block "${blockTag}"`);
}

// The engine executes a call as `from`/`to`/`data`/`value` against its verified
// head: the block argument it takes is discarded (`_block`, never read — the
// servable-window gate is a host obligation), and the addon exposes no
// state-override entry point. Any call carrying more than that has to go to a
// source that can honour it, rather than being answered — as `verified` — from
// head state without it.
const MYOTIS_UNSUPPORTED_CALL_FIELDS = [
  'gas',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
  'accessList',
];

function assertMyotisCallShape(method, params) {
  assertMyotisBlockTag(method, params[1]);
  if (params[2] != null) {
    throw new SourceUnavailableError(`Myotis cannot serve ${method} with state overrides`);
  }
  const call = params[0] || {};
  // A call carrying both calldata aliases with different payloads is ambiguous:
  // strict nodes reject the pair outright, so pick neither here rather than
  // executing one of them against head state and calling the answer verified.
  const data = calldata(call.data);
  const input = calldata(call.input);
  if (data && input && data !== input) {
    throw new SourceUnavailableError(
      `Myotis cannot serve ${method} with conflicting "data" and "input" calldata`
    );
  }
  for (const field of MYOTIS_UNSUPPORTED_CALL_FIELDS) {
    const value = call[field];
    if (value == null || value === '') continue;
    throw new SourceUnavailableError(`Myotis cannot serve ${method} with a "${field}" field`);
  }
}

async function requestMyotis(chainId, method, params) {
  if (!myotis.isReady(chainId)) throw new SourceUnavailableError('Myotis is not ready');

  if (method === 'eth_getBalance' || method === 'eth_getTransactionCount') {
    assertMyotisBlockTag(method, params[1]);
    const account = await myotis.getAccount(params[0], chainId);
    const value = method === 'eth_getBalance'
      ? nativeResult(account, 'balanceWei', 'balance')
      : nativeResult(account, 'nonce');
    return quantity(value);
  }

  if (method === 'eth_call') {
    assertMyotisCallShape(method, params);
    const call = params[0] || {};
    const result = await myotis.ethCall({
      chainId,
      from: call.from || '',
      to: call.to,
      data: call.data || '0x',
      value: decimal(call.value),
      block: 'latest',
    });
    return nativeResult(result, 'resultHex', 'result');
  }

  if (method === 'eth_estimateGas') {
    // Same constraint as the account reads and `eth_call`: the estimate is
    // taken against the verified head with only from/to/data/value, so an
    // explicit tag, state overrides or extra call fields cannot be honoured.
    assertMyotisCallShape(method, params);
    const call = params[0] || {};
    const result = await myotis.estimateGas({
      chainId,
      from: call.from || '',
      to: call.to,
      data: call.data || '0x',
      value: decimal(call.value),
    });
    return quantity(nativeResult(result, 'gasLimit', 'result'));
  }

  if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') {
    const result = await myotis.feeEstimate(chainId);
    return quantity(
      method === 'eth_gasPrice'
        ? nativeResult(result, 'gasPriceWei', 'gasPrice')
        : nativeResult(result, 'maxPriorityFeePerGasWei', 'maxPriorityFeePerGas')
    );
  }

  throw new SourceUnavailableError(`Myotis does not support ${method}`);
}

async function requestColibri(chainId, method, params, routeKey = null) {
  if (COLIBRI_UNSUPPORTED.has(method)) {
    throw new SourceUnavailableError(`Colibri does not support ${method}`);
  }
  if (!registry.getEndpoints(chainId, 'prover').length) {
    throw new SourceUnavailableError('No Colibri prover configured');
  }
  const inFlightKey = routeKey || JSON.stringify([
    'colibri',
    Number(chainId),
    method,
    requestTarget(method, params),
  ]);
  const routeInFlight = colibriInFlightByRoute.get(inFlightKey) || 0;
  if (colibriInFlight.size >= MAX_COLIBRI_IN_FLIGHT ||
      routeInFlight >= MAX_COLIBRI_IN_FLIGHT_PER_ROUTE) {
    throw new SourceUnavailableError('Colibri is already processing this workload');
  }
  // Keep the WASM-backed verifier lazy; most startup paths do not need it.
  const { requestViaColibri } = require('../ens/colibri-resolver');
  const requestPromise = Promise.resolve().then(() => requestViaColibri(chainId, method, params));
  colibriInFlight.add(requestPromise);
  colibriInFlightByRoute.set(inFlightKey, routeInFlight + 1);
  const release = () => {
    colibriInFlight.delete(requestPromise);
    const remaining = (colibriInFlightByRoute.get(inFlightKey) || 1) - 1;
    if (remaining > 0) colibriInFlightByRoute.set(inFlightKey, remaining);
    else colibriInFlightByRoute.delete(inFlightKey);
  };
  // A timed-out WASM/prover operation cannot currently be cancelled. Keep it
  // tracked until it really settles so repeated page calls cannot accumulate
  // unbounded background work.
  requestPromise.then(release, release);
  return withSourceDeadline(requestPromise, 'Colibri');
}

async function requestRpcUrl(url, method, params, timeoutMs, { signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) {
      const error = new Error(data.error.message || 'RPC request failed');
      error.code = data.error.code;
      error.data = data.error.data;
      throw error;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function endpointHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function isUserConfiguredRpc(chainId, url) {
  const cid = String(chainId);
  const source = registry.getEndpointSources(chainId, 'rpc').find(
    (entry) => !entry.keyed && entry.coverage?.[cid] === url
  );
  if (!source) return false;
  const metadata = registry.getEndpointSourceList().find((entry) => entry.id === source.id);
  return Boolean(metadata && !metadata.builtin && !metadata.removed && !metadata.keyed);
}

function myotisTrust(beforeStatus = {}, afterStatus = {}) {
  const beforeBlock = beforeStatus.optimisticBlockNumber ?? null;
  const afterBlock = afterStatus.optimisticBlockNumber ?? null;
  // The generic Myotis call executes at its optimistic head. Only label the
  // answer with a block when that head stayed stable around the call; a
  // separately sampled newer head must never be presented as the call's block.
  const block = beforeBlock !== null && beforeBlock === afterBlock ? afterBlock : null;
  return {
    level: 'verified',
    method: 'myotis',
    finality: 'optimistic',
    proof: 'P2P light client (optimistic beacon root — attested, not finalized)',
    block,
    agreed: ['myotis-p2p'],
    dissented: [],
    queried: ['myotis-p2p'],
    quorum: { k: 1, m: 1, achieved: true },
  };
}

function colibriTrust(chainId) {
  const [proverUrl] = registry.getEndpoints(chainId, 'prover');
  const prover = endpointHost(proverUrl);
  return {
    level: 'verified',
    method: 'colibri',
    prover,
    proof: registry.getNetwork(chainId)?.zkProof === false
      ? 'Sync-committee proof'
      : 'ZK sync-committee proof',
    block: null,
    agreed: prover ? [prover] : [],
    dissented: [],
    queried: prover ? [prover] : [],
    quorum: { k: 1, m: 1, achieved: true },
  };
}

async function requestQuorum(chainId, method, params, { includeTrust = false } = {}) {
  const network = registry.getNetwork(chainId) || {};
  const quorum = network.quorum || {};
  const k = Math.max(1, Number(quorum.k) || 3);
  const m = Math.max(1, Math.min(k, Number(quorum.m) || 2));
  const configuredTimeoutMs = Math.max(500, Number(quorum.timeoutMs) || 5000);
  const timeoutMs = Math.min(configuredTimeoutMs, INTERACTIVE_SOURCE_DEADLINE_MS);
  const urls = registry.getEndpoints(chainId, 'rpc').slice(0, k);
  if (urls.length < m) throw new SourceUnavailableError(`RPC quorum needs ${m} endpoints`);

  return new Promise((resolve, reject) => {
    const controllers = urls.map(() => new AbortController());
    const groups = new Map();
    const fulfilledUrls = [];
    const errors = [];
    let pending = urls.length;
    let finished = false;

    const abortPending = () => controllers.forEach((controller) => controller.abort());
    const succeed = (group) => {
      if (finished) return;
      finished = true;
      abortPending();
      if (!includeTrust) {
        resolve(group.value);
        return;
      }
      const agreedUrls = new Set(group.urls);
      resolve({
        result: group.value,
        trust: {
          level: 'verified',
          method: 'quorum',
          block: null,
          agreed: group.urls.map(endpointHost).filter(Boolean),
          dissented: fulfilledUrls
            .filter((url) => !agreedUrls.has(url))
            .map(endpointHost)
            .filter(Boolean),
          queried: urls.map(endpointHost).filter(Boolean),
          quorum: { k: urls.length, m, achieved: true },
        },
      });
    };
    const rejectIfImpossible = () => {
      if (finished) return;
      const largestGroup = Math.max(0, ...[...groups.values()].map((group) => group.count));
      if (largestGroup + pending >= m) return;
      finished = true;
      abortPending();
      const capacityFailures = errors.filter(isCapacityFailure).length;
      const timedOut = errors.some((error) => failureKind(error) === 'timeout');
      reject(new SourceUnavailableError(
        `RPC quorum did not reach ${m} matching responses`,
        capacityFailures >= m ? 'capacity' : timedOut ? 'timeout' : null
      ));
    };

    urls.forEach((url, index) => {
      requestRpcUrl(url, method, params, timeoutMs, { signal: controllers[index].signal }).then(
        (value) => {
          if (finished) return;
          pending -= 1;
          fulfilledUrls.push(url);
          const key = stableValue(value);
          const group = groups.get(key) || { count: 0, value, urls: [] };
          group.count += 1;
          group.urls.push(url);
          groups.set(key, group);
          if (group.count >= m) succeed(group);
          else rejectIfImpossible();
        },
        (error) => {
          if (finished) return;
          pending -= 1;
          errors.push(error);
          rejectIfImpossible();
        }
      );
    });
  });
}

async function requestDirect(chainId, method, params, { includeTrust = false } = {}) {
  const network = registry.getNetwork(chainId) || {};
  const timeoutMs = Math.max(500, Number(network.quorum?.timeoutMs) || 5000);
  const urls = registry.getEndpoints(chainId, 'rpc');
  if (!urls.length) throw new SourceUnavailableError('No RPC endpoint configured');
  let lastError;
  for (const url of urls) {
    try {
      const result = await requestRpcUrl(url, method, params, timeoutMs);
      if (!includeTrust) return result;
      const host = endpointHost(url);
      const userConfigured = isUserConfiguredRpc(chainId, url);
      return {
        result,
        trust: {
          level: userConfigured ? 'user-configured' : 'unverified',
          method: 'direct',
          block: null,
          agreed: host ? [host] : [],
          dissented: [],
          queried: host ? [host] : [],
          quorum: { k: 1, m: 1, achieved: false },
        },
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new SourceUnavailableError('All RPC endpoints failed');
}

async function requestDirectFeeQuote(chainId) {
  const network = registry.getNetwork(chainId) || {};
  const timeoutMs = Math.max(500, Number(network.quorum?.timeoutMs) || 5000);
  const urls = registry.getEndpoints(chainId, 'rpc');
  if (!urls.length) throw new SourceUnavailableError('No RPC endpoint configured');
  let lastError;
  for (const url of urls) {
    try {
      const gasPrice = await requestRpcUrl(url, 'eth_gasPrice', [], timeoutMs);
      let priority = null;
      try {
        // Deliberately use the same URL as eth_gasPrice. Falling through the
        // endpoint list independently is what produced mixed, invalid quotes.
        priority = await requestRpcUrl(url, 'eth_maxPriorityFeePerGas', [], timeoutMs);
      } catch {
        // Legacy transactions remain valid when this endpoint does not expose
        // an EIP-1559 priority-fee hint.
      }
      return feeQuote('direct', gasPrice, priority);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new SourceUnavailableError('All RPC endpoints failed');
}

async function requestSource(
  source,
  chainId,
  method,
  params,
  { includeTrust = false, routeKey = null } = {}
) {
  if (source === 'myotis') {
    const beforeStatus = includeTrust ? myotis.getStatus?.(chainId) || {} : null;
    const result = await requestMyotis(chainId, method, params);
    if (!includeTrust) return result;
    const afterStatus = myotis.getStatus?.(chainId) || {};
    return { result, trust: myotisTrust(beforeStatus, afterStatus) };
  }
  if (source === 'colibri') {
    const result = await requestColibri(chainId, method, params, routeKey);
    return includeTrust ? { result, trust: colibriTrust(chainId) } : result;
  }
  if (source === 'quorum') return requestQuorum(chainId, method, params, { includeTrust });
  if (source === 'direct') return requestDirect(chainId, method, params, { includeTrust });
  throw new SourceUnavailableError(`Unknown chain source: ${source}`);
}

async function request(
  chainId,
  method,
  rawParams = [],
  { includeTrust = false, routingContext = null } = {}
) {
  if (!isReadMethod(method)) throw new Error(`Unsupported read method: ${method}`);
  const network = registry.getNetwork(chainId);
  if (!network) throw new Error(`Unsupported chain ID: ${chainId}`);
  const params = normalizeParams(method, rawParams);
  const supportsMyotis = myotis.NETWORKS?.has(Number(chainId)) === true;
  const order = network.access?.readOrder ||
    (supportsMyotis ? DEFAULT_READ_ORDER : DEFAULT_NON_MYOTIS_READ_ORDER);
  const failures = [];
  let lastRpcError = null;
  for (const source of order) {
    if (DIRECT_ONLY_METHODS.has(method) && source !== 'direct') continue;
    const routeKey = source === 'colibri' || source === 'quorum'
      ? adaptiveRouteKey(source, chainId, method, params, routingContext)
      : null;
    if (adaptiveSourceUnavailable(routeKey)) {
      failures.push(`${source}: temporarily bypassed for this app workload`);
      continue;
    }
    try {
      const sourceResult = await requestSource(source, Number(chainId), method, params, {
        includeTrust,
        routeKey,
      });
      recordAdaptiveSuccess(routeKey);
      const result = includeTrust ? sourceResult.result : sourceResult;
      return {
        result,
        source,
        verified: source === 'myotis' || source === 'colibri' || source === 'quorum',
        ...(includeTrust && sourceResult.trust ? { trust: sourceResult.trust } : {}),
      };
    } catch (err) {
      recordAdaptiveFailure(routeKey, err);
      const message = safeErrorMessage(err);
      failures.push(`${source}: ${message}`);
      if (!(err instanceof SourceUnavailableError)) lastRpcError = err;
      log.verbose(`[chain-data] ${chainId} ${method} via ${source} failed: ${message}`);
    }
  }
  if (lastRpcError) throw lastRpcError;
  throw new Error(`All chain sources failed for ${method} (${failures.join('; ')})`);
}

async function getFeeQuote(chainId) {
  const network = registry.getNetwork(chainId);
  if (!network) throw new Error(`Unsupported chain ID: ${chainId}`);
  const order = network.access?.readOrder ||
    (myotis.NETWORKS?.has(Number(chainId)) === true
      ? DEFAULT_READ_ORDER
      : DEFAULT_NON_MYOTIS_READ_ORDER);
  const failures = [];
  let lastRpcError = null;

  for (const source of order) {
    try {
      if (source === 'myotis') {
        if (!myotis.isReady(chainId)) throw new SourceUnavailableError('Myotis is not ready');
        const result = await myotis.feeEstimate(chainId);
        const gasPrice = nativeResult(result, 'gasPriceWei', 'gasPrice');
        const priority = optionalNativeResult(
          result,
          'maxPriorityFeePerGasWei',
          'maxPriorityFeePerGas'
        );
        return feeQuote(source, gasPrice, priority);
      }

      if (source === 'direct') return await requestDirectFeeQuote(chainId);

      const gasPrice = await requestSource(source, chainId, 'eth_gasPrice', []);
      let priority = null;
      try {
        priority = await requestSource(source, chainId, 'eth_maxPriorityFeePerGas', []);
      } catch {
        // Preserve source coherence by using this source's gas price as a
        // legacy quote rather than asking the next source for half a quote.
      }
      return feeQuote(source, gasPrice, priority);
    } catch (err) {
      failures.push(`${source}: ${err.message}`);
      // Keep a real node error (with its JSON-RPC code/data) so the caller
      // sees it rather than a stringified aggregate — same as request().
      if (!(err instanceof SourceUnavailableError)) lastRpcError = err;
      log.verbose(`[chain-data] ${chainId} fee quote via ${source} failed: ${err.message}`);
    }
  }

  if (lastRpcError) throw lastRpcError;
  throw new Error(`All chain sources failed for fee quote (${failures.join('; ')})`);
}

async function broadcastRawTransaction(chainId, rawTransaction) {
  const network = registry.getNetwork(chainId);
  if (!network) throw new Error(`Unsupported chain ID: ${chainId}`);
  const order = network.access?.broadcastOrder ||
    (myotis.NETWORKS?.has(Number(chainId)) === true ? DEFAULT_BROADCAST_ORDER : ['direct']);
  const failures = [];
  let lastRpcError = null;
  for (const source of order) {
    try {
      let result;
      if (source === 'myotis') {
        if (!myotis.isReady(chainId)) throw new SourceUnavailableError('Myotis is not ready');
        const payload = await myotis.sendRawTransaction(rawTransaction, chainId);
        result = nativeResult(payload, 'txHash', 'result');
      } else if (source === 'direct') {
        result = await requestDirect(chainId, 'eth_sendRawTransaction', [rawTransaction]);
      } else {
        throw new SourceUnavailableError(`${source} cannot broadcast transactions`);
      }
      return { result, source };
    } catch (err) {
      failures.push(`${source}: ${err.message}`);
      // A node rejection (`nonce too low`, `already known`, …) carries a
      // JSON-RPC code/data the wallet needs — surface the real error rather
      // than the stringified aggregate, matching request().
      if (!(err instanceof SourceUnavailableError)) lastRpcError = err;
      log.verbose(`[chain-data] ${chainId} transaction broadcast via ${source} failed: ${err.message}`);
    }
  }
  if (lastRpcError) throw lastRpcError;
  throw new Error(`All transaction broadcasters failed (${failures.join('; ')})`);
}

module.exports = {
  isReadMethod,
  request,
  getFeeQuote,
  broadcastRawTransaction,
  requestRpcUrl,
  SourceUnavailableError,
  clearAdaptiveRoutingForTest,
};
