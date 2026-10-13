/**
 * A held intent's label at the chain's finalized block (freedom-core design
 * 0005, "Retrying an intent": "Labels, not permissions" and "Evidence for
 * labels"):
 *
 * - **paid:** one of the intent's own transactions is included at or below
 *   the finalized block, with status 1;
 * - **failed:** one is included there with status 0;
 * - **taken:** the finalized nonce has passed the intent's, and none of its
 *   own transactions is included: some other transaction used the nonce,
 *   possibly this very payment signed elsewhere;
 * - **held:** anything else, a chain with no finalized block among it.
 *
 * Labels authorize nothing: whatever one says, the wallet never signs the
 * intent at another nonce. A wrong label can mislead the display, never
 * pay twice.
 *
 * Evidence comes only from a verified source: Myotis, Colibri, or a quorum
 * that reached agreement among at least two endpoints. Direct (a quorum
 * that fell back to it included), Blockscout and a quorum of one don't
 * count; without verified evidence for every read, the intent stays held.
 *
 * The order matters:
 * 1. F, the finalized block;
 * 2. C, the sender's nonce at the finalized block, read *before* any
 *    receipt. A transaction at N that is finalized once C is read already
 *    has its receipt, so "every receipt null and C > N" can't be the
 *    window between the count and the receipt of the intent's own
 *    transaction;
 * 3. each hash's receipt: included means its block is at or below F, and
 *    the block at that height (finalized, so canonical) has the receipt's
 *    block hash. Its hash and sender must be the intent's.
 *
 * Pure: the reads go through the injected `request`, called as
 * `chainData.request(chainId, method, params, options)` with trust and no
 * routing context, so they are never interactive.
 */

const LABELS = Object.freeze({
  PAID: 'paid',
  FAILED: 'failed',
  TAKEN: 'taken',
  HELD: 'held',
});

// What a held intent's reads saw, for the display: one of its transactions
// is on chain (not final yet), none is, or the evidence was missing.
const OBSERVED = Object.freeze({
  INCLUDED: 'included',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
});

const VERIFIED_SOURCES = new Set(['myotis', 'colibri', 'quorum']);

// The options of every read: trust, no routing context (never
// interactive), and background (never queues for Myotis, so the tracker
// doesn't hold the user's Myotis slot; the next verified source answers).
const READ_OPTIONS = Object.freeze({ includeTrust: true, background: true });

/**
 * Whether a read's reply is evidence for a label: verified, from Myotis,
 * Colibri, or a quorum agreed among at least two endpoints.
 */
function isVerifiedEvidence(reply) {
  const trust = reply?.trust;
  if (!trust || trust.level !== 'verified') return false;
  if (!VERIFIED_SOURCES.has(reply.source) || trust.method !== reply.source) return false;
  if (trust.method !== 'quorum') return true;
  return trust.quorum?.achieved === true && Number(trust.quorum?.m) >= 2;
}

// A JSON-RPC quantity, or null.
function quantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null;
  return BigInt(value);
}

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null);

function held(observed, reason) {
  return { label: LABELS.HELD, observed, reason };
}

/**
 * @param {object} intent - a held intent's view: chainId, sender, nonce,
 *   hashes [{ hash }]
 * @param {object} deps
 * @param {Function} deps.request - chainData.request
 * @returns {Promise<{label: 'paid'|'failed', hash: string, block: number}
 *   | {label: 'taken', hash: null, block: number}
 *   | {label: 'held', observed: string, reason: string}>}
 */
async function readLabel(intent, { request }) {
  const read = async (method, params) => {
    const reply = await request(intent.chainId, method, params, READ_OPTIONS);
    if (!isVerifiedEvidence(reply)) {
      const error = new Error(`${method} had no verified evidence (${reply?.source ?? 'none'})`);
      error.unverified = true;
      throw error;
    }
    return reply.result;
  };

  try {
    // 1. The finalized block.
    const finalizedBlock = await read('eth_getBlockByNumber', ['finalized', false]);
    if (!finalizedBlock) return held(OBSERVED.UNKNOWN, 'no finalized block');
    const finalized = quantity(finalizedBlock.number);
    if (finalized === null) return held(OBSERVED.UNKNOWN, 'malformed finalized block');

    // 2. The sender's nonce at the finalized block, before any receipt.
    const count = quantity(await read('eth_getTransactionCount', [intent.sender, 'finalized']));
    if (count === null) return held(OBSERVED.UNKNOWN, 'malformed nonce');

    // 3. The receipts.
    for (const { hash } of intent.hashes) {
      const receipt = await read('eth_getTransactionReceipt', [hash]);
      if (receipt === null || receipt === undefined) continue;
      if (lower(receipt.transactionHash) !== lower(hash)) {
        return held(OBSERVED.UNKNOWN, 'a receipt for another transaction');
      }
      if (lower(receipt.from) !== lower(intent.sender)) {
        return held(OBSERVED.UNKNOWN, 'a receipt from another sender');
      }
      const blockNumber = quantity(receipt.blockNumber);
      if (blockNumber === null) return held(OBSERVED.UNKNOWN, 'malformed receipt');
      if (blockNumber > finalized)
        return held(OBSERVED.INCLUDED, 'included above the finalized block');
      const block = await read('eth_getBlockByNumber', [receipt.blockNumber, false]);
      if (!block || lower(block.hash) !== lower(receipt.blockHash)) {
        return held(OBSERVED.UNKNOWN, 'the receipt is not in the canonical block');
      }
      const status = quantity(receipt.status);
      if (status !== 0n && status !== 1n) return held(OBSERVED.UNKNOWN, 'no receipt status');
      return {
        label: status === 1n ? LABELS.PAID : LABELS.FAILED,
        hash: lower(hash),
        block: Number(finalized),
      };
    }

    // 4. None of its own is included: taken once the nonce has passed it.
    if (count > BigInt(intent.nonce)) {
      return { label: LABELS.TAKEN, hash: null, block: Number(finalized) };
    }
    return held(OBSERVED.ABSENT, 'not included');
  } catch (err) {
    return held(OBSERVED.UNKNOWN, err.unverified ? err.message : `read failed: ${err.message}`);
  }
}

module.exports = { LABELS, OBSERVED, READ_OPTIONS, isVerifiedEvidence, readLabel };
