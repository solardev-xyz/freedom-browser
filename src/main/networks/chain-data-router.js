const log = require('../logger');
const registry = require('./network-registry');
const myotis = require('../myotis/myotis-manager');
const blockscoutLogs = require('./blockscout-logs');

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

// Stateful filters live on the one node that created them, and web3_* answers
// describe that node, so only a single direct endpoint can serve them: a
// verifier or a quorum has nothing to check them against.
const SINGLE_NODE_METHODS = new Set([
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_uninstallFilter',
  'web3_clientVersion',
  'web3_sha3',
]);
READ_METHODS.add('web3_clientVersion');
READ_METHODS.add('web3_sha3');

// What each read source can serve, consulted before the router tries it
// (#497). One descriptor per source:
//
// - unsupported: methods the source never serves, whatever the params. The
//   router leaves the source out of such a request up front, alongside the
//   caller's own excludeSources (both are named in the error as "excluded for
//   this request"). excludeSources stays the caller's policy (Ant's log scans
//   ask the quorum only); this is the source's capability. A source not
//   listed here serves the method as far as the router knows, and its adapter
//   still refuses what depends on the request (Myotis: which methods its addon
//   version serves, block tags other than `latest`, state overrides, blob
//   transactions; see requestMyotis), which is reported as that source's
//   failure. A Myotis refusal of the request itself is not a source failure:
//   it is the answer (see nativeResult).
// - logSpan: the widest eth_getLogs block span the source serves.
//   'learned-per-endpoint' means each RPC endpoint's cap is learned from its
//   range-limit replies and the source asks only endpoints whose cap covers
//   the span (logRangeState; applied to range-capped log scans, i.e. callers
//   that pass rangeCapOf). null means no limit is tracked.
// - logResults: 'may-truncate' when the source's answer can come back
//   incomplete without an error once the result set is large. Public Gnosis
//   RPCs (rpc.gnosischain.com and gateway.fm alike, measured 2026-10-04 for
//   #496) answer a
//   query matching more than ~50k logs with only the latest ~474 blocks' logs.
//   The router checks such a source's eth_getLogs answer for that shape
//   (checkLogTruncation) before accepting it.
// - cost: what trying the source costs, which decides who may wait for it.
//   'serialized': one native read per chain at a time; background callers
//   (Ant's polling) take it only when idle and never queue (Myotis).
//   'proof': a proof fetched from the prover and verified in a worker thread,
//   with a bounded number in flight (Colibri). 'fanout': k RPC requests per
//   read (quorum). 'single': one RPC request at a time (direct). 'paired':
//   one log-index read (a page per 50 transfers) plus one RPC request, and a
//   quorum read for the newest blocks (blockscout).
// - optIn: the source is in no read order. Only a caller that names it in
//   includeSources is routed to it, right before the quorum, and only while
//   the configured read order keeps the quorum.
//
// blockscout (#529) is Blockscout's Gnosis log index, paired with one RPC
// endpoint. It serves only range-capped log scans (callers passing
// rangeCapOf, i.e. Ant's eth_getLogs through its bridge) whose filter is an
// xBZZ Transfer scan by sender or recipient (blockscout-logs.js
// logIndexFilter), and only a span wider than the RPC quorum can verify now:
// the scan Ant would otherwise read window by window. Blockscout's answer
// alone settles nothing. It is accepted only when an RPC endpoint able to
// serve the span (in practice a full-history one, all of which share one
// backend) returns the identical logs: two independent providers agreeing,
// as the quorum asks of two RPCs. The newest blocks of the span go to the
// quorum itself, so a Blockscout a few blocks behind the head does not
// disagree with the RPC (requestLogIndex).
//   logSpan 'full-history': it serves any span in one answer.
//   logResults 'paged': Blockscout lists a wallet's transfers 50 to a page,
//   read on until the span is covered or the list ends. The RPC half of the
//   pair may cut a large answer short (#496); disagreeing with Blockscout's
//   complete one then fails the pair, so neither half is checked by
//   checkLogTruncation.
//
// Colibri never serves eth_getLogs, whoever asks: its inclusion proofs show
// that each returned log is real, not that none is missing, so a log answer
// its upstream RPC cut short (above) would be labelled verified (#496). That
// covers Ant's log scans and any connected page's window.ethereum eth_getLogs
// alike. (Verification itself no longer blocks the browser: it runs in a
// worker thread since #495, where a wide range used to freeze the main
// process for 20-30 s.)
const COST = Object.freeze({
  SERIALIZED: 'serialized',
  PROOF: 'proof',
  FANOUT: 'fanout',
  SINGLE: 'single',
  PAIRED: 'paired',
});
const NO_METHODS = new Set();
const LOG_SCAN_ONLY = new Set(
  [...READ_METHODS, ...SINGLE_NODE_METHODS].filter((method) => method !== 'eth_getLogs')
);
const SOURCE_CAPABILITIES = Object.freeze({
  myotis: Object.freeze({
    unsupported: SINGLE_NODE_METHODS,
    logSpan: null,
    logResults: null,
    cost: COST.SERIALIZED,
  }),
  colibri: Object.freeze({
    unsupported: new Set([...SINGLE_NODE_METHODS, 'eth_getLogs']),
    // Its upstream refuses more than 10,000 blocks per log query, then retries
    // another node (#496). Not consulted while eth_getLogs is unsupported.
    logSpan: 10_000,
    logResults: 'may-truncate',
    cost: COST.PROOF,
  }),
  quorum: Object.freeze({
    unsupported: SINGLE_NODE_METHODS,
    logSpan: 'learned-per-endpoint',
    logResults: 'may-truncate',
    cost: COST.FANOUT,
  }),
  direct: Object.freeze({
    unsupported: NO_METHODS,
    logSpan: null,
    logResults: 'may-truncate',
    cost: COST.SINGLE,
  }),
  blockscout: Object.freeze({
    unsupported: LOG_SCAN_ONLY,
    logSpan: 'full-history',
    logResults: 'paged',
    cost: COST.PAIRED,
    optIn: true,
  }),
});

// Whether `source` can serve `method` at all. An unknown source is left to
// requestSource, which refuses it as before.
function sourceServesMethod(source, method) {
  return !SOURCE_CAPABILITIES[source]?.unsupported.has(method);
}

const DEFAULT_READ_ORDER = ['myotis', 'colibri', 'quorum', 'direct'];
const DEFAULT_NON_MYOTIS_READ_ORDER = ['colibri', 'quorum', 'direct'];
const DEFAULT_BROADCAST_ORDER = ['myotis', 'direct'];
const INTERACTIVE_SOURCE_DEADLINE_MS = 2000;
const SOURCE_TIMEOUT_COOLDOWNS_MS = [15_000, 30_000, 60_000];
// Route admission is per chain; native admission belongs to each supervised
// Myotis child. The router retains its slot until the manager request settles.
// A deadline stops that generation; it never frees native child capacity.
const MAX_MYOTIS_IN_FLIGHT = 1;
// The queue is still bounded: past this depth the slot is demonstrably not
// turning over inside anyone's deadline, so refuse rather than park unbounded
// work behind a stalled native read.
const MAX_MYOTIS_QUEUED = 16;
const MAX_COLIBRI_IN_FLIGHT = 8;
const MAX_COLIBRI_IN_FLIGHT_PER_ROUTE = 2;
const MAX_ADAPTIVE_SOURCE_ROUTES = 1024;

// These are deliberately process-local. A source that struggles with one
// app's call shape should not reorder the user's chain policy, affect another
// app, or stay demoted after Freedom restarts.
const adaptiveSourceState = new Map();
const myotisSlots = new Map();
const colibriInFlight = new Set();
const colibriInFlightByRoute = new Map();
// What each RPC endpoint can serve for a range-capped log scan (callers that
// pass rangeCapOf, i.e. the bundled Ant node's eth_getLogs through its bridge):
// `${chainId} ${url}` -> { refusedFrom, capUntil, slowFrom, slowUntil,
// coolUntil }. refusedFrom is the smallest block span the endpoint refused as
// a range limit, null while none was, and counts until capUntil. slowFrom is
// the smallest span its own upstream timed out on, and counts only until
// slowUntil (a short while: a busy moment is no range cap). coolUntil keeps an
// endpoint that failed for its own reasons out of these scans for a while.
// Process-local like the adaptive state: nothing is saved, and a cap is
// relearned with one refusal.
const logRangeState = new Map();
// How long a learned cap holds. After that the endpoint is asked for wider
// spans again, so a provider that raises its limit is noticed.
const LOG_RANGE_CAP_TTL_MS = 30 * 60_000;
// How long a log scan leaves out an endpoint that hung, refused the
// connection, throttled or failed some other way that does not depend on the
// requested range, and how long a span its upstream timed out on bounds it.
const LOG_SCAN_COOLDOWN_MS = 30_000;
// Quorum rounds per log scan: the first, and one with the endpoints left
// after the first round's failures were taken out.
const LOG_SCAN_QUORUM_ROUNDS = 2;
// The newest blocks of a scan the blockscout source leaves to the RPC quorum
// (at most what the quorum can verify), so a log index a little behind the
// chain head (about 83 minutes of Gnosis blocks) still agrees with the RPC.
const LOG_INDEX_TAIL_BLOCKS = 1000;
// How long the blockscout source is left alone after its answer disagreed
// with the RPC's. Its other failures name their own cooldown (a rate limit's
// reset, at least a minute).
const LOG_INDEX_DISAGREEMENT_COOLDOWN_MS = 5 * 60_000;
// How long it is left alone after the caller gave up while it was still
// reading (as long as a failure that names no cooldown of its own).
const LOG_INDEX_ABORT_COOLDOWN_MS = 60_000;
// chainId -> time until which the blockscout source is not asked.
const logIndexCoolUntil = new Map();
// How long an RPC endpoint is not asked to be Blockscout's pair after it
// answered a span with an entry not in the exact shape Ant reads: every wide
// window would otherwise re-spend a full-span eth_getLogs on it only to fall
// through to the quorum again.
const LOG_INDEX_PAIR_MALFORMED_COOLDOWN_MS = 30 * 60_000;
// `${chainId}|${url}` -> time until which that endpoint is not a pair.
const logIndexPairCoolUntil = new Map();
const logIndexPairKey = (chainId, url) => `${chainId}|${url}`;

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

// How useful a failure is to a caller that adapts its request to the error
// (the bundled Ant node's log scan halves its eth_getLogs window on a range
// limit or a timeout). The caller supplies rankError(error) -> one of these.
const ERROR_RANK = Object.freeze({
  // Depends on the endpoint, the caller cannot act on it (method not found,
  // internal error, rate limit, HTTP 5xx, transport failure, source not ready).
  ENDPOINT: 0,
  // An endpoint's own reply the caller may act on, though it cannot tell it
  // apart from an endpoint-dependent one (Ant: a range cap worded outside the
  // bridge's known list). Other endpoints are still asked, but it is reported
  // over any endpoint failure, so a later 429 or refused connection cannot
  // hide it.
  HINT: 1,
  // A timeout: the caller can shrink the request and try again.
  TIMEOUT: 2,
  // Depends on the request itself (a range limit): no other endpoint or retry
  // is expected to do better, so it ends the request at once.
  REQUEST: 3,
});

// The single error rule for a ranked request: keep the most useful failure
// seen so far across every tier, endpoint and retry. A later failure replaces
// it only when it ranks strictly higher, so an earlier range limit survives a
// later timeout or 429, an earlier timeout survives a later -32601 and a
// possible range cap (HINT) survives a later transport failure. The
// one equal-rank replacement is timeout by timeout: the later one is the
// attempt that actually ended the request (Direct's widened retry after
// quorum's 5 s cut), so its budget is what the caller and logs should see.
// Only a REQUEST-ranked failure is final. Without rankError nothing is kept and the
// router reports failures exactly as before (wallet reads, broadcasts).
function createErrorKeeper(rankError) {
  let kept = null;
  let keptRank = -1;
  return {
    note(error) {
      if (typeof rankError !== 'function' || !error) return;
      let rank;
      try {
        rank = Number(rankError(error));
      } catch {
        rank = ERROR_RANK.ENDPOINT;
      }
      if (!Number.isFinite(rank)) rank = ERROR_RANK.ENDPOINT;
      if (rank > keptRank || (rank === keptRank && rank === ERROR_RANK.TIMEOUT)) {
        kept = error;
        keptRank = rank;
      }
    },
    get final() {
      return keptRank >= ERROR_RANK.REQUEST;
    },
    // Only a failure the caller can act on replaces the router's own report;
    // endpoint-dependent failures keep the existing aggregate/last-RPC error.
    get error() {
      return keptRank > ERROR_RANK.ENDPOINT ? kept : null;
    },
  };
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

function configuredSourceTimeoutMs(chainId) {
  const network = registry.getNetwork(chainId) || {};
  return Math.max(500, Number(network.quorum?.timeoutMs) || 5000);
}

// The two-second budget is a *fall-through* allowance, not a global ceiling.
// Spending it only pays off when a later source can still answer and a page
// the user is watching is waiting on the result. Applied unconditionally it
// silently downgrades a verified answer to an unverified single-endpoint one
// (any wallet read on a network slower than 2s), and where the source is the
// last one configured it turns a read that would have succeeded into a
// failure. So: cap only an app-driven read that still has somewhere to fall
// through to; everyone else keeps the chain's configured timeout.
function sourceDeadlineMs(chainId, { interactive, hasFallbackSource }) {
  const configured = configuredSourceTimeoutMs(chainId);
  return interactive && hasFallbackSource
    ? Math.min(configured, INTERACTIVE_SOURCE_DEADLINE_MS)
    : configured;
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
  myotisSlots.clear();
  colibriInFlight.clear();
  colibriInFlightByRoute.clear();
  logRangeState.clear();
  logIndexCoolUntil.clear();
  logIndexPairCoolUntil.clear();
}

function blockNumberOf(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const number = Number.parseInt(value, 16);
  return Number.isSafeInteger(number) ? number : null;
}

// The block span an eth_getLogs filter covers (both ends inclusive), or null
// when either end is a tag (`latest`) or missing: such a query is never
// filtered or learned from.
function logQuerySpan(method, params) {
  if (method !== 'eth_getLogs') return null;
  const from = blockNumberOf(params?.[0]?.fromBlock);
  const to = blockNumberOf(params?.[0]?.toBlock);
  return from === null || to === null || to < from ? null : to - from + 1;
}

// A silently truncated eth_getLogs answer (#496, measured 2026-10-04): once a
// query matches more than ~50k logs, public Gnosis RPCs answer with only the latest ~474 blocks'
// logs and no error. Nothing in the answer says so, and a genuinely sparse
// result can look the same (a wallet funded minutes ago, scanned from the
// token's deployment), so the shape alone only makes an answer suspect: every
// log falls in the last LOG_TRUNCATION_TAIL_BLOCKS blocks of a range at least
// LOG_TRUNCATION_MIN_SPAN wide. A suspect answer is checked with one more query
// over the blocks before its oldest log, from the same source. Logs there
// prove the first answer incomplete and the request fails; none (or a failed
// check) accepts it as it is. Only a numeric range is checked: a range ending
// at a tag (`latest`) has no known end without another request.
// The cut depends on how many logs a query matches, not on its span: a window
// halved after one -32005 can still match too many and be cut the same way.
// So the minimum span is only what leaves the tail shape meaningful (at least
// a tail's worth of blocks before it to check), not a size below which
// truncation is assumed away. A range narrower than that is not checked; the
// shape cannot tell a cut answer from a complete one there.
const LOG_TRUNCATION_TAIL_BLOCKS = 1000;
const LOG_TRUNCATION_MIN_SPAN = 2 * LOG_TRUNCATION_TAIL_BLOCKS;

class TruncatedLogsError extends Error {
  constructor({ count, oldestBlock, toBlock, span }) {
    // Worded as a result-count limit (code and "too many logs ... range"), so
    // a caller that narrows its window on one (Ant's log scan, via the
    // bridge's rankLogScanError) does so here too.
    super(
      `query matched too many logs: the RPC returned only the ${count} logs in the last ` +
        `${toBlock - oldestBlock + 1} blocks of the ${span}-block range asked, and earlier ` +
        'blocks match more; narrow the block range'
    );
    this.name = 'TruncatedLogsError';
    this.code = -32005;
  }
}

// The re-query that checks a suspect answer, or null when the answer is not
// suspect.
function logTruncationProbe(method, params, result) {
  const span = logQuerySpan(method, params);
  if (span === null || span < LOG_TRUNCATION_MIN_SPAN) return null;
  if (!Array.isArray(result) || result.length === 0) return null;
  const toBlock = blockNumberOf(params[0].toBlock);
  let oldestBlock = Infinity;
  for (const entry of result) {
    const block = blockNumberOf(entry?.blockNumber);
    if (block === null || block > toBlock) return null;
    oldestBlock = Math.min(oldestBlock, block);
  }
  if (toBlock - oldestBlock >= LOG_TRUNCATION_TAIL_BLOCKS) return null;
  return {
    params: [{ ...params[0], toBlock: `0x${(oldestBlock - 1).toString(16)}` }, ...params.slice(1)],
    span: oldestBlock - blockNumberOf(params[0].fromBlock),
    evidence: { count: result.length, oldestBlock, toBlock, span },
  };
}

const logRangeKey = (chainId, url) => `${Number(chainId)} ${url}`;

// The widest span an endpoint is expected to serve right now: 0 while it
// cools down, Infinity while no cap is known.
function servableLogSpan(chainId, url, now) {
  const entry = logRangeState.get(logRangeKey(chainId, url));
  if (!entry) return Infinity;
  if (entry.coolUntil > now) return 0;
  let span = Infinity;
  if (entry.refusedFrom !== null && entry.capUntil > now) span = entry.refusedFrom - 1;
  if (entry.slowFrom !== null && entry.slowUntil > now) span = Math.min(span, entry.slowFrom - 1);
  return span;
}

// The widest span `m` endpoints can serve together: what a quorum can still
// verify. 0 when fewer than `m` endpoints can serve any span now.
function quorumLogSpan(chainId, urls, m, now) {
  const spans = urls.map((url) => servableLogSpan(chainId, url, now)).sort((a, b) => b - a);
  return spans.length >= m ? spans[m - 1] : 0;
}

// An answer ends a cooldown, and an answer at or above a cap clears it: the
// provider raised its limit, or its upstream is no longer slow.
function noteLogRangeAnswer(chainId, url, span) {
  const key = logRangeKey(chainId, url);
  const entry = logRangeState.get(key);
  if (!entry) return;
  entry.coolUntil = 0;
  if (entry.refusedFrom !== null && span >= entry.refusedFrom) entry.refusedFrom = null;
  if (entry.slowFrom !== null && span >= entry.slowFrom) entry.slowFrom = null;
  if (entry.refusedFrom === null && entry.slowFrom === null) logRangeState.delete(key);
}

// Learn from one endpoint's failed log query. A block-range cap the caller's
// capOf reads from the reply (a number it names, or the span below the one
// asked for a range limit without one) bounds the endpoint for
// LOG_RANGE_CAP_TTL_MS. An upstream query timeout (TIMEOUT-ranked, not this
// client's own) bounds it below the span asked, but only for
// LOG_SCAN_COOLDOWN_MS: the server may have been busy, and a timeout is no
// range limit to hold a scan to for half an hour. A failure that does not
// depend on the range (a hang, refused connection, throttle, missing method,
// lagging node) cools it down instead. Anything else (a reply that may be a
// throttle, or a result-count cap, which depends on the filter rather than
// the endpoint's range) is not learned from.
function noteLogRangeFailure(chainId, url, span, error, { capOf, rank, learn = true }, now) {
  // A truncation check (checkLogTruncation) is the router's own query, not
  // the caller's: its failure is swallowed, and must not cool endpoints down
  // or bound them for the caller's next window either.
  if (!learn) return;
  const key = logRangeKey(chainId, url);
  const entry = logRangeState.get(key) || {
    refusedFrom: null,
    capUntil: 0,
    slowFrom: null,
    slowUntil: 0,
    coolUntil: 0,
  };
  let cap;
  try {
    cap = capOf(error, span);
  } catch {
    cap = null;
  }
  let errorRank;
  try {
    errorRank = Number(rank?.(error));
  } catch {
    errorRank = ERROR_RANK.ENDPOINT;
  }
  const clientTimeout = failureKind(error) === 'timeout';
  if (Number.isSafeInteger(cap) && cap > 0) {
    entry.refusedFrom =
      entry.refusedFrom === null || entry.capUntil <= now
        ? cap + 1
        : Math.min(entry.refusedFrom, cap + 1);
    entry.capUntil = now + LOG_RANGE_CAP_TTL_MS;
  } else if (!clientTimeout && errorRank === ERROR_RANK.TIMEOUT) {
    entry.slowFrom =
      entry.slowFrom === null || entry.slowUntil <= now ? span : Math.min(entry.slowFrom, span);
    entry.slowUntil = now + LOG_SCAN_COOLDOWN_MS;
  } else if (clientTimeout || !(errorRank > ERROR_RANK.ENDPOINT)) {
    entry.coolUntil = now + LOG_SCAN_COOLDOWN_MS;
  } else {
    return;
  }
  logRangeState.set(key, entry);
}

// What a range-capped log scan gets when no quorum can serve its span: a
// range limit naming the widest span one can, so the caller (Ant) narrows
// its window to it. Ranked REQUEST by the bridge, so it ends the request.
function logRangeRefusal(span) {
  const error = new Error(`query exceeds max block range ${span}`);
  error.code = -32005;
  return error;
}

function isReadMethod(method) {
  return READ_METHODS.has(method) || SINGLE_NODE_METHODS.has(method);
}

function quantity(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    return `0x${BigInt(value).toString(16)}`;
  }
  return `0x${BigInt(value || 0).toString(16)}`;
}

// Numeric fields of a JSON-RPC call object are QUANTITYs and have to travel as
// hex. Internal callers work in decimal wei (ethers' parseUnits output), and a
// raw decimal makes strict nodes answer -32602, which silently drops the read
// out of the quorum tier. Normalise once here — the boundary every source
// shares — so all endpoints also see a byte-identical body to agree on.
// `chainId` and `type` are QUANTITYs too, and since ABI 34/35 the Myotis
// engine applies them instead of dropping them: its parser accepts only
// 0x-hex, and its -32602 refusal is final (no fallback), so a dApp's
// `{ chainId: 1 }` or `{ type: 2 }` has to be hex by the time it gets there.
const CALL_OBJECT_METHODS = new Set(['eth_call', 'eth_estimateGas']);
const CALL_QUANTITY_FIELDS = [
  'value',
  'gas',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
  'chainId',
  'type',
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

// Myotis refusals that name a limit of this engine build rather than anything
// wrong with the request: an executor whose fork table disagrees with the
// verified header (ABI 33, EIP-7843 slot number), its own eth_call gas budget,
// and blob transactions it does not execute. Another source can serve these.
const MYOTIS_CAPABILITY_REFUSAL =
  /EIP-7843|fork table|node's \d+-gas call budget|not supported by this node/i;
const MAX_MYOTIS_REFUSAL_MESSAGE = 300;

function myotisRefusalMessage(value, fallback) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_MYOTIS_REFUSAL_MESSAGE)
    : fallback;
}

// A definite answer from verified state, served to the caller instead of being
// retried elsewhere. `myotisRefusal` tells request() not to fall through.
function myotisRefusal(kind, code, message) {
  const error = new Error(message);
  error.code = code;
  error.myotisRefusal = kind;
  return error;
}

// Throws for every Myotis payload that is not a served answer.
function assertMyotisAnswer(payload) {
  if (payload?.status === 'revert') {
    const error = new Error('execution reverted');
    error.code = 3;
    error.data = typeof payload.dataHex === 'string' ? payload.dataHex : '0x';
    throw error;
  }
  // ABI 33+: -32602 is a permanent refusal; no retry and no sync progress
  // changes it. A refusal of the request itself (malformed or contradictory
  // transaction object, chainId for another chain, bad address) goes to the
  // caller as invalid params: a remote RPC that accepted it would do so by
  // ignoring a field, which is how an estimate ends up too low to mine.
  if (payload?.error && payload.code === -32602) {
    const message = myotisRefusalMessage(payload.error, 'invalid params');
    if (MYOTIS_CAPABILITY_REFUSAL.test(message)) {
      throw new SourceUnavailableError(`Myotis cannot execute this request: ${message}`);
    }
    throw myotisRefusal('invalid-params', -32602, message);
  }
  // ABI 34/35: the call or estimate cannot succeed within the caller's own
  // gas, fee cap or funds — geth's -32000 with its wording, like a revert an
  // answer from verified state rather than a failure to answer.
  if (payload?.status === 'infeasible') {
    throw myotisRefusal('infeasible', -32000, myotisRefusalMessage(payload.reason, 'transaction is infeasible'));
  }
  if (!payload || payload.error || ['error', 'unavailable'].includes(payload.status)) {
    throw new SourceUnavailableError('Myotis native read unavailable');
  }
}

function nativeResult(payload, ...keys) {
  assertMyotisAnswer(payload);
  for (const key of keys) {
    if (payload[key] != null) return payload[key];
  }
  throw new Error('Myotis returned an unexpected response');
}

// The state reads (account, code, storage) answer with a full object even
// when nothing was verified: their data keys are an answer only when
// `verifyMethod` is set (myotis-node README, "Serve a state read only with its
// verdict"). Without one there is no answer yet, so another source serves.
function verifiedStateRead(payload) {
  assertMyotisAnswer(payload);
  if (typeof payload.verifyMethod !== 'string' || !payload.verifyMethod) {
    throw new SourceUnavailableError(
      `Myotis read has no verdict (${myotisRefusalMessage(payload.failReason, 'unverified')})`
    );
  }
  return payload;
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

// Freedom requests Myotis account reads at the verified head. Although ABI 32
// also accepts finalized reads, any explicit tag other than `latest` — notably the `pending` nonce
// a new transaction needs — has to come from a source that honours the tag.
function assertMyotisBlockTag(method, blockTag) {
  if (blockTag == null || blockTag === 'latest') return;
  throw new SourceUnavailableError(`Myotis cannot serve ${method} at block "${blockTag}"`);
}

// ABI 34/35: the engine takes the whole transaction object and applies every
// field (gas, fees, nonce, accessList, authorizationList, chainId, type) or
// refuses the request as a permanent -32602 — nothing is dropped any more, so
// the object goes through as the caller sent it (after normalizeParams).
//
// What stays with other sources is what the engine cannot honour: a block
// selector other than `latest` (assertMyotisBlockTag), state overrides (the
// addon takes them, but Freedom has not adopted that path yet), and blob
// transactions, which the engine refuses as unsupported rather than invalid.
const MYOTIS_BLOB_FIELDS = [
  'blobVersionedHashes',
  'maxFeePerBlobGas',
  'blobs',
  'commitments',
  'proofs',
  'sidecar',
];

function assertMyotisCallShape(method, params) {
  assertMyotisBlockTag(method, params[1]);
  if (params[2] != null) {
    throw new SourceUnavailableError(`Myotis cannot serve ${method} with state overrides`);
  }
  const call = params[0];
  if (!call || typeof call !== 'object' || Array.isArray(call)) return;
  for (const field of MYOTIS_BLOB_FIELDS) {
    const value = call[field];
    if (value == null || (Array.isArray(value) && value.length === 0)) continue;
    throw new SourceUnavailableError(`Myotis cannot serve ${method} for a blob transaction ("${field}")`);
  }
}

async function requestMyotis(chainId, method, params) {
  if (!myotis.isReady(chainId)) throw new SourceUnavailableError('Myotis is not ready');

  if (method === 'eth_getBalance' || method === 'eth_getTransactionCount') {
    assertMyotisBlockTag(method, params[1]);
    const account = verifiedStateRead(await myotis.getAccount(params[0], chainId));
    // A proven-absent account has `balanceWei: null` and `nonce: -1`.
    if (account.exists === false) return '0x0';
    const value = method === 'eth_getBalance'
      ? nativeResult(account, 'balanceWei', 'balance')
      : nativeResult(account, 'nonce');
    return quantity(value);
  }

  if (method === 'eth_getCode') {
    assertMyotisBlockTag(method, params[1]);
    const code = verifiedStateRead(await myotis.getCode(params[0], chainId));
    const hex = nativeResult(code, 'codeHex');
    if (typeof hex !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(hex)) {
      throw new SourceUnavailableError('Myotis returned invalid code');
    }
    return hex.toLowerCase();
  }

  if (method === 'eth_getStorageAt') {
    assertMyotisBlockTag(method, params[2]);
    const slot = verifiedStateRead(await myotis.getStorageAt(params[0], params[1], chainId));
    // `valueHex` drops leading zeros and is null for an empty slot; a JSON-RPC
    // answer is the 32-byte word.
    const value = slot.valueHex == null ? '0x0' : slot.valueHex;
    if (typeof value !== 'string' || !/^0x[0-9a-f]{0,64}$/i.test(value)) {
      throw new SourceUnavailableError('Myotis returned an invalid storage value');
    }
    return `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
  }

  if (method === 'eth_call') {
    assertMyotisCallShape(method, params);
    const result = await myotis.ethCallTx({ chainId, tx: params[0] || {}, block: 'latest' });
    return nativeResult(result, 'resultHex', 'result');
  }

  if (method === 'eth_estimateGas') {
    // Same constraint as the account reads and `eth_call`: the estimate is
    // taken against the verified head, so an explicit tag or state overrides
    // go to a source that can honour them.
    assertMyotisCallShape(method, params);
    const result = await myotis.estimateGas({ chainId, tx: params[0] || {}, block: 'latest' });
    const gas = nativeResult(result, 'gas');
    if (!Number.isSafeInteger(gas) || gas < 0) throw new SourceUnavailableError('Myotis returned invalid gas');
    return quantity(gas);
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

function myotisSlotsFor(chainId) {
  if (!myotisSlots.has(chainId)) myotisSlots.set(chainId, { inFlight: 0, waiters: [] });
  return myotisSlots.get(chainId);
}

function releaseMyotisSlot(chainId) {
  const slots = myotisSlotsFor(chainId);
  const next = slots.waiters.shift();
  // Hand the slot straight over rather than counting it down and back up.
  if (next) next();
  else slots.inFlight = Math.max(0, slots.inFlight - 1);
}

// Returns null when the queue is full. `granted` is null when the slot was
// free, so an uncontended read never pays for a timer it cannot need.
function acquireMyotisSlot(chainId, { queue = true } = {}) {
  const slots = myotisSlotsFor(chainId);
  if (slots.inFlight < MAX_MYOTIS_IN_FLIGHT) {
    slots.inFlight += 1;
    return { granted: null, abandon: () => {} };
  }
  if (!queue || slots.waiters.length >= MAX_MYOTIS_QUEUED) return null;
  let grant;
  const granted = new Promise((resolve) => {
    grant = resolve;
  });
  slots.waiters.push(grant);
  return {
    granted,
    abandon: () => {
      const index = slots.waiters.indexOf(grant);
      if (index >= 0) slots.waiters.splice(index, 1);
      // The slot was handed over as the deadline fired: pass it along rather
      // than leaking it to a caller that has already fallen through.
      else granted.then(() => releaseMyotisSlot(chainId));
    },
  };
}

async function requestViaMyotis(
  chainId,
  method,
  params,
  { includeTrust = false, deadlineMs = null, background = false } = {}
) {
  const budgetMs = deadlineMs || configuredSourceTimeoutMs(chainId);
  // Background work (the bundled Ant node's polling) only takes an idle slot
  // of a serialized source and never queues, so it cannot sit ahead of
  // wallet/app reads.
  const slot = acquireMyotisSlot(chainId, {
    queue: !(background && SOURCE_CAPABILITIES.myotis.cost === COST.SERIALIZED),
  });
  if (!slot) {
    throw new SourceUnavailableError(
      background
        ? 'Myotis is busy with interactive reads'
        : 'Myotis has too many reads queued for this workload'
    );
  }
  const startedAt = Date.now();
  if (slot.granted) {
    // One budget covers the queue wait *and* the read, so serializing never
    // costs a caller more than a solo read against the same source would.
    try {
      await withSourceDeadline(slot.granted, 'Myotis', budgetMs);
    } catch (err) {
      slot.abandon();
      throw err;
    }
  }

  const requestPromise = Promise.resolve().then(async () => {
    // Sample the head inside the tracked promise: a native binding that throws
    // synchronously must reject this request (which releases the slot below)
    // rather than escape before the release handler is attached.
    const beforeStatus = includeTrust ? myotis.getStatus?.(chainId) || {} : null;
    const result = await requestMyotis(chainId, method, params);
    if (!includeTrust) return result;
    const afterStatus = myotis.getStatus?.(chainId) || {};
    return { result, trust: myotisTrust(beforeStatus, afterStatus) };
  });
  // A routing deadline limits caller patience, not native health. Keep this
  // slot until the manager settles; its own deadline retains native admission
  // until completion or verified child exit. Fallback can answer meanwhile.
  requestPromise.then(() => releaseMyotisSlot(chainId), () => releaseMyotisSlot(chainId));
  return withSourceDeadline(
    requestPromise,
    'Myotis',
    Math.max(1, budgetMs - (Date.now() - startedAt))
  );
}

async function requestColibri(chainId, method, params, routeKey = null, deadlineMs = null) {
  if (!sourceServesMethod('colibri', method)) {
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
  // A prover call is never left unbounded: without a fall-through budget it
  // still has to settle inside the chain's configured timeout.
  const budgetMs = deadlineMs || configuredSourceTimeoutMs(chainId);
  const requestPromise = Promise.resolve().then(() =>
    requestViaColibri(chainId, method, params, { deadlineMs: budgetMs })
  );
  colibriInFlight.add(requestPromise);
  colibriInFlightByRoute.set(inFlightKey, routeInFlight + 1);
  const release = () => {
    colibriInFlight.delete(requestPromise);
    const remaining = (colibriInFlightByRoute.get(inFlightKey) || 1) - 1;
    if (remaining > 0) colibriInFlightByRoute.set(inFlightKey, remaining);
    else colibriInFlightByRoute.delete(inFlightKey);
  };
  // Verification runs in Colibri's worker thread. Past the deadline the worker
  // host terminates a worker still busy verifying (and, later, one merely
  // still waiting on the prover), so the request settles; keep it tracked
  // until then so repeated page calls cannot accumulate background work.
  requestPromise.then(release, release);
  return withSourceDeadline(requestPromise, 'Colibri', budgetMs);
}

async function requestRpcUrl(url, method, params, timeoutMs, { signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
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
  } catch (err) {
    // Name the client timeout in the message: callers such as Ant's log scan
    // key on "query timeout" to shrink their window instead of giving up.
    if (timedOut && !signal?.aborted) {
      const error = new Error(`RPC query timeout after ${timeoutMs}ms`);
      error.failureKind = 'timeout';
      throw error;
    }
    throw err;
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

// One quorum round: ask `urls` and settle on the first m that agree.
function requestQuorumRound(
  chainId,
  method,
  params,
  {
    urls,
    includeTrust = false,
    allowDirectFallback = false,
    deadlineMs = null,
    keeper = createErrorKeeper(null),
    quorumTimeoutMs = null,
    logRange = null,
  }
) {
  const network = registry.getNetwork(chainId) || {};
  const quorum = network.quorum || {};
  const k = Math.max(1, Number(quorum.k) || 3);
  const m = Math.max(1, Math.min(k, Number(quorum.m) || 2));
  const configuredTimeoutMs = Math.max(500, Number(quorum.timeoutMs) || 5000);
  // A background caller (Ant's log scans) may widen the budget; it is never
  // narrowed below the configured timeout, and an interactive deadline below
  // that still applies.
  const budgetMs = Number.isFinite(quorumTimeoutMs)
    ? Math.max(configuredTimeoutMs, quorumTimeoutMs)
    : configuredTimeoutMs;
  const timeoutMs = deadlineMs && deadlineMs < configuredTimeoutMs ? deadlineMs : budgetMs;
  const endpointTimeoutMs = allowDirectFallback ? configuredTimeoutMs : timeoutMs;

  return new Promise((resolve, reject) => {
    const controllers = urls.map(() => new AbortController());
    const groups = new Map();
    const fulfilledUrls = [];
    const directCandidates = [];
    const errors = [];
    // Per member: whether it answered at all (a result or an RPC-level error,
    // as opposed to timing out or still being in flight when quorum gave up).
    const answered = new Array(urls.length).fill(false);
    let pending = urls.length;
    let finished = false;
    let verificationImpossible = false;
    let verificationTimer;

    const abortPending = () => controllers.forEach((controller) => controller.abort());
    const finish = () => {
      finished = true;
      clearTimeout(verificationTimer);
      abortPending();
    };
    const succeed = (group) => {
      if (finished) return;
      finish();
      if (logRange) {
        for (const url of fulfilledUrls) noteLogRangeAnswer(chainId, url, logRange.span);
      }
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
    const fail = ({ deadline = false } = {}) => {
      if (finished) return;
      // Members still in flight when quorum's own deadline fires were cut off
      // by a timeout; a ranked caller (Ant's log scan) counts that as one.
      if (deadline && pending > 0) {
        const cut = new Error(`RPC query timeout after ${timeoutMs}ms`);
        cut.failureKind = 'timeout';
        keeper.note(cut);
        if (logRange) {
          urls.forEach((url, index) => {
            if (!answered[index]) {
              noteLogRangeFailure(chainId, url, logRange.span, cut, logRange, Date.now());
            }
          });
        }
      }
      finish();
      if (logRange) {
        for (const url of fulfilledUrls) noteLogRangeAnswer(chainId, url, logRange.span);
      }
      const capacityFailures = errors.filter(isCapacityFailure).length;
      const timedOut = errors.some((error) => failureKind(error) === 'timeout');
      const error = new SourceUnavailableError(
        `RPC quorum did not reach ${m} matching responses`,
        capacityFailures >= m ? 'capacity' : timedOut ? 'timeout' : null
      );
      // Members that never answered were cut at quorum's budget. A caller that
      // widened Direct's per-URL budget may try them again; ones that did
      // answer would only repeat the same reply.
      error.directUnansweredUrls = urls.filter((_, index) => !answered[index]);
      // Direct would accept one endpoint's answer without agreement. Preserve
      // the highest-priority successful quorum member so the next configured
      // Direct tier can reuse it rather than issuing the same RPC again.
      const directFallback = directCandidates.sort((a, b) => a.index - b.index)[0];
      if (directFallback) {
        const fallbackKey = stableValue(directFallback.result);
        error.directFallback = {
          ...directFallback,
          agreedUrls: directCandidates
            .filter((candidate) => stableValue(candidate.result) === fallbackKey)
            .map((candidate) => candidate.url),
          dissentedUrls: directCandidates
            .filter((candidate) => stableValue(candidate.result) !== fallbackKey)
            .map((candidate) => candidate.url),
          queriedUrls: urls,
          quorum: { k: urls.length, m, achieved: false },
        };
      }
      error.directAttemptedUrls = urls;
      reject(error);
    };
    const rejectIfImpossible = () => {
      if (finished) return;
      const largestGroup = Math.max(0, ...[...groups.values()].map((group) => group.count));
      if (largestGroup + pending >= m) return;
      verificationImpossible = true;
      // If every completed member failed, let an already-running member finish
      // within Direct's compatibility budget. Its answer cannot restore
      // quorum, but it can satisfy the Direct tier without a duplicate request.
      // A request-dependent failure (a range limit) ends the request, so there
      // is nothing for that member's answer to feed.
      if (!allowDirectFallback || directCandidates.length || pending === 0 || keeper.final) {
        fail();
      }
    };

    verificationTimer = setTimeout(() => {
      if (finished) return;
      verificationImpossible = true;
      if (!allowDirectFallback || directCandidates.length || pending === 0) {
        fail({ deadline: true });
      }
    }, timeoutMs);

    urls.forEach((url, index) => {
      requestRpcUrl(url, method, params, endpointTimeoutMs, {
        signal: controllers[index].signal,
      }).then(
        (value) => {
          if (finished) return;
          pending -= 1;
          answered[index] = true;
          fulfilledUrls.push(url);
          directCandidates.push({ index, url, result: value });
          const key = stableValue(value);
          const group = groups.get(key) || { count: 0, value, urls: [] };
          group.count += 1;
          group.urls.push(url);
          groups.set(key, group);
          if (group.count >= m) succeed(group);
          else if (verificationImpossible) fail();
          else rejectIfImpossible();
        },
        (error) => {
          if (finished) return;
          pending -= 1;
          errors.push(error);
          keeper.note(error);
          if (logRange) {
            noteLogRangeFailure(chainId, url, logRange.span, error, logRange, Date.now());
          }
          if (failureKind(error) !== 'timeout') answered[index] = true;
          rejectIfImpossible();
        }
      );
    });
  });
}

async function requestQuorum(chainId, method, params, options = {}) {
  const network = registry.getNetwork(chainId) || {};
  const k = Math.max(1, Number(network.quorum?.k) || 3);
  const m = Math.max(1, Math.min(k, Number(network.quorum?.m) || 2));
  const endpoints = registry.getEndpoints(chainId, 'rpc');
  const { logRange = null, keeper = createErrorKeeper(null) } = options;
  const askQuorum = (urls) =>
    requestQuorumRound(chainId, method, params, { ...options, keeper, urls });

  if (endpoints.length < m) throw new SourceUnavailableError(`RPC quorum needs ${m} endpoints`);
  if (!logRange) return askQuorum(endpoints.slice(0, k));

  // A range-capped log scan asks the first k endpoints able to serve its span.
  // A round whose members failed has just taken them out (capped or cooling);
  // if another quorum can serve the same span, it is asked straight away.
  // When none can, the caller is told the widest span a quorum can still
  // verify, so it narrows to it instead of giving up (one full-range endpoint
  // down shrinks the scan to windows the capped ones serve). Only when no
  // quorum can serve any span does the caller get no quorum.
  const noQuorum = (lastError) => {
    const servable = quorumLogSpan(chainId, endpoints, m, Date.now());
    if (servable > 0 && servable < logRange.span) {
      const refusal = logRangeRefusal(servable);
      keeper.note(refusal);
      return refusal;
    }
    return lastError || new SourceUnavailableError(`No RPC quorum available for ${method}`);
  };
  // `endsAt` (a Date.now() instant) caps the rounds together rather than
  // each: a later round runs only on what is left of it, and not at all once
  // less than the configured quorum timeout is left (requestQuorumRound never
  // runs a round shorter than that).
  const { endsAt = null } = options;
  let asked = null;
  let lastError = null;
  for (let round = 1; round <= LOG_SCAN_QUORUM_ROUNDS; round += 1) {
    const now = Date.now();
    const urls = endpoints
      .filter((url) => servableLogSpan(chainId, url, now) >= logRange.span)
      .slice(0, k);
    if (urls.length < m || (asked && urls.every((url) => asked.includes(url)))) break;
    let roundOptions = options;
    if (endsAt !== null && round > 1) {
      const leftMs = endsAt - now;
      if (leftMs < configuredSourceTimeoutMs(chainId)) break;
      roundOptions = { ...options, quorumTimeoutMs: leftMs };
    }
    try {
      return await requestQuorumRound(chainId, method, params, { ...roundOptions, keeper, urls });
    } catch (err) {
      asked = urls;
      lastError = err;
    }
  }
  throw noQuorum(lastError);
}

const blockHex = (block) => `0x${block.toString(16)}`;

// The blockscout source (#529; see SOURCE_CAPABILITIES): answers a
// range-capped xBZZ Transfer scan wider than the RPC quorum can verify with
// two independent providers that agree, instead of the quorum's range refusal
// that has Ant read the span window by window.
//
// The span [from, to] is split. [from, to - tail] is read from one RPC
// endpoint whose cap covers it (in registry order; a failure is learned from
// as a quorum member's is, and the next one is asked) and then, once one has
// answered, from Blockscout. The two must list the same logs, identical in every field
// Blockscout reports (blockscout-logs.js logsAgree); the RPC's entries, cut
// to exactly those fields (agreedRpcLogs: no transaction index, which
// Blockscout does not report), are what the caller gets. The newest `tail`
// blocks (at most LOG_INDEX_TAIL_BLOCKS, and never more than the quorum can
// verify) are read from the RPC quorum as an ordinary range-capped scan. Any failure is a
// SourceUnavailableError and the request goes on to the quorum exactly as
// without this source: Blockscout down, rate limited or disagreeing (then it
// is left alone for a while: logIndexCoolUntil), no endpoint to pair it with,
// or the quorum failing the newest blocks. Its failures are not ranked for
// the caller (request() leaves them out of the error keeper): they say
// nothing about the caller's query, and the quorum that follows explains
// itself.
async function requestLogIndex(chainId, method, params, options = {}) {
  const { includeTrust = false, logRange = null, signal, quorumTimeoutMs = null } = options;
  const filter = method === 'eth_getLogs' ? blockscoutLogs.logIndexFilter(chainId, params) : null;
  if (!logRange || !filter) {
    throw new SourceUnavailableError(
      'Blockscout serves only range-capped xBZZ Transfer scans by sender or recipient'
    );
  }
  const now = Date.now();
  if ((logIndexCoolUntil.get(chainId) || 0) > now) {
    throw new SourceUnavailableError('Blockscout is left alone for a while after its last failure');
  }
  const network = registry.getNetwork(chainId) || {};
  const k = Math.max(1, Number(network.quorum?.k) || 3);
  const m = Math.max(1, Math.min(k, Number(network.quorum?.m) || 2));
  const endpoints = registry.getEndpoints(chainId, 'rpc');
  if (endpoints.length < m) throw new SourceUnavailableError(`RPC quorum needs ${m} endpoints`);
  const quorumSpan = quorumLogSpan(chainId, endpoints, m, now);
  if (quorumSpan >= logRange.span) {
    throw new SourceUnavailableError('the RPC quorum can verify this span itself');
  }
  if (quorumSpan < 1) {
    throw new SourceUnavailableError('no RPC quorum can verify the newest blocks');
  }
  const tail = Math.min(quorumSpan, LOG_INDEX_TAIL_BLOCKS);
  const pairTo = filter.toBlock - tail;
  const pairSpan = pairTo - filter.fromBlock + 1;
  const pairUrls = endpoints.filter(
    (url) =>
      servableLogSpan(chainId, url, now) >= pairSpan &&
      (logIndexPairCoolUntil.get(logIndexPairKey(chainId, url)) || 0) <= now
  );
  if (!pairUrls.length) {
    throw new SourceUnavailableError('no RPC endpoint serves this span to compare Blockscout with');
  }
  const pairParams = [{ ...params[0], toBlock: blockHex(pairTo) }];
  // One budget (the caller's widened quorum budget) covers the whole source:
  // the pair (the RPC, then every Blockscout page) runs inside it less the
  // configured quorum timeout, which is held back for the newest blocks'
  // quorum (requestQuorum never runs one shorter than that), and that quorum's
  // rounds share what is left (endsAt). So the source costs at most one
  // quorum budget before the quorum after it is asked, inside the bridge's own
  // deadline.
  const configuredMs = configuredSourceTimeoutMs(chainId);
  const budgetMs = Math.max(configuredMs, Number(quorumTimeoutMs) || 0);
  const startedAt = Date.now();
  const leftMs = () => budgetMs - (Date.now() - startedAt);
  const remainingMs = () => {
    const left = leftMs() - configuredMs;
    if (left < 1000) throw new SourceUnavailableError('Blockscout pairing ran out of time');
    return left;
  };
  // The RPC's entries (cut by agreedRpcLogs) are what Ant gets: an answer
  // with one not in the exact shape Ant reads is not taken (nor credited as
  // covering the span); that endpoint is not asked to pair again for a while
  // (LOG_INDEX_PAIR_MALFORMED_COOLDOWN_MS) and the next one is tried. No
  // Blockscout request is spent on it, and Blockscout, not at fault, is not
  // left alone for it.
  const askPairRpc = async () => {
    let lastError;
    for (const url of pairUrls) {
      signal?.throwIfAborted();
      let result;
      try {
        result = await requestRpcUrl(url, method, pairParams, remainingMs(), { signal });
      } catch (err) {
        signal?.throwIfAborted();
        if (err instanceof SourceUnavailableError) throw err;
        lastError = err;
        noteLogRangeFailure(chainId, url, pairSpan, err, logRange, Date.now());
        continue;
      }
      if (!blockscoutLogs.rpcTransferLogsWellFormed(result)) {
        logIndexPairCoolUntil.set(
          logIndexPairKey(chainId, url),
          Date.now() + LOG_INDEX_PAIR_MALFORMED_COOLDOWN_MS
        );
        lastError = new Error(`${endpointHost(url)} answered the span with a malformed log entry`);
        continue;
      }
      noteLogRangeAnswer(chainId, url, pairSpan);
      return { url, result };
    }
    throw lastError;
  };
  // The RPC first: Blockscout's keyless rate limit is shared by every page of
  // its answer, so it is spent only on a span an RPC has already answered.
  let rpc;
  try {
    rpc = await askPairRpc();
  } catch (err) {
    signal?.throwIfAborted();
    throw new SourceUnavailableError(
      `no RPC endpoint answered the span to compare Blockscout with: ${safeErrorMessage(err)}`
    );
  }
  let indexed;
  try {
    indexed = await blockscoutLogs.fetchBlockscoutTransferLogs(filter, pairTo, {
      signal,
      timeoutMs: remainingMs(),
    });
  } catch (err) {
    // The caller gave up while Blockscout was still reading: it was too slow
    // for this scan, so the next window does not wait on it again.
    if (signal?.aborted) {
      logIndexCoolUntil.set(chainId, Date.now() + LOG_INDEX_ABORT_COOLDOWN_MS);
    }
    signal?.throwIfAborted();
    if (err instanceof SourceUnavailableError) throw err;
    const coolMs = Number(err?.coolMs);
    if (Number.isFinite(coolMs) && coolMs > 0) logIndexCoolUntil.set(chainId, Date.now() + coolMs);
    throw new SourceUnavailableError(`Blockscout: ${safeErrorMessage(err)}`);
  }
  if (!blockscoutLogs.logsAgree(indexed, rpc.result)) {
    logIndexCoolUntil.set(chainId, Date.now() + LOG_INDEX_DISAGREEMENT_COOLDOWN_MS);
    const count = Array.isArray(rpc.result) ? rpc.result.length : 'no';
    throw new SourceUnavailableError(
      `Blockscout (${indexed.length} logs) and ${endpointHost(rpc.url)} (${count} logs) disagree`
    );
  }
  let newest;
  try {
    newest = await requestQuorum(
      chainId,
      method,
      [{ ...params[0], fromBlock: blockHex(pairTo + 1) }],
      {
        quorumTimeoutMs: Math.max(configuredMs, leftMs()),
        endsAt: startedAt + budgetMs,
        keeper: createErrorKeeper(logRange.rank),
        logRange: { ...logRange, span: tail },
      }
    );
  } catch (err) {
    signal?.throwIfAborted();
    throw new SourceUnavailableError(
      `RPC quorum did not verify the newest ${tail} blocks: ${safeErrorMessage(err)}`
    );
  }
  signal?.throwIfAborted();
  if (!Array.isArray(newest)) {
    throw new SourceUnavailableError('RPC quorum answered the newest blocks without a log list');
  }
  // The quorum's entries reach Ant too, and agreement alone does not make
  // them well formed: they meet the same shape as the pair's.
  if (!blockscoutLogs.rpcTransferLogsWellFormed(newest)) {
    throw new SourceUnavailableError(
      `RPC quorum answered the newest ${tail} blocks with a malformed log entry`
    );
  }
  // Only what the pair compared is delivered as verified; the quorum's
  // entries were compared whole by its members.
  const result = [...blockscoutLogs.agreedRpcLogs(rpc.result), ...newest];
  if (!includeTrust) return result;
  const agreed = [blockscoutLogs.logIndexHost(chainId), endpointHost(rpc.url)].filter(Boolean);
  return {
    result,
    trust: {
      level: 'verified',
      method: 'blockscout',
      block: null,
      agreed,
      dissented: [],
      queried: agreed,
      quorum: { k: 2, m: 2, achieved: true },
    },
  };
}

function directResponse(chainId, url, result, includeTrust, evidence = null) {
  if (!includeTrust) return result;
  const host = endpointHost(url);
  const userConfigured = isUserConfiguredRpc(chainId, url);
  const agreed = evidence?.agreedUrls?.map(endpointHost).filter(Boolean) || (host ? [host] : []);
  const dissented = evidence?.dissentedUrls?.map(endpointHost).filter(Boolean) || [];
  const queried = evidence?.queriedUrls?.map(endpointHost).filter(Boolean) || (host ? [host] : []);
  return {
    result,
    trust: {
      level: userConfigured ? 'user-configured' : 'unverified',
      method: 'direct',
      block: null,
      agreed,
      dissented,
      queried,
      quorum: evidence?.quorum || { k: 1, m: 1, achieved: false },
    },
  };
}

function configuredDirectTimeoutMs(chainId) {
  const network = registry.getNetwork(chainId) || {};
  return Math.max(500, Number(network.quorum?.timeoutMs) || 5000);
}

// A background caller (Ant's log scans) may widen the per-URL budget; it is
// never narrowed below the configured timeout.
function directUrlTimeoutMs(chainId, requestedTimeoutMs) {
  const configuredTimeoutMs = configuredDirectTimeoutMs(chainId);
  return Number.isFinite(requestedTimeoutMs)
    ? Math.max(configuredTimeoutMs, requestedTimeoutMs)
    : configuredTimeoutMs;
}

async function requestDirect(
  chainId,
  method,
  params,
  {
    includeTrust = false,
    directFallback = null,
    attemptedUrls = [],
    unansweredUrls = [],
    keeper = createErrorKeeper(null),
    signal,
    timeoutMs: requestedTimeoutMs = null,
    // Optional sink: set to { url } of the endpoint whose answer is returned,
    // so a follow-up query (checkLogTruncation) can go back to that endpoint.
    answeredBy = null,
  } = {}
) {
  const configuredTimeoutMs = configuredDirectTimeoutMs(chainId);
  const timeoutMs = directUrlTimeoutMs(chainId, requestedTimeoutMs);
  const urls = registry.getEndpoints(chainId, 'rpc');
  if (!urls.length) throw new SourceUnavailableError('No RPC endpoint configured');
  if (directFallback && urls.includes(directFallback.url) &&
      Object.prototype.hasOwnProperty.call(directFallback, 'result')) {
    if (answeredBy) answeredBy.url = directFallback.url;
    return directResponse(
      chainId,
      directFallback.url,
      directFallback.result,
      includeTrust,
      directFallback
    );
  }
  const attempted = new Set(attemptedUrls);
  // Endpoints quorum never asked go first, in registry order. With a widened
  // budget, the ones quorum cut off at the configured timeout then get their
  // longer attempt. They go last: they already failed to answer once, and a
  // caller's overall deadline (the Ant bridge's) may only fit one or two long
  // attempts, which must not all be spent on endpoints that are likely down.
  // Any failure short of a request-dependent one (see createErrorKeeper)
  // falls through to the next endpoint, so a healthy later endpoint stays
  // reachable whatever the earlier ones answered.
  const retried = timeoutMs > configuredTimeoutMs ? new Set(unansweredUrls) : new Set();
  const untried = urls.filter((url) => !attempted.has(url));
  const retries = urls.filter((url) => attempted.has(url) && retried.has(url));
  let lastError;
  for (const url of [...untried, ...retries]) {
    signal?.throwIfAborted();
    try {
      const result = await requestRpcUrl(url, method, params, timeoutMs, { signal });
      if (answeredBy) answeredBy.url = url;
      return directResponse(chainId, url, result, includeTrust);
    } catch (err) {
      signal?.throwIfAborted();
      lastError = err;
      keeper.note(err);
      if (keeper.final) throw keeper.error;
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
  {
    includeTrust = false,
    routeKey = null,
    directFallback = null,
    directAttemptedUrls = [],
    directUnansweredUrls = [],
    keeper,
    allowDirectFallback = false,
    deadlineMs = null,
    signal,
    background = false,
    directTimeoutMs = null,
    quorumTimeoutMs = null,
    logRange = null,
    directAnsweredBy = null,
  } = {}
) {
  if (source === 'myotis') {
    return requestViaMyotis(chainId, method, params, {
      includeTrust,
      deadlineMs,
      background,
    });
  }
  if (source === 'colibri') {
    const result = await requestColibri(chainId, method, params, routeKey, deadlineMs);
    return includeTrust ? { result, trust: colibriTrust(chainId) } : result;
  }
  if (source === 'quorum') {
    return requestQuorum(chainId, method, params, {
      includeTrust,
      allowDirectFallback,
      deadlineMs,
      keeper,
      quorumTimeoutMs,
      logRange,
    });
  }
  if (source === 'blockscout') {
    return requestLogIndex(chainId, method, params, {
      includeTrust,
      logRange,
      signal,
      quorumTimeoutMs,
    });
  }
  if (source === 'direct') {
    return requestDirect(chainId, method, params, {
      includeTrust,
      directFallback,
      attemptedUrls: directAttemptedUrls,
      unansweredUrls: directUnansweredUrls,
      keeper,
      signal,
      timeoutMs: directTimeoutMs,
      answeredBy: directAnsweredBy,
    });
  }
  throw new SourceUnavailableError(`Unknown chain source: ${source}`);
}

// Throws TruncatedLogsError when `source` answered `params` with a suspect
// eth_getLogs result (logTruncationProbe) and the same source finds logs in
// the blocks before the answer's oldest one. The check is best effort: when it
// fails, the answer is accepted as before, and nothing is learned from the
// failure (a check that timed out must not cool the endpoints down for the
// caller's next window).
//
// Myotis, Colibri and the quorum bound themselves by `deadlineMs`; Direct only
// bounds each endpoint, and would try every configured URL in turn. So a
// Direct check asks only the endpoint that gave the answer (`directUrl`) — the
// one whose cut is in question, and the only one known to be answering — and
// gets one attempt's worth of wall clock (the source deadline, or the caller's
// wider per-URL budget): an answer already in hand must not wait on N slow
// endpoints just to be double-checked, and a hung endpoint ahead of the
// answering one in the registry must not use up the check's one attempt.
async function checkLogTruncation(source, chainId, method, params, result, options) {
  const probe = logTruncationProbe(method, params, result);
  if (!probe) return;
  const { logRange, directUrl, ...rest } = options;
  let checkSignal = options.signal;
  let releaseBound = () => {};
  if (source === 'direct') {
    const boundMs = Math.max(
      Number(options.deadlineMs) || configuredSourceTimeoutMs(chainId),
      Number(options.directTimeoutMs) || 0
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, boundMs);
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener?.('abort', abort, { once: true });
    checkSignal = controller.signal;
    releaseBound = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', abort);
    };
  }
  let earlier;
  try {
    earlier = source === 'direct' && directUrl
      ? await requestRpcUrl(
        directUrl,
        method,
        probe.params,
        directUrlTimeoutMs(chainId, options.directTimeoutMs),
        { signal: checkSignal }
      )
      : await requestSource(source, chainId, method, probe.params, {
        ...rest,
        signal: checkSignal,
        logRange: logRange && SOURCE_CAPABILITIES[source]?.logSpan === 'learned-per-endpoint'
          ? { ...logRange, span: probe.span, learn: false }
          : null,
      });
  } catch (err) {
    options.signal?.throwIfAborted();
    log.verbose(
      `[chain-data] ${chainId} ${method} via ${source}: truncation check failed, ` +
        `answer accepted: ${safeErrorMessage(err)}`
    );
    return;
  } finally {
    releaseBound();
  }
  if (Array.isArray(earlier) && earlier.length > 0) {
    throw new TruncatedLogsError(probe.evidence);
  }
}

async function request(
  chainId,
  method,
  rawParams = [],
  {
    includeTrust = false,
    routingContext = null,
    signal,
    background = false,
    directTimeoutMs = null,
    // Widens the quorum tier's budget for background work (never narrows it).
    quorumTimeoutMs = null,
    // Optional error -> ERROR_RANK classifier. When set, the most useful
    // failure across every tier and retry is kept and reported, and a
    // REQUEST-ranked one ends the request (see createErrorKeeper).
    rankError = null,
    // Sources this caller must never be routed to, e.g. everything but the
    // RPC quorum for Ant's log scans.
    excludeSources = [],
    // Opt-in sources (SOURCE_CAPABILITIES optIn) this caller may be routed
    // to, right before the quorum: Ant's log scans name 'blockscout'.
    includeSources = [],
    // Optional (error, span) -> the widest block span the refusing endpoint
    // serves (a cap it named, or span - 1 for a range limit without one), or
    // null when the reply is no block-range limit (a result-count cap, a
    // throttle). With rankError, it makes an eth_getLogs over a numeric block
    // range a range-capped log scan: the quorum learns each endpoint's cap
    // and asks only endpoints that can serve the span (see logRangeState).
    rangeCapOf = null,
  } = {}
) {
  if (!isReadMethod(method)) throw new Error(`Unsupported read method: ${method}`);
  const network = registry.getNetwork(chainId);
  if (!network) throw new Error(`Unsupported chain ID: ${chainId}`);
  const params = normalizeParams(method, rawParams);
  const supportsMyotis = myotis.NETWORKS?.has(Number(chainId)) === true;
  const readOrder = network.access?.readOrder ||
    (supportsMyotis ? DEFAULT_READ_ORDER : DEFAULT_NON_MYOTIS_READ_ORDER);
  const span =
    typeof rangeCapOf === 'function' && typeof rankError === 'function'
      ? logQuerySpan(method, params)
      : null;
  const logRange = span === null ? null : { span, capOf: rangeCapOf, rank: rankError };
  // An opt-in source joins only a request it can serve at all, so one it
  // never could does not show up among the failures.
  const optIn = [...new Set(includeSources)].filter(
    (source) =>
      SOURCE_CAPABILITIES[source]?.optIn &&
      !readOrder.includes(source) &&
      (source !== 'blockscout' ||
        (logRange !== null && blockscoutLogs.logIndexFilter(chainId, params) !== null))
  );
  const configuredOrder = readOrder.flatMap((source) =>
    source === 'quorum' ? [...optIn, source] : [source]
  );
  // The caller's policy and each source's capability (SOURCE_CAPABILITIES)
  // both take a source out before it is tried.
  const excluded = new Set(excludeSources);
  for (const source of configuredOrder) {
    if (!sourceServesMethod(source, method)) excluded.add(source);
  }
  const order = configuredOrder.filter((source) => !excluded.has(source));
  const dropped = configuredOrder.filter((source) => excluded.has(source));
  const excludedNote = dropped.length ? `excluded for this request: ${dropped.join(', ')}` : null;
  if (order.length === 0) {
    throw new Error(
      `No chain source left for ${method} on chain ${chainId}: read order ` +
        `[${configuredOrder.join(', ')}], ${excludedNote}`
    );
  }
  // Only a page-driven read (an app supplies its routing context) trades
  // verification for interactive latency. Wallet-internal reads have no user
  // watching a frame and keep the chain's configured timeout.
  const interactive = normalizeRoutingOrigin(routingContext) !== null;
  const failures = [];
  let lastRpcError = null;
  let directFallback = null;
  let directAttemptedUrls = [];
  let directUnansweredUrls = [];
  const keeper = createErrorKeeper(rankError);
  for (let sourceIndex = 0; sourceIndex < order.length; sourceIndex += 1) {
    signal?.throwIfAborted();
    const source = order[sourceIndex];
    const routeKey = source === 'myotis' || source === 'colibri' || source === 'quorum'
      ? adaptiveRouteKey(source, chainId, method, params, routingContext)
      : null;
    if (adaptiveSourceUnavailable(routeKey)) {
      failures.push(`${source}: temporarily bypassed for this app workload`);
      continue;
    }
    const directAnsweredBy = {};
    try {
      const sourceResult = await requestSource(source, Number(chainId), method, params, {
        directAnsweredBy: source === 'direct' ? directAnsweredBy : null,
        signal,
        background,
        directTimeoutMs,
        quorumTimeoutMs,
        logRange: ['learned-per-endpoint', 'full-history'].includes(
          SOURCE_CAPABILITIES[source]?.logSpan
        )
          ? logRange
          : null,
        includeTrust,
        routeKey,
        directFallback: source === 'direct' ? directFallback : null,
        directAttemptedUrls: source === 'direct' ? directAttemptedUrls : [],
        directUnansweredUrls: source === 'direct' ? directUnansweredUrls : [],
        keeper,
        allowDirectFallback: source === 'quorum' && order[sourceIndex + 1] === 'direct',
        deadlineMs: sourceDeadlineMs(Number(chainId), {
          interactive,
          hasFallbackSource: sourceIndex + 1 < order.length,
        }),
      });
      signal?.throwIfAborted();
      const result = includeTrust ? sourceResult.result : sourceResult;
      if (SOURCE_CAPABILITIES[source]?.logResults === 'may-truncate') {
        await checkLogTruncation(source, Number(chainId), method, params, result, {
          signal,
          background,
          directTimeoutMs,
          quorumTimeoutMs,
          logRange,
          directUrl: directAnsweredBy.url || null,
          deadlineMs: sourceDeadlineMs(Number(chainId), {
            interactive,
            hasFallbackSource: sourceIndex + 1 < order.length,
          }),
        });
        signal?.throwIfAborted();
      }
      recordAdaptiveSuccess(routeKey);
      return {
        result,
        source,
        verified: ['myotis', 'colibri', 'quorum', 'blockscout'].includes(source),
        ...(includeTrust && sourceResult.trust ? { trust: sourceResult.trust } : {}),
      };
    } catch (err) {
      signal?.throwIfAborted();
      // A revert, a permanent -32602 refusal or an infeasible call is
      // Myotis's answer from verified state: serve it, never retry it at a
      // source that would have to ignore part of the request to differ.
      if (source === 'myotis' && (err.code === 3 || err.myotisRefusal)) throw err;
      if (source === 'quorum') {
        if (err.directFallback) directFallback = err.directFallback;
        if (Array.isArray(err.directAttemptedUrls)) {
          directAttemptedUrls = err.directAttemptedUrls;
        }
        if (Array.isArray(err.directUnansweredUrls)) {
          directUnansweredUrls = err.directUnansweredUrls;
        }
      }
      recordAdaptiveFailure(routeKey, err);
      const message = safeErrorMessage(err);
      failures.push(`${source}: ${message}`);
      if (!(err instanceof SourceUnavailableError)) lastRpcError = err;
      // Quorum already reported each member's failure; its own aggregate is
      // not an upstream error. The blockscout source's failures say nothing
      // about the caller's query (requestLogIndex): the quorum after it
      // answers or explains.
      if (source !== 'quorum' && source !== 'blockscout') keeper.note(err);
      log.verbose(`[chain-data] ${chainId} ${method} via ${source} failed: ${message}`);
      // A truncated answer depends on how many logs the query matches, not on
      // the source: the RPCs behind every later source cut it the same way.
      if (err instanceof TruncatedLogsError) throw err;
      // A request-dependent failure (a range limit) is final: later sources
      // would only repeat it or delay it. The one exception is a quorum
      // member's result Direct reuses without a new request: an answer beats
      // any error.
      if (keeper.final && !(directFallback && order[sourceIndex + 1] === 'direct')) break;
    }
  }
  if (keeper.error) throw keeper.error;
  if (lastRpcError) throw lastRpcError;
  throw new Error(
    `All chain sources failed for ${method} ` +
      `(${[...failures, excludedNote].filter(Boolean).join('; ')})`
  );
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

async function broadcastRawTransaction(chainId, rawTransaction, { signal } = {}) {
  const network = registry.getNetwork(chainId);
  if (!network) throw new Error(`Unsupported chain ID: ${chainId}`);
  const order = network.access?.broadcastOrder ||
    (myotis.NETWORKS?.has(Number(chainId)) === true ? DEFAULT_BROADCAST_ORDER : ['direct']);
  const failures = [];
  let lastRpcError = null;
  for (const source of order) {
    signal?.throwIfAborted();
    try {
      let result;
      if (source === 'myotis') {
        if (!myotis.isReady(chainId)) throw new SourceUnavailableError('Myotis is not ready');
        const payload = await myotis.sendRawTransaction(rawTransaction, chainId);
        try { result = nativeResult(payload, 'txHash', 'result'); }
        catch {
          const error = new Error('Myotis broadcast outcome uncertain; reconcile the original signed transaction');
          error.code = 'MYOTIS_BROADCAST_UNCERTAIN';
          throw error;
        }
      } else if (source === 'direct') {
        result = await requestDirect(chainId, 'eth_sendRawTransaction', [rawTransaction], { signal });
      } else {
        throw new SourceUnavailableError(`${source} cannot broadcast transactions`);
      }
      return { result, source };
    } catch (err) {
      signal?.throwIfAborted();
      // Uncertain: the transaction may be out there. Rejected (ABI 36): Myotis
      // judged it unpayable or its nonce used on verified state and sent
      // nothing; another broadcaster would only add an unverified second opinion.
      if (err.code === 'MYOTIS_BROADCAST_UNCERTAIN' || err.myotisRefusal) throw err;
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
  ERROR_RANK,
  SOURCE_CAPABILITIES,
  LOG_TRUNCATION_TAIL_BLOCKS,
  LOG_TRUNCATION_MIN_SPAN,
  LOG_RANGE_CAP_TTL_MS,
  LOG_SCAN_COOLDOWN_MS,
  LOG_INDEX_TAIL_BLOCKS,
  LOG_INDEX_DISAGREEMENT_COOLDOWN_MS,
  LOG_INDEX_PAIR_MALFORMED_COOLDOWN_MS,
  clearAdaptiveRoutingForTest,
};
