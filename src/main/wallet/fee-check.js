/**
 * The fee check at confirmation (freedom-core design 0005, Plausibility,
 * "A: the check at confirmation", decided in #92).
 *
 * Before main signs a transaction, the confirmation shows the most it can
 * cost (its gas limit × its max fee per gas, or × its gas price if legacy)
 * and compares that fee per gas with a reference fee R, the current network
 * fee. Above FEE_CHECK_MULTIPLE × R the user is asked again, with the ratio
 * named, and the send is never auto-approved. Whatever set the fee (a quote
 * from any source, or a replacement's raised fees) is judged against the
 * same R, which never comes from the transaction itself.
 *
 * **The evidence** is the core's `chain.fee_reference`: a verified header
 * from Colibri where the chain has one, and B's combined quote from the
 * chain's endpoints. R is, at the moment it is judged:
 *   1. **Verified:** the header has a base fee B and its timestamp is within
 *      60 s of this clock, either way: R = 2·B + the lowest priority fee
 *      among B's quotes, or 2·B when none gave one.
 *   2. **Combined quote:** otherwise, B's combined quote when it is at most
 *      60 s old, counted from the moment its request was sent: its
 *      `maxFeePerGas`, or its `gasPrice` if legacy. With `answered: 1` it is
 *      one endpoint's word: compared and shown, never auto-approved.
 *   3. **None:** otherwise, or when R is 0. The confirmation shows the most
 *      the send can cost and says it couldn't be compared, and the send is
 *      never auto-approved.
 *
 * **Ages:** evidence is reused, for a later approval or another
 * transaction's confirmation, while its request is at most 60 s old;
 * older evidence is gathered again before the approval it would judge.
 * The header's age comes from its timestamp and this wall clock; the
 * quote's from its request's start on the monotonic clock.
 *
 * **Main's own transactions** (a Safe's execution or activation, paid by
 * its executor) are judged as they are signed, against the same R. Within
 * the threshold, with a reference that permits auto-approval, they go ahead
 * as before; otherwise they stop before signing
 * (FEE_CHECK_NEEDS_CONFIRMATION) and are signed only with the fee the user
 * then confirms on the Safe's screen (safe-executor.js).
 *
 * **Fees the user didn't see** are never signed: a confirmed send that
 * names no fee of its own would be given today's after its confirmation,
 * so it is refused (FEE_NOT_SHOWN) and goes back to its screen
 * (wallet-ipc.js).
 *
 * The check is a confirmation heuristic, not proof that a fee is honest.
 */

const chainData = require('../networks/chain-data');

/** "About 3·R" (design 0005, A: The check): a send whose fee per gas is
 * above this multiple of the reference is asked again and never
 * auto-approved. Tuned against measured fee spikes before release. */
const FEE_CHECK_MULTIPLE = 3n;

/** The most a header or a quote may be aged when it is judged, and the most
 * evidence may be aged before it is gathered again. */
const EVIDENCE_MAX_AGE_MS = 60_000;

/** How long main waits for the evidence: a confirmation doesn't wait for
 * the core's full 120 s. */
const EVIDENCE_DEADLINE_MS = 15_000;

/** A send newly above the threshold at its approval: the user is asked
 * again, and nothing is signed. */
const FEE_CHECK_ASK_AGAIN = 'FEE_CHECK_ASK_AGAIN';

/** A send whose fee can't be auto-approved: it is shown for confirmation. */
const FEE_CHECK_NOT_AUTO_APPROVED = 'FEE_CHECK_NOT_AUTO_APPROVED';

/** A transaction main sends on its own (a Safe's execution or activation)
 * whose fee needs the user: nothing is signed until they confirm it. */
const FEE_CHECK_NEEDS_CONFIRMATION = 'FEE_CHECK_NEEDS_CONFIRMATION';

/** A send whose fee the user wasn't shown: it is never signed. */
const FEE_NOT_SHOWN = 'FEE_NOT_SHOWN';

/** The most chains whose evidence is kept at once. */
const MAX_CHAINS = 32;

/** A decimal string the core writes: at most 78 digits (2^256 has 78). */
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function decimal(value) {
  return typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : null;
}

/** The header part, or null for none, or one main can't read. */
function readHeader(header) {
  if (!isObject(header) || header.source !== 'colibri') return null;
  const number = decimal(header.number);
  const timestamp = decimal(header.timestamp);
  if (number === null || timestamp === null) return null;
  if (header.base_fee === null) return { number, timestamp, baseFee: null };
  const baseFee = decimal(header.base_fee);
  return baseFee === null ? null : { number, timestamp, baseFee };
}

/** B's combined quote, or null for none, or one main can't read. */
function readQuote(quote) {
  if (!isObject(quote) || quote.source !== 'direct') return null;
  const { answered } = quote;
  if (!Number.isSafeInteger(answered) || answered < 1) return null;
  const perGas =
    quote.type === 'eip1559'
      ? decimal(quote.maxFeePerGas)
      : quote.type === 'legacy'
        ? decimal(quote.gasPrice)
        : null;
  return perGas === null ? null : { type: quote.type, perGas, answered };
}

/**
 * The evidence in a `chain.fee_reference` reply, requested at `requestedAt`
 * (monotonic ms). A part main can't read counts as one that failed.
 */
function readEvidence(reply, requestedAt) {
  const reference = isObject(reply) ? reply : {};
  return {
    requestedAt,
    header: readHeader(reference.header),
    lowestPriority: reference.lowest_priority === null ? null : decimal(reference.lowest_priority),
    quote: readQuote(reference.quote),
  };
}

/**
 * R from `evidence` at the moment it is judged: `wallNow` (ms since the
 * epoch) for the header's timestamp, `monotonicNow` (ms) for the quote's
 * age. `{ fee, basis: 'header' | 'quote', oneEndpoint }`, or null for none.
 */
function referenceFee(evidence, { wallNow, monotonicNow }) {
  if (!evidence) return null;
  const { header, quote } = evidence;
  let reference = null;
  if (header && header.baseFee !== null) {
    const headerAgeMs = Math.abs(wallNow - Number(header.timestamp) * 1000);
    if (headerAgeMs <= EVIDENCE_MAX_AGE_MS) {
      reference = {
        fee: 2n * header.baseFee + (evidence.lowestPriority ?? 0n),
        basis: 'header',
        oneEndpoint: false,
      };
    }
  }
  if (!reference && quote && monotonicNow - evidence.requestedAt <= EVIDENCE_MAX_AGE_MS) {
    reference = { fee: quote.perGas, basis: 'quote', oneEndpoint: quote.answered === 1 };
  }
  return reference && reference.fee > 0n ? reference : null;
}

/** A transaction's quantity (decimal or hex, as a string, number or bigint),
 * or null. Longer than any 256-bit quantity is none. */
function quantity(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && value.length > 80) return null;
  try {
    const n = BigInt(value);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

/** A transaction's fee per gas: its max fee when it is EIP-1559 (both fee
 * fields set, as buildTransaction reads them), its gas price otherwise. */
function feePerGas(tx) {
  const maxFee = quantity(tx?.maxFeePerGas);
  const priority = quantity(tx?.maxPriorityFeePerGas);
  if (maxFee !== null && priority !== null) return maxFee;
  return quantity(tx?.gasPrice);
}

/** `fee / reference` to one decimal, as the confirmation names it: "20",
 * "3.4". Whole from 10 on. */
function ratioText(fee, reference) {
  const tenths = (fee * 10n + reference / 2n) / reference;
  if (tenths >= 100n) return ((fee + reference / 2n) / reference).toString();
  const whole = tenths / 10n;
  const rest = tenths % 10n;
  return rest === 0n ? whole.toString() : `${whole}.${rest}`;
}

/**
 * The check of `tx` (its gas limit and fees) against `reference`
 * (referenceFee). Decimal strings, so it crosses IPC as it is:
 * - `maxCost`: the most the send can cost, in wei, or null when its gas
 *   limit or fee isn't known;
 * - `comparable`: whether there was a reference to compare with;
 * - `ratio`: the fee per gas over R, as the confirmation names it;
 * - `above`: above FEE_CHECK_MULTIPLE × R: asked again;
 * - `oneEndpoint`: R is one endpoint's quote;
 * - `autoApprove`: whether the send may be approved without the user.
 */
function judgeFees(tx, reference) {
  const perGas = feePerGas(tx);
  const gasLimit = quantity(tx?.gasLimit);
  const maxCost = perGas !== null && gasLimit !== null ? (perGas * gasLimit).toString() : null;
  if (!reference || perGas === null) {
    return {
      maxCost,
      comparable: false,
      ratio: null,
      above: false,
      oneEndpoint: false,
      basis: null,
      autoApprove: false,
    };
  }
  const above = perGas > FEE_CHECK_MULTIPLE * reference.fee;
  return {
    maxCost,
    comparable: true,
    ratio: ratioText(perGas, reference.fee),
    above,
    oneEndpoint: reference.oneEndpoint,
    basis: reference.basis,
    autoApprove: !above && !reference.oneEndpoint,
  };
}

/** A chain ID as the core takes one, or null. */
function chainIdOf(tx) {
  const id = Number(tx?.chainId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The core's `chain.fee_reference` for `chainId`; in the E2E harness, its
 * fixture (test-harness.js), so specs don't depend on the live chain.
 */
function fetchFeeReference(chainId, options) {
  const fixture = globalThis.__FREEDOM_TEST_FEE_REFERENCE__;
  if (typeof fixture === 'function') return fixture(chainId, options);
  return chainData.getFeeReference(chainId, options);
}

/**
 * The check, with its evidence kept per chain. Clocks and the core request
 * come in as parameters, so tests run it on a fake clock.
 */
class FeeChecks {
  /**
   * @param {object} [options]
   * @param {(chainId: number, options: object) => Promise<object>} [options.fetch]
   *   the core's `chain.fee_reference`
   * @param {() => number} [options.wallClock] - ms since the epoch
   * @param {() => number} [options.monotonic] - ms, never going back
   * @param {object} [options.log]
   */
  constructor({
    fetch = fetchFeeReference,
    wallClock = () => Date.now(),
    monotonic = () => performance.now(),
    log = console,
  } = {}) {
    this.fetch = fetch;
    this.wallClock = wallClock;
    this.monotonic = monotonic;
    this.log = log;
    // chainId → { requestedAt, evidence: Promise }
    this.kept = new Map();
  }

  /**
   * The chain's evidence: the one kept while its request is at most 60 s
   * old (in flight or answered), or new evidence gathered now. A request
   * that failed is not kept: the next check asks again.
   */
  evidenceFor(chainId) {
    const now = this.monotonic();
    const kept = this.kept.get(chainId);
    if (kept && now - kept.requestedAt <= EVIDENCE_MAX_AGE_MS) return kept.evidence;
    const requestedAt = now;
    const entry = { requestedAt, evidence: null };
    let asked;
    try {
      asked = Promise.resolve(this.fetch(chainId, { deadlineMs: EVIDENCE_DEADLINE_MS }));
    } catch (err) {
      asked = Promise.reject(err);
    }
    entry.evidence = asked.then(
      (reply) => readEvidence(reply, requestedAt),
      (err) => {
        if (this.kept.get(chainId) === entry) this.kept.delete(chainId);
        this.log.warn?.(`[FeeCheck] No fee reference for chain ${chainId}: ${err?.message}`);
        return null;
      }
    );
    this.kept.delete(chainId);
    this.kept.set(chainId, entry);
    while (this.kept.size > MAX_CHAINS) this.kept.delete(this.kept.keys().next().value);
    return entry.evidence;
  }

  /** `tx` judged against its chain's reference now (judgeFees). */
  async check(tx) {
    const chainId = chainIdOf(tx);
    const evidence = chainId === null ? null : await this.evidenceFor(chainId);
    const reference = referenceFee(evidence, {
      wallNow: this.wallClock(),
      monotonicNow: this.monotonic(),
    });
    return judgeFees(tx, reference);
  }

  /**
   * The check at the moment of approval by the user, who has seen the fee
   * and confirmed it, and confirmed it again if it was above the threshold
   * (`acknowledged`). `askAgain` when it is above now and wasn't
   * acknowledged: nothing may be signed until the user confirms again.
   */
  async atApproval(tx, { acknowledged = false } = {}) {
    const verdict = await this.check(tx);
    const askAgain = verdict.above && acknowledged !== true;
    if (askAgain) {
      this.log.info?.(
        `[FeeCheck] Chain ${chainIdOf(tx)}: the fee is ${verdict.ratio}× the reference: asking again`
      );
    }
    return { ...verdict, askAgain };
  }

  /** Forgets every chain's evidence. */
  clear() {
    this.kept.clear();
  }
}

const shared = new FeeChecks();

/** An error that refuses a send for its fee check, with the verdict. */
function feeCheckError(code, verdict) {
  const error = new Error(
    code === FEE_CHECK_ASK_AGAIN
      ? `The network fee is ${verdict.ratio}× today's network fee. Confirm it again to send.`
      : "This payment's network fee needs your confirmation."
  );
  error.code = code;
  error.feeCheck = verdict;
  return error;
}

module.exports = {
  FEE_CHECK_MULTIPLE,
  EVIDENCE_MAX_AGE_MS,
  EVIDENCE_DEADLINE_MS,
  FEE_CHECK_ASK_AGAIN,
  FEE_CHECK_NOT_AUTO_APPROVED,
  FEE_CHECK_NEEDS_CONFIRMATION,
  FEE_NOT_SHOWN,
  FeeChecks,
  readEvidence,
  referenceFee,
  judgeFees,
  feeCheckError,
  checkFees: (tx) => shared.check(tx),
  checkAtApproval: (tx, options) => shared.atApproval(tx, options),
  _shared: shared,
};
