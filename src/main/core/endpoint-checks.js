/**
 * Endpoints serve their chain (freedom-core design 0005, "Endpoints serve
 * their chain", decided in #93): an RPC endpoint takes part in chain C's
 * reads, fee quotes and broadcasts only once `eth_chainId` from it has
 * answered C. Main asks, through the same transport its executors use
 * (`shell.rpc`'s), before the configuration snapshot lists the endpoint.
 *
 * - **An answer that differs** leaves the endpoint out. **A failed check**
 *   (down, a timeout, an unreadable answer) leaves it unchecked, and out,
 *   until a retry succeeds: retries back off from 30 s, doubling to 10 min.
 * - **Freshness:** an answer holds for one (chain, URL) for the core
 *   process's life. A reconfiguration that keeps the URL doesn't ask again;
 *   adding or editing a source does (`check`), and so does a new core
 *   process (`reset`). When the process ends, nothing more is asked until
 *   another starts (`reset` again).
 * - **An hourly re-check** asks every (chain, URL) again. An answer that
 *   hasn't changed does nothing; a changed one is reported (`onChange`), and
 *   the configuration joins it at most once a minute (chain-config.js).
 *
 * The check guards against a misconfigured endpoint, not a malicious one: a
 * lying endpoint answers `eth_chainId` correctly and lies about the rest,
 * which only the quorum and the verifiers bound.
 */

const dns = require('node:dns');
const { fetchLoop, makeHop, withDeadline, isOk, redirectAllowed } = require('./naming-shell');
const { boundLookups } = require('../networks/blockscout-logs');
const { validateRpcUrl } = require('../networks/network-registry');

/** How long one check may take. */
const CHECK_TIMEOUT_MS = 5000;
/** A failed check's first retry, doubling each time up to RETRY_MAX_MS. */
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** How often every endpoint is asked again. */
const RECHECK_MS = 60 * 60_000;
/** The largest answer to `eth_chainId` main reads: a JSON-RPC envelope
 * around a short hex quantity, with room to spare. */
const ANSWER_BYTES = 64 * 1024;
// A JSON-RPC quantity, strictly (EIP-1474): `0x`, then no leading zero.
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const ASK_ID = 1;

const ASK_BODY = JSON.stringify({ jsonrpc: '2.0', id: ASK_ID, method: 'eth_chainId', params: [] });

/** The chain ID in a reply to ASK_BODY, or null: a JSON-RPC 2.0 success
 * for its id, with a result and no error, the result a strict quantity. */
function chainIdOf(text) {
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    return null;
  }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  if (reply.jsonrpc !== '2.0' || reply.id !== ASK_ID) return null;
  if (!Object.hasOwn(reply, 'result') || Object.hasOwn(reply, 'error')) return null;
  const { result } = reply;
  if (typeof result !== 'string' || !QUANTITY.test(result)) return null;
  const chainId = Number(BigInt(result));
  return Number.isSafeInteger(chainId) ? chainId : null;
}

/**
 * The transport `shell.rpc` uses (naming-shell.js): one plain exchange,
 * redirects as naming's, off the endpoint's origin never to this machine or
 * its networks. Resolves the chain ID `url` answers, or null for a failed
 * check: no answer, or one that isn't a chain ID.
 *
 * @param {string} url
 * @param {object} [deps] - hop, lookup, timeoutMs (test seams)
 * @returns {Promise<number|null>}
 */
async function askChainId(url, { hop, lookup, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  if (validateRpcUrl(url) !== null) return null;
  const origin = new URL(url).origin;
  const controller = new AbortController();
  try {
    const response = await withDeadline({ deadline_ms: timeoutMs }, controller.signal, (within) =>
      fetchLoop(url, ASK_BODY, {
        hop,
        allowed: (location) => redirectAllowed(location, origin, { lookup, signal: within }),
        signal: within,
        plain: true,
        read: isOk,
        max: ANSWER_BYTES,
      })
    );
    if (!isOk(response.status)) return null;
    return chainIdOf(response.body.toString('utf8'));
  } catch {
    return null;
  }
}

/** The default `ask`: askChainId over main's own transport. */
function defaultAsk() {
  const hop = makeHop();
  const lookup = boundLookups(dns.promises.lookup);
  return (url) => askChainId(url, { hop, lookup });
}

const keyOf = (chainId, url) => JSON.stringify([chainId, url]);

/**
 * The answers of one core process's life, per (chain, URL), and the
 * retries and re-checks that keep them current.
 */
class EndpointChecks {
  /**
   * @param {object} [options]
   * @param {(url: string) => Promise<number|null>} [options.ask] - the chain
   *   ID an endpoint answers, or null when the check failed
   * @param {() => void} [options.onChange] - which endpoints are let in
   *   changed
   * @param {object} [options.log]
   */
  constructor({ ask, onChange = () => {}, log } = {}) {
    this.ask = ask || defaultAsk();
    this.onChange = onChange;
    this.log = log || console;
    this.entries = new Map();
    // Checks made for pairs not configured yet (a source being saved):
    // `{ answer, at }`, taken by the next sync instead of asking again. A
    // failed one is retried as any failed check is, from its own time.
    this.fresh = new Map();
    this.recheckTimer = null;
    this.epoch = 0;
  }

  /** Whether chain `chainId`'s endpoint `url` answered `chainId`. */
  allows(chainId, url) {
    return this.entries.get(keyOf(chainId, url))?.answer === chainId;
  }

  /** What `url` last answered for chain `chainId`: its chain ID, or null
   * for none yet. */
  answer(chainId, url) {
    return this.entries.get(keyOf(chainId, url))?.answer ?? null;
  }

  /**
   * The (chain, URL) pairs the configuration has now: those new are asked,
   * and those gone are forgotten, their retries with them. The hourly
   * re-check runs while there are any.
   *
   * @param {Array<{chainId: number, url: string}>} pairs
   */
  sync(pairs) {
    const wanted = new Map(pairs.map((pair) => [keyOf(pair.chainId, pair.url), pair]));
    for (const [key, entry] of this.entries) {
      if (!wanted.has(key)) this.forget(key, entry);
    }
    for (const [key, { chainId, url }] of wanted) {
      if (this.entries.has(key)) continue;
      const entry = { chainId, url, answer: null, failures: 0, retry: null, asking: null };
      this.entries.set(key, entry);
      // Just asked as its source was saved: that check stands, an answer
      // as it is, a failure with its first retry still to come.
      const seeded = this.fresh.get(key);
      if (!seeded) this.run(entry);
      else if (seeded.answer !== null) entry.answer = seeded.answer;
      else this.failed(entry, Math.max(0, seeded.at + RETRY_FIRST_MS - Date.now()));
    }
    this.fresh.clear();
    if (this.entries.size > 0 && !this.recheckTimer) {
      this.recheckTimer = setTimeout(() => this.recheckAll(), RECHECK_MS);
      this.recheckTimer.unref?.();
    }
    if (this.entries.size === 0) this.stopRecheck();
  }

  /**
   * Resolves once each of `pairs` has an answer or a failed first check, or
   * after `maxMs`, whichever comes first.
   */
  settled(pairs, maxMs) {
    const asked = pairs
      .map((pair) => this.entries.get(keyOf(pair.chainId, pair.url))?.asking)
      .filter(Boolean);
    if (asked.length === 0) return Promise.resolve();
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(resolve, maxMs);
      timer.unref?.();
    });
    return Promise.race([Promise.allSettled(asked), bound]).finally(() => clearTimeout(timer));
  }

  /**
   * Asks `url` for chain `chainId` now (a source added or edited), and
   * keeps the result if the pair is configured. Resolves what this check
   * found: the chain ID it answered, or null when it failed, whatever an
   * earlier check answered.
   */
  async check(chainId, url) {
    const key = keyOf(chainId, url);
    const entry = this.entries.get(key);
    // Asked afresh, unless a check is already under way.
    if (entry) return this.run(entry);
    const epoch = this.epoch;
    const answer = await Promise.resolve()
      .then(() => this.ask(url))
      .catch(() => null);
    if (epoch === this.epoch) this.fresh.set(key, { answer, at: Date.now() });
    return answer;
  }

  /** A new core process, or the end of one: no answer carries over, and
   * nothing runs. */
  reset() {
    for (const [key, entry] of this.entries) this.forget(key, entry);
    this.fresh.clear();
    this.stopRecheck();
    this.epoch += 1;
  }

  /** Asks every (chain, URL) again: the hourly re-check. */
  recheckAll() {
    this.recheckTimer = null;
    for (const entry of this.entries.values()) {
      if (!entry.asking) this.run(entry);
    }
    if (this.entries.size > 0) {
      this.recheckTimer = setTimeout(() => this.recheckAll(), RECHECK_MS);
      this.recheckTimer.unref?.();
    }
  }

  stopRecheck() {
    clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  forget(key, entry) {
    clearTimeout(entry.retry);
    entry.forgotten = true;
    this.entries.delete(key);
  }

  /** One check of `entry`, at most one at a time. Resolves what it found:
   * the chain ID answered, or null. */
  run(entry) {
    if (entry.asking) return entry.asking;
    clearTimeout(entry.retry);
    entry.retry = null;
    const epoch = this.epoch;
    entry.asking = Promise.resolve()
      .then(() => this.ask(entry.url))
      .catch(() => null)
      .then((answer) => {
        entry.asking = null;
        if (!entry.forgotten && epoch === this.epoch) this.settle(entry, answer);
        return answer;
      });
    return entry.asking;
  }

  /** A failed check of `entry`: asked again after `delay`, by default its
   * backoff's (30 s doubling to 10 min). */
  failed(entry, delay) {
    entry.failures += 1;
    const backoff = Math.min(RETRY_FIRST_MS * 2 ** (entry.failures - 1), RETRY_MAX_MS);
    entry.retry = setTimeout(() => this.run(entry), delay ?? backoff);
    entry.retry.unref?.();
  }

  settle(entry, answer) {
    if (answer === null) {
      // No answer: whatever it last answered stands, and it is asked again.
      this.failed(entry);
      return;
    }
    entry.failures = 0;
    const before = entry.answer === entry.chainId;
    entry.answer = answer;
    if (answer !== entry.chainId) {
      this.log.warn?.(
        `[Core] An endpoint of chain ${entry.chainId} serves chain ${answer}: left out`
      );
    }
    if (before !== (answer === entry.chainId)) this.onChange();
  }
}

module.exports = {
  EndpointChecks,
  askChainId,
  defaultAsk,
  CHECK_TIMEOUT_MS,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  RECHECK_MS,
};
