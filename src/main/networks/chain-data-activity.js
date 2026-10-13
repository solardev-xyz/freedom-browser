/**
 * Which chain-data reads were running — for the event-loop watchdog (#498).
 *
 * `instrumentChainData(chainData)` wraps chain data's exported
 * `request()`, `getFeeQuote()` and `broadcastRawTransaction()`
 * (chain-data.js) once, from the outside: every caller in the main process
 * reaches them as properties of the module object at call time
 * (`chainData.request(...)`, `router.request(...)`, a
 * `chainRequest = chainData.request` default parameter,
 * `chainData.getFeeQuote(...)`, `router.broadcastRawTransaction(...)`), so
 * wrapping the exports covers them all without touching the module itself.
 *
 * What it can see from out here: chain, method, start/settle time and, once
 * settled, the source that answered (the result's own `{ source }` field).
 * What it cannot: which tier is being asked *while* a request is still in
 * flight — that lives in the core's source loop (freedom-core design 0005).
 * For a synchronous stall in main that is rarely a loss (the blocked call
 * usually settles right as the loop comes back, so it is reported with its
 * answering source), but a stall whose read failed over to another tier is
 * reported as "failed" or "in flight" without naming the tier.
 *
 * Cost per request: one Map insert/delete and one ring-buffer write.
 */

const { performance } = require('perf_hooks');

const WRAPPED = Symbol.for('freedom.chainDataActivity.wrapped');
const DEFAULT_KEEP_SETTLED = 32;
const DEFAULT_MAX_LISTED = 5;

function createChainDataActivity({
  now = () => performance.now(),
  keepSettled = DEFAULT_KEEP_SETTLED,
  maxListed = DEFAULT_MAX_LISTED,
} = {}) {
  let nextId = 1;
  const inFlight = new Map();
  const settled = [];

  function track(chainId, method) {
    const id = nextId++;
    inFlight.set(id, { chainId, method, startedAt: now() });
    return function finish(source) {
      const entry = inFlight.get(id);
      if (!entry) return;
      inFlight.delete(id);
      settled.push({ ...entry, settledAt: now(), source: source || null });
      if (settled.length > keepSettled) settled.shift();
    };
  }

  // Everything that overlapped [since, now]: still in flight, or settled at
  // or after `since`. Longest first, so the likely culprit leads.
  function describe({ since = -Infinity } = {}) {
    const t = now();
    const rows = [];
    for (const entry of inFlight.values()) {
      rows.push({ ...entry, durationMs: t - entry.startedAt, label: 'in flight' });
    }
    for (const entry of settled) {
      if (entry.settledAt < since) continue;
      rows.push({
        ...entry,
        durationMs: entry.settledAt - entry.startedAt,
        label: entry.source ? `via ${entry.source}` : 'failed',
      });
    }
    if (rows.length === 0) return '';
    rows.sort((a, b) => b.durationMs - a.durationMs);
    const listed = rows
      .slice(0, maxListed)
      .map((r) => `${r.chainId} ${r.method} ${r.label}, ${Math.round(r.durationMs)} ms`);
    const more = rows.length > maxListed ? `; +${rows.length - maxListed} more` : '';
    return `chain-data: ${listed.join('; ')}${more}`;
  }

  // Wrap one exported chain-data function. `methodOf(args)` names the read for
  // the log line (`request` passes the JSON-RPC method through; the fee quote
  // and broadcast helpers have a fixed label).
  function wrapExport(chainData, name, methodOf) {
    const original = chainData[name];
    if (typeof original !== 'function' || original[WRAPPED]) return false;
    const wrapped = function (chainId, ...rest) {
      const finish = track(chainId, methodOf(rest));
      let pending;
      try {
        pending = original.call(this, chainId, ...rest);
      } catch (err) {
        finish(null);
        throw err;
      }
      return Promise.resolve(pending).then(
        (result) => {
          finish(result?.source);
          return result;
        },
        (err) => {
          finish(null);
          throw err;
        }
      );
    };
    Object.defineProperty(wrapped, 'name', { value: name });
    wrapped[WRAPPED] = true;
    chainData[name] = wrapped;
    return true;
  }

  // `request()` plus the fee quote and the broadcast (#498 R1-M4). Both are
  // reached as properties of the module object at call time too
  // (`chainData.getFeeQuote`, `router.broadcastRawTransaction`). Returns
  // whether `request` was newly wrapped.
  function instrumentChainData(chainData) {
    if (typeof chainData?.request !== 'function') {
      throw new Error('chainData.request is not a function');
    }
    const wrappedRequest = wrapExport(chainData, 'request', ([method]) => method);
    wrapExport(chainData, 'getFeeQuote', () => 'fee quote');
    wrapExport(chainData, 'broadcastRawTransaction', () => 'eth_sendRawTransaction');
    return wrappedRequest;
  }

  return { track, describe, instrumentChainData };
}

const shared = createChainDataActivity();

module.exports = {
  createChainDataActivity,
  describeChainDataActivity: shared.describe,
  instrumentChainData: shared.instrumentChainData,
};
